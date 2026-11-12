# 墨水屏微信小程序

配套 [ESP-S3-EINK](../ESP-S3-EINK/README.md) 固件，支持 800×480 和 1200×1600 六色面板。根据设备广播名自动选屏。

| 标识 | 主图尺寸 | 卡上字节数 | BLE 字节数 | 默认算法 |
|---|---|---:|---:|---|
| 800 | 800×480 | 384000 | 144000 | hybrid |
| 1200 | 1200×1600 | 1920000 | 720000 | atkinson |

## 目录

| 路径 | 内容 |
|---|---|
| `app.*` | 应用入口与全局样式 |
| `pages/index/` | 连接、图片处理、传图、列表与轮播 |
| `pages/crop/` | 裁剪 |
| `pages/dither/` | 算法预览 |
| `utils/` | 面板参数、调色、抖动、转换和 3bit 打包 |
| `tools/` | 电脑调参、浏览器及 Python 上传工具 |
| `tools/tests/` | JavaScript 与 Python 回归测试 |
| `docs/` | 开发与验证说明 |

## 使用

微信开发者工具打开工程，编译后用手机验证。微信须获蓝牙权限；相册仅显示部分照片时，在系统设置中调整微信的照片权限。

连接 `EINK-800-xxxx` 或 `EINK-1200-xxxx`，选择照片并裁剪、调参后上传。主图通过 3bit 压缩传输，设备解包为卡上每像素 1 字节的格式。没有同名 JPEG 的卡上图片不显示缩略图。

控制命令使用有应答写。支持时，图片采用无应答快传，每 16 包及最后一个数据包使用有应答写；上传成功仍以设备 FILE_END 应答为准。设备拒收或应答超时会报错，不以进度 100% 判成功。

上传、删除、选图、列表刷新和轮播设置对可能冲突的命令实行互斥。刷屏时被占用的图片需等待后重试删除。缩略图读取串行，缓存按设备隔离。连接回调、重试和管理任务绑定会话，断连或退出页面会清理。

## 电脑工具

```bash
python -m pip install -r tools/requirements.txt
python tools/param-lab-server.py
python tools/param-compare.py --panel 1200 --mode algo photo.jpg
python tools/param_upload.py --panel 1200 --name EINK-1200-B21A image.bin
```

浏览器调参使用支持 Web Bluetooth 的浏览器。必须选择与设备一致的面板；对比工具产物位于 `tools/_param_out/`，不提交版本库。

## OTA

小程序尚无 OTA 页面。设备支持独立网页和 Python HTTP 上传，不需要域名、证书或下载服务器；可选 HTTPS 主动拉取仍保留。见 [固件 OTA 说明](../ESP-S3-EINK/docs/ota.md)。

## 开发与验证

```bash
python tools/run_tests.py
```

- [工程开发说明](docs/development.md)
- [验证说明](docs/validation.md)

工具和测试目录不参与小程序打包；`project.private.config.json` 是个人配置，不纳入本次提交。
