// pages/crop/crop.js
Page({
  data: {
    imagePath: '',
    cropWidth: 800,
    cropHeight: 480,
    imageWidth: 0,
    imageHeight: 0,
    scale: 1,
    cropX: 0,
    cropY: 0,
    cropBoxWidth: 0,
    cropBoxHeight: 0,
    canvasWidth: 0,
    canvasHeight: 0
  },

  onLoad(options) {
    const imagePath = decodeURIComponent(options.imagePath || '')
    const cropWidth = parseInt(options.cropWidth) || 800
    const cropHeight = parseInt(options.cropHeight) || 480

    console.log('接收到的图片路径:', imagePath)
    console.log('裁剪尺寸:', cropWidth, cropHeight)

    this.setData({
      imagePath,
      cropWidth,
      cropHeight
    })

    if (imagePath) {
      this.loadImage(imagePath)
    } else {
      wx.showToast({ title: '图片路径无效', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
    }
  },

  /**
   * 加载图片并计算尺寸
   */
  loadImage(imagePath) {
    wx.getImageInfo({
      src: imagePath,
      success: (res) => {
        this.imageInfo = res
        this.calculateAndDraw()
      },
      fail: (err) => {
        console.error('加载图片失败', err)
        wx.showToast({ title: '加载图片失败', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1500)
      }
    })
  },

  /**
   * 计算尺寸并绘制
   */
  calculateAndDraw() {
    const imgWidth = this.imageInfo.width
    const imgHeight = this.imageInfo.height

    const sysInfo = wx.getSystemInfoSync()
    const maxWidth = sysInfo.windowWidth - 40
    const maxHeight = sysInfo.windowHeight - 200

    let displayWidth = imgWidth
    let displayHeight = imgHeight

    if (displayWidth > maxWidth) {
      const ratio = maxWidth / displayWidth
      displayWidth = maxWidth
      displayHeight = displayHeight * ratio
    }
    if (displayHeight > maxHeight) {
      const ratio = maxHeight / displayHeight
      displayHeight = maxHeight
      displayWidth = displayWidth * ratio
    }

    displayWidth = Math.floor(displayWidth)
    displayHeight = Math.floor(displayHeight)

    const scale = displayWidth / imgWidth

    const cropAspect = this.data.cropWidth / this.data.cropHeight
    let cropBoxWidth = displayWidth
    let cropBoxHeight = cropBoxWidth / cropAspect

    if (cropBoxHeight > displayHeight) {
      cropBoxHeight = displayHeight
      cropBoxWidth = cropBoxHeight * cropAspect
    }

    cropBoxWidth = Math.floor(cropBoxWidth)
    cropBoxHeight = Math.floor(cropBoxHeight)

    const cropX = Math.floor((displayWidth - cropBoxWidth) / 2)
    const cropY = Math.floor((displayHeight - cropBoxHeight) / 2)

    this.setData({
      imageWidth: imgWidth,
      imageHeight: imgHeight,
      canvasWidth: displayWidth,
      canvasHeight: displayHeight,
      scale: scale,
      cropBoxWidth,
      cropBoxHeight,
      cropX,
      cropY
    }, () => {
      setTimeout(() => {
        this.drawCanvas()
      }, 100)
    })
  },

  /**
   * 选择尺寸
   */
  selectSize(e) {
    const width = parseInt(e.currentTarget.dataset.w)
    const height = parseInt(e.currentTarget.dataset.h)

    if (width === this.data.cropWidth && height === this.data.cropHeight) {
      return
    }

    this.setData({
      cropWidth: width,
      cropHeight: height
    }, () => {
      this.calculateAndDraw()
    })
  },

  /**
   * 绘制画布
   */
  drawCanvas() {
    console.log('drawCanvas 被调用', this.data)

    const query = wx.createSelectorQuery().in(this)
    query.select('#cropCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        console.log('Canvas 查询结果:', res)

        if (!res[0] || !res[0].node) {
          console.error('Canvas 节点未找到')
          return
        }

        const canvas = res[0].node
        const ctx = canvas.getContext('2d')

        console.log('Canvas 尺寸:', this.data.canvasWidth, this.data.canvasHeight)
        console.log('图片路径:', this.data.imagePath)

        const dpr = wx.getSystemInfoSync().pixelRatio
        canvas.width = this.data.canvasWidth * dpr
        canvas.height = this.data.canvasHeight * dpr
        ctx.scale(dpr, dpr)

        ctx.clearRect(0, 0, this.data.canvasWidth, this.data.canvasHeight)

        const img = canvas.createImage()
        img.onload = () => {
          console.log('图片加载成功，开始绘制')

          ctx.drawImage(
            img,
            0, 0,
            this.data.canvasWidth,
            this.data.canvasHeight
          )

          ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'

          ctx.fillRect(0, 0, this.data.canvasWidth, this.data.cropY)
          ctx.fillRect(0, this.data.cropY + this.data.cropBoxHeight, this.data.canvasWidth, this.data.canvasHeight - this.data.cropY - this.data.cropBoxHeight)
          ctx.fillRect(0, this.data.cropY, this.data.cropX, this.data.cropBoxHeight)
          ctx.fillRect(this.data.cropX + this.data.cropBoxWidth, this.data.cropY, this.data.canvasWidth - this.data.cropX - this.data.cropBoxWidth, this.data.cropBoxHeight)

          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.strokeRect(this.data.cropX, this.data.cropY, this.data.cropBoxWidth, this.data.cropBoxHeight)

          const cornerSize = 20
          ctx.strokeStyle = '#07c160'
          ctx.lineWidth = 4

          ctx.beginPath()
          ctx.moveTo(this.data.cropX, this.data.cropY + cornerSize)
          ctx.lineTo(this.data.cropX, this.data.cropY)
          ctx.lineTo(this.data.cropX + cornerSize, this.data.cropY)
          ctx.stroke()

          ctx.beginPath()
          ctx.moveTo(this.data.cropX + this.data.cropBoxWidth - cornerSize, this.data.cropY)
          ctx.lineTo(this.data.cropX + this.data.cropBoxWidth, this.data.cropY)
          ctx.lineTo(this.data.cropX + this.data.cropBoxWidth, this.data.cropY + cornerSize)
          ctx.stroke()

          ctx.beginPath()
          ctx.moveTo(this.data.cropX, this.data.cropY + this.data.cropBoxHeight - cornerSize)
          ctx.lineTo(this.data.cropX, this.data.cropY + this.data.cropBoxHeight)
          ctx.lineTo(this.data.cropX + cornerSize, this.data.cropY + this.data.cropBoxHeight)
          ctx.stroke()

          ctx.beginPath()
          ctx.moveTo(this.data.cropX + this.data.cropBoxWidth - cornerSize, this.data.cropY + this.data.cropBoxHeight)
          ctx.lineTo(this.data.cropX + this.data.cropBoxWidth, this.data.cropY + this.data.cropBoxHeight)
          ctx.lineTo(this.data.cropX + this.data.cropBoxWidth, this.data.cropY + this.data.cropBoxHeight - cornerSize)
          ctx.stroke()

          ctx.font = '14px sans-serif'
          ctx.fillStyle = '#fff'
          ctx.fillText(`${this.data.cropWidth}x${this.data.cropHeight}`, this.data.cropX + 10, this.data.cropY - 10)
        }
        img.onerror = (err) => {
          console.error('Canvas 图片加载失败:', err)
        }
        img.src = this.data.imagePath
      })
  },

  /**
   * 触摸开始
   */
  touchStart(e) {
    if (e.touches.length === 1) {
      this.setData({
        lastTouchX: e.touches[0].clientX,
        lastTouchY: e.touches[0].clientY,
        isDragging: true
      })
    }
  },

  /**
   * 触摸移动
   */
  touchMove(e) {
    if (!this.data.isDragging || e.touches.length !== 1) return

    const deltaX = e.touches[0].clientX - this.data.lastTouchX
    const deltaY = e.touches[0].clientY - this.data.lastTouchY

    let newCropX = this.data.cropX + deltaX
    let newCropY = this.data.cropY + deltaY

    const maxX = this.data.canvasWidth - this.data.cropBoxWidth
    const maxY = this.data.canvasHeight - this.data.cropBoxHeight

    newCropX = Math.max(0, Math.min(newCropX, maxX))
    newCropY = Math.max(0, Math.min(newCropY, maxY))

    this.setData({
      cropX: newCropX,
      cropY: newCropY,
      lastTouchX: e.touches[0].clientX,
      lastTouchY: e.touches[0].clientY
    })

    if (!this.drawTimer) {
      this.drawTimer = setTimeout(() => {
        this.drawCanvas()
        this.drawTimer = null
      }, 16)
    }
  },

  /**
   * 触摸结束
   */
  touchEnd() {
    this.setData({ isDragging: false })
    if (this.drawTimer) {
      clearTimeout(this.drawTimer)
      this.drawTimer = null
      this.drawCanvas()
    }
  },

  /**
   * 确认裁剪
   */
  async confirmCrop() {
    wx.showLoading({ title: '处理中...' })

    try {
      const realCropX = this.data.cropX / this.data.scale
      const realCropY = this.data.cropY / this.data.scale
      const realCropWidth = this.data.cropBoxWidth / this.data.scale
      const realCropHeight = this.data.cropBoxHeight / this.data.scale

      const canvas = wx.createOffscreenCanvas({
        type: '2d',
        width: this.data.cropWidth,
        height: this.data.cropHeight
      })
      const ctx = canvas.getContext('2d')

      const img = canvas.createImage()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = this.data.imagePath
      })

      ctx.drawImage(
        img,
        realCropX, realCropY, realCropWidth, realCropHeight,
        0, 0, this.data.cropWidth, this.data.cropHeight
      )

      const tempFilePath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: canvas,
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        })
      })

      wx.hideLoading()

      const pages = getCurrentPages()
      const prevPage = pages[pages.length - 2]

      if (prevPage) {
        prevPage.setData({
          imageSrc: tempFilePath,
          processedSrc: '',
          processedBinary: null,
          colorStats: []
        })
      }

      wx.navigateBack()

    } catch (e) {
      console.error('裁剪失败', e)
      wx.hideLoading()
      wx.showToast({ title: '裁剪失败', icon: 'none' })
    }
  },

  /**
   * 取消裁剪
   */
  cancel() {
    wx.navigateBack()
  }
})
