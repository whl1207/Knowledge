/**
 * src/composables/useInstanceTaskFile.ts — 脚手架实例的「关联任务文件」通用逻辑
 *
 * 每个脚手架实例（AgentScaffold 导航栏中的一项）关联一个 .task 文件：
 *   · 新建实例**不预建文件**（2026-09-21 起）：实例先只存内存态，首次「保存」时弹对话框选择路径并回传登记；
 *   · 进入实例（激活）且该实例未在运行、且尚未加载过该文件时，自动读取并恢复状态；
 *   · 脚手架内的「保存任务状态」按钮：有关联文件时直接覆盖写（不再弹对话框），
 *     没有关联文件时退回旧行为（弹对话框），并把选中的路径回传宿主登记。
 *
 * 各脚手架只需提供 collect()（采集状态，不含 version/scaffold/savedAt）与 apply()（恢复状态）。
 */
import { onActivated, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { isEmptyTaskFile, wrapTaskFile } from '@/lib/taskFile'

export interface InstanceTaskFileOptions {
    /** 脚手架 key（写入任务文件的 scaffold 字段，供打开文件时识别归属） */
    scaffold: string
    /** 关联任务文件路径（宿主通过 prop 传入；空字符串 = 尚未关联） */
    filePath: () => string
    /** 实例 id（宿主通过 prop 传入；缺省时退回脚手架 key） */
    instanceId?: () => string
    /** 该实例是否正在运行（运行中的实例不自动加载，避免覆盖运行态） */
    isBusy: () => boolean
    /** 采集当前状态（不含 version/scaffold/savedAt）；返回字符串时直接写盘（供大状态自定义序列化） */
    collect: () => any | Promise<any>
    /** 应用状态（已解析的对象） */
    apply: (state: any) => void | Promise<void>
    /** 日志输出（可选） */
    log?: (level: 'info' | 'warning' | 'error', message: string) => void
    /** 脚手架内部对话框选中文件后回传路径，供宿主写入实例 meta */
    onLinkFile?: (path: string) => void
    /** 关联文件不可用（缺失/读取失败），供宿主导航栏标记 */
    onFileMissing?: (path: string) => void
    /** 保存成功回调（宿主可用于刷新导航栏状态） */
    onSaved?: (path: string) => void
}

export function useInstanceTaskFile(opts: InstanceTaskFileOptions) {
    const store = usestore()
    const zh = () => store.locales !== 'en'
    const log = (level: 'info' | 'warning' | 'error', message: string) => opts.log?.(level, message)

    /** 已从文件载入过的路径：切回实例（KeepAlive 激活）时不再重复加载，避免覆盖内存中的新状态 */
    let loadedPath = ''

    /** 采集状态 → JSON 文本（统一包装 version/scaffold/savedAt） */
    const buildJson = async (): Promise<string> => {
        const state = await opts.collect()
        // 返回字符串：视为完整文件内容（脚手架自定义序列化，已含 version/scaffold/savedAt，如批量执行的分批 stringify）
        if (typeof state === 'string') return state
        return JSON.stringify(wrapTaskFile(opts.scaffold, state as Record<string, any>), null, 2)
    }

    /** 解析文本 → 状态对象（空占位文件返回 null；脚手架不匹配时提示但继续尝试恢复） */
    const parseState = (text: string): any | null => {
        if (isEmptyTaskFile(text)) return null
        let state: any
        try {
            state = JSON.parse(text)
        } catch (e: any) {
            log('error', (zh() ? '文件解析失败: ' : 'Failed to parse file: ') + e.message)
            return null
        }
        if (state?.scaffold && state.scaffold !== opts.scaffold) {
            log('warning', zh()
                ? `该任务文件的类型为「${state.scaffold}」，与当前脚手架不一致，尝试按兼容方式恢复...`
                : `Task file belongs to "${state.scaffold}" (current: ${opts.scaffold}); trying best-effort restore...`)
        }
        return state
    }

    /** 从指定路径载入（宿主自动加载 / 打开 .task 跳转）；路径为空时为 null，返回是否成功应用 */
    const loadFromFile = async (path: string): Promise<boolean> => {
        loadedPath = path
        const res = await window.ipcRenderer.invoke('readTaskFile', path)
        if (!res || !res.success) {
            log('error', (zh() ? '读取失败: ' : 'Read failed: ') + (res?.error || (zh() ? '未知错误' : 'unknown error')) + ` (${path})`)
            opts.onFileMissing?.(path)
            return false
        }
        const state = parseState(res.content as string)
        if (!state) return false // 占位空文件：新建实例尚未保存过内容
        await opts.apply(state)
        return true
    }

    /** 保存到关联文件（path 为空则弹对话框，成功后回传路径给宿主登记） */
    const saveToFile = async (path?: string): Promise<boolean> => {
        const jsonStr = await buildJson()
        const target = path || opts.filePath()
        if (target) {
            const res = await window.ipcRenderer.invoke('writeTaskFile', target, jsonStr)
            if (!res || !res.success) {
                log('error', (zh() ? '保存失败: ' : 'Save failed: ') + (res?.error || '') + ` (${target})`)
                return false
            }
            log('info', (zh() ? '已保存到关联文件: ' : 'Saved to linked file: ') + target + ` (${(jsonStr.length / 1024).toFixed(0)}KB)`)
            opts.onSaved?.(target)
            return true
        }
        // 未关联文件（宿主外使用）：沿用旧的「另存为」对话框
        const res = await window.ipcRenderer.invoke('saveTaskFile', jsonStr)
        if (res?.success) {
            log('info', (zh() ? '任务状态已保存: ' : 'Task state saved: ') + res.path + ` (${(jsonStr.length / 1024).toFixed(0)}KB)`)
            opts.onLinkFile?.(res.path)
            opts.onSaved?.(res.path)
            return true
        }
        if (res?.error && res.error !== '用户取消') log('error', (zh() ? '保存失败: ' : 'Save failed: ') + res.error)
        return false
    }

    /** 旧入口：从对话框选择文件载入（无 path 参数时） */
    const loadTaskState = async (path?: string): Promise<boolean> => {
        if (path) return await loadFromFile(path)
        const res = await window.ipcRenderer.invoke('loadTaskFile')
        if (!res || !res.success) {
            if (res?.error && res.error !== '用户取消') log('error', (zh() ? '读取失败: ' : 'Read failed: ') + res.error)
            return false
        }
        const state = parseState(res.content as string)
        if (!state) return false
        await opts.apply(state)
        if (res.path) opts.onLinkFile?.(res.path)
        return true
    }

    /**
     * 保存任务状态：有关联文件直接覆盖，否则弹「另存为」。
     * 运行中保存前提示（保存的是当前内存状态，运行会继续）。
     */
    const saveTaskState = async (): Promise<boolean> => {
        if (opts.isBusy()) {
            try {
                await ElMessageBox.confirm(
                    zh() ? '该实例正在运行任务，保存的是当前已完成的状态快照（运行不会停止）。是否继续？'
                        : 'This instance is running. The saved snapshot is the current state (the run continues). Continue?',
                    zh() ? '提示' : 'Notice',
                    { confirmButtonText: zh() ? '继续保存' : 'Save', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' },
                )
            } catch { return false }
        }
        return await saveToFile()
    }

    /** 进入实例时自动加载（仅当：有关联文件 + 未在运行 + 尚未加载过该路径） */
    let autoLoadInFlight: { path: string; task: Promise<void> } | null = null
    const autoLoadFromLinkedFile = async () => {
        const path = opts.filePath()
        if (!path || loadedPath === path) return
        if (opts.isBusy()) return // 运行中的实例保持内存状态，不加载
        // ⚠ 首次挂载时 onMounted 与 onActivated 会连续触发两次；没有这个合并，
        //    两个流程会并发读同一文件并各自读取一次大表格（主进程解析缓存互相释放 → 报「缓存不存在」）
        if (autoLoadInFlight?.path === path) return await autoLoadInFlight.task
        const task = (async () => {
            const res = await window.ipcRenderer.invoke('readTaskFile', path, 262144)
            // 读不到文件（被移动/删除）：标记缺失，等用户重新定位
            if (!res || !res.success) {
                loadedPath = path
                opts.onFileMissing?.(path)
                return
            }
            // 占位空文件（新建实例）：无需恢复
            if (isEmptyTaskFile(res.content as string)) { loadedPath = path; return }
            await loadFromFile(path)
        })()
        autoLoadInFlight = { path, task }
        try {
            await task
        } finally {
            if (autoLoadInFlight?.task === task) autoLoadInFlight = null
        }
    }

    onMounted(() => { void autoLoadFromLinkedFile() })
    onActivated(() => { void autoLoadFromLinkedFile() })

    return { saveTaskState, saveToFile, loadTaskState, loadFromFile, autoLoadFromLinkedFile, hasLoadedFrom: (p: string) => loadedPath === p }
}
