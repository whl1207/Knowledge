#!/usr/bin/env node
/**
 * 把 GenOffice 的编辑器构建到 resources/office/ （供主进程以 WebContentsView 内嵌）
 *
 * 产物布局（与编辑器主模块的相对路径约定严格对应，勿改）：
 *   resources/office/<editor>/main/index.cjs   ← esbuild 打包的宿主 API 模块
 *   resources/office/<editor>/preload/index.js ← 来自 apps/<editor>/out/preload（约定：__dirname/../preload/index.js）
 *   resources/office/<editor>/renderer/**      ← 来自 apps/<editor>/out/renderer（约定：__dirname/../renderer/index.html）
 * 依据：apps/docs/src/main/docs-main.ts 的 DocsRuntimeConfig 默认值即 `join(__dirname, '../preload/index.js')`
 * 与 `join(__dirname, '../renderer/index.html')`；configureDocsRuntime() 可覆盖，但我们用默认布局做到零配置。
 *
 * 为什么主模块要自己 esbuild 打包：
 *   上游 apps/<editor>/src/main/index.ts 只是「独立启动」入口（startDocsStandalone），
 *   宿主 API（createDocsView / configureDocsRuntime / setDocsShellWindow …）在 docs-main.ts。
 *   上游 shell 以 workspace 源码形式 import 这些包，我们不是 monorepo，故打成自包含 CJS。
 *
 * 用法：
 *   node scripts/build-office.mjs                      # 默认只构建 docs（Word）
 *   node scripts/build-office.mjs --editors docs,sheets,slides,pdf
 *   node scripts/build-office.mjs --only-bundle        # 跳过渲染层构建，只重新打包主模块
 *   node scripts/build-office.mjs --clean              # 先清空 resources/office
 *   node scripts/build-office.mjs --native-only        # 只安置 Excel 的原生引擎 xlsx-sidecar
 *   node scripts/build-office.mjs --with-sheets-native # sheets 构建时顺带 cargo 编译原生引擎（需 Rust）
 *
 * Excel（sheets）依赖 Rust 侧车 xlsx-sidecar 才能打开 / 保存工作簿（缺了它不是「退化成 JS 引擎」，
 * 而是 workbook:select 直接 ENOENT 失败）。本脚本会把它安置到 resources/native/，主进程按该路径加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'genoffice')
const OUT_ROOT = path.join(ROOT, 'resources', 'office')
const require_ = createRequire(import.meta.url)

/** 编辑器登记表：workspace 包名 + 宿主 API 入口 */
const EDITORS = {
  docs: { pkg: '@genoffice/docs', entry: 'apps/docs/src/main/docs-main.ts', label: 'Word' },
  sheets: { pkg: '@genoffice/sheets', entry: 'apps/sheets/src/main/sheets-main.ts', label: 'Excel' },
  slides: { pkg: '@genoffice/slides', entry: 'apps/slides/src/main/slides-main.ts', label: 'PPT' },
  pdf: { pkg: '@genoffice/pdf', entry: 'apps/pdf/src/main/pdf-main.ts', label: 'PDF' },
}

// ---- 参数解析 ---------------------------------------------------------------

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const argOf = (f, dflt) => {
  const i = argv.indexOf(f)
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt
}

const requested = argOf('--editors', 'docs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const onlyBundle = hasFlag('--only-bundle')
const clean = hasFlag('--clean')
/** 只安置 Excel 的原生引擎（cargo 产物 → resources/native/），不重建任何编辑器产物 */
const nativeOnly = hasFlag('--native-only')
/** sheets 构建时顺带编译原生引擎：没有 Rust 工具链时直接失败（而不是悄悄少一个必需件） */
const buildSheetsNative = hasFlag('--with-sheets-native')

for (const name of requested) {
  if (!EDITORS[name]) {
    console.error(`未知编辑器 "${name}"，可选：${Object.keys(EDITORS).join(' / ')}`)
    process.exit(1)
  }
}

// ---- 小工具 -----------------------------------------------------------------

const MB = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`

function dirSize(dir) {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd || ROOT,
    shell: process.platform === 'win32',
    env: { ...process.env, ...(opts.env || {}) },
  })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（code ${res.status}）`)
}

// ---- 各阶段 -----------------------------------------------------------------

function ensureVendor() {
  const marker = path.join(VENDOR, 'package.json')
  if (!fs.existsSync(marker)) {
    throw new Error(
      `未找到 ${path.relative(ROOT, VENDOR)}/package.json\n  请先执行：node scripts/fetch-office-vendor.mjs（国内推荐加 --mirror）`,
    )
  }
  if (!fs.existsSync(path.join(VENDOR, 'node_modules'))) {
    throw new Error(
      `vendor 依赖未安装\n  cd vendor/genoffice && npm install --registry=https://registry.npmmirror.com`,
    )
  }
}

/** 阶段 1：electron-vite 构建渲染层与 preload
 *
 * 注意：不调用上游的 workspace 脚本 `npm run build -w @genoffice/<app>`，
 * 因为 apps/sheets 的 build 脚本会先跑 `native:build`（cargo 编译 xlsx-sidecar）。
 * 那条 cargo 步骤由本脚本自己的 native 阶段负责（见 stageSheetsSidecar），
 * 这样「产物是否就位」是显式的，而不是被上游脚本顺序悄悄带过。
 */
function buildRenderer(name) {
  const editor = EDITORS[name]
  const outDir = path.join(VENDOR, 'apps', name, 'out')
  const html = path.join(outDir, 'renderer', 'index.html')
  if (onlyBundle) {
    if (!fs.existsSync(html)) throw new Error(`--only-bundle 需要已有构建产物：${html} 不存在`)
    console.log(`[1/3] ${name}: 跳过渲染层构建（--only-bundle）`)
    return outDir
  }
  console.log(`[1/3] ${name}: electron-vite build（渲染层 + preload）`)
  run('npx', ['electron-vite', 'build'], {
    cwd: path.join(VENDOR, 'apps', name),
    env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  })
  if (!fs.existsSync(html)) throw new Error(`构建后仍缺少 ${html}`)
  return outDir
}

/** 阶段 2：用 vite 构建 API 打包宿主 API 主模块 → main/index.cjs
 *
 * 为什么不用 esbuild：上游主进程代码里有 vite 专有语法（`?raw` / `?asset` 等），
 * esbuild 无法解析（会报 "Top-level return cannot be used inside an ECMAScript module"）。
 * vite 构建 API 与上游 electron-vite 同工具链，`?raw` 原生可用；`?asset` 需自备插件（见下）。
 */
async function bundleMain(name, outDir) {
  const editor = EDITORS[name]
  const entry = path.join(VENDOR, editor.entry)
  if (!fs.existsSync(entry)) throw new Error(`缺少主模块入口：${editor.entry}`)

  const { build } = await import('vite')
  const outDirMain = path.join(OUT_ROOT, name, 'main')
  fs.mkdirSync(outDirMain, { recursive: true })

  console.log(`[2/3] ${name}: vite 打包主模块（宿主 API）`)
  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [
      /**
       * `?asset` / `?url` 是 electron-vite 的专有后缀（主进程里拿到资源路径）：
       * 把文件拷到产物目录的 assets/ 下，并导出其**运行时绝对路径**
       * （bundle 是 CJS，__dirname 即产物所在目录，dev 与打包后都成立）。
       * 主要来源：slides 的 Carlito 字体与 harfbuzz.wasm。
       */
      {
        name: 'aikm-asset-query',
        enforce: 'pre',
        async resolveId(id, importer) {
          const m = /^(.*)\?(asset|url)$/.exec(id)
          if (!m) return null
          const resolved = await this.resolve(m[1], importer, { skipSelf: true })
          return resolved ? `${resolved.id}?${m[2]}` : null
        },
        load(id) {
          const m = /^(.*)\?(asset|url)$/.exec(id)
          if (!m) return null
          const file = m[1]
          const assetsDir = path.join(outDirMain, 'assets')
          fs.mkdirSync(assetsDir, { recursive: true })
          const base = path.basename(file)
          fs.copyFileSync(file, path.join(assetsDir, base))
          return `export default require('path').join(__dirname, ${JSON.stringify(`assets/${base}`)});`
        },
      },
      {
        name: 'aikm-cjs-import-meta-url',
        enforce: 'post',
        renderChunk(code) {
          return code.replaceAll(
            'import.meta.url',
            'require("url").pathToFileURL(__filename).href',
          )
        },
      },
    ],
    build: {
      ssr: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      emptyOutDir: true,
      outDir: outDirMain,
      lib: {
        entry,
        formats: ['cjs'],
        // 返回的是「基名」，扩展名由 vite 按 format 追加 → index.cjs
        fileName: () => 'index',
      },
      rollupOptions: {
        // electron 由运行时提供；node 内建保持外部化
        external: ['electron', /^node:/],
        // SSR 构建会忽略 lib.fileName，这里显式锁定入口 chunk 名（懒加载 chunk 保持哈希名）
        output: {
          entryFileNames: 'index.cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
    // 关键：否则 vite 会把宿主项目的 public/（maps / drawio / 字体…）整个拷进输出目录
    publicDir: false,
  })

  let dest = path.join(outDirMain, 'index.cjs')
  // 兜底：不同 vite 版本命名策略可能不同 —— 入口 chunk 一定是最大的那个 .cjs
  if (!fs.existsSync(dest)) {
    const chunks = fs
      .readdirSync(outDirMain)
      .filter((f) => f.endsWith('.cjs'))
      .map((f) => ({ f, size: fs.statSync(path.join(outDirMain, f)).size }))
      .sort((a, b) => b.size - a.size)
    if (!chunks.length) throw new Error('vite 未产出任何 .cjs 产物')
    fs.renameSync(path.join(outDirMain, chunks[0].f), dest)
    console.log(`      入口 chunk 归一化：${chunks[0].f} → index.cjs`)
  }

  if (!fs.existsSync(dest)) throw new Error(`未产出 ${path.relative(ROOT, dest)}`)
  const bytes = fs.statSync(dest).size
  console.log(`      → ${path.relative(ROOT, dest)}  ${MB(bytes)}`)
  return { dest, bytes }
}

/** 阶段 3：拷贝 preload / renderer，并附上许可文件 */
function copyArtifacts(name, outDir) {
  console.log(`[3/3] ${name}: 拷贝 preload 与 renderer`)
  const destRoot = path.join(OUT_ROOT, name)
  for (const part of ['preload', 'renderer']) {
    const src = path.join(outDir, part)
    if (!fs.existsSync(src)) throw new Error(`缺少构建产物 ${path.relative(VENDOR, src)}`)
    copyDir(src, path.join(destRoot, part))
    console.log(`      ${part}: ${MB(dirSize(path.join(destRoot, part)))}`)
  }
}

/**
 * Excel 的原生引擎 xlsx-sidecar：**必需件**，缺了内嵌 Excel 打不开任何工作簿
 * （上游 sheets-main 的 workbook:select 走 client.open()，没有它就 spawn ENOENT）。
 *
 * 安置路径 resources/native/<exe>，与主进程 office-host.ts 的 resolveXlsxSidecarPath()
 * （打包后 <resources>/native/<exe>）以及 electron-builder 的 extraResources 一致。
 */
function stageSheetsSidecar(name) {
  const exe = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const destDir = path.join(ROOT, 'resources', 'native')
  const dest = path.join(destDir, exe)
  const built = path.join(
    VENDOR,
    'apps',
    'sheets',
    'native',
    'xlsx-engine',
    'target',
    'release',
    exe,
  )
  const override = process.env.XLSX_SIDECAR_PATH
  const hint =
    `Excel 原生引擎 ${exe} 未就位：它是内嵌 Excel 的**必需组件**（不是可选优化），\n` +
    `缺它时打开 .xlsx 只会得到一张空表。\n` +
    `  构建：装好 Rust 工具链后执行 node scripts/build-office.mjs --native-only --with-sheets-native\n` +
    `  或：用环境变量 XLSX_SIDECAR_PATH 指向已编译好的 ${exe}`

  if (buildSheetsNative) {
    if (spawnSync('cargo', ['--version'], { shell: process.platform === 'win32' }).status !== 0) {
      throw new Error(`--with-sheets-native 需要 Rust 工具链，但 cargo 不在 PATH 中。\n${hint}`)
    }
    console.log(`[native] ${name}: cargo build --release（xlsx-sidecar）`)
    run(
      'cargo',
      [
        'build',
        '--release',
        '--manifest-path',
        path.join('native', 'xlsx-engine', 'Cargo.toml'),
        '--config',
        path.join('native', 'xlsx-engine', '.cargo', 'config.toml'),
      ],
      { cwd: path.join(VENDOR, 'apps', 'sheets') },
    )
  }

  const source = override && fs.existsSync(override) ? override : fs.existsSync(built) ? built : null
  if (!source) {
    if (buildSheetsNative || nativeOnly) throw new Error(hint)
    console.warn(`\n[!] ${hint}\n`)
    return null
  }
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(source, dest)
  console.log(`[native] ${name}: ${path.relative(ROOT, source)} → ${path.relative(ROOT, dest)}  ${MB(fs.statSync(dest).size)}`)
  return dest
}

function copyLicenses() {
  for (const f of ['LICENSE', 'NOTICE', 'LICENSE-UNICODE.txt']) {
    const src = path.join(VENDOR, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_ROOT, f))
  }
  const notices = `本目录由 scripts/build-office.mjs 从 GenOffice（${JSON.parse(
    fs.readFileSync(path.join(__dirname, 'office-vendor.lock.json'), 'utf8'),
  ).commit}）构建。

GenOffice — Copyright 2026 Mainfunc, Inc. — Apache License 2.0
AI-KM 以内嵌方式使用其编辑器内核；GenOffice / Genspark 名称与商标归 Mainfunc, Inc. 所有（Apache-2.0 §6），
AI-KM 不主张也无权使用该品牌。
`
  fs.writeFileSync(path.join(OUT_ROOT, 'PROVENANCE.txt'), notices, 'utf8')
}

// ---- 主流程 -----------------------------------------------------------------

async function main() {
  console.log('构建 Office 编辑器内核 → resources/office/\n')
  ensureVendor()

  // 只安置 Excel 的原生引擎：不碰编辑器产物，方便「编辑器早就构建好了，只补引擎」
  if (nativeOnly) {
    const dest = stageSheetsSidecar('sheets')
    console.log(`\n✓ 原生引擎就位：${path.relative(ROOT, dest)}`)
    return
  }

  if (clean) {
    console.log(`清理 ${path.relative(ROOT, OUT_ROOT)}/`)
    fs.rmSync(OUT_ROOT, { recursive: true, force: true })
  }
  fs.mkdirSync(OUT_ROOT, { recursive: true })

  const summary = []
  for (const name of requested) {
    const label = EDITORS[name].label
    console.log(`\n=== ${name}（${label}）===`)
    const outDir = buildRenderer(name)
    const bundled = await bundleMain(name, outDir)
    copyArtifacts(name, outDir)
    summary.push({ name, label, main: bundled.bytes, total: dirSize(path.join(OUT_ROOT, name)) })
  }

  // Excel 的原生引擎与编辑器产物分开安置（不在 resources/office 下，见 office-host.ts 的解析顺序）
  if (requested.includes('sheets')) stageSheetsSidecar('sheets')

  copyLicenses()

  console.log('\n=== 汇总 ===')
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(7)} ${s.label.padEnd(5)} 主模块 ${MB(s.main).padStart(9)}  合计 ${MB(s.total).padStart(9)}`)
  }
  console.log(`  输出目录 ${path.relative(ROOT, OUT_ROOT)}/  总计 ${MB(dirSize(OUT_ROOT))}`)
  console.log('\n下一步：主进程 office-host 通过 createRequire 加载 <editor>/main/index.cjs')
}

main().catch((e) => {
  console.error('\n✗ 构建失败：', e.message)
  process.exit(1)
})
