/**
 * noticeCapture.ts — 把所有轻提示（ElMessage）收进「待我处理」面板
 *
 * 为什么用 DOM 观察而不是给 `ElMessage` 打补丁：应用里有 ~690 处 `ElMessage.xxx(...)`
 * 与少量 `ElMessage(...)` 直接调用；改调用点不现实，而给导出对象打补丁只能覆盖方法形式，
 * 还会受 ESM 绑定限制。Element Plus 的每条提示都会往 body 插一个 `.el-message` 节点，
 * 在这里观察一次，就能**不区分调用方式**全部收下（只读，不改变提示本身的行为）。
 *
 * 位置调整不在这里做：见 style.css 的 `.el-message` 段（顶部居中、导航栏下方、可正常堆叠）。
 */

import { pushNotice, type NoticeKind } from '@/store/notices'

const KIND_BY_CLASS: Array<[string, NoticeKind]> = [
  ['el-message--success', 'success'],
  ['el-message--error', 'error'],
  ['el-message--warning', 'warning'],
  ['el-message--info', 'info'],
]

/** 已记录过的 DOM 节点（同一条提示只入列一次） */
const seen = new WeakSet<Element>()
let observer: MutationObserver | null = null
let started = false

function kindOf(el: Element): NoticeKind {
  for (const [cls, kind] of KIND_BY_CLASS) {
    if (el.classList.contains(cls)) return kind
  }
  return 'info'
}

function record(el: Element): void {
  if (seen.has(el)) return
  seen.add(el)
  const content = el.querySelector('.el-message__content')
  const text = String(content?.textContent || el.textContent || '').trim()
  if (text) pushNotice(kindOf(el), text)
}

function scanNode(node: Node): void {
  if (node.nodeType !== 1) return
  const el = node as Element
  if (typeof el.matches === 'function' && el.matches('.el-message')) record(el)
  if (typeof el.querySelectorAll === 'function') {
    for (const inner of Array.from(el.querySelectorAll('.el-message'))) record(inner)
  }
}

/**
 * 开始观察轻提示节点（幂等，返回注销函数）。
 * 没有 DOM 的环境（自测 / 主进程）直接返回空注销，不报错。
 */
export function installNoticeCapture(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  if (started) return () => { /* 已安装：保持单一实例 */ }
  started = true
  observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.addedNodes)) scanNode(node)
    }
  })
  const start = () => {
    if (observer && document.body) observer.observe(document.body, { childList: true })
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
  return () => {
    observer?.disconnect()
    observer = null
    started = false
  }
}
