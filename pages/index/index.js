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
    cropHeight: 480 // 裁剪高度
  },

  onLoad() {
    this.checkBluetooth()
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
            if (completedCount === res.services.length) {
              this.setData({ services })
            }
          })
        })
      },
      fail: (err) => console.error('获取服务失败', err)
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
        this.setData({
          imageSrc: res.tempFiles[0].tempFilePath,
          processedSrc: '',
          processedBinary: null,
          colorStats: []
        })
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
  async processImage() {
    if (!this.data.imageSrc) return

    this.setData({ processing: true })

    try {
      // 获取图片信息
      const imgInfo = await new Promise((resolve, reject) => {
        wx.getImageInfo({
          src: this.data.imageSrc,
          success: resolve,
          fail: reject
        })
      })

      // 计算尺寸
      const maxSize = 800
      let width = imgInfo.width
      let height = imgInfo.height
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height)
        width = Math.floor(width * ratio)
        height = Math.floor(height * ratio)
      }

      // 创建离屏 canvas
      const canvas = wx.createOffscreenCanvas({
        type: '2d',
        width,
        height
      })
      const ctx = canvas.getContext('2d')

      // 绘制图片
      const img = canvas.createImage()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = this.data.imageSrc
      })
      ctx.drawImage(img, 0, 0, width, height)

      // 获取图像数据
      const imageData = ctx.getImageData(0, 0, width, height)
      const originalData = imageData.data

      // 应用抖动算法 - 返回的是处理后的数据对象
      const processedData = processImageData(imageData, {
        dither: this.data.selectedAlgo,
        ...this.data.enhanceParams
      })

      // 生成二进制数据
      const colorCodes = convertToEPD(imageData, {
        dither: this.data.selectedAlgo,
        ...this.data.enhanceParams
      })
      const binary = colorCodesToBinary(colorCodes)

      // 统计颜色使用情况
      const colorStats = this.analyzeColorStats(colorCodes)

      // 直接修改原 imageData 的数据（复用同一个对象）
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = processedData.data[i]
      }

      // 绘制结果
      ctx.putImageData(imageData, 0, 0)

      // 导出图片
      const processedSrc = canvas.toDataURL()

      this.setData({
        processedSrc,
        processedBinary: Array.from(binary), // 转为数组便于后续处理
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
   * 发送到设备
   */
  sendToDevice() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!this.data.processedBinary) {
      wx.showToast({ title: '请先处理图片', icon: 'none' })
      return
    }

    // TODO: 根据实际设备的特征值发送数据
    wx.showModal({
      title: '发送数据',
      content: `数据大小: ${this.data.processedBinary.length} 字节`,
      success: (res) => {
        if (res.confirm) {
          // 这里需要根据实际设备的 serviceId 和 characteristicId 来发送
          console.log('发送二进制数据:', this.data.processedBinary)
          wx.showToast({ title: '数据已准备发送', icon: 'none' })
        }
      }
    })
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
  },

  /**
   * 发送到设备
   */
  sendToDevice() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!this.data.processedBinary) {
      wx.showToast({ title: '请先处理图片', icon: 'none' })
      return
    }

    // TODO: 根据实际设备的特征值发送数据
    wx.showModal({
      title: '发送数据',
      content: `数据大小: ${this.data.processedBinary.length} 字节`,
      success: (res) => {
        if (res.confirm) {
          // 这里需要根据实际设备的 serviceId 和 characteristicId 来发送
          console.log('发送二进制数据:', this.data.processedBinary)
          wx.showToast({ title: '数据已准备发送', icon: 'none' })
        }
      }
    })
  }
})
