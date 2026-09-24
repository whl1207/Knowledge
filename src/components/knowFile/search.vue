<script setup lang="ts">
  import { ref,watch,onMounted, onBeforeUnmount} from 'vue'
  import {usestore} from '@/store'
  const store=usestore()
  let localResults=ref([]) as any
  let ifloading = ref(false)
  //搜索并过滤文件
  let filterText = ref('')
  let timer = ref(null) as any
  const open=(data:any)=>{
    store.openInApp(data)
  }
  //搜索并过滤文件
  const getResults=async function(keyword:string){
    if(filterText.value!=""){
      ifloading.value=true
      //本地搜索
      localResults.value=await window.ipcRenderer.invoke('search',store.root,keyword)//search(store.root,filterText.value)
      ifloading.value=false
    }
  }
  watch(()=>filterText.value, (newValue, oldValue) => {
    clearTimeout(timer.value)
    // 设置一个新的延时任务
    timer.value = setTimeout(() => {
      getResults(filterText.value)
      // 这里可以执行延时后的操作
      // 例如调用某个方法或者发送请求等
    }, 500) // 设置延时时间，单位为毫秒
  })
  onMounted(() => {
  })
</script>

<template>
  <div class="bg">
    <!-- 搜索框 -->
    <div class="search-bar">
      <i class="fa fa-search"></i>
      <input v-model="filterText" class="search" :placeholder="store.locales=='zh'?'请输入搜索关键词':'Enter keyword'" />
      <div v-if="filterText" class="search-clear" @click="filterText=''" :title="store.locales=='zh'?'清除':'Clear'">
        <i class="fa fa-times-circle"></i>
      </div>
    </div>
    <!-- 结果统计 -->
    <div class="result-info" v-if="filterText!='' && !ifloading && localResults.length">
      {{ store.locales=='zh' ? `共 ${localResults.length} 个匹配结果` : `${localResults.length} results` }}
    </div>
    <!-- 本地搜索结果（网格卡片） -->
    <div class="content scoll">
      <!-- 加载中 -->
      <div class="loading" v-if="ifloading">
        <i class="fa fa-spinner fa-spin fa-1x"></i>
      </div>
      <!-- 空状态 -->
      <div class="empty" v-if="filterText!='' && !ifloading && !localResults.length">
        <i class="fa fa-file-o"></i>
        <span>{{ store.locales=='zh' ? '没有找到匹配的文件' : 'No matching files' }}</span>
      </div>
      <!-- 结果卡片：标题固定顶部 + 内容区滚动 + 路径底部，固定高度，双击打开 -->
      <div class="card" v-for="item,index in localResults" :key="index" @dblclick="open(item)" :title="item.path">
        <div class="card-header">
          <i :class="store.icon(item.extension)" class="card-icon"></i>
          <span class="card-name" :title="item.label">{{ item.label }}</span>
        </div>
        <div class="card-snippets scoll" v-if="item.arr!=undefined && item.arr.length">
          <div class="snippet" v-for="(arr,sIndex) in item.arr" :key="sIndex">{{ arr }}</div>
        </div>
        <div class="card-empty" v-else>
          <span>{{ store.locales=='zh' ? '（无内容预览）' : '(No preview)' }}</span>
        </div>
        <div class="card-path">{{ item.path }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .bg {
    position: relative;
    height: calc(100% - 2px);
    overflow-y: hidden;
    display: flex;
    flex-direction: column;
    background-color: var(--backgroundColor);
  }

  /* 搜索框 */
  .search-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 5px 5px 0 5px;
    height: 30px;
    padding: 0 5px;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background-color: var(--backgroundColor);
  }
  .search-bar > i {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--fontColor);
    opacity: 0.6;
  }
  .search {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--fontColor);
    font-size: 13px;
  }
  .search-clear {
    flex-shrink: 0;
    cursor: pointer;
    color: var(--borderColor);
    font-size: 13px;
  }
  .search-clear:hover {
    color: var(--fontActiveColor);
  }

  /* 结果统计 */
  .result-info {
    flex-shrink: 0;
    padding: 6px 12px 0 12px;
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.7;
  }

  /* 结果网格 */
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    align-content: start;
  }

  /* 卡片：标题固定顶部 + 内容区滚动 + 路径底部，固定高度 */
  .card {
    position: relative;
    height: 220px;
    border: 1px solid var(--borderColor);
    border-radius: 8px;
    background-color: var(--backgroundColor);
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    user-select: none;
  }
  .card:hover {
    border-color: var(--primaryColor);
    background-color: var(--menuActiveColor);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  .card-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--borderColor);
    min-width: 0;
    background-color: var(--menuColor);
  }
  .card-header .card-icon {
    flex-shrink: 0;
    font-size: 15px;
    color: var(--primaryColor);
  }
  .card-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fontActiveColor);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-snippets {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  }
  .snippet {
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.85;
    line-height: 1.6;
    word-break: break-all;
  }
  .card-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.4;
  }
  .card-path {
    flex-shrink: 0;
    border-top: 1px solid var(--borderColor);
    padding: 8px 12px;
    font-size: 11px;
    color: var(--fontColor);
    opacity: 0.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 加载中 / 空状态（跨整行居中） */
  .loading,
  .empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 0;
    color: var(--fontColor);
    opacity: 0.5;
  }
  .empty i {
    font-size: 40px;
  }
  .empty span {
    font-size: 13px;
  }
</style>

