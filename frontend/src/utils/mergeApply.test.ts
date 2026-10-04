import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Specimen, Storage } from '@/types'
import type { MergeOp } from '@/types/merge'
import { db } from '@/hooks/usePersistentStore'
import { createMergeJob, loadPendingJob, runMergeJob } from '@/utils/mergeApply'

const makeSpecimen = (id: string, code: string, over: Partial<Specimen> = {}): Specimen => ({
  id,
  code,
  order: '鞘翅目',
  family: '步甲科',
  genus: '',
  species: '',
  tempName: '',
  collectDate: '2026-06-01',
  collector: '陆昀',
  sex: '雄',
  stage: '成虫',
  bodyLength: 20,
  method: '扫网',
  quantity: 1,
  status: '待鉴定',
  determiner: '',
  siteId: 'site_a',
  note: '',
  ...over
})

const makeStorage = (id: string, specimenId: string, over: Partial<Storage> = {}): Storage => ({
  id,
  specimenId,
  method: '针插',
  cabinet: 'C01',
  drawer: 1,
  box: 2,
  slot: 3,
  storedDate: '2026-06-04',
  handler: '覃羽',
  ...over
})

const insertSpecimen = (specimen: Specimen): MergeOp => ({
  table: 'specimens',
  action: 'insert',
  id: specimen.id,
  row: specimen,
  label: `标本 ${specimen.code}`
})

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('runMergeJob', () => {
  it('应用 insert / update 并记录进度，完成后状态 done', async () => {
    await db.specimens.put(makeSpecimen('sp_old', 'QLB-2026-0001'))
    const job = await createMergeJob('交接包.json', [
      insertSpecimen(makeSpecimen('sp_new', 'QLB-2026-0002')),
      { table: 'specimens', action: 'update', id: 'sp_old', patch: { note: '野外补充' }, label: '标本 QLB-2026-0001' }
    ], [])

    const done = await runMergeJob(job.jobId)
    expect(done.status).toBe('done')
    expect(done.applied).toBe(2)
    expect(done.inserted).toBe(1)
    expect(done.updated).toBe(1)
    expect(await db.specimens.count()).toBe(2)
    expect((await db.specimens.get('sp_old'))?.note).toBe('野外补充')
  })

  it('幂等：同编号标本已存在时跳过，不重复建档', async () => {
    await db.specimens.put(makeSpecimen('sp_local', 'QLB-2026-0001'))
    const job = await createMergeJob('交接包.json', [
      insertSpecimen(makeSpecimen('sp_other', 'QLB-2026-0001', { note: '包内版本' }))
    ], [])

    const done = await runMergeJob(job.jobId)
    expect(done.duplicates).toBe(1)
    expect(done.inserted).toBe(0)
    expect(await db.specimens.count()).toBe(1)
    // 馆内记录不被覆盖
    expect((await db.specimens.get('sp_local'))?.note).toBe('')
  })

  it('写库失败后可从断点恢复重试，已应用的不会重复执行', async () => {
    const badRow = { ...makeSpecimen('sp_bad', 'QLB-2026-0002') } as Record<string, unknown>
    delete badRow.id // 缺主键，put 必失败，用来模拟写库中断
    const job = await createMergeJob('交接包.json', [
      insertSpecimen(makeSpecimen('sp_a', 'QLB-2026-0001')),
      { table: 'specimens', action: 'insert', id: 'sp_bad', row: badRow as unknown as Specimen, label: '坏记录' },
      insertSpecimen(makeSpecimen('sp_b', 'QLB-2026-0003'))
    ], [])

    await expect(runMergeJob(job.jobId)).rejects.toThrow()
    let stalled = await db.mergeJobs.get(job.jobId)
    expect(stalled?.status).toBe('failed')
    expect(stalled?.applied).toBe(1)
    expect(await db.specimens.count()).toBe(1) // 只有第一条落库

    // 修好坏记录后重试：从第 2 条继续，第一条不重跑
    const fixed = await db.mergeJobs.get(job.jobId)
    fixed!.ops[1] = insertSpecimen(makeSpecimen('sp_bad', 'QLB-2026-0002'))
    await db.mergeJobs.put(fixed!)

    const done = await runMergeJob(job.jobId)
    expect(done.status).toBe('done')
    expect(done.applied).toBe(3)
    expect(done.inserted).toBe(3) // 计数含首轮已写的 1 条
    expect(done.duplicates).toBe(0)
    expect(await db.specimens.count()).toBe(3)
    stalled = await db.mergeJobs.get(job.jobId)
    expect(stalled?.status).toBe('done')
  })

  it('柜位被其他标本占用：保藏位置跳过，绝不一柜两位', async () => {
    await db.specimens.put(makeSpecimen('sp_x', 'QLB-2026-0001'))
    await db.storages.put(makeStorage('stg_x', 'sp_x'))
    const job = await createMergeJob('交接包.json', [
      {
        table: 'storages',
        action: 'insert',
        id: 'stg_new',
        row: makeStorage('stg_new', 'sp_y'), // 同一柜位 C01-D1-B02-S03
        label: '保藏 QLB-2026-0002'
      }
    ], [])

    const done = await runMergeJob(job.jobId)
    expect(done.slotSkipped).toBe(1)
    expect(done.inserted).toBe(0)
    expect(await db.storages.count()).toBe(1)
    expect((await db.storages.get('stg_x'))?.specimenId).toBe('sp_x')
  })

  it('loadPendingJob 只返回未完成的批次', async () => {
    const done = await createMergeJob('已完成.json', [], [])
    await runMergeJob(done.jobId)
    const stalled = await createMergeJob('未完成.json', [insertSpecimen(makeSpecimen('sp_a', 'QLB-2026-0001'))], [])

    const pending = await loadPendingJob()
    expect(pending?.jobId).toBe(stalled.jobId)
    expect(pending?.packageName).toBe('未完成.json')
  })
})
