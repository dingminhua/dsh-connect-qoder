/**
 * 一条探针结果的**唯一**渲染规则（文案 + 色调）：`probe-label.ts`。
 *
 * 为什么要有这个文件（issue #26）：池子把「上游排队」报成了「连不上上游」，
 * 用户看到红色的一句「连不上上游——上游没有给出可用答复」，于是以为账号坏了、
 * 去换 PAT。而上游逐字说的是「排队中，30 秒后再来，服务是好的」。
 *
 * 两层断言（本仓 `tests/locales.spec.ts` 的既有纪律）：
 *  · key-preserving 翻译器钉住**选了哪个 key**（判据层）；
 *  · 真实 locale 表钉住**这句话读起来对不对**（文案层）。
 */

import { describe, expect, it } from 'vitest'
import { probeResultView } from '../src/client/probe-label.ts'
import { exclusionText } from '../src/client/exclusion-text.ts'
import { qoderLocales, render } from '../src/client/locales.ts'
import type { Translate } from '../src/client/locales.ts'

/** key-preserving 翻译器：断言里直接读出用了哪个 key。 */
const keyT = ((key: string) => key) as never

const NOW = Date.parse('2026-10-31T00:00:00Z')

describe('issue #26：排队不是「连不上上游」', () => {
  it('用的是排队自己的 key，不是 unavailable 的那个', () => {
    const view = probeResultView(
      { outcome: 'queued', retryAtMs: NOW + 30_000, queue: { queueCount: 1027 } },
      keyT,
      NOW,
    )
    expect(view.text).toContain('row.probeQueuedAt')
    expect(view.text).not.toContain('row.probeUnavailable')
  })

  it('色调是 warn 而不是 bad（账号没坏，只是排队）', () => {
    const view = probeResultView({ outcome: 'queued', retryAtMs: NOW + 30_000 }, keyT, NOW)
    expect(view.tone).toBe('warn')
    // 变异检查：把 queued 归进 unavailable 分支，这条立刻红。
  })

  it('上游没给时刻时如实说「上游未给出何时恢复」，不编倒计时', () => {
    const view = probeResultView({ outcome: 'queued' }, keyT, NOW)
    expect(view.text).toContain('row.probeQueuedUnknown')
  })

  it('真的「连不上上游」仍然是 unavailable（别把这一档改坏）', () => {
    const view = probeResultView({ outcome: 'unavailable' }, keyT, NOW)
    expect(view.text).toBe('row.probeUnavailable')
    expect(view.tone).toBe('bad')
  })

  it('排除原因里排队有自己的说法，不是「连不上上游」', () => {
    expect(exclusionText(keyT, 'queued', NOW + 30_000, NOW)).toContain('row.poolExcludedQueued')
    expect(exclusionText(keyT, 'unavailable', undefined, NOW)).toBe('row.probeUnavailable')
  })
})

describe('issue #26：中文文案说的是「排队」', () => {
  const zh = qoderLocales.zh

  it('排队那一句里有「排队」，没有「连不上」', () => {
    const text = render(zh['row.probeQueuedAt'], { at: '10/31 00:30' })
    expect(text).toContain('排队')
    expect(text).not.toContain('连不上')
  })

  it('队列长度那一句把人数说出来', () => {
    const text = render(zh['row.probeQueuedCount'], { count: '1027' })
    expect(text).toContain('1027')
  })

  it('排除原因的短标签说的是「排队中」', () => {
    expect(zh['row.poolExcludedQueued']).toContain('排队')
  })
})
