import { newerVersion, verifyFirmware } from './firmware-updates.js'

export const BLE_OTA = {BEGIN: 0x30, DATA: 0x31, END: 0x32, ABORT: 0x33, REPLY: 0x35}

export class BleFirmwareSender {
  constructor(api, connection, update, beforeCommit = () => {}) {
    this.api = api
    this.connection = connection
    this.update = update
    this.beforeCommit = beforeCommit
    this.cancelled = false
    this.started = false
    this.committing = false
    this.accepted = false
    this.pending = null
  }

  assertActive() {
    if (this.cancelled || !this.connection.active()) throw new Error('蓝牙升级已取消或连接已断开')
  }

  receive(bytes) {
    const pending = this.pending
    if (!pending || bytes.length !== 7 || bytes[0] !== BLE_OTA.REPLY || bytes[1] !== pending.command) return
    const offset = (bytes[3] | bytes[4] << 8 | bytes[5] << 16 | bytes[6] << 24) >>> 0
    if (bytes[2] !== 0) {
      pending.reject(new Error(bytes[2] === 2 ? '设备忙或尚未完成启动自检，请稍后重试' :
        bytes[2] === 4 ? '设备固件摘要校验失败' : '设备拒绝固件数据（状态 ' + bytes[2] + '）'))
    } else if (offset !== pending.offset) {
      // A duplicate ACK from the previous packet cannot complete this packet.
      return
    } else pending.resolve()
  }

  async send(packet, offset, timeout = 60000, retries = 0) {
    this.assertActive()
    let acknowledged = false
    let wrote = false
    const pending = {command: packet[0], offset, resolve: null, reject: null, timer: null}
    const ack = new Promise((resolve, reject) => {
      pending.resolve = () => { acknowledged = true; resolve() }
      pending.reject = reject
      pending.timer = setTimeout(() => {
        const error = new Error('等待设备升级应答超时')
        error.timeout = true
        reject(error)
      }, timeout)
    })
    this.pending = pending
    const delivered = new Promise((resolve, reject) => {
      this.api.writeBLECharacteristicValue({writeType: 'write',
        deviceId: this.connection.deviceId, serviceId: this.connection.serviceId,
        characteristicId: this.connection.characteristicId, value: packet.buffer,
        success: () => { wrote = true; resolve() },
        fail: () => reject(new Error('蓝牙写入失败，请重新连接后重试'))})
    })
    try {
      await Promise.all([delivered, ack])
      this.assertActive()
    } catch (error) {
      if (error.timeout && wrote && !acknowledged && packet[0] === BLE_OTA.DATA && retries < 2 &&
          !this.cancelled && this.connection.active()) {
        clearTimeout(pending.timer)
        if (this.pending === pending) this.pending = null
        return this.send(packet, offset, timeout, retries + 1)
      }
      throw error
    } finally {
      clearTimeout(pending.timer)
      if (this.pending === pending) this.pending = null
    }
  }

  abort() {
    if (!this.started || this.committing || !this.connection.active()) return
    this.api.writeBLECharacteristicValue({writeType: 'write', deviceId: this.connection.deviceId,
      serviceId: this.connection.serviceId, characteristicId: this.connection.characteristicId,
      value: new Uint8Array([BLE_OTA.ABORT]).buffer, success() {}, fail() {}})
  }

  cancel() {
    if (this.cancelled || this.accepted) return
    this.cancelled = true
    this.pending?.reject(new Error('蓝牙升级已取消'))
    this.abort()
  }

  async readVerified(path, manifest) {
    const files = this.api.getFileSystemManager()
    const stats = await new Promise((resolve, reject) => files.stat({path,
      success: value => resolve(value.stats), fail: () => reject(new Error('固件缓存已失效，请重新下载'))}))
    this.assertActive()
    if (stats.size !== manifest.size) throw new Error('固件缓存大小不符，请重新下载')
    const buffer = await new Promise((resolve, reject) => files.readFile({filePath: path,
      success: value => resolve(value.data), fail: () => reject(new Error('无法读取固件，请重新下载'))}))
    this.assertActive()
    verifyFirmware(buffer, manifest)
    return new Uint8Array(buffer)
  }

  async install(path, sourceManifest, currentVersion, mtu) {
    const manifest = {...sourceManifest}
    if (!newerVersion(manifest.version, currentVersion)) throw new Error('固件版本必须高于设备当前版本')
    this.assertActive()
    this.update({firmwareStatus: '正在校验待升级固件…', firmwareInstallProgress: 0})
    const bytes = await this.readVerified(path, manifest)
    this.assertActive()
    const stream = new Uint8Array(32 + bytes.length)
    for (let i = 0; i < 32; i++) stream[i] = parseInt(manifest.sha256.slice(i * 2, i * 2 + 2), 16)
    stream.set(bytes, 32)
    const begin = new Uint8Array(5)
    begin[0] = BLE_OTA.BEGIN
    new DataView(begin.buffer).setUint32(1, bytes.length, true)
    this.update({firmwareStatus: '等待设备准备蓝牙升级…'})
    this.started = true
    try {
      await this.send(begin, 0, 130000)
      const payload = Math.max(20, Math.min(509, (Number(mtu) || 23) - 3)) - 5
      const started = Date.now()
      for (let offset = 0; offset < stream.length;) {
        this.assertActive()
        if (Date.now() - started > 3600000) throw new Error('蓝牙升级超过时限，请重试')
        const length = Math.min(payload, stream.length - offset)
        const packet = new Uint8Array(5 + length)
        packet[0] = BLE_OTA.DATA
        new DataView(packet.buffer).setUint32(1, offset, true)
        packet.set(stream.subarray(offset, offset + length), 5)
        await this.send(packet, offset + length)
        offset += length
        const progress = Math.min(99, Math.floor(Math.max(0, offset - 32) / bytes.length * 100))
        if (progress !== this.progress) {
          this.progress = progress
          this.update({firmwareStatus: '正在通过蓝牙传输固件…', firmwareInstallProgress: progress})
        }
      }
      this.assertActive()
      this.beforeCommit(manifest.version)
      this.committing = true
      this.update({firmwareCommitting: true, firmwareStatus: '设备正在校验固件并提交升级…'})
      await this.send(new Uint8Array([BLE_OTA.END]), stream.length)
      this.accepted = true
      this.update({firmwareInstallProgress: 100,
        firmwareStatus: '固件已提交，设备重启后请重新连接确认升级结果'})
    } catch (error) {
      this.abort()
      throw error
    }
  }
}
