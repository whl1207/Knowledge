<script setup lang="ts">
  import { usestore } from '@/store'
  import {ref, onMounted, watch, nextTick, computed} from 'vue'
  import { ElMessage, ElMessageBox } from 'element-plus'
  
  const store = usestore()
  let editRowIndex = ref<number | null>(null)
  let editAttributeName = ref<string>('')
  let attributes = ref([]) as any
  let data = ref([]) as any
  let searchQuery = ref<string>('')
  
  const isMarkdownFile = function(item: any): boolean {
    if (!item) return false
    
    // 文件夹也允许编辑（如果需要的话）
    // if (item.isFolder) return true
    
    // 检查文件扩展名
    const extension = (item.extension || '').toLowerCase()
    const fileName = (item.label || '').toLowerCase()
    
    // Markdown 文件扩展名列表
    const markdownExtensions = [
      '.md', '.markdown', '.mdown', '.mkd', 
      '.mkdn', '.mdwn', '.mdtxt', '.mdtext'
    ]
    
    // 检查扩展名是否匹配
    return markdownExtensions.some(ext => 
      extension === ext || fileName.endsWith(ext)
    )
  }
  // 过滤后的数据
  const filteredData = computed(() => {
    if (!searchQuery.value.trim()) {
      return data.value
    }
    
    const query = searchQuery.value.trim().toLowerCase()
    
    return data.value.filter((item: any) => {
      // 搜索文件名
      if (item.label && item.label.toLowerCase().includes(query)) {
        return true
      }
      
      // 搜索所有属性值
      if (item.attributes) {
        for (const key in item.attributes) {
          const value = item.attributes[key]
          if (value !== null && value !== undefined) {
            const strValue = String(value).toLowerCase()
            if (strValue.includes(query)) {
              return true
            }
          }
          // 也搜索属性名
          if (key.toLowerCase().includes(query)) {
            return true
          }
        }
      }
      
      // 搜索文件路径
      const filePath = item.fullPath || item.path
      if (filePath && filePath.toLowerCase().includes(query)) {
        return true
      }
      
      return false
    })
  })
  
  // 初始化数据
  const init = async function(){
    try {
      const files = await window.ipcRenderer.invoke("getFiles", store.root, 1)
      data.value = files
      getAttributes()
    } catch (error) {
      console.error('获取文件列表失败:', error)
    }
  }
  
  // 获取节点属性
  const getAttributes = function(){
    let allProps = [] as any
    data.value.forEach((obj: { attributes: any }) => {
      const props = Object.keys(obj.attributes)
      for(let i = 0; i < props.length; i++){
        if(!/^[A-Za-z]+$/.test(props[i])){
          allProps.push(props[i])
        }
      }
    })
    
    // 去除重复属性
    let result = allProps.filter((obj:any, index:any, self:any) => {
      return index === self.findIndex((o:any) => {
        return JSON.stringify(o) === JSON.stringify(obj)
      })
    })
    
    attributes.value = result
  }
  
  // 打开文件
  const open = function(i: number){
    store.openFileByMode(data.value[i])
  }
  
  // 打开文件夹
  const openFolder = function(path: string){
    store.addRoot(path)
    init()
  }
  
  // 智能识别数据类型
  const detectDataType = function(value: any): string {
    if (value === null || value === undefined || value === '') return 'text'
    
    // 检查是否是布尔值
    if (typeof value === 'boolean') return 'checkbox'
    
    // 检查字符串值
    if (typeof value === 'string') {
      const str = value.trim()
      
      // 检查布尔值字符串
      const lowerStr = str.toLowerCase()
      if (lowerStr === 'true' || lowerStr === 'false' || 
          lowerStr === '是' || lowerStr === '否' ||
          lowerStr === '1' || lowerStr === '0' || 
          lowerStr === 'yes' || lowerStr === 'no') {
        return 'checkbox'
      }
      
      // 检查ISO日期时间格式 (如：2022-11-25T14:57:39.000Z)
      const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/
      if (isoDateRegex.test(str)) {
        return 'datetime-local' // 改为 datetime-local 以支持时间
      }
      
      // 检查标准日期格式
      const datePatterns = [
        /^\d{4}-\d{2}-\d{2}$/,
        /^\d{4}\/\d{2}\/\d{2}$/,
        /^\d{4}年\d{2}月\d{2}日$/
      ]
      for (const pattern of datePatterns) {
        if (pattern.test(str)) {
          return 'date'
        }
      }
      
      // 检查时间格式
      const timePattern = /^\d{2}:\d{2}(:\d{2})?$/
      if (timePattern.test(str)) {
        return 'time'
      }
      
      // 检查是否是数字
      if (!isNaN(Number(str)) && str !== '' && str.trim() !== '') {
        // 排除空字符串和空格
        return 'number'
      }
    }
    
    // 检查是否是日期对象
    if (value instanceof Date) return 'datetime-local'
    
    // 检查是否是数字
    if (typeof value === 'number') return 'number'
    
    return 'text'
  }
  
  // 获取输入框类型
  const getInputType = function(attr: string, value: any){
    const detectedType = detectDataType(value)
    
    // 根据属性名给予提示（但不强制）
    const attrLower = attr.toLowerCase()
    if (attr === '状态' || attr === '完成' || attrLower.includes('status')) {
      return 'checkbox'
    } else if (attr === '日期' || attr === 'date' || attrLower.includes('date')) {
      return 'date'
    } else if (attr === '时间' || attr === 'time' || attrLower.includes('time')) {
      return 'time'
    } else if (attrLower.includes('datetime') || attrLower.includes('timestamp')) {
      return 'datetime-local'
    }
    
    return detectedType
  }
  
  // 转换值为标准格式
  const normalizeValue = function(value: any, inputType: string): any {
    if (value === null || value === undefined || value === '') return ''
    
    switch (inputType) {
      case 'checkbox':
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
          const str = value.trim().toLowerCase()
          if (str === 'true' || str === '是' || str === '1' || str === 'yes') return true
          if (str === 'false' || str === '否' || str === '0' || str === 'no') return false
        }
        return Boolean(value)
        
      case 'date':
        if (value instanceof Date) {
          const year = value.getFullYear()
          const month = ('0' + (value.getMonth() + 1)).slice(-2)
          const day = ('0' + value.getDate()).slice(-2)
          return `${year}-${month}-${day}`
        }
        if (typeof value === 'string') {
          const str = value.trim()
          // 处理ISO格式
          if (str.includes('T')) {
            try {
              const date = new Date(str)
              const year = date.getFullYear()
              const month = ('0' + (date.getMonth() + 1)).slice(-2)
              const day = ('0' + date.getDate()).slice(-2)
              return `${year}-${month}-${day}`
            } catch (e) {
              return str
            }
          }
          return str
        }
        return value
        
      case 'time':
        if (typeof value === 'string') return value.trim()
        return value
        
      case 'datetime-local':
        if (value instanceof Date) {
          const year = value.getFullYear()
          const month = ('0' + (value.getMonth() + 1)).slice(-2)
          const day = ('0' + value.getDate()).slice(-2)
          const hours = ('0' + value.getHours()).slice(-2)
          const minutes = ('0' + value.getMinutes()).slice(-2)
          const seconds = ('0' + value.getSeconds()).slice(-2)
          return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
        }
        if (typeof value === 'string') {
          const str = value.trim()
          // 处理ISO格式
          if (str.includes('T')) {
            try {
              const date = new Date(str)
              const year = date.getFullYear()
              const month = ('0' + (date.getMonth() + 1)).slice(-2)
              const day = ('0' + date.getDate()).slice(-2)
              const hours = ('0' + date.getHours()).slice(-2)
              const minutes = ('0' + date.getMinutes()).slice(-2)
              const seconds = ('0' + date.getSeconds()).slice(-2)
              return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
            } catch (e) {
              return str
            }
          }
          return str
        }
        return value
        
      case 'number':
        if (typeof value === 'number') return value
        const num = Number(value)
        return isNaN(num) ? value : num
        
      default:
        return value
    }
  }
  
  // 保存属性修改
  const saveAttribute = async function(index: number, attribute: string, value: any, inputType?: string){
    
    const file = data.value[index]
    if (!file) {
      console.error('文件信息不完整:', file)
      return
    }
    
    // 获取文件路径 - 使用正确的属性名
    const filePath = file.fullPath || file.path
    if (!filePath) {
      console.error('文件路径不存在:', file)
      return
    }
    
    try {
      
      // 根据输入类型规范化值
      const inputTypeToUse = inputType || getInputType(attribute, value)
      const normalizedValue = normalizeValue(value, inputTypeToUse)
      
      // 直接构建配置对象，而不是先获取
      let config: Record<string, any> = {}
      
      // 保留现有属性（除了当前修改的属性）
      if (file.attributes) {
        config = { ...file.attributes }
      }
      
      // 更新配置
      if (normalizedValue === '' || normalizedValue === null || normalizedValue === undefined) {
        delete config[attribute]
      } else {
        config[attribute] = normalizedValue
      }
      
      // 保存到文件
      const success = await window.ipcRenderer.invoke('saveFileMetadata', filePath, config)
      
      if (success) {
        // 更新本地数据
        if (!data.value[index].attributes) {
          data.value[index].attributes = {}
        }
        
        if (normalizedValue === '' || normalizedValue === null || normalizedValue === undefined) {
          delete data.value[index].attributes[attribute]
        } else {
          data.value[index].attributes[attribute] = normalizedValue
        }
        
        // 如果是新增的属性，需要更新属性列表
        if (!attributes.value.includes(attribute) && normalizedValue !== '' && 
            normalizedValue !== null && normalizedValue !== undefined) {
          attributes.value.push(attribute)
        }
        
        console.log(`属性保存成功: ${file.label} - ${attribute} = ${normalizedValue}`)
        
        // 退出编辑模式
        editRowIndex.value = null
        editAttributeName.value = ''
        
        // 强制重新渲染
        data.value = [...data.value]
        
        // 重新获取属性列表
        getAttributes()
      } else {
        console.error(`属性保存失败: ${file.label} - ${attribute}`)
        ElMessage.error(`保存失败，请检查控制台日志`)
      }
      
    } catch (error: any) {
      console.error('保存属性失败:', error)
      ElMessage.error(`保存失败: ${error.message || '未知错误'}`)
    }
  }
  
  // 格式化属性显示 - 添加文本截断功能
  const formatAttributeDisplay = function(value: any, maxLength: number = 20){
    if (value === null || value === undefined || value === '') return ''
    
    // 布尔值显示
    if (typeof value === 'boolean') {
      return value ? '✓' : ''
    }
    
    // 日期格式化 - 修改为显示完整年月日
    if (value instanceof Date) {
      const year = value.getFullYear()
      const month = ('0' + (value.getMonth() + 1)).slice(-2)
      const day = ('0' + value.getDate()).slice(-2)
      const hours = ('0' + value.getHours()).slice(-2)
      const minutes = ('0' + value.getMinutes()).slice(-2)
      // 显示格式：YYYY-MM-DD HH:MM
      return `${year}-${month}-${day} ${hours}:${minutes}`
    }
    
    // 字符串日期处理
    if (typeof value === 'string') {
      // ISO日期时间格式处理 (如：2022-11-25T14:57:39.000Z)
      if (value.includes('T')) {
        try {
          const date = new Date(value)
          const year = date.getFullYear()
          const month = ('0' + (date.getMonth() + 1)).slice(-2)
          const day = ('0' + date.getDate()).slice(-2)
          const hours = ('0' + date.getHours()).slice(-2)
          const minutes = ('0' + date.getMinutes()).slice(-2)
          return `${year}-${month}-${day} ${hours}:${minutes}`
        } catch (e) {
          // 如果解析失败，返回原始值
        }
      }
      
      // 标准日期格式显示为 YYYY-MM-DD
      const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (dateMatch) {
        return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
      }
      
      // 时间格式显示
      const timeMatch = value.match(/^(\d{2}):(\d{2})(:(\d{2}))?$/)
      if (timeMatch) {
        return `${timeMatch[1]}:${timeMatch[2]}`
      }
    }
    
    // 通用字符串处理 - 添加截断功能
    const strValue = String(value)
    if (strValue.length > maxLength) {
      return strValue.substring(0, maxLength) + '...'
    }
    
    return strValue
  }
  
  // 获取完整文本（用于title提示）
  const getFullText = function(value: any): string {
    if (value === null || value === undefined || value === '') return ''
    
    // 布尔值显示
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    
    // 日期对象
    if (value instanceof Date) {
      return value.toISOString()
    }
    
    return String(value)
  }
  
  // 处理单元格点击
  const handleCellClick = async function(index: number, attribute: string, event: MouseEvent){
    // 检查是否为 markdown 文件
    const file = data.value[index]
    if (!isMarkdownFile(file)) {
      // 非 markdown 文件，禁止编辑
      event.preventDefault()
      return
    }
    
    // 设置当前编辑的行和属性
    editRowIndex.value = index
    editAttributeName.value = attribute
    
    // 等待Vue完成DOM更新
    await nextTick()
    
    // 查找并聚焦输入框
    const cell = event.currentTarget as HTMLElement
    if (!cell) return
    
    // 给DOM一点时间渲染
    setTimeout(() => {
      const input = cell.querySelector('input')
      if (input) {
        input.focus()
        
        // 如果是日期/时间类型，显示选择器
        if (input.type === 'date' || input.type === 'time' || input.type === 'datetime-local') {
          try {
            input.showPicker?.()
          } catch (e) {
            // 某些浏览器可能不支持showPicker
            console.log('showPicker not supported')
          }
        }
      } else {
        console.warn('找不到输入框，请检查DOM结构')
      }
    }, 50)
  }
  
  // 处理输入框变化
  const handleInputChange = function(index: number, attribute: string, event: Event, inputType?: string){
    const target = event.target as HTMLInputElement
    let value: any
    
    if (inputType === 'checkbox') {
      value = target.checked
    } else {
      value = target.value
    }
    
    console.log('输入框变化:', { index, attribute, value, inputType })
    
    // 对于复选框，立即保存
    if (inputType === 'checkbox') {
      saveAttribute(index, attribute, value, inputType)
    }
    // 对于其他类型，等待失去焦点或回车
  }
  
  // 处理输入框失去焦点
  const handleInputBlur = function(index: number, attribute: string, event: Event, inputType?: string){
    const target = event.target as HTMLInputElement
    let value: any
    
    if (inputType === 'checkbox') {
      value = target.checked
    } else {
      value = target.value
    }
    
    console.log('输入框失去焦点:', { index, attribute, value, inputType })
    
    // 如果值为空，删除该属性
    if (value === '' || value === null || value === undefined) {
      saveAttribute(index, attribute, '')
    } else {
      saveAttribute(index, attribute, value, inputType)
    }
  }
  
  // 处理回车键
  const handleKeyPress = function(index: number, attribute: string, event: KeyboardEvent, inputType?: string){
    if (event.key === 'Enter') {
      const target = event.target as HTMLInputElement
      let value: any
      
      if (inputType === 'checkbox') {
        value = target.checked
      } else {
        value = target.value
      }
      
      console.log('回车键保存:', { index, attribute, value, inputType })
      
      saveAttribute(index, attribute, value, inputType)
      target.blur() // 失去焦点，退出编辑模式
    }
  }
  
  // 添加新属性列
  const addAttributeColumn = async function(){
    try {
      const { value } = await ElMessageBox.prompt('请输入新属性名称:', '添加属性列', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPattern: /.+/,
        inputErrorMessage: '名称不能为空'
      })
      const attrName = value.trim()
      if (!attributes.value.includes(attrName)) {
        attributes.value.push(attrName)
      }
    } catch { /* 用户取消 */ }
  }
  
  // 清除搜索
  const clearSearch = function(){
    searchQuery.value = ''
  }
  
  // ---- 悬浮提示（跟随鼠标显示文件信息，参考 view_file.vue） ----
  const tooltipVisible = ref(false)
  const tooltipPos = ref({ x: 0, y: 0 })
  const tooltipData = ref<any>(null)
  let tipSize = { w: 0, h: 0 }

  /** 格式化文件大小（字节 → B/KB/MB/GB） */
  const formatSize = function(size?: number): string {
    if (size == null || size < 0) return ''
    if (size < 1024) return size + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = size / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
    return value.toFixed(1) + ' ' + units[i]
  }

  /** 格式化修改时间（时间戳 → yyyy-MM-dd HH:mm） */
  const formatTime = function(mtime?: number): string {
    if (!mtime) return ''
    const d = new Date(mtime)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** 鼠标移入文件名时显示提示（首次显示时测量尺寸） */
  const showTooltip = (e: MouseEvent, data: any) => {
    tooltipData.value = data
    if (!tooltipVisible.value) {
      tooltipVisible.value = true
      nextTick(() => {
        const el = document.querySelector('.table-tooltip') as HTMLElement | null
        if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
        updateTooltipPos(e)
      })
    }
    updateTooltipPos(e)
  }

  /** 鼠标移动时更新提示位置：悬浮框在鼠标右上方（鼠标位于悬浮框左下角），超出视口时翻转 */
  const updateTooltipPos = (e: MouseEvent) => {
    if (!tooltipVisible.value) return
    let x = e.clientX
    let y = e.clientY - tipSize.h
    if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w
    if (tipSize.h && y < 4) y = e.clientY
    tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
  }

  /** 鼠标移出时隐藏提示 */
  const hideTooltip = () => {
    tooltipVisible.value = false
    tooltipData.value = null
  }
  
  watch(() => store.root, () => {
    init()
  })

  onMounted(() => {
    init()
  })
</script>

<template>
  <div class="bg">
    <!-- 表格内容区域 -->
    <div class="tab_content scoll">
      <table>
        <thead>
          <tr>
            <th class="fixed-col index">#</th>
            <th class="fixed-col action">操作</th>
            <th class="fixed-col name">文件名</th>
            <th v-for="(attr, attrIndex) in attributes" :key="attrIndex" class="attribute-col">
              <div class="attribute-header">
                <span :title="attr">{{ attr }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(node, index) in filteredData"
            :key="node.fullPath || node.path || index"
            :class="{ 'hover-row': index === editRowIndex }"
          >
            <!-- 序号列 -->
            <td class="fixed-col index">
              <span>{{ Number(index) + 1 }}</span>
            </td>
            
            <!-- 操作列 -->
            <td class="fixed-col action">
              <div class="action-buttons">
                <i 
                  class="fa fa-folder-open folder-icon" 
                  v-if="node.isFolder"
                  @click="openFolder(node.fullPath || node.path)"
                  title="打开文件夹"
                ></i>
                <i 
                  :class="store.icon(node.extension)" 
                  @click="open(Number(index))"
                  :title="node.isFolder ? '打开文件夹' : '打开文件'"
                ></i>
              </div>
            </td>
            
            <!-- 文件名列 -->
            <td class="fixed-col name"
                @mouseover="showTooltip($event, node)"
                @mousemove="updateTooltipPos($event)"
                @mouseleave="hideTooltip">
              <span class="filename-text">{{ node.label }}</span>
            </td>
            
            <!-- 属性列 -->
            <td 
              v-for="(attr, attrIndex) in attributes" 
              :key="attrIndex"
              class="attribute-col"
              :class="{ 'disabled-cell': !isMarkdownFile(node) }"
              @click="handleCellClick(Number(index), attr, $event)"
            >
              <!-- 只读模式显示 -->
              <div 
                v-if="!(Number(index) === editRowIndex && editAttributeName === attr)"
                class="attribute-value"
                :class="{
                  'status-true': node.attributes && node.attributes[attr] === true,
                  'status-false': node.attributes && node.attributes[attr] === false,
                  'date-value': getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'date',
                  'datetime-value': getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'datetime-local',
                  'time-value': getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'time',
                  'number-value': getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'number',
                  'text-value': getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'text',
                  'empty-value': !(node.attributes && node.attributes[attr]) && node.attributes && node.attributes[attr] !== false && node.attributes && node.attributes[attr] !== 0
                }"
                :title="isMarkdownFile(node) ? getFullText(node.attributes ? node.attributes[attr] : '') : '非Markdown文件，禁止编辑'"
              >
                <template v-if="node.attributes && node.attributes[attr] !== undefined && node.attributes[attr] !== null && node.attributes[attr] !== ''">
                  {{ formatAttributeDisplay(node.attributes[attr]) }}
                </template>
                <template v-else>
                  <span v-if="isMarkdownFile(node)" class="add-hint">点击添加</span>
                  <span v-else class="disabled-hint">禁止编辑</span>
                </template>
              </div>
              
              <!-- 编辑模式输入框 - 只在 markdown 文件中显示 -->
              <div 
                v-if="Number(index) === editRowIndex && editAttributeName === attr && isMarkdownFile(node)"
                class="edit-input"
              >
                <!-- 复选框 -->
                <input
                  v-if="getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'checkbox'"
                  type="checkbox"
                  :checked="node.attributes && node.attributes[attr] === true"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'checkbox')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'checkbox')"
                  class="checkbox-input"
                  autofocus
                />
                
                <!-- 日期选择器 -->
                <input
                  v-else-if="getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'date'"
                  type="date"
                  :value="normalizeValue(node.attributes ? node.attributes[attr] : '', 'date')"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'date')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'date')"
                  @keypress="(e: KeyboardEvent) => handleKeyPress(Number(index), attr, e, 'date')"
                  class="date-input"
                  autofocus
                />
                
                <!-- 时间选择器 -->
                <input
                  v-else-if="getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'time'"
                  type="time"
                  :value="normalizeValue(node.attributes ? node.attributes[attr] : '', 'time')"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'time')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'time')"
                  @keypress="(e: KeyboardEvent) => handleKeyPress(Number(index), attr, e, 'time')"
                  class="time-input"
                  autofocus
                />
                
                <!-- 日期时间选择器 -->
                <input
                  v-else-if="getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'datetime-local'"
                  type="datetime-local"
                  :value="normalizeValue(node.attributes ? node.attributes[attr] : '', 'datetime-local')"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'datetime-local')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'datetime-local')"
                  @keypress="(e: KeyboardEvent) => handleKeyPress(Number(index), attr, e, 'datetime-local')"
                  class="datetime-input"
                  autofocus
                />
                
                <!-- 数字输入框 -->
                <input
                  v-else-if="getInputType(attr, node.attributes ? node.attributes[attr] : '') === 'number'"
                  type="number"
                  :value="node.attributes ? node.attributes[attr] : ''"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'number')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'number')"
                  @keypress="(e: KeyboardEvent) => handleKeyPress(Number(index), attr, e, 'number')"
                  class="number-input"
                  autofocus
                />
                
                <!-- 文本输入框 -->
                <input
                  v-else
                  type="text"
                  :value="node.attributes ? node.attributes[attr] : ''"
                  @change="(e: Event) => handleInputChange(Number(index), attr, e, 'text')"
                  @blur="(e: Event) => handleInputBlur(Number(index), attr, e, 'text')"
                  @keypress="(e: KeyboardEvent) => handleKeyPress(Number(index), attr, e, 'text')"
                  placeholder="输入值"
                  class="text-input"
                  autofocus
                />
              </div>
            </td>
          </tr>
          
          <!-- 空状态 -->
          <tr v-if="filteredData.length === 0" class="empty-row">
            <td :colspan="attributes.length + 3" class="empty-cell">
              <div class="empty-state">
                <i class="fa fa-inbox"></i>
                <p>{{ searchQuery ? '没有找到匹配的结果' : '暂无数据' }}</p>
                <p v-if="searchQuery" class="search-hint">尝试使用不同的关键词搜索</p>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 底部状态栏：搜索 / 返回上级 / 添加属性列 / 计数 -->
    <div class="table-statusbar">
      <div class="table-search">
        <i class="fa fa-search table-search-icon"></i>
        <input v-model="searchQuery" :placeholder="store.locales==='zh'?'搜索文件名或属性…':'Search…'"/>
        <i v-if="searchQuery" class="fa fa-times table-clear-icon" @click="clearSearch" :title="store.locales==='zh'?'清除搜索':'Clear'"></i>
      </div>
      <span class="statusbar-spacer"></span>
      <button class="statusbar-btn" @click="store.backPath()" :title="store.locales==='zh'?'返回上一级':'Go up'"><i class="fa fa-arrow-up"></i></button>
      <button class="statusbar-btn" @click="addAttributeColumn()" :title="store.locales==='zh'?'添加属性列':'Add column'"><i class="fa fa-plus"></i> {{ store.locales==='zh'?'列':'Col' }}</button>
      <span class="statusbar-item"><i class="fa fa-columns"></i> {{ attributes.length }}</span>
      <span class="statusbar-item table-count" :title="store.locales==='zh'?('共 '+data.length+' 条'):('Total '+data.length)">
        {{ searchQuery ? filteredData.length + ' / ' + data.length : data.length }}
      </span>
    </div>

    <!-- 悬浮提示（跟随鼠标显示文件信息） -->
    <div v-if="tooltipVisible && tooltipData" class="table-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.type !== 'folder' && tooltipData.size != null">{{ store.locales=='zh'?'大小':'Size' }}: {{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime">{{ store.locales=='zh'?'修改时间':'Modified' }}: {{ formatTime(tooltipData.mtime) }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 保持原有的CSS样式不变 */
.bg {
  width: 100%;
  height: 100%;
  padding: 0;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
  box-sizing: border-box;
}

/* 顶部菜单精简：重置列表默认留白 */
.menu {
  margin: 0;
  padding: 0;
  width: 100%;
}
.menu ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  align-items: center;
  width: 100%;
}
.menu li {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  align-items: center;
  width: 100%;
}

.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.search-icon {
  position: absolute;
  left: 8px;
  color: var(--fontColor);
  opacity: 0.6;
  font-size: 12px;
  pointer-events: none;
}

.search {
  width: 100%;
  padding: 3px 28px 3px 24px;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
  transition: all 0.2s;
  box-sizing: border-box;
  height: 24px;
}

.search:focus {
  border-color: var(--primaryColor);
  box-shadow: 0 0 0 1px rgba(var(--primaryColor-rgb, 0, 123, 255), 0.2);
}

.search::placeholder {
  color: var(--borderColor);
  font-size: 11px;
}

.clear-icon {
  position: absolute;
  right: 8px;
  color: var(--fontColor);
  opacity: 0.6;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.clear-icon:hover {
  opacity: 1;
  color: var(--primaryColor);
}

.search-info {
  padding: 6px 12px;
  background: rgba(var(--primaryColor-rgb, 0, 123, 255), 0.08);
  color: var(--primaryColor);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid rgba(var(--primaryColor-rgb, 0, 123, 255), 0.15);
}

.search-info i {
  font-size: 12px;
}

.tab_content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
  background: var(--backgroundColor);
}

table {
  width: 100%;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}

thead {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--menuColor);
}

thead th {
  padding: 6px 4px;
  text-align: left;
  font-weight: 600;
  color: var(--fontActiveColor);
  border-bottom: 2px solid var(--borderColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 32px;
  vertical-align: middle;
}

.fixed-col {
  position: sticky;
  background: inherit;
  z-index: 5;
}

.fixed-col.index {
  left: 0;
  width: 35px;
  min-width: 35px;
  text-align: center;
  padding: 0 2px !important;
}

.fixed-col.action {
  left: 35px;
  width: 40px;
  min-width: 40px;
  text-align: center;
  padding: 0 2px !important;
}

.fixed-col.name {
  left: 75px;
  width: 120px;
  min-width: 120px;
  max-width: 120px;
  padding: 0 6px !important;
}

.attribute-col {
  min-width: 80px;
  max-width: 120px;
  width: auto;
  padding: 0 !important;
  cursor: pointer;
  position: relative;
  height: 32px;
  overflow: hidden;
}

.attribute-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 0 4px;
}

.attribute-header span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  white-space: nowrap;
}

tbody tr {
  border-bottom: 1px solid rgba(var(--borderColor-rgb, 128, 128, 128), 0.1);
  transition: background-color 0.2s;
  height: 32px;
}

tbody tr:hover {
  background-color: var(--menuHoverColor);
}

tbody tr.hover-row {
  background-color: rgba(var(--primaryColor-rgb, 0, 123, 255), 0.05);
}

td {
  padding: 0;
  text-align: left;
  vertical-align: middle;
  border-bottom: 1px solid rgba(var(--borderColor-rgb, 128, 128, 128), 0.1);
  height: 32px;
  max-height: 32px;
  overflow: hidden;
  white-space: nowrap;
}

/* 属性值显示 - 优化文本显示 */
.attribute-value {
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  line-height: 1.3;
  padding: 0 3px;
  height: 100%;
  width: 100%;
  transition: all 0.2s;
  cursor: pointer;
  text-align: center;
  word-break: break-all;
}

/* 文件名文本样式 */
.filename-text {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.3;
  padding: 0 2px;
  height: 100%;
  display: flex;
  align-items: center;
}

.status-true {
  color: #28a745;
  background: rgba(40, 167, 69, 0.08);
  font-weight: 500;
}

.status-false {
  color: #6c757d;
  opacity: 0.5;
}

.date-value {
  color: #17a2b8;
  font-family: monospace;
  font-size: 10px;
}

.datetime-value {
  color: #fd7e14;
  font-family: monospace;
  font-size: 10px;
}

.time-value {
  color: #20c997;
  font-family: monospace;
  font-size: 10px;
}

.number-value {
  color: #6f42c1;
  text-align: center;
  font-family: monospace;
  font-size: 11px;
}

/* 文本值样式 - 确保文本被截断 */
.text-value {
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-value {
  color: var(--borderColor);
  font-style: italic;
  opacity: 0.6;
}

.add-hint {
  color: var(--primaryColor);
  font-size: 10px;
  opacity: 0.7;
}

.action-buttons {
  display: flex;
  gap: 6px;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
}
.action-buttons i {
  cursor: pointer;  /* 添加手势图标 */
  font-size: 14px;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  color: var(--fontColor);
}
.folder-icon, .file-icon {
  cursor: pointer;
  font-size: 12px;
  padding: 2px;
  border-radius: 2px;
  transition: all 0.2s;
  color: var(--fontColor);
}

.folder-icon:hover {
  color: var(--primaryColor);
  background: rgba(var(--primaryColor-rgb, 0, 123, 255), 0.1);
}

.file-icon:hover {
  color: #28a745;
  background: rgba(40, 167, 69, 0.1);
}

.edit-input {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  padding: 0 2px;
  box-sizing: border-box;
}

.edit-input input {
  width: 100%;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--borderColor);
  border-radius: 2px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  outline: none;
  transition: all 0.2s;
  box-sizing: border-box;
  line-height: 24px;
}

.edit-input input:focus {
  border-color: var(--primaryColor);
  box-shadow: 0 0 0 1px rgba(var(--primaryColor-rgb, 0, 123, 255), 0.2);
}

.edit-input input.checkbox-input {
  width: auto;
  height: auto;
  margin: 0;
  transform: scale(0.9);
  cursor: pointer;
}

.edit-input input.date-input,
.edit-input input.datetime-input,
.edit-input input.time-input {
  font-family: monospace;
  font-size: 10px;
}

.edit-input input.datetime-input {
  min-width: 140px;
}

.edit-input input.number-input {
  text-align: right;
  font-family: monospace;
  font-size: 11px;
}

.empty-row {
  border-bottom: none;
}

.empty-cell {
  text-align: center;
  padding: 40px 20px !important;
  border-bottom: none;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--borderColor);
}

.empty-state i {
  font-size: 32px;
  opacity: 0.5;
}

.empty-state p {
  margin: 0;
  font-size: 12px;
}

.search-hint {
  font-size: 11px !important;
  opacity: 0.7;
}

.tab_content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.tab_content::-webkit-scrollbar-track {
  background: transparent;
}

.tab_content::-webkit-scrollbar-thumb {
  background-color: rgba(var(--borderColor-rgb, 128, 128, 128), 0.3);
  border-radius: 3px;
}

.tab_content::-webkit-scrollbar-thumb:hover {
  background-color: rgba(var(--borderColor-rgb, 128, 128, 128), 0.5);
}

/* 禁用编辑的单元格样式 */
.disabled-cell {
  cursor: not-allowed !important;
  opacity: 0.7;
}

.disabled-cell .attribute-value {
  cursor: not-allowed !important;
}

.disabled-hint {
  color: var(--borderColor);
  font-size: 10px;
  font-style: italic;
  opacity: 0.5;
}

/* 悬浮提示（跟随鼠标显示文件信息） */
.table-tooltip {
  position: fixed;
  z-index: 99999;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  line-height: 1.8;
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
  pointer-events: none;
  max-width: 60vw;
}
.table-tooltip .tooltip-name {
  white-space: normal;
  word-break: break-all;
  font-weight: bold;
  color: var(--fontColor);
}

@media (max-width: 768px) {
  .fixed-col.name {
    width: 100px;
    min-width: 100px;
    max-width: 100px;
  }
  
  .attribute-col {
    min-width: 70px;
    max-width: 100px;
  }
}

/* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
.table-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  box-sizing: border-box;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.table-statusbar .statusbar-item { display: inline-flex; align-items: center; gap: 4px; opacity: 0.85; }
.table-statusbar .statusbar-item i { font-size: 11px; opacity: 0.7; }
.table-statusbar .statusbar-spacer { flex: 1; }
.table-statusbar .statusbar-btn {
  margin: 0; padding: 0 6px; height: 18px; border: none; border-radius: 3px; background: transparent;
  color: var(--fontColor); font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0.85; transition: background-color 0.15s; flex-shrink: 0;
}
.table-statusbar .statusbar-btn:hover { background: var(--menuActiveColor); opacity: 1; }
.table-statusbar .table-count { font-weight: 600; }

/* 底栏内嵌搜索框 */
.table-search {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.table-search input {
  width: 170px;
  height: 18px;
  padding: 0 22px 0 20px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  outline: none;
  box-sizing: border-box;
}
.table-search input:focus { border-color: var(--fontActiveColor); }
.table-search-icon {
  position: absolute;
  left: 6px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.6;
  pointer-events: none;
}
.table-clear-icon {
  position: absolute;
  right: 6px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.6;
  cursor: pointer;
}
.table-clear-icon:hover { opacity: 1; color: var(--fontActiveColor); }

/* 右键菜单样式统一在 explorer.vue 中定义 */
</style>