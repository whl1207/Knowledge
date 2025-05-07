<script setup lang="ts">
    import {onMounted,onBeforeUnmount,ref, nextTick,computed} from 'vue'
    import {Ollama} from 'ollama/dist/browser.mjs'
    import block_md from './block_md.vue'
    import {usestore} from '../../store'
    const store=usestore()
    
    let panel = ref("") //面板显示参数，可以是设置或者配置
    let AIconfig = ref({
        model_url:'http://127.0.0.1:11434',
        model_type:'',
        model_types:[] as any[],
    })
    //默认提示词
    let initPrompt = ref([
        "你是一名专业的老师，现在你需要根据我提供的主题给出markdown格式的测试题来测试我，注意markdown格式的层级要鲜明。测试的内容为",
    ])
    //对比的模型
    let models = ref([
        {
            model:"",
            prompt:"请用中文给出几个简单的题目。"
        },
        {
            model:"",
            prompt:"请用中文给出几个复杂的题目。"
        }
    ])
    //提示词
    let prompts = ref([
        "可靠性。",
    ])
    let results=ref(Array.from(Array(models.value.length), () => new Array(prompts.value.length).fill("无")))
    let ollama=null as any //服务
    //改变Ollama服务地址
    function changeOllamaServe() {
        ollama = new Ollama({host: AIconfig.value.model_url})
    }
    const addPrompts=function(){
        prompts.value.push('');
        for (let i = 0; i < prompts.value.length; i++) {
            results.value[i].splice(prompts.value.length-1, 0, '无');
        }
    }
    const start=async function(){
        for(let i=0;i<models.value.length;i++){
            for(let j=0;j<prompts.value.length;j++){
                await chat(i,j)
            }
        }
    }
    //开始聊天
    const chat=async function(i:number,j:number){
        let history = []
        //更新对话提示
        history.push({role:'user',content:initPrompt.value+prompts.value[j]+models.value[i].prompt})
        results.value[i][j]='正在思考...'
        //发送到ollama服务
        const response = await ollama.chat({ model: models.value[i].model, messages: history, stream: true })
        results.value[i][j] = ""
        //流式输出
        for await (const part of response) {
            results.value[i][j]=results.value[i][j]+part.message.content
        }
        return true
    }
    const init= async function() {
        reset()
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
    const reset=function(){
        results.value=Array.from(Array(models.value.length), () => new Array(prompts.value.length).fill("无"))
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
        <div class="panel scoll">
            <div style="display:flex;margin:3px 3px;width:calc(100% - 6px)">
                <textarea class="scoll" v-model="initPrompt" style="height: 50px;width:calc(100% - 65px)" placeholder="请输入默认提示词"></textarea>
                <div style="display: flex;flex-direction: column;width:30px">
                    <div style="display: flex;">
                        <i class="fa fa-circle-o" @click="reset" style="flex:1;margin: 5px;"></i>
                        <i class="fa fa-cog" @click="panel=='设置'?panel='':panel='设置'" style="flex:1;margin: 5px;"></i>
                    </div>
                    <div class="button" title="发送，快捷键为：enter" @click="start()" style="width:100%;text-align: center;margin-right: 5px">
                        <i class="fa fa-send"></i>
                    </div>
                </div>
            </div>
            <table>
                <tr>
                    <td style="text-align: center;vertical-align: middle;">提示词</td>
                    <td v-for="(option, index) in prompts" :key="index">
                        <textarea class="scoll" v-model="prompts[index]" style="border: 0px;height: 80px;" placeholder="请输入提示词"></textarea>
                    </td>
                    <td :rowspan="models.length+1"  style="text-align: center; vertical-align: middle; cursor: pointer;" @click="addPrompts">
                        <i class="fa fa-plus"></i>
                    </td>
                </tr>
                <tr v-for="(option, index) in models" :key="index">
                    <td style="width:150px">
                        <select style="width:155px;height:32px;margin:0px 5px;margin: 5px 0px 5px 5px;" v-model="models[index].model">
                            <option v-for="(option, index) in AIconfig.model_types" :key="index" :value="option.name">{{ option.name }} ({{ (option.size/1024/1024/1024).toFixed(2)+'GB' }})</option>
                        </select>
                        <input v-model="models[index].prompt" style="width:150px">
                    </td>
                    <td v-for="(option, p) in prompts" :key="index">
                        <block_md :content="results[index][p]" :maxHeight="'150px'"/>
                    </td>
                </tr>
                <tr>
                    <td :colspan="prompts.length+1" style="text-align: center;display: flex; align-items: center; justify-content: center;" @click="models.push({model:'',prompt:''});results.push(new Array(prompts.length).fill('无'))">
                        <i class="fa fa-plus"></i>
                    </td>
                    <td :colspan="prompts.length+1"></td>
                </tr>
            </table>
        </div>
        <div class="config scoll" v-if="panel=='设置'">
            <div class="header">
                配置 <i @click="panel=''" style="flex:1;text-align: right" class="fa fa-times"></i>
            </div>
            <div class="body scoll">
                <table>
                        <tr >
                            <td>{{store.locales=='zh'?'模型地址':'Model URL:'}}</td>
                            <td><input v-model="AIconfig.model_url" @change="changeOllamaServe"/></td>
                        </tr>
                </table>
            </div>
        </div>
    </div>
</template>
    
<style scoped>
    .header{
        width: calc(100%);
        display: flex;
        background-color: var(--menuColor);
    }
    .panel{
        overflow-y:auto;
        height:calc(100%)
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
</style>
    