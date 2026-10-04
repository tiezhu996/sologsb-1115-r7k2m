import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import { findNearbySites } from '@/types'
import type { FieldConflict, MergeOp, MergePlan, TableName } from '@/types/merge'
import { storageSlotText } from '@/utils/codec'
import { uid } from '@/utils/id'
import type { LocalData, ParsedPackage } from '@/utils/handoff'

/** 冲突解决选择：冲突键 → 留馆内 / 用交接包 */
export type Resolutions = Record<string, 'local' | 'incoming'>

/** 参与三路合并的字段（id 与匹配键除外：标本编号、采集地代码照旧不动） */
const SITE_FIELDS = [
  'name',
  'region',
  'longitude',
  'latitude',
  'altitude',
  'habitat',
  'microHabitat',
  'microClimate',
  'dateStart',
  'dateEnd'
] as const
const SPECIMEN_FIELDS = [
  'order',
  'family',
  'genus',
  'species',
  'tempName',
  'collectDate',
  'collector',
  'sex',
  'stage',
  'bodyLength',
  'method',
  'quantity',
  'status',
  'determiner',
  'siteId',
  'note'
] as const
const DETERMINATION_FIELDS = ['determiner', 'date', 'conclusion', 'reference', 'confidence', 'needReview'] as const
const STORAGE_FIELDS = ['method', 'cabinet', 'drawer', 'box', 'slot', 'storedDate', 'handler'] as const

/** 字段中文名（冲突对照表用） */
export const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  region: '行政区',
  longitude: '经度',
  latitude: '纬度',
  altitude: '海拔',
  habitat: '生境类型',
  microHabitat: '小生境',
  microClimate: '微气候',
  dateStart: '采集日期起',
  dateEnd: '采集日期止',
  order: '目',
  family: '科',
  genus: '属',
  species: '种',
  tempName: '暂定名',
  collectDate: '采集日期',
  collector: '采集人',
  sex: '性别',
  stage: '虫态',
  bodyLength: '体长(mm)',
  method: '方式',
  quantity: '数量',
  status: '鉴定状态',
  determiner: '鉴定人',
  siteId: '采集地',
  note: '备注',
  date: '鉴定日期',
  conclusion: '鉴定结论',
  reference: '依据文献',
  confidence: '置信度',
  needReview: '需复核',
  cabinet: '标本柜',
  drawer: '抽屉号',
  box: '标本盒号',
  slot: '插位序号',
  storedDate: '入柜日期',
  handler: '经手人'
}

interface PlanCtx {
  ops: MergeOp[]
  conflicts: FieldConflict[]
  notes: string[]
  resolutions: Resolutions
}

type Row = Record<string, unknown>

/**
 * 逐字段三路合并一条记录：
 * - 两边相同 → 不动；
 * - 有基线时，只有一边改过的字段直接接受（单边变化）；
 * - 两边都改且值不同（或无基线的旧备份）→ 列入冲突对照，等待人工选边。
 * 返回自动合并得到的字段补丁；hasPending 表示仍有未解决冲突。
 */
function mergeRow(
  ctx: PlanCtx,
  table: TableName,
  id: string,
  label: string,
  baseRow: Row | undefined,
  localRow: Row,
  incomingRow: Row,
  fields: readonly string[]
): { patch: Record<string, unknown>; hasPending: boolean } {
  const patch: Record<string, unknown> = {}
  let hasPending = false
  for (const field of fields) {
    const incomingValue = incomingRow[field]
    // 旧备份可能缺字段（如 v1 标本没有采集方式）：缺失不覆盖
    if (incomingValue === undefined) continue
    const localValue = localRow[field]
    if (incomingValue === localValue) continue
    const key = `${table}:${id}:${field}`

    let isConflict: boolean
    if (baseRow !== undefined) {
      const baseHas = Object.prototype.hasOwnProperty.call(baseRow, field)
      const baseValue = baseRow[field]
      const localChanged = !baseHas || baseValue !== localValue
      const incomingChanged = !baseHas || baseValue !== incomingValue
      if (!incomingChanged) continue // 仅馆内改过 → 留馆内
      if (!localChanged) {
        // 仅交接包改过 → 接受
        patch[field] = incomingValue
        continue
      }
      isConflict = true // 双边都改且值不同
    } else {
      isConflict = true // 无基线（旧备份 / 首次同步）→ 保守列入对照
    }

    if (isConflict) {
      const resolved = ctx.resolutions[key]
      ctx.conflicts.push({ key, table, id, label, field, localValue, incomingValue, resolved })
      if (resolved === 'incoming') patch[field] = incomingValue
      else if (resolved === undefined) hasPending = true
    }
  }
  return { patch, hasPending }
}

/** 采集地认领：先按代码（忽略大小写），再按坐标 50 米内认到同一处 */
function matchLocalSite(incoming: CollectSite, localSites: CollectSite[]): CollectSite | undefined {
  const code = incoming.code.trim().toUpperCase()
  const byCode = localSites.find((site) => site.code.trim().toUpperCase() === code)
  if (byCode) return byCode
  const nearby = findNearbySites(localSites, incoming.latitude, incoming.longitude, 50)
  return nearby[0]?.site
}

/** 分配不与馆内已有记录冲突的 id；优先沿用包内 id（保持鉴定 / 保藏引用稳定） */
function claimId(preferred: string, used: Set<string>, prefix: string): string {
  if (!used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  let id = uid(prefix)
  while (used.has(id)) id = uid(prefix)
  used.add(id)
  return id
}

/**
 * 生成合并计划（纯函数，不落库）：
 * 采集地按代码 / 坐标认领，标本按编号匹配且编号照旧，
 * 冲突标本的保藏位置暂缓，柜位被占的保藏位置跳过。
 */
export function buildMergePlan(local: LocalData, incoming: ParsedPackage, resolutions: Resolutions = {}): MergePlan {
  const ctx: PlanCtx = { ops: [], conflicts: [], notes: [], resolutions }
  const siteIdMap: Record<string, string> = {}
  const specimenIdMap: Record<string, string> = {}

  const usedSiteIds = new Set(local.sites.map((site) => site.id))
  const usedSpecimenIds = new Set(local.specimens.map((item) => item.id))
  const usedDeterminationIds = new Set(local.determinations.map((item) => item.id))
  const usedStorageIds = new Set(local.storages.map((item) => item.id))

  // —— 1. 采集地：代码 / 坐标认到同一处 ——
  const knownSites = [...local.sites]
  for (const inSite of incoming.sites) {
    const matched = matchLocalSite(inSite, knownSites)
    if (!matched) {
      const id = claimId(inSite.id, usedSiteIds, 'site')
      siteIdMap[inSite.id] = id
      const row: CollectSite = { ...inSite, id, code: inSite.code.trim().toUpperCase() }
      ctx.ops.push({ table: 'sites', action: 'insert', id, row, label: `采集地 ${row.code} ${row.name}` })
      knownSites.push(row)
    } else {
      siteIdMap[inSite.id] = matched.id
      const label = `采集地 ${matched.code} ${matched.name}`
      if (matched.code.trim().toUpperCase() !== inSite.code.trim().toUpperCase()) {
        ctx.notes.push(`采集地「${inSite.code} ${inSite.name}」按坐标认到「${matched.code} ${matched.name}」，代码以馆内为准`)
      }
      const { patch } = mergeRow(
        ctx,
        'sites',
        matched.id,
        label,
        incoming.base.sites[inSite.id] as unknown as Row | undefined,
        matched as unknown as Row,
        inSite as unknown as Row,
        SITE_FIELDS
      )
      if (Object.keys(patch).length > 0) {
        ctx.ops.push({ table: 'sites', action: 'update', id: matched.id, patch, label })
      }
    }
  }

  const knownSiteIds = new Set(knownSites.map((site) => site.id))

  // —— 2. 标本：按编号匹配，编号照旧 ——
  const localByCode = new Map(local.specimens.map((item) => [item.code.trim().toUpperCase(), item]))
  const blockedSpecimenIds = new Set<string>()
  const specimenCodeById = new Map(local.specimens.map((item) => [item.id, item.code]))
  for (const inSpecimen of incoming.specimens) {
    const mappedSiteId = siteIdMap[inSpecimen.siteId] ?? inSpecimen.siteId
    const mapped: Specimen = { ...inSpecimen, siteId: mappedSiteId }
    if (!knownSiteIds.has(mappedSiteId)) {
      ctx.notes.push(`标本 ${inSpecimen.code} 引用的采集地不在包内，馆内也找不到，请合并后检查`)
    }
    const matched = localByCode.get(inSpecimen.code.trim().toUpperCase())
    if (!matched) {
      const id = claimId(inSpecimen.id, usedSpecimenIds, 'sp')
      specimenIdMap[inSpecimen.id] = id
      specimenCodeById.set(id, inSpecimen.code)
      ctx.ops.push({ table: 'specimens', action: 'insert', id, row: { ...mapped, id }, label: `标本 ${inSpecimen.code}` })
    } else {
      specimenIdMap[inSpecimen.id] = matched.id
      const label = `标本 ${matched.code}`
      const { patch, hasPending } = mergeRow(
        ctx,
        'specimens',
        matched.id,
        label,
        incoming.base.specimens[inSpecimen.id] as unknown as Row | undefined,
        matched as unknown as Row,
        mapped as unknown as Row,
        SPECIMEN_FIELDS
      )
      if (hasPending) blockedSpecimenIds.add(matched.id)
      if (Object.keys(patch).length > 0) {
        ctx.ops.push({ table: 'specimens', action: 'update', id: matched.id, patch, label })
      }
    }
  }

  const knownSpecimenIds = new Set([...usedSpecimenIds])
  const specimenExists = (id: string): boolean => knownSpecimenIds.has(id)

  // —— 3. 鉴定记录：按 id 或业务键（标本+鉴定人+日期+结论）认领，避免重复建档 ——
  const localDeterminations = [...local.determinations]
  for (const inDetermination of incoming.determinations) {
    const mappedSpecimenId = specimenIdMap[inDetermination.specimenId] ?? inDetermination.specimenId
    if (!specimenExists(mappedSpecimenId)) {
      ctx.notes.push(`鉴定记录（${inDetermination.determiner} ${inDetermination.date}）引用的标本不在包内，已跳过`)
      continue
    }
    const mapped: Determination = { ...inDetermination, specimenId: mappedSpecimenId }
    const matched =
      localDeterminations.find((item) => item.id === inDetermination.id) ??
      localDeterminations.find(
        (item) =>
          item.specimenId === mappedSpecimenId &&
          item.determiner === inDetermination.determiner &&
          item.date === inDetermination.date &&
          item.conclusion === inDetermination.conclusion
      )
    const code = specimenCodeById.get(mappedSpecimenId) ?? mappedSpecimenId
    if (!matched) {
      const id = claimId(inDetermination.id, usedDeterminationIds, 'det')
      ctx.ops.push({
        table: 'determinations',
        action: 'insert',
        id,
        row: { ...mapped, id },
        label: `鉴定 ${code} · ${inDetermination.determiner}`
      })
    } else {
      const { patch } = mergeRow(
        ctx,
        'determinations',
        matched.id,
        `鉴定 ${code} · ${matched.determiner}`,
        incoming.base.determinations[inDetermination.id] as unknown as Row | undefined,
        matched as unknown as Row,
        mapped as unknown as Row,
        DETERMINATION_FIELDS
      )
      if (Object.keys(patch).length > 0) {
        ctx.ops.push({
          table: 'determinations',
          action: 'update',
          id: matched.id,
          patch,
          label: `鉴定 ${code} · ${matched.determiner}`
        })
      }
    }
  }

  // —— 4. 保藏位置：冲突标本暂缓入柜；柜位被占则跳过，绝不允许一柜两位 ——
  const localStorages = [...local.storages]
  for (const inStorage of incoming.storages) {
    const mappedSpecimenId = specimenIdMap[inStorage.specimenId] ?? inStorage.specimenId
    const code = specimenCodeById.get(mappedSpecimenId) ?? mappedSpecimenId
    if (!specimenExists(mappedSpecimenId)) {
      ctx.notes.push(`保藏位置（${inStorage.cabinet}）引用的标本不在包内，已跳过`)
      continue
    }
    if (blockedSpecimenIds.has(mappedSpecimenId)) {
      ctx.notes.push(`标本 ${code} 有未解决的字段冲突，保藏位置暂缓导入，解决对照后再执行`)
      continue
    }
    const mapped: Storage = { ...inStorage, specimenId: mappedSpecimenId }
    const matched = localStorages.find((item) => item.specimenId === mappedSpecimenId)
    const label = `保藏 ${code}`

    let target: Storage
    let op: MergeOp | null = null
    if (matched) {
      const { patch, hasPending } = mergeRow(
        ctx,
        'storages',
        matched.id,
        label,
        incoming.base.storages[inStorage.id] as unknown as Row | undefined,
        matched as unknown as Row,
        mapped as unknown as Row,
        STORAGE_FIELDS
      )
      // 柜-屉-盒-位是一个整体：有未解决冲突时整条暂缓，不写半截位置
      if (hasPending) {
        ctx.notes.push(`标本 ${code} 的保藏位置存在冲突，解决对照后再写入`)
        continue
      }
      target = { ...matched, ...patch } as Storage
      if (Object.keys(patch).length > 0) {
        op = { table: 'storages', action: 'update', id: matched.id, patch, label }
      }
    } else {
      const id = claimId(inStorage.id, usedStorageIds, 'stg')
      target = { ...mapped, id }
      op = { table: 'storages', action: 'insert', id, row: target, label }
    }

    // 柜位占用检查：同一柜位只允许一份标本
    const slotKey = storageSlotText(target)
    const occupant = localStorages.find(
      (item) => item.specimenId !== mappedSpecimenId && storageSlotText(item) === slotKey
    )
    if (occupant) {
      const occupantCode = specimenCodeById.get(occupant.specimenId) ?? occupant.specimenId
      ctx.notes.push(`柜位 ${slotKey} 已被标本 ${occupantCode} 占用，标本 ${code} 的保藏位置跳过，请到保藏页调整`)
      continue
    }
    if (op) {
      ctx.ops.push(op)
      if (op.action === 'insert') localStorages.push(target)
    }
  }

  const inserts = ctx.ops.filter((op) => op.action === 'insert').length
  const updates = ctx.ops.filter((op) => op.action === 'update').length
  const pendingCount = ctx.conflicts.filter((conflict) => conflict.resolved === undefined).length

  return {
    ops: ctx.ops,
    conflicts: ctx.conflicts,
    pendingCount,
    blockedCount: blockedSpecimenIds.size,
    notes: ctx.notes,
    stats: { inserts, updates }
  }
}
