<script setup lang="ts">
  import { ref ,reactive,watch,onMounted, onBeforeUnmount} from 'vue'
  import {usestore} from '../store'

  const store=usestore()
  const help=function(){
    window.open("https://github.com/whl1207/Knowledge", "_blank");
  }
  const openConsole=function(){
    window.ipcRenderer.send('dev',{})
  }
  const toggleFullscreen=function(){
    window.ipcRenderer.send('toggle-fullscreen');
  }
  const startServe = function(){
    window.ipcRenderer.send('toggle-server', 'start')
  }
  const stopServe = function(){
    window.ipcRenderer.send('toggle-server', 'stop')
  }
  let serveState = ref(false)
  
  if(window.ipcRenderer!=undefined){
    window.ipcRenderer.on('server-status', (event, status) => {
      console.log(status)
      serveState.value = status
    })  
  }
  const openFolder = async function() {
    let path = await window.ipcRenderer.invoke('openFolderDialog')
    if(path!=null){
      store.root = path
      store.tree =  await window.ipcRenderer.invoke('getDirectoryTree',path)
      store.path = path
    }
  }
  onMounted(()=>{
    store.getAIconfig()
  })
</script>

<template>
  <div class="bg scoll">
    <div style="display: flex;width:calc(100% - 5px);padding-right: 5px;border-bottom: 1px solid var(--borderColor);-webkit-app-region: drag;">
        <label style="width:49px">{{store.locales=='zh'?'文件:':'file &nbsp;'}}</label>
        <input style="flex:1;-webkit-app-region: no-drag;margin-right: 0px" v-model="store.root"/>
        <div class="button" @click="openFolder" >
          <i class="fa fa-folder-open"></i> 
        </div>
    </div>
    <div style="display: grid;grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));flex:1;align-items: start;border-bottom: 1px solid var(--borderColor);">
      <div style="display: flex;width:100%">
        <label >{{store.locales=='zh'?'语言:':'language'}}</label>
        <select v-model="store.locales" style="width:calc(100% - 70px)">
          <option value="zh">{{store.locales=='zh'?'中文':'chinese'}}</option>
          <option value="en">{{store.locales=='zh'?'英文':'english'}}</option>
        </select>
      </div>
      <div style="display: flex;width:100%">
        <label >{{store.locales=='zh'?'主题：':'theme'}}</label>
        <select v-model="store.UI.theme" style="width:calc(100% - 70px)" @change="store.changeTheme()">
          <option value="深色">{{store.locales=='zh'?'深色':'dark'}}</option>
          <option value="浅色">{{store.locales=='zh'?'亮色':'light'}}</option>
          <option value="灰色">{{store.locales=='zh'?'灰色':'gray'}}</option>
          <option value="自定义">{{store.locales=='zh'?'自定义':'customize'}}</option>
        </select>
      </div>
      <div style="display: flex;width:100%">
        <label >{{store.locales=='zh'?'布局：':'layout'}}</label>
        <select v-model="store.UI.layout" style="width:calc(100% - 70px)">
          <option value="horizontal">{{store.locales=='zh'?'横向':'horizontal'}}</option>
          <option value="vertical">{{store.locales=='zh'?'纵向':'vertical'}}</option>
        </select>
      </div>
    </div>
    <div class="scoll" style="display: grid;grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));align-items: start;" v-if="store.UI.theme=='自定义'">
      <div>
        <label>背景颜色:</label>
        <input v-model="store.UI.backgroundColor" @change="store.changeTheme"/>
      </div>
      <div>
        <label>菜单颜色:</label>
        <input v-model="store.UI.menuColor" @change="store.changeTheme"/>
      </div>
      <div>
        <label>菜单激活:</label>
        <input v-model="store.UI.menuActiveColor" @change="store.changeTheme"/>
      </div>
      <div>
        <label>字体颜色:</label>
        <input v-model="store.UI.fontColor" @change="store.changeTheme"/>
      </div>
      <div>
        <label>字体激活:</label>
        <input v-model="store.UI.fontActiveColor" @change="store.changeTheme"/>
      </div>
      <div>
        <label>边框颜色:</label>
        <input v-model="store.UI.borderColor" @change="store.changeTheme"/>
      </div>
    </div>
    <div class="scoll" style="display: grid;grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));align-items: start;border-bottom: 1px solid var(--borderColor);">
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('浏览')}" @click="store.toggleView('浏览')"><i class="fa fa-book"></i> {{store.locales=='zh'?'浏览':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('编辑')}" @click="store.toggleView('编辑')"><i class="fa fa-code"></i> {{store.locales=='zh'?'编辑':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('导图')}" @click="store.toggleView('导图')"><i class="fa fa-map-o"></i> {{store.locales=='zh'?'导图':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('演示')}" @click="store.toggleView('演示')"><i class="fa fa-television"></i> {{store.locales=='zh'?'演示':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('文件')}" @click="store.toggleView('文件')"><i class="fa fa-folder"></i> {{store.locales=='zh'?'文件':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('看板')}" @click="store.toggleView('看板')"><i class="fa fa-list-ul"></i> {{store.locales=='zh'?'看板':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('图谱')}" @click="store.toggleView('图谱')"><i class="fa fa-xing"></i> {{store.locales=='zh'?'图谱':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('甘特')}" @click="store.toggleView('甘特')"><i class="fa fa-list-alt"></i> {{store.locales=='zh'?'甘特':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('月历')}" @click="store.toggleView('月历')"><i class="fa fa-calendar-o"></i> {{store.locales=='zh'?'月历':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('年历')}" @click="store.toggleView('年历')"><i class="fa fa-calendar-o"></i> {{store.locales=='zh'?'年历':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('地图')}" @click="store.toggleView('地图')"><i class="fa fa-location-arrow"></i> {{store.locales=='zh'?'地图':''}}</div>
      <div class="button" style="width:calc(100% - 27px)" :class="{active:store.isView('表格')}" @click="store.toggleView('表格')"><i class="fa fa-table"></i> {{store.locales=='zh'?'表格':''}}</div>
    </div>
    <div style="display: flex;flex-direction: column;align-items: start;border-bottom: 1px solid var(--borderColor);">
      <div style="display: flex;width:calc(100% - 5px);margin-right:5px">
        <label>{{store.locales=='zh'?'人工智能':'AI type &nbsp;'}}</label>
        <select v-model="store.AIconfig.AI_type" style="flex:1">
          <option v-for="(option, index) in store.AIconfig.AI_types" :key="index" :value="option">{{ option }}</option>
        </select>
      </div>
      <div style="display: flex;width:calc(100% - 5px);margin-right:5px">
        <label>{{store.locales=='zh'?'模型地址':'AI URL &nbsp;'}}</label>
        <input style="flex:1" v-model="store.AIconfig.model_url"/>
        <div class="button" title="AI状态" @click="store.getAIconfig()" :class="{active:store.AIconfig.state}"><i class="iconfont">&#xe65d;</i></div>
      </div>
      <div style="display: flex;width:100%">
        <label>{{store.locales=='zh'?'模型类型':'model &nbsp;&nbsp;'}}</label>
        <select v-model="store.AIconfig.model_type" @click="store.getAIconfig()" style="flex:1">
          <option v-for="(option, index) in store.AIconfig.model_types" :key="index" :value="option.name">{{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})</option>
        </select>
      </div>
      <div style="display: flex;width:100%">
        <label>{{store.locales=='zh'?'声音类型':'TTS type'}}</label>
        <select v-model="store.AIconfig.tts_type" style="flex:1">
          <option value="本地">local</option>
          <option value="GPT_Sovite">GPT_Sovite</option>
        </select>
      </div>
      
      <div style="display: flex;width:100%" v-if="store.AIconfig.tts_type=='GPT_Sovite'">
        <label>{{store.locales=='zh'?'发声地址':'TTS URL'}}</label>
        <input style="width:calc(100% - 90px)" v-model="store.AIconfig.tts_url"/>
      </div>
      <div style="display: flex;width:100%" v-if="store.AIconfig.tts_type=='GPT_Sovite'">
        <label>{{store.locales=='zh'?'发声音色':'TTS voi'}}</label>
        <input style="width:calc(100% - 90px)" v-model="store.AIconfig.tts_voice"/>
      </div>
      <div style="display: flex;width:100%">
        <label>{{store.locales=='zh'?'音转地址':'STT URL'}}</label>
        <input style="width:calc(100% - 90px)" v-model="store.AIconfig.stt_url"/>
      </div>
    </div>
    <div style="display: flex;border-bottom: 1px solid var(--borderColor);">
      <div class="button" @click="startServe" v-if="!serveState" style="width:80px" title="打开服务器"><i class="fa fa-server"></i></div>
      <div class="button" @click="stopServe" v-if="serveState" style="width:80px;color:var(--fontActiveColor)" title="关闭服务器"><i class="fa fa-server"></i></div>
      <input title="文件共享位置" style="display: flex"/>
    </div>
    <div style="display: grid;grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));flex:1;align-items: start;border-bottom: 1px solid var(--borderColor);">
      <div class="button" style="width:calc(100% - 27px)" @click="store.initConfig"><i class="fa fa-refresh"></i></div>
      <div class="button" style="width:calc(100% - 27px)" @click="store.saveConfig"><i class="fa fa-floppy-o"></i></div>
      <div class="button" style="width:calc(100% - 27px)" title="停止朗读" @click="store.stopTTS"><i class="fa fa-volume-off"></i></div>
      <div class="button" @click="toggleFullscreen()" title="全屏"><i class="fa fa-arrows-alt"></i></div>
      <div class="button" @click="openConsole()" title="控制台"><i class="fa fa-terminal"></i></div>
      <div class="button" style="width:calc(100% - 27px)" @click="help" title="帮助"><i class="fa fa-question"></i></div>
      <div class="button" style="width:calc(100% - 27px)" @click="store.exit" title="退出"><i class="fa fa-power-off"></i></div>
    </div>
  </div>
</template>

<style scoped>
  
  .bg {
    position: relative;
    height:calc(100% - 0px);
    overflow-y: auto;
    user-select: none;
  }
</style>

