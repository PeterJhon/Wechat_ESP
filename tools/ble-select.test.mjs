import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../utils/panel.js'
let definition,writes=[],notices=[],failWrite=false,timerId=0
const timers=new Map()
const wx={showToast:x=>notices.push(x),writeBLECharacteristicValue(x){writes.push(x);if(failWrite)x.fail({errCode:10008})}}
vm.runInNewContext(fs.readFileSync(new URL('../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},Uint8Array,setTimeout(f,delay){const id=++timerId;timers.set(id,{f,delay});return id},clearTimeout:id=>timers.delete(id)})
function page(){return Object.assign(Object.create(definition),{data:{connected:true,currentDeviceId:'a',writeServiceId:'s',writeCharacteristicId:'c',imageSrc:'x'},setData(x){Object.assign(this.data,x)},ensureFullResolution(){throw Error('Upload must be blocked during selection')}})}
const event={currentTarget:{dataset:{stem:'20261112-000000-000'}}}
const tick=()=>new Promise(r=>setImmediate(r))
function ack(p,status=0){const w=p._ackWaiters[2];timers.delete(w.timer);delete p._ackWaiters[2];w.resolve({responded:true,ok:status===0,status})}
let p=page();p.data.sending=true;p.selectImage(event);assert.equal(writes.length,0)
p.data.sending=false;p.selectImage(event);assert.equal(writes.length,1);await p.sendToDevice();assert.equal(writes.length,1)
ack(p,2);await tick();const retry=[...timers.values()].find(t=>t.delay===1100);assert(retry)
p.resetSessionState();p.data.currentDeviceId='b';p.data.connected=true;retry.f();assert.equal(writes.length,1);assert.equal(p._selectOperation,null)
// Also reject an old retry when the device changes without a reset notification.
p=page();p.selectImage(event);ack(p,2);await tick();const stale=[...timers.values()].find(t=>t.delay===1100);p.data.currentDeviceId='other';const before=writes.length;stale.f();assert.equal(writes.length,before);assert.equal(p._selectOperation,null)
// Old ACK callbacks must not clear a new operation after reconnect.
p=page();p.selectImage(event);p.resetSessionState();p.selectImage(event);const current=p._selectOperation;await tick();assert.equal(p._selectOperation,current);ack(p);await tick();assert.equal(p._selectOperation,null);assert.equal(notices.at(-1).icon,'success')
// Write failure settles the waiter immediately and does not schedule a retry.
p=page();failWrite=true;const toastCount=notices.length;p.selectImage(event);await tick();assert.equal(p._selectOperation,null);assert.equal(Object.keys(p._ackWaiters).length,0);assert.equal(notices.length,toastCount+1)
// Selection can begin while asynchronous full-resolution rendering is running.
p=page();failWrite=false;p.processedBinary=new Uint8Array(8).buffer
p.ensureFullResolution=async()=>{p.selectImage(event);return true}
const renderBefore=writes.length;await p.sendToDevice();assert.equal(writes.length,renderBefore+1)
assert.equal(new Uint8Array(writes.at(-1).value)[0],0x12);p.cancelSelect();await tick()
console.log('PASS: upload/select exclusion including asynchronous rendering, cancelled retry after disconnect, device identity checks, stale ACK isolation and write-failure cleanup')
