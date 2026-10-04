import { useEffect, useMemo, useRef, useState } from 'react'
import type { MergeJob } from '@/types/merge'
import { siteStore } from '@/stores/siteStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { determinationStore } from '@/stores/determinationStore'
import {
  advanceSyncBase,
  buildHandoffPackage,
  loadLocalData,
  parsePackage,
  type LocalData,
  type ParsedPackage
} from '@/utils/handoff'
import { buildMergePlan, FIELD_LABELS, type Resolutions } from '@/utils/mergePlan'
import { createMergeJob, discardMergeJob, loadJob, loadPendingJob, runMergeJob } from '@/utils/mergeApply'
import { downloadJson } from '@/utils/export'

function fileStamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** 交接包合并：野外导出离线包，回馆并入台账（三路合并 + 冲突对照 + 断点恢复） */
export default function HandoffPage(): JSX.Element {
  const [parsed, setParsed] = useState<ParsedPackage | null>(null)
  const [fileName, setFileName] = useState('')
  const [local, setLocal] = useState<LocalData | null>(null)
  const [resolutions, setResolutions] = useState<Resolutions>({})
  const [job, setJob] = useState<MergeJob | null>(null)
  const [pendingJob, setPendingJob] = useState<MergeJob | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ applied: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadPendingJob().then((found) => setPendingJob(found ?? null))
  }, [])

  const plan = useMemo(
    () => (parsed && local ? buildMergePlan(local, parsed, resolutions) : null),
    [parsed, local, resolutions]
  )

  /** 冲突对照里的采集地 id → 代码+名称 */
  const siteLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const site of local?.sites ?? []) map.set(site.id, `${site.code} ${site.name}`)
    for (const site of parsed?.sites ?? []) {
      if (!map.has(site.id)) map.set(site.id, `${site.code} ${site.name}（包内）`)
    }
    return map
  }, [local, parsed])

  const formatValue = (field: string, value: unknown): string => {
    if (value === undefined || value === null || value === '') return '（空）'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (field === 'siteId') return siteLabels.get(String(value)) ?? String(value)
    return String(value)
  }

  const refreshStores = async (): Promise<void> => {
    await siteStore.getState().hydrate()
    await specimenStore.getState().hydrate()
    await storageStore.getState().hydrate()
    await determinationStore.getState().hydrate()
  }

  const doExport = async (): Promise<void> => {
    setError('')
    const pkg = await buildHandoffPackage()
    downloadJson(`交接包-${fileStamp()}.json`, pkg)
    await advanceSyncBase()
    setMessage(
      `交接包已导出：标本 ${pkg.specimens.length} 份、采集地 ${pkg.sites.length} 处、鉴定 ${pkg.determinations.length} 条、保藏 ${pkg.storages.length} 条`
    )
  }

  const onFile = async (file: File): Promise<void> => {
    setError('')
    setMessage('')
    setJob(null)
    try {
      const pkg = parsePackage(await file.text())
      const localData = await loadLocalData()
      setParsed(pkg)
      setLocal(localData)
      setFileName(file.name)
      setResolutions({})
      setProgress(null)
    } catch (err) {
      setParsed(null)
      setLocal(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 执行（或断点恢复）一个批次，完成后推进同步基线并刷新台账 */
  const runAndReport = async (jobId: string): Promise<void> => {
    setRunning(true)
    setError('')
    try {
      const done = await runMergeJob(jobId, (applied, total) => setProgress({ applied, total }))
      setJob(done)
      await advanceSyncBase()
      await refreshStores()
      if (parsed) setLocal(await loadLocalData())
      setPendingJob(null)
      setMessage(
        `合并完成：新增 ${done.inserted} 条、更新 ${done.updated} 条` +
          (done.duplicates > 0 ? `、已存在跳过 ${done.duplicates} 条` : '') +
          (done.slotSkipped > 0 ? `、柜位被占跳过 ${done.slotSkipped} 条` : '')
      )
    } catch (err) {
      const failed = await loadJob(jobId)
      if (failed) setJob(failed)
      setError(
        `合并中断：${err instanceof Error ? err.message : String(err)}。` +
          `已应用 ${failed?.applied ?? 0} 条，点击「重试」从断点继续，不会重复建档或重复占柜。`
      )
    } finally {
      setRunning(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!plan || plan.ops.length === 0) return
    const created = await createMergeJob(fileName, plan.ops, plan.notes)
    setJob(created)
    await runAndReport(created.jobId)
  }

  const resolveAll = (side: 'local' | 'incoming'): void => {
    if (!plan) return
    const next: Resolutions = { ...resolutions }
    for (const conflict of plan.conflicts) next[conflict.key] = side
    setResolutions(next)
  }

  const discardPending = async (): Promise<void> => {
    if (!pendingJob) return
    await discardMergeJob(pendingJob.jobId)
    setPendingJob(null)
    setMessage('已放弃未完成的合并批次（已写入的数据保留，不会重复）')
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">交接包合并</h1>
        <p className="page-sub">
          野外队导出离线交接包，回馆后直接并入现有台账：采集地按代码与坐标认到同一处，标本编号照旧；
          两边都改过的字段先列来源对照，处理前不进保藏位置；写库中断可断点重试，不会重复建档或占两个柜位。
        </p>
      </header>

      {pendingJob ? (
        <section className="panel flex flex-wrap items-center gap-3 border-amber-300 bg-amber-50">
          <p className="text-sm text-amber-800">
            有未完成的合并批次「{pendingJob.packageName}」（{pendingJob.createdAt.slice(0, 19).replace('T', ' ')}）， 已应用{' '}
            {pendingJob.applied}/{pendingJob.ops.length} 条
            {pendingJob.status === 'failed' ? `，上次中断：${pendingJob.error ?? '未知原因'}` : ''}。
          </p>
          <button
            className="btn-primary"
            type="button"
            disabled={running}
            onClick={() => void runAndReport(pendingJob.jobId)}
          >
            从断点继续
          </button>
          <button className="btn-ghost" type="button" disabled={running} onClick={() => void discardPending()}>
            放弃该批次
          </button>
        </section>
      ) : null}

      <section className="panel flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800">导出交接包（野外队）</h2>
          <p className="text-xs text-slate-500">
            打包采集地、标本、鉴定记录与保藏位置，附带同步基线，供回馆后三路合并。
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={() => void doExport()}>
          导出交接包
        </button>
      </section>

      <section className="panel flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800">导入合并（回馆）</h2>
          <p className="text-xs text-slate-500">
            选择交接包 JSON；旧备份文件同样兼容，只是没有同步基线，差异字段会全部列入对照。
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onFile(file)
            e.target.value = ''
          }}
        />
        <button className="btn-primary" type="button" onClick={() => fileRef.current?.click()}>
          选择交接包文件
        </button>
        {fileName ? <span className="text-xs text-slate-500">{fileName}</span> : null}
      </section>

      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      {message ? <p className="rounded-lg border border-field-200 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      {parsed && plan ? (
        <>
          <section className="panel flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-700">
              <span>
                包类型：
                {parsed.format === 'handoff' ? (
                  <b className="text-field-700">交接包 v1</b>
                ) : (
                  <b className="text-amber-700">旧备份（无同步基线）</b>
                )}
              </span>
              {parsed.exportedAt ? <span>导出时间：{parsed.exportedAt.slice(0, 19).replace('T', ' ')}</span> : null}
              <span>
                包内：采集地 {parsed.sites.length} · 标本 {parsed.specimens.length} · 鉴定 {parsed.determinations.length} · 保藏{' '}
                {parsed.storages.length}
              </span>
            </div>
            {parsed.format === 'legacy' ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                旧备份没有同步基线，无法区分单边 / 双边修改：凡与馆内不同的字段都会列入下方对照表，需人工选边后才写入。
              </p>
            ) : null}
            {parsed.warnings.map((warning) => (
              <p key={warning} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {warning}
              </p>
            ))}
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">新增 {plan.stats.inserts} 条</span>
              <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">更新 {plan.stats.updates} 条</span>
              <span
                className={`rounded-full px-3 py-1 ${
                  plan.pendingCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'
                }`}
              >
                冲突 {plan.conflicts.length} 处（未解决 {plan.pendingCount}）
              </span>
              {plan.blockedCount > 0 ? (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">
                  暂缓入柜 {plan.blockedCount} 份标本
                </span>
              ) : null}
            </div>
          </section>

          {plan.conflicts.length > 0 ? (
            <section className="panel flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-800">来源对照：同一字段的两份值</h2>
                <span className="text-xs text-slate-500">逐项选边后才写入；未解决的标本暂缓入柜。</span>
                <span className="ml-auto flex gap-2">
                  <button className="btn-ghost" type="button" onClick={() => resolveAll('local')}>
                    全部留馆内
                  </button>
                  <button className="btn-ghost" type="button" onClick={() => resolveAll('incoming')}>
                    全部用交接包
                  </button>
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium">记录</th>
                      <th className="py-2 pr-3 font-medium">字段</th>
                      <th className="py-2 pr-3 font-medium">馆内值</th>
                      <th className="py-2 pr-3 font-medium">交接包值</th>
                      <th className="py-2 font-medium">处理</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.conflicts.map((conflict) => (
                      <tr
                        key={conflict.key}
                        className={`border-b border-slate-100 ${conflict.resolved === undefined ? 'bg-amber-50/60' : ''}`}
                      >
                        <td className="py-2 pr-3 text-xs text-slate-600">{conflict.label}</td>
                        <td className="py-2 pr-3 text-xs font-medium text-slate-700">
                          {FIELD_LABELS[conflict.field] ?? conflict.field}
                        </td>
                        <td className="max-w-[220px] break-all py-2 pr-3 text-xs">
                          {formatValue(conflict.field, conflict.localValue)}
                        </td>
                        <td className="max-w-[220px] break-all py-2 pr-3 text-xs">
                          {formatValue(conflict.field, conflict.incomingValue)}
                        </td>
                        <td className="py-2">
                          <span className="flex gap-3 text-xs">
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="radio"
                                name={conflict.key}
                                checked={conflict.resolved === 'local'}
                                onChange={() => setResolutions((prev) => ({ ...prev, [conflict.key]: 'local' }))}
                              />
                              留馆内
                            </label>
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="radio"
                                name={conflict.key}
                                checked={conflict.resolved === 'incoming'}
                                onChange={() => setResolutions((prev) => ({ ...prev, [conflict.key]: 'incoming' }))}
                              />
                              用交接包
                            </label>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {plan.notes.length > 0 ? (
            <section className="panel flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-slate-800">跳过与暂缓</h2>
              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
                {plan.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel flex flex-wrap items-center gap-3">
            <button
              className="btn-primary"
              type="button"
              disabled={running || plan.ops.length === 0}
              onClick={() => void execute()}
            >
              执行合并（{plan.ops.length} 条变更）
            </button>
            {plan.pendingCount > 0 ? (
              <span className="text-xs text-amber-700">
                还有 {plan.pendingCount} 处冲突未选边：涉及标本的保藏位置将暂缓，可先合并无争议部分。
              </span>
            ) : null}
            {plan.ops.length === 0 && plan.pendingCount === 0 ? (
              <span className="text-xs text-slate-500">包内数据与馆内一致，没有需要写入的变更。</span>
            ) : null}
            {running && progress ? (
              <span className="text-sm text-field-700">
                正在写入 {progress.applied}/{progress.total} …
              </span>
            ) : null}
          </section>
        </>
      ) : null}

      {job && job.status !== 'applying' ? (
        <section className="panel flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-800">
            {job.status === 'done' ? '合并报告' : '中断批次'}：{job.packageName}
          </h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">新增 {job.inserted}</span>
            <span className="rounded-full bg-field-50 px-3 py-1 text-field-700">更新 {job.updated}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">已存在跳过 {job.duplicates}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">柜位被占跳过 {job.slotSkipped}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
              进度 {job.applied}/{job.ops.length}
            </span>
          </div>
          {job.status === 'failed' ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-rose-600">中断原因：{job.error ?? '未知'}</p>
              <button className="btn-primary" type="button" disabled={running} onClick={() => void runAndReport(job.jobId)}>
                重试（从断点继续）
              </button>
            </div>
          ) : null}
          {job.notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
              {job.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
