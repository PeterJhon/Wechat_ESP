import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../utils/panel.js'
let definition, writes=[], notices=[]
const wx={showModal(x){x.success({confirm:true})},showToast(x){notices.push(x)},writeBLECharacteristicValue(x){writes.push(x)}}
vm.runInNewContext(fs.readFileSync(new URL('../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console,setTimeout,clearTimeout,Uint8Array})
for(const result of [{responded:true,ok:true},{responded:true,ok:false,status:2},{responded:false,ok:false}]){
 let removed=[],resolveAck;writes=[];notices=[]
 const p=Object.assign(Object.create(definition),{data:{connected:true},stemToLabel:x=>x,writeStemField:()=>new Uint8Array(20),removeFileLocally:x=>removed.push(x),waitForAck:()=>new Promise(r=>{resolveAck=r})})
 p.deleteImage({currentTarget:{dataset:{stem:'test'}}})
 assert.equal(writes.length,1)
 const done=writes[0].success()
 assert.equal(removed.length,0)
 resolveAck(result);await done
 assert.equal(removed.length,result.ok?1:0)
 assert.equal(p._deletePending,false)
 if(result.status===2)assert.equal(notices.at(-1).icon,'none')
}
console.log('PASS: deletion waits for device ACK; busy and timeout preserve list entry')
