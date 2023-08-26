<script setup lang="ts">

  import {usestore} from '../../../store'
  const store=usestore()
  withDefaults(
    defineProps<{src: string;}>(),
    {src: "",}
  )
</script>

<template >
  <iframe :src="src" style="width:100%;height:calc(100% - 4px); margin: 0px;border: 0px;"></iframe>
</template>

<style scoped>
</style>
