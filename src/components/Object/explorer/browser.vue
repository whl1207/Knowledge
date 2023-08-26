<script setup lang="ts">

  import {usestore} from '../../../store'
  const store=usestore()
  withDefaults(
    defineProps<{src: string;}>(),
    {src: "",}
  )
</script>

<template >
  <iframe style="width:100%;height: 100%;vertical-align:bottom;" :src="src" frameborder="0"></iframe>
</template>

<style scoped>
</style>
