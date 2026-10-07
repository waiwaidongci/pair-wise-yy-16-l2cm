import assert from 'node:assert/strict'
import {
  forkRemoteSession,
  mergeSessions,
  migrateSession,
  parseSessionImport,
  snapshotSession,
} from '../src/utils/merge'
import type { KilnSession } from '../src/types/firing'

function makeSession(overrides: Partial<KilnSession> = {}): KilnSession {
  const points = [
    { id: 'p0', timeMin: 0, tempC: 20, rev: 1 },
    { id: 'p1', timeMin: 100, tempC: 500, rev: 1 },
    { id: 'p2', timeMin: 200, tempC: 1200, rev: 1 },
    { id: 'p3', timeMin: 300, tempC: 80, rev: 1 },
  ]
  const actualSamples = [
    { id: 's0', timeMin: 0, tempC: 20, rev: 1 },
    { id: 's1', timeMin: 100, tempC: 480, rev: 1 },
    { id: 's2', timeMin: 200, tempC: 1150, rev: 1 },
  ]
  const session: KilnSession = {
    id: 'session-1',
    name: '测试窑次',
    kiln: '气窑 1 号',
    clay: '青瓷泥',
    glaze: '天青釉',
    firedAt: '2026-10-01',
    status: 'draft',
    timeOffsetMin: 0,
    timeOffsetRev: 1,
    points,
    actualSamples,
    rev: 1,
    baseRev: 1,
    pendingConflicts: [],
    baseSnapshot: undefined as unknown as KilnSession['baseSnapshot'],
    ...overrides,
  }
  session.baseSnapshot = snapshotSession(session)
  return session
}

function cloneWith(session: KilnSession, patch: Partial<KilnSession>): KilnSession {
  const next = structuredClone(session)
  Object.assign(next, patch)
  // 离线编辑不推进基线：保留原 baseSnapshot
  return next
}

// 1. 只有对方改了一个关键点 → 直接采纳，无冲突
{
  const local = makeSession()
  const remote = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p1' ? { ...p, tempC: 520, rev: 2 } : p)),
    rev: 2,
  })
  const result = mergeSessions(local, remote)
  assert.equal(result.ok, true)
  assert.equal(result.session!.points.find((p) => p.id === 'p1')!.tempC, 520)
  assert.equal(result.conflicts!.length, 0)
  assert.equal(result.stats!.adoptedRemote, 1)
  console.log('✓ 单边修改关键点直接采纳')
}

// 2. 两边都改了同一个关键点 → 峰值更高的一版胜出，另一版留待确认
{
  const local = makeSession()
  // 本地把峰值 p2 抬到 1250
  const localEdited = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p2' ? { ...p, tempC: 1250, rev: 2 } : p)),
    rev: 2,
  })
  // 对方把峰值 p2 抬到 1280（对方峰值更高）
  const remote = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p2' ? { ...p, tempC: 1280, rev: 2 } : p)),
    rev: 2,
  })
  const result = mergeSessions(localEdited, remote)
  assert.equal(result.ok, true)
  assert.equal(result.session!.points.find((p) => p.id === 'p2')!.tempC, 1280, '应保留对方峰值更高的版本')
  assert.equal(result.conflicts!.length, 1)
  assert.equal(result.conflicts![0].winner, 'remote')
  assert.equal(result.conflicts![0].localRaw.tempC, 1250)
  assert.equal(result.conflicts![0].remoteRaw.tempC, 1280)
  console.log('✓ 双边修改关键点按峰值温度裁决（对方胜）')
}

// 3. 本地峰值更高时本地胜出
{
  const local = makeSession()
  const localEdited = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p2' ? { ...p, tempC: 1290, rev: 2 } : p)),
    rev: 2,
  })
  const remote = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p2' ? { ...p, tempC: 1260, rev: 2 } : p)),
    rev: 2,
  })
  const result = mergeSessions(localEdited, remote)
  assert.equal(result.session!.points.find((p) => p.id === 'p2')!.tempC, 1290)
  assert.equal(result.conflicts![0].winner, 'local')
  console.log('✓ 双边修改关键点按峰值温度裁决（本地胜）')
}

// 4. 只有本地改了采样 → 采纳本地
{
  const local = makeSession()
  const localEdited = cloneWith(local, {
    actualSamples: local.actualSamples.map((s) => (s.id === 's1' ? { ...s, tempC: 500, rev: 2 } : s)),
    rev: 2,
  })
  const remote = makeSession()
  const result = mergeSessions(localEdited, remote)
  assert.equal(result.session!.actualSamples.find((s) => s.id === 's1')!.tempC, 500)
  assert.equal(result.conflicts!.length, 0)
  console.log('✓ 单边修改采样直接采纳')
}

// 5. 两边改了同一采样 → 留本地待确认
{
  const local = makeSession()
  const localEdited = cloneWith(local, {
    actualSamples: local.actualSamples.map((s) => (s.id === 's1' ? { ...s, tempC: 500, rev: 2 } : s)),
    rev: 2,
  })
  const remote = cloneWith(local, {
    actualSamples: local.actualSamples.map((s) => (s.id === 's1' ? { ...s, tempC: 460, rev: 2 } : s)),
    rev: 2,
  })
  const result = mergeSessions(localEdited, remote)
  assert.equal(result.session!.actualSamples.find((s) => s.id === 's1')!.tempC, 500)
  assert.equal(result.conflicts!.length, 1)
  assert.equal(result.conflicts![0].entityType, 'sample')
  assert.equal(result.conflicts![0].winner, 'local')
  console.log('✓ 双边修改采样留本地待确认')
}

// 6. 对方删点、本地未改 → 接受删除
{
  const local = makeSession()
  const remote = cloneWith(local, {
    points: local.points.filter((p) => p.id !== 'p3'),
    rev: 2,
  })
  const result = mergeSessions(local, remote)
  assert.equal(result.session!.points.find((p) => p.id === 'p3'), undefined)
  assert.equal(result.conflicts!.length, 0)
  console.log('✓ 单边删除关键点被接受')
}

// 7. 对方删点但本地改过 → 保留本地并留待确认
{
  const local = makeSession()
  const localEdited = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p1' ? { ...p, tempC: 540, rev: 2 } : p)),
    rev: 2,
  })
  const remote = cloneWith(local, {
    points: local.points.filter((p) => p.id !== 'p1'),
    rev: 2,
  })
  const result = mergeSessions(localEdited, remote)
  assert.equal(result.session!.points.find((p) => p.id === 'p1')!.tempC, 540)
  assert.equal(result.conflicts!.length, 1)
  assert.equal(result.conflicts![0].entityType, 'point')
  assert.equal(result.conflicts![0].remoteRaw, null)
  console.log('✓ 删除与修改冲突时保留修改并留待确认')
}

// 8. 本地新增关键点 → 采纳
{
  const local = makeSession()
  const remote = makeSession()
  const newPoint = { id: 'p4', timeMin: 250, tempC: 1100, rev: 2 }
  local.points.push(newPoint)
  local.rev = 2
  const result = mergeSessions(local, remote)
  assert.equal(result.session!.points.find((p) => p.id === 'p4')!.tempC, 1100)
  console.log('✓ 本地新增关键点被采纳')
}

// 9. 两边都改了时间偏移 → 留本地待确认
{
  const local = cloneWith(makeSession(), { timeOffsetMin: 3, rev: 2, timeOffsetRev: 2 })
  const remote = cloneWith(makeSession(), { timeOffsetMin: -4, rev: 2, timeOffsetRev: 2 })
  const result = mergeSessions(local, remote)
  assert.equal(result.session!.timeOffsetMin, 3)
  assert.equal(result.conflicts!.length, 1)
  assert.equal(result.conflicts![0].entityType, 'offset')
  console.log('✓ 双边修改时间偏移留本地待确认')
}

// 10. 只有对方改了泥料 → 采纳对方
{
  const local = makeSession()
  const remote = cloneWith(local, { clay: '高白泥', rev: 2 })
  const result = mergeSessions(local, remote)
  assert.equal(result.session!.clay, '高白泥')
  assert.equal(result.conflicts!.length, 0)
  console.log('✓ 单边修改元信息直接采纳')
}

// 11. 旧窑次（无修订号）→ 先补齐再合并
{
  const legacy = makeSession()
  const legacyRaw = JSON.parse(JSON.stringify(legacy))
  delete legacyRaw.rev
  delete legacyRaw.baseRev
  delete legacyRaw.timeOffsetRev
  delete legacyRaw.baseSnapshot
  delete legacyRaw.pendingConflicts
  legacyRaw.points.forEach((p: { rev?: number }) => delete p.rev)
  legacyRaw.actualSamples.forEach((s: { rev?: number }) => delete s.rev)
  const migrated = migrateSession(legacyRaw)
  assert.equal(migrated.rev, 1)
  assert.equal(migrated.baseRev, 1)
  assert.equal(migrated.points[0].rev, 1)
  assert.ok(migrated.baseSnapshot)
  // 补齐后对方做单边修改，应能正常合并
  const remote = cloneWith(migrated, {
    points: migrated.points.map((p) => (p.id === 'p0' ? { ...p, tempC: 30, rev: 2 } : p)),
    rev: 2,
  })
  const result = mergeSessions(migrated, remote)
  assert.equal(result.ok, true)
  assert.equal(result.session!.points[0].tempC, 30)
  console.log('✓ 旧窑次补齐修订号后可合并')
}

// 12. 对方离线分叉 → 与本地修改合并，产生冲突
{
  const local = makeSession()
  // 本地先把峰值小幅抬高（看火工在平板上改了峰值），基线保持 rev 1
  local.points = local.points.map((p) => (p.id === 'p2' ? { ...p, tempC: 1205, rev: 2 } : p))
  local.rev = 2
  const remote = forkRemoteSession(local)
  assert.ok(remote.rev > local.baseRev)
  const result = mergeSessions(local, remote)
  assert.equal(result.ok, true)
  // 对方把峰值抬得更高，p2 冲突且对方胜出
  const pointConflict = result.conflicts!.find((c) => c.entityType === 'point')
  assert.ok(pointConflict, '应存在关键点冲突')
  assert.equal(pointConflict!.winner, 'remote')
  assert.equal(result.session!.points.find((p) => p.id === 'p2')!.tempC, 1218)
  console.log('✓ 离线分叉合并产生峰值冲突并按规则裁决')
}

// 13. 导入校验：坏 JSON / 版本不符 / 窑次不符 → 失败
{
  const current = makeSession()
  const bad = parseSessionImport('{not json', current.id)
  assert.equal(bad.ok, false)
  const wrongSchema = parseSessionImport(JSON.stringify({ schema: 'other/v1', session: current }), current.id)
  assert.equal(wrongSchema.ok, false)
  const other = makeSession({ id: 'session-2' })
  const wrongSession = parseSessionImport(
    JSON.stringify({ schema: 'kiln-firing-curve/v1', session: other }),
    current.id,
  )
  assert.equal(wrongSession.ok, false)
  const good = parseSessionImport(
    JSON.stringify({ schema: 'kiln-firing-curve/v1', session: current }),
    current.id,
  )
  assert.equal(good.ok, true)
  console.log('✓ 导入校验拦截坏 JSON / 版本不符 / 窑次不符')
}

// 14. 合并后基线推进，再次合并无冲突
{
  const local = makeSession()
  const remote = cloneWith(local, {
    points: local.points.map((p) => (p.id === 'p1' ? { ...p, tempC: 530, rev: 2 } : p)),
    rev: 2,
  })
  const first = mergeSessions(local, remote)
  assert.equal(first.conflicts!.length, 0)
  // 以合并结果为新基线，再与自己合并 → 全部自动合并
  const again = mergeSessions(first.session!, first.session!)
  assert.equal(again.conflicts!.length, 0)
  assert.equal(again.stats!.autoMerged, first.session!.points.length + first.session!.actualSamples.length)
  console.log('✓ 合并后基线推进，重复合并无冲突')
}

console.log('\n全部通过 ✔')
