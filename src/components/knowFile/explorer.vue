<template>
  <div class="bg">
    <!-- 顶部标签栏（新窗口模式下无标签，整个隐藏；主页按钮组已移至左侧面板） -->
    <div class="top-panel" v-if="store.UI.fileOpenMode !== 'window'">
      <!-- 主页按钮 -->
      <div class="home">
        <div class="button" style="flex:1" :class="{active:mode=='file'}" @click="toggleMode('file')">
          <i class="fa fa-navicon"></i>
        </div>
        <div class="button" @click="openFolderDialog" :title="store.locales=='zh'?'添加工作区':'Add Workspace'">
          <i class="fa fa-folder-open"></i>
        </div>
        <div class="button" @click="openFileDialog" :title="store.locales=='zh'?'打开文件':'Open File'">
          <i class="fa fa-file-text"></i>
        </div>
        <div class="button" style="flex:1" :class="{active:searchOpen}" @click="searchOpen=!searchOpen" v-if="store.root!=''">
          <i class="fa fa-search"></i> 
        </div>
        <!-- 眼睛按钮：仅存在于 top-panel 内，而 top-panel 已在窗口内模式才渲染，故无需再判断 fileOpenMode -->
        <div class="button" style="flex:1"
          :class="{active: viewsPopover}"
          @click.stop="viewsPopover = !viewsPopover"
          title="视图">
          <i class="fa fa-eye"></i>
        </div>
        <div class="button" style="flex:1" 
          :class="{disabled: store.data.length <= 1}"
          @click="clearAllTabs"
          :title="`关闭所有标签页 (共${store.data.length}个)`">
          <i class="fa fa-times-circle"></i>
        </div>
      </div>
      <div class="App_tabs" ref="tabsContainer" @wheel="handleWheel">
        <transition-group name="tab" tag="div" class="tabs-wrapper">
          <div class="App_tab" 
               v-for="(item,index) in store.data" 
               :key="item.path" 
               :class="{ 'active': store.index === index }" 
               @click="selectFile(Number(index))">
            <i :class="store.icon(item.extension)"></i>
            <span class="tab-label" :title="item.label">{{item.label}}</span>&nbsp;
            <span><i class="fa fa-times" @click="close($event, Number(index))"></i></span>
          </div>
        </transition-group>
      </div>
    </div>
    
    <!-- 主要内容区域保持不变 -->
    <div class="explorer-container">
      <!-- 左侧面板（可调整宽度，始终为文件树） -->
      <div class="left-wrap" v-if="mode" :style="{ width: leftWidth + 'px', minWidth: minLeftWidth + 'px' }">
        <panel v-if="mode=='file'" ref="panelRef" class="left-panel" :show-views="viewsPopover" @reset-view-sizes="resetViewSizes">
          <!-- 新窗口模式：工作区/打开文件/搜索/创建文件 按钮组，置于面板顶部（top-panel 已隐藏；无"收起面板"按钮，因为收起后无 top-panel 可恢复） -->
          <template v-if="store.UI.fileOpenMode === 'window'" #toolbar>
            <div class="panel-home">
              <div class="panel-home-btn" @click="openFolderDialog" :title="store.locales=='zh'?'添加工作区':'Add Workspace'">
                <i class="fa fa-folder-open"></i>
              </div>
              <div class="panel-home-btn" @click="openFileDialog" :title="store.locales=='zh'?'打开文件':'Open File'">
                <i class="fa fa-file-text"></i>
              </div>
              <div class="panel-home-btn" :class="{active:searchOpen}" @click="searchOpen=!searchOpen" v-if="store.root!=''" :title="store.locales=='zh'?'搜索':'Search'">
                <i class="fa fa-search"></i>
              </div>
              <div class="panel-home-btn" v-if="store.root!=''" @click="panelRef?.promptCreateFile()" :title="store.locales=='zh'?'创建文件':'Create File'">
                <i class="fa fa-plus"></i>
              </div>
            </div>
          </template>
        </panel>
      </div>
      <div class="resizer" v-if="mode" @mousedown.prevent="startDrag" :style="{ left: (leftWidth - 3) + 'px' }"></div>
      <!-- 右侧内容区域 -->
      <div class="right-content">
        <!-- 远程只读提示条（仅「窗口内打开」的远程标签显示；单击快速预览不显示） -->
        <div v-if="isRemoteFile && !isActiveRemotePreview" class="remote-readonly-bar">
          <i class="fa fa-cloud" style="color:#42b883"></i>
          <span>{{ store.locales=='zh'?'远程文件为只读预览':'Remote file (read-only preview)' }}</span>
          <span class="remote-readonly-spacer"></span>
          <span class="remote-download-btn" @click="downloadActiveRemote" :title="store.locales=='zh'?'下载到当前工作区':'Download to current workspace'">
            <i class="fa fa-download"></i> {{ store.locales=='zh'?'下载到本地':'Download' }}
          </span>
        </div>
        <div class="explorer" :style="{flexDirection:store.UI.layout=='horizontal'?'row':'column'}">
          <template v-for="(viewName, vi) in getVisibleViews()" :key="viewName">
            <!-- 视图内容 -->
            <div class="view-panel" :style="getViewStyle(viewName)">
              <view_file v-if="viewName==='文件'" />
              <view_graph v-if="viewName==='图谱'" />
              <view_kanban v-if="viewName==='看板'" />
              <view_gantt v-if="viewName==='甘特'" />
              <view_year v-if="viewName==='日历'" />
              <view_map v-if="viewName==='地图'" />
              <view_table v-if="viewName==='表格'" />
              <!-- draw.io 图表：浏览/源码编辑/可视编辑/导图/演示视图统一渲染 Drawio 组件（远程文件只读） -->
              <Drawio v-if="isDrawioFile && isDrawioContentView(viewName)" :path="activeFilePath" :content="activeFileContent" :readonly="isRemoteFile" />
              <!-- .excalidraw 文件：浏览/编辑/块编辑/导图/演示视图统一渲染 Excalidraw 白板 -->
              <Excalidraw v-if="isExcalidrawFile && isExcalidrawContentView(viewName)" :path="activeFilePath" :content="activeFileContent" />
              <!-- 音视频等多媒体文件：浏览/编辑/块编辑/导图/演示视图统一渲染 Media 播放器 -->
              <Media v-else-if="isMediaFile && isMediaContentView(viewName)" :path="activeFilePath" :content="activeFileContent" />
              <md_read v-if="!isExcalidrawFile && !isDrawioFile && !isMediaFile && viewName===VIEW_BROWSE&&hasActiveFile" :content="activeFileContent" :path="activeFilePath" :is-remote="isRemoteFile" :remote-base64="activeRemoteBase64" :remote-text="activeRemoteText" />
              <md_mind v-if="!isExcalidrawFile && !isDrawioFile && viewName===VIEW_MINDMAP&&store.index!=null" />
              <md_ppt v-if="!isExcalidrawFile && !isDrawioFile && viewName===VIEW_PRESENTATION&&store.index!=null" />
              <Edit_Code v-if="!isExcalidrawFile && !isDrawioFile && viewName===VIEW_SOURCE&&store.index!=null" />
              <Edit_Block v-if="!isExcalidrawFile && !isDrawioFile && viewName===VIEW_VISUAL&&store.index!=null" />
            </div>
            <!-- 视图之间的拖拽手柄 -->
            <div v-if="vi < getVisibleViews().length - 1"
                 class="view-resizer"
                 :class="store.UI.layout==='horizontal'?'resizer-h':'resizer-v'"
                 @mousedown.prevent="startViewResize($event, viewName, getVisibleViews()[vi+1])">
            </div>
          </template>
          <empty v-if="store.root=='' || getVisibleViews().length == 0" />
        </div>
      </div>
    </div>

    <!-- 模糊搜索窗口（类似设置界面，悬浮弹出） -->
    <div v-if="searchOpen" class="search-overlay" @click="searchOpen=false">
      <div class="search-panel" @click.stop>
        <div class="settings-header">
          <span class="settings-header-title">
            <i class="fa fa-search"></i>
            {{ store.locales === 'zh' ? '模糊搜索' : 'Search' }}
          </span>
          <div class="settings-close" @click="searchOpen=false" :title="store.locales === 'zh' ? '关闭搜索 (Esc)' : 'Close search (Esc)'">
            <i class="fa fa-times"></i>
          </div>
        </div>
        <div class="search-panel-body">
          <search />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
  import {usestore} from '@/store'
  import { FILE_VIEW_NAMES, NON_BROWSE_FILE_VIEWS, VIEW_BROWSE, VIEW_SOURCE, VIEW_VISUAL, VIEW_MINDMAP, VIEW_PRESENTATION } from '@/lib/knowFile/fileViews'
  import { isDrawioFile as detectDrawioFile } from '@/shared/drawioFile'
  import { ElMessageBox, ElMessage } from 'element-plus'
  import { downloadRemoteFile } from '@/platform/remoteFs'
  
  import view_file from '@/components/knowFile/view/view_file.vue'
  import view_kanban from '@/components/knowFile/view/view_kanban.vue'
  import view_graph from '@/components/knowFile/view/view_graph.vue'
  import view_gantt from '@/components/knowFile/view/view_gantt.vue'
  import view_year from '@/components/knowFile/view/view_year.vue'
  import view_map from '@/components/knowFile/view/view_map.vue'
  import view_table from '@/components/knowFile/view/view_table.vue'
  import md_read from '@/components/knowFile/view/md_read.vue'
  import md_mind from '@/components/knowFile/view/md_mind.vue'
  import Edit_Code from '@/components/knowFile/view/Edit_Code.vue'
  import Edit_Block from '@/components/knowFile/view/Edit_Block.vue'
  import md_ppt from '@/components/knowFile/view/md_ppt.vue'
  import empty from '@/components/knowFile/view/empty.vue'

  // Excalidraw 白板（懒加载，.excalidraw 文件统一用它打开）
  const Excalidraw = defineAsyncComponent(() => import('@/components/knowFile/view/Excalidraw.vue'))
  // draw.io 图表（懒加载，.drawio/.dio 文件统一用它打开；drawio 运行时随应用打包在 /drawio）
  const Drawio = defineAsyncComponent(() => import('@/components/knowFile/view/Drawio.vue'))
  // 音视频多媒体播放器（懒加载，音视频文件统一用它打开）
  const Media = defineAsyncComponent(() => import('@/components/knowFile/view/Media.vue'))
  
  import panel from '@/components/knowFile/panel.vue'
  import search from '@/components/knowFile/search.vue'
  
  const store = usestore();
  const tabsContainer = ref<HTMLElement | null>(null);
  const mode = ref('file');
  // 文件树面板引用（用于刷新左侧文件树）
  const panelRef = ref<any>(null);

  // 模糊搜索窗口显隐（类似设置界面，悬浮弹出）
  const searchOpen = ref(false);

  // 按 Esc 关闭搜索窗口
  const onSearchKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') searchOpen.value = false
  }
  watch(searchOpen, (v) => {
    if (v) window.addEventListener('keydown', onSearchKeydown)
    else window.removeEventListener('keydown', onSearchKeydown)
  })

  // 左侧面板宽度（可拖动调整）
  const leftWidth = ref<number>(270);
  const minLeftWidth = 230;
  const maxLeftWidth = 900;
  let isDragging = false;

  // 各视图大小（flex basis, px），水平布局按宽度，垂直布局按高度
  const viewSizes = ref<Record<string, number>>({})
  const viewOrder = computed(() => store.viewList)
  const getVisibleViews = () => viewOrder.value.filter(v => {
    if (!store.view.includes(v)) return false
    // 远程文件只读预览：不允许用 源码编辑/可视编辑/思维导图/演示 渲染远程内容（仅「浏览」视图内联预览）。
    // 本地工作区的全局视图（文件/图谱/看板/甘特/日历/地图/表格）不受远程预览影响，仍按正常规则显示，
    // 避免预览远程文件时把已开启的本地视图全部隐藏 → 可见视图为 0 → 误触发 empty 空态。
    if (isRemoteFile.value && NON_BROWSE_FILE_VIEWS.includes(v)) return false
    if (v === '文件' || v === '看板' || v === '图谱' || v === '甘特' || v === '日历' || v === '地图' || v === '表格') return !!store.root
    if (NON_BROWSE_FILE_VIEWS.includes(v)) return store.index != null
    if (v === VIEW_BROWSE) return hasActiveFile.value
    return true
  })

  // 获取视图尺寸，返回 flex 样式
  const getViewStyle = (name: string) => {
    // 最后一个可见视图始终 flex:1 填充剩余空间
    const visible = getVisibleViews()
    if (visible.length > 0 && name === visible[visible.length - 1]) return { flex: '1 1 0' }
    const size = viewSizes.value[name]
    if (!size) return {} // 无保存尺寸时使用 CSS flex:1 等分
    const dim = store.UI.layout === 'horizontal' ? 'width' : 'height'
    return { [dim]: size + 'px', flex: '0 0 auto' }
  }

  // 开始拖拽调整视图大小
  let viewDragData: { name: string; nextName: string; startX: number; startSize: number; nextStartSize: number; dim: 'width' | 'height' } | null = null

  const startViewResize = (e: MouseEvent, name: string, nextName: string) => {
    e.preventDefault()
    e.stopPropagation()
    const dim = store.UI.layout === 'horizontal' ? 'width' : 'height'
    const sizes = viewSizes.value
    // 从 DOM 获取实际尺寸作为初始值
    const container = document.querySelector('.explorer') as HTMLElement
    const totalSize = container ? (dim === 'width' ? container.offsetWidth : container.offsetHeight) : 600
    // 估算各视图尺寸：未保存的按比例分配
    const visible = getVisibleViews()
    const unsizedCount = visible.filter(v => !sizes[v] && v !== name && v !== nextName).length + 2
    const defaultSize = Math.max(80, Math.floor(totalSize / unsizedCount))
    if (!sizes[name]) sizes[name] = defaultSize
    if (!sizes[nextName]) sizes[nextName] = defaultSize
    viewDragData = {
      name, nextName,
      startX: store.UI.layout === 'horizontal' ? e.clientX : e.clientY,
      startSize: sizes[name],
      nextStartSize: sizes[nextName],
      dim
    }
    document.body.style.cursor = store.UI.layout === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onViewDrag, true)
    window.addEventListener('mouseup', stopViewDrag, true)
  }

  const onViewDrag = (e: MouseEvent) => {
    if (!viewDragData) return
    const current = store.UI.layout === 'horizontal' ? e.clientX : e.clientY
    const delta = current - viewDragData.startX
    let newSize = viewDragData.startSize + delta
    let nextNewSize = viewDragData.nextStartSize - delta
    const minSize = 80
    // 若下一个视图是最后一个（flex:1 撑满剩余，不实际使用固定尺寸），
    // 则不应拿它的虚拟尺寸做最小限制，否则会把 name 错误锁定导致拖不动
    const visible = getVisibleViews()
    const nextIsLast = visible.length > 0 && viewDragData.nextName === visible[visible.length - 1]
    if (newSize < minSize) {
      newSize = minSize
      if (!nextIsLast) nextNewSize = viewDragData.startSize + viewDragData.nextStartSize - minSize
    }
    if (!nextIsLast && nextNewSize < minSize) {
      nextNewSize = minSize
      newSize = viewDragData.startSize + viewDragData.nextStartSize - minSize
    }
    viewSizes.value[viewDragData.name] = newSize
    viewSizes.value[viewDragData.nextName] = nextNewSize
  }

  const stopViewDrag = () => {
    viewDragData = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onViewDrag, true)
    window.removeEventListener('mouseup', stopViewDrag, true)
    try { localStorage.setItem('explorerViewSizes', JSON.stringify(viewSizes.value)) } catch (e) {}
    // 视图尺寸变化后触发 resize，让依赖容器尺寸的组件（图表/画布等）重新布局
    store.resize()
  }

  const startDrag = (e: MouseEvent) => {
    isDragging = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', stopDrag);
  };

  const onDrag = (e: MouseEvent) => {
    if (!isDragging) return;
    const newWidth = Math.max(minLeftWidth, Math.min(maxLeftWidth, e.clientX));
    leftWidth.value = newWidth;
  };

  const stopDrag = () => {
    isDragging = false;
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', stopDrag);
    try { localStorage.setItem('leftPanelWidth', String(leftWidth.value)); } catch (e) {}
    // 左侧面板宽度变化后触发 resize，让依赖容器尺寸的组件（图表/画布等）重新布局
    store.resize()
  };

  // 通道 B：其他窗口（或本窗口其它视图）保存文件后广播到达主窗口 → 同步本窗口 store 中匹配标签的内容，
  // 让主窗口中同时打开的 浏览/导图/演示/块编辑 等视图实时刷新显示。
  const onFileContentChanged = (_event: any, payload: { path?: string; content?: string }) => {
    const changedPath = payload?.path
    const newContent = payload?.content
    if (!changedPath || newContent == null) return
    // 正在以 编辑/块编辑 视图编辑“当前激活文件”时，跳过覆盖其内容（避免破坏编辑器里未保存的修改；
    // 该编辑器自身的保存已自行把内容写入 store）。其余情况（未激活标签 / 非编辑中的激活文件）正常同步。
    const activeTab = hasActiveFile.value ? store.data[store.index!] : null
    const protectingActiveEdit = !!activeTab && activeTab.path === changedPath &&
      (store.view.includes(VIEW_SOURCE) || store.view.includes(VIEW_VISUAL))
    for (let i = 0; i < store.data.length; i++) {
      const tab = store.data[i]
      if (!tab || tab.path !== changedPath) continue
      if (protectingActiveEdit && tab === activeTab) continue
      tab.content = newContent
    }
  }

  onMounted(() => {
    try {
      const saved = localStorage.getItem('leftPanelWidth');
      if (saved) {
        const v = parseInt(saved);
        if (!isNaN(v)) leftWidth.value = Math.max(minLeftWidth, Math.min(maxLeftWidth, v));
      }
    } catch (e) {}
    try {
      const saved = localStorage.getItem('explorerViewSizes');
      if (saved) viewSizes.value = JSON.parse(saved);
    } catch (e) {}
    // 监听其他窗口保存文件后的内容广播（通道 B）
    window.ipcRenderer.on('file-content-changed', onFileContentChanged)
  });

  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', stopDrag);
    window.removeEventListener('keydown', onSearchKeydown);
    window.ipcRenderer.off('file-content-changed', onFileContentChanged)
  });

  // 切换模式的方法
  const toggleMode = function(targetMode: string) {
    mode.value = mode.value !== targetMode ? targetMode : '';
    // 展开/关闭左侧面板会改变布局，触发 resize 让其他组件重新布局
    store.resize()
  };

  // 通过对话框选择文件夹并添加为工作区（支持多个工作区）
  const openFolderDialog = async function() {
    let path = await window.ipcRenderer.invoke('openFolderDialog')
    if(path != null){
      // 添加为新的工作区并设为当前工作区（重复路径仅切换当前工作区，返回 false）
      const isNew = store.addRoot(path)
      if (!isNew) {
        ElMessage.warning(store.locales === 'zh' ? '该文件夹已在工作区列表中' : 'This folder is already in your workspace list')
        return
      }
      // 启动文件监听（监听所有工作区）
      await window.ipcRenderer.invoke('startWatching', [...store.roots])
      // 刷新左侧文件树
      await panelRef.value?.refreshTree()
    }
    store.saveConfig()
  };

  // 通过对话框打开文件（打开文件）
  const openFileDialog = async function() {
    const path = await window.ipcRenderer.invoke('selectFile')
    if(path != null){
      // 本地 HTML 文件：默认用浏览器 Agent 打开（与知识管理双击一致）
      const extLow = String(path).toLowerCase()
      if (extLow.endsWith('.html') || extLow.endsWith('.htm')) {
        await window.ipcRenderer.invoke('browser-agent:open-file', { path })
        return
      }
      const inf = await window.ipcRenderer.invoke('getInf', path); //获取信息
      const attributes = await window.ipcRenderer.invoke('getConfig', path); //获取属性
      const fileContent = await window.ipcRenderer.invoke('readFile', path)
      // 按文件操作模式打开：新窗口模式 → 独立窗口；窗口内模式 → 标签页
      store.openFileByMode({
        ...inf,
        type: 'file',
        attributes: attributes,
        path: path,
        content: fileContent,
      })
    }
  };

  // 计算属性：判断是否有激活的文件
  const hasActiveFile = computed(() => {
    return store.index !== null && 
          store.data.length > 0 && 
          store.index < store.data.length;
  });

  // 计算属性：当前激活文件是否为远程只读文件
  const isRemoteFile = computed(() => {
    if (!hasActiveFile.value) return false
    const cur = store.data[store.index!]
    return cur?.isRemote === true
  });

  // 计算属性：当前激活远程标签是否来自「单击快速预览」（未正式打开 → 不显示远程只读条；
  // 在标签栏选到该标签或双击正式打开后 quickPreview 会被清除，只读条恢复显示）
  const isActiveRemotePreview = computed(() => {
    if (!isRemoteFile.value) return false
    const cur = store.data[store.index!]
    return cur?.quickPreview === true
  });

  // 下载当前激活的远程文件到本地工作区根目录
  const downloadActiveRemote = async () => {
    if (!isRemoteFile.value) return
    const cur = store.data[store.index!]
    const root = store.remoteRoots.find((r: any) => r.id === cur.remoteRootId)
    if (!root) {
      ElMessage.warning(store.locales === 'zh' ? '远程工作区不存在' : 'Remote workspace not found')
      return
    }
    if (!store.root) {
      ElMessage.warning(store.locales === 'zh' ? '请先打开一个本地工作区再下载' : 'Open a local workspace first')
      return
    }
    try {
      const rel = cur.remoteRel || cur.label || 'file'
      const localPath = await downloadRemoteFile(root, rel, store.root)
      ElMessage.success(store.locales === 'zh' ? ('已下载到: ' + localPath) : ('Downloaded: ' + localPath))
      // 下载后打开本地副本（以编辑；知识库 .kb 由 openInApp 统一跳转知识处理）
      const ext = (cur.extension || '').toLowerCase()
      store.openInApp({ path: localPath, label: (localPath.replace(/\\/g, '/').split('/').pop() || ''), type: 'file', extension: ext })
    } catch (e: any) {
      ElMessage.error(store.locales === 'zh' ? ('下载失败: ' + (e?.message || '')) : ('Download failed: ' + (e?.message || '')))
    }
  };

  // 计算属性：获取激活文件的内容
  const activeFileContent = computed(() => {
    if (hasActiveFile.value) {
      return store.data[store.index!].content;
    }
    return '';
  });

  // 计算属性：获取激活文件的路径
  const activeFilePath = computed(() => {
    if (hasActiveFile.value) {
      return store.data[store.index!].path;
    }
    return '';
  });

  // 计算属性：获取激活文件的远程 base64（远程图片/PDF 预览用）
  const activeRemoteBase64 = computed(() => {
    if (hasActiveFile.value) {
      return store.data[store.index!].remoteBase64 || '';
    }
    return '';
  });

  // 计算属性：获取激活文件的远程文本（远程 Word 转好的 Markdown）
  const activeRemoteText = computed(() => {
    if (hasActiveFile.value) {
      return store.data[store.index!].remoteText || '';
    }
    return '';
  });

  // 计算属性：当前激活文件是否为 .excalidraw 白板
  const isExcalidrawFile = computed(() => {
    if (!hasActiveFile.value) return false
    const cur = store.data[store.index!]
    if (!cur) return false
    const ext = (cur.extension || '').toLowerCase()
    if (ext === '.excalidraw') return true
    const p = cur.path || ''
    return p.toLowerCase().endsWith('.excalidraw')
  });

  // .excalidraw 文件：浏览/源码编辑/可视编辑/思维导图/演示这些内容视图统一渲染 Excalidraw 白板组件
  const isExcalidrawContentView = (name: string) => {
    return FILE_VIEW_NAMES.includes(name)
  };

  // 计算属性：当前激活文件是否为 draw.io 图表
  //（.drawio/.dio/.drawio.xml 按后缀；.xml 需内容含 <mxfile>/<mxGraphModel>，避免把所有 xml 当图表）
  const isDrawioFile = computed(() => {
    if (!hasActiveFile.value) return false
    const cur = store.data[store.index!]
    if (!cur) return false
    return detectDrawioFile(cur.path, cur.content)
  });

  // draw.io 图表：内容视图同样统一渲染 Drawio 组件
  const isDrawioContentView = (name: string) => {
    return FILE_VIEW_NAMES.includes(name)
  };

  // 音频/视频扩展名集合
  const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff'];
  const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg'];

  // 计算属性：当前激活文件是否为音视频多媒体文件
  const isMediaFile = computed(() => {
    if (!hasActiveFile.value) return false
    const cur = store.data[store.index!]
    if (!cur) return false
    const ext = (cur.extension || '').toLowerCase()
    return AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)
  });

  // 多媒体文件：浏览/源码编辑/可视编辑/思维导图/演示这些内容视图统一渲染 Media 播放器组件
  const isMediaContentView = (name: string) => {
    return FILE_VIEW_NAMES.includes(name)
  };

  // 新增：清空所有标签的方法
  const clearAllTabs = async function() {
    // 只有当标签数量大于1时才执行
    if (store.data.length <= 1) {
      return;
    }
    
    // 添加确认对话框，避免误操作
    try {
      await ElMessageBox.confirm(`确定要关闭所有 ${store.data.length} 个标签页吗？`, '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      })
      // 使用动画效果关闭所有标签
      const tabs = document.querySelectorAll('.App_tab');
      tabs.forEach(tab => {
        tab.classList.add('closing');
      });
      
      // 等待动画完成
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // 清除所有标签
      store.data.splice(0, store.data.length);
      
      // 重置状态
      store.index = null;
      store.path = '';
    } catch {}
  };

  // 视图管理面板（默认关闭，点击顶部眼睛按钮开关；面板渲染在 panel.vue 的 list scoll 上方）
  const viewsPopover = ref(false);

  // 平均分配所有视图尺寸（清空保存的视图尺寸，全部等分）
  const resetViewSizes = () => {
    viewSizes.value = {}
    try { localStorage.setItem('explorerViewSizes', JSON.stringify(viewSizes.value)) } catch (e) {}
    store.resize()
  };

  // 选择文件
  const selectFile = function(index: number) {
    if (index >= 0 && index < store.data.length) {
      store.index = index;
      const cur = store.data[store.index]
      // 选中远程标签 = 视为「窗口内打开」：清除快速预览标记（显示远程只读条）；远程路径不改变本地导航
      if (cur && cur.isRemote === true) {
        if (cur.quickPreview) cur.quickPreview = false
        return
      }
      if (cur && cur.type == 'file') {
        store.path = cur.path.substring(0, cur.path.lastIndexOf('\\'));
      } else if (cur) {
        store.path = cur.path;
      }
    }
  };

  // 关闭文件
  const close = async function(event: Event, index: number) {
    event.stopPropagation();
    
    if (index < 0 || index >= store.data.length) {
      return;
    }
    
    // 添加关闭动画
    const tabElement = event.currentTarget as HTMLElement;
    const tab = tabElement.closest('.App_tab');
    if (tab) {
      tab.classList.add('closing');
      
      // 等待动画完成
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    store.data.splice(index, 1);
    
    if (store.data.length == 0) {
      store.index = null;
    } else {
      if (store.index == index) {
        store.index = Math.max(0, Math.min(index, store.data.length - 1));
        if (store.data[store.index] && store.data[store.index].type == 'file') {
          store.path = store.data[store.index].path.substring(0, store.data[store.index].path.lastIndexOf('\\'));
        } else if (store.data[store.index]) {
          store.path = store.data[store.index].path;
        }
      } else if (store.index > index) {
        store.index -= 1;
      }
    }
  };
  
  const handleWheel = function(event: WheelEvent) {
    if (tabsContainer.value) {
      tabsContainer.value.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  };
</script>

<style scoped>
  .bg {
    display: flex;
    flex-direction: column;
    height: calc(100% - 1px); /* 使用视口高度 */
    background-color: var(--backgroundColor);
    overflow: hidden; /* 防止整体溢出 */
  }

  .top-panel{
    width:100%;
    height:40px;
    line-height:40px;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
    display: flex;
    flex-shrink: 0;
  }

  .home{
    position: relative; /* 为视图管理悬浮面板提供定位参考 */
    display: flex;
    align-items: center;
    line-height: normal;
    text-align: center;
    font-size: 16px;
    color: var(--fontColor);
    cursor: pointer;
    flex-shrink: 0;
  }

  /* 新窗口模式：4 按钮组与视图下拉/搜索框同一行（由 tree-toolbar flex-wrap 控制，窄时搜索框换行） */
  .panel-home {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .panel-home-btn {
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
  .panel-home-btn:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .panel-home-btn.active {
    color: var(--fontActiveColor);
  }

  .App_tabs {
    white-space: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    line-height: normal;
    scroll-behavior: smooth;
    flex: 1;
    display: flex;
    align-items: flex-end;
    padding: 0 3px;
    flex-shrink: 0;
  }

  .App_tabs::-webkit-scrollbar {
    display: none;
  }

  .tabs-wrapper {
    display: flex;
    align-items: flex-end;
    flex-shrink: 0;
    position: relative;
    min-height: 35px;
  }

  .App_tab {
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-bottom: 0px;
    height: 35px;
    min-width: fit-content;
    max-width: 220px; /* 限制标签最大宽度 */
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    user-select: none;
    padding: 0 8px;
    margin-right: 5px;
    border-radius: 5px 5px 0px 0px;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.3s ease;
    transform-origin: left center;
    opacity: 1;
    transform: scale(1);
  }

  /* 标签文字过长时用省略号截断 */
  .App_tab .tab-label {
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
    vertical-align: middle;
  }

  .App_tab.active {
    background-color: var(--backgroundColor);
    border-bottom: 0px;
  }

  .App_tab i:not(.fa-times) {
    margin-right: 5px;
  }

  .App_tab .fa-times {
    opacity: 0.6;
    font-size: 12px;
    margin-left: 5px;
    transition: opacity 0.2s;
  }

  .App_tab .fa-times:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  /* 标签添加动画 */
  .tab-enter-active {
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    transition-delay: 0.1s;
  }

  .tab-leave-active {
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    position: absolute;
    width: auto !important; /* 保持宽度 */
  }

  /* 修改这里：从下往上进入，从当前位置向下离开 */
  .tab-enter-from {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }

  .tab-leave-to {
    opacity: 0;
    transform: translateY(10px) scale(0.95);
    margin-right: -100px; /* 让元素向右移动消失 */
  }

  .tab-enter-to,
  .tab-leave-from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .tab-move {
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes closeTab {
    0% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    50% {
      opacity: 0.5;
      transform: translateY(5px) scale(0.97);
    }
    100% {
      opacity: 0;
      transform: translateY(15px) scale(0.9);
      margin-right: -40px;
      width: 0;
      padding: 0;
    }
  }

  /* 标签悬停效果 */
  .App_tab:hover:not(.active) {
    background-color: rgba(128, 128, 128, 0.1);
    transform: translateY(-1px);
  }

  .App_tab.active:hover {
    background-color: var(--backgroundColor);
  }

  .explorer-container {
    display: flex;
    width: 100%;
    flex: 1; /* 占据剩余空间 */
    min-height: 0; /* 关键：允许flex子元素收缩 */
    overflow: hidden; /* 防止内容溢出 */
    position: relative; /* 为绝对定位的 resizer 提供参考 */
  }
  
  /* 左侧面板容器，宽度由 inline style 控制 */
  .left-wrap {
    height: 100%;
    overflow: hidden;
    border-right: 1px solid var(--borderColor);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    width: 200px;
  }

  .left-panel {
    width: 100%;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    background: transparent;
    z-index: 20;
    transition: background-color 0.15s;
    transform: translateX(-3px);
  }
  .resizer:hover { background: rgba(0,0,0,0.04); }

  .right-content {
    flex: 1;
    min-width: 0; /* 关键：允许flex子元素收缩 */
    overflow: hidden; /* 改为hidden，防止滚动条 */
    display: flex;
    flex-direction: column; /* 远程只读提示条与内容区纵向排列，避免覆盖 */
  }

  /* 远程只读提示条 */
  .remote-readonly-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font-size: 11px;
    color: var(--fontColor);
    background: color-mix(in srgb, #42b883 10%, var(--menuColor));
    border-bottom: 1px solid color-mix(in srgb, #42b883 30%, var(--borderColor));
    user-select: none;
  }
  .remote-readonly-spacer {
    flex: 1;
  }
  .remote-download-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: #42b883;
    font-weight: 600;
  }
  .remote-download-btn:hover {
    text-decoration: underline;
  }

  .explorer {
    display: flex;
    flex: 1; /* 占据提示条之外的剩余高度 */
    min-height: 0; /* 关键：允许flex子元素收缩 */
    min-width: 0;
    overflow: hidden;
  }
  
  /* 视图面板 - 由 inline style 控制 flex，默认等分 */
  .view-panel {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    position: relative; /* 为 Excalidraw 等绝对定位子组件提供定位参考 */
  }
  .view-panel > * {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* 视图之间的拖拽手柄：不占布局宽度，悬浮覆盖在视图交界处 */
  .view-resizer {
    flex: 0 0 0;          /* 不占用 flex 布局空间 */
    background: transparent;
    z-index: 20; /* 提高层级，确保不被相邻视图内容覆盖 */
    pointer-events: auto;
    touch-action: none;
    position: relative;
    overflow: visible;
    transition: background-color 0.15s;
  }
  .view-resizer.resizer-h {
    width: 0;
    height: 100%;
    cursor: col-resize;
  }
  .view-resizer.resizer-v {
    width: 100%;
    height: 0;
    cursor: row-resize;
  }
  /* 悬浮视觉条（默认透明，悬停时显示） */
  .view-resizer.resizer-h::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
  }
  .view-resizer.resizer-v::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: -3px;
    height: 6px;
  }
  /* 扩大拖拽命中区（透明伪元素），提升可抓取性 */
  .view-resizer.resizer-h::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -5px;
    right: -5px;
  }
  .view-resizer.resizer-v::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: -5px;
    bottom: -5px;
  }
  .view-resizer:hover::before { background: var(--borderColor); }
  
  .button{
    background-color: var(--backgroundColor);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3px 8px;
    transition: all 0.2s;
  }
  
  .button.active {
    background-color: var(--menuActiveColor);
  }
  
  /* 新增：禁用状态样式 */
  .button.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  
  .button:not(.disabled):hover {
    background-color: var(--menuHoverColor);
    transform: translateY(-1px);
  }

  /* 模糊搜索窗口（类似设置界面，悬浮弹出） */
  .search-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1600;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, 0.35);
  }
  .search-panel {
    width: min(720px, calc(100% - 96px));
    height: min(520px, calc(100% - 96px));
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    background-color: var(--backgroundColor);
    display: flex;
    flex-direction: column;
  }

  /* 顶部标题栏：与 settings-header 完全一致 */
  .settings-header {
    flex-shrink: 0;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 0 12px;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    border-top-left-radius: 10px;
    border-top-right-radius: 10px;
    user-select: none;
  }
  .settings-header-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fontColor);
  }
  .settings-header-title i {
    color: var(--fontActiveColor);
  }
  .settings-close {
    width: 26px;
    height: 26px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fontColor);
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 14px;
  }
  .settings-close:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }

  .search-panel-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-top: none;
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
  }
</style>