#!/usr/bin/env python3
"""把墨水屏 .bin 图片经 BLE 直接传到 EINK 开发板。

为什么要有它：param-compare 产出的 sd/*.bin 以前只能拷 TF 卡、插拔读卡器。
这个脚本让同一批 .bin 从电脑的蓝牙直接发过去，协议与手机小程序
（pages/index/index.js、tools/param-uploader.js）完全一致。

用法：
    python tools/param_upload.py tools/_param_out/xxx/sd/*.bin
    python tools/param_upload.py tools/_param_out/xxx/sd          # 目录也行
    python tools/param_upload.py --scan                           # 只看附近设备
    python tools/param_upload.py --name EINK-1200-B21A a.bin
    python tools/param_upload.py --address AA:BB:CC:DD:EE:FF --panel 1200 a.bin

依赖：
    pip install -r tools/requirements.txt   # bleak + Pillow
    # 只装 bleak 也能传，但没有缩略图；Pillow 只在生成缩略图时用

要点：
  * .bin 是磁盘格式（每像素 1 字节）；发给设备前压成 3bit/像素的线上格式。
    1200 面板因此从 1,920,000B 降到 720,000B。
  * 固件每秒只接受同一条管理命令一次。连续传多张时，每张之间自动等 1.1 秒。
  * 同名文件已存在时设备回 status=2；脚本会等过限流窗口后换一个当前时间的
    名字重试，最后打印「请求名 → 实际名」。
  * 固件当前 BLE_REQUIRE_AUTH=0，直接连接即可。若将来打开配对门，需要先在
    系统蓝牙里配对，或加 --pair（并且连接时按住开发板中键）。
"""

import argparse
import asyncio
import glob
import io
import re
import sys
import time
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path

# Windows 中文控制台默认 GBK，而本脚本的输出是 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# 与 pages/index/index.js 的常量一致
SERVICE_UUID = "0000abf0-0000-1000-8000-00805f9b34fb"
CHAR_UUID = "0000abf1-0000-1000-8000-00805f9b34fb"
STEM_LENGTH = 19
STEM_FIELD = STEM_LENGTH + 1     # 线上定长字段：stem + NUL
PREVIEW_MAX_BYTES = 128 * 1024

CMD_FILE_START = 0x01
CMD_FILE_DATA = 0x02
CMD_FILE_END = 0x03
CMD_FILE_ABORT = 0x04
CMD_PREVIEW_START = 0x16
CMD_ACK = 0xFF

# 固件 ATT MTU 是 512：ATT 载荷最多 509B（含 1 字节命令）
FAST_TOTAL_BYTES = 509
COMPAT_TOTAL_BYTES = 20

# 与 utils/epd-wire.js 逐个对应，顺序不能重排
WIRE_INDEX_TO_CODE = (0x00, 0xFF, 0xFC, 0xE0, 0x03, 0x1C)
CODE_TO_INDEX = {code: i for i, code in enumerate(WIRE_INDEX_TO_CODE)}

# bytes.translate() 的 256 项查表：未知码按 JS 的默认行为落到黑色（索引 0）
INDEX_TABLE = bytes(CODE_TO_INDEX.get(i, 0) for i in range(256))

# 六种墨水的 sRGB 值，只用来生成缩略图
PALETTE_RGB = ((0, 0, 0), (255, 255, 255), (255, 255, 0),
               (255, 0, 0), (0, 0, 255), (0, 255, 0))

# 面板标识 → (宽, 高)。.bin 的尺寸必须正好是宽 × 高。
PANELS = {
    "800": (800, 480),
    "1200": (1200, 1600),
}

STEM_RE = re.compile(r"^\d{8}-\d{6}-\d{3}$")
PANEL_RE = re.compile(r"^EINK-(\d+)-", re.IGNORECASE)


class UploadError(RuntimeError):
    """给用户看的失败原因；main() 会打印它而不是整段堆栈。"""


class PreviewError(RuntimeError):
    """缩略图生成/上传失败。主图已经成功时才用，因此不该让整次上传失败。"""


@dataclass
class DeviceInfo:
    name: str
    address: str
    rssi: int
    ble: object            # bleak.BLEDevice


@dataclass
class UploadResult:
    path: Path
    requested_stem: str
    stem: str
    preview_error: Exception = None


def parse_panel_tag(name):
    match = PANEL_RE.match(str(name or ""))
    return match.group(1) if match else ""


def make_stem(now=None, sequence=0):
    now = now or datetime.now()
    return (f"{now.year:04d}{now.month:02d}{now.day:02d}-"
            f"{now.hour:02d}{now.minute:02d}{now.second:02d}-{sequence:03d}")


def stem_field(stem):
    """定长 20B：stem + NUL 填充。固件要求 preview/select/delete 都这么传。"""
    raw = stem.encode("ascii")
    if len(raw) != STEM_LENGTH:
        raise UploadError(f"图片名长度不对：{stem}（应为 {STEM_LENGTH}）")
    return raw.ljust(STEM_FIELD, b"\0")


def read_stem_field(payload):
    raw = bytes(payload[:STEM_FIELD]).split(b"\0", 1)[0]
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return ""


def wire_bytes(pixel_count):
    return (pixel_count * 3 + 7) // 8


def pack_to_wire(codes):
    """1 字节/像素调色板码 → 3bit/像素线上格式。

    位序必须与 utils/epd-wire.js 的 packToWire() 和固件 unpack_3bit() 一致：
    第 i 个像素占第 3i..3i+2 位（小端），跨字节自然拼接。
    """
    n = len(codes)
    if n == 0:
        return b""
    idx = bytes(codes).translate(INDEX_TABLE)
    out = bytearray(wire_bytes(n))
    o = 0
    full = n - (n % 8)
    for i in range(0, full, 8):
        p0 = idx[i]
        p1 = idx[i + 1]
        p2 = idx[i + 2]
        p3 = idx[i + 3]
        p4 = idx[i + 4]
        p5 = idx[i + 5]
        p6 = idx[i + 6]
        p7 = idx[i + 7]
        out[o] = p0 | (p1 << 3) | ((p2 & 0x03) << 6)
        out[o + 1] = (p2 >> 2) | (p3 << 1) | (p4 << 4) | ((p5 & 0x01) << 7)
        out[o + 2] = (p5 >> 1) | (p6 << 2) | (p7 << 5)
        o += 3

    # 尾部不足 8 像素时逐位写。两款面板的像素数都能被 8 整除，走不到这里，
    # 但这样函数对任意长度都成立，不会静默丢掉尾巴。
    for i in range(full, n):
        value = idx[i]
        bit = i * 3
        for b in range(3):
            if (value >> b) & 1:
                shift = bit + b
                out[shift >> 3] |= 1 << (shift & 7)
    return bytes(out)


def make_preview(codes, width, height):
    """把调色板码渲染成 400px 宽的 JPEG，供设备列表显示缩略图。

    和网页端一样逐级降质，直到满足固件 128KB 上限。Pillow 没装就跳过缩略图，
    主图仍然可以传。
    """
    try:
        from PIL import Image
    except ImportError as exc:
        raise PreviewError("未安装 Pillow，跳过缩略图（pip install Pillow）") from exc

    idx = bytes(codes).translate(INDEX_TABLE)
    image = Image.frombytes("P", (width, height), idx)
    palette = []
    for rgb in PALETTE_RGB:
        palette.extend(rgb)
    palette.extend([0] * (768 - len(palette)))
    image.putpalette(palette)
    rgb = image.convert("RGB")

    # 与 param-lab.html 的 buildPreviewJpeg() 同一组降级档位
    attempts = [(400, 75), (400, 65), (360, 65), (320, 55)]
    for target_w, quality in attempts:
        target_h = max(1, round(height * target_w / width))
        small = rgb.resize((target_w, target_h), Image.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        if 0 < len(data) <= PREVIEW_MAX_BYTES:
            return data
    raise PreviewError("缩略图降到 320px 仍超过 128KB")


class Ack:
    __slots__ = ("status", "payload")

    def __init__(self, status, payload=b""):
        self.status = status
        self.payload = payload

    @property
    def ok(self):
        return self.status == 0


class ParamUploader:
    """协议状态机。传输层只要求 subscribe/write 两个方法，方便用假设备测试。"""

    def __init__(self, link, *, chunk=None, retry_delay=1.1,
                 on_progress=None, on_log=None):
        self.link = link
        self.chunk = chunk
        self.retry_delay = retry_delay
        self._on_progress = on_progress or (lambda *args: None)
        self._on_log = on_log or (lambda *args: None)
        self._waiters = {}
        self._loop = None
        self._closed = False
        self._stem_stamp = ""
        self._stem_sequence = 0
        self._warned_no_write_no_rsp = False

    async def subscribe(self):
        self._loop = asyncio.get_running_loop()

        def forward(data):
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._handle_notification, bytes(data))
            except RuntimeError:
                pass

        await self.link.subscribe(forward)

    def notify_disconnected(self):
        """由 bleak 的 disconnected_callback 调用，可能不在事件循环线程。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._handle_disconnected)
        except RuntimeError:
            pass

    def _handle_notification(self, data):
        if len(data) < 2 or data[0] != CMD_ACK:
            return
        # 固件把命令字节的高四位放进 ACK 第二字节的高四位：
        # FILE_START 0x01 → 0x1?, PREVIEW_START 0x16 → 0x6?。
        key = (data[1] >> 4) & 0x0F
        status = data[1] & 0x0F
        waiter = self._waiters.pop(key, None)
        if waiter is None or waiter.done():
            return
        waiter.set_result(Ack(status, data[2:]))

    def _handle_disconnected(self):
        if self._closed:
            return
        self._closed = True
        for waiter in list(self._waiters.values()):
            if not waiter.done():
                waiter.set_exception(UploadError("设备连接已断开"))
        self._waiters.clear()

    def _discard_waiter(self, key, waiter):
        if self._waiters.get(key) is waiter:
            self._waiters.pop(key, None)

    async def _write_and_wait(self, packet, command, timeout):
        key = command & 0x0F
        waiter = self._loop.create_future()
        old = self._waiters.get(key)
        if old is not None and not old.done():
            old.set_exception(UploadError(
                f"命令 0x{command:02x} 的等待被新的等待替代"))
        self._waiters[key] = waiter
        try:
            # 控制包必须有应答；数据包才走无应答的快速路径。
            await self.link.write(packet, response=True)
        except Exception:
            self._discard_waiter(key, waiter)
            raise
        try:
            return await asyncio.wait_for(waiter, timeout)
        except asyncio.TimeoutError:
            raise UploadError(f"等待命令 0x{command:02x} 应答超时") from None
        finally:
            self._discard_waiter(key, waiter)

    def _strategy(self, mode):
        """返回 (每包总字节数, 是否要 ATT 应答)。"""
        if not getattr(self.link, "supports_write_without_response", True):
            if not self._warned_no_write_no_rsp:
                self._warned_no_write_no_rsp = True
                self._on_log("特征值不支持无应答写，改用 20B 有应答")
            return COMPAT_TOTAL_BYTES, True
        if self.chunk is not None:
            total = max(2, min(FAST_TOTAL_BYTES, int(self.chunk)))
            return total, False
        if mode == "compat":
            return COMPAT_TOTAL_BYTES, True
        reported = int(getattr(
            self.link, "max_write_without_response_size", 0) or 0)
        if reported < COMPAT_TOTAL_BYTES:
            return COMPAT_TOTAL_BYTES, True
        return min(FAST_TOTAL_BYTES, reported), False

    def packet_size(self, mode="fast"):
        return self._strategy(mode)

    async def _stream(self, data, label, mode):
        total_bytes, with_response = self._strategy(mode)
        payload = total_bytes - 1
        if payload < 1:
            raise UploadError(f"{label}的包大小无效：{total_bytes}B")
        offset = 0
        last_report = 0.0
        while offset < len(data):
            count = min(payload, len(data) - offset)
            packet = bytes((CMD_FILE_DATA,)) + data[offset:offset + count]
            await self.link.write(packet, response=with_response)
            offset += count
            now = time.monotonic()
            if now - last_report >= 0.25 or offset == len(data):
                self._on_progress(label, offset, len(data))
                last_report = now

        ack = await self._write_and_wait(
            bytes((CMD_FILE_END,)), CMD_FILE_END, 10.0)
        if not ack.ok:
            raise UploadError(
                f"{label}被设备拒收（FILE_END status={ack.status}）；"
                f"若反复出现，多半是丢包，试 --mode compat")

    def _next_stem(self):
        now = datetime.now()
        stamp = now.strftime("%Y%m%d-%H%M%S")
        if stamp != self._stem_stamp:
            self._stem_stamp = stamp
            self._stem_sequence = 0
        if self._stem_sequence > 999:
            raise UploadError("同一秒内序号已用尽，请稍后重试")
        stem = make_stem(now, self._stem_sequence)
        self._stem_sequence += 1
        return stem

    async def _start_main(self, requested_stem):
        stem = requested_stem
        for attempt in range(3):
            packet = bytes((CMD_FILE_START, len(stem))) + stem.encode("ascii")
            ack = await self._write_and_wait(packet, CMD_FILE_START, 4.0)
            device_stem = read_stem_field(ack.payload)
            if ack.ok:
                # 旧固件可能不回带名字；那就用请求的名字
                return device_stem or stem
            if ack.status != 2:
                raise UploadError(
                    f"设备拒绝主图（FILE_START status={ack.status}）")
            # status=2 既可能是重名，也可能是同一命令的 1 秒限流。
            # DATA 尚未开始，换名重试是安全的；但要先等过限流窗口。
            if attempt < 2:
                self._on_log(f"设备回 status=2，{self.retry_delay:.1f}s 后换名重试")
                await asyncio.sleep(self.retry_delay)
                stem = self._next_stem()
        raise UploadError("设备连续拒绝 3 个文件名（可能目录已满）")

    async def _start_preview(self, stem):
        packet = bytes((CMD_PREVIEW_START,)) + stem_field(stem)
        ack = await self._write_and_wait(
            packet, CMD_PREVIEW_START, 4.0)
        if not ack.ok:
            raise PreviewError(
                f"设备拒绝缩略图（PREVIEW_START status={ack.status}）")

    async def _abort_quietly(self):
        if self._closed:
            return
        try:
            await self.link.write(bytes((CMD_FILE_ABORT,)), response=True)
        except Exception:
            # 原错误比清理错误更有价值
            pass

    async def upload_file(self, path, data, panel, *, preview=True, mode="fast"):
        width, height = PANELS[panel]
        expected = width * height
        if len(data) != expected:
            wire = wire_bytes(expected)
            if len(data) == wire:
                raise UploadError(
                    f"{path.name} 是 {len(data)}B，看起来是 3bit 线上格式；"
                    f"这里需要磁盘格式的 .bin（{expected}B）")
            raise UploadError(
                f"{path.name} 为 {len(data)}B；{panel} 面板的 .bin 必须是 "
                f"{expected}B")

        wire = pack_to_wire(data)
        if len(wire) != wire_bytes(expected):
            raise UploadError(
                f"{path.name} 压缩后是 {len(wire)}B，应为 "
                f"{wire_bytes(expected)}B")

        requested = path.stem if STEM_RE.fullmatch(path.stem) else None
        main_done = False
        try:
            stem = await self._start_main(requested or self._next_stem())
            await self._stream(wire, "主图", mode)
            main_done = True

            preview_error = None
            if preview:
                try:
                    jpeg = make_preview(data, width, height)
                    await self._start_preview(stem)
                    await self._stream(jpeg, "缩略图", mode)
                except Exception as exc:
                    # 缩略图失败不该否定已经成功的主图
                    preview_error = exc
            return UploadResult(path, requested or path.stem, stem,
                                preview_error)
        except Exception:
            if not main_done:
                await self._abort_quietly()
            raise


async def scan_devices(timeout):
    """扫描附近设备，返回 (EINK 列表, 其他有名字的设备列表)。"""
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise UploadError("缺少 bleak：pip install bleak") from exc

    try:
        found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    except Exception as exc:
        raise UploadError(f"蓝牙扫描失败：{exc}") from exc

    eink = []
    other = []
    for device, adv in found.values():
        name = (adv.local_name or device.name or "").strip()
        service_match = any(
            str(uuid).lower() == SERVICE_UUID for uuid in adv.service_uuids)
        is_eink = name.upper().startswith("EINK-") or service_match
        if not name and not is_eink:
            continue
        rssi = adv.rssi if adv.rssi is not None else -999
        info = DeviceInfo(name, device.address, rssi, device)
        if is_eink:
            eink.append(info)
        else:
            other.append(info)

    eink.sort(key=lambda d: -d.rssi)
    other.sort(key=lambda d: -d.rssi)
    return eink, other


def select_device(devices, name, address):
    if address:
        wanted = address.strip().lower()
        compact = wanted.replace(":", "").replace("-", "")
        matched = [d for d in devices if d.address.lower() == wanted]
        if not matched:
            matched = [d for d in devices
                       if d.address.lower().replace(":", "")
                       .replace("-", "") == compact]
    elif name:
        matched = [d for d in devices if d.name.lower() == name.lower()]
        if not matched:
            matched = [d for d in devices if name.lower() in d.name.lower()]
    else:
        matched = list(devices)

    if not matched:
        hint = f"没有找到 {name or address}。"
        if devices:
            hint += "附近有：" + "、".join(
                f"{d.name or '(未命名)'}({d.address})" for d in devices)
        raise UploadError(hint)
    if len(matched) == 1:
        return matched[0]

    print("发现多台 EINK 设备：")
    for i, device in enumerate(matched, 1):
        print(f"  {i}) {device.name or '(未命名)'}  {device.address}  "
              f"{device.rssi} dBm")
    if not sys.stdin.isatty():
        raise UploadError("多台设备时请用 --name 或 --address 指定")
    choice = input("选择 [1]: ").strip() or "1"
    try:
        return matched[int(choice) - 1]
    except (ValueError, IndexError):
        raise UploadError(f"无效选择：{choice}") from None


def resolve_panel(device_name, explicit):
    tag = parse_panel_tag(device_name)
    if explicit and tag and explicit != tag:
        raise UploadError(
            f"面板不匹配：设备 {device_name} 是 {tag}，命令行指定 {explicit}")
    tag = explicit or tag
    if not tag:
        raise UploadError(
            "设备名里没有面板标识，请用 --panel 指定（800 或 1200）")
    if tag not in PANELS:
        raise UploadError(
            f"不认识的面板标识 {tag}，可选：{'、'.join(PANELS)}")
    return tag


def collect_files(inputs):
    files = []
    for raw in inputs:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(path.glob("*.bin")))
            files.extend(sorted((path / "sd").glob("*.bin")))
        elif glob.has_magic(raw):
            files.extend(sorted(Path(p) for p in glob.glob(raw)))
        else:
            files.append(path)

    seen = set()
    unique = []
    for path in files:
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        if not path.is_file():
            raise UploadError(f"找不到文件：{path}")
        if path.suffix.lower() != ".bin":
            raise UploadError(f"只接受 .bin：{path}")
        unique.append(path)
    unique.sort(key=lambda p: (p.stem, p.name))
    if not unique:
        raise UploadError("没有找到任何 .bin 文件")
    return unique


class BleakLink:
    def __init__(self, client, characteristic):
        self.client = client
        self.characteristic = characteristic
        try:
            size = int(characteristic.max_write_without_response_size)
        except Exception:
            size = COMPAT_TOTAL_BYTES
        self.max_write_without_response_size = max(1, size)
        properties = {
            str(item).lower()
            for item in (getattr(characteristic, "properties", None) or [])
        }
        self.supports_write_without_response = (
            "write-without-response" in properties)

    async def subscribe(self, callback):
        await self.client.start_notify(
            self.characteristic,
            lambda _characteristic, data: callback(bytes(data)))

    async def write(self, data, response):
        await self.client.write_gatt_char(
            self.characteristic, data, response=response)


def print_scan(eink, other):
    if eink:
        print(f"发现 {len(eink)} 台 EINK 设备：")
        for device in eink:
            print(f"  {device.name or '(未命名)'}  {device.address}  "
                  f"{device.rssi} dBm")
    else:
        print("没有发现 EINK- 设备。")
        print("检查：开发板已上电、未进入深度休眠（按复位/中键唤醒）、"
              "电脑蓝牙已打开、手机小程序没有连着它。")
    if other:
        print("\n附近其他带名字的蓝牙设备：")
        for device in other[:20]:
            print(f"  {device.name}  {device.address}  {device.rssi} dBm")


async def run_upload(args, files):
    eink, _ = await scan_devices(args.timeout)
    if not eink:
        raise UploadError(
            "没有发现 EINK- 设备。确认开发板已上电、未休眠、电脑蓝牙已打开，"
            "并且手机小程序没有连着它；可以先运行 --scan 看看。")
    device = select_device(eink, args.name, args.address)
    panel = resolve_panel(device.name, args.panel)
    width, height = PANELS[panel]

    jobs = []
    for path in files:
        data = path.read_bytes()
        expected = width * height
        if len(data) != expected:
            raise UploadError(
                f"{path.name} 为 {len(data)}B；{panel} 面板的 .bin 必须是 "
                f"{expected}B（目录里是不是混进了别的面板的图？）")
        jobs.append((path, data))

    print(f"设备：{device.name or '(未命名)'}（{device.address}）")
    print(f"面板：{panel}（{width}×{height}），共 {len(jobs)} 张")

    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise UploadError("缺少 bleak：pip install bleak") from exc

    holder = {}

    def on_disconnect(_client):
        uploader = holder.get("uploader")
        if uploader is not None:
            uploader.notify_disconnected()

    client = BleakClient(
        device.ble, disconnected_callback=on_disconnect,
        timeout=args.connect_timeout)
    try:
        await client.connect()
    except Exception as exc:
        raise UploadError(
            f"连接 {device.name or device.address} 失败：{exc}\n"
            f"若固件打开了 BLE_REQUIRE_AUTH，请先配对并在连接时按住开发板中键。"
        ) from exc

    try:
        if args.pair:
            try:
                await client.pair()
            except Exception as exc:
                raise UploadError(f"配对失败：{exc}") from exc

        characteristic = client.services.get_characteristic(CHAR_UUID)
        if characteristic is None:
            raise UploadError(
                "设备没有 0xABF1 特征值；确认固件是支持 BLE 传图的版本")
        try:
            mtu = int(client.mtu_size)
        except Exception:
            mtu = 0

        link = BleakLink(client, characteristic)
        uploader = ParamUploader(
            link, chunk=args.chunk,
            on_progress=_progress_printer(),
            on_log=lambda message: print(f"  {message}"))
        holder["uploader"] = uploader
        await uploader.subscribe()

        print(f"已连接，MTU {mtu or '未知'}")
        total_bytes, with_response = uploader.packet_size(args.mode)
        print(f"每包 {total_bytes}B"
              f"（{'有应答' if with_response else '无应答'}）")
        if (link.supports_write_without_response
                and total_bytes <= COMPAT_TOTAL_BYTES
                and args.mode == "fast" and args.chunk is None):
            print("  系统只报告了 20B 无应答写；可试 --chunk 509，"
                  "失败就退回 --mode compat")

        results = []
        for index, (path, data) in enumerate(jobs):
            if index:
                # 固件 1 秒限流窗口。预览包会把上一条管理命令换成 0x16，
                # 但这里统一等，免得依赖固件内部状态。
                await asyncio.sleep(1.1)
            print(f"[{index + 1}/{len(jobs)}] {path.name}  "
                  f"（{len(data) / 1048576:.2f} MB）")
            try:
                result = await uploader.upload_file(
                    path, data, panel, preview=not args.no_preview,
                    mode=args.mode)
            except UploadError:
                raise
            except Exception as exc:
                hint = ""
                if args.mode == "fast" and args.chunk is None:
                    hint = ("\n写入失败时可以试 --mode compat（20B 有应答），"
                            "或把 --chunk 调小。")
                raise UploadError(
                    f"上传 {path.name} 时蓝牙出错：{exc}{hint}") from exc
            results.append(result)
            if result.preview_error:
                print(f"  缩略图失败（主图已上传）：{result.preview_error}")
            if result.requested_stem != result.stem:
                if STEM_RE.fullmatch(result.requested_stem):
                    print(f"  同名或限流，设备实际采用：{result.stem}")
                else:
                    print(f"  文件名不是固件格式，已改用：{result.stem}")
            print()

        print(f"上传完成：{len(results)} 张")
        print(f"  {'文件':<36}{'设备上的名字'}")
        for result in results:
            print(f"  {result.path.name:<36}{result.stem}")

        if args.record:
            record = Path(args.record)
            record.parent.mkdir(parents=True, exist_ok=True)
            lines = ["# 文件\t请求名\t设备实际名字"]
            for result in results:
                lines.append(
                    f"{result.path.name}\t{result.requested_stem}\t{result.stem}")
            record.write_text("\n".join(lines) + "\n", encoding="utf-8")
            print(f"\n对照表：{record}")
        return 0
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


def _progress_printer():
    state = {"label": "", "percent": -1}
    tty = sys.stdout.isatty()

    def on_progress(label, sent, total):
        percent = sent * 100 // total if total else 100
        if label != state["label"]:
            if state["label"] and tty:
                print()
            state["label"] = label
            state["percent"] = -1
        # 终端里每 5% 刷一次；重定向时每 20% 打一行，避免日志被 \r 塞满
        step = 5 if tty else 20
        if percent == 100 or percent // step != state["percent"] // step:
            state["percent"] = percent
            if tty:
                print(f"\r  {label}：{percent:3d}%", end="", flush=True)
            else:
                print(f"  {label}：{percent:3d}%", flush=True)

    return on_progress


def build_parser():
    parser = argparse.ArgumentParser(
        prog="param-upload.py",
        description="把墨水屏 .bin 经 BLE 传到 EINK 开发板")
    parser.add_argument("files", nargs="*",
                        help="一个或多个 .bin，也可以是包含 .bin 的目录")
    parser.add_argument("--scan", action="store_true",
                        help="只扫描并打印附近的 EINK 设备")
    parser.add_argument("--name", help="按广播名选择设备（可只写一部分）")
    parser.add_argument("--address", help="按蓝牙地址选择设备")
    parser.add_argument("--panel", choices=sorted(PANELS),
                        help="设备名里没有面板标识时手动指定")
    parser.add_argument("--mode", choices=("fast", "compat"), default="fast",
                        help="fast 用无应答写；compat 用 20B 有应答（默认 fast）")
    parser.add_argument("--chunk", type=int,
                        help="强制每包总字节数（含命令字节），默认取系统 MTU；"
                             "写失败就退回 --mode compat")
    parser.add_argument("--no-preview", action="store_true",
                        help="不生成/上传缩略图（设备列表就没有缩略图）")
    parser.add_argument("--timeout", type=float, default=6.0,
                        help="扫描超时秒数（默认 6）")
    parser.add_argument("--connect-timeout", type=float, default=20.0,
                        help="连接超时秒数（默认 20）")
    parser.add_argument("--pair", action="store_true",
                        help="连接后主动配对（固件开启 BLE_REQUIRE_AUTH 时需要）")
    parser.add_argument("--record",
                        help="把「文件 → 设备实际名字」写成 TSV")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="出错时打印完整堆栈")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        if args.scan:
            eink, other = asyncio.run(scan_devices(args.timeout))
            print_scan(eink, other)
            return 0

        files = collect_files(args.files)
        return asyncio.run(run_upload(args, files))
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130
    except UploadError as exc:
        print(f"\n上传失败：{exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        if args.verbose:
            raise
        print(f"\n未预期错误：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
