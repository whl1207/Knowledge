<script setup lang="ts">
  import { onMounted } from 'vue'
  import { usestore } from '../../store'
  import file from '../../../electron/file'

  const store=usestore()

  //切换视图
  const toggleObjectView=async function(str:string){
    if(store.app.objectView.indexOf(str)==-1){
      store.app.objectView[store.app.objectView.length]=str
    }else{
      store.app.objectView.splice(store.app.objectView.indexOf(str),1)
    }
    store.resize() //触发缩放
  }
  const toggleDomainView=async function(str:string){
    if(store.app.domainView.indexOf(str)==-1){
      store.app.domainView[store.app.domainView.length]=str
    }else{
      store.app.domainView.splice(store.app.domainView.indexOf(str),1)
    }
    store.resize() //触发缩放
  }
  //切换工具
  const toggleTool=async function(str:string){
    if(store.app.tool.indexOf(str)==-1){
      store.app.tool[store.app.tool.length]=str
    }else{
      store.app.tool.splice(store.app.tool.indexOf(str),1)
    }
  }
  onMounted(() => {

  })
</script>

<template>
  <div class="bg">
    <div class="panel">
      <div class="title">
        <i class="fa fa-bandcamp"></i> 领域
      </div>
      <button @click="toggleDomainView('文件')" :class="[store.app.domainView.indexOf('文件')>-1?'active':'']">
        <i class="fa fa-folder"></i>&nbsp;文件
      </button>
      <button @click="toggleDomainView('看板')" :class="[store.app.domainView.indexOf('看板')>-1?'active':'']">
        <i class="fa fa-list-ul"></i>&nbsp;看板
      </button>
      <button @click="toggleDomainView('图谱')" :class="[store.app.domainView.indexOf('图谱')>-1?'active':'']">
        <i class="fa fa-xing"></i>&nbsp; 图谱
      </button>
      <button @click="toggleDomainView('甘特')" :class="[store.app.domainView.indexOf('甘特')>-1?'active':'']">
        <i class="fa fa-list-alt"></i>&nbsp;甘特
      </button>
      <button @click="toggleDomainView('日历')" :class="[store.app.domainView.indexOf('日历')>-1?'active':'']">
        <i class="fa fa-calendar-o"></i>&nbsp;月日历
      </button>
      <button @click="toggleDomainView('年日历')" :class="[store.app.domainView.indexOf('年日历')>-1?'active':'']">
        <i class="fa fa-calendar"></i>&nbsp;年日历
      </button>
      <button @click="toggleDomainView('地图')" :class="[store.app.domainView.indexOf('地图')>-1?'active':'']">
        <i class="fa fa-location-arrow"></i>&nbsp; 地图
      </button>
      <button @click="toggleDomainView('表格')" :class="[store.app.domainView.indexOf('表格')>-1?'active':'']">
        <i class="fa fa-table"></i>&nbsp;表格
      </button>
    </div>
    <div class="panel">
      <div class="title">
        <i class="fa fa-file-text"></i> 对象
      </div>
      <button style="" @click="toggleObjectView('浏览')" :class="[store.app.objectView.indexOf('浏览')>-1?'active':'']">
        <i class="fa fa-book"></i>&nbsp; 浏览
      </button>
      <button v-if="store.app.environment!='web'" @click="toggleObjectView('编辑')" :class="[store.app.objectView.indexOf('编辑')>-1?'active':'']">
        <i class="fa fa-code"></i>&nbsp;编辑
      </button>
      <button @click="toggleObjectView('导图')" :class="[store.app.objectView.indexOf('导图')>-1?'active':'']">
        <i class="fa fa-map-o"></i>&nbsp;导图
      </button>
      <button @click="toggleObjectView('演示')" :class="[store.app.objectView.indexOf('演示')>-1?'active':'']">
        <i class="fa fa-television"></i>&nbsp;演示
      </button>
    </div>
    <button style="width:100%" @click="if(store.app.miniView.length>0){store.app.miniView=[];}else{store.app.miniView=['导图'];}" :class="[store.app.miniView.length>0?'active':'']">
      <i class="fa fa fa-podcast"></i>&nbsp; 小窗视图
    </button>
    <button style="width:100%" @click="store.app.domainView=[];store.app.objectView=[];">
      <i class="fa fa fa-square-o"></i>&nbsp; 清空视图
    </button>
  </div>
</template>

<style scoped>
  
  .bg{/** 背景 */
    position: relative;
    float:center;
    z-index:10;
    width: calc(100% - 10px);
    height: calc(100% - 10px);
    color: var(--fontColor);
    background-color:var(--backgroundColor);
    overflow-y: auto;
    padding: 5px;
  }
  .bg::-webkit-scrollbar {
    display: none;
  }
  .panel{
    position: relative;
    width:calc(100% - 12px);
    border-radius: 5px;
    border: 1px solid var(--borderColor);
    padding: 5px;
    margin-bottom: 5px;
  }
  .title{
    margin-bottom: 5px;
  }
  button{
    width:50%;
    margin-right:0px;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
</style>

