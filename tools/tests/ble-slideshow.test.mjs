import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'
let definition,writes=[],timerId=0,failWrite=false
const timers=new Map()
const wx={showToast(){},writeBLECharacteristicValue(x){writes.push(x);if(failWrite)x.fail({errCode:10008})}}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},Uint8Array,setTimeout(f,ms){const id=++timerId;timers.set(id,{f,ms});return id},clearTimeout:id=>timers.delete(id)})
function page(){return Object.assign(Object.create(definition),{data:{connected:true,currentDeviceId:'A',writeServiceId:'s',writeCharacteristicId:'c',imageSrc:'x',slideshowEnabled:true,slideshowInterval:60},setData(x){Object.assign(this.data,x)},ensureFullResolution(){throw Error('Upload should be blocked')}})}
const tick=()=>new Promise(r=>setImmediate(r))
function ack(p,status){let w=p._ackWaiters[3];timers.delete(w.timer);delete p._ackWaiters[3];w.resolve({responded:true,ok:status===0,status})}
function takeTimer(ms){let pair=[...timers.entries()].find(([,t])=>t.ms===ms);assert(pair);timers.delete(pair[0]);return pair[1].f}
// Upload waiters survive slideshow changes; no control packet is sent during upload.
let p=page();p.data.sending=true;const end=p.waitForFileEndAck();const waiter=p._ackWaiters[3];p.sendSlideshowConfig(true,60);p.onSlideshowToggle({detail:{value:false}});p.queueSlideshowConfig();assert.equal(writes.length,0);assert.equal(p._ackWaiters[3],waiter);ack(p,0);assert.equal((await end).ok,true)
// Debounce belongs to the connection that created it, including same-device reconnects.
p=page();p.queueSlideshowConfig();const stale=takeTimer(400);p.resetSessionState();p.data.currentDeviceId='B';stale();assert.equal(writes.length,0)
// A queued setting excludes uploads and list/selection commands before it sends.
p=page();p.queueSlideshowConfig();await p.sendToDevice();p.requestFileList();p.selectImage({currentTarget:{dataset:{stem:'test'}}});assert.equal(writes.length,0)
// Rapid debounce changes retain only the latest value.
p.cancelSlideshow();p.queueSlideshowConfig();p.data.slideshowInterval=120;p.queueSlideshowConfig();takeTimer(400)();assert.equal(new Uint8Array(writes.at(-1).value)[2],120);ack(p,2);await tick()
const retry=takeTimer(500),before=writes.length;p.resetSessionState();p.data.currentDeviceId='B';retry();assert.equal(writes.length,before)
// Old ACK completion cannot erase a new session's pending setting.
p=page();p.sendSlideshowConfig(true,60);p.resetSessionState();p.data.currentDeviceId='B';p.queueSlideshowConfig();const current=p._slideshowOperation;await tick();assert.equal(p._slideshowOperation,current);p.cancelSlideshow()
// Busy retry stays on A; success releases the lock without state-query traffic.
p=page();p.sendSlideshowConfig(true,60);ack(p,2);await tick();takeTimer(500)();assert.equal(writes.at(-1).deviceId,'A');ack(p,0);await tick();assert.equal(p._slideshowOperation,null)
// Failed writes settle ACKs and restore state through a read-only query.
p=page();failWrite=true;p.sendSlideshowConfig(true,60);await tick();failWrite=false;assert.equal(p._slideshowOperation,null);assert.equal(Object.keys(p._ackWaiters).length,0);assert.equal(new Uint8Array(writes.at(-1).value)[0],0x14)
console.log('PASS: slideshow/upload exclusion, debounced updates, stale timers and ACKs, bounded retries and write-failure cleanup')
