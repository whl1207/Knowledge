<template>
    <div class="year">
      <div class="header">
        <div class="button" style="flex:1;white-space: nowrap;overflow: hidden;text-overflow: ellipsis;">{{ store.root }}</div>
        <div class="button" style="width:60px">{{ currentYear }}</div>
        <div class="button" @click="previousYear"><i class="fa fa-angle-left"></i></div>
        <div class="button" style="margin-right: 5px;" @click="nextYear"><i class="fa fa-angle-right"></i></div>
      </div>
      <div class="calendar-month" :key="currentYear">
          <view_date :year="currentYear" :month="m" v-for="(month, m) in months"/>
      </div>
    </div>
  </template>
  
  <script setup>
  import view_date from './view_date.vue'
  import {usestore} from '../../store'
  const store = usestore()
  const currentYear = ref(new Date().getFullYear()); // 当前年份
  const currentMonth = ref(new Date().getMonth());
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']; // 星期几的简写
  const months = [
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
  ]; // 月份及每月的日期

  import { ref } from 'vue';

  function isActiveDate(y, m, d) {
    const today = new Date();
    return (
      d === today.getDate() && m === today.getMonth() && currentYear.value === today.getFullYear()
    );
  }

  function getWeekday(month, date) {
    const year = currentYear.value;
    const monthIndex = month;
    return new Date(year, monthIndex, date).getDay();
  }

  function previousYear() {
    currentYear.value--;
  }

  function nextYear() {
    currentYear.value++;
  }
</script>
  
  <style scoped>
  .year{
    font-family: Arial, sans-serif;
    flex:1;
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
  
  .calendar-month {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    height:calc(100% - 51px);
    padding:5px;
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