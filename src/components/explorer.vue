<template>
  <div class="main">
    <div style="width:calc(100%);height:40px;background-color: var(--menuColor);line-height:40px;-webkit-app-region: drag;border-bottom:1px solid var(--borderColor) ;user-select: none;">
      <div style="-webkit-app-region: drag;">
        <div class="App_tabs" ref="tabsContainer" @wheel="handleWheel">
          <div class="button" style="z-index: 999;position:absolute;top:1px;margin-left:0px;margin-right:3px;background-color: var(--menuColor);" @click="store.sidePanel=!store.sidePanel;store.resize()">
            <i class="fa fa-home" v-if="store.sidePanel"></i>
            <i class="fa fa-angle-double-left" v-if="!store.sidePanel"></i>
          </div>
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
          <div class="App_tab" v-for="(item,index) in store.data" :key="index" :class="{ 'active': store.index === index }" @click="selectFile(index)">
              <i :class="store.icon(item.extension)"></i> {{item.label}}&nbsp;
              <div class="control">
                <span><i class="fa fa-times" @click="close($event,index)"></i></span>
              </div>
          </div>
        </div>
      </div>
    </div>
    <div class="explorer" :style="{flexDirection:store.UI.layout=='horizontal'?'row':'column'}">
      <view_file v-if="store.view.includes('文件')&&store.root!=''" />
      <view_kanban v-if="store.view.includes('看板')&&store.root!=''" />
      <view_graph v-if="store.view.includes('图谱')&&store.root!=''" />
      <view_gantt v-if="store.view.includes('甘特')&&store.root!=''" />
      <view_date v-if="store.view.includes('月历')&&store.root!=''" />
      <view_year v-if="store.view.includes('年历')&&store.root!=''" />
      <view_map v-if="store.view.includes('地图')&&store.root!=''" />
      <view_table v-if="store.view.includes('表格')&&store.root!=''" />
      <md_edit v-if="store.view.includes('编辑')&&store.index!=null" :style="{borderLeft:store.UI.layout=='horizontal'?'1px solid var(--borderColor)':'',borderTop:store.UI.layout=='vertical'?'1px solid var(--borderColor)':''}"/>
      <md_read v-if="store.view.includes('浏览')&&store.index!=null" :style="{borderLeft:store.UI.layout=='horizontal'?'1px solid var(--borderColor)':'',borderTop:store.UI.layout=='vertical'?'1px solid var(--borderColor)':''}"/>
      <md_mind v-if="store.view.includes('导图')&&store.index!=null" :style="{borderLeft:store.UI.layout=='horizontal'?'1px solid var(--borderColor)':'',borderTop:store.UI.layout=='vertical'?'1px solid var(--borderColor)':''}"/>
      <md_ppt v-if="store.view.includes('演示')&&store.index!=null" :style="{borderLeft:store.UI.layout=='horizontal'?'1px solid var(--borderColor)':'',borderTop:store.UI.layout=='vertical'?'1px solid var(--borderColor)':''}"/>
      <empty v-if="store.view.length==0||store.root==''" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {usestore} from '../store'
import view_file from './view/view_file.vue'
import view_kanban from './view/view_kanban.vue'
import view_graph from './view/view_graph.vue'
import view_gantt from './view/view_gantt.vue'
import view_date from './view/view_date.vue'
import view_year from './view/view_year.vue'
import view_map from './view/view_map.vue'
import view_table from './view/view_table.vue'
import md_read from './view/md_read.vue'
import md_mind from './view/md_mind.vue'
import md_edit from './view/md_edit.vue'
import md_ppt from './view/md_ppt.vue'
import empty from './view/empty.vue'

const store = usestore();
const tabsContainer = ref<HTMLElement | null>(null);

// 选择文件
const selectFile = function(index: any) {
  store.index = index;
  // 变更path
  if (store.data[store.index].type == 'file') {
    store.path = store.data[store.index].path.substring(0, store.data[store.index].path.lastIndexOf('\\'));
  } else {
    store.path = store.data[store.index].path;
  }
};

// 关闭文件
const close = function(event: any, index: any) {
  event.stopPropagation();
  // 删除页面序数
  store.data.splice(index, 1);
  // 页面清空时
  if (store.data.length == 0) {
    store.index = null;
    // store.resize() //触发缩放
  } else {
    // 如果关闭的是当前页面，则打开第一项页面
    if (store.index == index) store.index = 0;
  }
};

// 处理鼠标滚轮事件
const handleWheel = function(event: WheelEvent) {
  if (tabsContainer.value) {
    // 根据滚轮方向调整滚动位置
    tabsContainer.value.scrollLeft += event.deltaY;
    event.preventDefault(); // 阻止默认的垂直滚动行为
  }
};
</script>

<style scoped>
.App_tabs {
  white-space: nowrap;
  height: 33px;
  padding-top: 8px;
  padding-left: 5px;
  padding-right: 5px;
  overflow-x: auto;
  overflow-y: hidden;
  border-radius: 5px 5px 0px 0px;
  transition: 0.2s;
  line-height: 20px;
  scroll-behavior: smooth; /* 平滑滚动 */
}
.App_tabs::-webkit-scrollbar {
  display: none;
}
.App_tab {
  -webkit-app-region: no-drag;
  background-color: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 5px 5px 0px 0px;
  height: 31px;
  width: fit-content;
  white-space: normal;
  display: inline-block;
  user-select: none;
  padding: 0px 10px;
  line-height: 30px;
}
.active {
  background-color: var(--backgroundColor);
  border-bottom: 1px solid var(--backgroundColor);
}
.control {
  position: relative;
  float: right;
  opacity: 0;
  transition: 0.2s;
  padding-top: 3px;
  line-height: 24px;
}
.App_tab:hover .control {
  opacity: 1;
}
.explorer {
  display: flex;
  justify-content: space-between;
  width: 100%;
  height: calc(100% - 40px);
}
</style>