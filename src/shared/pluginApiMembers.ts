/**
 * pluginApiMembers.ts — 插件两半边的 `ctx` 成员表 + `ctx.*` 用法校验（**单一事实源**）
 *
 * 这份表原本只活在 `electron/main/plugin-dev/plugin-dev-check.ts` 里，导致两个问题：
 *
 * 1. **表本身会过时**：`ctx.files.readBytes` 与 `ctx.app.setChromeHidden` 早已实现
 *    （src/lib/plugin/files.ts / appApi.ts），表里却没有 → `plugin_dev_check` 会把
 *    **写法完全正确**的插件判为「用了宿主不存在的成员」，反过来误导作者。
 * 2. **同一份事实被写了三遍**（校验器一份、`src/lib/plugin/devGuide.ts` 一份、
 *    模板又一份）→ devGuide 的速查表一度把主进程半边写成 `ctx.shell` / `ctx.net` /
 *    `ctx.sessions`（真实 API 是 `ctx.host.runShell` / `ctx.host.fetch` /
 *    `ctx.host.sessions.list`），而校验器用的却是正确名字：指南与校验互相矛盾。
 *
 * 因此把表与校验函数提到共享层（无 node/electron 依赖，主进程与渲染进程共用）：
 * 运行时校验器（plugin-dev-check）与**文档自检**（src/shared/pluginDocsApi.selftest.ts）
 * 都调这里的同一份实现，两边不可能再各说各话。
 *
 * ⚠️ 改这里等于改插件契约：成员表要跟 `src/types/plugin.ts` 的 `PluginContext`
 * （主进程半边）与 `src/lib/plugin/runtime.ts` 的 `ClientPluginContext`（界面半边）对齐。
 */

/** 每个成员下可用的子成员（`null` = 只读数据对象或函数，不逐个校验属性） */
export type PluginCtxMembers = Record<string, string[] | null>

/**
 * 界面半边 `ctx` 的真实成员表（与 `src/lib/plugin/runtime.ts` 的 ClientPluginContext 一一对应）。
 *
 * 为什么需要它：生成式插件最常见的翻车不是语法错，而是**臆造宿主 API**
 * （真实案例：`ctx.files.readFile(...)` + `ctx.service('office', …)` 想解析 Excel，
 * 运行到第一行就抛 "is not a function"，用户看到的就是「面板一直空白 / 图表不显示」）。
 * 静态比对一眼就能在**交付前**发现，不必等用户在界面上发现「什么都没发生」。
 */
export const CLIENT_CTX_MEMBERS: PluginCtxMembers = {
  plugin: null, // 只读快照 { id, name, version, dir }
  config: null, // 只读快照（用户在「插件 → 配置」里保存的 JSON）
  vue: [
    'h', 'defineComponent', 'ref', 'shallowRef', 'reactive', 'computed', 'watch', 'watchEffect',
    'onMounted', 'onUnmounted', 'onBeforeUnmount', 'nextTick', 'toRef', 'toRefs', 'markRaw',
    'provide', 'inject', 'KeepAlive', 'Teleport', 'Transition', 'Fragment',
  ],
  locale: ['language', 'languageRef', 't', 'pick', 'ref', 'fixed'],
  llm: ['available', 'reason', 'sources', 'current', 'models', 'chat', 'stream'],
  files: [
    'available', 'reason', 'pickFiles', 'pickDirectory', 'pickWritableDirectory', 'list', 'readText', 'readBase64',
    'readBytes', 'readSheet', 'renderPdfPage', 'openInApp', 'writeText', 'remove',
  ],
  // 文件能力（两侧同形状的超集）：目标身份 / 版本 / 字面量编辑；契约见 src/shared/fsContract.ts
  fs: ['available', 'reason', 'resolve', 'stat', 'readText', 'readBytes', 'readBase64', 'listDir', 'writeText', 'editText', 'remove', 'sheet'],
  app: ['info', 'agentPresets', 'setChromeHidden', 'chromeHidden'],
  // 委派智能体（界面半边专有）：需 permissions: ['agent.run']，且只在桌面端可用
  agent: ['available', 'reason', 'presets', 'run', 'cancelAll'],
  // 委派句柄层（与上面并存）：create 返回句柄，可 whenIdle / stream / usage / dispose
  agents: ['available', 'reason', 'presets', 'create', 'get', 'list', 'cancelAll'],
  // 生图（需 permissions: ['image']；失败不抛异常，看 ok / code）
  image: ['available', 'reason', 'info', 'generate', 'cancelAll'],
  tts: ['available', 'reason', 'speak', 'stop'],
  shortcuts: ['register', 'list'],
  slots: ['register', 'declare', 'entries'],
  log: ['debug', 'info', 'warn', 'error'],
  on: null, // (type, listener) => 取消订阅函数
  effect: null, // (fn) => 登记副作用并自动清理
  notify: null, // (message) => 轻提示
}

/**
 * 界面半边**不存在**的宿主能力 → 给出「正确做法」。
 * 这些名字（尤其 service / mcp / storage / host）是模型最容易臆造出来的，所以单独列出来报。
 */
export const CLIENT_CTX_ABSENT: Record<string, string> = {
  service: '界面半边没有 ctx.service（也没法连 MCP 服务）：office / 浏览器 / drawio 这些 MCP 服务只按 mcp_call 给智能体调用。要在插件里做同类事情，请用 ctx 上已有的能力，或把功能做成**主进程半边**的工具（index.mjs + ctx.tool）让智能体调用',
  mcp: '界面半边没有 ctx.mcp：MCP 服务只按 mcp_call 给智能体调用，插件不能直连',
  host: '界面半边没有 ctx.host（那是主进程半边 index.mjs 的能力）',
  storage: '界面半边没有 ctx.storage：设置存 localStorage（键名带 aikm.plugin.<插件 id>. 前缀），图片 / 存档等大文件放本机 OPFS 的 plugins/<插件 id>/',
  tool: '界面半边没有 ctx.tool：注册工具要在**主进程半边** index.mjs 里写（export const inject = ["tools"]）',
  shell: '界面半边没有 ctx.shell（执行命令是主进程半边的能力，且需要 shell 权限）',
}

/**
 * 主进程半边 `ctx` 的真实成员表（与 `src/types/plugin.ts` 的 PluginContext 一一对应）。
 * 界面半边那套（ctx.vue / ctx.files / ctx.slots）在这里**不存在**，反之亦然——两半边最容易互相串用。
 */
export const MAIN_CTX_MEMBERS: PluginCtxMembers = {
  plugin: null,
  config: null,
  tool: null, // (def) => disposer
  service: null, // (name, impl) => disposer
  getService: null, // (name) => impl | undefined
  on: null, // (type, listener) => disposer
  effect: null, // (fn) => disposer
  host: ['readFile', 'writeFile', 'listDir', 'runShell', 'fetch', 'sessions', 'granted', 'notify'],
  // 与界面半边同形状（同一份实现，无 IPC）：目标身份 / 版本 / 字面量编辑
  fs: ['available', 'reason', 'resolve', 'stat', 'readText', 'readBytes', 'readBase64', 'listDir', 'writeText', 'editText', 'remove', 'sheet'],
  storage: ['get', 'set', 'delete', 'keys'],
  log: ['debug', 'info', 'warn', 'error'],
}

/** 主进程半边写错时，把「那东西在界面半边」直接点出来（两半边互串是最常见的错法） */
export const MAIN_CTX_ABSENT: Record<string, string> = {
  vue: '主进程半边没有 ctx.vue（那是界面半边的：ctx.vue / ctx.slots / ctx.locale / ctx.files 只在 client.mjs 里有）',
  files: '主进程半边没有 ctx.files（那是界面半边的选择框与 PDF 渲染）；文件读写两个半边都有：用 ctx.fs（插件目录内免授权，其余路径需用户授权）',
  slots: '主进程半边没有 ctx.slots：界面贡献（面板 / 设置页签等）要在界面半边 client.mjs 里注册',
  locale: '主进程半边没有 ctx.locale：中英文案在界面半边用 ctx.locale 处理',
  llm: '主进程半边没有 ctx.llm（大模型能力在界面半边 client.mjs 上）',
  tts: '主进程半边没有 ctx.tts（语音能力在界面半边 client.mjs 上）',
  shortcuts: '主进程半边没有 ctx.shortcuts（全局快捷键在界面半边 client.mjs 上注册）',
  notify: '主进程半边没有 ctx.notify；提示用户用 ctx.host.notify(message)',
}

/** 两半边合起来的「确实存在」成员（文档自检用：一句话里不区分是哪一半时按并集判） */
export const ANY_CTX_MEMBERS: PluginCtxMembers = {
  ...MAIN_CTX_MEMBERS,
  ...CLIENT_CTX_MEMBERS,
}

/**
 * `ctx.<top>` 的字面量匹配（与运行时校验器同一实现，避免文档与校验各说各话）。
 * 允许 `ctx . files` 这类空白（代码里偶尔会这么写），子成员不限大小写 —— 用在**代码**上。
 */
export const CTX_USAGE_RE = /\bctx\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g

/**
 * 同一件事，但用在**散文**（开发指南 / 报错文案）上的更严匹配：点号两侧不许有空白，
 * 且子成员必须以小写开头。
 *
 * 为什么必须分开：散文里 `... no ctx.vue / ctx.files / ctx.slots.` 这种句末句号 + 下句首字母大写
 * 会被上面的宽松正则读成 `ctx.slots.Real` / `ctx.vue.The` 之类的「不存在的子成员」，
 * 于是文档自检满屏误报（实测 44 条里绝大多数是这么来的）。代码里不存在这种写法，所以代码那一侧保持宽松。
 */
export const CTX_USAGE_PROSE_RE = /\bctx\.([A-Za-z_$][\w$]*)(?:\.([a-z_$][\w$]*))?/g

/**
 * 检查代码 / 文档文本里对 `ctx.*` 的引用，返回问题（空数组 = 没发现）。
 *
 * 只认字面量 `ctx.x` / `ctx.x.y`；`ctx['files']`、把 ctx 赋给别的变量后再用属已知盲区。
 * `options.prose` 为真时用散文匹配规则（见 CTX_USAGE_PROSE_RE）。
 */
export function checkCtxUsage(
  code: string,
  members: PluginCtxMembers,
  absent: Record<string, string>,
  options: { prose?: boolean } = {},
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const re = options.prose ? CTX_USAGE_PROSE_RE : CTX_USAGE_RE
  for (const match of code.matchAll(re)) {
    const top = match[1]
    const sub = match[2]
    const key = `${top}.${sub ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    const reason = absent[top]
    if (reason) {
      // 同一个缺失成员只报一次
      if (!seen.has(`!${top}`)) {
        seen.add(`!${top}`)
        problems.push(`用了宿主不存在的 ctx.${top} —— ${reason}`)
      }
      continue
    }
    if (!(top in members)) {
      problems.push(`用了宿主不存在的 ctx.${top}（这里可用的只有：${Object.keys(members).join(' / ')}）`)
      continue
    }
    const subs = members[top]
    if (sub && subs && !subs.includes(sub)) {
      problems.push(`ctx.${top} 没有 ${sub}（可用：${subs.join(' / ')}）`)
    }
  }
  return problems
}
