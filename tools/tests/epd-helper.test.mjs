import assert from 'node:assert/strict'
import { convertImage } from '../../utils/epd-helper.js'
import { panelForTag } from '../../utils/panel.js'

let drawn
globalThis.wx = {
  getImageInfo({ success }) { success({ width: 160, height: 90 }) },
  createOffscreenCanvas({ width, height }) {
    return {
      getContext() {
        return {
          drawImage(...args) { drawn = args.slice(1) },
          getImageData() {
            return { width, height, data: new Uint8ClampedArray(width * height * 4) }
          }
        }
      },
      createImage() {
        return { set src(value) { queueMicrotask(() => this.onload()) } }
      }
    }
  }
}
for (const tag of ['800', '1200']) {
  const panel = panelForTag(tag)
  const result = await convertImage('photo.jpg', panel.width, panel.height, { dither: 'none' })
  assert.equal(result.width, panel.width)
  assert.equal(result.height, panel.height)
  assert.equal(result.binary.length, panel.width * panel.height)
  const [x, y, width, height] = drawn
  assert.ok(x <= 0 && y <= 0)
  assert.ok(width >= panel.width && height >= panel.height)
  assert.equal(width / height, 160 / 90)
}
delete globalThis.wx
console.log('Helper center-crop and native binary sizes for both panels: PASS')
