<template>
  <div class="calendar" :style="{borderRadius:fixed?'5px':'',border:fixed?'1px var(--borderColor) solid':''}">
    <!-- 头部显示当前年份和月份，并提供切换月份的按钮 -->
    <div class="header">
      <div style="flex:1">{{ currentMonth }}</div>
      <div class="button" @click="prevMonth" v-if="!fixed"><i class="fa fa-angle-left"></i></div>
      <div class="button" @click="nextMonth" v-if="!fixed"><i class="fa fa-angle-right"></i></div>
      <select style="width:150px" v-model="attribute" v-if="!fixed">
        <option v-for="(item,index) in attributes" :key="index">{{item.name}}</option>
      </select>
    </div>

    <!-- 显示日历表格 -->
    <table style="flex:1" :style="{border:fixed?'0px':''}">
      <thead>
        <tr>
          <!-- 显示星期几 -->
          <th v-for="day in daysOfWeek" :key="day" :style="{border:fixed?'0px':''}">{{ day }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(week,w) in weeks" :key="w">
          <!-- 遍历每一天并显示日期 -->
          <td v-for="(date,d) in week" :key="d" :style="{border:fixed?'0px':''}">
            <div class="title"
              :class="{ 'not-current-month': !date.isCurrentMonth, 'today': isToday(date.dateObject) }">{{ date.day }}
            </div>
            <div class="items scoll">
              <template v-for="item in data" :key="item.id">
                <div class="item" v-if="isSameDay(item.date, date.dateObject)" :title="item.label" :style="{border:fixed?'1px solid var(--fontActiveColor)':'',width:fixed?'1px':''}" @dblclick="clickItem(item)">
                  <span v-if="!fixed">{{ item.label }}</span>
                </div>
              </template>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
  import {ref,computed,onMounted,watch} from 'vue';
  import {usestore} from '../../store'
  const store = usestore()
  const props = defineProps({
    year: {
      type: Number,
      default: undefined
    },
    month: {
      type: Number,
      default: undefined
    }
  })
  let attributes =ref([]) as any
  let attribute =ref("开始时间")
  //当前时间
  let currentDate = ref(new Date())

  //日历时间
  const data = ref < any[] > ([])
  let date =  ref(new Date())

  //是否是一个固定组件
  let fixed = ref(false)
  if(props.year!=undefined&&props.month!=undefined){
    currentDate = ref(new Date())
    fixed.value=true
    date.value=new Date(props.year+"-"+(props.month+1)+"-1")
  }
  //获取节点属性
  const getAttributes = function(){
    // 获取所有属性
    let allProps = [] as any
    store.data.forEach((obj: { attributes: any }) => {
      const props = Object.keys(obj.attributes)
      for(let i = 0;i<props.length;i++){
         if(!/^[A-Za-z]+$/.test(props[i])){
          let t = {
            name:props[i],
            state:0,
          } as any
          allProps.push(t)
        }
      }
    })
    // 去除重复属性
    let result = allProps.filter((obj:any, index:any, self:any) => {
      // 检查当前对象是否在之前的对象中出现过
      return (
        index === self.findIndex((o:any) => {
          return (
            JSON.stringify(o) === JSON.stringify(obj)&& // 对象相等
            JSON.stringify(o).includes("时间") // 包含 "时间" 字符串
          )
        })
      )
    })
    attributes.value = result
  }

  // 当前年份
  const currentYear = computed(() => {
    return date.value.getFullYear()
  })

  // 当前月份
  const currentMonth = computed(() => {
    return date.value.toLocaleString('default', { month: 'long'}) + (!fixed.value?(' ' + currentYear.value):'')
  })

  // 当前月份的第一天
  const firstDayOfMonth = computed(() => {
    return new Date(currentYear.value, date.value.getMonth(), 1)
  })

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
    const prevMonthLastDate = new Date(currentYear.value, date.value.getMonth(), 0).getDate()
    // 填充上一个月的日期
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const day = prevMonthLastDate - i
      const prevMonthDate = new Date(currentYear.value, date.value.getMonth() - 1, day)
      datesArr.push({
        day,
        isCurrentMonth: false,
        dateObject: prevMonthDate
      })
    }
    // 填充当前月份的日期
    const lastDay = new Date(currentYear.value, date.value.getMonth() + 1, 0)
    const lastDate = lastDay.getDate()
    for (let i = 1; i <= lastDate; i++) {
      const currentDateObj = new Date(currentYear.value, date.value.getMonth(), i)
      datesArr.push({
        day: i,
        isCurrentMonth: true,
        dateObject: currentDateObj
      })
    }
    // 填充下一个月的日期
    const remainingDays = 7 - (datesArr.length % 7);
    for (let i = 1; i <= remainingDays; i++) {
      const nextMonthDate = new Date(currentYear.value, date.value.getMonth() + 1, i);
      datesArr.push({
        day: i,
        isCurrentMonth: false,
        dateObject: nextMonthDate
      });
    }

    return datesArr
  })

  // 按每周分组的日期数组
  const weeks = computed < any[][] > (() => {
    const weeksArr: any[][] = []
    const datesArr = [...dates.value]
    while (datesArr.length) {
      weeksArr.push(datesArr.splice(0, 7))
    }

    return weeksArr
  })
  // 切换到上个月
  const prevMonth = () => {
    date.value = new Date(currentYear.value, date.value.getMonth() - 1, 1)
  }

  // 切换到下个月
  const nextMonth = () => {
    date.value = new Date(currentYear.value, date.value.getMonth() + 1, 1)
  }

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    )
  }

  // 判断两个日期是否为同一天
  const isSameDay = (date1: Date, date2: Date) => {
    return (
      date1.getDate() === date2.getDate() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getFullYear() === date2.getFullYear()
    )
  }
  // 点击事件
  const clickItem = (data:any) => {
    if(data.type==".md"||data.type==""||data.type==".html"){
      //let content=file.getFile(data.fullPath) //文件内容,web端无法使用
      //data = {...data,content}
    }
    //store.addTab(data)
  }
  // 判断两个日期是否为同一天
  const init = async function () {
    //如果不是云端环境
    if (store.root != "") {
      //如果没有打开标签
      data.value = await window.ipcRenderer.invoke("getFiles", store.root, 1)
    }
    for (let i = 0; i < data.value.length; i++) {
      if(data.value[i].attributes[attribute.value]!=undefined){
        data.value[i].date = new Date(data.value[i].attributes[attribute.value])
      }else{
        data.value[i].date = new Date()
      }
      }
    getAttributes()
  }
  watch(() => store.root, (newValue, oldValue) => {
    init()
  })
  watch(() => attribute.value, (newValue, oldValue) => {
    init()
  })
  onMounted(() => {
    init()
  })
</script>

<style scoped>
  .calendar {
    font-family: Arial, sans-serif;
    flex: 2;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    user-select: none
  }

  .header {
    display: flex;
    align-items: center;
    background-color: var(--menuColor);
    height: 30px;
    padding: 2px;
    width: 100%;
    text-align: center;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    height: calc(100% - 100px)
  }

  th {
    padding: 2px;
    background-color: var(--menuColor);
    text-align: center;
  }

  tr {
    display: table-row;
  }

  td {
    vertical-align: top;
    padding: 2px;
  }

  .items {
    width:calc(100% - 12px);
    overflow-y: auto;
    line-height: 12px;
    margin-left: 8px;
    display: grid;
  }
  .item {
    padding: 1px;
    border-radius: 2px;
    border: 1px solid var(--borderColor);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
    overflow: hidden;
  }

  .item:hover {
    background-color: var(--menuColor);
  }

  .not-current-month {
    color: #999;
  }

  .title {
    float: left;
    margin:0px;
    font-size:10px
  }

  .today {
    color: var(--fontActiveColor);
  }
</style>