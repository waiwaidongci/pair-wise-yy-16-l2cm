<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useFiringStore } from './stores/firingStore'

const route = useRoute()
const router = useRouter()
const store = useFiringStore()
const { pendingConflictCount } = storeToRefs(store)
const navItems = [
  { path: '/editor', label: '曲线编辑', icon: 'pi pi-chart-line' },
  { path: '/compare', label: '窑次对比', icon: 'pi pi-chart-scatter' },
  { path: '/sessions', label: '窑次管理', icon: 'pi pi-database' },
  { path: '/sync', label: '同步中心', icon: 'pi pi-sync' },
  { path: '/templates', label: '曲线模板', icon: 'pi pi-copy' },
]
const activePath = computed(() => navItems.find((item) => route.path.startsWith(item.path))?.path ?? '/editor')
const activeLabel = computed(() => navItems.find((item) => item.path === activePath.value)?.label ?? '曲线编辑')
</script>

<template>
  <div class="app-shell">
    <aside class="app-sider">
      <div class="brand">
        <div class="brand__mark">火</div>
        <div>
          <strong>火候</strong>
          <span>KILN FIRING STUDIO</span>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          type="button"
          class="nav-item"
          :class="{ 'nav-item--active': activePath === item.path }"
          @click="router.push(item.path)"
        >
          <i :class="item.icon" />
          <span>{{ item.label }}</span>
          <em v-if="item.path === '/sync' && pendingConflictCount" class="nav-badge">{{ pendingConflictCount }}</em>
        </button>
      </nav>
      <div class="kiln-card">
        <i class="pi pi-sun" />
        <div>
          <strong>气窑 3 号 · 正常</strong>
          <span>热电偶 K 型 / 5 秒采样</span>
        </div>
      </div>
      <div class="sider-footer">
        <span>工艺标准 v2.4</span>
        <Tag value="本地" severity="success" />
      </div>
    </aside>
    <section class="app-workspace">
      <header class="app-header">
        <div>
          <span>陶艺烧成数字工作台</span>
          <strong>{{ activeLabel }}</strong>
        </div>
        <div class="header-actions">
          <span class="sync-dot" />
          <span>目标曲线与记录仪数据自动保存</span>
        </div>
      </header>
      <main class="app-content">
        <RouterView />
      </main>
    </section>
  </div>
</template>
