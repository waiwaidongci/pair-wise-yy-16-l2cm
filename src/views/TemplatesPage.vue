<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import CurveChart from '../components/CurveChart.vue'
import type { CurveTemplate, KilnSession } from '../types/firing'

const store = useFiringStore()
const previewTemplateId = ref(store.templates[0]?.id)
const nameOpen = ref(false)
const templateName = ref('')
const templateSearch = ref('')
const previewTemplate = computed(
  () => store.templates.find((template) => template.id === previewTemplateId.value) ?? store.templates[0],
)
const filteredTemplates = computed(() => {
  const keyword = templateSearch.value.trim().toLowerCase()
  if (!keyword) return store.templates
  return store.templates.filter((template) =>
    [template.name, template.clay, template.glaze].some((value) => value.toLowerCase().includes(keyword)),
  )
})
const previewSession = computed<KilnSession>(() => {
  const template = previewTemplate.value
  return {
    id: `preview-${template.id}`,
    name: template.name,
    kiln: '预览',
    clay: template.clay,
    glaze: template.glaze,
    firedAt: '',
    status: 'draft',
    timeOffsetMin: 0,
    timeOffsetRev: 1,
    curveRev: 1,
    points: template.points.map((point, index) => ({ ...point, id: `preview-point-${index}`, rev: 1 })),
    actualSamples: [],
    syncShadow: {
      points: template.points.map((point, index) => ({ ...point, id: `preview-point-${index}`, rev: 1 })),
      samples: [],
      timeOffsetMin: 0,
      timeOffsetRev: 1,
      mergedAt: '',
    },
    pendingConflicts: [],
    analysis: {
      curveRev: 1,
      samplesSig: 'empty',
      offsetRev: 1,
      stale: false,
      calculatedAt: '',
      issueCount: 0,
    },
  }
})

function createTemplate() {
  store.saveTemplateFromSession(templateName.value)
  nameOpen.value = false
  templateName.value = ''
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">工艺知识库</span>
        <h2>曲线模板</h2>
        <p>按泥料和釉料复用成熟烧成方案，套用后仍可在曲线编辑页拖拽微调。</p>
      </div>
      <Button label="从当前窑次保存" icon="pi pi-copy" @click="nameOpen = true" />
    </section>

    <section class="template-layout">
      <article class="template-list">
        <div class="panel-title panel-title--row">
          <div><strong>可用模板</strong><span>{{ filteredTemplates.length }} 个</span></div>
          <InputText v-model="templateSearch" placeholder="搜索模板或材料" />
        </div>
        <button
          v-for="template in filteredTemplates"
          :key="template.id"
          type="button"
          class="template-row"
          :class="{ 'template-row--active': previewTemplateId === template.id }"
          @click="previewTemplateId = template.id"
        >
          <span class="template-row__mark"><i class="pi pi-chart-line" /></span>
          <span>
            <strong>{{ template.name }}</strong>
            <small>{{ template.clay }} / {{ template.glaze }}</small>
          </span>
          <Tag :value="`${template.peakTempC} ℃`" severity="danger" />
        </button>
      </article>

      <article class="template-preview">
        <div class="panel-title panel-title--row">
          <div>
            <strong>{{ previewTemplate.name }}</strong>
            <span>{{ previewTemplate.description }}</span>
          </div>
          <Button label="应用到当前窑次" icon="pi pi-check" @click="store.applyTemplate(previewTemplate.id); $router.push('/editor')" />
        </div>
        <CurveChart
          :sessions="[previewSession]"
          :active-session-id="previewSession.id"
          :interactive="false"
          :show-actual="false"
        />
        <div class="template-facts">
          <div><span>泥料</span><strong>{{ previewTemplate.clay }}</strong></div>
          <div><span>釉料</span><strong>{{ previewTemplate.glaze }}</strong></div>
          <div><span>最高温度</span><strong>{{ previewTemplate.peakTempC }} ℃</strong></div>
          <div><span>关键点</span><strong>{{ previewTemplate.points.length }}</strong></div>
          <div><span>总时长</span><strong>{{ (previewTemplate.points.at(-1)!.timeMin / 60).toFixed(1) }} h</strong></div>
        </div>
      </article>
    </section>

    <Dialog v-model:visible="nameOpen" header="保存当前窑次为模板" :style="{ width: '460px' }" modal>
      <div class="dialog-field">
        <label>模板名称</label>
        <InputText v-model="templateName" placeholder="例如：月白釉 1280 标准曲线" />
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="nameOpen = false" />
        <Button label="保存" @click="createTemplate" />
      </template>
    </Dialog>
  </div>
</template>
