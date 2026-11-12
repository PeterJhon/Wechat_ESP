import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../../utils/panel.js'
import {packToWire} from '../../utils/epd-wire.js'
let definition,notify,failData=false,packets=[],notices=[],modes=[]
const wx={env:{USER_DATA_PATH:'/cache'},notifyBLECharacteristicValueChange(x){x.success()},onBLECharacteristicValueChange(f){notify=f},showToast(x){notices.push(x)},showModal(x){notices.push(x)},hideToast(){},writeBLECharacteristicValue(x){
 const bytes=new Uint8Array(x.value);packets.push(bytes);modes.push(x.writeType);if(bytes[0]!==2)assert.equal(x.writeType,'write');x.success()
 if([1,3,4].includes(bytes[0]))notify({deviceId:'dev',value:new Uint8Array([255,bytes[0]<<4]).buffer})
 if(bytes[0]===2&&failData)notify({deviceId:'dev',value:new Uint8Array([255,0x21]).buffer})
}}
vm.runInNewContext(fs.readFileSync(new URL('../../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,packToWire,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},setTimeout:(f,n)=>n===300?0:setTimeout(f,n),clearTimeout,Uint8Array,ArrayBuffer})
function page(){return Object.assign(Object.create(definition),{data:{connected:true,currentDeviceId:'dev',imageSrc:'test',writeServiceId:'s',writeCharacteristicId:'c',mtu:512},setData(x){Object.assign(this.data,x)},processedBinary:new Uint8Array(800).buffer,_panel:{width:800,height:1},ensureFullResolution:async()=>true,makeStem:()=> '20261112-000000-000',buildPreviewJpeg:async()=>null,sleep:async()=>{},requestFileList(){}})}
for(const failure of [false,true]){
 failData=failure;packets=[];notices=[];let p=page();p.enableNotify('dev','s','c');notices=[];await p.sendToDevice()
 const data=packets.filter(x=>x[0]===2)
 assert(data.every(x=>x.length<=245))
 if(failure){assert.equal(data.length,1);assert(!packets.some(x=>x[0]===3));assert.equal(packets.at(-1)[0],4);assert(!notices.some(x=>x.icon==='success'))}
 else{assert.equal(data.reduce((sum,x)=>sum+x.length-1,0),300);assert(notices.some(x=>x.icon==='success'))}
}
let p=page();const first=p.thumbPath('same',10);p.data.currentDeviceId='other';assert.notEqual(p.thumbPath('same',10),first);assert.notEqual(p.thumbPath('same',11),p.thumbPath('same',10))
console.log('PASS: acknowledged writes, bounded packets, complete payload, stop on DATA rejection, device-specific cache keys')

failData=false;packets=[];modes=[];notices=[]
p=page();p._writeNoResponseSupported=true;p.processedBinary=new Uint8Array(80000).buffer;p._panel={width:80000,height:1}
p.enableNotify('dev','s','c');notices=[];await p.sendToDevice()
const fast=packets.map((bytes,i)=>({bytes,mode:modes[i]})).filter(x=>x.bytes[0]===2)
assert(fast.every(x=>x.bytes.length<=509))
assert.equal(fast.reduce((sum,x)=>sum+x.bytes.length-1,0),30000)
assert(fast.some(x=>x.mode==='writeNoResponse'))
assert.equal(fast.at(-1).mode,'write')
assert.equal(fast.filter(x=>x.mode==='write').length,Math.ceil(fast.length/16))
assert(notices.some(x=>x.icon==='success'))
console.log(`PASS: fast upload uses ${fast.length} DATA packets, ${fast.filter(x=>x.mode==='write').length} answered fences, preserved FILE_END confirmation`)

// Reuse one live session for repeated transfers, including recoverable DATA
// rejection. This exercises control cleanup, not radio throughput.
p=page();p.enableNotify('dev','s','c')
for(let cycle=0;cycle<20;cycle++) {
 failData=cycle%4===3;packets=[];modes=[];notices=[]
 await p.sendToDevice()
 assert.equal(p.data.sending,false)
 assert.equal(Object.keys(p._ackWaiters||{}).length,0)
 if(failData) assert.equal(packets.at(-1)[0],4)
 else assert(packets.some(packet=>packet[0]===3))
}
console.log('PASS: 20 repeated mock uploads recover after DATA rejection without retaining ACK waiters')
