// 调参台的 Web Bluetooth 上传器。
//
// 协议与 pages/index/index.js 保持一致；这里只做连接和上传当前主图 + JPEG
// 预览，不复制相册列表、删除、选择或轮播控制。

export const BLE_SERVICE_UUID = 0xABF0
export const BLE_CHARACTERISTIC_UUID = 0xABF1
export const STEM_FIELD = 20
export const PREVIEW_MAX_BYTES = 128 * 1024

const CMD_FILE_START = 0x01
const CMD_FILE_DATA = 0x02
const CMD_FILE_END = 0x03
const CMD_FILE_ABORT = 0x04
const CMD_PREVIEW_START = 0x16
const CMD_ACK = 0xFF

const FAST_TOTAL_BYTES = 509       // command + 508B，固件 ATT MTU 是 512
const COMPAT_TOTAL_BYTES = 20      // command + 19B，默认 ATT MTU 23 也安全
const WIRE_BYTES_BY_PANEL = { '800': 144000, '1200': 720000 }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

export function parsePanelTag(name) {
  const match = /^EINK-(\d+)-/i.exec(String(name || ''))
  return match ? match[1] : ''
}

export function writeStemField(stem) {
  const field = new Uint8Array(STEM_FIELD)
  const text = String(stem || '')
  const limit = Math.min(text.length, STEM_FIELD - 1)
  for (let i = 0; i < limit; i++) field[i] = text.charCodeAt(i) & 0xFF
  return field
}

export function readStemField(bytes, offset = 0) {
  const buf = toBytes(bytes)
  const limit = Math.min(offset + STEM_FIELD, buf.length)
  let end = offset
  while (end < limit && buf[end] !== 0) end++
  let stem = ''
  for (let i = offset; i < end; i++) stem += String.fromCharCode(buf[i])
  return stem
}

/**
 * 生成 YYYYMMDD-HHMMSS-NNN。sequence 由调用方维护；FILE_START 遇到重名时
 * 在发 DATA 前递增重试，所以不会产生半张重复图。
 */
export function makeStem(now = new Date(), sequence = 0) {
  const pad = (value, width) => String(value).padStart(width, '0')
  return pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) +
         pad(now.getDate(), 2) + '-' +
         pad(now.getHours(), 2) + pad(now.getMinutes(), 2) +
         pad(now.getSeconds(), 2) + '-' + pad(sequence, 3)
}

export class ParamUploader {
  constructor({ bluetooth = globalThis.navigator?.bluetooth,
                onState = () => {}, onProgress = () => {} } = {}) {
    this.bluetooth = bluetooth
    this.onState = onState
    this.onProgress = onProgress
    this.device = null
    this.server = null
    this.characteristic = null
    this.connected = false
    this.uploading = false
    this._waiters = new Map()
    this._stemStamp = ''
    this._stemSequence = 0
    this._onNotification = (event) => this._handleNotification(event)
    this._onDisconnected = () => this._handleDisconnected()
  }

  get deviceName() { return this.device?.name || '' }
  get devicePanelTag() { return parsePanelTag(this.deviceName) }
  get supported() { return Boolean(this.bluetooth?.requestDevice) }

  /** 首次连接一定弹浏览器设备选择器，必须从用户点击事件直接调用。 */
  async connect(expectedPanelTag) {
    if (!this.supported) {
      throw new Error('当前浏览器不支持 Web Bluetooth；请用 Microsoft Edge 或 Chrome，并从 http://127.0.0.1 打开')
    }
    if (this.connected) this.disconnect()

    this.onState({ kind: 'connecting', message: '请选择 EINK 设备…' })
    const device = await this.bluetooth.requestDevice({
      filters: [{ namePrefix: 'EINK-' }], optionalServices: [BLE_SERVICE_UUID]
    })

    const actualTag = parsePanelTag(device.name)
    if (!actualTag) throw new Error(`设备名 ${device.name || '(空)'} 没有面板标识，无法安全判断尺寸`)
    if (String(expectedPanelTag) !== actualTag) {
      throw new Error(`面板不匹配：页面选择 ${expectedPanelTag}，设备是 ${actualTag}`)
    }

    device.addEventListener('gattserverdisconnected', this._onDisconnected)
    try {
      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(BLE_SERVICE_UUID)
      const characteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID)
      await characteristic.startNotifications()
      characteristic.addEventListener('characteristicvaluechanged', this._onNotification)

      this.device = device
      this.server = server
      this.characteristic = characteristic
      this.connected = true
      this.onState({ kind: 'connected', message: `已连接 ${device.name}`, deviceName: device.name })
      return device.name
    } catch (error) {
      device.removeEventListener('gattserverdisconnected', this._onDisconnected)
      if (device.gatt?.connected) device.gatt.disconnect()
      throw error
    }
  }

  disconnect() {
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this._onNotification)
    }
    this._rejectAll(new Error('蓝牙已断开'))
    const device = this.device
    this.characteristic = null
    this.server = null
    this.device = null
    this.connected = false
    if (device) {
      device.removeEventListener('gattserverdisconnected', this._onDisconnected)
      if (device.gatt?.connected) device.gatt.disconnect()
    }
    this.onState({ kind: 'disconnected', message: '未连接' })
  }

  _handleDisconnected() {
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this._onNotification)
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected)
    }
    this.characteristic = null
    this.server = null
    this.device = null
    this.connected = false
    this.uploading = false
    this._rejectAll(new Error('设备连接已断开'))
    this.onState({ kind: 'disconnected', message: '设备已断开' })
  }

  _handleNotification(event) {
    const bytes = toBytes(event.target?.value ?? event)
    if (bytes.length < 2 || bytes[0] !== CMD_ACK) return
    const command = (bytes[1] >> 4) & 0x0F
    const status = bytes[1] & 0x0F
    const waiter = this._waiters.get(command)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this._waiters.delete(command)
    waiter.resolve({ status, ok: status === 0,
      stem: command === CMD_FILE_START ? readStemField(bytes, 2) : '' })
  }

  _waitForAck(command, timeoutMs) {
    const old = this._waiters.get(command)
    if (old) {
      clearTimeout(old.timer)
      old.reject(new Error(`命令 0x${command.toString(16)} 被新的等待替代`))
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        if (this._waiters.get(command) === waiter) {
          this._waiters.delete(command)
          reject(new Error(`等待命令 0x${command.toString(16)} 应答超时`))
        }
      }, timeoutMs) }
      this._waiters.set(command, waiter)
    })
  }

  /** 先挂 waiter 再写，避免通知抢跑；写失败则同步撤销 waiter。 */
  async _writeAndWait(bytes, command, timeoutMs) {
    const ackPromise = this._waitForAck(command, timeoutMs)
    try {
      await this._writeControl(bytes)
    } catch (error) {
      const waiter = this._waiters.get(command)
      if (waiter) {
        clearTimeout(waiter.timer)
        this._waiters.delete(command)
        waiter.reject(error)
      }
      // 消费 ackPromise 的拒绝，随后只向调用方抛原始写错误
      await ackPromise.catch(() => {})
      throw error
    }
    return ackPromise
  }

  _rejectAll(error) {
    for (const waiter of this._waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this._waiters.clear()
  }

  async _writeControl(bytes) {
    if (!this.characteristic || !this.connected) throw new Error('设备未连接')
    const c = this.characteristic
    if (typeof c.writeValueWithResponse === 'function') {
      await c.writeValueWithResponse(bytes)
    } else if (typeof c.writeValue === 'function') {
      await c.writeValue(bytes)
    } else {
      throw new Error('浏览器没有可用的 GATT 有应答写接口')
    }
  }

  _writeStrategy(mode) {
    const c = this.characteristic
    if (mode === 'compat') {
      return { totalBytes: COMPAT_TOTAL_BYTES,
        write: (packet) => this._writeControl(packet), label: '兼容 20B' }
    }

    const reported = Number(this.device?.gatt?.maxWriteWithoutResponseSize)
    if (reported >= 2 && typeof c.writeValueWithoutResponse === 'function') {
      const totalBytes = Math.min(FAST_TOTAL_BYTES, Math.floor(reported))
      return { totalBytes, write: (packet) => c.writeValueWithoutResponse(packet),
        label: `快速 ${totalBytes}B (无应答)` }
    }
    return { totalBytes: FAST_TOTAL_BYTES,
      write: (packet) => this._writeControl(packet), label: `快速 ${FAST_TOTAL_BYTES}B (有应答)` }
  }

  _nextStem(now = new Date()) {
    const stamp = makeStem(now, 0).slice(0, 15)
    if (stamp !== this._stemStamp) { this._stemStamp = stamp; this._stemSequence = 0 }
    return makeStem(now, this._stemSequence++)
  }

  async _startMain() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const stem = this._nextStem()
      const name = new TextEncoder().encode(stem)
      const packet = new Uint8Array(2 + name.length)
      packet[0] = CMD_FILE_START
      packet[1] = name.length
      packet.set(name, 2)
      const ack = await this._writeAndWait(packet, CMD_FILE_START, 4000)
      if (ack.ok && ack.stem) return ack.stem
      if (ack.status !== 2) throw new Error(`设备拒绝主图（FILE_START status=${ack.status}）`)
      /* status=2 既可能是重名/目录满，也可能是 FILE_START 的 1 秒限流。
       * 立即换名重发只会连续撞限流；等过窗口再试。DATA 尚未开始，重试安全。 */
      if (attempt < 2) await sleep(1100)
    }
    throw new Error('设备连续拒绝 3 个文件名（可能目录已满）')
  }

  async _startPreview(stem) {
    const packet = new Uint8Array(1 + STEM_FIELD)
    packet[0] = CMD_PREVIEW_START
    packet.set(writeStemField(stem), 1)
    const ack = await this._writeAndWait(packet, CMD_PREVIEW_START & 0x0F, 4000)
    if (!ack.ok) throw new Error(`设备拒绝缩略图（PREVIEW_START status=${ack.status}）`)
  }

  async _stream(bytes, { label, mode, progressBase, progressSpan }) {
    const source = toBytes(bytes)
    const strategy = this._writeStrategy(mode)
    const payloadBytes = strategy.totalBytes - 1
    let offset = 0
    let lastPercent = -1

    this.onState({ kind: 'streaming', message: `${label}：${strategy.label}` })
    while (offset < source.length) {
      const count = Math.min(payloadBytes, source.length - offset)
      const packet = new Uint8Array(1 + count)
      packet[0] = CMD_FILE_DATA
      packet.set(source.subarray(offset, offset + count), 1)
      await strategy.write(packet)
      offset += count
      const localPercent = Math.floor(offset / source.length * 100)
      if (localPercent !== lastPercent) {
        lastPercent = localPercent
        this.onProgress({ label, sent: offset, total: source.length,
          percent: progressBase + localPercent / 100 * progressSpan,
          packets: Math.ceil(source.length / payloadBytes), strategy: strategy.label })
      }
    }

    const ack = await this._writeAndWait(
      new Uint8Array([CMD_FILE_END]), CMD_FILE_END, 10000)
    if (!ack.ok) throw new Error(`${label}被设备拒收（FILE_END status=${ack.status}）`)
  }

  async _abortQuietly() {
    try {
      if (this.connected && this.characteristic) await this._writeControl(new Uint8Array([CMD_FILE_ABORT]))
    } catch (_) { /* 原错误比清理错误更有价值 */ }
  }

  async upload({ panelTag, wireBytes, previewBytes = null, mode = 'fast' }) {
    if (this.uploading) throw new Error('已有上传正在进行')
    if (!this.connected || !this.characteristic) throw new Error('请先连接设备')
    if (this.devicePanelTag !== String(panelTag)) {
      throw new Error(`面板不匹配：页面 ${panelTag}，设备 ${this.devicePanelTag || '未知'}`)
    }
    const main = toBytes(wireBytes)
    const expected = WIRE_BYTES_BY_PANEL[String(panelTag)]
    if (!expected) throw new Error(`不支持的面板标识：${panelTag}`)
    if (main.length !== expected) {
      throw new Error(`主图线上大小 ${main.length}B，应为 ${expected}B`)
    }

    this.uploading = true
    let mainDone = false
    try {
      const stem = await this._startMain()
      await this._stream(main, { label: '主图', mode, progressBase: 0, progressSpan: 95 })
      mainDone = true

      let previewError = null
      const preview = previewBytes ? toBytes(previewBytes) : null
      if (preview?.length) {
        if (preview.length > PREVIEW_MAX_BYTES) {
          previewError = new Error(`缩略图 ${preview.length}B 超过 128KB`)
        } else {
          try {
            await this._startPreview(stem)
            await this._stream(preview, { label: '缩略图', mode, progressBase: 95, progressSpan: 5 })
          } catch (error) {
            previewError = error
            await this._abortQuietly()
          }
        }
      }

      this.onProgress({ label: '完成', sent: 1, total: 1, percent: 100 })
      this.onState({ kind: previewError ? 'partial' : 'complete',
        message: previewError ? `主图已上传，缩略图失败：${previewError.message}` : `上传完成：${stem}`,
        stem, previewError })
      return { stem, partialSuccess: Boolean(previewError), previewError }
    } catch (error) {
      if (!mainDone) await this._abortQuietly()
      this.onState({ kind: 'error', message: error.message, error })
      throw error
    } finally {
      this.uploading = false
    }
  }
}
