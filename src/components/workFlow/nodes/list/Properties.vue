<!-- nodes/list/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('list_input') }}</label>
      <div class="property-input">
        <input type="text" :value="cfg.inputList" @input="save({ inputList: ($event.target as HTMLInputElement).value })"
          :placeholder="`{{${t('data_node')}.rows}} 或 [1,2,3]`" />
      </div>
    </div>

    <!-- 操作步骤 -->
    <div class="property-row" style="flex-direction:column;align-items:stretch;">
      <label class="property-label">{{ t('list_operations') }}</label>
      <div class="ops-list">
        <div v-for="(op, idx) in cfg.operations || []" :key="idx" class="op-item">
          <div class="op-head">
            <span class="op-index">{{ idx + 1 }}</span>
            <select :value="op.op" @change="onOpField(idx, 'op', ($event.target as HTMLSelectElement).value)" style="flex:1;">
              <option value="filter">过滤 filter</option>
              <option value="extract">提取字段 extract</option>
              <option value="sort">排序 sort</option>
              <option value="limit">截取前N limit</option>
              <option value="unique">去重 unique</option>
              <option value="slice">区间 slice</option>
            </select>
            <button class="wf-btn small" :title="t('iteration_inner_up')" @click="moveOp(idx, -1)"><i class="fa fa-arrow-up"></i></button>
            <button class="wf-btn small" :title="t('iteration_inner_down')" @click="moveOp(idx, 1)"><i class="fa fa-arrow-down"></i></button>
            <button class="wf-btn danger small" :title="t('delete_template')" @click="removeOp(idx)"><i class="fa fa-times"></i></button>
          </div>
          <div class="op-body">
            <template v-if="op.op === 'filter'">
              <div class="op-grid">
                <input type="text" :value="op.field" placeholder="字段(可空)" @input="onOpField(idx, 'field', ($event.target as HTMLInputElement).value)" />
                <select :value="op.operator" @change="onOpField(idx, 'operator', ($event.target as HTMLSelectElement).value)">
                  <option value="eq">等于</option>
                  <option value="neq">不等于</option>
                  <option value="contains">包含</option>
                  <option value="gt">大于</option>
                  <option value="gte">大于等于</option>
                  <option value="lt">小于</option>
                  <option value="lte">小于等于</option>
                  <option value="is_empty">为空</option>
                  <option value="is_not_empty">非空</option>
                  <option value="exists">存在</option>
                </select>
                <input type="text" :value="op.value" placeholder="值" @input="onOpField(idx, 'value', ($event.target as HTMLInputElement).value)" />
              </div>
            </template>
            <template v-else-if="op.op === 'extract'">
              <input type="text" :value="(op.fields || []).join(',')" placeholder="字段1,字段2" @input="onOpField(idx, 'fields', ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))" />
            </template>
            <template v-else-if="op.op === 'sort'">
              <div class="op-grid">
                <input type="text" :value="op.field" placeholder="字段" @input="onOpField(idx, 'field', ($event.target as HTMLInputElement).value)" />
                <select :value="op.order" @change="onOpField(idx, 'order', ($event.target as HTMLSelectElement).value)">
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select>
              </div>
            </template>
            <template v-else-if="op.op === 'limit'">
              <input type="number" min="0" :value="op.n" placeholder="N" @input="onOpField(idx, 'n', Number(($event.target as HTMLInputElement).value) || 0)" />
            </template>
            <template v-else-if="op.op === 'unique'">
              <input type="text" :value="op.field" placeholder="字段(可空=整体去重)" @input="onOpField(idx, 'field', ($event.target as HTMLInputElement).value)" />
            </template>
            <template v-else-if="op.op === 'slice'">
              <div class="op-grid">
                <input type="number" :value="op.start" placeholder="start" @input="onOpField(idx, 'start', Number(($event.target as HTMLInputElement).value) || 0)" />
                <input type="number" :value="op.end" placeholder="end(可空)" @input="onOpField(idx, 'end', Number(($event.target as HTMLInputElement).value) >= 0 ? Number(($event.target as HTMLInputElement).value) : undefined)" />
              </div>
            </template>
          </div>
        </div>
        <button class="add-op-btn" @click="addOp"><i class="fa fa-plus"></i> {{ t('list_add_op') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import type { ListOpConfig, ListOpStep } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()

const cfg = computed<ListOpConfig>(() => props.node.listOpConfig || {})
const save = (patch: Partial<ListOpConfig>) => emit('update', { listOpConfig: { ...props.node.listOpConfig, ...patch } })

const addOp = () => {
  const ops = [...(cfg.value.operations || [])]
  ops.push({ op: 'filter', field: '', operator: 'eq', value: '' })
  save({ operations: ops })
}
const removeOp = (idx: number) => {
  const ops = [...(cfg.value.operations || [])]
  ops.splice(idx, 1)
  save({ operations: ops })
}
const moveOp = (idx: number, dir: number) => {
  const ops = [...(cfg.value.operations || [])]
  const target = idx + dir
  if (target < 0 || target >= ops.length) return
  const tmp = ops[idx]; ops[idx] = ops[target]; ops[target] = tmp
  save({ operations: ops })
}
const onOpField = (idx: number, key: string, value: any) => {
  const ops = [...(cfg.value.operations || [])]
  ops[idx] = { ...(ops[idx] as any), [key]: value } as ListOpStep
  save({ operations: ops })
}
</script>

<style scoped>
.ops-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.op-item { border: 1px solid var(--borderColor); border-radius: 5px; padding: 6px; background: rgba(0,0,0,0.02); }
.op-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.op-index { font-size: 11px; font-weight: 600; color: #00838F; width: 16px; }
.op-btn { border: 1px solid var(--borderColor); background: transparent; border-radius: 3px; cursor: pointer; font-size: 10px; padding: 2px 5px; }
.op-btn.danger:hover { color: #f44336; border-color: #f44336; }
.op-body input, .op-body select { font-size: 12px; }
.op-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.op-grid input, .op-grid select { font-size: 12px; }
.add-op-btn { border: 1px dashed var(--borderColor); background: transparent; border-radius: 5px; padding: 6px; cursor: pointer; font-size: 12px; color: var(--fontColor); }
.add-op-btn:hover { border-color: #00838F; color: #00838F; }
</style>
