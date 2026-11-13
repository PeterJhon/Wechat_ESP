import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sha256 } from '../../utils/sha256.js'
import { FirmwareUpdater, newerVersion, validateManifest, verifyFirmware, parseManifestBuffer, httpsOrigin, OTA_SLOT_BYTES } from '../../utils/firmware-updates.js'

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
for (const size of [0, 3, 55, 56, 63, 64, 65, 2048, 1400000]) {
  const bytes = crypto.randomBytes(size)
  assert.equal(sha256(bytes), digest(bytes))
}
const manifestUrl = 'https://updates.example.org/eink/manifest.json'
const image = Buffer.alloc(352)
image[0] = 0xe9; image[23] = 1
image.writeUInt16LE(9, 12); image.writeUInt32LE(0xabcd5432, 32)
image.write('1.2.0-universal', 48); image.write('ESP_S3_EINK', 80)
image.write('EINK_BUILD_PROFILE=release\0', 128)
crypto.createHash('sha256').update(image.subarray(0, -32)).digest().copy(image, image.length - 32)
const manifest = {panel: 'universal', profile: 'release', version: '1.2.0-universal',
  url: 'https://updates.example.org/eink/app.bin', size: image.length, sha256: digest(image)}
const raw = text => Uint8Array.from(Buffer.from(text, 'utf8')).buffer
assert.equal(httpsOrigin('https://classx.fun:8443/eink/manifest.json'), 'https://classx.fun:8443')
assert.equal(httpsOrigin('https://classx.fun:443/file.bin'), httpsOrigin('https://classx.fun/file.bin'))
const portManifest = {...manifest, url: 'https://classx.fun:8443/eink/app.bin'}
validateManifest(portManifest, 'https://classx.fun:8443/eink/manifest.json')
for (const url of ['https://classx.fun/app.bin', 'https://classx.fun:8444/app.bin',
  'https://classx.fun:8443.evil.org/app.bin', 'https://classx.fun:8443@evil.org/app.bin',
  'https://@classx.fun:8443/app.bin', 'https://classx.fun:8443/app.bin#',
  'https://classx.fun:8443/app.bin#fragment', 'https://classx.fun:99999/app.bin',
  'https://127.0.0.1:8443/app.bin', 'https://classx.fun:8443\\@evil.org/app.bin'])
  assert.throws(() => validateManifest({...manifest, url}, 'https://classx.fun:8443/manifest.json'), url)
parseManifestBuffer(raw(JSON.stringify(manifest)), manifestUrl)
for (const body of ['[]', 'null', '{bad', ' '.repeat(4096), JSON.stringify({...manifest, notes: '字'.repeat(1300)})])
  assert.throws(() => parseManifestBuffer(raw(body), manifestUrl))
assert.throws(() => parseManifestBuffer(new Uint8Array([0xff]).buffer, manifestUrl))
assert.equal(newerVersion('1.10.0-universal', '1.9.9-universal'), true)
assert.equal(newerVersion('1.2.0-universal', '1.2.0-universal'), false)
assert.equal(newerVersion('1.1.9-universal', '1.2.0-universal'), false)
for (const version of ['1.2-universal', '01.2.3-universal', '65536.1.1-universal', '1.2.3-800'])
  assert.throws(() => newerVersion(version, manifest.version))
for (const patch of [{panel: '800'}, {profile: 'debug'}, {size: OTA_SLOT_BYTES + 1},
  {size: 352.5}, {sha256: 'bad'}, {url: 'http://updates.example.org/app.bin'},
  {url: 'https://other.example.org/app.bin'}, {url: 'https://u:p@updates.example.org/app.bin'}])
  assert.throws(() => validateManifest({...manifest, ...patch}, manifestUrl))
validateManifest(manifest, manifestUrl)
verifyFirmware(image, manifest)
for (const mutate of [b => b[0] = 0, b => b.writeUInt16LE(5, 12),
  b => b.write('other', 80), b => b.write('9.9.9', 48), b => b[128] = 0, b => b[b.length - 1] ^= 1]) {
  const bad = Buffer.from(image); mutate(bad)
  assert.throws(() => verifyFirmware(bad, {...manifest, sha256: digest(bad)}))
}
assert.throws(() => verifyFirmware(image.subarray(0, -1), manifest))
assert.throws(() => verifyFirmware(image, {...manifest, sha256: '0'.repeat(64)}))

function harness(current = '1.1.0-universal', url = manifestUrl) {
  const state = {}, requests = [], downloads = [], removed = []
  let progress, read, stat, aborted = 0
  const api = {
    request(x) { requests.push(x); return {abort() { aborted++ }} },
    downloadFile(x) { downloads.push(x); return {abort() { aborted++ }, onProgressUpdate(f) { progress = f }} },
    getFileSystemManager() { return {
      unlink(x) { removed.push(x.filePath) }, stat(x) { stat = x }, readFile(x) { read = x }
    } }
  }
  const client = new FirmwareUpdater(api, url, current, patch => Object.assign(state, patch))
  return {client, state, requests, downloads, removed,
    progress: p => progress(p), aborted: () => aborted,
    manifest: (value = manifest, code = 200) => requests.at(-1).success({statusCode: code, data: raw(JSON.stringify(value))}),
    download: () => downloads.at(-1).success({statusCode: 200, tempFilePath: '/tmp/app.bin'}),
    stat: size => stat.success({stats: {size}}),
    read: data => read.success({data})}
}
let h = harness(); h.client.check(); h.client.check(); assert.equal(h.requests.length, 1)
h.manifest(); assert.equal(h.downloads.length, 1)
h.progress({progress: 60, totalBytesWritten: 200, totalBytesExpectedToWrite: 352})
assert.equal(h.state.firmwareProgress, 60)
h.download(); h.stat(image.length); h.read(image)
assert.equal(h.state.firmwareDownloaded, true); assert.equal(h.state.firmwareBusy, false)
assert.match(h.state.firmwareStatus, /尚未安装/)
h.client.check(); h.manifest()
assert.equal(h.state.firmwareDownloaded, false, 'cached file must be revalidated')
h.stat(image.length); h.read(image)
assert.equal(h.downloads.length, 1, 'reuse revalidated session download')
h.client.dispose(); assert(h.removed.includes('/tmp/app.bin'))

for (const current of ['1.2.0-universal', '1.3.0-universal']) {
  h = harness(current); h.client.check(); h.manifest()
  assert.equal(h.downloads.length, 0); assert.equal(h.state.firmwareAvailable, false)
}
h = harness(undefined, ''); h.client.check(); assert.equal(h.requests.length, 0)
h = harness(); h.client.check(); h.manifest(manifest, 404)
assert.equal(h.state.firmwareBusy, false); assert.equal(h.downloads.length, 0)
assert.match(h.state.firmwareStatus, /暂未发布/)
assert.doesNotMatch(h.state.firmwareStatus, /最新|无需更新/)
h = harness(); h.client.check(); h.requests[0].fail({})
assert.equal(h.state.firmwareBusy, false)
h.client.check(); h.manifest(); h.download(); h.stat(123)
assert.equal(h.state.firmwareDownloaded, false); assert(h.removed.includes('/tmp/app.bin'))
h = harness(); h.client.check(); h.manifest(); h.download(); h.stat(image.length)
const corrupt = Buffer.from(image); corrupt[200] = 1; h.read(corrupt)
assert.equal(h.state.firmwareDownloaded, false); assert.match(h.state.firmwareStatus, /校验失败/)
h = harness(); h.client.check(); h.manifest()
h.progress({progress: 2, totalBytesWritten: 1, totalBytesExpectedToWrite: OTA_SLOT_BYTES + 1})
assert(h.aborted() > 0); h.download(); assert(h.removed.includes('/tmp/app.bin'))
h = harness(); h.client.check(); h.client.dispose(); const snapshot = {...h.state}
h.manifest(); assert.deepEqual(h.state, snapshot); assert.equal(h.downloads.length, 0)
h = harness(); h.client.check(); h.manifest(); h.client.dispose(); h.download()
assert(h.removed.includes('/tmp/app.bin')); assert.equal(h.state.firmwareDownloaded, false)
h = harness(); h.client.check(); h.manifest(); h.client.cancel()
const cancelled = {...h.state}; h.download()
assert.deepEqual(h.state, cancelled); assert.match(h.state.firmwareStatus, /取消/)
assert(h.removed.includes('/tmp/app.bin')); assert(h.aborted() > 0)
h.client.check(); h.manifest(); h.download(); h.stat(image.length); h.read(image)
assert.equal(h.state.firmwareDownloaded, true, 'retry after cancellation')
h.client.check(); h.manifest(); h.stat(image.length); h.read(corrupt)
assert.equal(h.downloads.length, 3, 'corrupted cached firmware is downloaded again')
h.client.dispose()
console.log('PASS: numeric versions, manifest validation, SHA-256, image identity, automatic download, retries, size limits and stale-session cleanup')
