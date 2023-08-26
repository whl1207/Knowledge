<script setup lang="ts">
    import { nextTick,onMounted,watch,onBeforeUnmount} from 'vue'
    import {usestore} from '../../../store'
    import file from '../../../../electron/file'
    //import Editor from '@toast-ui/editor'
    //import '/public/toastui-editor.css'
    //import 'highlight.js/styles/github.css'
    import 'prismjs/themes/prism.css'
    //import '@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight.css';
    //import codeSyntaxHighlight from '@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight-all';

    const store=usestore()

    let editor = null as any
    const init=async function(){
        if(store.app.files.length==0) return
        await nextTick()
        editor = new Editor({
            el: document.getElementById("mdeditor")!,
            height: '100%',
            initialEditType: 'wysiwyg',//wysiwyg or markdown
            previewStyle: 'vertical',
            useCommandShortcut:true,
            plugins: [codeSyntaxHighlight],
            
            customHTMLRenderer: {
                /**latex(node) {
                    const generator = new HtmlGenerator({ hyphenate: false });
                    const { body } = parse(node.literal, { generator }).htmlDocument();

                    return [
                        { type: 'openTag', tagName: 'div', outerNewLine: true },
                        { type: 'html', content: body.innerHTML },
                        { type: 'closeTag', tagName: 'div', outerNewLine: true }
                    ];
                },*/
            }
        })
        
        if(store.app.files[store.app.fileIndex].type==".md"||store.app.files[store.app.fileIndex].type=="") {
            let str = store.app.files[store.app.fileIndex].content
            await nextTick()
            editor.setMarkdown(str)
        }
    }
    watch(()=>store.app.fileIndex, (newValue, oldValue) => {
        init()
    })
    function save(e:any) {
        if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
            e.preventDefault();
            file.saveFile(store.app.storePath+store.app.files[store.app.fileIndex].fullPath,editor.getMarkdown());
        }
    }
    onMounted(() => {
        init()
        window.addEventListener('keydown', save)
    })
    onBeforeUnmount(() => {
        window.removeEventListener('keydown', save)
    })
</script>
    
<template>
    <div class="editor" v-if="store.app.files.length>0&&(store.app.files[store.app.fileIndex].type=='.md'||store.app.files[store.app.fileIndex].type=='')">
        <div id="mdeditor"></div>
    </div>
</template>
    
<style scoped>
    .editor{
        position:relative;
        margin: 0px;
        width:100%; /**flex溢出bug，可改0*/
        height: calc(100% - 2px);
        flex:4;
        overflow: hidden;/**flex溢出bug，添加*/
    }
    
</style>
    