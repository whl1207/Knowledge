<script setup lang="ts">
  import { ref, reactive, watch, onMounted } from 'vue'
  import { ElTree } from 'element-plus'
  import { usestore } from '../../store'

  const store = usestore()

  //搜索并过滤文件
  const filterText = ref('')
  const treeRef = ref < InstanceType < typeof ElTree >> ()
  const filterNode = function (value: string, data: any) {
    if (!value) return true
    return data.label.includes(value)
  }
  watch(filterText, (val) => {
    treeRef.value!.filter(val)
  })

  let ifMenu = ref(false)
  let menuPosition = reactive({
    x: 0,
    y: 0
  })

  //用户管理
  let user = reactive({
    name: '未命名节点',
    password: "",
    ip: '127.0.0.1',
    port: '9000'
  })
  let loading = ref(false)
  let err = ref('')
  const addNetworkUser = function () {
    let data = {
      name: user.name,
      password: user.password,
      ip: user.ip,
      port: user.port,
      state: false
    }
    store.app.network.push(data)
    store.saveApp()
  }
  const delNetwork = function (i: number) {
    store.app.network.splice(i, 1)
    store.app.networkIndex=-1
  }

  //获取目录
  let catalogue = ref([]) as any
  const getPartitions = function (i: number) {
    if(store.app.network.length==0){
      err.value = "请添加网络节点"
      return
    }
    store.app.networkIndex=i
    loading.value = true
    store.saveApp()
    err.value = ""
    catalogue.value = []
    //获取IP和端口
    const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port
    var xhr = new XMLHttpRequest()
    //2.告诉ajax请求地址以及请求方式
    xhr.open('get', address)
    xhr.timeout = 500
    //3.发送请求
    xhr.send()
    //4.获取服务器端给与客户端的响应数据
    xhr.onreadystatechange = function () {
      if (xhr.readyState == 4) {
        if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
          xhr.onload = function () {
            //xhr.responseText返回值是String
            if (xhr.responseText != "") {
              catalogue.value = JSON.parse(xhr.responseText)
              loading.value = false
              store.app.network[store.app.networkIndex].state = true
            }
          }
        } else {
          err.value = "连接失败：请检查网络。"
          loading.value = false
          store.app.network[store.app.networkIndex].state = false
        }
      }
    }
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
        dbopen(data)
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
  //左键双击操作
  //应用内打开
  const dbopen=(data:any)=>{
    store.app.path=data.fullPath
    //如果是pdf
    if(data.type=="pdf"){
      store.addTab(data)
      return
    }
    const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port+"/?type=get&parentPath="+data.parentPath+"&fullName="+data.fullName+""
    var xhr = new XMLHttpRequest()
    //2.告诉ajax请求地址以及请求方式
    xhr.open('get', address)
    xhr.timeout = 1000
    //3.发送请求
    xhr.send()
    //4.获取服务器端给与客户端的响应数据
    xhr.onreadystatechange = function () {
      if (xhr.readyState == 4) {
        if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
          xhr.onload = function () {
            //xhr.responseText返回值是String
            if (xhr.responseText != "") {
              let content=xhr.responseText //文件内容
              let cloudFile = {...data,content}
              store.addTab(cloudFile)
            }
          }
        } else {
          err.value = "连接失败：请检查网络。"
        }
      }
    }
    curNodeId = null
    preNodeId = null 
  }
  //右键点击的文件
  let selectFile=ref({}) as any
  //右键菜单
  const nodeContextmenu=(
    e:any, //事件
    data:any, //数据
    node:any, //node属性
    self:any, //self
  )=>{
    selectFile.value = data
    ifMenu.value=true
    menuPosition.x=e.clientX
    menuPosition.y=e.clientY-17
  }
  //计算激活页面的颜色
  const color=(data:any)=>{
    let str=""
    if(store.app.files.length!=0){
      if(store.app.files[store.app.fileIndex].cloud==true){
        str = data.fullPath==store.app.files[store.app.fileIndex].fullPath?'var(--fontActiveColor)':''
      }
    }
    return str
  }
  //打开页面
  const open=()=>{
    const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port+"/?type=get&parentPath="+selectFile.value.parentPath+"&fullName="+selectFile.value.fullName+""
    var xhr = new XMLHttpRequest()
    //2.告诉ajax请求地址以及请求方式
    xhr.open('get', address)
    xhr.timeout = 500;
    //3.发送请求
    xhr.send();
    //4.获取服务器端给与客户端的响应数据
    xhr.onreadystatechange = function () {
      if (xhr.readyState == 4) {
        if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
          xhr.onload = function () {
            //xhr.responseText返回值是String
            if (xhr.responseText != "") {
              let content=xhr.responseText //文件内容
              let cloud=true
              //解构文件，形成标签数据
              let cloudFile = {...selectFile.value,cloud,content}
              console.log(cloudFile)
              store.addTab(cloudFile)
            }
          }
        } else {
          err.value = "连接失败：请检查网络。"
        }
      }
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
          err.value = "连接失败：请检查网络。"
        }
      }
    }
  }
  
  //添加用户的状态数据，用于显示添加页面
  let showConfig = ref(false)
  
  onMounted(() => {
    if(store.app.network.length>0){
      getPartitions(0)
    }
  })
</script>

<template>
  <div class="bg">
    <div style="padding:10px 5px; border-bottom:1px solid var(--borderColor) ;">
      <span v-if="store.app.networkIndex!=-1">
        {{ store.app.network[store.app.networkIndex].name }}
        {{ store.app.network[store.app.networkIndex].ip }}
      </span>
      <span v-if="store.app.networkIndex==-1">
        未选择网络节点
      </span>
      <i class="fa fa-cog" style="float: right;margin-top:3px;margin-left:5px" :style="{color:showConfig?'var(--fontActiveColor)':''}" @click="showConfig=!showConfig"></i>
      <i class="fa fa-refresh" style="float: right;margin-top:3px" @click="getPartitions(store.app.networkIndex)"></i>
    </div>
    <div style="border-bottom: 1px solid var(--borderColor);padding:5px" v-if="showConfig&&store.app.network.length>0">
      <table style="border: 0px;" >
        <tr v-for="item,index in store.app.network" :key="index">
          <td style="border: 0px;" @click="store.app.networkIndex=index">
            <div style="top:0px;font-size:16px">{{item.name}}</div>
            <div style="bottom:0px;font-size:8px">{{item.ip}}:{{item.port}} <i v-if="item.password!=''" class="fa fa-key"></i></div>
          </td>
          <td style="border: 0px;width:35px">
            <i class="fa fa-jsfiddle" :style="{color:item.state?'green':''}" @click="getPartitions(index)"></i>
            <i class="fa fa-trash" @click="delNetwork(index)"></i>
          </td>
        </tr>
      </table>
    </div>
    <div class="add" v-if="showConfig" >
      <div style="display: flex;align-items: flex-start;">
        <span style="margin-bottom:5px">备注：</span>
        <input style="width:calc(100% - 148px);" v-model="user.name" />
        <input style="width:calc(77px);" placeholder="密匙" type="password" v-model="user.password" />
      </div>
      <div>
        <span style="margin-bottom:5px">地址：</span>
        <input style="width:calc(100% - 148px)" v-model="user.ip" />
        <input style="width:calc(41px)" v-model="user.port" />
        <button @click="addNetworkUser()" style="margin: 0px;"><i class="fa fa-plus"></i></button>
      </div>
    </div>
    <div class="fixPanel">
      <input v-model="filterText"  placeholder="搜索"/>
    </div>
    <span style="width:100%;text-align:center" v-if="err!=''||loading">
      <i v-if="loading" class="fa fa-spinner faa-spin animated"></i>
      {{err}}
    </span>
    <el-tree
      ref="treeRef"
      node-key="fullPath"
      class="catalogue"
      :data="catalogue"
      :filter-node-method="filterNode"
      :expand-on-click-node="false"
      @node-click="click"
      @node-contextmenu="nodeContextmenu"
    >
      <template #default="{ node, data }">
        <span class="custom-tree-node">
          <span :style="{color:color(data)}">
            <i :class="store.icon(data.type)"></i>&nbsp; 
            <span v-if="store.app.UI.extension">{{ data.fullName }}</span>
            <span v-if="!store.app.UI.extension">{{ data.name }}</span>
          </span>
        </span>
      </template>
    </el-tree>
    <div class="menu" v-if="ifMenu" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
      <ul>
        <li @click="dbopen">
          <i class="fa fa-folder-open"></i> &nbsp; 打开
        </li>
        <li @click="download" v-if="!selectFile.isFolder">
          <i class="fa fa-cloud-download"></i> &nbsp; 下载
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
  .bg {
    /** 背景 */
    position: relative;
    float: center;
    z-index: 10;
    width: calc(100%);
    height: calc(100%);
    overflow-y: auto;
  }

  .bg::-webkit-scrollbar {
    display: none;
  }

  .panel {
    position: relative;
    width: calc(100% - 12px);
    border-radius: 5px;
    border: 1px solid var(--borderColor);
    padding: 5px;
    margin-bottom: 5px;
  }
  .add{
    width:calc(100% - 10px);
    border-bottom: 1px solid var(--borderColor);
    overflow: hidden;
    transition: 0.5s;
    padding:5px
  }
  .menu{
    z-index:10;
    position:fixed;
  }
  .menu ul{
    position:absolute;
    width:110px;
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
    width:calc(100% - 13px);
    display:inline-block;
    position: relative;
  }
  .menu li:hover{
    background-color: var(--menuActiveColor);
  }
  .menu li>ul{
    left: 108px;
    top: 0px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
    width:130px
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    background-color:var(--menuColor);
    list-style-type:none;
    float:left;
    width:118px;
  }
  .catalogue{
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    overflow-x: hidden;
    display: block;
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
</style>