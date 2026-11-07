/**
 * 选择器胶囊的数据侧（`src/model-badge.ts`）：**说什么、什么时候说、说多长**。
 *
 * 这一层的错不会报错，只会静默画错 —— 所以每条判据都单独钉一遍：
 *
 * 1. **只说此刻成立的促销。** 窗口没到（`pending`）不画：宿主的胶囊只有四个
 *    tone，没有「虚线灰显」这一档，画出来就是一句假的「正在打折」。
 * 2. **翻译表必须含 `en`。** 宿主的 `resolveText` 把 `text.en` 当兜底；缺了它，
 *    任何没命中的语言都会得到一颗**空胶囊**。
 * 3. **上限是 16 个 grapheme，超了整枚不画。** 不是 `length`：`'👨‍👩‍👧'.length === 8`
 *    而用户看到的是 1 个字。也不能截断：截一半的上游文案会被读成一个完整结论。
 * 4. **没有就是 `undefined`，绝不用 `null`。** `badge: null` 会让注册表在
 *    `badge.text` 上抛错，那一整个 provider 从目录里消失。
 */
import { describe, expect, it } from 'vitest'
import {
  MODEL_BADGE_MAX_GRAPHEMES,
  badgeGraphemeCount,
  modelBadgeOf,
  modelBadgeText,
} from '../src/model-badge.ts'
import { parseQoderPromotion } from '../src/promo.ts'
import type { QoderModelInfo } from '../src/catalog.ts'
import { QODER_FALLBACK_MODELS, fallbackModelInfo } from '../src/catalog.ts'

/** 国内区 `qmodel_38max` 的实测形状（`docs/PROMO_BADGE.md` §2 逐字抓包）。 */
function upstreamPromotion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: false,
    rule_id: 'idle_time_model_credit_discount',
    discount_factor: 0.4,
    before_promotion_price_factor: 0.5,
    badge: { zh: '错峰 4 折', en: 'Off-Peak 60% off' },
    timezone: 'Asia/Shanghai',
    window_start: '22:00',
    window_end: '08:00',
    description: { zh: '22:00-08:00 时段内调用按 4 折计费', en: 'Off-peak calls are 60% off' },
    ...overrides,
  }
}

function modelWith(promo: Record<string, unknown> | undefined): QoderModelInfo {
  const base = fallbackModelInfo(QODER_FALLBACK_MODELS[0]!)
  const parsed = promo === undefined ? undefined : parseQoderPromotion(promo)
  return parsed === undefined ? base : { ...base, promotion: parsed }
}

/** 23:00 Asia/Shanghai —— 窗口内。 */
const IN_WINDOW = new Date('2026-10-21T15:00:00Z')
/** 12:00 Asia/Shanghai —— 窗口外（同一条规则是 pending）。 */
const OUTSIDE_WINDOW = new Date('2026-10-21T04:00:00Z')

describe('grapheme 计数：按用户看到的字，不按 length', () => {
  it('中文与英文按字数', () => {
    expect(badgeGraphemeCount('错峰 4 折')).toBe(6)
    expect(badgeGraphemeCount('Off-Peak 60% off')).toBe(16)
  })

  it('emoji 与组合字符算一个字（length 会算成 2 / 8）', () => {
    expect('🚦'.length).toBe(2)
    expect(badgeGraphemeCount('🚦')).toBe(1)
    expect('👨‍👩‍👧'.length).toBe(8)
    expect(badgeGraphemeCount('👨‍👩‍👧')).toBe(1)
  })

  it('上限就是上游那条英文原文的长度（16）', () => {
    expect(MODEL_BADGE_MAX_GRAPHEMES).toBe(16)
    expect(badgeGraphemeCount('Off-Peak 60% off')).toBe(MODEL_BADGE_MAX_GRAPHEMES)
  })
})

describe('文案：翻译表必须含 en', () => {
  it('中英都有且不同 → 翻译表（宿主按读者语言取）', () => {
    expect(modelBadgeText({ badge: { zh: '错峰 4 折', en: 'Off-Peak 60% off' } }))
      .toEqual({ en: 'Off-Peak 60% off', zh: '错峰 4 折' })
  })

  it('只有一种就发字面量，不拿另一种去猜', () => {
    expect(modelBadgeText({ badge: { zh: '错峰 4 折' } })).toBe('错峰 4 折')
    expect(modelBadgeText({ badge: { en: 'Off-Peak 60% off' } })).toBe('Off-Peak 60% off')
  })

  it('中英恰好一样时不发翻译表（同一句话说两遍没有意义）', () => {
    expect(modelBadgeText({ badge: { zh: 'Free', en: 'Free' } })).toBe('Free')
  })

  it('全是空白等于没有', () => {
    expect(modelBadgeText({ badge: { zh: '   ', en: '  ' } })).toBeUndefined()
    expect(modelBadgeText({ badge: {} })).toBeUndefined()
  })
})

describe('判定：只说此刻成立的那一枚', () => {
  it('窗口内 → live，画，tone 是 success', () => {
    const badge = modelBadgeOf(modelWith(upstreamPromotion()), IN_WINDOW)
    expect(badge).toEqual({ text: { en: 'Off-Peak 60% off', zh: '错峰 4 折' }, tone: 'success' })
  })

  it('窗口外 → pending，不画（宿主没有「还没到点」这个 tone）', () => {
    // 这一条是本次最容易做错的地方：画一枚 pending 会让用户以为此刻就在打折。
    expect(modelBadgeOf(modelWith(upstreamPromotion()), OUTSIDE_WINDOW)).toBeUndefined()
  })

  it('没有窗口声明时只信上游的 active', () => {
    const noWindow = { window_start: undefined, window_end: undefined }
    expect(modelBadgeOf(modelWith(upstreamPromotion({ ...noWindow, active: true })), OUTSIDE_WINDOW))
      .toBeDefined()
    expect(modelBadgeOf(modelWith(upstreamPromotion({ ...noWindow, active: false })), IN_WINDOW))
      .toBeUndefined()
  })

  it('窗口读不懂 → 不画（既不当作全天，也不退回去信 active）', () => {
    const broken = upstreamPromotion({ active: true, window_start: '25:00', window_end: '08:00' })
    expect(modelBadgeOf(modelWith(broken), IN_WINDOW)).toBeUndefined()
  })

  it('没有 promotion 字段的模型不画', () => {
    expect(modelBadgeOf(modelWith(undefined), IN_WINDOW)).toBeUndefined()
  })

  it('目录里查不到这一行时不画（不抛）', () => {
    expect(modelBadgeOf(undefined, IN_WINDOW)).toBeUndefined()
  })
})

describe('上限：超过 16 个 grapheme 整枚不画', () => {
  it('恰好 16 画，17 不画', () => {
    const sixteen = 'Off-Peak 60% off'
    expect(badgeGraphemeCount(sixteen)).toBe(16)
    expect(modelBadgeOf(modelWith(upstreamPromotion({ badge: { en: sixteen } })), IN_WINDOW))
      .toEqual({ text: sixteen, tone: 'success' })

    const seventeen = `${sixteen}!`
    expect(badgeGraphemeCount(seventeen)).toBe(17)
    expect(modelBadgeOf(modelWith(upstreamPromotion({ badge: { en: seventeen } })), IN_WINDOW))
      .toBeUndefined()
  })

  it('翻译表里**任何一条**超限都不画（不能只查当前语言那一条）', () => {
    // 宿主进程里读不到浏览器语言，两条都会发给它 —— 一条超长就可能撑破一行，
    // 所以判定必须覆盖整张表。
    const longZh = '错峰时段内调用按四折计费另赠积分优惠'
    expect(badgeGraphemeCount(longZh)).toBeGreaterThan(16)
    expect(modelBadgeOf(
      modelWith(upstreamPromotion({ badge: { zh: longZh, en: 'Off-Peak 60% off' } })),
      IN_WINDOW,
    )).toBeUndefined()
  })

  it('超限时不截断 —— 结果里不会出现半个词', () => {
    const badge = modelBadgeOf(modelWith(upstreamPromotion({ badge: { en: `${'a'.repeat(16)}b` } })), IN_WINDOW)
    expect(badge).toBeUndefined()
  })
})

describe('形状：没有就是 undefined，绝不用 null', () => {
  it('不画的时候返回 undefined', () => {
    // 用 `null` 表示「没有」会让注册表在 `badge.text` 上抛错，那一整个 provider
    // 从目录里消失（进 failures）。这是唯一会真把东西打坏的写法。
    expect(modelBadgeOf(modelWith(upstreamPromotion()), OUTSIDE_WINDOW)).toBeUndefined()
  })

  it('tone 只可能是四个字面量之一', () => {
    const badge = modelBadgeOf(modelWith(upstreamPromotion()), IN_WINDOW)
    expect(['neutral', 'info', 'success', 'warning']).toContain(badge?.tone)
  })

  it('翻译表的键是小写语言 id（宿主的 resolveText 按 localeKey 查）', () => {
    const badge = modelBadgeOf(modelWith(upstreamPromotion()), IN_WINDOW)
    if (typeof badge?.text === 'string') throw new Error('这条 fixture 应该发翻译表')
    for (const key of Object.keys(badge?.text ?? {})) expect(key).toBe(key.toLowerCase())
  })
})
