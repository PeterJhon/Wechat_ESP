/**
 * 7色墨水屏调色板配置
 * 支持 7 种颜色：黑、白、黄、红、蓝、绿
 */

// 7色调色板 - 颜色代码到 RGB 的映射
export const PALETTE = {
  0x00: [0, 0, 0],        // 黑色
  0xFF: [255, 255, 255],  // 白色
  0xFC: [255, 255, 0],    // 黄色
  0xE0: [255, 0, 0],      // 红色
  0x03: [0, 0, 255],      // 蓝色
  0x1C: [0, 255, 0],      // 绿色
}

// 调色板数组形式，用于快速查找
export const PALETTE_CODES = Object.keys(PALETTE).map(Number)
export const PALETTE_COLORS = Object.values(PALETTE)

// 4x4 Bayer 矩阵 (有序抖动)
export const BAYER_MATRIX_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

// 8x8 Bayer 矩阵 (有序抖动)
export const BAYER_MATRIX_8X8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
]

// 默认图像增强参数
export const DEFAULT_ENHANCE_PARAMS = {
  brightness: 1.05,
  saturation: 1.35,
  gamma: 0.85,
  contrast: 1.1,
  warmth: 1.05
}

/**
 * 查找最接近的颜色
 * @param {number[]} color - [r, g, b]
 * @param {number} blackPenalty - 黑色惩罚值
 * @returns {number} 颜色代码
 */
export function findClosestColor(color, blackPenalty = 0) {
  let minDist = Infinity
  let codeOut = 0x00

  for (let i = 0; i < PALETTE_CODES.length; i++) {
    const code = PALETTE_CODES[i]
    const rgb = PALETTE_COLORS[i]
    const dist = Math.sqrt(
      Math.pow(rgb[0] - color[0], 2) +
      Math.pow(rgb[1] - color[1], 2) +
      Math.pow(rgb[2] - color[2], 2)
    )
    const adjustedDist = code === 0x00 ? dist + blackPenalty : dist
    if (adjustedDist < minDist) {
      minDist = adjustedDist
      codeOut = code
    }
  }
  return codeOut
}

/**
 * 颜色代码转 RGB
 * @param {number} code - 颜色代码
 * @returns {number[]} [r, g, b]
 */
export function codeToRGB(code) {
  return PALETTE[code] || [0, 0, 0]
}

/**
 * 颜色代码转十六进制颜色
 * @param {number} code - 颜色代码
 * @returns {string} #RRGGBB
 */
export function codeToHex(code) {
  const [r, g, b] = codeToRGB(code)
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}
