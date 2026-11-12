import assert from 'node:assert/strict'
import { panelForTag, parsePanel, panelBytes, panelWireBytes, cropOptionsFor } from '../../utils/panel.js'
import { packToWire } from '../../utils/epd-wire.js'

for (const [tag, width, height, bytes, packed, algorithm] of [
  ['800', 800, 480, 384000, 144000, 'hybrid'],
  ['1200', 1200, 1600, 1920000, 720000, 'atkinson']
]) {
  const panel = parsePanel(`EINK-${tag}-B21A`)
  assert.deepEqual([panel.width, panel.height, panel.dither], [width, height, algorithm])
  assert.equal(panelBytes(panel), bytes)
  assert.equal(panelWireBytes(panel), packed)
  assert.equal(packToWire(new Uint8Array(bytes)).length, packed)
  const crops = cropOptionsFor(panel)
  assert.deepEqual(crops.map(p => [p.w, p.h]), [[width, height], [height, width]])
}
assert.equal(parsePanel('EINK-B21A').tag, '800')
assert.equal(parsePanel('eink-1200-b21a').tag, '1200')
assert.throws(() => parsePanel('EINK-999-B21A'), /不支持/)
assert.throws(() => parsePanel('EINK-unknown-B21A'), /不支持/)
assert.throws(() => panelForTag('999'), /不支持/)
console.log('Dual-panel profiles and full-frame wire sizes: PASS')
