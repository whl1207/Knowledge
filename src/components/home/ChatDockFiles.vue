<!-- src/components/home/ChatDockFiles.vue
     右侧栏（dock）「文件」标签：复用知识管理的文件树 panel.vue。

     与主资源管理器的区别只有一个：传 scope-root，把树限制在**当前聊天的工作区**内。
     面板自身的右键菜单（新建 / 重命名 / 删除 / 复制粘贴 / 拖拽移动 / 排序）全部保留；
     点击文件仍通过 open-file 事件交给 home.vue，在右侧栏里以文件标签打开。

     额外保留原右侧栏的「插入相对路径」：panel 的 node-opened 会带出最后点击的节点，
     把它插进输入框，方便直接让智能体读取该文件。 -->
<template>
  <div class="dock-files knowfile-menu">
    <Panel
      v-if="rootPath"
      ref="panelRef"
      :scope-root="rootPath"
      @open-file="onOpenFile"
      @node-opened="onNodeOpened"
    >
      <template #toolbar>
        <button
          class="dock-icon-btn"
          :title="zh ? '刷新' : 'Refresh'"
          @click="refresh"
        >
          <i class="fa fa-refresh"></i>
        </button>
        <button
          v-if="lastNodePath"
          class="dock-icon-btn"
          :title="zh ? '把相对路径插入输入框' : 'Insert relative path into the input box'"
          @click="insertPath"
        >
          <i class="fa fa-level-down"></i>
        </button>
      </template>
    </Panel>

    <div v-else class="dock-empty">
      <i class="fa fa-folder-o"></i>
      <span>{{ noWorkspace
        ? (zh ? '这个聊天未使用工作区：右侧栏文件树不指向全局默认目录' : 'This chat uses no workspace — the file tree does not fall back to the global default')
        : (zh ? '这个聊天还没有工作区：用输入框左下角的工作区按钮选择' : 'No workspace for this chat — choose one from the workspace button at the bottom-left of the input box') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { usestore } from '@/store'

// 文件树面板较重（Element Plus 树 + 文件操作），右侧栏首次打开文件标签时再加载
const Panel = defineAsyncComponent(() => import('@/components/knowFile/panel.vue'))

const props = defineProps<{
  active?: boolean
  /** 根目录：当前聊天自己的工作区（空 = 回落全局默认 store.root） */
  rootPath?: string
  /** true = 当前聊天明确「不使用工作区」，此时不回落 store.root */
  noWorkspace?: boolean
}>()
const emit = defineEmits<{
  (e: 'insert-text', text: string): void
  (e: 'open-file', payload: { path: string; view?: string; label?: string }): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const rootPath = computed(() => {
  if (props.noWorkspace) return ''
  return (String(props.rootPath || '').trim() || String(store.root || '')).replace(/[\\/]+$/, '')
})

const panelRef = ref<any>(null)
/** panel 最后点击的节点（文件 / 文件夹），用于「插入相对路径」 */
const lastNodePath = ref('')

function fileNameOf(p: string): string {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p || '')
}

/** 相对工作区根的路径（统一 / 分隔；根外路径原样返回） */
function relativeToRoot(p: string): string {
  const root = rootPath.value.replace(/\\/g, '/')
  const full = String(p || '').replace(/\\/g, '/')
  if (root && (full === root || full.startsWith(root + '/'))) {
    return full.slice(root.length).replace(/^\/+/, '')
  }
  return full
}

function onNodeOpened(data?: any): void {
  if (!data?.path || data?.isTruncatedHint) return
  lastNodePath.value = String(data.path)
}

/** panel.vue 的 open-file 载荷 → 右侧栏标签载荷 */
function onOpenFile(payload?: { data?: any; view?: string }): void {
  const data = payload?.data
  if (!data?.path) return
  const label = String(data.label || fileNameOf(data.path))
  emit('open-file', { path: String(data.path), view: payload?.view, label })
}

function insertPath(): void {
  if (!lastNodePath.value) return
  const rel = relativeToRoot(lastNodePath.value)
  if (!rel) return
  emit('insert-text', '`' + rel + '`')
}

function refresh(): void {
  void panelRef.value?.refreshTree?.()
}

// 工作区切换：清掉上一个工作区留下的「插入路径」目标
watch(rootPath, () => { lastNodePath.value = '' })

// 标签重新激活时刷新一次（与 DSH 文件页「切回来看到最新」一致）
watch(
  () => props.active,
  (v) => {
    if (!v) return
    void nextTick(() => panelRef.value?.refreshTree?.())
  },
)
</script>

<style scoped>
.dock-files {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12px;
  color: var(--fontColor);
}
.dock-files > * {
  flex: 1 1 auto;
  min-height: 0;
}
.dock-icon-btn {
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  padding: 0 3px;
  opacity: 0.75;
}
.dock-icon-btn:hover { opacity: 1; color: var(--fontActiveColor); }
.dock-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 26px 14px;
  text-align: center;
  opacity: 0.6;
  font-size: 12px;
  line-height: 1.5;
}
.dock-empty i { font-size: 18px; }
</style>
