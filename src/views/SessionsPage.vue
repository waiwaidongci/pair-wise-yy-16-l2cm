<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import { parseTemperatureCsv } from '../utils/csv'

const store = useFiringStore()
const { activeSession } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const importMessage = ref('')

function openFile() {
  fileInput.value?.click()
}

async function importCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const samples = parseTemperatureCsv(await file.text())
  if (!samples.length) {
    importMessage.value = '未解析到有效记录，请确认 CSV 包含 time,temp 两列。'
  } else {
    store.importSamples(samples)
    importMessage.value = `已导入 ${samples.length} 个温度采样点。`
  }
  ;(event.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>窑次与记录仪数据</h2>
        <p>维护泥料、釉料和烧成参数，导入温度记录后自动进入待复核状态。</p>
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
            <span>{{ session.points.length }} 个目标关键点</span>
            <span>{{ session.actualSamples.length }} 个实测点</span>
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
        <p v-if="importMessage" class="import-message">{{ importMessage }}</p>

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
