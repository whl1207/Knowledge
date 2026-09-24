/**
 * mbTiles.ts — 渲染层 MBTiles 瓦片图层共享工具
 *
 * 供 view_map.vue / DashboardView.vue 等所有地图组件复用：
 *  - createMbtilesLayer(): 构造一个不请求 URL 的 GridLayer，每张瓦片通过
 *    window.dsh.mapTiles.tile() 走主进程 sql.js 从 .mbtiles 读单张
 *  - mbTileToDataUrl(): Uint8Array → data URL（避免 Blob URL 生命周期泄漏）
 */
import * as L from 'leaflet'

export interface MbTileSourceLike {
  id: string
  format?: string
  minZoom?: number
  maxZoom?: number
}

/** Uint8Array → data URL（256 瓦片小图，base64 开销可忽略且无对象生命周期问题） */
export function mbTileToDataUrl(buf: Uint8Array, format?: string): string {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg'
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)))
  }
  return 'data:' + mime + ';base64,' + btoa(bin)
}

// 只 extend 一次（避免每张卡片/每次切换都重建子类）
const MbtilesTileLayerClass: any = (L as any).GridLayer.extend({
  createTile: function (coords: any) {
    const img = L.DomUtil.create('img')
    img.alt = ''
    const o: any = this.options || {}
    img.style.width = '256px'
    img.style.height = '256px'
    img.src = o.placeholder || ''
    if (window.dsh?.mapTiles?.tile) {
      window.dsh.mapTiles
        .tile({ id: o.srcId, z: coords.z, x: coords.x, y: coords.y })
        .then((buf: any) => {
          if (buf && buf.length) img.src = mbTileToDataUrl(buf, o.format)
        })
        .catch(() => { /* 无瓦片/出错时保持占位 */ })
    }
    return img
  },
})

/**
 * 构造一个 MBTiles 图层（GridLayer），可像普通底图一样 addTo(map)。
 * @param src 源描述（主进程 list 返回的 MapTileSource）
 * @param opts.placeholder 无瓦片时的占位图 URL
 */
export function createMbtilesLayer(
  src: MbTileSourceLike,
  opts: { placeholder?: string } = {},
): L.GridLayer {
  return new MbtilesTileLayerClass({
    srcId: src.id,
    format: src.format || 'jpg',
    minZoom: src.minZoom ?? 0,
    maxZoom: src.maxZoom ?? 30,
    placeholder: opts.placeholder || '',
  })
}

/** 从挂载列表中挑「内置」优先的地图源（无内置则取第一个用户包） */
export function pickPreferredMbSource(list: any[]): any | null {
  if (!list || !list.length) return null
  return list.find((s) => s?.kind === 'builtin') || list[0] || null
}
