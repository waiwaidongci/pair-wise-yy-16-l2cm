export interface FiringPoint {
  id: string
  timeMin: number
  tempC: number
  /** 该关键点最后一次被修改时的窑次修订号 */
  rev: number
}

export interface FiringSample {
  id: string
  timeMin: number
  tempC: number
  /** 该实测采样最后一次被修改时的窑次修订号 */
  rev: number
}

export type StageType = 'heat' | 'hold' | 'cool'

export interface FiringStage {
  id: string
  index: number
  type: StageType
  start: FiringPoint
  end: FiringPoint
  durationMin: number
  deltaTemp: number
  ratePerMin: number
}

export interface CurveTemplate {
  id: string
  name: string
  clay: string
  glaze: string
  peakTempC: number
  description: string
  points: Array<Omit<FiringPoint, 'id' | 'rev'>>
  updatedAt: string
}

export type ConflictEntityType = 'point' | 'sample' | 'offset' | 'meta'

/** 合并中双方都改过同一实体时的待确认项 */
export interface PendingConflict {
  id: string
  entityType: ConflictEntityType
  entityId: string
  /** 用于界面展示的实体描述 */
  label: string
  localValue: string
  remoteValue: string
  /** 用于采纳对方版本时直接应用的结构化原值；null 表示对方已删除 */
  localRaw: unknown
  remoteRaw: unknown
  localPeakTemp: number | null
  remotePeakTemp: number | null
  winner: 'local' | 'remote'
  reason: string
}

/** 上一次同步（合并）完成时的窑次快照，作为三方合并的基线 */
export interface SessionSnapshot {
  rev: number
  baseRev: number
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: KilnSession['status']
  timeOffsetMin: number
  timeOffsetRev: number
  points: FiringPoint[]
  actualSamples: FiringSample[]
}

export interface KilnSession {
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: 'draft' | 'completed' | 'review'
  timeOffsetMin: number
  /** 时间偏移最后一次被修改时的窑次修订号 */
  timeOffsetRev: number
  points: FiringPoint[]
  actualSamples: FiringSample[]
  /** 窑次头修订号，任何修改都会递增 */
  rev: number
  /** 上一次同步时的头修订号 */
  baseRev: number
  /** 三方合并基线快照 */
  baseSnapshot: SessionSnapshot
  /** 合并后留待人工确认的冲突项 */
  pendingConflicts: PendingConflict[]
}

export interface RiskIssue {
  id: string
  stageIndex: number
  severity: 'error' | 'warning'
  title: string
  message: string
  metric: string
}

export interface DeviationSummary {
  sampleCount: number
  meanAbs: number
  maxAbs: number
  maxAtMin: number
  maxTarget: number
  maxActual: number
}
