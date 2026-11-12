# 开发说明

`utils/panel.js` 是面板尺寸与默认算法的统一来源；未知的显式面板型号拒绝连接。辅助转换接口同样读取面板配置。

图片处理管线位于 `utils/epd-converter.js`、`epd-enhance.js`、`epd-dither.js`、`epd-palette.js`。线上打包位于 `epd-wire.js`，须与固件解包位序一致，参见 [BLE 协议](../../ESP-S3-EINK/docs/protocol.md)。

## 运行入口

| 命令 | 用途 |
|---|---|
| `python tools/param-lab-server.py` | 启动浏览器调参工具 |
| `python tools/param-compare.py --panel 800 photo.jpg` | 输出面板对应的参数对比图和主图 |
| `python tools/param-compare.py --panel 1200 photo.jpg --upload --device EINK-1200-B21A` | 批量生成并上传 |
| `python tools/param_upload.py --panel 800 --name EINK-800-B21A image.bin` | 上传原生主图 |
| `python tools/run_tests.py` | 主机回归 |

测试集中在 `tools/tests/`，工具入口继续保留在 `tools/`。修改目录时同步更新导入、测试 runner 和文档链接。

`project.config.json` 须忽略 tools/ 和 docs/ 的打包，避免电脑工具、测试和说明进入小程序包。不要提交生成的图片、缓存、个人设置或凭据。

BLE 会话状态保留在首页逻辑中。新增异步回调须验证设备和会话；释放操作只能影响自己拥有的等待与定时器。共用 ACK 编号的操作必须互斥，不能通过重新注册 waiter 覆盖进行中的事务。
