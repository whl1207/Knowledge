<!-- SkillStore.vue - 技能商店模块 -->
<template>
  <div class="agent-skill">
    <!-- ====== 商店内容 ====== -->
    <div class="store-content">
      <div class="store-body">
        <!-- 左侧：来源列表（可搜索 / 添加 / 删除） -->
        <div class="store-sources">
          <div class="store-sources-add">
            <input v-model="customSourceInput" :placeholder="store.locales === 'en' ? 'owner/repo' : 'owner/repo'" @keyup.enter="addCustomSource" :title="store.locales === 'en' ? 'Add custom source (owner/repo)' : '添加自定义来源（owner/repo）'" />
            <div class="button small store-add-btn" @click="addCustomSource" :title="store.locales === 'en' ? 'Add source' : '添加来源'">
              <i class="fa fa-plus"></i>
            </div>
            <div class="button small store-reset-btn" @click="resetSources" :title="store.locales === 'en' ? 'Reset to built-in sources' : '重置为内置来源'">
              <i class="fa fa-undo"></i>
            </div>
          </div>
          <div v-if="customSourceError" class="store-custom-error">{{ customSourceError }}</div>
          <div class="store-sources-list">
            <div
              v-for="src in storeSources"
              :key="src.url"
              class="store-source-item"
              :class="{ active: storeSource?.url === src.url }"
              @click="selectSource(src)"
              :title="src.name"
            >
              <i class="fa" :class="src.custom ? 'fa-star' : (src.type === 'http' ? 'fa-globe' : 'fa-github')"></i>
              <span class="store-source-name">{{ src.name }}</span>
              <span class="store-source-remove" @click.stop="removeSource(src)" :title="store.locales === 'en' ? 'Remove source' : '删除来源'">
                <i class="fa fa-times"></i>
              </span>
            </div>
          </div>
        </div>
        <!-- 中间：技能列表（详情打开时收缩为窄的一列，近似左侧来源导航） -->
        <div class="store-skills" :class="{ 'is-narrow': !!detailSkill }">
          <div class="store-skills-toolbar">
            <i class="fa fa-search"></i>
            <input v-model="storeSearch" :placeholder="store.locales === 'en' ? 'Search skills...' : '搜索技能...'" />
            <span class="store-count" v-if="filteredStoreSkills.length > 0">{{ filteredStoreSkills.length }} {{ store.locales === 'en' ? 'skills' : '个技能' }}</span>
            <div
              class="button small store-content-toggle"
              :class="{ on: contentSearchOn }"
              @click="toggleContentSearch"
              :title="store.locales === 'en'
                ? 'Content search: also match SKILL.md body, append hits as found (GitHub rate-limited, scans up to 60 per run)'
                : '内容搜索：同时匹配 SKILL.md 正文，命中即追加显示（GitHub 限流，单次最多扫描 60 个）'"
            >
              <i class="fa" :class="contentSearchOn ? 'fa-file-text' : 'fa-file-text-o'"></i>
            </div>
            <div class="button small" @click="loadStoreSkills(true)" :disabled="storeLoading" :title="store.locales === 'en' ? 'Refresh' : '刷新'">
              <i class="fa" :class="storeLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
            </div>
          </div>
          <!-- 内容搜索状态条：命中即追加，输入框始终保持可编辑 -->
          <div v-if="contentSearchOn && currentQuery" class="store-content-status">
            <template v-if="contentSearching">
              <i class="fa fa-spinner fa-spin"></i>
              <span>{{ store.locales === 'en' ? 'Searching SKILL.md content…' : '内容搜索 SKILL.md 正文…' }}</span>
              <span class="store-content-stat">· {{ store.locales === 'en' ? 'hit' : '已命中' }} {{ contentHits.length }}</span>
              <span class="store-content-stat">· {{ store.locales === 'en' ? 'scanned' : '已扫描' }} {{ contentProgress.done }}/{{ contentProgress.budget }}</span>
              <button class="store-content-stop" @click="stopContentSearch">{{ store.locales === 'en' ? 'Stop' : '停止' }}</button>
            </template>
            <template v-else-if="contentHits.length">
              <i class="fa fa-check-circle"></i>
              <span>{{ store.locales === 'en' ? `SKILL.md content hit ${contentHits.length}, appended` : `SKILL.md 正文命中 ${contentHits.length} 个，已追加` }}</span>
              <span v-if="contentProgress.capped" class="store-content-note">
                {{ store.locales === 'en' ? `(rate limit: only first ${contentProgress.budget} scanned)` : `（GitHub 限流：单次仅扫描前 ${contentProgress.budget} 个，换关键词继续搜可命中更多）` }}
              </span>
            </template>
            <template v-else-if="contentHitForQuery === currentQuery">
              <i class="fa fa-search"></i>
              <span>{{ store.locales === 'en' ? 'No SKILL.md content matched for this keyword' : '当前关键词未在 SKILL.md 正文命中，可换更短的关键词再搜' }}</span>
            </template>
            <template v-else>
              <i class="fa fa-hourglass-half"></i>
              <span>{{ store.locales === 'en' ? 'Content search pending…' : '内容搜索待开始…' }}</span>
            </template>
          </div>
          <div class="store-grid-wrap">
          <div class="store-skill-grid">
            <div
              v-for="skill in visibleStoreSkills"
              :key="skill.id"
              class="store-skill-item"
              @click="openSkillDetail(skill)"
              :title="store.locales === 'en' ? 'Click to view details' : '点击查看技能详情'"
            >
              <div class="store-skill-icon">
                <i class="fa fa-cube"></i>
              </div>
              <div class="store-skill-info">
                <div class="store-skill-name-row">
                  <span class="store-skill-name" :title="skill.name">{{ skill.name }}</span>
                  <span v-if="skill.hasSkillMd" class="store-skill-badge" :title="store.locales === 'en' ? 'Has SKILL.md' : '含 SKILL.md'">SKILL</span>
                </div>
                <div class="store-skill-desc" :class="{ 'is-placeholder': !skill.description && !skill.category }">
                  <template v-if="skill.description">{{ skill.description }}</template>
                  <template v-else-if="skill.category"><i class="fa fa-folder-open-o"></i> {{ skill.category }}</template>
                  <template v-else>{{ store.locales === 'en' ? 'Click to view details' : '点击查看详情' }}</template>
                </div>
                <div class="store-skill-meta">
                  <span class="meta-item" :title="store.locales === 'en' ? 'Source' : '来源'">
                    <i class="fa fa-github"></i> {{ skill.source }}
                  </span>
                  <span class="meta-item" :title="store.locales === 'en' ? 'Stars' : '星标'">
                    <i class="fa fa-star"></i> {{ skill.stars || 0 }}
                  </span>
                  <span v-if="skill.files && skill.files.length" class="meta-item" :title="store.locales === 'en' ? 'Files' : '文件数'">
                    <i class="fa fa-file-o"></i> {{ skill.files.length }}
                  </span>
                </div>
              </div>
              <button
                class="store-skill-download"
                :class="{ downloading: downloadingSkills.has(skill.id) }"
                :disabled="downloadingSkills.has(skill.id) || !store.skillsPath"
                @click.stop="downloadSkill(skill)"
                :title="!store.skillsPath ? (store.locales === 'en' ? 'Please set skills folder path in Settings first' : '请先在设置中配置技能文件夹路径') : (store.locales === 'en' ? 'Download this skill' : '下载此技能')"
              >
                <i class="fa" :class="downloadingSkills.has(skill.id) ? 'fa-spinner fa-spin' : 'fa-download'"></i>
              </button>
            </div>
            <!-- 滚动加载更多哨兵 -->
            <div ref="loadMoreSentinel" class="store-load-more" v-show="filteredStoreSkills.length > 0">
              <span v-if="storeLoading"><i class="fa fa-spinner fa-spin"></i> {{ store.locales === 'en' ? 'Loading...' : '加载中...' }}</span>
              <span v-else-if="hasMore" class="store-load-more-hint"><i class="fa fa-angle-double-down"></i> {{ store.locales === 'en' ? 'Scroll for more' : '继续下滑加载更多' }}</span>
              <span v-else class="store-load-more-done"><i class="fa fa-check"></i> {{ store.locales === 'en' ? 'All loaded' : '已全部加载' }} · {{ filteredStoreSkills.length }}</span>
            </div>
          </div>
          <!-- 加载 / 空状态覆盖层：只覆盖网格可视区，不遮挡上方搜索框（保证输入始终可编辑） -->
          <div v-if="storeLoading" class="store-overlay">
            <i class="fa fa-spinner fa-spin" style="font-size:24px;"></i>
            <span>{{ store.locales === 'en' ? 'Loading skill store...' : '正在加载技能商店...' }}</span>
          </div>
          <div v-else-if="filteredStoreSkills.length === 0" class="store-overlay">
            <i class="fa" :class="storeEmptyIcon"></i>
            <span>{{ storeEmptyText }}</span>
          </div>
          </div>
        </div>
        <!-- 右侧：技能详情栏（点击技能后显示，取消选择即隐藏，不占用浏览宽度） -->
        <div v-if="detailSkill" class="store-detail-pane">
          <div class="store-detail-head">
            <i class="fa fa-cube detail-head-icon"></i>
            <span class="store-detail-title" :title="detailSkill.name">{{ detailSkill.name }}</span>
            <span class="store-skill-badge">SKILL</span>
            <span v-if="detailCat" class="store-detail-sub" :title="detailCat">· {{ detailCat }}</span>
            <span class="store-detail-flex"></span>
            <button
              class="store-detail-download"
              :disabled="!store.skillsPath || downloadingSkills.has(detailSkill.id)"
              @click="downloadSkill(detailSkill)"
              :title="!store.skillsPath
                ? (store.locales === 'en' ? 'Please set skills folder path in Settings first' : '请先在设置中配置技能文件夹路径')
                : downloadingSkills.has(detailSkill.id)
                  ? (store.locales === 'en' ? 'Downloading...' : '正在下载...')
                  : (store.locales === 'en' ? 'Download this skill' : '下载此技能')"
            >
              <i class="fa" :class="downloadingSkills.has(detailSkill.id) ? 'fa-spinner fa-spin' : 'fa-download'"></i>
            </button>
            <button class="store-detail-close" :title="store.locales === 'en' ? 'Deselect' : '取消选择'" @click="deselectSkill"><i class="fa fa-times"></i></button>
          </div>
          <!-- 元信息 -->
          <div class="store-detail-meta">
            <span class="meta-item"><i class="fa fa-github"></i> {{ detailSkill.source }}</span>
            <span class="meta-item"><i class="fa fa-star"></i> {{ detailSkill.stars || 0 }}</span>
            <span v-if="detailSkill.files && detailSkill.files.length" class="meta-item"><i class="fa fa-file-o"></i> {{ detailSkill.files.length }} {{ store.locales === 'en' ? 'files' : '个文件' }}</span>
            <span class="meta-path" :title="detailSkill.path"><i class="fa fa-folder-open-o"></i> {{ detailSkill.path }}</span>
          </div>
          <!-- 正文：frontmatter 标签 + 描述 + markdown -->
          <div class="store-detail-body">
            <div v-show="detailLoading" class="store-detail-state">
              <i class="fa fa-spinner fa-spin"></i> {{ store.locales === 'en' ? 'Reading SKILL.md...' : '正在读取 SKILL.md...' }}
            </div>
            <template v-if="!detailLoading">
              <div v-if="detailMetaFields.length" class="skill-front-chips">
                <span v-for="f in detailMetaFields" :key="f.label + ':' + f.value" class="skill-front-chip" :title="f.value">
                  <span class="sf-k">{{ f.label }}</span>
                  <span class="sf-v">{{ f.value }}</span>
                </span>
              </div>
              <div v-if="detailMetaDesc" class="skill-front-desc" :title="detailMetaDesc">
                <i class="fa fa-quote-left"></i>
                <span>{{ detailMetaDesc }}</span>
              </div>
              <div v-if="detailRenderedBody" class="store-detail-md" v-html="detailRenderedBody"></div>
              <div v-else-if="!detailMetaFields.length && !detailMetaDesc" class="store-detail-state">
                <i class="fa fa-file-text-o"></i> {{ store.locales === 'en' ? 'No content' : '无内容' }}
              </div>
            </template>
          </div>
        </div>
      </div>
      <div v-if="storeInstallMsg" class="store-install-msg" :class="{ success: storeInstallSuccess, error: !storeInstallSuccess }" @click="storeInstallMsg = ''">
        <i class="fa" :class="storeInstallSuccess ? 'fa-check-circle' : 'fa-exclamation-circle'"></i>
        {{ storeInstallMsg }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { usestore } from '@/store'
import { renderQuestionMarkdown } from '@/lib/markdown/render'

const store = usestore()

// ==================== 类型 ====================
interface StoreSkill {
  id: string
  name: string
  description: string
  source: string
  stars?: number
  downloadUrl: string
  path: string
  branch?: string
  files?: string[]
  hasSkillMd?: boolean
  category?: string // 展示用分类路径（去 skills/ 前缀、不含技能名）
}

interface StoreSource { name: string; url: string; type: 'github' | 'http'; custom?: boolean }

// ==================== 状态 ====================
const BUILTIN_STORE_SOURCES: StoreSource[] = [
  { name: 'TOP-SKILLS (9000+ 技能)', url: 'bg-szy/TOP-SKILLS', type: 'github' },
  { name: 'FAOS Skills (1700+ 技能)', url: 'frank-luongt/faos-skills-marketplace', type: 'github' },
  { name: 'awesome-ai-agent-tools', url: 'michielhdoteth/awesome-ai-agent-tools', type: 'github' },
  { name: 'modelstudioai/skills', url: 'modelstudioai/skills', type: 'github' },
  { name: 'broomva/skills', url: 'broomva/skills', type: 'github' },
  { name: '1ai-skills (1300+ 技能)', url: 'oyi77/1ai-skills', type: 'github' },
  // 热门 AI 软件官方技能仓库（仍为 GitHub；目前无稳定公开的“非 GitHub JSON 技能商店”）
  { name: 'OpenClaw 官方技能', url: 'openclaw/openclaw', type: 'github' },
  { name: 'Anthropic 官方 Skills', url: 'anthropics/skills', type: 'github' },
  { name: 'obra/superpowers', url: 'obra/superpowers', type: 'github' },
]
// 内置源 + 用户自定义源（自定义源持久化到 store.skillStoreSources）
const storeSources = computed<StoreSource[]>(() => [
  ...BUILTIN_STORE_SOURCES,
  ...(store.skillStoreSources || []).map((s: any) => ({ name: `⭐ ${s.name}`, url: s.url, type: s.type || 'github', custom: true })),
])
const storeSource = ref<StoreSource>(storeSources.value[0])
const storeLoading = ref(false)
const storeSearch = ref('')
const storeError = ref('')
const storeInstallMsg = ref('')
const storeInstallSuccess = ref(false)
const downloadingSkills = ref<Set<string>>(new Set())
const storeSkills = ref<StoreSkill[]>([])
// 模块级缓存：同一来源再次进入直接复用，避免每次切换标签都重打 GitHub API（上万技能树 JSON 较大）
let storeCache: { key: string; list: StoreSkill[] } | null = null
// 分页（滚动加载更多）
const PAGE_SIZE = 24
const loadedCount = ref(PAGE_SIZE)
const loadMoreSentinel = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null
// 技能详情（点击卡片在右侧栏展示，按需读取 SKILL.md）
const detailSkill = ref<StoreSkill | null>(null)
const detailContent = ref('')
const detailLoading = ref(false)
const detailDescCache = new Map<string, string>()
// 自定义来源
const customSourceInput = ref('')
const customSourceError = ref('')

const selectSource = (src: StoreSource) => {
  if (storeSource.value?.url === src.url) return
  storeSource.value = src
  loadStoreSkills()
}

const addCustomSource = async () => {
  const raw = customSourceInput.value.trim()
  if (!raw) {
    ElMessage.warning(store.locales === 'en' ? 'Please enter a source address' : '请输入来源地址')
    return
  }
  // 支持完整 URL（内网地址）或 GitHub owner/repo
  const isHttp = /^https?:\/\//i.test(raw)
  let url = raw
  let name = raw
  let type: 'github' | 'http' = 'github'
  if (!isHttp) {
    url = raw.replace(/\/+$/, '')
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
      ElMessage.warning(store.locales === 'en' ? 'Format: owner/repo or URL' : '格式：owner/repo 或 URL')
      return
    }
  } else {
    type = 'http'
  }
  if (storeSources.value.some(s => s.url.toLowerCase() === url.toLowerCase())) {
    ElMessage.warning(store.locales === 'en' ? 'Source already exists' : '该来源已存在')
    return
  }
  // 验证来源可访问性，通过后才允许添加
  ElMessage.info(store.locales === 'en' ? 'Verifying source availability...' : '正在验证来源可访问性...')
  const ok = await verifySource(url, type)
  if (!ok) {
    ElMessage.error(store.locales === 'en' ? 'Source is not accessible, cannot add' : '来源不可访问，无法添加')
    return
  }
  store.skillStoreSources = [...(store.skillStoreSources || []), { name, url, type }]
  store.saveConfig()
  storeSource.value = { name: `⭐ ${name}`, url, type, custom: true }
  customSourceInput.value = ''
  customSourceError.value = ''
  ElMessage.success(store.locales === 'en' ? 'Source added' : '来源已添加')
  loadStoreSkills()
}

// 验证来源可访问性：HTTP 源 GET；GitHub 源请求仓库 API
const verifySource = async (url: string, type: 'github' | 'http'): Promise<boolean> => {
  try {
    if (type === 'http') {
      const resp = await fetch(url, { method: 'GET' })
      return resp.ok
    } else {
      const [owner, repo] = url.split('/')
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { method: 'GET' })
      return resp.ok
    }
  } catch {
    return false
  }
}

const removeSource = (src: StoreSource) => {
  if (!src.custom) {
    ElMessage.warning(store.locales === 'en' ? 'Built-in sources cannot be removed' : '内置来源不可删除')
    return
  }
  store.skillStoreSources = (store.skillStoreSources || []).filter(s => s.url !== src.url)
  store.saveConfig()
  ElMessage.success(store.locales === 'en' ? 'Source removed' : '来源已删除')
  if (storeSource.value?.url === src.url) {
    storeSource.value = storeSources.value[0]
    loadStoreSkills()
  }
}

// 重置来源：清空所有自定义来源，回到内置默认
const resetSources = () => {
  const wasCustom = !!storeSource.value?.custom
  store.skillStoreSources = []
  store.saveConfig()
  customSourceInput.value = ''
  customSourceError.value = ''
  if (wasCustom) {
    // 回到第一个内置源并加载（若该源已有缓存则秒回）
    storeSource.value = storeSources.value[0]
    loadStoreSkills()
  }
  ElMessage.success(store.locales === 'en' ? 'Sources reset to built-in' : '已重置为内置来源')
}

// 当前搜索词（小写、去首尾空白）
const currentQuery = computed(() => storeSearch.value.trim().toLowerCase())

// ==================== 内容搜索（SKILL.md 正文，命中即追加） ====================
const contentSearchOn = ref(false)          // “内容搜索”开关（工具栏图标按钮）
const contentHits = ref<StoreSkill[]>([])   // SKILL.md 正文命中（按发现顺序追加，置顶显示）
const contentHitForQuery = ref('')          // 当前内容命中对应的搜索词（词变了自动失效重搜）
const contentSearching = ref(false)
const contentProgress = ref<{ total: number; done: number; hits: number; budget: number; capped: boolean }>({ total: 0, done: 0, hits: 0, budget: 0, capped: false })
let contentScanCtrl: AbortController | null = null
let contentScanTimer: ReturnType<typeof setTimeout> | undefined
const GITHUB_SCAN_BUDGET = 60               // GitHub 未认证限流 ~60 次/小时：单次内容搜索最多拉取的 SKILL.md 数
const SCAN_CONCURRENCY = 8

// 名称 / 路径 / 分类子串命中（即时、不联网）
const nameMatches = (s: StoreSkill, q: string) =>
  s.name.toLowerCase().includes(q) ||
  (s.description || '').toLowerCase().includes(q) ||
  (s.category || '').toLowerCase().includes(q) ||
  (s.path || '').toLowerCase().includes(q)

// 正文命中判定：整串 → 英文/数字词（>=2）→ 中文段 2-gram 兜底（如“读pdf”→“pdf”命中；避免纯 ASCII 2-gram 把 update 这类词误判成 pdf）
const textMatches = (text: string, q: string): boolean => {
  const t = text.toLowerCase()
  const raw = q.toLowerCase()
  if (!raw) return false
  if (t.includes(raw)) return true
  for (const m of raw.match(/[a-z0-9]{2,}/g) || []) {
    if (t.includes(m)) return true
  }
  for (const run of raw.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (run.length > 12) continue
    for (let i = 0; i < run.length - 1; i++) {
      if (t.includes(run.slice(i, i + 2))) return true
    }
  }
  return false
}

// 内容命中置顶（“搜到几个就追加几个”看得见），名称命中随后
const filteredStoreSkills = computed(() => {
  const q = currentQuery.value
  const seen = new Set<string>()
  const out: StoreSkill[] = []
  const push = (s: StoreSkill) => { if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s) } }
  if (!q) {
    for (const s of storeSkills.value) push(s)
    return out
  }
  if (contentSearchOn.value && contentHitForQuery.value === q) {
    for (const s of contentHits.value) push(s)
  }
  for (const s of storeSkills.value) if (nameMatches(s, q)) push(s)
  return out
})

const stopContentSearch = () => {
  contentScanCtrl?.abort()
  contentScanCtrl = null
  contentSearching.value = false
}

const resetContentSearch = () => {
  stopContentSearch()
  contentHits.value = []
  contentHitForQuery.value = ''
  contentProgress.value = { total: 0, done: 0, hits: 0, budget: 0, capped: false }
}

// 读取并缓存 SKILL.md 原文（与详情弹窗共用 detailDescCache）
const fetchSkillMdCached = async (skill: StoreSkill, signal?: AbortSignal): Promise<string> => {
  if (detailDescCache.has(skill.id)) return detailDescCache.get(skill.id)!
  const md = await fetchSkillMarkdown(skill, signal)
  detailDescCache.set(skill.id, md)
  return md
}

const runContentSearch = async () => {
  const q = currentQuery.value
  if (!contentSearchOn.value || !q) return
  stopContentSearch()
  contentHitForQuery.value = q
  contentHits.value = []
  contentSearching.value = true
  contentProgress.value = { total: 0, done: 0, hits: 0, budget: 0, capped: false }
  const ctrl = new AbortController()
  contentScanCtrl = ctrl
  // 候选：名称/路径未命中的其余技能（这些才需要拉正文确认），按稳定顺序扫描前 budget 个
  const nameMatched = new Set<string>()
  for (const s of storeSkills.value) if (nameMatches(s, q)) nameMatched.add(s.id)
  const candidates = storeSkills.value.filter(s => !nameMatched.has(s.id))
  const budget = storeSource.value.type === 'http' ? candidates.length : Math.min(GITHUB_SCAN_BUDGET, candidates.length)
  const targets = candidates.slice(0, budget)
  contentProgress.value = { total: candidates.length, done: 0, hits: 0, budget, capped: candidates.length > budget }
  let idx = 0
  const scanOne = async () => {
    while (!ctrl.signal.aborted) {
      const i = idx++
      if (i >= targets.length) break
      const s = targets[i]
      try {
        const md = await fetchSkillMdCached(s, ctrl.signal)
        if (!ctrl.signal.aborted && q === currentQuery.value && textMatches(md, q)) {
          contentHits.value = [...contentHits.value, s]
        }
      } catch {
        // 单个技能读取失败不中断整体扫描（限流/网络抖动）
      }
      if (!ctrl.signal.aborted) {
        contentProgress.value = { ...contentProgress.value, done: contentProgress.value.done + 1, hits: contentHits.value.length }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length) }, () => scanOne()))
  if (!ctrl.signal.aborted) {
    contentSearching.value = false
    contentScanCtrl = null
  }
}

const toggleContentSearch = () => {
  contentSearchOn.value = !contentSearchOn.value
  if (!contentSearchOn.value) {
    resetContentSearch()
    return
  }
  if (currentQuery.value) runContentSearch()
}

// 列表切换来源 / 刷新后：旧的正文命中已失效，若开着内容搜索则防抖重搜
const afterStoreReload = () => {
  if (contentScanTimer) { clearTimeout(contentScanTimer); contentScanTimer = undefined }
  if (!contentSearchOn.value) { contentHits.value = []; contentHitForQuery.value = ''; return }
  resetContentSearch()
  if (currentQuery.value) contentScanTimer = setTimeout(() => runContentSearch(), 300)
}

// 空状态提示（区分：无技能 / 无搜索词 / 名称无命中 / 正文搜索中 / 均无命中）
const storeEmptyText = computed(() => {
  if (storeError.value) return storeError.value
  const zh = store.locales !== 'en'
  const raw = storeSearch.value.trim()
  if (!storeSkills.value.length) return zh ? '暂无可用技能：请先选择来源或点击刷新' : 'No skills yet: pick a source or refresh'
  if (!raw) return zh ? '该来源暂无可用技能' : 'No skills in this source'
  if (contentSearchOn.value) {
    if (contentSearching.value) return zh ? '内容搜索 SKILL.md 进行中…（命中即显示，输入框可继续编辑）' : 'Searching SKILL.md content…'
    return zh ? `名称与 SKILL.md 正文均未命中“${raw}”` : `No match for "${raw}" in names or SKILL.md`
  }
  return zh
    ? `没有按名称/路径匹配“${raw}”的技能，可点右侧“内容”按钮搜索 SKILL.md 正文`
    : `No skill matches "${raw}" by name/path — click the content button to search SKILL.md`
})
const storeEmptyIcon = computed(() => {
  if (storeError.value) return 'fa-exclamation-triangle'
  if (!storeSkills.value.length) return 'fa-shopping-cart'
  if (currentQuery.value) return contentSearching.value ? 'fa-spinner fa-spin' : 'fa-search'
  return 'fa-cubes'
})

// 列表刷新/换源后把网格滚动复位到顶部（避免停留在旧列表深处）
const resetGridScroll = () => {
  nextTick(() => {
    const grid = loadMoreSentinel.value?.parentElement
    if (grid) grid.scrollTop = 0
  })
}

const loadStoreSkills = async (force = false) => {
  const key = `${storeSource.value.type}:${storeSource.value.url}`
  // 命中缓存（同来源且非强制刷新）：直接复用，不再请求网络
  if (!force && storeCache?.key === key && storeCache.list.length) {
    storeSkills.value = storeCache.list
    storeError.value = ''
    loadedCount.value = PAGE_SIZE
    resetGridScroll()
    afterStoreReload()
    return
  }
  storeLoading.value = true
  storeError.value = ''
  storeSkills.value = []
  loadedCount.value = PAGE_SIZE
  try {
    if (storeSource.value.type === 'http') {
      await loadHttpStoreSkills()
    } else {
      await loadGithubStoreSkills()
    }
    storeCache = { key, list: storeSkills.value }
    resetGridScroll()
    afterStoreReload()
  } catch (error: any) {
    storeError.value = `加载失败: ${error.message}`
  } finally {
    storeLoading.value = false
  }
}

// GitHub 源：优先用 git/trees 递归一次性拿到完整技能树（含文件清单），回退 contents 目录列表
const loadGithubStoreSkills = async () => {
  const [owner, repo] = storeSource.value.url.split('/')
  let defaultBranch = 'main'
  let stars = 0
  try {
    const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`)
    if (repoResp.ok) {
      const d = await repoResp.json()
      defaultBranch = d.default_branch || defaultBranch
      stars = d.stargazers_count || 0
    }
  } catch {}
  // 方式一：git/trees 递归（不受 contents 单目录 1000 条限制，一次拿到全部技能+文件清单）
  try {
    const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`)
    if (treeResp.ok) {
      const treeData = await treeResp.json()
      const tree: any[] = Array.isArray(treeData.tree) ? treeData.tree : []
      if (tree.length) {
        storeSkills.value = buildSkillsFromTree(tree, owner, repo, defaultBranch, stars)
        return
      }
    }
  } catch {}
  // 方式二：回退 contents 目录列表
  let items: any[] = []
  const skillsResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/skills`).catch(() => null)
  if (skillsResp && skillsResp.ok) {
    items = await skillsResp.json()
  } else {
    const rootResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`)
    if (!rootResp.ok) throw new Error(`HTTP ${rootResp.status}`)
    items = await rootResp.json()
  }
  const dirs = (Array.isArray(items) ? items : []).filter((i: any) => i.type === 'dir')
  storeSkills.value = dirs.map((i: any) => ({
    id: `${repo}/${i.name}`,
    name: i.name,
    description: '',
    source: storeSource.value.name,
    stars,
    downloadUrl: i.url,
    path: i.path,
    branch: defaultBranch,
  }))
}

// 内网/HTTP 源：请求地址返回 JSON（数组或 {skills:[...]}）作为技能列表
const loadHttpStoreSkills = async () => {
  const resp = await fetch(storeSource.value.url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = await resp.json()
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : (Array.isArray(data?.data) ? data.data : []))
  const base = storeSource.value.url.replace(/\/+$/, '')
  storeSkills.value = arr
    .filter((s: any) => s && (s.name || s.id))
    .map((s: any, idx: number) => ({
      id: `${base}/${s.name || s.id || idx}`,
      name: s.name || s.id || `skill-${idx}`,
      description: s.description || s.desc || '',
      source: storeSource.value.name,
      stars: s.stars || 0,
      downloadUrl: s.downloadUrl || s.download_url || s.url || '',
      path: s.path || s.name || '',
    }))
}

const downloadSkill = async (skill: StoreSkill) => {
  if (!store.skillsPath) {
    storeInstallMsg.value = store.locales === 'en' ? 'Please set skills folder path in Settings first' : '请先在设置页面配置技能文件夹路径'
    storeInstallSuccess.value = false; return
  }
  const set = new Set(downloadingSkills.value)
  set.add(skill.id); downloadingSkills.value = set; storeInstallMsg.value = ''
  try {
    const targetDir = `${store.skillsPath.replace(/\\/g, '/')}/${skill.name}`
    await window.ipcRenderer.invoke('ensureDir', targetDir)
    if (storeSource.value.type === 'http') {
      const dl = skill.downloadUrl || (skill.path ? `${storeSource.value.url.replace(/\/+$/, '')}/${skill.path}` : '')
      if (!dl) throw new Error(store.locales === 'en' ? 'No download URL provided by this source' : '该来源未提供下载地址')
      await downloadHttpRecursive(dl, targetDir)
    } else if (skill.files && skill.files.length) {
      // 高效路径：利用 git tree 已知文件清单，从 raw CDN 直接下载（不占 GitHub API 配额）。
      // 文件相对路径以技能目录 skill.path 为根（嵌套分类仓库同样适用）。
      const [owner, repo] = storeSource.value.url.split('/')
      const branch = skill.branch || 'main'
      const relRoot = (skill.path || skill.name).replace(/\/+$/, '')
      for (const filePath of skill.files) {
        const rel = filePath.startsWith(`${relRoot}/`)
          ? filePath.slice(relRoot.length + 1)
          : (filePath.split('/').pop() || '')
        const parts = rel.split('/').filter(Boolean)
        const fileName = parts.pop() || 'file'
        const subDir = parts.length ? `${targetDir}/${parts.join('/')}` : targetDir
        if (parts.length) await window.ipcRenderer.invoke('ensureDir', subDir)
        let content = ''
        const rawResp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encPath(filePath)}`)
        if (rawResp.ok) {
          content = await rawResp.text()
        } else {
          // 回退 contents API（拿 download_url）
          const cResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encPath(filePath)}`)
          if (!cResp.ok) throw new Error(`HTTP ${cResp.status}`)
          const cData = await cResp.json()
          const dlResp = await fetch(cData.download_url)
          if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status}`)
          content = await dlResp.text()
        }
        const result = await window.ipcRenderer.invoke('writeFile', `${subDir}/${fileName}`, content)
        if (!result.success) throw new Error(result.error)
      }
    } else {
      const [owner, repo] = storeSource.value.url.split('/')
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encPath(skill.path)}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const files = await resp.json()
      if (Array.isArray(files)) {
        await downloadDir(files, targetDir, owner, repo)
      } else {
        await downloadFile(files as any, targetDir)
      }
    }
    storeInstallMsg.value = `✅ 技能 "${skill.name}" 已下载到技能文件夹`; storeInstallSuccess.value = true
  } catch (error: any) {
    storeInstallMsg.value = `❌ 下载失败: ${error.message}`; storeInstallSuccess.value = false
  } finally {
    const s = new Set(downloadingSkills.value); s.delete(skill.id); downloadingSkills.value = s
  }
}

// 内网/HTTP 源递归下载：返回 JSON 数组视为目录，否则视为单文件
const downloadHttpRecursive = async (url: string, dir: string) => {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const body = await resp.json()
    if (Array.isArray(body)) {
      for (const item of body) {
        if (!item.name) continue
        const subUrl = item.downloadUrl || item.download_url || item.url || `${url.replace(/\/+$/, '')}/${item.name}`
        await downloadHttpRecursive(subUrl, `${dir}/${item.name}`)
      }
      return
    }
  }
  const fileName = url.split('/').filter(Boolean).pop() || 'file'
  const result = await window.ipcRenderer.invoke('writeFile', `${dir}/${fileName}`, await resp.text())
  if (!result.success) throw new Error(result.error)
}

const downloadDir = async (items: any[], baseDir: string, owner: string, repo: string) => {
  for (const item of items) {
    if (item.type === 'dir') {
      const sub = `${baseDir}/${item.name}`
      await window.ipcRenderer.invoke('ensureDir', sub)
      const subResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`)
      if (subResp.ok) { const subItems = await subResp.json(); if (Array.isArray(subItems)) await downloadDir(subItems, sub, owner, repo) }
    } else if (item.type === 'file') {
      await downloadFile(item, baseDir)
    }
  }
}

const downloadFile = async (file: any, targetDir: string) => {
  const resp = await fetch(file.download_url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const content = await resp.text()
  const result = await window.ipcRenderer.invoke('writeFile', `${targetDir}/${file.name}`, content)
  if (!result.success) throw new Error(result.error)
}

// ==================== 分页（滚动加载更多） ====================
// 内容搜索时：随命中增多自动扩展可视窗口，让“追加进来”的卡片立刻可见
const visibleStoreSkills = computed(() => {
  const list = filteredStoreSkills.value
  const reveal = contentSearchOn.value && currentQuery.value ? contentHits.value.length : 0
  return list.slice(0, Math.max(loadedCount.value, reveal))
})
const hasMore = computed(() => loadedCount.value < filteredStoreSkills.value.length)

const loadMore = () => {
  if (storeLoading.value || !hasMore.value) return
  loadedCount.value += PAGE_SIZE
  // 若加载后哨兵仍在网格容器可见区内（一屏还没填满），继续加载直至填满容器
  nextTick(() => {
    const el = loadMoreSentinel.value
    if (!el || !hasMore.value || storeLoading.value) return
    const box = el.closest('.store-skill-grid')
    if (!box) return
    const er = el.getBoundingClientRect()
    const br = box.getBoundingClientRect()
    if (er.top < br.bottom) loadMore()
  })
}

const setupSentinel = () => {
  sentinelObserver?.disconnect()
  if (!loadMoreSentinel.value) return
  sentinelObserver = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore() },
    { rootMargin: '200px 0px' },
  )
  sentinelObserver.observe(loadMoreSentinel.value)
}

// ==================== 技能详情（按需读取 SKILL.md） ====================
// ==================== SKILL.md frontmatter 解析（YAML 元信息 → 标签标识） ====================
interface SkillFront { meta: Record<string, string>; body: string }
// 把开头 `--- ... ---` 的 YAML 解析为“字段→值”，正文单独返回（避免 frontmatter 被 markdown 渲染成 h2）
const parseSkillFrontmatter = (content: string): SkillFront => {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  if (!match) return { meta: {}, body: content }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    // 顶层字段必须顶格：跳过注释、缩进内容（多行块正文 / 列表子项）
    if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue
    const ci = line.indexOf(':')
    if (ci <= 0) continue
    const key = line.slice(0, ci).trim()
    if (!key) continue
    let val = line.slice(ci + 1).trim()
    // 跳过多行块（| / >）与列表项（- 开头）——不适合做小标签
    if (!val || /^[|>]/.test(val) || val.startsWith('-')) continue
    val = val.replace(/^["']|["']$/g, '').trim()
    if (val.length > 140) continue
    meta[key] = val
  }
  return { meta, body: content.slice(match[0].length) }
}
const FRONT_LABELS: Record<string, string> = {
  version: '版本', author: '作者', license: '许可协议', source: '来源',
  'allowed-tools': '可用工具', allowed_tools: '可用工具',
  model: '模型', models: '模型', model_provider: '模型提供方',
  created: '创建', updated: '更新', 'created-at': '创建', 'updated-at': '更新',
  category: '分类', homepage: '主页', url: '链接', emoji: '图标',
}
const frontLabel = (k: string) => FRONT_LABELS[k] || k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const SKIP_FRONT_KEYS = new Set(['name', 'description', 'metadata'])
const detailParsed = computed(() => parseSkillFrontmatter(detailContent.value))
const detailRenderedBody = computed(() => (detailParsed.value.body ? renderQuestionMarkdown(detailParsed.value.body) : ''))
const detailMetaDesc = computed(() => detailParsed.value.meta.description || '')
const detailMetaFields = computed(() => {
  const m = detailParsed.value.meta
  const out: { label: string; value: string }[] = []
  for (const k of Object.keys(m)) {
    if (SKIP_FRONT_KEYS.has(k)) continue
    const v = m[k]
    if (!v) continue
    out.push({ label: frontLabel(k), value: v })
  }
  return out
})

const openSkillDetail = async (skill: StoreSkill) => {
  // 已选中同一技能且非加载中：不重复闪烁
  if (detailSkill.value?.id === skill.id && !detailLoading.value) return
  detailSkill.value = skill
  detailLoading.value = true
  detailContent.value = ''
  try {
    if (detailDescCache.has(skill.id)) {
      detailContent.value = detailDescCache.get(skill.id)!
    } else {
      const md = await fetchSkillMarkdown(skill)
      detailContent.value = md
      detailDescCache.set(skill.id, md)
    }
  } catch (error: any) {
    detailContent.value = `> ⚠️ ${store.locales === 'en' ? 'Failed to load SKILL.md' : '无法读取 SKILL.md'}: ${error.message}`
  } finally {
    detailLoading.value = false
  }
}

const detailCat = computed(() => detailSkill.value?.category || '')

// 取消选择：右侧栏恢复占位提示
const deselectSkill = () => {
  detailSkill.value = null
  detailContent.value = ''
  detailLoading.value = false
}

// 读取技能 SKILL.md 原文（GitHub 源走 contents API，HTTP 源走 URL）
const fetchSkillMarkdown = async (skill: StoreSkill, signal?: AbortSignal): Promise<string> => {
  if (storeSource.value.type === 'http') {
    if (skill.description) return skill.description
    const mdUrl = `${(skill.downloadUrl || storeSource.value.url.replace(/\/+$/, '')).replace(/\/+$/, '')}/SKILL.md`
    const resp = await fetch(mdUrl, { signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.text()
  }
  const [owner, repo] = storeSource.value.url.split('/')
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encPath(skill.path)}/SKILL.md`, { signal })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = await resp.json()
  if (data.content) return atob(data.content.replace(/\n/g, ''))
  throw new Error('no content')
}

/** 仓库路径按 / 逐段 encodeURIComponent（目录/文件名可能含空格、# 等特殊字符） */
const encPath = (p: string) => p.split('/').map((seg) => encodeURIComponent(seg)).join('/')

/** 技能目录的展示分类：去掉 skills/ 前缀与技能名，只留父级路径 */
const dirCategory = (dir: string): string => {
  const rel = dir.replace(/^skills\//, '')
  const segs = rel.split('/')
  segs.pop()
  return segs.join(' / ')
}

// 从 git tree 构建技能列表：**任意深度**下，只要目录直接含 SKILL.md 即视为一个技能。
// （TOP-SKILLS / FAOS / 1ai-skills 等仓库的技能都嵌套在 skills/<分类>/<技能> 甚至更深层；
//  旧逻辑只取第一层目录，导致“明明几千个技能只看到 9/3 个”）。
const buildSkillsFromTree = (tree: any[], owner: string, repo: string, branch: string, stars: number): StoreSkill[] => {
  const blobs = (tree as any[]).filter((t: any) => t.type === 'blob')
  // 1) 收集所有含 SKILL.md 的目录 → 技能候选（去重、跳过根级 SKILL.md）
  const skillDirs = new Set<string>()
  for (const b of blobs) {
    if (!/\/SKILL\.md$/i.test(b.path)) continue
    const dir = b.path.slice(0, -(('SKILL.md').length + 1))
    if (dir) skillDirs.add(dir)
  }
  if (!skillDirs.size) return []
  // 2) 每个技能目录归集其子树文件：某 blob 的所有“候选祖先目录”都会包含它，
  //    因此下载“合集技能”（其子目录也含 SKILL.md）= 整包，下载叶技能 = 仅其自身。
  const filesMap = new Map<string, string[]>()
  for (const dir of skillDirs) filesMap.set(dir, [])
  for (const b of blobs) {
    const segs = b.path.split('/')
    let acc = ''
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i]
      if (skillDirs.has(acc)) filesMap.get(acc)!.push(b.path)
    }
  }
  // 3) 组装（以仓库内相对路径保证 id 唯一；id 含文件名可能碰撞的叶子名按目录区分）
  const out: StoreSkill[] = []
  for (const dir of [...skillDirs]) {
    const leaf = dir.split('/').pop() || dir
    out.push({
      id: `${repo}/${dir}`,
      name: leaf,
      description: '',
      source: storeSource.value.name,
      stars,
      downloadUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${encPath(dir)}`,
      path: dir,
      branch,
      files: filesMap.get(dir),
      hasSkillMd: true,
      category: dirCategory(dir),
    })
  }
  // 按分类 + 名称排序，浏览更整齐
  out.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
  return out
}

// 搜索变化：重置分页；内容搜索开启时防抖重启扫描（输入框始终可编辑）
watch(storeSearch, () => {
  loadedCount.value = PAGE_SIZE
  if (!contentSearchOn.value) return
  if (contentScanTimer) { clearTimeout(contentScanTimer); contentScanTimer = undefined }
  if (!currentQuery.value) { resetContentSearch(); return }
  resetContentSearch()
  contentScanTimer = setTimeout(() => runContentSearch(), 300)
})
watch(loadMoreSentinel, (el) => { if (el) setupSentinel() })
onMounted(() => { setupSentinel(); loadStoreSkills() })
onBeforeUnmount(() => {
  sentinelObserver?.disconnect()
  contentScanCtrl?.abort()
  if (contentScanTimer) clearTimeout(contentScanTimer)
})

</script>

<style scoped>
.agent-skill {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* ====== 按钮 ====== */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0px;
  border: 0px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background: var(--menuColor);
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
  border:1px solid var(--borderColor);
  font-size: 12px;
}

.button:hover {
  background: var(--menuColor);
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
}

/* ====== 商店内容 ====== */
.store-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ====== 商店：左侧来源 + 右侧技能网格（参照工具管理 tool-list） ====== */
.store-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ---- 左侧：来源列表 ---- */
.store-sources {
  width: 190px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--borderColor);
}

.store-sources-add {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.store-sources-add input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  outline: none;
}
.store-sources-add input:focus {
  border-color: var(--fontActiveColor);
}
.store-sources-add .store-add-btn {
  flex-shrink: 0;
  margin: 0;
  width: 24px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.store-sources-add .store-reset-btn {
  flex-shrink: 0;
  margin: 0;
  width: 24px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.store-sources-add .store-reset-btn:hover {
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.store-custom-error {
  color: #F44336;
  font-size: 10px;
  padding: 2px 6px;
  flex-shrink: 0;
}
.store-sources-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}
.store-source-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--fontColor);
  transition: all 0.15s;
  margin-bottom: 2px;
}
.store-source-item:hover {
  background: var(--menuColor);
  border-color: var(--borderColor);
}
.store-source-item.active {
  background: rgba(33, 150, 243, 0.12);
  border-color: #2196F3;
}
.store-source-item > i {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--borderColor);
}
.store-source-item.active > i {
  color: var(--fontActiveColor);
}
.store-source-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.store-source-remove {
  flex-shrink: 0;
  cursor: pointer;
  color: #F44336;
  font-size: 12px;
  padding: 0 2px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s;
}
.store-source-item:hover .store-source-remove {
  opacity: 1;
}
.store-source-remove:hover {
  background: rgba(244, 67, 54, 0.12);
}

/* ---- 中间：技能网格（参照工具管理 tool-list） ---- */
.store-skills {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* 详情打开时：技能区收缩为只容纳一列的窄栏（宽度接近左侧来源导航），
   与右侧详情形成 来源 | 技能单列 | 详情 的主从布局；关闭详情自动还原多列网格 */
.store-skills.is-narrow {
  flex: 0 0 auto;
  width: 260px;
  border-right: 1px solid var(--borderColor);
}
.store-skills.is-narrow .store-skill-grid {
  grid-template-columns: 1fr;
}
.store-skills-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.store-skills-toolbar > i {
  color: var(--borderColor);
  flex-shrink: 0;
}
.store-skills-toolbar input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  outline: none;
  height: 23px;
}
.store-skills-toolbar input:focus {
  border-color: var(--fontActiveColor);
}
.store-count {
  font-size: 10px;
  color: var(--borderColor);
  white-space: nowrap;
}
/* 内容搜索开关（工具栏图标按钮激活态） */
.store-content-toggle.on {
  background: var(--menuColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
/* 内容搜索状态条：位于工具栏与网格之间，随命中即时追加计数 */
.store-content-status {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--fontColor);
  border-bottom: 1px dashed var(--borderColor);
  background: color-mix(in srgb, var(--fontActiveColor) 6%, transparent);
  user-select: none;
}
.store-content-status > .fa-spinner { color: var(--fontActiveColor); }
.store-content-status > .fa-check-circle { color: #4caf50; }
.store-content-stat { color: var(--borderColor); }
.store-content-note { color: #ff9800; opacity: .9; }
.store-content-stop {
  margin-left: auto;
  padding: 1px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 10px;
  cursor: pointer;
}
.store-content-stop:hover { border-color: #f44336; color: #f44336; }
/* 加载/空状态覆盖层（位于网格内：只覆盖网格卡片区，不遮挡上方搜索框） */
.store-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--borderColor);
  background: color-mix(in srgb, var(--backgroundColor) 55%, transparent);
}
.store-overlay span {
  max-width: 80%;
  text-align: center;
  line-height: 1.6;
}
/* 网格相对定位容器：滚动发生在内部 .store-skill-grid，遮罩固定覆盖其可视区且不随内容滚动 */
.store-grid-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.store-skill-grid {
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px;
  align-content: start;
  overflow-y: auto;
  padding: 6px;
}

.store-skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  transition: all 0.12s;
  min-width: 0;
}
.store-skill-item:hover {
  border-color: var(--fontActiveColor);
}
.store-skill-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border-radius: 5px;
  color: var(--fontActiveColor);
  font-size: 15px;
}
.store-skill-info {
  flex: 1;
  min-width: 0;
}
.store-skill-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.store-skill-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.store-skill-desc {
  font-size: 10px;
  opacity: 0.75;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.store-skill-meta {
  display: flex;
  gap: 10px;
  margin-top: 2px;
}
.meta-item {
  font-size: 9px;
  opacity: 0.6;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.store-skill-download {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  transition: all 0.15s;
}
.store-skill-download:hover {
  background: var(--fontActiveColor);
  color: #fff;
}
.store-skill-download:disabled,
.store-skill-download.downloading {
  opacity: 0.6;
  cursor: not-allowed;
}
.store-skill-download.downloading {
  background: #4CAF50;
  color: #fff;
}

/* 卡片可点击 + SKILL 徽标 + 占位描述 */
.store-skill-item {
  cursor: pointer;
}
.store-skill-badge {
  flex-shrink: 0;
  font-size: 8px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, #2196F3 15%, transparent);
  color: #2196F3;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.store-skill-desc.is-placeholder {
  color: var(--fontActiveColor);
  opacity: 0.6;
}
.store-skill-desc i {
  font-size: 10px;
  margin-right: 3px;
  color: var(--borderColor);
}

/* 滚动加载更多哨兵 */
.store-load-more {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 0 4px;
  font-size: 11px;
  color: var(--borderColor);
  user-select: none;
}
.store-load-more .store-load-more-hint {
  color: var(--fontActiveColor);
  opacity: 0.8;
}
.store-load-more .store-load-more-done {
  opacity: 0.7;
}
.store-load-more i {
  font-size: 11px;
}

.store-install-msg {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 12px;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 10;
}

.store-install-msg.success {
  background: #4CAF50;
  color: white;
}

.store-install-msg.error {
  background: #f44336;
  color: white;
}

/* ====== 空状态 ====== */
.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--borderColor);
  gap: 8px;
}

.empty-hint i {
  font-size: 32px;
}

.empty-hint span {
  font-size: 12px;
}

/* ====== 技能详情：右侧详情栏（详情打开时作为主阅读区占满中间窄栏之外的宽度；
   头部风格与 群设置/问题配置 一致） ====== */
.store-detail-pane {
  flex: 1;
  min-width: 0;
  width: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--backgroundColor);
  color: var(--fontColor);
  border-left: 1px solid var(--borderColor);
  overflow: hidden;
}
.store-detail-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--borderColor);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  user-select: none;
}
.store-detail-placeholder i { font-size: 28px; }
/* 窄栏下的头部自适应：标题占剩余宽度、可截断，分类副标题按需收缩 */
.store-detail-pane .store-detail-title {
  flex: 1;
  min-width: 0;
  max-width: none;
}
.store-detail-pane .store-detail-sub { max-width: 45%; }
/* 头部：与 群设置(sd-head)/问题配置(qb-pick-head) 一致 */
.store-detail-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.store-detail-head .detail-head-icon {
  color: var(--fontActiveColor);
  font-size: 14px;
  flex-shrink: 0;
}
.store-detail-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.store-detail-sub {
  font-size: 11px;
  color: var(--borderColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.store-detail-flex { flex: 1; }
/* 右侧关闭：无边框、纯图标（对齐 sd-close 规范） */
.store-detail-close {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.store-detail-close:hover {
  background: var(--menuActiveColor);
  color: #f44336;
}
/* 头部下载：纯图标按钮（位于关闭按钮左侧），无文字、hover 有 title 说明 */
.store-detail-download {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(76, 175, 80, 0.45);
  border-radius: 4px;
  background: rgba(76, 175, 80, 0.08);
  color: #4CAF50;
  cursor: pointer;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.store-detail-download:hover {
  background: rgba(76, 175, 80, 0.18);
  border-color: #4CAF50;
}
.store-detail-download:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 元信息条 */
.store-detail-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 11px;
  color: var(--fontColor);
}
.store-detail-meta .meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.store-detail-meta .meta-path {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  font-size: 10px;
}
/* 正文区（禁止横向滚动条：超宽内容一律裁切/换行处理，仅保留纵向滚动） */
.store-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 12px;
}
.store-detail-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  color: var(--borderColor);
  font-size: 12px;
}
/* YAML frontmatter → 标签标识 */
.skill-front-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.skill-front-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 9px;
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  background: var(--menuColor);
  font-size: 11px;
  line-height: 1.7;
  color: var(--fontColor);
}
.skill-front-chip .sf-k {
  flex-shrink: 0;
  color: var(--fontActiveColor);
  font-size: 10px;
}
.skill-front-chip .sf-v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.skill-front-desc {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 10px;
  padding: 6px 10px;
  border-left: 3px solid var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 6%, transparent);
  font-size: 12px;
  line-height: 1.6;
  color: var(--fontColor);
  word-break: break-word;
}
.skill-front-desc i {
  color: var(--fontActiveColor);
  font-size: 11px;
  margin-top: 2px;
  flex-shrink: 0;
}
/* 正文 markdown：内容由 v-html 注入，需 :deep 才会命中子元素样式 */
.store-detail-md {
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}
.store-detail-md :deep(h1),
.store-detail-md :deep(h2),
.store-detail-md :deep(h3),
.store-detail-md :deep(h4) {
  margin: 12px 0 6px;
  line-height: 1.4;
  color: var(--fontColor);
}
.store-detail-md :deep(p) { margin: 6px 0; }
.store-detail-md :deep(ul),
.store-detail-md :deep(ol) { padding-left: 20px; margin: 6px 0; }
.store-detail-md :deep(code) {
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.store-detail-md :deep(pre) {
  background: color-mix(in srgb, #000 30%, transparent);
  padding: 8px 10px;
  border-radius: 5px;
  overflow-x: auto;
  border: 1px solid var(--borderColor);
}
.store-detail-md :deep(pre code) {
  background: transparent;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.store-detail-md :deep(blockquote) {
  border-left: 3px solid var(--fontActiveColor);
  margin: 6px 0;
  padding: 2px 10px;
  color: var(--borderColor);
  background: color-mix(in srgb, var(--menuColor) 40%, transparent);
}
.store-detail-md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.store-detail-md :deep(th),
.store-detail-md :deep(td) {
  border: 1px solid var(--borderColor);
  padding: 4px 8px;
  font-size: 12px;
}
.store-detail-md :deep(img) { max-width: 100%; }
.store-detail-md :deep(a) { color: var(--fontActiveColor); }
.store-detail-md :deep(hr) { border: none; border-top: 1px solid var(--borderColor); margin: 10px 0; }

/* ====== 滚动条 ====== */
::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

::-webkit-scrollbar-track {
  background: var(--backgroundColor);
}

::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}
</style>
