import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type {
  ConflictValue,
  CurveTemplate,
  FailedImportDraft,
  FiringPoint,
  FiringSample,
  KilnSession,
  LegacyKilnSession,
  MergeReport,
  PendingConflict,
  RevisionBundle,
} from '../types/firing'
import { cloneSession, templateToPoints, validateCurve } from '../utils/curve'
import {
  applyBundleToSessions,
  buildBundle,
  DEVICE_OFFICE,
  ensureRevisions,
  makeShadow,
  nextRev,
  nowIso,
  parseBundle,
  samplesSignature,
} from '../utils/revision'
import { applyOfficeOfflineEdit, simulateTabletOffline } from '../utils/simulate'

const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'

interface PersistShape {
  sessions: KilnSession[]
  templates: CurveTemplate[]
  activeSessionId: string
  overlaySessionIds: string[]
  failedDrafts: FailedImportDraft[]
  lastMergeReport: MergeReport | null
  deviceName: string
}

function loadState(): PersistShape | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PersistShape) : null
  } catch {
    return null
  }
}

export const useFiringStore = defineStore('firing-studio', () => {
  const persisted = loadState()

  // 旧窑次没有修订号：载入时先按现有内容补齐修订号与基线，再参与后续合并
  const sessions = ref<KilnSession[]>(
    (persisted?.sessions?.length
      ? (persisted.sessions as unknown as LegacyKilnSession[])
      : createMockSessions()
    ).map(ensureRevisions),
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
  const failedDrafts = ref<FailedImportDraft[]>(persisted?.failedDrafts ?? [])
  const lastMergeReport = ref<MergeReport | null>(persisted?.lastMergeReport ?? null)
  const deviceName = ref(persisted?.deviceName || DEVICE_OFFICE)
  const selectedPointId = ref<string | null>(sessions.value[0].points[0]?.id ?? null)
  const selectedStageIndex = ref<number | null>(0)
  const undoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const redoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const dragHistoryPending = ref(false)

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
  const allPendingConflicts = computed(() =>
    sessions.value.flatMap((session) =>
      session.pendingConflicts.map((conflict) => ({ conflict, session })),
    ),
  )
  const pendingConflictCount = computed(() =>
    sessions.value.reduce((sum, session) => sum + session.pendingConflicts.length, 0),
  )

  function persist() {
    const payload: PersistShape = {
      sessions: sessions.value,
      templates: templates.value,
      activeSessionId: activeSessionId.value,
      overlaySessionIds: overlaySessionIds.value,
      failedDrafts: failedDrafts.value,
      lastMergeReport: lastMergeReport.value,
      deviceName: deviceName.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }

  /** 曲线关键点增删改后：曲线修订号 +1，阶段划分绑定旧曲线的偏差/风险结论立即标记失效 */
  function bumpCurve(session: KilnSession) {
    session.curveRev = nextRev(session.curveRev)
    session.analysis = {
      ...session.analysis,
      curveRev: session.curveRev - 1, // 仍是旧结论的修订号，等待重算
      stale: true,
      issueCount: session.analysis?.issueCount ?? 0,
    }
  }

  function bumpSamples(session: KilnSession) {
    session.analysis = {
      ...session.analysis,
      stale: true,
    }
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
    const nextTime = Math.round(Math.min(maxTime, Math.max(minTime, timeMin)))
    const nextTemp = Math.round(Math.min(1450, Math.max(0, tempC)))
    const target = session.points.find((point) => point.id === pointId)
    if (!target) return
    if (target.timeMin === nextTime && target.tempC === nextTemp) return
    target.timeMin = nextTime
    target.tempC = nextTemp
    target.rev = nextRev(target.rev)
    target.updatedAt = nowIso()
    bumpCurve(session)
    sessions.value = [...sessions.value]
    persist()
  }

  function addPointAfterStage(stageIndex: number) {
    recordHistory()
    const stages = [...activeSession.value.points].sort((a, b) => a.timeMin - b.timeMin)
    const start = stages[stageIndex]
    const end = stages[stageIndex + 1]
    if (!start || !end) return
    const middleTime = Math.round((start.timeMin + end.timeMin) / 2)
    const middleTemp = Math.round((start.tempC + end.tempC) / 2)
    const point: FiringPoint = {
      id: `point-${crypto.randomUUID()}`,
      timeMin: middleTime,
      tempC: middleTemp,
      rev: 1,
      updatedAt: nowIso(),
    }
    activeSession.value.points = [...activeSession.value.points, point]
    bumpCurve(activeSession.value)
    selectedPointId.value = point.id
    selectedStageIndex.value = stageIndex + 1
    persist()
  }

  function removePoint(pointId: string) {
    if (activeSession.value.points.length <= 3) return
    recordHistory()
    activeSession.value.points = activeSession.value.points.filter((point) => point.id !== pointId)
    bumpCurve(activeSession.value)
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function applyTemplate(templateId: string) {
    const template = templates.value.find((item) => item.id === templateId)
    if (!template) return
    recordHistory()
    activeSession.value.points = templateToPoints(template, activeSession.value.id).map((point) => ({
      ...point,
      rev: nextRev(Math.max(0, ...activeSession.value.points.map((item) => item.rev))),
      updatedAt: nowIso(),
    }))
    activeSession.value.clay = template.clay
    activeSession.value.glaze = template.glaze
    bumpCurve(activeSession.value)
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
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
      description: `从 ${activeSession.value.name} 保存，包含 ${activeSession.value.points.length} 个关键点（曲线 r${activeSession.value.curveRev}）。`,
      points: activeSession.value.points.map(({ timeMin, tempC }) => ({ timeMin, tempC })),
      updatedAt: new Date().toISOString(),
    }
    templates.value.unshift(template)
    persist()
  }

  function importSamples(samples: Array<Omit<FiringSample, 'rev'>>) {
    recordHistory()
    const session = activeSession.value
    const maxRev = Math.max(0, ...session.actualSamples.map((sample) => sample.rev))
    session.actualSamples = samples.map((sample, index) => ({
      ...sample,
      rev: maxRev + index + 1,
      updatedAt: nowIso(),
    }))
    session.status = 'review'
    bumpSamples(session)
    persist()
  }

  function clearActualSamples() {
    recordHistory()
    activeSession.value.actualSamples = []
    bumpSamples(activeSession.value)
    persist()
  }

  function setTimeOffset(offsetMin: number) {
    const session = activeSession.value
    const rounded = Number(offsetMin.toFixed(1))
    if (rounded === session.timeOffsetMin) return
    session.timeOffsetMin = rounded
    session.timeOffsetRev = nextRev(session.timeOffsetRev)
    session.analysis = { ...session.analysis, stale: true }
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    Object.assign(activeSession.value, patch)
    persist()
  }

  function addSession() {
    recordHistory()
    const source = activeSession.value
    const session: KilnSession = ensureRevisions({
      ...cloneSession(source),
      id: crypto.randomUUID(),
      name: `新窑次 ${sessions.value.length + 1}`,
      firedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: 'draft',
      actualSamples: [],
      pendingConflicts: [],
      points: source.points.map((point, index) => ({
        ...point,
        id: `point-new-${Date.now()}-${index}`,
        rev: 1,
        updatedAt: nowIso(),
      })),
    })
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

  /* ---------------------------------------------------------------- */
  /* 派生结论重算：曲线 / 采样 / 偏移变动后阶段划分跟着变，旧结论失效    */
  /* ---------------------------------------------------------------- */

  function recomputeAnalysis(sessionId?: string) {
    const target = sessionId
      ? sessions.value.find((session) => session.id === sessionId)
      : activeSession.value
    if (!target) return
    const issues = validateCurve(target)
    target.analysis = {
      curveRev: target.curveRev,
      samplesSig: samplesSignature(target.actualSamples),
      offsetRev: target.timeOffsetRev,
      stale: false,
      calculatedAt: nowIso(),
      issueCount: issues.length,
    }
    persist()
  }

  /* ---------------------------------------------------------------- */
  /* 修订包导出 / 合并                                                  */
  /* ---------------------------------------------------------------- */

  function exportRevisionBundle(sessionIds?: string[]) {
    const chosen = sessionIds
      ? sessions.value.filter((session) => sessionIds.includes(session.id))
      : sessions.value
    return buildBundle(chosen, deviceName.value)
  }

  /**
   * 合并对端修订包。任何一步失败都抛出异常，调用方负责把原始载荷留作本地草稿，
   * 已有本地数据不会被覆盖。
   */
  function applyRevisionBundle(raw: string, filename: string): MergeReport {
    let bundle: RevisionBundle
    try {
      bundle = parseBundle(raw)
    } catch (error) {
      saveFailedDraft({
        kind: 'bundle',
        filename,
        payload: raw,
        error: error instanceof Error ? error.message : '修订包解析失败',
      })
      throw error
    }

    // 纯函数在深拷贝上合并：失败时直接放弃返回值，本地状态原封不动
    const beforeSessions = sessions.value.map(cloneSession)
    try {
      const applied = applyBundleToSessions(beforeSessions, bundle)
      recordHistory()
      sessions.value = applied.sessions
      lastMergeReport.value = applied.report
      // 曲线关键点一动阶段就重划：合并后立即按新曲线重算偏差 / 开裂风险结论
      applied.report.sessions.forEach((report) => recomputeAnalysis(report.sessionId))
      selectedPointId.value = activeSession.value.points[0]?.id ?? null
      persist()
      return applied.report
    } catch (error) {
      // 合并途中失败：本地状态未被触碰，原始包留作草稿可重试
      sessions.value = beforeSessions
      persist()
      saveFailedDraft({
        kind: 'bundle',
        filename,
        payload: raw,
        sessionName: bundle?.deviceName,
        error: error instanceof Error ? error.message : '合并过程中发生未知错误',
      })
      throw error instanceof Error ? error : new Error('合并失败，已保留本地草稿')
    }
  }

  function saveFailedDraft(draft: Omit<FailedImportDraft, 'id' | 'createdAt'>) {
    failedDrafts.value.unshift({
      ...draft,
      id: `draft-${crypto.randomUUID()}`,
      createdAt: nowIso(),
    })
    persist()
  }

  function saveCsvDraft(filename: string, payload: string, sessionId: string, error: string) {
    const session = sessions.value.find((item) => item.id === sessionId)
    saveFailedDraft({
      kind: 'csv',
      filename,
      payload,
      sessionId,
      sessionName: session?.name,
      error,
    })
  }

  function retryDraft(draftId: string): MergeReport | null {
    const draft = failedDrafts.value.find((item) => item.id === draftId)
    if (!draft) return null
    if (draft.kind === 'bundle') {
      const report = applyRevisionBundle(draft.payload, draft.filename)
      failedDrafts.value = failedDrafts.value.filter((item) => item.id !== draftId)
      persist()
      return report
    }
    // CSV 草稿由页面重新解析导入，这里只返回 null 表示交给调用方
    return null
  }

  function consumeCsvDraft(draftId: string) {
    const draft = failedDrafts.value.find((item) => item.id === draftId)
    failedDrafts.value = failedDrafts.value.filter((item) => item.id !== draftId)
    persist()
    return draft ?? null
  }

  function removeDraft(draftId: string) {
    failedDrafts.value = failedDrafts.value.filter((item) => item.id !== draftId)
    persist()
  }

  /**
   * 一键演示离线两边同改：
   * 办公室先改高峰值 → 平板基于修改前内容分叉改低峰值/补采样/调偏移 → 立即合并。
   */
  function runOfflineSimulation(sessionId: string): MergeReport {
    const before = sessions.value.map(cloneSession)
    const target = sessions.value.find((session) => session.id === sessionId)
    if (!target) throw new Error('找不到要模拟的窑次')
    recordHistory()
    applyOfficeOfflineEdit(target)
    persist()
    const tabletBundle = simulateTabletOffline(before, sessionId)
    return applyRevisionBundle(JSON.stringify(tabletBundle), '窑边平板-离线修订包.json')
  }

  /* ---------------------------------------------------------------- */
  /* 待确认冲突人工裁决                                                  */
  /* ---------------------------------------------------------------- */

  function chooseConflict(conflictId: string, choice: 'winner' | 'loser') {
    recordHistory()
    for (const session of sessions.value) {
      const conflict = session.pendingConflicts.find((item) => item.id === conflictId)
      if (!conflict) continue
      const chosen: ConflictValue = choice === 'winner' ? conflict.winner : conflict.loser
      applyConflictChoice(session, conflict, chosen)
      session.pendingConflicts = session.pendingConflicts.filter((item) => item.id !== conflictId)
      // 人工裁决后基线对齐到当前内容，避免下次合并再次报冲突
      session.syncShadow = makeShadow(session)
      persist()
      // 采纳任一版本都可能改变曲线：立即按新曲线重算阶段、偏差与开裂风险
      recomputeAnalysis(session.id)
      return
    }
  }

  function applyConflictChoice(session: KilnSession, conflict: PendingConflict, chosen: ConflictValue) {
    if (conflict.kind === 'offset') {
      session.timeOffsetMin = chosen.offsetMin ?? session.timeOffsetMin
      session.timeOffsetRev = nextRev(Math.max(session.timeOffsetRev, chosen.rev))
      return
    }
    if (conflict.kind === 'point-delete') {
      if (chosen.tempC === undefined) {
        // 选择了删除方
        session.points = session.points.filter((point) => point.id !== conflict.entityId)
        session.curveRev = nextRev(session.curveRev)
      } else {
        upsertPoint(session, chosen)
      }
      return
    }
    if (conflict.kind === 'sample-delete') {
      if (chosen.tempC === undefined) {
        session.actualSamples = session.actualSamples.filter((sample) => sample.id !== conflict.entityId)
      } else {
        upsertSample(session, chosen)
      }
      return
    }
    if (conflict.kind === 'point') {
      upsertPoint(session, chosen, conflict.entityId)
      return
    }
    upsertSample(session, chosen, conflict.entityId)
  }

  function upsertPoint(session: KilnSession, chosen: ConflictValue, entityId?: string) {
    const existing = session.points.find((point) => point.id === (entityId ?? ''))
    if (existing && chosen.timeMin !== undefined && chosen.tempC !== undefined) {
      existing.timeMin = chosen.timeMin
      existing.tempC = chosen.tempC
      existing.rev = nextRev(Math.max(existing.rev, chosen.rev))
      existing.updatedAt = nowIso()
    }
    session.curveRev = nextRev(session.curveRev)
  }

  function upsertSample(session: KilnSession, chosen: ConflictValue, entityId?: string) {
    const existing = session.actualSamples.find((sample) => sample.id === (entityId ?? ''))
    if (existing && chosen.timeMin !== undefined && chosen.tempC !== undefined) {
      existing.timeMin = chosen.timeMin
      existing.tempC = chosen.tempC
      existing.rev = nextRev(Math.max(existing.rev, chosen.rev))
      existing.updatedAt = nowIso()
    }
  }

  function dismissConflict(conflictId: string) {
    for (const session of sessions.value) {
      if (session.pendingConflicts.some((item) => item.id === conflictId)) {
        session.pendingConflicts = session.pendingConflicts.filter((item) => item.id !== conflictId)
        session.syncShadow = makeShadow(session)
        persist()
        return
      }
    }
  }

  function exportSessionJson() {
    const payload = {
      schema: 'kiln-firing-curve/v1',
      exportedAt: new Date().toISOString(),
      session: activeSession.value,
      validation: validationIssues.value,
      revision: {
        curveRev: activeSession.value.curveRev,
        timeOffsetRev: activeSession.value.timeOffsetRev,
      },
      timeAlignment: {
        offsetMin: activeSession.value.timeOffsetMin,
        basis: 'actual elapsed time + offset vs target arrival time',
      },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${activeSession.value.name}-烧成数据.json`
    anchor.click()
    URL.revokeObjectURL(url)
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
    failedDrafts,
    lastMergeReport,
    deviceName,
    allPendingConflicts,
    pendingConflictCount,
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
    recomputeAnalysis,
    exportRevisionBundle,
    applyRevisionBundle,
    saveCsvDraft,
    retryDraft,
    consumeCsvDraft,
    removeDraft,
    runOfflineSimulation,
    chooseConflict,
    dismissConflict,
  }
})
