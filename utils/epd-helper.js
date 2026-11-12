/**
 * 墨水屏转换器辅助函数
 * 提供便捷的调用接口
 */

import { processImageData, convertToEPD, colorCodesToBinary, colorCodesToImageData, analyzeColors, getDitherAlgorithmList, DEFAULT_CONFIG } from './epd-converter.js'
import { panelForTag } from './panel.js'

/**
 * 从 Canvas 获取图��并转换为墨水屏格式
 * @param {Canvas} canvas - 微信小程序 Canvas 对象
 * @param {object} options - 配置选项
 * @returns {Promise<{ imageData: ImageData, colorCodes: number[][], binary: Uint8Array }>}
 */
export async function convertCanvas(canvas, options = {}) {
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height

  // 获取原始图像数据
  const imageData = ctx.getImageData(0, 0, width, height)

  // 转换为墨水屏格式
  const colorCodes = convertToEPD(imageData, options)
  const processedImageData = colorCodesToImageData(colorCodes, width, height)
  const binary = colorCodesToBinary(colorCodes)

  return {
    imageData: processedImageData,
    colorCodes,
    binary
  }
}

/**
 * 将图片文件转换为墨水屏格式
 * @param {string} imagePath - 图片本地路径
 * @param {number} maxWidth - 目标宽度
 * @param {number} maxHeight - 目标高度
 * @param {object} options - 转换配置
 * @returns {Promise<{ imageData: ImageData, colorCodes: number[][], binary: Uint8Array, width: number, height: number }>}
 */
export async function convertImage(imagePath, maxWidth = panelForTag().width,
                                   maxHeight = panelForTag().height, options = {}) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: imagePath,
      success: (imgInfo) => {
        // The device accepts a complete native raster. Center-crop to fit;
        // bounding-box scaling produced undersized .bin files for many photos.
        const width = maxWidth
        const height = maxHeight
        const scale = Math.max(width / imgInfo.width, height / imgInfo.height)
        const drawWidth = imgInfo.width * scale
        const drawHeight = imgInfo.height * scale

        // 创建离屏 Canvas
        const canvas = wx.createOffscreenCanvas({
          type: '2d',
          width,
          height
        })
        const ctx = canvas.getContext('2d')

        // 绘制图片
        const img = canvas.createImage()
        img.onload = () => {
          ctx.drawImage(img, (width - drawWidth) / 2, (height - drawHeight) / 2,
                        drawWidth, drawHeight)

          // 转换
          convertCanvas(canvas, options).then(result => {
            resolve({
              ...result,
              width,
              height
            })
          }).catch(reject)
        }
        img.onerror = reject
        img.src = imagePath
      },
      fail: reject
    })
  })
}

/**
 * 将转换结果绘制到 Canvas
 * @param {Canvas} canvas - 目标 Canvas
 * @param {ImageData} imageData - 图像数据
 */
export function drawToCanvas(canvas, imageData) {
  const ctx = canvas.getContext('2d')
  ctx.putImageData(imageData, 0, 0)
}

/**
 * 导出为临时文件
 * @param {Canvas} canvas - Canvas 对象
 * @param {number} quality - 图片质量 0-1
 * @returns {Promise<string>} 临时文件路径
 */
export function exportToFile(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'png',
      quality,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    })
  })
}

/**
 * 完整的图片处理流程：选择图片 -> 转换 -> 显示
 * @param {object} options - 转换选项
 * @returns {Promise<string>} 处理后的图片临时路径
 */
export async function processAndExport(options = {}) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        try {
          const imagePath = res.tempFiles[0].tempFilePath
          const panel = panelForTag(options.panelTag)
          const result = await convertImage(imagePath, panel.width, panel.height,
            Object.assign({ dither: panel.dither }, options))

          // 创建 Canvas 绘制结果
          const canvas = wx.createOffscreenCanvas({
            type: '2d',
            width: result.width,
            height: result.height
          })

          drawToCanvas(canvas, result.imageData)
          const outputPath = await exportToFile(canvas)

          resolve({
            outputPath,
            ...result
          })
        } catch (e) {
          reject(e)
        }
      },
      fail: reject
    })
  })
}

// 导出所有工具函数
export {
  processImageData,
  convertToEPD,
  colorCodesToBinary,
  colorCodesToImageData,
  analyzeColors,
  getDitherAlgorithmList,
  DEFAULT_CONFIG
}
