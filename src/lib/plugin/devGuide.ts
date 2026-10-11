/**
 * devGuide.ts — 「设置 → 插件 → 开发」页的内容（纯数据，无 Vue 依赖）
 *
 * 为什么单独放一个文件：这里的每一段都是要**粘给大模型**的指令文本，属于"内容"而不是
 * "界面"。放在数据层便于校对「与实际实现是否一致」，也方便将来加更多模板。
 *
 * 维护约定：本文件里出现的清单字段、权限、槽位、ctx 方法名必须与
 *   - src/shared/pluginManifest.ts（清单校验、受支持权限）
 *   - src/shared/pluginSlots.ts（内置槽位）
 *   - src/lib/plugin/runtime.ts（客户端 ctx）
 *   - electron/main/plugin-host.ts（主进程 ctx）
 * 保持一致；改实现时请同步这里（否则开发者照着写会踩空）。
 */

/** 一段可复制的指令 / 说明 */
export interface PluginDevSection {
  key: string
  /** 小节标题 */
  titleZh: string
  titleEn: string
  /** 小节说明（讲清这段是干什么用的、什么时候用） */
  descZh: string
  descEn: string
  /** 可复制的正文（提示词 / 步骤） */
  bodyZh: string
  bodyEn: string
}

/** 速查表一行 */
export interface PluginDevFact {
  name: string
  descZh: string
  descEn: string
}

/** 常见问题 */
export interface PluginDevFaq {
  qZh: string
  qEn: string
  aZh: string
  aEn: string
}

/**
 * 硬约束：所有模板都会带上这一段。
 * 每一条都对应真实踩过的坑（宿主校验 / Blob 模块加载 / 深色主题 / flex 布局），
 * 不是风格建议，写插件时是必须遵守的。
 */
const CONSTRAINTS_ZH = `【必须遵守的硬约束（宿主会校验或直接失败）】
1. 目录名必须等于插件 id（清单里的 aikm.id）；两者不一致清单校验直接失败。
2. package.json 必须含 aikm 字段：id / version / apiVersion 必填，version 形如 1.0.0，apiVersion 写 "^1"。
3. main 与 client 至少声明一个（main = 主进程半边，client.entry = 界面半边），路径必须是插件目录内的相对路径。
4. declares.slots 必须列全你要用的所有槽位，出现未知槽位会被拒绝；只允许这些槽位：
   panel.main（主面板 + 导航按钮）、settings.tab（设置页签）、settings.card（插到已有设置页的卡片，需 meta.target）、
   swarm.workbench.tab（集群工作台页签）、chat.message.actions（聊天消息级按钮）。
5. 用到宿主能力必须声明 permissions（可用：fs / shell / net / agent / llm）；未声明就调用会直接抛错。
   启用插件时软件会把申请的权限列给用户确认，所以不要多申请。
6. 界面半边（client.entry 指向的文件）必须是**单文件 ESM 且没有任何 import/require**：
   宿主把源码包成 Blob URL 再 import，裸模块名（比如 'vue'）在 Blob 模块里无法解析。
   Vue 运行时由宿主注入：apply(ctx) 里从 ctx.vue 取 { h, defineComponent, ref, computed, watch, onMounted, onUnmounted, nextTick } 等。
7. 所有副作用必须可清理：定时器 / 事件监听 / 全局快捷键都要在 ctx.effect(() => 清理函数) 或组件的 onUnmounted 里撤销，
   否则禁用插件后它们还在跑（宿主只在卸载时撤销它自己记录的东西）。
8. 组件的 onMounted / onUnmounted 必须在 defineComponent 的 setup() 里调用；在 setup 之外调用会报「无组件实例」。
9. 文案中英双语：用 ctx.locale.pick({ zh: {...}, en: {...} })，不要在界面里写死中文。
10. 样式必须跟随主题：颜色用 CSS 变量 --backgroundColor / --menuColor / --menuActiveColor / --borderColor /
    --fontColor / --fontActiveColor；需要滚动的容器加 class="scoll"（应用统一细滚动条）。
    原生 select / input 必须自己设紧凑宽度与显式前景/背景色（软件全局样式给的是 31px 高、宽度 calc(100%-10px)，深色主题下不设颜色会白底白字）。
11. 面板要横向铺满：外层用块级容器，不要在 flex 容器里只放一个卡片（flex 子元素在主轴方向不会被拉伸，卡片会缩成内容宽）。
12. 面板高度不能撑大整个窗口：内容放在固定上限高度 + overflow:auto 的容器里，让面板内部滚动。
13. 错误要自己兜住：try/catch + ctx.log.warn(...)，不要只 console.log（插件日志在「插件 → 管理 → 日志」里看）。
14. 不要往界面里注入全局 CSS、不要改应用其它部分；插件只负责自己那部分 UI。`

const CONSTRAINTS_EN = `[Hard constraints the host enforces]
1. The folder name must equal the plugin id (aikm.id); a mismatch fails manifest validation.
2. package.json needs an "aikm" object: id / version / apiVersion are required, version like 1.0.0, apiVersion "^1".
3. Declare main and/or client (main = main-process half, client.entry = UI half); paths must be relative to the plugin folder.
4. declares.slots must list every slot you use; unknown slots are rejected. Allowed slots:
   panel.main (main panel + its nav button), settings.tab (settings page tab), settings.card (card injected into an existing settings page, needs meta.target),
   swarm.workbench.tab (swarm workbench tab), chat.message.actions (per-message buttons).
5. Host capabilities require permissions (fs / shell / net / agent / llm); calling without declaring throws. Users must confirm the requested
   permissions when enabling the plugin, so ask only for what you need.
6. The UI half (client.entry) must be a single-file ESM with NO imports/requires: the host loads it as a Blob URL module, so bare specifiers
   (e.g. 'vue') cannot resolve. Vue is injected: take { h, defineComponent, ref, computed, watch, onMounted, onUnmounted, nextTick } from ctx.vue.
7. Every side effect must be disposable: timers / listeners / global shortcuts must be released in ctx.effect(() => cleanup) or a component's onUnmounted,
   otherwise they keep running after the plugin is disabled.
8. Call onMounted / onUnmounted inside a component's setup(); calling them outside warns "no component instance".
9. Ship zh + en copy via ctx.locale.pick({ zh: {...}, en: {...} }).
10. Follow the theme: use CSS variables --backgroundColor / --menuColor / --menuActiveColor / --borderColor / --fontColor / --fontActiveColor;
    add class="scoll" to scrollable containers (app-wide thin scrollbar). Native select/input need explicit compact size and foreground/background
    colours (the app-wide rule is 31px tall, width calc(100% - 10px); without explicit colours they render white-on-white in dark themes).
11. Panels must fill the width: use block-level wrappers; a single card inside a flex container will not stretch on the main axis.
12. Never grow the window: put content in a container with a max-height + overflow:auto so the panel scrolls internally.
13. Handle errors yourself: try/catch + ctx.log.warn(...) (plugin logs are in Plugins → Manage → Logs).
14. Do not inject global CSS or modify other parts of the app.`

/** API 速查（渲染成表格） */
export const PLUGIN_DEV_FACTS: readonly PluginDevFact[] = [
  {
    name: 'package.json → aikm.id / name / version / apiVersion',
    descZh: '插件 id（必须等于目录名）、显示名、版本、宿主 API 版本（写 "^1"）。',
    descEn: 'Plugin id (must equal the folder name), display name, version, host API version ("^1").',
  },
  {
    name: 'package.json → aikm.main',
    descZh: '主进程半边入口（如 index.mjs）：注册工具、提供/注入服务、访问 shell / net / 会话日志，用 ctx.storage 存私有数据。',
    descEn: 'Main-process half entry (e.g. index.mjs): register tools, provide/inject services, use shell / net / session logs, keep private data via ctx.storage.',
  },
  {
    name: 'package.json → aikm.client.entry',
    descZh: '界面半边入口（如 client.mjs）：单文件 ESM、无 import，导出 apply(ctx) 或默认导出 { apply }。',
    descEn: 'UI half entry (e.g. client.mjs): single-file ESM without imports, exporting apply(ctx) (or it as default).',
  },
  {
    name: 'package.json → aikm.inject',
    descZh: '依赖的宿主服务名（如 ["tools"]）；服务未就绪时插件停在 pending 不加载。',
    descEn: 'Required host services (e.g. ["tools"]); the plugin stays pending until they are ready.',
  },
  {
    name: 'package.json → aikm.permissions',
    descZh: '申请的权限：fs（文件）/ shell（执行命令）/ net（http(s) 请求）/ agent（会话日志）/ llm（大模型）。',
    descEn: 'Requested permissions: fs (files) / shell (commands) / net (http(s)) / agent (session logs) / llm (models).',
  },
  {
    name: 'package.json → aikm.declares.tools / declares.slots',
    descZh: '声明要注册的工具名与要用的槽位（槽位必须都在内置清单里）。',
    descEn: 'Declares the tool names you register and the slots you contribute to (all slots must be built-in).',
  },
  {
    name: 'ctx.slots.register("panel.main", { key, titleZh, titleEn, icon, order, component })',
    descZh: '加一个主面板 + 导航按钮（component 用 ctx.vue.defineComponent 定义）。',
    descEn: 'Add a main panel plus its nav button (build component with ctx.vue.defineComponent).',
  },
  {
    name: 'ctx.slots.register("settings.tab", { key, titleZh, titleEn, icon, meta: { group: "ui" }, component })',
    descZh: '在「设置 → 插件」分组里加一个设置页签（key 即 activeNav 值）。',
    descEn: 'Add a settings tab under the Plugins group (key becomes the activeNav value).',
  },
  {
    name: 'ctx.slots.register("settings.card", { component, meta: { target: "view" } })',
    descZh: '往已有设置页里插一块卡片（target 为该设置页 id，如 view / features）。',
    descEn: 'Inject a card into an existing settings page (target is that page id, e.g. view / features).',
  },
  {
    name: 'ctx.shortcuts.register("Ctrl+Shift+H", handler, { descriptionZh, descriptionEn })',
    descZh: '注册全局快捷键；输入框内默认不抢键。',
    descEn: 'Register a global shortcut; keys are not stolen while typing in inputs.',
  },
  {
    name: 'ctx.llm.chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs })',
    descZh: '调一次大模型（权限 llm）；ctx.llm.sources() / current() / models(source) 可用于下拉选择。',
    descEn: 'One-shot model call (permission llm); use sources() / current() / models(source) to build pickers.',
  },
  {
    name: 'ctx.files.pickFiles / pickDirectory / list / readText / renderPdfPage / openInApp',
    descZh: '文件能力（权限 fs）；PDF 会自动提取正文，renderPdfPage 把某页画成 PNG。只能访问用户在该插件里选过的路径。',
    descEn: 'File capability (permission fs); PDF text is extracted automatically and renderPdfPage rasterises a page to PNG. Only paths the user picked for this plugin are readable.',
  },
  {
    name: 'ctx.tts.speak(text, { stopPrevious }) / ctx.tts.stop() / ctx.tts.available / ctx.tts.reason',
    descZh: '用应用自带的 TTS 念一段文本（引擎 / 音色 / 语速跟随「设置 → 语音」，不需要权限）。不可用时用 reason 给出可读提示，语音失败不要影响主流程。',
    descEn: 'Speak text through the app’s own TTS (engine / voice / speed follow Settings → Voice; no permission needed). When unavailable show tts.reason, and never let a speech failure break the main flow.',
  },
  {
    name: 'ctx.app.agentPresets()',
    descZh: '只读：设置里配置的智能体预设清单（id / name），可用于让用户选角色。',
    descEn: 'Read-only list of configured agent presets (id / name) so users can pick a role.',
  },
  {
    name: '界面半边：ctx.config / ctx.log / ctx.notify / ctx.on / ctx.effect',
    descZh: '配置（设置页可编辑 JSON）、日志、轻提示、事件订阅、副作用登记（返回清理函数）；界面半边没有 storage，要持久化就用 localStorage（键名带插件 id 前缀）。',
    descEn: 'Config (editable JSON in settings), logs, toasts, event subscription, side-effect registration (returns a disposer). The UI half has no storage — persist via localStorage with a plugin-id-prefixed key.',
  },
  {
    name: '主进程半边：ctx.storage.{get,set,delete}',
    descZh: '插件私有键值存储（落在 userData/plugins-data/<插件 id>/storage.json）。',
    descEn: 'Private key/value storage (userData/plugins-data/<plugin id>/storage.json).',
  },
  {
    name: '主进程半边：ctx.tool({ name, description, inputSchema, handler })',
    descZh: '给智能体加一个工具（scope = plugin:<id>，出现在「设置 → 工具 → 注册表」，禁用插件即消失）。',
    descEn: 'Add an agent tool (scope = plugin:<id>, listed in Settings → Tools → Registry, disappears when disabled).',
  },
  {
    name: '主进程半边：ctx.service(name, value) / export const inject = [...]',
    descZh: '提供 / 依赖宿主或其它插件的服务。',
    descEn: 'Provide or depend on services from the host or other plugins.',
  },
  {
    name: '主进程半边：ctx.shell.runShell(command, { cwd }) / ctx.net.fetch(url, init) / ctx.sessions.list()',
    descZh: '分别需要 shell / net / agent 权限。',
    descEn: 'Require the shell / net / agent permissions respectively.',
  },
]

/** 常见问题 */
export const PLUGIN_DEV_FAQ: readonly PluginDevFaq[] = [
  {
    qZh: '启用时提示「界面扩展装载失败」',
    qEn: 'Enabling fails with “failed to load the UI extension”.',
    aZh: '看「插件 → 管理 → 日志」里的具体原因。最常见的是 client 半边写了 import / require（Blob 模块无法解析裸模块名），或用了模板语法需要编译（只能写渲染函数 h(...)）。',
    aEn: 'Check Plugins → Manage → Logs for the reason. Most often the UI half uses import/require (a Blob module cannot resolve bare specifiers) or template syntax (write render functions with h(...) instead).',
  },
  {
    qZh: '提示「槽位未声明：xxx」或清单校验失败',
    qEn: '“slot is not declared: xxx” or manifest validation fails.',
    aZh: 'declares.slots 要列全用到的槽位；id 必须等于目录名；version 要形如 1.0.0；apiVersion 写 "^1"。',
    aEn: 'List every slot in declares.slots; id must equal the folder name; version must look like 1.0.0; apiVersion must be "^1".',
  },
  {
    qZh: '调用 ctx.llm / ctx.files 报「未声明 llm/fs 权限」',
    qEn: 'ctx.llm / ctx.files complain the llm/fs permission is missing.',
    aZh: '把权限加进 permissions 数组，然后回「插件 → 管理」点重载（权限是加载时按清单判定的）。',
    aEn: 'Add it to the permissions array and hit Reload in Plugins → Manage (permissions are resolved from the manifest at load time).',
  },
  {
    qZh: '界面样式错乱 / 深色主题下白底白字',
    qEn: 'Broken styling, or white-on-white in dark themes.',
    aZh: '颜色一律用主题变量；select / input 自己设尺寸与前景背景色；滚动容器加 class="scoll"。',
    aEn: 'Use theme variables for colours, set explicit size and colours on select/input, and add class="scoll" to scrollable containers.',
  },
  {
    qZh: '面板被挤成一条或者撑出窗口',
    qEn: 'The panel collapses into a strip, or stretches the window.',
    aZh: '横向铺满要用块级外层（flex 容器里的单个子元素不会在主轴拉伸）；高度用 max-height + overflow:auto 让面板内部滚动。',
    aEn: 'Use block-level wrappers to fill the width (a lone flex child will not stretch on the main axis) and cap height with max-height + overflow:auto so the panel scrolls internally.',
  },
  {
    qZh: '改了文件什么时候生效',
    qEn: 'When do file changes take effect?',
    aZh: '宿主会监视插件目录并自动重载；也可以手动点「插件 → 管理」里的重载按钮。界面元素随注册/撤销即时出现或消失，不需要重启软件。',
    aEn: 'The host watches the plugin folder and reloads automatically; you can also press Reload in Plugins → Manage. UI contributions appear/disappear immediately — no app restart needed.',
  },
]

/** 「如何使用插件」给人看的步骤 */
export const PLUGIN_DEV_USAGE_ZH = `1) 安装：插件文件夹放进插件目录，或「设置 → 插件 → 管理 → 从文件夹安装」；插件目录可改成自己的文件夹（和技能一样），点「打开插件目录」即可查看。
2) 启用：点启用按钮 → 弹窗会列出该插件申请的权限（文件 / 执行命令 / 网络 / 会话日志 / 大模型），确认后才会加载。停用后它加的界面元素与工具立即消失。
3) 用它：
   · 主面板 —— 左侧或底部的导航栏会出现它的按钮（图标 + 名称）；
   · 设置页签 —— 出现在「设置 → 插件」分组下，点进去就是插件自己的设置页；
   · 智能体工具 —— 让智能体调用该工具名（如「用 hello_aikm 向我问好」），或在「设置 → 工具 → 注册表」里看到 plugin:<插件 id> 分组；
   · 快捷键 —— 插件会说明它用了哪些组合键，插件设置页里也能看到；
   · 集群工作台 / 聊天消息按钮 —— 出现在对应位置。
4) 配置：插件 → 管理 → 配置（JSON），保存后点重载生效。
5) 排障：插件 → 管理 → 日志（能看到它自己打的信息）；「详情」里有清单、槽位、权限与加载状态。
6) 卸载：点移除（可选择是否删除插件文件夹）。`

export const PLUGIN_DEV_USAGE_EN = `1) Install: drop the folder into the plugins folder, or use Plugins → Manage → Install from folder. The plugins folder can be moved to your own directory (like skills) — use “Open plugins folder”.
2) Enable: press Enable — a dialog lists the permissions it requests (files / commands / network / session logs / models). It loads only after you confirm. Disabling removes its UI contributions and tools instantly.
3) Use it:
   · Main panel — a button (icon + name) shows up in the left or bottom nav;
   · Settings tab — appears under the Plugins group in Settings;
   · Agent tools — ask the agent to call the tool name (e.g. “use hello_aikm to greet me”), or find plugin:<id> in Settings → Tools → Registry;
   · Shortcuts — documented by the plugin and visible on its settings tab;
   · Swarm workbench / chat message buttons — appear in place.
4) Configure: Plugins → Manage → Config (JSON), then hit Reload.
5) Troubleshoot: Plugins → Manage → Logs (what the plugin logged) and Details (manifest, slots, permissions, load state).
6) Remove: press Remove (optionally deleting the folder).`

/** 各段可复制指令 */
export const PLUGIN_DEV_SECTIONS: readonly PluginDevSection[] = [
  {
    key: 'general',
    titleZh: '通用开发指令（推荐：整段粘给大模型）',
    titleEn: 'General development prompt (paste this whole block into your model)',
    descZh:
      '把最后一行「这个插件要做什么」换成你的需求（越具体越好：界面长什么样、有哪些按钮、要存什么数据），连同整段一起发给大模型；它会产出可以直接放进插件目录的文件。',
    descEn:
      'Replace the last line (“what this plugin should do”) with your requirement — the more concrete the better (what the UI looks like, which buttons exist, what data is stored) — and send the whole block to your model. It returns files you can drop straight into the plugins folder.',
    bodyZh: `你是一名 AI-KM 桌面应用（Vue3 + Electron，本地优先的知识管理软件）的插件开发者。请为我实现一个可直接运行的 AI-KM 插件。

【交付物】只输出文件内容，按下面的格式给出每个文件，不要省略、不要写「此处略」：
=== package.json ===
{ ... }
=== client.mjs ===
（界面半边，可选）
=== index.mjs ===
（主进程半边，可选）
=== README.md ===
（一句话：这个插件做什么、怎么用、申请了哪些权限）

【插件要实现的功能】
<在这里用中文写清需求：插件名、界面布局、有哪些按钮与输入框、点击后发生什么、数据是否需要持久化、是否需要调用大模型或读取文件>

${CONSTRAINTS_ZH}

【宿主 API（照抄名字，不要臆造）】
界面半边 apply(ctx)：
- ctx.plugin → { id, name, version, dir }；ctx.config → 用户在「插件 → 配置」里保存的 JSON（只读快照）
- ctx.vue → { h, defineComponent, ref, shallowRef, reactive, computed, watch, watchEffect, onMounted, onUnmounted, onBeforeUnmount, nextTick, toRef, toRefs, markRaw, provide, inject, KeepAlive, Teleport, Transition, Fragment }
- ctx.locale.pick({ zh: {...}, en: {...} }) → 拿到跟随语言切换的文案对象
- ctx.log.{debug,info,warn,error}(...)、ctx.notify(message)（轻提示）
- ctx.shortcuts.register('Ctrl+Shift+H', handler, { descriptionZh, descriptionEn })
- ctx.slots.register(slot, { key, titleZh, titleEn, icon, order, component, meta })
- ctx.on(type, listener) → 返回取消订阅函数；ctx.effect(fn) → 登记副作用并自动清理
- ctx.llm（需要 llm 权限）：{ available, reason, sources(), current(), models(source), chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs }) }
- ctx.files（需要 fs 权限）：{ available, reason, pickFiles({ accept, multiple }), pickDirectory(), list(dir), readText(path), renderPdfPage(path, { page, scale, maxWidth }), openInApp(path, view) }
- ctx.app.agentPresets() → [{ id, name }]
主进程半边 apply(ctx)：
- export const inject = ['tools']（要用工具注册表时必须声明）
- ctx.tool({ name, description, inputSchema, handler })：inputSchema 是 JSON Schema；handler(input) 返回可 JSON 序列化的结果
- ctx.service(name, value)、ctx.on(type, listener)、ctx.effect(fn)、ctx.storage.{get,set,delete}
- ctx.log.*、ctx.host.notify(message)、ctx.shell.runShell(command, { cwd })、ctx.net.fetch(url, init)、ctx.sessions.list()

【实现要求】
1. 先给清单（package.json），再给代码；清单里的 id、目录名、文件名要互相一致，我会把目录名起成清单里的 id。
2. declares.tools / declares.slots 必须与代码里实际注册的一致。
3. 界面半边只用渲染函数（h(...)）写，不写模板字符串模板语法，不写 import。
4. 代码要有中文注释解释关键取舍（为什么这样设计），并在 README.md 里写清使用步骤。
5. 如果功能需要大模型，请把提示词写清楚，并对模型返回的 JSON 做容错（解析失败要有兜底，不能崩）。
6. 结束时自查一遍：权限是否都申请了、副作用是否都清理了、offline（模型不可用）时是否还能跑。`,
    bodyEn: `You are a plugin developer for AI-KM (a local-first knowledge management desktop app built with Vue 3 + Electron). Implement a ready-to-run AI-KM plugin for me.

[Deliverables] Output file contents only, in the format below, with nothing omitted and no “rest omitted” placeholders:
=== package.json ===
{ ... }
=== client.mjs ===
(UI half, optional)
=== index.mjs ===
(main-process half, optional)
=== README.md ===
(one line: what it does, how to use it, which permissions it requests)

[What the plugin must do]
<describe the requirement here: plugin name, UI layout, buttons and inputs, what happens on click, whether data must persist, whether it calls a model or reads files>

${CONSTRAINTS_EN}

[Host API — use these exact names, do not invent others]
UI half apply(ctx):
- ctx.plugin → { id, name, version, dir }; ctx.config → JSON saved by the user in Plugins → Config (read-only snapshot)
- ctx.vue → { h, defineComponent, ref, shallowRef, reactive, computed, watch, watchEffect, onMounted, onUnmounted, onBeforeUnmount, nextTick, toRef, toRefs, markRaw, provide, inject, KeepAlive, Teleport, Transition, Fragment }
- ctx.locale.pick({ zh: {...}, en: {...} }) → copy that follows the app language
- ctx.log.{debug,info,warn,error}(...), ctx.notify(message) (toast)
- ctx.shortcuts.register('Ctrl+Shift+H', handler, { descriptionZh, descriptionEn })
- ctx.slots.register(slot, { key, titleZh, titleEn, icon, order, component, meta })
- ctx.on(type, listener) → returns an unsubscribe function; ctx.effect(fn) → registers a disposable side effect
- ctx.llm (needs the llm permission): { available, reason, sources(), current(), models(source), chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs }) }
- ctx.files (needs the fs permission): { available, reason, pickFiles({ accept, multiple }), pickDirectory(), list(dir), readText(path), renderPdfPage(path, { page, scale, maxWidth }), openInApp(path, view) }
- ctx.app.agentPresets() → [{ id, name }]
Main-process half apply(ctx):
- export const inject = ['tools'] (required when using the tool registry)
- ctx.tool({ name, description, inputSchema, handler }): inputSchema is JSON Schema; handler(input) returns JSON-serialisable data
- ctx.service(name, value), ctx.on(type, listener), ctx.effect(fn), ctx.storage.{get,set,delete}
- ctx.log.*, ctx.host.notify(message), ctx.shell.runShell(command, { cwd }), ctx.net.fetch(url, init), ctx.sessions.list()

[Implementation requirements]
1. Manifest first, then code; ids/filenames must agree with each other, and I will name the folder after the manifest id.
2. declares.tools / declares.slots must match what the code registers.
3. Write the UI half with render functions h(...) only — no template syntax, no imports.
4. Add comments explaining key trade-offs and put usage steps in README.md.
5. If the feature needs a model, write a precise prompt and make JSON parsing fault-tolerant (a bad reply must not crash the plugin).
6. Self-check before answering: are all permissions declared, are all side effects disposable, and does it still work when no model is available?`,
  },
  {
    key: 'panel',
    titleZh: '界面插件模板：主面板 + 设置页签 + 快捷键',
    titleEn: 'UI plugin template: main panel + settings tab + shortcut',
    descZh: '适合「给我一个 xx 面板」这类需求。整段粘给大模型即可，最后一行写你要的面板长什么样。',
    descEn: 'For “give me a panel that does X” requests. Paste the whole block and fill in the last line.',
    bodyZh: `请为 AI-KM 写一个界面插件（只有 client 半边，不需要主进程代码）。

【要实现的界面】
<描述面板长什么样：几栏布局、有哪些控件、点击后做什么>

【插件信息】
- 插件 id / 目录名：<my-panel>
- 面板导航名：<面板名>（同时给英文名），图标用 FontAwesome 4 类名（如 "fa fa-heartbeat"）

${CONSTRAINTS_ZH}

【写法要点】
- client.mjs 结构：export function apply(ctx) { ... }，用 ctx.vue 的 h / defineComponent / ref / computed 写；
- 面板用 ctx.slots.register('panel.main', { key: '<my-panel>', titleZh, titleEn, icon, order: 900, component: Panel })；
- 如果有可配置项，再加一个设置页签：ctx.slots.register('settings.tab', { key: '<my-panel>-settings', titleZh: '我的面板', titleEn: 'My panel', icon: 'fa fa-cogs', meta: { group: 'ui' }, component: Settings })，
  设置项改动要立即生效并持久化（可用 localStorage，键名带插件 id 前缀，如 'aikm.plugin.my-panel.settings'）；
- 面板高度自适应：最外层 height:100%; box-sizing:border-box; display:flex; flex-direction:column，需要滚动的区域 class="scoll" + overflow-y:auto + min-height:0；
- 数字/文本输入框、下拉框都要显式设前景色与背景色（主题变量）并给紧凑尺寸；
- 别忘了在 settings 卡或面板上给出简短的使用提示（一句话），并在 README.md 写清用法。`,
    bodyEn: `Write a UI-only AI-KM plugin (client half only, no main-process code).

[UI to build]
<describe the panel: layout, controls, what clicking does>

[Plugin info]
- Plugin id / folder name: <my-panel>
- Panel nav title: <name> (also provide English), icon as a FontAwesome 4 class (e.g. "fa fa-heartbeat")

${CONSTRAINTS_EN}

[Implementation notes]
- client.mjs shape: export function apply(ctx) { ... }, written with h / defineComponent / ref / computed from ctx.vue.
- Register the panel with ctx.slots.register('panel.main', { key: '<my-panel>', titleZh, titleEn, icon, order: 900, component: Panel }).
- If there are settings, add ctx.slots.register('settings.tab', { key: '<my-panel>-settings', titleZh: 'My panel', titleEn: 'My panel', icon: 'fa fa-cogs', meta: { group: 'ui' }, component: Settings }); changes must apply immediately and persist (localStorage with a plugin-id-prefixed key such as 'aikm.plugin.my-panel.settings').
- Panel height: outer element height:100%; box-sizing:border-box; display:flex; flex-direction:column; scrollable areas need class="scoll" + overflow-y:auto + min-height:0.
- Set explicit foreground/background colours (theme variables) and compact sizes on every input/select.
- Add a one-line usage hint in the panel or its settings tab, and document usage in README.md.`,
  },
  {
    key: 'tool',
    titleZh: '工具插件模板：给智能体加一个工具',
    titleEn: 'Tool plugin template: add an agent tool',
    descZh: '适合「让智能体会做 xx」这类需求（主进程半边 + 可选设置页）。整段粘给大模型即可。',
    descEn: 'For “let the agent do X” requests (main-process half plus an optional settings tab). Paste the whole block.',
    bodyZh: `请为 AI-KM 写一个「工具插件」：给智能体新增一个可以调用的工具。

【工具要做什么】
<例如：把一段文字做统计并返回字数 / 调用本地 xxx 命令 / 读取某个目录下的文件清单>

【插件信息】
- 插件 id / 目录名：<my-tool>
- 工具名（蛇形命名，唯一）：<my_tool_action>；一句话描述（会展示给模型，直接影响它会不会用）

${CONSTRAINTS_ZH}

【写法要点】
- index.mjs：export const inject = ['tools']；export function apply(ctx) { ctx.tool({ name, description, inputSchema, handler }) }
- inputSchema 用 JSON Schema，字段写 description（模型靠它填参）；required 只放真正必需的字段；
- handler 里先校验参数（缺失/越界要返回可读错误，不要抛原始异常），再干活；返回 { ok: true, value: {...} } 或 { ok: false, error: '…' }；
- 需要 shell / net 权限时在清单里声明并在 handler 里捕获失败（返回可读错误）；
- 需要持久化（如计数、缓存）用 ctx.storage.{get,set,delete}；
- declares.tools 里列出工具名；如果工具需要用户配置（如目标目录、超时），加一个 settings.tab 界面半边把它们存进插件配置；
- README.md 里写一条示例指令（用户对智能体说什么就能触发这个工具）。`,
    bodyEn: `Write an AI-KM “tool plugin”: a new tool the agent can call.

[What the tool does]
<e.g. count characters of a text / call a local command / list files under a directory>

[Plugin info]
- Plugin id / folder name: <my-tool>
- Tool name (snake_case, unique): <my_tool_action>; one-line description (shown to the model — it decides whether the agent uses the tool)

${CONSTRAINTS_EN}

[Implementation notes]
- index.mjs: export const inject = ['tools']; export function apply(ctx) { ctx.tool({ name, description, inputSchema, handler }) }
- inputSchema is JSON Schema; give every field a description (the model fills arguments from it); keep “required” minimal.
- Validate arguments inside handler (return readable errors instead of throwing raw exceptions), then do the work; return { ok: true, value: {...} } or { ok: false, error: '…' }.
- If you need shell / net permissions declare them and catch failures (return readable errors).
- Persist counters/caches with ctx.storage.{get,set,delete}.
- List the tool name in declares.tools; if the tool needs user config (target folder, timeout…), add a settings.tab UI half that stores it in plugin config.
- Put one example instruction in README.md (what the user says to the agent to trigger it).`,
  },
  {
    key: 'llm-files',
    titleZh: '大模型 / 文件能力模板',
    titleEn: 'Model + file capability template',
    descZh: '适合「上传文件让大模型处理」「选一个文件夹批量分析」这类需求（需要 llm / fs 权限）。',
    descEn: 'For “upload a file and let the model process it” or “pick a folder and analyse it in bulk” (needs llm / fs).',
    bodyZh: `请为 AI-KM 写一个同时使用「大模型」与「文件」能力的插件。

【要做什么】
<例如：选一个 PDF → 提取正文 → 让大模型按指定要求给结论 → 结果可复制导出>

【插件信息】
- 插件 id / 目录名：<my-ai-plugin>；permissions: ["llm", "fs"]

${CONSTRAINTS_ZH}

【写法要点】
- 选文件/文件夹：ctx.files.pickFiles({ accept: 'pdf', multiple: false }) / ctx.files.pickDirectory()；返回的路径是后续唯一可读的路径（主进程只授权用户选过的文件）；
- 读文本：ctx.files.readText(path) → { text, pages, pdf }（PDF 由主进程提取正文，可能有页数/字数上限，按返回值展示真实页数）；
- 图片预览：ctx.files.renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, pageCount, width, height }，用 <img src=${'$'}{dataUrl} style="display:block;margin:0 auto;width:auto;height:auto;max-width:100%;max-height:100%"> 展示（预览框要 flex 居中并设 max-height，免得页面下方留空白）；
- 调模型：先检查 ctx.llm.available，不可用时在界面上给出可读原因（ctx.llm.reason）并允许降级；来源/模型下拉用 ctx.llm.sources() 与 ctx.llm.models(source)（本地服务可先拉清单），留空表示跟随设置；
- 提示词要求模型只输出 JSON，并写一个容错的解析函数（去代码块围栏、截取第一个 { … } / [ … ]，解析失败要给可读错误 + 原始回复前 600 字）；
- 需要语音时用 ctx.tts：先看 ctx.tts.available（false 时用 ctx.tts.reason 给提示），朗读用 await ctx.tts.speak(text, { stopPrevious: true })，并把它做成可开关的选项（不要默认开口）；
- 大文本要截断并告知用户（例如「取前 20000 字，共 N 字」），所有异步操作要有 busy 状态与按钮禁用，失败要能重试；
- 结果区与预览区都要在固定上限高度内滚动，不要撑大整个窗口。`,
    bodyEn: `Write an AI-KM plugin that uses both the model and file capabilities.

[What it does]
<e.g. pick a PDF → extract text → ask the model for a verdict → let the user copy/export the result>

[Plugin info]
- Plugin id / folder name: <my-ai-plugin>; permissions: ["llm", "fs"]

${CONSTRAINTS_EN}

[Implementation notes]
- Pick files/folders with ctx.files.pickFiles({ accept: 'pdf', multiple: false }) / ctx.files.pickDirectory(); only paths the user picked become readable (the main process authorises exactly those).
- Read text with ctx.files.readText(path) → { text, pages, pdf } (the main process extracts PDF text; honour any page/char limits and show the real page count).
- Preview pages with ctx.files.renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, pageCount, width, height }, rendered as <img src=${'$'}{dataUrl} style="display:block;margin:0 auto;width:auto;height:auto;max-width:100%;max-height:100%"> (centre the preview with flex and cap its height so no blank space is left below).
- Call the model after checking ctx.llm.available; when unavailable show ctx.llm.reason and degrade gracefully. Build source/model pickers from ctx.llm.sources() and ctx.llm.models(source) (local servers can list models first); an empty value means “follow the app setting”.
- Instruct the model to reply with JSON only and write a tolerant parser (strip code fences, take the first { … } / [ … ], and on failure show a readable error plus the first 600 characters of the raw reply).
- For speech use ctx.tts: check ctx.tts.available first (show ctx.tts.reason when false), speak with await ctx.tts.speak(text, { stopPrevious: true }), and put it behind an opt-in toggle — never speak by default.
- Truncate large text and tell the user (e.g. “first 20000 of N characters”); every async action needs a busy state, disabled buttons and a retry path.
- Keep result and preview panes scrollable inside a capped height — never grow the window.`,
  },
  {
    key: 'fix',
    titleZh: '排障指令：把日志交给大模型改',
    titleEn: 'Debug prompt: hand the logs to the model',
    descZh: '插件没生效 / 报错时，先复制「插件 → 管理 → 日志」里的报错，再复制这份指令，两者一起发给大模型。',
    descEn: 'When a plugin fails, copy the error from Plugins → Manage → Logs and send it together with this prompt.',
    bodyZh: `我的 AI-KM 插件加载/运行失败了。下面依次是：清单、插件代码、以及软件里「插件 → 管理 → 日志」中的报错。请定位原因并给出**完整可替换的文件**（不要只给 diff 片段）。

【日志】
<粘贴日志原文>

【插件目录名】
<my-plugin>

【package.json】
<粘贴>

【client.mjs / index.mjs】
<粘贴>

请按下面的顺序检查并说明：
1) 清单校验：id 是否等于目录名、version / apiVersion 格式、main / client 路径是否安全、declares.slots 是否都在内置清单内、permissions 是否都在 fs/shell/net/agent/llm 内；
2) 界面半边：有没有 import / require（Blob 模块无法解析）、有没有用模板语法（只能用渲染函数）、Vue API 是否都取自 ctx.vue、onMounted/onUnmounted 是否在 setup() 里调用；
3) 槽位注册：key 是否重复、条目字段是否齐全（panel.main 需要 key/titleZh/titleEn/icon/component）、meta.target 是否写对；
4) 权限：调用的能力是否都在 permissions 里声明；
5) 清理：定时器 / 监听 / 快捷键是否有对应的清理；
6) 运行时错误：把报错对应到具体代码行，并说明修法。

最后输出修正后的完整文件，并说明我该在软件里做什么（例如「插件 → 管理 → 重载」）才能验证。`,
    bodyEn: `My AI-KM plugin fails to load or run. Below are the manifest, the plugin code and the error from Plugins → Manage → Logs. Find the cause and give me **complete replacement files** (not diff snippets).

[Logs]
<paste logs>

[Plugin folder name]
<my-plugin>

[package.json]
<paste>

[client.mjs / index.mjs]
<paste>

Check and explain in this order:
1) Manifest: id equals folder name, version/apiVersion format, main/client paths safe, declares.slots all built-in, permissions all within fs/shell/net/agent/llm.
2) UI half: any import/require (a Blob module cannot resolve them), template syntax instead of render functions, Vue APIs taken from ctx.vue, onMounted/onUnmounted called inside setup().
3) Slot registration: duplicate keys, missing fields (panel.main needs key/titleZh/titleEn/icon/component), wrong meta.target.
4) Permissions: every capability used is declared.
5) Cleanup: timers/listeners/shortcuts have matching disposers.
6) Runtime errors: map the error to the exact line and explain the fix.

Then output the corrected complete files and tell me what to do in the app (e.g. Plugins → Manage → Reload) to verify.`,
  },
]

/** 从零开始的最小可用示例（和仓库 examples/plugins/hello-panel 一致） */
export const PLUGIN_DEV_MINIMAL_ZH = `目录（目录名必须等于 id）：
my-plugin/
├── package.json
└── client.mjs

package.json：
{
  "name": "my-plugin",
  "version": "1.0.0",
  "aikm": {
    "id": "my-plugin",
    "name": "我的插件",
    "version": "1.0.0",
    "apiVersion": "^1",
    "client": { "entry": "client.mjs" },
    "declares": { "slots": ["panel.main"] }
  }
}

client.mjs（单文件、无 import）：
export function apply(ctx) {
  const { h, defineComponent, ref } = ctx.vue
  const text = ctx.locale.pick({ zh: { title: '我的插件', hello: '你好' }, en: { title: 'My plugin', hello: 'Hello' } })
  const Panel = defineComponent({
    name: 'MyPanel',
    setup() {
      const count = ref(0)
      return () =>
        h('div', { style: 'height:100%;box-sizing:border-box;padding:10px;display:flex;flex-direction:column;gap:6px' }, [
          h('div', { style: 'font-size:14px;font-weight:600' }, text.value.title),
          h('div', { style: 'font-size:12px;opacity:.75' }, \`\${text.value.hello} × \${count.value}\`),
          h('button', { onClick: () => { count.value += 1; ctx.notify('+1') }, style: 'align-self:flex-start;padding:2px 10px;cursor:pointer' }, '+1'),
        ])
    },
  })
  ctx.slots.register('panel.main', { key: 'my-plugin', titleZh: '我的插件', titleEn: 'My plugin', icon: 'fa fa-puzzle-piece', order: 900, component: Panel })
}

装好后：把文件夹放进插件目录 →「设置 → 插件 → 管理」点启用 → 左侧导航出现「我的插件」。`

export const PLUGIN_DEV_MINIMAL_EN = `Folder (the folder name must equal the id):
my-plugin/
├── package.json
└── client.mjs

package.json:
{
  "name": "my-plugin",
  "version": "1.0.0",
  "aikm": {
    "id": "my-plugin",
    "name": "My plugin",
    "version": "1.0.0",
    "apiVersion": "^1",
    "client": { "entry": "client.mjs" },
    "declares": { "slots": ["panel.main"] }
  }
}

client.mjs (single file, no imports):
export function apply(ctx) {
  const { h, defineComponent, ref } = ctx.vue
  const text = ctx.locale.pick({ zh: { title: '我的插件', hello: '你好' }, en: { title: 'My plugin', hello: 'Hello' } })
  const Panel = defineComponent({
    name: 'MyPanel',
    setup() {
      const count = ref(0)
      return () =>
        h('div', { style: 'height:100%;box-sizing:border-box;padding:10px;display:flex;flex-direction:column;gap:6px' }, [
          h('div', { style: 'font-size:14px;font-weight:600' }, text.value.title),
          h('div', { style: 'font-size:12px;opacity:.75' }, \`\${text.value.hello} × \${count.value}\`),
          h('button', { onClick: () => { count.value += 1; ctx.notify('+1') }, style: 'align-self:flex-start;padding:2px 10px;cursor:pointer' }, '+1'),
        ])
    },
  })
  ctx.slots.register('panel.main', { key: 'my-plugin', titleZh: '我的插件', titleEn: 'My plugin', icon: 'fa fa-puzzle-piece', order: 900, component: Panel })
}

Then: drop the folder into the plugins folder → enable it in Settings → Plugins → Manage → “My plugin” appears in the nav.`
