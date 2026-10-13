# resources/native — Office 编辑器的原生依赖

内嵌的 Excel 编辑器（GenOffice 内核）把工作簿的打开与保存全部交给一个 Rust 侧车进程
`xlsx-sidecar`（上游 `apps/sheets/native/xlsx-engine`）。**它是必需件**：缺了它
`workbook:select` 会以 `spawn … ENOENT` 失败，界面上的表现就是「打开 .xlsx 是一张空表」。

## 获取

```bash
npm run office:build:native
```

- 本机有 Rust 工具链时：脚本直接 `cargo build --release` 编译，并把可执行文件复制到这里；
- 已在别处编译好时：用环境变量 `XLSX_SIDECAR_PATH` 指向它，再跑同一条命令（脚本会复制过来）。

### 没有 Rust 工具链时：从官方安装包取现成的（已验证可用）

官方 Windows 安装包会把同一个文件放在 `resources/native/` 下，取出来即可（8.6 MB）：

```powershell
$dir = "$env:TEMP\genoffice-sidecar"; New-Item -ItemType Directory -Force $dir | Out-Null
$url = 'https://ghproxy.net/https://github.com/genspark-ai/genoffice/releases/download/v0.11.727/GenOfficeSetup-v0.11.727-x64.exe'
curl.exe -L -o "$dir\setup.exe" $url          # 直连 release-assets 常被墙，故走 ghproxy 等镜像
Start-Process "$dir\setup.exe" -ArgumentList '/S', "/D=$dir\app" -Wait   # 静默装到临时目录（免管理员）
Copy-Item "$dir\app\resources\native\xlsx-sidecar.exe" resources\native\ -Force
Start-Process "$dir\app\Uninstall GenOffice.exe" -ArgumentList '/S' -Wait # 卸掉临时安装
Remove-Item -Recurse -Force $dir
```

实测记录（2026-10-14）：v0.11.727 的 `xlsx-sidecar.exe` 与 `vendor/genoffice`（commit `aff3d20`）
协议兼容 —— 真实 .xlsx 能正常打开并流式加载（196 行的样本文件首屏即出）。上游新版本后
若出现打开异常，优先怀疑这里版本错配。

## 加载顺序

主进程 `electron/main/office-host.ts` 的 `resolveXlsxSidecarPath()` 依次查找：

1. 环境变量 `XLSX_SIDECAR_PATH`
2. 本目录（开发态优先，即 `resources/native/xlsx-sidecar[.exe]`）
3. `vendor/genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar[.exe]`（cargo 原始产物）

打包后只认 `<resources>/native/xlsx-sidecar[.exe]`（见 `electron-builder.json5` 的 `extraResources`），
因此发布前务必先执行 `npm run office:build:native`。
