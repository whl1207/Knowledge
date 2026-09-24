# AI-KM Linux 打包指南（deb / AppImage）

本文档说明在 **Windows 开发机**上，如何为 AI-KM 生成 Linux 安装包（`.deb` 和 `.AppImage`）。
由于本项目在国内网络环境下开发，文档中包含了全部所需的国内镜像配置与绕过 GitHub 限速的方案。

> 适用版本：v6.8.1+ ｜ 目标平台：Linux x64 ｜ 打包工具：electron-builder 24

---

## 1. 为什么不能在 Windows 上直接打包

electron-builder 在 **Windows 上直接打包 Linux 目标**会失败，原因有两个：

| 目标 | 失败原因 |
|------|----------|
| `deb` | 依赖本机 `fpm`（Ruby 工具）。electron-builder 24 在 Windows 上**不捆绑** fpm，需要额外安装 Ruby + fpm，且 fpm 在 Windows 上兼容性差 |
| `AppImage` | 打包时需要创建**符号链接**，Windows 无管理员/开发者模式权限时报错 `A required privilege is not held by the client` |
| `snap` | 需要解压 Linux 符号链接，Windows 上同样报错 |

**推荐方案：使用 WSL2（Ubuntu）在原生 Linux 环境打包**，deb / AppImage 一次搞定，无需额外安装 fpm。

---

## 2. 环境准备

### 2.1 安装 WSL2 + Ubuntu

> ⚠️ `wsl --install -d Ubuntu` 会先从 `raw.githubusercontent.com` 拉取发行版列表，
> 国内网络下通常会超时（`Wsl/InstallDistro/WININET_E_TIMEOUT`），因此改用下面的**离线导入**方式。

**① 以管理员身份打开 PowerShell，启用 WSL 功能（不需要联网）：**

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

**② 重启电脑。**

**③ 从清华镜像下载 Ubuntu 22.04 WSL rootfs（约 325 MB，速度快）：**

```powershell
mkdir D:\WSL
curl.exe -L -o D:\WSL\ubuntu-rootfs.tar.gz `
  "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz"
```

> 官方 rootfs 地址（国内慢）：`https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz`

**④ 导入发行版：**

```powershell
wsl --import Ubuntu D:\WSL\Ubuntu D:\WSL\ubuntu-rootfs.tar.gz
wsl -l -v   # 确认 Ubuntu 存在且 VERSION 为 2
```

> 说明：rootfs 导入的发行版默认用户是 `root`，打包场景下无需再创建普通用户。

#### 迁移 / 备份发行版

WSL 发行版以 `ext4.vhdx` 形式存放，**不要直接剪切文件夹**（会损坏）。要迁移到其他盘或做备份，用官方导出/导入：

```powershell
wsl --shutdown
wsl --export Ubuntu D:\WSL\ubuntu-backup.tar    # 导出备份（约 7 GB，视大小可能需要几分钟）
wsl --unregister Ubuntu                         # 注销并删除旧位置的文件
wsl --import Ubuntu D:\WSL\Ubuntu D:\WSL\ubuntu-backup.tar   # 导入到新位置
wsl -l -v                                       # 验证
```

> 迁移后发行版内所有内容（node_modules、构建产物等）都会原样保留；导出 tar 确认无误后可删除以释放空间。

### 2.2 配置 Ubuntu 环境（apt 源 / Node / 国内镜像）

将下面的脚本保存为 `setup.sh`，然后执行：

```bash
wsl -d Ubuntu -u root -- bash /mnt/d/WSL/setup.sh
```

`setup.sh` 内容（已处理国内网络）：

```bash
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

# 1) 将 apt 源换成清华镜像（否则 archive.ubuntu.com 只有几十 KB/s）
cp /etc/apt/sources.list /etc/apt/sources.list.bak 2>/dev/null || true
cat > /etc/apt/sources.list <<'EOF'
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ jammy main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ jammy-updates main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ jammy-backports main restricted universe multiverse
deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ jammy-security main restricted universe multiverse
EOF

apt-get update -y

# 2) 安装编译工具（原生模块可能需要编译）
apt-get install -y --no-install-recommends curl ca-certificates xz-utils git build-essential python3 pkg-config

# 3) 从 npmmirror 安装 Node 20
if ! command -v node >/dev/null 2>&1; then
  NODE_VERSION=v20.18.1
  curl -fsSL "https://npmmirror.com/mirrors/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi

npm config set registry https://registry.npmmirror.com

# 4) 持久化 electron 相关镜像变量（供后续每次 wsl 调用使用）
cat > /etc/profile.d/electron-mirror.sh <<'EOF'
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export npm_config_registry="https://registry.npmmirror.com"
EOF

echo "node: $(node -v), npm: $(npm -v)"
```

> 环境变量说明：
> - `ELECTRON_MIRROR`：让 electron-builder 从 npmmirror 下载 Electron 运行时（原为 GitHub，约 100 MB）。
> - `ELECTRON_BUILDER_BINARIES_MIRROR`：让 electron-builder 从 npmmirror 下载 appimage / fpm 等打包工具。

---

## 3. 项目配置要求（package.json）

`package.json` 中与 Linux 打包相关的配置（当前项目已配置好，仅供参考）：

```jsonc
{
  // deb 打包强校验：缺失会报 "Please specify project homepage"
  "homepage": "https://github.com/whl1207/Knowledge",

  "scripts": {
    // build-linux 一次产出：x64(deb + AppImage) + arm64(deb)
    "build-linux": "vue-tsc --noEmit && vite build && electron-builder --linux"
  },

  "build": {
    "appId": "com.whl.aikm",
    "productName": "AI-KM",
    "directories": { "output": "release" },
    "linux": {
      // 按架构指定目标：AppImage 只出 x64；deb 出 x64 + arm64
      "target": [
        { "target": "AppImage", "arch": ["x64"] },
        { "target": "deb", "arch": ["x64", "arm64"] }
      ],
      "icon": "public/icon.png",          // 建议 512x512（当前为 256x256）
      "category": "Utility",
      "maintainer": "whl <1920191110@nue.edu.com>",  // deb 必需，格式：名称 <邮箱>
      "artifactName": "${productName}-Linux-${version}-${arch}.${ext}"
    }
  }
}
```

> 注意：**真正生效的配置在 `package.json` 的 `build` 字段**，而不是根目录的 `electron-builder.json5`。
> electron-builder 优先读取 `package.json#build`。

---

## 4. 一键打包流程

### 4.1 复制项目到 WSL 并安装依赖（仅首次 / 源码变更后需要）

保存为 `build.sh`：

```bash
#!/bin/bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export npm_config_registry="https://registry.npmmirror.com"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1   # npm install 阶段跳过 electron 二进制下载（打包时 electron-builder 会自己下）

# —— 自动定位项目根目录（WSL 视角的 Windows 路径）——
# 脚本位于项目 help/ 目录时自动推导；否则请手动修改 SRC。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  SRC="/mnt/d/Project/1 Knowledge local"
fi
DST="/root/Knowledge"

echo "== copy project ($SRC -> $DST) =="
rm -rf "$DST"
mkdir -p "$DST"
cd "$SRC"
# 排除 node_modules / 构建产物，避免与 Windows 环境互相污染
tar --exclude=node_modules --exclude=dist --exclude=dist-electron --exclude=release --exclude=.git --exclude=.github \
    -cf - . | tar -xf - -C "$DST"
echo "== copied files count =="
find "$DST" -type f | wc -l

cd "$DST"
echo "== npm install =="
set +e
npm install --no-audit --no-fund
echo "NPM_INSTALL_EXIT=$?"
set -e
```

> 为什么要复制到 WSL 内部而不是直接在 `/mnt/d` 构建：
> - Windows 的 `node_modules` 里是 Win 版原生二进制，在 Linux 上打包会缺库；
> - WSL 内重新 `npm install` 会安装 Linux 版原生二进制，且不影响 Windows 本机开发环境。

### 4.2 执行打包

保存为 `run-build.sh`：

```bash
#!/bin/bash
cd /root/Knowledge
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export npm_config_registry="https://registry.npmmirror.com"
export NODE_OPTIONS="--max-old-space-size=6144"   # vite 构建内存大，默认 2GB 会 OOM
npm run build-linux
echo "BUILD_EXIT=$?"
```

Windows 侧执行：

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/WSL/build.sh
wsl -d Ubuntu -u root -- bash /mnt/d/WSL/run-build.sh
```

### 4.3 把产物复制回 Windows

保存为 `copy-back.sh`：

```bash
#!/bin/bash
# —— 自动定位项目根目录（WSL 视角的 Windows 路径）——
# 脚本位于项目 help/ 目录时自动推导；否则请手动修改 ROOT。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  ROOT="/mnt/d/Project/1 Knowledge local"   # 若脚本不在项目内，请手动修改
fi
SRC="/root/Knowledge/release"
DST="$ROOT/release"
mkdir -p "$DST"
echo "== WSL release 目录内容 =="
ls -la "$SRC"
echo "== 复制产物 =="
cp -v "$SRC"/AI-KM-Linux-*.deb      "$DST/"
cp -v "$SRC"/AI-KM-Linux-*.AppImage "$DST/"
echo "== Windows release 目录内容 =="
ls -la "$DST"
```

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/WSL/copy-back.sh
```

### 4.4 一键打包（推荐）

> v6.8.1+ 已把 4.1~4.3 三步合并为**一条命令**，无需再手动切脚本。

脚本位于项目内，自动定位项目根目录：

| 脚本 | 位置 | 作用 |
|------|------|------|
| `scripts/build-linux-all.cmd` | `scripts/` | Windows 入口，双击即可（可加 `--skip-install` 参数；默认同时打 x64 + arm64） |
| `scripts/build-linux-all.sh` | `scripts/` | WSL 内完整流程：同步源码 → npm install → 构建 → 复制回 Windows |

**Windows 侧一键执行（推荐）：**

```powershell
cd "D:\Project\1 Knowledge local"
.\scripts\build-linux-all.cmd          # 完整流程
.\scripts\build-linux-all.cmd --skip-install   # 源码未变时跳过 npm install，加速
```

等效的 WSL 直调命令：

```powershell
wsl -d Ubuntu -u root -- bash "/mnt/d/Project/1 Knowledge local/scripts/build-linux-all.sh"
```

说明：
- 无论是否传 `--skip-install`，每次都会**重新同步源码、重新构建**，保证产物与当前代码一致。
- `--skip-install` 仅在 `node_modules` 已存在时跳过 `npm install`（仅更新源码）。
- 构建失败时脚本会终止，不会覆盖 Windows 侧旧产物。

### 4.5 ARM64（aarch64）版本

> 适用：树莓派 4/5、飞腾/麒麟等国产 ARM 板、ARM 云主机等。

本项目依赖**全部为纯 JS**（无原生编译模块），因此可以在 x64 的 WSL 里直接**交叉打包 arm64**，无需 ARM 真机、无需安装交叉编译工具链。

`build.linux.target` 已按架构配置好（见第 3 节）：**AppImage 只出 x64，deb 出 x64 + arm64**。因此 `build-linux` / 一键脚本**默认就会同时产出多架构产物**，无需任何额外参数：

```powershell
cd "D:\Project\1 Knowledge local"
.\scripts\build-linux-all.cmd               # 默认同时打 x64 + arm64
.\scripts\build-linux-all.cmd --skip-install
```

等效的 WSL 直调命令：

```powershell
wsl -d Ubuntu -u root -- bash "/mnt/d/Project/1 Knowledge local/scripts/build-linux-all.sh"
```

原理：
- electron-builder 按 `target` 配置为 arm64 自动下载 **linux-arm64** 的 Electron 运行时（走 `ELECTRON_MIRROR` npmmirror 镜像），并在 x64 主机上用 fpm 组装出 arm64 的 deb 包。
- **ARM 版本只产出 deb**（架构名 `arm64`），不产出 AppImage。

| 产物 | 说明 |
|------|------|
| `AI-KM-Linux-6.8.1-arm64.deb` | Debian/Ubuntu ARM64：`sudo dpkg -i AI-KM-Linux-6.8.1-arm64.deb` |

> 注意：deb 的架构名为 `arm64`，AppImage 的架构名为 `aarch64` / `x86_64`（electron-builder 对各目标格式的命名差异，属正常现象）。
> 若以后引入需要编译的原生依赖（如 `better-sqlite3`、`sharp` 等），交叉打包才需要额外处理，届时建议改用 ARM 真机打包。

---

## 5. 打包产物

产物位于 `release/` 目录：

| 文件 | 大小（约） | 说明 |
|------|-----------|------|
| `AI-KM-Linux-6.8.1-amd64.deb` | 404 MB | Debian/Ubuntu x64：`sudo dpkg -i AI-KM-Linux-6.8.1-amd64.deb` |
| `AI-KM-Linux-6.8.1-x86_64.AppImage` | 528 MB | 免安装 x64：`chmod +x *.AppImage && ./AI-KM-Linux-6.8.1-x86_64.AppImage` |
| `AI-KM-Linux-6.8.1-arm64.deb` | ~380 MB | Debian/Ubuntu ARM64（树莓派等）：`sudo dpkg -i AI-KM-Linux-6.8.1-arm64.deb` |

---

## 6. 常见问题排查

| 现象 | 原因 / 解决 |
|------|------------|
| `wsl --install -d Ubuntu` 超时 `WININET_E_TIMEOUT` | `raw.githubusercontent.com` 被墙，改用 2.1 节的 rootfs 导入方式 |
| apt 更新只有几十 KB/s | 未换源，执行 2.2 节清华 apt 源配置 |
| `vite build` 报 `JavaScript heap out of memory` | WSL 内 Node 默认堆太小，设 `NODE_OPTIONS=--max-old-space-size=6144` |
| `deb` 报 `Please specify project homepage` | 顶层缺少 `homepage` 字段 |
| `deb` 报缺少 maintainer / author email | 在 `build.linux.maintainer` 配置 `名称 <邮箱>` |
| `AppImage` 报符号链接权限错误 | 说明是在 Windows 直接打的，改用 WSL |
| 打包出的 Linux 版运行缺库 | 未在 WSL 内重新 `npm install`（用了 Windows 的 node_modules） |
| 打包 arm64 时下载 Electron/工具慢或失败 | 确保 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 已指向 npmmirror（其包含 linux-arm64 Electron 与 fpm/appimage 工具） |

---

## 7. 脚本清单

以下脚本均位于 `D:\WSL\`，可随时复用：

| 脚本 | 作用 |
|------|------|
| `setup.sh` | 一次性：apt 换源、装编译工具、装 Node 20、配置镜像变量 |
| `build.sh` | 复制项目到 WSL + `npm install` |
| `run-build.sh` | 执行 `npm run build-linux`（x64: deb + AppImage；arm64: deb） |
| `copy-back.sh` | 把产物复制回 Windows `release/` |

> 如需迁移到其他机器，把 `package.json` 的配置带上、重跑 `setup.sh` 即可；脚本内容已在本文档内联，可随时重新生成。
