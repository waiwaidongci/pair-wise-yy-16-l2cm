import type { KilnSession, RevisionBundle } from '../types/firing'
import { buildBundle, DEVICE_TABLET, ensureRevisions, nextRev, nowIso } from './revision'

/**
 * 模拟窑边平板离线工作：平板在网络断开期间基于当前内容分叉，
 *  - 修改一个关键点（与办公室即将做的修改撞车，用于演示峰值温度裁决）
 *  - 补录一批新的实测采样
 *  - 调整时间偏移
 * 修订号逐项 +1，但不动 syncShadow（基线仍是分叉前的内容）。
 */
export function simulateTabletOffline(sessions: KilnSession[], sessionId: string): RevisionBundle {
  const forked = sessions.map(ensureRevisions).map((session) => JSON.parse(JSON.stringify(session)) as KilnSession)
  const target = forked.find((session) => session.id === sessionId) ?? forked[0]

  const sorted = [...target.points].sort((a, b) => a.timeMin - b.timeMin)
  const peakIndex = sorted.reduce((best, point, index) => (point.tempC > sorted[best].tempC ? index : best), 0)
  const peak = sorted[peakIndex]
  // 平板把峰值关键点降低 35 ℃（配方师在办公室会升高，制造“两边都改同一关键点”）
  peak.tempC = Math.max(100, peak.tempC - 35)
  peak.rev = nextRev(peak.rev)
  peak.updatedAt = nowIso()

  // 补录实测：接续最后一个采样点
  const lastTime = target.actualSamples.length
    ? Math.max(...target.actualSamples.map((sample) => sample.timeMin))
    : 0
  const maxRev = Math.max(0, ...target.actualSamples.map((sample) => sample.rev))
  for (let step = 1; step <= 4; step += 1) {
    const timeMin = lastTime + step * 5
    target.actualSamples.push({
      id: `tablet-offline-${timeMin}-${Math.random().toString(36).slice(2, 6)}`,
      timeMin,
      tempC: Math.max(40, peak.tempC - 18 - step * 6),
      rev: maxRev + step,
      updatedAt: nowIso(),
    })
  }

  // 平板把时间偏移向反方向调整
  target.timeOffsetMin = Number((target.timeOffsetMin - 2.5).toFixed(1))
  target.timeOffsetRev = nextRev(target.timeOffsetRev)

  // 平板端曲线修订号同样推进（合并时取 max+1）
  target.curveRev = nextRev(target.curveRev)

  return buildBundle(forked, DEVICE_TABLET)
}

/**
 * 模拟办公室配方师离线修改目标曲线：把峰值关键点升高 25 ℃，
 * 与平板上降低峰值的修改在同一关键点冲突。
 */
export function applyOfficeOfflineEdit(session: KilnSession) {
  const sorted = [...session.points].sort((a, b) => a.timeMin - b.timeMin)
  const peak = sorted.reduce((best, point) => (point.tempC > best.tempC ? point : best), sorted[0])
  peak.tempC = Math.min(1450, peak.tempC + 25)
  peak.rev = nextRev(peak.rev)
  peak.updatedAt = nowIso()
  session.curveRev = nextRev(session.curveRev)
  session.analysis = { ...session.analysis, stale: true }
}
