<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import { parseTemperatureCsv } from '../utils/csv'
import type { FiringSample } from '../types/firing'

const store = useFiringStore()
const { activeSession } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const importMessage = ref('')
const importSeverity = ref<'ok' | 'error'>('ok')

const sessionDrafts = computed(() =>
  store.failedDrafts.filter(
    (draft) => draft.kind === 'csv' && (!draft.sessionId || draft.sessionId === activeSession.value.id),
  ),
)

function openFile() {
  fileInput.value?.click()
}

function loadCsvContent(filename: string, content: string, sessionId: string): number {
  let samples: Array<Omit<FiringSample, 'rev'>> = []
  try {
    samples = parseTemperatureCsv(content)
  } catch (error) {
    store.saveCsvDraft(filename, content, sessionId, error instanceof Error ? error.message : 'CSV 解析异常')
    return 0
  }
  if (!samples.length) {
    // 导入失败：留住本地草稿（原始内容），可修正后重试
    store.saveCsvDraft(filename, content, sessionId, '未解析到有效记录，请确认 CSV 包含 time,temp 两列。')
    return 0
  }
  store.setActiveSession(sessionId)
  store.importSamples(samples)
  return samples.length
}

async function importCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const content = await file.text()
  const count = loadCsvContent(file.name, content, activeSession.value.id)
  if (count) {
    importMessage.value = `已导入并修订采样（${count} 点）。`
    importSeverity.value = 'ok'
  } else {
    importMessage.value = '导入失败，原始 CSV 已留作本地草稿，可在下方重试。'
    importSeverity.value = 'error'
  }
  ;(event.target as HTMLInputElement).value = ''
}

function retryCsv(draftId: string) {
  const draft = store.consumeCsvDraft(draftId)
  if (!draft) return
  const count2 = loadCsvContent(draft.filename, draft.payload, draft.sessionId ?? activeSession.value.id)
  if (count2) {
    importMessage.value = `草稿「${draft.filename}」重试导入成功（${count2} 点）。`
    importSeverity.value = 'ok'
  } else {
    importMessage.value = '重试仍失败，草稿继续保留。'
    importSeverity.value = 'error'
  }
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>窑次与记录仪数据</h2>
        <p>维护泥料、釉料和烧成参数，导入温度记录后自动进入待复核状态，采样带修订号参与合并。</p>
      </div>
      <Button label="新建窑次" icon="pi pi-plus" @click="store.addSession" />
    </section>

    <section class="sessions-grid">
      <article class="session-list-card">
        <div class="panel-title panel-title--row">
          <div><strong>全部窑次</strong><span>{{ store.sessions.length }} 条记录</span></div>
        </div>
        <button
          v-for="session in store.sessions"
          :key="session.id"
          type="button"
          class="session-card"
          :class="{ 'session-card--active': session.id === activeSession.id }"
          @click="store.setActiveSession(session.id)"
        >
          <div class="session-card__top">
            <strong>{{ session.name }}</strong>
            <Tag :value="session.status === 'completed' ? '已完成' : session.status === 'review' ? '待复核' : '草稿'" :severity="session.status === 'completed' ? 'success' : session.status === 'review' ? 'warn' : 'secondary'" />
          </div>
          <span>{{ session.kiln }} · {{ session.firedAt }}</span>
          <div class="session-card__meta">
            <span>{{ session.points.length }} 关键点 · r{{ session.curveRev }}</span>
            <span>{{ session.actualSamples.length }} 实测点</span>
          </div>
        </button>
      </article>

      <article class="session-detail">
        <div class="panel-title panel-title--row">
          <div><strong>{{ activeSession.name }}</strong><span>窑次信息与记录仪导入</span></div>
          <Button icon="pi pi-trash" label="删除" severity="danger" text :disabled="store.sessions.length <= 1" @click="store.removeSession(activeSession.id)" />
        </div>
        <div class="form-grid">
          <label><span>窑次名称</span><InputText :model-value="activeSession.name" @update:model-value="store.updateSessionMeta({ name: $event })" /></label>
          <label><span>窑炉</span><InputText :model-value="activeSession.kiln" @update:model-value="store.updateSessionMeta({ kiln: $event })" /></label>
          <label><span>泥料</span>
            <Select
              :model-value="activeSession.clay"
              :options="['青瓷泥', '高白泥', '粗陶泥', '紫砂泥', '炻器泥']"
              @update:model-value="store.updateSessionMeta({ clay: $event })"
            />
          </label>
          <label><span>釉料</span>
            <Select
              :model-value="activeSession.glaze"
              :options="['天青釉', '月白釉', '柴烧落灰釉', '结晶釉', '乐烧釉']"
              @update:model-value="store.updateSessionMeta({ glaze: $event })"
            />
          </label>
          <label class="form-span"><span>烧成时间</span><InputText :model-value="activeSession.firedAt" @update:model-value="store.updateSessionMeta({ firedAt: $event })" /></label>
        </div>

        <div class="import-box">
          <input ref="fileInput" class="hidden-input" type="file" accept=".csv,text/csv" @change="importCsv" />
          <div class="import-icon"><i class="pi pi-file-import" /></div>
          <div>
            <strong>导入记录仪 CSV</strong>
            <span>支持 time,temp 或 时间,温度 表头；时间单位可为分钟或 hh:mm:ss。</span>
          </div>
          <Button label="选择文件" icon="pi pi-upload" outlined @click="openFile" />
          <Button v-if="activeSession.actualSamples.length" label="清除实测" severity="danger" text @click="store.clearActualSamples" />
        </div>
        <p v-if="importMessage" class="import-message" :class="{ 'import-message--error': importSeverity === 'error' }">{{ importMessage }}</p>

        <div v-if="sessionDrafts.length" class="csv-drafts">
          <strong>导入失败的本地草稿</strong>
          <div v-for="draft in sessionDrafts" :key="draft.id" class="csv-draft-row">
            <div>
              <i class="pi pi-file" /> {{ draft.filename }}
              <p>{{ draft.error }}</p>
            </div>
            <div class="csv-draft-actions">
              <Button label="重试导入" icon="pi pi-refresh" size="small" outlined @click="retryCsv(draft.id)" />
              <Button label="丢弃" icon="pi pi-trash" size="small" severity="danger" text @click="store.removeDraft(draft.id)" />
            </div>
          </div>
        </div>

        <div class="sample-summary">
          <strong>当前实测数据</strong>
          <span v-if="activeSession.actualSamples.length">
            {{ activeSession.actualSamples.length }} 点 · 起始 {{ activeSession.actualSamples[0].tempC.toFixed(0) }} ℃ · 结束 {{ activeSession.actualSamples.at(-1)?.tempC.toFixed(0) }} ℃
          </span>
          <span v-else>尚未导入实测温度</span>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.import-message--error { color: #a2442f; }
.csv-drafts { margin-top: 12px; padding: 12px 14px; border: 1px solid #ecd9b8; border-radius: 10px; background: #fffaf0; }
.csv-drafts > strong { color: #8a6a35; font-size: 12px; }
.csv-draft-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; padding: 9px 10px; border-radius: 8px; background: #fff; border: 1px solid #f0e4cb; }
.csv-draft-row i { color: #b08d56; }
.csv-draft-row p { margin: 4px 0 0; color: #9a7c54; font-size: 10px; }
.csv-draft-actions { display: flex; gap: 6px; flex-shrink: 0; }
.hidden-input { display: none; }
</style>
