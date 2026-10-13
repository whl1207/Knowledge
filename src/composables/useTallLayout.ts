/**
 * useTallLayout.ts — 「细长窗口」判定（高宽比 > 16:9，典型如手机竖屏）。
 *
 * 这类窗口里左右分栏会把内容区挤到不可用（知识管理尤其明显），因此主页与知识管理都按
 * **整屏切换**呈现：主页是「聊天列表 ⇄ 对话」，知识管理是「文件树抽屉 ⇄ 右侧视图」。
 *
 * 按比例而不是宽度判定：常见的 16:9 / 16:10 窗口、正方形窗口都不算细长，只有明显竖长的
 * 窗口（手机竖屏、细高窗口）才切换成整屏。模块级共享同一个 ref + 一份窗口监听，
 * 多个组件（主页 / 知识管理）同时用时不会重复注册。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 高宽比阈值：超过它即视为细长窗口 */
export const TALL_ASPECT_RATIO = 16 / 9

const isTall = ref(false)
let users = 0

/** 按当前窗口尺寸同步判定结果（窗口尺寸变化 / 手机转屏时调用） */
function sync(): void {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0
  const h = typeof window !== 'undefined' ? window.innerHeight : 0
  isTall.value = w > 0 && h > 0 && h / w > TALL_ASPECT_RATIO
}

/**
 * 取细长布局状态（响应式，模块级共享）：
 * 组件挂载时开始跟随窗口尺寸变化，卸载时自动释放监听（最后一个使用者释放时移除监听）。
 */
export function useTallLayout(): Ref<boolean> {
  onMounted(() => {
    if (users === 0 && typeof window !== 'undefined') window.addEventListener('resize', sync)
    users++
    sync()
  })
  onBeforeUnmount(() => {
    users = Math.max(0, users - 1)
    if (users === 0 && typeof window !== 'undefined') window.removeEventListener('resize', sync)
  })
  return isTall
}
