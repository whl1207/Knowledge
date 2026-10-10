<!-- src/workflow/ui/AiPanel.vue -->
<!--
  AI 编排面板：用自然语言让大模型生成 / 修改整份工作流。
  模型输出必须是完整的 Dify DSL（YAML）；面板负责解析 + 校验，通过后交给画布应用（可撤销）。
-->
<template>
  <aside class="wf-panel wf-ai">
    <header class="wf-panel__head">
      <span class="wf-panel__title"><i class="fa fa-magic"></i> {{ t('ai.title') }}</span>
      <span class="wf-ai__status" :class="{ 'is-running': running }">{{ running ? t('ai.thinking') : t('ai.subtitle') }}</span>
      <button class="wf-icon-btn" :title="t('flow.close')" @click="$emit('close')"><i class="fa fa-times"></i></button>
    </header>

    <div class="wf-panel__body scoll">
      <div class="wf-field">
        <div class="wf-field__head">
          <span class="wf-field__label">{{ t('ai.model') }}</span>
        </div>
        <el-select :model-value="provider" size="small" style="width:100%" :disabled="running" @update:model-value="onProviderChange">
          <el-option :label="t('ai.modelGlobal')" value="" />
          <el-option v-for="opt in providerOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select
          v-if="provider"
          :model-value="modelName"
          size="small"
          filterable
          allow-create
          default-first-option
          style="width:100%;margin-top:6px"
          :placeholder="t('ai.modelName')"
          :disabled="running"
          @update:model-value="modelName = $event"
        >
          <el-option v-for="name in modelNames" :key="name" :label="name" :value="name" />
        </el-select>
      </div>

      <div v-if="selectedTitle" class="wf-ai__scope">
        <i class="fa fa-crosshairs"></i> {{ t('ai.scopeHint').replace('{name}', selectedTitle) }}
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('ai.request') }}</div>
        <el-input
          v-model="request"
          type="textarea"
          :rows="4"
          size="small"
          :disabled="running"
          :placeholder="t('ai.requestPlaceholder')"
        />
      </div>

      <div class="wf-ai__chips">
        <button v-for="(item, index) in examples" :key="index" class="wf-chip" :disabled="running" @click="request = item">
          {{ item }}
        </button>
      </div>

      <div class="wf-panel__actions">
        <button class="wf-btn wf-btn--primary" :disabled="running || readonly || !request.trim()" @click="ask">
          <i class="fa" :class="running ? 'fa-circle-o-notch fa-spin' : 'fa-magic'"></i>
          {{ running ? t('ai.thinking') : t('ai.generate') }}
        </button>
        <button class="wf-btn" :disabled="running || !canUndo" :title="t('ai.undoHint')" @click="$emit('undo')">
          <i class="fa fa-undo"></i> {{ t('ai.undo') }}
        </button>
      </div>

      <div v-if="error" class="wf-panel__error"><i class="fa fa-exclamation-triangle"></i> {{ error }}</div>

      <template v-if="history.length">
        <div class="wf-section-title"><i class="fa fa-history"></i> {{ t('ai.history') }}</div>
        <div v-for="(item, index) in history" :key="index" class="wf-card wf-ai__item" :class="item.ok ? 'is-ok' : 'is-error'">
          <div class="wf-ai__item-head">
            <i class="fa" :class="item.ok ? 'fa-check-circle' : 'fa-times-circle'"></i>
            <span class="wf-ai__item-request" :title="item.request">{{ item.request }}</span>
          </div>
          <div class="wf-ai__item-note">{{ item.note }}</div>
          <div v-if="item.raw" class="wf-ai__item-raw scoll">{{ item.raw }}</div>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from './locales'
import { parseDslYaml, serializeDslYaml } from '@/workflow/dsl/codec'
import { validateAndNormalizeDsl } from '@/workflow/dsl/validator'
import { DIFY_BUILTIN_NODE_TYPES, PRIVATE_NODE_TYPES, type DslDocument } from '@/workflow/dsl/types'
import { applyNodeModel } from '@/workflow/engine/modelBridge'
import { getAvailableModels, getModelOptions } from '@/workflow/engine/modelOptions'

const props = defineProps<{
  document: DslDocument | null
  selectedTitle?: string
  readonly?: boolean
  canUndo?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply', document: DslDocument): void
  (e: 'undo'): void
  (e: 'close'): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const request = ref('')
const running = ref(false)
const error = ref('')
const provider = ref('')
const modelName = ref('')

interface AiHistoryItem {
  request: string
  note: string
  ok: boolean
  raw?: string
}
const history = ref<AiHistoryItem[]>([])

const providerOptions = computed(() => getModelOptions(store, t))
const modelNames = computed(() => (provider.value ? getAvailableModels(store, provider.value) : []))

const isZh = computed(() => (store.locales || 'zh') === 'zh')
const examples = computed(() =>
  isZh.value
    ? ['把流程改成：先分类再分别回答', '加一个条件分支：分数 ≥ 60 走及格，否则不及格', '把大模型节点的提示词改得更严谨']
    : ['Restructure it: classify first, then answer per class', 'Add an if-else: score ≥ 60 passes, otherwise fails', 'Make the LLM prompt stricter'],
)

function onProviderChange(value: string): void {
  provider.value = value
  modelName.value = getAvailableModels(store, value)[0] ?? ''
}

/** 可用节点类型清单（提示模型别乱造类型） */
const nodeTypeHint = computed(() => [...DIFY_BUILTIN_NODE_TYPES, ...PRIVATE_NODE_TYPES].join(', '))

function buildPrompt(currentYaml: string, userRequest: string): string {
  const zh = isZh.value
  const scope = props.selectedTitle
    ? (zh ? `\n当前选中的节点是「${props.selectedTitle}」，如果用户的描述像是在说它，请优先改这个节点。` : '')
    : ''
  if (!zh) {
    return [
      'You are a Dify workflow authoring assistant. The user describes a change in plain language.',
      'Output ONLY the complete Dify app DSL as YAML (no explanation, no extra prose outside the YAML).',
      'Rules:',
      '1. Keep the top-level structure: version / kind: app / app / workflow.graph (nodes, edges).',
      '2. Keep existing node ids unless the node must be removed; leave unrelated parts untouched (keep unknown node types and their fields as-is).',
      `3. Only use these node types: ${nodeTypeHint.value}.`,
      '4. Every edge needs sourceHandle / targetHandle; branch nodes use their case_id / class id as sourceHandle, ELSE is "false".',
      '5. Node data keeps type / title / desc / version plus the fields that type needs (follow the existing YAML style).',
      scope,
      '',
      'Current workflow YAML:',
      '```yaml',
      currentYaml,
      '```',
      '',
      `User request: ${userRequest}`,
    ].join('\n')
  }
  return [
    '你是「AI-KM 工作流编排助手」。用户用自然语言描述需求，你要**只输出完整的 Dify 应用 DSL（YAML）**，不要解释、不要在 YAML 之外写任何内容。',
    '要求：',
    '1. 顶层保持 version / kind: app / app / workflow.graph（含 nodes、edges）。',
    '2. 现有节点 id 尽量不变（除确实要删掉的）；与需求无关的部分不要改动（未识别的节点类型与字段原样保留）。',
    `3. 节点类型只能用这些：${nodeTypeHint.value}。`,
    '4. 每条边都要有 sourceHandle / targetHandle；分支节点用 case_id / class id 作为 sourceHandle，ELSE 用 "false"。',
    '5. 节点 data 保留 type / title / desc / version，以及该类型需要的字段（写法照抄现有 YAML）。',
    scope,
    '',
    '当前工作流 YAML：',
    '```yaml',
    currentYaml,
    '```',
    '',
    `用户需求：${userRequest}`,
  ].join('\n')
}

/** 从模型输出里取出 YAML（去掉代码块围栏与前后废话） */
function extractYaml(text: string): string {
  let body = String(text || '').trim()
  const fence = body.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  const start = body.search(/^(version|app|kind|workflow):/m)
  if (start > 0) body = body.slice(start)
  return body.trim()
}

async function ask(): Promise<void> {
  const current = props.document
  if (!current || running.value) return
  const userRequest = request.value.trim()
  if (!userRequest) return

  running.value = true
  error.value = ''
  const restore = provider.value ? applyNodeModel(store, { provider: provider.value, name: modelName.value }) : () => {}
  try {
    const currentYaml = serializeDslYaml(current)
    const prompt = buildPrompt(currentYaml, userRequest)
    const raw = await store.sendToAI([{ role: 'user', content: prompt }])
    const yaml = extractYaml(String(raw ?? ''))
    if (!yaml) throw new Error(t('ai.errorEmpty'))

    const parsed = validateAndNormalizeDsl(parseDslYaml(yaml))
    if (!parsed.ok || !parsed.document) {
      const message = parsed.issues.find((i) => i.level === 'error')?.message || t('ai.errorInvalid')
      history.value = [{ request: userRequest, note: message, ok: false, raw: yaml.slice(0, 2000) }, ...history.value].slice(0, 8)
      error.value = message
      return
    }

    const before = current.workflow.graph.nodes.length
    const after = parsed.document.workflow.graph.nodes.length
    const beforeEdges = current.workflow.graph.edges.length
    const afterEdges = parsed.document.workflow.graph.edges.length
    const note = t('ai.note')
      .replace('{nodes}', `${before} → ${after}`)
      .replace('{edges}', `${beforeEdges} → ${afterEdges}`)
      .replace('{warn}', String(parsed.issues.filter((i) => i.level === 'warning').length))
    history.value = [{ request: userRequest, note, ok: true }, ...history.value].slice(0, 8)
    emit('apply', parsed.document)
    request.value = ''
  } catch (e) {
    const message = (e as Error)?.message || String(e)
    error.value = message
    history.value = [{ request: userRequest, note: message, ok: false }, ...history.value].slice(0, 8)
  } finally {
    restore()
    running.value = false
  }
}
</script>

<style scoped>
/* 面板外壳（.wf-panel）与按钮样式见全局 panel.css，这里只写 AI 编排专属样式 */
.wf-ai__status {
  color: var(--wf-text-dim);
  font-size: 11px;
}

.wf-ai__status.is-running {
  color: var(--wf-running);
}

.wf-ai__scope {
  margin-bottom: 10px;
  padding: 4px 8px;
  border: 1px dashed var(--wf-border);
  border-radius: 6px;
  color: var(--wf-text-soft);
  font-size: 11px;
}

.wf-ai__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.wf-chip {
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid var(--wf-border);
  border-radius: 10px;
  background: transparent;
  color: var(--wf-text-soft);
  font-size: 11px;
  cursor: pointer;
}

.wf-chip:hover:not(:disabled) {
  border-color: var(--wf-accent);
  color: var(--wf-accent-text);
}

.wf-ai__item {
  font-size: 11px;
}

.wf-ai__item.is-error {
  border-color: var(--wf-danger);
}

.wf-ai__item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wf-success);
}

.wf-ai__item.is-error .wf-ai__item-head {
  color: var(--wf-danger);
}

.wf-ai__item-request {
  flex: 1;
  overflow: hidden;
  color: var(--wf-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-ai__item-note {
  margin-top: 2px;
  color: var(--wf-text-dim);
}

.wf-ai__item-raw {
  max-height: 120px;
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--wf-code-bg);
  color: var(--wf-code-text);
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
