<script setup lang="ts">

  import {usestore} from '../../store'
  import {ref,reactive,Ref,onMounted,onBeforeUnmount,watch} from 'vue'
  import file from '../../../electron/file'

  //获取数据
  const store=usestore()
  let files=ref({}) as any
  //背景元素
  const filesELE: Ref<HTMLDivElement | null> = ref(null)
  //每个文件的宽度
  const fileWidth: Ref<string> = ref('100%')

  //右键点击的文件
  let selectFile=ref({}) as any

  //右键菜单的样式
  let ifMenu = ref(false)
  let menuPosition = reactive({
    x: 0,
    y: 0
  })

  //上传进度
  let progress=ref(0)

  const getData=async function(){
    if(store.app.environment!="web"){
      //如果不是云端环境
      if(store.app.files.length==0){
        //如果没有打开标签
        files.value=file.scanDeepFile(store.app.path,1,false)
      }else{
        //如果打开了标签
        if(!store.app.files[store.app.fileIndex].cloud){
          //如果是本地的
          files.value=file.scanDeepFile(store.app.path,1,false)
        }else{
          let str = await store.getCloudData("",1,0) as any 
          let t = JSON.parse(str)
          files.value=t.nodes
        }
      }
    }else{
      //如果是云端环境
      let str = await store.getCloudData(store.app.path,1,0) as any 
      let t = JSON.parse(str)
      files.value=t.nodes
    }
  }
  //获取图片地址
  const getAddress=function(item:any){
    if(store.app.environment!="web"){
      return "file:\\"+item.fullPath
    }else{
      return 'http://'+item.ip+"/"+item.fullPath
    }
  }
  // 打开文件
  const open=async function(data:any){
    if(store.app.environment!="web"){
      if(data.type==".md"||data.type==""||data.type==".html"){
        let content=file.getFile(data.fullPath) //文件内容,web端无法使用
        data = {...data,content}
      }
      store.addTab(data)
    }else{
      store.addTab(data)
    }
  }
  //右键菜单
  const nodeContextmenu=function(event:any,item:any){
    event.preventDefault()
    selectFile.value=item
    ifMenu.value=true
    menuPosition.x=event.clientX
    menuPosition.y=event.clientY-17
  }
  //打开位置
  const openFolder=(data:any)=>{
    const shell = require("electron").shell
    const fs=require("fs")
    let path = data.parentPath+'\\'+data.fullName
    if(path!=""){
      fs.exists(path, (exists:any) => {
        if (exists) shell.showItemInFolder(path)
      })
    }
  }
  //从节点下载文件
  const download=()=>{
    //构造地址
    const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port+"/?type=download&parentPath="+selectFile.value.parentPath+"&fullName="+selectFile.value.fullName+""
    var xhr = new XMLHttpRequest()
    //2.告诉ajax请求地址以及请求方式
    xhr.open('get', address)
    xhr.responseType = 'blob'
    xhr.timeout = 500;
    //3.发送请求
    xhr.send();
    //4.获取服务器端给与客户端的响应数据
    xhr.onload = function () {
      if (xhr.readyState == 4) {
        if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
          var blob = new Blob([this.response]);
          var reader = new FileReader(); // 是一个对象，其唯一目的是从 Blob（因此也从 File）对象中读取数据。
          reader.readAsDataURL(blob); // 转换为base64，可以直接放入a标签href
	        reader.onload = (e) => {
	        	// 转换完成，创建一个a标签用于下载
	        	var a = document.createElement("a") as any;
	            a.download = selectFile.value.fullName;
	            a.href = e.target!.result;
	            document.body.appendChild(a);
	            a.click();
	            setTimeout(function(){
	            	document.body.removeChild(a);
	            }, 200)
	        };
        } else {
          console.log("连接失败：请检查网络。")
        }
      }
    }
  }
  //缩放时计算宽度
  const resize=function(){
    const filesWidth = filesELE.value!.offsetWidth
    let width= (filesWidth-5)/16-12
    if(filesWidth>2000){
      width = (filesWidth-5)/16-12
    }else if(filesWidth>1000){
      width = (filesWidth-5)/10-12
    }else if(filesWidth>700){
      width = (filesWidth-5)/6-12
    }else if(filesWidth>400){
      width = (filesWidth-5)/3-12
    }else if(filesWidth>260){
      width = (filesWidth-5)/2-12
    }else{
      width = (filesWidth-5)-12
    }
    fileWidth.value = `${width}px`;
  }
  //计算颜色
  const color =function(item:any){
    if(item.attributes['颜色']!=undefined){
      return item.attributes['颜色']
    }else{
      return 'var(--borderColor)'
    }
  }
  //处理上传事件
  const handleFileDrop = (event:any) => {
    event.preventDefault();
    const files = event.dataTransfer.files
    const afile = files[0]
    // 执行上传操作，例如通过API发送文件给服务器
    if(store.app.environment=='web'){
      uploadFile(afile)
    }else{
      file.copy(afile.path,store.app.path).then((message) => {
        getData() // 文件上传成功，继续后续操作
        store.app.notification="文件已复制到知识库"
      })
      .catch((error) => {
        console.error(error) // 文件上传失败，处理错误
      })
    }
  }
  const uploadFile = (file:any) => {
    const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port+"/?type=upload&path="+store.app.path+"&filename="+file.name
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      // 监听上传进度
      xhr.upload.addEventListener('progress', (event) => {
        if(event.lengthComputable){
          const percentCompleted = Math.round(
            (event.loaded * 100) / event.total
          )
          progress.value = percentCompleted
        }
      })

      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          if (xhr.status === 200) {
            // 处理上传成功的响应
            resolve(xhr.responseText)
            getData()
            store.app.notification="上传成功"
          } else {
            // 处理上传失败的响应
            reject(new Error('File upload failed'))
          }
        }
      }
      xhr.open('POST', address)
      xhr.send(file)
    })
  }
  //删除文件
  const del =function(path:string){
    file.delFile(path)
    getData()
  }
  
  watch(()=>store.app.storePath, (newValue, oldValue) => {
    getData()
  })
  watch(()=>store.app.path, (newValue, oldValue) => {
    getData()
  })
  onMounted(() => {
    getData()
    resize()
    window.addEventListener('resize', resize)
    //非web环境中，监听文件变化
    if(store.app.environment!="web"){
      const fs = require('fs')
      // 监听文件夹
      fs.watchFile(store.app.path, (curr:any, prev:any) => {
        getData()
      })
    }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize)
  })
</script>

<template >
  <!--看板视图-->
  <div class="bg">
    <div class="menu">
        <ul>
          <li @click="store.pathBack()">
            <i class="fa fa-arrow-up"></i>
          </li>
          <li>
            {{store.app.path==""?"根目录":store.app.path}}
          </li>
        </ul>
    </div>
    <div class="files scoll" ref="filesELE" @dragover.prevent @drop="handleFileDrop">
      <!--节点-->
      <div v-for="(item,index) in files" :key="index" :item="item" :index="index" class="file" :style="{ width: fileWidth,color:color(item) }" @dblclick="open(item)" @contextmenu="nodeContextmenu($event,item)">
        <div class="content">
          <i :class="store.icon(item.type)" v-if="!(item.type=='.jpeg'||item.type=='.jpg'||item.type=='.png'||item.type=='.webp')"></i>
          <!--查看图片-->
          <div class="img" v-if="item.type=='.jpeg'||item.type=='.jpg'||item.type=='.png'||item.type=='.webp'">
            <img :src="getAddress(item)" lazy/>
          </div>
        </div>
        <div class="title">{{ item.fullName }}</div>
      </div>
    </div>
    <div class="contextmenu" v-if="ifMenu" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
      <ul>
        <li @click="open(selectFile);ifMenu=false">
          <i class="fa fa-folder-open"></i>&nbsp; 打开
        </li>
        <li @click="openFolder(selectFile);ifMenu=false" v-if="store.app.environment!='web'">
          <i class="fa fa-folder"></i>&nbsp; 打开位置
        </li>
        <li @click="download();ifMenu=false" v-if="(!selectFile.isFolder)&&selectFile.cloud">
          <i class="fa fa-cloud-download"></i>&nbsp; 下载
        </li>
        <li @click="del(selectFile.fullPath);ifMenu=false" v-if="(!selectFile.isFolder)&&!selectFile.cloud">
          <i class="fa fa-trash"></i>&nbsp; 删除
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
  .bg{
    z-index:0;
    width: 100%;
    height: calc(100% - 1px);
    overflow: hidden;
    flex:2;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
  }
  .menu{
    position: relative;
    width:100%;
    height:25px;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
  }
  .menu ul {
    position:absolute;
    margin: 0px;
    padding:0px;
    padding-top:0px;
    z-index:99;
    display:block;
    white-space:nowrap;
  }
  .menu ul li {
    position: relative;
    height:19px;
    cursor:pointer;
    line-height:18px;
    white-space:nowrap;
    padding:3px;
    padding-right:10px;
    padding-left: 10px;
    width:fit-content;
    display:inline-block;
    text-align: left;
  }
  .menu li:hover {
    background:var(--menuActiveColor);
  }
  .menu li>ul{
    left: 0px;
    top: 25px;
    width:fit-content;
    min-width:70px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    list-style-type:none;
    float:left;
    width:calc(100% - 10px);
    padding:5px;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
  .files{
    width:100%;
    height:calc(100% - 26px);
    overflow-y: auto;
  }
  .file{
    position: relative;
    word-wrap: break-word;
    float:left;
    border: 1px solid var(--borderColor);
    margin:5px;
    border-radius: 5px;
  }
  .title{
    position: relative;
    width:calc(100% - 6px);
    display: inline-block;
    user-select: none;
    word-break:keep-all;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    padding: 3px;
    font-size: 14px;
    text-align: center;
    color:var(--fontColor)
  }
  .content{
    border-bottom: var(--borderColor) 1px solid;
    text-align: center;
    height:100px;
    overflow: hidden;
  }
  .content i{
    margin:25px;
    font-size:48px;
  }
  .img{
    text-align: center;
    width:100%;
    height:100%;
  }
  img{
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .contextmenu{
    z-index:10;
    position:fixed;
  }
  .contextmenu ul{
    position:absolute;
    width:110px;
    border: 1px solid var(--borderColor);
    background-color: var(--menuColor);
    border-radius: 5px;
    list-style-type: none;
    padding-left: 0px;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
  }
  .contextmenu li{
    padding: 2px;
    padding-left: 10px;
    border-radius: 5px;
    width:calc(100% - 13px);
    display:inline-block;
    position: relative;
  }
  .contextmenu li:hover{
    background-color: var(--menuActiveColor);
  }
  .contextmenu li>ul{
    left: 108px;
    top: 0px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
    width:130px
  }
  .contextmenu li:hover>ul{
    display: block;
  }
  .contextmenu li>ul>li{
    background-color:var(--menuColor);
    list-style-type:none;
    float:left;
    width:118px;
  }
</style>
