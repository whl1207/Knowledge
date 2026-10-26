/**
 * toolFilePath.selftest.ts — 打开工具写入文件时的路径拼接
 *
 * 回归点：全局工作区事后被切到技能目录时，点击旧消息的「打开文件」不能把相对路径
 * 拼到全局根上；必须优先使用该聊天自己的工作区（与 agent 执行时的 cwd 一致）。
 *
 * 用法：`node scripts/run-selftests.mjs toolFilePath`
 */

import { isAbsoluteToolPath, resolveToolFilePath } from './toolFilePath'

export interface ToolFilePathCase { name: string; ok: boolean; detail?: string }

export function runToolFilePathSelfTest(): ToolFilePathCase[] {
  const cases: ToolFilePathCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  add('绝对路径：Windows', isAbsoluteToolPath('D:\\工作区\\demo_page.html'))
  add('绝对路径：POSIX', isAbsoluteToolPath('/tmp/demo_page.html'))
  add('绝对路径：UNC', isAbsoluteToolPath('\\\\server\\share\\a.html'))
  add('相对路径：不是绝对路径', !isAbsoluteToolPath('demo_page.html'))
  add('驱动器相对路径不是绝对路径（保持原有语义）', !isAbsoluteToolPath('D:demo_page.html'))

  const chat = 'D:\\工作区'
  const staleGlobal = 'D:\\Project\\1 Knowledge\\scripts\\kb'

  add(
    '聊天工作区优先于全局工作区（复现本次 ENOENT）',
    resolveToolFilePath('demo_page.html', { chatWorkspace: chat, globalRoot: staleGlobal })
      === 'D:\\工作区\\demo_page.html',
    resolveToolFilePath('demo_page.html', { chatWorkspace: chat, globalRoot: staleGlobal }),
  )
  add(
    '聊天工作区结尾斜杠会被去掉',
    resolveToolFilePath('demo_page.html', { chatWorkspace: 'D:\\工作区\\' })
      === 'D:\\工作区\\demo_page.html',
  )
  add(
    'POSIX 绝对路径原样返回',
    resolveToolFilePath('/demo_page.html', { chatWorkspace: chat })
      === '/demo_page.html',
  )
  add(
    'Windows 根目录里的正斜杠会归一为反斜杠',
    resolveToolFilePath('demo_page.html', { chatWorkspace: 'D:/工作区' })
      === 'D:\\工作区\\demo_page.html',
  )
  add(
    'POSIX 根目录拼 POSIX 路径',
    resolveToolFilePath('demo_page.html', { chatWorkspace: '/tmp/ws/' })
      === '/tmp/ws/demo_page.html',
  )
  add(
    '没有聊天工作区时回落全局工作区',
    resolveToolFilePath('demo_page.html', { chatWorkspace: '   ', globalRoot: staleGlobal })
      === 'D:\\Project\\1 Knowledge\\scripts\\kb\\demo_page.html',
  )
  add(
    '再回落 fallbackRoots',
    resolveToolFilePath('a.txt', { fallbackRoots: ['', 'E:\\ws'] }) === 'E:\\ws\\a.txt',
  )
  add('没有任何根时原样返回', resolveToolFilePath('demo_page.html') === 'demo_page.html')
  add('绝对路径不参与拼接', resolveToolFilePath('D:\\工作区\\demo_page.html', { chatWorkspace: staleGlobal })
    === 'D:\\工作区\\demo_page.html')
  add('空路径返回空串', resolveToolFilePath('', { chatWorkspace: chat }) === '')

  return cases
}
