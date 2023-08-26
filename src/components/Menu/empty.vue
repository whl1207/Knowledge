<script setup lang="ts">
  import { usestore } from '../../store'
  import { onMounted , onBeforeUnmount,nextTick} from 'vue'
  const store = usestore()
  
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
  onMounted(() => {})
  onBeforeUnmount(() => {})
</script>

<template>
  <div class="App_empty">
    <div class="panels">
      <div class="panel">
        <span><i class="fa fa-bandcamp"></i> 领域视图</span>
        <ul>
          <li @click="toggleDomainView('文件')" :class="[store.app.domainView.indexOf('文件')>-1?'active':'']">
            <i class="fa fa-folder"></i>&nbsp; 文件
          </li>
          <li @click="toggleDomainView('看板')" :class="[store.app.domainView.indexOf('看板')>-1?'active':'']">
            <i class="fa fa-list-ul"></i>&nbsp; 看板
          </li>
          <li @click="toggleDomainView('图谱')" :class="[store.app.domainView.indexOf('图谱')>-1?'active':'']">
            <i class="fa fa-xing"></i>&nbsp;&nbsp; 图谱
          </li>
          <li @click="toggleDomainView('地图')" :class="[store.app.domainView.indexOf('地图')>-1?'active':'']">
            <i class="fa fa-xing"></i>&nbsp;&nbsp; 地图
          </li>
          <li @click="toggleDomainView('日历')" :class="[store.app.domainView.indexOf('日历')>-1?'active':'']">
            <i class="fa fa-calendar-o"></i>&nbsp; 日历
          </li>
          <li @click="toggleDomainView('甘特')" :class="[store.app.domainView.indexOf('甘特')>-1?'active':'']">
            <i class="fa fa-list-alt"></i>&nbsp; 甘特
          </li>
          <li @click="toggleDomainView('表格')" :class="[store.app.domainView.indexOf('表格')>-1?'active':'']">
            <i class="fa fa-table"></i>&nbsp; 表格
          </li>
        </ul>
      </div>
      <div class="panel">
        <span><i class="fa fa-file-text"></i> 对象视图</span>
        <ul>
          <li @click="toggleObjectView('浏览')" :class="[store.app.objectView.indexOf('浏览')>-1?'active':'']">
            <i class="fa fa-book"></i>&nbsp; 浏览
          </li>
          <li @click="toggleObjectView('导图')" :class="[store.app.objectView.indexOf('导图')>-1?'active':'']">
            <i class="fa fa-map-o"></i>&nbsp;导图
          </li>
          <li @click="toggleObjectView('演示')" :class="[store.app.objectView.indexOf('演示')>-1?'active':'']">
            <i class="fa fa-television"></i>&nbsp;演示
          </li>
          <li @click="toggleObjectView('编辑')" :class="[store.app.objectView.indexOf('编辑')>-1?'active':'']">
            <i class="fa fa-code"></i>&nbsp;编辑
          </li>
        </ul>
      </div>
      <div class="panel" style="margin-right:0px;">
        <span><i class="fa fa-th"></i> 工具</span>
        <ul>
          <li @click="toggleTool('时钟')" :class="[store.app.tool.indexOf('时钟')>-1?'active':'']">
            <i class="fa fa-clock-o"></i>&nbsp;时钟
          </li>
          <li @click="toggleTool('计时')" :class="[store.app.tool.indexOf('计时')>-1?'active':'']">
            <i class="fa fa-clock-o"></i>&nbsp;计时
          </li>
          <li @click="toggleTool('朗读')" :class="[store.app.tool.indexOf('朗读')>-1?'active':'']">
            <i class="fa fa-volume-up"></i>&nbsp;朗读
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .App_empty{
    flex:1;
    width:100%;
    text-align: center;
    vertical-align: middle;
    background-color: var(--backgroundColor);
    overflow: hidden;
    z-index:-1
  }
  .panels{
    position: relative;
    transform:translate(-50%,-50%);
    left:50%;
    top:50%;
    width:380px;
    height:253px
  }
  .panel{
    position: relative;
    width:calc(33.3% - 10px);
    margin-right:10px;
    float:left;
    border:1px solid var(--borderColor);
    box-shadow:2px 2px 2px var(--menuColor);
    border-radius: 5px;
  }
  span{
    width:calc(100% - 10px);
    background-color: var(--menuColor);
    border-bottom:1px solid var(--borderColor);
    padding:5px;
    border-radius: 5px 5px 0px 0px;
  }
  ul {
    position:relative;
    margin-top: 2px;
    margin-bottom: 4px;
    padding: 0px;
    width:100%;
    margin-block-end:0px;
  }
  li {
    clear:both;
    height:22px;
    cursor:pointer;
    line-height:22px;
    white-space:nowrap;
    width:calc(100% - 28px);
    margin:2px;
    margin-left:4px;
    margin-right:4px;
    display:inline-block;
    position: relative;
    text-align: left;
    padding:5px;
    padding-left: 15px;
    border-radius:5px
  }
  li:hover {
    background-color: var(--menuActiveColor);
  }
  .active{
    background-color: var(--menuActiveColor);
  }
</style>