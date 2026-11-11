/**
 * toolBundles.selftest.ts — 能力包 + 单工具覆盖 + 运行门控
 *
 * 锁住 P0/P1 的关键语义：
 * - 旧 enabledTools 能无损折算成 bundles + overrides；
 * - 新工具随能力域自动进入，单工具覆盖能独立开关；
 * - 组合开关（整组）不会误伤单工具覆盖之外的项；
 * - 运行门控只在环境明确不可用时过滤，不把「不知道」当不可用。
 */

import {
  applyToolGates,
  autoToolsOf,
  bundlesOfTools,
  migrateCapsToToolBundles,
  selectedToolsOf,
  setBundleEnabled,
  setToolOverride,
  toolGateReason,
} from './toolBundles'
import { selectedToolOn, setToolEnabled, toolsFromCapabilities } from './capabilities'

export interface ToolBundlesCase { name: string; ok: boolean; detail?: string }

export function runToolBundlesSelfTest(): ToolBundlesCase[] {
  const cases: ToolBundlesCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 1) 旧 enabledTools → 包 + 覆盖，且解析结果无损 ----
  const caps: any = { enabledTools: ['read_file', 'write_file', 'ask_user', 'plugin_x'] }
  const migrated = migrateCapsToToolBundles(caps)
  add('旧预设迁移成功', migrated === true && caps.toolMode === 'auto')
  add('迁移后选中的能力域包含 files / interaction',
    caps.toolBundles.includes('files') && caps.toolBundles.includes('interaction'),
    JSON.stringify(caps.toolBundles))
  add('未选中的组内工具进入 exclude',
    Array.isArray(caps.toolOverrides?.exclude) && caps.toolOverrides.exclude.includes('read_image'),
    JSON.stringify(caps.toolOverrides))
  add('不属于任何组的工具进入 include',
    Array.isArray(caps.toolOverrides?.include) && caps.toolOverrides.include.includes('plugin_x'),
    JSON.stringify(caps.toolOverrides))
  const parsed = autoToolsOf(caps)
  add('解析结果与旧 enabledTools 等价',
    parsed.length === 4 && ['read_file', 'write_file', 'ask_user', 'plugin_x'].every((t) => parsed.includes(t)),
    parsed.join(','))
  add('迁移幂等（再次调用不改动）', migrateCapsToToolBundles(caps) === false)
  add('custom 模式不迁移', migrateCapsToToolBundles({ toolMode: 'custom', enabledTools: ['read_file'] }) === false)

  // ---- 2) 单工具覆盖：关掉包内工具、打开包外工具 ----
  const solo: any = { toolMode: 'auto', toolBundles: ['files'], toolOverrides: {} }
  add('files 包默认包含 read_file / write_file',
    autoToolsOf(solo).includes('read_file') && autoToolsOf(solo).includes('write_file'))
  setToolOverride(solo, 'write_file', false)
  add('单工具关闭进入 exclude', !autoToolsOf(solo).includes('write_file') && solo.toolOverrides.exclude.includes('write_file'))
  setToolOverride(solo, 'write_file', true)
  add('单工具重新打开移除 exclude', autoToolsOf(solo).includes('write_file') && !(solo.toolOverrides.exclude || []).includes('write_file'))
  setToolOverride(solo, 'shell', true)
  add('包外工具打开进入 include', autoToolsOf(solo).includes('shell') && solo.toolOverrides.include.includes('shell'))

  // ---- 3) 整组开关：切能力域，并清理该组的单工具覆盖 ----
  const group: any = { toolMode: 'auto', toolBundles: ['files'], toolOverrides: { exclude: ['read_image'] } }
  setBundleEnabled(group, 'files', true)
  add('整组开启清理该组 exclude', autoToolsOf(group).includes('read_image') && !(group.toolOverrides.exclude || []).includes('read_image'))
  setBundleEnabled(group, 'files', false)
  add('整组关闭移除能力域', !group.toolBundles.includes('files') && !autoToolsOf(group).includes('read_file'))
  add('未选中的组不能被整组开启以外的操作误加',
    bundlesOfTools(['read_file']).bundles.join(',') === 'files')

  // ---- 4) 运行门控：明确不可用才过滤 ----
  const all = ['read_image', 'read_file', 'shell', 'write_file', 'kb_search', 'mcp_call', 'browser_navigate', 'ask_user', 'exit_plan_mode', 'run_subagent']
  const gated = applyToolGates(all, {
    supportsVision: false,
    sandboxMode: 'safe',
    hasKnowledge: false,
    hasMcpServers: false,
    browserAvailable: false,
    interactive: false,
    nestedDepth: 1,
  })
  add('所有硬门控同时命中时只保留无环境依赖的 read_file',
    gated.length === 1 && gated[0] === 'read_file',
    gated.join(','))
  add('未提供环境事实时不误伤', applyToolGates(all, {}).length === all.length)
  add('无工作区事实不影响文件工具（文件工具可走绝对路径）',
    applyToolGates(['read_file', 'list_dir'], {}).length === 2)
  add('workspace 沙箱不拦 shell', applyToolGates(['shell'], { sandboxMode: 'workspace' }).includes('shell'))
  add('safe 沙箱拦 shell 与写入', !applyToolGates(['shell', 'write_file'], { sandboxMode: 'safe' }).includes('shell'))
  add('视觉明确不支持时拦 read_image', !applyToolGates(['read_image'], { supportsVision: false }).includes('read_image'))
  add('视觉未知时保留 read_image', applyToolGates(['read_image'], {}).includes('read_image'))
  add('门控原因可读', toolGateReason('read_image', { supportsVision: false }, true).includes('图片'))

  // ---- 5) 选择集：自动 / 旧模式 ----
  add('selectedToolsOf 自动模式按包解析', selectedToolsOf({ toolMode: 'auto', toolBundles: ['web'] }).includes('web_search'))
  add('selectedToolsOf 旧模式返回 enabledTools',
    selectedToolsOf({ enabledTools: ['read_file'] }).join(',') === 'read_file')

  // ---- 6) 与统一入口 capabilities.ts 的集成 ----
  const integrated: any = {
    toolMode: 'auto',
    toolBundles: ['files'],
    toolOverrides: { exclude: ['write_file'] },
    knowledgeBaseFiles: [],
  }
  add('自动包的 exclude 会被统一入口尊重',
    toolsFromCapabilities(integrated).includes('read_file') && !toolsFromCapabilities(integrated).includes('write_file'))
  add('统一入口带 env 时应用视觉门控',
    !toolsFromCapabilities(integrated, { env: { supportsVision: false } }).includes('read_image'))
  add('界面选中状态不受运行时门控影响',
    selectedToolOn(integrated, 'read_image') === true)
  setToolEnabled(integrated, 'write_file', true)
  add('手动打开写工具后统一入口立即可见',
    toolsFromCapabilities(integrated).includes('write_file') && selectedToolOn(integrated, 'write_file'))

  return cases
}
