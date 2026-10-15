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
  import { cancelVoice, startVoice, stopVoice, voiceOverlayVisible, voiceState } from '@/services/asr/globalVoice'

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

  /** 阶段文案 */
  const title = computed(() => {
    if (voiceState.phase === 'starting') {
      // 首次使用要加载模型（FunASR 约 230MB），可能等一会儿；说清楚，免得看起来像卡住
      return zh.value ? '正在启动语音输入…（首次会加载模型，可能需要一会儿）' : 'Starting voice input… (the first run loads the model, this can take a while)'
    }
    if (voiceState.phase === 'processing') return zh.value ? '识别中…' : 'Transcribing…'
    if (voiceState.phase === 'listening') return zh.value ? '正在语音输入…' : 'Listening…'
    return voiceState.notice || ''
  })

  /** 落点提示：有落点说明「正在输入到：xxx」，没有则提前说清会复制到剪贴板 */
  const targetText = computed(() => {
    if (voiceState.phase === 'idle') return ''
    if (voiceState.hasTarget && voiceState.targetLabel) {
      return (zh.value ? '正在输入到：' : 'Typing into: ') + voiceState.targetLabel
    }
    return zh.value ? '未找到输入框：结果会复制到剪贴板' : 'No input field: the result goes to the clipboard'
  })

  /** 结束方式提示：与输入卡片上的麦克风按钮同一套手感（按住说话 / 短按切换） */
  const hint = computed(() => {
    if (voiceState.phase !== 'listening') return ''
    return zh.value
      ? '按住说话、松开结束；短按切换持续收音（Esc 取消）'
      : 'Hold to talk and release to finish; tap to toggle (Esc cancels)'
  })

  /** 桌面应用在后台时探测不到松手，只能「按一次开始、再按一次结束」——单独说清楚 */
  const hintBackground = computed(() => {
    if (voiceState.phase !== 'listening' || voiceState.holdToTalk) return ''
    return zh.value ? '应用在后台时：按一次开始、再按一次结束' : 'In the background: press once to start, again to finish'
  })
</script>

<template>
  <!-- 传送到 body：任何模块 / 浮层之上都能显示（z-index 高于设置浮层与 Element Plus 弹窗） -->
  <Teleport to="body">
    <!-- 常驻悬浮麦克风（空闲时；点击=一次语音输入，按住可拖动位置，录音时换成下面的面板） -->
    <button
      v-if="!voiceOverlayVisible && voiceState.ready && store.AIconfig?.asr?.floatButton !== false"
      class="voice-fab"
      :class="{ dragging: dragPos.right !== null }"
      :style="fabStyle"
      :title="fabTitle"
      @pointerdown="onFabPointerDown"
    >
      <i class="fa fa-microphone"></i>
      <span class="voice-fab-close" :title="zh ? '不再显示悬浮麦克风（可在设置 → 语音 → 输入 里重新打开）' : 'Hide the floating mic (re-enable under Settings → Voice → ASR)'" @pointerdown.prevent.stop @click.stop="hideFloatingMic">×</span>
    </button>

    <div v-if="voiceOverlayVisible" class="voice-overlay" :class="`phase-${voiceState.phase}`">
      <div class="voice-pill">
        <!-- 图标区：录音 = 麦克风 + 脉冲圈；识别 = 转圈 -->
        <span class="voice-icon">
          <template v-if="voiceState.phase === 'processing'">
            <span class="voice-spin"></span>
            <i class="fa fa-microphone voice-mic-small"></i>
          </template>
          <template v-else>
            <span class="voice-pulse"></span>
            <i class="fa fa-microphone"></i>
          </template>
        </span>

        <div class="voice-body">
          <div class="voice-title">
            <span class="voice-title-text">{{ title }}</span>
            <!-- 录音中的跳动波形：一眼看出麦克风在工作 -->
            <span v-if="voiceState.phase === 'listening' || voiceState.phase === 'starting'" class="voice-wave">
              <span v-for="i in 5" :key="i" class="voice-wave-dot" :style="{ animationDelay: (i * 0.12) + 's' }"></span>
            </span>
          </div>
          <div v-if="targetText" class="voice-sub">{{ targetText }}</div>
          <div v-if="voiceState.partial" class="voice-partial">{{ voiceState.partial }}</div>
          <div v-if="hint" class="voice-hint">{{ hint }}</div>
          <div v-if="hintBackground" class="voice-hint">{{ hintBackground }}</div>
        </div>

        <div v-if="voiceState.phase !== 'idle'" class="voice-actions">
          <button class="voice-btn primary" @mousedown.prevent @click="stopVoice">
            {{ zh ? '结束' : 'Finish' }}
          </button>
          <button class="voice-btn" @mousedown.prevent @click="cancelVoice">
            {{ zh ? '取消' : 'Cancel' }}
          </button>
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

  .voice-pill {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background-color: var(--menuColor, #2b2b2b);
    border: 1px solid var(--fontActiveColor, #4c9aff);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: var(--fontColor, #eee);
    animation: voice-in 0.16s ease-out;
  }

  @keyframes voice-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ---- 左侧麦克风 ---- */
  .voice-icon {
    position: relative;
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background-color: rgba(231, 76, 60, 0.15);
    color: #e74c3c;
    font-size: 13px;
  }
  .voice-pulse {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid rgba(231, 76, 60, 0.7);
    animation: voice-pulse 1.1s ease-out infinite;
  }
  @keyframes voice-pulse {
    0% { transform: scale(0.9); opacity: 0.9; }
    100% { transform: scale(1.6); opacity: 0; }
  }
  .voice-spin {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: var(--fontActiveColor, #4c9aff);
    animation: voice-spin 0.8s linear infinite;
  }
  @keyframes voice-spin {
    to { transform: rotate(360deg); }
  }
  .voice-mic-small {
    font-size: 9px;
    color: var(--fontColor, #eee);
  }

  /* ---- 中间文字 ---- */
  .voice-body {
    min-width: 0;
    flex: 1 1 auto;
  }
  .voice-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    /* 允许换行：启动阶段那句说明较长，窄窗口下不要被截断 */
    flex-wrap: wrap;
  }
  .voice-wave {
    display: inline-flex;
    align-items: flex-end;
    gap: 3px;
    height: 14px;
  }
  .voice-wave-dot {
    display: inline-block;
    width: 3px;
    height: 4px;
    border-radius: 2px;
    background: var(--fontActiveColor, #4c9aff);
    animation: voice-dot 0.6s ease-in-out infinite alternate;
  }
  @keyframes voice-dot {
    0% { height: 4px; }
    50% { height: 14px; }
    100% { height: 4px; }
  }
  .voice-sub {
    margin-top: 3px;
    font-size: 11px;
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 流式引擎的实时文字：最多两行，避免浮层被撑高 */
  .voice-partial {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.4;
    opacity: 0.95;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .voice-hint {
    margin-top: 4px;
    font-size: 10px;
    opacity: 0.6;
    white-space: nowrap;
  }

  /* ---- 右侧按钮 ---- */
  .voice-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex: 0 0 auto;
    padding-top: 1px;
  }
  .voice-btn {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--fontColor, #eee);
    background-color: transparent;
    border: 1px solid var(--borderColor, #555);
    transition: all 0.15s ease;
  }
  .voice-btn:hover {
    border-color: var(--fontActiveColor, #4c9aff);
    color: var(--fontActiveColor, #4c9aff);
  }
  .voice-btn.primary {
    border-color: var(--fontActiveColor, #4c9aff);
    color: var(--fontActiveColor, #4c9aff);
  }
  .voice-btn.primary:hover {
    background-color: var(--menuActiveColor, rgba(76, 154, 255, 0.15));
  }
</style>
