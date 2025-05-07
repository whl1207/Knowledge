<script setup lang="ts">

  import {usestore} from '../../store'
  import { ref,reactive,watch,onMounted,onBeforeUnmount } from 'vue'

  import MarkdownIt from 'markdown-it'
  import yaml from 'js-yaml'
  import frontMatter from 'markdown-it-front-matter'
  //import katex from 'markdown-it-katex'
  import mathjax3 from 'markdown-it-mathjax3'
  //import replacelink from 'markdown-it-replace-link'
  import tocAndAnchor from 'markdown-it-toc-and-anchor'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  import 'highlight.js/styles/nnfx-dark.min.css'

  //读取并解构数据
  const store=usestore()
  let data = {} as any
  let prepList = ref([]) as any //预览列表
  let showIndex = ref(0)

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
    },
  }).use(frontMatter, (fm:any) => {
    yaml.load(fm)// 解析YAML
  }).use(mathjax3)
  .use(tocAndAnchor, { anchorLink:false })
  .use(mark)

  //更新目录和预览
  const init=async function(){
    prepList.value=[]
    data=store.data[store.index]
    if(data.content==undefined) data.content=""
    if(data.extension==".md"||data.extension==""){
      const sections = data.content.split(/\n\n\n|###*\s/) // 通过换行符划分内容为多个部分
      sections.map((section:string) => {
          const renderedContent = md.render(section) // 使用md渲染每个部分的内容
          if(renderedContent!='') prepList.value.push(renderedContent) // 在每个部分外部添加section标签
      })
    }
  }
  //监听变化
  watch(()=>store.data[store.index], (newValue, oldValue) => {
    init()
    showIndex.value=Number(Math.max(Math.min(prepList.value.length-1,showIndex.value),0))
  })
  onMounted(()=>{
    init()
  })
  onBeforeUnmount(() => {
  })
</script>

<template >
  <div class="bg">
    <div v-for="(item, index) in prepList" :key="index" >
      <div v-html="item" class="section" v-if="showIndex===index"></div>
    </div>
    <div class="button" style="position: absolute;bottom:0" @click="showIndex=Math.max(0,showIndex-1)"><i class="fa fa-arrow-left"></i></div>
    <div class="button" style="position: absolute;bottom:0;left:40px" @click="showIndex=Math.min(prepList.length-1,showIndex+1)"><i class="fa fa-arrow-right"></i></div>
    <div style="position: absolute;bottom:5px;right:5px;color:var(--borderColor)">{{showIndex+1}}</div>
    <div class="progress-bar" :style="{width:showIndex/(prepList.length-1)*100+'%'}"></div>
  </div>
</template>

<style scoped>
  .bg{/**背景 */
    width:100%;
    height: 100%;
    position:relative;
    margin: 0px;
    display: flex;
    flex:1;
    border-right: 1px solid var(--borderColor);
  }
  .section {
    position: absolute;
    background-color: var(--backgroundColor);
    flex: 1; /* 每个 section 铺满剩余空间 */
    height:calc(100% - 60px);
    width:calc(100% - 60px);
    padding: 30px;
    font-size: 1.5em;
    vertical-align: middle;
  }
  .progress-bar {
    height: 2px;
    background-color: var(--fontActiveColor);
    position: absolute;
    bottom: 0;
  }
</style>
