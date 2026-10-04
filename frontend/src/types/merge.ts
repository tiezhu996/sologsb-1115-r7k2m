import type { CollectSite, Determination, Specimen, Storage } from './index'

/** 参与合并的四张表 */
export type TableName = 'sites' | 'specimens' | 'determinations' | 'storages'

/** 任意一张表的业务记录 */
export type AnyRow = CollectSite | Specimen | Determination | Storage

/** 一条可执行的合并操作（insert 带整行，update 带字段补丁） */
export interface MergeOp {
  table: TableName
  action: 'insert' | 'update'
  /** 馆内记录 id（insert 时为即将写入的 id） */
  id: string
  /** 展示用标签，如「标本 QLB-2026-0007」 */
  label: string
  row?: AnyRow
  patch?: Record<string, unknown>
}

/** 同一字段的两份值：馆内 vs 交接包，需人工选边 */
export interface FieldConflict {
  /** 稳定键：表:记录id:字段 */
  key: string
  table: TableName
  id: string
  label: string
  field: string
  localValue: unknown
  incomingValue: unknown
  /** 已作出的选择；未选择时为 undefined（未解决） */
  resolved?: 'local' | 'incoming'
}

/** 合并计划：可执行操作 + 冲突对照 + 暂缓说明 */
export interface MergePlan {
  ops: MergeOp[]
  conflicts: FieldConflict[]
  /** 未解决冲突数 */
  pendingCount: number
  /** 因冲突暂缓入柜的标本数 */
  blockedCount: number
  /** 自动跳过 / 暂缓的说明（柜位被占、冲突暂缓等） */
  notes: string[]
  stats: { inserts: number; updates: number }
}

/** 合并批次：持久化到 IndexedDB，写库失败后可从断点恢复重试 */
export interface MergeJob {
  jobId: string
  packageName: string
  createdAt: string
  status: 'applying' | 'done' | 'failed'
  ops: MergeOp[]
  /** 已应用的操作数（ops 前 applied 条），恢复时从这里继续 */
  applied: number
  inserted: number
  updated: number
  /** 重试时撞见的已存在记录（幂等跳过） */
  duplicates: number
  /** 柜位被占而跳过的保藏位置数 */
  slotSkipped: number
  notes: string[]
  error?: string
  finishedAt?: string
}
