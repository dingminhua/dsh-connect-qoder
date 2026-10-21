/**
 * 活动优惠徽标的判定逻辑（`src/promo.ts`）与它在卡片上的那一半
 * （`src/client/promo-badge.ts`）。
 *
 * 这个文件盯的是三件容易错、且错了不会报错只会**静默画错**的事：
 *
 * 1. **判定必须在渲染时刻做**：上游的活动是墙钟窗口（22:00–08:00 Asia/Shanghai），
 *    若在解析目录时就挑定一枚，「夜间 4 折」会在第二天中午继续挂着。所以这里用
 *    **同一个解析结果**喂不同时钟，断言结论会跟着变。
 * 2. **窗口的边界**：起点含、终点不含；跨零点；`start === end` 视为全天。写反
 *    一个边界，用户就会在 22:00 那一分钟看不到、在 08:00 那一分钟多看到。
 * 3. **时区归上游**：窗口按上游声明的 `timezone` 读，不按浏览器本地时间。同一
 *    个瞬间在 Asia/Shanghai 是深夜、在 America/Los_Angeles 是上午，结论必须不同。
 *
 * 上游形状的出处见 `docs/PROMO_BADGE.md`（2026-10-21 实测国内区 + 国际区）。
 */
import { describe, expect, it } from 'vitest'
import {
  QODER_PROMO_DEFAULT_TIME_ZONE,
  clockMinute,
  parsePromoWindow,
  parseQoderPromotion,
  promoLiveAt,
  promoWithinWindow,
  readPromotion,
  zonedClock,
  type QoderPromotion,
} from '../src/promo.ts'
import { promoBadgeLabel, promoBadgeTooltip } from '../src/client/promo-badge.ts'
import { parseUpstreamModel } from '../src/catalog.ts'
import type { QoderUpstreamModel } from '../src/upstream.ts'

/** 国内区 `qmodel_38max` 实测行的逐字形状（只省略了与本文件无关的字段）。 */
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
    link_url: { zh: 'https://docs.qoder.cn/product-overview/qwen-3-7-series-model-staggering-discount' },
    ...overrides,
  }
}

/** 解析成功，失败直接炸——避免「解析被拒 → 没徽标 → 缺席断言假过」。 */
function rule(overrides: Record<string, unknown> = {}): QoderPromotion {
  const parsed = parseQoderPromotion(upstreamPromotion(overrides))
  if (parsed === undefined) throw new Error('fixture 解析失败')
  return parsed
}

/** 一个瞬间：2026-10-21T15:00:00Z = 23:00 Asia/Shanghai（窗口内）。 */
const NIGHT = new Date('2026-10-21T15:00:00Z')
/** 同一个瞬间在 Los Angeles 是 08:00（窗口终点，已经不在窗口内）。 */
const NIGHT_IN_LA = new Date('2026-10-21T15:00:00Z')
/** 2026-10-21T04:00:00Z = 12:00 Asia/Shanghai（窗口外）。 */
const NOON = new Date('2026-10-21T04:00:00Z')

describe('解析上游 promotion', () => {
  it('把实测行的每个字段都读出来', () => {
    const parsed = rule()
    expect(parsed).toEqual({
      active: false,
      badge: { zh: '错峰 4 折', en: 'Off-Peak 60% off' },
      description: { zh: '22:00-08:00 时段内调用按 4 折计费', en: 'Off-peak calls are 60% off' },
      link: { zh: 'https://docs.qoder.cn/product-overview/qwen-3-7-series-model-staggering-discount' },
      timeZone: 'Asia/Shanghai',
      window: { start: '22:00', end: '08:00', startMinute: 1320, endMinute: 480 },
      discountFactor: 0.4,
      beforePriceFactor: 0.5,
      ruleId: 'idle_time_model_credit_discount',
    })
  })

  it('非对象一律丢弃', () => {
    for (const value of [null, undefined, 'x', 42, [], [{ badge: { zh: 'a' } }]]) {
      expect(parseQoderPromotion(value)).toBeUndefined()
    }
  })

  it('没有可显示的文案就丢弃（插件不自己编）', () => {
    expect(parseQoderPromotion(upstreamPromotion({ badge: {} }))).toBeUndefined()
    expect(parseQoderPromotion(upstreamPromotion({ badge: { zh: '   ' } }))).toBeUndefined()
    expect(parseQoderPromotion(upstreamPromotion({ badge: undefined }))).toBeUndefined()
  })

  it('只有一边文案时保留那一边', () => {
    expect(rule({ badge: { en: 'Off-Peak 60% off' } }).badge).toEqual({ en: 'Off-Peak 60% off' })
    expect(rule({ badge: { zh: '错峰 4 折' } }).badge).toEqual({ zh: '错峰 4 折' })
  })

  it('`active` 缺席或不是 true 一律按「不生效」，但规则本身保留', () => {
    expect(rule({ active: undefined }).active).toBe(false)
    expect(rule({ active: 'true' }).active).toBe(false)
    expect(rule({ active: 1 }).active).toBe(false)
    // 保留是为了悬停能解释这条规则存在、以及它为什么此刻没画。
    expect(rule({ active: 'true' }).badge.zh).toBe('错峰 4 折')
  })

  it('读不懂的窗口当作没有窗口，而不是当作全天', () => {
    const parsed = rule({ window_start: '25:00', window_end: '08:00' })
    expect(parsed.window).toBeUndefined()
    expect(parsed.badge.zh).toBe('错峰 4 折')
  })

  it('空白字符串不算声明', () => {
    expect(rule({ timezone: '  ', rule_id: '' }).timeZone).toBeUndefined()
    expect(rule({ rule_id: '' }).ruleId).toBeUndefined()
  })
})

describe('clockMinute', () => {
  it('接受 0–23 时 / 0–59 分', () => {
    expect(clockMinute('22:00')).toBe(1320)
    expect(clockMinute('0:00')).toBe(0)
    expect(clockMinute('08:00')).toBe(480)
    expect(clockMinute(' 23:59 ')).toBe(1439)
  })

  it('越界、残缺、非字符串一律拒绝', () => {
    for (const value of ['24:00', '22:60', '22', '22:0', '', '22:00:00', 'abc']) {
      expect(clockMinute(value), value).toBeUndefined()
    }
  })

  it('两端都读得懂才算有窗口', () => {
    expect(parsePromoWindow('22:00', '08:00')).toEqual({ start: '22:00', end: '08:00', startMinute: 1320, endMinute: 480 })
    expect(parsePromoWindow('22:00', undefined)).toBeUndefined()
    expect(parsePromoWindow('22:00', '99:00')).toBeUndefined()
  })
})

describe('落盘往返（readPromotion）', () => {
  it('解析结果 JSON 往返后一模一样', () => {
    const parsed = rule()
    const stored = JSON.parse(JSON.stringify(parsed)) as unknown
    expect(readPromotion(stored)).toEqual(parsed)
  })

  it('分钟数与文本对不上时丢掉窗口，但规则还活着', () => {
    const parsed = rule()
    const tampered = JSON.parse(JSON.stringify(parsed)) as QoderPromotion
    tampered.window = { start: '22:00', end: '08:00', startMinute: 0, endMinute: 480 }
    const read = readPromotion(tampered)
    expect(read?.window).toBeUndefined()
    expect(read?.badge.zh).toBe('错峰 4 折')
  })

  it('乱七八糟的落盘值当作没有规则', () => {
    for (const value of [null, 'x', [], { badge: {} }, { badge: 'x' }]) {
      expect(readPromotion(value)).toBeUndefined()
    }
  })

  it('落盘里多出来的键被忽略（旧/新版本共存时不炸）', () => {
    const stored = { ...rule(), someFutureField: { deep: true } }
    expect(readPromotion(stored)).toEqual(rule())
  })
})

describe('窗口判定（按上游时区）', () => {
  const active = (overrides: Record<string, unknown> = {}): QoderPromotion => rule({ active: true, ...overrides })

  it('跨零点窗口：起点之后、终点之前都算', () => {
    const promo = active()
    // 23:00 / 次日 01:00 / 07:59 —— 三个都在 [22:00, 08:00) 里
    expect(promoWithinWindow(promo, new Date('2026-10-21T15:00:00Z'))).toBe(true)
    expect(promoWithinWindow(promo, new Date('2026-10-21T17:00:00Z'))).toBe(true)
    expect(promoWithinWindow(promo, new Date('2026-10-21T23:59:00Z'))).toBe(true)
  })

  it('边界：起点含、终点不含', () => {
    const promo = active()
    // 22:00 整 = 14:00Z，08:00 整 = 00:00Z（次日）
    expect(promoWithinWindow(promo, new Date('2026-10-21T14:00:00Z'))).toBe(true)
    expect(promoWithinWindow(promo, new Date('2026-10-21T00:00:00Z'))).toBe(false)
    // 终点前一分钟仍在窗口内
    expect(promoWithinWindow(promo, new Date('2026-10-20T23:59:00Z'))).toBe(true)
  })

  it('白天不生效', () => {
    expect(promoWithinWindow(active(), NOON)).toBe(false)
    expect(promoWithinWindow(active(), new Date('2026-10-21T05:00:00Z'))).toBe(false)
  })

  it('`start === end` 视为全天（上游写 22:00–22:00 只可能是这个意思）', () => {
    const promo = active({ window_start: '22:00', window_end: '22:00' })
    expect(promoWithinWindow(promo, NOON)).toBe(true)
    expect(promoWithinWindow(promo, NIGHT)).toBe(true)
  })

  it('没有窗口声明时只信上游的 active', () => {
    const promo = active({ window_start: undefined, window_end: undefined })
    expect(promoWithinWindow(promo, NOON)).toBe(true)
  })

  it('同一个瞬间，上海在窗口内、洛杉矶在窗口外', () => {
    const promo = active()
    expect(zonedClock(NIGHT, 'Asia/Shanghai')).toEqual({ isoWeekday: 3, minutes: 23 * 60 })
    expect(zonedClock(NIGHT_IN_LA, 'America/Los_Angeles')).toEqual({ isoWeekday: 3, minutes: 8 * 60 })
    expect(promoWithinWindow(promo, NIGHT)).toBe(true)
    expect(promoWithinWindow({ ...promo, timeZone: 'America/Los_Angeles' }, NIGHT_IN_LA)).toBe(false)
  })

  it('时区缺席时按国内区域兜底', () => {
    const promo = active({ timezone: undefined })
    expect(promo.timeZone).toBeUndefined()
    expect(promoWithinWindow(promo, NIGHT)).toBe(true)
    expect(promoWithinWindow(promo, NOON)).toBe(false)
    expect(QODER_PROMO_DEFAULT_TIME_ZONE).not.toBe('')
  })

  it('读不懂的时区不静默退回本地时间（只是无法用它收紧判定）', () => {
    // 宁可退回上游的 active（这里已被 promoLiveAt 当作必要的门之一），
    // 也不要用浏览器时区去改一个跨零点窗口的含义。
    expect(zonedClock(NIGHT, 'Mars/Olympus')).toBeUndefined()
    expect(promoWithinWindow({ ...active(), timeZone: 'Mars/Olympus' }, NOON)).toBe(true)
  })
})

describe('promoLiveAt：两道门都要过', () => {
  it('上游说没生效 → 不画（哪怕此刻在窗口内）', () => {
    expect(promoLiveAt(rule({ active: false }), NIGHT)).toBe(false)
  })

  it('上游说生效但此刻不在窗口内 → 不画', () => {
    expect(promoLiveAt(rule({ active: true }), NOON)).toBe(false)
  })

  it('两道门都过 → 画', () => {
    expect(promoLiveAt(rule({ active: true }), NIGHT)).toBe(true)
  })

  it('没有规则 → 不画', () => {
    expect(promoLiveAt(undefined, NIGHT)).toBe(false)
  })

  it('判定在渲染时刻：同一份解析结果随时钟改变结论', () => {
    // 这条是「不要在解析时就挑定徽标」的回归锁。
    const parsed = rule({ active: true })
    expect(promoLiveAt(parsed, new Date('2026-10-21T15:00:00Z'))).toBe(true)  // 23:00
    expect(promoLiveAt(parsed, new Date('2026-10-22T04:00:00Z'))).toBe(false) // 次日 12:00
    expect(promoLiveAt(parsed, new Date('2026-10-22T15:00:00Z'))).toBe(true)  // 次日 23:00
    // 解析结果本身没有任何「已判定」的痕迹：它就是上游的规则。
    expect(parsed.active).toBe(true)
    expect(parsed.window?.start).toBe('22:00')
  })
})

describe('胶囊上的文案与悬停（promo-badge）', () => {
  it('中文界面优先 zh，英文界面优先 en', () => {
    const promo = rule({ active: true })
    expect(promoBadgeLabel(promo, 'zh-CN')).toBe('错峰 4 折')
    expect(promoBadgeLabel(promo, 'en-US')).toBe('Off-Peak 60% off')
  })

  it('某一边缺失时回落另一边', () => {
    expect(promoBadgeLabel(rule({ badge: { en: 'Off-Peak 60% off' } }), 'zh-CN')).toBe('Off-Peak 60% off')
    expect(promoBadgeLabel(rule({ badge: { zh: '错峰 4 折' } }), 'en-US')).toBe('错峰 4 折')
  })

  it('悬停拼上游描述、时段（含时区）与说明页', () => {
    const tooltip = promoBadgeTooltip(rule({ active: true }), 'zh-CN')
    expect(tooltip).toContain('22:00-08:00 时段内调用按 4 折计费')
    expect(tooltip).toContain('22:00–08:00 (Asia/Shanghai)')
    expect(tooltip).toContain('https://docs.qoder.cn/')
  })

  it('没有时段就不写时区，只发了一个 badge 时悬停为空', () => {
    expect(promoBadgeTooltip(rule({ window_start: undefined, window_end: undefined }), 'en-US'))
      .toBe('Off-peak calls are 60% off · https://docs.qoder.cn/product-overview/qwen-3-7-series-model-staggering-discount')
    const bare = parseQoderPromotion({ active: true, badge: { zh: '错峰 4 折' } })
    expect(bare).toBeDefined()
    expect(promoBadgeTooltip(bare!, 'zh-CN')).toBe('')
  })
})

describe('目录条目携带规则（catalog 层）', () => {
  it('上游 snake_case 行 → 目录条目里的解析后规则', () => {
    const raw = {
      key: 'qmodel_38max',
      display_name: 'Qwen3.8-Max',
      price_factor: 0.5,
      raw: { promotion: upstreamPromotion({ active: true }) },
    } as unknown as QoderUpstreamModel
    const info = parseUpstreamModel(raw)
    expect(info.promotion).toEqual(rule({ active: true }))
  })

  it('没有 promotion 的行不产生字段（缺席 ≠ 空对象）', () => {
    const raw = { key: 'k', display_name: 'K', price_factor: 1, raw: {} } as unknown as QoderUpstreamModel
    expect('promotion' in parseUpstreamModel(raw)).toBe(false)
  })

  it('pollution 行（有 promotion 但没有文案）不进目录', () => {
    const raw = {
      key: 'k',
      display_name: 'K',
      price_factor: 1,
      raw: { promotion: upstreamPromotion({ badge: {} }) },
    } as unknown as QoderUpstreamModel
    expect('promotion' in parseUpstreamModel(raw)).toBe(false)
  })
})
