/**
 * useTaskFileOpen — 消费「打开 .task 任务文件」请求（store.taskPathToOpen）。
 *
 * 入口（知识管理双击 / 搜索 / 文件对话框等）由 store.openTaskFileByPath 识别脚手架后
 * 新建（或激活已有）实例、设 mainPanel='Agent脚手架' + taskPathToOpen；
 * 对应脚手架实例在 setup 中调用本组合式函数消费该标记并加载任务状态（与 .kb → knowRAG 的 kbPathToOpen 机制对齐）。
 *
 * 组件可能被 AgentScaffold 的 KeepAlive 缓存（切换脚手架时 deactivate/activate），
 * 故同时监听 onMounted / onActivated / watch(taskPathToOpen) 三个时机。
 */
import { onActivated, onMounted, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { isInstanceRunning } from '@/store/runningTasks'

export function useTaskFileOpen(key: string, loader: (path: string) => void | Promise<void>) {
    const store = usestore()
    let busy = false

    const consume = async () => {
        const path = store.taskPathToOpen
        if (!path || busy) return
        // 只有「当前激活实例」所属的脚手架才消费（其余实例可能同时存活于 KeepAlive 缓存中）
        if (store.activeInstance()?.type !== key) return
        const instanceId = store.activeInstanceId
        store.taskPathToOpen = null // 先消费标记，避免重复加载
        busy = true
        try {
            // 正在运行任务时先确认：加载会覆盖当前任务状态（运行不会自动停止）
            if (isInstanceRunning(instanceId)) {
                const zh = store.locales !== 'en'
                try {
                    await ElMessageBox.confirm(
                        zh ? '该脚手架正在运行任务，加载任务文件会覆盖当前状态（不会停止运行）。是否继续？'
                           : 'This scaffold is running a task. Loading the task file will overwrite the current state (the run is not stopped). Continue?',
                        zh ? '提示' : 'Notice',
                        { confirmButtonText: zh ? '继续加载' : 'Continue', cancelButtonText: zh ? '取消' : 'Cancel', type: 'warning' }
                    )
                } catch {
                    return // 用户取消
                }
            }
            await loader(path)
        } catch (e) {
            console.error(`[task-open] 脚手架 ${key} 加载任务文件失败:`, e)
        } finally {
            busy = false
        }
    }

    watch(() => store.taskPathToOpen, () => { void consume() })
    onMounted(() => { void consume() })
    onActivated(() => { void consume() })
}
