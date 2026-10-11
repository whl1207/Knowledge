/**
 * flowFile.ts — 工作流文件（`.flow.yml` / `.flow.yaml`）的识别（渲染进程共用，保持无 DOM 依赖）
 *
 * 工作流文件就是 Dify 应用 DSL（YAML，见 src/features/workflow）：内容由工作流编辑器读写，
 * 因此一律按扩展名判定——知识库里的普通 `.json` / `.yml` 数量很多，不能嗅探内容当工作流。
 */

/** Dify DSL 工作流文件后缀（YAML 内容） */
export const FLOW_DSL_SUFFIXES = ['.flow.yml', '.flow.yaml']

/** 路径是否为 Dify DSL 工作流文件 */
export function isFlowDslPath(path?: string | null): boolean {
  const p = String(path || '').toLowerCase()
  return FLOW_DSL_SUFFIXES.some((s) => p.endsWith(s))
}
