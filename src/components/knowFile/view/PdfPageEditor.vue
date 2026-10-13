<script setup lang="ts">
/**
 * PdfPageEditor.vue — PDF「页面管理」对话框（合并 / 删除 / 调整顺序 / 旋转）。
 *
 * 由 PdfViewer 状态栏的「页面管理」按钮打开：把整份 PDF 拆成一页一张的缩略图卡片，
 * 勾选后可批量删除，拖拽或 ‹ › 按钮调整顺序，↺ ↻ 旋转单页，也可把别的 PDF 合并进来
 * （有勾选时插在最后一页勾选之后，否则追加到末尾）。确认后由 pdf-lib 重新组页，
 * 覆盖原文件或另存为新文件。
 *
 * 缩略图**按需渲染**（滚动到才画，最多 2 张并发并缓存），几百页的文档也不会一次画爆。
 * 注意：pdfjs / pdf-lib 的对象一律放在**非响应式**变量里 —— 它们含 ES 私有字段，
 * 被 Vue 的 reactive 代理包一层后调用会抛「cannot read private member」。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { PDFJS_RUNTIME_OPTIONS } from '@/lib/pdfjs'
import { base64ToBytes, bytesToBase64, composePdf, inspectPdf, normalizeAngle } from '@/lib/knowFile/pdfEdit'

const props = defineProps<{
  modelValue: boolean
  /** 当前 PDF 的本地绝对路径（远程文件为空或不带盘符） */
  path?: string
  /** 远程预览时直接给的 base64（含 data: 前缀），此时无法覆盖原文件 */
  base64?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 保存成功（覆盖或另存）：path 为实际落盘路径；overwrite 表示是否覆盖了原文件 */
  (e: 'saved', path: string, overwrite: boolean): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const ipc: any = (window as any)?.ipcRenderer

/** 清单中的一页 */
interface PpePage {
  id: string
  /** 源文档下标（0 = 当前 PDF） */
  src: number
  /** 源文档内的页序号（0 起） */
  index: number
  /** 额外旋转角度（0 / 90 / 180 / 270） */
  rotation: number
}

/** 缩略图宽度（CSS px）—— 与实际渲染尺寸解耦，靠 max-width / max-height 自适应 */
const THUMB_W = 150
/** 缩略图缓存上限（条），超出丢弃最早的一张 */
const THUMB_CACHE_MAX = 400

// === 源文档（非响应式） ===
let sources: { name: string; bytes: Uint8Array }[] = []
let srcDocs: (any | null)[] = []
const srcNames = ref<string[]>([])

const pages = ref<PpePage[]>([])
const selected = ref(new Set<string>())
const thumbs = ref<Record<string, string>>({})
const loading = ref(false)
const busy = ref(false)
const dragFrom = ref(-1)
const dragOverIndex = ref(-1)
const gridRef = ref<HTMLDivElement | null>(null)

const total = computed(() => pages.value.length)
const mergedFiles = computed(() => Math.max(0, srcNames.value.length - 1))
const selectedCount = computed(() => selected.value.size)
/** 本地绝对路径 + 非远程 → 可以覆盖原文件 */
const canOverwrite = computed(() => !!props.path && !/^remote:\/\//i.test(props.path))
const localName = computed(() => fileName(props.path) || (zh.value ? '当前 PDF' : 'Current PDF'))

let idSeq = 0
const nextId = () => `pg${++idSeq}`
const fileName = (p?: string) => String(p || '').split(/[\\/]/).pop() || ''

// === 缩略图渲染队列（按需 + 限并发） ===
let queue: { src: number; index: number; rot: number; key: string }[] = []
const pendingKeys = new Set<string>()
let running = 0
let io: IntersectionObserver | null = null
let ioRoot: HTMLElement | null = null
let runToken = 0

const thumbKey = (src: number, index: number, rot: number) => `${src}:${index}:${rot}`
/** 卡片对应的缩略图 key（含旋转：转角后要重画） */
const keyOf = (p: PpePage) => thumbKey(p.src, p.index, p.rotation)

function scheduleThumb(src: number, index: number, rot: number) {
  const key = thumbKey(src, index, rot)
  if (thumbs.value[key] || pendingKeys.has(key)) return
  pendingKeys.add(key)
  queue.push({ src, index, rot, key })
  pump()
}

function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!
    running++
    void renderThumb(job).finally(() => { running--; pump() })
  }
}

async function renderThumb(job: { src: number; index: number; rot: number; key: string }) {
  const token = runToken
  try {
    if (!srcDocs[job.src]) {
      const doc = await pdfjsLib
        .getDocument({ data: sources[job.src].bytes.slice(), ...PDFJS_RUNTIME_OPTIONS })
        .promise
      // 关闭 / 重置后到达的文档不能留活口（否则 worker 泄漏）
      if (token !== runToken || !sources[job.src]) { try { doc.destroy() } catch { /* ignore */ } ; return }
      srcDocs[job.src] = doc
    }
    const page = await srcDocs[job.src].getPage(job.index + 1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({
      scale: THUMB_W / base.width,
      rotation: normalizeAngle(base.rotation + job.rot),
    })
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width * dpr))
    canvas.height = Math.max(1, Math.round(viewport.height * dpr))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    await page.render({ canvasContext: ctx, viewport }).promise
    if (token !== runToken) return
    const keys = Object.keys(thumbs.value)
    if (keys.length >= THUMB_CACHE_MAX) delete thumbs.value[keys[0]]
    thumbs.value[job.key] = canvas.toDataURL('image/jpeg', 0.78)
  } catch (err) {
    console.warn('[PdfPageEditor] 缩略图渲染失败:', err)
  } finally {
    pendingKeys.delete(job.key)
  }
}

/** 全部缩略图位重新纳入观察（新增 / 旋转后需重算，删除与排序沿用原元素即可） */
function observeAll() {
  void nextTick(() => {
    const root = gridRef.value
    if (!root) return
    if (!io || ioRoot !== root) {
      io?.disconnect()
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          const [src, index, rot] = (el.dataset.k || '').split(':').map(Number)
          if (Number.isFinite(src) && Number.isFinite(index)) scheduleThumb(src, index, rot || 0)
          io?.unobserve(el)
        }
      }, { root, rootMargin: '300px' })
      ioRoot = root
    }
    io.disconnect()
    root.querySelectorAll<HTMLElement>('.ppe-thumb').forEach((el) => io!.observe(el))
  })
}

// === 读当前 PDF ===
async function readCurrentBytes(): Promise<Uint8Array> {
  let base64 = props.base64 || ''
  if (!base64 && props.path) {
    const result = await ipc.invoke('readFileBase64', props.path)
    if (typeof result !== 'string' || !result.startsWith('data:')) {
      throw new Error(typeof result === 'string' ? result : 'read failed')
    }
    base64 = result
  }
  if (!base64) throw new Error('empty')
  return base64ToBytes(base64)
}

function reset() {
  runToken++
  queue = []
  pendingKeys.clear()
  running = 0
  io?.disconnect()
  io = null
  ioRoot = null
  for (const d of srcDocs) { try { d?.destroy() } catch { /* ignore */ } }
  srcDocs = []
  sources = []
  srcNames.value = []
  pages.value = []
  selected.value = new Set()
  thumbs.value = {}
  dragFrom.value = -1
  dragOverIndex.value = -1
  loading.value = false
  busy.value = false
}

async function init() {
  reset()
  loading.value = true
  try {
    const bytes = await readCurrentBytes()
    const info = await inspectPdf(bytes)
    sources = [{ name: localName.value, bytes }]
    srcDocs = [null]
    srcNames.value = [localName.value]
    pages.value = Array.from({ length: info.pageCount }, (_, i) => ({ id: nextId(), src: 0, index: i, rotation: 0 }))
    if (info.encrypted) {
      ElMessage.warning(zh.value
        ? '该 PDF 已加密，整理后的文件可能无法正常显示'
        : 'This PDF is encrypted; the edited file may not display correctly')
    }
    observeAll()
  } catch (err) {
    console.error('[PdfPageEditor] 读取 PDF 失败:', err)
    ElMessage.error(zh.value ? '读取 PDF 失败' : 'Failed to read the PDF')
  } finally {
    loading.value = false
  }
}

// === 操作 ===
function toggleSelect(p: PpePage) {
  const set = selected.value
  if (set.has(p.id)) set.delete(p.id)
  else set.add(p.id)
}

const selectAll = () => { selected.value = new Set(pages.value.map((p) => p.id)) }
const clearSelection = () => { selected.value = new Set() }

/** 目标下标 = 最后一张勾选的页之后；没有勾选则追加到末尾 */
function insertAtOfSelection(): number {
  let at = pages.value.length
  pages.value.forEach((p, i) => { if (selected.value.has(p.id)) at = i + 1 })
  return at
}

async function addPdfs() {
  if (busy.value || !ipc?.invoke) return
  let paths: string[] = []
  try {
    paths = await ipc.invoke('selectFiles', {
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
  } catch (err) {
    console.error('[PdfPageEditor] 选择文件失败:', err)
  }
  if (!paths || !paths.length) return

  busy.value = true
  let at = insertAtOfSelection()
  let added = 0
  try {
    for (const p of paths) {
      const result = await ipc.invoke('readFileBase64', p)
      if (typeof result !== 'string' || !result.startsWith('data:')) {
        ElMessage.error(`${fileName(p)}：${zh.value ? '读取失败' : 'read failed'}`)
        continue
      }
      const bytes = base64ToBytes(result)
      let pageCount = 0
      try {
        pageCount = (await inspectPdf(bytes)).pageCount
      } catch (err) {
        console.error('[PdfPageEditor] 解析失败:', p, err)
        ElMessage.error(`${fileName(p)}：${zh.value ? '不是有效的 PDF' : 'not a valid PDF'}`)
        continue
      }
      sources.push({ name: fileName(p), bytes })
      srcDocs.push(null)
      srcNames.value = sources.map((s) => s.name)
      const srcIdx = sources.length - 1
      const list = Array.from({ length: pageCount }, (_, i) => ({ id: nextId(), src: srcIdx, index: i, rotation: 0 }))
      pages.value.splice(at, 0, ...list)
      at += pageCount
      added += 1
    }
  } finally {
    busy.value = false
  }
  if (added) {
    clearSelection()
    observeAll()
    ElMessage.success(zh.value ? `已合并 ${added} 个 PDF` : `Merged ${added} PDF(s)`)
  }
}

async function removeSelected() {
  const ids = [...selected.value]
  if (!ids.length) {
    ElMessage.warning(zh.value ? '请先勾选要删除的页面' : 'Select pages to delete first')
    return
  }
  if (ids.length >= pages.value.length) {
    ElMessage.warning(zh.value ? '至少要保留一页' : 'Keep at least one page')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value ? `将删除 ${ids.length} 页，保存后生效（仅影响保存的文件）。` : `Delete ${ids.length} page(s)? Saved file only.`,
      zh.value ? '确认删除页面' : 'Confirm',
      { type: 'warning' },
    )
  } catch { return }
  pages.value = pages.value.filter((p) => !selected.value.has(p.id))
  clearSelection()
}

/** 把第 from 页移到 to（to 为移动后的目标下标；拖拽放下时传的是目标卡片原位下标） */
function moveTo(from: number, to: number) {
  const list = pages.value
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
}

function onDropAt(target: number) {
  const from = dragFrom.value
  const list = pages.value
  endDrag()
  if (from < 0 || from === target || target < 0 || target >= list.length) return
  // 先取出待移动项会让后面的下标左移一位，落点按方向修正
  moveTo(from, from < target ? target - 1 : target)
  clearSelection()
}

function endDrag() {
  dragFrom.value = -1
  dragOverIndex.value = -1
}

function onDragLeave(index: number) {
  if (dragOverIndex.value === index) dragOverIndex.value = -1
}

/** 旋转：点到的页在勾选集合里时，整组一起转 */
function rotateAt(index: number, delta: number) {
  const page = pages.value[index]
  if (!page) return
  const group = selected.value.has(page.id)
    ? pages.value.filter((p) => selected.value.has(p.id))
    : [page]
  for (const p of group) p.rotation = normalizeAngle(p.rotation + delta)
}

// Chromium 下必须 setData，否则拖拽不会真正开始（拿到的幽灵图也会是空白）
function onDragStart(index: number, e: DragEvent) {
  dragFrom.value = index
  dragOverIndex.value = -1
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', pages.value[index]?.id || '')
}

async function resetAll() {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      zh.value ? '将丢弃所有合并、删除与排序，回到刚打开时的原始页序。' : 'Discard all changes and restore the original pages?',
      zh.value ? '确认重置' : 'Confirm',
      { type: 'warning' },
    )
  } catch { return }
  await init()
}

function close() {
  if (busy.value) return
  reset()
  emit('update:modelValue', false)
}

// === 保存 ===
async function pickSavePath(): Promise<string> {
  const name = fileName(props.path) || 'document.pdf'
  const stem = name.replace(/\.[^.]+$/, '') || 'document'
  const sep = String(props.path || '').includes('\\') ? '\\' : '/'
  let dir = ''
  if (canOverwrite.value) dir = String(props.path).replace(/[\\/][^\\/]*$/, '')
  else if (store.root) dir = String(store.root).replace(/[\\/]$/, '')
  const defaultPath = dir ? `${dir}${sep}${stem}_edited.pdf` : `${stem}_edited.pdf`
  const picked = await ipc.invoke('saveFileDialog', {
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  return typeof picked === 'string' ? picked : ''
}

async function save(overwrite: boolean) {
  if (busy.value || !pages.value.length) return
  if (!ipc?.invoke) {
    ElMessage.warning(zh.value ? '当前环境无法保存文件' : 'Saving is unavailable here')
    return
  }
  if (overwrite) {
    try {
      await ElMessageBox.confirm(
        zh.value
          ? `将用整理后的 ${pages.value.length} 页覆盖原文件，原内容不可恢复。`
          : `Overwrite the original file with the ${pages.value.length} edited page(s)?`,
        zh.value ? '确认覆盖原文件' : 'Confirm overwrite',
        { type: 'warning' },
      )
    } catch { return }
  }

  const target = overwrite ? String(props.path) : await pickSavePath()
  if (!target) return

  busy.value = true
  try {
    const bytes = await composePdf(sources.map((s) => s.bytes), pages.value.map((p) => ({ src: p.src, index: p.index, rotation: p.rotation })))
    const ok = await ipc.invoke('writeFileBase64', target, bytesToBase64(bytes))
    if (!ok) throw new Error('write failed')
    void ipc.invoke('notify-file-changed', { path: target }).catch(() => {})
    ElMessage.success(`${zh.value ? '已保存：' : 'Saved: '}${target}`)
    emit('saved', target, overwrite)
    reset()
    emit('update:modelValue', false)
  } catch (err) {
    console.error('[PdfPageEditor] 保存失败:', err)
    ElMessage.error(zh.value ? '保存失败' : 'Save failed')
  } finally {
    busy.value = false
  }
}

// === 生命周期 ===
const onKeydown = (e: KeyboardEvent) => {
  if (!props.modelValue) return
  if (e.key === 'Escape') { e.stopPropagation(); close() }
  else if (e.key === 'Delete' && selectedCount.value) { e.preventDefault(); e.stopPropagation(); void removeSelected() }
}

watch(() => props.modelValue, (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    void init()
  } else {
    document.removeEventListener('keydown', onKeydown)
  }
}, { immediate: true })

// 旋转后缩略图要重画；排序 / 删除沿用同一批元素，无需重新观察
watch(computed(() => pages.value.map((p) => `${p.id}/${p.rotation}`).join(',')), () => observeAll())

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  reset()
})

const cardTitle = (p: PpePage) => zh.value
  ? `${p.src === 0 ? '原 PDF' : srcNames.value[p.src]} 第 ${p.index + 1} 页（当前第 ${pages.value.indexOf(p) + 1} 页）`
  : `${p.src === 0 ? 'Original' : srcNames.value[p.src]} page ${p.index + 1} (now #${pages.value.indexOf(p) + 1})`
</script>

<template>
  <div v-if="modelValue" class="ppe-overlay" @click.self="close">
    <div class="ppe-content">
      <div class="ppe-header">
        <h3><i class="fa fa-files-o"></i> {{ zh ? '页面管理' : 'Manage pages' }}</h3>
        <span class="ppe-header-info">
          {{ zh ? `共 ${total} 页` : `${total} pages` }}
          <template v-if="mergedFiles">{{ zh ? ` · 已合并 ${mergedFiles} 个文件` : ` · ${mergedFiles} merged` }}</template>
        </span>
        <button class="ppe-close" @click="close" :title="zh ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
      </div>

      <div class="ppe-toolbar">
        <button class="ppe-btn" :disabled="busy || loading" @click="addPdfs" :title="zh ? '合并其它 PDF（插在最后一张勾选的页之后，未勾选则追加到末尾）' : 'Merge PDFs (after the last selected page, else append)'">
          <i class="fa fa-plus"></i> {{ zh ? '添加 PDF' : 'Add PDF' }}
        </button>
        <button class="ppe-btn" :disabled="busy || loading || !selectedCount" @click="removeSelected" :title="zh ? '删除勾选的页面（需确认）' : 'Delete selected pages'">
          <i class="fa fa-trash-o"></i> {{ zh ? '删除选中' : 'Delete' }}<template v-if="selectedCount">{{ ` (${selectedCount})` }}</template>
        </button>
        <span class="ppe-sep"></span>
        <button class="ppe-btn" :disabled="busy || loading" @click="selectedCount === total ? clearSelection() : selectAll()">
          <i class="fa" :class="selectedCount === total && total > 0 ? 'fa-square-o' : 'fa-check-square-o'"></i>
          {{ selectedCount === total && total > 0 ? (zh ? '取消全选' : 'Deselect') : (zh ? '全选' : 'Select all') }}
        </button>
        <button class="ppe-btn" :disabled="busy || loading" @click="resetAll" :title="zh ? '丢弃全部调整，回到原始页序' : 'Discard all changes'">
          <i class="fa fa-undo"></i> {{ zh ? '重置' : 'Reset' }}
        </button>
        <span class="ppe-hint">{{ zh ? '拖拽缩略图可调整顺序' : 'Drag a thumbnail to reorder' }}</span>
      </div>

      <div ref="gridRef" class="ppe-grid scoll">
        <div v-if="loading" class="ppe-empty"><i class="fa fa-spinner fa-spin"></i>
          <span>{{ zh ? '正在读取 PDF…' : 'Loading PDF…' }}</span>
        </div>
        <div v-else-if="!total" class="ppe-empty"><i class="fa fa-file-pdf-o"></i>
          <span>{{ zh ? '没有页面' : 'No pages' }}</span>
        </div>
        <template v-else>
          <div
            v-for="(p, i) in pages"
            :key="p.id"
            class="ppe-card"
            :class="{ selected: selected.has(p.id), 'drag-over': dragOverIndex === i }"
            draggable="true"
            @click="toggleSelect(p)"
            @dragstart="onDragStart(i, $event)"
            @dragover.prevent="dragOverIndex = i"
            @dragleave="onDragLeave(i)"
            @drop.prevent="onDropAt(i)"
            @dragend="endDrag"
          >
            <div class="ppe-thumb" :data-k="keyOf(p)" :title="cardTitle(p)">
              <img v-if="thumbs[keyOf(p)]" :src="thumbs[keyOf(p)]" alt="" draggable="false" />
              <i v-else class="fa fa-file-pdf-o ppe-thumb-ph"></i>
              <span class="ppe-order">{{ i + 1 }}</span>
              <i class="fa fa-check ppe-check"></i>
            </div>
            <div class="ppe-card-foot">
              <span class="ppe-src" :title="cardTitle(p)">
                {{ (p.src === 0 ? (zh ? '原 PDF' : 'Original') : srcNames[p.src]) }} · P{{ p.index + 1 }}
              </span>
              <span class="ppe-card-btns">
                <button class="ppe-mini" :disabled="busy || i === 0" @click.stop="moveTo(i, i - 1)" :title="zh ? '前移' : 'Move up'"><i class="fa fa-arrow-left"></i></button>
                <button class="ppe-mini" :disabled="busy || i === total - 1" @click.stop="moveTo(i, i + 1)" :title="zh ? '后移' : 'Move down'"><i class="fa fa-arrow-right"></i></button>
                <button class="ppe-mini" :disabled="busy" @click.stop="rotateAt(i, -90)" :title="zh ? '向左旋转 90°' : 'Rotate left'"><i class="fa fa-rotate-left"></i></button>
                <button class="ppe-mini" :disabled="busy" @click.stop="rotateAt(i, 90)" :title="zh ? '向右旋转 90°' : 'Rotate right'"><i class="fa fa-rotate-right"></i></button>
              </span>
            </div>
          </div>
        </template>
      </div>

      <div class="ppe-footer">
        <span class="ppe-footer-hint">
          {{ canOverwrite
            ? (zh ? '「保存」将覆盖原文件；也可另存为新文件' : '"Save" overwrites the original; or save as a new file')
            : (zh ? '当前为远程预览，只能另存为新文件' : 'Remote preview: save as a new file only') }}
        </span>
        <button class="ppe-btn" :disabled="busy || loading" @click="close">{{ zh ? '取消' : 'Cancel' }}</button>
        <button class="ppe-btn" :disabled="busy || loading || !total" @click="save(false)" :title="zh ? '另存为新 PDF' : 'Save as a new PDF'">
          <i class="fa fa-files-o"></i> {{ zh ? '另存为…' : 'Save as…' }}
        </button>
        <button class="ppe-btn primary" :disabled="busy || loading || !total || !canOverwrite" @click="save(true)">
          <i class="fa" :class="busy ? 'fa-spinner fa-spin' : 'fa-save'"></i>
          {{ busy ? (zh ? '处理中…' : 'Working…') : (zh ? '保存' : 'Save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ppe-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1300;
}
.ppe-content {
  background: var(--backgroundColor);
  color: var(--fontColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  width: 980px;
  max-width: 94vw;
  height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.ppe-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--borderColor);
}
.ppe-header h3 { margin: 0; font-size: 14px; font-weight: 500; }
.ppe-header-info { font-size: 12px; opacity: 0.7; flex: 1; }
.ppe-close { background: none; border: none; color: var(--fontColor); cursor: pointer; font-size: 14px; }
.ppe-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--borderColor);
}
.ppe-sep { width: 1px; height: 18px; background: var(--borderColor); margin: 0 2px; }
.ppe-hint { font-size: 12px; opacity: 0.6; margin-left: auto; }
.ppe-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--fontColor);
  background: var(--menuColor, var(--backgroundColor));
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.ppe-btn:hover:not(:disabled) { border-color: #2196F3; color: #2196F3; }
.ppe-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ppe-btn.primary { background: #2196F3; border-color: #2196F3; color: #fff; }
.ppe-btn.primary:hover:not(:disabled) { color: #fff; opacity: 0.9; }
.ppe-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
  gap: 10px;
  align-content: start;
}
.ppe-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 60px 0;
  opacity: 0.6;
  font-size: 13px;
}
.ppe-empty i { font-size: 28px; }
.ppe-card {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  background: var(--menuColor, var(--backgroundColor));
  user-select: none;
}
.ppe-card:hover { border-color: #2196F3; }
.ppe-card.selected { border-color: #2196F3; box-shadow: 0 0 0 1px #2196F3 inset; }
.ppe-card.drag-over { border-color: #FF9800; box-shadow: 0 0 0 1px #FF9800 inset; }
.ppe-thumb {
  position: relative;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(128, 128, 128, 0.08);
  padding: 4px;
  box-sizing: border-box;
}
.ppe-thumb img { max-width: 100%; max-height: 100%; display: block; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); background: #fff; }
.ppe-thumb-ph { font-size: 26px; opacity: 0.25; }
.ppe-order {
  position: absolute;
  left: 4px;
  top: 4px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.ppe-check { position: absolute; right: 4px; top: 4px; color: #2196F3; opacity: 0; font-size: 13px; }
.ppe-card.selected .ppe-check { opacity: 1; }
.ppe-card-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 4px 4px 6px;
  border-top: 1px solid var(--borderColor);
}
.ppe-src { flex: 1; min-width: 0; font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ppe-card-btns { display: flex; gap: 1px; }
.ppe-mini {
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  color: var(--fontColor);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.ppe-mini:hover:not(:disabled) { background: rgba(33, 150, 243, 0.18); color: #2196F3; }
.ppe-mini:disabled { opacity: 0.3; cursor: not-allowed; }
.ppe-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--borderColor);
}
.ppe-footer-hint { flex: 1; font-size: 12px; opacity: 0.7; }
</style>
