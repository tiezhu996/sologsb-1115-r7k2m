import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { siteStore } from '@/stores/siteStore'
import { storageStore } from '@/stores/storageStore'
import { determinationStore } from '@/stores/determinationStore'
import type { EntityKind, EntityPlan, MergeJob, MergePlan, Snapshot } from '@/types/merge'
import { NEW_SITE, formatConflictValue } from '@/types/merge'
import { downloadJson } from '@/utils/export'
import {
  applyMerge,
  buildBundle,
  createMergeJob,
  loadBaseline,
  loadLocalSnapshot,
  parseBundle,
  prepareMerge,
  saveBaseline,
  saveFieldResolution,
  saveSiteMatchResolution,
  updateMergeJob
} from '@/utils/merge'

type Tab = 'field' | 'office'

const ACTION_TEXT: Record<EntityPlan['action'], string> = {
  insert: '新增',
  update: '更新',
  unchanged: '一致',
  skip: '暂缓'
}

const ACTION_STYLE: Record<EntityPlan['action'], string> = {
  insert: 'bg-field-50 text-field-700',
  update: 'bg-blue-50 text-blue-700',
  unchanged: 'bg-slate-100 text-slate-500',
  skip: 'bg-amber-50 text-amber-700'
}

const KIND_TABS: { kind: EntityKind; title: string }[] = [
  { kind: 'site', title: '采集地' },
  { kind: 'specimen', title: '标本' },
  { kind: 'determination', title: '鉴定记录' },
  { kind: 'storage', title: '保藏位置' }
]

function timestampName(prefix: string, suffix: string): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${suffix}`
}

/** 离线交接：野外端导出交接包；回馆后按基线三方合并，冲突列对照，写库可恢复重试 */
export default function MergePage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('office')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">离线交接包</h1>
        <p className="page-sub">
          野外机导入馆内基线后离线录入，回馆导出交接包；合并时采集地按代码与坐标（≤50 米）认同，标本编号照旧；
          同一字段两边都改先列来源对照，处理前不进保藏位置；写库失败可恢复重试，不重复建档、不占两个柜位。
        </p>
      </header>

      <div className="flex gap-2">
        <button
          type="button"
          className={tab === 'field' ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setTab('field')}
        >
          野外端：导入基线 / 导出交接包
        </button>
        <button
          type="button"
          className={tab === 'office' ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setTab('office')}
        >
          回馆：合并到本台账
        </button>
      </div>

      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}
      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      {tab === 'field' ? <FieldPanel onMessage={setMessage} onError={setError} /> : <OfficePanel onMessage={setMessage} onError={setError} />}
    </div>
  )
}

/* --------------------------------- 野外端 --------------------------------- */

function FieldPanel({
  onMessage,
  onError
}: {
  onMessage: (text: string) => void
  onError: (text: string) => void
}): JSX.Element {
  const [baselineInfo, setBaselineInfo] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshBaseline = async (): Promise<void> => {
    const row = await loadBaseline()
    setBaselineInfo(
      row
        ? `已保存出队基线：${row.origin} · 导出于 ${row.exportedAt.slice(0, 10)}（采集地 ${row.snapshot.sites.length} / 标本 ${row.snapshot.specimens.length}）`
        : '尚未导入馆内基线：建议出队前先导入，回馆才能识别单边变化'
    )
  }

  useEffect(() => {
    void refreshBaseline()
  }, [])

  const importBaseline = async (file: File): Promise<void> => {
    try {
      const bundle = parseBundle(JSON.parse(await file.text()))
      const snapshot: Snapshot = {
        sites: bundle.sites,
        specimens: bundle.specimens,
        determinations: bundle.determinations,
        storages: bundle.storages
      }
      await saveBaseline(snapshot, { exportedAt: bundle.exportedAt, origin: file.name })
      onMessage(`基线「${file.name}」已保存到本机，离线录入后导出交接包会自动内嵌`)
      await refreshBaseline()
    } catch (err) {
      onError(`基线导入失败：${err instanceof Error ? err.message : '文件无法解析'}（旧备份文件同样可用）`)
    }
  }

  const exportHandoff = async (): Promise<void> => {
    const snapshot = await loadLocalSnapshot()
    const baselineRow = await loadBaseline()
    const bundle = buildBundle(snapshot, baselineRow?.snapshot ?? null)
    downloadJson(timestampName('handoff', 'json'), bundle)
    onMessage(
      baselineRow
        ? `交接包已导出（含 ${snapshot.specimens.length} 份标本，并内嵌出队基线）`
        : '交接包已导出（未内嵌基线：回馆合并时所有不一致字段都需人工对照）'
    )
  }

  const exportBackup = async (): Promise<void> => {
    const snapshot = await loadLocalSnapshot()
    downloadJson(timestampName('gbinsectlog-backup', 'json'), {
      format: 'gbinsectlog-backup/full',
      exportedAt: new Date().toISOString(),
      origin: 'full-backup',
      ...snapshot
    })
    onMessage('全量备份已导出，可交给野外机作为基线，也可在旧流程中直接恢复')
  }

  return (
    <section className="panel flex flex-col gap-4">
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        出队流程：馆内先在本机「全量备份」→ 野外机通过「导入馆内基线」读入 → 离线录入采集地、标本、鉴定、入柜 →
        回馆前「导出离线交接包」。交接包是普通 JSON，可通过 U 盘 / 内网任意拷贝。
      </p>
      <p className="text-sm text-slate-600">{baselineInfo}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
          导入馆内基线（备份 JSON）
        </button>
        <button type="button" className="btn-primary" onClick={() => void exportHandoff()}>
          导出离线交接包
        </button>
        <button type="button" className="btn-ghost" onClick={() => void exportBackup()}>
          全量备份本机台账
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importBaseline(file)
            e.target.value = ''
          }}
        />
      </div>
    </section>
  )
}

/* --------------------------------- 回馆端 --------------------------------- */

function OfficePanel({
  onMessage,
  onError
}: {
  onMessage: (text: string) => void
  onError: (text: string) => void
}): JSX.Element {
  const [jobs, setJobs] = useState<MergeJob[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [local, setLocal] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshJobs = async (): Promise<void> => {
    const rows = await db.mergeJobs.orderBy('createdAt').reverse().toArray()
    setJobs(rows)
  }

  const refreshLocal = async (): Promise<void> => {
    setLocal(await loadLocalSnapshot())
  }

  useEffect(() => {
    void refreshJobs()
    void refreshLocal()
  }, [])

  const importBundle = async (file: File): Promise<void> => {
    try {
      const bundle = parseBundle(JSON.parse(await file.text()))
      const total = bundle.sites.length + bundle.specimens.length + bundle.determinations.length + bundle.storages.length
      if (total === 0) {
        onError('交接包里没有任何记录，未创建合并任务')
        return
      }
      const job = await createMergeJob(bundle, file.name)
      await refreshJobs()
      setSelectedId(job.id)
      onMessage(`已载入「${file.name}」：采集地 ${bundle.sites.length} · 标本 ${bundle.specimens.length} · 鉴定 ${bundle.determinations.length} · 保藏 ${bundle.storages.length}`)
    } catch (err) {
      onError(`交接包解析失败：${err instanceof Error ? err.message : '文件无法解析'}`)
    }
  }

  const selected = jobs.find((j) => j.id === selectedId) ?? null
  const plan: MergePlan | null = useMemo(() => {
    if (!selected || !local) return null
    return prepareMerge(local, selected.bundle, selected.resolutions)
  }, [selected, local])

  const chooseField = async (p: EntityPlan, field: string, resolution: 'local' | 'remote'): Promise<void> => {
    if (!selected) return
    await saveFieldResolution(selected, p.kind, p.incomingId, field, resolution)
    await refreshJobs()
    onMessage(`「${p.label}」的${p.conflicts.find((c) => c.field === field)?.label ?? field}已取${resolution === 'remote' ? '野外值' : '本馆值'}，可继续合并`)
  }

  const chooseSiteMatch = async (incomingSiteId: string, target: string): Promise<void> => {
    if (!selected) return
    await saveSiteMatchResolution(selected, incomingSiteId, target)
    await refreshJobs()
    onMessage(target === NEW_SITE ? '已认定为新采集地，标本将挂到新记录下' : '已认定到既有采集地，其下标本保持原编号')
  }

  const runApply = async (): Promise<void> => {
    if (!selected || !plan) return
    setBusy(true)
    try {
      // 始终按「当前本馆台账 + 已保存的处理结果」重算再写：上次写一半失败也不会重复
      const freshLocal = await loadLocalSnapshot()
      const freshPlan = prepareMerge(freshLocal, selected.bundle, selected.resolutions)
      const report = await applyMerge(freshPlan)
      await updateMergeJob(selected, {
        status: report.remainingConflicts > 0 ? 'open' : 'applied',
        lastError: null,
        appliedAt: report.appliedAt,
        lastReport: report
      })
      await Promise.all([
        siteStore.getState().hydrate(),
        specimenStore.getState().hydrate(),
        determinationStore.getState().hydrate(),
        storageStore.getState().hydrate()
      ])
      await refreshJobs()
      await refreshLocal()
      onMessage(
        `写库完成：新增 ${report.inserted} 条、更新 ${report.updated} 条、暂缓 ${report.skipped} 条` +
          (report.remainingConflicts > 0 ? `；仍有 ${report.remainingConflicts} 项待处理，处理后可再次合并，不会重复建档` : '；全部记录已合并')
      )
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await updateMergeJob(selected, { status: 'failed', lastError: text })
      await refreshJobs()
      onError(`写库失败（事务已整体回滚）：${text}。任务已保留，点「重试写库」即可继续。`)
    } finally {
      setBusy(false)
    }
  }

  const removeJob = async (job: MergeJob): Promise<void> => {
    await db.mergeJobs.delete(job.id)
    if (selectedId === job.id) setSelectedId(null)
    await refreshJobs()
    onMessage(`合并任务「${job.filename}」已删除（台账数据未改动）`)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <section className="panel flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-slate-700">合并任务</h2>
        <button type="button" className="btn-primary w-full justify-center" onClick={() => fileRef.current?.click()}>
          载入交接包 / 旧备份
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importBundle(file)
            e.target.value = ''
          }}
        />
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition ${
                  selectedId === job.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
                onClick={() => setSelectedId(job.id)}
              >
                <p className="truncate font-medium text-slate-700">{job.filename}</p>
                <p className="mt-0.5 text-slate-400">
                  {job.status === 'applied' ? '✅ 已合并' : job.status === 'failed' ? '⚠️ 写库失败，可重试' : '🕓 待处理'}
                  {' · '}
                  {job.createdAt.slice(0, 16).replace('T', ' ')}
                </p>
              </button>
            </li>
          ))}
          {jobs.length === 0 ? <li className="text-xs text-slate-400">暂无任务，载入野外队交回的 JSON 文件开始</li> : null}
        </ul>
      </section>

      {selected && plan ? (
        <JobReview
          job={selected}
          plan={plan}
          local={local}
          busy={busy}
          onChooseField={chooseField}
          onChooseSiteMatch={chooseSiteMatch}
          onApply={runApply}
          onRemove={() => void removeJob(selected)}
        />
      ) : (
        <section className="panel text-sm text-slate-500">
          {jobs.length > 0 ? '请在左侧选择一个合并任务' : '载入交接包后，这里会按「采集地 → 标本 → 鉴定 → 保藏」列出认定结果与字段对照。'}
        </section>
      )}
    </div>
  )
}

/* ------------------------------ 任务复核明细 ------------------------------ */

function JobReview({
  job,
  plan,
  local,
  busy,
  onChooseField,
  onChooseSiteMatch,
  onApply,
  onRemove
}: {
  job: MergeJob
  plan: MergePlan
  local: Snapshot | null
  busy: boolean
  onChooseField: (p: EntityPlan, field: string, resolution: 'local' | 'remote') => Promise<void>
  onChooseSiteMatch: (incomingSiteId: string, target: string) => Promise<void>
  onApply: () => Promise<void>
  onRemove: () => void
}): JSX.Element {
  const [kindTab, setKindTab] = useState<EntityKind>('specimen')
  const plans = plan[`${kindTab}s` as 'sites'] as EntityPlan[]
  const siteById = useMemo(() => new Map((local?.sites ?? []).map((s) => [s.id, s])), [local])

  return (
    <section className="panel flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{job.filename}</h2>
          <p className="text-xs text-slate-500">
            导出于 {job.exportedAt.slice(0, 16).replace('T', ' ') || '未知时间'}
            {job.bundle.baseline ? ' · 含出队基线（可识别单边变化）' : ' · 无基线（旧备份，全部差异需人工对照）'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={onApply}>
            {busy ? '写入中…' : job.status === 'failed' ? '重试写库' : plan.summary.skips > 0 ? '先合并可处理的记录' : '执行合并写库'}
          </button>
          <button type="button" className="btn-danger" disabled={busy} onClick={onRemove}>
            删除任务
          </button>
        </div>
      </header>

      {job.lastError ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">上次失败原因：{job.lastError}</p> : null}
      {job.lastReport ? (
        <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-xs text-field-700">
          上次写入：新增 {job.lastReport.inserted} · 更新 {job.lastReport.updated} · 暂缓 {job.lastReport.skipped}
          {job.appliedAt ? ` · 时间 ${job.appliedAt.slice(0, 16).replace('T', ' ')}` : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3 text-xs">
        <SummaryTag label="新增" value={plan.summary.inserts} tone="field" />
        <SummaryTag label="更新" value={plan.summary.updates} tone="blue" />
        <SummaryTag label="无变化" value={plan.summary.unchanged} tone="slate" />
        <SummaryTag label="暂缓" value={plan.summary.skips} tone="amber" />
        <SummaryTag label="待处理项" value={plan.summary.unresolved} tone="rose" />
      </div>

      {plan.issues.map((issue, i) => (
        <p
          key={i}
          className={`rounded-lg px-3 py-2 text-xs ${
            issue.level === 'warning' ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'
          }`}
        >
          {issue.text}
        </p>
      ))}

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {KIND_TABS.map((tab) => {
          const rows = plan[`${tab.kind}s` as 'sites'] as EntityPlan[]
          const pending = rows.filter((p) => p.blockedReasons.length > 0 || p.conflicts.some((c) => c.resolution === null)).length
          return (
            <button
              key={tab.kind}
              type="button"
              className={`rounded-t-lg px-3 py-1.5 text-xs ${kindTab === tab.kind ? 'bg-field-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
              onClick={() => setKindTab(tab.kind)}
            >
              {tab.title} {rows.length}
              {pending > 0 ? <span className="ml-1 rounded-full bg-rose-500 px-1.5 text-white">{pending}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="flex max-h-[520px] flex-col gap-3 overflow-auto pr-1">
        {plans.map((p) => (
          <PlanCard
            key={p.incomingId}
            plan={p}
            kind={kindTab}
            siteById={siteById}
            siteResolution={job.resolutions.siteMatch[p.incomingId]}
            onChooseField={onChooseField}
            onChooseSiteMatch={onChooseSiteMatch}
          />
        ))}
        {plans.length === 0 ? <p className="text-xs text-slate-400">交接包中没有此类记录</p> : null}
      </div>
    </section>
  )
}

function SummaryTag({ label, value, tone }: { label: string; value: number; tone: 'field' | 'blue' | 'slate' | 'amber' | 'rose' }): JSX.Element {
  const tones = {
    field: 'bg-field-50 text-field-700',
    blue: 'bg-blue-50 text-blue-700',
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700'
  }
  return (
    <span className={`rounded-full px-2.5 py-1 font-medium ${tones[tone]}`}>
      {label} {value}
    </span>
  )
}

function PlanCard({
  plan: p,
  kind,
  siteById,
  siteResolution,
  onChooseField,
  onChooseSiteMatch
}: {
  plan: EntityPlan
  kind: EntityKind
  siteById: Map<string, { id: string; code: string; name: string }>
  siteResolution: string | undefined
  onChooseField: (p: EntityPlan, field: string, resolution: 'local' | 'remote') => Promise<void>
  onChooseSiteMatch: (incomingSiteId: string, target: string) => Promise<void>
}): JSX.Element {
  const unresolved = p.conflicts.some((c) => c.resolution === null)
  return (
    <article className={`rounded-lg border p-3 ${p.blockedReasons.length > 0 ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200'}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">
            <span className="font-mono">{p.label}</span>
            {p.sublabel ? <span className="ml-2 font-normal text-slate-500">{p.sublabel}</span> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {p.match === 'new' ? '包内新增' : p.match === 'ambiguous' ? '匹配有歧义' : '认到本馆同一记录'}
            {p.baseExists ? ' · 基线在档' : ' · 基线无此项'}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${ACTION_STYLE[p.action]}`}>{ACTION_TEXT[p.action]}</span>
      </header>

      {kind === 'site' && p.match === 'ambiguous' ? (
        <div className="mt-2 rounded-lg bg-white/70 p-2">
          <p className="text-xs font-medium text-amber-800">采集地认定（代码或坐标 50 米内匹配到多处）：</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {p.candidates.map((cid) => {
              const site = siteById.get(cid)
              const active = siteResolution === cid
              return (
                <button
                  key={cid}
                  type="button"
                  className={`rounded-lg border px-2 py-1 text-xs ${active ? 'border-field-500 bg-field-50 text-field-700' : 'border-slate-300 text-slate-600'}`}
                  onClick={() => void onChooseSiteMatch(p.incomingId, cid)}
                >
                  认到 {site?.code} {site?.name}
                </button>
              )
            })}
            <button
              type="button"
              className={`rounded-lg border px-2 py-1 text-xs ${siteResolution === NEW_SITE ? 'border-field-500 bg-field-50 text-field-700' : 'border-slate-300 text-slate-600'}`}
              onClick={() => void onChooseSiteMatch(p.incomingId, NEW_SITE)}
            >
              作为新采集地
            </button>
          </div>
        </div>
      ) : null}

      {p.infos.map((info, i) => (
        <p key={i} className="mt-2 text-[11px] text-slate-500">ℹ️ {info}</p>
      ))}

      {p.conflicts.length > 0 ? (
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left font-medium">字段</th>
                <th className="px-2 py-1 text-left font-medium">本馆现值</th>
                <th className="px-2 py-1 text-left font-medium">野外值</th>
                <th className="px-2 py-1 text-left font-medium">出队基线</th>
                <th className="px-2 py-1 text-left font-medium">处理</th>
              </tr>
            </thead>
            <tbody>
              {p.conflicts.map((c) => (
                <tr key={c.field} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-1 font-medium text-slate-600">{c.label}</td>
                  <td className="px-2 py-1 text-slate-700">{formatConflictValue(c.local)}</td>
                  <td className="px-2 py-1 text-field-700">{formatConflictValue(c.remote)}</td>
                  <td className="px-2 py-1 text-slate-400">{formatConflictValue(c.base)}</td>
                  <td className="px-2 py-1">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className={`rounded px-2 py-0.5 ${c.resolution === 'local' ? 'bg-field-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                        onClick={() => void onChooseField(p, c.field, 'local')}
                      >
                        取本馆
                      </button>
                      <button
                        type="button"
                        className={`rounded px-2 py-0.5 ${c.resolution === 'remote' ? 'bg-field-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                        onClick={() => void onChooseField(p, c.field, 'remote')}
                      >
                        取野外
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unresolved ? <p className="bg-amber-50 px-2 py-1 text-[11px] text-amber-800">未选字段默认保持本馆值；该标本的保藏位置在全部对照处理前不会写入。</p> : null}
        </div>
      ) : null}

      {p.blockedReasons.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-amber-800">
          {p.blockedReasons.map((reason, i) => (
            <li key={i}>⏸ {reason}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
