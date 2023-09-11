<script setup lang="ts">
    import { ref ,onMounted} from 'vue'
    import {usestore} from '../../store'

    //加载组件
    import file from './file.vue'
    import window from './window.vue'
    import search from './search.vue'
    import cloud from './cloud.vue'
    import server from './server.vue'
    import setView from './set.vue'
    import AI from './AI.vue'

    const store=usestore()
    
    defineProps({
      Show: Boolean,
    })

    const changeWidth=(value:number)=>{
        store.app.navWidth=value
        store.resize() //触发缩放
    }
    onMounted(() => {
        if(store.app.environment=="web"){
            store.app.navView="cloud"
        }else{
            store.app.navView="file"
        }
    })
  </script>
  
  <template>
    <transition name="fade">
        <div id="App_nav" :class="Show === true ?'nav':'panelUnactive'" :style="{width:store.app.navWidth+'px'}">
            <div class="tabs">
                <div class="tab" v-if="store.app.environment!='web'" :class="[store.app.navView=='file'?'active':'']" @click="store.app.navView='file';changeWidth(300)">
                    <i class="iconfont">&#xeac6;</i>
                </div>
                <div class="tab" :class="[store.app.navView=='cloud'?'active':'']" @click="store.app.navView='cloud';changeWidth(300)">
                    <i class="iconfont">&#xeac5;</i>
                </div>
                <div class="tab" v-if="(store.app.environment!='web'&&store.app.storePath!='')||(store.app.environment=='web'&&store.app.network.length>0&&store.app.networkIndex!=-1)" :class="[store.app.navView=='search'?'active':'']" @click="store.app.navView='search';changeWidth(300)">
                    <i class="fa fa-search"></i>
                </div>
                <div class="tab" :class="[store.app.navView=='window'?'active':'']" @click="store.app.navView='window';changeWidth(300)">
                    <i class="iconfont">&#xe619;</i>
                </div>
                <div class="tab" :class="[store.app.navView=='AI'?'active':'']" @click="store.app.navView='AI';changeWidth(400)">
                    <i class="iconfont">&#xe65d;</i>
                </div>
                <div class="tab" v-if="store.app.environment!='web'" :class="[store.app.navView=='server'?'active':'']" @click="store.app.navView='server';changeWidth(300)">
                    <i class="iconfont" :style="{color:store.app.server.state?'var(--fontActiveColor)':'var(--fontColor)'}">&#xe6f2;</i>
                </div>
                <div class="tab" :class="[store.app.navView=='set'?'active':'']" @click="store.app.navView='set';changeWidth(300)">
                    <i class="iconfont">&#xe6c8;</i>
                </div>
            </div>
            <div class="content" v-if="store.app.navView!=''">
                <file v-if="store.app.navView=='file'" />
                <window v-if="store.app.navView=='window'" />
                <search v-if="store.app.navView=='search'" />
                <cloud v-if="store.app.navView=='cloud'" />
                <server v-if="store.app.navView=='server'" />
                <setView v-if="store.app.navView=='set'" />
                <AI v-if="store.app.navView=='AI'"/>
            </div>
        </div>
    </transition>
  </template>
  
  <style scoped>
    .nav{
        color:var(--fontColor);
        background-color: var(--backgroundColor);
        min-width:41px;
        max-width:calc(100% - 100px);
        height:calc(100%  - 2px);
        padding:0px;
        opacity: 1;
        transition-property: width, opacity;
        border-left: var(--borderColor) 1px solid;
        border-right: var(--borderColor) 1px solid;
        user-select: none;
        display: flex;
        flex-direction: row;
        -webkit-app-region: drag;
        z-index:10;
    }
    .panelUnactive{
        max-width:0px;
        width:0px;
        height:0px;
        padding:0px;
        opacity: 0;
        transition-property: width, opacity;
        transition: 0.2s ease-out;
        user-select: none;
    }
    .tabs{
        width:40px;
        height:100%;
        display: flex;
        flex-direction: column;
        border-right: var(--borderColor) 1px solid;
        overflow-y: auto;
    }
    .tabs::-webkit-scrollbar {
        display: none;
    }
    .tab{
        -webkit-app-region: no-drag;
        padding-left:12px;
        padding-top:13px;
        padding-bottom:13px;
        padding-right:7px;
    }
    i{
        width:calc(100% - 20px);
    }
    .tabActive i{
        padding-left:9px;
    }
    .content{
        height:100%;width:calc(100% - 40px);
        -webkit-app-region: no-drag;
    }
    .active{
        border-left:3px solid var(--fontActiveColor);
        padding-left:9px;
        background-color: var(--menuColor);
        color:var(--fontActiveColor);
    }
  </style>
  
  