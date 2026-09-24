/**
 * build-tts-worker.mjs — 用 esbuild 单独打包 TTS worker 线程
 *
 * vite-plugin-electron 会把 `new Worker(new URL(...))` 当成浏览器 Web Worker
 * 处理（把 node:* 外部化导致失败），所以这里用 esbuild 直接把
 * electron/main/tts-worker.ts 编成 Node ESM 目标文件：
 *   dist-electron/main/tts-worker.js
 * 由 vite.config.ts 主进程构建的 closeBundle 钩子调用，dev/build 都会执行。
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // 项目根
const outDir = path.join(root, 'dist-electron', 'main')

await build({
  entryPoints: [path.join(root, 'electron', 'main', 'tts-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // sherpa-onnx / electron 保持外部（运行时从 node_modules 加载）
  external: ['sherpa-onnx', 'electron'],
  outfile: path.join(outDir, 'tts-worker.js'),
  sourcemap: false,
  logLevel: 'info',
})

console.log('[tts-worker] DONE')
