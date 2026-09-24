#!/usr/bin/env node
/**
 * fetch-drawio-webapp.mjs — 获取并裁剪 draw.io 运行时，落地到 public/drawio
 *
 * 用途：Drawio.vue（draw.io 图表视图）用 iframe 加载 drawio 官方 webapp，
 * 通过 embed 模式 + JSON 协议（postMessage）作为宿主。运行时资源体积较大
 *（裁剪后约 65MB），因此不入库，由本脚本按需下载。
 *
 * 用法：
 *   node scripts/fetch-drawio-webapp.mjs            # 已存在则跳过
 *   node scripts/fetch-drawio-webapp.mjs --force    # 强制重新下载
 *   DRAWIO_VERSION=v31.4.5 node scripts/fetch-drawio-webapp.mjs
 *
 * 裁剪说明（以 webapp 源码为准，实测可离线正常启动）：
 *   - js/integrate.min.js  (~21MB) integrate.html 专用（Google Drive 等云端集成），主流程不加载
 *   - js/diagramly/        (~10MB) dev=1 模式源码，生产只用 js/app.min.js
 *   - js/grapheditor/      (~2MB)  dev=1 模式源码
 *   - stencils/            (~41MB) 原始形状库 XML，已打包进 js/stencils.min.js
 *   - WEB-INF/ META-INF/   Java servlet 部署产物，静态托管用不到
 *   - service-worker/workbox  离线缓存，本应用自身即离线环境
 * 保留：index.html / styles / resources / templates / math4 / shapes / img / images /
 *       plugins / mxgraph 及 js 下运行时需要的各 bundle 与子库。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import https from 'node:https'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEST = path.join(ROOT, 'public', 'drawio')
const TMP_TAR = path.join(ROOT, '.tmp-drawio-src.tar.gz')
const TMP_DIR = path.join(ROOT, '.tmp-drawio-extract')

const VERSION = process.env.DRAWIO_VERSION || 'v31.4.5'
const URL = `https://codeload.github.com/jgraph/drawio/tar.gz/refs/tags/${VERSION}`
const ARCHIVE_ROOT = `drawio-${VERSION.replace(/^v/, '')}`

/** 需要剔除的目录（相对 webapp 根） */
const SKIP_DIRS = new Set(['js/diagramly', 'js/grapheditor', 'stencils', 'WEB-INF', 'META-INF'])
/** 需要剔除的文件（相对 webapp 根） */
const SKIP_FILES = new Set(['js/integrate.min.js', 'service-worker.js', 'service-worker.js.map'])
/** 需要剔除的文件名前缀/后缀（workbox 产物） */
const SKIP_PATTERNS = [/^workbox-.*\.js(\.map)?$/]

const force = process.argv.includes('--force')

function log(msg) {
  console.log(`[drawio] ${msg}`)
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 6) return reject(new Error('too many redirects'))
      https
        .get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume()
            return follow(res.headers.location, depth + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`))
          }
          const total = Number(res.headers['content-length'] || 0)
          let got = 0
          let lastTick = 0
          const out = createWriteStream(dest)
          res.on('data', (chunk) => {
            got += chunk.length
            const sec = Math.floor(got / (8 * 1024 * 1024))
            if (total && sec !== lastTick) {
              lastTick = sec
              log(`下载中 ${(got / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`)
            }
          })
          res.pipe(out)
          out.on('finish', () => out.close(() => resolve(got)))
          out.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url)
  })
}

/** tar 在 Windows 10+ / macOS / Linux 均自带（Windows 为 bsdtar） */
function extractWebapp(tarFile, outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    'tar',
    ['-xzf', tarFile, '-C', outDir, '--strip-components=4', `${ARCHIVE_ROOT}/src/main/webapp/*`],
    { stdio: 'inherit' }
  )
}

function copyPruned(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  const walk = (rel) => {
    const abs = path.join(srcDir, rel)
    for (const entry of readdirSync(abs)) {
      const childRel = rel ? `${rel}/${entry}` : entry
      const stat = statSync(path.join(srcDir, childRel))
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(childRel)) continue
        walk(childRel)
        continue
      }
      if (SKIP_FILES.has(childRel)) continue
      if (SKIP_PATTERNS.some((re) => re.test(entry))) continue
      const target = path.join(destDir, childRel)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(path.join(srcDir, childRel), target)
    }
  }
  walk('')
}

function dirSize(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else {
        bytes += st.size
        files += 1
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

async function main() {
  if (existsSync(path.join(DEST, 'index.html')) && !force) {
    const { bytes, files } = dirSize(DEST)
    log(`已存在，跳过：public/drawio（${files} 个文件，${(bytes / 1048576).toFixed(1)}MB）`)
    log('如需重新获取，加 --force')
    return
  }

  log(`drawio ${VERSION} ← ${URL}`)
  if (!existsSync(TMP_TAR)) {
    await download(URL, TMP_TAR)
  } else {
    log(`复用已下载的源码包 ${path.basename(TMP_TAR)}`)
  }

  log('解出 webapp 子目录…')
  rmSync(TMP_DIR, { recursive: true, force: true })
  extractWebapp(TMP_TAR, TMP_DIR)

  log('裁剪并复制到 public/drawio …')
  rmSync(DEST, { recursive: true, force: true })
  copyPruned(TMP_DIR, DEST)

  rmSync(TMP_DIR, { recursive: true, force: true })
  rmSync(TMP_TAR, { force: true })

  const { bytes, files } = dirSize(DEST)
  log(`完成：${files} 个文件，${(bytes / 1048576).toFixed(1)}MB → public/drawio`)
}

main().catch((err) => {
  console.error('[drawio] 失败：', err?.message || err)
  process.exit(1)
})
