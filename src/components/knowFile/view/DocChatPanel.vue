<script setup lang="ts">
  /**
   * DocChatPanel.vue — 「智能操作」文档对话面板（右侧栏，无标题栏）
   *
   * 供 md_read（Markdown / Word）等模块复用：把当前文档的上下文（整篇 / 当前章节 /
   * 选中文字…）按需附在提问后，与模型多轮对话。
   *
   * 逻辑与 PdfViewer 的智能对话保持一致（同一套踩坑修复）：
   *  - 流式 onStream/onComplete/onError + epoch 轮次标记（被中止的旧轮回调不污染新轮）
   *  - requestId + 看门狗轮询 ai:get 快照兜底解锁 loading，并做假死检测（长时无 chunk / 硬超时）
   *  - IME：合成期间（选词回车）不发送；点发送按钮视为确认
   *  - 发送按钮只随输入是否为空禁用（loading 不置灰），避免生成完按钮点不动
   */
  import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
  import { ElMessage } from 'element-plus'
  import { usestore } from '@/store'
  import { renderQuestionMarkdown } from '@/lib/markdown/render'

  /** 可附带上下文选项 */
  interface AttachOption {
    key: string
    label: string
    icon: string
    title?: string
    /** kind=text 时拼进提示语的标签；缺省用 label（如「当前页文字 · 第 3 页」） */
    tag?: string
    /** 上下文类型：text（默认，拼进提问文本）/ image（多模态图片，如 PDF 当前页截图） */
    kind?: 'text' | 'image'
    /** 是否为默认选中项 */
    default?: boolean
    /** 此选项取的就是「选中文字」：用于在面板上提示已固定的选区 */
    usesSelection?: boolean
    /**
     * 悬浮时取「本条上下文有多少字符」：面板会在悬浮时调用一次并缓存，
     * 用于悬浮提示显示总数，以及超出 MAX_ATTACH_CHARS 时的截断预警。
     * 允许返回 Promise（如 PDF 需先提取文字）。不实现则不显示字数。
     */
    count?: () => number | Promise<number>
    /**
     * 计数的「版本」：返回值变化即视为上次统计作废（默认用 tag 做版本）。
     * 字数会随滚动 / 光标 / 选区变化的选项（当前章节、当前块、选中文字）必须给，
     * 否则悬浮看到的是第一次统计的旧数字。
     */
    countRev?: () => string | number
  }

  const props = defineProps<{
    /** 文档标识（切换文件时自动清空会话） */
    docKey?: string
    /** 上下文选项（顺序即按钮顺序） */
    attachOptions: AttachOption[]
    /**
     * 按 key 取上下文内容；返回空串表示本次不附带。
     * kind=text 时返回文本；kind=image 时返回图片 data URL（data:image/jpeg;base64,...）或裸 base64。
     * 允许返回 Promise（如 PDF 需异步提取页面文字 / 截图）。
     * 第二个参数是面板记下的「选中文字」快照：点输入框会让文档失焦、选区消失，
     * 调用方可以把 live 取不到时的它当兜底（不需要时忽略即可）。
     */
    getContext: (key: string, snapshot?: string) => string | Promise<string>
    /** 空状态提示文字 */
    hint?: string
  }>()

  const store = usestore()

  type ChatMsg = {
    role: 'user' | 'assistant'
    content: string
    sendContent?: string
    images?: string[]
    attachLabel?: string
    /** 附带内容超长被截断时的信息（用于在气泡里明确提醒） */
    truncated?: { kept: number; total: number }
  }

  const chatList = ref<ChatMsg[]>([])
  const chatInput = ref('')
  const chatLoading = ref(false)
  const chatComposing = ref(false)
  const chatBodyRef = ref<HTMLElement | null>(null)
  /** 当前选中的附带方式（'' = 不附带） */
  const chatAttach = ref<string>('')

  // 初始化默认选中项（无默认则默认附「整篇」类选项：取第一个）
  const initAttach = () => {
    const def = props.attachOptions.find((o) => o.default) || props.attachOptions[0]
    chatAttach.value = def ? def.key : ''
  }
  initAttach()
  watch(() => props.attachOptions, (opts) => {
    if (!opts.some((o) => o.key === chatAttach.value)) initAttach()
  })

  // 切换文件 → 清空会话（上下文已完全不同）
  watch(() => props.docKey, () => clearChat())

  const toggleAttach = (key: string) => {
    chatAttach.value = chatAttach.value === key ? '' : key
  }

  // ===== 附带内容规模（悬浮显示字数 / 截断预警） =====
  /** 单次附带内容的字符上限：超出部分不发送（必须在提示里说明，避免静默丢内容） */
  const MAX_ATTACH_CHARS = 120000
  const fmtNum = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  /** 已统计结果：key → { 字数, 版本 }（版本变化即失效，避免沿用旧数字） */
  const attachCount = ref<Record<string, { n: number; rev: string }>>({})
  const countingKeys = new Set<string>()
  const hoverKey = ref('')

  const tagOf = (o: AttachOption) => o.tag || o.label
  const revOf = (o: AttachOption) => String(o.countRev ? o.countRev() : tagOf(o))
  const countOf = (o: AttachOption): number | undefined => {
    const e = attachCount.value[o.key]
    return e && e.rev === revOf(o) ? e.n : undefined
  }

  const loadAttachCount = async (o: AttachOption, isHover = true) => {
    if (isHover) hoverKey.value = o.key
    if (!o.count) return
    if (countOf(o) !== undefined) return
    const rev = revOf(o)
    const flightKey = `${o.key}|${rev}`
    if (countingKeys.has(flightKey)) return
    countingKeys.add(flightKey)
    try {
      const n = await o.count()
      if (typeof n === 'number' && Number.isFinite(n)) {
        attachCount.value = { ...attachCount.value, [o.key]: { n, rev } }
      }
    } catch { /* 统计失败就不显示字数 */ }
    finally { countingKeys.delete(flightKey) }
  }

  const loadSelectedCount = () => {
    const o = props.attachOptions.find((x) => x.key === chatAttach.value)
    if (o) loadAttachCount(o, false)
  }
  // 选中项自动统计（鼠标没悬浮也能看到超限预警）；选项数组变化（翻页 / 滚动 / 换文档）做防抖
  let metaTimer: ReturnType<typeof setTimeout> | null = null
  watch(chatAttach, () => loadSelectedCount())
  watch(() => props.attachOptions, () => {
    if (metaTimer) clearTimeout(metaTimer)
    metaTimer = setTimeout(() => { metaTimer = null; loadSelectedCount() }, 350)
  })

  /** 悬浮提示（原生 title）：说明 + 字数 + 超限预警 */
  const chipTitle = (o: AttachOption) => {
    const base = o.title || o.label
    const n = countOf(o)
    if (n === undefined) return base
    if (n > MAX_ATTACH_CHARS) {
      return store.locales === 'zh'
        ? `${base} · 共 ${fmtNum(n)} 字符，超出 ${fmtNum(MAX_ATTACH_CHARS)} 上限，发送时只附带前 ${fmtNum(MAX_ATTACH_CHARS)} 字符`
        : `${base} · ${fmtNum(n)} chars, exceeds the ${fmtNum(MAX_ATTACH_CHARS)} limit, only the first part will be attached`
    }
    return `${base} · ${fmtNum(n)}${store.locales === 'zh' ? ' 字符' : ' chars'}`
  }

  /** 超出上限的提醒（悬浮项优先，否则看当前选中项）：字数已统计过才提示 */
  const attachOverLimitNote = computed(() => {
    const key = hoverKey.value || chatAttach.value
    const opt = props.attachOptions.find((o) => o.key === key)
    if (!opt) return ''
    const n = countOf(opt)
    if (n === undefined || n <= MAX_ATTACH_CHARS) return ''
    return store.locales === 'zh'
      ? `${tagOf(opt)} 内容较长（${fmtNum(n)} 字符）：发送时仅附带前 ${fmtNum(MAX_ATTACH_CHARS)} 字符`
      : `${tagOf(opt)} is long (${fmtNum(n)} chars): only the first ${fmtNum(MAX_ATTACH_CHARS)} chars will be attached`
  })

  /** 已发送消息里的截断提示文案 */
  const truncNote = (t: { kept: number; total: number }) => (store.locales === 'zh'
    ? `内容过长已截断：仅附带前 ${fmtNum(t.kept)} / ${fmtNum(t.total)} 字符`
    : `Truncated: only the first ${fmtNum(t.kept)} / ${fmtNum(t.total)} chars attached`)

  // ===== 选中文字快照 =====
  // 点输入框 / 面板按钮会让文档失焦，浏览器就把选区内容丢掉了。
  // 所以在 mousedown（焦点还没移走）时先记一份，供 getContext 兜底。
  const selSnapshot = ref('')

  const liveSelectionText = (): string => {
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      const t = ae as HTMLTextAreaElement
      const s = t.selectionStart ?? 0
      const e = t.selectionEnd ?? 0
      if (e > s) return t.value.slice(s, e)
    }
    return (window.getSelection()?.toString() || '').trim()
  }

  const onDocMouseDown = (e: MouseEvent) => {
    const text = liveSelectionText()
    if (text) {
      selSnapshot.value = text
      return
    }
    // 点在面板外面且此刻没有选中内容 → 说明用户主动取消了选择
    const t = e.target as HTMLElement | null
    if (!t || !t.closest('.dchat')) selSnapshot.value = ''
  }

  onMounted(() => {
    document.addEventListener('mousedown', onDocMouseDown, true)
    // 默认附带项也统计一下：不悬浮也能看到字数 / 超限预警
    loadSelectedCount()
  })

  /** 当前附带的选项若取的是选中文字，且已固定过选区 → 在输入区上方提示一下 */
  const selNote = computed(() => {
    const opt = props.attachOptions.find((o) => o.key === chatAttach.value)
    return !!opt?.usesSelection && !!selSnapshot.value.trim()
  })

  // ===== 滚动跟随（聊天列表贴底才自动下拉） =====
  /** 是否处于「贴底」状态：用户上滚看历史后置 false，此时新内容/流式输出不再强行下拉 */
  const chatStickBottom = ref(true)
  const BOTTOM_TOLERANCE = 24

  const isChatAtBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE

  const onChatScroll = () => {
    const el = chatBodyRef.value
    if (!el) return
    chatStickBottom.value = isChatAtBottom(el)
  }

  /** 滚到底部：默认仅「已贴底」时跟随；force=true 用于自己发送消息等必须可见的场景 */
  const scrollChatToBottom = (force = false) => {
    if (!force && !chatStickBottom.value) return
    nextTick(() => {
      const el = chatBodyRef.value
      if (!el) return
      el.scrollTop = el.scrollHeight
      chatStickBottom.value = true
    })
  }

  const chatHtml = (s: string) => (s ? renderQuestionMarkdown(s) : '')

  // ===== 发送 =====
  let chatAbort: AbortController | null = null
  let chatWatchTimer: ReturnType<typeof setInterval> | null = null
  let chatLastChunkAt = 0
  let chatStartedAt = 0
  let lastReqId = ''
  let chatEpoch = 0

  const stopChatWatchdog = () => {
    if (chatWatchTimer) { clearInterval(chatWatchTimer); chatWatchTimer = null }
  }

  const startChatWatchdog = (requestId: string, epoch: number) => {
    stopChatWatchdog()
    const ipc = (window as any).ipcRenderer
    if (!ipc?.invoke) return
    chatWatchTimer = setInterval(async () => {
      if (epoch !== chatEpoch) { stopChatWatchdog(); return }
      if (!chatLoading.value) { stopChatWatchdog(); return }
      let snap: any = null
      try { snap = await ipc.invoke('ai:get', { requestId }) } catch { /* 查询失败忽略 */ }
      const done = !snap || snap.status === 'completed' || snap.status === 'error' || snap.status === 'aborted'
      const last = chatList.value[chatList.value.length - 1]
      const hasContent = !!(last && last.role === 'assistant' && last.content)
      const contentStall = hasContent && Date.now() - chatLastChunkAt > 25000
      const hardTimeout = Date.now() - chatStartedAt > 120000
      if (!done && !contentStall && !hardTimeout) return
      stopChatWatchdog()
      if (!snap || snap.status !== 'completed') {
        try { await ipc.invoke('ai:abort', { requestId }) } catch { /* ignore */ }
      }
      chatLoading.value = false
      chatAbort = null
      if (snap?.status === 'completed' && snap.content && last && last.role === 'assistant' && !last.content) {
        last.content = snap.content
      }
      scrollChatToBottom()
    }, 4000)
  }

  const sendChatMessage = async () => {
    const text = chatInput.value.trim()
    if (!text || chatLoading.value) return
    const epoch = ++chatEpoch
    if (!(await store.ensureDefaultModelOnline())) {
      chatList.value.push({ role: 'assistant', content: '⚠ ' + (store.locales === 'zh' ? 'AI 服务未连接，请先检查大模型配置。' : 'AI service offline, please check model config.') })
      scrollChatToBottom(true)
      return
    }
    // 按当前选中的方式附上下文
    let sendContent = text
    let attachLabel = ''
    const images: string[] = []
    let truncated: { kept: number; total: number } | undefined
    const key = chatAttach.value
    if (key) {
      const opt = props.attachOptions.find((o) => o.key === key)
      let ctx = ''
      try { ctx = String((await props.getContext(key, selSnapshot.value)) || '').trim() } catch { ctx = '' }
      if (ctx && opt) {
        attachLabel = opt.tag || opt.label
        if (opt.kind === 'image') {
          // 多模态图片：兼容 data URL 与裸 base64
          const b64 = ctx.includes(',') ? ctx.slice(ctx.indexOf(',') + 1) : ctx
          if (b64) images.push(b64)
        } else if (ctx.length > MAX_ATTACH_CHARS) {
          // 超长上下文只发前 MAX_ATTACH_CHARS 字符，并在气泡上明确提醒（不静默丢弃）
          truncated = { kept: MAX_ATTACH_CHARS, total: ctx.length }
          // 顺手把统计结果记下，后续悬浮提示与预警立即生效（带版本号，位置/选区变了会自然失效）
          attachCount.value = { ...attachCount.value, [key]: { n: ctx.length, rev: revOf(opt) } }
          sendContent = `${text}\n\n【参考 · ${attachLabel}】\n${ctx.slice(0, MAX_ATTACH_CHARS)}`
        } else {
          sendContent = `${text}\n\n【参考 · ${attachLabel}】\n${ctx}`
        }
      } else {
        attachLabel = ''
      }
    }
    chatList.value.push({ role: 'user', content: text, sendContent, images, attachLabel, truncated })
    chatInput.value = ''
    chatList.value.push({ role: 'assistant', content: '' })
    // 自己发消息：一定拉到底（之前停在历史位置也应跳回自己刚发的那条）
    scrollChatToBottom(true)

    chatLoading.value = true
    if (chatAbort) chatAbort.abort()
    chatAbort = new AbortController()
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    lastReqId = reqId
    chatStartedAt = Date.now()
    chatLastChunkAt = Date.now()
    startChatWatchdog(reqId, epoch)

    const history = chatList.value.slice(0, -1).map((m) => {
      const base: any = { role: m.role, content: m.sendContent || m.content }
      if (m.images && m.images.length) base.images = [...m.images]
      return base
    })
    try {
      await store.sendToAI(history, {
        signal: chatAbort.signal,
        requestId: reqId,
        onStream: (chunk: string) => {
          if (epoch !== chatEpoch) return
          chatLastChunkAt = Date.now()
          const last = chatList.value[chatList.value.length - 1]
          if (last && last.role === 'assistant') last.content += chunk
          scrollChatToBottom()
        },
        onComplete: () => {
          if (epoch !== chatEpoch) return
          chatLoading.value = false
          chatAbort = null
          stopChatWatchdog()
          scrollChatToBottom()
        },
        onError: (err: Error) => {
          if (epoch !== chatEpoch) return
          chatLoading.value = false
          chatAbort = null
          stopChatWatchdog()
          const last = chatList.value[chatList.value.length - 1]
          const aborted = err?.name === 'AbortError' || /abort/i.test(err?.message || '')
          if (aborted) {
            if (last && last.role === 'assistant' && !last.content) chatList.value.pop()
          } else if (last && last.role === 'assistant') {
            last.content += (last.content ? '\n\n' : '') + '⚠ ' + (err?.message || (store.locales === 'zh' ? '请求失败' : 'Request failed'))
          }
          scrollChatToBottom()
        },
      })
    } catch {
      // 复位统一交给 finally
    } finally {
      if (epoch === chatEpoch) {
        chatLoading.value = false
        chatAbort = null
        stopChatWatchdog()
      }
    }
  }

  /** 统一发送入口：上一轮若卡 loading（完成事件丢失）先复位旧请求再发，保证按钮不会永久失效 */
  const unstickAndSend = () => {
    if (chatLoading.value && Date.now() - chatLastChunkAt < 5000) return // 仍在活跃生成
    if (chatLoading.value) {
      chatLoading.value = false
      if (chatAbort) { try { chatAbort.abort() } catch { /* ignore */ } chatAbort = null }
      stopChatWatchdog()
      const ipc = (window as any).ipcRenderer
      if (ipc?.invoke && lastReqId) ipc.invoke('ai:abort', { requestId: lastReqId }).catch(() => {})
    }
    chatComposing.value = false
    sendChatMessage()
  }

  const onChatKeyEnter = (e: KeyboardEvent) => {
    if ((e as any).isComposing || chatComposing.value) return
    unstickAndSend()
  }
  const sendChatClick = () => {
    chatComposing.value = false
    unstickAndSend()
  }

  const stopChat = () => { if (chatAbort) chatAbort.abort() }

  /** 删除单条消息；删的若是正在生成的那条，一并中止本次请求并让回调失效 */
  const removeChatMsg = (idx: number) => {
    if (!chatList.value[idx]) return
    if (chatLoading.value && idx === chatList.value.length - 1) {
      chatEpoch++   // 在途 chunk / onError 全部失效，避免写回或误删其他气泡
      if (chatAbort) { try { chatAbort.abort() } catch { /* ignore */ } chatAbort = null }
      stopChatWatchdog()
      chatLoading.value = false
    }
    chatList.value.splice(idx, 1)
  }

  const clearChat = () => {
    chatEpoch++          // 让在途回调失效，避免清空后被迟到的 chunk 重新写入
    if (chatAbort) { try { chatAbort.abort() } catch { /* ignore */ } chatAbort = null }
    stopChatWatchdog()
    chatList.value = []
    chatLoading.value = false
    chatInput.value = ''
    chatComposing.value = false
    chatStickBottom.value = true   // 新会话重新贴底跟随
  }

  const copyChatMsg = async (m: ChatMsg) => {
    const text = m.content || ''
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    ElMessage.success(store.locales === 'zh' ? '已复制' : 'Copied')
  }

  onBeforeUnmount(() => {
    chatEpoch++
    document.removeEventListener('mousedown', onDocMouseDown, true)
    if (metaTimer) { clearTimeout(metaTimer); metaTimer = null }
    if (chatAbort) { try { chatAbort.abort() } catch { /* ignore */ } }
    stopChatWatchdog()
  })
</script>

<template>
  <div class="dchat">
    <!-- 会话列表 -->
    <div ref="chatBodyRef" class="dchat-body scoll" @scroll.passive="onChatScroll">
      <div v-if="chatList.length === 0" class="dchat-empty">
        <i class="fa fa-commenting-o"></i>
        <div>{{ hint || (store.locales === 'zh' ? '对当前文档提问，可附全文 / 章节 / 选中文字' : 'Ask about this document (attach full text / section / selection)') }}</div>
        <div class="dchat-empty-sub">{{ store.locales === 'zh' ? '例如：总结全文要点 / 解释这一节的方法' : 'e.g. Summarize / explain this section' }}</div>
      </div>

      <div v-for="(m, idx) in chatList" :key="idx" class="dchat-row" :class="{ 'dchat-row-user': m.role === 'user' }">
        <div class="dchat-bubble">
          <div class="dchat-hdr">
            <i v-if="m.role === 'user'" class="fa fa-user dchat-user-ico"></i>
            <span class="dchat-name">{{ m.role === 'user' ? (store.locales === 'zh' ? '我' : 'Me') : 'AI' }}</span>
            <span v-if="m.role === 'user' && m.attachLabel" class="dchat-atc">· {{ m.attachLabel }}</span>
            <span class="dchat-sp"></span>
            <button v-if="m.role === 'assistant' && m.content" class="dchat-copy" :title="store.locales === 'zh' ? '复制 AI 回复' : 'Copy reply'" @click.stop="copyChatMsg(m)">
              <i class="fa fa-copy"></i>
            </button>
            <button class="dchat-del" :title="store.locales === 'zh' ? '删除这条消息' : 'Delete this message'" @click.stop="removeChatMsg(idx)">
              <i class="fa fa-times"></i>
            </button>
          </div>
          <div v-if="m.role === 'user' && m.content" class="dchat-text">{{ m.content }}</div>
          <div v-if="m.role === 'user' && m.truncated" class="dchat-trunc">
            <i class="fa fa-exclamation-triangle"></i>
            <span>{{ truncNote(m.truncated) }}</span>
          </div>
          <div v-if="m.role === 'user' && m.images && m.images.length" class="dchat-imgs">
            <div v-for="(img, ii) in m.images" :key="ii" class="dchat-img" :title="m.attachLabel || ''">
              <img :src="'data:image/jpeg;base64,' + img" alt="" />
              <span v-if="m.attachLabel">{{ m.attachLabel }}</span>
            </div>
          </div>
          <div v-if="m.role === 'assistant' && m.content" class="dchat-html" v-html="chatHtml(m.content)"></div>
          <div v-if="chatLoading && idx === chatList.length - 1" class="dchat-typing">
            <i class="fa fa-spinner fa-spin"></i> {{ store.locales === 'zh' ? '生成中…' : 'Thinking…' }}
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="dchat-input">
      <!-- 附带内容超限预警（悬浮附带按钮即会统计，超限时持续提示） -->
      <div v-if="attachOverLimitNote" class="dchat-selnote dchat-warnnote">
        <i class="fa fa-exclamation-triangle"></i>
        <span class="dchat-selnote-txt">{{ attachOverLimitNote }}</span>
      </div>
      <div v-if="selNote" class="dchat-selnote" :title="selSnapshot">
        <i class="fa fa-quote-left"></i>
        <span class="dchat-selnote-txt">{{ store.locales === 'zh' ? `已固定 ${selSnapshot.length} 字选中文字` : `${selSnapshot.length} chars pinned` }}</span>
        <button class="dchat-selnote-x" :title="store.locales === 'zh' ? '取消固定' : 'Clear'" @click="selSnapshot = ''">
          <i class="fa fa-times"></i>
        </button>
      </div>
      <textarea
        v-model="chatInput"
        rows="2"
        class="dchat-ta scoll"
        :placeholder="store.locales === 'zh' ? '输入问题，Enter 发送，Shift+Enter 换行…' : 'Ask anything, Enter to send, Shift+Enter for newline…'"
        @compositionstart="chatComposing = true"
        @compositionend="chatComposing = false"
        @keydown.enter.exact.prevent="onChatKeyEnter"
      ></textarea>
      <div class="dchat-actions">
        <button
          v-for="o in attachOptions"
          :key="o.key"
          class="dchat-chip"
          :class="{ active: chatAttach === o.key }"
          :title="chipTitle(o)"
          @mouseenter="loadAttachCount(o)"
          @mouseleave="hoverKey = ''"
          @mousedown.prevent
          @click="toggleAttach(o.key)"
        >
          <i class="fa" :class="o.icon"></i><span>{{ o.label }}</span>
        </button>
        <button v-if="chatLoading" class="dchat-mini" @click="stopChat" :title="store.locales === 'zh' ? '停止生成' : 'Stop'">
          <i class="fa fa-stop"></i>
        </button>
        <button class="dchat-mini" :disabled="!chatList.length" @click="clearChat" :title="store.locales === 'zh' ? '清空对话' : 'Clear chat'">
          <i class="fa fa-trash"></i>
        </button>
        <span class="dchat-spacer"></span>
        <button class="dchat-send" :disabled="!chatInput.trim()" @click="sendChatClick" :title="store.locales === 'zh' ? '发送 (Enter)' : 'Send (Enter)'">
          <i class="fa fa-paper-plane-o"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .dchat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--backgroundColor);
  }
  .dchat-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dchat-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--borderColor);
    text-align: center;
    font-size: 12px;
    padding: 0 12px;
  }
  .dchat-empty i {
    font-size: 26px;
    opacity: 0.5;
  }
  .dchat-empty-sub {
    font-size: 11px;
    opacity: 0.7;
  }
  /* ===== 消息行 ===== */
  .dchat-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    width: 100%;
  }
  .dchat-row-user {
    justify-content: flex-end;
  }
  .dchat-bubble {
    min-width: 0;
    max-width: 88%;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    overflow: hidden;
    /* 用户 / AI 消息统一无底色（与主聊天窗口 .message-item 一致），仅靠左右对齐与角色名区分 */
    background: transparent;
    color: var(--fontColor);
    font-size: 12px;
    line-height: 1.6;
    word-break: break-word;
  }
  .dchat-hdr {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    font-size: 10px;
    border-bottom: 1px dashed var(--borderColor);
  }
  .dchat-row-user .dchat-hdr {
    border-bottom-color: transparent;
    padding-bottom: 0;
  }
  .dchat-user-ico {
    color: var(--fontActiveColor);
    font-size: 11px;
  }
  .dchat-name {
    font-weight: 600;
    white-space: nowrap;
  }
  .dchat-row-user .dchat-name {
    color: var(--fontActiveColor);
  }
  .dchat-atc {
    color: var(--borderColor);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dchat-sp {
    flex: 1;
  }
  .dchat-copy {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: none;
    color: var(--borderColor);
    cursor: pointer;
    font-size: 11px;
    border-radius: 3px;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .dchat-row:hover .dchat-copy {
    display: inline-flex;
  }
  .dchat-copy:hover {
    color: var(--fontActiveColor);
    background: var(--backgroundColor);
  }
  /* 删除单条消息（用户 / AI 消息都有，常驻显示在右上角） */
  .dchat-del {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: none;
    color: var(--borderColor);
    cursor: pointer;
    font-size: 11px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.55;
    transition: all 0.15s ease;
  }
  .dchat-del:hover {
    opacity: 1;
    color: #e74c3c;
    background: var(--backgroundColor);
  }
  .dchat-text {
    white-space: pre-wrap;
    padding: 5px 8px;
  }
  /* 附带内容被截断的提醒（气泡内，紧跟在提问文字下方） */
  .dchat-trunc {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    margin: 0 8px 5px;
    padding: 3px 6px;
    border: 1px solid #e6a23c;
    border-radius: 4px;
    background: rgba(230, 162, 60, 0.12);
    color: #e6a23c;
    font-size: 11px;
    line-height: 1.5;
  }
  .dchat-trunc i { font-size: 10px; margin-top: 2px; }
  .dchat-html {
    padding: 5px 8px;
    font-size: 13px;
  }
  .dchat-html :deep(p) { margin: 4px 0; }
  .dchat-html :deep(h1),
  .dchat-html :deep(h2),
  .dchat-html :deep(h3),
  .dchat-html :deep(h4),
  .dchat-html :deep(h5),
  .dchat-html :deep(h6) {
    font-size: 14px;
    font-weight: 600;
    margin: 6px 0 4px;
    line-height: 1.4;
  }
  .dchat-html :deep(ul),
  .dchat-html :deep(ol) {
    margin: 4px 0;
    padding-left: 18px;
  }
  .dchat-html :deep(li) { margin: 2px 0; }
  .dchat-html :deep(a) { color: var(--fontActiveColor); }
  .dchat-html :deep(blockquote) {
    margin: 4px 0;
    padding: 2px 10px;
    border-left: 3px solid var(--borderColor);
    color: var(--borderColor);
  }
  .dchat-html :deep(pre),
  .dchat-html :deep(pre.hljs) {
    background: var(--inputColor);
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    padding: 6px 8px;
    overflow-x: auto;
    margin: 4px 0;
    color: var(--fontColor);
  }
  .dchat-html :deep(code) { font-size: 12px; }
  .dchat-html :deep(table) {
    border-collapse: collapse;
    margin: 4px 0;
    width: 100%;
  }
  .dchat-html :deep(th),
  .dchat-html :deep(td) {
    border: 1px solid var(--borderColor);
    padding: 3px 6px;
    text-align: left;
  }
  .dchat-html :deep(img) { max-width: 100%; }
  /* 附带的多模态图片（如 PDF 当前页截图） */
  .dchat-imgs {
    display: flex;
    gap: 4px;
    padding: 0 8px 5px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .dchat-img {
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    overflow: hidden;
    max-width: 130px;
  }
  .dchat-img img {
    display: block;
    width: 100%;
    cursor: zoom-in;
  }
  .dchat-img span {
    display: block;
    text-align: center;
    font-size: 10px;
    padding: 1px 0;
    background: var(--backgroundColor);
    color: var(--borderColor);
  }
  .dchat-typing {
    color: var(--borderColor);
    font-size: 11px;
    padding: 0 8px 5px;
  }

  /* ===== 输入区 ===== */
  .dchat-input {
    flex-shrink: 0;
    border-top: 1px solid var(--borderColor);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: var(--backgroundColor);
  }
  .dchat-ta {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    max-height: 120px;
    resize: vertical;
    padding: 6px 8px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    background: var(--inputColor);
    color: var(--fontColor);
    font-size: 12px;
    font-family: inherit;
    line-height: 1.5;
    outline: none;
    margin: 0;
  }
  .dchat-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .dchat-chip {
    width: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: 11px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background: var(--backgroundColor);
    color: var(--fontColor);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
  }
  .dchat-chip:hover {
    background: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .dchat-chip.active {
    background: var(--menuColor);
    border-color: var(--fontActiveColor);
    color: var(--fontActiveColor);
  }
  .dchat-chip i { font-size: 10px; }
  .dchat-mini,
  .dchat-send {
    width: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    padding: 0 7px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background: var(--backgroundColor);
    color: var(--fontColor);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .dchat-mini:hover:not(:disabled),
  .dchat-send:hover:not(:disabled) {
    background: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .dchat-mini:disabled,
  .dchat-send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .dchat-send {
    padding: 0 10px;
  }
  .dchat-spacer { flex: 1; }
  /* 「已固定选中文字」提示（点输入框失焦后选区内容依然会附带） */
  .dchat-selnote {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 6px;
    border: 1px dashed var(--borderColor);
    border-radius: 4px;
    background: var(--menuColor);
    color: var(--fontColor);
    font-size: 11px;
    opacity: 0.85;
  }
  .dchat-selnote i { font-size: 10px; opacity: 0.8; }
  .dchat-selnote-txt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dchat-selnote-x {
    width: auto;
    padding: 0 2px;
    border: none;
    background: none;
    color: var(--fontColor);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
  }
  .dchat-selnote-x:hover { opacity: 1; color: #e74c3c; }
  /* 附带内容超出上限的预警（与上方固定选区提示同位置，样式改为警告色） */
  .dchat-warnnote {
    border-color: #e6a23c;
    border-style: solid;
    color: #e6a23c;
    opacity: 1;
  }
</style>
