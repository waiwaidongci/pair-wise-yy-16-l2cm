<script setup lang="ts">
import type { DeviationSummary } from '../types/firing'

defineProps<{
  summary: DeviationSummary
  offsetMin: number
}>()

const emit = defineEmits<{
  updateOffset: [value: number]
}>()
</script>

<template>
  <section class="deviation-panel">
    <div class="deviation-heading">
      <div><strong>记录仪偏差</strong><span>实际温度按统一时间轴与目标曲线插值比较</span></div>
      <label>
        <span>时间偏移</span>
        <input
          type="number"
          step="0.5"
          :value="offsetMin"
          @change="emit('updateOffset', Number(($event.target as HTMLInputElement).value))"
        />
        <small>min</small>
      </label>
    </div>
    <div v-if="summary.sampleCount" class="deviation-grid">
      <div><span>平均绝对偏差</span><strong>{{ summary.meanAbs.toFixed(1) }} ℃</strong></div>
      <div><span>最大绝对偏差</span><strong>{{ summary.maxAbs.toFixed(1) }} ℃</strong></div>
      <div><span>最大偏差时刻</span><strong>{{ (summary.maxAtMin / 60).toFixed(2) }} h</strong></div>
      <div><span>该点目标 / 实际</span><strong>{{ summary.maxTarget.toFixed(0) }} / {{ summary.maxActual.toFixed(0) }} ℃</strong></div>
    </div>
    <div v-else class="deviation-empty">
      尚未导入实际温度记录。可在窑次管理页导入 CSV，字段为 time,temp。
    </div>
  </section>
</template>

<style scoped>
.deviation-panel { padding: 14px 16px; }
.deviation-heading { display: flex; align-items: flex-start; justify-content: space-between; }
.deviation-heading strong, .deviation-heading > div > span { display: block; }
.deviation-heading strong { color: #3f514e; font-size: 13px; }
.deviation-heading > div > span { margin-top: 3px; color: #899995; font-size: 10px; }
.deviation-heading label { display: flex; align-items: center; gap: 5px; color: #81918d; font-size: 10px; }
.deviation-heading input { width: 68px; height: 30px; padding: 0 7px; border: 1px solid #cad6d2; border-radius: 5px; color: #3f5550; }
.deviation-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
.deviation-grid div { padding: 10px; border-radius: 7px; background: #f2f6f5; }
.deviation-grid span, .deviation-grid strong { display: block; }
.deviation-grid span { color: #82918d; font-size: 9px; }
.deviation-grid strong { margin-top: 4px; color: #315d5b; font-size: 13px; }
.deviation-empty { margin-top: 11px; padding: 11px; border-radius: 7px; background: #f5f7f6; color: #85938f; font-size: 10px; }
</style>
