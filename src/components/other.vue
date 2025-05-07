<template>
  <div class="main">
      <div class="header">
        <div class="button" style="background-color: var(--menuColor);" @click="store.sidePanel=!store.sidePanel;store.resize()">
          <i class="fa fa-home" v-if="store.sidePanel"></i>
          <i class="fa fa-angle-double-left" v-if="!store.sidePanel"></i>
        </div>
        <div style="-webkit-app-region: no-drag;">
          <select v-model="mode" style="width:calc(90px)">
            <option value="pdf翻译">pdf翻译</option>
            <option value="文件转化">文件转化</option>
          </select>
        </div>
      </div>
      <div class="explorer">
        <pdfTrans></pdfTrans>
      </div>
    </div>
</template>

<script setup lang="ts">
  import {ref} from 'vue'
  import {usestore} from '../store'
  
  const store=usestore()
  let mode = ref('pdf翻译')
</script>

<style scoped>
  .header{
    width: calc(100%);
    display: flex;
    background-color: var(--menuColor);
    -webkit-app-region: drag;
    display: flex;
    border-bottom: var(--borderColor) 1px solid;
  }
  .active{
    background-color:var(--backgroundColor);
    border-bottom:1px solid var(--backgroundColor);
  }
  .control{
    position: relative;
    float: right;
    opacity: 0;
    transition: 0.2s;
    padding-top:3px;
    line-height: 24px;
  }
  .App_tab:hover .control{
    opacity: 1;
  }
  .explorer{
    display: flex;
    justify-content: space-between;
    width:100%;
    height:calc(100% - 41px)
  }
</style>