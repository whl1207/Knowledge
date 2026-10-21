/**
 * actions.selftest.ts — 元素解析 / 命中测试 / 真实输入序列（用假 CDP）
 *
 * 覆盖：click 派发序列、遮挡报错、fill 真实 insertText、STALE_REF 自动恢复。
 */
import { clickElement, fillElement, resolveElement, BrowserActionError } from './actions'

export interface BrowserActionsCase {
  name: string
  ok: boolean
  detail?: string
}

const refs = new Map([[1, { ref: 1, backendNodeId: 21, role: 'button', name: 'Go' }], [2, { ref: 2, backendNodeId: 22, role: 'textbox', name: 'Email' }]])

function fakeCdp(probeRef: { value: any }) {
  const calls: Array<[string, any]> = []
  const cdp = {
    calls,
    async send(method: string, params: any = {}) {
      calls.push([method, params])
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } }
      if (method === 'DOM.scrollIntoViewIfNeeded') return {}
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '')
        if (fn.includes('elementFromPoint')) return { result: { value: probeRef.value } }
        if (fn.includes('el.value.slice')) return { result: { value: 'hello' } }
        return { result: { value: true } }
      }
      if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://x', title: 'T' } } }
      return {}
    },
    on() { return () => {} },
  }
  return cdp as any
}

const baseProbe: any = {
  visible: true, disabled: false, cx: 100, cy: 50, width: 120, height: 30,
  tag: 'BUTTON', text: 'Go', contains: true, vw: 800, vh: 600,
}

export async function runBrowserActionsSelfTest(): Promise<BrowserActionsCase[]> {
  const cases: BrowserActionsCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  {
    const probeRef = { value: { ...baseProbe } }
    const cdp = fakeCdp(probeRef)
    const r = await clickElement(cdp, refs, { ref: 1 })
    const mouse = cdp.calls.filter(([m]: [string, any]) => m === 'Input.dispatchMouseEvent').map(([, p]: [string, any]) => p.type)
    add('click 派发 moved/pressed/released', JSON.stringify(mouse) === JSON.stringify(['mouseMoved', 'mousePressed', 'mouseReleased']))
    add('click 使用视口中心', cdp.calls.find(([m]: [string, any]) => m === 'Input.dispatchMouseEvent')[1].x === 100)
    add('receipt 含页面地址', r.url === 'https://x')

    probeRef.value = { ...baseProbe, contains: false, hitTag: 'DIV', hitText: 'overlay' }
    try {
      await clickElement(cdp, refs, { ref: 1 })
      add('遮挡应报错', false)
    } catch (e) {
      add('遮挡报 OCCLUDED', e instanceof BrowserActionError && e.code === 'OCCLUDED')
    }
  }

  {
    const probeRef = { value: { ...baseProbe, tag: 'INPUT' } }
    const cdp = fakeCdp(probeRef)
    const r = await fillElement(cdp, refs, { ref: 2 }, 'hello', { clear: true })
    add('fill 发送 insertText', cdp.calls.some(([m, p]: [string, any]) => m === 'Input.insertText' && p.text === 'hello'))
    add('fill 回显当前值', /hello/.test(r.detail), r.detail)
  }

  {
    let call = 0
    const cdp = {
      async send(method: string) {
        if (method === 'DOM.resolveNode') {
          call++
          if (call === 1) throw new Error('No node with given id')
          return { object: { objectId: 'obj-new' } }
        }
        return {}
      },
      on() { return () => {} },
    } as any
    const fresh = new Map([[7, { ref: 7, backendNodeId: 99, role: 'button', name: 'Go' }]])
    const r = await resolveElement(cdp, refs, { ref: 1 }, { refresh: async () => fresh })
    add('STALE_REF 自动恢复 backendNodeId', r.backendNodeId === 99)
    add('自动恢复标记写入 label', /自动刷新/.test(r.label), r.label)
  }

  return cases
}
