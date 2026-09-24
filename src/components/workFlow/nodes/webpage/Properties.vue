<!-- nodes/webpage/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row" style="display: flex;">
      <label class="property-label">{{ store.locales=='zh'?'网址:':'URL:'}}</label>
      <input type="text" :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLInputElement).value)" :placeholder="t('input_url')" style="flex:1"/>
    </div>
    <div class="property-row" style="display: flex;">
      <label class="property-label">{{ store.locales=='zh'?'访问模式':'Visit Mode'}}</label>
      <select :value="node.webpageOptions?.visitMode ?? 'single'"
        @change="onWebpageOption('visitMode', ($event.target as HTMLSelectElement).value)" style="flex:1">
        <option value="single">{{ store.locales=='zh'?'单页':'Single'}}</option>
        <option value="followLinks">{{ store.locales=='zh'?'跟踪链接':'Follow Links'}}</option>
        <option value="pattern">{{ store.locales=='zh'?'模式':'Pattern'}}</option>
      </select>
    </div>
    <div v-if="node.webpageOptions?.visitMode === 'pattern'" class="property-row" style="display: flex;">
      <label class="property-label">{{ t('link_pattern') }}</label>
      <input type="text" style="flex:1"
        :value="node.webpageOptions?.patternTemplate ?? ''"
        @input="onWebpageOption('patternTemplate', ($event.target as HTMLInputElement).value)"
        :placeholder="t('link_pattern_placeholder')" />
    </div>
    <div v-if="node.webpageOptions?.visitMode === 'pattern'" class="property-row" style="display: flex; gap: 6px;">
      <label class="property-label">{{ t('pattern_start') }}</label>
      <input type="number" style="flex:1"
        :value="node.webpageOptions?.patternStart ?? 1"
        min="1" 
        @input="onWebpageOption('patternStart', Number(($event.target as HTMLInputElement).value) || 1)" />
    </div>
    <div v-if="node.webpageOptions?.visitMode === 'pattern'" class="property-row" style="display: flex; gap: 6px;">
      <label class="property-label">{{ t('pattern_end') }}</label>
      <input type="number" style="flex:1"
        :value="node.webpageOptions?.patternEnd ?? 10"
        min="1" 
        @input="onWebpageOption('patternEnd', Number(($event.target as HTMLInputElement).value) || 10)" />
    </div>
    <div v-if="node.webpageOptions?.visitMode === 'pattern'" class="property-row" style="display: flex;">
      <label class="property-label">{{ t('pattern_step') }}</label>
      <input type="number" style="flex:1"
        :value="node.webpageOptions?.patternStep ?? 1"
        min="1" @input="onWebpageOption('patternStep', Number(($event.target as HTMLInputElement).value))" />
    </div>
    <div class="property-row" style="display: flex;" v-if="node.webpageOptions?.visitMode === 'followLinks'">
      <label class="property-label">{{ store.locales=='zh'?'最大页面数':'Max Pages'}}</label>
      <input type="number" style="flex:1"
        :value="node.webpageOptions?.maxPages ?? 1"
        min="1" max="50" @input="onWebpageOption('maxPages', Number(($event.target as HTMLInputElement).value))" />
    </div>
    <div class="property-row"  style="display: flex;">
      <label class="property-label">{{ t('content_extraction_strategy') }}</label>
      <select :value="node.webpageOptions?.mainContentStrategy ?? 'textDensity'"
        @change="onWebpageOption('mainContentStrategy', ($event.target as HTMLSelectElement).value)" style="flex:1">
        <option value="simple">{{ t('strategy_simple') }}</option>
        <option value="textDensity">{{ t('strategy_text_density') }}</option>
        <option value="readability">{{ t('strategy_readability') }}</option>
      </select>
    </div>
    <div class="property-row" v-if="node.webpageOptions?.visitMode === 'followLinks'">
      <label class="property-label">{{ t('return_links') }}</label>
      <input type="checkbox"
        :checked="node.webpageOptions?.includeLinks ?? true"
        @change="onWebpageOption('includeLinks', ($event.target as HTMLInputElement).checked)" />
      <label class="property-label">{{ t('same_domain_only') }}</label>
      <input type="checkbox"
        :checked="node.webpageOptions?.sameDomainOnly ?? true"
        @change="onWebpageOption('sameDomainOnly', ($event.target as HTMLInputElement).checked)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import { usestore } from '@/store'
const store = usestore()


const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })

const onWebpageOption = (key: string, value: any) => {
  const options = {
    ...(props.node.webpageOptions || {}),
    [key]: value
  }
  emit('update', { webpageOptions: options })
}
</script>

<style scoped>

</style>

