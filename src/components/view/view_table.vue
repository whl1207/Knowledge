<script setup lang="ts">
  import {usestore} from '../../store'
  import {ref,onMounted,watch} from 'vue'
  const store=usestore()
  let editRowIndex=ref(null) as any
  let attributes=ref([]) as any //有哪些属性
  let data=ref({}) as any
  const init = async function(){
    data.value = await window.ipcRenderer.invoke("getFiles", store.root, 1)
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
    //store.addTab(data.value[i])
  }
  /**
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
  } */
  watch(()=>store.root, (newValue, oldValue) => {
    init()
  })
  onMounted(() => {
    init()
  })
</script>

<template>
  <div class="bg">
    <div class="menu">
      <!--<li @click="store.rootBack();init()"><i class="fa fa-arrow-up"></i></li>-->
      <div class="button" style="white-space: nowrap;overflow: hidden;text-overflow: ellipsis;flex:1;margin-right:5px">
        {{store.root==""?"根目录":store.root}}
      </div>
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
              <i @click="store.root=node.fullPath;init()" class="fa fa-folder-open" v-if="node.isFolder"></i>
              <i @click="open(index)" class="fa fa-file-text"></i>
            </span>
          </td>
          <td>
            <span>{{node.label}}</span>
          </td>
          <td v-for="(item,a) in attributes">
            <span v-if="index!=editRowIndex">{{node.attributes[item]}}</span>
            <input v-if="index==editRowIndex" v-model="node.attributes[item]" @change=""/>
          </td>
        </tr>
      </table>
    </div>
  </div>
</template>

<style scoped>
  .bg{
    color: var(--fontColor);
    width: 100%;
    height: calc(100vh - 41px);
    padding:0px;
    position:relative;
    border-right:1px solid var(--borderColor);
    flex:1;
    overflow: hidden;
  }
  .menu{
    position: relative;
    width:100%;
    user-select: none;
    display: flex;
  }
  .tab_content{
    position:absolute;
    width:calc(100%);
    height:calc(100% - 40px);
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    overflow-x: auto;
  }

  table{
    width:calc(100% - 10px);
    max-width: 100%;
    margin:5px;
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
    padding: 3px;
  }
  input{
    width:calc(100% - 13px);
    height:20px;
    margin: 0px;
    text-align: center;
    font-size: 16px;
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
</style>
