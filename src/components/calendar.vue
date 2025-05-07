<template>
  <div class="bg">
      <div style="width:calc(100%);height:40px;background-color: var(--menuColor);line-height:40px;-webkit-app-region: drag;user-select: none;">
        <div style="-webkit-app-region: drag;padding:0px 5px;">
          <button :class="{active:mode=='按月查看'}" @click="mode='按月查看'" title="按月查看"><i class="fa fa-bars" style="font-size: 18px;"></i></button>
          <button :class="{active:mode=='按周查看'}" @click="mode='按周查看'" title="按周查看"><i class="fa fa-calendar"></i></button>
          <button @click="prev"><i class="fa fa-chevron-left"></i></button>
          <button @click="next"><i class="fa fa-chevron-right"></i></button>
          <button @click="insertTask"><i class="fa fa-plus"></i></button>
          <div style="font-size: 12px;float: right;line-height: 18px;-webkit-app-region: no-drag;">
            <div style="font-size: 12px;float: right;line-height: 18px;">
              <i @click="triggerFileInput()" class="fa fa-cloud-upload" title="还原数据"></i> &nbsp;
              <i @click="downloadJSON(allTasks, 'tasks.json');" class="fa fa-cloud-download" title="下载备份"></i> &nbsp;
              <i class="fa fa-toggle-on" ></i> &nbsp;
              <i class="fa fa-times"  @click="store.exit"></i>
            </div>
            <br/>
            <input type="file" ref="fileInput" style="display: none;" @change="handleFileUpload"/>
            <div v-if="mode=='按月查看'" style="font-size: 12px;float: right;line-height: 18px;">{{ currentMonth }}</div>
          </div>
        </div>
      </div>
      <div class="home">
        <div class="container">
          <table v-if="mode=='按月查看'">
              <thead>
                <tr>
                  <!-- 显示星期几 -->
                  <th v-for="day in daysOfWeek" :key="day">{{ day }}</th>
                </tr>
              </thead>
              <tbody style="height:100%;">
                <tr v-for="(week,w) in weeks" :key="w">
                  <!-- 遍历每一天并显示日期 -->
                  <td v-for="(date,d) in week" :key="d" :style="{ backgroundColor: isToday(date.dateObject)||isSameDay(selectedDate,date.dateObject)?'var(--menuActiveColor)':'',border:isSameDay(selectedDate,date.dateObject)?'var(--fontActiveColor) 1px solid':''}" @click="changeSelectedDate(date.dateObject)">
                    <div class="title" :style="{ color: isToday(date.dateObject)?'var(--fontActiveColor)':''}">{{ date.day }}</div>
                    <div class="items scoll">
                      <template v-for="item in allTasks" :key="item.id">
                        <div class="item" v-if="isSameDay(item.time, date.dateObject)" :title="item.title">
                          <input class="iteminput" :class="{active:!item.state}" v-model="item.title" @change="storeData"/>
                          <i @click="item.state=!item.state" class="fa" :class="{'fa-check':!item.state,'fa-times':item.state}" style="margin-left:-25px"></i>
                          <i @click="delTaskTitle(item);storeData()" class="fa fa-trash" style="margin-left:0px"></i>
                        </div>
                      </template>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          <div class="week" style="flex:1">
            <div class="week-calendar" v-if="mode=='按周查看'">
              <div class="week-days">
                <div v-for="day in weekDays" :key="day.date" :style="{color: day.today?'var(--fontActiveColor)':'',backgroundColor:day.selected?'var(--backgroundColor)':'',borderLeft:day.selected?'1px solid var(--borderColor)':'1px solid var(--menuColor)',borderRight:day.selected?'1px solid var(--borderColor)':'1px solid var(--menuColor)'}" @click="changeSelectedDate(day.time)">
                  <div >
                    <span style="font-size: 10px;white-space: nowrap;">{{ day.name }}</span>
                    <span style="font-size: 8px;white-space: nowrap;">{{ day.date }}</span>
                  </div>
                  <span style="position: absolute; top: 0;right:3px;font-size: 5px;" v-if="day.todos>0">{{ day.todos }}</span>
                </div>
              </div>
            </div>
            <div class="tasks scoll" :style="{height:mode!='按周查看'?'calc(100% - 45px)':''}" v-if="mode!='按月查看'">
              <div v-for="(task, index) in mode!='按周查看'?allTasks:tasks">
                <div class="task" v-if="(mode=='按周查看')?true:(mode=='已完成'?task.state:!task.state)">
                  <input type="checkbox" v-model="task.state" @change="storeData">
                  <input style="flex: 1;" v-model="task.title" @change="storeData"></input>
                  <input type="date" :value="task.time.toISOString().split('T')[0]" @change="updateTime($event, task);computer();storeData()" :style="{display: mode!='按周查看'?'block':''}"></input>
                  <button class="delete-btn" @click="delTaskTitle(task);computer()" :style="{display: mode!='按周查看'?'block':''}"><i class="fa fa-trash"></i></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
</template>

<script setup lang="ts">
  import {usestore} from '../store'
  import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue'
  const store=usestore()
  let mode = ref("按月查看") //查看模式
  let currentDate= ref(new Date()) //当前天
  let selectedDate= ref(new Date()) //选择天
  let weekDays =ref([]) as any
  let allTasks = ref([]) as any

  // 当前年份
  const currentYear = computed(() => {
    return currentDate.value.getFullYear()
  })

  // 当前月份
  const currentMonth = computed(() => {
    return currentDate.value.toLocaleString('default', { month: 'long'}) + (' ' + currentYear.value)
  })

  // 当前月份的第一天
  const firstDayOfMonth = computed(() => {
    return new Date(currentYear.value, currentDate.value.getMonth(), 1)
  })
  // 切换到上个月
  const prev = () => {
    if(mode.value=='按月查看'){
      currentDate.value = new Date(currentYear.value, currentDate.value.getMonth() - 1, 1)
    }else{
      currentDate.value.setDate(currentDate.value.getDate() - 7);
      computer()
    }
  }

  // 切换到下个月
  const next = () => {
    if(mode.value=='按月查看'){
      currentDate.value = new Date(currentYear.value, currentDate.value.getMonth() + 1, 1)
    }else{
      currentDate.value.setDate(currentDate.value.getDate() + 7);
      computer()
    }
  }

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    )
  }

  // 星期几的数组（周日到周六）
  const daysOfWeek = computed(() => {
    return ['日', '一', '二', '三', '四', '五', '六']
  })
  // 整个月的日期数组，包括前后的日期
  const dates = computed < any[] > (() => {
    const datesArr: any[] = []
    const firstDay = new Date(firstDayOfMonth.value)
    // 计算当前月份的第一天是星期几
    const firstDayOfWeek = firstDay.getDay()
    // 获取上一个月的最后一天
    const prevMonthLastDate = new Date(currentYear.value, currentDate.value.getMonth(), 0).getDate()
    // 填充上一个月的日期
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const day = prevMonthLastDate - i
      const prevMonthDate = new Date(currentYear.value, currentDate.value.getMonth() - 1, day)
      datesArr.push({
        day,
        isCurrentMonth: false,
        dateObject: prevMonthDate
      })
    }
    // 填充当前月份的日期
    const lastDay = new Date(currentYear.value, currentDate.value.getMonth() + 1, 0)
    const lastDate = lastDay.getDate()
    for (let i = 1; i <= lastDate; i++) {
      const currentDateObj = new Date(currentYear.value, currentDate.value.getMonth(), i)
      datesArr.push({
        day: i,
        isCurrentMonth: true,
        dateObject: currentDateObj
      })
    }
    // 填充下一个月的日期
    const remainingDays = 7 - (datesArr.length % 7);
    for (let i = 1; i <= remainingDays; i++) {
      const nextMonthDate = new Date(currentYear.value, currentDate.value.getMonth() + 1, i);
      datesArr.push({
        day: i,
        isCurrentMonth: false,
        dateObject: nextMonthDate
      });
    }

    return datesArr
  })
  const weeks = computed < any[][] > (() => {
    const weeksArr: any[][] = []
    const datesArr = [...dates.value]
    while (datesArr.length) {
      weeksArr.push(datesArr.splice(0, 7))
    }

    return weeksArr
  })
  function computer(){
    weekDays.value=[]
    const dayOfWeek = currentDate.value.getDay();
    const currentDay = currentDate.value.getDate();
    const currentMonth = currentDate.value.getMonth();
    const currentYear = currentDate.value.getFullYear();
    for (let i = 0; i < 7; i++) {
      const date = new Date(currentYear, currentMonth, currentDay - dayOfWeek + i);
      weekDays.value.push({
        name: getDayName(date.getDay()),
        date: formatDate(date),
        time: date,
        today: date.getFullYear() === new Date().getFullYear() && date.getMonth() === new Date().getMonth() && date.getDate() === new Date().getDate(),
        selected:isSameDay(date,selectedDate.value),
        todos:countTodo(date),
      });
    }
  }
  function changeSelectedDate(date:Date){
    selectedDate.value=new Date(date)
    weekDays.value.map((day:any) =>{
      if(isSameDay(selectedDate.value,day.time)){
        day.selected=true
      }else{
        day.selected=false
      }
    })
  }
  function getDayName(dayIndex:any) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[dayIndex];
  }
  function formatDate(date:any) {
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}-${day}`;
  }
  //定义任务
  interface Task {
    id: number;
    title: string; 
    time: Date;
    state: boolean;
  }
  // 存储数据
  async function storeData() {
    localStorage.setItem('tasks',JSON.stringify(allTasks.value))
  }

  // 查询数据
  function getData() {
    if (localStorage.getItem('tasks')!==null) {
      allTasks.value=JSON.parse(localStorage.getItem('tasks')!)
      //转换time为date格式
      for (let i = 0 ; i < allTasks.value.length; i++) {
        allTasks.value[i].time=new Date(allTasks.value[i].time)
      }
    }
  }
  //插入数据
  const insertTask = function(){
    allTasks.value.push({
      title:'未命名',
      time:selectedDate.value,
      state:false
    })
    computer()
    storeData()
  }
  const updateTime = function(event:any,task:Task){
    const newDate = new Date(event.target.value);
    task.time = newDate;
  }
  //获取选中天数的待办事项
  const tasks = computed(() => {
    if(allTasks.value!=undefined){
      return allTasks.value.filter((task:Task) => {
        // 检查任务日期是否与当前日期在同一天
        return (
          task.time.getFullYear() == selectedDate.value.getFullYear() &&
          task.time.getMonth() == selectedDate.value.getMonth() &&
          task.time.getDate() == selectedDate.value.getDate()
        );
      })
    }else{
      return []
    }
  })
  const delTaskTitle=function(task:Task){
    let index = allTasks.value.findIndex((item:any) => item.title === task.title && item.time === task.time && item.state === task.state);
    if (index !== -1) {
      allTasks.value.splice(index, 1);
    }
  }
  function isSameDay(date1: Date, date2: Date): boolean {
    return (
        date1.getFullYear() === date2.getFullYear() &&
        date1.getMonth() === date2.getMonth() &&
        date1.getDate() === date2.getDate()
    )
  }
  function countTodo(date: Date): number {
    if(allTasks.value!=undefined){
      let count = 0
      allTasks.value.filter((task:Task) => {
        // 检查任务日期是否与当前日期在同一天
        if(
          task.time.getFullYear() == date.getFullYear() &&
          task.time.getMonth() == date.getMonth() &&
          task.time.getDate() == date.getDate()
        ){
          count++
        }
      })
      return count
    }else{
      return 0
    } 
  }
  function downloadJSON(data:any, filename:string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const element = document.createElement('a');
    element.href = URL.createObjectURL(blob);
    element.download = filename;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }
  //上传数据
  const fileInput = ref<HTMLInputElement | null>(null); // 声明为HTMLInputElement或null类型
  const triggerFileInput = () => {
    fileInput.value?.click(); // 使用可选链操作符
  };

    const handleFileUpload = (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0]; // 使用可选链操作符和索引访问类型
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const content = e.target?.result as string; // 断言类型为string
            const parsedData = JSON.parse(content);
            
            // 假设 parsedData 是一个对象数组，每个对象都有 title, time, state 属性
            const transformedData = parsedData.map((item: any) => ({
              ...item,
              time: new Date(item.time) // 将 time 字段转换为 Date 对象
            }));
            allTasks.value = transformedData;
            console.log(allTasks.value)
          } catch (error:any) {
            alert(`Error parsing JSON file: ${error.message}`);
            allTasks.value = [];
          }
        };
        reader.onerror = (error:any) => {
          alert(`Error reading file: ${error.message}`);
        };
        reader.readAsText(file);
      }
    };
  //初始化操作
  getData()
  computer()
  watch(allTasks, (newTasks, oldTasks) => {
    computer()
  })
  onMounted(()=>{
    store.saveConfig()
  })
  onBeforeUnmount(()=>{
    store.saveConfig()
  })
</script>

<style scoped>
  .bg{
    display: flex;
    flex-direction: column;
    height:100%;
    overflow: hidden;
  }
  .active{
    background-color:var(--backgroundColor);
    border-bottom:1px solid var(--backgroundColor);
  }
  .home{
    width:calc(100% - 0px);
    height:calc(100% - 40px);
    flex:1;
    display: flex;
    flex-direction: column;
  }
  .container{
    display: flex;
    flex-direction: column;
    border: 0px;
  }
  button{
    border-radius: 5px;
    margin-right: 5px;
  }
  .week-calendar {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    font-size: 10px;
    user-select: none;
  }

  .week-days {
    display: flex;
    justify-content: space-around;
    width: 100%;
    text-align: center;
    margin:0px;
    flex:21;
  }
  .week-days div {
    padding: 2px 2px;
    margin: 0px 1px;
    flex:1;
    text-align: center;
    position: relative;
  }
  .tasks {
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    border-bottom: 1px solid var(--borderColor);
    overflow:hidden;
    overflow-y: auto;
    flex: 1;
  }

  /* 待办项样式 */
  .task {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--borderColor);
  }

  .task input{
    background-color: var(--backgroundColor);
    border: 0px;
  }
  .task input[type="date"]{
    display: none;
    width: 90px;
    border: 1px solid var(--borderColor);
  }
  .task:hover input[type="date"]{
    display: block;
  }
  /* 复选框样式 */
  .task input[type="checkbox"] {
    appearance: none;
    width: 30px;
    height: 28px;
    border: 1px solid var(--borderColor);
    background-color: var(--backgroundColor);
    border-radius: 4px;
    cursor: pointer;
    margin: 6px 0px;
    flex:0 0 28px;
  }

  .task input[type="checkbox"]:checked {
    background-color: var(--fontActiveColor);
    border-color: var(--fontColor);
  }
  .task:hover .edit-btn {
    display: block;
  }
  .task .edit-btn {
    display: none;
    border: none;
    padding: 3px 5px;
    margin-right: 5px;
    border-radius: 4px;
    cursor: pointer;
    font-size:14px;
    transition: 0.3s ease;
  }

  /* 删除按钮样式 */
  .task:hover .delete-btn {
    display: block;
  }
  .task .delete-btn {
    display: none;
    border: none;
    padding: 3px 5px;
    margin: 0px 3px 0px 0px;
    border-radius: 4px;
    cursor: pointer;
    font-size:14px;
    transition: 0.3s ease;
  }

  /* 完成任务的样式 */
  .task.completed label {
    text-decoration: line-through;
    color: #aaa;
  }
  .control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    text-align: center;
    border: 1px solid var(--borderColor);
    border-radius: 5px;
    margin: 5px 0px 10px 5px;
    padding: 5px 0px;
    min-width: 40px;
  }
  .add:hover {
    background-color: var(--menuColor);
  }
  table{
    height: calc(100%);
  }
  tr{
    height:10%;
    overflow-y: auto;
  }
  td {
    vertical-align: top;
    padding: 2px;
    width:1.285%;
  }
  .title {
    float: left;
    margin:0px;
    font-size:10px
  }
  .items {
    width:calc(100% - 12px);
    overflow-y: auto;
    line-height: 12px;
    margin-left: 8px;
    display: grid;
    overflow-y: auto;
  }
  .item {
    border-radius: 3px;
    border: 1px solid var(--borderColor);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
    overflow: hidden;
    margin-bottom: 1PX;
  }
  .item i{
    opacity: 0;
  }
  .item:hover i{
    opacity: 1;
  }
  .iteminput{
    padding: 0px;
    margin: 0px;
    font-size: 12px;
    height: 12px;
    border-radius: 0px;
    width: 100%;
    border: 0px;
    cursor: pointer;
  }
</style>