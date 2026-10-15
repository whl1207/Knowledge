/**
 * draggableSlot.selftest.ts — vuedraggable「#item 插槽只能一个根节点」的源码级防回归
 *
 * 背景（真实踩坑）：vuedraggable 要求 item 插槽每个条目**只有一个根节点**。
 * 如果在插槽里放了 HTML 注释，**开发构建会保留注释** → 插槽根上多出一个注释节点 →
 * 节点数 ≠ 列表长度 → 它抛 "Item slot must have only one child"，而这条错误被它自己的
 * try/catch 吞掉（只在页面里渲染成一段红字），随后它的 updated 钩子因为内部结构没建起来
 * 崩成 "Cannot read properties of undefined (reading 'updated')"。
 *
 * 这三点合起来意味着：`vue-tsc` 查不出、生产构建（注释被丢掉）也不复现 —— 必须有源码级检查。
 * 本文件用纯字符串解析（不引 Vue 编译器）做两件事：
 *   1. 用合成样例验证「检查器本身」能抓出注释 / 多根节点；
 *   2. 拿真实的 home.vue（聊天列表）跑一遍。
 *
 * 用法：`node scripts/run-selftests.mjs draggableSlot`
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DraggableSlotCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仓库根：自测产物在系统临时目录里，用 runner 注入的 NODE_PATH（<repo>/node_modules）反推 */
function repoRoot(): string {
  const np = process.env.NODE_PATH || ''
  return np ? resolve(np, '..') : process.cwd()
}

/** 缩进宽度（模板都按缩进排布，用缩进判断「是不是在插槽根这一级」） */
function indentOf(line: string): number {
  return line.match(/^\s*/)![0].length
}

export interface SlotInspection {
  /** 插槽里出现过的 HTML 注释（含安全的内层注释） */
  comments: string[]
  /** **插槽根这一级**的注释 —— 这些才会变成多余的根节点（危险） */
  rootComments: string[]
  /** 插槽根上的顶层元素个数 */
  rootElements: number
  /** 顶层元素（调试用） */
  roots: string[]
}

/**
 * 检查一段 `<template #item>` 的**内部**文本：
 * - 顶层元素 = 缩进最浅的那一级里、以 `<` 开头的行（本项目模板按缩进排布，够用且不依赖编译器）；
 * - 危险注释 = 缩进**不深于**顶层元素的行上的注释（即位于插槽根这一级）。
 */
export function inspectItemSlot(inner: string): SlotInspection {
  const comments = Array.from(inner.matchAll(/<!--([\s\S]*?)-->/g)).map((m) => m[1].trim())

  const lines = inner.split('\n').map((l) => l.replace(/\s+$/, ''))
  const elementLines = lines.filter((l) => /^\s*</.test(l) && !/^\s*<\//.test(l) && !/^\s*<\s*$/.test(l))
  let rootElements = 0
  let roots: string[] = []
  let rootIndent = Number.POSITIVE_INFINITY
  if (elementLines.length) {
    rootIndent = Math.min(...elementLines.map(indentOf))
    roots = elementLines.filter((l) => indentOf(l) === rootIndent)
    rootElements = roots.length
  }
  const rootComments = lines
    .filter((l) => /^\s*<!--/.test(l) && indentOf(l) <= rootIndent)
    .map((l) => (l.match(/<!--([\s\S]*?)-->/) || [])[1]?.trim() || '')

  return { comments, rootComments, rootElements, roots }
}

/** 取出源码里第一个 `<template #item...>` 的内部文本（本项目里没有嵌套 template，取最近的 </template> 即可） */
export function extractItemSlot(source: string): string | null {
  const open = source.search(/<template\s+#item[^>]*>/)
  if (open < 0) return null
  const openEnd = source.indexOf('>', open) + 1
  const close = source.indexOf('</template>', openEnd)
  if (close < 0) return null
  return source.slice(openEnd, close)
}

export function runDraggableSlotSelfTest(): DraggableSlotCase[] {
  const cases: DraggableSlotCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 检查器本身：合成样例
  const good = `
          <div class="chat-row-wrap">
            <div v-if="element.head">H</div>
            <div class="chat-item">C</div>
          </div>
`
  const badComment = `
          <!-- 分组头 -->
          <div class="chat-row-wrap">…</div>
`
  const badTwoRoots = `
          <div class="head">H</div>
          <div class="chat-item">C</div>
`
  const innerCommentOnly = `
          <div class="chat-item">
            <!-- 删除按钮 -->
            <i class="fa fa-trash"></i>
          </div>
`
  const g = inspectItemSlot(good)
  add('检查器：单根 + 无注释 → 通过', g.rootComments.length === 0 && g.rootElements === 1, JSON.stringify(g))
  const c = inspectItemSlot(badComment)
  add('检查器：插槽根上有注释 → 判为不合格', c.rootComments.length === 1, c.rootComments.join(' | '))
  const two = inspectItemSlot(badTwoRoots)
  add('检查器：根上两个元素 → 判为不合格', two.rootComments.length === 0 && two.rootElements === 2, `roots=${two.rootElements}`)
  const inner = inspectItemSlot(innerCommentOnly)
  add('检查器：注释在**元素内部**（安全）→ 通过', inner.rootElements === 1 && inner.comments.length === 1 && inner.rootComments.length === 0, JSON.stringify(inner))

  // 2. 提取器：能从源码里取出插槽内部
  const sample = `<draggable>\n  <template #item="{ element }">\n    <div>x</div>\n  </template>\n</draggable>`
  add('提取器：能取出 #item 内部文本', (extractItemSlot(sample) || '').includes('<div>x</div>'))
  add('提取器：没有 #item 时返回 null', extractItemSlot('<div>no slot</div>') === null)

  // 3. 真实文件：home.vue 的聊天列表插槽
  try {
    const src = readFileSync(join(repoRoot(), 'src', 'components', 'home.vue'), 'utf8')
    const inner = extractItemSlot(src)
    add('home.vue：找得到聊天列表的 #item 插槽', !!inner)
    if (inner) {
      const info = inspectItemSlot(inner)
      add('home.vue：插槽根上没有 HTML 注释（dev 下会成为多余节点）', info.rootComments.length === 0, info.rootComments.slice(0, 2).join(' | '))
      add('home.vue：插槽根上只有一个元素', info.rootElements === 1, `roots=${info.rootElements} :: ${info.roots.join(' ')}`)
    }
  } catch (err: any) {
    add('home.vue：读取失败', false, String(err?.message || err))
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logDraggableSlotSelfTest(): boolean {
  const cases = runDraggableSlotSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[draggableSlot] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
