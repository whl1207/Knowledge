import { defineStore } from "pinia"
import {nextTick} from "vue"
import {Ollama} from 'ollama/dist/browser.mjs'
export const usestore=defineStore('data',{
    //创建state
    state:()=>({
        root: "" as string, //仓库位置
        path: "" as string, //当前路径
        tree: [] as any, //目录结构
        data: [] as any, //打开的文件数据
        index: null as any, //打开的文件序号
        view:[] as any, //视图
        sidePanel:false as any, //侧面板
        mainPanel:"文件" as any, //主面板
        locales: 'zh', //语言
        UI:{
            theme: '深色',
            backgroundColor:"#0D1117",
            borderColor:"#30363D",
            menuColor:"#010409",
            menuActiveColor:"#24272E",
            fontColor:"#ffffff",
            fontActiveColor:"#CCA700",
            layout:'horizontal',/**横向布局**/
        }, //主题颜色
        AIconfig:{
            AI_types:[
                'ollama',
                'general'
            ],
            AI_type:'ollama',
            model_url:'http://127.0.0.1:11434',
            model_type:'',
            model_types:[] as any[],
            zhipu_APIkeys:'f68b52d495c6af45eed7e28e42cd96ba.Rb2uhP3FaUg00QIt',
            state:false,
            tts_type:'本地',
            tts_url:'http://127.0.0.1:8080/?&lang=zh&speed=1.0&', //
            tts_voice:'mazhao',
            tts_language:'zh',
            TTSaudio:new Audio(),
            stt_url:'ws://127.0.0.1:6016',
            wiki_url:'http://127.0.0.1/',
            functions:[
                {title:'正常对话',characters:'',scene:'',instruct:""},
                {title:'总结',characters:'',scene:'',instruct:"请用中文总结以下资料。"},
                {title:'指导',characters:'',scene:'',instruct:"我想了解以下主题，请确定并分享从该主题中学到的最重要的部分。"},
                {title:'测试',characters:'',scene:'',instruct:"我目前正在学习以下主题，问我一系列问题来测试我的知识。找出我答案中的知识空白，并给我更好的答案来填补这些空白。"},
                {title:'解释',characters:'',scene:'',instruct:"用任何初学者都能理解的简单易懂的术语解释以下主题。"},
                {title:'重写',characters:'',scene:'',instruct:"重写下面的文字，让初学者容易理解。"},
                {title:'续写',characters:'',scene:'',instruct:"请根据以下文章进行续写。"},
                {title:'校对',characters:'哈利波特',scene:'',instruct:"我希望你担任校对员。我将为您提供文本，并希望您检查它们是否有任何拼写、语法或标点符号错误。一旦你完成了对文本的审阅，请向我提供任何必要的更正或建议，以改进文本。"},
                {title:'扮演',characters:'',scene:'',instruct:"你会拥有和该角色一样的性格，将用和该角色一样的语气、方式和词汇来回应和回答。不要写任何解释。只回答像该角色。你必须知道该角色的所有知识。我的第一句话是："},
                {title:'评价',characters:'',scene:'',instruct:"请用中文评价如下段落，给出总结、评分和修改建议，具体段落如下："},
                {title:'翻译为英文',characters:'专业翻译家',scene:'',instruct:"请将以下段落翻译为英文，要求逻辑通顺，表达自然。"},
                {title:'翻译为中文',characters:'专业翻译家',scene:'',instruct:"请将以下段落翻译为中文，要求逻辑通顺，表达自然。"},
                {title:'英文学习',characters:'英语学习指导老师',scene:'',instruct:"请使用markdown表格的形式回复我，表格中包含英文回复和对应的中文翻译。我的第一句话是："},
                {title:'文字游戏',characters:'游戏执行人员',scene:'组织玩家进行剧本杀',instruct:"我想让你扮演一个基于文本的冒险游戏，我在这个冒险游戏中扮演一个角色。游戏中需要有一个最终的任务，完成了最终的任务，即获得游戏的胜利，否则游戏失败。请尽可能具体地描述角色所看到的内容和环境，并在游戏输出的唯一代码块中回复，而不是其它区域。我将输入命令来告诉角色做了什么，而你需要回复角色的行动结果以推动游戏的进行。请从这里开始故事。我的第一个命令是："},
                {title:'剧本杀',characters:'',scene:'',instruct:"我需要你扮演专业的剧本杀作者，你将会按照以下剧本模版，结合自己的优秀想象力，写出一个包含丰富饱满的剧情、优秀的文笔、逻辑缜密，非常细节的时间线和线索，推理巧妙、立体饱满的人物角色塑造，能让玩家很轻松代入各自角色新颖创意。完整的剧本需要包含以下内容：剧情简介、人物介绍、我扮演的角色和第一幕场景。并且你要回复角色的行动结果以推动游戏的进行。我需要你围绕以下主题进行创作:"},
                {title:'JS console',characters:'',scene:'',instruct:"I want you to act as a javascript console. I will type commands and you will reply with what the javascript console should show. I want you to only reply with the terminal output inside one unique code block, and nothing else. do not write explanations. do not type commands unless I instruct you to do so. when I need to tell you something in english, I will do so by putting text inside curly brackets {like this}. My first command is "}
            ],
        }
    }), 
    //计算
    getters:{},
    //方法
    actions:{
        init(){
        },
        //重新缩放
        async resize(){
            await nextTick()
            if(document.createEvent) {
              var event = document.createEvent("HTMLEvents");
              event.initEvent("resize", true, true);
              window.dispatchEvent(event);
            }
        },
        //初始化配置
        initConfig(){
            window.localStorage.removeItem('root')
            window.localStorage.removeItem('path')
            window.localStorage.removeItem('data')
            window.localStorage.removeItem('index')
            window.localStorage.removeItem('view')
            window.localStorage.removeItem('AIconfig')
            window.localStorage.removeItem('config')
            window.localStorage.removeItem('history')
            window.localStorage.removeItem('locales')
            window.localStorage.removeItem('mainPanel')
            window.localStorage.removeItem('sidePanel')
            window.localStorage.removeItem('links')
            window.ipcRenderer.send('closeWindow')
        },
        //储存配置信息
        saveConfig(){
            localStorage.setItem('root',JSON.stringify(this.root))
            localStorage.setItem('path',JSON.stringify(this.path))
            localStorage.setItem('data',JSON.stringify(this.data))
            localStorage.setItem('index',JSON.stringify(this.index))
            localStorage.setItem('view',JSON.stringify(this.view))
            localStorage.setItem('sidePanel',JSON.stringify(this.sidePanel))
            localStorage.setItem('mainPanel',JSON.stringify(this.mainPanel))
            localStorage.setItem('locales',JSON.stringify(this.locales))
            localStorage.setItem('AIconfig',JSON.stringify(this.AIconfig))
        },
        //读取配置信息
        loadConfig(){
            if(localStorage.getItem('root') !== null) {
                this.root=JSON.parse(localStorage.getItem('root')!)
            }
            if(localStorage.getItem('path') !== null) {
                this.path=JSON.parse(localStorage.getItem('path')!)
            }
            if(localStorage.getItem('data') !== null) {
                this.data=JSON.parse(localStorage.getItem('data')!)
            }
            if(localStorage.getItem('index') !== null) {
                this.index=JSON.parse(localStorage.getItem('index')!)
            }
            if(localStorage.getItem('view') !== null) {
                this.view=JSON.parse(localStorage.getItem('view')!)
            }
            if(localStorage.getItem('sidePanel') !== null) {
                this.sidePanel=JSON.parse(localStorage.getItem('sidePanel')!)
            }
            if(localStorage.getItem('mainPanel') !== null) {
                this.mainPanel=JSON.parse(localStorage.getItem('mainPanel')!)
            }
            if(localStorage.getItem('locales') !== null) {
                this.locales=JSON.parse(localStorage.getItem('locales')!)
            }
            if(localStorage.getItem('AIconfig') !== null) {
                this.AIconfig=JSON.parse(localStorage.getItem('AIconfig')!)
            }
        },
        async addTab(data:any){
            let existIndex = null
            let i = 0
            while (i < this.data.length) {
                if(this.data[i].path==data.path) existIndex=i
                i++;
            }
            if(existIndex==null){
                const fileContent =  await window.ipcRenderer.invoke('readFile', data.path)
                const attributes =  await window.ipcRenderer.invoke('getConfig', data.path)
                this.data.push({
                    ...data, // 使用对象展开语法将原始数据的属性展开到新的对象中
                    attributes: attributes, // 添加属性
                    content: fileContent // 添加内容
                })
                this.index=this.data.length-1
            }else{
                this.index=existIndex
            }
            //设定打开的路径
            if(data.type=='file'){
                this.path=data.path.substring(0, data.path.lastIndexOf('\\'));
            }else{
                this.path=data.path
            }
        },
        backPath() {
            // 如果当前路径已经是 root 目录，则不执行任何操作
            if (this.path === this.root || this.path === "") {
                return;
            }

            // 如果当前路径在 root 目录下，则向上一级
            if (this.path.startsWith(this.root)) {
                const parentPath = this.path.substring(0, this.path.lastIndexOf("\\"));

                // 如果上一级目录是 root 目录，则将路径设置为 root
                if (parentPath === this.root) {
                this.path = this.root;
                } else {
                this.path = parentPath;
                }
            } else {
                // 如果当前路径不在 root 目录下，则不执行任何操作
                return;
            }
        },
        toggleView(str:string){
            if(this.view.indexOf(str)==-1){
                this.view[this.view.length]=str
            }else{
                this.view.splice(this.view.indexOf(str),1)
            }
            this.resize()
        },
        isView(str:string){
            if(this.view.indexOf(str)==-1){
                return false
            }else{
                return true
            }
        },
        changeTheme(){
            if(this.UI.theme=="深色"){
                this.UI={
                    theme: '深色',
                    backgroundColor:"#0D1117",
                    borderColor:"#30363D",
                    menuColor:"#161617",
                    menuActiveColor:"#24272E",
                    fontColor:"#ffffff",
                    fontActiveColor:"#CCA700",
                    layout:this.UI.layout
                }
            }else if(this.UI.theme=="浅色"){
                this.UI={
                    theme: '浅色',
                    backgroundColor:"#ffffff",
                    borderColor:"#888888",
                    menuColor:"#E9E9E9",
                    menuActiveColor:"#ECD7D6",
                    fontColor:"#111111",
                    fontActiveColor:"#990000",
                    layout:this.UI.layout
                }
            }else if(this.UI.theme=="灰色"){
                this.UI={
                    theme: '灰色',
                    backgroundColor:"#1e1e1e",
                    borderColor:"#444444",
                    menuColor:"#303030",
                    menuActiveColor:"#4c4c4c",
                    fontColor:"#ffffff",
                    fontActiveColor:"#ffff00",
                    layout:this.UI.layout
                }
            }
            this.setTheme()
        },
        setTheme(){
            document.documentElement.style.setProperty("--backgroundColor",this.UI.backgroundColor);
            document.documentElement.style.setProperty("--menuColor",this.UI.menuColor);
            document.documentElement.style.setProperty("--menuActiveColor",this.UI.menuActiveColor);
            document.documentElement.style.setProperty("--fontColor",this.UI.fontColor);
            document.documentElement.style.setProperty("--fontActiveColor",this.UI.fontActiveColor);
            document.documentElement.style.setProperty("--borderColor",this.UI.borderColor);
        },
        tts(text:string){
            let that=this
            let audioURLs = [] as any;
            //发声
            async function speak(text:string) {
                if(that.AIconfig.tts_type=="本地"){
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
                    let parts = text.replace(/^---[\s\S]*?---\n?/gm, '').replace(/[^\u4e00-\u9fa5a-zA-Z\s,.?!]/g, " ").replace(/[>#*:|"'-]/g, " ").split(/[。？！\n]+/).filter(part => part.trim() !== '');
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
                    audioURLs.push(audioUrl);
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
                                audioURLs.push(url); // 将生成的URL存储到数组中
                            })
                            .catch(error => console.error("Error preloading audio:", error));
                    }
                    audio.play().catch(error => console.error("Error playing audio:", error));
                }else{
                    console.log(audioURLs.length,currentIndex)
                    if(audioURLs.length==currentIndex){
                        //当未返回音频时等待
                        setTimeout(fetchAndPlayAudio, 500,textParts,currentIndex);
                    }else if(audioURLs.length<currentIndex){
                      return;
                    }else{
                        const audioUrl = audioURLs[currentIndex];
                        const audio = new Audio(audioUrl);
        
                        audio.onended = () => {
                            console.log(`Part ${currentIndex + 1} of ${audioURLs.length} played.`);
                            fetchAndPlayAudio(textParts,currentIndex + 1);
                        };
                        // 如果不是最后一段，提前开始加载下一段音频
                        if (currentIndex < textParts.length - 1) {
                            const nextText = textParts[currentIndex + 1];
                            fetchAudio(nextText) // 提前请求下一段音频，但不等待它完成
                                .then(blob => URL.createObjectURL(blob))
                                .then(url => {
                                    // 可以在这里存储或处理预加载的音频URL，但由于自动播放策略，可能需要用户交互来实际播放
                                    audioURLs.push(url); // 将生成的URL存储到数组中
                                })
                                .catch(error => console.error("Error preloading audio:", error));
                        }else{
                            audioURLs=[]
                        }
                        console.log(`Playing part ${currentIndex + 1} of ${audioURLs.length}`);
                        audio.play().catch(error => console.error("Error playing audio:", error));
                    }
                }
            }
            //调用单次请求
            async function fetchAudio(text:string) {
                try {
                    const url = that.AIconfig.tts_url+'spk='+that.AIconfig.tts_voice+"&text="+text;
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
            speak(text)
        },
        stopTTS(){
            // 停止当前的朗读
            if(this.AIconfig.tts_type=="本地"){
                //停止本地朗读
                var synth = window.speechSynthesis;
                synth.cancel();
            }else{
                if (!this.AIconfig.TTSaudio.paused) { // 如果音频正在播放
                    this.AIconfig.TTSaudio.pause(); // 停止播放
                    this.AIconfig.TTSaudio.currentTime = 0; // 重置音频到开始位置
                }
            }
        },
        async getAIconfig (){
            if(this.AIconfig.AI_type=='ollama'){
                let ollama = new Ollama({host: this.AIconfig.model_url})
                try {
                    let result = await ollama.list()
                    if (result && result.models) {
                        // result 包含 models 属性，表示有数据返回
                        this.AIconfig.state=true
                        this.AIconfig.model_types = JSON.parse(JSON.stringify(result.models))
                        //console.log("Result contains data:", result.models);
                    }
                } catch (error) {
                    this.AIconfig.state=false
                    //console.error('Fetch error:', error);
                    // 在这里处理错误，例如显示错误提示给用户
                }
            }else{
                this.AIconfig.model_types=[
                    {name:"glm-4",size:0},
                    {name:"glm-4-flash",size:0}
                ]
            }
        },
        copyToClipboard(text:string) {
            const tempTextArea = document.createElement('textarea')
            tempTextArea.value = text
            document.body.appendChild(tempTextArea)
            tempTextArea.select()
            document.execCommand('copy')
            document.body.removeChild(tempTextArea)
        },
        //使用系统默认应用打开文件
        openByApp:async (path:string) => {
            await window.ipcRenderer.invoke('openByApp',path)
        },
        //退出应用
        exit(){
            this.saveConfig;
            window.ipcRenderer.send('closeWindow');
        },
        StampToDate(date?:any) {
            if(date==undefined|| !(date instanceof Date)) date = new Date()
            const year = date.getFullYear();
            const month = ('0' + (date.getMonth() + 1)).slice(-2);
            const day = ('0' + date.getDate()).slice(-2);
            const hour = ('0' + date.getHours()).slice(-2);
            const min = ('0' + date.getMinutes()).slice(-2);
            const sec = ('0' + date.getSeconds()).slice(-2);
            return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
        },
        //图标
        icon: function (extension:any){
            let c="fa fa-th"
            switch(extension){
                case "folder":c="fa fa-folder";
                break;
                case ".md":c="fa fa-file-text-o";
                break;
                case ".txt":c="fa fa-file-text-o";
                break;
                case ".ini":c="fa fa-file-text-o";
                break;
                case ".pptx":c="fa fa-file-powerpoint-o";
                break;
                case ".ppt":c="fa fa-file-powerpoint-o";
                break;
                case ".doc":c="fa fa-file-word-o";
                break;
                case ".docx":c="fa fa-file-word-o";
                break;
                case ".xls":c="fa fa-file-excel-o";
                break;
                case ".xlsx":c="fa fa-file-excel-o";
                break;
                case ".zip":c="fa fa-file-archive-o";
                break;
                case ".rar":c="fa fa-file-archive-o";
                break;
                case ".png":c="fa fa-file-image-o ";
                break;
                case ".jpg":c="fa fa-file-image-o ";
                break;
                case ".jpeg":c="fa fa-file-image-o ";
                break;
                case ".webp":c="fa fa-file-image-o ";
                break;
                case ".pdf":c="fa fa-file-pdf-o";
                break;
                case ".html":c="fa fa-file-code-o";
                break;
                case ".js":c="fa fa-file-code-o";
                break;
                case ".css":c="fa fa-file-code-o";
                break;
                case ".json":c="fa fa-file-code-o";
                break;
                case ".ts":c="fa fa-file-code-o";
                break;
                case ".mp4":c="fa fa-file-video-o";
                break;
                case ".wmv":c="fa fa-file-video-o";
                break;
                case ".avi":c="fa fa-file-video-o";
                break;
                case "flv":c="fa fa-file-video-o";
                break;
                case ".mp3":c="fa fa-file-audio-o";
                break;
                case ".m4a":c="fa fa-file-audio-o";
                break;
                case ".wb":c="fa fa-file-o";
                break;
                case ".exe":c="fa fa-windows"
                default:
                c="fa fa-th";
            }
            return c
        },
    }
})