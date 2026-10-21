/**
 * snapshot.selftest.ts — AX 树 → 紧凑文本 + ref（用假 CDP）
 *
 * 覆盖：URL/标题、ref 分配、文本省略/去重、iframe 计数、maxRefs/maxChars 截断。
 * runner 支持 run* 返回 Promise<cases>（见 scripts/run-selftests.mjs）。
 */
import { captureSnapshot } from './snapshot'

export interface BrowserSnapshotCase {
  name: string
  ok: boolean
  detail?: string
}

function axNode(nodeId: string, role: string, name: string, opts: any = {}) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    childIds: opts.children || [],
    ...(opts.backendDOMNodeId != null ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
    ...(opts.properties ? { properties: opts.properties } : {}),
  }
}

function fakeCdp(nodes: any[], frameCount = 1) {
  return {
    async send(method: string, params: any = {}) {
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression || '')
        if (expr.includes('scrollX')) return { result: { value: { x: 0, y: 0, w: 800, h: 600 } } }
        return { result: { value: { url: 'https://example.com/x', title: 'Example' } } }
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [{
            nodes: [{ backendNodeId: 21 }, { backendNodeId: 22 }],
            layout: { nodeIndex: [0, 1], bounds: [[0, 0, 120, 30], [-2000, 0, 10, 10]] },
          }],
        }
      }
      if (method === 'Page.getFrameTree') {
        const childFrames = frameCount > 1 ? [{ frame: { id: 'child' } }] : []
        return { frameTree: { frame: { id: 'main' }, childFrames } }
      }
      if (method === 'DOM.getBoxModel') return { model: { border: [10, 10, 110, 10, 110, 40, 10, 40] } }
      return {}
    },
    on() { return () => {} },
  } as any
}

export async function runBrowserSnapshotSelfTest(): Promise<BrowserSnapshotCase[]> {
  const cases: BrowserSnapshotCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })
  const nodes = [
    axNode('1', 'RootWebArea', '', { children: ['2', '3', '4', '5', '6', '7'] }),
    axNode('2', 'heading', 'Welcome', { backendDOMNodeId: 20 }),
    axNode('3', 'StaticText', 'Some body text'),
    axNode('4', 'button', 'Go', { backendDOMNodeId: 21, children: ['4a'] }),
    axNode('4a', 'StaticText', 'Go'),
    axNode('5', 'textbox', 'Email', { backendDOMNodeId: 22, properties: [{ name: 'required', value: { value: true } }] }),
    axNode('6', 'StaticText', '   '),
    axNode('7', 'Iframe', 'payment', { backendDOMNodeId: 23 }),
  ]

  const snap = await captureSnapshot(fakeCdp(nodes, 2), { maxChars: 4000, maxRefs: 10 })
  add('提取 url/title', snap.url === 'https://example.com/x' && snap.title === 'Example')
  add('可交互节点有 ref', /button "Go" \[ref=1/.test(snap.text), snap.text)
  add('textbox 有 ref', /textbox "Email" \[ref=2/.test(snap.text))
  add('heading 无 ref', /heading "Welcome"/.test(snap.text) && !/heading "Welcome" \[ref/.test(snap.text))
  add('空白文本被省略', !/^\s*text ""/m.test(snap.text))
  add('按钮子文本去重', (snap.text.match(/button "Go"/g) || []).length === 1)
  add('iframe 计数提示', snap.frameCount === 2 && snap.text.includes('子 frame'))
  add('ref 数量正确', snap.refs.size === 2, `refs=${snap.refs.size}`)
  add('ref 映射 backendNodeId', snap.refs.get(1)?.backendNodeId === 21 && snap.refs.get(2)?.backendNodeId === 22)

  const small = await captureSnapshot(fakeCdp(nodes, 1), { maxRefs: 1, maxChars: 4000 })
  add('maxRefs 截断', small.truncated === true && small.refs.size === 1, `truncated=${small.truncated} refs=${small.refs.size}`)

  const tiny = await captureSnapshot(fakeCdp(nodes, 1), { maxChars: 1000 })
  add('maxChars 生效', tiny.text.length < 1200, `len=${tiny.text.length}`)

  const dupNodes = [
    axNode('1', 'RootWebArea', '', { children: ['2', '3'] }),
    axNode('2', 'button', 'Save', { backendDOMNodeId: 31 }),
    axNode('3', 'button', 'Save', { backendDOMNodeId: 32 }),
  ]
  const dup = await captureSnapshot(fakeCdp(dupNodes, 1), { maxChars: 4000 })
  add('同名节点不输出 locator（唯一性证明）', dup.refs.size === 2 && !dup.text.includes('loc='), dup.text)

  const inter = await captureSnapshot(fakeCdp(nodes, 1), { interactiveOnly: true, maxChars: 4000 })
  add('interactiveOnly 只留可交互节点', inter.refs.size === 2 && !inter.text.includes('Some body text') && inter.text.includes('button "Go"'), inter.text)

  const sub = await captureSnapshot(fakeCdp(nodes, 1), { rootBackendNodeId: 21, maxChars: 4000 })
  add('subtree 只渲染指定子树', sub.refs.size === 1 && sub.text.includes('button "Go"') && !sub.text.includes('Welcome'), sub.text)

  const vp = await captureSnapshot(fakeCdp(nodes, 1), { viewportOnly: true, maxChars: 4000 })
  add('viewport 过滤视口外节点', vp.refs.size === 1 && vp.text.includes('button "Go"') && !vp.text.includes('Email'), vp.text)

  const oopif = await captureSnapshot(fakeCdp(nodes, 1), {
    maxChars: 4000,
    oopifFrames: [{
      token: '1:2', frameId: 'f1', url: 'https://pay.example/frame', offsetX: 10, offsetY: 20,
      executeJavaScript: async () => [{ role: 'button', name: 'Pay', selector: '#pay', x: 5, y: 5, w: 100, h: 30, disabled: false, tag: 'button' }],
    }],
  })
  const frameEntry = [...oopif.refs.values()].find((r) => r.frame)
  add('OOPIF 补充跨域 frame 交互节点', !!frameEntry && frameEntry.name === 'Pay' && oopif.text.includes('iframe "https://pay.example/frame"'), oopif.text)
  add('OOPIF ref 带 frame 偏移/selector', frameEntry?.frame?.offsetX === 10 && frameEntry?.frame?.selector === '#pay')

  return cases
}
