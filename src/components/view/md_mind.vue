<script setup lang="ts">
  import { ref,nextTick,onMounted,onBeforeUnmount,watch} from 'vue'
  import {usestore} from '../../store'

  import { Transformer } from 'markmap-lib'
  import * as markmap from 'markmap-view'

  const store=usestore()

  let id=ref("mindmap"+Date.now())
  let map = null as any
  const init=async function(){
    await nextTick()
    if(document.getElementById(id.value)==null) return
    document.getElementById(id.value)!.innerHTML=""
    let markdown = store.data[store.index].content
    const transformer = new Transformer()
    // 1. transform Markdown
    const { root, features } = transformer.transform(markdown)
    const { styles, scripts } = transformer.getUsedAssets(features)

    const { Markmap, loadCSS, loadJS } = markmap

    // 1. load assets
    //if (styles) loadCSS(styles);
    if (scripts) loadJS(scripts, { getMarkmap: () => markmap })

    // 2. create markmap
    // `options` is optional, i.e. `undefined` can be passed here
    map = Markmap.create('#'+id.value,undefined, root)
  }
  
  function update() {
      let markdown = store.data[store.index].content
      const transformer = new Transformer()
      const { root, features } = transformer.transform(markdown)
      map.setData(root)
      //// fit the container
      map.fit();

      // make sure node is visible in view port where node is root or one of its descendants
      //map.ensureView(node);
  }
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  watch(()=>store.index, (newValue, oldValue) => {
    update()
  })
  onMounted(() => {
    init()
  })
  onBeforeUnmount(() => {

  })
</script>
  
<template>
  <div class="mindmap" @contextmenu.prevent="" v-if="store.data[store.index]!=undefined">
    <svg :id="id" style="width: 100%; height: 100%"></svg>
    <div class="btns">
      <i @click="init" class="btn fa fa-refresh"></i>
    </div>
  </div>
</template>
  
<style scoped>
  .mindmap{
    position:relative;
    margin: 0px;
    width:100%; /**flex溢出bug，可改0*/
    height:100%;
    flex:1;
    user-select: none;
  }
  .btns{
    position:absolute;
    right:5px;
    top:5px;
    padding:5px;
  }
  .btn{
    position:relative;
    opacity: 0.8;
    margin-left: 5px;
  }
  .markmap{
    color:var(--fontColor)
  }
</style>
  