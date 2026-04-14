/**
 * 墨水屏图像增强模块
 * 包含 gamma 校正、亮度、对比度、饱和度调整等功能
 */

/**
 * 应用 Gamma 校正
 * @param {number[][]} imageData - 图像数据 [h][w][3]
 * @param {number} gamma - Gamma 值 (0.85 为默认)
 * @returns {number[][]} 处理后的图像数据
 */
export function applyGamma(imageData, gamma = 0.85) {
  const h = imageData.length
  const w = imageData[0].length
  const result = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const [r, g, b] = imageData[y][x]
      row.push([
        Math.min(255, Math.pow(r / 255, gamma) * 255),
        Math.min(255, Math.pow(g / 255, gamma) * 255),
        Math.min(255, Math.pow(b / 255, gamma) * 255)
      ])
    }
    result.push(row)
  }
  return result
}

/**
 * 调整亮度
 * @param {number[][]} imageData - 图像数据
 * @param {number} factor - 亮度系数 (1.05 为默认)
 * @returns {number[][]}
 */
export function enhanceBrightness(imageData, factor = 1.05) {
  const h = imageData.length
  const w = imageData[0].length
  const result = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const [r, g, b] = imageData[y][x]
      row.push([
        Math.min(255, Math.max(0, r * factor)),
        Math.min(255, Math.max(0, g * factor)),
        Math.min(255, Math.max(0, b * factor))
      ])
    }
    result.push(row)
  }
  return result
}

/**
 * 调整对比度
 * @param {number[][]} imageData - 图像数据
 * @param {number} factor - 对比度系数 (1.1 为默认)
 * @returns {number[][]}
 */
export function enhanceContrast(imageData, factor = 1.1) {
  const h = imageData.length
  const w = imageData[0].length
  const result = []

  // 计算全局平均值
  let sum = 0
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sum += imageData[y][x][0] + imageData[y][x][1] + imageData[y][x][2]
      count += 3
    }
  }
  const mean = sum / count

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const [r, g, b] = imageData[y][x]
      row.push([
        Math.min(255, Math.max(0, mean + (r - mean) * factor)),
        Math.min(255, Math.max(0, mean + (g - mean) * factor)),
        Math.min(255, Math.max(0, mean + (b - mean) * factor))
      ])
    }
    result.push(row)
  }
  return result
}

/**
 * 调整饱和度
 * @param {number[][]} imageData - 图像数据
 * @param {number} factor - 饱和度系数 (1.35 为默认)
 * @returns {number[][]}
 */
export function enhanceSaturation(imageData, factor = 1.35) {
  const h = imageData.length
  const w = imageData[0].length
  const result = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const [r, g, b] = imageData[y][x]
      const mean = (r + g + b) / 3
      row.push([
        Math.min(255, Math.max(0, mean + (r - mean) * factor)),
        Math.min(255, Math.max(0, mean + (g - mean) * factor)),
        Math.min(255, Math.max(0, mean + (b - mean) * factor))
      ])
    }
    result.push(row)
  }
  return result
}

/**
 * 暖色调平衡
 * @param {number[][]} imageData - 图像数据
 * @param {number} warmth - 暖色系数 (1.05 为默认)
 * @returns {number[][]}
 */
export function warmColorBalance(imageData, warmth = 1.05) {
  const h = imageData.length
  const w = imageData[0].length
  const result = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const [r, g, b] = imageData[y][x]
      row.push([
        Math.min(255, Math.max(0, r * warmth)),
        g,
        Math.min(255, Math.max(0, b / warmth))
      ])
    }
    result.push(row)
  }
  return result
}

/**
 * 综合图像增强
 * @param {number[][]} imageData - 图像数据
 * @param {object} params - 增强参数
 * @returns {number[][]}
 */
export function enhanceImage(imageData, params = {}) {
  const {
    brightness = 1.05,
    saturation = 1.35,
    gamma = 0.85,
    contrast = 1.1,
    warmth = 1.05
  } = params

  let result = imageData

  // 按顺序应用增强
  result = applyGamma(result, gamma)
  result = enhanceBrightness(result, brightness)
  result = enhanceContrast(result, contrast)
  result = enhanceSaturation(result, saturation)
  result = warmColorBalance(result, warmth)

  return result
}

/**
 * 将 ImageData 转换为内部格式
 * @param {ImageData} imageData - Canvas ImageData
 * @returns {number[][]} [y][x][r,g,b]
 */
export function imageToInternal(imageData) {
  const data = imageData.data
  const width = imageData.width
  const height = imageData.height
  const result = []

  for (let y = 0; y < height; y++) {
    const row = []
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      row.push([data[idx], data[idx + 1], data[idx + 2]])
    }
    result.push(row)
  }
  return result
}

/**
 * 将内部格式转换回 ImageData
 * @param {number[][]} internalData - [y][x][r,g,b]
 * @param {number} width - 图像宽度
 * @param {number} height - 图像高度
 * @returns {ImageData}
 */
export function internalToImageData(internalData, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const [r, g, b] = internalData[y][x]
      data[idx] = r
      data[idx + 1] = g
      data[idx + 2] = b
      data[idx + 3] = 255 // Alpha
    }
  }

  return { data, width, height }
}
