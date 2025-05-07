<script setup lang="ts">
  import { ref,watch,onMounted, onBeforeUnmount} from 'vue'
  import {usestore} from '../store'
  const store=usestore()
  let localResults=ref([]) as any
  let ifloading = ref(false)
  //搜索并过滤文件
  let filterText = ref('')
  let timer = ref(null) as any
  const open=(data:any)=>{
    store.addTab(data)
  }
  //搜索并过滤文件
  const getResults=async function(keyword:string){
    if(filterText.value!=""){
      ifloading.value=true
      //本地搜索
      localResults.value=await window.ipcRenderer.invoke('search',store.root,keyword)//search(store.root,filterText.value)
      ifloading.value=false
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
  })
</script>

<template>
  <div class="bg">
    <input v-model="filterText" class="search" :placeholder="store.locales=='zh'?'请输入搜索关键词':'keyword'" />
    <!--本地搜索结果-->
    <div class="content scoll">
      <div style="width:100%;text-align: center;" v-if="ifloading">
        <i class="fa fa-spinner fa-spin fa-1x"></i>
      </div>
      <div class="panel" v-for="item,index in localResults" :key="index" @dblclick="open(item)">
        <div class="title">
          <i :class="store.icon(item.extension)" style="position: absolute;left:8px;top:8px;"></i>
          {{item.label}}
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
    width:calc(100% - 21px);
    height:28px;
    background-color:var(--backgroundColor);
    border-radius: 0px;
    border: 0px;
    margin: 0px 0px 0px 5px;
    border: 1px solid var(--borderColor);
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
    
    width:calc(100% - 10px);
    height: calc(100% - 40px);
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

