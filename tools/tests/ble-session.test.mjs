import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'
import { packToWire } from '../../utils/epd-wire.js'
let definition, messages=[], writes=[]
const wx={hideToast(){},showToast(x){messages.push(x)},showModal(x){messages.push(x)},
  writeBLECharacteristicValue(x){writes.push(new Uint8Array(x.value)[0]);x.success()}}
const sandbox={...panels,packToWire,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,Uint8Array,ArrayBuffer}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),sandbox)
function page(){return Object.assign(Object.create(definition),{data:{connected:true,imageSrc:'test',writeServiceId:'s',writeCharacteristicId:'c',currentDeviceId:'d',mtu:23},setData(x){Object.assign(this.data,x)},processedBinary:new Uint8Array(8).buffer,_panel:{width:8,height:1},ensureFullResolution:async()=>true,makeStem:()=> '20261112-000000-000',buildPreviewJpeg:async()=>null,sleep:async()=>{}})}
let p=page(), pending=p.waitForAck(1,5000)
p.resetSessionState()
assert.equal((await pending).responded,false)
assert.equal(Object.keys(p._ackWaiters).length,0)
for(const failed of ['start','end']){
  p=page();messages=[];writes=[]
  p.waitForFileStartAck=async()=>({responded:failed!=='start',ok:true,stem:''})
  p.waitForFileEndAck=async()=>({responded:false,ok:false})
  await p.sendToDevice()
  assert(messages.some(x=>x.content?.includes('timed out')))
  assert(!messages.some(x=>x.icon==='success'))
  assert.equal(writes.at(-1),4)
  if(failed==='start')assert(!writes.includes(2))
}
p=page();messages=[];writes=[]
p.waitForFileStartAck=async()=>{p.resetSessionState();return {responded:false,ok:false}}
await p.sendToDevice()
assert.deepEqual(writes,[])
assert.equal(messages.length,0)
console.log('PASS: ACK reset settles, start/end timeout fail, disconnect cancels stale upload')
