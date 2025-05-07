<script setup lang="ts">
  import { ref,watch,onMounted, onBeforeUnmount} from 'vue'
  import {usestore} from '../store'
  import { ElTree } from 'element-plus'
  import search from './search.vue'
  import AI from './SlideAI.vue'
  const store=usestore()
  
  const filterText = ref('') //搜索并过滤文件
  const treeRef = ref<InstanceType<typeof ElTree>>() //树状图数据
  const expandedKeys = ref<string[]>([]); //展开状态数据

  const filterNode=function(value: string, data: any){
    if (!value) return true
    return data.label.includes(value)
  }
  
  //点击操作
  let nodeCount=0 //点击的次数
  let preNodeId=null as any //上次点击的点
  let curNodeId=null as any //当前点击的点
  let mode = ref('file') as any //侧边栏使用模式
  let nodeTimer=null //计时器
  const showInput = ref(false);
  const newFileName = ref('');
  const click=function(data:any){
    nodeCount++
    //双击时打开标签
    if( preNodeId && nodeCount >= 2){
      curNodeId = data.path 
      nodeCount = 0
      if(curNodeId == preNodeId){//第一次点击的节点和第二次点击的节点id相同
        //判断是否打开了
        store.addTab(data)
        curNodeId = null
        preNodeId = null
        return
      }
    }
    preNodeId = data.path
    nodeTimer = setTimeout(() => { //300ms内没有第二次点击就把第一次点击的清空
      preNodeId  = null
      nodeCount = 0
    },300)
  }
  //打开文件夹
  const openFolderDialog = async function() {
    let path = await window.ipcRenderer.invoke('openFolderDialog')
    if(path!=null){
      store.root = path
      store.tree =  await window.ipcRenderer.invoke('getDirectoryTree',path)
      store.path = path
    }
    store.saveConfig()
  }
  //通过对话框，打开其他文件
  const openFileDialog = async function() {
    const path =  await window.ipcRenderer.invoke('openFileDialog')
    openFile(path)
  }
  //通过路径打开文件
  const openFile = async function(path:any) {
    if(path!=null){
      const inf = await window.ipcRenderer.invoke('getInf', path); //获取信息
      const attributes = await window.ipcRenderer.invoke('getConfig', path); //获取属性
      const fileContent = await window.ipcRenderer.invoke('readFile', path)
      store.addTab({
        ...inf,
        attributes:attributes,
        path:path,
        content:fileContent,
      })
    }
  }
  //创建文件
  const createFile = async (fileName: string) => {
    if (!store.root) {
      alert('请先打开一个文件夹');
      return;
    }
    const path = await window.ipcRenderer.invoke('createFile', store.root, fileName+'.md');
    if (path) {openFile(path)}
    store.tree = await window.ipcRenderer.invoke('getDirectoryTree', store.root);
  };
  //右键菜单变量
  const contextMenu = ref({
    visible: false,
    style: {
      top: '0px',
      left: '0px',
    },
    node: null as any,
  });
  //右键菜单逻辑
  const handleRightClick = (event: MouseEvent, data: any) => {
    event.preventDefault(); // 阻止默认的右键菜单
    contextMenu.value.visible = true;
    contextMenu.value.style.left = `${event.clientX-40}px`;
    contextMenu.value.style.top = `${event.clientY}px`;
    contextMenu.value.node = data;
  };
  //展开状态记录
  const handleNodeExpand = (data: any) => {
    if (!expandedKeys.value.includes(data.path)) {
      expandedKeys.value.push(data.path);
    }
  };

  const handleNodeCollapse = (data: any) => {
    const index = expandedKeys.value.indexOf(data.path);
    if (index !== -1) {
      expandedKeys.value.splice(index, 1);
    }
  };
  //删除文件
  const deleteFile = async () => {
    if (contextMenu.value.node) {
      const path = contextMenu.value.node.path;
      const confirmDelete = confirm(`确定要删除文件 ${path} 吗？`);
      if (confirmDelete) {
        await window.ipcRenderer.invoke('deleteFile', path);
        store.tree = await window.ipcRenderer.invoke('getDirectoryTree', store.root);
        contextMenu.value.visible = false;
      }
    }
  };
  document.addEventListener('click', () => {
    contextMenu.value.visible = false;
  });
  const hideContextMenu = () => {
    contextMenu.value.visible = false;
  };
  watch(filterText, (val) => {
    treeRef.value!.filter(val)
  })
  const init = async function() {
    if(store.root!='') store.tree = await window.ipcRenderer.invoke('getDirectoryTree',store.root)
  }
  onMounted(()=>{
    init()
  })
  onBeforeUnmount(() => {
  })
</script>

<template>
  <div class="bg">
    <!--工具-->
    <div class="fixPanel">
      <div style="display: flex;">
        <div class="button" style="flex:1" :class="{active:mode=='file'}" @click="mode='file'">
          <i class="fa fa-folder-o"></i>
        </div>
        <div class="button" style="flex:1" :class="{active:mode=='search'}" @click="mode='search'" v-if="store.root!=''">
          <i class="fa fa-search"></i> 
        </div>
        <div class="button" style="flex:1" :class="{active:mode=='AI'}" @click="mode='AI'">
          <i class="iconfont">&#xe65d;</i>
        </div>
      </div>
    </div>
    <!--文件-->
    <div class="fileList scoll" v-if="mode=='file'">
      <div style="padding-bottom: 5px;user-select: none;flex:1;display: flex;white-space: nowrap;" :title="store.root">
        <div class="button" style="margin: 0px 0px 0px 5px;" @click="openFolderDialog" title="打开文件夹" v-if="mode=='file'">
          <i class="fa fa-folder-open"></i> 
        </div>
        <div class="button" style="margin: 0px 0px 0px 5px;" @click="openFileDialog" title="打开文件" v-if="mode=='file'">
          <i class="fa fa-file-text"></i> 
        </div>
        <div class="button" style="margin: 0px 0px 0px 5px;" @click="showInput = !showInput" v-if="store.root!=''&&mode=='file'">
          <i class="fa fa-plus"></i> 
        </div>
        <input
          v-if="showInput"
          v-model="newFileName"
          style="margin:  0px 0px 0px 5px;flex: 1;"
          @keyup.enter="createFile(newFileName); showInput = false; newFileName = ''" 
          @blur="showInput = false; newFileName = ''" 
          placeholder="创建文件"
        />
        <input v-if="store.root!=''" style="margin:  0px 0px 0px 5px;flex: 1;" v-model="filterText" placeholder="搜索"/>
      </div>
      <el-tree
        ref="treeRef"
        node-key="path"
        :data="store.tree"
        :filter-node-method="filterNode"
        :default-expanded-keys="expandedKeys"
        @node-click="click"
        @node-contextmenu="handleRightClick"
        @node-expand="handleNodeExpand"
        @node-collapse="handleNodeCollapse"
        v-if="store.root!=''"
        >
        <template #default="{ node, data }">
          <div class="custom-tree-node">
            <span>
              <i :class="store.icon(data.extension)"></i> &nbsp; 
              <span>{{ data.label }}</span>
            </span>
          </div>
        </template>
      </el-tree>
    </div>
    <!--搜索-->
    <div v-if="mode=='search'" style="width:100%;height:calc(100% - 70px);">
      <search/>
    </div>
    <div v-if="mode=='AI'" style="width:100%;height:calc(100% - 70px);margin-right: 5px;">
      <AI/>
    </div>
    <!--视图-->
    <div class="views scoll">
      <div class="view" @click="store.toggleView('文件');store.saveConfig()" :class="{active:store.isView('文件')}">
        <i class="fa fa-folder"></i>
      </div>
      <div class="view" @click="store.toggleView('甘特');store.saveConfig()" :class="{active:store.isView('甘特')}">
        <i class="iconfont">&#xe672;</i>
      </div>
      <div class="view" @click="store.toggleView('看板');store.saveConfig()" :class="{active:store.isView('看板')}">
        <i class="fa fa-list-ul"></i>
      </div>
      <div class="view" @click="store.toggleView('图谱');store.saveConfig()" :class="{active:store.isView('图谱')}">
        <i class="iconfont">&#xe662;</i>
      </div>
      <div class="view" @click="store.toggleView('月历');store.saveConfig()" :class="{active:store.isView('月历')}">
        <i class="iconfont">&#xe600;</i>
      </div>
      <div class="view" @click="store.toggleView('年历');store.saveConfig()" :class="{active:store.isView('年历')}">
        <i class="fa fa-calendar"></i>
      </div>
      <div class="view" @click="store.toggleView('地图');store.saveConfig()" :class="{active:store.isView('地图')}">
        <i class="iconfont">&#xe884;</i>
      </div>
      <div class="view" @click="store.toggleView('表格');store.saveConfig()" :class="{active:store.isView('表格')}">
        <i class="fa fa-table" ></i>
      </div>
      <div class="view" @click="store.toggleView('浏览');store.saveConfig()" :class="{active:store.isView('浏览')}">
        <i class="fa fa-book"></i>
      </div>
      <div class="view" @click="store.toggleView('导图');store.saveConfig()" :class="{active:store.isView('导图')}">
        <i class="fa fa-map-o"></i>
      </div>
      <div class="view" @click="store.toggleView('演示');store.saveConfig()" :class="{active:store.isView('演示')}">
        <i class="fa fa-television"></i>
      </div>
      <div class="view" @click="store.toggleView('编辑');store.saveConfig()" :class="{active:store.isView('编辑')}">
        <i class="fa fa-code"></i>
      </div>
    </div>
    <div v-if="contextMenu.visible" :style="contextMenu.style" class="context-menu" @mouseleave="hideContextMenu">
      <div class="menu-item" @click="deleteFile">删除</div>
    </div>
  </div>
</template>

<style scoped>
  
  .bg {
    position: relative;
    float: center;
    height:calc(100% - 0px);
    background-color: var(--menuColor);
  }
  .fileList{
    position: relative;
    height: calc(100% - 70px);
    max-height: calc(100% - 41px);;
    float: center;
    overflow-y: auto;
    padding: 0px;
    overflow: hidden;
    overflow-y: auto;
    user-select: none;
  }
  .fixPanel{
    width:calc(100%);
  }
  
  .views{
    display: flex;
    overflow: hidden;
    overflow-x: auto;
    overflow-y: hidden;
    border: 1px solid var(--borderColor);
    margin:0px -7px 0px 0px
  }
  .view{
    text-align: center;
    flex:1;
    border-right: 1px solid var(--borderColor);
    padding: 6px 3px;
    font-size: 10px;
  }
  .view:last-child{
    border-right: 0px solid var(--borderColor);
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
  .context-menu {
    position: absolute;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    box-shadow: 2px 2px 2px rgba(0, 0, 0, 0.3);
    z-index: 1000;
  }
  .menu-item {
    padding: 8px 16px;
    cursor: pointer;
    user-select: none;
  }

  .menu-item:hover {
    background-color: var(--menuActiveColor);
  }
</style>

