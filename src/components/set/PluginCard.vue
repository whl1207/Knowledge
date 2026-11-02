<!--
  PluginCard.vue — 插件管理面板的一张插件卡（与 SkillCard.vue / 工具卡片同一套外观）

  为什么单独抽出来：插件管理要改成与「技能管理」完全一致的分组列表 + 卡片样式，
  行样式必须固定成唯一实现（图标 / 名称 / 描述 / 版本 / 工具数 / 开关），
  面板只决定点卡片做什么、开关代表什么语义。
-->
<template>
  <div
    class="plugin-card"
    :class="{ on, active, dim: dimWhenOff && !on, compact }"
    :title="description || name"
    @click="emit('open')"
  >
    <span class="plugin-card-icon" :class="`status-${status}`">
      <i class="fa fa-puzzle-piece"></i>
    </span>
    <span class="plugin-card-info">
      <span class="plugin-card-name-row">
        <span class="plugin-card-name">{{ name }}</span>
        <span v-if="version" class="plugin-card-version" :title="zh ? `版本 ${version}` : `Version ${version}`">v{{ version }}</span>
      </span>
      <span class="plugin-card-desc">{{ description }}</span>
    </span>
    <span
      v-if="tools !== undefined && tools !== null && tools.length"
      class="plugin-card-tools"
      :title="zh ? `已注册 ${tools.length} 个工具（scope = plugin:${name}）` : `${tools.length} registered tool(s) (scope = plugin:${name})`"
    >
      <i class="fa fa-wrench"></i>{{ tools.length }}
    </span>
    <span
      class="plugin-card-toggle"
      :class="{ on }"
      :title="on
        ? (toggleTitleOn || (zh ? '已启用：点击禁用' : 'Enabled: click to disable'))
        : (toggleTitleOff || (zh ? '已禁用：点击启用' : 'Disabled: click to enable'))"
      @click.stop="emit('toggle')"
    >
      <span class="plugin-card-knob"></span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'

withDefaults(defineProps<{
  /** 显示名（清单里的 name，缺省回落到 id） */
  name: string
  /** 描述（悬停看全文，卡片内单行省略） */
  description?: string
  version?: string
  /** 已注册工具名列表：>0 时显示数量徽标 */
  tools?: string[]
  /** 插件状态：决定左侧图标颜色 */
  status?: string
  /** 开关状态 = 是否启用 */
  on: boolean
  /** 正在被点开（右侧详情对应这一个） */
  active?: boolean
  /** 关闭态整卡变淡（与工具管理一致） */
  dimWhenOff?: boolean
  /** 窄栏（选中插件后左栏 230px）用更紧凑的尺寸 */
  compact?: boolean
  toggleTitleOn?: string
  toggleTitleOff?: string
}>(), {
  description: '',
  version: '',
  tools: () => [],
  status: 'discovered',
  on: false,
  active: false,
  dimWhenOff: false,
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
/* 与 SkillCard.vue / 工具卡片完全同一套：细边框 + 菜单底色 + 悬停高亮 + 选中左侧强调条 */
.plugin-card {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  cursor: pointer; transition: all .12s;
  min-width: 0; min-height: 40px;
  box-sizing: border-box;
  user-select: none;
}
.plugin-card:hover { border-color: var(--fontActiveColor); }
.plugin-card.dim { opacity: .55; }
.plugin-card.active {
  border-color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--fontActiveColor);
}

/* 图标底：与工具 / 技能卡一致（强调色 10% 底）；状态色只改图标本身 */
.plugin-card-icon {
  width: 26px; height: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 5px; font-size: 12px;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  color: var(--fontActiveColor);
}
.plugin-card.dim .plugin-card-icon {
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  color: var(--fontColor);
}
.plugin-card-icon.status-failed { color: #e74c3c; background: color-mix(in srgb, #e74c3c 12%, transparent); }
.plugin-card-icon.status-invalid { color: #e74c3c; background: color-mix(in srgb, #e74c3c 12%, transparent); }
.plugin-card-icon.status-pending { color: #e6a23c; background: color-mix(in srgb, #e6a23c 12%, transparent); }
.plugin-card-icon.status-disabled { color: var(--fontColor); background: color-mix(in srgb, var(--fontColor) 8%, transparent); }

.plugin-card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.plugin-card-name-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.plugin-card-name {
  font-size: 12px; font-weight: 600; color: var(--fontColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.plugin-card-version {
  flex-shrink: 0; font-size: 9px; line-height: 14px; padding: 0 4px;
  border: 1px solid var(--borderColor); border-radius: 3px; opacity: .6;
}
.plugin-card-desc {
  font-size: 10px; color: var(--fontColor); opacity: .6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-height: 12px;
}

/* 工具数：与技能卡的文件数徽标同一位置与尺寸 */
.plugin-card-tools {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px;
  font-size: 9px; color: var(--fontColor); opacity: .5; white-space: nowrap;
}
.plugin-card-tools i { font-size: 9px; }

/* 开关：与工具管理 / 技能卡同尺寸同过渡 */
.plugin-card-toggle {
  width: 30px; height: 16px; border-radius: 8px; flex-shrink: 0;
  background: var(--borderColor); position: relative; cursor: pointer;
  transition: all .15s;
}
.plugin-card-knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.plugin-card-toggle.on { background: var(--fontActiveColor); }
.plugin-card-toggle.on .plugin-card-knob { left: 16px; }

/* 紧凑：选中插件后的 230px 窄栏 */
.plugin-card.compact { padding: 4px 6px; gap: 6px; min-height: 36px; }
.plugin-card.compact .plugin-card-icon { width: 22px; height: 22px; font-size: 11px; }
.plugin-card.compact .plugin-card-name { font-size: 11px; }
.plugin-card.compact .plugin-card-desc { font-size: 9px; }
.plugin-card.compact .plugin-card-toggle { width: 26px; height: 14px; }
.plugin-card.compact .plugin-card-knob { width: 10px; height: 10px; }
.plugin-card.compact .plugin-card-toggle.on .plugin-card-knob { left: 14px; }
</style>
