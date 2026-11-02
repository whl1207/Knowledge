<!--
  SkillCard.vue — 技能卡片（设置 → 技能 → 管理 / 智能体预设 → 技能 共用）

  为什么要抽成组件：这两个面板都按文件夹分组展示技能、行内都有开关，以前各写一套
  行样式，改一处就会「管理面板是卡片、预设里是另一张脸」。这里把「一张技能卡长什么样」
  固定成唯一实现，两个面板只决定：点卡片做什么、开关代表什么语义。

  语义（由父组件用 props 决定）：
  - `on`：开关状态。技能管理 = 已启用（注入智能体）；预设技能 = 已勾选（对该预设可用）。
  - `dimWhenOff`：关闭时整卡变淡（技能管理沿用「工具管理」的观感）。预设不传，
    因为预设卡片用「选中高亮」表达状态。
  - `highlightOn`：选中 / 启用时高亮描边（预设技能传 true，与管理面板的 dim 语义二选一）。
  - `active`：当前被点开（技能管理里正在看文件树的那一个）。
  - `compact`：窄栏 / 预设网格里用更紧凑的尺寸。
-->
<template>
  <div
    class="skill-card"
    :class="{ on, active, dim: dimWhenOff && !on, compact, 'highlight-on': highlightOn }"
    :title="description || name"
    @click="emit('open')"
  >
    <span class="skill-card-icon">
      <span v-if="emoji" class="skill-card-emoji">{{ emoji }}</span>
      <i v-else class="fa fa-cube"></i>
    </span>
    <span class="skill-card-info">
      <span class="skill-card-name-row">
        <span class="skill-card-name">{{ name }}</span>
        <span v-if="version" class="skill-card-version" :title="zh ? `版本 ${version}` : `Version ${version}`">v{{ version }}</span>
      </span>
      <span class="skill-card-desc">{{ description }}</span>
    </span>
    <span
      v-if="fileCount !== undefined && fileCount !== null"
      class="skill-card-files"
      :title="zh ? `该技能目录共 ${fileCount} 个文件（含 SKILL.md）` : `${fileCount} files in this skill (incl. SKILL.md)`"
    >
      <i class="fa fa-file-o"></i>{{ fileCount }}
    </span>
    <span
      class="skill-card-toggle"
      :class="{ on }"
      :title="on
        ? (toggleTitleOn || (zh ? '已启用：点击禁用' : 'Enabled: click to disable'))
        : (toggleTitleOff || (zh ? '已禁用：点击启用' : 'Disabled: click to enable'))"
      @click.stop="emit('toggle')"
    >
      <span class="skill-card-knob"></span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'

withDefaults(defineProps<{
  /** 技能名（目录名 / frontmatter name） */
  name: string
  /** 描述（悬停看全文，卡片内单行省略） */
  description?: string
  /** frontmatter emoji（有就代替通用立方体图标） */
  emoji?: string
  /** frontmatter version（显示成 vX.Y） */
  version?: string | number
  /** 技能目录文件总数（含 SKILL.md）；不传则不显示文件数徽标 */
  fileCount?: number
  /** 开关状态：管理面板 = 已启用；预设 = 已勾选 */
  on: boolean
  /** 正在被点开（文件树 / 编辑器对应这一个） */
  active?: boolean
  /** 关闭态整卡变淡（与工具管理一致） */
  dimWhenOff?: boolean
  /** 开启态高亮（预设技能用） */
  highlightOn?: boolean
  /** 窄栏 / 小卡片的紧凑尺寸 */
  compact?: boolean
  /** 开关打开 / 关闭时的悬停说明 */
  toggleTitleOn?: string
  toggleTitleOff?: string
}>(), {
  description: '',
  emoji: '',
  version: '',
  on: false,
  active: false,
  dimWhenOff: false,
  highlightOn: false,
  compact: false,
  toggleTitleOn: '',
  toggleTitleOff: '',
})

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'toggle'): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
</script>

<style scoped>
/* 卡片外观对齐「设置 → 工具 → 管理」的工具卡片：细边框 + 菜单底色 + 悬停高亮 */
.skill-card {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  cursor: pointer; transition: all .12s;
  min-width: 0; min-height: 40px;
  box-sizing: border-box;
  user-select: none;
}
.skill-card:hover { border-color: var(--fontActiveColor); }
.skill-card.dim { opacity: .55; }
.skill-card.active {
  border-color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--fontActiveColor);
}
.skill-card.highlight-on.on {
  border-color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}

/* 图标：与工具卡片一致（强调色 10% 底 + 强调色图标） */
.skill-card-icon {
  width: 26px; height: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 5px; font-size: 12px;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  color: var(--fontActiveColor);
}
.skill-card.dim .skill-card-icon {
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  color: var(--fontColor);
}
.skill-card-emoji { font-size: 14px; line-height: 1; }

.skill-card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.skill-card-name-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.skill-card-name {
  font-size: 12px; font-weight: 600; color: var(--fontColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.skill-card.highlight-on.on .skill-card-name { color: var(--fontActiveColor); }
.skill-card-version {
  flex-shrink: 0; font-size: 9px; line-height: 14px; padding: 0 4px;
  border: 1px solid var(--borderColor); border-radius: 3px; opacity: .6;
}
.skill-card-desc {
  font-size: 10px; color: var(--fontColor); opacity: .6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-height: 12px;
}

/* 文件数：只在技能管理里传 fileCount，预设技能不显示（那里关心的是勾选） */
.skill-card-files {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px;
  font-size: 9px; color: var(--fontColor); opacity: .5; white-space: nowrap;
}
.skill-card-files i { font-size: 9px; }

/* 开关：与「工具管理」的 tool-toggle 同尺寸同过渡 */
.skill-card-toggle {
  width: 30px; height: 16px; border-radius: 8px; flex-shrink: 0;
  background: var(--borderColor); position: relative; cursor: pointer;
  transition: all .15s;
}
.skill-card-knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.skill-card-toggle.on { background: var(--fontActiveColor); }
.skill-card-toggle.on .skill-card-knob { left: 16px; }

/* 紧凑：窄栏（管理面板选中技能后 230px）与预设技能网格 */
.skill-card.compact { padding: 4px 6px; gap: 6px; min-height: 36px; }
.skill-card.compact .skill-card-icon { width: 22px; height: 22px; font-size: 11px; }
.skill-card.compact .skill-card-emoji { font-size: 12px; }
.skill-card.compact .skill-card-name { font-size: 11px; }
.skill-card.compact .skill-card-desc { font-size: 9px; }
.skill-card.compact .skill-card-toggle { width: 26px; height: 14px; }
.skill-card.compact .skill-card-knob { width: 10px; height: 10px; }
.skill-card.compact .skill-card-toggle.on .skill-card-knob { left: 14px; }
</style>
