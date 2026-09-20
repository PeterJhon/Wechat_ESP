// pages/index/index.js
import { convertToEPD, colorCodesToBinary, colorCodesToImageData } from '../../utils/epd-converter.js'
import { PANEL_PROFILES, DEFAULT_PANEL_TAG, parsePanel, cropOptionsFor, panelBytes } from '../../utils/panel.js'
import { packToWire } from '../../utils/epd-wire.js'

// 扫描时只认广播名带这个前缀的设备（固件用 BLE_DEVICE_NAME = "EINK-xxxx"）
const DEVICE_NAME_PREFIX = 'EINK-'
// 名字没解析出来时的兜底：墨水屏服务的 16 位 UUID 是 0xABF0
const BLE_SERVICE_HINT = 'ABF0'

// 图片身份就是文件名 stem：YYYYMMDD-HHMMSS-NNN，19 字符。
// 设备没有时钟，所以时间必须由手机提供；定宽格式让字典序等于时间序。
const STEM_LENGTH = 19
const STEM_FIELD = 20          // 线上定长字段：stem + NUL

// 旁挂预览图（与设备端 BLE_PREVIEW_* 约定一致）
const PREVIEW_QUALITY = 0.75
const PREVIEW_WIDTH = 400
// 设备每个读回请求最多回 4 × 194 字节数据
const PREVIEW_CHUNK_REQUEST = 776
const PREVIEW_REPLY_TIMEOUT_MS = 3000
// 0x10 列表应答：头 5 字节 + 每条记录 stem:20 + bin_size:u32 + preview_size:u32
const FILE_LIST_HEADER_SIZE = 5
const FILE_LIST_RECORD_SIZE = STEM_FIELD + 8
const FILE_LIST_TIMEOUT_MS = 4000
// 列表窗口化：一次只渲染这么多行，滚到底再追加
const FILE_WINDOW_STEP = 50
// 翻页上限，防止设备异常时无限请求
const MAX_LIST_PAGES = 200
// 单页记录数上限：设备每页最多 16 条，超过说明头部被解析成了垃圾
const MAX_LIST_RECORDS = 1024
const THUMB_PREFIX = 'thumb_'
// 缩略图批量合并 setData 的条数
const THUMB_BATCH_SIZE = 10
// 轮播设置：合并短时间内的多次改动，并在设备报忙时重试
const SLIDESHOW_DEBOUNCE_MS = 400
const SLIDESHOW_RETRY_MS = 500
const SLIDESHOW_MAX_RETRIES = 3
// 实时预览：缩小到这个宽度跑抖动，拖动滑杆时才有几十毫秒的反馈。
// 这是绝对宽度，面板越大占整图的比例越小（800 上约 1/11，1200 上约 1/25），
// 而抖动是尺度相关的，所以预览与最终结果不会逐像素一致 —— 参数定下来后
// 由 scheduleSharpPreview 自动补一版全分辨率把它收敛回来。
const PREVIEW_DITHER_WIDTH = 240
// 松手后隔多久补全分辨率。太短会在连续点按时反复排队，太长则松手后
// 要干等一截预览才变清晰。
const SHARP_PREVIEW_DEBOUNCE_MS = 260
// 连续渲染之间的最小间隔，避免拖动时把 JS 线程占满
const LIVE_PREVIEW_INTERVAL_MS = 120
const MAX_PREVIEW_STEPS = 500
const MAX_PREVIEW_BUSY_RETRIES = 40

// 每个数据块之后的间隔。设备侧已把 SD 写从 BLE 接收路径上摘下来
// （环形缓冲 + 独立写卡任务），射频不再需要被压着走，所以这里是 0。
// 真机若出现丢包（FILE_END 报字节数不足），先把它调回 10 试。
const SEND_CHUNK_DELAY_MS = 0
// 选图被限流（status=2）后的重试间隔。设备侧的窗口是 1 秒，取略大一点。
const SELECT_RETRY_MS = 1100

Page({
  data: {
    // 蓝牙相关
    bluetoothReady: false,
    searching: false,
    devices: [],
    connected: false,
    currentDeviceId: '',
    adapterAvailable: false,

    // 标签页
    currentTab: 0,

    // 图片处理相关
    imageSrc: '',
    processedSrc: '',
    processing: false,
    // 正在补全分辨率：预览此刻还是缩小图，界面上要说一声
    sharpening: false,
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
    // 面板参数在连接后由广播名里的标识确定，这里先铺默认值
    panelTag: DEFAULT_PANEL_TAG,
    panelLabel: PANEL_PROFILES[DEFAULT_PANEL_TAG].label,
    cropOptions: cropOptionsFor(PANEL_PROFILES[DEFAULT_PANEL_TAG]),
    cropWidth: PANEL_PROFILES[DEFAULT_PANEL_TAG].width,
    cropHeight: PANEL_PROFILES[DEFAULT_PANEL_TAG].height,

    // BLE 文件传输
    writeServiceId: '',       // 0xABF0 服务 ID
    writeCharacteristicId: '', // 0xABF1 特征值 ID
    notifyEnabled: false,
    mtu: 20,                  // 协商后的 MTU（默认20）
    sending: false,
    sendProgress: 0,

    // 文件管理。完整列表放在 this._allFiles（不属于视图数据），
    // data 里只放当前渲染的窗口：上千条一次性推进视图层会产生上千个
    // 节点，而 scroll-view 不做回收。
    visibleFiles: [],         // {stem, label, size, previewSize, thumb}
    renderedCount: 0,
    fileTotal: 0,
    loadingFiles: false,

    // 轮播设置。间隔同时是设备的休眠间隔，所以给档位而不是线性滑杆：
    // 这个值直接决定续航，跨三个数量级的滑杆不好用。
    slideshowEnabled: false,
    slideshowInterval: 30,
    slideshowLabel: '30 秒',
    intervalPresets: [
      { label: '10 秒', seconds: 10 },
      { label: '30 秒', seconds: 30 },
      { label: '1 分', seconds: 60 },
      { label: '5 分', seconds: 300 },
      { label: '15 分', seconds: 900 },
      { label: '30 分', seconds: 1800 },
      { label: '1 小时', seconds: 3600 }
    ]
  },

  onLoad() {
    this._panel = parsePanel('')
    this.checkBluetooth()
    this._lastImageSrc = ''
  },

  /** 连接上以后按设备广播名确定面板，并让裁剪选项跟着变。 */
  applyPanelFromName(name) {
    const panel = parsePanel(name)
    const first = cropOptionsFor(panel)[0]
    this._panel = panel
    this.setData({
      panelTag: panel.tag,
      panelLabel: panel.label,
      cropOptions: cropOptionsFor(panel),
      cropWidth: first.w,
      cropHeight: first.h
    })
    console.log('面板：' + panel.label + '（标识 ' + panel.tag +
                '），图像 ' + (panel.width * panel.height) + ' 字节')
  },

  onShow() {
    // Coming back from crop page: image may have been replaced
    if (this.data.imageSrc && this.data.imageSrc !== this._lastImageSrc) {
      this._rawPixels = null
      this._rasterCanvas = null
      this._renderKey = null
      // the source changed, so any processed result and its preview are stale
      this.processedBinary = null
      this._previewBuffer = null
      this._finalColorCodes = null
      this._lastImageSrc = this.data.imageSrc
      this.rasterizeSource(this.data.imageSrc)
    }
  },

  onUnload() {
    if (this._sharpTimer) {
      clearTimeout(this._sharpTimer)
      this._sharpTimer = null
    }
    this.closeBluetooth()
  },

  /**
   * 切换标签页
   */
  switchTab(e) {
    const currentTab = parseInt(e.currentTarget.dataset.index)
    this.setData({ currentTab })
    // 切到处理页时补一版预览：换过图但还没出过结果的话，这里补上
    if (currentTab === 1 && this.data.imageSrc && !this.data.processedSrc) {
      this.scheduleLivePreview()
    }
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
    // 只注册一次：在连接/搜索流程里重复注册会让同一条通知被投递多次
    if (this._adapterStateListenerRegistered) return
    this._adapterStateListenerRegistered = true
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
    if (this._deviceFoundListenerRegistered) return
    this._deviceFoundListenerRegistered = true
    wx.onBluetoothDeviceFound((res) => {
      const newDevices = res.devices
        .filter(device => this.isTargetDevice(device))
        .map(device => {
          let name = device.name || device.localName || ''

          if (!name && device.advertisData) {
            const adv = device.advertisData
            name = adv.localName || adv.kCBAdvDataLocalName || adv.deviceName || ''
          }
          if (!name) {
            const id = device.deviceId || ''
            name = DEVICE_NAME_PREFIX + id.substring(id.length - 4, id.length)
          }

          return {
            deviceId: device.deviceId,
            name: name,
            RSSI: device.RSSI,
            signal: this.signalLevel(device.RSSI)
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
        this.applyPanelFromName(device.name)
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
    if (this._connStateListenerRegistered) return
    this._connStateListenerRegistered = true
    wx.onBLEConnectionStateChange((res) => {
      if (!res.connected) {
        this.resetSessionState()
        this.setData({
          connected: false,
          currentDeviceId: '',
        })
        wx.showToast({ title: '连接已断开', icon: 'none' })
      }
    })
  },

  /* Service discovery is only here to locate the write characteristic — the
   * full list is not something the UI needs. */
  getServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: (res) => {
        console.log('获取服务成功', res)
        let completedCount = 0
        const totalServices = res.services.length

        res.services.forEach((service) => {
          this.getCharacteristics(deviceId, service.uuid, (charResult) => {
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

        // 只注册一次：重复注册会让同一条通知被投递 N 次，文件列表分片
        // 会被重复追加而解析错乱（列表超过 19 张时就会跨多个通知）。
        if (this._notifyListenerRegistered) return
        this._notifyListenerRegistered = true

        wx.onBLECharacteristicValueChange((res) => {
          const buf = new Uint8Array(res.value)

          // 预览读回分片（0x15）。必须同时确认确实有读回在等待：只看首字节
          // 会把首字节恰好是 0x15 的列表分片当成预览分片丢掉，列表越长分片
          // 越多越容易撞上，最后表现为列表超时。
          if (this._previewPending && buf.length >= 6 && buf[0] === 0x15) {
            this.handlePreviewReply(buf)
            return
          }

          // 设备报告列表不完整（0x10 的 ACK 高四位被截断为 0，失败时低字节为 1）
          if (this._fileListBuffer && buf.length === 2 && buf[0] === 0xFF && buf[1] === 0x01) {
            this.abortFileList('设备报告文件列表不完整')
            return
          }

          // 列表会话进行中：后续分片是裸载荷，首字节可能是任意值，
          // 不能再要求它以 0x10 开头，否则除首片外全部被丢弃。
          if (this._fileListBuffer) {
            this.appendFileList(buf)
            return
          }

          if (buf.length >= 2 && buf[0] === 0xFF) {
            const ackCmd = (buf[1] >> 4) & 0x0F
            const status = buf[1] & 0x0F
            console.log('ACK: cmd=' + ackCmd + ' status=' + status)

            const waiter = this._ackWaiters ? this._ackWaiters[ackCmd] : null
            if (waiter) {
              clearTimeout(waiter.timer)
              delete this._ackWaiters[ackCmd]
              waiter.resolve({
                responded: true,
                ok: status === 0,
                status,
                // FILE_START 的应答带设备最终采用的名字
                stem: ackCmd === 0x01 && buf.length >= 2 + STEM_FIELD
                  ? this.readStemField(buf, 2)
                  : ''
              })
            }
          }

          // 文件列表（0x10）：首片开启一个会话
          if (buf.length >= 2 && buf[0] === 0x10) {
            this.beginFileList(buf)
            return
          }

          // 轮播状态（0x14）
          if (buf.length >= 4 && buf[0] === 0x14) {
            const enabled = buf[1] !== 0
            const interval = buf[2] | (buf[3] << 8)
            console.log('轮播状态: enabled=' + enabled + ' interval=' + interval)
            this.setData({
              slideshowEnabled: enabled,
              slideshowInterval: interval,
              slideshowLabel: this.formatInterval(interval)
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

  getCharacteristics(deviceId, serviceId, callback) {
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
        this.resetSessionState()
        this.setData({
          connected: false,
          currentDeviceId: '',
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
        this._previewBuffer = null
        this._finalColorCodes = null
        this._lastImageSrc = imagePath
        // invalidate the cached raster and the rendered result for a new image
        this._rawPixels = null
        this._rasterCanvas = null
        this._renderKey = null
        this.setData({
          imageSrc: imagePath,
          processedSrc: ''
        })
        // 预先栅格化，参数变化时可直接出预览，不必重新读图
        this.rasterizeSource(imagePath)
      }
    })
  },

  /**
   * 选择裁剪尺寸
   */
  selectCropSize(e) {
    this.setData({
      cropWidth: parseInt(e.currentTarget.dataset.w),
      cropHeight: parseInt(e.currentTarget.dataset.h)
    })
  },

  /**
   * 裁剪图片
   */
  cropImage() {
    wx.navigateTo({
      url: `/pages/crop/crop?imagePath=${encodeURIComponent(this.data.imageSrc)}` +
           `&cropWidth=${this.data.cropWidth}&cropHeight=${this.data.cropHeight}` +
           `&panelW=${this._panel.width}&panelH=${this._panel.height}`
    })
  },

  /**
   * 选择抖动算法
   */
  selectAlgo(e) {
    this.setData({
      selectedAlgo: e.currentTarget.dataset.id
    })
    this.scheduleLivePreview()
    this.scheduleSharpPreview()
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
    this.scheduleLivePreview()
    // 拖动中只跑缩小图；手指离开滑杆那次（bindchange，e.type 不是 changing）
    // 参数才算定下来，这时补一版全分辨率，预览会自己变清晰。
    if (e.type !== 'changing') {
      this.scheduleSharpPreview()
    }
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
    this.scheduleLivePreview()
    this.scheduleSharpPreview()
    wx.showToast({ title: '参数已重置', icon: 'none' })
  },

  /**
   * 处理图片
   */
  /**
   * 把任意源图栅格化成当前面板要求的尺寸。
   *
   * 设备只接受恰好一个栅格的整图（800×480 是 384000 字节，1200×1600 是
   * 1920000 字节），而源图什么比例都有：只按长边缩放会让 16:9 的照片停在
   * 800×450（360000 字节），设备直接拒收且不刷新。这里按目标比例居中裁切
   * 再缩放，栅格与文件布局不符时随后会被转置，字节数因此始终不变。
   */
  async rasterizeToPanel(imagePath) {
    const imgInfo = await new Promise((resolve, reject) => {
      wx.getImageInfo({ src: imagePath, success: resolve, fail: reject })
    })

    /* 面板的两种合法栅格是 宽×高（文件布局）与 高×宽。这里取与源图方向一致
     * 的那一个；方向若与文件布局不符，由后面的转置环节负责摆正。 */
    const panel = this._panel
    const fileIsLandscape = panel.width > panel.height
    const sourceIsPortrait = imgInfo.height > imgInfo.width
    const useRotated = sourceIsPortrait === fileIsLandscape
    const targetWidth = useRotated ? panel.height : panel.width
    const targetHeight = useRotated ? panel.width : panel.height

    const targetAspect = targetWidth / targetHeight
    const sourceAspect = imgInfo.width / imgInfo.height

    let cropWidth = imgInfo.width
    let cropHeight = imgInfo.height
    if (sourceAspect > targetAspect) {
      // 源图更宽：裁掉左右
      cropWidth = Math.round(imgInfo.height * targetAspect)
    } else if (sourceAspect < targetAspect) {
      // 源图更高：裁掉上下
      cropHeight = Math.round(imgInfo.width / targetAspect)
    }
    const cropX = Math.floor((imgInfo.width - cropWidth) / 2)
    const cropY = Math.floor((imgInfo.height - cropHeight) / 2)

    const canvas = wx.createOffscreenCanvas({
      type: '2d', width: targetWidth, height: targetHeight
    })
    const ctx = canvas.getContext('2d')
    const img = canvas.createImage()

    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = imagePath
    })

    // 源图可能带透明像素（裁剪页缩放后会留白），先铺白底：
    // 透明区域取出来是 RGB(0,0,0)，抖动后会变成黑块。
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
    ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight,
                  0, 0, targetWidth, targetHeight)

    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight)
    return {
      pixels: new Uint8ClampedArray(imageData.data),
      width: targetWidth,
      height: targetHeight,
      // 缩小预览要拿它当 drawImage 的源，所以一并带出去缓存
      canvas: canvas
    }
  },

  /**
   * 栅格化原始图片，缓存像素数据，后续换算法无需重新加载图片
   */
  async rasterizeSource(imagePath) {
    try {
      const raster = await this.rasterizeToPanel(imagePath)
      this._rawPixels = raster.pixels
      this._rawWidth = raster.width
      this._rawHeight = raster.height
      this._rasterCanvas = raster.canvas
      this._renderKey = null
      console.log('Source rasterized to panel size: ' + raster.width + 'x' + raster.height)
      // 选完图立刻给一版实时预览，不用再点按钮
      this.scheduleLivePreview()
      this.scheduleSharpPreview()
    } catch (e) {
      console.error('Rasterize failed:', e)
      this._rawPixels = null
    }
  },

  /**
   * 处理图片
   */
  /**
   * 取（并缓存）归一成面板尺寸后的像素与画布
   */
  async ensureRaster() {
    if (this._rawPixels && this._rawWidth && this._rawHeight && this._rasterCanvas) {
      return {
        pixels: this._rawPixels,
        width: this._rawWidth,
        height: this._rawHeight,
        canvas: this._rasterCanvas
      }
    }
    try {
      const raster = await this.rasterizeToPanel(this.data.imageSrc)
      this._rawPixels = raster.pixels
      this._rawWidth = raster.width
      this._rawHeight = raster.height
      this._rasterCanvas = raster.canvas
      this._renderKey = null
      return raster
    } catch (e) {
      console.error('栅格化失败:', e)
      return null
    }
  },

  /**
   * 按当前算法与参数渲染。
   *
   * fullScale=false 时在缩小图上跑抖动，供滑杆拖动时实时预览：整图是
   * 1920000 像素（1200 面板）的逐点运算，要一两秒，挂在 bindchanging 上
   * 跟不上；缩小图几十毫秒就够。代价是抖动与尺度相关，预览和最终结果不会
   * 逐像素一致 —— 所以松手后由 scheduleSharpPreview 自动补一版全分辨率，
   * 发给设备的也仍以那一次为准。
   */
  async renderDither(fullScale) {
    if (!this.data.imageSrc) return false

    const raster = await this.ensureRaster()
    if (!raster) return false

    const params = this.data.enhanceParams
    const key = [this.data.imageSrc, this.data.selectedAlgo, params.brightness,
                 params.contrast, params.saturation, params.gamma,
                 fullScale ? 'full' : 'preview'].join('|')
    if (key === this._renderKey) return true

    let imageData
    let renderWidth, renderHeight

    if (fullScale) {
      renderWidth = raster.width
      renderHeight = raster.height
      const canvas = wx.createOffscreenCanvas({
        type: '2d', width: renderWidth, height: renderHeight
      })
      const ctx = canvas.getContext('2d')
      imageData = ctx.createImageData(renderWidth, renderHeight)
      imageData.data.set(raster.pixels)
    } else {
      const scale = PREVIEW_DITHER_WIDTH / raster.width
      renderWidth = Math.max(8, Math.round(raster.width * scale))
      renderHeight = Math.max(8, Math.round(raster.height * scale))
      const small = wx.createOffscreenCanvas({
        type: '2d', width: renderWidth, height: renderHeight
      })
      const smallCtx = small.getContext('2d')
      smallCtx.drawImage(raster.canvas, 0, 0, renderWidth, renderHeight)
      imageData = smallCtx.getImageData(0, 0, renderWidth, renderHeight)
    }

    const colorCodes = convertToEPD(imageData, {
      dither: this.data.selectedAlgo,
      ...params
    })
    const processedData = colorCodesToImageData(colorCodes, renderWidth, renderHeight)

    // 栅格方向与文件布局不一致时转置。800×480 的文件是横的（竖图要转），
    // 1200×1600 的文件是竖的（横图反而要转）—— 所以不能只判"是不是竖图"。
    const fileIsLandscape = this._panel.width > this._panel.height
    const rasterIsLandscape = (colorCodes[0] || []).length > colorCodes.length

    let finalColorCodes = colorCodes
    if (rasterIsLandscape !== fileIsLandscape) {
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
    }

    // 画出来。processedSrc 用的是转置**前**的 codes —— 竖屏图要按用户
    // 看到的方向显示；转置只影响发给设备的字节。
    const out = wx.createOffscreenCanvas({
      type: '2d', width: renderWidth, height: renderHeight
    })
    const outCtx = out.getContext('2d')
    const outImage = outCtx.createImageData(renderWidth, renderHeight)
    outImage.data.set(processedData.data)
    outCtx.putImageData(outImage, 0, 0)
    const processedSrc = out.toDataURL()

    this._renderKey = key

    const patch = { processedSrc }
    if (fullScale) {
      // 只有全分辨率那次才产生可发送的数据与侧车预览的来源
      this.processedBinary = colorCodesToBinary(finalColorCodes)
      this._finalColorCodes = finalColorCodes
      this._previewBuffer = null
      patch.processing = false
      console.log('已按全分辨率渲染: ' + renderWidth + 'x' + renderHeight)
    }
    this.setData(patch)
    return true
  },

  /** 合并连续的参数改动：正在渲染时只记一个标记，渲染完再补一次。 */
  scheduleLivePreview() {
    if (!this.data.imageSrc) return
    if (this._liveBusy) {
      this._livePending = true
      return
    }
    this._liveBusy = true
    this.runLivePreview()
  },

  async runLivePreview() {
    this._livePending = false
    try {
      await this.renderDither(false)
    } catch (e) {
      console.error('实时预览失败:', e)
    }
    this._liveBusy = false
    if (this._livePending) {
      setTimeout(() => this.runLivePreview(), LIVE_PREVIEW_INTERVAL_MS)
    } else if (this._sharpAfterLive) {
      // 精确预览刚才让过路，实时预览停了就补上
      this._sharpAfterLive = false
      this.runSharpPreview()
    }
  },

  /**
   * 参数定下来后补一版全分辨率渲染。
   *
   * 拖动中跑的是缩小图抖动（见 PREVIEW_DITHER_WIDTH），与整图结果不会逐像素
   * 一致，面板越大差得越多。这里在松手后自动收敛到真正会发出去的样子，
   * 不必先点一次上传才知道效果。
   */
  scheduleSharpPreview() {
    if (!this.data.imageSrc) return
    if (this._sharpTimer) clearTimeout(this._sharpTimer)
    this._sharpTimer = setTimeout(() => {
      this._sharpTimer = null
      this.runSharpPreview()
    }, SHARP_PREVIEW_DEBOUNCE_MS)
  },

  async runSharpPreview() {
    // 实时预览在跑就让路，它收尾时会回来叫（见 runLivePreview）
    if (this._liveBusy) {
      this._sharpAfterLive = true
      return
    }
    this._sharpAfterLive = false
    this.setData({ sharpening: true })
    try {
      await this.renderDither(true)
    } catch (e) {
      console.error('精确预览失败:', e)
    } finally {
      this.setData({ sharpening: false })
    }
  },

  /**
   * 发送/保存前确保已按当前参数做过全分辨率渲染。
   * 实时预览是缩小图，不能拿去发送。
   */
  async ensureFullResolution() {
    this.setData({ processing: true })
    wx.showLoading({ title: '渲染中…', mask: true })
    try {
      return await this.renderDither(true)
    } finally {
      wx.hideLoading()
      this.setData({ processing: false })
    }
  },

  /**
   * 生成 400×240 的旁挂预览 JPEG。
   * 设备端没有 JPEG 编码器，图像必须在手机侧产出。
   * 渲染源是转置后的 finalColorCodes，因此和墨水屏实际显示的画面一致。
   */
  async buildPreviewJpeg() {
    if (this._previewBuffer) return this._previewBuffer

    const codes = this._finalColorCodes
    if (!codes || !codes.length || !codes[0] || !codes[0].length) return null

    const height = codes.length
    const width = codes[0].length

    const source = wx.createOffscreenCanvas({ type: '2d', width, height })
    const sourceCtx = source.getContext('2d')
    const imageData = sourceCtx.createImageData(width, height)
    imageData.data.set(colorCodesToImageData(codes, width, height).data)
    sourceCtx.putImageData(imageData, 0, 0)

    const previewHeight = Math.max(1, Math.round(height * PREVIEW_WIDTH / width))
    let dataUrl = null
    try {
      const scaled = wx.createOffscreenCanvas({
        type: '2d', width: PREVIEW_WIDTH, height: previewHeight
      })
      const scaledCtx = scaled.getContext('2d')
      scaledCtx.drawImage(source, 0, 0, PREVIEW_WIDTH, previewHeight)
      dataUrl = scaled.toDataURL('image/jpeg', PREVIEW_QUALITY)
    } catch (e) {
      // 降采样失败就退回全尺寸编码：设备端上限 128KB，仍能接受
      console.warn('预览降采样失败，改用全尺寸:', e)
      dataUrl = source.toDataURL('image/jpeg', PREVIEW_QUALITY)
    }

    const base64 = (dataUrl || '').split(',')[1]
    if (!base64) return null

    this._previewBuffer = wx.base64ToArrayBuffer(base64)
    console.log('预览图生成: ' + (this._previewBuffer.byteLength / 1024).toFixed(1) + 'KB')
    return this._previewBuffer
  },

  /**
   * 保存图片
   */
  async saveImage() {
    if (!this.data.imageSrc) return

    if (!await this.ensureFullResolution()) {
      wx.showToast({ title: '渲染失败，无法保存', icon: 'none' })
      return
    }

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
  async sendToDevice() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!this.data.imageSrc) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
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

    // 界面上的只是缩小预览，发送前必须按当前参数重跑一次全分辨率
    if (!await this.ensureFullResolution() || !this.processedBinary) {
      wx.showToast({ title: '渲染失败，无法发送', icon: 'none' })
      return
    }

    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    const binary = new Uint8Array(this.processedBinary)
    // 设备没有时钟，名字里的时间只能由手机提供；这个名字同时就是设备上的
    // 文件名和后续删除/选择/预览的身份
    const stem = this.makeStem()

    // 设备会静默丢弃尺寸不符的整张图，只回一个非零 FILE_END 状态，
    // 所以在这里就拦住，别让用户白等一整轮传输。
    const panel = this._panel
    const expectedBytes = panelBytes(panel)
    if (binary.length !== expectedBytes) {
      wx.showModal({
        title: '图片尺寸不对',
        content: '处理结果是 ' + binary.length + ' 字节，该面板只接受 ' +
                 expectedBytes + ' 字节（' + panel.width + '×' +
                 panel.height + '）。请重新处理图片。',
        showCancel: false
      })
      return
    }

    /* 线上走 3 bit/像素：1,920,000 → 720,000。设备侧解包后再落盘，
     * 所以上面按 panelBytes() 校验的是磁盘格式、这里换的是线上格式，别混。
     * 这一份同时把传输量砍到 1/2.67，是除了解耦之外最大的一笔。 */
    const wire = packToWire(binary)

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

    // 主图和预览图共用同一套 DATA/END 流程
    const streamBody = async (bytes, label, reportProgress, requireEndAck) => {
      let offset = 0
      const total = bytes.length
      let lastProgress = -1
      // 提到循环外：为 0 时连 Promise/setTimeout 都不必创建
      const chunkDelay = SEND_CHUNK_DELAY_MS
      console.log(label + ': 开始发送数据, 总包数:', Math.ceil(total / CHUNK_DATA_SIZE))

      while (offset < total) {
        const remaining = total - offset
        const dataSize = Math.min(CHUNK_DATA_SIZE, remaining)
        const packet = new Uint8Array(1 + dataSize)
        packet[0] = 0x02  // CMD_FILE_DATA
        packet.set(bytes.subarray(offset, offset + dataSize), 1)
        await writeChar(packet)
        if (chunkDelay > 0) {
          await this.sleep(chunkDelay)
        }

        offset += dataSize
        if (reportProgress) {
          const progress = Math.floor(offset / total * 100)
          // 只在进度变化时更新 UI（减少开销）
          if (progress !== lastProgress) {
            lastProgress = progress
            this.setData({ sendProgress: progress })
            console.log(progress + '%', '(' + offset + '/' + total + ')')
          }
        }
      }

      // CMD_FILE_END —— 必须等应答。设备只有在收满 384000 字节后才会回
      // status=0；不等应答的话，丢包造成的失败和小程序报的“发送完成”
      // 完全无法区分，用户只会看到屏幕不动。
      console.log(label + ': 发送 CMD_FILE_END')
      const endAckPromise = this.waitForFileEndAck()
      await writeChar(new Uint8Array([0x03]))
      const endAck = await endAckPromise

      if (!endAck.responded) {
        console.warn(label + ': 未收到 FILE_END 应答')
      } else if (!endAck.ok) {
        const reason = label + '被设备拒收（状态 ' + endAck.status +
                       '）：通常是传输中途丢包，设备收到的字节数不足'
        if (requireEndAck) {
          throw new Error(reason)
        }
        // 预览图失败不该否定已经成功的主图
        console.warn(reason)
      }
      await this.sleep(300)
    }

    const sendWithProtocol = async () => {
      try {
        console.log('=== 开始传输 ===')
        console.log('MTU:', this.data.mtu, '每包数据:', CHUNK_DATA_SIZE, 'B')
        console.log('文件名:', stem + '.bin', '数据大小:', binary.length, '字节')

        // 先产出预览图，避免上传期间用户换图导致预览与主图不一致
        let previewBuffer = null
        try {
          previewBuffer = await this.buildPreviewJpeg()
        } catch (e) {
          console.warn('预览图生成失败，仅上传主图:', e)
        }

        // Step 1: CMD_FILE_START —— 载荷是 name_len:u8 + 名字
        const nameBytes = strToBytes(stem)
        const startPacket = new Uint8Array(2 + nameBytes.length)
        startPacket[0] = 0x01  // CMD_FILE_START
        startPacket[1] = nameBytes.length
        startPacket.set(nameBytes, 2)
        console.log('发送 CMD_FILE_START (' + startPacket.length + 'B)')

        const ackPromise = this.waitForFileStartAck()
        await writeChar(startPacket)

        const ack = await ackPromise
        if (ack.responded && !ack.ok) {
          // 状态 2 通常是重名，换一个序号再试
          throw new Error(ack.status === 2
            ? '设备上已有同名图片，请稍后重试'
            : '设备拒绝接收该图片（状态 ' + ack.status + '）')
        }
        // 设备回带它实际采用的名字；无应答说明对端是旧固件
        const storedStem = ack.stem || ''
        console.log('设备已接受: ' + (storedStem || stem) +
                    (ack.responded ? '' : '（无应答，按旧固件处理）'))

        // Step 2: CMD_FILE_DATA + CMD_FILE_END
        await streamBody(wire, '主图', true, true)

        // Step 3: 旁挂预览图（CMD_PREVIEW_START = 0x16）
        if (storedStem && previewBuffer) {
          const previewStart = new Uint8Array(1 + STEM_FIELD)
          previewStart[0] = 0x16
          previewStart.set(this.writeStemField(storedStem), 1)
          await writeChar(previewStart)
          await this.sleep(200)
          await streamBody(new Uint8Array(previewBuffer), '预览图', false, false)
          console.log('预览图已上传: ' + storedStem +
                      ' (' + previewBuffer.byteLength + 'B)')
        } else if (!storedStem) {
          console.log('设备未回带图片名，跳过预览上传')
        } else {
          console.log('没有可用的预览图，跳过上传')
        }

        // 列表需要刷新才能看到新图
        setTimeout(() => this.requestFileList(), 300)

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
   * 请求文件列表 (CMD_FILE_LIST = 0x10)，分页拉取到收满为止。
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

    this.clearFileList()
    this._thumbGeneration = (this._thumbGeneration || 0) + 1
    this._allFiles = []
    this._stemIndex = new Map()
    this._listTotal = 0
    this._listPages = 0
    this._listCursor = ''
    this.setData({
      loadingFiles: true,
      visibleFiles: [],
      renderedCount: 0,
      fileTotal: 0
    })

    this.requestFileListPage()
  },

  /**
   * 请求下一页。载荷是"从哪个名字之后开始"的游标，空串表示从头。
   * 用游标而不是页码：上传和删除会让位置整体移动，页码会漏读或重读。
   */
  requestFileListPage() {
    if (++this._listPages > MAX_LIST_PAGES) {
      console.warn('文件列表翻页次数超限，先展示已收到的部分')
      this.finishFileList()
      return
    }

    this.armListTimeout('文件列表第 ' + this._listPages + ' 页')

    const cmd = new Uint8Array(1 + STEM_FIELD)
    cmd[0] = 0x10
    cmd.set(this.writeStemField(this._listCursor), 1)
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    wx.writeBLECharacteristicValue({
      deviceId: this.data.currentDeviceId,
      serviceId: this.data.writeServiceId,
      characteristicId: this.data.writeCharacteristicId,
      value: ab,
      fail: (err) => {
        console.error('FILE_LIST 发送失败:', err)
        this.abortFileList('请求发送失败')
      }
    })
  },

  /**
   * 删除图片 (CMD_FILE_DELETE = 0x11)
   */
  deleteImage(e) {
    const stem = e.currentTarget.dataset.stem
    if (!this.data.connected) return

    wx.showModal({
      title: '确认删除',
      content: '确定要删除 ' + this.stemToLabel(stem) + ' 吗？',
      success: (res) => {
        if (!res.confirm) return

        const cmd = new Uint8Array(1 + STEM_FIELD)
        cmd[0] = 0x11
        cmd.set(this.writeStemField(stem), 1)
        const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

        wx.writeBLECharacteristicValue({
          deviceId: this.data.currentDeviceId,
          serviceId: this.data.writeServiceId,
          characteristicId: this.data.writeCharacteristicId,
          value: ab,
          success: () => {
            console.log('DELETE 请求已发送: ' + stem)
            wx.showToast({ title: '删除中...', icon: 'none' })
            // 只把这一项从本地列表剔除，不再清空整表重新拉取：
            // 那样会把滚动位置和整屏缩略图全部丢掉。
            this.removeFileLocally(stem)
            setTimeout(() => this.requestFileList(), 500)
          },
          fail: (err) => {
            console.error('DELETE 发送失败:', err)
          }
        })
      }
    })
  },

  /** 本地剔除一条，让 UI 立刻反映删除结果。 */
  removeFileLocally(stem) {
    const files = this._allFiles || []
    const index = files.findIndex(f => f.stem === stem)
    if (index < 0) return
    files.splice(index, 1)

    this._stemIndex = new Map()
    files.forEach((file, i) => this._stemIndex.set(file.stem, i))

    this.setData({
      visibleFiles: files.slice(0, this.data.renderedCount),
      fileTotal: files.length
    })
  },

  /**
   * 选择图片显示 (CMD_FILE_SELECT = 0x12)
   */
  selectImage(e) {
    const stem = e.currentTarget.dataset.stem
    if (!this.data.connected) return

    /* 记住最后点的是哪一张：下面的重试只在它仍然是最新选择时才发，
     * 否则一次迟到的重试会把用户后来选的图顶掉。 */
    this._pendingSelect = stem
    this.sendSelect(stem, 0)
  },

  /**
   * 发送 FILE_SELECT，被限流时退避重试。
   *
   * 设备对会写卡的命令有「1 秒内不重复」的限流，超出的直接丢弃并回 status=2。
   * 连续切图时后几次必然撞上它，而 README 约定客户端收到 2 应当退避重试 ——
   * 不重试的话，用户看到的就是"点了没反应"。
   */
  sendSelect(stem, attempt) {
    const MAX_SELECT_ATTEMPTS = 3

    const cmd = new Uint8Array(1 + STEM_FIELD)
    cmd[0] = 0x12
    cmd.set(this.writeStemField(stem), 1)
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    // 等设备的应答：仅凭 BLE 写入成功就报"已发送"，被拒绝时用户
    // 完全看不到反馈。
    const ackPromise = this.waitForAck(0x02, 3000)

    wx.writeBLECharacteristicValue({
      deviceId: this.data.currentDeviceId,
      serviceId: this.data.writeServiceId,
      characteristicId: this.data.writeCharacteristicId,
      value: ab,
      fail: (err) => {
        console.error('SELECT 发送失败:', err)
        wx.showToast({ title: '发送失败', icon: 'none' })
      }
    })

    ackPromise.then((ack) => {
      if (!ack.responded) {
        wx.showToast({ title: '设备未应答', icon: 'none' })
      } else if (!ack.ok) {
        if (ack.status === 2 && attempt < MAX_SELECT_ATTEMPTS &&
            this._pendingSelect === stem) {
          // 被限流丢弃。等过设备那 1 秒窗口再发一次 —— 中途改选别的图就放弃。
          setTimeout(() => {
            if (this._pendingSelect === stem) this.sendSelect(stem, attempt + 1)
          }, SELECT_RETRY_MS)
          return
        }
        wx.showToast({ title: '设备拒绝了显示指令', icon: 'none' })
      } else {
        wx.showToast({ title: '已开始显示', icon: 'success' })
      }
    })
  },

  /**
   * 开始接收一页文件列表应答。
   * 首片进入会话，后续分片由 appendFileList 无条件追加——分片首字节是
   * 任意字节，不能再按 0x10 判断，否则除首片外全被丢弃。
   */
  /**
   * 超时从**发出请求**那一刻开始算，而不是等第一个分片到达。
   * 否则设备对某一页完全不应答时（丢包、忙、重启），既没有分片也就没有
   * 计时器，loadingFiles 会永远停在 true —— 界面看起来就是卡死。
   */
  armListTimeout(reason) {
    if (this._fileListTimer) {
      clearTimeout(this._fileListTimer)
    }
    this._fileListTimer = setTimeout(() => {
      this._fileListTimer = null
      this.abortFileList(reason + '超时（已收到 ' + this._fileListLength + ' 字节）')
    }, FILE_LIST_TIMEOUT_MS)
  },

  resetFileListBuffer() {
    this._fileListBuffer = null
    this._fileListLength = 0
  },

  beginFileList(bytes) {
    // 不动定时器：它是按"发请求"计的，分片到达只是让它继续跑
    this.resetFileListBuffer()

    let capacity = bytes.length
    if (bytes.length >= FILE_LIST_HEADER_SIZE) {
      const count = bytes[3] | (bytes[4] << 8)
      if (count > MAX_LIST_RECORDS) {
        this.abortFileList('设备返回的记录数异常 (' + count + ')')
        return
      }
      capacity = Math.max(FILE_LIST_HEADER_SIZE + count * FILE_LIST_RECORD_SIZE,
                          bytes.length)
    }
    this._fileListBuffer = new Uint8Array(capacity)
    this._fileListBuffer.set(bytes, 0)
    this._fileListLength = bytes.length

    this.tryFinishFileList()
  },

  appendFileList(chunk) {
    if (!this._fileListBuffer) return

    if (this._fileListLength + chunk.length > this._fileListBuffer.length) {
      const grown = new Uint8Array(this._fileListLength + chunk.length)
      grown.set(this._fileListBuffer.subarray(0, this._fileListLength), 0)
      this._fileListBuffer = grown
    }
    this._fileListBuffer.set(chunk, this._fileListLength)
    this._fileListLength += chunk.length
    this.tryFinishFileList()
  },

  tryFinishFileList() {
    const buf = this._fileListBuffer
    if (!buf || this._fileListLength < FILE_LIST_HEADER_SIZE) return

    this._listTotal = buf[1] | (buf[2] << 8)
    const count = buf[3] | (buf[4] << 8)
    const expected = FILE_LIST_HEADER_SIZE + count * FILE_LIST_RECORD_SIZE
    if (this._fileListLength < expected) return

    let lastStem = ''
    try {
      for (let i = 0; i < count; i++) {
        const off = FILE_LIST_HEADER_SIZE + i * FILE_LIST_RECORD_SIZE
        const stem = this.readStemField(buf, off)
        if (!stem) continue
        const rawSize = (buf[off + STEM_FIELD] | (buf[off + STEM_FIELD + 1] << 8) |
                         (buf[off + STEM_FIELD + 2] << 16) |
                         (buf[off + STEM_FIELD + 3] << 24)) >>> 0
        const previewSize = (buf[off + STEM_FIELD + 4] |
                             (buf[off + STEM_FIELD + 5] << 8) |
                             (buf[off + STEM_FIELD + 6] << 16) |
                             (buf[off + STEM_FIELD + 7] << 24)) >>> 0
        lastStem = stem
        this._allFiles.push({
          stem,
          label: this.stemToLabel(stem),
          size: this.formatFileSize(rawSize),
          previewSize,
          thumb: ''
        })
      }
    } catch (e) {
      console.error('文件列表解析异常:', e)
      this.abortFileList('解析失败: ' + (e.message || e))
      return
    }

    console.log('文件列表第 ' + this._listPages + ' 页: total=' + this._listTotal +
                ' count=' + count + ' 已收=' + this._allFiles.length)

    this.resetFileListBuffer()

    // 用最后一条的名字当游标继续翻页：total 每页头部都有，翻到收满为止
    if (count > 0 && lastStem &&
        this._allFiles.length < this._listTotal &&
        this._listPages < MAX_LIST_PAGES) {
      this._listCursor = lastStem
      this.requestFileListPage()
      return
    }

    this.clearFileList()
    this.finishFileList()
  },

  finishFileList() {
    const files = this._allFiles
    console.log('文件列表解析完成: ' + files.length + '/' + this._listTotal + ' 个文件')

    this._stemIndex = new Map()
    files.forEach((file, index) => this._stemIndex.set(file.stem, index))

    const rendered = Math.min(FILE_WINDOW_STEP, files.length)
    this.setData({
      visibleFiles: files.slice(0, rendered),
      renderedCount: rendered,
      fileTotal: files.length,
      loadingFiles: false
    })

    this.pruneThumbnailCache(files)
    this.loadThumbnails(this.data.visibleFiles)
  },

  /**
   * 滚到底时再放出一屏。只渲染窗口内的行：所有行一次性压进视图层会
   * 产生上千个节点，scroll-view 不做回收。
   */
  onFileListScrollToLower() {
    const files = this._allFiles || []
    if (this.data.renderedCount >= files.length) return

    const rendered = Math.min(this.data.renderedCount + FILE_WINDOW_STEP,
                              files.length)
    this.setData({
      visibleFiles: files.slice(0, rendered),
      renderedCount: rendered
    })
    this.loadThumbnails(this.data.visibleFiles)
  },

  abortFileList(reason) {
    console.warn('文件列表接收失败: ' + reason)
    this.clearFileList()
    this.setData({ loadingFiles: false })
    wx.showToast({ title: '文件列表读取失败', icon: 'none' })
  },

  clearFileList() {
    if (this._fileListTimer) {
      clearTimeout(this._fileListTimer)
      this._fileListTimer = null
    }
    this._fileListBuffer = null
    this._fileListLength = 0
  },

  /**
   * 断连时清掉进行中的会话状态，避免把上一次连接的进度带过来。
   * 保留 processedBinary / _finalColorCodes：处理好的图不属于会话状态，
   * 重新连接后应该还能直接发送。
   */
  resetSessionState() {
    this.clearFileList()
    this._previewPending = null
    this._previewProgress = 0
    this._ackWaiters = {}
    this._thumbGeneration = (this._thumbGeneration || 0) + 1
    if (this.data.loadingFiles || this.data.sending) {
      this.setData({ loadingFiles: false, sending: false })
    }
  },

  /**
   * 缩略图缓存键就是文件名：stem 全局唯一且不会被复用，
   * 所以不需要再靠字节数之类的近似辨析符。
   */
  thumbPath(stem) {
    return `${wx.env.USER_DATA_PATH}/${THUMB_PREFIX}${stem}.jpg`
  },

  /**
   * 清掉不再被列表引用的缓存文件（图片被删除，或换了新预览）。
   */
  pruneThumbnailCache(files) {
    const keep = new Set(
      files.filter(f => f.previewSize > 0).map(f => this.thumbPath(f.stem))
    )
    wx.getFileSystemManager().readdir({
      dirPath: wx.env.USER_DATA_PATH,
      success: (res) => {
        res.files
          .filter(name => name.startsWith(THUMB_PREFIX) && name.endsWith('.jpg'))
          .forEach(name => {
            const full = `${wx.env.USER_DATA_PATH}/${name}`
            if (keep.has(full)) return
            wx.getFileSystemManager().unlink({ filePath: full, fail: () => {} })
          })
      },
      fail: (err) => console.warn('读取缩略图目录失败:', err)
    })
  },

  /**
   * 串行拉取缩略图：并发会让设备端的读回会话互相打断。
   * 只拉传入的窗口（即可见行），并且把 setData 合并成批——
   * 每张缩略图一次 setData 在几百张时就是几百次跨线程往返。
   */
  async loadThumbnails(files) {
    const generation = ++this._thumbGeneration
    const targets = files.filter(f => f.previewSize > 0 && !f.thumb)
    const pending = []

    const flush = () => {
      if (!pending.length) return
      const patch = {}
      for (const item of pending) {
        const index = this._stemIndex ? this._stemIndex.get(item.stem) : -1
        if (index >= 0 && index < this.data.renderedCount) {
          patch[`visibleFiles[${index}].thumb`] = item.path
        }
      }
      pending.length = 0
      if (Object.keys(patch).length) this.setData(patch)
    }

    for (const file of targets) {
      if (generation !== this._thumbGeneration) return
      if (!this.data.connected) return

      const path = this.thumbPath(file.stem)
      if (await this.fileExists(path)) {
        file.thumb = path
        pending.push({ stem: file.stem, path })
        if (pending.length >= THUMB_BATCH_SIZE) flush()
        continue
      }

      try {
        const data = await this.readPreview(file.stem, file.previewSize)
        await this.writeFile(path, data)
        file.thumb = path
        pending.push({ stem: file.stem, path })
      } catch (e) {
        console.warn('缩略图拉取失败 ' + file.stem + ':', e)
      }

      if (pending.length >= THUMB_BATCH_SIZE) flush()
    }
    flush()
  },

  fileExists(filePath) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().access({
        path: filePath,
        success: () => resolve(true),
        fail: () => resolve(false)
      })
    })
  },

  writeFile(filePath, data) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().writeFile({
        filePath,
        data,
        success: resolve,
        fail: reject
      })
    })
  },

  /**
   * 分片拉取预览 JPEG。
   * 设备每片回包都带自己的 offset，所以缺口能被发现并从缺口处续拉，
   * 而不是把后续数据错位拼接成一张损坏的图。
   */
  readPreview(stem, totalSize) {
    const buffer = new Uint8Array(totalSize)
    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const characteristicId = this.data.writeCharacteristicId

    const send = (offset, want) => {
      // 载荷：stem(20) + offset:u32 + length:u16
      const cmd = new Uint8Array(1 + STEM_FIELD + 6)
      cmd[0] = 0x15
      cmd.set(this.writeStemField(stem), 1)
      const base = 1 + STEM_FIELD
      cmd[base] = offset & 0xFF
      cmd[base + 1] = (offset >>> 8) & 0xFF
      cmd[base + 2] = (offset >>> 16) & 0xFF
      cmd[base + 3] = (offset >>> 24) & 0xFF
      cmd[base + 4] = want & 0xFF
      cmd[base + 5] = (want >> 8) & 0xFF
      const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)
      return new Promise((resolve, reject) => {
        wx.writeBLECharacteristicValue({
          deviceId, serviceId, characteristicId, value: ab,
          success: resolve, fail: reject
        })
      })
    }

    const requestBatch = (offset, want) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._previewPending = null
        // 批次不完整不算失败：调用方从设备实际到达的位置续拉
        resolve('timeout')
      }, PREVIEW_REPLY_TIMEOUT_MS)

      this._previewPending = {
        offset,
        want,
        buffer,
        totalSize,
        resolve: () => { clearTimeout(timer); this._previewPending = null; resolve('done') },
        reject: (err) => { clearTimeout(timer); this._previewPending = null; reject(err) },
        retry: () => { clearTimeout(timer); this._previewPending = null; resolve('busy') }
      }

      send(offset, want).catch((err) => {
        const pending = this._previewPending
        if (pending && pending.offset === offset) {
          clearTimeout(timer)
          this._previewPending = null
          reject(err)
        }
      })
    })

    const run = async () => {
      let offset = 0
      let steps = 0
      let busyRetries = 0
      this._previewProgress = 0

      while (offset < totalSize) {
        if (++steps > MAX_PREVIEW_STEPS) {
          throw new Error('预览读取步数超限')
        }
        const want = Math.min(PREVIEW_CHUNK_REQUEST, totalSize - offset)
        const outcome = await requestBatch(offset, want)

        if (outcome === 'busy') {
          if (++busyRetries > MAX_PREVIEW_BUSY_RETRIES) {
            throw new Error('设备持续忙，读回中止')
          }
          await this.sleep(200)
          continue
        }
        busyRetries = 0

        if (this._previewProgress <= offset) {
          throw new Error('预览读取未推进 (offset=' + offset + ')')
        }
        offset = this._previewProgress
      }

      // offset == totalSize 是协议里的结束标志，发一次让设备立刻释放租约和
      // 文件句柄；否则会话要等设备侧空闲回收，期间它会占着那张图。
      await send(totalSize, 0).catch(() => {})
      return buffer.buffer
    }

    return run()
  },

  handlePreviewReply(buf) {
    const pending = this._previewPending
    if (!pending) return

    const status = buf[1]
    const replyOffset = (buf[2] | (buf[3] << 8) |
                         (buf[4] << 16) | (buf[5] << 24)) >>> 0

    if (status === 2) {
      pending.retry()
      return
    }
    if (status !== 0) {
      pending.reject(new Error('设备返回预览错误 status=' + status))
      return
    }

    const payload = buf.subarray(6)
    if (payload.length === 0) {
      this._previewProgress = pending.totalSize
      pending.resolve()
      return
    }
    if (replyOffset >= pending.totalSize || replyOffset < pending.offset) return

    const end = Math.min(replyOffset + payload.length, pending.totalSize)
    if (end <= replyOffset) return

    pending.buffer.set(payload.subarray(0, end - replyOffset), replyOffset)
    if (end > this._previewProgress) this._previewProgress = end

    if (this._previewProgress >= pending.offset + pending.want ||
        this._previewProgress >= pending.totalSize) {
      pending.resolve()
    }
  },

  /**
   * 等待某个命令的 ACK，返回 {responded, ok, status, id}。
   * responded=false 表示超时（旧固件、或链路丢了应答）。
   * id 只在 FILE_START 的 4 字节 ACK 里有效。
   */
  waitForAck(commandNibble, timeoutMs) {
    if (!this._ackWaiters) this._ackWaiters = {}
    const pending = this._ackWaiters[commandNibble]
    if (pending) {
      // 同一个命令重复等待：旧的直接判为无应答，不要把它悬在那里
      clearTimeout(pending.timer)
      pending.resolve({ responded: false, ok: false, status: -1, stem: '' })
    }

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          if (this._ackWaiters[commandNibble] === waiter) {
            delete this._ackWaiters[commandNibble]
            resolve({ responded: false, ok: false, status: -1, stem: '' })
          }
        }, timeoutMs)
      }
      this._ackWaiters[commandNibble] = waiter
    })
  },

  /**
   * 等待 FILE_START 应答，拿到设备分配的图片 id。
   * 返回 {responded, ok, status, id}：
   *   responded=false 表示超时——旧固件只回 2 字节 ACK，此时照常上传但跳过预览；
   *   responded=true 且 ok=false 表示设备明确拒收，调用方必须中止，
   *   否则会把整张图灌进空洞、设备端全部丢弃，而小程序还报“发送完成”。
   */
  waitForFileStartAck(timeoutMs = 3000) {
    return this.waitForAck(0x01, timeoutMs)
  },

  /**
   * 等待 FILE_END 应答。设备只有在收满 384000 字节后才会回 status=0；
   * 中途丢包会让它回非零状态，这里必须让调用方失败，
   * 否则“发送完成”会和“设备其实什么都没收到”长得一模一样。
   */
  waitForFileEndAck(timeoutMs = 8000) {
    return this.waitForAck(0x03, timeoutMs)
  },

  /**
   * 扫描会返回附近所有 BLE 设备，这里只保留本项目的墨水屏：优先按广播名
   * 前缀匹配；名字没解析出来时退回服务 UUID，避免因广播解析差异漏掉设备。
   */
  isTargetDevice(device) {
    const name = (device.name || device.localName || '').toUpperCase()
    if (name.indexOf(DEVICE_NAME_PREFIX) === 0) {
      return true
    }

    const uuids = device.advertisServiceUUIDs || []
    return uuids.some(uuid =>
      String(uuid).toUpperCase().indexOf(BLE_SERVICE_HINT) !== -1)
  },

  /** 把 RSSI 分成三档，用于给出信号强弱的颜色提示。 */
  signalLevel(rssi) {
    if (typeof rssi !== 'number') return 'weak'
    if (rssi >= -60) return 'strong'
    if (rssi >= -80) return 'medium'
    return 'weak'
  },

  /**
   * 从定长字段里读出 stem。设备发来的是 20 字节 NUL 填充字段。
   */
  readStemField(buf, offset) {
    const limit = Math.min(offset + STEM_FIELD, buf.length)
    let end = offset
    while (end < limit && buf[end] !== 0) end++

    let stem = ''
    for (let i = offset; i < end; i++) {
      stem += String.fromCharCode(buf[i])
    }
    return stem
  },

  /**
   * 把 stem 打包成定长的 20 字节字段（19 字符 + NUL）。
   */
  writeStemField(stem) {
    const field = new Uint8Array(STEM_FIELD)
    const text = stem || ''
    const limit = Math.min(text.length, STEM_FIELD - 1)
    for (let i = 0; i < limit; i++) {
      field[i] = text.charCodeAt(i) & 0xFF
    }
    return field
  },

  /**
   * 生成图片名 stem：YYYYMMDD-HHMMSS-NNN。
   * 设备没有时钟，时间只能由手机提供；定宽格式让字典序等于时间序。
   */
  makeStem() {
    const now = new Date()
    const pad = (value, width) => String(value).padStart(width, '0')
    const stamp = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) +
                  pad(now.getDate(), 2) + '-' +
                  pad(now.getHours(), 2) + pad(now.getMinutes(), 2) +
                  pad(now.getSeconds(), 2)

    // 同一秒内重复上传用序号区分；设备也会拒绝重名，届时调用方递增重试
    for (let seq = 0; seq < 1000; seq++) {
      const candidate = `${stamp}-${pad(seq, 3)}`
      const taken = (this._allFiles || []).some(f => f.stem === candidate)
      if (!taken) {
        return candidate
      }
    }
    return `${stamp}-999`
  },

  /**
   * 把 stem 变成可读的日期时间，用于列表显示。
   */
  stemToLabel(stem) {
    if (!stem || stem.length < STEM_LENGTH) return stem || ''
    return `${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6, 8)} ` +
           `${stem.slice(9, 11)}:${stem.slice(11, 13)}:${stem.slice(13, 15)}`
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
  /**
   * 合并短时间内的多次改动再下发。
   *
   * 开关连点、滑杆拖动会产生一串事件，而设备对同一条命令有 1 秒限流，
   * 逐条发送会让中间那些被静默丢弃 —— 界面显示的和设备实际执行的就分叉了。
   * 用户要的只是最后那个值。
   */
  queueSlideshowConfig() {
    if (this._slideshowTimer) {
      clearTimeout(this._slideshowTimer)
    }
    this._slideshowTimer = setTimeout(() => {
      this._slideshowTimer = null
      this.sendSlideshowConfig(this.data.slideshowEnabled,
                               this.data.slideshowInterval)
    }, SLIDESHOW_DEBOUNCE_MS)
  },

  sendSlideshowConfig(enabled, interval, attempt) {
    if (!this.data.connected) return
    const deviceId = this.data.currentDeviceId
    const serviceId = this.data.writeServiceId
    const charId = this.data.writeCharacteristicId
    if (!serviceId || !charId) return

    const tryNumber = attempt || 0
    const cmd = new Uint8Array(4)
    cmd[0] = 0x13
    cmd[1] = enabled ? 1 : 0
    cmd[2] = interval & 0xFF
    cmd[3] = (interval >> 8) & 0xFF
    const ab = cmd.buffer.slice(cmd.byteOffset, cmd.byteOffset + cmd.byteLength)

    // 必须等应答：被限流时设备回 status=2 并丢弃这条命令，
    // 不看应答的话界面会停在一个设备并不认的值上。
    const ackPromise = this.waitForAck(0x03, 3000)

    wx.writeBLECharacteristicValue({
      deviceId, serviceId, characteristicId: charId,
      value: ab,
      success: () => console.log('SLIDESHOW_CTRL 已发送: enabled=' + enabled +
                                 ' interval=' + interval + ' 第' + (tryNumber + 1) + '次'),
      fail: (err) => console.error('SLIDESHOW_CTRL 发送失败:', err)
    })

    ackPromise.then((ack) => {
      if (!ack.responded || ack.ok) return
      if (ack.status !== 2) {
        console.warn('设备拒绝了轮播设置 (status=' + ack.status + ')')
        return
      }
      // 忙 = 被限流。只在用户没有再改动的前提下重试，避免把过期值补发回去
      const stillCurrent = this.data.slideshowEnabled === enabled &&
                           this.data.slideshowInterval === interval
      if (tryNumber < SLIDESHOW_MAX_RETRIES && stillCurrent) {
        setTimeout(() => {
          this.sendSlideshowConfig(enabled, interval, tryNumber + 1)
        }, SLIDESHOW_RETRY_MS)
      } else {
        console.warn('轮播设置未能下发: enabled=' + enabled + ' interval=' + interval)
      }
    })
  },

  /**
   * 轮播开关切换
   */
  onSlideshowToggle(e) {
    this.setData({ slideshowEnabled: e.detail.value })
    this.queueSlideshowConfig()
  },

  /**
   * 轮播间隔变化
   */
  selectInterval(e) {
    const seconds = parseInt(e.currentTarget.dataset.seconds)
    if (seconds === this.data.slideshowInterval) return
    this.setData({
      slideshowInterval: seconds,
      slideshowLabel: this.formatInterval(seconds)
    })
    this.queueSlideshowConfig()
  },

  /** 秒数转成人看得懂的写法 */
  formatInterval(seconds) {
    if (seconds < 60) return seconds + ' 秒'
    if (seconds < 3600) return Math.round(seconds / 60) + ' 分'
    const hours = seconds / 3600
    return (hours % 1 === 0 ? hours : hours.toFixed(1)) + ' 小时'
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
})
