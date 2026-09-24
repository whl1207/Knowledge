<script setup lang="ts">
  import { ref,watch,onMounted,onBeforeUnmount,nextTick} from 'vue'
  import { ElMessage } from 'element-plus'
  import MarkdownIt from 'markdown-it'
  import mathjax3 from 'markdown-it-mathjax3'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  import 'highlight.js/styles/nnfx-dark.min.css'
  import { hashContent, renderMermaidSvgLenient, getCachedSvgLenient, ensureMermaidInit } from '@/lib/markdown/mermaid'
  import MermaidViewer from '@/components/MermaidViewer.vue'
  import { Transformer } from 'markmap-lib'
  import * as markmap from 'markmap-view'
  import {usestore} from '@/store'
  const store = usestore()
  const props = defineProps({
    content: {
      type: String,
      default: "### 未定义"
    },
    maxHeight: {
      type: String,
      default: null
    },
    fontSize: {
      type: String,
      default: '16px'
    }
  })
  const mddiv = ref(null) //父div
  let prep = ref("") //预览
  let ifmd = ref(true)
  let ifmind = ref(false)
  let id=ref("mindmap"+Date.now()) //svg的ID
  let map = null as any
  let pattern = ref(/[#*-]/)
  ensureMermaidInit()

  // Mermaid 源文本规范化已迁移至 '@/lib/markdown/mermaid-normalize'（顶部 import 的 normalizeMermaidSource）

  const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str:any, lang:any) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs scoll"><code>' +
            hljs.highlight(str,{language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (__) {}
      }
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    }
  }).use(mathjax3)
  .use(mark)

  const defaultFence = md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const langName = info ? info.split(/\s+/g)[0] : ''

    if (langName === 'mermaid') {
      const content = token.content.trim()
      const h = hashContent(content)
      const escaped = md.utils.escapeHtml(content)
      return `<div class="mermaid-wrapper" data-mermaid-hash="${h}"><div class="mermaid-src" style="display:none">${escaped}</div></div>`
    }

    return defaultFence(tokens, idx, options, env, self)
  }

  const renderMermaidDiagrams = async (root?: HTMLElement | null) => {
    const container = root || mddiv.value
    if (!container) return

    const wrappers = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-wrapper'))
    if (!wrappers.length) return

    for (const wrapper of wrappers) {
      const srcEl = wrapper.querySelector<HTMLElement>('.mermaid-src')
      if (!srcEl) continue

      const rawText = srcEl.textContent?.trim()
      if (!rawText) continue

      // 如果已有渲染结果，跳过
      if (wrapper.querySelector('.mermaid-rendered-svg')) continue

      // 检查缓存
      // 检查缓存（键 = 规范化后的源码，与 renderMermaidSvgLenient 一致）
      const cachedSvg = getCachedSvgLenient(rawText)
      if (cachedSvg) {
        wrapper.innerHTML = ''
        const svgContainer = document.createElement('div')
        svgContainer.className = 'mermaid-rendered-svg mermaid-clickable'
        svgContainer.innerHTML = cachedSvg
        svgContainer.setAttribute('data-mermaid-src', rawText)
        svgContainer.addEventListener('click', (e) => {
          e.stopPropagation()
          openMermaidModal(rawText)
        })
        wrapper.appendChild(svgContainer)
        continue
      }

      // 渲染（规范化 + 失败回退原始源码，与块编辑器/展开弹窗完全同一入口）
      try {
        const svgString = await renderMermaidSvgLenient(rawText)
        wrapper.innerHTML = ''
        const svgContainer = document.createElement('div')
        svgContainer.className = 'mermaid-rendered-svg mermaid-clickable'
        svgContainer.innerHTML = svgString
        svgContainer.setAttribute('data-mermaid-src', rawText)
        svgContainer.addEventListener('click', (e) => {
          e.stopPropagation()
          openMermaidModal(rawText)
        })
        wrapper.appendChild(svgContainer)
      } catch (error) {
        console.error('Mermaid render failed:', error)
        wrapper.innerHTML = `<pre class="mermaid-fallback">${md.utils.escapeHtml(rawText)}</pre>`
      }
    }
  }

  //更新目录和预览
  const init=async function(){
    await nextTick()
    if(props.content=="") return
    if(ifmd.value){
      map=null
      prep.value = md.render(props.content!)
    }
    if(ifmind.value){
      markmind()
    }
    await nextTick()
    await renderMermaidDiagrams(mddiv.value)
  }
  // 思维导图（markmap）下，把 mermaid 代码块收敛为“图标记”叶节点并登记源码，
  // 避免整段代码以 <pre> 形式铺在导图里；点击标记可用 MermaidViewer 查看原图
  const collectMermaidForMindmap = (mdText: string) => {
    const sources: string[] = []
    const cleaned = mdText.replace(/```mermaid[^\n]*\n([\s\S]*?)```[ \t]*(?:\n|$)/gi, (_w, src: string) => {
      sources.push(src.trim())
      return '\n- 🧩 Mermaid 图 [' + (sources.length - 1) + ']\n'
    })
    return { cleaned, sources }
  }
  let mmClickBinding: { svg: Element | null; fn: (e: Event) => void } | null = null
  const bindMindmapMermaidClick = (svgEl: Element | null, sources: string[]) => {
    // 清除旧监听，避免重复触发/闭包指向旧 sources
    if (mmClickBinding && mmClickBinding.svg) {
      mmClickBinding.svg.removeEventListener('click', mmClickBinding.fn)
      mmClickBinding = null
    }
    if (!svgEl || !sources.length) return
    const fn = (e: Event) => {
      const target = e.target as Element
      const g = target?.closest ? target.closest('g.markmap-node') : null
      if (!g) return
      const m = (g.textContent || '').match(/🧩 Mermaid 图\s*\[(\d+)\]/)
      if (!m) return
      const src = sources[Number(m[1])]
      if (src) openMermaidModal(src)
    }
    svgEl.addEventListener('click', fn)
    mmClickBinding = { svg: svgEl, fn }
  }
  //创建思维导图
  const markmind=()=>{
    let markdown = props.content
    // 思维导图专用预处理：mermaid 代码块 → “图标记”叶节点
    const { cleaned, sources } = collectMermaidForMindmap(markdown)
    markdown = cleaned
    if(map==null){
        //创建思维导图
        const container = document.getElementById(id.value);
        if (container == null) return;
        container.innerHTML = "";
        
        const transformer = new Transformer()
        const { root, features } = transformer.transform(markdown)
        const { styles, scripts } = transformer.getUsedAssets(features)
        const { Markmap, loadCSS, loadJS } = markmap
        //if (styles) loadCSS(styles);
        if (scripts) loadJS(scripts, { getMarkmap: () => markmap })
        container.style.width = "100%"
        container.style.height = "100%"
        map = Markmap.create('#'+id.value,undefined, root)
      }else{
        //更新数据
        const transformer = new Transformer()
        const { root, features } = transformer.transform(markdown)
        const { styles, scripts } = transformer.getUsedAssets(features)
        const { Markmap, loadCSS, loadJS } = markmap
        //if (styles) loadCSS(styles)
        if (scripts) loadJS(scripts, { getMarkmap: () => markmap })
        map.setData(root)
      }
    // 绑定：点击“🧩 Mermaid 图 [k]”叶节点 → 打开共享 MermaidViewer 查看原图
    const container = document.getElementById(id.value)
    bindMindmapMermaidClick(container ? container.querySelector('svg') : null, sources)
  }
  const isFullscreen = ref(false);
  const mdrender = ref<HTMLElement | null>(null)
  let cMaxHeight=ref(props.maxHeight)
  let cFontSize=ref(props.fontSize)
  const full = () => {
    isFullscreen.value=!isFullscreen.value
    if(isFullscreen.value){
      cMaxHeight.value='100%'
    }else{
      cMaxHeight.value=props.maxHeight
    }
    if(ifmind.value){
      nextTick()
      map=null
      markmind()
    }
  }
  
  const svg = ref<HTMLElement | null>(null)
  //监听变化
  watch(()=>props.content, (newValue, oldValue) => {
    init()
  })
  watch(()=>ifmd.value, (newValue, oldValue) => {
    init()
  })
  watch(()=>ifmind.value, (newValue, oldValue) => {
    init()
  })
  watch(()=>props.maxHeight, (newValue, oldValue) => {
    cMaxHeight.value=props.maxHeight
  })
  watch(()=>props.fontSize, (newValue, oldValue) => {
    cFontSize.value=props.fontSize
  })
  const handleFullscreenChange = () => {
    isFullscreen.value = !!document.fullscreenElement;
  };
  onMounted(()=>{
    init()
    document.addEventListener('fullscreenchange', handleFullscreenChange);
  })
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
  })

  // ===== Mermaid 查看（复用共享组件 MermaidViewer：放大/平移/导出） =====
  const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)
  const openMermaidModal = (source: string) => { mermaidViewerRef.value?.open({ source }) }

  /* ---- 模式切换 ---- */
  const switchMode = (mode: 'render' | 'source' | 'mindmap') => {
    ifmd.value = (mode === 'render')
    ifmind.value = (mode === 'mindmap')
  }

  /* ---- 右键菜单 ---- */
  const contextMenu = ref({ visible: false, x: 0, y: 0 })

  // 复制内容并提示
  const copyContent = () => {
    store.copyToClipboard(props.content)
    hideContextMenu()
    ElMessage.success(store.locales === 'en' ? 'Copied' : '复制成功')
  }

  // 朗读状态（是否正在朗读）
  const isSpeaking = ref(false)
  // 当前选中的文字（朗读时优先读选中内容）
  const selectedText = ref('')
  // 定时刷新朗读状态（用于右键菜单切换"朗读/停止朗读"）
  let ttsStateTimer: ReturnType<typeof setInterval> | null = null

  const refreshTTSState = () => {
    const state = store.getTTSState()
    isSpeaking.value = !!(state && state.isSpeaking)
  }

  // 朗读 / 停止朗读（有选中文字时只朗读选中内容）
  const speakContent = () => {
    if (isSpeaking.value) {
      store.stopTTS()
    } else {
      const text = selectedText.value || props.content
      store.tts(text)
    }
    hideContextMenu()
    refreshTTSState()
  }

  // 打开右键菜单时刷新朗读状态并记录选中文字
  const showContextMenu = (e: MouseEvent) => {
    selectedText.value = window.getSelection()?.toString()?.trim() || ''
    refreshTTSState()
    contextMenu.value = { visible: true, x: e.clientX, y: e.clientY }
    // 朗读进行中时，定时刷新状态（播放可能自动结束）
    if (ttsStateTimer) clearInterval(ttsStateTimer)
    if (isSpeaking.value) {
      ttsStateTimer = setInterval(() => {
        refreshTTSState()
        if (!isSpeaking.value) {
          if (ttsStateTimer) clearInterval(ttsStateTimer)
          ttsStateTimer = null
        }
      }, 500)
    }
  }

  const hideContextMenu = () => {
    contextMenu.value.visible = false
    if (ttsStateTimer) {
      clearInterval(ttsStateTimer)
      ttsStateTimer = null
    }
  }
</script>

<template >
  <div class="mddiv" :class="{ 'fullscreen-active': isFullscreen,'scoll': ifmd,'minddiv': ifmind}" :style="{maxHeight:cMaxHeight,fontSize:!isFullscreen?cFontSize:'',height:!isFullscreen?maxHeight:''}" ref="mddiv" @contextmenu.prevent="showContextMenu">
    <div style="height:100%;width:100%;display: flex;position: relative;">
      <div v-if="ifmd && !ifmind" class="scoll" style="overflow: hidden;overflow-y: auto;z-index: 1;flex:1;">
        <div class="md" v-html="prep" :style="{padding:isFullscreen?'30px':'2px'}" ref="mdrender">
        </div>
      </div>
      <div v-if="!ifmd && !ifmind" class="scoll" style="overflow: hidden;overflow-y: auto;z-index: 1;flex:1;">
        <pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:8px;font-size:13px;line-height:1.5;">{{ props.content }}</pre>
      </div>
      <div v-if="ifmind && !ifmd" style="z-index: 1;flex:1;">
        <svg :id="id" ref="svg"></svg>
      </div>
    </div>
  </div>

  <!-- 右键菜单 -->
  <teleport to="body">
    <div v-if="contextMenu.visible" class="context-menu-overlay" @click="hideContextMenu" @contextmenu.prevent="hideContextMenu"></div>
    <div v-if="contextMenu.visible" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
      <div class="context-menu-item" @click="speakContent()">
        <i :class="isSpeaking ? 'fa fa-stop' : 'fa fa-volume-up'"></i>
        {{ isSpeaking
          ? (store.locales === 'en' ? 'Stop Reading' : '停止朗读')
          : (selectedText
            ? (store.locales === 'en' ? 'Read Selection' : '朗读选中文字')
            : (store.locales === 'en' ? 'Read Aloud' : '朗读')) }}
      </div>
      <div class="context-menu-item" @click="copyContent()">
        <i class="fa fa-copy"></i> {{ store.locales === 'en' ? 'Copy' : '复制' }}
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" @click="switchMode('render'); hideContextMenu()" :class="{ disabled: ifmd && !ifmind }">
        <i class="fa fa-file-text-o"></i>
        {{ store.locales === 'en' ? 'Render' : '渲染模式' }}
      </div>
      <div class="context-menu-item" @click="switchMode('source'); hideContextMenu()" :class="{ disabled: !ifmd && !ifmind }">
        <i class="fa fa-code"></i>
        {{ store.locales === 'en' ? 'Source' : '查看源码' }}
      </div>
      <div v-if="pattern.test(props.content)" class="context-menu-item" @click="switchMode('mindmap'); hideContextMenu()" :class="{ disabled: ifmind }">
        <i class="fa fa-sitemap"></i>
        {{ store.locales === 'en' ? 'Mindmap' : '思维导图' }}
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" @click="full(); hideContextMenu()">
        <i class="fa" :class="isFullscreen ? 'fa-compress' : 'fa-expand'"></i>
        {{ isFullscreen ? (store.locales === 'en' ? 'Exit Fullscreen' : '退出全屏') : (store.locales === 'en' ? 'Fullscreen' : '全屏') }}
      </div>
    </div>
  </teleport>

  <!-- Mermaid 图查看（放大/平移/导出，复用共享组件） -->
  <MermaidViewer ref="mermaidViewerRef" />
</template>

<style scoped>
  .mddiv{/**背景 */
    width:100%;
    height: 100%;
    position:relative;
    margin: 0px;
    overflow: hidden;
    color:var(--fontColor);
    overflow-y: auto;
    z-index:0;
    min-width:100px;
    min-height:35px;
  }

  .minddiv::-webkit-scrollbar {
    display: none;
  }
  .md{
    position: relative;
    user-select:text;
  }

  /* 列表紧凑排版（v-html 内容需 :deep 穿透 scoped）
     原因：入口未引入 public/reset.css，而全局 style.css 只重设了 ul（margin-left/padding-left 8px），
     ol 仍落到浏览器默认（margin 1em 上下 + padding-left 40px）→ 有序列表上下留白、左侧缩进都偏大；
     且 markdown-it 对“项间有空行”的松散列表会给每个 li 包一层 <p>，叠加全局 p 边距后更空。
     这里与 home.vue .message-content 的紧凑规则保持一致。 */
  .md :deep(ol),
  .md :deep(ul) {
    margin: 4px 0;
    padding-left: 20px;
  }
  .md :deep(li) {
    margin: 2px 0;
    padding-left: 0;
  }
  .md :deep(li > p) {
    margin: 0.1em 0;
  }
  .md :deep(li > p:first-child) {
    margin-top: 0;
  }
  .md :deep(li > p:last-child) {
    margin-bottom: 0;
  }

  .mermaid {
    overflow-x: auto;
    margin: 8px 0;
    padding: 8px;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background-color: rgba(255, 255, 255, 0.03);
  }

  .mermaid-fallback {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.4;
    color: var(--fontColor);
  }

  .mermaid svg {
    max-width: 100%;
    height: auto;
  }
  .md::-webkit-scrollbar {
    display: block;
  }
  .markmap{
    position: relative;
    z-index: 1;
    color:var(--fontColor);
    flex:1;
    border-right: 1px solid var(--borderColor);
  }
  .fullscreen-active {
    position: fixed;
    top: 40px;
    left: 0px;
    width:100%;
    height:calc(100% - 42px);
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    z-index:999;
    max-height:100%;
  }
  
  /* ===== Mermaid 包装器 ===== */
  .mermaid-wrapper {
    margin: 8px 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background-color: rgba(255, 255, 255, 0.03);
    overflow: hidden;
  }
  .mermaid-rendered-svg {
    overflow-x: auto;
    padding: 8px;
    cursor: pointer;
    transition: border-color 0.2s ease;
  }
  .mermaid-rendered-svg:hover {
    border-color: rgba(52, 152, 219, 0.4);
  }
  .mermaid-rendered-svg svg {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0 auto;
  }
  .mermaid-fallback {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.4;
    color: var(--fontColor);
    padding: 8px;
  }
  .mermaid-clickable {
    position: relative;
  }
  .mermaid-clickable::after {
    font-family: 'FontAwesome';
    content: '\f002';
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  .mermaid-clickable:hover::after {
    opacity: 0.7;
  }

/* 右键菜单 - 非 scoped 以穿透 teleport */
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 999;
}
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 150px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
  font-size: 12px;
}
.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--fontColor);
  transition: background 0.1s;
}
.context-menu-item:hover {
  background: var(--menuActiveColor);
}
.context-menu-item i {
  width: 16px;
  text-align: center;
  font-size: 13px;
}
.context-menu-item.disabled {
  opacity: 0.4;
  pointer-events: none;
}
.context-menu-divider {
  height: 1px;
  background: var(--borderColor);
  margin: 3px 0;
}
</style>
