import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'

let definition, notify, listener
const timers = new Map(), writes = []
let nextTimer = 0
const wx = {
  notifyBLECharacteristicValueChange(options) { notify = options },
  onBLECharacteristicValueChange(callback) { listener = callback },
  writeBLECharacteristicValue(options) {
    assert.equal(typeof listener, 'function')
    writes.push(new Uint8Array(options.value)[0])
  },
  showToast() {}
}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/mg, ''), {
  ...panels, wx, Page(value) { definition = value }, Uint8Array,
  console: {log() {}, warn() {}, error() {}},
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id },
  clearTimeout(id) { timers.delete(id) }
})
function page() {
  return Object.assign(Object.create(definition), {
    data: {connected: true, currentDeviceId: 'A', writeServiceId: 'ABF0',
      writeCharacteristicId: 'ABF1', devices: [], visibleFiles: []},
    setData(value) { Object.assign(this.data, value) },
    pruneThumbnailCache() {}, loadThumbnails() {}
  })
}
const p = page()
p.enableNotify('A', 'ABF0', 'ABF1')
assert.equal(writes.length, 0)
notify.success()
assert.equal(p.data.notifyEnabled, true)
const initial = [...timers.values()].find(timer => timer.delay === 0)
assert(initial, 'notification setup automatically schedules the list')
initial.callback()
assert.equal(writes[0], 0x10)
assert.equal(p.data.loadingFiles, true)
const reply = new Uint8Array(33)
reply.set([0x10, 1, 0, 1, 0])
const stem = '20261112-120000-000'
reply.set([...stem].map(c => c.charCodeAt(0)), 5)
listener({deviceId: 'A', value: reply.buffer})
assert.equal(p.data.fileTotal, 1)
assert.equal(p.data.visibleFiles[0].stem, stem)
assert.equal(p.data.loadingFiles, false)
// An automatic read belonging to an old connection must never reach a new one.
timers.clear()
const q = page()
q.enableNotify('A', 'ABF0', 'ABF1')
notify.success()
const stale = [...timers.values()].find(timer => timer.delay === 0)
q._sessionGeneration = 1
q.data.currentDeviceId = 'B'
const count = writes.length
stale.callback()
assert.equal(writes.length, count)
// Automatic initialization retries at most twice; an empty successful reply
// must remain distinguishable from failure and an uninitialized list.
timers.clear()
const r = page()
r.requestFileList({automatic: true, attempt: 0})
for (let attempt = 0; attempt < 2; attempt++) {
  r.abortFileList('timeout')
  assert.equal(r.data.loadingFiles, false)
  assert(r.data.fileListError)
  const retryEntry = [...timers.entries()].find(([, timer]) => timer.delay === 1200)
  assert(retryEntry)
  timers.delete(retryEntry[0])
  retryEntry[1].callback()
  assert.equal(r._fileListOperation.attempt, attempt + 1)
  assert.equal(r.data.loadingFiles, true)
}
r.abortFileList('timeout')
assert.equal([...timers.values()].filter(timer => timer.delay === 1200).length, 0)
assert(r.data.fileListError)
r.requestFileList()
r.finishFileList()
assert.equal(r.data.filesLoaded, true)
assert.equal(r.data.fileTotal, 0)
assert.equal(r.data.fileListError, '')
// A manual refresh supersedes the queued automatic retry.
r.requestFileList({automatic: true, attempt: 0})
r.abortFileList('timeout')
const cancelledRetry = [...timers.values()].find(timer => timer.delay === 1200)
r.requestFileList()
const manual = r._fileListOperation
cancelledRetry.callback()
assert.equal(r._fileListOperation, manual)

// Refresh must not replace a successful list with a partial failed response.
r.abortFileList('cancel')
const saved=[{stem:'saved-a'},{stem:'saved-b'}]
const savedIndex=new Map(saved.map((file,index)=>[file.stem,index]))
r._allFiles=saved;r._stemIndex=savedIndex
r.setData({visibleFiles:saved.slice(0,1),fileTotal:2,renderedCount:1,filesLoaded:true})
r.requestFileList()
r._allFiles.push({stem:'incomplete'})
r.abortFileList('second page timed out')
assert.equal(r._allFiles,saved)
assert.equal(r._stemIndex,savedIndex)
assert.equal(r.data.visibleFiles[0].stem,'saved-a')
assert.equal(r.data.fileTotal,2)
assert.equal(r.data.renderedCount,1)
assert.equal(r.data.filesLoaded,true)
assert(r.data.fileListError)
// A successful empty refresh really does remove the old list.
r.requestFileList();r.finishFileList()
assert.equal(r.data.fileTotal,0)
assert.equal(r.data.fileListError,'')

// Full device capacity: 32 fragmented pages, ordered and without duplicates.
const large = page()
large.requestFileList()
for (let pageIndex=0; pageIndex<32; pageIndex++) {
  const bytes=new Uint8Array(5+16*28)
  bytes.set([0x10,0,2,16,0])
  for(let item=0;item<16;item++) {
    const name='20261112-120000-'+String(pageIndex*16+item).padStart(3,'0')
    bytes.set([...name].map(c=>c.charCodeAt(0)),5+item*28)
  }
  large.beginFileList(bytes.subarray(0,2))
  large.appendFileList(bytes.subarray(2,190))
  large.appendFileList(bytes.subarray(190))
}
assert.equal(large.data.fileTotal,512)
assert.equal(large.data.renderedCount,50)
assert.equal(new Set(large._allFiles.map(file=>file.stem)).size,512)
const fullList=large._allFiles
large.requestFileList()
large.beginFileList(new Uint8Array([0x10,0,2,17,0]))
assert(large.data.fileListError)
assert.equal(large._allFiles,fullList)
large.requestFileList()
large.beginFileList(new Uint8Array([0x10,0,2,16,0]))
large.appendFileList(new Uint8Array(500))
assert.equal(large._fileListBuffer,null)
assert.equal(large._allFiles,fullList)
large.requestFileList()
const repeated=new Uint8Array(33)
repeated.set([0x10,2,0,1,0])
repeated.set([...stem].map(c=>c.charCodeAt(0)),5)
large.beginFileList(repeated)
large.beginFileList(repeated)
assert(large.data.fileListError,'repeated cursor must fail rather than append forever')
assert.equal(large._allFiles,fullList)
console.log('PASS: first connection loads actual file records automatically; stale initialization is ignored')
