<script setup lang="ts">
/**
 * BlockCode.vue — 代码块的编辑面板（monaco-editor）
 *
 * 布局：语言选择放在**上方一行**（原先是塞在右侧），下方是 Monaco 编辑区。
 * 高度跟随行数自适应（8 行以内不滚动），超过则内部滚动，避免撑爆页面。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { ensureMonacoEnvironment } from '@/lib/monaco-env'
import { usestore } from '@/store'

ensureMonacoEnvironment()

const props = withDefaults(
  defineProps<{
    /** 代码正文（不含围栏） */
    modelValue: string
    /** 围栏语言标记 */
    lang: string
    zh: boolean
    /** 是否显示上方语言栏（独立公式块只借 Monaco 编辑，不改语言） */
    showLang?: boolean
    /** 字号：跟随状态栏的 A- / A+ */
    fontSize?: number
  }>(),
  { showLang: true, fontSize: 0 }
)

const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'lang-change', value: string): void
  (e: 'exit'): void
}>()

const store = usestore()
const hostRef = ref<HTMLElement | null>(null)
const lineCount = ref(Math.max(1, props.modelValue.split('\n').length))

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let applying = false

/** 常见围栏语言 → Monaco 语言 id */
const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  python: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  h: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  php: 'php',
  rb: 'ruby',
  ruby: 'ruby',
  sh: 'shell',
  bash: 'shell',
  shell: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  powershell: 'powershell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
  r: 'r',
  lua: 'lua',
  perl: 'perl',
  scala: 'scala',
  kotlin: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  tex: 'latex',
  latex: 'latex',
}

/** 语言选择框的候选项（也用于 datalist 提示） */
const LANG_OPTIONS = [
  'text', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust',
  'php', 'ruby', 'shell', 'powershell', 'sql', 'html', 'css', 'scss', 'json', 'yaml', 'xml',
  'markdown', 'mermaid', 'vue', 'ini', 'dockerfile', 'lua', 'r', 'kotlin', 'swift', 'dart', 'latex',
]

function monacoLang(lang: string): string {
  const key = (lang || '').trim().toLowerCase()
  if (!key || key === 'text' || key === 'txt') return 'plaintext'
  return LANG_MAP[key] ?? 'plaintext'
}

// Monaco 没有内置 LaTeX：注册一个简易 Monarch 分词，让公式块也有高亮
let latexRegistered = false
function ensureLatexLanguage(): void {
  if (latexRegistered) return
  latexRegistered = true
  if (monaco.languages.getLanguages().some((l) => l.id === 'latex')) return
  monaco.languages.register({ id: 'latex' })
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/\\(?:begin|end)\{[^}]*\}/, 'keyword.control'],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\$\$?/, 'string'],
        [/[a-zA-Z]/, 'identifier'],
        [/[0-9]+(?:\.[0-9]+)?/, 'number'],
        [/[{}]/, 'delimiter'],
        [/[\[\]]/, 'delimiter'],
        [/[&_^~%]/, 'operator'],
      ],
    },
  })
}

/** 与全局 .scoll 一致的滚动条尺寸 */
const SCROLLBAR_SIZE = 5

/** CSS 颜色 → Monaco 需要的 #RRGGBBAA（只认 hex / rgb，解析不了返回 null） */
function toHex8(raw: string, alpha: number): string | null {
  const s = (raw || '').trim()
  if (!s) return null
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  let m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return '#' + m[1].split('').map((c) => c + c).join('') + a
  m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) return '#' + m[1] + a
  m = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(s)
  if (m) {
    return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('') + a
  }
  return null
}

/** 自定义主题：滑块取项目的 menuActiveColor，尺寸由 scrollbar 选项控 */
let themeKey = ''
function ensureThemes(): void {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--menuActiveColor')
  if (accent.trim() === themeKey) return
  themeKey = accent.trim()
  const colors: Record<string, string> = {}
  const base = toHex8(accent, 0.45)
  const hot = toHex8(accent, 0.75)
  if (base) colors['scrollbarSlider.background'] = base
  if (hot) {
    colors['scrollbarSlider.hoverBackground'] = hot
    colors['scrollbarSlider.activeBackground'] = hot
  }
  monaco.editor.defineTheme('be-code-light', { base: 'vs', inherit: true, rules: [], colors })
  monaco.editor.defineTheme('be-code-dark', { base: 'vs-dark', inherit: true, rules: [], colors })
  monaco.editor.defineTheme('be-code-hc', { base: 'hc-black', inherit: true, rules: [], colors })
}

/** Monaco 主题跟随项目 UI 配色（滑块与全局 .scoll 同色） */
function currentTheme(): string {
  ensureThemes()
  const t = store.UI.theme
  if (t === '深色') return 'be-code-hc'
  if (t === '灰色') return 'be-code-dark'
  if (t === '浅色') return 'be-code-light'
  const hex = String(store.UI.backgroundColor || '').trim()
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex)
  if (m) {
    let v = m[1]
    if (v.length === 3) v = v.split('').map((c) => c + c).join('')
    const r = parseInt(v.slice(0, 2), 16)
    const g = parseInt(v.slice(2, 4), 16)
    const b = parseInt(v.slice(4, 6), 16)
    return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? 'be-code-light' : 'be-code-dark'
  }
  return 'be-code-dark'
}

/** Monaco 行高：显式指定才会与算高度的假设一致，且需跟随字号缩放 */
const BASE_FONT = 13.5
const LINE_RATIO = 20 / BASE_FONT
const PAD_Y = 8

function fontNow(): number {
  return props.fontSize || BASE_FONT
}

function lineHeightNow(): number {
  return Math.round(fontNow() * LINE_RATIO)
}

/**
 * 编辑器高度 = 内容实际高度 + 1px 余量。
 * `getContentHeight()` 已经把 Monaco 的上下内边距（padding: PAD_Y）算进去了，
 * 早先再额外加「1 行 + 2×PAD_Y」会让公式/代码块下方多出约两行空白（用户反馈），故只留 1px 防抖余量。
 * 高度贴合内容就不会出现编辑器内部滚动条，长内容交给外层块编辑器滚动。
 */
const hostHeight = ref('120px')

function syncHeight(): void {
  const ed = editor
  if (!ed) return
  const want = Math.ceil(ed.getContentHeight()) + 1
  if (Math.abs(parseFloat(hostHeight.value) - want) < 1) return
  hostHeight.value = want + 'px'
}

function onLangInput(e: Event): void {
  emit('lang-change', (e.target as HTMLInputElement).value)
}

onMounted(() => {
  if (!hostRef.value) return
  ensureLatexLanguage()
  monaco.editor.setTheme(currentTheme())
  editor = monaco.editor.create(hostRef.value, {
    value: props.modelValue,
    language: monacoLang(props.lang),
    theme: currentTheme(),
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'on',
    lineNumbersMinChars: 2,
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 6,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    smoothScrolling: false,
    lineHeight: lineHeightNow(),
    fontSize: fontNow(),
    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
    wordWrap: 'on',
    tabSize: 2,
    padding: { top: PAD_Y, bottom: PAD_Y },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    fixedOverflowWidgets: true,
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      useShadows: false,
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: SCROLLBAR_SIZE,
      horizontalScrollbarSize: SCROLLBAR_SIZE,
    },
  })

  editor.onDidChangeModelContent(() => {
    if (!editor) return
    lineCount.value = editor.getModel()?.getLineCount() ?? 1
    syncHeight()
    if (applying) return
    emit('change', editor.getValue())
  })

  // 换行 / 字号变化都会改变内容高度
  editor.onDidLayoutChange(() => syncHeight())

  // Esc 退出编辑态（交还给块渲染视图）
  editor.addCommand(monaco.KeyCode.Escape, () => emit('exit'))
  editor.focus()
  nextTick(syncHeight)
  window.setTimeout(syncHeight, 0)
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})

watch(
  () => props.modelValue,
  (v) => {
    if (!editor || editor.getValue() === v) return
    applying = true
    editor.setValue(v ?? '')
    applying = false
    lineCount.value = editor.getModel()?.getLineCount() ?? 1
    nextTick(syncHeight)
  }
)

watch(
  () => props.lang,
  (l) => {
    const model = editor?.getModel()
    if (model) monaco.editor.setModelLanguage(model, monacoLang(l))
  }
)

watch(
  () => props.fontSize,
  (v) => {
    editor?.updateOptions({
      fontSize: v || BASE_FONT,
      lineHeight: Math.round((v || BASE_FONT) * LINE_RATIO),
    })
    nextTick(syncHeight)
  }
)

watch(
  () => [store.UI.theme, store.UI.backgroundColor],
  () => monaco.editor.setTheme(currentTheme())
)
</script>

<template>
  <div class="bc-root">
    <!-- 语言栏：置于上方一行（公式块不显示） -->
    <div v-if="showLang" class="bc-bar">
      <i class="fa fa-code bc-bar-icon"></i>
      <input
        class="bc-lang"
        list="be-code-langs"
        :value="lang"
        :placeholder="zh ? '语言（如 js / python）' : 'Language (e.g. js)'"
        spellcheck="false"
        @change="onLangInput"
        @keydown.esc="emit('exit')"
      />
      <datalist id="be-code-langs">
        <option v-for="l in LANG_OPTIONS" :key="l" :value="l" />
      </datalist>
    </div>
    <div ref="hostRef" class="bc-host" :style="{ height: hostHeight }"></div>
  </div>
</template>

<style scoped>
.bc-root {
  margin: 2px 0;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  overflow: hidden;
  background: color-mix(in srgb, var(--fontColor) 4%, transparent);
}

.bc-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border-bottom: 1px solid var(--borderColor);
}

.bc-bar-icon {
  font-size: 11px;
  opacity: 0.5;
}

.bc-lang {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  opacity: 0.85;
}

.bc-lang::placeholder {
  color: var(--fontColor);
  opacity: 0.35;
}

.bc-host {
  width: 100%;
}

/* Monaco 自己画滚动条，没法用 .scoll，这里至少把光标对齐上 */
.bc-root :deep(.monaco-scrollable-element > .scrollbar.horizontal > .slider) {
  cursor: ew-resize !important;
}

.bc-root :deep(.monaco-scrollable-element > .scrollbar.vertical > .slider) {
  cursor: ns-resize !important;
}
</style>
