# AI-KM

**A local-first AI knowledge management platform — chat, knowledge bases, ontology modelling, agentic skills, visual workflows and MCP tools in one desktop app.**

Built with **Vue 3 + Electron + TypeScript**. Everything runs on your own machine: models can be local (Ollama / LM Studio / GPUStack / ONNX) or remote APIs you configure, and no content is sent anywhere else. The UI and the in-app help are bilingual (Chinese / English).

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange)
![Version](https://img.shields.io/badge/version-6.10.12-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-30-47848F)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883)

---

## ✨ What it does

| Area | Capabilities |
|:---|:---|
| **🏠 Home (AI chat)** | Five chat modes: plain · knowledge base (RAG) · workflow · agent · swarm, all sharing one model config; an agent preset can use the PTC presentation (the model writes one program that composes its tool calls); multi-chat sidebar, per-chat model binding, context-usage ring, branch tree, attachments, stop & steer |
| **📚 Knowledge management** | The file centre: 11 views (browse, source edit, visual block editor, mind map, presentation, files, graph, kanban, calendar, map, table) driven by Markdown YAML front matter; LAN collaborative editing (code / whiteboard / draw.io) and read-only remote shares |
| **📄 General files** | Markdown, Word, PDF, images & media, plain text, Excel and local web pages, plus `.excalidraw` whiteboards and `.drawio` diagrams — opened from Knowledge Management with the view that fits; export Markdown / Word / PDF; document smart actions (chat with the current document), PDF OCR and in-place translation |
| **🧩 Special files** | File types defined by the app, each with its own view: `.kb` knowledge base (double-click jumps to Knowledge Processing), `.flow.yml` workflow, `.task` Agent Scaffold and `.data` data canvas |
| **🔬 Knowledge processing** | Import Markdown / PDF / Word / TXT, configurable chunking, embedding & vector storage, retrieval strategies (hybrid, agentic evidence reranking, ontology-augmented), Q&A test sets with automatic scoring, knowledge base Q&A page |
| **🧠 Ontology modelling** | Entity & relation extraction from slices, force-directed visualisation, entity cards, ontology-augmented retrieval with configurable score boosting |
| **🔗 Workflow** | A file type in Knowledge Management (`.flow.yml`, Dify app DSL): visual node editor (agent, MCP, Python, data, iteration, aggregator, Word export, web search, …) with test runs and inspectable intermediate output |
| **🤖 Agent Scaffold** | A file type in Knowledge Management (`.task`): table-driven batch agents, per-column table reasoning, link & file collectors; multi-round runs with per-round snapshots, per-row status / filters / retries, trajectory graph and Excel export; can also be driven from external MCP clients |
| **🧩 Skills & presets** | Codex-style skill import (a folder plus `SKILL.md`), reusable Agent presets (role, model, per-tool switches, attached skills, PTC presentation), skill store |
| **🔌 Plugins** | Local plugin host: plugins add tools for agents and register main panels / settings tabs / settings cards / swarm tabs / global hotkeys plus bilingual string tables, with declared permissions (`fs` / `shell` / `net` / `agent` / `llm`); install from the plugins folder or a shared-folder store; a built-in dev guide and the `builtin-plugin-dev` MCP service let a model write a plugin for you |
| **🔌 Models, tools & MCP** | Ollama / LM Studio / GPUStack / DeepSeek / OpenAI-compatible and multiple custom providers with per-provider enable + connection test; credential table; per-tool switches; six built-in in-process MCP services (browser agent, Office Word & Excel, draw.io, literature search, PostgreSQL, plugin-dev reference) optionally exposed over HTTP |
| **🌐 Browser** | Built-in browser window (separate from Knowledge Management): multi-tab, bookmarks, offline page saving, and AI-controllable pages — agents navigate, read text / Markdown / HTML, click, type and take screenshots through the `browser_*` tools, with auto-recycled AI tabs |
| **🗣️ Speech** | Local TTS (Kokoro / Piper via ONNX) and ASR (ONNX Whisper, Whisper API, Qwen3-ASR with streaming punctuation) |
| **📦 Also included** | Learning module (mastery map, review, mistake book, exams), a task kanban inside Knowledge Management (per-attribute grouping, quick capture, drag to change status, archive), offline maps (MBTiles), session logs, bilingual in-app help |

Background tasks keep running when the window is closed to the tray, closing is guarded while tasks run, and settings live in a separate window.

## 🚀 Getting started

### Requirements

- **OS**: Windows 10+ / macOS 12+ / Linux (Ubuntu 20.04+)
- **Node.js**: 18 or newer (20 LTS recommended)
- **Hardware**: 8 GB RAM minimum with remote APIs; 16 GB+ and a GPU recommended when running local models

### Development

```bash
npm install     # install dependencies
npm run dev     # start the app in development mode
```

If you are behind a slow network in China, use a mirror for the Electron binary before installing:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install --registry=https://registry.npmmirror.com
```

### Build

| Command | Output |
|:---|:---|
| `npm run build` | Unpacked app in `release/` (fast local check) |
| `npm run build:dist` | Windows installer (NSIS) |
| `npm run build-portable` | Windows portable build |
| `npm run build-linux` | Linux AppImage / deb |
| `npm run release:win` | **Publish-ready Windows set**: portable `.exe` + green `.rar` (from the unpacked folder) |
| `npm run release:win-setup` | Same, plus the NSIS installer |
| `npm run release:linux` | Linux AppImage / deb through the WSL one-click script, then collected |
| `npm run release:all` | Windows first, then Linux — a full publish-ready `release/` |
| `npm run release:collect` | Only collect/rename the current artifacts (and rebuild the green RAR) |

`scripts/collect-release.mjs` normalises whatever electron-builder produced into the published names — `AI-KM_Windows_<ver>_x86_64_Portable.exe`, `AI-KM_Windows_<ver>_x86_64_green.rar`, `AI-KM_Linux_<ver>_x86_64.AppImage`, `AI-KM_Linux_<ver>_amd64.deb`, `AI-KM_Linux_<ver>_arm64.deb`, `AI-KM_Mac_<ver>_<arch>.dmg` — and packs the unpacked `release/AI-KM` folder into the green RAR (WinRAR's `Rar.exe`; override the path with `AIKM_RAR`). It is idempotent, so re-running it is safe.

### Automated releases (GitHub Actions)

`.github/workflows/build.yml` builds all three platforms in parallel on every push to `main` and then publishes the packages to the GitHub Release tagged `v<version>` (the `version` field of `package.json`):

| Platform | Package published |
|:---|:---|
| Windows | `AI-KM_Windows_<ver>_x86_64_Setup.exe` (NSIS installer) and `AI-KM_Windows_<ver>_x86_64_Portable.exe` (single-file portable) |
| Linux | `AI-KM_Linux_<ver>_x86_64.AppImage`, `AI-KM_Linux_<ver>_amd64.deb`, `AI-KM_Linux_<ver>_arm64.deb` |
| macOS (Apple Silicon) | `AI-KM_Mac_<ver>_arm64.dmg` |

* Bump `version` in `package.json` before releasing — an existing release gets its same-named assets replaced (`--clobber`, hand-written notes are kept), while a new version creates a new release with generated notes.
* Pull requests and documentation-only pushes only build; they never publish.
* The macOS build is unsigned (no Apple Developer certificate): first launch needs **right-click → Open**, or `xattr -cr /Applications/AI-KM.app`.
* CI packages cannot include the ~30 MB offline basemap (`public/maps/*.mbtiles` is generated from a local tile pyramid); `public/drawio` *is* fetched before packaging, so `.drawio` editing works. Use `npm run release:*` locally if you want the basemap inside the package.
* The green RAR is not built in CI (no WinRAR on the runners) — use `npm run release:win` locally for it.

### Optional local assets (not committed)

A few large assets are intentionally **not** in this repository. The app runs fine without them — the related feature is just empty until you generate them locally:

| Asset | How to build / fetch it | What breaks without it |
|:---|:---|:---|
| `public/maps/*.mbtiles` (~30 MB) | Pack your own tile pyramid (`public/tiles/<z>/<x>/<y>.png`):<br>`python scripts/make-builtin-mbtiles.py --src public/tiles/6 --out public/maps/builtin.mbtiles --name "Offline basemap"`<br>*Python 3 standard library only; any `*.mbtiles` in that folder is picked up automatically* | Map view has no built-in offline basemap (you can still mount your own package in **Settings → General → Other → Offline map**) |
| `public/drawio/` (~65 MB) | `node scripts/fetch-drawio-webapp.mjs` (add `--force` to re-download) | `.drawio` files cannot be opened / edited offline |
| `public/excalidraw-assets-dev/` (~18 MB, dev only) | Dev-time Excalidraw assets | Whiteboard assets for `npm run dev` |

`scripts/` follows the same policy: only the build/runtime helpers (`rename-unpacked`, `collect-release`, `build-tts-worker`, `fetch-drawio-webapp`, `make-builtin-mbtiles`, `build-linux-all.sh` + `build-linux-all.cmd`) are versioned; one-off diagnostics, test fixtures and benchmark data stay local.

Type check the renderer before committing: `npx vue-tsc --noEmit -p tsconfig.json`.

## 🗂 Project structure

```
electron/main/      Electron main process (window, IPC, MCP runtime, AI service, TTS/ASR workers)
electron/preload/   Preload bridge exposed to the renderer
src/components/     Renderer shell & shared UI (home, knowFile, knowRAG, learning, browser, set)
src/features/       Self-contained subsystems (workflow, data canvas, agent scaffold)
src/lib/            Shared libraries (markdown / block editor, export, file handling, task files)
src/services/       Renderer-side services (agent skills, KB reader, speech)
src/shared/         Code shared by main and renderer (AI core, tool registry, retrieval, search)
src/store/          Pinia stores (config, chats, swarm, running tasks)
manual/             User manual (Chinese) and Linux packaging guide
CHANGELOG.md        Change log (Chinese, primary) — mirrored in English by CHANGELOG.en.md
```

## 📖 Documentation

| Document | Description |
|:---|:---|
| [CHANGELOG.md](CHANGELOG.md) | 更新日志（中文，主档）— every user-visible change, newest first |
| [CHANGELOG.en.md](CHANGELOG.en.md) | Changelog in English |
| [manual/使用说明书.md](manual/使用说明书.md) | Complete Chinese user manual (also readable inside the app) — 11 chapters matching the in-app help: quick start, concepts, reasoning, knowledge management, knowledge processing, learning, general files, special files, browser, plugins, settings |
| [manual/Linux打包指南.md](manual/Linux打包指南.md) | Linux packaging notes |
| In-app help | **Settings → Help**: the same 11 sections (quick start, concepts, reasoning, knowledge, processing, learning, general files, special files, browser, plugins, settings) plus **Changelog** and **Credits** |

The changelog shown in **Settings → Help → Changelog** is the same file as the repository root `CHANGELOG.md` (English UI reads `CHANGELOG.en.md`), so the app and the repository never drift apart.

## 🔒 Privacy

- All chats, knowledge bases, workflows and logs are stored locally (app data folder + the folders you choose).
- No telemetry and no cloud sync; network access happens only when you use a remote model, search or MCP service you configured.
- API keys are kept in your local configuration and are masked in the UI.

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/whl1207/Knowledge](https://github.com/whl1207/Knowledge).

Before opening a PR, please make sure:

1. `npx vue-tsc --noEmit -p tsconfig.json` passes (add `npx tsc -p tsconfig.node.json --noEmit` when the main process changed).
2. User-visible changes are added to the top of `CHANGELOG.md` (one short sentence per entry).
3. The in-app help (`src/components/set/Help.vue`) and the manual are updated when behaviour changes.

## 📄 License

[PolyForm Noncommercial 1.0.0](LICENSE) © 2024 whl

**Source-available, not open source.** Use is free for any **noncommercial** purpose — personal use, study, research, experiment, hobby projects, and use by charitable, educational, public-research, public-health and government organizations. **Any commercial use requires a separate licence from the author.** Noncommercial redistribution is allowed as long as the licence terms and the `Required Notice` line travel with the software; the software is provided as is, without warranty.

For commercial licensing, open an issue at [github.com/whl1207/Knowledge](https://github.com/whl1207/Knowledge/issues).

## 🙏 Acknowledgements

Project scaffolding based on [electron-vite-vue](https://github.com/electron-vite/electron-vite-vue). Thanks to the open-source projects this app builds on, including Vue 3, Element Plus, Electron, Monaco Editor, draw.io, Excalidraw, Mermaid, MathJax, PDF.js, Leaflet, Yjs, ONNX Runtime, sherpa-onnx, sql.js, xlsx and the Model Context Protocol SDK.
