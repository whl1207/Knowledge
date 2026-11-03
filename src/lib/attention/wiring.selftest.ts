/**
 * wiring.selftest.ts — 「待我处理」的三处接线与两处判定的**源码级防回归**
 *
 * 背景：这个面板能不能立住，只取决于几条很安静的代码——
 *   1. `agentBridge.restore()` 必须把 `pendingQuestion` / `pendingPlanReview` 拷回视图，
 *      否则渲染层一刷新（Ctrl+R / HMR / 崩溃重载）「正在等你的问题」就凭空消失；
 *   2. 主进程 `getAgentState()` 必须补 `pendingQuestion`（提问不落日志，只有内存这一份）；
 *   3. 渲染层 `rendererAgent.toStateView()` 同口径（安卓 / 网页端）；
 *   4. 投影必须跳过已销毁会话（dispose 只置标记、不清 pending 字段）；
 *   5. 导航栏四个位置都要有入口（少一处，某个布局下的用户就看不到）。
 *
 * 这些全部是 vue-tsc 查不出的：删掉一行赋值、少一个入口，类型都对，只是功能静默失效。
 * 用法：`node scripts/run-selftests.mjs attentionWiring`
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface AttentionWiringCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仓库根：自测产物在系统临时目录里，用 runner 注入的 NODE_PATH（<repo>/node_modules）反推 */
function repoRoot(): string {
  const np = process.env.NODE_PATH || ''
  return np ? resolve(np, '..') : process.cwd()
}

function readRepoFile(rel: string): string {
  try {
    return readFileSync(join(repoRoot(), rel), 'utf8')
  } catch {
    return ''
  }
}

/** 取出一个函数/方法的源码区间（从 name( 起，配平大括号），用于只检查那一段而不是整个文件 */
function methodBody(source: string, name: string): string {
  const at = source.indexOf(name + '(')
  if (at < 0) return ''
  const open = source.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return ''
}

export function runAttentionWiringSelfTest(): AttentionWiringCase[] {
  const cases: AttentionWiringCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 1. agentBridge.restore() 必须恢复两个挂起态 ----
  const bridge = readRepoFile('src/platform/agentBridge.ts')
  const restore = methodBody(bridge, 'async restore')
  check('agentBridge.restore() 存在', restore.length > 0)
  check('restore() 恢复 pendingQuestion', /view\.pendingQuestion\s*=\s*state\.pendingQuestion/.test(restore), restore.slice(0, 80))
  check('restore() 恢复 pendingPlanReview', /view\.pendingPlanReview\s*=\s*state\.pendingPlanReview/.test(restore))

  // ---- 2. 主进程 getAgentState() 必须补提问（提问不落日志，只能从内存补） ----
  const main = readRepoFile('electron/main/agent-loop.ts')
  const getState = methodBody(main, 'export function getAgentState')
  check('getAgentState() 存在', getState.length > 0)
  check('getAgentState() 从 pendingQuestions 取提问', /pendingQuestions\.get\(id\)/.test(getState))
  check('getAgentState() 写入 live.pendingQuestion', /live\.pendingQuestion\s*=/.test(getState))

  // ---- 3. 渲染层 agent 的同口径 ----
  const renderer = readRepoFile('src/platform/rendererAgent.ts')
  const toState = methodBody(renderer, 'toStateView')
  check('rendererAgent.toStateView() 存在', toState.length > 0)
  check('rendererAgent.toStateView() 带 pendingQuestion', /pendingQuestion:/.test(toState))
  check('rendererAgent.toStateView() 带 pendingPlanReview', /pendingPlanReview:/.test(toState))

  // ---- 4. 投影必须过滤已销毁会话（dispose 不清 pending 字段 → 否则留僵尸条目） ----
  const model = readRepoFile('src/lib/attention/model.ts')
  check('投影过滤 status === disposed', /status\s*===\s*'disposed'/.test(model))
  check('投影过滤 disposed 标记', /disposed\s*===\s*true/.test(model))

  // ---- 5. 导航栏四处的入口 + 抽屉挂载 + 返回层级 ----
  const app = readRepoFile('src/App.vue')
  // 只数模板里的入口（CSS 规则里也有 .attention-entry，不能直接数出现次数）
  const entryCount = (app.match(/class="[^"]*\battention-entry\b/g) || []).length
  check('App.vue 入口出现 4 次（左/顶/窄/底）', entryCount === 4, `count=${entryCount}`)
  check('App.vue 挂载 AttentionPanel（浮层，贴入口）', /<AttentionPanel\b/.test(app))
  check('App.vue 注册 Alt+I 快捷键', /onAttentionKeydown/.test(app))
  check('入口把触发元素传给面板定位', /onAttentionEntryClick/.test(app))
  const layers = readRepoFile('src/platform/backLayers.ts')
  check('BACK_ORDER 含 attentionPanel', /attentionPanel\s*:\s*35/.test(layers))
  // 入口可在 设置 → 通用 → 基础 → 导航与模块 关闭（hiddenExtras 的 'attention'）
  const entryGateCount = (app.match(/v-if="store\.isExtraVisible\('attention'\)"/g) || []).length
  check('四处入口都由 isExtraVisible(\'attention\') 门控', entryGateCount === 4, `count=${entryGateCount}`)
  const setPage = readRepoFile('src/components/set/Set.vue')
  check('设置页「导航与模块」有「待我处理」开关', /key: 'attention'/.test(setPage) && /EXTRA_NAV_KEYS/.test(setPage))

  // ---- 6. 角标只算待我处理（0 条不显示数字） ----
  check('badge 对 0 返回空串', /if\s*\(n\s*<=\s*0\)\s*return\s*''/.test(model))

  // ---- 7. 轻提示收进面板「动态」：拦截必须在入口安装；面板要右对齐窗口 + 宽度自适应 ----
  const entryMain = readRepoFile('src/main.ts')
  check('main.ts 安装轻提示拦截', /installNoticeCapture\(\)/.test(entryMain))
  const panel = readRepoFile('src/components/attention/AttentionPanel.vue')
  check('面板右对齐窗口右侧（不是按钮右侧）', /vw\s*-\s*width\s*-\s*MARGIN/.test(panel))
  check('面板宽度按内容自适应（空/只有通知 200px、有交互 420px）',
    /PANEL_COMPACT\s*=\s*200/.test(panel) && /PANEL_WIDE\s*=\s*420/.test(panel))
  check('面板展示「动态」（轻提示副本）', /notices/.test(panel) && /clearNotices/.test(panel))

  // ---- 8. 轻提示不再用角落 toast：浮层隐藏 + 就地胶囊贴入口 ----
  const css = readRepoFile('src/style.css')
  check('ElMessage 浮层已隐藏（改成导航栏就地提示）', /\.el-message\s*\{[^}]*display:\s*none/.test(css))
  const chip = readRepoFile('src/components/attention/AttentionNoticeChip.vue')
  check('App.vue 挂载就地提示胶囊', /<AttentionNoticeChip\b/.test(app))
  check('胶囊贴在入口左侧（竖直导航栏则从右侧）', /anchorInRail/.test(chip) && /r\.left/.test(chip))
  check('胶囊停留后收缩（有定时器与离场）', /HOLD_MS/.test(chip) && /hideCurrent/.test(chip))

  // ---- 9. 结构化 Report（report_run）：三处接线 + 手机/网页端同口径 + 面板消费 ----
  const loop = readRepoFile('electron/main/agent-loop.ts')
  check('人回话时清掉过期上报（send → setRunReport(null)）',
    /if \(this\._runReport\) this\.setRunReport\(null\)/.test(loop))
  check('agent:state 回放 runReport', /runReport: replay\.runReport/.test(loop))
  const mainTools = readRepoFile('electron/main/tools.ts')
  check('主进程注册 report_run 工具', /defineTool\('report_run'/.test(mainTools))
  check('report_run 有超时预算', /report_run:\s*15_000/.test(mainTools))
  const rTools = readRepoFile('src/lib/agent/rendererTools.ts')
  check('手机/网页端也支持 report_run（同一份契约）', /case 'report_run'/.test(rTools))
  const bridgeFile = readRepoFile('src/platform/agentBridge.ts')
  check('agentBridge 投影 agent/report 事件', /case 'agent\/report'/.test(bridgeFile))
  check('restore() 恢复 runReport', /view\.runReport\s*=\s*state\.runReport/.test(bridgeFile))
  check('面板为运行状态类条目留了中档宽度', /PANEL_REPORT/.test(panel))

  // ---- 10. 并发保留位（给人留 1 个）：判定走纯逻辑、手动重跑标记为用户任务 ----
  const pipe = readRepoFile('src/features/agent-scaffold/pipelineRunner.ts')
  check('调度改用 canStart（含保留位判定）', /canStart\(/.test(pipe))
  check('手动重跑标记为用户任务（可用保留位）', /enqueueTasksFront\(tasks, \{ user: true \}\)/.test(pipe))
  check('远端并发声明走 effectiveConcurrency', /effectiveConcurrency\(/.test(pipe))

  return cases
}
