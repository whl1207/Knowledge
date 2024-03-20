<script setup lang="ts">
  import { ref ,reactive,nextTick,watch,onMounted} from 'vue'
  import { usestore } from '../../store'
  import file from '../../../electron/file'

  const store=usestore()

  let shell = null as any
  let fs = null as any
  if(store.app.environment!="web"){
    shell = require("electron").shell;
    fs=require("fs")
  }
  let localResults=ref([]) as any
  let cloudResults=ref([]) as any
  let type=ref("本地")
  let ifloading = ref(false)
  //搜索并过滤文件
  let filterText = ref('')
  let timer = ref(null) as any
  //点击操作
  const open=(data:any)=>{
    store.addTab(data)
  }

  //打开文件
  const openFile=(path:string)=>{
    if(path!=""){
      fs.exists(path, (exists:any) => {
        if (exists) shell.openPath(path)
      })
    }
  }
  //打开位置
  const openAddress=(path:string)=>{
    if(path!=""){
      console.log(path)
      fs.exists(path, (exists:any) => {
        if (exists) shell.showItemInFolder(path)
      });
    }
  }
  //云搜索
  const cloudSearch=async function(keyword:string){
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();

      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
            xhr.onload = function () {
              if (xhr.responseText != "") {
                let content=xhr.responseText //文件内容
                resolve(content) // 使用resolve将获取到的数据传递给后续操作
              }
            }
          } else {
            reject(xhr.statusText) // 请求失败，使用reject传递错误信息
          }
        }
      }
      
      // 发送异步请求
      const address = "http://" + store.app.network[store.app.networkIndex].ip + ":" + store.app.network[store.app.networkIndex].port+"/?type=search&keyword="+keyword
      xhr.open('get', address)
      xhr.timeout = 500
      xhr.send()
    })
  }
  const getResults=async function(keyword:string){
    if(filterText.value!=""){
      ifloading.value=true
      //本地搜索
      if(store.app.environment!="web"){
        localResults.value=await file.search(store.app.storePath,filterText.value)
      }
      ifloading.value=false
      //云端搜索
      if(store.app.network.length>0&&store.app.networkIndex!=-1){
        let str = await cloudSearch(filterText.value) as any
        cloudResults.value = JSON.parse(str)
      }
    }
  }
  watch(()=>filterText.value, (newValue, oldValue) => {
    clearTimeout(timer.value)
    // 设置一个新的延时任务
    timer.value = setTimeout(() => {
      getResults(filterText.value)
      // 这里可以执行延时后的操作
      // 例如调用某个方法或者发送请求等
    }, 500) // 设置延时时间，单位为毫秒
  })
  onMounted(() => {
    if(store.app.environment=="web"){
      type.value="云端"
    }
  })
</script>

<template>
  <div class="bg">
    <input v-model="filterText" class="search" :placeholder="store.app.locales=='zh'?'请输入搜索关键词':'keyword'" />
    <div class="type" v-if="store.app.environment!='web'">
      <div :class="[type=='本地'?'active':'']" @click="type='本地'">
        <i class="fa fa-database"></i> local</div>
      <div :class="[type=='云端'?'active':'']"  @click="type='云端'" v-if="store.app.network.length>0">
        <i class="fa fa-cloud"></i> 
        {{ store.app.network[store.app.networkIndex].name }}</div>
    </div>
    <!--本地搜索结果-->
    <div class="content scoll" v-if="type=='本地'">
      <div style="width:100%;text-align: center;" v-if="ifloading">
        <i class="fa fa-spinner fa-spin fa-1x"></i>
      </div>
      <div class="panel" v-for="item,index in localResults" :key="index" @dblclick="open(item)">
        <div class="title">
          <i :class="store.icon(item.type)" style="position: absolute;left:8px;top:8px;"></i>
          {{item.fullName}}
        </div>
        <span class="address">{{item.fullPath}}</span>
        <div class="contentArr" v-if="item.arr!=undefined" >
          <span v-for="(arr,index) in item.arr" :key="index">{{arr}}</span>
        </div>
      </div>
    </div>
    <!--云端搜索结果-->
    <div class="content scoll"  v-if="type=='云端'">
      <div class="panel" v-for="item,index in cloudResults" :key="index" @dblclick="open(item)">
        <div class="title">
          <i :class="store.icon(item.type)" style="position: absolute;left:8px;top:8px;"></i>
          {{item.fullName}}
        </div>
        <span class="address">{{item.fullPath}}</span>
        <div class="contentArr" v-if="item.arr!=undefined" >
          <span v-for="(arr,index) in item.arr" :key="index">{{arr}}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  
  .bg {
    /** 背景 */
    position: relative;
    height:calc(100% - 2px);
    overflow-y: hidden;
  }
  .search{
    width:calc(100% - 10px);
    background-color:var(--backgroundColor);
    border-radius: 0px;
    border: 0px;
    border-bottom: var(--borderColor) 1px solid;
    margin-bottom: 0px;
  }
  .type{
    display: flex;
  }
  .type div{
    flex:1;
    text-align:center;
    border:1px solid var(--borderColor);
    border-top:0px;
    padding:5px
  }
  .active{
    background-color: var(--menuColor);
  }
  .content{
    position: relative;
    height: calc(100% - 80px);
    float: center;
    overflow-y: auto;
    padding: 5px;
  }
  .panel {
    position: relative;
    width: calc(100% - 12px);
    border-radius: 5px;
    border: 1px solid var(--borderColor);
    padding: 5px;
    margin-bottom: 5px;
    overflow: hidden;
  }
  .title{
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    width:calc(100% - 22px);
    max-width: 100%;
    padding-left: 22px;
    padding-bottom: 5px;
    overflow-x: hidden;
  }
  .address{
    color: var(--fontColor);
    font-size: 8px;
    opacity: 1;
    display: none;
  }
  .contentArr{
    border-top: 1px solid var(--borderColor);
  }
  span{
    font-size: 12px;
    opacity: 0.7;
  }
  .menu{
    z-index:10;
    position: absolute;
  }
  .menu ul{
    position:absolute;
    width:110px;
    border: 1px solid var(--fontColor);
    background-color: var(--menuColor);
    border-radius: 5px;
  }
  .menu li:hover{
    background-color: var(--menuActiveColor);
  }
  .menu li>ul{
    left: 110px;
    top: 0px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--fontColor);
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    list-style-type:none;
    float:left;
    width:90px;
  }
  .MainMenu_unactive li {
    height: 0px;
  }
  
  .catalogue{
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    width:calc(100% - 10px);
    overflow: hidden;
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
  input{
    height:31px;
  }
  input:focus{
    outline:none;
  }
</style>

