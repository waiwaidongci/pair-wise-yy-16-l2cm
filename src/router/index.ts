import { createRouter, createWebHistory } from 'vue-router'
import ComparePage from '../views/ComparePage.vue'
import EditorPage from '../views/EditorPage.vue'
import SessionsPage from '../views/SessionsPage.vue'
import SyncPage from '../views/SyncPage.vue'
import TemplatesPage from '../views/TemplatesPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/editor' },
    { path: '/editor', component: EditorPage },
    { path: '/compare', component: ComparePage },
    { path: '/sessions', component: SessionsPage },
    { path: '/sync', component: SyncPage },
    { path: '/templates', component: TemplatesPage },
  ],
})
