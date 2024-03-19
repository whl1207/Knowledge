<script setup lang="ts">

  //加载视图组件
  import {usestore} from '../../store'
  import { ref ,onMounted,onBeforeUnmount, reactive,watch} from 'vue'
  import file from '../../../electron/file'
  import 'leaflet/dist/leaflet.css' // 导入 Leaflet 的 CSS 文件
  import L from 'leaflet' // 导入 Leaflet 的 JavaScript 文件

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
    defaultTileLayer:null,
    defaultImageUrl:'public/errorMap.png', //空地图时的图片地址
    markersLayer:null as any, //标记图层
    polygonsLayer:null as any //标记图层
  })
  let nodes = reactive([]) as any
  let markers = reactive([]) as L.Marker[] //所有标记
  let polygons = reactive([]) as L.polygon[] //所有多边形
  const initMap = async function(){
    
    if(map.target!=null){
      map.target.remove()
    }
    nodes=[]
    map.target = L.map('map').setView([map.lat, map.lon], map.zoomLevel)
   
    getSource() // 根据数据源添加底图图层
    map.target.attributionControl.remove() //移除版权信息
    map.target.removeControl(map.target.zoomControl) //移出缩放按钮
    
    //地图点击事件
    map.target.on('click', (e:any)=>{
      map.lat=e.latlng.lat
      map.lon=e.latlng.lng
    })
    //获取节点数据
    if(store.app.environment!="web"){
      //如果是electron环境
      if(store.app.path=="") return //如果未设定仓库和路径
      const fs = require("fs")
      const fileStat = fs.statSync(store.app.path)
      if(!fileStat.isDirectory()) return
      //初始化图布局配置，获取节点和边的信息
      store.app.data.nodes = await file.scanDeepFile(store.app.path,1,0)
    }else{
      //如果是网页端环境
      try {
        let str = await store.getCloudData(store.app.path,1,0) as any
        store.app.data.nodes = JSON.parse(str).nodes
      } catch (error) {
        // 处理错误情况
        console.error(error)
      }
    }
    
    //添加节点到地图
    for(let i=0;i<store.app.data.nodes.length;i++){
      if(store.app.data.nodes[i].attributes.纬度!=undefined&&store.app.data.nodes[i].attributes.经度!=undefined){
        //使用默认标记添加到地图
        //let marker = L.marker([store.app.data.nodes[i].attributes.纬度,store.app.data.nodes[i].attributes.经度]).addTo(map.target)
        
        if(store.app.data.nodes[i].attributes.范围!=null){
          //存在范围字段时，使用圆形标记添加到地图
          let polygon = L.polygon(store.app.data.nodes[i].attributes.范围, {
            color: store.app.data.nodes[i].attributes.颜色 || '#f03',
            fillColor: store.app.data.nodes[i].attributes.颜色 || '#f03',
            fillOpacity: 0.5
          }).addTo(map.target)
          // 创建 Tooltip
          var tooltip = L.tooltip({
            permanent: true,
            direction: 'right',
            offset: [10, 0],
            sticky: true // 设置 sticky 属性为 true
          }).setContent(store.app.data.nodes[i].name)
          // 将Tooltip绑定到标记上
          polygon.bindTooltip(tooltip).openTooltip()
          polygons[polygons.length]=polygon
          polygon.data=store.app.data.nodes[i]
          polygon.on('click', function (e:any) {
            // 点击时打开页面
            store.addTab(polygon.data)
          })
        }else{
          //使用圆形标记添加到地图
          let marker = L.circle([store.app.data.nodes[i].attributes.纬度,store.app.data.nodes[i].attributes.经度], {
            color: store.app.data.nodes[i].attributes.颜色 || '#f03',
            fillColor: store.app.data.nodes[i].attributes.颜色 || '#f03',
            fillOpacity: 0.5,
            radius: store.app.data.nodes[i].attributes.半径 || 10 // 半径（单位：米）
          }).addTo(map.target)
          // 创建 Tooltip
          var tooltip = L.tooltip({
            permanent: true,
            direction: 'right',
            offset: [10, 0],
            sticky: true // 设置 sticky 属性为 true
          }).setContent(store.app.data.nodes[i].name).openTooltip()
          // 将Tooltip绑定到标记上
          marker.bindTooltip(tooltip)
          markers[markers.length]=marker
          marker.data=store.app.data.nodes[i]
          marker.on('click', function (e:any) {
            // 点击时打开页面
            store.addTab(marker.data)
          })
        }
      }
    }
    // 创建标记和多边形的图层组
    map.markersLayer = L.layerGroup(markers)
    map.polygonsLayer = L.layerGroup(polygons)
    // 清除标记和多边形的图层组
    map.markersLayer.clearLayers()
    map.polygonsLayer.clearLayers()
    // 将图层组添加到地图上
    map.target.addLayer(map.markersLayer)
    map.target.addLayer(map.polygonsLayer)
    //聚焦到标记位置
    fitView()
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
    let bounds = L.latLngBounds()
    if(markers.length>0){
      bounds = bounds.extend(markers.map(marker => marker.getLatLng()))
    }
    if(polygons.length>0){
      bounds=bounds.extend(polygons.map(polygon => polygon.getBounds()))
    }
    if(markers.length>0||polygons.length>0){
      map.target.fitBounds(bounds)
    }
  }
  const go = function(){
    map.target.panTo([map.lat, map.lon]);
  }
  const open=function(event:any){
    console.log(event)
    //store.addTab(store.app.data.nodes[i])
  }
  // 手动切换所有 Tooltip 的开关状态
  const toggleTooltips = function() {
    markers.forEach(function(marker) {
      if (marker.isTooltipOpen()) {
        marker.closeTooltip();
      } else {
        marker.openTooltip();
      }
    })
    polygons.forEach(function(polygon) {
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
  watch(()=>store.app.path, (newValue, oldValue) => {
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
    <div v-if="!config" class="bars" @click="config=true">
      <i class="fa fa-bars"></i>
    </div>
    <div class="panel scoll" v-if="config">
      <div class="menu">
        <div @click="initMap()" title="初始化地图"><i class="fa fa-refresh"></i></div>
        <div @click="fitView()" title="聚焦到目标位置"><i class="fa fa-arrows-alt"></i></div>
        <div @click="toggleTooltips()" title="切换提示信息"><i class="fa fa-tag"></i></div>
        <div @click="" title="地图数据"><i class="fa fa-database"></i></div>
        <div @click="config=false" title="关闭控制面板"><i class="fa fa-times"></i></div>
      </div>
      <div class="select">
        <span>MAP URL</span>
        <select v-model="map.source">
          <option value="离线（卫星）">离线（卫星，gcj02）</option>
          <option value="高德地图（卫星）">高德地图（卫星，gcj02）</option>
          <option value="高德地图（简图）">高德地图（简图，gcj02）</option>
          <option value="高德地图（矢量）">高德地图（矢量，gcj02）</option>
          <option value="ChinaOnlineCommunity_Mobile">ChinaOnlineCommunity_Mobile（gcj02）</option>
          <option value="谷歌地图（街道）">谷歌地图（街道，gcj02）</option>
          <option value="谷歌地图（卫星）">谷歌地图（卫星，wgs84）</option>
          <option value="谷歌地图（地名）">谷歌地图（地名，gcj02）</option>
          <option value="自定义">自定义</option>
        </select>
      </div>
      <div class="select" v-if="map.source=='自定义'">
        <span>瓦片地址：</span>
        <input v-model="map.tileUrl"/>
      </div>
      <div class="select" v-if="map.source=='自定义'">
        <span>缩放范围：</span>
        <input v-model="map.min"/>
        <input v-model="map.max"/>
      </div>
      <div class="select">
        <span>{{store.app.locales=='zh'?'跳转到':'Jump to :'}}</span>
        <input v-model="map.lat"/>
        <input v-model="map.lon"/>
        <div style="height:24px;padding:5px 10px;border: 1px solid var(--borderColor);" @click="go()"><i class="fa fa-map-pin"></i></div>
      </div>
      <div class="data scoll">
        <table :key="nodes.length" style="width:100%;text-align: center;">
          <tr>
            <th>{{store.app.locales=='zh'?'名称':'Name'}}</th>
            <th>{{store.app.locales=='zh'?'纬度':'Lat'}}</th>
            <th>{{store.app.locales=='zh'?'经度':'Lon'}}</th>
            <th></th>
          </tr>
          <tr v-for="(item,index) in store.app.data.nodes" :key="index">
            <td>{{ item.name }}</td>
            <td><span v-if="item.attributes.纬度!=undefined" :title="item.attributes.纬度">{{ item.attributes.纬度.toFixed(2) }}</span></td>
            <td><span v-if="item.attributes.纬度!=undefined" :title="item.attributes.经度">{{ item.attributes.经度.toFixed(2) }}</span></td>
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
    flex:4;
    user-select: none;
  }
  #map{
    position: absolute;
    bottom: 0;
    width:100%;
    height:100%;
    z-index: 0
  }
  .bars{
    position: absolute;
    background-color: var(--menuColor);
    opacity: 0.5;
    padding:5px 10px;
    border-radius: 5px;
    right:10px;
    top:5px
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
    opacity: 0.8;
  }
  .menu{
    display: flex;
    width: 100%;
  }
  .menu div{
    flex:1;
    text-align: center;
    border: var(--borderColor) 1px solid;
    background-color: var(--menuColor);
    padding: 5px;
  }
  .select{
    display: flex;
    text-align: center;
    margin: 5px 0px;
  }
  .select span{
    height:32px;
    line-height: 32px;
  }
  .data{
    max-height:calc(100% - 200px);
    overflow-y: auto;
  }
</style>
