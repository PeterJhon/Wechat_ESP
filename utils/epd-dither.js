/**
 * 墨水屏抖动算法模块
 * 支持 11 种抖动算法
 */

import { findClosestColor, codeToRGB, PALETTE, PALETTE_COLORS, PALETTE_CODES, BAYER_MATRIX_4X4, BAYER_MATRIX_8X8 } from './epd-palette.js'

/**
 * Floyd-Steinberg 抖动算法
 * 最经典的误差扩散抖动
 */
export function floydSteinbergDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      // 扩散误差到相邻像素
      if (x + 1 < w) {
        img[y][x + 1][0] += error[0] * 7 / 16
        img[y][x + 1][1] += error[1] * 7 / 16
        img[y][x + 1][2] += error[2] * 7 / 16
      }
      if (x - 1 >= 0 && y + 1 < h) {
        img[y + 1][x - 1][0] += error[0] * 3 / 16
        img[y + 1][x - 1][1] += error[1] * 3 / 16
        img[y + 1][x - 1][2] += error[2] * 3 / 16
      }
      if (y + 1 < h) {
        img[y + 1][x][0] += error[0] * 5 / 16
        img[y + 1][x][1] += error[1] * 5 / 16
        img[y + 1][x][2] += error[2] * 5 / 16
      }
      if (x + 1 < w && y + 1 < h) {
        img[y + 1][x + 1][0] += error[0] * 1 / 16
        img[y + 1][x + 1][1] += error[1] * 1 / 16
        img[y + 1][x + 1][2] += error[2] * 1 / 16
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Atkinson 抖动算法
 * Apple 曾经使用的抖动算法，保留更多误差产生更好的细节
 */
export function atkinsonDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  const kernel = [
    [1, 0, 1/8], [2, 0, 1/8],
    [-1, 1, 1/8], [0, 1, 1/8], [1, 1, 1/8],
    [0, 2, 1/8]
  ]

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      for (const [dx, dy, coeff] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          img[ny][nx][0] += error[0] * coeff
          img[ny][nx][1] += error[1] * coeff
          img[ny][nx][2] += error[2] * coeff
        }
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Jarvis-Judice-Ninke 抖动算法
 * 更复杂的误差扩散，产生更细腻的效果
 */
export function jarvisJudiceNinkeDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  const kernel = [
    [1, 0, 7/48], [2, 0, 5/48],
    [-2, 1, 3/48], [-1, 1, 5/48], [0, 1, 7/48], [1, 1, 5/48], [2, 1, 3/48],
    [-2, 2, 1/48], [-1, 2, 3/48], [0, 2, 5/48], [1, 2, 3/48], [2, 2, 1/48]
  ]

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      for (const [dx, dy, coeff] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          img[ny][nx][0] += error[0] * coeff
          img[ny][nx][1] += error[1] * coeff
          img[ny][nx][2] += error[2] * coeff
        }
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Stucki 抖动算法
 * 类似 JJN 但计算量较小
 */
export function stuckiDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  const kernel = [
    [1, 0, 8/42], [2, 0, 4/42],
    [-2, 1, 2/42], [-1, 1, 4/42], [0, 1, 8/42], [1, 1, 4/42], [2, 1, 2/42],
    [-2, 2, 1/42], [-1, 2, 2/42], [0, 2, 4/42], [1, 2, 2/42], [2, 2, 1/42]
  ]

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      for (const [dx, dy, coeff] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          img[ny][nx][0] += error[0] * coeff
          img[ny][nx][1] += error[1] * coeff
          img[ny][nx][2] += error[2] * coeff
        }
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Burkes 抖动算法
 * 简化版误差扩散
 */
export function burkesDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  const kernel = [
    [1, 0, 8/32], [2, 0, 4/32],
    [-2, 1, 2/32], [-1, 1, 4/32], [0, 1, 8/32], [1, 1, 4/32], [2, 1, 2/32]
  ]

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      for (const [dx, dy, coeff] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          img[ny][nx][0] += error[0] * coeff
          img[ny][nx][1] += error[1] * coeff
          img[ny][nx][2] += error[2] * coeff
        }
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Sierra Lite 抖动算法
 * 轻量级 Sierra 算法
 */
export function sierraLiteDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      if (x + 1 < w) {
        img[y][x + 1][0] += error[0] * 2 / 4
        img[y][x + 1][1] += error[1] * 2 / 4
        img[y][x + 1][2] += error[2] * 2 / 4
      }
      if (x - 1 >= 0 && y + 1 < h) {
        img[y + 1][x - 1][0] += error[0] * 1 / 4
        img[y + 1][x - 1][1] += error[1] * 1 / 4
        img[y + 1][x - 1][2] += error[2] * 1 / 4
      }
      if (y + 1 < h) {
        img[y + 1][x][0] += error[0] * 1 / 4
        img[y + 1][x][1] += error[1] * 1 / 4
        img[y + 1][x][2] += error[2] * 1 / 4
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Two-Row Sierra 抖动算法
 * 两行 Sierra 算法
 */
export function twoRowSierraDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  const kernel = [
    [1, 0, 4/16], [2, 0, 3/16],
    [-2, 1, 1/16], [-1, 1, 2/16], [0, 1, 3/16], [1, 1, 2/16], [2, 1, 1/16]
  ]

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const oldPixel = img[y][x]
      const code = findClosestColor(oldPixel, blackPenalty)
      row.push(code)
      const newPixel = codeToRGB(code)

      const error = [
        oldPixel[0] - newPixel[0],
        oldPixel[1] - newPixel[1],
        oldPixel[2] - newPixel[2]
      ]

      for (const [dx, dy, coeff] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          img[ny][nx][0] += error[0] * coeff
          img[ny][nx][1] += error[1] * coeff
          img[ny][nx][2] += error[2] * coeff
        }
      }
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Ordered (Bayer) 抖动算法
 * 有序抖动，使用 Bayer 矩阵
 */
export function orderedDither(imageData, bayerMatrix = BAYER_MATRIX_4X4) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const matrixH = bayerMatrix.length
  const matrixW = bayerMatrix[0].length

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const threshold = bayerMatrix[y % matrixH][x % matrixW] / (matrixH * matrixW)
      const pixel = imageData[y][x]

      // 调整像素值
      const adjusted = [
        pixel[0] + (threshold - 0.5) * 64,
        pixel[1] + (threshold - 0.5) * 64,
        pixel[2] + (threshold - 0.5) * 64
      ]

      // 找最接近的颜色
      let minDist = Infinity
      let minCode = 0x00
      for (let i = 0; i < PALETTE_CODES.length; i++) {
        const rgb = PALETTE_COLORS[i]
        const dist = Math.pow(rgb[0] - adjusted[0], 2) +
                     Math.pow(rgb[1] - adjusted[1], 2) +
                     Math.pow(rgb[2] - adjusted[2], 2)
        if (dist < minDist) {
          minDist = dist
          minCode = PALETTE_CODES[i]
        }
      }
      row.push(minCode)
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Noise 抖动算法
 * 随机噪声抖动
 */
export function noiseDither(imageData, blackPenalty = 0, noiseLevel = 0.5) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const pixel = imageData[y][x]
      const noise = (Math.random() - 0.5) * 2 * noiseLevel * 64

      const adjusted = [
        pixel[0] + noise,
        pixel[1] + noise,
        pixel[2] + noise
      ]

      let minDist = Infinity
      let minCode = 0x00
      for (let i = 0; i < PALETTE_CODES.length; i++) {
        const rgb = PALETTE_COLORS[i]
        const dist = Math.pow(rgb[0] - adjusted[0], 2) +
                     Math.pow(rgb[1] - adjusted[1], 2) +
                     Math.pow(rgb[2] - adjusted[2], 2)
        const adjustedDist = PALETTE_CODES[i] === 0x00 ? dist + blackPenalty : dist
        if (adjustedDist < minDist) {
          minDist = adjustedDist
          minCode = PALETTE_CODES[i]
        }
      }
      row.push(minCode)
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * Hybrid Block 抖动算法
 * 混合块抖动，根据亮度区域使用不同策略
 */
export function hybridBlockDither(imageData, blackPenalty = 0, brightThreshold = 120, blockSize = 2) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []
  const img = imageData.map(row => row.map(pixel => [...pixel]))

  for (let y = 0; y < h; y += blockSize) {
    for (let x = 0; x < w; x += blockSize) {
      const blockH = Math.min(blockSize, h - y)
      const blockW = Math.min(blockSize, w - x)

      // 计算块平均颜色
      let sumR = 0, sumG = 0, sumB = 0
      let count = 0
      for (let by = 0; by < blockH; by++) {
        for (let bx = 0; bx < blockW; bx++) {
          sumR += img[y + by][x + bx][0]
          sumG += img[y + by][x + bx][1]
          sumB += img[y + by][x + bx][2]
          count++
        }
      }
      const avgColor = [sumR / count, sumG / count, sumB / count]
      const lum = (avgColor[0] + avgColor[1] + avgColor[2]) / 3

      if (lum >= brightThreshold) {
        // 亮区域使用 Floyd-Steinberg
        for (let by = 0; by < blockH; by++) {
          for (let bx = 0; bx < blockW; bx++) {
            const oldPixel = img[y + by][x + bx]
            const code = findClosestColor(oldPixel, blackPenalty)

            if (!dithered[y + by]) dithered[y + by] = []
            dithered[y + by][x + bx] = code

            const newPixel = codeToRGB(code)
            const error = [
              oldPixel[0] - newPixel[0],
              oldPixel[1] - newPixel[1],
              oldPixel[2] - newPixel[2]
            ]

            // 误差扩散
            if (x + bx + 1 < w) {
              img[y + by][x + bx + 1][0] += error[0] * 7 / 16
              img[y + by][x + bx + 1][1] += error[1] * 7 / 16
              img[y + by][x + bx + 1][2] += error[2] * 7 / 16
            }
            if (x + bx - 1 >= 0 && y + by + 1 < h) {
              img[y + by + 1][x + bx - 1][0] += error[0] * 3 / 16
              img[y + by + 1][x + bx - 1][1] += error[1] * 3 / 16
              img[y + by + 1][x + bx - 1][2] += error[2] * 3 / 16
            }
            if (y + by + 1 < h) {
              img[y + by + 1][x + bx][0] += error[0] * 5 / 16
              img[y + by + 1][x + bx][1] += error[1] * 5 / 16
              img[y + by + 1][x + bx][2] += error[2] * 5 / 16
            }
            if (x + bx + 1 < w && y + by + 1 < h) {
              img[y + by + 1][x + bx + 1][0] += error[0] * 1 / 16
              img[y + by + 1][x + bx + 1][1] += error[1] * 1 / 16
              img[y + by + 1][x + bx + 1][2] += error[2] * 1 / 16
            }
          }
        }
      } else {
        // 暗区域使用颜色混合
        const distances = PALETTE_COLORS.map(rgb =>
          Math.pow(rgb[0] - avgColor[0], 2) +
          Math.pow(rgb[1] - avgColor[1], 2) +
          Math.pow(rgb[2] - avgColor[2], 2)
        )
        const sorted = distances.map((d, i) => ({ d, i })).sort((a, b) => a.d - b.d)
        const color1 = PALETTE_CODES[sorted[0].i]
        const color2 = PALETTE_CODES[sorted[1].i]

        const positions = []
        for (let i = 0; i < blockH * blockW; i++) positions.push(i)
        // Fisher-Yates shuffle
        for (let i = positions.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[positions[i], positions[j]] = [positions[j], positions[i]]
        }

        const n1 = Math.floor(positions.length / 2)
        for (let i = 0; i < positions.length; i++) {
          const by = Math.floor(positions[i] / blockW)
          const bx = positions[i] % blockW
          const code = i < n1 ? color1 : color2

          if (!dithered[y + by]) dithered[y + by] = []
          dithered[y + by][x + bx] = code

          const oldPixel = img[y + by][x + bx]
          const newPixel = codeToRGB(code)
          const error = [
            oldPixel[0] - newPixel[0],
            oldPixel[1] - newPixel[1],
            oldPixel[2] - newPixel[2]
          ]

          // 误差扩散
          for (const [dx, dy] of [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]]) {
            const nx = x + bx + dx
            const ny = y + by + dy
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              img[ny][nx][0] += error[0] / 8
              img[ny][nx][1] += error[1] / 8
              img[ny][nx][2] += error[2] / 8
            }
          }
        }
      }
    }
  }
  return dithered
}

/**
 * 无抖动（直接最近色）
 */
export function noDither(imageData, blackPenalty = 0) {
  const h = imageData.length
  const w = imageData[0].length
  const dithered = []

  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      row.push(findClosestColor(imageData[y][x], blackPenalty))
    }
    dithered.push(row)
  }
  return dithered
}

/**
 * 抖动算法映射表
 */
export const DITHER_ALGORITHMS = {
  'hybrid': hybridBlockDither,
  'floyd': floydSteinbergDither,
  'atkinson': atkinsonDither,
  'jjn': jarvisJudiceNinkeDither,
  'stucki': stuckiDither,
  'burkes': burkesDither,
  'sierra': sierraLiteDither,
  'sierra2': twoRowSierraDither,
  'ordered4': (img) => orderedDither(img, BAYER_MATRIX_4X4),
  'ordered8': (img) => orderedDither(img, BAYER_MATRIX_8X8),
  'noise': noiseDither,
  'none': noDither
}

/**
 * 获取支持的抖动算法列表
 */
export function getDitherAlgorithmList() {
  return [
    { id: 'hybrid', name: '混合块抖动', description: '根据亮度区域使用不同策略' },
    { id: 'floyd', name: 'Floyd-Steinberg', description: '经典误差扩散算法' },
    { id: 'atkinson', name: 'Atkinson', description: 'Apple 使用过的算法' },
    { id: 'jjn', name: 'Jarvis-Judice-Ninke', description: '更细腻的误差扩散' },
    { id: 'stucki', name: 'Stucki', description: '类似 JJN 但更快' },
    { id: 'burkes', name: 'Burkes', description: '简化版误差扩散' },
    { id: 'sierra', name: 'Sierra Lite', description: '轻量级 Sierra' },
    { id: 'sierra2', name: 'Two-Row Sierra', description: '两行 Sierra' },
    { id: 'ordered4', name: 'Bayer 4x4', description: '有序抖动 4x4' },
    { id: 'ordered8', name: 'Bayer 8x8', description: '有序抖动 8x8' },
    { id: 'noise', name: '噪声抖动', description: '随机噪声抖动' },
    { id: 'none', name: '无抖动', description: '直接映射到最近颜色' }
  ]
}
