// pages/index/index.js
import { processImageData, DEFAULT_CONFIG, getDitherAlgorithmList, convertToEPD, colorCodesToBinary, colorCodesToImageData } from '../../utils/epd-converter.js'

Page({
  data: {
    // 蓝牙相关
    bluetoothReady: false,
    searching: false,
    devices: [],
    connected: false,
    currentDeviceId: '',
    services: [],
    adapterAvailable: false,

    // 标签页
    currentTab: 0,

    // 图片处理相关
    imageSrc: '',
    processedSrc: '',
    processing: false,
    showEnhance: false,
    selectedAlgo: 'hybrid',
    enhanceParams: {
      brightness: 1.05,
      saturation: 1.35,
      gamma: 0.85,
      contrast: 1.1,
      warmth: 1.05
    },
    algorithms: [
      { id: 'hybrid', name: '混合块抖动', desc: '根据亮度自适应' },
      { id: 'floyd', name: 'Floyd-Steinberg', desc: '经典误差扩散' },
      { id: 'atkinson', name: 'Atkinson', desc: 'Apple风格' },
      { id: 'jjn', name: 'Jarvis-Judice', desc: '更细腻' },
      { id: 'ordered4', name: 'Bayer 4x4', desc: '有序抖动' },
      { id: 'ordered8', name: 'Bayer 8x8', desc: '更细腻有序' },
      { id: 'noise', name: '噪声抖动', desc: '随机噪点' }
    ],
    processedBinary: null, // 存储二进制数据用于发送
    colorStats: [], // 颜色统计
    cropWidth: 800, // 裁剪宽度
    cropHeight: 480, // 裁剪高度
    // BLE 文件传输
    writeServiceId: '',       // 0xABF0 服务 ID
    writeCharacteristicId: '', // 0xABF1 特征值 ID
    notifyEnabled: false,
    mtu: 20,                  // 协商后的 MTU（默认20）
    sending: false,
    sendProgress: 0,

    // 文件管理
    imageFiles: [],           // {id, size}
    loadingFiles: false,
    fileListBuffer: [],       // accumulated notify data for FILE_LIST response

    // 轮播设置
    slideshowEnabled: false,
    slideshowInterval: 30
  },

  onLoad() {
    this.checkBluetooth()
    this._lastImageSrc = ''
  },

  onShow() {
    // Coming back from crop page: image may have been replaced
    if (this.data.imageSrc && this.data.imageSrc !== this._lastImageSrc) {
      this._rawPixels = null
      this._lastImageSrc = this.data.imageSrc
      this.rasterizeSource(this.data.imageSrc)
    }
  },

  onUnload() {
    this.closeBluetooth()
  },

  /**
   * 切换标签页
   */
  switchTab(e) {
    this.setData({
      currentTab: parseInt(e.currentTarget.dataset.index)
    })
  },

  // ========== 蓝牙相关方法 ==========

  checkBluetooth() {
    wx.getBluetoothAdapterState({
      success: (res) => {
        console.log('蓝牙状态:', res)
        this.setData({
          bluetoothReady: res.available,
          adapterAvailable: res.available
        })
      },
      fail: (err) => {
        console.error('蓝牙不可用:', err)
        this.setData({ adapterAvailable: false })
      }
    })
  },

  initBluetooth() {
    wx.openBluetoothAdapter({
      success: (res) => {
        console.log('蓝牙初始化成功', res)
        this.setData({ bluetoothReady: true })
        this.onBluetoothStateChange()
      },
      fail: (err) => {
        console.error('蓝牙初始化失败', err)
        wx.showToast({ title: '请开启蓝牙', icon: 'none' })
        if (err.errCode === 10001) {
          wx.showModal({
            title: '提示',
            content: '检测到蓝牙未开启，是否前往设置？',
            success: (res) => {
              if (res.confirm) wx.openSetting()
            }
          })
        }
      }
    })
  },

  onBluetoothStateChange() {
    wx.onBluetoothAdapterStateChange((res) => {
      console.log('蓝牙状态变化:', res)
      this.setData({ bluetoothReady: res.available })
      if (!res.available) {
        wx.showToast({ title: '蓝牙已关闭', icon: 'none' })
      }
    })
  },

  startSearch() {
    if (this.data.searching) return
    this.setData({ searching: true, devices: [] })

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: (res) => {
        console.log('开始搜索设备', res)
        this.onDeviceFound()
        setTimeout(() => {
          if (this.data.searching) this.stopSearch()
        }, 15000)
      },
      fail: (err) => {
        console.error('搜索失败', err)
        this.setData({ searching: false })
        wx.showToast({ title: '搜索失败', icon: 'none' })
      }
    })
  },

  stopSearch() {
    wx.stopBluetoothDevicesDiscovery({
      success: () => {
        console.log('停止搜索')
        this.setData({ searching: false })
      }
    })
  },

  onDeviceFound() {
    wx.onBluetoothDeviceFound((res) => {
      const newDevices = res.devices.map(device => {
        // 尝试从多个位置获取设备名称
        let name = device.name || device.localName

        // 如果名称仍为空，尝试从广播数据中提取
        if (!name && device.advertisData) {
          const adv = device.advertisData
          // 尝试常见的 localName 字段
          name = adv.localName || adv.kCBAdvDataLocalName || adv.deviceName

          // 尝试从广播数据中解析（某些设备名称在 Service UUID 中）
          if (!name && adv.serviceUuids) {
            name = 'BLE设备'
          }
        }

        // 如果还是没有名称，显示部分设备ID
        if (!name) {
          const id = device.deviceId || ''
          name = '设备_' + id.substring(id.length - 6, id.length)
        }

        return {
          deviceId: device.deviceId,
          name: name,
          RSSI: device.RSSI,
          advertisData: device.advertisData
        }
      })

      const devices = this.data.devices
      newDevices.forEach(newDevice => {
        const existingIndex = devices.findIndex(d => d.deviceId === newDevice.deviceId)
        if (existingIndex === -1) {
          devices.push(newDevice)
        } else {
          devices[existingIndex].RSSI = newDevice.RSSI
        }
      })

      devices.sort((a, b) => b.RSSI - a.RSSI)
      this.setData({ devices })
    })
  },

  connectDevice(e) {
    const device = e.currentTarget.dataset.device
    if (this.data.connected && this.data.currentDeviceId === device.deviceId) return

    if (this.data.searching) this.stopSearch()

    wx.showLoading({ title: '连接中...' })

    wx.createBLEConnection({
      deviceId: device.deviceId,
      timeout: 10000,
      success: () => {
        console.log('连接成功', device.deviceId)
        this.setData({ connected: true, currentDeviceId: device.deviceId })
        wx.hideLoading()
        wx.showToast({ title: '连接成功', icon: 'success' })
        this.getServices(device.deviceId)
        this.onConnectionClose()
      },
      fail: (err) => {
        console.error('连接失败', err)
        wx.hideLoading()
        let errorMsg = '连接失败'
        if (err.errCode === 10003) errorMsg = '连接超时'
        else if (err.errCode === 10012) errorMsg = '连接超时，请靠近设备'
        wx.showToast({ title: errorMsg, icon: 'none' })
      }
    })
  },

  onConnectionClose() {
    wx.onBLEConnectionStateChange((res) => {
      if (!res.connected) {
        this.setData({
          connected: false,
          currentDeviceId: '',
          services: []
        })
        wx.showToast({ title: '连接已断开', icon: 'none' })
      }
    })
  },

  getServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: (res) => {
        console.log('获取服务成功', res)
        const services = []
        let completedCount = 0
        const totalServices = res.services.length

        res.services.forEach((service) => {
          const serviceInfo = {
            uuid: service.uuid,
            isPrimary: service.isPrimary,
            characteristics: []
          }
          this.getCharacteristics(deviceId, service.uuid, serviceInfo, (charResult) => {
            serviceInfo.characteristics = charResult
            services.push(serviceInfo)
            completedCount++

            // 查找目标特征值 (0xABF0 服务 + 0xABF1 特征值)
            const svcUuidUpper = service.uuid.toUpperCase()
            if (svcUuidUpper.indexOf('ABF0') !== -1) {
              charResult.forEach(ch => {
                const charUuidUpper = ch.uuid.toUpperCase()
                if (charUuidUpper.indexOf('ABF1') !== -1 &&
                    ch.properties && (ch.properties.write || ch.properties.writeNoResponse)) {
                  console.log('找到目标特征值:', service.uuid, ch.uuid)
                  this.setData({
                    writeServiceId: service.uuid,
                    writeCharacteristicId: ch.uuid
                  })
                  // 启用 notify 以接收 ACK（直接传 serviceId，避免 setData 异步问题）
                  this.enableNotify(deviceId, service.uuid, ch.uuid)
                }
              })
            }

            if (completedCount === totalServices) {
              this.setData({ services })
              // 服务发现完后再协商 MTU（此时才能成功）
              this.negotiateMTU(deviceId)
            }
          })
        })
      },
      fail: (err) => console.error('获取服务失败', err)
    })
  },

  /**
   * 启用 notify 接收 ACK
   */
  enableNotify(deviceId, serviceId, characteristicId) {
    // 先存储 serviceId，setData 是异步的这里必须直接传参
    wx.notifyBLECharacteristicValueChange({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      state: true,
      success: () => {
        console.log('Notify 已启用')
        this.setData({ notifyEnabled: true })
        // Query slideshow state after connection
        setTimeout(() => this.querySlideshowState(), 300)
        wx.onBLECharacteristicValueChange((res) => {
          const buf = new Uint8Array(res.value)
          console.log('收到数据(' + buf.length + 'B):', Array.from(buf.slice(0, 8)))
          if (buf.length >= 2 && buf[0] === 0xFF) {
            const ackCmd = (buf[1] >> 4) & 0x0F
            const status = buf[1] & 0x0F
            console.log('ACK: cmd=' + ackCmd + ' status=' + status)
          }
          // Parse FILE_LIST response (0x10)
          if (buf.length >= 2 && buf[0] === 0x10) {
            const prev = this.data.fileListBuffer || []
            const combined = prev.concat(Array.from(buf))
            if (combined.length >= 2) {
              const count = combined[1]
              const expected = 2 + count * 6
              if (combined.length >= expected) {
                const files = []
                for (let i = 0; i < count; i++) {
                  const off = 2 + i * 6
                  const id = combined[off] | (combined[off + 1] << 8)
                  const rawSize = combined[off + 2] | (combined[off + 3] << 8) |
                                  (combined[off + 4] << 16) | (combined[off + 5] << 24)
                  files.push({ id, size: this.formatFileSize(rawSize) })
                }
                this.setData({ imageFiles: files, loadingFiles: false, fileListBuffer: [] })
                console.log('文件列表解析完成: ' + files.length + ' 个文件')
              } else {
                this.setData({ fileListBuffer: combined })
              }
            }
          }
          // Parse SLIDESHOW_STATE response (0x14)
          if (buf.length >= 4 && buf[0] === 0x14) {
            const enabled = buf[1] !== 0
            const interval = buf[2] | (buf[3] << 8)
            console.log('轮播状态: enabled=' + enabled + ' interval=' + interval)
            this.setData({
              slideshowEnabled: enabled,
              slideshowInterval: interval
            })
          }
        })
      },
      fail: (err) => {
        console.error('启用Notify失败', err)
      }
    })
  },

  /**
   * MTU 协商（必须在服务发现完成后调用，带重试）
   */
  negotiateMTU(deviceId, retryCount = 0) {
    const maxRetry = 3
    console.log('MTU协商... (第' + (retryCount + 1) + '次)')

    if (typeof wx.setBLEMTU !== 'function') {
      console.error('当前微信版本不支持 wx.setBLEMTU，需要基础库 >= 2.20.1')
      this.setData({ mtu: 20 })
      wx.showToast({ title: '微信版本太旧, 速度受限', icon: 'none' })
      return
    }

    wx.setBLEMTU({
      deviceId: deviceId,
      mtu: 512,
      success: (res) => {
        const mtu = res.mtu
        console.log('MTU协商成功:', mtu)
        if (mtu && mtu > 23) {
          this.setData({ mtu: mtu })
          wx.showToast({ title: '高速模式 MTU=' + mtu, icon: 'success', duration: 2000 })
        } else if (retryCount < maxRetry) {
          console.log('MTU偏低, 500ms后重试...')
          setTimeout(() => this.negotiateMTU(deviceId, retryCount + 1), 500)
        } else {
          this.setData({ mtu: 20 })
        }
      },
      fail: (err) => {
        console.error('MTU协商失败:', JSON.stringify(err))
        if (retryCount < maxRetry) {
          console.log('500ms后重试...')
          setTimeout(() => this.negotiateMTU(deviceId, retryCount + 1), 500)
        } else {
          this.setData({ mtu: 20 })
          wx.showToast({ title: 'MTU协商失败, 速度较慢', icon: 'none' })
        }
      }
    })
  },

  getCharacteristics(deviceId, serviceId, serviceInfo, callback) {
    wx.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: serviceId,
      success: (res) => {
        const characteristics = res.characteristics.map(char => ({
          uuid: char.uuid,
          properties: char.properties
        }))
        callback(characteristics)
      },
      fail: (err) => {
        console.error('获取特征值失败', err)
        callback([])
      }
    })
  },

  disconnect() {
    if (!this.data.currentDeviceId) return
    wx.closeBLEConnection({
      deviceId: this.data.currentDeviceId,
      success: () => {
        this.setData({
          connected: false,
          currentDeviceId: '',
          services: []
        })
        wx.showToast({ title: '已断开连接', icon: 'success' })
      }
    })
  },

  closeBluetooth() {
    if (this.data.searching) this.stopSearch()
    if (this.data.connected) this.disconnect()
    wx.closeBluetoothAdapter({
      success: () => {
        this.setData({ bluetoothReady: false, devices: [] })
      }
    })
  },

  // ========== 图片处理相关方法 ==========

  /**
   * 选择图片
   */
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const imagePath = res.tempFiles[0].tempFilePath
        this.processedBinary = null
        this._lastImageSrc = imagePath
        this._rawPixels = null  // invalidate cache for new image
        this.setData({
          imageSrc: imagePath,
          processedSrc: '',
          colorStats: []
        })
        // Pre-rasterize so processImage() can skip image loading
        this.rasterizeSource(imagePath)
      }
    })
  },

  /**
   * 选择裁剪尺寸
   */
  selectCropSize(e) {
    const size = parseInt(e.currentTarget.dataset.size)
    if (size === 800) {
      this.setData({ cropWidth: 800, cropHeight: 480 })
    } else {
      this.setData({ cropWidth: 480, cropHeight: 800 })
    }
  },

  /**
   * 裁剪图片
   */
  cropImage() {
    wx.navigateTo({
      url: `/pages/crop/crop?imagePath=${encodeURIComponent(this.data.imageSrc)}&cropWidth=${this.data.cropWidth}&cropHeight=${this.data.cropHeight}`
    })
  },

  /**
   * 选择抖动算法
   */
  selectAlgo(e) {
    this.setData({
      selectedAlgo: e.currentTarget.dataset.id
    })
  },

  /**
   * 切换增强参数面板
   */
  toggleEnhancePanel() {
    this.setData({
      showEnhance: !this.data.showEnhance
    })
  },

  /**
   * 参数变化
   */
  onParamChange(e) {
    const key = e.currentTarget.dataset.key
    const value = parseFloat(e.detail.value)
    this.setData({
      [`enhanceParams.${key}`]: value
    })
  },

  /**
   * 重置参数
   */
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
  },

  /**
   * 处理图片
   */
  /**
   * 栅格化原始图片，缓存像素数据，后续换算法无需重新加载图片
   */
  async rasterizeSource(imagePath) {
    try {
      const imgInfo = await new Promise((resolve, reject) => {
        wx.getImageInfo({ src: imagePath, success: resolve, fail: reject })
      })

      const maxSize = 800
      let w = imgInfo.width, h = imgInfo.height
      if (w > maxSize || h > maxSize) {
        const ratio = Math.min(maxSize / w, maxSize / h)
        w = Math.floor(w * ratio)
        h = Math.floor(h * ratio)
      }

      const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
      const ctx = canvas.getContext('2d')
      const img = canvas.createImage()

      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = imagePath
      })
      ctx.drawImage(img, 0, 0, w, h)

      const imageData = ctx.getImageData(0, 0, w, h)
      this._rawPixels = new Uint8ClampedArray(imageData.data)
      this._rawWidth = w
      this._rawHeight = h
      console.log('Source rasterized: ' + w + 'x' + h)
    } catch (e) {
      console.error('Rasterize failed:', e)
      this._rawPixels = null
    }
  },

  /**
   * 处理图片
   */
  async processImage() {
    if (!this.data.imageSrc) return

    this.setData({ processing: true })

    try {
      let width, height
      let imageData

      // 优先使用缓存的原始像素数据，避免重复加载图片导致 onload 不触发而卡死
      if (this._rawPixels && this._rawWidth && this._rawHeight) {
        width = this._rawWidth
        height = this._rawHeight
      } else {
        // 首次处理：加载图片并缓存
        const imgInfo = await new Promise((resolve, reject) => {
          wx.getImageInfo({ src: this.data.imageSrc, success: resolve, fail: reject })
        })

        const maxSize = 800
        width = imgInfo.width
        height = imgInfo.height
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height)
          width = Math.floor(width * ratio)
          height = Math.floor(height * ratio)
        }

        const loadCanvas = wx.createOffscreenCanvas({ type: '2d', width, height })
        const loadCtx = loadCanvas.getContext('2d')
        const img = loadCanvas.createImage()
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = this.data.imageSrc
        })
        loadCtx.drawImage(img, 0, 0, width, height)

        const rawData = loadCtx.getImageData(0, 0, width, height)
        this._rawPixels = new Uint8ClampedArray(rawData.data)
        this._rawWidth = width
        this._rawHeight = height
        console.log('Source rasterized (first): ' + width + 'x' + height)
      }

      // 创建输出 canvas 并从缓存复制原始像素
      const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      const ctx = canvas.getContext('2d')
      imageData = ctx.createImageData(width, height)
      imageData.data.set(this._rawPixels)
      const originalData = imageData.data

      // 应用抖动算法
      const colorCodes = convertToEPD(imageData, {
        dither: this.data.selectedAlgo,
        ...this.data.enhanceParams
      })
      const processedData = colorCodesToImageData(colorCodes, width, height)

      // 竖屏图片需要转置
      let finalColorCodes = colorCodes
      if (colorCodes.length > (colorCodes[0] || []).length) {
        const h = colorCodes.length
        const w = colorCodes[0].length
        const transposed = []
        for (let x = 0; x < w; x++) {
          const row = new Array(h)
          for (let y = 0; y < h; y++) {
            row[y] = colorCodes[y][x]
          }
          transposed.push(row)
        }
        finalColorCodes = transposed
        console.log('竖屏图片已转置: ' + h + 'x' + w + ' → ' + w + 'x' + h)
      }

      const binary = colorCodesToBinary(finalColorCodes)
      const colorStats = this.analyzeColorStats(finalColorCodes)

      // 将处理结果写入 canvas
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = processedData.data[i]
      }
      ctx.putImageData(imageData, 0, 0)
      const processedSrc = canvas.toDataURL()

      this.processedBinary = binary
      this.setData({
        processedSrc,
        colorStats,
        processing: false
      })

      wx.showToast({ title: '处理完成', icon: 'success' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '处理失败: ' + e.message, icon: 'none' })
      this.setData({ processing: false })
    }
  },

  /**
   * 保存图片
   */
  saveImage() {
    if (!this.data.processedSrc) return

    // 先检查权限
    wx.getSetting({
      success: (res) => {
        if (!res.authSetting['scope.writePhotosAlbum']) {
          // 没有权限，请求授权
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => {
              this.doSaveImage()
            },
            fail: () => {
              // 用户拒绝授权，引导到设置
              wx.showModal({
                title: '提示',
                content: '需要相册权限才能保存图片，是否前往设置？',
                success: (res) => {
                  if (res.confirm) {
                    wx.openSetting()
                  }
                }
              })
            }
          })
        } else {
          // 已有权限，直接保存
          this.doSaveImage()
        }
      }
    })
  },

  /**
   * 执行保存图片
   */
  doSaveImage() {
    // 将 base64 转换为临时文件
    const base64Data = this.data.processedSrc
    const filePath = wx.env.USER_DATA_PATH + '/epd_dither_' + Date.now() + '.png'

    wx.getFileSystemManager().writeFile({
      filePath: filePath,
      data: base64Data.split(',')[1] || base64Data,
      encoding: 'base64',
      success: () => {
        wx.saveImageToPhotosAlbum({
          filePath: filePath,
          success: () => {
            wx.showToast({ title: '已保存到相册', icon: 'success' })
          },
          fail: (err) => {
            console.error('保存失败:', err)
            wx.showToast({ title: '保存失败: ' + (err.errMsg || ''), icon: 'none' })
          }
        })
      },
      fail: (err) => {
        console.error('写入文件失败:', err)
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    })
  },

  /**
   * 发送到设备 (BLE 文件传输协议)
   * CMD_FILE_START (0x01): 开始传输
   * CMD_FILE_DATA  (0x02): 数据块
   * CMD_FILE_END   (0x03): 传输完成
   */
  sendToDevice() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!this.processedBinary) {
      wx.showToast({ title: '请先处理图片', icon: 'none' })
      return
    }
    if (!this.data.writeServiceId || !this.data.writeCharacteristicId) {
      wx.showToast({ title: '未找到目标特征值(0xABF1)', icon: 'none' })
      return
    }
    if (this.data.sending) {
      wx.showToast({ title: '正在发送中...', icon: 'none' })
      return
    }

    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    const binary = new Uint8Array(this.processedBinary)
    const filename = '/sdcard/img.bin'

    this.setData({ sending: true, sendProgress: 0 })

    // Uint8Array → ArrayBuffer（WeChat BLE API 需要 ArrayBuffer）
    const toArrayBuffer = (arr) => {
      const buf = new ArrayBuffer(arr.length)
      const view = new Uint8Array(buf)
      view.set(arr)
      return buf
    }

    // 写入特征值
    const writeChar = (arr) => {
      return new Promise((resolve, reject) => {
        const ab = toArrayBuffer(arr)
        console.log('BLE写入 ' + arr.length + 'B:', Array.from(arr.slice(0, 8)))
        wx.writeBLECharacteristicValue({
          deviceId, serviceId, characteristicId: charId,
          value: ab,
          success: () => {
            console.log(' 写入成功')
            resolve()
          },
          fail: (err) => {
            console.error(' 写入失败:', JSON.stringify(err))
            reject(err)
          }
        })
      })
    }

    // 字符串 → 字节数组（微信没有 TextEncoder，手动转换 ASCII）
    const strToBytes = (str) => {
      const bytes = new Uint8Array(str.length)
      for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i) & 0xFF
      }
      return bytes
    }

    // 分块大小 = MTU - 3(ATT头) - 1(命令字节) = MTU - 4
    // 默认 MTU=20 → 16字节数据/包；MTU=256 → 252字节数据/包（快16倍）
    const CHUNK_DATA_SIZE = Math.max(16, this.data.mtu - 4)

    const sendWithProtocol = async () => {
      try {
        // Step 1: CMD_FILE_START
        console.log('=== 开始传输 ===')
        console.log('MTU:', this.data.mtu, '每包数据:', CHUNK_DATA_SIZE, 'B')
        console.log('文件名:', filename, '数据大小:', binary.length, '字节')
        console.log('预计包数:', Math.ceil(binary.length / CHUNK_DATA_SIZE))

        const nameBytes = strToBytes(filename)
        const startPacket = new Uint8Array(2 + nameBytes.length)
        startPacket[0] = 0x01  // CMD_FILE_START
        startPacket[1] = nameBytes.length
        startPacket.set(nameBytes, 2)
        console.log('发送 CMD_FILE_START (' + startPacket.length + 'B)')
        await writeChar(startPacket)
        await this.sleep(200)

        // Step 2: CMD_FILE_DATA (分块发送)
        let offset = 0
        const total = binary.length
        let lastProgress = 0
        console.log('开始发送数据, 总包数:', Math.ceil(total / CHUNK_DATA_SIZE))

        while (offset < total) {
          const remaining = total - offset
          const dataSize = Math.min(CHUNK_DATA_SIZE, remaining)
          const packet = new Uint8Array(1 + dataSize)
          packet[0] = 0x02  // CMD_FILE_DATA
          packet.set(binary.subarray(offset, offset + dataSize), 1)
          await writeChar(packet)
          await this.sleep(10)  // Give NimBLE stack time to process

          offset += dataSize
          const progress = Math.floor(offset / total * 100)
          // 只在进度变化时更新 UI（减少开销）
          if (progress !== lastProgress) {
            lastProgress = progress
            this.setData({ sendProgress: progress })
            console.log(progress + '%', '(' + offset + '/' + total + ')')
          }
        }

        // Step 3: CMD_FILE_END
        console.log('发送 CMD_FILE_END')
        const endPacket = new Uint8Array([0x03])
        await writeChar(endPacket)
        await this.sleep(300)

        this.setData({ sending: false, sendProgress: 100 })
        wx.hideToast()
        wx.showToast({ title: '发送完成!', icon: 'success' })
        console.log('=== 传输完成 ===')
      } catch (err) {
        console.error('发送失败:', JSON.stringify(err))
        this.setData({ sending: false })
        wx.hideToast()
        wx.showModal({
          title: '发送失败',
          content: '错误: ' + (err.errMsg || err.message || JSON.stringify(err)),
          showCancel: false
        })
      }
    }

    sendWithProtocol()
  },

  /**
   * 请求文件列表 (CMD_FILE_LIST = 0x10)
   */
  requestFileList() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!this.data.writeServiceId || !this.data.writeCharacteristicId) {
      wx.showToast({ title: '未找到目标特征值', icon: 'none' })
      return
    }

    this.setData({ loadingFiles: true, imageFiles: [], fileListBuffer: [] })

    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    const cmd = new Uint8Array([0x10])
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    wx.writeBLECharacteristicValue({
      deviceId, serviceId, characteristicId: charId,
      value: ab,
      success: () => {
        console.log('FILE_LIST 请求已发送')
      },
      fail: (err) => {
        console.error('FILE_LIST 发送失败:', err)
        this.setData({ loadingFiles: false })
        wx.showToast({ title: '请求失败', icon: 'none' })
      }
    })
  },

  /**
   * 删除图片 (CMD_FILE_DELETE = 0x11)
   */
  deleteImage(e) {
    const id = parseInt(e.currentTarget.dataset.id)
    if (!this.data.connected) return

    wx.showModal({
      title: '确认删除',
      content: '确定要删除图片 #' + id + ' 吗？',
      success: (res) => {
        if (!res.confirm) return

        const deviceId = this.data.currentDeviceId
        const serviceId = this.data.writeServiceId
        const charId = this.data.writeCharacteristicId

        const cmd = new Uint8Array(3)
        cmd[0] = 0x11
        cmd[1] = id & 0xFF
        cmd[2] = (id >> 8) & 0xFF
        const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

        wx.writeBLECharacteristicValue({
          deviceId, serviceId, characteristicId: charId,
          value: ab,
          success: () => {
            console.log('DELETE 请求已发送: id=' + id)
            wx.showToast({ title: '删除中...', icon: 'none' })
            // Refresh file list after a short delay
            setTimeout(() => this.requestFileList(), 500)
          },
          fail: (err) => {
            console.error('DELETE 发送失败:', err)
          }
        })
      }
    })
  },

  /**
   * 选择图片显示 (CMD_FILE_SELECT = 0x12)
   */
  selectImage(e) {
    const id = parseInt(e.currentTarget.dataset.id)
    if (!this.data.connected) return

    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId

    const cmd = new Uint8Array(3)
    cmd[0] = 0x12
    cmd[1] = id & 0xFF
    cmd[2] = (id >> 8) & 0xFF
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    wx.writeBLECharacteristicValue({
      deviceId, serviceId, characteristicId: charId,
      value: ab,
      success: () => {
        console.log('SELECT 请求已发送: id=' + id)
        wx.showToast({ title: '已发送显示指令', icon: 'none' })
      },
      fail: (err) => {
        console.error('SELECT 发送失败:', err)
      }
    })
  },

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  },

  /**
   * 查询轮播状态 (CMD_SLIDESHOW_STATE = 0x14)
   */
  querySlideshowState() {
    if (!this.data.connected) return
    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    if (!serviceId || !charId) return

    const cmd = new Uint8Array([0x14])
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    wx.writeBLECharacteristicValue({
      deviceId, serviceId, characteristicId: charId,
      value: ab,
      success: () => console.log('SLIDESHOW_STATE 请求已发送'),
      fail: (err) => console.error('SLIDESHOW_STATE 发送失败:', err)
    })
  },

  /**
   * 发送轮播配置 (CMD_SLIDESHOW_CTRL = 0x13)
   */
  sendSlideshowConfig(enabled, interval) {
    if (!this.data.connected) return
    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    if (!serviceId || !charId) return

    const cmd = new Uint8Array(4)
    cmd[0] = 0x13
    cmd[1] = enabled ? 1 : 0
    cmd[2] = interval & 0xFF
    cmd[3] = (interval >> 8) & 0xFF
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    wx.writeBLECharacteristicValue({
      deviceId, serviceId, characteristicId: charId,
      value: ab,
      success: () => console.log('SLIDESHOW_CTRL 已发送: enabled=' + enabled + ' interval=' + interval),
      fail: (err) => console.error('SLIDESHOW_CTRL 发送失败:', err)
    })
  },

  /**
   * 轮播开关切换
   */
  onSlideshowToggle(e) {
    const enabled = e.detail.value
    this.setData({ slideshowEnabled: enabled })
    this.sendSlideshowConfig(enabled, this.data.slideshowInterval)
  },

  /**
   * 轮播间隔变化
   */
  onSlideshowIntervalChange(e) {
    const interval = parseInt(e.detail.value)
    this.setData({ slideshowInterval: interval })
    this.sendSlideshowConfig(this.data.slideshowEnabled, interval)
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  },

  /**
   * 分析颜色统计
   */
  analyzeColorStats(colorCodes) {
    const stats = {}
    const colorNames = {
      0x00: { name: '黑色', color: '#000000' },
      0xFF: { name: '白色', color: '#FFFFFF' },
      0xFC: { name: '黄色', color: '#FFFF00' },
      0xE0: { name: '红色', color: '#FF0000' },
      0x03: { name: '蓝色', color: '#0000FF' },
      0x1C: { name: '绿色', color: '#00FF00' }
    }

    for (let y = 0; y < colorCodes.length; y++) {
      for (let x = 0; x < (colorCodes[y]?.length ?? 0); x++) {
        const code = colorCodes[y][x]
        stats[code] = (stats[code] || 0) + 1
      }
    }

    const total = colorCodes.length * (colorCodes[0]?.length ?? 1)
    return Object.entries(stats).map(([code, count]) => ({
      code: parseInt(code),
      ...colorNames[code],
      count,
      percent: (count / total * 100).toFixed(1)
    })).sort((a, b) => b.count - a.count)
  }
})
