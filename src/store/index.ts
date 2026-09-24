// store/index.ts 

import { defineStore } from "pinia"
import { nextTick, markRaw } from "vue"
import { TTSManager, createTTSManager } from '@/services/tts/manager'
import { AIUtils } from '@/services/ai-utils'
import type { McpServerConfig } from '@/types/mcp'
import { generateMcpServerId } from '@/types/mcp'
import { FILE_VIEW_NAMES, normalizeViewName } from '@/lib/knowFile/fileViews'
import { detectTaskScaffold, detectRetiredTaskScaffold, isTaskFile, RETIRED_SCAFFOLD_LABELS, MERGED_SCAFFOLD_KEYS, MERGED_SCAFFOLD_LABELS } from '@/lib/taskFile'
import { DEFAULT_AGENT_MAX_STEPS, normalizeAgentMaxSteps } from '@/shared/agent-loop-rounds'
import { normalizeWebSearchConfig, newWebSearchCustomSource, toCustomProviderId, type WebSearchConfig, type WebSearchCustomSource } from '@/shared/webSearch'
import { migrateLegacyContextWindow } from '@/lib/contextUsage'
import { deepSeekConfig, deepSeekStyleOf, migrateDeepSeekMerge, normalizeLlmType, normalizeLlmTypeList, DEEPSEEK_LEGACY_TYPE } from '@/shared/llmSources'
import { ElMessage } from 'element-plus'
declare global {
  interface Window {
    _refreshTimer: NodeJS.Timeout | null;
  }
}

// 目录树为只读静态数据（整体替换刷新，节点内容不再变化）：深度 markRaw 使其成为非响应式，
// el-tree 的深层 watch 在遍历到节点时经 __v_skip 短路，避免大目录下数秒的响应式转换/深层遍历开销
export function markRawTree(tree: any[]): any[] {
  const walk = (nodes: any[]): any[] => {
    for (const n of nodes) {
      if (n && Array.isArray(n.children) && n.children.length) walk(n.children)
      markRaw(n)
    }
    return nodes
  }
  return markRaw(walk(tree))
}
// 主面板导航按钮 key 顺序（设置页「功能开关」据此隐藏/显示；当前面板被隐藏时自动跳到第一个可见面板）
const MAIN_PANEL_KEYS = ['主页', '知识管理', '知识处理', '学习', '工作流管理', '数据画布', 'Agent脚手架', '待办管理']

// 主题广播抑制标志：applyThemeFromBroadcast 应用其他窗口广播时置真，避免 setTheme 再广播造成循环
// （每个渲染进程是独立模块实例，此标志天然按窗口隔离）
let themeBroadcastGuard = false
// 上次广播的 UI 序列化串（同窗口内去重：仅在 UI 实际变化时向其它窗口广播一次）
let lastBroadcastUiJson = ''
// 上次广播的语言（语言不属于 UI，单独去重；否则只改语言时不会触发广播）
let lastBroadcastLocale = ''
// 上次下发主进程的搜索源配置（saveConfig 调用频繁，按序列化结果去重，避免重复 IPC）
let lastAppliedWebSearchJson = ''

// 是否持久化标签栏（data/index）：独立文件窗口设 false，避免把新窗口打开的标签写进共享 localStorage，
// 导致主窗口重启后恢复出独立窗口产生的标签（新窗口模式主窗口标签栏应为空）
let persistTabs = true

// 是否持久化主面板导航（mainPanel）：独立窗口（设置/文件/浏览器）设 false。
// mainPanel 只在主窗口有意义，而独立窗口的 store 是「打开那一刻的快照」——
// 它写盘会把主窗口当前面板覆盖回旧值（现象：关闭设置子窗口后主窗口从「主页」跳回「工作流管理」）。
let persistMainPanel = true

// 是否作为「设置写盘方」：仅设置独立窗口置真，saveConfig 时额外广播配置变更给其它窗口
let settingsConfigWriter = false

// 预设主题配色表（设置页「界面-主题」18 个预设主题；changeTheme 统一从表取值，下拉框由 Object.keys 生成，labelEn 供英文界面展示）
/** 跨平台取父目录：Windows 盘符根 / Linux 根正确归位（返回父目录或空串） */
function parentPathOf(p: string): string {
    if (!p) return ''
    const sep = p.includes('\\') ? '\\' : '/'
    const trimmed = p.replace(/[\\/]+$/, '')
    if (!trimmed) return ''
    const i = trimmed.lastIndexOf(sep)
    if (i <= 0) {
        if (sep === '/' && trimmed.startsWith('/')) return '/'
        return ''
    }
    return trimmed.substring(0, i)
}

export const THEMES: Record<string, { labelEn: string; backgroundColor: string; borderColor: string; menuColor: string; menuActiveColor: string; fontColor: string; fontActiveColor: string }> = {
    '浅蓝': { labelEn: 'Light Blue', backgroundColor: "#ffffff", borderColor: "#d0d7de", menuColor: "#fafcff", menuActiveColor: "#cde4ff", fontColor: "#1f2328", fontActiveColor: "#03254d" },
    '浅红': { labelEn: 'Light Red', backgroundColor: "#ffffff", borderColor: "#888888", menuColor: "#f0f0f0", menuActiveColor: "#ECD7D6", fontColor: "#111111", fontActiveColor: "#990000" },
    '深色': { labelEn: 'Dark', backgroundColor: "#0D1117", borderColor: "#30363D", menuColor: "#161617", menuActiveColor: "#24272E", fontColor: "#ffffff", fontActiveColor: "#CCA700" },
    '灰色': { labelEn: 'Gray', backgroundColor: "#1e1e1e", borderColor: "#444444", menuColor: "#303030", menuActiveColor: "#4c4c4c", fontColor: "#ffffff", fontActiveColor: "#ffff00" },
    '暖色': { labelEn: 'Warm Tones', backgroundColor: "#fef6e4", borderColor: "#ff8a8a", menuColor: "#f2e7d5", menuActiveColor: "#fd6d6d", fontColor: "#172c66", fontActiveColor: "#621601" },
    '午夜蓝': { labelEn: 'Midnight Blue', backgroundColor: "#1a1b26", borderColor: "#414868", menuColor: "#24283b", menuActiveColor: "#06318d", fontColor: "#c0caf5", fontActiveColor: "#eaf556" },
    '极简灰': { labelEn: 'Minimal Gray', backgroundColor: "#ffffff", borderColor: "#dddddd", menuColor: "#f5f5f5", menuActiveColor: "#e0e0e0", fontColor: "#333333", fontActiveColor: "#000000" },
    '暗夜紫': { labelEn: 'Dark Purple', backgroundColor: "#1a142b", borderColor: "#4a3f6e", menuColor: "#2a1f3a", menuActiveColor: "#5a4a8a", fontColor: "#d4c5ff", fontActiveColor: "#b794f4" },
    '奶茶色': { labelEn: 'Milk Tea Color', backgroundColor: "#f9f1e7", borderColor: "#d9b99b", menuColor: "#f3e5d5", menuActiveColor: "#e6c9af", fontColor: "#6b4f3c", fontActiveColor: "#aa7a5c" },
    '薄荷绿': { labelEn: 'Mint Green', backgroundColor: "#f0faf5", borderColor: "#a8e6cf", menuColor: "#e6f7ef", menuActiveColor: "#b8e6d0", fontColor: "#2d6a4f", fontActiveColor: "#1b4332" },
    '樱花粉': { labelEn: 'Cherry Pink', backgroundColor: "#fef0f0", borderColor: "#f5c6c6", menuColor: "#fce4e4", menuActiveColor: "#f8b4b4", fontColor: "#8b3a3a", fontActiveColor: "#5c1a1a" },
    '海洋蓝': { labelEn: 'Ocean Blue', backgroundColor: "#eef5fb", borderColor: "#b3d4f0", menuColor: "#e0edf7", menuActiveColor: "#b8d8f0", fontColor: "#1a5276", fontActiveColor: "#0e2f44" },
    '极光绿': { labelEn: 'Aurora Green', backgroundColor: "#0d1b2a", borderColor: "#1b3a2a", menuColor: "#162a3a", menuActiveColor: "#1a4a3a", fontColor: "#8de0a0", fontActiveColor: "#00ff88" },
    '复古黄': { labelEn: 'Vintage Yellow', backgroundColor: "#faf3e0", borderColor: "#e8d5a3", menuColor: "#f5ead0", menuActiveColor: "#ecd9a8", fontColor: "#5d4a2a", fontActiveColor: "#8b6914" },
    '暗夜绿': { labelEn: 'Dark Green', backgroundColor: "#0a1f14", borderColor: "#1a3a28", menuColor: "#102a1c", menuActiveColor: "#1a4a30", fontColor: "#a8d5b8", fontActiveColor: "#4ade80" },
    '珊瑚橙': { labelEn: 'Coral Orange', backgroundColor: "#fef5ef", borderColor: "#fad1b0", menuColor: "#fce8d8", menuActiveColor: "#f8c8a8", fontColor: "#7a3a1a", fontActiveColor: "#cc5500" },
    '冰雪蓝': { labelEn: 'Ice Blue', backgroundColor: "#f0f8ff", borderColor: "#b0d8f0", menuColor: "#e0f0fa", menuActiveColor: "#c0e0f5", fontColor: "#1a4a6a", fontActiveColor: "#0066aa" },
    '巧克力': { labelEn: 'Chocolate', backgroundColor: "#f5efe8", borderColor: "#d4bc9a", menuColor: "#ede0d0", menuActiveColor: "#dcc8a8", fontColor: "#3d2b1f", fontActiveColor: "#6b3a1a" },
}

/** 主题名归一化：THEMES 表是唯一真源（下拉选项由 Object.keys(THEMES) 生成），「自定义」是唯一允许的表外值。
 *  历史默认值写作 '浅蓝色'（多一个「色」），与表键 '浅蓝' 不匹配 → 新装软件的主题下拉框选不中任何项
 *  （浏览器显示第一项，但 v-model 值仍是 '浅蓝色'），且 changeTheme() 取不到配色。
 *  返回 true 表示发生了修正（调用方据此决定是否需要落盘）。 */
export function normalizeThemeName(ui: any): boolean {
    if (!ui || typeof ui !== 'object') return false
    if (ui.theme === '自定义' || THEMES[ui.theme]) return false
    ui.theme = '浅蓝'
    return true
}

// Agent脚手架定义（AgentScaffold 实例类型 / 新建入口共用，避免两处维护名称/图标）
// multi：是否允许开多个实例（多开时每个实例关联一个独立 .task 文件）；maxInstances：单类型实例上限
// 2026-09-21 收尾：批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格 四个旧脚手架已并入
// 「Agent脚手架」（对应其四种预设，见 Pipeline/presets.ts），SCAFFOLDS 收敛为唯一一项；
// 旧 .task 文件仍可识别：打开时自动转换为 Agent脚手架配置（见 openTaskFileByPath 与 MERGED_SCAFFOLD_KEYS）。
export const SCAFFOLDS: { key: string; icon: string; labelZh: string; labelEn: string; multi: boolean; maxInstances: number; preview?: boolean }[] = [
    { key: 'pipeline', icon: 'fa fa-sitemap', labelZh: 'Agent脚手架', labelEn: 'Agent Scaffold', multi: true, maxInstances: 4 },
]
// 注：原「agent（程序化工具调用 / PTC）」脚手架已下线，改为主页对话模式 ChatMode='code'（下拉选「PTC」）。
// 旧 .task 文件仍可被识别（lib/taskFile.ts RETIRED_TASK_SCAFFOLDS），打开时给出迁移提示。

/** 默认启用的脚手架 key（`preview` 标记的默认关闭；当前无预览项）。
 *  注：设置页的「脚手架」开关已移除（2026-09-21）——脚手架恒定启用；
 *  下列字段保留以兼容旧存档（旧值仍会被尊重）。 */
export function defaultEnabledScaffoldKeys(): string[] {
    return SCAFFOLDS.filter(s => !s.preview).map(s => s.key)
}

/** Agent脚手架实例（多开）：一个实例 = 一个独立任务 + 一个关联 .task 文件 */
export interface ScaffoldInstanceMeta {
    /** 实例 id：`<脚手架 key>:<随机串>`（删除后不复用） */
    id: string
    /** 脚手架 key（对应 SCAFFOLDS.key） */
    type: string
    /** 显示标题（默认取关联文件名，可手动重命名） */
    title: string
    /** 关联任务文件绝对路径（新建实例时立即创建占位文件，禁止与其他实例重复） */
    filePath: string
    /** 标题是否被手动改过（true 后不再跟随文件名重命名） */
    titleManual?: boolean
    /** 关联文件缺失（被移动/删除） */
    fileMissing?: boolean
    createdAt: number
    lastActiveAt: number
}
// 默认 AI 配置快照（「恢复默认 AI 配置」用）：state() 首次执行时捕获出厂默认值，
// 确保恢复结果与初始默认完全一致，不受后续 loadConfig 合并/用户修改影响
let DEFAULT_AIconfig: any = null
let _aiConfigCaptured = false
export const usestore = defineStore('data', {
    // 创建state
    state: () => {
        const s = {
        root: "" as string, // 当前工作区路径（兼容旧字段，指向 roots 中的当前项）
        roots: [] as string[], // 工作区列表（支持多个工作区）
        path: "" as string, // 当前路径
        skillsPath: "" as string, // 技能文件夹路径
        workflowPath: "" as string, // 工作流文件夹路径
        agentPresetPath: "" as string, // Agent 预设（.agent 文件）存储文件夹路径（仅会话内生效，不持久化）
        // 工具管理：智能体/技能（Agent 循环）默认可调用的工具白名单（null=默认全集，[]=全部关闭，其他=仅启用列表中的工具）
        agentTools: null as string[] | null,
        // 技能管理：被禁用的技能名（开关关闭的技能不注入智能体、不被 skill 工具加载）
        disabledSkills: [] as string[],
        // 技能商店：用户自定义的 GitHub 技能源（owner/repo）
        skillStoreSources: [] as { name: string; url: string; type: string }[],
        tree: [] as any, // 目录结构
        treeSort: { by: 'name', order: 'asc' } as { by: 'name' | 'mtime' | 'size'; order: 'asc' | 'desc' }, // 文件树排序方式
        // 主进程文件树版本号：持久化在 store 使面板重挂载后仍可命中「数据未变」快路径，
        // 避免每次切换都整树回传（海量文件下内存暴涨）；初始 -1 强制首次加载
        treeVersion: -1 as number,
        data: [] as any, // 打开的文件数据
        index: null as any, // 打开的文件序号
        view: [] as any, // 视图
        mainPanel: "主页" as any, // 主面板
        settingsOpen: false as boolean,
        settingsNav: '' as string,
        // 自定义标题（设置页「界面-自定义标题」；非空时顶部标题固定不变，不再随当前面板变化）
        customTitle: '',
        // 界面配置随软件分发：开启后界面配置保存到软件根目录 interface-config.json（便于整机分发），关闭则存 localStorage
        interfaceConfigMode: false,
        // 功能开关：被隐藏的主面板导航按钮 key（设置页「界面-功能开关」控制，App.vue 导航栏据此过滤）
        hiddenNavs: [] as string[],
        // Agent脚手架：启用的脚手架 key（保留字段以兼容旧存档；设置页开关已移除，当前恒定启用全部）
        enabledScaffolds: defaultEnabledScaffoldKeys(),
        // Agent脚手架 当前激活的脚手架 key（App 标题栏下拉 + AgentScaffold 共用；由当前实例的类型同步，保留供旧代码/设置页使用）
        activeScaffold: SCAFFOLDS[0].key as string,
        // Agent脚手架「实例」（多开）：每项 = 一个独立任务实例，关联一个 .task 文件
        scaffoldInstances: [] as ScaffoldInstanceMeta[],
        // 当前激活的实例 id（App 标题栏下拉 + AgentScaffold 导航栏共用）
        activeInstanceId: '' as string,
        kbPathToOpen: null as string | null, // 待加载的知识库(.kb)文件路径（从知识库打开时跳转到知识处理模块）
        taskPathToOpen: null as string | null, // 待加载的脚手架任务(.task)文件路径（打开时跳转 Agent脚手架模块）
        // 「数据画布」独立主面板：关联任务文件路径（空 = 尚未关联；首次进入面板时自动创建占位文件）
        canvasTaskPath: '' as string,
        // 待加载的画布任务文件（双击 .task 时由 openTaskFileByPath 标记，画布面板消费并加载）
        canvasPathToOpen: null as string | null,
        locales: 'zh', // 语言
        TrustedPython: false, // 兼容旧字段（pythonSandbox 三态模式）
        pythonSandbox: 'workspace' as 'safe' | 'workspace' | 'trusted', // Python 执行沙箱模式（借鉴 Codex sandbox_mode）：safe=只读 / workspace=工作区写入 / trusted=完全访问
        mcpServers: [] as McpServerConfig[], // MCP 服务配置（设置页管理，localStorage 持久化）
        // 联网搜索源配置（设置页「工具 → 搜索」管理；默认 Bing 免 Key；localStorage 持久化并下发给主进程）
        webSearch: normalizeWebSearchConfig(null) as WebSearchConfig,
        // 局域网协同文件编辑配置（设置页「基础-协作」管理，localStorage 持久化）
        collab: {
            enabled: false, // 主开关：关闭时编辑器状态栏不显示协同图标
            port: 3346, // WebSocket 协同服务端口（与 LAN 静态共享 3345 分离）
            maxMembers: 10, // 房间最大成员数（2~20）
            permissionMode: 'open' as 'open' | 'approve' | 'readonly', // 编辑权限：open=开放 / approve=请求-批准 / readonly=只读
            token: '', // 房间 Token（分享时为空则自动生成并回填）
            autoSaveSeconds: 30, // 宿主自动写盘间隔（秒）
            nickname: '', // 客户端名称（连接/加入时展示给其他成员）
        },
        // 远程文件共享服务配置（主机，设置页「协作」管理）
        remoteFs: {
            enabled: false, // 是否开启共享文件夹
            port: 3347, // HTTP 只读文件服务端口
            rootDir: '', // 共享根目录
            token: '', // 访问凭据
        },
        // 局域网共享知识库目录（主机，设置页「协作→局域网共享」配置；
        // 远端网页端在 home 知识库模式可从该目录选择现有 .kb 或上传自己的）
        lan: {
            kbDir: '', // 供局域网网页端列出/读取 .kb 的共享目录
        },
        // 远程工作区（客户端，文件树下方分区显示）
        remoteRoots: [] as import('@/types/collab').RemoteRoot[],
        UI: {
            // 主题名必须与 THEMES 表键完全一致（多一个「色」就会让下拉框选不中、丢失当前主题）
            theme: '浅蓝',
            backgroundColor: "#ffffff",
            borderColor: "#d0d7de",
            menuColor: "#f6f8fa",
            menuActiveColor: "#9ec4f0",
            fontColor: "#1f2328",
            fontActiveColor: "#03254d",
            layout: 'horizontal',
            windowZoom: 100, // 窗口缩放比例（百分比，50~200；由主进程 window-zoom.json 持久化）
            navLayout: 'top' as 'top' | 'left' | 'bottom', // 导航栏布局：top=顶部（默认）/ left=左侧 / bottom=下方
            fileOpenMode: 'window' as 'window' | 'inner', // 文件操作：双击打开方式（window=新窗口打开/默认, inner=窗口内打开）
            closeToTray: false, // 关闭按钮行为：false=直接退出（默认）/ true=折叠到托管区（托盘，后台任务继续运行）
            // ↑ 主进程是唯一事实源（userData/app-behavior.json，见 electron/main/tray-service.ts），
            //   这里仅镜像一份供界面显示与关闭提醒判定，设置页改动经 IPC 下发主进程落盘
            browserHomeUrl: '', // 浏览器 Agent 默认首页（仅手动打开浏览器时首个标签加载）
            browserSaveDir: '', // 浏览器保存文件夹（离线保存网页 + 收藏书签落盘目录；留空=当前工作区根目录）
            wordExportStylePath: '', // Word 导出样式文件（.docx，可选；留空则用内置默认样式）
            wordExportTemplate: 'gongwen', // Word 导出模板：gongwen=公文(GB/T 9704-2012)/cn=中文论文/en=英文论文(APA)/custom=自定义 .docx
        }, // 主题颜色
        AIconfig: {
            // 大模型配置
            llm: {
                // 支持的模型类型
                // 单来源键列表：DeepSeek 只有一个来源，接口样式由 deepseek.api_style 决定（历史 'deepseek-responses' 已合并）
                types: ['ollama', 'lmstudio', 'openai', 'deepseek', 'gpustack', 'anthropic', 'google', 'azure', 'custom'],
                type: 'ollama', // 当前使用的类型
                // Ollama 配置
                ollama: {
                    model_url: 'http://127.0.0.1:11434',
                    model: '',
                    embed_model: '', // 默认嵌入模型（知识库向量化用）
                    available_models: [] as any[],
                },
                // LM Studio 配置 (兼容 OpenAI API)
                lmstudio: {
                    base_url: 'http://localhost:1234', // LM Studio 默认地址
                    model: '',
                    embed_model: '', // 默认嵌入模型（知识库向量化用）
                    available_models: [] as string[],
                    api_key: '', // 可选，LM Studio 默认不需要
                    apiKeyRef: '', // 凭据引用（路线图 2.3）：优先于 api_key
                },
                // OpenAI 兼容 API 配置 (包括 DeepSeek, OpenAI, 其他兼容API)
                openai: {
                    api_key: '',
                    base_url: 'https://api.openai.com/v1', // OpenAI 默认地址
                    model: 'gpt-4o-mini', // 默认模型
                    embed_model: '', // 默认嵌入模型（如 text-embedding-3-small）
                    available_models: [] as string[], // 可用的模型列表
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                },

                // DeepSeek 独立配置（与 OpenAI 分开，避免互相影响）
                deepseek: {
                    api_key: '',
                    base_url: 'https://api.deepseek.com', // DeepSeek 默认地址
                    api_style: 'chat' as 'chat' | 'responses', // 接口样式：chat=Chat Completions（默认）/ responses=Responses API
                    model: 'deepseek-flash', // 默认模型（官方模型名：deepseek-flash / deepseek-v4-pro）
                    embed_model: '', // 默认嵌入模型（DeepSeek 无官方嵌入 API，可填兼容网关的嵌入模型）
                    available_models: [] as string[], // 可用的模型列表
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                },
                
                // DeepSeek Responses API 配置（OpenAI Responses 格式；联网搜索由本地 web_search 工具承担）
                deepseekResponses: {
                    api_key: '',
                    base_url: 'https://api.deepseek.com',
                    model: 'deepseek-flash', // 官方模型名：deepseek-flash / deepseek-v4-pro
                    embed_model: '', // 默认嵌入模型（Responses 无嵌入接口，可留空）
                    available_models: [] as string[], // 可用的模型列表
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                },

                // GPUStack 配置（内置来源，自托管推理服务平台；OpenAI 兼容端点默认在 /v1-openai 前缀下）
                gpustack: {
                    base_url: 'http://localhost', // GPUStack 服务地址（填裸地址即可，请求自动补 /v1-openai）
                    api_key: '',
                    model: '',
                    embed_model: '', // 默认嵌入模型（GPUStack 部署了嵌入模型时填写）
                    available_models: [] as string[],
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                },
                
                // Anthropic Claude 配置
                anthropic: {
                    api_key: '',
                    model: 'claude-3-haiku-20240307',
                    api_version: '2023-06-01',
                    embed_model: '', // 默认嵌入模型（Anthropic 无嵌入接口，可留空）
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                    available_models: [] as string[],
                },
                
                // Google Gemini 配置
                google: {
                    api_key: '',
                    model: 'gemini-pro',
                    embed_model: '', // 默认嵌入模型（如 text-embedding-004）
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                    available_models: [] as string[],
                },
                
                // Azure OpenAI 配置
                azure: {
                    api_key: '',
                    endpoint: '',
                    deployment: '',
                    embed_model: '', // 默认嵌入部署名（知识库向量化用）
                    api_version: '2024-02-15-preview',
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                    available_models: [] as string[],
                },
                
                // 自定义API配置（支持多个自定义来源：sources 列表 + activeIndex 当前激活；扁平字段始终为当前来源）
                custom: {
                    name: 'Custom', // 当前来源显示名（可重命名）
                    api_url: '',
                    api_key: '',
                    model: '',
                    embed_model: '', // 默认嵌入模型（自定义端点支持嵌入时填写）
                    headers: {} as Record<string, string>,
                    request_body: {} as any, // 自定义请求体
                    apiKeyRef: '', // 凭据引用（路线图 2.3）
                    available_models: [] as string[], // 从 api_url 推导 /models 拉取
                    sources: [{ // 所有自定义来源
                        id: 1,
                        name: 'Custom',
                        api_url: '',
                        api_key: '',
                        apiKeyRef: '',
                        model: '',
                        embed_model: '',
                        available_models: [] as string[],
                    }],
                    activeIndex: 0, // 当前激活的来源索引
                },
                
                // 通用配置
                online: false,
                temperature: 0.7,
                max_tokens: 16000,
                // 上下文窗口上限（历史全局值；已被来源级 contextWindowByProvider 取代，
                // 旧存档里可能非 0，由 migrateLegacyContextWindow 一次性下沉到来源级后清零）
                contextWindow: 0,
                // 上下文窗口上限——来源级手填覆盖（key = llmType；自定义来源为 'custom:<激活索引>'）
                // 0/缺省 = 自动：后端真实值 > 模型名关键字 > 来源默认值 > 未知兜底（见 src/lib/contextUsage.ts）
                contextWindowByProvider: {} as Record<string, number>,
                // 自动读取到的模型真实上下文窗口（tokens），0=未读取/不可得；仅作展示参考，
                // 圆环分母改由 src/lib/contextUsage.ts 的按「来源+模型」缓存提供
                contextWindowReal: 0,
                // 上次实际读到的已加载窗口（键 = '来源/模型'，如 'ollama/qwen3.8:latest'）。
                // Ollama 手动设置的上下文长度只体现在已加载实例的 /api/ps 上，模型卸载后读不到，
                // 因此持久化记住，供下次启动（尚未加载时）继续用作圆环分母。
                contextWindowProbed: {} as Record<string, number>,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0,
                stream: true,
                // 推理强度：'none' 关闭思考 / low / medium / high / max（统一档位，按后端能力映射下发）
                // - DeepSeek（chat + responses）：none/low/high/max；Ollama：low/medium/high；LM Studio：reasoning_effort
                // - 其它 OpenAI 兼容后端：chat_template_kwargs.enable_thinking
                think: 'none' as 'none' | 'low' | 'medium' | 'high' | 'max',
                // 嵌入兜底：当前来源不提供嵌入接口（DeepSeek / Anthropic 等）时，向量化改用该来源
                // llmType='' 表示不兜底；model 留空 = 用该来源自己的「默认嵌入模型」
                embeddingFallback: {
                    llmType: 'ollama' as string,
                    customSourceId: null as number | null, // llmType==='custom' 时指定用哪个自定义来源（null=当前激活来源）
                    model: '',
                },
                // 远端自托管后端（内网/公网 LM Studio / Ollama / custom）单后端在途流式请求上限（1~50，默认 2）
                remoteMaxInflight: 2,
            },
            
            // TTS配置 - 添加Qwen3-TTS类型
            tts: {
                type: '本地' as '本地' | 'indexTTS2' | 'Qwen3-TTS' | 'Kokoro' | 'Piper',
                url: 'http://localhost:9880/',
                voice: '四川方言', // 默认使用四川方言
                language: 'zh',
                audio: null as HTMLAudioElement | null,
                rate: 1.0,
                pitch: 1.0,
                emo: '正常',
                weight: 0.5,
                // Qwen3-TTS特定配置
                qwen3: {
                    available_voices: [] as string[], // 可用声音列表
                    connected: false, // 连接状态
                    speed: 1.0, // 语速
                    pitch: 1.0, // 音调
                    voices_url: 'http://localhost:7862/gradio_api/call/update_voices', // 刷新音色API地址
                },
                // 本地 ONNX TTS（Kokoro / Piper）配置
                onnx: {
                    modelDir: '', // 模型目录（解压后的文件夹路径）
                    lang: 'en', // Kokoro 语言：en(中英混合，推荐)/zh(仅中文)
                    sid: 0, // 说话人 ID
                    speed: 1.0, // 语速
                    modelLoaded: false, // 模型是否已加载
                    loading: false, // 是否加载中
                    error: '', // 最近一次错误
                    sampleRate: 0, // 模型采样率
                    numSpeakers: 0, // 说话人数
                },
            },
            
            // ASR（语音识别）配置
            asr: {
                type: 'onnx-whisper' as 'whisper-api' | 'whisper-local' | 'onnx-whisper' | 'qwen3-asr' | 'funasr-online',
                language: 'zh-CN',
                continuous: false,
                autoSend: false,
                // 标点校验模式（全局，对所有识别引擎生效）：none=无 / local=本地ct-punc / llm=大模型
                punctMode: 'none' as 'none' | 'local' | 'llm',
                puncDir: '', // 本地标点模型目录（ct-punc onnx 目录；punctMode=local 时使用）
                shortcut: 'Ctrl+Shift+Space',
                // Whisper API 配置（OpenAI 兼容）
                whisper: {
                    url: 'https://api.openai.com/v1/audio/transcriptions',
                    api_key: '',
                    model: 'whisper-1',
                },
                // Qwen3-ASR 配置（Gradio 网页服务 /run 或 OpenAI 兼容端点：本地 vLLM / Docker / 云端）
                qwen3: {
                    url: 'http://127.0.0.1:7867',
                    // 接口协议：auto=按地址自动判断（.../audio/transcriptions → OpenAI 兼容，否则 Gradio）
                    protocol: 'auto' as 'auto' | 'gradio' | 'openai',
                    api_key: '',
                    model: 'Qwen/Qwen3-ASR-1.7B',
                    // Gradio（Qwen3-ASR 网页服务，API 名 /run）参数
                    langDisp: '自动识别', // 语种选择
                    returnTs: true, // 开启单词级时间戳
                    splitPunc: true, // 跟随结果文本标点断句
                    diarize: false, // 开启说话人角色识别
                    maxChars: 40, // 单行最大字符数
                    // 识别方式：whole=整段（松手后一次识别）/ segment=流式（VAD 分段准实时，边说边出）
                    mode: 'segment' as 'whole' | 'segment',
                    silenceMs: 800, // 停顿多久切段（毫秒）
                    overlapMs: 300, // 切点重叠，避免切在字中间丢音（毫秒）
                    maxSegmentMs: 15000, // 单段最长（毫秒，上限 180000 = 3 分钟）
                },
                // ONNX Whisper 本地配置
                onnx: {
                    modelPath: '', // ONNX 模型文件路径
                    modelLoaded: false,
                    loading: false,
                    loadProgress: 0,
                    provider: 'wasm', // wasm / webgl
                    useLocalWasm: false, // true=本地WASM文件, false=CDN
                    availableModels: [] as Array<{
                        name: string;
                        path: string;
                        size: string;
                    }>,
                },
                // FunASR 流式 Paraformer（官方 online）本地配置
                funasr: {
                    dir: '', // 模型目录（含 model_quant.onnx/decoder_quant.onnx/config.yaml/am.mvn/tokens.json）
                    refineModel: '', // 可选：离线单文件 onnx（如 sensevoice-small），松开时对整句“两遍精修”；空=不精修
                    vad: true, // 能量 VAD 自动断句（说话停顿自动出句并继续听）
                    punctMin: 60, // 批处理标点阈值（字，punctMode=llm 时）：原文先实时出，攒够此字数再大模型一次性补标点整体替换；0=关闭批处理(逐句)
                },
                // 可用的语音识别引擎列表
                availableEngines: [] as string[],
            },
        },

        // 各模型来源的连接状态（模型设置页左侧列表；持久化，切换模块不丢失）
        llmSourceStatus: {} as Record<string, 'online' | 'offline' | 'untested'>,
        // 被禁用的模型来源（设置页左侧开关；内置=type key，自定义=`custom:<id>`；持久化）
        llmDisabledSources: [] as string[],
        // 各自定义来源的连接状态（按 source id；设置页左侧列表展示；持久化）
        llmCustomSourceStatus: {} as Record<number, 'online' | 'offline' | 'untested'>,
        
        // TTS管理器实例
        ttsManager: null as TTSManager | null,
        
        // 多模态支持：存储图片数据
        imageAttachments: [] as Array<{
            id: string;
            data: string | Uint8Array | ArrayBuffer;
            type: string;
            name?: string;
        }>,

        // 地图配置
        mapConfig: {
            tileProvider: 'offline', // 默认使用离线地图
            tileProviders: {
                // 离线地图（默认）：散文件瓦片已移除，离线底图由内置 MBTiles 包提供（见 map-tiles / view_map）
                offline: {
                    name: '离线地图',
                    url: '',
                    attribution: '',
                    minZoom: 4,
                    maxZoom: 10,
                    maxNativeZoom: 7,
                },
                gaode: {
                    name: '高德地图',
                    url: 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
                    attribution: '&copy; 高德地图',
                    minZoom: 2,
                    maxZoom: 18,
                },
                gaode_satellite: {
                    name: '高德卫星',
                    url: 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
                    attribution: '&copy; 高德地图',
                    minZoom: 2,
                    maxZoom: 18,
                },
                arcgis: {
                    name: 'ArcGIS',
                    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
                    attribution: '&copy; Esri',
                    minZoom: 2,
                    maxZoom: 18,
                },
                openstreetmap_cn: {
                    name: 'OSM 中文标注',
                    url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    minZoom: 2,
                    maxZoom: 19,
                },
            } as Record<string, { name: string; url: string; attribution: string; minZoom: number; maxZoom: number; maxNativeZoom?: number }>,
        },

        /** Agent 模板（完整配置，可在 agent-card-header 选择应用） */
        agentPresets: [] as Array<{
            id: string
            name: string
            /** 预设标签（用于预设面板 / 集群配置面板按名称和标签搜索） */
            tags: string[]
            llmType: string
            model: string
            systemPrompt: string
            temperature: number
            selectedSkills: string[]
            kbTopK?: number
            loopPromptMode?: 'auto' | 'sections'
            loopSections?: Array<{ id: string; title: string; text: string }>
            /** 预设自带的循环轮数（单 turn 最大 step 数；唯一例外，未配置时回退 store.generalAgentMaxSteps） */
            maxSteps?: number
            capabilities: {
                readFiles: boolean
                executeCode: boolean
                webSearch: boolean
                accessKnowledgeBase: boolean
                browseWebsites: boolean
                writeFiles: boolean
                listDirs: boolean
                runShell: boolean
                runSubagent: boolean
                skills: boolean
                  askUser: boolean
                  updatePlan: boolean
                  updateTodo: boolean
                  mcpAccess: boolean
                  mcpServerIds?: string[]
                  mcpEquipmentIds?: string[]
                knowledgeBaseFiles: string[]
            }
        }>,
        /**
         * 通用智能体（未绑定预设时的默认入口）单个回合最大步数 / 循环轮数。
         * **循环轮数的唯一数据源**：除智能体预设自带的 preset.maxSteps 外，所有执行入口都读这里
         * （默认 500，范围 1-1000；见 src/shared/agent-loop-rounds.ts）。
         */
        generalAgentMaxSteps: DEFAULT_AGENT_MAX_STEPS,
    };
    // 捕获 AI 配置出厂默认快照（state() 首次执行时尚未被 loadConfig 合并）
    if (!_aiConfigCaptured) {
        DEFAULT_AIconfig = JSON.parse(JSON.stringify(s.AIconfig))
        _aiConfigCaptured = true
    }
    return s
},
    
    // 计算属性
    getters: {
        // 获取当前模型的配置
        currentLLMConfig: (state) => {
            switch(state.AIconfig.llm.type) {
                case 'ollama':
                    return state.AIconfig.llm.ollama;
                case 'lmstudio':
                    return state.AIconfig.llm.lmstudio;
                case 'openai':
                    return state.AIconfig.llm.openai;
                case 'deepseek':
                case 'deepseek-responses':
                    // 单来源：按当前接口样式返回配置（带 api_style，请求层据此选 Chat / Responses）
                    // 注：'deepseek-responses' 仅为历史内存值兜底，配置已在 loadConfig 迁移为单来源
                    return deepSeekConfig(state.AIconfig.llm);
                case 'gpustack':
                    return state.AIconfig.llm.gpustack;
                case 'anthropic':
                    return state.AIconfig.llm.anthropic;
                case 'google':
                    return state.AIconfig.llm.google;
                case 'azure':
                    return state.AIconfig.llm.azure;
                case 'custom':
                    return (() => {
                        // 自定义来源：返回激活来源 sources[activeIndex] 与扁平字段合并的配置（来源数组为权威）
                        const c = state.AIconfig.llm.custom
                        const srcs = Array.isArray(c.sources) ? c.sources : []
                        const idx = (typeof c.activeIndex === 'number' && c.activeIndex >= 0 && c.activeIndex < srcs.length) ? c.activeIndex : 0
                        const src = srcs[idx]
                        if (!src) return c
                        return {
                            ...c,
                            ...src,
                            available_models: Array.isArray(src.available_models) && src.available_models.length
                                ? src.available_models
                                : (Array.isArray(c.available_models) ? c.available_models : []),
                        }
                    })()
                default:
                    return state.AIconfig.llm.ollama;
            }
        },
        
        // 检查是否有API密钥（内联 api_key 或凭据引用 apiKeyRef 任一即可）
        hasAPIKey: (state) => {
            const config = state.AIconfig.llm;
            const hasKey = (c: any) => !!(c?.api_key || c?.apiKeyRef);
            switch(config.type) {
                case 'ollama':
                    return true;
                case 'lmstudio':
                    return true;
                case 'openai':
                    return hasKey(config.openai);
                case 'deepseek':
                case 'deepseek-responses':
                    return hasKey(deepSeekConfig(config));
                case 'gpustack':
                    // GPUStack 为自托管服务：本地部署允许无密钥（与 ollama / lmstudio 一致）
                    return true;
                case 'anthropic':
                    return hasKey(config.anthropic);
                case 'google':
                    return hasKey(config.google);
                case 'azure':
                    return hasKey(config.azure);
                case 'custom':
                    return hasKey(config.custom);
                default:
                    return true;
            }
        },
        
        // 启用的模型来源类型列表（过滤掉被禁用的内置来源；custom 是否保留由 UI 层用 hasEnabledCustomSource 判断）
        enabledLlmTypes: (state) => {
            // 归一：历史存档里的 'deepseek-responses' 会合并进 'deepseek'（不再出现第二个 DeepSeek 来源）
            const all: string[] = normalizeLlmTypeList(
                state.AIconfig?.llm?.types || ['ollama', 'lmstudio', 'openai', 'deepseek', 'gpustack', 'anthropic', 'google', 'azure', 'custom']
            )
            const disabled = normalizeLlmTypeList(state.llmDisabledSources)
            return all.filter((t: string) => !disabled.includes(t))
        },
        
        // 获取当前模型的API端点
        currentAPIEndpoint: (state) => {
            const config = state.AIconfig.llm;
            switch(config.type) {
                case 'ollama':
                    return `${config.ollama.model_url}/api/chat`;
                case 'lmstudio':
                    return `${config.lmstudio.base_url}/v1/chat/completions`;
                case 'openai':
                    return `${config.openai.base_url}/v1/chat/completions`;
                case 'deepseek':
                case 'deepseek-responses': {
                    const ds = deepSeekConfig(config);
                    return ds.api_style === 'responses'
                        ? `${ds.base_url}/responses`
                        : `${ds.base_url}/v1/chat/completions`;
                }
                case 'gpustack':
                    // GPUStack：裸地址自动补 /v1-openai/chat/completions（与自定义来源同一推导规则）
                    return AIUtils.buildCustomChatEndpoint(config.gpustack.base_url);
                case 'anthropic':
                    return 'https://api.anthropic.com/v1/messages';
                case 'google':
                    return `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent`;
                case 'azure':
                    return `${config.azure.endpoint}/openai/deployments/${config.azure.deployment}/chat/completions?api-version=${config.azure.api_version}`;
                case 'custom':
                    return config.custom.api_url;
                default:
                    return '';
            }
        },
        
        // 检查TTS是否连接
        isTTSConnected: (state) => {
            const ttsConfig = state.AIconfig.tts;
            if (ttsConfig.type === 'Qwen3-TTS') {
                return ttsConfig.qwen3.connected;
            }
            if (ttsConfig.type === 'Kokoro' || ttsConfig.type === 'Piper') {
                return ttsConfig.onnx?.modelLoaded === true;
            }
            return true; // 本地和indexTTS2默认认为已连接
        },
        
        // 获取TTS类型列表
        ttsTypes: () => {
            return ['本地', 'indexTTS2', 'Qwen3-TTS', 'Kokoro', 'Piper'];
        },
        
        // 获取Qwen3-TTS可用声音列表
        qwen3TTSVoices: (state) => {
            if (state.AIconfig.tts.type === 'Qwen3-TTS') {
                return state.AIconfig.tts.qwen3.available_voices;
            }
            return [];
        },
        
        // 获取图片附件
        imageAttachmentsCount: (state) => {
            return state.imageAttachments.length;
        },
        
        // 所有可用视图列表（统一管理，新增视图只需在此添加）
        // 文件视图的顺序 / 名称见 src/lib/knowFile/fileViews.ts（改那里即可，勿在这里写死）
        viewList: () => {
            return ['文件', '表格', '图谱', '看板', '地图', '日历', '甘特', ...FILE_VIEW_NAMES]
        },
    },
    
    // 方法
    actions: {
        init() {
            // 初始化TTS管理器
            this.ttsManager = createTTSManager(
                this.AIconfig.tts,
                (state:any) => {
                    // 状态变化回调，可以在这里处理TTS状态变化
                }
            );
        },
        
        // 重新缩放
        async resize() {
            await nextTick()
            if (document.createEvent) {
                var event = document.createEvent("HTMLEvents");
                event.initEvent("resize", true, true);
                window.dispatchEvent(event);
            }
        },
        
        // 初始化配置（关闭后自动重启）
        initConfig() {
            localStorage.clear()
            window.ipcRenderer.send('restartApp')
        },
        
        // 恢复默认 AI 配置（仅 AIconfig 相关，不影响聊天记录/工作区等其它设置）
        resetAIconfig() {
            localStorage.removeItem('AIconfig')
            localStorage.removeItem('customLlmSources')
            localStorage.removeItem('llmSourceStatus')
            localStorage.removeItem('llmDisabledSources')
            localStorage.removeItem('llmCustomSourceStatus')
            // 用出厂默认快照重建（深拷贝，避免与快照共享引用后被响应式代理污染）
            this.AIconfig = JSON.parse(JSON.stringify(DEFAULT_AIconfig))
            this.saveConfig()
        },
        
        // 清空全部聊天记录（ai-chats / ai-chats-index），并通知已挂载的主页聊天模块重置内存
        clearAllChats() {
            localStorage.removeItem('ai-chats')
            localStorage.removeItem('ai-chats-index')
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('ai-chats-cleared'))
                // 独立设置窗口场景：通知其它窗口（主窗口）也重置内存，
                // 否则主窗口下一次 saveChats 会把已清空的记录写回去
                try { (window as any).ipcRenderer?.send?.('chats-changed') } catch { /* 忽略 */ }
            }
        },
        
        /**
         * 打开「设置」。
         * - 桌面版：打开独立「设置」子窗口（无系统标题栏，顶栏可拖动）；窗口已存在则聚焦并切换分类。
         * - 浏览器/LAN 模式（无 ipcRenderer）：退回主窗口内浮层（settingsOpen）。
         * nav 为要定位的设置分类 id（如 agentpreset / mcp / tools）。
         */
        openSettings(nav = '') {
            if (nav) this.settingsNav = nav
            if (typeof window !== 'undefined' && (window as any).ipcRenderer?.invoke) {
                try {
                    ;(window as any).ipcRenderer
                        .invoke('open-settings-window', nav ? { nav } : {})
                        .catch((err: any) => {
                            // 主进程未注册该通道（如开发时主进程未重启）时回退到窗口内浮层，并留下日志便于排查
                            console.warn('[openSettings] 打开设置独立窗口失败，回退窗口内浮层:', err)
                            this.settingsOpen = true
                        })
                } catch (e) {
                    this.settingsOpen = true
                }
            } else {
                this.settingsOpen = true
            }
        },

        /**
         * 把搜索源配置推给主进程（web_search 工具按该配置分发搜索源）。
         * 浏览器/LAN 模式无主进程（window.dsh 不可用）时静默跳过；
         * saveConfig 调用频繁，这里按序列化结果去重，仅在配置真变化时下发。
         */
        applyWebSearchToMain() {
            const api = typeof window !== 'undefined' ? (window as any).dsh?.webSearch : null
            if (!api?.setConfig) return
            try {
                const json = JSON.stringify(this.webSearch)
                if (json === lastAppliedWebSearchJson) return
                lastAppliedWebSearchJson = json
                Promise.resolve(api.setConfig(JSON.parse(json))).catch((e: any) => {
                    // 下发失败时清空去重标记，下次 saveConfig 会重试
                    lastAppliedWebSearchJson = ''
                    console.warn('[webSearch] 下发搜索源配置失败:', e)
                })
            } catch (e) {
                console.warn('[webSearch] 下发搜索源配置异常:', e)
            }
        },

        /** 更新搜索源配置（设置页保存触发：合并默认值 + 持久化 + 推送主进程） */
        updateWebSearchConfig(patch: Partial<WebSearchConfig>) {
            this.webSearch = normalizeWebSearchConfig({ ...this.webSearch, ...patch })
            this.saveConfig()
        },

        /**
         * 启用 / 停用某个搜索源（可同时启用多个）。
         * - 启用集合始终按 `order`（列表顺序）重排，即「列表位置 = 尝试顺序 / 优先级」
         * - 停用时至少保留一个源，最后一个不允许关闭（返回 false，由 UI 提示）
         */
        toggleWebSearchProvider(id: string) {
            const order: string[] = Array.isArray(this.webSearch?.order) ? [...this.webSearch.order] : []
            const enabled = new Set<string>(Array.isArray(this.webSearch?.providers) ? this.webSearch.providers : [])
            if (enabled.has(id)) {
                if (enabled.size <= 1) return false
                enabled.delete(id)
            } else {
                enabled.add(id)
            }
            const providers = (order.length ? order : [...enabled]).filter((x) => enabled.has(x))
            this.updateWebSearchConfig({ providers: providers as any })
            return true
        },

        /**
         * 拖动排序：把搜索源移动到列表的 toIndex（影响展示顺序，进而决定回退/聚合的尝试顺序）。
         * 已启用集合按新顺序重排，保证 `providers` 与 `order` 一致。
         */
        reorderWebSearchProvider(id: string, toIndex: number) {
            const order: string[] = Array.isArray(this.webSearch?.order) ? [...this.webSearch.order] : []
            const from = order.indexOf(id)
            if (from < 0) return
            const to = Math.max(0, Math.min(order.length - 1, toIndex))
            if (to === from) return
            order.splice(from, 1)
            order.splice(to, 0, id)
            const enabled = new Set<string>(Array.isArray(this.webSearch?.providers) ? this.webSearch.providers : [])
            this.updateWebSearchConfig({
                order: order as any,
                providers: order.filter((x) => enabled.has(x)) as any,
            })
        },

        /** 重置搜索源配置为出厂默认（Bing 单源 + 依次回退 + 8 条结果 + 清空全部 API Key） */
        resetWebSearchConfig() {
            this.webSearch = normalizeWebSearchConfig(null)
            this.saveConfig()
        },

        /**
         * 新增自定义（内网）搜索源：写入 `customs`，并把 `cs:<id>` 追加到列表末尾并默认启用。
         * 返回新源 id（设置页据此选中它进行配置）。
         */
        addWebSearchCustomSource(name?: string, kind?: 'searxng' | 'json') {
            const cs = newWebSearchCustomSource(name, kind)
            const pid = toCustomProviderId(cs.id)
            this.updateWebSearchConfig({
                customs: [...(this.webSearch?.customs || []), cs],
                order: [...(this.webSearch?.order || []), pid],
                providers: [...(this.webSearch?.providers || []), pid],
            })
            return cs.id
        },

        /** 更新自定义搜索源配置（名称 / 类型 / 地址 / 请求头 / 字段映射等；改完立即下发主进程） */
        updateWebSearchCustomSource(id: string, patch: Partial<WebSearchCustomSource>) {
            const customs = (this.webSearch?.customs || []).map((s) => (s.id === id ? { ...s, ...patch } : s))
            this.updateWebSearchConfig({ customs })
        },

        /** 删除自定义搜索源（同时从 order / providers 移除；清空后回退到默认 Bing，保证至少一个源） */
        removeWebSearchCustomSource(id: string) {
            const pid = toCustomProviderId(id)
            const customs = (this.webSearch?.customs || []).filter((s) => s.id !== id)
            const order = (this.webSearch?.order || []).filter((x) => x !== pid)
            const providers = (this.webSearch?.providers || []).filter((x) => x !== pid)
            this.updateWebSearchConfig({
                customs,
                order,
                providers: providers.length ? providers : ['bing'],
            })
        },

        // 储存配置信息
        saveConfig() {
            // 诊断：llm.type 变更时打印调用栈，便于定位「重启后来源被改成 ollama」的写入点
            try {
                const savedRaw = localStorage.getItem('AIconfig')
                const prevType = savedRaw ? (JSON.parse(savedRaw)?.llm?.type) : 'none'
                const curType = this.AIconfig?.llm?.type
                if (curType !== prevType) {
                    console.warn(`[AIconfig] llm.type 变更: ${prevType} → ${curType}\n` + new Error().stack)
                }
            } catch { /* 诊断日志，忽略解析错误 */ }
            localStorage.setItem('root', JSON.stringify(this.root))
            localStorage.setItem('roots', JSON.stringify(this.roots))
            localStorage.setItem('path', JSON.stringify(this.path))
            localStorage.setItem('skillsPath', JSON.stringify(this.skillsPath))
            localStorage.setItem('workflowPath', JSON.stringify(this.workflowPath))
            localStorage.setItem('agentTools', JSON.stringify(this.agentTools))
            localStorage.setItem('disabledSkills', JSON.stringify(this.disabledSkills))
            localStorage.setItem('skillStoreSources', JSON.stringify(this.skillStoreSources))
            // 独立窗口不持久化标签（见 persistTabs），避免污染主窗口标签栏
            if (persistTabs) {
                localStorage.setItem('data', JSON.stringify(this.data))
                localStorage.setItem('index', JSON.stringify(this.index))
            }
            localStorage.setItem('view', JSON.stringify(this.view))
            localStorage.setItem('treeSort', JSON.stringify(this.treeSort))
            // mainPanel 只在主窗口有意义：独立窗口写入会覆盖主窗口当前面板（见 persistMainPanel 注释）
            if (persistMainPanel) localStorage.setItem('mainPanel', JSON.stringify(this.mainPanel))
            localStorage.setItem('hiddenNavs', JSON.stringify(this.hiddenNavs))
            localStorage.setItem('customTitle', JSON.stringify(this.customTitle))
            localStorage.setItem('interfaceConfigMode', JSON.stringify(this.interfaceConfigMode))
            localStorage.setItem('enabledScaffolds', JSON.stringify(this.enabledScaffolds))
            localStorage.setItem('scaffoldInstances', JSON.stringify(this.scaffoldInstances))
            localStorage.setItem('activeInstanceId', JSON.stringify(this.activeInstanceId))
            localStorage.setItem('canvasTaskPath', JSON.stringify(this.canvasTaskPath))
            localStorage.setItem('locales', JSON.stringify(this.locales))
            localStorage.setItem('AIconfig', JSON.stringify(this.AIconfig))
            // 自定义来源独立双写存档：与 AIconfig 保持一致；即使 AIconfig 合并异常也能从独立键恢复
            try {
                const cc = this.AIconfig?.llm?.custom
                localStorage.setItem('customLlmSources', JSON.stringify({
                    sources: Array.isArray(cc?.sources) ? cc.sources : [],
                    activeIndex: typeof cc?.activeIndex === 'number' ? cc.activeIndex : 0,
                    name: cc?.name || '',
                    api_url: cc?.api_url || '',
                    api_key: cc?.api_key || '',
                    apiKeyRef: cc?.apiKeyRef || '',
                    model: cc?.model || '',
                    embed_model: cc?.embed_model || '',
                    available_models: Array.isArray(cc?.available_models) ? cc.available_models : [],
                }))
            } catch (e) { /* 独立存档写入失败不影响主存档 */ }
            localStorage.setItem('llmSourceStatus', JSON.stringify(this.llmSourceStatus))
            localStorage.setItem('llmDisabledSources', JSON.stringify(this.llmDisabledSources))
            localStorage.setItem('llmCustomSourceStatus', JSON.stringify(this.llmCustomSourceStatus))
            localStorage.setItem('UI', JSON.stringify(this.UI))
            localStorage.setItem('mapConfig', JSON.stringify(this.mapConfig))
            // 注意：装备/类型数据已迁移至 SwarmPlanner，不再在此管理
            localStorage.setItem('agentPresets', JSON.stringify(this.agentPresets))
            localStorage.setItem('generalAgentMaxSteps', JSON.stringify(this.generalAgentMaxSteps))
            localStorage.setItem('mcpServers', JSON.stringify(this.mcpServers))
            // 联网搜索源配置（设置页「工具 → 搜索」；同时推送给主进程供 web_search 工具使用）
            localStorage.setItem('webSearchConfig', JSON.stringify(this.webSearch))
            this.applyWebSearchToMain()
            localStorage.setItem('collab', JSON.stringify(this.collab))
            localStorage.setItem('remoteFs', JSON.stringify(this.remoteFs))
            localStorage.setItem('lan', JSON.stringify(this.lan))
            localStorage.setItem('remoteRoots', JSON.stringify(this.remoteRoots))
            // 界面配置随软件分发：开启时同步写入软件根目录（fire-and-forget，界面配置以该文件为准）
            if (this.interfaceConfigMode && window.dsh?.interfaceConfig) {
                window.dsh.interfaceConfig.save(this.gatherInterfaceConfig()).catch(() => {})
            }
            // UI / 语言变更广播到其它窗口（子窗口/文件窗口等），保证其即时应用（如 Word 导出模板、主题、语言等）
            // 复用 notify-theme-change → theme-changed 通道；接收方 applyThemeFromBroadcast 合并 UI + 语言
            const uiJson = JSON.stringify(this.UI)
            const locale = this.locales
            if (uiJson !== lastBroadcastUiJson || locale !== lastBroadcastLocale) {
                lastBroadcastUiJson = uiJson
                lastBroadcastLocale = locale
                if (typeof window !== 'undefined' && (window as any).ipcRenderer) {
                    try {
                        ;(window as any).ipcRenderer.send('notify-theme-change', { ui: JSON.parse(uiJson), locales: locale })
                    } catch (e) { /* 非 Electron 或序列化失败时忽略 */ }
                }
            }
            // 设置独立窗口写盘：额外广播一次完整配置变更，主窗口据此从 localStorage 重新同步
            // （AI 模型来源/工具开关/MCP/Agent 预设等不在 UI 广播范围内，主窗口内存不会自动更新）
            if (settingsConfigWriter && typeof window !== 'undefined' && (window as any).ipcRenderer) {
                try {
                    ;(window as any).ipcRenderer.send('settings-config-changed', { ui: JSON.parse(uiJson), locales: locale })
                } catch (e) { /* 忽略 */ }
            }
            // 注意：图片附件不保存到localStorage，因为可能很大
        },
        
        // 读取配置信息
        loadConfig() {
            // 延迟落盘标记：loadConfig 里的迁移（如 DeepSeek 单来源合并）会在
            // 读取 llmSourceStatus / llmDisabledSources 之前完成——若此时直接 saveConfig()，
            // 会用内存默认值覆盖这两份存档。统一到最后一次性落盘。
            let needPersist = false
            if (localStorage.getItem('root') !== null) {
                this.root = JSON.parse(localStorage.getItem('root')!)
            }
            if (localStorage.getItem('roots') !== null) {
                const parsed = JSON.parse(localStorage.getItem('roots')!)
                this.roots = Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string' && x) : []
            }
            // 兼容旧版本：仅有单个 root 时迁移为工作区列表
            if ((!this.roots || !this.roots.length) && this.root) {
                this.roots = [this.root]
            }
            // 确保当前 root 属于工作区列表；若不在则取列表第一项
            if (this.roots && this.roots.length && (!this.root || !this.roots.includes(this.root))) {
                this.root = this.roots[0]
                this.path = this.root
            }
            if (localStorage.getItem('path') !== null) {
                this.path = JSON.parse(localStorage.getItem('path')!)
            }
            if (localStorage.getItem('skillsPath') !== null) {
                this.skillsPath = JSON.parse(localStorage.getItem('skillsPath')!)
            }
            if (localStorage.getItem('workflowPath') !== null) {
                this.workflowPath = JSON.parse(localStorage.getItem('workflowPath')!)
            }
            if (localStorage.getItem('agentTools') !== null) {
                const parsedTools = JSON.parse(localStorage.getItem('agentTools')!)
                // 未配置(null)/关闭([])/启用列表 均原样保留；非法值回退 null
                this.agentTools = Array.isArray(parsedTools) ? parsedTools : null
            } else {
                this.agentTools = null
            }
            if (localStorage.getItem('disabledSkills') !== null) {
                const parsed = JSON.parse(localStorage.getItem('disabledSkills')!)
                this.disabledSkills = Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : []
            } else {
                this.disabledSkills = []
            }
            if (localStorage.getItem('skillStoreSources') !== null) {
                const parsedStore = JSON.parse(localStorage.getItem('skillStoreSources')!)
                this.skillStoreSources = Array.isArray(parsedStore) ? parsedStore.filter((x: any) => x && typeof x.url === 'string') : []
            } else {
                this.skillStoreSources = []
            }
            if (localStorage.getItem('data') !== null) {
                this.data = JSON.parse(localStorage.getItem('data')!)
            }
            if (localStorage.getItem('index') !== null) {
                this.index = JSON.parse(localStorage.getItem('index')!)
            }
            if (localStorage.getItem('view') !== null) {
                const parsedView = JSON.parse(localStorage.getItem('view')!)
                // 视图改名兼容：历史配置里的「编辑 / 块编辑 / 导图」归一化为「源码编辑 / 可视编辑 / 思维导图」
                this.view = Array.isArray(parsedView) ? parsedView.map((v: any) => (typeof v === 'string' ? normalizeViewName(v) : v)) : []
            }
            // 默认显示文件视图：无任何激活视图时自动开启「文件」，避免空白欢迎页
            if (!this.view || this.view.length === 0) {
                this.view = ['文件']
            }
            if (localStorage.getItem('treeSort') !== null) {
                this.treeSort = JSON.parse(localStorage.getItem('treeSort')!)
            }
            if (localStorage.getItem('mainPanel') !== null) {
                this.mainPanel = JSON.parse(localStorage.getItem('mainPanel')!)
                // 旧版模块名迁移：灵感管理 → 待办管理；Agent CLI → Agent脚手架（2026-09 改名）
                if (this.mainPanel === '灵感管理') this.mainPanel = '待办管理'
                if (this.mainPanel === 'Agent CLI') this.mainPanel = 'Agent脚手架'
            }
            // 功能开关：被隐藏的主面板导航按钮（旧存档无此 key 时兜底为空数组，全部显示）
            if (localStorage.getItem('hiddenNavs') !== null) {
                const parsedNavs = JSON.parse(localStorage.getItem('hiddenNavs')!)
                this.hiddenNavs = this.migrateNavKeys(parsedNavs)
            } else {
                this.hiddenNavs = []
            }
            // 自定义标题：界面设置定义后固定不变（无存档时为空）
            if (localStorage.getItem('customTitle') !== null) {
                const parsedTitle = JSON.parse(localStorage.getItem('customTitle')!)
                this.customTitle = typeof parsedTitle === 'string' ? parsedTitle : ''
            } else {
                this.customTitle = ''
            }
            // 界面配置随软件分发开关（默认关闭；开启后界面配置以根目录文件为准，由 loadRemoteInterfaceConfig 应用）
            if (localStorage.getItem('interfaceConfigMode') !== null) {
                this.interfaceConfigMode = JSON.parse(localStorage.getItem('interfaceConfigMode')!) === true
            } else {
                this.interfaceConfigMode = false
            }
            // Agent脚手架：启用的脚手架 key（过滤非法值；至少保留一个，兜底为全部）
            if (localStorage.getItem('enabledScaffolds') !== null) {
                const parsedScaffolds = JSON.parse(localStorage.getItem('enabledScaffolds')!)
                this.enabledScaffolds = Array.isArray(parsedScaffolds)
                    ? parsedScaffolds.filter((k: any) => SCAFFOLDS.some(s => s.key === k))
                    : defaultEnabledScaffoldKeys()
            } else {
                this.enabledScaffolds = defaultEnabledScaffoldKeys()
            }
            if (!this.enabledScaffolds.length) this.enabledScaffolds = [SCAFFOLDS[0].key]
            // 「数据画布」独立主面板：关联任务文件路径（旧存档无此 key → 由下方画布迁移从旧 canvas 实例接管）
            if (localStorage.getItem('canvasTaskPath') !== null) {
                const parsedCanvasPath = JSON.parse(localStorage.getItem('canvasTaskPath')!)
                this.canvasTaskPath = typeof parsedCanvasPath === 'string' ? parsedCanvasPath : ''
            }
            // Agent脚手架实例（多开）：从 localStorage 恢复；首次启动（无存档）时由 ensureInstances 按启用脚手架建成单实例
            if (localStorage.getItem('scaffoldInstances') !== null) {
                const parsedInstances = JSON.parse(localStorage.getItem('scaffoldInstances')!)
                const rawInstances = Array.isArray(parsedInstances) ? parsedInstances : []
                // 画布迁移：在过滤掉旧 canvas 实例（已不在 SCAFFOLDS 中）之前，先接管其关联任务文件
                this.migrateCanvasPanelState(rawInstances)
                this.scaffoldInstances = rawInstances
                    .filter((it: any) => it && typeof it.id === 'string' && SCAFFOLDS.some(s => s.key === it.type))
                    .map((it: any) => ({
                        id: String(it.id),
                        type: String(it.type),
                        title: String(it.title || ''),
                        filePath: String(it.filePath || ''),
                        titleManual: it.titleManual === true,
                        fileMissing: it.fileMissing === true,
                        createdAt: Number(it.createdAt) || Date.now(),
                        lastActiveAt: Number(it.lastActiveAt) || Number(it.createdAt) || Date.now(),
                    }))
            }
            if (localStorage.getItem('activeInstanceId') !== null) {
                const parsedActive = JSON.parse(localStorage.getItem('activeInstanceId')!)
                this.activeInstanceId = typeof parsedActive === 'string' ? parsedActive : ''
            }
            // 当前激活脚手架不在启用列表中时（如只启用了一个脚手架后重启），
            // 校正到第一个启用的脚手架，避免首次打开 Agent脚手架时仍显示已下线的脚手架
            if (this.enabledScaffolds.indexOf(this.activeScaffold) === -1) {
                this.activeScaffold = this.firstEnabledScaffold()
            }
            // 升级迁移：把新加入的脚手架一次性补进老存档（启用列表 + 补一个实例；用户手动关闭后不会恢复）
            this.migrateScaffoldDefaults()
            this.ensureInstances()
            this.migrateScaffoldTitles()
            if (localStorage.getItem('locales') !== null) {
                this.locales = JSON.parse(localStorage.getItem('locales')!)
            }
            if (localStorage.getItem('AIconfig') !== null) {
                // 保存当前选中的模型，避免被覆盖
                const savedConfig = JSON.parse(localStorage.getItem('AIconfig')!)
                
                // 如果是Ollama配置，先保存选中的模型
                if (savedConfig.llm.type === 'ollama' && savedConfig.llm.ollama.model) {
                    savedConfig.llm.ollama.model = savedConfig.llm.ollama.model;
                }
                
                // 合并默认配置，确保新增的属性（如 asr）在旧配置中也有值
                this.AIconfig = {
                    ...this.AIconfig,
                    ...savedConfig,
                    llm: { ...this.AIconfig.llm, ...savedConfig.llm },
                    tts: { ...this.AIconfig.tts, ...savedConfig.tts },
                    asr: savedConfig.asr ? { ...this.AIconfig.asr, ...savedConfig.asr } : this.AIconfig.asr,
                }

                // 诊断：确认 loadConfig 后内存里的来源类型（排查「重启后回退 ollama」）
                console.warn('[AIconfig] loadConfig 完成，内存 llm.type =', this.AIconfig?.llm?.type,
                    '（存档 llm.type =', savedConfig?.llm?.type, '）')

                // 迁移（标点校验全局化）：旧版本 useLLMPunctuation 布尔 + funasr.puncDir 子配置
                // → 新版本 asr.punctMode（'none'|'local'|'llm'）全局 + asr.puncDir 全局目录
                {
                    const oldAsr: any = savedConfig?.asr || {}
                    const asrNow: any = this.AIconfig.asr
                    if (!asrNow) { /* noop */ } else {
                        const oldLLM = oldAsr.useLLMPunctuation === true
                        const oldFunPunc = typeof oldAsr.funasr?.puncDir === 'string' && oldAsr.funasr.puncDir
                        // 旧版本没有显式 punctMode（新默认是 'none'）：按旧字段推断并迁移
                        if (oldAsr.punctMode === undefined && (oldLLM || oldFunPunc)) {
                            asrNow.punctMode = oldLLM ? 'llm' : 'local'
                        }
                        if (oldFunPunc && !asrNow.puncDir) asrNow.puncDir = oldFunPunc
                        // 清掉已废弃字段，避免残留
                        delete asrNow.useLLMPunctuation
                        if (asrNow.funasr) delete asrNow.funasr.puncDir
                        // 迁移（Qwen3-ASR 网页服务）：旧存档的 qwen3 无 protocol / Gradio 参数 → 合并默认值
                        // （asr 为浅合并，旧存档会整体覆盖 qwen3 对象，缺字段时按默认补全）
                        if (asrNow.qwen3 && DEFAULT_AIconfig?.asr?.qwen3) {
                            asrNow.qwen3 = { ...DEFAULT_AIconfig.asr.qwen3, ...asrNow.qwen3 }
                        }
                    }
                }

                // 迁移（deepseek 与 openai 拆分）：旧版本 deepseek 配置共用 openai 对象。
                // 若旧数据没有独立 deepseek 字段，且 openai.base_url 指向 DeepSeek（说明用户曾用 deepseek 共用配置），
                // 则把 openai 的值复制到 deepseek，openai 恢复 OpenAI 官方默认——保证两边数据互不污染。
                if (!savedConfig.llm?.deepseek && savedConfig.llm?.openai) {
                    const oldOpenai = savedConfig.llm.openai
                    const isDeepSeekUrl = String(oldOpenai.base_url || '').includes('deepseek.com')
                    if (isDeepSeekUrl) {
                        this.AIconfig.llm.deepseek = {
                            api_key: oldOpenai.api_key || '',
                            base_url: oldOpenai.base_url || 'https://api.deepseek.com',
                            api_style: 'chat',
                            model: oldOpenai.model || 'deepseek-chat',
                            embed_model: oldOpenai.embed_model || '',
                            available_models: oldOpenai.available_models || [],
                            apiKeyRef: oldOpenai.apiKeyRef || '',
                        }
                        // openai 恢复独立默认（避免继续污染）
                        this.AIconfig.llm.openai = {
                            api_key: '',
                            base_url: 'https://api.openai.com/v1',
                            model: 'gpt-4o-mini',
                            embed_model: '',
                            available_models: [],
                            apiKeyRef: '',
                        }
                    }
                }

                // 迁移（推理强度）：旧版本 think 为布尔值 → 新版本统一为档位字符串
                // （'none' 关闭思考 / low / medium / high / max，UI 用「推理强度」下拉）
                if (typeof this.AIconfig.llm.think !== 'string') {
                    this.AIconfig.llm.think = this.AIconfig.llm.think ? 'high' : 'none'
                }
                // 迁移（DeepSeek Responses）：服务端联网搜索已被官方移除（内置 web_search 会被忽略），
                // 清理废弃开关；默认模型改为官方新名 deepseek-flash（旧名 deepseek-v4-flash 已映射同一模型）
                {
                    const dsr: any = this.AIconfig.llm.deepseekResponses
                    if (dsr) {
                        delete dsr.web_search
                        delete dsr.web_search_force
                        if (!dsr.model || dsr.model === 'deepseek-v4-flash') dsr.model = 'deepseek-flash'
                    }
                }

                // 迁移（DeepSeek 单来源）：历史上 DeepSeek 有两个并列来源（deepseek / deepseek-responses），
                // 旧存档的全局类型 llm.type 与来源列表 types 里的该键全部收敛为单一来源 'deepseek'
                // + deepseek.api_style（唯一事实源）；两个配置块的密钥/地址互相补齐，切样式不丢凭据。
                if (migrateDeepSeekMerge(this.AIconfig.llm)) needPersist = true

                // 迁移（多自定义来源）：旧配置无 sources 时从扁平 custom 播种；activeIndex 越界时重置
                const customLlm = this.AIconfig.llm.custom
                if (customLlm && (!Array.isArray(customLlm.sources) || customLlm.sources.length === 0)) {
                    customLlm.sources = [{
                        id: 1,
                        name: customLlm.name || 'Custom',
                        api_url: customLlm.api_url || '',
                        api_key: customLlm.api_key || '',
                        apiKeyRef: customLlm.apiKeyRef || '',
                        model: customLlm.model || '',
                        embed_model: customLlm.embed_model || '',
                        available_models: Array.isArray(customLlm.available_models) ? customLlm.available_models : [],
                    }]
                }
                if (customLlm && (typeof customLlm.activeIndex !== 'number' ||
                    customLlm.activeIndex < 0 || customLlm.activeIndex >= (customLlm.sources || []).length)) {
                    customLlm.activeIndex = 0
                }

                // 自定义来源：优先从独立存档恢复（双写保障，防止 AIconfig 合并异常导致来源丢失/空白）
                try {
                    const rawCustom = localStorage.getItem('customLlmSources')
                    if (rawCustom) {
                        const sc = JSON.parse(rawCustom)
                        const cc = this.AIconfig?.llm?.custom
                        if (cc && Array.isArray(sc?.sources) && sc.sources.length > 0) {
                            cc.sources = sc.sources
                            cc.activeIndex = (typeof sc.activeIndex === 'number' && sc.activeIndex >= 0 && sc.activeIndex < sc.sources.length)
                                ? sc.activeIndex : 0
                            cc.name = sc.name || ''
                            cc.api_url = sc.api_url || ''
                            cc.api_key = sc.api_key || ''
                            cc.apiKeyRef = sc.apiKeyRef || ''
                            cc.model = sc.model || ''
                            cc.embed_model = sc.embed_model || ''
                            cc.available_models = Array.isArray(sc.available_models) ? sc.available_models : []
                        }
                    }
                } catch (e) { /* 独立存档缺失/损坏则回退 AIconfig */ }

                // 扁平字段与激活来源对齐（防止存档里扁平字段被临时值污染，导致设置页显示空白/旧模型）
                try { this.applyCustomSourceIndex() } catch (e) { /* 忽略 */ }

                // 迁移（上下文窗口上限）：历史全局单值 → 按迁移时激活来源下沉为来源级覆盖值。
                // 全局值残留会让切换来源后的圆环分母沿用别的来源（如本地 8192 用到 DeepSeek 上）。
                if (migrateLegacyContextWindow(this.AIconfig.llm)) needPersist = true
            }
            if (localStorage.getItem('UI') !== null) {
                this.UI = JSON.parse(localStorage.getItem('UI')!)
                // 旧存档可能缺少 windowZoom，兜底为 100
                if (typeof this.UI.windowZoom !== 'number' || !isFinite(this.UI.windowZoom)) this.UI.windowZoom = 100
                // 旧存档可能缺少 navLayout，兜底为顶部导航
                if (this.UI.navLayout !== 'top' && this.UI.navLayout !== 'left' && this.UI.navLayout !== 'bottom') this.UI.navLayout = 'top'
                // 旧存档可能缺少 fileOpenMode，兜底为新窗口打开
                if (this.UI.fileOpenMode !== 'window' && this.UI.fileOpenMode !== 'inner') this.UI.fileOpenMode = 'window'
                // 旧存档可能缺少 closeToTray，兜底为直接退出（真实值以主进程 app-behavior.json 为准，启动时握手同步）
                if (typeof this.UI.closeToTray !== 'boolean') this.UI.closeToTray = false
                // 旧存档可能缺少 browserHomeUrl，兜底为空（浏览器 Agent 默认空白页）
                if (typeof this.UI.browserHomeUrl !== 'string') this.UI.browserHomeUrl = ''
                // 旧存档可能缺少 browserSaveDir，兜底为空（浏览器保存到当前工作区根目录）
                if (typeof this.UI.browserSaveDir !== 'string') this.UI.browserSaveDir = ''
                // 旧存档可能缺少 wordExportStylePath，兜底为空（导出用内置默认样式）
                if (typeof this.UI.wordExportStylePath !== 'string') this.UI.wordExportStylePath = ''
                // 旧存档可能缺少 wordExportTemplate，兜底为公文模板
                if (typeof this.UI.wordExportTemplate !== 'string' || ['gongwen', 'cn', 'en', 'custom'].indexOf(this.UI.wordExportTemplate) === -1) this.UI.wordExportTemplate = 'gongwen'
                // 主题名归一化：旧存档里的 '浅蓝色' 等表外名称 → '浅蓝'（否则主题下拉框空白、changeTheme 失效）
                normalizeThemeName(this.UI)
                this.setTheme()
            }
            if (localStorage.getItem('llmSourceStatus') !== null) {
                const parsedStatus = JSON.parse(localStorage.getItem('llmSourceStatus')!)
                const status: Record<string, any> = (parsedStatus && typeof parsedStatus === 'object' && !Array.isArray(parsedStatus)) ? parsedStatus : {}
                // DeepSeek 单来源：历史 'deepseek-responses' 状态合并进 'deepseek'（任一 online 即 online）
                const legacyStatus = status['deepseek-responses']
                if (legacyStatus !== undefined) {
                    if (legacyStatus === 'online' || status['deepseek'] === undefined) {
                        status['deepseek'] = legacyStatus
                    }
                    delete status['deepseek-responses']
                }
                this.llmSourceStatus = status
            }
            if (localStorage.getItem('llmDisabledSources') !== null) {
                const parsedDisabled = JSON.parse(localStorage.getItem('llmDisabledSources')!)
                // DeepSeek 单来源：历史别名 'deepseek-responses' 的禁用标记丢弃——它原本只针对那个
                // 并列来源（用户通常只是不想看到重复条目），合并后若保留会连整个 DeepSeek 来源一起隐藏
                this.llmDisabledSources = normalizeLlmTypeList(
                    (Array.isArray(parsedDisabled) ? parsedDisabled : [])
                        .filter((x: any) => typeof x === 'string' && x !== DEEPSEEK_LEGACY_TYPE)
                )
            }
            if (localStorage.getItem('llmCustomSourceStatus') !== null) {
                const parsedCss = JSON.parse(localStorage.getItem('llmCustomSourceStatus')!)
                this.llmCustomSourceStatus = (parsedCss && typeof parsedCss === 'object' && !Array.isArray(parsedCss)) ? parsedCss : {}
            }
            if (localStorage.getItem('mapConfig') !== null) {
                this.mapConfig = JSON.parse(localStorage.getItem('mapConfig')!)
            }
            // 联网搜索源配置（缺字段/旧存档自动补齐默认值；读完后推送给主进程）
            try {
                const rawSearch = localStorage.getItem('webSearchConfig')
                this.webSearch = normalizeWebSearchConfig(rawSearch ? JSON.parse(rawSearch) : null)
            } catch (e) {
                console.warn('读取搜索源配置失败，回退默认值:', e)
                this.webSearch = normalizeWebSearchConfig(null)
            }
            this.applyWebSearchToMain()
            // 装备/类型数据（unmannedEquipment/movePlans/mapMarkers/装备配置）已迁移至 SwarmPlanner，不再从 localStorage 恢复
            // Agent 预设：优先读新 key 'agentPresets'；旧 key 'contactAgents' 兼容迁移
            const presetsRaw = localStorage.getItem('agentPresets') ?? localStorage.getItem('contactAgents')
            if (presetsRaw !== null) {
                const parsedAgentPresets = JSON.parse(presetsRaw)
                this.agentPresets = Array.isArray(parsedAgentPresets)
                    ? parsedAgentPresets.map((c: any) => {
                        // 旧版「角色」字段合并进系统提示词：角色不再作为独立字段维护
                        if (!c || typeof c !== 'object') return c
                        const role = typeof c?.role === 'string' ? c.role.trim() : ''
                        if (role) {
                            const sp = typeof c.systemPrompt === 'string' ? c.systemPrompt : ''
                            if (!sp.includes(role)) {
                                c.systemPrompt = sp ? `${role}\n\n${sp}` : role
                            }
                        }
                        delete c.role
                        // 单来源迁移：旧预设里的历史别名 'deepseek-responses' → 'deepseek'
                        if (c.llmType) c.llmType = normalizeLlmType(c.llmType)
                        return c
                    })
                    : []
            }
            // 通用智能体循环轮数（唯一数据源；默认 500，范围 1-1000；旧存档无此 key 时兜底默认值）
            if (localStorage.getItem('generalAgentMaxSteps') !== null) {
                const gv = Number(localStorage.getItem('generalAgentMaxSteps'))
                // 旧默认值 20（旧存档里从未改过该值时即为此）迁移到新默认 500，避免默认值形同虚设
                this.generalAgentMaxSteps = normalizeAgentMaxSteps(gv === 20 ? DEFAULT_AGENT_MAX_STEPS : gv)
            }
            if (localStorage.getItem('mcpServers') !== null) {
                this.mcpServers = JSON.parse(localStorage.getItem('mcpServers')!).filter((s: any) => s && s.id !== 'builtin-swarm-control')
            }
            // 内置浏览器 Agent MCP 服务兜底注入（幂等；防旧存档缺失 / 误删后丢失浏览器工具）
            this.ensureBuiltinMcpServer()
            // 协同文件编辑配置（含默认值兜底，兼容旧存档无此 key）
            if (localStorage.getItem('collab') !== null) {
                try {
                    const raw = JSON.parse(localStorage.getItem('collab')!)
                    if (raw && typeof raw === 'object') {
                        const mode = raw.permissionMode
                        this.collab = {
                            enabled: raw.enabled === true,
                            port: typeof raw.port === 'number' && raw.port >= 1024 && raw.port <= 65535 ? raw.port : 3346,
                            maxMembers: typeof raw.maxMembers === 'number' && raw.maxMembers >= 2 && raw.maxMembers <= 20 ? raw.maxMembers : 10,
                            permissionMode: mode === 'approve' || mode === 'readonly' ? mode : 'open',
                            token: typeof raw.token === 'string' ? raw.token : '',
                            autoSaveSeconds: typeof raw.autoSaveSeconds === 'number' && raw.autoSaveSeconds > 0 ? raw.autoSaveSeconds : 30,
                            nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
                        }
                    }
                } catch (e) {
                    console.warn('读取协同配置失败:', e)
                }
            }
            // 远程文件共享配置
            if (localStorage.getItem('remoteFs') !== null) {
                try {
                    const raw = JSON.parse(localStorage.getItem('remoteFs')!)
                    if (raw && typeof raw === 'object') {
                        this.remoteFs = {
                            enabled: raw.enabled === true,
                            port: typeof raw.port === 'number' && raw.port >= 1024 && raw.port <= 65535 ? raw.port : 3347,
                            rootDir: typeof raw.rootDir === 'string' ? raw.rootDir : '',
                            token: typeof raw.token === 'string' ? raw.token : '',
                        }
                    }
                } catch (e) {
                    console.warn('读取远程文件共享配置失败:', e)
                }
            }
            // 局域网共享知识库目录
            if (localStorage.getItem('lan') !== null) {
                try {
                    const raw = JSON.parse(localStorage.getItem('lan')!)
                    if (raw && typeof raw === 'object') {
                        this.lan = {
                            kbDir: typeof raw.kbDir === 'string' ? raw.kbDir : '',
                        }
                    }
                } catch (e) {
                    console.warn('读取局域网共享配置失败:', e)
                }
            }
            // 远程工作区列表
            if (localStorage.getItem('remoteRoots') !== null) {
                try {
                    const parsed = JSON.parse(localStorage.getItem('remoteRoots')!)
                    this.remoteRoots = Array.isArray(parsed)
                        ? parsed.filter((r: any) => r && typeof r.id === 'string' && typeof r.host === 'string')
                        : []
                } catch (e) {
                    this.remoteRoots = []
                }
            }

            // 迁移结果统一落盘（此时 llmSourceStatus / llmDisabledSources 已读入内存，不会被覆盖）
            if (needPersist) this.saveConfig()
        },

        // ================ MCP 服务管理 ================

        /**
         * 确保内置 MCP 服务存在（幂等）：浏览器 Agent + Office Word + drawio 图表 + 文献检索 + PostgreSQL 查询。
         * 内置服务为进程内服务（builtin）：分别经主进程 browserAgentService /
         * officeService / drawioService / literatureService / postgresService 提供工具，
         * 不依赖外部进程；软件启动 / 设置页挂载时兜底注入，防止旧存档缺失或误删后丢失。
         */
        ensureBuiltinMcpServer(): void {
            if (!this.mcpServers.some(s => s && s.id === 'builtin-browser')) {
                this.mcpServers.unshift({
                    id: 'builtin-browser',
                    name: 'Web Agent',
                    transport: 'stdio',
                    builtin: true,
                    autoConnect: true,
                    enabled: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })
            }
            if (!this.mcpServers.some(s => s && s.id === 'builtin-office')) {
                this.mcpServers.push({
                    id: 'builtin-office',
                    name: 'Office Word',
                    transport: 'stdio',
                    builtin: true,
                    autoConnect: true,
                    enabled: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })
            }
            if (!this.mcpServers.some(s => s && s.id === 'builtin-drawio')) {
                this.mcpServers.push({
                    id: 'builtin-drawio',
                    name: 'drawio',
                    transport: 'stdio',
                    builtin: true,
                    autoConnect: true,
                    enabled: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })
            }
            if (!this.mcpServers.some(s => s && s.id === 'builtin-literature')) {
                this.mcpServers.push({
                    id: 'builtin-literature',
                    name: '文献检索',
                    transport: 'stdio',
                    builtin: true,
                    autoConnect: true,
                    enabled: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })
            }
            // PostgreSQL 只读查询：连接信息由用户在「配置 → 环境变量 env」里填写（此处给出可改的模板）
            if (!this.mcpServers.some(s => s && s.id === 'builtin-postgres')) {
                this.mcpServers.push({
                    id: 'builtin-postgres',
                    name: 'PostgreSQL 查询',
                    transport: 'stdio',
                    builtin: true,
                    autoConnect: true,
                    enabled: true,
                    env: {
                        PGHOST: '',
                        PGPORT: '5432',
                        PGDATABASE: '',
                        PGUSER: '',
                        PGPASSWORD: '',
                        // 大库（如 OpenAlex 快照）人名/模糊检索常需几十秒；单位毫秒
                        PG_MCP_STATEMENT_TIMEOUT_MS: '180000',
                    },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                })
            }
            this.saveMcpServers()
        },

        /** 新增 MCP 服务并持久化 */
        addMcpServer(config: Partial<McpServerConfig>): McpServerConfig {
            const server: McpServerConfig = {
                id: generateMcpServerId(),
                name: config.name || '',
                transport: config.transport || 'stdio',
                command: config.command || '',
                args: config.args || '',
                env: config.env || {},
                serverUrl: config.serverUrl || '',
                headers: config.headers || {},
                autoConnect: config.autoConnect ?? true,
                enabled: config.enabled ?? true,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
            this.mcpServers.push(server)
            this.saveMcpServers()
            return server
        },

        /** 更新 MCP 服务并持久化 */
        updateMcpServer(id: string, patch: Partial<McpServerConfig>): void {
            const server = this.mcpServers.find(s => s.id === id)
            if (!server) return
            Object.assign(server, patch, { updatedAt: Date.now() })
            this.saveMcpServers()
        },

        /** 删除 MCP 服务并持久化（内置服务不可删除，避免浏览器 Agent 工具丢失） */
        removeMcpServer(id: string): void {
            const server = this.mcpServers.find(s => s.id === id)
            if (!server) return
            if (server.builtin) return
            this.mcpServers.splice(this.mcpServers.indexOf(server), 1)
            this.saveMcpServers()
        },

        /** 立即持久化 MCP 服务列表 */
        saveMcpServers() {
            localStorage.setItem('mcpServers', JSON.stringify(this.mcpServers))
        },
        
        async addTab(data: any) {
            // 远程文件：内容由调用方提供（data.content 已含预览内容），不再读本地磁盘
            // 注意：知识库(.kb)跳转已统一由 openFileByMode / openInApp 处理，addTab 只负责标签操作
            const isRemote = data && data.isRemote === true
            let existIndex = null
            let i = 0
            while (i < this.data.length) {
                if (this.data[i].path == data.path) existIndex = i
                i++;
            }
            if (existIndex == null) {
                // 远程文件内容由调用方提供（data.content 已含预览内容），不再读本地磁盘
                const fileContent = isRemote ? (data.content ?? '') : await window.ipcRenderer.invoke('readFile', data.path)
                const attributes = isRemote ? {} : await window.ipcRenderer.invoke('getConfig', data.path)
                // 新标签插入到第一个位置
                this.data.unshift({
                    ...data, // 使用对象展开语法将原始数据的属性展开到新的对象中
                    attributes: attributes, // 添加属性
                    content: fileContent // 添加内容
                })
                this.index = 0
            } else {
                this.index = existIndex
                // 已打开的对象若缺失元数据（如 extension），用传入数据补齐，保证编辑器能识别文件类型
                const target = this.data[existIndex]
                if (target && data.extension && !target.extension) {
                    target.extension = data.extension
                }
                // 远程标签：同步 quickPreview 标记（再次单击预览→仍为预览；双击正式打开/窗口内打开→转为正式打开）
                if (target && data && isRemote && typeof data.quickPreview === 'boolean') {
                    target.quickPreview = data.quickPreview
                }
            }
            // 设定打开的路径（远程文件不改变本地工作区路径）
            if (!isRemote && data.type == 'file') {
                this.path = parentPathOf(data.path);
            } else if (!isRemote) {
                this.path = data.path
            }
        },

        /** 按「文件操作」模式打开文件：新窗口模式（且为文件）→ 独立窗口浏览视图；否则窗口内打开 */
        openFileByMode(data: any) {
            if (!data || !data.path) return
            // 知识库(.kb)文件：无论何种文件操作模式，一律跳转到知识处理(knowRAG)模块加载
            //（新窗口模式下 open-file-window 分支会跳过 addTab 的 .kb 跳转，这里统一兜底）
            const isRemote = data.isRemote === true
            if (!isRemote && String(data.path).toLowerCase().endsWith('.kb')) {
                this.openKbFile(data.path)
                return
            }
            // 脚手架任务(.task)文件：识别所属脚手架后跳转 Agent脚手架 并加载（与 .kb 一致，不走文件视图）
            if (!isRemote && isTaskFile(data.path)) {
                void this.openTaskFileByPath(data.path)
                return
            }
            const isFile = data.type === 'file' || (data.extension != null && data.extension !== '')
            if (this.UI.fileOpenMode === 'window' && isFile) {
                // 默认以源码编辑视图打开（代码类 + 未识别/未知类型兜底为纯文本编辑）；
                // 有专属浏览视图的类型（md/html/图片/音视频/pdf/excel/excalidraw）默认浏览视图
                const ext = String(data.path).substring(String(data.path).lastIndexOf('.')).toLowerCase()
                // 系统打开类（可执行/压缩包/镜像等）：直接交给系统默认应用，不进入应用内视图
                const SYSTEM_OPEN_EXTS = ['.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.appimage', '.run', '.bin', '.flatpak', '.snap', '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst']
                if (SYSTEM_OPEN_EXTS.includes(ext)) {
                    window.ipcRenderer.invoke('openWithSystemApp', data.path)
                    return
                }
                // 有专属浏览视图、默认以浏览打开的类型
                const READ_EXTS = [
                    '.md', '.html', '.htm',
                    '.docx', '.doc',
                    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif',
                    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.mpg', '.mpeg',
                    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff',
                    '.pdf', '.xlsx', '.xls', '.excalidraw', '.drawio', '.dio'
                ]
                const view = READ_EXTS.includes(ext) ? 'read' : 'edit'
                window.ipcRenderer.invoke('open-file-window', { path: data.path, view }).catch(() => {})
            } else {
                this.addTab(data)
            }
        },

        /** 在窗口内打开文件（右键「软件内打开」/搜索/文件对话框等强制窗口内场景）；
            知识库(.kb)文件无论何种模式一律跳转知识处理(knowRAG)，与 openFileByMode 保持一致 */
        openInApp(data: any) {
            if (!data || !data.path) return
            const isRemote = data.isRemote === true
            if (!isRemote && String(data.path).toLowerCase().endsWith('.kb')) {
                this.openKbFile(data.path)
                return
            }
            // 脚手架任务(.task)文件：识别所属脚手架后跳转 Agent脚手架 并加载（与「软件内打开」的 .kb 行为一致）
            if (!isRemote && isTaskFile(data.path)) {
                void this.openTaskFileByPath(data.path)
                return
            }
            this.addTab(data)
        },

        /** 打开知识库(.kb)文件：跳转到知识处理(knowRAG)模块并标记待加载文件 */
        openKbFile(path: string) {
            this.mainPanel = '知识处理'
            this.kbPathToOpen = path
        },

        /** 打开脚手架任务(.task)文件：读取文件头识别所属脚手架 → 跳转 Agent脚手架并标记待加载。
            旧文件（无 scaffold 标记）按特征键推断；无法识别时提示并放弃跳转。 */
        async openTaskFileByPath(path: string) {
            const zh = this.locales !== 'en'
            // 只读文件头片段：结果/日志可能达上百 MB，避免整体读入渲染层（识别所需的键均在 JSON 开头）
            const res = await window.ipcRenderer.invoke('readTaskFile', path, 262144)
            if (!res || !res.success) {
                ElMessage.error(zh ? `读取任务文件失败: ${res?.error || '未知错误'}` : `Failed to read task file: ${res?.error || 'unknown error'}`)
                return
            }
            let key = detectTaskScaffold(res.content as string)
            if (!key) {
                // 已下线脚手架的旧任务文件（如 PTC）：给出迁移提示（不再创建实例）
                const retired = detectRetiredTaskScaffold(res.content as string)
                if (retired) {
                    const label = RETIRED_SCAFFOLD_LABELS[retired]
                    ElMessage.warning(zh
                        ? `该任务文件属于已下线的「${label?.labelZh || retired}」脚手架，已不再打开实例；该功能已迁移到主页对话模式的「PTC」`
                        : `This task file belongs to the retired "${label?.labelEn || retired}" scaffold; it no longer opens an instance — the feature moved to the "PTC" chat mode on the Home page`)
                    return
                }
                ElMessage.warning(zh ? '无法识别该任务文件所属脚手架，已取消打开' : 'Unrecognized .task file: cannot tell which scaffold it belongs to')
                return
            }
            // 「数据画布」已独立为顶层主面板（不再是 Agent脚手架）：跳转到画布面板，由面板消费并加载
            if (key === 'canvas') {
                this.mainPanel = '数据画布'
                this.canvasPathToOpen = path
                return
            }
            // 已并入「Agent脚手架」的旧脚手架（批量 / 表格推理 / 文件采集 / 链接采集）：
            // 提示后按 pipeline 打开（PipelineScaffold 读取时按特征键自动转换配置）
            if ((MERGED_SCAFFOLD_KEYS as readonly string[]).includes(key)) {
                const mergedLabel = MERGED_SCAFFOLD_LABELS[key]
                ElMessage.info(zh
                    ? `该任务文件属于已并入「Agent脚手架」的${mergedLabel ? '「' + mergedLabel.labelZh + '」' : '旧脚手架'}，将自动转换为 Agent脚手架配置打开`
                    : `This task file belongs to the merged${mergedLabel ? ' "' + mergedLabel.labelEn + '"' : ''} scaffold — opening it with the Pipeline and converting automatically`)
                key = 'pipeline'
            }
            // 该脚手架在设置页被关闭时自动启用（用户从文件打开，意图明确）
            if (this.enabledScaffolds.indexOf(key) === -1) this.enabledScaffolds.push(key)
            this.mainPanel = 'Agent脚手架'
            // 关联文件禁止重复：已有实例关联该文件 → 直接激活它（并触发重新加载）
            const exist = this.instanceByFilePath(path)
            if (exist) {
                this.setActiveInstance(exist.id)
                // 已打开的实例需要显式重新加载；从未加载过的实例被激活时会自动加载（避免大文件重复读两遍）
                this.taskPathToOpen = path
            } else {
                const targets = this.instancesOfType(key)
                if (this.instanceLimitReached(key) && targets.length) {
                    // 已达单类型上限：复用该类型最近使用的实例（其原关联文件保留在磁盘上，不再引用）
                    const last = targets.slice().sort((a: any, b: any) => b.lastActiveAt - a.lastActiveAt)[0]
                    this.linkInstanceFile(last.id, path)
                    this.setActiveInstance(last.id)
                } else {
                    const id = this.addInstance(key, { filePath: path })
                    this.linkInstanceFile(id, path)
                }
            }
        },

        /** 根据路径关闭对应的标签页 */
        closeTabByPath(filePath: string) {
            const idx = this.data.findIndex((d: any) => d.path === filePath)
            if (idx === -1) return
            this.data.splice(idx, 1)
            // 调整当前索引
            if (this.data.length === 0) {
                this.index = -1
            } else if (this.index >= this.data.length) {
                this.index = this.data.length - 1
            } else if (this.index > idx) {
                this.index--
            }
            // index 不变的情况：删除的标签在当前索引之后
        },
        
        backPath() {
            // 如果当前路径已经是 root 目录，则不执行任何操作
            if (this.path === this.root || this.path === "") {
                return;
            }

            // 如果当前路径在 root 目录下，则向上一级
            if (this.path.startsWith(this.root)) {
                const parentPath = parentPathOf(this.path);

                // 如果上一级目录是 root 目录，则将路径设置为 root
                if (parentPath === this.root) {
                    this.path = this.root;
                } else {
                    this.path = parentPath;
                }
            } else {
                // 如果当前路径不在 root 目录下，则不执行任何操作
                return;
            }
        },

        /** 添加工作区：注册到列表并设为当前工作区。返回是否新增（重复路径仅切换当前工作区并返回 false） */
        addRoot(path: string): boolean {
            if (!path) return false
            if (this.roots.includes(path)) {
                this.root = path
                this.path = path
                this.saveConfig()
                return false
            }
            this.roots.push(path)
            this.root = path
            this.path = path
            // 根集合变化：使文件树版本失效（否则主进程缓存仍有效 + 版本一致 → unchanged 快路径，新增根不显示）
            this.treeVersion = -1
            this.saveConfig()
            return true
        },

        /** 移除工作区（仅从列表移除，不删除磁盘文件）；若移除的是当前工作区，则切换为列表第一项 */
        removeRoot(path: string) {
            const idx = this.roots.indexOf(path)
            if (idx === -1) return
            this.roots.splice(idx, 1)
            if (this.root === path) {
                this.root = this.roots[0] || ''
                this.path = this.root
            }
            // 根集合变化：使文件树版本失效（否则剩余根缓存仍有效 + 版本一致 → unchanged 快路径，被删根残留）
            this.treeVersion = -1
            this.saveConfig()
        },

        /** 添加远程工作区 */
        addRemoteRoot(r: import('@/types/collab').RemoteRoot) {
            if (!r || !r.id) return
            const idx = this.remoteRoots.findIndex((x) => x.id === r.id)
            if (idx !== -1) this.remoteRoots[idx] = r
            else this.remoteRoots.push(r)
            this.saveConfig()
        },

        /** 移除远程工作区 */
        removeRemoteRoot(id: string) {
            this.remoteRoots = this.remoteRoots.filter((x) => x.id !== id)
            this.saveConfig()
        },

        /** 切换当前工作区 */
        setActiveRoot(path: string) {
            if (!path || !this.roots.includes(path)) return
            if (this.root === path) return
            this.root = path
            this.path = path
            this.saveConfig()
        },
        
        toggleView(str: string) {
            if (this.view.indexOf(str) == -1) {
                this.view[this.view.length] = str
            } else {
                this.view.splice(this.view.indexOf(str), 1)
            }
            this.resize()
        },
        
        isView(str: string) {
            if (this.view.indexOf(str) == -1) {
                return false
            } else {
                return true
            }
        },
        
        /** 判断主面板导航按钮是否可见（默认全部可见；隐藏的按钮不会出现在导航栏） */
        isNavVisible(key: string) {
            return this.hiddenNavs.indexOf(key) === -1
        },

        /**
         * 旧存档导航 key 迁移（模块改名）：'Agent CLI' → 'Agent脚手架'（2026-09 改名）。
         * 只保留字符串、去重；localStorage 存档与分发的 interface-config.json 共用。
         */
        migrateNavKeys(list: any): string[] {
            const LEGACY: Record<string, string> = { 'Agent CLI': 'Agent脚手架' }
            const out: string[] = []
            for (const x of Array.isArray(list) ? list : []) {
                if (typeof x !== 'string') continue
                const k = LEGACY[x] || x
                if (out.indexOf(k) === -1) out.push(k)
            }
            return out
        },
        
        /** 切换主面板导航按钮显示/隐藏（设置页「功能开关」）；若当前面板被隐藏则自动跳到第一个可见面板 */
        toggleNav(key: string) {
            const i = this.hiddenNavs.indexOf(key)
            if (i === -1) {
                this.hiddenNavs.push(key)
            } else {
                this.hiddenNavs.splice(i, 1)
            }
            if (!this.isNavVisible(this.mainPanel)) {
                const first = MAIN_PANEL_KEYS.find(k => this.isNavVisible(k))
                if (first) this.mainPanel = first
            }
            this.saveConfig()
        },
        
        /** 判断 Agent脚手架是否启用 */
        isScaffoldEnabled(key: string) {
            return this.enabledScaffolds.indexOf(key) !== -1
        },
        
        /** 切换 Agent脚手架启用/禁用（至少保留一个开启）
         *  启用：若该类型尚无实例则补一个（导航栏立即出现）；
         *  禁用：移除该类型的全部实例（磁盘文件保留），激活实例切到剩余实例 */
        toggleScaffold(key: string) {
            const i = this.enabledScaffolds.indexOf(key)
            if (i === -1) {
                this.enabledScaffolds.push(key)
                if (!this.instancesOfType(key).length) {
                    this.addInstance(key, { title: this.fileBaseName('') })
                }
            } else {
                if (this.enabledScaffolds.length <= 1) return
                this.enabledScaffolds.splice(i, 1)
                this.scaffoldInstances = this.scaffoldInstances.filter(it => it.type !== key)
                if (!this.activeInstance() || this.activeScaffold === key) {
                    const next = this.scaffoldInstances[0]
                    if (next) { this.activeInstanceId = next.id; this.activeScaffold = next.type }
                    else { this.activeInstanceId = ''; this.activeScaffold = this.firstEnabledScaffold() }
                }
            }
            // 恢复被关闭类型时（重新启用）补齐实例标题
            this.scaffoldInstances.forEach((it) => { if (!it.title) it.title = this.fileBaseName(it.filePath) || it.type })
            this.saveConfig()
        },
        
        /** 设置当前激活的 Agent脚手架（仅允许切到已启用的；同时把激活实例切到该类型的首个实例） */
        setActiveScaffold(key: string) {
            if (!this.enabledScaffolds.includes(key)) return
            this.activeScaffold = key
            const first = this.scaffoldInstances.find(it => it.type === key)
            if (first) this.setActiveInstance(first.id)
        },

        // ==================== 脚手架实例（多开） ====================

        /** 脚手架定义（按 key） */
        scaffoldDef(key: string) {
            return SCAFFOLDS.find(s => s.key === key)
        },

        /** 当前激活实例（无有效实例时返回 null；调用方应保证 ensureInstances 已执行） */
        activeInstance(): ScaffoldInstanceMeta | null {
            return this.scaffoldInstances.find(it => it.id === this.activeInstanceId) || null
        },

        /** 当前启用的脚手架对应的实例列表（按创建顺序；供导航栏/标题栏下拉渲染） */
        visibleInstances(): ScaffoldInstanceMeta[] {
            return this.scaffoldInstances.filter(it => this.enabledScaffolds.indexOf(it.type) !== -1)
        },

        /** 指定类型的实例列表 */
        instancesOfType(type: string): ScaffoldInstanceMeta[] {
            return this.scaffoldInstances.filter(it => it.type === type)
        },

        /** 按关联文件路径查实例（用于「关联文件禁止重复」校验） */
        instanceByFilePath(filePath: string, excludeId?: string): ScaffoldInstanceMeta | null {
            if (!filePath) return null
            const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
            const target = norm(filePath)
            return this.scaffoldInstances.find(it => it.id !== excludeId && it.filePath && norm(it.filePath) === target) || null
        },

        /** 新建实例（返回实例 id；文件创建由调用方通过主进程 createTaskFile 完成后传入 filePath） */
        addInstance(type: string, opts?: { title?: string; filePath?: string }): string {
            const def = this.scaffoldDef(type)
            const count = this.instancesOfType(type).length
            const id = `${type}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
            const now = Date.now()
            this.scaffoldInstances.push({
                id,
                type,
                title: opts?.title || `${def ? (this.locales === 'en' ? def.labelEn : def.labelZh) : type} ${count + 1}`,
                filePath: opts?.filePath || '',
                createdAt: now,
                lastActiveAt: now,
            })
            this.setActiveInstance(id)
            this.saveConfig()
            return id
        },

        /** 切换激活实例（并同步 activeScaffold，保证设置页/标题栏文案一致） */
        setActiveInstance(id: string) {
            const inst = this.scaffoldInstances.find(it => it.id === id)
            if (!inst) return
            this.activeInstanceId = id
            inst.lastActiveAt = Date.now()
            if (this.activeScaffold !== inst.type) this.activeScaffold = inst.type
            this.saveConfig()
        },

        /** 重命名实例（titleManual=true 后不再跟随文件名变化） */
        renameInstance(id: string, title: string) {
            const inst = this.scaffoldInstances.find(it => it.id === id)
            if (!inst) return
            inst.title = String(title || '').trim() || inst.title
            inst.titleManual = true
            this.saveConfig()
        },

        /** 关联/更换实例的任务文件（禁止与其他实例重复；返回冲突实例） */
        linkInstanceFile(id: string, filePath: string): ScaffoldInstanceMeta | null {
            const inst = this.scaffoldInstances.find(it => it.id === id)
            if (!inst || !filePath) return null
            const conflict = this.instanceByFilePath(filePath, id)
            if (conflict) return conflict
            inst.filePath = filePath
            inst.fileMissing = false
            if (!inst.titleManual) inst.title = this.fileBaseName(filePath)
            this.saveConfig()
            return null
        },

        /** 标记实例关联文件缺失（文件被移动/删除） */
        markInstanceFileMissing(id: string, missing: boolean) {
            const inst = this.scaffoldInstances.find(it => it.id === id)
            if (inst) inst.fileMissing = missing
        },

        /** 关闭（删除）实例：仅从列表移除，磁盘上的任务文件保留 */
        removeInstance(id: string) {
            const idx = this.scaffoldInstances.findIndex(it => it.id === id)
            if (idx === -1) return
            const type = this.scaffoldInstances[idx].type
            this.scaffoldInstances.splice(idx, 1)
            if (this.activeInstanceId === id) {
                const next = this.scaffoldInstances.find(it => it.type === type) || this.scaffoldInstances[0]
                if (next) { this.activeInstanceId = next.id; this.activeScaffold = next.type }
                else { this.activeInstanceId = '' }
            }
            this.saveConfig()
        },

        /** 文件路径 → 标题（去目录与扩展名） */
        fileBaseName(filePath: string) {
            const base = String(filePath || '').split(/[\\/]/).pop() || ''
            return base.replace(/\.task$/i, '') || base
        },

        /** 确保实例列表可用：清除已禁用类型的实例；空列表时按启用脚手架建单实例；校正激活实例
         *  同时在配置加载完成后调用（旧版本存档只有 enabledScaffolds/activeScaffold，需迁移出实例） */
        ensureInstances() {
            // 剔除已禁用类型的实例（保留磁盘文件，仅从导航栏移除）
            const kept = this.scaffoldInstances.filter(it => this.enabledScaffolds.indexOf(it.type) !== -1)
            if (kept.length !== this.scaffoldInstances.length) this.scaffoldInstances = kept
            // 空列表（首次使用 / 全部类型刚被启用）：每个启用的脚手架建一个实例
            if (!this.scaffoldInstances.length) {
                const now = Date.now()
                this.enabledScaffolds.forEach((type: string, i: number) => {
                    this.scaffoldInstances.push({
                        id: `${type}:${(now + i).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                        type,
                        title: '',
                        filePath: '',
                        createdAt: now + i,
                        lastActiveAt: now + i,
                    })
                })
            }
            // 标题兜底（迁移出来的实例没有标题）
            this.scaffoldInstances.forEach((it) => { if (!it.title) it.title = this.fileBaseName(it.filePath) || it.type })
            // 激活实例校正：优先沿用 activeInstanceId，其次匹配 activeScaffold 类型，最后取第一个
            if (!this.scaffoldInstances.some(it => it.id === this.activeInstanceId)) {
                const byType = this.scaffoldInstances.find(it => it.type === this.activeScaffold)
                this.activeInstanceId = (byType || this.scaffoldInstances[0])?.id || ''
            }
            const act = this.activeInstance()
            if (act) this.activeScaffold = act.type
        },

        /**
         * 一次性迁移：清理存量实例标题里的「（预览）」字样，并把自动生成的旧脚手架名
         * （「通用流水线」/「Pipeline」）改为现在的「Agent脚手架」/「Agent Scaffold」（手动改名的实例不动）。
         */
        migrateScaffoldTitles() {
            let changed = false
            for (const it of this.scaffoldInstances) {
                if (it.titleManual) continue
                let t = String(it.title || '')
                const before = t
                if (t.includes('（预览）')) t = t.replace('（预览）', '').trim()
                // 存量自动标题：通用流水线 1 / Pipeline 1 → Agent脚手架 1 / Agent Scaffold 1
                t = t.replace(/^通用流水线/, 'Agent脚手架').replace(/^Pipeline\b/, 'Agent Scaffold')
                if (t !== before) {
                    it.title = t
                    changed = true
                }
            }
            if (changed) this.saveConfig()
        },

        /**
         * 一次性迁移：「数据画布」由 Agent脚手架独立为顶层主面板。
         * 接管旧画布实例（type='canvas'）中最近使用且有关联文件的 .task 路径 → canvasTaskPath；
         * canvas 实例本身随实例列表的 SCAFFOLDS 过滤被移除（磁盘 .task 保留，双击仍可打开到画布面板）。
         */
        migrateCanvasPanelState(rawInstances: any[]) {
            if (this.canvasTaskPath) return
            const canvasInsts = (Array.isArray(rawInstances) ? rawInstances : [])
                .filter((it: any) => it && it.type === 'canvas' && typeof it.filePath === 'string' && it.filePath)
                .sort((a: any, b: any) => (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0))
            if (!canvasInsts.length) return
            this.canvasTaskPath = String(canvasInsts[0].filePath)
            try { localStorage.setItem('canvasTaskPath', JSON.stringify(this.canvasTaskPath)) } catch { /* 忽略 */ }
        },

        /**
         * 一次性迁移：把「新加入的脚手架」补进老存档的启用列表并补一个实例。
         * - 仅执行一次：已应用的迁移 id 记录在 localStorage:scaffoldMigrations，用户之后手动关闭不会被自动恢复；
         * - 不改变当前激活实例（避免启动时抢焦点）；全新安装不走此路径（默认列表已包含）。
         */
        migrateScaffoldDefaults() {
            // 新增默认启用的脚手架时，在此追加一条（id 仅用于一次性判定；重复追加请使用新 id）
            const MIGRATIONS: Array<{ id: string; key: string }> = [
                { id: 'pipeline-2026-09-21', key: 'pipeline' },
            ]
            let applied: string[] = []
            try {
                const parsed = JSON.parse(localStorage.getItem('scaffoldMigrations') || '[]')
                applied = Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : []
            } catch { applied = [] }
            let changed = false
            for (const m of MIGRATIONS) {
                if (applied.indexOf(m.id) !== -1) continue
                applied.push(m.id)
                changed = true
                if (!SCAFFOLDS.some(s => s.key === m.key)) continue
                if (this.enabledScaffolds.indexOf(m.key) === -1) this.enabledScaffolds.push(m.key)
                if (!this.instancesOfType(m.key).length) {
                    const def = this.scaffoldDef(m.key)
                    const now = Date.now()
                    this.scaffoldInstances.push({
                        id: `${m.key}:${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                        type: m.key,
                        title: `${def ? (this.locales === 'en' ? def.labelEn : def.labelZh) : m.key} 1`,
                        filePath: '',
                        createdAt: now,
                        lastActiveAt: now,
                    })
                }
            }
            if (changed) {
                try { localStorage.setItem('scaffoldMigrations', JSON.stringify(applied)) } catch { /* 忽略 */ }
                this.saveConfig()
            }
        },

        /** 新建实例时该类型是否已达上限 */
        instanceLimitReached(type: string): boolean {
            const def = this.scaffoldDef(type)
            const max = def?.maxInstances ?? 1
            return this.instancesOfType(type).length >= max
        },
        
        /** 第一个启用的脚手架 key（无则回退到首个在册脚手架） */
        firstEnabledScaffold() {
            return this.enabledScaffolds.find(k => SCAFFOLDS.some(s => s.key === k)) || SCAFFOLDS[0].key
        },
        
        /** 汇总当前界面配置（UI + 标题 + 功能开关 + 脚手架 + 视图 + 语言），供根目录文件持久化 */
        gatherInterfaceConfig() {
            return {
                UI: JSON.parse(JSON.stringify(this.UI)),
                customTitle: this.customTitle,
                hiddenNavs: [...this.hiddenNavs],
                enabledScaffolds: [...this.enabledScaffolds],
                view: [...this.view],
                locales: this.locales,
            }
        },
        
        /** 应用界面配置（来自根目录 interface-config.json） */
        applyInterfaceConfig(cfg: any) {
            if (!cfg || typeof cfg !== 'object') return
            if (cfg.UI && typeof cfg.UI === 'object') {
                this.UI = { ...this.UI, ...cfg.UI }
                // 分发的 interface-config.json 同样可能来自历史版本（theme='浅蓝色'）
                normalizeThemeName(this.UI)
            }
            if (typeof cfg.customTitle === 'string') this.customTitle = cfg.customTitle
            if (Array.isArray(cfg.hiddenNavs)) this.hiddenNavs = this.migrateNavKeys(cfg.hiddenNavs)
            if (Array.isArray(cfg.enabledScaffolds)) {
                this.enabledScaffolds = cfg.enabledScaffolds.filter((k: any) => SCAFFOLDS.some(s => s.key === k))
                if (!this.enabledScaffolds.length) this.enabledScaffolds = [SCAFFOLDS[0].key]
                // 界面配置应用后同样校正激活脚手架，确保其始终指向已启用的脚手架
                if (this.enabledScaffolds.indexOf(this.activeScaffold) === -1) {
                    this.activeScaffold = this.firstEnabledScaffold()
                }
            }
            if (Array.isArray(cfg.view)) this.view = cfg.view.map((v: any) => (typeof v === 'string' ? normalizeViewName(v) : v))
            if (typeof cfg.locales === 'string') this.locales = cfg.locales
            this.setTheme()
        },
        
        /** 启动时加载根目录界面配置（仅开关开启时生效；开启后界面以该文件为准） */
        async loadRemoteInterfaceConfig() {
            if (!this.interfaceConfigMode) return
            if (!window.dsh?.interfaceConfig) return
            try {
                const cfg = await window.dsh.interfaceConfig.load()
                if (cfg) this.applyInterfaceConfig(cfg)
            } catch (e) {
                console.warn('加载根目录界面配置失败:', e)
            }
        },
        
        /** 切换「界面配置随软件分发」开关；开启时把当前界面配置写入软件根目录 */
        async setInterfaceConfigMode(on: boolean) {
            this.interfaceConfigMode = on
            if (on && window.dsh?.interfaceConfig) {
                const res = await window.dsh.interfaceConfig.save(this.gatherInterfaceConfig())
                this.saveConfig()
                return res
            }
            this.saveConfig()
            return { success: true, path: '' }
        },
        
        changeTheme() {
            // 归一化主题管理：18 个预设主题统一从 THEMES 映射表取值，避免各分支字段不统一（自定义主题不在表中，保持当前 UI 不变）
            const t = THEMES[this.UI.theme]
            if (t) {
                this.UI = {
                    theme: this.UI.theme,
                    backgroundColor: t.backgroundColor,
                    borderColor: t.borderColor,
                    menuColor: t.menuColor,
                    menuActiveColor: t.menuActiveColor,
                    fontColor: t.fontColor,
                    fontActiveColor: t.fontActiveColor,
                    layout: this.UI.layout,
                    windowZoom: this.UI.windowZoom,
                    navLayout: this.UI.navLayout,
                    fileOpenMode: this.UI.fileOpenMode,
                    // ⚠️ changeTheme 会重建整个 UI 对象：新增的 UI 字段必须在这里带上，否则切主题就丢设置
                    closeToTray: this.UI.closeToTray,
                    browserHomeUrl: this.UI.browserHomeUrl,
                    browserSaveDir: this.UI.browserSaveDir,
                    wordExportStylePath: this.UI.wordExportStylePath,
                    wordExportTemplate: this.UI.wordExportTemplate || 'gongwen'
                }
            }
            this.setTheme()
            // 立刻落盘 + 广播给其它窗口（含主窗口）：
            // 只调 setTheme 只发 notify-theme-change，主窗口不监听该通道（它走 settings-config-changed），
            // 于是主窗口要等设置窗口关闭（onBeforeUnmount 的 saveConfig）才跟着变主题。
            this.saveConfig()
        },
        
        setTheme() {
            document.documentElement.style.setProperty("--backgroundColor", this.UI.backgroundColor);
            document.documentElement.style.setProperty("--menuColor", this.UI.menuColor);
            document.documentElement.style.setProperty("--menuActiveColor", this.UI.menuActiveColor);
            document.documentElement.style.setProperty("--fontColor", this.UI.fontColor);
            document.documentElement.style.setProperty("--fontActiveColor", this.UI.fontActiveColor);
            document.documentElement.style.setProperty("--borderColor", this.UI.borderColor);
            // 上报主题背景色到主进程，作为新开窗口首帧后备背景（消除加载白屏）
            try { window.ipcRenderer?.send('theme-background-changed', this.UI.backgroundColor) } catch (e) { /* 非 Electron 环境忽略 */ }
            // 广播完整主题 + 语言给其他窗口（任一窗口改主题/语言后，其它窗口立即跟随；
            // 收到广播应用时由 themeBroadcastGuard 抑制，避免循环）
            if (!themeBroadcastGuard) {
                try { window.ipcRenderer?.send('notify-theme-change', { ui: JSON.parse(JSON.stringify(this.UI)), locales: this.locales }) } catch (e) { /* 非 Electron 环境忽略 */ }
            }
        },

        /**
         * 切换界面语言：立即持久化并广播给其它窗口。
         * 语言不在 UI 对象里，必须单独广播：否则设置窗口改语言后，独立文件窗口/浏览器窗口
         * 要等设置窗口关闭（onBeforeUnmount 的 saveConfig）才更新。
         */
        setLocale(v: string) {
            this.locales = v === 'en' ? 'en' : 'zh'
            this.saveConfig()
        },

        /** 应用其他窗口广播的主题/语言（更新 UI 并重设 CSS 变量），不重复上报避免循环 */
        applyThemeFromBroadcast(payload: any) {
            if (!payload || typeof payload !== 'object') return
            // 兼容两种载荷：新格式 { ui, locales }；旧格式（整个对象就是 UI）
            const ui = payload.ui && typeof payload.ui === 'object' ? payload.ui : payload
            const locale = typeof payload.locales === 'string' ? payload.locales : ''
            themeBroadcastGuard = true
            try {
                this.UI = { ...this.UI, ...ui }
                if (locale === 'zh' || locale === 'en') this.locales = locale
                lastBroadcastUiJson = JSON.stringify(this.UI) // 与广播源保持一致，抑制本窗口回传
                lastBroadcastLocale = this.locales
                this.setTheme()
            } finally {
                themeBroadcastGuard = false
            }
        },

        /** 设置是否持久化标签栏（独立文件窗口设 false，避免污染主窗口标签栏） */
        setPersistTabs(v: boolean) {
            persistTabs = v
        },

        /**
         * 设置是否持久化主面板导航 mainPanel（独立窗口设 false）。
         * 独立窗口不维护主窗口导航，写盘会把主窗口的面板覆盖回它打开时的旧值。
         */
        setPersistMainPanel(v: boolean) {
            persistMainPanel = v
        },

        /**
         * 标记本窗口为「设置写盘方」（设置独立窗口调用）：
         * 之后每次 saveConfig 都额外广播 settings-config-changed，通知其它窗口（主窗口）同步配置。
         * 设置窗口是界面/AI/工具等配置的唯一编辑入口，主窗口内存里的配置不会自动感知这些修改。
         */
        setSettingsConfigWriter(v: boolean) {
            settingsConfigWriter = v
        },

        /**
         * 同步「设置独立窗口写盘后」的配置（仅主窗口调用）：
         * - UI 合并广播载荷（主题/语言/导航显隐/自定义标题/缩放/布局…）后重设 CSS 变量；
         * - 其余运行态配置（AI 模型来源 / 工具开关 / MCP / Agent 预设等）从 localStorage 重新读取。
         * 标签栏（data/index）与主面板导航（mainPanel）属主窗口自身运行态，设置窗口不维护，重载后原样保留。
         */
        syncConfigFromPeers(ui?: any, locale?: string) {
            const tabs = this.data
            const tabIndex = this.index
            const panel = this.mainPanel // 主窗口当前面板：不能被配置重载带走（否则会跳回 localStorage 里的旧值）
            themeBroadcastGuard = true // 重载期间不向其它窗口回传，避免与设置窗口互相广播
            try {
                if (ui && typeof ui === 'object') this.UI = { ...this.UI, ...ui }
                this.loadConfig()
                if (locale === 'zh' || locale === 'en') this.locales = locale
                this.data = tabs
                this.index = tabIndex
                this.mainPanel = panel
                this.setTheme()
            } finally {
                themeBroadcastGuard = false
            }
        },
        
        // TTS函数 - 使用TTS管理器
        tts(text: string) {
            if (!this.ttsManager) {
                this.init();
            }
            this.ttsManager?.play(text);
        },
        
        // 停止TTS
        stopTTS() {
            this.ttsManager?.stop();
        },
        
        // 获取TTS状态
        getTTSState() {
            if (!this.ttsManager) {
                this.init();
            }
            return this.ttsManager?.getTTSState() || {
                isSpeaking: false,
                isPaused: false,
                queueLength: 0,
                type: 'unknown'
            };
        },
        
        // 暂停/恢复TTS
        toggleTTS() {
            if (!this.ttsManager) {
                this.init();
            }
            this.ttsManager?.togglePause();
        },
        
        // 清理TTS资源
        cleanupTTSResources() {
            // 清理所有blob URL
            document.querySelectorAll('audio[src^="blob:"]').forEach(audio => {
                try {
                    const audioElement = audio as HTMLAudioElement;
                    audioElement.pause();
                    audioElement.src = '';
                } catch (error) {
                    console.error("清理音频资源时出错:", error);
                }
            });
        },
        
        // 更新TTS配置
        updateTTSConfig(config: any) {
            this.AIconfig.tts = { ...this.AIconfig.tts, ...config };
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
        },
        
        // 测试Qwen3-TTS连接
        async testQwen3TTSConnection(): Promise<{
            success: boolean;
            message: string;
            details?: any;
        }> {
            if (!this.ttsManager) {
                this.init();
            }
            
            try {
                const result = await this.ttsManager?.testQwen3TTSConnection() || { 
                    success: false, 
                    message: 'TTS管理器未初始化' 
                };
                
                // 根据结果中的 success 字段设置连接状态
                this.AIconfig.tts.qwen3.connected = result.success;
                
                return result;
            } catch (error) {
                console.error("测试Qwen3-TTS连接失败:", error);
                this.AIconfig.tts.qwen3.connected = false;
                return {
                    success: false,
                    message: `测试连接失败: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        },
        
        // 设置Qwen3-TTS URL
        setQwen3TTSUrl(url: string) {
            this.AIconfig.tts.url = url;
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
        },
        
        // 设置Qwen3-TTS声音
        setQwen3TTSVoice(voice: string) {
            this.AIconfig.tts.voice = voice;
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
        },
        
        // 设置Qwen3-TTS语速
        setQwen3TTSSpeed(speed: number) {
            this.AIconfig.tts.qwen3.speed = speed;
            this.AIconfig.tts.rate = speed; // 同时更新通用语速设置
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
        },
        
        // 设置Qwen3-TTS音调
        setQwen3TTSPitch(pitch: number) {
            this.AIconfig.tts.qwen3.pitch = pitch;
            this.AIconfig.tts.pitch = pitch; // 同时更新通用音调设置
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
        },
        
        // 更新本地 ONNX TTS（Kokoro / Piper）配置并同步到 TTS 管理器
        updateOnnxTTS(config: Partial<any>) {
            this.AIconfig.tts.onnx = { ...this.AIconfig.tts.onnx, ...config };
            if (this.ttsManager) {
                this.ttsManager.updateConfig(this.AIconfig.tts);
            }
            this.saveConfig();
        },

        // 加载本地 ONNX TTS 模型（预建实例，返回模型信息）
        async loadOnnxTTS(): Promise<{ success: boolean; message: string; info?: any }> {
            const onnx = this.AIconfig.tts.onnx;
            if (!onnx?.modelDir) {
                return { success: false, message: '未设置模型目录' };
            }
            onnx.loading = true;
            onnx.error = '';
            try {
                if (!(window as any).dsh?.tts) {
                    return { success: false, message: '主进程 TTS 服务不可用（非 Electron 环境？）' };
                }
                const info = await (window as any).dsh.tts.load({
                    engine: this.AIconfig.tts.type,
                    modelDir: onnx.modelDir,
                    lang: onnx.lang,
                });
                onnx.modelLoaded = true;
                onnx.sampleRate = info?.sampleRate || 0;
                onnx.numSpeakers = info?.numSpeakers || 0;
                return {
                    success: true,
                    message: `模型加载成功（${onnx.numSpeakers} 个音色，${onnx.sampleRate}Hz）`,
                    info,
                };
            } catch (error: any) {
                onnx.modelLoaded = false;
                onnx.error = error?.message || String(error);
                return { success: false, message: onnx.error };
            } finally {
                onnx.loading = false;
            }
        },

        // 测试合成一段本地 ONNX 语音
        testOnnxTTS(): { success: boolean; message: string } {
            const text = this.locales === 'zh' ? '这是一个本地语音合成测试。' : 'This is a local TTS test.';
            this.tts(text);
            return { success: true, message: '已开始合成' };
        },
        
        // 获取AI配置
        // 确保当前 LLM 配置可用（尤其 ollama 本地模型，模型名不固定）：
        // model 为空时自动从 available_models 回填第一个真实模型；列表也为空则刷新探测一次。
        // 各页面发送/运行前调用，避免读到空 model 而报 "model not found" / "请先在AI配置中选择一个Ollama模型"。
        async ensureLlmReady() {
            const llm = this.AIconfig.llm
            if (!llm) return
            // 仅 ollama 需要自愈：本地模型名不固定；其余 provider 默认 model 云端真实存在
            if (String(llm.type || '').toLowerCase() !== 'ollama') return
            const ollama = llm.ollama
            if (!ollama) return
            if (ollama.model) return
            // 已有可用列表：直接选第一个，无需网络请求
            if (Array.isArray(ollama.available_models) && ollama.available_models.length > 0) {
                ollama.model = ollama.available_models[0]
                this.saveConfig()
                return
            }
            // 列表也为空：刷新一次（getAIconfig 会拉取并自动选第一个可用模型）
            await this.getAIconfig()
        },

        /**
         * 把某个自定义来源（默认当前激活）同步到扁平 custom。
         * home 按聊天绑定的自定义来源路由/测试时用：先 apply 聊天绑定的索引，
         * 请求结束后由调用方恢复设置页当前激活来源。
         */
        applyCustomSourceIndex(index?: number) {
            const c = this.AIconfig?.llm?.custom
            if (!c || !Array.isArray(c.sources) || c.sources.length === 0) return
            const idx = (typeof index === 'number' && index >= 0 && index < c.sources.length)
                ? index
                : (typeof c.activeIndex === 'number' ? c.activeIndex : 0)
            const src = c.sources[idx]
            if (!src) return
            c.activeIndex = idx
            c.name = src.name || ''
            c.api_url = src.api_url || ''
            c.api_key = src.api_key || ''
            c.apiKeyRef = src.apiKeyRef || ''
            c.model = src.model || ''
            c.embed_model = src.embed_model || ''
            c.available_models = Array.isArray(src.available_models) ? src.available_models : []
        },

        /** 从 localStorage 重新加载 AIconfig（独立窗口/新模块打开时同步最新模型来源配置，避免用旧来源导致请求 URL 无效） */
        refreshAIconfigFromStorage() {
            const raw = localStorage.getItem('AIconfig')
            if (!raw) return
            try {
                const savedConfig = JSON.parse(raw)
                if (!savedConfig?.llm) return
                // 合并默认配置，确保结构完整（与 loadConfig 一致）
                this.AIconfig = {
                    ...this.AIconfig,
                    ...savedConfig,
                    llm: { ...this.AIconfig.llm, ...savedConfig.llm },
                    tts: { ...this.AIconfig.tts, ...savedConfig.tts },
                    asr: savedConfig.asr ? { ...this.AIconfig.asr, ...savedConfig.asr } : this.AIconfig.asr,
                }
                // 迁移（与 loadConfig 一致）：Qwen3-ASR 网页服务参数补全（asr 浅合并会整体覆盖 qwen3）
                if (this.AIconfig.asr?.qwen3 && DEFAULT_AIconfig?.asr?.qwen3) {
                    this.AIconfig.asr.qwen3 = { ...DEFAULT_AIconfig.asr.qwen3, ...this.AIconfig.asr.qwen3 }
                }
                // 迁移（与 loadConfig 一致）：think 布尔值 → 推理强度档位字符串；清理已废弃的 Responses 联网搜索配置
                if (typeof this.AIconfig.llm.think !== 'string') {
                    this.AIconfig.llm.think = this.AIconfig.llm.think ? 'high' : 'none'
                }
                {
                    const dsr: any = this.AIconfig.llm.deepseekResponses
                    if (dsr) {
                        delete dsr.web_search
                        delete dsr.web_search_force
                        if (!dsr.model || dsr.model === 'deepseek-v4-flash') dsr.model = 'deepseek-flash'
                    }
                }
                // 迁移（与 loadConfig 一致）：DeepSeek 两来源 → 单来源 + api_style
                if (migrateDeepSeekMerge(this.AIconfig.llm)) this.saveConfig()
                const customLlm = this.AIconfig.llm.custom
                // 多自定义来源：播种 / activeIndex 校验 / 独立存档恢复 / 扁平对齐（与 loadConfig 一致）
                if (customLlm && (!Array.isArray(customLlm.sources) || customLlm.sources.length === 0)) {
                    customLlm.sources = [{
                        id: 1,
                        name: customLlm.name || 'Custom',
                        api_url: customLlm.api_url || '',
                        api_key: customLlm.api_key || '',
                        apiKeyRef: customLlm.apiKeyRef || '',
                        model: customLlm.model || '',
                        embed_model: customLlm.embed_model || '',
                        available_models: Array.isArray(customLlm.available_models) ? customLlm.available_models : [],
                    }]
                }
                if (customLlm && (typeof customLlm.activeIndex !== 'number' ||
                    customLlm.activeIndex < 0 || customLlm.activeIndex >= (customLlm.sources || []).length)) {
                    customLlm.activeIndex = 0
                }
                try {
                    const rawCustom = localStorage.getItem('customLlmSources')
                    if (rawCustom) {
                        const sc = JSON.parse(rawCustom)
                        const cc = this.AIconfig?.llm?.custom
                        if (cc && Array.isArray(sc?.sources) && sc.sources.length > 0) {
                            cc.sources = sc.sources
                            cc.activeIndex = (typeof sc.activeIndex === 'number' && sc.activeIndex >= 0 && sc.activeIndex < sc.sources.length) ? sc.activeIndex : 0
                            cc.name = sc.name || ''
                            cc.api_url = sc.api_url || ''
                            cc.api_key = sc.api_key || ''
                            cc.apiKeyRef = sc.apiKeyRef || ''
                            cc.model = sc.model || ''
                            cc.embed_model = sc.embed_model || ''
                            cc.available_models = Array.isArray(sc.available_models) ? sc.available_models : []
                        }
                    }
                } catch (e) { /* 独立存档缺失/损坏则回退 AIconfig */ }
                // 扁平字段与激活来源对齐（防止临时值污染，保证自定义推理等使用激活来源）
                try { this.applyCustomSourceIndex() } catch (e) { /* 忽略 */ }
                // 迁移（上下文窗口上限）：与 loadConfig 一致，全局单值 → 来源级
                if (migrateLegacyContextWindow(this.AIconfig.llm)) this.saveConfig()
                // 来源可能已变化：连接状态未知，置 false 让 sendToAI 用新来源重新检测
                this.AIconfig.llm.online = false
            } catch (e) {
                console.error('[AIconfig] 刷新失败:', e)
            }
        },

        /** 来源是否被禁用：内置传 type key；自定义传 customId */
        isLlmSourceDisabled(key: string, customId?: number): boolean {
            if (customId !== undefined && (this.llmDisabledSources || []).includes(`custom:${customId}`)) return true
            return (this.llmDisabledSources || []).includes(key)
        },
        /** 切换来源启停：内置传 type key；自定义传 customId */
        toggleLlmSource(key: string, customId?: number) {
            const id = customId !== undefined ? `custom:${customId}` : key
            const arr = this.llmDisabledSources || []
            const i = arr.indexOf(id)
            if (i >= 0) arr.splice(i, 1)
            else arr.push(id)
            this.saveConfig()
        },
        /** 是否存在已启用的自定义来源（决定是否展示 custom 类型选项） */
        hasEnabledCustomSource(): boolean {
            const c = this.AIconfig?.llm?.custom
            const sources = Array.isArray(c?.sources) ? c.sources : []
            return sources.some((s: any) => !(this.llmDisabledSources || []).includes(`custom:${s?.id}`))
        },

        async getAIconfig(typeOverride?: string) {
            const llmConfig = this.AIconfig.llm;
            // typeOverride：连接检测/刷新等场景按指定来源探测，不修改全局 llm.type，
            // 避免并发保存把临时类型（如 ollama）写进存档导致重启后来源回退
            const type = typeOverride || llmConfig.type;

            switch (type) {
                case 'ollama':
                    // 保存当前选中的模型
                    const currentModel = llmConfig.ollama.model;
                    const currentUrl = llmConfig.ollama.model_url;
                    
                    // 从localStorage获取保存的模型（始终执行，不判断currentModel是否为空）；
                    // 注意：不要求 saved type===ollama——全局类型切到 custom 后，ollama 模型选择也应记住
                    let savedModel = null;
                    try {
                        const savedConfig = localStorage.getItem('AIconfig');
                        if (savedConfig) {
                            const parsed = JSON.parse(savedConfig);
                            if (parsed.llm?.ollama?.model) {
                                savedModel = parsed.llm.ollama.model;
                            }
                        }
                    } catch (e) {
                        console.error('从localStorage读取模型失败:', e);
                    }
                    
                    const ollamaResult = await AIUtils.checkOllamaConnection(llmConfig.ollama);
                    // 探测失败（IPC 异常返回 null）时按离线处理并保留原模型列表，不中断整个配置加载
                    this.AIconfig.llm.online = !!ollamaResult?.online;
                    if (Array.isArray(ollamaResult?.available_models)) {
                        this.AIconfig.llm.ollama.available_models = ollamaResult.available_models;
                    }
                    
                    // 决定要恢复哪个模型（优先级）：
                    // 1) 当前内存已选模型 → 保持不变（即使不在最新列表也不跳成最新模型）
                    // 2) 未选时 → 用 localStorage 保存的模型（跨会话记忆，不依赖当时的全局来源类型）
                    // 3) 都为空 → 保持原值，不自动跳到最新（发送前由 ensureLlmReady 兜底自动回填）
                    const alreadySelected = String(currentModel || '').trim();
                    const available = ollamaResult?.available_models || [];
                    if (alreadySelected) {
                        // 已选模型保持不变，不覆盖
                    } else if (savedModel && available.includes(savedModel)) {
                        this.AIconfig.llm.ollama.model = savedModel;
                    } else if (ollamaResult?.model) {
                        // ollama 离线/拉取失败：保留探测返回的模型（不误清空）
                        this.AIconfig.llm.ollama.model = ollamaResult.model;
                    }
                    // 未选且无保存模型：保持原值，不自动跳到最新（发送前由 ensureLlmReady 兜底自动回填）
                    // 拉取失败且无任何模型时保持原值（不强制置空，避免丢失用户已配置的模型）
                    
                    // 恢复URL（防止被覆盖）
                    if (currentUrl) {
                        this.AIconfig.llm.ollama.model_url = currentUrl;
                    }
                    // 注意：此处不再内部 saveConfig——getAIconfig 也用于 home 连接检测等临时切换场景，
                    // 内部保存会把临时 type 写进 localStorage（导致重启后来源被粘成 ollama）。
                    // 需要持久化的调用方（refreshOllamaModels 等）会在调用后自行 saveConfig。
                    break;
                case 'lmstudio':
                    const lmstudioResult = await AIUtils.checkLMStudioConnection({
                        base_url: llmConfig.lmstudio.base_url,
                        model: llmConfig.lmstudio.model
                    });
                    this.AIconfig.llm.online = !!lmstudioResult?.online;
                    if (Array.isArray(lmstudioResult?.available_models)) {
                        this.AIconfig.llm.lmstudio.available_models = lmstudioResult.available_models;
                    }
                    if (lmstudioResult?.model) {
                        this.AIconfig.llm.lmstudio.model = lmstudioResult.model;
                    }
                    break;
                case 'openai':
                    const openaiCheckCfg = { ...llmConfig.openai, api_key: (await this.resolveApiKey(llmConfig.openai)) || llmConfig.openai.api_key };
                    const openaiResult = await AIUtils.checkOpenAIConnection(openaiCheckCfg);
                    this.AIconfig.llm.online = !!openaiResult?.online;
                    if (Array.isArray(openaiResult?.available_models)) {
                        this.AIconfig.llm.openai.available_models = openaiResult.available_models;
                    }
                    break;

                case 'custom': {
                    const customCheckCfg = { ...llmConfig.custom, api_key: (await this.resolveApiKey(llmConfig.custom)) || llmConfig.custom.api_key };
                    const customResult = await AIUtils.checkCustomConnection(customCheckCfg);
                    this.AIconfig.llm.online = !!customResult?.online;
                    // 拉取失败（空列表/瞬断）时保留已存在的模型列表，避免把已选下拉打回手填
                    const fetched = Array.isArray(customResult?.available_models) ? customResult.available_models : [];
                    if (fetched.length > 0) {
                        this.AIconfig.llm.custom.available_models = fetched;
                    }
                    // 已选模型不在列表时保留（不覆盖用户手填）；列表为空也保持原值
                    break;
                }

                case 'deepseek':
                case 'deepseek-responses': {
                    // 单来源：按当前接口样式探测（Chat 走 /models，Responses 走 Responses 探测），
                    // 模型列表回填到该样式自己的配置块（两种样式的模型各记一份）
                    const dsStyle = deepSeekStyleOf(type, llmConfig.deepseek);
                    const dsCfg = deepSeekConfig(llmConfig);
                    const dsCheckCfg = { ...dsCfg, api_key: (await this.resolveApiKey(dsCfg)) || dsCfg.api_key };
                    const dsResult: any = dsStyle === 'responses'
                        ? await AIUtils.checkDeepSeekResponsesConnection(dsCheckCfg)
                        : await AIUtils.checkOpenAIConnection(dsCheckCfg);
                    this.AIconfig.llm.online = !!dsResult?.online;
                    if (Array.isArray(dsResult?.available_models)) {
                        const target = dsStyle === 'responses' ? this.AIconfig.llm.deepseekResponses : this.AIconfig.llm.deepseek;
                        target.available_models = dsResult.available_models;
                    }
                    break;
                }

                case 'gpustack': {
                    // GPUStack：连接/模型列表探测复用自定义来源逻辑（api_url = base_url，裸地址自动推导 /v1-openai）
                    const gpuCfg = { ...llmConfig.gpustack, api_key: (await this.resolveApiKey(llmConfig.gpustack)) || llmConfig.gpustack.api_key };
                    const gpuResult = await AIUtils.checkCustomConnection({ api_url: gpuCfg.base_url || '', api_key: gpuCfg.api_key });
                    this.AIconfig.llm.online = !!gpuResult?.online;
                    const gpuModels = Array.isArray(gpuResult?.available_models) ? gpuResult.available_models : [];
                    if (gpuModels.length > 0) this.AIconfig.llm.gpustack.available_models = gpuModels;
                    break;
                }
                    
                case 'anthropic':
                    const anthropicCheckCfg = { ...llmConfig.anthropic, api_key: (await this.resolveApiKey(llmConfig.anthropic)) || llmConfig.anthropic.api_key };
                    const anthropicResult = await AIUtils.checkAnthropicConnection(anthropicCheckCfg);
                    this.AIconfig.llm.online = !!anthropicResult?.online;
                    break;
                    
                case 'google':
                    const googleCheckCfg = { ...llmConfig.google, api_key: (await this.resolveApiKey(llmConfig.google)) || llmConfig.google.api_key };
                    const googleResult = await AIUtils.checkGoogleConnection(googleCheckCfg);
                    this.AIconfig.llm.online = !!googleResult?.online;
                    break;
            }
        },

        /** 确保“默认/当前”来源在线：未探测则先跑一次连接检测（独立/子窗口同样适用）；仍不可用返回 false */
        async ensureDefaultModelOnline(): Promise<boolean> {
            if (this.AIconfig.llm.online) return true
            try {
                await this.getAIconfig()
            } catch (e) {
                console.warn('[LLM] 连接检测失败:', e)
            }
            return !!this.AIconfig.llm.online
        },

        /**
         * 测试单个模型来源的 API 状态（设置页每个来源配置块底部的「测试连接」按钮用）。
         * 成功时顺带回填可用模型列表，并把结果写入 llmSourceStatus（左侧来源列表的状态圆点）。
         * @param key     来源 key：ollama / lmstudio / openai / deepseek / deepseek-responses / anthropic / google / azure / custom
         * @param persist 是否立即落盘（批量测试时传 false，最后统一保存）
         */
        async testLlmSource(key: string, persist = true): Promise<{ ok: boolean; models: string[]; status: number }> {
            const llm = this.AIconfig.llm as any
            // 凭据接缝：apiKeyRef 优先，未配置时回退内联 api_key
            const withKey = async (cfg: any) => ({ ...cfg, api_key: (await this.resolveApiKey(cfg)) || cfg?.api_key })
            let ok = false
            let models: string[] = []
            let status = 0
            try {
                switch (key) {
                    case 'ollama': {
                        const r: any = await AIUtils.checkOllamaConnection(llm.ollama)
                        ok = !!r?.online; models = r?.available_models || []
                        if (models.length) llm.ollama.available_models = models
                        break
                    }
                    case 'lmstudio': {
                        const r: any = await AIUtils.checkLMStudioConnection({ base_url: llm.lmstudio.base_url, model: llm.lmstudio.model })
                        ok = !!r?.online; models = r?.available_models || []
                        if (models.length) llm.lmstudio.available_models = models
                        break
                    }
                    case 'openai': {
                        const r: any = await AIUtils.checkOpenAIConnection(await withKey(llm.openai))
                        ok = !!r?.online; models = r?.available_models || []
                        if (models.length) llm.openai.available_models = models
                        break
                    }
                    case 'deepseek':
                    case 'deepseek-responses': {
                        // 单来源：测当前接口样式（chat → /models；responses → Responses 探测），回填对应样式块
                        const style = deepSeekStyleOf(key, llm.deepseek)
                        const dsCfg = deepSeekConfig(llm)
                        const r: any = style === 'responses'
                            ? await AIUtils.checkDeepSeekResponsesConnection(await withKey(dsCfg))
                            : await AIUtils.checkOpenAIConnection(await withKey(dsCfg))
                        ok = !!r?.online; models = r?.available_models || []
                        if (models.length) {
                            const target = style === 'responses' ? llm.deepseekResponses : llm.deepseek
                            target.available_models = models
                        }
                        break
                    }
                    case 'anthropic': {
                        const r: any = await AIUtils.checkAnthropicConnection(await withKey(llm.anthropic))
                        ok = !!r?.online
                        break
                    }
                    case 'google': {
                        const r: any = await AIUtils.checkGoogleConnection(await withKey(llm.google))
                        ok = !!r?.online
                        break
                    }
                    case 'azure': {
                        const r: any = await AIUtils.checkAzureConnection(await withKey(llm.azure))
                        ok = !!r?.online; status = Number(r?.status || 0)
                        break
                    }
                    case 'gpustack': {
                        // GPUStack：内置来源，连接探测复用自定义来源逻辑（api_url = base_url）
                        const r: any = await AIUtils.checkCustomConnection(await withKey({ api_url: llm.gpustack?.base_url || '' }))
                        ok = !!r?.online; models = r?.available_models || []; status = Number(r?.status || 0)
                        if (models.length) llm.gpustack.available_models = models
                        break
                    }
                    case 'custom': {
                        const r: any = await AIUtils.checkCustomConnection(await withKey(llm.custom))
                        ok = !!r?.online; models = r?.available_models || []; status = Number(r?.status || 0)
                        // 回填当前激活自定义来源的模型列表（扁平字段 + sources[activeIndex] 同步）
                        if (models.length) {
                            llm.custom.available_models = models
                            const srcs = Array.isArray(llm.custom?.sources) ? llm.custom.sources : []
                            const idx = (typeof llm.custom?.activeIndex === 'number' && llm.custom.activeIndex >= 0 && llm.custom.activeIndex < srcs.length) ? llm.custom.activeIndex : 0
                            if (srcs[idx]) srcs[idx].available_models = models
                        }
                        break
                    }
                    default:
                        return { ok: false, models: [], status: 0 }
                }
            } catch (e) {
                console.warn('[LLM] 来源 API 状态测试失败:', key, e)
            }
            this.llmSourceStatus = { ...this.llmSourceStatus, [normalizeLlmType(key)]: ok ? 'online' : 'offline' }
            if (persist) this.saveConfig()
            return { ok, models, status }
        },

        // 测试全部模型来源的连接状态（模型设置页左侧列表用；逐来源 check，不依赖当前选中类型）
        // 复用 testLlmSource：顺带回填各来源的可用模型列表（智能体预设等模块的「模型」下拉依赖这份缓存）
        async testAllLlmSources() {
            const llmConfig = this.AIconfig.llm
            const keys = ['ollama', 'lmstudio', 'openai', 'deepseek', 'gpustack', 'anthropic', 'google', 'azure', 'custom']
            await Promise.all(keys.map(async (key) => {
                try {
                    await this.testLlmSource(key, false)
                } catch {
                    this.llmSourceStatus = { ...this.llmSourceStatus, [key]: 'offline' }
                }
            }))

            // 自定义来源：逐个来源测试连接（按 id 记录状态，供左侧列表展示）
            const customCfg = llmConfig.custom
            const customSrcs = Array.isArray(customCfg?.sources) ? customCfg.sources : []
            for (const src of customSrcs) {
                try {
                    if (!String(src?.api_url || '').trim()) {
                        this.llmCustomSourceStatus[src.id] = 'untested'
                        continue
                    }
                    const cfg = { ...src, api_key: (await this.resolveApiKey(src)) || src.api_key }
                    const r = await AIUtils.checkCustomConnection(cfg)
                    this.llmCustomSourceStatus[src.id] = r.online ? 'online' : 'offline'
                } catch {
                    this.llmCustomSourceStatus[src.id] = 'offline'
                }
            }

            this.saveConfig()
        },
        
        // 发送消息到AI（统一入口）- 支持多模态
        async sendToAI(messages: any[], options?: {
            onStream?: (chunk: string) => void,
            onComplete?: (content: string) => void,
            onError?: (error: Error) => void,
            onSearchStatus?: (info: any) => void, // 联网搜索状态回调
            onReasoning?: (text: string) => void, // 思维链文本回调（Responses API reasoning_text）
            webSearch?: boolean, // 显式覆盖联网搜索开关（未传则用全局配置）
            signal?: AbortSignal,  // 添加这一行
            tools?: any[],       // function calling 工具定义（OpenAI 兼容）
            toolChoice?: any,    // 工具选择策略（auto / none / {type:'function',function:{name}}）
            onToolCalls?: (calls: any[]) => void, // 工具调用结果回调（function calling）
            onToolCallArgs?: (callId: string, name: string, argsFragment: string) => void // 工具参数流式增量（function calling）
            requestId?: string, // 主进程 AI 会话 id（断线续传用）
        }) {
            const llmConfig = this.AIconfig.llm;

            // 自愈：ollama model 为空时自动回填真实模型（覆盖 CanvasView/home/knowRAG 等所有走 sendToAI 的入口）
            await this.ensureLlmReady();
            
            if (!this.AIconfig.llm.online) {
                // online 是上次连接检测的缓存标志，可能过期（如工作流 setAIModelConfig 后直接发送、自定义来源刚配好）。
                // 统一接口：先做一次实时连接检测，配置有效（能连通）则不误报"未连接"。
                try {
                    await this.getAIconfig();
                } catch (e) { /* 检测失败保持 offline，由下方统一报错 */ }
            }
            
            if (!this.AIconfig.llm.online) {
                const error = new Error('AI服务未连接，请先检查配置');
                options?.onError?.(error);
                throw error;
            }
            
            // 应用功能配置
            let finalMessages = [...messages];
            
            try {
                // 统一分派到 AIUtils.sendChat（与知识处理模块 kbAiClient 共用同一实现，
                // 所有 provider 的请求构建/凭据解析/流式/工具调用都在该单一入口完成）
                const providerConfig = this.currentLLMConfig
                return await AIUtils.sendChat(llmConfig.type, providerConfig, llmConfig, finalMessages, options)
            } catch (error) {
                console.error('AI请求失败:', error);
                options?.onError?.(error as Error);
                throw error;
            }
        },

        /** 对语音识别文本进行 LLM 校验与标点修正（asr.punctMode==='llm' 时由 asr-manager 调用） */
        async polishSpeechText(text: string): Promise<string> {
            if (!text || !text.trim()) return text
            if (!this.AIconfig.llm.online) {
                // 独立/子窗口或首次使用可能还没跑连接探测：先探测一次，真不可用再跳过
                try { await this.getAIconfig() } catch (e) { /* 探测失败继续走跳过分支 */ }
                if (!this.AIconfig.llm.online) {
                    console.warn('[ASR] 标点校验跳过：默认大模型不可用（探测后仍 offline），返回原文')
                    return text
                }
            }
            console.log(`[ASR] 标点校验开始：原文 ${text.length} 字`)
            try {
                const prompt = [
                    '请对以下语音识别得到的文字进行校对：修正同音/谐音错别字，补全缺失的中文标点符号，必要时适当分段。',
                    '要求：只输出校对后的文字本身，不要添加任何解释、引号、前后缀或多余内容。',
                    '',
                    text.trim()
                ].join('\n')
                let result = ''
                await this.sendToAI([{ role: 'user', content: prompt }], {
                    onStream: (chunk: string) => { result += chunk },
                })
                const polished = result.trim()
                console.log(`[ASR] 标点校验完成：${polished.length} 字`)
                return polished || text
            } catch (e) {
                console.error('[ASR] LLM 标点校验失败，返回原文:', e)
                return text
            }
        },

        /**
         * 凭据接缝（路线图 2.3）：请求时按操作解析 apiKeyRef → 明文。
         * 优先使用配置里的 apiKeyRef（从主进程凭据存储解析），
         * 未配置时回退内联 api_key（向后兼容）。
         */
        async resolveApiKey(config: any): Promise<string | null> {
            const ref = config?.apiKeyRef
            if (typeof ref === 'string' && ref.trim()) {
                try {
                    if (window.dsh?.credentials?.resolve) {
                        const res = await window.dsh.credentials.resolve(ref.trim())
                        if (res?.value) return res.value
                    }
                } catch (e) {
                    console.warn(`[store] 凭据 "${ref}" 解析失败:`, e)
                }
            }
            return config?.api_key || null
        },
        
        // 多模态相关方法
        
        // 添加图片附件
        async addImageAttachment(file: File | string): Promise<string> {
            let imageData: string | Uint8Array | ArrayBuffer;
            let imageType = 'image/jpeg';
            let imageName = '';
            
            if (typeof file === 'string') {
                // 如果是URL或base64字符串
                if (file.startsWith('http')) {
                    imageData = await AIUtils.imageUrlToBase64(file);
                } else {
                    imageData = file;
                }
                imageName = 'image_' + Date.now() + '.jpg';
            } else {
                // 如果是File对象
                imageData = await AIUtils.imageToBase64(file);
                imageType = file.type;
                imageName = file.name;
            }
            
            const id = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            this.imageAttachments.push({
                id,
                data: imageData,
                type: imageType,
                name: imageName
            });
            
            return id;
        },
        
        // 移除图片附件
        removeImageAttachment(id: string) {
            const index = this.imageAttachments.findIndex(img => img.id === id);
            if (index !== -1) {
                this.imageAttachments.splice(index, 1);
            }
        },
        
        // 清除所有图片附件
        clearImageAttachments() {
            this.imageAttachments = [];
        },
        
        // 创建包含图片的消息
        createImageMessage(role: string, content: string, imageIds?: string[]) {
            const images: Array<string | Uint8Array> = [];
            
            if (imageIds && imageIds.length > 0) {
                imageIds.forEach(id => {
                    const attachment = this.imageAttachments.find(img => img.id === id);
                    if (attachment) {
                        if (typeof attachment.data === 'string') {
                            images.push(attachment.data);
                        } else if (attachment.data instanceof Uint8Array) {
                            images.push(attachment.data);
                        } else if (attachment.data instanceof ArrayBuffer) {
                            images.push(new Uint8Array(attachment.data));
                        }
                    }
                });
            }
            
            return AIUtils.createImageMessage(role, content, images);
        },
        
        copyToClipboard(text: string) {
            const tempTextArea = document.createElement('textarea')
            tempTextArea.value = text
            document.body.appendChild(tempTextArea)
            tempTextArea.select()
            document.execCommand('copy')
            document.body.removeChild(tempTextArea)
        },
        
        // 使用系统默认应用打开文件
        openByApp: async (path: string) => {
            await window.ipcRenderer.invoke('openByApp', path)
        },
        
        StampToDate(date?: any) {
            if (date == undefined || !(date instanceof Date)) date = new Date()
            const year = date.getFullYear();
            const month = ('0' + (date.getMonth() + 1)).slice(-2);
            const day = ('0' + date.getDate()).slice(-2);
            const hour = ('0' + date.getHours()).slice(-2);
            const min = ('0' + date.getMinutes()).slice(-2);
            const sec = ('0' + date.getSeconds()).slice(-2);
            return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
        },
        
        // 图标
        icon: function (extension: any) {
            let c = "fa fa-th"
            const ext = String(extension || '').toLowerCase()
            switch (ext) {
                case "folder":
                    c = "fa fa-folder";
                    break;
                case ".kb":
                    c = "fa fa-database";
                    break;
                case ".task":
                    // 脚手架任务文件（Agent脚手架实例保存的状态文件）：列表图标用任务清单，
                    // 与 .kb(fa-database) / .flow(fa-stumbleupon) / .md(fa-file-text-o) 区分
                    c = "fa fa-tasks";
                    break;
                case ".flow":
                    c = "fa fa-stumbleupon";
                    break;
                case ".md":
                    c = "fa fa-file-text-o";
                    break;
                case ".txt":
                    c = "fa fa-file-text-o";
                    break;
                case ".ini":
                    c = "fa fa-cog";
                    break;
                case ".toml":
                case ".yaml":
                case ".yml":
                case ".cfg":
                case ".conf":
                case ".properties":
                case ".xml":
                    c = "fa fa-cog";
                    break;
                case ".pptx":
                    c = "fa fa-file-powerpoint-o";
                    break;
                case ".ppt":
                    c = "fa fa-file-powerpoint-o";
                    break;
                case ".doc":
                    c = "fa fa-file-word-o";
                    break;
                case ".docx":
                    c = "fa fa-file-word-o";
                    break;
                case ".xls":
                    c = "fa fa-file-excel-o";
                    break;
                case ".xlsx":
                    c = "fa fa-file-excel-o";
                    break;
                case ".zip":
                    c = "fa fa-file-archive-o";
                    break;
                case ".rar":
                    c = "fa fa-file-archive-o";
                    break;
                case ".png":
                    c = "fa fa-file-image-o ";
                    break;
                case ".jpg":
                    c = "fa fa-file-image-o ";
                    break;
                case ".jpeg":
                    c = "fa fa-file-image-o ";
                    break;
                case ".webp":
                    c = "fa fa-file-image-o ";
                    break;
                case ".pdf":
                    c = "fa fa-file-pdf-o";
                    break;
                case ".html":
                    c = "fa fa-file-code-o";
                    break;
                case ".js":
                    c = "fa fa-file-code-o";
                    break;
                case ".css":
                    c = "fa fa-file-code-o";
                    break;
                case ".json":
                    c = "fa fa-file-code-o";
                    break;
                case ".ts":
                    c = "fa fa-file-code-o";
                    break;
                case ".jsx":
                case ".tsx":
                case ".vue":
                case ".scss":
                case ".less":
                case ".sass":
                case ".java":
                case ".c":
                case ".h":
                case ".cpp":
                case ".hpp":
                case ".cs":
                case ".go":
                case ".rs":
                case ".rb":
                case ".php":
                case ".swift":
                case ".kt":
                case ".sql":
                case ".py":
                    c = "fa fa-file-code-o";
                    break;
                case ".sh":
                case ".bat":
                case ".cmd":
                case ".ps1":
                    c = "fa fa-terminal";
                    break;
                case ".csv":
                case ".tsv":
                    c = "fa fa-table";
                    break;
                case ".log":
                    c = "fa fa-file-text-o";
                    break;
                case ".mp4":
                    c = "fa fa-file-video-o";
                    break;
                case ".wmv":
                    c = "fa fa-file-video-o";
                    break;
                case ".avi":
                    c = "fa fa-file-video-o";
                    break;
                case "flv":
                    c = "fa fa-file-video-o";
                    break;
                case ".mp3":
                    c = "fa fa-file-audio-o";
                    break;
                case ".m4a":
                    c = "fa fa-file-audio-o";
                    break;
                case ".wb":
                    c = "fa fa-file-o";
                    break;
                case ".excalidraw":
                    c = "fa fa-paint-brush";
                    break;
                case ".drawio":
                case ".dio":
                    // 不用 fa-sitemap：与工作流文件 .flow 的 fa-stumbleupon 都是「节点分支」图形，肉眼易混
                    c = "fa fa-object-group";
                    break;
                case ".exe":
                case ".msi":
                case ".dll":
                case ".apk":
                case ".dmg":
                case ".deb":
                case ".rpm":
                case ".appimage":
                case ".run":
                case ".bin":
                case ".flatpak":
                case ".snap":
                    c = "fa fa-cogs";
                    break;
                case ".iso":
                    c = "fa fa-compact-disc";
                    break;
                default:
                    c = "fa fa-th";
            }
            return c
        },
        
        // 切换模型类型（单来源：历史别名 'deepseek-responses' 归一到 'deepseek'）
        switchLLMType(type: string) {
            const t = normalizeLlmType(type)
            if (this.AIconfig.llm.types.includes(t)) {
                this.AIconfig.llm.type = t;
                this.AIconfig.llm.online = false;
                this.saveConfig();
            }
        },
        
        // 设置OpenAI兼容API配置
        setOpenAIConfig(config: {
            api_key: string;
            base_url?: string;
            model?: string;
        }) {
            if (config.api_key) {
                this.AIconfig.llm.openai.api_key = config.api_key;
            }
            if (config.base_url) {
                this.AIconfig.llm.openai.base_url = config.base_url;
            }
            if (config.model) {
                this.AIconfig.llm.openai.model = config.model;
            }
        },
        
        // 重置配置
        resetLLMConfig(type: string) {
            switch (type) {
                case 'ollama':
                    this.AIconfig.llm.ollama = {
                        model_url: 'http://127.0.0.1:11434',
                        model: '',
                        embed_model: '',
                        available_models: [],
                    };
                    break;
                case 'lmstudio':
                    this.AIconfig.llm.lmstudio = {
                        base_url: 'http://localhost:1234',
                        model: '',
                        embed_model: '',
                        available_models: [],
                        api_key: '',
                        apiKeyRef: '',
                    };
                    break;
                case 'openai':
                    this.AIconfig.llm.openai = {
                        api_key: '',
                        base_url: 'https://api.openai.com/v1',
                        model: 'gpt-4o-mini',
                        embed_model: '',
                        available_models: [],
                        apiKeyRef: '',
                    };
                    break;
                case 'deepseek':
                    this.AIconfig.llm.deepseek = {
                        api_key: '',
                        base_url: 'https://api.deepseek.com',
                        // 接口样式是「来源级」设置：重置连接参数不改样式
                        api_style: (this.AIconfig.llm.deepseek?.api_style === 'responses' ? 'responses' : 'chat'),
                        model: 'deepseek-flash',
                        embed_model: '',
                        available_models: [],
                        apiKeyRef: '',
                    };
                    break;
                case 'deepseek-responses':
                    // Responses 样式的凭据/模型记忆块（DeepSeek 单来源内的接口样式，不再是独立来源）
                    this.AIconfig.llm.deepseekResponses = {
                        api_key: '',
                        base_url: 'https://api.deepseek.com',
                        model: 'deepseek-flash',
                        embed_model: '',
                        available_models: [],
                        apiKeyRef: '',
                    };
                    break;
                case 'gpustack':
                    this.AIconfig.llm.gpustack = {
                        base_url: 'http://localhost',
                        api_key: '',
                        model: '',
                        embed_model: '',
                        available_models: [],
                        apiKeyRef: '',
                    };
                    break;
                case 'anthropic':
                    this.AIconfig.llm.anthropic = {
                        api_key: '',
                        model: 'claude-3-haiku-20240307',
                        api_version: '2023-06-01',
                        embed_model: '',
                        apiKeyRef: '',
                        available_models: [],
                    };
                    break;
                case 'google':
                    this.AIconfig.llm.google = {
                        api_key: '',
                        model: 'gemini-pro',
                        embed_model: '',
                        apiKeyRef: '',
                        available_models: [],
                    };
                    break;
                case 'azure':
                    this.AIconfig.llm.azure = {
                        api_key: '',
                        endpoint: '',
                        deployment: '',
                        embed_model: '',
                        api_version: '2024-02-15-preview',
                        apiKeyRef: '',
                        available_models: [],
                    };
                    break;
                case 'custom':
                    this.AIconfig.llm.custom = {
                        name: 'Custom',
                        api_url: '',
                        api_key: '',
                        model: '',
                        embed_model: '',
                        headers: {},
                        request_body: {},
                        apiKeyRef: '',
                        available_models: [],
                        sources: [{
                            id: Date.now(),
                            name: 'Custom',
                            api_url: '',
                            api_key: '',
                            apiKeyRef: '',
                            model: '',
                            embed_model: '',
                            available_models: [],
                        }],
                        activeIndex: 0,
                    };
                    break;
            }
            this.AIconfig.llm.online = false;
        },
        
        // 测试API连接
        async testConnection() {
            try {
                await this.getAIconfig();
                return this.AIconfig.llm.online;
            } catch (error) {
                console.error('测试连接失败:', error);
                return false;
            }
        },
        
        // 设置TTS语速
        setTTSRate(rate: number) {
            this.AIconfig.tts.rate = rate;
            // 如果是Qwen3-TTS，同时更新特定配置
            if (this.AIconfig.tts.type === 'Qwen3-TTS') {
                this.AIconfig.tts.qwen3.speed = rate;
            }
            if (this.ttsManager) {
                this.ttsManager.setRate(rate);
            }
        },
        
        // 设置TTS音高
        setTTSPitch(pitch: number) {
            this.AIconfig.tts.pitch = pitch;
            // 如果是Qwen3-TTS，同时更新特定配置
            if (this.AIconfig.tts.type === 'Qwen3-TTS') {
                this.AIconfig.tts.qwen3.pitch = pitch;
            }
            if (this.ttsManager) {
                this.ttsManager.setPitch(pitch);
            }
        },
        
        // 设置TTS声音
        setTTSVoice(voice: string) {
            this.AIconfig.tts.voice = voice;
            if (this.ttsManager) {
                this.ttsManager.setVoice(voice);
            }
        },
        
        // 设置TTS语言
        setTTSLanguage(language: string) {
            this.AIconfig.tts.language = language;
            if (this.ttsManager) {
                this.ttsManager.setLanguage(language);
            }
        },
        
        // 设置TTS情感
        setTTSEmotion(emo: string) {
            this.AIconfig.tts.emo = emo;
            if (this.ttsManager) {
                this.ttsManager.setEmotion(emo);
            }
        },
        
        // 设置TTS权重
        setTTSWeight(weight: number) {
            this.AIconfig.tts.weight = weight;
            if (this.ttsManager) {
                this.ttsManager.setWeight(weight);
            }
        }
    }
})