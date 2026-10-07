<script setup lang="ts">
import { computed } from 'vue'
import type { FiringStage, RiskIssue } from '../types/firing'

const props = defineProps<{
  stages: FiringStage[]
  issues: RiskIssue[]
  selectedIndex: number | null
}>()

const emit = defineEmits<{
  select: [index: number]
  update: [index: number, field: 'duration' | 'targetTemp', value: number]
  addAfter: [index: number]
}>()

const selected = computed(() => props.selectedIndex === null ? null : props.stages[props.selectedIndex])

function stageIssue(index: number) {
  return props.issues.find((issue) => issue.stageIndex === index)
}

function stageLabel(type: FiringStage['type']) {
  return type === 'heat' ? '升温' : type === 'hold' ? '保温' : '降温'
}
</script>

<template>
  <section class="stage-panel">
    <div class="panel-heading">
      <div><strong>阶段参数</strong><span>{{ stages.length }} 个烧成阶段</span></div>
    </div>
    <div class="stage-list">
      <button
        v-for="stage in stages"
        :key="stage.id"
        type="button"
        class="stage-row"
        :class="[
          `stage-row--${stage.type}`,
          { 'stage-row--active': selectedIndex === stage.index, 'stage-row--risk': stageIssue(stage.index) },
        ]"
        @click="emit('select', stage.index)"
      >
        <span class="stage-index">{{ String(stage.index + 1).padStart(2, '0') }}</span>
        <span class="stage-main">
          <strong>{{ stageLabel(stage.type) }}</strong>
          <small>{{ stage.start.tempC }} → {{ stage.end.tempC }} ℃</small>
        </span>
        <span class="stage-duration">{{ stage.durationMin.toFixed(0) }} min</span>
        <span class="stage-rate">{{ Math.abs(stage.ratePerMin).toFixed(1) }} ℃/min</span>
        <i v-if="stageIssue(stage.index)" />
      </button>
    </div>

    <div v-if="selected" class="stage-editor">
      <div class="stage-editor__title">
        <strong>编辑阶段 {{ selected.index + 1 }}</strong>
        <span>{{ stageLabel(selected.type) }}</span>
      </div>
      <label>
        <span>到达温度（℃）</span>
        <input
          type="number"
          :value="selected.end.tempC"
          min="0"
          max="1450"
          @change="emit('update', selected.index, 'targetTemp', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label>
        <span>阶段时长（分钟）</span>
        <input
          type="number"
          :value="selected.durationMin.toFixed(1)"
          min="1"
          @change="emit('update', selected.index, 'duration', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <button type="button" class="outline-button" @click="emit('addAfter', selected.index)">在阶段中插入关键点</button>
      <div v-if="stageIssue(selected.index)" class="stage-risk">
        <strong>{{ stageIssue(selected.index)?.title }}</strong>
        <p>{{ stageIssue(selected.index)?.message }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stage-panel { display: flex; min-height: 0; flex-direction: column; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 11px; border-bottom: 1px solid #e6ddd8; }
.panel-heading strong, .panel-heading span { display: block; }
.panel-heading strong { color: #4a3128; font-family: "Songti SC", serif; font-size: 16px; }
.panel-heading span { margin-top: 2px; color: #9a8478; font-size: 10px; }
.stage-list { max-height: 340px; overflow: auto; }
.stage-row {
  display: grid;
  position: relative;
  width: 100%;
  min-height: 52px;
  align-items: center;
  padding: 7px 10px;
  border: 0;
  border-bottom: 1px solid #eee7e2;
  background: #fff;
  color: #5a4339;
  cursor: pointer;
  grid-template-columns: 28px 1fr 58px 68px 8px;
  text-align: left;
  transition: .15s ease;
}
.stage-row:hover { background: #faf6f3; }
.stage-row--active { background: #f8efe8; box-shadow: inset 3px 0 #b6532f; }
.stage-index { color: #a6958d; font-family: Menlo, monospace; font-size: 10px; }
.stage-main strong, .stage-main small { display: block; }
.stage-main strong { font-size: 12px; }
.stage-main small { margin-top: 2px; color: #9a8478; font-size: 9px; }
.stage-duration, .stage-rate { color: #7e685d; font-size: 10px; text-align: right; }
.stage-row i { width: 7px; height: 7px; border-radius: 50%; background: #cf5339; }
.stage-row--hold .stage-index { color: #a26b1d; }
.stage-row--cool .stage-index { color: #3f7680; }
.stage-editor { display: grid; gap: 9px; padding: 14px 16px 17px; background: #fbf8f5; border-top: 1px solid #e6ddd8; }
.stage-editor__title { display: flex; align-items: center; justify-content: space-between; }
.stage-editor__title strong { color: #5a3b2e; font-size: 12px; }
.stage-editor__title span { color: #a27964; font-size: 10px; }
.stage-editor label { display: grid; gap: 4px; color: #806a5e; font-size: 10px; }
.stage-editor input { height: 34px; padding: 0 10px; border: 1px solid #d9cbc1; border-radius: 6px; outline: 0; color: #4e362c; background: #fff; }
.stage-editor input:focus { border-color: #b6532f; box-shadow: 0 0 0 2px rgba(182,83,47,.1); }
.outline-button { height: 32px; border: 1px solid #d4c3b8; border-radius: 6px; background: #fff; color: #80523e; cursor: pointer; }
.stage-risk { padding: 10px; border: 1px solid #efc6b9; border-radius: 7px; background: #fff3ef; }
.stage-risk strong { color: #b14531; font-size: 11px; }
.stage-risk p { margin: 5px 0 0; color: #825b4c; font-size: 10px; line-height: 1.6; }
</style>
