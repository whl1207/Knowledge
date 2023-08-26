<script setup lang="ts">
  import md from '../Object/explorer/md.vue'
  import mindmap from '../Object/md/mindmap.vue'
  import presentation from '../Object/md/presentation.vue'
  import atlas from '../Domain/atlas.vue'
  import board from '../Domain/board.vue'
  import gantt from '../Domain/gantt.vue'
  import calendar from '../Domain/calendar.vue'

  import { usestore } from '../../store'
  import { onBeforeUnmount,nextTick} from 'vue'
  
  const store = usestore()

  //固定在右下角
  const LB=() => {
    const dragDom=document.getElementById("miniView")!
    dragDom.style.top=""
    dragDom.style.left=""
  }

  //取消小窗，放进主视图
  const pin=() => {
    for(let i=0;i<store.app.miniView.length;i++){
      switch(store.app.miniView[i])
      {
        case "浏览":
          toggleObjectView("浏览")
          break;
        case "导图":
          toggleObjectView("导图")
          break;
        case "演示":
          toggleObjectView("演示")
          break;
        case "图谱":
          toggleDomainView("图谱")
          break;
        case "看板":
          toggleDomainView("看板")
          break;
        case "日历":
          toggleDomainView("日历")
          break;
        case "时间":
          toggleDomainView("时间")
          break;
        case "甘特":
          toggleDomainView("甘特")
          break;
        default:
          
      }
    }
    store.app.miniView=[]
  }
//切换视图
const toggleObjectView=async function(str:string){
    if(store.app.objectView.indexOf(str)==-1){
      store.app.objectView[store.app.objectView.length]=str
    }else{
      store.app.objectView.splice(store.app.objectView.indexOf(str),1)
    }
    store.resize() //触发缩放
  }
  const toggleDomainView=async function(str:string){
    if(store.app.domainView.indexOf(str)==-1){
      store.app.domainView[store.app.domainView.length]=str
    }else{
      store.app.domainView.splice(store.app.domainView.indexOf(str),1)
    }
    store.resize() //触发缩放
  }
  const sty = (function () {
    if ((document.body as any).currentStyle) {
      // 在ie下兼容写法
      return (dom: any, attr: any) => dom.currentStyle[attr]
    }
    return (dom: any, attr: any) => getComputedStyle(dom, null)[attr]
  })()

  const drag=(e: any) => {
    const dragDom=document.getElementById("miniView")!
    const dialogHeaderEl=dragDom.querySelector('.title')!
    console.log()
    // 鼠标按下，计算当前元素距离可视区的距离
    const disX = e.clientX - (dialogHeaderEl as HTMLDivElement).offsetLeft
      const disY = e.clientY - (dialogHeaderEl as HTMLDivElement).offsetTop
      const screenWidth = document.body.clientWidth // body当前宽度
      const screenHeight = document.documentElement.clientHeight // 可见区域高度(应为body高度，可某些环境下无法获取)
 
      const dragDomWidth = dragDom.offsetWidth // 对话框宽度
      const dragDomheight = dragDom.offsetHeight // 对话框高度
 
      const minDragDomLeft = dragDom.offsetLeft
      const maxDragDomLeft = screenWidth - dragDom.offsetLeft - dragDomWidth
 
      const minDragDomTop = dragDom.offsetTop
      const maxDragDomTop = screenHeight - dragDom.offsetTop - dragDomheight
 
      // 获取到的值带px 正则匹配替换
      let styL = sty(dragDom, 'left')
      // 为兼容ie
      if (styL === 'auto') styL = '0px'
      let styT = sty(dragDom, 'top')
 
      // console.log(styL)
      // 注意在ie中 第一次获取到的值为组件自带50% 移动之后赋值为px
      if (styL.includes('%')) {
        styL = +document.body.clientWidth * (+styL.replace(/%/g, '') / 100)
        styT = +document.body.clientHeight * (+styT.replace(/%/g, '') / 100)
      } else {
        styL = +styL.replace(/px/g, '')
        styT = +styT.replace(/px/g, '')
      }
 
      document.onmousemove = function (e) {
        // 通过事件委托，计算移动的距离
        let left = e.clientX - disX
        let top = e.clientY - disY
        // 边界处理
        if (-(left) > minDragDomLeft) {
          left = -(minDragDomLeft)
        } else if (left > maxDragDomLeft) {
          left = maxDragDomLeft
        }
 
        if (-(top) > minDragDomTop) {
          top = -(minDragDomTop)
        } else if (top > maxDragDomTop) {
          top = maxDragDomTop
        }
 
        // 移动当前元素
        dragDom.style.cssText += `;left:${left + styL}px;top:${top + styT}px;`
      }
 
      document.onmouseup = function (e: any) {
        document.onmousemove = null
        document.onmouseup = null
      }
      return false
  }
  
  onBeforeUnmount(() => {})
</script>

<template>
  <div id="miniView" class="miniView " v-if="store.app.miniView.length>0&&store.app.files.length>0">
    <div class="title" @mousedown="drag">
      <div class="left">
        <i @click="store.app.miniView=['浏览']" class="fa fa-book"></i>
        <i @click="store.app.miniView=['导图']" class="fa fa-map-o"></i>
        <i @click="store.app.miniView=['演示']" class="fa fa-television"></i>
        <i @click="store.app.miniView=['图谱']" class="fa fa-xing"></i>
        <i @click="store.app.miniView=['看板']" class="fa fa-list-ul"></i>
        <i @click="store.app.miniView=['日历']" class="fa fa-calendar-o"></i>
        <i @click="store.app.miniView=['时间']" class="fa fa-clock-o"></i>
        <i @click="store.app.miniView=['甘特']" class="fa fa-list-alt"></i>
      </div>
      <div class="right">
        <i @click="pin()" class="fa fa-map-pin"></i>
        <i @click="LB()" class="fa fa-chevron-down"></i>
        <i @click="store.app.miniView=[];" class="fa fa-times"></i>
      </div>
      
    </div>
    <div class="content resize">
      <template v-for="(item,index) in store.app.miniView" :key="index">
        <md v-if="item=='浏览'"/>
        <mindmap v-if="item=='导图'"/>
        <board v-if="item=='看板'"/>
        <atlas v-if="item=='图谱'"/>
        <gantt v-if="item=='甘特'" />
        <calendar v-if="item=='日历'" />
        <presentation v-if="item=='演示'" :key="store.app.fileIndex"/>
      </template>
    </div>
  </div>
</template>

<style scoped>
  .miniView{
    position:absolute;
    right:10px;
    bottom:10px;
    min-width:185px;
    width:fit-content;
    height:fit-content;
    overflow: hidden;
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    z-index:10;
    border-radius: 3px;
  }
  i{
    width:20px
  }
  .title{
    width:100%;
    height:25px;
    overflow: hidden;
    background-color: var(--menuColor);
    border-bottom: 1px solid var(--borderColor);
    text-align: center;
  }
  .left{
    position: absolute;
    left:5px
  }
  .right{
    position: absolute;
    right:5px
  }
  .content{
    width:400px;
    height:250px;
    min-width:185px;
    min-height:120px;
    max-width:100vw;
    max-height:100vh;
  }
  .resize{
    resize:both;
    overflow: hidden;
  }
  .resize::-webkit-scrollbar {
    width: 5px; height: 5px;
  }
</style>