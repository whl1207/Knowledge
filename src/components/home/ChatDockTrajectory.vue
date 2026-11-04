<!-- src/components/home/ChatDockTrajectory.vue
     会话轨迹（参照 DSH Trajectory）：按轮次把用户消息、模型回复、思考、工具调用、
     压缩记录整理成可展开的记录表，并给出 token / 耗时概览。
     只读投影：不改聊天、不触发请求。 -->
<template>
  <div class="traj">
    <div class="traj-head">
      <div class="traj-title">
        <i class="fa fa-history"></i>
        <span>{{ zh ? '会话轨迹' : 'Trajectory' }}</span>
        <span class="traj-count">{{ rows.length }}</span>
      </div>
      <div class="traj-search">
        <i class="fa fa-search"></i>
        <input v-model="query" :placeholder="zh ? '过滤记录（标题 / 内容 / 工具名）' : 'Filter records (title / content / tool)'" />
        <i v-if="query" class="fa fa-times-circle" @click="query = ''"></i>
      </div>
    </div>

    <div class="traj-summary">
      <div class="traj-metric"><span>{{ zh ? '轮次' : 'Turns' }}</span><b>{{ summary.turns }}</b></div>
      <div class="traj-metric"><span>{{ zh ? '记录' : 'Events' }}</span><b>{{ rows.length }}</b></div>
      <div class="traj-metric"><span>{{ zh ? '工具' : 'Tools' }}</span><b>{{ summary.tools }}</b></div>
      <div class="traj-metric"><span>{{ zh ? '输入' : 'Prompt' }}</span><b>{{ fmtTokens(summary.promptTokens) }}</b></div>
      <div class="traj-metric"><span>{{ zh ? '输出' : 'Output' }}</span><b>{{ fmtTokens(summary.completionTokens) }}</b></div>
      <div v-if="summary.cacheText" class="traj-metric"><span>{{ zh ? '缓存' : 'Cache' }}</span><b>{{ summary.cacheText }}</b></div>
      <div class="traj-metric"><span>{{ zh ? '耗时' : 'Elapsed' }}</span><b>{{ summary.elapsedText }}</b></div>
    </div>

    <div ref="listEl" class="traj-list scoll" @scroll="onScroll">
      <div v-if="!groups.length" class="traj-empty">
        <i class="fa fa-road"></i>
        <span>{{ query ? (zh ? '没有匹配的记录' : 'No matching events') : (zh ? '这个会话还没有可展示的轨迹' : 'No trajectory yet for this chat') }}</span>
      </div>
      <section v-for="g in groups" :key="g.key" class="traj-group">
        <div class="traj-group-head">
          <span class="traj-turn">{{ g.turn > 0 ? `${zh ? '第' : 'Turn '}${g.turn}${zh ? '轮' : ''}` : (zh ? '会话' : 'Session') }}</span>
          <span v-if="g.timeText" class="traj-group-time">{{ g.timeText }}</span>
          <span v-if="g.tools" class="traj-group-tools"><i class="fa fa-wrench"></i>{{ g.tools }}</span>
          <span v-if="g.tokenText" class="traj-group-tokens">{{ g.tokenText }}</span>
        </div>
        <div
          v-for="row in g.rows"
          :key="row.id"
          class="traj-row"
          :class="[row.kind, { open: expanded.has(row.id) }]"
          @click="toggle(row.id)"
        >
          <div class="traj-row-main">
            <span class="traj-row-icon"><i class="fa" :class="row.icon"></i></span>
            <span class="traj-row-kind">{{ kindLabel(row.kind) }}</span>
            <span class="traj-row-title" :title="row.title">{{ row.title }}</span>
            <span v-if="row.status" class="traj-row-status" :class="row.status">{{ row.status }}</span>
            <span v-if="row.timeText" class="traj-row-time">{{ row.timeText }}</span>
            <span v-if="row.durationText" class="traj-row-duration">{{ row.durationText }}</span>
            <i class="fa traj-row-caret" :class="expanded.has(row.id) ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
          </div>
          <div v-if="expanded.has(row.id)" class="traj-row-detail" @click.stop>
            <div v-if="row.detail" class="learn-md"><block_md :content="row.detail" :fontSize="'12px'" /></div>
            <div v-else class="traj-row-nodetail">{{ zh ? '无更多内容' : 'No further detail' }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import block_md from '@/components/block_md.vue'

const props = defineProps<{
  chat: any
  zh: boolean
}>()

type RowKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'plan' | 'system' | 'compaction'
interface TrajRow {
  id: string
  turn: number
  kind: RowKind
  title: string
  detail?: string
  icon: string
  status?: string
  time: number
  durationMs?: number
  timeText?: string
  durationText?: string
}
interface TrajGroup {
  key: string
  turn: number
  timeText: string
  tools: number
  tokenText: string
  rows: TrajRow[]
}

const query = ref('')
const expanded = ref<Set<string>>(new Set())
const listEl = ref<HTMLElement | null>(null)
const followTail = ref(true)

const fmtTokens = (n: number): string => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(Math.round(v))
}
const fmtTime = (t?: number): string => {
  if (!t || !Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const fmtDuration = (ms?: number): string => {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
const pretty = (v: any): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const allRows = computed<TrajRow[]>(() => {
  const chat = props.chat || {}
  const messages: any[] = Array.isArray(chat.messages) ? chat.messages : []
  const rows: TrajRow[] = []
  let turn = 0
  messages.forEach((m, mi) => {
    const baseId = `m${mi}`
    const time = Number(m?.timestamp) || 0
    if (m?.role === 'user') {
      turn++
      const attachments = Array.isArray(m.fileAttachments) ? m.fileAttachments : []
      const images = Array.isArray(m.images) ? m.images : []
      const extra = [
        images.length ? (props.zh ? `图片 ${images.length} 张` : `${images.length} image(s)`) : '',
        attachments.length ? (props.zh ? `附件：${attachments.map((f: any) => f.name).join('、')}` : `Attachments: ${attachments.map((f: any) => f.name).join(', ')}`) : '',
      ].filter(Boolean).join('\n')
      rows.push({
        id: `${baseId}-user`, turn, kind: 'user', icon: 'fa-user',
        title: String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (props.zh ? '用户消息' : 'User message'),
        detail: [m.content || '', extra].filter(Boolean).join('\n\n'), time,
        timeText: fmtTime(time),
      })
      return
    }
    if (m?.role === 'system') {
      rows.push({
        id: `${baseId}-system`, turn, kind: 'system', icon: 'fa-cog',
        title: String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (props.zh ? '系统消息' : 'System message'),
        detail: m.content || '', time, timeText: fmtTime(time),
      })
      return
    }
    const units: any[] = Array.isArray(m?.executionUnits) ? m.executionUnits : []
    let hasContentUnit = false
    units.forEach((u, ui) => {
      const st = String(u?.stepType || '')
      const start = Number(u?.startTime) || time
      const end = Number(u?.endTime) || 0
      const duration = end > start ? end - start : Number(u?.duration) || 0
      if (st === 'reasoning') {
        rows.push({
          id: `${baseId}-u${ui}-reason`, turn, kind: 'reasoning', icon: 'fa-lightbulb-o',
          title: String(u?.description || u?.streamContent || u?.resultPreview || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (props.zh ? '思考' : 'Reasoning'),
          detail: st === 'reasoning' ? String(u?.streamContent || u?.resultPreview || u?.description || '') : pretty(u?.result),
          status: u?.status, time: start, durationMs: duration,
          timeText: fmtTime(start), durationText: fmtDuration(duration),
        })
        return
      }
      if (st === 'tool' || u?.name || u?.args !== undefined) {
        const title = String(u?.description || u?.name || (props.zh ? '工具调用' : 'Tool call'))
        const detail = [
          u?.args !== undefined ? `**${props.zh ? '参数' : 'Arguments'}**\n\n\`\`\`json\n${pretty(u.args)}\n\`\`\`` : '',
          u?.error ? `**${props.zh ? '错误' : 'Error'}**\n\n${String(u.error)}` : '',
          u?.result !== undefined ? `**${props.zh ? '结果' : 'Result'}**\n\n\`\`\`\n${pretty(u.result)}\n\`\`\`` : (u?.resultPreview ? `**${props.zh ? '结果' : 'Result'}**\n\n${String(u.resultPreview)}` : ''),
        ].filter(Boolean).join('\n\n')
        rows.push({
          id: `${baseId}-u${ui}-tool`, turn, kind: 'tool', icon: 'fa-wrench', title,
          detail, status: u?.status, time: start, durationMs: duration,
          timeText: fmtTime(start), durationText: fmtDuration(duration),
        })
        return
      }
      if (st === 'content') {
        hasContentUnit = true
        rows.push({
          id: `${baseId}-u${ui}-content`, turn, kind: 'assistant', icon: 'fa-comment-o',
          title: String(u?.streamContent || u?.description || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (props.zh ? '模型回复' : 'Assistant reply'),
          detail: String(u?.streamContent || u?.description || ''), time: start,
          timeText: fmtTime(start), durationText: fmtDuration(duration),
        })
        return
      }
      if (st === 'plan') {
        rows.push({
          id: `${baseId}-u${ui}-plan`, turn, kind: 'plan', icon: 'fa-tasks',
          title: String(u?.description || (props.zh ? '更新计划' : 'Plan update')),
          detail: pretty(u?.result ?? u?.args), status: u?.status, time: start,
          timeText: fmtTime(start), durationText: fmtDuration(duration),
        })
      }
    })
    if (m?.content && !hasContentUnit) {
      rows.push({
        id: `${baseId}-assistant`, turn, kind: 'assistant', icon: 'fa-comment-o',
        title: String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (props.zh ? '模型回复' : 'Assistant reply'),
        detail: String(m.content || ''), time, timeText: fmtTime(time),
      })
    }
    // 每条助手消息的 token 用量汇总在轮次组头，不在记录表里单独占一行
  })
  if (chat?.compaction && (chat.compaction.summary || chat.compaction.tokensAfter || chat.compaction.tokensBefore)) {
    const c = chat.compaction
    rows.push({
      id: 'compaction', turn, kind: 'compaction', icon: 'fa-compress',
      title: props.zh ? '上下文压缩' : 'Context compaction',
      detail: [
        c.tokensBefore ? `${props.zh ? '压缩前' : 'Before'}：${fmtTokens(c.tokensBefore)} tok` : '',
        c.tokensAfter ? `${props.zh ? '压缩后' : 'After'}：${fmtTokens(c.tokensAfter)} tok` : '',
        c.summary ? `\n${String(c.summary)}` : '',
      ].filter(Boolean).join('\n\n'),
      time: Number(c.at) || 0, timeText: fmtTime(Number(c.at)),
    })
  }
  return rows
})

const rows = computed<TrajRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allRows.value
  return allRows.value.filter(r => `${r.title}\n${r.detail || ''}\n${r.kind}`.toLowerCase().includes(q))
})

/** 每轮 token 用量（按用户消息切轮，累加该轮所有助手消息的 usage） */
const turnTokens = computed<Map<number, string>>(() => {
  const map = new Map<number, { p: number; c: number }>()
  let turn = 0
  for (const m of (props.chat?.messages || [])) {
    if (m?.role === 'user') { turn++; continue }
    const s = m?.tokenStats
    if (!s) continue
    const cur = map.get(turn) || { p: 0, c: 0 }
    cur.p += Number(s.promptTokensTotal ?? s.promptTokens ?? 0) || 0
    cur.c += Number(s.completionTokens ?? 0) || 0
    map.set(turn, cur)
  }
  const out = new Map<number, string>()
  for (const [k, v] of map) {
    const total = v.p + v.c
    if (total > 0) out.set(k, `${fmtTokens(v.p)} / ${fmtTokens(v.c)} tok`)
  }
  return out
})

const groups = computed<TrajGroup[]>(() => {
  const map = new Map<number, TrajRow[]>()
  for (const r of rows.value) {
    const arr = map.get(r.turn) || []
    arr.push(r)
    map.set(r.turn, arr)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([turn, list]) => {
    const tools = list.filter(r => r.kind === 'tool').length
    const times = list.map(r => r.time).filter(Boolean)
    const first = times.length ? Math.min(...times) : 0
    const last = times.length ? Math.max(...times) : 0
    return {
      key: String(turn), turn, tools,
      timeText: turn > 0 ? (first ? `${fmtTime(first)}${last && last !== first ? ` – ${fmtTime(last)}` : ''}` : '') : '',
      tokenText: turnTokens.value.get(turn) || '',
      rows: list,
    }
  })
})

// 从聊天消息中取每轮 token（按用户消息后第一条助手消息的 tokenStats）
const summary = computed(() => {
  const messages: any[] = props.chat?.messages || []
  let promptTokens = 0
  let completionTokens = 0
  let cached = 0
  let cacheReported = false
  let tools = 0
  let turns = 0
  let first = 0
  let last = 0
  for (const m of messages) {
    const t = Number(m?.timestamp) || 0
    if (t) { if (!first || t < first) first = t; if (t > last) last = t }
    if (m?.role === 'user') turns++
    const s = m?.tokenStats
    if (s) {
      promptTokens += Number(s.promptTokensTotal ?? s.promptTokens ?? 0) || 0
      completionTokens += Number(s.completionTokens ?? 0) || 0
      if (typeof s.cachedTokens === 'number') { cached += s.cachedTokens; cacheReported = true }
      if (s.cacheReported) cacheReported = true
    }
    if (Array.isArray(m?.executionUnits)) {
      tools += m.executionUnits.filter((u: any) => u?.stepType === 'tool' || u?.name || u?.args !== undefined).length
    }
  }
  const elapsed = first && last ? last - first : 0
  return {
    turns, tools, promptTokens, completionTokens,
    cacheText: cacheReported && promptTokens > 0 ? `${Math.round((cached / promptTokens) * 100)}%` : '',
    elapsedText: fmtDuration(elapsed) || '—',
  }
})

const kindLabel = (kind: RowKind): string => {
  if (kind === 'user') return props.zh ? '用户' : 'User'
  if (kind === 'assistant') return props.zh ? '回复' : 'Reply'
  if (kind === 'reasoning') return props.zh ? '思考' : 'Thinking'
  if (kind === 'tool') return props.zh ? '工具' : 'Tool'
  if (kind === 'plan') return props.zh ? '计划' : 'Plan'
  if (kind === 'system') return props.zh ? '系统' : 'System'
  return props.zh ? '压缩' : 'Compaction'
}

const toggle = (id: string) => {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const scrollToTail = () => {
  nextTick(() => {
    if (!listEl.value || !followTail.value) return
    listEl.value.scrollTop = listEl.value.scrollHeight
  })
}
/** 用户向上滚动后暂停自动跟随；回到底部附近恢复 */
const onScroll = () => {
  const el = listEl.value
  if (!el) return
  followTail.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
watch(() => props.chat?.messages?.length, () => scrollToTail())
watch(() => props.chat?.id, () => { followTail.value = true; scrollToTail() })
onMounted(scrollToTail)
</script>

<style scoped>
.traj { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--backgroundColor); }
.traj-head { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-bottom: 1px solid var(--borderColor); background: var(--menuColor); }
.traj-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.traj-title > i { color: var(--fontActiveColor); }
.traj-count { font-size: 10px; opacity: .55; font-weight: normal; }
.traj-search { flex: 1; min-width: 0; margin-left: auto; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 7px; border: 1px solid var(--borderColor); border-radius: 5px; background: var(--backgroundColor); }
.traj-search > i { font-size: 11px; opacity: .5; }
.traj-search > input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fontColor); font-size: 11px; }
.traj-search > i:last-child { cursor: pointer; }
.traj-summary { flex-shrink: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 8px; padding: 8px; border-bottom: 1px solid var(--borderColor); }
.traj-metric { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 4px; font-size: 10px; opacity: .75; }
.traj-metric > b { font-weight: 600; white-space: nowrap; color: var(--fontColor); }
.traj-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 12px; }
.traj-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; opacity: .5; padding: 36px 16px; font-size: 12px; text-align: center; }
.traj-empty i { font-size: 22px; }
.traj-group { margin: 6px 6px 0; }
.traj-group-head { display: flex; align-items: center; gap: 6px; padding: 5px 6px; font-size: 10px; color: var(--fontColor); opacity: .7; border-bottom: 1px dashed var(--borderColor); }
.traj-turn { font-weight: 600; }
.traj-group-time { opacity: .8; }
.traj-group-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
.traj-group-tokens { opacity: .8; }
.traj-row { border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 55%, transparent); cursor: pointer; }
.traj-row:hover { background: color-mix(in srgb, var(--fontActiveColor) 6%, transparent); }
.traj-row-main { display: flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 6px; font-size: 11px; }
.traj-row-icon { flex-shrink: 0; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; background: color-mix(in srgb, var(--fontColor) 8%, transparent); font-size: 10px; }
.traj-row.reasoning .traj-row-icon { color: #b08900; }
.traj-row.tool .traj-row-icon { color: var(--fontActiveColor); }
.traj-row.user .traj-row-icon { color: #2e7d32; }
.traj-row.compaction .traj-row-icon { color: #7b1fa2; }
.traj-row-kind { flex-shrink: 0; font-size: 9px; opacity: .5; width: 28px; }
.traj-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.traj-row-status { flex-shrink: 0; font-size: 9px; padding: 0 4px; border-radius: 3px; background: color-mix(in srgb, var(--fontColor) 8%, transparent); }
.traj-row-status.running { color: #1565c0; }
.traj-row-status.success { color: #2e7d32; }
.traj-row-status.error { color: #c62828; }
.traj-row-time,
.traj-row-duration { flex-shrink: 0; font-size: 9px; opacity: .5; }
.traj-row-caret { flex-shrink: 0; font-size: 9px; opacity: .45; }
.traj-row-detail { padding: 2px 10px 8px 27px; font-size: 12px; line-height: 1.6; border-top: 1px dashed color-mix(in srgb, var(--borderColor) 55%, transparent); }
.traj-row-nodetail { opacity: .45; font-size: 11px; padding: 4px 0; }
.learn-md { overflow-wrap: anywhere; }
</style>
