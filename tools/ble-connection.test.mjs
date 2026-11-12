import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../utils/panel.js'
let definition,connects=[],services=[],chars=[],notifies=[],mtus=[],closed=[],notices=[],timers=[],listeners=[]
const wx={showLoading(){},hideLoading(){},showToast:x=>notices.push(x),
 createBLEConnection:x=>connects.push(x),closeBLEConnection:x=>closed.push(x),
 getBLEDeviceServices:x=>services.push(x),getBLEDeviceCharacteristics:x=>chars.push(x),
 notifyBLECharacteristicValueChange:x=>notifies.push(x),setBLEMTU:x=>mtus.push(x),
 onBLEConnectionStateChange(){},onBLECharacteristicValueChange:x=>listeners.push(x),offBLECharacteristicValueChange(){}}
vm.runInNewContext(fs.readFileSync(new URL('../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},Uint8Array,setTimeout(f,ms){timers.push({f,ms});return timers.length},clearTimeout(){}})
function page(){return Object.assign(Object.create(definition),{data:{connected:false,mtu:23},setData(x){Object.assign(this.data,x)}})}
const event=id=>({currentTarget:{dataset:{device:{deviceId:id,name:'EINK-800-0001'}}}})
const svc={services:[{uuid:'ABF0'}]},characteristics={characteristics:[{uuid:'ABF1',properties:{write:true,writeNoResponse:true}}]}
// Out-of-order connection completions must retain the latest requested device.
let p=page();p.connectDevice(event('A'));const a=connects.at(-1);p.connectDevice(event('B'));connects.at(-1).success();const count=notices.length;a.success();a.fail({errCode:10012});assert.equal(p.data.currentDeviceId,'B');assert.equal(notices.length,count);assert(closed.some(x=>x.deviceId==='A'))
// Old service/characteristic discovery cannot enable notifications on a new device.
const bServices=services.at(-1);bServices.success(svc);const bChars=chars.at(-1)
p.connectDevice(event('C'));connects.at(-1).success();let n=notifies.length;bChars.success(characteristics);assert.equal(notifies.length,n);assert.equal(p.data.writeCharacteristicId,'')
services.at(-1).success(svc);chars.at(-1).success(characteristics);const cNotify=notifies.at(-1),cMtu=mtus.at(-1)
cNotify.success();assert.equal(p.data.notifyEnabled,true);const oldListener=listeners.at(-1)
cMtu.fail({errCode:10008});const retry=timers.findLast(x=>x.ms===500)
// Reset and reconnect to the same device: identity alone is not sufficient.
p.disconnect();const oldClose=closed.at(-1);p.connectDevice(event('C'));connects.at(-1).success();const beforeMtu=mtus.length
cNotify.success();cMtu.success({mtu:512});retry.f();oldClose.success()
assert.equal(p.data.currentDeviceId,'C');assert.equal(p.data.mtu,23);assert.equal(p.data.notifyEnabled,false);assert.equal(mtus.length,beforeMtu)
let parsed=false;p.beginFileList=()=>{parsed=true};oldListener({deviceId:'C',value:new Uint8Array([0x10,0]).buffer});assert.equal(parsed,false)
// Discovery on the new session still proceeds normally.
services.at(-1).success(svc);chars.at(-1).success(characteristics);notifies.at(-1).success();mtus.at(-1).success({mtu:512});assert.equal(p.data.notifyEnabled,true);assert.equal(p.data.mtu,512)
// A page unload invalidates pending connect callbacks and closes the late physical link.
p=page();p.connectDevice(event('D'));const d=connects.at(-1);p._bluetoothDisposed=true;p.resetSessionState();d.success();assert.equal(p.data.connected,false);assert(closed.some(x=>x.deviceId==='D'))
console.log('PASS: out-of-order connects, stale discovery/notify/MTU callbacks, same-device reconnect, old notifications, delayed disconnect and unload cleanup')
