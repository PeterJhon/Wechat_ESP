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
 *
 * 注意：**已不在主路径上**。convertToEPD() 现在走 enhanceToInternal()，
 * 它把转换与增强合成两趟、并给 gamma 建查表。这里保留是作为分步实现的
 * 参考和单步调试用途 —— 性能问题不要往这里找，要改就改 enhanceToInternal。
 *
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
 * RGBA 直读 → 增强后的内部格式 [y][x][r,g,b]，两趟搞定。
 *
 * 原来的路径是 imageToInternal 先建 192 万个 [r,g,b]，再被 5 个增强函数
 * 各复制一遍（enhanceContrast 还要额外走一趟算全局均值）—— 合计 6 趟遍历
 * 和 6 份中间数组。1200×1600 实测 890ms，其中一多半花在这上面。
 *
 * 这里合成两趟：第一趟 gamma + 亮度并顺手累计均值，第二趟对比度 + 饱和度
 * + 暖色。gamma 的输入只有 0..255 共 256 种取值，用查表替掉每像素 3 次
 * Math.pow（整图 576 万次）。
 *
 * 中间值与原实现一样保持浮点、不取整，运算顺序也不变，所以结果**逐通道
 * 比特级一致**（已用 192 万像素比对，最大差 0）。
 *
 * @param {Uint8ClampedArray} rgba - 每像素 4 字节
 * @param {number} width
 * @param {number} height
 * @param {object} params - 增强参数
 * @returns {number[][]} [y][x][r,g,b]
 */
export function enhanceToInternal(rgba, width, height, params = {}) {
  const {
    brightness = 1.05,
    saturation = 1.35,
    gamma = 0.85,
    contrast = 1.1,
    warmth = 1.05
  } = params

  /* gamma 查表。输入是字节，只有 256 种取值，没必要对每个像素每个通道
   * 都算一次幂。 */
  const lut = new Float64Array(256)
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.min(255, Math.pow(v / 255, gamma) * 255)
  }

  const rows = new Array(height)
  let sum = 0

  // 第一趟：gamma + 亮度，并累计均值供对比度使用
  for (let y = 0; y < height; y++) {
    const row = new Array(width)
    const base = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = base + x * 4
      const r = Math.min(255, lut[rgba[i]] * brightness)
      const g = Math.min(255, lut[rgba[i + 1]] * brightness)
      const b = Math.min(255, lut[rgba[i + 2]] * brightness)
      sum += r + g + b
      row[x] = [r, g, b]
    }
    rows[y] = row
  }

  const mean = sum / (width * height * 3)

  // 第二趟：对比度 + 饱和度 + 暖色，原地改写
  for (let y = 0; y < height; y++) {
    const row = rows[y]
    for (let x = 0; x < width; x++) {
      const px = row[x]

      let r = Math.min(255, Math.max(0, mean + (px[0] - mean) * contrast))
      let g = Math.min(255, Math.max(0, mean + (px[1] - mean) * contrast))
      let b = Math.min(255, Math.max(0, mean + (px[2] - mean) * contrast))

      // 饱和度：以三通道均值为轴心缩放
      const gray = (r + g + b) / 3
      r = Math.min(255, Math.max(0, gray + (r - gray) * saturation))
      g = Math.min(255, Math.max(0, gray + (g - gray) * saturation))
      b = Math.min(255, Math.max(0, gray + (b - gray) * saturation))

      // 暖色：红增蓝减，绿不动
      px[0] = Math.min(255, Math.max(0, r * warmth))
      px[1] = g
      px[2] = Math.min(255, Math.max(0, b / warmth))
    }
  }

  return rows
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
