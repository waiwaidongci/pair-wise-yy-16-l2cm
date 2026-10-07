<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import CurveChart from '../components/CurveChart.vue'
import StagePanel from '../components/StagePanel.vue'
import RiskSummary from '../components/RiskSummary.vue'
import DeviationPanel from '../components/DeviationPanel.vue'
import { buildStages, calculateDeviation } from '../utils/curve'

const store = useFiringStore()
const { activeSession, selectedPointId, selectedStageIndex, validationIssues, canUndo, canRedo } = storeToRefs(store)
const templateOpen = ref(false)
const templateName = ref('')
const stages = computed(() => buildStages(activeSession.value.points))
const deviation = computed(() =>
  calculateDeviation(
    activeSession.value.points,
    activeSession.value.actualSamples,
    activeSession.value.timeOffsetMin,
  ),
)
const sessionOptions = computed(() =>
  store.sessions.map((session) => ({ label: session.name, value: session.id })),
)

// 曲线关键点一变，阶段划分跟着变：旧偏差 / 开裂风险结论失效后按新曲线重算
watch(
  () => [activeSession.value.id, activeSession.value.curveRev, activeSession.value.timeOffsetRev, activeSession.value.actualSamples.length],
  (_newValue, _oldValue, onCleanup) => {
    if (!activeSession.value.analysis?.stale) return
    const timer = window.setTimeout(() => store.recomputeAnalysis(activeSession.value.id), 350)
    onCleanup(() => window.clearTimeout(timer))
  },
)

function updateSelectedStage(index: number, field: 'duration' | 'targetTemp', value: number) {
  const stage = stages.value[index]
  if (!stage) return
  if (field === 'duration') {
    store.updatePoint(stage.end.id, stage.start.timeMin + Math.max(1, value), stage.end.tempC)
  } else {
    store.updatePoint(stage.end.id, stage.end.timeMin, value)
  }
  selectedStageIndex.value = index
}

function saveTemplate() {
  store.saveTemplateFromSession(templateName.value)
  templateOpen.value = false
  templateName.value = ''
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">当前窑次</span>
        <h2>{{ activeSession.name }}</h2>
        <p>{{ activeSession.kiln }} · {{ activeSession.clay }} / {{ activeSession.glaze }} · {{ activeSession.firedAt }}</p>
      </div>
      <div class="heading-actions">
        <Select
          :model-value="store.activeSessionId"
          :options="sessionOptions"
          option-label="label"
          option-value="value"
          class="session-select"
          @update:model-value="store.setActiveSession"
        />
        <Button icon="pi pi-undo" label="撤销" severity="secondary" outlined :disabled="!canUndo" @click="store.undo" />
        <Button icon="pi pi-redo" label="重做" severity="secondary" outlined :disabled="!canRedo" @click="store.redo" />
        <Button icon="pi pi-copy" label="保存模板" outlined @click="templateOpen = true" />
        <Button icon="pi pi-download" label="导出 JSON" @click="store.exportSessionJson" />
      </div>
    </section>

    <div class="rev-strip">
      <Tag :value="`曲线修订 r${activeSession.curveRev}`" severity="danger" />
      <Tag :value="`时间偏移 r${activeSession.timeOffsetRev}（${activeSession.timeOffsetMin} min）`" severity="info" />
      <Tag :value="`采样 ${activeSession.actualSamples.length} 点`" severity="secondary" />
      <Tag v-if="activeSession.pendingConflicts.length" :value="`待确认 ${activeSession.pendingConflicts.length} 项`" severity="warn" />
      <Tag v-if="activeSession.analysis.stale" value="旧结论已失效，按新曲线重算中…" severity="warn" />
    </div>

    <section class="editor-grid">
      <article class="chart-card">
        <div class="chart-toolbar">
          <div>
            <strong>目标烧成曲线</strong>
            <span>拖动关键点可同时调整温度与到达时间，改动会递增修订号</span>
          </div>
          <div class="chart-metrics">
            <span>关键点 <strong>{{ activeSession.points.length }}</strong></span>
            <span>阶段 <strong>{{ stages.length }}</strong></span>
            <span>峰值 <strong>{{ Math.max(...activeSession.points.map((point) => point.tempC)) }} ℃</strong></span>
          </div>
        </div>
        <CurveChart
          :sessions="[activeSession]"
          :active-session-id="activeSession.id"
          :selected-point-id="selectedPointId"
          @select-point="selectedPointId = $event"
          @update-point="(id, time, temp) => store.updatePoint(id, time, temp, false)"
          @begin-drag="store.beginDrag"
          @end-drag="store.endDrag"
        />
      </article>

      <aside class="side-panel">
        <StagePanel
          :stages="stages"
          :issues="validationIssues"
          :selected-index="selectedStageIndex"
          @select="selectedStageIndex = $event"
          @update="updateSelectedStage"
          @add-after="store.addPointAfterStage"
        />
      </aside>
    </section>

    <section class="lower-grid">
      <article class="detail-card">
        <DeviationPanel
          :summary="deviation"
          :offset-min="activeSession.timeOffsetMin"
          :offset-rev="activeSession.timeOffsetRev"
          :stale="activeSession.analysis.stale"
          @update-offset="store.setTimeOffset"
        />
      </article>
      <article class="detail-card">
        <RiskSummary :issues="validationIssues" :stale="activeSession.analysis.stale" :curve-rev="activeSession.curveRev" />
      </article>
    </section>

    <Dialog v-model:visible="templateOpen" header="从当前窑次保存模板" :style="{ width: '460px' }" modal>
      <div class="dialog-field">
        <label>模板名称</label>
        <InputText v-model="templateName" placeholder="例如：天青釉 1260 慢烧" />
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="templateOpen = false" />
        <Button label="保存模板" @click="saveTemplate" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.rev-strip { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
</style>
