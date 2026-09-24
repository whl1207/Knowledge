<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { usestore } from '@/store'
import MediaAudio from '@/components/knowFile/view/MediaAudio.vue'
import MediaVideo from '@/components/knowFile/view/MediaVideo.vue'

const store = usestore()

const props = defineProps<{
  path: string
  content?: string
}>()

const emit = defineEmits<{
  (e: 'update:path', path: string): void
}>()

const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff']
const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg']

// 内部当前播放路径：子模块切歌/切集时更新，props.path 变化时同步（与父组件标签逻辑分离）
const currentPath = ref(props.path)
watch(() => props.path, (p) => { if (p) currentPath.value = p })

const extension = computed(() => {
  const p = currentPath.value || ''
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
})
const isAudio = computed(() => AUDIO_EXTS.includes(extension.value))
const isVideo = computed(() => VIDEO_EXTS.includes(extension.value))

// 子模块内切换媒体（切歌/切集）时更新内部路径并向上透传（父组件标签/标题同步）
function onMediaPathChange(p: string) {
  if (!p) return
  currentPath.value = p
  emit('update:path', p)
}
</script>

<template>
  <div class="media-root">
    <MediaAudio v-if="isAudio" :path="currentPath" @update:path="onMediaPathChange" />
    <MediaVideo v-else-if="isVideo" :path="currentPath" @update:path="onMediaPathChange" />
    <!-- 未知多媒体格式 -->
    <div v-else class="media-status">
      <i class="fa fa-question-circle"></i>
      <span>{{ store.locales === 'zh' ? '暂不支持该多媒体格式' : 'Unsupported media format' }}</span>
    </div>
  </div>
</template>

<style scoped>
.media-root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--backgroundColor);
}
.media-status {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fontColor);
  font-size: 14px;
}
.media-status i {
  font-size: 20px;
  color: var(--fontActiveColor);
}
</style>
