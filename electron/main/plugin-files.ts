/**
 * plugin-files.ts — 插件文件能力 IPC（`plugin:files:*` / `plugin:fs:*`）
 *
 * **实现只有一份**：全部落在 `electron/main/plugin-fs.ts`（`createPluginFs`）。本文件只负责
 * "从 IPC 载荷里取出插件 id 与授权状态 → 调实现 → 把结果/错误翻译成 IPC"。
 * 收敛前的三套入口（界面 `ctx.files.*`、主进程 `ctx.host.readFile/*`、`ctx.host.granted.*`）
 * 共用这一份实现，见 `docs/plan/插件能力面向DSH风格收敛-设计方案（逐文件）.md` §四。
 *
 * 安全模型（未改变）：
 * 1. **权限**：只有清单声明了 `fs` 权限、且插件当前处于激活态才能调用；
 * 2. **授权范围**：只允许"用户在该插件里亲自选过"的文件/文件夹（及子项），外加插件自己的目录。
 *    清单落盘（`plugin-grants.ts`），重启有效，可在「设置 → 插件 → 数据」逐条撤销。
 *
 * 旧通道（`plugin:files:*`）保留原样的载荷与返回形状（只多出可选字段），
 * 新通道（`plugin:fs:stat` / `plugin:fs:edit-text`）承载版本与字面量编辑。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPCError } from '@/types/ipc'
import { pluginHost } from './plugin-host'
import { requirePluginApproval } from './plugin-approval'
import { addGrant, clearGrants, listGrants, revokeGrant } from './plugin-grants'
import { asFsError, createPluginFs } from './plugin-fs'
import { fsPolicySnapshot, isFsPolicyEnabled, setFsPolicyEnabled } from './plugin-fs-policy'
import type { FsEdit, PluginFsApi } from '@/shared/fsContract'

/** 插件临时文件（`userData/plugins-data/<id>/tmp/`）：单文件上限与保留个数 */
const TEMP_MAX_BYTES = 32 * 1024 * 1024
const TEMP_KEEP = 200

/** 插件是否声明了 fs 权限（未声明一律拒绝） */
function requireFsPermission(pluginId: string): void {
  const snapshot = pluginHost.list().find((p) => p.id === pluginId)
  if (!snapshot) throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
  // 停用期间不接受任何调用；但「记住的路径」不清（授权是用户点过的，撤销走「插件 → 数据」）
  if (!snapshot.enabled) throw new IPCError('PERMISSION_DENIED', `插件未启用：${pluginId}`)
  if (!snapshot.permissions.includes('fs')) {
    throw new IPCError('PERMISSION_DENIED', `插件 ${pluginId} 未声明 fs 权限（package.json 的 aikm.permissions）`)
  }
}

function readPluginId(payload: unknown): string {
  const id = String((payload as { id?: unknown })?.id ?? '').trim()
  if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少插件 id')
  return id
}

/** 按文件头判断是不是受支持的图片（与 read_image 的 sniff 同一套魔数） */
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true // PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true // JPEG
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true // GIF8
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true // RIFF….WEBP
  return false
}

/** 按载荷构造该插件的文件能力（判权 + 目录由宿主快照决定，插件无法伪造） */
function fsFor(payload: { id?: string }): PluginFsApi {
  const pluginId = readPluginId(payload)
  const snapshot = pluginHost.list().find((p) => p.id === pluginId)
  if (!snapshot) throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
  if (!snapshot.enabled) throw new IPCError('PERMISSION_DENIED', `插件未启用：${pluginId}`)
  return createPluginFs({
    pluginId,
    pluginDir: snapshot.dir,
    dataDir: path.join(app.getPath('userData'), 'plugins-data', pluginId),
    hasPermission: snapshot.permissions.includes('fs'),
  })
}

function asIpcError(error: unknown): IPCError {
  return asFsError(error, 'FS_FAILED')
}

/** 统一的处理包壳：把实现抛出的异常翻译成带 code 的 IPCError */
function handle<T>(fn: (payload: any) => Promise<T> | T) {
  return async (_event: unknown, payload: any = {}) => {
    try {
      return await fn(payload)
    } catch (error) {
      throw asIpcError(error)
    }
  }
}

export function registerPluginFilesIpc(): void {
  /** 选文件（返回绝对路径；同时把该文件加入该插件的授权范围） */
  ipcMain.handle(
    'plugin:files:pick',
    handle(async (payload: { id?: string; accept?: string; multiple?: boolean }) => {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const accept = String(payload?.accept ?? 'any')
      const filters =
        accept === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : accept === 'text'
            ? [{ name: 'Text', extensions: ['txt', 'md', 'json', 'csv'] }]
            : [{ name: 'All Files', extensions: ['*'] }]
      const parent = dialogParent()
      const options: Electron.OpenDialogOptions = {
        properties: payload?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters,
      }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) {
        return { cancelled: true, files: [] as Array<{ path: string; name: string; size: number }> }
      }
      const files: Array<{ path: string; name: string; size: number }> = []
      for (const filePath of result.filePaths) {
        addGrant(pluginId, filePath)
        const name = filePath.split(/[\\/]/).pop() || filePath
        const stat = await fs.stat(filePath).catch(() => null)
        files.push({ path: filePath, name, size: stat ? stat.size : 0 })
      }
      return { cancelled: false, files }
    }),
  )

  /** 选文件夹（返回绝对路径；该文件夹及其子项进入授权范围） */
  ipcMain.handle(
    'plugin:files:pick-dir',
    handle(async (payload: { id?: string }) => {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const parent = dialogParent()
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return { cancelled: true, dir: null }
      const dir = result.filePaths[0]
      addGrant(pluginId, dir)
      return { cancelled: false, dir: { path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir } }
    }),
  )

  /**
   * 选一个**可写**文件夹（授权模式 write：可在其中创建 / 覆盖 / 编辑 / 删除文件）。
   *
   * 与只读的 `pick-dir` 分开是刻意的：
   * - 用户点的时候就知道自己在给"写"的权限（标题与按钮都写明）；
   * - 插件**没有**别的办法把自己变成可写 —— 这是唯一入口；
   * - 同一个目录先以只读选过、再以可写选一次 → 升级为 write（`addGrant` 只升不降）。
   */
  ipcMain.handle(
    'plugin:files:pick-writable',
    handle(async (payload: { id?: string; title?: string }) => {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      const parent = dialogParent()
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        title: String(payload?.title ?? '').trim() || '选择一个允许该插件写入的文件夹',
        buttonLabel: '允许写入此文件夹',
      }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return { cancelled: true, dir: null }
      const dir = result.filePaths[0]
      addGrant(pluginId, dir, 'write')
      return { cancelled: false, dir: { path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir, mode: 'write' as const } }
    }),
  )

  /**
   * 写文本（覆盖式）。父目录自动创建。
   * **只认可写授权**（只读授权 → `FS_READ_ONLY_GRANT`；插件目录内除外）。
   * 可选 `expectedVersion` / `presence`：给了就做乐观并发与存在性检查（省略 = 无条件，老行为不变）。
   */
  ipcMain.handle(
    'plugin:files:write-text',
    handle(async (payload: { id?: string; path?: string; text?: string; expectedVersion?: string; presence?: string }) => {
      const api = fsFor(payload)
      const res = await api.writeText(String(payload?.path ?? '').trim(), String(payload?.text ?? ''), {
        expectedVersion: typeof payload?.expectedVersion === 'string' ? payload.expectedVersion : undefined,
        presence: (payload?.presence === 'mustExist' || payload?.presence === 'mustNotExist' ? payload.presence : 'any') as
          | 'any'
          | 'mustExist'
          | 'mustNotExist',
      })
      return { path: res.path, bytes: res.bytes, version: res.version }
    }),
  )

  /**
   * 删除文件 / 空目录（**只认可写授权**）。
   *
   * 刻意**不做递归删除**：`remove` 的作用是"删掉我刚写的那个文件"，
   * 而递归删除一个用户授权目录会把整棵子树带走 —— 那种破坏性操作不该由插件的一句话完成。
   */
  ipcMain.handle(
    'plugin:files:remove',
    handle(async (payload: { id?: string; path?: string; expectedVersion?: string }) => {
      const api = fsFor(payload)
      return await api.remove(String(payload?.path ?? '').trim(), {
        expectedVersion: typeof payload?.expectedVersion === 'string' ? payload.expectedVersion : undefined,
      })
    }),
  )

  /** 列目录（只列一层；需在授权范围内） */
  ipcMain.handle(
    'plugin:files:list',
    handle(async (payload: { id?: string; path?: string }) => {
      const api = fsFor(payload)
      return await api.listDir(String(payload?.path ?? '').trim())
    }),
  )

  /** 读文本（PDF 自动走文本提取；返回里带 `version`，供后续带版本写入） */
  ipcMain.handle(
    'plugin:files:read-text',
    handle(async (payload: { id?: string; path?: string; maxBytes?: number }) => {
      const api = fsFor(payload)
      const res = await api.readText(String(payload?.path ?? '').trim(), { maxBytes: payload?.maxBytes })
      return { ...res, pages: res.pages ?? 0, pdf: res.pdf === true }
    }),
  )

  /** 读二进制（base64，给渲染层的 pdfjs 渲染页面用） */
  ipcMain.handle(
    'plugin:files:read-base64',
    handle(async (payload: { id?: string; path?: string; maxBytes?: number }) => {
      const api = fsFor(payload)
      return await api.readBase64(String(payload?.path ?? '').trim(), { maxBytes: payload?.maxBytes })
    }),
  )

  /**
   * 读表格（.xlsx / .xls / .csv → 每个工作表的表头 + 数据行）。
   *
   * 为什么需要它：插件界面半边是单文件 ESM、不能 import SheetJS，`readText` 对 xlsx 只会返回
   * 二进制乱码；于是「读 Excel 画图」这类插件只能靠臆造 API 而必然失败。
   */
  ipcMain.handle(
    'plugin:files:read-sheet',
    handle(async (payload: { id?: string; path?: string; maxRows?: number; maxSheets?: number }) => {
      const api = fsFor(payload)
      return await api.sheet.read(String(payload?.path ?? '').trim(), {
        maxRows: payload?.maxRows,
        maxSheets: payload?.maxSheets,
      })
    }),
  )

  // -------------------------------------------------------------------------
  // 插件临时文件（`ctx.files.saveTempFile`）
  //
  // 为什么需要：插件常把「界面里渲染出来的图片」交给智能体的 read_image 读（扫描件识别、
  // 报表截图…）。界面半边手里只有 dataURL，而 read_image 要的是**绝对路径**。
  //
  // 不能写到插件目录（`ctx.host.writeFile` / `ctx.fs` 的相对路径都落在那里）：
  // 宿主用 fs.watch 监视插件目录做热重载，写一个文件就会触发「插件已重载」，
  // 界面状态被重置、在飞的委派被取消——表现就是「点一下按钮面板跳走 / 恢复初始状态」。
  // 所以临时文件统一落到 `userData/plugins-data/<id>/tmp/`（不在监视范围内），
  // 由主进程按 mtime 只保留最近 TEMP_KEEP 个，插件不用自己清理。
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'plugin:files:save-temp',
    handle(async (payload: { id?: string; name?: string; mime?: string; base64?: string; dataUrl?: string }) => {
      const pluginId = readPluginId(payload)
      requireFsPermission(pluginId)
      let base64 = String(payload?.base64 ?? '').trim()
      if (!base64) {
        const m = /^data:[^;]*;base64,(.*)$/s.exec(String(payload?.dataUrl ?? ''))
        if (m) base64 = m[1]
      }
      if (!base64) throw new IPCError('INVALID_ARGUMENT', '缺少图片数据（base64 / dataUrl）')
      let bytes: Buffer
      try {
        bytes = Buffer.from(base64, 'base64')
      } catch {
        throw new IPCError('INVALID_ARGUMENT', '图片数据不是合法的 base64')
      }
      if (!bytes.length) throw new IPCError('INVALID_ARGUMENT', '图片数据为空')
      if (bytes.length > TEMP_MAX_BYTES) {
        throw new IPCError('INVALID_ARGUMENT', `临时文件过大（${bytes.length} 字节 > ${TEMP_MAX_BYTES}）`)
      }
      const safe = String(payload?.name || 'file')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80) || 'file'
      // 声称是图片就校验文件头：把二进制当 UTF-8 字符串写的旧写法会产出 EF BF BD 开头的"PNG"，
      // 那时 read_image 才报错，排查起来绕一大圈。这里直接拒绝，并说清原因。
      const claimsImage = /^image\//i.test(String(payload?.mime || '')) || /\.(png|jpe?g|webp|gif)$/i.test(safe)
      if (claimsImage && !looksLikeImage(bytes)) {
        throw new IPCError(
          'INVALID_ARGUMENT',
          '图片数据不是有效的 PNG / JPEG / WebP / GIF（文件头不匹配）：请按字节传 base64，不要把它当字符串写',
        )
      }
      const dir = path.join(app.getPath('userData'), 'plugins-data', pluginId, 'tmp')
      await fs.mkdir(dir, { recursive: true })
      const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
      const abs = path.join(dir, file)
      await fs.writeFile(abs, bytes)
      // 清理：按 mtime 只留最近 TEMP_KEEP 个（失败不影响本次保存）
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const rows: Array<{ name: string; mtime: number }> = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null)
          if (stat) rows.push({ name: entry.name, mtime: stat.mtimeMs })
        }
        rows.sort((a, b) => b.mtime - a.mtime)
        for (const row of rows.slice(TEMP_KEEP)) {
          await fs.unlink(path.join(dir, row.name)).catch(() => { /* 已被别的进程删掉 */ })
        }
      } catch { /* 清理失败不影响本次保存 */ }
      return { path: abs, name: safe, bytes: bytes.length }
    }),
  )

  // -------------------------------------------------------------------------
  // 新通道：版本与字面量编辑（`ctx.fs` 的 stat / editText）
  // -------------------------------------------------------------------------

  /** 取状态与版本（不存在也返回 `{exists:false}`，不抛错） */
  ipcMain.handle(
    'plugin:fs:stat',
    handle(async (payload: { id?: string; path?: string }) => {
      const api = fsFor(payload)
      return await api.stat(String(payload?.path ?? '').trim())
    }),
  )

  /**
   * 字面量编辑（读 → 校验版本 → 替换 → 原子写回）。
   * 命中 0 处或多处 → `FS_AMBIGUOUS_EDIT`；版本不符 → `FS_STALE_VERSION`。
   */
  ipcMain.handle(
    'plugin:fs:edit-text',
    handle(async (payload: { id?: string; path?: string; edits?: FsEdit[]; expectedVersion?: string }) => {
      const api = fsFor(payload)
      return await api.editText(
        String(payload?.path ?? '').trim(),
        Array.isArray(payload?.edits) ? (payload.edits as FsEdit[]) : [],
        { expectedVersion: typeof payload?.expectedVersion === 'string' ? payload.expectedVersion : undefined },
      )
    }),
  )

  /**
   * 「先读后写」策略的读 / 写（设置页入口；默认关）。
   * 读：只读快照（是否开启 + 本会话已观察的文件数）；写：需用户确认（与授权撤销同口径）。
   */
  ipcMain.handle('plugin:fs:policy-get', (_event, payload: { id?: string } = {}) => {
    const pluginId = readPluginId(payload)
    if (!pluginHost.list().some((p) => p.id === pluginId)) {
      throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
    }
    const snap = fsPolicySnapshot()
    return { id: pluginId, enabled: isFsPolicyEnabled(pluginId), observed: snap.observed[pluginId] ?? 0 }
  })

  ipcMain.handle(
    'plugin:fs:policy-set',
    handle(async (payload: { id?: string; enabled?: boolean; confirm?: boolean }) => {
      const pluginId = readPluginId(payload)
      const enabled = payload?.enabled === true
      requirePluginApproval(payload, `${enabled ? '开启' : '关闭'}插件 ${pluginId} 的「先读后写」策略`)
      return { id: pluginId, enabled: setFsPolicyEnabled(pluginId, enabled) }
    }),
  )

  /**
   * 列出某个插件记住的文件授权（设置 → 插件 → 数据 里显示）。
   * 只读，不需要 fs 权限（停用的插件也要能看到并撤销它记住的路径）。
   */
  ipcMain.handle('plugin:files:grants', (_event, payload: { id?: string } = {}) => {
    const pluginId = readPluginId(payload)
    if (!pluginHost.list().some((p) => p.id === pluginId)) {
      throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${pluginId}`)
    }
    return { id: pluginId, entries: listGrants(pluginId) }
  })

  /** 撤销一条授权（撤销是「收回权限」，但仍要求用户确认，避免插件偷偷改别人的授权） */
  ipcMain.handle('plugin:files:revoke-grant', (_event, payload: { id?: string; path?: string; confirm?: boolean } = {}) => {
    const pluginId = readPluginId(payload)
    const target = String(payload?.path ?? '').trim()
    if (!target) throw new IPCError('INVALID_ARGUMENT', '缺少路径')
    requirePluginApproval(payload, `撤销插件 ${pluginId} 的文件授权`)
    return { removed: revokeGrant(pluginId, target) }
  })

  /** 清掉某个插件的全部授权（用户确认后） */
  ipcMain.handle('plugin:files:clear-grants', (_event, payload: { id?: string; confirm?: boolean } = {}) => {
    const pluginId = readPluginId(payload)
    requirePluginApproval(payload, `清除插件 ${pluginId} 的全部文件授权`)
    return { removed: clearGrants(pluginId) }
  })
}

/** 取当前聚焦窗口作为对话框父窗口（无则用默认） */
function dialogParent(): BrowserWindow | undefined {
  try {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  } catch {
    return undefined
  }
}
