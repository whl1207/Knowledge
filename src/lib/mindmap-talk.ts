/**
 * 思维导图「讲解 / 演示」模式的页内结构规则（纯函数，便于单测与复用）
 *
 * 讲解模式把每个标题分成一“页”：以该标题为新的页根，页内**固定只展示两层**——
 * 第 1 层 = 焦点标题，第 2 层 = 它的直接子节点。
 *
 * 为什么是「折叠第 2 层」而不是「限制画布深度」：markmap 只能靠 `payload.fold`
 * （折叠父节点）来隐藏子树，节点是叶子时 fold 无效。所以要刚好看到两层，
 * 就把第 2 层里有子节点的节点折叠起来：它们显示为带实心圆点的“可下钻入口”，
 * 再深一层的内容不会一次铺开；第 2 层里的正文/图片叶子照常显示。
 */

/** 讲解页固定展示的层数：1 = 焦点标题，2 = 它的直接子节点 */
export const TALK_PAGE_DEPTH = 2

/**
 * 预置讲解页的页内折叠（原地修改 payload.fold）。
 *
 * @param focus 页根（当前讲解步骤对应的标题节点）
 * @param pageDepth 页内展示层数，默认 {@link TALK_PAGE_DEPTH}
 */
export function prepareTalkPage(focus: any, pageDepth: number = TALK_PAGE_DEPTH): void {
  if (!focus) return
  // 页根自身必须展开：上一页可能把它折叠过（它曾是上一页的第 2 层节点），
  // 否则 setData 后整页只剩焦点一个节点
  focus.payload = { ...focus.payload, fold: 0 }
  const walk = (n: any, depth: number) => {
    for (const c of (n && n.children) || []) {
      const cd = depth + 1 // 相对页根的深度：1 = 焦点，2 = 第二层…
      c.payload = {
        ...c.payload,
        // 达到展示层数的节点（有子节点）一律收成入口；无子节点的叶子不受 fold 影响
        fold: cd >= pageDepth && c.children && c.children.length ? 1 : 0,
      }
      walk(c, cd)
    }
  }
  walk(focus, 1)
}
