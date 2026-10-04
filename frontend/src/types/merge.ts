import type { CollectSite, Determination, Specimen, Storage } from '@/types'

/** 离线交接包格式标识 */
export const HANDOFF_FORMAT = 'gbinsectlog-handoff/v1'

/** 采集地坐标认同阈值（米），与站点页「50 米内同一采集地」一致 */
export const SITE_MATCH_RADIUS = 50

/** 歧义采集地人工认定为「新建」时的取值 */
export const NEW_SITE = '__new__'

/** 一份台账快照：全量备份 / 交接包基线 / 合并时的本馆现状都用它 */
export interface Snapshot {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
}

/** 野外队回馆交接包：四类记录 + 出队时馆内台账基线（可为空，如旧备份） */
export interface BundleData extends Snapshot {
  format: string
  exportedAt: string
  origin: string
  baseline: Snapshot | null
}

export type EntityKind = 'site' | 'specimen' | 'determination' | 'storage'

export type MergeAction = 'insert' | 'update' | 'unchanged' | 'skip'

export interface FieldDef {
  key: string
  label: string
}

/** 同一字段两份值的来源对照 */
export interface FieldConflict {
  field: string
  label: string
  /** 本馆现值 */
  local: unknown
  /** 交接包值（野外） */
  remote: unknown
  /** 出队基线值，无基线时为 null */
  base: unknown
  /** null=尚未处理（保持本馆值），local=保持本馆，remote=采用野外 */
  resolution: 'local' | 'remote' | null
}

export interface MergeIssue {
  level: 'info' | 'warning'
  text: string
}

/** 单条入包记录的合并计划 */
export interface EntityPlan {
  kind: EntityKind
  /** 交接包内的原行 id */
  incomingId: string
  /** 认定到的本馆行 id（新增时为 null） */
  localId: string | null
  /** 最终写库用的 id（新增走确定性 id，保证重试幂等） */
  finalId: string
  /** 主标题：采集地代码 / 标本编号 / 柜位 */
  label: string
  sublabel: string
  /** new=包内新增，matched=认到本馆同一记录，ambiguous=匹配到多处待人工认定 */
  match: 'new' | 'matched' | 'ambiguous'
  /** 歧义时可选的本馆记录 id 列表 */
  candidates: string[]
  /** 是否能在基线中找到对应行 */
  baseExists: boolean
  /** 实际动作：insert/update/unchanged/skip（blocked 时为 skip） */
  action: MergeAction
  /** 写库行（action 为 skip 时为 null） */
  values: Record<string, unknown> | null
  conflicts: FieldConflict[]
  /** 阻断原因，如「采集地尚未认定」「柜位已被占用」 */
  blockedReasons: string[]
  /** 不阻断的提示，如「基线中存在但本馆已删除，按新增重建」 */
  infos: string[]
}

export interface MergeSummary {
  inserts: number
  updates: number
  unchanged: number
  skips: number
  unresolved: number
}

export interface MergePlan {
  sites: EntityPlan[]
  specimens: EntityPlan[]
  determinations: EntityPlan[]
  storages: EntityPlan[]
  issues: MergeIssue[]
  summary: MergeSummary
}

/** 人工处理结果：字段双值选择 + 歧义采集地认定，按稳定 key 持久化进任务 */
export interface MergeResolutions {
  /** key: `${kind}:${incomingId}:${field}` → local / remote */
  fields: Record<string, 'local' | 'remote'>
  /** key: 交接包采集地 id → 选定的本馆采集地 id 或 NEW_SITE */
  siteMatch: Record<string, string>
}

export interface MergeReport {
  appliedAt: string
  inserted: number
  updated: number
  skipped: number
  remainingConflicts: number
}

export type MergeJobStatus = 'open' | 'applied' | 'failed'

/** 持久化的合并任务：写库失败/刷新页面后可原样恢复重试 */
export interface MergeJob {
  id: string
  createdAt: string
  updatedAt: string
  status: MergeJobStatus
  /** 来源文件名 */
  filename: string
  origin: string
  exportedAt: string
  bundle: BundleData
  resolutions: MergeResolutions
  lastError: string | null
  appliedAt: string | null
  lastReport: MergeReport | null
}

/** 出队基线（最新一份全量备份），导出交接包时内嵌 */
export interface BaselineRow {
  key: 'latest'
  importedAt: string
  exportedAt: string
  origin: string
  snapshot: Snapshot
}

export const EMPTY_SNAPSHOT = (): Snapshot => ({ sites: [], specimens: [], determinations: [], storages: [] })

export const EMPTY_RESOLUTIONS = (): MergeResolutions => ({ fields: {}, siteMatch: {} })

/** 参与三方比对的字段及中文名（id / 编号 / 外键不在此列，单独处理） */
export const SITE_FIELDS: FieldDef[] = [
  { key: 'name', label: '名称' },
  { key: 'region', label: '行政区' },
  { key: 'longitude', label: '经度' },
  { key: 'latitude', label: '纬度' },
  { key: 'altitude', label: '海拔' },
  { key: 'habitat', label: '生境类型' },
  { key: 'microHabitat', label: '小生境' },
  { key: 'microClimate', label: '微气候' },
  { key: 'dateStart', label: '采集日期起' },
  { key: 'dateEnd', label: '采集日期止' }
]

export const SPECIMEN_FIELDS: FieldDef[] = [
  { key: 'order', label: '目' },
  { key: 'family', label: '科' },
  { key: 'genus', label: '属' },
  { key: 'species', label: '种' },
  { key: 'tempName', label: '暂定名' },
  { key: 'collectDate', label: '采集日期' },
  { key: 'collector', label: '采集人' },
  { key: 'sex', label: '性别' },
  { key: 'stage', label: '虫态' },
  { key: 'bodyLength', label: '体长(mm)' },
  { key: 'method', label: '采集方式' },
  { key: 'quantity', label: '数量' },
  { key: 'status', label: '鉴定状态' },
  { key: 'determiner', label: '鉴定人' },
  { key: 'note', label: '备注' }
]

export const DETERMINATION_FIELDS: FieldDef[] = [
  { key: 'determiner', label: '鉴定人' },
  { key: 'date', label: '鉴定日期' },
  { key: 'conclusion', label: '鉴定结论' },
  { key: 'reference', label: '依据文献' },
  { key: 'confidence', label: '置信度' },
  { key: 'needReview', label: '需复核' }
]

export const STORAGE_FIELDS: FieldDef[] = [
  { key: 'method', label: '保藏方式' },
  { key: 'cabinet', label: '柜' },
  { key: 'drawer', label: '抽屉' },
  { key: 'box', label: '盒' },
  { key: 'slot', label: '插位' },
  { key: 'storedDate', label: '入柜日期' },
  { key: 'handler', label: '经手人' }
]

export const ENTITY_LABEL: Record<EntityKind, string> = {
  site: '采集地',
  specimen: '标本',
  determination: '鉴定记录',
  storage: '保藏位置'
}

/** 字段值展示：空值/布尔统一转中文 */
export function formatConflictValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
