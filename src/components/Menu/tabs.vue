<script setup lang="ts">
    import {
        usestore
    } from '../../store'
    import { onMounted , onBeforeUnmount} from 'vue'
    const store = usestore()
    //打开页面
    const openPage = function (index: number) {
        store.app.fileIndex = index
        //更改路径
        if(store.app.files[store.app.fileIndex].type==""){
            store.app.path=store.app.files[store.app.fileIndex].fullPath
        }else{
            store.app.path=store.app.files[store.app.fileIndex].parentPath
        }
        //判断视图
        toggleView()
    }
    //关闭页面
    const close = function (event:any,index: number) {
        event.stopPropagation()
        //删除页面序数
        store.app.files.splice(index,1)
        //页面清空时
        if(store.app.files.length==0){
            store.app.fileIndex=-1
            if(store.app.environment!="web"){
                store.app.path=store.app.storePath
            }else{
                store.app.path=""
            }
            store.app.domainView=["文件"]
            store.app.objectView=["浏览"]
            store.resize() //触发缩放
        }else{
            //如果关闭的是当前页面，则打开第一项页面
            if(store.app.fileIndex==index) store.app.fileIndex=0
            //切换页面时，更换路径
            if(store.app.files[store.app.fileIndex].isFolder){
                store.app.path=store.app.files[store.app.fileIndex].fullPath
            }else{
                store.app.path=store.app.files[store.app.fileIndex].parentPath
            }
        }
        //判断视图
        toggleView()
    }
    const toggleView = function(){
        if(store.app.files.length>0){
            if(store.app.files[store.app.fileIndex].attributes['推荐领域视图']!=undefined){
                store.app.domainView=[store.app.files[store.app.fileIndex].attributes['推荐领域视图']]
            }
            if(store.app.files[store.app.fileIndex].attributes['推荐对象视图']!=undefined){
                store.app.objectView=[store.app.files[store.app.fileIndex].attributes['推荐对象视图']]
            }
        }
    }
    const scoll = function(event:any) {
        event.preventDefault
        let content = document.querySelector('.App_tabs')! as any
        var divx1 = content.offsetLeft
        var divy1 = content.offsetTop
        var divx2 = content.offsetLeft + content.offsetWidth
        var divy2 = content.offsetTop + content.offsetHeight
        if( event.clientX > divx1 && event.clientX < divx2 && event.clientY > divy1 && event.clientY < divy2){
            content.scrollLeft += event.deltaY/5
        }
    }
    onMounted(() => {
        window.addEventListener('wheel', scoll)
    })
    onBeforeUnmount(() => {
        window.removeEventListener('wheel', scoll)
    })
</script>

<template>
    <div class="App_tabs">
        <div class="App_tab" v-for="(item,index) in store.app.files" :key="index"
            :style="{backgroundColor:store.app.fileIndex==index?'var(--backgroundColor)':'',borderBottom:store.app.fileIndex==index?'1px solid var(--backgroundColor)':'1px solid var(--borderColor)'}"
            @click="openPage(index)">
            <span class="App_title">
                <i v-if="item.cloud==true" class="fa fa-cloud"></i> &nbsp;
            </span>
            <span class="App_title" v-if="store.app.UI.extension">
                <i :class="store.icon(item.type)"></i> {{item.fullName}}&nbsp;
            </span>
            <span class="App_title" v-if="!store.app.UI.extension">
                <i :class="store.icon(item.type)"></i> {{item.name}}&nbsp;
            </span>
            <div class="control">
                <span>
                    <i class="fa fa-times" @click="close($event,index)"></i>
                </span>
            </div>
        </div>
    </div>
</template>

<style scoped>
    .App_tabs{
        position: relative;
        white-space: nowrap;
        float: left;
        height:33px;
        margin-top: 8px;
        overflow-x: auto;
        overflow-y: hidden;
        border-radius: 5px 5px 0px 0px;
        transition: 0.2s;
    }
    .App_tabs::-webkit-scrollbar {
        display: none;
    }
    .App_tab{
        position: relative;
        -webkit-app-region: no-drag;
        background-color: var(--menuColor);
        border: 1px solid var(--borderColor);
        border-radius: 5px 5px 0px 0px;
        height:29px;
        width: fit-content;
        white-space: normal;
        display: inline-block;
        user-select: none;
        padding-left:10px;
        padding-right:10px;
        padding-top:2px;
        white-space:nowrap;
    }
    .App_title{
        position:relative;
        display: inline-block;
        top:0px;
        padding-top:3px;
        text-align: center;
        overflow: hidden;
        max-width:calc(100% - 5px);
    }
    .control{
        position: relative;
        float: right;
        opacity: 0;
        transition: 0.2s;
        padding-top:3px;
    }
    .App_tab:hover .control{
        opacity: 1;
    }
</style>