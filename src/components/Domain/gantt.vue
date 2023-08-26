<script setup lang="ts">

  import {usestore} from '../../store'
  import { ref,reactive,onMounted,onBeforeUnmount,watch,nextTick} from 'vue'
  import {gantt} from 'dhtmlx-gantt'
  import "dhtmlx-gantt/codebase/dhtmlxgantt.css"
  import file from '../../../electron/file'
  //获取数据
  const store=usestore()
  //解构数据
  const ganttdom = ref(null) as any
  const contextMenu = ref(null) as any
  const showContextMenu = ref(false)
  const id = ref("")
  let data=reactive({
    "tasks": [] as any,
    "links": []
  })
  let deep=ref(1)
  let markertoday = ref(null) as any
  var zoomConfig = {
    levels: [
      /** 暂时没必要
      {
         name:"1hour", // 添加1小时级别
         scale_height: 50,
         min_column_width: 40,
         scales:[
            {unit: "day", step: 1, format: "%M %d 日"},
            {unit: "hour", step: 2, format: "%H:%i"}
         ]
      },
      {
         name:"hour", // 添加6小时级别
         scale_height: 50,
         min_column_width: 40,
         scales:[
            {unit: "day", step: 1, format: "%M %d 日"},
            {unit: "hour", step: 6, format: "%H:%i"}
         ]
      }, */
      {
        name:"day",
        scale_height: 27,
        min_column_width:80,
        scales:[
            {unit: "day", step: 1, format: "%M %d 日"}
        ]
      },
      {
         name:"week",
         scale_height: 50,
         min_column_width:50,
         scales:[
          {unit: "week", step: 1, format: function (date:any) {
           var dateToStr = gantt.date.date_to_str("%M %d 日");
           var endDate = gantt.date.add(date, 6, "day");
           var weekNum = gantt.date.date_to_str("%W")(date);
           return "第" + weekNum + "周, " + dateToStr(date) + " - " + dateToStr(endDate);
           }},
           {unit: "day", step: 1, format: "%j %D"}
         ]
       },
       {
         name:"month",
         scale_height: 50,
         min_column_width:120,
         scales:[
            {unit: "month", format: "%F, %Y"},
            {unit: "week", format: "第%W周"}
         ]
        },
        {
         name:"quarter",
         height: 50,
         min_column_width:90,
         scales:[
          {unit: "month", step: 1, format: "%M"},
          {
           unit: "quarter", step: 1, format: function (date:any) {
            var dateToStr = gantt.date.date_to_str("%M");
            var endDate = gantt.date.add(gantt.date.add(date, 3, "month"), -1, "day");
            return dateToStr(date) + " - " + dateToStr(endDate);
           }
         }
        ]},
        {
          name:"year",
          scale_height: 50,
          min_column_width: 30,
          scales:[
            {unit: "year", step: 1, format: "%Y"}
        ]}
    ]
  };

  const daysDiff=function(a:string,b:string){
    const startDate = new Date(a);
    const endDate = new Date(b);

    // 将开始日期和结束日期的时间部分设置为 00:00:00，以确保只计算日期的差异
    //startDate.setHours(0, 0, 0, 0);
    //endDate.setHours(0, 0, 0, 0);

    // 计算日期的毫秒差异，并将其转换为天数
    const timeDiff = Math.abs(endDate.getTime() - startDate.getTime())
    let daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24))
    if(daysDiff==0) daysDiff=1
    return daysDiff
  }
  const init=async function(){
    if(store.app.environment!="web"){
      //如果是electron环境，未设定仓库和路径
      if(store.app.path=="") return
      const fs = require("fs")
      const state = fs.existsSync(store.app.path)//判断是不是有这个文件或者文件夹
      if(state){
        //初始化图布局配置，获取节点和边的信息
        store.app.data.nodes = await file.scanDeepFile(store.app.path,deep.value,true)
      }else{
        console.log("文件不存在")
      }
    }else{
      //如果是网页端环境
      try {
        let str = await store.getCloudData(store.app.path,deep.value,1) as any
        let data = JSON.parse(str)
        store.app.data.nodes=data.nodes
      } catch (error) {
        // 处理错误情况
        console.error(error)
      }
    }
    data.tasks=[]
    gantt.clearAll()
    for(let i = 0;i<store.app.data.nodes.length;i++){
      //判断是否有开始时间的属性
      let start_date=store.StampToDate()
      //判断是否有结束时间的属性
      let duration=1
      if(store.app.data.nodes[i].attributes!=undefined){
        if(store.app.data.nodes[i].attributes.开始时间!=undefined){
          start_date=store.app.data.nodes[i].attributes.开始时间
          if(store.app.data.nodes[i].attributes.结束时间!=undefined){
            duration=daysDiff(store.app.data.nodes[i].attributes.开始时间 || store.StampToDate(),store.app.data.nodes[i].attributes.结束时间 || store.StampToDate() )
          }
        }
      }
      if(i==0){
        data.tasks.push({
          id: store.app.data.nodes[i].fullPath,
          text: store.app.data.nodes[i].fullName,
          start_date:start_date,
          duration:duration,
          data:store.app.data.nodes[i]
        })
      }else{
        data.tasks.push({
          id: store.app.data.nodes[i].fullPath,
          text: store.app.data.nodes[i].fullName,
          start_date:start_date,
          duration:duration,
          parent:store.app.data.nodes[i].parentPath,
          data:store.app.data.nodes[i]
        })
      }
    }
    gantt.parse(data)
    gantt.eachTask(function(task) {
      // 检查任务是否为父任务
      if (gantt.hasChild(task.id)) {
        // 展开父任务及其子任务
        gantt.open(task.id);
      }
    });
    
    gantt.sort("start_date",true);
    focusToday()
    var dateToStr = gantt.date.date_to_str(gantt.config.task_date);
    markertoday.value = gantt.addMarker({
        start_date: new Date(), //a Date object that sets the marker's date
        css: "today", //a CSS class applied to the marker
        text: "N", //the marker title
        title: dateToStr( new Date()) // the marker's tooltip
    });
  }
  const scale = function(type:string){
    if(type=="in")gantt.ext.zoom.zoomIn()
    if(type=="out")gantt.ext.zoom.zoomOut()
    gantt.init(ganttdom.value)
    focusToday()
  }
  const focusToday = function(){
    var today = new Date(); // 获取当前日期
    gantt.scrollTo(gantt.posFromDate(today),null);
  }
  const open =function(id:string){
    store.addTab(gantt.getTask(id).data)
  }
  const del =function(id:string){
    const isConfirmed = confirm('确定删除吗?');
    if (isConfirmed) {
      file.delFile(id)
      init()
    } else {
      console.log('取消删除')
    }
  }
  const openFolder=(path:any)=>{
    const shell = require("electron").shell
    const fs=require("fs")
    if(path!=""){
      fs.exists(path, (exists:any) => {
        if (exists) shell.showItemInFolder(path)
      })
    }
  }
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  async function update(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault()
      sleep(100)
      init()
    }
  }
  watch(()=>store.app.path, (newValue, oldValue) => {
    init()
  })
  watch(()=>store.app.dialog, (newValue, oldValue) => {
    init()
  })
  onMounted(() => {
    gantt.i18n.setLocale("cn");
    gantt.config.step = 1;
    gantt.config.date_format = "%Y-%m-%d";
    gantt.config.sort = true; 
    gantt.config.scroll_on_click = true; //指定在选择显示所选任务时是否应滚动日程表区域
    gantt.plugins({ 
      marker: true 
    });
    gantt.ext.zoom.init(zoomConfig);
    gantt.config.touch = "force";
    gantt.attachEvent("onTaskDblClick", function(id,e){
      // 在这里编写双击行为
      store.addTab(gantt.getTask(id).data)
      return false;
    });
    if(store.app.environment!="web"){
      gantt.attachEvent("onAfterTaskDrag", function(id, mode, e) {
        // 在这里编写处理拖动结束事件的代码
        let attributes =file.getConfig(gantt.getTask(id).data.fullPath)
        for (const key in attributes) {
          if (Object.prototype.hasOwnProperty.call(attributes, key)) {
            const value = attributes[key]
            
            // 判断属性值是否为Date类型
            if (value instanceof Date) {
              // 将Date类型转换为固定格式的字符串（MM-DD）
              const formattedDate = store.StampToDate(value)
              
              // 更新config对象的属性值为格式化后的字符串
              attributes[key] = formattedDate;
            }
          }
        }
        attributes['开始时间']=store.StampToDate(gantt.getTask(id).start_date as any)
        attributes['结束时间']=store.StampToDate(gantt.getTask(id).end_date as any)
        let state = file.saveConfig(gantt.getTask(id).data.fullPath,attributes)
        if(state) store.app.notification="保存属性成功"
      });
      gantt.attachEvent("onContextMenu", function(taskId, linkId, e) {
        // 阻止默认的上下文菜单弹出
        if(taskId!=null){
          showContextMenu.value=true
          id.value=taskId
          // 获取鼠标点击位置相对于容器的坐标
          var x = e.clientX - ganttdom.value.offsetLeft;
          var y = e.clientY - ganttdom.value.offsetTop;

          // 显示右键菜单
          contextMenu.value.style.left = x + "px";
          contextMenu.value.style.top = y + "px";
          return true
        }
      });
    }else{
      gantt.config.readonly = true;//网页中为只读
    }
    gantt.init(ganttdom.value);
    init()
    window.addEventListener('keydown', update)
  })
  onBeforeUnmount(() => {
    gantt.deleteMarker(markertoday)
    window.removeEventListener('keydown', update)
  })
</script>

<template >
  <div class="bg">
    <div class="menu">
      <ul style="width:100%;">
        <li @click="init()"><i class="fa fa-refresh"></i></li>
        <li @click="store.pathBack();init()" title="向上一层"><i class="fa fa-arrow-up"></i></li>
        <li @click="focusToday"><i class="fa fa-flag-o"></i></li>
        <li @click="scale('out')"><i class="fa fa-minus-square-o"></i></li>
        <li @click="scale('in')"><i class="fa fa-plus-square-o"></i></li>
        <li @click="">扫描层级：{{ deep }}
          <ul>
            <li @click="deep=1;init()">1</li>
            <li @click="deep=2;init()">2</li>
            <li @click="deep=3;init()">3</li>
            <li @click="deep=4;init()">4</li>
            <li @click="deep=5;init()">5</li>
          </ul>
        </li>
        <li v-if="store.app.environment!='web'" @click="store.app.dialog='创建文档'"><i class="fa fa-plus"></i></li>
        <li style="max-width:calc(100% - 332px);">{{store.app.path==""?"根目录":store.app.path}}</li>
        
      </ul>
    </div>
    <div ref="ganttdom" class="gantt">
    </div>
    <div ref="contextMenu" class="contextMenu" v-show="showContextMenu" @mouseleave="showContextMenu=false">
      <ul>
        <li @click="open(id)"><i class="fa fa-file-text"></i>&nbsp; 打开任务</li>
        <li @click="openFolder(id)"><i class="fa fa-folder"></i>&nbsp; 打开位置</li>
        <li @click="del(id)"><i class="fa fa-trash"></i>&nbsp; 删除任务</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
  .bg{
    z-index:0;
    position:relative;
    width: 100%;
    height: 100%;
    border-bottom:1px solid var(--borderColor);
    flex:2;
    overflow: hidden;
  }
  .gantt{
    overflow: hidden !important;
    user-select: none;
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
  .gantt{
    position:absolute;
    width:calc(100%);
    height:calc(100% - 26px);
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    overflow-x: auto;
    overflow-y: auto;
    z-index:-10
  }
  .contextMenu{
    position: fixed;
  }
  .contextMenu ul{
    background-color: var(--menuColor);
    padding:5px;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
  }
  .contextMenu ul li{
    cursor:pointer;
    list-style-type:none;
  }
</style>
