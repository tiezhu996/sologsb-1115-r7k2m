import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Determination, Specimen, Storage } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import {
  advanceSyncBase,
  buildHandoffPackage,
  loadLocalData,
  parsePackage,
  snapshotAll,
  writeSyncBase
} from '@/utils/handoff'
import { buildMergePlan } from '@/utils/mergePlan'
import { createMergeJob, runMergeJob } from '@/utils/mergeApply'

const seedMuseum = async (): Promise<void> => {
  await db.sites.put({
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
    dateEnd: '2026-06-02'
  })
  await db.specimens.put({
    id: 'sp_1',
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
    note: '原始备注'
  } satisfies Specimen)
  await db.determinations.put({
    id: 'det_1',
    specimenId: 'sp_1',
    determiner: '覃羽',
    date: '2026-06-03',
    conclusion: 'Carabus sp.',
    reference: '',
    confidence: '中',
    needReview: false
  } satisfies Determination)
  await db.storages.put({
    id: 'stg_1',
    specimenId: 'sp_1',
    method: '针插',
    cabinet: 'C01',
    drawer: 1,
    box: 2,
    slot: 3,
    storedDate: '2026-06-04',
    handler: '覃羽'
  } satisfies Storage)
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('交接包端到端：导出 → 双方修改 → 合并 → 重跑', () => {
  it('单边变化自动合并，双边变化进对照，执行后重跑幂等', async () => {
    await seedMuseum()
    // 野外队带着副本出发：首次导出建立同步基线
    await advanceSyncBase()

    // 回馆后导出交接包（带基线），模拟文件读写
    const pkg = buildHandoffPackage().then((data) => JSON.stringify(data))
    const parsed = parsePackage(await pkg)
    expect(parsed.format).toBe('handoff')
    expect(Object.keys(parsed.base.specimens)).toContain('sp_1')

    // 野外修改：note 改一次；新增一份标本及其保藏位置
    const fieldSpecimen: Specimen = {
      ...(parsed.specimens[0] as Specimen),
      note: '野外补充'
    }
    const newSpecimen: Specimen = { ...fieldSpecimen, id: 'sp_2', code: 'QLB-2026-0002', note: '新采' }
    parsed.specimens[0] = fieldSpecimen
    parsed.specimens.push(newSpecimen)
    parsed.storages.push({ ...parsed.storages[0], id: 'stg_2', specimenId: 'sp_2', slot: 4 } as Storage)

    // 馆内修改：family 改一次（单边）；note 也改（与野外双边冲突）
    await db.specimens.update('sp_1', { family: '大步甲属复核', note: '馆内修订' })

    const local = await loadLocalData()
    const plan = buildMergePlan(local, parsed)
    // 双边改 note → 1 处冲突；family 仅馆内改 → 不动；野外新增 → insert
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].field).toBe('note')
    expect(plan.ops.some((op) => op.id === 'sp_2' && op.action === 'insert')).toBe(true)
    // sp_2 是新增标本、无冲突，其保藏位置（空柜位）可随批入柜
    expect(plan.ops.some((op) => op.table === 'storages' && op.id === 'stg_2')).toBe(true)

    // 选边后执行
    const key = plan.conflicts[0].key
    const resolved = buildMergePlan(local, parsed, { [key]: 'incoming' })
    const job = await createMergeJob('交接包.json', resolved.ops, resolved.notes)
    const done = await runMergeJob(job.jobId)
    expect(done.status).toBe('done')

    const sp1 = (await db.specimens.get('sp_1')) as Specimen
    expect(sp1.note).toBe('野外补充') // 选「用交接包」
    expect(sp1.family).toBe('大步甲属复核') // 馆内单边修改保留
    expect(await db.specimens.get('sp_2')).toBeDefined()
    expect(await db.storages.get('stg_2')).toBeDefined()
    expect(await db.specimens.count()).toBe(2)
    expect(await db.storages.count()).toBe(2)

    // 重跑同一批次：直接返回 done，不产生重复数据
    const again = await runMergeJob(job.jobId)
    expect(again.status).toBe('done')
    expect(await db.specimens.count()).toBe(2)

    // 合并完成后推进基线，再对同一包重新计划：无剩余变更
    await writeSyncBase(snapshotAll(await loadLocalData()))
    const after = buildMergePlan(await loadLocalData(), parsed)
    expect(after.ops).toHaveLength(0)
    expect(after.pendingCount).toBe(0)
  })
})
