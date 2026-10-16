/**
 * llmCredentials.selftest.ts — 「内联 API Key 不再留在 localStorage」这条不变式的纯逻辑自测
 *
 * 锁四件事：
 *   1. **自维护规则**：只在"有 `apiKeyRef` 接缝"的对象上动手 —— 所以 `AIconfig.asr.*`
 *      （只有 `api_key`、消费方 manager.ts 直接读明文）被**结构性**排除，不会被误迁而弄坏 ASR；
 *   2. **不丢密钥**：写凭据失败时明文与 ref 都保持原状（fail-open），绝不出现
 *      "ref 指向不存在的凭据 + 明文被清掉"的不可恢复状态；
 *   3. **幂等**：同一份配置跑第二遍什么也不做（否则每次 saveConfig 都会重复写凭据）；
 *   4. **确定性凭据名**：同一来源永远同一个名字，重复迁移不攒垃圾凭据。
 *
 * 用法：`node scripts/run-selftests.mjs llmCredentials`
 */
import {
  INLINE_KEY_FIELD,
  KEY_REF_FIELD,
  collectLlmKeySites,
  hasKeyRefSeam,
  llmCredentialName,
  migrateLlmKeys,
  redactLlmKeys,
} from './llmCredentials'

export interface LlmCredentialsCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仿 AIconfig 的最小夹具：三个有 ref 接缝的模型来源 + 两个**没有**接缝的 ASR 来源 */
function fixture() {
  return {
    llm: {
      type: 'openai',
      openai: { api_key: 'sk-openai-1', apiKeyRef: '', base_url: 'https://x' },
      custom: {
        api_key: 'sk-custom-0',
        apiKeyRef: '',
        sources: [
          { id: 1, api_key: 'sk-custom-1', apiKeyRef: '' },
          { id: 2, api_key: 'sk-custom-2', apiKeyRef: 'llm.custom.sources.1' }, // 已有 ref
        ],
      },
    },
    asr: {
      // ⚠️ 真实形状：没有 apiKeyRef，且 manager.ts 直接读 api_key → 必须**不动**
      whisper: { url: 'https://api.openai.com/v1', api_key: 'asr-whisper-plain' },
      qwen3: { url: 'http://127.0.0.1:8000', api_key: 'asr-qwen3-plain' },
    },
    UI: { theme: 'dark' },
  }
}

/** 记录写入的假凭据库 */
function fakeWriter(failOn: string[] = []) {
  const writes: Array<[string, string]> = []
  return {
    writes,
    writer: {
      async set(name: string, value: string) {
        if (failOn.includes(name)) throw new Error(`凭据库拒绝：${name}`)
        writes.push([name, value])
      },
    },
  }
}

export function runLlmCredentialsSelfTest(): LlmCredentialsCase[] {
  const cases: LlmCredentialsCase[] = []

  // 1) 只收集"有 ref 接缝"的站点（自维护规则）
  const sites = collectLlmKeySites(fixture())
  const paths = sites.map((s) => s.path.join('.'))
  cases.push({
    name: '自维护规则：只收集有 apiKeyRef 接缝的内联明文（ASR 被排除）',
    ok:
      !paths.some((p) => p.startsWith('asr.')) &&
      paths.includes('llm.openai') &&
      paths.includes('llm.custom') &&
      paths.includes('llm.custom.sources.0'),
    detail: `收集到 ${sites.length} 处：${paths.join(', ')}（不应包含任何 asr.*）`,
  })

  // 2) hasRef 标记正确（决定"能否直接清明文"）
  const byPath = new Map(sites.map((s) => [s.path.join('.'), s]))
  cases.push({
    name: 'hasRef 标记：无引用=false、已有引用=true',
    ok:
      byPath.get('llm.openai')?.hasRef === false &&
      byPath.get('llm.custom.sources.1')?.hasRef === true,
    detail: `llm.openai=${byPath.get('llm.openai')?.hasRef}，llm.custom.sources.1=${byPath.get('llm.custom.sources.1')?.hasRef}`,
  })

  // 3) 凭据名确定性（含数组下标）
  cases.push({
    name: '凭据名确定性：路径直接成名字（含数组下标）',
    ok:
      llmCredentialName(['llm', 'custom', 'sources', 0]) === 'llm.custom.sources.0' &&
      llmCredentialName(['llm', 'openai']) === 'llm.openai',
    detail: 'llm.custom.sources.0 / llm.openai',
  })

  // 4) redactLlmKeys：深拷贝、不改原对象、只清 hasRef 的
  //    （迁移本身是异步的，见 runLlmCredentialsAsyncSelfTest）
  {
    const cfg: any = fixture()
    const red = redactLlmKeys(cfg)
    cases.push({
      name: 'redactLlmKeys：只清"已有引用"的明文，且不改动原对象',
      ok:
        red.llm.custom.sources[1][INLINE_KEY_FIELD] === '' &&
        red.llm.custom.sources[0][INLINE_KEY_FIELD] === 'sk-custom-1' && // 无 ref → 不动，避免丢密钥
        red.asr.whisper.api_key === 'asr-whisper-plain' &&
        cfg.llm.custom.sources[1][INLINE_KEY_FIELD] === 'sk-custom-2', // 原对象未被改
      detail: `redacted: openai=${red.llm.openai[INLINE_KEY_FIELD]} sources1=${red.llm.custom.sources[1][INLINE_KEY_FIELD]}；原对象 sources1=${cfg.llm.custom.sources[1][INLINE_KEY_FIELD]}`,
    })
  }

  // 6) hasKeyRefSeam 的判定（元：证明规则真的在按字段判断，而不是碰巧）
  cases.push({
    name: 'meta: 接缝判定按"是否有 string 型 apiKeyRef 自有字段"',
    ok:
      hasKeyRefSeam({ api_key: 'x', apiKeyRef: '' }) === true &&
      hasKeyRefSeam({ api_key: 'x' }) === false &&
      hasKeyRefSeam({ api_key: 'x', apiKeyRef: 1 }) === false &&
      hasKeyRefSeam(null) === false,
    detail: '有 ref 字段=true；无=false；ref 非 string=false；null=false',
  })

  return cases
}

/**
 * 迁移部分是异步的，单独一套（run-selftests 的 run 支持 Promise<数组>）。
 * 这里把同步子集一并带上 —— 注册给 runner 的只有本函数，别让同步用例被漏掉。
 */
export async function runLlmCredentialsAsyncSelfTest(): Promise<LlmCredentialsCase[]> {
  const cases: LlmCredentialsCase[] = [...runLlmCredentialsSelfTest()]

  // A) 正常迁移：写凭据 + 填 ref + 清明文；ASR 不被碰
  //
  // 夹具里有 4 个站点：openai / custom / custom.sources[0] 三个需要**写凭据**，
  // custom.sources[1] 已有 ref，只需清明文（不该重复写凭据 —— 否则会覆盖别人映射的凭据）。
  {
    const cfg: any = fixture()
    const { writes, writer } = fakeWriter()
    const r = await migrateLlmKeys(cfg, writer)
    cases.push({
      name: '迁移：写凭据 + 填 apiKeyRef + 清明文（ASR 明文原样保留）',
      ok:
        r.migrated === 4 &&
        r.failed === 0 &&
        writes.length === 3 &&
        cfg.llm.openai[KEY_REF_FIELD] === 'llm.openai' &&
        cfg.llm.openai[INLINE_KEY_FIELD] === '' &&
        cfg.llm.custom.sources[0][KEY_REF_FIELD] === 'llm.custom.sources.0' &&
        cfg.llm.custom.sources[1][INLINE_KEY_FIELD] === '' &&
        cfg.asr.whisper.api_key === 'asr-whisper-plain' &&
        cfg.asr.qwen3.api_key === 'asr-qwen3-plain',
      detail: `migrated=${r.migrated} failed=${r.failed} 写凭据=${writes.length}（期望 4/0/3：三个需写 + 一个已有 ref 只清明文）`,
    })
  }

  // B) 幂等：第二遍什么也不做
  {
    const cfg: any = fixture()
    const w1 = fakeWriter()
    await migrateLlmKeys(cfg, w1.writer)
    const w2 = fakeWriter()
    const r2 = await migrateLlmKeys(cfg, w2.writer)
    cases.push({
      name: '幂等：迁移后再跑一遍不写凭据、不改配置',
      ok: r2.migrated === 0 && r2.failed === 0 && w2.writes.length === 0,
      detail: `第二遍 migrated=${r2.migrated} 写凭据=${w2.writes.length}（期望 0/0）`,
    })
  }

  // C) fail-open：写失败时明文与 ref 都保持原状（绝不丢密钥）
  {
    const cfg: any = fixture()
    const { writer } = fakeWriter(['llm.openai'])
    const r = await migrateLlmKeys(cfg, writer)
    cases.push({
      name: 'fail-open：凭据写入失败时明文与 ref 均保持原状（不丢密钥）',
      ok:
        r.failed === 1 &&
        cfg.llm.openai[INLINE_KEY_FIELD] === 'sk-openai-1' &&
        cfg.llm.openai[KEY_REF_FIELD] === '' &&
        r.errors.length === 1 &&
        r.errors[0].includes('llm.openai'),
      detail: `failed=${r.failed} 明文=${cfg.llm.openai[INLINE_KEY_FIELD]} ref="${cfg.llm.openai[KEY_REF_FIELD]}" 错误=${r.errors[0] ?? ''}`,
    })
  }

  // D) 没有凭据接缝（浏览器/安卓）→ 整体不执行
  {
    const cfg: any = fixture()
    const r = await migrateLlmKeys(cfg, null)
    cases.push({
      name: '无凭据接缝（浏览器/安卓）时整体不执行，明文全部保留',
      ok:
        r.migrated === 0 &&
        r.failed === 0 &&
        cfg.llm.openai[INLINE_KEY_FIELD] === 'sk-openai-1' &&
        cfg.asr.whisper.api_key === 'asr-whisper-plain',
      detail: `migrated=${r.migrated}（期望 0，且明文未动）`,
    })
  }

  // E) meta：若"接缝规则"被删掉，ASR 就会被收集 → 证明这条用例能抓到该回归
  {
    const cfg: any = fixture()
    const asrSite = collectLlmKeySites(cfg).find((s) => s.path.join('.').startsWith('asr.'))
    // 直接构造"没有接缝判定"时的行为：手写一个带 api_key 的对象并断言接缝判定为 false
    const bare = { api_key: 'plain' }
    cases.push({
      name: 'meta: ASR 形状（无 ref 字段）在接缝判定下必然为 false —— 排除是结构性的',
      ok: asrSite === undefined && hasKeyRefSeam(bare) === false,
      detail: `被发现为站点=${asrSite ? asrSite.path.join('.') : '无'}（期望"无"）`,
    })
  }

  return cases
}

/** 命令行入口：同步 + 异步合并，便于 `node scripts/run-selftests.mjs llmCredentials` 单跑 */
export async function logLlmCredentialsSelfTest(): Promise<boolean> {
  const cases = [...runLlmCredentialsSelfTest(), ...(await runLlmCredentialsAsyncSelfTest())]
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
