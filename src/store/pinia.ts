/**
 * pinia.ts — 全局共享 Pinia 实例
 *
 * 让 main.ts 的 `app.use(pinia)` 与模块级 store 访问（如 composables/swarm 在
 * import 阶段调用 usestore()）使用**同一个** Pinia 实例，避免
 * “getActivePinia() was called but there was no active Pinia”。
 */
import { createPinia } from 'pinia'

export const pinia = createPinia()
