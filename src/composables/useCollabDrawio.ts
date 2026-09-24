/**
 * useCollabDrawio.ts — draw.io 图表（.drawio）协同会话
 *
 * 复用主进程 collab-service 的 WS 协议与房间机制（kind='drawio'），同步走 drawio
 * **官方 diff 协议**（embed 模式的 diffSync），不依赖 drawio 内部对象：
 *   - 进入会话：用权威 XML 执行一次 load 动作并带 diffSync:true，建立共同基准
 *   - 本地编辑：autosave / save 回传的 { patch, xml } → 只把 patch 广播出去
 *   - 远端 patch：{ action:'patch', patch } 应用到本地编辑器
 *
 * 拓扑：**网状中继**（服务端把 patch 转发给除发送者外的所有成员）。
 * 实测结论：应用远端 patch 会同步更新编辑器内部 shadow，之后不会再产生 diff，
 * 因此不会回声再广播；各成员靠 drawio 自身的 diff 协议收敛。
 *
 * 宿主（共享者）额外上报「完整 XML」：新成员加入时的权威快照、周期写盘都用它。
 * 宿主应用远端 patch 不会触发 autosave，所以它按需现导（见 scheduleHostXmlUpload）。
 */
import { ref, readonly } from 'vue'
import { usestore } from '@/store'
import type { CollabMember } from '@/types/collab'

/** 主进程 collab-service 发出的中文文案 → 英文（英文界面下避免中英混排） */
const SERVER_MSG_EN: Record<string, string> = {
  '当前无编辑权限': 'No edit permission in this session',
  '服务已停止': 'Collaboration service stopped',
  '主机已停止共享': 'The host stopped sharing',
  '会话已结束': 'Session ended',
}

export type CollabSessionStatus = 'idle' | 'connecting' | 'connected'

/** 宿主组件（Drawio.vue）需要实现的桥接能力 */
export interface DrawioCollabBridge {
  /** 编辑器是否已就绪（可接收 load / patch） */
  isReady(): boolean
  /** 应用远端增量 patch */
  applyPatch(patch: any): void
  /** 用权威 XML 重建编辑器内容并开启 diffSync（进入会话 / 重同步） */
  loadShared(xml: string): void
  /** 导出当前完整 XML（宿主上报 / 写盘前） */
  exportXml(): Promise<string>
  /** 权限变化：只读成员应阻断编辑交互 */
  setEditable(editable: boolean): void
}

export interface CollabDrawioController {
  status: Readonly<import('vue').Ref<CollabSessionStatus>>
  isHost: Readonly<import('vue').Ref<boolean>>
  canEdit: Readonly<import('vue').Ref<boolean>>
  roomId: Readonly<import('vue').Ref<string | null>>
  roomToken: Readonly<import('vue').Ref<string>>
  members: Readonly<import('vue').Ref<CollabMember[]>>
  error: Readonly<import('vue').Ref<string>>
  pendingEditRequests: Readonly<import('vue').Ref<CollabMember[]>>
  /** 宿主：共享当前图表并进入会话（content 必须是当前编辑器的完整 XML） */
  startHost(
    bridge: DrawioCollabBridge,
    filePath: string,
    content: string,
    opts?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; name?: string },
  ): Promise<boolean>
  /** 客户端：加入会话 */
  join(bridge: DrawioCollabBridge, url: string, name: string): Promise<boolean>
  /** 由宿主组件的 autosave / save 回调调用（会话中） */
  handleLocalDiff(patch: any, xml?: string): void
  /** 请求服务端写盘（仅宿主） */
  save(): Promise<boolean>
  /** 宿主整体重建内容后（如 AI 插入图形），让全体成员重建 diff 基准 */
  resync(xml: string): void
  leave(): void
  requestEdit(): void
  grantEdit(memberId: string): void
  denyEdit(memberId: string): void
  clearEditRequest(memberId: string): void
  onClosed(cb: (reason: string) => void): void
  destroy(): void
}

export function useCollabDrawio(): CollabDrawioController {
  const store = usestore()
  /** 中英文案选择：跟随应用语言（store.locales） */
  const t = (zh: string, en: string) => (store.locales === 'zh' ? zh : en)
  /** 主进程文案映射（未知文案原样返回） */
  const serverText = (m: string) => (store.locales === 'zh' ? m : SERVER_MSG_EN[m] || m)

  const status = ref<CollabSessionStatus>('idle')
  const isHost = ref(false)
  const canEdit = ref(false)
  const roomId = ref<string | null>(null)
  const roomToken = ref('')
  const members = ref<CollabMember[]>([])
  const error = ref('')
  const pendingEditRequests = ref<CollabMember[]>([])

  let bridge: DrawioCollabBridge | null = null
  let ws: WebSocket | null = null
  let ownMemberId = ''
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let hostXmlTimer: ReturnType<typeof setTimeout> | null = null
  let closedCb: ((reason: string) => void) | null = null
  let pendingConnect: ((ok: boolean) => void) | null = null
  let saveResolve: ((ok: boolean) => void) | null = null
  /** 是否已拿到权威快照：此前收到的 patch 先入队，快照应用后再补放 */
  let synced = false
  let patchQueue: any[] = []

  function sendWs(msg: Record<string, any>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg))
      } catch (e) {
        console.warn('[collab-drawio] 发送失败:', e)
      }
    }
  }

  function applyPermission() {
    bridge?.setEditable(canEdit.value)
  }

  /** 宿主应用远端 patch 后不会触发 autosave，这里主动现导一份上报给服务端（延迟合并） */
  function scheduleHostXmlUpload() {
    if (!isHost.value) return
    if (hostXmlTimer) clearTimeout(hostXmlTimer)
    hostXmlTimer = setTimeout(async () => {
      hostXmlTimer = null
      if (status.value !== 'connected' || !bridge?.isReady()) return
      try {
        const xml = await bridge.exportXml()
        if (xml) sendWs({ type: 'drawio-xml', xml })
      } catch (e) {
        console.warn('[collab-drawio] 上报权威 XML 失败:', e)
      }
    }, 800)
  }

  /** 本地编辑：广播增量 patch（宿主附上完整 XML，供服务端保存/新人同步） */
  function handleLocalDiff(patch: any, xml?: string) {
    if (status.value !== 'connected' || !canEdit.value) return
    if (!patch || typeof patch !== 'object') return
    if (isHost.value && xml) sendWs({ type: 'drawio-diff', patch, xml })
    else sendWs({ type: 'drawio-diff', patch })
  }

  /** 收到权威快照：重建编辑器内容并开启 diffSync，随后补放等待期间的 patch */
  async function applySync(xml: string) {
    if (!bridge) return
    if (xml && xml.trim()) bridge.loadShared(xml)
    synced = true
    if (patchQueue.length) {
      const queued = patchQueue
      patchQueue = []
      // 补放的 patch 可能已包含在快照里，重复应用是幂等的（drawio 按 cell id 更新）
      queued.forEach((p) => bridge?.applyPatch(p))
    }
    status.value = 'connected'
    applyPermission()
    if (pendingConnect) {
      pendingConnect(true)
      pendingConnect = null
    }
  }

  function handleMessage(msg: any) {
    if (!msg || typeof msg.type !== 'string') return
    switch (msg.type) {
      case 'welcome': {
        ownMemberId = msg.memberId || ''
        isHost.value = !!msg.isHost
        members.value = Array.isArray(msg.members) ? msg.members : []
        const me = members.value.find((m) => m.id === ownMemberId)
        canEdit.value = me ? me.canEdit : true
        break
      }
      case 'snapshot':
        // drawio 房间不使用 Yjs 文档，快照为空；此处不改变状态
        break
      case 'drawio-sync': {
        void applySync(String(msg.xml || ''))
        break
      }
      case 'drawio-diff': {
        if (!synced) {
          // 快照未到：先入队（快照之后的补放保证不丢改动）
          if (msg.patch && patchQueue.length < 200) patchQueue.push(msg.patch)
          break
        }
        if (msg.patch && typeof msg.patch === 'object') {
          bridge?.applyPatch(msg.patch)
          // 宿主负责维护权威 XML（远端改动不会触发它的 autosave）
          scheduleHostXmlUpload()
        }
        break
      }
      case 'drawio-need-sync': {
        // 服务端让宿主现导一份权威 XML 给新加入/重同步的成员
        if (!isHost.value || !bridge?.isReady()) return
        void bridge.exportXml().then((xml) => {
          if (xml) sendWs({ type: 'drawio-xml', xml })
        })
        break
      }
      case 'members': {
        members.value = Array.isArray(msg.members) ? msg.members : []
        const me = members.value.find((m) => m.id === ownMemberId)
        if (me) {
          canEdit.value = me.canEdit
          if (me.role === 'host') isHost.value = true
        }
        applyPermission()
        break
      }
      case 'role': {
        if (msg.denied) {
          error.value = t('编辑请求被拒绝', 'Edit request denied')
        } else {
          canEdit.value = !!msg.canEdit
        }
        applyPermission()
        break
      }
      case 'host': {
        isHost.value = msg.hostId === ownMemberId
        break
      }
      case 'edit-request': {
        if (msg.member) pendingEditRequests.value = [...pendingEditRequests.value, msg.member]
        break
      }
      case 'saved': {
        if (saveResolve) {
          saveResolve(!!msg.ok)
          saveResolve = null
        }
        break
      }
      case 'closed': {
        teardown(serverText(msg.reason || '会话已结束'))
        break
      }
      case 'error': {
        error.value = serverText(msg.message || '发生错误')
        break
      }
      default:
        break
    }
  }

  function connect(url: string, name: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line no-new
        new URL(url)
      } catch {
        error.value = t('协同地址无效', 'Invalid collaboration URL')
        status.value = 'idle'
        resolve(false)
        return
      }
      const socket = new WebSocket(url)
      ws = socket
      status.value = 'connecting'
      error.value = ''
      synced = false
      patchQueue = []
      pendingConnect = resolve

      socket.onopen = () => {
        sendWs({ type: 'hello', name: name || t('匿名', 'Anonymous') })
      }
      socket.onmessage = (ev) => {
        try {
          handleMessage(JSON.parse(ev.data))
        } catch (e) {
          console.warn('[collab-drawio] 解析消息失败:', e)
        }
      }
      socket.onerror = () => { /* onclose 统一处理 */ }
      socket.onclose = () => {
        if (pendingConnect) {
          const m = error.value || t('无法连接协同服务', 'Cannot reach the collaboration service')
          pendingConnect(false)
          pendingConnect = null
          teardown(m)
        } else if (status.value === 'connected') {
          teardown(t('连接已断开', 'Connection lost'))
        } else if (status.value === 'connecting') {
          teardown(error.value || t('连接已关闭', 'Connection closed'))
        }
      }

      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) sendWs({ type: 'ping' })
      }, 10000)
    })
  }

  function teardown(reason: string) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (hostXmlTimer) {
      clearTimeout(hostXmlTimer)
      hostXmlTimer = null
    }
    if (ws) {
      try {
        ws.onclose = null
        ws.close()
      } catch { /* ignore */ }
      ws = null
    }
    if (pendingConnect) {
      pendingConnect(false)
      pendingConnect = null
    }
    if (saveResolve) {
      saveResolve(false)
      saveResolve = null
    }
    bridge = null
    synced = false
    patchQueue = []
    status.value = 'idle'
    isHost.value = false
    canEdit.value = false
    roomId.value = null
    roomToken.value = ''
    members.value = []
    pendingEditRequests.value = []
    if (closedCb) {
      const cb = closedCb
      closedCb = null
      cb(reason)
    }
  }

  async function startHost(
    b: DrawioCollabBridge,
    filePath: string,
    content: string,
    opts: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; name?: string } = {},
  ): Promise<boolean> {
    if (status.value !== 'idle') return false
    if (!window.dsh?.collab) {
      error.value = t('协同服务不可用', 'Collaboration service unavailable')
      return false
    }
    try {
      const res = await window.dsh.collab.shareFile(filePath, content, { ...opts, kind: 'drawio' })
      roomId.value = res.roomId
      roomToken.value = res.token || ''
      bridge = b
      const ok = await connect(res.url, opts.name?.trim() || t('主机', 'Host'))
      if (!ok) {
        roomId.value = null
        roomToken.value = ''
        return false
      }
      return true
    } catch (e: any) {
      error.value = e?.message || String(e)
      status.value = 'idle'
      return false
    }
  }

  async function join(b: DrawioCollabBridge, url: string, name: string): Promise<boolean> {
    if (status.value !== 'idle') return false
    bridge = b
    return connect(url, name)
  }

  function leave() {
    if (status.value === 'idle') return
    teardown('left')
  }

  /** 宿主写盘：先现导一份权威 XML 上报（WS 有序，服务端会先存后写），再请求保存 */
  async function save(): Promise<boolean> {
    if (status.value !== 'connected' || !ws) return false
    if (isHost.value && bridge?.isReady()) {
      try {
        const xml = await bridge.exportXml()
        if (xml) sendWs({ type: 'drawio-xml', xml })
      } catch { /* ignore */ }
    }
    return new Promise((resolve) => {
      saveResolve = resolve
      sendWs({ type: 'save-request' })
    })
  }

  /**
   * 宿主整体重建内容（如 AI 插入图形走 load 而非增量 patch）后，
   * 让服务端把新内容下发给全体成员重建 diff 基准 —— 否则各方基准不一致会逐步漂移。
   */
  function resync(xml: string) {
    if (status.value !== 'connected' || !isHost.value) return
    if (!xml || !xml.trim()) return
    sendWs({ type: 'drawio-resync', xml })
  }

  function requestEdit() {
    sendWs({ type: 'request-edit' })
  }

  function grantEdit(memberId: string) {
    sendWs({ type: 'grant-edit', memberId })
  }

  function denyEdit(memberId: string) {
    sendWs({ type: 'deny-edit', memberId })
  }

  function clearEditRequest(memberId: string) {
    pendingEditRequests.value = pendingEditRequests.value.filter((m) => m.id !== memberId)
  }

  function onClosed(cb: (reason: string) => void) {
    closedCb = cb
  }

  function destroy() {
    if (status.value !== 'idle') teardown('left')
  }

  return {
    status: readonly(status) as Readonly<import('vue').Ref<CollabSessionStatus>>,
    isHost: readonly(isHost),
    canEdit: readonly(canEdit),
    roomId: readonly(roomId),
    roomToken: readonly(roomToken),
    members: readonly(members) as Readonly<import('vue').Ref<CollabMember[]>>,
    error: readonly(error),
    pendingEditRequests: readonly(pendingEditRequests) as Readonly<import('vue').Ref<CollabMember[]>>,

    startHost,
    join,
    handleLocalDiff,
    save,
    resync,
    leave,
    requestEdit,
    grantEdit,
    denyEdit,
    clearEditRequest,
    onClosed,
    destroy,
  }
}
