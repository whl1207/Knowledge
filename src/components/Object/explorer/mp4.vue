<script setup lang="ts">

  import {usestore} from '../../../store'
  const store=usestore()
</script>

<template >
  <video :src="store.app.files[store.app.fileIndex].cloud?('http://'+store.app.files[store.app.fileIndex].ip+'/'+store.app.files[store.app.fileIndex].fullPath):('file:\\'+store.app.files[store.app.fileIndex].fullPath)" style="width:100%;height: 100%;border: 0px;" controls autoplay></video>
</template>

<style scoped>
  video{
    display: table-cell;
    width: 100%;
    height: 100%;
    object-fit:contain;
    z-index:-100;
  }
</style>
