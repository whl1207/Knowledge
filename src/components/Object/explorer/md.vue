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
  //AI配置
  let AIconfig = ref({
        model_url:'ws://127.0.0.1:17860/ws',
        tts_url:'http://127.0.0.1:8080/?&lang=zh&speed=1.0&',
        tts_voice:'mazhao',
        stt_url:'http://127.0.0.1:8080/',
        functions:[
            {title:'正常对话',characters:'',scene:'',instruct:""},
            {title:'总结',characters:'',scene:'',instruct:"请用中文总结以下资料："},
            {title:'指导',characters:'',scene:'',instruct:"我想了解以下主题，请确定并分享从该主题中学到的最重要的部分。"},
            {title:'测试',characters:'',scene:'',instruct:"我目前正在学习以下主题，问我一系列问题来测试我的知识。找出我答案中的知识空白，并给我更好的答案来填补这些空白。"},
            {title:'解释',characters:'',scene:'',instruct:"用任何初学者都能理解的简单易懂的术语解释以下主题。"},
            {title:'重写',characters:'',scene:'',instruct:"重写下面的文字，让初学者容易理解。"},
            {title:'续写',characters:'',scene:'',instruct:"请根据以下文章进行续写："},
            {title:'英文翻译',characters:'专业翻译家',scene:'',instruct:"请将以下段落翻译为英文，要求逻辑通顺，表达自然。"},
            {title:'中文翻译',characters:'专业翻译家',scene:'',instruct:"请将以下段落翻译为中文，要求逻辑通顺，表达自然。"},
            {title:'文字游戏',characters:'游戏执行人员',scene:'组织玩家进行剧本杀',instruct:"我想让你扮演一个基于文本的冒险游戏，我在这个冒险游戏中扮演一个角色。游戏中需要有一个最终的任务，完成了最终的任务，即获得游戏的胜利，否则游戏失败。请尽可能具体地描述角色所看到的内容和环境，并在游戏输出的唯一代码块中回复，而不是其它区域。我将输入命令来告诉角色做了什么，而你需要回复角色的行动结果以推动游戏的进行。请从这里开始故事。我的第一个命令是："},
            /**{title:'剧本杀',instruct:"我需要你扮演专业的剧本杀作者，你将会按照以下剧本模版，结合自己的优秀想象力，写出一个包含丰富饱满的剧情、优秀的文笔、逻辑缜密，非常细节的时间线和线索，推理巧妙、立体饱满的人物角色塑造，能让玩家很轻松代入各自角色新颖创意。完整的剧本需要包含以下内容：剧情简介、人物介绍、我扮演的角色和第一幕场景。并且你要回复角色的行动结果以推动游戏的进行。我需要你围绕以下主题进行创作:"},**/
        ],
        memory:'', //记忆和知识的来源
        searchNum:8 //互联网搜索条目数
    }) //服务地址
  let audioURLs = ref([]) as any //服务地址
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
  let selectedText = ref("");
  //获取选中的文字
  const handleSelection=function() {
    selectedText.value = window.getSelection()?.toString()||'';
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
  //发声
  async function speak() {
    let text = store.app.files[store.app.fileIndex].content;
    if(selectedText.value!=""){
      text = selectedText.value;
    }
    console.log(window.getSelection,text)
    if(AIconfig.value.tts_url==""){
      //windows自带的tts
      var utterance = new SpeechSynthesisUtterance();
      // 设置要朗读的文本
      utterance.text = text;
      //使用默认的语音合成器
      var synth = window.speechSynthesis;
      // 将 utterance 添加到语音合成队列中
      synth.speak(utterance);
    }else{
      //调用tts服务
      //删除yaml信息、替换#和>和*，按照。？！和换行符切割文本
      let parts = text.replace(/^---[\s\S]*?---\n?/gm, '').replace(/[>#*]/g, " ").split(/[。？！\n]+/).filter(part => part.trim() !== '');
      // 进一步处理，确保每个部分不是空的
      parts = parts.map(part => part.trim()).filter(part => part.length > 0);
      console.log(parts);
      await fetchAndPlayAudio(parts);
    }
  }
    //预加载音频并按顺序播放
    async function fetchAndPlayAudio(textParts:any, currentIndex = 0) {
        if (currentIndex >= textParts.length) {
            console.log("播放完毕");
            return; // 所有部分都已播放完毕
        }
        const text = textParts[currentIndex];
        //如果未预加载则预加载音频
        if(currentIndex==0){
            const audioBlob = await fetchAudio(text);
            const audioUrl = URL.createObjectURL(audioBlob);
            audioURLs.value.push(audioUrl);
            const audio = new Audio(audioUrl);

            // 当前音频播放结束时，递归调用以播放下一段
            audio.onended = () => {
                console.log(`Part ${currentIndex + 1} of ${textParts.length} played.`);
                fetchAndPlayAudio(textParts,currentIndex + 1);
            };

            // 如果不是最后一段，提前开始加载下一段音频
            if (currentIndex < textParts.length - 1) {
                const nextText = textParts[currentIndex + 1];
                fetchAudio(nextText) // 提前请求下一段音频，但不等待它完成
                    .then(blob => URL.createObjectURL(blob))
                    .then(url => {
                        // 可以在这里存储或处理预加载的音频URL，但由于自动播放策略，可能需要用户交互来实际播放
                        audioURLs.value.push(url); // 将生成的URL存储到数组中
                    })
                    .catch(error => console.error("Error preloading audio:", error));
            }

            console.log(`Playing part ${currentIndex + 1} of ${textParts.length}`);
            audio.play().catch(error => console.error("Error playing audio:", error));
        }else{
            if(audioURLs.value.length==currentIndex){
                //当未返回音频时等待
                setTimeout(fetchAndPlayAudio, 100,textParts,currentIndex);
            }else if(audioURLs.value.length<currentIndex){
              return;
            }else{
                const audioUrl = audioURLs.value[currentIndex];
                const audio = new Audio(audioUrl);

                audio.onended = () => {
                    console.log(`Part ${currentIndex + 1} of ${audioURLs.value.length} played.`);
                    fetchAndPlayAudio(textParts,currentIndex + 1);
                };
                // 如果不是最后一段，提前开始加载下一段音频
                if (currentIndex < textParts.length - 1) {
                    const nextText = textParts[currentIndex + 1];
                    fetchAudio(nextText) // 提前请求下一段音频，但不等待它完成
                        .then(blob => URL.createObjectURL(blob))
                        .then(url => {
                            // 可以在这里存储或处理预加载的音频URL，但由于自动播放策略，可能需要用户交互来实际播放
                            audioURLs.value.push(url); // 将生成的URL存储到数组中
                        })
                        .catch(error => console.error("Error preloading audio:", error));
                }else{
                    audioURLs.value=[]
                }
                console.log(`Playing part ${currentIndex + 1} of ${audioURLs.value.length}`);
                audio.play().catch(error => console.error("Error playing audio:", error));
            }
        }
    }
  //调用单次请求
  async function fetchAudio(text:string) {
    try {
      const url = AIconfig.value.tts_url+'spk='+AIconfig.value.tts_voice+"&text="+text;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      const audioBlob = await response.blob();
      return audioBlob; // 确保这里返回的是Blob对象
    } catch (error) {
      console.error("Error fetching audio:", error);
      throw error; // 将错误向上抛出，以便可以在调用处捕获
    }
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
    if (localStorage.getItem('AIconfig')!= null) {
      AIconfig.value=JSON.parse(localStorage.getItem("AIconfig")!)
    }
  })
  onBeforeUnmount(() => {
    audioURLs.value=[]
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
      <div v-if="store.app.files[store.app.fileIndex].type=='txt'&&store.app.files[store.app.fileIndex].content!=''" class="prep scoll" v-html="store.app.files[store.app.fileIndex].content" @mouseup="handleSelection" @keyup="handleSelection">
      </div>
      <!--查看md文件-->
      <div v-if="(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')&&prep!=''" class="prep scoll" v-html="prep" @contextmenu.prevent="nodeContextmenu($event)" @mouseup="handleSelection" @keyup="handleSelection">
      </div>
    </div>
  </div>
  <div class="menus" v-if="ifMenu&&(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')" @mouseleave="ifMenu=false" :style="{top:menuPosition.y+'px',left:menuPosition.x+'px'}">
    <div class="menu" style="margin-bottom: 5px;">
      <div @click="iftoc=!iftoc" class="button" :class="[iftoc?'active':'']" :title="iftoc?'关闭目录':'打开目录'">
        <i class="fa fa-bars"></i>
      </div>
      <div @click="toggleView()" class="button" title="切换到思维导图视图">
        <i class="fa fa-map-o"></i>
      </div>
      <div @click="closeView()" class="button" title="关闭视图">
        <i class="fa fa-eye"></i>
      </div>
      <div @click="closeTab()" class="button" title="关闭页面">
        <i class="fa fa-times"></i>
      </div>
      <div @click="speak()" class="button" title="开始朗读">
        <i class="fa fa-volume-up"></i>
      </div>
    </div>
    <div class="menu">
      <div style="padding: 5px;">音色：</div>
      <input v-model="AIconfig.tts_voice"/>
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
  .menus{
    z-index:100;
    position:fixed;
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    width:fit-content;
    cursor: pointer;
    border-radius: 5px;
    padding: 5px;
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
