<script setup lang="ts">

  import {usestore} from '../../store'
  import { nextTick, ref ,Ref,onMounted , onBeforeUnmount,watch} from 'vue'
  import file from '../../../electron/file'

  //获取数据
  const store=usestore()

  //背景长宽
  let bgheight = ref(0)
  let bgwidth = ref(0)
  let svgWidth = ref(0)
  let svgHeight = ref(0)
  //分类模式，不分类时为紧凑，分类时为属性名称
  let type= ref("")
  //背景矩形数组
  let rects : Ref<any[]> = ref([])
  //数据
  let data : Ref<any[]> = ref([])
  const getData=async function(){
    if(store.app.environment!="web"){
      //如果不是云端环境
      if(store.app.files.length==0){
        //如果没有打开标签
        data.value=file.scanDeepFile(store.app.path,1,0)
      }else{
        //如果打开了标签
        if(!store.app.files[store.app.fileIndex].cloud){
          //如果是本地的，判断扫描模式
          data.value=file.scanDeepFile(store.app.path,1,0)
        }else{
          let str = await store.getCloudData("",1,0) as any 
          let t = JSON.parse(str)
          data.value=t.nodes
        }
      }
    }else{
      //如果是云端环境
      let str = await store.getCloudData("",1,0) as any 
      let t = JSON.parse(str)
      data.value=t.nodes
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

    let endWidth=0
    //布局边距
    let margin = 5
    let width=200
    rects.value=[]
    if(type.value==""){
      let x=margin
      let y=margin
      for(let i=0;i<data.value.length;i++){
        //本节点赋值
        data.value[i].x=x
        data.value[i].y=y
        //下一节点的位置
        if(i!=data.value.length-1){
          //本节点的宽度和高度
          let nowheight=document.getElementById("node"+data.value[i].id)!.clientHeight
          //下一个节点的宽度和高度
          let nextheight=document.getElementById("node"+data.value[i+1].id)!.clientHeight
          let nexty = y + nowheight +margin
          //如果下一个节点容不下
          if(nexty>bgheight.value-nextheight-margin){
            x=x+width+margin
            y=margin
          }else{
            y=nexty
          }
        }
      }
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
        if(store.app.viewSet.board=="状态"){
          if(labelArray[i]==true){
            labelArray[i]="已完成"
          }else if(labelArray[i]==false){
            labelArray[i]="未完成"
          }
        }else if(store.app.viewSet.board=="标签"){
          if(labelArray[i]==""){
            labelArray[i]="无标签"
          }
        }
      }

      //计算位置，方案1
      let initY=margin+24
      let initX=0

      let y = initY //当前y
      let x = initX+margin //当前x
      
      for(let j = 0; j < nodeArray.length; j++){
        let maxY=0
        initX =initX+margin
        let rectdata={
          x:x,
          y:margin,
          width:0,
          height:0,
          title:labelArray[j],
          count:0,
        }
        for (let i = 0; i < nodeArray[j].length; i++) {
          //寻找当前节点信息
          let index = -1
          for(let a = 0;a<data.value.length;a++){
            if(data.value[a].id==nodeArray[j][i]){
              index=a
              break
            }
          }
          //如果找到了当前节点
          if(index!=-1){
            //设置节点位置
            data.value[index].x=x+margin
            data.value[index].y=y
            //获取当前节点高度
            let nowheight=document.getElementById("node"+data.value[index].id)!.clientHeight
            //计算下一节点应在的位置
            let nextY = y + nowheight + margin

            //如果到达最后一个点，计算矩形位置后即可返回
            if(i == nodeArray[j].length-1){
              maxY=Math.max(maxY,nextY)
              break
            }
            //寻找下一节点高度
            let indexNext = -1
            for(let a = 0;a<data.value.length;a++){
              if(data.value[a].id==nodeArray[j][i+1]){
                indexNext=a
                break
              }
            }
            let nextheight =0
            if(indexNext!=-1){
              nextheight=document.getElementById("node"+data.value[indexNext].id)!.clientHeight
            }
            
            //如果下一个节点在本列容不下
            if(nextY>bgheight.value-nextheight-margin){
              //记录最大背景矩形的高度
              maxY=Math.max(maxY,nextY)
              //换行并重置绘制高度
              x=x+width+margin
              y=initY
              //如果到达最后一个节点，不用换行
              if(i==nodeArray[j].length-1){x=x-125}
            }else{
              y=nextY
              if(y>=maxY){maxY=y}
            }
          }
        }
        //计算包裹矩形的位置
        rectdata.height=maxY-margin
        rectdata.width=x-rectdata.x+width+2*margin
        rects.value.push(rectdata)
        //计算下一个方块的起始位置
        //方案1：遇见下一组就换到下一列
        x=x+width+3*margin
        y=initY

        endWidth=x+width+3*margin
      }

      //方案2：分组矩形紧凑放到下面
      /**
      let initY=margin+24
      let initX=0

      let y = initY //当前y
      let x = initX+margin //当前x
      
      for(let j = 0; j < nodeArray.length; j++){
        let maxY=0
        initX =initX+margin
        let rectdata={
          x:x,
          y:y-24,
          width:0,
          height:0,
          title:labelArray[j],
          count:0,
        }
        //如果下一个矩形y超出，重新定义rectdata
        if(y+100>bgheight.value){
          rectdata={
            x:x+width+3*margin,
            y:margin,
            width:0,
            height:0,
            title:labelArray[j],
            count:0,
          }
        }
        
        for (let i = 0; i < nodeArray[j].length; i++) {
          //寻找当前节点信息
          let index = -1
          for(let a = 0;a<data.value.length;a++){
            if(data.value[a].id==nodeArray[j][i]){
              index=a
              break
            }
          }
          //如果找到了当前节点
          if(index!=-1){
            //设置节点位置
            data.value[index].x=x+margin
            data.value[index].y=y
            //获取当前节点高度
            let nowheight=document.getElementById("node"+data.value[index].id)!.clientHeight
            //计算下一节点应在的位置
            let nextY = y + nowheight + margin

            //如果到达最后一个点，计算矩形位置后即可返回
            if(i == nodeArray[j].length-1){
              maxY=Math.max(maxY,nextY)
              break
            }
            //寻找下一节点高度
            let indexNext = -1
            for(let a = 0;a<data.value.length;a++){
              if(data.value[a].id==nodeArray[j][i+1]){
                indexNext=a
                break
              }
            }
            let nextheight =0
            if(indexNext!=-1){
              nextheight=document.getElementById("node"+data.value[indexNext].id)!.clientHeight
            }
            
            //如果下一个节点在本列容不下
            if(nextY>bgheight.value-nextheight-margin){
              //记录最大背景矩形的高度
              maxY=Math.max(maxY,nextY)
              //换行并重置绘制高度
              x=x+width+margin
              y=initY
              //如果到达最后一个节点，不用换行
              if(i==nodeArray[j].length-1){x=x-125}
            }else{
              y=nextY
              if(y>=maxY){maxY=y}
            }
          }
        }
        //计算包裹矩形的位置
        rectdata.height=y+35+margin-rectdata.y
        rectdata.width=x-rectdata.x+width+2*margin
        rects.value.push(rectdata)
        //计算下一个方块的起始位置
        x=x
        y=y+4*margin+50

        endWidth=x+width+3*margin
      }
      */
      /** */
    }
    svgWidth.value=endWidth
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
  const resize = async function(){
    getData()
    Draw()
  }
  //计算style函数
  const style=(item:any)=>{
    return {
      'left':item.x+'px',
      'top':item.y+'px',
      'width':200+'px',
      'max-width':'calc(100% - ' +2*store.app.viewSet.margin+ 'px)',
      'background-color':item.attributes.颜色!=undefined?item.attributes.颜色:'var(--menuColor)'
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
    if(store.app.environment!="web"){
      if(!data.isFolder&&(data.type==".md"||data.type==""||data.type==".html")){
        let content=file.getFile(data.fullPath) 
        data = {...data,content}
      }
      store.addTab(data)
    }else{
      console.log("开发中")
    }
  }
  watch(()=>store.app.storePath, (newValue, oldValue) => {
    getData()
    Draw()
  })
  watch(()=>store.app.path, (newValue, oldValue) => {
    getData()
    Draw()
  })
  onMounted(() => {
    window.addEventListener('resize', resize)
    getData()
    Draw()
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize)
  })
</script>

<template >
  <!--看板视图-->
  <div class="bg">
    <div class="menu">
        <ul>
          <li @click="store.pathBack()">
            <i class="fa fa-arrow-up"></i>
          </li>
          <li><i class="fa fa-cubes">&nbsp; {{ type }}</i>
            <ul>
              <li @click="type='';store.resize()" :class="[type==''?'active':'']">
                不进行分类
              </li>
              <li v-for="(item,index) in attributes" @click="type=item;store.resize()">
                {{ item }}
              </li>
            </ul>
          </li>
          <li>
            {{store.app.path==""?"根目录":store.app.path}}
          </li>
        </ul>
    </div>
    <div class="panel scoll" id="panel" :style="{overflowX: store.app.viewSet.content?'hidden':'visible'}">
      <!--节点-->
      <div class="node" v-for="(item,index) in data" :key="index" :item="item" :index="index" :id="'node'+item.id" :style="style(item)" @dblclick="open(item)">
        <!--非图片标题-->
        <div
          v-if="!(item.type=='jpeg'||item.type=='jpg'||item.type=='png'||item.type=='webp')"
          class="title">
          <span v-if="!store.app.viewSet.content">
            <i :class="store.icon(item.type)" style="position: relative;color:var(--fontColor)"></i>&nbsp;
          </span>
          <span v-if="!store.app.UI.extension">{{item.name}}</span>
          <span v-if="store.app.UI.extension">{{item.fullName}}{{ item.attributes.颜色 }}</span>
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
          :y="21"
          style="text-anchor: middle;fill:var(--fontColor);"
        >{{getTitle(item.title)}}
        </text>
      </svg>
      <!--分类方块，方案2-->
      <!--
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
          :y="item.y+21"
          style="text-anchor: middle;fill:var(--fontColor);"
        >{{getTitle(item.title)}}
        </text>
      </svg>
      -->
    </div>
  </div>
  
</template>

<style scoped>
  .bg{
    z-index:0;
    position:relative;
    width: 100%;
    height: calc(100% - 1px);
    overflow: hidden;
    flex:2;
    border-bottom:1px solid var(--borderColor);
  }
  .menu{
    position: relative;
    width:100%;
    height:25px;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
  }
  .menu ul {
    position:absolute;
    margin: 0px;
    padding:0px;
    padding-top:0px;
    z-index:99;
    display:block;
    white-space:nowrap;
  }
  
  .menu ul li {
    position: relative;
    height:19px;
    cursor:pointer;
    line-height:18px;
    white-space:nowrap;
    padding:3px;
    padding-right:10px;
    padding-left: 10px;
    width:fit-content;
    display:inline-block;
    text-align: left;
  }
  .menu li:hover {
    background:var(--menuActiveColor);
  }
  .menu li>ul{
    left: 0px;
    top: 25px;
    width:fit-content;
    min-width:70px;
    background-color:var(--menuColor);
    display: none;
    box-shadow:2px 2px 2px rgba(0, 0, 0, .6);
    border:1px solid var(--borderColor);
  }
  .menu li:hover>ul{
    display: block;
  }
  .menu li>ul>li{
    list-style-type:none;
    float:left;
    width:calc(100% - 10px);
    padding:5px;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
  .panel{
    position: absolute;
    width: 100%;
    height: calc(100% - 27px);
    overflow: auto;
  }
  #svg{
    z-index:-10;
    float:left;
    position:absolute;
    height:calc(100%);
    user-select: none;
  }
  
  .node {
    position: absolute;
    word-wrap: break-word;
    transition: 0.2s;
    max-width: calc(100% - 10px);
    border: 1px solid var(--borderColor);
    border-radius: 3px ;
  }
  .title{
    position: relative;
    width:calc(100% - 15px);
    padding: 5px;
    padding-left: 10px;
    margin: 0px;
    margin-bottom: -3px;
    overflow:hidden;
    display: inline-block;
    user-select: none;
    border-radius:3px;
    color:var(--fontColor)
  }
  .title span{
    width:fit-content;
    max-width:calc(100% - 20px);
    word-break:keep-all;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .state{
    position:absolute;
    color:var(--fontActiveColor);
    top:8px;
    right:8px;
    font-size: 12px;
  }
</style>
