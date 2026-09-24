<script setup lang="ts">
  import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
  import { usestore, markRawTree } from '@/store'
  import { ElTree } from 'element-plus'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import type { RemoteRoot, RemoteFsNode } from '@/types/collab'
  import { fetchFsInfo, fetchFsList, fetchFsRead, downloadRemoteFile, remotePathOf } from '@/platform/remoteFs'
  import { FILE_VIEWS as FILE_VIEWS_DEFS, FILE_VIEW_NAMES } from '@/lib/knowFile/fileViews'
  import { newDrawioXml } from '@/shared/drawioFile'
  
  const store = usestore()
  // 视图管理面板显隐（由 explorer 顶部的眼睛按钮控制）
  const props = defineProps<{ showViews?: boolean }>()
  const emit = defineEmits<{ (e: 'reset-view-sizes'): void }>()
  const filterText = ref('') //搜索并过滤文件
  const treeRef = ref<InstanceType<typeof ElTree>>() //树状图数据
  const expandedKeys = ref<string[]>([]); //展开状态数据

  const filterNode = function(value: string, data: any){
    if (!value) return true
    return data.label.includes(value)
  }
  
  //点击操作
  let nodeCount = 0 //点击的次数
  let preNodeId = null as any //上次点击的点
  let curNodeId = null as any //当前点击的点
  let mode = ref('file') as any //侧边栏使用模式
  let nodeTimer: ReturnType<typeof setTimeout> | null = null //计时器

  
  // 重命名相关


  // 远程节点单击/双击判定辅助：记录上次单击时间，用于区分「单击预览」与「双击打开」
  let remoteClickAt = 0
  const REMOTE_DBL_MS = 320

  const click = function(data: any){
    // 远程节点：单击=窗口内快速预览（远程只读，单次点击更顺手）；
    //         双击=按「文件操作」模式打开（新窗口模式 → 独立窗口 FileWindow）
    if (data?.remote) {
      if (data.type === 'file') handleRemoteFileClick(data)
      return
    }
    // 点击工作区根目录时切换为当前工作区
    const isRootNode = store.roots.includes(data.path)
    if (isRootNode) {
      store.setActiveRoot(data.path)
    }

    nodeCount++
    //双击时打开标签
    if( preNodeId && nodeCount >= 2){
      curNodeId = data.path 
      nodeCount = 0
      if(curNodeId == preNodeId){//第一次点击的节点和第二次点击的节点id相同
        // 双击按节点类型分发：
        //  - 文件：走 store.openFileByMode（与文件视图 view_file.vue 一致）——.kb 知识库跳转知识处理、
        //    系统打开类交系统应用；其余按「新窗口/窗口内」操作模式打开，并按扩展名选择浏览/源码视图
        //  - 文件夹（含工作区根目录）：切换展开/折叠，绝不能当文件标签打开
        //    （文件夹被 addTab 后编辑视图会按文件读取目录 → EISDIR 报错）
        if (data.type === 'file') {
          store.openFileByMode(data)
        } else {
          toggleNodeExpand(data)
        }
        curNodeId = null
        preNodeId = null
        return
      }
    }
    preNodeId = data.path
    nodeTimer = setTimeout(() => { //300ms内没有第二次点击就把第一次点击的清空
      preNodeId = null
      nodeCount = 0
    },300)
  }

  /** 双击文件夹：切换展开/折叠（经 treeRef 节点模型操作，兼容 lazy 懒加载目录）。
      文件夹不能当作文件标签打开——编辑视图会按文件读取目录 → EISDIR 报错 */
  const toggleNodeExpand = (data: any) => {
    const node: any = (treeRef.value as any)?.store?.getNode(data.path)
    if (!node) return
    if (node.expanded) {
      node.collapse()
    } else {
      node.expand()
    }
  }

  // 开始重命名
  const startRename = async function(data: any) {
    try {
      const { value: newName } = await ElMessageBox.prompt('请输入新名称:', '重命名', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputValue: data.label,
        inputPattern: /.+/,
        inputErrorMessage: '名称不能为空'
      })
      const trimmed = newName.trim()
      if (trimmed === data.label) return
      const result = await window.ipcRenderer.invoke('renameFile', data.path, trimmed)
      if (result.success) {
        // 若重命名的是工作区根目录，同步更新工作区列表
        const rootIdx = store.roots.indexOf(data.path)
        if (rootIdx !== -1) {
          store.roots[rootIdx] = result.newPath
        }
        if (store.root === data.path) {
          store.root = result.newPath;
        }
        await refreshTree();
        ElMessage.success('重命名成功');
      } else {
        ElMessage.error(`重命名失败: ${result.error}`);
      }
    } catch { /* 用户取消 */ }
  };

  // 打开/添加工作区文件夹
  const openFolderDialog = async function() {
    let path = await window.ipcRenderer.invoke('openFolderDialog')
    if(path != null){
      // 添加为新的工作区并设为当前工作区（重复路径仅切换当前工作区，返回 false）
      const isNew = store.addRoot(path)
      if (!isNew) {
        ElMessage.warning(store.locales === 'zh' ? '该文件夹已在工作区列表中' : 'This folder is already in your workspace list')
        return
      }
      await refreshTree()
      // 启动文件监听（监听所有工作区）
      await window.ipcRenderer.invoke('startWatching', [...store.roots])
    }
    store.saveConfig()
  }

  // ==================== 远程工作区（局域网共享文件夹，只读预览） ====================

  // 远程树顶层数据：每个远程工作区一个根节点（云图标，懒加载）
  const remoteTreeData = ref<Array<Record<string, any>>>([])

  /** 同步远程树顶层（工作区列表变化时重建） */
  const rebuildRemoteTree = () => {
    remoteTreeData.value = store.remoteRoots.map((r: RemoteRoot) => ({
      id: `remote:${r.id}`,
      path: `remote:${r.id}`,
      label: r.name || r.host,
      type: 'folder',
      isRemoteRoot: true,
      remoteRootId: r.id,
      remoteRel: '',
      remote: true,
      children: [] as any[],
    }))
  }
  watch(
    () => store.remoteRoots.map((r: RemoteRoot) => `${r.id}|${r.name}|${r.host}:${r.port}`).join('\n'),
    () => {
      rebuildRemoteTree()
    },
    { immediate: true }
  )

  /** 合并后的树：本地工作区 + 远程工作区（远程始终在所有折叠的最下方） */
  const mergedTree = computed(() => [...store.tree, ...remoteTreeData.value])

  /** lazy 模式统一加载：本地节点返回已有 children；远程目录调 /fs/list */
  const loadTreeNode = async (node: any, resolve: (data: any[]) => void) => {
    const data = node?.data
    // 本地节点：refreshMultiTree 已提供完整 children。
    // 注意：el-tree 在 lazy 模式下挂载时会直接对根节点调 load，此时根节点的 data 是
    // 整个 mergedTree 数组本身（而非带 children 的对象），必须直接 resolve 数组；
    // 否则二次挂载（store.tree 已就绪、data 不再变化、setData 不触发）会只剩空的根节点 → 不显示文件。
    if (!data?.remote) {
      resolve(Array.isArray(data) ? data : (data?.children || []))
      return
    }
    if (data.type !== 'folder') {
      resolve([])
      return
    }
    const root = remoteRootOf(data)
    if (!root) {
      resolve([])
      return
    }
    try {
      const children = await fetchFsList(root, data.remoteRel || '')
      const nodes = children.map((c: RemoteFsNode) => ({
        id: `remote:${root.id}:${c.path}`,
        path: `remote:${root.id}:${c.path}`,
        label: c.label,
        type: c.type,
        remoteRootId: root.id,
        remoteRel: c.path,
        remote: true,
        children: c.type === 'folder' ? [] : undefined,
        size: c.size,
        mtime: c.mtime,
      }))
      resolve(nodes)
    } catch (e: any) {
      console.error('[remote-fs] 加载目录失败:', e)
      ElMessage.error(store.locales === 'zh' ? ('远程目录加载失败: ' + (e?.message || '')) : ('Remote list failed: ' + (e?.message || '')))
      resolve([])
    }
  }

  /** 根据 node.data 找到对应的远程工作区配置 */
  const remoteRootOf = (data: any): RemoteRoot | null => {
    if (!data?.remoteRootId) return null
    return store.remoteRoots.find((r: RemoteRoot) => r.id === data.remoteRootId) || null
  }

  /** 刷新远程工作区根节点：清空懒加载缓存并重新拉取内部文件列表 */
  const refreshRemoteRoot = async (data: any) => {
    const root = remoteRootOf(data)
    if (!root) return
    try {
      // 预拉取一次，验证连通性并预热
      await fetchFsList(root, data.remoteRel || '')
      const node: any = (treeRef.value as any)?.store?.getNode(data.path)
      if (node) {
        // 清除懒加载缓存，重新触发 load 拉取最新目录（保持展开状态）
        node.loaded = false
        node.loading = false
        node.expanded = true
        node.childNodes.length = 0
        node.loadData(() => {})
      }
      ElMessage.success(store.locales === 'zh' ? '已刷新' : 'Refreshed')
    } catch (e: any) {
      console.error('[remote-fs] 刷新失败:', e)
      ElMessage.error(store.locales === 'zh' ? ('刷新失败: ' + (e?.message || '')) : ('Refresh failed: ' + (e?.message || '')))
    }
  }

  /** 点击远程文件：读取内容并打开预览标签 */
  const clickRemoteNode = async (data: any, opts?: { preview?: boolean }) => {
    if (!data || data.type !== 'file') return
    const root = remoteRootOf(data)
    if (!root) return
    const rel = relOfRemoteNode(root, data)
    // quickPreview：单击快速预览（主窗口不显示远程只读条）；false/未传 = 正式「窗口内打开」（选到该标签时显示只读条）
    const isPreview = opts?.preview === true
    try {
      const ext = (data.label || '').substring(data.label.lastIndexOf('.')) || ''
      const extLower = ext.toLowerCase()
      // 图片 / PDF：读取 base64 内联预览
      const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
      if (IMG_EXTS.includes(extLower) || extLower === '.pdf') {
        const content = await fetchFsRead(root, rel)
        if (content?.base64 || content?.text) {
          store.addTab({
            path: remotePathOf(root, rel),
            label: data.label,
            type: 'file',
            extension: ext,
            isRemote: true,
            quickPreview: isPreview,
            remoteRootId: root.id,
            remoteRel: rel,
            // 存储原始 base64（不含 data: 前缀），供 PdfViewer / 图片渲染使用
            remoteBase64: content.base64 || '',
            remoteText: content.text || '',
          })
          return
        }
        await promptDownloadRemote(root, rel, data.label)
        return
      }
      // Word 文档：主进程 mammoth 转 Markdown 后内联预览（.doc 旧格式不支持，仍走下载）
      if (extLower === '.docx') {
        const content = await fetchFsRead(root, rel)
        if (content?.base64) {
          const md: any = await window.ipcRenderer.invoke('docxToMarkdown', { base64: content.base64 })
          if (typeof md === 'string' && md) {
            store.addTab({
              path: remotePathOf(root, rel),
              label: data.label,
              type: 'file',
              extension: ext,
              isRemote: true,
              quickPreview: isPreview,
              remoteRootId: root.id,
              remoteRel: rel,
              content: md,
              remoteText: md,
            })
            return
          }
        }
        await promptDownloadRemote(root, rel, data.label)
        return
      }
      const content = await fetchFsRead(root, rel)
      const text = content.text ?? ''
      const isBinary = !content.text
      // 其余二进制文件（视频等）：提示下载到本地打开
      if (isBinary) {
        await promptDownloadRemote(root, rel, data.label)
        return
      }
      store.addTab({
        path: remotePathOf(root, rel),
        label: data.label,
        type: 'file',
        extension: ext,
        isRemote: true,
        quickPreview: isPreview,
        remoteRootId: root.id,
        remoteRel: rel,
        content: text,
      })
    } catch (e: any) {
      ElMessage.error(store.locales === 'zh' ? ('远程文件读取失败: ' + (e?.message || '')) : ('Remote read failed: ' + (e?.message || '')))
    }
  }

  // ---- 远程文件「双击按文件操作模式打开」（新窗口模式 → 独立窗口 FileWindow） ----

  /** 远程文件单击/双击判定：单击 → 窗口内快速预览；320ms 内再次点击同一节点 → 双击打开 */
  const handleRemoteFileClick = (data: any) => {
    if (nodeTimer) { clearTimeout(nodeTimer); nodeTimer = null }
    const now = Date.now()
    // 双击：与上次单击同一节点且间隔在阈值内
    if (preNodeId === data.path && now - remoteClickAt <= REMOTE_DBL_MS) {
      preNodeId = null
      remoteClickAt = 0
      openRemoteByMode(data)
      return
    }
    // 单击：远程只读，窗口内快速预览（不显示远程只读条）
    preNodeId = data.path
    remoteClickAt = now
    clickRemoteNode(data, { preview: true })
    nodeTimer = setTimeout(() => {
      preNodeId = null
      remoteClickAt = 0
      nodeTimer = null
    }, REMOTE_DBL_MS)
  }

  /** 双击远程文件：按「文件操作」模式打开——新窗口模式 → 独立窗口(FileWindow)；窗口内模式 → 窗口内预览 */
  const openRemoteByMode = (data: any) => {
    if (store.UI.fileOpenMode === 'window') {
      openRemoteInNewWindow(data)
    } else {
      clickRemoteNode(data)
    }
  }

  /** 在新窗口（FileWindow.vue）打开远程文件：只读，默认浏览视图（可切导图/演示），可下载到本地 */
  const openRemoteInNewWindow = (data: any) => {
    const root = remoteRootOf(data)
    if (!root) return
    const rel = relOfRemoteNode(root, data)
    if (!rel) return
    const label = (data.label || rel.replace(/\\/g, '/').split('/').pop() || 'file')
    window.ipcRenderer.invoke('open-file-window', {
      path: remotePathOf(root, rel),
      view: 'read',
      remoteRootId: root.id,
      remoteRel: rel,
      label,
    }).catch(() => {})
  }

  /** 把服务端返回的绝对 path 转为共享根相对路径（去除共享根前缀） */
  function relOfRemoteNode(root: RemoteRoot, data: any): string {
    if (typeof data.remoteRel === 'string' && data.remoteRel) return data.remoteRel
    // 兜底：服务端返回绝对路径时，仅取文件名（跨目录下载受限，暂简化）
    const p = String(data.path || '')
    return p.replace(/\\/g, '/').split('/').pop() || data.label || 'file'
  }

  /** 下载远程文件到当前激活工作区根目录 */
  const promptDownloadRemote = async (root: RemoteRoot, rel: string, label: string) => {
    try {
      await ElMessageBox.confirm(
        store.locales === 'zh'
          ? `远程文件为只读，是否下载 "${label}" 到当前工作区（${store.root || '未设置'}）？`
          : `Remote file is read-only. Download "${label}" to the current workspace (${store.root || 'unset'})?`,
        store.locales === 'zh' ? '下载远程文件' : 'Download Remote File',
        { confirmButtonText: store.locales === 'zh' ? '下载' : 'Download', cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel', type: 'info' }
      )
    } catch { return }
    if (!store.root) {
      ElMessage.warning(store.locales === 'zh' ? '请先打开一个本地工作区再下载' : 'Open a local workspace first')
      return
    }
    try {
      const localPath = await downloadRemoteFile(root, rel, store.root)
      ElMessage.success(store.locales === 'zh' ? ('已下载到: ' + localPath) : ('Downloaded: ' + localPath))
      await refreshTree()
    } catch (e: any) {
      ElMessage.error(store.locales === 'zh' ? ('下载失败: ' + (e?.message || '')) : ('Download failed: ' + (e?.message || '')))
    }
  }

  // ---- 添加 / 删除远程工作区 ----
  const addRemoteDialogVisible = ref(false)
  const remoteForm = ref({ host: '', port: 3347, token: '', name: '' })
  const remoteLinkDraft = ref('')

  const promptAddRemote = () => {
    remoteForm.value = { host: '', port: 3347, token: '', name: '' }
    remoteLinkDraft.value = ''
    addRemoteDialogVisible.value = true
  }

  // 从远程共享链接（remote-fs://ip:port?token=...）解析出 host/port/token
  const parseRemoteLink = (link: string): { host: string; port: number; token: string } | null => {
    const s = link.trim()
    if (!s) return null
    // 兼容带 scheme 或不带 scheme 的形式
    const body = s.replace(/^remote-fs:\/\//i, '').replace(/^https?:\/\//i, '')
    const qIdx = body.indexOf('?')
    const authority = qIdx === -1 ? body : body.substring(0, qIdx)
    const query = qIdx === -1 ? '' : body.substring(qIdx + 1)
    const token = new URLSearchParams(query).get('token') || ''
    const m = authority.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
    if (m) return { host: m[1], port: Number(m[2]), token }
    if (/^[^:\s]+$/.test(authority)) return { host: authority, port: 3347, token }
    return null
  }

  // 粘贴链接时自动填充
  const onRemoteLinkInput = (val: string) => {
    remoteLinkDraft.value = val
    const parsed = parseRemoteLink(val)
    if (parsed) {
      remoteForm.value.host = parsed.host
      remoteForm.value.port = parsed.port
      if (parsed.token) remoteForm.value.token = parsed.token
    }
  }

  const confirmAddRemote = async () => {
    const hostRaw = remoteForm.value.host.trim()
    let host = hostRaw
    let port = remoteForm.value.port
    const token = remoteForm.value.token.trim()
    // 兼容用户在主机栏直接粘贴 "ip:端口"：自动拆分为 host 与 port
    const m = hostRaw.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
    if (m) {
      host = m[1]
      port = Number(m[2])
    }
    if (!host || !port || !token) {
      ElMessage.warning(store.locales === 'zh' ? '请填写主机、端口与 Token' : 'Host, port and token are required')
      return
    }
    const name = remoteForm.value.name.trim() || host
    const candidate: RemoteRoot = { id: `${host}:${port}:${token}`, name, host, port, token }
    // 校验共享可用
    try {
      const info = await fetchFsInfo(candidate)
      candidate.name = name || info.name || host
      candidate.rootName = info.name
    } catch (e: any) {
      ElMessage.error(store.locales === 'zh' ? ('无法连接共享: ' + (e?.message || '')) : ('Cannot connect: ' + (e?.message || '')))
      return
    }
    store.addRemoteRoot(candidate)
    addRemoteDialogVisible.value = false
    rebuildRemoteTree()
    ElMessage.success(store.locales === 'zh' ? '远程工作区已添加' : 'Remote workspace added')
  }

  const removeRemoteRoot = async (data: any) => {
    // 兼容两种入参：树节点（含 remoteRootId）或 RemoteRoot 配置对象（含 id，右键菜单传入的是 remoteRootOf 的结果）
    const root =
      (data?.remoteRootId
        ? store.remoteRoots.find((r: RemoteRoot) => r.id === data.remoteRootId)
        : store.remoteRoots.find((r: RemoteRoot) => r.id === data?.id)) || null
    if (!root) return
    try {
      await ElMessageBox.confirm(
        store.locales === 'zh' ? `确定要从列表中删除远程工作区 "${root.name}" 吗？` : `Remove remote workspace "${root.name}"?`,
        store.locales === 'zh' ? '删除远程工作区' : 'Remove Remote Workspace',
        { confirmButtonText: store.locales === 'zh' ? '确定' : 'OK', cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel', type: 'warning' }
      )
    } catch { return }
    store.removeRemoteRoot(root.id)
    // 关闭该远程工作区已打开的预览标签，避免残留
    if (store.data.some((d: any) => d.isRemote && d.remoteRootId === root.id)) {
      store.data = store.data.filter((d: any) => !(d.isRemote && d.remoteRootId === root.id))
      if (store.index >= store.data.length) store.index = store.data.length - 1
    }
    rebuildRemoteTree()
    ElMessage.success(store.locales === 'zh' ? '远程工作区已删除' : 'Remote workspace removed')
  }

  // ---- 文件树排序 ----
  const sortBy = ref<'name' | 'mtime' | 'size'>(store.treeSort?.by || 'name')
  const sortOrder = ref<'asc' | 'desc'>(store.treeSort?.order || 'asc')

  // 快速自然排序：数字段按数值比较、忽略大小写（替代 localeCompare numeric 选项的高开销，大目录可提速数十倍）；
  // 含中文等非 ASCII 名称时回退原 localeCompare，保持本地化排序一致
  const ASCII_RE = /^[\x00-\x7F]*$/
  const NATURAL_RE = /(\d+)|(\D+)/g
  const NUM_RE = /^\d+$/
  const naturalCompare = (a: string, b: string): number => {
    if (a === b) return 0
    if (!ASCII_RE.test(a) || !ASCII_RE.test(b)) {
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    }
    const la = a.toLowerCase()
    const lb = b.toLowerCase()
    const sa = la.match(NATURAL_RE) || [la]
    const sb = lb.match(NATURAL_RE) || [lb]
    const len = Math.max(sa.length, sb.length)
    for (let i = 0; i < len; i++) {
      const x = sa[i]
      const y = sb[i]
      if (x === undefined) return -1
      if (y === undefined) return 1
      if (x === y) continue
      if (NUM_RE.test(x) && NUM_RE.test(y)) {
        const xn = parseInt(x, 10)
        const yn = parseInt(y, 10)
        if (xn !== yn) return xn - yn
        if (x.length !== y.length) return x.length - y.length // 前导零：长度短者在前
        continue
      }
      return x < y ? -1 : 1
    }
    // 忽略大小写后完全相等：用原始串区分稳定顺序
    return a < b ? -1 : a > b ? 1 : 0
  }

  /** 节点比较器（文件夹始终排在文件前面，与升降序无关） */
  const compareNodes = (a: any, b: any): number => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    let result = 0
    if (sortBy.value === 'mtime') {
      result = (a.mtime || 0) - (b.mtime || 0)
    } else if (sortBy.value === 'size') {
      result = (a.size || 0) - (b.size || 0)
    } else {
      result = naturalCompare(String(a.label ?? ''), String(b.label ?? ''))
    }
    return sortOrder.value === 'asc' ? result : -result
  }

  /**
   * 就地递归排序：直接对数组 sort，仅重排顺序，不复建节点对象
   * （旧实现 spread 新建节点对象会触发 Vue 深层响应式转换 + 大量 GC，大目录下卡顿数秒）
   */
  const sortNodes = (nodes: any[]): void => {
    nodes.sort(compareNodes)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n && Array.isArray(n.children) && n.children.length) {
        sortNodes(n.children)
      }
    }
  }

  /** 将排序方式应用到整棵树（就地重排；顶层浅替换触发 el-tree 更新，节点按 node-key 复用，展开状态保留）
   *  保持工作区根节点顺序不变，仅对每个根节点内部的子节点排序 */
  const applySort = () => {
    if (!store.tree || !store.tree.length) return
    for (const n of store.tree) {
      if (n && Array.isArray(n.children) && n.children.length) {
        sortNodes(n.children)
      }
    }
    // 顶层浅替换（节点对象复用，仅更换数组引用）确保「切换排序方式」路径下 el-tree 也能感知新顺序
    store.tree = [...store.tree]
  }

  /** 设置排序方式；再次点击同一项切换升/降序 */
  const setSort = (by: 'name' | 'mtime' | 'size') => {
    if (sortBy.value === by) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = by
      sortOrder.value = 'asc'
    }
    store.treeSort = { by: sortBy.value, order: sortOrder.value }
    applySort()
    store.saveConfig()
  }

  // ---- 悬浮提示工具 ----
  /** 格式化文件大小（字节 → B/KB/MB/GB） */
  const formatSize = (size?: number) => {
    if (size == null || size < 0) return ''
    if (size < 1024) return size + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = size / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024
      i++
    }
    return value.toFixed(1) + ' ' + units[i]
  }

  /** 格式化修改时间（时间戳 → yyyy-MM-dd HH:mm） */
  const formatTime = (mtime?: number) => {
    if (!mtime) return ''
    const d = new Date(mtime)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // ---- 悬浮提示（跟随鼠标） ----
  const tooltipVisible = ref(false)
  const tooltipPos = ref({ x: 0, y: 0 })
  const tooltipData = ref<any>(null)
  let tipSize = { w: 0, h: 0 }

  /** 鼠标悬浮时显示提示（首次显示时测量尺寸以决定防溢出方向） */
  const showTooltip = (e: MouseEvent, data: any) => {
    tooltipData.value = data
    if (!tooltipVisible.value) {
      tooltipVisible.value = true
      nextTick(() => {
        const el = document.querySelector('.tree-tooltip') as HTMLElement | null
        if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
      })
    }
    // 跟随鼠标，超出视口时翻转方向
    let x = e.clientX + 12
    let y = e.clientY + 12
    if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w - 12
    if (tipSize.h && y + tipSize.h > window.innerHeight - 4) y = e.clientY - tipSize.h - 12
    tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
  }

  // 提示内容变化时（如不同长度文件名）重新测量尺寸，确保防溢出方向正确
  watch(tooltipData, () => {
    if (tooltipVisible.value && tooltipData.value) {
      nextTick(() => {
        const el = document.querySelector('.tree-tooltip') as HTMLElement | null
        if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
      })
    }
  })

  /** 隐藏提示 */
  const hideTooltip = () => {
    tooltipVisible.value = false
    tooltipData.value = null
  }

  // 刷新合并：一次全量刷新执行期间，后续请求仅排队一次（避免知识处理等高频写文件时全量扫描叠加卡顿）
  let refreshInFlight = false
  let refreshQueued = false
  // 文件树加载中（数据为空时显示加载指示；默认 true 避免首帧/重开模块闪现"暂无文件"）
  const treeLoading = ref(true)

  // 刷新文件树（支持多个工作区）
  const refreshTree = async function() {
    if (refreshInFlight) {
      refreshQueued = true
      return
    }
    refreshInFlight = true
    // 每次刷新都标记加载中：空态插槽仅在数据为空时渲染（有旧树时不影响旧树显示），
    // 避免重开模块/刷新时 el-tree 重建瞬间闪现"暂无文件"，此时应显示"正在加载"
    treeLoading.value = true
    try {
      let roots = (store.roots && store.roots.length ? [...store.roots] : []).filter(Boolean)
      // 兼容：未注册工作区列表但已设置 root 时，视为单一工作区
      if (!roots.length && store.root) roots = [store.root]
      if (!roots.length) {
        store.tree = []
        return
      }
      // treeVersion 存于 store：面板重挂载后仍记得上次版本，数据未变时主进程直接返回 unchanged。
      // 仅当渲染端已有非空树时才用版本快路径；树为空时传 -1 强制全量加载，避免 unchanged 留下空树
      let knownVersion = store.tree && store.tree.length ? store.treeVersion : -1
      // 根目录集合变化（新增/删除工作区）时禁用版本快路径：
      // 主进程只校验「剩余根」的缓存有效 + 版本一致就返回 unchanged，并不知道根列表少了一项，
      // 导致渲染端旧树里残留已删除的工作区（表现为仅失去加粗、文件夹仍在列表）。
      // 顶层根集合不一致时传 -1 强制全量重建。
      if (knownVersion !== -1) {
        const curRootPaths = (store.tree || []).map((n: any) => n.path).filter(Boolean)
        const needRoots = roots
        if (curRootPaths.join('\n') !== needRoots.join('\n')) {
          knownVersion = -1
        }
      }
      const result = await window.ipcRenderer.invoke('refreshMultiTree', roots, knownVersion)
      if (result.success) {
        // 数据未变化：保留现有树，跳过整棵树回传与重新处理（markRawTree/排序/展开键修剪）
        if (result.unchanged) {
          store.treeVersion = result.version
          return
        }
        store.treeVersion = result.version
        store.tree = markRawTree(result.tree)
        // 同步工作区列表：过滤掉已不存在（被删除）的路径，保持列表顺序
        const existing = result.tree.map((n: any) => n.path)
        if (existing.join('\n') !== store.roots.join('\n')) {
          store.roots = existing
          if (!existing.includes(store.root)) {
            store.root = existing[0] || ''
            store.path = store.root
          }
          store.saveConfig()
        }
        applySort()
        pruneExpandedKeys()
      }
    } finally {
      refreshInFlight = false
      treeLoading.value = false
      if (refreshQueued) {
        refreshQueued = false
        refreshTree()
      }
    }
  }

  // 通过对话框，打开其他文件
  const selectFile = async function() {
    const path = await window.ipcRenderer.invoke('selectFile')
    openFile(path)
  }

  // 应用内无法预览/编辑的文件（可执行/压缩包等）：双击直接用系统默认应用打开
  const SYSTEM_OPEN_EXTS = ['.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst']

  // 通过路径打开文件（窗口内打开；知识库 .kb 由 store.openInApp 统一跳转知识处理）
  const openFile = async function(path: any) {
    if(path != null){
      // 系统打开类文件：直接用系统默认应用打开，不进入应用内预览/编辑
      const ext = String(path).substring(String(path).lastIndexOf('.')).toLowerCase()
      if (SYSTEM_OPEN_EXTS.includes(ext)) {
        window.ipcRenderer.invoke('openWithSystemApp', path)
        return
      }
      const inf = await window.ipcRenderer.invoke('getInf', path); //获取信息
      const attributes = await window.ipcRenderer.invoke('getConfig', path); //获取属性
      const fileContent = await window.ipcRenderer.invoke('readFile', path)
      store.openInApp({
        ...inf,
        attributes: attributes,
        path: path,
        content: fileContent,
      })
    }
  }

  //创建文件（fileType: md / excalidraw / drawio）
  const createFile = async (fileName: string, fileType: 'md' | 'excalidraw' | 'drawio' = 'md') => {
    if (!store.root) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    const targetDir = contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.path : store.root
    const suffix = fileType === 'excalidraw' ? '.excalidraw' : (fileType === 'drawio' ? '.drawio' : '.md')
    const path = await window.ipcRenderer.invoke('createFile', targetDir, fileName + suffix);
    if (path) {
      // .drawio 先写入空白图表框架，避免留下 0 字节文件（打开时与 drawio 默认新建一致）
      if (fileType === 'drawio') {
        try { await window.ipcRenderer.invoke('saveFile', path, newDrawioXml()) } catch { /* ignore */ }
      }
      openFile(path)
      ElMessage.success(`文件 "${fileName}${suffix}" 创建成功`);
    }
    await refreshTree()
  };

  const createFolder = async (folderName: string) => {
    if (!store.root) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    const targetDir = contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.path : store.root
    const dir = await window.ipcRenderer.invoke('createFolder', targetDir, folderName);
    if (dir) {
      ElMessage.success(`文件夹 "${folderName}" 创建成功`);
    }
    await refreshTree()
  };

  // 创建文件对话框状态
  const createDialogVisible = ref(false)
  const createFileType = ref<'md' | 'excalidraw' | 'drawio'>('md')
  const createFileName = ref('')

  // 通过弹窗创建文件（单框：选择类型 + 输入文件名）
  const promptCreateFile = () => {
    if (!store.root) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    createFileType.value = 'md'
    createFileName.value = ''
    createDialogVisible.value = true
  };

  // 确认创建文件
  const confirmCreateFile = async () => {
    const name = createFileName.value.trim()
    if (!name) {
      ElMessage.warning(store.locales === 'zh' ? '文件名不能为空' : 'File name cannot be empty');
      return
    }
    createDialogVisible.value = false
    await createFile(name, createFileType.value)
  };

  // 通过弹窗创建文件夹
  const promptCreateFolder = async () => {
    if (!store.root) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    try {
      const { value: folderName } = await ElMessageBox.prompt('请输入文件夹名称:', '创建文件夹', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPattern: /.+/,
        inputErrorMessage: '文件夹名称不能为空'
      })
      const trimmed = folderName.trim()
      if (!trimmed) return
      await createFolder(trimmed)
    } catch { /* 用户取消 */ }
  };

  // ---- 复制/粘贴 ----
  const copiedPath = ref<string | null>(null)

  /** 复制文件或文件夹路径到剪贴板 */
  const copyNode = (node: any) => {
    copiedPath.value = node.data.path
    ElMessage.success(store.locales === 'zh' ? '已复制' : 'Copied')
  }

  /** 将已复制的文件/文件夹粘贴到当前右键的文件夹下 */
  const pasteNode = async () => {
    if (!copiedPath.value) return
    const targetDir = contextMenu.value.node?.path || store.root
    if (!targetDir) return

    try {
      const result = await window.ipcRenderer.invoke('copyFile', copiedPath.value, targetDir)
      if (result.success) {
        ElMessage.success(store.locales === 'zh' ? '粘贴成功' : 'Pasted successfully')
        copiedPath.value = null
        await refreshTree()
      } else {
        ElMessage.error(result.error || (store.locales === 'zh' ? '粘贴失败' : 'Paste failed'))
      }
    } catch (error) {
      console.error('粘贴失败:', error)
      ElMessage.error(store.locales === 'zh' ? '粘贴失败' : 'Paste failed')
    }
  }

  // ---- 拖拽移动文件 ----
  /** 仅文件可拖拽，文件夹不可拖拽 */
  const allowDrag = (node: any) => {
    // 远程节点只读，禁止拖拽
    if (node.data?.remote) return false
    return node.data.type === 'file'
  }

  /** 仅文件夹可作为拖放目标，且不能为自身 */
  const allowDrop = (draggingNode: any, dropNode: any, type: string) => {
    // 远程节点只读，禁止作为拖放目标
    if (dropNode.data?.remote) return false
    // 只有放到文件夹上才允许
    if (dropNode.data.type !== 'folder') return false
    // 不能放到自己身上
    if (draggingNode.data.path === dropNode.data.path) return false
    return true
  }

  /** 处理拖放完成 */
  const handleDrop = async (draggingNode: any, dropNode: any, dropType: string, ev: Event) => {
    const sourcePath = draggingNode.data.path
    const targetDir = dropNode.data.path
    if (!sourcePath || !targetDir) return

    try {
      const result = await window.ipcRenderer.invoke('moveFile', sourcePath, targetDir)
      if (result.success) {
        ElMessage.success(store.locales === 'zh' ? '移动成功' : 'Moved successfully')
        await refreshTree()
      } else {
        ElMessage.error(result.error || (store.locales === 'zh' ? '移动失败' : 'Move failed'))
      }
    } catch (error) {
      console.error('移动文件失败:', error)
      ElMessage.error(store.locales === 'zh' ? '移动文件失败' : 'Failed to move file')
    }
  };

  //右键菜单变量
  const contextMenu = ref({
    visible: false,
    style: {
      top: '0px',
      left: '0px',
      transform: '',
    } as Record<string, string>,
    node: null as any,
    isRoot: false as boolean, // 右键的节点是否为工作区根目录
    isRemote: false as boolean, // 右键的节点是否为远程节点
  });

  const getOffset = (element: HTMLElement) => {
    let top = 0, left = 0;
    while (element) {
      top += element.offsetTop;
      left += element.offsetLeft;
      element = element.offsetParent as HTMLElement;
    }
    return { top, left };
  };

  // 右键菜单溢出视口时自动向右上（向上/向左）移动，保证完全显示
  const adjustContextMenuPosition = () => {
    nextTick(() => {
      const menu = document.querySelector('.context-menu')
      if (!menu) return
      const rect = menu.getBoundingClientRect()
      const margin = 4
      let left = rect.left
      let top = rect.top
      // 底部溢出 → 向上移动
      if (rect.bottom > window.innerHeight - margin) {
        top = Math.max(margin, top - (rect.bottom - (window.innerHeight - margin)))
      }
      // 右侧溢出 → 向左移动
      if (rect.right > window.innerWidth - margin) {
        left = Math.max(margin, left - (rect.right - (window.innerWidth - margin)))
      }
      contextMenu.value.style = {
        left: left + 'px',
        top: top + 'px',
        transform: ''
      }
    })
  }

  //右键菜单逻辑（文件节点）
  const handleRightClick = (event: MouseEvent, data: any) => {
    event.preventDefault(); // 阻止默认的右键菜单
    
    contextMenu.value.visible = true;
    contextMenu.value.style = {
      left: event.clientX + 'px',
      top: event.clientY + 'px',
      transform: ''
    };
    contextMenu.value.node = data;
    contextMenu.value.isRoot = store.roots.includes(data.path);
    contextMenu.value.isRemote = data?.remote === true;
    adjustContextMenuPosition();
  };

  // 右键「新窗口打开」的视图列表：Word 文档只提供 浏览 / 思维导图（与 FileWindow 的视图列表一致）
  const isWordNode = computed(() => {
    const p = String(contextMenu.value?.node?.path || '').toLowerCase();
    return p.endsWith('.docx') || p.endsWith('.doc');
  });

  // 远程节点右键操作：根节点删除远程工作区；文件下载到本地工作区
  const remoteContextAction = async () => {
    const data = contextMenu.value.node
    if (!data) return
    contextMenu.value.visible = false
    if (data.isRemoteRoot) {
      await removeRemoteRoot(data)
      return
    }
    if (data.type === 'file') {
      const root = remoteRootOf(data)
      if (root) {
        await promptDownloadRemote(root, relOfRemoteNode(root, data), data.label)
      }
    }
  };

  // 空白区域右键菜单
  const showViewMenu = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.el-tree-node') || target.closest('.context-menu')) return
    e.preventDefault()
    contextMenu.value.visible = true;
    contextMenu.value.style = {
      left: e.clientX + 'px',
      top: e.clientY + 'px',
      transform: ''
    };
    contextMenu.value.node = null; // 无选中节点，不显示重命名/删除
    contextMenu.value.isRoot = false;
    contextMenu.value.isRemote = false;
    adjustContextMenuPosition();
  };

  // ---- 展开状态持久化（按仓库根路径隔离，避免切换仓库后残留旧路径） ----
  const EXPAND_STORAGE_KEY = 'treeExpanded'

  /** 读取指定仓库的展开状态 */
  const loadExpandedKeys = (root: string) => {
    try {
      const map = JSON.parse(localStorage.getItem(EXPAND_STORAGE_KEY) || '{}')
      expandedKeys.value = Array.isArray(map[root]) ? map[root] : []
    } catch {
      expandedKeys.value = []
    }
  }

  /** 保存当前仓库的展开状态 */
  const saveExpandedKeys = () => {
    if (!store.root) return
    try {
      const map = JSON.parse(localStorage.getItem(EXPAND_STORAGE_KEY) || '{}')
      map[store.root] = [...expandedKeys.value]
      localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(map))
    } catch { /* 忽略存储异常 */ }
  }

  /** 清理指定仓库的展开状态（仓库位置变更时调用，避免旧路径残留） */
  const clearExpandedKeys = (root: string) => {
    expandedKeys.value = []
    if (!root) return
    try {
      const map = JSON.parse(localStorage.getItem(EXPAND_STORAGE_KEY) || '{}')
      if (root in map) {
        delete map[root]
        localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(map))
      }
    } catch { /* 忽略存储异常 */ }
  }

  /** 清理展开状态中已不存在的路径（如文件被删除/重命名），并同步持久化 */
  const pruneExpandedKeys = () => {
    const valid = new Set<string>()
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        valid.add(n.path)
        if (n.children?.length) walk(n.children)
      }
    }
    walk(store.tree)
    const before = expandedKeys.value.length
    expandedKeys.value = expandedKeys.value.filter(p => valid.has(p))
    if (expandedKeys.value.length !== before) saveExpandedKeys()
  }

  //展开状态记录（变化即持久化；远程节点懒加载由 el-tree lazy 自动处理，不持久化展开状态）
  const handleNodeExpand = (data: any) => {
    if (data?.remote) return
    if (!expandedKeys.value.includes(data.path)) {
      expandedKeys.value.push(data.path);
      saveExpandedKeys();
    }
  };

  const handleNodeCollapse = (data: any) => {
    if (data?.remote) return
    const index = expandedKeys.value.indexOf(data.path);
    if (index !== -1) {
      expandedKeys.value.splice(index, 1);
      saveExpandedKeys();
    }
  };

  // 仓库位置变更：清理旧仓库残留的展开状态，并恢复新仓库自己的展开状态
  watch(
    () => store.root,
    (newRoot, oldRoot) => {
      if (newRoot === oldRoot) return
      if (oldRoot) clearExpandedKeys(oldRoot)
      loadExpandedKeys(newRoot)
    }
  )

  // 工作区列表变化时自动刷新文件树（如从设置页添加/移除工作区后及时更新）
  watch(
    () => store.roots.join('\n'),
    (newRoots, oldRoots) => {
      if (newRoots === oldRoots) return
      if (store.root || store.roots.length) {
        refreshTree()
      } else {
        store.tree = []
      }
    }
  )

  //删除文件或文件夹
  const deleteFile = async () => {
    if (!contextMenu.value.node) return
    const node = contextMenu.value.node
    const path = node.path
    const isFolder = node.type === 'folder'
    const label = node.label

    try {
      await ElMessageBox.confirm(
        `确定要删除${isFolder ? '文件夹' : '文件'} "${label}" 吗？`,
        '确认删除',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        }
      )
    } catch {
      return // 用户取消
    }

    // 执行删除
    try {
      if (isFolder) {
        await window.ipcRenderer.invoke('deleteFolder', path)
      } else {
        await window.ipcRenderer.invoke('deleteFile', path)
        // 同步关闭已打开的标签页
        const tabIdx = store.data.findIndex((d: any) => d.path === path)
        if (tabIdx !== -1) {
          store.data.splice(tabIdx, 1)
          if (store.data.length === 0) {
            store.index = -1
          } else if (store.index >= store.data.length) {
            store.index = store.data.length - 1
          } else if (store.index > tabIdx) {
            store.index--
          }
        }
      }
      await refreshTree()
      contextMenu.value.visible = false
      ElMessage.success('删除成功')
    } catch (error) {
      console.error('删除失败:', error)
      ElMessage.error('删除失败')
    }
  };

  // 删除工作区（仅从工作区列表移除，不删除磁盘文件）
  const deleteWorkspaceRoot = async () => {
    const node = contextMenu.value.node
    if (!node) return
    try {
      await ElMessageBox.confirm(
        `确定要从工作区列表中删除 "${node.label}" 吗？\n（不会删除磁盘上的文件）`,
        '删除工作区',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        }
      )
    } catch {
      return // 用户取消
    }
    store.removeRoot(node.path)
    contextMenu.value.visible = false
    await refreshTree()
    // 重启文件监听（监听剩余工作区）
    await window.ipcRenderer.invoke('startWatching', [...store.roots])
    ElMessage.success('已从工作区列表删除')
  };

  // 处理文件系统变化
  const handleFileSystemChange = async (event: any, data: any) => {
    // 防抖：延迟刷新，避免频繁刷新
    if (window._refreshTimer) {
      clearTimeout(window._refreshTimer);
    }
    window._refreshTimer = setTimeout(async () => {
      await refreshTree();
      window._refreshTimer = null;
    }, 500);
  };

  // 监听文件系统变化
  onMounted(async () => {
    // 监听文件系统变化事件
    window.ipcRenderer.on('fileSystemChanged', handleFileSystemChange);
    
    if (store.root || (store.roots && store.roots.length)) {
      // 恢复上次保存的展开状态（须在树数据加载前调用，node.initialize 才会按 key 展开）
      loadExpandedKeys(store.root)
      await refreshTree();
      // 启动文件监听（监听所有工作区）
      await window.ipcRenderer.invoke('startWatching', [...store.roots]);
    }
  });

  // 点击空白处关闭右键菜单（具名引用，卸载时移除，避免每次挂载累积一个永不移除的 document 监听）
  const hideContextMenuOnDocClick = () => {
    contextMenu.value.visible = false;
  };

  onBeforeUnmount(async () => {
    // 移除事件监听
    window.ipcRenderer.off('fileSystemChanged', handleFileSystemChange);
    // 移除文档级点击监听
    document.removeEventListener('click', hideContextMenuOnDocClick);
    // 停止文件监听
    await window.ipcRenderer.invoke('stopWatching');
    // 清除定时器
    if (window._refreshTimer) {
      clearTimeout(window._refreshTimer);
      window._refreshTimer = null;
    }
  });

  document.addEventListener('click', hideContextMenuOnDocClick);

  // 新窗口打开文件
  const openInNewWindow = async (path: string, view: string) => {
    await window.ipcRenderer.invoke('open-file-window', { path, view })
  }

  const hideContextMenu = () => {
    contextMenu.value.visible = false;
  };

  // 判断该节点是否为工作区根目录
  const isWorkspaceRoot = (path: string) => {
    return store.roots.includes(path)
  }

  // 判断该节点是否已在标签页中打开
  const isTabOpen = (path: string) => {
    return store.data.some((d: any) => d.path === path)
  }

  // 判断该节点是否为当前激活的标签
  const isActiveTab = (path: string) => {
    return store.data[store.index]?.path === path
  }


  const viewsList = computed(() => store.viewList)

  // 文件形式视图（随文件在标签/新窗口中打开，与文件树视图管理区的全局视图分开管理）
  // 顺序 / 名称统一来自 src/lib/knowFile/fileViews.ts
  const FILE_VIEWS = FILE_VIEW_NAMES
  // Word 等只读文件：不允许窗口内开可编辑/演示视图（菜单里隐藏这几项）
  const READONLY_VIEW_KEYS = ['edit', 'blockedit', 'presentation']

  // 视图本地化显示名：store.view / viewList 的内部标识恒为中文（isView/toggleView/组件 v-if 均依赖），
  // 仅下拉展示文本随语言切换；英文命名与 empty.vue 欢迎页视图网格保持一致，避免同屏两处显示不一致
  const VIEW_NAME_EN: Record<string, string> = {
    '文件': 'Files', '图谱': 'Graph', '看板': 'Kanban', '甘特': 'Gantt', '日历': 'Year',
    '地图': 'Map', '表格': 'Table',
    // 文件视图（浏览/源码编辑/可视编辑/思维导图/演示）的英文名统一取自 fileViews.ts
    ...Object.fromEntries(FILE_VIEWS_DEFS.map((v) => [v.name, v.labelEn])),
  }
  // 中文显示名覆盖：甘特视图对外展示为「日程」（内部标识仍为「甘特」）
  const VIEW_NAME_ZH: Record<string, string> = { '甘特': '日程' }
  const viewName = (v: string) => (store.locales === 'zh' ? (VIEW_NAME_ZH[v] || v) : (VIEW_NAME_EN[v] || v))

  // 视图管理区显示的视图：新窗口打开模式下隐藏文件形式视图，只显示其他 7 个（文件/图谱/看板/甘特/日历/地图/表格）
  const viewsForGrid = computed(() => {
    if (store.UI.fileOpenMode === 'window') {
      return store.viewList.filter(v => !FILE_VIEWS.includes(v))
    }
    return store.viewList
  })

  // 全部关闭视图
  const closeAllViews = function() {
    store.view.splice(0, store.view.length);
    store.saveConfig();
  };

  // 当前激活的全局视图（select 显示值；多个开启时取第一个）
  const activeGlobalView = computed(() => viewsForGrid.value.find(v => store.isView(v)) || '')
  // select 切换视图：互斥单选（开启选中的，关闭 select 内其他视图；select 范围外的视图开关不受影响）
  const onGlobalViewChange = (e: Event) => {
    const v = (e.target as HTMLSelectElement).value
    if (!v || !viewsForGrid.value.includes(v)) return
    const keep = store.view.filter((x: string) => !viewsForGrid.value.includes(x))
    if (!keep.includes(v)) keep.push(v)
    store.view = keep
    store.saveConfig()
  }

  watch(filterText, (val) => {
    treeRef.value!.filter(val)
  })

  // 暴露方法给父组件
  defineExpose({
    refreshTree,
    promptCreateFile
  });
</script>

<template>
  <div class="bg" @mouseleave="hideContextMenu">
    <div class="list scoll" v-if="mode=='file'" @contextmenu.prevent="showViewMenu">
      <!-- 视图管理（list scoll 上方，由 explorer 眼睛按钮开关；新窗口模式下改用搜索栏左侧常驻下拉） -->
      <div class="views-container" v-if="showViews && store.UI.fileOpenMode !== 'window'">
        <!-- 视图下拉 + 均分/关闭图标按钮（同一行） -->
        <select :value="activeGlobalView" @change="onGlobalViewChange" class="views-select"
                :title="store.locales=='zh'?'选择视图':'Select view'">
          <option v-for="v in viewsForGrid" :key="v" :value="v">{{ viewName(v) }}</option>
        </select>
        <div class="views-btn" @click="emit('reset-view-sizes')" :title="store.locales=='zh'?'平均分配视图宽度':'Distribute equally'">
          <i class="fa fa-arrows-h"></i>
        </div>
        <div class="views-btn" @click="closeAllViews" :title="store.locales=='zh'?'全部关闭':'Close all'">
          <i class="fa fa-eye-slash"></i>
        </div>
      </div>
      <!-- 未打开工作区时隐藏工具栏（无可用控件），由下方空态引导提供「打开工作区/打开文件」入口 -->
      <div class="tree-toolbar" :title="store.root" v-if="store.root!='' || store.remoteRoots.length">
        <!-- 新窗口模式下：视图选择常驻于搜索栏左侧（窗口内模式用上方弹出视图管理） -->
        <select v-if="store.UI.fileOpenMode === 'window' && store.root!=''" :value="activeGlobalView" @change="onGlobalViewChange" class="views-select tree-view-select"
                :title="store.locales=='zh'?'选择视图':'Select view'">
          <option v-for="v in viewsForGrid" :key="v" :value="v">{{ viewName(v) }}</option>
        </select>
        <!-- 新窗口模式下 4 按钮组（来自 explorer 的 toolbar slot；与视图/搜索框同一行，面板变窄时搜索框自动换行） -->
        <slot name="toolbar" />
        <!-- 搜索框（参照 home.vue chat-toolbar 样式；flex 1 1 160px：宽度不足时自动换到下一行独占） -->
        <div v-if="store.root!=''" class="tree-search-box">
          <i class="fa fa-search"></i>
          <input v-model="filterText" class="tree-search-input" :placeholder="store.locales=='zh'?'搜索文件':'search file'"/>
          <div v-if="filterText" class="tree-search-clear" @click="filterText=''" :title="store.locales=='zh'?'清除':'Clear'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
        <!-- 添加按钮（参照 home.vue chat-toolbar 样式；新窗口模式下已移入工具栏按钮组） -->
        <div class="tree-new-btn" v-if="store.root!=''&&mode=='file'&&store.UI.fileOpenMode !== 'window'" @click="promptCreateFile" :title="store.locales=='zh'?'创建文件':'Create File'">
          <i class="fa fa-plus"></i>
        </div>
      </div>
      <div class="tree-scroll scoll">
        <!-- 未打开任何工作区：清晰引导新手如何开始使用 -->
        <div v-if="store.root=='' && !store.remoteRoots.length" class="tree-empty-guide">
          <div class="guide-inner">
            <i class="fa fa-folder-open-o guide-icon"></i>
            <div class="guide-title">{{ store.locales=='zh' ? '打开工作区开始使用' : 'Open a Workspace to Start' }}</div>
            <div class="guide-desc">{{ store.locales=='zh' ? '选择一个文件夹作为工作区，即可浏览和管理其中的文件与知识库；也可以单独打开一个文件查看。' : 'Pick a folder as your workspace to browse and manage files and knowledge bases, or open a single file directly.' }}</div>
            <div class="guide-actions">
              <button class="guide-btn guide-btn-primary" @click="openFolderDialog">
                <i class="fa fa-folder-open-o"></i><span>{{ store.locales=='zh' ? '打开本地工作区' : 'Local Workspace' }}</span>
              </button>
              <button class="guide-btn guide-btn-remote" @click="promptAddRemote">
                <i class="fa fa-cloud"></i><span>{{ store.locales=='zh' ? '连接远程工作区' : 'Remote Workspace' }}</span>
              </button>
              <button class="guide-btn" @click="selectFile">
                <i class="fa fa-file-text-o"></i><span>{{ store.locales=='zh' ? '打开文件' : 'Open File' }}</span>
              </button>
            </div>
          </div>
        </div>
        <el-tree
          v-else
          ref="treeRef"
          node-key="path"
          :data="mergedTree"
          :filter-node-method="filterNode"
          :default-expanded-keys="expandedKeys"
          lazy
          :load="loadTreeNode"
          :props="{ isLeaf: (data: any) => data.type === 'file' }"
          draggable
          :allow-drag="allowDrag"
          :allow-drop="allowDrop"
          @node-drop="handleDrop"
          @node-click="click"
          @node-contextmenu="handleRightClick"
          @node-expand="handleNodeExpand"
          @node-collapse="handleNodeCollapse"
          >
        <!-- 空态：加载中显示转圈，否则提示暂无文件（替代 el-tree 默认的 "No Data"） -->
        <template #empty>
          <div v-if="treeLoading" class="tree-loading">
            <i class="fa fa-spinner fa-spin"></i>
            <span>{{ store.locales=='zh'?'正在加载文件...':'Loading files...' }}</span>
          </div>
          <div v-else class="tree-loading">
            <i class="fa fa-folder-open-o"></i>
            <span>{{ store.locales=='zh'?'暂无文件':'No Data' }}</span>
          </div>
        </template>
        <template #default="{ node, data }">
          <div class="custom-tree-node" :class="{ 'tab-open': isTabOpen(data.path), 'tab-active': isActiveTab(data.path), 'workspace-root': isWorkspaceRoot(data.path), 'remote-root': data.remote }">
            <span class="tree-content" @mousemove="showTooltip($event, data)" @mouseleave="hideTooltip">
              <i v-if="data.remote" :class="data.isRemoteRoot ? 'fa fa-cloud' : (data.type === 'folder' ? 'fa fa-folder' : 'fa fa-file-text-o')" style="color:#42b883"></i>
              <i v-else :class="store.icon(data.extension)"></i> &nbsp; 
              <span class="tree-label">{{ data.label }}</span>
            </span>
            <!-- 远程工作区根节点：最右侧刷新按钮，重新拉取内部文件 -->
            <span v-if="data.isRemoteRoot" class="remote-refresh-btn" @click.stop="refreshRemoteRoot(data)" :title="store.locales=='zh'?'刷新远程文件':'Refresh remote files'">
              <i class="fa fa-refresh"></i>
            </span>
          </div>
        </template>
      </el-tree>
      </div>
    </div>
    <div v-if="contextMenu.visible" :style="contextMenu.style" class="context-menu" @click.stop @mouseleave="hideContextMenu">
      <!-- 远程节点右键：预览 / 下载 / 删除所属远程工作区 -->
      <template v-if="contextMenu.isRemote && contextMenu.node">
        <template v-if="contextMenu.node.type === 'file'">
          <div class="menu-item" @click="clickRemoteNode(contextMenu.node, { preview: true }); hideContextMenu()">
            <i class="fa fa-eye" style="color:#42b883"></i> {{ store.locales=='zh'?'预览':'Preview' }}
          </div>
          <div class="menu-item" @click="remoteContextAction()">
            <i class="fa fa-download" style="color:#42b883"></i> {{ store.locales=='zh'?'下载到本地工作区':'Download to Local Workspace' }}
          </div>
          <div class="menu-divider"></div>
        </template>
        <div class="menu-item" @click="removeRemoteRoot(remoteRootOf(contextMenu.node) as any); hideContextMenu()">
          <i class="fa fa-trash"></i> {{ store.locales=='zh'?'删除远程工作区':'Remove Remote Workspace' }}
        </div>
      </template>
      <!-- 工作区根目录右键：仅显示系统打开 + 删除该工作区 -->
      <template v-else-if="contextMenu.isRoot">
        <div class="menu-item" @click="store.openByApp(contextMenu.node.path); hideContextMenu()">
          <i class="fa fa-external-link"></i> {{ store.locales=='zh'?'系统打开':'Open in System' }}
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click="deleteWorkspaceRoot()">
          <i class="fa fa-trash"></i> {{ store.locales=='zh'?'删除该工作区':'Delete Workspace' }}
        </div>
      </template>
      <template v-else>
      <!-- 空白区域：添加工作区 -->
      <div class="menu-item" v-if="!contextMenu.node" @click="openFolderDialog(); hideContextMenu()">
        <i class="fa fa-folder-open"></i> {{ store.locales=='zh'?'添加本地工作区':'Add Local Workspace' }}
      </div>
      <div class="menu-item" v-if="!contextMenu.node" @click="promptAddRemote(); hideContextMenu()">
        <i class="fa fa-cloud" style="color:#42b883"></i> {{ store.locales=='zh'?'连接远程工作区':'Connect Remote Workspace' }}
      </div>
      <div class="menu-divider" v-if="!contextMenu.node"></div>
      <!-- 打开（一级，仅文件） -->
      <div class="menu-item has-submenu" v-if="contextMenu.node">
        <i class="fa fa-folder-open-o"></i>
        <span style="flex:1">{{ store.locales=='zh'?'打开':'Open' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li @click="store.openInApp(contextMenu.node); hideContextMenu()">
            <i class="fa fa-file-text-o"></i> {{ store.locales=='zh'?'软件内打开':'In App' }}
          </li>
          <li class="has-submenu">
            <i class="fa fa-window-maximize"></i>
            <span style="flex:1">{{ store.locales=='zh'?'新窗口打开':'New Window' }}</span>
            <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
            <ul class="submenu">
              <li v-for="v in FILE_VIEWS_DEFS" :key="v.key" v-show="!isWordNode || !READONLY_VIEW_KEYS.includes(v.key)"
                  @click="openInNewWindow(contextMenu.node.path, v.key); hideContextMenu()">
                <i :class="v.icon"></i> {{ store.locales=='zh' ? v.name : v.labelEn }}
              </li>
            </ul>
          </li>
          <li @click="store.openByApp(contextMenu.node.path); hideContextMenu()">
            <i class="fa fa-external-link"></i> {{ store.locales=='zh'?'系统打开':'System' }}
          </li>
        </ul>
      </div>
      <!-- 操作（一级，仅右键到文件夹且有工作区时显示；创建文件位置取决于点击的文件夹） -->
      <div class="menu-item has-submenu" v-if="contextMenu.node && contextMenu.node.type === 'folder' && store.root">
        <i class="fa fa-wrench"></i>
        <span style="flex:1">{{ store.locales=='zh'?'操作':'Actions' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li v-if="contextMenu.node" @click="copyNode(contextMenu.node); hideContextMenu()">
            <i class="fa fa-copy"></i> {{ store.locales=='zh'?'复制':'Copy' }}
          </li>
          <li v-if="copiedPath" @click="pasteNode(); hideContextMenu()">
            <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
          </li>
          <li @click="promptCreateFile(); hideContextMenu()">
            <i class="fa fa-plus"></i> {{ store.locales=='zh'?'创建文件':'Create File' }}
          </li>
          <li @click="promptCreateFolder(); hideContextMenu()">
            <i class="fa fa-folder"></i> {{ store.locales=='zh'?'创建文件夹':'Create Folder' }}
          </li>
          <div class="menu-divider"></div>
          <li @click="selectFile(); hideContextMenu()">
            <i class="fa fa-file-text"></i> {{ store.locales=='zh'?'打开文件':'Open File' }}
          </li>
          <li @click="openFolderDialog(); hideContextMenu()">
            <i class="fa fa-folder-open"></i> {{ store.locales=='zh'?'打开文件夹':'Open Folder' }}
          </li>
        </ul>
      </div>
      <div class="menu-divider" v-if="contextMenu.node"></div>
      <!-- 排序（一级，始终显示） -->
      <div class="menu-item has-submenu">
        <i class="fa fa-sort"></i>
        <span style="flex:1">{{ store.locales=='zh'?'排序':'Sort' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li @click="setSort('name'); hideContextMenu()">
            <i :class="sortBy=='name' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh'?'名称':'Name' }}</span>
            <i v-if="sortBy=='name'" :class="sortOrder=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
          <li @click="setSort('mtime'); hideContextMenu()">
            <i :class="sortBy=='mtime' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh'?'修改时间':'Modified' }}</span>
            <i v-if="sortBy=='mtime'" :class="sortOrder=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
          <li @click="setSort('size'); hideContextMenu()">
            <i :class="sortBy=='size' ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh'?'大小':'Size' }}</span>
            <i v-if="sortBy=='size'" :class="sortOrder=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
        </ul>
      </div>
      <!-- 重命名（一级，仅文件） -->
      <div class="menu-item" v-if="contextMenu.node" @click="startRename(contextMenu.node)">
        <i class="fa fa-edit"></i> {{ store.locales=='zh'?'重命名':'Rename' }}
      </div>
      <!-- 删除（一级，仅文件） -->
      <div class="menu-item" v-if="contextMenu.node" @click="deleteFile">
        <i class="fa fa-trash"></i> {{ store.locales=='zh'?'删除':'Delete' }}
      </div>
      </template>
    </div>
    <!-- 悬浮提示（跟随鼠标显示文件信息） -->
    <div v-if="tooltipVisible && tooltipData" class="tree-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.size != null">{{ store.locales=='zh'?'大小':'Size' }}: {{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime">{{ store.locales=='zh'?'修改时间':'Modified' }}: {{ formatTime(tooltipData.mtime) }}</div>
    </div>

    <!-- 创建文件对话框（类型 + 文件名，紧凑弹窗，样式参照集群「编辑 Agent」） -->
    <Teleport to="body">
      <div v-if="createDialogVisible" class="pf-overlay" @click="createDialogVisible = false"></div>
      <div v-if="createDialogVisible" class="pf-pop">
        <div class="pf-head">
          <span class="pf-title"><i class="fa fa-file-text-o"></i> {{ store.locales=='zh'?'创建文件':'Create File' }}</span>
          <button class="pf-close" @click="createDialogVisible = false" :title="store.locales=='zh'?'关闭':'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="pf-body">
          <div class="pf-types">
            <div class="pf-type" :class="{ on: createFileType === 'md' }" @click="createFileType = 'md'"><i class="fa fa-file-text-o"></i>Markdown</div>
            <div class="pf-type" :class="{ on: createFileType === 'excalidraw' }" @click="createFileType = 'excalidraw'"><i class="fa fa-paint-brush"></i> Excalidraw</div>
            <div class="pf-type" :class="{ on: createFileType === 'drawio' }" @click="createFileType = 'drawio'"><i class="fa fa-object-group"></i> draw.io</div>
          </div>
          <input
            v-model="createFileName"
            class="pf-input"
            :placeholder="store.locales=='zh'?'请输入文件名':'Enter file name'"
            @keyup.enter="confirmCreateFile"
            @keyup.esc="createDialogVisible = false"
          />
        </div>
        <div class="pf-actions">
          <button class="pf-btn pf-cancel" @click="createDialogVisible = false">{{ store.locales=='zh'?'取消':'Cancel' }}</button>
          <button class="pf-btn pf-ok" @click="confirmCreateFile">{{ store.locales=='zh'?'创建':'Create' }}</button>
        </div>
      </div>
    </Teleport>

    <!-- 添加远程工作区对话框（紧凑弹窗，样式参照集群「编辑 Agent」） -->
    <Teleport to="body">
      <div v-if="addRemoteDialogVisible" class="pf-overlay" @click="addRemoteDialogVisible = false"></div>
      <div v-if="addRemoteDialogVisible" class="pf-pop pf-pop-remote">
        <div class="pf-head">
          <span class="pf-title"><i class="fa fa-cloud" style="color:#42b883"></i> {{ store.locales=='zh'?'添加远程工作区':'Add Remote Workspace' }}</span>
          <button class="pf-close" @click="addRemoteDialogVisible = false" :title="store.locales=='zh'?'关闭':'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="pf-body">
          <div class="rf-field rf-link-field">
            <label>{{ store.locales=='zh'?'链接':'Link' }}</label>
            <input :value="remoteLinkDraft" @input="onRemoteLinkInput(($event.target as HTMLInputElement).value)"
                   :placeholder="store.locales=='zh'?'粘贴 remote-fs://… 自动填充':'Paste remote-fs://… to autofill'" />
          </div>
          <div class="rf-field">
            <label>{{ store.locales=='zh'?'名称':'Name' }}</label>
            <input v-model="remoteForm.name" :placeholder="store.locales=='zh'?'可选，默认主机名':'Optional, defaults to host'" />
          </div>
          <div class="rf-field">
            <label>{{ store.locales=='zh'?'主机':'Host' }}</label>
            <input v-model="remoteForm.host" :placeholder="store.locales=='zh'?'如 192.168.1.100':'e.g. 192.168.1.100'" />
          </div>
          <div class="rf-field">
            <label>{{ store.locales=='zh'?'端口':'Port' }}</label>
            <input v-model.number="remoteForm.port" type="number" min="1024" max="65535" />
          </div>
          <div class="rf-field">
            <label>Token</label>
            <input v-model="remoteForm.token" :placeholder="store.locales=='zh'?'共享访问凭据':'Share access token'" />
          </div>
          <div class="rf-hint">
            {{ store.locales=='zh'?'从主机「设置 → 协作 → 共享文件夹」获取主机、端口与 Token。远程文件为只读，编辑需下载到本地工作区。':'Get host, port and token from the host\'s Settings → Collaboration → Shared Folder. Remote files are read-only; edit after downloading to a local workspace.' }}
          </div>
        </div>
        <div class="pf-actions">
          <button class="pf-btn pf-cancel" @click="addRemoteDialogVisible = false">{{ store.locales=='zh'?'取消':'Cancel' }}</button>
          <button class="pf-btn pf-ok" @click="confirmAddRemote">{{ store.locales=='zh'?'连接':'Connect' }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
  /* 保持原有样式，添加新的样式 */
  
  .bg {
    position: relative;
    height: 100%;
    display: block;
  }

  /* 文件树工具栏（参照 home.vue chat-toolbar 样式） */
  .tree-toolbar {
    display: flex;
    flex-wrap: wrap; /* 面板变窄时，搜索框可自动换行到下一行 */
    align-items: center;
    gap: 4px;
    padding: 5px;
    flex-shrink: 0;
    white-space: nowrap;
    user-select: none;
    container-type: inline-size; /* 启用宽度容器查询：按面板宽度切换 宽/窄 布局 */
  }
  .tree-search-box {
    flex: 1 1 80px; /* 最小 80px：宽度不足时整体换行独占一行 */
    min-width: 0;
    height: 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background-color: var(--backgroundColor);
    color: var(--borderColor);
    font-size: 12px;
  }
  .tree-search-box > i {
    flex-shrink: 0;
    font-size: 12px;
  }
  .tree-search-input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--fontColor);
    font-size: 12px;
  }
  .tree-search-clear {
    flex-shrink: 0;
    cursor: pointer;
    font-size: 12px;
    color: var(--borderColor);
  }
  .tree-search-clear:hover {
    color: var(--fontActiveColor);
  }
  .tree-new-btn {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    cursor: pointer;
    color: var(--fontColor);
    background-color: var(--backgroundColor);
    font-size: 12px;
    transition: all 0.15s ease;
  }
  .tree-new-btn:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }

  /* 视图管理面板（list scoll 上方）：视图下拉 + 均分/关闭图标按钮同一行 */
  .views-container {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--borderColor);
  }
  .views-select {
    flex: 1;
    min-width: 0;
    width: auto; /* 覆盖全局 select 的 calc(100% - 10px) */
    height: 24px;
    margin: 0; /* 覆盖全局 select 的 margin: 5px */
    padding: 0 4px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background-color: var(--backgroundColor);
    color: var(--fontColor);
    font-size: 12px;
    outline: none;
    cursor: pointer;
  }
  .views-select option {
    background-color: var(--menuColor);
    color: var(--fontColor);
  }
  .views-btn {
    flex-shrink: 0;
    width: 26px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    cursor: pointer;
    color: var(--fontColor);
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    user-select: none;
  }
  .views-btn:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  /* 新窗口模式：搜索栏左侧的常驻视图下拉（复用 .views-select 基础样式，覆盖 toolbar 语境；
     宽面板时固定 76px，由搜索框占满剩余；窄面板时（见下方 @container）拉伸填满第一行按钮后的空白） */
  .tree-view-select {
    flex: 0 0 auto;
    width: 76px;
    height: 28px;
    margin: 0;
    box-sizing: border-box;
  }
  .tree-view-select option {
    background-color: var(--menuColor);
    color: var(--fontColor);
  }

  /* 新窗口模式（存在 tree-view-select 时）宽面板：搜索框占满剩余宽度，视图下拉固定 */
  .tree-toolbar:has(.tree-view-select) .tree-search-box {
    flex: 1 1 0;
    min-width: 0;
  }
  /* 窄面板（容器 < 400px）：搜索框换行独占一行，视图下拉拉伸填满第一行按钮后的空白 */
  @container (max-width: 399px) {
    .tree-toolbar:has(.tree-view-select) .tree-view-select {
      flex: 1 1 auto;
      min-width: 76px;
      width: auto;
    }
    .tree-toolbar:has(.tree-view-select) .tree-search-box {
      flex: 1 1 100%;
      min-width: 0;
    }
  }

  .list {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    user-select: none;
    background-color: var(--backgroundColor);
  }
  .tree-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* 文件树空态/加载指示（替代 el-tree 默认 "No Data"） */
  .tree-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 24px 0;
    color: var(--borderColor);
    font-size: 12px;
    user-select: none;
  }
  .tree-loading i {
    font-size: 14px;
  }

  /* 未打开工作区时的引导空态（清晰提示新手如何开始） */
  .tree-empty-guide {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
  }
  .guide-inner {
    text-align: center;
    max-width: 320px;
  }
  .guide-icon {
    font-size: 42px;
    color: var(--borderColor);
    margin-bottom: 12px;
  }
  .guide-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--fontColor);
    margin-bottom: 8px;
  }
  .guide-desc {
    font-size: 12px;
    line-height: 1.7;
    color: var(--borderColor);
    margin-bottom: 18px;
  }
  .guide-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .guide-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background: var(--menuColor);
    color: var(--fontColor);
    cursor: pointer;
    transition: all .15s ease;
    user-select: none;
  }
  .guide-btn:hover {
    border-color: var(--fontActiveColor);
    color: var(--fontActiveColor);
  }
  .guide-btn-primary {
    background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
    border-color: color-mix(in srgb, var(--fontActiveColor) 40%, var(--borderColor));
    color: var(--fontActiveColor);
    font-weight: 600;
  }
  .guide-btn-primary:hover {
    background: color-mix(in srgb, var(--fontActiveColor) 22%, transparent);
  }
  /* 远程工作区按钮：绿色云图标，与远程工作区配色一致 */
  .guide-btn-remote {
    color: #42b883;
    border-color: color-mix(in srgb, #42b883 50%, var(--borderColor));
  }
  .guide-btn-remote:hover {
    border-color: #42b883;
    color: #42b883;
    background: color-mix(in srgb, #42b883 10%, transparent);
  }

  /* 远程工作区根节点：加粗名称 */

  /* ===== 紧凑弹窗（创建文件 / 添加远程工作区；样式参照集群「编辑 Agent」弹层） ===== */
  .pf-overlay {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(1px);
  }
  .pf-pop {
    position: fixed; z-index: 501;
    width: 300px; max-width: calc(100vw - 16px);
    background: var(--menuColor);
    border: 1px solid var(--borderColor); border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
    padding: 8px; display: flex; flex-direction: column; gap: 6px;
    left: 50%; top: 50%; transform: translate(-50%, -50%);
  }
  .pf-pop-remote { width: 340px; }
  .pf-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .pf-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 5px; }
  .pf-title i { color: var(--fontActiveColor); font-size: 11px; }
  .pf-close {
    width: 20px; height: 20px; padding: 0; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--borderColor); border-radius: 4px;
    background: var(--backgroundColor); color: var(--fontColor);
    cursor: pointer; font-size: 11px;
  }
  .pf-close:hover { color: #f44336; border-color: #f44336; }
  .pf-body { display: flex; flex-direction: column; gap: 5px; }
  .pf-types { display: flex; gap: 3px; }
  .pf-type {
    flex: 1; padding: 4px 4px; font-size: 10px;
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    border: 1px solid var(--borderColor); border-radius: 4px;
    background: var(--backgroundColor); color: var(--fontColor); opacity: .75;
    cursor: pointer; transition: all .12s;
  }
  .pf-type i { font-size: 10px; }
  .pf-type:hover { opacity: 1; color: var(--fontActiveColor); }
  .pf-type.on {
    opacity: 1; color: var(--fontActiveColor); font-weight: 600;
    border-color: var(--borderColor);
    background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  }
  .pf-input {
    width: 100%; box-sizing: border-box;
    font-size: 11px; line-height: 1.5;
    border: 1px solid var(--borderColor); border-radius: 4px;
    background: var(--backgroundColor); color: var(--fontColor);
    padding: 5px 6px; outline: none; margin: 0px
  }
  .pf-input:focus { border-color: var(--fontActiveColor); }
  .pf-actions { display: flex; gap: 4px; justify-content: flex-end; }
  .pf-btn {
    padding: 3px 10px; font-size: 11px;
    border: 1px solid var(--borderColor); border-radius: 4px;
    background: var(--backgroundColor); color: var(--fontColor);
    cursor: pointer; transition: all .12s;
  }
  .pf-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
  .pf-ok {
    background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
    border-color: color-mix(in srgb, var(--fontActiveColor) 40%, var(--borderColor));
    color: var(--fontActiveColor); font-weight: 600;
  }
  /* 添加远程工作区字段 */
  .rf-field { display: flex; align-items: center; gap: 6px; }
  .rf-field label { min-width: 42px; font-size: 11px; flex-shrink: 0; padding:0px }
  .rf-field input {
    flex: 1; min-width: 0; box-sizing: border-box;
    font-size: 11px; line-height: 1.5;
    border: 1px solid var(--borderColor); border-radius: 4px;
    background: var(--backgroundColor); color: var(--fontColor);
    padding: 4px 6px; outline: none; margin: 0px
  }
  .rf-field input:focus { border-color: var(--fontActiveColor); }
  /* 链接输入框：绿色高亮，提示粘贴共享链接 */
  .rf-link-field input {
    border-color: color-mix(in srgb, #42b883 50%, var(--borderColor));
    background: color-mix(in srgb, #42b883 6%, var(--backgroundColor));
    color: #42b883;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 10.5px;
  }
  .rf-link-field input::placeholder { color: color-mix(in srgb, #42b883 60%, var(--fontColor)); }
  .rf-link-field input:focus { border-color: #42b883; }
  .rf-hint {
    font-size: 10px; opacity: 0.7; line-height: 1.5;
    background: color-mix(in srgb, var(--menuColor) 60%, transparent);
    border-radius: 4px; padding: 5px 7px;
  }

  .menu{
    z-index:9999;
    position:fixed;
  }
  
  .menu ul{
    position:absolute;
    width:80px;
    border: 1px solid var(--borderColor);
    background-color: var(--menuColor);
    border-radius: 5px;
    list-style-type: none;
    padding-left: 0px;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
  }
  
  .menu li{
    padding: 2px;
    padding-left: 10px;
    border-radius: 5px;
    width:calc(100% - 12px);
    display:inline-block;
    position: relative;
  }
  
  .menu li:hover{
    background-color: var(--menuActiveColor);
  }
  
  .menu li>ul{
    left: 80px;
    top: 0px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
    width:122px;
  }
  
  .menu li:hover>ul{
    display: block;
  }
  
  .menu li>ul>li{
    background-color:var(--menuColor);
    list-style-type:none;
    float:left;
    width:110px;
  }
  
  .content::-webkit-scrollbar {
    display: none;
  }
  
  .custom-tree-node {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    padding-right:2px;
  }

  /* 远程工作区根节点最右侧的刷新按钮 */
  .remote-refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-left: 6px;
    border-radius: 4px;
    color: #42b883;
    cursor: pointer;
    font-size: 11px;
    flex-shrink: 0;
    opacity: 0.6;
    transition: all 0.15s ease;
  }
  .remote-refresh-btn:hover {
    opacity: 1;
    background: color-mix(in srgb, #42b883 18%, transparent);
  }
  
  .el-tree {
    background-color: var(--backgroundColor) !important;
    color: var(--fontColor);
    --el-tree-node-hover-bg-color: var(--menuActiveColor);
    --el-tree-text-color: var(--fontColor);
    --el-tree-expand-icon-color: var(--fontColor);
  }

  .el-tree-node {
    background-color: var(--backgroundColor);
  }

  .el-tree-node__content {
    background-color: var(--backgroundColor);
    color: var(--fontColor);
  }

  .el-tree-node__content:hover {
    background-color: var(--menuActiveColor) !important;
  }

  .el-tree-node:focus > .el-tree-node__content,
  .el-tree-node.is-current > .el-tree-node__content {
    background-color: var(--menuActiveColor) !important;
    color: var(--fontActiveColor);
  }
  
  .is-current{
    background-color: var(--menuColor) !important;
  }

  /* 工作区根目录（顶层节点）：背景色为 menuColor；子级目录无背景色 */
  :deep(.el-tree > .el-tree-node > .el-tree-node__content) {
    background-color: var(--menuColor) !important;
  }

  /* 工作区根目录文字加粗，便于与子级目录区分 */
  .custom-tree-node.workspace-root .tree-label {
    font-weight: bold;
  }
  
  /* 右键菜单样式统一在 explorer.vue 中定义 */
  .context-menu {
    min-width: 160px;
  }

  /* 已打开的标签：用主题色标识并加粗 */
  .custom-tree-node.tab-open .tree-label {
    color: var(--primaryColor);
    font-weight: bold;
  }
  .custom-tree-node.tab-open .tree-content i {
    color: var(--primaryColor);
  }

  /* 当前激活的标签：高亮加粗 */
  .custom-tree-node.tab-active .tree-label {
    color: var(--fontActiveColor);
    font-weight: bold;
  }
  .custom-tree-node.tab-active .tree-content i {
    color: var(--fontActiveColor);
  }

  /* 悬浮提示（跟随鼠标） */
  .tree-tooltip {
    position: fixed;
    z-index: 99999;
    background: var(--menuColor);
    color: var(--fontColor);
    font-size: 12px;
    line-height: 1.8;
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
    pointer-events: none;
    max-width: 60vw;
  }

  /* 文件名：过长时换行显示，避免超出视口 */
  .tooltip-name {
    white-space: normal;
    word-break: break-all;
    font-weight: bold;
    color: var(--fontColor);
  }
  
</style>