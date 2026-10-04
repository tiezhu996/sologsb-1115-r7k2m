import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import type { TableName } from '@/types/merge'
import { db, loadAll } from '@/hooks/usePersistentStore'

/** 交接包格式标识与版本 */
export const HANDOFF_KIND = 'gbinsectlog-handoff'
export const HANDOFF_VERSION = 1

export const TABLE_NAMES: TableName[] = ['sites', 'specimens', 'determinations', 'storages']

/**
 * 行快照：表 → 记录 id → 记录内容。
 * 作为三路合并的「共同祖先」：导出方把自己上次同步点的快照放进交接包，
 * 接收方逐字段对比 基线 / 馆内 / 包内 三份值，识别单边变化。
 */
export interface TableSnapshots {
  sites: Record<string, CollectSite>
  specimens: Record<string, Specimen>
  determinations: Record<string, Determination>
  storages: Record<string, Storage>
}

/** 交接包（离线文件） */
export interface HandoffPackage {
  kind: typeof HANDOFF_KIND
  version: number
  exportedAt: string
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
  /** 导出方上次同步点的行快照；首次导出时为空 */
  base: TableSnapshots
}

/** 解析后的统一载荷：交接包与旧备份都归一到这个结构 */
export interface ParsedPackage {
  format: 'handoff' | 'legacy'
  exportedAt: string
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
  /** 旧备份没有基线，为空快照 → 合并时退化为保守对照 */
  base: TableSnapshots
  warnings: string[]
}

/** 本地四表全量 */
export interface LocalData {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
}

export function emptySnapshots(): TableSnapshots {
  return { sites: {}, specimens: {}, determinations: {}, storages: {} }
}

/** 读取本地四表全量 */
export async function loadLocalData(): Promise<LocalData> {
  const [sites, specimens, determinations, storages] = await Promise.all([
    loadAll<CollectSite>(db.sites),
    loadAll<Specimen>(db.specimens),
    loadAll<Determination>(db.determinations),
    loadAll<Storage>(db.storages)
  ])
  return { sites, specimens, determinations, storages }
}

/** 把四表全量转成行快照 */
export function snapshotAll(local: LocalData): TableSnapshots {
  const toMap = <T extends { id: string }>(rows: T[]): Record<string, T> =>
    Object.fromEntries(rows.map((row) => [row.id, row]))
  return {
    sites: toMap(local.sites),
    specimens: toMap(local.specimens),
    determinations: toMap(local.determinations),
    storages: toMap(local.storages)
  }
}

const SYNC_BASE_KEY = 'syncBase'

/** 读取本机的同步基线（上次导出 / 导入合并完成时的全量快照） */
export async function readSyncBase(): Promise<TableSnapshots> {
  const row = await db.meta.get(SYNC_BASE_KEY)
  if (!row || typeof row.value !== 'object' || row.value === null) return emptySnapshots()
  return sanitizeBase(row.value)
}

/** 写入本机的同步基线 */
export async function writeSyncBase(snapshots: TableSnapshots): Promise<void> {
  await db.meta.put({ key: SYNC_BASE_KEY, value: snapshots })
}

/** 构建交接包：四表全量 + 本机当前同步基线 */
export async function buildHandoffPackage(): Promise<HandoffPackage> {
  const local = await loadLocalData()
  const base = await readSyncBase()
  return {
    kind: HANDOFF_KIND,
    version: HANDOFF_VERSION,
    exportedAt: new Date().toISOString(),
    ...local,
    base
  }
}

/**
 * 导出完成后推进本机基线：这份包回馆合并后，馆内状态即本机当前状态，
 * 下次再导出时就能以「此刻」为共同祖先识别单边变化。
 */
export async function advanceSyncBase(): Promise<void> {
  await writeSyncBase(snapshotAll(await loadLocalData()))
}

/** 键排序的稳定序列化，用于行内容相等判断 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

export function rowsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

type RowValidator = (row: Record<string, unknown>) => boolean

/** 从原始对象里挑出合法行，丢弃的行计入 warnings */
function pickRows<T>(raw: unknown, table: string, valid: RowValidator, warnings: string[]): T[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push(`「${table}」不是数组，已忽略`)
    return []
  }
  const rows: T[] = []
  let dropped = 0
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && valid(item as Record<string, unknown>)) {
      rows.push(item as T)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) warnings.push(`「${table}」有 ${dropped} 条记录缺少必要字段，已跳过`)
  return rows
}

const hasId = (row: Record<string, unknown>): boolean => typeof row.id === 'string' && row.id.length > 0

/** 清洗基线快照：只保留结构合法的表与行 */
function sanitizeBase(raw: unknown): TableSnapshots {
  const base = emptySnapshots()
  if (typeof raw !== 'object' || raw === null) return base
  const obj = raw as Record<string, unknown>
  for (const table of TABLE_NAMES) {
    const entries = obj[table]
    if (typeof entries !== 'object' || entries === null) continue
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null && hasId(value as Record<string, unknown>)) {
        ;(base[table] as Record<string, unknown>)[key] = value
      }
    }
  }
  return base
}

/**
 * 解析交接包文件；同时兼容旧备份（无 kind / base 的全量导出 JSON）。
 * 解析失败抛出带中文说明的 Error。
 */
export function parsePackage(text: string): ParsedPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON，请选择交接包或备份文件')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('文件内容不是交接包对象')
  }
  const obj = raw as Record<string, unknown>
  const isHandoff = obj.kind === HANDOFF_KIND
  if (isHandoff) {
    const version = typeof obj.version === 'number' ? obj.version : 0
    if (version > HANDOFF_VERSION) {
      throw new Error(`交接包版本 v${version} 高于当前支持的 v${HANDOFF_VERSION}，请升级应用后再合并`)
    }
  }

  const warnings: string[] = []
  const sites = pickRows<CollectSite>(obj.sites, '采集地', (row) => hasId(row) && typeof row.code === 'string', warnings)
  const specimens = pickRows<Specimen>(
    obj.specimens,
    '标本',
    (row) => hasId(row) && typeof row.code === 'string',
    warnings
  )
  const determinations = pickRows<Determination>(
    obj.determinations,
    '鉴定记录',
    (row) => hasId(row) && typeof row.specimenId === 'string',
    warnings
  )
  const storages = pickRows<Storage>(
    obj.storages,
    '保藏位置',
    (row) => hasId(row) && typeof row.specimenId === 'string' && typeof row.cabinet === 'string',
    warnings
  )

  if (!isHandoff && sites.length + specimens.length + determinations.length + storages.length === 0) {
    throw new Error('无法识别的文件：既不是交接包，也不包含采集地 / 标本 / 鉴定 / 保藏数据')
  }

  return {
    format: isHandoff ? 'handoff' : 'legacy',
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    sites,
    specimens,
    determinations,
    storages,
    base: isHandoff ? sanitizeBase(obj.base) : emptySnapshots(),
    warnings
  }
}
