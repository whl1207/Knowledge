<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref, nextTick,computed} from 'vue'
    import {Ollama} from 'ollama/dist/browser.mjs'
    import block_md from './block_md.vue'
    import {usestore} from '../store'
    import * as d3 from 'd3';
    import { Matrix,SingularValueDecomposition  } from 'ml-matrix';

    const store=usestore()
    let files = ref([]) as any //知识库文件信息
    let blocks = ref([]) as any //知识库片段信息
    let panel = ref("管理") //显示模式，“管理”时显示知识库，“混合”时显示两个，“聊天”时只显示聊天
    let prompt = ref("") //默认问题
    let result = ref("未推理") //推理结果
    let kb_state = ref("") //支持库处理状态
    let ollama=null as any //服务
    let model = ref({
        url:"http://127.0.0.1:11434", //模型地址
        list:[] as any,
        embed:"nomic-embed-text:latest", //嵌入模型
        process:"qwen2.5:latest", //知识库处理模型
        processPrompt:"请根据如下资料，提出这些资料能够解答的若干个问题，不要返回其他表述。资料如下：", //知识库处理提示词
        searchMethod:"余弦相似度", //按数量检索时，返回的知识片段个数
        searchMode:"按匹配率", //检索模式：按数量/按匹配率
        matchRatio:0.58, //按匹配率检索时，返回的知识片段匹配率阈值
        searchNum:5, //按数量检索时，返回的知识片段个数
        searchCharacter:2500, //按字符检索时，限制的字符数量
        chat:"qwen2.5:latest", //聊天模型
        mdsIterations: 50, // MDS迭代次数
        mdsEpsilon: 0.1 // MDS收敛阈值
    })
    //现有的embedding模型列表
    let embeddingModelList = [
        'nomic-embed-text',
        'mxbai-embed-large',
        'bge-m3',
        'snowflake-arctic-embed',
        'all-minilm',
        'bge-large',
        'snowflake-arctic-embed2',
        'paraphrase-multilingual',
        'granite-embedding',
    ]
    //改变Ollama服务地址
    function changeOllamaServe() {
        ollama = new Ollama({host: model.value.url})
    }
    //获取模型
    async function getModel(){
        let ollama = new Ollama({host: model.value.url})
        try {
            let result = await ollama.list()
            if (result && result.models) {
                model.value.list = JSON.parse(JSON.stringify(result.models))
            }
        } catch (error) {
            console.error('Fetch error:', error);
            kb_state.value="ollama未在运行"
        }
    }
    //选择知识库所在的文件夹
    const openFolder = async function() {
        store.root = await window.ipcRenderer.invoke('openFolderDialog')
        load()
    }
    
    // 知识切片和向量化
    const process = async function() {
        try {
            ollama = new Ollama({ host: model.value.url });
            // 获取文件信息
            let { fileList, relationList } = await window.ipcRenderer.invoke("getFilesRelation", store.root, 3);
            
            files.value = fileList
                .filter((obj: any) => !obj.path.toLowerCase().endsWith('.kb'))
                .map((obj: any, index: number) => {
                    return { ...obj };
                });
            
            kb_state.value = "读取到" + files.value.length + "个文件。正在处理...";
            blocks.value = [];
            
            // 读取每个文件的数据
            for (let i = 0; i < files.value.length; i++) {
                try {
                    let result = await window.ipcRenderer.invoke('readFile', files.value[i].path);
                    if (result != undefined) {
                        files.value[i].content = result;
                        // 按两行切分
                        let block = files.value[i].content.split(/(?:\r?\n){3,}/);
                        kb_state.value = "读取到" + files.value.length + "个文件，正在切分第" + (i + 1) + "个文件并向量化。";
                        
                        // 生成向量
                        try {
                            const response = await ollama.embed({
                                model: model.value.embed,
                                input: block,
                                truncate: true,
                                keep_alive: "1h",
                            });

                            if (!response || !response.embeddings) {
                                throw new Error("向量化处理错误，请检查ollama的embed模型。");
                            }

                            block.forEach((string: string, index: number) => {
                                blocks.value.push({
                                    label: files.value[i].label.substring(0, files.value[i].label.lastIndexOf('.')), // 记录文件名
                                    path: files.value[i].path, // 记录文件路径
                                    extension: files.value[i].extension, // 记录文件扩展名
                                    A: string, // 文本段落
                                    A_vector: response.embeddings[index],
                                    Q: '问题未推理', // 文本对应的问题
                                    Q_vector: [],
                                    p: 0, // 文本的匹配度
                                    state: false, // 段落的匹配状态
                                    show: 'A',
                                });
                            });
                        } catch (embedError) {
                            console.error("向量化处理失败:", embedError);
                            kb_state.value = `文件 ${files.value[i].label} 向量化失败`;
                            continue; // 跳过当前文件，继续处理下一个
                        }
                    }
                } catch (fileError) {
                    console.error("文件读取失败:", fileError);
                    kb_state.value = `文件 ${files.value[i].label} 读取失败`;
                    continue; // 跳过当前文件，继续处理下一个
                }
            }
            kb_state.value = "";
        } catch (globalError) {
            console.error("处理过程中发生全局错误:", globalError);
            kb_state.value = `处理失败`;
        }
    };
    // 推理所有切片问题
    const reasonings = async function(){
        console.log("开始推理，共找到"+blocks.value.length+"个知识片段。")
        for(let i = 0; i < blocks.value.length; i++){
            console.log(i,blocks.value[i].Q)
            if(blocks.value[i].Q!=='问题未推理'&&blocks.value[i].Q!=='') continue
            console.log("开始推理，第"+i+"个知识片段。")
            let history = []
            //更新对话提示
            history.push({role:'user',content:model.value.processPrompt+blocks.value[i].A})
            //发送到ollama服务
            ollama = new Ollama({host:  model.value.url})
            console.log(ollama)
            const response = await ollama.chat({ model: model.value.process, messages: history, stream: true })
            blocks.value[i].Q = ""
            //流式输出
            for await (const part of response) {
                blocks.value[i].Q=blocks.value[i].Q+part.message.content
            }
        }
    }
    // 推理单个切片问题
    const reasoning = async function(i){
        blocks.value[i].Q='正在推理'
        let history = []
        history.push({role:'user',content:model.value.processPrompt+blocks.value[i].A})
        ollama = new Ollama({host:  model.value.url})
        const response = await ollama.chat({ model: model.value.process, messages: history, stream: true })
        blocks.value[i].Q = ""
        for await (const part of response) {
            blocks.value[i].Q=blocks.value[i].Q+part.message.content
        }
    }
    //开始聊天
    const chat=async function(propmt:string){
        ollama = new Ollama({ host: model.value.url });
        result.value="正在思考..."
        // 计算问题的向量
        const queryResponse = await ollama.embed({
            model: model.value.embed,
            input: propmt,
            truncate: true,
            keep_alive: "1h",
        });
        const queryEmbedding = queryResponse.embeddings?.[0];
        
        // 准备所有向量（包括问题）
        const allVectors = blocks.value.map((b: any) => b.A_vector);
        allVectors.push(queryEmbedding);
        
        // 计算MDS降维结果
        let mdsPoints: any[] = [];
        if (model.value.searchMethod === "MDS") {
            const mdsResult = computeMDS(allVectors, model.value.mdsIterations, model.value.mdsEpsilon);
            
            // 提取问题点的坐标（最后一个点）
            const queryPoint = mdsResult[mdsResult.length - 1];
            
            // 计算每个点与问题的距离（转换为相似度）
            mdsPoints = blocks.value.map((block: any, i: number) => {
                const point = mdsResult[i];
                const dx = point[0] - queryPoint[0];
                const dy = point[1] - queryPoint[1];
                const distance = Math.sqrt(dx*dx + dy*dy);
                
                // 更新blocks的匹配度
                block.p = 1 / (1 + distance);
                
                return {
                    x: point[0],
                    y: point[1],
                    label: block.label,
                    p: block.p,
                    distance: distance,
                    content: block.A // 添加片段内容
                };
            });
            
            // 添加问题点（不参与排序）
            const queryData = {
                x: queryPoint[0],
                y: queryPoint[1],
                label: "您的问题",
                p: 1,
                isQuery: true
            };
            
            // 按相似度排序（仅对知识片段排序）
            mdsPoints.sort((a, b) => b.p - a.p);
            
            // 绘制图表（包含排序后的点和问题点）
            nextTick(() => {
                const container = document.getElementById('mds-chart');
                if (container) {
                    // 合并排序后的点和问题点
                    const pointsToDraw = [...mdsPoints.slice(0, 50), queryData];
                    drawScatterPlot(container, pointsToDraw);
                }
            });
        } else {
            // 原来的余弦相似度计算
            for(let i = 0; i < blocks.value.length; i++){
                blocks.value[i].p = cosineSimilarity(queryEmbedding, blocks.value[i].A_vector);
                if(blocks.value[i].Q_vector.length > 0){
                    blocks.value[i].p = (blocks.value[i].p + cosineSimilarity(queryEmbedding, blocks.value[i].Q_vector)) / 2;
                }
            }
        }
        blocks.value.sort((a: any, b: any) => b.p - a.p);
        // 其余代码保持不变...
        let history = []
        let content = propmt+'。请根据参考资料解决以上问题，如果不相关可以忽略后续资料。'
        let num = 0;
        // 重置所有片段的匹配状态
        for (let i = 0; i < blocks.value.length; i++) {
            blocks.value[i].state=false;
        }
        // 按不同模式匹配
        if(model.value.searchMode=="按数量"){
            for (let i = 0; i < model.value.searchNum; i++) {
                content += "《" + blocks.value[i].label + "》："
                content += blocks.value[i].A + "。";
                blocks.value[i].state=true;
                num++;
            }
        }else if(model.value.searchMode=="按匹配率"){
            for (let i = 0; i < blocks.value.length; i++) {
                if(blocks.value[i].p >= model.value.matchRatio) {
                    content += "《" + blocks.value[i].label + "》："
                    content += blocks.value[i].A + "。";
                    blocks.value[i].state=true;
                    num++;
                } else {
                    break;
                }
            }
        }else if(model.value.searchMode=="按字符"){
            let currentLength = content.length;
            for (let i = 0; i < blocks.value.length; i++) {
                const blockContent = "《" + blocks.value[i].label + "》：" + blocks.value[i].A + "。";
                if (currentLength + blockContent.length <= model.value.searchCharacter) {
                    content += blockContent;
                    currentLength += blockContent.length;
                    blocks.value[i].state=true;
                    num++;
                } else {
                    break;
                }
            }
        }
        console.log(content)
        result.value="正在思考，查询到"+num+"个资料。"
        //更新对话提示
        history.push({role:'user',content:content})
        //发送到ollama服务
        ollama = new Ollama({host: model.value.url})
        const response = await ollama.chat({ model: model.value.chat, messages: history, stream: true })
        result.value = ""
        //流式输出
        for await (const part of response) {
            result.value=result.value+part.message.content
        }
        return true
    }
    
    // 计算余弦相似度
    function cosineSimilarity(vecA:number[], vecB:number[]) {
        // 确保向量长度相同
        if (vecA.length !== vecB.length) {
            throw new Error("向量维度不匹配");
        }

        // 计算点积
        let dotProduct = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
        }

        // 计算模长
        const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
        const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));

        // 避免除以零
        if (magnitudeA === 0 || magnitudeB === 0) {
            return 0;
        }

        return dotProduct / (magnitudeA * magnitudeB);
    }
    // 添加MDS计算函数
    function computeMDS(vectors: number[][], iterations: number, epsilon: number): number[][] {
        const n = vectors.length;
        if (n === 0) return [];
        
        // 计算距离矩阵
        const distances = Matrix.zeros(n, n);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                distances.set(i, j, 1 - cosineSimilarity(vectors[i], vectors[j]));
            }
        }
        
        // 经典MDS算法
        const H = Matrix.eye(n).sub(Matrix.ones(n, n).mul(1 / n));
        
        // 计算D²：不使用map，改用循环
        const D2 = Matrix.zeros(n, n);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const val = distances.get(i, j);
                D2.set(i, j, val * val);
            }
        }
        
        // B = -0.5 * H * D² * H
        const B = H.mmul(D2).mmul(H).mul(-0.5);
        
        // 计算SVD
        const svd = new SingularValueDecomposition(B);
        const U = svd.leftSingularVectors;
        const s = svd.diagonal;
        
        // 创建 sqrt(S) 对角矩阵
        const sqrtS = Matrix.zeros(n, n);
        for (let i = 0; i < s.length; i++) {
            sqrtS.set(i, i, Math.sqrt(Math.max(s[i], 0))); // 确保非负
        }
        
        // X = U * sqrt(S)
        const X = U.mmul(sqrtS);
        
        // 取前2维
        const result: number[][] = [];
        for (let i = 0; i < n; i++) {
            result.push([X.get(i, 0), X.get(i, 1)]);
        }
        
        return result;
    }

    // 添加绘制散点图函数
    function drawScatterPlot(container: HTMLElement, points: {x: number, y: number, label: string, p: number, isQuery?: boolean, content?: string}[]) {
        // 清空容器
        container.innerHTML = '';
        const width = container.clientWidth;
        const height = container.clientHeight;
        const margin = {top: 20, right: 20, bottom: 20, left: 40};
        
        const svg = d3.select(container)
            .append('svg')
            .attr('width', width)
            .attr('height', height);
        
        // 计算包含所有点的范围（包括问题点）
        const xExtent = d3.extent(points, d => d.x) as [number, number];
        const yExtent = d3.extent(points, d => d.y) as [number, number];
        
        const x = d3.scaleLinear()
            .domain(xExtent)
            .range([margin.left, width - margin.right]);
        
        const y = d3.scaleLinear()
            .domain(yExtent)
            .range([height - margin.bottom, margin.top]);
        
        // 添加坐标轴
        svg.append('g')
            .attr('transform', `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(x));
        
        svg.append('g')
            .attr('transform', `translate(${margin.left},0)`)
            .call(d3.axisLeft(y));
        
        // 添加连接线（从问题点到其他点）
        const queryPoint = points.find(p => p.isQuery);
        if (queryPoint) {
            points.filter(p => !p.isQuery).forEach(targetPoint => {
                svg.append('line')
                    .attr('x1', x(queryPoint.x))
                    .attr('y1', y(queryPoint.y))
                    .attr('x2', x(targetPoint.x))
                    .attr('y2', y(targetPoint.y))
                    .attr('stroke', 'rgba(200, 200, 200, 0.3)')
                    .attr('stroke-width', 0.5);
            });
        }
        
        // 创建工具提示div
        const tooltip = d3.select(container)
            .append('div')
            .attr('class', 'scatter-tooltip')
            .style('position', 'absolute')
            .style('visibility', 'hidden')
            .style('background', 'var(--backgroundColor)')
            .style('border', '1px solid var(--borderColor)')
            .style('border-radius', '5px')
            .style('padding', '8px')
            .style('max-width', '300px')
            .style('max-height', '200px')
            .style('overflow', 'auto')
            .style('z-index', '1000')
            .style('font-size', '12px');
        
        // 添加知识片段点
        svg.selectAll('circle.point')
            .data(points.filter(p => !p.isQuery))
            .enter()
            .append('circle')
            .attr('class', 'point')
            .attr('cx', d => x(d.x))
            .attr('cy', d => y(d.y))
            .attr('r', 4)
            .attr('fill', d => d3.interpolateRdYlGn(d.p))
            .attr('stroke', '#666')
            .attr('stroke-width', 0.5)
            .on('mouseover', function(event, d) {
                // 显示工具提示
                tooltip.style('visibility', 'visible')
                    .style('left', (event.pageX + 10) + 'px')
                    .style('top', (event.pageY - 10) + 'px')
                    .html(`
                        <div><strong>${d.label}</strong></div>
                        <div>相似度: ${(d.p*100).toFixed(1)}%</div>
                        <hr style="margin:5px 0;border-color:var(--borderColor);">
                        <div>${d.content || '无内容'}</div>
                    `);
                
                // 高亮当前点
                d3.select(this)
                    .attr('r', 6)
                    .attr('stroke-width', 1.5);
            })
            .on('mouseout', function() {
                // 隐藏工具提示
                tooltip.style('visibility', 'hidden');
                
                // 恢复默认大小
                d3.select(this)
                    .attr('r', 4)
                    .attr('stroke-width', 0.5);
            });
        
        // 添加问题点（特殊标记）
        if (queryPoint) {
            svg.append('circle')
                .attr('cx', x(queryPoint.x))
                .attr('cy', y(queryPoint.y))
                .attr('r', 8)
                .attr('fill', 'none')
                .attr('stroke', 'red')
                .attr('stroke-width', 2);
            
            svg.append('circle')
                .attr('cx', x(queryPoint.x))
                .attr('cy', y(queryPoint.y))
                .attr('r', 4)
                .attr('fill', 'red');
            
            svg.append('text')
                .attr('x', x(queryPoint.x) + 10)
                .attr('y', y(queryPoint.y) - 10)
                .text('您的问题')
                .attr('font-size', '12px')
                .attr('fill', 'red');
        }
    }

    // 知识库加工后的片段数
    const processNum = computed(()=>{
        return blocks.value.filter((item:any) => item.Q !== '问题未推理').length
    })
    // 保存处理后的知识库
    const save = function(){
        // 获取当前时间并格式化为文件名
        const now = new Date();
        // 使用更易读的格式：YYYY-MM-DD_HH-MM-SS
        const timestamp = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;

        window.ipcRenderer.invoke('saveFile', `${store.root}/${timestamp}.kb`, JSON.stringify(blocks.value))
            .then((success) => {
                if (success) {
                    kb_state.value = `文件 ${timestamp}.kb 保存成功`;
                } else {
                    kb_state.value = '文件保存失败';
                }
            })
            .catch((error) => {
                console.error(error);
                kb_state.value = '文件保存出错';
            })
    }
    // 读取处理后的知识库
    const load = async function(){
        //获取文件信息
        if(store.root=='') return
        let { fileList, relationList } = await window.ipcRenderer.invoke("getFilesRelation", store.root, 1)
        const kbs = fileList.filter((file:any)=>file.path.endsWith('.kb'))
        
        if(kbs.length>0){
            kb_state.value = '在文件夹中读取到'+kbs.length+'个知识库';
            
            // 创建对话框选项
            const options = {
                type: 'question',
                buttons: [...kbs.map((file:any) => file.label), '取消'], // 添加取消按钮
                defaultId: 0,
                title: '选择知识库',
                message: '请选择要加载的知识库文件:',
                detail: '检测到多个知识库文件，请选择其中一个加载'
            };
            
            try {
                // 显示对话框并等待用户选择
                const { response } = await window.ipcRenderer.invoke('showDialog', options);
                
                // 检查用户是否点击了取消按钮
                if (response === kbs.length) { // 取消按钮是最后一个选项
                    kb_state.value = '取消加载知识库，请对知识进行切片和初始化';
                    return; // 直接返回，不加载任何文件
                }
                
                if (response >= 0 && response < kbs.length) {
                    let content = await window.ipcRenderer.invoke('readFile', kbs[response].path)
                    blocks.value = JSON.parse(content)
                    kb_state.value = '已加载知识库: ' + kbs[response].label;
                } else {
                    kb_state.value = '取消加载知识库，请对知识进行切片和初始化';
                }
            } catch (error) {
                console.error('加载知识库出错:', error);
                kb_state.value = '加载知识库出错';
            }
        }
    }
    const init= async function() {
        load()
        getModel()
    }
    //初始化
    onMounted(()=>{
        init()
    })
    //关闭该模块时
    onBeforeUnmount(() => {
    })
</script>
    
<template>
    <div class="main">
        <div v-if="panel=='聊天'||panel=='混合'" style="display: flex;flex-direction: column;min-width:250px;flex:1;border-right: 1px var(--borderColor) solid;-webkit-app-region: drag;">
            <div style="display: flex;width:calc(100% - 5px);padding-right: 5px;">
                <select v-model="model.chat" style="flex:1;height:32px;margin: 5px 0px 5px 5px;-webkit-app-region: no-drag;" @click="getModel()">
                    <option 
                        v-for="(option, index) in model.list.filter((model:any) => 
                            !embeddingModelList.some(embedModel => 
                                model.name.toLowerCase().includes(embedModel.toLowerCase())
                            )
                        )" 
                        :key="index" 
                        :value="option.name"
                    >
                        {{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})
                    </option>
                </select>
                <select v-model="model.searchMethod" style="width:72px;height:32px;margin: 5px 0px 5px 5px;-webkit-app-region: no-drag;" @click="getModel()">
                    <option value="余弦相似度">{{store.locales=='zh'?'余弦相似度':'Cosine similarity'}}</option>
                    <option value="MDS">MDS</option>
                </select>
                <select v-model="model.searchMode" style="width:72px;height:32px;margin: 5px 0px 5px 5px;-webkit-app-region: no-drag;" @click="getModel()">
                    <option value="按匹配率">{{store.locales=='zh'?'按匹配率':'Matching rate'}}</option>
                    <option value="按数量">{{store.locales=='zh'?'按数量':'Quantity'}}</option>
                    <option value="按字符">{{store.locales=='zh'?'按字符':'Character'}}</option>
                </select>
                <input type="number" style="width:45px;margin-right: 0px;-webkit-app-region: no-drag;" v-if="model.searchMode=='按匹配率'" v-model="model.matchRatio"/>
                <input type="number" style="width:45px;margin-right: 0px;-webkit-app-region: no-drag;" v-if="model.searchMode=='按数量'" v-model="model.searchNum"/>
                <input type="number" style="width:45px;margin-right: 0px;-webkit-app-region: no-drag;" v-if="model.searchMode=='按字符'" v-model="model.searchCharacter"/>
                <div class="button" title="打开对话界面" @click="panel=='混合'?panel='聊天':panel='混合'" :class="{active:panel=='混合'}">
                    <i class="fa fa-stack-overflow" ></i>
                </div>
            </div>
            <div style="display: flex;width:calc(100% - 5px);padding-right: 5px;">
                <input style="flex:2;margin-right: 0px;-webkit-app-region: no-drag;" phace v-model="prompt" placeholder="请输入问题"/>
                <div class="button" @click="chat(prompt)"><i class="fa fa-send"></i> </div>
            </div>
            <div id="mds-chart-container" v-if="model.searchMethod=='MDS'" style="width:100%;height:200px;overflow: hidden;-webkit-app-region: no-drag; display: flex; justify-content: center; align-items: center;">
                <div id="mds-chart" style="width: 100%; height: 100%;"></div>
            </div>
            <div class="scoll" style="flex:1;overflow-y: auto;border: 1px solid var(--borderColor);margin: 0px 5px 5px 5px;border-radius: 5px;-webkit-app-region: no-drag;">
                <block_md :content="result" :fontSize="'12px'"/>
            </div>
        </div>
        <div class="panel scoll" v-if="panel=='管理'||panel=='混合'">
            <div style="display: flex;flex-direction:column;width:calc(100%);border-bottom: 1px solid var(--borderColor);background-color: var(--menuColor);-webkit-app-region: drag;">
                <div style="display: flex;flex-direction:row">
                    <div class="button" title="打开对话界面" @click="panel=='管理'?panel='混合':panel='管理'" :class="{active:panel=='混合'}">
                        <i class="fa fa-comment-o" ></i>
                    </div>
                    <div class="button" @click="openFolder" title="打开文件夹"><i class="fa fa-folder-open"></i> </div>
                    <input style="flex:2;margin-right: 0px;-webkit-app-region: no-drag;" placeholder="知识库位置" title="知识库位置" v-model="store.root"/>
                    <input style="flex:1;margin-right: 5px;-webkit-app-region: no-drag;" placeholder="AI服务的地址" title="AI服务的地址" v-model="model.url" @change="changeOllamaServe"/>
                </div>
                <div style="display: flex;flex-direction:row">
                    <div class="button" title="读取知识库" @click="load"><i class="fa fa-file-text-o"></i> </div>
                    <div class="button" style="margin-right:5px;" title="保存知识库" @click="save"><i class="fa fa-floppy-o"></i> </div>
                    <div style="padding: 8px 2px;white-space: nowrap;overflow: hidden;text-overflow: ellipsis">
                        <i class="fa fa-file-text"></i> {{files.length}} <i class="fa fa-file-text-o"></i> {{blocks.length}} <i class="iconfont">&#xe65d;</i> {{processNum}}/{{blocks.length}}
                    </div>
                    <div style="padding: 8px 2px;white-space: nowrap;overflow: hidden;text-overflow: ellipsis">{{store.locales=='zh'?'&nbsp;嵌入:':'Embed:'}}</div>
                    <select v-model="model.embed" style="flex:1;height:32px;margin: 5px 0px 5px 5px;-webkit-app-region: no-drag;" @click="getModel()">
                        <option 
                            v-for="(option, index) in model.list.filter((model:any) => 
                                embeddingModelList.some(embedModel => 
                                    model.name.toLowerCase().includes(embedModel.toLowerCase())
                                )
                            )" 
                            :key="index" 
                            :value="option.name"
                        >
                            {{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})
                        </option>
                    </select>
                    <div class="button" title="读取文件和切片" @click="process"><i class="fa fa-cut"></i></div>
                    <div style="padding: 8px 2px;white-space: nowrap;overflow: hidden;text-overflow: ellipsis">&nbsp;{{store.locales=='zh'?'&nbsp;提取:':'Extract:'}}</div>
                    <select v-model="model.process" style="flex:1;height:32px;margin: 5px 0px 5px 5px;-webkit-app-region: no-drag;" @click="getModel()">
                        <option 
                            v-for="(option, index) in model.list.filter((model:any) => 
                                !embeddingModelList.some(embedModel => 
                                    model.name.toLowerCase().includes(embedModel.toLowerCase())
                                )
                            )" 
                            :key="index" 
                            :value="option.name"
                        >
                            {{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})
                        </option>
                    </select>
                    <input style="flex:2;margin-right: 0px;-webkit-app-region: no-drag;" placeholder="知识处理提示词" title="知识处理提示词" v-model="model.processPrompt"/>
                    <div class="button" style="margin-right: 5px;" title="提取信息" @click="reasonings()"><i class="fa fa-question"></i> </div>
                </div>
            </div>
            <div style="height:calc(100% - 83px);display: flex;">
                <div class="scoll" style="max-width: 100%;flex:2;height:100%;overflow-y: auto;">
                    <div class="blocks scoll" @dragover.prevent >
                        <div v-for="(block, index) in blocks" :key="index" class="block scoll">
                            <div class="label">
                                <span class="ellipsis" :style="{color:block.state?'var(--fontActiveColor)':''}" :title="block.label"> <i :class="store.icon(block.extension)"></i> 
                                {{block.label}}</span>
                                <span>{{(block.p*100).toFixed(2)+"%"}}</span>
                                <button @click="block.show='A'" :style="{color:block.show!='Q'?'var(--fontActiveColor)':''}" :title="block.A_vector?.length > 0 ? block.A_vector?.length + '维向量' : '向量未计算'"><i class="fa fa-file-text-o"></i> </button>
                                <button @click="block.show='Q'" :style="{color:block.show=='Q'?'var(--fontActiveColor)':''}" :title="block.Q_vector?.length > 0 ? block.Q_vector?.length + '维向量'  : '向量未计算'"><i :class="block.Q!='问题未推理'?'fa fa-commenting-o':'fa fa-comment-o'"></i> </button>
                                <button @click="reasoning(index)"><i class="fa fa-question"></i> </button>
                            </div>
                            <hr />
                            <block_md v-if="block.show!='Q'" :content="block.A" :fontSize="'8px'" :maxHeight="'170px'"/>
                            <textarea class="scoll" style="font-size: 8px;" v-if="block.show=='Q'" v-model="block.Q"></textarea>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div style="display:block;position:fixed;right:5px;bottom:5px;font-size: 10px;">{{kb_state}}</div>
    </div>
</template>
    
<style scoped>
    .main{
        display:flex;
        width:100%;
        height:calc(100% - 1px)
    }
    .header{
        width: calc(100%);
        display: flex;
        background-color: var(--menuColor);
    }
    .panel{
        padding: 0px;
        overflow-y:auto;
        flex:3;
        height:100%;
    }
    .table{
        padding: 0px;
    }
    tr{
        padding: 0px;
    }
    td{
        padding: 0px;
        vertical-align: top;
    }
    textarea{
        height:calc(100% - 10px);
        width:calc(100% - 12px);
    }
    .config{
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border-radius: 5px;
        border: var(--borderColor) 1px solid;
        background-color: var(--backgroundColor);
        width:calc(50% + 120px);
        max-width: 90%;
        max-height: calc(100% - 100px);
        user-select: none;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .body{
        padding:5px;
        flex-grow: 1;
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
    .config table{
        width: 100%;
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
    .blocks{
        width:calc(100% - 5px);
        height:fit-content;
        max-height:calc(100% - 5px);
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        align-items: start;
        padding:5px 0px 0px 5px;
    }
    .block{
        position: relative;
        word-wrap: break-word;
        border: 1px solid var(--borderColor);
        margin:0px 5px 5px 0px;
        border-radius: 5px;
        height:200px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
    }
    .block .label{
        font-size: 10px;
        width:calc(100% - 6px);
        margin:3px;
        display: flex;
        align-items: center;
    }
    .ellipsis {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
    }
</style>