<template>
  <div class="colorPickerContainer">
    <div class="content">
      <div
        :placement="placement"
        :width="200"
        trigger="click"
        :disabled="colorList.length <= 0"
      >
        <div class="colorList">
          <div
            class="colorItem"
            v-for="item in colorList"
            :key="item"
            :style="{ backgroundColor: item }"
            @click="color = item"
          >
            <span v-if="!item">无</span>
            <span v-if="item === 'transparent'">T</span>
          </div>
        </div>
      </div>
    </div>
    <div>
      <input v-model="color" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  value: {
    type: String,
    default: ''
  },
  type: {
    type: String,
    default: ''
  },
  name: {
    type: String,
    default: '颜色'
  },
  placement: {
    type: String,
    default: 'bottom'
  },
  showEmptySelect: {
    type: Boolean,
    default: false
  }
})

// 描边颜色
const strokeColorList = [
  '#000000',
  '#343a40',
  '#cccccc',
  '#c92a2a',
  '#a61e4d',
  '#862e9c',
  '#5f3dc4',
  '#364fc7',
  '#1864ab',
  '#0b7285',
  '#087f5b',
  '#2b8a3e',
  '#5c940d',
  '#e67700',
  '#d9480f'
]

// 填充颜色
const fillColorList = [
  'transparent',
  '#ced4da',
  '#868e96',
  '#fa5252',
  '#e64980',
  '#be4bdb',
  '#7950f2',
  '#4c6ef5',
  '#228be6',
  '#15aabf',
  '#12b886',
  '#40c057',
  '#82c91e',
  '#fab005',
  '#fd7e14'
]

// 背景颜色
const backgroundColorList = [
  'rgb(255, 255, 255)',
  'rgb(248, 249, 250)',
  'rgb(241, 243, 245)',
  'rgb(255, 245, 245)',
  'rgb(255, 240, 246)',
  'rgb(248, 240, 252)',
  'rgb(243, 240, 255)',
  'rgb(237, 242, 255)',
  'rgb(231, 245, 255)',
  'rgb(227, 250, 252)',
  'rgb(230, 252, 245)',
  'rgb(235, 251, 238)',
  'rgb(244, 252, 227)',
  'rgb(255, 249, 219)',
  'rgb(255, 244, 230)'
]


const emits = defineEmits(['change'])

const color = ref(props.value)
watch(
  () => {
    return props.value
  },
  val => {
    color.value = val
  }
)
const colorList = computed(() => {
  let list = props.showEmptySelect ? [''] : []
  switch (props.type) {
    case 'stroke':
      list.push(...strokeColorList)
      break
    case 'fill':
      list.push(...fillColorList)
      break
    case 'background':
      list.push(...backgroundColorList)
      break
    default:
  }
  return list
})
watch(color, () => {
  emits('change', color.value)
})
</script>

<style scoped>
  .colorPickerContainer{
    position: relative;
  }
  .content {
    display: flex;
    align-items: center;
  }
  .colorList {
    display: grid;
    grid-template-columns: repeat(5, auto);
    grid-gap: 5px;
    
  }
  .colorItem {
    width: 20px;
    height: 20px;
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid var(--borderColor);
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 12px;
    color: #909399;
  }
  input{
    margin-top: 5px;
  }
</style>
