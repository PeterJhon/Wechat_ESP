import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as panels from '../utils/panel.js'
let definition, opening, calls=[]
const wx={
 openBluetoothAdapter(x){calls.push('open');opening=x},
 getBluetoothAdapterState(x){calls.push('state');x.success({available:true})},
 onBluetoothAdapterStateChange(){calls.push('listen')},
 closeBluetoothAdapter(x){calls.push('close');x.success()},
 showToast(){},showModal(){}
}
vm.runInNewContext(fs.readFileSync(new URL('../pages/index/index.js',import.meta.url),'utf8').replace(/^import .*$/mg,''),{...panels,wx,Page(x){definition=x},console:{log(){},warn(){},error(){}},setTimeout,clearTimeout})
const page=()=>Object.assign(Object.create(definition),{data:{},setData(x){Object.assign(this.data,x)}})
let p=page();p.onLoad();p.checkBluetooth();p.initBluetooth()
assert.deepEqual(calls,['open'])
opening.success({})
assert.deepEqual(calls,['open','listen','state'])
assert.equal(p.data.bluetoothReady,true)
p.onShow();assert.equal(calls.at(-1),'state')
calls=[];p=page();p.onLoad();opening.fail({errCode:10001})
assert.deepEqual(calls,['open'])
assert.equal(p.data.bluetoothReady,false)
assert.equal(p._bluetoothOpening,false)
p.initBluetooth();assert.equal(calls.length,2)
calls=[];p=page();p.onLoad();const stale=opening;p.closeBluetooth();stale.success({})
assert.deepEqual(calls,['open','close'])
assert.equal(p._adapterInitialized,false)
console.log('PASS: open before query, duplicate init suppressed, failed init stays unavailable, stale open ignored')
