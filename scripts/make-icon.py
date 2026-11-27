#!/usr/bin/env python3
"""生成 AI-KM 应用图标（三角图谱 + 中央六边形 AI）。

唯一图标源文件。跑一次同时产出：

- resources/icons/ai-km-icon.svg       矢量母版
- resources/icons/ai-km-icon-2048.png  位图母版（2048×2048）
- build/icons/{16,24,32,48,64,128,256,512}x*.png   electron-builder 打包用
- public/icon.png                      Windows 安装包 / 窗口图标（512）
- public/favicon-16.png / favicon-32.png / favicon.ico（多尺寸）

设计：
- 深色圆角底 + 轻微中心光晕；
- 三个角上的圆形节点（青→蓝紫渐变），中间平顶六边形；
- 三个圆各连到六边形一条边的中点，线不进入圆/六边形内部；
- 六边形正中一枚 “AI” 小字。

依赖：Python 3 + Pillow。用法：

    python scripts/make-icon.py          # 重新生成全部尺寸
    python scripts/make-icon.py --check  # 只检查现有文件是否齐全，不写盘
"""
from __future__ import annotations

import argparse
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 512          # 逻辑尺寸（SVG 视口）
SS = 4           # 超采样倍数：先画 2048 再缩小
BG_TOP, BG_BOTTOM = '#111B2E', '#06090F'
EDGE = '#38BDF8'
NODE_TOP, NODE_BOTTOM = '#22D3EE', '#7C6CFF'
RING = '#E0F2FE'
HEX_FILL = '#0F1E3C'
AI_COLOR = '#E0F2FE'
CIRCLE_R = 0.080 * S
HEX_R = 0.135 * S
ORBIT_R = 0.32 * S
LINE_W = 0.028 * S


def hx(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def lerp(a, b, t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def radial_background(top: str, bottom: str) -> Image.Image:
    """深色竖向渐变 + 圆角方形裁剪（透明圆角）。"""
    W = S * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    grad = Image.new('RGBA', (W, W))
    d = ImageDraw.Draw(grad)
    for y in range(W):
        d.line([(0, y), (W, y)], fill=lerp(hx(top), hx(bottom), y / max(1, W - 1)) + (255,))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(S * 0.22 * SS), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def add_glow(img: Image.Image) -> None:
    W = img.width
    halo = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse(
        [W * 0.18, W * 0.12, W * 0.82, W * 0.78], fill=hx('#3B82F6') + (40,)
    )
    halo = halo.filter(ImageFilter.GaussianBlur(S * 0.13 * SS))
    img.alpha_composite(halo)


def pt(deg: float, r: float) -> tuple[float, float]:
    a = math.radians(deg)
    return (S / 2 + r * math.cos(a), S / 2 - r * math.sin(a))


def grad_color(y: float):
    return lerp(hx(NODE_TOP), hx(NODE_BOTTOM), max(0.0, min(1.0, y / S)))


def render() -> Image.Image:
    img = radial_background(BG_TOP, BG_BOTTOM)
    add_glow(img)
    d = ImageDraw.Draw(img)

    circles = [pt(90, ORBIT_R), pt(210, ORBIT_R), pt(330, ORBIT_R)]
    # 平顶六边形：顶点在 0/60/…，顶部是平边；连接点落在三条边的中点
    hexagon = [pt(a, HEX_R) for a in (0, 60, 120, 180, 240, 300)]
    targets = [pt(a, HEX_R * math.cos(math.radians(30))) for a in (90, 210, 330)]

    lw = int(LINE_W * SS)
    # 圆 → 六边形边中点：线画到边内侧，随后被六边形填充盖住，避免接缝
    for cc, hv in zip(circles, targets):
        dx, dy = hv[0] - cc[0], hv[1] - cc[1]
        dist = math.hypot(dx, dy) or 1
        ux, uy = dx / dist, dy / dist
        pa = (cc[0] + ux * CIRCLE_R, cc[1] + uy * CIRCLE_R)
        pb = (hv[0] + ux * S * 0.020, hv[1] + uy * S * 0.020)
        d.line(
            [(pa[0] * SS, pa[1] * SS), (pb[0] * SS, pb[1] * SS)],
            fill=hx(EDGE) + (255,), width=lw,
        )

    # 六边形：深色填充 + 亮青描边
    d.polygon(
        [(x * SS, y * SS) for x, y in hexagon],
        fill=hx(HEX_FILL) + (255,), outline=hx(EDGE) + (255,), width=lw,
    )

    # 中央 “AI”：优先用 Segoe UI Bold，缺失时退回默认字体
    font_size = int(0.078 * S * SS)
    font = None
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            font = ImageFont.truetype(name, font_size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = 'AI'
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = S * SS / 2 - tw / 2 - bbox[0]
    ty = S * SS / 2 - th / 2 - bbox[1] - 0.004 * S * SS
    d.text((tx, ty), text, font=font, fill=hx(AI_COLOR) + (255,))

    # 三个圆节点：渐变填充 + 浅色描边，内部不画任何线
    node_layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    nd = ImageDraw.Draw(node_layer)
    for (x, y) in circles:
        r = CIRCLE_R * SS
        cx, cy = x * SS, y * SS
        size = int(r * 2) + 2
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        fill = Image.new('RGBA', (size, size))
        fd = ImageDraw.Draw(fill)
        top_color, bottom_color = grad_color(y - CIRCLE_R), grad_color(y + CIRCLE_R)
        for yy in range(size):
            fd.line([(0, yy), (size, yy)], fill=lerp(top_color, bottom_color, yy / max(1, size - 1)) + (255,))
        fill.putalpha(mask)
        node_layer.alpha_composite(fill, (int(cx - size / 2), int(cy - size / 2)))
        nd.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=hx(RING) + (235,), width=max(6, int(S * 0.010 * SS)),
        )
    img.alpha_composite(node_layer)
    return img


# ------------------------------------------------------------------ SVG 母版
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#111B2E"/><stop offset="1" stop-color="#06090F"/></linearGradient>
<radialGradient id="haze"><stop stop-color="#3B82F6" stop-opacity=".28"/><stop offset="1" stop-color="#3B82F6" stop-opacity="0"/></radialGradient>
<linearGradient id="node" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#22D3EE"/><stop offset="1" stop-color="#7C6CFF"/></linearGradient>
</defs>
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
<circle cx="256" cy="230" r="180" fill="url(#haze)"/>
<g stroke="#38BDF8" stroke-width="14" stroke-linecap="round">
<line x1="256" y1="133.12" x2="256" y2="196.14"/>
<line x1="149.58" y1="317.44" x2="204.16" y2="285.93"/>
<line x1="362.42" y1="317.44" x2="307.84" y2="285.93"/>
</g>
<polygon points="325.12,256 290.56,196.14 221.44,196.14 186.88,256 221.44,315.86 290.56,315.86" fill="#0F1E3C" stroke="#38BDF8" stroke-width="14" stroke-linejoin="round"/>
<text x="256" y="256" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="700" fill="#E0F2FE">AI</text>
<g stroke="#E0F2FE" stroke-width="5" fill="url(#node)">
<circle cx="256" cy="92.16" r="40.96"/>
<circle cx="114.1" cy="337.92" r="40.96"/>
<circle cx="397.9" cy="337.92" r="40.96"/>
</g>
</svg>
'''

PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def outputs():
    return [
        os.path.join(ROOT, 'resources', 'icons', 'ai-km-icon.svg'),
        os.path.join(ROOT, 'resources', 'icons', 'ai-km-icon-2048.png'),
        *[os.path.join(ROOT, 'build', 'icons', f'{s}x{s}.png') for s in PNG_SIZES],
        os.path.join(ROOT, 'public', 'icon.png'),
        os.path.join(ROOT, 'public', 'favicon-16.png'),
        os.path.join(ROOT, 'public', 'favicon-32.png'),
        os.path.join(ROOT, 'public', 'favicon.ico'),
    ]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Generate AI-KM app icon assets')
    parser.add_argument('--check', action='store_true', help='only verify that outputs exist')
    args = parser.parse_args(argv)

    files = outputs()
    if args.check:
        missing = [f for f in files if not os.path.isfile(f) or os.path.getsize(f) == 0]
        for f in files:
            print(('OK   ' if f not in missing else 'MISS ') + os.path.relpath(f, ROOT))
        return 1 if missing else 0

    master = render()
    icons_dir = os.path.join(ROOT, 'build', 'icons')
    design_dir = os.path.join(ROOT, 'resources', 'icons')
    public_dir = os.path.join(ROOT, 'public')
    for d in (icons_dir, design_dir, public_dir):
        os.makedirs(d, exist_ok=True)

    master.resize((2048, 2048), Image.LANCZOS).save(os.path.join(design_dir, 'ai-km-icon-2048.png'))
    with open(os.path.join(design_dir, 'ai-km-icon.svg'), 'w', encoding='utf-8') as fh:
        fh.write(SVG)
    for s in PNG_SIZES:
        master.resize((s, s), Image.LANCZOS).save(os.path.join(icons_dir, f'{s}x{s}.png'))
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(public_dir, 'icon.png'))
    master.resize((16, 16), Image.LANCZOS).save(os.path.join(public_dir, 'favicon-16.png'))
    master.resize((32, 32), Image.LANCZOS).save(os.path.join(public_dir, 'favicon-32.png'))
    master.resize((256, 256), Image.LANCZOS).save(os.path.join(public_dir, 'favicon.ico'), sizes=ICO_SIZES)

    for f in files:
        print(f'{os.path.getsize(f):>8}  {os.path.relpath(f, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
