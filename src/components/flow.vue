<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref,Ref, nextTick,computed,watch} from 'vue'
    import {Ollama} from 'ollama/dist/browser.mjs'
    import block_md from './block_md.vue'
    import {usestore} from '../store'
    import { jsPlumb } from 'jsplumb';

    const store=usestore() as any
    
    let panel = ref("") //面板显示参数，可以是设置或者配置
    let AIconfig = ref({
        model_url:'http://127.0.0.1:11434',
        model_type:'',
        model_types:[] as any[],
    })
    //默认提示词
    let initPrompt = ref([
        "",
    ])
    let ollama=null as any //服务
    //改变Ollama服务地址
    function changeOllamaServe() {
        ollama = new Ollama({host: AIconfig.value.model_url})
    }
    const start = async function(){
        for(let i=0; i<items.value.length; i++){
            await chat(i)
        }
    }
    //开始聊天
    const chat=async function(i:number){
        let history = []
        //更新对话提示
        let prompt=initPrompt.value+items.value[i].prompt
        if(items.value[i].model==""){
            items.value[i].result="请选择模型"
            return false
        }
        if(prompt==""){
            items.value[i].result="请输入提示词"
            return false
        }else{
            //获取历史信息
            let selectLinks=links.value
            .filter((link:Link) => link.target === items.value[i].id)
            .map((link:Link) => link.source);
            let sourceItems = items.value.filter(item => selectLinks.includes(item.id))
            for(let i=0;i<sourceItems.length;i++){
                if(sourceItems[i].type=="推理"){
                    if(sourceItems[i].model==items.value[i].model){
                        history.push({role:'user',content:sourceItems[i].prompt})
                        history.push({role:'assistant',content:sourceItems[i].result})
                    }else{
                        history.push({role:'user',content:sourceItems[i].result})
                    }
                }else{
                    history.push({role:'user',content:sourceItems[i].result})
                }
            }
            history.push({role:'user',content:prompt})
            console.log(history)
            //设定模块状态
            items.value[i].result='正在思考...'
            //发送到ollama服务
            const response = await ollama.chat({ model: items.value[i].model, messages: history, stream: true })
            items.value[i].result = ""
            //流式输出
            for await (const part of response) {
                items.value[i].result=items.value[i].result+part.message.content
            }
            return true
        }
    }
    const init = async function() {
        await nextTick()
        jsPlumbInstance.value = jsPlumb.getInstance({
            Container: document.querySelector('.flows') // 明确指定容器
        })
        
        // 设置初始缩放
        jsPlumbInstance.value.setZoom(scale.value);
        
        jsPlumbInstance.value.importDefaults({
            DragOptions: {
                cursor: 'pointer',
                zIndex: 2000,
                containment: 'parent'
            },
            Connector: ['Bezier', { curviness: 30 }],
            Anchors: ['Bottom', 'Top'],
            Endpoint: ['Dot', { radius: 3 }],
            PaintStyle: { stroke: 'var(--borderColor)', strokeWidth: 2 },
            EndpointStyle: { fill: 'var(--fontActiveColor)' }
        })
        jsPlumbInstance.value.bind('click', (conn:any,originalEvent:any) => {
            jsPlumbInstance.value.deleteConnection(conn)
            //删除对应的链接
            const filteredLinks = links.value.filter((link:Link) => {
                return link.source == Number(conn.sourceId.split('-')[1]) && link.target == Number(conn.targetId.split('-')[1])
            })
            // 现在 filteredLinks 数组中只包含满足条件的链接对象，你可以将其从原始数组中删除
            filteredLinks.forEach((link:Link) => {
                const index = links.value.indexOf(link);
                if (index > -1) {
                    links.value.splice(index, 1);
                }
            })
        })
        setTimeout(()=>{
            drawlink()
        },100)
        AIconfig.value.model_types=[]
        ollama = new Ollama({host: AIconfig.value.model_url})
        let result = await ollama.list()
        AIconfig.value.model_types = result.models
        //console.log(AIconfig.value.model_types)
        if(AIconfig.value.model_types.length>0){
            if(AIconfig.value.model_type=="无模型"){
                AIconfig.value.model_type=AIconfig.value.model_types[0].name
            }
        }else{
            AIconfig.value.model_types=["无模型"]
            AIconfig.value.model_type="无模型"
        }
    }
    //对比的模型
    const nodeRefs = ref({}) as any;
    interface item {
        id: number;
        type:string,
        model: string;
        prompt: string;
        result: string;
        x: number;
        y: number;
    }
    let items = ref([
        {
            id:0,
            type:"推理",
            model:"",
            prompt:"你好。",
            result:"未推理",
            x: 20,
            y: 20,
        },
        {
            id:1,
            type:"推理",
            model:"",
            prompt:"你好吗？",
            result:"未推理",
            x: 240,
            y: 20,
        }
    ]) as Ref<item[]>
    
    let blockHeight= ref("85px") //模块预览的高度
    let startX: number, startY: number, currentID: number | null = null;
    let initialX = 0
    let initialY = 0
    let scrollLeft = 0
    let scrollTop = 0
    const onMouseDown = (event: MouseEvent,id:number) => {
        event.stopPropagation();
        // 确保点击的是节点本身而不是子元素
        if (!(event.target as HTMLElement).closest('.flow')) return;
        currentID = id;
        const node = items.value.find(n => n.id === id);
        if (node) {
            const container = document.querySelector('.flows') as HTMLElement;
            const rect = container.getBoundingClientRect();
            
            // 考虑缩放比例计算坐标
            startX = (event.clientX - rect.left + container.scrollLeft) / scale.value;
            startY = (event.clientY - rect.top + container.scrollTop) / scale.value;
            
            initialX = node.x;
            initialY = node.y;
            
            // 添加事件监听器
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
        if(mode.value==""){
            document.addEventListener('mousemove', onMouseMove)
            document.addEventListener('mouseup', onMouseUp)
        }else{
            if(sourceID.value==null){
                sourceID.value=id
            }else{
                //判断是否连接同一模块
                if(sourceID.value!=id){
                    //判断是否已连接
                    let exist = false
                    for(let i=0;i<links.value.length;i++){
                        if(links.value[i].source==sourceID.value&&links.value[i].target==id) exist = true
                    }
                    if(exist==false){
                        //添加链接
                        link(sourceID.value,id)
                    }
                }
                sourceID.value=null
            }
        }
        const container = document.querySelector('.flows') as HTMLElement
        scrollLeft = container.scrollLeft
        scrollTop = container.scrollTop
    };

    const onMouseMove = (event: MouseEvent) => {
        if (currentID === null) return;
        
        const container = document.querySelector('.flows') as HTMLElement;
        const rect = container.getBoundingClientRect();
        
        // 考虑缩放比例计算坐标
        const currentX = (event.clientX - rect.left + container.scrollLeft) / scale.value;
        const currentY = (event.clientY - rect.top + container.scrollTop) / scale.value;
        
        const deltaX = currentX - startX;
        const deltaY = currentY - startY;

        const node = items.value.find(n => n.id === currentID);
        if (node) {
            node.x = initialX + deltaX;
            node.y = initialY + deltaY;
            
            // 限制在容器范围内（考虑缩放）
            const maxX = (container.scrollWidth / scale.value) - 200;
            const maxY = (container.scrollHeight / scale.value) - 150;
            
            node.x = Math.max(0, Math.min(node.x, maxX));
            node.y = Math.max(0, Math.min(node.y, maxY));
            
            // 移动节点后重新绘制连接线
            if (jsPlumbInstance.value) {
                const element = nodeRefs.value[node.id];
                if (element) {
                    jsPlumbInstance.value.repaint(element);
                }
            }
        }
    };

    const onMouseUp = () => {
        currentID = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
    let mode = ref("") as any //操作模式
    let sourceID = ref(null) as any //起始模块
    interface Link {
        source: number;
        target: number;
    }
    let links=ref([]) as any
    const jsPlumbInstance = ref(null) as any;
    const link = (i:number,j:number)=>{
        links.value.push({
            source:i,
            target:j
        })
        drawlink()
    }
    const drawlink = ()=>{
        jsPlumbInstance.value.deleteEveryConnection();

        items.value.forEach(item => {
            const element = nodeRefs.value[item.id]
            if (!element || !(element instanceof HTMLElement)) {
                console.error(`Invalid element for item ${item.id}`, element)
                return
            }

            // 确保每次重新初始化可拖拽状态
            jsPlumbInstance.value.draggable(element, {
                containment: 'parent',
                drag: function(event: any) {
                    jsPlumbInstance.value.repaint(element)
                }
            })
        })
        
        for(let i=0;i<links.value.length;i++){ //对于所有的link，都绘制线
            const connection = jsPlumbInstance.value.connect({
                source: nodeRefs.value[links.value[i].source],
                target: nodeRefs.value[links.value[i].target],
                overlays: [
                    ['Arrow', { width: 12, length: 12, location: 0.5 }],
                ],
            });
            
            // 对新创建的连接线应用当前缩放比例
            if (connection) {
                jsPlumbInstance.value.setZoom(scale.value, connection);
            }
        }
    }
    const addItem = ()=>{
        items.value.push({
            id:items.value.reduce((max, item) => Math.max(max, item.id), -1)+1,
            type:"推理",
            model:"",
            prompt:"",
            result:"未推理",
            x: 20,
            y: items.value.reduce((max, item) => Math.max(max, item.y), 0)+140,
        })
    }
    const addOnline = ()=>{
        items.value.push({
            id:items.value.reduce((max, item) => Math.max(max, item.id), -1)+1,
            type:"网络",
            model:"",
            prompt:"",
            result:"无资料",
            x: 20,
            y: items.value.reduce((max, item) => Math.max(max, item.y), 0)+140,
        })
    }
    const addResouce = ()=>{
        items.value.push({
            id:items.value.reduce((max, item) => Math.max(max, item.id), -1)+1,
            type:"本地",
            model:"",
            prompt:"",
            result:"无资料",
            x: 20,
            y: items.value.reduce((max, item) => Math.max(max, item.y), 0)+140,
        })
    }
    const handleFileDrop = async function(event:any){
        event.preventDefault()
        const files = event.dataTransfer.files
        for (const file of files) {
            const fileExtension = file.name.split('.').pop().toLowerCase();
            if (fileExtension === 'docx' || fileExtension === 'pdf' || fileExtension === 'md' || fileExtension === 'xlsx') {
                items.value.push({
                    id:items.value.reduce((max, item) => Math.max(max, item.id), -1)+1,
                    type:"本地",
                    model:"."+fileExtension,
                    prompt:file.name,
                    result:await window.ipcRenderer.invoke('readFile', file.path),
                    x: event.offsetX,
                    y: event.offsetY,
                })
            }       
        }
    }
    const readAI = function(i:number){
        const urlPattern = /^(http[s]?:\/\/)?([^:/\s]+)(:?\d*)?(.*)?$/
        let url = ""
        if(!urlPattern.test(items.value[i].prompt)){
            url = "https://r.jina.ai/" + items.value[i].prompt;
        }else{
            url = "https://r.jina.ai/https://www.bing.com/search?q=" + items.value[i].prompt;
        }
        console.log(items.value[i].prompt,url)
        const request = new XMLHttpRequest()
        request.open("GET", url, false)  // 同步请求
        request.send()
        items.value[i].result =request.responseText
    }
    const reset = ()=>{
        items.value=[
            {
                id:0,
                type:"推理",
                model:"",
                prompt:"你好。",
                result:"未推理",
                x: 20,
                y: 20,
            },
            {
                id:1,
                type:"推理",
                model:"",
                prompt:"你好吗？",
                result:"未推理",
                x: 240,
                y: 20,
            }
        ]
        links.value=[]
        drawlink()
    }
    const delItem = (i:number)=>{
        //删除连线
        let id = items.value[i].id
        links.value=links.value.filter((link:any) => link.source !== id && link.target !== id)
        drawlink()
        items.value.splice(i,1)
    }
    //重置链接
    const resetLink = ()=>{
        links.value=[]
        drawlink()
    }
    const isInputFocused = ref({}) as any

    const getInputStyle = (index:number) => {
      return isInputFocused.value[index]
        ? "width: 114px; margin-right: 0px;"
        : "width: 50px; margin-right: 0px;"
    }

    const handleFocus = (index:number) => {
      isInputFocused.value = { ...isInputFocused.value, [index]: true }
    }

    const handleBlur = (index:number) => {
      isInputFocused.value = { ...isInputFocused.value, [index]: false }
    }

    // 下载文件
    function save() {
        let data = {
            items:items.value,
            links:links.value
        }
        const blob = new Blob([JSON.stringify(data)], {type: 'text/plain'})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        let name = "流程"+new Date().getMonth() +"-"+ new Date().getDay()+".flow"
        a.download = name
        a.click()
        URL.revokeObjectURL(url)
    }
    // 打开文件
    async function open() {
        const result = await window.ipcRenderer.invoke('openFile')
        if (result.content) {
            let data = JSON.parse(result.content)
            items.value=data.items
            links.value=data.links
            setTimeout(()=>{
                drawlink()
            },10)
        }
    }
    // 新增响应式变量和引用
    const flowsContainer = ref<HTMLElement | null>(null);
    const canvasWidth = ref(3000);
    const canvasHeight = ref(3000);

    // 背景拖拽处理函数
    function handleBackgroundMouseDown(event: MouseEvent) {
        // 确保点击的是背景而不是节点
        const target = event.target as HTMLElement;
        if (!target.classList.contains('flows') && !target.classList.contains('canvas')) return;
        
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startY = event.clientY;
        const container = flowsContainer.value!;
        const initialScrollLeft = container.scrollLeft;
        const initialScrollTop = container.scrollTop;

        const onMouseMove = (e: MouseEvent) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            container.scrollLeft = initialScrollLeft - dx;
            container.scrollTop = initialScrollTop - dy;
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    // 动态更新画布尺寸（可选）
    function updateCanvasSize() {
        let maxX = 0, maxY = 0;
        items.value.forEach(item => {
            maxX = Math.max(maxX, item.x + 200); // 假设节点宽度200px
            maxY = Math.max(maxY, item.y + 150); // 假设节点高度150px
        });
        canvasWidth.value = maxX + 500; // 增加边距
        canvasHeight.value = maxY + 500;
    }

    const scale = ref(1); // 当前缩放比例
    const minScale = 0.5; // 最小缩放比例
    const maxScale = 2;   // 最大缩放比例
    const scaleStep = 0.1; // 每次缩放步长
    function zoomIn() {
        if (scale.value < maxScale) {
            scale.value = Math.min(maxScale, scale.value + scaleStep);
            applyZoom();
            if (jsPlumbInstance.value) {
                jsPlumbInstance.value.repaintEverything();
            }
        }
    }

    function zoomOut() {
        if (scale.value > minScale) {
            scale.value = Math.max(minScale, scale.value - scaleStep);
            applyZoom();
            if (jsPlumbInstance.value) {
                jsPlumbInstance.value.repaintEverything();
            }
        }
    }

    function resetZoom() {
        scale.value = 1;
        applyZoom();
        if (jsPlumbInstance.value) {
            jsPlumbInstance.value.repaintEverything();
        }
    }

    function applyZoom() {
        const canvas = document.querySelector('.canvas') as HTMLElement;
        if (canvas) {
            canvas.style.transform = `scale(${scale.value})`;
            canvas.style.transformOrigin = '0 0';
            
            if (jsPlumbInstance.value) {
                // 设置全局缩放
                jsPlumbInstance.value.setZoom(scale.value);
                
                // 重新绘制所有元素
                jsPlumbInstance.value.repaintEverything();
            }
        }
    }
    function handleWheel(event: Event) {
        const wheelEvent = event as WheelEvent; // 类型断言
        if (wheelEvent.ctrlKey) {
            wheelEvent.preventDefault();
            if (wheelEvent.deltaY < 0) {
            zoomIn();
            } else {
            zoomOut();
            }
        }
    }
    // 在节点移动后更新尺寸
    watch(items, () => updateCanvasSize(), { deep: true });
    //初始化
    onMounted(()=>{
        flowsContainer.value = document.querySelector('.flows');
        if (localStorage.getItem('items')!= null) {
            items.value=JSON.parse(localStorage.getItem("items")!)
        }
        if (localStorage.getItem('links')!= null) {
            links.value=JSON.parse(localStorage.getItem("links")!)
        }
        init()
        updateCanvasSize()
        const container = document.querySelector('.flows');
        if (container) {
            container.addEventListener('wheel', handleWheel as EventListener, { passive: false });
        }
    })
    //关闭该模块时
    onBeforeUnmount(() => {
        const container = document.querySelector('.flows');
        if (container) {
            container.removeEventListener('wheel', handleWheel as EventListener);
        }
        items.value.forEach(item => {
            const element = nodeRefs.value[item.id]
            if (element) {
            }
        })
        jsPlumbInstance.value.reset()
        localStorage.setItem("items",JSON.stringify(items.value))
        localStorage.setItem("links",JSON.stringify(links.value))
    })
</script>
    
<template>
    <div class="main">
        <div style="text-align: end;background:var(--menuColor);border-bottom:1px solid var(--borderColor);-webkit-app-region: drag;">
            <div style="float:left;padding:8px 5px">
                {{store.locales=='zh'?'工作流':'workflow'}}({{ (scale * 100).toFixed(0) }}%)
            </div>
            <div class="button" @click="zoomOut" title="缩小">
            <i class="fa fa-search-minus"></i>
            </div>
            <div class="button" @click="resetZoom" title="重置缩放">
            <i class="fa fa-search"></i>
            </div>
            <div class="button" @click="zoomIn" title="放大">
            <i class="fa fa-search-plus"></i>
            </div>
            <div class="button" @click="open()" title="打开流程">
                <i class="fa fa-folder-o"></i>
            </div>
            <div class="button" @click="save()" title="保存流程">
                <i class="fa fa-floppy-o"></i>
            </div>
            <div class="button" @click="addOnline()" title="添加网络资料">
                <i class="fa fa-globe"></i>
            </div>
            <div class="button" @click="addResouce()" title="添加本地资料">
                <i class="fa fa-file-text-o"></i>
            </div>
            <div class="button" @click="addItem()" title="添加推理">
                <i class="fa fa-plus"></i>
            </div>
            <div class="button" :class="{ 'active': mode=='link' }" title="链接模式" @click="mode!='link'?mode='link':mode='';sourceID=null">
                <i class="fa fa-link"></i>
            </div>
            <div class="button" title="打开设置" @click="panel=='设置'?panel='':panel='设置'" :style="{color:panel=='设置'?'var(--fontActiveColor)':'',backgroundColor:panel=='设置'?'var(--menuActiveColor)':''}" style="margin-right:5px">
                <i class="fa fa-cog"></i>
            </div>
        </div>
        
        <div class="flows" ref="flowsContainer" @dragover.prevent @drop="handleFileDrop($event)" @mousedown="handleBackgroundMouseDown">
            <div class="canvas" :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px' }" @mousedown="handleBackgroundMouseDown">
                <div class="flow" v-for="(item, index) in items" :key="item.id" @mousedown="onMouseDown($event,item.id)" :ref="el => { if(el) nodeRefs[item.id] = el }" :style="{ left: item.x + 'px', top: item.y + 'px' ,border: (sourceID==item.id)?'var(--fontActiveColor) 1px solid':'',width:item.type!='推理'?'150px':''}" :id="'item-' + item.id" :title="'id:'+item.id.toString()">
                    <div style="cursor: move;border-bottom: 1px solid var(--borderColor)" v-if="item.type=='推理'">
                        <input v-model="item.prompt" placeholder="请输入提示词" style="width:50px;margin-right:0px ;" :style="getInputStyle(index)" @focus="handleFocus(index)" @blur="handleBlur(index)"/>
                        <select v-show="!isInputFocused[index]" style="width:60px;height:32px;margin: 5px 0px 5px 5px;" v-model="item.model">
                            <option v-for="(option, index) in AIconfig.model_types" :key="index" :value="option.name">{{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})</option>
                        </select>
                        <div class="button" @click="delItem(index)">
                            <i class="fa fa-trash"></i>
                        </div>
                        <div class="button" title="发送" @click="chat(index)" style="margin-right: 5px">
                            <i class="fa fa-send"></i>
                        </div>
                    </div>
                    <div style="cursor: move;display: flex;font-size:10px;border-bottom: 1px solid var(--borderColor);" v-if="item.type=='本地'" placeholder="请拖入文件">
                        <span style="white-space: nowrap;overflow: hidden;text-overflow: ellipsis;padding:3px;color:var(--fontActiveColor);flex:1;"><i :class="store.icon(item.model)"></i> {{ item.prompt }}</span>
                        <i class="fa fa-trash" style="margin:6px 4px" @click="delItem(index)"></i>
                    </div>
                    <div style="cursor: move;border-bottom: 1px solid var(--borderColor);" v-if="item.type=='网络'">
                        <input v-model="item.prompt" placeholder="请输入网址" style="width:97px;margin-right:0px ;" @change="readAI(index)"/>
                        <div class="button" @click="delItem(index)">
                            <i class="fa fa-trash"></i>
                        </div>
                    </div>
                    <block_md :content="item.result" :maxHeight="blockHeight" :fontSize="'10px'"/>
                </div>
            </div>
        </div>
        <div class="config scoll" v-if="panel=='设置'">
            <div class="body scoll">
                <textarea class="scoll" v-model="initPrompt" style="height: 50px;margin:5px;margin-bottom:0px;width:calc(100% - 24px)" placeholder="请输入任务目标"></textarea>
                <div style="display: flex;">
                    <label>{{store.locales=='zh'?'模型地址':'URL:'}}</label>
                    <input style="flex:1" v-model="AIconfig.model_url" @change="changeOllamaServe"/>
                </div>
                <div style="display: flex;">
                    <label>{{store.locales=='zh'?'建图模式':'flow mode:'}}</label>
                    <select style="flex:1">
                        <option value="自动">自动</option>
                        <option value="手动">手动</option>
                    </select>
                </div>
                <div style="display: flex;">
                    <label>{{store.locales=='zh'?'关联模式':'link mode:'}}</label>
                    <select style="flex:1">
                        <option value="历史对话模式">历史对话模式</option>
                        <option value="提示词模式">提示词模式</option>
                    </select>
                </div>
                <div style="display: flex;">
                    <label>{{store.locales=='zh'?'检索模式':'rag mode:'}}</label>
                    <select style="flex:1">
                        <option value="全文">全文</option>
                        <option value="划分+NPL">划分+NPL</option>
                    </select>
                </div>
                <div style="display: flex;">
                    <label>{{store.locales=='zh'?'预览高度':'height:'}}</label>
                    <input style="flex:1" v-model="blockHeight"/>
                </div>
                <div class="button" style="margin-right: 0px;" title="重置流程" @click="reset">
                    <i class="fa fa-circle-o"></i>
                </div>
                <div class="button" style="margin-right: 0px;" title="重置链接" @click="resetLink">
                    <i class="fa fa-unlink"></i>
                </div>
            </div>
        </div>
    </div>
</template>
    
<style scoped>
    .header{
        width: calc(100%);
        display: flex;
        border-bottom: 1px solid var(--borderColor);
        background-color: var(--menuColor);
    }
    .flows {
        position: relative;
        width: 100%;
        height: calc(100% - 43px);
        overflow: auto;
        cursor: grab;
        background-color: var(--backgroundColor);
    }

    .canvas {
        position: relative;
        min-width: 3000px;
        min-height: 3000px;
        transform-origin: 0 0;
        transition: transform 0.1s ease;
        /* 移除 pointer-events: none */
    }

    .flows:active {
        cursor: grabbing; /* 拖拽中光标 */
    }
    .flows::-webkit-scrollbar{  
        width: 5px;
        height:5px;
    }  
    .flows::-webkit-scrollbar-track{  
        background-color:var(--menuColor);
    }
    .flows::-webkit-scrollbar-thumb{
        background-color:var(--fontActiveColor);
    }

    .flow{
        position:absolute;
        border: 1px solid var(--borderColor);
        border-radius: 5px;
        user-select: none;
        padding: 0px;
        width:206px;
        background-color: var(--backgroundColor);
        will-change: transform;
        pointer-events: auto;
    }
    .config{
        position: absolute;
        top: 42px;
        right: 0;
        border: var(--borderColor) 1px solid;
        background-color: var(--backgroundColor);
        width:200px;
        height:calc(100% - 44px);
        max-width: 90%;
        user-select: none;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
</style>
    