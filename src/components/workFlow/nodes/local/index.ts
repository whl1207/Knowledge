/**
 * local executor - 本地文件节点
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const localExecutor: NodeExecutor = {
  type: 'local',
  label: '本地文件节点',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    let filePath = node.prompt

    if (!filePath || filePath.trim() === '' || filePath === ctx.t('drag_file')) {
      const contexts = await ctx.getNodeContextWithPorts(node.id, ctx.decisionPaths)
      for (const context of contexts) {
        try {
          const parsed = JSON.parse(context)
          if (parsed?.filePath) { filePath = parsed.filePath; break }
          if (parsed?.result && typeof parsed.result === 'string') {
            const pm = parsed.result.match(/([A-Za-z]:[\\/][^"\n]*|\/[^"\n]*)/)
            if (pm) { filePath = pm[0]; break }
          }
        } catch { continue }
      }
      if (!filePath || filePath.trim() === '') {
        node.result = JSON.stringify({ result: ctx.t('select_file_or_connect_upstream'), type: 'local', success: false, error: ctx.t('file_path_empty') })
        node.status = 'error'
        ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
        ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
        return false
      }
    }

    try {
      const content = await ctx.readFile(filePath)
      const fileMode = node.fileMode || 'full'

      if (fileMode === 'full') {
        const ext = '.' + filePath.split('.').pop()?.toLowerCase()
        node.result = JSON.stringify({ type: 'local', success: true, mode: 'full', filePath, filename: filePath.split('/').pop() || filePath.split('\\').pop(), extension: ext, content, result: content, timestamp: new Date().toISOString() })
        node.model = ext
      } else if (fileMode === 'template') {
        const templates = node.fileTemplates || []
        if (templates.length === 0) {
          node.result = JSON.stringify({ result: ctx.t('configure_templates'), type: 'local', success: false, error: ctx.t('no_templates') })
          node.status = 'error'
          ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
          ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
          return false
        }

        const imagePatterns = [
          /data:image\/(?:png|jpeg|jpg|gif|bmp|webp|svg\+xml);base64,[a-zA-Z0-9+/]+={0,2}/gi,
          /\bhttps?:\/\/\S+\.(?:jpg|jpeg|png|gif|bmp|webp|svg)\b/gi,
          /\b[a-zA-Z]:[\\/][^\\/]+\.(?:jpg|jpeg|png|gif|bmp|webp|svg)\b/gi,
          /\/(?:[^\/]+\/)*[^\/]+\.(?:jpg|jpeg|png|gif|bmp|webp|svg)\b/gi,
          /!\[[^\]]*\]\([^)]+\.(?:jpg|jpeg|png|gif|bmp|webp|svg)\)/gi,
          /<img[^>]+src=["'][^"']+\.(?:jpg|jpeg|png|gif|bmp|webp|svg)["'][^>]*>/gi
        ]
        let filteredContent = content
        imagePatterns.forEach(p => { filteredContent = filteredContent.replace(p, ctx.t('image_filtered')) })
        filteredContent = filteredContent.replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/gi, ctx.t('image_filtered_markdown'))
        filteredContent = filteredContent.replace(/<img[^>]+src=["']data:image\/[^"']+["'][^>]*>/gi, '<img src="' + ctx.t('image_filtered') + '">')

        const allMatches: Array<{ templateIndex: number; templateName: string; pattern: string; start: number; text: string }> = []
        templates.forEach((template, ti) => {
          if (!template.pattern.trim()) return
          try {
            const regex = new RegExp(template.pattern, 'g'); let match
            while ((match = regex.exec(filteredContent)) !== null) allMatches.push({ templateIndex: ti, templateName: template.name, pattern: template.pattern, start: match.index, text: match[0] })
          } catch { /* ignore regex errors */ }
        })
        allMatches.sort((a, b) => a.start - b.start)

        const slices: Record<string, string> = {}
        const allPositions = allMatches.map(m => m.start)

        templates.forEach((template, ti) => {
          const tm = allMatches.filter(m => m.templateIndex === ti).sort((a, b) => a.start - b.start)
          if (tm.length === 0) { slices[`output${ti+1}`] = ''; return }
          tm.forEach((match, mi) => {
            const start = match.start + match.text.length
            const nextPositions = allPositions.filter(p => p > match.start)
            const end = nextPositions.length > 0 ? nextPositions[0] : filteredContent.length
            slices[`output${ti+1}`] = (slices[`output${ti+1}`] || '') + filteredContent.substring(start, end).trim() + '\n\n'
          })
          slices[`output${ti+1}`] = slices[`output${ti+1}`].trim()
        })

        const outputByPort: Record<string, string> = { default: filteredContent }
        templates.forEach((t, i) => {
          const portId = `output${i+1}`
          outputByPort[portId] = slices[portId] || ''
          if (node.outputPorts) {
            const portCfg = node.outputPorts.ports.find(p => p.id === portId)
            if (portCfg) portCfg.data = slices[portId] || ''
          }
        })

        node.result = JSON.stringify({ type: 'local', success: true, mode: 'template', filePath, content: filteredContent, slices, outputByPort, result: Object.values(slices).filter(Boolean).join('\n\n---\n\n'), timestamp: new Date().toISOString() })
      }

      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      node.result = JSON.stringify({ result: `${ctx.t('file_read_error')}: ${error.message}`, type: 'local', success: false, error: error.message, filePath })
      node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
