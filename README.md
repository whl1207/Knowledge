# AI-KM

**A local-first AI knowledge management platform — chat, knowledge bases, ontology modelling, agentic skills, visual workflows and MCP tools in one desktop app.**

Built with **Vue 3 + Electron + TypeScript**. Everything runs on your own machine: models can be local (Ollama / LM Studio / GPUStack / ONNX) or remote APIs you configure, and no content is sent anywhere else. The UI, the in-app help and the manual are bilingual (Chinese / English).

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange)
![Version](https://img.shields.io/badge/version-6.9.24-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-30-47848F)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883)

---

## ✨ What it does

| Area | Capabilities |
|:---|:---|
| **🏠 Home (chat)** | Plain chat · RAG chat over a knowledge base · workflow-triggered chat · skill / agent chat with autonomous planning · PTC (model writes code that composes tool calls) · swarm chat with Agent presets; multi-chat sidebar, per-chat model binding, context-usage ring, branch tree, attachments, stop & steer |
| **📚 Knowledge management** | 12 reading / editing views (browse, source, visual block editor, mind map, presentation, graph, …) plus dedicated views for `.drawio`, `.excalidraw`, PDF, images, code and media; export Markdown / Word / PDF; document smart actions (chat with a document); LAN collaborative editing and read-only remote shares |
| **🔬 Knowledge processing** | Import Markdown / PDF / Word / TXT, configurable chunking, embedding & vector storage, retrieval strategies (hybrid, agentic evidence reranking, ontology-augmented), Q&A test sets with automatic scoring, knowledge base Q&A page |
| **🧠 Ontology modelling** | Entity & relation extraction from slices, force-directed visualisation, entity cards, ontology-augmented retrieval with configurable score boosting |
| **🔗 Workflow** | Visual node editor (agent, MCP, Python, data, iteration, aggregator, Word export, web search, …) with test runs and inspectable intermediate output |
| **🤖 Agent Scaffold** | Table-driven batch agents, per-column table reasoning, link & file collectors, data canvas; multi-round runs with per-round snapshots, per-row status / filters / retries, trajectory graph and Excel export; can also be driven from external MCP clients |
| **🧩 Skills & presets** | Codex-style skill import, reusable Agent presets (role, model, per-tool switches, attached skills), skill store |
| **🔌 Models, tools & MCP** | Ollama / LM Studio / GPUStack / DeepSeek / OpenAI-compatible and multiple custom providers with per-provider enable + connection test; credential table; per-tool switches; built-in MCP services (Office Word & Excel, draw.io, PostgreSQL, literature search, web search, browser) optionally exposed over HTTP |
| **🗣️ Speech** | Local TTS (Kokoro / Piper via ONNX) and ASR (ONNX Whisper, Whisper API, Qwen3-ASR with streaming punctuation) |
| **📦 Also included** | Learning module (mastery map, review, mistake book, exams), todo board (memo / tree / month view), offline maps (MBTiles), built-in browser with auto-recycled AI tabs, session logs, bilingual in-app help |

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

### Optional local assets (not committed)

A few large assets are intentionally **not** in this repository. The app runs fine without them — the related feature is just empty until you generate them locally:

| Asset | How to build / fetch it | What breaks without it |
|:---|:---|:---|
| `public/maps/*.mbtiles` (~30 MB) | Pack your own tile pyramid (`public/tiles/<z>/<x>/<y>.png`):<br>`python scripts/make-builtin-mbtiles.py --src public/tiles/6 --out public/maps/builtin.mbtiles --name "Offline basemap"`<br>*Python 3 standard library only; any `*.mbtiles` in that folder is picked up automatically* | Map view has no built-in offline basemap (you can still mount your own package in **Settings → General → Other → Offline map**) |
| `public/drawio/` (~65 MB) | `node scripts/fetch-drawio-webapp.mjs` (add `--force` to re-download) | `.drawio` files cannot be opened / edited offline |
| `public/excalidraw-assets-dev/` (~18 MB, dev only) | Dev-time Excalidraw assets | Whiteboard assets for `npm run dev` |

`scripts/` follows the same policy: only the six build/runtime helpers (`rename-unpacked`, `build-tts-worker`, `fetch-drawio-webapp`, `make-builtin-mbtiles`, `build-linux-all.sh` + `build-linux-all.cmd`) are versioned; one-off diagnostics, test fixtures and benchmark data stay local.

Type check the renderer before committing: `npx vue-tsc --noEmit -p tsconfig.json`.

## 🗂 Project structure

```
electron/main/      Electron main process (window, IPC, MCP runtime, AI service, TTS/ASR workers)
electron/preload/   Preload bridge exposed to the renderer
src/components/     Renderer UI (home, knowFile, knowRAG, workFlow, AgentScaffold, DataCanvas, learning, browser, todos, set)
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
| [manual/使用说明书.md](manual/使用说明书.md) | Complete Chinese user manual (also readable inside the app) |
| [manual/Linux打包指南.md](manual/Linux打包指南.md) | Linux packaging notes |
| In-app help | **Settings → Help**: quick start, module-by-module guides, changelog and design references |

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
