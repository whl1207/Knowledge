/**
 * llmCredentials.ts — 把内联在配置里的模型 API Key 搬进主进程凭据库（浏览器 / 安卓保持原样）
 *
 * ## 为什么必须做
 *
 * `AIconfig` 整份被写进 **localStorage**（见 src/lib/settingsData.ts 的 BACKUP_KEYS 与 store.saveConfig），
 * 而界面半边插件与宿主**同 realm**：它可以直接 `localStorage.getItem('AIconfig')` 读到内联的
 * `api_key` 明文，再用 `fetch` 发出去。`net` / `llm` 两个权限对界面半边**管不到**环境网络能力
 * （`fetch` 是 realm 全局），所以"把明文从 localStorage 里挪走"是唯一能真正消除该外带目标的改动。
 *
 * ## 规则（自维护：只在**已经有 ref 字段**的地方动手）
 *
 * 判定一个对象是"可迁移站点"的条件是三个**同时**成立：
 *   1. `apiKeyRef` 是它自己的 string 属性（= 这条链路已经有凭据引用接缝）；
 *   2. `api_key` 是非空字符串（= 真的有明文要搬）；
 *   3. 尚未填 `apiKeyRef`（已填的只需清掉明文，不要再写一次凭据，免得覆盖别人）。
 *
 * 这条规则自动**排除** `AIconfig.asr.whisper` / `asr.qwen3` —— 它们只有 `api_key`、没有 `apiKeyRef`，
 * 而且消费方（src/services/asr/manager.ts）直接读 `api_key`，不做引用解析。若把它们也搬走而不同步
 * 改消费方，ASR 会直接坏掉。**残留**：这两个语音识别 Key 仍以明文留在 localStorage 里，
 * 要么给 ASR 补上引用解析后一并迁移，要么接受（见返工说明）。
 *
 * ## 不丢密钥
 *
 * 写凭据是异步的，失败时**不动内存里的明文也不写盘**（fail-open）：宁可暂时保留明文，
 * 也绝不出现"ref 指向不存在的凭据、明文又被清掉"这种不可恢复的状态。
 */

/** 内联明文字段名（全仓统一，别改；改了就要同步 ai-utils.ts / manager.ts 的读取处） */
export const INLINE_KEY_FIELD = 'api_key'
/** 凭据引用字段名（凭据明文只存主进程，见 electron/main/credentials.ts） */
export const KEY_REF_FIELD = 'apiKeyRef'

/** 一个"内联明文站点"：定位、承载对象、确定性凭据名、以及它是否已有引用 */
export interface LlmKeySite {
  /** 相对根对象的路径（诊断与凭据名用） */
  path: Array<string | number>
  /** 承载这两个字段的对象（就地改 `apiKeyRef` / `api_key`） */
  container: Record<string, unknown>
  /** 确定性凭据名：同一来源永远同一个名字，重复迁移不会攒垃圾凭据 */
  name: string
  /** 明文值 */
  value: string
  /** 是否已有 `apiKeyRef`（有 = 明文可以安全清掉；无 = 必须先成功写凭据） */
  hasRef: boolean
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** 该对象是否具备"凭据引用"接缝（有自己的 string 型 `apiKeyRef` 字段） */
export function hasKeyRefSeam(obj: unknown): boolean {
  return isPlainObject(obj) && hasOwn(obj, KEY_REF_FIELD) && typeof obj[KEY_REF_FIELD] === 'string'
}

/** 由路径生成确定性凭据名：`['llm','openai']` → `llm.openai`；数组下标直接入名 */
export function llmCredentialName(path: Array<string | number>): string {
  return path.join('.')
}

/**
 * 收集所有"内联明文站点"（递归；只进普通对象与数组）。
 * `path` 是相对根对象的路径，用于凭据名与诊断。
 */
export function collectLlmKeySites(root: unknown, path: Array<string | number> = []): LlmKeySite[] {
  const sites: LlmKeySite[] = []
  const visit = (node: unknown, p: Array<string | number>): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, [...p, i]))
      return
    }
    if (!isPlainObject(node)) return

    if (hasKeyRefSeam(node)) {
      const raw = node[INLINE_KEY_FIELD]
      if (typeof raw === 'string' && raw.trim() !== '') {
        const ref = node[KEY_REF_FIELD] as string
        sites.push({
          path: p,
          container: node,
          name: llmCredentialName(p),
          value: raw,
          hasRef: ref.trim() !== '',
        })
      }
    }
    for (const [k, v] of Object.entries(node)) visit(v, [...p, k])
  }
  visit(root, path)
  return sites
}

/** 是否存在需要处理的明文（供调用方提前短路；不产生副作用） */
export function hasInlineLlmKeys(root: unknown): boolean {
  return collectLlmKeySites(root).length > 0
}

/**
 * 深拷贝并把**已有引用**的站点的明文清空。
 *
 * 只清 `hasRef` 的：没有引用的站点一旦清掉明文而凭据又没写成功，密钥就永久丢了。
 * 给"落盘 / 导出 / 备份"这类不该带明文的出口用。
 */
export function redactLlmKeys<T>(root: T): T {
  const clone = JSON.parse(JSON.stringify(root)) as T
  for (const site of collectLlmKeySites(clone)) {
    if (site.hasRef) site.container[INLINE_KEY_FIELD] = ''
  }
  return clone
}

/** 迁移依赖：写凭据（主进程）。不可用时（浏览器 / 安卓）整个迁移**不执行**，明文保持原样。 */
export interface LlmCredentialWriter {
  set(name: string, value: string): Promise<unknown>
}

export interface LlmKeyMigrationResult {
  /** 成功搬走的数量（含"已有引用只需清明文"的） */
  migrated: number
  /** 写凭据失败的数量（此时该站点**保持原样**，不丢密钥） */
  failed: number
  /** 失败站点的可读原因（进日志） */
  errors: string[]
}

/**
 * 就地迁移：把明文写进凭据库、填 `apiKeyRef`、清掉 `api_key`。
 *
 * 幂等：跑第二遍时没有明文（或只有已迁移完成的），什么也不做。
 * fail-open：单个站点写失败只记录，明文与 ref 都保持原状。
 */
export async function migrateLlmKeys(
  root: unknown,
  writer: LlmCredentialWriter | null,
): Promise<LlmKeyMigrationResult> {
  const result: LlmKeyMigrationResult = { migrated: 0, failed: 0, errors: [] }
  if (!writer || typeof writer.set !== 'function') return result

  for (const site of collectLlmKeySites(root)) {
    if (site.hasRef) {
      // 已有引用：明文可以安全清掉（凭据本来就在主进程里）
      site.container[INLINE_KEY_FIELD] = ''
      result.migrated++
      continue
    }
    try {
      await writer.set(site.name, site.value)
      site.container[KEY_REF_FIELD] = site.name
      site.container[INLINE_KEY_FIELD] = ''
      result.migrated++
    } catch (e) {
      result.failed++
      result.errors.push(`${site.path.join('.') || '(root)'}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
