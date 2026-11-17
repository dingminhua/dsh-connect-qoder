/**
 * issue #41：活动期显示倍率（displayMultiplier）与计费倍率（priceFactor）分离。
 *
 * 现场的坏形状：上游给某模型 `price_factor: 0.1` + 一条「限时免费」promotion
 * （`discount_factor: 0`、`before_promotion_price_factor: 0.1`）。Qoder 官方菜单
 * 显示活动后的 `x0.00`，插件却永远显示基准价 `0.1x`。
 *
 * 这里钉住规则层（promo / catalog / pool 投影），渲染层的断言在
 * `tests/discount-multiplier-render.spec.tsx`。
 *
 * 两条不能混的线：
 * - `priceFactor` / `creditMultiplier` 仍是**基准价**，落盘、pi-ai 请求、账号池
 *   「免费即 0」判据全部读它，一个字符都不改；
 * - 显示倍率由 `displayMultiplierOf` 在**渲染时刻**从基准价 + promotion 现算，
 *   不新增落盘字段——窗口绑死的值一旦写进 `lastCatalog` 就会冻结到下次刷新。
 *
 * @module dsh-connect-qoder/tests/discount-multiplier
 */
import { describe, expect, it } from 'vitest'
import {
  parseQoderPromotion,
  promoDisplayAt,
  readPromotion,
  displayMultiplierOf,
  type QoderPromotion,
} from '../src/promo.ts'
import { parseUpstreamModel, modelDisplayName, fallbackModelInfo, QODER_FALLBACK_MODELS } from '../src/catalog.ts'
import { webModelOf } from '../src/web-status.ts'
import { poolModelOf } from '../src/account-pool.ts'
import type { QoderUpstreamModel } from '../src/upstream.ts'

/** 现场那条「限时免费」promotion（数字是假值，形状取自 PROMO_BADGE.md §2）。 */
function freePromotion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    rule_id: 'limited_time_free',
    // 基准价 0.1 × 折扣系数 0 = 活动实际价 0（x0.00 = 免费）。
    discount_factor: 0,
    before_promotion_price_factor: 0.1,
    badge: { zh: '限时免费', en: 'Limited-time free' },
    description: { zh: '活动期间免费', en: 'Free during the event' },
    timezone: 'Asia/Shanghai',
    window_start: '00:00',
    window_end: '00:00', // start===end = 全天，让正面用例不受跑测试时刻影响
    ...overrides,
  }
}

function rule(overrides: Record<string, unknown> = {}): QoderPromotion {
  const parsed = parseQoderPromotion(freePromotion(overrides))
  if (parsed === undefined) throw new Error('fixture 解析失败')
  return parsed
}

/** 一条 cn 的 qfmodel 行：`price_factor` 是基准价 0.1，不是现场显示的 0。 */
function qfmodel(overrides: {
  promotion?: Record<string, unknown> | undefined
  priceFactor?: number | undefined
} = {}): QoderUpstreamModel {
  return {
    key: 'qfmodel',
    display_name: 'Qwen3.8-Flash',
    enable: true,
    is_default: false,
    is_vl: true,
    is_reasoning: true,
    is_free: false, // 基准不是免费；活动是另一层
    price_factor: overrides.priceFactor ?? 0.1,
    max_input_tokens: 180_000,
    max_output_tokens: 32_768,
    thinking_config: undefined,
    context_config: undefined,
    // 默认带促销；传 `promotion: undefined` 得到无促销的普通模型。
    raw: 'promotion' in overrides
      ? overrides.promotion === undefined ? {} : { promotion: overrides.promotion }
      : { promotion: freePromotion() },
  } as unknown as QoderUpstreamModel
}

/** 23:00 Asia/Shanghai —— 对全天窗口恒 live。 */
const LIVE = new Date('2026-10-21T15:00:00Z')

describe('活动折扣数字的解析与落盘往返', () => {
  it('保留 discount_factor / before_promotion_price_factor（显示倍率要用）', () => {
    const parsed = rule()
    expect(parsed.discountFactor).toBe(0)
    expect(parsed.beforePromotionPriceFactor).toBe(0.1)
    // rule_id 仍不保留：插件不给它任何语义。
    expect('ruleId' in parsed).toBe(false)
  })

  it('缺席 / 非有限数读成 undefined（缺席 ≠ 0）', () => {
    expect(rule({ discount_factor: undefined }).discountFactor).toBeUndefined()
    expect(rule({ before_promotion_price_factor: '0.1' }).beforePromotionPriceFactor).toBeUndefined()
    expect(rule({ discount_factor: Number.NaN }).discountFactor).toBeUndefined()
  })

  it('解析结果 JSON 往返后折扣数字不丢', () => {
    const parsed = rule()
    expect(readPromotion(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })
})

describe('displayMultiplierOf：渲染时刻的活动实际价', () => {
  const DARK = new Date('2026-10-21T04:00:00Z') // 12:00 Asia/Shanghai

  it('活动生效且有折扣数字 → 基准价 × 折扣系数（0.1 × 0 = 0）', () => {
    const info = parseUpstreamModel(qfmodel())
    expect(info.priceFactor).toBe(0.1) // 基准价不动
    expect(info.promotion && promoDisplayAt(info.promotion, LIVE)).toBe('live')
    expect(displayMultiplierOf(info, LIVE)).toBe(0)
  })

  it('窗口外退回基准价（同一份解析结果，随时钟改变结论）', () => {
    const info = parseUpstreamModel(qfmodel({
      promotion: freePromotion({ window_start: '22:00', window_end: '08:00' }),
    }))
    expect(displayMultiplierOf(info, LIVE)).toBe(0)
    expect(displayMultiplierOf(info, DARK)).toBe(0.1)
  })

  it('没有折扣数字 → 退回基准价（不编造活动价）', () => {
    const info = parseUpstreamModel(qfmodel({
      promotion: freePromotion({ discount_factor: undefined }),
    }))
    expect(displayMultiplierOf(info, LIVE)).toBe(0.1)
  })

  it('before_promotion_price_factor 与基准价对不上也照算（不拿折前快照当门）', () => {
    // issue #41 的限时免费条目里，这个字段可能与目录当前 price_factor 不同；
    // 拿它校验会把该显示的 x0.00 又压回基准价。基准价只取目录当前值。
    const info = parseUpstreamModel(qfmodel({
      promotion: freePromotion({ before_promotion_price_factor: 99 }),
    }))
    expect(displayMultiplierOf(info, LIVE)).toBe(0)
  })

  it('折扣系数越界（<0 或 >1）→ 不采信', () => {
    for (const bad of [-1, 1.5]) {
      const info = parseUpstreamModel(qfmodel({
        promotion: freePromotion({ discount_factor: bad }),
      }))
      expect(displayMultiplierOf(info, LIVE)).toBe(0.1)
    }
  })

  it('没有 promotion 的普通模型 → 恒等于基准价', () => {
    const info = parseUpstreamModel(qfmodel({ promotion: undefined }))
    expect(displayMultiplierOf(info, LIVE)).toBe(0.1)
    expect(displayMultiplierOf(info, DARK)).toBe(0.1)
  })

  it('结果按两位小数归一，避免浮点噪声（0.5 × 0.4 = 0.2）', () => {
    const info = parseUpstreamModel(qfmodel({
      promotion: freePromotion({ discount_factor: 0.4, before_promotion_price_factor: 0.5 }),
      priceFactor: 0.5,
    }))
    expect(displayMultiplierOf(info, LIVE)).toBe(0.2)
  })
})

describe('显示倍率只在 UI 路径出现，计费路径一个字符不动', () => {
  it('modelDisplayName 带显示倍率（渲染时刻传 now）', () => {
    const info = parseUpstreamModel(qfmodel())
    expect(modelDisplayName(info, LIVE)).toBe('Qwen3.8-Flash · x0.00')
    // 不传 now 时用当前时刻：全天促销下同样是活动价（生产调用点不改）。
    expect(modelDisplayName(info)).toBe('Qwen3.8-Flash · x0.00')
  })

  it('webModelOf 的 creditMultiplier 仍是基准价，promotion 带着折扣数字到卡片', () => {
    const info = parseUpstreamModel(qfmodel())
    const web = webModelOf(info)
    expect(web.creditMultiplier).toBe(0.1) // 计费/落盘字段不动
    expect(web.promotion?.discountFactor).toBe(0) // UI 现算所需的数字原样到卡片
    // 卡片拿到这两项后自行现算，不依赖服务器写入一个会随时钟过期的字段。
    expect(displayMultiplierOf({ priceFactor: web.creditMultiplier!, promotion: web.promotion }, LIVE)).toBe(0)
  })

  it('poolModelOf 的免费语义不被活动价污染，但把 promotion 带给下拉', () => {
    const info = parseUpstreamModel(qfmodel())
    const pool = poolModelOf(info)
    // 这个模型按基准价不是免费：creditMultiplier 必须是 0.1，不能是 0。
    expect(pool.creditMultiplier).toBe(0.1)
    expect(pool.promotion?.discountFactor).toBe(0)
    expect(displayMultiplierOf({ priceFactor: pool.creditMultiplier!, promotion: pool.promotion }, LIVE)).toBe(0)
  })

  it('兜底目录里的 qfmodel 仍是基准价 0（离线与实时同源语义）', () => {
    const info = fallbackModelInfo(QODER_FALLBACK_MODELS.find(m => m.key === 'qfmodel')!)
    expect(info.priceFactor).toBe(0)
    expect(info.promotion).toBeUndefined()
  })
})
