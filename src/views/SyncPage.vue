<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import { useFiringStore } from '../stores/firingStore'
import { downloadText } from '../utils/csv'
import type { ConflictValue, PendingConflict } from '../types/firing'

const store = useFiringStore()
const {
  sessions,
  activeSession,
  failedDrafts,
  lastMergeReport,
  pendingConflictCount,
  allPendingConflicts,
} = storeToRefs(store)
const router = useRouter()
const bundleInput = ref<HTMLInputElement>()
const message = ref('')
const messageSeverity = ref<'ok' | 'error'>('ok')
const simulateOpen = ref(false)

const sessionRevisionRows = computed(() =>
  sessions.value.map((session) => ({
    id: session.id,
    name: session.name,
    kiln: session.kiln,
    curveRev: session.curveRev,
    offsetRev: session.timeOffsetRev,
    pointCount: session.points.length,
    sampleCount: session.actualSamples.length,
    pending: session.pendingConflicts.length,
    shadowAt: session.syncShadow.mergedAt,
    stale: session.analysis.stale,
  })),
)

function flash(text: string, severity: 'ok' | 'error' = 'ok') {
  message.value = text
  messageSeverity.value = severity
}

function exportCurrentBundle() {
  const bundle = store.exportRevisionBundle([activeSession.value.id])
  downloadText(
    JSON.stringify(bundle, null, 2),
    `${activeSession.value.name}-修订包-r${activeSession.value.curveRev}.json`,
    'application/json;charset=utf-8',
  )
  flash(`已导出当前窑次修订包（曲线 r${activeSession.value.curveRev}），可拷给对端合并。`)
}

function exportAllBundles() {
  const bundle = store.exportRevisionBundle()
  downloadText(JSON.stringify(bundle, null, 2), `全部窑次-修订包-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')
  flash(`已导出 ${bundle.sessions.length} 个窑次的修订包（设备：${store.deviceName}）。`)
}

function openBundlePicker() {
  bundleInput.value?.click()
}

async function importBundle(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const raw = await file.text()
  try {
    const report = store.applyRevisionBundle(raw, file.name)
    flash(
      `合并完成：自动采纳 ${report.adoptedCount} 项变更，${report.conflictCount} 项保留峰值更高版待确认。`,
      report.conflictCount ? 'error' : 'ok',
    )
  } catch (error) {
    flash(`合并失败，原始修订包已留作本地草稿，可在下方重试：${(error as Error).message}`, 'error')
  }
  ;(event.target as HTMLInputElement).value = ''
}

function retryBundle(draftId: string) {
  try {
    store.retryDraft(draftId)
    flash('草稿重试合并成功。')
  } catch (error) {
    flash(`重试仍失败，草稿继续保留：${(error as Error).message}`, 'error')
  }
}

/* ---------------- 离线冲突场景演示 ---------------- */

function runOfflineScenario() {
  try {
    const report = store.runOfflineSimulation(activeSession.value.id)
    const sessionReport = report.sessions[0]
    flash(
      `模拟完成：办公室 +25 ℃、平板 −35 ℃ 改了同一峰值关键点，已自动保留峰值更高的办公室版，平板版进入待确认；并入 ${sessionReport?.sampleAdopted ?? 0} 个补录采样。`,
      'error',
    )
  } catch (error) {
    flash(`模拟合并失败：${(error as Error).message}`, 'error')
  }
  simulateOpen.value = false
}

/* ---------------- 待确认冲突 ---------------- */

function valueText(conflict: PendingConflict, value: ConflictValue) {
  if (conflict.kind === 'offset') return `偏移 ${value.offsetMin} min（r${value.rev}）`
  if (conflict.kind.includes('delete') && value.tempC === undefined) return `删除该${conflict.kind === 'point-delete' ? '关键点' : '采样'}`
  return `${value.timeMin} min · ${value.tempC?.toFixed?.(0) ?? value.tempC} ℃（r${value.rev}）`
}

function choose(conflictId: string, choice: 'winner' | 'loser') {
  store.chooseConflict(conflictId, choice)
  flash(choice === 'winner' ? '已采纳自动保留版本，结论按新曲线重算。' : '已改采另一版本，阶段划分与风险结论按新曲线重算。')
}

function openSession(sessionId: string) {
  store.setActiveSession(sessionId)
  store.recomputeAnalysis(sessionId)
  router.push('/editor')
}

function formatTime(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">离线协作 · 修订合并</span>
        <h2>修订同步中心</h2>
        <p>关键点、实测采样、时间偏移全部带修订号；按修订号三向合并，只一边动过直接采纳，两边都改同一关键点时保留峰值温度更高的一版。</p>
      </div>
      <Tag :value="store.deviceName" severity="secondary" />
    </section>

    <p v-if="message" class="sync-message" :class="`sync-message--${messageSeverity}`">{{ message }}</p>

    <section class="sync-grid">
      <article class="sync-card">
        <div class="panel-title">
          <strong>① 导出本机修订包</strong>
          <span>离线结束后拷给对端；包含内容与合并基线</span>
        </div>
        <div class="sync-actions">
          <Button label="导出当前窑次" icon="pi pi-file-export" outlined @click="exportCurrentBundle" />
          <Button label="导出全部窑次" icon="pi pi-folder-open" outlined @click="exportAllBundles" />
        </div>
      </article>

      <article class="sync-card">
        <div class="panel-title">
          <strong>② 导入对端修订包并合并</strong>
          <span>解析或合并失败时原始载荷留存为本地草稿，可重试</span>
        </div>
        <div class="sync-actions">
          <input ref="bundleInput" class="hidden-input" type="file" accept=".json,application/json" @change="importBundle" />
          <Button label="选择修订包合并" icon="pi pi-file-import" @click="openBundlePicker" />
          <Button label="模拟离线冲突场景" icon="pi pi-wifi" severity="warning" outlined @click="simulateOpen = true" />
        </div>
      </article>
    </section>

    <section v-if="pendingConflictCount" class="content-card conflict-card">
      <div class="panel-title panel-title--row">
        <div>
          <strong>待确认（{{ pendingConflictCount }}）</strong>
          <span>自动保留峰值 / 修订号更高的一版，另一版留此备查；确认后基线刷新，旧结论按新曲线重算</span>
        </div>
      </div>
      <div v-for="{ conflict, session } in allPendingConflicts" :key="conflict.id" class="conflict-row">
        <div class="conflict-main">
          <div class="conflict-head">
            <Tag :value="session.name" severity="secondary" />
            <strong>{{ conflict.label }}</strong>
          </div>
          <p>{{ conflict.autoRule }}</p>
          <div class="conflict-values">
            <span class="conflict-value" :class="{ 'conflict-value--win': conflict.winner.side === 'local' }">
              <i :class="conflict.winner.side === 'local' ? 'pi pi-desktop' : 'pi pi-tablet'" /> {{ conflict.winner.device }}：{{ valueText(conflict, conflict.winner) }}
            </span>
            <span class="conflict-value" :class="{ 'conflict-value--win': conflict.loser.side === 'local' }">
              <i :class="conflict.loser.side === 'local' ? 'pi pi-desktop' : 'pi pi-tablet'" /> {{ conflict.loser.device }}：{{ valueText(conflict, conflict.loser) }}
            </span>
          </div>
        </div>
        <div class="conflict-buttons">
          <Button label="保留自动版" icon="pi pi-check-circle" size="small" @click="choose(conflict.id, 'winner')" />
          <Button label="改采另一版" icon="pi pi-undo" size="small" severity="secondary" outlined @click="choose(conflict.id, 'loser')" />
          <Button label="打开窑次" icon="pi pi-arrow-right" size="small" text @click="openSession(conflict.sessionId)" />
        </div>
      </div>
    </section>

    <section class="content-card">
      <div class="panel-title panel-title--row">
        <div><strong>各窑次修订状态</strong><span>曲线修订号变化即意味着阶段重划，绑定旧阶段的偏差与开裂风险结论失效</span></div>
      </div>
      <div class="comparison-table">
        <div class="comparison-row comparison-row--header">
          <span>窑次</span><span>曲线 r</span><span>偏移 r</span><span>关键点 / 采样</span><span>基线时间</span><span>状态</span>
        </div>
        <div v-for="row in sessionRevisionRows" :key="row.id" class="comparison-row">
          <strong>{{ row.name }}</strong>
          <span>r{{ row.curveRev }}</span>
          <span>r{{ row.offsetRev }}</span>
          <span>{{ row.pointCount }} / {{ row.sampleCount }}</span>
          <span>{{ formatTime(row.shadowAt) }}</span>
          <span class="row-tags">
            <Tag v-if="row.stale" value="结论待重算" severity="warn" />
            <Tag v-if="row.pending" :value="`待确认 ${row.pending}`" severity="danger" />
            <Tag v-if="!row.stale && !row.pending" value="已同步" severity="success" />
          </span>
        </div>
      </div>
    </section>

    <section v-if="failedDrafts.length" class="content-card draft-card">
      <div class="panel-title panel-title--row">
        <div><strong>本地草稿（{{ failedDrafts.length }}）</strong><span>合并或导入失败后自动留存，网络恢复可直接重试，无需重新选择文件</span></div>
      </div>
      <div v-for="draft in failedDrafts" :key="draft.id" class="draft-row">
        <div>
          <strong><i class="pi pi-file" /> {{ draft.filename }}</strong>
          <p>{{ draft.error }}</p>
          <small>{{ draft.kind === 'bundle' ? '修订包' : 'CSV 采样' }}<template v-if="draft.sessionName"> · {{ draft.sessionName }}</template> · 留存于 {{ formatTime(draft.createdAt) }}</small>
        </div>
        <div class="conflict-buttons">
          <Button v-if="draft.kind === 'bundle'" label="重试合并" icon="pi pi-refresh" size="small" @click="retryBundle(draft.id)" />
          <Button label="丢弃" icon="pi pi-trash" size="small" severity="danger" text @click="store.removeDraft(draft.id)" />
        </div>
      </div>
    </section>

    <section v-if="lastMergeReport" class="content-card">
      <div class="panel-title">
        <strong>最近一次合并报告</strong>
        <span>来自 {{ lastMergeReport.deviceName }} · {{ formatTime(lastMergeReport.at) }}</span>
      </div>
      <ul class="report-list">
        <li v-for="report in lastMergeReport.sessions" :key="report.sessionId">
          <strong>{{ report.sessionName }}</strong>
          <span v-if="report.isNewSession">新窑次整份采纳；</span>
          <span>采纳关键点 {{ report.pointAdopted }} 个、采样 {{ report.sampleAdopted }} 个{{ report.offsetChanged ? '、时间偏移 1 项' : '' }}；</span>
          <span :class="{ 'report-conflict': report.conflicts.length }">{{ report.conflicts.length }} 项待确认</span>
        </li>
      </ul>
    </section>

    <Dialog v-model:visible="simulateOpen" header="模拟离线两边同改" :style="{ width: '520px' }" modal>
      <div class="simulate-body">
        <p>将在当前窑次 <strong>「{{ activeSession.name }}」</strong> 上演示网络断开期间的冲突：</p>
        <ol>
          <li>办公室（配方师）离线把峰值关键点 <strong>升高 25 ℃</strong>；</li>
          <li>窑边平板（看火工）同时把同一关键点 <strong>降低 35 ℃</strong>，补录 4 个实测采样，并调整时间偏移；</li>
          <li>网络恢复后按修订号合并：峰值更高的办公室版自动保留，平板版进入待确认；采样与偏移按规则并入。</li>
        </ol>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="simulateOpen = false" />
        <Button label="开始模拟并合并" @click="runOfflineScenario" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.sync-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sync-card { padding: 15px 16px; border: 1px solid #e6ddd8; border-radius: 12px; background: #fff; }
.sync-actions { display: flex; gap: 9px; margin-top: 13px; flex-wrap: wrap; }
.sync-message { padding: 10px 14px; border-radius: 9px; font-size: 12px; line-height: 1.6; }
.sync-message--ok { background: #eef7f0; color: #3b6e4f; border: 1px solid #cde5d3; }
.sync-message--error { background: #fdf1ec; color: #a2442f; border: 1px solid #f0cdbf; }
.conflict-card { border-color: #f0cdbf; }
.conflict-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 4px; border-bottom: 1px solid #f0e7e1; }
.conflict-row:last-child { border-bottom: 0; }
.conflict-head { display: flex; align-items: center; gap: 8px; }
.conflict-head strong { color: #5a3b2e; font-size: 13px; }
.conflict-main p { margin: 6px 0 8px; color: #8a6a5c; font-size: 11px; line-height: 1.6; }
.conflict-values { display: flex; gap: 16px; flex-wrap: wrap; }
.conflict-value { display: inline-flex; align-items: center; gap: 5px; color: #8a766c; font-size: 11px; font-family: Menlo, monospace; }
.conflict-value--win { color: #b14733; font-weight: 600; }
.conflict-buttons { display: flex; gap: 6px; flex-shrink: 0; }
.row-tags { display: flex; gap: 5px; }
.draft-card { border-color: #ecd9b8; }
.draft-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 4px; border-bottom: 1px solid #f3ead9; }
.draft-row:last-child { border-bottom: 0; }
.draft-row strong { display: flex; align-items: center; gap: 7px; color: #6d522f; font-size: 12px; }
.draft-row p { margin: 5px 0 3px; color: #9a7c54; font-size: 11px; }
.draft-row small { color: #ab987c; font-size: 10px; }
.report-list { margin: 10px 0 0; padding-left: 18px; color: #6f5a50; font-size: 11px; line-height: 1.9; }
.report-conflict { color: #b14733; font-weight: 600; }
.simulate-body { color: #6f5a50; font-size: 12px; line-height: 1.8; }
.simulate-body ol { margin: 10px 0 0; padding-left: 20px; }
.hidden-input { display: none; }
</style>
