#!/usr/bin/env node
/**
 * 获取 Office 编辑器内核源码（GenOffice）到 vendor/genoffice/
 *
 * 版本锚点来自 scripts/office-vendor.lock.json（仓库 + commit SHA），
 * 因此本脚本可重复执行、结果可复现；换版本只需改锁文件里的 commit。
 *
 * 为什么走「归档包」而不是 git clone：
 *   git 协议经国内代理不稳定（实测浅克隆 6 分钟后 0 字节落地），
 *   而代理对 GitHub archive 支持良好。归档包顶层目录名即为 ref，内容不含 .git。
 *
 * 用法：
 *   node scripts/fetch-office-vendor.mjs                 # 直连 codeload，失败自动降级到镜像
 *   node scripts/fetch-office-vendor.mjs --mirror        # 强制走镜像（国内推荐）
 *   node scripts/fetch-office-vendor.mjs --ref main      # 覆盖锁文件里的 ref（调试用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LOCK = path.join(__dirname, 'office-vendor.lock.json')

const forceMirror = process.argv.includes('--mirror')
const refArgIndex = process.argv.indexOf('--ref')
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
const ref = refArgIndex > -1 ? process.argv[refArgIndex + 1] : lock.commit || lock.ref

const repo = lock.repository.replace(/^https?:\/\/github\.com\//, '')
const destDir = path.join(ROOT, lock.vendorDir || 'vendor/genoffice')
const tmpDir = path.join(ROOT, '.tmp-office-vendor')

/** 候选下载地址：直连 codeload 最快但可能被限速，代理对 archive 支持良好 */
function candidates() {
  const direct = `https://codeload.github.com/${repo}/tar.gz/${ref}`
  const viaProxy = (host) => `${host}/https://github.com/${repo}/archive/${ref}.tar.gz`
  return forceMirror
    ? [viaProxy('https://ghproxy.net'), viaProxy('https://ghfast.top'), direct]
    : [direct, viaProxy('https://ghproxy.net'), viaProxy('https://ghfast.top')]
}

async function download(url, outFile) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let seen = 0
  let lastLog = 0
  const started = Date.now()
  const stream = Readable.fromWeb(res.body)
  stream.on('data', (chunk) => {
    seen += chunk.length
    const now = Date.now()
    if (now - lastLog > 3000) {
      lastLog = now
      const mb = (seen / 1048576).toFixed(1)
      const speed = (seen / 1048576 / ((now - started) / 1000)).toFixed(2)
      process.stdout.write(
        `\r    ${mb} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}  ${speed} MB/s   `,
      )
    }
  })
  await pipeline(stream, fs.createWriteStream(outFile))
  process.stdout.write('\r' + ' '.repeat(60) + '\r')
  return seen
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（code ${res.status}）`)
}

/** 校验关键目录，确认归档内容完整 */
function verify() {
  const required = [
    'package.json',
    'LICENSE',
    'apps/docs',
    'apps/sheets',
    'apps/slides',
    'apps/pdf',
    'packages/docx-engine',
    'packages/ai-provider',
    'packages/agent-core',
  ]
  const missing = required.filter((p) => !fs.existsSync(path.join(destDir, p)))
  if (missing.length) throw new Error(`归档缺少关键路径: ${missing.join(', ')}`)
}

async function main() {
  fs.mkdirSync(tmpDir, { recursive: true })
  const tarFile = path.join(tmpDir, 'genoffice.tar.gz')

  let ok = false
  for (const url of candidates()) {
    try {
      console.log(`  → ${url}`)
      const bytes = await download(url, tarFile)
      if (bytes < 1024 * 1024) throw new Error(`响应过小（${bytes} 字节），可能是错误页`)
      console.log(`    下载完成：${(bytes / 1048576).toFixed(1)} MB`)
      ok = true
      break
    } catch (e) {
      console.warn(`    失败：${e.message}`)
    }
  }
  if (!ok) throw new Error('所有下载渠道均失败')

  // 解压 → 展平顶层目录 → 落位
  const extractDir = path.join(tmpDir, 'extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  console.log('  解压中…')
  run('tar', ['-xzf', tarFile, '-C', extractDir])

  const entries = fs.readdirSync(extractDir)
  if (entries.length !== 1) throw new Error(`归档顶层应为单一目录，实际为 ${entries.length} 个`)
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  fs.renameSync(path.join(extractDir, entries[0]), destDir)
  fs.rmSync(tmpDir, { recursive: true, force: true })

  verify()
  const files = countFiles(destDir)
  console.log(`\n✓ ${lock.vendorDir} 就绪：${files} 个文件（ref=${ref}）`)
  console.log('  下一步：cd vendor/genoffice && npm install（国内加 --registry=https://registry.npmmirror.com）')
}

function countFiles(dir) {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1
  }
  return n
}

main().catch((e) => {
  console.error('\n✗ 获取失败：', e.message)
  process.exit(1)
})
