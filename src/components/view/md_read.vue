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

  let data = store.data[store.index];
  let prep = ref("") //预览
  let iftoc=ref(false) //是否显示目录
  let toc=ref([] as any) //目录
  //yaml信息
  let info = reactive({}) as any
  
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
    /**replaceLink: function (link:any, env:any) {
      const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      //判断是否为链接格式
      const objExp=new RegExp(Expression);
      if(objExp.test(link)==true){
        return link
      }else{
        return "file://"+data.path + "//" + link
      }
    }*/
  }).use(frontMatter, (fm:any) => {
    info = yaml.load(fm)// 解析YAML
  }).use(mathjax3)
  .use(tocAndAnchor, { anchorLink:false })
  .use(mark)

  //.use(replacelink)
  //.use(katex, { throwOnError: false, errorColor: '#CC0000' }) 

  //更新目录和预览
  const init=async function(){
    info={}
    prep.value=''
    if (!store.data || store.data.length === 0) return;
    data = store.data[store.index];
    if (!data) return;
    if(!data.hasOwnProperty('content') && data.content === undefined) data.content=""
    if(data.extension==".md"||data.extension==""){
      RenderMarkdown()
    }
  }
  //渲染markdown
  const RenderMarkdown= async function() {
    data = store.data[store.index]
    if(data.content!=''){
      prep.value = md.render(data.content)
      //计算目录
      toc.value=Array.from(data.content.matchAll(/^(#{2,6})(\s+)(<a\s+.*><\/a>)?(.+)(\r?\n)?/gm))
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
  let selectedText = ref("");
  //发声
  async function speak() {
    let text = store.data[store.index].content;
    if(selectedText.value!=""){
      text = selectedText.value;
    }
    //windows自带的tts
    var utterance = new SpeechSynthesisUtterance();
    // 设置要朗读的文本
    utterance.text = text;
    //使用默认的语音合成器
    var synth = window.speechSynthesis;
    // 将 utterance 添加到语音合成队列中
    synth.speak(utterance);
  }
  //获取选中的文字
  const handleSelection=function() {
    selectedText.value = window.getSelection()?.toString()||'';
  }
  //当点击保存后刷新本页
  async function save(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault();
      if(store.data.length>0){
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
  let ifMenu=ref(false)
  //监听变化init 
  watch(()=>store.data[store.index], (newValue, oldValue) => {
    if(store.data.length>0){
      init()
    }
  })
  onMounted(()=>{
    init()
    window.addEventListener('keydown', save)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', save)
    data = null
  })
</script>

<template >
  <div class="md">
    <div class="nav resize" v-if="iftoc&&(data.extension=='.md')">
      <div style="position: absolute;width:100%;height:100%;display: flex;flex-direction: column;">
        <div style="padding:5px;width:calc(100% - 10px);border-bottom: 1px solid var(--borderColor);color:var(--fontActiveColor)">
          {{ data.label }}<br />
        </div>
        <div class="info scoll" v-if="Object.keys(info).length !== 0">
          <table>
            <tr v-for="(value, key) in info" :key="key">
              <td style="width:80px;">{{ key }}</td>
              <td :title="value">{{value}}</td>
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
      <div v-if="data && (data.extension == '.md')" class="button" style="position: absolute;right:10px;z-index:999" @click="ifMenu=!ifMenu">
        <i class="fa fa-angle-down"></i>
      </div>
      <div v-if="ifMenu" class="menus" @mouseleave="ifMenu=false">
        <div @click="iftoc=true" v-if="!iftoc"><i class="fa fa-bars"></i> 打开目录</div>
        <div @click="iftoc=false" v-if="iftoc"><i class="fa fa-bars"></i> 关闭目录</div>
        <div @click="speak"><i class="fa fa-volume-up"></i> 朗读文章</div>
        <div @click="store.copyToClipboard(store.data[store.index].content)"><i class="fa fa-copy"></i> 复制全文</div>
        <div @click="store.openByApp(store.data[store.index].path)"><i class="fa fa-certificate"></i> 软件打开</div>
      </div>
      <div class="nodata" v-if="data.content==''">
        <h5 style="width: 100%;text-align: center;">文件无内容和数据</h5>
      </div>
      <div class="nodata" v-if="prep==''&&data.content!=''">
        <video v-if="data.extension=='.mp4'" style="width: 100%;height: 100%;object-fit: cover;" controls :src="data.path"></video>
        <img v-if="['.jpg', '.jpeg', '.png', '.gif'].includes(data.extension.toLowerCase())" style="width: 100%;height: 100%;object-fit: contain;" :src="data.path"></img>
        <button @click="store.openByApp(store.data[store.index].path)">无数据，外部打开</button>
      </div>
      <!--查看txt文件-->
      <div v-if="data.extension=='txt'&&data.content!=''" class="prep scoll" v-html="data.content" @mouseup="handleSelection" @keyup="handleSelection">
      </div>
      <!--查看md文件-->
      <div v-if="(data.extension=='.md'||data.extension=='')&&prep!=''" class="prep scoll" v-html="prep" @mouseup="handleSelection" @keyup="handleSelection">
      </div>
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
    border-right: 1px solid var(--borderColor);
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
    width:calc(100% - 10px);
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
  .menus{
    z-index:100;
    background-color: var(--backgroundColor);
    position: absolute;
    right:10px;
    z-index:999;
    display: flex;
    flex-direction: column;
    margin: 5px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    padding: 5px;
    cursor: pointer;
  }
  .menus .menu{
    display: flex;
  }
  .menu .button{
    padding:5px 10px;
    margin-right: 5px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    text-align: center;
  }
  .menu input{
    width: 135px;
    border: 1px solid var(--borderColor);
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
    border-radius: 5px;
    width:150px;
    margin: 5px;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    font-size: 16px;
    position:absolute;
    top: 0px;
    left: 0px;
  }
</style>
