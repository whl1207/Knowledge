/**
 * clientEventBus.selftest.ts — 「插件重载不会多出一个监听器」的行为级验证（T5 不变式）
 *
 * 背景：这条不变式原先只能靠人读 runtime.ts 确认（它牵着 Vue 与平台桥，没法在 Node 下跑）。
 * 现在总线抽成无依赖模块，可以真的实例化、真的跑 50 轮装载/卸载来验。
 *
 * 同时用**故意写坏的实现**（按插件 id 分桶、撤销不清理）跑同一套探针，证明这套检查不是恒真
 * —— 一个永远通过的测试等于没有测试。
 *
 * 用法：`node scripts/run-selftests.mjs clientEventBus`
 */
import { ClientEventBus } from './clientEventBus'

export interface ClientEventBusCase {
  name: string
  ok: boolean
  detail?: string
}

/** 探针只依赖这四件事，好让"坏实现"也能套同一套检查 */
interface BusLike {
  on(type: string, listener: (payload: unknown) => void): () => void
  emit(type: string, payload: unknown): void
  listenerCount(type?: string): number
  topicCount(): number
}

/**
 * 模拟 cycles 轮「装载 → 卸载」：每轮为每个插件订阅 topics 个 topic，然后全部撤销。
 * 返回基线与终态的监听器数 / topic 桶数。
 */
function runReloadCycles(bus: BusLike, plugins: string[], topics: string[], cycles: number) {
  const base = { listeners: bus.listenerCount(), topics: bus.topicCount() }
  for (let c = 0; c < cycles; c++) {
    const offs: Array<() => void> = []
    for (const plugin of plugins) {
      for (const topic of topics) {
        // 真实实现在这里用 `emit(`${plugin}/${topic}`)` 做过滤 —— 过滤发生在**事件名**上，
        // 而不是在注册表的键上。这正是"按构造不会漏"的来源。
        offs.push(bus.on(`${plugin}/${topic}`, () => {}))
      }
    }
    for (const off of offs.reverse()) off()
  }
  return { base, after: { listeners: bus.listenerCount(), topics: bus.topicCount() } }
}

/**
 * 故意写坏的实现：按插件 id 分桶、撤销是空操作（模拟"忘了清理"）。
 * 它在同一套探针下**必须**被判为不合规。
 */
class LeakyPluginKeyedBus implements BusLike {
  private byPlugin = new Map<string, Set<string>>()
  on(type: string, _listener: (payload: unknown) => void): () => void {
    const [plugin, topic] = type.split('/')
    let set = this.byPlugin.get(plugin)
    if (!set) {
      set = new Set()
      this.byPlugin.set(plugin, set)
    }
    set.add(topic)
    return () => {
      /* 忘了清理 */
    }
  }
  emit(): void {
    /* 与本次探针无关 */
  }
  listenerCount(): number {
    let n = 0
    for (const set of this.byPlugin.values()) n += set.size
    return n
  }
  topicCount(): number {
    return this.byPlugin.size
  }
}

export function runClientEventBusSelfTest(): ClientEventBusCase[] {
  const cases: ClientEventBusCase[] = []

  // 核心不变式：50 轮 × 3 插件 × 2 topic 之后，两条计数都回到基线
  const bus = new ClientEventBus()
  const { base, after } = runReloadCycles(bus, ['a', 'b', 'c'], ['tick', 'done'], 50)
  cases.push({
    name: '不变式：50 轮装载/卸载后监听器与 topic 桶都回到基线',
    ok: after.listeners === base.listeners && after.topics === base.topics,
    detail: `基线 ${base.listeners}/${base.topics} → 终态 ${after.listeners}/${after.topics}（期望 0/0）`,
  })

  // I1：emit 不创建条目（任意 topic 名撒不出一堆空桶）
  const b2 = new ClientEventBus()
  for (let i = 0; i < 1000; i++) b2.emit(`plugin-x/topic-${i}`, i)
  cases.push({
    name: 'I1：emit 未知 topic 不创建条目（1000 个不同 topic 名也不长）',
    ok: b2.listenerCount() === 0 && b2.topicCount() === 0,
    detail: `listeners=${b2.listenerCount()} topics=${b2.topicCount()}（期望 0/0）`,
  })

  // I1b：撤销后空桶要被回收，否则「注册过又撤销」的 topic 会永久占位
  const b3 = new ClientEventBus()
  const off3 = b3.on('tmp/topic', () => {})
  const midTopics = b3.topicCount()
  off3()
  cases.push({
    name: 'I1b：撤销最后一个监听器后空桶被回收',
    ok: midTopics === 1 && b3.topicCount() === 0,
    detail: `订阅时 topics=${midTopics}（期望 1）→ 撤销后 topics=${b3.topicCount()}（期望 0）`,
  })

  // I2：撤销是精确且幂等的（重复撤销不误删别人的监听器）
  const b4 = new ClientEventBus()
  const keep: Array<[string, unknown]> = []
  const offA = b4.on('s/t', (p) => keep.push(['A', p]))
  b4.on('s/t', (p) => keep.push(['B', p]))
  offA()
  offA() // 幂等：第二次调用不能把 B 也删掉
  b4.emit('s/t', 1)
  cases.push({
    name: 'I2：撤销精确且幂等 —— 重复撤销不会误删另一个插件的监听器',
    ok: b4.listenerCount() === 1 && keep.length === 1 && keep[0][0] === 'B',
    detail: `剩余监听器 ${b4.listenerCount()}（期望 1），收到事件 ${JSON.stringify(keep)}（期望只有 B）`,
  })

  // 隔离：一个监听器抛错不打断其余监听器，也不冒泡
  const b5 = new ClientEventBus()
  const seen: string[] = []
  b5.on('s/t', () => {
    throw new Error('boom')
  })
  b5.on('s/t', () => seen.push('ok'))
  let threw = false
  // 这条用例**故意**触发 bus 的错误分支；临时收走 console.error，免得自测输出里出现看似失败的报错
  const realError = console.error
  console.error = () => {}
  try {
    b5.emit('s/t', null)
  } catch {
    threw = true
  } finally {
    console.error = realError
  }
  cases.push({
    name: '隔离：单监听器抛错不影响其余监听器，也不冒泡给宿主',
    ok: !threw && seen.length === 1,
    detail: `冒泡=${threw}（期望 false）已收到=${seen.length}（期望 1）`,
  })

  // meta：同一套探针在"按插件 id 分桶 + 不清理"的坏实现上必须判不合规（证明检查非恒真）
  const leaky = new LeakyPluginKeyedBus()
  const leakyResult = runReloadCycles(leaky, ['a', 'b', 'c'], ['tick', 'done'], 50)
  const leakyOk =
    leakyResult.after.listeners === leakyResult.base.listeners &&
    leakyResult.after.topics === leakyResult.base.topics
  cases.push({
    name: 'meta: 同一探针能把「按插件 id 分桶且不清理」的实现判为泄漏',
    ok: !leakyOk,
    detail: `坏实现基线 ${leakyResult.base.listeners}/${leakyResult.base.topics} → 终态 ${leakyResult.after.listeners}/${leakyResult.after.topics}（应增长，故探针判不合规）`,
  })

  // meta：证明"过滤发生在事件名上"确实能隔离插件（不会串台）
  const b6 = new ClientEventBus()
  const inbox: string[] = []
  b6.on('pluginA/tick', () => inbox.push('A'))
  b6.on('pluginB/tick', () => inbox.push('B'))
  b6.emit('pluginB/tick', null)
  cases.push({
    name: 'meta: 以 `<pluginId>/<topic>` 命名事件时插件之间不串台',
    ok: inbox.length === 1 && inbox[0] === 'B',
    detail: `收到 ${JSON.stringify(inbox)}（期望只收到 B）`,
  })

  return cases
}

/** 命令行入口 */
export function logClientEventBusSelfTest(): boolean {
  const cases = runClientEventBusSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
