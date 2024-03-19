<script setup lang="ts">
    import {onMounted,watch,onBeforeUnmount,nextTick,ref} from 'vue'
    import {usestore} from '../../store'
    import file from '../../../electron/file'
    import * as monaco from 'monaco-editor'

    const store=usestore()

    let editor = null as any
    const init = function() {
        if(editType.value.indexOf(store.app.files[store.app.fileIndex].type)==-1) return
        // 初始化编辑器，确保dom已经渲染
        editor = monaco.editor.create(document.getElementById('codeeditor')!, {
            value: getFile(), //编辑器初始显示文字
            language: 'markdown', //此处使用的markdown
            theme: "深色"==store.app.UI.theme?"hc-black":(["灰色","蓝色","红色"].includes(store.app.UI.theme)?'vs-dark':'vs'), //官方自带三种主题vs, hc-black, or vs-dark
            selectOnLineNumbers: true,//显示行号
            roundedSelection: false,
            readOnly: false, // 只读
            cursorStyle: 'line', //光标样式
            automaticLayout: true, //自动布局
            glyphMargin: true, //字形边缘
            useTabStops: false,
            fontSize: store.app.UI.fontsize, //字体大小
            //autoIndent: true, //自动布局
            quickSuggestionsDelay: 100, //代码提示延时
            wordWrap: "on",//换行
        })
        //editor.updateOptions({ wordWrap: "off" }) //更新配置
        // 监听值的变化
        editor.onDidChangeModelContent((val:any) => {
            //console.log(val.changes[0].text)
        })
        //设置网络文件不可编辑
        if(store.app.files[store.app.fileIndex].cloud==true){
            editor.updateOptions({ readOnly: true })
        }else{
            editor.updateOptions({ readOnly: false })
        }
    }
    const editType=ref([".md","",".html",".js",".css",".ts",".py",".json",".txt"]);
    const getFile=function():string{
        if(store.app.files.length>0){
            let str = ''
            
            if(store.app.files[store.app.fileIndex].cloud==true) {
                //云端文件，直接查看代码
                //console.log(store.app.files[store.app.fileIndex])
                str = store.app.files[store.app.fileIndex].content
            }else{
                //本地文件，实时读取代码
                str = file.getFile(store.app.files[store.app.fileIndex].fullPath)
            }
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
        store.app.UI.fontsize=size
        editor.updateOptions({
            fontSize: size,
        })
    }
    
    const dispatchsave=function(){
        var e = new KeyboardEvent('keydown',{keyCode:83,ctrlKey: true});
        window.dispatchEvent(e);
    }
    //监听文件变化
    watch(()=>store.app.files[store.app.fileIndex], (newValue, oldValue) => {
        if(editType.value.indexOf(store.app.files[store.app.fileIndex].type)==-1) return
        if(editor==null){
            init()
        }else{
            if(store.app.files.length>0){
                editor.setValue(getFile())
            }else{
                editor.setValue("")
            }
            if(store.app.files[store.app.fileIndex].cloud==true){
                editor.updateOptions({ readOnly: true })
            }else{
                editor.updateOptions({ readOnly: false })
            }
        }
    })
    watch(()=>store.app.files[store.app.fileIndex].content, (newValue, oldValue) => {
        editor.setValue(store.app.files[store.app.fileIndex].content)
    })
    //监听UI主题变化
    watch(()=> store.app.UI.theme, (newValue, oldValue) => {
        if("深色"==store.app.UI.theme){
            monaco.editor.setTheme("hc-black")
        }else if(["灰色","蓝色","红色"].includes(newValue)){
            monaco.editor.setTheme("vs-dark")
        }else{
            monaco.editor.setTheme("vs")
        }
    })
    //监听保存事件
    function save(e:any) {
        if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
            e.preventDefault();
            if(store.app.files[store.app.fileIndex].cloud) return
            if(store.app.files.length>0&&editType.value.indexOf(store.app.files[store.app.fileIndex].type)>-1){
                store.app.files[store.app.fileIndex].content=editor.getValue();
                let state = file.saveFile(store.app.files[store.app.fileIndex].fullPath,editor.getValue()) as boolean
                if(state) store.app.notification="保存成功"
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
    <div v-show="editType.indexOf(store.app.files[store.app.fileIndex].type)>-1" class="editor" :style="{borderBottom:store.app.UI.layout=='column'?'1px solid var(--borderColor)':'',borderRight:store.app.UI.layout=='row'?'1px solid var(--borderColor)':''}">
        <div class="menu">
            <ul>
                <li @click="" >
                    <i class="fa fa-file-text"></i> {{store.app.locales=='zh'?'文件':'file'}}
                    <ul>
                        <li @click="dispatchsave()">
                            <i class="fa fa-floppy-o"></i> {{store.app.locales=='zh'?'保存':'save'}}
                        </li>
                    </ul>
                </li>
                <li @click="" v-if="false">
                    <i class="fa fa-legal"></i> {{store.app.locales=='zh'?'插入':'insert'}}
                    <ul>
                        <li @click="">
                            <i class="fa fa-code"></i> {{store.app.locales=='zh'?'代码':'code'}}
                        </li>
                        <li @click="">
                            <i class="fa fa-file-image-o"></i> {{store.app.locales=='zh'?'图片':'image'}}
                        </li>
                        <li @click="">
                            <i class="fa fa-link"></i> {{store.app.locales=='zh'?'链接':'link'}}
                        </li>
                    </ul>
                </li>
                <li @click="" >
                    <i class="fa fa-adjust"></i> {{store.app.locales=='zh'?'主题':'theme'}}
                    <ul>
                        <li @click="changeStyle('vs')">
                            {{store.app.locales=='zh'?'浅色':'vs'}}
                        </li>
                        <li @click="changeStyle('vs-dark')">
                            {{store.app.locales=='zh'?'深色':'vs-dark'}}
                        </li>
                        <li @click="changeStyle('hc-black')">
                            {{store.app.locales=='zh'?'黑色':'hc-black'}}
                        </li>
                    </ul>
                </li>
                <li @click="" >
                    <i class="fa fa-language"></i> {{store.app.locales=='zh'?'语言':'language'}}
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
                    <i class="fa fa-font"></i> {{store.app.locales=='zh'?'字体':'font'}}
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
        max-width:100%;
        height: 100%;
        flex:5;
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
    