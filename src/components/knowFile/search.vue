<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import { workspaceRoots } from '@/services/workspaceScan'
import * as kbAi from '@/shared/kbAiClient'

const store = usestore()
/** 宿主（explorer）提供：右侧文件标签有未保存内容时先询问，返回 false 取消打开 */
const props = defineProps<{ guardLeave?: () => Promise<boolean> }>()

type SearchMode = 'keyword' | 'semantic'
const SEARCH_MODES: Array<{ id: SearchMode; zh: string; en: string }> = [
  { id: 'keyword', zh: '关键字', en: 'Keyword' },
  { id: 'semantic', zh: '语义', en: 'Semantic' },
]

const localResults = ref<any[]>([])
const ifloading = ref(false)
const filterText = ref('')
const searchMode = ref<SearchMode>('keyword')
const searchError = ref('')
const searchHint = ref('')
let timer: any = null
/** 每次搜索的序号：用户继续输入 / 切换模式时，旧结果不得覆盖新结果 */
let searchSeq = 0

const tr = (zh: string, en: string) => (store.locales === 'zh' ? zh : en)

/** 语义搜索只读取这些文本类型；其它二进制文件不参与嵌入 */
const SEM_TEXT_EXTS = ['.md', '.txt', '.json', '.csv', '.yml', '.yaml', '.html', '.ts', '.js', '.py']
const SEM_SKIP_DIRS = ['node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron', 'build', 'release', 'out', 'coverage', '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vs', 'vendor', 'android', 'ios', 'resources', '__pycache__', '.venv', 'venv']
/** 首次语义搜索最多比较的文件数：避免一次把整个大工作区全部向量化 */
const SEM_MAX_FILES = 500
const SEM_TEXT_CHARS = 1600
const SEM_BATCH = 16
const SEM_CACHE_MAX = 2000
/** path -> { sig（大小）, model（嵌入模型）, vec, text }；文件大小或嵌入模型变化时重新嵌入 */
const semCache = new Map<string, { sig: string; model: string; vec: number[]; text: string }>()

/** 全部已打开工作区（含当前根目录兜底） */
const kbRoots = (): string[] => [...new Set(workspaceRoots(store.roots, store.root))]

/** 当前 AI 来源的嵌入规格（含设置里的嵌入兜底） */
function buildEmbedSpec(): kbAi.KbModelSpec {
  const llm = store.AIconfig?.llm || {}
  const type = String(llm.type || 'ollama')
  const cfg = kbAi.getProviderConfig(llm, type) || {}
  return {
    llmType: type as any,
    config: cfg,
    embed: String(cfg.embed_model || '').trim(),
    chat: String(cfg.model || ''),
    process: String(cfg.model || ''),
    embedFallback: kbAi.buildEmbedFallbackFromStore(store),
  } as kbAi.KbModelSpec
}

/** 没有配置/找不到可用嵌入模型时给出明确提示；返回 null 表示不要继续语义搜索 */
function requireEmbeddingSpec(): kbAi.KbModelSpec | null {
  const spec = buildEmbedSpec()
  const eff = kbAi.effectiveEmbedSpec(spec)
  const model = String((eff as any)?.embed || (eff as any)?.config?.embed_model || '').trim()
  if (!model) {
    searchError.value = tr(
      '未设置嵌入模型：请到「设置 → AI 来源」配置嵌入模型，或设置「嵌入兜底」模型后再使用语义搜索。',
      'No embedding model configured. Set one under Settings → AI Sources, or configure an embedding fallback, then use semantic search.',
    )
    return null
  }
  return spec
}

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function snippetOf(text: string, keyword: string): string {
  const body = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!body) return ''
  const kw = keyword.trim()
  if (kw) {
    const idx = body.toLowerCase().indexOf(kw.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - 70)
      const end = Math.min(body.length, idx + kw.length + 150)
      return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ')}${end < body.length ? '…' : ''}`
    }
  }
  return body.slice(0, 220).replace(/\s+/g, ' ')
}

function rememberSem(path: string, sig: string, model: string, vec: number[], text: string) {
  if (semCache.size > SEM_CACHE_MAX) semCache.clear()
  semCache.set(path, { sig, model, vec, text })
}

/** 关键字搜索：逐个工作区调用现有全文搜索 API，再按路径去重 */
async function keywordSearch(keyword: string, seq: number) {
  const roots = kbRoots()
  if (!roots.length) {
    searchError.value = tr('还没有打开任何工作区。', 'No workspace is open.')
    localResults.value = []
    return
  }
  searchHint.value = tr(`在 ${roots.length} 个工作区中搜索…`, `Searching ${roots.length} workspace(s)…`)
  const packs = await Promise.all(roots.map(root =>
    getPlatform().fs.searchFiles(root, keyword).catch(() => [] as any[]),
  ))
  if (seq !== searchSeq) return
  const seen = new Set<string>()
  const out: any[] = []
  for (const list of packs) {
    for (const item of (list || [])) {
      if (!item || item.type === 'folder' || !item.path) continue
      const key = String(item.path).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  localResults.value = out
  searchHint.value = out.length
    ? tr(`全部工作区共 ${out.length} 个匹配文件`, `${out.length} matching file(s) across all workspaces`)
    : ''
}

/** 语义搜索：扫描全部工作区的文本文件，嵌入后按余弦相似度排序 */
async function semanticSearch(keyword: string, seq: number) {
  const roots = kbRoots()
  if (!roots.length) {
    searchError.value = tr('还没有打开任何工作区。', 'No workspace is open.')
    localResults.value = []
    return
  }
  const spec = requireEmbeddingSpec()
  if (!spec) { localResults.value = []; return }
  const effSpec = kbAi.effectiveEmbedSpec(spec) as any
  const modelKey = String(effSpec?.embed || effSpec?.config?.embed_model || '')

  searchHint.value = tr(`正在扫描 ${roots.length} 个工作区…`, `Scanning ${roots.length} workspace(s)…`)
  const packs = await Promise.all(roots.map(root =>
    getPlatform().fs.scan(root, {
      extensions: SEM_TEXT_EXTS,
      excludeDirs: SEM_SKIP_DIRS,
      maxFiles: 2000,
    }).catch(() => ({ success: false, files: [] as any[] })),
  ))
  if (seq !== searchSeq) return

  const seen = new Set<string>()
  const files: any[] = []
  for (const pack of packs) {
    for (const f of ((pack as any)?.files || [])) {
      const p = String(f?.filePath || '')
      if (!p) continue
      const key = p.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (Number(f.size || 0) > 2 * 1024 * 1024) continue
      files.push(f)
    }
  }
  if (!files.length) {
    localResults.value = []
    searchHint.value = tr('工作区里没有可做语义搜索的文本文件。', 'No text files available for semantic search.')
    return
  }
  const limited = files.slice(0, SEM_MAX_FILES)
  if (limited.length < files.length) {
    searchHint.value = tr(
      `文本文件较多，本次只比较前 ${limited.length} 个（可按关键字先缩小范围）。`,
      `Many text files; comparing the first ${limited.length} only (use keyword mode to narrow down first).`,
    )
  }

  // 先嵌入查询：模型不存在 / 服务不可用时在这里给出提示
  let queryVec: number[]
  try {
    const vecs = await kbAi.embed(spec, [keyword])
    queryVec = vecs?.[0] || []
    if (!queryVec.length) throw new Error('嵌入服务返回空向量')
  } catch (e: any) {
    searchError.value = tr(
      `嵌入模型不可用：${e?.message || e || '未知错误'}`,
      `Embedding model unavailable: ${e?.message || e || 'unknown error'}`,
    )
    searchHint.value = ''
    localResults.value = []
    return
  }
  if (seq !== searchSeq) return

  // 读取/复用文件文本 + 向量
  const entries: Array<{ f: any; text: string; vec: number[] }> = []
  const pending: Array<{ f: any; text: string; idx: number }> = []
  for (const f of limited) {
    if (seq !== searchSeq) return
    const p = String(f.filePath)
    const sig = String(f.size ?? '')
    const cached = semCache.get(p)
    if (cached && cached.sig === sig && cached.model === modelKey && cached.vec?.length) {
      entries.push({ f, text: cached.text, vec: cached.vec })
      continue
    }
    let text = ''
    try {
      text = String(await getPlatform().fs.readText(p) || '').slice(0, SEM_TEXT_CHARS)
    } catch { text = '' }
    if (!text.trim()) continue
    entries.push({ f, text, vec: [] })
    pending.push({ f, text, idx: entries.length - 1 })
  }

  for (let i = 0; i < pending.length; i += SEM_BATCH) {
    if (seq !== searchSeq) return
    const batch = pending.slice(i, i + SEM_BATCH)
    searchHint.value = tr(
      `语义搜索：正在嵌入 ${Math.min(i + batch.length, pending.length)}/${pending.length} 个文件…`,
      `Semantic search: embedding ${Math.min(i + batch.length, pending.length)}/${pending.length} file(s)…`,
    )
    try {
      const vecs = await kbAi.embed(spec, batch.map(x => x.text))
      batch.forEach((x, j) => {
        const vec = vecs?.[j] || []
        if (!vec.length) return
        entries[x.idx].vec = vec
        rememberSem(String(x.f.filePath), String(x.f.size ?? ''), modelKey, vec, x.text)
      })
    } catch (e: any) {
      searchError.value = tr(
        `嵌入模型不可用：${e?.message || e || '未知错误'}`,
        `Embedding model unavailable: ${e?.message || e || 'unknown error'}`,
      )
      searchHint.value = ''
      localResults.value = []
      return
    }
  }
  if (seq !== searchSeq) return

  const ranked = entries
    .filter(e => e.vec?.length)
    .map(e => ({
      path: String(e.f.filePath || ''),
      label: String(e.f.fileName || ''),
      type: 'file',
      extension: String(e.f.extension || ''),
      score: cosine(queryVec, e.vec),
      arr: [snippetOf(e.text, keyword)],
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)

  localResults.value = ranked
  searchHint.value = ranked.length
    ? tr(`语义搜索：从 ${entries.length} 个文本文件中找到 ${ranked.length} 个结果`, `Semantic: ${ranked.length} result(s) from ${entries.length} text file(s)`)
    : tr(`语义搜索：已比较 ${entries.length} 个文本文件，没有找到相近内容。`, `Semantic: compared ${entries.length} text file(s); nothing close enough.`)
}

const getResults = async (keyword: string) => {
  const kw = String(keyword || '').trim()
  const seq = ++searchSeq
  searchError.value = ''
  searchHint.value = ''
  if (!kw) {
    localResults.value = []
    ifloading.value = false
    return
  }
  ifloading.value = true
  localResults.value = []
  try {
    if (searchMode.value === 'semantic') await semanticSearch(kw, seq)
    else await keywordSearch(kw, seq)
  } catch (e: any) {
    if (seq === searchSeq) {
      searchError.value = tr(`搜索失败：${e?.message || e}`, `Search failed: ${e?.message || e}`)
      localResults.value = []
    }
  } finally {
    if (seq === searchSeq) ifloading.value = false
  }
}

watch([filterText, searchMode], () => {
  clearTimeout(timer)
  timer = setTimeout(() => { void getResults(filterText.value) }, 500)
})

const open = async (data: any) => {
  if (!data || !data.path) return
  // 先处理右侧文件标签的未保存内容（单窗口模式下搜索会切到新的文件标签）
  if (props.guardLeave && !(await props.guardLeave())) return
  store.openFileByMode({
    path: data.path,
    label: data.label,
    type: data.type === 'folder' ? 'folder' : 'file',
    extension: data.extension || '',
  })
}

onBeforeUnmount(() => { clearTimeout(timer) })
</script>

<template>
  <div class="bg">
    <!-- 搜索框：关键字（默认）/ 语义 两种模式 -->
    <div class="search-bar">
      <i class="fa fa-search"></i>
      <input
        v-model="filterText"
        class="search"
        :placeholder="searchMode === 'semantic'
          ? (store.locales == 'zh' ? '描述你想找的内容（语义搜索）' : 'Describe what you are looking for (semantic)')
          : (store.locales == 'zh' ? '在所有工作区搜索文件名 / 内容' : 'Search file names / content in all workspaces')"
      />
      <div class="search-mode-group" :title="store.locales == 'zh' ? '关键字：按文件名/正文匹配；语义：用嵌入模型找最相关的文件' : 'Keyword: name/text match; Semantic: embeddings rank the most relevant files'">
        <button
          v-for="m in SEARCH_MODES"
          :key="m.id"
          type="button"
          class="search-mode-btn"
          :class="{ active: searchMode === m.id }"
          @click="searchMode = m.id"
        >{{ store.locales == 'zh' ? m.zh : m.en }}</button>
      </div>
      <div v-if="filterText" class="search-clear" @click="filterText=''" :title="store.locales == 'zh' ? '清除' : 'Clear'">
        <i class="fa fa-times-circle"></i>
      </div>
    </div>
    <!-- 搜索范围 / 进度 -->
    <div class="search-hint" v-if="searchHint || (filterText && searchMode === 'semantic' && !ifloading && !searchError)">
      <i class="fa" :class="ifloading ? 'fa-spinner fa-spin' : 'fa-globe'"></i>
      {{ searchHint || (store.locales == 'zh' ? '语义搜索会读取并嵌入全部工作区的文本文件，首次较慢。' : 'Semantic search embeds text files from all workspaces; the first run is slower.') }}
    </div>
    <!-- 没有嵌入模型 / 模型不可用 -->
    <div class="search-error" v-if="searchError">
      <i class="fa fa-exclamation-circle"></i>
      {{ searchError }}
    </div>
    <!-- 结果统计 -->
    <div class="result-info" v-if="filterText != '' && !ifloading && localResults.length && !searchError">
      {{ store.locales == 'zh' ? `共 ${localResults.length} 个匹配结果（全部工作区）` : `${localResults.length} result(s) across all workspaces` }}
    </div>
    <!-- 结果卡片 -->
    <div class="content scoll">
      <div class="loading" v-if="ifloading">
        <i class="fa fa-spinner fa-spin fa-1x"></i>
      </div>
      <div class="empty" v-if="filterText != '' && !ifloading && !localResults.length && !searchError">
        <i class="fa fa-file-o"></i>
        <span>{{ searchMode === 'semantic'
          ? (store.locales == 'zh' ? '没有找到语义相近的文件' : 'No semantically similar files')
          : (store.locales == 'zh' ? '没有找到匹配的文件' : 'No matching files') }}</span>
      </div>
      <div class="card" v-for="item, index in localResults" :key="index" @dblclick="open(item)" :title="item.path">
        <div class="card-header">
          <i :class="store.icon(item.extension)" class="card-icon"></i>
          <span class="card-name" :title="item.label">{{ item.label }}</span>
          <span v-if="item.score != null" class="card-score" :title="store.locales == 'zh' ? '语义相关度' : 'Semantic score'">{{ Math.round(item.score * 100) }}%</span>
        </div>
        <div class="card-snippets scoll" v-if="item.arr != undefined && item.arr.length">
          <div class="snippet" v-for="(arr, sIndex) in item.arr" :key="sIndex">{{ arr }}</div>
        </div>
        <div class="card-empty" v-else>
          <span>{{ store.locales == 'zh' ? '（无内容预览）' : '(No preview)' }}</span>
        </div>
        <div class="card-path">{{ item.path }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .bg {
    position: relative;
    height: calc(100% - 2px);
    overflow-y: hidden;
    display: flex;
    flex-direction: column;
    background-color: var(--backgroundColor);
  }

  /* 搜索框 */
  .search-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 5px 5px 0 5px;
    height: 30px;
    padding: 0 5px;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background-color: var(--backgroundColor);
  }
  .search-bar > i {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--fontColor);
    opacity: 0.6;
  }
  .search {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--fontColor);
    font-size: 13px;
  }
  /* 搜索模式：紧凑的主题内联切换组（不用原生 select，避免宽度撑满与下拉配色不跟随主题） */
  .search-mode-group {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 1px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    background: var(--menuColor);
    box-sizing: border-box;
  }
  .search-mode-btn {
    height: 100%;
    padding: 0 6px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color .15s, color .15s;
  }
  .search-mode-btn:hover { color: var(--fontActiveColor); }
  .search-mode-btn.active {
    background: var(--menuActiveColor);
    color: var(--fontActiveColor);
    font-weight: 600;
  }
  .search-clear {
    flex-shrink: 0;
    cursor: pointer;
    color: var(--borderColor);
    font-size: 13px;
  }
  .search-clear:hover {
    color: var(--fontActiveColor);
  }

  /* 搜索范围 / 进度 / 错误 */
  .search-hint,
  .search-error {
    flex-shrink: 0;
    padding: 6px 12px 0 12px;
    font-size: 11px;
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .search-hint { color: var(--fontColor); opacity: 0.65; }
  .search-error { color: #e81123; }

  /* 结果统计 */
  .result-info {
    flex-shrink: 0;
    padding: 6px 12px 0 12px;
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.7;
  }

  /* 结果网格 */
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    align-content: start;
  }

  /* 卡片：标题固定顶部 + 内容区滚动 + 路径底部，固定高度 */
  .card {
    position: relative;
    height: 220px;
    border: 1px solid var(--borderColor);
    border-radius: 8px;
    background-color: var(--backgroundColor);
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    user-select: none;
  }
  .card:hover {
    border-color: var(--primaryColor);
    background-color: var(--menuActiveColor);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  .card-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--borderColor);
    min-width: 0;
    background-color: var(--menuColor);
  }
  .card-header .card-icon {
    flex-shrink: 0;
    font-size: 15px;
    color: var(--primaryColor);
  }
  .card-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fontActiveColor);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-score {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--fontActiveColor);
    opacity: 0.75;
  }
  .card-snippets {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  }
  .snippet {
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.85;
    line-height: 1.6;
    word-break: break-all;
  }
  .card-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.4;
  }
  .card-path {
    flex-shrink: 0;
    border-top: 1px solid var(--borderColor);
    padding: 8px 12px;
    font-size: 11px;
    color: var(--fontColor);
    opacity: 0.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 加载中 / 空状态（跨整行居中） */
  .loading,
  .empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 0;
    color: var(--fontColor);
    opacity: 0.5;
  }
  .empty i {
    font-size: 40px;
  }
  .empty span {
    font-size: 13px;
  }
</style>
