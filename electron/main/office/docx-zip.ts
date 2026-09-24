/**
 * docx ZIP 底层原语（Node 端，零第三方依赖）
 *
 *  - unzipEntries：读取 zip 全部条目（中央目录解析 + stored/deflate 解压）
 *  - readZipEntryText：读单个条目文本
 *  - packZip：把条目重新打包为 zip（deflate + CRC32 + 中央目录）
 *
 * 供 docx-reader（读）与 docx-editor（编辑后增量重打包）共用。
 */
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { asUint8 } from '../buffer-view'

export interface ZipEntryData {
  name: string
  data: Buffer
}

// ==================== 解包 ====================

function findEocd(buf: Buffer): number {
  const len = buf.length
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0x20000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i
  }
  return -1
}

/** 读取 zip 全部条目（保序）；method 0/8 均支持 */
export function unzipEntries(buf: Buffer): ZipEntryData[] {
  const out: ZipEntryData[] = []
  const eocd = findEocd(buf)
  if (eocd < 0) return out
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  let pos = cdOff
  const end = cdOff + cdSize
  while (pos + 46 <= end) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) { pos++; continue }
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const cmtLen = buf.readUInt16LE(pos + 32)
    const localOff = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    const ln = buf.readUInt16LE(localOff + 26)
    const el = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + ln + el
    const comp = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer | null = null
    if (method === 0) data = Buffer.from(asUint8(comp))
    else if (method === 8) { try { data = inflateRawSync(asUint8(comp)) } catch { data = null } }
    if (data !== null) out.push({ name, data })
    pos += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

/** 读取 zip 中指定路径条目并解压为 utf-8 文本 */
export function readZipEntryText(buf: Buffer, want: string): string | null {
  for (const e of unzipEntries(buf)) {
    if (e.name === want) return e.data.toString('utf8')
  }
  return null
}

// ==================== 打包 ====================

let crcTable: Uint32Array | null = null
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(data: Buffer): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 把条目打包为 zip（全部 deflate） */
export function packZip(entries: ZipEntryData[]): Buffer {
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const comp = deflateRawSync(asUint8(e.data))
    const crc = crc32(e.data)
    const local = Buffer.alloc(30 + nameBuf.length + comp.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(asUint8(local), 30)
    comp.copy(asUint8(local), 30 + nameBuf.length)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(asUint8(central), 46)

    localParts.push(local)
    centralParts.push(central)
    offset += local.length
  }

  const cd = Buffer.concat(centralParts.map(asUint8))
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts.map(asUint8), asUint8(cd), asUint8(eocd)])
}
