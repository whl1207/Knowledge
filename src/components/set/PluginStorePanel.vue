<!--
  PluginStorePanel.vue — 插件商店（P2 预留占位）

  当前版本**只做本地插件**（「插件 → 管理」里从文件夹安装），在线分发通道尚未提供：
  这里不放任何"功能不可用"的控制项，只说明现状与本地方案，并提供两个实用入口
  （打开插件目录 / 跳到管理页），避免出现点了没反应的空面板。
-->
<template>
  <div class="plugin-store">
    <div class="settings-group">
      <h3>{{ zh ? '插件商店' : 'Plugin Store' }}</h3>

      <div class="ps-notice">
        <i class="fa fa-info-circle"></i>
        <div>
          <div class="ps-title">{{ zh ? '在线安装尚未提供' : 'Online installation is not available yet' }}</div>
          <div class="ps-desc">
            {{ zh
              ? '本版本只支持本地插件：把插件文件夹放到插件目录，或在「插件 → 管理」里从文件夹安装。在线分发（浏览 / 一键安装 / 更新）会在后续版本提供。'
              : 'This version supports local plugins only: drop a plugin folder into the plugins folder, or use “Plugins → Manage → Install from folder”. Online distribution (browse / one-click install / updates) will come later.' }}
          </div>
        </div>
      </div>

      <div class="ps-cards">
        <div class="ps-card">
          <div class="ps-card-title"><i class="fa fa-folder-open-o"></i> {{ zh ? '本地安装' : 'Local install' }}</div>
          <div class="ps-card-desc">
            {{ zh
              ? '插件包 = 一个文件夹（含 package.json 与 aikm 清单）。仓库里的 examples/plugins/hello-panel 可直接拿来试用。'
              : 'A plugin package is a folder with a package.json carrying the aikm manifest. examples/plugins/hello-panel in the repo is a ready-to-try sample.' }}
          </div>
          <div class="ps-actions">
            <div class="button small" @click="goManage">{{ zh ? '去「管理」安装' : 'Go to Manage' }}</div>
            <div class="button small" @click="openDir">{{ zh ? '打开插件目录' : 'Open plugins folder' }}</div>
          </div>
        </div>

        <div class="ps-card">
          <div class="ps-card-title"><i class="fa fa-book"></i> {{ zh ? '插件能做什么' : 'What a plugin can do' }}</div>
          <div class="ps-card-desc">
            {{ zh
              ? '给智能体加工具；往界面里加主面板、设置页签、设置卡片与集群工作台页签；注册全局快捷键；提供中英文案字典。'
              : 'Add agent tools; add main panels, settings tabs, settings cards and swarm workbench tabs; register global shortcuts; ship zh/en locale dictionaries.' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const goManage = () => {
  store.settingsNav = 'plugin'
}

const openDir = async () => {
  try {
    await (window as any).dsh?.plugin?.openDir?.()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}
</script>

<style scoped>
.plugin-store {
  color: var(--fontColor);
}
/* 内边距必须由组件自带：Set.vue 的 .settings-group 是 scoped 样式，不会作用到子组件内部 */
.plugin-store .settings-group {
  padding: 8px;
  margin-bottom: 0;
}
/* 标题与其它设置页一致：强调色 + 左侧竖条 + 下边框 */
.plugin-store h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.plugin-store h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.ps-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.6;
}
.ps-notice i {
  color: #409eff;
  margin-top: 2px;
}
.ps-title {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.ps-desc {
  opacity: 0.75;
}
.ps-cards {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.ps-card {
  flex: 1 1 260px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  padding: 10px;
  background: var(--menuColor);
}
.ps-card-title {
  font-weight: 600;
  font-size: 13px;
}
.ps-card-desc {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.7;
  opacity: 0.75;
}
.ps-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 与技能管理的工具栏按钮同款（.button.small） */
.plugin-store .button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
  margin: 0;
  cursor: pointer;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
}
.plugin-store .button.small:hover {
  background-color: var(--menuActiveColor);
}
.ps-actions .button {
  margin: 0;
  cursor: pointer;
}
</style>
