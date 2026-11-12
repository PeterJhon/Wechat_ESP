import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'
let definition, writes=0
const listeners=new Map(), removed=[]
const wx={writeBLECharacteristicValue(x){writes++;x.success()},showToast(){}}
const names=['BluetoothAdapterStateChange','BluetoothDeviceFound','BLEConnectionStateChange','BLECharacteristicValueChange']
for(const name of names){
 wx['on'+name]=f=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(f)}
 wx['off'+name]=f=>{removed.push(f);listeners.get(name)?.delete(f)}
}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,Uint8Array})
function page(){return Object.assign(Object.create(definition),{data:{connected:true,currentDeviceId:'d',renderedCount:2},_thumbGeneration:0,setData(){},thumbPath:x=>x})}
const tick=()=>new Promise(r=>setImmediate(r))
// Refresh cannot interleave list bytes with a pending delete acknowledgement.
let p=page();p._deletePending=true;p.requestFileList();assert.equal(writes,0)
p._deletePending=false;p.data.loadingFiles=true;p.requestFileList();assert.equal(writes,0)

p=page();let active=0,maximum=0,reads=[],release
p.fileExists=async()=>false;p.writeFile=async()=>{}
p.readPreview=stem=>{reads.push(stem);active++;maximum=Math.max(maximum,active);return new Promise(r=>{release=()=>{active--;r(new ArrayBuffer(1))}})}
const a={stem:'a',previewSize:1,thumb:''},b={stem:'b',previewSize:1,thumb:''}
const first=p.loadThumbnails([a]);await tick()
const second=p.loadThumbnails([a,b]);await tick()
assert.equal(maximum,1);assert.deepEqual(reads,['a'])
release();await first;await tick();assert.deepEqual(reads,['a','b'])
release();await second;assert.equal(maximum,1)

p=page();let updates=0,finish
p.fileExists=async()=>false;p.writeFile=async()=>{updates++}
p.readPreview=()=>new Promise(r=>{finish=r})
const old=p.loadThumbnails([{stem:'old',previewSize:1}]);await tick()
p._thumbGeneration++;finish(new ArrayBuffer(1));await old;assert.equal(updates,0)

p=page();p.writeStemField=()=>new Uint8Array(20)
const preview=p.readPreview('a',10)
const rejected=assert.rejects(preview,/Bluetooth session ended/)
p.resetSessionState();await rejected;assert.equal(p._previewPending,null)

p=page();let delivered=0
for(const name of names)p.registerBluetoothListener(name,()=>{delivered++})
const oldCallbacks=Object.values(p._bluetoothListeners)
const other=page();for(const name of names)other.registerBluetoothListener(name,()=>{delivered++})
p.closeBluetooth=()=>{};p.onUnload();assert.equal(removed.length,4)
for(const name of names)assert.equal(listeners.get(name).size,1)
for(const callback of oldCallbacks)callback({deviceId:'d'})
assert.equal(delivered,0)
for(const name of names)for(const callback of listeners.get(name))callback({deviceId:'d'})
assert.equal(delivered,4)
console.log('PASS: refresh/delete exclusion, serialized previews, stale-read cancellation, preview cleanup and scoped listener removal')
