<script setup lang="ts">
  import { ref,nextTick,onMounted,onBeforeUnmount,watch} from 'vue'
  import {usestore} from '../../../store'

  import { Transformer } from 'markmap-lib';
  import * as markmap from 'markmap-view';

  const store=usestore()

  let id=ref("mindmap"+Date.now())
  let map = null as any
  const init=async function(){
    await nextTick()
    if(document.getElementById(id.value)==null) return
    document.getElementById(id.value)!.innerHTML=""
    let markdown = store.app.files[store.app.fileIndex].content
    const transformer = new Transformer()
    // 1. transform Markdown
    const { root, features } = transformer.transform(markdown)
    const { styles, scripts } = transformer.getUsedAssets(features)

    const { Markmap, loadCSS, loadJS } = markmap

    // 1. load assets
    if (styles) loadCSS(styles);
    if (scripts) loadJS(scripts, { getMarkmap: () => markmap })

    // 2. create markmap
    // `options` is optional, i.e. `undefined` can be passed here
    map = Markmap.create('#'+id.value,undefined, root)
  }
  
  async function update(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault()
      await sleep(10)
      let markdown = store.app.files[store.app.fileIndex].content
      const transformer = new Transformer()
      const { root, features } = transformer.transform(markdown)
      map.setData(root)
      //// fit the container
      //map.fit();

      // make sure node is visible in view port where node is root or one of its descendants
      //map.ensureView(node);
    }
  }
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  //切换为浏览
  const toggleView=async function(){
    if(store.app.objectView.indexOf("导图")>-1){
      store.app.objectView.splice(store.app.objectView.indexOf("导图"),1)
    }
    if(store.app.objectView.indexOf("浏览")==-1){
      store.app.objectView.push("浏览")
    }
    store.resize() //触发缩放
  }
  const close=async function(){
    if(store.app.objectView.indexOf("导图")>-1){
      store.app.objectView.splice(store.app.objectView.indexOf("导图"),1)
    }
    store.resize() //触发缩放
  }
  watch(()=>store.app.fileIndex, (newValue, oldValue) => {
    if(store.app.files.length>0){
      if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type=="") init()
    }else{
      let markdown = ""
      const transformer = new Transformer()
      const { root, features } = transformer.transform(markdown)
      if(map!=null) map.setData(root)
    }
  })
  onMounted(() => {
    window.addEventListener('keydown', update)
    if(store.app.files.length==0) return
    if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type=="") init()
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', update)
  })
</script>
  
<template>
  <div class="mindmap" v-if="store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type==''" :style="{borderBottom:store.app.UI.layout=='column'?'1px solid var(--borderColor)':'',borderRight:store.app.UI.layout=='row'?'1px solid var(--borderColor)':''}" @contextmenu.prevent="">
    <svg :id="id" style="width: 100%; height: 100%"></svg>
    <div class="btns">
      <i @click="init" class="btn fa fa-refresh"></i>
      <i @click="toggleView" class="btn fa fa-file-text"></i>
      <i @click="close" class="btn fa fa-times"></i>
    </div>
  </div>
</template>
  
<style scoped>
  .mindmap{
    position:relative;
    margin: 0px;
    width:100%; /**flex溢出bug，可改0*/
    height:100%;
    flex:4;
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
</style>
  