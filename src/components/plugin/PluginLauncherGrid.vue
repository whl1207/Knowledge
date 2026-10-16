<!--
  PluginLauncherGrid.vue — 插件导航收纳后的「启动器网格」

  什么时候出现：导航栏的插件图标放不下（按实际宽度判定，见 lib/plugin/navLauncher.ts）时，
  插件图标收纳成一个 `fa fa-th-large` 图标；点它之后主面板的内容区就渲染本网格，
  用 grid 列出全部插件面板，点一张卡片即以子窗口形态打开该插件。

  卡片布局：**第一行 = 图标 + 面板名**，下面三行 = 插件描述（超出用省略号裁剪）。
  这里刻意不再放「插件名」：面板名通常就等于插件名，两行写同一句话看不出信息量（踩过）。

  底部状态栏：与知识库（knowRAG）底部状态栏同款样式，显示「共 N 个插件 / 已启用 M 个」。
  计数来自插件清单（不是面板条目数）—— 一个插件可能有多个面板、也可能一个面板都没有，
  两者混着显示会跟插件管理页对不上。
-->
<template>
  <div class="plugin-launcher-grid">
    <div v-if="!entries.length" class="plg-empty">
      <i class="fa fa-puzzle-piece plg-empty-icon"></i>
      <div class="plg-empty-title">{{ zh ? '没有启用中的插件面板' : 'No enabled plugin panel' }}</div>
      <div class="plg-empty-text">
        {{ zh
          ? '插件启用后，它的主面板会出现在这里。可前往「设置 → 插件 → 管理」启用插件。'
          : 'Once a plugin is enabled, its main panel shows up here. Enable plugins under Settings → Plugins → Manage.' }}
      </div>
    </div>

    <!-- 直接铺网格：不放「全部插件 / 计数 / 点击以子窗口打开」这类页头（计数在底部状态栏） -->
    <div v-else class="plg-grid scoll">
      <div
        v-for="e in entries"
        :key="e.key"
        class="plg-card"
        :class="{ active: e.key === highlight }"
        :title="e.description ? `${e.title} — ${e.description}` : e.title"
        @click="$emit('select', e.key)"
      >
        <!-- 第一行：图标 + 标题 -->
        <div class="plg-card-head">
          <div class="plg-card-icon"><i :class="e.icon"></i></div>
          <div class="plg-card-title">{{ e.title }}</div>
        </div>
        <!-- 下面三行：插件描述（没有描述时不占位） -->
        <div v-if="e.description" class="plg-card-desc">{{ e.description }}</div>
      </div>
    </div>

    <!-- 底部状态栏：与知识库 knowRAG 的 prep-status-panel 同款（menuColor 底 + 上边框 + 小字号） -->
    <div class="plg-status">
      <span class="plg-status-item">
        <i class="fa fa-puzzle-piece"></i>
        {{ zh ? `共 ${totalCount} 个插件` : `${totalCount} plugins` }}
      </span>
      <span class="plg-status-sep"></span>
      <span class="plg-status-item on">
        <i class="fa fa-check-circle"></i>
        {{ zh ? `已启用 ${enabledCount} 个` : `${enabledCount} enabled` }}
      </span>
      <span v-if="disabledCount > 0" class="plg-status-item">
        <i class="fa fa-pause-circle"></i>
        {{ zh ? `未启用 ${disabledCount} 个` : `${disabledCount} disabled` }}
      </span>
      <span class="plg-status-hint">{{ zh ? '点击卡片在子窗口打开' : 'Click a card to open it in a window' }}</span>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * 入口条目：与 `panel.main` 槽位条目同源（key / 图标 / 标题），另加归属插件的描述。
 * 用独立的普通 `<script>` 导出类型：`<script setup>` 里不允许 export。
 */
export interface PluginLauncherEntry {
  key: string
  icon: string
  title: string
  /** 所属插件显示名（内置面板或拿不到插件名时为空串；仅用于提示，不直接显示） */
  pluginName?: string
  /** 所属插件描述（清单里的 description；空串表示没有描述，描述行整行不渲染） */
  description?: string
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    entries: PluginLauncherEntry[]
    /** 中文界面（由调用方注入，组件自己不去读 store，方便复用与单测） */
    zh?: boolean
    /** 当前已打开的插件面板 key（卡片高亮用） */
    highlight?: string
    /** 插件总数（含未启用） */
    totalCount?: number
    /** 已启用的插件数 */
    enabledCount?: number
  }>(),
  { zh: true, highlight: '', totalCount: 0, enabledCount: 0 },
)

defineEmits<{ (e: 'select', key: string): void }>()

/** 未启用 = 总数 - 已启用（负数不出，避免调用方传错时显示成 "-1 个"） */
const disabledCount = computed(() => Math.max(0, props.totalCount - props.enabledCount))
</script>

<style scoped>
.plugin-launcher-grid {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
}

/* 插件卡片网格：按可用宽度自动换列（最小 200px），窗口越宽列越多。
   卡片比原来高（第一行图标+标题，下面三行描述），列宽也相应放大 */
.plg-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  grid-auto-rows: min-content;
  gap: 10px;
  padding: 10px 12px;
}
.plg-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background-color: var(--menuColor);
  cursor: pointer;
  transition: all 0.2s ease;
}
.plg-card:hover,
.plg-card.active {
  border-color: var(--fontActiveColor);
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  transform: translateY(-1px);
}
/* 第一行：图标 + 标题 */
.plg-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.plg-card-icon {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background-color: var(--backgroundColor);
  font-size: 16px;
}
.plg-card-title {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 下面三行：插件描述，超出用省略号裁剪（完整内容在卡片 title 提示里） */
.plg-card-desc {
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.62;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  /* 未支持 -webkit-line-clamp 时退化为单行省略 */
  text-overflow: ellipsis;
}

/* ===== 底部状态栏：与知识库 knowRAG 的 prep-status-panel 同款
   （menuColor 底 + 上边框 + 小字号 + 不换行；计数与提示分列两端） ===== */
.plg-status {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-wrap: nowrap;
  column-gap: 12px;
  padding: 6px 10px;
  background: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  border-radius: 0;
  flex-shrink: 0;
  overflow: hidden;
  min-width: 0;
  font-size: 11px;
}
.plg-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0.75;
}
.plg-status-item i {
  font-size: 11px;
}
.plg-status-item.on {
  color: var(--fontActiveColor);
  opacity: 0.95;
}
.plg-status-sep {
  width: 1px;
  align-self: stretch;
  background-color: var(--borderColor);
  flex-shrink: 0;
}
/* 右侧提示：靠右、更淡，空间不够时可被压缩截断 */
.plg-status-hint {
  margin-left: auto;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.5;
}

.plg-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 60px 20px;
  text-align: center;
}
.plg-empty-icon { font-size: 34px; opacity: 0.35; }
.plg-empty-title { font-size: 15px; font-weight: 600; color: var(--fontActiveColor); }
.plg-empty-text { max-width: 460px; font-size: 12px; line-height: 1.6; opacity: 0.8; }
</style>
