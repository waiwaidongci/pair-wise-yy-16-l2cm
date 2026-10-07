import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type {
  CurveTemplate,
  FiringPoint,
  FiringSample,
  KilnSession,
  PendingConflict,
} from '../types/firing'
import { cloneSession, templateToPoints, validateCurve } from '../utils/curve'
import {
  downloadSessionJson,
  forkRemoteSession,
  mergeSessions,
  migrateSession,
  parseSessionImport,
  snapshotSession,
  type MergeOutcome,
  type MergeStats,
} from '../utils/merge'

const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      sessions: KilnSession[]
      templates: CurveTemplate[]
      activeSessionId: string
      overlaySessionIds: string[]
    }
    return {
      ...parsed,
      sessions: (parsed.sessions ?? []).map(migrateSession),
    }
  } catch {
    return null
  }
}

export const useFiringStore = defineStore('firing-studio', () => {
  const persisted = loadState()
  const sessions = ref<KilnSession[]>(
    persisted?.sessions?.length ? persisted.sessions : createMockSessions().map(migrateSession),
  )
  const templates = ref<CurveTemplate[]>(persisted?.templates?.length ? persisted.templates : MOCK_TEMPLATES)
  const activeSessionId = ref(
    persisted?.activeSessionId && sessions.value.some((item) => item.id === persisted.activeSessionId)
      ? persisted.activeSessionId
      : sessions.value[0].id,
  )
  const overlaySessionIds = ref<string[]>(
    persisted?.overlaySessionIds?.filter((id) => sessions.value.some((item) => item.id === id))
      ?? sessions.value.slice(1, 3).map((item) => item.id),
  )
  const selectedPointId = ref<string | null>(sessions.value[0].points[0]?.id ?? null)
  const selectedStageIndex = ref<number | null>(0)
  const undoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const redoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const dragHistoryPending = ref(false)

  // 合并 / 导入相关的瞬时状态（不持久化）
  const lastImportPayload = ref<string | null>(null)
  const lastImportError = ref<string | null>(null)
  const lastMergeStats = ref<MergeStats | null>(null)
  const lastMergeAt = ref<number | null>(null)

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? sessions.value[0],
  )
  const validationIssues = computed(() => validateCurve(activeSession.value))
  const visibleSessions = computed(() => {
    const ids = new Set([activeSessionId.value, ...overlaySessionIds.value])
    return sessions.value.filter((session) => ids.has(session.id))
  })
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const pendingConflictCount = computed(() => activeSession.value.pendingConflicts.length)

  function persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: sessions.value,
        templates: templates.value,
        activeSessionId: activeSessionId.value,
        overlaySessionIds: overlaySessionIds.value,
      }),
    )
  }

  function snapshot() {
    return {
      sessions: sessions.value.map(cloneSession),
      activeSessionId: activeSessionId.value,
    }
  }

  function recordHistory() {
    undoStack.value.push(snapshot())
    if (undoStack.value.length > 40) undoStack.value.shift()
    redoStack.value = []
  }

  function restore(snapshotState: { sessions: KilnSession[]; activeSessionId: string }) {
    sessions.value = snapshotState.sessions.map(cloneSession)
    activeSessionId.value = snapshotState.activeSessionId
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(snapshot())
    restore(previous)
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(snapshot())
    restore(next)
  }

  function beginDrag() {
    if (!dragHistoryPending.value) {
      recordHistory()
      dragHistoryPending.value = true
    }
  }

  function endDrag() {
    dragHistoryPending.value = false
    persist()
  }

  function setActiveSession(id: string) {
    if (!sessions.value.some((session) => session.id === id)) return
    activeSessionId.value = id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    lastMergeAt.value = null
    persist()
  }

  function updatePoint(pointId: string, timeMin: number, tempC: number, record = true) {
    if (record) recordHistory()
    const session = activeSession.value
    const sorted = [...session.points].sort((a, b) => a.timeMin - b.timeMin)
    const index = sorted.findIndex((point) => point.id === pointId)
    const previous = sorted[index - 1]
    const next = sorted[index + 1]
    const minTime = previous ? previous.timeMin + 1 : 0
    const maxTime = next ? next.timeMin - 1 : 1440
    const newRev = session.rev + 1
    session.points = session.points.map((point) =>
      point.id === pointId
        ? {
            ...point,
            timeMin: Math.round(Math.min(maxTime, Math.max(minTime, timeMin))),
            tempC: Math.round(Math.min(1450, Math.max(0, tempC))),
            rev: newRev,
          }
        : point,
    )
    session.rev = newRev
    sessions.value = [...sessions.value]
    persist()
  }

  function addPointAfterStage(stageIndex: number) {
    recordHistory()
    const session = activeSession.value
    const stages = [...session.points].sort((a, b) => a.timeMin - b.timeMin)
    const start = stages[stageIndex]
    const end = stages[stageIndex + 1]
    if (!start || !end) return
    const newRev = session.rev + 1
    const point: FiringPoint = {
      id: `point-${crypto.randomUUID()}`,
      timeMin: Math.round((start.timeMin + end.timeMin) / 2),
      tempC: Math.round((start.tempC + end.tempC) / 2),
      rev: newRev,
    }
    session.points = [...session.points, point]
    session.rev = newRev
    selectedPointId.value = point.id
    selectedStageIndex.value = stageIndex + 1
    persist()
  }

  function removePoint(pointId: string) {
    const session = activeSession.value
    if (session.points.length <= 3) return
    recordHistory()
    session.points = session.points.filter((point) => point.id !== pointId)
    session.rev += 1
    selectedPointId.value = session.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function applyTemplate(templateId: string) {
    const template = templates.value.find((item) => item.id === templateId)
    if (!template) return
    recordHistory()
    const session = activeSession.value
    const newRev = session.rev + 1
    session.points = templateToPoints(template, session.id).map((point) => ({ ...point, rev: newRev }))
    session.clay = template.clay
    session.glaze = template.glaze
    session.rev = newRev
    selectedPointId.value = session.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function saveTemplateFromSession(name: string) {
    const template: CurveTemplate = {
      id: crypto.randomUUID(),
      name: name.trim() || `${activeSession.value.name} 模板`,
      clay: activeSession.value.clay,
      glaze: activeSession.value.glaze,
      peakTempC: Math.max(...activeSession.value.points.map((point) => point.tempC)),
      description: `从 ${activeSession.value.name} 保存，包含 ${activeSession.value.points.length} 个关键点。`,
      points: activeSession.value.points.map(({ timeMin, tempC }) => ({ timeMin, tempC })),
      updatedAt: new Date().toISOString(),
    }
    templates.value.unshift(template)
    persist()
  }

  function importSamples(samples: FiringSample[]) {
    recordHistory()
    const session = activeSession.value
    const newRev = session.rev + 1
    session.actualSamples = samples.map((sample) => ({ ...sample, rev: newRev }))
    session.status = 'review'
    session.rev = newRev
    persist()
  }

  function clearActualSamples() {
    recordHistory()
    const session = activeSession.value
    session.actualSamples = []
    session.rev += 1
    persist()
  }

  function setTimeOffset(offsetMin: number) {
    const session = activeSession.value
    session.timeOffsetMin = Number(offsetMin.toFixed(1))
    session.rev += 1
    session.timeOffsetRev = session.rev
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    const session = activeSession.value
    Object.assign(session, patch)
    session.rev += 1
    persist()
  }

  function addSession() {
    recordHistory()
    const source = activeSession.value
    const id = crypto.randomUUID()
    const session: KilnSession = {
      ...cloneSession(source),
      id,
      name: `新窑次 ${sessions.value.length + 1}`,
      firedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: 'draft',
      timeOffsetMin: 0,
      timeOffsetRev: 1,
      actualSamples: [],
      points: source.points.map((point, index) => ({
        ...point,
        id: `point-new-${Date.now()}-${index}`,
        rev: 1,
      })),
      rev: 1,
      baseRev: 1,
      pendingConflicts: [],
    }
    session.baseSnapshot = snapshotSession(session)
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    selectedPointId.value = session.points[0]?.id ?? null
    persist()
  }

  function removeSession(id: string) {
    if (sessions.value.length <= 1) return
    recordHistory()
    sessions.value = sessions.value.filter((session) => session.id !== id)
    overlaySessionIds.value = overlaySessionIds.value.filter((sessionId) => sessionId !== id)
    if (activeSessionId.value === id) activeSessionId.value = sessions.value[0].id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    persist()
  }

  function toggleOverlay(id: string) {
    if (id === activeSessionId.value) return
    overlaySessionIds.value = overlaySessionIds.value.includes(id)
      ? overlaySessionIds.value.filter((sessionId) => sessionId !== id)
      : [...overlaySessionIds.value, id]
    persist()
  }

  function exportSessionJson() {
    downloadSessionJson(activeSession.value)
  }

  /** 把合并结果应用到当前窑次；失败时本地草稿不动，保留导入内容以便重试 */
  function applyMergeOutcome(outcome: MergeOutcome): boolean {
    if (!outcome.ok || !outcome.session) return false
    recordHistory()
    sessions.value = sessions.value.map((session) =>
      session.id === activeSessionId.value ? outcome.session! : session,
    )
    selectedPointId.value = outcome.session.points[0]?.id ?? null
    selectedStageIndex.value = 0
    lastMergeStats.value = outcome.stats ?? null
    lastMergeAt.value = Date.now()
    persist()
    return true
  }

  /** 导入对方离线副本（JSON）并按修订号合并；任何失败都不改动本地草稿 */
  function importSessionJson(text: string): MergeOutcome {
    lastImportPayload.value = text
    lastImportError.value = null
    const parsed = parseSessionImport(text, activeSession.value.id)
    if (!parsed.ok) {
      lastImportError.value = parsed.error
      return { ok: false, error: parsed.error }
    }
    const outcome = mergeSessions(activeSession.value, parsed.session)
    if (!outcome.ok) {
      lastImportError.value = outcome.error ?? '合并失败，本地草稿未改动，可重试。'
      return outcome
    }
    if (!applyMergeOutcome(outcome)) {
      lastImportError.value = '合并结果应用失败，本地草稿未改动，可重试。'
      return { ok: false, error: lastImportError.value }
    }
    lastImportPayload.value = null
    return outcome
  }

  /** 用上次导入的内容重试合并 */
  function retryImport(): MergeOutcome {
    if (!lastImportPayload.value) {
      return { ok: false, error: '没有可重试的导入内容。' }
    }
    return importSessionJson(lastImportPayload.value)
  }

  /** 模拟对方离线分叉：基于共同基线施加离线改动并下载副本 */
  function simulateRemoteFork() {
    const remote = forkRemoteSession(activeSession.value)
    downloadSessionJson(remote)
  }

  /** 处理合并后留待确认的冲突：应用所选版本（本地回退或对方采纳） */
  function resolveConflict(conflictId: string, winner: 'local' | 'remote') {
    const session = activeSession.value
    const conflict = session.pendingConflicts.find((item) => item.id === conflictId)
    if (!conflict) return
    recordHistory()
    applyConflictValue(session, conflict, winner === 'local' ? conflict.localRaw : conflict.remoteRaw)
    session.pendingConflicts = session.pendingConflicts.filter((item) => item.id !== conflictId)
    session.rev += 1
    sessions.value = [...sessions.value]
    persist()
  }

  function applyConflictValue(session: KilnSession, conflict: PendingConflict, raw: unknown) {
    if (conflict.entityType === 'point') {
      if (raw === null) {
        session.points = session.points.filter((point) => point.id !== conflict.entityId)
      } else {
        const value = raw as { timeMin: number; tempC: number }
        const existing = session.points.find((point) => point.id === conflict.entityId)
        const newRev = session.rev + 1
        if (existing) {
          session.points = session.points.map((point) =>
            point.id === conflict.entityId ? { ...point, timeMin: value.timeMin, tempC: value.tempC, rev: newRev } : point,
          )
        } else {
          session.points = [...session.points, { id: conflict.entityId, timeMin: value.timeMin, tempC: value.tempC, rev: newRev }]
        }
      }
    } else if (conflict.entityType === 'sample') {
      if (raw === null) {
        session.actualSamples = session.actualSamples.filter((sample) => sample.id !== conflict.entityId)
      } else {
        const value = raw as { timeMin: number; tempC: number }
        const existing = session.actualSamples.find((sample) => sample.id === conflict.entityId)
        const newRev = session.rev + 1
        if (existing) {
          session.actualSamples = session.actualSamples.map((sample) =>
            sample.id === conflict.entityId ? { ...sample, timeMin: value.timeMin, tempC: value.tempC, rev: newRev } : sample,
          )
        } else {
          session.actualSamples = [...session.actualSamples, { id: conflict.entityId, timeMin: value.timeMin, tempC: value.tempC, rev: newRev }]
        }
      }
    } else if (conflict.entityType === 'offset') {
      session.timeOffsetMin = Number(raw)
      session.timeOffsetRev = session.rev + 1
    } else if (conflict.entityType === 'meta') {
      ;(session as unknown as Record<string, unknown>)[conflict.entityId] = raw
    }
  }

  return {
    sessions,
    templates,
    activeSessionId,
    activeSession,
    selectedPointId,
    selectedStageIndex,
    overlaySessionIds,
    visibleSessions,
    validationIssues,
    canUndo,
    canRedo,
    pendingConflictCount,
    lastImportError,
    lastMergeStats,
    lastMergeAt,
    undo,
    redo,
    beginDrag,
    endDrag,
    setActiveSession,
    updatePoint,
    addPointAfterStage,
    removePoint,
    applyTemplate,
    saveTemplateFromSession,
    importSamples,
    clearActualSamples,
    setTimeOffset,
    updateSessionMeta,
    addSession,
    removeSession,
    toggleOverlay,
    exportSessionJson,
    importSessionJson,
    retryImport,
    simulateRemoteFork,
    resolveConflict,
  }
})
