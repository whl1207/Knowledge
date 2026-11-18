<script setup lang="ts">
import { aikmIpc } from '@/lib/aikmIpc'
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'
import strategyConfig from '@/components/KnowledgeBase/knowledge/strategyConfig.vue'
import { getPlatform } from '@/platform'
import {
  isVectorDbAvailable,
  getVectorDbInfo,
  migrateKbToVectorDb,
  exportVectorDbPortable,
  deleteVectorDb,
  formatVectorBytes,
  kbdbPathOf,
  upsertFileVectorsToDb,
  closeVectorDbHandle,
  type KbVectorDbInfo,
} from '@/lib/kbVectorDb'

// 定义组件接口
interface Props {
  store: any
  model: any
  getModel: () => Promise<void>
  /** 模块工具栏的三个配置按钮决定当前分组 */
  initialGroup?: 'knowledgebase' | 'strategy' | 'process'
}

const props = defineProps<Props>()

// 定义类型
interface ConfigGroup {
  title: string
  icon: string
  description: string
}

interface ConfigItemOption {
  value?: string
  label?: string
  name?: string
  size?: number
}

interface ConfigItem {
  group: string
  key: string
  label: string
  labelEn: string
  type: 'text' | 'select' | 'number' | 'range' | 'textarea' | 'checkbox' | 'display' | 'embed'
  placeholder?: string
  placeholderEn?: string
  description: string
  descriptionEn: string
  options?: ConfigItemOption[] | any
  min?: number
  max?: number
  step?: number
  value?: string | (() => string)
  show?: () => boolean
  /** true = 勾选框文案直接显示 label，不加「启用 」前缀（label 本身已是完整动作句） */
  noPrefix?: boolean
}

interface KnowledgeBaseFile {
  label: string
  path: string
  /** 知识库说明：在右侧详情里编辑，随 .kb 的 description 字段保存 */
  description?: string
  config?: {
    embedModel?: string
    timestamp?: string
    version?: string
    blockCount?: number
    /** 是否把向量数据写入 .kb（false=精简模式，向量按需在首次问答重新推导） */
    saveVectors?: boolean
    /** 3.2：保存时自动写入 <库名>.kbdb（缺省视为开启） */
    autoVectorDb?: boolean
    /** 向量库精度：float32（默认）/ int8（约 1/4 体积） */
    vectorQuant?: 'float32' | 'int8'
    /** 是否把测试结果写入侧车文件（3.1 起 .kb 不再内联 testData） */
    saveTestResults?: boolean
    /** 测试结果侧车文件名（与 .kb 同目录；空=没有测试结果文件） */
    testDataFile?: string
    /** 3.2：向量库引用（向量存 .kbdb，.kb 不再内联 A_vector） */
    vectorStore?: { file?: string; dim?: number }
  }
  metadata?: {
    blockCount?: number
    hasEmbeddings?: boolean
    hasQuestions?: boolean
    avgVectorDimension?: number
    reasonedCount?: number
    /** 问题库活动问题总数（含手动/导入，未合并） */
    questionCount?: number
    fileCount?: number
  }
  ontology?: {
    entities?: number
    relations?: number
    communityCount?: number
    communityReportCount?: number
  }
}

// 本地化文本
const t = (zh: string, en: string): string => {
  return props.store.locales === 'zh' ? zh : en
}

// 配置分组（顺序即侧边栏顺序：版本 → 策略 → 设置）
const configGroups = computed<Record<string, ConfigGroup>>(() => ({
  knowledgebase: {
    title: t('版本', 'Versions'),
    icon: 'fa fa-database',
    description: t('知识库版本、保存与清理', 'Knowledge base versions, saving and cleanup')
  },
  strategy: {
    title: t('策略', 'Strategies'),
    icon: 'fa fa-cubes',
    description: t('检索策略：原语组合、参数与检索参数', 'Retrieval Strategy: primitive composition, params & retrieval params')
  },
  process: {
    title: t('设置', 'Settings'),
    icon: 'fa fa-cogs',
    description: t('切片、问题处理与本体推理配置', 'Slicing, Question Processing & Ontology Configuration')
  }
}))

// 知识库文件列表
const knowledgeBases = ref<KnowledgeBaseFile[]>([])
const isLoadingKb = ref(false)
/** 当前选中的知识库（按路径，不按索引：两个列表的排序不同） */
const selectedKbPath = ref('')
const selectedKb = computed<KnowledgeBaseFile | null>(
  () => knowledgeBases.value.find((k) => k.path === selectedKbPath.value) || null
)
/** 说明编辑态 */
const editingDescription = ref(false)
const descriptionDraft = ref('')
const savingDescription = ref(false)
const kbScanPath = ref('')

// ==================== 向量库（.kbdb）状态与操作 ====================
const vectorDbAvailable = ref<boolean | null>(null)
/** 不可用时的原因（用于界面提示：主进程没重启 / 运行时没有 node:sqlite） */
const vectorDbError = ref('')
const vectorDb = ref<KbVectorDbInfo | null>(null)
const vectorDbLoading = ref(false)
const vectorDbBusy = ref(false)
/** 迁移进度文本（空 = 没在跑） */
const vectorDbProgress = ref('')

async function refreshVectorDb(): Promise<void> {
  const kb = selectedKb.value
  vectorDb.value = null
  if (!kb) return
  // 每次选库都重新探测：主进程刚重启/面板早于主进程就绪打开时，
  // 之前缓存下来的 false 不能一直粘着（用户看到的"不支持"可能只是探早了）。
  const probe = await isVectorDbAvailable()
  vectorDbAvailable.value = !!probe?.available
  vectorDbError.value = probe?.available ? '' : String(probe?.error || '')
  if (!vectorDbAvailable.value) return
  vectorDbLoading.value = true
  try {
    vectorDb.value = await getVectorDbInfo(kb.path)
  } catch (e) {
    console.warn(t('读取向量库状态失败:', 'Failed to read vector DB stats:'), e)
  } finally {
    vectorDbLoading.value = false
  }
}

/** 「重试检测」：清掉上次结论后再探一次 */
async function retryVectorDbProbe(): Promise<void> {
  vectorDbAvailable.value = null
  vectorDbError.value = ''
  const kb = selectedKb.value
  if (!kb) return
  const probe = await isVectorDbAvailable()
  vectorDbAvailable.value = !!probe?.available
  vectorDbError.value = probe?.available ? '' : String(probe?.error || '')
  if (vectorDbAvailable.value) await refreshVectorDb()
}

/** 不可用提示里追加可操作原因（通道缺失 = 主进程还没重启） */const vectorDbUnavailableText = computed<string>(() => {
  const err = vectorDbError.value
  const zh = props.store.locales === 'zh'
  const channelMissing = /no handler|not registered|未找到.*(通道|handler)|No handler registered/i.test(err)
  if (channelMissing) {
    return zh
      ? `主进程还没重启（缺少 kb:vector 通道）：请完全退出 AI-KM 后重新启动（只刷新页面不够）。${err ? `（${err}）` : ''}`
      : `The main process has not been restarted yet (kb:vector channel missing). Fully quit AI-KM and start it again (a page refresh is not enough).${err ? ` (${err})` : ''}`
  }
  return zh
    ? `当前环境不支持向量库：${err || '主进程未内置 node:sqlite'}`
    : `Vector DB is unavailable here: ${err || 'node:sqlite is not built into the main process'}`
})

/** 把 .kb 里已有的向量批量搬进 .kbdb（也在"重建"时用） */
async function migrateVectors(): Promise<void> {
  const kb = selectedKb.value
  if (!kb || vectorDbBusy.value) return
  const zh = props.store.locales === 'zh'
  vectorDbBusy.value = true
  vectorDbProgress.value = ''
  try {
    const desiredQuant = String((props.model as any)?.vectorQuant || 'float32') === 'int8' ? 'int8' : 'float32'
    const existing = await getVectorDbInfo(kb.path).catch(() => null)
    if (existing?.exists && existing.stats.quant && existing.stats.quant !== desiredQuant) {
      emit('updateState', zh
        ? `向量库精度是 ${existing.stats.quant}，与当前设置 ${desiredQuant} 不同：请用「重建向量库」按新精度重写`
        : `Vector DB precision is ${existing.stats.quant} but current setting is ${desiredQuant}; use "Rebuild vector DB" to rewrite it`)
      return
    }
    const text = await getPlatform().fs.readText(kb.path)
    const data = JSON.parse(text)
    const model = String(kb.config?.embedModel || data.config?.embedModel || '')
    const res = await migrateKbToVectorDb(kb.path, data.blocks || [], {
      model,
      quant: String((props.model as any)?.vectorQuant || ''),
      onProgress: (done, total) => {
        vectorDbProgress.value = `${done}/${total}`
        emit('updateState', zh ? `写入向量库 ${done}/${total}…` : `Writing vectors ${done}/${total}…`)
      },
    })
    if (!res.total) {
      emit('updateState', zh
        ? '这个 .kb 没有可迁移的向量（精简模式未保存向量）：先开启「保存向量数据」并保存一次'
        : 'No vectors to migrate (slim mode): enable "save vectors" and save the KB once first')
      return
    }
    // 文件级摘要向量也迁移进库（3.2 下 .kb 会去掉它们）
    try {
      const items = Object.entries(data.fileIndex || {})
        .filter(([, v]: any) => Array.isArray(v?.vector) && v.vector.length > 0)
        .map(([file, v]: any) => ({ file: String(file), vector: v.vector as number[] }))
      if (items.length) await upsertFileVectorsToDb(kb.path, items, String(selectedKb.value?.config?.vectorQuant || ''))
    } catch (e) {
      console.warn('[configManager] 迁移文件向量失败（检索时会按需重算）:', e)
    }
    // 迁移完成后立刻把 .kb 瘦身（3.2：去掉内联 A_vector，检索默认走向量库），
    // 否则用户会看到"向量库建好了，但 .kb 还是原来那么大"。
    const slim = await slimKbAfterMigration(kb, model)
    await refreshVectorDb()
    await refreshKbFiles()
    emit('updateState', zh
      ? `向量库完成：写入 ${res.written} 条、跳过 ${res.skipped} 条（共 ${res.total} 条，${res.dim} 维）${slim?.ok ? `；.kb 已瘦身 ${formatVectorBytes(slim.before)} → ${formatVectorBytes(slim.after)}` : '；库还不完整，暂未瘦身 .kb'}`
      : `Vector DB ready: ${res.written} written, ${res.skipped} skipped (${res.total} total, ${res.dim}-dim)${slim?.ok ? `; .kb slimmed ${formatVectorBytes(slim.before)} → ${formatVectorBytes(slim.after)}` : '; DB incomplete, .kb not slimmed'}`)
  } catch (e: any) {
    console.error(t('写入向量库失败:', 'Failed to write vector DB:'), e)
    emit('updateState', zh ? `写入向量库失败：${e?.message || e}` : `Failed to write vector DB: ${e?.message || e}`)
  } finally {
    vectorDbBusy.value = false
    vectorDbProgress.value = ''
  }
}

/**
 * 迁移成功后把 `.kb` 就地改成 3.2：删除 blocks[].A_vector、写入 config.vectorStore。
 * 只有「库向量数 ≥ 切片数」时才做，避免库不完整时把还没入库的向量弄丢。
 */
async function slimKbAfterMigration(
  kb: any,
  model: string,
): Promise<{ ok: boolean; before: number; after: number } | null> {
  try {
    const info = await getVectorDbInfo(kb.path)
    if (!info?.exists) return null
    const text = await getPlatform().fs.readText(kb.path)
    const data = JSON.parse(text)
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    if (!blocks.length || info.stats.vectors < blocks.length) return null
    for (const b of blocks) delete b.A_vector
    data.config = {
      ...(data.config || {}),
      version: '3.2',
      saveVectors: false,
      vectorQuant: info.stats.quant === 'int8' ? 'int8' : 'float32',
      vectorStore: {
        kind: 'kbdb',
        file: kbdbPathOf(kb.path).replace(/\\/g, '/').split('/').pop(),
        dim: info.stats.dim,
        model: model || String(data.config?.embedModel || ''),
        metric: 'cosine',
        vectors: info.stats.vectors,
      },
    }
    const out = JSON.stringify(data)
    const ok = await getPlatform().fs.saveText(kb.path, out)
    if (ok) {
      await scanKnowledgeBases()
      // 重新选中当前库（扫描后列表对象是新的）
      const idx = knowledgeBases.value.findIndex((x: any) => String(x.path).replace(/\\/g, '/') === String(kb.path).replace(/\\/g, '/'))
      if (idx >= 0) {
        selectedKbPath.value = knowledgeBases.value[idx].path
      }
    }
    return { ok, before: text.length, after: out.length }
  } catch (e) {
    console.warn('[configManager] 瘦身 .kb 失败（向量库已写入，.kb 保持原样）:', e)
    return null
  }
}

/** 重建向量库：请求主模块重新向量化全部切片 → 写 .kbdb → 瘦身 .kb */
async function rebuildVectors(): Promise<void> {
  const kb = selectedKb.value
  if (!kb || vectorDbBusy.value) return
  const zh = props.store.locales === 'zh'
  try {
    await ElMessageBox.confirm(
      zh ? `重新向量化「${kb.label}」的全部切片并重建 .kbdb？会先重新嵌入所有切片（耗时取决于嵌入模型与切片数），完成后 .kb 会瘦身。`
        : `Re-embed all slices of "${kb.label}" and rebuild .kbdb? This re-embeds every slice (time depends on the embed model and slice count); the .kb is slimmed afterwards.`,
      t('重建向量库', 'Rebuild vector DB'),
      { confirmButtonText: t('开始重建', 'Rebuild'), cancelButtonText: t('取消', 'Cancel'), type: 'warning' },
    )
  } catch { return }
  emit('updateState', zh ? '已请求重建向量库：重新向量化全部切片…' : 'Rebuild requested: re-embedding all slices…')
  emit('rebuildVectorDb')
}

/** 导出干净单文件（xxx.portable.kbdb），用于拷贝/归档 */
async function exportVectors(): Promise<void> {
  const kb = selectedKb.value
  if (!kb || vectorDbBusy.value) return
  const zh = props.store.locales === 'zh'
  vectorDbBusy.value = true
  try {
    const res = await exportVectorDbPortable(kb.path)
    await refreshKbFiles()
    emit('updateState', zh
      ? `已导出便携包：${res.target}（${formatVectorBytes(res.bytes)}）`
      : `Portable DB exported: ${res.target} (${formatVectorBytes(res.bytes)})`)
  } catch (e: any) {
    emit('updateState', zh ? `导出失败：${e?.message || e}` : `Export failed: ${e?.message || e}`)
  } finally {
    vectorDbBusy.value = false
  }
}

/** 删除 `.kbdb`（索引可随时用 .kb 里的向量重建） */
async function removeVectors(): Promise<void> {
  const kb = selectedKb.value
  if (!kb || vectorDbBusy.value) return
  const zh = props.store.locales === 'zh'
  try {
    await ElMessageBox.confirm(
      zh ? `删除「${kb.label}」的向量库（.kbdb）？删除后检索会退化为"按需重新计算全部切片向量"（首次很慢），直到重新构建向量库。`
        : `Delete the vector DB (.kbdb) for "${kb.label}"? Retrieval will fall back to re-computing all slice vectors on demand (slow first time) until you rebuild it.`,
      t('提示', 'Confirm'),
      { confirmButtonText: t('删除', 'Delete'), cancelButtonText: t('取消', 'Cancel'), type: 'warning' },
    )
  } catch { return }
  vectorDbBusy.value = true
  try {
    const res = await deleteVectorDb(kb.path)
    await refreshVectorDb()
    await refreshKbFiles()
    emit('updateState', zh ? `已删除向量库（${res.removed} 个文件）` : `Vector DB deleted (${res.removed} files)`)
  } catch (e: any) {
    emit('updateState', zh ? `删除向量库失败：${e?.message || e}` : `Failed to delete vector DB: ${e?.message || e}`)
  } finally {
    vectorDbBusy.value = false
  }
}

// ==================== 知识库相关文件（每个文件一张卡片，含大小） ====================
interface KbSideFile {
  name: string
  path: string
  size: number
  mtime: number
  /** 角色标识（用于图标 / 文案） */
  role: 'kb' | 'kbdb' | 'kbdb-runtime' | 'testdata' | 'learning' | 'learningIndex' | 'exams' | 'portable'
  roleLabel: string
  roleEn: string
  icon: string
}

/** 时间戳显示（meta 里存 ISO 字符串） */
function fmtDbTime(s?: string): string {
  if (!s) return ''
  const t = new Date(s)
  return Number.isNaN(t.getTime()) ? s : t.toLocaleString()
}

const kbFiles = ref<KbSideFile[]>([])
const kbFilesLoading = ref(false)

// 详情页按文件卡片组织：.kb / .kbdb 单独大卡，其余附属文件进两列小卡
const kbMainFile = computed(() => kbFiles.value.find((f) => f.role === 'kb'))
const kbDbFile = computed(() => kbFiles.value.find((f) => f.role === 'kbdb'))
const kbRuntimeFiles = computed(() => kbFiles.value.filter((f) => f.role === 'kbdb-runtime'))
const kbSideFiles = computed(() => kbFiles.value.filter((f) => !['kb', 'kbdb', 'kbdb-runtime'].includes(f.role)))

/** 时间戳（毫秒）→ 本地可读时间 */
function fmtMsTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/** 导航/标题里显示知识库名：去掉 .kb 后缀（文件卡片里仍显示完整文件名） */
function displayKbName(label?: string): string {
  return String(label || '').replace(/\.kb$/i, '')
}

const KB_SIDE_FILE_ROLES: Array<{ test: (name: string, stem: string) => boolean; role: KbSideFile['role']; zh: string; en: string; icon: string }> = [
  { test: (n, s) => n.toLowerCase() === `${s}.kb`.toLowerCase(), role: 'kb', zh: '知识库', en: 'Knowledge base', icon: 'fa-database' },
  { test: (n, s) => n.toLowerCase() === `${s}.kbdb`.toLowerCase(), role: 'kbdb', zh: '向量库', en: 'Vector DB', icon: 'fa-cubes' },
  { test: (n, s) => /\.kbdb-(wal|shm)$/i.test(n), role: 'kbdb-runtime', zh: '向量库运行时', en: 'Vector DB WAL', icon: 'fa-clock-o' },
  { test: (n, s) => n.toLowerCase() === `${s}.testdata.json`.toLowerCase(), role: 'testdata', zh: '测试结果', en: 'Test results', icon: 'fa-flask' },
  { test: (n, s) => n.toLowerCase() === `${s}.learning`.toLowerCase(), role: 'learning', zh: '学习记录', en: 'Learning records', icon: 'fa-graduation-cap' },
  { test: (n, s) => n.toLowerCase() === `${s}.learning.json`.toLowerCase(), role: 'learningIndex', zh: '学习记录索引', en: 'Learning index', icon: 'fa-list-alt' },
  { test: (n, s) => n.toLowerCase() === `${s}.exams.json`.toLowerCase(), role: 'exams', zh: '试卷库', en: 'Exam papers', icon: 'fa-file-text-o' },
  { test: (n, s) => n.toLowerCase() === `${s}.portable.kbdb`.toLowerCase(), role: 'portable', zh: '便携向量库', en: 'Portable DB', icon: 'fa-archive' },
]

function roleOfFile(name: string, stem: string): { role: KbSideFile['role']; zh: string; en: string; icon: string } | null {
  for (const r of KB_SIDE_FILE_ROLES) if (r.test(name, stem)) return { role: r.role, zh: r.zh, en: r.en, icon: r.icon }
  return null
}

/** 列出该知识库同目录下的所有相关文件（.kb / .kbdb / 测试结果 / 学习记录 / 试卷 …）及大小 */
async function refreshKbFiles(): Promise<void> {
  const kb = selectedKb.value
  kbFiles.value = []
  if (!kb?.path) return
  const normalized = String(kb.path).replace(/\\/g, '/')
  const dir = normalized.slice(0, normalized.lastIndexOf('/'))
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  const stem = fileName.replace(/\.kb$/i, '')
  kbFilesLoading.value = true
  try {
    const res = await getPlatform().fs.listTreeWithRelations(dir, 1)
    const files = (res?.fileList || []).filter((f: any) => f?.type === 'file')
    const out: KbSideFile[] = []
    for (const f of files) {
      const name = String(f.label || '').replace(/\\/g, '/').split('/').pop() || ''
      const role = roleOfFile(name, stem)
      if (!role) continue
      out.push({
        name,
        path: String(f.path || ''),
        size: Number(f.size) || 0,
        mtime: Number(f.mtime) || 0,
        role: role.role,
        roleLabel: role.zh,
        roleEn: role.en,
        icon: role.icon,
      })
    }
    // 顺序固定：知识库 → 向量库（含运行时）→ 测试结果 → 学习 → 试卷 → 便携包
    const order = ['kb', 'kbdb', 'kbdb-runtime', 'testdata', 'learning', 'learningIndex', 'exams', 'portable']
    out.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name))
    kbFiles.value = out
  } catch (e) {
    console.warn(t('列知识库相关文件失败:', 'Failed to list KB files:'), e)
  } finally {
    kbFilesLoading.value = false
  }
}

/** 在系统文件管理器里定位某个相关文件 */
async function revealKbFile(file: KbSideFile): Promise<void> {
  try {
    const ok = await getPlatform().shell.revealInFolder(file.path)
    if (ok) return
    await openKbFolder()
  } catch { /* 忽略：定位失败不阻断 */ }
}

// 配置项
const configItems = computed<ConfigItem[]>(() => [
  {
    group: 'process',
    key: 'embed',
    label: '嵌入模型',
    labelEn: 'Embedding Model',
    type: 'embed',
    description: '知识库切片/问题的向量化所用嵌入模型。选择「跟随默认」则使用设置页中配置的默认嵌入模型；选择其它模型后，会清空旧向量并用新模型重新向量化切片与问题（否则新旧向量维度不一致会导致检索失效）。',
    descriptionEn: 'Embedding model used to vectorize KB slices & questions. "Follow default" uses the default embedding model from Settings. Choosing another model clears old vectors and re-embeds slices & questions with it (mixed-dimension vectors break retrieval).'
  },
  {
    group: 'process',
    key: 'autoVectorDb',
    label: '自动写入向量库（.kbdb）',
    labelEn: 'Auto-write vector DB (.kbdb)',
    type: 'checkbox',
    noPrefix: true,
    description: '开启（默认）：保存知识库时自动把切片向量写入同目录的「<库名>.kbdb」，.kb 不再内联向量（3.2，文件明显变小），检索默认走向量库；库还不完整（有新切片未向量化）时本次仍写内联，下次保存自动转成瘦身版。关闭：不自动创建新库（已存在的 .kbdb 仍会增量同步，避免丢向量）。运行环境没有内置 node:sqlite 时自动退回内联向量。',
    descriptionEn: 'ON (default): saving the KB automatically writes slice vectors into "<kb>.kbdb" next to the .kb; the .kb no longer inlines vectors (3.2, much smaller) and retrieval uses the vector DB by default. If the DB is incomplete (new slices not embedded yet) this save keeps inline vectors and the next save slims the file. OFF: no new DB is created (an existing .kbdb is still kept in sync so vectors are not lost). Runtimes without built-in node:sqlite fall back to inline vectors.'
  },
  {
    group: 'process',
    key: 'vectorQuant',
    label: '向量库精度',
    labelEn: 'Vector DB precision',
    type: 'select',
    options: [
      { value: 'float32', label: t('float32（精确，体积大）', 'float32 (exact, larger)') },
      { value: 'int8', label: t('int8（约 1/4 体积，略损精度）', 'int8 (~1/4 size, slight precision loss)') },
    ],
    description: '写入 .kbdb 时的向量精度：float32 最精确；int8 每个向量只多存一个 scale，体积约为 float32 的 1/4，检索分数略降。修改精度后需要点「重建向量库」才会重写已有向量。',
    descriptionEn: 'Precision used when writing .kbdb: float32 is exact; int8 stores one scale per vector and takes about 1/4 of the space with a small retrieval-score loss. After changing it, use "Rebuild vector DB" to rewrite existing vectors.'
  },
  {
    group: 'process',
    key: 'saveTestResults',
    label: '保存测试结果（单独文件）',
    labelEn: 'Save test results (separate file)',
    type: 'checkbox',
    noPrefix: true,
    description: '开启：保存知识库时把测试页的检索结果、位次分析、策略召回对比统计与智能路由检索过程写入同目录的单独文件「<库名>.testdata.json」，下次加载即可直接查看/导出（无需重跑），便于复现实验与写论文；.kb 本体保持精简。关闭（默认）：只保存测试用例（问题/参考答案/关联切片），结果需重跑；已存在的 .testdata.json 不会被删除。注意：结果按切片 id 回源，重新切片或换库后旧结果的正文与命中标记可能失配。',
    descriptionEn: 'ON: saving the KB writes the test page results — retrieval results, rank analysis, strategy recall stats and agentic retrieval traces — into a SEPARATE file "<kb>.testdata.json" in the same folder, so they can be reviewed/exported after reloading without re-running (great for reproducibility); the .kb itself stays small. OFF (default): only test cases are saved; results must be re-run; an existing .testdata.json is left untouched. Note: results reference slices by id, so after re-slicing or switching KBs text/hit marks may mismatch.'
  },
  {
    group: 'search',
    key: 'searchMethod',
    label: '检索方法',
    labelEn: 'Search Method',
    type: 'select',
    options: [
      { value: 'CS', label: t('余弦相似度 (CS)', 'Cosine Similarity (CS)') },
      { value: 'CS(M)', label: t('合并余弦相似度 (CS(M))', 'Merged Cosine Similarity (CS(M))') }
    ],
    description: '向量相似度计算方法。MDS / MDS(M) / PCA 属于降维可视化方法，不参与检索排序，已从检索方法中移除',
    descriptionEn: 'Vector similarity method. MDS / MDS(M) / PCA are dimensionality-reduction/visualization methods, not retrieval metrics; they have been removed from the retrieval method list'
  },
  {
    group: 'search',
    key: 'searchMode',
    label: '检索模式',
    labelEn: 'Search Mode',
    type: 'select',
    options: [
      { value: t('按数量', 'By Count'), label: t('按数量', 'By Count') },
      { value: t('按匹配率', 'By Match Rate'), label: t('按匹配率', 'By Match Rate') },
      { value: t('按字符', 'By Characters'), label: t('按字符', 'By Characters') }
    ],
    description: '知识片段召回策略',
    descriptionEn: 'Knowledge fragment retrieval strategy'
  },
  {
    group: 'search',
    key: 'searchNum',
    label: '检索数量',
    labelEn: 'Search Count',
    type: 'number',
    min: 1,
    max: 20,
    show: () => props.model.searchMode === t('按数量', 'By Count'),
    description: '按数量检索时返回的片段数',
    descriptionEn: 'Number of fragments to return when searching by count'
  },
  {
    group: 'search',
    key: 'matchRatio',
    label: '匹配率阈值',
    labelEn: 'Match Ratio Threshold',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    show: () => props.model.searchMode === t('按匹配率', 'By Match Rate'),
    description: '按匹配率检索时的相似度阈值',
    descriptionEn: 'Similarity threshold when searching by match rate'
  },
  {
    group: 'search',
    key: 'searchCharacter',
    label: '字符限制',
    labelEn: 'Character Limit',
    type: 'number',
    min: 100,
    max: 10000,
    show: () => props.model.searchMode === t('按字符', 'By Characters'),
    description: '按字符检索时的最大字符数',
    descriptionEn: 'Maximum characters when searching by characters'
  },
  {
    group: 'search',
    key: 'summaryWeight',
    label: '增强权重',
    labelEn: 'Enhance Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    description: '语义增强相似度在综合评分中的权重（摘要向量 + 问题向量）',
    descriptionEn: 'Weight of semantic enhancement similarity in comprehensive score (summary + question vectors)'
  },
  {
    group: 'search',
    key: 'sliceWeight',
    label: '片段权重',
    labelEn: 'Fragment Weight',
    type: 'display',
    value: () => (1 - props.model.summaryWeight).toFixed(2),
    description: '片段相似度在综合评分中的权重（自动计算）',
    descriptionEn: 'Weight of fragment similarity in comprehensive score (auto calculated)'
  },
  {
    group: 'search',
    key: 'bm25Enabled',
    label: '启用BM25检索',
    labelEn: 'Enable BM25 Search',
    type: 'checkbox',
    description: '是否启用BM25算法进行检索（与余弦相似度混合使用）',
    descriptionEn: 'Whether to enable BM25 algorithm for search (mixed with cosine similarity)'
  },
  {
    group: 'search',
    key: 'bm25Weight',
    label: 'BM25权重',
    labelEn: 'BM25 Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    show: () => props.model.bm25Enabled,
    description: 'BM25算法在综合评分中的权重',
    descriptionEn: 'Weight of BM25 algorithm in comprehensive score'
  },
  {
    group: 'process',
    key: 'sliceStrategy',
    label: '切片策略',
    labelEn: 'Slice Strategy',
    type: 'select',
    options: [
      { value: '语义', label: t('语义（按主题相似度切分）', 'Semantic (Split by topic similarity)') },
      { value: '智能', label: t('智能（按一级标题切分）', 'Smart (Split by top-level headings)') },
      { value: '标识符', label: t('标识符（按多个空行切分）', 'Identifier (Split by empty lines)') }
    ],
    description: '文档切片时使用的策略',
    descriptionEn: 'Strategy used for document slicing'
  },
  {
    group: 'process',
    key: 'agentSubQueryWeight',
    label: '子查询重排权重',
    labelEn: 'Sub-query Rerank Weight',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    description: '仅 Agentic 生效：最终重排时融合「工具检索通道分」与「原始问题内容余弦」的权重（默认 0.5 等权）。值越高越偏向工具按检索词召回的精确结果，越低越偏向切片正文与原始问题的相似度（0=只用原始问题，1=只用工具通道分）',
    descriptionEn: 'Agentic only: weight blending the tool retrieval channel score with original-question content similarity in the final rerank (default 0.5, equal). Higher = favor precise tool recall, lower = favor slice-vs-question similarity (0 = original query only, 1 = channel score only)'
  },
  {
    group: 'process',
    key: 'agentToolTopN',
    label: '工具候选数',
    labelEn: 'Tool Candidate Pool',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    description: '仅 Agentic（智能路由）生效：每个检索工具内部取多少条候选切片（默认 15）。这些候选全部并入证据池参与最终融合排序，因此调大可抬高召回上限；模型实际读到的上下文仍只有「切片数量」条（不增加提示词体积）。若在「策略配置」里给某个智能路由策略单独设了「工具候选数」，则以该策略设置为准。',
    descriptionEn: 'Agentic only: how many candidate slices each retrieval tool fetches internally (default 15). All of them join the evidence pool for the final fused ranking, so a larger value raises the recall ceiling; the model still only reads "slice count" snippets (prompt size unchanged). A per-strategy "Tool candidate pool" in Strategy Config overrides this.'
  },
  {
    group: 'process',
    key: 'sliceMaxChars',
    label: '切片最大字符数',
    labelEn: 'Max Chars Per Slice',
    type: 'number',
    min: 500,
    max: 20000,
    step: 100,
    description: '单个切片的最大字符数，超过的切片会按句子二次切分',
    descriptionEn: 'Max characters per slice; oversized slices are re-split by sentences'
  },
  {
    group: 'process',
    key: 'sliceOverlapChars',
    label: '切片重叠字符数',
    labelEn: 'Slice Overlap Chars',
    type: 'number',
    min: 0,
    max: 2000,
    step: 50,
    description: '相邻切片首尾重叠的字符数（仅用于向量化，不改变展示原文）',
    descriptionEn: 'Chars of overlap between adjacent slices (used only for embedding, not for display)'
  },
  {
    group: 'process',
    key: 'semanticSplitThreshold',
    label: '语义切分阈值',
    labelEn: 'Semantic Split Threshold',
    type: 'range',
    min: 0.5,
    max: 0.99,
    step: 0.01,
    show: () => props.model.sliceStrategy === '语义',
    description: '语义切分时相邻片段相似度低于此值视为主题边界（越低切分越粗）',
    descriptionEn: 'Adjacent segment similarity below this is a topic boundary (lower = coarser split)'
  },
  {
    group: 'process',
    key: 'entityLinkLlm',
    label: '实体链接 LLM 兜底',
    labelEn: 'Entity-link LLM Fallback',
    type: 'checkbox',
    description: '本体增强 / 多跳的实体链接在「模糊匹配 + 语义匹配」都无把握时，是否再调一次大模型兜底匹配。默认开（质量优先）；若对话与嵌入模型在同一服务（LM Studio / Ollama）且显存有限，运行本体增强策略时每轮查询都要在对话与嵌入模型间换载，评测会很慢——关掉后本体增强全程只用嵌入模型（召回可能略降）。',
    descriptionEn: 'Whether entity linking (Ontology / Multi-hop) makes one extra LLM call when fuzzy + semantic matching are inconclusive. On by default (better recall); with LM Studio/Ollama the chat and embedding models cannot stay resident together, so every query swaps models and evaluation becomes very slow — turn it off to keep Ontology use of the embedding model only (recall may drop slightly).'
  },
  {
    group: 'process',
    key: 'questionChoiceOptions',
    label: '生成选择题选项',
    labelEn: 'Generate Choice Options',
    type: 'checkbox',
    description: '推理问题时一并生成**选择题选项**（每题 4 个选项 A–D 与正确选项标签），而不是只生成纯问答。打开后：① 问题生成改用选择题提示词（每题一个区块，选项行 + 答案字母，要求干扰项似是而非）；② 问题库记录 <code>choiceMap</code>（选项正文）与 <code>answerChoices</code>（正确标签），<code>extraAnswer</code> 始终是文字答案（正确选项正文）；③ <strong>学习模块</strong>的练习卡据此走<strong>确定性判分</strong>（先写答案 → 检查并揭示 → 按裁决结算）。仅对<strong>之后新推理的问题</strong>生效，已推理的问题不受影响（需清空重推理）。',
    descriptionEn: 'Also generate **choice options** when reasoning questions (4 options A–D plus the correct label per question) instead of plain Q&A. When on: ① question generation switches to the choice prompt (one block per question, option lines plus an answer letter, with plausible distractors); ② each question record keeps a <code>choiceMap</code> (option text) and <code>answerChoices</code> (correct labels), while <code>extraAnswer</code> always holds the textual answer (the correct option body); ③ the **Learning** module grades such cards **deterministically** (write your answer → check and reveal → settle on the verdict) instead of using the four self-ratings. Applies only to questions reasoned **from now on**; existing questions are untouched (clear and re-reason to convert).'
  },
  {
    group: 'process',
    key: 'maxTestCases',
    label: '测试用例上限',
    labelEn: 'Max Test Cases',
    type: 'number',
    min: 1,
    max: 5000,
    step: 50,
    description: '测试页自动生成测试用例的最大条数（按推理问题逐行拆分后截取）',
    descriptionEn: 'Max number of test cases auto-generated in Test tab (after splitting inferred questions by line)'
  },
  {
    group: 'process',
    key: 'questionDedupThreshold',
    label: '问题去重阈值',
    labelEn: 'Question Dedup Threshold',
    type: 'range',
    min: 0,
    max: 0.99,
    step: 0.01,
    show: () => props.model.questionDedupEnabled,
    description: '问题语义相似度≥此值判定为重复（保留答案更贴合者）',
    descriptionEn: 'Questions with semantic similarity ≥ this are duplicates (keep the better-fitting answer)'
  },
  {
    group: 'process',
    key: 'questionDedupEnabled',
    label: '自动处理问题去重',
    labelEn: 'Auto Dedup Questions',
    type: 'checkbox',
    description: '从知识库读取用例后，对语义相似的问题自动去重并择优答案；关闭则不处理',
    descriptionEn: 'After loading cases from KB, auto-dedup semantically similar questions and keep the better answer; off = no processing'
  },
  {
    group: 'process',
    key: 'questionMergeEnabled',
    label: 'LLM合并相似问题',
    labelEn: 'LLM Merge Similar Questions',
    type: 'checkbox',
    description: '对判重的问题调用LLM综合成一条更完整规范的问题，并择优/合并答案；关闭则保留原问题表述',
    descriptionEn: 'Merge duplicate questions into one more complete one via LLM, pick/merge answers; off = keep original wording'
  },
  // ==================== 本体推理描述词配置（并入处理配置） ====================
  {
    group: 'process',
    key: 'ontologyEntityTypes',
    label: '实体类型描述词',
    labelEn: 'Entity Type Descriptors',
    type: 'textarea',
    placeholder: '概念、对象、事物、主体、人物、组织、地点等',
    placeholderEn: 'concepts, objects, things, subjects, people, organizations, places, etc.',
    description: '本体构建时AI识别实体的类型描述词，用中文顿号分隔',
    descriptionEn: 'Entity type descriptors for AI during ontology building, separated by commas'
  },
  {
    group: 'process',
    key: 'ontologyRelationTypes',
    label: '关系类型描述词',
    labelEn: 'Relation Type Descriptors',
    type: 'textarea',
    placeholder: '- **is_a**：继承关系。例如："医疗保险" is_a "保险合同"',
    placeholderEn: '- **is_a**: Inheritance relationship',
    description: '本体构建时AI识别关系类型的描述，每行一个关系类型定义',
    descriptionEn: 'Relation type descriptors for AI during ontology building, one type per line'
  },
  {
    group: 'process',
    key: 'entityDescriptionPrompt',
    label: '卡片描述推理提示词',
    labelEn: 'Card Description Reasoning Prompt',
    type: 'textarea',
    placeholder: '你是一个知识图谱专家。请根据提供的文本内容，为实体"{{entityName}}"生成一个准确、完整的描述。',
    placeholderEn: 'You are a knowledge graph expert. Generate an accurate and complete description for the entity "{{entityName}}" based on the provided text.',
    description: '批量推理卡片描述时使用的提示词模板。可用占位符：{{entityName}}、{{entityTypes}}、{{content}}、{{language}}，留空则使用默认提示词',
    descriptionEn: 'Prompt template for batch card description reasoning. Placeholders: {{entityName}}, {{entityTypes}}, {{content}}, {{language}}. Leave empty to use default prompt'
  },
  {
    group: 'process',
    key: 'ontologyBatchSize',
    label: '本体批量大小',
    labelEn: 'Ontology Batch Size',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    description: '本体构建时每批处理的切片数量（1-50）',
    descriptionEn: 'Number of slices per batch when building ontology (1-50)'
  }
])

// 活动配置分组
const activeGroup = ref<string>(props.initialGroup || 'knowledgebase')
watch(() => props.initialGroup, (g) => {
  if (g) activeGroup.value = g
})

// 获取当前组的配置项
const currentConfigItems = computed(() => {
  return configItems.value.filter(item => {
    if (item.group !== activeGroup.value) return false
    if (item.show && typeof item.show === 'function') {
      return item.show()
    }
    return true
  })
})

// ==================== 嵌入模型（处理配置；联动父级重新向量化） ====================
/** 判断模型名是否属于嵌入模型（与 knowRAG.autoSetEmbedModel 一致） */
const isEmbedModelName = (name: string) =>
  /^(bge|text-embedding|ada-embedding|instructor|e5|gte|m3e)|embed|embedding/i.test(name || '')
/** 设置页(AI 来源)配置的默认嵌入模型名（“跟随默认”选项使用；未配置时为空串，由父级自动选用） */
const defaultEmbedName = computed<string>(() => {
  const llm = props.store.AIconfig?.llm || {}
  const type = llm.type || 'ollama'
  // DeepSeek 单来源：嵌入模型取当前接口样式对应的配置块（历史别名归一到 deepseek）
  const key = deepSeekStyleOf(type, llm.deepseek) === 'responses' ? 'deepseekResponses' : normalizeLlmType(type)
  return (llm[key] && llm[key].embed_model) ? llm[key].embed_model : ''
})
/** 下拉候选：来源可用模型中的嵌入模型（排除“跟随默认”项避免重复）+ 自定义当前值（若不在候选里） */
const embedCandidates = computed<string[]>(() => {
  const list: string[] = (props.model?.list || []).map((m: any) => m.name).filter(Boolean)
  const out: string[] = []
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n) }
  list.filter((n) => isEmbedModelName(n) && n !== defaultEmbedName.value).forEach(add)
  const cur = String(props.model?.embed || '')
  if (cur && cur !== defaultEmbedName.value) add(cur)
  return out
})
/** 用户更改嵌入模型：交给父级处理（确认 + 新模型重新向量化） */
const onEmbedModelChange = (next: string) => {
  if (String(props.model?.embed || '') === String(next || '')) return
  emit('embedModelChange', String(next || ''))
}

// 扫描知识库文件
const scanKnowledgeBases = async () => {
  if (!props.store.root) {
    kbScanPath.value = t('未选择文件夹', 'No folder selected')
    emit('updateState', kbScanPath.value)
    return
  }

  kbScanPath.value = props.store.root
  isLoadingKb.value = true
  emit('updateState', t('正在扫描知识库文件...', 'Scanning knowledge base files...'))

  try {
    const result = await aikmIpc.invoke("getFilesRelation", props.store.root, 3)
    if (!result) {
      knowledgeBases.value = []
      return
    }

    const { fileList = [] } = result
    const kbFiles = fileList.filter((file: any) => file.path.endsWith('.kb'))
    
    // 读取每个知识库文件的元数据
    const processedFiles = await Promise.all(
      kbFiles.map(async (file: any) => {
        try {
          const content = await getPlatform().fs.readText(file.path)
          const data = JSON.parse(content)
          
          const kbFile: KnowledgeBaseFile = {
            label: file.label,
            path: file.path,
            // 说明文字随 .kb 存（版本管理右侧详情里编辑）
            description: String(data.description || ''),
          }
          
          // 解析配置信息
          if (data.config) {
            kbFile.config = {
              embedModel: data.config.embedModel,
              timestamp: data.config.timestamp,
              version: data.config.version,
              blockCount: data.blocks?.length,
              // 精简模式：向量未写入 .kb，首次问答按需重新推导
              saveVectors: data.config.saveVectors !== false ? true : false,
              // 自动写入 .kbdb（3.2 起默认开启）；老 KB 没有该字段时按开启处理
              autoVectorDb: data.config.autoVectorDb !== false,
              vectorQuant: data.config.vectorQuant === 'int8' ? 'int8' : 'float32',
              // 3.2：向量在 .kbdb（.kb 不内联）；界面据此显示「向量库」而不是「精简」
              vectorStore: data.config.vectorStore ? { file: String(data.config.vectorStore.file || ''), dim: Number(data.config.vectorStore.dim) || 0 } : undefined,
              // 3.1：测试结果在 <库名>.testdata.json（同目录），.kb 只记文件名
              saveTestResults: data.config.saveTestResults === true,
              testDataFile: String(data.config.testDataFile || '') || undefined,
            }
          }
          
          // 解析本体信息（实体数、关系数、社区数、报告数）
          if (data.ontology) {
            kbFile.ontology = {
              entities: data.ontology.entities?.length || 0,
              relations: data.ontology.relations?.length || 0
            }
          }
          // 社区检测结果和报告
          if (data.communityResult) {
            if (!kbFile.ontology) kbFile.ontology = {}
            kbFile.ontology.communityCount = data.communityResult.count || data.communityResult.communities?.length || 0
          }
          if (data.communityReports) {
            if (!kbFile.ontology) kbFile.ontology = {}
            kbFile.ontology.communityReportCount = data.communityReports.length || 0
          }
          
          // 解析切片元数据（方案 A：问题由问题库 questions 承载，切片不再持有 Q）
          if (data.blocks && data.blocks.length > 0) {
            const firstBlock = data.blocks[0]
            const hasEmbeddings = !!firstBlock.A_vector || !!data.config?.vectorStore
            const avgVectorDimension = firstBlock.A_vector?.length
              || Number(data.config?.vectorStore?.dim) || 0
            const activeQuestions = (data.questions || []).filter((q: any) => q && q.status !== 'merged' && q.text)
            const hasQuestions = activeQuestions.length > 0
            const reasonedCount = activeQuestions.filter((q: any) => q.origin === 'reasoned').length
            const fileCount = new Set(data.blocks.map((b: any) => b.label)).size
            
            kbFile.metadata = {
              blockCount: data.blocks.length,
              hasEmbeddings,
              hasQuestions,
              avgVectorDimension,
              reasonedCount,
              questionCount: activeQuestions.length,
              fileCount
            }
          }
          
          return kbFile
        } catch (e) {
          // 如果解析失败，只返回基本信息
          console.error(t('解析知识库文件失败:', 'Failed to parse knowledge base file:'), file.label, e)
          return {
            label: file.label,
            path: file.path,
            config: { version: 'unknown' }
          } as KnowledgeBaseFile
        }
      })
    )
    
    // 按文件名排序（按时间戳降序）
    processedFiles.sort((a: any, b: any) => {
      return b.label.localeCompare(a.label)
    })
    
    knowledgeBases.value = processedFiles
    // 与插件管理面板一致：首次进入不自动选中（右侧显示「从左侧选择」提示）；
    // 刷新时保留当前选中，被删掉的文件则清空选择。
    if (selectedKbPath.value && !processedFiles.some((kb: KnowledgeBaseFile) => kb.path === selectedKbPath.value)) {
      selectedKbPath.value = ''
    }
    emit('updateState', t(
      `扫描完成，找到 ${knowledgeBases.value.length} 个知识库文件`,
      `Scan complete, found ${knowledgeBases.value.length} knowledge base files`
    ))
    
  } catch (error) {
    console.error(t('扫描知识库出错:', 'Error scanning knowledge base:'), error)
    emit('updateState', t('扫描知识库失败', 'Failed to scan knowledge bases'))
  } finally {
    isLoadingKb.value = false
  }
}

// 加载知识库到主模块
// ==================== 知识库改名（同步文件夹/所有同名文件） ====================
const renamingKb = ref(false)

/**
 * 重命名知识库：`知识库/<旧名>/<旧名>.*` → `知识库/<新名>/<新名>.*`。
 * - 文件夹名恰好等于库名时连同文件夹一起改名；
 * - `.kb / .kbdb(-wal/-shm) / .testdata.json / .learning / .learning.json / .exams.json / .portable.kbdb` 一起改；
 * - 改完回写 `.kb` 里的 `config.vectorStore.file / testDataFile`，再通知主模块更新已加载路径。
 */
async function renameSelectedKb(): Promise<void> {
  const kb = selectedKb.value
  if (!kb || renamingKb.value) return
  const zh = props.store.locales === 'zh'
  const normalized = String(kb.path).replace(/\\/g, '/')
  const oldFile = normalized.split('/').pop() || ''
  const oldStem = oldFile.replace(/\.kb$/i, '')
  let input = ''
  try {
    const res = await ElMessageBox.prompt(
      zh ? `把「${oldStem}」重命名为：` : `Rename "${oldStem}" to:`,
      zh ? '重命名知识库' : 'Rename knowledge base',
      {
        inputValue: oldStem,
        confirmButtonText: zh ? '重命名' : 'Rename',
        cancelButtonText: zh ? '取消' : 'Cancel',
        inputValidator: (v: string) => {
          const name = String(v || '').trim().replace(/\.kb$/i, '')
          if (!name) return zh ? '名称不能为空' : 'Name is required'
          if (/[\\/:*?"<>|]/.test(name)) return zh ? '名称不能包含 \\ / : * ? " < > |' : 'Name cannot contain \\ / : * ? " < > |'
          return true
        },
      },
    )
    input = String(res?.value || '').trim().replace(/\.kb$/i, '')
  } catch { return }
  const newStem = input.replace(/[\\/:*?"<>|]/g, '_')
  if (!newStem || newStem === oldStem) return

  const oldDir = normalized.slice(0, normalized.lastIndexOf('/'))
  const parentDir = oldDir.slice(0, oldDir.lastIndexOf('/'))
  const folderName = oldDir.split('/').pop() || ''
  const folderIsStem = folderName.toLowerCase() === oldStem.toLowerCase()
  const newDir = folderIsStem ? `${parentDir}/${newStem}` : oldDir
  const suffixes = [
    '.testdata.json', '.learning', '.learning.json', '.exams.json',
    '.kbdb', '.kbdb-wal', '.kbdb-shm', '.portable.kbdb', '.kb',
  ]
  renamingKb.value = true
  try {
    // Windows 上 .kbdb 被主进程打开时无法改名：先关句柄
    await closeVectorDbHandle(kb.path).catch(() => {})
    if (folderIsStem) {
      const moved = await getPlatform().fs.renameFile(oldDir, newStem)
      if (!moved?.success) throw new Error(moved?.error || (zh ? '文件夹改名失败' : 'folder rename failed'))
    }
    for (const suffix of suffixes) {
      const oldPath = `${newDir}/${oldStem}${suffix}`
      const res = await getPlatform().fs.renameFile(oldPath, `${newStem}${suffix}`)
      if (res && res.success === false && !/不存在|not exist|no such/i.test(String(res.error || ''))) {
        console.warn('[configManager] 改名跳过:', oldPath, res.error)
      }
    }
    const newKbPath = `${newDir}/${newStem}.kb`
    // 更新 .kb 内部引用（文件名变了，但内容/时间戳不动）
    try {
      const text = await getPlatform().fs.readText(newKbPath)
      const data = JSON.parse(text)
      if (data?.config) {
        if (data.config.vectorStore) data.config.vectorStore.file = `${newStem}.kbdb`
        if (data.config.testDataFile) data.config.testDataFile = `${newStem}.testdata.json`
      }
      await getPlatform().fs.saveText(newKbPath, JSON.stringify(data))
    } catch (e) {
      console.warn('[configManager] 改 .kb 内部引用失败（文件名已改）:', e)
    }
    emit('kbRenamed', { oldPath: kb.path, newPath: newKbPath, newName: newStem })
    await scanKnowledgeBases()
    const idx = knowledgeBases.value.findIndex((x: any) => String(x.path).replace(/\\/g, '/') === newKbPath.replace(/\\/g, '/'))
    if (idx >= 0) selectedKbPath.value = knowledgeBases.value[idx].path
    emit('updateState', zh ? `已重命名为「${newStem}」` : `Renamed to "${newStem}"`)
  } catch (e: any) {
    emit('updateState', zh ? `重命名失败：${e?.message || e}` : `Rename failed: ${e?.message || e}`)
  } finally {
    renamingKb.value = false
  }
}

const loadKnowledgeBase = async (path?: string) => {
  const kbFile = (path ? knowledgeBases.value.find((k) => k.path === path) : selectedKb.value) || null
  if (!kbFile) return
  emit('updateState', t(
    `正在加载知识库: ${kbFile.label}`,
    `Loading knowledge base: ${kbFile.label}`
  ))
  // 传路径而不是索引：版本管理列表与主模块列表的排序不同
  emit('loadKnowledgeBase', kbFile.path)
}

/** 左栏选中一个知识库（右侧详情随之切换） */
const selectKbFile = (path: string) => {
  selectedKbPath.value = path
  editingDescription.value = false
  void refreshVectorDb()
  void refreshKbFiles()
}
const loadSelectedKb = () => { if (selectedKb.value) void loadKnowledgeBase(selectedKb.value.path) }
const deleteSelectedKb = () => { if (selectedKb.value) void deleteKnowledgeBase(selectedKb.value.path) }

/**
 * 打开知识库所在文件夹：优先在系统文件管理器里**定位到 .kb 本身**
 * （`revealInFolder` 会打开父目录并选中它）；该能力不可用时退回
 * 「用系统默认方式打开父目录」。失败给出状态栏提示，不静默。
 */
const openKbFolder = async () => {
  const kb = selectedKb.value
  if (!kb?.path) return
  const zh = props.store.locales === 'zh'
  try {
    const revealed = await getPlatform().shell.revealInFolder(kb.path)
    if (revealed) return
    const dir = String(kb.path).replace(/\\/g, '/').replace(/\/[^/]+$/, '')
    const res = await getPlatform().shell.openWithSystemApp(dir)
    if (!res?.success) {
      emit('updateState', zh ? `打开文件夹失败：${res?.error || kb.path}` : `Failed to open the folder: ${res?.error || kb.path}`)
    }
  } catch (e: any) {
    emit('updateState', zh ? `打开文件夹失败：${e?.message || e}` : `Failed to open the folder: ${e?.message || e}`)
  }
}

/** 说明：进入编辑态（草稿独立，取消不影响原值） */
const startEditDescription = () => {
  descriptionDraft.value = selectedKb.value?.description || ''
  editingDescription.value = true
}
const cancelEditDescription = () => { editingDescription.value = false }
/**
 * 保存说明：直接改 .kb 的 description 字段（先读整份 → 改字段 → 写回）。
 * 说明属于元数据，不该触发时间戳/版本变化；同时通知主模块更新内存里的说明，
 * 避免它下一次保存时用旧值把这里刚写的说明覆盖掉。
 */
const saveDescription = async () => {
  const kb = selectedKb.value
  if (!kb || savingDescription.value) return
  savingDescription.value = true
  try {
    const content = await getPlatform().fs.readText(kb.path)
    const data = JSON.parse(content)
    const text = String(descriptionDraft.value || '').trim()
    data.description = text
    const ok = await getPlatform().fs.saveText(kb.path, JSON.stringify(data))
    if (!ok) {
      emit('updateState', t('保存说明失败', 'Failed to save the description'))
      return
    }
    kb.description = text
    editingDescription.value = false
    emit('kbDescriptionSaved', { path: kb.path, description: text })
    emit('updateState', t(`已保存知识库说明：${kb.label}`, `Description saved: ${kb.label}`))
  } catch (e: any) {
    console.error(t('保存说明出错:', 'Error saving description:'), e)
    emit('updateState', t(`保存说明失败：${e?.message || e}`, `Failed to save the description: ${e?.message || e}`))
  } finally {
    savingDescription.value = false
  }
}

// 删除知识库文件
const deleteKnowledgeBase = async (path: string) => {
  const kbFile = knowledgeBases.value.find((k) => k.path === path)
  if (!kbFile) return
  try {
    await ElMessageBox.confirm(
      t(
        `确定要删除知识库 "${kbFile.label}" 吗？会连同所在库文件夹（含学习记录、试卷库、测试结果文件）一起删除，此操作不可恢复。`,
        `Delete "${kbFile.label}"? The whole KB folder (including learning records, exam papers and the test-results file) will be removed. This cannot be undone.`
      ),
      t('提示', 'Confirm'),
      { confirmButtonText: t('确定', 'OK'), cancelButtonText: t('取消', 'Cancel'), type: 'warning' }
    )
  } catch { return }
  
  try {
    // 先释放/删除向量库句柄：Windows 上打开着的 .kbdb 会让文件夹删除失败
    await deleteVectorDb(kbFile.path).catch(() => { /* 没有向量库时忽略 */ })
    const normalized = String(kbFile.path || '').replace(/\\/g, '/')
    const parts = normalized.split('/')
    const fileName = parts.pop() || ''
    const parent = parts.join('/')
    const parentName = parts[parts.length - 1] || ''
    const kbBase = fileName.replace(/\.kb$/i, '')
    // 方案 A：<知识库>/<库名>/<库名>.kb —— 删除整个库文件夹（含 .learning / .exams.json / .testdata.json）
    // 旧版根目录 .kb：只删除 .kb 及其同名侧车，绝不删除整个工作区
    let success = false
    if (parent && parentName === kbBase) {
      const res = await getPlatform().fs.deleteFolder(parent)
      success = !!res?.success
    } else {
      success = await getPlatform().fs.deleteFile(kbFile.path)
      if (success) {
        const stem = normalized.replace(/\.kb$/i, '')
        await getPlatform().fs.deleteFile(stem + '.learning')
        await getPlatform().fs.deleteFile(stem + '.exams.json')
        // 测试结果侧车（3.1 起）：<库名>.testdata.json
        await getPlatform().fs.deleteFile(stem + '.testdata.json')
      }
    }
    if (success) {
      const idx = knowledgeBases.value.findIndex((k) => k.path === kbFile.path)
      if (idx >= 0) knowledgeBases.value.splice(idx, 1)
      if (selectedKbPath.value === kbFile.path) {
        selectedKbPath.value = ''
      }
      emit('updateState', t(
        `已删除知识库: ${kbFile.label}`,
        `Deleted knowledge base: ${kbFile.label}`
      ))
    } else {
      emit('updateState', t('删除失败：文件夹可能被占用', 'Delete failed: folder may be in use'))
    }
  } catch (error: any) {
    console.error(t('删除知识库出错:', 'Error deleting knowledge base:'), error)
    emit('updateState', t(
      `删除失败: ${error.message}`,
      `Delete failed: ${error.message}`
    ))
  }
}

// 获取保存时间文本
const getSaveTimeText = (timestamp?: string) => {
  if (!timestamp) return t('未知', 'Unknown')
  try {
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString().substring(0, 5)
  } catch (e) {
    return timestamp
  }
}

// 监听根目录变化
watch(() => props.store.root, (newRoot) => {
  if (newRoot && activeGroup.value === 'knowledgebase') {
    scanKnowledgeBases()
  }
})

// 初始化
onMounted(() => {
  // 如果已经有根目录，立即扫描
  if (props.store.root) {
    scanKnowledgeBases()
  }
  
})



// 切换分组时扫描知识库
watch(activeGroup, (newGroup) => {
  if (newGroup === 'knowledgebase' && props.store.root) {
    scanKnowledgeBases()
  }
  
})

// 定义发射事件
const emit = defineEmits<{
  updateState: [state: string]
  /** 传**路径**（不是索引）：版本管理列表与主模块列表排序不同 */
  loadKnowledgeBase: [path: string]
  strategiesChanged: []
  embedModelChange: [model: string]
  /** 说明保存后通知主模块更新内存值，避免它下次保存时用旧说明覆盖 */
  kbDescriptionSaved: [payload: { path: string; description: string }]
  /** 请求主模块重建向量库（重新向量化全部切片 + 写库 + 瘦身） */
  rebuildVectorDb: []
  /** 知识库改名完成（主模块需要更新已加载路径并刷新版本列表） */
  kbRenamed: [payload: { oldPath: string; newPath: string; newName: string }]
}>()

// 策略配置变更：转发给父组件刷新策略注册表（QA 下拉等）
const handleStrategiesChanged = () => {
  emit('strategiesChanged')
  emit('updateState', t('策略配置已更新', 'Strategy config updated'))
}
</script>

<template>
  <div class="config-layout">
    <div class="config-body">
      <!-- 配置内容区：分组由模块工具栏的三个按钮切换，不再使用左侧导航 -->
      <div class="config-content scoll">
        <div class="config-inner">
          <!-- 知识库配置：左栏 = 知识库文件导航，右栏 = 选中文件的详情（与插件管理同构） -->
          <div v-if="activeGroup === 'knowledgebase'" class="kb-section kb-manage">
            <div class="kb-manage-split">
              <!-- ===================== 左栏：知识库导航 ===================== -->
              <div class="kb-nav">
                <div class="kb-nav-toolbar">
                  <button class="kb-nav-btn" :class="{ spinning: isLoadingKb }" @click="scanKnowledgeBases"
                    :title="t('重新扫描知识库文件', 'Rescan knowledge base files')">
                    <i class="fa fa-refresh"></i>
                  </button>
                  <span class="kb-nav-count">{{ knowledgeBases.length }} {{ t('个', 'files') }}</span>
                </div>
                <div class="kb-nav-list scoll">
                  <div v-if="isLoadingKb" class="kb-loading"><i class="fa fa-spinner fa-spin kb-loading-icon"></i></div>
                  <div v-else-if="knowledgeBases.length === 0" class="kb-empty">
                    <i class="fa fa-database kb-empty-icon"></i>
                    <div class="kb-empty-text">{{ t('未找到知识库文件', 'No knowledge base files found') }}</div>
                    <div class="kb-empty-hint">{{ t('请确保已选择正确的文件夹', 'Please ensure you have selected the correct folder') }}</div>
                  </div>
                  <div v-else class="kb-nav-items">
                    <div
                      v-for="(kb, index) in knowledgeBases"
                      :key="kb.path || index"
                      class="kb-nav-item"
                      :class="{ active: kb.path === selectedKbPath }"
                      :title="kb.path"
                      @click="selectKbFile(kb.path)"
                    >
                      <div class="kb-nav-icon"><i class="fa" :class="kb.path === selectedKbPath ? 'fa-database' : 'fa-folder-o'"></i></div>
                      <div class="kb-nav-main">
                        <div class="kb-nav-name">{{ displayKbName(kb.label) }}</div>
                        <div class="kb-nav-sub">
                          <span v-if="kb.config?.version" class="kb-ver-badge">v{{ kb.config.version }}</span>
                          <span>{{ getSaveTimeText(kb.config?.timestamp) }}</span>
                        </div>
                        <div v-if="kb.description" class="kb-nav-desc">{{ kb.description }}</div>
                      </div>
                      <i v-if="kb.metadata?.hasEmbeddings" class="fa fa-check-circle kb-nav-ok" :title="t('已向量化', 'Embedded')"></i>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ===================== 右栏：选中知识库详情 ===================== -->
              <div class="kb-detail">
                <div v-if="!selectedKb" class="kb-detail-empty">
                  <i class="fa fa-hand-o-left"></i>
                  <div class="kb-detail-empty-title">{{ t('从左侧选择一个知识库', 'Select a knowledge base on the left') }}</div>
                  <div class="kb-detail-empty-hint">{{ t('可查看切片/向量/测试结果概况，并编辑说明（保存在 .kb 中）', 'Inspect slices/vectors/test results and edit the description (stored in the .kb)') }}</div>
                </div>
                <div v-else class="kb-detail-body scoll">
                  <div class="kb-detail-head">
                    <div class="kb-detail-title">
                      <i class="fa fa-database"></i>
                      <span :title="selectedKb.label">{{ displayKbName(selectedKb.label) }}</span>
                      <span v-if="selectedKb.config?.version" class="kb-ver-badge">v{{ selectedKb.config.version }}</span>
                    </div>
                    <div class="kb-detail-actions">
                      <span v-if="selectedKb.metadata?.hasEmbeddings" class="kb-status-tag c-green"><i class="fa fa-check-circle"></i> {{ t('已向量化', 'Embedded') }}</span>
                      <span v-if="selectedKb.config?.vectorStore" class="kb-status-tag c-teal"><i class="fa fa-cubes"></i> {{ t('向量库', 'Vector DB') }}</span>
                      <span v-else-if="selectedKb.config?.saveVectors === false" class="kb-status-tag c-orange"><i class="fa fa-file-archive-o"></i> {{ t('精简（向量按需）', 'Slim') }}</span>
                      <span v-if="selectedKb.metadata?.hasQuestions" class="kb-status-tag c-blue"><i class="fa fa-question-circle"></i> {{ t('有问题', 'Questions') }}</span>
                    </div>
                  </div>

                  <!-- 详情工具栏：加载 / 重命名 / 打开文件夹 / 删除（不塞进卡片） -->
                  <div class="kb-detail-toolbar">
                    <button class="button kb-vec-btn" @click="loadSelectedKb">
                      <i class="fa fa-play"></i>{{ t('加载', 'Load') }}
                    </button>
                    <button class="button kb-vec-btn" :disabled="renamingKb" @click="renameSelectedKb">
                      <i class="fa" :class="renamingKb ? 'fa-spinner fa-spin' : 'fa-i-cursor'"></i>{{ t('重命名', 'Rename') }}
                    </button>
                    <button class="button kb-vec-btn" @click="openKbFolder">
                      <i class="fa fa-folder-open-o"></i>{{ t('打开文件夹', 'Open folder') }}
                    </button>
                    <button class="button kb-vec-btn danger" @click="deleteSelectedKb">
                      <i class="fa fa-trash"></i>{{ t('删除', 'Delete') }}
                    </button>
                  </div>

                  <!-- 说明：放在工具栏下方、文件卡片上方 -->
                  <div class="kb-desc-panel">
                    <div class="kb-card-desc-head">
                      <span>{{ t('说明', 'Description') }}</span>
                      <span v-if="!editingDescription" class="kb-detail-link" @click="startEditDescription">
                        <i class="fa fa-pencil"></i>{{ selectedKb.description ? t('编辑', 'Edit') : t('添加', 'Add') }}
                      </span>
                    </div>
                    <div v-if="!editingDescription" class="kb-card-desc-text" :class="{ empty: !selectedKb.description }">
                      {{ selectedKb.description || t('还没有说明：点「添加」写一句这份知识库的用途 / 适用范围，会保存在 .kb 里', 'No description yet: click Add to note what this KB is for; it is stored in the .kb') }}
                    </div>
                    <div v-else class="kb-detail-desc-edit">
                      <textarea
                        v-model="descriptionDraft"
                        class="kb-desc-input"
                        rows="3"
                        :placeholder="t('例如：运筹学课程第 1-12 章知识点，用于课程问答与出题', 'e.g. Operations research chapters 1-12, used for course Q&A and exam generation')"
                        @keydown.esc.stop="editingDescription = false"
                      ></textarea>
                      <div class="kb-detail-desc-actions">
                        <button class="button" :disabled="savingDescription" @click="saveDescription">
                          <i class="fa" :class="savingDescription ? 'fa-spinner fa-spin' : 'fa-save'"></i>{{ t('保存说明', 'Save') }}
                        </button>
                        <button class="button" :disabled="savingDescription" @click="cancelEditDescription">{{ t('取消', 'Cancel') }}</button>
                      </div>
                    </div>
                  </div>

                  <!-- .kb 主卡：版本/统计/模型（说明已上移到工具栏下方） -->
                  <div class="kb-card kb-card-main">
                    <div class="kb-card-head">
                      <i class="fa fa-database kb-card-icon"></i>
                      <span class="kb-card-name" :title="selectedKb.label">{{ selectedKb.label }}</span>
                      <span class="kb-card-role">{{ t('知识库', 'Knowledge base') }}</span>
                      <span class="kb-card-size">{{ kbMainFile ? formatVectorBytes(kbMainFile.size) : '' }}</span>
                    </div>
                    <div class="kb-card-stats">
                      <span>{{ t('切片', 'Blocks') }} <b>{{ selectedKb.metadata?.blockCount || selectedKb.config?.blockCount || 0 }}</b></span>
                      <span>{{ t('文件', 'Files') }} <b>{{ selectedKb.metadata?.fileCount ?? '?' }}</b></span>
                      <span>{{ t('问题', 'Questions') }} <b>{{ selectedKb.metadata?.questionCount ?? '?' }}</b></span>
                      <span>{{ t('实体/关系', 'Entities/Relations') }} <b>{{ selectedKb.ontology?.entities || 0 }} / {{ selectedKb.ontology?.relations || 0 }}</b></span>
                      <span>{{ t('社区/报告', 'Communities/Reports') }} <b>{{ selectedKb.ontology?.communityCount || 0 }} / {{ selectedKb.ontology?.communityReportCount || 0 }}</b></span>
                    </div>
                    <div class="kb-card-meta">
                      <span><i class="fa fa-cube"></i>{{ t('嵌入模型', 'Embed model') }} <b>{{ selectedKb.config?.embedModel || '—' }}</b></span>
                      <span><i class="fa fa-clock-o"></i>{{ t('保存', 'Saved') }} <b>{{ getSaveTimeText(selectedKb.config?.timestamp) }}</b></span>
                      <span><i class="fa fa-database"></i>{{ t('向量', 'Vectors') }} <b>{{ selectedKb.config?.vectorStore ? t('存于 .kbdb', 'In .kbdb') : (selectedKb.config?.saveVectors === false ? t('按需推导', 'On-demand') : t('内联 .kb', 'Inline')) }}</b></span>
                    </div>
                    <div class="kb-card-path" :title="selectedKb.path + ' — ' + t('点击打开所在文件夹', 'click to open the containing folder')" @click="openKbFolder">{{ selectedKb.path }}</div>
                  </div>

                  <!-- .kbdb 向量库卡：状态/统计/模型/时间/操作都在这里 -->
                  <div v-if="vectorDbAvailable === false" class="kb-card kb-card-db">
                    <div class="kb-card-head">
                      <i class="fa fa-cubes kb-card-icon"></i>
                      <span class="kb-card-name">{{ kbDbFile?.name || '*.kbdb' }}</span>
                      <span class="kb-card-role">{{ t('向量库', 'Vector DB') }}</span>
                    </div>
                    <div class="kb-vec-note">
                      <div class="kb-vec-note-text">{{ vectorDbUnavailableText }}</div>
                      <button class="button kb-vec-btn" @click="retryVectorDbProbe">
                        <i class="fa fa-refresh"></i>{{ t('重试检测', 'Retry') }}
                      </button>
                    </div>
                  </div>
                  <div v-else class="kb-card kb-card-db" :class="{ empty: !vectorDb?.exists }">
                    <div class="kb-card-head">
                      <i class="fa fa-cubes kb-card-icon"></i>
                      <span class="kb-card-name">{{ kbDbFile?.name || selectedKb.label.replace(/\.kb$/i, '') + '.kbdb' }}</span>
                      <span class="kb-card-role">{{ t('向量库', 'Vector DB') }}</span>
                      <span class="kb-card-size">{{ kbDbFile ? formatVectorBytes(kbDbFile.size) : '' }}</span>
                      <span v-if="vectorDbLoading" class="kb-card-hint">{{ t('读取中…', 'loading…') }}</span>
                    </div>
                    <template v-if="vectorDb?.exists">
                      <div class="kb-card-stats">
                        <span>{{ t('向量', 'Vectors') }} <b>{{ vectorDb.stats.vectors }}</b></span>
                        <span>{{ t('维度', 'Dim') }} <b>{{ vectorDb.stats.dim }}</b></span>
                        <span>{{ t('精度', 'Quant') }} <b>{{ vectorDb.stats.quant || 'float32' }}</b></span>
                        <span v-if="kbRuntimeFiles.length">{{ t('运行时文件', 'Runtime files') }} <b>{{ kbRuntimeFiles.length }}</b></span>
                      </div>
                      <div class="kb-card-meta">
                        <span><i class="fa fa-cube"></i>{{ t('模型', 'Model') }} <b>{{ vectorDb.stats.model || '—' }}</b></span>
                        <span><i class="fa fa-clock-o"></i>{{ t('创建', 'Created') }} <b>{{ fmtDbTime(vectorDb.stats.createdAt) || '—' }}</b></span>
                        <span><i class="fa fa-clock-o"></i>{{ t('更新', 'Updated') }} <b>{{ fmtDbTime(vectorDb.stats.updatedAt) || '—' }}</b></span>
                        <span v-if="vectorDb.portable" class="kb-card-hint">{{ t('（便携包回退）', '(portable fallback)') }}</span>
                      </div>
                      <div
                        v-if="vectorDb.stats.model && selectedKb.config?.embedModel && vectorDb.stats.model !== selectedKb.config.embedModel"
                        class="kb-vec-warn"
                      >
                        <i class="fa fa-exclamation-triangle"></i>
                        {{ t('库向量模型与知识库嵌入模型不一致', 'Vector DB model differs from the KB embed model') }}：
                        {{ vectorDb.stats.model }} ≠ {{ selectedKb.config.embedModel }}，
                        {{ t('检索结果会变差，建议「重建向量库」', 'retrieval quality will degrade; rebuild the vector DB') }}
                      </div>
                      <div class="kb-card-actions">
                        <button class="button kb-vec-btn" :disabled="vectorDbBusy" @click="migrateVectors"
                          :title="t('把 .kb 里已有的向量批量写入 .kbdb（内容未变的块会跳过）', 'Copy the .kb inline vectors into .kbdb (unchanged chunks are skipped)')">
                          <i class="fa" :class="vectorDbBusy && vectorDbProgress ? 'fa-spinner fa-spin' : 'fa-database'"></i>
                          {{ t('更新向量库', 'Update vectors') }}
                        </button>
                        <button class="button kb-vec-btn" :disabled="vectorDbBusy" @click="rebuildVectors"
                          :title="t('重新向量化全部切片并重建 .kbdb（换过嵌入模型/库损坏时用）', 'Re-embed all slices and rebuild .kbdb (use after changing the embed model or if the DB is damaged)')">
                          <i class="fa fa-refresh"></i>{{ t('重建向量库', 'Rebuild') }}
                        </button>
                        <button class="button kb-vec-btn" :disabled="vectorDbBusy || !vectorDb?.exists" @click="exportVectors"
                          :title="t('导出单文件便携包（xxx.portable.kbdb），可随 .kb 一起拷给同事', 'Export a portable single-file DB (xxx.portable.kbdb) to copy alongside the .kb')">
                          <i class="fa fa-file-archive-o"></i>{{ t('导出便携包', 'Export') }}
                        </button>
                        <button class="button kb-vec-btn danger" :disabled="vectorDbBusy || !vectorDb?.exists" @click="removeVectors"
                          :title="t('删除 .kbdb（需要时可重新写入）', 'Delete the .kbdb (re-create it any time)')">
                          <i class="fa fa-trash"></i>{{ t('删除', 'Delete') }}
                        </button>
                      </div>
                      <div v-if="vectorDbProgress" class="kb-vec-progress">
                        <i class="fa fa-spinner fa-spin"></i> {{ vectorDbProgress }}
                      </div>
                    </template>
                    <template v-else>
                      <div class="kb-card-meta">
                        <span>{{ t('未创建（.kb 内联向量仍可检索）', 'Not created (the .kb inline vectors still work)') }}</span>
                      </div>
                      <div class="kb-card-actions">
                        <button class="button kb-vec-btn" :disabled="vectorDbBusy" @click="migrateVectors">
                          <i class="fa fa-database"></i>{{ t('写入向量库', 'Write vectors') }}
                        </button>
                        <button class="button kb-vec-btn" :disabled="vectorDbBusy" @click="rebuildVectors">
                          <i class="fa fa-refresh"></i>{{ t('重建向量库', 'Rebuild') }}
                        </button>
                      </div>
                    </template>
                  </div>

                  <!-- 附属文件：测试结果 / 学习记录 / 试卷库 / 学习索引 / 便携包，两列小卡 -->
                  <div v-if="kbSideFiles.length" class="kb-card-grid">
                    <div
                      v-for="f in kbSideFiles"
                      :key="f.path"
                      class="kb-card kb-card-small"
                      :title="f.path + '\n' + t('点击在文件管理器中定位', 'Click to reveal in the file manager')"
                      @click="revealKbFile(f)"
                    >
                      <div class="kb-card-head">
                        <i class="fa kb-card-icon" :class="f.icon"></i>
                        <span class="kb-card-name" :title="f.name">{{ f.name }}</span>
                        <span class="kb-card-size">{{ formatVectorBytes(f.size) }}</span>
                      </div>
                      <div class="kb-card-meta">
                        <span>{{ t(f.roleLabel, f.roleEn) }}</span>
                        <span>{{ fmtMsTime(f.mtime) }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="!kbFilesLoading" class="kb-vec-note">{{ t('还没有相关文件', 'No related files yet') }}</div>

                  <!-- 状态标签已合并到头部标题右侧 -->
                </div>
              </div>
            </div>
          </div>

          <!-- 策略配置 -->
          <div v-else-if="activeGroup === 'strategy'" class="strategy-section" style="height:100%;">
            <strategyConfig :store="store" :model="model" @change="handleStrategiesChanged" />
          </div>

          <!-- 其他配置组 -->
          <!-- 其他配置组（参照设置界面的表单行布局） -->
          <div v-else class="config-section">
            <div class="config-scroll scoll">
              <div v-if="currentConfigItems.length > 0" class="config-items">
                <div v-for="item in currentConfigItems" :key="item.key" class="config-item">
                  <div class="config-item-label" :title="t(item.description, item.descriptionEn)">
                    {{ t(item.label, item.labelEn) }}
                  </div>
                  <div class="config-item-field">
                    <template v-if="item.type === 'embed'">
                      <div class="config-embed-row">
                        <select :value="model.embed" class="config-select" :title="t(item.description, item.descriptionEn)" @change="onEmbedModelChange(($event.target as HTMLSelectElement).value)">
                          <option :value="defaultEmbedName">{{ t('跟随默认（设置页默认嵌入模型）', 'Follow default (Settings embedding model)') }}{{ defaultEmbedName ? ' · ' + defaultEmbedName : t('（未配置，自动选用可用嵌入模型）', ' (not set; auto pick embed model)') }}</option>
                          <option v-for="m in embedCandidates" :key="m" :value="m">{{ m }}</option>
                        </select>
                        <div class="config-embed-refresh" :title="t('刷新模型列表（从当前 AI 来源拉取）', 'Refresh model list (fetch from current AI source)')" @click="props.getModel && props.getModel()">
                          <i class="fa fa-refresh"></i>
                        </div>
                      </div>
                      <!-- 测试标签页设置了「评测用嵌入模型」时提示：评测/检索实际用的是它，此处设置不影响评测 -->
                      <div v-if="model.testEmbed" class="config-embed-override"
                           :title="t('在「测试」标签页选择了评测用嵌入模型，评测/检索实际使用它；此处设置不改变评测结果。清空测试页该项（选「跟随设置」）即可让此处设置生效。', 'An evaluation embed model is set on the Test tab and is used for evaluation/retrieval; this setting does not affect it. Choose &quot;Follow settings&quot; on the Test tab to make this setting take effect.')">
                        <i class="fa fa-flask"></i>
                        <span>{{ t('评测覆盖', 'Eval override') }}: {{ model.testEmbed }}</span>
                      </div>
                    </template>
                    <template v-else-if="item.type === 'text'">
                      <input v-model="model[item.key]" :placeholder="t(item.placeholder || '', item.placeholderEn || '')" class="config-input" />
                    </template>
                    <template v-else-if="item.type === 'select'">
                      <select v-model="model[item.key]" class="config-select">
                        <template v-if="Array.isArray(item.options)">
                          <option v-for="(option, idx) in item.options" :key="idx" :value="option.value || option">
                            {{ typeof option.label === 'string' && option.label.includes('(') ? option.label : t(option.label || option, option.label || option) }}
                          </option>
                        </template>
                        <template v-else-if="item.options && item.options.value">
                          <option v-for="(option, idx) in item.options.value" :key="idx" :value="option.name || option">
                            {{ option.name || option }}<template v-if="option.size"> ({{ (option.size/1024/1024/1024).toFixed(2) }}GB)</template>
                          </option>
                        </template>
                      </select>
                    </template>
                    <template v-else-if="item.type === 'number'">
                      <input type="number" v-model.number="model[item.key]" :min="item.min" :max="item.max" :step="item.step || 1" class="config-number" />
                    </template>
                    <template v-else-if="item.type === 'range'">
                      <div class="config-range-wrap">
                        <input type="range" v-model.number="model[item.key]" :min="item.min" :max="item.max" :step="item.step" class="config-range" />
                        <span class="config-range-value">{{ (model[item.key] * 100).toFixed(0) }}%</span>
                      </div>
                    </template>
                    <template v-else-if="item.type === 'textarea'">
                      <textarea v-model="model[item.key]" :placeholder="t(item.placeholder || '', item.placeholderEn || '')" class="config-textarea scoll"></textarea>
                    </template>
                    <template v-else-if="item.type === 'checkbox'">
                      <label class="config-checkbox-label">
                        <input type="checkbox" v-model="model[item.key]" class="config-checkbox-input" />
                        <span class="config-checkbox-text">{{ item.noPrefix ? t(item.label, item.labelEn) : t('启用 ', 'Enable ') + t(item.label, item.labelEn) }}</span>
                      </label>
                    </template>
                    <template v-else-if="item.type === 'display'">
                      <div class="config-display">{{ typeof item.value === 'function' ? item.value() : item.value }}</div>
                    </template>
                  </div>
                </div>
              </div>

              <div v-if="currentConfigItems.length === 0" class="empty-state">
                <i class="fa fa-sliders empty-state-icon"></i>
                <div class="empty-state-text">{{ t('当前无可用配置项', 'No available configuration items') }}</div>
                <div class="empty-state-hint">{{ t('请检查当前检索模式设置', 'Please check the current search mode settings') }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== Layout ====== */
.config-layout { display: flex; flex-direction: column; width: 100%; height: 100%; }
/* 面板本身不再套边框 + 内边距（原来 body 与 content 各一层 padding、中间一层 border，
   看起来像"两个 padding 夹一个边框"）：内容直接铺满宿主给的高度 */
.config-body { display: flex; flex-direction: column; flex: 1; gap: 4px; padding: 0; box-sizing: border-box; min-height: 0; }

/* ====== Sidebar ====== */
.config-sidebar { width: 150px; border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
.sidebar-groups { flex-shrink: 0; }
.group-item { padding: 5px; margin-bottom: 5px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; transition: background-color 0.15s; }
.group-item:hover, .group-item.active { background-color: var(--menuColor) !important; }
.group-item.active { border-color: var(--borderColor); }
.group-item-title { display: flex; align-items: center; gap: 5px; }
.group-item-title i { font-size: 12px; }
.group-item-title span { font-size: 12px; font-weight: bold; }
.group-item-desc { font-size: 10px; color: var(--borderColor); margin-top: 3px; margin-left: 20px; }
.sidebar-actions { margin-top: auto; border-top: 1px solid var(--borderColor); padding-top: 5px; flex-shrink: 0; }
.sidebar-actions-title { font-weight: bold; font-size: 12px; margin-bottom: 5px; color: var(--borderColor); }
.sidebar-actions-buttons { display: flex; gap: 5px; }
.action-btn { align-items: center; justify-content: center; flex: 1; margin: 0 !important; }

/* ====== Content Area ====== */
/* 边框与内边距去掉：三个面板（版本 / 策略 / 设置）直接贴合宿主区域，
   只有面板内部的左右分栏用一条分隔线（.kb-nav 的 border-right）区分 */
.config-content { flex: 1; min-height: 0; border: 0; border-radius: 0; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.config-inner { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ====== Knowledge Base（标题行 + Grid 列表，参照工具设置面板） ====== */
.kb-section { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; }
.kb-list-head { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* 刷新按钮：仅图标，样式轻量 */
.kb-refresh-btn {
  flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; margin: 0; padding: 0;
  border: none; background: transparent;
  color: var(--borderColor); font-size: 11px;
  cursor: pointer; border-radius: 3px;
  transition: color .12s, background-color .12s;
}
.kb-refresh-btn:hover { color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.kb-refresh-btn.spinning { color: var(--fontActiveColor); }
.kb-refresh-btn.spinning .fa { animation: kb-spin 1s linear infinite; }
@keyframes kb-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
.kb-head-title { font-size: 11px; opacity: .9; font-weight: 600; white-space: nowrap; }
.kb-head-desc { font-size: 10px; opacity: .6; white-space: nowrap; }

.kb-list { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.kb-loading { display: flex; justify-content: center; align-items: center; height: 100px; }
.kb-loading-icon { font-size: 24px; color: var(--borderColor); }
.kb-empty { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 200px; color: var(--borderColor); }
.kb-empty-icon { font-size: 48px; margin-bottom: 16px; }
.kb-empty-text { margin-bottom: 8px; }
.kb-empty-hint { font-size: 12px; }

/* 知识库列表：2-3 列自适应网格 */
.kb-list-content {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  align-content: start;
}

/* ====== KB Card（参照工具设置面板的 tool-item 风格） ====== */
.kb-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  transition: all .12s;
  min-width: 0;
}
.kb-card:hover { border-color: var(--fontActiveColor); }
.kb-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kb-icon {
  width: 32px; height: 32px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, #4CAF50 12%, transparent);
  border-radius: 5px; color: #4CAF50; font-size: 15px;
}
.kb-info { flex: 1; min-width: 0; }
.kb-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kb-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-model-badge {
  font-size: 9px; padding: 0 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 140px;
}
.kb-desc { font-size: 10px; opacity: .7; margin-top: 1px; display: flex; align-items: center; gap: 6px; }
.kb-ver-badge {
  font-size: 9px; padding: 0 4px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border: 1px solid var(--borderColor); color: var(--fontColor);
}
.kb-actions { display: flex; gap: 4px; flex-shrink: 0; }
.kb-actions .icon-btn { width: 23px; height: 23px; margin: 0; padding: 0; border: none; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
.kb-actions .icon-btn.danger:hover { color: #F56C6C; }

/* ====== KB 紧凑统计 ====== */
.kb-meta { display: flex; gap: 10px; flex-wrap: wrap; }
.kb-meta .meta-item { font-size: 10px; opacity: .75; display: inline-flex; align-items: center; gap: 3px; color: var(--fontColor); }

/* ====== KB Status ====== */
.kb-status { display: flex; gap: 5px; flex-wrap: wrap; }
.kb-status-tag {
  font-size: 9px; padding: 1px 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  border: 1px solid var(--borderColor); white-space: nowrap;
}
.kb-status-tag.c-grey { opacity: .55; }

/* ====== 版本管理：左栏导航 + 右栏详情（与插件管理面板同构） ====== */
.kb-manage { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.kb-manage-split {
  display: flex; flex: 1; min-height: 0; overflow: hidden;
  /* 不再套外框：面板整体无边框，左栏与详情之间只靠 .kb-nav 的 border-right 分隔 */
  border: 0; border-radius: 0;
}
.kb-nav {
  width: 252px; min-width: 252px; flex-shrink: 0;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  min-height: 0;
}
.kb-nav-toolbar {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 5px; border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.kb-nav-btn {
  flex: 0 0 24px; width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  font-size: 11px; cursor: pointer; transition: all .12s;
}
.kb-nav-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.kb-nav-btn.spinning .fa { animation: kb-spin 1s linear infinite; }
.kb-nav-count { margin-left: auto; font-size: 10px; opacity: .6; white-space: nowrap; }
.kb-nav-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
.kb-nav-items { display: flex; flex-direction: column; gap: 2px; }
.kb-nav-item {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 6px 7px; border-radius: 4px; cursor: pointer;
  border: 1px solid transparent; min-width: 0;
}
.kb-nav-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.kb-nav-item.active {
  background: var(--menuActiveColor);
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, transparent);
  color: var(--fontActiveColor);
}
.kb-nav-icon { flex: 0 0 auto; width: 14px; text-align: center; font-size: 11px; opacity: .8; padding-top: 2px; }
.kb-nav-main { flex: 1; min-width: 0; }
.kb-nav-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-nav-sub { display: flex; align-items: center; gap: 6px; font-size: 10px; opacity: .62; margin-top: 2px; white-space: nowrap; }
.kb-nav-desc {
  font-size: 10px; opacity: .55; margin-top: 3px; line-height: 1.35;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
  -webkit-box-orient: vertical;
}
.kb-nav-ok { flex: 0 0 auto; font-size: 10px; color: #4CAF50; padding-top: 2px; }

.kb-detail { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.kb-detail-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 20px; text-align: center; font-size: 12px; opacity: .55; line-height: 1.6;
}
.kb-detail-empty i { font-size: 20px; }
.kb-detail-empty-title { font-weight: 600; }
.kb-detail-empty-hint { font-size: 11px; opacity: .8; max-width: 320px; }
.kb-detail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 5px; }
.kb-detail-head {
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 5px; border-bottom: 1px solid var(--borderColor);
}
.kb-detail-title {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600;
}
.kb-detail-title > span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-detail-actions { flex-shrink: 0; display: flex; gap: 4px; }
.kb-detail-actions .icon-btn {
  width: 24px; height: 24px; margin: 0; padding: 0; border: none;
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px;
}
.kb-detail-actions .icon-btn.danger:hover { color: #F56C6C; }
.kb-detail-section { margin-top: 12px; }
.kb-detail-section-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; font-weight: 600; opacity: .85; margin-bottom: 5px;
}
.kb-detail-link {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; font-weight: 400; cursor: pointer; color: var(--fontActiveColor);
}
.kb-detail-link:hover { text-decoration: underline; }
.kb-detail-desc { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.kb-detail-desc.empty { opacity: .5; white-space: normal; }
.kb-desc-input {
  width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical;
  padding: 6px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  font-size: 12px; line-height: 1.5; font-family: inherit;
}
.kb-desc-input:focus { outline: none; border-color: var(--fontActiveColor); }
.kb-detail-desc-actions { display: flex; align-items: center; gap: 6px; }
/* 说明的「保存 / 取消」：全局 .button 的 margin + 默认字号在详情里偏大，
   这里收成 24px 高的紧凑按钮（图标 10px、文字 11px），与面板其余控件同一档 */
.kb-detail-desc-actions .button {
  margin: 0;
  height: 24px;
  min-height: 24px;
  width: auto;
  padding: 0 9px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
}
.kb-detail-desc-actions .button i { font-size: 10px; }
.kb-detail-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 5px 10px;
}
.kb-detail-kv {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 11px; padding: 4px 7px; border-radius: 4px;
  background: color-mix(in srgb, var(--fontColor) 5%, transparent);
}
.kb-detail-kv .k { opacity: .65; white-space: nowrap; }
.kb-detail-kv .v { font-weight: 600; }
.kb-detail-row { display: flex; align-items: baseline; gap: 10px; font-size: 11px; padding: 3px 0; }
.kb-detail-row .k { flex: 0 0 84px; width: 84px; opacity: .65; }
.kb-detail-row .v { flex: 1; min-width: 0; word-break: break-all; }
.kb-detail-path { font-size: 10px; opacity: .85; cursor: pointer; }
.kb-detail-path:hover { color: var(--fontActiveColor); text-decoration: underline; }
.kb-vec-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.kb-vec-btn {
  margin: 0;
  height: 24px;
  min-height: 24px;
  width: auto;
  padding: 0 9px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
}
.kb-vec-btn i { font-size: 10px; }
.kb-vec-btn:disabled { opacity: .45; cursor: not-allowed; }
.kb-vec-btn.danger:hover:not(:disabled) { color: #F56C6C; border-color: #F56C6C; }
.kb-vec-progress { margin-top: 5px; font-size: 10px; opacity: .75; display: flex; align-items: center; gap: 5px; }
.kb-vec-note { font-size: 11px; opacity: .7; line-height: 1.55; display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.kb-vec-note-text { flex: 1; min-width: 200px; }
.kb-vec-warn {
  display: flex; align-items: flex-start; gap: 5px;
  margin-top: 5px; padding: 4px 6px; border-radius: 4px;
  font-size: 10px; line-height: 1.5;
  color: #E6A23C;
  background: color-mix(in srgb, #E6A23C 12%, transparent);
  border: 1px solid color-mix(in srgb, #E6A23C 35%, transparent);
}

/* 相关文件：一个文件一张卡（图标 + 文件名 + 角色 + 大小） */
/* ===== 详情页文件卡片（.kb / .kbdb 大卡 + 附属文件小卡） ===== */
.kb-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 7px;
  background: var(--menuColor);
  box-sizing: border-box;
}
.kb-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.kb-card-icon { flex: 0 0 16px; width: 16px; text-align: center; font-size: 13px; color: var(--fontActiveColor); }
.kb-card-name { min-width: 0; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-card-role { flex: 0 0 auto; font-size: 10px; opacity: .55; }
.kb-card-size { flex: 0 0 auto; margin-left: auto; font-size: 10px; opacity: .7; font-variant-numeric: tabular-nums; }
.kb-card-hint { flex: 0 0 auto; font-size: 10px; opacity: .55; }
.kb-card-stats { display: flex; flex-wrap: wrap; gap: 3px 12px; font-size: 10.5px; opacity: .85; }
.kb-card-stats b { font-weight: 600; opacity: .95; }
.kb-card-meta { display: flex; flex-wrap: wrap; gap: 3px 12px; font-size: 10px; opacity: .68; }
.kb-card-meta b { font-weight: 500; opacity: .9; }
.kb-card-meta i { margin-right: 4px; opacity: .7; }
.kb-card-desc { padding-top: 5px; border-top: 1px dashed var(--borderColor); }
.kb-card-desc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; font-size: 10.5px; opacity: .7; }
.kb-card-desc-text { font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.kb-card-desc-text.empty { opacity: .5; }
.kb-card-path { font-size: 9.5px; opacity: .5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.kb-card-path:hover { color: var(--fontActiveColor); text-decoration: underline; }
.kb-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
/* 详情顶部工具栏：加载 / 重命名 / 打开文件夹 / 删除 */
.kb-detail-toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 3px 0 6px; margin-bottom: 2px; }
/* 工具栏下方的说明面板（不塞进 .kb 卡片） */
.kb-desc-panel {
  padding: 7px 10px;
  margin-bottom: 8px;
  border: 1px solid var(--borderColor);
  border-radius: 7px;
  background: var(--backgroundColor);
  box-sizing: border-box;
}
.kb-desc-panel .kb-card-desc-head { margin-bottom: 4px; }
.kb-card-db { border-color: color-mix(in srgb, var(--fontActiveColor) 28%, var(--borderColor)); }
.kb-card-db.empty { opacity: .85; }
.kb-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.kb-card-small { margin-bottom: 0; padding: 6px 8px; gap: 4px; cursor: pointer; }
.kb-card-small:hover { border-color: var(--fontActiveColor); }

.kb-file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.kb-file-card {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; min-width: 0;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor); cursor: pointer;
  transition: border-color .12s, background-color .12s;
}
.kb-file-card:hover { border-color: var(--fontActiveColor); background: var(--menuActiveColor); }
.kb-file-icon {
  flex: 0 0 22px; width: 22px; height: 22px; line-height: 22px;
  text-align: center; border-radius: 4px; font-size: 11px;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  color: var(--fontActiveColor);
}
.kb-file-main { flex: 1; min-width: 0; }
.kb-file-name { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-file-meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 10px; opacity: .65; white-space: nowrap; }
.kb-file-role { overflow: hidden; text-overflow: ellipsis; }
.kb-file-size { margin-left: auto; font-variant-numeric: tabular-nums; }
.kb-detail-hint { opacity: .55; font-size: 10px; }
@media (max-width: 820px) {
  .kb-nav { width: 200px; min-width: 200px; }
}

/* ====== Config Items（参考设置界面：label + 控件单行紧凑布局） ====== */
.config-section { display: flex; flex-direction: column; gap: 6px; height: 100%; overflow: hidden; padding: 6px 8px; box-sizing: border-box; }
.config-scroll { flex: 1; overflow-y: auto; padding-right: 5px; }
.config-items { display: flex; flex-direction: column; gap: 8px; }
.config-item { display: flex; align-items: center; gap: 8px; min-width: 0; }
.config-item-label {
  flex-shrink: 0; width: 150px; min-width: 0;
  text-align: right; font-size: 12px; color: var(--fontColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: help;
}
.config-item-label.left { text-align: left; }
.config-item-field { flex: 1; min-width: 0; display: flex; align-items: center; }

/* ====== Form Controls ====== */
.config-input, .config-select, .config-number { width: 100%; max-width: 100%; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; background-color: var(--backgroundColor); color: var(--fontColor); box-sizing: border-box; margin:0px}
.config-input:focus, .config-select:focus, .config-number:focus, .config-textarea:focus { outline: none; border-color: var(--fontActiveColor); }
.config-range-wrap { display: flex; align-items: center; gap: 10px; width: 100%; }
.config-range { flex: 1; min-width: 0; width: 100%; margin:0px }
.config-range-value { font-size: 12px; min-width: 40px; flex-shrink: 0; text-align: right; }
.config-textarea { width: 100%; max-width: 100%; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; min-height: 80px; resize: vertical; box-sizing: border-box; background-color: var(--backgroundColor); color: var(--fontColor); }
.config-checkbox-label { display: flex; align-items: center; gap: 5px; cursor: pointer; width: 100%; padding: 0px }
.config-checkbox-input { width: 16px; height: 16px; flex-shrink: 0; }
.config-checkbox-text { font-size: 12px; }
.config-display { padding: 6px 8px; border: 1px solid var(--borderColor); border-radius: 4px; font-size: 12px; background-color: var(--menuColor); box-sizing: border-box; }

/* ====== 嵌入模型选择行（处理配置） ====== */
.config-embed-row { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; }
.config-embed-row .config-select { flex: 1; min-width: 0; }
.config-embed-refresh {
  flex-shrink: 0; width: 24px; height: 24px; margin: 0; padding: 0;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--menuColor); color: var(--borderColor);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; cursor: pointer;
}
.config-embed-refresh:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
/* 评测用嵌入模型覆盖提示（测试标签页设置；仅提示，不改变设置值） */
.config-embed-override {
  display: flex; align-items: center; gap: 5px; margin-top: 4px;
  font-size: 11px; color: #FF9800; cursor: help;
}
.config-embed-override i { flex-shrink: 0; }

/* ====== Weight Info ====== */
.weight-info { margin: 15px 0; padding: 12px; border: 1px dashed var(--borderColor); border-radius: 5px; background-color: rgba(0,0,0,0.02); }
.weight-info-title { font-size: 12px; color: var(--borderColor); margin-bottom: 8px; display: flex; align-items: center; gap: 5px; }
.weight-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; font-size: 11px; }
.weight-item { text-align: center; }
.weight-label { font-weight: bold; margin-bottom: 4px; }
.weight-value { font-size: 14px; font-weight: bold; }

/* ====== Empty State ====== */
.empty-state { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 200px; color: var(--borderColor); width: 100%; }
.empty-state-icon { font-size: 48px; margin-bottom: 16px; }
.empty-state-text { margin-bottom: 8px; }
.empty-state-hint { font-size: 12px; }

/* ====== Color Helpers ====== */
.c-green { color: #4CAF50; }
.c-blue { color: #2196F3; }
.c-orange { color: #FF9800; }
.c-purple { color: #9C27B0; }
.c-brown { color: #795548; }
.c-cyan { color: #00BCD4; }
.c-teal { color: #009688; }
.c-indigo { color: #3F51B5; }
</style>