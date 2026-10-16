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
 * 另外：设置页签的**一级分组 id 与设置页 id 清单**来自
 *   - src/components/set/Set.vue 的 navTree（改动设置导航时，请同步「设置页签 / 设置卡片模板」一节、
 *     速查表的两行与 FAQ 里那份清单；分组 id 写错会让插件多出一个同名的「插件」一级菜单）
 * 模板 key 清单同时被 electron/main/plugin-dev-guide.ts 的 PLUGIN_DEV_TEMPLATE_KEYS 与
 * plugin_dev_templates 的工具说明引用（新增模板小节时三处一起改）。
 */

/** 一段可复制的指令 / 说明 */
export interface PluginDevSection {
  key: string
  /** 小节标题 */
  titleZh: string
  titleEn: string
  /** 页签上的短标题（管理页用页签切换栏目，长标题放不下） */
  tabZh: string
  tabEn: string
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
 * 导出原因：核心工具 `plugin_dev_guide`（主进程）也要原样交给模型，见 electron/main/plugin-dev-guide.ts。
 */
export const CONSTRAINTS_ZH = `【必须遵守的硬约束（宿主会校验或直接失败）】
1. 目录名必须等于插件 id（清单里的 aikm.id），且**只能用 ASCII 小写字母开头、只含 [a-z0-9._-]**（如 my-plugin）：
   目录名是中文 / 含大写 / 含空格时宿主直接跳过这个文件夹（插件不会出现在列表里），id 与目录名不一致也会校验失败。
   插件名称、界面文案要用中文就写在 aikm.name 与 ctx.locale 里，别写进 id / 目录名、也别写进工具名（工具名必须蛇形 ASCII）。
2. package.json 必须含 aikm 字段：id / version / apiVersion 必填，version 形如 1.0.0，apiVersion 写 "^1"。
3. main 与 client 至少声明一个（main = 主进程半边，client.entry = 界面半边），路径必须是插件目录内的相对路径。
4. declares.slots 必须列全你要用的所有槽位，出现未知槽位会被拒绝；只允许这些槽位：
   panel.main（主面板 + 导航按钮）、settings.tab（设置页签）、settings.card（插到已有设置页的卡片，需 meta.target）、
   swarm.workbench.tab（集群工作台页签）、chat.message.actions（聊天消息级按钮）。
   settings.tab 的 key 就是设置页 id（用 plugin-<插件 id> 前缀，别占用内置页 id），**meta.group 只能填已存在的一级分组 id（省略即内置「插件」分组，填不存在的 id 会多出一个同名「插件」一级菜单）**；
   settings.card 的 meta.target 必填（内置设置页 id），不写会出现在所有设置页。细节与完整示例见「设置页签 / 设置卡片模板」一节。
5. 用到宿主能力必须声明 permissions（清单见 plugin_dev_host）；未声明就调用会直接抛错。
   启用插件时软件会把申请的权限列给用户确认，所以不要多申请。
   **fs 不等于能读任意路径**：只能读「用户在该插件里选过」的文件 / 文件夹，选过一次就记住
   （跨重启有效，可在「插件 → 数据」撤销）。所以流程必须是 pickFiles() / pickDirectory() 让用户选一次 →
   把路径存进 localStorage（键名带 aikm.plugin.<插件 id>. 前缀）→ 之后直接读；**写死绝对路径一定读不到**（报「未授权访问」）。
   **写文件要用户单独授权一个「可写」文件夹**（ctx.files.pickWritableDirectory()，或设置页的「允许写入某文件夹…」）：
   只读授权下写入一律被拒，越界（兄弟目录 / 写死的绝对路径）也一律拒绝；ctx.host.writeFile 只能写**插件自己的目录**。
6. 界面半边（client.entry 指向的文件）必须是**单文件 ESM 且没有任何 import/require**：
   宿主把源码包成 Blob URL 再 import，裸模块名（比如 'vue'）在 Blob 模块里无法解析。
   Vue 运行时由宿主注入：apply(ctx) 里从 ctx.vue 取 { h, defineComponent, ref, computed, watch, onMounted, onUnmounted, nextTick } 等。
   界面半边**只有** ctx.vue 文档里列出的成员：**没有 ctx.service / ctx.mcp**（MCP 服务只给智能体用），也**没有 ctx.files.readFile**（读文件用 pickFiles/readText/readBase64/readSheet）——写不存在的 API 会在运行时直接抛错。
7. 所有副作用必须可清理：定时器 / 事件监听 / 全局快捷键都要在 ctx.effect(() => 清理函数) 或组件的 onUnmounted 里撤销，
   否则禁用插件后它们还在跑（宿主只在卸载时撤销它自己记录的东西）。
8. 组件的 onMounted / onUnmounted 必须在 defineComponent 的 setup() 里调用；在 setup 之外调用会报「无组件实例」。
9. 文案中英双语：用 ctx.locale.pick({ zh: {...}, en: {...} })，不要在界面里写死中文。
   ⚠️ **pick() / ref() 返回的是 ref（响应式对象），不是字符串**：取值必须写 text.value.title（切语言会自动更新）。
   把它直接丢进 ctx.notify(...)、拼进模板字符串或与其它字符串相加，界面 / 提示里就会显示 "[object Object]"。
   **提示只收字符串**：要一次性字符串用 ctx.locale.t(dict, 'key', { 参数 })，或先取 text.value.x 再自己拼。
10. 样式必须跟随主题：颜色用 CSS 变量 --backgroundColor / --menuColor / --menuActiveColor / --borderColor /
    --fontColor / --fontActiveColor；需要滚动的容器加 class="scoll"（应用统一细滚动条）。
    原生 select / input 必须自己设紧凑宽度与显式前景/背景色（软件全局样式给的是 31px 高、宽度 calc(100%-10px)，深色主题下不设颜色会白底白字）。
    ⚠️ **canvas / 图表是例外**：canvas 2D 的 fillStyle / strokeStyle **不认 CSS 变量**（写 'var(--fontColor)' 会被静默忽略，
    表现为图表文字看不见或整块空白）。要真实颜色就
    getComputedStyle(document.documentElement).getPropertyValue('--fontColor')，或直接写固定色值。
    ⚠️ **图表必须由数据驱动重画——只在按钮点击里画，用户看到的就是空白**：用 watch(data, () => draw(), { flush: 'post' })
    与 watch(viewMode, …) 在数据 / 视图变化后重画（或 await nextTick() 再画），别把绘制只挂在「挂载后的一个 setTimeout」上
    （数据比定时器慢，就永远不画）；有多个图时**每个图各自判自己的 canvas**（if (!pieEl) return 只允许拦「当前要画的这个图」，
    否则切到柱状图后一次都画不出来）；ResizeObserver 要观察**已经挂上 DOM 的** canvas（在 ref 回调里 observe，或 nextTick 后再 observe），
    尺寸变了就重画；每次绘制都用 try/catch + ctx.log.warn 包住——一次抛错会中断整次绘制，用户只看到半张图或整块空白。
11. 面板要横向铺满：外层用块级容器，不要在 flex 容器里只放一个卡片（flex 子元素在主轴方向不会被拉伸，卡片会缩成内容宽）。
12. 面板高度不能撑大整个窗口：内容放在固定上限高度 + overflow:auto 的容器里，让面板内部滚动。
13. 错误要自己兜住：try/catch + ctx.log.warn(...)，不要只 console.log（插件日志在「插件 → 管理 → 日志」里看）。
    绘图 / 解析这类「一抛错就整块空白」的代码尤其要包起来——canvas 绘制循环里一个变量名写错就会中断整次绘制，
    用户只看到空白、日志里什么都没有，极难排查。
14. 不要往界面里注入全局 CSS、不要改应用其它部分；插件只负责自己那部分 UI。
15. **只调用本指南列出的宿主 API，不要凭名字猜**：两个半边各有一套 ctx，且**不能混用**——
    界面半边（client.mjs）：plugin / config / vue / locale / llm / files / app / tts / shortcuts / slots / on / effect / notify / log；
    主进程半边（index.mjs）：plugin / config / tool / service / getService / on / effect / host / storage / log。
    也就是说界面半边**没有** ctx.service / ctx.mcp / ctx.host / ctx.storage / ctx.tool，主进程半边**没有** ctx.vue / ctx.files / ctx.slots。
    真实翻车案例（都会在运行时抛 "is not a function"，面板表现为什么都不显示）：ctx.files.readFile、ctx.service('office', …)、
    ctx.mcp.call、ctx.llm.chatStream。
    并且要**按它标注的异步性与返回形状**用：
    · ctx.files.* 全部是**异步**（pickFiles / pickDirectory / list / readText / readBase64 / readSheet / renderPdfPage / openInApp）——
      必须写成 const res = await ctx.files.readSheet(path)；漏 await 不会报错，但 res.sheets 是 undefined，面板只会显示「文件为空」。
    · pickFiles() 返回 { cancelled, files: [{ path, name, size }] }，**不是路径数组**：取消时 cancelled === true 且**不抛错**，
      路径取 res.files[0].path；别用 try/catch 判取消（也不要判 e.message === 'cancelled'），别传 titleZh/titleEn 之类的自造参数。
    · ctx.llm.models() / ctx.llm.chat() 同样是异步；返回结构见速查表。
    交付前用 plugin_dev_check 自检，它会逐条报出「宿主没有这个成员 / 漏 await / 返回形状用错 / 观察器没断开」并列出可用成员。`

export const CONSTRAINTS_EN = `[Hard constraints the host enforces]
1. The folder name must equal the plugin id (aikm.id) and be ASCII lowercase: it must start with [a-z0-9] and contain only
   [a-z0-9._-] (e.g. my-plugin). A folder named in Chinese, with uppercase letters or spaces is skipped entirely (the plugin never
   appears in the list); a mismatch between id and folder name fails manifest validation. Put Chinese in aikm.name and ctx.locale —
   never in the id / folder name or in tool names (tool names must be snake_case ASCII).
2. package.json needs an "aikm" object: id / version / apiVersion are required, version like 1.0.0, apiVersion "^1".
3. Declare main and/or client (main = main-process half, client.entry = UI half); paths must be relative to the plugin folder.
4. declares.slots must list every slot you use; unknown slots are rejected. Allowed slots:
   panel.main (main panel + its nav button), settings.tab (settings page tab), settings.card (card injected into an existing settings page, needs meta.target),
   swarm.workbench.tab (swarm workbench tab), chat.message.actions (per-message buttons).
   A settings.tab key is the settings page id (prefix it with plugin-<plugin id>, never reuse a built-in page id) and **meta.group may only be an existing top-level group id (omit it for the built-in Plugins group; a non-existent id adds a second “Plugins” top-level menu)**;
   settings.card requires meta.target (a built-in settings page id) — without it the card appears on every settings page. See the “Settings tab / card template” section for the full example.
5. Host capabilities require permissions (the full list is in plugin_dev_host's output — it is generated from what this build actually supports); calling without declaring throws. Users must confirm the requested
   permissions when enabling the plugin, so ask only for what you need.
   **fs does not mean “any path”**: only files/folders the user picked *inside that plugin* are readable, and a pick is remembered
   (it survives a restart; the user can revoke it under Plugins → Data). So the flow is pickFiles() / pickDirectory() → store the path in
   localStorage (key prefixed with aikm.plugin.<plugin id>.) → read it directly. **A hard-coded absolute path is never readable** (“not authorised”).
6. The UI half (client.entry) must be a single-file ESM with NO imports/requires: the host loads it as a Blob URL module, so bare specifiers
   (e.g. 'vue') cannot resolve. Vue is injected: take { h, defineComponent, ref, computed, watch, onMounted, onUnmounted, nextTick } from ctx.vue.
   The UI half has **only** the members documented for ctx: there is **no ctx.service / ctx.mcp** (MCP services are agent-only) and **no
   ctx.files.readFile** (use pickFiles / readText / readBase64 / readSheet) — inventing APIs throws at runtime.
7. Every side effect must be disposable: timers / listeners / global shortcuts must be released in ctx.effect(() => cleanup) or a component's onUnmounted,
   otherwise they keep running after the plugin is disabled.
8. Call onMounted / onUnmounted inside a component's setup(); calling them outside warns "no component instance".
9. Ship zh + en copy via ctx.locale.pick({ zh: {...}, en: {...} }).
   ⚠️ **pick() / ref() return a ref (a reactive object), not a string**: read values as text.value.title (updates with the app language).
   Feeding one straight into ctx.notify(...), a template literal or string concatenation renders "[object Object]" in the UI.
   **notify only takes a string**: use ctx.locale.t(dict, 'key', { params }) for a one-off string, or read text.value.x first.
10. Follow the theme: use CSS variables --backgroundColor / --menuColor / --menuActiveColor / --borderColor / --fontColor / --fontActiveColor;
    add class="scoll" to scrollable containers (app-wide thin scrollbar). Native select/input need explicit compact size and foreground/background
    colours (the app-wide rule is 31px tall, width calc(100% - 10px); without explicit colours they render white-on-white in dark themes).
    ⚠️ **canvas / charts are the exception**: canvas 2D **does not resolve CSS variables** — fillStyle = 'var(--fontColor)' is silently
    ignored (chart labels end up invisible, or the whole canvas looks blank). Use a literal colour, or read the real value with
    getComputedStyle(document.documentElement).getPropertyValue('--fontColor').
    ⚠️ **Charts must be redrawn when the data changes — painting only from a button click leaves the panel blank**:
    redraw from watch(data, () => draw(), { flush: 'post' }) and watch(viewMode, …) (or await nextTick() first), never from a lone
    setTimeout after mount (if the data arrives later than the timer, nothing is ever painted). With several charts, **each draw
    must check its own canvas** (if (!pieEl) return may only guard the chart you are drawing, otherwise the bar chart never renders);
    observe **an already-mounted** canvas with ResizeObserver (observe inside the ref callback, or after nextTick) and redraw on size
    changes; wrap every paint in try/catch + ctx.log.warn — one throw aborts the whole paint, leaving a half-drawn chart or a blank area.
11. Panels must fill the width: use block-level wrappers; a single card inside a flex container will not stretch on the main axis.
12. Never grow the window: put content in a container with a max-height + overflow:auto so the panel scrolls internally.
13. Handle errors yourself: try/catch + ctx.log.warn(...) (plugin logs are in Plugins → Manage → Logs). This matters most for drawing /
    parsing code, where one thrown error blanks the whole panel: a single typo’d variable inside the canvas draw loop aborts the entire
    paint, leaving an empty area with nothing in the logs.
14. Do not inject global CSS or modify other parts of the app.
15. **Only call the host APIs listed in this guide — never invent one from its name.** Each half has its own ctx and they are *not*
    interchangeable. UI half (client.mjs): plugin / config / vue / locale / llm / files / app / tts / shortcuts / slots / on / effect /
    notify / log. Main-process half (index.mjs): plugin / config / tool / service / getService / on / effect / host / storage / log.
    So the UI half has **no** ctx.service / ctx.mcp / ctx.host / ctx.storage / ctx.tool, and the main half has **no** ctx.vue / ctx.files /
    ctx.slots. Real failures (each throws “is not a function” and leaves the panel blank): ctx.files.readFile, ctx.service('office', …),
    ctx.mcp.call, ctx.llm.chatStream. Correct calls: read a spreadsheet with ctx.files.readSheet(path), raw bytes with
    ctx.files.readBase64(path), text with ctx.files.readText(path), and ask the user to pick a file with
    ctx.files.pickFiles({ accept: 'any' }).
    Also follow the documented **async-ness and return shapes**:
    · every ctx.files.* method is **async** (pickFiles / pickDirectory / list / readText / readBase64 / readSheet /
      renderPdfPage / openInApp) — always write const res = await ctx.files.readSheet(path). A missing await raises no error,
      but res.sheets is undefined and the panel just says “file is empty”.
    · pickFiles() returns { cancelled, files: [{ path, name, size }] }, **not an array of paths**: cancellation sets
      cancelled === true and **does not throw**, so take res.files[0].path and never detect cancellation with try/catch
      (nor by checking e.message === 'cancelled'), and do not invent options such as titleZh / titleEn.
    · ctx.llm.models() / ctx.llm.chat() are async too; see the cheat sheet for their result shapes.
    Run plugin_dev_check before delivering — it reports every member the host does not have, every missing await, wrong
    return shape and undisconnected observer, together with the members that do exist.`

/** API 速查（渲染成表格） */
export const PLUGIN_DEV_FACTS: readonly PluginDevFact[] = [
  {
    name: 'package.json → aikm.id / name / version / apiVersion',
    descZh: '插件 id（必须是 ASCII 小写 [a-z0-9._-] 且等于目录名）、显示名（可用中文）、版本、宿主 API 版本（写 "^1"）。',
    descEn: 'Plugin id (ASCII lowercase [a-z0-9._-], must equal the folder name), display name (Chinese is fine here), version, host API version ("^1").',
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
    name: 'ctx.slots.register("settings.tab", { key, titleZh, titleEn, icon, order, component })',
    descZh: '在「设置 → 插件」分组里加一个设置页签（key 即 activeNav 值）。规则：① key 在 settings.tab 槽位内必须**全局唯一**（重复直接抛「key 重复」），用 plugin-<插件 id> 这种前缀，且**不要占用内置设置页 id**（view / features / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help），否则导航里出现两个同 id 项、右侧同时渲染内置页与你的页签；② **meta.group 只能填已存在的一级分组 id**：base-group 通用 / llm-group 模型 / collab-group 协作 / ai-group 语音 / service-group 工具 / plugin-group 插件 / skill-group 技能 / agent-group 智能体；**省略 meta.group 即 plugin-group（内置「插件」分组）**，填别的 id（如 "ui"）会新建一个标题为「插件」的同名一级分组。',
    descEn: 'Add a settings tab under the Plugins group (key is the activeNav value). Rules: ① the key must be **globally unique** inside the settings.tab slot (a duplicate throws “duplicate key”) — prefix it with plugin-<plugin id> and **never reuse a built-in page id** (view / features / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help), otherwise the nav shows two entries with the same id and the right pane renders both pages; ② **meta.group may only be an existing top-level group id**: base-group / llm-group / collab-group / ai-group / service-group / plugin-group / skill-group / agent-group — **omitting it means plugin-group (the built-in Plugins group)**, while any other id (e.g. "ui") creates a second top-level group titled “Plugins”.',
  },
  {
    name: 'ctx.slots.register("settings.card", { key, component, meta: { target: "view" } })',
    descZh: '往**已有**设置页里插一块卡片。**meta.target 必填**，取值是内置设置页 id（view / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help；旧 id features 已并入 view，写 features 也会显示在基础页），也可写数组同时插多页（{ target: ["view", "data"] }）；**不写 target 会出现在所有设置页**（包括插件商店这类不相干的页面）。',
    descEn: 'Inject a card into an **existing** settings page. **meta.target is mandatory** and takes a built-in settings page id (view / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help; the old id "features" was merged into "view" and still lands on the Basic page), or an array to inject into several pages ({ target: ["view", "data"] }); **without target the card shows up on every settings page** (including unrelated ones such as the plugin store).',
  },
  {
    name: 'ctx.shortcuts.register("Ctrl+Shift+H", handler, { descriptionZh, descriptionEn })',
    descZh: '注册全局快捷键；输入框内默认不抢键。',
    descEn: 'Register a global shortcut; keys are not stolen while typing in inputs.',
  },
  {
    name: 'ctx.locale.pick(dict) / ref(dict, key) / t(dict, key, params) / fixed(dict, language) / language',
    descZh: '文案（中英双语）。**pick(dict) 与 ref(dict, key) 返回的是 ref，不是字符串**：写 const text = ctx.locale.pick({ zh: {...}, en: {...} })，取值用 text.value.title（切语言自动更新）；要一次性字符串用 t(dict, "key", { name }) 或 fixed(dict, "zh" | "en")。**把 ref 传给 ctx.notify()、拼进模板字符串或与字符串相加，界面 / 提示里就会显示 "[object Object]"**（真实翻车点）。en 缺项时逐项回退中文。',
    descEn: 'Localised copy (zh + en). **pick(dict) and ref(dict, key) return a ref, not a string**: write const text = ctx.locale.pick({ zh: {...}, en: {...} }) and read text.value.title (updates with the app language); for a one-off string use t(dict, "key", { name }) or fixed(dict, "zh" | "en"). **Passing a ref to ctx.notify(), into a template literal or into string concatenation renders "[object Object]"** (a real failure mode). Missing en entries fall back to Chinese per key.',
  },
  {
    name: 'ctx.llm.chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs })',
    descZh: '调一次大模型（权限 llm）；ctx.llm.sources() / current() / models(source) 可用于下拉选择。',
    descEn: 'One-shot model call (permission llm); use sources() / current() / models(source) to build pickers.',
  },
  {
    name: 'ctx.files.pickFiles / pickDirectory / pickWritableDirectory / list / readText / readBase64 / readBytes / readSheet / renderPdfPage / openInApp / writeText / remove',
    descZh: '文件能力（权限 fs）。**这些方法全部返回 Promise，必须 await**；返回形状：pickFiles({ accept: "any"|"pdf"|"text", multiple }) → { cancelled, files: [{ path, name, size }] }（**取消时 cancelled=true，不抛错**，路径取 files[0].path）；readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] }（.xlsx/.xls/.csv，**界面半边没有 SheetJS，读表就用它**）；readText(path) → { text, pages, pdf }（PDF 自动提取正文）；readBase64(path) → { base64, size }；**readBytes(path) → { bytes: Uint8Array, size }**（几十 MB 的大文件——ROM / 模型——用它：走 base64 会多 1/3 体积、还要在 JS 里编码再解码一遍，安卓上明显更慢）；list(dir) → { dir, entries: [{ name, path, isDir, size }] }（**一次最多 500 项**）；renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, … }。只能访问用户在该插件里**选过**的路径，选过一次会记住（跨重启有效，用户可在「插件 → 数据」撤销）。',
    descEn: 'File capability (permission fs). **Every method returns a Promise — always await.** Shapes: pickFiles({ accept: "any"|"pdf"|"text", multiple }) → { cancelled, files: [{ path, name, size }] } (**cancellation sets cancelled=true, it does not throw**; take files[0].path); readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] } (.xlsx/.xls/.csv — **the UI half has no SheetJS, use this**); readText(path) → { text, pages, pdf }; readBase64(path) → { base64, size }; **readBytes(path) → { bytes: Uint8Array, size }** (use it for tens-of-MB files — ROMs, models — base64 costs a third more bytes plus an encode and a decode in JS, which is noticeably slower on Android); list(dir) → { dir, entries: [{ name, path, isDir, size }] } (**at most 500 entries at a time**); renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, … }. Only paths the user picked for this plugin are readable, and a pick is remembered (it survives a restart; the user can revoke it under Plugins → Data).',
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
    name: 'ctx.agent.available / reason / presets() / run(presetId, input, opts) / cancelAll()',
    descZh: '委派智能体（界面半边专有）：按用户配好的**预设**跑一次独立会话，返回 { ok, termination, output, error?, turn, usage? }。'
      + '需要 permissions: [\'agent.run\']（与只读的 \'agent\' 是**两件事**，不能互相顶替），且**只在桌面端可用**（网页 / 移动端 available=false，用 reason 说明）。'
      + 'opts 可申请 timeoutMs / maxSteps，并可用 systemPrompt、tools、mcpServerIds **覆盖**预设的系统提示词 / 工具白名单 / MCP 服务（按 id 引用用户已配置并启用的服务）。'
      + '**模型与密钥不可选**（provider / model 一律来自预设）；覆盖只是**申请** —— 工具由宿主按你的权限裁剪，默认不给文件 / MCP 工具。'
      + '**只有 termination === \'completed\' 才算成功**（ok 由它决定）；失败时 output 是中止前的部分输出。'
      + '\n  预算 / 权限被拒 / 委派拿不到工具的原因与做法，见 plugin_dev_faq。',
    descEn: 'Delegate to an agent (UI half only): run one isolated session using a user-configured **preset**, returning '
      + '{ ok, termination, output, error?, turn, usage? }. Requires permissions: [\'agent.run\'] (a **different** thing from the read-only \'agent\'), '
      + 'and is **desktop-only** (on web/mobile available=false with a reason). Only termination === \'completed\' counts as success; '
      + 'on failure output is the partial text captured before the stop. See plugin_dev_faq for budget / denial / tool-stripping details.',
  },
  {
    name: '界面半边：ctx.config / ctx.log / ctx.notify(message) / ctx.on / ctx.effect',
    descZh: '配置（设置页可编辑 JSON）、日志、轻提示、事件订阅、副作用登记（返回清理函数）。**ctx.notify(message) 只接受字符串**——传 ref / 对象进去，用户看到的提示就是 "[object Object]"（先取 .value 再传）。界面半边没有 storage，要持久化就用 localStorage（键名带插件 id 前缀）。',
    descEn: 'Config (editable JSON in settings), logs, toasts, event subscription, side-effect registration (returns a disposer). **ctx.notify(message) only accepts a string** — pass a ref or an object and the toast reads "[object Object]" (read .value first). The UI half has no storage — persist via localStorage with a plugin-id-prefixed key.',
  },
  {
    name: '主进程半边：ctx.storage.{get,set,delete}',
    descZh: '插件私有键值存储（落在 userData/plugins-data/<插件 id>/storage.json）。',
    descEn: 'Private key/value storage (userData/plugins-data/<plugin id>/storage.json).',
  },
  {
    name: '主进程半边：ctx.tool({ name, description, inputSchema, handler, requiresApproval })',
    descZh: '给智能体加一个工具（scope = plugin:<id>，出现在「设置 → 工具 → 注册表」，禁用插件即消失）。'
      + '**声明了 fs / shell 权限的插件，其工具默认需要用户确认**（requiresApproval 默认 true）：'
      + '用户在「插件 → 权限 → 工具审批」里选"每次询问 / 已允许 / 已拒绝"；'
      + '被拒绝时工具调用会返回 `{ ok: false, error }`（不是抛异常），所以你的 handler 不必处理它，但**不要假设工具一定被执行**。',
    descEn: 'Add an agent tool (scope = plugin:<id>; listed in Settings → Tools → Registry; disappears when disabled). '
      + '**Plugins that declare fs / shell get user confirmation by default** (requiresApproval defaults to true): the user picks ask / allow / deny under Plugins → Permissions → Tool approval. '
      + 'A denial comes back as `{ ok: false, error }` (not a thrown error), so never assume your handler ran.',
  },
  {
    name: '主进程半边：ctx.service(name, value) / export const inject = [...]',
    descZh: '提供 / 依赖宿主或其它插件的服务。',
    descEn: 'Provide or depend on services from the host or other plugins.',
  },
  {
    name: '主进程半边：ctx.host.granted.{list, readText, writeText, listDir, remove} / ctx.host.runShell(command, { cwd }) / ctx.host.fetch(url, init) / ctx.host.sessions.list()',
    descZh: '`ctx.host.granted.*` = **用户授权过的路径**内的读写（需 fs 权限）：授权目录覆盖其子树，**写只认"可写"授权**（只读授权下写入被拒，错误里会说明），越界一律拒绝；`ctx.host.readFile / writeFile / listDir` 只能碰**插件自己的目录**，别拿它当万能写。runShell / fetch / sessions 分别需要 shell / net / agent 权限。',
    descEn: '`ctx.host.granted.*` reads/writes inside the **paths the user granted** (needs fs): a granted folder covers its subtree and **writes require a writable grant** (a read-only grant refuses writes with an explanatory error); anything outside is rejected. `ctx.host.readFile / writeFile / listDir` only touch **the plugin’s own folder**. runShell / fetch / sessions need the shell / net / agent permissions.',
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
    qZh: 'ctx.agent.run 报「未声明 agent.run 权限」/ 明明声明了 agent 却还是被拒 / available 是 false',
    qEn: 'ctx.agent.run says the agent.run permission is missing, or declares agent and is still refused, or available is false.',
    aZh: '三个不同的原因，分开查：'
      + '\n  ① 权限：`agent.run` 与只读的 `agent`（读会话日志）是**两个独立权限**，声明了后者不等于能跑前者——'
      + '这是刻意的，否则老插件会静默获得"花你钱"的能力。要跑就在 permissions 里单独加 `"agent.run"`，然后重载插件。'
      + '\n  ② 平台：委派**只在桌面端可用**。网页 / 移动端的本地宿主没有主进程来执行预算，所以 `available === false`，'
      + '`reason` 会写明原因。插件应当判断 available，并在界面上给用户一句人话，不要直接抛错。'
      + '\n  ③ 用户没允许：首次调用会弹一个主进程对话框（允许 / 每次都问 / 拒绝）。用户选「拒绝」后，'
      + '返回的是 `{ ok: false, termination: \'consent-denied\' }` —— **不是异常**，别当成 bug；'
      + '用户可以在「插件 → 数据」里改回来。',
    aEn: 'Three distinct causes — check them separately: (1) `agent.run` and the read-only `agent` (session logs) are **separate permissions**; declaring the latter does not grant the former (deliberate, so existing plugins do not silently gain the ability to spend your quota). Add `"agent.run"` and reload. '
      + '(2) Delegation is **desktop-only**: on web/mobile there is no main process to enforce the budget, so `available === false` and `reason` explains it — check availability and show the user a sentence instead of throwing. '
      + '(3) The user has not allowed it: the first call shows a main-process dialog (allow / ask every time / deny). A refusal returns `{ ok: false, termination: \'consent-denied\' }` — that is a **result, not an exception**; the user can revert it under Plugins → Data.',
  },
  {
    qZh: 'ctx.agent.run 报预算错（并发 / 每小时次数），或者跑得比我要的步数少',
    qEn: 'ctx.agent.run hits a budget error (concurrency / hourly cap), or runs fewer steps than requested.',
    aZh: '预算**由宿主裁定，只紧不松**，插件只能申请更小的值：'
      + '\n  · timeoutMs 默认 10 分钟、上限 30 分钟；maxSteps 默认 20、上限 60，且与预设自己的步数上限取 min；'
      + '\n  · 每个插件最多同时 1 个委派、每小时 20 次（本窗口内计数，跨重启保留）——超了会**抛错**，不会静默降级；'
      + '\n  · 所以"我要 500 步"不会给你 500 步。真要更多，请用户到「插件 → 数据」里看用量，或把长任务拆成多次、'
      + '并在界面里给进度提示（每次委派都是一次独立会话，没有跨会话记忆）。',
    aEn: 'The budget is **host-decided and only tightens** — a plugin can only ask for less: timeoutMs 10 min default / 30 max; maxSteps 20 default / 60 max, and min() with the preset\'s own cap; at most 1 concurrent delegation and 20 calls per hour per plugin (counted in a window, persisted across restarts). Exceeding them **throws** rather than silently degrading, so asking for 500 steps will not give you 500. For long work, split it into several calls and show progress in the UI (each delegation is an isolated session with no cross-session memory).',
  },
  {
    qZh: '插件怎么才能写文件 / 报「只读授权不能写入」或「未授权访问」',
    qEn: 'How can a plugin write files — or why do I get “read-only grant cannot write” / “unauthorized”?',
    aZh: '写文件只有一条路，且**必须用户亲手授权**：'
      + '① 让用户在「设置 → 插件 → 管理 → 该插件 → 文件授权」点「允许写入某文件夹…」（或插件自己调 `ctx.files.pickWritableDirectory()` 弹目录选择框）——'
      + '**用户没点过，插件就永远写不了**；'
      + '② 然后写：界面半边用 `await ctx.files.writeText(path, text)`，主进程半边的工具用 `ctx.host.granted.writeText(path, content)`（都要 `fs` 权限）。'
      + '\n  三种报错分别对应：**「只读授权不能写入」**= 这个目录当初是以"只读"选的，要写就让用户重新以可写方式选一次（会升级）；'
      + '**「未授权访问」**= 路径不在任何授权目录内（含兄弟目录、写死的绝对路径）；'
      + '**「插件未声明 fs 权限」**= 清单里没写 `fs`。'
      + '\n  `ctx.host.writeFile` 只能写**插件自己的目录**（userData 下的插件数据目录），不能拿它写用户工作区。'
      + '删除用 `remove`，但它**不做递归删除**（空目录才能删）。',
    aEn: 'There is exactly one path, and the user must grant it by hand: (1) the user clicks “Allow writing to…” under Settings → Plugins → Manage → the plugin → File access (or the plugin calls `ctx.files.pickWritableDirectory()` to open the folder picker) — **without that click a plugin can never write**; (2) then write with `await ctx.files.writeText(path, text)` (UI half) or `ctx.host.granted.writeText(path, content)` (main-half tools); both need the `fs` permission. '
      + 'The three errors mean: “read-only grant cannot write” = that folder was granted read-only, ask the user to pick it as writable again (it upgrades); “unauthorized” = the path is outside every granted folder (siblings and hard-coded absolute paths included); “plugin does not declare fs” = add it to the manifest. '
      + '`ctx.host.writeFile` only writes **the plugin’s own folder**, never the user workspace. `remove` deletes files / empty folders only — it never recurses.',
  },
  {
    qZh: '想让被委派的智能体读文件 / 用 MCP 服务',
    qEn: 'The delegated agent should read files or use MCP servers.',
    aZh: '默认**不给**（防止"零权限插件 → 委派一个能读文件的预设 → 拿回任意文件"）。'
      + '要放开得让用户在「设置 → 插件 → 权限」里给**你这个插件**勾上「文件工具」或「MCP」——文件工具还需要你自己声明 `fs` 权限（双条件）。'
      + '你也可以在 `ctx.agent.run` 的 opts 里用 `tools` / `mcpServerIds` 申请，但宿主仍按上面的开关裁剪，裁掉了什么可以在插件日志里看到。'
      + '命令执行 / 代码执行 / 技能 / 递归委派**永不放宽**：要做这些请让插件自己声明 `shell` 权限走 `ctx.host.runShell`。',
    aEn: 'Not granted by default (this blocks “zero-permission plugin → delegates to a preset with read_file → reads anything”). '
      + 'The user must tick “File tools” or “MCP” for **your plugin** under Settings → Plugins → Permissions — and file tools additionally require you to declare `fs` (two conditions). '
      + 'You may request them via `tools` / `mcpServerIds` in `ctx.agent.run` opts, but the host still clips by those switches; what got clipped shows up in the plugin log. '
      + 'Shell / code execution / skills / recursive delegation are **never** relaxed — declare the `shell` permission and use `ctx.host.runShell` instead.',
  },
  {
    qZh: '想让被委派的智能体读文件 / 用 MCP，或者它为什么没有 read_file / shell？',
    qEn: 'The delegated agent should read files / use MCP — or why does it lack read_file / shell?',
    aZh: '默认**不给**（否则"零权限插件 → 委派能读文件的预设 → 拿回任意文件"就成立）。'
      + '要放开：让用户在「设置 → 插件 → 权限」给**你这个插件**勾「文件工具」或「MCP」；文件工具还需你声明 `fs`（双条件）。'
      + 'opts 可用 `tools` / `mcpServerIds`（按 id 引用用户已启用的服务）申请，但宿主仍按开关裁剪（裁了什么看插件日志）。'
      + '命令 / 代码 / 技能 / 递归委派**永不放宽**：自己声明 `shell` 走 `ctx.host.runShell`，读自己目录用 `ctx.files`。',
    aEn: 'Not granted by default (otherwise “zero-permission plugin → delegates to a preset with read_file → reads anything” would hold). '
      + 'The user must tick “File tools” or “MCP” for **your plugin** under Settings → Plugins → Permissions; file tools additionally require you to declare `fs` (two conditions). '
      + 'You may request them via `tools` / `mcpServerIds` in opts (MCP by id, referencing the servers the user configured and enabled), but the host still clips by those switches — the plugin log shows what was clipped. '
      + 'Shell / code execution / skills / recursive delegation are **never** relaxed: declare the `shell` permission and use `ctx.host.runShell` (a separate approval), and read your own files with `ctx.files`.',
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
  {
    qZh: '界面半边能不能调 MCP 服务 / 宿主内置服务（如用 office 服务解析 Excel）？',
    qEn: 'Can the UI half call MCP or built-in host services (e.g. the office service to parse Excel)?',
    aZh: '不能。界面半边只有 ctx 上列出的那些成员（**没有 ctx.service / ctx.mcp**），MCP 服务（office / 浏览器 / drawio 等）只暴露给智能体经 mcp_call 调用。插件要读表格请用 ctx.files.readSheet(path)（.xlsx/.xls/.csv），要读二进制用 ctx.files.readBase64(path)，要调外部服务请把它做成**主进程半边**的插件工具（ctx.tool）让智能体调用；写不存在的 API（如 ctx.files.readFile、ctx.service）会在运行时抛 "is not a function"。',
    aEn: 'No. The UI half only has the members listed for ctx (**there is no ctx.service / ctx.mcp**); MCP services (office / browser / drawio …) are exposed to agents through mcp_call only. To read a spreadsheet use ctx.files.readSheet(path) (.xlsx/.xls/.csv), for raw bytes use ctx.files.readBase64(path), and for external services ship a **main-process half** tool (ctx.tool) the agent can call. Inventing APIs (ctx.files.readFile, ctx.service …) throws “is not a function” at runtime.',
  },
  {
    qZh: '图表 / 画布（canvas）不显示，或页面空白（含「必须点一下按钮才出图」「柱状图永远不显示」）',
    qEn: 'The chart / canvas shows nothing, or the panel goes blank (including “it only appears after clicking a button” and “the bar chart never shows up”).',
    aZh: '三个常见坑：① **canvas 2D 不认 CSS 变量**——`ctx2d.fillStyle = "var(--fontColor)"` 会被忽略（用固定色，或 `getComputedStyle(document.documentElement).getPropertyValue("--fontColor")` 取真值）；② 绘制代码里变量名写错（如把 `s` 写成未定义的 `item`）会抛错并中断整次绘制，只画出一部分——绘制函数要 try/catch 并用 ctx.log.warn 记下来；③ 尺寸依赖容器的要在数据变化后重画，且 ResizeObserver / 定时器要断开（ctx.effect 或 onUnmounted），否则重载后会越画越乱；④ **只在按钮点击里重画**——数据到位后没有任何东西触发重画，canvas 就一直是空的（要么 watch(data, () => draw(), { flush: "post" }) / await nextTick() 后重画，要么画在 ref 回调里；别只依赖「挂载后的一个 setTimeout」，数据比定时器慢就永远不画）；⑤ **guard 写错会连带拦掉另一个图**——onResize 里用 `if (!pieEl) return` 判「要不要画」，切到柱状图时 pieEl 是 null（ref 回调把它置空了），于是柱状图一次都不画：**每个图各自判自己的 canvas**。',
    aEn: 'Three classic traps: ① **canvas 2D does not resolve CSS variables** — ctx2d.fillStyle = "var(--fontColor)" is silently ignored (use literal colours, or read the real value via getComputedStyle(document.documentElement).getPropertyValue("--fontColor")); ② a typo’d variable in the draw loop (e.g. an undefined `item` instead of `s`) throws and aborts the whole paint, leaving a half-drawn chart — wrap the draw call in try/catch and ctx.log.warn; ③ redraw when data changes, and disconnect ResizeObserver / timers (ctx.effect or onUnmounted) so reloads do not pile up; ④ **drawing only from a click handler** — nothing redraws when the data arrives, so the canvas stays blank (redraw from watch(data, () => draw(), { flush: "post" }) / after await nextTick(), or paint inside the ref callback; never rely on a single setTimeout after mount, because data that arrives later than the timer is never painted); ⑤ **a wrong guard can block the other chart** — deciding “should I draw?” with `if (!pieEl) return` breaks the bar chart, because switching views nulls pieEl in the ref callback, so the bar chart is never painted: **each draw must check its own canvas**.',
  },
  {
    qZh: '界面文案或提示显示 "[object Object]"',
    qEn: 'The UI shows “[object Object]” instead of text.',
    aZh: '把 ctx.locale.pick(...) / ref(...) 的返回值当字符串用了：它们返回的是 **ref**，取值要写 text.value.title（示例：const text = ctx.locale.pick({ zh: {...}, en: {...} })，再 h("div", null, text.value.title)）。传进 ctx.notify(...)、拼进模板字符串（`${ctx.locale.pick(...)}`）或与字符串相加，都会得到 "[object Object]"。要一次性字符串就用 ctx.locale.t(dict, "key", { 参数 })，或先取 .value 再拼。',
    aEn: 'A ref returned by ctx.locale.pick(...) / ref(...) was used as a string: those return a **ref**, so read values with text.value.title (e.g. const text = ctx.locale.pick({ zh: {...}, en: {...} }); h("div", null, text.value.title)). Passing one to ctx.notify(...), into a template literal (`${ctx.locale.pick(...)}`) or into string concatenation all yield "[object Object]". For a one-off string use ctx.locale.t(dict, "key", { params }), or read .value first.',
  },
  {
    qZh: '读文件报「未授权访问」',
    qEn: 'Reading a file fails with “not authorised”.',
    aZh: '插件只能读**用户在该插件里亲自选过**的路径（写死的绝对路径不算），选过一次就会记住（跨重启有效，用户可在「插件 → 数据」里撤销）。所以流程是：await ctx.files.pickFiles() 让用户选一次 → 把 res.files[0].path 存起来（localStorage `aikm.plugin.<插件 id>.*`）→ 之后直接读；万一报未授权，就再次弹选择框让用户确认。',
    aEn: 'A plugin may only read paths the user picked **inside that plugin** (a hard-coded absolute path is not authorised), and a pick is remembered (it survives a restart; the user can revoke it under Plugins → Data). So: `await ctx.files.pickFiles()` once, store `res.files[0].path` (localStorage `aikm.plugin.<id>.*`), then read it directly — and if a read is refused, ask the user to pick again.',
  },
  {
    qZh: '选了文件却「没有数据」/ 面板一直显示空（忘了 await 或返回形状用错）',
    qEn: 'Nothing happens after picking a file, or the panel keeps saying “no data”.',
    aZh: '两个高频原因：① **忘记 await**——`ctx.files.*` 全部返回 Promise，`const res = ctx.files.readSheet(p)` 拿到的是 Promise，`res.sheets` 是 undefined（不报错，所以很难发现）；② **pickFiles 的返回形状**：它返回 `{ cancelled, files: [{ path, name, size }] }`，不是路径数组，所以 `files.length` / `files[0]` 都不对，正确写法是 `const res = await ctx.files.pickFiles({ accept: "any" }); if (res.cancelled || !res.files.length) return; const path = res.files[0].path`（用户取消时**不抛错**，别用 try/catch 判取消）。plugin_dev_check 会把这两种情况静态报出来。',
    aEn: 'Two usual causes: ① **a missing await** — every `ctx.files.*` call returns a Promise, so `const res = ctx.files.readSheet(p)` yields a Promise and `res.sheets` is undefined (no error is thrown, which is why it is so hard to spot); ② **the pickFiles shape** — it returns `{ cancelled, files: [{ path, name, size }] }`, not an array of paths, so `files.length` / `files[0]` are both wrong; the correct form is `const res = await ctx.files.pickFiles({ accept: "any" }); if (res.cancelled || !res.files.length) return; const path = res.files[0].path` (cancellation **does not throw**, so never detect it with try/catch). plugin_dev_check reports both statically.',
  },
  {
    qZh: '设置页签没进「插件」分组（左侧多出一个同名的「插件」一级菜单）/ 设置卡片出现在所有设置页',
    qEn: 'The settings tab does not land in the Plugins group (a second top-level “Plugins” menu appears) / the settings card shows up on every settings page.',
    aZh: '三种写法问题：① **meta.group 只能填已存在的一级分组 id**（base-group 通用 / llm-group 模型 / collab-group 协作 / ai-group 语音 / service-group 工具 / plugin-group 插件 / skill-group 技能 / agent-group 智能体）；**省略 meta.group = 内置「插件」分组**，填别的 id（如 "ui"）会新建一个标题硬编码为「插件」的一级分组——删掉 meta.group 或改成 plugin-group 即可；② **settings.card 必须写 meta.target**（内置设置页 id，可写数组），不写就会出现在所有设置页；③ 别用内置设置页 id 当 settings.tab 的 key（会与内置页撞同一个 id，导航里出现两项、右侧同时渲染两页）：用 plugin-<插件 id> 前缀。改完回「插件 → 管理」点一次重载。',
    aEn: 'Three typical mistakes: ① **meta.group must be an existing top-level group id** (base-group / llm-group / collab-group / ai-group / service-group / plugin-group / skill-group / agent-group); **omitting meta.group means the built-in Plugins group**, and any other id (e.g. "ui") creates a new top-level group hard-titled “Plugins” — drop meta.group or set it to plugin-group; ② **settings.card requires meta.target** (a built-in settings page id, or an array), otherwise the card appears on every settings page; ③ never use a built-in settings page id as the settings.tab key (it collides with that page: the nav shows two entries and the right pane renders both pages) — prefix it with plugin-<plugin id>. Press Reload in Plugins → Manage afterwards.',
  },
]

/** 「如何使用插件」给人看的步骤 */
export const PLUGIN_DEV_USAGE_ZH = `0) 命名（先定好，避免返工）：**插件文件夹名必须等于清单 aikm.id，且只能是 ASCII 小写 [a-z0-9._-]**（如 my-plugin）。文件夹名带中文 / 大写 / 空格时宿主会直接跳过这个文件夹（插件根本不出现，管理页会给提示），只能改名重来；中文请写进 aikm.name 与界面文案。
1) 安装：插件文件夹放进插件目录（可直接放，也可按用途放进各级子文件夹——管理页能看出它属于哪个文件夹），或「设置 → 插件 → 管理 → 从文件夹安装」；插件目录可改成自己的文件夹（和技能一样），点「打开插件目录」即可查看。手动放进新插件后点管理页目录栏的「重新扫描」即可发现（不必重启软件）。
2) 启用：点启用按钮 → 弹窗会列出该插件申请的权限（文件 / 执行命令 / 网络 / 会话日志 / 大模型），确认后才会加载。停用后它加的界面元素与工具立即消失。
3) 用它：
   · 主面板 —— 左侧或底部的导航栏会出现它的按钮（图标 + 名称）；
   · 设置页签 —— 出现在「设置 → 插件」分组下，点进去就是插件自己的设置页；
   · 智能体工具 —— 让智能体调用该工具名（如「用 hello_aikm 向我问好」），或在「设置 → 工具 → 注册表」里看到 plugin:<插件 id> 分组；
   · 快捷键 —— 插件会说明它用了哪些组合键，插件设置页里也能看到；
   · 集群工作台 / 聊天消息按钮 —— 出现在对应位置。
4) 配置：插件 → 管理 → 配置（JSON），保存后点重载生效。
5) 发给别人：把插件文件夹放进「协作 → 共享」里共享的目录（可分类放进子文件夹），对方在「插件 → 商店」粘贴共享地址即可一键安装（安装前会再次列出权限）；索引由软件实时扫描，不需要你手写任何清单文件。
5) 排障：插件 → 管理 → 日志（能看到它自己打的信息）；「详情」里有清单、槽位、权限与加载状态。
6) 卸载：点移除（可选择是否删除插件文件夹）。`

export const PLUGIN_DEV_USAGE_EN = `0) Naming (decide this first to avoid rework): **the plugin folder name must equal the manifest aikm.id and be ASCII lowercase [a-z0-9._-]** (e.g. my-plugin). A folder with Chinese characters, uppercase letters or spaces is skipped by the host (the plugin never shows up — the manager will say so) and only a rename fixes it; put Chinese in aikm.name and the UI copy.
1) Install: drop the folder into the plugins folder (directly, or grouped by purpose in nested subfolders — the manager shows which folder each plugin belongs to), or use Plugins → Manage → Install from folder. The plugins folder can be moved to your own directory (like skills) — use “Open plugins folder”. Click “Rescan” in the folder bar to pick up manually added plugins (no restart needed).
2) Enable: press Enable — a dialog lists the permissions it requests (files / commands / network / session logs / models). It loads only after you confirm. Disabling removes its UI contributions and tools instantly.
3) Use it:
   · Main panel — a button (icon + name) shows up in the left or bottom nav;
   · Settings tab — appears under the Plugins group in Settings;
   · Agent tools — ask the agent to call the tool name (e.g. “use hello_aikm to greet me”), or find plugin:<id> in Settings → Tools → Registry;
   · Shortcuts — documented by the plugin and visible on its settings tab;
   · Swarm workbench / chat message buttons — appear in place.
4) Configure: Plugins → Manage → Config (JSON), then hit Reload.
5) Share it: put the plugin folder into the folder shared under Collaboration → Share (category subfolders are fine); others paste the share address into Plugins → Store and install it in one click — the index is scanned on the fly, so you never hand-write a manifest file.
6) Troubleshoot: Plugins → Manage → Logs (what the plugin logged) and Details (manifest, slots, permissions, load state).
7) Remove: press Remove (optionally deleting the folder).`

/** 各段可复制指令 */
export const PLUGIN_DEV_SECTIONS: readonly PluginDevSection[] = [
  {
    key: 'general',
    titleZh: '通用开发指令（推荐：整段粘给大模型）',
    titleEn: 'General development prompt (paste this whole block into your model)',
    tabZh: '通用指令',
    tabEn: 'General prompt',
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
- ctx.locale.pick({ zh: {...}, en: {...} }) → 拿到跟随语言切换的文案 **ref**：const text = ctx.locale.pick({...})，取值写 text.value.title（**它本身不是字符串**）；要一次性字符串用 ctx.locale.t({ zh, en }, 'key', { 参数 })
- ctx.log.{debug,info,warn,error}(...)、ctx.notify(message)（轻提示，**只收字符串**——传 ref 会显示 "[object Object]"）
- ctx.shortcuts.register('Ctrl+Shift+H', handler, { descriptionZh, descriptionEn })
- ctx.slots.register(slot, { key, titleZh, titleEn, icon, order, component, meta })
- ctx.on(type, listener) → 返回取消订阅函数；ctx.effect(fn) → 登记副作用并自动清理
- ctx.llm（需要 llm 权限）：{ available, reason, sources(), current(), models(source), chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs }) }
- ctx.files（需要 fs 权限，**全部是异步，必须 await**）：{ available, reason, pickFiles({ accept: 'any'|'pdf'|'text', multiple }) → { cancelled, files: [{ path, name, size }] }（取消时 cancelled=true 且不抛错，路径取 files[0].path）, pickDirectory() → { cancelled, dir: { path, name } }, list(dir) → { entries: [{ name, path, isDir, size }] }, readText(path) → { text, pages, pdf }, readBase64(path) → { base64, size }, readBytes(path) → { bytes: Uint8Array, size }（几十 MB 的大文件用它，别走 base64）, readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] }（.xlsx/.xls/.csv，界面半边没有 SheetJS）, renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, pageCount, width, height }, openInApp(path, view) }
- ctx.app.agentPresets() → [{ id, name }]；ctx.app.setChromeHidden(hidden) → 请求隐藏 / 恢复宿主外壳（顶栏 + 导航栏），插件面板全屏时用（切面板或卸载时宿主会自动恢复）
主进程半边 apply(ctx)：
- export const inject = ['tools']（要用工具注册表**视图**时声明；它只有 register / list / get 元数据，
  **没有 execute** —— 执行宿主工具只能由智能体循环发起，与 DSH 工具服务的公开面一致）
- ctx.tool({ name, description, inputSchema, handler })：inputSchema 是 JSON Schema；handler(input) 返回可 JSON 序列化的结果
- ctx.service(name, value)、ctx.on(type, listener)、ctx.effect(fn)、ctx.storage.{get,set,delete}
- ctx.log.*、ctx.host.notify(message)、ctx.host.runShell(command, { cwd })、ctx.host.fetch(url, init)、ctx.host.sessions.list()

【实现要求】
1. 命名规则（**先定好，避免返工**）：插件**目录名必须等于清单 aikm.id**，且只能用 ASCII 小写字母/数字开头、只含 \`[a-z0-9._-]\`（例：my-plugin）。目录名带中文 / 大写 / 空格时宿主会**整目录跳过**（插件根本不会出现在列表里），只能改名重来——所以先给出英文 id 与目录名，再写文件。中文写进清单的 aikm.name（显示名）与界面文案。
2. 先给清单（package.json），再给代码；清单里的 id、目录名、文件名要互相一致，我会把目录名起成清单里的 id。
3. declares.tools / declares.slots 必须与代码里实际注册的一致。
4. 界面半边只用渲染函数（h(...)）写，不写模板字符串模板语法，不写 import。
5. 代码要有中文注释解释关键取舍（为什么这样设计），并在 README.md 里写清使用步骤。
6. 如果功能需要大模型，请把提示词写清楚，并对模型返回的 JSON 做容错（解析失败要有兜底，不能崩）。
7. 结束时自查一遍：权限是否都申请了、副作用是否都清理了、offline（模型不可用）时是否还能跑。
8. **只用上面【宿主 API】列出的成员**（界面半边 / 主进程半边各一套，不能混用）；不要凭名字猜 API——ctx.files.readFile、ctx.service、ctx.mcp、ctx.storage（界面半边）都不存在，读表格用 ctx.files.readSheet(path)、读二进制用 ctx.files.readBase64(path)、让用户选文件用 ctx.files.pickFiles({ accept: 'any' })。`,
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
- ctx.locale.pick({ zh: {...}, en: {...} }) → a **ref** of the language-aware copy: const text = ctx.locale.pick({...}); read text.value.title (**it is not a string**); for a one-off string use ctx.locale.t({ zh, en }, 'key', { params })
- ctx.log.{debug,info,warn,error}(...), ctx.notify(message) (toast) — **message must be a string** (a ref renders "[object Object]")
- ctx.shortcuts.register('Ctrl+Shift+H', handler, { descriptionZh, descriptionEn })
- ctx.slots.register(slot, { key, titleZh, titleEn, icon, order, component, meta })
- ctx.on(type, listener) → returns an unsubscribe function; ctx.effect(fn) → registers a disposable side effect
- ctx.llm (needs the llm permission): { available, reason, sources(), current(), models(source), chat({ source, model, system, messages, temperature, maxTokens, think, timeoutMs }) }
- ctx.files (needs the fs permission; **every method is async — always await**): { available, reason, pickFiles({ accept: 'any'|'pdf'|'text', multiple }) → { cancelled, files: [{ path, name, size }] } (cancellation sets cancelled=true and does not throw; take files[0].path), pickDirectory() → { cancelled, dir: { path, name } }, list(dir) → { entries: [{ name, path, isDir, size }] }, readText(path) → { text, pages, pdf }, readBase64(path) → { base64, size }, readBytes(path) → { bytes: Uint8Array, size } (for tens-of-MB files — skip base64), readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] } (.xlsx/.xls/.csv — the UI half has no SheetJS), renderPdfPage(path, { page, scale, maxWidth }) → { dataUrl, pageCount, width, height }, openInApp(path, view) }
- ctx.app.agentPresets() → [{ id, name }]; ctx.app.setChromeHidden(hidden) → ask the host to hide/restore its own chrome (top bar + nav bars) while a plugin panel goes fullscreen (the host restores it on panel switch or unload)
Main-process half apply(ctx):
- export const inject = ['tools'] (declare it when you need the tool-registry **view**: it only offers
  register / list / metadata — **no execute**. Running host tools is the agent loop's job, matching DSH's tool-service surface)
- ctx.tool({ name, description, inputSchema, handler }): inputSchema is JSON Schema; handler(input) returns JSON-serialisable data
- ctx.service(name, value), ctx.on(type, listener), ctx.effect(fn), ctx.storage.{get,set,delete}
- ctx.log.*, ctx.host.notify(message), ctx.host.runShell(command, { cwd }), ctx.host.fetch(url, init), ctx.host.sessions.list()

[Implementation requirements]
1. Naming rule (**settle this first to avoid rework**): the plugin folder name must equal the manifest’s aikm.id and be ASCII lowercase — starting with [a-z0-9] and containing only [a-z0-9._-] (e.g. my-plugin). A folder named in Chinese, with uppercase letters or spaces is skipped entirely by the host (the plugin never shows up in the list) and only a rename fixes it — so decide the English id and folder name before writing files. Chinese belongs in aikm.name (display name) and in the UI copy.
2. Manifest first, then code; ids/filenames must agree with each other, and I will name the folder after the manifest id.
3. declares.tools / declares.slots must match what the code registers.
4. Write the UI half with render functions h(...) only — no template syntax, no imports.
5. Add comments explaining key trade-offs and put usage steps in README.md.
6. If the feature needs a model, write a precise prompt and make JSON parsing fault-tolerant (a bad reply must not crash the plugin).
7. Self-check before answering: are all permissions declared, are all side effects disposable, and does it still work when no model is available?
8. **Use only the members listed under [Host API] above** (each half has its own set; they are not interchangeable). Never invent an API from its name — ctx.files.readFile, ctx.service, ctx.mcp and ctx.storage (UI half) do not exist. Read a spreadsheet with ctx.files.readSheet(path), raw bytes with ctx.files.readBase64(path), and ask the user to pick a file with ctx.files.pickFiles({ accept: 'any' }).`,
  },
  {
    key: 'panel',
    titleZh: '界面插件模板：主面板 + 设置页签 + 快捷键',
    titleEn: 'UI plugin template: main panel + settings tab + shortcut',
    tabZh: '界面插件',
    tabEn: 'UI panel',
    descZh: '适合「给我一个 xx 面板」这类需求。整段粘给大模型即可，最后一行写你要的面板长什么样。',
    descEn: 'For “give me a panel that does X” requests. Paste the whole block and fill in the last line.',
    bodyZh: `请为 AI-KM 写一个界面插件（只有 client 半边，不需要主进程代码）。

【要实现的界面】
<描述面板长什么样：几栏布局、有哪些控件、点击后做什么>

【插件信息】
- 插件 id / 目录名：<my-panel>（**只能是 ASCII 小写 [a-z0-9._-]，不能用中文 / 大写 / 空格**——中文目录名会被宿主整目录跳过；中文写进清单的 aikm.name）
- 面板导航名：<面板名>（同时给英文名），图标用 FontAwesome 4 类名（如 "fa fa-heartbeat"）

${CONSTRAINTS_ZH}

【写法要点】
- client.mjs 结构：export function apply(ctx) { ... }，用 ctx.vue 的 h / defineComponent / ref / computed 写；
- 面板用 ctx.slots.register('panel.main', { key: '<my-panel>', titleZh, titleEn, icon, order: 900, component: Panel })；
- 如果有可配置项，再加一个设置页签：ctx.slots.register('settings.tab', { key: 'plugin-<插件 id>', titleZh: '我的面板设置', titleEn: 'My panel settings', icon: 'fa fa-cogs', order: 900, component: Settings })（**不要写 meta: { group: 'ui' }**：省略 meta.group 即归入「设置 → 插件」分组，写不存在的分组 id 会多出一个同名「插件」一级分组；完整写法与可用 id 清单见「设置页签 / 设置卡片模板」一节），
  设置项改动要立即生效并持久化（可用 localStorage，键名带插件 id 前缀，如 'aikm.plugin.my-panel.settings'）；
  图片 / 存档这类大文件放本机 OPFS 的 'plugins/<插件 id>/' 目录（宿主「插件管理 → 数据」按这个约定统计与清理）；
- 面板高度自适应：最外层 height:100%; box-sizing:border-box; display:flex; flex-direction:column，需要滚动的区域 class="scoll" + overflow-y:auto + min-height:0；
- 数字/文本输入框、下拉框都要显式设前景色与背景色（主题变量）并给紧凑尺寸；
- 别忘了在 settings 卡或面板上给出简短的使用提示（一句话），并在 README.md 写清用法。`,
    bodyEn: `Write a UI-only AI-KM plugin (client half only, no main-process code).

[UI to build]
<describe the panel: layout, controls, what clicking does>

[Plugin info]
- Plugin id / folder name: <my-panel> (ASCII lowercase [a-z0-9._-] only — no Chinese, uppercase or spaces: a Chinese folder name is skipped entirely by the host; write Chinese in the manifest’s aikm.name)
- Panel nav title: <name> (also provide English), icon as a FontAwesome 4 class (e.g. "fa fa-heartbeat")

${CONSTRAINTS_EN}

[Implementation notes]
- client.mjs shape: export function apply(ctx) { ... }, written with h / defineComponent / ref / computed from ctx.vue.
- Register the panel with ctx.slots.register('panel.main', { key: '<my-panel>', titleZh, titleEn, icon, order: 900, component: Panel }).
- If there are settings, add ctx.slots.register('settings.tab', { key: 'plugin-<plugin id>', titleZh: 'My panel settings', titleEn: 'My panel settings', icon: 'fa fa-cogs', order: 900, component: Settings }) (**never write meta: { group: 'ui' }**: leaving meta.group out puts the tab in the built-in Plugins group, while an unknown group id adds a second top-level group with the same name; see the “Settings tab / card template” section for the full call and the allowed ids); changes must apply immediately and persist (localStorage with a plugin-id-prefixed key such as 'aikm.plugin.my-panel.settings'); put large blobs (images, saves) in OPFS under 'plugins/<plugin id>/' — that is how Settings → Plugins → Data measures and clears per-plugin data.
- Panel height: outer element height:100%; box-sizing:border-box; display:flex; flex-direction:column; scrollable areas need class="scoll" + overflow-y:auto + min-height:0.
- Set explicit foreground/background colours (theme variables) and compact sizes on every input/select.
- Add a one-line usage hint in the panel or its settings tab, and document usage in README.md.`,
  },
  {
    key: 'settings',
    titleZh: '设置页签 / 设置卡片模板：把插件的配置项放进「设置 → 插件」',
    titleEn: 'Settings tab / card template: put your plugin options under Settings → Plugins',
    tabZh: '设置页签',
    tabEn: 'Settings tab',
    descZh:
      '适合「插件要能配置」这类需求。整段粘给大模型即可：给了可直接抄的注册写法、**完整可用的设置组件骨架**（立即生效 + 本机持久化 + 恢复默认），以及设置**一级分组 id** 与**设置页 id** 两份清单——分组写错会多出一个同名的「插件」一级菜单，卡片不写 target 会出现在所有设置页。',
    descEn:
      'For “the plugin needs options”. Paste the whole block: it contains the exact registration calls, a **complete working settings component** (applies immediately, persists locally, has a reset button), and the two id lists (settings groups and settings pages) — a wrong group id creates a second top-level “Plugins” menu, and a card without target appears on every settings page.',
    bodyZh: `请为 AI-KM 插件加一个「设置页签」（和可选的「设置卡片」），用来配置插件自己的选项。

【插件信息】
- 插件 id / 目录名：<my-panel>（**只能是 ASCII 小写 [a-z0-9._-]，不能用中文 / 大写 / 空格**——中文目录名会被宿主整目录跳过；中文写进清单的 aikm.name）
- 设置页签名：<我的面板设置>（同时给英文名），图标用 FontAwesome 4 类名（如 "fa fa-cogs"）
- 要配的选项：<例如 字号 / 是否显示网格 / 默认标题 …>

${CONSTRAINTS_ZH}

【一、注册：先记住三条规矩】
1) settings.tab（设置页签）：
   ctx.slots.register('settings.tab', { key: 'plugin-<插件 id>', titleZh: '我的面板设置', titleEn: 'My panel settings', icon: 'fa fa-cogs', order: 900, component: Settings })
   · **key 就是设置页 id（= 导航里的 activeNav），在 settings.tab 槽位内必须全局唯一**：第二个插件用同一个 key 会直接抛「key 重复」。一律用 'plugin-<插件 id>' 这种前缀，**不要占用内置设置页 id**（view / features / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help），否则导航里会出现两个同 id 的项、右侧同时渲染内置页和你的页签。
   · **meta.group 决定挂在哪个一级分组下，只能填已存在的分组 id**：base-group 通用 / llm-group 模型 / collab-group 协作 / ai-group 语音 / service-group 工具 / plugin-group 插件 / skill-group 技能 / agent-group 智能体。**省略 meta.group = plugin-group（内置「插件」分组）**，这也是绝大多数插件的正确选择；填一个上面没有的 id（比如 'ui'）会新建一个**标题硬编码为「插件」**的一级分组，看起来就是「又多了一个同名的插件菜单」——这是最常见的踩坑。
   · order 只影响同一分组内的排序（小的在前）；titleZh / titleEn / icon 决定导航项的文字与图标。
2) settings.card（往**已有**设置页里插一张卡片，可选）：
   ctx.slots.register('settings.card', { key: 'plugin-<插件 id>-card', component: Card, meta: { target: 'view' } })
   · **必须写 meta.target**（要插到哪个设置页的 id，上面那份内置设置页 id 清单），也可以写数组同时插多页（如 { target: ['view', 'data'] }）；**不写 target 会出现在所有设置页**（包括插件商店那种不相干的页面）。
   · 卡片是「list」槽位：多个插件的卡片按 order 依次排列，适合放一小块说明或几个开关；复杂配置还是用 settings.tab。
3) 两个半边都不需要改：配置界面完全由你绘制，宿主只提供「位置」。

【二、完整可抄的设置组件骨架（立即生效 + 本机持久化 + 恢复默认）】
- 界面半边**没有 ctx.storage**，用 localStorage，键名带插件 id 前缀：'aikm.plugin.<插件 id>.settings'；
- 把 settings 放在 **apply() 作用域**（不是组件里），面板与设置页签就共用同一份配置：改哪边都立即生效，也不用互相通知；
- 用 ctx.effect 注册 watch（返回停止函数），插件禁用时自动停掉，不留副作用。

  const SETTINGS_KEY = 'aikm.plugin.my-panel.settings'
  const defaults = () => ({ size: 12, showGrid: true, title: '' })

  const loadSettings = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
      return saved && typeof saved === 'object' ? { ...defaults(), ...saved } : defaults()
    } catch (e) {
      ctx.log.warn('读取设置失败，按默认值开始：', e)
      return defaults()
    }
  }

  // apply() 作用域：面板与设置页签共用这一份
  const settings = ref(loadSettings())
  ctx.effect(() => {
    const stop = watch(settings, () => {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value))
      } catch (e) {
        ctx.log.warn('保存设置失败：', e)
      }
    }, { deep: true })
    return () => stop()
  })

  const inputStyle = 'height:22px;box-sizing:border-box;padding:0 4px;border:1px solid var(--borderColor,#dcdfe6);border-radius:3px;background:var(--backgroundColor,#fff);color:var(--fontColor,#303133);font-size:11px;width:74px'

  const Settings = defineComponent({
    name: 'MyPanelSettings',
    setup() {
      const numberField = (key, label, min, step) =>
        h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, [
          h('span', { style: 'opacity:.75' }, label),
          h('input', {
            type: 'number', min, step, value: settings.value[key], style: inputStyle,
            onChange: (e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) settings.value[key] = v   // 立即生效；watch 负责落盘
            },
          }),
        ])

      return () =>
        h('div', { class: 'scoll', style: 'height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto;font-size:12px' }, [
          h('h3', { style: 'margin:0 0 8px;padding:0 0 8px 10px;border-bottom:1px solid var(--borderColor,#dcdfe6);border-left:3px solid var(--fontActiveColor,#409eff);font-size:14px;font-weight:600' }, text.value.tabTitle),
          h('div', { style: 'display:flex;align-items:center;gap:14px;row-gap:6px;flex-wrap:wrap' }, [
            numberField('size', text.value.sizeLabel, 1, 1),
            h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, [
              h('input', { type: 'checkbox', checked: settings.value.showGrid, style: 'margin:0;cursor:pointer', onChange: (e) => (settings.value.showGrid = e.target.checked) }),
              text.value.gridLabel,
            ]),
            h('button', {
              onClick: () => { settings.value = defaults() },
              style: 'cursor:pointer;padding:2px 8px;border-radius:4px;border:1px solid var(--borderColor,#dcdfe6);background:var(--menuColor,#fff);color:var(--fontColor,#303133);font-size:11px',
            }, text.value.reset),
          ]),
          h('div', { style: 'font-size:11px;line-height:1.7;opacity:.68;margin-top:8px' }, text.value.settingsHint),
        ])
    },
  })

  // 文案照硬约束第 9 条用 ctx.locale.pick（取值写 text.value.xxx），这里从略
  ctx.slots.register('settings.tab', {
    key: 'plugin-my-panel',
    titleZh: '我的面板设置',
    titleEn: 'My panel settings',
    icon: 'fa fa-cogs',
    order: 900,
    component: Settings,
  })

  // 可选：再往「设置 → 通用 → 基础」里插一张卡片（不放 meta.group，必须放 meta.target）
  // 卡片通常比设置页更紧凑，实践里另写一个小组件（这里为省篇幅复用 Settings）
  ctx.slots.register('settings.card', { key: 'plugin-my-panel-card', component: Settings, meta: { target: 'view' } })

【三、大文件不放配置里】
图片 / 存档这类大文件放本机 OPFS 的 'plugins/<插件 id>/' 目录（宿主「插件管理 → 数据」按这个约定统计与清理），配置里只存路径与开关。

【四、交付前自查】
- 「设置 → 插件」分组下应出现你的页签；**若左侧多出一个同名的「插件」一级菜单，就是 meta.group 写了不存在的 id**（删掉或改成 plugin-group）；
- 设置卡片只应出现在目标页（检查 meta.target 是**设置页 id**，不是分组 id）；
- 改配置立即生效且重启后保留（刷新页面 / 重载插件都试一次）；
- 提示条只传字符串（ctx.notify(text.value.xxx)，别传 ref）。

【交付物】按 === package.json === / === client.mjs === / === README.md === 分段给出完整文件内容，不要省略、不要写「此处略」。`,
    bodyEn: `Add a settings tab (and optionally a settings card) to an AI-KM plugin so users can configure it.

[Plugin info]
- Plugin id / folder name: <my-panel> (**ASCII lowercase [a-z0-9._-] only** — a Chinese folder name is skipped by the host; put Chinese in the manifest’s aikm.name)
- Settings tab title: <My panel settings> (also provide the other language), icon as a FontAwesome 4 class (e.g. "fa fa-cogs")
- Options to expose: <e.g. font size / show grid / default title …>

${CONSTRAINTS_EN}

[1. Registration — three rules]
1) settings.tab:
   ctx.slots.register('settings.tab', { key: 'plugin-<plugin id>', titleZh: '…', titleEn: 'My panel settings', icon: 'fa fa-cogs', order: 900, component: Settings })
   · **key is the settings page id (= activeNav) and must be unique inside the settings.tab slot**: a second plugin reusing it throws “duplicate key”. Always prefix with 'plugin-<plugin id>' and **do not take a built-in page id** (view / features / data / fileassoc / other / llm / llm-embed / credentials / share / collab / perm / tts / asr / tools / search / mcp / toolregistry / plugin / plugin-store / plugin-dev / agentskill / agentskill-store / agentpreset / agentconsole / sessionlog / help), otherwise the nav shows two entries with the same id and the right pane renders both the built-in page and yours.
   · **meta.group picks the top-level group and may only be an existing group id**: base-group (General) / llm-group (Models) / collab-group (Collaboration) / ai-group (Speech) / service-group (Tools) / plugin-group (Plugins) / skill-group (Skills) / agent-group (Agent). **Omitting meta.group means plugin-group (the built-in Plugins group)** — the right choice for almost every plugin; any other id (e.g. 'ui') creates a **new top-level group hard-titled “Plugins”**, i.e. “a second Plugins menu appeared”, the most common trap here.
   · order only sorts inside the same group (ascending); titleZh / titleEn / icon drive the nav entry.
2) settings.card (inject a card into an **existing** settings page, optional):
   ctx.slots.register('settings.card', { key: 'plugin-<plugin id>-card', component: Card, meta: { target: 'view' } })
   · **meta.target is mandatory** (the settings page id from the built-in list above) and may be an array to inject into several pages ({ target: ['view', 'data'] }); **without target the card appears on every settings page** (including unrelated ones such as the plugin store).
   · It is a “list” slot: cards from different plugins are ordered by order; a small note or a couple of toggles fit well — use settings.tab for real configuration.
3) Neither half needs changes: the host only provides the position, you draw the whole UI.

[2. A complete settings component (applies immediately, persists locally, resettable)]
- The UI half has **no ctx.storage**: use localStorage with a plugin-id-prefixed key, 'aikm.plugin.<plugin id>.settings'.
- Keep settings in the **apply() scope** (not inside a component) so the panel and the settings tab share one object: edits apply everywhere immediately, no messaging needed.
- Register the watch through ctx.effect (return the stop function) so nothing keeps running after the plugin is disabled.

  const SETTINGS_KEY = 'aikm.plugin.my-panel.settings'
  const defaults = () => ({ size: 12, showGrid: true, title: '' })

  const loadSettings = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
      return saved && typeof saved === 'object' ? { ...defaults(), ...saved } : defaults()
    } catch (e) {
      ctx.log.warn('load settings failed, using defaults:', e)
      return defaults()
    }
  }

  const settings = ref(loadSettings())   // apply() scope: shared by the panel and the settings tab
  ctx.effect(() => {
    const stop = watch(settings, () => {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value))
      } catch (e) {
        ctx.log.warn('save settings failed:', e)
      }
    }, { deep: true })
    return () => stop()
  })

  const inputStyle = 'height:22px;box-sizing:border-box;padding:0 4px;border:1px solid var(--borderColor,#dcdfe6);border-radius:3px;background:var(--backgroundColor,#fff);color:var(--fontColor,#303133);font-size:11px;width:74px'

  const Settings = defineComponent({
    name: 'MyPanelSettings',
    setup() {
      const numberField = (key, label, min, step) =>
        h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, [
          h('span', { style: 'opacity:.75' }, label),
          h('input', {
            type: 'number', min, step, value: settings.value[key], style: inputStyle,
            onChange: (e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) settings.value[key] = v   // applies immediately; the watch persists it
            },
          }),
        ])

      return () =>
        h('div', { class: 'scoll', style: 'height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto;font-size:12px' }, [
          h('h3', { style: 'margin:0 0 8px;padding:0 0 8px 10px;border-bottom:1px solid var(--borderColor,#dcdfe6);border-left:3px solid var(--fontActiveColor,#409eff);font-size:14px;font-weight:600' }, text.value.tabTitle),
          h('div', { style: 'display:flex;align-items:center;gap:14px;row-gap:6px;flex-wrap:wrap' }, [
            numberField('size', text.value.sizeLabel, 1, 1),
            h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, [
              h('input', { type: 'checkbox', checked: settings.value.showGrid, style: 'margin:0;cursor:pointer', onChange: (e) => (settings.value.showGrid = e.target.checked) }),
              text.value.gridLabel,
            ]),
            h('button', {
              onClick: () => { settings.value = defaults() },
              style: 'cursor:pointer;padding:2px 8px;border-radius:4px;border:1px solid var(--borderColor,#dcdfe6);background:var(--menuColor,#fff);color:var(--fontColor,#303133);font-size:11px',
            }, text.value.reset),
          ]),
          h('div', { style: 'font-size:11px;line-height:1.7;opacity:.68;margin-top:8px' }, text.value.settingsHint),
        ])
    },
  })

  // Localised copy via ctx.locale.pick (read text.value.xxx), omitted here
  ctx.slots.register('settings.tab', {
    key: 'plugin-my-panel',
    titleZh: '我的面板设置',
    titleEn: 'My panel settings',
    icon: 'fa fa-cogs',
    order: 900,
    component: Settings,
  })

  // Optional: one more card inside Settings → General → Basic (no meta.group, but meta.target is required)
  // A card is usually more compact than a settings page — normally a separate small component (reused here for brevity)
  ctx.slots.register('settings.card', { key: 'plugin-my-panel-card', component: Settings, meta: { target: 'view' } })

[3. Keep big blobs out of the config]
Put images / saves in OPFS under 'plugins/<plugin id>/' (Settings → Plugins → Data measures and clears them) and store only paths plus switches in the config.

[4. Self-check before delivering]
- The tab must appear under the Plugins group; **a second top-level “Plugins” menu means meta.group holds a non-existent id** (drop it or use plugin-group).
- The card may only appear on the target page (make sure meta.target is a **settings page id**, not a group id).
- Changes apply immediately and survive a restart (test a page reload and a plugin reload).
- Pass strings to toasts only (ctx.notify(text.value.xxx), never a ref).

[Deliverable] Full file contents under === package.json === / === client.mjs === / === README.md === headers; nothing omitted, no “rest omitted” placeholders.`,
  },
  {
    key: 'chart',
    titleZh: '图表面板模板：canvas 图表（饼图 / 柱状图切换）',
    titleEn: 'Chart panel template: canvas charts (pie / bar)',
    tabZh: '图表面板',
    tabEn: 'Chart panel',
    descZh:
      '适合「选一个 Excel / CSV，按某一列分组画图」这类需求。**图表插件的失败几乎全在绘制时机上**（只在按钮点击里画、guard 拦错图、观察器挂在还没渲染的 canvas 上），这段模板把这些写法直接钉死。整段粘给大模型即可。',
    descEn:
      'For “pick an Excel / CSV and chart one column”. **Chart plugins fail almost entirely on drawing timing** (painting only from a click handler, a guard that blocks the other chart, an observer attached to a canvas that does not exist yet); this template pins those patterns down. Paste the whole block into your model.',
    bodyZh: `请为 AI-KM（Vue3 + Electron 桌面应用）写一个「图表」插件：面板里选一个 Excel / CSV，按用户选的一列（如「领域」）分组统计，再用 canvas 画图，支持饼图 / 柱状图切换。

【插件信息】
- 插件 id / 目录名：<my-chart>（**只能是 ASCII 小写 [a-z0-9._-]，不能用中文 / 大写 / 空格**——中文目录名会被宿主整目录跳过）；permissions: ["fs"]；declares.slots: ["panel.main"]

${CONSTRAINTS_ZH}

【图表要点（照这段写；图表插件的失败几乎全在「绘制时机」上）】
1. 取数据只用 ctx.files.pickFiles({ accept: 'any' }) 与 await ctx.files.readSheet(path)（返回 { sheetCount, sheets: [{ name, headers, rows, truncated }] }，rows 第一行是表头）；按表头名找列（headers.indexOf('领域')），找不到就给可读提示；选过的路径存进 localStorage（键名 aikm.plugin.<插件 id>.filePath）方便下次载入，**自动载入失败也要提示用户重新选**（软件重启后授权失效）。
2. 状态与绘制分开：
   const data = ref([]); const viewMode = ref('pie'); const pieEl = ref(null); const barEl = ref(null)
   function draw() { try { if (viewMode.value === 'pie') drawPie(pieEl.value, data.value); else drawBar(barEl.value, data.value) } catch (e) { ctx.log.warn('[my-chart] 绘制失败', e) } }
3. **数据 / 视图变化后自动重画**（只在按钮 onClick 里画，用户选完文件看到的就是空白 canvas）：
   watch([data, viewMode], () => draw(), { flush: 'post' })
   canvas 的 ref 回调里也画一次：ref: el => { pieEl.value = el; if (el) { observer.observe(el); draw() } }
4. **每个图各自判自己的 canvas**：drawPie(canvas, rows) 第一行写 if (!canvas) return，drawBar 同理；**不要**写 if (!pieEl) return 这种「用另一个图的 ref 决定要不要画」的判定——切到柱状图时 pieEl 已被置空，柱状图就永远不画。
5. canvas 尺寸与配色：const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; const c = canvas.getContext('2d'); c.scale(dpr, dpr)。颜色写固定色值（canvas 2D **不认 CSS 变量**）；容器还没宽度时（rect.width < 2）直接 return，等 ResizeObserver 再画。
6. ResizeObserver 只观察**已经挂上 DOM 的** canvas（在 ref 回调里 observe），onUnmounted 里 disconnect()；onMounted 里的 setTimeout 只作兜底，不能是唯一的重画入口。
7. 数据多时只画前 12 项、其余合并成「其它」，图例放右侧；无数据时清屏后画一句「暂无数据」（不清屏会叠字）。
8. 文案中英双语（ctx.locale.pick，取值写 text.value.x），提示只传字符串：ctx.notify(text.value.loaded)。

【交付物】按 === package.json === / === client.mjs === / === README.md === 分段给出完整文件内容，不要省略、不要写「此处略」。`,
    bodyEn: `Write an AI-KM (Vue 3 + Electron desktop app) “chart” plugin: pick an Excel / CSV in the panel, group rows by a chosen column (e.g. “Domain”) and draw the result on a canvas, with pie / bar switching.

[Plugin info]
- Plugin id / folder name: <my-chart> (**ASCII lowercase [a-z0-9._-] only — no Chinese, uppercase or spaces**; a Chinese folder name is skipped entirely by the host); permissions: ["fs"]; declares.slots: ["panel.main"]

${CONSTRAINTS_EN}

[Chart essentials — follow these; chart plugins fail almost entirely on drawing timing]
1. Read data only through ctx.files.pickFiles({ accept: 'any' }) and await ctx.files.readSheet(path) (returns { sheetCount, sheets: [{ name, headers, rows, truncated }] }; rows[0] is the header row). Find the column by header name (headers.indexOf('Domain')) and show a readable message when it is missing. Keep the picked path in localStorage (key aikm.plugin.<plugin id>.filePath) so it can load next time, and **ask the user to pick again when the automatic load fails** (the grant expires when the app restarts).
2. Keep state and painting apart:
   const data = ref([]); const viewMode = ref('pie'); const pieEl = ref(null); const barEl = ref(null)
   function draw() { try { if (viewMode.value === 'pie') drawPie(pieEl.value, data.value); else drawBar(barEl.value, data.value) } catch (e) { ctx.log.warn('[my-chart] draw failed', e) } }
3. **Redraw whenever the data or the view mode changes** (painting only from a button onClick leaves the user staring at a blank canvas after picking a file):
   watch([data, viewMode], () => draw(), { flush: 'post' })
   and paint once from the canvas ref callback too: ref: el => { pieEl.value = el; if (el) { observer.observe(el); draw() } }
4. **Each draw checks its own canvas**: start drawPie(canvas, rows) with if (!canvas) return, and the same in drawBar. Never decide “should I draw?” with if (!pieEl) return — switching to the bar chart has already nulled pieEl, so the bar chart would never render.
5. Canvas size and colours: const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; const c = canvas.getContext('2d'); c.scale(dpr, dpr). Use literal colour values (canvas 2D **does not resolve CSS variables**). Return early while the container has no width (rect.width < 2) and let ResizeObserver paint later.
6. A ResizeObserver may only observe **an already-mounted** canvas (observe inside the ref callback) and must be disconnected in onUnmounted. The setTimeout in onMounted is a fallback, never the only way to draw.
7. With many rows draw the top 12 and fold the rest into “Other”, with the legend on the right; with no data clear the canvas and paint a single “no data” line (otherwise old text stacks up).
8. Keep zh + en copy via ctx.locale.pick (read text.value.x) and pass strings to ctx.notify(text.value.loaded).

[Deliverable] Full file contents under === package.json === / === client.mjs === / === README.md === headers; nothing omitted, no “rest omitted” placeholders.`,
  },
  {
    key: 'tool',
    titleZh: '工具插件模板：给智能体加一个工具',
    titleEn: 'Tool plugin template: add an agent tool',
    tabZh: '工具插件',
    tabEn: 'Tool plugin',
    descZh: '适合「让智能体会做 xx」这类需求（主进程半边 + 可选设置页）。整段粘给大模型即可。',
    descEn: 'For “let the agent do X” requests (main-process half plus an optional settings tab). Paste the whole block.',
    bodyZh: `请为 AI-KM 写一个「工具插件」：给智能体新增一个可以调用的工具。

【工具要做什么】
<例如：把一段文字做统计并返回字数 / 调用本地 xxx 命令 / 读取某个目录下的文件清单>

【插件信息】
- 插件 id / 目录名：<my-tool>（**只能是 ASCII 小写 [a-z0-9._-]，不能用中文 / 大写 / 空格**——中文目录名会被宿主整目录跳过；中文写进清单的 aikm.name）
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
- Plugin id / folder name: <my-tool> (ASCII lowercase [a-z0-9._-] only — no Chinese, uppercase or spaces: a Chinese folder name is skipped entirely by the host; write Chinese in the manifest’s aikm.name)
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
    tabZh: '模型 / 文件',
    tabEn: 'Model & files',
    descZh: '适合「上传文件让大模型处理」「选一个文件夹批量分析」这类需求（需要 llm / fs 权限）。',
    descEn: 'For “upload a file and let the model process it” or “pick a folder and analyse it in bulk” (needs llm / fs).',
    bodyZh: `请为 AI-KM 写一个同时使用「大模型」与「文件」能力的插件。

【要做什么】
<例如：选一个 PDF → 提取正文 → 让大模型按指定要求给结论 → 结果可复制导出>

【插件信息】
- 插件 id / 目录名：<my-ai-plugin>（**只能是 ASCII 小写 [a-z0-9._-]，不能用中文 / 大写 / 空格**——中文目录名会被宿主整目录跳过；中文写进清单的 aikm.name）；permissions: ["llm", "fs"]

${CONSTRAINTS_ZH}

【写法要点】
- 选文件/文件夹：await ctx.files.pickFiles({ accept: 'any' }) / await ctx.files.pickDirectory()；返回的路径是后续唯一可读的路径（主进程只授权用户选过的文件）；
- 读文本：await ctx.files.readText(path) → { text, pages, pdf }（PDF 由主进程提取正文，可能有页数/字数上限，按返回值展示真实页数）；
- 读表格：await ctx.files.readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] }（.xlsx / .xls / .csv；界面半边没有 SheetJS，不要自己解析二进制；按表头名取列，注意 truncated 说明被截断）；
- 读二进制：await ctx.files.readBase64(path) → { base64, size }（图片等自定义解析用，默认上限 40MB）；
- ⚠️ **ctx.files 全部是异步**：忘 await 不会报错，但读 res.sheets / res.text 会得到 undefined（面板只会显示「数据为空」）；
  另外 **pickFiles 的返回值不是路径数组**——是 { cancelled, files: [{ path, name, size }] }，取消时 cancelled=true 且不抛错；
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
- Plugin id / folder name: <my-ai-plugin> (ASCII lowercase [a-z0-9._-] only — no Chinese, uppercase or spaces: a Chinese folder name is skipped entirely by the host; write Chinese in the manifest’s aikm.name); permissions: ["llm", "fs"]

${CONSTRAINTS_EN}

[Implementation notes]
- Pick files/folders with await ctx.files.pickFiles({ accept: 'pdf', multiple: false }) / await ctx.files.pickDirectory(); only paths the user picked become readable (the main process authorises exactly those).
- Read text with await ctx.files.readText(path) → { text, pages, pdf } (the main process extracts PDF text; honour any page/char limits and show the real page count).
- Read spreadsheets with await ctx.files.readSheet(path) → { sheetCount, sheets: [{ name, headers, rows, truncated }] } (.xlsx / .xls / .csv; the UI half has no SheetJS — never parse binary yourself; index columns by header name and surface truncated).
- Read raw bytes with await ctx.files.readBase64(path) → { base64, size } (for images and custom parsing; 40MB default cap).
- ⚠️ **every ctx.files method is async**: a missing await throws nothing, but res.sheets / res.text come back undefined (the panel then
  just says “data is empty”). And **pickFiles does not return an array of paths** — it returns { cancelled, files: [{ path, name, size }] };
  cancellation sets cancelled=true and does not throw.
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
    tabZh: '排障',
    tabEn: 'Troubleshoot',
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
export const PLUGIN_DEV_MINIMAL_ZH = `目录（目录名必须等于 id，且只能是 ASCII 小写 [a-z0-9._-]；带中文 / 大写的目录名会被宿主跳过）：
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

/**
 * 主进程半边的最小示例（挂在 `plugin_dev_api_main` 这个话题上）。
 *
 * 为什么单独拆出来：`api` 话题原本把两个半边的成员表与示例塞在一起，体量超了
 * plugin-smoke 的「单次不超过 <话题预算> 字」预算（小模型一次吃不下；预算数由
 * `src/shared/toolResultBudget.ts` 的截断阈值推导，不是手调的数）。按半边拆开后，
 * 写界面半边的人不必读主进程那一套，反之亦然 —— 而"两半边 ctx 串用"本来就是这个
 * 项目最常见的错法（见 src/shared/pluginApiMembers.ts 的 *_CTX_ABSENT 表）。
 */
export const PLUGIN_DEV_MINIMAL_MAIN_ZH = `目录（同一个插件可以同时有界面半边与主进程半边）：
my-plugin/
├── package.json
├── client.mjs        （界面半边，可选）
└── index.mjs         （主进程半边，本话题讲这个）

package.json（在主进程半边里要声明 "main"）：
{
  "name": "my-plugin",
  "version": "1.0.0",
  "aikm": {
    "id": "my-plugin",
    "name": "我的插件",
    "version": "1.0.0",
    "apiVersion": "^1",
    "main": "index.mjs",
    "inject": ["tools"],
    "permissions": ["shell"],
    "declares": { "tools": ["my_plugin_ping"] }
  }
}

index.mjs（注册一个给智能体用的工具）：
export const inject = ['tools']

export function apply(ctx) {
  ctx.tool({
    name: 'my_plugin_ping',
    description: '示例工具：回显一段文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (input) => ({ ok: true, value: { echo: String(input?.text ?? '') } }),
  })
  ctx.log.info('插件已激活')
}

要点：
- 主进程半边的代码与宿主同进程、**不受工作区沙箱约束**；清单里的 permissions 是给用户看的声明与判权依据，不是沙箱。
- 工具名必须带插件前缀（如 my_plugin_），与宿主已有工具重名会**直接装载失败**。
- handler 必须返回 { ok, value?, error? }；抛异常会被宿主统一转成 { ok: false }。
- 声明了 fs / shell 权限的插件，其工具默认需要用户审批（requiresApproval）。**这条是执行的**：
  审批在 toolRegistry 的 pre-execute 阶段拦（所有执行入口都汇聚在那里），三态由用户在
  「插件 → 权限 → 工具审批」控制，默认 ask；没有可用窗口询问时按**拒绝**处理（fail-closed）。
  被拒时工具返回 { ok: false, error }，不抛异常。`

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
