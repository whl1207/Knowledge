/**
 * notices.ts — 轻提示（ElMessage）的收件箱副本
 *
 * 为什么要有它：应用里到处用 `ElMessage.success/error/...` 做即时反馈（几百处），
 * 它们是**瞬时**的——错过就没了，也散落在界面各角落。这里把所有轻提示同时记一份，
 * 由「待我处理」面板的「动态」段展示（未读小蓝点在入口上），让"刚才弹过什么"可以回看。
 *
 * 为什么不是 store：轻提示可能在 Pinia 挂载之前触发（入口初始化、插件事件），
 * 因此这里用**模块级 ref**（与 store/chats.ts 同样的理由），不依赖 Pinia 实例。
 */

import { computed, ref } from 'vue'

export type NoticeKind = 'success' | 'error' | 'warning' | 'info'

export interface NoticeItem {
  id: string
  kind: NoticeKind
  text: string
  /** 毫秒时间戳 */
  at: number
  read: boolean
}

/** 最多保留多少条（超出丢最旧；面板只展示最近若干条） */
const MAX_NOTICES = 50
/** 同文案在此窗口内不重复入列（连续点两次「已复制」不该出现两条） */
const DEDUPE_MS = 3000

let seq = 0
export const notices = ref<NoticeItem[]>([])
export const unreadNoticeCount = computed(() => notices.value.filter((n) => !n.read).length)

/** 记一条轻提示（由 lib/noticeCapture.ts 的 ElMessage 拦截器调用） */
export function pushNotice(kind: NoticeKind, text: string): void {
  const value = String(text ?? '').trim()
  if (!value) return
  const now = Date.now()
  const head = notices.value[0]
  if (head && head.text === value && head.kind === kind && now - head.at < DEDUPE_MS) {
    // 同一句话重复弹出：只更新时间，不新增一条
    head.at = now
    head.read = false
    return
  }
  seq += 1
  notices.value = [{ id: `notice-${now}-${seq}`, kind, text: value, at: now, read: false }, ...notices.value].slice(0, MAX_NOTICES)
}

export function markNoticesRead(): void {
  if (!unreadNoticeCount.value) return
  notices.value = notices.value.map((n) => (n.read ? n : { ...n, read: true }))
}

export function clearNotices(): void {
  notices.value = []
}
