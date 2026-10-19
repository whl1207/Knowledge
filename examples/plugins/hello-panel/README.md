# 示例插件：hello-panel

AI-KM 插件宿主的**最小可用示例**：同时演示主进程半边（工具、服务、事件、宿主能力）与渲染层半边（主面板、设置页签、设置卡片、工作台页签、全局快捷键、中英文案），可作为编写新插件的模板。

## 安装

1. 打开「设置 → 插件 → 管理」，点标题栏右侧的 ➕ **从文件夹安装**并选择本目录（也可先把整个目录复制到插件目录：`<userData>/plugins`，目录名必须与清单 `aikm.id` 一致）；
2. 插件目录默认 `<userData>/plugins`，可用标题栏的「选择插件目录」改到自己的文件夹（与技能一致）；
3. 点刷新（或重启应用）——插件会被自动发现；目录内文件改动会**自动重载**；
4. 「设置 → 工具 → 注册表」中应能看到 `hello_echo`（scope 显示为 `plugin:hello-panel`）；
5. 导航栏出现「示例插件」按钮（插件注册的主面板）；设置里多出「插件 → 示例插件」页签，以及插在「基础」页里的示例卡片；
6. 按 Ctrl+Shift+H 会弹出一条通知（示例插件注册的全局快捷键）；「插件 → 管理 → 详情」里能看到它占用的全部位置与快捷键。

> 卸载验证：在插件页点「禁用」，`hello_echo` 立即从注册表消失，「示例插件」按钮、设置页签与卡片、快捷键同时失效；
> 若停用前正停在插件面板上，主导航会自动切回「主页」。「移除」时会再问一次是否**连磁盘文件一起删除**。

## 清单字段（`package.json` 的 `aikm` 字段）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件唯一 id，必须与目录名一致（小写 kebab-case 风格） |
| `name` | | 展示名，缺省用 id |
| `version` | ✅ | 语义化版本 |
| `apiVersion` | ✅ | 要求的宿主 API 区间，如 `^1` / `>=1 <2` / `1` |
| `main` | | 主进程入口（相对插件目录）；与 `client` 至少一个 |
| `client` | | 渲染层半边 `{ entry, inject? }`（单文件 ESM） |
| `inject` | | 依赖的宿主服务名，未就绪时插件停在「等待依赖」 |
| `permissions` | | `fs` / `shell` / `net` / `agent` / `agent.run` / `llm` / `image`（见下） |
| `declares` | | 声明式清单（工具名、界面槽位），仅用于展示与预检 |

## 权限

| 权限 | 解锁的宿主能力 |
|---|---|
| `fs` | 文件能力：两个半边的 `ctx.fs`（插件目录内免授权，其余路径只认用户在该插件里选过的授权），以及工具路径的审批 seam（`requiresApproval`） |
| `shell` | `ctx.host.runShell(cmd, { policy: 'trusted' })`（仍需显式传 trusted，与 `run_shell` 工具同一策略） |
| `net` | `ctx.host.fetch(url)` |
| `agent` | `ctx.host.sessions.list()`（会话日志只读视图） |
| `agent.run` | `ctx.agent.run()` / `ctx.agents.*`（委派一次独立会话；与只读的 `agent` 是两件事，仅桌面端） |
| `llm` | `ctx.llm.*`（对话 / 流式 / 结构化输出） |
| `image` | `ctx.image.*`（生图；服务地址与 token 由用户在设置里配） |

> ⚠️ 权限是**透明化与误操作防护**，不是沙箱：插件代码与宿主同进程运行（渲染层半边与主界面同文档），
> 不受工作区沙箱保护。设置页会在启用前展示权限并要求确认。

## 主进程半边 `ctx`（`index.mjs`）

```js
export const inject = ['tools']
export function apply(ctx) {
  ctx.tool(toolDefinition)          // 注册工具（scope = plugin:<id>）
  ctx.service(name, impl)           // 提供命名服务
  ctx.getService(name)              // 读取服务
  ctx.on('tool/post-execute', fn)   // 订阅宿主事件
  ctx.effect(() => cleanup)         // 副作用 + 卸载清理
  ctx.host.readFile / writeFile / listDir / runShell / fetch / sessions / granted / notify
  ctx.fs.readText / readBytes / readBase64 / listDir / writeText / editText / stat / resolve / remove / sheet.read  // 与界面半边同形状
  ctx.storage.get / set / delete / keys
  ctx.log.debug / info / warn / error
  ctx.config                        // 用户在插件页「配置」里保存的 JSON
}
```

## 渲染层半边 `ctx`（`client.mjs`）

```js
export function apply(ctx) {
  const { h, defineComponent, ref } = ctx.vue     // 宿主注入的 Vue（单实例）
  ctx.slots.register('panel.main', {             // 主面板（自动获得导航按钮 + 顶栏标题）
    key: '示例插件', titleZh: '示例插件', titleEn: 'Hello Panel',
    icon: 'fa fa-puzzle-piece', order: 900,
    component: defineComponent({ setup: () => () => h('div', '内容') }),
  })
  ctx.slots.register('settings.tab', { key: 'plugin-hello', titleZh: '示例插件', titleEn: 'Hello', component })
  ctx.slots.register('settings.card', {           // 插进「已有」设置页（meta.target = 目标页 id）
    key: 'hello-inline-card', titleZh: '示例插件卡片', order: 900,
    component: defineComponent({ setup: () => () => h('div', '卡片') }),
    meta: { target: 'view' },
  })
  ctx.slots.register('swarm.workbench.tab', { key: 'hello-workbench', titleZh: '插件页签', titleEn: 'Plugin Tab', component })

  // 全局快捷键：返回 disposer，卸载自动注销
  ctx.shortcuts.register('Ctrl+Shift+H', () => ctx.notify('按到快捷键了'), {
    titleZh: '弹出一条通知', titleEn: 'Show a notification',
  })

  // 中英文案：pick 返回随界面语言变化的 computed，ref 取单个键
  const text = ctx.locale.pick({
    zh: { title: '示例插件面板' },
    en: { title: 'Hello Panel' },
  })

  ctx.effect(() => cleanup)      // 卸载清理（槽位条目由注册表自动撤销）
  ctx.log / ctx.config / ctx.on
}
```

### 渲染层 ctx 一览

| 成员 | 说明 |
|---|---|
| `ctx.vue` | 宿主注入的 Vue API 子集（`h` / `defineComponent` / `ref` / `computed` / `watch` / `onMounted` / `onUnmounted` / `inject` / `useSlots`） |
| `ctx.slots.register` / `declare` / `entries` | 注册 / 声明子槽位 / 查看条目 |
| `ctx.shortcuts.register(binding, handler, options)` | 注册全局快捷键（`options` 可带 `titleZh` / `titleEn` 说明，会显示在插件详情里） |
| `ctx.shortcuts.list()` | 当前全部快捷键（含占位与来源） |
| `ctx.locale` | `pick(dict)` → 随语言变化的 computed 字典；`ref(dict, key)` → 单键；`t(dict, key, params)` → 即时取词；`languageRef` / `language` |
| `ctx.notify(message)` | 弹一条消息提示（跟随界面语言的文案由插件自己决定；**只接受字符串**） |
| `ctx.fs` | 文件能力（权限 `fs`，两半边同形状）：`resolve` / `stat`（版本）/ `readText` / `readBytes` / `readBase64` / `listDir` / `writeText`（可带 `expectedVersion`）/ `editText` / `remove` / `sheet.read`；失败抛 `FS_*` 错误码 |
| `ctx.files` | 选择框与预览（权限 `fs`）：`pickFiles` / `pickDirectory` / `pickWritableDirectory` / `renderPdfPage` / `openInApp`（读写是老别名的同义实现） |
| `ctx.app` | `info()` / `agentPresets()` / `setChromeHidden(hidden)` / `chromeHidden()`（只读信息与全屏时的外壳控制） |
| `ctx.llm` | 权限 `llm`：`available` / `reason` / `sources()` / `current()` / `models(source)` / `chat({ …, schema })` / `stream({ messages, schema })` |
| `ctx.agent` / `ctx.agents` | 权限 `agent.run`（仅桌面端）：`run(presetId, input, opts)` / `create({ preset, input })` → 句柄（`whenIdle` / `result` / `usage` / `stream` / `cancel` / `dispose`） |
| `ctx.image` | 权限 `image`：`info()` / `generate({ prompt, … })` / `cancelAll()`；**失败不抛**，看 `ok` / `code` |
| `ctx.tts` | 语音朗读（无需权限）：`speak(text, { stopPrevious })` / `stop()` / `available` / `reason` |
| `ctx.on` / `ctx.effect` / `ctx.log` / `ctx.config` | 订阅观测事件（只收到属于自己的工具 / 委派事件）/ 副作用清理 / 日志（`debug`~`error`）/ 用户在插件页保存的配置 |

### 可用槽位

| 槽位 | 语义 | 条目需要 |
|---|---|---|
| `panel.main` | 主面板（含导航按钮与顶栏标题） | `key` / `titleZh` / `titleEn` / `icon` / `component` / `order` |
| `settings.tab` | 设置页签 | `key`（设置导航 id）/ `titleZh` / `titleEn` / `component`；`meta.group` 可指定分组 |
| `settings.card` | 设置卡片：插进**已有**设置页 | `key` / `component` / `meta.target`（目标设置页 id，如 `'view'` / `'features'`） |
| `swarm.workbench.tab` | 集群工作台页签（追加在「通信」之后） | `key` / `titleZh` / `titleEn` / `component` / `order` |
| `chat.message.actions` | 消息操作按钮（P1 暂未接线） | `key` / `component` |

> `panel.main` 与 `settings.tab` 是 **keyed** 槽位：同一个 key 只保留最后一个注册；
> `settings.card` / `swarm.workbench.tab` / `chat.message.actions` 是 **list** 槽位：条目按 `order` 排序后全部渲染，
> 其中 `meta.target` 可把条目限定到某个具体 owner（设置页 id）。
> 渲染时应用的是「按 owner 过滤后」的条目，所以 list 槽位的 `meta.target` 必须由外壳传入 owner 才生效。

### 客户端半边的硬规则

- **单文件 ESM 且不能有 `import`**：宿主用 Blob URL 动态 import，Blob 模块解析不了裸模块名与相对路径；
- **不要自带 vue**：用 `ctx.vue`（宿主注入的是同一个 Vue 运行时；自带副本会让响应式失效）；
- 宿主是 **runtime-only** 构建，没有模板编译器 → 组件用 `h()` / `defineComponent` 手写 render；
- 单个扩展崩溃只会显示「扩展出错了」+ 重试按钮，不会影响主界面（错误边界）。

所有注册方法都返回 disposer，插件卸载时**逆序**执行——这就是「注册即副作用、卸载即撤销」。
