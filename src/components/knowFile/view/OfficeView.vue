<!--
  OfficeView.vue — 内嵌 Office 编辑器（GenOffice 内核）的**单一宿主组件**

  设计要点（对应 docs/plan/Word 展示与编辑-落地方案（借鉴 GenOffice）.md 附录 E）：
  - 四种类型（Word / Excel / PPT / PDF）共用这一个组件：编辑器本身是原生 WebContentsView，
    Vue 侧只负责「占位 + 上报矩形 + 生命周期」，类型差异全在主进程的类型描述表里；
  - 占位 div 必须铺满容器：编辑器视图会盖在它之上，所以占位区内不放任何 UI；
  - 卸载（切换视图 / 关窗）时先保存再关闭；若用户在保存确认框里点了取消，通知父组件切回本视图。
-->
<template>
  <div class="office-view">
    <!-- 不可用/出错时才显示提示（可用时占位区被原生视图覆盖，放这里也看不到） -->
    <div v-if="!type" class="office-hint">
      <p>{{ zh ? '该文件类型没有对应的 Office 编辑器' : 'No Office editor for this file type' }}</p>
    </div>
    <div v-else-if="!props.available" class="office-hint">
      <p>{{ zh ? `${label} 编辑器尚未构建` : `${label} editor is not built yet` }}</p>
      <p class="office-hint-cmd">{{ zh ? '在项目根目录执行：' : 'Run in project root: ' }}npm run office:build</p>
    </div>
    <div v-else-if="error" class="office-hint office-hint-error">
      <p>{{ error }}</p>
      <p class="office-hint-cmd" @click="retry">{{ zh ? '点击重试' : 'Click to retry' }}</p>
    </div>
    <div v-else-if="loading" class="office-hint">
      <p>{{ zh ? '正在加载编辑器…' : 'Loading editor…' }}</p>
    </div>
    <div ref="hostRef" class="office-host" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { usestore } from '@/store'
import { buildOfficeAiConfig, officeEnvPayload } from '@/lib/knowFile/officeAi'
import {
  officeTypeForPath,
  officeRectOf,
  officeOpen,
  officeClose,
  officeSetBounds,
  officeSetVisible,
  officeRefresh,
  onOfficeEvent,
  isOfficeRuntime,
  type OfficeEditorType,
} from '@/lib/knowFile/office'

const props = defineProps<{
  /** 文件绝对路径 */
  path: string
  /** 该类型的编辑器是否已构建（由父组件探测后传入） */
  available: boolean
}>()

const emit = defineEmits<{
  (e: 'saved', filePath: string): void
  /** 用户在保存确认框里取消了关闭 → 父组件应切回本视图 */
  (e: 'cancel-close'): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const LABELS: Record<OfficeEditorType, string> = {
  docs: 'Word',
  sheets: 'Excel',
  slides: 'PPT',
}

const hostRef = ref<HTMLElement | null>(null)
const viewId = ref('')
const error = ref('')
const loading = ref(true)

const type = computed(() => officeTypeForPath(props.path))
const label = computed(() => (type.value ? LABELS[type.value] : ''))

let observer: ResizeObserver | null = null
let offEvent: (() => void) | null = null
let boundsRaf = 0

/** 上报占位矩形（合并到下一帧，避免拖拽窗口时高频 IPC） */
function pushBounds() {
  if (boundsRaf) return
  boundsRaf = requestAnimationFrame(() => {
    boundsRaf = 0
    if (!viewId.value) return
    officeSetBounds(viewId.value, officeRectOf(hostRef.value))
  })
}

async function open() {
  if (!isOfficeRuntime() || !type.value || viewId.value || !props.available) {
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  await nextTick()
  const res = await officeOpen(props.path, officeRectOf(hostRef.value))
  if (res.ok && res.viewId) {
    viewId.value = res.viewId
  } else {
    error.value = res.error || (zh.value ? '编辑器启动失败' : 'Failed to start editor')
  }
  loading.value = false
}

/** 卸载前保存并关闭；返回 false 表示用户取消了关闭 */
async function close(notifyCancel = true): Promise<boolean> {
  if (!viewId.value) return true
  const id = viewId.value
  const res = await officeClose(id)
  if (res.ok) {
    viewId.value = ''
    return true
  }
  // 用户点了「取消」：视图仍在主进程里；恢复显示并让父组件切回来
  await officeRefresh(id)
  if (notifyCancel) emit('cancel-close')
  return false
}

function retry() {
  error.value = ''
  void open()
}

/**
 * 供父组件在「会覆盖到编辑器区域的浮层」展开/收起时调用。
 * 原生 WebContentsView 永远绘制在 DOM 之上，不隐藏就会挡住文件窗口的视图切换下拉。
 */
function setVisible(next: boolean) {
  if (!viewId.value) return
  if (next) void officeRefresh(viewId.value)
  else void officeSetVisible(viewId.value, false)
}

defineExpose({ setVisible })

// ---- 向主进程推送 AI-KM 的能力（模型配置 / 主题 / 语言）----
// 编辑器把模型当宿主能力：必须在它加载渲染层之前推好，否则它的模型选择器一开始是空的。
function pushEnv() {
  const api = (window as any).ipcRenderer
  if (!api) return
  Promise.resolve(api.invoke('office:set-env', officeEnvPayload())).catch(() => {})
}

async function pushAiConfig() {
  const api = (window as any).ipcRenderer
  if (!api) return
  try {
    const cfg = await buildOfficeAiConfig()
    await api.invoke('office:set-ai-config', cfg)
  } catch (e) {
    console.warn('[office] 推送模型配置失败:', e)
  }
}

// 模型或主题/语言变化时同步（编辑器无需重启即可切换模型）
watch(
  () => JSON.stringify((store as any).AIconfig?.llm ?? null),
  () => {
    void pushAiConfig()
  },
)
watch(() => [store.UI?.theme, store.locales], pushEnv)

onMounted(async () => {
  if (!isOfficeRuntime()) {
    loading.value = false
    return
  }
  offEvent = onOfficeEvent((e) => {
    if (e.viewId !== viewId.value) return
    if (e.event === 'saved') emit('saved', e.filePath || props.path)
    // PPT 放映结束：主进程把视图从「铺满整窗」放回占位区，用的还是上一次上报的矩形。
    // 立刻按当前布局重报一次，避免拿放映前的旧矩形去摆（窗口尺寸可能已经变了）。
    if (e.event === 'show-ended') {
      void officeRefresh(viewId.value)
      pushBounds()
    }
    if (e.event === 'crashed') {
      viewId.value = ''
      error.value = zh.value ? '编辑器进程异常退出' : 'Editor process crashed'
    }
  })

  if (typeof ResizeObserver !== 'undefined' && hostRef.value) {
    observer = new ResizeObserver(() => pushBounds())
    observer.observe(hostRef.value)
  }
  window.addEventListener('resize', pushBounds)

  // 先把宿主能力推给主进程，再创建编辑器视图（它的首次 ai:get-settings 就能拿到模型）
  pushEnv()
  await pushAiConfig()
  await open()
})

onBeforeUnmount(async () => {
  window.removeEventListener('resize', pushBounds)
  if (boundsRaf) cancelAnimationFrame(boundsRaf)
  observer?.disconnect()
  observer = null
  offEvent?.()
  offEvent = null
  await close()
})

// 同一组件实例被复用到另一个文件时（多标签/换文件）：先关旧的再开新的
watch(
  () => props.path,
  async (next, prev) => {
    if (!next || next === prev) return
    await close(false)
    await open()
  },
)
</script>

<style scoped>
.office-view {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--backgroundColor);
}

/* 占位区：编辑器 WebContentsView 会精确覆盖这一块 */
.office-host {
  width: 100%;
  height: 100%;
}

.office-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--textColor, #666);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}

.office-hint-error {
  color: #d9534f;
  /* 主进程给的是多行说明（缺失的路径 + 可执行的下一步），按原样换行 */
  white-space: pre-line;
}

.office-hint-cmd {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  opacity: 0.75;
  cursor: pointer;
  user-select: text;
}
</style>
