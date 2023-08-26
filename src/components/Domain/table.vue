<script setup lang="ts">
  import {usestore} from '../../store'
  import {ref,onMounted,watch} from 'vue'
  import file from '../../../electron/file'
  const store=usestore()
  let editRowIndex=ref(null) as any
  let attributes=ref([]) as any //有哪些属性
  let data=ref({}) as any
  const init = async function(){
    data.value=await file.scanDeepFile(store.app.path,1,0)
    getAttributes()
  }
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
  const open = function(i:number){
    store.addTab(data.value[i])
  }
  const changeAttribute = function(i:number,attribute:string,value:any){
    //查询文件现有属性
    let attributesData = file.getConfig(data.value[i].fullPath)
    //如果使date，格式化字符串
    for (const key in attributesData) {
      if (Object.prototype.hasOwnProperty.call(attributesData, key)) {
        const value = attributesData[key]
        // 判断属性值是否为Date类型
        if (value instanceof Date) {
          // 将Date类型转换为固定格式的字符串（MM-DD）
          const formattedDate = store.StampToDate(value)
          // 更新config对象的属性值为格式化后的字符串
          attributesData[key] = formattedDate;
        }
      }
    }
    //修改属性
    attributesData[attribute]=value
    let state = file.saveConfig(data.value[i].fullPath,attributesData)
    if(state) store.app.notification="保存属性成功"
  }
  watch(()=>store.app.path, (newValue, oldValue) => {
    //init()
  })
  onMounted(() => {
    init()
  })
</script>

<template>
  <div class="bg">
    <div class="menu">
        <ul>
          <li @click="init()"><i class="fa fa-refresh"></i></li>
          <li @click="store.pathBack();init()"><i class="fa fa-arrow-up"></i></li>
          <li>
            {{store.app.path==""?"根目录":store.app.path}}
          </li>
        </ul>
    </div>
    <div class="tab_content scoll">
      <table>
        <thead>
          <th style="width:30px" fixed="true"></th>
          <th style="width:50px" fixed="true"></th>
          <th>标题</th>
          <th v-for="(item,index) in attributes">{{ item }}</th>
        </thead>
        <tr
          v-for="(node,index) in data"
          @mouseenter="editRowIndex=index"
          @mouseleave="editRowIndex=null"
          :style="{background:(index==editRowIndex?'var(--menuActiveColor)':'')}"
        >
          <td>
            <span>{{index}}</span>
          </td>
          <td>
            <span>
              <i @click="store.app.path=node.fullPath;init()" class="fa fa-folder-open" v-if="node.isFolder"></i>
              <i @click="open(index)" class="fa fa-file-text"></i>
            </span>
          </td>
          <td>
            <span>{{node.name}}</span>
          </td>
          <td v-for="(item,a) in attributes">
            <span v-if="index!=editRowIndex">{{node.attributes[item]}}</span>
            <input v-if="index==editRowIndex" v-model="node.attributes[item]" @change="changeAttribute(index,item,node.attributes[item])"/>
          </td>
        </tr>
      </table>
    </div>
  </div>
</template>

<style scoped>
  .bg{
    z-index:-10;
    color: var(--fontColor);
    width: 100%;
    height: calc(100vh - 30px);
    padding:0px;
    position:relative;
    border-bottom:1px solid var(--borderColor);
    flex:1;
    overflow: hidden;
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
  .tab_content{
    position:absolute;
    width:calc(100%);
    height:calc(100% - 26px);
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    overflow-x: auto;
  }

  table{
    width:100%;
    max-width: 100%;
    table-layout: auto;
    text-align: center;
  }

  table th
  {
    background-color: var(--menuColor);
    color:var(--fontActiveColor);
  }
  table td
  {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width:50px;
  }
  input{
    width:calc(100% - 13px);
    height:20px;
    margin: 0px;
    text-align: center;
    font-size: 16px;
    background-color: var(--menuColor);
    border: none;
    outline: none;
  }
  input[type="date"]{
    width:110px;
  }
  input[type="checkbox"]{
    width:15px;
    height:15px
  }
  button{
    border:none;
    font-size: 14px;
    padding: 2px;
    margin: 0px;
    height:32px;
    width:50%;
    border-radius: 0px;
  }
  button:hover{
    background-color: var(--menuActiveColor);
  }
  span{
    display: block;
    width: 100%;
    height: 20px;
    overflow:hidden; 
    text-overflow:ellipsis;
    display:-webkit-box; 
    -webkit-box-orient:vertical;
    -webkit-line-clamp:2; 
  }
  i {
    padding: 0px 2px;
  }
</style>
