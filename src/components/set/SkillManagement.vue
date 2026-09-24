<!-- SkillManagement.vue - 技能管理模块 -->
<template>
  <div class="agent-skill">
    <!-- ====== 顶部工具栏 ====== -->
    <div class="top-bar">
      <h3>{{ store.locales === 'en' ? 'Skill Management' : '技能管理' }}</h3>
      <div class="manage-toolbar">
        <span class="skill-count" v-if="skills.length > 0">{{ skills.length }} {{ store.locales === 'en' ? 'skills' : '个技能' }}</span>
        <span class="folder-path" :title="store.skillsPath || (store.locales === 'en' ? 'Not set' : '未设置')">
          <i class="fa fa-folder"></i> {{ store.skillsPath || (store.locales === 'en' ? 'No skills folder set' : '未设置技能文件夹') }}
        </span>
        <div class="button icon-btn" @click="openSkillsFolder" :title="store.locales === 'en' ? 'Select skills folder' : '选择技能文件夹'">
          <i class="fa fa-folder-open"></i>
        </div>
        <div class="button icon-btn" @click="refreshSkillList" :disabled="loading" :title="store.locales === 'en' ? 'Refresh skills' : '刷新技能'">
          <i class="fa" :class="loading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
        </div>
        <div class="button icon-btn" @click="openSkillInExplorer" :disabled="!selectedSkill" :title="store.locales === 'en' ? 'Open in Explorer' : '在资源管理器中打开'">
          <i class="fa fa-external-link"></i>
        </div>
      </div>
    </div>

    <!-- ====== 管理内容 ====== -->
    <div class="manage-content">
      <div class="manage-split">
        <!-- 左侧：技能列表 -->
        <div class="manage-left">
          <div class="skill-list">
            <div v-if="loading" class="empty-hint" style="height:100%;">
              <i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>
              <span>{{ store.locales === 'en' ? 'Loading...' : '加载中...' }}</span>
            </div>
            <div v-else-if="skills.length === 0" class="empty-hint" style="height:100%;">
              <i class="fa fa-cubes" style="font-size:24px;"></i>
              <span>{{ store.skillsPath ? (store.locales === 'en' ? 'No skill files found' : '未找到技能文件') : (store.locales === 'en' ? 'Please set skills folder first' : '请先设置技能文件夹') }}</span>
            </div>
            <div
              v-for="skill in skills"
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
        </div>

        <!-- 中间：文件树 -->
        <div class="manage-middle">
          <div v-if="!selectedSkill" class="empty-hint">
            <i class="fa fa-hand-pointer-o" style="font-size:28px;"></i>
            <span>{{ store.locales === 'en' ? 'Select a skill from the left' : '请从左侧选择一个技能' }}</span>
          </div>
          <div v-else class="file-tree-container">
            <div class="file-tree-header">
              <span><i class="fa fa-folder-open-o"></i> {{ selectedSkill.name }}</span>
              <span class="file-count">{{ skillFiles.length }} {{ store.locales === 'en' ? 'files' : '个文件' }}</span>
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
        <div class="manage-right" v-if="previewFile">
          <div class="file-preview-header">
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
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { usestore } from '@/store'
import * as monaco from 'monaco-editor'
import { ensureMonacoEnvironment } from '@/lib/monaco-env'

const store = usestore()

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
  const path = await window.ipcRenderer.invoke('openFolderDialog')
  if (path) {
    store.skillsPath = path
    store.saveConfig()
    await loadSkillList()
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
    const loaded = await window.ipcRenderer.invoke('loadSkills', store.skillsPath)
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
  addLog('info', `选中技能: ${skill.name}`)
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
  try {
    const content = await window.ipcRenderer.invoke('readFile', file.path)
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
    const content = await window.ipcRenderer.invoke('readFile', previewFile.value.path)
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
    const result = await window.ipcRenderer.invoke('writeFile', previewFile.value.path, previewContent.value)
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
    window.ipcRenderer.invoke('openInFolder', selectedSkill.value.path)
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
  if (newPath) {
    await loadSkillList()
  } else {
    skills.value = []
  }
})

// ==================== 生命周期 ====================

onMounted(async () => {
  if (store.skillsPath) {
    await loadSkillList()
  }
  // 技能目录变更监听（skill-service watcher）：目录内 SKILL.md 增删改自动刷新
  // 列表；window.dsh 不存在（旧构建/独立窗口）时静默跳过
  if (window.dsh?.skills?.onChange) {
    skillChangeUnsubscribe = window.dsh.skills.onChange(() => {
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

.folder-path {
  font-size: 11px;
  color: var(--fontColor);
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  width: 180px;
  min-width: 200px;
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
}

.skill-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
  margin-bottom: 2px;
}

.skill-item:hover {
  background: var(--menuColor);
  border-color: var(--borderColor);
}

.skill-item.active {
  background: rgba(33, 150, 243, 0.12);
  border-color: #2196F3;
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
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-desc {
  display: block;
  font-size: 10px;
  color: var(--borderColor);
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

.file-tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 22px;
  font-weight: 500;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
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
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0px 5px;
  font-size: 11px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  height: 34px
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
</style>
