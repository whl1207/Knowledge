/**
 * 学习模块：知识库(.kb) 只读加载器（自制读盘）
 *
 * 约定（见 docs/设计决策记录.md §五 学习模块）：
 * - `.kb` 仅用于检索与出题原料，本模块只读、绝不写回；
 * - 学习状态（作答/掌握度/复习）另存为同目录 `<库名>.learning`（兼容读取旧 `.learning.json`，P1 落地）。
 * - 复用 kbRetrieval.loadKnowledgeBase（与 home 主聊天同一套只读解析）。
 */
import { loadKnowledgeBase } from '@/shared/kbRetrieval'

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
  entityToBlocks?: Array<{ entityName: string; blockIds: string[] }>
  kbConfig?: any
  blockCount: number
}

function baseName(p: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** 扫描当前工作区所有已保存的 .kb 文件（含自动知识库的排除由调用方决定：仅列实体 .kb） */
export async function listKbFiles(root: string): Promise<LearningKbFile[]> {
  if (!root) return []
  try {
    const result = await window.ipcRenderer.invoke('getFilesRelation', root, 1)
    const fileList = (result && result.fileList) || []
    const kbs = fileList.filter(
      (f: any) => typeof f?.path === 'string' && f.path.toLowerCase().endsWith('.kb')
    )
    kbs.sort((a: any, b: any) => (b.mtime || 0) - (a.mtime || 0))
    return kbs.map((f: any) => ({
      path: f.path,
      label: f.label || baseName(f.path),
      mtime: f.mtime || 0,
    }))
  } catch (e) {
    console.error('[learning] 扫描知识库失败:', e)
    return []
  }
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

    return {
      path: kbPath,
      label: baseName(kbPath),
      blocks,
      questions: kb.questions || [],
      files: [...fileMap.entries()].map(([p, label]) => ({ path: p, label })),
      entities: kb.ontology?.entities || [],
      entityToBlocks: kb.ontology?.entityToBlocksIndex,
      kbConfig: kb.kbConfig,
      blockCount: blocks.length,
    }
  } catch (e) {
    console.error('[learning] 加载知识库失败:', kbPath, e)
    return null
  }
}
