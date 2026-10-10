/**
 * file-ext.ts — 文件后缀判定（主进程列表 / 树节点共用）。
 *
 * 多数场景直接用 path.extname 即可；但 Dify DSL 工作流文件名是 `.flow.yml`
 * （双后缀），extname 只会返回 `.yml`，渲染层据此无法与普通 YAML 区分，
 * 会导致工作流文件用不上专属画布视图与图标，故这些场景统一走 flowAwareExt。
 */
import { extname } from 'node:path'

/** Dify DSL 工作流后缀（与渲染层 src/shared/flowFile.ts 的 FLOW_DSL_SUFFIXES 保持一致） */
export const FLOW_DSL_SUFFIX_RE = /\.flow\.(?:yml|yaml)$/i

/** 文件后缀：Dify DSL 工作流整体返回（`.flow.yml` / `.flow.yaml`），其余等同 path.extname */
export function flowAwareExt(filePath: string): string {
  const m = FLOW_DSL_SUFFIX_RE.exec(String(filePath || ''))
  return m ? m[0] : extname(filePath)
}
