export interface FiringPoint {
  id: string
  timeMin: number
  tempC: number
  /** 关键点修订号：每次在任一端被修改后递增，合并按修订号判断是否动过 */
  rev: number
  updatedAt?: string
}

export interface FiringSample {
  id: string
  timeMin: number
  tempC: number
  /** 实测采样修订号：记录仪导入 / 平板补录后递增 */
  rev: number
  updatedAt?: string
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
  points: Array<Pick<FiringPoint, 'timeMin' | 'tempC'>>
  updatedAt: string
}

/**
 * 合并基线（三向合并的公共祖先）。每次合并 / 定稿后刷新为当时内容，
 * 离线两端都从同一份基线分叉，恢复网络后据此判断“哪一边动过”。
 */
export interface SessionShadow {
  points: FiringPoint[]
  samples: FiringSample[]
  timeOffsetMin: number
  timeOffsetRev: number
  mergedAt: string
}

export type ConflictKind = 'point' | 'sample' | 'offset' | 'point-delete' | 'sample-delete'

export interface ConflictValue {
  side: 'local' | 'remote'
  device: string
  rev: number
  /** 关键点 / 采样使用 */
  timeMin?: number
  tempC?: number
  /** 时间偏移使用 */
  offsetMin?: number
  updatedAt?: string
}

export interface PendingConflict {
  id: string
  sessionId: string
  sessionName: string
  kind: ConflictKind
  entityId: string
  /** 例如：关键点 #5（395 min / 1260 ℃）、时间偏移、采样 02:15 */
  label: string
  /** 自动裁决说明，例如“两边都改过，自动保留峰值温度更高的一版 1285 > 1260” */
  autoRule: string
  winner: ConflictValue
  loser: ConflictValue
}

/** 绑在曲线修订号上的派生结论：曲线一变即失效，按新曲线重算 */
export interface SessionAnalysis {
  curveRev: number
  samplesSig: string
  offsetRev: number
  stale: boolean
  calculatedAt: string
  issueCount: number
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
  /** 时间偏移修订号 */
  timeOffsetRev: number
  /** 曲线整体修订号：关键点增 / 删 / 改后递增，阶段划分与派生结论绑定此号 */
  curveRev: number
  points: FiringPoint[]
  actualSamples: FiringSample[]
  /** 最近一次合并 / 定稿的公共基线 */
  syncShadow: SessionShadow
  /** 自动裁决后留下的待确认项（败版） */
  pendingConflicts: PendingConflict[]
  analysis: SessionAnalysis
}

/** 离线端（窑边平板）导出 / 保存的修订包 */
export interface RevisionBundle {
  schema: 'kiln-firing-revision-bundle/v2'
  deviceName: string
  exportedAt: string
  sessions: BundleSession[]
}

export interface BundleSession {
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  curveRev: number
  timeOffsetMin: number
  timeOffsetRev: number
  points: FiringPoint[]
  actualSamples: FiringSample[]
  shadow: SessionShadow
}

export interface MergeSessionReport {
  sessionId: string
  sessionName: string
  isNewSession: boolean
  pointAdopted: number
  sampleAdopted: number
  offsetChanged: boolean
  conflicts: PendingConflict[]
}

export interface MergeReport {
  at: string
  deviceName: string
  sessions: MergeSessionReport[]
  conflictCount: number
  adoptedCount: number
}

export interface FailedImportDraft {
  id: string
  kind: 'bundle' | 'csv'
  filename: string
  /** 留存的原始载荷，重试时不需要用户重新选择文件 */
  payload: string
  sessionId?: string
  sessionName?: string
  error: string
  createdAt: string
}

export interface RiskIssue {
  id: string
  stageIndex: number
  severity: 'error' | 'warning'
  title: string
  message: string
  metric: string
}

/** 旧窑次：关键点 / 采样 / 偏移都没有修订号，打开时由 ensureRevisions 补齐 */
export type LegacyFiringPoint = Omit<FiringPoint, 'rev' | 'updatedAt'> & { rev?: number }
export type LegacyFiringSample = Omit<FiringSample, 'rev' | 'updatedAt'> & { rev?: number }
export interface LegacyKilnSession extends Omit<KilnSession, 'points' | 'actualSamples' | 'curveRev' | 'timeOffsetRev' | 'syncShadow' | 'pendingConflicts' | 'analysis'> {
  points: LegacyFiringPoint[]
  actualSamples: LegacyFiringSample[]
  curveRev?: number
  timeOffsetRev?: number
  syncShadow?: SessionShadow
  pendingConflicts?: PendingConflict[]
  analysis?: KilnSession['analysis']
}

export interface DeviationSummary {
  sampleCount: number
  meanAbs: number
  maxAbs: number
  maxAtMin: number
  maxTarget: number
  maxActual: number
}
