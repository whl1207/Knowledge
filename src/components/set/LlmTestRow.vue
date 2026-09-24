<!-- LlmTestRow.vue - 模型来源「测试 API 状态」行（各来源配置块底部复用）
     点击后调用 store.testLlmSource(key)：探测该来源连通性、回填可用模型、更新左侧来源列表状态圆点；
     并发 refreshed 事件，让父组件顺带刷新该来源的模型清单 / 加载状态 / 上下文窗口（来源配置块内唯一的刷新入口）。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'

const props = defineProps<{ sourceKey: string }>()
const emit = defineEmits<{ (e: 'refreshed', key: string): void }>()

const store = usestore()
const zh = () => store.locales === 'zh'

type TestState = 'idle' | 'testing' | 'ok' | 'fail'
const state = ref<TestState>('idle')
const message = ref('')

/** 测试该来源的 API 状态（连通性）：成功顺带回填可用模型，并更新左侧列表状态圆点 */
const runTest = async () => {
  if (state.value === 'testing') return
  state.value = 'testing'
  message.value = zh() ? '测试中...' : 'Testing...'
  try {
    const r: any = await store.testLlmSource(props.sourceKey)
    const models: string[] = Array.isArray(r?.models) ? r.models : []
    if (r?.ok) {
      state.value = 'ok'
      message.value = models.length
        ? (zh() ? `连接成功，发现 ${models.length} 个模型` : `Connected, ${models.length} models`)
        : (zh() ? '连接成功' : 'Connected')
      ElMessage.success(message.value)
    } else {
      state.value = 'fail'
      const status = Number(r?.status || 0)
      message.value = status === 401
        ? (zh() ? '连接失败：可能凭据（API Key）错误' : 'Failed: possible credential (API key) error')
        : (zh() ? '连接失败，请检查地址、端口与密钥' : 'Failed; check URL, port and key')
      ElMessage.warning(message.value)
    }
  } catch (e: any) {
    state.value = 'fail'
    message.value = (zh() ? '连接失败：' : 'Failed: ') + (e?.message || String(e))
    ElMessage.warning(message.value)
  } finally {
    // 无论成败都通知父级刷新模型清单 / 上下文窗口：该按钮是来源配置块内唯一的刷新入口
    emit('refreshed', props.sourceKey)
  }
}
</script>

<template>
  <div class="form-group">
    <label>{{ zh() ? 'API 状态' : 'API Status' }}</label>
    <div class="input-with-button">
      <div class="button test-source-btn" :class="'status-' + state"
        @click="runTest"
        :title="message ? (zh() ? '点击重新测试连通性并刷新模型列表 / 上下文窗口' : 'Test connectivity again and refresh the model list / context window') : (zh() ? '测试连通性，并刷新模型列表与上下文窗口' : 'Test connectivity and refresh the model list and context window')">
        <i class="fa" :class="state === 'testing' ? 'fa-spinner fa-spin' : (message ? 'fa-refresh' : 'fa-plug')"></i>
        <span class="test-source-btn-text">{{ state === 'testing' ? (zh() ? '测试中...' : 'Testing...') : (message || (zh() ? '测试连接' : 'Test')) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 LlmSettings 配置块内其它 form-group 行保持同一行布局（label + 控件同行） */
.form-group { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; white-space: nowrap; margin: 0; }
.form-group > label { flex-shrink: 0; min-width: 95px; text-align: right; font-size: 12px; line-height: 1; }
.form-group > label::after { content: '：'; }
.input-with-button { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; margin: 0; }
.test-source-btn {
  flex-shrink: 0; width: auto; height: 27px; padding: 0 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  font-size: 12px; white-space: nowrap; cursor: pointer; margin: 0px; flex:1;
  min-width: 0; overflow: hidden;
}
.test-source-btn-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.test-source-btn.status-testing { color: var(--fontActiveColor); }
.test-source-btn.status-ok { color: #4CAF50; }
.test-source-btn.status-fail { color: #f44336; }
</style>
