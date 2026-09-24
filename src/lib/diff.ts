/**
 * 轻量级文本 Diff 工具
 *
 * 用于“AI 修改对比”等场景：计算两段文本的差异，
 * 支持行级分组（equal / delete / add）与字符级细粒度对比。
 *
 * 算法：Myers O(ND)（公共前缀/后缀裁剪 + 大输入回退），
 * 足够轻量，无需引入第三方依赖。
 */

export type DiffOp =
    | { type: 'equal'; lines: string[] }
    | { type: 'delete'; lines: string[] }
    | { type: 'add'; lines: string[] }

export interface DiffStats {
    added: number
    removed: number
}

/** 按换行符切分文本；空文本返回空数组（而非 [""]） */
const splitLines = (text: string): string[] => {
    if (!text) return []
    return text.split(/\r\n|\r|\n/)
}

/**
 * Myers 算法：返回逐行编辑序列（eq/del/add）
 * 内部使用，返回原始逐行操作
 */
function myersDiff<T>(a: T[], b: T[]): Array<{ op: 'eq' | 'del' | 'add'; t: T }> {
    const n = a.length
    const m = b.length
    const max = n + m

    // 前向计算：记录每条对角线在每一步的 x 值，用于回溯
    const trace: Map<number, number>[] = []
    const v = new Map<number, number>()
    v.set(1, 0)
    let done = false

    outer: for (let d = 0; d <= max; d++) {
        trace.push(new Map(v))
        for (let k = -d; k <= d; k += 2) {
            let x: number
            const down =
                k === -d ||
                (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))
            if (down) {
                x = v.get(k + 1) ?? 0
            } else {
                x = (v.get(k - 1) ?? 0) + 1
            }
            let y = x - k
            // 沿对角线推进相同内容
            while (x < n && y < m && a[x] === b[y]) {
                x++
                y++
            }
            v.set(k, x)
            if (x >= n && y >= m) {
                done = true
                break outer
            }
        }
    }

    // 回溯构造编辑序列
    const ops: Array<{ op: 'eq' | 'del' | 'add'; t: T }> = []
    let x = n
    let y = m
    for (let d = trace.length - 1; d >= 0; d--) {
        const vv = trace[d]
        const k = x - y
        const down =
            k === -d || (k !== d && (vv.get(k - 1) ?? -Infinity) < (vv.get(k + 1) ?? -Infinity))
        const prevK = down ? k + 1 : k - 1
        const prevX = vv.get(prevK) ?? 0
        const prevY = prevX - prevK
        // 对角线上相同内容
        while (x > prevX && y > prevY) {
            ops.push({ op: 'eq', t: a[x - 1] })
            x--
            y--
        }
        if (d === 0) break
        if (x === prevX) {
            // 从 b 中新增
            ops.push({ op: 'add', t: b[y - 1] })
            y--
        } else {
            // 从 a 中删除
            ops.push({ op: 'del', t: a[x - 1] })
            x--
        }
    }
    return ops.reverse()
}

/** 将连续同类型的逐行操作合并为分组操作 */
function groupOps<T>(raw: Array<{ op: 'eq' | 'del' | 'add'; t: T }>): Array<{
    type: 'equal' | 'delete' | 'add'
    lines: T[]
}> {
    const result: Array<{ type: 'equal' | 'delete' | 'add'; lines: T[] }> = []
    for (const r of raw) {
        const type = r.op === 'eq' ? 'equal' : r.op === 'del' ? 'delete' : 'add'
        const last = result[result.length - 1]
        if (last && last.type === type) {
            last.lines.push(r.t)
        } else {
            result.push({ type, lines: [r.t] })
        }
    }
    return result
}

/** 大输入时 Myers 的最坏情况保护阈值（行数乘积） */
const LINE_DIFF_LIMIT = 4_000_000

/** 计算两段文本的行级差异（保留原始与修改后的行内容） */
export function diffLines(original: string, modified: string): DiffOp[] {
    const a = splitLines(original)
    const b = splitLines(modified)

    // 裁剪公共前缀
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    // 裁剪公共后缀
    let endA = a.length
    let endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--
        endB--
    }

    const midA = a.slice(start, endA)
    const midB = b.slice(start, endB)

    const raw: Array<{ op: 'eq' | 'del' | 'add'; t: string }> = []
    for (let i = 0; i < start; i++) raw.push({ op: 'eq', t: a[i] })

    if (midA.length === 0 && midB.length === 0) {
        // 完全一致
    } else if (midA.length === 0) {
        for (const t of midB) raw.push({ op: 'add', t })
    } else if (midB.length === 0) {
        for (const t of midA) raw.push({ op: 'del', t })
    } else if (midA.length * midB.length <= LINE_DIFF_LIMIT) {
        raw.push(...myersDiff(midA, midB))
    } else {
        // 超大差异回退：整段视为替换
        for (const t of midA) raw.push({ op: 'del', t })
        for (const t of midB) raw.push({ op: 'add', t })
    }

    for (let i = endA; i < a.length; i++) raw.push({ op: 'eq', t: a[i] })

    return groupOps(raw)
}

/** 计算两段短文本的字符级差异（用于行内高亮） */
export function diffChars(a: string, b: string): DiffOp[] {
    const aa = Array.from(a)
    const bb = Array.from(b)
    if (aa.length === 0 && bb.length === 0) return []
    if (aa.length === 0) return [{ type: 'add', lines: bb }]
    if (bb.length === 0) return [{ type: 'delete', lines: aa }]
    // 字符级一般很短，直接用 Myers（带保护阈值）
    const raw =
        aa.length * bb.length <= 2500
            ? myersDiff(aa, bb)
            : [...aa.map((t) => ({ op: 'del' as const, t })), ...bb.map((t) => ({ op: 'add' as const, t }))]
    return groupOps(raw)
}

/** 统计新增 / 删除的行数 */
export function countStats(ops: DiffOp[]): DiffStats {
    let added = 0
    let removed = 0
    for (const op of ops) {
        if (op.type === 'add') added += op.lines.length
        else if (op.type === 'delete') removed += op.lines.length
    }
    return { added, removed }
}
