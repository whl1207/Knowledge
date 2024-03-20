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
      <div style="padding:5px;margin-bottom: 5px;border:1px solid var(--borderColor);box-shadow:2px 2px 2px var(--menuColor);border-radius: 5px;text-align: left;">
        <div>
          <i class="fa fa-folder-open" @click="store.setStorePath()"></i> &nbsp;
          <i class="fa fa-file-text" @click="store.openFile()"></i> &nbsp;
        </div>
      </div>
      <div class="panel">
        <span class="header"><i class="fa fa-superpowers show"></i> {{store.app.locales=='zh'?'领域视图':'Domain View'}}</span>
        <div class="views scoll">
          <div class="view" @click="toggleDomainView('甘特')" :class="[store.app.domainView.indexOf('甘特')>-1?'active':'']">
            &nbsp;<i class="iconfont">&#xe672;</i>&nbsp; <span>{{store.app.locales=='zh'?'甘特':'Gantt'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('看板')" :class="[store.app.domainView.indexOf('看板')>-1?'active':'']">
            &nbsp;<i class="fa fa-list-ul"></i>&nbsp; <span>{{store.app.locales=='zh'?'看板':'Board'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('日历')" :class="[store.app.domainView.indexOf('日历')>-1?'active':'']">
            <i class="iconfont" style="font-size: 20px;">&#xe600;</i> <span>{{store.app.locales=='zh'?'月历':'Month'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('图谱')" :class="[store.app.domainView.indexOf('图谱')>-1?'active':'']">
            <i class="iconfont"  style="font-size: 20px;">&#xe662;</i>&nbsp;<span> {{store.app.locales=='zh'?'图谱':'Chart'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('年日历')" :class="[store.app.domainView.indexOf('年日历')>-1?'active':'']">
            &nbsp;<i class="fa fa-calendar"></i>&nbsp; <span>{{store.app.locales=='zh'?'年历':'Yearly'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('地图')" :class="[store.app.domainView.indexOf('地图')>-1?'active':'']">
            <i class="iconfont" style="font-size: 20px;">&#xe884;</i>&nbsp;<span>{{store.app.locales=='zh'?'地图':'Map'}}</span>
          </div>
          <div class="view" @click="toggleDomainView('表格')" :class="[store.app.domainView.indexOf('表格')>-1?'active':'']">
            &nbsp;<i class="fa fa-table" ></i>&nbsp; <span>{{store.app.locales=='zh'?'表格':'Table'}}</span>
          </div>
        </div>
      </div>
      <div class="panel">
        <span class="header"><i class="fa fa-eye show"></i> {{store.app.locales=='zh'?'对象视图':'Object View'}}</span>
        <div class="views scoll" style="padding:0px 50px">
          <div class="view" @click="toggleObjectView('浏览')" :class="[store.app.objectView.indexOf('浏览')>-1?'active':'']">
            <i class="fa fa-book"></i>&nbsp;<span>{{store.app.locales=='zh'?'浏览':'Browse'}}</span>
          </div>
          <div class="view" @click="toggleObjectView('导图')" :class="[store.app.objectView.indexOf('导图')>-1?'active':'']">
            <i class="fa fa-map-o"></i>&nbsp;<span>{{store.app.locales=='zh'?'导图':'Mind Map'}}</span>
          </div>
          <div class="view" @click="toggleObjectView('演示')" :class="[store.app.objectView.indexOf('演示')>-1?'active':'']">
            <i class="fa fa-television"></i>&nbsp;<span>{{store.app.locales=='zh'?'演示':'Presentation'}}</span>
          </div>
          <div class="view" @click="toggleObjectView('编辑')" :class="[store.app.objectView.indexOf('编辑')>-1?'active':'']">
            <i class="fa fa-code"></i>&nbsp;<span>{{store.app.locales=='zh'?'编辑':'Edit'}}</span>
          </div>
        </div>
      </div>
    </div>
    
    <div style="position: relative;width:100%;text-align: center;top: calc(50% - 100px);">
      <span style="cursor: pointer;" @click="store.app.locales='zh'">中文</span>|
      <span style="cursor: pointer;" @click="store.app.locales='en'">English</span>
    </div>
  </div>
</template>

<style scoped>
  .App_empty{
    flex:1;
    width:100%;
    height:100%;
    background-color: var(--backgroundColor);
    overflow: hidden;
    z-index:-1;
    user-select: none;
  }
  .panels{
    position: relative;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width:450px;
    max-width: calc(100% - 20px);
    display: flex-direction;
  }
  .panel{
    position: relative;
    margin-bottom:5px;
    border:1px solid var(--borderColor);
    box-shadow:2px 2px 2px var(--menuColor);
    border-radius: 5px;
  }
  .views{
    display: flex;
    overflow: hidden;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .view{
    width:calc(100% - 18px);
    margin:4px;
    padding: 5px;
    border-radius: 5px;
    flex: 1;
    text-align: center;
  }
  .view:hover{
    background-color: var(--menuColor);
  }
  .header{
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