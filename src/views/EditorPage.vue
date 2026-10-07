<script setup lang="ts">
import { computed, ref } from 'vue'
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
const {
  activeSession,
  selectedPointId,
  selectedStageIndex,
  validationIssues,
  canUndo,
  canRedo,
  pendingConflictCount,
  lastMergeAt,
} = storeToRefs(store)
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

const importFile = ref<HTMLInputElement>()
const conflictDialogOpen = ref(false)
const importMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null)

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

function openImportFile() {
  importFile.value?.click()
}

async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const text = await file.text()
  const outcome = store.importSessionJson(text)
  if (outcome.ok) {
    const stats = outcome.stats!
    importMessage.value = {
      type: 'success',
      text: `合并完成：采纳本地 ${stats.adoptedLocal} 项、对方 ${stats.adoptedRemote} 项、自动合并 ${stats.autoMerged} 项，${stats.newConflicts} 项待确认。`,
    }
    if (outcome.conflicts?.length) conflictDialogOpen.value = true
  } else {
    importMessage.value = { type: 'error', text: outcome.error ?? '合并失败，本地草稿未改动。' }
  }
  ;(event.target as HTMLInputElement).value = ''
}

function retryImport() {
  const outcome = store.retryImport()
  if (outcome.ok) {
    importMessage.value = { type: 'success', text: '重试合并成功。' }
    if (outcome.conflicts?.length) conflictDialogOpen.value = true
  } else {
    importMessage.value = { type: 'error', text: outcome.error ?? '重试失败，本地草稿未改动。' }
  }
}

function simulateRemote() {
  store.simulateRemoteFork()
  importMessage.value = {
    type: 'success',
    text: '已生成对方离线副本并下载。可在本地继续修改后，用「导入合并」读入该副本，即可看到按修订号合并的结果。',
  }
}

const conflictTypeLabel: Record<string, string> = {
  point: '关键点',
  sample: '实测采样',
  offset: '时间偏移',
  meta: '窑次信息',
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">当前窑次</span>
        <h2>{{ activeSession.name }}</h2>
        <p>
          {{ activeSession.kiln }} · {{ activeSession.clay }} / {{ activeSession.glaze }} · {{ activeSession.firedAt }}
          · 修订号 <strong>rev {{ activeSession.rev }}</strong>
        </p>
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
        <Button icon="pi pi-download" label="导出 JSON" outlined @click="store.exportSessionJson" />
        <Button icon="pi pi-upload" label="导入合并" @click="openImportFile" />
        <Button icon="pi pi-users" label="模拟对方修改" text @click="simulateRemote" />
        <input ref="importFile" class="hidden-input" type="file" accept=".json,application/json" @change="onImportFile" />
      </div>
    </section>

    <section v-if="pendingConflictCount" class="conflict-banner">
      <div>
        <strong>有 {{ pendingConflictCount }} 项合并冲突待确认</strong>
        <span>双方离线修改了同一内容，已按规则保留一版，另一版留待你人工确认。</span>
      </div>
      <Button label="去处理" icon="pi pi-exclamation-triangle" severity="warning" @click="conflictDialogOpen = true" />
    </section>

    <section v-if="importMessage" class="import-message" :class="`import-message--${importMessage.type}`">
      <span>{{ importMessage.text }}</span>
      <Button v-if="importMessage.type === 'error' && store.lastImportError" label="重试" icon="pi pi-replay" size="small" @click="retryImport" />
    </section>

    <section class="editor-grid">
      <article class="chart-card">
        <div class="chart-toolbar">
          <div>
            <strong>目标烧成曲线</strong>
            <span>拖动关键点可同时调整温度与到达时间</span>
          </div>
          <div class="chart-metrics">
            <span>关键点 <strong>{{ activeSession.points.length }}</strong></span>
            <span>阶段 <strong>{{ stages.length }}</strong></span>
            <span>峰值 <strong>{{ Math.max(...activeSession.points.map((point) => point.tempC)) }} ℃</strong></span>
            <span>修订 <strong>rev {{ activeSession.rev }}</strong></span>
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
          :recalculated="!!lastMergeAt"
          @update-offset="store.setTimeOffset"
        />
      </article>
      <article class="detail-card">
        <RiskSummary :issues="validationIssues" :recalculated="!!lastMergeAt" />
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

    <Dialog v-model:visible="conflictDialogOpen" header="合并冲突待确认" :style="{ width: '720px' }" modal>
      <div class="conflict-intro">
        以下内容双方在离线状态下都做了修改。已按规则保留其中一版（关键点冲突保留峰值温度更高的一版），另一版留待确认。
      </div>
      <div v-for="conflict in activeSession.pendingConflicts" :key="conflict.id" class="conflict-item">
        <div class="conflict-item__head">
          <Tag :value="conflictTypeLabel[conflict.entityType] ?? conflict.entityType" severity="warn" />
          <strong>{{ conflict.label }}</strong>
          <Tag :value="conflict.winner === 'local' ? '已保留本地' : '已保留对方'" :severity="conflict.winner === 'local' ? 'info' : 'success'" />
        </div>
        <div class="conflict-versions">
          <div class="conflict-version" :class="{ 'conflict-version--winner': conflict.winner === 'local' }">
            <span>本地（本机）</span>
            <strong>{{ conflict.localValue }}</strong>
            <small v-if="conflict.localPeakTemp !== null">峰值 {{ conflict.localPeakTemp }} ℃</small>
          </div>
          <div class="conflict-version" :class="{ 'conflict-version--winner': conflict.winner === 'remote' }">
            <span>对方（离线副本）</span>
            <strong>{{ conflict.remoteValue }}</strong>
            <small v-if="conflict.remotePeakTemp !== null">峰值 {{ conflict.remotePeakTemp }} ℃</small>
          </div>
        </div>
        <p class="conflict-reason">{{ conflict.reason }}</p>
        <div class="conflict-actions">
          <Button
            label="保留本地"
            size="small"
            :severity="conflict.winner === 'local' ? 'primary' : 'secondary'"
            :outlined="conflict.winner !== 'local'"
            @click="store.resolveConflict(conflict.id, 'local')"
          />
          <Button
            label="采用对方"
            size="small"
            :severity="conflict.winner === 'remote' ? 'primary' : 'secondary'"
            :outlined="conflict.winner !== 'remote'"
            @click="store.resolveConflict(conflict.id, 'remote')"
          />
        </div>
      </div>
      <template #footer>
        <Button label="关闭" severity="secondary" text @click="conflictDialogOpen = false" />
      </template>
    </Dialog>
  </div>
</template>
