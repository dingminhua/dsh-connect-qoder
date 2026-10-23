// @vitest-environment jsdom
/**
 * 活动徽标在卡片上的真实渲染。
 *
 * 结构上要钉住的两件事（都是「渲染成文本检查不出来」的类型）：
 *
 * 1. **徽标在名字外面**：`.dsm-qoder-model-name` 是省略号截断的，把胶囊塞进去
 *    会被一起裁掉。断言它在 `.dsm-qoder-model-copy` 里、但**不在**名字 span 里。
 * 2. **画不画由渲染时刻决定**：同一个模型行，喂「此刻在窗口内」就画实心，喂
 *    「此刻在窗口外」画成灰的（`promoDisplayAt` 的 `pending`）——窗口是排定的，
 *    白天也得让人看出晚上有折扣；喂「没有窗口且 active 为 false」才整枚不画。
 *    判定函数本身在 `tests/promo.spec.ts` 里测过，这里测的是卡片确实调用了它、
 *    且用的是上游的文案而不是插件自己编的。
 *
 * 参考：`tests/card-render.spec.tsx`（同款挂载 harness）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { parseQoderPromotion, zonedClock, type QoderPromotion } from '../src/promo.ts'

// React 18.3 moved `act` onto the react export; the test-utils copy warns.
const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t: any = (key: string): string => key

/** 解析成功，失败直接炸（否则「没徽标」会假过）。 */
function rule(overrides: Record<string, unknown> = {}): QoderPromotion {
  const parsed = parseQoderPromotion({
    active: true,
    // 全天窗口：本文件的正面用例不该因为测试跑在几点而变红；窗口的边界语义
    // 在 `tests/promo.spec.ts` 里用固定时刻测。
    window_start: '00:00',
    window_end: '00:00',
    badge: { zh: '错峰 4 折', en: 'Off-Peak 60% off' },
    description: { zh: '22:00-08:00 时段内调用按 4 折计费' },
    timezone: 'Asia/Shanghai',
    ...overrides,
  })
  if (parsed === undefined) throw new Error('fixture 解析失败')
  return parsed
}

/**
 * 一个「此刻一定不在窗口内」的窗口：起点在 2 小时后、宽 1 小时。
 *
 * 用当前时钟现算而不是写死 `03:00–04:00`：写死会在那个点跑测试时偶发通过。
 */
function windowAwayFromNow(timeZone: string): { window_start: string, window_end: string } {
  const now = new Date()
  const clock = zonedClock(now, timeZone)
  if (clock === undefined) throw new Error('取不到时区时钟')
  const startMinute = (clock.minutes + 120) % 1440
  const endMinute = (startMinute + 60) % 1440
  const format = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  return { window_start: format(startMinute), window_end: format(endMinute) }
}

function modelOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    key: 'qwen3-coder',
    name: 'Qwen3 Coder',
    contextWindow: 262_144,
    nativeContextWindow: 262_144,
    maxTokens: 65_536,
    creditMultiplier: 0.79,
    ...overrides,
  }
}

function usageDoc(model: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region: 'cn',
    enabled: true,
    showCreditsInMainUi: true,
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'settings', selected: true }],
    models: [model],
    enabledModelKeys: [model['key']],
    offModelKeys: [],
    imageModelKeys: [],
  }
}

async function renderWith(model: Record<string, unknown>, translate: any = t): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/plugins/dsh-connect-qoder/usage')) {
      const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
      return { ok: true, status: 200, json: async () => usageDoc({ ...model, region }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(React.createElement(QoderCard, { t: translate, view: 'page' })) })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

/** 让 `uiLanguage()` 读到指定语言（jsdom 的 navigator.language 是只读 getter）。 */
function setUiLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true })
}

describe('模型行活动徽标', () => {
  beforeEach(() => { setUiLanguage('zh-CN') })
  afterEach(() => { vi.unstubAllGlobals() })

  it('上游说生效且此刻在窗口内：画上游的原文', async () => {
    const view = await renderWith(modelOf({ promotion: rule() }))
    const badge = view.container.querySelector('.dsm-qoder-model-promo')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('错峰 4 折')
    await view.unmount()
  })

  it('英文界面用上游的 en 文案（插件不改写）', async () => {
    setUiLanguage('en-US')
    const view = await renderWith(modelOf({ promotion: rule() }))
    expect(view.container.querySelector('.dsm-qoder-model-promo')!.textContent).toBe('Off-Peak 60% off')
    await view.unmount()
  })

  it('宿主界面语言优先于浏览器语言（中文界面配英文浏览器也用 zh 文案）', async () => {
    setUiLanguage('en-US')
    // 宿主把 t 绑定到哪份字典，就说明界面是哪一种语言。
    const hostT: any = (key: string): string => key === 'promo.locale' ? 'zh-CN' : key
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        return { ok: true, status: 200, json: async () => usageDoc({ ...modelOf({ promotion: rule() }), region: 'cn' }) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(React.createElement(QoderCard, { t: hostT, view: 'page' })) })
    expect(container.querySelector('.dsm-qoder-model-promo')!.textContent).toBe('错峰 4 折')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('徽标在名字外面（名字是省略号截断的）', async () => {
    const view = await renderWith(modelOf({ promotion: rule() }))
    const copy = view.container.querySelector('.dsm-qoder-model-copy')
    const name = view.container.querySelector('.dsm-qoder-model-name')
    const badge = view.container.querySelector('.dsm-qoder-model-promo')
    expect(copy).not.toBeNull()
    expect(name).not.toBeNull()
    expect(badge).not.toBeNull()
    // 在 copy 里、不在 name 里 —— 塞进名字就会被裁掉。
    expect(copy!.contains(badge)).toBe(true)
    expect(name!.contains(badge)).toBe(false)
    // 顺序：名字之后（视觉上「模型名 · 徽标」）。
    expect(name!.compareDocumentPosition(badge!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await view.unmount()
  })

  it('悬停带上游的描述、时段与时区', async () => {
    const view = await renderWith(modelOf({ promotion: rule() }))
    const tip = view.container.querySelector('.dsm-qoder-model-promo')!.getAttribute('title') ?? ''
    expect(tip).toContain('22:00-08:00 时段内调用按 4 折计费')
    expect(tip).toContain('00:00–00:00 (Asia/Shanghai)')
    await view.unmount()
  })

  it('窗口内就画，不看快照里的 active（目录是启动时取的，active 是过去时）', async () => {
    const view = await renderWith(modelOf({ promotion: rule({ active: false }) }))
    expect(view.container.querySelector('.dsm-qoder-model-promo')!.textContent).toBe('错峰 4 折')
    await view.unmount()
  })

  it('没有窗口声明时退回 active：false 不画', async () => {
    const standing = rule({ active: false, window_start: undefined, window_end: undefined })
    const view = await renderWith(modelOf({ promotion: standing }))
    expect(view.container.querySelector('.dsm-qoder-model-promo')).toBeNull()
    await view.unmount()
  })

  it('窗口外画成灰的，悬停里写明几点生效（不是「正在打折」）', async () => {
    const away = windowAwayFromNow('Asia/Shanghai')
    // 把 key 与参数一起回显：这里断言的是「用了哪个 key、带进去哪个起点」，
    // 具体措辞由 `tests/locales.spec.ts` 对着真表钉。
    const echo: any = (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}(${String(params['start'])})`
    const view = await renderWith(modelOf({ promotion: rule(away) }), echo)
    const badge = view.container.querySelector('.dsm-qoder-model-promo')
    expect(badge).not.toBeNull()
    // 灰显靠一个修饰类，不是靠内联样式——CSS 里那份才是唯一真源。
    expect(badge!.className).toContain('dsm-qoder-model-promo-pending')
    expect(badge!.textContent).toBe('错峰 4 折')
    const tip = badge!.getAttribute('title') ?? ''
    expect(tip.startsWith(`row.promoPending(${away.window_start})`)).toBe(true)
    // 灰显不等于少说信息：上游的时段与时区仍在悬停里。
    expect(tip).toContain(`${away.window_start}–${away.window_end} (Asia/Shanghai)`)
    await view.unmount()
  })

  it('「免费」徽标带悬停解释（上游只给一个布尔量，这句是插件写的）', async () => {
    const view = await renderWith(modelOf({ creditMultiplier: 0, isFree: true }))
    const tag = view.container.querySelector('.dsm-qoder-model-meta-tag')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toBe('row.modelFree')
    // 上游对这个徽标没有 description / 时段 / 链接可引用，所以这里用的是插件
    // 自己那条 key —— 断言它，而不是断言某句中文。
    expect(tag!.getAttribute('title')).toBe('row.modelFreeHint')
    await view.unmount()
  })

  it('点胶囊不会顺手取消勾选整个模型（整行是 label）', async () => {
    const view = await renderWith(modelOf({ promotion: rule() }))
    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(true)
    const badge = view.container.querySelector('.dsm-qoder-model-promo')!
    await act(async () => {
      badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(checkbox.checked).toBe(true)
    await view.unmount()
  })

  it('没有活动字段的行不画', async () => {
    const view = await renderWith(modelOf({}))
    expect(view.container.querySelector('.dsm-qoder-model-promo')).toBeNull()
    // 倍率仍然照画，新增徽标没有挤掉它。
    expect(view.container.querySelector('.dsm-qoder-model-name-rate')).not.toBeNull()
    await view.unmount()
  })
})
