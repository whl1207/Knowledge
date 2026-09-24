#!/bin/bash
# ============================================================
# 一键打包 Linux（x64: deb + AppImage；arm64: deb）
#   流程：同步源码到 WSL -> npm install -> 构建 -> 复制回 Windows
#   用法（在 Windows 上直接运行 build-linux-all.cmd 即可）：
#     bash build-linux-all.sh                  # 完整流程（x64 + arm64 一起打包）
#     bash build-linux-all.sh --skip-install   # 跳过 npm install（源码未变时加速）
# ============================================================
set -e

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export npm_config_registry="https://registry.npmmirror.com"
export NODE_OPTIONS="--max-old-space-size=6144"

# —— 参数解析 ——
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    *) echo "!! 未知参数: $arg（仅支持 --skip-install）" ;;
  esac
done

# —— 自动定位项目根目录（WSL 视角的 Windows 路径）——
# 脚本位于项目 scripts/ 目录（或原来的 help/ 子目录）时自动推导；否则请手动修改 SRC。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  SRC="/mnt/d/Project/1 Knowledge local"
fi
DST="/root/Knowledge"

echo "======================================================="
echo " [1/4] 同步源码: $SRC -> $DST"
echo "======================================================="
if [ "$SKIP_INSTALL" -eq 1 ] && [ -d "$DST/node_modules" ]; then
  echo "   --skip-install：保留 node_modules，仅更新源码与清理旧构建产物"
  rm -rf "$DST/dist" "$DST/dist-electron" "$DST/release"
else
  echo "   全新同步（含清理 node_modules / 旧产物）"
  rm -rf "$DST"
fi
mkdir -p "$DST"
cd "$SRC"
# 排除 node_modules / 构建产物，避免与 Windows 环境互相污染
tar --exclude=node_modules --exclude=dist --exclude=dist-electron --exclude=release --exclude=.git --exclude=.github \
    -cf - . | tar -xf - -C "$DST"
echo "   已同步文件数: $(find "$DST" -type f | wc -l)"

cd "$DST"

if [ "$SKIP_INSTALL" -eq 1 ] && [ -d node_modules ]; then
  echo "   （跳过 npm install）"
else
  echo "======================================================="
  echo " [2/4] npm install"
  echo "======================================================="
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1   # install 阶段跳过 electron 二进制（打包时 electron-builder 会自己下）
  set +e
  npm install --no-audit --no-fund
  NPM_INSTALL_EXIT=$?
  set -e
  unset ELECTRON_SKIP_BINARY_DOWNLOAD
  echo "   npm install 退出码: $NPM_INSTALL_EXIT"
  if [ "$NPM_INSTALL_EXIT" -ne 0 ]; then
    echo "!! npm install 失败，终止打包"
    exit "$NPM_INSTALL_EXIT"
  fi
fi

echo "======================================================="
echo " [3/4] 构建: npm run build-linux（x64: deb+AppImage；arm64: deb）"
echo "======================================================="
set +e
npm run build-linux
BUILD_EXIT=$?
set -e
if [ "$BUILD_EXIT" -ne 0 ]; then
  echo "!! 构建失败 (BUILD_EXIT=$BUILD_EXIT)，不执行复制回 Windows"
  exit "$BUILD_EXIT"
fi

echo "======================================================="
echo " [4/4] 复制产物回 Windows: $DST/release -> $SRC/release"
echo "======================================================="
mkdir -p "$SRC/release"
ls -la "$DST/release"
cp -v "$DST"/release/AI-KM-Linux-*.deb      "$SRC/release/"
cp -v "$DST"/release/AI-KM-Linux-*.AppImage "$SRC/release/"
echo "== Windows release 目录内容 =="
ls -la "$SRC/release"

echo "======================================================="
echo " ✅ 打包完成！产物已复制到 $SRC/release"
echo "======================================================="
