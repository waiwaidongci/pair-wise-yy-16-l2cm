<script setup lang="ts">
import type { RiskIssue } from '../types/firing'

defineProps<{
  issues: RiskIssue[]
}>()
</script>

<template>
  <section class="risk-summary">
    <div class="risk-heading">
      <div>
        <strong>釉面风险检查</strong>
        <span>{{ issues.length ? `发现 ${issues.length} 项需要关注` : '当前曲线未触发风险规则' }}</span>
      </div>
      <span class="risk-badge" :class="{ 'risk-badge--safe': !issues.length }">
        {{ issues.length ? '需调整' : '通过' }}
      </span>
    </div>
    <div v-if="issues.length" class="risk-list">
      <article
        v-for="issue in issues"
        :key="issue.id"
        class="risk-item"
        :class="`risk-item--${issue.severity}`"
      >
        <span class="risk-item__index">{{ issue.stageIndex + 1 }}</span>
        <div>
          <strong>{{ issue.title }}</strong>
          <p>{{ issue.message }}</p>
          <small>{{ issue.metric }}</small>
        </div>
      </article>
    </div>
    <div v-else class="risk-safe">
      升温速率、保温时长和降温速度均在当前泥料与釉料的建议范围内。
    </div>
  </section>
</template>

<style scoped>
.risk-summary { padding: 15px 16px; }
.risk-heading { display: flex; align-items: flex-start; justify-content: space-between; }
.risk-heading strong, .risk-heading span { display: block; }
.risk-heading strong { color: #49332a; font-size: 14px; }
.risk-heading span { margin-top: 3px; color: #99847a; font-size: 10px; }
.risk-badge { padding: 3px 8px; border-radius: 999px; background: #fde7e0; color: #b14733; font-size: 10px; }
.risk-badge--safe { background: #e5f3e8; color: #34774c; }
.risk-list { display: grid; gap: 8px; margin-top: 12px; max-height: 420px; overflow: auto; }
.risk-item { display: grid; gap: 10px; padding: 11px; border: 1px solid #efd5cb; border-radius: 8px; background: #fff8f5; grid-template-columns: 25px 1fr; }
.risk-item--warning { border-color: #eddbb0; background: #fffbf0; }
.risk-item__index { display: grid; width: 23px; height: 23px; place-items: center; border-radius: 50%; background: #b6532f; color: #fff; font-family: Menlo, monospace; font-size: 9px; }
.risk-item--warning .risk-item__index { background: #b98629; }
.risk-item strong { color: #9e3f2d; font-size: 11px; }
.risk-item--warning strong { color: #96691b; }
.risk-item p { margin: 5px 0; color: #765c50; font-size: 10px; line-height: 1.65; }
.risk-item small { color: #a88e82; font-family: Menlo, monospace; font-size: 9px; }
.risk-safe { margin-top: 12px; padding: 13px; border-radius: 8px; background: #eef7f0; color: #477658; font-size: 11px; line-height: 1.7; }
</style>
