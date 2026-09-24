/**
 * src/lib/kbFile.ts — 知识库（knowRAG）文件级通用工具
 *
 * 无状态纯函数集：文件类型判定 / 规范化路径 / 展示格式化 / Markdown 预处理。
 * 由 knowRAG.vue 主面板及其视图子组件（fileView 等）共享，
 * 避免同一逻辑在组件间重复定义或经由 props 层层下传。
 * 组件状态相关的判断（如 hasCorrespondingMd / isMissingMd）以「文件列表」作参数传入，保持纯函数。
 */

/** 是否为 PDF（按扩展名） */
export function isPdfFile(extension: string | undefined | null): boolean {
    return extension?.toLowerCase() === '.pdf'
}

/** 是否为 Word 文档（.docx / .doc） */
export function isWordFile(extension: string | undefined | null): boolean {
    const e = extension?.toLowerCase()
    return e === '.docx' || e === '.doc'
}

/** 是否为图片（按扩展名；接受带前导点或纯扩展名） */
export function isImageFile(extension: string | undefined | null): boolean {
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif']
        .includes(extension?.toLowerCase().replace(/^\./, '') || '')
}

/** 是否为音视频等媒体文件 */
export function isMediaFile(extension: string | undefined | null): boolean {
    return ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'rm', 'rmvb', 'vob', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'mid', 'midi', 'amr']
        .includes(extension?.toLowerCase().replace(/^\./, '') || '')
}

/** 去除 Markdown 正文顶部的 YAML frontmatter（--- ... ---），返回纯正文 */
export function stripFrontmatter(content: string): string {
    if (!content || typeof content !== 'string') return content
    const fmRegex = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/
    if (fmRegex.test(content)) {
        return content.replace(fmRegex, '').replace(/^\s+/, '')
    }
    return content
}

/** 把任意文件路径的扩展名替换为 .md（无扩展名则直接追加 .md），用于查找同名的规范化目标 */
export function mdPathOf(filePath: string): string {
    const slashIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    const dotIdx = filePath.lastIndexOf('.')
    if (dotIdx > slashIdx) {
        return filePath.slice(0, dotIdx) + '.md'
    }
    return filePath + '.md'
}

/** 知识库侧车文件（.kb 本体 / .learning 学习记录）：不应作为普通可切片文档进入文件视图 */
export function isKbSidecarFile(path?: string | null): boolean {
    const p = (path || '').toLowerCase()
    return p.endsWith('.kb') || p.endsWith('.learning') || p.endsWith('.learning.json')
}

/** PDF/Word/图片 是否已规范化：给定文件列表中已存在同名 .md 文档 */
export function hasCorrespondingMd(file: any, fileList: any[]): boolean {
    const ext = (file?.extension || '').toLowerCase()
    if (!isPdfFile(ext) && !isWordFile(ext) && !isImageFile(ext)) return false
    const targetPath = mdPathOf(file?.path || '')
    return fileList.some((f: any) =>
        (f.extension || '').toLowerCase() === '.md' && f.path === targetPath
    )
}

/** PDF/Word/图片 是否缺少同名 .md 文档（需要规范化，列表中红色标出） */
export function isMissingMd(file: any, fileList: any[]): boolean {
    const ext = (file?.extension || '').toLowerCase()
    if (!isPdfFile(ext) && !isWordFile(ext) && !isImageFile(ext)) return false
    return !hasCorrespondingMd(file, fileList)
}

/** 格式化文件大小（字节 → B / KB / MB / GB / TB） */
export function formatSize(size?: number | null): string {
    if (size == null || size < 0) return ''
    if (size < 1024) return size + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = size / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return value.toFixed(1) + ' ' + units[i]
}

/** 格式化修改时间（时间戳 → yyyy-MM-dd HH:mm） */
export function formatTime(mtime?: number | null): string {
    if (!mtime) return ''
    const d = new Date(mtime)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
