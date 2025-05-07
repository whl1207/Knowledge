<script setup lang="ts">
  import { usestore } from '../../store'
  import { onMounted , onBeforeUnmount,nextTick} from 'vue'
  const store = usestore()
  
  const openFolder = async function() {
    let path = await window.ipcRenderer.invoke('openFolderDialog')
    if(path!=null){
      store.root = path
      store.tree =  await window.ipcRenderer.invoke('getDirectoryTree',path)
      store.path = path
    }
  }
  onMounted(() => {})
  onBeforeUnmount(() => {})
</script>

<template>
  <div class="App_empty">
    <div class="panels">
      <div style="padding:5px;margin-bottom: 5px;border:1px solid var(--borderColor);box-shadow:2px 2px 2px var(--menuColor);border-radius: 5px;text-align: left;display: flex;">
        <i class="fa fa-folder-open" style="margin:5px" @click="openFolder()"></i>
        <select v-model="store.locales" style="margin: 0px 3px;">
          <option value="zh">中文</option>
          <option value="en">ENGLISH</option>
        </select>
        <select v-model="store.UI.theme" style="margin: 0px 3px;" @change="store.changeTheme()">
          <option value="深色">深色</option>
          <option value="浅色">浅色</option>
          <option value="灰色">灰色</option>
          <option value="自定义">自定义</option>
        </select>
      </div>
      <div class="panel">
        <div class="views scoll">
          <div class="view" @click="store.toggleView('文件')" :class="{active:store.isView('文件')}">
            <i class="fa fa-folder"></i>
          </div>
          <div class="view" @click="store.toggleView('甘特')" :class="{active:store.isView('甘特')}">
            <i class="iconfont">&#xe672;</i>
          </div>
          <div class="view" @click="store.toggleView('看板')" :class="{active:store.isView('看板')}">
            <i class="fa fa-list-ul"></i>
          </div>
          <div class="view" @click="store.toggleView('图谱')" :class="{active:store.isView('图谱')}">
            <i class="iconfont"  style="font-size: 20px;">&#xe662;</i>
          </div>
          <div class="view" @click="store.toggleView('月历')" :class="{active:store.isView('月历')}">
            <i class="iconfont" style="font-size: 20px;">&#xe600;</i>
          </div>
          <div class="view" @click="store.toggleView('年历')" :class="{active:store.isView('年历')}">
           <i class="fa fa-calendar"></i>
          </div>
          <div class="view" @click="store.toggleView('地图')" :class="{active:store.isView('地图')}">
            <i class="iconfont" style="font-size: 20px;">&#xe884;</i>
          </div>
          <div class="view" @click="store.toggleView('表格')" :class="{active:store.isView('表格')}">
            <i class="fa fa-table" ></i>
          </div>
          <div class="view" @click="store.toggleView('浏览')" :class="{active:store.isView('浏览')}">
            <i class="fa fa-book"></i>
          </div>
          <div class="view" @click="store.toggleView('导图')" :class="{active:store.isView('导图')}">
            <i class="fa fa-map-o"></i>
          </div>
          <div class="view" @click="store.toggleView('演示')" :class="{active:store.isView('演示')}">
            <i class="fa fa-television"></i>
          </div>
          <div class="view" @click="store.toggleView('编辑')" :class="{active:store.isView('编辑')}">
            <i class="fa fa-code"></i>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .App_empty{
    flex:1;
    width:100%;
    height:100%;
    background-color: var(--backgroundColor);
    overflow: hidden;
    user-select: none;
  }
  .panels{
    position: relative;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width:160px;
    max-width: calc(100% - 20px);
    display: flex-direction;
  }
  .panel{
    position: relative;
    margin-bottom:5px;
    border:1px solid var(--borderColor);
    box-shadow:2px 2px 2px var(--menuColor);
    border-radius: 5px;
  }
  .views{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(25px, 1fr));
    overflow: hidden;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .view{
    width:calc(100% - 8px);
    margin:2px;
    padding: 2px;
    border-radius: 5px;
    flex: 1;
    text-align: center;
  }
  .view:hover{
    background-color: var(--menuColor);
  }
  .active{
    background-color: var(--menuActiveColor);
  }
</style>