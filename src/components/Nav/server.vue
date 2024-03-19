<script setup lang="ts">
  import { ref ,onBeforeUnmount,computed, reactive} from 'vue'
  import {usestore} from '../../store'
  const store=usestore()
  
  let ipcRenderer = null as any
  let net = null as any
  let fs = null as any
  if(store.app.environment!="web"){
    ipcRenderer = require('electron').ipcRenderer
    net = require('net')
    fs = require('fs')
  }
  
  let closeing=ref(false)

  const openServer=function(){
    ipcRenderer.send('OpenServer');
    store.app.server.state=true;
    closeing.value=false;
    store.saveApp()
  }
  const closeServer=function(){
    ipcRenderer.send('CloseServer');
    closeing.value=true
    store.saveApp()
  }
  
  </script>
  
  <template>
    <div class="bg">
      <div class="panel">
        <span style="margin-bottom: 5px;">{{store.app.locales=='zh'?'共享位置':'Share Local'}}</span>
        <input class="path" style="" v-model="store.app.sharePath"/>
        <button class="selectPath" style="width:40px" @click="store.setSharePath()">
          <i class="fa fa-folder-open-o"></i>
        </button>
        <button style="width:100%;" v-if="store.app.server.state==false" @click="openServer()">{{store.app.locales=='zh'?'打开服务':'Open Server'}}</button>
        <button style="width:100%;" v-if="store.app.server.state==true&&closeing==false" @click="closeServer()">{{store.app.locales=='zh'?'关闭服务':'Close Server'}}</button>
        <span style="margin-bottom: 5px;">{{store.app.locales=='zh'?'共享密匙':'Share Key'}}</span>
        <input type="password" v-model="store.app.server.password"/>
      </div>
      <div class="panel" style="height:calc(100% - 210px);overflow:hidden" v-if="store.app.logs.length>0">
        <span style="margin-bottom: 5px;">日志：</span>
        <i class="fa fa-eraser" style="position: absolute; right:8px;top:8px" @click="store.app.logs=[]"></i>
        <div class="scoll" style="height:calc(100% - 40px);width:calc(100% - 12px);overflow-y: auto;background-color: var(--menuColor);border: 1px solid var(--borderColor);padding:5px">
          <ul>
            <li v-for="item,index in store.app.logs.slice().reverse()" :key="index">{{item}}</li>
          </ul>
        </div>
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
  ul{
    list-style:none;
    margin: 0px;
    padding: 0px;
    user-select: none;
    font-size: 11px;
  }
  li{
    cursor:pointer;
  }
  .active{
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
    border-left: 3px solid var(--fontActiveColor);
    padding-left: -3px;
  }
  .tab_content{
    position:relative;
    width:calc(100% - 10px);
    padding: 5px;
    top:0px;
    overflow-x: auto;
    overflow-y: auto;
  }
  .el-select{
    width:calc(50% - 35px);
  }
  button{
    width:100%;
    margin-right: 0px;
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
  .opacity{
    background-color:rgba(0,0,0,0);
    border: none;
    outline: none;
  }
  hr{
    border-bottom:var(--borderColor);
    margin-top: 5px;
    margin-bottom: 5px;
  }
  </style>
  