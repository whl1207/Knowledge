<script setup lang="ts">
  import {ref, nextTick,computed,onMounted} from 'vue'
  import {usestore} from './store'
  const store=usestore()

  import SlideAI from './components/SlideAI.vue'
  import file from './components/file.vue'
  import calendar from './components/calendar.vue'
  import explorer from './components/explorer.vue'
  import browser from './components/browser.vue'
  import other from './components/other.vue'
  import knowledge from './components/knowledge.vue'
  import flow from './components/flow.vue'
  import Set from './components/Set.vue'

  const isResizing = ref(false);
  const startX = ref(0);
  const startWidth = ref(0);
  const panelWidth = ref(300); // 初始宽度
  const panelType = ref(""); // 面板类型
  const set = ref(false); // 是否显示设置面板
  const startResize = (e:any) => {
    isResizing.value = true
    startX.value = e.clientX
    startWidth.value = panelWidth.value
    document.addEventListener('mousemove', resize)
    document.addEventListener('mouseup', stopResize)
    store.resize()
  };

  const resize = (e:any) => {
    if (isResizing.value) {
      const deltaX = e.clientX - startX.value;
      panelWidth.value = Math.max(startWidth.value + deltaX, 145); // 设置最小宽度为100px
    }
  };

  const stopResize = () => {
    isResizing.value = false;
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResize);
  }
  store.setTheme()

  onMounted(async () => {
    store.loadConfig()
    if(store.root!=undefined&&store.root!=""){
      store.tree =  await window.ipcRenderer.invoke('getDirectoryTree',store.root)
    }
  })
</script>

<template>
  
  <div class="container">
    <div class="mainPanel" :class="{ 'panel-hide': store.sidePanel }" v-if="!store.sidePanel" :style="{ width: (panelType=='')?'40px':((store.mainPanel=='')?'100%':(panelWidth + 'px')) ,borderRight: (store.mainPanel==''||panelType=='') ? '' : '1px solid var(--borderColor)'}">
      <div style="width: 100%;display: flex">
        <div class="panel-header">
          <div :class="{active:store.mainPanel=='文件'}" @click="panelType='文件';store.mainPanel='文件'" title="文件管理"><i class="fa fa-folder-o"></i></div>
          <div :class="{active:store.mainPanel=='知识库处理'}" @click="store.mainPanel='知识库处理';panelType=''" title="知识库处理"><i class="fa fa-stack-overflow"></i></div>
          <div :class="{active:store.mainPanel=='工作流'}" @click="store.mainPanel='工作流';panelType=''" title="工作流"><i class="fa fa-stumbleupon"></i></div>
          <div :class="{active:store.mainPanel=='独立AI'}" @click="store.mainPanel='独立AI';panelType=''" title="独立AI"><i class="iconfont">&#xe65d;</i></div>
          <div :class="{active:store.mainPanel=='日历'}" @click="panelType='';store.mainPanel='日历'" title="日历"><i class="fa fa-calendar"></i></div>
          <!--<div :class="{active:store.mainPanel=='工具'}" @click="panelType='';store.mainPanel='工具'" title="工具"><i class="fa fa-th"></i></div>-->
          <div style="flex:1;-webkit-app-region: drag;"></div>
          <div :class="{active:set}" @click="set=!set"><i class="fa fa-cogs"></i></div>
        </div>
        <div style="height:calc(100vh - 0px);width: calc(100% - 45px)" v-if="panelType!=''">
          <file v-if="panelType=='文件'"/>
          <SlideAI v-if="panelType=='AI'"/>
        </div>
      </div>
      <div class="panel-draggable" @mousedown="startResize" v-if="store.mainPanel!=''"></div>
    </div>
    <SlideAI v-if="store.mainPanel=='独立AI'" :style="{ width: panelType!=''?('calc(100% - ' + panelWidth + 'px)'):'100%' }"/>
    <explorer v-if="store.mainPanel=='文件'" :style="{ width: 'calc(100% - ' + panelWidth + 'px)' }"/>
    <calendar v-if="store.mainPanel=='日历'" :style="{ width: panelType!=''?('calc(100% - ' + panelWidth + 'px)'):'100%' }"/>
    <browser v-if="store.mainPanel=='网络'" :style="{ width: 'calc(100% - ' + panelWidth + 'px)' }"/>
    <knowledge v-if="store.mainPanel=='知识库处理'" :style="{ width: 'calc(100% - ' + panelWidth + 'px)' }"/>
    <flow v-if="store.mainPanel=='工作流'" :style="{ width: 'calc(100% - ' + panelWidth + 'px)' }"/>
    <other v-if="store.mainPanel=='工具'" :style="{ width: 'calc(100% - ' + panelWidth + 'px)' }"/>
    <div v-if="set" style="position: absolute;width: 70%;left: 15%;top:50px;height:calc(100% - 100px);border: 1px solid var(--fontActiveColor);background-color: var(--menuColor);border-radius: 5px;">
      <Set/>
    </div>
  </div>
</template>

<style>
</style>
