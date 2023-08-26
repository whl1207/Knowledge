<script setup lang="ts">

  import {usestore} from '../../../store'
  const store=usestore()
  withDefaults(
    defineProps<{src: string;}>(),
    {src: "",}
  )
</script>

<template >
    <img :src="src">
</template>

<style scoped>
  img{
    display: table-cell;
    width: 100%;
    height: 100%;
    object-fit:contain;
    z-index:-100;
  }
</style>
