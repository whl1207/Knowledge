<script setup lang="ts">

  import {usestore} from '../../store'
  import md from './explorer/md.vue'
  import jpg from './explorer/jpg.vue'
  import mp3 from './explorer/mp3.vue'
  import pdf from './explorer/pdf.vue'
  import mp4 from './explorer/mp4.vue'
  import browser from './explorer/browser.vue'
  import wb from './explorer/wb.vue'
  const store=usestore()
</script>

<template >
  <div class="explorer" v-if="['.md','.txt','','.pdf','.wb','.html','.mp3','.m4a','.mp4','.wmv','.avi','.jpeg','.jpg','.png','.webp'].includes(store.app.files[store.app.fileIndex].type)||(['.md','.txt',''].includes(store.app.files[store.app.fileIndex].type))" :style="{borderBottom:store.app.UI.layout=='column'?'1px solid var(--borderColor)':'',borderRight:store.app.UI.layout=='row'?'1px solid var(--borderColor)':''}">
    <md v-if="['.md','.txt',''].includes(store.app.files[store.app.fileIndex].type)" />
    <pdf v-if="['.pdf'].includes(store.app.files[store.app.fileIndex].type)" :src="store.app.files[store.app.fileIndex].cloud==true?('http://'+store.app.files[store.app.fileIndex].ip+'/'+store.app.files[store.app.fileIndex].fullPath):('file://'+store.app.files[store.app.fileIndex].fullPath)"/>
    <wb v-if="['.wb'].includes(store.app.files[store.app.fileIndex].type)" :key="store.app.fileIndex" />
    <browser v-if="['.html'].includes(store.app.files[store.app.fileIndex].type)" :src="store.app.files[store.app.fileIndex].cloud==true?('http://'+store.app.files[store.app.fileIndex].ip+'/'+store.app.files[store.app.fileIndex].fullPath):('file://'+store.app.files[store.app.fileIndex].fullPath)"/>
    <mp3 v-if="['.mp3','.m4a'].includes(store.app.files[store.app.fileIndex].type)"  :url="store.app.files[store.app.fileIndex].cloud==true?('http://'+store.app.files[store.app.fileIndex].ip+'/'+store.app.files[store.app.fileIndex].fullPath):('file://'+store.app.files[store.app.fileIndex].fullPath)"/>
    <mp4 v-if="['.mp4','.wmv','.avi'].includes(store.app.files[store.app.fileIndex].type)" />
    <jpg v-if="['.jpeg','.jpg','.png','.webp'].includes(store.app.files[store.app.fileIndex].type)" :src="store.app.files[store.app.fileIndex].cloud==true?('http://'+store.app.files[store.app.fileIndex].ip+'/'+store.app.files[store.app.fileIndex].fullPath):('file://'+store.app.files[store.app.fileIndex].fullPath)"/>
  </div>
</template>

<style scoped>
  .explorer{/**背景 */
    width:100%;
    position:relative;
    margin: 0px;
    padding:0px;
    height: calc(100% - 1px);
    flex:3;
  }
</style>
