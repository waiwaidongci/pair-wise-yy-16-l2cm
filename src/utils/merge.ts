import type {
  FiringPoint,
  FiringSample,
  KilnSession,
  PendingConflict,
  SessionSnapshot,
} from '../types/firing'
import { cloneSession } from './curve'

export const SESSION_SCHEMA = 'kiln-firing-curve/v1'

export interface SessionExportFile {
  schema: string
  exportedAt: string
  session: KilnSession
}

export interface MergeStats {
  adoptedLocal: number
  adoptedRemote: number
  autoMerged: number
  newConflicts: number
}

export interface MergeOutcome {
  ok: boolean
  error?: string
  session?: KilnSession
  conflicts?: PendingConflict[]
  stats?: MergeStats
}

/** 截取窑次当前内容作为合并基线快照 */
export function snapshotSession(session: KilnSession): SessionSnapshot {
  return {
    rev: session.rev,
    baseRev: session.baseRev,
    name: session.name,
    kiln: session.kiln,
    clay: session.clay,
    glaze: session.glaze,
    firedAt: session.firedAt,
    status: session.status,
    timeOffsetMin: session.timeOffsetMin,
    timeOffsetRev: session.timeOffsetRev,
    points: session.points.map((point) => ({ ...point })),
    actualSamples: session.actualSamples.map((sample) => ({ ...sample })),
  }
}

export function peakTempOf(points: FiringPoint[]): number {
  return points.length ? Math.max(...points.map((point) => point.tempC)) : 0
}

/**
 * 旧窑次没有修订号：打开时先按现有内容补齐修订号与基线快照，
 * 补齐后的 rev 从 1 起算，基线即当前内容，随后即可参与合并。
 */
export function migrateSession(session: KilnSession): KilnSession {
  if (
    typeof session.rev === 'number' &&
    session.baseSnapshot &&
    Array.isArray(session.pendingConflicts)
  ) {
    return session
  }
  const rev = typeof session.rev === 'number' ? session.rev : 1
  const points = session.points.map((point) => ({
    ...point,
    rev: typeof point.rev === 'number' ? point.rev : 1,
  }))
  const actualSamples = session.actualSamples.map((sample) => ({
    ...sample,
    rev: typeof sample.rev === 'number' ? sample.rev : 1,
  }))
  const migrated: KilnSession = {
    ...session,
    points,
    actualSamples,
    timeOffsetRev: typeof session.timeOffsetRev === 'number' ? session.timeOffsetRev : 1,
    rev,
    baseRev: rev,
    pendingConflicts: Array.isArray(session.pendingConflicts) ? session.pendingConflicts : [],
  }
  migrated.baseSnapshot = snapshotSession(migrated)
  return migrated
}

function pointChanged(base: FiringPoint | undefined, value: FiringPoint | undefined): boolean {
  if (!value) return false
  if (!base) return true
  return base.timeMin !== value.timeMin || base.tempC !== value.tempC
}

function sampleChanged(base: FiringSample | undefined, value: FiringSample | undefined): boolean {
  if (!value) return false
  if (!base) return true
  return base.timeMin !== value.timeMin || base.tempC !== value.tempC
}

function pointLabel(point: FiringPoint): string {
  return `关键点 ${Math.round(point.timeMin)} min / ${Math.round(point.tempC)} ℃`
}

function sampleLabel(sample: FiringSample): string {
  return `实测 ${Math.round(sample.timeMin)} min / ${Math.round(sample.tempC)} ℃`
}

function makeConflict(
  entityType: PendingConflict['entityType'],
  entityId: string,
  label: string,
  localValue: string,
  remoteValue: string,
  localRaw: unknown,
  remoteRaw: unknown,
  localPeak: number | null,
  remotePeak: number | null,
  winner: 'local' | 'remote',
  reason: string,
): PendingConflict {
  return {
    id: `conflict-${crypto.randomUUID()}`,
    entityType,
    entityId,
    label,
    localValue,
    remoteValue,
    localRaw,
    remoteRaw,
    localPeakTemp: localPeak,
    remotePeakTemp: remotePeak,
    winner,
    reason,
  }
}

/**
 * 按修订号做三方合并（base 为本地保存的上次同步快照）：
 * - 只有一边相对基线改过：直接采纳该边；
 * - 两边都改过同一个关键点：保留峰值温度更高的一版，另一版留作待确认；
 * - 两边都改过同一采样 / 偏移 / 元信息：保留本地，对方版本留作待确认；
 * - 一边删除、另一边修改：保留修改后的版本，删除动作留作待确认。
 */
export function mergeSessions(local: KilnSession, remote: KilnSession): MergeOutcome {
  try {
    const base = local.baseSnapshot ?? snapshotSession(local)
    const merged: KilnSession = {
      ...cloneSession(local),
      points: [],
      actualSamples: [],
      pendingConflicts: [...local.pendingConflicts],
    }
    const newConflicts: PendingConflict[] = []
    const stats: MergeStats = { adoptedLocal: 0, adoptedRemote: 0, autoMerged: 0, newConflicts: 0 }
    const localPeak = peakTempOf(local.points)
    const remotePeak = peakTempOf(remote.points)

    const basePoints = new Map(base.points.map((point) => [point.id, point]))
    const localPoints = new Map(local.points.map((point) => [point.id, point]))
    const remotePoints = new Map(remote.points.map((point) => [point.id, point]))

    for (const id of new Set([...basePoints.keys(), ...localPoints.keys(), ...remotePoints.keys()])) {
      const bp = basePoints.get(id)
      const lp = localPoints.get(id)
      const rp = remotePoints.get(id)
      const lChanged = pointChanged(bp, lp)
      const rChanged = pointChanged(bp, rp)

      if (lp && rp) {
        if (!bp) {
          // 两边都新增了同一 id 的关键点
          if (lp.timeMin === rp.timeMin && lp.tempC === rp.tempC) {
            merged.points.push({ ...lp })
            stats.autoMerged += 1
          } else {
            const winner: 'local' | 'remote' = localPeak >= remotePeak ? 'local' : 'remote'
            const adopted = winner === 'local' ? lp : rp
            merged.points.push({ ...adopted })
            stats.newConflicts += 1
            newConflicts.push(
              makeConflict(
                'point',
                id,
                pointLabel(adopted),
                `${lp.timeMin} min · ${lp.tempC} ℃`,
                `${rp.timeMin} min · ${rp.tempC} ℃`,
                { timeMin: lp.timeMin, tempC: lp.tempC },
                { timeMin: rp.timeMin, tempC: rp.tempC },
                localPeak,
                remotePeak,
                winner,
                `双方各自新增了同一关键点但内容不一致；本地峰值 ${localPeak} ℃${winner === 'local' ? ' ≥ ' : ' < '}对方峰值 ${remotePeak} ℃，已保留${winner === 'local' ? '本地' : '对方'}版本，另一版留待确认。`,
              ),
            )
          }
        } else if (lChanged && rChanged) {
          // 两边都改过同一个关键点：峰值温度更高的一版胜出
          const winner: 'local' | 'remote' = localPeak >= remotePeak ? 'local' : 'remote'
          const adopted = winner === 'local' ? lp : rp
          merged.points.push({ ...adopted })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'point',
              id,
              pointLabel(adopted),
              `${lp.timeMin} min · ${lp.tempC} ℃`,
              `${rp.timeMin} min · ${rp.tempC} ℃`,
              { timeMin: lp.timeMin, tempC: lp.tempC },
              { timeMin: rp.timeMin, tempC: rp.tempC },
              localPeak,
              remotePeak,
              winner,
              `双方都修改了关键点；本地峰值 ${localPeak} ℃${winner === 'local' ? ' ≥ ' : ' < '}对方峰值 ${remotePeak} ℃，已保留${winner === 'local' ? '本地' : '对方'}版本，另一版留待确认。`,
            ),
          )
        } else if (lChanged) {
          merged.points.push({ ...lp })
          stats.adoptedLocal += 1
        } else if (rChanged) {
          merged.points.push({ ...rp })
          stats.adoptedRemote += 1
        } else {
          merged.points.push({ ...lp })
          stats.autoMerged += 1
        }
      } else if (lp && !rp) {
        if (!bp) {
          merged.points.push({ ...lp })
          stats.adoptedLocal += 1
        } else if (lChanged) {
          // 对方删除了该点，但本地改过：保留本地修改，留待确认
          merged.points.push({ ...lp })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'point',
              id,
              pointLabel(lp),
              `${lp.timeMin} min · ${lp.tempC} ℃`,
              '（对方已删除）',
              { timeMin: lp.timeMin, tempC: lp.tempC },
              null,
              null,
              null,
              'local',
              '对方删除了该关键点，而本地有修改；已保留本地版本，删除动作留待确认。',
            ),
          )
        }
        // 对方删除且本地未改：接受删除
      } else if (!lp && rp) {
        if (!bp) {
          merged.points.push({ ...rp })
          stats.adoptedRemote += 1
        } else if (rChanged) {
          // 本地删除了该点，但对方改过：保留对方修改，留待确认
          merged.points.push({ ...rp })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'point',
              id,
              pointLabel(rp),
              '（本地已删除）',
              `${rp.timeMin} min · ${rp.tempC} ℃`,
              null,
              { timeMin: rp.timeMin, tempC: rp.tempC },
              null,
              null,
              'remote',
              '本地删除了该关键点，而对方有修改；已保留对方版本，删除动作留待确认。',
            ),
          )
        }
        // 本地删除且对方未改：接受删除
      }
    }

    const baseSamples = new Map(base.actualSamples.map((sample) => [sample.id, sample]))
    const localSamples = new Map(local.actualSamples.map((sample) => [sample.id, sample]))
    const remoteSamples = new Map(remote.actualSamples.map((sample) => [sample.id, sample]))

    for (const id of new Set([...baseSamples.keys(), ...localSamples.keys(), ...remoteSamples.keys()])) {
      const bs = baseSamples.get(id)
      const ls = localSamples.get(id)
      const rs = remoteSamples.get(id)
      const lChanged = sampleChanged(bs, ls)
      const rChanged = sampleChanged(bs, rs)

      if (ls && rs) {
        if (!bs) {
          if (ls.timeMin === rs.timeMin && ls.tempC === rs.tempC) {
            merged.actualSamples.push({ ...ls })
            stats.autoMerged += 1
          } else {
            merged.actualSamples.push({ ...ls })
            stats.newConflicts += 1
            newConflicts.push(
              makeConflict(
                'sample',
                id,
                sampleLabel(ls),
                `${ls.timeMin} min · ${ls.tempC} ℃`,
                `${rs.timeMin} min · ${rs.tempC} ℃`,
                { timeMin: ls.timeMin, tempC: ls.tempC },
                { timeMin: rs.timeMin, tempC: rs.tempC },
                null,
                null,
                'local',
                '双方各自新增了同一实测采样但内容不一致；已保留本地版本，对方版本留待确认。',
              ),
            )
          }
        } else if (lChanged && rChanged) {
          merged.actualSamples.push({ ...ls })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'sample',
              id,
              sampleLabel(ls),
              `${ls.timeMin} min · ${ls.tempC} ℃`,
              `${rs.timeMin} min · ${rs.tempC} ℃`,
              { timeMin: ls.timeMin, tempC: ls.tempC },
              { timeMin: rs.timeMin, tempC: rs.tempC },
              null,
              null,
              'local',
              '双方都修改了同一实测采样；已保留本地版本，对方版本留待确认。',
            ),
          )
        } else if (lChanged) {
          merged.actualSamples.push({ ...ls })
          stats.adoptedLocal += 1
        } else if (rChanged) {
          merged.actualSamples.push({ ...rs })
          stats.adoptedRemote += 1
        } else {
          merged.actualSamples.push({ ...ls })
          stats.autoMerged += 1
        }
      } else if (ls && !rs) {
        if (!bs) {
          merged.actualSamples.push({ ...ls })
          stats.adoptedLocal += 1
        } else if (lChanged) {
          merged.actualSamples.push({ ...ls })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'sample',
              id,
              sampleLabel(ls),
              `${ls.timeMin} min · ${ls.tempC} ℃`,
              '（对方已删除）',
              { timeMin: ls.timeMin, tempC: ls.tempC },
              null,
              null,
              null,
              'local',
              '对方删除了该实测采样，而本地有修改；已保留本地版本，删除动作留待确认。',
            ),
          )
        }
      } else if (!ls && rs) {
        if (!bs) {
          merged.actualSamples.push({ ...rs })
          stats.adoptedRemote += 1
        } else if (rChanged) {
          merged.actualSamples.push({ ...rs })
          stats.newConflicts += 1
          newConflicts.push(
            makeConflict(
              'sample',
              id,
              sampleLabel(rs),
              '（本地已删除）',
              `${rs.timeMin} min · ${rs.tempC} ℃`,
              null,
              { timeMin: rs.timeMin, tempC: rs.tempC },
              null,
              null,
              'remote',
              '本地删除了该实测采样，而对方有修改；已保留对方版本，删除动作留待确认。',
            ),
          )
        }
      }
    }

    // 时间偏移：只采纳一边的修改，两边都改则留本地待确认
    const offsetLocalChanged = local.timeOffsetMin !== base.timeOffsetMin
    const offsetRemoteChanged = remote.timeOffsetMin !== base.timeOffsetMin
    if (offsetLocalChanged && offsetRemoteChanged) {
      merged.timeOffsetMin = local.timeOffsetMin
      merged.timeOffsetRev = local.timeOffsetRev
      stats.newConflicts += 1
      newConflicts.push(
        makeConflict(
          'offset',
          'timeOffset',
          '时间偏移',
          `${local.timeOffsetMin} min`,
          `${remote.timeOffsetMin} min`,
          local.timeOffsetMin,
          remote.timeOffsetMin,
          null,
          null,
          'local',
          '双方都修改了时间偏移；已保留本地版本，对方版本留待确认。',
        ),
      )
    } else if (offsetRemoteChanged) {
      merged.timeOffsetMin = remote.timeOffsetMin
      merged.timeOffsetRev = remote.timeOffsetRev
      stats.adoptedRemote += 1
    } else {
      merged.timeOffsetMin = local.timeOffsetMin
      merged.timeOffsetRev = local.timeOffsetRev
      if (offsetLocalChanged) stats.adoptedLocal += 1
    }

    // 元信息：只采纳一边的修改，两边都改则留本地待确认
    const metaFields = ['name', 'kiln', 'clay', 'glaze', 'firedAt', 'status'] as const
    for (const field of metaFields) {
      const lv = local[field]
      const rv = remote[field]
      const bv = base[field]
      const lChanged = lv !== bv
      const rChanged = rv !== bv
      if (lChanged && rChanged && lv !== rv) {
        ;(merged as unknown as Record<string, unknown>)[field] = lv
        stats.newConflicts += 1
        newConflicts.push(
          makeConflict(
            'meta',
            field,
            `窑次信息 · ${field}`,
            String(lv),
            String(rv),
            lv,
            rv,
            null,
            null,
            'local',
            `双方都修改了窑次信息 ${field}；已保留本地版本，对方版本留待确认。`,
          ),
        )
      } else if (rChanged && !lChanged) {
        ;(merged as unknown as Record<string, unknown>)[field] = rv
        stats.adoptedRemote += 1
      } else {
        ;(merged as unknown as Record<string, unknown>)[field] = lv
        if (lChanged) stats.adoptedLocal += 1
      }
    }

    merged.rev = Math.max(local.rev, remote.rev) + 1
    merged.baseRev = merged.rev
    merged.baseSnapshot = snapshotSession(merged)
    merged.pendingConflicts = [...local.pendingConflicts, ...newConflicts]

    return { ok: true, session: merged, conflicts: newConflicts, stats }
  } catch (error) {
    return {
      ok: false,
      error: `合并过程出错：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

/**
 * 模拟对方（离线平板）从同一基线分叉后的修改：
 * 基于本地保存的上次同步快照，施加若干离线改动，返回对方窑次副本。
 */
export function forkRemoteSession(session: KilnSession): KilnSession {
  const base = session.baseSnapshot ?? snapshotSession(session)
  const fork: KilnSession = {
    ...cloneSession(session),
    rev: base.rev + 1,
    baseRev: base.rev + 1,
    timeOffsetMin: base.timeOffsetMin,
    timeOffsetRev: base.timeOffsetRev,
    points: base.points.map((point) => ({ ...point })),
    actualSamples: base.actualSamples.map((sample) => ({ ...sample })),
    pendingConflicts: [],
  }
  const bump = fork.rev

  // 对方抬高了峰值点温度
  const peak = [...fork.points].sort((a, b) => b.tempC - a.tempC)[0]
  if (peak) {
    peak.tempC = Math.min(1450, peak.tempC + 18)
    peak.rev = bump
  }
  // 对方移动了一个中间关键点的到达时间
  const movable = fork.points.find(
    (point) => point.id !== peak?.id && point.timeMin > 60 && point.timeMin < 600,
  )
  if (movable) {
    const nextPoint = [...fork.points]
      .sort((a, b) => a.timeMin - b.timeMin)
      .find((point) => point.timeMin > movable.timeMin)
    movable.timeMin = Math.min(nextPoint ? nextPoint.timeMin - 1 : movable.timeMin + 12, movable.timeMin + 12)
    movable.rev = bump
  }
  // 对方补录了一个实测采样
  if (fork.actualSamples.length) {
    const sample = fork.actualSamples[Math.floor(fork.actualSamples.length / 2)]
    sample.tempC = Math.round(sample.tempC + 25)
    sample.rev = bump
  }
  // 对方调整了时间偏移
  fork.timeOffsetMin = Number((fork.timeOffsetMin + 2.5).toFixed(1))
  fork.timeOffsetRev = bump

  fork.baseSnapshot = snapshotSession(fork)
  return fork
}

/** 解析导入的窑次 JSON 文件，校验结构与窑次一致性 */
export function parseSessionImport(
  text: string,
  currentSessionId: string,
): { ok: true; session: KilnSession } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请确认导出文件未损坏。' }
  }
  const file = parsed as Partial<SessionExportFile> | null
  if (!file || typeof file !== 'object') {
    return { ok: false, error: '文件内容无法识别。' }
  }
  if (file.schema !== SESSION_SCHEMA) {
    return { ok: false, error: `文件版本不兼容（schema=${String(file.schema)}），无法合并。` }
  }
  if (!file.session || typeof file.session !== 'object') {
    return { ok: false, error: '文件中缺少窑次数据（session 字段）。' }
  }
  const raw = file.session as KilnSession
  if (raw.id !== currentSessionId) {
    return {
      ok: false,
      error: `该文件属于窑次「${raw.name ?? raw.id}」，与当前窑次不一致，已阻止合并。`,
    }
  }
  if (!Array.isArray(raw.points) || !Array.isArray(raw.actualSamples)) {
    return { ok: false, error: '窑次数据缺少关键点或实测采样数组。' }
  }
  return { ok: true, session: migrateSession(raw) }
}

export function downloadSessionJson(session: KilnSession) {
  const payload: SessionExportFile = {
    schema: SESSION_SCHEMA,
    exportedAt: new Date().toISOString(),
    session,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${session.name}-离线副本.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
