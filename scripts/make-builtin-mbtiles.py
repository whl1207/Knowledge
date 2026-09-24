#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-builtin-mbtiles.py — 把金字塔瓦片目录打包成 MBTiles（SQLite）单文件。

MBTiles 规范要点（Mapbox）:
  - tiles 表: (zoom_level, tile_column, tile_row, tile_data)
  - tile_row 使用 TMS 坐标（自南向北），XYZ/Google 坐标 y 需要翻转:
        tms_row = 2^zoom - 1 - y_xyz
  - metadata 表: (name, value)，至少含 name/format/minzoom/maxzoom/bounds

用法:
  python scripts/make-builtin-mbtiles.py \
      --src public/tiles/6 \
      --out public/maps/builtin.mbtiles \
      --name "内置离线卫星图" \
      --attribution "AI-KM 内置离线地图"

生成后复制/提交 public/maps/*.mbtiles 即随软件内嵌分发。
"""
import argparse
import math
import os
import sqlite3
import sys

# 瓦片像素大小（标准 256）
TILE_SIZE = 256


def tile_bbox_xyz(z: int, x: int, y: int):
    """XYZ 瓦片 (z,x,y) 覆盖的经纬度范围（Web Mercator / EPSG:3857 的常规算法）。"""
    n = 2.0 ** z
    lon_left = x / n * 360.0 - 180.0
    lon_right = (x + 1) / n * 360.0 - 180.0
    lat_top = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_bottom = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_left, lat_bottom, lon_right, lat_top  # w, s, e, n


def scan_tiles(src_dir: str):
    """扫描 {src}/{z}/{x}/{y}.png，返回 {z: set((x, y_xyz))} 与 bbox。"""
    by_zoom: dict[int, set] = {}
    min_lon, min_lat = 180.0, 90.0
    max_lon, max_lat = -180.0, -90.0
    total = 0
    for root, _, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        parts = rel.split(os.sep)
        if len(parts) != 2:
            continue
        try:
            z, x = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if z not in by_zoom:
            by_zoom[z] = set()
        for fn in files:
            if not fn.lower().endswith(".png"):
                continue
            y = int(os.path.splitext(fn)[0])
            by_zoom[z].add((x, y))
            w, s, e, n = tile_bbox_xyz(z, x, y)
            min_lon, min_lat = min(min_lon, w), min(min_lat, s)
            max_lon, max_lat = max(max_lon, e), max(max_lat, n)
            total += 1
    return by_zoom, (min_lon, min_lat, max_lon, max_lat), total


def sniff_format(src_dir: str, by_zoom):
    """读取第一张瓦片文件头嗅探真实图片格式（很多离线包扩展名是 .png 内容却是 jpg）。"""
    for z, tiles in sorted(by_zoom.items()):
        for (x, y) in sorted(tiles):
            p = os.path.join(src_dir, str(z), str(x), f"{y}.png")
            if os.path.exists(p):
                with open(p, "rb") as f:
                    head = f.read(16)
                if head[:3] == b"\xff\xd8\xff":
                    return "jpg"
                if head[:8] == b"\x89PNG\r\n\x1a\n":
                    return "png"
                if head[:2] == b"II" or head[:2] == b"MM":
                    return "webp" if head[8:12] == b"WEBP" else "jpg"
    return "png"


def build(src_dir: str, out_path: str, name: str, attribution: str):
    if os.path.exists(out_path):
        os.remove(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    by_zoom, (w, s, e, n), total = scan_tiles(src_dir)
    if not by_zoom:
        print("未扫描到任何瓦片，退出。", file=sys.stderr)
        sys.exit(1)
    zooms = sorted(by_zoom)
    minzoom, maxzoom = zooms[0], zooms[-1]
    fmt = sniff_format(src_dir, by_zoom)
    print(f"扫描到 {total} 张瓦片，zoom {minzoom}~{maxzoom}，图片格式: {fmt}")
    print(f"覆盖范围 (w,s,e,n): {w:.6f}, {s:.6f}, {e:.6f}, {n:.6f}")

    db = sqlite3.connect(out_path)
    try:
        db.executescript(
            """
            CREATE TABLE metadata (name TEXT, value TEXT);
            CREATE TABLE tiles (
                zoom_level INTEGER,
                tile_column INTEGER,
                tile_row INTEGER,
                tile_data BLOB
            );
            CREATE UNIQUE INDEX tile_index
                ON tiles (zoom_level, tile_column, tile_row);
            """
        )

        # 预编译插入语句，逐张写入（把 PNG 字节原样存 BLOB，不二次压缩）
        ins = db.executemany(
            "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) "
            "VALUES (?, ?, ?, ?)",
            (
                (
                    z,
                    x,
                    (1 << z) - 1 - y,  # XYZ → TMS 翻转
                    open(os.path.join(src_dir, str(z), str(x), f"{y}.png"), "rb").read(),
                )
                for z in zooms
                for (x, y) in sorted(by_zoom[z])
            ),
        )
        ins.fetchall() if hasattr(ins, "fetchall") else None

        meta = {
            "name": name,
            "format": fmt,
            "minzoom": str(minzoom),
            "maxzoom": str(maxzoom),
            "bounds": f"{w},{s},{e},{n}",
            "scheme": "tms",
            "type": "overlay",
            "attribution": attribution,
            "description": f"由 scripts/make-builtin-mbtiles.py 从 {src_dir} 生成",
        }
        db.executemany("INSERT INTO metadata (name, value) VALUES (?, ?)", list(meta.items()))
        db.commit()
        db.execute("VACUUM")
    finally:
        db.close()

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"已生成: {out_path}  ({size_mb:.1f} MB, {total} 瓦片, z{minzoom}~z{maxzoom})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="打包 XYZ 瓦片目录为 MBTiles")
    ap.add_argument("--src", default="public/tiles/6", help="瓦片目录 {src}/{z}/{x}/{y}.png")
    ap.add_argument("--out", default="public/maps/builtin.mbtiles", help="输出 .mbtiles 路径")
    ap.add_argument("--name", default="内置离线卫星图", help="metadata.name")
    ap.add_argument("--attribution", default="AI-KM 内置", help="metadata.attribution")
    args = ap.parse_args()
    build(args.src, args.out, args.name, args.attribution)
