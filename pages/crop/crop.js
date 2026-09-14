// pages/crop/crop.js
//
// 取景框的尺寸固定为设备要求的比例（800×480 或 480×800），图片则在框内
// 可缩放：缩小可以把整张图放进框里（四周留白），放大可以只取局部。
// 滑杆 100% 表示"图片刚好完整可见"，默认值是"刚好填满取景框"。
Page({
  data: {
    imagePath: '',
    cropWidth: 800,
    cropHeight: 480,
    imageWidth: 0,
    imageHeight: 0,

    // 缩放（百分比）。100 = 完整可见，默认 = 填满取景框
    zoom: 100,
    zoomMin: 100,
    zoomMax: 300,

    cropX: 0,
    cropY: 0,
    cropBoxWidth: 0,
    cropBoxHeight: 0,
    canvasWidth: 0,
    canvasHeight: 0
  },

  onUnload() {
    if (this.drawTimer) {
      clearTimeout(this.drawTimer)
      this.drawTimer = null
    }
    // 画布节点与已解码的图片都持有原生资源，离开页面时释放
    this._canvas = null
    this._ctx = null
    this._image = null
  },

  onLoad(options) {
    const imagePath = decodeURIComponent(options.imagePath || '')
    const cropWidth = parseInt(options.cropWidth) || 800
    const cropHeight = parseInt(options.cropHeight) || 480

    console.log('接收到的图片路径:', imagePath)
    console.log('裁剪尺寸:', cropWidth, cropHeight)

    this.setData({ imagePath, cropWidth, cropHeight })

    if (imagePath) {
      this.loadImage(imagePath)
    } else {
      wx.showToast({ title: '图片路径无效', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
    }
  },

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
   * 计算画布、取景框与缩放基准
   *
   * 两个基准比例都以"每个源像素占多少显示像素"为单位，且都相对**取景框**
   * 而不是画布 —— 取景框只是画布的一个子矩形，若按画布算，滑杆 100% 时
   * 整张图仍可能被框切掉：
   *   containScale —— 整张图刚好完整放进取景框（滑杆 100%，会有留白）
   *   coverScale   —— 整张图刚好填满取景框（滑杆默认值，等于原先的行为）
   */
  calculateAndDraw() {
    const imgWidth = this.imageInfo.width
    const imgHeight = this.imageInfo.height

    const sysInfo = wx.getSystemInfoSync()
    const maxWidth = sysInfo.windowWidth - 40
    const maxHeight = sysInfo.windowHeight - 260

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

    const canvasWidth = Math.max(1, Math.floor(displayWidth))
    const canvasHeight = Math.max(1, Math.floor(displayHeight))

    // 取景框：画布内能放下的最大同比例矩形
    const cropAspect = this.data.cropWidth / this.data.cropHeight
    let cropBoxWidth = canvasWidth
    let cropBoxHeight = cropBoxWidth / cropAspect
    if (cropBoxHeight > canvasHeight) {
      cropBoxHeight = canvasHeight
      cropBoxWidth = cropBoxHeight * cropAspect
    }
    cropBoxWidth = Math.floor(cropBoxWidth)
    cropBoxHeight = Math.floor(cropBoxHeight)

    const fitWidth = cropBoxWidth / imgWidth
    const fitHeight = cropBoxHeight / imgHeight
    const containScale = Math.min(fitWidth, fitHeight)
    const coverScale = Math.max(fitWidth, fitHeight)
    const coverPercent = Math.max(100, Math.ceil(coverScale / containScale * 100))

    this._containScale = containScale

    this.setData({
      imageWidth: imgWidth,
      imageHeight: imgHeight,
      canvasWidth,
      canvasHeight,
      cropBoxWidth,
      cropBoxHeight,
      cropX: Math.floor((canvasWidth - cropBoxWidth) / 2),
      cropY: Math.floor((canvasHeight - cropBoxHeight) / 2),
      zoomMin: 100,
      zoomMax: Math.max(300, coverPercent * 2),
      zoom: coverPercent
    }, () => {
      this.applyZoom()
    })
  },

  /**
   * 按当前缩放算出图片在画布上的尺寸与位置（始终居中），然后重绘
   */
  applyZoom() {
    const scale = this._containScale * this.data.zoom / 100
    const displayWidth = this.data.imageWidth * scale
    const displayHeight = this.data.imageHeight * scale

    this._displayScale = scale
    this.setData({
      imageDisplayWidth: displayWidth,
      imageDisplayHeight: displayHeight,
      imageX: (this.data.canvasWidth - displayWidth) / 2,
      imageY: (this.data.canvasHeight - displayHeight) / 2
    }, () => {
      setTimeout(() => this.drawCanvas(), 30)
    })
  },

  onZoomChange(e) {
    this.setData({ zoom: e.detail.value }, () => {
      this.applyZoom()
    })
  },

  /** 取景框回到画布中央 */
  centerCrop() {
    this.setData({
      cropX: Math.floor((this.data.canvasWidth - this.data.cropBoxWidth) / 2),
      cropY: Math.floor((this.data.canvasHeight - this.data.cropBoxHeight) / 2)
    }, () => {
      this.drawCanvas()
    })
  },

  selectSize(e) {
    const width = parseInt(e.currentTarget.dataset.w)
    const height = parseInt(e.currentTarget.dataset.h)

    if (width === this.data.cropWidth && height === this.data.cropHeight) {
      return
    }

    this.setData({ cropWidth: width, cropHeight: height }, () => {
      this.calculateAndDraw()
    })
  },

  /**
   * 缓存画布节点与已解码的图片。
   *
   * 拖动时 touchMove 每 16ms 就要重绘一次，如果每帧都重新查询节点、再
   * 从磁盘解码一遍图片，开销大到画面会一直闪；变换用 scale() 还会在
   * 赋值 width/height 未重置变换时逐帧累乘。
   */
  async ensureCanvas() {
    if (this._canvas && this._ctx) return true

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await new Promise((resolve) => {
        wx.createSelectorQuery().in(this)
          .select('#cropCanvas')
          .fields({ node: true, size: true })
          .exec((r) => resolve(r && r[0]))
      })
      if (res && res.node) {
        this._canvas = res.node
        this._ctx = this._canvas.getContext('2d')
        return true
      }
      // 首帧可能还没完成布局，等一下再试
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    console.error('Canvas 节点未找到')
    return false
  },

  async ensureImage() {
    if (this._image) return true
    if (!await this.ensureCanvas()) return false

    const img = this._canvas.createImage()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = this.data.imagePath
    })
    this._image = img
    return true
  },

  async drawCanvas() {
    try {
      if (!await this.ensureImage()) return
    } catch (e) {
      console.error('Canvas 图片加载失败:', e)
      return
    }

    const canvas = this._canvas
    const ctx = this._ctx
    const dpr = wx.getSystemInfoSync().pixelRatio
    const width = this.data.canvasWidth
    const height = this.data.canvasHeight

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr
      canvas.height = height * dpr
    }
    // setTransform 是幂等的；scale() 在变换未被重置时会不断累乘
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 图片可能比画布小，先铺白底，留白才是白色而不是透明
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(this._image,
                  this.data.imageX, this.data.imageY,
                  this.data.imageDisplayWidth, this.data.imageDisplayHeight)

    // 取景框之外压暗
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(0, 0, width, this.data.cropY)
    ctx.fillRect(0, this.data.cropY + this.data.cropBoxHeight, width,
                 height - this.data.cropY - this.data.cropBoxHeight)
    ctx.fillRect(0, this.data.cropY, this.data.cropX, this.data.cropBoxHeight)
    ctx.fillRect(this.data.cropX + this.data.cropBoxWidth, this.data.cropY,
                 width - this.data.cropX - this.data.cropBoxWidth,
                 this.data.cropBoxHeight)

    ctx.strokeStyle = '#07c160'
    ctx.lineWidth = 3
    ctx.strokeRect(this.data.cropX, this.data.cropY,
                   this.data.cropBoxWidth, this.data.cropBoxHeight)

    ctx.font = '14px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(`${this.data.cropWidth}x${this.data.cropHeight}`,
                 this.data.cropX + 10, this.data.cropY - 10)
  },

  touchStart(e) {
    if (e.touches.length === 1) {
      this.setData({
        lastTouchX: e.touches[0].clientX,
        lastTouchY: e.touches[0].clientY,
        isDragging: true
      })
    }
  },

  touchMove(e) {
    if (!this.data.isDragging || e.touches.length !== 1) return

    const deltaX = e.touches[0].clientX - this.data.lastTouchX
    const deltaY = e.touches[0].clientY - this.data.lastTouchY

    const maxX = this.data.canvasWidth - this.data.cropBoxWidth
    const maxY = this.data.canvasHeight - this.data.cropBoxHeight

    this.setData({
      cropX: Math.max(0, Math.min(this.data.cropX + deltaX, maxX)),
      cropY: Math.max(0, Math.min(this.data.cropY + deltaY, maxY)),
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
   *
   * 取景框对应到源图的区域可能有一部分落在图片之外（图片被缩小了），
   * 所以先给输出铺白：画布规范会把越界的源矩形裁掉、并按同比例裁剪目标
   * 矩形，剩下的正好就是留白。
   */
  async confirmCrop() {
    wx.showLoading({ title: '处理中...' })

    try {
      const scale = this._displayScale
      const srcX = (this.data.cropX - this.data.imageX) / scale
      const srcY = (this.data.cropY - this.data.imageY) / scale
      const srcWidth = this.data.cropBoxWidth / scale
      const srcHeight = this.data.cropBoxHeight / scale

      const canvas = wx.createOffscreenCanvas({
        type: '2d',
        width: this.data.cropWidth,
        height: this.data.cropHeight
      })
      const ctx = canvas.getContext('2d')

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, this.data.cropWidth, this.data.cropHeight)

      const img = canvas.createImage()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = this.data.imagePath
      })

      ctx.drawImage(
        img,
        srcX, srcY, srcWidth, srcHeight,
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
          processedBinary: null
        })
      }

      wx.navigateBack()

    } catch (e) {
      console.error('裁剪失败', e)
      wx.hideLoading()
      wx.showToast({ title: '裁剪失败', icon: 'none' })
    }
  },

  cancel() {
    wx.navigateBack()
  }
})
