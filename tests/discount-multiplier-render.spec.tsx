// @vitest-environment jsdom
/**
 * issue #41 渲染层：卡片模型行显示「活动实际价」而不是基准价。
 *
 * 与 `tests/discount-multiplier.spec.ts`（纯函数）配成一对：那里钉规则，这里钉
 * 卡片确实把规则接上了——同一个基准价 0.1 的模型，活动期显示 `(0.00x)`，
 * 窗口外退回 `(0.10x)`，且活动价的倍率标签带一句「基准价」悬停。
 *
 * harness 照 `tests/card-promo.spec.tsx`。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { parseQoderPromotion, zonedClock, type QoderPromotion } from '../src/promo.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 回显 key 的假翻译器：断言「用了哪个 key、带进去哪个值」由本文件负责。 */
const t: any = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}(${String(params['base'])})`

function promo(overrides: Record<string, unknown> = {}): QoderPromotion {
  const parsed = parseQoderPromotion({
    active: true,
    // 全天窗口：活动价用例不受跑测试时刻影响。
    window_start: '00:00',
    window_end: '00:00',
    discount_factor: 0,
    before_promotion_price_factor: 0.1,
    badge: { zh: '限时免费', en: 'Limited-time free' },
    timezone: 'Asia/Shanghai',
    ...overrides,
  })
  if (parsed === undefined) throw new Error('fixture 解析失败')
  return parsed
}

/** 一个「此刻一定不在窗口内」的窗口，用来验证活动价退回基准价。 */
function windowAwayFromNow(): { window_start: string, window_end: string } {
  const clock = zonedClock(new Date(), 'Asia/Shanghai')
  if (clock === undefined) throw new Error('取不到时区时钟')
  const start = (clock.minutes + 120) % 1440
  const end = (start + 60) % 1440
  const fmt = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return { window_start: fmt(start), window_end: fmt(end) }
}

function modelOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    key: 'qfmodel',
    name: 'Qwen3.8-Flash',
    contextWindow: 180_000,
    nativeContextWindow: 180_000,
    maxTokens: 32_768,
    creditMultiplier: 0.1, // 基准价：活动价不得覆盖它
    ...overrides,
  }
}

async function renderWith(model: Record<string, unknown>): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/plugins/dsh-connect-qoder/usage')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'signed-in', accountId: 'a', accountName: 'A', region: 'cn', enabled: true,
        showCreditsInMainUi: true, selectionExplicit: false,
        accounts: [], models: [model], enabledModelKeys: [model['key']], offModelKeys: [], imageModelKeys: [],
      }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(React.createElement(QoderCard, { t, view: 'page' })) })
  return { container, async unmount() { await act(async () => { root.unmount() }); container.remove() } }
}

describe('卡片模型行倍率（issue #41）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('活动期显示活动实际价 (0.00x)，不是基准价 (0.10x)', async () => {
    const view = await renderWith(modelOf({ promotion: promo() }))
    const rate = view.container.querySelector('.dsm-qoder-model-name-rate')
    expect(rate).not.toBeNull()
    expect(rate!.textContent).toBe('(0.00x)')
    await view.unmount()
  })

  it('活动价的倍率标签带「基准价」悬停，说明 0 是活动价不是免费', async () => {
    const view = await renderWith(modelOf({ promotion: promo() }))
    const rate = view.container.querySelector('.dsm-qoder-model-name-rate')
    expect(rate!.getAttribute('title')).toBe('row.ratePromoHint(0.10)')
    await view.unmount()
  })

  it('窗口外退回基准价 (0.10x)，且不再挂「基准价」悬停', async () => {
    const view = await renderWith(modelOf({ promotion: promo(windowAwayFromNow()) }))
    const rate = view.container.querySelector('.dsm-qoder-model-name-rate')
    expect(rate!.textContent).toBe('(0.10x)')
    expect(rate!.getAttribute('title')).toBeNull()
    await view.unmount()
  })

  it('没有活动的普通模型照旧显示基准价，不挂悬停', async () => {
    const view = await renderWith(modelOf({}))
    const rate = view.container.querySelector('.dsm-qoder-model-name-rate')
    expect(rate!.textContent).toBe('(0.10x)')
    expect(rate!.getAttribute('title')).toBeNull()
    await view.unmount()
  })
})
