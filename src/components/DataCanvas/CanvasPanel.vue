<!-- CanvasPanel.vue - 「数据画布」独立主面板（App.vue 顶层导航）
     数据画布原属 Agent脚手架模块，现独立为顶层面板：
       · 关联任务文件路径存于 store.canvasTaskPath（老存档中画布实例的路径由 store 一次性迁移接管）；
       · 首次进入且尚未关联文件时，自动创建占位 .task（userData/tasks），保证自动保存 / 崩溃恢复有落点；
       · 双击 / 搜索打开画布 .task：store.canvasPathToOpen → 本面板消费并加载（与 .kb → 知识处理的机制对齐）。 -->
<template>
  <div class="canvas-panel">
    <DataCanvasModule
      ref="moduleRef"
      instance-id="canvas"
      :task-file-path="store.canvasTaskPath"
      @file-saved="onFileSaved"
      @file-missing="onFileMissing"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CanvasPanel' })
import { nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import { emptyTaskFileContent } from '@/lib/taskFile'
import DataCanvasModule from '@/components/DataCanvas/DataCanvasModule.vue'

const store = usestore()
const moduleRef = ref<any>(null)
const zh = () => store.locales !== 'en'

/** 打开（双击/搜索/文件对话框）画布 .task：消费 store.canvasPathToOpen，切换关联文件并加载 */
let consuming = false
const consumeOpenRequest = async () => {
  const path = store.canvasPathToOpen
  if (!path || consuming) return
  store.canvasPathToOpen = null // 先消费标记，避免重复加载（KeepAlive 下 mount / activate 均会触发）
  consuming = true
  try {
    store.canvasTaskPath = path
    store.saveConfig()
    await nextTick()
    const ok = await moduleRef.value?.loadFromFile?.(path)
    if (ok === true) ElMessage.success(zh() ? `已加载画布：${path}` : `Canvas loaded: ${path}`)
  } finally {
    consuming = false
  }
}

/** 首次进入且没有关联文件：自动建一个占位 .task（与旧画布实例「新建即建文件」行为对齐） */
const ensureTaskFile = async () => {
  if (store.canvasTaskPath || store.canvasPathToOpen || !window.ipcRenderer) return
  try {
    const res = await window.ipcRenderer.invoke('createTaskFile', {
      baseName: zh() ? '数据画布' : 'Data Canvas',
      content: emptyTaskFileContent('canvas'),
    })
    if (res?.success && res.path) {
      store.canvasTaskPath = res.path
      store.saveConfig()
    }
  } catch { /* 创建失败不阻塞：画布仍可正常使用，保存时会弹「另存为」兜底 */ }
}

watch(() => store.canvasPathToOpen, () => { void consumeOpenRequest() })
onMounted(async () => {
  if (!store.canvasPathToOpen) await ensureTaskFile()
  void consumeOpenRequest()
})
onActivated(() => { void consumeOpenRequest() })

/** 保存成功：接管（新）路径——含「未关联文件时另存为」兜底流程选定的文件 */
const onFileSaved = (path: string) => {
  if (path && store.canvasTaskPath !== path) {
    store.canvasTaskPath = path
    store.saveConfig()
  }
}

const onFileMissing = () => {
  ElMessage.warning(zh()
    ? '画布任务文件不可用（可能已被移动或删除）；下次保存会重新询问保存位置'
    : 'Canvas task file is unavailable (moved or deleted); you will be asked for a new location on next save')
}
</script>

<style scoped>
.canvas-panel { height: 100%; }
</style>
