<script setup lang="ts">
  import { ref ,onBeforeUnmount,computed, reactive} from 'vue'
  import {usestore} from '../../store'

  const store=usestore()
  let ipcRenderer = null as any
  if(store.app.environment!="web"){
    ipcRenderer = require('electron').ipcRenderer
  }
  
  const fullWindows=function() {
    let ipcRenderer = require('electron').ipcRenderer
    ipcRenderer.send('fullWindow');
    store.app.UI.isFull=!store.app.UI.isFull
  }
  const focusMode=function() {
    if(!store.app.UI.isMenu&&store.app.UI.isFull){
      //如果处于专注模式则退出
      store.app.UI.isMenu=true
      store.app.UI.isFull=false
      let ipcRenderer = require('electron').ipcRenderer
      ipcRenderer.send('fullWindow')
    }else{
      //如果不处于专注模式则打开
      //判断全屏状态
      if(!store.app.UI.isFull){
        store.app.UI.isFull=true
        let ipcRenderer = require('electron').ipcRenderer
        ipcRenderer.send('fullWindow')
      }
      //判断顶部栏状态
      if(store.app.UI.isMenu){
        store.app.UI.isMenu=false
      }
    }
  }
  
  const initAPP=function(){
    window.localStorage.removeItem('app')
    window.localStorage.removeItem('atlas')
    if(store.app.environment!="web"){
      let ipcRenderer = require('electron').ipcRenderer
      ipcRenderer.send('closeWindow')
    }else{
      location.reload()
    }
  }

  const openConsole=function(){
    ipcRenderer.send('dev',{})
  }
  const clearConsole=function(){
    console.clear()
  }
  let closeing=ref(false)
  
  onBeforeUnmount(() => {

  })
</script>

<template>
  <div class="bg">
    <div class="panel" v-if="store.app.environment!='web'">
      <div style="margin-bottom:5px">储存库位置：</div>
      <input class="path" style="" v-model="store.app.storePath"/>
      <button class="selectPath" style="width:40px" @click="store.setStorePath()"><i class="fa fa-folder-open-o"></i></button>
      <span >双击操作：</span>
      <select v-model="store.app.clickToOpen">
        <option value="智能操作">智能操作</option>
        <option value="本级，无分页">本级，无分页</option>
        <option value="本级，有分页">本级，有分页</option>
        <option value="上级，无分页">上级，无分页</option>
        <option value="上级，有分页">上级，有分页</option>
      </select>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">主题：</div>
      <div style="width:100%">
        <button :class="[store.app.UI.theme=='深色'?'active':'']" @click="store.changeTheme('dark')"><i class="fa fa-moon-o"></i>深色</button>
        <button :class="[store.app.UI.theme=='灰色'?'active':'']" @click="store.changeTheme('grey')"><i class="fa fa-moon-o"></i>灰色</button>
        <button :class="[store.app.UI.theme=='蓝色'?'active':'']" @click="store.changeTheme('blue')"><i class="fa fa-moon-o"></i>蓝色</button>
        <button :class="[store.app.UI.theme=='红色'?'active':'']" @click="store.changeTheme('red')"><i class="fa fa-moon-o"></i>红色</button>
        <button :class="[store.app.UI.theme=='米色'?'active':'']" @click="store.changeTheme('tint')"><i class="fa fa-sun-o"></i>米色</button>
        <button :class="[store.app.UI.theme=='白色'?'active':'']" @click="store.changeTheme('white')"><i class="fa fa-sun-o"></i>白色</button>
      </div>
      <span>代码：</span>
      <select style="width:calc(100% - 42px)" v-model="store.app.highlightCSS">
        <option label="atom-one-dark.css" value="atom-one-dark.css" />
        <option label="github-dark.css" value="github-dark.css" />
        <option label="default.css" value="default.css" />
        <option label="hybrid.css" value="hybrid.css" />
        <option label="idea.css" value="idea.css" />
        <option label="vs2015.css" value="vs2015.css" />
        <option label="xcode.css" value="xcode.css" />
      </select>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">自定义主题：</div>
      <div style="width:100%">
        <span>背景（默认）：
          <el-color-picker v-model="store.app.UI.backgroundColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.backgroundColor"/>
        </span>
        <span>边框（默认）：
          <el-color-picker v-model="store.app.UI.borderColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.borderColor"/>
        </span>
        <span>菜单（默认）：
          <el-color-picker v-model="store.app.UI.menuColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.menuColor"/>
        </span>
        <span>菜单（激活）：
          <el-color-picker v-model="store.app.UI.menuActiveColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.menuActiveColor"/>
        </span>
        <span>字体（默认）：
          <el-color-picker v-model="store.app.UI.fontColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.fontColor"/>
        </span>
        <span>字体（激活）：
          <el-color-picker v-model="store.app.UI.fontActiveColor" show-alpha/>
          <input class="opacity" v-model="store.app.UI.fontActiveColor"/>
        </span>
      </div>
      <button style="width:100%" @click="store.changeTheme('自定义')">自定义主题</button>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">演示模式：</div>
      <div style="width:100%">
        <span>宽度：
          <input class="opacity" style="width:calc(100% - 60px)" v-model="store.app.viewSet.presentation.width"/>
        </span>
        <span>长度：
          <input class="opacity" style="width:calc(100% - 60px)" v-model="store.app.viewSet.presentation.height"/>
        </span>
      </div>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">模式：</div>
      <button style="min-width:30px" @click="focusMode()" :class="[!store.app.UI.isMenu&&store.app.UI.isFull?'active':'']">
        <i class="fa fa-dot-circle-o"></i> 专注
      </button>
      <button style="min-width:30px" @click="store.app.UI.extension=!store.app.UI.extension" :class="[store.app.UI.extension?'active':'']">
        显示后缀
      </button>
      <button style="min-width:30px" @click="fullWindows()" :class="[store.app.UI.isFull?'active':'']">
        <span ><i v-if="!store.app.viewSet.isFull" class="fa fa-arrows-alt"></i></span>
        <span ><i v-if="store.app.viewSet.isFull" class="fa fa-window-restore"></i></span> 全屏
      </button>
      <button style="min-width:30px" @click="store.app.UI.isMenu=!store.app.UI.isMenu" :class="[store.app.UI.isMenu?'active':'']">
        标签菜单
      </button>
      <button @click="store.app.UI.layout='row'" :class="[store.app.UI.layout=='row'?'active':'']">
        <i class="fa fa-arrows-h"></i> 横向
      </button>
      <button @click="store.app.UI.layout='column'" :class="[store.app.UI.layout=='column'?'active':'']">
        <i class="fa fa-arrows-v"></i>&nbsp; &nbsp;纵向
      </button>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">操作：</div>
      <button @click="store.app.files=[]">关闭标签</button>
      <button @click="initAPP">初始化软件</button>
      <button v-if="store.app.environment!='web'" @click="openConsole">控制台</button>
      <button v-if="store.app.environment!='web'" @click="clearConsole">清空控制台</button>
    </div>
    <div class="panel" v-if="store.app.environment!='web'">
      <div style="width:100%;margin-bottom:5px">版本与环境：</div>
      <span>{{store.app.appPath}}</span><br />
      <span>{{store.app.environment}}</span>
    </div>
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
    overflow: hidden;
  }
  .opacity{
    background-color:rgba(0,0,0,0);
    width:calc(100% - 140px);
    border: none;
    border-bottom: 1px solid var(--borderColor);
    outline: none;
  }
  span{
    font-size: 14px;
  }
  input:focus{
    outline:none;
  }
  .input{
    width:calc(100% - 52px);
    margin:0px;
    top:0px;
    border-radius: 5px 0px 0px 5px;
  }
  button{
    margin-right:0px;
    width:calc(50% - 5px);
    margin-right:5px
  }
  .path{
    width:calc(100% - 52px);
    height:24px;
    margin:0px;
    margin-top:-0px;
    top:0px;
    border-radius: 5px 0px 0px 5px;
  }
  .selectPath{
    position:absolute;
    padding: 0px;
    margin:0px;
    border-radius: 0px 5px 5px 0px;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
</style>
