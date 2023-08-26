<script setup lang="ts">

  import {usestore} from '../../../store'
  import {ref,onMounted,nextTick } from 'vue'

  import '/public/reveal.css'
  import Revealjs from 'reveal.js'
  import RevealMarkdown from 'reveal.js/plugin/markdown/markdown.esm.js'
  import RevealNotes from 'reveal.js/plugin/notes/notes.js'
  import RevealHighlight from "reveal.js/plugin/highlight/highlight.js"
  import RevealMath from "reveal.js/plugin/math/math.js"
  import mathjax from "mathjax/es5/tex-mml-chtml.js"
  //读取并解构数据
  const store=usestore()
  let fileAddress = ref("")
  let data = ref("")
  let Reveal = null as any

  //初始化演示
  const init=async function(){
    if(store.app.files.length==0) return
    if(store.app.files[store.app.fileIndex].type!='.md') return
    fileAddress.value=store.app.files[store.app.fileIndex].fullPath
    data.value = store.app.files[store.app.fileIndex].content
    data.value = data.value.replace(/^---[\s\S]+?---\n/, '') //去除yaml头
    //处理图片链接
    data.value=data.value.replace(/!\[(.*?)\]\((.*?)\)/g,function(a,b,c,d){
      //a 匹配到的内容，b 第一组内容，图片标签，c 图片原文地址，d 位置
      //判断是不是外链
      const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      const objExp=new RegExp(Expression);
      if(objExp.test(c)==true){
        return a
      }else{
        let address=store.app.files[store.app.fileIndex].parentPath.replace(/\\/g,"/")
        return "!["+b+"](file://"+address+"/"+c+")"
      }
    })
    //处理背景图片链接
    data.value=data.value.replace(/data-background-image="(.*?)"/g,function(a,b,c){
      //a 匹配到的内容，b 图片原文地址，c 位置
      //判断是不是外链
      const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      const objExp=new RegExp(Expression)
      let str = ""
      if(objExp.test(b)==true){
        str = a
      }else{
        let address=store.app.files[store.app.fileIndex].parentPath.replace(/\\/g,"/")
        str = 'data-background-image="file://'+address+'/'+b+'"'
      }
      return str
    })

    await nextTick()

    Reveal = new Revealjs({})
    let width=store.app.viewSet.presentation.width
    let height=store.app.viewSet.presentation.height
    if(width.indexOf('%')==-1) width=width*1
    if(height.indexOf('%')==-1) height=height*1
    Reveal.initialize({
      width: width,
      height: height,
      minScale: 0.2,
      maxScale: 2.0,
      controls: true,			// 显示右下角控制按钮
      progress: true,			// 显示进度条
      //slideNumber:true,       // 显示页码
      center: true,			// 幻灯片内容默认排版在中心
      overview: true,
      touch: true,  //触屏使用
      showNotes:showNotes.value,  //显示注释
      autoSlide: 8000,
      //loop: true,
      markdown: {
        smartypants: true
      },
      mathjax3: {
        mathjax: '/node_modules/mathjax/es5/tex-mml-chtml.js',
        tex: {
          inlineMath: [ [ '$', '$' ], [ '\\(', '\\)' ]  ]
        },
        options: {
          skipHtmlTags: [ 'script', 'noscript', 'style', 'textarea', 'pre' ]
        },
      },
      plugins: [ RevealMarkdown,RevealNotes,RevealHighlight,RevealMath.MathJax3 ]
    })
    
    await sleep(10)
    Reveal.toggleAutoSlide()
  }

  const Overview=()=>{
    Reveal.toggleOverview()
  }

  let showNotes=ref(false)
  const ShowNotes=()=>{
    showNotes.value=!showNotes.value
    Reveal.configure({ showNotes: showNotes.value })
  }

  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  const close=async function(){
    if(store.app.objectView.indexOf("演示")>-1){
      store.app.objectView.splice(store.app.objectView.indexOf("演示"),1)
    }
    store.resize() //触发缩放
  }
  const save = async function(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault()
      await sleep(100)
      init()
    }
  }
  onMounted(()=>{
    init()
    window.removeEventListener('keydown', save)
  })
</script>

<template >
  <div class="bg" v-if="store.app.files.length>0&&(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')" :style="{borderBottom:store.app.UI.layout=='column'?'1px solid var(--borderColor)':'',borderRight:store.app.UI.layout=='row'?'1px solid var(--borderColor)':''}">
    <div class="reveal" id="reveal">
      <div class="slides">
        <!--<section data-transition="zoom">
          <h1>{{store.app.files[store.app.fileIndex].name}}</h1>
        </section>-->
        <section data-markdown
          data-transition="convex"
					data-separator="^\n\n\n"
					data-separator-vertical="^\n\n"
					data-separator-notes="^> Note:"
          data-charset="utf-8"
          >
          <textarea data-template>
            {{data}}
          </textarea>
        </section>
        <!--外部文件
        <section :data-markdown="fileAddress"
          data-transition="convex"
					data-separator="^\n\n\n"
					data-separator-vertical="^\n\n"
					data-separator-notes="^> Note:"
         	data-charset="utf-8"
        >
        </section>
        -->
      </div>
    </div>
    <div class="btns">
      <i class="btn fa fa-bandcamp" @click="Overview()"></i>
      <i class="btn fa fa-comment" @click="ShowNotes()"></i>
      <i class="btn fa fa-times" @click="close()"></i>
    </div>
    
  </div>
</template>

<style scoped>
  .bg{/**背景 */
    width:100%;
    position:relative;
    margin: 0px;
    width: 100%;
    height: 100%;
    flex:4;
  }
  .reveal{
    position: absolute;
    background-color:var(--backgroundColor);
    width:100%;
    height:100%
  }
  .btns{
    position:absolute;
    right:5px;
    top:5px;
    padding:5px;
    z-index:10;
  }
  .btn{
    position:relative;
    opacity: 0.8;
    margin-left: 5px;
  }
</style>


