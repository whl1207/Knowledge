<!-- 网页抓取设置（「工具 → 抓取」）：三条抓取通道各自开关 + 拖动排序（回退顺序）
     - 直接访问（内置 HTTP 客户端；HTML / PDF）
     - DeepSeek Fetch（官方接口，服务端返回 Markdown 正文；可复用对话 / 搜索的 DeepSeek 凭据）
     - 虚拟浏览器（隐藏 Chromium，桌面端独有）
     - 测试抓取：填 URL 直接验证当前通道链，展示命中的通道 / 耗时 / 正文长度与开头
     配置保存在 store.webFetch（localStorage `webFetchConfig`），每次变更自动下发主进程（webFetch:set-config）。 -->
<script setup lang="ts">
import { aikmDsh } from '@/lib/aikmIpc'
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  WEB_FETCH_CHANNEL_IDS,
  webFetchChannelMeta,
  type WebFetchChannelId,
  type WebFetchTestResult,
} from '@/shared/webFetch'

interface Props {
  store: any
}
const props = defineProps<Props>()
const store = props.store
const t = (zh: string, en: string): string => (store.locales === 'zh' ? zh : en)

// 防御：旧存档/异常时补齐结构（normalize 由 store 负责，这里只防 undefined）
if (!store.webFetch) store.updateWebFetchConfig({})

/** 是否有主进程（桌面版）可用：浏览器 / 局域网模式下抓取仍由主机执行 */
const hasMain = computed(() => !!(aikmDsh?.webFetch?.setConfig))

/** 已开启的通道 */
const isEnabled = (id: WebFetchChannelId) => !!store.webFetch?.channels?.[id]

/** 列表项：顺序 = 配置的 order（拖动结果），也就是失败后的回退顺序 */
const listItems = computed(() => {
  const order: string[] = Array.isArray(store.webFetch?.order) ? store.webFetch.order : []
  const all: WebFetchChannelId[] = [...WEB_FETCH_CHANNEL_IDS]
  const ids = [...order.filter((id) => all.includes(id as WebFetchChannelId)), ...all.filter((id) => !order.includes(id))]
  return ids.map((id) => ({ id: id as WebFetchChannelId, meta: webFetchChannelMeta(id) }))
})

const label = (id: WebFetchChannelId) => {
  const meta = webFetchChannelMeta(id)
  return store.locales === 'zh' ? meta.label : meta.labelEn
}
const desc = (id: WebFetchChannelId) => {
  const meta = webFetchChannelMeta(id)
  return store.locales === 'zh' ? meta.zh : meta.en
}
const channelIcon = (id: WebFetchChannelId): string => {
  if (id === 'deepseek') return 'fa-bolt'
  if (id === 'browser') return 'fa-window-maximize'
  return 'fa-cloud-download'
}

// ==================== 保存（归一化 + 持久化 + 下发主进程） ====================
const persist = () => store.updateWebFetchConfig({})

// 启用 / 停用（至少保留一个）
const toggle = (id: WebFetchChannelId) => {
  const ok = store.toggleWebFetchChannel(id)
  if (!ok) ElMessage.warning(t('至少保留一种抓取方式', 'Keep at least one fetch channel enabled'))
}

// ==================== 拖动排序（从上到下 = 回退顺序） ====================
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
  const order: string[] = [...(store.webFetch?.order || [])]
  const from = order.indexOf(srcId)
  const j = order.indexOf(id)
  if (from < 0 || j < 0) return
  let final = hint.pos === 'after' ? j + 1 : j
  if (from < final) final -= 1
  store.reorderWebFetchChannel(srcId as WebFetchChannelId, final)
}

// ==================== 重置 ====================
const resetAll = async () => {
  try {
    await ElMessageBox.confirm(
      t('将恢复默认抓取方式（直接访问 + 虚拟浏览器，DeepSeek 关闭）并清空 DeepSeek Key，是否继续？',
        'Restore the default channels (direct + virtual browser, DeepSeek off) and clear the DeepSeek key?'),
      t('重置抓取设置', 'Reset fetch settings'),
      { type: 'warning', confirmButtonText: t('重置', 'Reset'), cancelButtonText: t('取消', 'Cancel') },
    )
  } catch {
    return // 用户取消
  }
  store.resetWebFetchConfig()
  testResult.value = null
  ElMessage.success(t('已恢复默认抓取设置', 'Fetch settings reset to defaults'))
}

// ==================== 测试抓取 ====================
const testUrl = ref('')
const testing = ref(false)
const testResult = ref<WebFetchTestResult | null>(null)
/** API Key 显示/隐藏（避免设置页截图泄漏） */
const showKey = ref(false)

const runTest = async () => {
  const api = aikmDsh?.webFetch
  if (!api?.test) {
    ElMessage.warning(t('浏览器模式下无法测试抓取（需桌面版）', 'Fetch test requires the desktop app'))
    return
  }
  testing.value = true
  try {
    // 与搜索测试同理：必须带解析后的 DeepSeek Key，否则「复用凭据」会被误判成未配置
    const config = typeof store.buildWebFetchPayload === 'function'
      ? await store.buildWebFetchPayload()
      : JSON.parse(JSON.stringify(store.webFetch))
    const r: WebFetchTestResult = await api.test({
      url: testUrl.value.trim() || 'https://example.com',
      config,
    })
    testResult.value = r
  } catch (e: any) {
    testResult.value = { success: false, url: testUrl.value.trim(), elapsedMs: 0, error: e?.message || String(e) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="wf-settings scoll">
    <!-- 标题行 -->
    <div class="wf-header-row">
      <h3><i class="fa fa-cloud-download"></i><span>{{ t('网页抓取', 'Web Fetch') }}</span></h3>
      <div class="wf-header-actions">
        <div class="button wf-btn" @click="resetAll"
             :title="t('恢复默认抓取方式（清空 DeepSeek Key）', 'Restore default channels (clears the DeepSeek key)')">
          <i class="fa fa-undo"></i>
          {{ t('恢复默认', 'Reset') }}
        </div>
      </div>
    </div>

    <div class="wf-desc">
      <i class="fa fa-info-circle"></i>
      {{ t('web_fetch 工具（智能体、批量任务、工作流共用）按下面的顺序依次尝试已开启的抓取方式：某个通道失败（HTTP 403 / 验证页 / 超时 / 空内容）就自动回退到下一个，全部失败才返回错误。',
           'The web_fetch tool (shared by agents, batch runs and workflows) tries the enabled channels below in order: when one fails (HTTP 403 / challenge page / timeout / empty body) it falls back to the next, and only reports an error when all fail.') }}
    </div>

    <!-- 抓取方式列表 -->
    <div class="wf-block">
      <div class="wf-block-title">
        <span>{{ t('抓取方式（从上到下 = 回退顺序）', 'Channels (top to bottom = fallback order)') }}</span>
        <span class="wf-hint-inline">{{ t('拖动左侧把手可调整顺序', 'Drag the handle to reorder') }}</span>
      </div>
      <div class="wf-channel-list">
        <div
          v-for="item in listItems"
          :key="item.id"
          class="wf-channel-item"
          :class="{
            active: isEnabled(item.id),
            dragging: dragId === item.id,
            'drop-before': dropHint?.id === item.id && dropHint?.pos === 'before',
            'drop-after': dropHint?.id === item.id && dropHint?.pos === 'after',
          }"
          draggable="true"
          @dragstart="onDragStart(item.id, $event)"
          @dragover.prevent="onDragOver(item.id, $event)"
          @drop.prevent="onDrop(item.id)"
          @dragend="onDragEnd"
          :title="desc(item.id)"
        >
          <i class="fa fa-bars wf-grip"></i>
          <div class="wf-avatar"><i class="fa" :class="channelIcon(item.id)"></i></div>
          <div class="wf-info">
            <div class="wf-name-row">
              <span class="wf-name">{{ label(item.id) }}</span>
              <span v-if="item.meta.desktopOnly" class="wf-badge">{{ t('仅桌面端', 'Desktop only') }}</span>
              <span v-if="item.meta.needsKey" class="wf-badge">{{ t('需 Key', 'Key required') }}</span>
            </div>
            <div class="wf-sub">{{ desc(item.id) }}</div>
          </div>
          <div class="wf-toggle" :class="{ on: isEnabled(item.id) }"
               :title="isEnabled(item.id) ? t('点击停用', 'Click to disable') : t('点击启用', 'Click to enable')"
               @click.stop="toggle(item.id)">
            <span class="wf-knob"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- DeepSeek Fetch 配置 -->
    <div class="wf-block">
      <div class="wf-block-title">
        <span><i class="fa fa-bolt"></i> DeepSeek Fetch</span>
        <span class="wf-state" :class="{ on: isEnabled('deepseek') }">
          {{ isEnabled('deepseek') ? t('已启用', 'Enabled') : t('未启用', 'Disabled') }}
        </span>
      </div>
      <div class="wf-row">
        <label>API Key</label>
        <div class="wf-input-with-btn">
          <input v-model="store.webFetch.deepseek.apiKey" :type="showKey ? 'text' : 'password'"
                 :placeholder="t('留空并开启下面的「复用凭据」即可', 'Leave empty and reuse other DeepSeek credentials below')"
                 @change="persist" />
          <div class="button wf-eye" @click="showKey = !showKey" :title="showKey ? t('隐藏', 'Hide') : t('显示', 'Show')">
            <i class="fa" :class="showKey ? 'fa-eye-slash' : 'fa-eye'"></i>
          </div>
        </div>
      </div>
      <div class="wf-row">
        <label>{{ t('接口地址', 'API host') }}</label>
        <input v-model="store.webFetch.deepseek.apiHost" placeholder="https://api.deepseek.com" @change="persist" />
      </div>
      <div class="wf-row wf-row-wrap">
        <label>{{ t('复用凭据', 'Reuse credentials') }}</label>
        <input type="checkbox" v-model="store.webFetch.deepseek.reuseChatKey" @change="persist" />
        <span class="wf-hint-inline">
          {{ t('自己的 Key 留空时：依次复用「工具 → 搜索」里的 DeepSeek Key / 凭据引用 / 对话的 DeepSeek 凭据',
               'When the key above is empty: reuse the DeepSeek key / credential ref from Tools → Search, then the chat DeepSeek credential') }}
        </span>
      </div>
      <div class="wf-hint">
        {{ t('接口：POST {host}/v1/tools/fetch，Bearer 鉴权；返回服务端抓取并整理好的 Markdown 正文。按成功请求次数计费（约 5 元 / 1000 次），QPS 5；403 表示目标站点拒绝抓取，404 表示没取到可用正文。',
             'Endpoint: POST {host}/v1/tools/fetch with Bearer auth; returns Markdown extracted by the server. Billed per successful request (about ¥5 / 1,000), 5 QPS. 403 = the site refuses fetching, 404 = no usable content.') }}
      </div>
    </div>

    <!-- 测试抓取 -->
    <div class="wf-block">
      <div class="wf-block-title">
        <span>{{ t('测试抓取', 'Test fetch') }}</span>
        <span class="wf-hint-inline">{{ t('建议先用一个平时打不开的页面验证回退', 'Try a page that normally fails to verify the fallback') }}</span>
      </div>
      <div class="wf-row">
        <label>URL</label>
        <input v-model="testUrl" :placeholder="t('留空用 https://example.com 测试', 'Empty = test with https://example.com')"
               @keyup.enter="runTest" />
      </div>
      <div class="wf-test-actions">
        <div class="button wf-btn" :class="{ disabled: testing }" @click="runTest">
          <i class="fa" :class="testing ? 'fa-spinner fa-spin' : 'fa-flask'"></i>
          {{ testing ? t('抓取中…', 'Fetching…') : t('测试当前通道链', 'Test channel chain') }}
        </div>
      </div>
      <div v-if="testResult" class="wf-test-result">
        <div class="wf-test-head" :class="testResult.success ? 'ok' : 'fail'">
          <i class="fa" :class="testResult.success ? 'fa-check-circle' : 'fa-times-circle'"></i>
          <template v-if="testResult.success">
            <span>{{ t('成功', 'OK') }}</span>
            <span class="wf-test-meta">
              via {{ testResult.via }} · {{ testResult.elapsedMs }} ms · {{ testResult.chars }} {{ t('字符', 'chars') }}
            </span>
          </template>
          <template v-else>
            <span>{{ t('失败', 'Failed') }}</span>
            <span class="wf-test-meta">{{ testResult.elapsedMs }} ms · {{ testResult.error }}</span>
          </template>
        </div>
        <pre v-if="testResult.success && testResult.preview" class="wf-preview">{{ testResult.preview }}</pre>
      </div>
      <div v-if="!hasMain" class="wf-hint warn">
        <i class="fa fa-exclamation-triangle"></i>
        {{ t('浏览器 / 局域网模式：配置只保存在本机浏览器，实际抓取仍由主机执行；测试需在桌面端使用。',
             'Browser / LAN mode: the configuration stays in this browser and fetching still runs on the host; testing requires the desktop app.') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-settings {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  color: var(--fontColor);
  box-sizing: border-box;
}

/* ====== 标题行 ====== */
.wf-header-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border-bottom: 1px solid var(--borderColor);
  margin-bottom: 8px;
}
.wf-header-row h3 {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  color: var(--fontActiveColor); margin: 0; padding: 0 0 8px 10px;
  font-size: 14px; font-weight: 600;
}
.wf-header-row h3::before {
  content: ''; position: absolute; left: 0; top: 3px; bottom: 9px;
  width: 3px; background: var(--fontActiveColor); border-radius: 2px;
}
.wf-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.wf-desc { font-size: 12px; opacity: .85; line-height: 1.5; margin-bottom: 8px; }
.wf-desc i { color: var(--fontActiveColor); margin-right: 4px; }

/* ====== 区块 ====== */
.wf-block {
  border: 1px solid var(--borderColor); border-radius: 5px;
  padding: 7px 8px; margin-bottom: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.wf-block-title {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 12px; font-weight: 600; color: var(--fontActiveColor);
  flex-wrap: wrap;
}
.wf-state { font-size: 11px; font-weight: 400; opacity: .65; }
.wf-state.on { color: #4CAF50; opacity: .95; }

/* ====== 通道列表 ====== */
.wf-channel-list { display: flex; flex-direction: column; gap: 4px; }
.wf-channel-item {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 7px; border-radius: 5px;
  border: 1px solid transparent;
  cursor: grab; transition: background .15s, border-color .15s;
}
.wf-channel-item:active { cursor: grabbing; }
.wf-channel-item:hover { background: color-mix(in srgb, var(--fontColor) 5%, transparent); }
.wf-channel-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor));
}
.wf-channel-item.dragging { opacity: .5; }
.wf-channel-item.drop-before { box-shadow: inset 0 2px 0 var(--fontActiveColor); }
.wf-channel-item.drop-after { box-shadow: inset 0 -2px 0 var(--fontActiveColor); }
.wf-grip { flex-shrink: 0; font-size: 10px; opacity: .3; }
.wf-channel-item:hover .wf-grip { opacity: .7; }
.wf-avatar {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor); font-size: 13px;
}
.wf-info { flex: 1; min-width: 0; }
.wf-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wf-name { font-size: 12px; font-weight: 600; }
.wf-badge {
  font-size: 9px; padding: 0 5px; border-radius: 3px;
  border: 1px solid var(--borderColor);
  color: var(--fontColor); opacity: .7;
}
.wf-sub { font-size: 10px; opacity: .7; margin-top: 1px; line-height: 1.45; }

/* 开关（与工具管理同观感） */
.wf-toggle {
  width: 30px; height: 16px; border-radius: 8px; flex-shrink: 0;
  background: var(--borderColor); position: relative; cursor: pointer; transition: all .15s;
}
.wf-toggle .wf-knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: all .15s;
}
.wf-toggle.on { background: var(--fontActiveColor); }
.wf-toggle.on .wf-knob { left: 16px; }

/* ====== 表单行 ====== */
.wf-row {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: nowrap; white-space: nowrap; margin: 0;
}
.wf-row > label {
  flex-shrink: 0; width: auto; min-width: 78px;
  text-align: right; font-size: 12px; line-height: 1;
}
.wf-row > label::after { content: '：'; }
.wf-row > input:not([type="checkbox"]) { flex: 1; min-width: 0; }
.wf-row > input[type="checkbox"] { flex: 0 0 auto; width: 15px; height: 15px; }
.wf-row.wf-row-wrap { white-space: normal; flex-wrap: wrap; }
.wf-row input {
  padding: 2px 4px; border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor); font-size: 13px;
  height: 27px; box-sizing: border-box;
}
.wf-row input:focus { outline: none; border-color: var(--fontActiveColor); }
.wf-input-with-btn { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 4px; }
.wf-input-with-btn > input { flex: 1; min-width: 0; }
.wf-eye {
  flex-shrink: 0; width: auto; padding: 0 8px; margin: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.wf-hint { font-size: 11px; opacity: .7; line-height: 1.5; }
.wf-hint.warn { color: #e6a23c; opacity: .95; }
.wf-hint-inline { font-size: 11px; opacity: .7; font-weight: 400; white-space: normal; }

/* ====== 按钮 / 测试 ====== */
.button {
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  cursor: pointer; transition: all .2s ease;
  display: flex; align-items: center; justify-content: center;
  gap: 5px; font-size: 13px; white-space: nowrap; margin: 0; padding: 4px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button.disabled { opacity: .5; pointer-events: none; }
.wf-btn { width: auto; padding: 0 10px; height: 26px; font-size: 12px; }
.wf-test-actions { display: flex; align-items: center; gap: 8px; }
.wf-test-result { display: flex; flex-direction: column; gap: 6px; }
.wf-test-head { display: flex; align-items: baseline; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.wf-test-head.ok { color: #67c23a; }
.wf-test-head.fail { color: #f56c6c; }
.wf-test-meta { font-size: 11px; opacity: .85; word-break: break-word; }
.wf-preview {
  margin: 0; padding: 6px 8px; max-height: 220px; overflow: auto;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor); color: var(--fontColor);
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
</style>
