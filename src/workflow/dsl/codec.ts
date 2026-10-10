/**
 * Dify DSL 的 YAML 编解码（纯 I/O，不做语义校验）
 *
 * 序列化选项刻意贴近 Dify 的导出（Python `yaml.dump(..., allow_unicode=True)`）：
 * - `sortKeys`：PyYAML 默认按键名排序，Dify 导出文件就是这个顺序
 * - `noArrayIndent`：序列项的 `-` 与父键左对齐（PyYAML 风格）
 * - `lineWidth: -1`：不折行，避免长字符串被折成多行标量后丢失原始形态
 *
 * 解析用 CORE_SCHEMA：不做隐式时间戳/特殊类型转换，保证 JSON 化后的往返稳定。
 */

import yaml from 'js-yaml'
import { DSL_MAX_SIZE, type DslDocument } from './types'

/** DSL 处理错误（带可读信息，供 UI 直接展示） */
export class DslError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DslError'
  }
}

/** 字符串的 UTF-8 字节长度 */
export function byteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

/** 解析 DSL 文本为对象；语法错误 / 非映射 / 超限时抛 DslError */
export function parseDslYaml(content: string): Record<string, unknown> {
  if (!content || !content.trim()) throw new DslError('文件内容为空')
  if (byteLength(content) > DSL_MAX_SIZE) {
    throw new DslError(`文件超过 ${Math.round(DSL_MAX_SIZE / 1024 / 1024)}MB 上限`)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA })
  } catch (error) {
    throw new DslError(`YAML 解析失败：${(error as Error).message}`)
  }

  if (parsed === null || parsed === undefined) throw new DslError('文件内容为空')
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DslError('YAML 根节点必须是映射（mapping）')
  }
  return parsed as Record<string, unknown>
}

/** 序列化 DSL 对象为 YAML 文本 */
export function serializeDslYaml(document: DslDocument): string {
  return yaml.dump(document, {
    schema: yaml.CORE_SCHEMA,
    sortKeys: true,
    noArrayIndent: true,
    noRefs: true,
    noCompatMode: true,
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  })
}

/** 判断一段文本是否像 Dify DSL（供「导入 Dify DSL」入口嗅探，不做文件识别） */
export function looksLikeDifyDsl(content: string): boolean {
  try {
    const doc = parseDslYaml(content)
    return doc.kind === 'app' && !!doc.app && !!doc.workflow
  } catch {
    return false
  }
}
