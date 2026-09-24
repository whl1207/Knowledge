/**
 * useSwarmAgents.ts — 集群成员的技能支持
 *
 * 集群不再有自己的成员增删改与能力编辑：成员 = Agent 预设引用
 * （成员配置在「设置 → 预设」维护，映射见 `useSwarmMembers`）。
 * 这里只保留运行期需要的能力：技能目录扫描与技能提示词拼装。
 */

import { store, skillList, knowledgeBaseList } from '@/store/swarmState'
import type { SwarmAgent } from '@/types/swarm'

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

export const loadSkillList = async () => {
  if (!store.skillsPath) { skillList.value = []; return }
  try {
    const loaded = await window.ipcRenderer.invoke('loadSkills', store.skillsPath)
    skillList.value = (loaded || []).map((s: any) => ({
      name: s.name,
      path: s.path,
      description: s.description || '',
    }))
  } catch { skillList.value = [] }
}

/** 技能模式变更时清空选择 */
export const onSkillModeChange = (agent: SwarmAgent) => {
  if (agent.skillMode !== 'select') agent.selectedSkill = ''
}

/** 获取技能内容的 prompt 片段（all=全部已安装技能；select=所选技能） */
export const getSkillPrompt = async (agent: SwarmAgent): Promise<string> => {
  if (agent.skillMode === 'none' || !store.skillsPath) return ''
  try {
    if (agent.skillMode === 'all') {
      const parts: string[] = []
      for (const sk of skillList.value) {
        const mdPath = sk.path.replace(/\\/g, '/') + '/SKILL.md'
        const content = await window.ipcRenderer.invoke('readFile', mdPath)
        if (content && typeof content === 'string' && !content.startsWith('Error')) {
          parts.push(`## 技能：${sk.name}\n${content}`)
        }
      }
      return parts.length > 0 ? `\n## 已启用的技能\n${parts.join('\n\n')}\n` : ''
    } else if (agent.skillMode === 'select') {
      // 多选技能（selectedSkills 优先；旧数据回退单选的 selectedSkill）
      const paths = (agent.selectedSkills && agent.selectedSkills.length)
        ? agent.selectedSkills
        : (agent.selectedSkill ? [agent.selectedSkill] : [])
      const parts: string[] = []
      for (const p of paths) {
        const mdPath = p.replace(/\\/g, '/') + '/SKILL.md'
        const content = await window.ipcRenderer.invoke('readFile', mdPath)
        if (content && typeof content === 'string' && !content.startsWith('Error')) {
          const sk = skillList.value.find(s => s.path === p)
          const skillName = sk ? sk.name : (p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '')
          parts.push(skillName ? `## 技能：${skillName}\n${content}` : `## 技能\n${content}`)
        }
      }
      if (parts.length > 0) return `\n## 已启用的技能\n${parts.join('\n\n')}\n`
    }
  } catch { /* 忽略 */ }
  return ''
}

/** 获取 agent 已配置的技能名（从技能路径映射） */
export const getAgentSkillName = (agent: SwarmAgent): string => {
  if (agent.skillMode !== 'select' || !agent.selectedSkill) return ''
  const match = skillList.value.find(s => s.path === agent.selectedSkill)
  if (match && match.name) return match.name
  return agent.selectedSkill.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
}

// ---------------------------------------------------------------------------
// 知识库文件列表（全局扫描一次，供配置界面选择；成员实际使用的知识库来自预设）
// ---------------------------------------------------------------------------

export const scanKnowledgeBases = async () => {
  if (!store.root) return
  try {
    const result = await window.ipcRenderer.invoke('getFilesRelation', store.root, 1)
    const fileList: any[] = result?.fileList || []
    knowledgeBaseList.value = fileList
      .filter((f: any) => f.path?.endsWith('.kb'))
      .map((f: any) => ({ label: f.label || f.path.split(/[/\\]/).pop(), path: f.path }))
  } catch { /* 静默忽略 */ }
}
