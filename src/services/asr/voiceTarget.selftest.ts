/**
 * voiceTarget.selftest.ts — 全局语音输入「落点判断 + 文本规则」自测（纯计算，不依赖 DOM）
 *
 * 这两件事是全局语音输入最容易悄悄坏掉的部分：
 *   · 谁能当落点（判断太松 → 把字写进隐藏的代理输入框 / 只读框；太紧 → 明明能输入的框却写不进去）；
 *   · 一句话的文本规则（中英混排时该不该补空格）。
 * 因此把它们做成纯函数并在这里固化。
 *
 * 用法（开发期）：
 *   import { runVoiceTargetSelfTest } from '@/services/asr/voiceTarget.selftest'
 *   console.table(runVoiceTargetSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs voiceTarget`
 */

import { isVoiceEditable, speechInsertText, type EditableDescriptor } from './voiceTargetCore'

export interface VoiceTargetCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一份「形状描述」：默认是一只有布局的普通文本 input */
function desc(patch: Partial<EditableDescriptor> = {}): EditableDescriptor {
  return { tagName: 'INPUT', inputType: 'text', kind: 'input', hasLayout: true, ...patch }
}

export function runVoiceTargetSelfTest(): VoiceTargetCase[] {
  const cases: VoiceTargetCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 能当落点的常见元素
  add('落点：普通文本 input 可以', isVoiceEditable(desc()))
  add('落点：textarea 可以', isVoiceEditable(desc({ tagName: 'TEXTAREA', inputType: undefined, kind: 'textarea' })))
  add('落点：contenteditable 可以', isVoiceEditable(desc({ tagName: 'DIV', inputType: undefined, isContentEditable: true, kind: 'editable' })))
  add('落点：password / email / search 等文本类 input 可以',
    isVoiceEditable(desc({ inputType: 'password' })) && isVoiceEditable(desc({ inputType: 'email' })) && isVoiceEditable(desc({ inputType: 'search' })))

  // 2. 不能当落点：控件类 input / 只读 / 禁用 / 隐藏 / 代理输入框
  const nonText = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden']
  add('落点：非文本 input 全部排除（写进去也看不见）', nonText.every((t) => !isVoiceEditable(desc({ inputType: t }))),
    nonText.filter((t) => isVoiceEditable(desc({ inputType: t }))).join(','))
  add('落点：只读 input / textarea 排除',
    !isVoiceEditable(desc({ readOnly: true })) && !isVoiceEditable(desc({ tagName: 'TEXTAREA', readOnly: true, kind: 'textarea' })))
  add('落点：禁用元素排除', !isVoiceEditable(desc({ disabled: true })))
  add('落点：没有布局盒（display:none / v-show 隐藏）排除', !isVoiceEditable(desc({ hasLayout: false })))
  add('落点：aria-hidden 排除', !isVoiceEditable(desc({ ariaHidden: true })))
  add('落点：monaco 的隐藏 textarea 排除（要走编辑器 API）', !isVoiceEditable(desc({ insideMonaco: true })))
  add('落点：终端等代理输入框排除', !isVoiceEditable(desc({ insideProxyEditor: true })))
  add('落点：普通 div（不可编辑）排除', !isVoiceEditable(desc({ tagName: 'DIV', inputType: undefined, kind: 'editable' })))

  // 3. 文本规则：中文之间不补空格，英文词与英文词之间补
  add('文本：空串原样返回', speechInsertText('', '') === '')
  add('文本：纯中文不补空格', speechInsertText('今天天气不错', '的') === '今天天气不错')
  add('文本：中文句末标点不补空格', speechInsertText('你好。', '好') === '你好。')
  add('文本：英文结尾补一个尾随空格', speechInsertText('hello', '') === 'hello ', JSON.stringify(speechInsertText('hello', '')))
  add('文本：光标前是英文词字符时补前导空格', speechInsertText('world', 'o') === ' world ', JSON.stringify(speechInsertText('world', 'o')))
  add('文本：光标前是空格不重复补', speechInsertText('world', ' ') === 'world ')
  add('文本：光标前是中文不补前导空格', speechInsertText('world', '界') === 'world ')
  add('文本：已有尾随空格不重复补', speechInsertText('hello ', '') === 'hello ')
  add('文本：换行结尾不补空格', speechInsertText('hello\n', '') === 'hello\n')
  add('文本：数字结尾（英文语境）补空格', speechInsertText('2024', '') === '2024 ')

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logVoiceTargetSelfTest(): boolean {
  const cases = runVoiceTargetSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[voiceTarget] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
