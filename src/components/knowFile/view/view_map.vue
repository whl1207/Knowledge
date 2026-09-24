<script setup lang="ts">

  //加载视图组件
  import { usestore } from '@/store'
  import { ref ,onMounted,onBeforeUnmount, reactive,watch,computed} from 'vue'
  import 'leaflet/dist/leaflet.css' // 导入 Leaflet 的 CSS 文件
  import * as L from 'leaflet' // 导入 Leaflet 的 JavaScript 文件
  import { createMbtilesLayer } from '@/lib/mbTiles'

  const store=usestore()
  let sideOpen = ref(false) // 右侧面板（图源 + 数据列表）开关：默认收起
  let sourceOpen = ref(true) // 右侧面板：图源区展开
  let dataOpen = ref(true) // 右侧面板：数据列表区展开
  let deep = ref(1) // 读取深度（多层文件）
  let onlyGeo = ref(true) // 仅显示已配置经纬度的文件
  let mouseLat = ref(0)
  let mouseLon = ref(0)
  let tooltipsOn = ref(true) // 标签（Tooltip）是否显示（状态栏按钮）
  let curZoom = ref(4) // 当前缩放级别（状态栏显示）
  let map = reactive({
    source:"离线",
    tileUrl:'',
    target:null as any,
    min:4,
    max:7,
    lat:36.810731,
    lon:113.116709,
    zoomLevel:4,
    defaultTileLayer:null as any,
    defaultImageUrl:'public/errorMap.png', //空地图时的图片地址
    markersLayer:null as any, //标记图层
    polygonsLayer:null as any //标记图层
  })
  let nodes = reactive([]) as any
  let markers = reactive([]) as any //所有标记
  let polygons = reactive([]) as any //所有多边形
  let data = reactive([]) as any//读取数据

  // 已挂载的 MBTiles 离线地图包（内置 + 用户挂载）
  let mapTileSources = ref([]) as any
  let unsubMapTiles: (() => void) | null = null
  const isMbSource = (s: string) => s && s.startsWith('mb:')

  // 计算文件树的最大深度
  const getMaxDepth = function(tree: any[], currentDepth: number = 1): number {
    let max = currentDepth
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        const childDepth = getMaxDepth(node.children, currentDepth + 1)
        if (childDepth > max) max = childDepth
      }
    }
    return max
  }
  const maxDepth = ref(5)
  watch(() => store.tree, (val) => {
    if (val && val.length > 0) {
      maxDepth.value = Math.max(getMaxDepth(val), 1)
    }
  }, { immediate: true })

  // 数据列表：按“仅显示有经纬度”配置过滤
  const filteredData = computed(() => {
    if (!onlyGeo.value) return data
    return data.filter((item: any) => item.attributes?.纬度 && item.attributes?.经度)
  })

  // 在线源（散文件式离线已移除，仅保留在线源）
  const onlineSources = computed(() => sources)
  // 当前图源所属类型：offline（MBTiles 包，或空=未就绪/无包）/ online / custom
  const tileType = computed<'offline' | 'online' | 'custom'>(() => {
    const s = map.source
    if (s === '自定义') return 'custom'
    if (isMbSource(s) || s === '') return 'offline'
    return 'online'
  })
  // 切换图源类型：自动落到该类首个可用源（离线无包时进入空状态，由面板提示）
  const chooseTileType = (t: 'offline' | 'online' | 'custom') => {
    if (t === tileType.value) return
    if (t === 'offline') {
      const p = mapTileSources.value.find((s: any) => s.kind === 'builtin') || mapTileSources.value[0]
      map.source = p ? 'mb:' + p.id : ''
    } else if (t === 'online') {
      map.source = sources[0]
    } else {
      map.source = '自定义'
    }
  }
  // 当前图源在右侧面板/状态栏的显示名
  const sourceLabel = computed(() => {
    const s = map.source
    if (isMbSource(s)) {
      return mapTileSources.value.find((x: any) => x.id === s.slice(3))?.name || s.slice(3)
    }
    if (s === '自定义') return store.locales === 'zh' ? '自定义' : 'Custom'
    if (s === '') return store.locales === 'zh' ? '离线(无包)' : 'Offline(none)'
    return s
  })

  const initMap = async function(){
    if(map.target!=null){
      map.target.remove()
    }
    nodes=[]
    markers=[]
    polygons=[]
    map.target = L.map('map').setView([map.lat, map.lon], map.zoomLevel)
   
    getSource() // 根据数据源添加底图图层
    map.target.attributionControl.remove() //移除版权信息
    map.target.removeControl(map.target.zoomControl) //移出缩放按钮
    if (map.markersLayer) map.target.removeLayer(map.markersLayer);
    if (map.polygonsLayer) map.target.removeLayer(map.polygonsLayer);
    map.markersLayer = L.layerGroup().addTo(map.target);
    map.polygonsLayer = L.layerGroup().addTo(map.target);
    map.target.on('click', (e:any)=>{
      map.lat=e.latlng.lat
      map.lon=e.latlng.lng
    })
    map.target.on('mousemove', (e:any)=>{
      mouseLat.value = e.latlng.lat
      mouseLon.value = e.latlng.lng
    })
    map.target.on('zoomend', () => {
      curZoom.value = map.target ? map.target.getZoom() : map.zoomLevel
    })
    curZoom.value = map.zoomLevel
    tooltipsOn.value = true
    if(store.root=="") return //如果未设定仓库和路径
    data = await window.ipcRenderer.invoke("getFiles", store.root, deep.value)
    //添加节点到地图
    data.forEach((item: any) => {
      if (!item.attributes?.纬度 || !item.attributes?.经度) return;

      if (item.attributes.范围?.length > 0) {
        const polygon = L.polygon(item.attributes.范围, {
          color: item.attributes.颜色 || '#f03',
          fillColor: item.attributes.颜色 || '#f03',
          fillOpacity: 0.5
        });
        polygon.bindTooltip(item.label.replace(/\.md$/, ''), {
          permanent: true,
          direction: 'right',
          offset: [10, 0],
          sticky: true
        }).openTooltip();
        polygons.push(polygon);
        map.polygonsLayer.addLayer(polygon);
      } else {
        const marker = L.circle([item.attributes.纬度, item.attributes.经度], {
          color: item.attributes.颜色 || '#f03',
          fillColor: item.attributes.颜色 || '#f03',
          fillOpacity: 0.5,
          radius: item.attributes.半径 || 10
        });
        marker.bindTooltip(item.label.replace(/\.md$/, ''), {
          permanent: true,
          direction: 'right',
          offset: [10, 0],
          sticky: true
        }).openTooltip();
        marker.on('click', () => store.openFileByMode(item));
        markers.push(marker);
        map.markersLayer.addLayer(marker);
      }
    })
  }
  const getSource = function () {
    if (map.defaultTileLayer != null) {
      map.target.removeLayer(map.defaultTileLayer)
      map.defaultTileLayer = null
    }
    // MBTiles 离线地图包（内置 + 用户挂载）
    if (isMbSource(map.source)) {
      const src = mapTileSources.value.find((s: any) => s.id === map.source.slice(3))
      if (src) {
        map.min = src.minZoom
        map.max = src.maxZoom
        map.target.setMinZoom(src.minZoom)
        map.target.setMaxZoom(src.maxZoom)
        map.defaultTileLayer = createMbtilesLayer(src, { placeholder: map.defaultImageUrl }).addTo(map.target)
        // 有规范 bounds（不跨 180° 经线）时自动定位到覆盖范围
        const b = src.bounds
        if (b && b.east <= 180 && b.west < b.east && b.south < b.north) {
          map.target.fitBounds([[b.south, b.west], [b.north, b.east]])
        }
        return
      }
      // 列表未就绪/包被移除：进入空状态（不添加底图，面板给出提示）
      map.source = ''
      return
    }
    if (map.source === '') {
      // 离线但无可用地图包：不添加底图，等待挂载或选择其他源
      return
    }
    if(map.source=="高德地图（卫星）"){
      map.tileUrl = "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }else if(map.source=="高德地图（矢量）"){
      map.tileUrl = "https://webst01.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }else if(map.source=="高德地图（简图）"){
      map.tileUrl = "https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }else if(map.source=="ChinaOnlineCommunity_Mobile"){
      map.tileUrl = "https://map.geoq.cn/arcgis/rest/services/ChinaOnlineCommunity_Mobile/MapServer/tile/{z}/{y}/{x}"
      map.min=4
      map.max=17
    }else if(map.source=="谷歌地图（街道）"){
      map.tileUrl = "https://gac-geo.googlecnapps.cn/maps/vt?lyrs=m&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }else if(map.source=="谷歌地图（卫星）"){
      map.tileUrl = "https://gac-geo.googlecnapps.cn/maps/vt?lyrs=s&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }else if(map.source=="谷歌地图（地名）"){
      map.tileUrl = "https://gac-geo.googlecnapps.cn/maps/vt?lyrs=s,m&gl=CN&x={x}&y={y}&z={z}"
      map.min=4
      map.max=18
    }
    map.target.setMinZoom(map.min)
    map.target.setMaxZoom(map.max)
    map.defaultTileLayer = L.tileLayer(map.tileUrl, {errorTileUrl: map.defaultImageUrl}).addTo(map.target)
  }

  const open = function(event: any){
    console.log(event)
    //store.addTab(data[i])
  }
  // 手动切换所有 Tooltip 的开关状态
  const toggleTooltips = function() {
    tooltipsOn.value = !tooltipsOn.value
    markers.forEach(function(marker:any) {
      if (marker.isTooltipOpen()) {
        marker.closeTooltip();
      } else {
        marker.openTooltip();
      }
    })
    polygons.forEach(function(polygon:any) {
      if (polygon.isTooltipOpen()) {
        polygon.closeTooltip();
      } else {
        polygon.openTooltip();
      }
    })
  }
  // 拉取已挂载的 MBTiles 地图包列表；离线时可自动选中内置包
  // 离线时选用第一个可用离线包（内置优先）；无包则保持空状态由面板提示
  const pickOffline = function (list: any[]) {
    const builtin = (list || []).find((s: any) => s.kind === 'builtin') || (list || [])[0]
    if (builtin) map.source = 'mb:' + builtin.id
  }
  const loadMapTiles = async function (autoPickBuiltin = false) {
    try {
      const list = (await window.dsh?.mapTiles?.list?.()) || []
      mapTileSources.value = list
      if (autoPickBuiltin && !navigator.onLine && map.source === '') pickOffline(list)
    } catch (e) {
      mapTileSources.value = []
    }
  }
  onMounted(() => {
    map.source = navigator.onLine ? '高德地图（卫星）' : ''
    initMap()
    // 拉取 MBTiles 包；离线时自动选中内置包（watch(map.source) 会重建图层）
    loadMapTiles(true)
    if (window.dsh?.mapTiles?.onChange) {
      unsubMapTiles = window.dsh.mapTiles.onChange((list: any) => {
        mapTileSources.value = list || []
        if (!navigator.onLine) {
          if (map.source === '') pickOffline(list)
          else if (isMbSource(map.source) && map.defaultTileLayer == null) getSource()
        } else if (isMbSource(map.source) && map.defaultTileLayer == null) {
          getSource()
        }
      })
    }
  })
  onBeforeUnmount(() => {
    unsubMapTiles?.()
    unsubMapTiles = null
    if (map.target) {
      map.target.remove();
    }
  })
  watch(()=>store.root, (newValue, oldValue) => {
    //if (map.target) {map.target.remove()}
    initMap()
  })
  watch(()=>map.source, (newValue, oldValue) => {//修改图源
    getSource()
  })
  // 右栏展开/收起会改变地图可视宽度 → 重算 Leaflet 尺寸
  watch(sideOpen, () => {
    setTimeout(() => { try { map.target?.invalidateSize() } catch { /* ignore */ } }, 0)
  })
  const zoomIn = () => { try { map.target?.zoomIn() } catch { /* ignore */ } }
  const zoomOut = () => { try { map.target?.zoomOut() } catch { /* ignore */ } }
  const copyCoords = async () => {
    try {
      await navigator.clipboard.writeText(`${mouseLat.value.toFixed(6)}, ${mouseLon.value.toFixed(6)}`)
    } catch { /* ignore */ }
  }
  const sources = ['高德地图（卫星）','高德地图（简图）','高德地图（矢量）','ChinaOnlineCommunity_Mobile','谷歌地图（街道）','谷歌地图（卫星）','谷歌地图（地名）']
</script>

<template >
  <div class="map">
    <!-- 主地图区 -->
    <div class="map-canvas">
      <div id="map"></div>

      <!-- 右侧面板：图源 + 数据列表 -->
      <div v-show="sideOpen" class="map-side">
        <div class="map-side-head">
          <span class="map-side-title"><i class="fa fa-sliders"></i> {{ store.locales=='zh'?'地图面板':'Map Panel' }}</span>
          <button class="map-side-close" @click="sideOpen=false" :title="store.locales=='zh'?'收起面板':'Collapse panel'">×</button>
        </div>
        <div class="map-side-body">
          <!-- 图源区 -->
          <div class="ms-sec" :class="{ collapsed: !sourceOpen }">
            <div class="ms-sec-head" @click="sourceOpen=!sourceOpen">
              <i class="fa ms-caret" :class="sourceOpen?'fa-chevron-down':'fa-chevron-right'"></i>
              <i class="fa fa-globe"></i>
              <span>{{ store.locales=='zh'?'图源':'Source' }}</span>
              <span class="ms-cur" :title="sourceLabel">{{ sourceLabel }}</span>
            </div>
            <div class="ms-sec-body" v-show="sourceOpen">
              <!-- 图源类型：离线 / 在线 / 自定义 -->
              <div class="src-types">
                <button class="src-type" :class="{ active: tileType==='offline' }" @click="chooseTileType('offline')">
                  <i class="fa fa-database"></i> {{ store.locales=='zh'?'离线':'Offline' }}
                </button>
                <button class="src-type" :class="{ active: tileType==='online' }" @click="chooseTileType('online')">
                  <i class="fa fa-globe"></i> {{ store.locales=='zh'?'在线':'Online' }}
                </button>
                <button class="src-type" :class="{ active: tileType==='custom' }" @click="chooseTileType('custom')">
                  <i class="fa fa-link"></i> {{ store.locales=='zh'?'自定义':'Custom' }}
                </button>
              </div>

              <!-- 离线地图：MBTiles 包（无包时散文件兜底） -->
              <template v-if="tileType==='offline'">
                <template v-if="mapTileSources.length">
                  <div class="src-row" v-for="src in mapTileSources" :key="'m'+src.id"
                       :class="{ active: map.source==='mb:'+src.id }" @click="map.source='mb:'+src.id">
                    <i class="fa" :class="map.source==='mb:'+src.id?'fa-dot-circle-o':'fa-circle-o'"></i>
                    <span class="src-name" :title="src.name">{{ src.name }}</span>
                    <span class="src-meta">z{{ src.minZoom }}~{{ src.maxZoom }}</span>
                    <span class="src-builtin" v-if="src.kind==='builtin'">{{ store.locales=='zh'?'内置':'In' }}</span>
                  </div>
                </template>
                <template v-else>
                  <div class="src-tip">{{ store.locales=='zh'?'未挂载离线地图包。请到 设置 → 系统 → 离线地图（MBTiles）挂载后使用。':'No offline map mounted. Mount one in Settings → System → Offline Maps (MBTiles).' }}</div>
                </template>
              </template>

              <!-- 在线地图 -->
              <template v-else-if="tileType==='online'">
                <div class="src-row" v-for="src in onlineSources" :key="'o'+src"
                     :class="{ active: map.source===src }" @click="map.source=src">
                  <i class="fa" :class="map.source===src?'fa-dot-circle-o':'fa-circle-o'"></i>
                  <span class="src-name" :title="src">{{ src }}</span>
                </div>
              </template>

              <!-- 自定义地图：URL + 缩放范围单行编辑（完整说明以 title 提示） -->
              <template v-else>
                <div class="src-custom">
                  <input class="src-custom-url" v-model="map.tileUrl" style="margin:0px"
                         :placeholder="store.locales=='zh'?'瓦片 URL 模板':'Tile URL template'"
                         :title="store.locales=='zh' ? '瓦片 URL 模板，需包含 {z}/{x}/{y} 占位符。例：https://webrd01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}' : 'Tile URL template containing {z}/{x}/{y}. e.g. https://webrd01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}'"/>
                  <input class="src-custom-num" v-model.number="map.min" type="number"
                         style="margin:0px"
                         :title="store.locales=='zh'?'最小缩放':'Min zoom'"
                         :placeholder="store.locales=='zh'?'min':'min'"/>
                  <span class="src-custom-dash">–</span>
                  <input class="src-custom-num" v-model.number="map.max" type="number"
                         style="margin:0px"
                         :title="store.locales=='zh'?'最大缩放':'Max zoom'"
                         :placeholder="store.locales=='zh'?'max':'max'"/>
                  <button class="src-custom-apply" @click="getSource()"
                          :title="store.locales=='zh'?'应用并刷新底图':'Apply and refresh'">{{ store.locales=='zh'?'应用':'Go' }}</button>
                </div>
              </template>
            </div>
          </div>
          <!-- 数据列表区 -->
          <div class="ms-sec data" :class="{ collapsed: !dataOpen }">
            <div class="ms-sec-head" @click="dataOpen=!dataOpen">
              <i class="fa ms-caret" :class="dataOpen?'fa-chevron-down':'fa-chevron-right'"></i>
              <i class="fa fa-list-ul"></i>
              <span>{{ store.locales=='zh'?'数据列表':'Data' }}</span>
              <span class="ms-count">{{ filteredData.length }}</span>
              <button class="ms-filter" :class="{ active: onlyGeo }" @click.stop="onlyGeo=!onlyGeo"
                      :title="store.locales=='zh'?'仅显示有经纬度':'Only geo'"><i class="fa fa-filter"></i></button>
            </div>
            <div class="ms-sec-body" v-show="dataOpen">
              <table class="ms-table">
                <thead><tr><th>{{ store.locales=='zh'?'名称':'Name' }}</th><th>{{ store.locales=='zh'?'纬度':'Lat' }}</th><th>{{ store.locales=='zh'?'经度':'Lon' }}</th></tr></thead>
                <tbody>
                  <tr v-for="(item,index) in filteredData" :key="index">
                    <td class="ms-td-name" :title="item.label"
                        @click="item.attributes?.经度!=null && store.openFileByMode(item)">{{ item.label }}</td>
                    <td v-if="item.attributes?.纬度!=null">{{ Number(item.attributes.纬度).toFixed(3) }}</td><td v-else></td>
                    <td v-if="item.attributes?.经度!=null">{{ Number(item.attributes.经度).toFixed(3) }}</td><td v-else></td>
                  </tr>
                  <tr v-if="!filteredData.length"><td colspan="3" class="ms-empty">{{ store.locales=='zh'?'（无数据）':'(empty)' }}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部状态栏（与代码编辑/阅读视图一致观感） -->
    <div class="map-statusbar">
      <button class="statusbar-btn" @click="zoomIn" :title="store.locales=='zh'?'放大':'Zoom in'"><i class="fa fa-plus"></i></button>
      <button class="statusbar-btn" @click="zoomOut" :title="store.locales=='zh'?'缩小':'Zoom out'"><i class="fa fa-minus"></i></button>
      <span class="statusbar-sep"></span>
      <button class="statusbar-btn" @click="initMap()" :title="store.locales=='zh'?'刷新地图':'Refresh'"><i class="fa fa-refresh"></i></button>
      <button class="statusbar-btn" :class="{ active: tooltipsOn }" @click="toggleTooltips()"
              :title="store.locales=='zh'?'标签显隐':'Tooltips'"><i class="fa fa-tag"></i></button>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ store.locales=='zh'?'深度':'Depth' }}</span>
      <select class="statusbar-select" v-model.number="deep" @change="initMap()" :title="store.locales=='zh'?'读取文件深度':'Read depth'">
        <option v-for="d in maxDepth" :key="d" :value="d">{{ d }}</option>
      </select>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item status-coord" @click="copyCoords" :title="store.locales=='zh'?'点击复制坐标':'Copy coordinates'">
        <i class="fa fa-crosshairs"></i> {{ mouseLat.toFixed(5) }}, {{ mouseLon.toFixed(5) }}
      </span>
      <span class="statusbar-item" :title="store.locales=='zh'?'当前缩放':'Zoom'"><i class="fa fa-search-plus"></i> {{ curZoom }} / {{ map.min }}~{{ map.max }}</span>
      <span class="statusbar-item status-src" :title="sourceLabel"><i class="fa fa-globe"></i> {{ sourceLabel }}</span>
      <button class="statusbar-btn" :class="{ active: sideOpen }" @click="sideOpen=!sideOpen"
              :title="store.locales=='zh'?'右侧面板':'Panel'"><i class="fa fa-columns"></i></button>
    </div>
  </div>
</template>

<style scoped>
  .map{
    position: relative;
    width: 100%;
    height: calc(100% - 1px);
    min-width:120px;
    overflow: hidden;
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    border-bottom:1px solid var(--borderColor);
    flex:2;
    user-select: none;
  }
  /* 主地图区（为底部 24px 状态栏留位） */
  .map-canvas{
    position: relative;
    width: 100%;
    height: calc(100% - 24px);
    overflow: hidden;
  }
  #map{
    position: absolute;
    inset: 0;
    width:100%;
    height:100%;
    z-index: 0;
  }

  /* ===== 右侧面板：图源 + 数据列表 ===== */
  .map-side{
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: 300px;
    display: flex;
    flex-direction: column;
    background-color: var(--backgroundColor);
    border-left: 1px solid var(--borderColor);
    z-index: 1000;
    opacity: 0.98;
    user-select: none;
    box-shadow: -2px 0 6px rgba(0,0,0,.12);
  }
  .map-side-head{
    display:flex; align-items:center; gap:6px;
    height: 30px; padding: 0 6px 0 10px; flex-shrink: 0;
    font-size: 13px; font-weight: 600;
    background: var(--menuColor);
    border-bottom: 1px solid var(--borderColor);
  }
  .map-side-title{ flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; display:flex; align-items:center; gap:6px; }
  .map-side-close{
    border:none; background:transparent; color:var(--fontColor); font-size:16px; line-height:1; cursor:pointer; padding:0 4px;
  }
  .map-side-close:hover{ color:var(--fontActiveColor); }
  .map-side-body{ flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }

  /* 分区：图源区自适应高、数据区撑满剩余 */
  .ms-sec{ display:flex; flex-direction:column; border-bottom:1px solid var(--borderColor); }
  .ms-sec.collapsed{ flex:0 0 auto; }
  .ms-sec.data{ flex:1; min-height:0; }
  .ms-sec-head{
    display:flex; align-items:center; gap:6px; height:28px; padding:0 8px; flex-shrink:0;
    font-size:12px; font-weight:600; color:var(--fontColor);
    background: var(--menuColor); cursor:pointer; user-select:none;
  }
  .ms-sec-head:hover{ background: var(--menuActiveColor); }
  .ms-caret{ font-size:10px; color:var(--borderColor); width:12px; }
  .ms-cur{
    margin-left:auto; font-weight:400; font-size:11px; color:var(--borderColor);
    max-width:45%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .ms-count{
    margin-left:auto; font-weight:400; font-size:11px; background:var(--menuActiveColor);
    border-radius:8px; padding:0 6px; line-height:14px; flex-shrink:0;
  }
  .ms-filter{
    margin-left:auto; border:none; background:transparent; color:var(--borderColor);
    font-size:12px; cursor:pointer; padding:0 2px; flex-shrink:0;
  }
  .ms-filter.active{ color: var(--primaryColor, #1f7de0); }
  .ms-sec-body{ overflow-y:auto; padding: 4px; }
  .ms-sec.data .ms-sec-body{ flex:1; min-height:0; }

  /* 图源类型切换（离线 / 在线 / 自定义） */
  .src-types{
    display:flex; gap:4px; padding:2px 2px 4px;
  }
  .src-type{
    flex:1; height:24px; border:1px solid var(--borderColor); border-radius:4px;
    background: var(--menuColor); color:var(--fontColor); font-size:12px;
    display:inline-flex; align-items:center; justify-content:center; gap:4px;
    cursor:pointer; user-select:none; transition: background .15s; padding:0 2px; white-space:nowrap;
  }
  .src-type:hover{ background: var(--menuActiveColor); }
  .src-type.active{
    color: var(--fontActiveColor); background: var(--menuActiveColor); border-color: var(--fontActiveColor);
  }
  .src-tip{ font-size:11px; color:var(--borderColor); padding:2px 6px; }

  .src-row{
    display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px;
    font-size:12px; cursor:pointer; color:var(--fontColor);
  }
  .src-row:hover{ background: var(--menuActiveColor); }
  .src-row.active{ color: var(--fontActiveColor); background: var(--menuActiveColor); }
  .src-row .fa-dot-circle-o{ color: var(--primaryColor, #1f7de0); }
  .src-row .src-name{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .src-row .src-meta{ font-size:10px; color:var(--borderColor); flex-shrink:0; }
  .src-row .src-builtin{
    font-size:9px; color:var(--primaryColor, #1f7de0); border:1px solid var(--borderColor);
    border-radius:3px; padding:0 3px; flex-shrink:0;
  }
  .src-custom{
    display:flex; align-items:center; gap:4px; padding:0px;
  }
  .src-custom input{
    background: var(--menuColor); border:1px solid var(--borderColor); border-radius:3px;
    color:var(--fontColor); font-size:11px; padding:2px 4px; box-sizing:border-box; height:22px;
  }
  .src-custom .src-custom-url{ flex:1; min-width:40px; }
  .src-custom .src-custom-num{ flex:0 0 40px; width:40px; }
  .src-custom-dash{ color:var(--borderColor); flex-shrink:0; }
  .src-custom-apply{
    flex-shrink:0; margin:0; padding:2px 8px; background: var(--menuColor);
    border:1px solid var(--borderColor); border-radius:3px; color:var(--fontColor);
    font-size:11px; cursor:pointer; height:22px;
  }
  .src-custom-apply:hover{ background: var(--menuActiveColor); }

  /* 数据表格 */
  .ms-table{ width:100%; border-collapse:collapse; font-size:11px; table-layout: fixed; }
  .ms-table th{
    position:sticky; top:0; background: var(--menuColor); color:var(--borderColor); font-weight:600;
    padding:2px 4px; text-align:left; border-bottom:1px solid var(--borderColor);
  }
  .ms-table td{ padding:2px 4px; border-bottom:1px solid var(--borderColor); color:var(--fontColor); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ms-table tr:hover td{ background: var(--menuActiveColor); }
  .ms-td-name{
    cursor:pointer; color: var(--primaryColor, #1f7de0);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .ms-empty{ text-align:center; color:var(--borderColor); padding:8px 0; }

  /* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
  .map-statusbar{
    position:absolute; left:0; right:0; bottom:0;
    display:flex; align-items:center; gap:8px;
    height:24px; box-sizing:border-box; padding:0 8px;
    font-size:12px; color:var(--fontColor);
    background-color:var(--menuColor);
    border-top:1px solid var(--borderColor);
    user-select:none; white-space:nowrap; overflow:hidden;
    z-index: 1100;
  }
  .map-statusbar .statusbar-item{
    display:inline-flex; align-items:center; gap:4px; opacity:.85;
  }
  .map-statusbar .statusbar-item i{ font-size:11px; opacity:.7; }
  .map-statusbar .statusbar-spacer{ flex:1; }
  .map-statusbar .statusbar-btn{
    margin:0; padding:0 6px; height:18px; border:none; border-radius:3px; background:transparent;
    color:var(--fontColor); font-size:12px; display:inline-flex; align-items:center; justify-content:center;
    cursor:pointer; opacity:.85; transition:background-color .15s; flex-shrink:0;
  }
  .map-statusbar .statusbar-btn:hover{ background:var(--menuActiveColor); opacity:1; }
  .map-statusbar .statusbar-btn.active{ color:var(--fontActiveColor); opacity:1; }
  .map-statusbar .statusbar-sep{ width:1px; height:14px; background:var(--borderColor); flex-shrink:0; }
  .map-statusbar .statusbar-select{
    height:18px; border:1px solid var(--borderColor); border-radius:3px;
    background: var(--backgroundColor); color:var(--fontColor); font-size:11px; padding:0 4px;
    width:auto; min-width:44px; max-width:72px; outline:none; cursor:pointer; flex-shrink:0;
  }
  .map-statusbar .statusbar-select option{
    background: var(--backgroundColor); color: var(--fontColor);
  }
  .map-statusbar .status-coord{ cursor:pointer; }
  .map-statusbar .status-coord:hover{ color:var(--fontActiveColor); }
  .map-statusbar .status-src{ max-width:160px; overflow:hidden; text-overflow:ellipsis; }
</style>
