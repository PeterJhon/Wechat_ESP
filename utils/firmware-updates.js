import { sha256 } from './sha256.js'
import parseUrl from './vendor/url-parse.js'

export const OTA_SLOT_BYTES = 0x1e0000

export function versionParts(version) {
  if (typeof version !== 'string') throw new Error('固件版本格式不正确')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-universal$/.exec(version)
  if (!match) throw new Error('固件版本格式不正确')
  const parts = match.slice(1).map(Number)
  if (parts.some(x => x > 65535)) throw new Error('固件版本超出范围')
  return parts
}

export function newerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function httpsOrigin(url) {
  if (typeof url !== 'string' || url.length >= 512 || /[\s\x00-\x1f\x7f\\#]/.test(url))
    throw new Error('更新地址必须是有效的 HTTPS 地址')
  const parsed = parseUrl(url, {})
  const authority = url.slice(url.indexOf('//') + 2).split(/[/?#]/, 1)[0]
  const hostname = parsed.hostname.toLowerCase()
  const port = parsed.port ? Number(parsed.port) : 443
  if (!/^https:\/\//i.test(url) || parsed.protocol !== 'https:' || !parsed.slashes ||
      parsed.auth || authority.includes('@') || parsed.hash ||
      !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z](?:[a-z\d-]*[a-z\d])?$/i.test(hostname) ||
      hostname.length > 253 || hostname.split('.').some(label => label.length > 63) ||
      !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('更新地址必须使用有效的 HTTPS 域名和端口')
  return 'https://' + hostname + ':' + port
}

export function parseManifestBuffer(buffer, manifestUrl) {
  if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' ||
      buffer.byteLength === 0 || buffer.byteLength >= 4096)
    throw new Error('更新清单无效：正文必须小于 4096 字节')
  try {
    const encoded = Array.from(new Uint8Array(buffer), b => '%' + b.toString(16).padStart(2, '0')).join('')
    const text = decodeURIComponent(encoded).replace(/^\ufeff/, '')
    return validateManifest(JSON.parse(text), manifestUrl)
  } catch (e) { throw new Error('更新清单无效：' + e.message) }
}

export function validateManifest(value, manifestUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.panel !== 'universal' || value.profile !== 'release')
    throw new Error('更新清单不是通用发布版固件')
  versionParts(value.version)
  if (!Number.isInteger(value.size) || value.size < 288 || value.size > OTA_SLOT_BYTES ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))
    throw new Error('更新清单的大小或校验值不正确')
  if (httpsOrigin(value.url) !== httpsOrigin(manifestUrl))
    throw new Error('固件必须与更新清单使用相同的 HTTPS 域名和端口')
  return {version: value.version, size: value.size, sha256: value.sha256,
    url: value.url, panel: value.panel, profile: value.profile}
}

function asciiField(bytes, start, end) {
  let text = ''
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) return text
    if (bytes[i] > 127) throw new Error('固件信息不正确')
    text += String.fromCharCode(bytes[i])
  }
  throw new Error('固件信息缺少终止符')
}

export function verifyFirmware(buffer, manifest) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length !== manifest.size || bytes.length < 288 || bytes.length > OTA_SLOT_BYTES)
    throw new Error('固件文件大小不符')
  if (sha256(bytes) !== manifest.sha256) throw new Error('固件 SHA-256 校验失败')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 0xe9 || view.getUint16(12, true) !== 9 ||
      view.getUint32(32, true) !== 0xabcd5432 ||
      asciiField(bytes, 80, 112) !== 'ESP_S3_EINK' ||
      asciiField(bytes, 48, 80) !== manifest.version)
    throw new Error('固件与设备项目或版本不匹配')
  const tail = Array.from(bytes.slice(-32), x => x.toString(16).padStart(2, '0')).join('')
  if (bytes[23] !== 1 || sha256(bytes.subarray(0, -32)) !== tail)
    throw new Error('固件镜像内部校验失败')
  const marker = 'EINK_BUILD_PROFILE=release\0'
  let release = false
  for (let i = 0; i <= bytes.length - marker.length; i++) {
    if (bytes[i] === 69 && [...marker].every((c, n) => bytes[i + n] === c.charCodeAt(0))) {
      release = true; break
    }
  }
  if (!release) throw new Error('下载的固件不是发布版')
  return true
}

// One instance belongs to one BLE session. Disposing aborts network tasks and
// removes temporary files; late callbacks cannot publish state to a new device.
export class FirmwareUpdater {
  constructor(api, manifestUrl, currentVersion, update) {
    this.api = api
    this.url = manifestUrl
    this.current = currentVersion
    this.update = update
    this.generation = 0
    this.busy = false
    this.disposed = false
    this.path = ''
  }

  emit(values) { if (!this.disposed) this.update(values) }
  remove(path) {
    if (path) this.api.getFileSystemManager().unlink({filePath: path, fail() {}})
  }
  dispose() {
    this.disposed = true
    this.generation++
    this.request?.abort()
    this.download?.abort()
    this.remove(this.path)
    this.path = ''
  }

  cancel() {
    if (!this.busy || this.disposed) return
    this.generation++
    this.request?.abort()
    this.download?.abort()
    this.remove(this.path)
    this.path = ''
    this.busy = false
    this.emit({firmwareBusy: false, firmwareDownloaded: false, firmwareProgress: 0,
      firmwareStatus: '已取消，可重新检查更新'})
  }

  check() {
    if (this.busy || this.disposed) return
    if (!this.url) {
      this.emit({firmwareStatus: '更新服务暂未启用'})
      return
    }
    try { httpsOrigin(this.url); versionParts(this.current) } catch (e) {
      this.emit({firmwareStatus: e.message}); return
    }
    this.busy = true
    const generation = ++this.generation
    const active = () => !this.disposed && generation === this.generation
    this.emit({firmwareBusy: true, firmwareDownloaded: false, firmwareStatus: '正在检查新版本…'})
    this.request = this.api.request({
      url: this.url, method: 'GET', timeout: 15000, dataType: 'text', responseType: 'arraybuffer',
      header: {'Cache-Control': 'no-cache'},
      success: response => {
        if (!active()) return
        try {
          if (response.statusCode === 404) throw new Error('更新清单暂未发布或不可用，可稍后重试')
          if (response.statusCode !== 200) throw new Error('更新服务暂不可用，请重试')
          const manifest = parseManifestBuffer(response.data, this.url)
          const newer = newerVersion(manifest.version, this.current)
          this.manifest = manifest
          this.emit({firmwareLatest: manifest.version, firmwareAvailable: newer,
            firmwareSize: (manifest.size / 1024 / 1024).toFixed(2) + ' MB'})
          if (!newer) {
            this.busy = false
            this.remove(this.path); this.path = ''
            this.emit({firmwareBusy: false, firmwareStatus: '当前无需更新'})
          } else if (this.path && this.downloadedHash === manifest.sha256) {
            const path = this.path
            this.emit({firmwareStatus: '正在重新校验已下载的固件…'})
            this.verifyFile(path, manifest, generation, () => this.complete(manifest), () => {
              this.remove(path); this.path = ''
              this.fetchFirmware(generation)
            })
          } else {
            this.remove(this.path); this.path = ''
            this.emit({firmwareDownloaded: false, firmwareProgress: 0})
            this.fetchFirmware(generation)
          }
        } catch (e) { this.fail(e, active) }
      },
      fail: () => this.fail(new Error('检查失败，请确认手机网络后重试'), active)
    })
  }

  fail(error, active) {
    if (!active()) return
    this.remove(this.path)
    this.path = ''
    this.busy = false
    this.emit({firmwareBusy: false, firmwareDownloaded: false, firmwareStatus: error.message})
  }

  complete(manifest) {
    this.downloadedHash = manifest.sha256
    this.busy = false
    this.emit({firmwareBusy: false, firmwareDownloaded: true,
      firmwareProgress: 100, firmwareStatus: '新版固件已下载并通过校验，尚未安装到设备'})
  }

  verifyFile(path, manifest, generation, success, failure) {
    const active = () => !this.disposed && generation === this.generation
    const files = this.api.getFileSystemManager()
    const failed = message => { if (active()) failure(new Error(message)) }
    files.stat({path,
      success: result => {
        if (!active()) return
        if (result.stats.size !== manifest.size) { failed('固件文件大小不符，请重新下载'); return }
        files.readFile({filePath: path,
          success: result => {
            if (!active()) return
            try { verifyFirmware(result.data, manifest) }
            catch (e) { failure(e); return }
            success()
          },
          fail: () => failed('无法读取下载的固件')
        })
      },
      fail: () => failed('无法读取固件文件信息')
    })
  }

  fetchFirmware(generation) {
    const active = () => !this.disposed && generation === this.generation
    const manifest = this.manifest
    this.emit({firmwareStatus: '发现新版本，正在下载…'})
    this.download = this.api.downloadFile({
      url: manifest.url, timeout: 120000,
      success: response => {
        if (!active()) { this.remove(response.tempFilePath); return }
        if (response.statusCode !== 200 || !response.tempFilePath) {
          this.remove(response.tempFilePath)
          this.fail(new Error('固件下载失败，请重试'), active); return
        }
        const path = response.tempFilePath
        this.path = path
        this.emit({firmwareStatus: '正在校验固件…'})
        this.verifyFile(path, manifest, generation,
          () => this.complete(manifest), error => this.fail(error, active))
      },
      fail: () => this.fail(new Error('固件下载中断，请重试'), active)
    })
    this.download.onProgressUpdate?.(progress => {
      if (!active() || !this.busy) return
      if (progress.totalBytesWritten > OTA_SLOT_BYTES || progress.totalBytesExpectedToWrite > OTA_SLOT_BYTES) {
        this.fail(new Error('固件超过设备容量，已停止下载'), active)
        this.generation++
        this.download.abort()
        return
      }
      this.emit({firmwareProgress: Math.min(99, Math.max(0, progress.progress))})
    })
  }

}
