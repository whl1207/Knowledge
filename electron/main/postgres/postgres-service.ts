// electron/main/postgres/postgres-service.ts
// 内置 MCP 服务：PostgreSQL 只读查询（builtin-postgres）
//
// 场景：本地 / 内网把大数据集（如 OpenAlex 离线快照）导入 PostgreSQL 后，
// 让智能体（通用智能体 / Agent 预设 / 集群 / 工作流 MCP 节点）用 SQL 做统计与检索。
//
// 设计要点：
// - 与 office / drawio / literature 同构：主进程内 SDK Server over InMemoryTransport；
//   打包主进程时不能静态内联 MCP SDK（zod v4 内联损坏），一律 @vite-ignore 运行时加载。
// - **连接信息来自 MCP 服务配置的 env**（设置 → 工具 → MCP → PostgreSQL 查询 → 配置 → 环境变量）：
//   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD / PGSSL，或直接给 PG_MCP_CONNECTION_STRING / DATABASE_URL。
//   未配置时工具返回可读的配置指引，而不是抛异常。
// - **只读三保险**：① SQL 静态校验（仅 SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN，拒绝多语句与写类关键字）；
//   ② 连接上设 `default_transaction_read_only = on`；③ 连接上设 `statement_timeout`。
//   强烈建议再配一个只读数据库账号（GRANT SELECT），这才是最终防线。
// - 连接按「配置指纹」缓存复用；空闲连接报错时丢弃重连（pg Client 的 error 事件必须监听，否则会崩主进程）。
// - 本文件不 import electron，可脱离 Electron 用 InMemoryTransport 做冒烟测试。

// ---------------- 运行时懒加载 MCP Server SDK ----------------
import * as fs from 'node:fs'

interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null
async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

// ---------------- 运行时懒加载 pg（node-postgres，纯 JS，无原生依赖） ----------------
let pgModuleCache: any = null
async function getPg(): Promise<any> {
  if (pgModuleCache) return pgModuleCache
  // 变量拼接 + @vite-ignore：保持运行时从 node_modules 加载（vite 不内联）
  const modName = 'pg'
  const mod: any = await import(/* @vite-ignore */ modName)
  const pg = mod?.default ?? mod
  if (!pg?.Client) throw new Error('无法加载 pg（node-postgres）模块，请确认依赖已安装（npm i pg）')
  pgModuleCache = pg
  return pg
}

// ---------------- 常量 ----------------
export const POSTGRES_MCP_ID = 'builtin-postgres'

const MAX_OUTPUT = 9000 // 单次工具返回文本上限（超出截断）
const DEFAULT_MAX_ROWS = 50 // pg_query 默认返回行数
const HARD_MAX_ROWS = 500 // pg_query 返回行数硬上限
const DEFAULT_STATEMENT_TIMEOUT_MS = 30000 // 单条 SQL 超时（默认 30s）
const DEFAULT_CONNECT_TIMEOUT_MS = 10000
const CELL_MAX_CHARS = 120 // 表格单元格最大字符数

function str(v: any): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function clampInt(v: any, def: number, min: number, max: number): number {
  // 注意：Number('') === 0 且被 Number.isFinite 认作合法，会把未配置项钳到 min（曾因此把 30s 超时变成 1s）
  const raw = typeof v === 'string' ? v.trim() : v
  if (raw === '' || raw === null || raw === undefined) return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

// ---------------- 连接配置解析 ----------------
export interface PgSettings {
  connectionString: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  /** 显式指定的 schema（PG_MCP_SCHEMA）；空 = 连接后自动探测「唯一的用户 schema」并设为 search_path */
  schema: string
  maxRows: number
  statementTimeoutMs: number
  connectTimeoutMs: number
  /** 是否提供了足以建连的信息（连接串或 host/database 之一） */
  configured: boolean
}

/**
 * 由 MCP 服务配置传入的 env（设置页可编辑）覆盖进程环境变量。
 * 每次内置连接（含设置页「连接」/智能体调用）都会刷新这里的值，
 * 因此改完设置后重新连接即可生效（对外 HTTP 暴露的会话同样复用最近一次配置）。
 */
let configuredEnv: Record<string, string> = {}

export function setRuntimeEnv(env: any): void {
  const out: Record<string, string> = {}
  let parsed: any = env
  if (typeof env === 'string') {
    try {
      parsed = JSON.parse(env)
    } catch {
      parsed = null
    }
  }
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
      else if (v != null) out[k] = String(v)
    }
  }
  configuredEnv = out
}

function pickEnv(keys: string[]): string {
  for (const k of keys) {
    const v = str(configuredEnv[k]).trim() || str((process.env as any)[k]).trim()
    if (v) return v
  }
  return ''
}

export function resolveSettings(): PgSettings {
  const connectionString = pickEnv(['PG_MCP_CONNECTION_STRING', 'DATABASE_URL', 'POSTGRES_URL', 'PGURL'])
  const host = pickEnv(['PGHOST'])
  const database = pickEnv(['PGDATABASE', 'PGDB'])
  const user = pickEnv(['PGUSER', 'PGUSERNAME'])
  const password = pickEnv(['PGPASSWORD', 'PGPASS'])
  const port = clampInt(pickEnv(['PGPORT']) || 5432, 5432, 1, 65535)
  const sslRaw = pickEnv(['PGSSL', 'PGSSLMODE', 'PG_MCP_SSL']).toLowerCase()
  const ssl = sslRaw === 'true' || sslRaw === '1' || sslRaw === 'require' || sslRaw === 'yes'
  return {
    connectionString,
    host,
    port,
    database,
    user,
    password,
    ssl,
    schema: pickEnv(['PG_MCP_SCHEMA', 'PGSCHEMA']),
    maxRows: clampInt(pickEnv(['PG_MCP_MAX_ROWS']), DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
    statementTimeoutMs: clampInt(pickEnv(['PG_MCP_STATEMENT_TIMEOUT_MS']), DEFAULT_STATEMENT_TIMEOUT_MS, 1000, 600000),
    connectTimeoutMs: clampInt(pickEnv(['PG_MCP_CONNECT_TIMEOUT_MS']), DEFAULT_CONNECT_TIMEOUT_MS, 1000, 60000),
    configured: !!(connectionString || host || database),
  }
}

/** 脱敏后的连接目标描述（用于工具输出，绝不回显密码） */
function describeTarget(s: PgSettings): string {
  if (s.connectionString) {
    // 去掉连接串里的密码（postgres://user:pwd@host/db）
    const safe = s.connectionString.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@')
    return safe
  }
  const hostPart = s.host ? `${s.host}:${s.port}` : 'localhost:5432'
  return `postgresql://${s.user || '（未设用户）'}:${s.password ? '***' : '（未设密码）'}@${hostPart}/${s.database || '（未设库名）'}`
}

function notConfiguredHint(): string {
  return [
    'PostgreSQL 连接信息尚未配置。',
    '',
    '请在「设置 → 工具 → MCP → PostgreSQL 查询 → 配置 → 环境变量 env」中填写（JSON）：',
    '{',
    '  "PGHOST": "127.0.0.1",',
    '  "PGPORT": "5432",',
    '  "PGDATABASE": "openalex",',
    '  "PGUSER": "aikm_ro",',
    '  "PGPASSWORD": "你的只读账号密码",',
    '  "PG_MCP_STATEMENT_TIMEOUT_MS": "180000"',
    '}',
    '',
    '说明：',
    '- 也可只填一条连接串：{"PG_MCP_CONNECTION_STRING": "postgresql://user:pwd@host:5432/db"}',
    '- ⚠ PG_MCP_STATEMENT_TIMEOUT_MS 的单位是**毫秒**：180000 = 180 秒（大库人名/模糊检索常需几十秒，填 1000 就只有 1 秒）。',
    '- 数据在专用 schema（如 openalex）时，连接后会自动把 search_path 设为它，SQL 可直接写表名；多个用户 schema 时请用 "PG_MCP_SCHEMA": "openalex" 显式指定。',
    '- 远程库需 SSL 时加 {"PGSSL": "true"}；改完配置请点右上角「连接服务」让设置生效。',
    '- 强烈建议使用只读账号（GRANT SELECT），服务端已强制只读事务 + 语句超时。',
  ].join('\n')
}

// ---------------- 连接管理（按配置指纹缓存单连接） ----------------
let cachedClient: any = null
let cachedKey = ''
/** 当前生效的 search_path（便于 pg_status / 错误提示回显） */
let cachedSearchPath = ''

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** 库里的 schema 提示（给“表不存在”类错误用） */
function schemaHint(): string {
  if (cachedSearchPath) return `当前 search_path = ${cachedSearchPath}；可用 schema 限定写法（如 openalex.表名），或先用 pg_list_tables 确认表名。`
  return '可用 schema.表名 限定写法，或先用 pg_list_tables / pg_list_schemas 确认。'
}

/** 探测“唯一的用户 schema”（如 openalex）；存在多个时不猜，留给 PG_MCP_SCHEMA 显式指定 */
async function detectUserSchema(client: any): Promise<string> {
  const { rows } = await queryRows(
    client,
    `select n.nspname
       from pg_namespace n
      where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'public')
        and n.nspname not like 'pg\_temp%'
        and n.nspname not like 'pg\_toast%'
      order by (select count(*) from pg_class c where c.relnamespace = n.oid) desc
      limit 5`
  )
  const names = rows.map((r) => str(r[0])).filter(Boolean)
  return names.length === 1 ? names[0] : ''
}

function settingsKey(s: PgSettings): string {
  return [s.connectionString, s.host, s.port, s.database, s.user, s.password, s.ssl ? 'ssl' : ''].join('|')
}

async function dropClient(): Promise<void> {
  const c = cachedClient
  cachedClient = null
  cachedKey = ''
  cachedSearchPath = ''
  if (c) {
    try {
      await c.end()
    } catch {
      /* 忽略关闭错误 */
    }
  }
}

async function acquireClient(s: PgSettings): Promise<any> {
  const key = settingsKey(s)
  if (cachedClient && cachedKey === key) return cachedClient
  if (cachedClient) await dropClient()

  const pg = await getPg()
  const opts: any = s.connectionString
    ? { connectionString: s.connectionString }
    : { host: s.host || 'localhost', port: s.port, database: s.database, user: s.user, password: s.password }
  if (s.ssl) opts.ssl = { rejectUnauthorized: false }
  opts.statement_timeout = s.statementTimeoutMs
  opts.connectionTimeoutMillis = s.connectTimeoutMs
  opts.application_name = 'AI-KM PostgreSQL MCP'

  const client = new pg.Client(opts)
  // pg 的空闲连接错误（网络中断 / 服务端重启）必须监听，否则会抛出未捕获异常
  client.on('error', (err: any) => {
    console.warn('[pg-mcp] 连接错误，将丢弃并重连：', err?.message || err)
    void dropClient()
  })
  await client.connect()
  cachedClient = client
  cachedKey = key
  // 会话级只读（部分只读账号 / 连接池代理不允许 SET，失败只告警不阻断）
  try {
    await client.query('SET default_transaction_read_only = on')
  } catch (e: any) {
    console.warn('[pg-mcp] 设置只读事务失败（继续，建议改用只读账号）：', e?.message || e)
  }
  // 关闭 JIT：本服务的查询都是「索引点查 / 小范围 LIKE」，实际只读几个 buffer，
  // 但表达式（translate(lower(display_name)…)）没有统计信息 → 规划器估行严重偏高 → 触发 JIT 编译，
  // 实测每次查询白花 40–220 ms（比查询本身还慢）。本会话关掉即可，不影响库的全局设置。
  if (!/^(off|false|0|no)$/i.test(str(pickEnv(['PG_MCP_JIT'])))) {
    try {
      await client.query('SET jit = off')
    } catch (e: any) {
      console.warn('[pg-mcp] 关闭 JIT 失败（继续）：', e?.message || e)
    }
  }
  // search_path：让模型可以直接写 `select * from works`（数据常在专用 schema，如 openalex）
  try {
    const schema = s.schema || (await detectUserSchema(client))
    if (schema) {
      await client.query(`SET search_path TO ${quoteIdent(schema)}, public`)
      cachedSearchPath = `${schema}, public`
    } else {
      const r = await client.query('SHOW search_path')
      cachedSearchPath = str(r?.rows?.[0]?.[0] ?? r?.rows?.[0]?.search_path)
    }
  } catch (e: any) {
    console.warn('[pg-mcp] 设置 search_path 失败（继续）：', e?.message || e)
  }
  // 探测姓名索引（决定后续走索引快路还是全表扫，并影响并发度）
  await detectNameIndex(client, s.schema || 'openalex')
  return client
}

async function closeAll(): Promise<void> {
  await dropClient()
}

/** 把底层错误翻译成可操作的提示 */
function decorateError(err: any, s: PgSettings): string {
  const raw = str(err?.message) || String(err)
  const code = str((err as any)?.code)
  const target = describeTarget(s)
  if (code === 'ECONNREFUSED') return `无法连接 ${target}：连接被拒绝（数据库未启动、端口不对，或不允许远程连接）。`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析主机名（${target}）：请检查 PGHOST 填写是否正确。`
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return `连接 ${target} 超时/被重置：检查网络与数据库监听地址（listen_addresses / pg_hba.conf）。`
  if (code === '28P01') return `认证失败（${target}）：用户名或密码不正确。`
  if (code === '3D000') return `数据库不存在（${target}）：请检查 PGDATABASE 是否为实际库名。`
  if (code === '28000') return `连接被 pg_hba.conf 拒绝（${target}）：该主机/用户未授权访问。`
  if (code === '42P01') return `表或视图不存在：${raw}。${schemaHint()}`
  if (code === '42703') return `列名不存在：${raw}。请先用 pg_describe_table 查看列名（或 pg_sample_rows 看数据形态），不要猜列名。${schemaHint()}`
  if (code === '57014') {
    return (
      `查询被取消：超过语句超时（当前 ${s.statementTimeoutMs} 毫秒）。` +
      `⚠ 该项单位是**毫秒**：120 秒应填 120000（常见误填：填 1000 或 1 = 只有 1 秒）。` +
      ` 在「设置 → 工具 → MCP → PostgreSQL 查询 → 配置 → 环境变量 env」调整 PG_MCP_STATEMENT_TIMEOUT_MS，` +
      `并把该服务右上角「调用超时（秒）」设为 ≥ 200；同时收窄条件/避免大表全表扫。`
    )
  }
  if (code === '25006') return `当前事务为只读，禁止写操作（本服务只允许查询）。`
  if (code === '42501') return `权限不足：${raw}（请确认账号对该表有 SELECT 权限）。`
  return raw
}

async function withClient<T>(fn: (client: any, s: PgSettings) => Promise<T>): Promise<T> {
  const s = resolveSettings()
  if (!s.configured) throw new Error(notConfiguredHint())
  try {
    // 建连也在 try 内：连接类失败（ECONNREFUSED / 认证失败 / 库不存在）同样翻译成可读提示
    const client = await acquireClient(s)
    return await fn(client, s)
  } catch (err: any) {
    const code = str((err as any)?.code)
    // 连接类错误 → 丢弃缓存，下次重连
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', '57P01', '08006', '08001', '08003'].includes(code)) {
      await dropClient()
    }
    const wrapped: any = new Error(decorateError(err, s))
    throw wrapped
  }
}

async function queryRows(client: any, text: string, values: any[] = []): Promise<{ fields: string[]; rows: any[][] }> {
  const res = await client.query({ text, values, rowMode: 'array' })
  const fields: string[] = Array.isArray(res?.fields) ? res.fields.map((f: any) => str(f?.name)) : []
  const rows: any[][] = Array.isArray(res?.rows) ? res.rows : []
  return { fields, rows }
}

// ---------------- SQL 只读校验 ----------------
/**
 * 剥离 SQL 中的字符串/标识符/注释（保留长度无关的占位空格），
 * 用于关键字扫描——避免 `WHERE note = 'delete'` 这类字面量被误判。
 */
export function stripSqlLiterals(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    // 单引号字符串（含 E'' 反斜杠转义）
    if (ch === "'") {
      out += " '"
      i++
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          i++
          break
        }
        i++
      }
      out += "' "
      continue
    }
    // 双引号标识符（"select" 作为列名时不参与关键字扫描）
    if (ch === '"') {
      out += ' "'
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2
          continue
        }
        if (sql[i] === '"') {
          i++
          break
        }
        i++
      }
      out += '" '
      continue
    }
    // 行注释
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    // 块注释
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    // 美元引用字符串 $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        out += " ' ' "
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/** 只读 SQL 允许的起始关键字 */
const ALLOWED_START_RE = /^\s*(select|with|table|values|show|explain)\b/i
/** 只读以外的关键字（DDL / DML / 会话与权限变更 / 危险函数） */
const FORBIDDEN_RE =
  /\b(insert|update|delete|merge|upsert|drop|alter|create|grant|revoke|truncate|comment|copy|call|do|vacuum|analyze|reindex|cluster|refresh|listen|notify|set|reset|discard|begin|start|commit|rollback|savepoint|lock|prepare|execute|deallocate|declare|import|security|pg_sleep|pg_read_file|pg_write_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_stat_reset)\b/i

export interface PreparedSql {
  sql: string
  limitAppended: boolean
}

/**
 * 校验并把 SQL 收紧为「单条只读查询 + 自动补 LIMIT」。
 * 说明：LIMIT 只在最外层缺省时追加（对聚合查询无副作用）；返回行数另在格式化阶段再截断一次。
 */
export function prepareReadOnlySql(rawSql: string, maxRows: number): PreparedSql {
  let sql = str(rawSql).trim()
  if (!sql) throw new Error('sql 参数必填：请传入一条只读查询语句（SELECT / WITH ... SELECT）')
  sql = sql.replace(/;+\s*$/, '').trim()

  const stripped = stripSqlLiterals(sql)
  if (/;/.test(stripped)) {
    throw new Error('只允许单条只读语句：检测到多个语句分隔符「;」，请一次只查一条 SQL')
  }
  if (!ALLOWED_START_RE.test(stripped)) {
    throw new Error(
      '只允许只读查询：SQL 必须以 SELECT / WITH / TABLE / VALUES / SHOW / EXPLAIN 开头（本服务不提供写操作）'
    )
  }
  const bad = FORBIDDEN_RE.exec(stripped)
  if (bad) {
    throw new Error(
      `只读模式下不允许出现关键字「${bad[1].toUpperCase()}」。` +
        `若这只是列名/表名（例如名为 set、comment 的字段），请用双引号包裹标识符后重试，例如 SELECT "set" FROM t。`
    )
  }

  let limitAppended = false
  const startsWithShow = /^\s*show\b/i.test(stripped)
  if (!startsWithShow && !/\blimit\s+\d+/i.test(stripped)) {
    sql = `${sql}\nLIMIT ${maxRows + 1}`
    limitAppended = true
  }
  return { sql, limitAppended }
}

// ---------------- 结果格式化 ----------------
function cell(v: any): string {
  if (v === null || v === undefined) return '∅'
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ')
  if (Buffer.isBuffer(v)) return `\\x${v.slice(0, 32).toString('hex')}${v.length > 32 ? '…' : ''}`
  if (typeof v === 'object') {
    let s: string
    try {
      s = JSON.stringify(v)
    } catch {
      s = String(v)
    }
    return s.length > CELL_MAX_CHARS ? s.slice(0, CELL_MAX_CHARS) + '…' : s
  }
  let s = String(v)
  s = s.replace(/\r?\n/g, ' ⏎ ').replace(/\|/g, '\\|')
  if (s.length > CELL_MAX_CHARS) s = s.slice(0, CELL_MAX_CHARS) + '…'
  return s
}

function formatTable(fields: string[], rows: any[][]): string {
  if (!fields.length) return '（无列信息）'
  const head = `| ${fields.map((f) => f.replace(/\|/g, '\\|')).join(' | ')} |`
  const sep = `| ${fields.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${fields.map((_, i) => cell(r?.[i])).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return text.slice(0, MAX_OUTPUT) + '\n…（输出超长已截断：可减少 max_rows、只选必要列，或在 SQL 里做聚合）'
}

// ---------------- 工具实现 ----------------

/** 列出 schema 及其对象数量 */
async function pgListSchemas(): Promise<string> {
  return withClient(async (client) => {
    const { fields, rows } = await queryRows(
      client,
      `select n.nspname as schema,
              count(c.oid) filter (where c.relkind in ('r','p')) as tables,
              count(c.oid) filter (where c.relkind in ('v','m')) as views,
              count(c.oid) filter (where c.relkind = 'f') as foreign_tables
         from pg_namespace n
         left join pg_class c on c.relnamespace = n.oid
        where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        group by n.nspname
        order by n.nspname`
    )
    const lines = [`共 ${rows.length} 个 schema（不含系统 schema）：`, '', formatTable(fields, rows)]
    return truncateOutput(lines.join('\n'))
  })
}

/** 列出表 / 视图（含行数估算与注释） */
async function pgListTables(args: any): Promise<string> {
  const schema = str(args?.schema).trim()
  const keyword = str(args?.keyword ?? args?.query).trim()
  const limit = clampInt(args?.limit, 100, 1, 1000)
  return withClient(async (client) => {
    const { fields, rows } = await queryRows(
      client,
      `select n.nspname as schema,
              c.relname as name,
              case c.relkind when 'r' then 'table' when 'p' then 'table(分区)'
                             when 'v' then 'view' when 'm' then 'matview'
                             when 'f' then 'foreign' else c.relkind::text end as kind,
              greatest(c.reltuples, 0)::bigint as est_rows,
              coalesce(obj_description(c.oid, 'pg_class'), '') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','v','m','f')
          and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
          and ($1 = '' or n.nspname = $1)
          and ($2 = '' or c.relname ilike '%' || $2 || '%'
                        or coalesce(obj_description(c.oid, 'pg_class'), '') ilike '%' || $2 || '%')
        order by n.nspname, c.relkind, c.relname
        limit $3`,
      [schema, keyword, limit]
    )
    if (!rows.length) {
      const scope = [schema ? `schema=${schema}` : '', keyword ? `关键字=${keyword}` : ''].filter(Boolean).join('、')
      const hint = keyword
        ? '\n（本工具的 keyword 只匹配「表名 / 表注释」：若你想按人名找作者，请用 pg_resolve_author；想按文献内容检索请用 pg_query 写 SQL）'
        : ''
      return `未找到匹配的表/视图${scope ? `（${scope}）` : ''}。可先用 pg_list_schemas 查看有哪些 schema。${hint}`
    }
    const lines = [
      `共返回 ${rows.length} 个对象${limit && rows.length >= limit ? `（已按 limit=${limit} 截断）` : ''}：`,
      '（est_rows 为统计估算值，可能偏旧；精确计数请用 pg_query 执行 count(*)）',
      '',
      formatTable(fields, rows),
    ]
    return truncateOutput(lines.join('\n'))
  })
}

/** 解析表名（支持 schema.table、不带 schema 时按 search_path 解析），并取回真实 oid/schema/表名 */
async function resolveTable(client: any, rawName: string): Promise<{ oid: string; schema: string; name: string }> {
  const name = str(rawName).trim()
  if (!name) throw new Error('table 参数必填，例如 works 或 openalex.works（先用 pg_list_tables 查看可用表名）')
  const { rows } = await queryRows(
    client,
    `select c.oid::text, n.nspname, c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.oid = to_regclass($1)`,
    [name]
  )
  const oid = str(rows?.[0]?.[0])
  if (!oid) {
    throw new Error(`表不存在：${name}（可先用 pg_list_tables 查看可用表名；含大写或特殊字符的表名需加双引号）`)
  }
  return { oid, schema: str(rows?.[0]?.[1]), name: str(rows?.[0]?.[2]) }
}

/** 查看表结构：列 / 主键 / 索引 / 行数估算 */
async function pgDescribeTable(args: any): Promise<string> {
  const raw = str(args?.table ?? args?.name)
  return withClient(async (client) => {
    const t = await resolveTable(client, raw)
    const cols = await queryRows(
      client,
      `select a.attname as column,
              format_type(a.atttypid, a.atttypmod) as type,
              case when a.attnotnull then 'NOT NULL' else '' end as nullable,
              coalesce(pg_get_expr(d.adbin, d.adrelid), '') as default_value,
              coalesce(col_description(a.attrelid, a.attnum), '') as comment
         from pg_attribute a
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [t.oid]
    )
    const idx = await queryRows(
      client,
      `select indexname as index_name, indexdef as definition
         from pg_indexes where schemaname = $1 and tablename = $2
        order by indexname`,
      [t.schema, t.name]
    )
    const stat = await queryRows(
      client,
      `select c.relkind::text as kind, greatest(c.reltuples, 0)::bigint as est_rows,
              pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
              coalesce(obj_description(c.oid, 'pg_class'), '') as comment
         from pg_class c where c.oid = $1::oid`,
      [t.oid]
    )
    const kindName: Record<string, string> = { r: 'table', p: 'table(分区)', v: 'view', m: 'matview', f: 'foreign' }
    const s0 = stat.rows?.[0] || []
    const lines = [
      `表：${t.schema}.${t.name}（${kindName[str(s0[0])] || str(s0[0]) || '?'}）`,
      `行数估算：${str(s0[1])} ｜ 总大小：${str(s0[2])}${str(s0[3]) ? ` ｜ 注释：${str(s0[3])}` : ''}`,
      '',
      `列（${cols.rows.length}）：`,
      formatTable(cols.fields, cols.rows),
      '',
      `索引（${idx.rows.length}）：`,
      idx.rows.length ? formatTable(idx.fields, idx.rows) : '（无索引：大表按该列过滤会很慢，建议建索引）',
    ]
    return truncateOutput(lines.join('\n'))
  })
}

/** 采样若干行 */
async function pgSampleRows(args: any): Promise<string> {
  const raw = str(args?.table ?? args?.name)
  const limit = clampInt(args?.limit, 5, 1, 50)
  return withClient(async (client) => {
    const t = await resolveTable(client, raw)
    const quoted = `"${t.schema.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`
    const { fields, rows } = await queryRows(client, `select * from ${quoted} limit $1`, [limit])
    if (!rows.length) return `${t.schema}.${t.name} 中暂无数据（0 行）。`
    return truncateOutput(
      [`${t.schema}.${t.name} 采样 ${rows.length} 行：`, '', formatTable(fields, rows)].join('\n')
    )
  })
}

/** 只读 SQL 查询 */
async function pgQuery(args: any): Promise<string> {
  const s0 = resolveSettings()
  const maxRows = clampInt(args?.max_rows, s0.maxRows, 1, HARD_MAX_ROWS)
  const prepared = prepareReadOnlySql(args?.sql ?? args?.query, maxRows)
  return withClient(async (client) => {
    const started = Date.now()
    const { fields, rows } = await queryRows(client, prepared.sql)
    const elapsed = Date.now() - started
    if (!fields.length) {
      return `执行成功：语句无返回结果集（用时 ${elapsed} ms）。`
    }
    const truncated = rows.length > maxRows
    const shown = truncated ? rows.slice(0, maxRows) : rows
    const lines = [
      `执行成功：返回 ${shown.length} 行${truncated ? `（结果多于 max_rows=${maxRows}，已截断）` : ''}，用时 ${elapsed} ms`,
    ]
    if (prepared.limitAppended) lines.push(`（未检测到 LIMIT，已自动追加 LIMIT ${maxRows + 1} 以保护数据库）`)
    if (elapsed > 3000) lines.push('（查询较慢：建议先用 pg_list_tables 看行数估算，或为过滤/排序列建索引）')
    lines.push('', formatTable(fields, shown))
    return truncateOutput(lines.join('\n'))
  })
}

/** 连接与配置状态自检 */
async function pgStatus(): Promise<string> {
  const s = resolveSettings()
  /** head 在使用时现算：search_path 要等真正连上后才知道 */
  const head = () => {
    const lines = [
      `配置来源：MCP 服务「PostgreSQL 查询」的环境变量 env（未配置项可回退进程环境变量）`,
      `连接目标：${describeTarget(s)}`,
      `search_path：${cachedSearchPath || `（未连接；${s.schema ? `将使用 PG_MCP_SCHEMA=${s.schema}` : '连接后自动探测唯一用户 schema'}）`}`,
      `只读保护：SQL 静态校验 + default_transaction_read_only=on + statement_timeout=${s.statementTimeoutMs} 毫秒（${(s.statementTimeoutMs / 1000).toFixed(1)} 秒）`,
      `默认返回行数：${s.maxRows}（可通过 PG_MCP_MAX_ROWS 调整，单次查询上限 ${HARD_MAX_ROWS}）`,
      `作者消歧：并发上限 ${resolveConcurrency()}（PG_MCP_RESOLVE_CONCURRENCY 可调）｜ 姓名索引 ${
        nameIndexMode === 'btree' || nameIndexMode === 'trgm'
          ? `已检测到（${nameIndexMode}${nameSuffixIndex ? ' + 后缀索引' : ''}）→ 走索引快路`
          : nameIndexMode === 'none'
            ? '未检测到 → 每次消歧需全表扫 authors（约 15–20 s）。建索引可提速数百倍：'
            : '（连接后自动检测）'
      }`,
      `JIT：本会话已关闭（表达式无统计信息，规划器估行偏高会触发 JIT 编译，实测每次查询白花 40–220 ms；填 PG_MCP_JIT=off 也保持关闭）`,
    ]
    if (nameIndexMode === 'none') {
      lines.push(
        `  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_norm_name ON ${quoteIdent(s.schema || 'openalex')}.authors (translate(lower(display_name), '.', ' ') text_pattern_ops);`
      )
    } else if (!nameSuffixIndex) {
      lines.push(
        '可选再快一步（把「姓在末尾」的兜底查询从全表扫变成索引查）：',
        `  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_norm_name_rev ON ${quoteIdent(s.schema || 'openalex')}.authors (reverse(translate(lower(display_name), '.', ' ')) text_pattern_ops);`
      )
    }
    if (s.statementTimeoutMs < 5000) {
      lines.push(
        `⚠ 语句超时仅 ${s.statementTimeoutMs} 毫秒：稍大的查询会被直接取消（57014）。若填的是「秒数」请改成毫秒（180 秒 → 180000）。`
      )
    }
    return lines
  }
  if (!s.configured) {
    return truncateOutput([...head(), '', notConfiguredHint()].join('\n'))
  }
  try {
    return await withClient(async (client) => {
      const { fields, rows } = await queryRows(
        client,
        `select current_database() as database,
                current_user as "user",
                inet_server_addr()::text || ':' || inet_server_port()::text as server,
                current_setting('search_path') as search_path,
                current_setting('transaction_read_only') as read_only,
                split_part(version(), ',', 1) as version,
                (select count(*) from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                  where c.relkind in ('r','p')
                    and n.nspname not in ('pg_catalog','information_schema'))::bigint as user_tables`
      )
      return truncateOutput([...head(), '', '连接正常：', '', formatTable(fields, rows)].join('\n'))
    })
  } catch (e: any) {
    return truncateOutput([...head(), '', `连接失败：${e?.message || String(e)}`].join('\n'))
  }
}

// ---------------- 并发控制与结果缓存（批量智能体并发调用时避免 N 路全表扫）----------------

/**
 * 作者消歧并发控制：每次解析都要扫一遍 authors 表（28 GB），
 * N 路并发会把 IO 打满、单次延迟从 15 秒涨到 60 秒以上 → MCP 调用超时。
 * 因此默认**串行**（并发 1）；当库里已建好姓名索引（毫秒级）时自动放宽到 4，
 * 也可用 PG_MCP_RESOLVE_CONCURRENCY 显式指定（1–8）。
 */
let resolveActive = 0
const resolveWaiters: Array<() => void> = []

/** 姓名索引模式：'' = 尚未探测；none = 无索引（只能全表扫）；btree / trgm = 可走索引 */
let nameIndexMode: '' | 'none' | 'btree' | 'trgm' = ''
/** 是否已有「后缀索引」`reverse(translate(lower(display_name),'.',' '))`：让 `%surname` 这类尾部锚定的模式也能走索引 */
let nameSuffixIndex = false

/** JS 侧的字符串反转（与 SQL 的 reverse() 对 UTF-8 单码点字符一致；姓名场景足够） */
const reverseStr = (s: string): string => Array.from(s).reverse().join('')

function resolveConcurrency(): number {
  const explicit = clampInt(pickEnv(['PG_MCP_RESOLVE_CONCURRENCY']), 0, 0, 8)
  if (explicit > 0) return explicit
  return nameIndexMode && nameIndexMode !== 'none' ? 4 : 1
}

async function acquireResolveSlot(pendingHint: number): Promise<void> {
  const limit = resolveConcurrency()
  if (resolveActive < limit) {
    resolveActive++
    void pendingHint
    return
  }
  await new Promise<void>((resolve) => resolveWaiters.push(resolve))
  resolveActive++
}

function releaseResolveSlot(): void {
  resolveActive = Math.max(0, resolveActive - 1)
  const next = resolveWaiters.shift()
  if (next) next()
}

function enqueueResolve<T>(fn: () => Promise<T>): Promise<T> {
  return acquireResolveSlot(resolveWaiters.length).then(async () => {
    try {
      return await fn()
    } finally {
      releaseResolveSlot()
    }
  })
}

/** 探测 authors 表是否有可用于姓名检索的索引（表达式 btree / GIN trgm）；可用 PG_MCP_NAME_INDEX_MODE 强制覆盖（测试用） */
async function detectNameIndex(client: any, sch: string): Promise<void> {
  try {
    const { rows } = await queryRows(
      client,
      `select indexdef from pg_indexes where schemaname = $1 and tablename = 'authors'`,
      [sch]
    )
    const defs = rows.map((r) => str(r[0]).toLowerCase())
    const hasTrgm = defs.some((d) => d.includes('display_name') && d.includes('gin_trgm_ops'))
    // 后缀索引：索引表达式中含 reverse(...)（排除 trgm）
    nameSuffixIndex = defs.some((d) => d.includes('display_name') && d.includes('reverse(') && d.includes('btree'))
    const hasBtree = defs.some((d) => d.includes('display_name') && d.includes('btree') && !d.includes('reverse('))
    nameIndexMode = hasTrgm ? 'trgm' : hasBtree ? 'btree' : 'none'
  } catch {
    nameIndexMode = ''
  }
  const forced = str(pickEnv(['PG_MCP_NAME_INDEX_MODE'])).toLowerCase()
  if (forced === 'btree' || forced === 'trgm' || forced === 'none') nameIndexMode = forced
}

const RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000
const RESOLVE_CACHE_MAX = 300
const resolveCache = new Map<string, { at: number; text: string }>()

/** 跨会话持久缓存文件（由主进程注入 userData 路径；未注入则仅内存缓存） */
let resolveCacheFile = ''
let resolveCacheDirty = false
let resolveCacheSaveTimer: NodeJS.Timeout | null = null

export function setResolveCacheFile(file: string): void {
  resolveCacheFile = file
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const now = Date.now()
      for (const [k, v] of Object.entries(raw as Record<string, { at: number; text: string }>)) {
        if (v && typeof v.text === 'string' && now - (v.at || 0) < RESOLVE_CACHE_TTL_MS) resolveCache.set(k, v)
      }
    }
  } catch (e: any) {
    console.warn('[pg-mcp] 读取解析缓存失败（忽略）：', e?.message || e)
  }
}

function scheduleCachePersist(): void {
  if (!resolveCacheFile || resolveCacheSaveTimer) return
  resolveCacheSaveTimer = setTimeout(() => {
    resolveCacheSaveTimer = null
    if (!resolveCacheDirty) return
    resolveCacheDirty = false
    try {
      fs.writeFileSync(resolveCacheFile, JSON.stringify(Object.fromEntries(resolveCache)), 'utf8')
    } catch (e: any) {
      console.warn('[pg-mcp] 写入解析缓存失败（忽略）：', e?.message || e)
    }
  }, 2000)
  resolveCacheSaveTimer.unref?.()
}

function resolveCacheKey(args: any): string {
  return [str(args?.name), str(args?.institution), str(args?.orcid), str(args?.detail), str(args?.limit)].join('|')
}

function resolveCacheGet(key: string): string | null {
  const hit = resolveCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(key)
    return null
  }
  return hit.text
}

function resolveCacheSet(key: string, text: string): void {
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    // 简单淘汰：清掉最旧的一批
    const keys = [...resolveCache.keys()].slice(0, Math.floor(RESOLVE_CACHE_MAX / 4))
    keys.forEach((k) => resolveCache.delete(k))
  }
  resolveCache.set(key, { at: Date.now(), text })
  resolveCacheDirty = true
  scheduleCachePersist()
}

/** 某条姓名规则的**全部** LIKE 模式（全表扫用，语义最完整） */
function likeAllOf(m: NameMatchers): string[] {
  const out: string[] = []
  for (const g of m.groups) out.push(...g.like)
  return [...new Set(out)]
}

/** 强制只用全表扫（精度优先，排查索引快路漏召时用）：PG_MCP_FORCE_NAME_SCAN=1 */
const forceNameScan = (): boolean => /^(1|true|yes|on)$/i.test(pickEnv(['PG_MCP_FORCE_NAME_SCAN']))

/**
 * 批量里「仍未命中」的条目是否再做一次**全表扫**兜底（默认关闭）。
 * 理由：一次全表扫在 1.1 亿行上要 15–40 秒，而快路 + 全部计划重试已覆盖绝大多数写法；
 * 需要更彻底的召回时置 `PG_MCP_BATCH_FALLBACK_SCAN=1`。有后缀索引时自动改用索引补查（不走本开关）。
 */
const fallbackScanEnabled = (): boolean => /^(1|true|yes|on)$/i.test(pickEnv(['PG_MCP_BATCH_FALLBACK_SCAN']))

/** 逐条打印姓名查询耗时（排查「为什么还是慢」时用）：PG_MCP_DEBUG_TIMING=1 */
const debugTiming = (): boolean => /^(1|true|yes|on)$/i.test(pickEnv(['PG_MCP_DEBUG_TIMING']))

/**
 * 把 LIKE 模式拆成「索引可用部分 + 残余过滤」，让 btree（text_pattern_ops）索引真正被用上。
 * 关键实测结论（PG16 + `CREATE INDEX ON authors (translate(lower(display_name),'.',' ') text_pattern_ops)`）：
 *   `expr LIKE $1`（单模式、前缀式）→ **Index Scan**（0.05 ms）
 *   `expr = any($1::text[])`      → **Index Scan**
 *   `expr LIKE any($2::text[])`   → **Seq Scan**（索引完全用不上，必须拆开逐条查）
 * 例：`mark %perazella` → 前缀 `mark %` 走索引，残余 `%perazella` 落在 Index Cond 之上做 Filter。
 */
/** 索引前缀的最短字面量长度：短于它的前缀（如只给首字母产生的 `s %`）会扫掉数百万条索引项，得不偿失 */
const MIN_PREFIX_LEN = 4

function indexPlansOf(matchers: NameMatchers[], plansPerMatcher: number): Array<{ prefix: string; suffix: string; score: number; mi: number }> {
  const seen = new Set<string>()
  const plans: Array<{ prefix: string; suffix: string; score: number; mi: number }> = []
  for (let mi = 0; mi < matchers.length; mi++) {
    const m = matchers[mi]
    let taken = 0
    for (const g of m.groups) {
      if (taken >= plansPerMatcher) break
      for (const p of g.like) {
        if (taken >= plansPerMatcher) break
        const segs = p.split('%')
        if (!segs[0]) continue // 前导 %（如 `%perazella mark`）→ 前缀锚不住，无法走索引
        // 过短的前缀（如 `s %`）会扫掉数百万条索引项：跳过；但每条姓名至少保一个计划（否则该条无从检索）
        if (segs[0].length < MIN_PREFIX_LEN && taken > 0) continue
        const prefix = `${segs[0]}%`
        if (seen.has(prefix)) continue
        seen.add(prefix)
        // `a%b`（单 % 且以字面量结尾）→ 尾部锚定的后缀，可用 reverse 索引；其余（自由通配）只能做残余过滤
        const suffix = segs.length === 2 && segs[1] ? segs[1] : ''
        plans.push({ prefix, suffix, score: g.score, mi })
        taken++
      }
    }
  }
  return plans
}

/** 索引快路的模式数量上限：超过就退回一次全表扫（几百次网络往返 × 规划开销会超过扫表收益） */
const INDEX_PLAN_QUERY_CAP = 80

/**
 * 姓名候选检索（单条 / 批量共用）：
 * - **有姓名索引** → 先走索引快路：精确 `= any($1)` + 逐条前缀 `like $1`（各自可被索引使用），
 *   通常 10–50 ms；只有快路空手而归时才退回全表扫（保证召回不丢）。
 * - **无索引** → 直接全表扫（113M 行 / 28 GB，约 15–20 s），按「精确优先、论文数降序」排序后截断，保证主档案不被挤掉。
 */
async function scanAuthorCandidates(
  client: any,
  T: (t: string) => string,
  matchers: NameMatchers[],
  limit: number,
  opts: { plansPerMatcher?: number; extraLoose?: string[]; forceScan?: boolean; noScanFallback?: boolean; ignorePlanCap?: boolean } = {}
): Promise<{ rows: Array<{ id: string; dn: string; wc: number }>; via: 'index' | 'scan'; queries: number; ms: number }> {
  const tStart = Date.now()
  const exactAll = [...new Set(matchers.flatMap((m) => m.groups.flatMap((g) => g.exact)))]
  const likeAll = [...new Set([...matchers.flatMap(likeAllOf), ...(opts.extraLoose || [])])]
  const rowCap = Math.max(limit, 200)
  const indexUsable = !opts.forceScan && !forceNameScan() && !!nameIndexMode && nameIndexMode !== 'none'

  if (indexUsable) {
    // 每条姓名规则最多用几个前缀计划（PG_MCP_INDEX_PLANS，默认 4；批量内部按 2 调用）；
    // 深度重试用 ignorePlanCap 绕过该上限（它就是要穷尽全部计划）
    const planCap = opts.ignorePlanCap
      ? Math.max(1, opts.plansPerMatcher ?? 8)
      : clampInt(pickEnv(['PG_MCP_INDEX_PLANS']), Math.max(1, opts.plansPerMatcher ?? 4), 1, 8)
    const plans = indexPlansOf(matchers, planCap)
    // 条目很少时「每条几个索引查询」远优于一次全表扫；条目很多时每条几查会退化成几百次往返
    // → 超过这个预算就改用「一次合并扫描」（一条 SQL 覆盖全部模式）
    if (plans.length + (exactAll.length ? 1 : 0) <= INDEX_PLAN_QUERY_CAP) {
      const got: Array<{ id: string; dn: string; wc: number }> = []
      const seen = new Set<string>()
      let queries = 0
      const collect = (rows: any[]) => {
        for (const r of rows) {
          const id = str(r[0])
          if (id && !seen.has(id)) {
            seen.add(id)
            got.push({ id, dn: str(r[1]), wc: Number(r[2]) || 0 })
          }
        }
      }
      // 每条姓名**已命中**的最强匹配分（只统计真正返回的候选，不能按「有哪些分组」预估）：
      // 低于它的计划只能补充更弱的候选（不会有新结论），跳过可省一次往返
      const bestByMatcher = matchers.map(() => 0)      // ⚠ 不要用 `= ANY(array)` 抽精确匹配：表达式没有统计信息，规划器会把多值等值估得极大，
      //   直接选全表扫（实测 38 秒），而单值/前缀 LIKE 都走索引（3–12 ms）。
      //   精确形态本来就已被前缀计划覆盖（`sanjay gupta` 必然匹配 `sanjay gupta%`），无需重复查。
      const base = `select split_part(id, '/', 4) as author_id, ${SQL_NORM_NAME} as dn, coalesce(works_count, 0)::bigint as wc from ${T('authors')}`
      for (const plan of plans) {
        if (bestByMatcher[plan.mi] > 0 && plan.score < bestByMatcher[plan.mi]) continue
        // 只在「近似完整姓名」的前缀上排序（`sanjay gupta%`：命中行数少、排序便宜，且保证大档案不被截掉）；
        // 宽前缀（`adina %` / `mark %`，命中上万行）不排序 → 命中够 LIMIT 就提前停，避免为大范围读堆 + 排序
        const prefixLiteral = plan.prefix.slice(0, -1)
        const planRowCap = plan.score >= 95 && prefixLiteral.length >= 8 ? Math.max(limit * 5, 1000) : rowCap
        const conds = [`${SQL_NORM_NAME} like $1`]
        const params: any[] = [plan.prefix]
        if (plan.suffix) {
          if (nameSuffixIndex) {
            // 有后缀索引：`%surname` → `reverse(norm) LIKE 'yemanrus%'`，两个条件都能走索引（BitmapAnd）
            params.push(`${reverseStr(plan.suffix)}%`)
            conds.push(`${SQL_NORM_NAME_REV} like $${params.length}`)
          } else {
            params.push(`%${plan.suffix}`)
            conds.push(`${SQL_NORM_NAME} like $${params.length}`)
          }
        }
        params.push(planRowCap)
        const qt0 = Date.now()
        const r = await queryRows(
          client,
          `${base} where ${conds.join(' and ')} limit $${params.length}`,
          params
        )
        if (debugTiming()) {
          console.error(`[pg-mcp] 姓名查询 ${Date.now() - qt0} ms（${r.rows.length} 行）：${conds.join(' and ')} limit ${planRowCap}`)
        }
        queries++
        if (r.rows.length) bestByMatcher[plan.mi] = Math.max(bestByMatcher[plan.mi], plan.score)
        collect(r.rows)
      }
      if (got.length) {
        // 快路是多条查询拼起来的：JS 里按「匹配强度 → 论文数」排（不依赖 SQL 排序，避免规划器改选全表扫）
        const scoreOf = (dn: string) => matchers.reduce((mx, m) => Math.max(mx, scoreName(m, dn)), 0)
        got.sort((a, b) => scoreOf(b.dn) - scoreOf(a.dn) || b.wc - a.wc)
        return { rows: got, via: 'index', queries, ms: Date.now() - tStart }
      }
      // 调用方明确要求「只试索引、不要内部退化成全表扫」（如批量里的深度重试）：直接返回空
      if (opts.noScanFallback) return { rows: [], via: 'index', queries, ms: Date.now() - tStart }
    }
  }

  const scan = await queryRows(
    client,
    `select split_part(id, '/', 4) as author_id, ${SQL_NORM_NAME} as dn
       from ${T('authors')}
      where ${SQL_NORM_NAME} = any($1::text[]) or ${SQL_NORM_NAME} like any($2::text[])
      order by case when ${SQL_NORM_NAME} = any($1::text[]) then 0 else 1 end,
               coalesce(works_count, 0) desc
      limit $3`,
    [exactAll, likeAll, limit]
  )
  return {
    rows: scan.rows.map((r) => ({ id: str(r[0]), dn: str(r[1]), wc: 0 })).filter((r) => r.id),
    via: 'scan',
    queries: 1,
    ms: Date.now() - tStart,
  }
}

// ---------------- 作者消歧（人名 + 机构 → 作者 ID，一步到位）----------------

/** 机构名里的泛化词：把 "Stanford Center for Health Education" / "Yale School of Medicine" 归约成关键词 */
const INST_STOPWORDS = new Set([
  'center', 'centre', 'for', 'of', 'and', 'the', 'health', 'healthcare', 'education', 'university',
  'institute', 'institution', 'department', 'dept', 'school', 'college', 'faculty', 'laboratory', 'lab',
  'research', 'national', 'academy', 'hospital', 'medical', 'medicine', 'nursing', 'pharmacy', 'dentistry',
  'science', 'sciences', 'technology', 'engineering', 'graduate', 'studies', 'program', 'programme',
  'division', 'unit', 'office', 'branch', 'public', 'global', 'affairs', 'clinical', 'clinic', 'campus',
])

/** 依次尝试的机构关键词：先原串（最精确），再逐个非泛化词（保持原顺序，专有名词通常在前） */
function institutionKeys(raw: string): string[] {
  const s = str(raw).trim()
  if (!s) return []
  const words = s.split(/[\s,;/]+/).filter(Boolean)
  const keep = words.filter((w) => w.length >= 3 && !INST_STOPWORDS.has(w.toLowerCase()))
  const out = [s]
  for (const w of keep) {
    if (!out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w)
  }
  return out
}

/** 一组「匹配强度 → 匹配式」规则：分数高的组先判，命中即取其分值 */
interface MatcherGroup {
  score: number
  exact: string[]
  like: string[]
}

interface NameMatchers {
  mode: 'full' | 'surname'
  surname: string
  groups: MatcherGroup[]
}

/** 姓名归一化：小写 → 去句点（Mr. / E. / 缩写点）→ 折叠空格。库内与输入两侧都过一遍，才不会因标点差异匹配不上 */
function normName(v: any): string {
  return str(v)
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** SQL 侧同一套归一化的轻量表达（translate 比 regexp_replace 便宜，空格差异靠模式里的 % 吃掉） */
const SQL_NORM_NAME = `translate(lower(display_name), '.', ' ')`

/** 归一化表达式的反转（后缀索引使用；reverse 是 IMMUTABLE，可建表达式索引） */
const SQL_NORM_NAME_REV = `reverse(${SQL_NORM_NAME})`

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** SQL LIKE 语义的匹配（支持 % 出现在任意位置，如 `mark %perazella`）；正则按模式缓存，避免逐行重建 */
const likeRxCache = new Map<string, RegExp>()
function likeMatch(text: string, pattern: string): boolean {
  let rx = likeRxCache.get(pattern)
  if (!rx) {
    rx = new RegExp('^' + pattern.split('%').map(escapeRegex).join('.*') + '$')
    if (likeRxCache.size > 4000) likeRxCache.clear()
    likeRxCache.set(pattern, rx)
  }
  return rx.test(text)
}

/**
 * 由「可能不全的人名」生成分级匹配式。覆盖：
 * - 双词序（库里 `Wei Zhang` 与 `Zhang Wei` 并存）
 * - 中间名 / 中间首字母（`Mark Perazella` → 命中 `Mark A. Perazella`）
 * - 截断与连字符（`Zhang We` / `Zhang Wei-hua`）
 * - 只给姓、或「姓 + 首字母」（`Yasmin S` / `S Yasmin`）
 */
function buildNameMatchers(rawName: string): NameMatchers {
  const lower = normName(rawName).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = lower.split(' ').filter(Boolean)
  if (tokens.length === 1) {
    return {
      mode: 'surname',
      surname: tokens[0],
      groups: [{ score: 30, exact: [], like: [`${tokens[0]}%`, `${tokens[0]} %`] }],
    }
  }
  const isInitial = (t: string) => /^[a-z]$/.test(t)
  const firstTok = tokens[0]
  const lastTok = tokens[tokens.length - 1]
  const givenTokens = tokens.slice(0, -1)
  let surname: string
  let given: string
  let givenIsInitial: boolean
  if (isInitial(lastTok)) {
    surname = firstTok
    given = lastTok
    givenIsInitial = true
  } else if (isInitial(firstTok)) {
    surname = lastTok
    given = firstTok
    givenIsInitial = true
  } else {
    surname = lastTok
    given = tokens.slice(0, -1).join(' ')
    givenIsInitial = false
  }
  const gi = given[0]
  const groups: MatcherGroup[] = givenIsInitial
    ? [
        {
          score: 90,
          exact: [`${surname} ${gi}`, `${gi} ${surname}`],
          like: [
            `${surname} ${gi}%`,
            `${gi} ${surname}%`,
            `${gi} %${surname}`,
            `%${surname} ${gi}`,
            `${surname}, ${gi}%`,
          ],
        },
        { score: 50, exact: [], like: [`${surname} ${gi}%`, `${gi} ${surname}%`] },
        // 兜底：只给首字母时，仍把「姓」相关候选（如 `Mark A. Perazella` / `Perazella Ma`）列在后面供人工识别
        { score: 35, exact: [], like: [`${surname}%`, `${surname} %`, `%${surname}`, `% ${surname}`] },
      ]
    : [
        {
          score: 100,
          exact: [lower, `${given} ${surname}`, `${surname} ${given}`],
          like: [`${given} ${surname}%`, `${surname} ${given}%`],
        },
        {
          // 中间名 / 中间首字母：`mark %perazella`、`%perazella mark`、`perazella, mark`
          score: 90,
          exact: [],
          like: [`${given} %${surname}`, `%${surname} ${given}`, `%${surname}, ${given}`, `${surname}, ${given}%`],
        },
        {
          // 库里缺中间名（输入 `Adina Simona Voiculescu` → 库里 `Adina Voiculescu`）或输入缺中间名：
          // 只用首段名 + 姓，分数略低于完整匹配
          score: 85,
          exact: [],
          like: [`${givenTokens[0]} %${surname}`, `${surname} ${givenTokens[0]}%`, `${givenTokens[0]} ${surname}%`],
        },
        {
          // 名只给首字母
          score: 50,
          exact: [],
          like: [`${gi} %${surname}`, `${gi} ${surname}%`, `${surname} ${gi}%`, `%${surname} ${gi}`],
        },
      ]
  return { mode: 'full', surname, groups }
}

/** 按分级规则给 display_name 打分（无命中返回 20） */
function scoreName(m: NameMatchers, display: string): number {
  const dl = normName(display)
  for (const g of m.groups) {
    if (g.exact.includes(dl) || g.like.some((p) => likeMatch(dl, p))) return g.score
  }
  return 20
}

type AuthorCand = {
  id: string
  display: string
  orcid: string
  works: number
  cited: number
  instWorks: number
  y1: string
  y2: string
  nameScore: number
  instScore: number
  score: number
  tier: 'auto' | 'review' | 'weak'
  insts: Array<{ id: string; name: string; works: number }>
  topWorks: string[]
}

/** 本工具的匹配式可能含中间通配（如 `mark %perazella`），故用通用 LIKE 语义匹配 */

/** 汇总候选证据并渲染（机构历史 + 代表作，供判定/人工复核） */
async function renderAuthorCandidates(
  client: any,
  sch: string,
  head: string[],
  candIds: string[],
  targetInstIds: string[],
  m: NameMatchers,
  t0: number,
  detail: 'auto' | 'brief' | 'full'
): Promise<string> {
  const T = (t: string) => `${quoteIdent(sch)}.${t}`
  const longIds = candIds.map((id) => (id.startsWith('http') ? id : `https://openalex.org/${id}`))

  const base = await queryRows(
    client,
    `select split_part(id, '/', 4) as author_id, display_name, coalesce(orcid, '') as orcid,
            works_count, cited_by_count
       from ${T('authors')}
      where id = any($1::text[])`,
    [longIds]
  )
  const instAll = await queryRows(
    client,
    `select wa.author_id, i.id, i.display_name, count(distinct wa.work_id)::bigint as works
       from ${T('works_authorships')} wa
       join ${T('institutions')} i on i.id = wa.institution_id
      where wa.author_id = any($1::text[])
      group by 1, 2, 3
      order by 1, works desc`,
    [candIds]
  )
  const years = await queryRows(
    client,
    `select wa.author_id, min(w.publication_year)::text as y1, max(w.publication_year)::text as y2
       from ${T('works_authorships')} wa
       join ${T('works')} w on w.id = wa.work_id
      where wa.author_id = any($1::text[]) and w.publication_year is not null
      group by 1`,
    [candIds]
  )
  const topWorks = await queryRows(
    client,
    `select author_id, year, cited, title from (
        select wa.author_id as author_id, w.publication_year as year, w.cited_by_count as cited,
               left(w.title, 80) as title,
               row_number() over (partition by wa.author_id order by w.cited_by_count desc) as rn
          from ${T('works_authorships')} wa
          join ${T('works')} w on w.id = wa.work_id
         where wa.author_id = any($1::text[])
       ) t where rn <= 2 order by author_id, cited desc`,
    [candIds]
  )

  const instById = new Map<string, Array<{ id: string; name: string; works: number }>>()
  for (const r of instAll.rows) {
    const id = str(r[0])
    const arr = instById.get(id) || []
    arr.push({ id: str(r[1]), name: str(r[2]), works: Number(r[3]) || 0 })
    instById.set(id, arr)
  }
  const yearById = new Map<string, string>()
  for (const r of years.rows) yearById.set(str(r[0]), `${str(r[1])}–${str(r[2])}`)
  const worksById = new Map<string, string[]>()
  for (const r of topWorks.rows) {
    const id = str(r[0])
    const arr = worksById.get(id) || []
    arr.push(`[${str(r[1])} · 被引 ${str(r[2])}] ${str(r[3])}`)
    worksById.set(id, arr)
  }

  const target = new Set(targetInstIds)
  const cands: AuthorCand[] = base.rows.map((r) => {
    const id = str(r[0])
    const display = str(r[1])
    const works = Number(r[3]) || 0
    const cited = Number(r[4]) || 0
    const insts = instById.get(id) || []
    // 目标机构命中：按 institution_id 精确匹配（目标机构可能不止一个，如主校 + 附属机构）
    const instWorks = insts.filter((x) => target.has(x.id)).reduce((a, b) => a + b.works, 0)
    const nameScore = scoreName(m, display)
    // 机构证据：命中且论文数足够 → 强证据；小档案（论文 < 5）只能算弱证据
    const instScore = instWorks > 0 ? (works >= 5 ? 100 : 60) : 0
    const score = nameScore + instScore
    const tier: AuthorCand['tier'] =
      score >= 180 && works >= 5 && instWorks > 0 ? 'auto' : score >= 100 ? 'review' : 'weak'
    const [y1, y2] = (yearById.get(id) || '–').split('–')
    return {
      id,
      display,
      orcid: str(r[2]),
      works,
      cited,
      instWorks,
      y1: str(y1),
      y2: str(y2),
      nameScore,
      instScore,
      score,
      tier,
      insts,
      topWorks: worksById.get(id) || [],
    }
  })
  cands.sort((a, b) => b.score - a.score || b.cited - a.cited)

  const overview = cands.map((c, i) => [
    i + 1,
    c.id,
    c.display,
    c.orcid || '—',
    c.works,
    c.cited,
    target.size ? c.instWorks : '—',
    c.y1 ? `${c.y1}–${c.y2}` : '—',
    c.insts.slice(0, 2).map((x) => x.name).join('；') || '—',
    `${c.score}`,
    c.tier,
  ])
  const lines = [
    ...head,
    '',
    target.size
      ? '（“目标机构论文”= 该候选在目标机构下的论文数；库里可能只收录上级机构，故 0 不等于不相关）'
      : '（未提供有效机构 → 无机构证据，“判定”不会自动确认）',
    '',
    formatTable(
      ['#', 'author_id', 'display_name', 'orcid', '论文', '被引', '目标机构论文', '年份', '主要机构', 'score', '判定'],
      overview
    ),
  ]
  if (m.mode === 'surname') lines.push('', '⚠ 只给了姓氏：候选天然很多，必须结合机构/代表作，且应交由用户确认。')

  const top = cands[0]
  const second = cands[1]
  // 只给了首字母/前缀时，排第一的常常是"小档案"；若机构命中者中另有一个论文数远大的，以它为主档案
  const withInst = cands.filter((c) => c.instWorks > 0)
  const biggest = withInst.slice().sort((a, b) => b.works - a.works)[0]
  const recommend = biggest && top && biggest.id !== top.id && biggest.works >= 5 * Math.max(1, top.works) ? biggest : top
  // 「主档案」判定：与次优候选相比，论文数/机构命中数明显占优（其余通常是同一人的碎片档案）
  const secondVs = cands.find((c) => c.id !== recommend.id)
  const dominant =
    !!recommend &&
    recommend.works >= 5 &&
    !!secondVs &&
    (recommend.instWorks >= 3 * secondVs.instWorks || recommend.works >= 5 * secondVs.works)
  void second
  const auto = cands.filter((c) => c.tier === 'auto')
  // 明细：brief 时不要；auto 模式下唯一结论（主档案或单一 auto）时不输出（省 token）
  const showDetail = detail === 'full' || (detail !== 'brief' && !(dominant || auto.length === 1))
  if (showDetail) {
    for (const c of cands.slice(0, 6)) {
      lines.push(
        '',
        `▸ ${c.id} ｜ ${c.display} ｜ 论文 ${c.works} ｜ 被引 ${c.cited} ｜ 判定 ${c.tier}`,
        `   机构历史：${c.insts.slice(0, 6).map((x) => `${x.name}(${x.works})`).join('、') || '（无）'}`,
        ...(c.topWorks.length ? c.topWorks.map((w) => `   代表作：${w}`) : ['   代表作：（无）'])
      )
    }
  }

  lines.push('')
  if (dominant) {
    const others = cands.filter((c) => c.id !== recommend.id && c.tier === 'auto')
    if (recommend.id !== top.id) {
      lines.push(
        `注意：#1（${top.id}）只是姓名匹配靠前的小档案（${top.works} 篇）；按机构命中与论文规模，作者主档案应为 ${recommend.id}。`
      )
    }
    lines.push(
      `结论建议（主档案）：${recommend.id}（${recommend.display}）—— 机构证据：${recommend.insts.slice(0, 3).map((x) => `${x.name}(${x.works})`).join('、') || '（无）'}；论文 ${recommend.works} 篇${recommend.orcid ? '；含 ORCID' : ''}。`
    )
    if (others.length) {
      lines.push(
        `另有 ${others.length} 个疑似同一人的小档案：${others.map((c) => `${c.id}(${c.works} 篇)`).join('、')}——批量统计时建议以主档案为准，或按需人工合并。`
      )
    }
  } else if (auto.length === 1) {
    lines.push(
      showDetail
        ? `结论建议：${auto[0].id}（${auto[0].display}）——请核对上方机构历史/代表作后再采用。`
        : `结论建议：${auto[0].id}（${auto[0].display}）——机构证据：${auto[0].insts.slice(0, 3).map((x) => `${x.name}(${x.works})`).join('、') || '（无）'}。`
    )
  } else if (auto.length > 1) {
    lines.push(`存在 ${auto.length} 个高置信候选：请用机构历史与代表作区分；仍无法区分时让用户确认，不要按论文数/被引猜。`)
  } else if (cands.length) {
    lines.push('没有达到自动确认的候选：请结合机构历史/代表作判定，或让用户确认（补 ORCID 可一次定位）。')
  }
  lines.push('提示：机构证据取自 works_authorships.institution_id（库内最可靠）；目标机构在库中不存在时，本工具会忽略机构过滤并列出候选。')
  lines.push(`⏱ 本工具总用时 ${Date.now() - t0} ms（姓名检索是全表扫，故较慢）`)
  return truncateOutput(lines.join('\n'))
}

/**
 * 作者消歧入口（单条 / 批量）。单条见 pgResolveAuthorSingle；批量（names 数组）一次扫描解析多条，
 * 避免批量智能体“每条一个线程各扫一遍 28 GB”。
 */
async function pgResolveAuthor(args: any): Promise<string> {
  const detailArg = str(args?.detail ?? args?.format).toLowerCase()
  const detail: 'auto' | 'brief' | 'full' =
    detailArg === 'brief' ? 'brief' : detailArg === 'full' ? 'full' : 'auto'
  const limit = clampInt(args?.limit, 10, 1, 50)

  // 批量模式：names 可为 ["姓名|机构", ...] 或 [{name, institution, orcid}, ...]
  const namesArg = args?.names ?? args?.queries
  if (Array.isArray(namesArg) && namesArg.length) {
    const items = namesArg
      .map((x: any) => {
        if (typeof x === 'string') {
          const [n, inst] = String(x).split('|')
          return { name: str(n), institution: str(inst), orcid: '' }
        }
        return {
          name: str(x?.name ?? x?.author),
          institution: str(x?.institution ?? x?.inst ?? x?.affiliation),
          orcid: str(x?.orcid),
        }
      })
      .filter((x: any) => x.name)
    if (!items.length) {
      throw new Error('names 参数格式不正确：可传 ["姓名|机构", ...] 或 [{name, institution}, ...]')
    }
    if (items.length > 200) throw new Error('names 一次最多 200 条（更多请分批）')
    return await enqueueResolve(() => pgResolveAuthorBatch(items, detail, limit))
  }

  const key = resolveCacheKey(args)
  const cached = resolveCacheGet(key)
  if (cached) return `（10 分钟内相同查询，直接返回缓存结果）\n${cached}`
  const text = await enqueueResolve(() => pgResolveAuthorSingle(args, detail, limit))
  resolveCacheSet(key, text)
  return text
}

interface BatchItem {
  name: string
  institution: string
  orcid: string
}

/** 机构名 → institutions 白名单（先原串、再逐个非泛化词，命中即止）；按关键词缓存，批量同机构不重复查 */
const instKeyCache = new Map<string, { ids: string[]; labels: string[] }>()

async function lookupInstitutionKey(
  client: any,
  T: (t: string) => string,
  key: string
): Promise<{ ids: string[]; labels: string[] }> {
  const hit = instKeyCache.get(key)
  if (hit) return hit
  const { rows } = await queryRows(
    client,
    `select id, display_name from ${T('institutions')}
      where lower(display_name) like '%' || lower($1) || '%'
      order by works_count desc nulls last limit 5`,
    [key]
  )
  const ids: string[] = []
  const labels: string[] = []
  for (const r of rows) {
    const id = str(r[0])
    if (id && !ids.includes(id)) {
      ids.push(id)
      labels.push(`${str(r[1])}(${id})`)
    }
  }
  const out = { ids, labels }
  if (instKeyCache.size > 500) instKeyCache.clear()
  instKeyCache.set(key, out)
  return out
}

async function resolveInstIds(
  client: any,
  T: (t: string) => string,
  rawInst: string
): Promise<{ ids: string[]; labels: string[]; usedKey: string }> {
  const ids: string[] = []
  const labels: string[] = []
  if (!str(rawInst).trim()) return { ids, labels, usedKey: '' }
  for (const key of institutionKeys(rawInst)) {
    const { ids: hitIds, labels: hitLabels } = await lookupInstitutionKey(client, T, key)
    if (hitIds.length) {
      for (let i = 0; i < hitIds.length; i++) {
        if (!ids.includes(hitIds[i])) {
          ids.push(hitIds[i])
          labels.push(hitLabels[i])
        }
      }
      return { ids, labels, usedKey: key }
    }
  }
  return { ids, labels, usedKey: '' }
}

/**
 * 批量作者消歧：**一次姓名扫描**覆盖全部条目（不再一条一扫描），逐条给出结论 ID。
 * 输出为紧凑表 + 「结果：姓名 → ID」清单，适合批量智能体直接取用。
 */
async function pgResolveAuthorBatch(
  items: BatchItem[],
  detail: 'auto' | 'brief' | 'full',
  limit: number
): Promise<string> {
  const prepared = items.map((it) => {
    const m = buildNameMatchers(it.name)
    return { ...it, m }
  })
  return withClient(async (client, s) => {
    const sch = s.schema || 'openalex'
    const T = (t: string) => `${quoteIdent(sch)}.${t}`
    const t0 = Date.now()
    const head = [`【批量作者消歧】${items.length} 条 ｜ schema：${sch}`]

    // 1) ORCID 直通车（最准）
    const orcids = prepared
      .map((p) => (p.orcid ? (p.orcid.startsWith('http') ? p.orcid : `https://orcid.org/${p.orcid}`) : ''))
      .filter(Boolean)
    const byOrcid = new Map<string, string>()
    if (orcids.length) {
      const r = await queryRows(
        client,
        `select lower(orcid) as orcid, split_part(author_id, '/', 4) as aid from ${T('authors_ids')} where lower(orcid) = any($1::text[])`,
        [orcids.map((o) => o.toLowerCase())]
      )
      r.rows.forEach((x) => {
        const aid = str(x[1])
        if (aid) byOrcid.set(str(x[0]), aid)
      })
    }

    // 2) 合并一次姓名扫描（有姓名索引时走索引快路；未覆盖到的条目按「姓」补查）
    const surnameLikes = [...new Set(prepared.map((p) => p.m.surname).filter(Boolean).map((sn) => `%${sn}%`))]
    const scan = await scanAuthorCandidates(client, T, prepared.map((p) => p.m), 1500, {
      plansPerMatcher: 2, // 批量条目多：每条只取最强的前 2 个前缀计划
      extraLoose: surnameLikes, // 兜底全表扫时保证「只要姓对得上」就能进候选（避免漏召回）
    })
    let scanRows = scan.rows
    let scanVia: 'index' | 'scan' | 'index+scan' | 'index+suffix' | 'index+deep' = scan.via
    let scanQueries = scan.queries
    let scanMs = scan.ms
    const isUnresolved = (p: (typeof prepared)[number]) => !scanRows.some((r) => scoreName(p.m, r.dn) > 20)
    if (scan.via === 'index') {
      // 快路每条只用前 2 个计划，可能漏掉「库里带中间名/缺中间名/截断」的写法
      // → 先对未命中条目用「全部计划」再试一次（仍走索引，每条几十毫秒，比全表扫便宜得多）
      let miss = prepared.filter(isUnresolved)
      if (miss.length && miss.length < prepared.length) {
        const t1 = Date.now()
        const deep = await scanAuthorCandidates(client, T, miss.map((p) => p.m), 1500, { plansPerMatcher: 8, ignorePlanCap: true, noScanFallback: true })
        scanQueries += deep.queries
        scanMs += Date.now() - t1
        if (deep.via === 'index' && deep.rows.length) {
          const have = new Set(scanRows.map((r) => r.id))
          const add = deep.rows.filter((r) => !have.has(r.id))
          if (add.length) scanRows = [...scanRows, ...add]
          scanVia = 'index+deep'
          head.push(`↳ 快路未命中 ${miss.length} 条 → 用「全部计划」索引重试（${deep.queries} 次查询 / ${Date.now() - t1} ms，+${add.length} 行候选）`)
        }
        miss = prepared.filter(isUnresolved)
      }
      // 仍未命中的：有后缀索引时按「姓」用索引补查；没索引时默认不再全表扫（除非显式打开开关）
      if (miss.length && miss.length < prepared.length) {
        const missSurnames = [...new Set(miss.map((p) => p.m.surname).filter(Boolean))]
        let add: Array<{ id: string; dn: string; wc: number }> = []
        const t2 = Date.now()
        if (nameSuffixIndex && missSurnames.length) {
          // 有后缀索引：按「姓结尾」逐条查（毫秒级），不再付一次 15–20 s 的全表扫
          const extra: Array<{ id: string; dn: string; wc: number }> = []
          const got2 = new Set<string>()
          for (const sn of missSurnames) {
            const r = await queryRows(
              client,
              `select split_part(id, '/', 4) as author_id, ${SQL_NORM_NAME} as dn, coalesce(works_count, 0)::bigint as wc
                 from ${T('authors')}
                where ${SQL_NORM_NAME_REV} like $1
                limit 800`,
              [`${reverseStr(sn)}%`]
            )
            for (const row of r.rows) {
              const id = str(row[0])
              if (id && !got2.has(id)) {
                got2.add(id)
                extra.push({ id, dn: str(row[1]), wc: Number(row[2]) || 0 })
              }
            }
          }
          scanQueries += missSurnames.length
          scanMs += Date.now() - t2
          const have = new Set(scanRows.map((r) => r.id))
          add = extra.filter((r) => !have.has(r.id))
          scanVia = 'index+suffix'
          head.push(`↳ 仍未命中 ${miss.length} 条 → 已按「姓」（后缀索引）补查 ${missSurnames.length} 次（+${add.length} 行候选）`)
        } else if (fallbackScanEnabled()) {
          const back = await scanAuthorCandidates(client, T, miss.map((p) => p.m), 1500, {
            forceScan: true,
            extraLoose: missSurnames.map((sn) => `%${sn}%`),
          })
          scanQueries += back.queries
          scanMs += back.ms
          const have = new Set(scanRows.map((r) => r.id))
          add = back.rows.filter((r) => !have.has(r.id))
          scanVia = 'index+scan'
          head.push(`↳ 仍未命中 ${miss.length} 条 → 已补一次全表扫（${back.ms} ms，+${add.length} 行候选）`)
        } else {
          head.push(
            `↳ 仍有 ${miss.length} 条未命中（已跳过全表扫兜底，避免白付几十秒）：`,
            `   如需更彻底找回，可在服务 env 里加 "PG_MCP_BATCH_FALLBACK_SCAN":"1"，或建后缀索引后自动改用索引补查`
          )
        }
        if (add.length) scanRows = [...scanRows, ...add]
      }
    }
    const viaText =
      scanVia === 'index'
        ? '走姓名索引快路'
        : scanVia === 'scan'
          ? '全表扫'
          : scanVia === 'index+deep'
            ? '索引快路 + 全部计划重试'
            : scanVia === 'index+scan'
              ? '索引快路 + 兜底全表扫'
              : '索引快路 + 后缀索引补查'
    head.push(`姓名扫描：**${scanQueries} 次查询 / ${scanMs} ms**（${viaText}）→ 命中 ${scanRows.length} 行候选`)

    // 3) 逐条评分 + 机构求交
    const out: Array<{
      idx: number
      query: string
      inst: string
      author_id: string
      display: string
      works: number
      instWorks: number
      score: number
      note: string
    }> = []
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]
      const scores = new Map<string, number>()
      for (const r of scanRows) {
        const sc = scoreName(p.m, r.dn)
        if (sc > 20) scores.set(r.id, Math.max(scores.get(r.id) || 0, sc))
      }
      const orcidHit = p.orcid ? byOrcid.get((p.orcid.startsWith('http') ? p.orcid : `https://orcid.org/${p.orcid}`).toLowerCase()) : ''
      if (orcidHit) scores.set(orcidHit, 100)

      let candIds = [...scores.keys()]
      const inst = await resolveInstIds(client, T, p.institution)
      if (inst.ids.length && candIds.length) {
        const hit = await queryRows(
          client,
          `select wa.author_id, count(distinct wa.work_id)::bigint as n
             from ${T('works_authorships')} wa
            where wa.institution_id = any($1::text[]) and wa.author_id = any($2::text[])
            group by 1`,
          [inst.ids, candIds]
        )
        const instWorks = new Map(hit.rows.map((r) => [str(r[0]), Number(r[1]) || 0]))
        // 选择顺序：匹配强度 > 机构命中数 > 论文数（不单看机构论文数，否则小档案会压过主档案）
        candIds = candIds.sort(
          (a, b) =>
            (scores.get(b) || 0) - (scores.get(a) || 0) ||
            (instWorks.get(b) || 0) - (instWorks.get(a) || 0)
        )
        const ordered = new Map<string, number>()
        for (const id of candIds) ordered.set(id, instWorks.get(id) || 0)
        const topIds = candIds.slice(0, 3)
        const base = topIds.length
          ? await queryRows(
              client,
              `select split_part(id, '/', 4) as id, display_name, works_count from ${T('authors')} where id = any($1::text[])`,
              [topIds.map((id) => `https://openalex.org/${id}`)]
            )
          : { fields: [], rows: [] }
        const baseMap = new Map(base.rows.map((r) => [str(r[0]), { display: str(r[1]), works: Number(r[2]) || 0 }]))
        // 主档案提升：仅在**同等高强度匹配**（得分≥90，或与最高分相差≤10）的候选之间按论文数取主档案；
        // 否则会把同姓的其他人误当主档案
        const bestScore = scores.get(topIds[0]) || 0
        const byWorks = topIds
          .filter(
            (id) =>
              (instWorks.get(id) || 0) > 0 &&
              baseMap.has(id) &&
              (scores.get(id) || 0) >= Math.max(90, bestScore - 10)
          )
          .sort((a, b) => (baseMap.get(b)?.works || 0) - (baseMap.get(a)?.works || 0))
        let pick = topIds.find((id) => baseMap.has(id)) || ''
        if (byWorks.length && pick && byWorks[0] !== pick) {
          const bigW = baseMap.get(byWorks[0])?.works || 0
          const pickW = baseMap.get(pick)?.works || 0
          if (bigW >= 5 * Math.max(1, pickW)) pick = byWorks[0]
        }
        const info = baseMap.get(pick)
        const secondPick = topIds[1] ? baseMap.get(topIds[1]) : undefined
        const note = !pick
          ? 'No Result'
          : (ordered.get(pick) || 0) >= 3 * Math.max(1, ordered.get(topIds[1]) || 0) ||
              (info?.works || 0) >= 5 * Math.max(1, secondPick?.works || 0)
            ? `主档案（另有 ${topIds.length - 1} 个候选）`
            : `需复核（${topIds.length} 个候选）`
        out.push({
          idx: i + 1,
          query: `${p.name}${p.institution ? ` @ ${p.institution}` : ''}`,
          inst: inst.labels[0] || (p.institution ? '（库中无匹配机构）' : '—'),
          author_id: pick || 'No Result',
          display: info?.display || '—',
          works: info?.works || 0,
          instWorks: pick ? ordered.get(pick) || 0 : 0,
          score: pick ? scores.get(pick) || 0 : 0,
          note,
        })
        continue
      }

      // 无机构参考：直接用姓名分排序取前几名
      const sorted = candIds.sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0)).slice(0, 3)
      const base = sorted.length
        ? await queryRows(
            client,
            `select split_part(id, '/', 4) as id, display_name, works_count from ${T('authors')} where id = any($1::text[])`,
            [sorted.map((id) => `https://openalex.org/${id}`)]
          )
        : { fields: [], rows: [] }
      const baseMap = new Map(base.rows.map((r) => [str(r[0]), { display: str(r[1]), works: Number(r[2]) || 0 }]))
      const pick = sorted.find((id) => baseMap.has(id)) || ''
      const info = baseMap.get(pick)
      out.push({
        idx: i + 1,
        query: p.name,
        inst: p.institution ? '（未匹配）' : '—',
        author_id: pick || 'No Result',
        display: info?.display || '—',
        works: info?.works || 0,
        instWorks: 0,
        score: pick ? scores.get(pick) || 0 : 0,
        note: pick ? `无机构证据（${sorted.length} 个候选），需复核` : 'No Result',
      })
    }

    const table = formatTable(
      ['#', '查询', '机构参考', 'author_id', 'display_name', '论文', '目标机构论文', 'score', '备注'],
      out.map((o) => [o.idx, o.query, o.inst, o.author_id, o.display, o.works, o.instWorks, o.score, o.note])
    )
    const list = out.map((o) => `${o.idx}. ${o.query} → ${o.author_id}`).join('\n')
    void limit
    void detail
    head.push('', table, '', '结果（姓名 → 作者 ID）：', list)
    head.push(
      '',
      '说明：批量模式共用一次姓名扫描，IO 压力最小（推荐批量任务用这个，而不是每条一个线程各查一次）；',
      '「No Result」表示库中查不到；标「需复核」的多候选建议人工确认，不要按论文数猜。'
    )
    head.push(`⏱ 批量总用时 ${Date.now() - t0} ms`)
    return truncateOutput(head.join('\n'))
  })
}

/**
 * 单条作者消歧：人名（可只给姓/首字母，支持中间名）+ 可选机构 → 候选列表 + 机构证据。
 * 口径与 skills/openalex-pg/references/batch-author-resolution.md 一致：一次姓名全表扫 + 索引求交。
 */
async function pgResolveAuthorSingle(
  args: any,
  detail: 'auto' | 'brief' | 'full',
  limit: number
): Promise<string> {
  const rawName = str(args?.name ?? args?.author ?? args?.query)
  if (!rawName) throw new Error('name 参数必填：作者姓名，可只写「姓」或「姓 + 首字母」（如 "Seema Yasmin" / "Yasmin S"）')
  const rawInst = str(args?.institution ?? args?.inst ?? args?.affiliation)
  const orcid = str(args?.orcid).trim()
  const m = buildNameMatchers(rawName)
  const t0 = Date.now()

  return withClient(async (client, s) => {
    const sch = s.schema || 'openalex'
    const T = (t: string) => `${quoteIdent(sch)}.${t}`
    const head = [`【作者消歧】name="${rawName}"${rawInst ? ` ｜ 机构参考="${rawInst}"` : ''}`, `schema：${sch}`]
    try {
      // 1) ORCID 直达（最准）
      if (orcid) {
        const target = orcid.startsWith('http') ? orcid : `https://orcid.org/${orcid}`
        const { rows } = await queryRows(client, 'select author_id from openalex.authors_ids where orcid = $1 limit 5', [target])
        const ids = rows.map((r) => str(r[0]).replace(/^https?:\/\/openalex\.org\//, '')).filter(Boolean)
        if (!ids.length) return `${head.join('\n')}\n\n该 ORCID 在库中无记录 → No Result`
        head.push(`按 ORCID 精确命中：${ids.join(', ')}`)
        return await renderAuthorCandidates(client, sch, head, ids, [], m, t0, detail)
      }

      // 2) 机构名 → institutions 白名单（先全称，再退化到关键词，如 "Stanford"）
      const targetIds: string[] = []
      const targetLabels: string[] = []
      for (const key of institutionKeys(rawInst)) {
        const { ids: hitIds, labels: hitLabels } = await lookupInstitutionKey(client, T, key)
        if (hitIds.length) {
          for (let i = 0; i < hitIds.length; i++) {
            if (!targetIds.includes(hitIds[i])) {
              targetIds.push(hitIds[i])
              targetLabels.push(hitLabels[i])
            }
          }
          head.push(`机构匹配（关键词 "${key}"）→ ${targetLabels.join('、')}`)
          break
        }
      }
      if (rawInst && !targetIds.length) {
        head.push(`⚠ 库中没有匹配「${rawInst}」的机构（这类单位往往不是独立机构实体，库里只收录上级机构）→ 忽略机构过滤，先按姓名取候选并列出机构历史`)
      }

      // 3) 姓名匹配的候选集：有姓名索引走索引快路（毫秒级），否则一次全表扫（15–20 s）；
      //    不逐行 EXISTS，且排序保证被 LIMIT 截断时优先保留最可能的候选
      let scanIds: string[] = []
      let scanStats = { queries: 0, ms: 0 }
      const doNameScan = async (force: boolean): Promise<'index' | 'scan'> => {
        const r = await scanAuthorCandidates(client, T, [m], 500, { forceScan: force })
        scanStats = { queries: r.queries, ms: r.ms }
        scanIds = []
        const seen = new Set<string>()
        for (const row of r.rows) {
          if (row.id && !seen.has(row.id)) {
            seen.add(row.id)
            scanIds.push(row.id)
          }
        }
        return r.via
      }
      let scanVia: 'index' | 'scan' = await doNameScan(false)
      head.push(
        scanVia === 'index'
          ? `姓名匹配候选（走姓名索引快路：${scanStats.queries} 次查询 / ${scanStats.ms} ms）：${scanIds.length} 个`
          : `姓名匹配候选（全表扫，${scanStats.ms} ms）：${scanIds.length} 个${scanIds.length >= 500 ? '（已截断到 500，靠前的更可能相关）' : ''}`
      )

      // 有机构参考时，用一次索引查询求交（author_id / institution_id 双索引）
      const intersectInst = async (): Promise<string[]> => {
        if (!targetIds.length || !scanIds.length) return []
        const hit = await queryRows(
          client,
          `select wa.author_id, count(distinct wa.work_id)::bigint as inst_works
             from ${T('works_authorships')} wa
            where wa.institution_id = any($1::text[]) and wa.author_id = any($2::text[])
            group by 1
            order by inst_works desc
            limit 200`,
          [targetIds, scanIds]
        )
        return hit.rows.map((r) => str(r[0])).filter(Boolean)
      }
      let inInst = await intersectInst()
      if (targetIds.length && !inInst.length && scanVia === 'index') {
        // 索引快路没命中目标机构 → 该人的档案可能带中间名/别名，快路模式覆盖不到：补一次全表扫复核
        head.push('↳ 索引快路在目标机构内没命中 → 已兜底全表扫复核（保证不因走索引而漏人）')
        scanVia = await doNameScan(true)
        inInst = await intersectInst()
      }
      if (targetIds.length && scanIds.length) head.push(`其中在目标机构发表过的：${inInst.length} 个（走索引求交）`)
      // 机构命中优先，其余候选保留在后面（机构历史里仍能看到证据）
      const candIds: string[] = targetIds.length ? [...inInst, ...scanIds.filter((id) => !inInst.includes(id))] : scanIds
      if (!candIds.length) return `${head.join('\n')}\n\n未找到任何候选 → No Result`

      return await renderAuthorCandidates(client, sch, head, candIds.slice(0, limit), targetIds, m, t0, detail)
    } catch (e: any) {
      if (str(e?.code) === '42P01') {
        throw new Error(
          `本工具面向 OpenAlex 结构的库（需要 ${sch}.authors / works / works_authorships / institutions / institutions 等表）。` +
            `当前库结构不符或 schema 不对：可用环境变量 PG_MCP_SCHEMA 指定 schema，或用 pg_list_tables 确认表名。`
        )
      }
      throw e
    }
  })
}

// ---------------- 工具清单 ----------------
export function toolDefinitions(): any[] {
  return [
    {
      name: 'pg_resolve_author',
      description:
        '【作者消歧·优先用】把人名（可只给姓/首字母，支持「名 姓」与「姓 名」、中间名/中间首字母：如 "Mark Perazella" 能命中 "Mark A. Perazella"）+ 可选机构参考，一次性解析成 OpenAlex 作者 ID：返回候选表（ORCID、论文数、被引、目标机构命中数、年份、主要机构、分档）与结论建议，默认自动控制长度（唯一高置信候选时只给结论，多候选时附机构历史与代表作）；同一人常有多个碎片档案时会给出「主档案」结论。**批量任务请用 `names` 一次解析多条（共用一次姓名扫描）**，不要每条开一个线程各查一次——服务端对单条调用已串行化，但并发仍然会拉长总耗时。机构可给完整单位名（库里只有上级机构时会自动退化成关键词，如 "Yale School of Medicine" → Yale 相关机构）或缩写词；给 orcid 直接精确定位；无候选时返回 "No Result"。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '作者姓名；可只写姓（"Perazella"）或「姓 + 首字母」（"Perazella M"），支持两种词序与中间名' },
          institution: { type: 'string', description: '可选：机构参考（完整单位名 / 上级机构名 / 关键词，如 "Yale School of Medicine" 或 "Yale"）' },
          orcid: { type: 'string', description: '可选：ORCID（有则直接精确定位，强烈推荐）' },
          limit: { type: 'number', description: '候选返回条数上限（默认 10，最大 50）' },
          names: {
            type: 'array',
            description:
              '批量模式（推荐批量任务用来代替“每条一个线程”）：一次解析多条，共用一次姓名扫描；元素可为 "姓名|机构" 字符串，或 {name, institution, orcid} 对象（最多 200 条）。给了 names 时忽略 name 参数，返回紧凑表格与「姓名 → ID」清单',
            items: { type: 'string', description: '"姓名|机构"，如 "Mark Perazella|Yale School of Medicine"' },
          },
          detail: { type: 'string', enum: ['auto', 'brief', 'full'], description: "输出长度：auto（默认）唯一高置信候选时精简、多候选时附明细；brief 只要候选表+结论；full 总是附每个候选的机构历史与代表作" },
        },
        required: ['name'],
      },
    },
    {
      name: 'pg_status',
      description:
        '检查 PostgreSQL 连接配置与连通性（不传参）：返回当前连接目标（密码脱敏）、数据库/用户、服务器版本、只读事务状态、用户表数量，以及未配置时的填写指引。首次使用、报错排查时先调用它。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pg_list_schemas',
      description:
        '列出数据库中的全部 schema（不含系统 schema）及各 schema 下的表/视图数量。不确定数据放在哪个 schema 时先调用它。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pg_list_tables',
      description:
        '列出表 / 视图清单：表名、类型、行数估算（est_rows）与注释，可按 schema 限定、按表名/注释关键字模糊匹配。探查「离线大数据集里有哪些表」时优先调用；行数估算偏旧时可用 pg_query 执行 count(*) 精确计数。',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: '限定 schema（可选，如 public / openalex；省略则列出全部非系统 schema）' },
          keyword: { type: 'string', description: '关键字（可选）：匹配表名或表注释' },
          limit: { type: 'number', description: '返回条数上限（默认 100，最大 1000）' },
        },
      },
    },
    {
      name: 'pg_describe_table',
      description:
        '查看单张表/视图的结构：各列的名称、类型、是否非空、默认值与列注释，外加索引定义、行数估算与表大小。写 SQL 之前先看列名，避免猜错字段。',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名，可带 schema，如 works 或 openalex.works（含大写/特殊字符时用双引号）' },
        },
        required: ['table'],
      },
    },
    {
      name: 'pg_sample_rows',
      description: '采样查看某张表的前若干行（LIMIT 保护），用于确认字段内容形态（如 JSON 结构、日期格式、DOI 写法）。',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名，可带 schema，如 works' },
          limit: { type: 'number', description: '采样行数（默认 5，最大 50）' },
        },
        required: ['table'],
      },
    },
    {
      name: 'pg_query',
      description:
        '执行只读 SQL 查询（SELECT / WITH ... SELECT / TABLE / VALUES / SHOW / EXPLAIN）：支持聚合、CTE、JOIN、窗口函数与全文/模糊匹配。服务端强制只读事务、30 秒语句超时，缺省 LIMIT 会自动补上，返回 Markdown 表格。统计文献数量、被引分布、机构/年份分布、关键词共现等分析都走它。',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '单条只读 SQL（不要带多条语句；写操作会被拒绝）' },
          max_rows: { type: 'number', description: `返回行数上限（默认 ${DEFAULT_MAX_ROWS}，最大 ${HARD_MAX_ROWS}；聚合查询通常返回少量行）` },
        },
        required: ['sql'],
      },
    },
  ]
}

// ---------------- 工具执行 ----------------
async function executeTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'pg_resolve_author':
      return await pgResolveAuthor(args)
    case 'pg_status':
      return await pgStatus()
    case 'pg_list_schemas':
      return await pgListSchemas()
    case 'pg_list_tables':
      return await pgListTables(args)
    case 'pg_describe_table':
      return await pgDescribeTable(args)
    case 'pg_sample_rows':
      return await pgSampleRows(args)
    case 'pg_query':
      return await pgQuery(args)
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ---------------- 共享单例 Server（内置连接与对外暴露共用） ----------------
let sharedServer: any = null
let sharedServerReady: Promise<any> | null = null

async function ensureServer(): Promise<any> {
  if (sharedServer) return sharedServer
  if (!sharedServerReady) {
    sharedServerReady = (async () => {
      const sdk = await getServerSdk()
      const server = new sdk.Server(
        { name: 'AI-KM PostgreSQL (只读查询)', version: '0.1.0' },
        { capabilities: { tools: {} } }
      )
      const tools = toolDefinitions()
      server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
        const toolName = String(req?.params?.name || '')
        const args = req?.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}
        try {
          const text = await executeTool(toolName, args)
          return { content: [{ type: 'text', text }] }
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `查询失败：${err?.message || String(err)}` }] }
        }
      })
      sharedServer = server
      return server
    })()
  }
  return sharedServerReady
}

/**
 * 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server。
 * `config.env` 每次连接都会刷新到运行时设置（设置页改完 env 重新连接即生效）。
 */
export async function createLocalServerPair(config?: any): Promise<{ server: any; clientTransport: any }> {
  setRuntimeEnv(config?.env)
  const sdk = await getServerSdk()
  const server = await ensureServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

/** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server */
export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

export const postgresService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames: () => toolDefinitions().map((t: any) => t.name),
  /** 直接执行某个工具（调试 / 自动化测试用，跳过 MCP 传输层） */
  executeTool,
  /** 释放数据库连接（退出应用时调用） */
  closeAll,
  setRuntimeEnv,
  resolveSettings,
  /** 注入跨会话持久缓存文件（主进程用 userData 路径调用；不调用则仅内存缓存） */
  setResolveCacheFile,
}
