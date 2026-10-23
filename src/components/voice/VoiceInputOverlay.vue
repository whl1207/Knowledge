<script setup lang="ts">
  /**
   * VoiceInputOverlay.vue — 全局语音输入的**唯一视觉提示**（整个应用只挂一次，见 App.vue）
   *
   * 为什么需要它：语音输入现在可以落在任何输入框（搜索框 / 设置字段 / 对话框输入框…），
   * 那些地方原本没有麦克风按钮，用户看不到「到底在录没有、声音进没进去、结果会落在哪」。
   * 所以它统一负责回答三件事：
   *   ① 正在录音吗（红色麦克风 + 跳动波形；识别阶段换成转圈）；
   *   ② 正在输入到哪个框（落点名，纯文本输入框没有自己的录音提示，这是唯一的反馈）；
   *   ③ 刚才那句话（流式引擎的实时文字，说完即写入落点）。
   *
   * 状态全部来自 globalVoice.ts 的 voiceState —— 本组件不发指令、不做判断，只做展示与两个按钮。
   * 注意：**报错 / 缺配置不走这里**（统一由 globalVoice 用 ElMessage 弹出）——
   * 这个浮层只表示「正在录音 / 正在识别 / 刚写完」，不用红色去显示错误。
   */
  import { computed, reactive } from 'vue'
  import { usestore } from '@/store'
  import { startVoice, stopVoice, voiceOverlayVisible, voiceState } from '@/services/asr/globalVoice'

  /**
   * system=true：这是「系统级听写的独立悬浮窗」，不是应用内浮层。
   * 它整窗鼠标穿透、不抢焦点，所以不显示可点击的结束 / 取消按钮；
   * 结束方式改为「再按一次快捷键」，避免点击悬浮窗把前台应用切走。
   */
  const props = defineProps<{ system?: boolean }>()

  const store = usestore()
  const zh = computed(() => store.locales === 'zh')

  /**
   * 常驻悬浮麦克风：热键在任何机器上都不一定百分百进到窗口（系统级快捷键与窗口按键两条路径
   * 互相兜底，但环境差异仍可能存在），所以再给一个**看得见、点得到、可拖动**的入口 ——
   * 点它就是一次语音输入，录音时的提示面板一定在。可在「设置 → 语音 → 输入」里关掉（✕ 同效）。
   *
   * 位置按「距右下角的像素偏移」记住（存在 asr.floatPos），拖动后立刻落盘。
   */
  const FAB_SIZE = 36
  const FAB_MARGIN = 4
  /** 拖动期间的实时位置（null = 用存档位置） */
  const dragPos = reactive<{ right: number | null; bottom: number | null }>({ right: null, bottom: null })

  /**
   * 存档位置必须**每次求值都从 store 现读**：早期版本在 setup 里抓了一份快照，
   * 拖动把新位置写进 store 后快照还是旧的，松手就「弹回原位」。
   */
  const savedPos = () => {
    const p = (store.AIconfig?.asr?.floatPos || {}) as { right?: number; bottom?: number }
    return { right: typeof p.right === 'number' ? p.right : 14, bottom: typeof p.bottom === 'number' ? p.bottom : 84 }
  }

  const fabStyle = computed(() => {
    const saved = clampPos(dragPos.right ?? savedPos().right, dragPos.bottom ?? savedPos().bottom)
    return { right: `${saved.right}px`, bottom: `${saved.bottom}px` }
  })

  /** 把坐标夹进可视区：拖出窗口后还能拖回来 */
  const clampPos = (right: number, bottom: number) => {
    const maxRight = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN)
    const maxBottom = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN)
    return {
      right: Math.min(Math.max(right, FAB_MARGIN), maxRight),
      bottom: Math.min(Math.max(bottom, FAB_MARGIN), maxBottom),
    }
  }

  let drag: { startX: number; startY: number; baseRight: number; baseBottom: number; moved: boolean } | null = null

  const onFabPointerDown = (e: PointerEvent) => {
    // 只处理主键 / 触摸；✕ 的点击由它自己 stop
    if (e.button !== 0) return
    e.preventDefault() // 关键：不让输入框丢焦点，落点仍是用户点进去的那个框
    const base = clampPos(dragPos.right ?? savedPos().right, dragPos.bottom ?? savedPos().bottom)
    drag = { startX: e.clientX, startY: e.clientY, baseRight: base.right, baseBottom: base.bottom, moved: false }
    window.addEventListener('pointermove', onFabPointerMove)
    window.addEventListener('pointerup', onFabPointerUp)
  }

  const onFabPointerMove = (e: PointerEvent) => {
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    const next = clampPos(drag.baseRight - dx, drag.baseBottom - dy)
    dragPos.right = next.right
    dragPos.bottom = next.bottom
  }

  const onFabPointerUp = () => {
    window.removeEventListener('pointermove', onFabPointerMove)
    window.removeEventListener('pointerup', onFabPointerUp)
    const moved = !!drag?.moved
    drag = null
    if (moved) {
      // 拖动：记住新位置（不触发语音输入）
      try {
        store.AIconfig.asr.floatPos = { right: dragPos.right ?? 14, bottom: dragPos.bottom ?? 84 }
        store.saveConfig()
      } catch { /* 写盘失败下次仍是默认位置 */ }
      dragPos.right = null
      dragPos.bottom = null
      return
    }
    // 没移动 = 点击：开始 / 结束一次语音输入
    dragPos.right = null
    dragPos.bottom = null
    if (voiceState.phase === 'idle') void startVoice()
    else void stopVoice()
  }

  /** 悬浮麦克风提示：把当前快捷键一并说清 */
  const fabTitle = computed(() => {
    const key = voiceState.hostShortcutActive || voiceState.shortcutDisplay
    return zh.value
      ? `语音输入：点击开始，再点一次结束；可拖动调整位置${key ? `（快捷键 ${key}）` : ''}`
      : `Voice input: click to start, click again to finish; drag to move${key ? ` (shortcut ${key})` : ''}`
  })

  /** 关掉悬浮麦克风（同一个开关也出现在设置页里） */
  const hideFloatingMic = () => {
    try {
      store.AIconfig.asr.floatButton = false
      store.saveConfig()
    } catch { /* 写盘失败不影响本次隐藏 */ }
  }

  /** 阶段文案：应用内和系统悬浮窗使用同一套最短状态 */
  const title = computed(() => {
    if (voiceState.phase === 'starting') return zh.value ? '正在启动…' : 'Starting…'
    if (voiceState.phase === 'processing') return zh.value ? '识别中…' : 'Transcribing…'
    if (voiceState.phase === 'listening') return zh.value ? '正在语音输入…' : 'Listening…'
    return ''
  })

  /**
   * 应用内是否显示面板：
   * 系统级听写由独立悬浮窗负责（props.system=true）；应用内这一份必须隐藏，
   * 否则 AI-KM 窗口在前台/可见时会同时出现两个面板。
   */
  const panelVisible = computed(() =>
    voiceOverlayVisible.value && (props.system || voiceState.mode === 'dom')
  )


</script>

<template>
  <!-- 传送到 body：任何模块 / 浮层之上都能显示（z-index 高于设置浮层与 Element Plus 弹窗） -->
  <Teleport to="body">
    <!-- 常驻悬浮麦克风（空闲时；点击=一次语音输入，按住可拖动位置，录音时换成下面的面板） -->
    <button
      v-if="!props.system && !voiceOverlayVisible && voiceState.ready && store.AIconfig?.asr?.floatButton !== false"
      class="voice-fab"
      :class="{ dragging: dragPos.right !== null }"
      :style="fabStyle"
      :title="fabTitle"
      @pointerdown="onFabPointerDown"
    >
      <i class="fa fa-microphone"></i>
      <span class="voice-fab-close" :title="zh ? '不再显示悬浮麦克风（可在设置 → 语音 → 输入 里重新打开）' : 'Hide the floating mic (re-enable under Settings → Voice → ASR)'" @pointerdown.prevent.stop @click.stop="hideFloatingMic">×</span>
    </button>

    <div v-if="panelVisible" class="voice-overlay" :class="[`phase-${voiceState.phase}`, { 'voice-overlay-system': props.system }]">
      <div class="voice-pill">
        <!-- 左侧只放一个动画：录音=跳动波形；启动/识别=转圈。不再同时出现麦克风脉冲。 -->
        <span class="voice-icon">
          <span v-if="voiceState.phase === 'listening'" class="voice-wave">
            <span v-for="i in 5" :key="i" class="voice-wave-dot" :style="{ animationDelay: (i * 0.12) + 's' }"></span>
          </span>
          <span v-else class="voice-spin"></span>
        </span>

        <div class="voice-body">
          <div class="voice-title">
            <span class="voice-title-text">{{ title }}</span>
          </div>
          <div v-if="voiceState.partial" class="voice-partial">{{ voiceState.partial }}</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
  /* ---- 常驻悬浮麦克风：右下角小圆钮，不抢焦点（mousedown.prevent），默认半透明 ---- */
  .voice-fab {
    position: fixed;
    right: 14px;
    /* 抬到输入卡片操作行上方：默认布局下右下角是「发送」按钮 */
    bottom: 84px;
    z-index: 3900;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    cursor: grab;
    /* 拖动时不要选中文本 / 触发触摸滚动 */
    touch-action: none;
    user-select: none;
    color: var(--fontColor, #eee);
    background-color: var(--menuColor, #2b2b2b);
    border: 1px solid var(--borderColor, #555);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
    opacity: 0.55;
    transition: opacity 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }
  .voice-fab:hover {
    opacity: 1;
    border-color: var(--fontActiveColor, #4c9aff);
    color: var(--fontActiveColor, #4c9aff);
    transform: scale(1.06);
  }
  /* 拖动中：跟手、不加过渡、光标抓取态 */
  .voice-fab.dragging {
    transition: none;
    opacity: 1;
    cursor: grabbing;
    transform: none;
  }
  /* ✕ 只在悬停时出现，避免小圆钮上一直挂着一个叉 */
  .voice-fab-close {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 16px;
    height: 16px;
    line-height: 14px;
    text-align: center;
    border-radius: 50%;
    font-size: 11px;
    color: var(--fontColor, #eee);
    background-color: var(--menuActiveColor, rgba(76, 154, 255, 0.35));
    border: 1px solid var(--borderColor, #555);
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .voice-fab:hover .voice-fab-close { opacity: 1; }

  /* 容器只负责定位：本身不吃鼠标事件，避免挡住下面的输入框 / 按钮 */
  .voice-overlay {
    position: fixed;
    left: 50%;
    bottom: 92px;
    transform: translateX(-50%);
    z-index: 4000;
    pointer-events: none;
    max-width: min(560px, calc(100vw - 32px));
  }

  /* 系统级听写的独立悬浮窗：组件是 Teleport 到 body 的，父容器的 deep 样式管不到，
     所以在组件自己身上把面板压到窗口底部（窗口只有 180px 高）。 */
  .voice-overlay.voice-overlay-system {
    bottom: 12px;
  }

  /* 应用内与系统共用同一个小面板：固定 64px 高，只显示「左侧动画 + 状态 + 一行实时文字」。
     文字变长时不会再把面板撑高。 */
  .voice-pill {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    box-sizing: border-box;
    padding: 6px 10px;
    border-radius: 9px;
    background-color: var(--menuColor, #2b2b2b);
    border: 1px solid var(--fontActiveColor, #4c9aff);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: var(--fontColor, #eee);
    overflow: hidden;
    animation: voice-in 0.16s ease-out;
  }

  @keyframes voice-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ---- 左侧：唯一动画位（录音=波形，启动/识别=转圈） ---- */
  .voice-icon {
    position: relative;
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .voice-spin {
    position: absolute;
    inset: 1px;
    border-radius: 50%;
    border: 2px solid var(--borderColor, #555);
    border-top-color: var(--fontActiveColor, #4c9aff);
    animation: voice-spin 0.8s linear infinite;
  }
  @keyframes voice-spin {
    to { transform: rotate(360deg); }
  }

  /* ---- 中间文字：固定两行高度，实时文字单行省略 ---- */
  .voice-body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    height: 100%;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .voice-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .voice-title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .voice-wave {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 14px;
    width: 22px;
  }
  .voice-wave-dot {
    display: inline-block;
    width: 2.5px;
    height: 3px;
    border-radius: 2px;
    background: var(--fontActiveColor, #4c9aff);
    animation: voice-dot 0.6s ease-in-out infinite alternate;
  }
  @keyframes voice-dot {
    0% { height: 3px; }
    50% { height: 12px; }
    100% { height: 3px; }
  }
  .voice-partial {
    margin-top: 1px;
    font-size: 11.5px;
    line-height: 1.3;
    opacity: 0.95;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-height: 1.3em;
  }
</style>
