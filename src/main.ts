import { createApp } from 'vue'
import App from '@/App.vue'
import { aikmDsh, initAikmIpc } from '@/lib/aikmIpc'

// 最早时机领取宿主 IPC 桥（一次性），把桥收进模块作用域 —— 之后 window 上不再有任何通用 IPC 入口，
// 界面半边插件因此拿不到宿主通道。详见 src/lib/aikmIpc.ts 顶部注释。
initAikmIpc()

// Excalidraw 静态资源（字体/vendor）路径：指向 dist 根目录，dev 与 file:// 生产环境均可解析
;(window as any).EXCALIDRAW_ASSET_PATH = './'
import { pinia } from '@/store/pinia'
import { isAuxWindowHash } from '@/store'
import { ElMessage, ElTree } from 'element-plus';
import 'element-plus/theme-chalk/index.css';
import '@/style.css'
import '@/assets/kb-view.css'

// 注：Monaco 不再在入口静态导入（体积巨大）。worker 环境与诊断选项已移至
// src/lib/monaco-env.ts，由各使用 Monaco 的组件（按需异步加载）自行调用
// ensureMonacoEnvironment()，避免 Monaco 进入首屏 bundle、拖慢首屏。

//import '@/demos/ipc'
// If you want use Node.js, the`nodeIntegration` needs to be enabled in the Main process.
// import '@/demos/node'

// ---------------------------------------------------------------------------
// 剪贴板兼容：局域网共享的网页端常以 http://192.168.x.x:3345 打开，
// 属于**非安全上下文**（非 https / 非 localhost），浏览器不提供 navigator.clipboard，
// 于是所有「复制」按钮都会抛 `Cannot read properties of undefined (reading 'writeText')`。
// 这里补一个基于 execCommand 的实现，位置透明，各组件无需改动。
// ---------------------------------------------------------------------------
if (typeof navigator !== 'undefined' && !navigator.clipboard?.writeText) {
  const fallbackWrite = (text: string): boolean => {
    try {
      const ta = document.createElement('textarea')
      ta.value = String(text ?? '')
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (!fallbackWrite(text)) throw new Error('clipboard unavailable')
        },
        readText: async () => '',
      },
    })
  } catch (e) {
    console.warn('[clipboard] 兼容实现注入失败（复制按钮在 http 局域网页可能不可用）:', e)
  }
}

// 系统级听写的悬浮窗只渲染语音面板，不需要插件运行时 / 渲染层任务 / 全局提示
const isVoiceOverlayWindow = window.location.hash.startsWith('#/voice-overlay')

createApp(App)
  .use(pinia)
  .component(ElTree.name!, ElTree)
  .mount('#app')

// 渲染层任务接缝：主进程工具（如 export_word）需要 DOM/MathJax/canvas 时
// 经 `agent/renderer-task` 请求本窗口执行；入口初始化一次，与是否有 agent 会话无关。
// 动态导入：任务模块会拉起导出管线（markdown-it/MathJax/OOXML），不进首屏 bundle。
if (!isVoiceOverlayWindow) {
  import('@/platform/rendererTasks')
    .then((m) => m.initRendererTaskRunner())
    .catch(() => { /* 非 Electron 环境（浏览器 dev）无 preload，忽略 */ })
}

// 插件宿主通知（ctx.host.notify → 主进程广播 plugin:notify）：仅在主窗口弹提示，
// 设置/文件/浏览器等独立窗口不重复弹同一提示。
if (!isAuxWindowHash(window.location.hash)) {
  aikmDsh?.plugin?.onEvent?.((ev) => {
    if (ev.type === 'plugin/notify') ElMessage.info(`[${ev.id}] ${ev.message}`)
  })
}
// 插件工具同步 + 渲染层插件运行时（界面扩展装载；见 src/lib/plugin/runtime.ts）：
// 拉取已激活插件、加载其 client 半边、把插件工具推给能力槽推导；插件停用即刻撤销。
if (!isVoiceOverlayWindow) {
  import('@/lib/plugin/runtime')
    .then((m) => m.initPluginRuntime())
    .catch(() => { /* 非 Electron 环境无 preload，忽略 */ })
}


// 等首帧绘制完成后再淡出加载层，避免深色遮罩刚移除时应用尚未绘制导致白屏
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
})
