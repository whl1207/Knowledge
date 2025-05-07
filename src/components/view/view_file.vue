<script setup lang="ts">

  import {usestore} from '../../store'
  import {ref,reactive,onMounted,onBeforeUnmount,watch} from 'vue'

  //获取数据
  const store=usestore()
  let files=ref([]) as any

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
    if (store.path && !(await window.ipcRenderer.invoke('isDirectory', store.path))) {
      return;
    }
    try {
      files.value = await window.ipcRenderer.invoke('getFiles', store.path, 1);
    } catch (error) {
      console.error(error);
    }
  }
  //获取图片地址
  const getAddress=function(item:any){
    return `file:\/\//${item.path.replace(/\\/g, '/')}`
  }
  // 打开文件
  const open=async function(data:any){
    store.addTab(data)
  }
  //右键菜单
  const nodeContextmenu=function(event:any,item:any){
    event.preventDefault()
    selectFile.value=item
    ifMenu.value=true
    menuPosition.x=event.clientX-10
    menuPosition.y=event.clientY-17
  }
  //打开位置
  const openInFolder= async function(data:any){
    window.ipcRenderer.invoke('openInFolder',data.path)
  }
  //缩放时计算宽度
  const resize=function(){
  }
  //计算颜色
  const color =function(item:any){
    if(item.hasOwnProperty('颜色')){
      return item.attributes['颜色']
    }else{
      return 'var(--borderColor)'
    }
  }
  //删除文件
  const del =function(item:any){
    console.log(item)
    //file.delFile(path)
    getData()
  }
  
  watch(()=>store.root, (newValue, oldValue) => {
    getData()
  })
  watch(()=>store.path, (newValue, oldValue) => {
    getData()
  })
  onMounted(() => {
    getData()
    resize()
    window.addEventListener('resize', resize)
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
          <li @click="store.backPath()">
            <i class="fa fa-arrow-up"></i>
          </li>
          <li>
            {{store.path==""?"根目录":store.path}}
          </li>
        </ul>
    </div>
    <div class="files scoll" @dragover.prevent >
      <div v-for="(item,index) in files" :key="index" :item="item" :index="index" :style="{ color:color(item) }" @dblclick="open(item)" @contextmenu="nodeContextmenu($event,item)" class="file" :title="item.fullName">
        <div class="content">
          <i :class="store.icon(item.extension)" v-if="!(item.extension=='.jpeg'||item.extension=='.jpg'||item.extension=='.png'||item.extension=='.webp')"></i>
          <!--查看图片-->
          <div class="img" v-if="item.extension=='.jpeg'||item.extension=='.jpg'||item.extension=='.png'||item.extension=='.webp'">
            <img :src="getAddress(item)" lazy/>
          </div>
        </div>
        <div class="title">{{ item.label }}</div>
      </div>
    </div>
    <div class="contextmenu" v-if="ifMenu" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
      <ul>
        <li @click="open(selectFile);ifMenu=false">
          <i class="fa fa-file-text-o"></i>&nbsp; 打开
        </li>
        <li @click="openInFolder(selectFile);ifMenu=false">
          <i class="fa fa-folder"></i>&nbsp; 系统位置
        </li>
        <!--
        <li @click="del(selectFile);ifMenu=false" v-if="(!selectFile.isFolder)&&!selectFile.cloud">
          <i class="fa fa-trash"></i>&nbsp; 删除
        </li>-->
      </ul>
    </div>
  </div>
</template>

<style scoped>
  .bg{
    z-index:0;
    width: 100%;
    height: calc(100% - 0px);
    overflow: hidden;
    flex:1;
    border-bottom:1px solid var(--borderColor);
    border-right: 1px solid var(--borderColor);
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
    width:calc(100% - 5px);
    height:fit-content;
    max-height:calc(100% - 26px);
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    align-items: start;
    padding:5px 0px 0px 5px;
  }
  .file{
    position: relative;
    word-wrap: break-word;
    border: 1px solid var(--borderColor);
    margin:0px 5px 5px 0px;
    border-radius: 5px;
    height:100px
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
    height:75px;
    overflow: hidden;
  }
  .content i{
    margin:15px;
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
