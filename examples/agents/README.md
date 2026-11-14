# 证据推理智能体（.agent）

## 文件

- 源码：`examples/agents/证据推理智能体.agent`
- 已安装：
  - `%APPDATA%\knowledge-dev\agent-presets\证据推理智能体.agent`
  - `%APPDATA%\knowledge\agent-presets\证据推理智能体.agent`

## 定位

面向批量任务的一行：给一条会议记录或撤稿记录，查证后输出**可追溯的答案**。

- 输入有姓名/候选证据 → OpenAlex 作者消歧；
- 输入有 DOI/撤稿 → 撤稿原因分类；
- 其他输入 → 通用公开信息核查。

它不是“聊天助手”，不写文件、不跑 shell、不调用子智能体。

## 工具

只开两个：

- `web_search`
- `web_fetch`

不新增工具，也不需要 MCP。证据页签的 `sources` 就来自这两个工具产生的 URL / 结果片段。

> 如果要把 `openalex-pg` 的离线库作为工具，需要另配 skill / MCP；当前版本刻意只用 web，保证通用、无环境依赖。

## 关键约束

- 候选证据足够时，不为了“多查”而调用工具；
- 一次任务最多访问 6 个页面；
- 不编造 URL/quote；找不到可靠来源就回答“无法确定”；
- 合并档案（机构数/论文数异常大）要降权或排除；
- 碎片档案（1 篇、无 ORCID、无机构）不能仅凭姓名选中；
- 撤稿类别必须用封闭八类。

## 怎么用

1. 在「设置 → 智能体 → 管理」里点「重新扫描」（或重启应用），选中「证据推理智能体」。
2. 打开 Agent Scaffold，导入 `experiments/e1/out/by_task/*_smoke3.xlsx`。
3. 执行方式选 Agent，输出方式选“单独结果”。
4. **执行器预设**选「证据推理智能体」。
5. 勾选「证据」；任务指令用 `by_task/*_instruction.md`。
6. 并发 2、最大步数 10，先跑 3 行。

## 输出

```json
{
  "answer": "A1234567890 / 数据/结果问题 / 无法确定",
  "evidence_url": "https://...",
  "quote": "页面原文片段",
  "confidence": "高/中/低",
  "reason": "一句话依据"
}
```

`evidence_url` 和 `quote` 是给证据页签/人工复核用的；没有可靠来源时不要编。

## 注意

- 这个预设只负责“查证 + 作答”，不负责自动重跑；`retrieve_more` / `switch_executor` 是脚手架 attempt 层的事。
- 如果任务只跑 Pure LLM、不走工具，证据页签会是 `out_of_scope` 或 `incomplete`，这是预期。
- 预设文件是 JSON，字段名不要改；`capabilities.enabledTools` 必须与工具名逐字一致。
