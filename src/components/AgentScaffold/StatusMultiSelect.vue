<!-- StatusMultiSelect.vue - 状态多选筛选（按钮 + 弹出勾选面板）

     用途：AgentBatch 的「状态筛选」（表格页工具栏 / 任务页「显示行」区）共用。
     行为：可同时勾选多种状态；**不勾选 = 全部**（不做状态筛选）。
     说明：下拉面板用 Teleport + position:fixed 挂到 body，避免被 .task-col-body 等滚动容器裁剪
     （同 panel.vue 右键菜单的做法）；选项文案与帮助说明由父组件传入，语言取 store.locales。 -->
<template>
  <div class="status-multi" :class="{ disabled, active: open || modelValue.length > 0 }">
    <div class="status-multi-btn" ref="btnRef" :title="buttonTitle" @click="toggleOpen">
      <i class="fa fa-filter" style="font-size:10px;"></i>
      <span class="status-multi-label">{{ summary }}</span>
      <i class="fa fa-caret-down" style="font-size:9px;opacity:.7;"></i>
    </div>
    <Teleport to="body">
      <div v-if="open" class="status-multi-mask" @click="open = false"></div>
      <div v-if="open" class="status-multi-pop" :style="popStyle" @click.stop>
        <label v-for="opt in options" :key="opt.value" class="status-multi-item" :title="opt.label" @click.prevent="toggle(opt.value)">
          <input type="checkbox" :checked="isChecked(opt.value)" style="width:14px;height:14px;flex:none;margin:0px;pointer-events:none;" />
          <span>{{ opt.label }}</span>
        </label>
        <div class="status-multi-actions">
          <span class="status-multi-act" @click="selectAll">{{ zh ? '全选' : 'All' }}</span>
          <span class="status-multi-act" @click="clearAll">{{ zh ? '清空' : 'Clear' }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: { value: string; label: string }[]
  disabled?: boolean
  /** 悬停帮助说明（父组件给出完整用法） */
  hint?: string
}>(), { disabled: false, hint: '' })

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const store = usestore()
const zh = computed(() => store.locales !== 'en')

const open = ref(false)
const btnRef = ref<HTMLElement | null>(null)
const popStyle = ref<Record<string, string>>({})

const isChecked = (value: string) => props.modelValue.includes(value)

/** 触发按钮上的摘要文案：未选=全部 / 单选=该项名称 / 多选=n 项 */
const summary = computed(() => {
  const n = props.modelValue.length
  if (n === 0) return zh.value ? '全部状态' : 'All status'
  if (n === 1) return props.options.find(o => o.value === props.modelValue[0])?.label || props.modelValue[0]
  return zh.value ? `已选 ${n} 项` : `${n} selected`
})

/** 按钮 title：帮助说明 + （已选时）当前已选状态清单”；标签上的 title 会遮住按钮的，故不单独设 */
const buttonTitle = computed(() => {
  const names = props.options.filter(o => isChecked(o.value)).map(o => o.label)
  if (!names.length) return props.hint
  return `${props.hint}${props.hint ? '\n' : ''}${zh.value ? '当前已选' : 'Selected'}: ${names.join(zh.value ? '、' : ', ')}`
})

const toggleOpen = () => {
  if (props.disabled) return
  if (open.value) { open.value = false; return }
  const rect = btnRef.value?.getBoundingClientRect()
  if (rect) {
    popStyle.value = {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.bottom + 4)}px`,
      minWidth: `${Math.max(Math.round(rect.width), 130)}px`,
      maxWidth: '240px',
    }
  }
  open.value = true
}

const toggle = (value: string) => {
  const next = props.modelValue.includes(value)
    ? props.modelValue.filter(v => v !== value)
    : [...props.modelValue, value]
  emit('update:modelValue', next)
}
const selectAll = () => emit('update:modelValue', props.options.map(o => o.value))
const clearAll = () => emit('update:modelValue', [])

// 关闭面板时清空按钮引用（Teleport 内的节点由本组件渲染，无需额外清理）
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') open.value = false }
document.addEventListener('keydown', onKey)
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<style scoped>
.status-multi {
  position: relative;
  display: inline-flex;
  flex: none;
  width: 130px;
  min-width: 0;
}
.status-multi-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 26px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.status-multi-btn:hover { background: var(--menuColor); }
.status-multi.active .status-multi-btn { border-color: #2196F3; color: #2196F3; }
.status-multi.disabled .status-multi-btn { opacity: .5; cursor: not-allowed; }
.status-multi-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 面板（Teleport 到 body，position:fixed 定位） */
.status-multi-mask { position: fixed; inset: 0; z-index: 998; }
.status-multi-pop {
  position: fixed;
  z-index: 999;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  box-shadow: 0 4px 16px rgba(0, 0, 0, .3);
  font-size: 11px;
  color: var(--fontColor);
}
.status-multi-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.status-multi-item:hover { background: var(--menuActiveColor); }
.status-multi-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 2px;
  padding: 3px 6px 1px;
  border-top: 1px solid var(--borderColor);
}
.status-multi-act { cursor: pointer; opacity: .8; }
.status-multi-act:hover { opacity: 1; color: var(--fontActiveColor); }
</style>
