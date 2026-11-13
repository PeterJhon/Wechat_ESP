import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {BleFirmwareSender, BLE_OTA} from '../../utils/ble-ota.js'

const image = Buffer.alloc(1024)
image[0] = 0xe9; image[23] = 1; image.writeUInt16LE(9, 12)
image.writeUInt32LE(0xabcd5432, 32); image.write('1.2.0-universal', 48)
image.write('ESP_S3_EINK', 80); image.write('EINK_BUILD_PROFILE=release\0', 128)
crypto.createHash('sha256').update(image.subarray(0, -32)).digest().copy(image, image.length - 32)
const sha = crypto.createHash('sha256').update(image).digest('hex')
const manifest = {size: image.length, sha256: sha, version: '1.2.0-universal'}
function setup({failAt, corrupt = false, disconnect = false, hold = false} = {}) {
  const writes = [], progress = [], received = [], committed = []
  let sender, active = true, position = 0, held
  const ack = (command, offset, status = 0) => {
    const bytes = new Uint8Array(7); bytes.set([BLE_OTA.REPLY, command, status])
    new DataView(bytes.buffer).setUint32(3, offset, true)
    sender.receive(bytes)
  }
  const api = {
    getFileSystemManager() { return {
      stat(x) { x.success({stats: {size: image.length}}) },
      readFile(x) { const data = Buffer.from(image); if (corrupt) data[400] ^= 1; x.success({data}) }
    } },
    writeBLECharacteristicValue(x) {
      assert.equal(x.writeType, 'write'); assert.equal(x.deviceId, 'A')
      const packet = new Uint8Array(x.value); writes.push(packet)
      if (failAt === 'write') { x.fail({}); return }
      x.success()
      const command = packet[0]
      if (command === BLE_OTA.ABORT) return
      if (failAt === command) { ack(command, position, 1); return }
      if (command === BLE_OTA.BEGIN) { assert.equal(new DataView(packet.buffer).getUint32(1, true), image.length); ack(command, 0) }
      if (command === BLE_OTA.DATA) {
        const offset = new DataView(packet.buffer).getUint32(1, true)
        assert.equal(offset, position)
        if (hold) { held = () => ack(command, position + packet.length - 5); return }
        received.push(...packet.subarray(5)); position += packet.length - 5
        ack(command, offset) // delayed duplicate of the previous DATA ACK
        if (disconnect) { active = false; sender.cancel(); return }
        ack(command, position)
      }
      if (command === BLE_OTA.END) ack(command, position)
    }
  }
  sender = new BleFirmwareSender(api, {deviceId: 'A', serviceId: 's', characteristicId: 'c', active: () => active},
    value => progress.push(value), version => committed.push(version))
  return {sender, writes, progress, received, committed, release: () => held?.()}
}
for (const mtu of [23, 185, 512]) {
  const h = setup()
  await h.sender.install('/tmp/app.bin', manifest, '1.1.0-universal', mtu)
  assert.equal(h.sender.accepted, true)
  assert.deepEqual(Buffer.from(h.received).subarray(0, 32), Buffer.from(sha, 'hex'))
  assert.deepEqual(Buffer.from(h.received).subarray(32), image)
  assert(h.writes.every(p => p.length <= Math.min(509, mtu - 3)))
  assert.equal(h.writes.at(-1)[0], BLE_OTA.END)
  assert.equal(h.committed[0], manifest.version)
  assert.match(h.progress.at(-1).firmwareStatus, /重新连接确认/)
  assert(h.progress.every(p => !p.firmwareStatus?.includes('升级成功')))
}
for (const failAt of [BLE_OTA.BEGIN, BLE_OTA.DATA, BLE_OTA.END, 'write']) {
  const h = setup({failAt})
  await assert.rejects(h.sender.install('/tmp/app.bin', manifest, '1.1.0-universal', 512))
  assert.equal(h.sender.accepted, false)
  if (failAt !== BLE_OTA.END) assert(h.writes.some(p => p[0] === BLE_OTA.ABORT))
}
let h = setup({corrupt: true})
await assert.rejects(h.sender.install('/tmp/app.bin', manifest, '1.1.0-universal', 512), /SHA-256/)
assert.equal(h.writes.length, 0)
h = setup({disconnect: true})
await assert.rejects(h.sender.install('/tmp/app.bin', manifest, '1.1.0-universal', 512))
assert(!h.writes.some(p => p[0] === BLE_OTA.END))
h = setup({hold: true})
const installing = h.sender.install('/tmp/app.bin', manifest, '1.1.0-universal', 512)
await new Promise(resolve => setImmediate(resolve))
h.sender.cancel(); h.release()
await assert.rejects(installing, /取消/)
assert(h.writes.some(p => p[0] === BLE_OTA.ABORT))
assert(!h.writes.some(p => p[0] === BLE_OTA.END))
h = setup()
await assert.rejects(h.sender.install('/tmp/app.bin', manifest, manifest.version, 512), /高于/)
assert.equal(h.writes.length, 0)

// Retry only DATA whose ATT write completed but whose application ACK was lost.
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
const deadlines = [], retried = []
try {
  globalThis.setTimeout = fn => { deadlines.push(fn); return deadlines.length }
  globalThis.clearTimeout = () => {}
  let sender
  const api = {writeBLECharacteristicValue(x) {
    retried.push(new Uint8Array(x.value)); x.success()
    if (retried.length === 2) sender.receive(new Uint8Array([0x35, 0x31, 0, 10, 0, 0, 0]))
  }}
  sender = new BleFirmwareSender(api, {deviceId: 'A', serviceId: 's', characteristicId: 'c', active: () => true}, () => {})
  const packet = new Uint8Array([0x31, 0, 0, 0, 0, 1, 2])
  const sending = sender.send(packet, 10, 1)
  deadlines[0]()
  await sending
  assert.equal(retried.length, 2)
  assert.deepEqual(retried[0], retried[1])
  assert.equal(sender.pending, null)
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
console.log('PASS: BLE OTA metadata/body across MTUs, device ACK/offset, duplicate ACK, rejection, corruption, cancellation and disconnect')
