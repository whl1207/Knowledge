<script setup lang="ts">
  import { ref } from 'vue'

  import {usestore} from '../../store'
  const store=usestore()
  let op=ref(false)
  let isTop = ref(false)
  let domain=ref(false)
  let object=ref(false)
  let ipcRenderer=null as any
  if(store.app.environment!="web"){
    ipcRenderer = require('electron').ipcRenderer
  }
  const toggleObjectView=async function(str:string){
    if(store.app.objectView.indexOf(str)==-1){
      store.app.objectView[store.app.objectView.length]=str
    }else{
      store.app.objectView.splice(store.app.objectView.indexOf(str),1)
    }
    store.resize()
  }
  const toggleDomainView=async function(str:string){
    if(store.app.domainView.indexOf(str)==-1){
      store.app.domainView[store.app.domainView.length]=str
    }else{
      store.app.domainView.splice(store.app.domainView.indexOf(str),1)
    }
    store.resize() //触发缩放
  }
  //关闭其他页面
  const closeOther = function () {
    if(store.app.files.length==0||store.app.fileIndex==-1) return
    let temp=store.app.files[store.app.fileIndex]
    store.app.files=[]
    store.app.files[0]=temp
    store.app.fileIndex=0
  }
</script>

<template>
  <div class="Menu_left">
    <i class="fa fa-bars show" @click="op=!op" :class="[op?'active':'']"></i>
    <div class="menu" v-if="op" @click="op=false">
      <ul>
        <li v-if="store.app.environment!='web'">
          <i class="fa fa-folder-o"></i> 打开
            <ul>
              <li @click="store.setStorePath()">
                <i class="fa fa-folder-open"></i> 仓库
              </li>
              <li @click="store.openFile()">
                <i class="fa fa-folder-open"></i> 文件
              </li>
            </ul>
          </li>
        <li  v-if="store.app.environment!='web'">
          <i class="fa fa-plus"></i> 创建
          <ul>
            <li @click="store.app.dialog='创建文件夹'">
              <i class="fa fa-folder"></i> 文件夹
            </li>
            <li @click="store.app.dialog='创建文档'">
              <i class="fa fa-file-text"></i> 文档
            </li>
            <li @click="store.app.dialog='创建白板'">
              <i class="fa fa-file-o"></i> 白板
            </li>
          </ul>
        </li>
        <li>
          <i class="fa fa-adjust"></i> 主题
          <ul>
            <li @click="store.changeTheme('white')">
              <i class="fa fa-sun-o"></i> 浅色主题
            </li>
            <li @click="store.changeTheme('dark')">
              <i class="fa fa-moon-o"></i> 深色主题
            </li>
          </ul>
        </li>
        <li>
          <i class="fa fa-life-buoy"></i> 操作
          <ul>
            <li @click="closeOther">
              <i class="fa fa-bolt"></i> &nbsp; 保留当前
            </li>
            <li v-if="store.app.environment!='web'" @click="ipcRenderer.send('topWindow');isTop=!isTop;">
              <i class="fa fa-unlock-alt" v-if="!isTop"></i> &nbsp;
              <i class="fa fa-lock" v-if="isTop"></i> 置顶窗口
            </li>
            <li v-if="store.app.environment!='web'" @click="ipcRenderer.send('minWindow')">
              <i class="fa fa-desktop"></i> 显示桌面
            </li>
          </ul>
        </li>
        <li v-if="store.app.environment!='web'" @click="ipcRenderer.send('closeWindow')">
          <i class="fa fa-sign-out"></i> 关闭
        </li>
      </ul>
    </div>
    <i @click="toggleDomainView('文件')" :class="[store.app.domainView.indexOf('文件')>-1?'active':'']" class="fa fa-folder show"></i>
    <i @click="domain=!domain" v-if="!domain" class="fa fa-superpowers show"></i>
    <div class="view" v-if="domain">
      <div>
        <i @click="domain=false" class="fa fa-arrow-circle-o-left"></i>
      </div>
      <div @click="toggleDomainView('看板')" :class="[store.app.domainView.indexOf('看板')>-1?'active':'']">
        <i class="fa fa-list-ul"></i>
      </div>
      <div @click="toggleDomainView('图谱')" :class="[store.app.domainView.indexOf('图谱')>-1?'active':'']">
        <i class="fa fa-xing"></i>
      </div>
      <div @click="toggleDomainView('甘特')" :class="[store.app.domainView.indexOf('甘特')>-1?'active':'']">
        <i class="fa fa-calendar-minus-o"></i>
      </div>
      <div @click="toggleDomainView('日历')" :class="[store.app.domainView.indexOf('日历')>-1?'active':'']">
        <i class="fa fa-calendar-o"></i>
      </div>
      <div @click="toggleDomainView('年日历')" :class="[store.app.domainView.indexOf('年日历')>-1?'active':'']">
        <i class="fa fa-calendar"></i>
      </div>
      <div @click="toggleDomainView('地图')" :class="[store.app.domainView.indexOf('地图')>-1?'active':'']">
        <i class="fa fa-location-arrow"></i>
      </div>
      <div @click="toggleDomainView('表格')" :class="[store.app.domainView.indexOf('表格')>-1?'active':'']">
        <i class="fa fa-table"></i>
      </div>
    </div>
    <i @click="object=!object" v-if="!object" class="fa fa-eye show"></i>
    <div class="view" v-if="object">
      <div>
        <i @click="object=false" class="fa fa-arrow-circle-o-left"></i>
      </div>
      <div @click="toggleObjectView('浏览')" :class="[store.app.objectView.indexOf('浏览')>-1?'active':'']">
        <i class="fa fa-book"></i>
      </div>
      <div @click="toggleObjectView('编辑')" :class="[store.app.objectView.indexOf('编辑')>-1?'active':'']">
        <i class="fa fa-code"></i>
      </div>
      <div @click="toggleObjectView('导图')" :class="[store.app.objectView.indexOf('导图')>-1?'active':'']">
        <i class="fa fa-map-o"></i>
      </div>
      <div @click="toggleObjectView('演示')" :class="[store.app.objectView.indexOf('演示')>-1?'active':'']">
        <i class="fa fa-television"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .Menu_left{
    width:fit-content;
    -webkit-app-region:no-drag;
    z-index:999;
    user-select: none;
    height:40px;
    line-height: 30px;
    display: flex;
  }
  .Menu_left .show{
    padding:5px 3px;
    margin-right:7px;
    margin-top:8px;
    margin-bottom:6px;
    width:20px;
    white-space:nowrap;
    border-radius: 3px;
    z-index:99
  }
  .Menu_left .show:hover{
    background-color: var(--menuActiveColor);
  }
  .view{
    margin:5px 0px;
    background-color: var(--menuColor);
    display: flex;
    flex-wrap: nowrap;
    border: var(--borderColor) 1px solid;
    border-radius: 5px;
    transition: 0.5s ease-out;
    width:auto;
    opacity: 1;
    margin-right: 5px;
    z-index:99
  }
  .view div{
    padding: 0px 6px;
    border-radius: 3px;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
  .menu{
    position: absolute;
    left: 41px;
    top: 40px;
    width:70px;
    user-select: none;
    border-radius: 3px;
    background-color: var(--menuColor);
    border:1px solid var(--borderColor);
  }
  .menu ul {
    position:relative;
    padding:0px;
    margin: 0px;
    padding-top:0px;
    z-index:99;
    display:block;
    white-space:nowrap;
    width:calc(100% - 0px);
    background-color:var(--menuColor);
    /**display: none;**/
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
  }
  
  .menu ul li {
    list-style-type:none;
    float:left;
    width:calc(100% - 10px);
    padding:5px;
    height:20px;
    line-height: 20px;
    border: 3px;
    text-align: left;
  }
  .menu li:hover {
    background:var(--menuActiveColor);
  }
  .menu li>ul{
    position: relative;
    left: 65px;
    top: -25px;
    width:fit-content;
    height: fit-content;
    min-width:70px;
    display: none;
    border-top:1px solid var(--borderColor);
    border: 3px;
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    list-style-type:none;
    float:left;
    width:calc(100% - 10px);
    background-color:var(--menuColor);
    padding:5px;
    border-left:1px solid var(--borderColor);
    border-right:1px solid var(--borderColor);
    border-bottom:1px solid var(--borderColor);
  }
</style>
