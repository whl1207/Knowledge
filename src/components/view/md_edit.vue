<script setup lang="ts">
    import {onMounted,watch,onBeforeUnmount,nextTick,ref} from 'vue'
    import {usestore} from '../../store'
    import * as monaco from 'monaco-editor'
    import {Ollama} from 'ollama/dist/browser.mjs'
    const store=usestore()

    let editor = null as any
    let ollama=null as any //服务
    //改变Ollama服务地址
    function changeOllamaServe() {
        ollama = new Ollama({host: store.AIconfig.model_url})
    }
    
    let data = ref( store.data[store.index] ) as any
    const init = function() {
        data.value = store.data[store.index]
        if(editType.value.indexOf(data.value.extension)==-1) return
        // 初始化编辑器，确保dom已经渲染
        editor = monaco.editor.create(document.getElementById('codeeditor')!, {
            value: getFile(), //编辑器初始显示文字
            language: 'markdown', //此处使用的markdown
            theme: "hc-black", //官方自带三种主题vs, hc-black, or vs-dark
            selectOnLineNumbers: true,//显示行号
            roundedSelection: false,
            readOnly: false, // 只读
            cursorStyle: 'line', //光标样式
            automaticLayout: true, //自动布局
            glyphMargin: true, //字形边缘
            useTabStops: false,
            fontSize: 16, //字体大小
            //autoIndent: true, //自动布局
            quickSuggestionsDelay: 100, //代码提示延时
            wordWrap: "on",//换行
        })
        editor.addAction({
            id: 'show-command-palette',
            label: 'Show Command Palette',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
            run: () => {
                editor.trigger('', 'editor.action.quickCommand');
            }
        });
        //editor.updateOptions({ wordWrap: "off" }) //更新配置
        // 监听值的变化
        editor.onDidChangeModelContent((val:any) => {
            //console.log(val.changes[0].text)
        })
        
        editor.updateOptions({ readOnly: false }) //设置网络文件可编辑性
        ollama = new Ollama({host: store.AIconfig.model_url})
        if(store.UI.theme=='深色'){
            changeStyle('hc-black')
        }else if(store.UI.theme=='灰色'){
            changeStyle('vs-dark')
        }else if(store.UI.theme=='浅色'){
            changeStyle('vs')
        }
    }
    const editType=ref([".md","",".html",".js",".css",".ts",".py",".json",".txt"]);
    const getFile=function():string{
        if(store.data.length>0){
            let str = ''
            str = data.value.content
            return str
        }
        return ''
    }
    const changeStyle=function(theme:string){
        monaco.editor.setTheme(theme)
    }
    const changeLanguage=function(language:string){
        monaco.editor.setModelLanguage(editor.getModel(),language)
    }
    const changeFont=function(size:any){
        editor.updateOptions({
            fontSize: size,
        })
    }
    const chat=async function(){
        //更新对话提示
        if (editor) {
            const model = editor.getModel();
            if (model) {
                let content = ""
                const selection = editor.getSelection();
                
                console.log(selection)
                if (selection) {
                    let selectText = editor.getModel().getValueInRange(selection)
                    console.log(selectText)
                    if(selectText!=''){
                        content = selectText
                    }else{
                        content = editor.getValue()
                    }
                }
                console.log(content)
                let prompt = "请根据以下内容进行续写：" + content + "。" //提提示词
                let history = [] //对话历史
                history.push({role:'user',content:prompt})
                //设定模块状态
                //发送到ollama服务
                const response = await ollama.chat({ model: store.AIconfig.model_type, messages: history, stream: true })
                
                let currentPosition = editor.getPosition()
                console.log(currentPosition)
                for await (const part of response) {
                    const content = part.message.content
                    model.applyEdits([{
                        range: new monaco.Range(currentPosition.lineNumber, currentPosition.column, currentPosition.lineNumber, currentPosition.column),
                        text: content
                    }])
                    // 计算新的光标位置
                    const linesCount = content.split('\n').length - 1; // 计算换行符的数量
                    const lastLineLength = content.substring(content.lastIndexOf('\n') + 1).length; // 最后一行的长度（不包括最后的换行符）
                    currentPosition.lineNumber = currentPosition.lineNumber + linesCount;
                    currentPosition.column = (linesCount > 0) ? 1 : currentPosition.column + lastLineLength;
                }
                
            }
            
        }
        
    }
    const dispatchsave=function(){
        var e = new KeyboardEvent('keydown',{keyCode:83,ctrlKey: true});
        window.dispatchEvent(e);
    }
    //监听文件变化
    watch(()=>store.data[store.index], (newValue, oldValue) => {
        data.value=store.data[store.index]
        if(editType.value.indexOf(data.extension)==-1) return
        if(editor==null){
            init()
        }else{
            if(store.data.length>0){
                editor.setValue(data.value.content)
            }else{
                editor.setValue("")
            }
            editor.updateOptions({ readOnly: false })
        }
    })
    watch(()=>data.value.content, (newValue, oldValue) => {
        editor.setValue(data.value.content)
    })
    watch(()=>store.UI.theme, (newValue, oldValue) => {
        if(store.UI.theme=='深色'){
            changeStyle('hc-black')
        }else if(store.UI.theme=='灰色'){
            changeStyle('vs-dark')
        }else if(store.UI.theme=='浅色'){
            changeStyle('vs')
        }
    })
    //监听保存事件
    function save(e:any) {
        if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
            e.preventDefault();
            if(store.data.length>0&&editType.value.indexOf(data.value.extension)>-1){
                data.value.content=editor.getValue();
                //保存文件，待补充
                window.ipcRenderer.invoke('saveFile', data.value.path, data.value.content)
                .then((success) => {
                    if (success) {
                        store.saveConfig();
                        console.log('文件保存成功');
                    } else {
                        console.log('文件保存失败');
                    }
                })
                .catch((error) => {
                    console.error(error);
                })
            }
        }
    }
    //初始化
    onMounted(() => {
        init()
        getFile()
        window.addEventListener('keydown', save)
    })
    onBeforeUnmount(() => {
        window.removeEventListener('keydown', save)
    })
</script>
    
<template>
    <div v-show="editType.indexOf(store.data[store.index].extension)>-1" class="editor" style="border-right:1px solid var(--borderColor)">
        <div class="menu">
            <ul>
                <li @click="" >
                    <i class="fa fa-file-text"></i> {{store.locales=='zh'?'文件':'file'}}
                    <ul>
                        <li @click="dispatchsave()">
                            <i class="fa fa-floppy-o"></i> {{store.locales=='zh'?'保存':'save'}}
                        </li>
                    </ul>
                </li>
                <li @click="" v-if="false">
                    <i class="fa fa-legal"></i> {{store.locales=='zh'?'插入':'insert'}}
                    <ul>
                        <li @click="">
                            <i class="fa fa-code"></i> {{store.locales=='zh'?'代码':'code'}}
                        </li>
                        <li @click="">
                            <i class="fa fa-file-image-o"></i> {{store.locales=='zh'?'图片':'image'}}
                        </li>
                        <li @click="">
                            <i class="fa fa-link"></i> {{store.locales=='zh'?'链接':'link'}}
                        </li>
                    </ul>
                </li>
                <li @click="" >
                    <i class="fa fa-adjust"></i> {{store.locales=='zh'?'主题':'theme'}}
                    <ul>
                        <li @click="changeStyle('vs')">
                            {{store.locales=='zh'?'浅色':'vs'}}
                        </li>
                        <li @click="changeStyle('vs-dark')">
                            {{store.locales=='zh'?'深色':'vs-dark'}}
                        </li>
                        <li @click="changeStyle('hc-black')">
                            {{store.locales=='zh'?'黑色':'hc-black'}}
                        </li>
                    </ul>
                </li>
                <li @click="" >
                    <i class="fa fa-language"></i> {{store.locales=='zh'?'语言':'language'}}
                    <ul>
                        <li @click="changeLanguage('markdown')">
                            markdown
                        </li>
                        <li @click="changeLanguage('html')">
                            html
                        </li>
                        <li @click="changeLanguage('javascript')">
                            javascript
                        </li>
                    </ul>
                </li>
                <li @click="" >
                    <i class="fa fa-font"></i> {{store.locales=='zh'?'字体':'font'}}
                    <ul>
                        <li @click="changeFont(12)">
                            12
                        </li>
                        <li @click="changeFont(15)">
                            15
                        </li>
                        <li @click="changeFont(18)">
                            18
                        </li>
                        <li @click="changeFont(24)">
                            24
                        </li>
                        <li @click="changeFont(30)">
                            30
                        </li>
                    </ul>
                </li>
                <li @click="chat" >
                    <i class="iconfont">&#xe65d;</i> {{store.locales=='zh'?'续写':'AI'}}
                </li>
            </ul>
        </div>
        <div id="codeeditor" ></div>
    </div>
</template>
    
<style scoped>
    .editor{
        position:relative;
        margin: 0px;
        width:100%;
        height: 100%;
        flex:2;
        overflow: hidden;
    }
    #codeeditor{
        position:relative;
        width:100%;
        max-width:100%;
        height: calc(100% - 26px);
    }
    .div{
        background-color: aliceblue !important;
    }
    .menu{
        position: relative;
        width:100%;
        height:26px;
        user-select: none;
        border-bottom:1px solid var(--borderColor);
    }
    .menu ul {
        position:absolute;
        margin: 0px;
        padding:0px;
        padding-top:0px;
        z-index:99;
        display:block;
        white-space:nowrap;
    }
    
    .menu ul li {
        position: relative;
        height:19px;
        cursor:pointer;
        line-height:18px;
        white-space:nowrap;
        padding:3px;
        padding-right:10px;
        padding-left: 10px;
        width:fit-content;
        display:inline-block;
        text-align: left;
        z-index: 99;
    }
    .menu li:hover {
        background:var(--menuActiveColor);
    }
    .menu li>ul{
        left: 0px;
        top: 25px;
        width:fit-content;
        min-width:70px;
        background-color:var(--menuColor);
        display: none;
        box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
        border:1px solid var(--borderColor);
    }
    .menu li:hover>ul{
        display: block;
    }
    .menu li>ul>li{
        list-style-type:none;
        float:left;
        width:calc(100% - 10px);
        padding:5px;
    }
</style>
    