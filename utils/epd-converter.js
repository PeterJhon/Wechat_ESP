/**
 * 墨水屏图像转换器 - 主模块
 * 整合图像增强和抖动算法
 */

import { enhanceImage, imageToInternal, internalToImageData } from './epd-enhance.js'
import { DITHER_ALGORITHMS, getDitherAlgorithmList } from './epd-dither.js'
import { codeToRGB, codeToHex, PALETTE, PALETTE_CODES } from './epd-palette.js'

/**
 * 转换配置
 */
export const DEFAULT_CONFIG = {
  // 增强参数
  brightness: 1.05,
  saturation: 1.35,
  gamma: 0.85,
  contrast: 1.1,
  warmth: 1.05,
  // 抖动参数
  dither: 'hybrid',
  blackPenalty: 0
}

/**
 * ImageData 转换为墨水屏颜色代码
 * @param {ImageData} imageData - Canvas ImageData
 * @param {object} config - 转换配置
 * @returns {number[][]} 颜色代码矩阵 [y][x]
 */
export function convertToEPD(imageData, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // 转换为内部格式
  let internalData = imageToInternal(imageData)

  // 应用图像增强
  const enhanceParams = {
    brightness: cfg.brightness,
    saturation: cfg.saturation,
    gamma: cfg.gamma,
    contrast: cfg.contrast,
    warmth: cfg.warmth
  }
  internalData = enhanceImage(internalData, enhanceParams)

  // 应用抖动算法
  const ditherFunc = DITHER_ALGORITHMS[cfg.dither] || DITHER_ALGORITHMS.hybrid
  const dithered = ditherFunc(internalData, cfg.blackPenalty)

  return dithered
}

/**
 * 将墨水屏颜色代码转换为 Canvas 可绘制的数据
 * @param {number[][]} colorCodes - 颜色代码矩阵
 * @param {number} width - 图像宽度
 * @param {number} height - 图像高度
 * @returns {ImageData} Canvas ImageData
 */
export function colorCodesToImageData(colorCodes, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const code = colorCodes[y]?.[x] ?? 0x00
      const [r, g, b] = codeToRGB(code)
      data[idx] = r
      data[idx + 1] = g
      data[idx + 2] = b
      data[idx + 3] = 255
    }
  }

  return { data, width, height }
}

/**
 * 完整的转换流程：ImageData -> Canvas ImageData
 * @param {ImageData} imageData - 输入图像数据
 * @param {object} config - 转换配置
 * @returns {ImageData} 处理后的 ImageData
 */
export function processImageData(imageData, config = {}) {
  const colorCodes = convertToEPD(imageData, config)
  return colorCodesToImageData(colorCodes, imageData.width, imageData.height)
}

/**
 * 将颜色代码转换为二进制数据
 * @param {number[][]} colorCodes - 颜色代码矩阵
 * @returns {Uint8Array} 二进制数据
 */
export function colorCodesToBinary(colorCodes) {
  const h = colorCodes.length
  const w = colorCodes[0]?.length ?? 0
  const buffer = new Uint8Array(h * w)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buffer[y * w + x] = colorCodes[y][x]
    }
  }

  return buffer
}

/**
 * 统计颜色使用情况
 * @param {number[][]} colorCodes - 颜色代码矩阵
 * @returns {object} 颜色统计
 */
export function analyzeColors(colorCodes) {
  const stats = {}
  const colorNames = {
    0x00: '黑色',
    0xFF: '白色',
    0xFC: '黄色',
    0xE0: '红色',
    0x03: '蓝色',
    0x1C: '绿色'
  }

  for (let y = 0; y < colorCodes.length; y++) {
    for (let x = 0; x < (colorCodes[y]?.length ?? 0); x++) {
      const code = colorCodes[y][x]
      stats[code] = (stats[code] || 0) + 1
    }
  }

  return Object.entries(stats).map(([code, count]) => ({
    code: parseInt(code),
    name: colorNames[code] || `未知(${code})`,
    count,
    percent: (count / (colorCodes.length * (colorCodes[0]?.length ?? 1)) * 100).toFixed(2)
  }))
}

/**
 * 导出工具函数
 */
export {
  getDitherAlgorithmList,
  codeToRGB,
  codeToHex,
  PALETTE,
  PALETTE_CODES
}
