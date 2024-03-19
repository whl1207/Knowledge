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
    window.localStorage.removeItem('AIconfig')
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
      <div style="margin-bottom:5px" >{{store.app.locales=='zh'?'语言：':'Language:'}}</div>
      <select v-model="store.app.locales">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
      <div style="margin-bottom:5px">{{store.app.locales=='zh'?'知识库位置：':'Knowledge Base Location:'}}</div>
      <input class="path" style="width:calc(100% - 52px);" v-model="store.app.storePath"/>
      <button class="selectPath" style="width:40px" @click="store.setStorePath()"><i class="fa fa-folder-open-o"></i></button>
      <span >{{store.app.locales=='zh'?'双击操作：':'Double-Click Operation'}}</span>
      <select v-model="store.app.clickToOpen">
        <option value="智能操作">{{store.app.locales=='zh'?'智能操作：':'Smart Operation:'}}</option>
        <option value="本级，无分页">本级，无分页</option>
        <option value="本级，有分页">本级，有分页</option>
        <option value="上级，无分页">上级，无分页</option>
        <option value="上级，有分页">上级，有分页</option>
      </select>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">{{store.app.locales=='zh'?'主题：':'Theme:'}}</div>
      <div style="width:100%">
        <button :class="[store.app.UI.theme=='深色'?'active':'']" @click="store.changeTheme('dark')"><i class="fa fa-moon-o"></i>{{store.app.locales=='zh'?'深色':'Dark'}}</button>
        <button :class="[store.app.UI.theme=='灰色'?'active':'']" @click="store.changeTheme('grey')"><i class="fa fa-moon-o"></i>{{store.app.locales=='zh'?'灰色':'Grey'}}</button>
        <button :class="[store.app.UI.theme=='蓝色'?'active':'']" @click="store.changeTheme('blue')"><i class="fa fa-moon-o"></i>{{store.app.locales=='zh'?'蓝色':'Blue'}}</button>
        <button :class="[store.app.UI.theme=='红色'?'active':'']" @click="store.changeTheme('red')"><i class="fa fa-moon-o"></i>{{store.app.locales=='zh'?'蓝色':'Red'}}</button>
        <button :class="[store.app.UI.theme=='米色'?'active':'']" @click="store.changeTheme('tint')"><i class="fa fa-sun-o"></i>{{store.app.locales=='zh'?'米色':'Beige'}}</button>
        <button :class="[store.app.UI.theme=='白色'?'active':'']" @click="store.changeTheme('white')"><i class="fa fa-sun-o"></i>{{store.app.locales=='zh'?'白色':'White'}}</button>
      </div>
      <span>{{store.app.locales=='zh'?'代码主题：':'Code Theme:'}}</span>
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
      <div style="width:100%;margin-bottom:5px">{{store.app.locales=='zh'?'自定义主题：':'Custom Theme:'}}</div>
      <div style="width:100%">
        <table>
          <tr>
            <td style="min-width: 120px;">{{store.app.locales=='zh'?'背景（默认）':'BG (default)'}}</td>
            <td><el-color-picker v-model="store.app.UI.backgroundColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.backgroundColor"/></td>
          </tr>
          <tr>
            <td style="min-width: 100px;">{{store.app.locales=='zh'?'边框（默认）':'BD (default)'}}</td>
            <td><el-color-picker v-model="store.app.UI.borderColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.borderColor"/></td>
          </tr>
          <tr>
            <td style="min-width: 100px;">{{store.app.locales=='zh'?'菜单（默认）':'Menu (default)'}}</td>
            <td><el-color-picker v-model="store.app.UI.menuColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.menuColor"/></td>
          </tr>
          <tr>
            <td style="min-width: 100px;">{{store.app.locales=='zh'?'菜单（激活）':'Menu (active)'}}</td>
            <td><el-color-picker v-model="store.app.UI.menuActiveColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.menuActiveColor"/></td>
          </tr>
          <tr>
            <td style="min-width: 100px;">{{store.app.locales=='zh'?'字体（默认）':'Font (default)'}}</td>
            <td><el-color-picker v-model="store.app.UI.fontColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.fontColor"/></td>
          </tr>
          <tr>
            <td style="min-width: 100px;">{{store.app.locales=='zh'?'字体（激活）':'Font (active)'}}</td>
            <td><el-color-picker v-model="store.app.UI.fontActiveColor" show-alpha/></td>
            <td><input class="opacity" v-model="store.app.UI.fontActiveColor"/></td>
          </tr>
        </table>
      </div>
      <button style="width:100%" @click="store.changeTheme('自定义')">{{store.app.locales=='zh'?'使用自定义主题':'Use Custom Theme'}}</button>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">{{store.app.locales=='zh'?'演示模式设置':'PowerPoint Configs:'}}</div>
      <div style="width:100%">
        <span>{{store.app.locales=='zh'?'宽度：':'Width:'}}
          <input class="opacity" style="width:calc(100% - 60px)" v-model="store.app.viewSet.presentation.width"/>
        </span>
        <span>{{store.app.locales=='zh'?'高度：':'Height:'}}
          <input class="opacity" style="width:calc(100% - 60px)" v-model="store.app.viewSet.presentation.height"/>
        </span>
      </div>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">{{store.app.locales=='zh'?'界面设置：':'Interface Configs:'}}</div>
      <button style="min-width:30px" @click="focusMode()" :class="[!store.app.UI.isMenu&&store.app.UI.isFull?'active':'']">
        <i class="fa fa-dot-circle-o"></i> {{store.app.locales=='zh'?'专注模式':'Focus Mode:'}}
      </button>
      <button style="min-width:30px" @click="store.app.UI.extension=!store.app.UI.extension" :class="[store.app.UI.extension?'active':'']">
        {{store.app.locales=='zh'?'显示后缀':'Show Suffix'}}
      </button>
      <button style="min-width:30px" @click="fullWindows()" :class="[store.app.UI.isFull?'active':'']">
        <span ><i v-if="!store.app.viewSet.isFull" class="fa fa-arrows-alt"></i></span>
        <span ><i v-if="store.app.viewSet.isFull" class="fa fa-window-restore"></i></span> {{store.app.locales=='zh'?'全屏':'Full Screen'}}
      </button>
      <button style="min-width:30px" @click="store.app.UI.isMenu=!store.app.UI.isMenu" :class="[store.app.UI.isMenu?'active':'']">
        {{store.app.locales=='zh'?'显示标签':'Show Tabs'}}
      </button>
      <button @click="store.app.UI.layout='row'" :class="[store.app.UI.layout=='row'?'active':'']">
        <i class="fa fa-arrows-h"></i> {{store.app.locales=='zh'?'横向布局':'Horizontal'}}
      </button>
      <button @click="store.app.UI.layout='column'" :class="[store.app.UI.layout=='column'?'active':'']">
        <i class="fa fa-arrows-v"></i> {{store.app.locales=='zh'?'纵向布局':'Vertical'}}
      </button>
    </div>
    <div class="panel">
      <div style="width:100%;margin-bottom:5px">{{store.app.locales=='zh'?'系统操作：':'System Operation:'}}</div>
      <button @click="store.app.files=[]">{{store.app.locales=='zh'?'关闭标签':'Close Tabs'}}</button>
      <button @click="initAPP">{{store.app.locales=='zh'?'初始化软件':'Initialize'}}</button>
      <button v-if="store.app.environment!='web'" @click="openConsole">{{store.app.locales=='zh'?'控制台':'Console'}}</button>
      <button v-if="store.app.environment!='web'" @click="clearConsole">{{store.app.locales=='zh'?'清空控制台':'Clear Console'}}</button>
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
    width:calc(100%);
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
