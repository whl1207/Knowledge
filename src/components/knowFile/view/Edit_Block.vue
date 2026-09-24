<script setup lang="ts">
import { onMounted, watch, onBeforeUnmount, ref, computed, nextTick } from 'vue'
import { usestore } from '@/store'
import { createASRManager } from '@/services/asr/manager'
import { ElMessage, ElMessageBox } from 'element-plus'
import BlockEditor from '@/components/knowFile/view/block/BlockEditor.vue'

const store = usestore()

/** 自研块编辑器组件实例 */
const beRef = ref<InstanceType<typeof BlockEditor> | null>(null)
/** 传给块编辑器的 Markdown（已剥离 YAML frontmatter） */
const editorValue = ref('')
/** 切换文件时自增，强制重建编辑器（清空撤销栈） */
const editorKey = ref(0)

/**
 * 编辑器对外接口：保持与旧库一致的调用形状，
 * 使本文件其余逻辑（保存 / 脏标记 / ASR / 右键菜单）几乎无需改动。
 */
interface EditorApi {
    getMarkdown: () => string
    setMarkdown: (md: string) => void
    focus: () => void
    destroy: () => void
    /** 在光标处插入纯文本（语音输入用） */
    insertTextAtCaret: (text: string) => void
}

const editor: EditorApi = {
    getMarkdown: () => beRef.value?.getText() ?? '',
    setMarkdown: (md: string) => beRef.value?.setText(md),
    focus: () => beRef.value?.focus(),
    destroy: () => { /* 生命周期由 v-if / key 管理，无需手动销毁 */ },
    insertTextAtCaret: (text: string) => beRef.value?.insertTextAtCaret(text),
}

// 编辑器是否已初始化
const editorInitialized = ref(false)
// 脏状态标记 — 是否有未保存的修改
const isDirty = ref(false)
// 编程式更新标记（避免将程序更新误认为用户修改）
let isUpdatingContent = false
// 编辑器加载时的原始内容快照，用于判断是否真有修改
let originalContentSnapshot = ''

// 当前数据引用
const data = ref(store.data[store.index])

// YAML frontmatter 缓存（编辑器不展示/不编辑这部分内容）
let yamlFrontmatter = ''

/** 提取 YAML frontmatter，返回正文内容 */
const stripYamlFrontmatter = (content: string): string => {
    const trimmed = content.trimStart()
    if (trimmed.startsWith('---')) {
        const endIndex = trimmed.indexOf('---', 3)
        if (endIndex !== -1) {
            yamlFrontmatter = trimmed.slice(0, endIndex + 3)
            return trimmed.slice(endIndex + 3).trimStart()
        }
    }
    yamlFrontmatter = ''
    return content
}

/** 将 YAML frontmatter 拼回正文前 */
const restoreYamlFrontmatter = (body: string): string => {
    if (yamlFrontmatter) {
        return yamlFrontmatter + '\n\n' + body.trimStart()
    }
    return body
}


// 支持的文件类型（块编辑器只用于 Markdown）
const editType = ref(['.md'])

// 计算属性：是否显示编辑器
const shouldShowEditor = computed(() => {
    const currentFile = store.data[store.index]
    return currentFile && editType.value.includes(currentFile.extension)
})

// 获取文件内容（剥离 YAML frontmatter）
const getFile = (): string => {
    if (store.data.length > 0 && data.value) {
        return stripYamlFrontmatter(data.value.content || '')
    }
    return ''
}

// 当前文件所在目录，用于把 Markdown 相对图片路径解析为本地绝对路径（与 md_read 一致）
const getMdBasePath = () => {
    const p = data.value?.path || ''
    if (!p) return ''
    const normalized = p.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash >= 0 ? normalized.substring(0, lastSlash + 1) : ''
}

// 初始化编辑器
const initEditor = function () {
    if (!shouldShowEditor.value) {
        destroyEditor()
        return
    }

    data.value = store.data[store.index]

    // 确保DOM元素存在
    const container = document.getElementById('block-editor-host')
    if (!container) {
        console.warn('块编辑器容器未找到')
        return
    }

    // 如果容器有隐藏样式，确保它显示
    if (container.style.display === 'none') {
        container.style.display = 'block'
    }

    try {
        // 初始化时抑制 onChange 误触脏标记
        isUpdatingContent = true
        const initialContent = getFile()

        // 把正文交给自研块编辑器，并强制重建（清掉上一个文件的撤销栈）
        editorValue.value = initialContent
        editorKey.value += 1

        // 记录原始内容快照
        originalContentSnapshot = initialContent

        // 初始化完成后恢复正常脏标记检测
        nextTick(() => {
            isUpdatingContent = false
            isDirty.value = false
        })

        editorInitialized.value = true

    } catch (error) {
        console.error('块编辑器初始化失败:', error)
        editorInitialized.value = false
    }
}

// 重新初始化编辑器
const reinitEditor = () => {
    if (!shouldShowEditor.value) return

    nextTick(() => {
        setTimeout(() => {
            initEditor()
        }, 50)
    })
}

// 保存内容（恢复 YAML frontmatter 后写入）
const saveContent = () => {
    if (!data.value) return
    // 编辑器还没挂载时 getText() 返回空串，直接保存会把文件清空
    if (shouldShowEditor.value && !beRef.value) {
        console.warn('块编辑器尚未就绪，跳过本次保存')
        return
    }

    try {
        const body = editor.getMarkdown()
        data.value.content = restoreYamlFrontmatter(body)

        // 保存成功后更新快照
        originalContentSnapshot = body

        if (data.value.path) {
            window.ipcRenderer.invoke('saveFile', data.value.path, data.value.content)
                .then((success: boolean) => {
                    if (success) {
                        isDirty.value = false
                        console.log('文件保存成功')
                        // 通知其他窗口（独立窗口中的浏览/导图/演示等）刷新预览
                        window.ipcRenderer.invoke('notify-file-changed', { path: data.value.path, content: data.value.content }).catch(() => {})
                    } else {
                        console.warn('文件保存失败')
                    }
                })
                .catch((error: any) => {
                    console.error('保存失败:', error)
                })
        }
    } catch (error) {
        console.error('保存内容时出错:', error)
    }
}

// 更新编辑器内容（剥离 YAML frontmatter）
const updateEditorContent = () => {
    if (editor && data.value) {
        const currentValue = editor.getMarkdown()
        const stripped = stripYamlFrontmatter(data.value.content || '')

        // 只有当内容不同时才更新
        if (currentValue !== stripped) {
            isUpdatingContent = true
            editor.setMarkdown(stripped)
            // setMarkdown 可能异步触发 onChange，延迟恢复标记
            nextTick(() => { isUpdatingContent = false })
        }

        // 更新快照为当前文件正文（用于脏检测对比）
        originalContentSnapshot = stripped
    }
}

// 分发保存事件
const dispatchsave = () => {
    saveContent()
}

// 支持的图片扩展名
const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif']

// 处理拖入悬浮
const handleEditorDragOver = (e: DragEvent) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer!.dropEffect = 'copy'
}

// 转义 Markdown 链接路径中的特殊字符
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
    if (filePath.includes(':\\') || filePath.startsWith('\\\\')) {
        const forwardPath = filePath.replace(/\\/g, '/')
        return `[${displayName}](${escapeLinkPath(`file:///${forwardPath}`)})`
    }
    return `[${displayName}](${escapeLinkPath(filePath)})`
}

// 处理拖入文件（由块编辑器组件转发，index = 拖放位置所在的块）
const onDropFiles = async (payload: { files: File[]; index: number }) => {
    if (!data.value || !payload?.files?.length) return

    const texts: string[] = []
    for (const file of payload.files) {
        const filePath = (file as any).path || file.name
        const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
        const isImage = imageExtensions.includes(ext)
        const fileName = filePath.replace(/\\/g, '/').split('/').pop() || 'file'

        let linkPath = filePath
        if (data.value.path) {
            const relPath = await window.ipcRenderer.invoke('getRelativePath', data.value.path, filePath)
            if (relPath && !relPath.startsWith('../')) {
                linkPath = relPath
            }
        }

        texts.push(isImage ? buildImageMarkdown(linkPath, fileName) : buildFileLinkMarkdown(linkPath, fileName))
    }

    beRef.value?.insertMarkdownAfter(payload.index, texts.join('\n\n'))
    isDirty.value = true
}

// 块编辑器内容变化 → 脏标记
const onEditorChange = () => {
    if (!isUpdatingContent) isDirty.value = true
}

// 销毁编辑器（自研块编辑器的生命周期由 v-if / key 管理）
const destroyEditor = () => {
    editorInitialized.value = false
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
    // 切换文件时检查是否有未保存的修改（仅当内容确实与快照不同时才提示）
    const hasRealChanges = editor && isDirty.value &&
        editor.getMarkdown() !== originalContentSnapshot
    if (hasRealChanges) {
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
        destroyEditor()
        return
    }

    if (!editorInitialized.value) {
        reinitEditor()
    } else {
        // 切换文件：重建编辑器（同时重置撤销栈，避免跨文件撤销）
        initEditor()
    }
}, { immediate: true })

// 监听文件内容变化（从外部更新）
watch(() => data.value?.content, (newContent) => {
    if (editor && newContent !== undefined) {
        updateEditorContent()
    }
})

// 监听主题变化
// （自研块编辑器直接使用项目 CSS 变量，无需额外同步）

// 监听 shouldShowEditor 变化
watch(shouldShowEditor, (newValue) => {
    if (newValue) {
        reinitEditor()
    } else {
        destroyEditor()
    }
})

// 子菜单溢出检测
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

        if (rect.bottom > viewportH) {
            submenu.classList.add('submenu-up')
        }
        if (rect.right > viewportW) {
            submenu.classList.add('submenu-left')
        }
    })
}

// 组件挂载
onMounted(() => {
    setTimeout(() => {
        if (shouldShowEditor.value) {
            initEditor()
        }
    }, 50)

    window.addEventListener('keydown', handleSave)
    document.addEventListener('click', hideContextMenu)
    document.addEventListener('mouseover', handleSubmenuOverflow)
})

// 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0 })
const hasSelection = ref(false)
const isDiagramContext = ref(false)
let diagramBlockId: string | null = null
const contextMenuRef = ref<HTMLElement | null>(null)
const hideContextMenu = () => { contextMenu.value.visible = false }
const showEditorContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    hasSelection.value = hasTextSelection()

    // 检测是否点击在 mermaid 图表块上
    const figure = (e.target as HTMLElement).closest('.be-block[data-diagram="1"]')
    isDiagramContext.value = !!figure
    diagramBlockId = figure?.getAttribute('data-id') ?? null

    contextMenu.value.visible = true
    contextMenu.value.x = e.clientX
    contextMenu.value.y = e.clientY

    nextTick(() => {
        const menu = contextMenuRef.value
        if (!menu) return
        const menuHeight = menu.offsetHeight
        const viewportH = window.innerHeight
        const spaceBelow = viewportH - e.clientY
        const spaceAbove = e.clientY
        if (spaceBelow < menuHeight && spaceAbove > menuHeight) {
            contextMenu.value.y = e.clientY - menuHeight
        } else if (spaceBelow < menuHeight) {
            contextMenu.value.y = Math.max(4, e.clientY - menuHeight)
        }
    })
}

/** 删除右键点击的图表块 */
const deleteDiagramBlock = () => {
    if (!diagramBlockId) return
    hideContextMenu()
    beRef.value?.removeBlockById(diagramBlockId)
    diagramBlockId = null
    isDirty.value = true
}

/** 当前是否有可复制的选区（块编辑器是 textarea，window.getSelection 取不到） */
const hasTextSelection = (): boolean => {
    const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        return (el.selectionEnd ?? 0) > (el.selectionStart ?? 0)
    }
    const selection = window.getSelection()
    return !!selection && !selection.isCollapsed
}

// 复制选中文字
const copySelectedText = () => {
    const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        const s = el.selectionStart ?? 0
        const e2 = el.selectionEnd ?? 0
        if (e2 > s) {
            navigator.clipboard.writeText(el.value.slice(s, e2))
            return
        }
    }
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) {
        navigator.clipboard.writeText(selection.toString())
    }
}

// 粘贴
const pasteText = async () => {
    try {
        const text = await navigator.clipboard.readText()
        if (!text) return
        beRef.value?.insertMarkdownAtCaret(text)
        editor.focus()
    } catch (e) {
        // 粘贴失败
    }
}

// ---- ASR 语音输入 ----
const asrManager = ref<ReturnType<typeof createASRManager> | null>(null)
const isASRRecording = ref(false)
const isASRProcessing = ref(false)
const asrErrorMessage = ref('')
const asrLivePreview = ref('') // funasr 流式：边说边看的实时文本
let asrErrorTimer: ReturnType<typeof setTimeout> | null = null

/** 初始化 ASR 管理器，成功返回管理器实例，失败返回 null */
const initASR = (): NonNullable<typeof asrManager.value> | null => {
    if (asrManager.value) return asrManager.value
    try {
        asrManager.value = createASRManager(store.AIconfig.asr, {
            onResult: (result: { text: string; isFinal: boolean }) => {
                if (result.isFinal) {
                    asrLivePreview.value = ''
                    if (!result.text) return
                    const suffix = result.text.endsWith(' ') || result.text.endsWith('\n') ? '' : ' '
                    // 插到当前光标处（不在编辑态则落在当前块末尾）
                    editor.insertTextAtCaret(result.text + suffix)
                    isDirty.value = true
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
                } else if (status === 'listening') {
                    isASRRecording.value = true
                    isASRProcessing.value = false
                } else if (status === 'processing') {
                    isASRRecording.value = false
                    isASRProcessing.value = true
                } else if (status === 'error') {
                    isASRRecording.value = false
                    isASRProcessing.value = false
                }
            },
            onError: (error: string) => {
                console.error('[ASR] 语音输入错误:', error)
                isASRRecording.value = false
                isASRProcessing.value = false
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

/** 切换语音录制 */
const toggleASR = () => {
    if (!asrManager.value) {
        const mgr = initASR()
        if (!mgr) return
        // 预热音频采集图（不加载模型），让首次录音立即开始
        mgr.warmup?.().catch(() => {})
        setTimeout(() => mgr.start(), 100)
        return
    }
    if (isASRRecording.value) {
        isASRProcessing.value = true
        asrManager.value.stop().finally(() => {
            isASRProcessing.value = false
        })
    } else {
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

/** 传给块编辑器状态栏按钮的显示状态（录音逻辑仍在本组件） */
const asrButton = computed(() => ({
    icon: getASRIcon(),
    title: getASRTitle(),
    active: isASRRecording.value,
    disabled: isASRProcessing.value,
}))

// ---- ASR 语音输入结束 ----

// Markdown 常用元素定义（用于右键菜单）
interface MarkdownSnippet {
    label: string
    icon: string
    insert: string
}

const markdownSnippets: MarkdownSnippet[] = [
    { label: '标题1', icon: 'fa fa-header', insert: '# ' },
    { label: '标题2', icon: 'fa fa-header', insert: '## ' },
    { label: '标题3', icon: 'fa fa-header', insert: '### ' },
    { label: '分割线', icon: 'fa fa-minus', insert: '\n---\n' },
    { label: '无序列表', icon: 'fa fa-list-ul', insert: '- ' },
    { label: '有序列表', icon: 'fa fa-list-ol', insert: '1. ' },
    { label: '任务列表', icon: 'fa fa-check-square-o', insert: '- [ ] ' },
    { label: '引用', icon: 'fa fa-quote-right', insert: '> ' },
    { label: '代码块', icon: 'fa fa-terminal', insert: '```\n\n```' },
    { label: '链接', icon: 'fa fa-link', insert: '[](url)' },
    { label: '图片', icon: 'fa fa-picture-o', insert: '![](url)' },
]

/** 插入 Markdown 元素到编辑器 */
const insertMarkdownSnippet = (snippet: MarkdownSnippet) => {
    beRef.value?.insertMarkdownAtCaret(snippet.insert)
    isDirty.value = true
}

// 组件卸载
onBeforeUnmount(async () => {
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
            // 用户取消
        }
    }
    destroyEditor()
    window.removeEventListener('keydown', handleSave)
    document.removeEventListener('click', hideContextMenu)
    document.removeEventListener('mouseover', handleSubmenuOverflow)
    if (asrManager.value) {
        if (isASRRecording.value) asrManager.value.abort()
        asrManager.value = null
    }
    if (asrErrorTimer) clearTimeout(asrErrorTimer)
})
</script>

<template>
    <div v-if="shouldShowEditor" class="block-editor" :class="{ 'asr-active': isASRRecording || isASRProcessing }" style="border-right:1px solid var(--borderColor)">
        <!-- 右键菜单 -->
        <div v-if="contextMenu.visible" ref="contextMenuRef" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @mouseleave="hideContextMenu" @click.stop>
            <div class="menu-item" v-if="hasSelection" @click="copySelectedText(); hideContextMenu()"><i class="fa fa-copy"></i> {{store.locales=='zh'?'复制':'Copy'}}</div>
            <div class="menu-item" @click="pasteText(); hideContextMenu()"><i class="fa fa-clipboard"></i> {{store.locales=='zh'?'粘贴':'Paste'}}</div>
            <div class="menu-divider"></div>
            <div class="menu-item" @click="dispatchsave(); hideContextMenu()">
                <i class="fa fa-floppy-o"></i> 保存
            </div>
            <div class="menu-divider" v-if="isDiagramContext"></div>
            <div class="menu-item" v-if="isDiagramContext" @click="deleteDiagramBlock()" style="color:#e74c3c">
                <i class="fa fa-trash-o"></i> {{store.locales=='zh'?'删除图表':'Delete Diagram'}}
            </div>
            <div class="menu-item has-submenu">
                <i class="fa fa-plus-square-o"></i>
                <span style="flex:1">插入元素</span>
                <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
                <ul class="submenu">
                    <li v-for="s in markdownSnippets" :key="s.label" @click="insertMarkdownSnippet(s); hideContextMenu()">
                        <i :class="s.icon"></i> {{ s.label }}
                    </li>
                </ul>
            </div>
        </div>

        <div
            id="block-editor-host"
            class="block-editor-host scoll"
            @contextmenu.prevent.stop="showEditorContextMenu"
            @dragover="handleEditorDragOver"
        >
            <BlockEditor
                v-if="shouldShowEditor && editorInitialized"
                :key="editorKey"
                ref="beRef"
                :value="editorValue"
                :dirty="isDirty"
                :base-path="getMdBasePath()"
                :placeholder="store.locales === 'zh' ? '开始写作...' : 'Start writing...'"
                :asr="asrButton"
                @change="onEditorChange"
                @save="saveContent"
                @asr-toggle="toggleASR"
                @drop-files="onDropFiles"
            />
        </div>
        <!-- 语音波动条 -->
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
.block-editor {
    position: relative;
    margin: 0px;
    width: 100%;
    height: 100%;
    flex: 2;
    overflow: hidden;
}

.block-editor-host {
    position: relative;
    width: 100%;
    max-width: 100%;
    height: 100%;
    outline: none;
    display: block !important;
    overflow-y: auto;
}

.block-editor.asr-active .block-editor-host {
    padding-bottom: 50px;
}

/* 自研块编辑器直接使用项目 CSS 变量，这里只需保证铺满容器 */
.block-editor-host {
    display: block !important;
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

/* 三级菜单 */
.menu li > ul > li > ul {
    left: 100%;
    top: 0;
    margin-left: 2px;
    margin-top: -4px;
}

/* 语音波动条 */
.asr-wave-wrap {
    position: absolute;
    /* 抬到状态栏之上（状态栏高 24px） */
    bottom: 34px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 55;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 12px;
    border-radius: 14px;
    cursor: pointer;
    background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
    user-select: none;
    animation: asr-wave-in 0.2s ease;
    background-color: var(--menuColor);
}
@keyframes asr-wave-in {
    from { opacity: 0; transform: translateX(-50%) translateY(6px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.asr-wave-dot {
    display: inline-block;
    width: 3px;
    border-radius: 2px;
    background: var(--fontActiveColor);
    animation: asr-dot-bounce 0.6s ease-in-out infinite alternate;
}
@keyframes asr-dot-bounce {
    0%   { height: 4px; }
    50%  { height: 14px; }
    100% { height: 4px; }
}

/* 实时识别文本（funasr 流式） */
.asr-wave-live {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,.65);
  color: #fff;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 8px;
  white-space: nowrap;
  max-width: 70vw;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
  z-index: 5;
  pointer-events: none;
}

.asr-wave-err {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #e74c3c;
    color: #fff;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 6px;
    white-space: nowrap;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    pointer-events: none;
    animation: asr-err-in 0.2s ease;
}
.asr-wave-err i { margin-right: 4px; font-size: 10px; }
@keyframes asr-err-in {
    from { opacity: 0; transform: translateX(-50%) translateY(4px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

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

</style>
