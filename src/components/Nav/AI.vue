<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref, nextTick} from 'vue'
    import {usestore} from '../../store'
    import MarkdownIt from 'markdown-it'
    import hljs from 'highlight.js'
    import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.js' 
    import * as workerSrc from 'pdfjs-dist/build/pdf.worker.entry.js'
    PDFJS.GlobalWorkerOptions.workerSrc = workerSrc
    
    const store=usestore()
    let state = ref("AI未上线...")
    let input = ref("") //输入的消息
    let message=ref("") //消息返回值
    let prep=ref("") //消息渲染值
    let prompt = ref("") //最终提示词
    let ifhistory = ref(false)
    let history = ref([]) as any //历史聊天记录
    let iflink =ref(false) //是否允许查阅知识库
    let ifedit =ref(false) //是否允许编辑知识库
    let ifNLP = ref(false) //使用NLP压缩关键信息
    let ifOnline =ref(false) //关联互联网搜索
    let ifWeb =ref(false) //关联网页
    let onlineNum =ref(8) //互联网搜索条目数
    let ifSpeak =ref(false) //自动朗读
    let panel = ref("") //面板显示参数，可以是设置或者配置
    let server = ref('ws://127.0.0.1:17860/ws') //服务地址
    let strlimit = ref(8000) //知识库字数限制
    let funcIndex = ref(-1) //功能序数
    let func = ref([
        {title:'本地正常对话',link:false,edit:false,online:false,web:false,content:""},
        {title:'联网正常对话',link:false,edit:false,online:true,web:false,content:""},
        {title:'总结剪切板内容',link:false,edit:false,online:false,web:true,content:"请用中文总结以下资料："},
        {title:'在文件中，续写文章',link:true,edit:true,online:false,web:false,content:"请根据以下文章进行续写："},
        {title:'在对话中，续写文章',link:true,edit:false,online:false,web:false,content:"请根据以下文章进行续写："},
        {title:'总结文件内容',link:true,edit:false,online:false,web:false,content:"请用中文总结下面的段落，并给我一份包含关键信息的列表。"},
        {title:'搜索最新消息',link:false,edit:false,online:true,web:false,content:"请根据以下资料进行总结。"},
        {title:'总结',link:false,edit:false,online:false,web:false,content:"请用中文总结以下资料："},
        {title:'英文翻译',link:false,edit:false,online:false,web:false,content:"请将以下段落翻译为英文，要求逻辑通顺，表达自然。"},
        {title:'中文翻译',link:false,edit:false,online:false,web:false,content:"请将以下段落翻译为中文，要求逻辑通顺，表达自然。"},
        {title:'指导学习',link:false,edit:false,online:false,web:false,content:"我想了解以下主题，请确定并分享从该主题中学到的最重要的部分。"},
        {title:'加强学习',link:false,edit:false,online:false,web:false,content:"我目前正在学习以下主题，问我一系列问题来测试我的知识。找出我答案中的知识空白，并给我更好的答案来填补这些空白。"},
        {title:'解释术语',link:false,edit:false,online:false,web:false,content:"用任何初学者都能理解的简单易懂的术语解释以下主题。"},
        {title:'重写段落',link:false,edit:false,online:false,web:false,content:"重写下面的文字，让初学者容易理解。"},
        {title:'文字游戏',link:false,edit:false,online:false,web:false,content:"我想让你扮演一个基于文本的冒险游戏，我在这个冒险游戏中扮演一个角色。游戏中需要有一个最终的任务，完成了最终的任务，即获得游戏的胜利，否则游戏失败。请尽可能具体地描述角色所看到的内容和环境，并在游戏输出的唯一代码块中回复，而不是其它区域。我将输入命令来告诉角色做了什么，而你需要回复角色的行动结果以推动游戏的进行。请从这里开始故事。我的第一个命令是："},
        {title:'剧本杀',link:false,edit:false,online:false,web:false,content:"我需要你扮演专业的剧本杀作者，你将会按照以下剧本模版，结合自己的优秀想象力，写出一个包含丰富饱满的剧情、优秀的文笔、逻辑缜密，非常细节的时间线和线索，推理巧妙、立体饱满的人物角色塑造，能让玩家很轻松代入各自角色新颖创意。完整的剧本需要包含以下内容：剧情简介、人物介绍、我扮演的角色和第一幕场景。并且你要回复角色的行动结果以推动游戏的进行。我需要你围绕以下主题进行创作:"},
    ]) as any //功能设置

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
        if ("WebSocket" in window) {
            var webSocket = new WebSocket(server.value);
            webSocket.onopen = function() {
                state.value="AI已连接"
            };
            webSocket.onclose = function() {
                state.value="AI已下线"
            };
            webSocket.onerror = function() {
                state.value="AI连接发生错误"
            };
            } else {
            console.log("当前浏览器不支持WebSocket");
        }
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
            let ws = new WebSocket(server.value);
            ws.onmessage = function (event:any) {
                //如果功能中不允许修改文章
                if(!ifedit.value){
                    message.value = event.data
                    RenderMarkdown()
                    var element = document.getElementById("AI_messages")!
                    element.scrollTop = element.scrollHeight
                }else{
                    store.app.files[store.app.fileIndex].content=initContent+event.data
                }
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
                //如果功能中不允许修改文章
                if(!ifedit.value){
                    history.value.push({role:'AI',content:message.value,prep:prep.value})
                    if(ifSpeak.value) speak(message.value)
                    message.value=""
                }else{
                    message.value="内容修改完毕，请查看文档"
                    prep.value="内容修改完毕，请查看文档"
                    history.value.push({role:'AI',content:message.value,prep:prep.value})
                    if(ifSpeak.value) speak(message.value)
                    message.value=""
                }
                
                funcIndex.value=-1
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
    function speak(text:string) {
        var utterance = new SpeechSynthesisUtterance();
        // 设置要朗读的文本
        utterance.text = text;
        // 使用默认的语音合成器
        var synth = window.speechSynthesis;
        // 将 utterance 添加到语音合成队列中
        synth.speak(utterance);
    }
    function stopSpeak(){
        var synth = window.speechSynthesis;
        // 停止当前的朗读
        synth.cancel();
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
        const results = []
        let str = ""
        for (let i = 0; i < Math.min(resultNodes.length, numResults); i++) {
            const linkNode = resultNodes[i].querySelector("h2 a")
            const descriptionNode = resultNodes[i].querySelector(".b_caption p")
            if (linkNode && descriptionNode) {
                const link = linkNode.getAttribute('href')
                const description = descriptionNode.textContent!.trim()
                results.push({ link, description })
                str=str+description+"。"
            }
        }
        return str
    }
    function getVisibleTextFromHtml(html:string) {
        let text = '';

        // 递归遍历节点
        function traverse(node:any) {
            if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() !== '') {
            text += node.nodeValue.trim() + ' ';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
            // 排除特定元素类型
            const excludedTags = ['style', 'script', 'noscript'];
            if (!excludedTags.includes(node.tagName.toLowerCase())) {
                for (let i = 0; i < node.childNodes.length; i++) {
                traverse(node.childNodes[i]);
                }
            }
            }
        }

        // 将 HTML 解析为 DOM 树
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // 从根节点开始遍历
        traverse(doc.body);

        return text.trim();
    }
    //检测语言
    /**function detectLanguage(text:string) {
        let count = 0;
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            if (charCode >= 0x4e00 && charCode <= 0x9fff) {
            count++;
            }
        }
        if (count/text.length >= 0.5) {
            return '中文';
        } else {
            return '英文';
        }
    }**/
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
        prompt.value=""
        //关联功能
        if(funcIndex.value!=-1){
            prompt.value=func.value[funcIndex.value].content
        }
        prompt.value=prompt.value+input.value
        //使用nlp处理知识库

        //判断是否关联知识库
        if(iflink.value){
            if(store.app.files.length>0&&store.app.fileIndex>-1){
                if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type==".txt"||store.app.files[store.app.fileIndex].type==""){
                    if(!ifNLP.value){
                        //不打开nlp压缩文本
                        prompt.value=prompt.value+"。参考资料如下："+store.app.files[store.app.fileIndex].content
                    }else{
                        //打开nlp查找最相近的句子
                        let result=await findMostSimilarSentence(input.value, store.app.files[store.app.fileIndex].content)
                        prompt.value=prompt.value+"。参考资料如下："+result
                        send_raw(prompt.value,'',ifhistory.value?history.value:[])
                        return
                    }
                }else if(store.app.files[store.app.fileIndex].type==".pdf"){
                    parsePDF(store.app.files[store.app.fileIndex].fullPath)
                    .then(async content => {
                        if(!ifNLP.value){
                            console.log(content.length)
                            //不打开nlp压缩文本
                            prompt.value=prompt.value+"。参考资料如下："+content.slice(0, strlimit.value);
                        }else{
                            //打开nlp查找最相近的句子
                            let result=await findMostSimilarSentence(input.value, content)
                            //console.log(result)
                            prompt.value=prompt.value+"。参考资料如下："+result
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
        }
        if(ifOnline.value){
            prompt.value=prompt.value+"。参考资料如下："+searchOnline(input.value,onlineNum.value)
        }
        if(ifWeb.value){
            const clipboard = navigator.clipboard;
            // 读取剪贴板中的文本
            clipboard.readText().then(text => {
                prompt.value=prompt.value+"。参考资料如下：" +getVisibleTextFromHtml(text).slice(0, strlimit.value);
                send_raw(prompt.value,'',ifhistory.value?history.value:[])
                return
            });
            return
        }
        send_raw(prompt.value,'',ifhistory.value?history.value:[])
    }
    //选择功能
    const clickfunc =function(index:number){
        panel.value=''
        funcIndex.value=index
        iflink.value=func.value[index].link
        ifedit.value=func.value[index].edit
        ifOnline.value=func.value[index].online
        ifWeb.value=func.value[index].web
    }
    //初始化
    onMounted(()=>{
        checkWebSocketAvailability()
        if (localStorage.getItem('history')!= null) {
            history.value=JSON.parse(localStorage.getItem("history")!)
        }else{
            history.value=[]
        }
        window.addEventListener('keydown', enter)
    })
    onBeforeUnmount(() => {
        window.removeEventListener('keydown', enter)
        localStorage.setItem("history",JSON.stringify(history.value))
    })
</script>
    
<template>
    <div class="bg">
        <div class="header">
            <span :style="{color:state=='AI已连接'?'var(--fontActiveColor)':''}" style="border:1px solid var(--borderColor);padding:5px;border-radius: 5px;"> <i class="fa fa-reddit"></i> {{ state }}</span>
        </div>
        <div class="message scoll" id="AI_messages">
            <div v-for="(item,index) in history" class="item" :class="{me_message:item.role=='user',ai_message:item.role=='AI'}">
                <div v-html="item.prep" >
                </div>
                <div class="set">
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
            <textarea v-model="input" ></textarea>
            <div>
                <button title="发送，快捷键为：ctrl + enter" @click="chat()">
                    <i class="fa fa-send"></i>
                </button>
                <button title="打开功能设置" @click="panel='功能'" style="flex:1" :style="{color:panel=='功能'||funcIndex!=-1?'var(--fontActiveColor)':'',backgroundColor:panel=='功能'?'var(--menuActiveColor)':''}">
                    <i class="fa fa-reddit"></i> 
                </button>
                <button title="打开服务器配置" @click="panel='设置'" :style="{color:panel=='设置'?'var(--fontActiveColor)':'',backgroundColor:panel=='设置'?'var(--menuActiveColor)':''}">
                    <i class="fa fa-cog"></i>
                </button>
            </div>
        </div>
        <div class="config scoll" v-if="panel=='功能'">
            <table style="width:100%">
                <tr>
                    <td style="max-width: 70px;">名称</td>
                    <td style="max-width: 70px;" title="关联到知识库" @click="iflink=!iflink" :style="{color:iflink?'var(--fontActiveColor)':'',backgroundColor:iflink?'var(--menuActiveColor)':''}"><i class="fa fa-file-text"></i></td>
                    <td style="max-width: 70px;" title="修改知识库" @click="ifedit=!ifedit" :style="{color:ifedit?'var(--fontActiveColor)':'',backgroundColor:ifedit?'var(--menuActiveColor)':''}"><i class="fa fa-edit"></i></td>
                    <td style="max-width: 70px;" title="联网查询" @click="ifOnline=!ifOnline" :style="{color:ifOnline?'var(--fontActiveColor)':'',backgroundColor:ifOnline?'var(--menuActiveColor)':''}"><i class="fa fa-globe"></i></td>
                    <td style="max-width: 70px;" title="关联网页" @click="ifWeb=!ifWeb" :style="{color:ifWeb?'var(--fontActiveColor)':'',backgroundColor:ifWeb?'var(--menuActiveColor)':''}"><i class="iconfont">&#xe697;</i></td>
                </tr>
                <tr v-for="(item,index) in func" @click="clickfunc(index)" :class="[funcIndex==index?'active':'']">
                    <td style="max-width: 70px;" :title="item.content">{{ item.title }}</td>
                    <td style="max-width: 70px;">
                        <i class="fa fa-check" v-if="item.link"></i>
                        <i class="fa fa-times" v-if="!item.link"></i>
                    </td>
                    <td style="max-width: 70px;">
                        <i class="fa fa-check" v-if="item.edit"></i>
                        <i class="fa fa-times" v-if="!item.edit"></i>
                    </td>
                    <td style="max-width: 70px;">
                        <i class="fa fa-check" v-if="item.online"></i>
                        <i class="fa fa-times" v-if="!item.online"></i>
                    </td>
                    <td style="max-width: 70px;">
                        <i class="fa fa-check" v-if="item.web"></i>
                        <i class="fa fa-times" v-if="!item.web"></i>
                    </td>
                </tr>
            </table>
        </div>
        <div class="config" v-if="panel=='设置'">
            <div>
                <button title="关联历史聊天记录" @click="ifhistory=!ifhistory" :style="{color:ifhistory?'var(--fontActiveColor)':'',backgroundColor:ifhistory?'var(--menuActiveColor)':''}">
                    <i class="fa fa-history"></i> 关联历史
                </button>
                <button title="删除历史" @click="trash()">
                    <i class="fa fa-trash"></i> 删除历史
                </button>
            </div>
            <div>
                <span>服务地址：</span>
                <input v-model="server" @change="checkWebSocketAvailability()"/>
            </div>
            <div>
                <span>token限制：</span>
                <input v-model="strlimit"/>
                <span>NLP压缩：</span>
                <input type="checkbox" v-model="ifNLP" />
            </div>
            <div>
                <span>互联网搜索：</span>
                <input v-model="onlineNum"/>
                <span>自动朗读：</span>
                <input type="checkbox" v-model="ifSpeak" />
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
    }
    .footer textarea{
        width:calc(100% - 6px);
        border-radius: 5px 0px 0px 5px;
        border: 1px solid var(--borderColor);
        background-color: var(--backgroundColor);
        color:var(--fontColor);
        height:120px;
        resize: none;
        padding:3px
    }
    .footer textarea:focus{
        outline: none;
    }
    .footer button{
        width:60px;
        margin: 0px;
        padding:0px;
        flex:1;
        border-radius: 0px 5px 5px 0px;
    }
    .footer div{
        display: flex;
    }
    .footer div button{
        width:60px;
        margin: 0px;
        padding:0px;
        flex:1;
        border-radius: 0px;
    }
    .config{
        padding:5px;
        border-top: var(--borderColor) 1px solid;
        background-color: var(--backgroundColor);
        max-height: 200px;
        overflow-y: auto;
    }
    .config div{
        display: flex;
    }
    .config div button{
        width:60px;
        margin: 0px;
        padding:0px;
        flex:1;
        border-radius: 0px;
    }
    .config span{
        line-height: 32px;
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
</style>
    