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
      <div class="panel" style="width:100px">
        <span> 基础视图</span>
        <div class="base" @click="toggleDomainView('文件')" title="文件视图">
          <i class="fa fa-folder" style="font-size: 30px;"></i>
        </div>
        <div class="base"  @click="store.app.browser=!store.app.browser"  title="网页视图">
          <i class="iconfont" style="font-size: 30px;">&#xe697;</i>
        </div>
      </div>
      <div class="panel"  style="width:200px">
        <span>领域视图</span>
          <div class="view" @click="toggleDomainView('甘特')" :class="[store.app.domainView.indexOf('甘特')>-1?'active':'']">
            &nbsp;<i class="iconfont">&#xe672;</i>&nbsp; 甘特
          </div>
          <div class="view" @click="toggleDomainView('看板')" :class="[store.app.domainView.indexOf('看板')>-1?'active':'']">
            &nbsp;<i class="fa fa-list-ul"></i>&nbsp; 看板
          </div>
          <div class="view" @click="toggleDomainView('日历')" :class="[store.app.domainView.indexOf('日历')>-1?'active':'']">
            <i class="iconfont" style="font-size: 20px;">&#xe600;</i> 月历
          </div>
          <div class="view" @click="toggleDomainView('图谱')" :class="[store.app.domainView.indexOf('图谱')>-1?'active':'']">
            <i class="iconfont"  style="font-size: 20px;">&#xe662;</i>&nbsp; 图谱
          </div>
          <div class="view" @click="toggleDomainView('年日历')" :class="[store.app.domainView.indexOf('年日历')>-1?'active':'']">
            &nbsp;<i class="fa fa-calendar"></i>&nbsp; 年历
          </div>
          <div class="view" @click="toggleDomainView('地图')" :class="[store.app.domainView.indexOf('地图')>-1?'active':'']">
            <i class="iconfont" style="font-size: 20px;">&#xe884;</i>&nbsp;地图
          </div>
          <div class="view" @click="toggleDomainView('表格')" :class="[store.app.domainView.indexOf('表格')>-1?'active':'']">
            &nbsp;<i class="fa fa-table" ></i>&nbsp; 表格
          </div>
      </div>
      <div class="panel"  style="width:100px">
        <span>对象视图</span>
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
    width:430px;
    height:253px
  }
  .base{
    position: relative;
    width:calc(100% - 50px);
    border:1px solid var(--borderColor);
    border-radius: 5px;
    margin:10px;
    padding:15.5px;
    line-height: 30px;
    font-size: 30px;
  }
  .panel{
    position: relative;
    margin-right:5px;
    float:left;
    border:1px solid var(--borderColor);
    box-shadow:2px 2px 2px var(--menuColor);
    border-radius: 5px;
  }
  .view{
    width:calc(50% - 18px);
    margin:4px;
    padding: 5px;
    float: right;
    border-radius: 5px;
  }
  .view:hover{
    background-color: var(--menuColor);
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
    margin:3.5px;
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