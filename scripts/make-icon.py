#!/usr/bin/env python3
"""生成 AI-KM 应用图标（玻璃卡片：三层错落卡片 + 节点图）。

唯一的图标源文件。跑一次同时产出：

- resources/icons/ai-km-icon.svg       矢量母版
- resources/icons/ai-km-icon-2048.png  位图母版（2048×2048）
- build/icons/{16,24,32,48,64,128,256,512}x*.png   electron-builder 打包用
- public/icon.png                      Windows 安装包 / 窗口图标（512）
- public/favicon-16.png / favicon-32.png / favicon.ico（多尺寸）

依赖：Python 3 + Pillow（本机已装）。用法：

    python scripts/make-icon.py          # 重新生成全部尺寸
    python scripts/make-icon.py --check  # 只检查现有文件是否齐全，不写盘
"""
from __future__ import annotations

import argparse
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 512          # 逻辑尺寸（SVG 视口）
SS = 4           # 超采样倍数：先画 2048 再缩小

BG_TOP, BG_BOTTOM = '#131A2A', '#06080F'
HAZE = '#6D5BFF'
CARD_COLORS = [
    # (x0, y0, x1, y1, radius, angle, 渐变起, 渐变止, 不透明度)
    (150, 210, 386, 434, 26, 14, '#6D8BFF', '#2B3AA8', 0.82),
    (136, 178, 386, 416, 28, 6, '#22D3EE', '#116E86', 0.85),
    (122, 140, 388, 394, 30, -6, '#BFE9FF', '#C4B5FD', 0.75),
]
NODES = [(196, 218), (196, 312), (300, 264)]
EDGES = [((196, 218), (196, 312)), ((196, 218), (300, 264)), ((196, 312), (300, 264))]
NODE_R = [22, 22, 26]
TOP_ANGLE = -6          # 顶卡的旋转角，节点图跟着转


# ------------------------------------------------------------------ 基础工具
def hx(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def lerp(a, b, t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sample(stops, t: float):
    stops = [(p, hx(c)) for p, c in stops]
    if t <= stops[0][0]:
        return stops[0][1]
    for i in range(1, len(stops)):
        if t <= stops[i][0]:
            t0, c0 = stops[i - 1]
            t1, c1 = stops[i]
            return lerp(c0, c1, (t - t0) / max(1e-6, t1 - t0))
    return stops[-1][1]


def radial_background(stops, radius=112):
    """深色径向渐变 + 圆角方形裁切（透明圆角）。"""
    W = S * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    grad = Image.new('RGBA', (W, W))
    draw = ImageDraw.Draw(grad)
    cx, cy, rad = W / 2, W * 0.45, W * 0.80
    for y in range(W):
        for x in range(0, W, 2):
            t = min(1.0, math.hypot(x - cx, y - cy) / rad)
            draw.line([(x, y), (x + 1, y)], fill=sample(stops, t) + (255,))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=radius * SS, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def rotated_tile(w, h, radius, stops, alpha, angle):
    """圆角矩形 + 横向渐变，按 angle 旋转。"""
    w, h = int(w), int(h)
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    tile = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    grad = Image.new('RGBA', (w, h))
    gd = ImageDraw.Draw(grad)
    for x in range(w):
        gd.line([(x, 0), (x, h)], fill=sample(stops, x / max(1, w - 1)) + (255,))
    tile.paste(grad, (0, 0), mask)
    tile.putalpha(tile.getchannel('A').point(lambda v: int(v * alpha)))
    if angle:
        tile = tile.rotate(angle, resample=Image.BICUBIC, expand=True)
    return tile


def tile_edge(w, h, radius, angle, pct=255):
    """卡片描边（旋转后贴回）。"""
    w, h = int(w), int(h)
    edge = Image.new('L', (w, h), 0)
    ImageDraw.Draw(edge).rounded_rectangle(
        [0, 0, w - 1, h - 1], radius=radius, outline=pct, width=max(1, int(3 * SS))
    )
    if angle:
        edge = edge.rotate(angle, resample=Image.BICUBIC, expand=True)
    return edge


def paint(img, mask, stops, alpha=255):
    """用横向渐变填充 mask。"""
    W = img.width
    grad = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(grad)
    for x in range(W):
        gd.line([(x, 0), (x, W)], fill=sample(stops, x / (W - 1)) + (255,))
    if alpha < 255:
        grad.putalpha(grad.getchannel('A').point(lambda v: int(v * alpha / 255)))
    img.paste(grad, (0, 0), mask)


def mask_poly(pts):
    W = S * SS
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).polygon([(x * SS, y * SS) for x, y in pts], fill=255)
    return m


def mask_line(pts, width, closed=False):
    W = S * SS
    m = Image.new('L', (W, W), 0)
    d = ImageDraw.Draw(m)
    p = [(x * SS, y * SS) for x, y in pts]
    d.line(p + ([p[0]] if closed else []), fill=255, width=int(width * SS), joint='curve')
    r = width * SS / 2
    for x, y in (p if closed else (p[0], p[-1])):
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    return m


def disc(img, cx, cy, r, color):
    ImageDraw.Draw(img).ellipse(
        [(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=hx(color) + (255,)
    )


def glow(img, cx, cy, r, color, alpha=90):
    W = img.width
    size = int(r * 2 * SS)
    halo = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(halo)
    for i in range(40, 0, -1):
        t = i / 40
        rr = r * SS * t
        d.ellipse([size / 2 - rr, size / 2 - rr, size / 2 + rr, size / 2 + rr],
                  fill=hx(color) + (int(alpha * (1 - t) ** 2),))
    img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(8)),
                        (int(cx * SS - size / 2), int(cy * SS - size / 2)))


def rotate_pts(pts, deg, cx=256, cy=256):
    rad = math.radians(deg)
    out = []
    for x, y in pts:
        dx, dy = x - cx, y - cy
        out.append((cx + dx * math.cos(rad) - dy * math.sin(rad),
                    cy + dx * math.sin(rad) + dy * math.cos(rad)))
    return out


# ------------------------------------------------------------------ 画图标
def render() -> Image.Image:
    img = radial_background([(0, BG_TOP), (1, BG_BOTTOM)])
    glow(img, 300, 300, 200, HAZE, 80)

    # 三层卡片：底 → 中 → 顶
    for (x0, y0, x1, y1, radius, angle, c0, c1, alpha) in CARD_COLORS:
        w, h = x1 - x0, y1 - y0
        tile = rotated_tile(w * SS, h * SS, radius * SS, [(0, c0), (1, c1)], alpha, angle)
        img.alpha_composite(tile, (int(x0 * SS - (tile.width - w * SS) / 2),
                                   int(y0 * SS - (tile.height - h * SS) / 2)))
        edge = tile_edge(w * SS, h * SS, radius * SS, angle)
        big = Image.new('L', (S * SS, S * SS), 0)
        big.paste(edge, (int(x0 * SS - (edge.width - w * SS) / 2), int(y0 * SS - (edge.height - h * SS) / 2)))
        # 与定稿图一致的描边：淡蓝 → 淡紫，透明度 150
        paint(img, big, [(0, '#BFE9FF'), (1, '#A78BFA')], 150)

    # 顶卡上的节点图（随卡片 -6° 旋转）
    nodes = rotate_pts(NODES, TOP_ANGLE)
    for a, b in EDGES:
        paint(img, mask_line([rotate_pts([a], TOP_ANGLE)[0], rotate_pts([b], TOP_ANGLE)[0]], 8),
              [(0, '#BFE9FF'), (1, '#FFFFFF')], 170)
    for (cx, cy), r in zip(nodes, NODE_R):
        disc(img, cx, cy, r, '#EAF9FF')
    return img


# ------------------------------------------------------------------ SVG 母版
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
<defs>
<radialGradient id="bg" cx="50%" cy="45%" r="80%"><stop stop-color="#131A2A"/><stop offset="1" stop-color="#06080F"/></radialGradient>
<linearGradient id="c1" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#6D8BFF"/><stop offset="1" stop-color="#2B3AA8"/></linearGradient>
<linearGradient id="c2" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#22D3EE"/><stop offset="1" stop-color="#116E86"/></linearGradient>
<linearGradient id="c3" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#BFE9FF"/><stop offset="1" stop-color="#C4B5FD"/></linearGradient>
<radialGradient id="haze"><stop stop-color="#6D5BFF" stop-opacity=".5"/><stop offset="1" stop-color="#6D5BFF" stop-opacity="0"/></radialGradient>
</defs>
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
<circle cx="300" cy="300" r="220" fill="url(#haze)"/>
<g transform="rotate(14 268 322)"><rect x="150" y="210" width="236" height="224" rx="26" fill="url(#c1)" opacity=".82" stroke="#BFE9FF" stroke-opacity=".45" stroke-width="3"/></g>
<g transform="rotate(6 261 297)"><rect x="136" y="178" width="250" height="238" rx="28" fill="url(#c2)" opacity=".85" stroke="#BFE9FF" stroke-opacity=".45" stroke-width="3"/></g>
<g transform="rotate(-6 255 267)"><rect x="122" y="140" width="266" height="254" rx="30" fill="url(#c3)" opacity=".75" stroke="#FFFFFF" stroke-opacity=".5" stroke-width="3"/></g>
<g transform="rotate(-6 255 267)">
<polyline points="196,218 196,312" stroke="#BFE9FF" stroke-width="8" stroke-linecap="round" stroke-opacity=".7"/>
<polyline points="196,218 300,264" stroke="#BFE9FF" stroke-width="8" stroke-linecap="round" stroke-opacity=".7"/>
<polyline points="196,312 300,264" stroke="#BFE9FF" stroke-width="8" stroke-linecap="round" stroke-opacity=".7"/>
<circle cx="196" cy="218" r="22" fill="#EAF9FF"/><circle cx="196" cy="312" r="22" fill="#EAF9FF"/><circle cx="300" cy="264" r="26" fill="#EAF9FF"/>
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
