# 双面板墨水屏微信客户端与调参工具

配套相邻目录 `ESP-S3-EINK` 固件。一个小程序同时支持两种六色面板，连接时根据广播名自动选屏：

| 标识 | 广播名示例 | 原生栅格 | 主图文件 | BLE 压缩数据 | 默认算法 |
|---|---|---|---:|---:|---|
| 800 | EINK-800-B21A | 800×480 | 384000 B | 144000 B | hybrid |
| 1200 | EINK-1200-B21A | 1200×1600 | 1920000 B | 720000 B | atkinson |

面板尺寸和算法集中在 `utils/panel.js`。两种屏幕的裁剪方向、图片栅格、预览和传图长度跟随配置；未知的显式面板型号会报错。旧广播名 `EINK-B21A` 按 800 兼容，不应给新大屏固件使用此命名。

## 小程序

用微信开发者工具打开本目录。入口 `pages/index` 负责蓝牙扫描连接、选图裁剪、调色与抖动、上传、图片列表、缩略图、删除、选图和轮播设置。`pages/crop` 是面板对应的裁剪页；`pages/dither` 是独立算法预览页，缩小图仅用于观察效果，不负责导出设备主图。

`utils/epd-converter.js`、`epd-enhance.js`、`epd-dither.js`、`epd-palette.js` 实现共用图像管线；`epd-wire.js` 负责 3bit 线上打包。主图落盘仍为每像素 1 字节，不能直接把压缩数据拷到 TF 卡。

辅助接口 `quickConvert(path, algorithm, {panelTag: '1200'})`、`processAndExport({panelTag: '1200'})` 也按所选面板生成完整原生栅格；未指定时兼容 800。横竖自由裁剪和旋转以上传主页面为准。

`project.config.json` 中必须保留对整个 `tools/` 目录的打包忽略，避免测试、电脑工具和生成的图片超出小程序包大小。`project.private.config.json` 为已有个人设置，不参与本次整理。

## 电脑浏览器调参

```bash
python tools/param-lab-server.py
```

用 Edge / Chrome 打开工具打印的本地 URL，选择 800 或 1200 面板，调整参数后可通过 Web Bluetooth 上传。面板必须与设备一致。

## 参数对比与批量上屏

```bash
python -m pip install -r tools/requirements.txt
python tools/param-compare.py --panel 800 photo.jpg
python tools/param-compare.py --panel 1200 --mode algo photo.jpg
python tools/param-compare.py --panel 1200 photo.jpg --upload --device EINK-1200-B21A
```

对比工具从 `utils/panel.js` 读取尺寸和默认算法，输出按面板放在 `tools/_param_out/800`、`tools/_param_out/1200`，包括对比图、原生 `.bin` 和上屏对照表。

已有原生 `.bin` 可直接上传：

```bash
python tools/param_upload.py --panel 800 --name EINK-800-B21A image.bin
python tools/param_upload.py --panel 1200 --name EINK-1200-B21A image.bin
```

CLI 上传器检查设备面板、实际文件长度、应答和同名冲突，再压缩传输。上传器不会改变图片尺寸，别给它另一块屏的主图。

## OTA 与验证

远程 OTA 由固件通过 Wi-Fi + HTTPS 完成，小程序当前没有 OTA 按钮。固件构建与发布流程见 `ESP-S3-EINK/docs/panels.md`、`docs/ota.md`。两种面板共用一份通用固件和 OTA 清单；固件开机自动识别屏幕，小程序根据识别后的广播名选择图片尺寸。

```bash
node tools/panel.test.mjs
node tools/epd-helper.test.mjs
node tools/param-uploader.test.mjs
node tools/bluetooth-init.test.mjs
node tools/ble-session.test.mjs
node tools/ble-delete.test.mjs
node tools/ble-concurrency.test.mjs
node tools/ble-reliability.test.mjs
python tools/param_upload_test.py
```

主机检查覆盖面板识别、两种栅格与打包长度、命令应答和模拟上传。还需分别在两块屏上验证微信真机权限、裁剪方向、颜色、缩略图、连续上传以及轮播休眠。
