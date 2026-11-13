import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'

let definition, timerId = 0
const timers = new Map(), writes = [], clients = []
class FirmwareUpdater {
  constructor(api, url, version, callback) {
    Object.assign(this, {version, callback, checks: 0, disposed: false})
    clients.push(this)
  }
  check() { this.checks++ }
  dispose() { this.disposed = true }
}
const stored = new Map(), modals = []
const wx = {writeBLECharacteristicValue(x) { writes.push(new Uint8Array(x.value)); x.success() },
  getStorageSync(key) { return stored.get(key) }, removeStorageSync(key) { stored.delete(key) },
  showModal(value) { modals.push(value) }}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/mg, ''), {...panels, FirmwareUpdater, FIRMWARE_MANIFEST_URL: '', wx,
  console: {log() {}, warn() {}, error() {}}, Uint8Array,
  Page(x) { definition = x }, setTimeout(f, ms) { const id = ++timerId; timers.set(id, {f, ms}); return id },
  clearTimeout(id) { timers.delete(id) }})
function page() {
  writes.length = 0; timers.clear()
  return Object.assign(Object.create(definition), {
    data: {...definition.data, connected: true, notifyEnabled: true, currentDeviceId: 'A',
      writeServiceId: 's', writeCharacteristicId: 'c'}, setData(x) { Object.assign(this.data, x) }
  })
}
let p = page(); p.queryFirmwareInfo()
assert.equal(writes[0][0], 0x19)
const count = writes.length
p.requestFileList(); p.sendSlideshowConfig(true, 30); p.queryWifiState()
assert.equal(writes.length, count, 'version query excludes list/control transactions')
p.handleFirmwareInfo(new Uint8Array([0x19, 1, 0, 10, 0, 0, 1, 1]))
assert.equal(p.data.firmwareCurrent, '1.10.256-universal')
const client = clients.at(-1)
assert.equal(client.version, '1.10.256-universal'); assert.equal(client.checks, 1)
client.callback({firmwareStatus: 'downloaded'}); assert.equal(p.data.firmwareStatus, 'downloaded')
p.resetSessionState(); p.data.currentDeviceId = 'B'
assert.equal(client.disposed, true)
client.callback({firmwareStatus: 'stale'}); assert.notEqual(p.data.firmwareStatus, 'stale')
assert.equal(p.data.firmwareCurrent, '')
p.data.notifyEnabled = true
p.queryFirmwareInfo(); const timeout = [...timers.values()].find(x => x.ms === 4000)
timeout.f(); assert.match(p.data.firmwareStatus, /无法读取设备版本/)
assert.equal(p._deviceInfoOperation, null)
console.log('PASS: BLE firmware version, transaction exclusion, automatic check and reconnect cleanup')

// A committed transfer is successful only after the target boots and confirms.
p = page()
stored.set('eink_ota_pending_A', {version: '1.1.13-universal'})
p.queryFirmwareInfo()
p.handleFirmwareInfo(new Uint8Array([0x19, 1, 0, 1, 0, 13, 0, 1, 1, 0]))
assert.equal(p.data.firmwareBleSupported, true)
assert.equal(p.data.firmwareConfirmed, false)
assert.equal(modals.length, 0)
assert(stored.has('eink_ota_pending_A'))
const poll = [...timers.values()].find(x => x.ms === 2000)
poll.f()
p.handleFirmwareInfo(new Uint8Array([0x19, 1, 0, 1, 0, 13, 0, 1, 1, 1]))
assert.equal(modals.at(-1).title, '升级成功')
assert.equal(stored.has('eink_ota_pending_A'), false)

// A rollback to an older, non-BLE-OTA firmware must not claim success.
p = page(); stored.set('eink_ota_pending_A', {version: '1.1.13-universal'})
p.queryFirmwareInfo()
p.handleFirmwareInfo(new Uint8Array([0x19, 1, 0, 1, 0, 12, 0, 1]))
assert.equal(p.data.firmwareBleSupported, false)
assert.equal(modals.at(-1).title, '升级结果待检查')
assert.match(modals.at(-1).content, /回滚/)
console.log('PASS: BLE OTA capability, delayed boot confirmation and rollback result')
