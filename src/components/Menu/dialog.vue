<script setup lang="ts">

  import {usestore} from '../../store'
  import {ref,onMounted,onBeforeUnmount } from 'vue'
  import file from '../../../electron/file'

  defineProps({
    title: String,
    content: String,
  })

  let data=ref("")
  //读取并解构数据
  const store=usestore()
    
  const save=function(){
    var e = new KeyboardEvent('keydown',{keyCode:83,ctrlKey: true});
    window.dispatchEvent(e);
  }

  //确认操作
  const confirm=function(){
    if(store.app.dialog=='创建文档'){
      if(data.value==""){
        store.app.notification="请输入文件名称"
        return
      }
      let fullPath=""
      if(store.app.path==""){
        fullPath=store.app.storePath
      }else{
        fullPath=store.app.path
      }
      let str =`---
创建时间: ${store.formatTimeStamp(Date.now())}
---
# ${data.value}`
      file.createFile(fullPath,data.value+".md",str)
      store.catalogue=file.getCatalogue(store.app.storePath)
      store.app.data.nodes=file.scanDeepFile(store.app.path,1,false)
    }else if(store.app.dialog=='创建白板'){
      if(data.value==""){
        store.app.notification="请输入白板名称"
        return
      }
      let fullPath=""
      if(store.app.path==""){
        fullPath=store.app.storePath
      }else{
        fullPath=store.app.path
      }
      file.createFile(fullPath,data.value+".wb",JSON.stringify(
        {
          "state": {
            "scale": 1,
            "scrollX": 0,
            "scrollY": 200,
            "scrollStep": 50,
            "backgroundColor": "",
            "showGrid": false,
            "readonly": false,
            "gridConfig": {
                "size": 20,
                "strokeStyle": "#dfe0e1",
                "lineWidth": 1
            }
        },
        "elements": []
        }
      ))
      store.catalogue=file.getCatalogue(store.app.storePath)
      store.app.data.nodes=file.scanDeepFile(store.app.path,1,false)
    }else if(store.app.dialog=='创建文件夹'){
      if(data.value==""){
        store.app.notification="请输入文件夹名称"
        return
      }
      let fullPath=""
      if(store.app.path==""){
        fullPath=store.app.storePath+data.value
      }else{
        fullPath=store.app.path+"\\"+data.value
      }
      file.createFolder(fullPath)
      store.catalogue=file.getCatalogue(store.app.storePath)
      store.app.data.nodes=file.scanDeepFile(store.app.path,1,false)
    }else if(store.app.dialog=='重命名'){
      if(data.value==""){
        store.app.notification="请输入名称"
        return
      }
      let oldName=""
      oldName=store.app.path+"\\"+store.app.files[store.app.fileIndex].fullName
      console.log(oldName)
      let newName=""
      newName=store.app.path+"\\"+data.value+(store.app.files[store.app.fileIndex].type!=""?".":"")+store.app.files[store.app.fileIndex].type
      console.log(newName)
      file.renameFile(oldName,newName)
      //读取目录
      store.catalogue=file.getCatalogue(store.app.storePath)
      //关闭页面
      store.app.files.splice(store.app.fileIndex,1)
      store.app.fileIndex=store.app.files.length-1
    }
    store.app.dialog=''
  }
  const exit = async function(e:any) {
    if (e.keyCode == 27){
      store.app.dialog=''
    }else if (e.keyCode == "13") {
      e.preventDefault()
      confirm()
    }
  }
  onMounted(()=>{
    window.addEventListener('keydown', exit)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', exit)
  })
</script>
    
<template >
  <div class="mask" @click="store.app.dialog=''">
  </div>
  <div class="dialog">
    <div class="title">
      {{store.app.dialog}}
    </div>
    <div class="content">
      <span style="width:calc(100% - 0px);overflow: hidden;" v-if="store.app.dialog=='创建文件夹'||store.app.dialog=='创建文档'||store.app.dialog=='创建白板'">
        位置：
        {{store.app.path}}
      </span>
      <span style="" v-if="store.app.dialog=='创建文件夹'||store.app.dialog=='创建文档'||store.app.dialog=='创建白板'">
        名称：
      </span>
      <input v-model="data"/>
      <div style="float:right">
        <button @click="confirm">确定</button>
        <button @click="store.app.dialog=''">取消</button>
      </div>
    </div>
  </div>
</template>
    
<style scoped>
    
  .mask{
    position: fixed;
    width: 100%;
    height:100%;
    background-color: var(--menuColor);
    opacity: 0.3;
    z-index:20
  }
  .dialog{
    position: fixed;
    float:center;
    transform:translate(-50%,-50%);
    left:50%;
    top:50%;
    width:300px;
    color:var(--fontColor);
    border: 1px solid var(--borderColor);
    background-color: var(--backgroundColor);
    box-shadow:2px 2px 2px rgba(0, 0, 0, .3);
    border-radius: 5px;
    z-index:99
  }
  .title{
    width:calc(100% + 0px);
    background-color: var(--menuColor);
    color:var(--fontActiveColor);
    text-align: center;
    vertical-align: middle;
    height:28px;
    line-height: 28px;
    border-bottom: 1px solid var(--borderColor);
    border-radius: 10px 10px 0px 0px;
  }
  .content{
    width:calc(100% - 10px);
    height:calc(100% - 24px);
    overflow: hidden;
    padding:5px;
  }
  input{
    margin: 5px;
    width:calc(100% - 70px);
    background-color: var(--backgroundColor);
  }
  button{
    margin: 5px;
    margin-top:0px;
    width:calc(50% - 10px)
  }
  button:hover{
    background-color: var(--menuActiveColor);
  }
</style>
    