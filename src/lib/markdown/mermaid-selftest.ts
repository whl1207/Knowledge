/**
 * Mermaid 源码规范化的自测（纯字符串，不需要 DOM / mermaid 运行时）
 *
 * 这组用例对应两次真实事故：
 *  1) 未加引号的标签含半角括号 → mermaid Parse error，图不显示；
 *  2) 加引号规则误伤已带引号的边标签（`--"a{id}"-->`）→ 反而制造 Parse error。
 */
import { normalizeMermaidSource } from './mermaid-normalize'

export interface MermaidCase {
  name: string
  ok: boolean
  detail?: string
}

const cases: { name: string; src: string; expect: (out: string) => boolean; detail?: string }[] = [
  {
    name: '菱形标签含半角括号 → 加引号',
    src: 'flowchart LR\n    C{关键催化剂：第二次世界大战 (WWII)} --> D\n',
    expect: (o) => o.includes('C{"关键催化剂：第二次世界大战 (WWII)"}'),
  },
  {
    name: '方括号标签含半角括号 → 加引号',
    src: 'flowchart LR\n    B --> C[数学模型 (Math Models)]\n',
    expect: (o) => o.includes('C["数学模型 (Math Models)"]'),
  },
  {
    name: '中文标签未加引号 → 加引号',
    src: 'flowchart LR\n    A[源文档] --> B[解析与切片]\n',
    expect: (o) => o.includes('A["源文档"]') && o.includes('B["解析与切片"]'),
  },
  {
    name: '已加引号的标签不二次包裹',
    src: 'flowchart LR\n    subgraph OFF["离线构建（处理管线）"]\n    end\n',
    expect: (o) => o.includes('OFF["离线构建（处理管线）"]') && !o.includes('""'),
  },
  {
    name: '边标签里的 {…} 不被二次加引号（引号套引号）',
    src: 'flowchart LR\n    Q --"attempt{blockId,ok}"--> B\n',
    expect: (o) => o.includes('Q --"attempt{blockId,ok}"--> B') && !o.includes('attempt{"'),
  },
  {
    name: '单个 % 注释 → %%',
    src: 'flowchart LR\n    % 这是注释\n    A --> B\n',
    expect: (o) => o.includes('%% 这是注释'),
  },
  {
    name: '%% 注释保持原样',
    src: 'flowchart LR\n    %% 正常注释\n    A --> B\n',
    expect: (o) => o.includes('%% 正常注释'),
  },
  {
    name: 'classDiagram 转 flowchart',
    src: 'classDiagram\n    class Foo {\n      +int id\n    }\n    Foo --> Bar\n',
    expect: (o) => /^flowchart LR/.test(o),
  },
  {
    name: '遮罩占位符不残留',
    src: 'flowchart LR\n    A["已引号 (x)"] --> B[未引号 (y)]\n',
    expect: (o) => !/[\u0000]/.test(o) && o.includes('A["已引号 (x)"]') && o.includes('B["未引号 (y)"]'),
  },
]

export function runMermaidNormalizeSelfTest(): MermaidCase[] {
  return cases.map((c) => {
    try {
      const out = normalizeMermaidSource(c.src)
      if (c.expect(out)) return { name: c.name, ok: true }
      return { name: c.name, ok: false, detail: '实际输出：' + JSON.stringify(out) }
    } catch (e) {
      return { name: c.name, ok: false, detail: String(e) }
    }
  })
}
