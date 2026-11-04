<!-- src/components/plugin/FileViewerHost.vue
     文件查看器宿主：把「当前文件」交给插件注册的 file.viewer 槽位。
     文件内容由宿主读取（只读上下文），插件卸载 / 查看器换人时自动重挂。 -->
<template>
  <div class="fv-host">
    <div v-if="viewers.length > 1" class="fv-bar">
      <span class="fv-bar-label">{{ zh ? '查看器' : 'Viewer' }}</span>
      <button
        v-for="v in viewers"
        :key="v.id"
        class="fv-chip"
        :class="{ on: v.id === selectedId }"
        :title="v.pluginId"
        @click="select(v.id)"
      >
        <i class="fa" :class="v.icon || 'fa-file-o'"></i>
        <span>{{ zh ? v.titleZh : v.titleEn }}</span>
      </button>
    </div>

    <div v-if="remote" class="fv-empty">
      <i class="fa fa-cloud"></i>
      <span>{{ zh ? '插件查看器只支持本地文件；远程文件请使用内置预览' : 'Plugin viewers only support local files; use the built-in preview for remote files' }}</span>
    </div>
    <div v-else-if="!selected" class="fv-empty">
      <i class="fa fa-plug"></i>
      <span>{{ zh ? '没有可用的插件查看器' : 'No plugin viewer available' }}</span>
    </div>
    <div v-else-if="loading" class="fv-empty">
      <i class="fa fa-spinner fa-spin"></i>
      <span>{{ zh ? '正在读取文件…' : 'Reading file…' }}</span>
    </div>
    <div v-else-if="error" class="fv-empty">
      <i class="fa fa-exclamation-triangle"></i>
      <span class="fv-error">{{ error }}</span>
      <button class="fv-retry" @click="load">{{ zh ? '重试' : 'Retry' }}</button>
    </div>
    <div v-else class="fv-body">
      <PluginSlot name="file.viewer" :owner="selected.id" :file-context="fileContext" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import PluginSlot from '@/components/plugin/PluginSlot.vue'
import { resolvePluginFileViewers, type LoadedFileViewer } from '@/lib/plugin/fileViewers'
import { fileExtensionOf, type FileViewerSurface } from '@/shared/fileViewers'

const props = withDefaults(defineProps<{
  path: string
  surface?: FileViewerSurface
  viewerId?: string
  remote?: boolean
}>(), { surface: 'knowledge', viewerId: '', remote: false })
const emit = defineEmits<{ (e: 'update:viewer-id', id: string): void }>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const loading = ref(false)
const error = ref('')
const text = ref<string | null>(null)
const bytes = ref<Uint8Array | null>(null)
const selectedId = ref(String(props.viewerId || ''))
let loadSeq = 0

const viewers = computed<LoadedFileViewer[]>(() => (
  props.remote ? [] : resolvePluginFileViewers(props.path, props.surface)
))
const selected = computed<LoadedFileViewer | null>(() => (
  viewers.value.find((v) => v.id === selectedId.value)
  || viewers.value.find((v) => v.id === String(store.UI.fileViewerDefaults?.[fileExtensionOf(props.path)] || ''))
  || viewers.value[0]
  || null
))

/** 当前文件上下文：传给插件组件；只暴露读取当前文件的窄接口 */
const fileContext = computed<Record<string, unknown>>(() => ({
  path: props.path,
  name: props.path.replace(/\\/g, '/').split('/').pop() || props.path,
  surface: props.surface,
  viewerId: selected.value?.id || '',
  text: text.value,
  bytes: bytes.value,
  readText: async () => {
    const s = await getPlatform().fs.readText(props.path)
    if (s.startsWith('Error reading file')) throw new Error(s)
    return s
  },
  readBytes: async () => {
    const b = await getPlatform().fs.readBinary(props.path)
    if (!b) throw new Error(zh.value ? '读取文件失败' : 'Failed to read file')
    return b
  },
  save: selected.value?.write
    ? async (next: string | Uint8Array) => {
        if (typeof next === 'string') {
          const r = await getPlatform().fs.writeText(props.path, next)
          if (!r.success) throw new Error(r.error || 'save failed')
          text.value = next
          return
        }
        const ok = await getPlatform().fs.writeBase64(props.path, bytesToBase64(next))
        if (!ok) throw new Error('save failed')
        bytes.value = next
      }
    : undefined,
}))

function bytesToBase64(data: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function select(id: string) {
  if (selectedId.value === id) return
  selectedId.value = id
  emit('update:viewer-id', id)
  void load()
}

async function load() {
  const v = selected.value
  const seq = ++loadSeq
  text.value = null
  bytes.value = null
  error.value = ''
  if (!v || !props.path) return
  loading.value = true
  try {
    if (v.loading === 'bytes') {
      const b = await getPlatform().fs.readBinary(props.path)
      if (!b) throw new Error(zh.value ? '读取文件失败' : 'Failed to read file')
      if (seq === loadSeq) bytes.value = b
    } else {
      const s = await getPlatform().fs.readText(props.path)
      if (s.startsWith('Error reading file')) throw new Error(s)
      if (seq === loadSeq) text.value = s
    }
  } catch (e: any) {
    if (seq === loadSeq) error.value = String(e?.message || e)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(() => [props.path, props.surface, props.remote], () => {
  selectedId.value = String(props.viewerId || '')
  void load()
}, { immediate: true })
watch(() => props.viewerId, (id) => {
  if (id && id !== selectedId.value) { selectedId.value = id; void load() }
})
watch(viewers, (list) => {
  if (!list.some((v) => v.id === selectedId.value)) {
    selectedId.value = list[0]?.id || ''
    void load()
  }
})
</script>

<style scoped>
.fv-host { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--backgroundColor); }
.fv-bar { flex-shrink: 0; display: flex; align-items: center; gap: 5px; padding: 5px 8px; border-bottom: 1px solid var(--borderColor); background: var(--menuColor); overflow-x: auto; }
.fv-bar-label { flex-shrink: 0; font-size: 10px; opacity: .55; margin-right: 2px; }
.fv-chip { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; height: 23px; padding: 0 8px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); color: var(--fontColor); font-size: 10px; cursor: pointer; }
.fv-chip.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.fv-body { flex: 1; min-height: 0; overflow: auto; }
.fv-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 20px; text-align: center; font-size: 12px; color: var(--fontColor); opacity: .7; }
.fv-empty i { font-size: 22px; }
.fv-error { max-width: 90%; word-break: break-word; opacity: .9; }
.fv-retry { height: 26px; padding: 0 10px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--menuColor); color: var(--fontColor); font-size: 11px; cursor: pointer; }
</style>
