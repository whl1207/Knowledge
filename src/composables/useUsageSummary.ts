/**
 * useUsageSummary — 读取主进程的用量账本快照（只读，桌面端专用）
 *
 * 两处界面共用：设置 → 通用 → 数据（总体用量）与设置 → 模型 → 来源（单个来源）。
 * 因此把「怎么拉、什么时候拉、失败怎么降级」收在这里，页面只管展示。
 *
 * 边界：
 * - 账本从本版本启用后才开始记录，不做历史回填；
 * - 浏览器 / 安卓 / 旧主进程没有这个通道 → `available` 为 false，页面据此隐藏整块；
 * - 失败只记 `failed`，不抛错：设置页不该因为统计读不到就打不开。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { aikmDsh, aikmIpcAvailable } from '@/lib/aikmIpc'
import type { UsageSummary } from '@/shared/usageStats'

export function useUsageSummary(options?: { auto?: boolean }) {
  const auto = options?.auto !== false
  const summary = ref<UsageSummary | null>(null)
  const loading = ref(false)
  const failed = ref(false)

  /** 通道是否可用（非桌面端 / 旧主进程为 false） */
  const available = computed(() => aikmIpcAvailable() && !!(aikmDsh as any)?.usage?.summary)

  /** 拉取快照；并发调用只保留最后一次的结果 */
  let seq = 0
  async function reload(): Promise<void> {
    if (!available.value) return
    const mine = ++seq
    loading.value = true
    try {
      const next = await (aikmDsh as any).usage.summary()
      if (mine !== seq) return
      summary.value = next as UsageSummary
      failed.value = false
    } catch (e) {
      if (mine !== seq) return
      failed.value = true
      console.warn('[usage] 读取用量账本失败：', e)
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  /**
   * 窗口重新获得焦点时刷新（用户发完消息切回设置页就能看到新数字）。
   * 1.5s 内只跑一次，避免「点一下设置项」引发的连续 focus 把 IPC 打满。
   */
  let focusAt = 0
  function onFocus(): void {
    if (Date.now() - focusAt < 1500) return
    focusAt = Date.now()
    void reload()
  }

  onMounted(() => {
    if (!auto || !available.value) return
    void reload()
    window.addEventListener('focus', onFocus)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('focus', onFocus)
  })

  return { summary, loading, failed, available, reload }
}
