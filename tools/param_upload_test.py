"""param_upload.py 的假设备测试。

跑：
    python tools/param_upload_test.py

不碰真蓝牙：FakeLink 按固件 main/ble_task.c 的应答规则回包，重点验证
3bit 压包、命令/应答节奏、同名换名和缩略图旁挂。
"""

import asyncio
import random
import tempfile
import unittest
from pathlib import Path

import param_upload as pu

CODES = pu.WIRE_INDEX_TO_CODE


def make_codes(count):
    return bytes(CODES[i % len(CODES)] for i in range(count))


class FakeLink:
    """模拟固件的写卡任务。只实现上传必需的命令。"""

    def __init__(self, *, width=800, height=480, known=(), max_write=509):
        self.width = width
        self.height = height
        self.known = set(known)
        self.max_write_without_response_size = max_write
        self.writes = []              # 每包 (bytes, response)
        self.transfers = []           # 成功收尾的 {stem, kind, data}
        self._callback = None
        self._receiving = False
        self._kind = ""
        self._stem = ""
        self._buffer = bytearray()

    async def subscribe(self, callback):
        self._callback = callback

    async def write(self, data, response):
        data = bytes(data)
        self.writes.append((data, response))
        command = data[0]

        if command == pu.CMD_FILE_START:
            length = data[1]
            stem = data[2:2 + length].decode("ascii")
            if not pu.STEM_RE.fullmatch(stem) or stem in self.known:
                self._ack(command, 2)
                return
            self.known.add(stem)
            self._begin(stem, "main")
            self._ack(command, 0, stem)

        elif command == pu.CMD_FILE_DATA:
            if self._receiving:
                self._buffer.extend(data[1:])

        elif command == pu.CMD_FILE_END:
            if not self._receiving:
                self._ack(command, 1)
                return
            if self._kind == "main":
                expected = pu.wire_bytes(self.width * self.height)
                good = len(self._buffer) == expected
            else:
                good = 0 < len(self._buffer) <= pu.PREVIEW_MAX_BYTES
            self.transfers.append(
                {"stem": self._stem, "kind": self._kind,
                 "data": bytes(self._buffer)})
            self._receiving = False
            self._ack(command, 0 if good else 2)

        elif command == pu.CMD_PREVIEW_START:
            if len(data) != 1 + pu.STEM_FIELD:
                self._ack(command, 1)
                return
            stem = pu.read_stem_field(data[1:])
            if stem not in self.known:
                self._ack(command, 1)
                return
            self._begin(stem, "preview")
            self._ack(command, 0)

        elif command == pu.CMD_FILE_ABORT:
            self._receiving = False
            self._ack(command, 0)

        else:
            self._ack(command, 1)

    def _begin(self, stem, kind):
        self._stem = stem
        self._kind = kind
        self._buffer = bytearray()
        self._receiving = True

    def _ack(self, command, status, stem=""):
        payload = bytes((0xFF, ((command << 4) | status) & 0xFF))
        if stem:
            payload += stem.encode("ascii").ljust(pu.STEM_FIELD, b"\0")
        loop = asyncio.get_running_loop()
        loop.call_soon(self._deliver, payload)

    def _deliver(self, payload):
        if self._callback is not None:
            self._callback(payload)


def reference_pack(codes):
    out = bytearray(pu.wire_bytes(len(codes)))
    for i, code in enumerate(codes):
        value = pu.CODE_TO_INDEX[code]
        for bit in range(3):
            if (value >> bit) & 1:
                position = i * 3 + bit
                out[position >> 3] |= 1 << (position & 7)
    return bytes(out)


class PackTests(unittest.TestCase):
    def test_known_vector_matches_javascript(self):
        codes = (CODES * 7)[:40]
        self.assertEqual(pu.pack_to_wire(codes).hex(),
                         "88c6221a8b682ca2b188c6221a8b68")

    def test_arbitrary_lengths_match_reference(self):
        rng = random.Random(20261029)
        for length in range(0, 41):
            codes = bytes(rng.choice(CODES) for _ in range(length))
            self.assertEqual(pu.pack_to_wire(codes),
                             reference_pack(codes), f"length={length}")

    def test_unknown_code_falls_back_to_black(self):
        self.assertEqual(pu.pack_to_wire(bytes((0x42,)) * 8),
                         pu.pack_to_wire(bytes((0x00,)) * 8))


class HelperTests(unittest.TestCase):
    def test_parse_panel_tag(self):
        self.assertEqual(pu.parse_panel_tag("EINK-1200-B21A"), "1200")
        self.assertEqual(pu.parse_panel_tag("eink-800-1234"), "800")
        self.assertEqual(pu.parse_panel_tag("garbage"), "")

    def test_stem_field_roundtrip(self):
        stem = "20261029-235900-007"
        field = pu.stem_field(stem)
        self.assertEqual(len(field), pu.STEM_FIELD)
        self.assertEqual(pu.read_stem_field(field), stem)
        self.assertEqual(pu.read_stem_field(b"\0" * pu.STEM_FIELD), "")

    def test_make_stem(self):
        from datetime import datetime
        self.assertEqual(
            pu.make_stem(datetime(2026, 10, 29, 23, 59, 5), 7),
            "20261029-235905-007")

    def test_collect_directory_includes_sd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sd").mkdir()
            (root / "a.bin").write_bytes(b"")
            (root / "sd" / "b.bin").write_bytes(b"")
            files = pu.collect_files([str(root)])
        self.assertEqual([p.name for p in files], ["a.bin", "b.bin"])


class PanelTests(unittest.TestCase):
    def test_resolve_panel_from_name(self):
        self.assertEqual(pu.resolve_panel("EINK-1200-B21A", None), "1200")
        self.assertEqual(pu.resolve_panel("EINK-800-B21A", None), "800")

    def test_resolve_panel_needs_explicit_when_name_has_no_tag(self):
        with self.assertRaises(pu.UploadError):
            pu.resolve_panel("EINK-B21A", None)
        self.assertEqual(pu.resolve_panel("EINK-B21A", "1200"), "1200")

    def test_resolve_panel_rejects_mismatch(self):
        with self.assertRaises(pu.UploadError):
            pu.resolve_panel("EINK-800-B21A", "1200")


class FakeCharacteristic:
    def __init__(self, properties=None, max_write=509):
        self.properties = properties if properties is not None else [
            "read", "write", "write-without-response", "notify"]
        self.max_write_without_response_size = max_write


class FakeClient:
    def __init__(self):
        self.characteristic = FakeCharacteristic()
        self.callback = None
        self.writes = []

    async def start_notify(self, characteristic, callback):
        self.callback = callback

    async def write_gatt_char(self, characteristic, data, response):
        self.writes.append((bytes(data), response))


class LinkTests(unittest.IsolatedAsyncioTestCase):
    async def test_bleak_link_wraps_client(self):
        client = FakeClient()
        link = pu.BleakLink(client, client.characteristic)
        self.assertTrue(link.supports_write_without_response)
        self.assertEqual(link.max_write_without_response_size, 509)

        received = []
        await link.subscribe(received.append)
        client.callback(client.characteristic, bytearray(b"\xff\x10"))
        self.assertEqual(received, [b"\xff\x10"])

        await link.write(b"abc", response=False)
        self.assertEqual(client.writes, [(b"abc", False)])

    async def test_bleak_link_detects_missing_no_response_write(self):
        client = FakeClient()
        client.characteristic = FakeCharacteristic(properties=["write", "notify"])
        link = pu.BleakLink(client, client.characteristic)
        self.assertFalse(link.supports_write_without_response)


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # 压包/缩略图是同步 CPU 活，IsolatedAsyncioTestCase 默认的 debug
        # 模式会把超过 100ms 的 task 当成慢回调打到输出里；这里只是测试，
        # 关掉 debug 免得日志被噪音淹没。
        asyncio.get_running_loop().set_debug(False)

    async def _uploader(self, link):
        uploader = pu.ParamUploader(link, retry_delay=0)
        await uploader.subscribe()
        return uploader

    async def test_main_and_preview(self):
        width, height = 800, 480
        source = make_codes(width * height)
        link = FakeLink(width=width, height=height)
        uploader = await self._uploader(link)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261029-235900-000.bin"
            path.write_bytes(source)
            result = await uploader.upload_file(
                path, source, "800", preview=True)

        self.assertEqual(result.stem, "20261029-235900-000")
        self.assertIsNone(result.preview_error)

        main = [t for t in link.transfers if t["kind"] == "main"]
        preview = [t for t in link.transfers if t["kind"] == "preview"]
        self.assertEqual(len(main), 1)
        self.assertEqual(len(preview), 1)
        self.assertEqual(main[0]["data"], pu.pack_to_wire(source))
        self.assertTrue(preview[0]["data"].startswith(b"\xff\xd8"))
        self.assertLessEqual(len(preview[0]["data"]), pu.PREVIEW_MAX_BYTES)

        data_packets = [w for w, _ in link.writes if w[0] == pu.CMD_FILE_DATA]
        self.assertTrue(data_packets)
        self.assertTrue(all(len(p) <= 509 for p in data_packets))
        # 快速模式的数据包必须走无应答写
        self.assertTrue(all(not response for packet, response in link.writes
                            if packet[0] == pu.CMD_FILE_DATA))

    async def test_duplicate_stem_is_renamed(self):
        width, height = 800, 480
        source = make_codes(width * height)
        link = FakeLink(width=width, height=height,
                        known={"20261029-235900-000"})
        uploader = await self._uploader(link)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261029-235900-000.bin"
            path.write_bytes(source)
            result = await uploader.upload_file(
                path, source, "800", preview=False)

        self.assertNotEqual(result.stem, "20261029-235900-000")
        self.assertRegex(result.stem, r"^\d{8}-\d{6}-\d{3}$")
        main = [t for t in link.transfers if t["kind"] == "main"]
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]["data"], pu.pack_to_wire(source))

    async def test_bad_size_fails_before_any_write(self):
        link = FakeLink()
        uploader = await self._uploader(link)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261029-235900-000.bin"
            path.write_bytes(b"\0" * 100)
            with self.assertRaises(pu.UploadError):
                await uploader.upload_file(path, b"\0" * 100, "800")
        self.assertEqual(link.writes, [])

    async def test_compat_mode_uses_20_byte_answered_packets(self):
        width, height = 800, 480
        source = make_codes(width * height)
        link = FakeLink(width=width, height=height)
        uploader = await self._uploader(link)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261029-235900-001.bin"
            path.write_bytes(source)
            await uploader.upload_file(path, source, "800",
                                       preview=False, mode="compat")

        data_packets = [(packet, response) for packet, response in link.writes
                        if packet[0] == pu.CMD_FILE_DATA]
        self.assertTrue(data_packets)
        self.assertTrue(all(len(p) <= 20 for p, _ in data_packets))
        self.assertTrue(all(response for _, response in data_packets))

    async def test_characteristic_without_no_response_write_falls_back(self):
        width, height = 800, 480
        source = make_codes(width * height)
        link = FakeLink(width=width, height=height)
        link.supports_write_without_response = False
        uploader = await self._uploader(link)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261029-235900-002.bin"
            path.write_bytes(source)
            await uploader.upload_file(path, source, "800", preview=False)

        data_packets = [(packet, response) for packet, response in link.writes
                        if packet[0] == pu.CMD_FILE_DATA]
        self.assertTrue(data_packets)
        self.assertTrue(all(len(p) <= 20 for p, _ in data_packets))
        self.assertTrue(all(response for _, response in data_packets))


if __name__ == "__main__":
    unittest.main(verbosity=2)
