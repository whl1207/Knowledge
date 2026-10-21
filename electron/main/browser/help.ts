/**
 * help.ts — Web Agent 的精炼使用指南（browser_help 工具的内容）
 *
 * 为什么需要它：应用内 Agent 有 BROWSER_TOOLS_HINT 系统提示，但通过 MCP 接入的
 * 外部客户端只看到工具 schema，没有工作流约束。这里提供一份**短、通用、按主题**
 * 的说明，让外部智能体在开始任务前调用一次即可，不必把长提示塞进每个工具描述。
 *
 * 只写通用规则，不写具体站点操作（站点经验走 browser_learning_*）。
 */

export type BrowserHelpTopic =
  | 'quickstart'
  | 'actions'
  | 'waits'
  | 'tabs'
  | 'script'
  | 'files'
  | 'learnings'

const QUICKSTART = `Web Agent 快速指南
流程：browser_navigate → browser_snapshot → browser_click/fill（用 [ref=N]）→ browser_wait_for / browser_extract_* → browser_space_finish。
硬规则：
1) 先看再做：操作前先 snapshot；不要猜 CSS，优先用 ref。
2) ref 只在当前页面/当前 DOM 有效；导航或页面明显变化后重新 snapshot。
3) 点击/填写返回的是"动作回执"（新标签/弹窗/下载/控制台错误），不代表业务成功；用 wait_for / snapshot / extract 确认结果。
4) 等待用 browser_wait_for（selector/text/url/loadState/networkIdle），不要用固定 sleep 猜时间。
5) 每个会话只操作自己的标签；用户标签一律拒绝。会话结束用 browser_space_finish 关闭自己的页面（keep 里的交还用户）。
6) 多步任务优先 browser_run 一轮脚本完成；重复站点先 browser_learning_get，已批准的流程直接 browser_playbook_run。
按主题查看：browser_help(topic="actions"|"waits"|"tabs"|"script"|"files"|"learnings")`

const ACTIONS = `动作工具（按 ref 操作）
- browser_click：单击/双击（clickCount）、左/中/右键；ref 或 selector。
- browser_fill：填写 input/textarea/contenteditable；clear=false 追加。
- browser_type：按 selector 输入（只用于没有 ref 的兜底场景）。
- browser_press：按键/组合键（Enter/Tab/Escape/ControlOrMeta+A），可带 ref 先聚焦。
- browser_hover：悬停（展开菜单/tooltip）。
- browser_select：原生 select，按 value/label/index 选择。
- browser_upload：给 input[type=file] 选本地文件（绝对路径，≤20 个）。
- browser_dialog：显式接受/取消 alert/confirm/prompt（弹窗出现后 600ms 内有效，超时自动处理）。
- browser_scroll：滚动页面（也可先 snapshot 看目标是否已在视口）。
原则：可操作性检查会拦"不可见/被遮挡/禁用"；不要用 JS 强行点，改成滚动/等待/关闭遮挡层。`

const WAITS = `等待与验证
- kind=selector：等元素出现/可见（state=visible|attached|hidden）。
- kind=text：等页面文本包含 value（最常用，适合提交后的结果提示）。
- kind=url：等 URL 匹配（正则或子串）。
- kind=loadState：等 load/DOMContentLoaded。
- kind=networkIdle：等网络空闲（SPA 列表加载）。
原则：动作后优先"等一个可观察结果"而不是 sleep；超时后用 browser_snapshot 看实际页面，不要盲目重试提交。`

const TABS = `标签与会话
- 每个 MCP/Agent 会话有自己的标签；browser_list_tabs 只应操作自己可见的标签。
- 页面有稳定 label p1/p2…，便于在 keep 里保留。
- browser_navigate 默认在当前会话标签打开；newTab=true 新开。
- browser_switch_tab / browser_close_tab 只接受自己的标签。
- 单会话页面上限默认 8（设置可改），超出回收最旧页。
- 任务结束：browser_space_finish {keep:["p1"]}；keep 的页面会交还用户，其余关闭。`

const SCRIPT = `脚本化（多步任务优先）
- browser_run：写一段 async 脚本，API：goto(url)、snapshot(opts)、click(ref)、fill(ref,text)、press(key)、hover、select、waitFor(spec)、extract()、text()、url()、title()、sleep(ms)。结束后自动附最终快照。
- 独立步骤需要检查中间结果时，仍用单工具调用；不要为了"看起来快"把需要分支判断的流程硬塞进脚本。
- PTC run_code 里等价可用 browser.*（goto/snapshot/click/fill/press/waitFor/extract/tabs/finish），与 browser_run 共用实现。
- 脚本输出用 return / console.log；大结果只提取需要的片段。`

const FILES = `文件 / 弹窗 / 下载
- 上传：browser_upload {ref, files:[绝对路径]}；先 snapshot 找 input[type=file] 的 ref；跨域 iframe 内暂不支持上传。
- 下载：点击触发后，动作回执会显示"下载「文件名」"；browser_list_downloads 可查状态/路径。
- 弹窗：默认 600ms 后自动处理（alert 接受，confirm/prompt 取消）；要保留/确认时在窗口内调用 browser_dialog。
- 新窗口：window.open/target=_blank 会开新标签并出现在回执里；用 browser_list_tabs 查看并切换。`

const LEARNINGS = `站点经验（跨任务复用）
- 开始某站点任务前：browser_learning_get {host}；不确定有哪些站点：browser_learning_list。
- 成功后把可复用要点（入口 URL、关键按钮、等待条件、登录/风控注意事项）用 browser_learning_save 记录。
- 可复用**完整流程**可保存为可执行 Playbook：browser_playbook_save（草稿）→ 用户批准 → browser_playbook_run。代码只用 browser.*，不要写密码/Cookie/token。
- 不要写入密码、Cookie、token 或个人敏感信息；经验只保存文本。
- 经验按 host 存为 Markdown，用户可在「浏览器设置 → 经验」查看/删除。`

const TOPICS: Record<BrowserHelpTopic, string> = {
  quickstart: QUICKSTART,
  actions: ACTIONS,
  waits: WAITS,
  tabs: TABS,
  script: SCRIPT,
  files: FILES,
  learnings: LEARNINGS,
}

export function buildBrowserHelp(topic?: string): string {
  const key = String(topic || 'quickstart') as BrowserHelpTopic
  return TOPICS[key] || QUICKSTART
}

export function browserHelpTopics(): BrowserHelpTopic[] {
  return Object.keys(TOPICS) as BrowserHelpTopic[]
}
