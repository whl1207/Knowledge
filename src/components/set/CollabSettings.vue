<!-- 协作设置模块（独立 vue）：协同文件编辑 + 共享文件夹 + 局域网共享（含共享知识库目录）。
     原为 Set.vue「基础-协作」内联内容，抽离为独立组件，便于复用/单独维护。 -->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { buildLanEmbedPayload } from '@/platform/lanKb'

interface Props {
  store: any
}
const props = defineProps<Props>()
const store = props.store
const t = (zh: string, en: string): string => (store.locales === 'zh' ? zh : en)

// ==================== 局域网共享（静态网页分享） ====================
const lanServerRunning = ref(false)
const lanServerPort = ref(3345)
const lanServerIPs = ref<string[]>([])
// 知识库共享目录（存于 store.lan.kbDir，同时同步到主进程供 LAN HTTP 服务读取）
// 防御：旧存档/异常情况 store.lan 缺失时先补齐默认结构
if (!store.lan) store.lan = { kbDir: '' }
const lanKbDir = ref<string>(store.lan?.kbDir || '')

// 监听局域网服务器状态变化
const unsubLan: Array<() => void> = []
if (window.ipcRenderer) {
  const onLan = (_event: any, status: any) => {
    lanServerRunning.value = status.running
    lanServerPort.value = status.port
    lanServerIPs.value = status.ips
  }
  window.ipcRenderer.on('lan-server-status', onLan)
  unsubLan.push(() => window.ipcRenderer.removeListener('lan-server-status', onLan))
}

// 获取局域网服务器状态
const refreshLanServerInfo = async () => {
  if (!window.ipcRenderer) return
  try {
    const info = await window.ipcRenderer.invoke('getLanServerInfo')
    lanServerRunning.value = info.running
    lanServerPort.value = info.port
    lanServerIPs.value = info.ips
  } catch (e) {
    console.error('获取局域网服务器信息失败:', e)
  }
}

// 把「知识库共享目录 + 主机嵌入配置」同步到主进程（LAN HTTP 服务据此提供 /api/kb/*）
const syncLanKbToMain = async () => {
  if (!window.ipcRenderer) return
  try {
    await window.ipcRenderer.invoke('lan:setKbDir', lanKbDir.value || '')
    // 主机嵌入配置：供远端网页端对共享 .kb 做向量检索（维度与建库模型一致）
    await window.ipcRenderer.invoke('lan:setEmbed', buildLanEmbedPayload(store))
  } catch (e) {
    console.warn('同步局域网知识库配置失败:', e)
  }
}

// 选择知识库共享目录
const chooseLanKbDir = async () => {
  if (!window.ipcRenderer) return
  try {
    const p = await window.ipcRenderer.invoke('openFolderDialog')
    if (p) {
      lanKbDir.value = p
      store.lan.kbDir = p
      store.saveConfig()
      await syncLanKbToMain()
      ElMessage.success(t('知识库共享目录已设置', 'KB share folder set'))
    }
  } catch (e) {
    console.error('选择知识库共享目录失败:', e)
  }
}

// 启动局域网共享（启动前同步知识库目录/嵌入配置，网页端即可使用）
const startLanServer = async () => {
  if (!window.ipcRenderer) return
  try {
    await syncLanKbToMain()
    const result = await window.ipcRenderer.invoke('startLanServer', lanServerPort.value)
    if (result.success) {
      ElMessage.success(t('局域网共享已启动', 'LAN sharing started'))
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

// 停止局域网共享
const stopLanServer = async () => {
  if (!window.ipcRenderer) return
  try {
    const result = await window.ipcRenderer.invoke('stopLanServer')
    if (result.success) {
      ElMessage.success(t('局域网共享已停止', 'LAN sharing stopped'))
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

// ==================== 协同文件编辑服务 ====================
const collabServerRunning = ref(false)
const collabServerPort = ref(3346)
const collabServerIPs = ref<string[]>([])

// 协同服务运行状态 ⇄ 「显示协同入口」开关：运行中即启用，停止即关闭
const syncCollabEnabled = (running: boolean) => {
  if (store.collab.enabled !== running) {
    store.collab.enabled = running
    store.saveConfig()
  }
}

if (window.dsh?.collab) {
  window.dsh.collab.onStatus((status: any) => {
    collabServerRunning.value = status.running
    collabServerPort.value = status.port
    collabServerIPs.value = status.ips
    syncCollabEnabled(status.running)
  })
}

const refreshCollabServerInfo = async () => {
  if (!window.dsh?.collab) return
  try {
    const info = await window.dsh.collab.getStatus()
    collabServerRunning.value = info.running
    collabServerPort.value = info.port
    collabServerIPs.value = info.ips
    syncCollabEnabled(info.running)
  } catch (e) {
    console.error('获取协同服务信息失败:', e)
  }
}

const startCollabServer = async () => {
  if (!window.dsh?.collab) {
    ElMessage.error(t('协同服务不可用', 'Collab service unavailable'))
    return
  }
  try {
    const result = await window.dsh.collab.start({
      port: store.collab.port,
      maxMembers: store.collab.maxMembers,
      permissionMode: store.collab.permissionMode,
    })
    if (result.success) {
      ElMessage.success(t('协同服务已启动', 'Collab service started'))
      syncCollabEnabled(true)
      if (result.port) {
        store.collab.port = result.port
        store.saveConfig()
      }
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

const stopCollabServer = async () => {
  if (!window.dsh?.collab) return
  try {
    const result = await window.dsh.collab.stop()
    if (result.success) {
      ElMessage.success(t('协同服务已停止', 'Collab service stopped'))
      syncCollabEnabled(false)
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

const regenerateCollabToken = () => {
  const chars = '0123456789abcdef'
  let token = ''
  for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)]
  store.collab.token = token
  store.saveConfig()
  ElMessage.success(t('已生成新的房间 Token', 'New room token generated'))
}

// ==================== 远程文件共享（共享文件夹，客户端可只读预览/下载） ====================
const remoteFsRunning = ref(false)
const remoteFsPort = ref(3347)
const remoteFsIPs = ref<string[]>([])

if (window.dsh?.remoteFs) {
  window.dsh.remoteFs.onStatus((status: any) => {
    remoteFsRunning.value = status.running
    remoteFsPort.value = status.port
    remoteFsIPs.value = status.ips
  })
}

const refreshRemoteFsInfo = async () => {
  if (!window.dsh?.remoteFs) return
  try {
    const info = await window.dsh.remoteFs.getStatus()
    remoteFsRunning.value = info.running
    remoteFsPort.value = info.port
    remoteFsIPs.value = info.ips
  } catch (e) {
    console.error('获取远程文件共享信息失败:', e)
  }
}

const chooseRemoteFsRoot = async () => {
  const path = await window.ipcRenderer.invoke('openFolderDialog')
  if (path) {
    store.remoteFs.rootDir = path
    store.saveConfig()
  }
}

const startRemoteFsServer = async () => {
  if (!window.dsh?.remoteFs) {
    ElMessage.error(t('远程文件共享服务不可用', 'Remote FS service unavailable'))
    return
  }
  if (!store.remoteFs.rootDir) {
    ElMessage.warning(t('请先选择要共享的文件夹', 'Choose a folder to share first'))
    return
  }
  try {
    const result = await window.dsh.remoteFs.start({
      port: store.remoteFs.port,
      rootDir: store.remoteFs.rootDir,
      token: store.remoteFs.token || undefined,
    })
    if (result.success) {
      if (result.port) store.remoteFs.port = result.port
      if (result.token) store.remoteFs.token = result.token
      store.remoteFs.enabled = true
      store.saveConfig()
      ElMessage.success(t('远程文件共享已启动', 'Remote FS started'))
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

const stopRemoteFsServer = async () => {
  if (!window.dsh?.remoteFs) return
  try {
    const result = await window.dsh.remoteFs.stop()
    if (result.success) {
      store.remoteFs.enabled = false
      store.saveConfig()
      ElMessage.success(t('远程文件共享已停止', 'Remote FS stopped'))
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

const regenerateRemoteFsToken = () => {
  const chars = '0123456789abcdef'
  let token = ''
  for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)]
  store.remoteFs.token = token
  store.saveConfig()
  ElMessage.success(t('已生成新的访问 Token', 'New access token generated'))
}

// ==================== 连接信息复制 ====================
const copyToClipboardText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('链接已复制', 'Link copied'))
  } catch {
    ElMessage.error(t('复制失败', 'Copy failed'))
  }
}
const copyLanLink = (ip: string) => copyToClipboardText(`http://${ip}:${lanServerPort.value}`)
const copyCollabLink = (ip: string) => copyToClipboardText(`ws://${ip}:${collabServerPort.value}/collab/<房间号>?token=${store.collab.token || ''}`)
const copyRemoteFsLink = (ip: string) => copyToClipboardText(`remote-fs://${ip}:${remoteFsPort.value}?token=${store.remoteFs.token || ''}`)

// 初始化：刷新三项服务状态 + 把知识库目录/嵌入配置同步到主进程
onMounted(async () => {
  await refreshLanServerInfo()
  await refreshCollabServerInfo()
  await refreshRemoteFsInfo()
  await syncLanKbToMain()
})

onBeforeUnmount(() => {
  unsubLan.forEach(fn => { try { fn() } catch { /* ignore */ } })
})
</script>

<template>
  <div class="settings-section collab-settings">
    <!-- 局域网共享（网页端访问入口；含知识库共享目录） -->
    <div class="settings-group">
      <h3>{{ store.locales=='zh'?'局域网共享' : 'LAN Sharing' }}</h3>
      <!-- 操作（第一行，状态显示在操作右侧） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!lanServerRunning" class="button" @click="startLanServer"
                 :title="store.locales=='zh'?'启动局域网共享' : 'Start LAN sharing'">
              <i class="fa fa-globe"></i> {{ store.locales=='zh'?'启动共享' : 'Start' }}
            </div>
            <div v-if="lanServerRunning" class="button" @click="stopLanServer"
                 :title="store.locales=='zh'?'停止局域网共享' : 'Stop LAN sharing'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止共享' : 'Stop' }}
            </div>
            <div class="button" @click="refreshLanServerInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: lanServerRunning, offline: !lanServerRunning }">
            <i :class="lanServerRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ lanServerRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
            <span v-if="lanServerRunning && lanServerPort" class="status-port">:{{ lanServerPort }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="lanServerPort" type="number" min="1024" max="65535"
               :disabled="lanServerRunning"
               :placeholder="store.locales=='zh'?'端口号' : 'Port number'"/>
      </div>
      <!-- 知识库共享目录（网页端知识库模式可选择该目录里的 .kb） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'知识库目录' : 'KB Folder' }}</label>
        <div class="input-with-button">
          <input v-model="lanKbDir" readonly
                 :placeholder="store.locales=='zh'?'选择放置 .kb 知识库的文件夹' : 'Choose folder containing .kb files'"/>
          <div class="button" style="width:auto;padding:0 8px;" @click="chooseLanKbDir"
               :title="store.locales=='zh'?'选择文件夹':'Choose folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div v-if="lanServerRunning && lanServerIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'访问地址' : 'Access URL' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in lanServerIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-globe"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyLanLink(ip)">http://{{ ip }}:{{ lanServerPort }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyLanLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '启动后其他设备可通过浏览器访问上方地址使用聊天。若设置了「知识库目录」，远端网页端在 home 知识库模式可从该目录选择现有的 .kb 使用，或上传自己的文件作为知识库。文件浏览、设置等桌面专属功能在远程浏览器中不可用。'
            : 'Expose the chat interface to LAN. Remote devices open the URL above in a browser. If a "KB Folder" is set, remote users in home KB mode can pick an existing .kb from it, or upload their own files as a KB. File browsing, settings and other desktop-only features are unavailable in remote browsers.' }}
        </div>
      </div>
    </div>

    <!-- 协同文件编辑 -->
    <div class="settings-group">
      <h3>{{ store.locales=='zh'?'协同文件编辑' : 'Collaborative Editing' }}</h3>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!collabServerRunning" class="button" @click="startCollabServer"
                 :title="store.locales=='zh'?'启动协同服务' : 'Start collab service'">
              <i class="fa fa-play"></i> {{ store.locales=='zh'?'启动服务' : 'Start' }}
            </div>
            <div v-if="collabServerRunning" class="button" @click="stopCollabServer"
                 :title="store.locales=='zh'?'停止协同服务' : 'Stop collab service'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止服务' : 'Stop' }}
            </div>
            <div class="button" @click="refreshCollabServerInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: collabServerRunning, offline: !collabServerRunning }">
            <i :class="collabServerRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ collabServerRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
            <span v-if="collabServerRunning && collabServerPort" class="status-port">:{{ collabServerPort }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="store.collab.port" type="number" min="1024" max="65535"
               :disabled="collabServerRunning"
               :placeholder="store.locales=='zh'?'协同服务端口' : 'Collab port'"/>
      </div>
      <div v-if="collabServerRunning && collabServerIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'连接地址' : 'Address' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in collabServerIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-link"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyCollabLink(ip)">ws://{{ ip }}:{{ collabServerPort }}/collab/&lt;房间号&gt;?token={{ store.collab.token || '' }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyCollabLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'最大成员数' : 'Max Members' }}</label>
        <input v-model.number="store.collab.maxMembers" type="number" min="2" max="20"
               :disabled="collabServerRunning"
               :placeholder="store.locales=='zh'?'2~20' : '2-20'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'编辑权限' : 'Edit Permission' }}</label>
        <div class="environment-selector">
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'open' }"
               @click="store.collab.permissionMode='open'; store.saveConfig()"
               :title="store.locales=='zh' ? '所有成员加入即可编辑' : 'Everyone can edit on join'">
            <i class="fa fa-unlock"></i>
            <span>{{ store.locales=='zh' ? '开放编辑' : 'Open' }}</span>
          </div>
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'approve' }"
               @click="store.collab.permissionMode='approve'; store.saveConfig()"
               :title="store.locales=='zh' ? '加入为只读，需主机批准后才能编辑' : 'Join as read-only; host approval required to edit'">
            <i class="fa fa-handshake-o"></i>
            <span>{{ store.locales=='zh' ? '请求-批准' : 'Approve' }}</span>
          </div>
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'readonly' }"
               @click="store.collab.permissionMode='readonly'; store.saveConfig()"
               :title="store.locales=='zh' ? '所有人只读，仅主机可编辑' : 'Read-only for all except host'">
            <i class="fa fa-eye"></i>
            <span>{{ store.locales=='zh' ? '只读' : 'Read-only' }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'房间 Token' : 'Room Token' }}</label>
        <div class="input-with-button">
          <input v-model="store.collab.token" :disabled="collabServerRunning"
                 :placeholder="store.locales=='zh'?'加入房间时需要输入的凭证' : 'Token required to join'"/>
          <div class="button" style="width:20px;" @click="regenerateCollabToken"
               :title="store.locales=='zh'?'重新生成':'Regenerate'">
            <i class="fa fa-refresh"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'自动保存间隔（秒）' : 'Auto-save (seconds)' }}</label>
        <input v-model.number="store.collab.autoSaveSeconds" type="number" min="5" max="600"
               :placeholder="store.locales=='zh'?'主机写盘间隔' : 'Host save interval'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'客户端名称' : 'Client Name' }}</label>
        <input v-model="store.collab.nickname" maxlength="20"
               :placeholder="store.locales=='zh'?'连接后显示的名称（默认：主机/访客）' : 'Name shown after connect (default: Host/Guest)'"/>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '在代码编辑器状态栏点击协同图标可「共享此文件」或「加入会话」。共享者（主机）负责将文档写盘，其他成员通过局域网实时协同编辑；需要房间 Token 才能加入。'
            : 'Click the collab icon in the code editor status bar to share a file or join a session. The host writes the document to disk; others edit in real time over LAN. A room token is required to join.' }}
        </div>
      </div>
    </div>

    <!-- 共享文件夹（远程只读文件服务，客户端可添加远程工作区预览/下载） -->
    <div class="settings-group">
      <h3>{{ store.locales=='zh'?'共享文件夹' : 'Shared Folder' }}</h3>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!remoteFsRunning" class="button" @click="startRemoteFsServer"
                 :title="store.locales=='zh'?'启动共享文件夹服务' : 'Start shared folder service'">
              <i class="fa fa-cloud"></i> {{ store.locales=='zh'?'启动共享' : 'Start' }}
            </div>
            <div v-if="remoteFsRunning" class="button" @click="stopRemoteFsServer"
                 :title="store.locales=='zh'?'停止共享文件夹服务' : 'Stop shared folder service'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止共享' : 'Stop' }}
            </div>
            <div class="button" @click="refreshRemoteFsInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: remoteFsRunning, offline: !remoteFsRunning }">
            <i :class="remoteFsRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ remoteFsRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'共享目录' : 'Folder' }}</label>
        <div class="input-with-button">
          <input v-model="store.remoteFs.rootDir" :disabled="remoteFsRunning"
                 :placeholder="store.locales=='zh'?'选择要共享的文件夹' : 'Choose folder to share'"/>
          <div class="button" style="width:auto;padding:0 8px;" @click="chooseRemoteFsRoot" :disabled="remoteFsRunning"
               :title="store.locales=='zh'?'选择文件夹':'Choose folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="store.remoteFs.port" type="number" min="1024" max="65535"
               :disabled="remoteFsRunning"
               :placeholder="store.locales=='zh'?'默认 3347' : 'Default 3347'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'访问 Token' : 'Token' }}</label>
        <div class="input-with-button">
          <input v-model="store.remoteFs.token" :disabled="remoteFsRunning"
                 :placeholder="store.locales=='zh'?'客户端添加远程工作区时的凭据' : 'Credential for clients'"/>
          <div class="button" style="width:20px;" @click="regenerateRemoteFsToken"
               :title="store.locales=='zh'?'重新生成':'Regenerate'">
            <i class="fa fa-refresh"></i>
          </div>
        </div>
      </div>
      <div v-if="remoteFsRunning && remoteFsIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'连接信息' : 'Connection' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in remoteFsIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-cloud"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyRemoteFsLink(ip)">remote-fs://{{ ip }}:{{ remoteFsPort }}?token={{ store.remoteFs.token || '' }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyRemoteFsLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '客户端在「知识管理 → 文件树空白处右键 → 添加远程工作区」中粘贴上面的链接（或分别填写主机、端口、Token），即可只读预览共享文件夹中的文件；编辑时需下载到本地工作区。'
            : 'On the client, right-click the file tree in Knowledge Management → "Add Remote Workspace" and paste the link above (or fill in Host / Port / Token separately) to preview files read-only; editing requires downloading to a local workspace.' }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== 组容器（与设置页其余面板一致） ====== */
.collab-settings { padding: 2px; }
.settings-group {
  margin-bottom: 5px;
  padding: 8px;
}
.settings-group:last-child { margin-bottom: 0; }
.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* ====== 表单组 ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.form-group label {
  width: 120px; min-width: 120px;
  color: var(--fontColor); font-size: 14px;
  user-select: none; line-height: 1; flex-shrink: 0;
}
.form-group input,
.form-group textarea {
  flex: 1; padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px;
}
.form-group input, .form-group select { height: 33px; box-sizing: border-box; }
.form-group input[type="range"] { height: auto; }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus {
  outline: none; border-color: var(--fontActiveColor);
}
.form-group input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin-right: 10px; }

/* 带按钮输入框 */
.input-with-button { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 5px; }
.input-with-button > input, .input-with-button > select { flex: 1; min-width: 0; margin: 0; }
.input-with-button > .button {
  flex-shrink: 0; height: auto; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0; width: auto;
}

/* ====== 按钮 / 按钮组 / 操作+状态 ====== */
.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex; align-items: center; justify-content: center;
  gap: 5px; font-size: 14px; white-space: nowrap;
  margin: 0px; padding: 6px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button i { font-size: 14px; }
.button-group { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.button-group .button { width: 100%; }
.action-with-status { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 8px; }
.action-with-status .button-group { flex: 1; }
.action-with-status .button-group .button { height: 33px; box-sizing: border-box; }
.action-with-status .status-indicator {
  flex: none; margin-left: auto; white-space: nowrap;
  height: 33px; box-sizing: border-box;
  display: flex; align-items: center; padding: 0 12px;
}

/* ====== 状态指示器 ====== */
.status-indicator { flex: 1; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 5px; font-size: 14px; }
.status-indicator.online { background-color: rgba(46, 204, 113, 0.2); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.3); }
.status-indicator.offline { background-color: rgba(231, 76, 60, 0.2); color: #e74c3c; border: 1px solid rgba(231, 76, 60, 0.3); }
.status-indicator i { font-size: 16px; }
.status-port { opacity: 0.85; font-weight: 600; }

/* ====== 环境选择（编辑权限） ====== */
.environment-selector { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.environment-option {
  display: flex; flex-direction: row; align-items: center; justify-content: center;
  height: 33px; box-sizing: border-box; padding: 0 10px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  cursor: pointer; transition: all 0.2s ease; gap: 6px; white-space: nowrap;
}
.environment-option:hover { background-color: var(--menuActiveColor); }
.environment-option.active { background-color: var(--menuActiveColor); color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.environment-option i { font-size: 16px; }
.environment-option span { font-size: 14px; font-weight: 500; text-align: center; }

/* ====== 局域网地址/连接信息 ====== */
.lan-addresses { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.lan-address-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background-color: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 5px; }
.lan-address-item i { color: var(--fontActiveColor); font-size: 14px; }
.lan-address-item code { flex: 1; min-width: 0; word-break: break-all; color: var(--fontActiveColor); font-size: 13px; font-weight: 600; background: none; user-select: all; cursor: pointer; }
.lan-link-code:hover { text-decoration: underline; }
.lan-copy-btn {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 24px; height: 24px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  color: var(--fontActiveColor); background: var(--menuColor);
  cursor: pointer; font-size: 12px; transition: all 0.15s;
}
.lan-copy-btn:hover { background: var(--menuActiveColor); }
.lan-copy-btn:active { opacity: 0.7; }

/* ====== 配置描述 ====== */
.config-description { flex: 1; font-size: 10px; color: var(--fontColor); opacity: 0.7; margin-left: 5px; }
</style>
