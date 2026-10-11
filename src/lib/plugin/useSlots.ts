/**
 * useSlots.ts — 槽位注册表 ↔ Vue 响应式的桥
 *
 * 为什么单独一层：`slots.ts` 是纯逻辑（无 vue 依赖，可在 Node 下单测），
 * 本文件才引入 ref/computed，把注册表的变化转成可渲染的响应式值。
 */

import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { slotRegistry, type SlotDefinition, type SlotSnapshot } from './slots'

type OwnerSource = Ref<unknown> | ComputedRef<unknown> | (() => unknown)

/** 读取 owner（支持 ref / computed / getter 三种写法） */
function readOwner(source?: OwnerSource): unknown {
  if (!source) return undefined
  if (typeof source === 'function' && !('value' in source)) return (source as () => unknown)()
  return (source as Ref<unknown>).value
}

/** 订阅注册表变化（组件卸载时自动退订），返回递增的版本号 ref */
export function useSlotVersion(): Ref<number> {
  const version = ref(0)
  const stop = slotRegistry.subscribe(() => {
    version.value++
  })
  onUnmounted(stop)
  return version
}

/** 某槽位按 owner 解析出的条目（keyed 已分派；list 已排序） */
export function useSlotEntries(name: string, owner?: OwnerSource): ComputedRef<SlotDefinition[]> {
  const version = useSlotVersion()
  return computed(() => {
    void version.value
    return slotRegistry.entries(name, readOwner(owner))
  })
}

/** 某槽位的全部条目（不按 keyed 分派过滤；用于导航/清单） */
export function useAllSlotEntries(name: string, owner?: OwnerSource): ComputedRef<SlotDefinition[]> {
  const version = useSlotVersion()
  return computed(() => {
    void version.value
    return slotRegistry.entriesAll(name, readOwner(owner))
  })
}

/** 某槽位唯一胜出的条目（keyed/single/chain） */
export function useResolvedSlot(name: string, owner?: OwnerSource): ComputedRef<SlotDefinition | undefined> {
  const version = useSlotVersion()
  return computed(() => {
    void version.value
    return slotRegistry.resolve(name, readOwner(owner))
  })
}

/** 全部槽位快照（设置页诊断用） */
export function useSlotSnapshot(): ComputedRef<SlotSnapshot[]> {
  const version = useSlotVersion()
  return computed(() => {
    void version.value
    return slotRegistry.snapshot()
  })
}
