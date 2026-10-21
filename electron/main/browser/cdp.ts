/**
 * cdp.ts — 每个标签页一条 CDP 连接（Electron webContents.debugger）
 *
 * 为什么需要：P0 的浏览器工具全部走 `executeJavaScript`，只能"注入 JS"：拿不到可访问性树、
 * 派发不了可信输入、等不到页面生命周期。P1 用 CDP 补齐观测/动作/等待。
 *
 * 边界（务必了解）：
 * - `webContents.debugger` 只绑定单个 page target：没有 `Target.*` / `Browser.*`，进不了 OOPIF；
 * - 同一 webContents 同时只能挂一个 debugger：DevTools 打开时会 detach，这里自动重连；
 * - 所有命令带超时，避免页面挂起时把 step 拖死。
 */
import type { WebContents } from 'electron'

const CDP_VERSION = '1.3'
const DEFAULT_TIMEOUT_MS = 15_000

export class CdpSession {
  private attached = false
  private hooked = false
  private listeners = new Map<string, Set<(params: any) => void>>()
  private disposed = false

  constructor(private readonly wc: WebContents) {}

  get isAttached(): boolean {
    return this.attached
  }

  /** 确保已 attach 并 enable 常用域（幂等） */
  async ensure(): Promise<void> {
    if (this.disposed) throw new Error('浏览器标签已关闭')
    if (!this.attached) {
      try {
        this.wc.debugger.attach(CDP_VERSION)
      } catch (err: any) {
        const msg = String(err?.message || err)
        if (/already attached|another debugger/i.test(msg)) {
          // DevTools 正在使用同一个 webContents：给出可操作提示，而不是原始异常
          throw new Error('浏览器调试端口被占用（DevTools 已打开？）：请先关闭该标签的开发者工具再让 AI 操作')
        }
        throw new Error(`无法连接页面调试协议：${msg}`)
      }
      this.attached = true
      this.hook()
    }
    for (const [method, params] of [
      ['Page.enable', {}],
      ['Runtime.enable', {}],
      ['DOM.enable', {}],
      ['Network.enable', {}],
      ['Accessibility.enable', {}],
      ['Page.setLifecycleEventsEnabled', { enabled: true }],
    ] as const) {
      try { await this.send(method, params) } catch { /* 部分域在旧页面/内部页不可用：忽略 */ }
    }
  }

  /** 发一条 CDP 命令；超时 reject */
  async send<T = any>(method: string, params: Record<string, any> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.disposed) throw new Error('浏览器标签已关闭')
    if (!this.attached) await this.ensure()
    const raw = this.wc.debugger.sendCommand(method, params)
    return await withTimeout(raw, timeoutMs, `CDP ${method} 超时`) as T
  }

  /** 订阅 CDP 事件，返回取消函数 */
  on(method: string, cb: (params: any) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(cb)
    return () => { set?.delete(cb) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    if (this.attached) {
      try { this.wc.debugger.detach() } catch { /* 忽略 */ }
      this.attached = false
    }
  }

  private hook(): void {
    if (this.hooked) return
    this.hooked = true
    const onMessage = (_e: any, method: string, params: any) => {
      const set = this.listeners.get(method)
      if (!set?.size) return
      for (const cb of set) {
        try { cb(params) } catch { /* 忽略监听器异常 */ }
      }
    }
    const onDetach = () => {
      // DevTools 打开 / 渲染进程崩溃 / 页面被销毁：保留对象，下一次 send 自动重连
      this.attached = false
    }
    this.wc.debugger.on('message', onMessage)
    this.wc.debugger.on('detach', onDetach)
    // 不主动 removeAllListeners：同一 webContents 只会有我们一个 debugger 使用者
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
