/**
 * platform/android/tasks — 长任务前台服务桥（LongTask 插件）封装
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/LongTaskPlugin.java +
 * LongTaskService.java：起一个带进度通知的前台服务，长任务期间不被系统回收，
 * 用户还能从通知栏看到进度并点回应用。
 *
 * 非安卓环境不需要它（桌面/网页的长任务不会被回收），调用点通过
 * `hasCapability('app.longTask')` 判断，因此这里的实现只在安卓生效。
 */

import { registerPlugin } from '@capacitor/core'

/** 原生插件的最小接口（与 LongTaskPlugin.java 一一对应） */
export interface LongTaskPluginApi {
  begin(payload: { title?: string; text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean; action?: string }>
  update(payload: { text?: string; progress?: number; indeterminate?: boolean }): Promise<{ success: boolean; action?: string }>
  end(): Promise<{ success: boolean; action?: string }>
  active(): Promise<{ active: boolean }>
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const LongTask = registerPlugin<LongTaskPluginApi>('LongTask')
