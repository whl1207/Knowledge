/**
 * fs.ts — 界面半边的 `ctx.fs`（契约层在 `src/shared/fsContract.ts`）
 *
 * 设计（见 docs/plan/插件能力面向DSH风格收敛-设计方案 §四）：
 * - **形状统一**：插件只看到 `ctx.fs`，不再需要区分"这是 `ctx.files` 还是 `ctx.host.granted`"；
 * - **读/写走既有实现**：桌面端经 `plugin:files:*`、安卓/网页端经平台能力层 —— 由
 *   `createPluginFilesApi` 统一处理（它已经把两端都实现了），本模块**不重写 I/O**；
 * - **只补两件宿主新增的能力**：`stat`（取版本）与 `editText`（版本校验 + 字面量替换），
 *   它们走后端新通道 `plugin:fs:stat` / `plugin:fs:edit-text`；后端不支持时**诚实降级**
 *   （`editText` 用"读全文 + 本地替换 + 写回"实现，且不提供版本保护，并在日志里说清）。
 *
 * ⚠️ 与 `ctx.files` 的关系：`ctx.files` 保留（老插件零改动），`ctx.fs` 是它的**超集入口**。
 * 选择框（pick*）与 `openInApp` 仍只在 `ctx.files` 上：它们是"用户交互"，不属于文件系统契约。
 */

import type {
  FsEdit,
  FsEditResult,
  FsEntry,
  FsStat,
  FsTarget,
  FsTextResult,
  FsWriteOptions,
  FsWriteResult,
  PluginFsApi,
} from '@/shared/fsContract'
import { applyLiteralEdits, fsTargetOf } from '@/shared/fsContract'
import { createPluginFilesApi, type PluginFilesApi } from './files'
import { aikmDsh } from '@/lib/aikmIpc'

interface FilesBridge {
  stat?(options: { id: string; path: string }): Promise<FsStat>
  editText?(options: { id: string; path: string; edits: FsEdit[]; expectedVersion?: string }): Promise<FsEditResult>
  writeText(options: {
    id: string
    path: string
    text: string
    expectedVersion?: string
    presence?: FsWriteOptions['presence']
  }): Promise<{ path: string; bytes: number; version?: string | null }>
  remove(options: { id: string; path: string; expectedVersion?: string }): Promise<{ removed: boolean; missing?: boolean }>
}

export interface PluginFsApiDeps {
  pluginId: string
  /** 清单是否声明了 `fs` */
  permitted: boolean
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** 取宿主新增的两条通道（桌面端才有；安卓/网页端为 undefined） */
function filesBridge(): FilesBridge | null {
  try {
    const files = aikmDsh?.plugin?.files as unknown as FilesBridge | undefined
    return files && typeof files.writeText === 'function' ? files : null
  } catch {
    return null
  }
}

export function createPluginFsApi(deps: PluginFsApiDeps): PluginFsApi {
  const legacy: PluginFilesApi = createPluginFilesApi({
    pluginId: deps.pluginId,
    permitted: deps.permitted,
    log: deps.log,
  })

  const bridge = filesBridge()
  const ensure = (): void => {
    if (!deps.permitted) throw new Error(`插件 ${deps.pluginId} 未声明 fs 权限（在 package.json 的 aikm.permissions 里加上 "fs"）`)
  }

  /** 目标 → 绝对路径（界面半边的相对路径基准是插件目录；没有 cwd 时按原样交给后端） */
  const targetOf = (input: string | FsTarget): FsTarget => {
    const t = fsTargetOf(input)
    if (!t.path) throw new Error('缺少路径')
    return t
  }

  return {
    get available() {
      return legacy.available
    },
    get reason() {
      return legacy.reason
    },

    resolve(input, opts) {
      return fsTargetOf(input, opts?.cwd)
    },

    async stat(input): Promise<FsStat> {
      ensure()
      const t = targetOf(input)
      if (bridge?.stat) return await bridge.stat({ id: deps.pluginId, path: t.path })
      // 降级：用列目录探测存在性与大小（拿不到 mtime，因此没有版本）
      const dir = t.path.replace(/\/[^/]*$/, '') || t.path
      const name = t.path.slice(dir.length + 1)
      try {
        const res = await legacy.list(dir)
        const hit = res.entries.find((e) => e.name === name)
        if (!hit) return { path: t.path, exists: false, isDir: false, size: 0, mtimeMs: 0, version: null }
        return { path: t.path, exists: true, isDir: hit.isDir, size: hit.size, mtimeMs: 0, version: null }
      } catch {
        return { path: t.path, exists: false, isDir: false, size: 0, mtimeMs: 0, version: null }
      }
    },

    async readText(input, opts): Promise<FsTextResult> {
      ensure()
      const t = targetOf(input)
      const res = await legacy.readText(t.path, { maxBytes: opts?.maxBytes })
      let version: string | null = null
      if (bridge?.stat) {
        try {
          version = (await bridge.stat({ id: deps.pluginId, path: t.path })).version
        } catch {
          version = null
        }
      }
      return {
        path: res.path,
        text: res.text,
        version,
        size: (res as { size?: number }).size ?? res.text.length,
        truncated: Boolean((res as { truncated?: boolean }).truncated),
        ...(res.pdf ? { pdf: true, pages: res.pages } : {}),
      }
    },

    async readBytes(input, opts) {
      ensure()
      const t = targetOf(input)
      const res = await legacy.readBytes(t.path, { maxBytes: opts?.maxBytes })
      return { path: res.path, bytes: res.bytes, size: res.size, version: null }
    },

    async readBase64(input, opts) {
      ensure()
      const t = targetOf(input)
      return await legacy.readBase64(t.path, { maxBytes: opts?.maxBytes })
    },

    async listDir(input): Promise<{ dir: string; entries: FsEntry[] }> {
      ensure()
      const t = targetOf(input)
      const res = await legacy.list(t.path)
      return { dir: res.dir, entries: res.entries }
    },

    async writeText(input, text, opts): Promise<FsWriteResult> {
      ensure()
      const t = targetOf(input)
      // 有版本/存在性要求时必须走后端通道（legacy 没有这两个参数）
      if (bridge?.writeText && (opts?.expectedVersion || opts?.presence)) {
        const res = await bridge.writeText({
          id: deps.pluginId,
          path: t.path,
          text,
          expectedVersion: opts.expectedVersion,
          presence: opts.presence,
        })
        return { path: res.path, bytes: res.bytes, version: res.version ?? null }
      }
      const res = await legacy.writeText(t.path, text)
      return { path: res.path, bytes: res.bytes, version: null }
    },

    async editText(input, edits, opts): Promise<FsEditResult> {
      ensure()
      const t = targetOf(input)
      if (bridge?.editText) {
        return await bridge.editText({
          id: deps.pluginId,
          path: t.path,
          edits,
          expectedVersion: opts?.expectedVersion,
        })
      }
      // 降级：读全文 → 本地替换 → 写回。**没有版本保护**（后端不支持 stat），明确记一条日志
      deps.log.warn('ctx.fs.editText 在当前平台退化为"读+改写"，没有版本保护（仅桌面端有）')
      const read = await legacy.readText(t.path)
      const plan = applyLiteralEdits(read.text, edits)
      if (!plan.ok) {
        const err = new Error(plan.message) as Error & { code?: string }
        err.code = plan.code
        throw err
      }
      const written = await legacy.writeText(t.path, plan.text)
      return { path: written.path, applied: plan.applied, bytes: written.bytes, version: null }
    },

    async remove(input, opts) {
      ensure()
      const t = targetOf(input)
      if (bridge?.remove && opts?.expectedVersion) {
        return await bridge.remove({ id: deps.pluginId, path: t.path, expectedVersion: opts.expectedVersion })
      }
      return await legacy.remove(t.path)
    },

    sheet: {
      async read(input, opts) {
        ensure()
        const t = targetOf(input)
        return await legacy.readSheet(t.path, { maxRows: opts?.maxRows, maxSheets: opts?.maxSheets })
      },
    },
  }
}
