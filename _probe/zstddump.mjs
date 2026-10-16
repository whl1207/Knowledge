// 一次性排查脚本：DSH 会话文件是「每行一个独立 zstd 帧」的 jsonl.zstd（示例文件 902 帧）。
// Node 的 zstdDecompressSync 只解第一帧，createZstdDecompress 会在第二帧上报
// ZSTD_error_prefix_unknown，所以这里按「找到下一个帧魔数」的方式逐帧解压。
// 用法：node zstddump.mjs <input.jsonl.zstd> <output.jsonl>
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function frameOffsets(buf) {
  const offsets = []
  let p = 0
  for (;;) {
    const i = buf.indexOf(MAGIC, p)
    if (i < 0) break
    offsets.push(i)
    p = i + 4
  }
  return offsets
}

const [inp, outp] = process.argv.slice(2)
if (!inp || !outp) {
  console.error('usage: node zstddump.mjs <in.jsonl.zstd> <out.jsonl>')
  process.exit(2)
}

const buf = readFileSync(inp)
const offsets = frameOffsets(buf)
const parts = []
let failed = 0
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  try {
    parts.push(zstdDecompressSync(buf.subarray(start, end)))
  } catch (e) {
    failed++
    if (failed <= 3) console.error(`frame ${i} @${start} failed: ${e.message}`)
  }
}
const out = Buffer.concat(parts)
writeFileSync(outp, out)
console.log(`frames=${offsets.length} failed=${failed} bytes=${buf.length} -> ${out.length} : ${outp}`)
