/* 合并引擎关键场景验证（Node + fake-indexeddb，非自动化测试套件，手动执行） */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  applyMerge,
  buildBundle,
  createMergeJob,
  loadLocalSnapshot,
  parseBundle,
  prepareMerge,
  saveFieldResolution,
  saveSiteMatchResolution,
  updateMergeJob
} from '../src/utils/merge.ts'
import { db } from '../src/hooks/usePersistentStore.ts'
import { EMPTY_SNAPSHOT } from '../src/types/merge.ts'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

const site = (id, code, lat, lon, extra = {}) => ({
  id, code, name: `${code}样地`, region: '', longitude: lon, latitude: lat, altitude: 100,
  habitat: '阔叶林', microHabitat: '', microClimate: '', dateStart: '2026-09-01', dateEnd: '2026-09-02', ...extra
})
const spec = (id, code, siteId, extra = {}) => ({
  id, code, order: '鞘翅目', family: '步甲科', genus: 'Carabus', species: '', tempName: '步甲',
  collectDate: '2026-09-01', collector: '陆昀', sex: '未知', stage: '成虫', bodyLength: 10,
  method: '扫网', quantity: 1, status: '待鉴定', determiner: '', siteId, note: '', ...extra
})
const storage = (id, specimenId, slot, extra = {}) => ({
  id, specimenId, method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot,
  storedDate: '2026-09-03', handler: '覃羽', ...extra
})

console.log('1) 采集地认定：代码相同 / 坐标 50 米内认同，编号不改写')
{
  const base = {
    ...EMPTY_SNAPSHOT(),
    sites: [site('s1', 'QLB', 25.8123, 107.2136, { name: '旧名' })],
    specimens: [spec('sp1', 'QLB-2026-0001', 's1')]
  }
  // 本馆：采集地改了名；野外：代码相同、坐标在 30 米内但代码字段写成了小写
  const local = structuredClone(base)
  local.sites[0].name = '本馆改名'
  const bundle = buildBundle(
    {
      ...EMPTY_SNAPSHOT(),
      // 野外机只有这一个采集地（id 沿用基线），名称被野外改成野外名
      sites: [site('s1', 'QLB', 25.8125, 107.2138, { name: '野外新名' })],
      specimens: [spec('sp1', 'QLB-2026-0001', 's1', { collector: '蓝澈' })]
    },
    structuredClone(base)
  )

  const plan = prepareMerge(local, bundle, { fields: {}, siteMatch: {} })
  const sp = plan.specimens[0]
  check('标本按编号认到同一条，不新建', () => {
    assert.equal(sp.match, 'matched')
    assert.equal(sp.finalId, 'sp1')
    assert.equal(sp.action, 'update') // 采集人单边变化
  })
  check('单边变化（仅野外改采集人）直接接野外值', () => {
    assert.equal(sp.conflicts.length, 0)
    assert.equal(sp.values.collector, '蓝澈')
  })
  check('采集地两边都改名 → 列字段对照，默认保持本馆', () => {
    const c = plan.sites[0].conflicts.find((x) => x.field === 'name')
    assert.ok(c)
    assert.equal(c.local, '本馆改名')
    assert.equal(c.remote, '野外新名')
    assert.equal(c.base, '旧名')
  })
  check('认定后保留本馆代码与标本编号', () => {
    assert.equal(plan.sites[0].values.code, 'QLB')
    assert.equal(sp.values.code, 'QLB-2026-0001')
  })
}

console.log('2) 无基线旧备份：双方不同即列对照，不静默覆盖')
{
  const local = { ...EMPTY_SNAPSHOT(), specimens: [spec('a', 'QLB-2026-0001', 's1', { collector: '甲' })] }
  const legacy = parseBundle({
    format: 'gbinsectlog-backup/legacy',
    sites: [site('s1', 'QLB', 25.8123, 107.2136)],
    specimens: [spec('b', 'QLB-2026-0001', 's1', { collector: '乙' })]
  })
  const plan = prepareMerge(local, legacy, { fields: {}, siteMatch: {} })
  check('旧备份可解析且基线为 null', () => assert.equal(legacy.baseline, null))
  check('采集人差异列对照', () => assert.equal(plan.specimens[0].conflicts[0]?.field, 'collector'))
}

console.log('3) 保藏位置：字段未处理前不写入 + 柜位占用保护')
{
  const base = {
    ...EMPTY_SNAPSHOT(),
    sites: [site('s1', 'QLB', 25.8123, 107.2136)],
    specimens: [spec('sp1', 'QLB-2026-0001', 's1', { note: '基线备注' }), spec('sp2', 'QLB-2026-0002', 's1')],
    storages: []
  }
  const local = structuredClone(base)
  local.specimens[0].note = '本馆备注' // 本馆改了备注
  // 本馆 sp2 已占用 C01-1-1-5
  local.storages = [storage('g2', 'sp2', 5)]
  const bundle = buildBundle(
    {
      ...structuredClone(base),
      specimens: [
        spec('sp1', 'QLB-2026-0001', 's1', { note: '野外备注' }), // 两边都改备注
        spec('sp2', 'QLB-2026-0002', 's1')
      ],
      storages: [
        storage('g1', 'sp1', 3), // sp1 入 3 号位
        storage('gx', 'sp2', 5) // sp2 野外也指向 5 号（同一标本，同位置，应一致）
      ]
    },
    structuredClone(base)
  )

  let plan = prepareMerge(local, bundle, { fields: {}, siteMatch: {} })
  const sp1 = plan.specimens.find((p) => p.label === 'QLB-2026-0001')
  const stg1 = plan.storages.find((p) => p.sublabel.includes('QLB-2026-0001'))
  check('sp1 备注双改进对照', () => assert.equal(sp1.conflicts.some((c) => c.field === 'note'), true))
  check('sp1 的保藏位置在对照处理前暂缓', () => {
    assert.equal(stg1.action, 'skip')
    assert.ok(stg1.blockedReasons.join('').includes('双值对照'))
  })

  // 选野外值后，保藏位置放行
  const resolutions = { fields: { 'specimen:sp1:note': 'remote' }, siteMatch: {} }
  plan = prepareMerge(local, bundle, resolutions)
  const stg1b = plan.storages.find((p) => p.sublabel.includes('QLB-2026-0001'))
  check('对照处理后保藏位置变为新增', () => assert.equal(stg1b.action, 'insert'))

  // 另一标本野外箱想占本馆已被 sp2 占的 5 号给 sp1 → 拒绝
  const bundle2 = buildBundle(
    {
      ...structuredClone(base),
      specimens: [spec('sp1', 'QLB-2026-0001', 's1'), spec('sp2', 'QLB-2026-0002', 's1')],
      storages: [storage('g1', 'sp1', 5)]
    },
    structuredClone(base)
  )
  const local2 = structuredClone(base)
  local2.storages = [storage('g2', 'sp2', 5)]
  const plan2 = prepareMerge(local2, bundle2, { fields: {}, siteMatch: {} })
  const clash = plan2.storages.find((p) => p.sublabel.includes('QLB-2026-0001'))
  check('柜位被别的标本占时挂起，不占两个柜位', () => {
    assert.equal(clash.action, 'skip')
    assert.ok(clash.blockedReasons.join('').includes('占用'))
  })
}

console.log('4) 采集地歧义：代码与坐标各命中一个，需人工认定')
{
  const base = { ...EMPTY_SNAPSHOT(), sites: [], specimens: [] }
  const local = {
    ...EMPTY_SNAPSHOT(),
    sites: [
      site('sa', 'AAA', 25.8123, 107.2136),
      site('sb', 'BBB', 25.8125, 107.2138) // 距入包点约 30 米
    ]
  }
  const bundle = buildBundle(
    { ...EMPTY_SNAPSHOT(), sites: [site('sx', 'AAA', 25.8125, 107.2138)], specimens: [spec('sp1', 'AAA-2026-0001', 'sx')] },
    structuredClone(base)
  )
  let plan = prepareMerge(local, bundle, { fields: {}, siteMatch: {} })
  const sx = plan.sites[0]
  check('歧义采集地挂起且其下标本一并挂起', () => {
    assert.equal(sx.match, 'ambiguous')
    assert.equal(sx.action, 'skip')
    assert.equal(plan.specimens[0].action, 'skip')
  })
  const resolutions = { fields: {}, siteMatch: { sx: 'sb' } }
  plan = prepareMerge(local, buildBundle(
    { ...EMPTY_SNAPSHOT(), sites: [site('sx', 'AAA', 25.8125, 107.2138)], specimens: [spec('sp1', 'AAA-2026-0001', 'sx')] },
    structuredClone(base)
  ), resolutions)
  check('人工认到 BBB 后：采集地更新，标本改挂且编号照旧', () => {
    assert.equal(plan.sites[0].finalId, 'sb')
    assert.equal(plan.specimens[0].values.siteId, 'sb')
    assert.equal(plan.specimens[0].values.code, 'AAA-2026-0001')
  })
}

console.log('5) 写库幂等：失败重试不重复建档 / 不重复占柜')
await checkAsync('应用两次结果一致', async () => {
  await db.specimens.clear()
  await db.sites.clear()
  await db.determinations.clear()
  await db.storages.clear()

  const base = { ...EMPTY_SNAPSHOT(), sites: [], specimens: [], determinations: [], storages: [] }
  const bundle = buildBundle(
    {
      ...EMPTY_SNAPSHOT(),
      sites: [site('s9', 'NEW', 30.0, 110.0)],
      specimens: [spec('n1', 'NEW-2026-0001', 's9')],
      storages: [storage('h1', 'n1', 7)]
    },
    base
  )
  const local = await loadLocalSnapshot()
  const job = await createMergeJob(bundle, 'test.json')
  const plan1 = prepareMerge(local, bundle, job.resolutions)
  await applyMerge(plan1)
  // 模拟重开页面 / 重试：重新读台账、重算、再写一次
  const local2 = await loadLocalSnapshot()
  const plan2 = prepareMerge(local2, bundle, job.resolutions)
  assert.equal(plan2.summary.inserts, 0)
  assert.equal(plan2.summary.unchanged >= 3, true)
  await applyMerge(plan2)

  assert.equal(await db.sites.count(), 1)
  assert.equal(await db.specimens.count(), 1)
  assert.equal(await db.storages.count(), 1)
  assert.equal((await db.storages.toArray())[0].slot, 7)
  await updateMergeJob(job, { status: 'applied', lastError: null })
})

console.log('6) 鉴定记录：新增恢复 + 结论双改列对照')
{
  const det = (id, specimenId, extra = {}) => ({
    id, specimenId, determiner: '覃羽', date: '2026-09-05', conclusion: 'Carabus sp.',
    reference: '', confidence: '中', needReview: false, ...extra
  })
  const base = {
    ...EMPTY_SNAPSHOT(),
    sites: [site('s1', 'QLB', 25.8123, 107.2136)],
    specimens: [spec('sp1', 'QLB-2026-0001', 's1')],
    determinations: [det('d1', 'sp1')]
  }
  const local = structuredClone(base)
  local.determinations[0].reference = '本馆补的文献' // 本馆单边改
  delete local.determinations[0].confidence
  local.determinations[0].confidence = '高'
  const bundle = buildBundle(
    {
      ...structuredClone(base),
      determinations: [
        det('d1', 'sp1', { conclusion: 'Carabus smaragdinus' }), // 野外单边改结论
        det('d2', 'sp1', { determiner: '蓝澈', date: '2026-09-08', conclusion: 'Noctuidae sp.' }) // 野外新增一条
      ]
    },
    structuredClone(base)
  )
  const plan = prepareMerge(local, bundle, { fields: {}, siteMatch: {} })
  check('原鉴定记录：野外单边改结论直接接收，本馆单边补的文献保留', () => {
    const d1 = plan.determinations.find((p) => p.finalId === 'd1')
    assert.equal(d1.action, 'update')
    assert.equal(d1.values.conclusion, 'Carabus smaragdinus')
    assert.equal(d1.values.reference, '本馆补的文献')
  })
  check('野外新增鉴定记录按新增恢复，不依赖自增 id', () => {
    const d2 = plan.determinations.find((p) => p.label === 'Noctuidae sp.')
    assert.equal(d2.action, 'insert')
    assert.equal(d2.values.specimenId, 'sp1')
  })
}

console.log(`\n${passed} 项检查通过`)
