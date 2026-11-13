import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'

let definition, nextTimer = 0, failWrite = false
const timers = new Map(), writes = [], toasts = []
const wx = {
  showToast(x) { toasts.push(x) },
  writeBLECharacteristicValue(x) {
    writes.push(new Uint8Array(x.value))
    if (failWrite) x.fail({errCode: 10008})
    else x.success?.()
  }
}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/mg, ''), {...panels, wx, Page(x) { definition = x },
  console: {log() {}, warn() {}, error() {}}, Uint8Array,
  setTimeout(f, ms) { const id = ++nextTimer; timers.set(id, {f, ms}); return id },
  clearTimeout(id) { timers.delete(id) }})
function page() {
  timers.clear(); writes.length = 0; toasts.length = 0
  return Object.assign(Object.create(definition), {
    data: {...definition.data, connected: true, notifyEnabled: true,
      currentDeviceId: 'A', writeServiceId: 's', writeCharacteristicId: 'c'},
    setData(x) { Object.assign(this.data, x) }
  })
}
function state(p, enabled, running, pending = 0, failed = 0) {
  p.handleWifiState(new Uint8Array([0x18, enabled, running, pending, failed]))
}
function ack(p, status) {
  const waiter = p._ackWaiters[7]
  timers.delete(waiter.timer); delete p._ackWaiters[7]
  waiter.resolve({responded: true, ok: status === 0, status})
}
const tick = () => new Promise(resolve => setImmediate(resolve))

// Read actual device preference; no assumption based on phone-local settings.
let p = page()
p.queryWifiState(); assert.equal(writes[0][0], 0x18)
state(p, 1, 1); assert.equal(p.data.wifiKnown, true); assert.equal(p.data.wifiEnabled, true)
assert.equal(p._wifiOperation, null)

// A saved preference ACK is not completion: wait for the runtime to stop.
p.onWifiToggle({detail: {value: false}})
assert.deepEqual([...writes.at(-1)], [0x17, 0])
ack(p, 0); await tick()
assert.equal(p.data.wifiBusy, true)
state(p, 0, 1, 1); assert.equal(p.data.wifiBusy, true)
state(p, 0, 1); assert.equal(p.data.wifiBusy, true) // snapshot crossing transition
state(p, 0, 0); assert.equal(p.data.wifiBusy, false)
assert.equal(p.data.wifiEnabled, false); assert.equal(toasts.at(-1).title, 'Wi-Fi 已关闭')
assert.equal(timers.size, 0)

// Other BLE transactions cannot begin during a setting or state query.
p = page(); p.queryWifiState()
const count = writes.length
p.requestFileList(); p.selectImage({currentTarget: {dataset: {stem: 'x'}}})
p.sendSlideshowConfig(true, 60)
assert.equal(writes.length, count)
state(p, 0, 0)
p.data.sending = true; p.onWifiToggle({detail: {value: true}})
assert.equal(writes.length, count)

// Failed persistence / busy responses refresh state rather than claiming success.
p = page(); p.data.wifiKnown = true
p.onWifiToggle({detail: {value: true}}); ack(p, 2); await tick()
assert.equal(writes.at(-1)[0], 0x18); state(p, 0, 0)
assert.equal(p.data.wifiEnabled, false)

// Driver failure is distinct from successful persistence.
p.onWifiToggle({detail: {value: true}}); ack(p, 0); await tick()
state(p, 1, 0, 0, 1)
assert.match(p.data.wifiStatus, /切换失败/); assert.equal(p.data.wifiBusy, false)

// Old firmware times out, and does not expose a functioning-looking switch.
p = page(); p.queryWifiState()
const timeout = [...timers.values()].find(t => t.ms === 4000)
timeout.f(); assert.equal(p.data.wifiKnown, false); assert.match(p.data.wifiStatus, /升级/)

// Late ACKs and polling callbacks cannot mutate a reconnected session.
p = page(); p.data.wifiKnown = true
p.onWifiToggle({detail: {value: true}}); ack(p, 0); await tick()
const stalePoll = [...timers.values()].find(t => t.ms === 500).f
p.resetSessionState(); p.data.currentDeviceId = 'B'
const before = writes.length
stalePoll(); state(p, 1, 1); await tick()
assert.equal(writes.length, before); assert.equal(p.data.wifiKnown, false)

// Write errors release both operation and ACK waiter.
p = page(); p.data.wifiKnown = true; failWrite = true
p.onWifiToggle({detail: {value: true}}); await tick(); failWrite = false
assert.equal(p._wifiOperation, null); assert.equal(p.data.wifiKnown, false)
assert.equal(Object.keys(p._ackWaiters).length, 0)
console.log('PASS: Wi-Fi device state, persistence vs runtime completion, transaction exclusion, busy/failure, old firmware and stale session cleanup')
