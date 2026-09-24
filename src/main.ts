import { createApp } from 'vue'
import App from '@/App.vue'

// Excalidraw 静态资源（字体/vendor）路径：指向 dist 根目录，dev 与 file:// 生产环境均可解析
;(window as any).EXCALIDRAW_ASSET_PATH = './'
import { pinia } from '@/store/pinia'
import { ElTree } from 'element-plus';
import 'element-plus/theme-chalk/index.css';
import '@/style.css'
import '@/assets/kb-view.css'

// 注：Monaco 不再在入口静态导入（体积巨大）。worker 环境与诊断选项已移至
// src/lib/monaco-env.ts，由各使用 Monaco 的组件（按需异步加载）自行调用
// ensureMonacoEnvironment()，避免 Monaco 进入首屏 bundle、拖慢首屏。

//import '@/demos/ipc'
// If you want use Node.js, the`nodeIntegration` needs to be enabled in the Main process.
// import '@/demos/node'

createApp(App)
  .use(pinia)
  .component(ElTree.name!, ElTree)
  .mount('#app')

// 渲染层任务接缝：主进程工具（如 export_word）需要 DOM/MathJax/canvas 时
// 经 `agent/renderer-task` 请求本窗口执行；入口初始化一次，与是否有 agent 会话无关。
// 动态导入：任务模块会拉起导出管线（markdown-it/MathJax/OOXML），不进首屏 bundle。
import('@/platform/rendererTasks')
  .then((m) => m.initRendererTaskRunner())
  .catch(() => { /* 非 Electron 环境（浏览器 dev）无 preload，忽略 */ })

// 等首帧绘制完成后再淡出加载层，避免深色遮罩刚移除时应用尚未绘制导致白屏
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
})
