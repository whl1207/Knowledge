<!-- SkillManagement.vue - 技能管理模块 -->
<template>
  <div class="agent-skill" :class="{ tall: isTallLayout }">
    <!-- ====== 管理内容 ====== -->
    <div class="manage-content">
      <div class="manage-split">
        <!-- 左侧：技能列表 -->
        <div class="manage-left" v-show="!isTallLayout || tallScreen === 'list'">
          <!-- 左侧导航工具栏（参照「插件 → 管理」）：安装 / 刷新 / 打开目录 / 选择目录 / 恢复默认 -->
          <div class="sk-nav-toolbar">
            <button class="sk-nav-btn primary" @click="installSkill"
              :title="store.locales === 'en' ? 'Install a skill folder (copies it into the skills folder)' : '安装技能：选择一个技能文件夹复制进技能目录'">
              <i class="fa fa-plus"></i><span class="sk-nav-btn-label">{{ store.locales === 'en' ? 'Install' : '安装' }}</span>
            </button>
            <button class="sk-nav-btn" @click="refreshSkillList" :disabled="loading"
              :title="store.locales === 'en' ? 'Refresh skills' : '刷新技能'">
              <i class="fa" :class="loading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
            </button>
            <button class="sk-nav-btn" :disabled="!store.skillsPath" @click="revealSkillsRoot"
              :title="store.locales === 'en' ? 'Open the skills folder in Explorer' : '在资源管理器中打开技能目录'">
              <i class="fa fa-external-link"></i>
            </button>
            <button class="sk-nav-btn" @click="openSkillsFolder"
              :title="store.locales === 'en' ? 'Select skills folder' : '选择技能文件夹'">
              <i class="fa fa-folder-open"></i>
            </button>
            <button class="sk-nav-btn" :disabled="isDefaultFolder" @click="resetSkillsFolder"
              :title="store.locales === 'en' ? 'Back to the default skills folder' : '恢复默认技能文件夹'">
              <i class="fa fa-undo"></i>
            </button>
          </div>
          <div class="sk-nav-search">
            <i class="fa fa-search"></i>
            <input v-model="skillKeyword" spellcheck="false"
              :placeholder="store.locales === 'en' ? 'Search skills (name / description)' : '搜索技能（名称 / 描述）'" />
            <i v-if="skillKeyword" class="fa fa-times-circle sk-search-clear" @click="skillKeyword = ''"
              :title="store.locales === 'en' ? 'Clear' : '清除'"></i>
          </div>
          <div class="skill-list">
            <div v-if="loading" class="empty-hint" style="height:100%;">
              <i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>
              <span>{{ store.locales === 'en' ? 'Loading...' : '加载中...' }}</span>
            </div>
            <div v-else-if="skills.length === 0" class="empty-hint" style="height:100%;">
              <i class="fa fa-cubes" style="font-size:24px;"></i>
              <span>{{ store.skillsPath ? (store.locales === 'en' ? 'No skill files found' : '未找到技能文件') : (store.locales === 'en' ? 'Please set skills folder first' : '请先设置技能文件夹') }}</span>
            </div>
            <div v-else-if="!filteredSkills.length" class="empty-hint" style="height:auto;padding:12px 4px;">
              <span>{{ store.locales === 'en' ? `No skills match “${skillKeyword.trim()}”` : `没有匹配「${skillKeyword.trim()}」的技能` }}</span>
            </div>
            <div
              v-for="skill in filteredSkills"
              :key="skill.name"
              class="skill-item"
              :class="{ active: selectedSkill?.name === skill.name }"
              @click="selectSkill(skill)"
              :title="skill.description"
            >
              <i class="fa" :class="skill.metadata?.emoji ? 'fa-smile-o' : 'fa-cube'"></i>
              <div class="skill-info">
                <span class="skill-name">
                  <span v-if="skill.metadata?.emoji" class="skill-emoji">{{ skill.metadata.emoji }}</span>
                  {{ skill.name }}
                </span>
                <span class="skill-desc">{{ skill.description }}</span>
              </div>
              <span class="skill-badge" :title="skill.metadata?.version ? (store.locales === 'en' ? `Version: ${skill.metadata.version}` : `版本: ${skill.metadata.version}`) : ''">
                <span v-if="skill.metadata?.version">v{{ skill.metadata.version }} |</span>
                {{ (skill.fileCount ?? skill.preview?.files?.length ?? skill.files?.length ?? 0) + 1 }} {{ store.locales === 'en' ? 'files' : '文件' }}
              </span>
              <!-- 启用开关：关闭的技能不注入智能体 / 不被 skill 工具加载 -->
              <span
                class="skill-enable-toggle"
                :class="{ on: isSkillEnabled(skill.name) }"
                :title="isSkillEnabled(skill.name) ? (store.locales === 'en' ? 'Enabled: injected into agent' : '已启用：注入智能体') : (store.locales === 'en' ? 'Disabled: not injected' : '已禁用：不注入智能体')"
                @click.stop="toggleSkillEnabled(skill.name)"
              >
                <span class="skill-enable-knob"></span>
              </span>
            </div>
          </div>

          <!-- 底栏（参照「插件 → 管理」）：数量 + 技能目录（点击选择目录） -->
          <div class="sk-nav-foot">
            <div class="sk-foot-row">
              <span class="sk-foot-count">
                {{ skillKeyword ? `${filteredSkills.length} / ${skills.length}` : skills.length }}
                {{ store.locales === 'en' ? 'skills' : '个技能' }}
              </span>
              <span class="sk-foot-icons">
                <i v-if="isDefaultFolder" class="fa fa-home sk-foot-icon" :title="store.locales === 'en' ? 'Default skills folder' : '默认技能目录'"></i>
                <i v-else-if="store.skillsPath" class="fa fa-undo sk-foot-icon action"
                  :title="store.locales === 'en' ? 'Restore the default skills folder' : '恢复默认技能目录'" @click="resetSkillsFolder"></i>
              </span>
            </div>
            <div class="sk-foot-path" @click="openSkillsFolder" :title="store.skillsPath || ''">
              <i class="fa fa-folder"></i>
              <span class="sk-foot-path-text">{{ store.skillsPath || (store.locales === 'en' ? 'No folder set' : '未设置技能文件夹') }}</span>
            </div>
          </div>
        </div>

        <!-- 中间：文件树 -->
        <div class="manage-middle" v-show="!isTallLayout || tallScreen === 'tree'">
          <div v-if="!selectedSkill" class="empty-hint">
            <i class="fa fa-hand-pointer-o" style="font-size:28px;"></i>
            <span>{{ store.locales === 'en' ? 'Select a skill from the left' : '请从左侧选择一个技能' }}</span>
          </div>
          <div v-else class="file-tree-container">
            <div class="file-tree-header">
              <!-- 细长窗口：文件树整屏时左上角返回（回到整屏技能列表） -->
              <div v-if="isTallLayout" class="sk-back" @click="backToSkillList"
                :title="store.locales === 'en' ? 'Back to skill list' : '返回技能列表'">
                <i class="fa fa-arrow-left"></i>
              </div>
              <span><i class="fa fa-folder-open-o"></i> {{ selectedSkill.name }}</span>
              <span class="file-count">{{ skillFiles.length }} {{ store.locales === 'en' ? 'files' : '个文件' }}</span>
              <i class="fa fa-external-link sk-open-dir" @click="openSkillInExplorer"
                :title="store.locales === 'en' ? 'Open this skill folder in Explorer' : '在资源管理器中打开该技能文件夹'"></i>
            </div>
            <div class="file-tree-body">
              <template v-for="node in fileTree" :key="node.path">
                <!-- 文件夹 -->
                <div v-if="node.type === 'folder'" class="tree-folder">
                  <div class="folder-row" @click="toggleFolder(node)" @dblclick="toggleFolder(node)">
                    <i class="fa" :class="expandedFolders.has(node.path) ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
                    <i class="fa fa-folder" :class="{ 'fa-folder-open': expandedFolders.has(node.path) }"></i>
                    <span class="folder-name">{{ node.name }}</span>
                  </div>
                  <div v-if="expandedFolders.has(node.path)" class="folder-children">
                    <template v-for="child in node.children" :key="child.path">
                      <!-- 子文件夹 -->
                      <div v-if="child.type === 'folder'" class="tree-folder">
                        <div class="folder-row" @click="toggleFolder(child)" @dblclick="toggleFolder(child)">
                          <i class="fa" :class="expandedFolders.has(child.path) ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
                          <i class="fa fa-folder" :class="{ 'fa-folder-open': expandedFolders.has(child.path) }"></i>
                          <span class="folder-name">{{ child.name }}</span>
                        </div>
                        <div v-if="expandedFolders.has(child.path)" class="folder-children">
                          <div
                            v-for="gc in (child.children || [])"
                            :key="gc.path"
                            class="file-item"
                            :class="{ active: previewFile?.path === gc.path }"
                            @click="gc.type === 'file' && previewSkillFile(gc)"
                          >
                            <i :class="getFileIconClass(gc.name)"></i>
                            <span class="file-name">{{ gc.name }}</span>
                            <span class="file-size">{{ formatFileSize(gc.size) }}</span>
                          </div>
                        </div>
                      </div>
                      <!-- 子文件 -->
                      <div
                        v-else
                        class="file-item"
                        :class="{ active: previewFile?.path === child.path }"
                        @click="previewSkillFile(child)"
                      >
                        <i :class="getFileIconClass(child.name)"></i>
                        <span class="file-name">{{ child.name }}</span>
                        <span class="file-size">{{ formatFileSize(child.size) }}</span>
                      </div>
                    </template>
                  </div>
                </div>
                <!-- 根目录文件 -->
                <div
                  v-else
                  class="file-item"
                  :class="{ active: previewFile?.path === node.path }"
                  @click="previewSkillFile(node)"
                >
                  <i :class="getFileIconClass(node.name)"></i>
                  <span class="file-name">{{ node.name }}</span>
                  <span class="file-size">{{ formatFileSize(node.size) }}</span>
                </div>
              </template>
              <div v-if="fileTree.length === 0" class="empty-hint" style="height:100%;">
                <i class="fa fa-file-o" style="font-size:20px;"></i>
                <span>{{ store.locales === 'en' ? 'This skill folder is empty' : '该技能文件夹为空' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：编辑器（选中文件时显示） -->
        <div class="manage-right" v-if="previewFile" v-show="!isTallLayout || tallScreen === 'editor'">
          <div class="file-preview-header">
            <!-- 细长窗口：编辑器整屏时左上角返回（回到整屏文件树） -->
            <div v-if="isTallLayout" class="sk-back" @click="backToFileTree"
              :title="store.locales === 'en' ? 'Back to file tree' : '返回文件树'">
              <i class="fa fa-arrow-left"></i>
            </div>
            <span><i :class="getFileIconClass(previewFile.name)"></i> {{ previewFile.name }}</span>
            <div style="display:flex;gap:8px;">
              <div @click="reloadPreviewContent" :disabled="saving" :title="store.locales === 'en' ? 'Reload' : '重载'">
                <i class="fa fa-refresh"></i>
              </div>
              <div :class="{ saving: saving }" @click="savePreviewContent" :disabled="saving || !previewHasChanges" :title="store.locales === 'en' ? 'Save' : '保存'">
                <i class="fa" :class="saving ? 'fa-spinner fa-spin' : 'fa-save'"></i>
                {{ saving ? (store.locales === 'en' ? 'Saving...' : '保存中...') : '' }}
              </div>
            </div>
          </div>
          <div class="file-preview-content" ref="previewContainer"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { aikmDsh } from '@/lib/aikmIpc'
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { usestore } from '@/store'
import * as monaco from 'monaco-editor'
import { ensureMonacoEnvironment } from '@/lib/monaco-env'
import { getPlatform, hasCapability } from '@/platform'
import { ensureDefaultSkillsPath, resetSkillsPathToDefault, isDefaultSkillsFolder } from '@/composables/useDefaultStorage'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useTallLayout } from '@/composables/useTallLayout'

const store = usestore()

// 细长窗口（高宽比 > 16:9，如手机竖屏）：技能列表 / 文件树 / 编辑器三栏并排会把编辑区挤到
// 不可用，改为**逐级整屏下钻**（与设置导航 / MCP 设置 / 预设编辑同一套做法）：
// 技能列表 → 文件树 → 文件编辑，靠各屏左上角 ← 逐级返回；宽窗口下三栏并排，本状态无意义。
const isTallLayout = useTallLayout()
type TallScreen = 'list' | 'tree' | 'editor'
const tallScreen = ref<TallScreen>('list')

// Monaco worker 环境按需初始化（避免首屏加载 Monaco）
ensureMonacoEnvironment()

// ==================== 类型 ====================
interface LogEntry {
  time: string
  level: 'info' | 'warning' | 'error'
  message: string
}

interface SkillFile {
  name: string
  path: string
  size: number
}

interface SkillItem {
  name: string
  description: string
  path: string
  metadata: any
  /** 技能目录真实文件总数（files 为受限采样；超大型技能如 1w+ 模板文件） */
  fileCount?: number
  preview: {
    content: string
    files: SkillFile[]
  }
  files?: SkillFile[]
}

interface TreeNode {
  name: string
  path: string
  type: 'folder' | 'file'
  size: number
  children?: TreeNode[]
}

// ==================== 状态 ====================
const loading = ref(false)
/** 技能目录变更监听的取消函数（window.dsh.skills.onChange 返回值） */
let skillChangeUnsubscribe: (() => void) | null = null
const saving = ref(false)

// 技能数据
const skills = ref<SkillItem[]>([])
const selectedSkill = ref<SkillItem | null>(null)
/** 左侧导航搜索词（名称 / 描述） */
const skillKeyword = ref('')
/** 过滤后的技能列表（搜索时保持原顺序） */
const filteredSkills = computed(() => {
  const kw = skillKeyword.value.trim().toLowerCase()
  if (!kw) return skills.value
  return skills.value.filter((s) =>
    String(s.name || '').toLowerCase().includes(kw) ||
    String(s.description || '').toLowerCase().includes(kw),
  )
})
const previewFile = ref<SkillFile | null>(null)
const previewContent = ref('')
const previewOriginalContent = ref('')
const previewHasChanges = computed(() => previewContent.value !== previewOriginalContent.value)

const logs = ref<LogEntry[]>([])

// DOM 引用
const previewContainer = ref<HTMLElement | null>(null)

// Monaco 编辑器实例
let previewEditor: monaco.editor.IStandaloneCodeEditor | null = null

// ==================== 计算属性 ====================

// 当前选中技能的文件列表（包含 SKILL.md）
const skillFiles = computed(() => {
  if (!selectedSkill.value) return []
  const files: SkillFile[] = []
  const existingFiles = (selectedSkill.value as any).files || selectedSkill.value.preview?.files || []

  // 添加 SKILL.md（IPC 中会被过滤掉，但管理面板需要显示）
  const hasSkillMd = existingFiles.some((f: SkillFile) => f.name === 'SKILL.md')
  if (!hasSkillMd && selectedSkill.value.path) {
    files.push({
      name: 'SKILL.md',
      path: selectedSkill.value.path.replace(/\\/g, '/') + '/SKILL.md',
      size: (selectedSkill.value.preview?.content || '').length
    })
  }

  // 添加其他文件
  files.push(...existingFiles)
  return files
})

// 文件夹展开状态
const expandedFolders = ref<Set<string>>(new Set())

// 切换文件夹展开/折叠，同时清除底部预览
const toggleFolder = (node: TreeNode) => {
  const set = new Set(expandedFolders.value)
  if (set.has(node.path)) {
    set.delete(node.path)
  } else {
    set.add(node.path)
    // 展开文件夹时清除预览，让下方只显示文件列表
    previewFile.value = null
    previewContent.value = ''
  }
  // 关键：把新 Set 写回 ref 才会触发响应式更新（否则箭头点击无反应）
  expandedFolders.value = set
}

// 从扁平文件列表构建树状结构
const buildFileTree = (files: SkillFile[], basePath: string): TreeNode[] => {
  const tree: TreeNode[] = []
  const map = new Map<string, TreeNode>()
  const normalizedBase = basePath.replace(/\\/g, '/').replace(/\/+$/, '') + '/'

  for (const file of files) {
    // 转为相对路径
    const fullPath = file.path.replace(/\\/g, '/')
    const relPath = fullPath.startsWith(normalizedBase)
      ? fullPath.substring(normalizedBase.length)
      : fullPath
    const parts = relPath.split('/')
    const fileName = parts.pop()!

    // 处理文件夹路径
    let currentLevel = tree
    let currentRelPath = ''

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentRelPath += (i > 0 ? '/' : '') + part

      let folder = map.get(currentRelPath)
      if (!folder) {
        folder = {
          name: part,
          path: currentRelPath,
          type: 'folder',
          size: 0,
          children: []
        }
        map.set(currentRelPath, folder)
        currentLevel.push(folder)
      }
      currentLevel = folder.children!
    }

    // 添加文件节点
    currentLevel.push({
      name: fileName,
      path: file.path,
      type: 'file',
      size: file.size
    })
  }

  // 排序：文件夹在上，文件在下，各自按名称排序
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children) sortTree(node.children)
    }
  }
  sortTree(tree)

  return tree
}

// 当前选中技能的树状文件结构
const fileTree = computed(() => buildFileTree(skillFiles.value, selectedSkill.value?.path || ''))

// ==================== 文件操作 ====================

// 打开技能文件夹选择对话框
const openSkillsFolder = async () => {
  const path = await getPlatform().dialog.pickDirectory()
  if (path) {
    store.skillsPath = path
    store.saveConfig()
    await refreshDefaultFolderFlag()
    await loadSkillList()
  }
}

/** 当前技能目录是否就是默认位置（决定「默认位置」徽标与「恢复默认」按钮是否可用） */
const isDefaultFolder = ref(false)
const refreshDefaultFolderFlag = async () => {
  isDefaultFolder.value = await isDefaultSkillsFolder()
}

/** 恢复默认技能文件夹（userData/skills）：只改路径，不删除原目录里的文件 */
const resetSkillsFolder = async () => {
  const dir = await resetSkillsPathToDefault()
  if (!dir) {
    ElMessage.warning(store.locales === 'en' ? 'No default skills folder on this platform' : '当前平台没有默认技能目录')
    return
  }
  await refreshDefaultFolderFlag()
  await refreshSkillList()
  ElMessage.success(store.locales === 'en' ? `Back to default folder: ${dir}` : `已恢复默认技能文件夹：${dir}`)
}

/**
 * 安装技能（参照「插件 → 管理 → 安装插件」）：
 * 主进程弹目录选择框 → 复制技能文件夹进技能目录 → 刷新列表。
 * 同名冲突时先确认，再以 replace 重试。
 */
const installSkill = async () => {
  const api: any = getPlatform().host.skills
  if (!api?.install) {
    ElMessage.error(store.locales === 'en' ? 'Installing skills is not supported here' : '当前环境不支持安装技能')
    return
  }
  const run = async (replace = false): Promise<void> => {
    try {
      const res = await api.install({ root: store.skillsPath, replace })
      if (res?.cancelled) return
      ElMessage.success(store.locales === 'en'
        ? `Installed skill: ${res?.name || ''}`
        : `已安装技能：${res?.name || ''}`)
      await refreshSkillList()
    } catch (e: any) {
      if (e?.code === 'SKILL_EXISTS') {
        try {
          await ElMessageBox.confirm(
            store.locales === 'en'
              ? `${e.message}. Replacing first removes the old copy in the skills folder (skills hold no user data, so this is usually safe).`
              : `${e.message}。覆盖安装会先删除技能目录里的旧版本（技能本身不含用户数据，通常安全）。`,
            store.locales === 'en' ? 'Replace?' : '覆盖安装？',
            { type: 'warning', confirmButtonText: store.locales === 'en' ? 'Replace' : '覆盖安装', cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消' },
          )
        } catch {
          return
        }
        return await run(true)
      }
      ElMessage.error(e?.message || String(e))
    }
  }
  await run()
}

/** 在资源管理器中打开技能根目录（未设置时提示） */
const revealSkillsRoot = async () => {
  if (!store.skillsPath) return
  try {
    const ok = await getPlatform().shell.revealInFolder(store.skillsPath)
    if (!ok) ElMessage.warning(store.locales === 'en' ? 'Cannot open the folder here' : '当前平台打不开文件夹')
  } catch {
    ElMessage.warning(store.locales === 'en' ? 'Cannot open the folder here' : '当前平台打不开文件夹')
  }
}

// 加载技能列表
const loadSkillList = async () => {
  if (!store.skillsPath) {
    skills.value = []
    return
  }

  loading.value = true
  try {
    const loaded = await getPlatform().host.skills.list(store.skillsPath)
    skills.value = loaded
    addLog('info', `已加载 ${loaded.length} 个技能`)
  } catch (error: any) {
    addLog('error', `加载技能失败: ${error.message}`)
  } finally {
    loading.value = false
  }
}

// 刷新技能列表
const refreshSkillList = async () => {
  selectedSkill.value = null
  previewFile.value = null
  previewContent.value = ''
  await loadSkillList()
}

// 选择技能
const selectSkill = (skill: SkillItem) => {
  selectedSkill.value = skill
  previewFile.value = null
  previewContent.value = ''
  tallScreen.value = 'tree'   // 细长窗口：选中技能后整屏进入文件树
  addLog('info', `选中技能: ${skill.name}`)
}

/** 细长窗口：从文件树整屏返回技能列表 */
const backToSkillList = () => { tallScreen.value = 'list' }

/** 细长窗口：从文件编辑整屏返回文件树（Monaco 在隐藏期间量不到尺寸，回来时重新布局一次） */
const backToFileTree = () => {
  tallScreen.value = 'tree'
  nextTick(() => previewEditor?.layout())
}

// ====== 技能启用开关（关闭的技能不注入智能体 / 不被 skill 工具加载） ======

const isSkillEnabled = (name: string): boolean => {
  return !store.disabledSkills.includes(name)
}

const toggleSkillEnabled = (name: string) => {
  const disabled = new Set(store.disabledSkills)
  if (disabled.has(name)) {
    disabled.delete(name)
  } else {
    disabled.add(name)
  }
  store.disabledSkills = Array.from(disabled)
  store.saveConfig()
  addLog('info', `${disabled.has(name) ? '禁用' : '启用'}技能: ${name}`)
}

// 获取文件图标类名
const getFileIconClass = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'md': return 'fa fa-file-text-o'
    case 'py': return 'fa fa-file-code-o'
    case 'js': return 'fa fa-file-code-o'
    case 'ts': return 'fa fa-file-code-o'
    case 'json': return 'fa fa-file-code-o'
    case 'yaml': case 'yml': return 'fa fa-file-code-o'
    case 'txt': return 'fa fa-file-text-o'
    case 'html': return 'fa fa-file-code-o'
    case 'css': return 'fa fa-file-code-o'
    case 'vue': return 'fa fa-file-code-o'
    default: return 'fa fa-file-o'
  }
}

// 格式化文件大小
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 预览技能文件（可编辑）
const previewSkillFile = async (file: SkillFile) => {
  if (!file || !file.path) return
  previewFile.value = file
  tallScreen.value = 'editor'   // 细长窗口：点文件即整屏进入编辑器（编辑器创建时容器已可见）
  try {
    const content = await getPlatform().fs.readText(file.path)
    if (typeof content !== 'string' || content.startsWith('Error reading file')) {
      throw new Error(content || '无法读取文件')
    }
    previewContent.value = content
    previewOriginalContent.value = content
    nextTick(() => initPreviewEditor(content, file.name))
    addLog('info', `预览文件: ${file.name}`)
  } catch (error: any) {
    addLog('error', `读取文件失败: ${error.message}`)
  }
}

// 重载预览文件
const reloadPreviewContent = async () => {
  if (!previewFile.value) return
  try {
    const content = await getPlatform().fs.readText(previewFile.value.path)
    if (typeof content !== 'string' || content.startsWith('Error reading file')) {
      throw new Error(content || '无法读取文件')
    }
    previewContent.value = content
    previewOriginalContent.value = content
    if (previewEditor) {
      previewEditor.setValue(content)
    }
    addLog('info', `已重载: ${previewFile.value.name}`)
  } catch (error: any) {
    addLog('error', `重载失败: ${error.message}`)
  }
}

// 保存预览文件
const savePreviewContent = async () => {
  if (!previewFile.value || !previewHasChanges.value) return
  saving.value = true
  try {
    const result = await getPlatform().fs.writeText(previewFile.value.path, previewContent.value)
    if (result.success) {
      previewOriginalContent.value = previewContent.value
      addLog('info', `文件已保存: ${previewFile.value.name}`)
    } else {
      addLog('error', `保存失败: ${result.error}`)
    }
  } catch (error: any) {
    addLog('error', `保存失败: ${error.message}`)
  } finally {
    saving.value = false
  }
}

// 在资源管理器中打开技能文件夹
const openSkillInExplorer = () => {
  if (selectedSkill.value) {
    getPlatform().shell.revealInFolder(selectedSkill.value.path)
  }
}

// ==================== 日志 ====================

const addLog = (level: 'info' | 'warning' | 'error', message: string) => {
  const time = new Date().toLocaleTimeString()
  logs.value.push({ time, level, message })
  if (logs.value.length > 1000) {
    logs.value = logs.value.slice(-500)
  }
}

// ==================== Monaco 编辑器 ====================

// 获取文件语言
const getFileLanguage = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'md': return 'markdown'
    case 'py': return 'python'
    case 'js': return 'javascript'
    case 'ts': return 'typescript'
    case 'json': return 'json'
    case 'yaml': case 'yml': return 'yaml'
    case 'html': return 'html'
    case 'css': return 'css'
    case 'vue': return 'html'
    case 'xml': return 'xml'
    case 'sh': case 'bash': return 'shell'
    case 'txt': default: return 'plaintext'
  }
}

// 初始化预览编辑器（可编辑，追踪变化）
const initPreviewEditor = (content: string, filename: string) => {
  if (!previewContainer.value) return
  if (previewEditor) {
    previewEditor.dispose()
    previewEditor = null
  }

  const lang = getFileLanguage(filename)

  previewEditor = monaco.editor.create(previewContainer.value, {
    value: content,
    language: lang,
    theme: 'vs-dark',
    minimap: { enabled: false },
    fontSize: 12,
    readOnly: false,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: 'on',
    tabSize: 2,
  })

  // 监听内容变化，同步到 previewContent
  previewEditor.onDidChangeModelContent(() => {
    if (previewEditor) {
      previewContent.value = previewEditor.getValue()
    }
  })
}

// ==================== 监听器 ====================

// 监听 skillsPath 变化
watch(() => store.skillsPath, async (newPath) => {
  await refreshDefaultFolderFlag()
  if (newPath) {
    await loadSkillList()
  } else {
    skills.value = []
  }
})

// ==================== 生命周期 ====================

onMounted(async () => {
  // 默认存储位置：技能默认在 userData/skills（首次运行自动就位；用户选过目录则沿用）
  await ensureDefaultSkillsPath()
  await refreshDefaultFolderFlag()
  if (store.skillsPath) {
    await loadSkillList()
  }
  // 技能目录变更监听（skill-service watcher）：目录内 SKILL.md 增删改自动刷新
  // 列表；window.dsh 不存在（旧构建/独立窗口）时静默跳过
  if (aikmDsh?.skills?.onChange) {
    skillChangeUnsubscribe = aikmDsh.skills.onChange(() => {
      if (store.skillsPath) loadSkillList()
    })
  }
})

onBeforeUnmount(() => {
  if (skillChangeUnsubscribe) {
    skillChangeUnsubscribe()
    skillChangeUnsubscribe = null
  }
  if (previewEditor) {
    previewEditor.dispose()
    previewEditor = null
  }
})
</script>

<style scoped>
.agent-skill {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* ====== 顶部工具栏（参照工具管理 group-title-row：h3 左 + 操作区右） ====== */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 3px;
  margin: 0;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.top-bar h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0;
  padding: 0 0 8px 10px;
  border-bottom: none;
  font-size: 14px;
  margin-top: 5px;
  margin-left: 5px;
  font-weight: 600;
  flex-shrink: 0;
}
.top-bar h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* 管理/配置 内部切换 */
.inner-tabs {
  display: flex;
  flex-shrink: 0;
  border-right: 1px solid var(--borderColor);
}
.inner-tabs .tab-btn {
  padding: 8px 14px;
  font-size: 12px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  text-align: center;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.inner-tabs .tab-btn:hover {
  background: var(--backgroundColor);
}
.inner-tabs .tab-btn.active {
  border-bottom-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: var(--backgroundColor);
}

/* ====== 按钮 ====== */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0px;
  border: 0px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background: var(--menuColor);
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
  border:1px solid var(--borderColor);
  font-size: 12px;
}

.button:hover {
  background: var(--menuColor);
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button.danger {
  background: #f44336;
  color: white;
  border-color: #f44336;
}

.button.danger:hover {
  background: #d32f2f;
}

.button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
}

.button.active {
  background: #2196F3;
  color: white;
  border-color: #2196F3;
}

.button.saving {
  background: #4CAF50;
  color: white;
  border-color: #4CAF50;
}

/* ====== 管理标签页 ====== */
.manage-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.manage-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0px;
  padding-right: 5px;
}
/* 图标按钮：默认仅显示图标（无边框），悬停 title 显示说明 */
.icon-btn {
  width: 23px;
  height: 23px;
  margin: 0;
  padding: 0;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

/* ====== 左侧导航（参照「插件 → 管理」）：安装 / 搜索 / 列表 / 底栏 ====== */
.sk-nav-toolbar {
  /* 与「插件 → 管理」工具栏同一行：安装占满剩余宽度，其余四个图标按钮固定 26px */
  display: flex; flex-wrap: nowrap; gap: 4px;
  padding: 5px; flex-shrink: 0;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.sk-nav-btn {
  flex: 0 0 26px; width: 26px; min-width: 26px; height: 26px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 12px; transition: all .12s;
}
.sk-nav-btn:hover:not(:disabled) { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.sk-nav-btn:disabled { opacity: .4; cursor: not-allowed; }
.sk-nav-btn.primary {
  flex: 1 1 auto; width: auto; min-width: 0; padding: 0 6px;
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor));
  color: var(--fontActiveColor);
}
.sk-nav-btn.primary:hover { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); }
.sk-nav-btn-label { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-nav-search {
  display: flex; align-items: center; gap: 6px;
  margin: 5px; height: 26px; padding: 0 6px; flex-shrink: 0;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); font-size: 12px; color: var(--borderColor);
}
.sk-nav-search input {
  flex: 1; min-width: 0; margin: 0;
  border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px;
}
.sk-search-clear { cursor: pointer; }
.sk-search-clear:hover { color: var(--fontActiveColor); }
.sk-nav-foot {
  flex-shrink: 0; display: flex; flex-direction: column; gap: 3px;
  padding: 5px 7px; border-top: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.sk-foot-row { display: flex; align-items: center; justify-content: space-between; font-size: 10px; opacity: .8; }
.sk-foot-icons { display: flex; align-items: center; gap: 6px; }
.sk-foot-icon { font-size: 10px; }
.sk-foot-icon.action { cursor: pointer; }
.sk-foot-icon.action:hover { color: var(--fontActiveColor); opacity: 1; }
.sk-foot-path {
  display: flex; align-items: center; gap: 5px; min-width: 0;
  font-size: 10px; opacity: .65; cursor: pointer;
}
.sk-foot-path:hover { opacity: 1; }
.sk-foot-path i { flex-shrink: 0; }
.sk-foot-path-text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left;
}
/* 文件树头部的「打开该技能文件夹」 */
.sk-open-dir { margin-left: 8px; cursor: pointer; opacity: .7; }
.sk-open-dir:hover { opacity: 1; color: var(--fontActiveColor); }

.folder-path {
  font-size: 11px;
  color: var(--fontColor);
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「默认位置」徽标：技能目录仍是 userData/skills（没被用户改成自定义目录） */
.folder-default-badge {
  font-style: normal;
  font-size: 9px;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid var(--borderColor);
  opacity: .75;
}

.skill-count {
  font-size: 10px;
  color: var(--fontColor);
  white-space: nowrap;
}

.manage-split {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.manage-left {
  /* 与「插件 → 管理」左栏一致：230px（安装按钮 + 四个图标按钮能排在一行） */
  width: 230px;
  min-width: 230px;
  flex-shrink: 0;
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
}

.skill-list {
  flex: 1;
  overflow-y: auto;
  /* 与「插件 → 管理」列表一致的左右留白 */
  padding: 0 4px 4px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  transition: all .12s;
  margin-bottom: 2px;
  box-sizing: border-box;
  /* 与「插件 → 管理」的行高对齐：两行（名称 + 描述）固定 44px，描述为空也不会变矮 */
  min-height: 44px;
  user-select: none;
  -webkit-user-select: none;
}

.skill-item:hover {
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  border-color: transparent;
}

.skill-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  border-color: var(--fontActiveColor);
}

.skill-item i {
  font-size: 16px;
  color: #FF9800;
  flex-shrink: 0;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-desc {
  display: block;
  font-size: 10px;
  color: var(--fontColor);
  opacity: .55;
  min-height: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 技能启用开关 */
.skill-enable-toggle {
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: var(--borderColor);
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  transition: all .15s;
}
.skill-enable-toggle .skill-enable-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.skill-enable-toggle.on { background: var(--fontActiveColor); }
.skill-enable-toggle.on .skill-enable-knob { left: 16px; }

.skill-emoji {
  margin-right: 3px;
  font-size: 14px;
}

.skill-badge {
  font-size: 9px;
  color: var(--borderColor);
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--backgroundColor);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 中间列：文件树 */
.manage-middle {
  width: 240px;
  min-width: 220px;
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-tree-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 两列的表头：高度与左侧工具栏（sk-nav-toolbar = 26px 按钮 + 上下 5px padding + 1px 分隔线）
   完全一致，固定 37px；技能名 / 文件名过长时截断而不换行，表头不会被撑高。 */
.file-tree-header,
.file-preview-header {
  box-sizing: border-box;
  height: 37px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  line-height: 1;
  font-weight: 500;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
}
/* 名称占满剩余宽度，超出用省略号（file-count / 图标 / 保存按钮保持可见） */
.file-tree-header > span:first-of-type,
.file-preview-header > span:first-of-type {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-tree-header > .file-count,
.file-tree-header > .sk-open-dir,
.file-preview-header > div,
.file-tree-header > .sk-back,
.file-preview-header > .sk-back {
  flex-shrink: 0;
}

.file-count {
  font-size: 10px;
  font-weight: normal;
  color: var(--borderColor);
}

.file-tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

/* 右侧列：编辑器 */
.manage-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.file-preview-header {
  /* 高度由上面与 .file-tree-header 合并的规则统一为固定 37px */
  padding: 0 10px;
}

.file-preview-content {
  flex: 1;
  min-height: 0;
}

.tree-folder {
  user-select: none;
}

.folder-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.folder-row:hover {
  background: var(--menuColor);
}

.folder-row i.fa-chevron-right,
.folder-row i.fa-chevron-down {
  font-size: 9px;
  width: 10px;
  color: var(--borderColor);
}

.folder-row i.fa-folder {
  font-size: 12px;
  color: #FFB300;
}

.folder-row i.fa-folder-open {
  font-size: 12px;
  color: #FFB300;
}

.folder-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-children {
  padding-left: 18px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.file-item:hover {
  background: var(--menuColor);
}

.file-item.active {
  background: rgba(33, 150, 243, 0.12);
  color: var(--fontActiveColor);
}

.file-item i {
  font-size: 12px;
  flex-shrink: 0;
  color: var(--borderColor);
}

.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 9px;
  color: var(--borderColor);
  flex-shrink: 0;
}

.file-skill-badge {
  font-size: 9px;
  color: var(--borderColor);
  padding: 0 4px;
  border-radius: 4px;
  background: var(--backgroundColor);
  flex-shrink: 0;
}

/* ====== 空状态 ====== */
.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--borderColor);
  gap: 8px;
}

.empty-hint i {
  font-size: 32px;
}

.empty-hint span {
  font-size: 12px;
}

/* ====== 滚动条 ====== */
::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

::-webkit-scrollbar-track {
  background: var(--backgroundColor);
}

::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}

/* ====== 细长窗口（高宽比 > 16:9，如手机竖屏）：技能列表 → 文件树 → 编辑器逐级整屏 ======
   三栏并排会把编辑器挤到只剩一两百像素。三屏都用 v-show 隐藏，切回来时列表滚动位置与
   编辑器内容都还在。 */
.agent-skill.tall .manage-left,
.agent-skill.tall .manage-middle {
  width: 100%;
  min-width: 0;
  border-right: 0;
}
.agent-skill.tall .manage-right { width: 100%; }
/* 技能条目按钢琴键式整宽条目呈现：行高够手指点 */
.agent-skill.tall .skill-list { padding: 8px; }
.agent-skill.tall .skill-item {
  min-height: 56px;
  padding: 8px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--menuColor);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.agent-skill.tall .skill-name { font-size: 14px; }
.agent-skill.tall .skill-desc { font-size: 12px; }
/* 文件树条目同样放大（触摸目标够大） */
.agent-skill.tall .file-item,
.agent-skill.tall .folder-row { min-height: 34px; }
/* 各屏标题栏里的返回按钮（只在细长窗口出现；做小以免撑高标题栏） */
.sk-back {
  flex-shrink: 0;
  width: 26px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 11px;
  transition: all 0.15s ease;
}
.sk-back:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
/* 标题栏：返回按钮 + 标题靠左、其余靠右（原本的 space-between 会把标题挤到中间） */
.agent-skill.tall .file-tree-header,
.agent-skill.tall .file-preview-header { gap: 8px; }
.agent-skill.tall .file-tree-header > span:first-of-type,
.agent-skill.tall .file-preview-header > span:first-of-type {
  margin-right: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 顶部工具栏（技能文件夹 / 刷新 / 打开）在细长窗口下也允许横向滑动 */
.agent-skill.tall .top-bar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.agent-skill.tall .top-bar::-webkit-scrollbar { display: none; }
</style>
