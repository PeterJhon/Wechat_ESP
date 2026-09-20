#!/usr/bin/env python3
"""参数对比工具 —— 把同一张图按多组「算法 × 参数」渲染出来，并排给你挑。

为什么要有它：屏幕上的观感只有你的眼睛能判断，靠猜数值改参数是瞎调。
这个脚本让同一张图在各种参数下的**抖动图案**直接并排摊开，你指哪组好，
就把那组定成该面板的默认值。

用法：
    python tools/param-compare.py                      # 用内置合成测试图
    python tools/param-compare.py 你的照片.jpg          # 用真实照片

输出（默认写到 tools/_param_out/）：
    sheet.png        并排对比图，先看这张
    detail_*.png     每组在暗部的 1:1 裁切，用来判断“暗部糊不糊”
    <id>.png         每组的完整单图，可以放大细看

诚实的限制：PNG 走的是 sRGB，而六种墨水的实际色值并不等于 sRGB（“红”
实际偏砖红）。所以这张图能准确反映**抖动图案、层次、噪点**，但**颜色浓淡
的观感会和你屏幕上看到的有出入** —— 颜色要上屏看。

⚠ 产出目录在小程序工程内（tools/_param_out/），跑一次约 25 MB（9 个
1.92 MB 的 .bin）。微信的打包器**不读 .gitignore**，只认 project.config.json
的 packOptions.ignore —— 那里必须保留 tools 的忽略项，否则真机调试上传会报
80051（超过 2 MB 上限）。
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Windows 中文控制台默认 GBK，而本脚本与 node 的输出都是 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("需要 Pillow：pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "_param_out"

W, H = 1200, 1600          # 1200×1600 面板
BASE = dict(brightness=1.05, saturation=1.35, gamma=0.85, contrast=1.1, warmth=1.05)
# 上屏用的文件名前缀。固件只认 ^\d{8}-\d{6}-\d{3}$，且按名字排序 ——
# 用同一时刻加序号，9 张会在列表里连在一起，方便一张张翻。
STEM_BASE = "20260920-235900"

# 变体表。围绕用户报的两个症状设计：
#   “暗部糊成一团” → hybrid 的深色分支只随机混两色，换成真正的误差扩散试试
#   “颜色灰、不够鲜” → 提高 saturation / contrast
VARIANTS = [
    ("a0_hybrid_默认", "hybrid · 当前默认值",               dict(BASE, dither="hybrid")),
    ("a1_floyd",       "floyd · 同参数",                    dict(BASE, dither="floyd")),
    ("a2_jjn",         "jjn · 同参数",                      dict(BASE, dither="jjn")),
    ("a3_stucki",      "stucki · 同参数",                   dict(BASE, dither="stucki")),
    ("a4_atkinson",    "atkinson · 同参数",                 dict(BASE, dither="atkinson")),
    ("b0_jjn_鲜艳",     "jjn · 饱和1.6 对比1.25",            dict(BASE, dither="jjn", saturation=1.6, contrast=1.25)),
    ("b1_stucki_鲜艳",  "stucki · 饱和1.6 对比1.25",         dict(BASE, dither="stucki", saturation=1.6, contrast=1.25)),
    ("b2_floyd_提暗部", "floyd · 饱和1.6 对比1.25 gamma0.72", dict(BASE, dither="floyd", saturation=1.6, contrast=1.25, gamma=0.72)),
    ("c0_jjn_黑惩罚60", "jjn · 鲜艳 + blackPenalty 60",       dict(BASE, dither="jjn", saturation=1.6, contrast=1.25, blackPenalty=60)),
]


def synthetic() -> Image.Image:
    """内置测试图：刻意压上用户报的两个症状。

    左半是有细节的暗场景（暗部糊不糊），右半是肤色/饱和色块与平滑渐变
    （颜色鲜不鲜、过渡有没有色块）。
    """
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    half = W // 2

    # 左半：暗部。极暗底色上叠细线与同心圆，糊掉就看不见。
    for y in range(H):
        v = int(8 + 26 * (y / H))
        d.line([(0, y), (half, y)], fill=(v, v, v + 3))
    for i in range(0, H, 18):
        d.line([(0, i), (half, i)], fill=(52, 50, 56))
    for r in range(40, 300, 34):
        d.ellipse([half // 2 - r, H // 2 - r, half // 2 + r, H // 2 + r],
                  outline=(70, 66, 74), width=2)

    # 右上：肤色阶梯（六色屏最难还原的就是肤色）
    for i in range(6):
        y0 = int(i * H / 12)
        f = 0.72 + i * 0.05
        d.rectangle([half, y0, W, y0 + H // 12],
                    fill=(int(232 * f), int(186 * f), int(150 * f)))

    # 右中：饱和色块 + 灰阶（看哪些墨真被用上）
    sw = (W - half) // 3
    for i, c in enumerate([(220, 30, 30), (240, 200, 20), (30, 60, 200),
                           (30, 170, 70), (128, 128, 128), (200, 128, 40)]):
        d.rectangle([half + (i % 3) * sw, H // 2 + (i // 3) * (H // 8),
                     half + (i % 3 + 1) * sw, H // 2 + (i // 3 + 1) * (H // 8)], fill=c)

    # 右下：平滑渐变（看有没有色块/条带）
    for y in range(H * 3 // 4, H):
        for x in range(half, W):
            t = (x - half) / (W - half)
            d.point((x, y), fill=(int(255 * t), int(255 * (1 - t)), int(255 * abs(0.5 - t) * 2)))
    return img


def prepare(src):
    """按 rasterizeToPanel 的做法：等比缩放后居中裁切到 1200×1600。"""
    img = Image.open(src).convert("RGB") if src else synthetic()
    scale = max(W / img.width, H / img.height)
    img = img.resize((max(1, round(img.width * scale)),
                      max(1, round(img.height * scale))), Image.LANCZOS)
    left = (img.width - W) // 2
    top = (img.height - H) // 2
    return img.crop((left, top, left + W, top + H))


def pad(s, width):
    """按**显示宽度**补齐（中文占两列）。用 str.ljust 会按字符数补，
    中文行就全歪了。"""
    w = sum(2 if ord(c) > 0x2E80 else 1 for c in s)
    return s + " " * max(0, width - w)


def save_png(img, path):
    """写 PNG。目标文件可能被看图软件占着（Windows 上会报 EINVAL），
    那就退到一个带后缀的新名字，别让整轮渲染白跑。"""
    try:
        img.save(path)
        return path
    except OSError as e:
        alt = path.with_name(f"{path.stem}_new{path.suffix}")
        img.save(alt)
        print(f"  ! {path.name} 写不进去（{e}），已改写到 {alt.name}")
        return alt


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if src and not src.exists():
        sys.exit(f"找不到图片：{src}")
    OUT.mkdir(parents=True, exist_ok=True)

    img = prepare(src)
    print(f"源图：{src if src else '（内置合成测试图）'}  →  裁切到 {W}×{H}\n")
    print("渲染中（每行末尾是各墨色占比，能看出哪些墨根本没被用上）：")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        rgba = tmp / "src.rgba"
        # 必须转 RGBA：RGB 的 tobytes() 是 3 字节/像素，渲染端按 4 字节读
        rgba.write_bytes(img.convert("RGBA").tobytes())

        job = {
            "width": W, "height": H, "rgbaPath": str(rgba), "outDir": str(tmp),
            "variants": [{"id": i, "label": l, "config": c} for i, l, c in VARIANTS],
        }
        (tmp / "job.json").write_text(json.dumps(job), encoding="utf-8")

        r = subprocess.run(["node", str(ROOT / "tools" / "param-render.mjs"),
                            str(tmp / "job.json")],
                           cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            sys.exit(f"渲染失败：\n{r.stdout}\n{r.stderr}")
        print(r.stdout, end="")

        manifest = json.loads((tmp / "manifest.json").read_text(encoding="utf-8"))
        rendered = {m["id"]: Image.frombytes("RGBA", (W, H),
                                             (tmp / f"{m['id']}.rgba").read_bytes())
                    for m in manifest}

        # —— 设备能直接读的 .bin —— 必须趁临时目录还在时拷出来。
        # 文件名要满足固件的 ^\d{8}-\d{6}-\d{3}$，否则挂载扫描时会被忽略。
        sd = OUT / "sd"
        sd.mkdir(exist_ok=True)
        for n, m in enumerate(manifest):
            stem = f"{STEM_BASE}-{n:03d}"
            shutil.copyfile(tmp / "bin" / f"{m['id']}.bin", sd / f"{stem}.bin")
            m["stem"] = stem

    # —— 上屏用的对照表。放在 PNG 之前写：它是上屏必需的，不该被
    #    ✓一个被占住的 PNG 挡住。——
    lines = [
        "把 sd/ 里的 .bin 全部拷到 TF 卡根目录，插卡上电。",
        "在小程序的文件列表里按下面的名字选中即可显示；每张刷新约 31 秒。",
        "名字按时间排序，所以列表里它们是连在一起的 9 张。",
        "",
        pad("文件名", 28) + pad("参数", 42) + "墨色占比",
        "-" * 104,
    ]
    for m in manifest:
        lines.append(pad(m["stem"] + ".bin", 28) + pad(m["label"], 42) +
                     " ".join(m["share"]))
    (OUT / "上屏对照表.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # —— 单图 ——
    for m in manifest:
        save_png(rendered[m["id"]].convert("RGB"), OUT / f"{m['id']}.png")

    # —— 暗部 1:1 裁切（落在合成图的暗场景区域内）——
    crop_box = (120, 560, 520, 960)
    for m in manifest:
        save_png(rendered[m["id"]].convert("RGB").crop(crop_box),
                 OUT / f"detail_{m['id']}.png")

    # —— 并排总图 ——
    tile_w, tile_h, cols = 288, 384, 3
    rows = (len(manifest) + cols - 1) // cols
    gap, label_h = 10, 34          # 不要叫 pad —— 会和上面的 pad() 函数撞名
    sheet = Image.new("RGB", (cols * (tile_w + gap) + gap,
                              rows * (tile_h + label_h + gap) + gap), (26, 26, 30))
    d = ImageDraw.Draw(sheet)
    for n, m in enumerate(manifest):
        cx = gap + (n % cols) * (tile_w + gap)
        cy = gap + (n // cols) * (tile_h + label_h + gap)
        d.text((cx + 2, cy + 4), m["label"][:34], fill=(235, 235, 235))
        tile = rendered[m["id"]].convert("RGB").resize((tile_w, tile_h), Image.LANCZOS)
        sheet.paste(tile, (cx, cy + label_h))
    save_png(sheet, OUT / "sheet.png")

    print(f"\n输出目录：{OUT}")
    print("  sd/*.bin             ← 拷到 TF 卡根目录，上屏看真实效果")
    print("  上屏对照表.txt        ← 文件名对应哪组参数")
    print("  sheet.png            并排总图（电脑上看图案，颜色作不得准）")
    print("  detail_*.png         暗部 1:1 裁切")
    print("  <id>.png             每组完整单图")
    print(f"\n⚠ PNG 是 sRGB，六种墨水的实际色值不等于 sRGB ——")
    print(f"   颜色浓淡的判断请以屏上为准，PNG 只用来看图案和噪点。")


if __name__ == "__main__":
    main()
