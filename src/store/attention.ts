/**
 * attention.ts — 「待我处理」收件箱的渲染层状态（投影 + 动作）
 *
 * 事实源：`agentBridge` 的视图（桌面 = 主进程 agent 内存；安卓/网页 = 渲染层 agent）。
 * 本模块只做投影与转发，**不自己维护"未解决清单"**——否则就与主进程的
 * `pendingQuestions` / `pendingPlanReviews` 形成双事实源（见实施方案 D3）。
 *
 * 动作全部走既有通道：
 * - 回答提问 = `agentBridge.answer(sessionId, askId, '', answers)`；
 * - 计划裁决 = 同一方法的 `review-` 前缀分支（message = 裁决，feedback 走 answers[0].custom）；
 * - 停止会话 = `agentBridge.cancel(sessionId, 'user')`。
 * 因此原聊天里的模态会因为这些视图字段被清空而自动收口（各 runner 已有 watcher）。
 */

import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AskUserAnswer } from '@/types/agent'
import type { AttentionItem } from '@/types/attention'
import { agentBridge } from '@/platform/agentBridge'
import { chatsRef, currentChatIndexRef } from '@/store/chats'
import { usestore } from '@/store'
import { badgeText, groupItems, itemsFromViews, sortItems } from '@/lib/attention/model'
import type { PlanReviewVerdict } from '@/shared/agentPlanReview'

/**
 * 面板开关 + 锚点。
 *
 * 形态是**贴着导航按钮的浮层面板**（不是全高抽屉）：点击哪个入口就贴着哪个入口展开，
 * 永远不遮挡导航栏；没有条目时高度自动收小。开关放 store 而不是组件内 ref，
 * 因为导航入口（四处）、键盘快捷键、Esc、返回手势都要能控制同一份状态。
 */
export const panelOpen = ref(false)
/** 触发面板的导航按钮（浮层据它定位；键盘打开时回退到当前可见的那个入口） */
export const panelAnchor = ref<HTMLElement | null>(null)

/** 找到当前可见的「待我处理」入口（四种布局各有一个，窄窗口可能同时存在两个） */
export function findVisibleEntry(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.attention-entry'))
  return nodes.find((el) => el.offsetParent !== null) || nodes[0] || null
}

export function openPanel(anchor?: HTMLElement | null): void {
  panelAnchor.value = anchor || findVisibleEntry()
  panelOpen.value = true
}
export function closePanel(): void { panelOpen.value = false }
export function togglePanel(anchor?: HTMLElement | null): void {
  if (panelOpen.value) closePanel()
  else openPanel(anchor)
}

/** 视图版本号：agentBridge 的视图是普通对象，靠订阅回调 + version 触发 computed 重算 */
const tick = ref(0)
/** 每个条目首次被观察到的时刻（视图里没有"何时开始等"的时间戳） */
const firstSeen = new Map<string, number>()

let off: (() => void) | null = null

/** 会话 id → 聊天 id（打开原处用；找不到就不给该按钮） */
function chatIdOfSession(sessionId: string): string | undefined {
  const list = Array.isArray(chatsRef.value) ? chatsRef.value : []
  const hit = list.find((c: any) => c && String(c.agentSessionId || '') === sessionId)
  return hit && hit.id !== undefined && hit.id !== null ? String(hit.id) : undefined
}

/** 当前待我处理条目（已排序；分组见 groups） */
export const items = computed<AttentionItem[]>(() => {
  tick.value
  const list = sortItems(itemsFromViews(agentBridge.list(), {
    resolveChatId: chatIdOfSession,
    resolveAt: (key) => firstSeen.get(key),
    now: Date.now(),
  }))
  // 首次观察登记 + 清理已消失的键（避免 Map 无限增长）
  const alive = new Set(list.map((i) => i.key))
  for (const item of list) if (!firstSeen.has(item.key)) firstSeen.set(item.key, item.at)
  for (const key of Array.from(firstSeen.keys())) if (!alive.has(key)) firstSeen.delete(key)
  return list
})

export const groups = computed(() => groupItems(items.value))
export const openCount = computed(() => items.value.length)
/** 角标文案（0 → 空串：入口常驻但不显示数字） */
export const badge = computed(() => badgeText(openCount.value))

/** 重新拉一遍全部活跃会话的状态（渲染层重载后用它把挂起态恢复回来） */
export async function refreshAttention(): Promise<void> {
  try {
    await agentBridge.refreshAll()
  } catch {
    // 拉不到就用手上已有的视图，不阻塞界面
  }
  tick.value++
}

/**
 * 幂等初始化：App.vue onMounted 调一次，返回注销函数。
 * 订阅视图变化 + 启动时从主进程状态重建（刷新 / 重开窗口后条目不再凭空消失）。
 */
export function initAttention(): () => void {
  if (off) {
    void refreshAttention()
    return () => {}
  }
  off = agentBridge.on(() => { tick.value++ })
  void refreshAttention()
  return () => {
    off?.()
    off = null
  }
}

function warnFailed(zh: boolean): void {
  ElMessage.warning(zh ? '这条已经失效了（会话已结束或已被处理）' : 'This item is no longer valid (the session ended or it was handled)')
  void refreshAttention()
}

function isZh(): boolean {
  try { return usestore().locales !== 'en' } catch { return true }
}

/** 回答一条提问（面板内作答） */
export async function answerItem(item: AttentionItem, answers: AskUserAnswer[]): Promise<boolean> {
  const askId = item.payload.askId
  if (!askId) return false
  try {
    await agentBridge.answer(item.sessionId, askId, '', answers)
    tick.value++
    return true
  } catch {
    warnFailed(isZh())
    return false
  }
}

/** 裁决一份计划评审（approve / keep + feedback / dismiss） */
export async function decideItem(
  item: AttentionItem,
  verdict: PlanReviewVerdict,
  feedback = '',
): Promise<boolean> {
  const reviewId = item.payload.reviewId
  if (!reviewId) return false
  const text = String(feedback || '').trim()
  const answers: AskUserAnswer[] | undefined = verdict === 'keep' && text
    ? [{ id: 'feedback', selected: [], custom: text }]
    : undefined
  try {
    await agentBridge.answer(item.sessionId, reviewId, verdict, answers)
    tick.value++
    return true
  } catch {
    warnFailed(isZh())
    return false
  }
}

/** 停止该条目的会话（提问类「结束等待」的唯一诚实做法：不是忽略，而是明确停掉） */
export async function stopSession(item: AttentionItem): Promise<void> {
  try {
    await agentBridge.cancel(item.sessionId, 'user')
    tick.value++
  } catch {
    warnFailed(isZh())
  }
}

/** 打开原处：切到主页并定位到该会话所属的聊天 */
export function openSource(item: AttentionItem): void {
  if (!item.chatId) return
  try {
    const store = usestore()
    store.mainPanel = '主页'
    const list = Array.isArray(chatsRef.value) ? chatsRef.value : []
    const idx = list.findIndex((c: any) => c && String(c.id) === String(item.chatId))
    if (idx >= 0) currentChatIndexRef.value = idx
  } catch {
    // 主页模块还没就绪时静默失败：条目仍在面板里，用户可以重试
  }
  closePanel()
}
