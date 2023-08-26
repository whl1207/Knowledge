<script setup lang="ts">

  import {usestore} from '../../../store'
  import { nextTick, ref,reactive,watch,computed,onMounted,onBeforeUnmount } from 'vue'
  import file from '../../../../electron/file'
  import TinyWhiteboard from "tiny-whiteboard"
  import ColorPicker from '../../Menu/ColorPicker.vue'
  //读取并解构数据
  const store=usestore()
  let app = null as any
  // 当前操作类型
  const currentType = ref('selection')

  // dom节点
  const box = ref(null)

  // 应用实例
  const appInstance = ref(null)
  // 当前激活的元素
  const activeElement = ref(null) as any
  // 当前多选的元素
  const selectedElements = ref([])
  const hasSelectedElements = computed(() => {
    return selectedElements.value.length > 0
  })
  // 描边宽度
  const lineWidth = ref('small')
  // 边框样式
  const lineDash = ref(0)
  // 透明度
  const globalAlpha = ref(1)
  // 角度
  const rotate = ref(0)
  // 当前缩放
  const currentZoom = ref(100)
  // 缩放允许前进后退
  const canUndo = ref(false)
  const canRedo = ref(false)
  const jsonPreviewBox = ref(null)
  // 背景颜色
  const backgroundColor = ref('')
  // 当前滚动距离
  const scroll = reactive({
    x: 0,
    y: 0
  })
  // 切换显示网格
  const showGrid = ref(false)
  // 模式切换
  const readonly = ref(false)
  // 帮助弹窗
  const helpDialogVisible = ref(false)
  const shortcutKeyList = reactive([
    {
      name: '全部选中',
      value: 'Control + a'
    },
    {
      name: '删除',
      value: 'Del 或 Backspace'
    },
    {
      name: '复制',
      value: 'Control + c'
    },
    {
      name: '粘贴',
      value: 'Control + v'
    },
    {
      name: '放大',
      value: 'Control + +'
    },
    {
      name: '缩小',
      value: 'Control + -'
    },
    {
      name: '重置缩放',
      value: 'Control + 0'
    },
    {
      name: '缩放以适应所有元素',
      value: 'Shift + 1'
    },
    {
      name: '撤销',
      value: 'Control + z'
    },
    {
      name: '重做',
      value: 'Control + y'
    },
    {
      name: '显示隐藏网格',
      value: "Control + '"
    }
  ])

  //初始化白板
  const init=async function(){
    if(store.app.files.length==0) return
    if(store.app.files[store.app.fileIndex].type==".wb"){
      await nextTick()
      if(app==null){
        //console.log(document.documentElement.style.getPropertyValue("--fontActiveColor"))
        app = new TinyWhiteboard({
          container: document.getElementById("whiteboard"),
        })
        let data ="{}"
        if(store.app.environment!="web"){
          data = file.getFile(store.app.files[store.app.fileIndex].fullPath)
        }
        
        app.setData(JSON.parse(data),false)

        app.on('activeElementChange', (element:any) => {
          if (activeElement.value) {
            activeElement.value.off('elementRotateChange', onElementRotateChange)
          }
          activeElement.value = element
          if (element) {
            let { style, rotate: elementRotate } = element
            lineWidth.value = style.lineWidth
            lineDash.value = style.lineDash
            globalAlpha.value = style.globalAlpha
            rotate.value = elementRotate
            element.on('elementRotateChange', onElementRotateChange)
          }
        })
        // 元素多选变化
        app.on('multiSelectChange', (elements:any) => {
          selectedElements.value = elements
        })
        // 缩放变化
        app.on('zoomChange', (scale:any) => {
          currentZoom.value = scale * 100
        })
        // 监听app内部修改类型事件
        app.on('currentTypeChange', (type:any) => {
          currentType.value = type
        })
        // 监听前进后退事件
        app.on('shuttle', (index:any, length:any) => {
          canUndo.value = index > 0
          canRedo.value = index < length - 1
        })
        // 监听滚动变化
        app.on('scrollChange', (x:any, y:any) => {
          scroll.y = parseInt(y)
          scroll.x = parseInt(x)
        })
      }
      
    }
  }
  // 类型变化
  const onCurrentTypeChange = () => {
    // 清除激活项
    app.cancelActiveElement()
  }
  // 放大
  const zoomIn = () => {
    app.zoomIn()
  }

  // 缩小
  const zoomOut = () => {
    app.zoomOut()
  }

  // 恢复初始缩放
  const resetZoom = () => {
    app.setZoom(1)
  }

  // 模式切换
  const toggleMode = () => {
    if (readonly.value) {
      readonly.value = false
      app.setEditMode()
    } else {
      readonly.value = true
      app.setReadonlyMode()
    }
  }
  // 切换显示网格
  const toggleGrid = () => {
    if (showGrid.value) {
      showGrid.value = false
      app.hideGrid()
    } else {
      showGrid.value = true
      app.showGrid()
    }
  }
  // 元素角度变化
  const onElementRotateChange = (elementRotate:any) => {
    rotate.value = elementRotate
  }
  // 更新样式
  const updateStyle = (key:any, value:any) => {
    app.setCurrentElementsStyle({
      [key]: value
    })
  }
  // 删除元素
  const deleteElement = () => {
    app.deleteCurrentElements()
  }

  // 复制元素
  const copyElement = () => {
    app.copyPasteCurrentElements()
  }
  // 回退
  const undo = () => {
    app.undo()
  }

  // 前进
  const redo = () => {
    app.redo()
  }
  function resize() {
    app.resize()
  }
  function save(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault();
      file.saveFile(store.app.files[store.app.fileIndex].fullPath,JSON.stringify(app.exportJson()))
    }
  }
  watch(currentType, () => {
    app.updateCurrentType(currentType.value)
  })
  //监听变化
  watch(()=>store.app.files[store.app.fileIndex], (newValue, oldValue) => {
    if(store.app.files.length>0){
      init()
      app.render.render()
    }
  })
  watch(()=>store.app.UI.theme, (newValue, oldValue) => {
    console.log(app.state)
  })
  onMounted(()=>{
    init()
    window.addEventListener('keydown', save)
    window.addEventListener('resize', resize)
    
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', save)
    window.removeEventListener('resize', resize)
  })
</script>

<template >
  <!--文章视图-->
  <div class="bg">
    <!--查看白板-->
    <div id="whiteboard" >
    </div>
    <div class="toolbarsbg">
    <div class="toolbars">
      <div @click="toggleMode" class="toolbar" :style="{backgroundColor:readonly?'var(--menuActiveColor)':''}">
        <i class="fa fa-lock" v-if="readonly"></i>
        <i class="fa fa-unlock-alt" v-if="!readonly"></i>
      </div>
      <div @click="toggleGrid" class="toolbar" :style="{backgroundColor:showGrid?'var(--menuActiveColor)':''}"><i class="fa fa-th"></i></div>
      <span v-if="!readonly" style="margin-right:5px">|</span>
      <div v-if="!readonly" @click="undo" class="toolbar">
        <i class="fa fa-undo"></i>
      </div>
      <div v-if="!readonly" @click="redo" class="toolbar">
        <i class="fa fa-repeat"></i>
      </div>
      <div v-if="!readonly" @click="currentType='selection';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='selection'?'var(--menuActiveColor)':''}">
        <i class="fa fa-hand-paper-o"></i>
      </div>
      <div v-if="!readonly" @click="currentType='rectangle';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='rectangle'?'var(--menuActiveColor)':''}">
        <svg width="15px" height="15px">
          <polyline points="1,1 14,1" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="1,1 1,14" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="14,1 14,14" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="1,14 14,14" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
        </svg>
      </div>
      <div v-if="!readonly" @click="currentType='diamond';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='diamond'?'var(--menuActiveColor)':''}">
        <svg width="15px" height="15px">
          <polyline points="7.5,0 0,7.5" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="0,7.5 7.5,15" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="7.5,0 15,7.5" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="15,7.5 7.5,15" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
        </svg>
      </div>
      <div v-if="!readonly" @click="currentType='triangle';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='triangle'?'var(--menuActiveColor)':''}">
        <svg width="15px" height="15px">
          <polyline points="7.5,0 0,15" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="7.5,0 15,15" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
          <polyline points="15,14 0,14" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
        </svg>
      </div>
      <div v-if="!readonly" @click="currentType='circle';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='circle'?'var(--menuActiveColor)':''}"><i class="fa fa-circle-o"></i></div>
      <div v-if="!readonly" @click="currentType='line';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='line'?'var(--menuActiveColor)':''}">
        <svg width="15px" height="15px">
          <polyline points="0,9 15,9" style="fill:none;stroke:var(--fontColor);stroke-width:2" />
        </svg>
      </div>
      <div v-if="!readonly" @click="currentType='arrow';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='arrow'?'var(--menuActiveColor)':''}"><i class="fa fa-long-arrow-right"></i></div>
      <div v-if="!readonly" @click="currentType='freedraw';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='freedraw'?'var(--menuActiveColor)':''}"><i class="fa fa-pencil"></i></div>
      <div v-if="!readonly" @click="currentType='text';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='text'?'var(--menuActiveColor)':''}"><i class="fa fa-font"></i></div>
      <div v-if="!readonly" @click="currentType='image';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='image'?'var(--menuActiveColor)':''}"><i class="fa fa-file-image-o"></i></div>
      <div v-if="!readonly" @click="currentType='eraser';onCurrentTypeChange()" class="toolbar" :style="{backgroundColor:currentType=='eraser'?'var(--menuActiveColor)':''}"><i class="fa fa-eraser"></i></div>

    </div>
  </div>
    <div class="zoom">
      <div @click="zoomOut"><i class="fa fa-search-minus"></i></div>
      <div @click="zoomIn"><i class="fa fa-search-plus"></i></div>
      <span @click="resetZoom">{{ currentZoom }}%</span>
    </div>
    <div class="cog" v-show="activeElement || hasSelectedElements">
        <div>
          <!-- 描边 -->
          <div
            class="styleBlock"
            v-if="
              !['text', 'image'].includes(activeElement?.type) ||
              hasSelectedElements
            "
          >
            <div class="styleBlockTitle">描边</div>
            <ColorPicker
              type="stroke"
              :value="activeElement?.style.strokeStyle"
              @change="updateStyle('strokeStyle', $event)"
            ></ColorPicker>
          </div>
          <!-- 填充 -->
          <div
            class="styleBlock"
            v-if="
              !['image', 'line', 'arrow', 'freedraw'].includes(
                activeElement?.type
              ) || hasSelectedElements
            "
          >
            <div class="styleBlockTitle">填充</div>
            <ColorPicker
              type="fill"
              :value="activeElement?.style.fillStyle"
              @change="updateStyle('fillStyle', $event)"
            ></ColorPicker>
          </div>
          <!-- 描边宽度 -->
          <div
            class="styleBlock"
            v-if="
              !['image', 'text'].includes(activeElement?.type) ||
              hasSelectedElements
            "
          >
            <div class="styleBlockTitle">描边宽度</div>
            <div class="styleBlockContent" style="display:flex;width:100%">
              <div @click="lineWidth='small';updateStyle('lineWidth', 'small')">细</div>
              <div @click="lineWidth='middle';updateStyle('lineWidth', 'middle')">中</div>
              <div @click="lineWidth='large';updateStyle('lineWidth', 'large')">粗</div>
            </div>
          </div>
          <!-- 边框样式 -->
          <div
            class="styleBlock"
            v-if="
              !['freedraw', 'image', 'text'].includes(activeElement?.type) ||
              hasSelectedElements
            "
          >
            <div class="styleBlockTitle">边框样式</div>
            <div class="styleBlockContent">
              <div @click="lineDash=0;updateStyle('lineDash', 0)">实</div>
              <div @click="lineDash=5;updateStyle('lineDash', 5)">虚</div>
              <div @click="lineDash=2;updateStyle('lineDash', 2)">点</div>
            </div>
          </div>
          <!-- 透明度 -->
          <div class="styleBlock">
            <div class="styleBlockTitle">透明度</div>
              <input
                type="range"
                v-model="globalAlpha"
                min="0"
                max="1"
                step="0.1"
                @change="updateStyle('globalAlpha', globalAlpha)"
              />
          </div>
          <!-- 操作 -->
          <div class="styleBlock">
            <div class="styleBlockTitle">操作</div>
            <div class="styleBlockContent">
              <button @click="deleteElement">
                <i class="fa fa-trash-o "></i>
              </button>
              <button @click="copyElement">
                <i class="fa fa-files-o"></i>
              </button>
            </div>
          </div>
        </div>
    </div>
  </div>
</template>

<style scoped>
  .bg{/**背景 */
    width:100%;
    display: flex;
    position:relative;
    margin: 0px;
    width: 100%;
    height: 100%;
    flex:4;
  }
  #whiteboard{
    position: absolute;
    width: 100%;
    height:100%;
  }
  .toolbarsbg{
    position: absolute;
    width:calc(100%);
    height:50px;
    bottom: 10px;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .toolbars{
    user-select: none;
    position: absolute;
    bottom: 0px;
    padding: 5px;
    border-radius: 5px;
    background-color: var(--menuColor);
    pointer-events: all;
    box-shadow:3px 3px 3px rgba(78, 78, 78, 0.2);
  }
  .toolbar{
    padding: 5px;
    padding-left: 8px;
    padding-right: 8px;
    margin-right: 5px;
    border-radius: 0px;
    border-radius: 5px;
    display: inline-block;
  }
  .zoom{
    user-select: none;
    position: absolute;
    top:5px;
    left:5px;
  }
  .zoom div{
    display: inline-block;
    width:20px;
    height:20px;
    padding: 3px;
    text-align: center;
  }
  .cog{
    position: absolute;
    top:5px;
    right:5px;
    width:130px;
    padding:5px;
    border-radius: 10px;
    border: 1px solid var(--borderColor);
    background-color: var(--backgroundColor);
  }
  .styleBlockTitle{
    margin-bottom: 5px;
  }
  .styleBlockContent{
    display: flex;
  }
  .styleBlockContent div{
    flex: 1;
    border: 1px solid var(--borderColor);
    text-align: center;
    border-radius: 5px;
  }
</style>
