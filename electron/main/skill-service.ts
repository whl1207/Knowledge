/**
 * skill-service.ts — 技能多根发现 + 变更监听（对齐 DSH Skills 注册表）
 *
 * 借鉴 DeepSeek-Harness skills 子系统（docs/subsystems/skills.md）：
 * - **多 Provider 按优先级合并目录**：`SkillProvider` 提供 candidate（含
 *   rank/locator），注册表只做合并与去重（rank 小者胜出），`get()` 按名读取；
 * - **目录变更监听**：fs.watch 监听每个根，diff 出 added/removed/changed，
 *   经 `skill:change` 事件通知消费方，UI 增量刷新（不再手动 refresh）；
 * - **源与优先级**：source 是展示用元数据而非优先级本身；同 rank 时先注册者胜。
 *
 * 兼容性：保留主进程原 `loadSkills` 的解析逻辑与返回形状（name/description/
 * path/metadata/source/promptVersion/preview），渲染进程无需改动即可消费。
 */

import { join, extname } from 'node:path'
import * as fs from 'node:fs'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 技能预览中保留的最大文件数（防超大型技能如 1w+ 模板文件拖垮 IPC 传输与
 * 上下文注入；超过时按"重要扩展名优先"采样，对齐 DSH"资源按需加载、
 * 结果不枚举技能目录"）。
 */
const SKILL_PREVIEW_MAX_FILES = 200

/** 采样时优先保留的扩展名（文本/脚本/配置类；资产/模板等海量资源不优先） */
const SKILL_PREVIEW_PRIORITY_EXT = new Set([
  '.md', '.markdown', '.txt', '.py', '.js', '.mjs', '.cjs', '.ts', '.vue',
  '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.sh', '.bat', '.cmd',
  '.ps1', '.css', '.html', '.htm', '.csv', '.tsv',
])

/** 技能目录内的资源文件（SKILL.md 之外） */
export interface SkillFileInfo {
  name: string
  path: string
  size: number
}

/** 技能候选（provider → registry 的形状；rank 小者优先） */
export interface SkillCandidate {
  name: string
  description: string
  path: string
  metadata: Record<string, any>
  source: string
  promptVersion: string
  preview: {
    content: string
    /** 受限采样后的文件清单（重要扩展名优先，最多 SKILL_PREVIEW_MAX_FILES 个） */
    files: SkillFileInfo[]
    /** 技能目录下真实文件总数（files 为采样，此数为完整计数） */
    fileCount: number
  }
  /** 注册表内优先级（小者胜出） */
  rank: number
  /** 提供方名称（user/project/bundled/…） */
  provider: string
}

/** 技能提供方：一个技能来源（本地目录 / 内置包 / 远端目录） */
export interface SkillProvider {
  name: string
  rank: number
  list(): SkillCandidate[]
  /** 是否由 setRoots 管理根目录（内置 user provider 为 true） */
  readonly rootsManaged?: boolean
}

/** 目录变更种类 */
export type SkillChangeKind = 'added' | 'removed' | 'changed'
export type SkillChangeListener = (kind: SkillChangeKind, names: string[]) => void

// ---------------------------------------------------------------------------
// frontmatter 解析（自 index.ts 迁移，逻辑保持不变）
// ---------------------------------------------------------------------------

/**
 * 修复第三方技能 frontmatter 的常见 YAML 问题（借鉴 OpenAI Codex
 * parser.rs 的 repair_frontmatter_scalar_fields）。
 */
export function repairFrontmatterYaml(frontmatter: string): string {
  return frontmatter.split('\n').map((line) => {
    const m = line.match(/^(\s*)([\w][\w.-]*):\s*(.+)$/)
    if (!m) return line
    const [, indent, key, value] = m
    // 值已是合法结构化形式（list/map/引用/块）则不处理
    if (/^[\[{"'|>]/.test(value)) return line
    // 未加引号的标量值中含 ": "（YAML 不允许）→ 用双引号包裹并转义
    if (/:[ \t]/.test(value) && !/^['"]/.test(value)) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `${indent}${key}: "${escaped}"`
    }
    return line
  }).join('\n')
}

/** 解析 SKILL.md 的 YAML frontmatter（带容错修复） */
export function parseSkillMetadata(content: string): { [key: string]: any } | null {
  const matches = content.match(/^---\r?\n([\s\S]+?)\r?\n---/)
  if (matches && matches.length > 1) {
    try {
      return yaml.load(matches[1]) as { [key: string]: any }
    } catch (error) {
      // 容错：行级修复后重试
      try {
        const repaired = repairFrontmatterYaml(matches[1])
        const parsed = yaml.load(repaired)
        if (parsed && typeof parsed === 'object') {
          console.warn('技能 frontmatter 首次解析失败，已通过容错修复成功加载')
          return parsed as { [key: string]: any }
        }
      } catch {
        // 忽略，走下方报错
      }
      console.error('解析YAML失败:', error)
      return null
    }
  }
  return null
}

/** 计算技能内容的简单哈希，用于 promptVersion 变更检测（ESM 兼容） */
export function computeSkillHash(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return 'v' + Math.abs(hash).toString(36)
}

// ---------------------------------------------------------------------------
// 单技能目录解析
// ---------------------------------------------------------------------------

/** 解析一个技能目录（要求含 SKILL.md）；解析失败返回 null */
export function parseSkillDir(
  skillPath: string,
  provider: string,
  rank: number,
  source: string,
): SkillCandidate | null {
  const skillMdPath = join(skillPath, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) return null
  try {
    const content = fs.readFileSync(skillMdPath, 'utf8')
    const metadata = parseSkillMetadata(content)
    if (!metadata || !metadata.name) return null

    // 递归收集目录下文件：真实总数全量统计（fileCount），但 `files` 只保留
    // 受限采样（重要扩展名优先，最多 SKILL_PREVIEW_MAX_FILES 个）。避免超大
    // 技能（如 1w+ 模板文件）把全量清单经 IPC 传到渲染进程、再注入 agent 上下文，
    // 导致推理被截断（对齐 DSH"资源按需加载、结果不枚举技能目录"）。
    // 用 withFileTypes 免去每个文件的 statSync（大幅提速，仅对采样文件补 size）。
    const allFiles: SkillFileInfo[] = []
    let fileCount = 0
    const priority: SkillFileInfo[] = []
    const rest: SkillFileInfo[] = []
    const collectFiles = (dir: string, prefix: string = '') => {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return // 单目录不可读不阻断整个技能
      }
      for (const entry of entries) {
        if (entry.name === 'SKILL.md') continue
        if (entry.isDirectory()) {
          collectFiles(join(dir, entry.name), prefix + entry.name + '/')
        } else if (entry.isFile()) {
          fileCount++
          const info: SkillFileInfo = { name: prefix + entry.name, path: join(dir, entry.name), size: 0 }
          if (SKILL_PREVIEW_PRIORITY_EXT.has(extname(entry.name).toLowerCase())) {
            if (priority.length < SKILL_PREVIEW_MAX_FILES) priority.push(info)
          } else if (rest.length < SKILL_PREVIEW_MAX_FILES) {
            rest.push(info)
          }
        }
      }
    }
    collectFiles(skillPath)
    // 优先保留重要文件，再补其余，截断到预算；为保留的采样文件补真实 size
    const sampled = [...priority, ...rest].slice(0, SKILL_PREVIEW_MAX_FILES)
    for (const f of sampled) {
      try { f.size = fs.statSync(f.path).size } catch { /* ignore */ }
    }

    return {
      name: metadata.name,
      description: metadata.description || '',
      path: skillPath,
      metadata,
      source: metadata.source || source,
      promptVersion: computeSkillHash(content),
      preview: { content, files: sampled, fileCount },
      rank,
      provider,
    }
  } catch (error) {
    console.error(`解析技能 ${skillPath} 失败:`, error)
    return null
  }
}

/** 扫描一个根目录下的全部技能目录 */
export function scanSkillRoot(root: string, provider: string, rank: number, source: string): SkillCandidate[] {
  if (!root || !fs.existsSync(root)) return []
  const out: SkillCandidate[] = []
  let items: string[] = []
  try {
    items = fs.readdirSync(root)
  } catch (e) {
    console.error(`扫描技能目录 ${root} 失败:`, e)
    return []
  }
  for (const item of items) {
    const skillPath = join(root, item)
    try {
      const stats = fs.statSync(skillPath)
      if (!stats.isDirectory()) continue
      const candidate = parseSkillDir(skillPath, provider, rank, source)
      if (candidate) out.push(candidate)
    } catch (e) {
      console.warn(`技能目录 ${item} 读取失败:`, e)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 技能服务（provider 注册表 + 多根合并 + watcher）
// ---------------------------------------------------------------------------

class SkillService {
  private providers: SkillProvider[] = []
  private watchers: fs.FSWatcher[] = []
  private listeners = new Set<SkillChangeListener>()
  private debounceTimer: NodeJS.Timeout | null = null
  private lastSnapshot: Map<string, string> | null = null // name → promptVersion

  /** 注册一个技能提供方；返回注销函数（对齐"注册即副作用、卸载即撤销"） */
  registerProvider(provider: SkillProvider): () => void {
    this.providers.push(provider)
    this.lastSnapshot = null
    return () => {
      this.providers = this.providers.filter((p) => p !== provider)
      this.lastSnapshot = null
    }
  }

  /** 设置 user provider 的根目录列表（替换式；无效根静默忽略） */
  setRoots(roots: string[]): void {
    this.removeUserProvider()
    const validRoots = (roots || []).filter((r) => !!r)
    if (validRoots.length === 0) return
    this.registerProvider({
      name: 'user',
      rank: 100,
      rootsManaged: true,
      list: () => {
        const out: SkillCandidate[] = []
        for (const root of validRoots) {
          out.push(...scanSkillRoot(root, 'user', 100, 'user'))
        }
        return out
      },
    })
    // 重设根目录后重建 watcher
    this.clearWatchers()
    for (const root of validRoots) this.watchRoot(root)
  }

  private removeUserProvider(): void {
    this.providers = this.providers.filter((p) => p.name !== 'user')
  }

  /** 合并所有 provider 的候选（rank 小者胜出；同 rank 先注册者胜） */
  list(): SkillCandidate[] {
    const byName = new Map<string, SkillCandidate>()
    for (const provider of this.providers) {
      for (const candidate of provider.list()) {
        const existing = byName.get(candidate.name)
        if (!existing || candidate.rank < existing.rank) {
          byName.set(candidate.name, candidate)
        }
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 按名读取技能候选（不存在返回 undefined） */
  get(name: string): SkillCandidate | undefined {
    return this.list().find((c) => c.name === name)
  }

  /** 订阅目录变更；返回注销函数 */
  onChange(listener: SkillChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 全量重新扫描并强制发一次 changed（供 UI 手动刷新后的兜底同步） */
  refresh(): void {
    this.lastSnapshot = null
    this.diffAndEmit(true)
  }

  // ---------------- 内部 ----------------

  private watchRoot(root: string): void {
    const onEvent = () => this.scheduleDiff()
    // Windows/macOS 支持递归监听；Linux 回退到非递归
    try {
      const watcher = fs.watch(root, { recursive: true }, onEvent)
      watcher.on('error', () => { /* 忽略监听错误 */ })
      this.watchers.push(watcher)
    } catch {
      try {
        const watcher = fs.watch(root, onEvent)
        watcher.on('error', () => { /* 忽略监听错误 */ })
        this.watchers.push(watcher)
      } catch {
        console.warn(`无法监听技能目录: ${root}`)
      }
    }
  }

  private clearWatchers(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* ignore */ }
    }
    this.watchers = []
  }

  private scheduleDiff(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.diffAndEmit(false), 400)
  }

  private diffAndEmit(force: boolean): void {
    this.debounceTimer = null
    const before = this.lastSnapshot
    const current = new Map(this.list().map((c) => [c.name, c.promptVersion]))
    this.lastSnapshot = current

    if (!before || force) {
      // 首次 / 强制：只发一次 changed（全量）
      if (current.size > 0) this.emitChange('changed', Array.from(current.keys()))
      return
    }

    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []
    for (const [name, ver] of current) {
      const prev = before.get(name)
      if (!prev) added.push(name)
      else if (prev !== ver) changed.push(name)
    }
    for (const name of before.keys()) {
      if (!current.has(name)) removed.push(name)
    }
    if (added.length) this.emitChange('added', added)
    if (removed.length) this.emitChange('removed', removed)
    if (changed.length) this.emitChange('changed', changed)
  }

  private emitChange(kind: SkillChangeKind, names: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(kind, names)
      } catch (e) {
        console.error('[skill-service] 变更监听器异常:', e)
      }
    }
  }

  dispose(): void {
    this.clearWatchers()
    this.listeners.clear()
    this.providers = []
    this.lastSnapshot = null
  }
}

/** 全局单例 */
export const skillService = new SkillService()
