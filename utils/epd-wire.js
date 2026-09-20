/**
 * 线上格式 —— 传图时的位打包。
 *
 * 六色只需要 3 bit，而线上一直是 1 字节/像素，等于每像素白扔 5 bit。
 * 这里把 8 个像素压进 3 个字节：1200×1600 一帧从 1,920,000 降到 720,000。
 *
 * **只压传输，不压存储。** 设备收到后立刻解包再落盘，SD 上仍是 1 字节/像素，
 * 所以 img_mgr、slideshow、显示路径、以及卡里已有的图片全都不受影响。
 *
 * 固件侧 `main/ble_task.c` 的 unpack_3bit() 是同一套位序 ——
 * 改这里必须同步改那边，否则画面会整体错位。
 */

/** 3 bit 索引 → JS 调色板色码。顺序即线上编码，不能重排。 */
export const WIRE_INDEX_TO_CODE = [0x00, 0xFF, 0xFC, 0xE0, 0x03, 0x1C]

/** 色码 → 索引。只有 6 个合法值，用 256 项查表比 Map 快得多。 */
const CODE_TO_INDEX = new Uint8Array(256)
for (let i = 0; i < WIRE_INDEX_TO_CODE.length; i++) {
  CODE_TO_INDEX[WIRE_INDEX_TO_CODE[i]] = i
}

/**
 * 打包后的字节数。
 * 行宽须为 8 的倍数才能整行对齐（800 与 1200 都满足）。
 */
export function wireBytes(pixelCount) {
  return Math.ceil(pixelCount * 3 / 8)
}

/**
 * 把 1 字节/像素的调色板码压成 3 bit/像素。
 *
 * 第 i 个像素占第 3i..3i+2 位（小端），跨字节自然拼接：
 *   byte0 = p0 | (p1<<3) | ((p2&3)<<6)
 *   byte1 = (p2>>2) | (p3<<1) | (p4<<4) | ((p5&1)<<7)
 *   byte2 = (p5>>1) | (p6<<2) | (p7<<5)
 *
 * 行宽整除 8 时，每行正好落在字节边界上，不需要行末补位。
 *
 * @param {Uint8Array} codes 1 字节/像素的调色板码（文件布局，行主序）
 * @returns {Uint8Array}
 */
export function packToWire(codes) {
  const n = codes.length
  const full = n - (n % 8)
  const out = new Uint8Array(wireBytes(n))

  let o = 0
  for (let i = 0; i < full; i += 8) {
    const p0 = CODE_TO_INDEX[codes[i]]
    const p1 = CODE_TO_INDEX[codes[i + 1]]
    const p2 = CODE_TO_INDEX[codes[i + 2]]
    const p3 = CODE_TO_INDEX[codes[i + 3]]
    const p4 = CODE_TO_INDEX[codes[i + 4]]
    const p5 = CODE_TO_INDEX[codes[i + 5]]
    const p6 = CODE_TO_INDEX[codes[i + 6]]
    const p7 = CODE_TO_INDEX[codes[i + 7]]

    out[o++] = p0 | (p1 << 3) | ((p2 & 0x03) << 6)
    out[o++] = (p2 >> 2) | (p3 << 1) | (p4 << 4) | ((p5 & 0x01) << 7)
    out[o++] = (p5 >> 1) | (p6 << 2) | (p7 << 5)
  }

  /* 尾部不足 8 像素时按同一位置规则逐位写。当前两款面板的像素数都能被 8
   * 整除、走不到这里，但这样函数对任意长度都成立，不会静默丢掉尾巴。 */
  for (let i = full; i < n; i++) {
    const v = CODE_TO_INDEX[codes[i]]
    for (let b = 0; b < 3; b++) {
      if ((v >> b) & 1) {
        const bit = i * 3 + b
        out[bit >> 3] |= 1 << (bit & 7)
      }
    }
  }

  return out
}
