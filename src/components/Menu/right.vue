<script setup lang="ts">
  import { ref,watch,onMounted } from 'vue'

  import {usestore} from '../../store'
  const store=usestore()
  //electron通信
  let ipcRenderer=null as any
  if(store.app.environment!="web"){
    ipcRenderer = require('electron').ipcRenderer
  }

  let isTop = ref(false)

  let show = ref(true)
  const max=function(){
    ipcRenderer.send('fullWindow')
  }
  watch(()=>store.app.notification, (newValue, oldValue) => {
    setTimeout(function(){
	    store.app.notification=""
	  }, 1000)
  })
  onMounted(() => {
    store.app.notification=""
  })
</script>

<template>
  <div class="menus" v-if="store.app.notification!=''">
    <transition name="fade">
      <div class="notification" >
        <i class="fa fa-commenting-o"></i> {{store.app.notification}}
      </div>
    </transition>
    <!--
    <div class="menu">
      <i class="fa fa-window-minimize" v-if="!isTop" @click="ipcRenderer.send('minWindow');show=false"></i>
    </div>
    <div class="menu">
      <i class="fa fa-unlock-alt" v-if="!isTop" @click="ipcRenderer.send('topWindow');isTop=!isTop;show=false"></i>
      <i class="fa fa-lock" v-if="isTop" @click="ipcRenderer.send('topWindow');isTop=!isTop;show=false"></i>
    </div>
    <div class="menu" v-if="!isTop">
      <i class="fa fa-times" @click="ipcRenderer.send('closeWindow')"></i>
    </div>-->
  </div>
</template>

<style scoped>
  .menus{
    position: absolute;
    width:fit-content;
    height:32px;
    right:0px;
    color:var(--fontColor);
    background-color: var(--menuColor);
    user-select: none;
    overflow: hidden;
    transition: 0.2s;
    padding:6px;
    padding-bottom:2px;
    border-bottom:var(--borderColor) 1px solid;
    transition: 0.5s;
    z-index:999
  }
  .menu{
    position: relative;
    float:left;
    color:var(--fontColor);
    border-radius: 3px;
    -webkit-app-region: no-drag;
    padding: 4px;
    padding-left: 3px;
    padding-right: 3px;
    user-select: none;
  }
  .menu:hover{
    background-color: var(--menuActiveColor);
  }
  .notification{
    position: relative;
    float:left;
    color:var(--fontColor);
    border-radius: 3px;
    -webkit-app-region: no-drag;
    padding: 4px;
    padding-left: 3px;
    padding-right: 3px;
    user-select: none;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    transition: 1s;
    color:var(--fontActiveColor)
  }
  .fade-enter-active,.fade-leave-active {
    transition: opacity 0.5s;
    animation: blink 1s infinite;
  }
  .fade-enter,
  .fade-leave-to {
    opacity: 0;
  }
  @keyframes blink {
    0% { opacity: 1; }
    50% { opacity: 0.75; }
    100% { opacity: 1; }
  }
  .fa{
    width:24px;
  }
</style>
