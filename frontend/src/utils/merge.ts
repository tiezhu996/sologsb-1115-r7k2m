import { distanceMeters } from '@/types'
import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import {
  DETERMINATION_FIELDS,
  EMPTY_RESOLUTIONS,
  EMPTY_SNAPSHOT,
  ENTITY_LABEL,
  HANDOFF_FORMAT,
  NEW_SITE,
  SITE_FIELDS,
  SITE_MATCH_RADIUS,
  SPECIMEN_FIELDS,
  STORAGE_FIELDS,
  type BaselineRow,
  type BundleData,
  type EntityKind,
  type EntityPlan,
  type FieldConflict,
  type FieldDef,
  type MergeJob,
  type MergePlan,
  type MergeReport,
  type MergeResolutions,
  type Snapshot
} from '@/types/merge'

/* ---------------------------------- 哈希 ---------------------------------- */

/** FNV-1a 32 位哈希，输出 base36；确定性，供新增行 id 使用（重试不换 id） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

/** 新增行的确定性 id：同一交接包重复应用永远写同一行，杜绝重复建档 */
function deterministicId(prefix: string, key: string): string {
  return `imp_${prefix}_${fnv1a(key)}`
}

/* --------------------------------- 值比较 --------------------------------- */

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim()
  return value ?? ''
}

function sameValue(a: unknown, b: unknown): boolean {
  const va = normalizeValue(a)
  const vb = normalizeValue(b)
  if (va === vb) return true
  if (typeof va === 'number' && typeof vb === 'number') return Math.abs(va - vb) < 1e-9
  return false
}

function slotKey(s: Pick<Storage, 'cabinet' | 'drawer' | 'box' | 'slot'>): string {
  return `${s.cabinet.trim().toUpperCase()}-${s.drawer}-${s.box}-${s.slot}`
}

/** 鉴定记录自然键：同一标本 + 鉴定人 + 日期视为同一条（结论/文献等是被合并的内容，不参与认定） */
function detKey(d: Pick<Determination, 'specimenId' | 'determiner' | 'date'>): string {
  return `${d.specimenId}｜${d.determiner.trim()}｜${d.date.trim()}`.toLowerCase()
}

/* ------------------------------ 包 / 备份解析 ------------------------------ */

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

/** 兼容两种来源：新交接包（format + baseline）与旧全量备份（顶层平铺数组） */
export function parseBundle(raw: unknown): BundleData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('文件内容不是有效的 JSON 对象')
  }
  const obj = raw as Record<string, unknown>
  const pick = (name: string): Record<string, unknown>[] => asArray(obj[name])

  return {
    format: typeof obj.format === 'string' ? obj.format : 'gbinsectlog-backup/legacy',
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    origin: typeof obj.origin === 'string' ? obj.origin : '',
    sites: pick('sites') as unknown as CollectSite[],
    specimens: pick('specimens') as unknown as Specimen[],
    determinations: pick('determinations') as unknown as Determination[],
    storages: pick('storages') as unknown as Storage[],
    baseline: parseSnapshot(obj.baseline)
  }
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  if (!Array.isArray(obj.sites) && !Array.isArray(obj.specimens)) return null
  return {
    sites: asArray(obj.sites) as unknown as CollectSite[],
    specimens: asArray(obj.specimens) as unknown as Specimen[],
    determinations: asArray(obj.determinations) as unknown as Determination[],
    storages: asArray(obj.storages) as unknown as Storage[]
  }
}

/** 读取本馆当前台账（合并现场） */
export async function loadLocalSnapshot(): Promise<Snapshot> {
  const [sites, specimens, determinations, storages] = await Promise.all([
    db.sites.toArray(),
    db.specimens.toArray(),
    db.determinations.toArray(),
    db.storages.toArray()
  ])
  return { sites, specimens, determinations, storages }
}

/** 生成交接包 JSON 对象（野外端导出用） */
export function buildBundle(snapshot: Snapshot, baseline: Snapshot | null): BundleData {
  return {
    ...snapshot,
    format: HANDOFF_FORMAT,
    exportedAt: new Date().toISOString(),
    origin: 'offline-handoff',
    baseline
  }
}

/* ------------------------------ 三方字段比对 ------------------------------ */

export interface FieldDecision {
  field: string
  label: string
  /** 本馆现值 */
  local: unknown
  /** 交接包值（野外） */
  remote: unknown
  /** 出队基线值，无基线时为 null */
  base: unknown
  /**
   * 字段处置：
   * - accept-remote：仅野外改（单边变化），直接接野外值
   * - keep-local：仅本馆改（单边变化），保持本馆值
   * - conflict：两边都改成不同值，列来源对照（默认保持本馆，等人工选择）
   */
  outcome: 'accept-remote' | 'keep-local' | 'conflict'
  /** conflict 时的人工选择（null=未处理） */
  resolution: 'local' | 'remote' | null
}

/**
 * 逐字段三方比对：
 * - 仅野外改（base==local, remote 不同）→ 接收野外值；
 * - 仅本馆改（base==remote, local 不同）→ 保持本馆；
 * - 两边都改成不同值 → 列来源对照，默认保持本馆，待人工选择（保藏位置在此之前不写入）。
 * 无基线时只要双方值不同即列对照（旧备份兼容策略，不静默覆盖）。
 */
function diffFields(
  fields: FieldDef[],
  localRow: Record<string, unknown>,
  remoteRow: Record<string, unknown>,
  baseRow: Record<string, unknown> | null,
  hasBase: boolean
): FieldDecision[] {
  const decisions: FieldDecision[] = []
  for (const def of fields) {
    const remote = remoteRow[def.key]
    const local = localRow[def.key]
    if (sameValue(remote, local)) continue
    const base = hasBase && baseRow ? baseRow[def.key] : undefined
    let outcome: FieldDecision['outcome'] = 'conflict'
    if (hasBase && baseRow) {
      const remoteChanged = !sameValue(base, remote)
      const localChanged = !sameValue(base, local)
      if (remoteChanged && !localChanged) outcome = 'accept-remote'
      else if (!remoteChanged && localChanged) outcome = 'keep-local'
    }
    decisions.push({
      field: def.key,
      label: def.label,
      local,
      remote,
      base: base ?? null,
      outcome,
      resolution: null
    })
  }
  return decisions
}

/** 需要列来源对照的字段（两边都改或无基线差异） */
function conflictsOf(decisions: FieldDecision[]): FieldConflict[] {
  return decisions
    .filter((d) => d.outcome === 'conflict')
    .map((d) => ({ field: d.field, label: d.label, local: d.local, remote: d.remote, base: d.base, resolution: d.resolution }))
}

/**
 * 按字段决定 + 人工选择合并出最终行：
 * - accept-remote 落野外值；keep-local 留本馆值；
 * - conflict 只有人工选「取野外」才覆盖，未选一律保持本馆值。
 */
function mergeValues(
  fields: FieldDef[],
  localRow: Record<string, unknown>,
  remoteRow: Record<string, unknown>,
  decisions: FieldDecision[]
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...localRow }
  const byField = new Map(decisions.map((d) => [d.field, d]))
  for (const def of fields) {
    const d = byField.get(def.key)
    if (!d) continue
    if (d.outcome === 'accept-remote') values[def.key] = remoteRow[def.key]
    else if (d.outcome === 'conflict' && d.resolution === 'remote') values[def.key] = remoteRow[def.key]
  }
  return values
}

/** 合并结果相对本馆行是否有字段变化 */
function decisionsChanged(fields: FieldDef[], localRow: Record<string, unknown>, merged: Record<string, unknown>): boolean {
  return fields.some((def) => !sameValue(merged[def.key], localRow[def.key]))
}

/* -------------------------------- 合并计划 -------------------------------- */

/** 本轮计划使用的人工处理结果（prepareMerge 入口注入） */
let currentResolutions: MergeResolutions = EMPTY_RESOLUTIONS()

function stampResolutions(kind: EntityKind, incomingId: string, decisions: FieldDecision[]): void {
  for (const d of decisions) {
    if (d.outcome !== 'conflict') continue
    const saved = currentResolutions.fields[`${kind}:${incomingId}:${d.field}`]
    if (saved) d.resolution = saved
  }
}

interface SiteMapping {
  /** 入包采集地 id → 最终写库 id */
  finalId: Map<string, string>
  blocked: Set<string>
}

/** 采集地认定：先基线 id，再代码（大小写不敏感），再坐标 50 米；多坐标命中则歧义 */
function mapSites(plan: MergePlan, local: Snapshot, bundle: BundleData): SiteMapping {
  const baseline = bundle.baseline
  const baseById = new Map(baseline?.sites.map((s) => [s.id, s]) ?? [])
  const localById = new Map(local.sites.map((s) => [s.id, s]))

  const finalId = new Map<string, string>()
  const blocked = new Set<string>()

  for (const remote of bundle.sites) {
    const reasons: string[] = []
    const infos: string[] = []
    const base = baseById.get(remote.id) ?? null
    const baseExists = base !== null
    let match: EntityPlan['match'] = 'new'
    let localSite: CollectSite | null = null
    const candidates: CollectSite[] = []

    // 1) 基线里有同 id：离队前它就是本馆记录
    if (base) {
      const byId = localById.get(base.id)
      if (byId) {
        localSite = byId
        match = 'matched'
      } else {
        // 本馆已删除（可能已被站点页合并到别处）：交给人工认定
        const near = local.sites
          .map((s) => ({ site: s, distance: distanceMeters(remote.latitude, remote.longitude, s.latitude, s.longitude) }))
          .filter((item) => item.distance <= SITE_MATCH_RADIUS)
        candidates.push(...near.map((item) => item.site))
        match = candidates.length > 0 ? 'ambiguous' : 'new'
        reasons.push('该采集地在基线中存在，但本馆台账里已删除或已被合并，请重新认定')
      }
    } else {
      // 2) 代码相同认同一处
      const sameCode = local.sites.filter((s) => s.code.trim().toUpperCase() === remote.code.trim().toUpperCase())
      // 3) 坐标 50 米内认同一处
      const near = local.sites
        .map((s) => ({ site: s, distance: distanceMeters(remote.latitude, remote.longitude, s.latitude, s.longitude) }))
        .filter((item) => item.distance <= SITE_MATCH_RADIUS)
        .map((item) => item.site)

      const codeIds = new Set(sameCode.map((s) => s.id))
      const nearIds = new Set(near.map((s) => s.id))
      const union = new Map<string, CollectSite>()
      sameCode.forEach((s) => union.set(s.id, s))
      near.forEach((s) => union.set(s.id, s))

      if (union.size === 1) {
        localSite = [...union.values()][0]
        match = 'matched'
        if (!codeIds.has(localSite.id)) infos.push('代码不同但坐标 50 米内，认作同一采集地（本馆代码不变）')
        if (!nearIds.has(localSite.id)) {
          const dist = distanceMeters(remote.latitude, remote.longitude, localSite.latitude, localSite.longitude)
          if (dist > SITE_MATCH_RADIUS) infos.push('代码相同但坐标相差超过 50 米，按代码认作同一处，请核对坐标')
        }
      } else if (union.size > 1) {
        match = 'ambiguous'
        candidates.push(...union.values())
        reasons.push(`按代码/坐标匹配到 ${union.size} 个候选采集地，请认定同一处或选择新建`)
      }
    }

    // 应用已保存的人工认定（任务重开/重试时恢复之前的选择）
    let isAmbiguousUnresolved = match === 'ambiguous'
    if (isAmbiguousUnresolved) {
      const resolved = currentResolutions.siteMatch[remote.id]
      if (resolved === NEW_SITE) {
        localSite = null
        match = 'new'
        isAmbiguousUnresolved = false
      } else if (resolved) {
        const chosen = localById.get(resolved) ?? candidates.find((s) => s.id === resolved) ?? null
        if (chosen) {
          localSite = chosen
          match = 'matched'
          isAmbiguousUnresolved = false
        }
      }
    }

    if (isAmbiguousUnresolved) blocked.add(remote.id)

    let action: EntityPlan['action']
    let values: Record<string, unknown> | null = null
    const conflicts: FieldConflict[] = []

    const remoteRow = remote as unknown as Record<string, unknown>
    if (localSite) {
      const localRow = localSite as unknown as Record<string, unknown>
      const decisions = diffFields(SITE_FIELDS, localRow, remoteRow, base as unknown as Record<string, unknown> | null, baseExists)
      stampResolutions('site', remote.id, decisions)
      const merged = mergeValues(SITE_FIELDS, localRow, remoteRow, decisions)
      conflicts.push(...conflictsOf(decisions))
      // 代码是标本编号前缀，一律保留本馆代码，不改写
      values = { ...merged, id: localSite.id, code: localSite.code }
      action = decisionsChanged(SITE_FIELDS, localRow, merged) ? 'update' : 'unchanged'
      finalId.set(remote.id, localSite.id)
      if (localSite.code.trim().toUpperCase() !== remote.code.trim().toUpperCase()) {
        infos.push(`入包代码 ${remote.code} 与本馆代码 ${localSite.code} 不一致，保留本馆代码，标本编号不改写`)
      }
      if (isAmbiguousUnresolved) {
        action = 'skip'
        values = null
      }
    } else {
      const newId = base?.id ?? deterministicId('site', remote.code.trim().toUpperCase())
      finalId.set(remote.id, newId)
      values = { ...remoteRow, id: newId, code: remote.code.trim().toUpperCase() }
      if (isAmbiguousUnresolved) {
        action = 'skip'
        values = null
      } else {
        action = 'insert'
      }
    }

    plan.sites.push({
      kind: 'site',
      incomingId: remote.id,
      localId: localSite?.id ?? null,
      finalId: finalId.get(remote.id) ?? '',
      label: remote.code,
      sublabel: remote.name,
      match,
      candidates: candidates.map((s) => s.id),
      baseExists,
      action,
      values,
      conflicts,
      blockedReasons: isAmbiguousUnresolved ? reasons : [],
      infos
    })
  }

  return { finalId, blocked }
}

/* -------------------------------- 标本映射 ------------------------------- */

interface SpecimenMapping {
  /** 入包标本 id → 最终写库 id */
  finalId: Map<string, string>
  /** 本馆标本 id → 最终写库 id（鉴定/保藏记录的外键经它对齐） */
  localToFinal: Map<string, string>
  blocked: Set<string>
}

function mapSpecimens(
  plan: MergePlan,
  local: Snapshot,
  bundle: BundleData,
  siteMapping: SiteMapping
): SpecimenMapping {
  const baseline = bundle.baseline
  const baseByCode = new Map(
    (baseline?.specimens ?? []).map((s) => [s.code.trim().toUpperCase(), s])
  )
  const localByCode = new Map(
    local.specimens.map((s) => [s.code.trim().toUpperCase(), s])
  )

  const finalId = new Map<string, string>()
  // 本馆标本默认留在本馆（鉴定/保藏记录的外键需能对齐到包里没带走的标本）
  const localToFinal = new Map(local.specimens.map((s) => [s.id, s.id]))
  const blocked = new Set<string>()

  for (const remote of bundle.specimens) {
    const reasons: string[] = []
    const infos: string[] = []
    const code = remote.code.trim().toUpperCase()

    // 外键：入包采集地 → 最终采集地 id；采集地未认定则整条标本挂起
    const siteFinalId = siteMapping.finalId.get(remote.siteId)
    let siteBlocked = false
    if (!siteFinalId || siteMapping.blocked.has(remote.siteId)) {
      siteBlocked = true
      reasons.push('关联采集地尚未完成认定')
      blocked.add(remote.id)
    }

    const base = baseByCode.get(code) ?? null
    const baseExists = base !== null
    const localSpecimen = localByCode.get(code) ?? null
    const remoteRow = remote as unknown as Record<string, unknown>

    let action: EntityPlan['action']
    let values: Record<string, unknown> | null = null
    const conflicts: FieldConflict[] = []

    if (localSpecimen) {
      const localRow = localSpecimen as unknown as Record<string, unknown>
      const decisions = diffFields(SPECIMEN_FIELDS, localRow, remoteRow, base as unknown as Record<string, unknown> | null, baseExists)
      stampResolutions('specimen', remote.id, decisions)
      const merged = mergeValues(SPECIMEN_FIELDS, localRow, remoteRow, decisions)
      conflicts.push(...conflictsOf(decisions))
      if (!siteBlocked) merged.siteId = siteFinalId
      values = { ...merged, id: localSpecimen.id, code: localSpecimen.code }
      action = decisionsChanged(SPECIMEN_FIELDS, localRow, merged) ? 'update' : 'unchanged'
      finalId.set(remote.id, localSpecimen.id)
      localToFinal.set(localSpecimen.id, localSpecimen.id)
      if (siteBlocked) {
        action = 'skip'
        values = null
      }
    } else {
      if (baseExists) infos.push('基线中存在该编号但本馆已没有，按新增建档（编号原样保留）')
      // 编号照旧：不重新分配、不加后缀
      const newId = base?.id ?? deterministicId('sp', code)
      finalId.set(remote.id, newId)
      values = { ...remoteRow, id: newId, code: remote.code, siteId: siteFinalId ?? remote.siteId }
      action = 'insert'
      if (siteBlocked) {
        action = 'skip'
        values = null
      }
    }

    plan.specimens.push({
      kind: 'specimen',
      incomingId: remote.id,
      localId: localSpecimen?.id ?? null,
      finalId: finalId.get(remote.id) ?? '',
      label: remote.code,
      sublabel: [remote.order, remote.family, remote.tempName].filter(Boolean).join(' / ') || '未定名',
      match: localSpecimen ? 'matched' : 'new',
      candidates: [],
      baseExists,
      action,
      values,
      conflicts,
      blockedReasons: reasons,
      infos
    })
  }

  return { finalId, localToFinal, blocked }
}

function mapDeterminations(
  plan: MergePlan,
  local: Snapshot,
  bundle: BundleData,
  specimenMapping: SpecimenMapping
): void {
  const baseline = bundle.baseline
  const resolveSpec = (specimenId: string): string => specimenMapping.localToFinal.get(specimenId) ?? specimenId

  // 三方匹配均按「标本 + 自然键」索引；基线与本馆行处在同一 id 空间，统一按本馆 id 对齐到最终 id
  const indexRows = (rows: Determination[]) => {
    const map = new Map<string, Determination>()
    for (const row of rows) {
      const resolvedSpec = resolveSpec(row.specimenId)
      map.set(detKey({ ...row, specimenId: resolvedSpec }), { ...row, specimenId: resolvedSpec })
    }
    return map
  }

  const baseMap = indexRows(baseline?.determinations ?? [])
  const localMap = indexRows(local.determinations)

  for (const remote of bundle.determinations) {
    const reasons: string[] = []
    const infos: string[] = []
    const specFinal = specimenMapping.finalId.get(remote.specimenId)
    let blocked = false
    if (!specFinal || specimenMapping.blocked.has(remote.specimenId)) {
      blocked = true
      reasons.push('所属标本尚未完成入包处理（采集地未认定）')
    }

    const keyedRemote: Determination = { ...remote, specimenId: specFinal ?? remote.specimenId }
    const key = detKey(keyedRemote)
    const base = baseMap.get(key) ?? null
    const localRow0 = localMap.get(key) ?? null
    const remoteRow = keyedRemote as unknown as Record<string, unknown>

    let action: EntityPlan['action']
    let values: Record<string, unknown> | null = null
    const conflicts: FieldConflict[] = []
    let localId: string | null = null
    let finalIdValue: string
    const label = `${remote.conclusion || '（无结论）'}`
    const sublabel = `${remote.determiner || '未填鉴定人'} · ${remote.date || '未填日期'}`

    if (localRow0) {
      const localRow = localRow0 as unknown as Record<string, unknown>
      const decisions = diffFields(DETERMINATION_FIELDS, localRow, remoteRow, base as unknown as Record<string, unknown> | null, base !== null)
      stampResolutions('determination', remote.id, decisions)
      const merged = mergeValues(DETERMINATION_FIELDS, localRow, remoteRow, decisions)
      conflicts.push(...conflictsOf(decisions))
      values = { ...merged, id: localRow0.id, specimenId: localRow0.specimenId }
      action = decisionsChanged(DETERMINATION_FIELDS, localRow, merged) ? 'update' : 'unchanged'
      localId = localRow0.id
      finalIdValue = localRow0.id
      if (blocked) {
        action = 'skip'
        values = null
      }
    } else {
      if (base) infos.push('基线中存在该鉴定记录但本馆已没有，按新增恢复')
      finalIdValue = base?.id ?? deterministicId('det', key)
      values = { ...remoteRow, id: finalIdValue }
      action = 'insert'
      if (blocked) {
        action = 'skip'
        values = null
      }
    }

    plan.determinations.push({
      kind: 'determination',
      incomingId: remote.id,
      localId,
      finalId: finalIdValue,
      label,
      sublabel,
      match: localRow0 ? 'matched' : 'new',
      candidates: [],
      baseExists: base !== null,
      action,
      values,
      conflicts,
      blockedReasons: reasons,
      infos
    })
  }
}

/* -------------------------------- 保藏位置 -------------------------------- */

function mapStorages(
  plan: MergePlan,
  local: Snapshot,
  bundle: BundleData,
  specimenMapping: SpecimenMapping
): void {
  const baseline = bundle.baseline
  const resolveSpec = (specimenId: string): string => specimenMapping.localToFinal.get(specimenId) ?? specimenId
  const specCodeById = new Map(local.specimens.map((s) => [s.id, s.code.trim().toUpperCase()]))
  const localBySpecimen = new Map(
    local.storages.map((s) => [resolveSpec(s.specimenId), { ...s, specimenId: resolveSpec(s.specimenId) }])
  )
  const baseBySpecimen = new Map(
    (baseline?.storages ?? []).map((s) => {
      const specFinal = resolveSpec(s.specimenId)
      return [specFinal, { ...s, specimenId: specFinal }]
    })
  )

  // 已占用柜位：本馆现状 + 本计划已接收的新增/更新（保藏位置逐条落，冲突即挂起）
  const occupied = new Map<string, string>()
  for (const s of local.storages) occupied.set(slotKey(s), resolveSpec(s.specimenId))

  for (const remote0 of bundle.storages) {
    const reasons: string[] = []
    const infos: string[] = []
    const specFinal = specimenMapping.finalId.get(remote0.specimenId)
    const remote: Storage = { ...remote0, specimenId: specFinal ?? remote0.specimenId }
    const remoteRow = remote as unknown as Record<string, unknown>
    const specimenPlan = plan.specimens.find((p) => p.finalId === remote.specimenId)
    const code = specimenPlan?.label ?? specCodeById.get(remote.specimenId) ?? '未知标本'

    let blocked = false
    if (!specFinal || specimenMapping.blocked.has(remote0.specimenId)) {
      blocked = true
      reasons.push('所属标本尚未完成入包处理')
    }

    // 同一标本有未决字段对照：处理前保藏位置不进库
    const specimenConflicts = specimenPlan?.conflicts.filter((c) => c.resolution === null) ?? []
    if (specimenConflicts.length > 0) {
      blocked = true
      reasons.push(`标本「${code}」还有 ${specimenConflicts.length} 个字段双值对照未处理`)
    }

    const localRow0 = localBySpecimen.get(remote.specimenId) ?? null
    const base = baseBySpecimen.get(remote.specimenId) ?? null
    const key = slotKey(remote)

    // 柜位占用检查：同一柜位不允许两份标本
    const occupant = occupied.get(key)
    if (occupant && occupant !== remote.specimenId) {
      blocked = true
      reasons.push(`柜位 ${key} 已被标本「${specCodeById.get(occupant) ?? occupant}」占用，避免占两个柜位`)
    }

    let action: EntityPlan['action']
    let values: Record<string, unknown> | null = null
    const conflicts: FieldConflict[] = []
    let localId: string | null = null
    let finalIdValue: string

    if (localRow0) {
      const localRow = localRow0 as unknown as Record<string, unknown>
      const decisions = diffFields(STORAGE_FIELDS, localRow, remoteRow, base as unknown as Record<string, unknown> | null, base !== null)
      stampResolutions('storage', remote0.id, decisions)
      const merged = mergeValues(STORAGE_FIELDS, localRow, remoteRow, decisions)
      conflicts.push(...conflictsOf(decisions))
      values = { ...merged, id: localRow0.id, specimenId: remote.specimenId }
      action = decisionsChanged(STORAGE_FIELDS, localRow, merged) ? 'update' : 'unchanged'
      localId = localRow0.id
      finalIdValue = localRow0.id
      if (blocked) {
        action = 'skip'
        values = null
      } else {
        occupied.set(key, remote.specimenId)
      }
    } else {
      if (base) infos.push('基线中该标本已入柜但本馆没有位置记录，按新增入柜')
      finalIdValue = base?.id ?? deterministicId('stg', remote.specimenId)
      values = { ...remoteRow, id: finalIdValue }
      action = 'insert'
      if (blocked) {
        action = 'skip'
        values = null
      } else {
        occupied.set(key, remote.specimenId)
      }
    }

    plan.storages.push({
      kind: 'storage',
      incomingId: remote0.id,
      localId,
      finalId: finalIdValue,
      label: key,
      sublabel: `标本 ${code} · ${remote.method}`,
      match: localRow0 ? 'matched' : 'new',
      candidates: [],
      baseExists: base !== null,
      action,
      values,
      conflicts,
      blockedReasons: reasons,
      infos
    })
  }
}

/* --------------------------------- 入口 ---------------------------------- */

/**
 * 根据本馆现状 + 交接包 + 已保存的人工处理结果生成合并计划（纯计算，可反复重算）。
 */
export function prepareMerge(local: Snapshot, bundle: BundleData, resolutions: MergeResolutions): MergePlan {
  currentResolutions = resolutions
  const plan: MergePlan = {
    sites: [],
    specimens: [],
    determinations: [],
    storages: [],
    issues: [],
    summary: { inserts: 0, updates: 0, unchanged: 0, skips: 0, unresolved: 0 }
  }

  if (!bundle.baseline) {
    plan.issues.push({
      level: 'warning',
      text: '该包不含出队基线（可能是旧版备份）：无法判断单边变化，凡双方不一致的字段一律先列来源对照，需人工处理后才会写入。'
    })
  }

  const siteMapping = mapSites(plan, local, bundle)
  const specimenMapping = mapSpecimens(plan, local, bundle, siteMapping)
  mapDeterminations(plan, local, bundle, specimenMapping)
  mapStorages(plan, local, bundle, specimenMapping)

  const all = [...plan.sites, ...plan.specimens, ...plan.determinations, ...plan.storages]
  for (const p of all) {
    if (p.action === 'insert') plan.summary.inserts += 1
    if (p.action === 'update') plan.summary.updates += 1
    if (p.action === 'unchanged') plan.summary.unchanged += 1
    if (p.action === 'skip') plan.summary.skips += 1
  }
  plan.summary.unresolved = all.filter(
    (p) => p.blockedReasons.length > 0 || p.conflicts.some((c) => c.resolution === null)
  ).length

  const blockedStorage = plan.storages.filter((p) => p.blockedReasons.length > 0).length
  if (blockedStorage > 0) {
    plan.issues.push({
      level: 'info',
      text: `${blockedStorage} 条保藏位置按规则暂缓写入（字段对照未处理 / 柜位冲突 / 标本未认定），其余记录可先合并。`
    })
  }

  return plan
}

/* -------------------------------- 应用写库 -------------------------------- */

function collectWritable(plan: MergePlan): {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  storages: Storage[]
  report: MergeReport
} {
  const pick = <T,>(plans: EntityPlan[]): T[] =>
    plans.filter((p) => (p.action === 'insert' || p.action === 'update') && p.values).map((p) => p.values as T)

  const all = [...plan.sites, ...plan.specimens, ...plan.determinations, ...plan.storages]
  const now = new Date().toISOString()
  return {
    sites: pick<CollectSite>(plan.sites),
    specimens: pick<Specimen>(plan.specimens),
    determinations: pick<Determination>(plan.determinations),
    storages: pick<Storage>(plan.storages),
    report: {
      appliedAt: now,
      inserted: all.filter((p) => p.action === 'insert').length,
      updated: all.filter((p) => p.action === 'update').length,
      skipped: all.filter((p) => p.action === 'skip').length,
      remainingConflicts: all.filter(
        (p) => p.blockedReasons.length > 0 || p.conflicts.some((c) => c.resolution === null)
      ).length
    }
  }
}

/**
 * 在单个 Dexie 事务内提交：
 * - 新行使用确定性 id + put：失败重跑写的是同一行，不会重复建档；
 * - 保藏位置先查柜位占用再写：同柜位不会出现两份标本，不会占两个柜位；
 * - 事务中途失败整体回滚，任务保留 open 状态，恢复后可直接重试。
 */
export async function applyMerge(plan: MergePlan): Promise<MergeReport> {
  const writable = collectWritable(plan)

  await db.transaction('rw', db.sites, db.specimens, db.determinations, db.storages, async () => {
    if (writable.sites.length > 0) await db.sites.bulkPut(writable.sites)
    if (writable.specimens.length > 0) await db.specimens.bulkPut(writable.specimens)
    if (writable.determinations.length > 0) await db.determinations.bulkPut(writable.determinations)

    if (writable.storages.length > 0) {
      // 事务内再核一次柜位：本馆现状 + 本批内部，双保险
      const occupied = new Map<string, string>()
      for (const s of await db.storages.toArray()) occupied.set(slotKey(s), s.specimenId)
      const accepted: Storage[] = []
      for (const incoming of writable.storages) {
        const key = slotKey(incoming)
        const holder = occupied.get(key)
        if (holder && holder !== incoming.specimenId) continue // 冲突：不占用柜位，计划里已挂起
        occupied.set(key, incoming.specimenId)
        accepted.push(incoming)
      }
      if (accepted.length > 0) await db.storages.bulkPut(accepted)
    }
  })

  return writable.report
}

/* ------------------------------ 任务持久化 ------------------------------- */

export async function createMergeJob(bundle: BundleData, filename: string): Promise<MergeJob> {
  const now = new Date().toISOString()
  const job: MergeJob = {
    id: deterministicId('job', `${filename}｜${bundle.exportedAt}｜${now}`),
    createdAt: now,
    updatedAt: now,
    status: 'open',
    filename,
    origin: bundle.origin,
    exportedAt: bundle.exportedAt,
    bundle,
    resolutions: EMPTY_RESOLUTIONS(),
    lastError: null,
    appliedAt: null,
    lastReport: null
  }
  await db.mergeJobs.put(job)
  return job
}

export async function updateMergeJob(job: MergeJob, patch: Partial<MergeJob>): Promise<MergeJob> {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() }
  await db.mergeJobs.put(next)
  return next
}

export async function saveFieldResolution(
  job: MergeJob,
  kind: EntityKind,
  incomingId: string,
  field: string,
  resolution: 'local' | 'remote'
): Promise<MergeJob> {
  const fields = { ...job.resolutions.fields, [`${kind}:${incomingId}:${field}`]: resolution }
  return updateMergeJob(job, { resolutions: { ...job.resolutions, fields } })
}

export async function saveSiteMatchResolution(job: MergeJob, incomingSiteId: string, target: string): Promise<MergeJob> {
  const siteMatch = { ...job.resolutions.siteMatch, [incomingSiteId]: target }
  return updateMergeJob(job, { resolutions: { ...job.resolutions, siteMatch } })
}

/* -------------------------------- 基线管理 -------------------------------- */

export async function saveBaseline(snapshot: Snapshot, source: { exportedAt?: string; origin?: string }): Promise<void> {
  const row: BaselineRow = {
    key: 'latest',
    importedAt: new Date().toISOString(),
    exportedAt: source.exportedAt ?? new Date().toISOString(),
    origin: source.origin ?? '馆内备份',
    snapshot
  }
  await db.baselines.put(row)
}

export async function loadBaseline(): Promise<BaselineRow | null> {
  return (await db.baselines.get('latest')) ?? null
}

export function emptySnapshot(): Snapshot {
  return EMPTY_SNAPSHOT()
}

export { ENTITY_LABEL }
