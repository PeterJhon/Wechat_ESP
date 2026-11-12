import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../utils/panel.js'
let definition, writes=[], notices=[]
const wx={showModal(x){x.success({confirm:true})},showToast(x){notices.push(x)},writeBLECharacteristicValue(x){writes.push(x)}}
vm.runInNewContext(fs.readFileSync(new URL('../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console,setTimeout,clearTimeout,Uint8Array})
for(const result of [{responded:true,ok:true},{responded:true,ok:false,status:2},{responded:false,ok:false}]){
 let removed=[],resolveAck;writes=[];notices=[]
 const p=Object.assign(Object.create(definition),{data:{connected:true},stemToLabel:x=>x,writeStemField:()=>new Uint8Array(20),removeFileLocally:x=>removed.push(x),waitForAck(){return new Promise(r=>{resolveAck=r;this._ackWaiters={1:{resolve:r,timer:null}}})}})
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

function actualPage(){return Object.assign(Object.create(definition),{
  data:{connected:true,currentDeviceId:'A'},setData(x){Object.assign(this.data,x)},
  stemToLabel:x=>x,writeStemField:()=>new Uint8Array(20),removeFileLocally(){throw Error('Stale delete removed a new-session file')}
})}
let confirmation
wx.showModal=x=>{confirmation=x.success}
let p=actualPage();writes=[]
p.deleteImage({currentTarget:{dataset:{stem:'old'}}})
p.resetSessionState();p.data.currentDeviceId='B';confirmation({confirm:true})
assert.equal(writes.length,0)
wx.showModal=x=>x.success({confirm:true})
p=actualPage();writes=[];p.deleteImage({currentTarget:{dataset:{stem:'old'}}})
const oldWrite=writes[0];const oldResult=oldWrite.success()
p.resetSessionState();p.data.currentDeviceId='B'
p.deleteImage({currentTarget:{dataset:{stem:'new'}}})
const newWaiter=p._ackWaiters[1]
oldWrite.fail({});await oldResult
assert.equal(p._deletePending,true);assert.equal(p._ackWaiters[1],newWaiter)
p.resetSessionState()
console.log('PASS: stale delete confirmation, write failure and ACK completion cannot affect a new connection')
