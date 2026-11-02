/**
 * useAgentSkillTask.ts — 「技能设计师」的渲染层数据源
 *
 * 技能目录（`store.skillsPath`）与已装技能清单只有渲染层拿得到（技能库路径存在 localStorage，
 * 技能列表由主进程 skill-service 经 `skills.list` 返回）。主进程的 builtin-skill-dev 服务
 * 通过 `requestRendererTask(agentId, 'agent_skill', …)` 取这一份数据，用于：
 *   - `skill_dev_host`：告诉模型技能目录的绝对路径、是否默认位置、已装技能；
 *   - `skill_dev_check`：把「技能名」解析成绝对路径，并做重名检查。
 *
 * 写文件不在这里：技能是磁盘目录，模型用 write_file / replace_in_file 直接写入
 * （与「插件设计师」同一套做法），自检由主进程的 skill_dev_check 承担。
 */

import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import { ensureDefaultSkillsPath, isDefaultSkillsFolder } from '@/composables/useDefaultStorage'

export interface SkillTaskResult {
  ok: boolean
  value?: any
  error?: string
}

/** 技能摘要（不含正文，避免把整库内容塞进上下文） */
function summarize(s: any): any {
  return {
    name: String(s?.name || ''),
    description: String(s?.description || '').slice(0, 300),
    shortDescription: String(s?.shortDescription || '').slice(0, 120),
    path: String(s?.path || ''),
    /** 分类目录（相对技能根，`/` 分隔；直接放在根下为空串），便于模型按分类整理技能 */
    folder: String(s?.folder || ''),
    emoji: String(s?.metadata?.emoji || ''),
    version: String(s?.metadata?.version || ''),
    promptVersion: String(s?.promptVersion || ''),
    fileCount: Number(s?.fileCount || s?.files?.length || 0),
  }
}

/**
 * 渲染层任务入口（kind === 'agent_skill'）。
 * 目前只有一个 op：`host`（技能目录 + 已装技能）。保留 op 字段，后续加 `list` / `verify` 不用改协议。
 */
export async function handleAgentSkillTask(payload: any): Promise<SkillTaskResult> {
  const op = String(payload?.op || 'host')
  const store = usestore() as any
  try {
    if (op !== 'host' && op !== 'list') {
      return { ok: false, error: `未知的技能操作：${op}（可用：host）` }
    }

    // 目录：已有自定义路径就沿用；没有就落到默认位置（userData/skills）
    let folder = String(store.skillsPath || '')
    if (!folder) folder = await ensureDefaultSkillsPath()
    const isDefault = folder ? await isDefaultSkillsFolder() : false

    let skills: any[] = []
    let exists = false
    let error = ''
    if (folder) {
      try {
        const result = await getPlatform().fs.listTreeWithRelations(folder, 1)
        exists = true
        void result
      } catch {
        exists = false
      }
      try {
        const list: any[] = (await getPlatform().host.skills.list(folder)) || []
        skills = list.map(summarize)
      } catch (e: any) {
        error = String(e?.message || e)
      }
    }

    return {
      ok: true,
      value: {
        folder,
        isDefault,
        exists,
        count: skills.length,
        skills,
        defaultNote: '默认位置是应用数据目录下的 skills（userData/skills）；用户可在「设置 → 技能 → 管理」里换成别的文件夹。',
        howToUse: '在聊天里输入 `$技能名` 显式触发；或在「设置 → 智能体 → 管理 → 技能」里勾选该技能，让该预设的系统提示带上技能库清单。',
        howToReload: '技能目录内的文件变化会被自动监听（约 400ms 防抖）；没生效就到「设置 → 技能 → 管理」点刷新，确认目录就是上面这个 folder。',
        error,
      },
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
