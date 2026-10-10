/**
 * 学习模块：知识库(.kb) 只读加载器（自制读盘）
 *
 * 约定（见 docs/设计决策记录.md §五 学习模块）：
 * - `.kb` 仅用于检索与出题原料，本模块只读、绝不写回；
 * - 学习状态（作答/掌握度/复习）另存为同目录 `<库名>.learning`（兼容读取旧 `.learning.json`，P1 落地）。
 * - 复用 kbRetrieval.loadKnowledgeBase（与 home 主聊天同一套只读解析）。
 */
import { loadKnowledgeBase } from '@/shared/kbRetrieval'
import { listWorkspaceFiles } from '@/services/workspaceScan'

export interface LearningKbFile {
  path: string
  label: string
  mtime: number
}

export interface LearningKbLoaded {
  path: string
  label: string
  blocks: any[]
  /** 问题库（方案 A：题目/复习问题从此出；关联切片在 answerBlocks/srcBlockId） */
  questions: any[]
  files: { path: string; label: string }[]
  entities: any[]
  /** 本体关系（图谱轴用；source/target 为实体 id） */
  relations: any[]
  entityToBlocks?: Array<{ entityName: string; blockIds: string[] }>
  /** 文件级摘要（概览型提问的上下文来源；取自 .kb 的 fileIndex / fileSummaries） */
  fileSummaries?: { path: string; label: string; content: string }[]
  kbConfig?: any
  blockCount: number
}

function baseName(p: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * 扫描各工作区（含子目录，见 workspaceScan.WORKSPACE_SCAN_DEPTH）中已保存的 .kb 文件。
 *
 * 学习模块没有「知识处理」那种按任意路径打开 .kb 的入口（store.kbPathToOpen），
 * 只能靠扫描定位；因此扫描**全部工作区**并下钻子目录，
 * 避免 .kb 与知识库文件夹同级、或放在子目录里时漏掉。
 */
export async function listKbFiles(roots: string[]): Promise<LearningKbFile[]> {
  const files = await listWorkspaceFiles(roots, ['.kb'])
  files.sort((a, b) => b.mtime - a.mtime)
  return files.map((f) => ({ path: f.path, label: f.label, mtime: f.mtime }))
}

/** 只读加载 .kb 并整理为学习模块可用的轻量结构（剥离向量/评分等运行期大字段不在此做，直接取所需字段） */
const KB_VERSION_ALLOWED = new Set(['2.4', '2.5', '3.0'])
export async function readKbForLearning(kbPath: string): Promise<LearningKbLoaded | null> {
  try {
    const kb = await loadKnowledgeBase(kbPath)
    const version = String(kb.kbConfig?.version || '')
    if (version && !KB_VERSION_ALLOWED.has(version)) {
      console.warn('[learning] 不支持的知识库版本:', kbPath, version)
      return null
    }
    const blocks: any[] = kb.blocks || []

    // 文件去重（按 filePath/path/label 归并）
    const fileMap = new Map<string, string>()
    for (const b of blocks) {
      const key = b.filePath || b.path || b.label || ''
      if (key && !fileMap.has(key)) fileMap.set(key, b.label || key)
    }

    // 文件级摘要（概览型提问用）：fileIndex 优先，兼容旧 fileSummaries；都没有则为空数组
    const summaryMap = new Map<string, string>()
    for (const [k, v] of kb.fileIndex.entries()) if (v?.content) summaryMap.set(k, String(v.content))
    for (const [k, v] of kb.fileSummaries.entries()) if (v?.content && !summaryMap.has(k)) summaryMap.set(k, String(v.content))
    const fileSummaries = [...summaryMap.entries()].map(([p, content]) => ({
      path: p, label: fileMap.get(p) || baseName(p), content,
    }))

    return {
      path: kbPath,
      label: baseName(kbPath),
      blocks,
      questions: kb.questions || [],
      files: [...fileMap.entries()].map(([p, label]) => ({ path: p, label })),
      entities: kb.ontology?.entities || [],
      relations: kb.ontology?.relations || [],
      entityToBlocks: kb.ontology?.entityToBlocksIndex,
      fileSummaries,
      kbConfig: kb.kbConfig,
      blockCount: blocks.length,
    }
  } catch (e) {
    console.error('[learning] 加载知识库失败:', kbPath, e)
    return null
  }
}
