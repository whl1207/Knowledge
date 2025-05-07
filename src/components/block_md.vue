<script setup lang="ts">
  import { ref,watch,onMounted,onBeforeUnmount,nextTick} from 'vue'
  import MarkdownIt from 'markdown-it'
  import mathjax3 from 'markdown-it-mathjax3'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  import 'highlight.js/styles/nnfx-dark.min.css'
  import { Transformer } from 'markmap-lib'
  import * as markmap from 'markmap-view'
  import {usestore} from '../store'
  const store = usestore()
  const props = defineProps({
    content: {
      type: String,
      default: "### 未定义"
    },
    maxHeight: {
      type: String,
      default: null
    },
    fontSize: {
      type: String,
      default: '16px'
    }
  })
  const mddiv = ref(null) //父div
  let prep = ref("") //预览
  let ifmd = ref(true)
  let ifmind = ref(false)
  let ifppt = ref(false)
  let prepList = ref([]) as any //预览列表
  let showIndex = ref(0)
  let id=ref("mindmap"+Date.now()) //svg的ID
  let map = null as any
  let pattern = ref(/[#*-]/)
  const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str:any, lang:any) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs scoll"><code>' +
            hljs.highlight(str,{language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (__) {}
      }
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    }
  }).use(mathjax3)
  .use(mark)

  //更新目录和预览
  const init=async function(){
    await nextTick()
    if(props.content=="") return
    if(ifmd.value){
      map=null
      prep.value = md.render(props.content!)
    }
    if(ifmind.value){
      markmind()
    }
    if(ifppt.value){
      prepList.value=[]
      const sections = props.content.split(/\n\n\n|###*\s/) // 通过换行符划分内容为多个部分
      sections.map((section:string) => {
          const renderedContent = md.render(section) // 使用md渲染每个部分的内容
          if(renderedContent!='') prepList.value.push(renderedContent) // 在每个部分外部添加section标签
      })
    }
  }
  //创建思维导图
  const markmind=()=>{
    let markdown = props.content
    if(map==null){
        //创建思维导图
        const container = document.getElementById(id.value);
        if (container == null) return;
        container.innerHTML = "";
        
        const transformer = new Transformer()
        const { root, features } = transformer.transform(markdown)
        const { styles, scripts } = transformer.getUsedAssets(features)
        const { Markmap, loadCSS, loadJS } = markmap
        //if (styles) loadCSS(styles);
        if (scripts) loadJS(scripts, { getMarkmap: () => markmap })
        container.style.width = "100%"
        container.style.height = "100%"
        map = Markmap.create('#'+id.value,undefined, root)
      }else{
        //更新数据
        const transformer = new Transformer()
        const { root, features } = transformer.transform(markdown)
        const { styles, scripts } = transformer.getUsedAssets(features)
        const { Markmap, loadCSS, loadJS } = markmap
        //if (styles) loadCSS(styles)
        if (scripts) loadJS(scripts, { getMarkmap: () => markmap })
        map.setData(root)
      }
  }
  const isFullscreen = ref(false);
  const mdrender = ref<HTMLElement | null>(null)
  let cMaxHeight=ref(props.maxHeight)
  let cFontSize=ref(props.fontSize)
  const full = () => {
    isFullscreen.value=!isFullscreen.value
    if(isFullscreen.value){
      cMaxHeight.value='100%'
    }else{
      cMaxHeight.value=props.maxHeight
    }
    if(ifmind.value){
      nextTick()
      map=null
      markmind()
    }
  }
  
  const svg = ref<HTMLElement | null>(null)
  //监听变化
  watch(()=>props.content, (newValue, oldValue) => {
    init()
  })
  watch(()=>ifmd.value, (newValue, oldValue) => {
    init()
  })
  watch(()=>ifmind.value, (newValue, oldValue) => {
    init()
  })
  watch(()=>ifppt.value, (newValue, oldValue) => {
    init()
  })
  watch(()=>props.maxHeight, (newValue, oldValue) => {
    cMaxHeight.value=props.maxHeight
  })
  const handleFullscreenChange = () => {
    isFullscreen.value = !!document.fullscreenElement;
  };
  onMounted(()=>{
    init()
    document.addEventListener('fullscreenchange', handleFullscreenChange);
  })
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
  })
</script>

<template >
  <div class="mddiv" :class="{ 'fullscreen-active': isFullscreen,'scoll': ifmd,'minddiv': ifmind}" :style="{maxHeight:cMaxHeight,fontSize:!isFullscreen?cFontSize:'',height:!isFullscreen?maxHeight:''}" ref="mddiv">
    <div style="height:100%;width:100%;display: flex;position: relative;">
      <div v-if="ifmd" class="scoll" style="overflow: hidden;overflow-y: auto;z-index: 1;flex:1;">
        <div class="md" v-html="prep" :style="{padding:isFullscreen?'30px':'2px'}" ref="mdrender">
        </div>
      </div>
      <div v-if="ifmind" style="z-index: 1;flex:1;border-left: 1px solid var(--borderColor);">
        <svg :id="id" ref="svg"></svg>
      </div>
      <div class="ppt" v-if="ifppt" :style="{padding:isFullscreen?'30px':'0px',width:isFullscreen?'calc(100% - 60px)':'calc(100% - 4px)',fontSize:isFullscreen?'1.5em':'14px'}">
        <template v-for="(item, index) in prepList" :key="index">
          <div v-html="item" class="section scoll" :style="{padding:isFullscreen?'30px':'0px'}" v-if="showIndex==index"></div>
        </template>
      </div>
    </div>
    <div class="control" :style="{fontSize:isFullscreen?'18px':'12px'}">
      <div @click="store.tts(props.content)" class="btn">
        <i class="fa fa-volume-up"></i>
      </div>
      <div @click="store.copyToClipboard(props.content)" class="btn">
        <i class="fa fa-copy"></i>
      </div>
      <div @click="ifmd=!ifmd" class="btn" :class="{ 'active': ifmd}">
        <i class="fa fa-file-text-o"></i>
      </div>
      <div v-if="pattern.test(props.content)" @click="ifmind=!ifmind" class="btn" :class="{ 'active': ifmind}">
        <i class="fa fa-sitemap"></i>
      </div>
      <div @click="ifppt=!ifppt" class="btn" :class="{ 'active': ifppt}">
        <i class="fa fa-delicious"></i>
      </div>
      <div v-if="ifppt" class="btn" @click="showIndex=Math.max(0,showIndex-1)">
        <i class="fa fa-arrow-left"></i>
      </div>
      <div v-if="ifppt" class="btn" @click="showIndex=Math.min(prepList.length-1,showIndex+1)">
        <i class="fa fa-arrow-right"></i>
      </div>
      <div v-if="ifppt" class="btn" style="color:var(--fontColor)">
        {{showIndex+1}}
      </div>
      <div @click="full" class="btn" style="margin-right:5px">
        <i class="fa fa-window-maximize" v-if="!isFullscreen"></i>
        <i class="fa fa-times" v-if="isFullscreen"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .mddiv{/**背景 */
    width:100%;
    height: 100%;
    position:relative;
    margin: 0px;
    overflow: hidden;
    color:var(--fontColor);
    overflow-y: auto;
    z-index:0;
    min-width:100px;
    min-height:35px;
  }
  .mddiv:hover .control {
    display: flex; /* 使用 flex 布局让按钮自动排布 */
  }
  .minddiv::-webkit-scrollbar {
    display: none;
  }
  .md{
    position: relative;
    user-select:text;
  }
  .md::-webkit-scrollbar {
    display: block;
  }
  .ppt{
    min-width: 400px;
    min-height:300px;
    height:calc(100% - 60px);
    flex:1;
    display: flex;
    border-left: 1px solid var(--borderColor);
  }
  .section {
    position: absolute;
    background-color: var(--backgroundColor);
    flex: 1; /* 每个 section 铺满剩余空间 */
    height:calc(100% - 0px);
    padding: 30px;
    overflow-y: auto;
  }
  .markmap{
    position: relative;
    z-index: 1;
    color:var(--fontColor);
    flex:1;
    border-right: 1px solid var(--borderColor);
  }
  .fullscreen-active {
    position: fixed;
    top: 45px;
    left: 40px;
    width:calc(100% - 80px);
    height:calc(100% - 95px);
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    z-index:999;
    max-height:100%;
  }
  
  .control{
    display: none;
    position: absolute;
    top:0;
    right:0px;
    height:fit-content;
    justify-content: space-between; /* 使图标横向均匀分布 */
    align-items: center; /* 垂直居中对齐 */
    padding: 0px;
    z-index:10;
    background-color: var(--menuColor);
    opacity: 0.7;
    width:100%;
  }
  .control .btn{
    padding:2px 3px;
    text-align: center;
    flex:1;
  }
  
</style>
