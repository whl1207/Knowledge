/**
 * agentContract.selftest.ts — 插件委派契约层的纯逻辑自测
 *
 * 锁四件事（每件都对应一条会在生产里咬人的规矩）：
 *   1. 预算**只紧不松**，且被削掉的项要显式回给插件（不静默降级）；
 *   2. 工具分层 **fail-closed**：未登记分层的槽位一律不放行，且断言"现有槽位全部登记了"；
 *   3. **`ok` 由 `termination` 决定**，失败时保留部分输出、绝不冒充成功（对齐 DSH 的结果纪律）；
 *   4. 调用窗口记账的边界（含脏时间戳）。
 *
 * 用法：`node scripts/run-selftests.mjs agentContract`
 */
import { CAPABILITY_TOOL_SLOTS } from '@/lib/agent/capabilities'
import {
  AGENT_RUN_LIMITS,
  LLM_CONFIG_KEYS,
  canStartCall,
  delegableToolFilter,
  delegableToolSet,
  isTokenBudgetEnforced,
  neverRelaxableSlots,
  normalizeAgentRunResult,
  normalizePluginAgentLimits,
  pickLlmConfig,
  pruneCallWindow,
  resolveAgentRunBudget,
  resolveWorkRoot,
  toIpcSafe,
  untieredSlots,
  withWorkRootHint,
} from './agentContract'
import type { PluginPermission } from '@/types/plugin'

export interface AgentContractCase {
  name: string
  ok: boolean
  detail?: string
}

/** 危险工具的"必须被拒"清单（零权限插件下） */
const MUST_BE_DENIED_WHEN_UNPRIVILEGED = [
  'read_file', 'search_files', 'list_dir', 'write_file', 'replace_in_file', 'multi_replace',
  'run_python', 'shell', 'mcp_call', 'skill', 'run_subagent', 'job_output', 'job_kill', 'kb_search',
]

export function runAgentContractSelfTest(): AgentContractCase[] {
  const cases: AgentContractCase[] = []

  // ---------------- 1) 预算钳制 ----------------
  {
    const d = resolveAgentRunBudget(undefined)
    cases.push({
      name: '预算：不申请时取默认值',
      ok:
        d.timeoutMs === AGENT_RUN_LIMITS.timeoutMs.default &&
        d.maxSteps === AGENT_RUN_LIMITS.maxSteps.default &&
        d.clamped.length === 0,
      detail: `timeoutMs=${d.timeoutMs} maxSteps=${d.maxSteps} clamped=${d.clamped.length}`,
    })
  }
  {
    const r = resolveAgentRunBudget({ timeoutMs: 10 ** 9, maxSteps: 10 ** 6, maxTokens: 10 ** 9 })
    cases.push({
      name: '预算：超上限被钳到上限，且记录被削项（不静默降级）',
      ok:
        r.timeoutMs === AGENT_RUN_LIMITS.timeoutMs.max &&
        r.maxSteps === AGENT_RUN_LIMITS.maxSteps.max &&
        r.maxTokens === AGENT_RUN_LIMITS.maxTokens.max &&
        r.clamped.length === 3,
      detail: `timeoutMs=${r.timeoutMs} maxSteps=${r.maxSteps} clamped=${r.clamped.map((c) => `${c.field}:${c.requested}→${c.applied}`).join(' ')}`,
    })
  }
  {
    const r = resolveAgentRunBudget({ timeoutMs: 1, maxSteps: 0, maxTokens: Number('x') })
    cases.push({
      name: '预算：正数但低于下限 → 抬到下限并记为被削；非正数 / 非法 → 回落默认且**不**记为被削',
      ok:
        r.timeoutMs === AGENT_RUN_LIMITS.timeoutMs.min &&
        r.maxSteps === AGENT_RUN_LIMITS.maxSteps.default &&
        r.maxTokens === AGENT_RUN_LIMITS.maxTokens.default &&
        r.clamped.length === 1 &&
        r.clamped[0].field === 'timeoutMs' &&
        r.clamped[0].source === 'request',
      detail: `timeoutMs=${r.timeoutMs} maxSteps=${r.maxSteps} maxTokens=${r.maxTokens} clamped=${JSON.stringify(r.clamped)}`,
    })
  }
  {
    const r = resolveAgentRunBudget({ maxSteps: 50 }, 5)
    cases.push({
      name: '预算：预设的步数上限参与取 min，并标明是被**预设**削的',
      ok:
        r.maxSteps === 5 &&
        r.clamped.length === 1 &&
        r.clamped[0].field === 'maxSteps' && r.clamped[0].applied === 5 && r.clamped[0].source === 'preset',
      detail: `maxSteps=${r.maxSteps} clamped=${r.clamped.map((c) => `${c.field}:${c.requested}→${c.applied}(${c.source})`).join(' ')}`,
    })
  }
  {
    const r = resolveAgentRunBudget({ maxSteps: 3 }, 999)
    cases.push({
      name: '预算：预设比申请更松时**不放大**、也不记被削（仍用申请值）',
      ok: r.maxSteps === 3 && r.clamped.length === 0,
      detail: `maxSteps=${r.maxSteps}（申请 3，预设 999 → 应取 3 且无 clamped）`,
    })
  }
  cases.push({
    name: 'meta: v1 的 token 上限明确标记为未执行（P1.5 打开时本断言会红，提醒同步契约）',
    ok: isTokenBudgetEnforced() === false && AGENT_RUN_LIMITS.maxTokens.enforced === false,
    detail: '主进程当前不解析 LLM 用量，故 maxTokens 只能事后报告（见设计 §3 D4）',
  })

  // ---------------- 2) 工具分层 fail-closed ----------------
  {
    const missing = untieredSlots()
    cases.push({
      name: '工具分层：现有能力槽全部登记了分层（新增槽位必须来登记，否则自测红）',
      ok: missing.length === 0,
      detail: missing.length ? `未登记：${missing.join(', ')}` : `${CAPABILITY_TOOL_SLOTS.length} 个槽位全部已登记`,
    })
  }
  {
    const set = delegableToolSet([])
    const leaked = MUST_BE_DENIED_WHEN_UNPRIVILEGED.filter((t) => set.has(t))
    cases.push({
      name: '零权限插件：文件 / 命令 / 代码 / MCP / 技能 / 递归委派 / 知识库 全部不可委派',
      ok: leaked.length === 0,
      detail: leaked.length ? `泄漏：${leaked.join(', ')}` : `允许集 ${set.size} 项：${[...set].sort().join(' / ')}`,
    })
  }
  {
    const withNet = delegableToolSet(['net'])
    const withFs = delegableToolSet(['fs'])
    cases.push({
      name: 'gated 分层按插件自己的权限放行：net → 联网检索；fs → 知识库检索（但都不是 read_file）',
      ok:
        withNet.has('web_search') && withNet.has('web_fetch') &&
        !withNet.has('kb_search') &&
        withFs.has('kb_search') &&
        !withFs.has('read_file') && !withFs.has('write_file'),
      detail: `net: web_search=${withNet.has('web_search')} kb_search=${withNet.has('kb_search')}；fs: kb_search=${withFs.has('kb_search')} read_file=${withFs.has('read_file')}`,
    })
  }
  {
    const r = delegableToolFilter({ requestedTools: null, pluginPermissions: [], pluginOwnTools: ['my_plugin_ping'] })
    const dangerous = r.allowed.filter((t) => MUST_BE_DENIED_WHEN_UNPRIVILEGED.includes(t))
    cases.push({
      name: '预设不限（null）时退化为"能力槽允许集"，**不是全放行**；插件自有工具在内',
      ok: dangerous.length === 0 && r.allowed.includes('my_plugin_ping'),
      detail: `${r.allowed.length} 项：${r.allowed.join(' / ')}`,
    })
  }
  {
    const r = delegableToolFilter({
      requestedTools: ['ask_user', 'read_file', 'shell', 'my_plugin_ping', 'web_search'],
      pluginPermissions: [],
      pluginOwnTools: ['my_plugin_ping'],
    })
    cases.push({
      name: '有预设白名单时取交集，并记录被裁项（含插件自有工具——预设没列就不给）',
      ok:
        r.allowed.includes('ask_user') &&
        r.allowed.includes('my_plugin_ping') &&
        !r.allowed.includes('read_file') && !r.allowed.includes('shell') && !r.allowed.includes('web_search') &&
        r.denied.sort().join() === ['read_file', 'shell', 'web_search'].sort().join(),
      detail: `allowed=${r.allowed.join(' / ')}｜denied=${r.denied.join(' / ')}`,
    })
  }

  // ---------------- 2b) 面板可调：每插件额度 + D5 放宽 ----------------
  {
    const d = normalizePluginAgentLimits(undefined)
    const d2 = normalizePluginAgentLimits({})
    cases.push({
      name: '每插件额度：没配过 → 默认 1 / 20（面板是加法，已装插件行为不变）',
      ok:
        d.concurrency === 1 && d.callsPerHour === 20 &&
        d2.concurrency === 1 && d2.callsPerHour === 20,
      detail: `${JSON.stringify(d)} / ${JSON.stringify(d2)}`,
    })
  }
  {
    const big = normalizePluginAgentLimits({ concurrency: 99, callsPerHour: 9999 })
    const junk = normalizePluginAgentLimits({ concurrency: -3, callsPerHour: 'x' })
    cases.push({
      name: '每插件额度：超天花板钳到上限（3 / 200）；非法值回落**默认**而不是锁成最小值',
      ok:
        big.concurrency === 3 && big.callsPerHour === 200 &&
        junk.concurrency === 1 && junk.callsPerHour === 20,
      detail: `big=${JSON.stringify(big)} junk=${JSON.stringify(junk)}`,
    })
  }
  {
    const noPerm = delegableToolSet([], { fs: true })
    const withFs = delegableToolSet(['fs'], { fs: true })
    const noRelax = delegableToolSet(['fs'])
    cases.push({
      name: '放宽 fs 是**双条件**：用户开了开关 + 插件自己声明了 fs；只声明 fs 而不开开关仍然不给',
      ok:
        !noPerm.has('read_file') &&
        withFs.has('read_file') && withFs.has('write_file') &&
        !noRelax.has('read_file'),
      detail: `空权限+开关=${noPerm.has('read_file')}｜fs权限+开关=${withFs.has('read_file')}｜fs权限无开关=${noRelax.has('read_file')}`,
    })
  }
  {
    const withMcp = delegableToolSet([], { mcp: true })
    cases.push({
      name: '放宽 mcp 只需用户开关（MCP 服务本身是用户配置的，插件只能按 id 引用）',
      ok: withMcp.has('mcp_call'),
      detail: `mcp_call=${withMcp.has('mcp_call')}`,
    })
  }
  {
    // 最关键的一条：把插件能声明的权限**全部**声明上、两个开关**全开**，
    // 命令 / 代码执行 / 技能 / 递归委派 仍然进不来（永不放宽）。
    const all: PluginPermission[] = ['fs', 'shell', 'net', 'agent', 'agent.run', 'llm']
    const set = delegableToolSet(all, { fs: true, mcp: true })
    const stillDenied = ['shell', 'run_python', 'skill', 'run_subagent', 'job_output', 'job_kill'].filter((t) => set.has(t))
    const neverTier = neverRelaxableSlots()
    cases.push({
      name: '**两个开关全开 + 全部权限声明** → 命令 / 代码 / 技能 / 递归委派仍然进不来',
      ok: stillDenied.length === 0 && neverTier.length === 4,
      detail: stillDenied.length
        ? `泄漏：${stillDenied.join(', ')}`
        : `永不放宽的槽位：${neverTier.join(', ')}`,
    })
  }
  {
    const r = delegableToolFilter({
      requestedTools: ['read_file', 'mcp_call', 'ask_user', 'shell'],
      pluginPermissions: ['fs'],
      relax: { fs: true, mcp: true },
    })
    cases.push({
      name: '放宽后仍要与"这次申请的工具"取交集（放宽只是解除拒绝，不是放行一切）',
      ok:
        r.allowed.includes('read_file') && r.allowed.includes('mcp_call') && r.allowed.includes('ask_user') &&
        !r.allowed.includes('shell') &&
        r.denied.join() === 'shell',
      detail: `allowed=${r.allowed.join(' / ')}｜denied=${r.denied.join(' / ')}`,
    })
  }

  // ---------------- 3) 结果归一（不冒充成功） ----------------
  {
    const r = normalizeAgentRunResult({ ok: true, termination: 'timeout', output: '半截回答', turn: 2 })
    cases.push({
      name: '**ok 由 termination 决定**：传 ok:true + timeout → 仍判失败，且保留部分输出',
      ok: r.ok === false && r.termination === 'timeout' && r.output === '半截回答',
      detail: `ok=${r.ok} termination=${r.termination} output="${r.output}"`,
    })
  }
  {
    const r = normalizeAgentRunResult({ output: '正常答完', turn: 1 })
    cases.push({
      name: '无终止原因且无错误 → completed（ok=true）',
      ok: r.ok === true && r.termination === 'completed' && r.output === '正常答完' && r.turn === 1,
      detail: `ok=${r.ok} termination=${r.termination} turn=${r.turn}`,
    })
  }
  {
    const casesIn = [
      [{ timedOut: true }, 'timeout'],
      [{ cancelled: true }, 'cancelled'],
      [{ error: '模型 500' }, 'error'],
      [{ termination: '不是合法值', error: 'boom' }, 'error'],
      [{ termination: 'maxSteps', output: '走满了' }, 'maxSteps'],
    ] as const
    const bad = casesIn.filter(([raw, want]) => normalizeAgentRunResult(raw as any).termination !== want)
    cases.push({
      name: '终止原因推导：timedOut / cancelled / error 各归其位；非法 termination 被忽略并回落推导',
      ok: bad.length === 0,
      detail: bad.length ? bad.map(([raw]) => JSON.stringify(raw)).join('；') : `${casesIn.length} 例全对`,
    })
  }
  {
    const r = normalizeAgentRunResult({ turn: -5, usage: { inputTokens: 12, outputTokens: Number('x') } })
    cases.push({
      name: 'turn 归一（负数 → 0）；usage 只在两个字段都是数字时才带上',
      ok: r.turn === 0 && r.usage === undefined,
      detail: `turn=${r.turn} usage=${JSON.stringify(r.usage)}`,
    })
  }

  // ---------------- 4) 调用窗口 ----------------
  {
    const now = 10_000_000
    const kept = pruneCallWindow([now - 1, now - AGENT_RUN_LIMITS.windowMs - 1, NaN as unknown as number, now], now)
    const within = kept.every((t) => t > now - AGENT_RUN_LIMITS.windowMs)
    cases.push({
      name: '调用窗口：窗口外的时间戳与脏值被丢掉',
      ok: kept.length === 2 && within,
      detail: `保留 ${kept.length} 个（期望 2，且都在窗口内）`,
    })
  }
  {
    const now = 5_000
    const atLimit = canStartCall([1, 2, 3], now, 3)
    const under = canStartCall([1, 2], now, 3)
    cases.push({
      name: '调用窗口：到上限即拒（边界：= limit 拒、< limit 放行）',
      ok: atLimit.ok === false && atLimit.used === 3 && under.ok === true && under.used === 2,
      detail: `atLimit=${atLimit.ok}(${atLimit.used}/${atLimit.limit}) under=${under.ok}(${under.used}/${under.limit})`,
    })
  }

  // ---------------- 5) 过桥数据整形（真实事故的回归测试） ----------------
  {
    // 事故现场：`{ ...llm }` 把整个模型配置块（含全部来源与 custom.sources）带上过桥
    const llmWithEverything = {
      type: 'deepseek',
      temperature: 0.7,
      max_tokens: 4096,
      think: true,
      top_p: 0.9,
      // 以下都不该被带过去
      deepseek: { api_key: 'sk-deepseek-should-not-ride-along', model: 'deepseek-chat' },
      openai: { api_key: 'sk-openai-should-not-ride-along' },
      custom: { activeIndex: 0, sources: [{ name: 'x', api_key: 'sk-custom-should-not-ride-along' }] },
    }
    const cfg = pickLlmConfig(llmWithEverything, 'deepseek')
    const carriedKeys = Object.keys(cfg).sort()
    const leaked = ['deepseek', 'openai', 'custom'].filter((k) => k in cfg)
    cases.push({
      name: '**过桥的 llmConfig 是白名单**：不携带其它来源的配置与 api_key（事故根因）',
      ok:
        leaked.length === 0 &&
        cfg.type === 'deepseek' &&
        cfg.stream === true &&
        cfg.temperature === 0.7 &&
        cfg.max_tokens === 4096 &&
        cfg.think === true &&
        cfg.top_p === 0.9,
      detail: `带过去的键：${carriedKeys.join(', ')}${leaked.length ? `｜**泄漏**：${leaked.join(', ')}` : ''}`,
    })
  }
  {
    // 白名单必须覆盖主进程真的会读的那些字段，否则委派会静默少传参数
    const consumed = ['type', 'stream', 'think', 'temperature', 'top_p', 'max_tokens', 'model', 'tools',
      'frequency_penalty', 'presence_penalty', 'options', 'keep_alive', 'logprobs', 'top_logprobs',
      'remoteMaxInflight', 'format']
    const missing = consumed.filter((k) => !LLM_CONFIG_KEYS.includes(k as (typeof LLM_CONFIG_KEYS)[number]))
    cases.push({
      name: `白名单覆盖主进程消费的全部 ${consumed.length} 个字段（少一个就会静默丢参数）`,
      ok: missing.length === 0,
      detail: missing.length ? `缺少：${missing.join(', ')}` : `${LLM_CONFIG_KEYS.length} 个键`,
    })
  }
  {
    const cyclic: Record<string, unknown> = { name: 'src' }
    cyclic.self = cyclic // 自引用 → JSON.stringify 会 RangeError
    let msg = ''
    try {
      toIpcSafe({ options: { config: cyclic } }, '智能体预设「p1」的 options')
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    cases.push({
      name: '**折不动时点名到字段**（不再是 Electron 那句无从下手的 "could not be cloned"）',
      ok: msg.includes('智能体预设「p1」的 options') && msg.includes('无法序列化'),
      detail: msg,
    })
  }
  {
    const src = { a: 1, nested: { b: [1, 2, 3] } }
    const out = toIpcSafe(src, '测试')
    cases.push({
      name: '折得动时返回等值但**不同身份**的纯数据副本（下游改它不会回写源对象）',
      ok: out !== src && JSON.stringify(out) === JSON.stringify(src) && out.nested !== src.nested,
      detail: `sameRef=${out === src} sameNested=${out.nested === src.nested}`,
    })
  }

  // ---------------- 工作目录（被委派 agent 的 cwd） ----------------
  {
    const r = resolveWorkRoot({ incoming: '/kb', writableRoots: ['/grant'] })
    cases.push({
      name: '**没配置 → 原样透传调用方的默认**（面板出现之前的行为不许变）',
      ok: r.cwd === '/kb' && r.source === 'default' && !r.error,
      detail: JSON.stringify(r),
    })
  }
  {
    const r = resolveWorkRoot({ configured: '/grant/sub', incoming: '/kb', writableRoots: ['/grant'] })
    cases.push({
      name: '配置在可写授权内 → 用它（并覆盖传入的默认）',
      ok: r.cwd === '/grant/sub' && r.source === 'configured' && !r.error,
      detail: JSON.stringify(r),
    })
  }
  {
    const exact = resolveWorkRoot({ configured: '/grant', incoming: '/kb', writableRoots: ['/grant'] })
    const nested = resolveWorkRoot({ configured: '/grant/a/b', incoming: '/kb', writableRoots: ['/grant/a'] })
    cases.push({
      name: '授权根本身、以及更深一层子目录都算命中（目录授权覆盖子树）',
      ok: exact.cwd === '/grant' && !exact.error && nested.cwd === '/grant/a/b' && !nested.error,
      detail: `${exact.cwd} / ${nested.cwd}`,
    })
  }
  {
    const outside = resolveWorkRoot({ configured: '/elsewhere', incoming: '/kb', writableRoots: ['/grant'] })
    const revoked = resolveWorkRoot({ configured: '/grant', incoming: '/kb', writableRoots: [] })
    const sibling = resolveWorkRoot({ configured: '/grant-x', incoming: '/kb', writableRoots: ['/grant'] })
    cases.push({
      name: '授权之外 / 授权被撤销 / 前缀相似的兄弟目录 → **报错且不回退默认**（悄悄换目录会让 agent 在没预期的位置读写）',
      ok:
        !outside.cwd && !!outside.error && outside.source === 'configured' &&
        !revoked.cwd && !!revoked.error &&
        !sibling.cwd && !!sibling.error && /未授权/.test(sibling.error),
      detail: `outside=${!!outside.error} revoked=${!!revoked.error} sibling=${!!sibling.error}`,
    })
  }
  {
    const strict = resolveWorkRoot({ configured: 'C:/Data/Work', incoming: '', writableRoots: ['c:/data/work'] })
    const loose = resolveWorkRoot({ configured: 'C:/Data/Work', incoming: '', writableRoots: ['c:/data/work'], caseInsensitive: true })
    cases.push({
      name: '大小写：严格模式不命中、平台忽略大小写时命中（调用方按平台传）',
      ok: !strict.cwd && !!strict.error && loose.cwd === 'C:/Data/Work',
      detail: `strict=${!!strict.error} loose=${loose.cwd}`,
    })
  }
  {
    const none = withWorkRootHint(undefined, '')
    const withPrompt = withWorkRootHint('你是数学证明助手。', '/grant/sub')
    const masked = withWorkRootHint('工作目录是 /tmp', '/grant/sub')
    cases.push({
      name: 'D1：cwd 必须由宿主写进系统提示（含路径 + 相对路径说明），且**追加在插件/预设提示之后**（盖不掉）',
      ok:
        none === '' &&
        withPrompt.startsWith('你是数学证明助手。') &&
        withPrompt.includes('/grant/sub') &&
        /Working directory/.test(withPrompt) &&
        /相对路径按这个目录解析/.test(withPrompt) &&
        masked.indexOf('/tmp') < masked.lastIndexOf('/grant/sub'),
      detail: withPrompt.split('\n').slice(-3).join(' / '),
    })
  }

  return cases
}

/** 命令行入口 */
export function logAgentContractSelfTest(): boolean {
  const cases = runAgentContractSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
