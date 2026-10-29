#!/usr/bin/env python3
"""启动墨水屏调参台。

Web Bluetooth 要求可信来源；直接双击 HTML 得到 file://，普通局域网 HTTP 也不
算可信。这个脚本只监听 127.0.0.1，并把仓库根目录作为服务根，这样
param-lab.html 才能 import ../utils/*.js。

运行：
    python tools/param-lab-server.py

默认浏览器若不支持 Web Bluetooth，把终端打印的 URL 复制到 Edge 或 Chrome。
"""

import http.server
import sys
import threading
import webbrowser
from functools import partial
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765
ROOT = Path(__file__).resolve().parent.parent
URL = f"http://{HOST}:{PORT}/tools/param-lab.html"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """只把错误打印到终端；正常加载几十个模块时不要刷屏。"""

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    handler = partial(QuietHandler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    except OSError as exc:
        sys.exit(
            f"无法监听 {HOST}:{PORT}：{exc}\n"
            f"如果调参台已经开着，直接访问：{URL}"
        )

    print(f"调参台：{URL}")
    print("按 Ctrl+C 停止。首次连接蓝牙时请在浏览器弹窗里选择 EINK 设备。")
    print("若默认浏览器没有蓝牙按钮，请把上面的 URL 复制到 Edge 或 Chrome。")

    # 服务器先进入监听状态再开浏览器，避免浏览器比 bind 更快而看到连接拒绝。
    threading.Timer(0.25, lambda: webbrowser.open(URL)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止…")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
