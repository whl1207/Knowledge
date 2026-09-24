/**
 * tts-service.ts — 本地 ONNX TTS（Kokoro / Piper）主进程服务（worker 版）
 *
 * sherpa-onnx 的模型加载与合成运行在 worker 线程（tts-worker.ts），
 * 主进程仅做消息转发，避免同步 WASM 推理阻塞主进程事件循环导致窗口卡死。
 *
 * IPC（裸通道，二进制安全）：
 *   tts:status      → { available, version, error }
 *   tts:load        → { engine, modelDir, lang } → TtsModelInfo
 *   tts:synthesize  → { engine, modelDir, text, sid, speed, lang } → Uint8Array(WAV)
 *   tts:dispose     → { success }
 */

import { ipcMain } from 'electron'
import { Worker } from 'node:worker_threads'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// worker 由 scripts/build-tts-worker.mjs 单独打成 Node ESM 文件
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'tts-worker.js')

export interface TtsSynthesizePayload {
  /** 'Kokoro' | 'Piper' */
  engine: string
  modelDir: string
  text: string
  sid?: number
  speed?: number
  lang?: string
}

export interface TtsLoadPayload {
  engine: string
  modelDir: string
  sid?: number
  speed?: number
  lang?: string
}

export interface TtsModelInfo {
  engine: 'Kokoro' | 'Piper'
  modelDir: string
  modelFile: string
  sampleRate: number
  numSpeakers: number
  resolved: Record<string, string>
}

// ---------- worker 管理与消息协议 ----------

let worker: Worker | null = null
let workerReady: Promise<Worker> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function spawnWorker(): Promise<Worker> {
  if (workerReady) return workerReady
  workerReady = (async () => {
    const w = new Worker(workerPath, { type: 'module' } as any)
    w.unref()
    w.on('message', (msg: any) => {
      if (!msg || typeof msg.id !== 'number') return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error || 'TTS 工作线程执行失败'))
    })
    w.on('error', (err) => {
      console.error('[TTS] worker 错误:', err)
      for (const [, p] of pending) p.reject(err)
      pending.clear()
    })
    w.on('exit', (code) => {
      console.warn(`[TTS] worker 退出 code=${code}`)
      if (worker === w) {
        worker = null
        workerReady = null
      }
    })
    worker = w
    return w
  })()
  return workerReady
}

/** 向 worker 发一条消息，返回 Promise */
async function invoke(type: string, payload?: any): Promise<any> {
  const w = await spawnWorker()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      w.postMessage({ id, type, payload })
    } catch (err) {
      pending.delete(id)
      reject(err as Error)
    }
  })
}

// ---------- IPC 处理器 ----------

export function registerTtsIpc(): void {
  ipcMain.handle('tts:status', async () => {
    try {
      return await invoke('status')
    } catch (err: any) {
      return { available: false, version: '', error: err?.message || '未知错误' }
    }
  })

  ipcMain.handle('tts:load', async (_e, payload: TtsLoadPayload) => {
    const info = await invoke('load', {
      engine: payload?.engine,
      modelDir: payload?.modelDir,
      lang: payload?.lang,
    })
    return info as TtsModelInfo
  })

  ipcMain.handle('tts:synthesize', async (_e, payload: TtsSynthesizePayload) => {
    const data = await invoke('synthesize', {
      engine: payload?.engine,
      modelDir: payload?.modelDir,
      text: payload?.text,
      sid: payload?.sid ?? 0,
      speed: payload?.speed ?? 1.0,
      lang: payload?.lang,
    })
    if (!data?.wav || data.wav.byteLength === 0) {
      throw new Error('TTS 合成结果为空')
    }
    // worker 里是 Uint8Array（Buffer 的转移视图），转为 Buffer 返回给渲染进程
    return Buffer.from(data.wav)
  })

  ipcMain.handle('tts:dispose', async () => {
    try { await invoke('dispose') } catch { /* ignore */ }
    return { success: true }
  })
}

/** 应用退出时终止 worker 线程 */
export function disposeTtsService(): void {
  for (const [, p] of pending) p.reject(new Error('应用退出'))
  pending.clear()
  if (worker) {
    try { worker.terminate() } catch { /* ignore */ }
    worker = null
    workerReady = null
  }
}

