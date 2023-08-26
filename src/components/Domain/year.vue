<template>
    <div class="year-calendar">
      <div class="header">
        <div @click="previousYear"><i class="fa fa-angle-left"></i></div>
        <div>{{ currentYear }}</div>
        <div @click="nextYear"><i class="fa fa-angle-right"></i></div>
      </div>
      <div class="calendar-month" :key="currentYear">
        <Calendar :year="currentYear" :month="m" v-for="(month, m) in months"/>
        <!--<div v-for="(month, m) in months" :key="m" class="month">
          <div class="month-header">{{ month.name }}</div>
          <div class="weekdays">
            <span v-for="(day, w) in weekdays" :key="w">{{ day }}</span>
          </div>
          <div class="dates">
            <span
              v-for="(date, d) in month.dates"
              :key="d"
              :class="{ active: isActiveDate(currentYear,m,d), weekday: date.weekday === 0 }"
            >
              {{ date.date }}
            </span>
          </div>
        </div>-->
      </div>
    </div>
  </template>
  
  <script>
  import Calendar from './calendar.vue'
  export default {
    name: 'YearCalendar',
    data() {
      return {
        currentYear: new Date().getFullYear(), // 当前年份
        currentMonth: new Date().getMonth(),
        weekdays: ['日', '一', '二', '三', '四', '五', '六'], // 星期几的简写
        months: [
          { name: '一月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '二月', dates: [...Array(28).keys()].map((date) => ({ date: date + 1 })) },
          { name: '三月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '四月', dates: [...Array(30).keys()].map((date) => ({ date: date + 1 })) },
          { name: '五月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '六月', dates: [...Array(30).keys()].map((date) => ({ date: date + 1 })) },
          { name: '七月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '八月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '九月', dates: [...Array(30).keys()].map((date) => ({ date: date + 1 })) },
          { name: '十月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
          { name: '十一月', dates: [...Array(30).keys()].map((date) => ({ date: date + 1 })) },
          { name: '十二月', dates: [...Array(31).keys()].map((date) => ({ date: date + 1 })) },
        ], // 月份及每月的日期
      };
    },
    components: {
      Calendar // 在组件选项中注册组件
    },
    methods: {
      isActiveDate(y,m,d) {
        const today = new Date();
        return (
          d === today.getDate() && m === today.getMonth() && this.currentYear === today.getFullYear()
        );
      },
      getWeekday(month, date) {
        const year = this.currentYear;
        const monthIndex = month;
        return new Date(year, monthIndex, date).getDay();
      },
      previousYear() {
        this.currentYear--;
      },
      nextYear() {
        this.currentYear++;
      },
    },
  };
</script>
  
  <style scoped>
  .year-calendar {
    font-family: Arial, sans-serif;
    flex:8;
    display: flex;
    flex-direction: column;
    height:100%;
    overflow:hidden
  }
  
  .header {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color:var(--menuColor);
    border-bottom:var(--borderColor) 1px solid
  }
  .header div{
    width:33%;
    padding:10px;
    text-align:center
  }
  
  .calendar-month {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    height:100%;
    padding:10px
  }
  
  .month {
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    padding: 5px;
  }
  
  .month-header {
    text-align: center;
    font-weight: bold;
  }
  
  .weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    padding-bottom:5px;
    border-bottom:1px solid var(--borderColor);
    text-align:center
  }
  .dates {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    height:calc(100% - 48px);
    justify-content: center;
    align-items: center;
  }
  
  .dates span {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    text-align:center
  }
  
  .dates span.active {
    color:var(--fontActiveColor);
    background-color: var(--menuColor);
    border-radius:5px
  }
  </style>