<script setup lang="ts">
  import { usestore } from '@/store'
  import { nextTick, ref ,Ref,onMounted , onBeforeUnmount,watch} from 'vue'

  //获取数据
  const store=usestore()

  //背景长宽
  let bgheight = ref(0)
  let bgwidth = ref(0)
  let svgWidth = ref(0)
  let svgHeight = ref(0)
  //分类模式，不分类时为紧凑，分类时为属性名称
  let type= ref("")
  let kanban = ref("状态")
  //背景矩形数组
  let rects : Ref<any[]> = ref([])
  //数据
  let data : Ref<any[]> = ref([])
  const getData=async function(){
    //如果不是云端环境
    if(store.data.length==0){
      //如果没有打开标签
      try {
        const list:any = await window.ipcRenderer.invoke("getFiles",store.root,1)
        setKanbanData(list)
      } catch (error) {
        // 处理错误
        console.error(error);
      }
    }else{
      try {
        const list:any = await window.ipcRenderer.invoke("getFiles",store.root,1)
        setKanbanData(list)
      } catch (error) {
        // 处理错误
        console.error(error);
      }
    }
    getAttributes()
  }
  const Draw=async function(){
    await nextTick()
    //获取布局长宽
    bgheight.value=document.getElementById("panel")!.getBoundingClientRect().height
    bgwidth.value=document.getElementById("panel")!.getBoundingClientRect().width
    //设置svg高度
    svgHeight.value=bgheight.value

    //布局边距
    let margin = 8
    let minCardWidth = 180    // 卡片最小宽度，用于计算列数
    rects.value=[]
    if(type.value==""){
      // 无分类 - 使用网格布局，卡片铺满行宽
      let availWidth = bgwidth.value - 2 * margin
      let cols = Math.max(1, Math.floor(availWidth / (minCardWidth + margin)))
      // 卡片实际宽度 = (可用宽度 - 间距) / 列数
      let cardWidth = (availWidth - (cols - 1) * margin) / cols
      let rowHeight = 48
      for(let i = 0; i < data.value.length; i++){
        let col = i % cols
        let row = Math.floor(i / cols)
        data.value[i].x = margin + col * (cardWidth + margin)
        data.value[i].y = margin + row * rowHeight
        data.value[i].cardWidth = cardWidth
      }
      let totalRows = Math.ceil(data.value.length / cols)
      svgHeight.value = margin + totalRows * rowHeight + margin
    }else{
      //节点分类
      let nodeArray = new Array();
      //统计标签数组
      let labelArray = []
      let ifundefined=false
      for (let i = 0; i <= data.value.length - 1; i++) {
        //遍历所有节点，记录有哪些标签
        let temp = data.value[i].attributes
        //按搜索到的属性分组
        if(temp[type.value]!=undefined){//判断文件是否有属性
          if(labelArray.indexOf(temp[type.value])==-1){
            labelArray.push(temp[type.value])
            nodeArray.push(new Array())
          }
        }else{
          ifundefined=true
        }
      }
      if(ifundefined){
        labelArray.push(undefined)
        nodeArray.push(new Array())
      }
      //按标签分组
      for (let i = 0; i <= data.value.length - 1; i++) {
        let temp = data.value[i].attributes
        nodeArray[labelArray.indexOf(temp[type.value])].push(i)
      }
      //标签重新定义
      for (let i = 0; i <= labelArray.length - 1; i++) {
        if(kanban.value=="状态"){
          if(labelArray[i]==true){
            labelArray[i]="已完成"
          }else if(labelArray[i]==false){
            labelArray[i]="未完成"
          }
        }else if(kanban.value=="标签"){
          if(labelArray[i]==""){
            labelArray[i]="无标签"
          }
        }
      }
      //计算位置 - 垂直网格布局，每个类别从上到下排布
      let margin = 8           // 分类框之间的间距
      let pad = 8             // 分类框内边距（卡片与边框的距离）
      let minCardWidth = 180   // 卡片最小宽度，用于计算列数
      let rowHeight = 48       // 每个节点行高

      // 卡片在分类框内的可用宽度
      let availWidth = bgwidth.value - 2 * margin - 2 * pad
      // 计算每行可放的节点数
      let cols = Math.max(1, Math.floor(availWidth / (minCardWidth + margin)))
      // 卡片实际宽度 = (可用宽度 - 间距) / 列数
      let cardWidth = (availWidth - (cols - 1) * margin) / cols
      let totalHeight = margin

      for(let j = 0; j < nodeArray.length; j++){
        let groupY = totalHeight
        
        // 计算组内节点需要多少行
        let items = nodeArray[j].length
        let rows = Math.max(1, Math.ceil(items / cols))
        let groupHeight = margin + 16 + rows * rowHeight + margin

        let rectdata = {
          x: margin,
          y: groupY,
          width: bgwidth.value - 2 * margin,
          height: groupHeight,
          title: labelArray[j] != undefined ? labelArray[j].toString() : '未定义',
          count: 0,
        }
        
        for (let i = 0; i < items; i++) {
          let index = -1
          for(let a = 0; a < data.value.length; a++){
            if(a == nodeArray[j][i]){
              index = a
              break
            }
          }
          if(index != -1){
            let col = i % cols
            let row = Math.floor(i / cols)
            data.value[index].x = margin + pad + col * (cardWidth + margin)
            data.value[index].y = groupY + margin + 24 + row * rowHeight
            data.value[index].cardWidth = cardWidth
          }
        }
        
        rects.value.push(rectdata)
        totalHeight += groupHeight + margin
      }
      
      svgHeight.value = totalHeight
    }
    svgWidth.value = bgwidth.value
    
    // 绘制完成后检查是否需要滚动条
    setTimeout(checkScrollbar, 50)
  }
  
  let attributes=ref([]) as any //有哪些属性
  //获取节点属性
  const getAttributes = function(){
    // 获取所有属性
    let allProps = [] as any
    data.value.forEach((obj: { attributes: any }) => {
      const props = Object.keys(obj.attributes)
      for(let i = 0;i<props.length;i++){
        if(!/^[A-Za-z]+$/.test(props[i])){
          allProps.push(props[i])
        }
      }
    })
    // 去除重复属性
    let result = allProps.filter((obj:any, index:any, self:any) => {
      // 检查当前对象是否在之前的对象中出现过
      return (
        index ===
        self.findIndex((o:any) => {
          return JSON.stringify(o) === JSON.stringify(obj)
        })
      )
    })
    attributes.value = result
  }
  
  // 检查面板高度
  const checkScrollbar = () => {
    const panel = document.getElementById('panel')
    if (!panel) return
    // 让 CSS 的 overflow-y: auto 控制滚动
  }
  
  const resize = async function(){
    getData()
  }

  // 看板搜索：过滤卡片并重新布局
  const kanbanQuery = ref('')
  let kanbanTimer: any = null
  let fullKanban: any[] = []
  const setKanbanData = function (arr: any[]) {
    fullKanban = arr || []
    const q = kanbanQuery.value.trim().toLowerCase()
    data.value = q ? fullKanban.filter((it: any) => String(it.label || '').toLowerCase().includes(q)) : fullKanban
    Draw()
  }
  const applyKanbanSearch = function () {
    const q = kanbanQuery.value.trim().toLowerCase()
    data.value = q ? fullKanban.filter((it: any) => String(it.label || '').toLowerCase().includes(q)) : fullKanban
    Draw()
  }
  watch(kanbanQuery, () => {
    clearTimeout(kanbanTimer)
    kanbanTimer = setTimeout(applyKanbanSearch, 150)
  })
  //计算style函数
  const style=(item:any)=>{
    return {
      'left':item.x+'px',
      'top':item.y+'px',
      'width':(item.cardWidth || 200)+'px',
      'max-width':'calc(100% - ' +2*1+ 'px)',
      'background-color':item.attributes!=undefined?(item.attributes.颜色!=undefined?item.attributes.颜色:'var(--menuColor)'):''
    }
  }
  const getTitle=(title:any)=>{
    if(title==undefined){
      return '未定义'
    }else if(title instanceof Date){
      return store.StampToDate(title)
    }else if(typeof title == 'string'){
      const chineseRegex = /[\u4e00-\u9fa5]/
      if (chineseRegex.test(title)) {
        return title.substring(0, 14)
      }else{
        return title.substring(0, 25)
      }
    }
  }
  const open=(data:any)=>{
    console.log(data)
    store.openFileByMode(data)
    if(!data.isFolder&&(data.extension==".md"||data.extension==""||data.extension==".html")){
      //let content= window.ipcRenderer.invoke("",data.path)
      //data = {...data,content}
    }
  }
  
  watch(()=>store.root, (newValue, oldValue) => {
    getData()
  })
  onMounted(() => {
    window.addEventListener('resize', resize)
    getData()
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize)
  })
</script>

<template>
  <!--看板视图-->
  <div class="bg">
    <!-- 看板内容区域 -->
    <div class="panel" id="panel">
      <!--节点-->
      <div class="node" v-for="(item,index) in data" :key="index" :item="item" :index="index" :id="'node'+item.id" :style="style(item)" @dblclick="open(item)">
        <!--非图片标题-->
        <div
          v-if="!(item.extension=='jpeg'||item.extension=='jpg'||item.extension=='png'||item.extension=='webp')"
          class="title">
          <span>
            <i :class="store.icon(item.extension || item.type)" style="position: relative;color:var(--fontColor)"></i>&nbsp;
          </span>
          <span>{{item.label}}</span>
        </div>

        <!--状态-->
        <div class="state">
          <i class="fa fa-check" v-if="item.attributes.状态"></i>
        </div>
      </div>
      <!--分类方块，方案1-->
      <svg id="svg" v-if="rects.length>0" :width="svgWidth" :height="svgHeight">
        <rect
          v-for="(item,index) in rects"
          :x="item.x"
          :y="item.y"
          :width="item.width"
          :height="item.height"
          style="stroke-width:1;
          fill:var(--backgroundColor);
          stroke:var(--borderColor)"
        />
        <text
          v-for="(item,index) in rects"
          font-size="14"
          :x="item.x+item.width/2"
          :y="item.y+17"
          style="text-anchor: middle;fill:var(--fontActiveColor);"
        >{{getTitle(item.title)}}
        </text>
      </svg>
    </div>

    <!-- 底部状态栏：搜索 / 分类方式 / 返回上级 / 节点计数 -->
    <div class="kanban-statusbar">
      <div class="statusbar-search" @click.stop :title="store.locales=='zh'?'搜索卡片':'Search cards'">
        <i class="fa fa-search"></i>
        <input v-model="kanbanQuery" :placeholder="store.locales=='zh'?'搜索卡片…':'Search…'" @keydown.stop @keyup.esc="kanbanQuery=''"/>
        <i v-if="kanbanQuery" class="fa fa-times" @click="kanbanQuery=''" :title="store.locales=='zh'?'清除搜索':'Clear'"></i>
      </div>
      <span class="statusbar-sep"></span>
      <button class="statusbar-btn" @click="store.backPath()" :title="store.locales=='zh'?'返回上一级':'Go up'"><i class="fa fa-arrow-up"></i></button>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-tag"></i> {{ store.locales=='zh'?'分类':'Group' }}</span>
      <select class="statusbar-select" v-model="type" @change="store.resize()" :title="store.locales=='zh'?'分类方式':'Group by'">
        <option value="">{{ store.locales=='zh'?'不分类':'No Group' }}</option>
        <option v-for="a in attributes" :key="a" :value="a">{{ a }}</option>
      </select>
      <span class="statusbar-item status-cur" :title="type || (store.locales=='zh'?'不分类':'No Group')">{{ type || (store.locales=='zh'?'未分类':'Ungrouped') }}</span>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item"><i class="fa fa-file"></i> {{ data.length }} {{ store.locales=='zh'?'项':'items' }}</span>
      <button class="statusbar-btn" @click="store.resize()" :title="store.locales=='zh'?'刷新布局':'Refresh'"><i class="fa fa-refresh"></i></button>
    </div>
  </div>
</template>

<style scoped>
.bg {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
  box-sizing: border-box;
}

/* 看板内容区域 */
.panel {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  width: 100%;
  height: calc(100% - 24px);
  overflow-x: hidden;
  overflow-y: auto;
}

/* SVG 背景 */
#svg {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  user-select: none;
  z-index: 0;
}

/* 滚动条样式 */
.panel::-webkit-scrollbar {
  width: 8px;
}
.panel::-webkit-scrollbar-track {
  background: transparent;
}
.panel::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, 0.3);
  border-radius: 4px;
}
.panel::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, 0.5);
}

/* 节点样式 */
.node {
  position: absolute;
  word-wrap: break-word;
  transition: 0.2s;
  max-width: calc(100% - 10px);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background-color: var(--menuColor);
  z-index: 1;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  padding: 6px 0;
}

.node:hover {
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
  border-color: var(--primaryColor);
}

.title {
  position: relative;
  width: calc(100% - 20px);
  padding: 4px 8px;
  margin: 0;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  user-select: none;
  border-radius: 4px;
  color: var(--fontColor);
  font-size: 13px;
  line-height: 1.4;
}

.title span {
  width: fit-content;
  max-width: calc(100% - 20px);
  word-break: keep-all;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  position: absolute;
  color: var(--fontActiveColor);
  top: 8px;
  right: 8px;
  font-size: 12px;
}

/* 右键菜单样式统一在 explorer.vue 中定义 */
/* 子菜单宽度覆盖 + 悬停桥接 */
.has-submenu .submenu {
  min-width: 120px;
}
.has-submenu::after {
  content: '';
  position: absolute;
  right: -12px;
  top: 0;
  width: 12px;
  height: 100%;
}

/* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
.kanban-statusbar{
  display:flex; align-items:center; gap:8px; flex-shrink:0;
  height:24px; box-sizing:border-box; padding:0 8px;
  font-size:12px; color:var(--fontColor);
  background-color:var(--menuColor);
  border-top:1px solid var(--borderColor);
  user-select:none; white-space:nowrap; overflow:hidden;
}
.kanban-statusbar .statusbar-item{ display:inline-flex; align-items:center; gap:4px; opacity:.85; }
.kanban-statusbar .statusbar-item i{ font-size:11px; opacity:.7; }
.kanban-statusbar .statusbar-spacer{ flex:1; }
.kanban-statusbar .statusbar-btn{
  margin:0; padding:0 6px; height:18px; border:none; border-radius:3px; background:transparent;
  color:var(--fontColor); font-size:12px; display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; opacity:.85; transition:background-color .15s; flex-shrink:0;
}
.kanban-statusbar .statusbar-btn:hover{ background:var(--menuActiveColor); opacity:1; }
.kanban-statusbar .statusbar-sep{ width:1px; height:14px; background:var(--borderColor); flex-shrink:0; }
.kanban-statusbar .statusbar-select{
  height:18px; border:1px solid var(--borderColor); border-radius:3px;
  background: var(--backgroundColor); color:var(--fontColor); font-size:11px; padding:0 4px;
  width:auto; min-width:56px; max-width:120px; outline:none; cursor:pointer; flex-shrink:0;
}
.kanban-statusbar .statusbar-select option{
  background: var(--backgroundColor); color: var(--fontColor);
}
.kanban-statusbar .status-cur{ color: var(--fontActiveColor); opacity: .9; }
.kanban-statusbar .statusbar-search {
  display: inline-flex; align-items: center; gap: 4px;
  height: 18px; padding: 0 6px; box-sizing: border-box;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); flex-shrink: 0;
}
.kanban-statusbar .statusbar-search i { font-size: 10px; opacity: 0.6; cursor: pointer; }
.kanban-statusbar .statusbar-search input {
  width: 120px; height: 100%; border: none; outline: none;
  background: transparent; color: var(--fontColor); font-size: 11px; padding: 0;
}
.kanban-statusbar .statusbar-search input::placeholder { color: var(--borderColor); }
</style>