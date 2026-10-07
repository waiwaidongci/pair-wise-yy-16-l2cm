import type {
  BundleSession,
  ConflictValue,
  FiringPoint,
  FiringSample,
  KilnSession,
  LegacyKilnSession,
  MergeReport,
  MergeSessionReport,
  PendingConflict,
  RevisionBundle,
  SessionShadow,
} from '../types/firing'

export const DEVICE_OFFICE = '办公室电脑（配方师）'
export const DEVICE_TABLET = '窑边平板（看火工）'
export const BUNDLE_SCHEMA = 'kiln-firing-revision-bundle/v2'

export function nowIso() {
  return new Date().toISOString()
}

export function nextRev(current: number) {
  return (current || 0) + 1
}

/* ------------------------------------------------------------------ */
/* 旧窑次补齐：没有修订号的数据按现有内容初始化到当前修订               */
/* ------------------------------------------------------------------ */

export function ensureRevisions(session: LegacyKilnSession | KilnSession): KilnSession {
  const migrated = JSON.parse(JSON.stringify(session)) as KilnSession
  migrated.points = migrated.points.map((point) => ({
    ...point,
    rev: Math.max(1, point.rev ?? 1),
    updatedAt: point.updatedAt ?? migrated.firedAt ?? nowIso(),
  }))
  migrated.actualSamples = migrated.actualSamples.map((sample) => ({
    ...sample,
    rev: Math.max(1, sample.rev ?? 1),
    updatedAt: sample.updatedAt ?? migrated.firedAt ?? nowIso(),
  }))
  migrated.curveRev = Math.max(1, migrated.curveRev ?? 1)
  migrated.timeOffsetRev = Math.max(1, migrated.timeOffsetRev ?? 1)
  if (!migrated.syncShadow) {
    migrated.syncShadow = makeShadow(migrated)
  }
  if (!migrated.pendingConflicts) migrated.pendingConflicts = []
  if (!migrated.analysis) {
    migrated.analysis = {
      curveRev: migrated.curveRev,
      samplesSig: samplesSignature(migrated.actualSamples),
      offsetRev: migrated.timeOffsetRev,
      stale: false,
      calculatedAt: nowIso(),
      issueCount: 0,
    }
  }
  return migrated
}

export function makeShadow(session: KilnSession): SessionShadow {
  return {
    points: JSON.parse(JSON.stringify(session.points)) as FiringPoint[],
    samples: JSON.parse(JSON.stringify(session.actualSamples)) as FiringSample[],
    timeOffsetMin: session.timeOffsetMin,
    timeOffsetRev: session.timeOffsetRev,
    mergedAt: nowIso(),
  }
}

export function samplesSignature(samples: FiringSample[]) {
  // 采样点多，签名只看数量 + 首尾 + 抽样校验，避免全量序列化开销
  if (!samples.length) return 'empty'
  const indices = [0, Math.floor(samples.length / 2), samples.length - 1]
  const picked = indices.map((index) => `${samples[index].id}:${samples[index].timeMin}:${samples[index].tempC}:${samples[index].rev}`)
  return `${samples.length}|${picked.join('|')}`
}

/* ------------------------------------------------------------------ */
/* 修订包                                                              */
/* ------------------------------------------------------------------ */

export function buildBundle(sessions: KilnSession[], deviceName: string): RevisionBundle {
  return {
    schema: BUNDLE_SCHEMA,
    deviceName,
    exportedAt: nowIso(),
    sessions: sessions.map((session) => ({
      id: session.id,
      name: session.name,
      kiln: session.kiln,
      clay: session.clay,
      glaze: session.glaze,
      curveRev: session.curveRev,
      timeOffsetMin: session.timeOffsetMin,
      timeOffsetRev: session.timeOffsetRev,
      points: JSON.parse(JSON.stringify(session.points)),
      actualSamples: JSON.parse(JSON.stringify(session.actualSamples)),
      shadow: JSON.parse(JSON.stringify(session.syncShadow)),
    })),
  }
}

export function parseBundle(raw: string): RevisionBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('修订包不是有效的 JSON 文件，请确认导出后没有被改动。')
  }
  const bundle = parsed as Partial<RevisionBundle>
  if (bundle?.schema !== BUNDLE_SCHEMA) {
    throw new Error('修订包版本不匹配（应为 kiln-firing-revision-bundle/v2），无法安全合并。')
  }
  if (!Array.isArray(bundle.sessions) || !bundle.sessions.length) {
    throw new Error('修订包中没有任何窑次数据。')
  }
  for (const session of bundle.sessions) {
    if (!session?.id || !Array.isArray(session.points)) {
      throw new Error('修订包中存在结构不完整的窑次，合并已中止，本地草稿保留。')
    }
  }
  return bundle as RevisionBundle
}

/* ------------------------------------------------------------------ */
/* 三向合并：base 为公共基线，local 为办公室端，remote 为平板端         */
/* 规则：                                                              */
/*  - 只有一边动过：直接采纳                                           */
/*  - 两边都改过同一关键点：峰值温度更高的一版胜出，另一版留待确认      */
/*  - 温度相同（采样 / 偏移等同理）：修订号更高者胜，另一版待确认       */
/* ------------------------------------------------------------------ */

function valueOf(side: 'local' | 'remote', device: string, point: FiringPoint): ConflictValue {
  return { side, device, rev: point.rev, timeMin: point.timeMin, tempC: point.tempC, updatedAt: point.updatedAt }
}

function sampleValue(side: 'local' | 'remote', device: string, sample: FiringSample): ConflictValue {
  return { side, device, rev: sample.rev, timeMin: sample.timeMin, tempC: sample.tempC, updatedAt: sample.updatedAt }
}

function pointLabel(point: FiringPoint) {
  return `关键点（${point.timeMin} min · ${point.tempC} ℃，r${point.rev}）`
}

function sampleLabel(sample: FiringSample) {
  const hours = Math.floor(sample.timeMin / 60)
  const minutes = Math.round(sample.timeMin % 60)
  return `实测采样 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} · ${sample.tempC.toFixed(0)} ℃（r${sample.rev}）`
}

interface Mergeable {
  id: string
  rev: number
}

type DiffState = 'unchanged' | 'modified' | 'deleted' | 'added'

function diffStates<T extends Mergeable>(
  current: Map<string, T>,
  base: Map<string, T>,
): Map<string, DiffState> {
  const states = new Map<string, DiffState>()
  for (const id of new Set([...current.keys(), ...base.keys()])) {
    const now = current.has(id)
    const before = base.has(id)
    if (now && before) {
      states.set(id, current.get(id)!.rev > base.get(id)!.rev ? 'modified' : 'unchanged')
    } else if (now && !before) {
      states.set(id, 'added')
    } else {
      states.set(id, 'deleted')
    }
  }
  return states
}

/**
 * 按峰值温度裁决关键点：温度更高者胜出；温度相同则修订号更高者胜。
 * 返回胜出侧（'local' | 'remote'）。
 */
function higherPeakWins(localPoint: FiringPoint, remotePoint: FiringPoint): 'local' | 'remote' {
  if (remotePoint.tempC !== localPoint.tempC) {
    return remotePoint.tempC > localPoint.tempC ? 'remote' : 'local'
  }
  return remotePoint.rev > localPoint.rev ? 'remote' : 'local'
}

function higherRevWins(localRev: number, remoteRev: number): 'local' | 'remote' {
  return remoteRev > localRev ? 'remote' : 'local'
}

function describeAuto(kind: PendingConflict['kind'], winner: ConflictValue, loser: ConflictValue) {
  if (kind === 'point') {
    return `两端都修改了该关键点，自动保留峰值温度更高的一版（${winner.tempC} ℃ > ${loser.tempC} ℃），败版留待人工确认。`
  }
  if (kind === 'point-delete' || kind === 'sample-delete') {
    return '一端修改、另一端删除，自动保留修改后的一版，删除操作留待人工确认。'
  }
  if (kind === 'offset') {
    return `两端都调整了时间偏移，自动保留修订号更高的一版（r${winner.rev} > r${loser.rev}），另一版待确认。`
  }
  return `两端都写入了该数据，自动保留修订号更高的一版（r${winner.rev} > r${loser.rev}），另一版待确认。`
}

function makeConflict(
  sessionId: string,
  sessionName: string,
  kind: PendingConflict['kind'],
  entityId: string,
  label: string,
  winner: ConflictValue,
  loser: ConflictValue,
): PendingConflict {
  return {
    id: `conflict-${sessionId}-${kind}-${entityId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    sessionName,
    kind,
    entityId,
    label,
    autoRule: describeAuto(kind, winner, loser),
    winner,
    loser,
  }
}

export interface MergedSession {
  merged: BundleSession
  conflicts: PendingConflict[]
  pointAdopted: number
  sampleAdopted: number
  offsetChanged: boolean
  isNewSession: boolean
}

/**
 * 合并单个窑次。
 * @param local 本地窑次（若不存在则为 null，表示修订包里是本地没有的新窑次）
 * @param remote 对端修订包中的窑次
 * @param remoteDevice 对端设备名
 */
export function mergeSession(
  local: KilnSession | null,
  remote: BundleSession,
  remoteDevice: string,
): MergedSession {
  const localMigrated = local ? ensureRevisions(local) : null

  // 本地没有该窑次：整份采纳（新窑次，基线即对端内容）
  if (!localMigrated) {
    const first = freshRemote(remote)
    return {
      merged: first,
      conflicts: [],
      pointAdopted: remote.points.length,
      sampleAdopted: remote.actualSamples.length,
      offsetChanged: false,
      isNewSession: true,
    }
  }

  const sessionName = localMigrated.name
  const basePoints = new Map(localMigrated.syncShadow.points.map((point) => [point.id, point]))
  const baseSamples = new Map(localMigrated.syncShadow.samples.map((sample) => [sample.id, sample]))
  const localPoints = new Map(localMigrated.points.map((point) => [point.id, point]))
  const remotePoints = new Map(remote.points.map((point) => [point.id, point]))
  const localSamples = new Map(localMigrated.actualSamples.map((sample) => [sample.id, sample]))
  const remoteSamples = new Map(remote.actualSamples.map((sample) => [sample.id, sample]))

  const localPointStates = diffStates(localPoints, basePoints)
  const remotePointStates = diffStates(remotePoints, basePoints)
  const localSampleStates = diffStates(localSamples, baseSamples)
  const remoteSampleStates = diffStates(remoteSamples, baseSamples)

  const conflicts: PendingConflict[] = []
  const mergedPoints: FiringPoint[] = []
  let pointAdopted = 0

  const pointIds = new Set([...localPointStates.keys(), ...remotePointStates.keys()])
  for (const id of pointIds) {
    const ls = localPointStates.get(id) ?? 'deleted'
    const rs = remotePointStates.get(id) ?? 'deleted'
    const lp = localPoints.get(id)
    const rp = remotePoints.get(id)

    if (ls === 'unchanged' && rs !== 'unchanged') {
      if (rp) { mergedPoints.push(rp); pointAdopted += 1 }
      continue
    }
    if (rs === 'unchanged' && ls !== 'unchanged') {
      if (lp) mergedPoints.push(lp)
      continue
    }
    if (ls === 'unchanged' && rs === 'unchanged') {
      if (lp) mergedPoints.push(lp)
      else if (rp) mergedPoints.push(rp)
      continue
    }

    if (lp && rp) {
      // 两端都动过：新增-新增 或 修改-修改
      const winnerSide = higherPeakWins(lp, rp)
      const winner = winnerSide === 'remote' ? rp : lp
      const loser = winnerSide === 'remote' ? lp : rp
      mergedPoints.push(winner)
      conflicts.push(
        makeConflict(
          localMigrated.id,
          sessionName,
          'point',
          id,
          pointLabel(winner),
          valueOf(winnerSide, winnerSide === 'remote' ? remoteDevice : DEVICE_OFFICE, winner),
          valueOf(winnerSide === 'remote' ? 'local' : 'remote', winnerSide === 'remote' ? DEVICE_OFFICE : remoteDevice, loser),
        ),
      )
      pointAdopted += 1
      continue
    }

    if (lp && !rp) {
      // 本地改 / 新增，远端删
      if (rs === 'deleted' && ls === 'modified') {
        mergedPoints.push(lp)
        conflicts.push(
          makeConflict(localMigrated.id, sessionName, 'point-delete', id, pointLabel(lp),
            valueOf('local', DEVICE_OFFICE, lp),
            { side: 'remote', device: remoteDevice, rev: basePoints.get(id)?.rev ?? 0, tempC: undefined }),
        )
      } else if (ls === 'added') {
        mergedPoints.push(lp)
      }
      // 本地也没改的纯远端删除：两边一致删除
      continue
    }

    if (!lp && rp) {
      if (ls === 'deleted' && rs === 'modified') {
        mergedPoints.push(rp)
        pointAdopted += 1
        conflicts.push(
          makeConflict(localMigrated.id, sessionName, 'point-delete', id, pointLabel(rp),
            valueOf('remote', remoteDevice, rp),
            { side: 'local', device: DEVICE_OFFICE, rev: basePoints.get(id)?.rev ?? 0 }),
        )
      } else if (rs === 'added') {
        mergedPoints.push(rp)
        pointAdopted += 1
      }
      continue
    }
  }
  mergedPoints.sort((a, b) => a.timeMin - b.timeMin)

  // ---- 实测采样：追加式合并（记录仪 / CSV 只在对应一端产生） ----
  const mergedSamples: FiringSample[] = []
  let sampleAdopted = 0
  const sampleIds = new Set([...localSampleStates.keys(), ...remoteSampleStates.keys()])
  for (const id of sampleIds) {
    const ls = localSampleStates.get(id) ?? 'deleted'
    const rs = remoteSampleStates.get(id) ?? 'deleted'
    const lsm = localSamples.get(id)
    const rsm = remoteSamples.get(id)

    if (lsm && rsm) {
      if (ls === 'unchanged' || rs === 'unchanged' || lsm.rev === rsm.rev) {
        mergedSamples.push(lsm)
        continue
      }
      const winnerSide = higherRevWins(lsm.rev, rsm.rev)
      const winner = winnerSide === 'remote' ? rsm : lsm
      const loser = winnerSide === 'remote' ? lsm : rsm
      mergedSamples.push(winner)
      conflicts.push(
        makeConflict(localMigrated.id, sessionName, 'sample', id, sampleLabel(winner),
          sampleValue(winnerSide, winnerSide === 'remote' ? remoteDevice : DEVICE_OFFICE, winner),
          sampleValue(winnerSide === 'remote' ? 'local' : 'remote', winnerSide === 'remote' ? DEVICE_OFFICE : remoteDevice, loser)),
      )
      sampleAdopted += 1
      continue
    }
    if (lsm && !rsm) {
      // 远端删除：本地改过则保留 + 待确认，否则跟随删除；本地新增则保留
      if (rs === 'deleted' && ls === 'modified') {
        mergedSamples.push(lsm)
        conflicts.push(
          makeConflict(localMigrated.id, sessionName, 'sample-delete', id, sampleLabel(lsm),
            sampleValue('local', DEVICE_OFFICE, lsm),
            { side: 'remote', device: remoteDevice, rev: baseSamples.get(id)?.rev ?? 0 }),
        )
      } else if (ls !== 'unchanged') {
        mergedSamples.push(lsm)
      }
      continue
    }
    if (!lsm && rsm) {
      if (ls === 'deleted' && rs === 'modified') {
        mergedSamples.push(rsm)
        sampleAdopted += 1
        conflicts.push(
          makeConflict(localMigrated.id, sessionName, 'sample-delete', id, sampleLabel(rsm),
            sampleValue('remote', remoteDevice, rsm),
            { side: 'local', device: DEVICE_OFFICE, rev: baseSamples.get(id)?.rev ?? 0 }),
        )
      } else if (rs !== 'unchanged') {
        mergedSamples.push(rsm)
        sampleAdopted += 1
      }
    }
  }
  mergedSamples.sort((a, b) => a.timeMin - b.timeMin)

  // ---- 时间偏移：只比修订号 ----
  let offsetMin = localMigrated.timeOffsetMin
  let timeOffsetRev = localMigrated.timeOffsetRev
  let offsetChanged = false
  const localOffsetChanged = localMigrated.timeOffsetRev > localMigrated.syncShadow.timeOffsetRev
    || localMigrated.timeOffsetMin !== localMigrated.syncShadow.timeOffsetMin
  const remoteOffsetChanged = remote.timeOffsetRev > localMigrated.syncShadow.timeOffsetRev
    || remote.timeOffsetMin !== localMigrated.syncShadow.timeOffsetMin

  if (remoteOffsetChanged && !localOffsetChanged) {
    offsetMin = remote.timeOffsetMin
    timeOffsetRev = remote.timeOffsetRev
    offsetChanged = true
  } else if (remoteOffsetChanged && localOffsetChanged) {
    if (remote.timeOffsetRev > localMigrated.timeOffsetRev) {
      offsetMin = remote.timeOffsetMin
      timeOffsetRev = remote.timeOffsetRev
      offsetChanged = true
      conflicts.push(
        makeConflict(localMigrated.id, sessionName, 'offset', 'time-offset', '时间偏移',
          { side: 'remote', device: remoteDevice, rev: remote.timeOffsetRev, offsetMin: remote.timeOffsetMin },
          { side: 'local', device: DEVICE_OFFICE, rev: localMigrated.timeOffsetRev, offsetMin: localMigrated.timeOffsetMin }),
      )
    } else {
      conflicts.push(
        makeConflict(localMigrated.id, sessionName, 'offset', 'time-offset', '时间偏移',
          { side: 'local', device: DEVICE_OFFICE, rev: localMigrated.timeOffsetRev, offsetMin: localMigrated.timeOffsetMin },
          { side: 'remote', device: remoteDevice, rev: remote.timeOffsetRev, offsetMin: remote.timeOffsetMin }),
      )
    }
  }

  // 曲线整体修订号取两端较高者 +1（合并产生新版本）
  const curveRev = Math.max(localMigrated.curveRev, remote.curveRev) + 1

  // 合并后新基线：采纳后的内容
  const merged: BundleSession = {
    id: localMigrated.id,
    name: localMigrated.name,
    kiln: localMigrated.kiln,
    clay: localMigrated.clay,
    glaze: localMigrated.glaze,
    curveRev,
    timeOffsetMin: offsetMin,
    timeOffsetRev,
    points: mergedPoints,
    actualSamples: mergedSamples,
    shadow: {
      points: JSON.parse(JSON.stringify(mergedPoints)),
      samples: JSON.parse(JSON.stringify(mergedSamples)),
      timeOffsetMin: offsetMin,
      timeOffsetRev,
      mergedAt: nowIso(),
    },
  }

  return { merged, conflicts, pointAdopted, sampleAdopted, offsetChanged, isNewSession: false }
}

function freshRemote(remote: BundleSession): BundleSession {
  return {
    ...remote,
    points: JSON.parse(JSON.stringify(remote.points)),
    actualSamples: JSON.parse(JSON.stringify(remote.actualSamples)),
    shadow: {
      points: JSON.parse(JSON.stringify(remote.points)),
      samples: JSON.parse(JSON.stringify(remote.actualSamples)),
      timeOffsetMin: remote.timeOffsetMin,
      timeOffsetRev: remote.timeOffsetRev,
      mergedAt: nowIso(),
    },
  }
}

export interface AppliedBundle {
  sessions: KilnSession[]
  results: MergedSession[]
  report: MergeReport
}

/**
 * 在本地窑次数组的深拷贝上应用整份修订包。
 * 纯函数：任何一窑次合并抛错都不会改动入参数组，调用方直接放弃返回值即可回滚。
 */
export function applyBundleToSessions(
  localSessions: KilnSession[],
  bundle: RevisionBundle,
): AppliedBundle {
  const working = localSessions.map((session) => JSON.parse(JSON.stringify(session)) as KilnSession)
  const results: MergedSession[] = []
  for (const remoteEntry of bundle.sessions) {
    const local = working.find((session) => session.id === remoteEntry.id) ?? null
    const result = mergeSession(local, remoteEntry, bundle.deviceName)
    results.push(result)

    if (result.isNewSession) {
      const created: KilnSession = {
        id: result.merged.id,
        name: result.merged.name,
        kiln: result.merged.kiln,
        clay: result.merged.clay,
        glaze: result.merged.glaze,
        firedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        status: 'review',
        timeOffsetMin: result.merged.timeOffsetMin,
        timeOffsetRev: result.merged.timeOffsetRev,
        curveRev: result.merged.curveRev,
        points: result.merged.points,
        actualSamples: result.merged.actualSamples,
        syncShadow: result.merged.shadow,
        pendingConflicts: [],
        analysis: {
          curveRev: result.merged.curveRev,
          samplesSig: samplesSignature(result.merged.actualSamples),
          offsetRev: result.merged.timeOffsetRev,
          stale: true,
          calculatedAt: nowIso(),
          issueCount: 0,
        },
      }
      working.unshift(created)
      continue
    }

    const target = working.find((session) => session.id === result.merged.id)!
    target.points = result.merged.points
    target.actualSamples = result.merged.actualSamples
    target.timeOffsetMin = result.merged.timeOffsetMin
    target.timeOffsetRev = result.merged.timeOffsetRev
    target.curveRev = result.merged.curveRev
    target.syncShadow = result.merged.shadow
    target.analysis = {
      curveRev: target.curveRev,
      samplesSig: samplesSignature(target.actualSamples),
      offsetRev: target.timeOffsetRev,
      stale: true,
      calculatedAt: nowIso(),
      issueCount: target.analysis?.issueCount ?? 0,
    }
    const incoming = result.conflicts
    const kept = target.pendingConflicts.filter(
      (existing) => !incoming.some(
        (incomingConflict) =>
          incomingConflict.entityId === existing.entityId && incomingConflict.kind === existing.kind,
      ),
    )
    target.pendingConflicts = [...kept, ...incoming]
  }
  return { sessions: working, results, report: summarizeMerge(bundle, results) }
}

export function summarizeMerge(
  bundle: RevisionBundle,
  results: MergedSession[],
): MergeReport {
  const sessionReports: MergeSessionReport[] = results.map((result, index) => ({
    sessionId: result.merged.id,
    sessionName: result.merged.name || bundle.sessions[index].name,
    isNewSession: result.isNewSession,
    pointAdopted: result.pointAdopted,
    sampleAdopted: result.sampleAdopted,
    offsetChanged: result.offsetChanged,
    conflicts: result.conflicts,
  }))
  const conflictCount = sessionReports.reduce((sum, report) => sum + report.conflicts.length, 0)
  const adoptedCount = sessionReports.reduce(
    (sum, report) => sum + report.pointAdopted + report.sampleAdopted + (report.offsetChanged ? 1 : 0),
    0,
  )
  return {
    at: nowIso(),
    deviceName: bundle.deviceName,
    sessions: sessionReports,
    conflictCount,
    adoptedCount,
  }
}

