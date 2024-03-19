<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref, nextTick,computed} from 'vue'
    import {usestore} from '../../store'
    import MarkdownIt from 'markdown-it'
    import hljs from 'highlight.js'
    import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.js' 
    import * as workerSrc from 'pdfjs-dist/build/pdf.worker.entry.js'
    PDFJS.GlobalWorkerOptions.workerSrc = workerSrc
    
    const store=usestore()
    let state = ref("AI Offline")
    let input = ref("") //输入的消息
    let message=ref("") //消息返回值
    let prep=ref("") //消息渲染值
    let ifhistory = ref(false)
    let history = ref([]) as any //历史聊天记录
    let ifNLP = ref(false) //使用NLP压缩关键信息
    let ifSpeak =ref(false) //自动朗读
    let panel = ref("") //面板显示参数，可以是设置或者配置
    let AIconfig = ref({
        model_url:'ws://127.0.0.1:17860/ws',
        tts_url:'http://127.0.0.1:8080/?&lang=zh&speed=1.0&',
        tts_voice:'mazhao',
        tts_language:'zh',
        stt_url:'http://127.0.0.1:8080/',
        wiki_url:'http://127.0.0.1/',
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
    let weblink = ref([]) //互联网资料 
    let funcIndex = ref(0) //功能序数
    let reference = ref("") //参考资料
    const prompt = computed(() => (AIconfig.value.functions[funcIndex.value].characters!=""?"你是一名"+AIconfig.value.functions[funcIndex.value].characters+"。":'')+(AIconfig.value.functions[funcIndex.value].scene!=""?"现在你正在"+AIconfig.value.functions[funcIndex.value].scene+"。":'')+AIconfig.value.functions[funcIndex.value].instruct+reference.value+input.value); //合成后的提示词

    let audioURLs = ref([]) as any;
    let strlimit = ref(4000) //知识库字数限制
    let TTSaudio = new Audio();//TTS音频

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
        replaceLink: function (link:any, env:any) {
        const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
        const objExp=new RegExp(Expression);
        if(objExp.test(link)==true||store.app.files[store.app.fileIndex].cloud==true){
            return "http://" + store.app.files[store.app.fileIndex].ip+"/"+store.app.files[store.app.fileIndex].parentPath + "/" + link
        }else{
            return "file://"+store.app.files[store.app.fileIndex].parentPath + "//" + link
        }
        }
    })
    const RenderMarkdown= async function() {
        prep.value = md.render(message.value)
    }
    
    //检查服务器状态
    function checkWebSocketAvailability() {
        let webSocket = new WebSocket(AIconfig.value.model_url);
        webSocket.onopen = function() {state.value="AI Online"}
        webSocket.onclose = function() {state.value="AI Offline"}
        webSocket.onerror = function() {state.value="AI ERROR"}
    }

    //发送聊天信息
    let send_raw = async (prompt:any, keyword:any, QA_history:any, onmessage = alert, addition_args = {}) => {
        if(input.value!=""){
            history.value.push({role:'user',content:input.value,prep:input.value})
        }
        input.value=""
        let result = ''
        let initContent=""
        if(store.app.files.length>0){
            initContent=store.app.files[store.app.fileIndex].content||""
        }
        await new Promise(resolve => {
            let ws = new WebSocket(AIconfig.value.model_url);
            ws.onmessage = function (event:any) {
                message.value = event.data
                RenderMarkdown()
                var element = document.getElementById("AI_messages")!
                element.scrollTop = element.scrollHeight
            };
            Object.assign(addition_args, {
                prompt: prompt,
                keyword: keyword,
                temperature: 0.8,
                top_p: 0.8,
                max_length: 4100,
                history: QA_history
            })
            ws.onopen = function () {
                ws.send(JSON.stringify(addition_args))
            };
            ws.onclose = function () {
                resolve("")
                history.value.push({role:'AI',content:message.value,prep:prep.value,weblink:JSON.parse(JSON.stringify(weblink.value))})
                if(ifSpeak.value) speak(message.value)
                message.value=""
            }
            ws.onerror = function(event:any) {
                prep.value="连接出错了，请检查AI状态"
                // 无法连接到WebSocket服务器，进行相应处理
            };
        })
        return result
    }
    //复制文本到剪贴板
    function copyToClipboard(text:string) {
        // 创建一个临时的textarea元素
        const tempTextArea = document.createElement('textarea');
        tempTextArea.value = text;
        
        // 将textarea添加到document中
        document.body.appendChild(tempTextArea);
        
        // 选中textarea中的文本
        tempTextArea.select();
        
        // 复制文本到剪贴板
        document.execCommand('copy');
        
        // 删除临时textarea元素
        document.body.removeChild(tempTextArea);
        store.app.notification="复制成功"
    }
    //发声
    async function speak(text:string) {
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
            audio.play().catch(error => console.error("Error playing audio:", error));
        }else{
            console.log(audioURLs.value.length,currentIndex)
            if(audioURLs.value.length==currentIndex){
                //当未返回音频时等待
                setTimeout(fetchAndPlayAudio, 500,textParts,currentIndex);
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
    //停止tts
    function stopSpeak(){
        // 停止当前的朗读
        if(AIconfig.value.tts_url==""){
            //停止本地朗读
            var synth = window.speechSynthesis;
            synth.cancel();
        }else{
            if (!TTSaudio.paused) { // 如果音频正在播放
                TTSaudio.pause(); // 停止播放
                TTSaudio.currentTime = 0; // 重置音频到开始位置
            }
        }
    }
    //清空历史
    const trash = function(){
        history.value=[];
        nextTick()
    }
    //监听回车键
    const enter = async function(e:any) {
        if (e.keyCode == "13" && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            chat()
        }
    }
    //获取pdf内容
    async function parsePDF(pdfUrl:string) {
        //PDFJS.GlobalWorkerOptions.workerSrc = './public/pdf.worker.js';
        const loadingTask = PDFJS.getDocument(pdfUrl);
        const pdfDocument = await loadingTask.promise;
        const pageCount = pdfDocument.numPages;
        
        let textContent = '';

        for (let i = 1; i <= pageCount; i++) {
            const page = await pdfDocument.getPage(i);
            const content = await page.getTextContent();
            const strings = (content as {items: {str: string}[]}).items.map(item => item.str);
            textContent += strings.join(' ');
        }
        return textContent;
    }
    //获取互联网信息
    const searchOnline = function(query:string,numResults:number){
        var xhr = new XMLHttpRequest()
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
    //使用nlp.js处理知识库
    async function findMostSimilarSentence(query:string, str:any) {
        //切割知识库
        let arr = str.split(/[.\。\n]/)
        //过滤不用的元素
        const sentences: string[] = arr.filter((item:string) => item !== "")
        const { NlpManager,Translation } = require('node-nlp')
        const manager = new NlpManager({ languages: ['zh','en'] })
        //const lang = detectLanguage(str)
        // 添加文本样本
        for (let i = 0; i < sentences.length; i++) {
            manager.addDocument('zh', sentences[i], `${i}`);
        }
        
        // 训练NLP模型
        await manager.train();
        //查找 最相近的句子
        const response = await manager.process('zh', query);
        //console.log(response)
        //获取最相关的句子序号
        let resultid=[]
        for(let i=0;i<response.nluAnswer.classifications.length;i++){
            resultid.push(response.nluAnswer.classifications[i].intent)
        }
        //将附近句子的序号也加入进来
        let newresultid=[] as any[]
        for(let i = 0;i<Math.min(resultid.length,10);i++){
            let id =parseInt(resultid[i])
            //console.log(id)
            //添加后十句，并判断句子是否为空
            for(let j = 0;j<8;j++){
                if(sentences[id+j]!=""&&sentences[id+j]!=undefined){
                    newresultid.push(id+j)
                    //console.log(id+j,sentences[id+j])
                }
            }
        }
        //删除参考资料的重复项
        newresultid = [...new Set(newresultid)]
        //对参考资料进行排序
        newresultid = newresultid.sort(function(a, b) {return a-b})
        //console.log(newresultid)
        let result=""
        for(let i = 0;i<newresultid.length;i++){
            //清理数组
            result=result+sentences[newresultid[i]]+"。"
            //console.log(newresultid[i],sentences[newresultid[i]])
        }
        //console.log(result)
        return result
    }
    //开始聊天
    const chat=async function(){
        //使用nlp处理知识库

        //判断是否关联知识库
        if(AIconfig.value.memory=="本地文件"&&(store.app.files.length>0&&store.app.fileIndex>-1)){
            if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type==".txt"||store.app.files[store.app.fileIndex].type==""){
                if(!ifNLP.value){
                        //不打开nlp压缩文本
                        reference.value="。参考资料如下："+store.app.files[store.app.fileIndex].content
                    }else{
                        //打开nlp查找最相近的句子
                        let result=await findMostSimilarSentence(input.value, store.app.files[store.app.fileIndex].content)
                        reference.value="。参考资料如下："+result
                        send_raw(prompt.value,'',ifhistory.value?history.value:[])
                        return
                    }
                }else if(store.app.files[store.app.fileIndex].type==".pdf"){
                    parsePDF(store.app.files[store.app.fileIndex].fullPath)
                    .then(async content => {
                        if(!ifNLP.value){
                            console.log(content.length)
                            //不打开nlp压缩文本
                            reference.value="。参考资料如下："+content.slice(0, strlimit.value);
                        }else{
                            //打开nlp查找最相近的句子
                            let result=await findMostSimilarSentence(input.value, content)
                            //console.log(result)
                            reference.value="。参考资料如下："+result
                            send_raw(prompt.value,'',ifhistory.value?history.value:[])
                            return
                        }
                        //console.log(str)
                        send_raw(prompt.value,'',ifhistory.value?history.value:[])
                    })
                    .catch(error => {
                        console.error(error)
                })
                return
            }
        }
        if(AIconfig.value.memory=="互联网"){
            reference.value="。网络收集到的资料如下："+searchOnline(input.value,AIconfig.value.searchNum)
        }else{
            reference.value=""
        }
        send_raw(prompt.value,'',ifhistory.value?history.value:[])
    }
    //删除功能
    const addFunc = function(){
        AIconfig.value.functions.push({
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
                AIconfig.value.functions.splice(funcIndex.value);
                funcIndex.value=0;
            }
        }
    }
    //全屏对话
    const fullAI =function(){
        store.app.navWidth==400?store.app.navWidth=document.body.clientWidth:store.app.navWidth=400
    }
    //初始化
    onMounted(()=>{
        checkWebSocketAvailability()
        if (localStorage.getItem('history')!= null) {
            history.value=JSON.parse(localStorage.getItem("history")!)
        }else{
            history.value=[]
        }
        if (localStorage.getItem('AIconfig')!= null) {
            AIconfig.value=JSON.parse(localStorage.getItem("AIconfig")!)
        }
        window.addEventListener('keydown', enter)
    })
    //关闭该模块时
    onBeforeUnmount(() => {
        window.removeEventListener('keydown', enter)
        audioURLs.value=[]
        localStorage.setItem("history",JSON.stringify(history.value))
        localStorage.setItem("AIconfig",JSON.stringify(AIconfig.value))
    })
</script>
    
<template>
    <div class="bg">
        <div class="header" @click="checkWebSocketAvailability">
            <span :style="{color:state=='AI Online'?'var(--fontActiveColor)':''}" style="border:1px solid var(--borderColor);padding:5px;margin-right: 5px;border-radius: 5px;user-select: none;"> 
                <i class="fa fa-reddit"></i> {{ state }}
            </span>
            <span style="border:1px solid var(--borderColor);padding:5px;border-radius: 5px;user-select: none;"> 
                {{ AIconfig.functions[funcIndex].title==""?"未命名":AIconfig.functions[funcIndex].title }}
            </span>
            <span title="界面最大" @click="fullAI" style="border:1px solid var(--borderColor);padding:5px 10px;border-radius: 5px;float:right"> 
                <i class="fa fa-arrows-alt"></i>
            </span>
            <span title="打开设置" @click="panel=='设置'?panel='':panel='设置'" style="border:1px solid var(--borderColor);padding:5px 10px;border-radius: 5px;float:right;margin-right: 5px;" :style="{color:panel=='设置'?'var(--fontActiveColor)':'',backgroundColor:panel=='设置'?'var(--menuActiveColor)':''}">
                <i class="fa fa-cog"></i>
            </span>
        </div>
        <div class="message scoll" id="AI_messages">
            <div v-for="(item,index) in history" class="item" :class="{me_message:item.role=='user',ai_message:item.role=='AI'}">
                <div v-html="item.prep" >
                </div>
                <div class="set">
                    <a :title="link.description+link.link" :href="link.link" target="_blank" v-for="(link,i) in item.weblink">{{link.title}}</a>
                    <i class="fa fa-volume-off" @click="stopSpeak()"></i> &nbsp;
                    <i class="fa fa-volume-up" @click="speak(item.content)"></i> &nbsp;
                    <i class="fa fa-copy" @click="copyToClipboard(item.content)"></i> &nbsp;
                    <i class="fa fa-times" @click="history.splice(index,1)"></i>
                </div>
            </div>
            <div class="item ai_message" v-if="message!=''" v-html="prep">
            </div>
        </div>
        <div class="footer">
            <textarea class="scoll" v-model="input" :placeholder="prompt"></textarea>
            <button title="发送，快捷键为：ctrl + enter" @click="chat()">
                <i class="fa fa-send"></i>
            </button>
        </div>
        <div class="config scoll" v-if="panel!=''">
            <div class="header">
                AI Config <i @click="panel=''" style="float: right;" class="fa fa-times"></i>
            </div>
            <div class="body scoll">
                <div>
                    <button v-for="(item,index) in AIconfig.functions" @click="funcIndex=index" style="font-size: 12px;" :class="[funcIndex==index?'active':'']">
                        {{ item.title==""?"未命名":item.title }}
                    </button>
                    <button @click="addFunc()">
                        <i class="fa fa-plus"></i>
                    </button>
                </div>
                <hr/>
                <table>
                    <tr>
                        <td title="功能" style="width:40px"><i class="fa fa-superpowers"></i></td>
                        <td><input v-model="AIconfig.functions[funcIndex].title" style="width:calc(100% - 40px)"/> <i class="fa fa-trash" @click="delFunc()"></i></td>
                        <td title="记忆/知识" style="width:40px"><i class="fa fa-heartbeat"></i></td>
                        <td style="display: flex;">
                            <div style="flex:1;height:100%;border-right: 1px solid var(--borderColor);display: flex;align-items: center;justify-content: center;" title="无记忆" :class="[AIconfig.memory==''?'active':'']" @click="AIconfig.memory=''">
                                <i class="fa fa-file-o"></i>
                            </div>
                            <div style="flex:1;height:100%;border-right: 1px solid var(--borderColor);display: flex;align-items: center;justify-content: center;" title="本地文件" :class="[AIconfig.memory=='本地文件'?'active':'']" @click="AIconfig.memory='本地文件'">
                                <i class="fa fa-file-text"></i>
                            </div>
                            <div style="flex:1;height:100%;border-right: 1px solid var(--borderColor);display: flex;align-items: center;justify-content: center;" title="互联网" :class="[AIconfig.memory=='互联网'?'active':'']" @click="AIconfig.memory='互联网'">
                                <i class="fa fa-cloud"></i>
                            </div>
                            <div style="flex:1;height:100%;display: flex;align-items: center;justify-content: center;" title="搜索条目数" :class="[AIconfig.memory=='互联网'?'active':'']" v-if="AIconfig.memory=='互联网'" >
                                <input style="width:calc(100%);height:calc(100%)"  title="搜索条目数" v-model="AIconfig.searchNum"/>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td title="人设"><i class="fa fa-user-o"></i></td>
                        <td><input v-model="AIconfig.functions[funcIndex].characters"/></td>
                        <td title="场景"><i class="fa fa-building"></i></td>
                        <td><input v-model="AIconfig.functions[funcIndex].scene"/></td>
                    </tr>
                    <tr>
                        <td title="场景"><i class="fa fa-info"></i></td>
                        <td colspan="3"><input v-model="AIconfig.functions[funcIndex].instruct"/></td>
                    </tr>
                </table>
                <hr/>
                <div class="tabs">
                    <button title="关联历史聊天记录" @click="ifhistory=!ifhistory" :style="{color:ifhistory?'var(--fontActiveColor)':'',backgroundColor:ifhistory?'var(--menuActiveColor)':''}">
                        <i class="fa fa-history"></i>
                    </button>
                    <button title="NLP压缩" @click="ifNLP=!ifNLP"  :style="{color:ifNLP?'var(--fontActiveColor)':'',backgroundColor:ifNLP?'var(--menuActiveColor)':''}">
                        <i class="fa fa-file-zip-o"></i>
                    </button>
                    <button title="自动朗读" @click="ifSpeak=!ifSpeak"  :style="{color:ifSpeak?'var(--fontActiveColor)':'',backgroundColor:ifSpeak?'var(--menuActiveColor)':''}">
                        <i class="fa fa-volume-up"></i>
                    </button>
                    <button title="删除历史" @click="trash()">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
                <table>
                        <tr >
                            <td>{{store.app.locales=='zh'?'模型地址':'Model URL:'}}</td>
                            <td><input v-model="AIconfig.model_url" @change="checkWebSocketAvailability()"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'token限制':'token Limit:'}}</td>
                            <td><input v-model="strlimit"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'维基地址':'wiki URL:'}}</td>
                            <td><input v-model="AIconfig.wiki_url"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'TTS地址':'TTS URL:'}}</td>
                            <td><input v-model="AIconfig.tts_url"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'TTS音色':'TTS voice:'}}</td>
                            <td><input v-model="AIconfig.tts_voice"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'TTS语言':'TTS language:'}}</td>
                            <td><input v-model="AIconfig.tts_language"/></td>
                        </tr>
                        <tr >
                            <td>{{store.app.locales=='zh'?'STT地址':'STT URL:'}}</td>
                            <td><input v-model="AIconfig.stt_url"/></td>
                        </tr>
                </table>
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
        border-bottom: var(--borderColor) 1px solid;
        padding:5px
    }
    .message{
        padding: 5px;
        flex:1;
        flex-direction: column;
        overflow-y: auto;
        bottom: 0;
    }
    .message .item{
        margin-bottom:5px
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
        margin-top: 5px;
        padding-top: 3px;
        padding-right: 5px;
        border-top:1px solid var(--borderColor) ;
        color:var(--fontColor);
    }
    .ai_message{
        border: 1px solid var(--borderColor);
        padding:5px;
        width:fit-content;
        max-width:calc(100% - 20px);
        border-radius: 5px;
    }
    .me_message{
        border: 1px solid var(--borderColor);
        color:var(--fontActiveColor);
        padding:5px;
        border-radius: 5px;
        width:fit-content;
        margin-left: auto
    }
    .footer{
        padding: 5px;
        border-top: var(--borderColor) 1px solid;
        display: flex;
    }
    .footer textarea{
        border-radius: 5px 0px 0px 5px;
        border: 1px solid var(--borderColor);
        border-right: 0px;
        background-color: var(--backgroundColor);
        color:var(--fontColor);
        height:80px;
        resize: none;
        padding:5px;
        width:calc(100% - 60px);
    }
    .footer textarea:focus{
        outline: none;
    }
    .footer button{
        width:60px;
        height:92px;
        margin: 0px;
        padding:0px;
        flex:1;
        border-radius: 0px 5px 5px 0px;
    }
    .config{
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border-radius: 5px;
        border: var(--borderColor) 1px solid;
        background-color: var(--backgroundColor);
        width:calc(100% - 40px);
        max-width: 800px;
        max-height: calc(100% - 100px);
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
    .config button{
        flex: 1;
        margin: 2px;
        border-radius: 5px;
    }
    .config input{
        margin: 0px;
        border-radius: 0px;
        border: 0px;
        background-color: var(--backgroundColor);
    }
    .config input:focus{
        outline: none;
    }
    .config table{
        margin: 2px 0px;
    }
    .config table tr td{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: center;
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
</style>
    