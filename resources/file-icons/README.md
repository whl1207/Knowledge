# 文件类型图标（文件关联用）

Windows 资源管理器显示「默认用 AI-KM 打开」的文件时，图标取自注册表
`HKCU\Software\Classes\<ProgID>\DefaultIcon`。没做这套图标之前，所有已关联类型都指向
`AI-KM.exe,0`，于是 `.md` / `.pdf` / `.json` 长得一模一样，只能靠扩展名分辨。

本目录为每种文件类型提供一张自己的图标（彩色文档 + 类型缩写）：

| 文件 | 用途 |
| --- | --- |
| `<key>.ico` | 写进注册表 DefaultIcon，供资源管理器显示（16/20/24/32/40/48 为 32bpp BMP 条目，64/96/128/256 为 PNG 条目） |
| `<key>.png` | 40px 预览图，设置 → 其他 → 文件关联 的列表里直接当 `<img>` 显示（主进程不用解 ICO） |

`<key>` 与 `electron/main/file-assoc.ts` 里 `FILE_ASSOC_ENTRIES[].icon` 一一对应。

## 重新生成

```bash
python scripts/make-file-icons.py                     # 只生成图标
python scripts/make-file-icons.py --preview out.png   # 额外输出浅色/深色底对照图
```

- 依赖 Pillow（`pip install pillow`）。
- 想改配色 / 缩写，改 `scripts/make-file-icons.py` 顶部的 `TYPES` 表后重跑即可。
- 生成物需要提交进仓库：它们随安装包分发（`extraResources` 的 `file-icons`）。

## 运行时怎么用

`file-assoc.ts` 会把本目录复制到 `<userData>/file-icons`，注册表里写的是那份**绝对路径**——
因为免安装版的 exe / 资源在临时目录（路径每次运行都变），安装目录也可能被迁走，而 userData
始终稳定。启动时还会把「已经关联到本软件」的 ProgID 的 DefaultIcon 校正成对应图标，
用户不必手动逐个重设。
