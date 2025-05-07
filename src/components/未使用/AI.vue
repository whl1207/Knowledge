<template>
  <div class="main">
      <div class="header">
        <div class="button" style="background-color: var(--menuColor);" @click="store.sidePanel=!store.sidePanel;store.resize()">
          <i class="fa fa-home" v-if="store.sidePanel"></i>
          <i class="fa fa-angle-double-left" v-if="!store.sidePanel"></i>
        </div>
        <div style="-webkit-app-region: no-drag;">
          <select v-model="mode" style="width:calc(90px)">
            <option value="知识库">知识库</option>
            <option value="模型对比">模型对比</option>
            <option value="流程模式">流程模式</option>
          </select>
          <i class="fa fa-book" v-if="mode=='知识库'"></i>
          <i class="fa fa-columns" v-if="mode=='模型对比'"></i>
          <i class="fa fa-cubes" v-if="mode=='流程模式'"></i>
        </div>
      </div>
      <div class="explorer">
        <AI_kb v-if="mode=='知识库'"/>
        <AI_vs v-if="mode=='模型对比'"/>
        <AI_flow v-if="mode=='流程模式'"/>
      </div>
    </div>
</template>

<script setup lang="ts">
  import {ref} from 'vue'
  import {usestore} from '../../store'
  import AI_kb from './AI/AI_kb.vue'
  import AI_vs from './AI/AI_vs.vue'
  import AI_flow from './AI/AI_flow.vue'
  const store=usestore()
  let mode = ref('知识库')
</script>

<style scoped>
  .header{
    width: calc(100%);
    display: flex;
    background-color: var(--menuColor);
    -webkit-app-region: drag;
    display: flex;
    border-bottom: var(--borderColor) 1px solid;
  }
  .active{
    background-color:var(--backgroundColor);
    border-bottom:1px solid var(--backgroundColor);
  }
  .control{
    position: relative;
    float: right;
    opacity: 0;
    transition: 0.2s;
    padding-top:3px;
    line-height: 24px;
  }
  .App_tab:hover .control{
    opacity: 1;
  }
  .explorer{
    display: flex;
    justify-content: space-between;
    width:100%;
    height:calc(100% - 41px)
  }
</style>