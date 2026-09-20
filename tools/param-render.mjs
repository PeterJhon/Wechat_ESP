/**
 * 参数对比工具 —— 渲染端。
 *
 * 被 tools/param-compare.py 调用：读一张裸 RGBA，按给定的若干组
 * 「算法 × 参数」各跑一遍 convertToEPD()，把结果写成裸 RGBA 交给
 * Python 组装成对比图。
 *
 * 用的就是小程序里的同一套 utils/epd-*.js，所以抖动图案与真机一致。
 * （颜色浓淡不一致：六种墨水的实际色值不等于 sRGB，PNG 只能反映图案。）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertToEPD, colorCodesToImageData,
         colorCodesToBinary } from '../utils/epd-converter.js'

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { width, height, rgbaPath, outDir, variants } = job
const binDir = join(outDir, 'bin')
mkdirSync(binDir, { recursive: true })

const rgba = new Uint8ClampedArray(readFileSync(rgbaPath))
if (rgba.length !== width * height * 4) {
  console.error(`RGBA 长度不符：${rgba.length}，应为 ${width * height * 4}`)
  process.exit(1)
}

const imageData = { data: rgba, width, height }
const manifest = []

for (const v of variants) {
  const t0 = process.hrtime.bigint()
  const codes = convertToEPD(imageData, v.config)
  const out = colorCodesToImageData(codes, width, height)
  const file = join(outDir, `${v.id}.rgba`)
  writeFileSync(file, Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length))

  /* 同时产出设备能直接读的 .bin：每像素 1 字节调色板码、行主序，
   * 大小必须恰好是 width*height，否则设备的尺寸校验会拒收。 */
  const bin = colorCodesToBinary(codes)
  writeFileSync(join(binDir, `${v.id}.bin`), Buffer.from(bin))
  if (bin.length !== width * height) {
    console.error(`  ${v.id}: .bin 大小 ${bin.length}，应为 ${width * height}`)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6

  /* 顺带统计各墨色占比。颜色发灰有时不是参数问题，而是某些墨根本没被
   * 用上 —— 这一行能直接看出来。 */
  const used = new Map()
  for (let y = 0; y < height; y++) {
    const row = codes[y]
    for (let x = 0; x < width; x++) {
      const c = row[x]
      used.set(c, (used.get(c) || 0) + 1)
    }
  }
  const share = [...used.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c.toString(16).padStart(2, '0')}:${(n / (width * height) * 100).toFixed(1)}%`)

  manifest.push({ id: v.id, label: v.label, file, ms: Math.round(ms), share })
  console.log(`  ${v.label.padEnd(40)} ${String(Math.round(ms)).padStart(5)}ms  ${share.join(' ')}`)
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
