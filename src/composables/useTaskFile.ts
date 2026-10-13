/**
 * src/composables/useTaskFile.ts — 「关联任务文件」通用逻辑（脚手架 .task / 数据画布 .data 共用）
 *
 * 组件（PipelineScaffold / DataCanvasModule 等）关联一个任务文件（独立窗口里由 prop 固定传入）：
 *   · 挂载 / 激活且尚未加载过该路径时，自动读取并恢复状态（占位空文件跳过，避免覆盖当前状态）；
 *   · 「保存」：有关联文件时直接覆盖写；没有关联文件时退回「另存为」对话框，并把选中路径回传给宿主。
 *
 * 各组件只需提供 collect()（采集状态，不含 version/scaffold/savedAt）与 apply()（恢复状态）。
 */
import { onActivated, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { isEmptyTaskFile, wrapTaskFile } from '@/lib/taskFile'
import { getPlatform, hasCapability } from '@/platform'

export interface TaskFileOptions {
    /** 脚手架 key（写入任务文件的 scaffold 字段，供打开文件时识别归属） */
    scaffold: string
    /** 文件路径（宿主通过 prop 传入；空字符串 = 尚未关联） */
    filePath: () => string
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
    /** 保存成功回调（带回写盘内容；宿主可据此同步标签内容 / 通知其它窗口，避免再读一次大文件） */
    onSavedJson?: (path: string, json: string) => void
    /** 是否在挂载 / 激活时自动载入关联文件（默认 true；文件驱动场景由宿主自己控制载入顺序时设 false） */
    autoLoad?: boolean
}

export function useTaskFile(opts: TaskFileOptions) {
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

    /** 空内容（新建的空文件）视为「尚无状态」，不报解析错误 */
    const parseState = (text: string): any | null => {
        if (isEmptyTaskFile(text)) return null
        if (!String(text || '').trim()) return null
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
        const res = await getPlatform().fs.readTaskFile(path)
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
            const res = await getPlatform().fs.writeTaskFile(target, jsonStr)
            if (!res || !res.success) {
                log('error', (zh() ? '保存失败: ' : 'Save failed: ') + (res?.error || '') + ` (${target})`)
                return false
            }
            log('info', (zh() ? '已保存到关联文件: ' : 'Saved to linked file: ') + target + ` (${(jsonStr.length / 1024).toFixed(0)}KB)`)
            opts.onSaved?.(target)
            opts.onSavedJson?.(target, jsonStr)
            return true
        }
        // 未关联文件（宿主外使用）：沿用旧的「另存为」对话框
        const res = await getPlatform().fs.saveTaskFileAs(jsonStr)
        if (res?.success) {
            const savedPath = res.path || ''
            log('info', (zh() ? '任务状态已保存: ' : 'Task state saved: ') + savedPath + ` (${(jsonStr.length / 1024).toFixed(0)}KB)`)
            opts.onLinkFile?.(savedPath)
            opts.onSaved?.(savedPath)
            return true
        }
        if (res?.error && res.error !== '用户取消') log('error', (zh() ? '保存失败: ' : 'Save failed: ') + res.error)
        return false
    }

    /** 旧入口：从对话框选择文件载入（无 path 参数时） */
    const loadTaskState = async (path?: string): Promise<boolean> => {
        if (path) return await loadFromFile(path)
        const res = await getPlatform().fs.pickTaskFile()
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
            const res = await getPlatform().fs.readTaskFile(path, 262144)
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

    if (opts.autoLoad !== false) {
        onMounted(() => { void autoLoadFromLinkedFile() })
        onActivated(() => { void autoLoadFromLinkedFile() })
    }

    return { saveTaskState, saveToFile, loadTaskState, loadFromFile, autoLoadFromLinkedFile, hasLoadedFrom: (p: string) => loadedPath === p }
}
