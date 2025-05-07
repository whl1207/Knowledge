<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref, nextTick,computed} from 'vue'
    import MarkdownIt from 'markdown-it'
    import hljs from 'highlight.js'
    import 'highlight.js/styles/github-dark.css'
    import {Ollama} from 'ollama/dist/browser.mjs'
    import block_md from './block_md.vue'
    import {usestore} from '../store'
    const store=usestore()
    
    let input = ref("") //输入的消息
    let history = ref([]) as any //历史聊天记录
    
    let panel = ref("") //面板显示参数，可以是设置或者配置
    let config = ref({
        memoryType:'无', //记忆类型
        memory:'' as string, //记忆文本
        memoryList:[] as any, //{name:'',path:'',content:''}名称、地址、内容
        image:null as any,
        searchNum:5, //互联网搜索条目数
        ifNLP:false, //使用NLP压缩关键信息
        ifSpeak:false //自动朗读
    })

    let ollama=new Ollama({host: store.AIconfig.model_url}) as any //服务
    //改变Ollama服务地址
    function changeOllamaServe() {
        ollama = new Ollama({host: store.AIconfig.model_url})
    }
    let weblink = ref([]) as any//互联网资料 
    let funcIndex = ref(0) //功能序数
    let prompt = ref("") //提示词

    let strlimit = ref(4000) //知识库字数限制
    //渲染库设置
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
    }) as any
    const RenderMarkdown= function(str:string) {
        return md.render(str)
    }
    
    //清空历史
    const trash = function(){
        history.value=[];
        nextTick()
    }
    //监听回车键
    let textarea = ref(null)
    const enter = async function(e:any) {
        //if (e.keyCode == "13" && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
        if (e.keyCode == "13"&&document.activeElement === textarea.value) {
            e.preventDefault()
            chat()
        }
    }
    //更新提示词
    let updatePrompt = ()=>{
        //合成后的提示词：角色、场景、指令、参考资料、具体需求
        let characters = (store.AIconfig.functions[funcIndex.value].characters!=""?"我希望你表现得像" + store.AIconfig.functions[funcIndex.value].characters+"。":'')
        let scene = (store.AIconfig.functions[funcIndex.value].scene!=""?"现在你正在" + store.AIconfig.functions[funcIndex.value].scene+"。":'')
        let instruct = store.AIconfig.functions[funcIndex.value].instruct
        prompt.value = characters+scene+instruct+input.value+config.value.memory
    }
    //上传知识库文件
    const handleFileDrop = async function(event:any){
        event.preventDefault();
        const files = event.dataTransfer.files
        for (const file of files) {
            // 执行上传操作，例如通过API发送文件给服务器
            const fileExtension = file.name.split('.').pop().toLowerCase();
            if (fileExtension === 'docx' || fileExtension === 'pdf' || fileExtension === 'md') {
                let content = await window.ipcRenderer.invoke('readFile', file.path)
                config.value.memoryList.push(
                    {
                        name:file.name,
                        path:file.path,
                        content:content,
                    }
                )
            }       
        }
        updatePrompt()
    }
    //上传图片
    const handleImageDrop = async function(event:any){
        event.preventDefault();
        const files = event.dataTransfer.files
        for (const file of files) {
            // 执行上传操作，例如通过API发送文件给服务器
            const fileExtension = file.name.split('.').pop().toLowerCase();
            if (fileExtension === 'jpg'||fileExtension === 'png'||fileExtension === 'webp') {
                console.log(file)
                config.value.image=file
            }       
        }
        const reader = new FileReader();
        reader.onloadend = function() {
            if (typeof reader.result === 'string') {
                const base64String = reader.result.split(',')[1];
                config.value.image.base64=base64String
            } else {
                console.log('error')
            }
        }
        reader.readAsDataURL(config.value.image);
    }
    //删除记忆
    const delMemory = function(index:number){
        if(confirm("取消该资料关联吗？")){
            config.value.memoryList.splice(index,1)
            updatePrompt()
        }
    }
    //获取互联网信息
    const searchOnline = function(query:string,numResults:number){
        var url = "https://www.bing.com/search?q=" + query
        // 创建一个HTTP GET请求对象
        const request = new XMLHttpRequest()
        request.open("GET", url, false)  // 同步请求
        request.send()

        // 解析HTML内容
        const parser = new DOMParser()
        const htmlDoc = parser.parseFromString(request.responseText, "text/html")

        // 获取搜索结果的节点列表
        const resultNodes = htmlDoc.querySelectorAll("li.b_algo")

        // 提取搜索结果的网页链接和简介
        weblink.value = []
        let str = ""
        for (let i = 0; i < Math.min(resultNodes.length, numResults); i++) {
            const linkNode = resultNodes[i].querySelector("h2 a")
            const descriptionNode = resultNodes[i].querySelector(".b_caption p")
            if (linkNode && descriptionNode) {
                const link = linkNode.getAttribute('href')||''
                const description = descriptionNode.textContent!.trim()
                // 创建新的XMLHttpRequest来获取链接指向的网页
                const detailRequest = new XMLHttpRequest();
                detailRequest.open("GET", link, false); // 同步请求
                detailRequest.send();

                // 解析获取到的网页内容
                const detailDoc = parser.parseFromString(detailRequest.responseText, "text/html");
                // 获取网页标题
                const title = detailDoc.title;

                weblink.value.push({ link, description,title })
                str=str+description+"。"
            }
        }
        return str
    }
    //
    const searchAI = function(query:string){
        var url = "https://r.jina.ai/https://www.bing.com/search?q=" + query;
        const request = new XMLHttpRequest()
        request.open("GET", url, false)  // 同步请求
        request.send()
        return request.responseText
    }
    //开始聊天
    const chat=async function(){
        /** 
            let RAG = ollama.embeddings({
                model: 'nomic-embed-text',
                prompt: 'prompt.value',
            })
            console.log(RAG)
        **/
        //判断是否关联知识库
        if(config.value.memoryType=="网络搜索"){
            config.value.memory='互联网搜索到的资料如下：'+searchOnline(input.value,config.value.searchNum)
        }else if(config.value.memoryType=="AI搜索"){
            config.value.memory='互联网搜索到的资料如下：'+await searchAI(input.value).toString()
        }else if(config.value.memoryType=='本地'){
            config.value.memory=''
            config.value.memory='参考资料如下：'
            for (const item of config.value.memoryList) {
                config.value.memory=config.value.memory+item.content+"。"
            }
        }else{
            config.value.memory=''
        }
        if(config.value.memory.length>0){//是否压缩资料参考资料
            if(config.value.ifNLP){
                //打开nlp压缩查找最相近的句子
                //let result=await findMostSimilarSentence(input.value, AIconfig.value.memoryContent)
                //AIconfig.value.memoryContent=result
            }
        }
        updatePrompt()
        if(prompt.value=='') return
        if(store.AIconfig.AI_type=='智谱'){
            history.value.push({
                role:'user',
                content:prompt.value,
                prep:prompt.value,
            })
            history.value.push({role:'assistant',content:'正在思考...',prep:'正在思考...'})
            const apiKey = store.AIconfig.zhipu_APIkeys;
            const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

            const data = {
                model: store.AIconfig.model_type,
                stream:true,
                messages: history.value
            };

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder(); // 用于解码流中的文本
                history.value[history.value.length-1].content=""
                // 读取流
                async function readStream() {
                    if (!reader) {
                        throw new Error('Failed to get reader from response body');
                    }

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }else{
                            // 解码并输出流中的数据
                            const chunk = decoder.decode(value, { stream: true });
                            const parts = chunk.split('data: ').filter(part => part.trim() !== '')
                            const jsonObjects = parts.map(part => {
                                try {
                                    const t =chunk.match(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/)
                                    if (t) {
                                        let r = JSON.parse(t[0]).delta.content
                                        history.value[history.value.length-1].content=history.value[history.value.length-1].content+r
                                        history.value[history.value.length-1].prep=RenderMarkdown(history.value[history.value.length-1].content)
                                    }
                                } catch (error) {
                                    console.error("Error parsing JSON:", error);
                                    return null;
                                }
                            })
                        }
                    }
                }

                await readStream();

            } catch (error) {
                console.error('Error:', error);
            }
            return
        }
        
        //界面更新
        if(config.value.memoryType=='多模态'){ //多模态
            history.value.push({
                role:'user',
                content:prompt.value,
                prep:prompt.value,
                image:config.value.image.path,
            })
            history.value.push({role:'assistant',content:'正在思考...',prep:'正在思考...'})
            
            nextTick
            var element = document.getElementById("AI_messages")! //滑动聊天
                element.scrollTop = element.scrollHeight
            const response = await ollama.generate({
                model: store.AIconfig.model_type,
                prompt: prompt.value,
                images: [config.value.image.base64],
                stream: true,
            })
            history.value[history.value.length-1].content=""
            history.value[history.value.length-1].prep=""
            for await (const part of response) {
                history.value[history.value.length-1].content=history.value[history.value.length-1].content+part.response
                history.value[history.value.length-1].prep=RenderMarkdown(history.value[history.value.length-1].content)
                element.scrollTop = element.scrollHeight
            }
        }else{ //普通聊天模式
            
            history.value.push({
                role:'user',
                content:prompt.value,
                prep:prompt.value,
            })
            input.value=""
            history.value.push({role:'assistant',content:'正在思考...',prep:'正在思考...',weblink:JSON.parse(JSON.stringify(weblink.value))})
            prompt.value=""
            nextTick
            var element = document.getElementById("AI_messages")! //滑动聊天
                element.scrollTop = element.scrollHeight
            //发送到ollama服务
            const response = await ollama.chat({ model: store.AIconfig.model_type, messages: history.value, stream: true })
            //const firstCharacter = ''//(await response.next()).value.message.content
            //收到第一个字符时
            history.value[history.value.length-1].content=""
            history.value[history.value.length-1].prep=""
            //流式输出
            for await (const part of response) {
                history.value[history.value.length-1].content=history.value[history.value.length-1].content+part.message.content
                history.value[history.value.length-1].prep=RenderMarkdown(history.value[history.value.length-1].content)
                element.scrollTop = element.scrollHeight
            }
            //输出后添加到对话记录
            if(config.value.ifSpeak) store.tts(history.value[history.value.length-1].content)
            updatePrompt()
        }
    }
    //删除功能
    const addFunc = function(){
        store.AIconfig.functions.push({
            title:'新功能',
            characters:'',
            scene:'',
            instruct:''
        });
    }
    //删除功能
    const delFunc = function(){
        if(funcIndex.value!=0){
            if(confirm("确认删除此功能吗？")){
                store.AIconfig.functions.splice(funcIndex.value);
                funcIndex.value=0;
            }
        }
    }
    const recording = ref<boolean>(false);
    
    //初始化
    onMounted(()=>{
        if (localStorage.getItem('history')!= null) {
            history.value=JSON.parse(localStorage.getItem("history")!)
        }else{
            history.value=[]
        }
        if (localStorage.getItem('config')!= null) {
            config.value=JSON.parse(localStorage.getItem("config")!)
        }
        window.addEventListener('keydown', enter)
    })
    //关闭该模块时
    onBeforeUnmount(() => {
        window.removeEventListener('keydown', enter)
        localStorage.setItem("history",JSON.stringify(history.value))
        localStorage.setItem("config",JSON.stringify(config.value))
    })
</script>
    
<template>
    <div class="bg">
        <div class="header">
            <select v-model="store.AIconfig.AI_type" style="flex:1;margin: 5px 0px 5px 5px;max-width: 70px;min-width: 60px;" :class="{active:store.AIconfig.state}">
                <option v-for="(option, index) in store.AIconfig.AI_types" :key="index" :value="option">{{ option }}</option>
            </select>
            <select v-model="store.AIconfig.model_type" style="flex:1;margin: 5px 0px 5px 5px;max-width: 170px;min-width: 90px;" @click="store.getAIconfig()">
                <option v-for="(option, index) in store.AIconfig.model_types" :key="index" :value="option.name">{{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})</option>
            </select>
            <div style="flex:2;-webkit-app-region: drag;"></div>
            <div class="button" :class="{active:store.mainPanel==''}" @click="store.mainPanel!=''?store.mainPanel='':store.mainPanel=''"><i class="fa fa-window-maximize"></i></div>
            <div title="删除聊天历史" @click="trash()" class="button" style="margin-right: 5px;"> 
                <i class="fa fa-trash"></i>
            </div>
        </div>
        <div class="message scoll" id="AI_messages">
            <div v-for="(item,index) in history" class="item" :class="{me_message:item.role=='user',ai_message:item.role=='assistant'}">
                <block_md :content="item.content"/>
                <img v-if="item.image!=undefined" :src="item.image"  style="width: 100%;height: 60px;object-fit: cover;"/>
                <div class="set">
                    <a :title="link.description+link.link" :href="link.link" target="_blank" v-for="(link,i) in item.weblink">{{link.title}}</a>
                    <i class="fa fa-times" @click="history.splice(index,1)"></i>
                </div>
            </div>
        </div>
        <div style="display: flex;border-top: var(--borderColor) 1px solid;padding: 5px 5px 0px 5px;">
            <div class="scoll" style="width:100px;font-size: 10px;max-height: 100px;overflow-y: auto;" v-if="config.memoryType=='本地'&&config.memoryList.length>0">
                <div v-for="(item,index) in config.memoryList" style="margin: 0px 5px;white-space: nowrap;max-width: 100px;overflow: hidden;text-overflow: ellipsis;cursor: pointer;" @click="delMemory(index)">
                    <i class="fa fa-file-text-o"></i> {{item.name}}/{{ item.content.length+'字' }}
                </div>
            </div>
            <div class="scoll" style="width:100px;max-height: 60px;overflow: hidden;border: 1px solid var(--borderColor);" v-if="config.memoryType=='多模态'&&config.image!=null" @dragover.prevent @drop="handleImageDrop">
                <img style="width: 100%;height: 100%;object-fit: cover;" :src="config.image.path">
            </div>
            <textarea ref="textarea" class="scoll" style="flex:2;min-height:50px;height:calc(100% - 10px);border-radius: 5px 0px 0px 5px;" v-model="input" :placeholder="prompt"></textarea>
            <div class="button" title="发送，快捷键为：enter" @click="chat()" style="width:15px;height:calc(100% - 6px);margin:0px;line-height: 55px;text-align: center;border-radius: 0px 5px 5px 0px;border-left:0px">
                <i class="fa fa-send"></i>
            </div>
        </div>
        <div class="footer">
            <div title="打开设置" @click="panel=='设置'?panel='':panel='设置'" :style="{color:panel=='设置'?'var(--fontActiveColor)':'',backgroundColor:panel=='设置'?'var(--menuActiveColor)':''}">
                <i class="fa fa-cog"></i>
            </div>
            <div title="功能" @click="panel=='功能'?panel='':panel='功能'" :style="{color:panel=='功能'?'var(--fontActiveColor)':'',backgroundColor:panel=='功能'?'var(--menuActiveColor)':''}">
                <i class="fa fa-user-o"></i>
            </div>
            <div v-if="config.memoryType=='本地'" @dragover.prevent @drop="handleFileDrop" title="拖动到此处，上传文件进行对话">
                <i class="fa fa-file-text-o"></i>
            </div>
            <div v-if="config.memoryType=='多模态'" @dragover.prevent @drop="handleImageDrop" title="拖动到此处，上传图片进行对话">
                <i class="fa fa-file-image-o"></i>
            </div>
            <select v-model="config.memoryType">
                <option value="无">无</option>
                <option value="本地">本地</option>
                <option value="多模态">多模态</option>
                <option value="网络搜索">网络搜索</option>
                <option value="AI搜索">AI搜索</option>
            </select>
            <select v-model="funcIndex" @change="updatePrompt">
                <option v-for="(option, index) in store.AIconfig.functions" :key="index" :value="index">{{ option.title }}</option>
            </select>
        </div>

        <div class="config scoll" v-if="panel=='功能'">
            <div class="header">
                功能 <i @click="panel=''" style="flex:1;text-align: right;margin-right:5px;margin-top:5px" class="fa fa-times"></i>
            </div>
            <div class="body scoll">
                <div class="function" v-for="(item,index) in store.AIconfig.functions" @click="funcIndex=index;updatePrompt()" :class="[funcIndex==index?'active':'']">
                    {{ item.title==""?"未命名":item.title }}
                </div>
                <div class="function" @click="addFunc()">
                    <i class="fa fa-plus"></i>
                </div>
                <table>
                    <tr>
                        <td title="功能" style="width:40px"><i class="fa fa-superpowers"></i></td>
                        <td><input v-model="store.AIconfig.functions[funcIndex].title" style="width:calc(100% - 40px)"  @change="updatePrompt"/> <i class="fa fa-trash" @click="delFunc()"></i></td>
                        <td title="人设"><i class="fa fa-user-o"></i></td>
                        <td><input v-model="store.AIconfig.functions[funcIndex].characters" @change="updatePrompt"/></td>
                        <td title="场景"><i class="fa fa-building"></i></td>
                        <td><input v-model="store.AIconfig.functions[funcIndex].scene" @change="updatePrompt"/></td>
                    </tr>
                    <tr>
                        <td title="指令"><i class="fa fa-info"></i></td>
                        <td colspan="5" style="padding:0px">
                            <textarea v-model="store.AIconfig.functions[funcIndex].instruct" class="scoll" style="height:px;width:calc(100% - 25px);margin: 5px 5px 0px 5px;"></textarea>
                        </td>
                    </tr>
                </table>
            </div>
        </div>
        <div class="config scoll" v-if="panel=='设置'">
            <div class="header">
                配置 <i @click="panel=''" style="flex:1;text-align: right;margin-right:5px;margin-top:5px" class="fa fa-times"></i>
            </div>
            <div class="body scoll">
                <table>
                        <tr >
                            <td>{{store.locales=='zh'?'模型地址':'Model URL:'}}</td>
                            <td><input v-model="store.AIconfig.model_url" @change="changeOllamaServe"/></td>
                        </tr>
                        <tr >
                            <td>{{store.locales=='zh'?'智谱密匙':'APIkey:'}}</td>
                            <td><input v-model="store.AIconfig.zhipu_APIkeys" type="password"/></td>
                        </tr>
                        <tr >
                            <td>{{store.locales=='zh'?'TTS类型':'TTS type:'}}</td>
                            <td><select v-model="store.AIconfig.tts_type" style="height:32px;margin:0px 5px;flex:1;margin: 5px 0px 5px 5px;">
                                <option value="本地">本地</option>
                                <option value="GPT_Sovite">GPT_Sovite</option>
                            </select></td>
                        </tr>
                        <tr v-if="store.AIconfig.tts_type=='GPT_Sovite'">
                            <td>{{store.locales=='zh'?'TTS地址':'TTS URL:'}}</td>
                            <td><input v-model="store.AIconfig.tts_url"/></td>
                        </tr>
                        <tr v-if="store.AIconfig.tts_type=='GPT_Sovite'">
                            <td>{{store.locales=='zh'?'TTS音色':'TTS voice:'}}</td>
                            <td><input v-model="store.AIconfig.tts_voice"/></td>
                        </tr>
                        <tr>
                            <td>{{store.locales=='zh'?'STT地址':'STT URL:'}}</td>
                            <td><input v-model="store.AIconfig.stt_url"/></td>
                        </tr>
                        <tr >
                            <td>{{store.locales=='zh'?'搜索条目':'Search Number:'}}</td>
                            <td><input title="搜索条目数" v-model="config.searchNum"/></td>
                        </tr>
                        <tr >
                            <td>{{store.locales=='zh'?'token限制':'token Limit:'}}</td>
                            <td><input v-model="strlimit"/></td>
                        </tr>
                </table>
                <div style="display: flex;flex-direction:row;">
                    <div class="button" style="flex:1;" @click="config.ifNLP=!config.ifNLP" :style="{color:config.ifNLP?'var(--fontActiveColor)':''}" :title="store.locales=='zh'?'NLP压缩':'NLP:'"><i class="fa fa-file-zip-o"></i></div>
                    <div class="button" style="flex:1;" @click="config.ifSpeak=!config.ifSpeak" :style="{color:config.ifSpeak?'var(--fontActiveColor)':''}" :title="store.locales=='zh'?'自动朗读':'auto tts:'"><i class="fa fa-volume-up"></i></div>
                    <div class="button" style="flex:1;" @click="config.memoryList=[];config.image=null;updatePrompt()" :title="store.locales=='zh'?'清空记忆':'clear'"><i class="fa fa-trash"></i></div>
                </div>
            </div>
        </div>
    </div>
</template>
    
<style scoped>
    .bg{
        position: relative;
        height:calc(100%);
        display: flex;
        flex-direction: column;
        user-select:text;
        overflow: hidden;
    }
    .header{
        width: calc(100%);
        border-bottom: var(--borderColor) 1px solid;
        display: flex;
    }
    .message{
        padding: 5px;
        flex:1;
        flex-direction: column;
        overflow-y: auto;
        bottom: 0;
        background-color: var(--backgroundColor);
    }
    .message .item{
        margin-bottom:3px
    }
    .message .item .set{
        font-size: 10px;
        text-align: right;
        height:0px;
        overflow: hidden;
        transition: 0.5s;
        border-top:0px solid var(--borderColor) ;
    }
    .set a{
        float:left;
        display: inline-block; /* 或者 block，取决于具体需求 */
        width: 60px; /* 设置固定宽度 */
        white-space: nowrap; /* 确保文本在一行内显示 */
        overflow: hidden; /* 隐藏超出部分 */
        text-overflow: ellipsis; /* 超出部分显示省略号 */
        border:1px solid var(--borderColor);
        margin-right:5px;
        padding:2px;
        color:var(--fontColor);
        font-size:8px;
    }
    .message .item:hover .set{
        height:fit-content;
        z-index: 999;
        margin-top: 3px;
        padding-top: 3px;
        padding-right: 5px;
        border-top:1px solid var(--borderColor) ;
        color:var(--fontColor);
    }
    .ai_message{
        border: 1px solid var(--borderColor);
        width:fit-content;
        max-width:calc(100% - 20px);
        border-radius: 3px;
    }
    .me_message{
        border: 1px solid var(--borderColor);
        color:var(--fontActiveColor);
        border-radius: 3px;
        width:fit-content;
        max-width:calc(100% - 20px);
        margin-left: auto
    }
    .footer{
        display: flex;
        padding: 0px 5px ;
    }
    .footer div{
        margin:2px 0px;
        width:100%;
        text-align:center;
        line-height:30px;
        flex:1;
    }
    .footer select{
        flex:2;
        height:26px;
        margin:4px 0px;
        border-radius: 5px;
    }
    .config{
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border-radius: 5px;
        border: var(--borderColor) 1px solid;
        background-color: var(--backgroundColor);
        width:calc(50% + 150px);
        max-width: 95%;
        max-height: calc(100% - 90px);
        user-select: none;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .header{
        background-color: var(--menuColor);
    }
    .body{
        padding:5px;flex-grow: 1;
        overflow-y: auto;
    }
    .tabs{
        display: flex;
    }
    .config table{
        width: 100%;
        margin: 2px 0px;
    }
    .config table tr td{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: center;
        padding: 0px;
    }
    .active{
        background-color: var(--menuColor);
        color:var(--fontActiveColor)
    }
    hr{
        width: calc(100% - 6px);
        border-color:var(--borderColor);
        margin:2px;
    }
    .function{ /*按钮样式*/
        margin:2px;
        padding:2px 5px;
        color:var(--fontColor);
        border: 1px solid var(--borderColor);
        width: fit-content;
        display: inline-block;
        border-radius: 5px;
        -webkit-app-region: no-drag;
        line-height: normal;
        background-color: var(--menuColor);
        margin-right: 0px;
        text-align: center;
        user-select: none;
        cursor: pointer;
        font-size: 14px;
    }
    .function:hover{
        background-color: var(--menuActiveColor);
    }
</style>
    