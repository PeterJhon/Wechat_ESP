import assert from 'node:assert/strict'
import { ParamUploader, STEM_FIELD, makeStem, parsePanelTag,
         readStemField, writeStemField } from './param-uploader.js'

class EventHub {
  constructor() { this.listeners = new Map() }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(fn)
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn) }
  emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event) }
}

class MockCharacteristic extends EventHub {
  constructor() { super(); this.writes = []; this.currentStem = '' }
  async startNotifications() { return this }
  async writeValueWithResponse(value) { await this.write(value) }
  async writeValueWithoutResponse(value) { await this.write(value) }
  async write(value) {
    const p = Uint8Array.from(value)
    this.writes.push(p)
    const cmd = p[0]
    if (cmd === 0x01) {
      const n = p[1]
      this.currentStem = String.fromCharCode(...p.subarray(2, 2 + n))
      this.ack(0x01, 0, this.currentStem)
    } else if (cmd === 0x16) {
      this.ack(0x16, 0)
    } else if (cmd === 0x03) {
      this.ack(0x03, 0)
    }
  }
  ack(cmd, status, stem = '') {
    queueMicrotask(() => {
      const b = new Uint8Array(stem ? 2 + STEM_FIELD : 2)
      b[0] = 0xFF
      b[1] = ((cmd << 4) | status) & 0xFF
      if (stem) b.set(writeStemField(stem), 2)
      this.emit('characteristicvaluechanged', { target: { value: new DataView(b.buffer) } })
    })
  }
}

class MockDevice extends EventHub {
  constructor(name, characteristic) {
    super()
    this.name = name
    this.gatt = {
      connected: false,
      maxWriteWithoutResponseSize: 509,
      connect: async () => {
        this.gatt.connected = true
        return { getPrimaryService: async () => ({
          getCharacteristic: async () => characteristic
        }) }
      },
      disconnect: () => { this.gatt.connected = false }
    }
  }
}

function concatData(writes, from, to) {
  const packets = writes.slice(from, to).filter(p => p[0] === 0x02)
  const total = packets.reduce((n, p) => n + p.length - 1, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of packets) { out.set(p.subarray(1), o); o += p.length - 1 }
  return { out, packets }
}

assert.equal(parsePanelTag('EINK-1200-B21A'), '1200')
assert.equal(parsePanelTag('garbage'), '')
assert.equal(makeStem(new Date(2026, 8, 25, 14, 23, 5), 7), '20260925-142305-007')
assert.equal(readStemField(writeStemField('20260925-142305-007')), '20260925-142305-007')

const c = new MockCharacteristic()
const d = new MockDevice('EINK-1200-B21A', c)
const states = []
const progress = []
const u = new ParamUploader({
  bluetooth: { requestDevice: async () => d },
  onState: s => states.push(s), onProgress: p => progress.push(p)
})
await u.connect('1200')

const main = Uint8Array.from({ length: 720000 }, (_, i) => i % 251)
const preview = Uint8Array.from({ length: 12345 }, (_, i) => (i * 7) % 256)
const result = await u.upload({ panelTag: '1200', wireBytes: main,
                                previewBytes: preview, mode: 'fast' })
assert.match(result.stem, /^\d{8}-\d{6}-\d{3}$/)
assert.equal(result.partialSuccess, false)
assert.equal(progress.at(-1).percent, 100)

const start = c.writes.findIndex(p => p[0] === 0x01)
const firstEnd = c.writes.findIndex((p, i) => i > start && p[0] === 0x03)
const previewStart = c.writes.findIndex((p, i) => i > firstEnd && p[0] === 0x16)
const secondEnd = c.writes.findIndex((p, i) => i > previewStart && p[0] === 0x03)
assert.ok(start >= 0 && firstEnd > start && previewStart > firstEnd && secondEnd > previewStart)

const mainRx = concatData(c.writes, start + 1, firstEnd)
assert.deepEqual(mainRx.out, main)
assert.ok(mainRx.packets.every(p => p.length <= 509))
const previewRx = concatData(c.writes, previewStart + 1, secondEnd)
assert.deepEqual(previewRx.out, preview)
assert.ok(previewRx.packets.every(p => p.length <= 509))
assert.equal(readStemField(c.writes[previewStart], 1), result.stem)

// 面板不匹配必须在第一条写之前失败
const c2 = new MockCharacteristic()
const d2 = new MockDevice('EINK-800-B21A', c2)
const u2 = new ParamUploader({ bluetooth: { requestDevice: async () => d2 } })
await assert.rejects(() => u2.connect('1200'), /面板不匹配/)
assert.equal(c2.writes.length, 0)

// 兼容模式总包不超过 20B，尾包也能完整拼回
const c3 = new MockCharacteristic()
const d3 = new MockDevice('EINK-800-B21A', c3)
const u3 = new ParamUploader({ bluetooth: { requestDevice: async () => d3 } })
await u3.connect('800')
const small = Uint8Array.from({ length: 144000 }, (_, i) => i % 233)
await u3.upload({ panelTag: '800', wireBytes: small, mode: 'compat' })
const s0 = c3.writes.findIndex(p => p[0] === 0x01)
const se = c3.writes.findIndex((p, i) => i > s0 && p[0] === 0x03)
const smallRx = concatData(c3.writes, s0 + 1, se)
assert.deepEqual(smallRx.out, small)
assert.ok(smallRx.packets.every(p => p.length <= 20))

console.log('param-uploader mock tests: PASS')
