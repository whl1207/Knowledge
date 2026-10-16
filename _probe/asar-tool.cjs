// asar-tool.cjs — list / extract entries from an Electron .asar archive (uses the project's @electron/asar)
// usage:
//   node asar-tool.cjs list    <asar> [regex]
//   node asar-tool.cjs extract <asar> <regex> <destDir>
const asar = require('@electron/asar')
const fs = require('node:fs')
const path = require('node:path')

const [mode, asarPath, arg3, arg4] = process.argv.slice(2)
if (!mode || !asarPath) {
  console.error('usage: node asar-tool.cjs list|extract <asar> <regex> [destDir]')
  process.exit(2)
}

// asar entry names carry a leading separator and (on Windows) native separators;
// getFile() splits on path.sep and chokes on the leading one, so strip it but keep the rest native.
const entries = asar.listPackage(asarPath).map((raw) => ({
  raw: raw.replace(/^[/\\]+/, ''),
  rel: raw.replace(/^[/\\]+/, '').replace(/\\/g, '/'),
}))
const re = arg3 ? new RegExp(arg3, 'i') : /.*/
const hits = entries.filter((e) => re.test(e.rel))

if (mode === 'list') {
  for (const h of hits.sort((a, b) => a.rel.localeCompare(b.rel))) console.log(h.rel)
  console.log(`--- ${hits.length} / ${entries.length} entries`)
} else if (mode === 'extract') {
  const dest = arg4
  if (!dest) { console.error('extract needs destDir'); process.exit(2) }
  let ok = 0
  for (const h of hits) {
    const target = path.join(dest, h.rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      const buf = asar.extractFile(asarPath, h.raw)
      fs.writeFileSync(target, buf)
      ok++
    } catch (e) {
      console.error(`skip ${h.rel}: ${e.message}`)
    }
  }
  console.log(`extracted ${ok} / ${hits.length} entries to ${dest}`)
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
