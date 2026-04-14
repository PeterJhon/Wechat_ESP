// pages/dither/dither.js
import { processImageData, DEFAULT_CONFIG, getDitherAlgorithmList, analyzeColors, colorCodesToBinary, colorCodesToImageData } from '../../utils/epd-converter.js'

Page({
  data: {
    src: '',
    ditheredSrc: '',
    ditherAlgorithms: [],
    ditherIndex: 0,
    selectedDither: 'hybrid',
    currentDitherName: '混合块抖动',
    currentDitherDesc: '根据亮度区域使用不同策略',
    loading: false,
    showEnhancePanel: false,
    enhanceParams: {
      brightness: 1.05,
      saturation: 1.35,
      gamma: 0.85,
      contrast: 1.1,
      warmth: 1.05
    },
    colorStats: [],
    canvasWidth: 0,
    canvasHeight: 0
  },

  onLoad() {
    // 初始化算法列表
    const algorithms = getDitherAlgorithmList()
    this.setData({
      ditherAlgorithms: algorithms,
      currentDitherName: algorithms[0].name,
      currentDitherDesc: algorithms[0].description
    })
  },

  // 选择图片
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.setData({ src: tempFilePath, ditheredSrc: '' })

        // 获取图片信息
        wx.getImageInfo({
          src: tempFilePath,
          success: (imgInfo) => {
            // 计算合适的显示尺寸
            const maxSize = 800
            let width = imgInfo.width
            let height = imgInfo.height

            if (width > maxSize || height > maxSize) {
              const ratio = Math.min(maxSize / width, maxSize / height)
              width = Math.floor(width * ratio)
              height = Math.floor(height * ratio)
            }

            this.setData({
              canvasWidth: width,
              canvasHeight: height
            })
          }
        })
      }
    })
  },

  // 抖动算法选择
  onDitherChange(e) {
    const index = parseInt(e.detail.value)
    const algorithm = this.data.ditherAlgorithms[index]
    this.setData({
      ditherIndex: index,
      selectedDither: algorithm.id || 'hybrid',
      currentDitherName: algorithm.name || '混合块抖动',
      currentDitherDesc: algorithm.description || ''
    })
  },

  // 处理图像
  async processImage() {
    if (!this.data.src) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }

    this.setData({ loading: true })

    try {
      // 1. 创建离屏 canvas
      const canvas = wx.createOffscreenCanvas({
        type: '2d',
        width: this.data.canvasWidth,
        height: this.data.canvasHeight
      })
      const ctx = canvas.getContext('2d')

      // 2. 绘制图片到 canvas
      const img = canvas.createImage()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = this.data.src
      })
      ctx.drawImage(img, 0, 0, this.data.canvasWidth, this.data.canvasHeight)

      // 3. 获取 ImageData
      const imageData = ctx.getImageData(0, 0, this.data.canvasWidth, this.data.canvasHeight)

      // 4. 应用抖动算法
      const processedData = processImageData(imageData, {
        dither: this.data.selectedDither,
        ...this.data.enhanceParams
      })

      // 5. 将结果绘制回 canvas
      ctx.putImageData(processedData, 0, 0)

      // 6. 导出为临时文件
      const ditheredSrc = canvas.toDataURL()

      // 7. 分析颜色
      // 这里需要重新获取颜色代码进行分析
      // 由于 processImageData 直接返回 ImageData，我们需要修改一下

      this.setData({
        ditheredSrc,
        loading: false
      })

      wx.showToast({ title: '处理完成', icon: 'success' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '处理失败: ' + e.message, icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 切换增强面板
  toggleEnhancePanel() {
    this.setData({
      showEnhancePanel: !this.data.showEnhancePanel
    })
  },

  // 参数滑块变化
  onSliderChange(e) {
    const field = e.currentTarget.dataset.field
    const value = parseFloat(e.detail.value)
    this.setData({
      [`enhanceParams.${field}`]: value
    })
  },

  // 保存图片
  saveImage() {
    if (!this.data.ditheredSrc) {
      wx.showToast({ title: '请先处理图片', icon: 'none' })
      return
    }

    wx.saveImageToPhotosAlbum({
      filePath: this.data.ditheredSrc,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    })
  },

  // 重置参数
  resetParams() {
    this.setData({
      enhanceParams: {
        brightness: 1.05,
        saturation: 1.35,
        gamma: 0.85,
        contrast: 1.1,
        warmth: 1.05
      }
    })
    wx.showToast({ title: '参数已重置', icon: 'none' })
  }
})
