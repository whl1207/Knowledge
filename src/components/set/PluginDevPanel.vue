<!--
  PluginDevPanel.vue — 「设置 → 插件 → 开发」

  用途：把「怎么让大模型帮我写一个 AI-KM 插件」这件事讲清楚，并提供**可直接复制的指令**。
  设计取舍：
  - 指令文本放在 lib/plugin/devGuide.ts（纯数据），组件只负责排版与复制，便于对照实现校对；
  - 复制用 navigator.clipboard，失败时回退到 textarea + execCommand（Electron 里 http://localhost 属于安全上下文，
    但打包后走 file:// 时 clipboard 可能不可用，所以兜底必须有）；
  - 每段指令都放在限高可滚动的 <pre> 里，避免把设置页撑得极长。
-->
<template>
  <div class="plugin-dev">
    <div class="settings-group">
      <h3>{{ zh ? '插件开发' : 'Plugin development' }}</h3>

      <div class="pd-notice">
        <i class="fa fa-lightbulb-o"></i>
        <div>
          <div class="pd-title">{{ zh ? '最快的方式：把指令粘给大模型' : 'Fastest path: paste a prompt into your model' }}</div>
          <div class="pd-desc">
            {{
              zh
                ? 'AI-KM 插件就是一个文件夹（清单 + 可选的主进程/界面半边）。下面的「通用开发指令」包含全部约束与宿主 API，粘给任意大模型并写清你要的功能，它产出的文件放进插件目录即可在「插件 → 管理」里启用。'
                : 'An AI-KM plugin is just a folder (manifest plus optional main-process / UI halves). The general prompt below carries every constraint and the host API — paste it into any model, describe your feature, and enable the resulting files in Plugins → Manage.'
            }}
          </div>
        </div>
      </div>

      <div class="pd-actions">
        <div class="button small" @click="goManage"><i class="fa fa-puzzle-piece"></i> {{ zh ? '去「管理」安装 / 启用' : 'Go to Manage' }}</div>
        <div class="button small" @click="openDir"><i class="fa fa-folder-open-o"></i> {{ zh ? '打开插件目录' : 'Open plugins folder' }}</div>
        <div class="button small" @click="copy(usage, 'usage')"><i class="fa fa-copy"></i> {{ zh ? '复制「如何使用插件」' : 'Copy “How to use plugins”' }}</div>
        <div class="button small" @click="copy(minimal, 'minimal')"><i class="fa fa-copy"></i> {{ zh ? '复制最小示例' : 'Copy minimal example' }}</div>
      </div>

      <!-- 如何使用插件 -->
      <div class="pd-block">
        <div class="pd-block-head">
          <div class="pd-block-title"><i class="fa fa-play-circle-o"></i> {{ zh ? '如何使用插件' : 'How to use plugins' }}</div>
          <div class="button small" @click="copy(usage, 'usage')">{{ copiedKey === 'usage' ? (zh ? '已复制' : 'Copied') : zh ? '复制' : 'Copy' }}</div>
        </div>
        <pre class="pd-pre">{{ usage }}</pre>
      </div>

      <!-- 最小示例 -->
      <div class="pd-block">
        <div class="pd-block-head">
          <div class="pd-block-title"><i class="fa fa-file-code-o"></i> {{ zh ? '从零开始的最小插件（照抄即可跑）' : 'Minimal plugin from scratch' }}</div>
          <div class="button small" @click="copy(minimal, 'minimal')">{{ copiedKey === 'minimal' ? (zh ? '已复制' : 'Copied') : zh ? '复制' : 'Copy' }}</div>
        </div>
        <pre class="pd-pre">{{ minimal }}</pre>
      </div>

      <!-- 各段指令 -->
      <div v-for="s in sections" :key="s.key" class="pd-block">
        <div class="pd-block-head">
          <div class="pd-block-title"><i class="fa fa-magic"></i> {{ zh ? s.titleZh : s.titleEn }}</div>
          <div class="button small" @click="copy(zh ? s.bodyZh : s.bodyEn, s.key)">
            {{ copiedKey === s.key ? (zh ? '已复制' : 'Copied') : zh ? '复制指令' : 'Copy prompt' }}
          </div>
        </div>
        <div class="pd-block-desc">{{ zh ? s.descZh : s.descEn }}</div>
        <pre class="pd-pre">{{ zh ? s.bodyZh : s.bodyEn }}</pre>
      </div>

      <!-- 速查表 -->
      <div class="pd-block">
        <div class="pd-block-title"><i class="fa fa-table"></i> {{ zh ? '清单 / 槽位 / API 速查' : 'Manifest, slots and API cheat sheet' }}</div>
        <table class="pd-table">
          <tbody>
            <tr v-for="f in facts" :key="f.name">
              <td class="pd-table-name"><code>{{ f.name }}</code></td>
              <td class="pd-table-desc">{{ zh ? f.descZh : f.descEn }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 常见问题 -->
      <div class="pd-block">
        <div class="pd-block-title"><i class="fa fa-question-circle-o"></i> {{ zh ? '常见问题' : 'FAQ' }}</div>
        <div v-for="(f, i) in faq" :key="i" class="pd-faq">
          <div class="pd-faq-q"><i class="fa fa-angle-right"></i> {{ zh ? f.qZh : f.qEn }}</div>
          <div class="pd-faq-a">{{ zh ? f.aZh : f.aEn }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import {
  PLUGIN_DEV_FACTS,
  PLUGIN_DEV_FAQ,
  PLUGIN_DEV_MINIMAL_EN,
  PLUGIN_DEV_MINIMAL_ZH,
  PLUGIN_DEV_SECTIONS,
  PLUGIN_DEV_USAGE_EN,
  PLUGIN_DEV_USAGE_ZH,
} from '@/lib/plugin/devGuide'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const sections = PLUGIN_DEV_SECTIONS
const facts = PLUGIN_DEV_FACTS
const faq = PLUGIN_DEV_FAQ
const usage = computed(() => (zh.value ? PLUGIN_DEV_USAGE_ZH : PLUGIN_DEV_USAGE_EN))
const minimal = computed(() => (zh.value ? PLUGIN_DEV_MINIMAL_ZH : PLUGIN_DEV_MINIMAL_EN))

/** 刚复制成功的那一块（按钮上给个「已复制」反馈） */
const copiedKey = ref('')

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

/** 复制：优先用剪贴板 API，失败时回退到临时 textarea（打包后 file:// 下 clipboard 可能不可用） */
const copy = async (text: string, key: string) => {
  const fallback = () => {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
  try {
    const ok = (await navigator.clipboard?.writeText?.(text).then(() => true).catch(() => false)) ?? false
    if (!ok && !fallback()) throw new Error('clipboard unavailable')
  } catch {
    if (!fallback()) {
      ElMessage.error(zh.value ? '复制失败，请手动选中文本复制' : 'Copy failed — select the text manually')
      return
    }
  }
  copiedKey.value = key
  ElMessage.success(zh.value ? '已复制，粘贴给大模型即可' : 'Copied — paste it into your model')
  setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = ''
  }, 2000)
}
</script>

<style scoped>
.plugin-dev {
  color: var(--fontColor);
}
/* 内边距必须由组件自带：Set.vue 的 .settings-group 是 scoped 样式，不会作用到子组件内部 */
.plugin-dev .settings-group {
  padding: 8px;
  margin-bottom: 0;
}
.plugin-dev h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.plugin-dev h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.pd-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.6;
}
.pd-notice i {
  color: #e6a23c;
  margin-top: 2px;
}
.pd-title {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.pd-desc {
  opacity: 0.78;
}
.pd-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.pd-block {
  margin-top: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  padding: 8px 10px;
  background: var(--menuColor);
}
.pd-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.pd-block-title {
  font-size: 13px;
  font-weight: 600;
}
.pd-block-title i {
  color: var(--fontActiveColor);
  margin-right: 4px;
}
.pd-block-desc {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.7;
  opacity: 0.75;
}
.pd-pre {
  margin: 8px 0 0 0;
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.65;
  font-family: Consolas, 'Courier New', monospace;
  color: var(--fontColor);
  background: var(--menuActiveColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
}
.pd-table {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 11px;
  line-height: 1.7;
}
.pd-table td {
  border-bottom: 1px dashed var(--borderColor);
  padding: 4px 6px;
  vertical-align: top;
}
.pd-table-name {
  width: 42%;
}
.pd-table-name code {
  word-break: break-all;
  color: var(--fontActiveColor);
}
.pd-table-desc {
  opacity: 0.78;
}
.pd-faq {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.7;
}
.pd-faq-q {
  font-weight: 600;
}
.pd-faq-q i {
  color: var(--fontActiveColor);
  margin-right: 4px;
}
.pd-faq-a {
  opacity: 0.78;
  padding-left: 12px;
}
/* 与技能 / 插件管理页的工具栏按钮同款（.button.small） */
.plugin-dev .button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
  margin: 0;
  cursor: pointer;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.plugin-dev .button.small:hover {
  background-color: var(--menuActiveColor);
}
</style>
