<script setup lang="ts">

  //加载必要插件
  import { ref,onMounted,nextTick } from 'vue'
  import {usestore} from './store'

  //加载导航
  import navView from './components/Nav/nav.vue'

  //加载菜单
  import left from './components/Menu/left.vue'
  import right from './components/Menu/right.vue'
  import tabs from './components/Menu/tabs.vue'

  //加载对话框
  import dialogView from './components/Menu/dialog.vue'
  //加载空视图组件
  import empty from './components/Menu/empty.vue'

  //加载领域组件
  import fileView from './components/Domain/fileView.vue'
  import atlas from './components/Domain/atlas.vue'
  import maps from './components/Domain/maps.vue'
  import board from './components/Domain/board.vue'
  import gantt from './components/Domain/gantt.vue'
  import calendar from './components/Domain/calendar.vue'
  import year from './components/Domain/year.vue'
  import tableDomain from './components/Domain/table.vue'
  
  //加载对象插件
  import explorer from './components/Object/explorer.vue'
  import presentation from './components/Object/md/presentation.vue'
  import codeeditor from './components/Object/codeeditor.vue'
  import mindmap from './components/Object/md/mindmap.vue'
  import browser from './components/Object/browser.vue'
  //加载小窗
  import miniView from './components/Menu/miniView.vue'

  const store=usestore()
  //初始化
  store.init()
  let local=ref<HTMLIFrameElement | null>(null);
  //抓取数据给网络
  let ipcRenderer=null as any
  if(store.app.environment!="web"){
    ipcRenderer = require('electron').ipcRenderer
    //判断是否开启服务器
    if(store.app.server.state==true){
      ipcRenderer.send('OpenServer')
    }
    //判断是否关闭了服务器
    ipcRenderer.on('closeServerOver', (event:any, arg:any) => {
      store.app.server.state=false
    })
  }

  //全屏对话
  const ifFullNav =function(){
    return store.app.navWidth==document.body.clientWidth
  }
  //初始化主题
  document.documentElement.style.setProperty("--backgroundColor",store.app.UI.backgroundColor);
  document.documentElement.style.setProperty("--menuColor",store.app.UI.menuColor);
  document.documentElement.style.setProperty("--menuActiveColor",store.app.UI.menuActiveColor);
  document.documentElement.style.setProperty("--fontColor",store.app.UI.fontColor);
  document.documentElement.style.setProperty("--fontActiveColor",store.app.UI.fontActiveColor);
  document.documentElement.style.setProperty("--borderColor",store.app.UI.borderColor);
  //添加保存配置的事件
  window.addEventListener('keydown', function(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault()
      localStorage.setItem('app',JSON.stringify(store.app))
    }else if(e.which == 27){
      e.preventDefault()
      store.app.UI.isMenu=true
    }
  })
  //主菜单是否显示
  let domainWidth=ref(680)
  //切换侧边栏时，触发resize事件
  const toggle=function(){
    store.app.showNav=!store.app.showNav
    store.app.navWidth=300
    store.resize() //触发缩放
    domainWidth.value = Math.max(Math.min(domainWidth.value,document.body.clientWidth - (store.app.showNav?store.app.navWidth:0) -265),260)
    store.saveApp() //储存配置信息
  }
  
  window.addEventListener('resize', function(){
    store.app.navWidth = Math.max(Math.min(store.app.navWidth,document.body.clientWidth - 262),41)
  })
  onMounted(()=>{
    //导航栏宽度
    let resize = document.getElementById("resize1")! as any
    resize.onmousedown = function(e:any) {
      // 颜色改变提醒
      resize.style.background = "var(--menuActiveColor)";
      let startX = e.clientX;
      resize.left = resize.offsetLeft;
      document.onmousemove = function(e) {
          // 计算并应用位移量
          let endX = e.clientX
          let moveLen = endX - startX
          startX = endX
          store.app.navWidth = Math.max(Math.min(store.app.navWidth + moveLen,document.body.clientWidth - 262),41)
      }
      document.onmouseup = function() {
        // 颜色恢复
        resize.style.background = "";
        document.onmousemove = null;
        document.onmouseup = null;
      }
    }
    //领域视图宽度
    let resize2 = document.getElementById("resize2")! as any
    resize2.onmousedown = function(e:any) {
      // 颜色改变提醒
      resize2.style.background = "var(--menuActiveColor)";
      let startX = e.clientX;
      resize2.left = resize2.offsetLeft;
      document.onmousemove = function(e) {
        // 计算并应用位移量
        let endX = e.clientX
        let moveLen = endX - startX
        startX = endX
        domainWidth.value = Math.max(Math.min(domainWidth.value + moveLen,document.body.clientWidth - (store.app.showNav?store.app.navWidth:0) -265),260)
      }
      document.onmouseup = async function() {
        resize2.style.background = "" // 颜色恢复
        document.onmousemove = null
        document.onmouseup = null
        store.resize() //触发缩放
      }
    }
  })
</script>

<template >
  <div style="height:100vh;width:100%;">
    <div class="App_topMenu" v-if="store.app.UI.isMenu">
        <div class="App_home" @click="toggle">
          <i v-if="!store.app.showNav" class="fa fa-home"></i>
          <i v-if="store.app.showNav" class="fa fa-angle-left" @click=""></i>
        </div>
        <left/>
        <tabs />
        <right v-if="store.app.environment!='web'"/>
    </div>
    <div style="display:flex;width:100%" :style="{height:store.app.UI.isMenu?'calc(100% - 41px)':'calc(100% - 2px)'}">
      <navView :Show="store.app.showNav" v-if="store.app.showNav"/>
      <div class="App_bottomHome" v-if="!store.app.UI.isMenu">
        <i v-if="store.app.showNav" class="fa fa-angle-left" @click="toggle"></i>
        <i v-if="!store.app.showNav&&store.app.environment!='web'" class="fa fa-hand-grab-o" style="-webkit-app-region:drag;"></i>
        <i v-if="!store.app.showNav" class="fa fa-home" @click="toggle"></i>
        <i v-if="!store.app.showNav&&store.app.environment!='web'" class="fa fa-arrows-alt" @click="ipcRenderer.send('fullWindow')"></i>
        <i v-if="!store.app.showNav&&store.app.environment!='web'" class="fa fa-times" @click="ipcRenderer.send('closeWindow')"></i>
      </div>
      <div v-show="store.app.navView!=''&&store.app.showNav" id="resize1"></div>
      <div class="App_bg" v-show="!ifFullNav()" :style="{width:store.app.showNav?'calc(100% - '+store.app.navWidth+'px)':'100%'}">
        <!--内容栏-->
        <div class="App_loacl" v-show="(store.app.domainView.length>0&&store.app.path!='')||(store.app.objectView.length>0&&store.app.files.length>0)" ref="loacl" :style="{top:!store.app.UI.isMenu?'0px':'',height:!store.app.UI.isMenu?'calc(100% - 1px)':''}">
          <div class="App_domain" v-if="store.app.domainView.length>0&&(store.app.environment=='web'||(store.app.environment!='web'&&store.app.storePath!=''))" :style="{width:store.app.objectView.length!=0&&store.app.files.length>0?domainWidth+'px':'100%',maxWidth:store.app.objectView.length!=0&&store.app.files.length>0?'75%':'100%'}">
            <template v-for="(item,index) in store.app.domainView" :key="index">
              <fileView v-if="item=='文件'"/>
              <board v-if="item=='看板'"/>
              <atlas v-if="item=='图谱'"/>
              <maps v-if="item=='地图'"/>
              <gantt v-if="item=='甘特'" />
              <calendar v-if="item=='日历'" />
              <year v-if="item=='年日历'" />
              <tableDomain v-if="item=='表格'"/>
            </template>
          </div>
          <div id="resize2" v-show="store.app.domainView.length>0&&store.app.objectView.length>0"></div>
          <div class="App_object" v-if="store.app.files.length>0&&(store.app.objectView.includes('浏览')||store.app.objectView.includes('演示')||store.app.objectView.includes('导图')||store.app.objectView.includes('编辑'))" :style="{flexDirection:store.app.UI.layout=='column'?'column':'row',width:store.app.domainView.length>0?'calc(100% - '+domainWidth+'px)':'0px',height:store.app.objectView.includes('导图')?'calc(100% - 4px)':'calc(100%)'}">
            <template v-for="(item,index) in store.app.objectView" :key="index">
              <explorer v-if="item=='浏览'"/>
              <presentation v-if="item=='演示'" :key="store.app.fileIndex"/>
              <mindmap v-if="item=='导图'"/>
              <codeeditor v-if="item=='编辑'"/>
            </template>
          </div>
        </div>
        <browser v-if="store.app.browser"/>
        <empty v-if="((store.app.domainView.length==0&&store.app.objectView.length==0)||
        (store.app.domainView.length==0&&store.app.files.length==0))
        &&!store.app.browser"/>
        <!--未选择视图时显示empty组件，未打开文件时显示empty组件，未选择仓库时显示-->
      </div>
      
      <dialogView v-if="store.app.dialog!=''"/>
      <miniView />
    </div>
  </div>
</template>

<style>
  body {
    background-color:var(--backgroundColor);
    color:var(--fontColor);
  }
  #resize1{
    height:100%;
    width:5px;
    margin-left:-5px;
    cursor: col-resize;
    z-index:10;
  }
  #resize2{
    height:100%;
    width:5px;
    margin-left:-5px;
    cursor: col-resize;
    z-index:10;
  }
  .App_bg{
    width:100%;
    height:100%;
    z-index: 5;
    flex: 1;
    flex-direction: row;
    display: flex;
    overflow: hidden;
  }
  .App_topMenu{
    width:100%;
    height:40px;
    background-color: var(--menuColor);
    -webkit-app-region: drag;
    text-align: center;
    border-bottom:1px solid var(--borderColor);
    display:flex;
  }
  .App_bottomHome{
    z-index:999;
    position: fixed;
    bottom:0px;
    margin:10px 5px;
    border-radius: 3px;
    -webkit-app-region:no-drag;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
  }
  .App_bottomHome i{
    padding:6px 12px;
  }
  .App_home{
    padding:3px;
    margin:7px;
    margin-top:6px;
    margin-bottom:6px;
    width:23px;
    float: left;
    white-space:nowrap;
    border-radius: 3px;
    -webkit-app-region:no-drag;
  }
  .App_home:hover{
    background-color:var(--menuActiveColor);
  }

  .App_loacl{
    position: relative;
    flex:2;
    display: flex;
    flex-direction:row;
    height:calc(100% - 0px);
    transition: 0.2s;
    z-index:-1;
    flex-shrink: 0;
  }
  .App_domain{
    position:relative;
    width: calc(100%);
    min-width:160px;
    max-width:100%;
    height: calc(100%);
    margin: 0px;
    padding: 0px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--borderColor);
    z-index:-1
  }
  .App_object{
    position:relative;
    width: calc(100%);
    height: calc(100% - 0px);
    margin: 0px;
    padding: 0px;
    display: flex;
    flex-direction: row;
    flex:5;
    z-index:-1
  }
  .ai{
    position:relative;
    width: calc(100%);
    height: calc(100% - 0px);
    margin: 0px;
    padding: 0px;
    display: flex;
    flex-direction: row;
    flex:3;
    z-index:-1
  }
  /**通用样式*/
  input{
    border-radius:5px;
    color:var(--fontColor);
    background-color: var(--menuColor);
    border:1px solid var(--borderColor);
    font-size: 16px;
    margin-bottom: 2px;
    margin-left:0px;
    height:20px;
    padding: 5px;
    height:24px;
    width:calc(100% - 11px)
  }


  button{
    height:36px;
    border-radius:5px;
    color:var(--fontColor);
    background-color: var(--menuColor);
    font-size: 16px;
    padding: 5px;
    padding-right: 10px;
    padding-left: 10px;
    margin-top: 3px;
    margin-bottom: 5px;
    margin-right: 10px;
    border: 1px solid var(--borderColor);
    white-space: nowrap;
    overflow: hidden;
  }
  span{
    white-space: nowrap;
    display: inline-block;
    text-overflow: ellipsis;
  }
  select{
    color:var(--fontColor);
    background-color: var(--menuColor);
    border:var(--borderColor) 1px solid;
    height:36px;
    border-radius:5px;
    width:100%;
    font-size: 16px;
    outline: none;
  }
  /** 文章渲染样式*/
  h1,h2,h3,h4,h5,h6,p{
    margin:0px;
    margin-bottom:10px;
  }
  ul{
    list-style:disc;
    padding-left:30px
  }
  a{
    color:var(--fontActiveColor);
    text-decoration:none;
    font-size: 16px;
  }
  a:hover{
    background-color:var(--menuColor);
  }
  table{
    width:100%;
    background-color: var(--backgroundColor);
    border-top: 1px solid var(--borderColor);
    border-left: 1px solid var(--borderColor);
    border-spacing: 0;
  }
  table td, table th{
    border-bottom: 1px solid var(--borderColor);
    border-right: 1px solid var(--borderColor);
    height: 32px;
  }
  table thead th
  {
    background-color: var(--menuColor);
    color:var(--fontColor);
  }
  table tr:nth-child(odd)
  {
    background: var(--backgroundColor);
  }
  .noborder{
    border: none;
    margin: 0px;
  }
  .noborder td,th{
    border: none;
  }
  img{
    max-width:100%
  }
  /** 可变宽度样式*/
  .resize{
    resize:horizontal;
    overflow: hidden
  }
  .resize::-webkit-scrollbar {
    width: 5px; height: 5px;
  }
  /** 代码渲染样式和滑块样式*/
  .hljs{
    border: 1px solid var(--borderColor);
    padding: 5px;
    margin-top: 10px;
    margin-bottom: 10px;
    overflow-x: auto;
  }
  .hljs::-webkit-scrollbar,.scoll::-webkit-scrollbar
  {  
    width: 5px;
    height:5px;
  }  
  .hljs::-webkit-scrollbar-track,.scoll::-webkit-scrollbar-track 
  {  
    background-color:var(--menuColor);
  }
  .hljs::-webkit-scrollbar-thumb,.scoll::-webkit-scrollbar-thumb
  {
    background-color:var(--fontActiveColor);
  }
  /**markdown渲染样式*/
  blockquote{
    border-left: 3px solid var(--fontActiveColor);
    margin-left: 9px;
    padding-left: 6px;
    margin-right: 6px;
    background-color: var(--menuColor);
    padding-top:8px;
    padding-bottom:2px;
  }
  /**导航样式*/
  .el-tree {
    --el-tree-node-hover-bg-color: var(--menuActiveColor) !important;
    --el-tree-text-color: var(--fontColor) !important;
    --el-tree-expand-icon-color: var(--fontColor) !important;
  }
  /**甘特图样式*/
  .gantt_container, .gantt_tooltip,.gantt_grid_scale,.gantt_scale_cell,.gantt_task_cell,.gantt_cell,.gantt_cell_tree{
    background-color: var(--backgroundColor) !important;
    color:var(--fontColor) !important;
  }
  .gantt_row, .gantt_task_row{
    border-bottom: 1px solid var(--borderColor) !important;
  }
  .gantt_task_line{
    border: 1px solid var(--borderColor) !important;
  }
  .gantt_task_content{
    background-color: var(--menuColor) !important;
    color:var(--fontColor) !important;
  }
  .gantt_task_line.gantt_selected{
    background-color: var(--menuActiveColor) !important;
    box-shadow: 0 0 10px var(--fontActiveColor) !important;
  }
  .gantt_grid_head_cell{
    background-color: var(--backgroundColor) !important;
    color:var(--fontColor) !important;
  }
  .gantt_scale_cell,.gantt_task_cell{
    border-right: 1px solid var(--borderColor) !important;
  }
  /** 滑块*/
  .gantt_task_vscroll{
    background-color: var(--menuActiveColor) !important;
  }
  .gantt_hor_scroll::-webkit-scrollbar{
    background-color: var(--menuActiveColor) !important;
  }
  .gantt_ver_scroll::-webkit-scrollbar {
    background-color: var(--menuActiveColor) !important;
  }

  /* 定义滚动条轨道的背景颜色 */
  .gantt_hor_scroll::-webkit-scrollbar-track,.gantt_ver_scroll::-webkit-scrollbar-track {
    background-color: var(--menuColor) !important;
    border: 1px solid var(--borderColor);
  }

  /* 定义滚动条滑块的背景颜色 */
  .gantt_hor_scroll::-webkit-scrollbar-thumb,.gantt_ver_scroll::-webkit-scrollbar-thumb {
    background-color: var(--fontActiveColor) !important;
  }

  /* 定义鼠标悬停在滑块上时的背景颜色 */
  .gantt_hor_scroll::-webkit-scrollbar-thumb:hover,.gantt_ver_scroll::-webkit-scrollbar-thumb:hover  {
    background-color: var(--fontActiveColor) !important;
  }

  /* 颜色选择器样式 */
  .el-color-picker__trigger {
    width: 20px !important;
    height: 20px !important;
    border: 0px !important;
    padding:0px !important;
  }
  input[type="range"] {
    position: relative;
    margin: 0px;
    top:4px;
    border-radius: 0px;
    width: calc(100% - 12px);
    -webkit-appearance: none;
    height:15px;
    background-color: var(--backgroundColor);
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    cursor: default;
    height: 20px;
    width: 20px;
    transform: translateY(0px);
    background: none repeat scroll 0 0 var(--fontActiveColor);
    border-radius: 5px;
    border: 1px solid var(--borderColor);
  }
</style>
