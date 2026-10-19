#!/usr/bin/env python3
"""
生成「文件关联」用的文件类型图标（resources/file-icons/*.ico）
================================================================================
用途：Windows 资源管理器里，凡是「默认用 AI-KM 打开」的文件类型，图标取自
      注册表 HKCU\\Software\\Classes\\<ProgID>\\DefaultIcon。安装程序把它统一写成
      `AI-KM.exe,0`，于是所有类型看起来都是软件图标、互相分不出来。
      本脚本为每个文件类型生成一张「彩色文档 + 类型缩写」的 .ico，由主进程写进
      各 ProgID 的 DefaultIcon（见 electron/main/file-assoc.ts）。

用法：python scripts/make-file-icons.py [--out <目录>] [--preview <png 路径>]
      依赖 Pillow（DSH 自带的 Python 已装；本机 Python 需 `pip install pillow`）。

设计：
  - 尺寸 16/20/24/32/40/48/64/96/128/256 逐个**单独绘制**（不是从大图缩放），
    小尺寸用 3 字符缩写、大尺寸用完整缩写，保证 16px 下也能看出区别。
  - 先按 4 倍超采样画，再 LANCZOS 缩到目标尺寸，边缘抗锯齿。
  - 小尺寸写 32bpp BMP 条目（兼容性最好），256 写 PNG 条目（体积小）。
"""

from __future__ import annotations

import argparse
import os
import struct
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 只在没装 Pillow 时触发
    sys.exit('需要 Pillow：pip install pillow')

# ---------------------------------------------------------------------------
# 文件类型表：key（= file-assoc.ts 里的 FileAssocEntry.key）、主色、文字缩写
# 颜色都选得足够深，白字对比度 >= 3:1（16px 下也能看清轮廓）。
# ---------------------------------------------------------------------------
TYPES: list[tuple[str, str, str, str]] = [
    # key,       主色,       小尺寸缩写(<=3), 大尺寸文字
    ('kb',         '#5B3FD1', 'KB',  'KB'),
    ('md',         '#12509E', 'MD',  'MD'),
    ('txt',        '#5B6B7C', 'TXT', 'TXT'),
    ('json',       '#A86A06', 'JSN', 'JSON'),
    ('html',       '#E2600C', 'HTM', 'HTML'),
    ('css',        '#0E86D4', 'CSS', 'CSS'),
    ('xml',        '#0E8A7D', 'XML', 'XML'),
    ('yaml',       '#9B3FD1', 'YML', 'YAML'),
    ('toml',       '#8A5A2B', 'TML', 'TOML'),
    ('csv',        '#1E8E3E', 'CSV', 'CSV'),
    ('pdf',        '#D32F2F', 'PDF', 'PDF'),
    ('ts',         '#2F74C0', 'TS',  'TS'),
    ('code',       '#454F5B', 'CDE', 'CODE'),
    ('excalidraw', '#6D5DF6', 'EXC', 'DRAW'),
    ('drawio',     '#B23A00', 'DIO', 'DIO'),
    ('flow',       '#C026A3', 'FLW', 'FLOW'),
    ('data',       '#4F46E5', 'DAT', 'DATA'),
    ('mmd',        '#D6336C', 'MMD', 'MMD'),
]

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 4  # 超采样倍数

FONT_CANDIDATES = [
    os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', 'segoeuib.ttf'),
    os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', 'arialbd.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
]


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default(px)


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def lighten(rgb: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    """向白色混合 amount（0..1）"""
    return tuple(round(c + (255 - c) * amount) for c in rgb)  # type: ignore[return-value]


def render(size: int, color: tuple[int, int, int], label: str) -> Image.Image:
    """在 size*SS 的画布上画一张文档图标，再缩到 size。"""
    W = size * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

    # 页面矩形（略高于宽，像一张竖着的纸）
    mx, my = W * 0.085, W * 0.03
    x0, y0 = mx, my
    x1, y1 = W - mx, W - my
    radius = max(1.0, W * 0.13)
    fold = W * 0.30

    page = Image.new('L', (W, W), 0)
    ImageDraw.Draw(page).rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=255)
    # 右上角切出折角
    cut = Image.new('L', (W, W), 0)
    ImageDraw.Draw(cut).polygon([(x1 - fold, 0), (W, 0), (W, y0 + fold)], fill=255)
    page = ImageChops.subtract(page, cut)
    img.paste(color + (255,), (0, 0), page)

    # 折角本身（比主色亮一点，形成「纸角翻起」的感觉）
    ear = Image.new('L', (W, W), 0)
    ImageDraw.Draw(ear).polygon(
        [(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)], fill=255)
    img.paste(lighten(color, 0.55) + (255,), (0, 0), ear)

    # 文字：自动收字号，保证不超出页面宽度
    max_w = (x1 - x0) * 0.76
    max_h = (y1 - y0) * 0.40
    font_px = int((y1 - y0) * 0.34)
    while font_px > 2:
        font = load_font(font_px)
        left, top, right, bottom = font.getbbox(label)
        tw, th = right - left, bottom - top
        if tw <= max_w and th <= max_h:
            break
        font_px -= 1
    font = load_font(font_px)
    left, top, right, bottom = font.getbbox(label)
    cx = (x0 + x1) / 2 - (left + right) / 2
    cy = y0 + (y1 - y0) * 0.62 - (top + bottom) / 2
    ImageDraw.Draw(img).text((cx, cy), label, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


def bmp_entry(img: Image.Image) -> bytes:
    """把 RGBA 图编码成 ICO 里的 32bpp BMP 条目（BITMAPINFOHEADER + BGRA + AND 掩码）。"""
    w, h = img.size
    px = img.load()
    rows = []
    for y in range(h - 1, -1, -1):  # 自下而上
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    xor = b''.join(rows)
    mask_row_bytes = ((w + 31) // 32) * 4
    and_mask = b'\x00' * (mask_row_bytes * h)  # 全 0 = 不透明；透明交给 alpha 通道
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0,
                         len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + xor + and_mask


def png_entry(img: Image.Image) -> bytes:
    import io
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def write_ico(path: str, color: tuple[int, int, int], small: str, full: str) -> None:
    entries = []
    for size in SIZES:
        img = render(size, color, small if size <= 24 else full)
        # 小尺寸用 32bpp BMP（兼容性最好）；>= 64 用 PNG 条目（体积只有 BMP 的几十分之一，
        # Vista 之后的 shell 都支持）。256 只能是 PNG。
        entries.append((size, png_entry(img) if size >= 64 else bmp_entry(img)))
    entries.sort(key=lambda e: e[0])  # 由小到大，256 放最后
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b''
    payload = b''
    for size, data in entries:
        b_ = 0 if size >= 256 else size
        directory += struct.pack('<BBBBHHII', b_, b_, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        payload += data
    with open(path, 'wb') as f:
        f.write(header + directory + payload)


def preview(out_png: str, icon_dir: str) -> None:
    """拼一张对照图：浅色 / 深色底上各一排 48 / 32 / 16px，方便肉眼检查。"""
    sizes = [48, 32, 16]
    pad, gap = 14, 8
    col_w = sum(sizes) + gap * (len(sizes) + 1)
    band_h = max(sizes) + pad * 2
    width = pad * 2 + col_w * len(TYPES)
    height = band_h * 2
    sheet = Image.new('RGB', (width, height), (248, 249, 251))
    ImageDraw.Draw(sheet).rectangle([0, band_h, width, height], fill=(30, 32, 38))

    thumbs: list[dict[int, Image.Image]] = []
    for key, _color, _small, _full in TYPES:
        ico = Image.open(os.path.join(icon_dir, key + '.ico'))
        thumbs.append({s: ico.ico.getimage((s, s)).convert('RGBA') for s in sizes})

    for band in (0, 1):
        base_y = band * band_h + pad
        for i, by_size in enumerate(thumbs):
            x = pad + i * col_w + gap
            for size in sizes:
                img = by_size[size]
                sheet.paste(img, (x, base_y + max(sizes) - size), img)
                x += size + gap
    sheet.save(out_png)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), 'resources', 'file-icons'))
    ap.add_argument('--preview', default='')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for key, color, small, full in TYPES:
        path = os.path.join(args.out, key + '.ico')
        write_ico(path, hex_rgb(color), small, full)
        # 设置页的图标预览（PNG 便于渲染层直接当 <img> 用，主进程不用解 ICO）
        render(40, hex_rgb(color), full).save(os.path.join(args.out, key + '.png'), optimize=True)
        print(f'  {os.path.basename(path):<16} {os.path.getsize(path) / 1024:6.1f} KB')
    print(f'已生成 {len(TYPES)} 个图标 -> {args.out}')

    if args.preview:
        preview(args.preview, args.out)
        print(f'对照图 -> {args.preview}')


if __name__ == '__main__':
    main()
