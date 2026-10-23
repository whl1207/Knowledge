const asar = require('@electron/asar')
const fs = require('fs')
const p = 'D:/AI/AI-KM/resources/app.asar'
for (const f of ['\\dist\\assets\\Drawio-a8tc73UT.js', '\\dist-electron\\main\\index-DZt0QUoz.js']) {
  const buf = asar.extractFile(p, f.replace(/^\\/, ''))
  const s = buf.toString('utf8')
  const marks = {
    hasCollectPages: s.includes('collectPages'),
    hasPagesPayload: s.includes('pages:') || s.includes('pages,') || s.includes('.pages'),
    hasMerged: s.includes('getPageCount') || s.includes('copyPages'),
    hasNewToast: s.includes('已导出 PDF（'),
    hasOldToast: s.includes('已导出 PDF 到'),
    hasExportPdfChannel: s.includes('drawio-export-pdf'),
    len: s.length,
  }
  console.log(f, JSON.stringify(marks))
  fs.writeFileSync('D:/Project/1 Knowledge/.tmp-chunk-' + (f.includes('Drawio') ? 'drawio' : 'main') + '.js', s)
}
