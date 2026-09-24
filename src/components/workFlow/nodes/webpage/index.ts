/**
 * webpage executor - 网页节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'
import { extractMainContent } from '@/components/workFlow/engine/executorHelpers'
import { isBotChallengePage, extractDoiFromUrl, fetchDoiViaCrossref } from '@/shared/webFetchHelpers'

export const webpageExecutor: NodeExecutor = {
  type: 'webpage',
  label: '网页节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.prompt || node.prompt.trim() === '' || node.prompt === 'https://') {
      node.result = ctx.t('enter_url'); node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    try {
      let url = ctx.resolveTemplate(node.prompt.trim(), node.id)
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url
      ctx.log(`正在获取网页: ${url}`, 'info')

      const opts = node.webpageOptions || {}
      const visitMode = opts.visitMode || 'single'
      const includeLinks = opts.includeLinks !== false
      const maxPages = Math.max(1, opts.maxPages ?? 1)
      const sameDomainOnly = opts.sameDomainOnly !== false
      const strategy = (opts.mainContentStrategy || 'textDensity') as 'simple' | 'textDensity' | 'readability'
      const patternTemplate = (opts.patternTemplate || '').trim()
      const patternStart = Number.isFinite(Number(opts.patternStart)) ? Number(opts.patternStart) : 1
      const patternEnd = Number.isFinite(Number(opts.patternEnd)) ? Number(opts.patternEnd) : 1
      const patternStep = Math.max(1, Number(opts.patternStep ?? 1))

      const visitedUrls = new Set<string>()
      const pages: Array<{ url: string; contentType: string; rawContent: string; filteredContent: string; links: Array<{ text: string; url: string }> }> = []
      const queue: string[] = []
      let startOrigin: string | null = null

      const normalizeUrl = (href: string, base: string): string | null => {
        try { return new URL(href, base).href } catch { return null }
      }

      if (visitMode === 'pattern') {
        if (!patternTemplate || !patternTemplate.includes('{}')) throw new Error(ctx.t('invalid_link_pattern'))
        if (patternEnd < patternStart) throw new Error(ctx.t('invalid_pattern_range'))
        for (let i = patternStart; i <= patternEnd && queue.length < maxPages; i += patternStep) queue.push(patternTemplate.replace('{}', String(i)))
      } else { queue.push(url) }

      const followLinks = visitMode === 'followLinks'
      let challengeHit = false

      while (queue.length > 0 && pages.length < maxPages) {
        const currentUrl = queue.shift()!
        if (visitedUrls.has(currentUrl)) continue
        visitedUrls.add(currentUrl)

        if (!startOrigin) { try { startOrigin = new URL(currentUrl).origin } catch { startOrigin = null } }

        const response = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          redirect: 'follow'
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

        const contentType = response.headers.get('content-type') || ''
        let content: string
        if (contentType.includes('application/json')) { const json = await response.json(); content = JSON.stringify(json, null, 2) }
        else { content = await response.text() }

        if (!content || content.trim() === '') throw new Error(ctx.t('empty_content'))

        // 反爬验证页检测：命中时依次尝试
        //  1) DOI 链接 → Crossref 降级获取元数据；
        //  2) 主进程 web_fetch（无头 Chromium 可执行 JS 通过验证）。
        //  全部失败则跳过该页。
        if (isBotChallengePage(content)) {
          challengeHit = true
          let recovered = ''
          const doi = extractDoiFromUrl(currentUrl)
          if (doi) {
            ctx.log(`检测到目标站点人机验证，改用 Crossref 获取 DOI 元数据: ${doi}`, 'info')
            recovered = await fetchDoiViaCrossref(doi)
          }
          if (!recovered) {
            // 非 DOI 或 Crossref 失败：尝试主进程无头浏览器（可过 JS 验证），复用 web_fetch 工具
            try {
              const res = await ctx.safeIpcInvoke('tools:execute', { name: 'web_fetch', input: { url: currentUrl } })
              const toolResult = (res && typeof res === 'object' && 'data' in res) ? res.data : res
              const text = toolResult?.ok ? String(toolResult.value?.text || '') : ''
              if (text && !isBotChallengePage(text)) recovered = text
            } catch { /* 主进程通道失败则跳过 */ }
          }
          if (recovered) {
            pages.push({ url: currentUrl, contentType, rawContent: content, filteredContent: recovered, links: [] })
            continue
          }
          ctx.log(`目标站点需要人机验证，跳过该页: ${currentUrl}`, 'warning')
          continue
        }

        const result = extractMainContent(content, strategy, currentUrl)
        pages.push({ url: currentUrl, contentType, rawContent: content, filteredContent: result.content, links: result.links })

        if (followLinks && pages.length < maxPages) {
          for (const link of result.links) {
            if (visitedUrls.has(link.url)) continue
            if (sameDomainOnly && startOrigin) { try { if (new URL(link.url).origin !== startOrigin) continue } catch { continue } }
            queue.push(link.url)
          }
        }
      }

      if (pages.length === 0) {
        throw new Error(challengeHit
          ? (ctx.t('challenge_blocked') || '目标站点需要人机验证，无法直接获取内容')
          : ctx.t('empty_content'))
      }

      const aggregatedContent = pages.map(p => `${p.url} ===\n${p.filteredContent}`).join('\n\n')
      const allLinks: Array<{ text: string; url: string }> = []
      if (includeLinks) { for (const p of pages) { for (const l of p.links) { if (!allLinks.find(x => x.url === l.url)) allLinks.push(l) } } }

      // 抓取正文写入运行日志（内层子图 onNodeComplete 不转发，只能靠 ctx.log 透出）
      ctx.log(`网页 ${pages[0]?.url || url} 获取完成（${pages.length} 页，${aggregatedContent.length} 字符）:\n${aggregatedContent.slice(0, 800)}${aggregatedContent.length > 800 ? '\n...（内容已截断）' : ''}`, 'info')

      node.result = JSON.stringify({
        result: aggregatedContent, url: node.prompt.trim(), timestamp: new Date().toISOString(),
        pageCount: pages.length, pages: pages.map(p => ({ url: p.url, length: p.filteredContent.length, rawLength: p.rawContent.length, contentType: p.contentType })),
        links: includeLinks ? allLinks.slice(0, 100) : undefined, includeLinks, followLinks, maxPages, sameDomainOnly, strategy,
        contentType: pages.length === 1 ? pages[0].contentType : 'multiple',
        length: aggregatedContent.length, rawLength: pages.reduce((s, p) => s + p.rawContent.length, 0)
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      ctx.log(`网页获取失败: ${error.message}`, 'error')
      node.result = JSON.stringify({ result: `${ctx.t('fetch_error')}: ${error.message}`, url: node.prompt.trim(), timestamp: new Date().toISOString(), error: error.message })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
