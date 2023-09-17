<script setup lang="ts">
    import {onMounted,ref} from 'vue'
    import {usestore} from '../../store'
    const store=usestore()
    let initurl = ref("http://m.inftab.com")
    let url = ref(initurl.value)
    let state = ref("")
    const goBack = () => {
        const webview = document.querySelector('webview') as Electron.WebviewTag;
        if (webview && webview.canGoBack()) {
            webview.goBack();
        }
    }
    // 刷新功能
    const refresh = () => {
        const webview = document.querySelector('webview') as Electron.WebviewTag;
        if (webview) {
            webview.reload();
        }
    };
    // 刷新功能
    const home = () => {
        url.value=initurl.value
    };
    //复制
    const copy = () => {
        const webview = document.querySelector('webview') as Electron.WebviewTag;
            // 在页面加载完成后，将输入框中的值更新为当前地址
            url.value = webview.getURL();
            store.web= url.value;
            webview.executeJavaScript(`
                const content = document.documentElement.outerHTML; // 获取当前页面的HTML源码
                // 创建一个隐藏的textarea元素
                const textarea = document.createElement('textarea');
                // 设置要复制的文本内容
                textarea.value = content;
                // 将textarea添加到DOM中
                document.body.appendChild(textarea);
                // 选中textarea中的文本
                textarea.select();
                // 执行复制操作
                document.execCommand('copy');
                // 移除textarea元素
                document.body.removeChild(textarea);
                window.postMessage({ type: "html", content: content }, "*"); // 将源码发送到主进程
            `);
        const clipboard = navigator.clipboard;
        // 读取剪贴板中的文本
        clipboard.readText().then(text => {
            let str=getVisibleTextFromHtml(text);
            const textarea = document.createElement('textarea');
            textarea.value = str;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            store.app.notification="资料读取成功"+str.length
        })
        
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
    onMounted(() => {
        // 获取webview的引用
        const webview = document.querySelector('webview') as Electron.WebviewTag;
        if (webview) {
            // 监听页面加载完成事件
            webview.addEventListener('dom-ready', () => {
                // 在页面加载完成后，将输入框中的值更新为当前地址
                url.value = webview.getURL();
                store.web= url.value;
            });
            webview.addEventListener('did-start-loading', () => {
                console.log('Webview 开始加载');
                state.value="加载中"
                // 在这里执行开始加载的逻辑
            });

            webview.addEventListener('did-stop-loading', () => {
                console.log('Webview 加载成功');
                state.value=""
                store.web= url.value;
                // 在这里执行停止加载的逻辑
            });

            webview.addEventListener('did-fail-load', () => {
                console.log('Webview 加载失败');
                // 在这里执行加载失败的逻辑
            });
        }
        window.addEventListener("message", (event) => {
            if (event.data.type === "html") {
                const htmlContent = event.data.content; // 获取从Webview中发送过来的HTML源码
                console.log(htmlContent); // 打印HTML源码
            }
        });
    });
</script>

<template >
    <div class="browser">
        <div class="tools">
            <input type="text" v-model="url" placeholder="输入网址">
            <button v-if="state==''" @click="refresh"><i class="fa fa-refresh"></i></button>
            <button v-if="state=='加载中'" @click="refresh"><i class="fa fa-spinner"></i></button>
            <button @click="goBack"><i class="fa fa-arrow-left"></i></button>
            <button @click="home"><i class="fa fa-home"></i></button>
            <button @click="copy"><i class="fa fa-copy"></i></button>
        </div>
        <webview ref="iframeRef" id="webview" :src="url" ></webview>
    </div>
</template>

<style scoped>
  .browser{
    width:calc(100% - 0px);
    position:relative;
    margin: 0px;
    padding:0px;
    height: calc(100% - 2px);
    border-left: 1px solid var(--borderColor);
    flex:1;
  }
  .tools{
    float: left;
    width:100%;
    display: flex;
    border-bottom: 1px solid var(--borderColor);
  }
  input{
    height:15px;
    margin:3.5px;
    border-radius: 5px;
    background-color: var(--backgroundColor);
  }
  input:focus {
    outline: none;
  }
  button{
    margin: 0px;
    height: 34px;
    border: 0px;
    border-left: 1px solid var(--borderColor);
    border-radius:0px;
    background-color: var(--backgroundColor);
  }
  webview{
    width:calc(100% - 0px);
    height:calc(100% - 36px);
    border: 0px;
  }
</style>
