<!--
  PluginSlot.vue — 工作台的唯一渲染入口

  用法：
    <PluginSlot name="panel.main" :owner="store.mainPanel" />
    <PluginSlot name="swarm.workbench.tab" />

  - 单条目槽位（keyed / single / chain）由注册表解析出「唯一胜出」的条目并渲染；
  - 多条目槽位（list，或显式 :multiple）渲染全部条目（已按 order 排序）；
  - 每个条目都套 PluginBoundary：单个扩展崩溃不影响其他条目与主界面；
  - `meta.keepAlive` 指定 KeepAlive include 名（内置的知识处理/学习依赖它保活）；
  - `meta.passOwner` 为真时把 owner 作为 prop 传给组件，否则通过 provide 注入
    （避免给不声明 props 的内置面板塞入无关注解）。

  类型提示：模板里不直接对 `singleEntry`（可能为 undefined）取属性/传参，
  统一在脚本里预计算成可直接渲染的值（`singleComponent` / `singleProps`），
  这样 vue-tsc 不需要在模板里做收窄。
-->
<template>
  <!-- 多条目（list）：逐条渲染，顺序 = order（同 order 按注册顺序） -->
  <template v-if="isMulti">
    <PluginBoundary v-for="def in listEntries" :key="def.key" :label="def.titleZh || def.key">
      <template #default="{ attempt }">
        <component
          :is="asComponent(def)"
          v-if="asComponent(def)"
          :key="attempt"
          v-bind="componentProps(def)"
        />
      </template>
    </PluginBoundary>
  </template>

  <!-- 单条目（keyed / single / chain）
       ⚠️ 保活的三个关键点（少一个「声明了 keepAlive 的面板」就会被销毁、状态丢失）：
        1) PluginBoundary **不能**带 :key —— 面板切换时 key 变化会重建边界，
           而 KeepAlive 卸载会把缓存实例全部 unmount；
        2) KeepAlive 必须**常驻**（不能按当前面板是否声明 keepAlive 来 v-if），
           否则切到普通面板时它被卸载，缓存同样被清空；
        3) include 必须是「所有声明了 keepAlive 的面板名」的**全集**，
           否则切到另一个面板时 include 变化会触发 pruneCache，把刚缓存的面板清掉。
       缓存键用「面板 key + 重试次数」：不同面板各占一个缓存槽，切回即恢复。 -->
  <PluginBoundary v-else-if="singleComponent" :label="singleLabel" :entry-key="singleKey">
    <template #default="{ attempt }">
      <!-- KeepAlive 内必须恰好一个子节点：分支说明写在这里（注释也会被算作子节点，故不能放进 KeepAlive 内） -->
      <KeepAlive v-if="keepAliveInclude" :include="keepAliveInclude">
        <component v-if="isCoreEntry" :is="singleComponent" :key="`${singleKey}|${attempt}`" v-bind="singleProps" />
        <div v-else-if="isMainPanel" class="plugin-panel-scroll scoll">
          <component :is="singleComponent" :key="`${singleKey}|${attempt}`" v-bind="singleProps" />
        </div>
        <component v-else :is="singleComponent" :key="`${singleKey}|${attempt}`" v-bind="singleProps" />
      </KeepAlive>
      <div v-else-if="isMainPanel && !isCoreEntry" class="plugin-panel-scroll scoll">
        <component :is="singleComponent" :key="`${singleKey}|${attempt}`" v-bind="singleProps" />
      </div>
      <component v-else :is="singleComponent" :key="`${singleKey}|${attempt}`" v-bind="singleProps" />
    </template>
  </PluginBoundary>
</template>

<script setup lang="ts">
import { computed, provide, type Component } from 'vue'
import PluginBoundary from './PluginBoundary.vue'
import { useAllSlotEntries, useResolvedSlot, useSlotEntries } from '@/lib/plugin/useSlots'
import { slotRegistry, type SlotDefinition } from '@/lib/plugin/slots'
import { SLOT_META_CORE, SLOT_META_KEEP_ALIVE, SLOT_META_PASS_OWNER, SLOT_OWNER_KEY } from '@/shared/pluginSlots'
import { PANEL_MAIN_SLOT } from '@/lib/plugin/coreSlots'

const props = withDefaults(
  defineProps<{
    /** 槽位名（见 src/shared/pluginSlots.ts） */
    name: string
    /** 分派依据：keyed 用 key 匹配、chain 交给 select、list 用于 when */
    owner?: unknown
    /** 强制按「多条目」渲染（list 槽位默认即如此） */
    multiple?: boolean
  }>(),
  { multiple: false },
)

const kind = computed(() => slotRegistry.kindOf(props.name) ?? 'list')
const isMulti = computed(() => props.multiple || kind.value === 'list')
const isMainPanel = computed(() => props.name === PANEL_MAIN_SLOT)

// 渲染用「按 owner 过滤后」的条目（list 槽位会据此应用 meta.target / when 过滤）；
// 注意不要用 entriesAll：那是「列清单/诊断」用的全量视图，会把限定到其它页面的条目也渲染出来
// （实测踩坑：settings.card 的 meta.target='view' 卡片曾泄漏到商店页）。
const entries = useSlotEntries(props.name, () => props.owner)
/** 槽位全部条目（不过滤 owner）：用于汇总 keepAlive include 名单 */
const allEntries = useAllSlotEntries(props.name, () => props.owner)
const resolved = useResolvedSlot(props.name, () => props.owner)

// 槽位 owner 注入（组件内 inject(SLOT_OWNER_KEY) 可读，无需声明 props）
provide(SLOT_OWNER_KEY, computed(() => props.owner))

const listEntries = computed<SlotDefinition[]>(() => (isMulti.value ? entries.value : []))
const singleEntry = computed<SlotDefinition | null>(() => (isMulti.value ? null : resolved.value ?? null))

/** 组件引用（条目未提供 component 时为 null → 不渲染节点） */
const singleComponent = computed<Component | null>(() => (singleEntry.value?.component as Component) ?? null)
const singleKey = computed(() => singleEntry.value?.key ?? 'none')
const singleLabel = computed(() => singleEntry.value?.titleZh || singleEntry.value?.key || '')
/**
 * KeepAlive 的 include 名单 = 该槽位**所有**条目声明的 keepAlive 名（全集）。
 * 必须是全集：若只传当前面板的名字，切到另一个面板时 include 变化会触发 KeepAlive 的 pruneCache，
 * 把刚缓存的面板整批卸载（这正是「切走再切回，测试数据没了」的根因之一）。
 * 名单里没有的条目（主页 / 知识管理 / 未声明保活的插件面板）保持原来的「切走即销毁」行为。
 */
const keepAliveInclude = computed<string[] | undefined>(() => {
  const names: string[] = []
  for (const def of allEntries.value) {
    const n = def.meta?.[SLOT_META_KEEP_ALIVE]
    if (typeof n === 'string' && n && !names.includes(n)) names.push(n)
  }
  return names.length ? names : undefined
})
const singleProps = computed<Record<string, unknown>>(() =>
  singleEntry.value ? componentProps(singleEntry.value) : {},
)
/** 内置条目（meta.core）：主面板里的内置面板自带布局与滚动，不能套滚动容器 */
const isCoreEntry = computed(() => !!singleEntry.value?.meta?.[SLOT_META_CORE])

/** 组件渲染所需 props（仅在条目显式要求时传 owner） */
function componentProps(def: SlotDefinition): Record<string, unknown> {
  return def.meta?.[SLOT_META_PASS_OWNER] ? { owner: props.owner } : {}
}

/** 组件引用（list 分支用；条目未提供 component 时为 undefined → 不渲染节点） */
function asComponent(def: SlotDefinition): Component | undefined {
  return def.component as Component | undefined
}
</script>

<style scoped>
/* 插件主面板的滚动容器：面板内容超过可视高度时出现滚动条（内置面板自带布局，不走这里） */
.plugin-panel-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
