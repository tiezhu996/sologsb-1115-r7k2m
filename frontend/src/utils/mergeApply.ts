import type { CollectSite, Determination, Specimen, Storage } from '@/types'
import { findNearbySites } from '@/types'
import type { MergeJob, MergeOp } from '@/types/merge'
import { db } from '@/hooks/usePersistentStore'
import { storageSlotText } from '@/utils/codec'
import { uid } from '@/utils/id'

type OpOutcome = 'inserted' | 'updated' | 'duplicate' | 'slot-skipped'

/** 新建合并批次并持久化（此时不写任何业务数据） */
export async function createMergeJob(packageName: string, ops: MergeOp[], notes: string[]): Promise<MergeJob> {
  const job: MergeJob = {
    jobId: uid('job'),
    packageName,
    createdAt: new Date().toISOString(),
    status: 'applying',
    ops,
    applied: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    slotSkipped: 0,
    notes
  }
  await db.mergeJobs.put(job)
  return job
}

/** 找出最近一个未完成的批次（中断恢复入口） */
export async function loadPendingJob(): Promise<MergeJob | undefined> {
  const jobs = await db.mergeJobs.toArray()
  return jobs
    .filter((job) => job.status !== 'done')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

export async function loadJob(jobId: string): Promise<MergeJob | undefined> {
  return db.mergeJobs.get(jobId)
}

/** 放弃未完成的批次（不动业务数据，仅清理批次记录） */
export async function discardMergeJob(jobId: string): Promise<void> {
  await db.mergeJobs.delete(jobId)
}

/** 应用一条操作；重复执行安全（按业务键查重 / 柜位查占用） */
async function applyOp(op: MergeOp): Promise<OpOutcome> {
  switch (op.table) {
    case 'sites':
      return db.transaction('rw', db.sites, async () => {
        if (op.action === 'insert') {
          const row = op.row as CollectSite
          const all = await db.sites.toArray()
          const duplicate =
            all.find((site) => site.code.trim().toUpperCase() === row.code.trim().toUpperCase()) ??
            findNearbySites(all, row.latitude, row.longitude, 50)[0]?.site
          if (duplicate) return 'duplicate'
          await db.sites.put(row)
          return 'inserted'
        }
        const changed = await db.sites.where('id').equals(op.id).modify(op.patch ?? {})
        return changed > 0 ? 'updated' : 'duplicate'
      })

    case 'specimens':
      return db.transaction('rw', db.specimens, async () => {
        if (op.action === 'insert') {
          const row = op.row as Specimen
          // 标本编号照旧：同编号即同一份，绝不重复建档
          const existing = await db.specimens.where('code').equalsIgnoreCase(row.code).first()
          if (existing) return 'duplicate'
          await db.specimens.put(row)
          return 'inserted'
        }
        const changed = await db.specimens.where('id').equals(op.id).modify(op.patch ?? {})
        return changed > 0 ? 'updated' : 'duplicate'
      })

    case 'determinations':
      return db.transaction('rw', db.determinations, async () => {
        if (op.action === 'insert') {
          const row = op.row as Determination
          const siblings = await db.determinations.where('specimenId').equals(row.specimenId).toArray()
          const duplicate = siblings.some(
            (item) =>
              item.determiner === row.determiner && item.date === row.date && item.conclusion === row.conclusion
          )
          if (duplicate) return 'duplicate'
          await db.determinations.put(row)
          return 'inserted'
        }
        const changed = await db.determinations.where('id').equals(op.id).modify(op.patch ?? {})
        return changed > 0 ? 'updated' : 'duplicate'
      })

    case 'storages':
      return db.transaction('rw', db.storages, async () => {
        const all = await db.storages.toArray()
        if (op.action === 'insert') {
          const row = op.row as Storage
          if (all.some((item) => item.specimenId === row.specimenId)) return 'duplicate'
          const slotKey = storageSlotText(row)
          if (all.some((item) => item.specimenId !== row.specimenId && storageSlotText(item) === slotKey)) {
            return 'slot-skipped'
          }
          await db.storages.put(row)
          return 'inserted'
        }
        const current = all.find((item) => item.id === op.id)
        if (!current) return 'duplicate'
        const target = { ...current, ...(op.patch ?? {}) } as Storage
        const slotKey = storageSlotText(target)
        if (all.some((item) => item.specimenId !== target.specimenId && storageSlotText(item) === slotKey)) {
          return 'slot-skipped'
        }
        await db.storages.put(target)
        return 'updated'
      })
  }
}

/**
 * 执行（或断点恢复）合并批次：
 * 逐条应用操作，每应用一条就把进度写回 mergeJobs；
 * 中途失败时批次标记 failed，重试从 applied 处继续，
 * 已成功的操作靠业务键查重幂等跳过，不会重复建档或占两个柜位。
 */
export async function runMergeJob(
  jobId: string,
  onProgress?: (applied: number, total: number) => void
): Promise<MergeJob> {
  const job = await db.mergeJobs.get(jobId)
  if (!job) throw new Error('合并批次不存在或已被清理')
  if (job.status === 'done') return job

  const persist = async (patch: Partial<MergeJob>): Promise<void> => {
    await db.mergeJobs.update(jobId, patch)
    Object.assign(job, patch)
  }
  await persist({ status: 'applying', error: undefined })

  let { inserted, updated, duplicates, slotSkipped } = job
  try {
    for (let index = job.applied; index < job.ops.length; index += 1) {
      const outcome = await applyOp(job.ops[index])
      if (outcome === 'inserted') inserted += 1
      else if (outcome === 'updated') updated += 1
      else if (outcome === 'duplicate') duplicates += 1
      else if (outcome === 'slot-skipped') slotSkipped += 1
      await persist({ applied: index + 1, inserted, updated, duplicates, slotSkipped })
      onProgress?.(index + 1, job.ops.length)
    }
    await persist({ status: 'done', finishedAt: new Date().toISOString() })
  } catch (error) {
    await persist({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  return job
}
