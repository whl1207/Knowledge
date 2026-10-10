/**
 * mediaMeta.ts — 音视频媒体元信息（知识管理列表缩略图 + 音频播放器共用）
 *
 * 收拢三处容易被写歪的逻辑，保证「列表里的封面」和「播放器里的封面/歌词」表现一致：
 *  - 音视频扩展名判定；
 *  - 内嵌标签解析（MP3 等的 ID3v2、FLAC 的 Vorbis comment / PICTURE 块），纯字节解析，不依赖第三方库；
 *  - LRC 时间轴解析（内置歌词与外挂 .lrc 都是同一套格式）。
 */

/** 音频扩展名（小写） */
export const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff']
/** 视频扩展名（小写） */
export const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg']

/** 是否为音频扩展名（入参需已小写或以任意大小写传入） */
export function isAudioExt(ext: string): boolean {
  return AUDIO_EXTS.includes(String(ext || '').toLowerCase())
}

/** 是否为视频扩展名 */
export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.includes(String(ext || '').toLowerCase())
}

/** 是否为音视频扩展名 */
export function isMediaExt(ext: string): boolean {
  return isAudioExt(ext) || isVideoExt(ext)
}

/** 歌词行；time < 0 表示该行没有时间戳（纯文本歌词，不参与高亮/滚动） */
export interface LyricLine {
  time: number
  text: string
}

/** 读取 ID3v2 标签头，返回 { major, tagEnd }；非 ID3v2 返回 null */
function readId3Header(bytes: Uint8Array): { major: number; tagEnd: number } | null {
  if (bytes.length < 10) return null
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null // "ID3"
  const major = bytes[3]
  if (major !== 2 && major !== 3 && major !== 4) return null
  // 标签体大小（syncsafe）
  const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
  return { major, tagEnd: Math.min(bytes.length, 10 + tagSize) }
}

/** 遍历 ID3v2 帧，命中 targetId 时回调（回调返回 true 即停止遍历） */
function eachFrame(
  bytes: Uint8Array,
  major: number,
  tagEnd: number,
  targetId: string,
  cb: (start: number, end: number) => boolean
): void {
  let pos = 10
  while (pos + 10 <= tagEnd) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
    if (id === '\u0000\u0000\u0000\u0000') break
    let frameSize: number
    if (major === 4) {
      frameSize = ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) | ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f)
    } else {
      frameSize = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]
    }
    const frameStart = pos + 10
    const frameEnd = frameStart + frameSize
    if (frameEnd > tagEnd || frameEnd > bytes.length) break
    if (id === targetId && cb(frameStart, frameEnd)) return
    pos = frameEnd
  }
}

/**
 * 从音频文件提取专辑封面：先试 ID3v2（MP3 等），再试 FLAC。
 * 返回 blob URL（调用方负责 URL.revokeObjectURL 释放）；无封面返回 null。
 */
export function extractAlbumArt(bytes: Uint8Array): string | null {
  const id3 = extractId3AlbumArt(bytes)
  if (id3) return id3
  return extractFlacAlbumArt(bytes)
}

/**
 * 从音频文件提取内置歌词：先试 ID3v2 USLT 帧（MP3 等），再试 FLAC 的 Vorbis comment。
 * 返回歌词原文（可能是 LRC，也可能是纯文本），无歌词返回 null。
 */
export function extractAudioLyrics(bytes: Uint8Array): string | null {
  const id3 = extractId3Lyrics(bytes)
  if (id3) return id3
  return extractFlacLyrics(bytes)
}

/**
 * 从音频文件头部解析 ID3v2 APIC 帧，提取专辑封面。
 * 返回 blob URL（调用方负责 URL.revokeObjectURL 释放）；无封面返回 null。
 */
function extractId3AlbumArt(bytes: Uint8Array): string | null {
  try {
    const header = readId3Header(bytes)
    if (!header) return null
    let url: string | null = null
    eachFrame(bytes, header.major, header.tagEnd, 'APIC', (start, end) => {
      const img = parseApic(bytes, start, end)
      if (img) {
        url = img
        return true
      }
      return false
    })
    return url
  } catch {
    /* 忽略解析错误 */
    return null
  }
}

/** 解析 APIC 帧：encoding + mime(null) + pictureType(1) + description(null) + 图片数据 */
function parseApic(bytes: Uint8Array, start: number, end: number): string | null {
  if (end - start < 5) return null
  const enc = bytes[start] // 0=ISO-8859-1, 1=UTF-16, 2=UTF-16BE, 3=UTF-8
  let p = start + 1
  // MIME 类型（null 终止）
  let mimeEnd = p
  while (mimeEnd < end && bytes[mimeEnd] !== 0) mimeEnd++
  if (mimeEnd >= end) return null
  const mime = String.fromCharCode(...bytes.slice(p, mimeEnd)).toLowerCase()
  if (!mime.startsWith('image/')) return null
  p = mimeEnd + 1
  if (p >= end) return null
  p += 1 // 图片类型
  if (p >= end) return null
  // 跳过描述（按编码读取终止符）
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(bytes[p] === 0 && bytes[p + 1] === 0)) p++
    p += 2
  } else {
    while (p < end && bytes[p] !== 0) p++
    p += 1
  }
  if (p >= end) return null
  const imgBytes = bytes.slice(p, end)
  if (!imgBytes.length) return null
  const blob = new Blob([imgBytes], { type: mime })
  return URL.createObjectURL(blob)
}

/** 从音频文件解析 ID3v2 USLT 帧提取内置歌词文本 */
function extractId3Lyrics(bytes: Uint8Array): string | null {
  try {
    const header = readId3Header(bytes)
    if (!header) return null
    let text: string | null = null
    eachFrame(bytes, header.major, header.tagEnd, 'USLT', (start, end) => {
      const txt = parseUslt(bytes, start, end)
      if (txt) {
        text = txt
        return true
      }
      return false
    })
    return text
  } catch {
    /* 忽略解析错误 */
    return null
  }
}

/** 解析 USLT 帧：encoding + language(3) + descriptor(null) + 歌词文本 */
function parseUslt(bytes: Uint8Array, start: number, end: number): string | null {
  if (end - start < 5) return null
  const enc = bytes[start]
  let p = start + 1
  p += 3 // language
  if (p >= end) return null
  // 跳过描述（按编码读取终止符）
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(bytes[p] === 0 && bytes[p + 1] === 0)) p++
    p += 2
  } else {
    while (p < end && bytes[p] !== 0) p++
    p += 1
  }
  if (p >= end) return null
  const lyricBytes = bytes.slice(p, end)
  if (!lyricBytes.length) return null
  let text: string
  try {
    if (enc === 1) text = new TextDecoder('utf-16').decode(lyricBytes)
    else if (enc === 2) text = new TextDecoder('utf-16be').decode(lyricBytes)
    else text = new TextDecoder('utf-8').decode(lyricBytes)
  } catch {
    text = new TextDecoder('utf-8').decode(lyricBytes)
  }
  return text.replace(/\u0000/g, '').trim() || null
}

// ---------------- FLAC（原生 FLAC 元数据块；Vorbis comment 存歌词、PICTURE 块存封面） ----------------
// FLAC 不用 ID3：文件头是 "fLaC" + 一串元数据块。封面在 PICTURE(6) 块，
// 也可能以 base64 放在 Vorbis comment 的 METADATA_BLOCK_PICTURE / COVERART 里；
// 歌词放在 LYRICS / UNSYNCEDLYRICS 注释里。少数 FLAC 前面会挂一个 ID3v2 标签（非标准），也一并跳过。

/** 是否 FLAC 文件（含「前置 ID3v2 标签」的情况，返回 fLaC 标记的偏移；不是则 -1） */
function flacBaseOffset(bytes: Uint8Array): number {
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 0
  const id3 = readId3Header(bytes)
  if (id3) {
    const base = id3.tagEnd
    if (base + 4 <= bytes.length && bytes[base] === 0x66 && bytes[base + 1] === 0x4c && bytes[base + 2] === 0x61 && bytes[base + 3] === 0x43) return base
  }
  return -1
}

function readU32BE(b: Uint8Array, o: number): number {
  return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0)
}

function readU32LE(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i])
  return s
}

/** 遍历 FLAC 元数据块；回调返回 true 即停止 */
function eachFlacBlock(bytes: Uint8Array, base: number, cb: (type: number, start: number, end: number) => boolean): void {
  let pos = base + 4
  while (pos + 4 <= bytes.length) {
    const header = bytes[pos]
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const start = pos + 4
    const end = start + len
    if (end > bytes.length) return // 数据不完整，放弃
    if (cb(type, start, end)) return
    if (isLast) return
    pos = end
  }
}

/** 解析 FLAC PICTURE 块（也用于 METADATA_BLOCK_PICTURE base64 解出的内容），返回 blob URL */
function parseFlacPicture(bytes: Uint8Array, start: number, end: number): string | null {
  if (end - start < 32) return null
  let p = start + 4 // 图片类型
  const mimeLen = readU32BE(bytes, p)
  p += 4
  if (p + mimeLen > end) return null
  const mime = latin1(bytes, p, p + mimeLen).toLowerCase()
  p += mimeLen
  const descLen = readU32BE(bytes, p)
  p += 4
  if (p + descLen + 16 > end) return null
  p += descLen
  p += 16 // 宽 / 高 / 色深 / 索引色数
  const dataLen = readU32BE(bytes, p)
  p += 4
  if (p >= end) return null
  const imgBytes = bytes.slice(p, Math.min(end, p + dataLen))
  if (!imgBytes.length) return null
  return URL.createObjectURL(new Blob([imgBytes], { type: mime.startsWith('image/') ? mime : 'image/jpeg' }))
}

/** base64 → 字节（浏览器 / Electron 渲染进程有 atob） */
function base64ToBytes(b64: string): Uint8Array | null {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '')
  if (!clean || typeof atob !== 'function') return null
  try {
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

interface FlacComment {
  /** 键名大写（如 LYRICS / METADATA_BLOCK_PICTURE） */
  key: string
  value: string
}

/** 读取 FLAC 的 Vorbis comment 块（type 4） */
function readFlacComments(bytes: Uint8Array, base: number): FlacComment[] {
  const out: FlacComment[] = []
  try {
    eachFlacBlock(bytes, base, (type, start, end) => {
      if (type !== 4) return false
      let p = start
      if (p + 4 > end) return true
      const vendorLen = readU32LE(bytes, p)
      p += 4 + vendorLen
      if (p + 4 > end) return true
      const count = readU32LE(bytes, p)
      p += 4
      for (let i = 0; i < count && p + 4 <= end; i++) {
        const len = readU32LE(bytes, p)
        p += 4
        if (p + len > end) break
        let text = ''
        try {
          text = new TextDecoder('utf-8').decode(bytes.slice(p, p + len))
        } catch {
          text = latin1(bytes, p, p + len)
        }
        p += len
        const eq = text.indexOf('=')
        if (eq <= 0) continue
        out.push({ key: text.slice(0, eq).trim().toUpperCase(), value: text.slice(eq + 1) })
      }
      return true
    })
  } catch {
    /* 忽略解析错误 */
  }
  return out
}

/** FLAC 封面：优先 PICTURE 块，其次 METADATA_BLOCK_PICTURE / COVERART 注释 */
function extractFlacAlbumArt(bytes: Uint8Array): string | null {
  try {
    const base = flacBaseOffset(bytes)
    if (base < 0) return null
    let url: string | null = null
    eachFlacBlock(bytes, base, (type, start, end) => {
      if (type !== 6) return false
      url = parseFlacPicture(bytes, start, end)
      return !!url
    })
    if (url) return url
    const comments = readFlacComments(bytes, base)
    for (const c of comments) {
      if (c.key !== 'METADATA_BLOCK_PICTURE') continue
      const raw = base64ToBytes(c.value)
      if (!raw) continue
      const pic = parseFlacPicture(raw, 0, raw.length)
      if (pic) return pic
    }
    // 旧式 COVERART：直接是图片 base64（可带 COVERARTMIME 指定类型）
    const mime = comments.find((c) => c.key === 'COVERARTMIME')?.value
    for (const c of comments) {
      if (c.key !== 'COVERART') continue
      const raw = base64ToBytes(c.value)
      if (raw && raw.length) return URL.createObjectURL(new Blob([raw], { type: mime || 'image/jpeg' }))
    }
  } catch {
    /* 忽略解析错误 */
  }
  return null
}

/** FLAC 歌词：Vorbis comment 的 LYRICS / UNSYNCEDLYRICS */
function extractFlacLyrics(bytes: Uint8Array): string | null {
  try {
    const base = flacBaseOffset(bytes)
    if (base < 0) return null
    const keys = ['LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS']
    for (const c of readFlacComments(bytes, base)) {
      if (keys.includes(c.key)) {
        const text = c.value.replace(/\u0000/g, '').trim()
        if (text) return text
      }
    }
  } catch {
    /* 忽略解析错误 */
  }
  return null
}

/**
 * 解析 LRC 时间轴歌词；整段都没有时间戳时按行返回纯文本（time = -1，不参与高亮/滚动）。
 *
 * 有时间轴时**丢弃无时间戳的行**（`[ti:]` `[ar:]` `[al:]` `[offset:]` 以及各家音乐软件
 * 生成的 `[kuwo:044]` 之类元信息行）。否则首行 time = -1 会让「首行是否带时间戳」的判断
 * 失效，内置歌词（USLT 里通常带一段元信息头）就只显示、不随时间高亮滚动。
 */
export function parseLrc(text: string): LyricLine[] {
  const result: LyricLine[] = []
  let hasTimestamp = false
  const lines = String(text || '').split(/\r?\n/)
  for (const rawLine of lines) {
    const timeMatches = [...rawLine.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (timeMatches.length) {
      hasTimestamp = true
      const lyricText = rawLine.replace(/\[[^\]]*\]/g, '').trim()
      for (const m of timeMatches) {
        const min = parseInt(m[1], 10)
        const sec = parseInt(m[2], 10)
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0
        result.push({ time: min * 60 + sec + frac, text: lyricText })
      }
    } else {
      result.push({ time: -1, text: rawLine })
    }
  }
  if (!hasTimestamp) return result.map(l => ({ time: -1, text: l.text }))
  return result.filter(l => l.time >= 0)
}
