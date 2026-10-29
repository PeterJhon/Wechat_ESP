#!/usr/bin/env python3
"""参数对比工具 —— 把同一张图按多组「算法 × 参数」渲染出来，并排给你挑。

为什么要有它：屏幕上的观感只有你的眼睛能判断，靠猜数值改参数是瞎调。
这个脚本让同一张图在各种参数下的**抖动图案**直接并排摊开，你指哪组好，
就把那组定成该面板的默认值。

用法：
    python tools/param-compare.py 照片.jpg                 # 参数扫描（默认）
    python tools/param-compare.py 一张.jpg 另一张.jpg       # 多张，各一个子目录
    python tools/param-compare.py --mode=algo 照片.jpg      # 改为换算法对比
    python tools/param-compare.py --mode=combo 照片.jpg     # 改为组合扫描
    python tools/param-compare.py                           # 无参时用内置合成图

    python tools/param-compare.py 照片.jpg --upload         # 渲染完直接经蓝牙传到开发板
    python tools/param-compare.py 照片.jpg --upload --device=EINK-1200-B21A

--upload 需要先 pip install bleak；不装也能正常渲染，只是不能上传。
同一批图的文件名用同一个时间前缀、序号连续，传上去后在列表里是连着的。
加 --no-preview 可让 --upload 不传缩略图（设备列表里就没有缩略图）。

三种模式：
    params（默认）固定算法，**每次只动一个增强参数** —— 亮度 / 对比度 /
                  饱和度 / gamma / 暖色。一次只改一个才看得出每个旋钮的
                  作用方向与幅度。调参第一步走这个。
    combo         把 params 看出方向的旋钮组合起来，找平衡点。重点是饱和度
                  与对比度的相互抵消。
    algo          固定参数，只换抖动算法。

输出（默认写到 tools/_param_out/）：
    sheet.png        并排对比图，先看这张
    detail_*.png     每组在暗部的 1:1 裁切，用来判断“暗部糊不糊”
    <id>.png         每组的完整单图，可以放大细看
    sd/*.bin         拷到 TF 卡根目录，或加 --upload 从电脑蓝牙直接传

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
from datetime import datetime
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
    sys.exit("需要 Pillow：pip install -r tools/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "_param_out"

W, H = 1200, 1600          # 1200×1600 面板
BASE = dict(brightness=1.05, saturation=1.35, gamma=0.85, contrast=1.1, warmth=1.05)
# 上屏用的文件名前缀。固件只认 ^\d{8}-\d{6}-\d{3}$，且按名字排序 ——
# 每次运行取当前时刻，所有图共用一个前缀、序号全局递增，这样它们在列表里
# 连在一起，重跑也不会撞上一轮的名字（设备会拒绝同名上传）。
STEM_BASE = datetime.now().strftime("%Y%m%d-%H%M%S")
_stem_sequence = 0


def next_stem():
    """给下一张产出取名字。序号跨源图、跨变体连续。"""
    global _stem_sequence
    if _stem_sequence > 999:
        sys.exit("一次运行超过 1000 张，文件名里的 3 位序号不够用")
    stem = f"{STEM_BASE}-{_stem_sequence:03d}"
    _stem_sequence += 1
    return stem


ALGO = "atkinson"      # 参数扫描时固定用这个算法（上屏实测选定的）


def variants_algo():
    """算法对比：固定当前参数，只换抖动算法。"""
    return [
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


def variants_params():
    """参数扫描：固定算法，每次只动一个增强参数。

    一次只改一个才看得出每个旋钮的作用方向与幅度；同时改两个就分不清是
    谁的功劳。第一组是基准（= 当前默认值），其余都相对它只动一项。

    各旋钮的方向（写在这里，省得每次都重新推）：
      gamma     <1 提亮中间调、>1 压暗；对“暗部有没有细节”影响最大
      contrast  >1 拉开明暗；对“发灰”影响最大，但过高会让渐变出色块
      saturation>1 提艳；六色屏本来就饱和，过高会让像素过早全落到某个墨色
      brightness 整体加减；和 gamma 有重叠，先调 gamma 通常更有效
      warmth    >1 偏暖（红增蓝减）；只有肤色/暖场景看得出
    """
    def v(**kw):
        return dict(BASE, dither=ALGO, **kw)

    return [
        ("p00_基准",      f"基准 · 当前默认（{ALGO}）",        v()),

        ("p01_饱和1.10",  "饱和 1.10（降）",                   v(saturation=1.10)),
        ("p02_饱和1.60",  "饱和 1.60（升）",                   v(saturation=1.60)),
        ("p03_饱和1.90",  "饱和 1.90（升更多）",                v(saturation=1.90)),

        ("p04_对比0.95",  "对比 0.95（降）",                   v(contrast=0.95)),
        ("p05_对比1.30",  "对比 1.30（升）",                   v(contrast=1.30)),
        ("p06_对比1.50",  "对比 1.50（升更多）",                v(contrast=1.50)),

        ("p07_gamma0.70", "gamma 0.70（暗部更亮）",             v(gamma=0.70)),
        ("p08_gamma0.75", "gamma 0.75",                       v(gamma=0.75)),
        ("p09_gamma1.00", "gamma 1.00（中性）",                v(gamma=1.00)),
        ("p10_gamma1.15", "gamma 1.15（整体压暗）",             v(gamma=1.15)),

        ("p11_亮度0.92",  "亮度 0.92（降）",                   v(brightness=0.92)),
        ("p12_亮度1.18",  "亮度 1.18（升）",                   v(brightness=1.18)),

        ("p13_暖色0.95",  "暖色 0.95（偏冷）",                  v(warmth=0.95)),
        ("p14_暖色1.15",  "暖色 1.15（偏暖）",                  v(warmth=1.15)),
    ]


def variants_combo():
    """组合扫描：把上一轮看出方向的旋钮配起来。

    关键未知数是**饱和度与对比度相互抵消** —— 数据上它们反向（提对比让黑白
    都增加、挤压彩色空间），所以"又鲜又有劲"未必同时拿得到，这组就是来找
    平衡点的。所以主体是「gamma 固定、扫 饱和 × 对比」的方格，再换 gamma
    档位、并加两端包抄。

    gamma 是上一轮确认最强的旋钮，所以先把它定在 0.75（暗部略提亮）再扫另两个。
    """
    def v(**kw):
        return dict(BASE, dither=ALGO, **kw)

    return [
        ("c00_基准",             "基准 · 当前默认",                     v()),

        # —— gamma 0.75 下的 饱和 × 对比 方格 ——
        ("c01_.75_1.5_1.10",     "g.75 饱和1.50 对比1.10（柔和）",       v(gamma=0.75, saturation=1.50, contrast=1.10)),
        ("c02_.75_1.5_1.35",     "g.75 饱和1.50 对比1.35",              v(gamma=0.75, saturation=1.50, contrast=1.35)),
        ("c03_.75_1.8_1.10",     "g.75 饱和1.80 对比1.10（鲜）",         v(gamma=0.75, saturation=1.80, contrast=1.10)),
        ("c04_.75_1.8_1.35",     "g.75 饱和1.80 对比1.35（鲜+劲）",       v(gamma=0.75, saturation=1.80, contrast=1.35)),
        ("c05_.75_2.0_1.35",     "g.75 饱和2.00 对比1.35（极鲜）",        v(gamma=0.75, saturation=2.00, contrast=1.35)),

        # —— 换 gamma 档位，其余保持 c04 ——
        ("c06_.65_1.8_1.35",     "g.65 饱和1.80 对比1.35（暗部更亮）",     v(gamma=0.65, saturation=1.80, contrast=1.35)),
        ("c07_.95_1.8_1.35",     "g.95 饱和1.80 对比1.35（整体压暗）",     v(gamma=0.95, saturation=1.80, contrast=1.35)),

        # —— 用亮度代替 gamma 提亮：两者都能提亮，但方式不同 ——
        ("c08_亮1.15",           "亮度1.15 饱和1.80 对比1.20（g.85）",     v(brightness=1.15, saturation=1.80, contrast=1.20)),

        # —— 暖色微调 ——
        ("c09_暖1.10",           "g.75 饱和1.80 对比1.35 暖1.10",         v(gamma=0.75, saturation=1.80, contrast=1.35, warmth=1.10)),

        # —— 两端包抄，用来确认边界 ——
        ("c10_全拉满",            "g.65 饱和2.00 对比1.50（最激进）",       v(gamma=0.65, saturation=2.00, contrast=1.50)),
        ("c11_最柔和",            "g.95 饱和1.35 对比1.00（最保守）",       v(gamma=0.95, saturation=1.35, contrast=1.00)),
    ]


MODES = {"algo": variants_algo, "params": variants_params, "combo": variants_combo}


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


def run_one(src, out, variants):
    """处理一张图：渲染全部变体，把各产物写进 out/。"""
    out.mkdir(parents=True, exist_ok=True)

    img = prepare(src)
    print(f"\n{'=' * 72}")
    print(f"源图：{src.name if src else '（内置合成测试图）'}  →  裁切到 {W}×{H}")
    print("渲染中（每行末尾是各墨色占比，能看出哪些墨根本没被用上）：")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        rgba = tmp / "src.rgba"
        # 必须转 RGBA：RGB 的 tobytes() 是 3 字节/像素，渲染端按 4 字节读
        rgba.write_bytes(img.convert("RGBA").tobytes())

        job = {
            "width": W, "height": H, "rgbaPath": str(rgba), "outDir": str(tmp),
            "variants": [{"id": i, "label": l, "config": c} for i, l, c in variants],
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
        # 每次运行的名字不同，所以先清掉上一轮的，否则目录会越攒越多，
        # --upload 也会把旧图一起传上去。
        sd = out / "sd"
        if sd.exists():
            for old in sd.glob("*.bin"):
                old.unlink()
        sd.mkdir(exist_ok=True)
        for m in manifest:
            stem = next_stem()
            shutil.copyfile(tmp / "bin" / f"{m['id']}.bin", sd / f"{stem}.bin")
            m["stem"] = stem

    # —— 上屏用的对照表。放在 PNG 之前写：它是上屏必需的，不该被
    #    ✓一个被占住的 PNG 挡住。——
    lines = [
        "把 sd/ 里的 .bin 拷到 TF 卡根目录插卡上电；或加 --upload 经蓝牙直接传。",
        "在小程序的文件列表里按下面的名字选中即可显示；每张刷新约 31 秒。",
        "名字按时间排序，所以这些图在列表里是连在一起的。",
        "",
        pad("文件名", 28) + pad("参数", 42) + "墨色占比",
        "-" * 104,
    ]
    for m in manifest:
        lines.append(pad(m["stem"] + ".bin", 28) + pad(m["label"], 42) +
                     " ".join(m["share"]))
    (out / "上屏对照表.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # —— 单图 ——
    for m in manifest:
        save_png(rendered[m["id"]].convert("RGB"), out / f"{m['id']}.png")

    # —— 中心 1:1 裁切。取中心而不是固定角落：真实照片的主体通常在中间，
    #    看纹理和噪点比看边角有用。——
    cx, cy = W // 2, H // 2
    crop_box = (cx - 200, cy - 200, cx + 200, cy + 200)
    for m in manifest:
        save_png(rendered[m["id"]].convert("RGB").crop(crop_box),
                 out / f"detail_{m['id']}.png")

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
    save_png(sheet, out / "sheet.png")

    print(f"\n输出目录：{out}")
    print("  sheet.png            并排总图（先看这张）")
    print("  detail_*.png         中心 1:1 裁切")
    print("  <id>.png             每组完整单图")
    print("  sd/*.bin             拷到 TF 卡上屏，或加 --upload 直接传")
    return out


def main():
    argv = sys.argv[1:]
    mode = "params"            # 默认参数扫描：调增强参数比换算法更常做
    upload = False
    device = None
    no_preview = False
    rest = []
    for a in argv:
        if a == "--upload":
            upload = True
        elif a == "--no-preview":
            no_preview = True
        elif a.startswith("--device="):
            device = a.split("=", 1)[1]
        elif a.startswith("--mode="):
            mode = a.split("=", 1)[1]
            if mode not in MODES:
                sys.exit(f"未知模式 {mode}，可选：{'、'.join(MODES)}")
        elif a.startswith("-"):
            sys.exit(f"未知选项 {a}")
        else:
            rest.append(a)

    if (device or no_preview) and not upload:
        sys.exit("--device/--no-preview 只和 --upload 一起用")

    variants = MODES[mode]()
    srcs = [Path(a) for a in rest]
    for s in srcs:
        if not s.exists():
            sys.exit(f"找不到图片：{s}")
    if not srcs:
        srcs = [None]          # 无参时用内置合成测试图

    print(f"模式：{mode}（{len(variants)} 组变体）")
    outputs = []
    for s in srcs:
        # 目录名带上模式：不同模式的产出互不覆盖，好对照
        name = f"{s.stem if s else '_合成测试图'}_{mode}"
        outputs.append(run_one(s, OUT / name, variants))

    if upload:
        bins = [p for out in outputs for p in (out / "sd").glob("*.bin")]
        bins.sort(key=lambda p: p.stem)
        if not bins:
            sys.exit("没有可上传的 .bin")
        cmd = [sys.executable,
               str(Path(__file__).with_name("param_upload.py")),
               *map(str, bins)]
        if device:
            cmd.append(f"--name={device}")
        if no_preview:
            cmd.append("--no-preview")
        record = OUT / "上传记录.txt"
        cmd.append(f"--record={record}")
        print(f"\n{'=' * 72}")
        print(f"经蓝牙上传 {len(bins)} 张（需要 bleak；同名会自动改名）…")
        r = subprocess.run(cmd, cwd=ROOT)
        if r.returncode != 0:
            sys.exit(f"蓝牙上传失败（退出码 {r.returncode}）；"
                     f".bin 仍在 {OUT}，可拷 TF 卡或重试")

    print(f"\n{'=' * 72}")
    print(f"全部输出在：{OUT}")
    print("⚠ PNG 是 sRGB，六种墨水的实际色值不等于 sRGB ——")
    print("  颜色浓淡的判断请以屏上为准，PNG 只用来看图案和噪点。")


if __name__ == "__main__":
    main()
