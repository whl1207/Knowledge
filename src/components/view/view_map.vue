<script setup lang="ts">

  //加载视图组件
  import {usestore} from '../../store'
  import { ref ,onMounted,onBeforeUnmount, reactive,watch} from 'vue'
  import 'leaflet/dist/leaflet.css' // 导入 Leaflet 的 CSS 文件
  import * as L from 'leaflet' // 导入 Leaflet 的 JavaScript 文件

  const store=usestore()
  let config = ref(false)
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
  const initMap = async function(){
    if(map.target!=null){
      map.target.remove()
    }
    nodes=[]
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
    if(store.root=="") return //如果未设定仓库和路径
    data = await window.ipcRenderer.invoke("getFiles", store.root, 1)
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
        marker.on('click', () => store.addTab(item));
        markers.push(marker);
        map.markersLayer.addLayer(marker);
      }
    })
    fitView() //聚焦到标记位置
  }
  const getSource = function(){
    if(map.defaultTileLayer!=null){
      map.target.removeLayer(map.defaultTileLayer)
    }
    if(map.source=="离线（卫星）"){
      map.tileUrl = "./tiles/6/{z}/{x}/{y}.png"
      map.min=4
      map.max=7
    }else if(map.source=="高德地图（卫星）"){
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
  const fitView = function(){
    /**let bounds = L.latLngBounds()
    if(markers.length>0){
      bounds = bounds.extend(markers.map(marker => marker.getLatLng()))
    }
    if(polygons.length>0){
      bounds=bounds.extend(polygons.map(polygon => polygon.getBounds()))
    }
    if(markers.length>0||polygons.length>0){
      map.target.fitBounds(bounds)
    }**/
  }
  const go = function(){
    map.target.panTo([map.lat, map.lon]);
  }
  const open=function(event:any){
    console.log(event)
    //store.addTab(data[i])
  }
  // 手动切换所有 Tooltip 的开关状态
  const toggleTooltips = function() {
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
  onMounted(() => {
    if(navigator.onLine) {
      map.source="高德地图（卫星）"
    } else {
      map.source="离线（卫星）"
    }
    initMap()
  })
  onBeforeUnmount(() => {
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
  watch(()=>map.tileUrl, (newValue, oldValue) => {//修改瓦片地址
    if(map.defaultTileLayer!=null){
      map.target.removeLayer(map.defaultTileLayer)
    }
    map.defaultTileLayer = L.tileLayer(map.tileUrl, {errorTileUrl: map.defaultImageUrl}).addTo(map.target)
  })
</script>

<template >
  <!--图谱视图-->
  <div class="map">
    <div id="map"></div>
    <div v-if="!config" class="button" style="position: absolute;right:10px;top:5px;" @click="config=true">
      <i class="fa fa-bars"></i>
    </div>
    <div class="panel scoll" v-if="config">
      <div class="menu">
        <div class="button" @click="initMap()" title="初始化地图"><i class="fa fa-refresh"></i></div>
        <div class="button" @click="fitView()" title="聚焦到目标位置"><i class="fa fa-arrows-alt"></i></div>
        <div class="button" @click="toggleTooltips()" title="切换提示信息"><i class="fa fa-tag"></i></div>
        <div class="button" @click="" title="地图数据"><i class="fa fa-database"></i></div>
        <div class="button" @click="config=false" title="关闭控制面板"><i class="fa fa-times"></i></div>
      </div>
      <table :key="nodes.length" style="width:100%;text-align: center;">
        <tr>
          <td>URL</td>
          <td colspan="2">
            <select v-model="map.source">
              <option value="离线（卫星）">{{store.locales=='zh'?'离线（卫星，gcj02）':'Offline (Satellite, gcj02)'}}</option>
              <option value="高德地图（卫星）">{{store.locales=='zh'?'高德地图（卫星，gcj02）':'Amap (satellite, gcj02)'}}</option>
              <option value="高德地图（简图）">{{store.locales=='zh'?'高德地图（简图，gcj02）':'Amap (schematic, gcj02)'}}</option>
              <option value="高德地图（矢量）">{{store.locales=='zh'?'高德地图（矢量，gcj02）':'Amap (vector, gcj02)'}}</option>
              <option value="ChinaOnlineCommunity_Mobile">ChinaOnlineCommunity_Mobile（gcj02）</option>
              <option value="谷歌地图（街道）">{{store.locales=='zh'?'谷歌地图（街道，gcj02）':'Google Maps (Street, gcj02)'}}</option>
              <option value="谷歌地图（卫星）">{{store.locales=='zh'?'谷歌地图（卫星，wgs84）':'Google Maps (satellite, wgs84)'}}</option>
              <option value="谷歌地图（地名）">{{store.locales=='zh'?'谷歌地图（地名，gcj02）':'Google Maps (place name, gcj02)'}}</option>
              <option value="自定义">{{store.locales=='zh'?'自定义':'Custom'}}</option>
            </select>
          </td>
        </tr>
        <tr v-if="map.source=='自定义'">
            <td>{{store.locales=='zh'?'地址':'Address:'}}</td>
            <td colspan="2"><input v-model="map.tileUrl"/></td>
        </tr>
        <tr v-if="map.source=='自定义'">
          <td>{{store.locales=='zh'?'缩放':'zoom:'}}</td>
          <td><input v-model="map.min"/></td>
          <td><input v-model="map.max"/></td>
        </tr>
        <tr>
          <td @click="go()"><i class="fa fa-map-pin"></i></td>
          <td><input v-model="map.lat"/></td>
          <td><input v-model="map.lon"/></td>
        </tr>
      </table>
      <div class="data scoll">
        <table :key="nodes.length" style="width:100%;text-align: center;">
          <tr>
            <th>{{store.locales=='zh'?'名称':'Name'}}</th>
            <th>{{store.locales=='zh'?'纬度':'Lat'}}</th>
            <th>{{store.locales=='zh'?'经度':'Lon'}}</th>
            <th></th>
          </tr>
          <tr v-for="(item,index) in data" :key="index">
            <td>{{ item.name }}</td>
            <td><span v-if="item.attributes!=undefined&&item.attributes.纬度!=undefined" :title="item.attributes.纬度">{{ item.attributes.纬度.toFixed(2) }}</span></td>
            <td><span v-if="item.attributes!=undefined&&item.attributes.纬度!=undefined" :title="item.attributes.经度">{{ item.attributes.经度.toFixed(2) }}</span></td>
            <td><i class="fa fa-eye"></i></td>
          </tr>
        </table>
      </div>
    </div>
    <i class="fa fa-cogs" style="float:right;z-index:10" v-if="!config" @click="config=!config"></i>
  </div>
</template>

<style scoped>
  .map{
    position: relative;
    width: 100%;
    height: 100%;
    min-width:120px;
    overflow: hidden;
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    border-bottom:1px solid var(--borderColor);
    flex:2;
    user-select: none;
  }
  #map{
    position: absolute;
    bottom: 0;
    width:100%;
    height:100%;
    z-index: 0
  }
  .panel{
    position: relative;
    float:right;
    top:5px;
    right:5px;
    padding: 5px;
    width:300px;
    height:fit-content;
    max-height: calc(100% - 20px);
    background-color: var(--backgroundColor);
    border:1px solid var(--borderColor) ;
    overflow-y: auto;
    z-index: 10;
    user-select: none;
    border-radius: 10px;
    opacity: 0.9;
  }
  .menu{
    display: flex;
    width: 100%;
  }
  .menu div{
    flex:1;
  }
  .data{
    max-height:calc(100% - 200px);
    overflow-y: auto;
  }
  select{
    margin: 0px
  }
  input{
    margin: 0px
  }
  td{
    padding: 0px;
  }
</style>
