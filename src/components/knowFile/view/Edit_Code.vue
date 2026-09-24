<script setup lang="ts">
import { onMounted, watch, onBeforeUnmount, ref, computed, watchEffect, nextTick } from 'vue'
import { usestore } from '@/store'
import * as monaco from 'monaco-editor'
import { ensureMonacoEnvironment } from '@/lib/monaco-env'
import { createASRManager } from '@/services/asr/manager'

// Monaco worker 环境按需初始化（避免首屏加载 Monaco）
ensureMonacoEnvironment()
import { useCollabSession } from '@/composables/useCollabSession'
import type { CollabMember } from '@/types/collab'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/nnfx-dark.min.css'
import { ElMessage, ElMessageBox } from 'element-plus'
import { diffLines, diffChars, type DiffOp } from '@/lib/diff'
import BlockMd from '@/components/block_md.vue'
import DocTocPanel from '@/components/knowFile/view/DocTocPanel.vue'
import { extractMarkdownHeadings, flattenHeadingLevels, loadDocTocWidth, saveDocTocWidth, loadDocTocOpen, saveDocTocOpen, DOC_TOC_MIN_WIDTH, DOC_TOC_MAX_WIDTH } from '@/lib/markdown/toc'
import { loadDocChatWidth, saveDocChatWidth, DOC_CHAT_MIN_WIDTH, DOC_CHAT_MAX_WIDTH } from '@/lib/knowFile/panelWidths'

const store = usestore()

// 编辑器实例
let editor: monaco.editor.IStandaloneCodeEditor | null = null
// 编辑器是否已初始化
const editorInitialized = ref(false)
// 缩略图（minimap）开关，默认开启
const minimapEnabled = ref(true)
// 脏状态标记 — 是否有未保存的修改
const isDirty = ref(false)
// 最近一次保存/加载时的内容快照（用于判断是否已保存）
let savedContent = ''
// 最近一次保存/加载时的内容版本号（大文件下用于 O(1) 脏检查，替代逐键全量字符串比较）
let savedVersion = 0
// 编程式更新标记（避免将程序更新误认为用户修改）
let isUpdatingContent = false

// ---- 协同文件编辑（局域网实时多人） ----
const collab = useCollabSession()
const showCollabPanel = ref(false)
const collabJoinUrl = ref('')
const collabJoinName = ref('')
// 协同服务运行状态（用于生成可复制的加入地址）
const collabServerStatus = ref<{ running: boolean; port: number; ips: string[] }>({ running: false, port: 0, ips: [] })
let collabStatusUnsub: (() => void) | null = null
// 组件卸载标志（卸载时不弹结束提示）
let collabUnmounting = false

const collabEnabled = computed(() => store.collab.enabled)
const isCollabActive = computed(() => collab.status.value !== 'idle')

// 打开协同面板时，用设置里的客户端名称预填昵称输入框
watch(showCollabPanel, (v) => {
    if (v && !collabJoinName.value.trim()) {
        collabJoinName.value = store.collab.nickname || ''
    }
})

/** 可复制的加入地址（宿主导出给客户端） */
const collabJoinLink = computed(() => {
    if (!collab.roomId.value) return ''
    const port = collabServerStatus.value.port || store.collab.port
    const ip = collabServerStatus.value.ips[0] || '127.0.0.1'
    const token = store.collab.token
    return `ws://${ip}:${port}/collab/${collab.roomId.value}?token=${encodeURIComponent(token)}`
})

/** 协同按钮图标 */
const collabIcon = () => {
    if (collab.status.value === 'connecting') return 'fa fa-spinner fa-spin'
    if (collab.status.value === 'connected') return 'fa fa-users'
    return 'fa fa-users'
}

// 会话结束回调：恢复本地内容基线、只读状态，并提示（主动离开不提示）
collab.onClosed((reason) => {
    const model = editor ? editor.getModel() : null
    if (model) {
        savedContent = model.getValue()
        savedVersion = model.getAlternativeVersionId()
        data.value.content = savedContent
        isDirty.value = false
        editor!.updateOptions({ readOnly: false })
        updateStatusBar()
    }
    if (reason !== 'left' && !collabUnmounting) {
        ElMessage.warning(store.locales === 'zh' ? ('协同会话结束: ' + reason) : ('Collab session ended: ' + reason))
    }
    showCollabPanel.value = false
})

// 会话期间根据连接状态/编辑权限切换编辑器只读
watch([() => collab.status.value, () => collab.canEdit.value], () => {
    if (!editor) return
    if (collab.status.value === 'connecting') {
        editor.updateOptions({ readOnly: true })
    } else if (collab.status.value === 'connected') {
        editor.updateOptions({ readOnly: !collab.canEdit.value })
    }
})

/** 确保协同服务已启动 */
const ensureCollabServer = async (): Promise<boolean> => {
    if (!window.dsh?.collab) {
        ElMessage.error(store.locales === 'zh' ? '协同服务不可用（请先在设置中开启）' : 'Collab service unavailable')
        return false
    }
    try {
        const st = await window.dsh.collab.getStatus()
        if (st.running) {
            collabServerStatus.value = st
            return true
        }
        const res = await window.dsh.collab.start({
            port: store.collab.port,
            maxMembers: store.collab.maxMembers,
            permissionMode: store.collab.permissionMode,
        })
        if (res.success) {
            if (res.port) store.collab.port = res.port
            const st2 = await window.dsh.collab.getStatus()
            collabServerStatus.value = st2
            return true
        }
        ElMessage.error(store.locales === 'zh' ? ('协同服务启动失败: ' + res.error) : ('Collab start failed: ' + res.error))
        return false
    } catch (e: any) {
        ElMessage.error(store.locales === 'zh' ? ('协同服务启动失败: ' + e.message) : ('Collab start failed: ' + e.message))
        return false
    }
}

/** 宿主共享当前文件 */
const shareCurrentFile = async () => {
    if (!editor || !data.value) return
    if (isCollabActive.value) {
        showCollabPanel.value = true
        return
    }
    if (!(await ensureCollabServer())) return
    const model = editor.getModel()
    if (!model) return
    // 连接期间先置只读，收到快照后按权限恢复
    editor.updateOptions({ readOnly: true })
    const ok = await collab.startHost(editor, model, data.value.path, editor.getValue(), {
        token: store.collab.token || undefined,
        maxMembers: store.collab.maxMembers,
        permissionMode: store.collab.permissionMode,
        autoSaveSeconds: store.collab.autoSaveSeconds,
        name: store.collab.nickname.trim() || '主机',
    })
    if (ok) {
        // 回填自动生成的房间 Token（分享时若未设置，服务端生成）
        if (!store.collab.token && collab.roomToken.value) {
            store.collab.token = collab.roomToken.value
            store.saveConfig()
        }
        const st = await window.dsh?.collab.getStatus()
        if (st) collabServerStatus.value = st
        showCollabPanel.value = true
        ElMessage.success(store.locales === 'zh' ? '已开始共享，可复制加入地址' : 'Sharing started, copy the join link')
    } else {
        editor.updateOptions({ readOnly: false })
        ElMessage.error(store.locales === 'zh' ? ('共享失败: ' + (collab.error.value || '未知错误')) : ('Share failed: ' + (collab.error.value || 'Unknown error')))
    }
}

/** 客户端加入会话 */
const joinCollabSession = async () => {
    if (!editor || !data.value) return
    if (isCollabActive.value) return
    const url = collabJoinUrl.value.trim()
    if (!url) {
        ElMessage.warning(store.locales === 'zh' ? '请输入加入地址' : 'Enter the join address')
        return
    }
    const model = editor.getModel()
    if (!model) return
    // 客户端名称：优先面板输入，其次设置里的默认名称，最后兜底
    const typedName = collabJoinName.value.trim()
    const clientName = typedName || store.collab.nickname.trim() || '访客'
    // 用户填了新名称则记住，方便下次使用
    if (typedName && typedName !== store.collab.nickname) {
        store.collab.nickname = typedName
        store.saveConfig()
    }
    editor.updateOptions({ readOnly: true })
    const ok = await collab.join(editor, model, url, clientName)
    if (ok) {
        showCollabPanel.value = true
        ElMessage.success(store.locales === 'zh' ? '已加入协同会话' : 'Joined collab session')
    } else {
        editor.updateOptions({ readOnly: false })
        ElMessage.error(store.locales === 'zh' ? ('加入失败: ' + (collab.error.value || '未知错误')) : ('Join failed: ' + (collab.error.value || 'Unknown error')))
    }
}

/** 退出会话 */
const leaveCollabSession = async () => {
    const wasHost = collab.isHost.value
    const rid = collab.roomId.value
    collab.leave()
    if (wasHost && rid && window.dsh?.collab) {
        await window.dsh.collab.closeRoom(rid).catch(() => {})
    }
    showCollabPanel.value = false
}

/** 切换协同面板 */
const toggleCollabPanel = () => {
    if (!collabEnabled.value) return
    showCollabPanel.value = !showCollabPanel.value
}

/** 复制加入地址 */
const copyCollabLink = () => {
    if (!collabJoinLink.value) return
    navigator.clipboard.writeText(collabJoinLink.value)
        .then(() => ElMessage.success(store.locales === 'zh' ? '加入地址已复制' : 'Join link copied'))
        .catch(() => {})
}

/** 宿主批准/拒绝编辑请求 */
const respondEditRequest = (memberId: string, grant: boolean) => {
    if (grant) collab.grantEdit(memberId)
    else collab.denyEdit(memberId)
    collab.clearEditRequest(memberId)
}

// 当前数据引用
const data = ref(store.data[store.index])

// 大文件判定阈值（字符数）——超过则进入大文件降级模式
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024
// 是否大文件（按当前文件内容长度判断）
const isLargeFile = computed(() => {
    const c = data?.value?.content
    return typeof c === 'string' && c.length > LARGE_FILE_THRESHOLD
})
// 编辑器加载中（大文件异步填充时显示遮罩）
const editorLoading = ref(false)

// ---- 自定义 AI 推理（输入提示词，结果展示在对话框供复制） ----
const showCustomPrompt = ref(false)
const customPromptText = ref('')
const customPromptResult = ref('')
const customPromptLoading = ref(false)
const customPromptShowSource = ref(false)
const customPromptResultRef = ref<HTMLElement | null>(null)
let customPromptAbort: AbortController | null = null
// 对话框宽度（null = 用共用的默认宽度；拖动左边界调整后固定为具体值）
const customPromptWidth = ref<number | null>(null)
// 与其它视图（浏览 / 可视编辑 / PDF）共用的面板宽度与默认值（见 lib/knowFile/panelWidths）
const docChatWidth = ref(loadDocChatWidth())
const effectivePromptWidth = computed(() => customPromptWidth.value ?? docChatWidth.value)
// 拖动后结果区不再受默认 max-height 限制（填满对话框）
const resultStyle = computed(() => customPromptWidth.value !== null ? { maxHeight: 'none' } : {})
let promptResizeData: { startX: number; startWidth: number } | null = null

const startPromptResize = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const dialog = (e.currentTarget as HTMLElement).closest('.custom-prompt-dialog') as HTMLElement
    if (!dialog) return
    promptResizeData = {
        startX: e.clientX,
        startWidth: effectivePromptWidth.value
    }
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onPromptResize, true)
    window.addEventListener('mouseup', stopPromptResize, true)
}

const onPromptResize = (e: MouseEvent) => {
    if (!promptResizeData) return
    const delta = e.clientX - promptResizeData.startX
    // 面板位于右侧：向左拖（delta 为负）宽度增大
    const newWidth = promptResizeData.startWidth - delta
    // 限幅与其它视图一致，但不超过窗口宽度的 60%
    const maxW = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(DOC_CHAT_MAX_WIDTH, Math.floor(window.innerWidth * 0.6)))
    customPromptWidth.value = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(maxW, newWidth))
    saveDocChatWidth(customPromptWidth.value)
}

const stopPromptResize = () => {
    promptResizeData = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onPromptResize, true)
    window.removeEventListener('mouseup', stopPromptResize, true)
}

const triggerCustomPrompt = async () => {
    if (!(await store.ensureDefaultModelOnline())) {
        ElMessage.warning(store.locales === 'zh' ? 'AI 服务未连接，请先检查配置。' : 'AI service is not connected, please check configuration.')
        return
    }
    // 保持编辑器焦点：点击按钮不应让选中/光标消失，确保能捕获选中文本
    editor?.focus()
    // 保留上次的输入与推理/修改结果（关闭后重新打开仍可见）。
    // 仅当没有正在展示的修改结果时，才重新捕获当前选中/目标文本。
    if (!modifyTargetInfo.value || !modifyResult.value) {
        captureModifyTarget()
    }
    showCustomPrompt.value = true
}

/** 获取选中文本；无选中时返回整个编辑器内容 */
const getEffectiveText = (): string => {
    if (!editor) return ''
    const { text } = getSelectedText()
    if (text) return text
    const model = editor.getModel()
    return model ? model.getValue() : ''
}

const submitCustomPrompt = async () => {
    if (!customPromptText.value.trim()) return
    const effectiveText = getEffectiveText()
    if (!effectiveText) return

    customPromptLoading.value = true
    customPromptResult.value = ''

    if (customPromptAbort) customPromptAbort.abort()
    customPromptAbort = new AbortController()

    const prompt = `${customPromptText.value.trim()}\n\n${effectiveText}`

    try {
        await store.sendToAI([
            { role: 'user', content: prompt }
        ], {
            signal: customPromptAbort.signal,
            onStream: (chunk: string) => {
                customPromptResult.value += chunk
            },
            onComplete: () => {
                customPromptLoading.value = false
                customPromptAbort = null
            },
            onError: (error: Error) => {
                console.error('自定义 AI 推理失败:', error)
                customPromptResult.value += `\n\n[${store.locales === 'zh' ? '错误' : 'Error'}: ${error.message}]`
                customPromptLoading.value = false
                customPromptAbort = null
            }
        })
    } catch (error) {
        console.error('submitCustomPrompt error:', error)
        customPromptLoading.value = false
    }
}

const copyCustomPromptResult = () => {
    if (customPromptResult.value) {
        navigator.clipboard.writeText(customPromptResult.value)
            .then(() => ElMessage.success(store.locales === 'zh' ? '结果源码已复制' : 'Result source copied'))
            .catch(() => {})
    }
}

const clearCustomPromptResult = () => {
    customPromptResult.value = ''
}

const saveCustomPromptResult = async () => {
    if (!customPromptResult.value || !store.root) return
    const rootDir = store.root
    const separator = rootDir.includes('\\') ? '\\' : '/'
    const dir = rootDir.replace(/[\\/]$/, '')

    const now = new Date()
    const timestamp = now.toISOString().split('T')[0] + '_' +
        now.getHours().toString().padStart(2, '0') +
        now.getMinutes().toString().padStart(2, '0')
    const fileName = `推理结果_${timestamp}.md`
    const filePath = `${dir}${separator}${fileName}`

    const content = `---\n导出时间: ${now.toLocaleString('zh-CN')}\n---\n\n${customPromptResult.value}`

    try {
        const success = await window.ipcRenderer.invoke('saveFile', filePath, content)
        if (success) {
            ElMessage.success(store.locales === 'zh' ? '保存成功' : 'Saved successfully')
        } else {
            ElMessage.error(store.locales === 'zh' ? '保存失败' : 'Save failed')
        }
    } catch (error) {
        console.error('保存推理结果失败:', error)
        ElMessage.error(store.locales === 'zh' ? '保存失败: ' + String(error) : 'Save failed: ' + String(error))
    }
}

const closeCustomPrompt = () => {
    showCustomPrompt.value = false
    if (customPromptAbort) {
        customPromptAbort.abort()
        customPromptAbort = null
    }
    // 关闭对话框只中止进行中的请求，不清空已生成的推理/修改数据，
    // 这样重新打开自定义推理时仍能看到之前的结果。
    if (modifyAbort) {
        modifyAbort.abort()
        modifyAbort = null
    }
    if (modifyDiffTimer) {
        clearTimeout(modifyDiffTimer)
        modifyDiffTimer = null
    }
    modifyLoading.value = false
    if (modifyInferAbort) {
        modifyInferAbort.abort()
        modifyInferAbort = null
    }
    modifyInferLoading.value = false
}

// ---- AI 修改模式（diff 对比预览：输入推理方向 → 修改 → 接受/取消） ----
const MODIFY_CONTEXT_LINES = 100

interface ModifyTargetInfo {
    hasSelection: boolean
    range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null
    targetText: string
    contextBefore: string
    contextAfter: string
}

const modifyTargetInfo = ref<ModifyTargetInfo | null>(null)
const modifyMode = ref(false)
const modifyLoading = ref(false)
const modifyResult = ref('')
const modifyDiffOps = ref<DiffOp[]>([])
// diff 视图查看方式：'preview' 渲染预览（两栏） | 'diff' 逐行对比
const modifyViewMode = ref<'preview' | 'diff'>('preview')
// 修改对比对话框内的 Tab：'diff' 修改结果 | 'infer' 推理结果
const modifyActiveTab = ref<'diff' | 'infer'>('diff')
// 推理 Tab 内是否展示“修改结果”作为上下文（便于对照评价）
const showModifyContextInInfer = ref(true)
// 推理 Tab 内是否展示“推理上下文”（发送给 AI 的前后 MODIFY_CONTEXT_LINES 行）
const showInferContext = ref(false)
let modifyAbort: AbortController | null = null
let modifyStreamText = ''
let modifyDiffTimer: ReturnType<typeof setTimeout> | null = null

/** 捕获当前选中区域与目标文本（供修改模式使用） */
const captureModifyTarget = () => {
    if (!editor) {
        modifyTargetInfo.value = null
        return
    }
    const model = editor.getModel()
    if (!model) {
        modifyTargetInfo.value = null
        return
    }
    const { text, range } = getSelectedText()
    if (text && range) {
        // 有选中：目标为选中文本，附带前后文作为上下文
        const beforeLines: string[] = []
        for (let ln = Math.max(1, range.startLineNumber - MODIFY_CONTEXT_LINES); ln < range.startLineNumber; ln++) {
            beforeLines.push(model.getLineContent(ln))
        }
        const afterLines: string[] = []
        const endLine = Math.min(model.getLineCount(), range.endLineNumber + MODIFY_CONTEXT_LINES)
        for (let ln = range.endLineNumber + 1; ln <= endLine; ln++) {
            afterLines.push(model.getLineContent(ln))
        }
        modifyTargetInfo.value = {
            hasSelection: true,
            range: {
                startLineNumber: range.startLineNumber,
                startColumn: range.startColumn,
                endLineNumber: range.endLineNumber,
                endColumn: range.endColumn
            },
            targetText: text,
            contextBefore: beforeLines.join('\n'),
            contextAfter: afterLines.join('\n')
        }
    } else {
        // 无选中：目标为整个文档
        modifyTargetInfo.value = {
            hasSelection: false,
            range: null,
            targetText: model.getValue(),
            contextBefore: '',
            contextAfter: ''
        }
    }
}

/** 构建“修改模式”的提示词（上下文设计：仅修改目标部分，前后文仅作理解） */
const buildModifyPrompt = (instruction: string, info: ModifyTargetInfo): string => {
    if (info.hasSelection) {
        return [
            '【任务】',
            instruction,
            '',
            '【背景说明】',
            '下面提供的“上文”和“下文”只是帮助你理解选中内容所处的环境与风格，请勿修改它们。',
            '你只需要改写“需要修改的选中内容”部分，并直接输出修改后的选中内容本身。',
            '',
            '【上文】',
            '<<<<<<<',
            info.contextBefore || '(无)',
            '>>>>>>>',
            '',
            '【需要修改的选中内容】',
            '<<<<<<<',
            info.targetText,
            '>>>>>>>',
            '',
            '【下文】',
            '<<<<<<<',
            info.contextAfter || '(无)',
            '>>>>>>>',
            '',
            '【输出要求】',
            '1. 只输出修改后的“选中内容”本身，不要输出任何解释、开头语或结尾语。',
            '2. 不要使用 ``` 代码围栏包裹输出。',
            '3. 保持原有的缩进与格式风格。',
            '4. 输出内容将直接替换选中的区域。'
        ].join('\n')
    }
    return [
        '【任务】',
        instruction,
        '',
        '【目标文档】',
        '下方是整个文档内容，请基于你的推理方向改写它，并输出完整的修改后文档。',
        '<<<<<<<',
        info.targetText,
        '>>>>>>>',
        '',
        '【输出要求】',
        '1. 输出整个修改后的文档内容。',
        '2. 不要使用 ``` 代码围栏包裹输出，不要输出任何解释。',
        '3. 保持文档原有的结构、格式与语言风格。',
        '4. 输出内容将直接替换整个文档。'
    ].join('\n')
}

/** 解析 AI 输出：去除可能包裹的代码围栏 */
const parseModifyOutput = (raw: string): string => {
    const text = raw.trim()
    const fence = text.match(/^```[^\n]*\n?([\s\S]*?)\n?```\s*$/)
    if (fence) return fence[1].replace(/\r\n/g, '\n').trimEnd()
    return text.replace(/\r\n/g, '\n')
}

/** 触发修改（新增按钮）：生成修改结果并以 diff 对比模式展示 */
const triggerModify = async () => {
    if (!customPromptText.value.trim()) return
    if (!modifyTargetInfo.value) {
        ElMessage.warning(store.locales === 'zh' ? '未获取到可修改的内容。' : 'No content to modify.')
        return
    }
    if (!(await store.ensureDefaultModelOnline())) {
        ElMessage.warning(store.locales === 'zh' ? 'AI 服务未连接，请先检查配置。' : 'AI service is not connected, please check configuration.')
        return
    }

    modifyMode.value = true
    modifyLoading.value = true
    modifyResult.value = ''
    modifyStreamText = ''
    modifyDiffOps.value = []
    modifyViewMode.value = 'preview'
    modifyActiveTab.value = 'diff'

    if (modifyAbort) modifyAbort.abort()
    modifyAbort = new AbortController()

    const prompt = buildModifyPrompt(customPromptText.value.trim(), modifyTargetInfo.value)

    try {
        await store.sendToAI([
            { role: 'user', content: prompt }
        ], {
            signal: modifyAbort.signal,
            onStream: (chunk: string) => {
                if (!chunk) return
                modifyStreamText += chunk
                scheduleModifyDiff()
            },
            onComplete: () => {
                finalizeModifyDiff()
                modifyLoading.value = false
                modifyAbort = null
            },
            onError: (error: Error) => {
                console.error('AI 修改失败:', error)
                modifyLoading.value = false
                modifyAbort = null
                exitModifyMode()
                ElMessage.error(store.locales === 'zh' ? 'AI 修改失败，请稍后重试。' : 'AI modify failed, please try again later.')
            }
        })
    } catch (error) {
        console.error('triggerModify error:', error)
        modifyLoading.value = false
    }
}

/** 流式期间节流重算 diff（避免每块都重算） */
const scheduleModifyDiff = () => {
    if (modifyDiffTimer) return
    modifyDiffTimer = setTimeout(() => {
        modifyDiffTimer = null
        computeModifyDiff()
    }, 60)
}

/** 重算并更新 diff */
const computeModifyDiff = () => {
    if (!modifyTargetInfo.value) return
    modifyResult.value = parseModifyOutput(modifyStreamText)
    modifyDiffOps.value = diffLines(modifyTargetInfo.value.targetText, modifyResult.value)
}

/** 流结束后最终计算 */
const finalizeModifyDiff = () => {
    if (modifyDiffTimer) {
        clearTimeout(modifyDiffTimer)
        modifyDiffTimer = null
    }
    computeModifyDiff()
}

/** 接受修改：将修改结果应用回编辑器（替换选中区域或整个文档） */
const acceptModify = () => {
    if (!editor || !modifyTargetInfo.value || modifyLoading.value) return
    const modified = modifyResult.value
    if (!modified) return
    const model = editor.getModel()
    if (!model) return

    editor.pushUndoStop()
    if (modifyTargetInfo.value.hasSelection && modifyTargetInfo.value.range) {
        const r = modifyTargetInfo.value.range
        const lineCount = model.getLineCount()
        const endLine = Math.min(r.endLineNumber, lineCount)
        const range = new monaco.Range(r.startLineNumber, r.startColumn, endLine, r.endColumn)
        editor.executeEdits('ai-modify', [{ range, text: modified, forceMoveMarkers: true }])
        // 选中修改后的内容，方便再次微调
        const startOffset = model.getOffsetAt(new monaco.Position(range.startLineNumber, range.startColumn))
        const endPos = model.getPositionAt(startOffset + modified.length)
        editor.setSelection(new monaco.Selection(range.startLineNumber, range.startColumn, endPos.lineNumber, endPos.column))
    } else {
        editor.executeEdits('ai-modify', [{ range: model.getFullModelRange(), text: modified, forceMoveMarkers: true }])
    }
    editor.pushUndoStop()
    editor.focus()
    isDirty.value = true

    ElMessage.success(store.locales === 'zh' ? '修改已应用' : 'Changes applied')
    exitModifyMode()
}

/** 退出修改模式（取消 / 应用后） */
const exitModifyMode = () => {
    if (modifyAbort) {
        modifyAbort.abort()
        modifyAbort = null
    }
    if (modifyDiffTimer) {
        clearTimeout(modifyDiffTimer)
        modifyDiffTimer = null
    }
    modifyMode.value = false
    modifyLoading.value = false
    modifyResult.value = ''
    modifyStreamText = ''
    modifyDiffOps.value = []
    // 同时清空修改模式内的推理结果
    if (modifyInferAbort) {
        modifyInferAbort.abort()
        modifyInferAbort = null
    }
    modifyInferLoading.value = false
    modifyInferResult.value = ''
    modifyActiveTab.value = 'diff'
    showModifyContextInInfer.value = true
    showInferContext.value = false
}

// ---- 修改对比模式内的推理（结果展示在 diff 下方，目标与修改一致） ----
const modifyInferResult = ref('')
const modifyInferLoading = ref(false)
let modifyInferAbort: AbortController | null = null

const renderedModifyInfer = computed(() => {
    return modifyInferResult.value ? customMd.render(modifyInferResult.value) : ''
})

/** 构建“推理”的提示词：有选中时附带前后 MODIFY_CONTEXT_LINES 行上下文 */
const buildInferPrompt = (instruction: string, info: ModifyTargetInfo): string => {
    if (!info.hasSelection) {
        // 无选中：目标即整个文档，本身就是全部上下文
        return `${instruction}\n\n${info.targetText}`
    }
    return [
        '【任务】',
        instruction,
        '',
        '【背景说明】',
        '下面是“上文”和“下文”上下文，帮助你理解目标内容所处的环境与风格。',
        '',
        '【上文】',
        '<<<<<<<',
        info.contextBefore || '(无)',
        '>>>>>>>',
        '',
        '【目标内容】',
        '<<<<<<<',
        info.targetText,
        '>>>>>>>',
        '',
        '【下文】',
        '<<<<<<<',
        info.contextAfter || '(无)',
        '>>>>>>>'
    ].join('\n')
}

/** 推理上下文的纯文本（用于在推理 Tab 展示 AI 接收到的内容） */
const modifyInferContextText = computed(() => {
    const info = modifyTargetInfo.value
    if (!info) return ''
    if (!info.hasSelection) return info.targetText
    return [
        '【上文】',
        '<<<<<<<',
        info.contextBefore || '(无)',
        '>>>>>>>',
        '',
        '【目标内容】',
        '<<<<<<<',
        info.targetText,
        '>>>>>>>',
        '',
        '【下文】',
        '<<<<<<<',
        info.contextAfter || '(无)',
        '>>>>>>>'
    ].join('\n')
})

const runModifyInfer = async () => {
    if (!customPromptText.value.trim()) return
    if (!modifyTargetInfo.value) return
    if (!(await store.ensureDefaultModelOnline())) {
        ElMessage.warning(store.locales === 'zh' ? 'AI 服务未连接，请先检查配置。' : 'AI service is not connected, please check configuration.')
        return
    }
    if (modifyInferAbort) modifyInferAbort.abort()
    modifyInferAbort = new AbortController()
    modifyInferLoading.value = true
    modifyInferResult.value = ''
    // 切到推理结果 Tab，并展开“推理上下文”方便查看 AI 接收的内容
    modifyActiveTab.value = 'infer'
    showInferContext.value = true

    const prompt = buildInferPrompt(customPromptText.value.trim(), modifyTargetInfo.value)

    try {
        await store.sendToAI([
            { role: 'user', content: prompt }
        ], {
            signal: modifyInferAbort.signal,
            onStream: (chunk: string) => {
                if (!chunk) return
                modifyInferResult.value += chunk
            },
            onComplete: () => {
                modifyInferLoading.value = false
                modifyInferAbort = null
            },
            onError: (error: Error) => {
                console.error('修改模式推理失败:', error)
                modifyInferResult.value += `\n\n[${store.locales === 'zh' ? '错误' : 'Error'}: ${error.message}]`
                modifyInferLoading.value = false
                modifyInferAbort = null
            }
        })
    } catch (error) {
        console.error('runModifyInfer error:', error)
        modifyInferLoading.value = false
    }
}

const copyModifyInfer = () => {
    if (modifyInferResult.value) {
        navigator.clipboard.writeText(modifyInferResult.value)
    }
}

const clearModifyInfer = () => {
    modifyInferResult.value = ''
    if (modifyInferAbort) {
        modifyInferAbort.abort()
        modifyInferAbort = null
    }
    modifyInferLoading.value = false
}

/** 复制修改后的文本 */
const copyModifyResult = () => {
    if (modifyResult.value) {
        navigator.clipboard.writeText(modifyResult.value)
    }
}

/** 修改模式下回车：触发修改 */
const handleCustomPromptEnter = () => {
    if (modifyMode.value) {
        if (!modifyLoading.value && customPromptText.value.trim()) triggerModify()
    } else {
        submitCustomPrompt()
    }
}

const modifyDiffStats = computed(() => {
    let added = 0
    let removed = 0
    for (const op of modifyDiffOps.value) {
        if (op.type === 'add') added += op.lines.length
        else if (op.type === 'delete') removed += op.lines.length
    }
    return { added, removed }
})

const modifyHasDiff = computed(() => modifyDiffStats.value.added > 0 || modifyDiffStats.value.removed > 0)

// ---- diff 渲染行构建 ----
interface DiffRow {
    kind: 'context' | 'del' | 'add' | 'mod'
    oldLine: number | null
    newLine: number | null
    oldHtml: string
    newHtml: string
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escLine = (s: string): string => escapeHtml(s).replace(/ /g, '&nbsp;')

/** 字符级行内高亮（原始行 / 修改行） */
const diffCharsToHtml = (oldLine: string, newLine: string): { oldHtml: string; newHtml: string } => {
    const ops = diffChars(oldLine, newLine)
    let oldHtml = ''
    let newHtml = ''
    for (const op of ops) {
        if (op.type === 'equal') {
            oldHtml += escLine(op.lines.join(''))
            newHtml += escLine(op.lines.join(''))
        } else if (op.type === 'delete') {
            oldHtml += `<span class="diff-char-del">${escLine(op.lines.join(''))}</span>`
        } else {
            newHtml += `<span class="diff-char-add">${escLine(op.lines.join(''))}</span>`
        }
    }
    return { oldHtml, newHtml }
}

const modifyDiffRows = computed<DiffRow[]>(() => {
    const ops = modifyDiffOps.value
    const rows: DiffRow[] = []
    let oldLine = 1
    let newLine = 1
    let i = 0
    while (i < ops.length) {
        const op = ops[i]
        if (op.type === 'equal') {
            for (const line of op.lines) {
                rows.push({ kind: 'context', oldLine, newLine, oldHtml: escLine(line), newHtml: escLine(line) })
                oldLine++
                newLine++
            }
            i++
        } else if (op.type === 'delete') {
            const next = ops[i + 1]
            if (next && next.type === 'add') {
                const delLines = op.lines
                const addLines = next.lines
                const pairCount = Math.min(delLines.length, addLines.length)
                for (let p = 0; p < pairCount; p++) {
                    const { oldHtml, newHtml } = diffCharsToHtml(delLines[p], addLines[p])
                    rows.push({ kind: 'mod', oldLine, newLine, oldHtml, newHtml })
                    oldLine++
                    newLine++
                }
                for (let p = pairCount; p < delLines.length; p++) {
                    rows.push({ kind: 'del', oldLine, newLine: null, oldHtml: escLine(delLines[p]), newHtml: '' })
                    oldLine++
                }
                for (let p = pairCount; p < addLines.length; p++) {
                    rows.push({ kind: 'add', oldLine: null, newLine, oldHtml: '', newHtml: escLine(addLines[p]) })
                    newLine++
                }
                i += 2
            } else {
                for (const line of op.lines) {
                    rows.push({ kind: 'del', oldLine, newLine: null, oldHtml: escLine(line), newHtml: '' })
                    oldLine++
                }
                i++
            }
        } else {
            for (const line of op.lines) {
                rows.push({ kind: 'add', oldLine: null, newLine, oldHtml: '', newHtml: escLine(line) })
                newLine++
            }
            i++
        }
    }
    return rows
})

const modifyRowClass = (row: DiffRow) => {
    if (row.kind === 'context') return 'diff-row-context'
    if (row.kind === 'del') return 'diff-row-del'
    if (row.kind === 'add') return 'diff-row-add'
    return 'diff-row-mod'
}

// Markdown 渲染器（用于自定义推理结果）
const mdEscapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const customMd = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str: any, lang: any) {
        if (lang && hljs.getLanguage(lang)) {
            try {
                const highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
                return `<pre class="hljs scoll" data-lang="${mdEscapeHtml(lang)}"><code>${highlighted}</code></pre>`
            } catch (__) { }
        }
        return '<pre class="hljs"><code>' + mdEscapeHtml(str) + '</code></pre>'
    }
})

const renderedCustomResult = computed(() => {
    return customPromptResult.value ? customMd.render(customPromptResult.value) : ''
})

const getSelectedText = (): { text: string, range: monaco.Selection | null } => {
    if (!editor) return { text: '', range: null }
    const selection = editor.getSelection()
    if (!selection) return { text: '', range: null }
    const model = editor.getModel()
    if (!model) return { text: '', range: null }
    const text = model.getValueInRange(selection)
    return { text, range: selection }
}

// 支持的文件类型说明：
// 代码编辑器对任意文件开放（未识别/未知扩展名兜底为纯文本编辑，不再提示「不支持的文件类型」）；
// 语法高亮由 languageMap（下方）按扩展名匹配，未命中回退 plaintext。

// 主题映射
const themeMap = {
    '深色': 'hc-black',
    '灰色': 'vs-dark',
    '浅色': 'vs'
} as const

const getThemeFromUI = (): string => {
    const uiTheme = store.UI.theme
    const mappedTheme = themeMap[uiTheme as keyof typeof themeMap]
    if (mappedTheme) {
        return mappedTheme
    }

    const bg = store.UI.backgroundColor || ''
    const hex = String(bg).trim()
    const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/i.exec(hex)
    if (match) {
        let value = match[1]
        if (value.length === 3) {
            value = value.split('').map((c) => c + c).join('')
        }
        const r = parseInt(value.slice(0, 2), 16)
        const g = parseInt(value.slice(2, 4), 16)
        const b = parseInt(value.slice(4, 6), 16)
        const brightness = (r * 299 + g * 587 + b * 114) / 1000
        return brightness > 160 ? 'vs' : 'vs-dark'
    }

    return 'vs-dark'
}

// 语言映射
const languageMap: Record<string, string> = {
    '.md': 'markdown',
    '.html': 'html',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.css': 'css',
    '.py': 'python',
    '.json': 'json',
    '.txt': 'plaintext',
    '.lrc': 'plaintext',
    '.ini': 'ini',
    '.toml': 'ini',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.cfg': 'ini',
    '.conf': 'ini',
    '.properties': 'ini',
    '.xml': 'xml',
    '.jsx': 'javascript',
    '.tsx': 'typescript',
    '.vue': 'html',
    '.scss': 'scss',
    '.less': 'less',
    '.sass': 'scss',
    '.java': 'java',
    '.c': 'c',
    '.h': 'cpp',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.sh': 'shell',
    '.bat': 'bat',
    '.cmd': 'bat',
    '.ps1': 'powershell',
    '.sql': 'sql',
    '.csv': 'plaintext',
    '.tsv': 'plaintext',
    '.log': 'plaintext',
    '.flow': 'json',
    '.kb': 'json',
    '.task': 'json',
    '.htm': 'html',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.svelte': 'html',
    '.astro': 'html',
    '.cc': 'cpp',
    '.hh': 'cpp',
    '.kts': 'kotlin',
    '.lua': 'lua',
    '.pl': 'perl',
    '.pm': 'perl',
    '.r': 'r',
    '.dart': 'dart',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.scala': 'scala',
    '.coffee': 'coffeescript',
    '.dockerfile': 'dockerfile',
    '.gradle': 'groovy',
    '.groovy': 'groovy',
    '.pug': 'pug',
    '.jade': 'pug',
    '.ejs': 'handlebars',
    '.hbs': 'handlebars',
    '.twig': 'twig',
    '.proto': 'protobuf',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    // 无对应 Monaco 语言 / 配置类 → 纯文本高亮
    '.f90': 'plaintext',
    '.f95': 'plaintext',
    '.erl': 'plaintext',
    '.makefile': 'plaintext',
    '.njk': 'plaintext',
    '.diff': 'plaintext',
    '.patch': 'plaintext',
    '.env': 'plaintext',
    '.gitignore': 'plaintext',
    '.gitattributes': 'plaintext',
    '.editorconfig': 'plaintext',
    '.eslintrc': 'plaintext',
    '.eslintignore': 'plaintext',
    '.prettierrc': 'plaintext',
    '.babelrc': 'plaintext',
    '.npmrc': 'plaintext',
    '.yarnrc': 'plaintext',
    '.dockerignore': 'plaintext',
    '.vimrc': 'plaintext',
    '.bashrc': 'plaintext',
    '.zshrc': 'plaintext',
    '.gitconfig': 'plaintext'
}

// 计算属性：是否显示编辑器
// 兜底：存在当前文件即允许编辑（未知/未列出扩展名按纯文本高亮），不再提示「不支持的文件类型」
const shouldShowEditor = computed(() => {
    const currentFile = store.data[store.index]
    return !!currentFile
})

// 获取文件内容
const getFile = (): string => {
    if (store.data.length > 0 && data.value) {
        return data.value.content || ''
    }
    return ''
}

// 检测语言（扩展名统一小写匹配；未命中回退纯文本）
const detectLanguage = (extension: string): string => {
    return languageMap[String(extension || '').toLowerCase()] || 'plaintext'
}

// 初始化编辑器
const initEditor = function () {
    if (!shouldShowEditor.value) {
        destroyEditor()
        return
    }
    
    data.value = store.data[store.index]
    
    // 确保DOM元素存在并且可见
    const container = document.getElementById('codeeditor')
    if (!container) {
        console.warn('编辑器容器未找到')
        return
    }
    
    // 如果容器有隐藏样式，确保它显示
    if (container.style.display === 'none') {
        container.style.display = 'block'
    }
    
    try {
        // 如果编辑器已经存在，先销毁
        if (editor) {
            destroyEditor()
        }
        
        // 初始化编辑器（大文件下自动降级影响性能的选项；先以空内容快速创建壳，避免同步 tokenize 阻塞首帧）
        const large = isLargeFile.value
        editorLoading.value = large
        editor = monaco.editor.create(container, {
            value: large ? '' : getFile(),
            language: detectLanguage(data.value.extension),
            theme: getThemeFromUI(),
            selectOnLineNumbers: true,
            roundedSelection: false,
            readOnly: false,
            cursorStyle: 'line',
            automaticLayout: true,
            glyphMargin: !large,
            useTabStops: false,
            fontSize: 16,
            quickSuggestionsDelay: 100,
            wordWrap: large ? 'off' : (wordWrapEnabled.value ? 'on' : 'off'),
            renderWhitespace: renderWhitespaceEnabled.value ? 'all' : 'none',
            minimap: {
                enabled: minimapEnabled.value && !large,
                renderCharacters: false,
                maxColumn: 80,
                scale: 1,
                showSlider: 'mouseover'
            },
            scrollBeyondLastLine: false,
            folding: true,
            lineNumbersMinChars: 3,
            formatOnPaste: !large,
            formatOnType: !large,
            renderLineHighlight: large ? 'none' : 'all',
            smoothScrolling: !large,
            largeFileOptimizations: true,
            stickyScroll: { enabled: !large },
            occurrencesHighlight: large ? 'off' : 'singleFile',
            selectionHighlight: !large,
            colorDecorators: !large,
            scrollbar: {
                vertical: 'visible',
                horizontal: 'visible',
                useShadows: false
            }
        })
        
        // 添加快捷命令面板
        editor.addAction({
            id: 'show-command-palette',
            label: 'Show Command Palette',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
            run: () => {
                editor!.trigger('keybinding', 'editor.action.quickCommand', null)
            }
        })
        
        // 添加快捷键保存操作
        editor.addAction({
            id: 'save-file',
            label: 'Save File',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
            run: () => {
                saveContent()
            }
        })

        // 记录初始内容快照（作为未保存状态的比对基准）
        const initModel = editor.getModel()
        savedContent = initModel?.getValue() || ''
        savedVersion = initModel?.getAlternativeVersionId() ?? 0
        
        // 大文件：空内容创建后异步填充，避免同步 tokenize 阻塞首帧；期间显示加载遮罩
        if (large && editor) {
            const model = editor.getModel()!
            const fill = () => {
                // 填充期间编辑器可能已被销毁/切换，安全退出
                if (!editor || editor.getModel() !== model) {
                    editorLoading.value = false
                    return
                }
                isUpdatingContent = true
                model.setValue(getFile())
                isUpdatingContent = false
                savedContent = model.getValue()
                savedVersion = model.getAlternativeVersionId()
                isDirty.value = false
                editorLoading.value = false
                updateStatusBar()
            }
            if ('requestIdleCallback' in window) {
                window.requestIdleCallback(fill, { timeout: 300 })
            } else {
                setTimeout(fill, 50)
            }
        }
        
        // 记录初始语言和字号
        currentLanguage.value = detectLanguage(data.value.extension)
        currentFontSize.value = 16
        
        // 移除右键菜单：使用 capture 阶段拦截 contextmenu 事件
        
        // 设置初始主题
        updateTheme()
        
        // 监听内容变化：与保存快照比对判断未保存状态，并刷新状态栏
        editor.onDidChangeModelContent(() => {
            // 协同会话中内容由 Yjs 驱动，跳过本地脏标记逻辑
            if (isCollabActive.value) {
                updateStatusBar()
                return
            }
            const model = editor?.getModel()
            // 大文件用版本号 O(1) 判断；小文件用内容比较以保留「撤销回保存内容」识别
            const contentEquals = model
                ? (isLargeFile.value ? model.getAlternativeVersionId() === savedVersion : model.getValue() === savedContent)
                : true
            if (contentEquals) {
                // 撤销/恢复回保存时的内容 → 取消未保存标记
                isDirty.value = false
            } else if (!isUpdatingContent) {
                isDirty.value = true
            }
            updateStatusBar()
        })

        // 内容变化 → 刷新目录（防抖，避免逐键扫全文）
        scheduleRefreshToc()
        
        // 监听光标位置变化，刷新状态栏
        editor.onDidChangeCursorPosition((e) => {
            statusLine.value = e.position.lineNumber
            statusColumn.value = e.position.column
        })
        
        

        // 监听选中区域变化，刷新选中字符数
        editor.onDidChangeCursorSelection(() => {
            updateStatusBar()
        })
        
        // 初始化状态栏
        updateStatusBar()
        // 初始化目录（Markdown 才有）+ 滚动联动
        refreshToc()
        editor.onDidScrollChange(() => onEditorScrollForToc())
        
        // 监听编辑器尺寸变化
        window.addEventListener('resize', handleResize)

        // 容器宽度变化（右侧面板 / 左侧目录开合）→ 太窄时自动收起目录
        if (typeof ResizeObserver !== 'undefined' && tocRootRef.value) {
            tocObserver = new ResizeObserver(() => {
                tocWrapWidth.value = tocRootRef.value?.clientWidth ?? Number.POSITIVE_INFINITY
            })
            tocObserver.observe(tocRootRef.value)
            tocWrapWidth.value = tocRootRef.value.clientWidth
        }
        
        // 监听拖放图片到编辑器（使用 capture 确保在 Monaco 内部处理前捕获）
        const editorContainer = document.getElementById('codeeditor')
        if (editorContainer) {
            editorContainer.addEventListener('drop', handleEditorDrop, true)
            editorContainer.addEventListener('dragover', handleEditorDragOver, true)
            editorContainer.addEventListener('contextmenu', showEditorContextMenu, true)
        }
        
        editorInitialized.value = true
        
    } catch (error) {
        console.error('编辑器初始化失败:', error)
        editorLoading.value = false
        editorInitialized.value = false
    }
}

// 处理窗口大小变化
const handleResize = () => {
    if (editor) {
        setTimeout(() => {
            editor?.layout()
        }, 100)
    }
}

// 重新初始化编辑器（用于从不支持的文件切换回来时）
const reinitEditor = () => {
    if (!shouldShowEditor.value) return
    
    // 使用 nextTick 确保DOM更新完成
    nextTick(() => {
        setTimeout(() => {
            initEditor()
        }, 50)
    })
}

// 保存内容（返回是否保存成功；供「关闭前未保存提示」等异步流程等待保存完成）
const saveContent = (): Promise<boolean> => {
    return new Promise((resolve) => {
        if (!editor || !data.value) return resolve(false)

        // 协同会话中：仅宿主可保存（写盘），其他成员提示并禁止
        if (isCollabActive.value) {
            if (!collab.isHost.value) {
                ElMessage.warning(store.locales === 'zh' ? '仅主机可保存，请请求主机保存' : 'Only the host can save')
                return resolve(false)
            }
            collab.save().then((ok) => {
                if (ok) {
                    ElMessage.success(store.locales === 'zh' ? '已同步保存到主机' : 'Saved (host)')
                } else {
                    ElMessage.warning(store.locales === 'zh' ? '保存请求失败' : 'Save request failed')
                }
                resolve(!!ok)
            })
            return
        }

        try {
            data.value.content = editor.getValue()
            
            if (data.value.path) {
                window.ipcRenderer.invoke('saveFile', data.value.path, data.value.content)
                    .then((success) => {
                        if (success) {
                            // 更新保存快照并清除未保存标记
                            savedContent = editor?.getModel()?.getValue() || ''
                            savedVersion = editor?.getModel()?.getAlternativeVersionId() ?? 0
                            isDirty.value = false
                            ElMessage.success(store.locales === 'zh' ? '保存成功' : 'Saved successfully')
                            console.log('文件保存成功')
                            // 通知其他窗口（独立窗口中的浏览/导图/演示等）刷新预览
                            window.ipcRenderer.invoke('notify-file-changed', { path: data.value.path, content: data.value.content }).catch(() => {})
                            resolve(true)
                        } else {
                            ElMessage.error(store.locales === 'zh' ? '保存失败' : 'Save failed')
                            console.warn('文件保存失败')
                            resolve(false)
                        }
                    })
                    .catch((error) => {
                        console.error('保存失败:', error)
                        ElMessage.error(store.locales === 'zh' ? '保存失败: ' + String(error) : 'Save failed: ' + String(error))
                        resolve(false)
                    })
            } else {
                resolve(false)
            }
        } catch (error) {
            console.error('保存内容时出错:', error)
            resolve(false)
        }
    })
}

// 更新主题
const updateTheme = () => {
    if (!editor) return

    const theme = getThemeFromUI()
    monaco.editor.setTheme(theme)
}

// 切换语言
const changeLanguage = (language: string) => {
    if (editor) {
        const model = editor.getModel()
        if (model) {
            monaco.editor.setModelLanguage(model, language)
            currentLanguage.value = language
        }
    }
}

// 自动切换语言
const autoChangeLanguage = () => {
    if (editor && data.value) {
        const language = detectLanguage(data.value.extension)
        changeLanguage(language)
    }
}

// 更新编辑器内容
const updateEditorContent = () => {
    // 协同会话中由 Yjs 驱动模型，禁止本地内容覆盖
    if (isCollabActive.value) return
    if (editor && data.value) {
        // 大文件状态变化时（如切换标签）同步升降级编辑器选项
        const large = isLargeFile.value
        editor.updateOptions({
            wordWrap: large ? 'off' : (wordWrapEnabled.value ? 'on' : 'off'),
            minimap: { enabled: minimapEnabled.value && !large },
            renderLineHighlight: large ? 'none' : 'all',
            smoothScrolling: !large,
            stickyScroll: { enabled: !large },
            occurrencesHighlight: large ? 'off' : 'singleFile',
            selectionHighlight: !large,
            formatOnPaste: !large,
            formatOnType: !large
        })

        const currentValue = editor.getValue()
        const newValue = data.value.content || ''
        
        // 只有当内容不同时才更新，避免光标位置丢失
        if (currentValue !== newValue) {
            // 保存光标位置
            const position = editor.getPosition()
            isUpdatingContent = true
            editor.setValue(newValue)
            isUpdatingContent = false
            
            // 恢复光标位置
            if (position) {
                editor.setPosition(position)
                editor.revealPositionInCenter(position)
            }
        }
        
        autoChangeLanguage()
    }
}

// 更改字体大小（范围限制 8~72，与状态栏 A-/A+ 按钮的禁用阈值一致）
const changeFont = (size: number) => {
    const clamped = Math.max(8, Math.min(72, Math.round(size)))
    if (editor) {
        editor.updateOptions({
            fontSize: clamped,
        })
        currentFontSize.value = clamped
    }
}

// 更改样式主题
const changeStyle = (theme: string) => {
    monaco.editor.setTheme(theme)
}

// 切换缩略图（minimap）显示
const toggleMinimap = () => {
    minimapEnabled.value = !minimapEnabled.value
    if (editor) {
        editor.updateOptions({ minimap: { enabled: minimapEnabled.value } })
    }
}

// 自动换行开关（默认开启）
const wordWrapEnabled = ref(true)
// 显示空白字符开关（默认关闭）
const renderWhitespaceEnabled = ref(false)
// 底部状态栏数据
const statusLine = ref(1)
const statusColumn = ref(1)
const statusSelected = ref(0)
const statusTotalLines = ref(1)
const statusFileSize = ref(0)

// 切换自动换行
const toggleWordWrap = () => {
    wordWrapEnabled.value = !wordWrapEnabled.value
    if (editor) {
        editor.updateOptions({ wordWrap: wordWrapEnabled.value ? 'on' : 'off' })
    }
}

// 切换显示空白字符
const toggleRenderWhitespace = () => {
    renderWhitespaceEnabled.value = !renderWhitespaceEnabled.value
    if (editor) {
        editor.updateOptions({ renderWhitespace: renderWhitespaceEnabled.value ? 'all' : 'none' })
    }
}

// 状态栏统计防抖定时器（字符数/选中数等 O(n) 统计不逐键计算）
let statusBarTimer: ReturnType<typeof setTimeout> | null = null

// 更新底部状态栏
const updateStatusBar = () => {
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const pos = editor.getPosition()
    if (pos) {
        statusLine.value = pos.lineNumber
        statusColumn.value = pos.column
    }
    statusTotalLines.value = model.getLineCount()
    // 字符数 / 选中字符数：防抖计算，避免大文件逐键 O(n) 开销
    if (statusBarTimer) clearTimeout(statusBarTimer)
    statusBarTimer = setTimeout(() => {
        statusBarTimer = null
        if (!editor || !editor.getModel()) return
        const m = editor.getModel()!
        statusFileSize.value = m.getValueLength()
        const sel = editor.getSelection()
        statusSelected.value = (sel && !sel.isEmpty()) ? m.getValueInRange(sel).length : 0
    }, 200)
}

// 分发保存事件
const dispatchsave = () => {
    saveContent()
}

// ===== 左侧目录（共享组件 DocTocPanel；只有 Markdown 且有标题时可用） =====
const TOC_KEY = 'edit-code-toc-open'
// 目录开合与其它视图共享：在任一处打开后，切到别的视图也会打开（见 lib/markdown/toc.ts）
const tocOpen = ref(loadDocTocOpen())
/** 显式开合（状态栏按钮 / 面板关闭按钮）：写回共享状态 */
const setTocOpen = (v: boolean) => { tocOpen.value = v; saveDocTocOpen(v) }
// 宽度与浏览/块编辑/PDF 共用同一个 key 与同一个初始值（见 lib/markdown/toc.ts）
const tocWidth = ref(loadDocTocWidth())
watch(tocWidth, (v) => saveDocTocWidth(v))

/** 只有 Markdown 文件才有「标题 → 目录」 */
const isMarkdown = computed(() => currentLanguage.value === 'markdown')
/** 源码里的标题（带行号，供跳转用） */
const tocHeadings = ref<Array<{ level: number; text: string; line: number }>>([])
/** 目录项（id = 下标 + 1，与 tocHeadings 对位） */
const tocItems = computed(() => flattenHeadingLevels(tocHeadings.value))
const tocActiveId = ref<number | null>(null)
const tocAvailable = computed(() => isMarkdown.value && tocItems.value.length > 0)

/** 容器太窄时自动收起（与块编辑视图一致） */
const tocRootRef = ref<HTMLElement | null>(null)
const tocWrapWidth = ref(Number.POSITIVE_INFINITY)
const tocUsable = computed(() => tocWrapWidth.value >= 420)
let tocObserver: ResizeObserver | null = null
let tocTimer: ReturnType<typeof setTimeout> | null = null
let tocScrollRaf = 0

/** 扫描源码中的标题（非 Markdown 直接清空） */
const refreshToc = () => {
    const model = editor?.getModel()
    if (!model || model.getLanguageId() !== 'markdown') {
        tocHeadings.value = []
        tocActiveId.value = null
        return
    }
    tocHeadings.value = extractMarkdownHeadings(model.getValue())
    if (tocActiveId.value && tocActiveId.value > tocHeadings.value.length) tocActiveId.value = null
    updateActiveHeading()
}
const scheduleRefreshToc = () => {
    if (tocTimer) clearTimeout(tocTimer)
    tocTimer = setTimeout(() => { tocTimer = null; refreshToc() }, 250)
}

/** 滚动联动：当前章节 = 视口顶部所在行之前的最后一个标题 */
const updateActiveHeading = () => {
    if (!editor || !tocHeadings.value.length) { tocActiveId.value = null; return }
    const top = editor.getVisibleRanges()[0]?.startLineNumber ?? 1
    let idx = -1
    for (let i = 0; i < tocHeadings.value.length; i++) {
        if (tocHeadings.value[i].line <= top) idx = i
        else break
    }
    tocActiveId.value = idx >= 0 ? idx + 1 : null
}
// 每帧最多算一次；Monaco 的 reveal 是带缓动的，必须在滚动事件结束后再算一次才不会停在上一个标题
const onEditorScrollForToc = () => {
    if (tocScrollRaf) return
    tocScrollRaf = requestAnimationFrame(() => { tocScrollRaf = 0; updateActiveHeading() })
}

/** 点目录：把标题滚到视口顶部（与浏览视图 block:'start' 一致），光标落到该行行首 */
const jumpToHeadingLine = (id: number) => {
    const h = tocHeadings.value[id - 1]
    if (!h || !editor) return
    // revealLineNearTop 在目标行已可见时不会滚动，这里直接按行高定位，保证标题贴顶
    editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(h.line)))
    editor.setSelection(new monaco.Selection(h.line, 1, h.line, 1))
    editor.focus()
    tocActiveId.value = id
}

const toggleToc = () => { setTocOpen(!tocOpen.value) }

/** 状态栏搜索按钮：与 Ctrl+F 完全一致（Monaco 内置查找框） */
const openFind = () => { editor?.getAction('actions.find')?.run() }

// 支持的图片扩展名
const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif']

// 拖放目标位置（由 dragover 实时更新）
let dropTargetPosition: monaco.Position | null = null

// 处理拖入悬浮（仅 Markdown 模式下拦截文件拖放）
const handleEditorDragOver = (e: DragEvent) => {
    // 非 Markdown 语言时交给 Monaco 默认处理
    if (editor?.getModel()?.getLanguageId() !== 'markdown') return

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer!.dropEffect = 'copy'

    // 实时记录鼠标在编辑器中的位置
    if (editor) {
        const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
        if (target?.position) {
            dropTargetPosition = target.position
        }
    }
}

// 转义 Markdown 链接路径中的特殊字符（含空格、括号时用 <> 包裹）
const escapeLinkPath = (path: string): string => {
    if (/[\s()]/.test(path)) {
        return `<${path}>`
    }
    return path
}

// 构造 Markdown 图片语法
const buildImageMarkdown = (filePath: string, displayName: string): string => {
    return `![${displayName}](${escapeLinkPath(filePath)})`
}

// 构造 Markdown 文件链接语法
const buildFileLinkMarkdown = (filePath: string, displayName: string): string => {
    // 如果是绝对路径（如 C:\path\file.pdf），转为 file:/// 格式
    if (filePath.includes(':\\') || filePath.startsWith('\\\\')) {
        const forwardPath = filePath.replace(/\\/g, '/')
        return `[${displayName}](${escapeLinkPath(`file:///${forwardPath}`)})`
    }
    // 相对路径
    return `[${displayName}](${escapeLinkPath(filePath)})`
}

// 处理拖入文件（仅 Markdown 模式下图片转 Markdown 图片，其他文件转 Markdown 链接）
const handleEditorDrop = async (e: DragEvent) => {
    if (!editor || !data.value) return
    // 非 Markdown 语言时交给 Monaco 默认处理
    if (editor.getModel()?.getLanguageId() !== 'markdown') return

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    // 只处理单个文件拖入
    const file = files[0]
    // Electron 中拖入的文件带有完整路径（file.path）
    const filePath = (file as any).path || file.name

    e.preventDefault()
    e.stopPropagation()

    // ★ 关键：在 await 之前立即捕获鼠标位置的编辑器坐标
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
    const dropPosition = target?.position || dropTargetPosition || editor.getPosition()
    dropTargetPosition = null
    if (!dropPosition) return

    // 检查是否为图片
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
    const isImage = imageExtensions.includes(ext)

    // 获取文件名（不含路径）
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'file'

    // 计算路径
    let linkPath = filePath
    if (data.value.path) {
        const relPath = await window.ipcRenderer.invoke('getRelativePath', data.value.path, filePath)
        if (relPath) {
            // 在同一级目录或子级目录时才使用相对路径（不以 ../ 开头）
            if (!relPath.startsWith('../')) {
                linkPath = relPath
            }
        }
    }

    // 构造 Markdown 文本
    const markdownText = isImage
        ? buildImageMarkdown(linkPath, fileName)
        : buildFileLinkMarkdown(linkPath, fileName)

    const position = dropPosition

    editor.pushUndoStop()
    editor.executeEdits('drop-file', [
        {
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: markdownText,
            forceMoveMarkers: true
        }
    ])
    editor.pushUndoStop()

    // 将光标移动到插入内容之后
    const newPosition = new monaco.Position(position.lineNumber, position.column + markdownText.length)
    editor.setPosition(newPosition)
    editor.focus()

    isDirty.value = true
}

// 销毁编辑器
const destroyEditor = () => {
    // 协同会话中销毁编辑器前先退出（销毁 Monaco 绑定，避免模型 dispose 崩溃）
    if (isCollabActive.value) {
        collab.destroy()
        showCollabPanel.value = false
    }
    if (editor) {
        // 语音锚点装饰绑定在本编辑器上，销毁前清理（防悬挂引用）
        if (asrAnchorDecor) { try { asrAnchorDecor.clear() } catch (e) { /* ignore */ } }
        asrAnchorDecor = null
        asrSessionActive = false
        asrAnchorPos = null
        asrAnchorModel = null
        try {
            // 移除事件监听器
            window.removeEventListener('resize', handleResize)
            
            // 移除事件监听器
            const editorContainer = document.getElementById('codeeditor')
            if (editorContainer) {
                editorContainer.removeEventListener('drop', handleEditorDrop, true)
                editorContainer.removeEventListener('dragover', handleEditorDragOver, true)
                editorContainer.removeEventListener('contextmenu', showEditorContextMenu, true)
            }
            
            // 移除添加的样式
            const style = document.getElementById('monaco-hide-default-menu-items')
            if (style) {
                style.remove()
            }
            
            // 销毁编辑器
            editor.getModel()?.dispose()
            editor.dispose()
        } catch (error) {
            console.warn('编辑器销毁时出现警告:', error)
        } finally {
            editor = null
            editorInitialized.value = false
            editorLoading.value = false
            if (statusBarTimer) {
                clearTimeout(statusBarTimer)
                statusBarTimer = null
            }
        }
    }
}

// 保存快捷键处理
const handleSave = (e: KeyboardEvent) => {
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        saveContent()
    }
}

// 监听当前文件变化
watch(() => store.data[store.index], async (newValue) => {
    // 切换文件时若在协同会话中，先安全退出（避免本地内容覆盖 Yjs 绑定）
    if (isCollabActive.value) {
        const wasHost = collab.isHost.value
        const rid = collab.roomId.value
        collab.leave()
        if (wasHost && rid && window.dsh?.collab) {
            window.dsh.collab.closeRoom(rid).catch(() => {})
        }
        showCollabPanel.value = false
    }
    // 切换文件时检查是否有未保存的修改
    if (isDirty.value && editor) {
        try {
            await ElMessageBox.confirm(
                store.locales === 'zh'
                    ? '当前文件有未保存的更改，是否保存？'
                    : 'Current file has unsaved changes. Save?',
                store.locales === 'zh' ? '提示' : 'Prompt',
                {
                    confirmButtonText: store.locales === 'zh' ? '保存' : 'Save',
                    cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
                    type: 'warning'
                }
            )
            saveContent()
        } catch {
            // 用户取消，不做保存
        }
        isDirty.value = false
    }

    data.value = newValue
    
    if (!shouldShowEditor.value) {
        // 不支持的文件类型，销毁编辑器
        destroyEditor()
        return
    }
    
    // 支持的文件类型
    if (!editor || !editorInitialized.value) {
        // 编辑器未初始化，重新初始化
        reinitEditor()
    } else {
        // 编辑器已存在，更新内容
        updateEditorContent()
    }
}, { immediate: true })

// 监听文件内容变化（从外部更新）
watch(() => data.value?.content, (newContent) => {
    if (editor && newContent !== undefined) {
        updateEditorContent()
    }
})

// 监听主题变化
watchEffect(() => {
    updateTheme()
})

// 监听 shouldShowEditor 变化
watch(shouldShowEditor, (newValue) => {
    if (newValue) {
        // 切换到支持的文件类型
        reinitEditor()
    } else {
        // 切换到不支持的文件类型
        destroyEditor()
    }
})

// 子菜单溢出检测：当子菜单超出视口时自动翻转展开方向
const handleSubmenuOverflow = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.has-submenu')
    if (!target) return
    const submenu = target.querySelector(':scope > .submenu') as HTMLElement
    if (!submenu) return

    requestAnimationFrame(() => {
        submenu.classList.remove('submenu-up', 'submenu-left')

        const rect = submenu.getBoundingClientRect()
        const viewportW = window.innerWidth
        const viewportH = window.innerHeight

        // 底部溢出 → 向上展开
        if (rect.bottom > viewportH) {
            submenu.classList.add('submenu-up')
        }
        // 右侧溢出 → 向左展开
        if (rect.right > viewportW) {
            submenu.classList.add('submenu-left')
        }
    })
}

// 组件挂载
onMounted(() => {
    // 延迟初始化以确保DOM完全渲染
    setTimeout(() => {
        if (shouldShowEditor.value) {
            initEditor()
        }
    }, 50)

    // 订阅协同服务状态（用于生成可复制的加入地址）
    if (window.dsh?.collab) {
        collabStatusUnsub = window.dsh.collab.onStatus((st: any) => {
            collabServerStatus.value = st
        })
    }
    
    window.addEventListener('keydown', handleSave)
    document.addEventListener('click', hideContextMenu)
    document.addEventListener('mouseover', handleSubmenuOverflow)
})

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0 })
const hasSelection = ref(false)
const contextMenuRef = ref<HTMLElement | null>(null)
const hideContextMenu = () => { contextMenu.value.visible = false }
const showEditorContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const sel = getSelectedText()
    hasSelection.value = !!sel.text
    contextMenu.value.visible = true
    contextMenu.value.x = e.clientX
    contextMenu.value.y = e.clientY

    // 测量菜单高度，空间不足时向上弹出
    nextTick(() => {
        const menu = contextMenuRef.value
        if (!menu) return
        const menuHeight = menu.offsetHeight
        const menuWidth = menu.offsetWidth
        const viewportH = window.innerHeight
        const viewportW = window.innerWidth
        const spaceBelow = viewportH - e.clientY
        const spaceAbove = e.clientY
        if (spaceBelow < menuHeight && spaceAbove > menuHeight) {
            contextMenu.value.y = e.clientY - menuHeight
        } else if (spaceBelow < menuHeight) {
            // 上下都不够，向上贴边
            contextMenu.value.y = Math.max(4, e.clientY - menuHeight)
        }
        // 水平溢出：右侧空间不足时向左展开（避免超出右边缘）
        const spaceRight = viewportW - e.clientX
        if (spaceRight < menuWidth) {
            // 左右空间都不足时向左贴边，避免超出左边缘
            contextMenu.value.x = Math.max(4, e.clientX - menuWidth)
        }
    })
}

// 复制选中文字
const copySelectedText = () => {
    const { text } = getSelectedText()
    if (text) {
        navigator.clipboard.writeText(text)
    }
}

// 粘贴
const pasteText = async () => {
    if (!editor) return
    try {
        const text = await navigator.clipboard.readText()
        editor.executeEdits('paste', [{ range: editor.getSelection()!, text, forceMoveMarkers: true }])
        editor.focus()
    } catch (e) {
        // 粘贴失败（权限不足等）
    }
}

// 当前字体大小
const currentFontSize = ref(16)
const currentLanguage = ref('markdown')

// ---- ASR 语音输入 ----
const asrManager = ref<ReturnType<typeof createASRManager> | null>(null)
const isASRRecording = ref(false)
const isASRProcessing = ref(false)
const asrErrorMessage = ref('')
const asrLivePreview = ref('') // funasr 流式：边说边看的实时文本
let asrErrorTimer: ReturnType<typeof setTimeout> | null = null

// ---- 语音会话锚点（代码编辑器目标）----
// 录音开始时把编辑器光标位置锁定为锚点；会话内每一句都连续插在锚点之后并推进。
// 锚点用 monaco 零长 decoration 做文本跟踪：即使你在锚点之前/之后增删文字、换行，
// 装饰 range 会随编辑自动前移/后移，落点始终准确（不依赖固定行/列）。
let asrSessionActive = false
let asrAnchorPos: { lineNumber: number; column: number } | null = null
let asrAnchorModel: monaco.editor.ITextModel | null = null
let asrAnchorDecor: monaco.editor.IEditorDecorationsCollection | null = null
const ANCHOR_STICKINESS = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges

/** 结束语音会话：清空锚点 */
const endASRSession = () => {
  asrSessionActive = false
  asrAnchorPos = null
  asrAnchorModel = null
  asrAnchorDecor?.clear()
  asrAnchorDecor = null
}

/** 初始化 ASR 管理器，成功返回管理器实例，失败返回 null */
const initASR = (): NonNullable<typeof asrManager.value> | null => {
  if (asrManager.value) return asrManager.value
  try {
    asrManager.value = createASRManager(store.AIconfig.asr, {
      onResult: (result: { text: string; isFinal: boolean }) => {
        if (result.isFinal) {
          asrLivePreview.value = ''
          if (result.text) insertSpeechResult(result.text)
        } else {
          // 流式 partial（funasr-online）：实时预览
          asrLivePreview.value = result.text
        }
      },
      onStatusChange: (status: string) => {
        if (status === 'idle') {
          isASRRecording.value = false
          isASRProcessing.value = false
          asrLivePreview.value = ''
          endASRSession()
        } else if (status === 'listening') {
          isASRRecording.value = true
          isASRProcessing.value = false
        } else if (status === 'processing') {
          isASRRecording.value = false
          isASRProcessing.value = true
        } else if (status === 'error') {
          isASRRecording.value = false
          isASRProcessing.value = false
          endASRSession()
        }
      },
      onError: (error: string) => {
        console.error('[ASR] 语音输入错误:', error)
        isASRRecording.value = false
        isASRProcessing.value = false
        endASRSession()
        asrErrorMessage.value = error
        if (asrErrorTimer) clearTimeout(asrErrorTimer)
        asrErrorTimer = setTimeout(() => { asrErrorMessage.value = '' }, 5000)
      }
    })
    return asrManager.value
  } catch (e) {
    console.warn('[ASR] 初始化失败:', e)
    return null
  }
}

/** 将文本插入到编辑器当前光标位置（语音会话内插在 decoration 跟踪的会话锚点，保证本段语音连续且落点精确） */
const insertTextAtCursor = (text: string) => {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return

  // 如果文本末尾没有空格/换行，补一个空格
  const suffix = text.endsWith(' ') || text.endsWith('\n') ? '' : ' '
  const insertText = text + suffix

  // 默认插入到当前光标位置（无语音锚点时）
  let range: monaco.Range = editor.getSelection() ?? new monaco.Range(1, 1, 1, 1)
  let anchorOk = false
  // 语音流式（funasr）会话中：锚点由 monaco decoration 文本跟踪维护——
  // 即使你在锚点之前增删文字（改字/换行/加行），装饰 range 已自动同步，这里直接取其最新位置覆盖插入点
  if (asrSessionActive && asrAnchorDecor && asrAnchorModel === model) {
    const r = asrAnchorDecor.getRange(0)
    if (r) {
      const line = Math.min(Math.max(r.startLineNumber, 1), model.getLineCount())
      const column = Math.min(Math.max(r.startColumn, 1), model.getLineMaxColumn(line))
      range = new monaco.Range(line, column, line, column)
      anchorOk = true
    }
  }
  if (!anchorOk && asrSessionActive) {
    endASRSession() // 锚点失效（如编辑器被重建）→ 收尾本段
  }

  editor.pushUndoStop()
  editor.executeEdits('asr-input', [
    { range, text: insertText, forceMoveMarkers: true }
  ])
  editor.pushUndoStop()

  // 把装饰锚点推进到本次插入文本之后（下一句紧接其后）
  if (anchorOk && asrSessionActive && asrAnchorDecor) {
    const parts = insertText.split('\n')
    const startLine = range.startLineNumber
    let nl: number
    let nc: number
    if (parts.length === 1) {
      nl = startLine
      nc = range.startColumn + parts[0].length
    } else {
      nl = startLine + parts.length - 1
      nc = parts[parts.length - 1].length + 1
    }
    const cl = Math.min(Math.max(nl, 1), model.getLineCount())
    const cc = Math.min(Math.max(nc, 1), model.getLineMaxColumn(cl))
    asrAnchorPos = { lineNumber: cl, column: cc }
    asrAnchorDecor.set([{
      range: new monaco.Range(cl, cc, cl, cc),
      options: { stickiness: ANCHOR_STICKINESS }
    }])
  }
  editor.focus()
}

// （语音输入固定用于代码编辑器；此前可在“自定义推理”框输入的目标切换已移除）

/** 锁定语音会话锚点 = 录音开始时编辑器光标位置（语音输入固定用于代码编辑器）。
 *  用零长 decoration 跟踪该文本间隙：之后你在其前后增删字符，monaco 会自动移动它 */
const lockASRAnchor = () => {
  if (editor && editor.getModel()) {
    const model = editor.getModel()
    const sel = editor.getSelection()
    const pos = sel ? sel.getStartPosition() : editor.getPosition()
    if (pos) {
      asrAnchorModel = model
      asrAnchorPos = { lineNumber: pos.lineNumber, column: pos.column }
      if (!asrAnchorDecor) asrAnchorDecor = editor.createDecorationsCollection([])
      asrAnchorDecor.set([{
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: { stickiness: ANCHOR_STICKINESS }
      }])
      asrSessionActive = true
      return
    }
  }
  endASRSession()
}

/** 语音识别文本固定插入代码编辑器（按需：语音输入仅用于编辑器，不进入自定义推理框） */
const insertSpeechResult = (text: string) => {
  insertTextAtCursor(text)
}

/** Markdown 常用元素定义 */
interface MarkdownSnippet {
  label: string
  icon: string
  insert: string
  selectAfter: number // 插入后选中前 n 个字符（0 表示不选中）
}

const markdownSnippets: MarkdownSnippet[] = [
  { label: '标题1',       icon: 'fa fa-header',         insert: '# ',                                selectAfter: 0 },
  { label: '标题2',       icon: 'fa fa-header',         insert: '## ',                               selectAfter: 0 },
  { label: '标题3',       icon: 'fa fa-header',         insert: '### ',                              selectAfter: 0 },
  { label: '粗体',        icon: 'fa fa-bold',           insert: '****',                              selectAfter: 2 },
  { label: '斜体',        icon: 'fa fa-italic',         insert: '**',                                selectAfter: 1 },
  { label: '删除线',      icon: 'fa fa-strikethrough',  insert: '~~~~',                              selectAfter: 2 },
  { label: '行内代码',    icon: 'fa fa-code',           insert: '``',                                selectAfter: 1 },
  { label: '分割线',      icon: 'fa fa-minus',          insert: '\n---\n',                           selectAfter: 0 },
  { label: '无序列表',    icon: 'fa fa-list-ul',        insert: '\n- ',                              selectAfter: 0 },
  { label: '有序列表',    icon: 'fa fa-list-ol',        insert: '\n1. ',                             selectAfter: 0 },
  { label: '任务列表',    icon: 'fa fa-check-square-o', insert: '\n- [ ] ',                          selectAfter: 0 },
  { label: '引用',        icon: 'fa fa-quote-right',    insert: '\n> ',                              selectAfter: 0 },
  { label: '代码块',      icon: 'fa fa-terminal',       insert: '\n```\n\n```\n',                    selectAfter: 4 },
  { label: '链接',        icon: 'fa fa-link',           insert: '[](url)',                           selectAfter: 1 },
  { label: '图片',        icon: 'fa fa-picture-o',      insert: '![](url)',                          selectAfter: 2 },
  { label: '表格',        icon: 'fa fa-table',          insert: '\n| 列1 | 列2 |\n| --- | --- |\n|  |  |\n', selectAfter: 0 },
  { label: '脚注',        icon: 'fa fa-asterisk',       insert: '[^1]',                              selectAfter: 0 },
]

/** 插入 Markdown 元素到编辑器光标位置 */
const insertMarkdownSnippet = (snippet: MarkdownSnippet) => {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return

  editor.pushUndoStop()
  editor.executeEdits('insert-md-snippet', [
    {
      range: editor.getSelection()!,
      text: snippet.insert,
      forceMoveMarkers: true
    }
  ])

  // 选中占位符区域
  if (snippet.selectAfter > 0) {
    const position = editor.getPosition()!
    const start = new monaco.Position(position.lineNumber, position.column - snippet.selectAfter)
    const end = new monaco.Position(position.lineNumber, position.column)
    editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column))
  }

  editor.pushUndoStop()
  editor.focus()
}

/** 切换语音录制 */
const toggleASR = () => {
  // 保持编辑器焦点：语音输入目标为编辑器，点击按钮不应让光标消失
  editor?.focus()
  if (!asrManager.value) {
    const mgr = initASR()
    if (!mgr) return
    // 预热音频采集图（不加载模型），让首次录音立即开始
    mgr.warmup?.().catch(() => {})
    // 首次初始化后延迟启动（等待回调注册）
    setTimeout(() => {
      lockASRAnchor()
      mgr.start()
    }, 100)
    return
  }
  if (isASRRecording.value) {
    isASRProcessing.value = true
    asrManager.value.stop().finally(() => {
      isASRProcessing.value = false
    })
  } else {
    // 开始新一轮录音：锁定当前光标为会话锚点（本段语音统一插在此处）
    lockASRAnchor()
    asrManager.value.start()
  }
}

/** ASR 按钮图标 */
const getASRIcon = () => {
  if (isASRProcessing.value) return 'fa fa-spinner fa-spin'
  if (isASRRecording.value) return 'fa fa-microphone fa-fade'
  return 'fa fa-microphone'
}

/** ASR 按钮提示 */
const getASRTitle = () => {
  if (isASRRecording.value)
    return store.locales === 'zh' ? '录音中，点击停止' : 'Recording, click to stop'
  if (isASRProcessing.value)
    return store.locales === 'zh' ? '处理中...' : 'Processing...'
  return store.locales === 'zh' ? '语音输入（麦克风权限需要 HTTPS 或 localhost）' : 'Voice Input'
}

// ---- ASR 语音输入结束 ----

// 组件卸载
onBeforeUnmount(async () => {
    collabUnmounting = true
    // 先退出协同会话（销毁 Monaco 绑定，避免模型被 dispose 时崩溃）
    if (isCollabActive.value) {
        const wasHost = collab.isHost.value
        const rid = collab.roomId.value
        collab.destroy()
        if (wasHost && rid && window.dsh?.collab) {
            await window.dsh.collab.closeRoom(rid).catch(() => {})
        }
    }
    if (collabStatusUnsub) {
        collabStatusUnsub()
        collabStatusUnsub = null
    }
    if (isDirty.value) {
        try {
            await ElMessageBox.confirm(
                store.locales === 'zh'
                    ? '有未保存的更改，是否保存？'
                    : 'There are unsaved changes. Save?',
                store.locales === 'zh' ? '提示' : 'Prompt',
                {
                    confirmButtonText: store.locales === 'zh' ? '保存' : 'Save',
                    cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
                    type: 'warning'
                }
            )
            saveContent()
        } catch {
            // 用户取消，不做保存
        }
    }
    destroyEditor()
    window.removeEventListener('keydown', handleSave)
    window.removeEventListener('resize', handleResize)
    document.removeEventListener('click', hideContextMenu)
    document.removeEventListener('mouseover', handleSubmenuOverflow)
    // 停止 ASR 语音识别
    if (asrManager.value) {
      if (isASRRecording.value) asrManager.value.abort()
      asrManager.value = null
    }
    endASRSession()
    if (asrErrorTimer) clearTimeout(asrErrorTimer)
    if (statusBarTimer) {
        clearTimeout(statusBarTimer)
        statusBarTimer = null
    }
    if (tocTimer) { clearTimeout(tocTimer); tocTimer = null }
    if (tocScrollRaf) { cancelAnimationFrame(tocScrollRaf); tocScrollRaf = 0 }
    tocObserver?.disconnect()
    tocObserver = null
})

// 暴露给父组件：独立窗口（FileWindow.vue）关闭前检查未保存状态 / 主动保存
defineExpose({
    hasUnsaved: () => isDirty.value,
    saveContent
})
</script>

<template>
    <div v-if="shouldShowEditor" ref="tocRootRef" class="editor" :class="{ 'asr-active': isASRRecording || isASRProcessing }" style="border-right:1px solid var(--borderColor)">
        <!-- 右键菜单 -->
        <div v-if="contextMenu.visible" ref="contextMenuRef" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @mouseleave="hideContextMenu" @click.stop>
            <div class="menu-item" v-if="hasSelection" @click="copySelectedText(); hideContextMenu()"><i class="fa fa-copy"></i> {{store.locales=='zh'?'复制':'Copy'}}</div>
            <div class="menu-item" @click="pasteText(); hideContextMenu()"><i class="fa fa-clipboard"></i> {{store.locales=='zh'?'粘贴':'Paste'}}</div>
            <div class="menu-divider"></div>
            <div class="menu-item has-submenu" v-if="currentLanguage==='markdown'">
                <i class="fa fa-plus-square-o"></i>
                <span style="flex:1">插入元素</span>
                <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                <ul class="submenu">
                    <li v-for="s in markdownSnippets" :key="s.label" @click="insertMarkdownSnippet(s); hideContextMenu()">
                        <i :class="s.icon"></i> {{ s.label }}
                    </li>
                </ul>
            </div>
            <div class="menu-item has-submenu">
                <i class="fa fa-th-large"></i>
                <span style="flex:1">布局</span>
                <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                <ul class="submenu">
                    <li style="height:1px;background:var(--borderColor);margin:4px 8px;padding:0;list-style:none;pointer-events:none"></li>
                    <li @click="toggleMinimap(); hideContextMenu()">
                        <i :class="minimapEnabled ? 'fa fa-check-square-o' : 'fa fa-square-o'"></i>
                        {{ store.locales=='zh'?'缩略图':'Minimap' }}
                    </li>
                    <li @click="toggleWordWrap(); hideContextMenu()">
                        <i :class="wordWrapEnabled ? 'fa fa-check-square-o' : 'fa fa-square-o'"></i>
                        {{ store.locales=='zh'?'自动换行':'Word Wrap' }}
                    </li>
                    <li @click="toggleRenderWhitespace(); hideContextMenu()">
                        <i :class="renderWhitespaceEnabled ? 'fa fa-check-square-o' : 'fa fa-square-o'"></i>
                        {{ store.locales=='zh'?'显示空白字符':'Whitespace' }}
                    </li>
                    <li class="has-submenu">
                        <i class="fa fa-adjust"></i>
                        <span style="flex:1">主题</span>
                        <span style="font-size:11px;color:var(--borderColor)">{{ store.UI.theme }}</span>
                        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                        <ul class="submenu">
                            <li @click="changeStyle('vs'); hideContextMenu()"><i class="fa fa-circle-o"></i> 浅色</li>
                            <li @click="changeStyle('vs-dark'); hideContextMenu()"><i class="fa fa-circle-o"></i> 深色</li>
                            <li @click="changeStyle('hc-black'); hideContextMenu()"><i class="fa fa-circle-o"></i> 黑色</li>
                        </ul>
                    </li>
                    <li class="has-submenu">
                        <i class="fa fa-language"></i>
                        <span style="flex:1">语言</span>
                        <span style="font-size:11px;color:var(--borderColor)">{{ currentLanguage }}</span>
                        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                        <ul class="submenu">
                            <li v-for="lang in ['markdown','html','javascript','typescript','python','css','json','plaintext']" :key="lang" @click="changeLanguage(lang); hideContextMenu()"><i class="fa fa-circle-o"></i> {{ lang }}</li>
                        </ul>
                    </li>
                    <li class="has-submenu">
                        <i class="fa fa-font"></i>
                        <span style="flex:1">字体大小</span>
                        <span style="font-size:11px;color:var(--borderColor)">{{ currentFontSize }}</span>
                        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                        <ul class="submenu">
                            <li v-for="size in [12,15,18,24,30]" :key="size" @click="changeFont(size); hideContextMenu()"><i class="fa fa-circle-o"></i> {{ size }}</li>
                        </ul>
                    </li>
                </ul>
            </div>
        </div>

        <!-- 自定义 AI 推理对话框（底部非模态面板，不遮挡编辑器，可继续滑动/选择文本） -->
        <div v-if="showCustomPrompt" class="custom-prompt-overlay">
            <div class="custom-prompt-dialog" :style="(modifyMode || customPromptLoading || customPromptResult) ? { width: effectivePromptWidth + 'px' } : {}">
                <!-- 可拖动左边界调整宽度 -->
                <div class="custom-prompt-resizer" @mousedown.prevent="startPromptResize" :title="store.locales=='zh'?'拖动调整宽度':'Drag to resize'"></div>
                <!-- 关闭按钮（任何模式可用，关闭对话框并保留数据） -->
                <button class="custom-prompt-close" v-if="modifyMode" @click="closeCustomPrompt" :title="store.locales=='zh'?'关闭':'Close'">×</button>
                <!-- 修改模式：diff 对比预览 -->
                <div v-if="modifyMode" class="custom-prompt-result scoll modify-result" :style="resultStyle">
                    <!-- Tab 标签：修改结果 / 推理结果 -->
                    <div class="modify-tabs">
                        <button :class="{ active: modifyActiveTab === 'diff' }" @click="modifyActiveTab = 'diff'">
                            <i class="fa fa-exchange"></i> {{ store.locales=='zh' ? '修改结果' : 'Modify' }}
                        </button>
                        <button :class="{ active: modifyActiveTab === 'infer' }" @click="modifyActiveTab = 'infer'">
                            <i class="fa fa-commenting-o"></i> {{ store.locales=='zh' ? '推理结果' : 'Inference' }}
                        </button>
                    </div>

                    <!-- Tab 1：修改结果（diff 对比） -->
                    <div v-if="modifyActiveTab === 'diff'" class="modify-body">
                        <div class="modify-diff-header">
                            <span class="modify-diff-title">
                                <i class="fa fa-exchange"></i>
                                {{ store.locales=='zh' ? '修改对比' : 'Modify Preview' }}
                            </span>
                            <span class="modify-diff-header-right">
                                <span class="modify-view-toggle">
                                    <button :class="{ active: modifyViewMode === 'preview' }" @click="modifyViewMode = 'preview'">
                                        <i class="fa fa-eye"></i> {{ store.locales=='zh'?'预览':'Preview' }}
                                    </button>
                                    <button :class="{ active: modifyViewMode === 'diff' }" @click="modifyViewMode = 'diff'">
                                        <i class="fa fa-columns"></i> {{ store.locales=='zh'?'对比':'Diff' }}
                                    </button>
                                </span>
                                <span class="modify-diff-stats">
                                    <span class="stat-add">+{{ modifyDiffStats.added }}</span>
                                    <span class="stat-del">-{{ modifyDiffStats.removed }}</span>
                                    <span v-if="modifyTargetInfo && modifyTargetInfo.hasSelection" class="modify-diff-scope">{{ store.locales=='zh' ? '（选中区域）' : '(selection)' }}</span>
                                    <span v-else class="modify-diff-scope">{{ store.locales=='zh' ? '（整个文档）' : '(document)' }}</span>
                                </span>
                            </span>
                        </div>
                        <div v-if="modifyLoading && modifyDiffOps.length === 0" class="custom-prompt-loading">
                            <i class="fa fa-spinner fa-spin fa-2x"></i>
                            <span>{{ store.locales=='zh' ? '修改中...' : 'Modifying...' }}</span>
                        </div>
                        <div v-else-if="modifyDiffOps.length === 0" class="custom-prompt-loading">
                            <span>{{ store.locales=='zh' ? '没有检测到差异' : 'No differences detected' }}</span>
                        </div>
                        <template v-else>
                            <!-- 渲染预览：原文 / 修改后 两栏（直接复用 block_md.vue 渲染） -->
                            <div v-if="modifyViewMode === 'preview'" class="modify-preview">
                                <div class="preview-pane">
                                    <div class="preview-pane-head">
                                        <span class="preview-pane-title"><i class="fa fa-file-text-o"></i> {{ store.locales=='zh' ? '原文' : 'Original' }}</span>
                                    </div>
                                    <div class="preview-pane-body scoll">
                                        <BlockMd :content="modifyTargetInfo ? modifyTargetInfo.targetText : ''" fontSize="14px" />
                                    </div>
                                </div>
                                <div class="preview-pane">
                                    <div class="preview-pane-head">
                                        <span class="preview-pane-title"><i class="fa fa-file-text-o"></i> {{ store.locales=='zh' ? '修改后' : 'Modified' }}</span>
                                    </div>
                                    <div class="preview-pane-body scoll">
                                        <BlockMd :content="modifyResult" fontSize="14px" />
                                    </div>
                                </div>
                            </div>
                            <!-- 逐行对比：原文 / 修改后 并排高亮 -->
                            <div v-else class="modify-diff-table scoll">
                                <div class="diff-row diff-row-head">
                                    <div class="diff-col diff-col-head-del">{{ store.locales=='zh' ? '原文' : 'Original' }}</div>
                                    <div class="diff-col diff-col-head-add">{{ store.locales=='zh' ? '修改后' : 'Modified' }}</div>
                                </div>
                                <div v-for="(row, idx) in modifyDiffRows" :key="idx" class="diff-row" :class="modifyRowClass(row)">
                                    <div class="diff-col">
                                        <span class="diff-line-num">{{ row.oldLine !== null ? row.oldLine : '' }}</span>
                                        <span class="diff-mark" :class="{ 'diff-mark-del': row.kind === 'del' || row.kind === 'mod' }">{{ row.oldLine !== null && (row.kind === 'del' || row.kind === 'mod') ? '-' : '' }}</span>
                                        <code class="diff-line-text" v-html="row.oldHtml"></code>
                                    </div>
                                    <div class="diff-col">
                                        <span class="diff-line-num">{{ row.newLine !== null ? row.newLine : '' }}</span>
                                        <span class="diff-mark" :class="{ 'diff-mark-add': row.kind === 'add' || row.kind === 'mod' }">{{ row.newLine !== null && (row.kind === 'add' || row.kind === 'mod') ? '+' : '' }}</span>
                                        <code class="diff-line-text" v-html="row.newHtml"></code>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>

                    <!-- Tab 2：推理结果（含修改结果上下文，便于对照评价） -->
                    <div v-else class="modify-body modify-infer-tab scoll">
                        <!-- 推理上下文（发送给 AI 的前后 MODIFY_CONTEXT_LINES 行，可折叠） -->
                        <div v-if="modifyTargetInfo && modifyTargetInfo.hasSelection" class="modify-context-panel">
                            <div class="modify-context-head" @click="showInferContext = !showInferContext">
                                <span class="modify-context-title"><i class="fa fa-eye"></i> {{ store.locales=='zh' ? ('推理上下文（前后 ' + MODIFY_CONTEXT_LINES + ' 行）') : 'Inference context' }}</span>
                                <i :class="showInferContext ? 'fa fa-chevron-down' : 'fa fa-chevron-right'"></i>
                            </div>
                            <div v-if="showInferContext" class="modify-context-body scoll">
                                <pre class="modify-context-pre">{{ modifyInferContextText }}</pre>
                            </div>
                        </div>
                        <!-- 修改结果上下文（可折叠） -->
                        <div v-if="modifyResult" class="modify-context-panel">
                            <div class="modify-context-head" @click="showModifyContextInInfer = !showModifyContextInInfer">
                                <span class="modify-context-title"><i class="fa fa-exchange"></i> {{ store.locales=='zh' ? '修改结果（上下文）' : 'Modified (context)' }}</span>
                                <i :class="showModifyContextInInfer ? 'fa fa-chevron-down' : 'fa fa-chevron-right'"></i>
                            </div>
                            <div v-if="showModifyContextInInfer" class="modify-context-body scoll">
                                <BlockMd :content="modifyResult" fontSize="14px" />
                            </div>
                        </div>
                        <!-- 推理输出 -->
                        <div v-if="modifyInferLoading && !modifyInferResult" class="custom-prompt-loading">
                            <i class="fa fa-spinner fa-spin fa-2x"></i>
                            <span>{{ store.locales=='zh' ? '推理中...' : 'Reasoning...' }}</span>
                        </div>
                        <div v-if="modifyInferResult" class="custom-prompt-rendered modify-infer-body" v-html="renderedModifyInfer"></div>
                    </div>
                </div>
                <!-- 结果区：Markdown 渲染，flex 撑满，底部输入区推上来 -->
                <div v-else-if="customPromptLoading || customPromptResult" class="custom-prompt-result scoll" ref="customPromptResultRef" :style="resultStyle">
                    <div v-if="customPromptLoading && !customPromptResult" class="custom-prompt-loading">
                        <i class="fa fa-spinner fa-spin fa-2x"></i>
                        <span>{{ store.locales=='zh'?'推理中...':'Reasoning...' }}</span>
                    </div>
                    <div v-if="customPromptResult && !customPromptShowSource" class="custom-prompt-rendered" v-html="renderedCustomResult"></div>
                    <div v-if="customPromptResult && customPromptShowSource" class="custom-prompt-source">
                        <pre><code>{{ customPromptResult }}</code></pre>
                    </div>
                </div>
                <!-- 空态占位：无任务时撑满上方，把输入区推到下方 -->
                <div v-else class="custom-prompt-empty">
                    <i class="fa fa-commenting-o"></i>
                    <span>{{ store.locales=='zh' ? '暂无推理任务' : 'No inference task yet' }}</span>
                </div>
                <!-- 输入区和按钮行（一行：左侧输入，右侧图标按钮） -->
                <div class="custom-prompt-bottom">
                    <textarea
                        v-model="customPromptText"
                        class="scoll"
                        rows="1"
                        :placeholder="modifyMode ? (store.locales=='zh'?'输入推理方向（将生成修改对比）...':'Enter a direction (modify preview)...') : (store.locales=='zh'?'输入任务...':'Enter a task...')"
                        @keydown.enter.exact.prevent="handleCustomPromptEnter"
                    ></textarea>
                    <div class="custom-prompt-actions">
                        <template v-if="modifyMode">
                            <template v-if="modifyActiveTab === 'diff'">
                                <button @click="runModifyInfer" :disabled="modifyInferLoading || !customPromptText.trim()" :title="store.locales=='zh'?'推理':'Reason'">
                                    <i class="fa fa-paper-plane-o"></i>
                                </button>
                                <button @click="triggerModify" :disabled="modifyLoading || !customPromptText.trim()" :title="store.locales=='zh'?'重新修改':'Redo'">
                                    <i class="fa fa-repeat"></i>
                                </button>
                                <button @click="acceptModify" :disabled="modifyLoading || !modifyHasDiff" :title="store.locales=='zh'?'接受':'Accept'">
                                    <i class="fa fa-check"></i>
                                </button>
                                <button v-if="modifyResult" @click="copyModifyResult" :title="store.locales=='zh'?'复制':'Copy'">
                                    <i class="fa fa-copy"></i>
                                </button>
                            </template>
                            <template v-else>
                                <button @click="runModifyInfer" :disabled="modifyInferLoading || !customPromptText.trim()" :title="store.locales=='zh'?'推理':'Reason'">
                                    <i class="fa fa-paper-plane-o"></i>
                                </button>
                                <button v-if="modifyInferResult" @click="copyModifyInfer" :title="store.locales=='zh'?'复制':'Copy'">
                                    <i class="fa fa-copy"></i>
                                </button>
                                <button v-if="modifyInferResult" @click="clearModifyInfer" :title="store.locales=='zh'?'清空':'Clear'">
                                    <i class="fa fa-trash-o"></i>
                                </button>
                            </template>
                        </template>
                        <template v-else>
                            <button @click="submitCustomPrompt" :disabled="customPromptLoading || !customPromptText.trim()" :title="store.locales=='zh'?'推理':'Submit'">
                                <i class="fa fa-paper-plane-o"></i>
                            </button>
                            <button @click="triggerModify" :disabled="customPromptLoading || !customPromptText.trim()" :title="store.locales=='zh'?'修改':'Modify'">
                                <i class="fa fa-pencil"></i>
                            </button>
                            <!-- 结果操作（有结果时显示）：复制/源码/保存/清空 -->
                            <template v-if="customPromptResult">
                                <button @click="copyCustomPromptResult" :title="store.locales=='zh'?'复制结果源码':'Copy result source'">
                                    <i class="fa fa-copy"></i>
                                </button>
                                <button @click="customPromptShowSource = !customPromptShowSource" :title="customPromptShowSource ? (store.locales=='zh'?'渲染':'Render') : (store.locales=='zh'?'源码':'Source')">
                                    <i :class="customPromptShowSource ? 'fa fa-eye' : 'fa fa-code'"></i>
                                </button>
                                <button @click="saveCustomPromptResult" :title="store.locales=='zh'?'保存到工作区':'Save to workspace'">
                                    <i class="fa fa-floppy-o"></i>
                                </button>
                                <button @click="clearCustomPromptResult" :title="store.locales=='zh'?'清空':'Clear'">
                                    <i class="fa fa-trash-o"></i>
                                </button>
                            </template>
                            <button @click="closeCustomPrompt" :title="store.locales=='zh'?'取消':'Cancel'">
                                <i class="fa fa-times"></i>
                            </button>
                        </template>
                    </div>
                </div>
            </div>
        </div>

        <!-- 左侧目录（共享组件，与浏览 / 块编辑一致）+ 编辑器 -->
        <div class="editor-main">
        <!-- 目录面板：非 Markdown 或没标题时不渲染（面板内部还会按开合与容器宽度决定是否显示） -->
        <DocTocPanel
            v-if="isMarkdown"
            :open="tocOpen"
            @update:open="setTocOpen"
            v-model:width="tocWidth"
            :items="tocItems"
            :active-id="tocActiveId"
            :usable="tocUsable"
            :min-width="DOC_TOC_MIN_WIDTH"
            :max-width="DOC_TOC_MAX_WIDTH"
            @select="jumpToHeadingLine"
        />
        <!-- 右侧推理面板打开时，编辑器右侧让出面板宽度，左右布局不遮挡内容 -->
        <div id="codeeditor" :style="showCustomPrompt ? { marginRight: effectivePromptWidth + 'px' } : {}">
            <!-- 大文件异步加载遮罩 -->
            <div v-if="editorLoading" class="editor-loading-mask">
                <i class="fa fa-spinner fa-spin fa-2x"></i>
                <span>{{ store.locales=='zh' ? '正在加载大文件…' : 'Loading large file…' }}</span>
            </div>
        </div>
        </div>
        <!-- 底部状态栏 -->
        <div class="editor-statusbar">
            <!-- 最左边：目录（仅 Markdown 且有标题时有意义）/ 搜索（与 Ctrl+F 同一个查找框） -->
            <button v-if="tocAvailable" class="statusbar-btn" :class="{ active: tocOpen }" @click="toggleToc" :title="store.locales=='zh' ? (tocOpen ? '关闭目录' : '打开目录') : (tocOpen ? 'Close TOC' : 'Open TOC')">
                <i class="fa fa-bars"></i>
            </button>
            <button v-if="isMarkdown" class="statusbar-btn" @click="openFind" :title="store.locales=='zh' ? '搜索 (Ctrl+F)' : 'Search (Ctrl+F)'">
                <i class="fa fa-search"></i>
            </button>
            <span v-if="isDirty" class="statusbar-item statusbar-dirty" :title="store.locales=='zh'?'有未保存的更改':'Unsaved changes'">
                <i class="fa fa-circle"></i> {{ store.locales=='zh'?'未保存':'Unsaved' }}
            </span>
            <span class="statusbar-item"><i class="fa fa-map-marker"></i> Ln {{ statusLine }}, Col {{ statusColumn }}</span>
            <span v-if="statusSelected" class="statusbar-item"><i class="fa fa-text-width"></i> {{ statusSelected }} {{ store.locales=='zh'?'已选':'sel' }}</span>
            <span class="statusbar-item"><i class="fa fa-bars"></i> {{ statusTotalLines }} {{ store.locales=='zh'?'行':'lines' }}</span>
            <span class="statusbar-item"><i class="fa fa-file-text-o"></i> {{ statusFileSize }} {{ store.locales=='zh'?'字符':'chars' }}</span>
            <!-- 字号调节：A- / A+（位于状态信息之后） -->
            <button class="statusbar-btn" @click="changeFont(currentFontSize - 1)" :disabled="currentFontSize <= 8" :title="store.locales=='zh'?'减小字号 (A-)':'Decrease font size (A-)'">
                <span class="statusbar-font-label">A-</span>
            </button>
            <button class="statusbar-btn" @click="changeFont(currentFontSize + 1)" :disabled="currentFontSize >= 72" :title="store.locales=='zh'?'增大字号 (A+)':'Increase font size (A+)'">
                <span class="statusbar-font-label">A+</span>
            </button>
            <span class="statusbar-spacer"></span>
            <button v-if="collabEnabled" class="statusbar-btn" :class="{ 'collab-active': isCollabActive }" @click="toggleCollabPanel" :title="isCollabActive ? (store.locales=='zh'?'协同会话进行中，点击查看':'Collab session active, click to view') : (store.locales=='zh'?'协同编辑':'Collaboration')">
                <i :class="collabIcon()"></i>
                <span v-if="isCollabActive && collab.members.value.length" class="collab-badge">{{ collab.members.value.length }}</span>
            </button>
            <button class="statusbar-btn" @click="dispatchsave()" :title="store.locales=='zh'?'保存 (Ctrl+S)':'Save (Ctrl+S)'">
                <i class="fa fa-floppy-o"></i>
            </button>
            <button class="statusbar-btn" :class="{ active: minimapEnabled }" @click="toggleMinimap()" :title="store.locales=='zh'?'缩略图':'Minimap'">
                <i class="fa fa-map"></i>
            </button>
            <button class="statusbar-btn" :class="{ active: wordWrapEnabled }" @click="toggleWordWrap()" :title="store.locales=='zh'?'自动换行':'Word Wrap'">
                <i class="fa fa-arrows-h"></i>
            </button>
            <button class="statusbar-btn" :class="{ active: renderWhitespaceEnabled }" @click="toggleRenderWhitespace()" :title="store.locales=='zh'?'显示空白字符':'Whitespace'">
                <i class="fa fa-ellipsis-h"></i>
            </button>
            <button class="statusbar-btn" @mousedown.prevent @click.stop="triggerCustomPrompt()" :title="store.locales=='zh'?'自定义推理':'Custom Prompt'">
                <i class="fa fa-magic"></i>
            </button>
            <button class="statusbar-btn" :class="{ active: isASRRecording || isASRProcessing, 'asr-active': isASRRecording || isASRProcessing }" @mousedown.prevent @click="toggleASR()" :title="getASRTitle()">
                <i :class="getASRIcon()"></i>
            </button>
            <span class="statusbar-item statusbar-lang"><i class="fa fa-code"></i> {{ currentLanguage }}</span>
        </div>

        <!-- 协同编辑面板 -->
        <div v-if="collabEnabled && showCollabPanel" class="collab-panel" @click.stop>
            <div class="collab-panel-head">
                <span><i class="fa fa-users"></i> {{ store.locales=='zh'?'协同编辑':'Collaboration' }}</span>
                <button class="collab-close" @click="showCollabPanel = false" :title="store.locales=='zh'?'关闭':'Close'">×</button>
            </div>

            <!-- 未连接：共享 / 加入 -->
            <template v-if="!isCollabActive">
                <button class="collab-primary-btn" @click="shareCurrentFile">
                    <i class="fa fa-share-alt"></i> {{ store.locales=='zh'?'共享此文件':'Share this file' }}
                </button>
                <div class="collab-tip">{{ store.locales=='zh'?'创建协同房间，复制加入地址给其他成员或加入会话':'Create a room and share the join link or join a session' }}</div>
                <div class="collab-field">
                    <label>{{ store.locales=='zh'?'加入地址':'Join URL' }}</label>
                    <input v-model="collabJoinUrl" :placeholder="store.locales=='zh'?'ws://ip:端口/collab/房间号?token=…':'ws://ip:port/collab/room?token=…'"/>
                </div>
                <div class="collab-field">
                    <label>{{ store.locales=='zh'?'昵称':'Name' }}</label>
                    <input v-model="collabJoinName" :placeholder="store.locales=='zh'?'显示给其他成员':'Shown to others'"/>
                </div>
                <button class="collab-primary-btn" @click="joinCollabSession">
                    <i class="fa fa-sign-in"></i> {{ store.locales=='zh'?'加入会话':'Join' }}
                </button>
            </template>

            <!-- 会话中 -->
            <template v-else>
                <div class="collab-status-row">
                    <span class="collab-status-dot" :class="{ on: collab.status.value === 'connected' }"></span>
                    <span>{{ collab.status.value === 'connecting' ? (store.locales=='zh'?'连接中…':'Connecting…') : (store.locales=='zh'?'已连接':'Connected') }}</span>
                    <span v-if="isCollabActive" class="collab-role">
                        {{ collab.isHost.value ? (store.locales=='zh'?'主机':'Host') : (collab.canEdit.value ? (store.locales=='zh'?'可编辑':'Editor') : (store.locales=='zh'?'只读':'Reader')) }}
                    </span>
                </div>

                <!-- 宿主：可复制的加入地址 -->
                <div v-if="collab.isHost.value && collabJoinLink" class="collab-field">
                    <label>{{ store.locales=='zh'?'加入地址':'Join URL' }}</label>
                    <div class="collab-link-row">
                        <code class="collab-link">{{ collabJoinLink }}</code>
                        <button class="collab-mini-btn" @click="copyCollabLink" :title="store.locales=='zh'?'复制':'Copy'"><i class="fa fa-copy"></i></button>
                    </div>
                </div>

                <!-- 成员列表 -->
                <div class="collab-members">
                    <div class="collab-members-title">{{ store.locales=='zh'?('成员 (' + collab.members.value.length + ')') : ('Members (' + collab.members.value.length + ')') }}</div>
                    <div v-for="m in collab.members.value" :key="m.id" class="collab-member">
                        <span class="collab-color" :style="{ backgroundColor: m.color }"></span>
                        <span class="collab-member-name">{{ m.name }}</span>
                        <span class="collab-member-role">{{ m.role === 'host' ? (store.locales=='zh'?'主机':'Host') : (m.role === 'editor' ? (store.locales=='zh'?'编辑':'Ed') : (store.locales=='zh'?'只读':'R')) }}</span>
                    </div>
                </div>

                <!-- 宿主：待批准的编辑请求 -->
                <div v-if="collab.isHost.value && collab.pendingEditRequests.value.length" class="collab-requests">
                    <div class="collab-members-title">{{ store.locales=='zh'?'编辑请求':'Edit requests' }}</div>
                    <div v-for="r in collab.pendingEditRequests.value" :key="r.id" class="collab-member">
                        <span class="collab-color" :style="{ backgroundColor: r.color }"></span>
                        <span class="collab-member-name">{{ r.name }}</span>
                        <button class="collab-mini-btn ok" @click="respondEditRequest(r.id, true)" :title="store.locales=='zh'?'批准':'Approve'"><i class="fa fa-check"></i></button>
                        <button class="collab-mini-btn no" @click="respondEditRequest(r.id, false)" :title="store.locales=='zh'?'拒绝':'Deny'"><i class="fa fa-times"></i></button>
                    </div>
                </div>

                <!-- 只读成员：请求编辑权 -->
                <button v-if="!collab.canEdit.value && !collab.isHost.value" class="collab-primary-btn" @click="collab.requestEdit()">
                    <i class="fa fa-pencil"></i> {{ store.locales=='zh'?'请求编辑权':'Request edit' }}
                </button>

                <!-- 操作 -->
                <div class="collab-actions">
                    <button class="collab-mini-btn" @click="saveContent()" :title="store.locales=='zh'?'保存到主机':'Save to host'"><i class="fa fa-floppy-o"></i> {{ store.locales=='zh'?'保存':'Save' }}</button>
                    <button class="collab-mini-btn leave" @click="leaveCollabSession" :title="store.locales=='zh'?'退出会话':'Leave session'"><i class="fa fa-sign-out"></i> {{ store.locales=='zh'?'退出':'Leave' }}</button>
                </div>
            </template>
        </div>

        <!-- 语音波动条（底部居中，仅在录制/处理时出现） -->
        <div v-if="isASRRecording || isASRProcessing" class="asr-wave-wrap" @click="toggleASR" :title="getASRTitle()">
          <span v-for="i in 5" :key="i" class="asr-wave-dot" :style="{ animationDelay: (i * 0.15) + 's' }"></span>
          <div v-if="asrLivePreview" class="asr-wave-live" title="实时识别">{{ asrLivePreview }}</div>
          <div v-if="asrErrorMessage" class="asr-wave-err">
            <i class="fa fa-exclamation-triangle"></i> {{ asrErrorMessage }}
          </div>
        </div>
    </div>
    <div v-else class="unsupported-file">
        {{ store.locales === 'zh' ? '不支持的文件类型' : 'Unsupported file type' }}
    </div>
</template>

<style scoped>
.editor {
    position: relative;
    margin: 0px;
    width: 100%;
    height: 100%;
    flex: 2;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

/* 左侧目录 + 编辑器：横向 flex（目录在左，编辑区自适应剩余宽度） */
.editor-main {
    flex: 1;
    min-height: 0;
    display: flex;
    order: 1;
}

#codeeditor {
    position: relative;
    width: auto; /* 由 flex 撑满，并受右侧面板 margin 让位 */
    max-width: 100%;
    flex: 1;
    min-width: 0;
    min-height: 0;
    order: 1;
    outline: none;
    display: block !important;
}

/* 大文件异步加载遮罩 */
.editor-loading-mask {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--bgColor, #1e1e1e);
    color: var(--textColor, #c8c8c8);
    font-size: 14px;
}

/* 底部状态栏 */
.editor-statusbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    flex-shrink: 0;
    order: 3;
    padding: 0 10px;
    font-size: 12px;
    color: var(--fontColor);
    background-color: var(--menuColor);
    border-top: 1px solid var(--borderColor);
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    box-sizing: border-box;
}
.editor-statusbar .statusbar-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0.85;
}
.editor-statusbar .statusbar-item i {
    font-size: 11px;
    opacity: 0.7;
}
/* 未保存提示 */
.editor-statusbar .statusbar-dirty {
    color: #e6a23c;
}
.editor-statusbar .statusbar-dirty i {
    font-size: 10px;
}
.editor-statusbar .statusbar-spacer {
    flex: 1;
}
.editor-statusbar .statusbar-btn {
    margin: 0;
    padding: 0 6px;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0.85;
    transition: background-color 0.15s;
}
.editor-statusbar .statusbar-btn:hover {
    background-color: var(--menuActiveColor);
    opacity: 1;
}
.editor-statusbar .statusbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
}
.editor-statusbar .statusbar-btn:disabled:hover {
    background-color: transparent;
}
/* 字号加减按钮文本（左下角 A- / A+） */
.editor-statusbar .statusbar-font-label {
    font-weight: 600;
    font-size: 12px;
    letter-spacing: -0.5px;
}
.editor-statusbar .statusbar-btn.active {
    color: var(--fontActiveColor);
    opacity: 1;
}
.editor-statusbar .statusbar-btn.asr-active {
    color: #f56c6c;
}
.editor-statusbar .statusbar-btn.asr-active i {
    animation: asr-menu-fade 0.8s ease-in-out infinite alternate;
}
.editor-statusbar .statusbar-lang {
    text-transform: uppercase;
}
.unsupported-file {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--textColor);
    font-size: 14px;
    opacity: 0.7;
}

/* 三级菜单（如果存在） */
.menu li > ul > li > ul {
    left: 100%;
    top: 0;
    margin-left: 2px;
    margin-top: -4px;
}

/* 右键菜单样式统一在 explorer.vue 中定义 */

/* ── 语音波动条（悬浮最上层，底部显示） ── */
.asr-wave-wrap {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  cursor: pointer;
  background: color-mix(in srgb, var(--fontActiveColor) 14%, var(--backgroundColor));
  border: 1px solid var(--borderColor);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  user-select: none;
  animation: asr-wave-in 0.2s ease;
}
@keyframes asr-wave-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.asr-wave-dot {
  display: inline-block;
  width: 4px;
  border-radius: 2px;
  background: var(--fontActiveColor);
  animation: asr-dot-bounce 0.6s ease-in-out infinite alternate;
}
@keyframes asr-dot-bounce {
  0%   { height: 4px; }
  50%  { height: 16px; }
  100% { height: 4px; }
}

/* 实时识别文本（funasr 流式）——文字多时自动换行。
   width:max-content 让宽度按整段内容计算（短句窄、长句撑到上限才折行），
   避免 absolute 收缩布局把宽度塌成最窄可断行（每行一字） */
.asr-wave-live {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: min(70vw, 720px);
  background: rgba(0,0,0,.65);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  padding: 4px 12px;
  border-radius: 8px;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: left;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
  z-index: 5;
  pointer-events: none;
}

/* 错误气泡 */
.asr-wave-err {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 260px;
  background: #e74c3c;
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  padding: 4px 10px;
  border-radius: 6px;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  pointer-events: none;
  animation: asr-err-in 0.2s ease;
}
.asr-wave-err i { margin-right: 4px; font-size: 10px; }
@keyframes asr-err-in {
  from { opacity: 0; transform: translateX(-50%) translateY(4px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

/* 右键菜单中语音输入录制时高亮 */
.asr-menu-recording {
  color: var(--fontActiveColor) !important;
}
.asr-menu-recording i {
  animation: asr-menu-fade 0.8s ease-in-out infinite alternate;
}
@keyframes asr-menu-fade {
  from { opacity: 1; }
  to   { opacity: 0.3; }
}

/* ── 自定义 AI 推理面板（右侧边栏，内容在上、操作两行在下） ── */
.custom-prompt-overlay {
  order: 2;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 24px; /* 结束于底部状态栏之上，不覆盖状态栏（.editor-statusbar 高度 24px） */
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  pointer-events: none; /* 不遮挡编辑器，可继续滑动/选择文本 */
  z-index: 200;
}
.custom-prompt-dialog {
  position: relative;
  width: 360px; /* 默认宽度，可拖左边界调整 */
  height: 100%;
  background: var(--backgroundColor);
  border-left: 1px solid var(--borderColor);
  box-shadow: -6px 0 20px rgba(0,0,0,0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto; /* 面板本身可交互 */
}
/* 可拖动左边界调整宽度 */
.custom-prompt-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 30;
  background: transparent;
  transition: background-color 0.15s;
}
.custom-prompt-resizer:hover {
  background: var(--fontActiveColor);
  opacity: 0.5;
}
.custom-prompt-close {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 20;
  border: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 3px 9px;
  border-radius: 4px;
  opacity: 0.6;
}
.custom-prompt-close:hover {
  opacity: 1;
  background: var(--menuColor);
}

.custom-prompt-result {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 5px;
}

.custom-prompt-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--borderColor);
  text-align: center;
  font-size: 13px;
}
.custom-prompt-empty i {
  font-size: 28px;
  opacity: 0.6;
}

.custom-prompt-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 0;
  color: var(--borderColor);
  font-size: 13px;
}

.custom-prompt-rendered {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fontColor);
}
.custom-prompt-rendered pre,
.custom-prompt-rendered pre.hljs {
  background: var(--inputColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto;
}
.custom-prompt-rendered code {
  font-size: 13px;
}
.custom-prompt-rendered :deep(img) {
  max-width: 100%;
}
.custom-prompt-rendered table {
  border-collapse: collapse;
  width: 100%;
}
.custom-prompt-rendered th,
.custom-prompt-rendered td {
  border: 1px solid var(--borderColor);
  padding: 6px 10px;
  text-align: left;
}

.custom-prompt-source {
  font-size: 13px;
  line-height: 1.5;
  color: var(--fontColor);
}
.custom-prompt-source pre,
.custom-prompt-source pre.hljs {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--inputColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto;
}
.custom-prompt-source code {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
}

/* 操作区：第一行输入任务，第二行相关按钮 */
.custom-prompt-bottom {
  border-top: 1px solid var(--borderColor);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: color-mix(in srgb, var(--backgroundColor) 98%, var(--borderColor));
}

.custom-prompt-bottom textarea {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  max-height: 80px;
  padding: 6px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 13px;
  resize: vertical;
  outline: none;
  font-family: inherit;
}
.custom-prompt-bottom textarea:focus {
  border-color: var(--fontActiveColor);
}

.custom-prompt-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}
.custom-prompt-actions button {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 5px;
  border: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.custom-prompt-actions button:hover:not(:disabled) {
  background: var(--menuActiveColor);
}
.custom-prompt-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── AI 修改模式（diff 对比预览） ── */
.modify-diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--backgroundColor) 96%, transparent);
  font-size: 12px;
}
.modify-diff-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--fontColor);
}
.modify-diff-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.stat-add { color: #3fb950; font-weight: 600; }
.stat-del { color: #f85149; font-weight: 600; }
.modify-diff-scope {
  color: var(--borderColor);
  font-size: 11px;
}
.modify-diff-table {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  user-select: text;
}
.diff-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 30%, transparent);
}
.diff-row-head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--backgroundColor);
  font-weight: 600;
  border-bottom: 1px solid var(--borderColor);
}
.diff-col {
  display: flex;
  align-items: flex-start;
  padding: 0 4px;
  min-width: 0;
  overflow: hidden;
}
.diff-col-head-del { color: #f85149; }
.diff-col-head-add { color: #3fb950; }
.diff-line-num {
  flex: none;
  min-width: 30px;
  text-align: right;
  padding-right: 6px;
  color: var(--borderColor);
  font-size: 11px;
  user-select: none;
}
.diff-mark {
  flex: none;
  width: 14px;
  text-align: center;
  font-weight: 700;
  user-select: none;
}
.diff-mark-del { color: #f85149; }
.diff-mark-add { color: #3fb950; }
.diff-line-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: var(--fontColor);
  font-family: inherit;
}
/* 行背景（左=删除/原，右=新增/改） */
.diff-row-del .diff-col:first-child {
  background: rgba(248, 81, 73, 0.18);
}
.diff-row-add .diff-col:last-child {
  background: rgba(46, 160, 67, 0.18);
}
.diff-row-mod .diff-col:first-child {
  background: rgba(248, 81, 73, 0.18);
}
.diff-row-mod .diff-col:last-child {
  background: rgba(46, 160, 67, 0.18);
}
.diff-row-context .diff-line-text {
  color: color-mix(in srgb, var(--fontColor) 80%, transparent);
}
/* 字符级高亮 */
.diff-char-del {
  background: rgba(248, 81, 73, 0.45);
  border-radius: 2px;
}
.diff-char-add {
  background: rgba(46, 160, 67, 0.45);
  border-radius: 2px;
}

/* ── 预览 / 对比切换 ── */
.modify-result {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden; /* 取消容器滑块 */
}
.modify-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modify-diff-header-right {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.modify-view-toggle {
  display: inline-flex;
  gap: 4px;
}
.modify-view-toggle button {
  padding: 2px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.modify-view-toggle button.active {
  background: var(--primaryColor, #409eff);
  color: #fff;
  border-color: transparent;
}
.modify-diff-table {
  padding: 8px;
  box-sizing: border-box;
}
/* ── 预览模式：原文 / 修改后 两栏（源码/渲染切换） ── */
.modify-preview {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 6px;
  box-sizing: border-box;
}
.preview-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
  background: var(--backgroundColor);
}
.preview-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--backgroundColor) 96%, transparent);
  font-size: 12px;
}
.preview-pane-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--fontColor);
}
.preview-pane-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 6px;
}
/* ── 修改对比对话框内的 Tab 标签 ── */
.modify-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
  position: sticky;
  top: 0;
  background: var(--backgroundColor);
  z-index: 4;
  border-bottom: 1px solid var(--borderColor);
}
.modify-tabs button {
  padding: 5px 14px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  opacity: 0.7;
  margin-bottom: -1px;
}
.modify-tabs button:hover {
  opacity: 1;
}
.modify-tabs button.active {
  opacity: 1;
  font-weight: 600;
  background: color-mix(in srgb, var(--menuColor) 60%, transparent);
  border-color: var(--borderColor);
  color: var(--primaryColor, #409eff);
}
/* ── 推理结果 Tab ── */
.modify-infer-tab {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: block; /* 覆盖 .modify-body 的 flex，避免子元素被 flex 压缩成一条窄线 */
}
/* 修改结果上下文（可折叠） */
.modify-context-panel {
  flex-shrink: 0; /* 防止被 flex 压缩 */
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  margin-bottom: 8px;
  overflow: hidden;
}
.modify-context-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
  background: color-mix(in srgb, var(--menuColor) 50%, transparent);
  user-select: none;
}
.modify-context-head:hover {
  background: var(--menuActiveColor);
}
.modify-context-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--fontColor);
}
.modify-context-body {
  max-height: 240px;
  overflow: auto;
  padding: 6px 8px;
  border-top: 1px solid var(--borderColor);
}
.modify-context-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fontColor);
}
.modify-infer-body {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fontColor);
  padding: 6px;
  background: var(--inputColor);
  border-radius: 4px;
}

/* ---- 协同编辑 ---- */
.editor-statusbar .statusbar-btn.collab-active {
  color: #42b883;
  opacity: 1;
}
.collab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  margin-left: 3px;
  border-radius: 7px;
  background: #42b883;
  color: var(--fontColor);
  font-size: 10px;
  line-height: 14px;
}
.collab-panel {
  position: absolute;
  right: 5px;
  bottom: 29px;
  width: 276px;
  max-height: 72%;
  overflow-y: auto;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 8px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--fontColor);
}
.collab-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.collab-panel-head .collab-close {
  background: transparent;
  border: none;
  color: var(--fontColor);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  padding: 0 2px;
}
.collab-panel-head .collab-close:hover {
  opacity: 1;
}
.collab-primary-btn {
  width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--inputColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.collab-primary-btn:hover {
  background: var(--menuActiveColor);
}
.collab-tip {
  font-size: 10px;
  opacity: 0.7;
  line-height: 1.3;
}
.collab-field {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.collab-field label {
  font-size: 10px;
  opacity: 0.75;
  min-width: 48px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 0px
}
.collab-field input {
  flex: 1;
  min-width: 0;
  width: auto;
  box-sizing: border-box;
  padding: 2px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 12px;
  margin: 0px
}
.collab-link-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.collab-link {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  background: var(--inputColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 2px 5px;
}
.collab-status-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
.collab-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f56c6c;
  flex-shrink: 0;
}
.collab-status-dot.on {
  background: #42b883;
}
.collab-role {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.8;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  padding: 0 4px;
  white-space: nowrap;
}
.collab-members {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 130px;
  overflow-y: auto;
}
.collab-members-title {
  font-size: 10px;
  opacity: 0.7;
}
.collab-member {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 0;
}
.collab-color {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.collab-member-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.collab-member-role {
  font-size: 9px;
  opacity: 0.65;
}
.collab-requests {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px dashed var(--borderColor);
  padding-top: 5px;
}
.collab-actions {
  display: flex;
  gap: 6px;
  border-top: 1px dashed var(--borderColor);
  padding-top: 5px;
}
.collab-mini-btn {
  padding: 2px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--inputColor);
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.collab-mini-btn:hover {
  background: var(--menuActiveColor);
}
.collab-mini-btn.ok {
  color: #42b883;
}
.collab-mini-btn.no {
  color: #f56c6c;
}
.collab-mini-btn.leave {
  color: #e6a23c;
}
</style>