<!--
  PluginBoundary.vue — 扩展错误边界

  单个扩展崩溃（渲染抛错 / 组件解析失败）**不得影响主界面**：这里捕获子树错误，
  就地显示原因 + 重试按钮；重试通过作用域插槽把 `attempt` 传给子组件做 key，从而重建子树。
  对齐 DSH 的姿态：稳态下坏包只告警、不殃及他人。

  注意：正常渲染时本组件**不产生额外 DOM**（直接透传默认插槽），
  因此不会改变被包裹面板的原有布局。
-->
<template>
  <div v-if="error" class="plugin-boundary-error">
    <i class="fa fa-exclamation-triangle"></i>
    <div class="pb-body">
      <div class="pb-title">{{ zh ? '扩展出错了' : 'Extension failed' }}<span v-if="label"> · {{ label }}</span></div>
      <div class="pb-detail">{{ error }}</div>
    </div>
    <div class="pb-retry" @click="retry">{{ zh ? '重试' : 'Retry' }}</div>
  </div>
  <slot v-else :attempt="attempt" />
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue'
import { usestore } from '@/store'

const props = defineProps<{ label?: string }>()
const store = usestore()
const zh = computed(() => store.locales === 'zh')

const error = ref('')
/** 每次重试自增 → 调用方把它作为子组件 key，强制重建 */
const attempt = ref(0)

onErrorCaptured((err: unknown) => {
  error.value = err instanceof Error ? (err.stack || err.message) : String(err)
  console.error(`[PluginBoundary] 扩展渲染异常${props.label ? ` (${props.label})` : ''}:`, err)
  // 已处理：阻止继续向上冒泡（否则整个应用会白屏）
  return false
})

const retry = () => {
  error.value = ''
  attempt.value++
}
</script>

<style scoped>
.plugin-boundary-error {
  height: calc(100% - 28px);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  font-size: 13px;
  color: var(--fontColor, #333);
}
.plugin-boundary-error > i {
  color: #dc2626;
  font-size: 16px;
  margin-top: 2px;
}
.pb-body {
  flex: 1;
  min-width: 0;
}
.pb-title {
  font-weight: 600;
}
.pb-detail {
  margin-top: 4px;
  opacity: 0.7;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
}
.pb-retry {
  cursor: pointer;
  border: 1px solid var(--borderColor, #ddd);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.pb-retry:hover {
  background: var(--hoverColor, rgba(0, 0, 0, 0.05));
}
</style>
