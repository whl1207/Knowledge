import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { defineConfig } from 'vite'
import type { RollupOptions } from 'rollup'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import pkg from './package.json'

// 路径别名：'@' → <projectRoot>/src（与 tsconfig.json / tsconfig.node.json 的 paths 保持一致）
// 注意：vite-plugin-electron 用 configFile: false 单独构建主进程与 preload，不继承根配置，
// 因此下列三处 resolve.alias 必须都显式声明，否则 '@' 在主进程里解析失败。
const srcAlias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
}

// 构建告警过滤：只静音下面这三类**已知且无法在本仓库修掉**的告警，其余一律照常输出。
// 1) Rollup「dynamic import will not move module into another chunk」——
//    store/index.ts、services/ai-utils.ts、@capacitor/core 等既被大量静态导入、又被少量动态导入
//    （打断循环依赖 / 按需加载），Rollup 会把上百个静态导入方一次性列出来，一次构建刷十几屏；
// 2) vite-plugin-electron 的 preload 默认配置带 rolldown 时代的 `platform`（input）与
//    `codeSplitting`（output）；Vite 7 走 Rollup，会把这两个键报成 Unknown input/output options。
//    只按**具体键名**过滤，避免掩盖我们自己配置里的拼写错误。
const IGNORED_ROLLUP_WARNINGS = [
  'dynamic import will not move module into another chunk',
  'Unknown input options: platform',
  'Unknown output options: codeSplitting',
]
const onRollupWarn: NonNullable<RollupOptions['onwarn']> = (warning, warn) => {
  const msg = String(warning?.message || '')
  if (IGNORED_ROLLUP_WARNINGS.some((m) => msg.includes(m))) return
  warn(warning)
}

// TTS worker：主进程构建完成后用 esbuild 单独打包成 Node ESM 文件
// （vite 把 new Worker(new URL()) 当 Web Worker 处理，故不能走 vite worker）
// 成功时不打印任何东西（脚本自身也只在有警告/错误时输出）；失败才把细节抛出来。
const ttsWorkerPlugin = {
  name: 'tts-worker-build',
  closeBundle() {
    try {
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'build-tts-worker.mjs')
      execSync(`node "${script}"`, { stdio: 'inherit' })
    } catch (err) {
      console.error('[tts-worker] build failed:', (err as Error)?.message)
    }
  },
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  fs.rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG

  return {
    // Excalidraw 的入口 main.js 读取 process.env.IS_PREACT / NODE_ENV 来选择 UMD 产物，
    // 浏览器/Electron 渲染进程没有 process 全局，需在编译期替换，避免 "process is not defined"
    define: {
      'process.env.IS_PREACT': 'false',
      // 编译期注入：应用版本号（来自 package.json）与构建时刻（ISO 字符串，渲染端转本地时间）
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString())
    },
    build: {
      chunkSizeWarningLimit: 1500, // 将警告阈值提高到 1500KB（默认是 500KB）
      rollupOptions: {
        // 渲染层同样过滤「dynamic import will not move module…」（见 onRollupWarn 说明）
        onwarn: onRollupWarn,
      },
    },
    // ASR ONNX 推理 Web Worker（asr-onnx-worker.ts）需要 ESM 格式：
    // worker 内动态 import('onnxruntime-web/wasm') 会触发代码分割，
    // 默认 iife 格式不支持代码分割会报 "Invalid value iife for output.format"
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      include: ['pdfjs-dist'],
      exclude: ['onnxruntime-web'], // onnxruntime-web 有 WASM 二进制，预打包可能出问题
    },
    assetsInclude: ['**/*.wasm'], // 确保 WASM 文件被正确处理
    // 渲染进程：'@' → src
    resolve: { alias: srcAlias },
    plugins: [
      vue(),
      electron({
        main: {
          // Shortcut of `build.lib.entry`
          entry: 'electron/main/index.ts',
          onstart({ startup }) {
            if (process.env.VSCODE_DEBUG) {
              console.log(/* For `.vscode/.debug.script.mjs` */'[startup] Electron App')
            } else {
              startup()
            }
          },
          vite: {
            // 主进程单独构建（configFile: false），别名需在此重复声明
            resolve: { alias: srcAlias },
            // 这里只跑主进程的打包：成功时的「building… / watching… / 产物大小表」对日常开发没有信息量，
            // 只保留警告与错误（渲染层 dev server 仍照常打印自己的地址等信息）。
            logLevel: 'warn',
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rollupOptions: {
                onwarn: onRollupWarn,
                plugins: [ttsWorkerPlugin],
                // Some third-party Node.js libraries may not be built correctly by Vite, especially `C/C++` addons, 
                // we can use `external` to exclude them to ensure they work correctly.
                // Others need to put them in `dependencies` to ensure they are collected into `app.asar` after the app is built.
                // Of course, this is not absolute, just this way is relatively simple. :)
                external: (id: string) => {
                    const b = id.replace(/\\/g, '/')
                    const deps = Object.keys('dependencies' in pkg ? pkg.dependencies : {})
                    // 匹配依赖名（作为包名或 node_modules 中的路径）
                    const matchDep = (name: string): boolean =>
                      b === name || b.startsWith(name + '/') || b.includes('/node_modules/' + name + '/')
                    // 所有 dependencies 中的包都 external
                    if (deps.some(d => matchDep(d))) return true
                    // MCP SDK 生态必须运行时从 node_modules 加载：
                    // 项目用的是 SDK 子路径导入（如 @modelcontextprotocol/sdk/client/index.js），
                    // 同时 zod / zod-to-json-schema 不在 dependencies 里也会被内联打包，
                    // 内联后的 zod 与 SDK 期望的 zod v4 schema 结构不一致，
                    // 引发 "v3Schema.safeParse is not a function"（MCP callTool 响应校验崩溃）。
                    return (
                      matchDep('electron') ||
                      matchDep('@modelcontextprotocol/sdk') ||
                      matchDep('zod') ||
                      matchDep('zod-to-json-schema')
                    )
                  },
              },
            },
          },
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: 'electron/preload/index.ts',
          vite: {
            // preload 单独构建（configFile: false），别名需在此重复声明
            resolve: { alias: srcAlias },
            // 同主进程：只留警告与错误，避免 dev 下重复打印「building… / watching…」
            logLevel: 'warn',
            build: {
              sourcemap: sourcemap ? 'inline' : undefined, // #332
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rollupOptions: {
                onwarn: onRollupWarn,
                external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
              },
            },
          },
        },
        // Ployfill the Electron and Node.js API for Renderer process.
        // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
        // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer: {},
      }),
    ],
    server: process.env.VSCODE_DEBUG && (() => {
      const url = new URL(pkg.debug.env.VITE_DEV_SERVER_URL)
      return {
        host: url.hostname,
        port: +url.port,
      }
    })(),
    clearScreen: false,
  }
})
