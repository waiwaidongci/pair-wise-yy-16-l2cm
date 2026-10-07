// 合并逻辑验证：用 tsc 把 TS 转成 CJS 后在 node 里跑
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

mkdirSync('/tmp/merge-check', { recursive: true })
execSync('node_modules/.bin/tsc src/utils/revision.ts --outDir /tmp/merge-check --module commonjs --target es2022 --moduleResolution node --skipLibCheck', { stdio: 'inherit' })

const {
  ensureRevisions,
  buildBundle,
  parseBundle,
  mergeSession,
  applyBundleToSessions,
  DEVICE_TABLET,
} = await import('file:///tmp/merge-check/utils/revision.js')

let passed = 0
function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${message}`)
  }
}

function makeLegacySession(overrides = {}) {
  return {
    id: 's1',
    name: '测试窑次',
    kiln: '气窑1号',
    clay: '青瓷泥',
    glaze: '天青釉',
    firedAt: '2026-10-01',
    status: 'draft',
    timeOffsetMin: 0,
    // 注意：旧数据没有任何修订号
    points: [
      { id: 'p0', timeMin: 0, tempC: 20 },
      { id: 'p1', timeMin: 100, tempC: 600 },
      { id: 'p2', timeMin: 400, tempC: 1260 },
      { id: 'p3', timeMin: 700, tempC: 80 },
    ],
    actualSamples: [
      { id: 'm0', timeMin: 0, tempC: 20 },
      { id: 'm1', timeMin: 50, tempC: 300 },
    ],
    ...overrides,
  }
}

// ---------- 1. 旧窑次补齐 ----------
{
  const session = ensureRevisions(makeLegacySession())
  assert(session.points.every((p) => p.rev === 1), '旧关键点补齐修订号 rev=1')
  assert(session.actualSamples.every((s) => s.rev === 1), '旧采样补齐修订号 rev=1')
  assert(session.curveRev === 1 && session.timeOffsetRev === 1, '曲线 / 偏移修订号补齐为 1')
  assert(session.syncShadow.points.length === 4, '按现有内容生成合并基线（4 个关键点）')
  assert(session.syncShadow.timeOffsetMin === 0, '基线记录时间偏移')
}

// ---------- 2. 只有一边动过 → 直接采纳 ----------
{
  const office = ensureRevisions(makeLegacySession())
  // 平板只改了 p1 温度，并新增一个采样
  const tabletBundle = buildBundle([JSON.parse(JSON.stringify(office))], DEVICE_TABLET)
  const remote = tabletBundle.sessions[0]
  remote.points.find((p) => p.id === 'p1').tempC = 650
  remote.points.find((p) => p.id === 'p1').rev = 2
  remote.actualSamples.push({ id: 'm2', timeMin: 100, tempC: 610, rev: 2 })
  remote.timeOffsetMin = 5
  remote.timeOffsetRev = 2

  const result = mergeSession(office, remote, DEVICE_TABLET)
  assert(result.conflicts.length === 0, '单边修改不产生冲突')
  assert(result.merged.points.find((p) => p.id === 'p1').tempC === 650, '直接采纳平板的关键点修改')
  assert(result.merged.actualSamples.some((s) => s.id === 'm2'), '直接采纳平板新增采样')
  assert(result.merged.timeOffsetMin === 5, '直接采纳平板的时间偏移')
}

// ---------- 3. 两边改同一关键点 → 峰值温度更高者胜，败版待确认 ----------
{
  const office = ensureRevisions(makeLegacySession())
  const officeBase = JSON.parse(JSON.stringify(office))
  // 办公室升高 p2
  office.points.find((p) => p.id === 'p2').tempC = 1285
  office.points.find((p) => p.id === 'p2').rev = 2
  office.curveRev = 2
  // 平板降低 p2
  const remote = buildBundle([officeBase], DEVICE_TABLET).sessions[0]
  remote.points.find((p) => p.id === 'p2').tempC = 1240
  remote.points.find((p) => p.id === 'p2').rev = 2
  remote.curveRev = 2

  const result = mergeSession(office, remote, DEVICE_TABLET)
  assert(result.conflicts.length === 1, '同一关键点双改产生 1 个待确认')
  assert(result.merged.points.find((p) => p.id === 'p2').tempC === 1285, '自动保留峰值更高的办公室版 1285')
  assert(result.conflicts[0].loser.tempC === 1240, '败版 1240 留在待确认')
  assert(/峰值温度更高/.test(result.conflicts[0].autoRule), '待确认项说明裁决依据')

  // 温度相同 → 修订号更高者胜
  const office2 = ensureRevisions(makeLegacySession())
  const base2 = JSON.parse(JSON.stringify(office2))
  office2.points.find((p) => p.id === 'p2').tempC = 1260
  office2.points.find((p) => p.id === 'p2').rev = 3
  const remote2 = buildBundle([base2], DEVICE_TABLET).sessions[0]
  remote2.points.find((p) => p.id === 'p2').tempC = 1260
  remote2.points.find((p) => p.id === 'p2').timeMin = 410
  remote2.points.find((p) => p.id === 'p2').rev = 2
  const result2 = mergeSession(office2, remote2, DEVICE_TABLET)
  assert(result2.merged.points.find((p) => p.id === 'p2').timeMin === 400, '温度相同时修订号更高（办公室 r3）胜出')
  assert(result2.conflicts.length === 1, '温度相同仍保留败版待确认')
}

// ---------- 4. 一端删除另一端修改 → 保留修改版，删除待确认 ----------
{
  const office = ensureRevisions(makeLegacySession())
  const base = JSON.parse(JSON.stringify(office))
  office.points.find((p) => p.id === 'p1').tempC = 700
  office.points.find((p) => p.id === 'p1').rev = 2
  const remote = buildBundle([base], DEVICE_TABLET).sessions[0]
  remote.points = remote.points.filter((p) => p.id !== 'p1')

  const result = mergeSession(office, remote, DEVICE_TABLET)
  assert(result.merged.points.some((p) => p.id === 'p1'), '修改优先于删除：关键点保留')
  assert(result.conflicts[0]?.kind === 'point-delete', '删除操作留待确认')
}

// ---------- 5. 时间偏移两边都调 → r 高者胜，另一版待确认 ----------
{
  const office = ensureRevisions(makeLegacySession())
  const base = JSON.parse(JSON.stringify(office))
  office.timeOffsetMin = 3
  office.timeOffsetRev = 2
  const remote = buildBundle([base], DEVICE_TABLET).sessions[0]
  remote.timeOffsetMin = -4
  remote.timeOffsetRev = 3

  const result = mergeSession(office, remote, DEVICE_TABLET)
  assert(result.merged.timeOffsetMin === -4, '时间偏移保留修订号更高的平板 r3')
  assert(result.conflicts[0]?.kind === 'offset', '另一版时间偏移留待确认')
}

// ---------- 6. 本地没有的窑次 → 整份采纳 ----------
{
  const other = ensureRevisions(makeLegacySession({ id: 's9', name: '新窑次' }))
  const remote = buildBundle([other], DEVICE_TABLET).sessions[0]
  const result = mergeSession(null, remote, DEVICE_TABLET)
  assert(result.isNewSession === true, '标记为新窑次')
  assert(result.merged.points.length === 4, '整份采纳对端窑次')
  assert(result.conflicts.length === 0, '新窑次无冲突')
}

// ---------- 7. 基线在合并后刷新 ----------
{
  const office = ensureRevisions(makeLegacySession())
  const base = JSON.parse(JSON.stringify(office))
  office.points.find((p) => p.id === 'p1').tempC = 660
  office.points.find((p) => p.id === 'p1').rev = 2
  office.curveRev = 2
  const remote = buildBundle([base], DEVICE_TABLET).sessions[0]
  remote.actualSamples.push({ id: 'm9', timeMin: 90, tempC: 500, rev: 2 })
  remote.curveRev = 2

  const result = mergeSession(office, remote, DEVICE_TABLET)
  assert(result.merged.shadow.points.find((p) => p.id === 'p1').tempC === 660, '合并后基线含办公室修改')
  assert(result.merged.shadow.samples.some((s) => s.id === 'm9'), '合并后基线含平板新采样')
  assert(result.merged.curveRev === 3, '合并产生曲线新版本 r3（max(r2,r1)+1）')
}

// ---------- 8. 修订包解析失败抛错（交给 store 存草稿） ----------
{
  let failed = false
  try {
    parseBundle('{ not json')
  } catch {
    failed = true
  }
  assert(failed, '损坏修订包解析失败并抛出')
  let wrongSchema = false
  try {
    parseBundle(JSON.stringify({ schema: 'other/v1', sessions: [] }))
  } catch {
    wrongSchema = true
  }
  assert(wrongSchema, '错误 schema 版本拒绝合并')
}

// ---------- 9. 整包应用：多窑次 + 新窑次 + 不污染本地输入（失败回滚基础） ----------
{
  const officeA = ensureRevisions(makeLegacySession({ id: 'a' }))
  const officeB = ensureRevisions(makeLegacySession({ id: 'b', name: '二号窑' }))
  const locals = [officeA, officeB]

  // 平板包：改 a 的一个点 + 带一个本地没有的新窑次 c
  const forkA = JSON.parse(JSON.stringify(officeA))
  forkA.points.find((p) => p.id === 'p1').tempC = 720
  forkA.points.find((p) => p.id === 'p1').rev = 2
  const forkC = ensureRevisions(makeLegacySession({ id: 'c', name: '平板新建窑次' }))
  const bundle = buildBundle([forkA, forkC], DEVICE_TABLET)

  const snapshotBefore = JSON.stringify(locals)
  const applied = applyBundleToSessions(locals, bundle)
  assert(JSON.stringify(locals) === snapshotBefore, '整包合并不修改入参（失败时本地原样保留）')
  assert(applied.sessions.some((s) => s.id === 'c'), '新窑次并入本地')
  const mergedA = applied.sessions.find((s) => s.id === 'a')
  assert(mergedA.points.find((p) => p.id === 'p1').tempC === 720, '既有窑次采纳对端修改')
  assert(mergedA.analysis.stale === true, '合并后偏差 / 风险结论标记失效，等待按新曲线重算')
  assert(applied.report.conflictCount === 0, '报告无冲突')
  assert(applied.report.sessions.length === 2, '报告覆盖包内两个窑次')

  // 坏包：schema 校验在 parseBundle 阶段拦截；构造结构损坏的窑次让合并抛错
  const broken = buildBundle([forkA], DEVICE_TABLET)
  delete broken.sessions[0].points
  let threw = false
  try {
    applyBundleToSessions(locals, broken)
  } catch {
    threw = true
  }
  assert(threw, '损坏窑次导致合并抛错')
  assert(JSON.stringify(locals) === snapshotBefore, '抛错后本地输入依然完好（可重试）')
}

console.log(`\n${passed} 项断言通过`)
