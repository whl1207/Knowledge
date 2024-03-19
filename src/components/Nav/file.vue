<script setup lang="ts">
  import { ref ,reactive,watch,onMounted, onBeforeUnmount} from 'vue'
  import { ElTree } from 'element-plus'
  import {usestore} from '../../store'
  import file from '../../../electron/file'

  const store=usestore()

  let shell=null as any
  let fs =null as any
  if(store.app.environment!="web"){
    shell = require("electron").shell;
    fs=require("fs")
  }

  //搜索并过滤文件
  const filterText = ref('')
  const treeRef = ref<InstanceType<typeof ElTree>>()
  const filterNode=function(value: string, data: any){
    if (!value) return true
    return data.label.includes(value)
  }
  
  
  let nodeCount=0 //点击的次数
  let preNodeId=null as any //上次点击的点
  let curNodeId=null as any //当前点击的点
  let nodeTimer=null //计时器
  //点击操作
  const click=(data:any)=>{
    nodeCount++
    //双击时打开标签
    if( preNodeId && nodeCount >= 2){
      curNodeId = data.fullPath 
      nodeCount = 0
      if(curNodeId == preNodeId){//第一次点击的节点和第二次点击的节点id相同
        open(data)
        curNodeId = null
        preNodeId = null
        return
      }
    }
    preNodeId = data.fullPath
    nodeTimer = setTimeout(() => { //300ms内没有第二次点击就把第一次点击的清空
      preNodeId  = null
      nodeCount = 0
    },300)
  }
  //应用内打开
  const open=(data:any)=>{
    if(data.type==".md"||data.type==""||data.type==".html"){
      let content=file.getFile(data.fullPath) //文件内容
      data = {...data,content}
    }
    store.addTab(data)
  }
  //默认打开
  const openLocal=(data:any)=>{
    const shell = require("electron").shell
    const fs=require("fs")
    let path = data.parentPath+'\\'+data.fullName
    if(path!=""){
      fs.exists(path, (exists:any) => {
        if (exists) shell.openPath(path)
      })
    }
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
  
  let ifMenu=ref(false)
  let menuPosition=reactive({
    x:0,
    y:0
  })
  //右键点击的文件
  let selectFile=ref({}) as any

  //右键
  const nodeContextmenu=(
    e:any, //事件
    data:any, //数据
    node:any, //node属性
    self:any, //self
  )=>{
    selectFile.value = {
      fullPath:data.fullPath,//文件路径
      parentPath:data.parentPath,//父文件夹路径
      name:data.name,//文件名称，不包含后缀
      fullName:data.fullName,//文件名称，不包含后缀
      type:data.type,//文件类型
    }
    ifMenu.value=true
    menuPosition.x=e.clientX
    menuPosition.y=e.clientY-17
  }
  //开始拖动文件
  let aFile=reactive({
    address:"",
    fullName:"",
  }) //移动或移动文件的地址
  let operateType=ref("") //操作类型
  //结束拖动文件
  const handleDragEnd=(node:any,nextNode:any,event:any)=>{
    console.log(node.data.fullPath)
    console.log(nextNode.data.fullPath+"\\"+node.data.fullName)
    file.move(node.data.fullPath,nextNode.data.fullPath+"\\"+node.data.fullName)
  }
  //复制或剪切
  const copyORcut=(type:any)=>{
    aFile.address=selectFile.value.fullPath;
    aFile.fullName=selectFile.value.fullName;
    operateType.value=type;
    ifMenu.value=false
  }
  //粘贴
  const paste=async function(){
    ifMenu.value=false
    if(operateType.value=="复制"){
      file.copy(aFile.address,selectFile.value.parentPath)
    }else if(operateType.value=="剪切"){
      file.move(aFile.address,selectFile.value.parentPath)
    }
    aFile={
      address:"",
      fullName:"",
    }
    await sleep(100)
    store.catalogue=file.getCatalogue(store.app.storePath)
  }
  //删除
  const del=()=>{
    //关闭已删除页面
    for(let i=0;i<store.app.files.length;i++){
      if(JSON.stringify(store.app.files[i].fullPath)==JSON.stringify(selectFile.value.fullPath)){
        store.app.files.splice(i,1)
      }
    }
    store.app.fileIndex=Math.min(store.app.fileIndex,store.app.files.length-1)
    //删除文件
    file.delFile(selectFile.value.fullPath)
    store.catalogue=file.getCatalogue(store.app.storePath)
    //触发更新
    //store.app.data.nodes=await file.scanDeepFile(store.app.path,1,0)
    ifMenu.value=false
  }
  // 展开节点时触发
  const handleNodeExpand=(data:any)=> {
    // 判断数组中有没有该节点的id
    if (!store.app.defaultExpandedKeys.includes(data.fullPath)) {
      // 没有则添加到数组中
      store.app.defaultExpandedKeys.push(data.fullPath)
    }
  }
  // 折叠节点时触发
  const handleNodeCollapse=(data:any)=> {
    // 判断数组中有没有该节点的id
    if (store.app.defaultExpandedKeys.includes(data.fullPath)) {
      // 有则获取到该id在数组中的下标
      const index = store.app.defaultExpandedKeys.findIndex((item:any) => item === data.id);
      // 然后通过下标删除该节点的id
      store.app.defaultExpandedKeys.splice(index, 1);
    }
  }
  //刷新数据
  const update=()=>{
    if(store.app.storePath==''){
      store.setStorePath()
    }else{
      store.catalogue=file.getCatalogue(store.app.storePath)
    }
  }
  //计算激活页面的颜色
  const color=(data:any)=>{
    let str=""
    if(store.app.files.length!=0){
      if(store.app.files[store.app.fileIndex].cloud==false){
        str = data.fullPath==store.app.files[store.app.fileIndex].fullPath?'var(--fontActiveColor)':''
      }
    }
    return str
  }
  //延迟函数
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  watch(filterText, (val) => {
    treeRef.value!.filter(val)
  })
  watch(()=>store.app.storePath, (newValue, oldValue) => {
    store.catalogue=file.getCatalogue(store.app.storePath)
  })
  onMounted(() => {
    store.catalogue=file.getCatalogue(store.app.storePath)
    //非web环境中监听文件变化
    if(store.app.environment!="web"){
      const fs = require('fs')
      // 监听文件夹
      fs.watchFile(store.app.storePath, (curr:any, prev:any) => {
        store.catalogue=file.getCatalogue(store.app.storePath)
      })
    }
  })
  onBeforeUnmount(() => {
    store.saveApp()
  })
</script>

<template>
  <div class="bg">
    <div class="fixPanel">
      <input v-model="filterText"  :placeholder="store.app.locales=='zh'?'搜索':'Search'" />
    </div>
    <!--文件列表-->
    <div class="content">
      <span style="cursor:pointer;width:calc(100% - 10px);padding:5px" @click="update" @dblclick="store.app.path=store.app.storePath;;store.app.domainView=['文件']" v-if="store.app.storePath!=''">
        <i class="fa fa-folder"></i> {{store.app.storePath}}
      </span>
      <el-tree
        ref="treeRef"
        node-key="fullPath"
        class="catalogue"
        :data="store.catalogue"
        :filter-node-method="filterNode"
        :expand-on-click-node="false"
        :default-expanded-keys="store.app.defaultExpandedKeys"
        @node-click="click"
        @node-contextmenu="nodeContextmenu"
        @node-drag-end="handleDragEnd"
        @node-expand="handleNodeExpand"
        @node-collapse="handleNodeCollapse"
        >
        <template #default="{ node, data }">
          <div class="custom-tree-node">
            <span :style="{color:color(data)}">
              <i :class="store.icon(data.type)"></i>&nbsp; 
              <span v-if="store.app.UI.extension">{{ data.fullName }}</span>
              <span v-if="!store.app.UI.extension">{{ data.name }}</span>
            </span>
          </div>
        </template>
      </el-tree>
    </div>
    <div class="menu" v-if="ifMenu" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
      <ul>
        <li v-if="selectFile.type!=''"><i class="fa fa-folder-open"></i> &nbsp;打开
          <ul>
            <li @click="open(selectFile)">
              <i class="fa fa-file-o"></i>&nbsp;
              内部打开
            </li>
            <li @click="openLocal(selectFile)">
              <i class="fa fa-th"></i>&nbsp;
              外部打开
            </li>
            <li @click="openFolder(selectFile)">
              <i class="fa fa-folder"></i>&nbsp;
              打开位置
            </li>
          </ul>
        </li>
        <li><i class="fa fa-gavel"></i> &nbsp;操作
          <ul>
            <li @click="copyORcut('复制')">
              <i class="fa fa-copy"></i>&nbsp;
              复制
            </li>
            <li @click="copyORcut('剪切')">
              <i class="fa fa-cut"></i>&nbsp;
              剪切
            </li>
            <li v-if="aFile.address!=''&&aFile.fullName!=''&&operateType!=''" @click="paste()">
              <i class="fa fa-clipboard"></i>&nbsp;
              粘贴
            </li>
            <li @click="store.app.dialog='重命名';store.addTab(selectFile)">
              <i class="fa fa-font"></i>&nbsp;
              重命名
            </li>
            <li @click="del()">
              <i class="fa fa-trash-o"></i> &nbsp;
              删除
            </li>
          </ul>
        </li>
        <li><i class="fa fa-plus"></i> &nbsp; 创建
          <ul>
            <li @click="store.app.dialog='创建文档';if(selectFile.type==''){store.app.path=selectFile.fullPath}else{store.app.path=selectFile.parentPath}">
              <i class="fa fa fa-file-text"></i> &nbsp;
              markdown
            </li>
            <li @click="store.app.dialog='创建文件夹';if(selectFile.type==''){store.app.path=selectFile.fullPath}else{store.app.path=selectFile.parentPath}">
              <i class="fa fa-folder"></i> &nbsp;
              文件夹
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
  
  .bg {
    position: relative;
    float: center;
    height:calc(100% - 2px);
  }
  .fixPanel{
    position: relative;
    width:calc(100%);
  }
  .fixPanel input{
    height:31px;
    width:calc(100% - 10px);
    background-color:var(--backgroundColor);
    border-radius: 0px;
    border: 0px;
    border-bottom:1px solid var(--borderColor);
    margin: 0px;
  }
  input:focus{
    outline:none;
  }
  .tools{
    position: relative;
    width:100%;
    height:40px;
    user-select: none;
    -webkit-app-region: drag;
  }
  .tools ul {
    position:absolute;
    margin: 0px;
    padding:4px;
    padding-bottom:3px;
    z-index:999;
    display:block;
    white-space:nowrap;
  }
  
  .tools ul li {
    position: relative;
    height:100%;
    cursor:pointer;
    line-height:100%;
    white-space:nowrap;
    padding:8px;
    width:fit-content;
    display:inline-block;
    text-align: left;
    margin-right: 3px;
    border-radius: 5px;
    -webkit-app-region: no-drag;
  }
  .tools li:hover {
    background:var(--menuActiveColor);
  }
  .tools li>ul{
    left: 0px;
    top: 31px;
    padding:0px;
    width:fit-content;
    min-width:60px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .3);
    border:1px solid var(--borderColor);
    border-radius: 5px;
  }
  .tools li:hover>ul{
    display: block;
  }
  .tools li>ul>li{
    list-style-type:none;
    float:left;
    width:calc(100% - 16px);
  }
  .active{
    background-color: var(--menuActiveColor);
  }
  .menu{
    z-index:9999;
    position:fixed;
  }
  .menu ul{
    position:absolute;
    width:80px;
    border: 1px solid var(--borderColor);
    background-color: var(--menuColor);
    border-radius: 5px;
    list-style-type: none;
    padding-left: 0px;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
  }
  .menu li{
    padding: 2px;
    padding-left: 10px;
    border-radius: 5px;
    width:calc(100% - 12px);
    display:inline-block;
    position: relative;
  }
  .menu li:hover{
    background-color: var(--menuActiveColor);
  }
  .menu li>ul{
    left: 80px;
    top: 0px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
    width:122px;
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    background-color:var(--menuColor);
    list-style-type:none;
    float:left;
    width:110px;
  }
  
  .content{
    position: relative;
    height: calc(100% - 50px);
    float: center;
    overflow-y: auto;
    padding: 5px;
  }
  .content::-webkit-scrollbar {
    display: none;
  }
  
  .catalogue{
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    width:100%;
  }
  .custom-tree-node {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    padding-right:2px;
  }
  .el-tree-node__content:hover{
    background-color: var(--menuColor) !important;
  }
  .el-tree-node__content:focus{
    background-color: var(--menuColor) !important;
  }
  .el-tree-node:hover{
    background-color: var(--menuColor) !important;
  }
  .el-tree-node:focus{
    background-color: var(--menuColor) !important;
  }
  .is-current{
    background-color: var(--menuColor) !important;
  }
</style>

