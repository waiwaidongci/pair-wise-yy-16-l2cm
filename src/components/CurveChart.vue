<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FiringPoint, FiringSample, KilnSession } from '../types/firing'
import { sessionDomain, sortPoints } from '../utils/curve'

const props = withDefaults(
  defineProps<{
    sessions: KilnSession[]
    activeSessionId: string
    selectedPointId?: string | null
    interactive?: boolean
    showActual?: boolean
  }>(),
  {
    selectedPointId: null,
    interactive: true,
    showActual: true,
  },
)

const emit = defineEmits<{
  selectPoint: [pointId: string]
  updatePoint: [pointId: string, timeMin: number, tempC: number]
  beginDrag: []
  endDrag: []
}>()

const svgRef = ref<SVGSVGElement>()
const draggingId = ref<string | null>(null)
const width = 1060
const height = 520
const padding = { top: 26, right: 30, bottom: 54, left: 62 }
const plotWidth = width - padding.left - padding.right
const plotHeight = height - padding.top - padding.bottom
const domain = computed(() => sessionDomain(props.sessions))
const activeSession = computed(
  () => props.sessions.find((session) => session.id === props.activeSessionId) ?? props.sessions[0],
)

function xScale(timeMin: number) {
  return padding.left + (timeMin / domain.value.maxTime) * plotWidth
}

function yScale(tempC: number) {
  return padding.top + plotHeight - (tempC / domain.value.maxTemp) * plotHeight
}

function path(points: FiringPoint[]) {
  return sortPoints(points)
    .map((point, index) => `${index ? 'L' : 'M'} ${xScale(point.timeMin).toFixed(2)} ${yScale(point.tempC).toFixed(2)}`)
    .join(' ')
}

function samplePath(samples: FiringSample[]) {
  return samples
    .map((sample, index) => `${index ? 'L' : 'M'} ${xScale(sample.timeMin).toFixed(2)} ${yScale(sample.tempC).toFixed(2)}`)
    .join(' ')
}

const timeTicks = computed(() => {
  const step = domain.value.maxTime > 720 ? 120 : 60
  return Array.from({ length: Math.floor(domain.value.maxTime / step) + 1 }, (_, index) => index * step)
})
const tempTicks = computed(() => [0, 200, 400, 600, 800, 1000, 1200, 1400])

function localPoint(event: PointerEvent) {
  const svg = svgRef.value
  if (!svg) return { timeMin: 0, tempC: 0 }
  const rect = svg.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * width
  const y = ((event.clientY - rect.top) / rect.height) * height
  return {
    timeMin: Math.max(0, ((x - padding.left) / plotWidth) * domain.value.maxTime),
    tempC: Math.max(0, ((padding.top + plotHeight - y) / plotHeight) * domain.value.maxTemp),
  }
}

function startDrag(pointId: string, event: PointerEvent) {
  if (!props.interactive) return
  draggingId.value = pointId
  emit('selectPoint', pointId)
  emit('beginDrag')
  ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent) {
  if (!draggingId.value || !props.interactive) return
  const next = localPoint(event)
  emit('updatePoint', draggingId.value, next.timeMin, next.tempC)
}

function endDrag() {
  if (!draggingId.value) return
  draggingId.value = null
  emit('endDrag')
}

function sessionColor(index: number) {
  return ['#b6532f', '#447f8a', '#8a6d3b', '#76568c', '#3f8f58'][index % 5]
}
</script>

<template>
  <div class="curve-chart">
    <svg
      ref="svgRef"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      aria-label="窑炉目标曲线与实际温度曲线"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @pointerleave="endDrag"
    >
      <defs>
        <linearGradient id="heatZone" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#f4efe5" />
          <stop offset="1" stop-color="#f7e4d3" />
        </linearGradient>
        <filter id="pointShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#4a271d" flood-opacity=".28" />
        </filter>
      </defs>
      <rect :x="padding.left" :y="padding.top" :width="plotWidth" :height="plotHeight" fill="url(#heatZone)" rx="5" />

      <g class="grid-lines">
        <g v-for="tick in tempTicks" :key="`temp-${tick}`">
          <line :x1="padding.left" :x2="width - padding.right" :y1="yScale(tick)" :y2="yScale(tick)" />
          <text :x="padding.left - 12" :y="yScale(tick) + 4" text-anchor="end">{{ tick }}</text>
        </g>
        <g v-for="tick in timeTicks" :key="`time-${tick}`">
          <line :x1="xScale(tick)" :x2="xScale(tick)" :y1="padding.top" :y2="height - padding.bottom" />
          <text :x="xScale(tick)" :y="height - padding.bottom + 23" text-anchor="middle">{{ (tick / 60).toFixed(0) }}h</text>
        </g>
      </g>

      <g class="axis-labels">
        <text :x="padding.left - 42" :y="padding.top + 8">℃</text>
        <text :x="width - padding.right" :y="height - 15" text-anchor="end">烧成经过时间（小时）</text>
      </g>

      <g v-for="(session, index) in sessions" :key="session.id" class="curve-series">
        <path
          v-if="session.id !== activeSessionId"
          :d="path(session.points)"
          fill="none"
          :stroke="sessionColor(index + 1)"
          stroke-width="2"
          stroke-dasharray="7 5"
          opacity=".55"
          class="overlay-curve"
        />
        <path
          v-if="showActual && session.actualSamples.length"
          :d="samplePath(session.actualSamples)"
          fill="none"
          :stroke="session.id === activeSessionId ? '#2e6f76' : sessionColor(index + 1)"
          :stroke-width="session.id === activeSessionId ? 2.2 : 1.3"
          :opacity="session.id === activeSessionId ? .9 : .25"
          class="actual-curve"
        />
        <path
          v-if="session.id === activeSessionId"
          :d="path(session.points)"
          fill="none"
          :stroke="sessionColor(index)"
          stroke-width="3.2"
          class="target-curve"
        />
      </g>

      <g v-if="activeSession" class="point-layer">
        <g
          v-for="point in activeSession.points"
          :key="point.id"
          class="curve-point"
          :class="{ 'curve-point--selected': point.id === selectedPointId }"
        >
          <circle
            :cx="xScale(point.timeMin)"
            :cy="yScale(point.tempC)"
            :r="point.id === selectedPointId ? 9 : 7"
            @pointerdown="startDrag(point.id, $event)"
          />
          <text
            v-if="point.id === selectedPointId"
            :x="xScale(point.timeMin)"
            :y="yScale(point.tempC) - 16"
            text-anchor="middle"
          >
            {{ point.tempC }}℃ · {{ (point.timeMin / 60).toFixed(2) }}h
          </text>
        </g>
      </g>
    </svg>
    <div class="chart-legend">
      <span><i class="legend-target" />目标曲线</span>
      <span><i class="legend-actual" />实际记录</span>
      <span><i class="legend-overlay" />叠加窑次</span>
      <span class="chart-hint">拖动圆点调整温度与到达时间</span>
    </div>
  </div>
</template>

<style scoped>
.curve-chart { width: 100%; }
svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; user-select: none; }
.grid-lines line { stroke: rgba(83, 61, 45, .12); stroke-width: 1; }
.grid-lines text, .axis-labels text { fill: #8a7366; font-size: 11px; }
.axis-labels text { font-weight: 600; }
.target-curve { filter: drop-shadow(0 2px 3px rgba(182, 83, 47, .18)); }
.actual-curve { stroke-dasharray: 5 4; }
.curve-point circle {
  fill: #fff8f1;
  stroke: #aa4e2d;
  stroke-width: 2.5;
  cursor: grab;
  filter: url(#pointShadow);
}
.curve-point circle:active { cursor: grabbing; }
.curve-point--selected circle { fill: #b6532f; stroke: #fff; stroke-width: 3; }
.curve-point text { fill: #653521; font-size: 11px; font-weight: 700; }
.chart-legend { display: flex; align-items: center; gap: 18px; padding: 0 12px 4px 60px; color: #7f6b60; font-size: 11px; }
.chart-legend span { display: flex; align-items: center; gap: 6px; }
.chart-legend i { display: inline-block; width: 24px; height: 3px; border-radius: 2px; }
.legend-target { background: #b6532f; }
.legend-actual { background: repeating-linear-gradient(90deg, #2e6f76 0 6px, transparent 6px 10px); }
.legend-overlay { background: #447f8a; opacity: .5; }
.chart-hint { margin-left: auto; }
</style>
