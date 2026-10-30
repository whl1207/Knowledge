<script setup lang="ts">
  import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick, markRaw } from 'vue'
  import { usestore, markRawTree, isPathInside, folderLabelOf } from '@/store'
  import { ElTree } from 'element-plus'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import type { RemoteRoot, RemoteFsNode } from '@/types/collab'
  import { fetchFsInfo, fetchFsList, downloadRemoteFile, remotePathOf } from '@/platform/remoteFs'
  import { buildRemotePreviewTab } from '@/lib/knowFile/remotePreview'
  import { FILE_VIEWS as FILE_VIEWS_DEFS, supportsOfficeView } from '@/lib/knowFile/fileViews'
  import { NEW_FILE_TYPES, newFileType, writeNewFileSkeleton, type NewFileTypeKey } from '@/lib/knowFile/newFileTypes'
  import { FILE_SORT_ITEMS, fileTypeKey, type FileSortKey } from '@/lib/knowFile/fileSort'
  // 文件系统变更：全局单例订阅 + 目录监听租约（见 lib/knowFile/fileWatch.ts）
  import { onFileSystemChanged, acquireFileWatch, releaseFileWatch } from '@/lib/knowFile/fileWatch'
  import { shouldSkipTextPreview } from '@/lib/knowFile/textPreview'
  import { getPlatform, hasCapability, getRuntimeKind } from '@/platform'
  
  const store = usestore()

  const props = defineProps<{
    /**
     * 打开文件前的守卫（宿主 explorer 提供）：右侧有正在编辑的文件标签时，
     * 先让用户处理未保存内容；返回 false 表示取消本次打开。
     * 远程文件的单击预览由本组件直接改 store，所以必须在这里也守一次。
     */
    guardLeave?: () => Promise<boolean>
    /**
     * 只显示这个工作区（右侧栏文件标签用）：为空 = 沿用全局工作区列表。
     * 设置后本面板不再改动全局 store.root / store.roots / store.tree，只维护自己的局部树。
     */
    scopeRoot?: string
  }>()

  /** 宿主（explorer.vue）用 node-opened 收起细长窗口下的整屏文件树抽屉 */
  const emit = defineEmits<{
    (e: 'node-opened', data?: any): void
    /** 文件：由宿主在右侧标签栏里以文件标签打开（不再新开窗口） */
    (e: 'open-file', payload: { data: any; view?: string }): void
    /** 显式要求另开窗口 / 浮层（宿主先处理当前文件标签的未保存内容） */
    (e: 'open-standalone', payload: any): void
  }>()

  /**
   * 右侧栏文件树（scopeRoot 非空）：
   * - 只从该工作区建树，搜索也只用它；
   * - 树数据放在局部 ref，不覆盖全局 store.tree（主资源管理器的树还在用）；
   * - 不切换全局 store.root / roots，删除/新建等操作仍用绝对路径。
   */
  const scopeRoot = computed(() => String(props.scopeRoot || '').replace(/[\\/]+$/, ''))
  const scoped = computed(() => !!scopeRoot.value)
  const effectiveRoot = computed(() => scopeRoot.value || String(store.root || ''))
  const effectiveRoots = computed<string[]>(() => {
    if (scoped.value) return [scopeRoot.value]
    const roots = (store.roots && store.roots.length ? [...store.roots] : []).filter(Boolean)
    if (!roots.length && store.root) roots.push(String(store.root))
    return roots
  })
  /** 新建 / 粘贴的默认目录：范围内的面板只看自己的根，不跟随全局 store.path */
  const currentDir = computed(() => (scoped.value ? scopeRoot.value : String(store.path || store.root || '')))
  const localTree = ref<any[]>([])
  const treeData = computed<any[]>(() => (scoped.value ? localTree.value : store.tree))
  const setTreeData = (next: any[]) => {
    if (scoped.value) localTree.value = next
    else store.tree = next
  }

  const filterText = ref('') //按文件名搜索（全树，有预算；不再用 el-tree 的本地过滤）
  const treeRef = ref<InstanceType<typeof ElTree>>() //树状图数据
  const expandedKeys = ref<string[]>([]); //展开状态数据

  
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

  // 安卓（触摸屏）：单击即打开文件 / 进入文件夹。
  // 手机上没有鼠标、双击要靠连点两次，浏览器还会把双击当成缩放（单击被吞）——桌面上
  // 「单击只选中、双击才打开」的约定在触摸屏上表现为「点了没反应」。
  const tapOpensDirectly = getRuntimeKind() === 'android'

  /** 打开文件 / 进入目录（单击即打开与双击打开共用同一套分发） */
  const openOrEnterNode = (data: any) => {
    // 超大目录的「其余 N 项未显示」提示行：不是真实文件，不参与打开
    if (data?.isTruncatedHint) {
      ElMessage.info(store.locales === 'zh' ? '该目录条目过多，已只显示前一部分，请用上方搜索定位文件' : 'Too many entries; use search to locate files')
      return
    }
    // 通知宿主（explorer）：细长窗口下据此收起整屏文件树抽屉，把屏幕让给右侧视图
    emit('node-opened', data)
    // 按节点类型分发：
    //  - 文件：交给宿主在右侧**标签栏**里打开（标签内容复用文件窗口的多视图选择）。
    //    特殊文件（.kb / .task / .html / 系统打开类）由 store.openFileInTab 统一识别处理。
    //  - 文件夹（含工作区根目录）：只让右侧各视图定位到该目录；树本身不展开 /
    //    折叠（展开 / 折叠点节点左侧箭头，这样双击不会出现先开后收的闪动）；
    //    也绝不能当文件标签打开（文件夹被 addTab 后编辑视图会按文件读取目录 → EISDIR 报错）
    if (data.type === 'file') {
      emit('open-file', { data })
      return
    }
    // 右侧栏文件树只浏览/操作当前工作区：点文件夹交给 el-tree 展开收起，
    // 不切换全局工作区、不驱动主界面右侧视图。
    if (scoped.value) return
    // 目录可能属于**另一个工作区**（不在当前 root 下）：先把它所属的工作区设为当前工作区，
    // 否则跨工作区打开文件夹会被下面的 isPathInside 挡掉、右侧各视图拿不到点击的路径（静默无反应）
    const owner = store.roots
      .filter((r: string) => isPathInside(data.path, r))
      .sort((a: string, b: string) => b.length - a.length)[0]
    if (owner && owner !== store.root) store.setActiveRoot(owner)
    // 右侧各视图（文件 / 看板 / 表格 / 图谱 / 地图 / 日历）跟随该目录，与「文件」视图进入文件夹、
    // 点击面包屑同一套导航；用 isPathInside 而非 startsWith：盘符大小写 / 结尾分隔符不同时也要算
    // 「在工作区内」，否则会静默不切换当前目录（看板等视图仍停在原目录）
    if (isPathInside(data.path, store.root)) store.knowEnterDir(data.path)
  }

  const click = function(data: any){
    // 「其余 N 项未显示」提示行：只做提示，不选中/不打开
    if (data?.isTruncatedHint) {
      openOrEnterNode(data)
      return
    }
    // 远程节点：文件 → 右侧标签栏（单窗口 / 安卓单击即打开，桌面单击快速预览、双击正式打开）；
    //         文件夹 → 右侧「文件」视图切到该远程目录（与本地文件夹联动同一套观感）
    if (data?.remote) {
      if (data.type === 'file') {
        handleRemoteFileClick(data)
        return
      }
      emit('node-opened', data)
      const root = remoteRootOf(data)
      if (root) {
        void syncRemoteRootPermission(root)
        // 远程目录只能在「文件」视图里展示：从看板 / 日历等切回来，避免点了文件夹却停在旧视图
        store.selectView('文件')
        store.knowEnterRemoteDir({
          rootId: root.id,
          rel: data.remoteRel || '',
          label: data.isRemoteRoot ? root.name : data.label,
        })
      }
      return
    }
    // 点击工作区根目录时切换为当前工作区（右侧栏范围内不切换全局工作区）
    const isRootNode = store.roots.includes(data.path)
    if (!scoped.value && isRootNode) {
      store.setActiveRoot(data.path)
    }

    // 安卓 / 右侧栏文件树：单击直接打开文件（文件夹由 el-tree 单击展开）
    if (tapOpensDirectly || scoped.value) {
      openOrEnterNode(data)
      return
    }

    nodeCount++
    //双击时打开标签
    if( preNodeId && nodeCount >= 2){
      curNodeId = data.path 
      nodeCount = 0
      if(curNodeId == preNodeId){//第一次点击的节点和第二次点击的节点id相同
        openOrEnterNode(data)
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

  // 系统分享面板（安卓 / 支持 Web Share 的环境才有；桌面隐藏入口）
  const canShare = hasCapability('shell.share')

  /** 分享节点：文件交给系统分享面板（手机可发到聊天软件 / 云盘 / 邮件） */
  const shareNode = async function(data: any) {
    hideContextMenu()
    const res = await getPlatform().shell.share(data.path)
    if (!res.success) {
      ElMessage.error((store.locales === 'zh' ? '分享失败: ' : 'Share failed: ') + (res.error || ''))
    }
  }

  // 开始重命名
  const startRename = async function(data: any) {
    // 范围模式的根由聊天工作区固定，重命名根会让 scopedRoot 立即失效（右键菜单也不提供）
    if (scoped.value && data?.path === scopeRoot.value) return
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
      const result = await getPlatform().fs.renameFile(data.path, trimmed)
      if (result.success) {
        // 若重命名的是工作区根目录，同步更新工作区列表（右侧栏范围模式不改全局工作区）
        const newPath = result.newPath || data.path
        if (!scoped.value) {
          const rootIdx = store.roots.indexOf(data.path)
          if (rootIdx !== -1) {
            store.roots[rootIdx] = newPath
          }
          if (store.root === data.path) {
            store.root = newPath;
          }
        }
        await refreshTreeAndViews();
        ElMessage.success('重命名成功');
      } else {
        ElMessage.error(`重命名失败: ${result.error}`);
      }
    } catch { /* 用户取消 */ }
  };

  // 打开/添加工作区文件夹
  const openFolderDialog = async function() {
    let path = await getPlatform().dialog.pickDirectory()
    if(path != null){
      // 添加为新的工作区并设为当前工作区（重复路径仅切换当前工作区，返回 false）
      const isNew = store.addRoot(path)
      if (!isNew) {
        ElMessage.warning(store.locales === 'zh' ? '该文件夹已在工作区列表中' : 'This folder is already in your workspace list')
        return
      }
      await refreshTreeAndViews()
      // 启动文件监听（监听所有工作区）
      await getPlatform().watch.acquire([...store.roots])
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

  /** 合并后的树：本地工作区 + 远程工作区（远程始终在所有折叠的最下方）；右侧栏只显示范围内的工作区 */
  const mergedTree = computed(() => (scoped.value ? treeData.value : [...treeData.value, ...remoteTreeData.value]))

  /**
   * 懒加载单个目录：只读「这一层」。
   *
   * 这是「选 D 盘不再闪退」的核心 —— 旧实现一次性把整个工作区扫成树再经 IPC 回传
   * （百万文件 = 数百 MB 对象），必然 OOM。现在内存只与用户实际展开过的目录成正比。
   */
  const fetchDirNodes = async (dir: string): Promise<any[]> => {
    const page = await getPlatform().fs.listDir(dir)
    const entries = page.entries || []
    if (page.error && !entries.length) {
      ElMessage.error(
        store.locales === 'zh'
          ? `无法读取目录：${page.error}`
          : `Cannot read folder: ${page.error}`
      )
      return []
    }
    const nodes = sortNodeList(entries.map((e: any) => markRaw({ ...e })))
    // 超大目录只列前 N 项：给一个明确的信息行，避免用户以为文件丢了
    if (page.truncated) {
      nodes.push(markRaw({
        label: store.locales === 'zh'
          ? `其余 ${Math.max(0, (page.total || 0) - entries.length)} 项未显示，请用上方搜索`
          : `${Math.max(0, (page.total || 0) - entries.length)} more not shown, use search`,
        path: `${dir}::truncated`,
        type: 'file',
        extension: '',
        isTruncatedHint: true,
      }))
    }
    return nodes
  }

  /** lazy 模式统一加载：本地目录按需读一层，远程目录调 /fs/list */
  const loadTreeNode = async (node: any, resolve: (data: any[]) => void) => {
    const data = node?.data
    // 注意：el-tree 在 lazy 模式下挂载时会直接对根节点调 load，此时根节点的 data 是
    // 整个 mergedTree 数组本身（而非带 children 的对象），必须直接 resolve 数组；
    // 否则二次挂载（store.tree 已就绪、data 不再变化、setData 不触发）会只剩空的根节点 → 不显示文件。
    if (Array.isArray(data)) {
      resolve(data)
      return
    }
    if (!data) {
      resolve([])
      return
    }
    if (!data.remote) {
      if (data.type !== 'folder') {
        resolve([])
        return
      }
      // 懒加载失败也必须 resolve：否则 el-tree 的 loading 会一直转（reject 会变成未处理拒绝）
      try {
        resolve(await fetchDirNodes(data.path))
      } catch (e) {
        console.error('[knowledge] 读取目录失败:', data?.path, e)
        resolve([])
      }
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

  /** 进远程目录时同步一次主机权限（只读 ⇄ 可编辑 Markdown），让工具栏 / 标签栏状态不过期 */
  const syncRemoteRootPermission = async (root: RemoteRoot) => {
    try {
      const info = await fetchFsInfo(root)
      if (root.permission !== info.permission) {
        root.permission = info.permission
        store.saveWorkspace()
      }
    } catch { /* 离线时沿用本地缓存，真正保存时服务端还会校验 */ }
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

  /** 打开远程文件标签：加入 store.data 后请求 explorer 把右侧标签切到它 */
  async function addRemoteTab(tab: any) {
    await store.addTab(tab)
    store.focusFileTab(tab.path)
  }

  /** 点击远程文件：读取内容并打开预览标签（单窗口 / 安卓一律进标签栏） */
  const clickRemoteNode = async (data: any, opts?: { preview?: boolean }) => {
    if (!data || data.type !== 'file') return
    // 多窗口模式没有标签栏：右键「预览」等入口仍打开独立文件窗口
    if (!store.singleWindowMode) {
      openRemoteInNewWindow(data)
      return
    }
    // 单窗口模式：远程预览会切到新的文件标签，先处理当前文件标签的未保存内容
    if (props.guardLeave && !(await props.guardLeave())) return
    const root = remoteRootOf(data)
    if (!root) return
    const rel = relOfRemoteNode(root, data)
    // quickPreview：单击快速预览（主窗口不显示远程只读条）；false/未传 = 正式打开（选到该标签时显示只读条）
    const isPreview = opts?.preview === true
    const result = await buildRemotePreviewTab(root, rel, data.label, isPreview)
    if (result.ok) {
      await addRemoteTab(result.tab)
      return
    }
    if (result.reason === 'download') {
      await promptDownloadRemote(root, rel, data.label)
      return
    }
    ElMessage.error(store.locales === 'zh' ? ('远程文件读取失败: ' + (result.error || '')) : ('Remote read failed: ' + (result.error || '')))
  }

  // ---- 远程文件打开：单窗口进标签栏，多窗口才另开窗口 ----

  /** 远程文件单击/双击判定：单击 → 主窗口内快速预览；320ms 内再次点击同一节点 → 正式打开 */
  const handleRemoteFileClick = (data: any) => {
    // 多窗口模式没有右侧标签栏：保持原行为，单击直接开独立窗口
    if (!store.singleWindowMode) {
      openRemoteByMode(data)
      return
    }
    // 安卓：单击即正式打开（进右侧标签栏；触摸屏没有可靠的「双击」）
    if (tapOpensDirectly) {
      openRemoteByMode(data)
      return
    }
    if (nodeTimer) { clearTimeout(nodeTimer); nodeTimer = null }
    const now = Date.now()
    // 双击：与上次单击同一节点且间隔在阈值内
    if (preNodeId === data.path && now - remoteClickAt <= REMOTE_DBL_MS) {
      preNodeId = null
      remoteClickAt = 0
      openRemoteByMode(data)
      return
    }
    // 单击：远程只读，主窗口内快速预览（不显示远程只读条）
    preNodeId = data.path
    remoteClickAt = now
    clickRemoteNode(data, { preview: true })
    nodeTimer = setTimeout(() => {
      preNodeId = null
      remoteClickAt = 0
      nodeTimer = null
    }, REMOTE_DBL_MS)
  }

  /**
   * 正式打开远程文件：
   *  - 单窗口（安卓 / 网页 / 桌面单窗口）：右侧标签栏，不再弹子窗口；
   *  - 多窗口（桌面默认）：保留原行为，在独立文件窗口打开。
   */
  const openRemoteByMode = (data: any) => {
    // 与本地文件一致：细长窗口下收起文件树抽屉，让屏幕交给文件窗口 / 右侧视图
    emit('node-opened', data)
    if (!store.singleWindowMode) {
      openRemoteInNewWindow(data)
      return
    }
    void clickRemoteNode(data)
  }

  /** 在新窗口（FileWindow.vue）打开远程文件：只读，默认浏览视图（可切导图/演示），可下载到本地 */
  const openRemoteInNewWindow = (data: any) => {
    const root = remoteRootOf(data)
    if (!root) return
    const rel = relOfRemoteNode(root, data)
    if (!rel) return
    const label = (data.label || rel.replace(/\\/g, '/').split('/').pop() || 'file')
    emit('open-standalone', {
      path: remotePathOf(root, rel),
      view: 'read',
      remoteRootId: root.id,
      remoteRel: rel,
      label,
    })
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
      await refreshTreeAndViews()
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
      candidate.permission = info.permission
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
  const sortBy = ref<FileSortKey>(store.treeSort?.by || 'name')
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

  /** 节点比较器（文件夹始终排在文件前面，与升降序无关；截断提示行固定排最后） */
  const compareNodes = (a: any, b: any): number => {
    if (a.isTruncatedHint) return 1
    if (b.isTruncatedHint) return -1
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    let result = 0
    if (sortBy.value === 'mtime') {
      result = (a.mtime || 0) - (b.mtime || 0)
    } else if (sortBy.value === 'size') {
      result = (a.size || 0) - (b.size || 0)
    } else if (sortBy.value === 'type') {
      // 按类型（扩展名）排序，同类型再按名称，避免同类型文件之间顺序随扫描结果变化
      result = naturalCompare(fileTypeKey(a.label), fileTypeKey(b.label))
        || naturalCompare(String(a.label ?? ''), String(b.label ?? ''))
    } else {
      result = naturalCompare(String(a.label ?? ''), String(b.label ?? ''))
    }
    return sortOrder.value === 'asc' ? result : -result
  }

  /**
   * 对「一个目录」的条目排序（懒加载后不再有整棵树可排）。
   * 只排当前这一层，不新建节点对象（避免响应式转换与大量 GC）。
   */
  const sortNodeList = (nodes: any[]): any[] => {
    if (nodes.length > 1) nodes.sort(compareNodes)
    return nodes
  }

  /**
   * 切换排序方式：不在这里遍历（深层节点可能还没加载）。
   * 浅替换顶层数组 → el-tree setData → 按 expandedKeys 重新展开 →
   * 每个目录重新 listDir 时由 fetchDirNodes 按新偏好排好。
   */
  const applySort = () => {
    if (!treeData.value || !treeData.value.length) return
    setTreeData([...treeData.value])
  }

  /** 设置排序方式；再次点击同一项切换升/降序 */
  const setSort = (by: FileSortKey) => {
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
    // 右键菜单打开期间不显示文件信息提示，避免提示盖住菜单
    if (contextMenu.value.visible) return
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
  //
  // 懒加载后这里只做两件事：① 用工作区列表重建**根层**（零整树扫描，通常 1~3 次 stat）；
  // ② 触发 el-tree 重新按 expandedKeys 逐级展开 → 每个已展开目录重新 listDir（一层）。
  // 因此刷新成本只与「用户展开过多少目录」有关，与工作区里有多少文件无关。
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
      const roots = effectiveRoots.value
      if (!roots.length) {
        setTreeData([])
        return
      }

      // 轻量存在性校验：每个根一次 stat（getInfo），不再整树扫描。
      // 目的是让被删除 / 拔盘的工作区从列表里消失（旧行为），stat 失败时保留（可能只是暂时不可用）。
      const alive = await Promise.all(roots.map(async (r: string) => {
        try {
          return (await getPlatform().fs.getInfo(r)) !== null
        } catch {
          return true
        }
      }))
      const kept = roots.filter((_r: string, i: number) => alive[i])
      if (!scoped.value && kept.join('\n') !== store.roots.join('\n')) {
        store.roots = kept
        if (!kept.includes(store.root)) {
          store.root = kept[0] || ''
          store.path = store.root
        }
        store.saveConfig()
        store.saveWorkspace()
      }

      // 根节点直接由工作区列表构造，不需要磁盘扫描
      setTreeData(markRawTree(kept.map((r: string) => markRaw({
        label: folderLabelOf(r) || r,
        path: r,
        type: 'folder',
        extension: 'folder',
        isRoot: true,
      }))))
      pruneExpandedKeys()
      // 等 el-tree 完成 setData（会按 expandedKeys 递归展开并 listDir）后再收起 loading
      await nextTick()
      // 右侧栏：确保当前工作区根是展开的（default-expanded-keys 只在初始化时生效）
      if (scoped.value && scopeRoot.value) {
        const rootNode = (treeRef.value as any)?.getNode?.(scopeRoot.value)
        if (rootNode && !rootNode.expanded) rootNode.expand?.()
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

  /**
   * 文件树被本面板改动（重命名 / 新建 / 删除 / 粘贴 / 移动 / 下载 / 工作区增删）后调用：
   * 刷新文件树，并递增 knowRefreshTick 让右侧各视图（日历 / 看板 / 表格 / 地图 / 图谱 / 文件）
   * 立即重新拉数据——否则它们要等手动点「刷新」才更新（如重命名后日历仍是旧名字）。
   */
  const refreshTreeAndViews = async () => {
    await refreshTree()
    // 右侧栏范围模式只维护自己这棵树，不驱动主界面的日历 / 看板等视图
    if (!scoped.value) store.knowRefreshViews()
  }

  // 通过对话框，打开其他文件
  const selectFile = async function() {
    const path = await getPlatform().dialog.pickFile()
    openFile(path)
  }

  // 应用内无法预览/编辑的文件（可执行/压缩包等）：双击直接用系统默认应用打开
  const SYSTEM_OPEN_EXTS = ['.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst']

  // 通过路径打开文件（统一交给 store.openFileByMode：一律在新窗口打开；知识库 .kb 走知识处理）
  const openFile = async function(path: any) {
    if(path != null){
      if (props.guardLeave && !(await props.guardLeave())) return
      // 系统打开类文件：直接用系统默认应用打开，不进入应用内预览/编辑
      const ext = String(path).substring(String(path).lastIndexOf('.')).toLowerCase()
      if (SYSTEM_OPEN_EXTS.includes(ext)) {
        getPlatform().shell.openWithSystemApp(path)
        return
      }
      const inf = await getPlatform().fs.getInfo(path); //获取信息
      const attributes = await getPlatform().fs.readMetadata(path); //获取属性
      const fileContent = shouldSkipTextPreview(path) ? '' : await getPlatform().fs.readText(path)
      store.openFileByMode({
        ...inf,
        attributes: attributes,
        path: path,
        content: fileContent,
      })
    }
  }

  // 创建文件（类型见 lib/knowFile/newFileTypes.ts：Markdown / Excalidraw / draw.io / 工作流 / 数据画布 / 脚手架 / Office 三件套）
  const createFile = async (fileName: string, fileType: NewFileTypeKey = 'md') => {
    if (!effectiveRoot.value) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    const def = newFileType(fileType) || NEW_FILE_TYPES[0]
    // 右键某个文件夹时建在它里面；否则建在**当前文件夹**（与「文件」视图一致，不再一律落到工作区根目录）
    const targetDir = contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.path : currentDir.value
    const suffix = def.ext
    const path = await getPlatform().fs.createFile(targetDir, fileName + suffix);
    if (path) {
      // 需要初始内容的类型先写入（draw.io 空白图表框架 / 脚手架空任务骨架 / Office 空白文档），避免留下 0 字节文件
      await writeNewFileSkeleton(path, def)
      openFile(path)
      ElMessage.success(`文件 "${fileName}${suffix}" 创建成功`);
    }
    await refreshTreeAndViews()
  };

  const createFolder = async (folderName: string) => {
    if (!effectiveRoot.value) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    // 与创建文件同一套：右键文件夹时建在它里面，否则建在当前文件夹
    const targetDir = contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.path : currentDir.value
    const dir = await getPlatform().fs.createFolder(targetDir, folderName);
    if (dir) {
      ElMessage.success(`文件夹 "${folderName}" 创建成功`);
    }
    await refreshTreeAndViews()
  };

  // 通过弹窗创建文件（**只从「新建」子菜单进来**，类型必带；工具栏 ＋ 已去掉）。
  // 与「文件」视图的 createNewFile（view_file.vue）**完全同一套**：类型在菜单里选好，
  // 弹窗只问文件名（ElMessageBox.prompt）——两处外观/文案/校验保持一致。
  const promptCreateFile = async (fileType: NewFileTypeKey) => {
    if (!effectiveRoot.value) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    const zh = store.locales === 'zh'
    const def = newFileType(fileType) || NEW_FILE_TYPES[0]
    try {
      const { value } = await ElMessageBox.prompt(zh ? '请输入文件名:' : 'Enter file name:', zh ? `新建 ${def.labelZh}` : `New ${def.labelEn}`, {
        confirmButtonText: zh ? '确定' : 'OK',
        cancelButtonText: zh ? '取消' : 'Cancel',
        inputPattern: /.+/,
        inputErrorMessage: zh ? '名称不能为空' : 'Name cannot be empty'
      })
      const name = String(value ?? '').trim()
      if (!name) return
      await createFile(name, def.key)
    } catch { /* 用户取消 */ }
  };

  // 通过弹窗创建文件夹（与「文件」视图 createNewFolder 同一套文案/校验）
  const promptCreateFolder = async () => {
    if (!effectiveRoot.value) {
      ElMessage.warning('请先打开一个文件夹');
      return;
    }
    const zh = store.locales === 'zh'
    try {
      const { value: folderName } = await ElMessageBox.prompt(zh ? '请输入文件夹名称:' : 'Enter folder name:', zh ? '新建文件夹' : 'New Folder', {
        confirmButtonText: zh ? '确定' : 'OK',
        cancelButtonText: zh ? '取消' : 'Cancel',
        inputPattern: /.+/,
        inputErrorMessage: zh ? '名称不能为空' : 'Name cannot be empty'
      })
      const trimmed = String(folderName ?? '').trim()
      if (!trimmed) return
      await createFolder(trimmed)
    } catch { /* 用户取消 */ }
  };

  // ---- 复制 / 粘贴（剪贴板与「文件」视图共用：store.fileClipboard）----

  /** 取路径所在目录（兼容 \ 与 /） */
  const dirOfPath = (p: string): string => {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    return i >= 0 ? p.substring(0, i) : ''
  }

  // 剪贴板里是否有可粘贴的项（与「文件」视图共用，复制后即可粘贴）
  const hasClipboard = computed(() => !!store.fileClipboard?.paths?.length)

  /**
   * 复制文件或文件夹（node 为树节点数据，取其 path 写入共用剪贴板）
   */
  const copyNode = (node: any) => {
    const p = node?.path || node?.data?.path
    if (!p) return
    store.fileClipboard = { paths: [p], cut: false }
    ElMessage.success(store.locales === 'zh' ? '已复制' : 'Copied')
  }

  /** 粘贴目标目录：右键文件夹 → 它本身；右键文件 → 它所在目录；空白处 → 当前目录 */
  const pasteTargetDir = (): string => {
    const node = contextMenu.value.node
    if (!node) return currentDir.value
    if (node.type === 'folder') return node.path
    return dirOfPath(node.path) || currentDir.value
  }

  /** 将剪贴板中的文件/文件夹粘贴到目标目录（与「文件」视图共用剪贴板，剪切项走移动） */
  const pasteNode = async () => {
    const clip = store.fileClipboard
    if (!clip?.paths?.length) return
    const targetDir = pasteTargetDir()
    if (!targetDir) return

    const sep = targetDir.includes('\\') ? '\\' : '/'
    const failed: string[] = []
    let n = 0
    for (const p of clip.paths) {
      // 剪切到同目录无意义；复制到同目录由主进程自动加「_副本」
      if (clip.cut && dirOfPath(p) === targetDir) continue
      // 防止把文件夹粘贴到其自身或子目录内（会无限递归或改名失败）
      if (targetDir === p || targetDir.startsWith(p + sep)) {
        failed.push(p)
        continue
      }
      const res = clip.cut
        ? await getPlatform().fs.moveFile(p, targetDir)
        : await getPlatform().fs.copyFile(p, targetDir)
      if (res && res.success) n++
      else failed.push(p)
    }
    // 剪切：仅保留失败项以便重试；复制：保留剪贴板以支持向多处重复粘贴
    if (clip.cut) store.fileClipboard = failed.length ? { paths: failed, cut: true } : null
    await refreshTreeAndViews()
    if (failed.length) {
      ElMessage.warning(
        store.locales === 'zh'
          ? `已${clip.cut ? '移动' : '复制'} ${n} 项，${failed.length} 项失败`
          : `${clip.cut ? 'Moved' : 'Copied'} ${n}, ${failed.length} failed`
      )
    } else if (n) {
      ElMessage.success(
        clip.cut
          ? (store.locales === 'zh' ? `已移动 ${n} 项` : `Moved ${n}`)
          : (store.locales === 'zh' ? `已复制 ${n} 项` : `Copied ${n}`)
      )
    }
  }

  // ---- 拖拽移动文件 ----
  /** 仅文件可拖拽，文件夹不可拖拽 */
  const allowDrag = (node: any) => {
    // 远程节点只读，禁止拖拽；「其余 N 项未显示」提示行不是真实条目
    if (node.data?.remote || node.data?.isTruncatedHint) return false
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

  /**
   * 拖拽开始时把节点路径写进 dataTransfer：
   * Markdown 编辑器据此插入 `![](图.drawio)` / `[](文件)`（el-tree 自带拖拽没有 File 对象）。
   */
  const onTreeNodeDragStart = (node: any, ev: DragEvent) => {
    const p = node?.data?.path
    if (!p) return
    try {
      ev.dataTransfer?.setData('application/x-aikm-path', String(p))
      ev.dataTransfer?.setData('text/plain', String(p))
    } catch {
      /* 某些环境不允许写自定义类型，忽略 */
    }
  }

  /** 处理拖放完成 */
  const handleDrop = async (draggingNode: any, dropNode: any, dropType: string, ev: Event) => {
    const sourcePath = draggingNode.data.path
    const targetDir = dropNode.data.path
    if (!sourcePath || !targetDir) return

    try {
      const result = await getPlatform().fs.moveFile(sourcePath, targetDir)
      if (result.success) {
        ElMessage.success(store.locales === 'zh' ? '移动成功' : 'Moved successfully')
        await refreshTreeAndViews()
      } else {
        ElMessage.error(result.error || (store.locales === 'zh' ? '移动失败' : 'Move failed'))
      }
    } catch (error) {
      console.error('移动文件失败:', error)
      ElMessage.error(store.locales === 'zh' ? '移动文件失败' : 'Failed to move file')
    }
  };

  // 在系统文件管理器中定位右键的节点（文件夹→打开其所在位置）
  const revealInFolder = (node: any) => {
    if (!node?.path) return
    getPlatform().shell.revealInFolder(node.path)
  }

  // 复制右键节点的完整路径到剪贴板
  const copyNodePath = (node: any) => {
    if (!node?.path) return
    store.copyToClipboard(node.path)
    ElMessage.success(store.locales === 'zh' ? '已复制地址' : 'Path copied')
  }

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
  const handleRightClick = (event: Event, data: any) => {
    event.preventDefault(); // 阻止默认的右键菜单
    // 「其余 N 项未显示」提示行不是真实条目：没有可执行的右键操作
    if (data?.isTruncatedHint) return
    hideTooltip(); // 隐藏文件信息提示，避免其盖住右键菜单

    const pos = event as MouseEvent;
    contextMenu.value.visible = true;
    contextMenu.value.style = {
      left: pos.clientX + 'px',
      top: pos.clientY + 'px',
      transform: ''
    };
    contextMenu.value.node = data;
    contextMenu.value.isRoot = scoped.value ? data.path === scopeRoot.value : store.roots.includes(data.path);
    contextMenu.value.isRemote = data?.remote === true;
    adjustContextMenuPosition();
  };

  // Word 等只读文件：不允许开可编辑/演示视图（菜单里隐藏这几项）
  const READONLY_VIEW_KEYS = ['edit', 'blockedit', 'presentation']

  // 右键「新窗口打开」的视图列表：Word 文档只提供 浏览 / 思维导图（与 FileWindow 的视图列表一致）
  const isWordNode = computed(() => {
    const p = String(contextMenu.value?.node?.path || '').toLowerCase();
    return p.endsWith('.docx') || p.endsWith('.doc');
  });

  // 右键菜单里 Word 不提供的视图：编辑类一律没有；旧版 .doc 还没有标题层级，导图会是空图
  const wordHiddenViewKeys = computed(() => {
    const p = String(contextMenu.value?.node?.path || '').toLowerCase();
    return p.endsWith('.doc') ? [...READONLY_VIEW_KEYS, 'mindmap'] : READONLY_VIEW_KEYS;
  });

  // 「打开」子菜单的视图清单：非 Word / Excel / PPT 文件不列「Office 编辑」（与文件窗口的切换器一致）
  const contextMenuViews = computed(() =>
    FILE_VIEWS_DEFS.filter(
      (v) => v.key !== 'office' || (!contextMenu.value.isRemote && supportsOfficeView(contextMenu.value.node?.path)),
    ),
  );

  // 右键「打开文件所在位置」文案：文件夹说「所在位置」，文件说「文件所在位置」
  const revealLabel = computed(() => {
    if (store.locales !== 'zh') return 'Reveal in Folder'
    return contextMenu.value.node?.type === 'folder' ? '打开所在位置' : '打开文件所在位置'
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
    hideTooltip(); // 隐藏文件信息提示，避免其盖住右键菜单
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
      const keys = Array.isArray(map[root]) ? map[root] : []
      // 右侧栏只有当前工作区一个根：默认展开它，打开就是文件列表，而不是一个折叠的根目录
      expandedKeys.value = scoped.value && root && !keys.includes(root) ? [root, ...keys] : keys
    } catch {
      expandedKeys.value = []
    }
  }

  /** 保存当前仓库的展开状态 */
  const saveExpandedKeys = () => {
    const root = effectiveRoot.value
    if (!root) return
    try {
      const map = JSON.parse(localStorage.getItem(EXPAND_STORAGE_KEY) || '{}')
      map[root] = [...expandedKeys.value]
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

  /**
   * 清理展开状态中已不属于任何工作区的路径，并同步持久化。
   *
   * 懒加载后树里只有已展开的节点，不能再靠遍历整棵树来校验：
   * 被删除的目录在重新展开时 listDir 会失败并返回空，残留的 key 只会多一次空请求，
   * 因此这里只按「是否还在某个工作区内」做一次 O(展开数) 的剪枝。
   */
  const pruneExpandedKeys = () => {
    if (!expandedKeys.value.length) return
    const roots = effectiveRoots.value
    if (!roots.length) return
    const before = expandedKeys.value.length
    expandedKeys.value = expandedKeys.value.filter((p) => roots.some((r: string) => isPathInside(p, r)))
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
    () => effectiveRoot.value,
    (newRoot, oldRoot) => {
      if (newRoot === oldRoot) return
      // 右侧栏范围模式可能只是切换聊天工作区：不能删掉旧根在 localStorage 里的展开状态
      // （同一个根可能正被主资源管理器使用），只切换到新根的记录即可。
      if (!scoped.value && oldRoot) clearExpandedKeys(oldRoot)
      loadExpandedKeys(newRoot)
      if (scoped.value) void refreshTree()
    }
  )

  // 工作区列表变化时自动刷新文件树（如从设置页添加/移除工作区后及时更新）
  watch(
    () => store.roots.join('\n'),
    (newRoots, oldRoots) => {
      if (scoped.value) return
      if (newRoots === oldRoots) return
      if (store.root || store.roots.length) {
        refreshTree()
      } else {
        setTreeData([])
      }
    }
  )

  //删除文件或文件夹
  const deleteFile = async () => {
    if (!contextMenu.value.node) return
    const node = contextMenu.value.node
    const path = node.path
    // 范围模式：不允许把整个范围根目录删掉（根节点的右键菜单也不提供删除）
    if (scoped.value && path === scopeRoot.value) return
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
        await getPlatform().fs.deleteFolder(path)
      } else {
        await getPlatform().fs.deleteFile(path)
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
      await refreshTreeAndViews()
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
    await refreshTreeAndViews()
    // 重启文件监听（监听剩余工作区）
    await getPlatform().watch.acquire([...store.roots])
    ElMessage.success('已从工作区列表删除')
  };

  // 处理文件系统变化：走全局单例订阅。
  // 此前每个面板实例各自 window.ipcRenderer.on('fileSystemChanged')，而 preload 的 off
  // 跨 contextBridge 不可靠 → 每挂载一次就多一个永不移除的监听（>10 触发
  // MaxListenersExceededWarning），旧实例被闭包引用无法回收、事件时重复全量刷新。
  // 现在 ipcRenderer 上永远只有 1 个监听，且去抖共享（一次事件只刷新一次）。
  let disposeFileWatch: (() => void) | null = null;
  let watchAcquired = false;

  /** 重新拉取某个已加载的树节点（文件系统事件只做这一件事，不做整树重扫） */
  const reloadDirNode = (node: any) => {
    if (!node) return
    node.loaded = false
    node.loading = false
    node.childNodes = []
    node.loadData(() => {})
  }

  /**
   * 文件系统变化：
   * - 主进程会给出「发生变化的目录」（payload.dirs）；只刷新这些目录对应的已加载节点；
   * - 未展开的目录不用管（下次展开时本来就会重新 listDir）；
   * - 没有目录信息（老版本主进程）时才退回重建根层。
   */
  const handleFsChanged = (payload: any) => {
    const dirs: string[] = Array.isArray(payload?.dirs)
      ? payload.dirs.map((d: any) => String(d || '')).filter(Boolean)
      : (payload?.dir ? [String(payload.dir)] : [])
    if (!dirs.length) {
      void refreshTree()
      return
    }
    const treeStore = (treeRef.value as any)?.store
    if (!treeStore) return
    for (const dir of dirs) {
      const node = treeStore.getNode(dir)
      // 只刷新「已经加载过」的节点：没加载说明没展开，重新展开时会读最新内容
      if (node && node.loaded) reloadDirNode(node)
    }
  }

  // 监听文件系统变化
  onMounted(async () => {
    disposeFileWatch = onFileSystemChanged(handleFsChanged);

    if (effectiveRoot.value || effectiveRoots.value.length) {
      // 恢复上次保存的展开状态（须在树数据加载前调用，node.initialize 才会按 key 展开）
      loadExpandedKeys(effectiveRoot.value)
      await refreshTree();
      // 启动文件监听（租约：来回切模块时复用现有 watcher，不重建）
      await acquireFileWatch(effectiveRoots.value);
      watchAcquired = true;
    }
  });

  // 点击空白处关闭右键菜单（具名引用，卸载时移除，避免每次挂载累积一个永不移除的 document 监听）
  const hideContextMenuOnDocClick = () => {
    contextMenu.value.visible = false;
  };

  onBeforeUnmount(() => {
    // 取消订阅（唯一监听本身不解绑，避免 off 不可靠时重复注册）
    disposeFileWatch?.();
    disposeFileWatch = null;
    // 取消未完成/待执行的搜索：面板已卸载，结果没人用
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
    searchSeq++
    // 移除文档级点击监听
    document.removeEventListener('click', hideContextMenuOnDocClick);
    // 释放目录监听（最后一个消费者释放后宽限 3s 才真正 stopWatching）
    if (watchAcquired) {
      watchAcquired = false;
      releaseFileWatch();
    }
  });

  document.addEventListener('click', hideContextMenuOnDocClick);

  /**
   * 右键「打开」子菜单：在右侧**标签页**中按指定视图打开文件（默认双击也是标签页）。
   * 想另开窗口 / 应用内浮层时走下面的「在新窗口打开」。
   */
  const openInNewWindow = async (path: string, view: string) => {
    const node = contextMenu.value.node || { path, type: 'file' }
    emit('open-file', { data: { ...node, path }, view })
  }

  /** 右键「操作 → 在新窗口打开」：显式走窗口 / 浮层（宿主先处理当前文件标签的未保存内容） */
  const openInStandaloneWindow = async (path: string) => {
    emit('open-standalone', { path, view: store.defaultViewForPath(path) })
  }

  const hideContextMenu = () => {
    contextMenu.value.visible = false;
  };

  // 「新建」子菜单可用条件：已打开本地工作区，且未右键远程节点（只读）；
  // 文件节点不提供（与「文件」视图一致，避免新建到非同级目录）
  const canCreateInMenu = computed(
    () => !!effectiveRoot.value && !contextMenu.value.isRemote && (!contextMenu.value.node || contextMenu.value.node.type === 'folder')
  );

  // 判断该节点是否为工作区根目录
  const isWorkspaceRoot = (path: string) => {
    return scoped.value ? path === scopeRoot.value : store.roots.includes(path)
  }

  // 判断该节点是否已在标签页中打开
  const isTabOpen = (path: string) => {
    return store.data.some((d: any) => d.path === path)
  }

  // 判断该节点是否为当前激活的文件标签（视图标签激活时没有激活文件）
  const isActiveTab = (path: string) => {
    return store.knowActiveFileTabPath === path
  }


  // ---- 文件树搜索：按「文件名」全树搜索（带预算，绝不整树加载） ----
  // 懒加载后 el-tree 里只有已展开的节点，旧做法（treeRef.filter）只能过滤到这些节点，
  // 用户搜深层文件会「明明有却搜不到」。现在改为向主进程请求一层有预算的全树文件名搜索：
  // 结果数 / 深度 / 时间三重上限 + 请求序号取消，输入再快也不会叠加成多个全盘扫描。
  const searchResults = ref<any[]>([])
  const searchLoading = ref(false)
  const searchTruncated = ref(false)
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchSeq = 0

  const parentDirOf = (p: string): string => {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    return i > 0 ? p.slice(0, i) : ''
  }

  const runNameSearch = async (kw: string) => {
    const seq = ++searchSeq
    searchLoading.value = true
    try {
      const roots = effectiveRoots.value
      const res = await getPlatform().fs.searchNames(roots, kw, { maxResults: 200, requestId: seq })
      if (seq !== searchSeq) return // 已有更新的输入：丢弃旧结果
      searchResults.value = (res.results || []).map((r: any) => ({ ...r, dirLabel: parentDirOf(r.path) }))
      searchTruncated.value = res.truncated
    } catch {
      if (seq === searchSeq) {
        searchResults.value = []
        searchTruncated.value = false
      }
    } finally {
      if (seq === searchSeq) searchLoading.value = false
    }
  }

  watch(filterText, (val) => {
    const kw = String(val || '').trim()
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
    if (!kw) {
      searchSeq++ // 让在途请求作废
      searchResults.value = []
      searchTruncated.value = false
      searchLoading.value = false
      return
    }
    searchLoading.value = true
    searchTimer = setTimeout(() => { void runNameSearch(kw) }, 250)
  })

  /** 点击搜索结果：切到所属工作区并按文件打开（与树里双击同一套出口） */
  const openFromSearch = (item: any) => {
    if (!item?.path) return
    if (!scoped.value) {
      const owner = store.roots
        .filter((r: string) => isPathInside(item.path, r))
        .sort((a: string, b: string) => b.length - a.length)[0]
      if (owner && owner !== store.root) store.setActiveRoot(owner)
    }
    emit('node-opened', item)
    emit('open-file', { data: item })
  }

  // 暴露方法给父组件（新建文件只走文件树右键「新建」，不再往外暴露创建入口）
  defineExpose({
    refreshTree
  });
</script>

<template>
  <div class="bg" @mouseleave="hideContextMenu">
    <div class="list scoll" v-if="mode=='file'" @contextmenu.prevent="showViewMenu">
      <!-- 未打开工作区时隐藏工具栏（无可用控件），由下方空态引导提供「打开工作区/打开文件」入口 -->
      <div class="tree-toolbar" :title="effectiveRoot" v-if="effectiveRoot!='' || (!scoped && store.remoteRoots.length)">
        <!-- 左侧插槽（细长窗口的抽屉返回按钮；桌面并排布局不用） -->
        <slot name="toolbar-left" />
        <!-- 文件搜索（放在原「视图选择」的位置；视图选择现已常驻顶部工具栏，见 ViewToolbar.vue） -->
        <div v-if="effectiveRoot!=''" class="tree-search-box">
          <i class="fa fa-search"></i>
          <input v-model="filterText" class="tree-search-input" :placeholder="store.locales=='zh'?'搜索文件':'search file'"/>
          <div v-if="filterText" class="tree-search-clear" @click="filterText=''" :title="store.locales=='zh'?'清除':'Clear'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
        <!-- 面板顶部按钮组（来自 explorer 的 toolbar slot；与搜索框同一行） -->
        <slot name="toolbar" />
      </div>
      <div class="tree-scroll scoll">
        <!-- 未打开任何工作区：清晰引导新手如何开始使用 -->
        <div v-if="effectiveRoot=='' && !store.remoteRoots.length" class="tree-empty-guide">
          <div class="guide-inner">
            <i class="fa fa-folder-open-o guide-icon"></i>
            <div class="guide-title">{{ store.locales=='zh' ? '打开工作区开始使用' : 'Open a Workspace to Start' }}</div>
            <div class="guide-desc">{{ store.locales=='zh' ? '选择一个文件夹作为工作区，即可浏览和管理其中的文件与知识库；也可以单独打开一个文件查看。' : 'Pick a folder as your workspace to browse and manage files and knowledge bases, or open a single file directly.' }}</div>
            <div class="guide-actions">
              <button v-if="!scoped" class="guide-btn guide-btn-primary" @click="openFolderDialog">
                <i class="fa fa-folder-open-o"></i><span>{{ store.locales=='zh' ? '打开本地工作区' : 'Local Workspace' }}</span>
              </button>
              <button v-if="!scoped" class="guide-btn guide-btn-remote" @click="promptAddRemote">
                <i class="fa fa-cloud"></i><span>{{ store.locales=='zh' ? '连接远程工作区' : 'Remote Workspace' }}</span>
              </button>
              <button class="guide-btn" @click="selectFile">
                <i class="fa fa-file-text-o"></i><span>{{ store.locales=='zh' ? '打开文件' : 'Open File' }}</span>
              </button>
            </div>
          </div>
        </div>
        <!-- 搜索结果：输入即按文件名全树搜索（有预算，不会拖死主进程）。
             用 v-show 而不是 v-if 隐藏文件树 —— 否则每次搜索都会重建 el-tree、丢掉展开状态与已加载节点。 -->
        <template v-else>
        <div v-if="filterText" class="tree-search-results">
          <div v-if="searchLoading" class="tree-search-state">
            <i class="fa fa-spinner fa-spin"></i>
            <span>{{ store.locales=='zh' ? '正在搜索文件名…' : 'Searching file names…' }}</span>
          </div>
          <template v-else>
            <div v-if="!searchResults.length" class="tree-search-state">
              <i class="fa fa-search"></i>
              <span>{{ store.locales=='zh' ? '没有匹配的文件名' : 'No matching file name' }}</span>
            </div>
            <div
              v-for="item in searchResults"
              :key="item.path"
              class="tree-search-item"
              :title="item.path"
              @click="openFromSearch(item)"
            >
              <i :class="store.icon(item.extension)"></i>
              <span class="tree-search-item-label">{{ item.label }}</span>
              <span class="tree-search-item-dir">{{ item.dirLabel }}</span>
            </div>
            <div v-if="searchTruncated" class="tree-search-state tree-search-truncated">
              {{ store.locales=='zh'
                ? `结果过多，仅显示前 ${searchResults.length} 条（请再输入几个字缩小范围）`
                : `Too many results, showing first ${searchResults.length} (type more to narrow)` }}
            </div>
          </template>
        </div>
        <!-- 单击不展开（expand-on-click-node=false）：展开 / 折叠点节点左侧箭头，双击留给「右侧各视图定位到该目录」，
             否则双击的两次单击会各开合一次，出现先开后收的伸缩闪动 -->
        <el-tree
          v-show="!filterText"
          ref="treeRef"
          node-key="path"
          :data="mergedTree"
          :default-expanded-keys="expandedKeys"
          lazy
          :load="loadTreeNode"
          :props="{ isLeaf: (data: any) => data.type === 'file' }"
          :expand-on-click-node="scoped"
          draggable
          :allow-drag="allowDrag"
          :allow-drop="allowDrop"
          @node-drop="handleDrop"
          @node-drag-start="onTreeNodeDragStart"
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
        </template>
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
      <!-- 工作区根目录右键：系统打开 / 新建 / 删除该工作区 -->
      <template v-else-if="contextMenu.isRoot">
        <div class="menu-item" @click="store.openByApp(contextMenu.node.path); hideContextMenu()">
          <i class="fa fa-external-link"></i> {{ store.locales=='zh'?'系统打开':'Open in System' }}
        </div>
        <div class="menu-divider"></div>
        <!-- 新建（二级菜单，与「文件」视图一致）：建在该工作区根目录 -->
        <div class="menu-item has-submenu" v-if="canCreateInMenu">
          <i class="fa fa-plus-circle"></i>
          <span style="flex:1">{{ store.locales=='zh'?'新建':'New' }}</span>
          <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
          <ul class="submenu">
            <li @click="promptCreateFolder(); hideContextMenu()">
              <i class="fa fa-folder"></i> {{ store.locales=='zh'?'文件夹':'Folder' }}
            </li>
            <li v-for="t in NEW_FILE_TYPES" :key="t.key" @click="promptCreateFile(t.key); hideContextMenu()">
              <i :class="t.icon"></i> {{ store.locales=='zh' ? t.labelZh : t.labelEn }}
            </li>
          </ul>
        </div>
        <div class="menu-item" v-if="hasClipboard" @click="pasteNode(); hideContextMenu()">
          <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
        </div>
        <div class="menu-divider" v-if="!scoped"></div>
        <div class="menu-item" v-if="!scoped" @click="deleteWorkspaceRoot()">
          <i class="fa fa-trash"></i> {{ store.locales=='zh'?'删除该工作区':'Delete Workspace' }}
        </div>
      </template>
      <template v-else>
      <!-- 空白区域：添加工作区（右侧栏范围模式不提供，范围固定为当前聊天工作区） -->
      <div class="menu-item" v-if="!contextMenu.node && !scoped" @click="openFolderDialog(); hideContextMenu()">
        <i class="fa fa-folder-open"></i> {{ store.locales=='zh'?'添加本地工作区':'Add Local Workspace' }}
      </div>
      <div class="menu-item" v-if="!contextMenu.node && !scoped" @click="promptAddRemote(); hideContextMenu()">
        <i class="fa fa-cloud" style="color:#42b883"></i> {{ store.locales=='zh'?'连接远程工作区':'Connect Remote Workspace' }}
      </div>
      <div class="menu-divider" v-if="!contextMenu.node && !scoped"></div>
      <!-- 粘贴（一级，空白处右键 → 粘贴到当前目录；剪贴板与「文件」视图共用） -->
      <div class="menu-item" v-if="!contextMenu.node && hasClipboard" @click="pasteNode(); hideContextMenu()">
        <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
      </div>
      <!-- 新建（二级菜单，与「文件」视图一致）：右键文件夹建在它里面，空白处建在当前目录 -->
      <div class="menu-item has-submenu" v-if="canCreateInMenu">
        <i class="fa fa-plus-circle"></i>
        <span style="flex:1">{{ store.locales=='zh'?'新建':'New' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li @click="promptCreateFolder(); hideContextMenu()">
            <i class="fa fa-folder"></i> {{ store.locales=='zh'?'文件夹':'Folder' }}
          </li>
          <li v-for="t in NEW_FILE_TYPES" :key="t.key" @click="promptCreateFile(t.key); hideContextMenu()">
            <i :class="t.icon"></i> {{ store.locales=='zh' ? t.labelZh : t.labelEn }}
          </li>
        </ul>
      </div>
      <!-- 打开（一级）：文件 → 视图列表（即「新窗口打开」的各视图）；文件夹 → 所在位置 / 复制地址 / 系统打开 -->
      <div class="menu-item has-submenu" v-if="contextMenu.node && contextMenu.node.type === 'file'">
        <i class="fa fa-folder-open-o"></i>
        <span style="flex:1">{{ store.locales=='zh'?'打开':'Open' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li v-for="v in contextMenuViews" :key="v.key" v-show="!isWordNode || !wordHiddenViewKeys.includes(v.key)"
              @click="openInNewWindow(contextMenu.node.path, v.key); hideContextMenu()">
            <i :class="v.icon"></i> {{ store.locales=='zh' ? v.name : v.labelEn }}
          </li>
        </ul>
      </div>
      <div class="menu-item has-submenu" v-else-if="contextMenu.node">
        <i class="fa fa-folder-open-o"></i>
        <span style="flex:1">{{ store.locales=='zh'?'打开':'Open' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li @click="revealInFolder(contextMenu.node); hideContextMenu()">
            <i class="fa fa-folder-open-o"></i> {{ revealLabel }}
          </li>
          <li @click="copyNodePath(contextMenu.node); hideContextMenu()">
            <i class="fa fa-link"></i> {{ store.locales=='zh'?'复制地址':'Copy Path' }}
          </li>
          <li @click="store.openByApp(contextMenu.node.path); hideContextMenu()">
            <i class="fa fa-external-link"></i> {{ store.locales=='zh'?'系统打开':'System' }}
          </li>
          <li v-if="canShare" @click="shareNode(contextMenu.node)">
            <i class="fa fa-share-alt"></i> {{ store.locales=='zh'?'分享':'Share' }}
          </li>
        </ul>
      </div>
      <!-- 操作（二级，仅文件）：打开位置 / 复制地址 / 系统打开 -->
      <div class="menu-item has-submenu" v-if="contextMenu.node && contextMenu.node.type === 'file'">
        <i class="fa fa-wrench"></i>
        <span style="flex:1">{{ store.locales=='zh'?'操作':'Actions' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li v-if="!scoped" @click="openInStandaloneWindow(contextMenu.node.path); hideContextMenu()">
            <i class="fa fa-window-restore"></i> {{ store.locales!='zh'
              ? (store.singleWindowMode ? 'Open in window' : 'Open in new window')
              : (store.singleWindowMode ? '在窗口中打开' : '在新窗口打开') }}
          </li>
          <li @click="revealInFolder(contextMenu.node); hideContextMenu()">
            <i class="fa fa-folder-open-o"></i> {{ revealLabel }}
          </li>
          <li @click="copyNodePath(contextMenu.node); hideContextMenu()">
            <i class="fa fa-link"></i> {{ store.locales=='zh'?'复制地址':'Copy Path' }}
          </li>
          <li @click="store.openByApp(contextMenu.node.path); hideContextMenu()">
            <i class="fa fa-external-link"></i> {{ store.locales=='zh'?'系统打开':'System' }}
          </li>
          <li v-if="canShare" @click="shareNode(contextMenu.node)">
            <i class="fa fa-share-alt"></i> {{ store.locales=='zh'?'分享':'Share' }}
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
          <li v-for="s in FILE_SORT_ITEMS" :key="s.key" @click="setSort(s.key); hideContextMenu()">
            <i :class="sortBy==s.key ? 'fa fa-check-square-o' : 'fa fa-square-o'" style="color:var(--primaryColor)"></i>
            <span style="flex:1">{{ store.locales=='zh' ? s.labelZh : s.labelEn }}</span>
            <i v-if="sortBy==s.key" :class="sortOrder=='asc' ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc'" style="font-size:10px;width:auto"></i>
          </li>
        </ul>
      </div>
      <!-- 重命名（一级，仅文件） -->
      <div class="menu-item" v-if="contextMenu.node" @click="startRename(contextMenu.node)">
        <i class="fa fa-edit"></i> {{ store.locales=='zh'?'重命名':'Rename' }}
      </div>
      <!-- 复制 / 粘贴（一级，文件 / 文件夹均可复制；剪贴板与「文件」视图共用） -->
      <div class="menu-item" v-if="contextMenu.node" @click="copyNode(contextMenu.node); hideContextMenu()">
        <i class="fa fa-copy"></i> {{ store.locales=='zh'?'复制':'Copy' }}
      </div>
      <div class="menu-item" v-if="contextMenu.node && hasClipboard" @click="pasteNode(); hideContextMenu()">
        <i class="fa fa-paste"></i> {{ store.locales=='zh'?'粘贴':'Paste' }}
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

    <!-- 创建文件：不再自带弹窗——右键「新建 → 类型」之后走 view_file.vue 那套
         ElMessageBox.prompt（见 promptCreateFile），与「文件」视图外观/文案/校验完全一致 -->

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
    flex-wrap: nowrap; /* 始终一行：空间不足时由搜索框收缩，不换行 */
    align-items: center;
    gap: 4px;
    padding: 5px;
    flex-shrink: 0;
    white-space: nowrap;
    user-select: none;
    container-type: inline-size; /* 启用宽度容器查询：按面板宽度切换 宽/窄 布局 */
  }
  .tree-search-box {
    flex: 1 1 80px; /* 占满一行里搜索框之后剩下的空间；窄面板时收缩（最小 56px），不换行 */
    min-width: 56px;
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

  /* 全树文件名搜索结果（替换树视图，树本身用 v-show 保留挂载） */
  .tree-search-results {
    padding: 2px 0;
    font-size: 12px;
  }
  .tree-search-state {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 14px 10px;
    color: var(--borderColor);
    user-select: none;
  }
  .tree-search-truncated {
    padding-top: 6px;
    padding-bottom: 10px;
    line-height: 1.5;
  }
  .tree-search-item {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    cursor: pointer;
    color: var(--fontColor);
    white-space: nowrap;
    overflow: hidden;
  }
  .tree-search-item:hover {
    background-color: var(--menuActiveColor);
  }
  .tree-search-item > i {
    flex-shrink: 0;
    font-size: 13px;
  }
  .tree-search-item-label {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tree-search-item-dir {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl; /* 路径过长时优先保留末级目录（更接近用户要找的位置） */
    text-align: right;
    font-size: 11px;
    color: var(--borderColor);
    opacity: .8;
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
    width: 300px; max-width: calc(100vw / var(--ui-zoom, 1) - 16px);
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
  .pf-actions { display: flex; gap: 4px; justify-content: flex-end; }
  .pf-btn {
    /* 全局别的组件里有 button{width:100%} 这类规则，这里写死宽度免得按钮被撑满整行 */
    width: auto; flex: none;
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
  
  /* 右键菜单样式统一在 style.css（.context-menu + 知识管理紧凑变体）中定义 */

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
    max-width: calc(60vw / var(--ui-zoom, 1));
  }

  /* 文件名：过长时换行显示，避免超出视口 */
  .tooltip-name {
    white-space: normal;
    word-break: break-all;
    font-weight: bold;
    color: var(--fontColor);
  }
  
</style>