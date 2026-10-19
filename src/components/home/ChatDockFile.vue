<!-- src/components/home/ChatDockFile.vue
     主页右侧栏里的「文件」标签内容：把文件窗口（FileWindow）以**嵌入模式**放进侧栏。

     为什么不另写一套只读预览：子窗口的多视图选择（浏览 / 源码编辑 / 可视编辑 / 思维导图 /
     演示 / Office 编辑）以及各文件类型的专属编辑器都在 FileWindow 里，嵌入复用同一份实现，
     视图列表、默认视图、编辑器行为才不会和独立窗口分叉。

     注意：同一时刻只应挂载一个文件标签（见 ChatDock.vue），因为编辑器视图读取的是
     store.data[store.index]（全局「当前文件」）。切换 / 关闭标签前由宿主调用
     confirmLeave() 处理未保存内容。 -->
<template>
  <FileWindow
    v-if="path"
    ref="fileWindowRef"
    embedded
    :path="path"
    :view="view"
    :remote-root-id="remoteRootId"
    :remote-rel="remoteRel"
    :label="label"
    @update:view="onView"
  />
  <div v-else class="dock-file-empty">
    <i class="fa fa-file-o"></i>
    <span>{{ zh ? '这个标签没有文件路径' : 'This tab has no file path' }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { usestore } from '@/store'

// 懒加载：FileWindow 会带出编辑器 / Excalidraw 等一大票依赖，不能让主页首屏把它一起加载。
// 只有真的打开了文件标签（下面模板 v-if 挂载）才会拉取这个 chunk。
const FileWindow = defineAsyncComponent(() => import('@/components/knowFile/FileWindow.vue'))

const props = defineProps<{
  path: string
  view?: string
  remoteRootId?: string
  remoteRel?: string
  label?: string
}>()
const emit = defineEmits<{ (e: 'update:view', view: string): void }>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const fileWindowRef = ref<any>(null)

function onView(v: string) {
  emit('update:view', v)
}

/** 宿主在切换 / 关闭标签前调用：有未保存内容时让用户选择保存 / 不保存 / 取消 */
async function confirmLeave(): Promise<boolean> {
  const r = await fileWindowRef.value?.confirmLeave?.()
  return r !== false
}

defineExpose({ confirmLeave })
</script>

<style scoped>
.dock-file-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  opacity: 0.6;
  font-size: 12px;
  text-align: center;
  padding: 16px;
}
.dock-file-empty i { font-size: 20px; }
</style>
