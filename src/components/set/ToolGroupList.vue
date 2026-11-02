<!--
  ToolGroupList.vue — 列表的「分组外壳」（设置 → 工具 → 管理 / 智能体预设 → 工具 / 技能管理 / 预设 → 技能 共用）

  只负责“怎么摆”：分组、折叠、搜索、只看已启用、组内全开 / 全关。
  **分组从哪来由父组件决定**：
    - 传 `rows`（平铺行）→ 按能力域分组（归属表见 lib/agent/toolGroups.ts），工具面板走这条；
    - 传 `sections`（已分好组）→ 原样使用，技能面板按文件夹分组走这条
      （见 lib/agent/skillFolders.ts）。
  **行长什么样由父组件通过 #row 插槽决定** —— 各面板的行样式差别很大，共用一套行标记
  会互相牵制。

  操作语义：组头计数与批量按钮都只作用于**当前可见的行**（搜索 / 只看已启用过滤之后），
  即“看到什么就改什么”；想改整组就先清空搜索。
-->
<template>
  <div class="tgl">
    <!-- 工具条：搜索 / 只看已启用 / 展开收起（固定在组列表上方，不随列表滚动） -->
    <div class="tgl-toolbar">
      <div class="tgl-search">
        <i class="fa fa-search tgl-search-icon"></i>
        <input
          v-model="searchText"
          class="tgl-search-input"
          type="text"
          :placeholder="searchPlaceholder || (zh ? '搜索工具（名称 / 工具名 / 描述）' : 'Search tools (label / key / description)')"
          @keydown.esc="searchText = ''"
        />
        <i
          v-if="searchText"
          class="fa fa-times-circle tgl-search-clear"
          :title="zh ? '清空' : 'Clear'"
          @click="searchText = ''"
        ></i>
      </div>
      <button
        class="tgl-tool-btn"
        :class="{ on: onlyEnabled }"
        :title="onlyEnabledText || (zh ? '只显示已启用的项' : 'Show enabled only')"
        @click="onlyEnabled = !onlyEnabled"
      >
        <i class="fa fa-filter"></i>
        <span class="tgl-tool-btn-text">{{ onlyEnabledText || (zh ? '已启用' : 'Enabled') }}</span>
      </button>
      <button
        v-if="!searchText"
        class="tgl-tool-btn"
        :title="allCollapsed
          ? (zh ? '展开所有分组' : 'Expand all groups')
          : (zh ? '收起所有分组' : 'Collapse all groups')"
        @click="toggleAllCollapsed"
      >
        <i class="fa" :class="allCollapsed ? 'fa-expand' : 'fa-compress'"></i>
      </button>
    </div>

    <div class="tgl-scroll">
      <div v-for="g in visibleGroups" :key="g.id" class="tgl-group">
        <!-- 组头：整行可点折叠；计数与批量按钮只对当前可见行生效 -->
        <div
          class="tgl-group-head"
          :title="zh ? '点击折叠 / 展开该组' : 'Click to collapse / expand this group'"
          @click="toggleGroup(g.id)"
        >
          <i class="fa tgl-caret" :class="collapsedOf(g.id) ? 'fa-chevron-right' : 'fa-chevron-down'"></i>
          <i class="fa tgl-group-icon" :class="g.icon"></i>
          <span class="tgl-group-name">{{ zh ? g.labelZh : g.labelEn }}</span>
          <span
            class="tgl-group-count"
            :class="{ all: onCount(g) === g.rows.length }"
            :title="zh ? `已启用 ${onCount(g)} / 共 ${g.rows.length} 个` : `${onCount(g)} of ${g.rows.length} enabled`"
          >{{ onCount(g) }}/{{ g.rows.length }}</span>
          <span v-if="bulk" class="tgl-group-actions" @click.stop>
            <button
              class="tgl-bulk"
              :disabled="!canEnable(g)"
              :title="zh ? '启用该组当前可见的全部项' : 'Enable all items visible in this group'"
              @click="emitBulk(g, true)"
            >{{ bulkOnText || (zh ? '全开' : 'All') }}</button>
            <button
              class="tgl-bulk"
              :disabled="!canDisable(g)"
              :title="zh ? '禁用该组当前可见的全部项' : 'Disable all items visible in this group'"
              @click="emitBulk(g, false)"
            >{{ bulkOffText || (zh ? '全关' : 'None') }}</button>
          </span>
        </div>

        <!-- 行容器：layout 决定网格 / 单列；行内容由父组件插槽渲染 -->
        <div v-show="!collapsedOf(g.id)" class="tgl-rows" :class="'tgl-rows--' + layout">
          <template v-for="row in g.rows" :key="row.name">
            <slot name="row" :row="row" />
          </template>
        </div>
      </div>

      <div v-if="!visibleGroups.length" class="tgl-empty">
        <i class="fa fa-search"></i>
        {{ emptyText || (zh ? '没有匹配的工具' : 'No matching tools') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends GroupableToolRow">
import { computed, ref } from 'vue'
import { usestore } from '@/store'
import { groupToolRows, type GroupableToolRow, type ToolGroupSection } from '@/lib/agent/toolGroups'

const props = withDefaults(defineProps<{
  /** 平铺的行（按能力域自动分组）；传 sections 时可省略 */
  rows?: T[]
  /** 已分好组的数据（如技能按文件夹）；优先于 rows */
  sections?: ToolGroupSection<T>[]
  /** grid = 多列卡片（工具管理 / 预设），list = 单列 */
  layout?: 'grid' | 'list'
  /** 是否显示组内全开 / 全关 */
  bulk?: boolean
  /** 搜索框占位文案（不传按“工具”措辞） */
  searchPlaceholder?: string
  /** 空态文案（不传按“工具”措辞） */
  emptyText?: string
  /** 「只看已启用」按钮文案 */
  onlyEnabledText?: string
  /** 组内批量按钮文案 */
  bulkOnText?: string
  bulkOffText?: string
}>(), {
  rows: () => [],
  layout: 'grid',
  bulk: true,
})

const emit = defineEmits<{
  (e: 'bulk', payload: { rows: T[]; on: boolean }): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const searchText = ref('')
const onlyEnabled = ref(false)

/** 分组数据：父组件给了 sections 就用它（技能按文件夹），否则按工具能力域自动分 */
const sections = computed<ToolGroupSection<T>[]>(() =>
  props.sections && props.sections.length ? props.sections : groupToolRows(props.rows || []),
)

// 折叠状态：初始按分组表的 defaultCollapsed，只在本次挂载内有效
const collapsed = ref<Set<string>>(
  new Set(sections.value.filter((g) => g.defaultCollapsed).map((g) => g.id)),
)

/** 搜索 / 只看已启用过滤后的分组（空组隐藏）；搜索同时匹配组名（文件夹 / 能力域） */
const visibleGroups = computed<ToolGroupSection<T>[]>(() => {
  const q = searchText.value.trim().toLowerCase()
  return sections.value
    .map((g) => {
      const groupLabel = `${g.labelZh} ${g.labelEn}`.toLowerCase()
      return {
        ...g,
        rows: g.rows.filter((row) => {
          if (onlyEnabled.value && !row.on) return false
          if (!q) return true
          return `${row.name} ${row.labelZh} ${row.labelEn} ${row.description} ${groupLabel}`
            .toLowerCase()
            .includes(q)
        }),
      }
    })
    .filter((g) => g.rows.length > 0)
})

/** 搜索时强制展开（否则命中的行藏在折叠组里，等于没搜到） */
const collapsedOf = (id: string): boolean => !searchText.value && collapsed.value.has(id)

const allCollapsed = computed(() =>
  visibleGroups.value.length > 0 && visibleGroups.value.every((g) => collapsed.value.has(g.id)),
)

const toggleGroup = (id: string) => {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

const toggleAllCollapsed = () => {
  if (allCollapsed.value) {
    collapsed.value = new Set()
    return
  }
  collapsed.value = new Set(visibleGroups.value.map((g) => g.id))
}

const onCount = (g: ToolGroupSection<T>): number => g.rows.reduce((n, row) => n + (row.on ? 1 : 0), 0)

/** 全开：还有没开的（且不是恒开）才可点 */
const canEnable = (g: ToolGroupSection<T>): boolean => g.rows.some((row) => !row.on && !row.alwaysOn)
/** 全关：还有开着的（且能关掉）才可点 */
const canDisable = (g: ToolGroupSection<T>): boolean => g.rows.some((row) => row.on && !row.alwaysOn)

const emitBulk = (g: ToolGroupSection<T>, on: boolean) => {
  emit('bulk', { rows: g.rows, on })
}
</script>

<style scoped>
.tgl {
  display: flex;
  flex-direction: column;
  /* 一定要显式占满：父级如果是 align-items:flex-start，块级子元素会被收缩到内容宽度，
     网格就只能算出两列，右侧留一大片空白（工具管理页踩过） */
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 5px;
}

/* ====== 工具条 ====== */
.tgl-toolbar { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.tgl-search {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor);
}
.tgl-search:focus-within { border-color: var(--fontActiveColor); }
.tgl-search-icon { font-size: 10px; opacity: 0.5; flex-shrink: 0; }
.tgl-search-input {
  flex: 1; min-width: 0;
  border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 11px;
  padding: 0; margin: 0;
}
.tgl-search-clear { font-size: 11px; opacity: 0.5; cursor: pointer; flex-shrink: 0; }
.tgl-search-clear:hover { opacity: 0.9; }

.tgl-tool-btn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 7px; flex-shrink: 0;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: transparent; color: var(--fontColor);
  font-size: 10px; cursor: pointer; transition: all .12s;
}
.tgl-tool-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.tgl-tool-btn.on {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.tgl-tool-btn i { font-size: 10px; }

/* ====== 组列表 ====== */
.tgl-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.tgl-scroll::-webkit-scrollbar { width: 4px; }
.tgl-scroll::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }

.tgl-group { margin-bottom: 7px; }
.tgl-group:last-child { margin-bottom: 0; }

/* 组头：一条浅色横条，弱到不抢工具的视觉重量 */
.tgl-group-head {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  cursor: pointer; user-select: none;
  font-size: 11px; font-weight: 600;
  color: var(--fontColor);
}
.tgl-group-head:hover { background: color-mix(in srgb, var(--fontColor) 10%, transparent); }
.tgl-caret { font-size: 9px; opacity: 0.65; flex-shrink: 0; width: 9px; text-align: center; }
.tgl-group-icon { font-size: 10px; opacity: 0.7; flex-shrink: 0; }
.tgl-group-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tgl-group-count {
  font-size: 9px; font-weight: 500; opacity: 0.55;
  font-family: Consolas, monospace; flex-shrink: 0;
}
.tgl-group-count.all { opacity: 0.85; color: var(--fontActiveColor); }
.tgl-group-actions { display: flex; gap: 3px; flex-shrink: 0; opacity: 0.5; }
.tgl-group-head:hover .tgl-group-actions { opacity: 1; }
.tgl-bulk {
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: transparent; color: var(--fontColor);
  font-size: 9px; line-height: 1.4; padding: 0 4px;
  cursor: pointer; transition: all .12s;
}
.tgl-bulk:hover:not(:disabled) { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.tgl-bulk:disabled { opacity: 0.35; cursor: default; }

/* 行容器：grid 用 CSS 变量控制最小列宽（父组件可按面板覆盖 --tgl-min） */
.tgl-rows { padding: 4px 0 0 9px; }
.tgl-rows--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--tgl-min, 240px), 1fr));
  gap: 5px;
  align-content: start;
}
.tgl-rows--list { display: flex; flex-direction: column; gap: 4px; }

.tgl-empty {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 18px 0; font-size: 11px; opacity: 0.55;
}
</style>
