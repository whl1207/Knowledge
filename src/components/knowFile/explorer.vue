<template>
  <div class="bg knowfile-menu">
    <!-- 主要内容区域保持不变 -->
    <div class="explorer-container" :class="{ tall: isTallLayout }">
      <!-- 左侧面板（可调整宽度，始终为文件树；收起 / 展开走宽度过渡动画，见下方 .left-panel-* 类）
           细长窗口（高宽比 > 16:9，如手机竖屏）下改为**覆盖式整屏抽屉**：右侧视图始终占满整屏，
           抽屉由工具栏最左的开关打开、点文件夹 / 文件（或抽屉左上角的返回）后收起 -->
      <Transition name="left-panel" @after-enter="store.resize()" @after-leave="store.resize()">
        <div class="left-wrap" v-if="mode" :style="isTallLayout ? undefined : { '--left-w': leftWidth + 'px' }">
          <panel v-if="mode=='file'" ref="panelRef" class="left-panel" @node-opened="onNodeOpened">
            <!-- 抽屉左上角返回（细长窗口才有：抽屉盖住了工具栏上的那个开关） -->
            <template #toolbar-left>
              <div v-if="isTallLayout" class="panel-home-btn drawer-back" @click="toggleMode('file')"
                :title="store.locales=='zh'?'收起文件树':'Close file tree'">
                <i class="fa fa-arrow-left"></i>
              </div>
            </template>
            <!-- 面板顶部按钮组：工作区 / 打开文件 / 搜索 / 创建文件 -->
            <template #toolbar>
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
      </Transition>
      <!-- 拖拽条：收起时滑到左边并淡出，跟随面板的宽度过渡（不用 v-if，否则展开时会瞬间出现在终点）；
           细长窗口下不调宽度（抽屉整屏），隐藏 -->
      <div class="resizer" :class="{ 'is-hidden': !mode || isTallLayout, 'is-dragging': isDragging }" @mousedown.prevent="startDrag" :style="{ left: (mode ? leftWidth - 3 : -6) + 'px' }"></div>
      <!-- 右侧内容区域 -->
      <div class="right-content">
        <!-- 远程只读提示条（远程文件在右窗格预览时显示；单击快速预览不显示） -->
        <div v-if="isRemoteFile && !isActiveRemotePreview" class="remote-readonly-bar">
          <i class="fa fa-cloud" style="color:#42b883"></i>
          <span>{{ store.locales=='zh'?'远程文件为只读预览':'Remote file (read-only preview)' }}</span>
          <span class="remote-readonly-spacer"></span>
          <span class="remote-download-btn" @click="downloadActiveRemote" :title="store.locales=='zh'?'下载到当前工作区':'Download to current workspace'">
            <i class="fa fa-download"></i> {{ store.locales=='zh'?'下载到本地':'Download' }}
          </span>
        </div>
        <!-- 顶部工具栏（面板开关 + 视图选择 + 路径面包屑 + 搜索 + 刷新）：右侧视图共用这一条 -->
        <ViewToolbar
          v-if="viewToolbarVisible"
          v-model:search="store.knowQuery"
          :panel-open="!!mode"
          :searchable="viewToolbarSearchable"
          :placeholder="store.locales === 'zh' ? '搜索当前目录…（支持 属性:值）' : 'Search this folder… (attr:value)'"
          :search-title="store.locales === 'zh' ? '搜索当前目录：标题 / 状态 / 属性值，也支持 状态:待办、优先级>2' : 'Search this folder: title / status / attribute values (Status:todo, Priority>2)'"
          @toggle-panel="toggleMode('file')"
          @refresh="store.knowRefreshViews()"
        />
        <div class="explorer">
          <!-- 主窗口一次只显示一个视图：全局视图（store.view 单选，见 设置 → 功能 → 知识管理）；
               远程文件预览标签激活时自动换成「浏览」（只读预览，不需要在设置里开），关掉标签即回到原视图 -->
          <div v-if="activeView" class="view-panel">
            <view_file v-if="activeView==='文件'" />
            <view_graph v-if="activeView==='图谱'" />
            <view_kanban v-if="activeView==='看板'" />
            <view_year v-if="activeView==='日历'" />
            <view_map v-if="activeView==='地图'" />
            <view_table v-if="activeView==='表格'" />
            <!-- 专属文件（图表 / 白板 / 工作流 / 数据画布）与音视频：在「浏览」视图里渲染各自编辑器（远程只读） -->
            <Drawio v-if="isDrawioFile && isDrawioContentView(activeView)" :path="activeFilePath" :content="activeFileContent" :readonly="isRemoteFile" />
            <Excalidraw v-if="isExcalidrawFile && isExcalidrawContentView(activeView)" :path="activeFilePath" :content="activeFileContent" />
            <Media v-else-if="isMediaFile && isMediaContentView(activeView)" :path="activeFilePath" :content="activeFileContent" />
            <WorkflowEditor v-if="isFlowDslFile && isFlowContentView(activeView)" :path="activeFilePath" :content="activeFileContent" :readonly="isRemoteFile" />
            <DataCanvasModule v-if="isDataFile && isDataContentView(activeView)" :task-file-path="activeFilePath" mode="full" @file-saved="onDataCanvasSaved" />
            <Mermaid v-if="isMermaidFile && isMermaidContentView(activeView)" :path="activeFilePath" :content="activeFileContent" />
            <md_read v-if="!isDrawingEditor && !isMediaFile && !isFlowDslFile && !isDataFile && !isMermaidFile && activeView===VIEW_BROWSE" :content="activeFileContent" :path="activeFilePath" :is-remote="isRemoteFile" :remote-base64="activeRemoteBase64" :remote-text="activeRemoteText" />
          </div>
          <empty v-else />
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
  import { usestore, DEFAULT_VIEW } from '@/store'
  import { VIEW_BROWSE } from '@/lib/knowFile/fileViews'
  // 专属文件类型（白板 / 图表 / 工作流 / 数据画布）的判别、编辑器与视图范围统一取自 fileEditors.ts
  import { detectEditorKind, editorVisibleInView, FILE_EDITORS } from '@/components/knowFile/fileEditors'
  import { ElMessageBox, ElMessage } from 'element-plus'
  import { downloadRemoteFile } from '@/platform/remoteFs'
  import { useBackLayer } from '@/composables/useBackLayer'
  import { BACK_ORDER } from '@/platform/backLayers'
  
  import view_file from '@/components/knowFile/view/view_file.vue'
  import view_kanban from '@/components/knowFile/view/view_kanban.vue'
  import view_graph from '@/components/knowFile/view/view_graph.vue'
  import view_year from '@/components/knowFile/view/view_year.vue'
  import view_map from '@/components/knowFile/view/view_map.vue'
  import view_table from '@/components/knowFile/view/view_table.vue'
  import md_read from '@/components/knowFile/view/md_read.vue'
  import empty from '@/components/knowFile/view/empty.vue'

  // 白板 / 图表 / 工作流编辑器 / 数据画布（懒加载入口统一取自 fileEditors.ts，drawio 运行时随应用打包在 /drawio）
  const Excalidraw = defineAsyncComponent(FILE_EDITORS.excalidraw.load)
  const Drawio = defineAsyncComponent(FILE_EDITORS.drawio.load)
  // 音视频多媒体播放器（懒加载，音视频文件统一用它打开）
  const Media = defineAsyncComponent(() => import('@/components/knowFile/view/Media.vue'))
  const WorkflowEditor = defineAsyncComponent(FILE_EDITORS.flow.load)
  const DataCanvasModule = defineAsyncComponent(FILE_EDITORS.data.load)
  // Mermaid 图表（.mmd / .mermaid）
  const Mermaid = defineAsyncComponent(FILE_EDITORS.mermaid.load)
  
  import panel from '@/components/knowFile/panel.vue'
  import ViewToolbar from '@/components/knowFile/ViewToolbar.vue'
  import search from '@/components/knowFile/search.vue'
import { getPlatform, hasCapability } from '@/platform'
import { useTallLayout } from '@/composables/useTallLayout'
  
  const store = usestore();

  const mode = ref('file');
  // 文件树面板引用（用于刷新左侧文件树）
  const panelRef = ref<any>(null);

  // 细长窗口（高宽比 > 16:9，如手机竖屏）：左栏改为覆盖式整屏抽屉，右侧视图始终占满整屏
  //（判定与窗口监听与主页共用同一份，见 useTallLayout）
  const isTallLayout = useTallLayout();

  /** 收起抽屉（细长窗口下点文件夹 / 文件后自动收起，回到右侧视图） */
  const closeDrawer = () => {
    if (!mode.value) return
    mode.value = ''
    store.resize()
  };

  /** 文件树里打开了文件 / 进入了文件夹：细长窗口下收起抽屉，让右侧视图接手展示 */
  const onNodeOpened = () => {
    if (isTallLayout.value) closeDrawer();
  };

  // 模糊搜索窗口显隐（类似设置界面，悬浮弹出）
  const searchOpen = ref(false);

  // ==================== 安卓返回手势（本模块内的界面栈） ====================
  // 本模块自己的可回退状态：① 模糊搜索浮窗 ② 细长窗口（手机竖屏）下打开的整屏文件树抽屉
  // （等价于点抽屉左上角的 ←，或点文件夹 / 文件后自动收起）。
  // 更靠内层的浮层（应用内文件窗口、设置）由各自 / App.vue 登记，优先级见 platform/backLayers。
  useBackLayer(
    'explorer',
    BACK_ORDER.moduleNav,
    () => {
      if (store.mainPanel !== '知识管理') return false
      if (store.settingsOpen || store.fileWindowOverlay) return false
      if (searchOpen.value) return true
      return isTallLayout.value && !!mode.value
    },
    () => {
      if (searchOpen.value) { searchOpen.value = false; return }
      closeDrawer()
    },
  );

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
  // 拖动面板宽度时用它屏蔽拖拽条的 left 过渡（否则拖拽条会滞后于面板边缘）
  const isDragging = ref(false);

  // 主窗口一次只显示一个视图（见模板）：全局视图跟 store.view（单选），
  // 远程文件预览标签激活时自动顶成「浏览」——关掉标签即回到原来选的全局视图，无需在设置里开「浏览」
  const activeView = computed(() => {
    if (isRemoteFile.value) return VIEW_BROWSE
    if (!store.root) return ''
    // 兜底默认视图：store.loadConfig 保证 store.view 至少有一个全局视图
    return store.viewList.find((v: string) => store.view.includes(v)) || DEFAULT_VIEW
  })

  // 顶部工具栏（面板开关 + 视图选择 + 路径面包屑 + 搜索 + 刷新）：右侧视图共用这一条
  const viewToolbarVisible = computed(() => !!store.root)
  // 只有「地图」没有搜索需求：当前视图是地图时不显示搜索框
  const viewToolbarSearchable = computed(() => activeView.value !== '地图')

  const startDrag = (e: MouseEvent) => {
    isDragging.value = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', stopDrag);
  };

  const onDrag = (e: MouseEvent) => {
    if (!isDragging.value) return;
    const newWidth = Math.max(minLeftWidth, Math.min(maxLeftWidth, e.clientX));
    leftWidth.value = newWidth;
  };

  const stopDrag = () => {
    isDragging.value = false;
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', stopDrag);
    try { localStorage.setItem('leftPanelWidth', String(leftWidth.value)); } catch (e) {}
    // 左侧面板宽度变化后触发 resize，让依赖容器尺寸的组件（图表/画布等）重新布局
    store.resize()
  };

  // 通道 B：其他窗口（本窗口以「浏览」预览远程文件时）保存文件后广播到达主窗口 → 同步本窗口 store 中匹配标签的内容，
  // 让右侧预览实时刷新显示。
  let unsubFileContent: (() => void) | null = null
  const onFileContentChanged = (payload: unknown) => {
    const { path: changedPath, content: newContent } = (payload || {}) as { path?: string; content?: string }
    if (!changedPath || newContent == null) return
    // 主窗口不再承载任何编辑器（文件一律在独立窗口编辑），广播到达后直接同步标签内容
    for (let i = 0; i < store.data.length; i++) {
      const tab = store.data[i]
      if (!tab || tab.path !== changedPath) continue
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
    // 细长窗口：起手就按「抽屉」规则定好——有工作区时收起（右侧视图占满整屏），
    // 没有工作区时展开（打开工作区 / 打开文件的入口都在树里，收起会让新手无从下手）
    if (isTallLayout.value) mode.value = store.root ? '' : 'file'
    // 监听其他窗口保存文件后的内容广播（通道 B）
    unsubFileContent = getPlatform().events.on('file-content-changed', onFileContentChanged)
  });

  // 细长布局 / 工作区变化时调整抽屉：
  //  - 刚打开工作区（空 → 有）：收起抽屉，直接看右侧视图
  //  - 刚进入细长布局：有工作区收起、没有则展开
  //  - 离开细长布局（回到宽窗口）：恢复桌面并排显示
  watch([isTallLayout, () => store.root], ([tall, root], [wasTall, wasRoot]) => {
    if (!tall) {
      if (tall !== wasTall) { mode.value = 'file'; store.resize() }
      return
    }
    if (!wasRoot && root) { closeDrawer(); return }
    if (tall !== wasTall) {
      mode.value = root ? '' : 'file'
      store.resize()
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', stopDrag);
    window.removeEventListener('keydown', onSearchKeydown);
    unsubFileContent?.()
    unsubFileContent = null
  });

  // 切换模式的方法
  const toggleMode = function(targetMode: string) {
    mode.value = mode.value !== targetMode ? targetMode : '';
    // 展开/关闭左侧面板会改变布局，触发 resize 让其他组件重新布局
    store.resize()
  };

  // 通过对话框选择文件夹并添加为工作区（支持多个工作区）
  const openFolderDialog = async function() {
    let path = await getPlatform().dialog.pickDirectory()
    if(path != null){
      // 添加为新的工作区并设为当前工作区（重复路径仅切换当前工作区，返回 false）
      const isNew = store.addRoot(path)
      if (!isNew) {
        ElMessage.warning(store.locales === 'zh' ? '该文件夹已在工作区列表中' : 'This folder is already in your workspace list')
        return
      }
      // 启动文件监听（监听所有工作区）
      await getPlatform().watch.acquire([...store.roots])
      // 刷新左侧文件树
      await panelRef.value?.refreshTree()
    }
    store.saveConfig()
  };

  // 通过对话框打开文件（打开文件）
  const openFileDialog = async function() {
    const path = await getPlatform().dialog.pickFile()
    if(path != null){
      // 本地 HTML 文件：默认用浏览器 Agent 打开（与知识管理双击一致）
      const extLow = String(path).toLowerCase()
      if (extLow.endsWith('.html') || extLow.endsWith('.htm')) {
        await getPlatform().browserAgent.call('open-file', { path })
        return
      }
      const inf = await getPlatform().fs.getInfo(path); //获取信息
      const attributes = await getPlatform().fs.readMetadata(path); //获取属性
      const fileContent = await getPlatform().fs.readText(path)
      // 打开文件：一律用独立窗口打开（原「窗口内打开」模式已去掉）
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
      // 下载后打开本地副本（以编辑；知识库 .kb 由 openFileByMode 统一跳转知识处理）
      const ext = (cur.extension || '').toLowerCase()
      store.openFileByMode({ path: localPath, label: (localPath.replace(/\\/g, '/').split('/').pop() || ''), type: 'file', extension: ext })
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

  // 计算属性：当前激活文件的专属编辑器类型（.excalidraw / .drawio / .flow.yml / .data；其余为 null 走通用视图）
  const editorKind = computed(() => {
    if (!hasActiveFile.value) return null
    const cur = store.data[store.index!]
    if (!cur) return null
    return detectEditorKind({ path: cur.path, extension: cur.extension, content: cur.content })
  });

  // 绘图类（白板 / 图表）接管全部视图：浏览 / 源码编辑 / 可视编辑 / 导图 / 演示 全部渲染绘图界面，通用视图让位
  const isDrawingEditor = computed(() => editorKind.value === 'excalidraw' || editorKind.value === 'drawio');
  const isExcalidrawFile = computed(() => editorKind.value === 'excalidraw');
  const isDrawioFile = computed(() => editorKind.value === 'drawio');
  const isExcalidrawContentView = (name: string) => editorVisibleInView('excalidraw', name);
  const isDrawioContentView = (name: string) => editorVisibleInView('drawio', name);

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

  // 多媒体文件：主窗口只在「浏览」视图里渲染 Media 播放器（远程文件的音视频预览也走这里）
  const isMediaContentView = (name: string) => name === VIEW_BROWSE;

  const isFlowDslFile = computed(() => editorKind.value === 'flow');
  const isDataFile = computed(() => editorKind.value === 'data');
  // 工作流 / 数据画布：浏览、可视编辑渲染流程画布或画布模块（源码编辑仍按 YAML / JSON 文本打开）
  const isFlowContentView = (name: string) => editorVisibleInView('flow', name);
  const isDataContentView = (name: string) => editorVisibleInView('data', name);

  const isMermaidFile = computed(() => editorKind.value === 'mermaid');
  // Mermaid 图表（.mmd / .mermaid）：只替换「浏览」视图（源码编辑在独立窗口用 Monaco 改）
  const isMermaidContentView = (name: string) => editorVisibleInView('mermaid', name);

  /** 数据画布保存成功：把写盘内容同步回打开的标签，并通知其它窗口（避免再读一次大文件） */
  const onDataCanvasSaved = (path: string, content?: string) => {
    if (!path || typeof content !== 'string') return
    const tab = (store.data || []).find((item: any) => item && item.path === path)
    if (tab) tab.content = content
    getPlatform().app.notifyFileChanged({ path, content }).catch(() => {})
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

  /* 面板顶部 4 按钮组（工作区 / 打开文件 / 搜索 / 创建文件）：与搜索框同一行（见 panel.vue 的 .tree-toolbar） */
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
  /* 抽屉返回按钮（细长窗口）：只占一个图标位，放在搜索框左侧 */
  .drawer-back {
    margin-right: 2px;
  }

  .explorer-container {
    display: flex;
    width: 100%;
    flex: 1; /* 占据剩余空间 */
    min-height: 0; /* 关键：允许flex子元素收缩 */
    overflow: hidden; /* 防止内容溢出 */
    position: relative; /* 为绝对定位的 resizer 提供参考 */
  }
  
  /* 左侧面板容器，宽度由 --left-w 控制（收起 / 展开时过渡这个宽度做出滑出观感） */
  .left-wrap {
    height: 100%;
    overflow: hidden;
    border-right: 1px solid var(--borderColor);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    width: var(--left-w, 200px);
    min-width: 0;
  }

  /* 收起 / 展开动画：外层宽度 0 ↔ --left-w，内层面板保持原宽（被裁切而非被压扁） */
  .left-wrap.left-panel-enter-active,
  .left-wrap.left-panel-leave-active {
    transition: width 0.22s ease, opacity 0.22s ease;
  }
  .left-wrap.left-panel-enter-from,
  .left-wrap.left-panel-leave-to {
    width: 0;
    opacity: 0;
  }

  .left-panel {
    width: var(--left-w, 100%);
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
    transition: background-color 0.15s, left 0.22s ease, opacity 0.22s ease;
    transform: translateX(-3px);
  }
  .resizer.is-hidden { opacity: 0; pointer-events: none; }
  /* 拖动宽度时去掉 left 过渡，拖拽条要贴着面板边缘即时跟手 */
  .resizer.is-dragging { transition: background-color 0.15s; }
  .resizer:hover { background: rgba(0,0,0,0.04); }

  /* ====== 细长窗口（高宽比 > 16:9，如手机竖屏）：左栏 = 覆盖式整屏抽屉 ======
     不再与右侧视图分栏（分栏会把右侧挤到不可用），抽屉展开时整屏盖住内容区与工具栏，
     关闭后右侧视图独占整屏；删除的分隔线 / 拖拽条在这里都不适用。 */
  .explorer-container.tall .left-wrap {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    border-right: 0;
    z-index: 30;
  }
  .explorer-container.tall .left-panel {
    width: 100%;
  }

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
  
  /* 视图面板 - 一次只渲染一个视图，撑满右侧区域 */
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
    width: min(1200px, calc(100% - 48px));
    height: min(820px, calc(100% - 48px));
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