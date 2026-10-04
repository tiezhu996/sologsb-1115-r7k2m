import { describe, expect, it } from 'vitest'
import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import { emptySnapshots, type LocalData, type ParsedPackage } from '@/utils/handoff'
import { buildMergePlan } from '@/utils/mergePlan'

const makeSite = (over: Partial<CollectSite> = {}): CollectSite => ({
  id: 'site_a',
  code: 'QLB',
  name: '青龙背',
  region: '黔南州',
  longitude: 107.2136,
  latitude: 25.8123,
  altitude: 986,
  habitat: '阔叶林',
  microHabitat: '',
  microClimate: '',
  dateStart: '2026-06-01',
  dateEnd: '2026-06-02',
  ...over
})

const makeSpecimen = (over: Partial<Specimen> = {}): Specimen => ({
  id: 'sp_a',
  code: 'QLB-2026-0001',
  order: '鞘翅目',
  family: '步甲科',
  genus: '',
  species: '',
  tempName: '大黑步甲',
  collectDate: '2026-06-01',
  collector: '陆昀',
  sex: '雄',
  stage: '成虫',
  bodyLength: 28.4,
  method: '扫网',
  quantity: 1,
  status: '待鉴定',
  determiner: '',
  siteId: 'site_a',
  note: '',
  ...over
})

const makeDetermination = (over: Partial<Determination> = {}): Determination => ({
  id: 'det_a',
  specimenId: 'sp_a',
  determiner: '覃羽',
  date: '2026-06-03',
  conclusion: 'Carabus smaragdinus',
  reference: '',
  confidence: '高',
  needReview: false,
  ...over
})

const makeStorage = (over: Partial<Storage> = {}): Storage => ({
  id: 'stg_a',
  specimenId: 'sp_a',
  method: '针插',
  cabinet: 'C01',
  drawer: 1,
  box: 2,
  slot: 3,
  storedDate: '2026-06-04',
  handler: '覃羽',
  ...over
})

const makeLocal = (over: Partial<LocalData> = {}): LocalData => ({
  sites: [],
  specimens: [],
  determinations: [],
  storages: [],
  ...over
})

const makePkg = (over: Partial<ParsedPackage> = {}): ParsedPackage => ({
  format: 'handoff',
  exportedAt: '2026-06-05T08:00:00.000Z',
  sites: [],
  specimens: [],
  determinations: [],
  storages: [],
  base: emptySnapshots(),
  warnings: [],
  ...over
})

describe('buildMergePlan', () => {
  it('全新数据：采集地 / 标本 / 鉴定 / 保藏全部新增，标本 siteId 重映射到新增采集地', () => {
    const plan = buildMergePlan(
      makeLocal(),
      makePkg({
        sites: [makeSite()],
        specimens: [makeSpecimen()],
        determinations: [makeDetermination()],
        storages: [makeStorage()]
      })
    )
    expect(plan.stats.inserts).toBe(4)
    expect(plan.conflicts).toHaveLength(0)
    const specimenOp = plan.ops.find((op) => op.table === 'specimens')
    const siteOp = plan.ops.find((op) => op.table === 'sites')
    expect(siteOp?.action).toBe('insert')
    expect((specimenOp?.row as Specimen).siteId).toBe(siteOp?.id)
    // 标本编号照旧
    expect((specimenOp?.row as Specimen).code).toBe('QLB-2026-0001')
  })

  it('标本编号相同即同一份：无基线时字段差异列入对照，保藏位置暂缓', () => {
    const plan = buildMergePlan(
      makeLocal({ specimens: [makeSpecimen({ note: '馆内备注' })] }),
      makePkg({
        specimens: [makeSpecimen({ note: '野外备注' })],
        storages: [makeStorage()]
      })
    )
    expect(plan.stats.inserts).toBe(0)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].field).toBe('note')
    expect(plan.conflicts[0].localValue).toBe('馆内备注')
    expect(plan.conflicts[0].incomingValue).toBe('野外备注')
    expect(plan.pendingCount).toBe(1)
    expect(plan.blockedCount).toBe(1)
    // 处理前不进保藏位置
    expect(plan.ops.some((op) => op.table === 'storages')).toBe(false)
    expect(plan.notes.some((note) => note.includes('暂缓'))).toBe(true)
  })

  it('有基线时只接单边变化：仅交接包改过的字段自动合并', () => {
    const base = emptySnapshots()
    base.specimens.sp_a = makeSpecimen({ note: '原始备注' })
    const plan = buildMergePlan(
      makeLocal({ specimens: [makeSpecimen({ note: '原始备注' })] }),
      makePkg({ specimens: [makeSpecimen({ note: '野外补充' })], base })
    )
    expect(plan.conflicts).toHaveLength(0)
    const update = plan.ops.find((op) => op.table === 'specimens' && op.action === 'update')
    expect(update?.patch).toEqual({ note: '野外补充' })
  })

  it('有基线时仅馆内改过：保留馆内，不产生任何操作', () => {
    const base = emptySnapshots()
    base.specimens.sp_a = makeSpecimen({ note: '原始备注' })
    const plan = buildMergePlan(
      makeLocal({ specimens: [makeSpecimen({ note: '馆内修订' })] }),
      makePkg({ specimens: [makeSpecimen({ note: '原始备注' })], base })
    )
    expect(plan.ops).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
  })

  it('双边都改过且值不同：列入对照，选边后按选定值合并', () => {
    const base = emptySnapshots()
    base.specimens.sp_a = makeSpecimen({ note: '原始备注' })
    const incoming = makePkg({ specimens: [makeSpecimen({ note: '野外版' })], base })
    const local = makeLocal({ specimens: [makeSpecimen({ note: '馆内版' })] })

    const plan = buildMergePlan(local, incoming)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.ops).toHaveLength(0)

    const key = plan.conflicts[0].key
    const resolved = buildMergePlan(local, incoming, { [key]: 'incoming' })
    expect(resolved.pendingCount).toBe(0)
    const update = resolved.ops.find((op) => op.table === 'specimens')
    expect(update?.patch).toEqual({ note: '野外版' })

    const keepLocal = buildMergePlan(local, incoming, { [key]: 'local' })
    expect(keepLocal.pendingCount).toBe(0)
    expect(keepLocal.ops).toHaveLength(0)
  })

  it('采集地按坐标认到同一处：代码不同也合并，代码以馆内为准', () => {
    const plan = buildMergePlan(
      makeLocal({ sites: [makeSite()] }),
      makePkg({
        sites: [makeSite({ id: 'site_x', code: 'NEW', name: '野外新名', latitude: 25.81231, longitude: 107.21361 })],
        specimens: [makeSpecimen({ siteId: 'site_x' })]
      })
    )
    // 不新增采集地
    expect(plan.ops.some((op) => op.table === 'sites' && op.action === 'insert')).toBe(false)
    expect(plan.notes.some((note) => note.includes('代码以馆内为准'))).toBe(true)
    // 包内标本改挂馆内采集地
    const specimenOp = plan.ops.find((op) => op.table === 'specimens')
    expect((specimenOp?.row as Specimen).siteId).toBe('site_a')
  })

  it('柜位被其他标本占用：保藏位置跳过，绝不一柜两位', () => {
    const plan = buildMergePlan(
      makeLocal({
        specimens: [makeSpecimen({ id: 'sp_b', code: 'QLB-2026-0002' })],
        storages: [makeStorage({ id: 'stg_b', specimenId: 'sp_b' })]
      }),
      makePkg({
        specimens: [makeSpecimen()],
        storages: [makeStorage()]
      })
    )
    expect(plan.ops.some((op) => op.table === 'storages')).toBe(false)
    expect(plan.notes.some((note) => note.includes('占用'))).toBe(true)
  })

  it('鉴定记录按业务键认领：id 不同也不重复建档', () => {
    const plan = buildMergePlan(
      makeLocal({
        specimens: [makeSpecimen()],
        determinations: [makeDetermination({ id: 'det_local' })]
      }),
      makePkg({ determinations: [makeDetermination()] })
    )
    expect(plan.ops).toHaveLength(0)
  })

  it('旧备份缺字段（如 v1 无采集方式）：缺失字段不覆盖、不报冲突', () => {
    const legacySpecimen = makeSpecimen() as unknown as Record<string, unknown>
    delete legacySpecimen.method
    const plan = buildMergePlan(
      makeLocal({ specimens: [makeSpecimen({ method: '灯诱' })] }),
      makePkg({ format: 'legacy', specimens: [legacySpecimen as unknown as Specimen] })
    )
    expect(plan.conflicts.every((conflict) => conflict.field !== 'method')).toBe(true)
    expect(plan.ops).toHaveLength(0)
  })

  it('冲突解决后，暂缓的保藏位置进入可执行计划', () => {
    const incoming = makePkg({
      specimens: [makeSpecimen({ note: '野外备注' })],
      storages: [makeStorage()]
    })
    const local = makeLocal({ specimens: [makeSpecimen({ note: '馆内备注' })] })
    const first = buildMergePlan(local, incoming)
    const key = first.conflicts[0].key
    const resolved = buildMergePlan(local, incoming, { [key]: 'incoming' })
    expect(resolved.blockedCount).toBe(0)
    expect(resolved.ops.some((op) => op.table === 'storages' && op.action === 'insert')).toBe(true)
  })
})
