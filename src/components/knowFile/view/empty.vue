<script setup lang="ts">
/**
 * empty.vue — 知识管理右侧的空态提示
 *
 * 只在「没有打开工作区」时显示（见 explorer.vue 的 activeView）。视图开关已收窄为单选（设置 → 功能 → 知识管理），
 * 远程文件预览会自动用「浏览」显示，所以这里不再需要视图按钮、语言 / 主题下拉等入口。
 */
import { usestore } from '@/store'

const store = usestore()
</script>

<template>
  <div class="App_empty">
    <div class="empty-inner">
      <i class="fa fa-folder-open-o"></i>
      <div class="empty-title">{{ store.locales === 'zh' ? '还没有打开工作区' : 'No workspace open' }}</div>
      <div class="empty-desc">
        {{ store.locales === 'zh'
          ? '在左侧文件树里打开本地或远程工作区（也可以直接打开一个文件），右侧就会显示所选的视图。'
          : 'Open a local or remote workspace in the file tree on the left (or open a single file) and the selected view shows up here.' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.App_empty {
  flex: 1;
  width: 100%;
  height: 100%;
  background-color: var(--backgroundColor);
  overflow: hidden;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  text-align: center;
}

.empty-inner > i {
  font-size: 40px;
  color: var(--accentColor);
}

.empty-title {
  color: var(--textColor);
  font-size: 18px;
  font-weight: 600;
}

.empty-desc {
  color: var(--textSecondary);
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.85;
}
</style>
