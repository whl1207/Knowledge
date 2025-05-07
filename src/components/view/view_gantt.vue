<script setup lang="ts">

  import {usestore} from '../../store'
  import { ref,reactive,onMounted,onBeforeUnmount,watch,nextTick} from 'vue'
  import {gantt} from 'dhtmlx-gantt'
  import "dhtmlx-gantt/codebase/dhtmlxgantt.css"
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
          {unit: "day", step: 1, format: store.locales=='zh'?"%M %d 日":"%M %d"}
        ]
      },
      {
         name:"week",
         scale_height: 50,
         min_column_width:50,
         scales:[
          {unit: "week", step: 1, format: function (date:any) {
           var dateToStr = gantt.date.date_to_str(store.locales=='zh'?"%M %d 日":"%M %d");
           var endDate = gantt.date.add(date, 6, "day");
           var weekNum = gantt.date.date_to_str("%W")(date);
           return store.locales=='zh'?("第" + weekNum + "周, "):(weekNum + " week, ") + dateToStr(date) + " - " + dateToStr(endDate);
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
            {unit: "week", format: store.locales=='zh'?"第%W周":"%W"}
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
    //如果是electron环境，未设定仓库和路径
    if(store.root=="") return
    let files = await window.ipcRenderer.invoke("getFiles", store.root, 1);
    
    data.tasks=[]
    gantt.clearAll()
    for(let i = 0;i<files.length;i++){
      //判断是否有开始时间的属性
      let start_date=store.StampToDate()
      //判断是否有结束时间的属性
      let duration=1
      if(files[i].attributes!=undefined){
        if(files[i].attributes.开始时间!=undefined){
          start_date=files[i].attributes.开始时间
          if(files[i].attributes.结束时间!=undefined){
            duration=daysDiff(files[i].attributes.开始时间 || store.StampToDate(),files[i].attributes.结束时间 || store.StampToDate() )
          }
        }
      }
      if(i==0){
        data.tasks.push({
          id: files[i].path,
          text: files[i].label,
          start_date:start_date,
          duration:duration,
          data:files[i]
        })
      }else{
        data.tasks.push({
          id: files[i].path,
          text: files[i].label,
          start_date:start_date,
          duration:duration,
          parent:files[i].parentPath,
          data:files[i]
        })
      }
    }
    gantt.parse(data)
    gantt.eachTask(function(task:any) {
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
    //store.addTab(gantt.getTask(id).data)
  }
  const del =function(id:string){
    const isConfirmed = confirm('确定删除吗?');
    if (isConfirmed) {
      //file.delFile(id)
      init()
    } else {
      console.log('取消删除')
    }
  }
  const openFolder=(path:any)=>{
    //
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
  watch(()=>store.root, (newValue, oldValue) => {
    init()
  })
  onMounted(() => {
    if(store.locales=='zh'){gantt.i18n.setLocale("cn");}else{gantt.i18n.setLocale("en");}
    gantt.config.step = 1;
    gantt.config.date_format = "%Y-%m-%d";
    gantt.config.sort = true; 
    gantt.config.scroll_on_click = true; //指定在选择显示所选任务时是否应滚动日程表区域
    gantt.plugins({ 
      marker: true 
    });
    gantt.ext.zoom.init(zoomConfig);
    gantt.config.touch = "force";
    gantt.attachEvent("onTaskDblClick", function(id:any,e:any){
      // 在这里编写双击行为
      //store.addTab(gantt.getTask(id).data)
      return false;
    })
      gantt.attachEvent("onAfterTaskDrag", function(id:any, mode:any, e:any) {
        // 在这里编写处理拖动结束事件的代码
        let attributes ={} as any//file.getConfig(gantt.getTask(id).data.fullPath)
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
      });
      gantt.attachEvent("onContextMenu", function(taskId:any, linkId:any, e:any) {
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
      })
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
      <div class="button" @click="init()"><i class="fa fa-refresh"></i></div>
      <div class="button" @click="focusToday"><i class="fa fa-flag-o"></i></div>
      <div class="button" @click="scale('out')"><i class="fa fa-minus-square-o"></i></div>
      <div class="button" @click="scale('in')"><i class="fa fa-plus-square-o"></i></div>
      <select @change="init" v-model="deep" style="width:50px">{{store.locales=='zh'?'扫描层级:':'Scanning Level:'}}{{ deep }}
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
      </select>
      <div class="button" style="flex:1;margin-right: 5px;white-space: nowrap;overflow: hidden;text-overflow: ellipsis;">{{store.root==""?"根目录":store.root}}</div>
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
    height:40px;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
    display: flex;
  }
  .gantt{
    position:absolute;
    width:calc(100%);
    height:calc(100% - 41px);
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
