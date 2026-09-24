<!-- 联网搜索源设置（「工具 → 搜索」）：多源启用 + 策略，布局与「模型」页一致（左列表 / 右配置）。
     - 左列表：内置搜索源 + 自定义（内网）源，每项一张卡片（图标 / 名称 / 状态 / 启用开关），可同时启用多个。
     - 工具栏：多源策略下拉 + ↺ 重置为默认（含清空 Key 与自定义源）+ ＋ 添加自定义（内网）源。
     - 右配置：选中源的参数（API Key / 实例地址 / 请求头 / 字段映射等）+ 该源「测试」按钮与结果。
     - 自定义源（SearXNG 兼容实例 / 通用 HTTP JSON 接口）用 `cs:<id>` 编码参与同一套排序 / 启用 / 测试流程。
     - 多源策略：依次回退（按列表顺序逐个尝试，第一个有结果即用）/ 并行聚合（全部执行后按 URL 合并去重）。
     - 配置保存在 store.webSearch（localStorage `webSearchConfig`），每次变更自动下发主进程（webSearch:set-config）。 -->
<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  WEB_SEARCH_PROVIDER_IDS,
  webSearchProviderMeta,
  webSearchProviderIcon,
  findWebSearchCustomSource,
  toCustomProviderId,
  type WebSearchCustomSource,
  type WebSearchTestResult,
} from '@/shared/webSearch'

interface Props {
  store: any
}
const props = defineProps<Props>()
const store = props.store
const t = (zh: string, en: string): string => (store.locales === 'zh' ? zh : en)

// 防御：旧存档/异常时补齐结构（normalize 由 store 负责，这里只防 undefined）
if (!store.webSearch) store.updateWebSearchConfig({})

/** 是否有主进程（桌面版）可用：浏览器/LAN 模式下搜索源配置不下发也不可测试 */
const hasMain = computed(() => !!((window as any).dsh?.webSearch?.setConfig))

/** 已启用的源（有序） */
const enabledIds = computed<string[]>(() => Array.isArray(store.webSearch?.providers) ? store.webSearch.providers : [])
const isEnabled = (id: string) => enabledIds.value.includes(id)
/** 自定义（内网）搜索源列表（配置里定义，顺序由 order 决定） */
const customSources = computed<WebSearchCustomSource[]>(() =>
  Array.isArray(store.webSearch?.customs) ? store.webSearch.customs : [])
/** 当前选中的自定义源（选中内置源时为 undefined） */
const currentCustom = computed<WebSearchCustomSource | undefined>(() =>
  findWebSearchCustomSource(store.webSearch, selected.value))
/**
 * 列表项：内置源 + 自定义源，顺序 = 配置的 `order`（拖动排序结果）。
 * 自定义源用 `cs:<id>` 编码参与同一套排序 / 启用 / 测试流程。
 */
const listItems = computed(() => {
  const order: string[] = Array.isArray(store.webSearch?.order) ? store.webSearch.order : []
  const all: string[] = [
    ...WEB_SEARCH_PROVIDER_IDS,
    ...customSources.value.map((s) => toCustomProviderId(s.id)),
  ]
  const ids = [...order.filter((id) => all.includes(id)), ...all.filter((id) => !order.includes(id))]
  return ids.map((id) => ({ id, meta: webSearchProviderMeta(id, store.webSearch) }))
})

/** 当前选中源（默认第一个启用源；选中项被停用时保持选中以便继续配置） */
const selected = ref<string>(enabledIds.value[0] || WEB_SEARCH_PROVIDER_IDS[0])
const currentMeta = computed(() => webSearchProviderMeta(selected.value, store.webSearch))

const providerLabel = (id: string) => {
  const meta = webSearchProviderMeta(id, store.webSearch)
  return store.locales === 'zh' ? meta.label : meta.labelEn
}
const providerDesc = (id: string) => {
  const meta = webSearchProviderMeta(id, store.webSearch)
  return store.locales === 'zh' ? meta.zh : meta.en
}
/** 自定义源类型短标签（列表第二行用） */
const customKindLabel = (s: WebSearchCustomSource) =>
  s.kind === 'searxng' ? t('SearXNG 兼容', 'SearXNG') : t('JSON 接口', 'JSON API')
/** 列表第二行短描述：配置状态（Key 已填 / 未填 / 免 Key / 自建地址） */
const providerSub = (id: string) => {
  const meta = webSearchProviderMeta(id, store.webSearch)
  if (meta.custom) {
    const cs = findWebSearchCustomSource(store.webSearch, id)
    const host = String(cs?.apiHost || '').trim().replace(/^https?:\/\//, '')
    const kind = cs ? customKindLabel(cs) : ''
    return host ? `${kind} · ${host}` : `${kind} · ${t('未填地址', 'No URL')}`
  }
  if (meta.needsHost) {
    const host = String(store.webSearch?.[id]?.apiHost || '').trim()
    return host ? host.replace(/^https?:\/\//, '') : t('未填实例地址', 'No instance URL')
  }
  if (meta.needsKey) {
    return String(store.webSearch?.[id]?.apiKey || '').trim() ? t('已配置 Key', 'Key set') : t('未配置 Key', 'No key')
  }
  return t('免 Key', 'Keyless')
}

// ==================== 配置保存（归一化 + 持久化 + 下发主进程） ====================
const persist = () => store.updateWebSearchConfig({})

// 启用 / 停用（至少保留一个）
const toggleProvider = (id: string) => {
  const ok = store.toggleWebSearchProvider(id)
  if (!ok) ElMessage.warning(t('至少保留一个搜索源', 'Keep at least one search source enabled'))
}

// ==================== 拖动排序（列表从上到下 = 回退/聚合的尝试顺序） ====================
const dragId = ref('')
const dropHint = ref<{ id: string; pos: 'before' | 'after' } | null>(null)

const onDragStart = (id: string, e: DragEvent) => {
  dragId.value = id
  dropHint.value = null
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}
const onDragOver = (id: string, e: DragEvent) => {
  if (!dragId.value || dragId.value === id) return
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  dropHint.value = { id, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' }
}
const onDragEnd = () => {
  dragId.value = ''
  dropHint.value = null
}
const onDrop = (id: string) => {
  const srcId = dragId.value
  const hint = dropHint.value
  onDragEnd()
  if (!srcId || srcId === id || !hint) return
  const order: string[] = [...(store.webSearch?.order || [])]
  const from = order.indexOf(srcId)
  const j = order.indexOf(id)
  if (from < 0 || j < 0) return
  let final = hint.pos === 'after' ? j + 1 : j
  if (from < final) final -= 1 // 先移除靠前元素后，目标下标前移一位
  store.reorderWebSearchProvider(srcId, final)
}

// ==================== 自定义（内网）搜索源 ====================

/** 新增自定义源（先问名称，类型默认为 SearXNG 兼容，可在右侧切换） */
async function addCustomSource() {
  let name = ''
  try {
    const r = await ElMessageBox.prompt(
      t('给这个内网搜索源起个名字（如「内网搜索」）', 'Name this LAN source (e.g. “Intranet search”)'),
      t('添加自定义搜索源', 'Add custom source'),
      {
        confirmButtonText: t('添加', 'Add'),
        cancelButtonText: t('取消', 'Cancel'),
        inputPlaceholder: t('内网搜索源', 'LAN source'),
        inputValidator: () => true,
      },
    )
    name = String((r as any)?.value || '').trim()
  } catch {
    return // 用户取消
  }
  const id = store.addWebSearchCustomSource(name || t('内网搜索源', 'LAN source'), 'searxng')
  selected.value = toCustomProviderId(id)
  ElMessage.success(t('已添加，请在右侧填写地址并测试', 'Added — fill in the URL and test on the right'))
}

/** 修改当前自定义源配置（输入变化即保存并下发主进程） */
function updateCustom(patch: Partial<WebSearchCustomSource>) {
  const cs = currentCustom.value
  if (!cs) return
  store.updateWebSearchCustomSource(cs.id, patch)
}

/** 删除当前自定义源（二次确认） */
async function removeCustomSource() {
  const cs = currentCustom.value
  if (!cs) return
  try {
    await ElMessageBox.confirm(
      t(`将删除自定义源「${cs.name}」及其配置，是否继续？`, `Delete custom source “${cs.name}” and its settings?`),
      t('删除自定义搜索源', 'Delete custom source'),
      { type: 'warning', confirmButtonText: t('删除', 'Delete'), cancelButtonText: t('取消', 'Cancel') },
    )
  } catch {
    return // 用户取消
  }
  store.removeWebSearchCustomSource(cs.id)
  // 清掉该源的测试状态点（列表里已不存在该项）
  const rest = { ...sourceStatus.value }
  delete rest[toCustomProviderId(cs.id)]
  sourceStatus.value = rest
  selected.value = WEB_SEARCH_PROVIDER_IDS[0]
  ElMessage.success(t('已删除自定义搜索源', 'Custom source deleted'))
}

// ==================== 重置全部配置为默认 ====================
const resetAll = async () => {
  try {
    await ElMessageBox.confirm(
      t('将把所有搜索源恢复为默认（Bing 单源 + 依次回退 + 8 条结果），并清空已填写的 API Key、删除全部自定义（内网）源。是否继续？',
        'All search sources will be reset to defaults (Bing only, fallback strategy, 8 results); API keys and all custom sources will be removed. Continue?'),
      t('重置搜索源配置', 'Reset search sources'),
      { type: 'warning', confirmButtonText: t('重置', 'Reset'), cancelButtonText: t('取消', 'Cancel') },
    )
  } catch {
    return // 用户取消
  }
  store.resetWebSearchConfig()
  testRuns.value = []
  sourceStatus.value = {}
  selected.value = 'bing'
  ElMessage.success(t('已恢复默认搜索源配置', 'Search sources reset to defaults'))
}

// ==================== 测试搜索（可按单个源测试，也可逐个测全部启用源） ====================
interface WsTestRun {
  provider: string
  success: boolean
  error?: string
  elapsedMs: number
  via?: string
  results: Array<{ title: string; url: string; snippet?: string }>
}

const testQuery = ref('')
const testing = ref('')
/** 测试结果按源分组展示（不滚屏，直接向下展开） */
const testRuns = ref<WsTestRun[]>([])
/** 各源的最近测试状态（列表右侧小圆点：online / offline / untested） */
const sourceStatus = ref<Record<string, 'online' | 'offline' | 'untested'>>({})

const buildPayload = (provider?: string) => ({
  query: testQuery.value.trim() || 'OpenAI',
  config: JSON.parse(JSON.stringify(store.webSearch)),
  ...(provider ? { provider } : {}),
})

/** 测试单个源（与启用状态无关） */
const runTestSource = async (provider: string) => {
  const api = (window as any).dsh?.webSearch
  if (!api?.test) {
    ElMessage.warning(t('浏览器模式下无法测试搜索（需桌面版）', 'Search test requires the desktop app'))
    return
  }
  testing.value = provider
  try {
    const r: WebSearchTestResult = await api.test(buildPayload(provider))
    testRuns.value = [{
      provider,
      success: !!r?.success,
      error: r?.error,
      elapsedMs: Number(r?.elapsedMs || 0),
      via: r?.via,
      results: Array.isArray(r?.results) ? r.results : [],
    }]
    sourceStatus.value = { ...sourceStatus.value, [provider]: r?.success ? 'online' : 'offline' }
  } catch (e: any) {
    testRuns.value = [{ provider, success: false, error: e?.message || String(e), elapsedMs: 0, results: [] }]
    sourceStatus.value = { ...sourceStatus.value, [provider]: 'offline' }
  } finally {
    testing.value = ''
  }
}

/** 逐个测试全部启用源（并行聚合/回退策略下都能看到每个源各自的表现） */
const runTestAll = async () => {
  const api = (window as any).dsh?.webSearch
  if (!api?.test) {
    ElMessage.warning(t('浏览器模式下无法测试搜索（需桌面版）', 'Search test requires the desktop app'))
    return
  }
  const list = enabledIds.value
  if (!list.length) return
  testing.value = '__all__'
  testRuns.value = []
  try {
    for (const id of list) {
      try {
        const r: WebSearchTestResult = await api.test(buildPayload(id))
        testRuns.value = [...testRuns.value, {
          provider: id,
          success: !!r?.success,
          error: r?.error,
          elapsedMs: Number(r?.elapsedMs || 0),
          via: r?.via,
          results: Array.isArray(r?.results) ? r.results : [],
        }]
        sourceStatus.value = { ...sourceStatus.value, [id]: r?.success ? 'online' : 'offline' }
      } catch (e: any) {
        testRuns.value = [...testRuns.value, { provider: id, success: false, error: e?.message || String(e), elapsedMs: 0, results: [] }]
        sourceStatus.value = { ...sourceStatus.value, [id]: 'offline' }
      }
    }
  } finally {
    testing.value = ''
  }
}

/**
 * 外部链接（官方文档 / 搜索结果）：桌面版用**自带浏览器**（浏览器 Agent 窗口）打开；
 * 已有浏览器窗口则新标签页打开，未打开则开窗直达该页；浏览器 / 局域网模式退回新标签页。
 */
const openInBrowser = async (url?: string) => {
  const target = String(url || '').trim()
  if (!target) return
  const ipc = (window as any).ipcRenderer
  if (ipc?.invoke) {
    try {
      const r = await ipc.invoke('browser-agent:open-url', { url: target })
      if (r?.ok !== false) return
    } catch {
      /* 主进程未注册该通道（旧版本）时退回下面的外部浏览器 */
    }
  }
  window.open(target, '_blank', 'noopener')
}

// API Key 显示/隐藏（避免设置页截图泄漏）
const showKey = ref(false)
</script>

<template>
  <div class="ws-settings">
    <!-- ====== 左侧：搜索源列表 ====== -->
    <div class="ws-sidebar">
      <div class="ws-toolbar">
        <span class="ws-toolbar-label">{{ t('多源策略', 'Strategy') }}</span>
        <select v-model="store.webSearch.strategy" class="ws-toolbar-select" @change="persist"
                :title="store.webSearch.strategy === 'merge'
                  ? t('并行聚合：所有启用源同时搜索，结果按 URL 去重合并', 'Merge: query all enabled sources in parallel and merge by URL')
                  : t('依次回退：按列表顺序逐个尝试，第一个有结果的源胜出', 'Fallback: try sources in order until one returns results')">
          <option value="fallback">{{ t('依次回退', 'Fallback') }}</option>
          <option value="merge">{{ t('并行聚合', 'Merge') }}</option>
        </select>
        <!-- 重置全部搜索源配置为默认（含清空 API Key / 删除自定义源） -->
        <div class="ws-toolbar-btn" @click="resetAll"
             :title="t('重置搜索源配置为默认（清空 Key / 恢复 Bing 单源）', 'Reset search sources to defaults (clears keys)')">
          <i class="fa fa-undo"></i>
        </div>
        <!-- 添加自定义（内网）搜索源 -->
        <div class="ws-toolbar-btn" @click="addCustomSource"
             :title="t('添加自定义（内网）搜索源：内网 SearXNG 实例 / HTTP JSON 接口', 'Add a custom LAN source: SearXNG instance or HTTP JSON API')">
          <i class="fa fa-plus"></i>
        </div>
      </div>
      <div class="ws-source-list scoll">
        <div
          v-for="item in listItems"
          :key="item.id"
          class="ws-source-item"
          :class="{
            active: selected === item.id,
            disabled: !isEnabled(item.id),
            dragging: dragId === item.id,
            'drop-before': dropHint?.id === item.id && dropHint?.pos === 'before',
            'drop-after': dropHint?.id === item.id && dropHint?.pos === 'after',
          }"
          draggable="true"
          @click="selected = item.id"
          @dragstart="onDragStart(item.id, $event)"
          @dragover.prevent="onDragOver(item.id, $event)"
          @drop.prevent="onDrop(item.id)"
          @dragend="onDragEnd"
          :title="t('拖动可调整顺序；列表从上到下即回退/聚合的尝试顺序', 'Drag to reorder; the list order is the attempt order') + '\n' + providerDesc(item.id)"
        >
          <i class="fa fa-bars ws-drag-grip"></i>
          <div class="ws-source-avatar"><i class="fa" :class="webSearchProviderIcon(item.id)"></i></div>
          <div class="ws-source-info">
            <span class="ws-source-name">{{ providerLabel(item.id) }}</span>
            <span class="ws-source-desc">{{ providerSub(item.id) }}</span>
          </div>
          <span class="ws-source-status" :class="sourceStatus[item.id] || 'untested'">
            <i class="fa" :class="(sourceStatus[item.id] || 'untested') === 'online' ? 'fa-check-circle' : (sourceStatus[item.id] === 'offline' ? 'fa-times-circle' : 'fa-circle-thin')"></i>
          </span>
          <span class="ws-source-toggle" @click.stop="toggleProvider(item.id)"
                :title="isEnabled(item.id)
                  ? t('停用该搜索源（至少保留一个）', 'Disable this source (at least one must stay enabled)')
                  : t('启用该搜索源', 'Enable this source')">
            <i class="fa" :class="isEnabled(item.id) ? 'fa-toggle-on' : 'fa-toggle-off'"></i>
          </span>
        </div>
      </div>
    </div>

    <!-- ====== 右侧：配置区 ====== -->
    <div class="ws-content scoll">
      <!-- 选中源标题 + 启用/停用 -->
      <div class="ws-content-header">
        <h3>
          <i class="fa" :class="webSearchProviderIcon(currentMeta.id)"></i>
          <span class="ws-title-text">{{ providerLabel(currentMeta.id) }}</span>
          <span class="ws-header-state" :class="{ on: isEnabled(currentMeta.id) }">
            {{ isEnabled(currentMeta.id) ? t('已启用', 'Enabled') : t('未启用', 'Disabled') }}
          </span>
        </h3>
        <div class="ws-header-actions">
          <!-- 自定义（内网）源：删除入口 -->
          <div v-if="currentCustom" class="button ws-toggle-btn ws-danger-btn" @click="removeCustomSource"
               :title="t('删除该自定义搜索源及其配置', 'Delete this custom source and its settings')">
            <i class="fa fa-trash"></i>
            {{ t('删除', 'Delete') }}
          </div>
          <div class="button ws-toggle-btn" @click="toggleProvider(currentMeta.id)">
            <i class="fa" :class="isEnabled(currentMeta.id) ? 'fa-toggle-on' : 'fa-toggle-off'"></i>
            {{ isEnabled(currentMeta.id) ? t('停用', 'Disable') : t('启用', 'Enable') }}
          </div>
        </div>
      </div>

      <!-- 说明 + 官方文档 -->
      <div class="settings-group">
        <div class="ws-desc">
          <i class="fa fa-info-circle"></i>
          {{ providerDesc(currentMeta.id) }}
          <template v-if="currentMeta.docs">
            <a class="doc-link" :href="currentMeta.docs" target="_blank" rel="noopener noreferrer"
               :title="t('在内置浏览器中打开', 'Open in the built-in browser')"
               @click.prevent="openInBrowser(currentMeta.docs)">
              {{ t('官方文档 / 申请入口', 'Docs / sign up') }} <i class="fa fa-external-link"></i>
            </a>
          </template>
        </div>
      </div>

      <!-- 该源配置 -->
      <div class="settings-group">
        <div class="ws-config-block">
          <!-- 自定义（内网）源：名称 / 类型 / 地址 / 鉴权 / 字段映射 -->
          <template v-if="currentCustom">
            <div class="form-group">
              <label>{{ t('名称', 'Name') }}</label>
              <input v-model="currentCustom.name" @change="persist" />
            </div>
            <div class="form-group">
              <label>{{ t('类型', 'Type') }}</label>
              <select v-model="currentCustom.kind" @change="persist">
                <option value="searxng">{{ t('SearXNG 兼容实例（内网元搜索）', 'SearXNG-compatible instance') }}</option>
                <option value="json">{{ t('HTTP JSON 接口（自定义字段映射）', 'HTTP JSON API (custom mapping)') }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>{{ t('请求地址', 'Request URL') }}</label>
              <input v-model="currentCustom.apiHost"
                     :placeholder="currentCustom.kind === 'searxng' ? 'http://192.168.1.10:8080' : 'http://192.168.1.10:9200/api/search?q={query}'"
                     @change="persist" />
            </div>
            <div class="form-group">
              <label>API Key</label>
              <div class="input-with-button">
                <input v-model="currentCustom.apiKey" :type="showKey ? 'text' : 'password'"
                       :placeholder="t('可留空（内网免鉴权）；填了会作为 Bearer 发送', 'Optional; sent as Bearer when filled')"
                       @change="persist" />
                <div class="button" style="width:auto;padding:0 8px;" @click="showKey = !showKey"
                     :title="showKey ? t('隐藏', 'Hide') : t('显示', 'Show')">
                  <i class="fa" :class="showKey ? 'fa-eye-slash' : 'fa-eye'"></i>
                </div>
              </div>
            </div>
            <div class="form-group ws-row-top">
              <label>{{ t('请求头', 'Headers') }}</label>
              <textarea v-model="currentCustom.headers" class="ws-custom-textarea" spellcheck="false"
                        :placeholder="t('每行一个 Key: Value，可用 {key} 代表 API Key', 'One “Key: Value” per line; {key} = API key')"
                        @change="persist"></textarea>
            </div>

            <!-- SearXNG 兼容实例参数 -->
            <template v-if="currentCustom.kind === 'searxng'">
              <div class="form-group">
                <label>{{ t('启用引擎', 'Engines') }}</label>
                <input v-model="currentCustom.engines"
                       :placeholder="t('留空用实例默认，如 google,bing', 'e.g. google,bing (empty = instance default)')" @change="persist" />
              </div>
              <div class="form-group">
                <label>{{ t('语言', 'Language') }}</label>
                <select v-model="currentCustom.language" @change="persist">
                  <option value="auto">{{ t('自动', 'Auto') }}</option>
                  <option value="zh-CN">{{ t('中文', 'Chinese') }}</option>
                  <option value="en">{{ t('英文', 'English') }}</option>
                </select>
              </div>
              <div class="ws-hint">
                {{ t('请求格式：GET 实例地址/search?q=关键词&format=json，需实例 settings.yml 开启 JSON 输出；地址可只填「IP:端口」。',
                     'Request: GET <URL>/search?q=<query>&format=json; JSON output must be enabled in the instance settings.yml. “IP:port” alone is fine.') }}
              </div>
            </template>

            <!-- 通用 HTTP JSON 接口参数 -->
            <template v-else>
              <div class="form-group">
                <label>{{ t('请求方式', 'Method') }}</label>
                <select v-model="currentCustom.method" @change="persist">
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
              <div v-if="currentCustom.method === 'POST'" class="form-group ws-row-top">
                <label>{{ t('请求体', 'Body') }}</label>
                <textarea v-model="currentCustom.bodyTemplate" class="ws-custom-textarea" spellcheck="false"
                          :placeholder="t('POST 请求体模板，用 {query} 占位关键词（JSON 模板请自行加引号）；留空则自动发送 query/count',
                                       'POST body template with {query} placeholder (quote it yourself for JSON); empty sends query/count')"
                          @change="persist"></textarea>
              </div>
              <div class="form-group">
                <label>{{ t('结果路径', 'Items path') }}</label>
                <input v-model="currentCustom.itemsPath"
                       :placeholder="t('结果数组所在字段，如 data.list / hits.hits；留空自动识别', 'e.g. data.list / hits.hits (empty = auto)')"
                       @change="persist" />
              </div>
              <div class="form-group">
                <label>{{ t('标题字段', 'Title field') }}</label>
                <input v-model="currentCustom.titleField" :placeholder="'title'" @change="persist" />
              </div>
              <div class="form-group">
                <label>{{ t('链接字段', 'URL field') }}</label>
                <input v-model="currentCustom.urlField" :placeholder="'url'" @change="persist" />
              </div>
              <div class="form-group">
                <label>{{ t('摘要字段', 'Snippet field') }}</label>
                <input v-model="currentCustom.snippetField" :placeholder="'snippet'" @change="persist" />
              </div>
              <div class="ws-hint">
                {{ t('地址里可用 {query} 占位（GET 留空占位时自动追加 ?q=关键词）；字段支持点号路径（如 _source.title）；相对链接会按请求地址补全。',
                     'Use {query} in the URL (GET without it appends ?q=…); fields accept dot paths (e.g. _source.title); relative links are resolved against the request URL.') }}
              </div>
            </template>
          </template>

          <!-- SearXNG：实例地址 / 引擎 / 语言 -->
          <template v-else-if="currentMeta.id === 'searxng'">
            <div class="form-group">
              <label>{{ t('实例地址', 'Instance URL') }}</label>
              <input v-model="store.webSearch.searxng.apiHost" placeholder="http://localhost:8080" @change="persist" />
            </div>
            <div class="form-group">
              <label>{{ t('启用引擎', 'Engines') }}</label>
              <input v-model="store.webSearch.searxng.engines"
                     :placeholder="t('留空用实例默认，如 google,bing', 'e.g. google,bing (empty = instance default)')" @change="persist" />
            </div>
            <div class="form-group">
              <label>{{ t('语言', 'Language') }}</label>
              <select v-model="store.webSearch.searxng.language" @change="persist">
                <option value="auto">{{ t('自动', 'Auto') }}</option>
                <option value="zh-CN">{{ t('中文', 'Chinese') }}</option>
                <option value="en">{{ t('英文', 'English') }}</option>
              </select>
            </div>
            <div class="ws-hint">
              {{ t('需在实例的 settings.yml 中开启 JSON 输出（search.formats 含 json），否则接口会返回 403。',
                   'Enable JSON output in settings.yml (search.formats must include json), otherwise the API returns 403.') }}
            </div>
          </template>

          <!-- API Key 源：Key / 接口地址（+ 智谱搜索等级） -->
          <template v-else-if="currentMeta.needsKey">
            <div class="form-group">
              <label>API Key</label>
              <div class="input-with-button">
                <input
                  v-model="store.webSearch[currentMeta.id].apiKey"
                  :type="showKey ? 'text' : 'password'"
                  :placeholder="t('粘贴 API Key（仅保存在本机）', 'Paste API key (stored locally)')"
                  @change="persist"
                />
                <div class="button" style="width:auto;padding:0 8px;" @click="showKey = !showKey"
                     :title="showKey ? t('隐藏', 'Hide') : t('显示', 'Show')">
                  <i class="fa" :class="showKey ? 'fa-eye-slash' : 'fa-eye'"></i>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>{{ t('接口地址', 'API host') }}</label>
              <input v-model="store.webSearch[currentMeta.id].apiHost" @change="persist" />
            </div>
            <div v-if="currentMeta.id === 'zhipu'" class="form-group">
              <label>{{ t('搜索等级', 'Search level') }}</label>
              <select v-model="store.webSearch.zhipu.searchEngine" @change="persist">
                <option value="search_std">{{ t('基础（search_std）', 'Basic (search_std)') }}</option>
                <option value="search_pro">{{ t('高阶（search_pro）', 'Advanced (search_pro)') }}</option>
              </select>
            </div>
          </template>

          <!-- 免 Key 源：Bing 可选中文改写，其余无需配置 -->
          <template v-else-if="currentMeta.id === 'bing'">
            <div class="form-group ws-hint-row">
              <label>{{ t('中文查询改写', 'Rewrite (zh)') }}</label>
              <input type="checkbox" v-model="store.webSearch.rewriteZhQuery" @change="persist" />
              <span class="ws-hint-inline">
                {{ t('长中文句先转关键词，避免拆词问题', 'Turn long Chinese queries into keywords') }}
              </span>
            </div>
          </template>

          <!-- 免 Key 源（百度 / DuckDuckGo）：无需配置 -->
          <template v-else>
            <div class="ws-hint">
              {{ t('该搜索源无需配置，启用后即可使用。', 'No configuration needed — just enable it.') }}
            </div>
          </template>
        </div>
      </div>

      <!-- 全局设置（所有搜索源共用） -->
      <div class="ws-content-header"><h3>{{ t('全局设置', 'Global') }}</h3></div>
      <div class="settings-group">
        <div class="ws-config-block">
          <div class="form-group">
            <label>{{ t('返回条数', 'Max results') }}</label>
            <input v-model.number="store.webSearch.maxResults" type="number" min="1" max="20" step="1" @change="persist" />
          </div>
          <div class="ws-hint">
            {{ t('配置作用于智能体、批量任务与工作流「网络搜索」节点使用的 web_search 工具，改完立即生效（无需重启）；抓取具体网页（web_fetch）不受影响。',
                 'Applies to the web_search tool used by agents, batch runs and workflow web-search nodes — takes effect immediately. web_fetch is unaffected.') }}
          </div>
          <div v-if="!hasMain" class="ws-hint warn">
            <i class="fa fa-exclamation-triangle"></i>
            {{ t('当前为浏览器/局域网模式：配置仅保存在本机浏览器，实际搜索仍由主机执行。',
                 'Browser/LAN mode: the configuration is stored in this browser; searches still run on the host.') }}
          </div>
        </div>
      </div>

      <!-- 测试搜索 -->
      <div class="ws-content-header"><h3>{{ t('测试搜索', 'Test Search') }}</h3></div>
      <div class="settings-group">
        <div class="ws-config-block">
          <div class="form-group">
            <label>{{ t('测试词', 'Query') }}</label>
            <input v-model="testQuery" :placeholder="t('留空用 “OpenAI” 测试', 'Empty = test with “OpenAI”')" @keyup.enter="runTestAll()" />
          </div>
          <!-- 两个测试按钮另起一行 -->
          <div class="ws-test-actions">
            <div class="button" :class="{ disabled: !!testing }" @click="runTestAll()"
                 :title="t('逐个测试全部已启用的搜索源', 'Test every enabled search source one by one')">
              <i class="fa" :class="testing === '__all__' ? 'fa-spinner fa-spin' : 'fa-list-ul'"></i>
              {{ testing === '__all__' ? t('测试中…', 'Testing…') : t('测试全部启用源', 'Test all enabled') }}
            </div>
            <div class="button" :class="{ disabled: !!testing }" @click="runTestSource(selected)"
                 :title="t('只测试当前选中的源（与是否启用无关）', 'Test only the selected source (regardless of enable state)')">
              <i class="fa" :class="testing === selected ? 'fa-spinner fa-spin' : 'fa-flask'"></i>
              {{ t('测当前源', 'Test source') }}
            </div>
          </div>
          <!-- 测试结果：按源分组，向下展开（不滚屏） -->
          <div v-if="testRuns.length" class="test-result">
            <div v-for="(run, ri) in testRuns" :key="ri" class="test-group">
              <div class="test-group-head" :class="run.success ? 'ok' : 'fail'">
                <i class="fa" :class="run.success ? 'fa-check-circle' : 'fa-times-circle'"></i>
                <span class="test-group-name">{{ providerLabel(run.provider) }}</span>
                <template v-if="run.success">
                  <span class="test-group-meta">via {{ run.via }} · {{ run.elapsedMs }} ms · {{ run.results.length }} {{ t('条结果', 'results') }}</span>
                </template>
                <template v-else>
                  <span class="test-group-meta">{{ t('失败', 'Failed') }}：{{ run.error }}</span>
                </template>
              </div>
              <div v-if="run.success && run.results.length" class="test-items">
                <div v-for="(r, i) in run.results" :key="i" class="test-item">
                  <a :href="r.url" target="_blank" rel="noopener noreferrer" class="test-item-title" :title="r.url"
                     @click.prevent="openInBrowser(r.url)">{{ r.title }}</a>
                  <div class="test-item-url">{{ r.url }}</div>
                  <div v-if="r.snippet" class="test-item-snippet">{{ r.snippet }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== 根：左右分栏（与「模型」设置一致的骨架） ====== */
.ws-settings {
  display: flex; height: 100%; flex: 1; overflow: hidden;
  background: var(--backgroundColor); color: var(--fontColor);
}
.ws-sidebar {
  width: 210px; display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor); background: var(--menuColor);
  flex-shrink: 0;
}
.ws-toolbar {
  display: flex; align-items: center; gap: 6px;
  flex-shrink: 0; padding: 5px;
  border-bottom: 1px solid var(--borderColor); background: var(--menuColor);
}
.ws-toolbar-label { font-size: 12px; opacity: .75; flex-shrink: 0; }
.ws-toolbar-select {
  flex: 1; min-width: 0; height: 26px; padding: 0 4px; margin: 0px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 12px;
}
.ws-toolbar-select:focus { outline: none; border-color: var(--fontActiveColor); }
.ws-toolbar-btn {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); background: var(--backgroundColor);
  color: var(--fontColor); font-size: 12px; cursor: pointer; transition: all .15s;
}
.ws-toolbar-btn:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }

.ws-source-list { flex: 1; overflow-y: auto; padding: 2px; }
.ws-source-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; margin-bottom: 2px; border-radius: 5px;
  border: 1px solid transparent; cursor: grab; transition: background .15s, border-color .15s;
}
.ws-source-item:active { cursor: grabbing; }
.ws-source-item.dragging { opacity: .5; }
.ws-source-item.drop-before { box-shadow: inset 0 2px 0 var(--fontActiveColor); }
.ws-source-item.drop-after { box-shadow: inset 0 -2px 0 var(--fontActiveColor); }
.ws-drag-grip { flex-shrink: 0; font-size: 10px; opacity: .3; cursor: grab; }
.ws-source-item:hover .ws-drag-grip { opacity: .7; }
.ws-source-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.ws-source-item.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); border-color: var(--fontActiveColor); }
.ws-source-avatar {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
}
.ws-source-avatar i { font-size: 12px; color: var(--fontActiveColor); }
.ws-source-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ws-source-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-source-desc { font-size: 10px; color: var(--fontColor); opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-source-status { flex-shrink: 0; font-size: 10px; color: var(--borderColor); }
.ws-source-status.online { color: #4CAF50; }
.ws-source-status.offline { color: #f44336; }
.ws-source-toggle {
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; font-size: 14px; cursor: pointer;
  color: var(--fontActiveColor); opacity: .85; transition: all .12s;
}
.ws-source-toggle:hover { opacity: 1; transform: scale(1.12); }
.ws-source-toggle .fa-toggle-off { color: var(--borderColor); }
/* 未启用：置灰 + 名称删除线（同「模型」页禁用来源的观感） */
.ws-source-item.disabled { opacity: .45; }
.ws-source-item.disabled .ws-source-name { text-decoration: line-through; }

/* ====== 右侧：配置区 ====== */
.ws-content { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 8px; }
.ws-content-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px;
  border-bottom: 1px solid var(--borderColor); padding-bottom: 5px; margin-bottom: 6px;
}
.ws-content-header h3 {
  position: relative; flex: 1 1 140px; min-width: 0;
  color: var(--fontActiveColor); margin: 0; padding: 0 0 4px 10px;
  font-size: 14px; font-weight: 600;
  display: flex; align-items: center; gap: 6px;
}
.ws-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-content-header h3::before {
  content: ''; position: absolute; left: 0; top: 2px; bottom: 6px;
  width: 3px; background: var(--fontActiveColor); border-radius: 2px;
}
.ws-header-state { font-size: 11px; font-weight: 400; opacity: .7; white-space: nowrap; flex-shrink: 0; }
.ws-header-state.on { color: #4CAF50; opacity: .9; }
.ws-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; }
.ws-toggle-btn { width: auto; padding: 0 8px; height: 24px; font-size: 12px; }
/* 删除自定义源按钮（红色悬停提示，与其它按钮同尺寸） */
.ws-danger-btn { color: #f56c6c; border-color: color-mix(in srgb, #f56c6c 45%, var(--borderColor)); }
.ws-danger-btn:hover { background-color: color-mix(in srgb, #f56c6c 12%, transparent); color: #f56c6c; }
/* 多行配置（自定义源请求头 / 请求体）：标签顶端对齐，内容区自适应高度 */
.ws-content .form-group.ws-row-top { align-items: flex-start; }
.ws-content .form-group.ws-row-top > label { padding-top: 5px; }
.ws-custom-textarea {
  flex: 1; min-width: 0; min-height: 52px; resize: vertical;
  padding: 3px 4px; border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  font-size: 12px; line-height: 1.5; font-family: Consolas, Monaco, monospace;
  box-sizing: border-box;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden;
}
.ws-custom-textarea:focus { outline: none; border-color: var(--fontActiveColor); }

.settings-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.ws-config-block {
  border: 1px solid var(--borderColor); border-radius: 4px;
  padding: 6px; display: flex; flex-direction: column; gap: 6px;
}
.ws-desc { font-size: 12px; opacity: .85; line-height: 1.5; }
.ws-hint { font-size: 11px; opacity: .7; line-height: 1.5; }
.ws-hint.warn { color: #e6a23c; opacity: .95; }
.ws-hint-inline { flex: 1; min-width: 0; font-size: 11px; opacity: .7; white-space: normal; }
.ws-hint-row { white-space: normal; }
.doc-link { color: var(--fontActiveColor); text-decoration: none; margin-left: 6px; }
.doc-link:hover { text-decoration: underline; }

/* ====== 表单单行布局（label 右对齐 + 控件撑满，同「模型」页） ====== */
.ws-content .form-group {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: nowrap; white-space: nowrap; margin: 0;
}
.ws-content .form-group > * { margin: 0; }
.ws-content .form-group > label {
  flex-shrink: 0; width: auto; min-width: 95px;
  text-align: right; font-size: 12px; line-height: 1;
}
.ws-content .form-group > label::after { content: '：'; }
.ws-content .form-group > input,
.ws-content .form-group > select,
.ws-content .form-group > .input-with-button { flex: 1; min-width: 0; }
.ws-content .form-group input,
.ws-content .form-group select {
  padding: 2px 4px; border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor); font-size: 13px;
  height: 27px; box-sizing: border-box;
}
/* 下拉框用正常背景色（不用菜单底色） */
.ws-content .form-group select { background-color: var(--backgroundColor); }
.ws-content .form-group input:focus,
.ws-content .form-group select:focus { outline: none; border-color: var(--fontActiveColor); }
.ws-content .form-group input[type="checkbox"] { flex: 0 0 auto; width: 15px; height: 15px; margin-right: 6px; }
.input-with-button { display: flex; align-items: stretch; gap: 4px; min-width: 0; margin: 0; }
.input-with-button > input { flex: 1; min-width: 0; margin: 0; }
.input-with-button > .button {
  flex-shrink: 0; height: auto; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0; width: auto;
}
.button {
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  cursor: pointer; transition: all 0.2s ease;
  display: flex; align-items: center; justify-content: center;
  gap: 5px; font-size: 13px; white-space: nowrap; margin: 0; padding: 4px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button.disabled { opacity: 0.5; pointer-events: none; }
.button i { font-size: 13px; }

/* ====== 测试结果（按源分组，自然展开不滚屏） ====== */
.ws-test-actions { display: flex; align-items: center; gap: 8px; }
.ws-test-actions .button { width: auto; padding: 0 10px; height: 27px; }
.test-result { margin-top: 2px; display: flex; flex-direction: column; gap: 10px; }
.test-group { display: flex; flex-direction: column; gap: 6px; }
.test-group-head { display: flex; align-items: baseline; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.test-group-head.ok { color: #67c23a; }
.test-group-head.fail { color: #f56c6c; }
.test-group-name { font-weight: 600; }
.test-group-meta { font-size: 11px; opacity: .85; word-break: break-word; }
.test-items { display: flex; flex-direction: column; gap: 6px; }
.test-item { border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px 7px; background-color: var(--menuColor); }
.test-item-title { color: var(--fontActiveColor); font-size: 13px; text-decoration: none; }
.test-item-title:hover { text-decoration: underline; }
.test-item-url { color: var(--fontColor); font-size: 11px; opacity: 0.6; word-break: break-all; }
.test-item-snippet { color: var(--fontColor); font-size: 12px; opacity: 0.85; margin-top: 3px; line-height: 1.45; }
</style>
