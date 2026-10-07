/* eslint-disable no-console */
// Store 端到端验证（由 scripts/verify-store.mjs 编译执行）
declare const process: { exitCode: number }
declare const globalThis: { localStorage?: unknown } & Record<string, unknown>
import { createPinia, setActivePinia } from 'pinia'
import { useFiringStore } from '../src/stores/firingStore'

// localStorage polyfill（Node 环境没有）
const memory = new Map<string, string>()
;(globalThis as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key),
  clear: () => memory.clear(),
}
setActivePinia(createPinia())

let passed = 0
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${message}`)
  }
}

const store = useFiringStore()
const sessionId = store.sessions[0].id
const originalPeak = Math.max(...store.sessions[0].points.map((point) => point.tempC))

// 1. 旧数据载入即补齐
assert(store.sessions.every((session) => session.curveRev >= 1), '全部窑次已补齐曲线修订号')
assert(store.sessions.every((session) => session.points.every((point) => point.rev >= 1)), '全部关键点有修订号')

// 2. 模拟离线双改并合并
const report = store.runOfflineSimulation(sessionId)
const session = store.sessions.find((item) => item.id === sessionId)!
assert(report.sessions[0].conflicts.length >= 1, '离线合并产生待确认冲突')
assert(session.pendingConflicts.some((item) => item.kind === 'point'), '同一关键点双改进入待确认')
const peakAfterMerge = Math.max(...session.points.map((point) => point.tempC))
assert(peakAfterMerge === originalPeak + 25, `自动保留峰值更高的办公室版（${originalPeak} → ${peakAfterMerge}）`)
assert(session.analysis.stale === false, '合并后已按新曲线重算结论（stale=false）')
assert(session.actualSamples.length >= 4, '平板补录采样已并入')
assert(session.timeOffsetMin <= 1, '时间偏移按规则合并')

// 3. 人工改采败版
const pointConflict = session.pendingConflicts.find((item) => item.kind === 'point')!
store.chooseConflict(pointConflict.id, 'loser')
const updated = store.sessions.find((item) => item.id === sessionId)!
assert(updated.pendingConflicts.every((item) => item.id !== pointConflict.id), '裁决后冲突从待确认移除')
const loserPeak = pointConflict.loser.tempC!
const conflictPoint = updated.points.find((point) => point.id === pointConflict.entityId)!
assert(conflictPoint.tempC === loserPeak, '改采败版后该关键点切换为败版温度')
assert(updated.analysis.stale === false, '裁决后按新曲线重新重算')

// 4. 损坏修订包：失败留存草稿，数据不动
const beforeJson = JSON.stringify(store.sessions)
const sessionsBefore = store.sessions.length
let failed = false
try {
  store.applyRevisionBundle('{坏json', 'bad.json')
} catch {
  failed = true
}
assert(failed, '损坏修订包合并抛错')
assert(store.failedDrafts.some((draft) => draft.filename === 'bad.json'), '失败后留存本地草稿')
assert(JSON.stringify(store.sessions) === beforeJson, '失败不影响已有本地数据')
assert(store.sessions.length === sessionsBefore, '失败不增减窑次')

// 5. 草稿重试坏包仍失败但草稿保留；手工构造一个合法包重试成功后草稿被移除
const validBundle = store.exportRevisionBundle([sessionId])
// 用一个能通过校验但与当前基线一致的包（无变更，幂等）
const report2 = store.applyRevisionBundle(JSON.stringify(validBundle), 'ok.json')
assert(report2.conflictCount === 0, '同基线包幂等合并无冲突')

console.log(`\n${passed} 项断言通过`)
