/**
 * skill-install.ts — 「安装技能」：把一个技能文件夹复制进技能目录
 *
 * 与「插件安装」同一套心智（对齐 PluginManagement 的「安装插件」）：
 *   用户选中一个**本地技能文件夹** → 校验里面有 SKILL.md → 复制到 `技能目录/<文件夹名>`。
 *
 * 为什么在主进程做：技能目录里可能带脚本、图片、模板等二进制资源，
 * 逐个读回渲染层再写回去既慢又容易在编码上出问题；这里用 `fs.cpSync` 一次搞定。
 *
 * 冲突：目标同名且未确认覆盖 → 抛 `SKILL_EXISTS`（带 code，渲染层弹「覆盖安装？」再调一次）。
 * 复制完调用 `skillService.refresh()`，watcher 的 400ms 防抖之外再补一次立即刷新。
 */

import { dialog } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPCError } from '@/types/ipc'
import { skillService } from './skill-service'

export interface SkillInstallOptions {
  /** 技能根目录（渲染层的 store.skillsPath；空 = 未设置） */
  root: string
  /** 覆盖同名技能（渲染层在用户确认后传 true） */
  replace?: boolean
  /** 跳过目录选择框（自测 / 后续支持拖放时用） */
  sourceDir?: string
}

export interface SkillInstallResult {
  cancelled?: boolean
  /** 技能目录名（= 复制进去的文件夹名） */
  name?: string
  /** 安装后的绝对路径 */
  path?: string
  /** 是否覆盖了已有技能 */
  replaced?: boolean
}

/**
 * 安装一个技能文件夹：选目录（或直接用 sourceDir）→ 校验 → 复制到 `<root>/<name>`。
 */
export async function installSkillFolder(opts: SkillInstallOptions): Promise<SkillInstallResult> {
  const root = String(opts?.root || '').trim()
  if (!root) {
    throw new IPCError('INVALID_ARGUMENT', '技能目录未设置：请先在「设置 → 技能 → 管理」选择技能文件夹')
  }

  let source = String(opts?.sourceDir || '').trim()
  if (!source) {
    const picked = await dialog.showOpenDialog({
      title: '选择要安装的技能文件夹（内含 SKILL.md）',
      properties: ['openDirectory'],
      buttonLabel: '安装此技能',
    })
    if (picked.canceled || !picked.filePaths?.length) return { cancelled: true }
    source = picked.filePaths[0]
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch (e: any) {
    throw new IPCError('INVALID_ARGUMENT', `选中的目录不可读：${e?.message || e}`)
  }
  if (!stat.isDirectory()) {
    throw new IPCError('INVALID_ARGUMENT', '请选择一个**技能文件夹**（里面直接含 SKILL.md），不是单个文件')
  }

  const name = path.basename(source)
  const skillMd = path.join(source, 'SKILL.md')
  if (!fs.existsSync(skillMd)) {
    throw new IPCError('INVALID_ARGUMENT', `「${name}」里没有 SKILL.md：技能目录必须直接包含 SKILL.md（大小写一致）`)
  }

  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, name)
  const exists = fs.existsSync(target)
  if (exists && !opts?.replace) {
    throw new IPCError('SKILL_EXISTS', `技能「${name}」已存在`)
  }
  if (exists) {
    fs.rmSync(target, { recursive: true, force: true })
  }
  try {
    fs.cpSync(source, target, { recursive: true })
  } catch (e: any) {
    throw new IPCError('INTERNAL', `复制技能失败：${e?.message || e}`)
  }
  // 立即刷新（watcher 会有防抖；这里让界面马上看到）
  try { skillService.refresh() } catch { /* 刷新失败不影响安装结果 */ }
  return { name, path: target, replaced: exists }
}

/** 供 IPC 与自测调用：把 sourceDir 安装到 root（不弹框） */
export const installSkillFromDir = (root: string, sourceDir: string, replace = false): Promise<SkillInstallResult> =>
  installSkillFolder({ root, sourceDir, replace })
