<template>
  <div class="swarm-team">
    <!-- 顶部：聊天名称（由 chat-header 合并进来）+ 工作台页签 -->
    <div class="st-head">
      <div class="st-title">
        <slot name="head-left">
          <i class="fa fa-users"></i>
          <span>{{ zh ? '项目组' : 'Team' }}</span>
          <span v-if="board" class="st-sub">
            {{ board.members.length }} {{ zh ? '名成员' : 'members' }} · {{ episodeLabel }}
          </span>
        </slot>
      </div>
      <!-- 回合切换器：回合结束后任务过程仍在（归档进历史），这里可以切回去回看 -->
      <select
        v-if="episodes.length > 1"
        v-model="selectedEpisodeId"
        class="st-ep-select"
        :title="zh ? '切换查看各回合的任务过程（历史回合只读）' : 'Review the task board of a previous episode (read-only)'"
      >
        <option v-for="e in episodes" :key="e.id" :value="e.live ? '' : e.id">{{ episodeOptionLabel(e) }}</option>
      </select>
      <div class="st-tabs">
        <button class="st-btn" :class="{ active: tab === 'msg' }" @click="setTab('msg')">
          {{ zh ? '消息' : 'Messages' }}
        </button>
        <button class="st-btn" :class="{ active: tab === 'lane' }" @click="setTab('lane')">
          {{ zh ? '泳道' : 'Flow' }}
        </button>
        <button class="st-btn" :class="{ active: tab === 'roster' }" @click="setTab('roster')">
          {{ zh ? '名册' : 'Roster' }}
        </button>
        <button class="st-btn" :class="{ active: tab === 'tasks' }" @click="setTab('tasks')">
          {{ zh ? '任务' : 'Tasks' }}
        </button>
        <button class="st-btn" :class="{ active: tab === 'comm' }" @click="setTab('comm')">
          {{ zh ? '通信' : 'Comm' }}
        </button>
        <!-- 扩展页签（插件经 swarm.workbench.tab 槽位追加；内置 5 个页签保持不变） -->
        <button
          v-for="t in extraTabs"
          :key="t.key"
          class="st-btn"
          :class="{ active: tab === t.key }"
          @click="setTab(t.key)"
        >
          {{ zh ? t.titleZh : t.titleEn }}
        </button>
      </div>
    </div>

    <div class="st-body-row">
      <!-- 消息流（独立 UI；底部发送栏复用聊天输入框） -->
      <div v-show="tab === 'msg'" ref="streamEl" class="st-stream scoll">
        <div v-if="!visibleMessages.length" class="st-empty">
          {{ zh ? '在下方输入框描述你想完成的目标：Lead 会把它拆成任务并按依赖分派给成员，成员之间也会互相沟通协作——这里实时显示大家的进展与产出。' : 'Describe the goal you want done in the input box below: the Lead splits it into tasks and assigns them to members by dependency, and members also message each other. Progress and outputs show up here live.' }}
        </div>
        <template v-for="(m, i) in visibleMessages" :key="i">
          <!-- 协议事件细条（折叠展示） -->
          <div v-if="m.swarmProtocol" class="st-proto-row">
            <span class="st-proto">{{ m.swarmProtocol.text }}</span>
          </div>
          <!-- 通信条 -->
          <div v-else-if="m.swarmComm" class="st-comm-row">
            <i class="fa fa-exchange"></i>
            <span class="st-comm-to">{{ m.swarmComm.to }}</span>
            <span class="st-comm-kind">{{ m.swarmComm.kind }}</span>
            <span class="st-comm-text">{{ m.swarmComm.summary }}</span>
          </div>
          <!-- 产出物卡片（post_artifact） -->
          <div v-else-if="m.swarmArtifact" class="st-artifact-row">
            <div class="st-artifact">
              <i class="fa fa-file-text-o"></i>
              <div class="st-artifact-main">
                <div class="st-artifact-name">{{ m.swarmArtifact.name }}</div>
                <div class="st-artifact-path" :title="m.swarmArtifact.path">{{ m.swarmArtifact.path }}</div>
              </div>
              <span class="st-artifact-size">{{ Math.max(1, Math.round(m.swarmArtifact.bytes / 1024)) }}KB</span>
              <button class="st-btn" @click="openArtifact(m.swarmArtifact.path)">{{ zh ? '打开' : 'Open' }}</button>
            </div>
          </div>
          <!-- 普通消息 -->
          <div
            v-else
            class="st-row"
            :class="{ user: m.role === 'user', active: !!m.swarmAgent?.taskId && activeTaskId === m.swarmAgent.taskId }"
            :data-task-id="m.swarmAgent?.taskId || null"
          >
            <div class="st-msg">
              <div class="st-who">
                {{ who(m) }}
                <span
                  v-if="m.swarmAgent?.taskId"
                  class="st-task-tag"
                  :title="zh ? '在任务板中定位' : 'Locate in task board'"
                  @click="focusTaskInBoard(m.swarmAgent.taskId)"
                >{{ m.swarmAgent.taskId }}</span>
              </div>
              <div class="st-text md" v-html="mdHtml(m.content)"></div>
            </div>
          </div>
        </template>
      </div>

      <!-- 工作台（泳道 / 名册 / 任务 / 通信）——与「消息」并列，全宽显示 -->
      <div v-show="tab !== 'msg'" ref="panelEl" class="st-panel scoll">
        <!-- 回看历史回合：数据来自归档快照，只读 -->
        <div v-if="!isLiveBoard" class="st-review-bar">
          <i class="fa fa-history"></i>
          {{ zh ? '正在回看历史回合（只读）：任务板 / 泳道 / 通信 / 产出物都保留在这一回合里，可在顶部切换回当前回合。' : 'Reviewing a previous episode (read-only). Switch back with the selector above.' }}
        </div>
        <!-- 泳道：任务依赖关系 + 智能体状态（借鉴 cc-haha 工作台） -->
        <template v-if="tab === 'lane'">
          <div v-if="!laneLayout" class="st-empty">
            {{ isLiveBoard
              ? (zh ? 'Lead 拆解出任务后，这里会显示依赖泳道与成员状态。' : 'Task lanes appear once the Lead creates tasks.')
              : (zh ? '这一回合没有任务记录。' : 'No tasks recorded in this episode.') }}
          </div>
          <div v-else class="lane-wrap" :style="{ width: laneLayout.width + 'px', height: laneLayout.height + 'px' }">
            <svg class="lane-edges" :width="laneLayout.width" :height="laneLayout.height">
              <defs>
                <marker id="lane-arrow" markerWidth="9" markerHeight="9" refX="9" refY="4.5" orient="auto">
                  <path d="M0,0 L9,4.5 L0,9 z" fill="currentColor" />
                </marker>
              </defs>
              <path v-for="e in laneLayout.edges" :key="e.id" :d="e.d" class="lane-edge" marker-end="url(#lane-arrow)" />
            </svg>
            <!-- 列头：成员名称 / 状态（两行） -->
            <div
              v-for="c in laneLayout.cols"
              :key="'ch' + c.idx"
              class="lane-col-head"
              :style="{ left: c.x + 'px', width: laneLayout.colW + 'px' }"
            >
              <div class="lane-col-name">{{ c.name }}</div>
              <div class="lane-col-status">
                <span class="st-dot" :class="c.status"></span>{{ c.status }}
                <span v-if="isStuck(c)" class="st-stuck">⚠</span>
              </div>
            </div>
            <div
              v-for="c in laneLayout.cols"
              :key="'cs' + c.idx"
              class="lane-col-sep"
              :style="{ left: c.x + 'px', top: LANE_HEADER_H + 'px', height: (laneLayout.height - LANE_HEADER_H) + 'px' }"
            ></div>
            <!-- 行头：依赖层级 -->
            <div
              v-for="L in laneLayout.layers"
              :key="'l' + L.d"
              class="lane-layer-label"
              :style="{ top: L.y + 'px', height: L.h + 'px' }"
            >
              {{ zh ? '第 ' + (L.d + 1) + ' 层' : 'L' + (L.d + 1) }}
            </div>
            <div
              v-for="b in laneLayout.blocks"
              :key="b.id"
              class="lane-block st-clickable"
              :class="[b.status, { active: activeTaskId === b.id }]"
              :style="{ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' }"
              :title="b.title"
              @click="focusTask(b.id)"
            >
              <span class="lane-block-title">{{ b.id }} · {{ b.title }}</span>
            </div>
          </div>
        </template>

        <!-- 名册 -->
        <template v-else-if="tab === 'roster'">
          <div v-for="mm in board?.members || []" :key="mm.idx" class="st-card">
            <div class="st-card-head">
              <span class="st-dot" :class="mm.status"></span>
              <span class="st-card-name">{{ mm.name }}</span>
              <span class="st-card-tag">{{ mm.status }}</span>
            </div>
            <div class="st-card-sub">{{ mm.role || '—' }}{{ mm.model ? ' · ' + mm.model : '' }}</div>
            <div v-if="mm.currentTaskId" class="st-card-sub">
              ▶ {{ taskTitle(mm.currentTaskId) }}
            </div>
            <div class="st-card-sub">
              <span v-if="mm.tokensTotal">{{ Math.round(mm.tokensTotal / 1000) }}k tokens</span>
              <span v-if="mm.toolCount"> · {{ zh ? '工具' : 'tools' }} {{ mm.toolCount }}</span>
              <span v-if="mm.lastActiveAt"> · {{ relTime(mm.lastActiveAt) }}</span>
            </div>
            <div v-if="isStuck(mm)" class="st-stuck-chip">
              ⚠ {{ zh ? '超过 90 秒无新活动，可能在等依赖或卡住' : 'No activity for >90s — possibly stuck' }}
            </div>
            <div v-if="mm.recentTools?.length" class="st-card-sub">
              {{ zh ? '最近' : 'recent' }}: {{ mm.recentTools.join(' · ') }}
            </div>
          </div>
        </template>

        <!-- 任务板 -->
        <template v-else-if="tab === 'tasks'">
          <div class="st-toolbar">
            <span class="st-tool-label">{{ zh ? '并发' : 'Concurrency' }}</span>
            <select
              v-model.number="maxInflight"
              class="st-select"
              :title="zh ? '一次同时派发几个任务（1~8）' : 'How many tasks to dispatch at once (1-8)'"
            >
              <option v-for="n in 8" :key="n" :value="n">{{ n }}</option>
            </select>
            <button v-if="!swarmRunning && unfinishedCount > 0" class="st-btn" @click="onResume">
              {{ zh ? `继续未完成任务（${unfinishedCount}）` : `Resume unfinished (${unfinishedCount})` }}
            </button>
          </div>
          <div v-if="!(board?.tasks || []).length" class="st-empty">{{ zh ? '暂无任务' : 'No tasks' }}</div>
          <div
            v-for="t in board?.tasks || []"
            :key="t.id"
            class="st-card st-clickable"
            :class="{ active: activeTaskId === t.id }"
            :title="zh ? '点击定位该任务的消息' : 'Click to locate its messages'"
            @click="focusTask(t.id)"
          >
            <div class="st-card-head">
              <span class="st-badge" :class="t.status">{{ t.status }}</span>
              <span
                v-if="t.assignee !== undefined"
                class="st-avatar"
                :style="{ background: memberColor(t.assignee) }"
              >{{ (board?.members[t.assignee]?.name || '?').slice(0, 1) }}</span>
              <span class="st-card-name">{{ t.id }} · {{ t.title }}</span>
              <span v-if="t.background" class="st-card-tag">{{ zh ? '后台' : 'bg' }}</span>
            </div>
            <div class="st-card-sub">
              {{ t.assignee !== undefined ? (board?.members[t.assignee]?.name || '#' + t.assignee) : (zh ? '待认领' : 'unassigned') }}
              <span v-if="t.deps.length"> · ← {{ t.deps.join(',') }}</span>
            </div>
            <div v-if="t.output" class="st-card-out">{{ t.output.slice(0, 200) }}</div>
            <div v-if="artifactsOf(t.id).length" class="st-art-chips">
              <span
                v-for="a in artifactsOf(t.id)"
                :key="a.path"
                class="st-art-chip"
                :title="a.path"
                @click.stop="openArtifact(a.path)"
              >📎 {{ a.name }}</span>
            </div>
          </div>
        </template>

        <!-- 通信流 -->
        <template v-else-if="tab === 'comm'">
          <div v-if="commGraph" class="comm-graph">
            <svg :width="commGraph.width" :height="commGraph.height">
              <defs>
                <marker id="comm-arrow" markerWidth="9" markerHeight="9" refX="9" refY="4.5" orient="auto">
                  <path d="M0,0 L9,4.5 L0,9 z" fill="currentColor" />
                </marker>
              </defs>
              <path
                v-for="e in commGraph.edges"
                :key="e.id"
                :d="e.d"
                class="comm-edge"
                marker-end="url(#comm-arrow)"
              />
              <text v-for="e in commGraph.edges" :key="'l' + e.id" :x="e.mx" :y="e.my" class="comm-edge-label" text-anchor="middle">
                {{ e.count }}
              </text>
              <g v-for="nd in commGraph.nodes" :key="nd.key" class="comm-node">
                <circle :cx="nd.x" :cy="nd.y" r="5" />
                <text :x="nd.x" :y="nd.y + 18" text-anchor="middle" class="comm-node-label">{{ nd.label }}</text>
              </g>
            </svg>
            <div v-if="commGraph.broadcastCount" class="comm-broadcast">
              {{ zh ? `广播 ${commGraph.broadcastCount} 条` : `${commGraph.broadcastCount} broadcast(s)` }}
            </div>
          </div>
          <div v-if="!(board?.messages || []).length" class="st-empty">{{ zh ? '暂无通信' : 'No messages' }}</div>
          <div v-for="c in board?.messages || []" :key="c.id" class="st-card">
            <div class="st-card-head">
              <span class="st-card-name">{{ fromName(c.from) }} → {{ c.to === '*' ? (zh ? '全体' : 'all') : toName(c.to) }}</span>
              <span class="st-card-tag">{{ c.kind }}</span>
            </div>
            <div class="st-card-sub">{{ c.summary }}</div>
          </div>
        </template>

        <!-- 扩展页签（插件贡献；渲染在同一个工作台面板内） -->
        <template v-else-if="activeExtraTab">
          <PluginBoundary :label="activeExtraTab.titleZh || activeExtraTab.key">
            <template #default="{ attempt }">
              <component :is="activeExtraTab.component" :key="attempt" />
            </template>
          </PluginBoundary>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * SwarmTeamStream.vue — 项目组（Agent Teams）的**独立消息栏**
 *
 * - 只在 `swarmOptions.runMode === 'team'` 时由 home.vue 挂载；
 * - 消息流是 Agent Teams 协议事件的投影（协议细条 / 通信条 / 普通汇报）；
 * - 右侧工作台抽屉：名册 / 任务板 / 通信流；
 * - **底部发送栏复用 home.vue 的输入框**（本组件不接管输入）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import { running as swarmRunning } from '@/store/swarmState'
import { resumeSwarm } from '@/store/swarmRunner'
import { roomOf, ensureRoom, buildMembers, boardOf, episodeList, currentEpisodeId } from '@/store/swarmRoom'
import { deriveMembers } from '@/composables/swarm/useSwarmMembers'
import { workspaceRoot } from '@/lib/agent/promptContext'
import { renderMarkdown } from '@/lib/markdown/render'
import { ensureMermaidInit, getCachedSvg, renderMermaidSvg } from '@/lib/markdown/mermaid'
import { useAllSlotEntries } from '@/lib/plugin/useSlots'
import PluginBoundary from '@/components/plugin/PluginBoundary.vue'
import { SWARM_WORKBENCH_SLOT } from '@/lib/plugin/coreSlots'
import type { SwarmRoom } from '@/types/swarmRoom'

const props = defineProps<{ chat: any }>()
const store = usestore()
const zh = computed(() => store.locales !== 'en')

type LaneTab = 'msg' | 'lane' | 'roster' | 'tasks' | 'comm'
/** 消息与工作台（泳道/名册/任务/通信）是**并列标签**，一次只显示一个（全宽） */
const tab = ref<LaneTab | string>('msg')
const setTab = (t: string) => { tab.value = t }

/** 扩展页签（插件贡献；内置 5 个页签保持原实现不变） */
const extraTabs = useAllSlotEntries(SWARM_WORKBENCH_SLOT)
const activeExtraTab = computed(() => extraTabs.value.find((t) => t.key === tab.value))

const room = computed<SwarmRoom | null>(() => roomOf(props.chat?.id))
/**
 * 工作台当前展示的回合：
 *  - '' = 正在进行的那个回合（默认，可续跑）；
 *  - 其它 = 历史回合 id（只读回看任务过程）。
 * 回合结束后泳道不会被清掉（endEpisode 只标记状态），新回合开始时上一回合归档进 history，
 * 因此「跑完还能看过程」与「任务不跨回合累积」同时成立。
 */
const selectedEpisodeId = ref('')
const episodes = computed(() => episodeList(room.value))
const board = computed(() => boardOf(room.value, selectedEpisodeId.value))
/** true = 看的是当前回合（可续跑）；false = 历史回看（只读） */
const isLiveBoard = computed(() => board.value?.live !== false)
const streamEl = ref<HTMLElement | null>(null)

const visibleMessages = computed(() =>
  ((props.chat?.messages || []) as any[]).filter((m) => m.content || m.swarmProtocol || m.swarmComm || m.swarmArtifact),
)

const episodeLabel = computed(() => {
  const ep = board.value?.episode
  if (!ep) return zh.value ? '未开始' : 'idle'
  const base = ep.status === 'running'
    ? (zh.value ? '进行中' : 'running')
    : ep.status === 'done' ? (zh.value ? '已结束' : 'done') : (zh.value ? '已中断' : 'aborted')
  return board.value?.live ? base : `${zh.value ? '回看' : 'review'} · ${base}`
})

/** 回合切换器的一项文案（回看历史回合用） */
function episodeOptionLabel(e: { id: string; status: string; live: boolean; taskCount: number }): string {
  const n = String(e.id).replace(/^ep/, '') || '?'
  const st = e.status === 'running'
    ? (zh.value ? '进行中' : 'running')
    : e.status === 'done' ? (zh.value ? '已结束' : 'done') : (zh.value ? '已中断' : 'aborted')
  const tail = e.taskCount ? ` · ${e.taskCount}${zh.value ? ' 个任务' : ' tasks'}` : ''
  return `${zh.value ? '回合' : 'Episode'} ${n} · ${st}${tail}`
}

/** markdown 渲染（复用 home 的 renderMarkdown；按内容缓存，流式下命中率高） */
const mdCache = new Map<string, string>()
function mdHtml(src: string): string {
  const s = String(src || '')
  if (!s) return ''
  const hit = mdCache.get(s)
  if (hit !== undefined) return hit
  const html = renderMarkdown(s)
  if (mdCache.size > 400) mdCache.clear()
  mdCache.set(s, html)
  return html
}

/** 活动指标：相对时间（每 5 秒刷新一次）与「可能卡住」判定 */
const STUCK_MS = 90_000
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
function relTime(ts?: number): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now.value - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`
}
function isStuck(m: { status?: string; lastActiveAt?: number }): boolean {
  return m.status === 'running' && !!m.lastActiveAt && now.value - m.lastActiveAt > STUCK_MS
}

/** 断点续跑：未完成任务数 + 继续（只对「当前回合」成立；回看历史回合时不给续跑入口） */
const unfinishedCount = computed(() =>
  isLiveBoard.value
    ? (board.value?.tasks || []).filter((t) => t.status !== 'done' && t.status !== 'cancelled').length
    : 0,
)
const onResume = async (): Promise<void> => {
  if (!isLiveBoard.value) return
  await resumeSwarm(props.chat?.id)
}

/** 任务 ↔ 消息联动：点任务 → 跳消息页并高亮该任务气泡；点气泡任务标签 → 回任务页 */
const activeTaskId = ref<string | null>(null)
function scrollToTask(id: string): void {
  const root = streamEl.value
  if (!root) return
  const el = root.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('st-flash')
  setTimeout(() => el.classList.remove('st-flash'), 1400)
}
function focusTask(id: string): void {
  activeTaskId.value = id
  tab.value = 'msg'
  void nextTick(() => scrollToTask(id))
}
function focusTaskInBoard(id?: string): void {
  if (!id) return
  activeTaskId.value = id
  tab.value = 'tasks'
}

/** 并发闸门（一次派发多少任务；写入房间 + 随对话保存） */
const maxInflight = computed({
  get: () => room.value?.maxInflight ?? 3,
  set: (v: number) => {
    const n = Math.min(8, Math.max(1, Number(v) || 1))
    const r = room.value
    if (r) r.maxInflight = n
    if (props.chat) {
      props.chat.config.swarmOptions = { ...(props.chat.config.swarmOptions || {}), maxInflight: n }
    }
  },
})

/** 通信流：参与者之间的有向聚合（弧线 + 箭头，宽度随条数） */
const commGraph = computed(() => {
  const r = board.value
  if (!r || !r.messages.length) return null
  const nodes: Array<{ key: string; label: string; x: number; y: number }> = []
  const push = (key: string, label: string) => {
    if (!nodes.some((n) => n.key === key)) nodes.push({ key, label, x: 0, y: 0 })
  }
  push('user', zh.value ? '用户' : 'User')
  push('lead', 'Lead')
  r.members.forEach((m) => push(`m${m.idx}`, m.name))
  if (nodes.length < 2) return null

  const width = Math.max(380, panelW.value - 28)
  const nodeY = 96
  const gapX = width / nodes.length
  nodes.forEach((nd, i) => { nd.x = gapX * (i + 0.5); nd.y = nodeY })

  // 归一化端点：-1 与 'lead' 都是 Lead；成员为 m<idx>
  const norm = (v: any): string => {
    if (v === 'lead' || v === -1 || v === undefined || v === null) return 'lead'
    if (v === 'user') return 'user'
    if (v === '*') return '*'
    return `m${v}`
  }
  const agg = new Map<string, { from: string; to: string; count: number }>()
  for (const msg of r.messages) {
    const from = norm(msg.from)
    const to = norm(msg.to)
    const key = `${from}->${to}`
    const cur = agg.get(key) || { from, to, count: 0 }
    cur.count++
    agg.set(key, cur)
  }
  const posOf = (k: string) => nodes.find((nd) => nd.key === k)?.x ?? 0
  const edges = Array.from(agg.values())
    .filter((e) => e.to !== '*' && nodes.some((nd) => nd.key === e.from) && nodes.some((nd) => nd.key === e.to))
    .map((e) => {
      const x1 = posOf(e.from)
      const x2 = posOf(e.to)
      const lift = 26 + Math.min(56, e.count * 12)
      const cy = nodeY - lift
      return {
        id: `${e.from}->${e.to}`,
        d: `M${x1},${nodeY - 7} Q${(x1 + x2) / 2},${cy} ${x2},${nodeY - 7}`,
        count: e.count,
        mx: (x1 + x2) / 2,
        my: cy + 8,
      }
    })
  const broadcastCount = Array.from(agg.values()).filter((e) => e.to === '*').reduce((a, e) => a + e.count, 0)
  return { width, height: 132, nodes, edges, broadcastCount }
})

/** 产出物：按任务过滤 / 用应用内视图打开 */
function artifactsOf(taskId: string): Array<{ name: string; path: string; bytes: number }> {
  return (board.value?.artifacts || []).filter((a) => a.taskId === taskId)
}

/** 把产出物路径补成绝对路径（主进程给的本来就是绝对路径；这里只兜住相对路径的历史数据） */
function absoluteArtifactPath(p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p
  const root = workspaceRoot(store) || (store as any).roots?.[0] || ''
  if (!root) return p
  return `${String(root).replace(/[\\/]+$/, '')}/${p.replace(/^[\\/]+/, '')}`
}

/**
 * 打开产出物：打开失败 / 文件已被删掉时给出明确提示。
 * 以前这里 `catch {}` 把异常吞掉，用户看到的是「点了没反应」，无从判断原因。
 */
function openArtifact(path: string): void {
  if (!path) return
  const p = absoluteArtifactPath(String(path))
  const ext = p.slice(p.lastIndexOf('.'))
  try {
    store.openFileByMode({ path: p, type: 'file', extension: ext })
  } catch (e: any) {
    ElMessage.error(zh.value
      ? `打开失败：${e?.message || e}`
      : `Open failed: ${e?.message || e}`)
  }
}

/** 成员颜色（任务卡片头像点，与泳道/气泡无关，仅助于辨认） */
const MEMBER_COLORS = ['#2196f3', '#4caf50', '#ff9800', '#9c27b0', '#00bcd4', '#f44336', '#795548', '#607d8b']
function memberColor(idx?: number): string {
  if (idx === undefined || idx < 0) return '#9e9e9e'
  return MEMBER_COLORS[idx % MEMBER_COLORS.length]
}

/** 任务 id → 标题（名册「当前任务」用） */
function taskTitle(id?: string): string {
  if (!id) return ''
  return board.value?.tasks.find((t) => t.id === id)?.title || id
}

function who(m: any): string {
  if (m.role === 'user') return zh.value ? '我' : 'You'
  if (m.swarmAgent) return m.swarmAgent.idx >= 0 ? m.swarmAgent.name : 'Lead'
  return 'Lead'
}
function fromName(f: any): string {
  if (f === 'lead' || f === -1) return 'Lead'
  if (f === 'user') return zh.value ? '我' : 'You'
  return board.value?.members[f]?.name || `#${f}`
}
function toName(t: any): string {
  if (t === 'lead' || t === -1) return 'Lead'
  if (t === 'user') return zh.value ? '我' : 'You'
  return board.value?.members[t]?.name || `#${t}`
}

// ---------------------------------------------------------------------------
// 泳道布局（竖向）：列 = 成员（名称/状态两行），行 = 依赖层级（自上而下）
// ---------------------------------------------------------------------------
const LANE_LEFT_W = 48
const LANE_COL_W = 156
const LANE_COL_MIN = 104
const LANE_COL_MAX = 520
const LANE_BLOCK_H = 38
const LANE_V_GAP = 8
const LANE_HEADER_H = 46
/** 每层额外留白：层与层之间更疏朗，箭头也更清楚 */
const LANE_LAYER_PAD = 30

/** 面板宽度（泳道列宽据此自适应：成员少则拉伸，成员多则收窄） */
const panelW = ref(0)
const panelEl = ref<HTMLElement | null>(null)
let panelRO: ResizeObserver | null = null
function attachPanelRO(): void {
  panelRO?.disconnect()
  panelRO = null
  const el = panelEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  panelRO = new ResizeObserver(() => { panelW.value = el.clientWidth })
  panelRO.observe(el)
  panelW.value = el.clientWidth
}

const laneLayout = computed(() => {
  const r = board.value
  if (!r || !r.tasks.length) return null
  const tasks = r.tasks
  const byId = new Map(tasks.map((t) => [t.id, t]))

  // 依赖深度（最长路径）
  const depth = new Map<string, number>()
  const calc = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    seen.add(id)
    const t = byId.get(id)
    if (!t) return 0
    const d = t.deps.length ? 1 + Math.max(...t.deps.map((x) => calc(x, seen))) : 0
    depth.set(id, d)
    return d
  }
  tasks.forEach((t) => calc(t.id, new Set()))

  type Row = { idx: number; name: string; status: string; current?: string; lastActiveAt?: number; y: number; h: number }
  const rows: Row[] = r.members.map((m) => {
    const cur = r.tasks.find((t) => t.id === m.currentTaskId)
    return { idx: m.idx, name: m.name, status: m.status, current: cur ? cur.title : undefined, lastActiveAt: m.lastActiveAt, y: 0, h: 0 }
  })
  if (tasks.some((t) => t.assignee === undefined)) {
    rows.push({ idx: -1, name: zh.value ? '未指派' : 'Unassigned', status: 'idle', y: 0, h: 0 })
  }
  if (!rows.length) return null

  const depths = Array.from({ length: Math.max(...tasks.map((t) => depth.get(t.id) || 0)) + 1 }, (_, i) => i)

  // 列宽自适应：按面板可用宽度均分（成员少 → 拉伸；成员多 → 收窄）
  const avail = panelW.value - LANE_LEFT_W - 40
  const colW = Math.max(LANE_COL_MIN, Math.min(LANE_COL_MAX, avail > 0 ? avail / rows.length : LANE_COL_W))
  const blockW = Math.max(72, Math.min(colW - 20, 280))
  // 列 = 成员；行 = 依赖层级（自上而下）
  const cols = rows.map((r, i) => ({ ...r, x: LANE_LEFT_W + i * colW }))
  const counts = new Map<string, number>()
  for (const t of tasks) {
    const k = `${t.assignee ?? -1}|${depth.get(t.id) || 0}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  const layerH = depths.map(
    (d) => Math.max(1, ...cols.map((c) => counts.get(`${c.idx}|${d}`) || 0)) * (LANE_BLOCK_H + LANE_V_GAP) + LANE_V_GAP + LANE_LAYER_PAD,
  )
  const layers: Array<{ d: number; y: number; h: number }> = []
  let y = LANE_HEADER_H
  depths.forEach((d, i) => {
    layers.push({ d, y, h: layerH[i] })
    y += layerH[i]
  })
  const height = y + 4
  const width = LANE_LEFT_W + cols.length * colW + 8

  const used = new Map<string, number>()
  const pos = new Map<string, { x: number; y: number }>()
  const blocks = tasks.map((t) => {
    const key = `${t.assignee ?? -1}|${depth.get(t.id) || 0}`
    const n = used.get(key) || 0
    used.set(key, n + 1)
    const col = cols.find((c) => c.idx === (t.assignee ?? -1)) || cols[0]
    const bx = col.x + (colW - blockW) / 2
    const by = layers[depth.get(t.id) || 0].y + LANE_V_GAP + n * (LANE_BLOCK_H + LANE_V_GAP)
    pos.set(t.id, { x: bx, y: by })
    return { id: t.id, title: t.title, status: t.status, x: bx, y: by, w: blockW, h: LANE_BLOCK_H }
  })

  // 依赖箭头：直角走线（下行 → 横移 → 下行），比曲线更清晰
  const edges = tasks.flatMap((t) =>
    t.deps.flatMap((dep) => {
      const from = pos.get(dep)
      const to = pos.get(t.id)
      if (!from || !to) return []
      const x1 = from.x + blockW / 2
      const y1 = from.y + LANE_BLOCK_H
      const x2 = to.x + blockW / 2
      const y2 = to.y
      // 横向段放在层间偏上（至少留 14px 竖线给箭头，避免与箭头重叠）
      const runIn = 14
      const gap = Math.max(runIn + 6, y2 - y1)
      const my = Math.min(y1 + Math.round(gap / 2), y2 - runIn)
      const d = x1 === x2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`
      return [{ id: `${dep}->${t.id}`, d }]
    }),
  )

  return { width, height, colW, cols, layers, blocks, edges }
})

/** 名册跟随对话的成员预设（合并保留已有会话/状态）；进入项目组即可见工作台 */
function ensure(): void {
  const id = props.chat?.id
  if (!id) return
  const ids = ((props.chat?.config?.swarmPresetIds) || []) as string[]
  const { members } = deriveMembers(ids)
  const r = ensureRoom(id, buildMembers(members.map((m) => ({ name: m.name, role: m.role, model: m.model }))))
  // 并发闸门随对话恢复
  const saved = Number(props.chat?.config?.swarmOptions?.maxInflight)
  if (Number.isFinite(saved) && saved > 0) r.maxInflight = Math.min(8, Math.max(1, saved))
}

onMounted(() => {
  ensure()
  attachPanelRO()
  nowTimer = setInterval(() => { now.value = Date.now() }, 5000)
})
onBeforeUnmount(() => {
  panelRO?.disconnect()
  if (nowTimer) clearInterval(nowTimer)
})
watch(() => props.chat?.id, () => { selectedEpisodeId.value = ''; ensure() })
watch(() => ((props.chat?.config?.swarmPresetIds) || []).join('|'), ensure)
// 新回合开始（运行中会新开一个 episode）→ 自动切回「当前回合」，别停在上一回合的回看里
watch(() => currentEpisodeId(room.value), (id, prev) => { if (id && id !== prev) selectedEpisodeId.value = '' })
// 选中的历史回合若已不存在（例如被归档上限挤掉）→ 回到当前回合
watch(episodes, (list) => {
  if (selectedEpisodeId.value && !list.some((e) => e.id === selectedEpisodeId.value)) selectedEpisodeId.value = ''
})
// 切换页签后：重新测量宽度 + （回到消息页时）滚到底并补渲染 mermaid
watch(tab, () => {
  void nextTick(() => {
    attachPanelRO()
    if (tab.value === 'msg') { scrollBottom(); scheduleMermaid() }
  })
})

/** 滚到底 */
function scrollBottom(): void {
  if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight
}

/** mermaid：与 home 同一套工具（按内容哈希缓存），渲染流内的 .mermaid-wrapper */
let mermaidTimer: ReturnType<typeof setTimeout> | null = null
async function renderMermaidIn(): Promise<void> {
  const root = streamEl.value
  if (!root) return
  const wrappers = Array.from(root.querySelectorAll('.mermaid-wrapper')) as HTMLElement[]
  if (!wrappers.length) return
  ensureMermaidInit()
  for (const w of wrappers) {
    const src = w.querySelector('.mermaid-src')?.textContent || ''
    if (!src) continue
    try {
      w.innerHTML = getCachedSvg(src) || (await renderMermaidSvg(src))
    } catch { /* 渲染失败保留源码占位 */ }
  }
}
function scheduleMermaid(): void {
  if (mermaidTimer) clearTimeout(mermaidTimer)
  mermaidTimer = setTimeout(() => { void renderMermaidIn() }, 120)
}

// 消息变化（含流式长度变化）→ 滚到底 + 渲染 mermaid
watch(
  () => visibleMessages.value.map((m: any) => `${m.role}:${(m.content || '').length}`).join('|'),
  () => { scrollBottom(); scheduleMermaid() },
  { flush: 'post' },
)
</script>

<style scoped>
.swarm-team {
  display: flex;
  flex-direction: column;
  width: 100%;
  align-self: stretch;
  box-sizing: border-box;
  height: 100%;
  min-height: 100%;
  background: var(--backgroundColor);
}
.st-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与其它模式的 .chat-header 一致：等高（40px 内容 + 上下 1px 内边距 + 1px 下边框）、左右同为 5px 内边距 */
  min-height: 40px;
  box-sizing: content-box;
  padding: 1px 5px;
  border-bottom: 1px solid var(--borderColor);
  flex: 0 0 auto;
}
/* 左侧承载聊天列表开关 + 聊天标题（可伸缩），右侧页签固定不压缩 */
.st-title { display: flex; align-items: center; gap: 6px; font-size: 13px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.st-sub { font-size: 11px; opacity: 0.6; }
.st-tabs { display: flex; gap: 4px; flex: 0 0 auto; }
.st-btn {
  font-size: 12px;
  padding: 2px 8px;
  height: 22px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.st-btn.active { border-color: var(--menuActiveColor); color: var(--fontActiveColor); }

/* 回合切换器（回看历史回合的任务过程） */
.st-ep-select {
  flex: 0 0 auto;
  max-width: 200px;
  height: 22px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--borderColor);
  background: transparent;
  color: inherit;
}
/* 回看历史回合的只读提示条 */
.st-review-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--borderColor);
  border-left: 3px solid var(--menuActiveColor);
  border-radius: 4px;
  opacity: 0.85;
}

.st-body-row { position: relative; flex: 1 1 auto; min-height: 0; }
.st-stream { position: absolute; inset: 0; padding: 8px 14px; overflow: auto; }
.st-panel { position: absolute; inset: 0; padding: 10px 14px; overflow: auto; }
.st-empty { font-size: 12px; opacity: 0.55; padding: 12px 4px; }

.st-proto-row { display: flex; justify-content: center; margin: 6px 0; }
.st-proto {
  font-size: 11px;
  opacity: 0.6;
  padding: 2px 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 10px;
}
.st-comm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin: 4px 0;
  padding: 3px 8px;
  border-left: 2px solid var(--menuActiveColor);
  background: color-mix(in srgb, var(--menuActiveColor) 8%, transparent);
  border-radius: 3px;
}
.st-comm-to { font-weight: 600; }
.st-comm-kind { font-size: 10px; opacity: 0.65; }
.st-comm-text { opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.st-row { display: flex; margin: 6px 0; }
.st-row.user { justify-content: flex-end; }
.st-msg {
  max-width: 78%;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  padding: 6px 10px;
}
.st-row.user .st-msg { background: transparent; }
.st-who { font-size: 11px; opacity: 0.7; margin-bottom: 3px; }
.st-task-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 0 5px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  opacity: 0.8;
}
.st-text { font-size: 13px; word-break: break-word; }

/* 消息正文 markdown（复用 home 的 HTML，需要自己的样式） */
.st-text.md :deep(p) { margin: 4px 0; }
.st-text.md :deep(h1),
.st-text.md :deep(h2),
.st-text.md :deep(h3),
.st-text.md :deep(h4) { margin: 8px 0 4px; font-size: 14px; }
.st-text.md :deep(ul),
.st-text.md :deep(ol) { margin: 4px 0 4px 18px; padding-left: 0; }
.st-text.md :deep(li) { margin: 2px 0; }
.st-text.md :deep(pre) {
  margin: 6px 0;
  padding: 8px;
  border-radius: 6px;
  overflow: auto;
  background: rgba(127, 127, 127, 0.12);
  font-size: 12px;
}
.st-text.md :deep(code) { font-size: 12px; }
.st-text.md :deep(:not(pre) > code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.15);
}
.st-text.md :deep(table) { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
.st-text.md :deep(th),
.st-text.md :deep(td) { border: 1px solid var(--borderColor); padding: 3px 6px; }
.st-text.md :deep(blockquote) {
  margin: 6px 0;
  padding-left: 8px;
  border-left: 3px solid var(--borderColor);
  opacity: 0.85;
}
.st-text.md :deep(img) { max-width: 100%; }
.st-text.md :deep(a) { color: var(--menuActiveColor); }
.st-text.md :deep(hr) { border: none; border-top: 1px solid var(--borderColor); margin: 8px 0; }
.st-text.md :deep(.mermaid-wrapper) { margin: 6px 0; text-align: center; }
.st-text.md :deep(.mermaid-wrapper svg) { max-width: 100%; height: auto; }

.st-card {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
}
.st-card-head { display: flex; align-items: center; gap: 6px; }
.st-card-name { font-size: 12px; font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-card-tag { font-size: 10px; opacity: 0.65; }
.st-card-sub { font-size: 11px; opacity: 0.7; margin-top: 3px; }
.st-card-out { font-size: 11px; opacity: 0.8; margin-top: 4px; white-space: pre-wrap; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; background: #9e9e9e; flex: 0 0 auto; }
.st-dot.running { background: #2196f3; }
.st-dot.idle { background: #4caf50; }
.st-dot.blocked { background: #ff9800; }
.st-dot.stopped { background: #9e9e9e; }
.st-badge { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--borderColor); }
.st-badge.done { color: #4caf50; border-color: #4caf50; }
.st-badge.running { color: #2196f3; border-color: #2196f3; }
.st-badge.error { color: #f44336; border-color: #f44336; }
.st-badge.pending { opacity: 0.7; }
.st-badge.ready { color: #ff9800; border-color: #ff9800; }

/* 泳道（竖向）：列 = 成员（名称/状态两行），行 = 依赖层级 */
.lane-wrap { position: relative; margin: 0 auto; }
.lane-edges { position: absolute; left: 0; top: 0; color: color-mix(in srgb, var(--fontColor) 45%, transparent); pointer-events: none; }
.lane-edge { fill: none; stroke: currentColor; stroke-width: 1.6px; }
.lane-col-head {
  position: absolute;
  top: 0;
  height: 46px;
  box-sizing: border-box;
  padding: 4px 6px 0;
  text-align: center;
  border-bottom: 1px solid var(--borderColor);
  overflow: hidden;
}
.lane-col-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane-col-status {
  font-size: 11px;
  opacity: 0.75;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 3px;
}
.lane-col-sep { position: absolute; width: 0; border-left: 1px dashed var(--borderColor); opacity: 0.5; }
.lane-layer-label {
  position: absolute;
  left: 0;
  width: 48px;
  font-size: 11px;
  opacity: 0.6;
  padding-top: 6px;
  box-sizing: border-box;
}
.lane-block {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  display: flex;
  align-items: center;
  padding: 0 7px;
  font-size: 11px;
}
.lane-block.done { border-color: #4caf50; color: #4caf50; }
.lane-block.running { border-color: #2196f3; color: #2196f3; }
.lane-block.error { border-color: #f44336; color: #f44336; }
.lane-block.ready { border-color: #ff9800; color: #ff9800; }
.lane-block.pending { opacity: 0.6; }
.st-stuck-chip { font-size: 11px; margin-top: 3px; color: #ff9800; }
.st-stuck { color: #ff9800; }
/* 工具条（并发闸门 / 续跑）：单行、无下边距 */
.st-toolbar { display: flex; align-items: center; gap: 8px; }
.st-tool-label { font-size: 12px; opacity: 0.7; white-space: nowrap; }
.st-toolbar .st-btn { white-space: nowrap; }
.st-select {
  width: 56px;
  flex: 0 0 auto;
  height: 22px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--borderColor);
  background: transparent;
  color: inherit;
}
.st-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: #fff;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

/* 任务 ↔ 消息联动 */
.st-clickable { cursor: pointer; }
.st-card.active { border-color: var(--menuActiveColor); }
.lane-block.active { box-shadow: 0 0 0 2px var(--menuActiveColor); }
.st-row.active .st-msg { border-color: var(--menuActiveColor); }
.st-flash { animation: stFlash 1.4s ease; }
.st-task-tag { cursor: pointer; }
@keyframes stFlash {
  0% { background: color-mix(in srgb, var(--menuActiveColor) 35%, transparent); }
  100% { background: transparent; }
}

/* 产出物卡片：长路径不能把「打开」按钮顶出可见区域（路径最多两行省略，按钮固定不压缩） */
.st-artifact-row { display: flex; margin: 6px 0; min-width: 0; }
.st-artifact {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--menuActiveColor);
  border-radius: 6px;
  padding: 6px 10px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.st-artifact-main { flex: 1 1 auto; min-width: 0; }
.st-artifact-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-artifact-path {
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
  max-width: 100%;
}
.st-artifact-size { font-size: 11px; opacity: 0.7; flex: 0 0 auto; }
.st-artifact .st-btn { flex: 0 0 auto; white-space: nowrap; }
.st-art-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.st-art-chip {
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  cursor: pointer;
}
.st-art-chip:hover { border-color: var(--menuActiveColor); color: var(--menuActiveColor); }

/* 通信流（有向聚合图） */
.comm-graph { margin-bottom: 8px; overflow-x: auto; }
.comm-graph svg { display: block; color: color-mix(in srgb, var(--fontColor) 45%, transparent); }
.comm-edge { fill: none; stroke: currentColor; stroke-width: 1.4px; }
.comm-edge-label { font-size: 10px; fill: currentColor; }
.comm-node circle { fill: var(--menuActiveColor); }
.comm-node-label { font-size: 11px; fill: var(--fontColor); }
.comm-broadcast { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.lane-block-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
