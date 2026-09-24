/**
 * 打包后把 electron-builder 生成的 win-unpacked 目录重命名为 AI-KM。
 *
 * win-unpacked 是 electron-builder 内部硬编码的未打包目录名，无法通过配置修改，
 * 因此在打包完成后统一改名为 AI-KM。
 *
 * 递归扫描 release 下所有 win-unpacked 目录，兼容两种输出位置：
 *   - release/win-unpacked        （package.json build 配置）
 *   - release/<version>/win-unpacked（electron-builder.json5 配置）
 */
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const releaseRoot = fileURLToPath(new URL('../release/', import.meta.url))

/**
 * 打包完成后需要自动清理的 electron-builder 临时产物：
 *  - .icon-ico                   图标缓存目录
 *  - builder-debug.yml           调试配置快照
 *  - builder-effective-config.yaml 生效配置快照
 */
const CLEANUP_NAMES = ['.icon-ico', 'builder-debug.yml', 'builder-effective-config.yaml']

/** 递归清理 release 下的构建临时产物（跳过应用目录与 node_modules 避免误删/拖慢） */
function cleanupArtifacts(root) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (CLEANUP_NAMES.includes(entry.name)) {
      rmSync(full, { recursive: true, force: true })
      console.log(`[rename-unpacked] 已清理临时文件: ${full}`)
    } else if (entry.isDirectory() && !['node_modules', 'AI-KM'].includes(entry.name)) {
      cleanupArtifacts(full)
    }
  }
}

/** 递归收集所有名为 win-unpacked 的目录 */
function collectWinUnpackedDirs(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    if (entry.name === 'win-unpacked') {
      found.push(full)
    } else {
      found.push(...collectWinUnpackedDirs(full))
    }
  }
  return found
}

const targets = collectWinUnpackedDirs(releaseRoot)

if (targets.length === 0) {
  console.log('[rename-unpacked] 未找到 win-unpacked 目录，跳过重命名。')
  process.exit(0)
}

for (const dir of targets) {
  const dest = join(dir, '..', 'AI-KM')
  // 目标已存在（例如上次已重命名）则先删除，保证重命名成功
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  try {
    renameSync(dir, dest)
    console.log(`[rename-unpacked] ${dir} -> ${dest}`)
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error(
        `[rename-unpacked] 重命名失败：${dir} 正被其他进程占用（EBUSY）。\n` +
          `请关闭正在运行的 AI-KM 应用、资源管理器窗口或杀毒软件扫描后重试，\n` +
          `或重新运行: node scripts/rename-unpacked.mjs`
      )
      process.exitCode = 1
    } else {
      throw err
    }
  }
}

// 打包成功（win-unpacked 改名完成）后，自动清理 electron-builder 生成的临时产物
cleanupArtifacts(releaseRoot)
