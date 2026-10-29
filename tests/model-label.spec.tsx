// @vitest-environment jsdom
/**
 * 选择器里的活动/免费徽标（issue #12）的真实渲染。
 *
 * 钉住四类「渲染成文本检查不出来」的东西：
 *
 * 1. **三态与卡片同源**：同一个上游规则，此刻在窗口内画实心、不在窗口内画灰
 *    （虚线），没有窗口且 active 为 false 才整枚不画 —— 判据必须走
 *    `promoDisplayAt`，不能在组件里另写一份。
 * 2. **委托必须是子元素而不是函数调用**：被委托的组件有自己的 hooks。直接
 *    `other(props)` 调用会把它的 hooks 混进我们的 hook 序列，同一槽位在
 *    外来↔本插件 provider 之间切换时直接崩。这里用「被委托组件带 hooks」的
 *    替身钉住：只有作为元素渲染时才合法。
 * 3. **每个 fiber 用自己的 slots**（#12 报告的补丁缺陷）：两次
 *    `createQoderModelLabel` 必须各自看到自己的注册表，模块级变量会让后者
 *    覆盖前者。
 * 4. **失败不炸**：fetch 挂了、行不存在、promotion 字段残缺 —— 都退回裸名字。
 *
 * 参考：`tests/card-promo.spec.tsx`（同款挂载 harness）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQoderModelLabel, findUsageRow, __resetModelLabelCacheForTests } from '../src/client/QoderModelLabel.tsx'
import type { QoderModelLabelProps, QoderModelLabelSlots } from '../src/client/QoderModelLabel.tsx'
import { parseQoderPromotion } from '../src/promo.ts'
import type { QoderPromotion } from '../src/promo.ts'
import type { QoderWebModel } from '../src/status-paths.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * 模拟宿主绑好的翻译器：`promo.locale` 回答 zh（其余键名直通，方便断言键）。
 *
 * 语言信号走 `hostLanguage`（先问 t，问不出才看浏览器）——jsdom 的
 * `navigator.language` 是 en-US，不显式给 zh 的话上游双语字段会取英文侧，
 * 断言就成了「测语言检测」而不是「测徽标」。
 */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  if (key === 'promo.locale') return 'zh'
  if (params === undefined || params === null) return key
  return [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')
}

/** 上游国内区的实测形状（promo.spec.ts 同一份），只留本文件用得到的字段。 */
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

function parsedPromo(overrides: Record<string, unknown> = {}): QoderPromotion {
  const parsed = parseQoderPromotion(upstreamPromotion(overrides))
  if (parsed === undefined) throw new Error('fixture 解析失败')
  return parsed
}

/** 23:00 Asia/Shanghai —— 窗口内。 */
const IN_WINDOW = new Date('2026-10-21T15:00:00Z')
/** 12:00 Asia/Shanghai —— 窗口外（同一条规则，pending）。 */
const OUTSIDE_WINDOW = new Date('2026-10-21T04:00:00Z')

function row(overrides: Partial<QoderWebModel> = {}): QoderWebModel {
  return {
    key: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    contextWindow: 200_000,
    nativeContextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as QoderWebModel
}

/** 记录每次 fetch 的 URL；默认回一份 signed-in 文档。 */
function stubFetch(models: QoderWebModel[]): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    urls.push(String(input))
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'signed-in', models }),
    } as unknown as Response
  }))
  return { urls }
}

/**
 * 空注册表 + 可注入条目的替身。
 *
 * `bindLocale` 默认按 `ns` 回一个可断言的翻译器（键名直通、带上命名空间前缀），
 * 这样「递过去的是**对方**命名空间的 t」可以被逐字验证 —— issue #23 的两个
 * 错误修法（不传 t / 传我们自己的 t）都会在这里露馅。
 */
function slotsStub(
  others: Array<{ component: unknown, locale?: string }> = [],
  opts: { bindLocale?: boolean } = {},
): QoderModelLabelSlots {
  const stub: QoderModelLabelSlots = { entries: () => others }
  if (opts.bindLocale !== false) {
    stub.bindLocale = (ns: string) => ((key: string) => `${ns}:${key}`) as any
  }
  return stub
}

async function mount(
  props: Partial<QoderModelLabelProps>,
  slots: QoderModelLabelSlots = slotsStub(),
): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const Component = createQoderModelLabel(slots)
  const full: QoderModelLabelProps = {
    provider: { id: 'qoder' },
    model: { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
    placement: 'menu',
    t,
    ...props,
  }
  await act(async () => {
    root.render(React.createElement(Component as any, full))
  })
  // 让首次 fetch 的 promise 链走完。
  await act(async () => { await Promise.resolve() })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  __resetModelLabelCacheForTests()
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(IN_WINDOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetModelLabelCacheForTests()
  document.body.innerHTML = ''
})

describe('选择器标签：徽标三态与卡片同源', () => {
  it('窗口内画实心胶囊，名字仍在位', async () => {
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const { container, unmount } = await mount({})
    const chip = container.querySelector('.dsm-qoder-model-promo')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('错峰 4 折')
    expect(chip?.className).not.toContain('dsm-qoder-model-promo-pending')
    // 名字必须原样在（契约：addition 渲染在旁边，名字归宿主）。
    expect(container.textContent).toContain('Qwen3.8-Max')
    await unmount()
  })

  it('窗口外画灰显虚线，悬停写明几点生效', async () => {
    vi.setSystemTime(OUTSIDE_WINDOW)
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const { container, unmount } = await mount({})
    const chip = container.querySelector('.dsm-qoder-model-promo')
    expect(chip?.className).toContain('dsm-qoder-model-promo-pending')
    // 灰显的价值全在「几点生效」；说不出时间就整枚不画（见下一条）。
    expect(chip?.getAttribute('title')).toContain('row.promoPending|start=22:00')
    await unmount()
  })

  it('没有窗口且 active 为 false 的规则整枚不画', async () => {
    stubFetch([row({ promotion: parsedPromo({ active: false, window_start: undefined, window_end: undefined }) })])
    const { container, unmount } = await mount({})
    expect(container.querySelector('.dsm-qoder-model-promo')).toBeNull()
    expect(container.textContent).toContain('Qwen3.8-Max')
    await unmount()
  })

  it('窗口读不出来时不猜时刻，整枚不画', async () => {
    stubFetch([row({ promotion: parsedPromo({ active: false, window_start: '25:00', window_end: '08:00' }) })])
    const { container, unmount } = await mount({})
    expect(container.querySelector('.dsm-qoder-model-promo')).toBeNull()
    await unmount()
  })
})

describe('选择器标签：免费与菜单行', () => {
  it('is_free 的模型挂免费标签，悬停解释「不消耗积分」', async () => {
    stubFetch([row({ isFree: true })])
    const { container, unmount } = await mount({})
    const tag = container.querySelector('.dsm-qoder-model-meta-tag')
    expect(tag?.textContent).toBe('row.modelFree')
    expect(tag?.getAttribute('title')).toBe('row.modelFreeHint')
    await unmount()
  })

  it('菜单行给胶囊加限宽修饰类，trigger 行不加', async () => {
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const menu = await mount({ placement: 'menu' })
    expect(menu.container.querySelector('.dsm-qoder-model-promo')?.className).toContain('dsm-qoder-model-label-promo')
    await menu.unmount()

    const trigger = await mount({ placement: 'trigger' })
    expect(trigger.container.querySelector('.dsm-qoder-model-promo')?.className).not.toContain('dsm-qoder-model-label-promo')
    await trigger.unmount()
  })

  it('选择器给的 id 是显示名也能对上（key / name 两列都认）', async () => {
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const { container, unmount } = await mount({ model: { id: 'Qwen3.8-Max', name: 'Qwen3.8-Max' } })
    expect(container.querySelector('.dsm-qoder-model-promo')).not.toBeNull()
    await unmount()
  })

  it('失败与缺席都退回裸名字，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)))
    const { container, unmount } = await mount({})
    expect(container.querySelector('.dsm-qoder-model-promo')).toBeNull()
    expect(container.textContent).toContain('Qwen3.8-Max')
    await unmount()

    // 行根本不在文档里（模型刚上架 / 名字改过）：同样只画名字。
    stubFetch([])
    const second = await mount({})
    expect(second.container.textContent).toContain('Qwen3.8-Max')
    await second.unmount()
  })
})

describe('选择器标签：外来 provider 的委托', () => {
  it('外来 provider 且没人可委托时画裸名字，且不发请求', async () => {
    const { urls } = stubFetch([])
    const { container, unmount } = await mount({ provider: { id: 'workbuddy' }, model: { id: 'wb-1', name: 'WB One' } })
    expect(container.textContent).toBe('WB One')
    expect(urls).toHaveLength(0)
    await unmount()
  })

  it('外来 provider 委托给账本里的下一个组件，且作为子元素渲染（替身带 hooks）', async () => {
    const seen: QoderModelLabelProps[] = []
    function ForeignLabel(props: QoderModelLabelProps): React.ReactElement {
      // 故意用 hooks：直接调用会把它混进我们的 hook 序列（非法），元素渲染才合法。
      const [count] = React.useState(1)
      seen.push(props)
      return React.createElement('span', { className: 'wb-label' }, `${props.model.name}·${String(count)}·${String((props.t as unknown as (k: string) => string | undefined)?.(`badge.label`))}`)
    }
    stubFetch([])
    const { container, unmount } = await mount(
      { provider: { id: 'workbuddy' }, model: { id: 'wb-1', name: 'WB One' } },
      slotsStub([{ component: ForeignLabel, locale: 'workbuddy-labels' }]),
    )
    // issue #23：必须把**对方命名空间**的 t 递过去（这里是 `workbuddy-labels:badge.label`）。
    // 不递 ⇒ 对方无条件调用 t 时抛 TypeError（#23 现场）；
    // 递我们自己的 t ⇒ 串了命名空间，界面上出现字面键名。
    expect(container.querySelector('.wb-label')?.textContent).toBe('WB One·1·workbuddy-labels:badge.label')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.provider.id).toBe('workbuddy')
    await unmount()
  })

  it('同一实例在外来↔本插件之间切换 provider 不崩（hook 数量必须恒定）', async () => {
    // 直接调用被委托组件（`other(props)`）会把它自己的 hooks 混进我们的序列：
    // 第一次渲染走「外来」分支（0 个我们的 hook + 对方若干），第二次走「本插件」
    // 分支（我们 2 个）—— hook 数量一变 React 立刻抛。元素渲染才恒定。
    function ForeignLabel(props: QoderModelLabelProps): React.ReactElement {
      React.useState(0)
      React.useEffect(() => undefined, [])
      return React.createElement('span', { className: 'wb-label' }, props.model.name)
    }
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const Component = createQoderModelLabel(slotsStub([{ component: ForeignLabel }]))
    const base = { model: { id: 'qmodel_38max', name: 'Qwen3.8-Max' }, placement: 'menu', t }

    await act(async () => {
      root.render(React.createElement(Component as any, { ...base, provider: { id: 'workbuddy' } }))
    })
    expect(container.querySelector('.wb-label')).not.toBeNull()

    // 同一个组件实例（同一个位置）换成 qoder provider，并渲染出徽标。
    await act(async () => {
      root.render(React.createElement(Component as any, { ...base, provider: { id: 'qoder' } }))
    })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('.wb-label')).toBeNull()
    expect(container.querySelector('.dsm-qoder-model-promo')).not.toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('两个 fiber 各用各的注册表，且**同时存活**时互不覆盖（模块级变量会在这里翻车）', async () => {
    // 关键在时序：先把两个实例都建好（相当于两个 fiber 各跑一次 apply），
    // 再让**先建的那个**渲染。模块级变量此刻已被第二个覆盖 —— 用它的写法
    // 会把 A 委托到 B 的注册表上。
    function Aa(): React.ReactElement { return React.createElement('i', { className: 'other-a' }, 'A') }
    function Bb(): React.ReactElement { return React.createElement('i', { className: 'other-b' }, 'B') }
    stubFetch([])
    const ComponentA = createQoderModelLabel(slotsStub([{ component: Aa }]))
    const ComponentB = createQoderModelLabel(slotsStub([{ component: Bb }]))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const props = { provider: { id: 'workbuddy' }, model: { id: 'x', name: 'X' }, placement: 'menu', t }

    await act(async () => { root.render(React.createElement(ComponentA as any, props)) })
    expect(container.querySelector('.other-a')).not.toBeNull()
    expect(container.querySelector('.other-b')).toBeNull()

    await act(async () => { root.render(React.createElement(ComponentB as any, props)) })
    expect(container.querySelector('.other-b')).not.toBeNull()
    expect(container.querySelector('.other-a')).toBeNull()

    // 回到 A：若它读的是被覆盖的全局，这里会画出 B。
    await act(async () => { root.render(React.createElement(ComponentA as any, props)) })
    expect(container.querySelector('.other-a')).not.toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('账本里第一条是自己时跳过自己（否则会自委托成环）', async () => {
    stubFetch([])
    // 同一实例进账本：身份比对必须排除自己，才会落到下一个组件。
    const ledger: Array<{ component: unknown, locale?: string }> = []
    const Component = createQoderModelLabel({
      entries: () => ledger,
      bindLocale: (ns: string) => ((key: string) => `${ns}:${key}`) as any,
    })
    ledger.push({ component: Component }, { component: () => React.createElement('b', null, 'real') })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(Component as any, {
        provider: { id: 'workbuddy' }, model: { id: 'x', name: 'X' }, placement: 'menu', t,
      }))
    })
    expect(container.querySelector('b')).not.toBeNull()
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('选择器标签：时钟翻面', () => {
  it('分钟时器推进后，窗口外的规则从实心翻成灰显，不需要重挂', async () => {
    // 21:59:30 Asia/Shanghai —— 还差 30 秒到 22:00。
    vi.setSystemTime(new Date('2026-10-21T13:59:30Z'))
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const { container, unmount } = await mount({})
    // 此刻不在窗口内 → pending（22:00 起生效）。
    expect(container.querySelector('.dsm-qoder-model-promo')?.className).toContain('pending')
    // 推进 90 秒跨过 22:00：时器每 60 秒一跳，第二次跳后徽标应翻成实心。
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(container.querySelector('.dsm-qoder-model-promo')?.className).not.toContain('pending')
    await unmount()
  })
})

describe('选择器标签：分钟翻面与请求合流', () => {
  it('快照命中缓存（不发请求）时，窗口边界仍依靠时钟重渲染翻面', async () => {
    // 21:59:30 —— 差 30 秒到 22:00。先挂一个实例把快照写进缓存。
    vi.setSystemTime(new Date('2026-10-21T13:59:30Z'))
    const { urls } = stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const first = await mount({})
    expect(first.container.querySelector('.dsm-qoder-model-promo')?.className).toContain('pending')
    expect(urls).toHaveLength(1)
    await first.unmount()

    // 第二个实例挂起时缓存仍新鲜（< 60s），mount 不会发请求；随后推进时钟。
    // 若只有「数据变了才重渲染」，这里永远不会翻面 —— 徽标会停在灰显。
    const second = await mount({})
    expect(urls).toHaveLength(1)
    expect(second.container.querySelector('.dsm-qoder-model-promo')?.className).toContain('pending')
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000) })
    expect(second.container.querySelector('.dsm-qoder-model-promo')?.className).not.toContain('pending')
    await second.unmount()
  })

  it('tick 时若没有任何新数据到达，徽标仍靠时钟自己翻面（不依赖 setSnapshot）', async () => {
    // 21:59:30。首次请求成功写缓存；此后把 fetch 换成永不兑现的 promise，
    // 让后续 tick 既拿不到新快照、也改不了任何状态 —— 唯一能触发重渲染的
    // 只有「重读时钟」那一步。少了它，徽标会一直停在灰显。
    vi.setSystemTime(new Date('2026-10-21T13:59:30Z'))
    stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const { container, unmount } = await mount({})
    expect(container.querySelector('.dsm-qoder-model-promo')?.className).toContain('pending')

    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000) })
    expect(container.querySelector('.dsm-qoder-model-promo')?.className).not.toContain('pending')
    await unmount()
  })

  it('同区多行同时挂载只发一次请求（单飞）', async () => {
    const { urls } = stubFetch([row({ promotion: parsedPromo({ active: true }) })])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const Component = createQoderModelLabel(slotsStub())
    const rows = ['qmodel_38max', 'qmodel_38max', 'qmodel_38max']

    await act(async () => {
      root.render(React.createElement(
        'div',
        null,
        ...rows.map((id, index) => React.createElement(Component as any, {
          key: index, provider: { id: 'qoder' }, model: { id, name: 'Qwen3.8-Max' }, placement: 'menu', t,
        })),
      ))
    })
    await act(async () => { await Promise.resolve() })
    // 三行同区：菜单里几十行时这是「打开一次选择器 = 几十次请求」与一次的区别。
    expect(urls).toHaveLength(1)
    expect(container.querySelectorAll('.dsm-qoder-model-promo')).toHaveLength(3)
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('findUsageRow', () => {
  it('key 与显示名两列都认，未知返回 undefined', () => {
    const models = [row()]
    expect(findUsageRow(models, 'qmodel_38max')?.key).toBe('qmodel_38max')
    expect(findUsageRow(models, 'Qwen3.8-Max')?.key).toBe('qmodel_38max')
    expect(findUsageRow(models, 'nope')).toBeUndefined()
    expect(findUsageRow(undefined, 'qmodel_38max')).toBeUndefined()
  })
})

/**
 * **issue #23 的现场**：被委托的组件无条件调用 `t`。
 *
 * 宿主的 `DeepSeekModelLabel` 长这样（`app.asar` 实测）：
 *
 * ```js
 * function DeepSeekModelLabel({ provider, model, t }) {
 *   if (!(...匹配 deepseek 的 provider/model...)) return model.name
 *   … jsx(Tag, { children: t("badge.label") }) …
 * }
 * ```
 *
 * 它声明了 `locale: "deepseek-model-label-1017"`，所以宿主的框架会按那个
 * 命名空间注入 `t`。我们绕过框架直接 `jsx(Other, {...ownerProps})` 时没传，
 * 于是 `t(...)` 抛 `TypeError: t is not a function`，宿主边界把**整片** label
 * 槽弃权 → 触发按钮、菜单当前值、每个列表行的徽标一起消失，且用户零信号。
 *
 * 这组用例把三种结局分开钉：
 *  1. 不传 t           → 对方抛错（本测试的替身会抛，证明这就是缺陷形状）
 *  2. 传**对方**命名空间的 t → 正常渲染（修复后的行为）
 *  3. 拿不到 locale 面   → 不委托，落回裸名字（而不是递一个会抛的东西）
 */
describe('选择器标签：委托必须给出对方自己的 t（issue #23）', () => {
  /** 与宿主 1017 同构：**无条件**调用 t。 */
  function NeedsT(props: QoderModelLabelProps): React.ReactElement {
    const label = (props.t as (k: string) => string)('badge.label')
    return React.createElement('span', { className: 'needs-t' }, label)
  }

  it('传的是对方命名空间的 t，不是我们的（串命名空间会画出字面键名）', async () => {
    stubFetch([])
    const { container, unmount } = await mount(
      { provider: { id: 'deepseek-account' }, model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' } },
      slotsStub([{ component: NeedsT, locale: 'deepseek-model-label-1017' }]),
    )
    expect(container.querySelector('.needs-t')?.textContent).toBe('deepseek-model-label-1017:badge.label')
    await unmount()
  })

  it('对方没声明 locale 时不传 t（它自己就不依赖框架的座位）', async () => {
    stubFetch([])
    function Plain(props: QoderModelLabelProps): React.ReactElement {
      return React.createElement('span', { className: 'plain' }, `${props.model.name}|${String(props.t === undefined)}`)
    }
    const { container, unmount } = await mount(
      { provider: { id: 'workbuddy' }, model: { id: 'wb', name: 'WB' } },
      slotsStub([{ component: Plain }]),
    )
    expect(container.querySelector('.plain')?.textContent).toBe('WB|true')
    await unmount()
  })

  it('拿不到 locale 面（bindLocale 缺席）时落回裸名字，不把会抛的组件渲染出去', async () => {
    // 老宿主 / 单测环境：`bindLocale` 不存在。此时若仍委托，NeedsT 必抛，
    // 整片 label 槽被弃权 —— 正是 #23 的后果。宁可少一枚别家徽标。
    stubFetch([])
    const { container, unmount } = await mount(
      { provider: { id: 'deepseek-account' }, model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' } },
      slotsStub([{ component: NeedsT, locale: 'deepseek-model-label-1017' }], { bindLocale: false }),
    )
    expect(container.querySelector('.needs-t')).toBeNull()
    expect(container.textContent).toBe('DeepSeek-V4.1-Flash')
    await unmount()
  })

  it('bindLocale 抛错（命名空间未注册）也落回裸名字，不把异常扩散出去', async () => {
    stubFetch([])
    const { container, unmount } = await mount(
      { provider: { id: 'deepseek-account' }, model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' } },
      {
        entries: () => [{ component: NeedsT, locale: 'not-registered' }],
        bindLocale: () => { throw new Error('locale namespace not registered') },
      },
    )
    expect(container.textContent).toBe('DeepSeek-V4.1-Flash')
    await unmount()
  })

  it('本插件的徽标在修复前后都照常渲染（回归对照）', async () => {
    // 委托是给**外来** provider 的；改这段不能碰到自家的三态徽标。
    stubFetch([row({ promotion: parsedPromo({ active: true }), isFree: false })])
    const { container, unmount } = await mount(
      { provider: { id: 'qoder' }, model: { id: 'qmodel_38max', name: 'Qwen3.8-Max' } },
      slotsStub([{ component: NeedsT, locale: 'deepseek-model-label-1017' }]),
    )
    expect(container.querySelector('.dsm-qoder-model-promo')).not.toBeNull()
    expect(container.querySelector('.needs-t')).toBeNull()
    await unmount()
  })
})
