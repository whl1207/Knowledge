/**
 * pluginPresetTools.selftest.ts — 「插件工具在智能体预设里怎么算」的自测（方案 B 语义）
 *
 * 背景（真实需求 + 真实缺陷）：插件注册的工具（作用域 `plugin:<id>`）以前被
 * `toolsFromCapabilities()` **无条件追加**到每个预设的白名单末尾，后果是：
 *   - 用户在预设界面里**看不到**这些工具（工具行来自静态表 AGENT_TOOL_REGISTRY）；
 *   - 因此也**关不掉**它们，只能整体停用插件。
 *
 * 现在改为方案 B：`enabledTools` 是唯一权威，插件工具与内置工具一视同仁 —— 勾了才生效。
 * 本自测锁住四条不变量：
 *   1. 未勾选 ⇒ 不进白名单（旧的"自动追加"必须彻底消失）；
 *   2. 勾选且插件仍激活 ⇒ 进白名单；
 *   3. 勾选但插件已卸载/停用 ⇒ **剔除**（防止预设里残留的名字继续暴露给模型）；
 *   4. `toolOn()` 与白名单**同一个答案**（界面显示 = 运行时可用，不允许两套）。
 *
 * 用法：`node scripts/run-selftests.mjs pluginPresetTools`
 */
import {
  effectiveToolsOf,
  getPluginToolNames,
  isPluginTool,
  setPluginDeclaredToolNames,
  setPluginToolNames,
  toolOn,
  toolsFromCapabilities,
} from './capabilities'

export interface PluginPresetToolsCase {
  name: string
  ok: boolean
  detail?: string
}

/** Pi 预设的真实基础集（与 builtinAgentPresets.ts 的 enabledTools 一致，作为锚点） */
const PI_BASE = [
  'ask_user', 'read_file', 'search_files', 'list_dir',
  'write_file', 'replace_in_file', 'multi_replace',
  'shell', 'run_python', 'web_search', 'web_fetch', 'skill',
]

const MPG = [
  'mathproof_init', 'mathproof_add_fact', 'mathproof_link', 'mathproof_state',
  'mathproof_frontier', 'mathproof_search', 'mathproof_revoke', 'mathproof_check',
]

const OTHER_PLUGIN = ['hello_echo']

export function runPluginPresetToolsSelfTest(): PluginPresetToolsCase[] {
  const cases: PluginPresetToolsCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  const capsWith = (enabledTools: string[]) => ({ enabledTools: enabledTools.slice() })

  // ---- 1) 未勾选：一个插件工具都不许进来（这就是"自动追加"必须消失的断言）----
  setPluginDeclaredToolNames([...MPG, ...OTHER_PLUGIN])
  setPluginToolNames([...MPG, ...OTHER_PLUGIN])
  const notTicked = toolsFromCapabilities(capsWith(PI_BASE))
  push('插件激活但预设未勾选 ⇒ 插件工具不进白名单',
    !notTicked.some((t) => isPluginTool(t)),
    `意外带入：${notTicked.filter((t) => isPluginTool(t)).join(', ') || '（无）'}`)
  push('未勾选时白名单就是基础集本身（顺序也不变）',
    notTicked.join(',') === PI_BASE.join(','),
    `${notTicked.length} 项：${notTicked.join(',')}`)

  // ---- 2) 勾选且插件激活：进白名单 ----
  const ticked = toolsFromCapabilities(capsWith([...PI_BASE, ...MPG]))
  push('勾选且插件激活 ⇒ 8 个插件工具全部进白名单',
    MPG.every((t) => ticked.includes(t)),
    `缺失：${MPG.filter((t) => !ticked.includes(t)).join(', ') || '（无）'}`)
  push('勾选后总数 = 基础 12 + 插件 8',
    ticked.length === PI_BASE.length + MPG.length,
    `${ticked.length}`)

  // ---- 3) 勾选过但插件已卸载/停用：剔除（防脏数据继续暴露给模型）----
  // 关键点：**声明过**的名单仍在（含停用的插件），只有"已激活"名单里没有它 —— 这正是剔除了它的依据
  setPluginToolNames([...OTHER_PLUGIN]) // 假装 math-proof-graph 被停用了
  // 注意：hello_echo 要**显式勾选**才会在名单里（方案 B 下没有"自动带入"这回事），
  // 而 mathproof_* 即使勾了也必须被剔除 —— 这一条正是要区分这两种情况
  const stale = toolsFromCapabilities(capsWith([...PI_BASE, ...MPG, 'hello_echo']))
  push('插件停用后，预设里残留的插件工具被剔除',
    !stale.some((t) => MPG.includes(t)),
    `仍然存在：${stale.filter((t) => MPG.includes(t)).join(', ') || '（无）'}`)
  push('剔除只针对失效的插件工具，其它插件工具仍在',
    stale.includes('hello_echo') && stale.length === PI_BASE.length + 1,
    `${stale.length}：${stale.join(',')}`)

  // ---- 4) toolOn 与白名单同源（界面显示 = 运行时可用）----
  setPluginToolNames([...MPG, ...OTHER_PLUGIN])
  push('toolOn(未勾选的插件工具) === false', toolOn(capsWith(PI_BASE), 'mathproof_init') === false)
  push('toolOn(勾选且激活) === true', toolOn(capsWith([...PI_BASE, 'mathproof_init']), 'mathproof_init') === true)
  setPluginToolNames([])
  push('toolOn(勾选但插件全部停用) === false', toolOn(capsWith([...PI_BASE, 'mathproof_init']), 'mathproof_init') === false)
  push('effectiveToolsOf 与 toolsFromCapabilities 逐项一致',
    effectiveToolsOf(capsWith(PI_BASE)).join(',') === toolsFromCapabilities(capsWith(PI_BASE)).join(','))

  // ---- 5) 旧模式（无 enabledTools，按能力槽布尔推导）也必须遵守同一条规则 ----
  setPluginToolNames([...MPG])
  const legacyOff = toolsFromCapabilities({ readFiles: true, listDirs: true, askUser: true })
  push('旧模式（能力槽布尔）下插件工具同样不会被自动追加',
    !legacyOff.includes('mathproof_init'),
    legacyOff.join(','))
  push('旧模式仍产出它自己的能力槽工具', legacyOff.includes('read_file') && legacyOff.includes('list_dir') && legacyOff.includes('ask_user'),
    legacyOff.join(','))

  // ---- 6) 边界：能力集为空 / 插件名单为空 / 重复勾选 ----
  push('空的 enabledTools ⇒ 空白名单（不因插件工具而"无中生有"）',
    toolsFromCapabilities(capsWith([])).length === 0,
    JSON.stringify(toolsFromCapabilities(capsWith([]))))
  setPluginToolNames([])
  push('插件名单为空时不抛错', toolsFromCapabilities(capsWith(PI_BASE)).length === PI_BASE.length)
  setPluginToolNames([...MPG])
  const dup = toolsFromCapabilities(capsWith([...PI_BASE, 'mathproof_init', 'mathproof_init']))
  push('重复勾选不产生重复项', dup.filter((t) => t === 'mathproof_init').length === 1,
    String(dup.filter((t) => t === 'mathproof_init').length))
  push('setPluginToolNames 过滤掉空串/非字符串',
    (() => {
      setPluginToolNames(['ok_tool', '', '  ', undefined as any, 42 as any])
      const names = getPluginToolNames()
      return names.length === 1 && names[0] === 'ok_tool'
    })())

  // 收尾：把模块级名单清干净，免得影响同一进程里后续的自测套件
  setPluginToolNames([])
  setPluginDeclaredToolNames([])
  return cases
}

/** 命令行入口（run-selftests 走这个） */
export function logPluginPresetToolsSelfTest(): boolean {
  const cases = runPluginPresetToolsSelfTest()
  const failed = cases.filter((c) => !c.ok)
  for (const c of cases) {
    if (!c.ok) console.log(`  [FAIL] ${c.name}${c.detail ? ' -- ' + c.detail : ''}`)
  }
  console.log(`[pluginPresetTools] ${cases.length - failed.length}/${cases.length} passed`)
  return failed.length === 0
}
