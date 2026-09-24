<!-- SessionLogPanel.vue — 会话事件日志检视器（设置模块内嵌版；单一事实源可视化）
     hideHeader：嵌入智能体控制台时隐藏自身头部（模块标题/清空按钮），控件由外层 ac-header 提供
     布局（参照 AgentPreset / SkillManagement）：左侧「会话列表导航」+ 右侧「详情」。
     事件流采用分段加载：打开只取最近 PAGE_EVENTS 条，滚动到底自动加载更早历史，
     避免超大日志一次性 IPC + 渲染导致的打开卡顿。 -->
<template>
  <div class="session-log-panel">
    <!-- ====== 左侧导航：会话列表 ====== -->
    <div class="slp-nav">
      <div class="slp-nav-toolbar">
        <div class="slp-nav-title-row">
          <span v-if="!hideHeader" class="slp-nav-title"><i class="fa fa-list-alt"></i> {{ isZh ? '会话日志' : 'Session Log' }}</span>
          <span class="slp-nav-count">{{ filteredSessions.length }}/{{ sessions.length }}</span>
          <div class="slp-nav-actions">
            <button class="slp-btn" :title="isZh ? '刷新会话列表' : 'Refresh sessions'" @click="onRefresh">
              <i class="fa" :class="listLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
            </button>
          </div>
        </div>
        <div v-if="!hideHeader" class="slp-nav-clear-row">
          <select v-model="clearRange" class="slp-range-select" :title="isZh ? '清理范围（清理该时间点以前的会话日志）' : 'Clear range (sessions older than this point)'">
            <option v-for="o in clearRangeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <button class="slp-btn slp-btn-danger slp-clear-btn" :title="isZh ? '按范围清理会话日志' : 'Clear session logs by range'" @click="onClear">
            <i class="fa fa-eraser"></i>
            <span>{{ isZh ? '清理' : 'Clear' }}</span>
          </button>
        </div>
        <div class="slp-nav-search">
          <i class="fa fa-search"></i>
          <input v-model="keyword" class="slp-nav-search-input"
            :placeholder="isZh ? '搜索会话/聊天内容' : 'Search sessions / chat'" />
          <i v-if="contentSearching" class="fa fa-spinner fa-spin slp-nav-search-loading"></i>
          <div v-if="keyword" class="slp-nav-search-clear" @click="keyword = ''" :title="isZh ? '清除' : 'Clear'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
      </div>

      <div ref="navListEl" class="slp-nav-list scoll" @scroll="onNavScroll">
        <div v-if="!sessions.length" class="slp-empty">
          <i class="fa fa-inbox" style="font-size:22px;"></i>
          <span>{{ isZh ? '暂无会话日志' : 'No session logs' }}</span>
        </div>
        <div v-else-if="!filteredSessions.length" class="slp-empty">
          <i class="fa fa-search" style="font-size:20px;"></i>
          <span>{{ isZh ? '无匹配会话' : 'No matching sessions' }}</span>
        </div>
        <div
          v-for="s in visibleSessions"
          :key="s.id"
          class="slp-nav-item"
          :class="{ active: s.id === sessionId }"
          :title="rowTitle(s)"
          @click="selectSession(s.id)"
        >
          <i v-if="hasContentHit(s.id) && !isIdMatch(s.id)" class="slp-content-dot" :title="isZh ? '命中聊天内容' : 'Matched in chat'"></i>
          <span class="slp-nav-name">{{ shortId(s.id) }}</span>
          <span class="slp-nav-meta" :title="isZh ? s.events + ' 事件' : s.events + ' events'">{{ s.events }} {{ isZh ? '事件' : 'ev' }}</span>
          <span class="slp-nav-time" :title="fullTime(s.lastTs)">{{ shortTime(s.lastTs) }}</span>
        </div>
        <div v-if="filteredSessions.length > visibleSessions.length" class="slp-nav-more">
          <i class="fa fa-chevron-down"></i>
          {{ isZh ? '下滑加载更多会话' : 'scroll for more sessions' }}
        </div>
      </div>
    </div>

    <!-- ====== 右侧：详情 ====== -->
    <div class="slp-main">
      <!-- Tab 栏 -->
      <div class="slp-tabs">
        <button v-for="t in tabs" :key="t.value" class="slp-tab" :class="{ active: tab === t.value }" @click="onTab(t.value)">
          {{ t.label }}
        </button>
        <span v-if="tab === 'events'" class="slp-count">{{ events.length }} {{ isZh ? '事件' : 'ev' }}</span>
        <span v-else-if="tab === 'derive'" class="slp-count">{{ messages.length }} {{ isZh ? '消息' : 'msg' }}</span>
      </div>

      <!-- 内容滚动区（共享，@scroll 按当前 tab 触发“加载更多”） -->
      <div ref="bodyEl" class="slp-body scoll" @scroll="onBodyScroll">
        <!-- ====== 事件流（最新在上，下滑加载更早） ====== -->
        <div v-if="tab === 'events'" class="slp-events">
          <div v-if="!sessionId" class="slp-empty">
            <i class="fa fa-hand-pointer-o" style="font-size:26px;"></i>
            <span>{{ isZh ? '从左侧选择一个会话查看事件日志' : 'Select a session on the left' }}</span>
          </div>
          <template v-else>
            <div class="slp-events-meta">
              <span class="slp-events-id" :title="sessionId"><i class="fa fa-hashtag"></i> {{ shortId(sessionId) }}</span>
              <span class="slp-events-note">
                <i class="fa" :class="loadingEvents && !events.length ? 'fa-spinner fa-spin' : 'fa-arrow-down'"></i>
                <template v-if="!events.length && loadingEvents">{{ isZh ? '加载最近事件…' : 'Loading…' }}</template>
                <template v-else-if="events.length && hasMoreEvents">{{ isZh ? '最新在上 · 下滑加载更早' : 'newest on top · scroll for older' }}</template>
                <template v-else-if="events.length">{{ isZh ? '已加载全部事件' : 'all events loaded' }}</template>
              </span>
            </div>
            <div v-if="!events.length && !loadingEvents" class="slp-empty">
              <i class="fa fa-list-alt" style="font-size:22px;"></i>
              <span>{{ isZh ? '该会话无事件' : 'No events in this session' }}</span>
            </div>
            <div v-for="ev in displayEvents" :key="ev.seq" class="slp-event" :class="'slp-event-' + (ev.type || '').replace('/', '-')">
              <div class="slp-event-head" @click="toggleEvent(ev.seq)">
                <span class="slp-seq">{{ ev.seq }}</span>
                <span class="slp-type">{{ ev.type }}</span>
                <span class="slp-time">{{ time(ev.ts) }}</span>
                <i class="fa fa-chevron-down slp-toggle" :class="{ open: !!openEvents[ev.seq] }"></i>
              </div>
              <div v-if="openEvents[ev.seq]" class="slp-event-body">
                <pre>{{ pretty(payloadOf(ev)) }}</pre>
              </div>
            </div>
            <!-- 底部加载状态 -->
            <div class="slp-more" v-if="events.length">
              <i v-if="loadingEvents" class="fa fa-spinner fa-spin"></i>
              <template v-if="loadingEvents">{{ isZh ? '加载更早…' : 'Loading older…' }}</template>
              <template v-else-if="hasMoreEvents">{{ isZh ? '下滑加载更早记录 ↓' : 'scroll down for older ↓' }}</template>
              <template v-else>{{ isZh ? '— 已到最早记录 —' : '— oldest reached —' }}</template>
            </div>
          </template>
        </div>

        <!-- ====== 派生消息（按对话顺序，长会话分段渲染） ====== -->
        <div v-else-if="tab === 'derive'" class="slp-derive">
          <div v-if="!sessionId" class="slp-empty">
            <i class="fa fa-hand-pointer-o" style="font-size:26px;"></i>
            <span>{{ isZh ? '从左侧选择一个会话查看派生消息' : 'Select a session on the left' }}</span>
          </div>
          <template v-else>
            <div v-if="!msgLoaded && !msgLoading" class="slp-empty">
              <button class="slp-btn" @click="ensureMessages">{{ isZh ? '加载派生消息' : 'Load derived messages' }}</button>
            </div>
            <div v-if="msgLoading && !msgLoaded" class="slp-empty">
              <i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>
              <span>{{ isZh ? '加载中…' : 'Loading…' }}</span>
            </div>
            <template v-if="msgLoaded">
              <div v-if="!visibleMessages.length" class="slp-empty">{{ isZh ? '无派生消息' : 'No derived messages' }}</div>
              <div v-for="(m, i) in visibleMessages" :key="i" class="slp-msg" :class="'slp-msg-' + m.role">
                <div class="slp-msg-head">
                  <span class="slp-msg-role">{{ m.role }}</span>
                  <span v-if="m.name" class="slp-msg-name">{{ m.name }}</span>
                </div>
                <pre class="slp-msg-content">{{ m.content || (m.role === 'tool' ? '[tool result]' : '') }}</pre>
                <div v-if="m.toolCalls?.length" class="slp-msg-tools">
                  <div v-for="(tc, j) in m.toolCalls" :key="j" class="slp-toolcall">{{ tc.name }}</div>
                </div>
              </div>
              <div class="slp-more">
                <span v-if="msgRenderLimit < messages.length">{{ isZh ? '下滑加载更多消息 ↓' : 'scroll down for more ↓' }}</span>
                <span v-else>{{ isZh ? `— 已显示全部 ${messages.length} 条消息 —` : `— all ${messages.length} messages —` }}</span>
              </div>
            </template>
          </template>
        </div>

        <!-- ====== 完整性 ====== -->
        <div v-else class="slp-integrity">
          <div v-if="!sessionId" class="slp-empty">
            <i class="fa fa-hand-pointer-o" style="font-size:26px;"></i>
            <span>{{ isZh ? '从左侧选择一个会话检查完整性' : 'Select a session on the left' }}</span>
          </div>
          <template v-else>
            <div v-if="!integrity && !integrityLoading" class="slp-empty">
              <span>{{ isZh ? '点击加载后查看完整性' : 'Load to check integrity' }}</span>
            </div>
            <div v-if="integrityLoading && !integrity" class="slp-empty">
              <i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>
              <span>{{ isZh ? '校验中…' : 'Checking…' }}</span>
            </div>
            <template v-if="integrity">
              <div class="slp-integrity-badge" :class="integrity.ok ? 'ok' : 'bad'">
                <i class="fa" :class="integrity.ok ? 'fa-check-circle' : 'fa-times-circle'"></i>
                {{ integrity.ok ? (isZh ? '日志自洽（seq 连续）' : 'Log consistent (seq contiguous)') : (isZh ? '日志损坏' : 'Log corrupted') }}
              </div>
              <div v-if="integrity.violation" class="slp-integrity-violation">{{ integrity.violation }}</div>
              <div class="slp-integrity-seq">{{ isZh ? '事件数' : 'Events' }}: {{ integrity.seq }}</div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { usestore } from '@/store'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { SessionEvent, DerivedMessage, SessionLogIntegrity } from '@/types/session-log'

const props = defineProps<{ sessionId?: string; hideHeader?: boolean }>()

const store = usestore()
const isZh = computed(() => store.locales !== 'en')

type LogTab = 'events' | 'derive' | 'integrity'

/** 事件流每次分页大小（首屏 = 最近的 N 条；之后下滑取更早 N 条） */
const PAGE_EVENTS = 400
/** 派生消息客户端分段渲染步长 */
const RENDER_MSG_STEP = 200
/** 会话列表（左导航）分段渲染步长：会话很多时滚动到底再继续渲染 */
const SESSION_RENDER_STEP = 100

const sessionId = ref(props.sessionId || '')
const sessions = ref<Array<{ id: string; events: number; lastTs: number }>>([])
const keyword = ref('')
const listLoading = ref(false)
/** 左导航会话列表分段渲染：当前最多显示的条数 */
const sessionRenderLimit = ref(SESSION_RENDER_STEP)
/** 内容搜索：命中聊天记录（user/assistant 正文）的会话 id → 命中片段 */
const contentHits = ref<Record<string, string>>({})
const contentSearching = ref(false)
/** 清理范围：全部 / 一天以前 / 一周以前 / 一个月以前 */
type ClearRangeKey = 'all' | '1d' | '1w' | '1m'
const clearRange = ref<ClearRangeKey>('all')

// ---- 事件流（分段加载：已加载部分按 seq 升序存，展示时反转=最新在上） ----
const events = ref<SessionEvent[]>([])
const hasMoreEvents = ref(true)
const loadingEvents = ref(false)

// ---- 派生消息（懒加载 + 客户端分段渲染） ----
const messages = ref<DerivedMessage[]>([])
const msgLoaded = ref(false)
const msgLoading = ref(false)
const msgRenderLimit = ref(0)

// ---- 完整性（懒加载） ----
const integrity = ref<SessionLogIntegrity | null>(null)
const integrityLoading = ref(false)

const openEvents = ref<Record<number, boolean>>({})
const tab = ref<LogTab>('derive')
const bodyEl = ref<HTMLElement>()
const navListEl = ref<HTMLElement>()

/** 会话切换令牌：使切换前发出的过期异步返回失效 */
let loadToken = 0
/** 内容搜索防抖定时器与令牌：防止快速输入/切换时结果错乱 */
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchToken = 0

const tabs = computed<Array<{ value: LogTab; label: string }>>(() => [
  { value: 'derive', label: isZh.value ? '派生消息' : 'Derived' },
  { value: 'events', label: isZh.value ? '事件流' : 'Events' },
  { value: 'integrity', label: isZh.value ? '完整性' : 'Integrity' },
])

const filteredSessions = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return sessions.value
  // id 即时命中 + 聊天内容命中（异步填充 contentHits）取并集
  const matched = new Set<string>()
  for (const s of sessions.value) {
    if (s.id.toLowerCase().includes(kw) || shortId(s.id).toLowerCase().includes(kw)) matched.add(s.id)
  }
  for (const id of Object.keys(contentHits.value)) matched.add(id)
  return sessions.value.filter(s => matched.has(s.id))
})

/** 左导航可见会话（分段渲染：前 sessionRenderLimit 条） */
const visibleSessions = computed(() => filteredSessions.value.slice(0, sessionRenderLimit.value))

/** 展示用事件：最新在上（已加载部分反转） */
const displayEvents = computed(() => {
  const arr = events.value.slice()
  arr.reverse()
  return arr
})

/** 派生消息展示（前 msgRenderLimit 条） */
const visibleMessages = computed(() => messages.value.slice(0, msgRenderLimit.value))

// ---------------------------------------------------------------------------
// 时间 / 缩写 / 载荷工具
// ---------------------------------------------------------------------------

function time(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 侧栏用短时间：MM-DD HH:mm */
function shortTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 侧栏悬停完整时间：YYYY-MM-DD HH:mm:ss */
function fullTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 会话 id 缩写：保留前 8 位 + 后 4 位，便于识别又不占满一行 */
function shortId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

/** 该会话是否因 id 命中当前关键字 */
function isIdMatch(id: string): boolean {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return false
  return id.toLowerCase().includes(kw) || shortId(id).toLowerCase().includes(kw)
}

/** 该会话是否命中聊天内容（有内容片段） */
function hasContentHit(id: string): boolean {
  return !!contentHits.value[id]
}

/** 会话行悬停提示：命中内容时附带命中片段，便于定位 */
function rowTitle(s: { id: string }): string {
  const snippet = contentHits.value[s.id]
  if (snippet) {
    return `${s.id}\n${isZh.value ? '命中聊天内容' : 'Matched in chat'}: ${snippet}`
  }
  return s.id
}

function pretty(v: any): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function payloadOf(ev: SessionEvent): Record<string, unknown> {
  const { seq, ts, sessionId: _sid, type: _t, ...payload } = ev as any
  return payload
}

function toggleEvent(seq: number): void {
  openEvents.value[seq] = !openEvents.value[seq]
}

// ---------------------------------------------------------------------------
// 会话列表 / 加载
// ---------------------------------------------------------------------------

/** 刷新会话列表；无选中会话时自动选中最近一个 */
async function refreshSessions(): Promise<void> {
  if (!window.dsh?.sessionLog) return
  listLoading.value = true
  let list: Array<{ id: string; events: number; lastTs: number }> = []
  try {
    list = await window.dsh.sessionLog.list()
    sessions.value = list
    resetSessionRender()
  } catch (e: any) {
    console.error('[session-log-panel] 列出会话失败:', e)
    return
  } finally {
    listLoading.value = false
  }
  if (!sessionId.value && list.length) {
    await selectSession(list[0].id)
  }
}

async function selectSession(id: string): Promise<void> {
  sessionId.value = id
  await loadSession()
}

/** 重置单个会话内的各 tab 内容状态 */
function resetContent(): void {
  events.value = []
  hasMoreEvents.value = true
  loadingEvents.value = false
  messages.value = []
  msgLoaded.value = false
  msgLoading.value = false
  msgRenderLimit.value = 0
  integrity.value = null
  integrityLoading.value = false
  openEvents.value = {}
}

/** 加载当前选中会话：重置并只加载当前 tab 所需数据 */
async function loadSession(): Promise<void> {
  const id = sessionId.value.trim()
  if (!id || !window.dsh?.sessionLog) return
  loadToken++
  resetContent()
  if (tab.value === 'events') await loadEventsPage(true)
  else if (tab.value === 'derive') ensureMessages()
  else ensureIntegrity()
  scrollTop()
}

/**
 * 分段加载事件流。
 * reset=true：取最近 PAGE_EVENTS 条；reset=false：取 seq < 已加载最旧的更早一页并前置。
 */
async function loadEventsPage(reset: boolean): Promise<void> {
  const id = sessionId.value.trim()
  if (!id || !window.dsh?.sessionLog) return
  if (loadingEvents.value) return
  if (!reset && !hasMoreEvents.value) return
  const token = loadToken
  loadingEvents.value = true
  try {
    const oldest = events.value.length ? events.value[0].seq : 0
    const page = await window.dsh.sessionLog.events(id, {
      limit: PAGE_EVENTS,
      beforeSeq: reset ? undefined : oldest > 0 ? oldest : undefined,
    })
    if (token !== loadToken) return // 已切换会话
    events.value = reset ? page : [...page, ...events.value]
    // 首页/更早页不足 PAGE 条，或已回卷到 seq=1，即说明没有更早记录了
    hasMoreEvents.value = page.length >= PAGE_EVENTS && page.length > 0 && page[0].seq > 1
  } catch (e: any) {
    console.error('[session-log-panel] 加载事件失败:', e)
    hasMoreEvents.value = false
  } finally {
    if (token === loadToken) loadingEvents.value = false
  }
}

/** 懒加载派生消息（一次取全量，渲染端分段展示） */
async function ensureMessages(): Promise<void> {
  const id = sessionId.value.trim()
  if (!id || !window.dsh?.sessionLog) return
  if (msgLoaded.value || msgLoading.value) return
  const token = loadToken
  msgLoading.value = true
  try {
    const msgs = await window.dsh.sessionLog.derive(id)
    if (token !== loadToken) return // 已切换会话
    messages.value = msgs
    msgLoaded.value = true
    msgRenderLimit.value = Math.min(RENDER_MSG_STEP, msgs.length)
  } catch (e: any) {
    console.error('[session-log-panel] 加载派生消息失败:', e)
  } finally {
    if (token === loadToken) msgLoading.value = false
  }
}

/** 懒加载完整性校验 */
async function ensureIntegrity(): Promise<void> {
  const id = sessionId.value.trim()
  if (!id || !window.dsh?.sessionLog) return
  if (integrity.value || integrityLoading.value) return
  const token = loadToken
  integrityLoading.value = true
  try {
    const res = await window.dsh.sessionLog.integrity(id)
    if (token === loadToken) integrity.value = res
  } catch (e: any) {
    console.error('[session-log-panel] 完整性校验失败:', e)
    if (token === loadToken) integrity.value = { ok: false, seq: 0, violation: e?.message || String(e) }
  } finally {
    if (token === loadToken) integrityLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 交互：Tab 切换 / 滚动加载更多 / 滚动复位 / 自动填满视口
// ---------------------------------------------------------------------------

function onTab(t: LogTab): void {
  if (tab.value === t) return
  tab.value = t
  scrollTop()
  const id = sessionId.value.trim()
  if (!id) return
  if (t === 'events') {
    if (!events.value.length && !loadingEvents.value) loadEventsPage(true)
  } else if (t === 'derive') {
    ensureMessages()
  } else {
    ensureIntegrity()
  }
}

/** 滚动到底（阈值内）时按当前 tab 加载更多 */
function onBodyScroll(): void {
  const el = bodyEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 120) return
  if (tab.value === 'events') {
    loadEventsPage(false)
  } else if (tab.value === 'derive' && msgLoaded.value && msgRenderLimit.value < messages.value.length) {
    msgRenderLimit.value += RENDER_MSG_STEP
  }
}

function scrollTop(): void {
  nextTick(() => {
    if (bodyEl.value) bodyEl.value.scrollTop = 0
  })
}

/** 派生消息若不足一屏（内容高度 < 容器高度），自动补足直到可滚动或显示完全部 */
watch(visibleMessages, async () => {
  if (tab.value !== 'derive') return
  await nextTick()
  const el = bodyEl.value
  if (el && el.scrollHeight <= el.clientHeight + 2 && msgRenderLimit.value < messages.value.length) {
    msgRenderLimit.value += RENDER_MSG_STEP
  }
})

/** 左导航滚动到底时继续渲染更多会话（会话很多时分段加载） */
function onNavScroll(): void {
  const el = navListEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
  if (sessionRenderLimit.value < filteredSessions.value.length) {
    sessionRenderLimit.value += SESSION_RENDER_STEP
  }
}

/** 会话列表刷新/清空后：回到顶部并重置分段起点，避免累积巨量 DOM */
function resetSessionRender(): void {
  sessionRenderLimit.value = SESSION_RENDER_STEP
  nextTick(() => {
    if (navListEl.value) navListEl.value.scrollTop = 0
  })
}

/** 会话列表不足一屏却仍有更多会话时自动补足 */
watch(visibleSessions, async () => {
  const el = navListEl.value
  if (!el) return
  await nextTick()
  if (el.scrollHeight <= el.clientHeight + 2 && sessionRenderLimit.value < filteredSessions.value.length) {
    sessionRenderLimit.value += SESSION_RENDER_STEP
  }
})

/** 关键字变化：防抖触发聊天内容检索；清空时丢弃结果与在途请求 */
watch(keyword, (kw) => {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }
  if (!kw.trim()) {
    searchToken++
    contentHits.value = {}
    contentSearching.value = false
    return
  }
  // 清掉旧关键字的内容命中，避免串味；id 命中即时由 filteredSessions 呈现
  contentHits.value = {}
  contentSearching.value = false
  searchTimer = setTimeout(() => {
    runContentSearch(kw.trim())
  }, 240)
})

/** 调用主进程全文检索（按 id 或聊天正文命中），填充 contentHits */
async function runContentSearch(kw: string): Promise<void> {
  if (!window.dsh?.sessionLog) return
  const token = ++searchToken
  contentSearching.value = true
  try {
    const res = await window.dsh.sessionLog.search(kw)
    if (token !== searchToken) return // 关键字已变化/清空，丢弃过期结果
    const map: Record<string, string> = {}
    for (const r of res || []) map[r.id] = r.snippet || ''
    contentHits.value = map
  } catch (e: any) {
    console.error('[session-log-panel] 内容搜索失败:', e)
  } finally {
    if (token === searchToken) contentSearching.value = false
  }
}

// ---------------------------------------------------------------------------
// 清空 / 刷新
// ---------------------------------------------------------------------------

/** 清空全部会话事件日志（由外层 ac-header 的清空按钮触发） */
async function clearAll(): Promise<void> {
  if (!window.dsh?.sessionLog) return
  try {
    await window.dsh.sessionLog.clearAll()
  } catch (e: any) {
    console.error('[session-log-panel] 清空失败:', e)
  }
  loadToken++
  resetContent()
  sessionId.value = ''
  keyword.value = ''
  sessions.value = []
  await refreshSessions()
}

/** 清理范围下拉选项 */
const clearRangeOptions = computed<Array<{ value: ClearRangeKey; label: string }>>(() => [
  { value: 'all', label: isZh.value ? '全部' : 'All' },
  { value: '1d', label: isZh.value ? '一天以前' : 'Older than 1 day' },
  { value: '1w', label: isZh.value ? '一周以前' : 'Older than 1 week' },
  { value: '1m', label: isZh.value ? '一个月以前' : 'Older than 1 month' },
])

/** 时间范围 → 截止时间戳（清理早于该值的会话；null = 全部） */
function cutoffOfRange(key: ClearRangeKey): number | null {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  switch (key) {
    case '1d': return now - DAY
    case '1w': return now - 7 * DAY
    case '1m': return now - 30 * DAY
    default: return null
  }
}

/** 自带头部清理按钮：按所选时间范围确认后清理（不可恢复） */
async function onClear(): Promise<void> {
  const cutoff = cutoffOfRange(clearRange.value)
  const count = cutoff == null
    ? sessions.value.length
    : sessions.value.filter(s => s.lastTs < cutoff).length
  if (!count) {
    ElMessage.info(isZh.value ? '没有符合该时间范围的会话可清理' : 'No sessions match this range')
    return
  }
  const rangeLabel = clearRangeOptions.value.find(o => o.value === clearRange.value)?.label || ''
  try {
    await ElMessageBox.confirm(
      isZh.value
        ? `确定清理“${rangeLabel}”的会话日志吗（共 ${count} 个）？该操作不可恢复。`
        : `Clear session logs "${rangeLabel}" (${count} sessions)? This cannot be undone.`,
      isZh.value ? '清理日志' : 'Clear Logs',
      { type: 'warning', confirmButtonText: isZh.value ? '清理' : 'Clear', cancelButtonText: isZh.value ? '取消' : 'Cancel' }
    )
  } catch { return }
  await clearByRange(cutoff)
}

/** 按范围清理并刷新列表；若当前会话被清掉则自动改选最近会话 */
async function clearByRange(cutoff: number | null): Promise<void> {
  if (!window.dsh?.sessionLog) return
  const prev = sessionId.value
  let removed = 0
  try {
    const res = await window.dsh.sessionLog.clearBefore(cutoff ?? 0)
    removed = res?.removed ?? 0
  } catch (e: any) {
    console.error('[session-log-panel] 清理失败:', e)
    ElMessage.error(isZh.value ? '清理失败' : 'Clear failed')
    return
  }
  loadToken++
  keyword.value = ''
  contentHits.value = {}
  contentSearching.value = false
  await refreshSessions()
  const keepCurrent = prev && sessions.value.some(s => s.id === prev)
  if (!keepCurrent) {
    sessionId.value = ''
    resetContent()
    if (sessions.value.length) await selectSession(sessions.value[0].id)
  }
  if (removed > 0) {
    ElMessage.success(isZh.value ? `已清理 ${removed} 个会话日志` : `Cleared ${removed} session logs`)
  }
}

/** 手动刷新：重取会话列表；保留当前选中并重载（拉到最新） */
async function onRefresh(): Promise<void> {
  if (!window.dsh?.sessionLog) return
  const prev = sessionId.value
  listLoading.value = true
  try {
    sessions.value = await window.dsh.sessionLog.list()
    resetSessionRender()
  } catch (e: any) {
    console.error('[session-log-panel] 刷新失败:', e)
    return
  } finally {
    listLoading.value = false
  }
  if (prev) {
    if (sessions.value.some(s => s.id === prev)) {
      await selectSession(prev)
    } else {
      sessionId.value = ''
      resetContent()
    }
  } else if (sessions.value.length) {
    await selectSession(sessions.value[0].id)
  }
}

/** 兼容旧调用：重载当前会话（等价于 loadSession） */
async function load(): Promise<void> {
  await loadSession()
}

onMounted(() => {
  refreshSessions()
  if (props.sessionId) loadSession()
})

// 供外层读取会话列表 / 切换会话 / 刷新 / 清空（外部 sessionId 注入时用）
defineExpose({ sessions, sessionId, refreshSessions, selectSession, load, clearAll })
</script>

<style scoped>
.session-log-panel {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
}

/* ========== 左侧：会话列表导航（参照 AgentPreset contact-sidebar） ========== */
.slp-nav {
  width: 210px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.slp-nav-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.slp-nav-title-row { display: flex; align-items: center; gap: 6px; }
.slp-nav-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slp-nav-title i { color: var(--fontActiveColor); margin-right: 3px; }
.slp-nav-count { font-size: 10px; opacity: .55; white-space: nowrap; }
.slp-nav-actions { margin-left: auto; display: flex; gap: 4px; flex-shrink: 0; }
/* 清理范围行：下拉 + 清理按钮 */
.slp-nav-clear-row { display: flex; align-items: center; gap: 4px; }
.slp-range-select {
  flex: 1; min-width: 0; height: 24px; margin: 0;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; padding: 0 4px;
}
.slp-clear-btn { flex-shrink: 0; gap: 3px; height: 24px; font-size: 11px; padding: 0 8px; }
.slp-nav-search {
  display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--borderColor); font-size: 12px;
}
.slp-nav-search > i { flex-shrink: 0; font-size: 12px; }
.slp-nav-search-input {
  flex: 1; min-width: 0;
  border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px; margin: 0; padding: 0;
}
.slp-nav-search-clear { flex-shrink: 0; cursor: pointer; font-size: 12px; color: var(--borderColor); }
.slp-nav-search-clear:hover { color: var(--fontActiveColor); }
.slp-nav-search-loading { flex-shrink: 0; font-size: 11px; color: var(--fontActiveColor); }
/* 仅内容命中（非 id 命中）时的蓝色小圆点标记 */
.slp-content-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #409eff; flex-shrink: 0;
}
.slp-nav-list { flex: 1; overflow-y: auto; padding: 2px; background-color: var(--backgroundColor); }
.slp-nav-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; margin-bottom: 1px; border-radius: 3px; cursor: pointer;
  border: 1px solid transparent; transition: all .12s;
}
.slp-nav-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.slp-nav-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  border-color: var(--fontActiveColor);
}
/* 单行布局：标题可截断；右侧依次为事件计数 + 时间 */
.slp-nav-name {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.slp-nav-meta {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  opacity: .6;
  white-space: nowrap;
}
.slp-nav-time {
  flex-shrink: 0;
  margin-left: 6px;
  font-size: 10px;
  opacity: .6;
  white-space: nowrap;
  color: var(--fontColor);
}
.slp-nav-more {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  color: #888; font-size: 11px; padding: 6px 0;
}
.slp-nav-more i { font-size: 9px; }

/* ========== 右侧：详情 ========== */
.slp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }

/* Tab 栏 */
.slp-tabs {
  display: flex; gap: 4px; align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.slp-tab {
  border: 1px solid transparent; background: transparent;
  color: var(--fontColor); border-radius: 4px;
  padding: 3px 12px; cursor: pointer; font-size: 12px;
  transition: all .12s;
}
.slp-tab:hover { background: color-mix(in srgb, var(--fontColor) 8%, transparent); }
.slp-tab.active { background: #409eff; color: #fff; }
.slp-count { margin-left: auto; color: #888; font-size: 11px; white-space: nowrap; }

.slp-body { flex: 1; overflow-y: auto; padding: 6px 10px 10px; min-height: 0; }

/* 事件流头部说明条 */
.slp-events-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 2px 2px 6px;
  border-bottom: 1px dashed var(--borderColor);
  margin-bottom: 6px;
}
.slp-events-id { font-family: monospace; font-size: 11px; color: var(--fontActiveColor); }
.slp-events-id i { font-size: 10px; margin-right: 2px; }
.slp-events-note { margin-left: auto; font-size: 11px; color: #888; display: inline-flex; align-items: center; gap: 4px; }

/* 底部加载更多 / 结束提示 */
.slp-more {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  color: #888; font-size: 11px; padding: 8px 0 4px; text-align: center;
}

/* ====== 通用控件 ====== */
.slp-btn {
  border: 1px solid var(--borderColor); background: transparent; color: var(--fontColor);
  border-radius: 4px; padding: 4px 7px; cursor: pointer; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
}
.slp-btn:hover { background: var(--menuActiveColor); }
.slp-btn-danger { color: #e74c3c; border-color: rgba(231, 76, 60, 0.55); }
.slp-btn-danger:hover { background: rgba(231, 76, 60, 0.12); border-color: #e74c3c; }

.slp-empty {
  color: #888; text-align: center; padding: 24px 10px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
}

/* ====== 事件条目 ====== */
.slp-event { border: 1px solid var(--borderColor); border-radius: 4px; margin-bottom: 3px; overflow: hidden; }
.slp-event-head { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: pointer; }
.slp-event-head:hover { background: color-mix(in srgb, var(--fontColor) 5%, transparent); }
.slp-seq { color: #888; font-family: monospace; font-size: 11px; }
.slp-type { font-weight: 600; font-family: monospace; }
.slp-event-user-message .slp-type { color: #0958d9; }
.slp-event-assistant-message .slp-type { color: #389e0d; }
.slp-event-tool-call .slp-type { color: #d46b08; }
.slp-event-tool-result .slp-type { color: #722ed1; }
.slp-event-session-start .slp-type, .slp-event-session-end .slp-type { color: #888; }
.slp-time { margin-left: auto; color: #888; font-size: 11px; }
.slp-toggle { font-size: 10px; color: #888; transition: transform .15s; }
.slp-toggle.open { transform: rotate(180deg); }
.slp-event-body { border-top: 1px dashed var(--borderColor); padding: 6px 8px; background: var(--menuColor); }
.slp-event-body pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; font-family: monospace; }

/* ====== 派生消息 ====== */
.slp-msg { border-left: 3px solid #888; margin-bottom: 6px; padding: 4px 8px; background: var(--menuColor); border-radius: 4px; }
.slp-msg-user { border-color: #0958d9; }
.slp-msg-assistant { border-color: #389e0d; }
.slp-msg-tool { border-color: #722ed1; }
.slp-msg-system { border-color: #888; }
.slp-msg-head { display: flex; gap: 8px; align-items: center; }
.slp-msg-role { font-weight: 600; text-transform: uppercase; font-size: 11px; }
.slp-msg-name { color: #722ed1; font-size: 11px; }
.slp-msg-content { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; }
.slp-msg-tools { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.slp-toolcall { font-size: 10px; background: #722ed1; color: #fff; border-radius: 8px; padding: 0 6px; }

/* ====== 完整性 ====== */
.slp-integrity { padding: 10px; }
.slp-integrity-badge { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; }
.slp-integrity-badge.ok { color: #389e0d; }
.slp-integrity-badge.bad { color: #cf1322; }
.slp-integrity-violation { color: #cf1322; margin-top: 8px; font-family: monospace; font-size: 12px; }
.slp-integrity-seq { color: #888; margin-top: 8px; }
</style>
