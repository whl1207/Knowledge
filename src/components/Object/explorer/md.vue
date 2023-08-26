<script setup lang="ts">

  import {usestore} from '../../../store'
  import { nextTick, ref,reactive,watch,onMounted,onBeforeUnmount } from 'vue'

  import MarkdownIt from 'markdown-it'
  import yaml from 'js-yaml'
  import frontMatter from 'markdown-it-front-matter'
  //import katex from 'markdown-it-katex'
  import mathjax3 from 'markdown-it-mathjax3'
  import replacelink from 'markdown-it-replace-link'
  import tocAndAnchor from 'markdown-it-toc-and-anchor'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  //import 'markdown-it-katex/node_modules/katex/dist/katex.min.css'
  import 'highlight.js/styles/github-dark.css'

  //读取并解构数据
  const store=usestore()
  //const css = import('../../../node_modules/highlight.js/styles/'+store.app.highlightCSS)

  //预览
  let prep = ref("")
  //是否显示目录
  let iftoc=ref(false)
  //目录
  let toc=ref([] as any)
  //yaml信息
  let info = reactive({}) 

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str:any, lang:any) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs"><code>' +
            hljs.highlight(str,{language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (__) {}
      }
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    },
    replaceLink: function (link:any, env:any) {
      const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      //判断是否为链接格式
      const objExp=new RegExp(Expression);
      if(objExp.test(link)==true){
        return link
      }else{
        //判断是否为云文件
        if(store.app.files[store.app.fileIndex].cloud){
          return "http://" + store.app.files[store.app.fileIndex].ip+"/"+store.app.files[store.app.fileIndex].parentPath + "/" + link
        }else{
          return "file://"+store.app.files[store.app.fileIndex].parentPath + "//" + link
        }
      }
    }
  }).use(frontMatter, (fm:any) => {
    info = yaml.load(fm)// 解析YAML
  }).use(mathjax3)
  .use(replacelink)
  .use(tocAndAnchor, { anchorLink:false })
  .use(mark)

  //.use(katex, { throwOnError: false, errorColor: '#CC0000' }) 

  //更新目录和预览
  const init=async function(){
    info={}
    prep.value=''
    if(store.app.files.length==0) return
    if(store.app.files[store.app.fileIndex].content==undefined) store.app.files[store.app.fileIndex].content=""
    if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type==""){
      RenderMarkdown()
    }
  }
  //渲染markdown
  const RenderMarkdown= async function() {
    if(store.app.files[store.app.fileIndex].content!=''){
      prep.value = md.render(store.app.files[store.app.fileIndex].content)
      //计算目录
      toc.value=Array.from(store.app.files[store.app.fileIndex].content.matchAll(/^(#{2,6})(\s+)(<a\s+.*><\/a>)?(.+)(\r?\n)?/gm))
      for(let i = 0;i<toc.value.length;i++){
        toc.value[i][6]=toc.value[i][4]//记录原始标题
        toc.value[i][4]=toc.value[i][4].toLocaleLowerCase() //大写转小写
        toc.value[i][4]=toc.value[i][4].replace(" ","-") //替换空格
        toc.value[i][4]=toc.value[i][4].replace("（","")
        toc.value[i][4]=toc.value[i][4].replace("）","")
        toc.value[i][4]=toc.value[i][4].replace(".","")
        toc.value[i][4]=toc.value[i][4].replace(/\u3001/g,"-") //替换、
        toc.value[i][4]=toc.value[i][4].replace(/\u3002/g,"") //删除。
        toc.value[i][4]=toc.value[i][4].replace(/\uFF1F/g,"") //删除。
      }
    }
  }

  //当点击保存后刷新本页
  async function save(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault();
      if(store.app.files.length>0){
        await sleep(10)
        init()
      }
    }
  }
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  //关闭页面
  const closeTab=function(){
    store.app.files.splice(store.app.fileIndex,1)
    store.app.fileIndex=Math.min(store.app.fileIndex,store.app.files.length-1)
    //页面清空时
    if(store.app.files.length==0){
      store.app.fileIndex=-1
      if(store.app.environment!="web"){
        store.app.path=store.app.storePath
      }
      store.resize() //触发缩放
    }else{
      //切换页面时，更换路径
      if(store.app.environment!="web"){
        store.app.path=store.app.files[store.app.fileIndex].parentPath
      }
    }
  }
  //关闭视图
  const closeView=async function(){
    if(store.app.objectView.indexOf("浏览")>-1){
      store.app.objectView.splice(store.app.objectView.indexOf("浏览"),1)
    }
    store.resize() //触发缩放
  }
  //切换为思维导图
  const toggleView=async function(){
    if(store.app.objectView.indexOf("浏览")>-1){
      store.app.objectView.splice(store.app.objectView.indexOf("浏览"),1)
    }
    if(store.app.objectView.indexOf("导图")==-1){
      store.app.objectView.push("导图")
    }
    store.resize() //触发缩放
  }
  let ifMenu=ref(false)
  let menuPosition=reactive({
    x:0,
    y:0
  })
  const nodeContextmenu=(
    e:any, //事件
  )=>{
    ifMenu.value=true
    menuPosition.x=e.clientX
    menuPosition.y=e.clientY
  }
  const formatDate=function(value:any) {
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = ('0' + (value.getMonth() + 1)).slice(-2);
      const day = ('0' + value.getDate()).slice(-2);
      const hour = ('0' + value.getHours()).slice(-2);
      const min = ('0' + value.getMinutes()).slice(-2);
      const sec = ('0' + value.getSeconds()).slice(-2);
      return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
    }
    return value;
  }
  //关闭浏览视图
  const closeExplorer = function(){
    store.app.objectView.splice(store.app.objectView.indexOf("浏览"),1)
  }
  //打开编辑视图
  const openEdit = function(){
    store.app.objectView[store.app.objectView.length]="编辑"
  }
  //监听变化
  watch(()=>store.app.files[store.app.fileIndex], (newValue, oldValue) => {
    if(store.app.files.length>0){
      init()
    }
  })
  watch(()=>store.app.files[store.app.fileIndex].content, (newValue, oldValue) => {
    RenderMarkdown()
  })
  onMounted(()=>{
    init()
    window.addEventListener('keydown', save)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', save)
  })
</script>

<template >
  <!--文章视图-->
  <div class="md">
    <div class="nav resize" v-if="iftoc&&(store.app.files[store.app.fileIndex].type=='.md')">
      <div style="position: absolute;width:100%;height:100%;display: flex;flex-direction: column;">
      <div style="padding:5px;width:calc(100% - 10px);border-bottom: 1px solid var(--borderColor);color:var(--fontActiveColor)">
        {{ store.app.files[store.app.fileIndex].fullName }}<br />
      </div>
      <div class="info scoll" v-if="Object.keys(info).length !== 0">
        <table>
          <tr v-for="(value, key) in info" :key="key">
            <td style="width:80px;">{{ key }}</td>
            <td :title="value">{{formatDate(value)}}</td>
          </tr>
        </table>
      </div>
      <div class="toc scoll">
        <ul>
          <li v-for="(t,index) in toc" :key="index" >
            <a :href="'#'+t[4]" target="_self" style="color:var(--fontColor)">
              <div style="width:100%">
                <span v-for="item,index in t[1].length-2" style="width:10px"> </span>
                {{t[6]}}
              </div>
            </a>
          </li>
        </ul>
      </div>
      </div>
    </div>
    <div class="content">
      <div class="nodata" v-if="store.app.files[store.app.fileIndex].content==''">
        <div class="panel">
          <h5>文件无内容和数据</h5>
          <button @click="closeExplorer">
            <i class="fa fa-book"></i>&nbsp; 关闭浏览视图
          </button>
          <button @click="openEdit" v-if="store.app.objectView.indexOf('编辑')==-1">
            <i class="fa fa-code"></i> 打开编辑视图
          </button>
        </div>
      </div>
      <div class="nodata" v-if="prep==''&&store.app.files[store.app.fileIndex].content!=''">
        <div class="panel">
          <h5>文件有数据，无内容</h5>
          <button @click="closeExplorer">
            <i class="fa fa-book"></i>&nbsp; 关闭浏览视图
          </button>
          <button @click="openEdit" v-if="store.app.objectView.indexOf('编辑')==-1">
            <i class="fa fa-code"></i> 打开编辑视图
          </button>
        </div>
      </div>
      <!--查看txt文件-->
      <div v-if="store.app.files[store.app.fileIndex].type=='txt'&&store.app.files[store.app.fileIndex].content!=''" class="prep scoll" v-html="store.app.files[store.app.fileIndex].content">
      </div>
      <!--查看md文件-->
      <div v-if="(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')&&prep!=''" class="prep scoll" v-html="prep" @contextmenu.prevent="nodeContextmenu($event)">
      </div>
    </div>
  </div>
  <div class="menu" v-if="ifMenu&&(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
    <div @click="iftoc=!iftoc" style="padding:2px" :class="[iftoc?'active':'']">
      <i class="fa fa-bars"></i> &nbsp;
      <span v-if="!iftoc">打开目录</span>
      <span v-if="iftoc">关闭目录</span>
    </div>
    <div @click="toggleView()" style="padding:2px">
      <i class="fa fa-map-o"></i> &nbsp;思维导图
    </div>
    <div @click="closeView()" style="padding:2px">
      <i class="fa fa-eye"></i> &nbsp;关闭视图
    </div>
    <div @click="closeTab()" style="padding:2px">
      <i class="fa fa-times"></i> &nbsp;&nbsp;关闭页面
    </div>
  </div>
</template>

<style scoped>
  .md{/**背景 */
    width:100%;
    height: 100%;
    position:relative;
    margin: 0px;
    display: flex;
    flex:1;
  }
  .iftoc:hover{
    opacity: 1;
  }
  ul{
    list-style: none;
    margin: 0px;
    padding:5px;
    padding-top:5px;
    margin-block-end:0px;
  }
  li{
    color:var(--fontColor);
    clear:both;
    height:24px;
    cursor:pointer;
    line-height:28px;
    position: relative;
    white-space:nowrap;
  }
  td{
    padding: 0px;
    text-align: center;
  }
  li:hover{
    color: var(--fontActiveColor);
  }
  li:hover .del{
    display: inline-block;
    text-shadow: 1px 1px 2px black;
  }

  .content{
    position:absolute;
    width:calc(100%);
    height:calc(100%);
    color:var(--fontColor);
    padding: 0px;
    position: relative;
    display: inline-block;
  }
  .Columns{
    position: relative;
    height: 100%;
    display: flex;
    flex-wrap:nowrap;
    flex-direction:row
  }
  .Column{
    width: calc(100% - 2px);
    height:calc(100%);
    position: relative;
    display: inline-block;
    border-right:1px solid var(--borderColor);
    overflow-y: auto;
    overflow-x: hidden;
  }
  .Column::-webkit-scrollbar {
    display: none;
  }
  .prep{
    position: absolute;
    float: left;
    width:calc(100% - 20px);
    height:calc(100% - 20px);
    color:var(--fontColor);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 10px;
    font-size: 16px;
  }
  .nav{
    width:300px;
    min-width:205px;
    max-width:350px;
    height:calc(100%);
    position: relative;
    border-left:1px solid var(--borderColor);
    border-right:1px solid var(--borderColor);
  }
  .nav::-webkit-scrollbar {
    display: none;
  }
  .info{
    padding:5px;
    width:calc(100%);
    border-bottom: 1px solid var(--borderColor);
    height: fit-content;
    max-height: 200px;
    overflow-y: auto;
  }
  .info table tr td{
    white-space: nowrap;
    overflow: none;
    width:calc(100%);
    max-width: 90px;
    text-overflow: ellipsis;
    font-size: 12px;
    padding: 0px;
    height:20px
  }
  .toc{
    overflow: hidden;
    overflow-y: auto;
  }
  .img{
    text-align: center;
    width:100%;
    height: 100%;
  }
  .img img{
    display: table-cell;
    width: 100%;
    height: 100%;
    object-fit:contain;
    z-index:-100;
  }
  button{
    width: 100%;
  }
  input{
    border-color: var(--backgroundColor);
  }
  .menu{
    z-index:100;
    position:fixed;
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    width:fit-content;
    cursor: pointer;
    border-radius: 5px;
    padding: 5px;
  }
  .active{
    background-color: var(--menuColor);
  }
  .loading{
    background-color: var(--backgroundColor);
    padding:5px;
    border: 1px solid var(--borderColor);
  }
  hr{
    background-color:var(--fontColor);
  }
  .nodata{
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    user-select: none;
    overflow: hidden;
  }
  .nodata .panel {
    /* 样式设置，可以根据需要进行自定义修改 */
    height:fit-content;
    width:150px;
    font-size: 16px;
    text-align: center;
  }
  .nodata button {
    /* 样式设置，可以根据需要进行自定义修改 */
    height:35px;
    width:150px;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    font-size: 16px;
  }
</style>
