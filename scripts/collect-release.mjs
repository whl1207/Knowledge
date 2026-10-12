/**
 * 归集发布产物：把 electron-builder 生成的文件改名为发布命名，并按需打「绿色包」。
 *
 * 命名规则（<ver> = package.json 的 version）：
 *   AI-KM_v<ver>_Portable.exe            -> AI-KM_Windows_<ver>_x86_64_Portable.exe
 *   AI-KM_v<ver>_Setup.exe               -> AI-KM_Windows_<ver>_x86_64_Setup.exe
 *   AI-KM-Linux-<ver>-x86_64.AppImage    -> AI-KM_Linux_<ver>_x86_64.AppImage
 *   AI-KM-Linux-<ver>-amd64.deb          -> AI-KM_Linux_<ver>_amd64.deb
 *   AI-KM-Linux-<ver>-arm64.deb          -> AI-KM_Linux_<ver>_arm64.deb
 *   解包目录 release/AI-KM（免安装）       -> AI-KM_Windows_<ver>_x86_64_green.rar（内含 AI-KM/ 目录）
 *
 * 用法：
 *   node scripts/collect-release.mjs              # 改名 + 有解包目录时打绿色包
 *   node scripts/collect-release.mjs --skip-rar   # 只改名，不打绿色包
 *   node scripts/collect-release.mjs --force      # 绿色包已存在也重打
 *
 * 说明：
 *   - 幂等：已是发布命名的文件不会重复处理，可以重复执行；
 *   - 兼容两种输出位置：release/ 与 release/<ver>/（electron-builder.json5 的 output 配置）；
 *   - 绿色包用 WinRAR 命令行（默认 C:\Program Files\WinRAR\Rar.exe，可用环境变量 AIKM_RAR 覆盖）；
 *     找不到 WinRAR 只提示、不报错，其它产物照常归集。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RELEASE = join(ROOT, 'release')
const VER = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const args = process.argv.slice(2)
const skipRar = args.includes('--skip-rar')
const force = args.includes('--force')

/** 源文件名 -> 发布文件名 */
const RULES = [
  { src: `AI-KM_v${VER}_Portable.exe`, dst: `AI-KM_Windows_${VER}_x86_64_Portable.exe` },
  { src: `AI-KM_v${VER}_Setup.exe`, dst: `AI-KM_Windows_${VER}_x86_64_Setup.exe` },
  { src: `AI-KM-Linux-${VER}-x86_64.AppImage`, dst: `AI-KM_Linux_${VER}_x86_64.AppImage` },
  { src: `AI-KM-Linux-${VER}-amd64.deb`, dst: `AI-KM_Linux_${VER}_amd64.deb` },
  { src: `AI-KM-Linux-${VER}-arm64.deb`, dst: `AI-KM_Linux_${VER}_arm64.deb` },
  // 备用命名（electron-builder.json5 里的 artifactName）
  { src: `AI-KM-Windows-${VER}-Setup.exe`, dst: `AI-KM_Windows_${VER}_x86_64_Setup.exe` },
  { src: `AI-KM-Mac-${VER}-Installer.dmg`, dst: `AI-KM_Mac_${VER}_x86_64.dmg` }
]

fs.mkdirSync(RELEASE, { recursive: true })
const searchDirs = [RELEASE, join(RELEASE, VER)].filter((d) => fs.existsSync(d))

const renamed = []
for (const rule of RULES) {
  const dstPath = join(RELEASE, rule.dst)
  if (fs.existsSync(dstPath)) continue
  for (const dir of searchDirs) {
    const srcPath = join(dir, rule.src)
    if (!fs.existsSync(srcPath)) continue
    fs.renameSync(srcPath, dstPath)
    renamed.push(`${rule.src}  ->  ${rule.dst}`)
    break
  }
}

// 绿色包：release/AI-KM（win-unpacked 改名后的免安装目录）打成 RAR
const greenRar = join(RELEASE, `AI-KM_Windows_${VER}_x86_64_green.rar`)
const unpacked = join(RELEASE, 'AI-KM')
let rarMsg
if (skipRar) {
  rarMsg = '按 --skip-rar 跳过绿色包'
} else if (!fs.existsSync(unpacked)) {
  rarMsg = '未找到解包目录 release/AI-KM（先执行 npm run release:win），跳过绿色包'
} else if (fs.existsSync(greenRar) && !force) {
  rarMsg = `绿色包已存在（${basename(greenRar)}），跳过（--force 可重打）`
} else {
  const rar = [process.env.AIKM_RAR, 'C:\\Program Files\\WinRAR\\Rar.exe', 'C:\\Program Files (x86)\\WinRAR\\Rar.exe']
    .filter(Boolean)
    .find((p) => fs.existsSync(p))
  if (!rar) {
    rarMsg = '未找到 WinRAR（Rar.exe），跳过绿色包（可用环境变量 AIKM_RAR 指定路径）'
  } else {
    if (fs.existsSync(greenRar)) fs.rmSync(greenRar, { force: true })
    const started = Date.now()
    execFileSync(rar, ['a', '-r', '-m5', greenRar, 'AI-KM'], { cwd: RELEASE, stdio: 'inherit' })
    const mb = (fs.statSync(greenRar).size / 1024 / 1024).toFixed(1)
    rarMsg = `绿色包已生成：${basename(greenRar)}（${mb} MB，用时 ${((Date.now() - started) / 1000).toFixed(0)}s）`
  }
}

console.log(`[collect-release] 版本 ${VER}`)
if (renamed.length) renamed.forEach((r) => console.log('  ✓ ' + r))
else console.log('  · 没有需要改名的产物（已是发布命名）')
console.log('  · ' + rarMsg)
console.log('  发布产物目录: ' + RELEASE)
