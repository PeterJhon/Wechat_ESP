/**
 * 墨水屏抖动算法 - 简易使用示例
 *
 * 基本用法：
 * ```javascript
 * import { quickConvert } from '../../utils/epd-simple.js'
 *
 * // 快速转换
 * const result = await quickConvert(imagePath, 'floyd')
 * console.log(result.outputPath) // 处理后的图片路径
 * console.log(result.binary) // 二进制数据，可发送给蓝牙设备
 * ```
 */

import { convertImage, exportToFile } from './epd-helper.js'
import { DEFAULT_CONFIG, getDitherAlgorithmList } from './epd-converter.js'

/**
 * 快速转换图片
 * @param {string} imagePath - 图片路径
 * @param {string} algorithm - 抖动算法 (floyd, atkinson, jjn, etc.)
 * @param {object} options - 其他选项
 * @returns {Promise<object>}
 */
export async function quickConvert(imagePath, algorithm = 'hybrid', options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    dither: algorithm,
    ...options
  }

  const result = await convertImage(imagePath, 800, 480, config)

  // 导出为临时文件
  const canvas = wx.createOffscreenCanvas({
    type: '2d',
    width: result.width,
    height: result.height
  })
  const ctx = canvas.getContext('2d')
  ctx.putImageData(result.imageData, 0, 0)

  const outputPath = await exportToFile(canvas)

  return {
    ...result,
    outputPath
  }
}

/**
 * 选择图片并转换
 * @param {string} algorithm - 抖动算法
 * @returns {Promise<object>}
 */
export async function chooseAndConvert(algorithm = 'hybrid') {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        try {
          const result = await quickConvert(res.tempFiles[0].tempFilePath, algorithm)
          resolve(result)
        } catch (e) {
          reject(e)
        }
      },
      fail: reject
    })
  })
}

/**
 * 获取所有支持的算法
 */
export function getAlgorithms() {
  return getDitherAlgorithmList()
}

/**
 * 预设配置
 */
export const PRESETS = {
  // 高质量 - 使用 JJN 算法
  highQuality: {
    algorithm: 'jjn',
    brightness: 1.05,
    saturation: 1.35,
    gamma: 0.85,
    contrast: 1.1
  },
  // 快速 - 使用 Sierra Lite
  fast: {
    algorithm: 'sierra',
    brightness: 1.0,
    saturation: 1.2,
    gamma: 1.0,
    contrast: 1.0
  },
  // 艺术效果 - Atkinson
  artistic: {
    algorithm: 'atkinson',
    brightness: 1.1,
    saturation: 1.5,
    gamma: 0.8,
    contrast: 1.2
  },
  // 有序抖动 - 规整图案
  ordered: {
    algorithm: 'ordered4',
    brightness: 1.05,
    saturation: 1.3,
    gamma: 0.9,
    contrast: 1.05
  },
  // 默认
  default: DEFAULT_CONFIG
}
