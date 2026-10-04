import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { HANDOFF_KIND, HANDOFF_VERSION, emptySnapshots, parsePackage } from '@/utils/handoff'

describe('parsePackage', () => {
  it('非法 JSON 直接报错', () => {
    expect(() => parsePackage('not-json')).toThrow('不是有效的 JSON')
  })

  it('交接包格式：识别 kind 并解析同步基线', () => {
    const base = emptySnapshots()
    base.specimens.sp_a = { id: 'sp_a', code: 'QLB-2026-0001' } as never
    const text = JSON.stringify({
      kind: HANDOFF_KIND,
      version: HANDOFF_VERSION,
      exportedAt: '2026-06-05T08:00:00.000Z',
      sites: [],
      specimens: [{ id: 'sp_a', code: 'QLB-2026-0001' }],
      determinations: [],
      storages: [],
      base
    })
    const parsed = parsePackage(text)
    expect(parsed.format).toBe('handoff')
    expect(parsed.specimens).toHaveLength(1)
    expect(parsed.base.specimens.sp_a).toBeDefined()
  })

  it('旧备份格式：无 kind / base 也能解析，按无基线合并', () => {
    const text = JSON.stringify({
      exportedAt: '2025-12-01T00:00:00.000Z',
      specimens: [{ id: 'sp_1', code: 'QLB-2025-0001' }],
      sites: [{ id: 'site_1', code: 'QLB' }]
    })
    const parsed = parsePackage(text)
    expect(parsed.format).toBe('legacy')
    expect(parsed.specimens).toHaveLength(1)
    expect(parsed.sites).toHaveLength(1)
    expect(parsed.base).toEqual(emptySnapshots())
  })

  it('高于当前版本的交接包被拒绝', () => {
    const text = JSON.stringify({ kind: HANDOFF_KIND, version: HANDOFF_VERSION + 1, specimens: [] })
    expect(() => parsePackage(text)).toThrow('高于当前支持')
  })

  it('缺必要字段的记录被丢弃并记入警告', () => {
    const text = JSON.stringify({
      kind: HANDOFF_KIND,
      version: HANDOFF_VERSION,
      specimens: [{ id: 'sp_1' }, { code: 'NO-ID-0001' }, { id: 'sp_2', code: 'QLB-2026-0002' }]
    })
    const parsed = parsePackage(text)
    expect(parsed.specimens).toHaveLength(1)
    expect(parsed.warnings.some((warning) => warning.includes('2 条'))).toBe(true)
  })

  it('既非交接包也不含四表数据的文件无法识别', () => {
    expect(() => parsePackage(JSON.stringify({ hello: 'world' }))).toThrow('无法识别')
  })
})
