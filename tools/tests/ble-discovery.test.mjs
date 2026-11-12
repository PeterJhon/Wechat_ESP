import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'

let definition, found
const starts = [], stops = [], timers = new Map()
let timerId = 0
const wx = {
  onBluetoothDeviceFound(callback) { found = callback },
  startBluetoothDevicesDiscovery(options) {
    assert.equal(typeof found, 'function', 'listen before discovery starts')
    starts.push(options)
  },
  stopBluetoothDevicesDiscovery(options) { stops.push(options) },
  showToast() {}
}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/mg, ''), {
  ...panels, wx, Page(value) { definition = value },
  console: {log() {}, warn() {}, error() {}},
  setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
  clearTimeout(id) { timers.delete(id) }
})
const p = Object.assign(Object.create(definition), {
  data: { searching: false, devices: [] },
  setData(value) { Object.assign(this.data, value) },
  isTargetDevice() { return true }, signalLevel() { return 3 }
})
const advertisement = {devices: [{deviceId: 'frame', name: 'EINK-800-1234', RSSI: -40}]}
p.startSearch()
assert.equal(starts[0].allowDuplicatesKey, true)
// Firmware can advertise before the native discovery success callback.
found(advertisement)
assert.equal(p.data.devices.length, 1)
starts[0].success({})
const oldTimer = [...timers.values()][0]
p.stopSearch()
p.startSearch()
assert.equal(p.data.devices.length, 0)
found(advertisement)
found(advertisement)
assert.equal(p.data.devices.length, 1, 'same peripheral returns without duplicate rows')
stops[0].complete()
oldTimer()
starts[0].fail({})
assert.equal(p.data.searching, true, 'old callbacks cannot stop the new scan')
starts[1].success({})
p.stopSearch()
assert.equal(timers.size, 0)
found({devices: [{deviceId: 'late', name: 'EINK-800-5678', RSSI: -30}]})
assert.equal(p.data.devices.length, 1, 'ignore advertisements after stop')
console.log('PASS: rediscovery, early advertisements, deduplication and stale scan callbacks')

p.startSearch()
found({devices:[{deviceId:'boot',name:'EINK-STARTING-1234',RSSI:-40}]})
assert.equal(p.data.devices[0].starting,true)
assert.equal(p._searchWaitingPanel,true,'keep scanning long enough for panel detection')
const before=p._connectionAttempt
p.connectDevice({currentTarget:{dataset:{device:p.data.devices[0]}}})
assert.equal(p._connectionAttempt,before,'starting panel cannot be uploaded with guessed dimensions')
found({devices:[{deviceId:'boot',name:'EINK-STARTING-1234',localName:'EINK-800-1234',RSSI:-38}]})
assert.equal(p.data.devices.length,1)
assert.equal(p.data.devices[0].name,'EINK-800-1234')
assert.equal(p.data.devices[0].starting,false)
p.stopSearch()
console.log('PASS: early boot advertisement transitions to the detected panel in the same scan')
