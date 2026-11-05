// @vitest-environment jsdom
/**
 * 积分读数的**席位**可选（对齐 dsh-connect-workbuddy issue #62 / 其 commit
 * f16b05f，MIT，Copyright (c) 2026 LaoDing）。
 *
 * 报告的问题是：装了第三方插件之后，输入框里的积分余额就不显示了。根因是位置
 * 本身——`conversation.input.right`（输入框工具栏）是**共享的 list 插槽**，shell
 * 自己的控件和任何其他 bundle 都注册在那里，而 list 插槽无法保证每个占用者都
 * 可见：谁后注册/占了地方，就可能把读数挤没。
 *
 * 修法是把**席位**变成每个区域的选择：`composer`（默认，没主动选过的人界面不动）
 * 或 `stats`（输入框卡片下方那行常驻栏，shell 在那里渲染自己的轮次/token 统计）。
 *
 * 这里钉住两条**都不是装饰性**的性质：
 *   1. 读写往返——席位能在设置写入后存活，且设置存在之前写下的配置读出来是
 *      `composer`（升级不移屏）；
 *   2. GATE 只在该席位渲染、另一个席位不渲染，读数不会在设置说一套时画两遍
 *      （或一遍都不画）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextRegionCampaignsShown,
  nextRegionCreditPosition,
  regionCampaignsShownOf,
  regionCreditPositionOf,
  regionCreditsShownOf,
  unwrapVolatileDeep,
} from '../src/status-paths.ts'
import { ComposerCreditsGate, composerCreditsRegionOf } from '../src/client/ComposerCreditsGate.tsx'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import { QODER_COMPOSER_CSS } from '../src/client/styles.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Key-preserving translator: a wrong key shows up as the literal key text. */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  if (params === undefined || params === null) return key
  return [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')
}

/** A settings scope stub whose snapshot is the given section. */
function scopeOf(value: unknown): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/**
 * 按插槽的方式渲染 gate，并回报**画出了什么**。
 *
 * 真挂载而不是直接调用组件：gate 读一个 settings scope 并订阅它，所以「席位」
 * 这个决定只存在于 React 的生命周期里。`drawn` 数的是读数自己的根节点——gate
 * 产出的那一个节点——这正是让「只在恰好一个席位渲染」可观测的东西。
 */
async function drawGate(input: {
  position?: 'composer' | 'stats'
  scope?: unknown
  provider?: string
  openSettings?: () => void
}): Promise<{ container: HTMLDivElement, drawn: number }> {
  // 读数会在挂载时取余额；空应答让这条用例只关于**席位**决定，而不是积分。
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'signed-out', accounts: [] }),
  } as Response)))
  const useProjection = (): unknown => ({ next: { provider: input.provider ?? 'qoder' } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ComposerCreditsGate, {
      t,
      ...input.position === undefined ? {} : { position: input.position },
      ...input.scope === undefined ? {} : { settingsScope: input.scope as any },
      ...input.openSettings === undefined ? {} : { openSettings: input.openSettings },
      useProjection,
    } as any))
  })
  const drawn = container.querySelectorAll('.dsm-qoder-composer-credits').length
  await act(async () => { root.unmount() })
  container.remove()
  return { container, drawn }
}

describe('积分读数席位', () => {
  it('默认是 composer，包括设置存在之前写下的配置', () => {
    // 默认值的全部意义：升级不动屏幕上的任何东西。
    expect(regionCreditPositionOf({ regions: { cn: {} } }, 'cn')).toBe('composer')
    expect(regionCreditPositionOf({ regions: { cn: { showCreditsInMainUi: false } } }, 'cn')).toBe('composer')
    expect(regionCreditPositionOf(undefined, 'cn')).toBe('composer')
    // 手工改坏的配置读出来也是默认值，而不是哪都不渲染。
    expect(regionCreditPositionOf({ regions: { cn: { creditPosition: 'sidebar' } } }, 'cn')).toBe('composer')
  })

  it('按**区域**读席位，不是全局一个', () => {
    const value = { regions: { cn: { creditPosition: 'stats' }, global: {} } }
    expect(regionCreditPositionOf(value, 'cn')).toBe('stats')
    expect(regionCreditPositionOf(value, 'global')).toBe('composer')
  })

  it('写入只动目标区域的 creditPosition，兄弟字段与另一区域原样保留', () => {
    // `next*` 家族的入参/返回都是 **regions 映射本身**（见 `nextRegionSlots`），
    // 不是整棵设置树——与 `nextRegionCreditsShown` 同规。
    const before = {
      cn: { pat: 'pt-keep', enabledModelKeys: ['a'], creditPosition: 'composer' },
      global: { creditPosition: 'stats', pat: 'pt-global' },
    }
    const after = nextRegionCreditPosition(before, 'cn', 'stats') as any
    expect(after.cn.creditPosition).toBe('stats')
    // 同槽的兄弟字段不能被这次写入吃掉。
    expect(after.cn.pat).toBe('pt-keep')
    expect(after.cn.enabledModelKeys).toEqual(['a'])
    // 另一个区域完全不动。
    expect(after.global).toEqual({ creditPosition: 'stats', pat: 'pt-global' })
  })

  it('往返：写下的席位读得回来，且开关字段互不干扰', () => {
    const regions = nextRegionCreditPosition({ cn: {} }, 'cn', 'stats')
    const written = { regions }
    expect(regionCreditPositionOf(written, 'cn')).toBe('stats')
    // 位置与显示开关是两件事：写位置不该把开关关掉，反之亦然。
    expect(regionCreditsShownOf(written, 'cn')).toBe(true)
  })

  it('活动显示开关：与积分开关互不干扰，读写往返，默认显示', () => {
    // 两个开关都是区域级内容开关，住在同一个区域槽里 —— 所以最容易出的错是
    // 「写一个把另一个吃掉」。逐项验证：
    //   1. 从未写过 = 显示（内容开关的缺席不等于拒绝，与共享座位那条判据相反）；
    //   2. 写活动开关不影响积分开关；
    //   3. 写入的值能原样读回。
    expect(regionCampaignsShownOf({ cn: {} }, 'cn')).toBe(true)
    const off = { regions: nextRegionCampaignsShown({ cn: { showCreditsInMainUi: true } }, 'cn', false) }
    expect(regionCampaignsShownOf(off, 'cn')).toBe(false)
    expect(regionCreditsShownOf(off, 'cn')).toBe(true)
    // 反向：写积分开关不该把活动开关打开。
    const creditsOff = { regions: nextRegionCampaignsShown({ cn: {} }, 'cn', false) }
    expect(regionCampaignsShownOf(creditsOff, 'cn')).toBe(false)
    // 兄弟区域不受影响。
    expect(regionCampaignsShownOf({ cn: { showCampaigns: false }, global: {} }, 'global')).toBe(true)
  })

  it('volatile 包装下的值也能读出正确席位（代理的 === 陷阱）', () => {
    // 0.1.7 线上，scope 的值是活的 cosmokit 引用；不解包就读字段会拿到代理，
    // 而代理与字符串比较恒为 false，席位会被误判成 composer。
    const wrapped = { regions: { cn: { creditPosition: 'stats' } } }
    const proxy = new Proxy(wrapped, {})
    expect(regionCreditPositionOf(unwrapVolatileDeep(proxy), 'cn')).toBe('stats')
  })

  it('归属：非本插件的 provider 不渲染', () => {
    // 两个连接器插件共用同一行时，绝不能同时画两家的积分。
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, scopeOf({}))).toBeUndefined()
    expect(composerCreditsRegionOf({ next: { provider: 'qoder' } }, scopeOf({}))).toBe('cn')
    expect(composerCreditsRegionOf({ next: { provider: 'qoder-global' } }, scopeOf({}))).toBe('global')
  })

  it('GATE 在设置点名的席位渲染，且只在那个席位', async () => {
    const composer = await drawGate({ position: 'composer', scope: scopeOf({ regions: { cn: {} } }) })
    const stats = await drawGate({ position: 'stats', scope: scopeOf({ regions: { cn: {} } }) })
    // 默认 = composer：stats 席位必须闭嘴，否则读数会同时出现在两处。
    expect(composer.drawn).toBe(1)
    expect(stats.drawn).toBe(0)
  })

  it('GATE：把席位改成 stats 后，渲染权整个交过去（不是两边都画）', async () => {
    const scope = scopeOf({ regions: { cn: { creditPosition: 'stats' } } })
    const composer = await drawGate({ position: 'composer', scope })
    const stats = await drawGate({ position: 'stats', scope })
    expect(composer.drawn).toBe(0)
    expect(stats.drawn).toBe(1)
  })

  it('GATE：区域被关掉时两个席位都不渲染（而不是先在非当前席位画一帧）', async () => {
    // 判定顺序是「归属 → 开关 → 席位」。若席位先判，被关掉的区域会在**非**当前
    // 席位先画一帧再被区域判定拒掉——用户会看到读数闪一下。
    const scope = scopeOf({ regions: { cn: { showCreditsInMainUi: false } } })
    expect((await drawGate({ position: 'composer', scope })).drawn).toBe(0)
    expect((await drawGate({ position: 'stats', scope })).drawn).toBe(0)

    // `enabled: false`（整个版本供应商被撤掉）同理。
    const disabled = scopeOf({ regions: { cn: { enabled: false } } })
    expect((await drawGate({ position: 'composer', scope: disabled })).drawn).toBe(0)
    expect((await drawGate({ position: 'stats', scope: disabled })).drawn).toBe(0)
  })

  it('GATE：position 缺席时按 composer 处理（旧调用方与旧宿主的兼容面）', async () => {
    expect((await drawGate({ scope: scopeOf({ regions: { cn: {} } }) })).drawn).toBe(1)
  })
})

// ==========================================================================
// composer 页脚：显示数据的真实读取时刻，并在刷新失败时说明数字是旧的
// ==========================================================================

/**
 * 截图里 800 之所以看起来可信，是因为页脚写着「最近刷新 00:22」—— 那是**客户端
 * fetch 返回的时刻**，刷新失败时它照样往前走。数字是旧的、时间显示刚刚，用户
 * 无从判断哪个能信。
 *
 * 现在宿主把数据的真实读取时刻（`creditsAtMs`）带出来：两者不一致就标「未更新」，
 * 并把宿主的 `refreshError` 覆盖层显示成失败提示（旧数字仍在，只是被说明）。
 */
describe('composer 页脚的数据时刻', () => {
  /** 挂载 ComposerCredits、点开面板，回报页脚与错误行的文本。 */
  async function openPanel(doc: Record<string, unknown>): Promise<{ foot: string, error: string | null, total: string }> {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/account-credits')) {
        return { ok: true, status: 200, json: async () => [] } as Response
      }
      return { ok: true, status: 200, json: async () => doc } as Response
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(ComposerCredits, { t, provider: 'qoder', region: 'cn' } as any))
      })
      const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')!
      await act(async () => { trigger.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      // 面板 portal 到 body，所以从 document 找。
      const panel = document.querySelector('.dsm-qoder-composer-panel') as HTMLElement
      expect(panel).not.toBeNull()
      return {
        foot: panel.querySelector('.dsm-qoder-composer-panel-foot')?.textContent ?? '',
        error: panel.querySelector('.dsm-qoder-composer-panel-error')?.textContent ?? null,
        total: trigger.textContent ?? '',
      }
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    }
  }

  const signedInDoc = (over: Record<string, unknown>): Record<string, unknown> => ({
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'ddd',
    region: 'cn',
    enabled: true,
    accounts: [],
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 738, packages: [], expiringSoon: 0 },
    ...over,
  })

  it('数据时刻与 fetch 时刻一致时，页脚不加「未更新」', async () => {
    const view = await openPanel(signedInDoc({ creditsAtMs: Date.now() }))
    expect(view.foot).toContain('composer.lastRefresh')
    expect(view.foot).not.toContain('composer.dataStale')
    expect(view.error).toBeNull()
    expect(view.total).toContain('738')
  })

  it('数据比 fetch 更老时标「未更新」，但数字保留', async () => {
    // 刷新失败：宿主保留上一次的好快照（atMs 是旧的），客户端必须把这件事说出来。
    const old = Date.now() - 10 * 60_000
    const view = await openPanel(signedInDoc({
      creditsAtMs: old,
      refreshError: 'credits read returned no data (timeout)',
    }))
    expect(view.total).toContain('738')
    expect(view.foot).toContain('composer.dataStale')
    expect(view.error).toContain('composer.refreshFailed')
  })

  it('refreshError 单独出现（数据时刻恰好新鲜）也要显示失败提示', async () => {
    const view = await openPanel(signedInDoc({
      creditsAtMs: Date.now(),
      refreshError: 'credits read returned no data (timeout)',
    }))
    expect(view.error).toContain('composer.refreshFailed')
    expect(view.total).toContain('738')
  })

  it('旧宿主不给 creditsAtMs 时退回 fetch 时刻，且不谎报「未更新」', async () => {
    const view = await openPanel(signedInDoc({}))
    expect(view.foot).toContain('composer.lastRefresh')
    expect(view.foot).not.toContain('composer.dataStale')
  })
  it('不为页脚时刻钉死 locale', () => {
    // 源码级断言：不论测试环境是什么语言都成立。行为级断言在 zh-CN 环境下
    // 会因为「钉死的写法」和「读者语言的写法」结果相同而失效，源码级不会。
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ComposerCredits.tsx'),
      'utf8',
    )
    const clock = /function formatClock\(value: number\): string \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(clock, 'ComposerCredits.tsx 里没有找到 formatClock').not.toBe('')
    expect(
      clock,
      "formatClock 仍钉死了 locale —— 必须用 undefined，让时刻跟随读者",
    ).not.toContain("'zh-CN'")
    expect(clock).toContain('undefined')
  })

  it('渲染出的时刻是读者语言的那种写法', async () => {
    // 行为级那一半。这个时刻是「最近一次刷新的时刻」——也就是当下——所以期望值
    // 取渲染**前后**两个瞬间，两者都接受，因为中间可能跨过一分钟。
    const format = (ms: number): string =>
      new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const before = Date.now()
    const view = await openPanel(signedInDoc({ creditsAtMs: Date.now() }))
    const after = Date.now()

    expect(view.foot).toContain('composer.lastRefresh')
    expect(
      view.foot.includes(format(before)) || view.foot.includes(format(after)),
      `页脚印的是 ${JSON.stringify(view.foot)}，不是读者语言对 ${format(before)} 的写法`,
    ).toBe(true)
  })

})

  // ==========================================================================
  // composer 面板的点色：与设置页大表同判、同证据
  // ==========================================================================

  /**
   * 用户实拍（2026-10-18）与最终口径：「能用的绿色圆点；当前选择的，绿色圆点
   * 加第二行提示当前选用；不能用的红色圆点+原因；原因里显示解禁时间」。
   *
   * 面板此前的 bug：宿主的 account-credits 表不带探针字段，面板的点落在「没测过」
   * 的灰上——设置页绿、面板灰。现在颜色只回答「能不能用」：没被排除就绿，被排除
   * 就红；「哪一个是它」由第二行「当前选用」说明，不再靠颜色区分。
   *
   * 这里从 DOM 钉住最终颜色与文字（而不是只测纯函数）：面板此前正是「纯函数没错、
   * 接线没接」才灰的。
   */

describe('composer 面板的点色', () => {
  // accountStateColor 的两档在用色（var() 令牌的回退值就是这些 hex）。
  const GREEN = '#22a06b'
  const RED = '#ef4444'

  const doc: Record<string, unknown> = {
    status: 'signed-in',
    accountId: 'a-cur',
    accountName: 'cur',
    region: 'cn',
    enabled: true,
    accounts: [],
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 165, packages: [], expiringSoon: 0 },
    // 玩家池：页头那颗「刷新」判的是**池成员**（宿主侧的 `pool.test` 遍历的
    // 就是它），不是面板上列出的账号行。
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelId: 'qmodel_38max',
      targetModelSource: 'preferred',
      memberAccountIds: ['a-cur'],
      effectiveMemberAccountIds: ['a-cur'],
      accounts: [],
    },
  }

  /**
   * 挂载 → 开面板 → 把面板交给断言回调 → 拆卸。
   * `counts.accountCredits` 数账号表请求次数、`counts.test` 数页头那颗「刷新」
   * 的探针请求次数（两者都是既有回归点）。
   *
   * `pool` 覆盖 usage 文档里的玩家池段（`undefined` = 宿主不发这一段，例如旧
   * 宿主）。「刷新」判的是**池成员**（宿主侧的 `pool.test` 遍历的就是它），不是
   * 面板上列出的账号行 —— 所以这两者必须能分别设定。
   */
  async function withPanel(
    rows: Record<string, unknown>[],
    run: (panel: HTMLElement, counts: { accountCredits: number, test: number }) => Promise<void>,
    /**
     * `openSettings` 回调。**默认不传** —— 一台没挂 Plugins 页的宿主拿不到
     * `pluginNavigation`，那时这颗按钮根本不该存在，而这个默认值正是那种形态。
     */
    openSettings?: () => void,
    /** 覆盖 usage 文档里的 `pool` 段；`undefined` = 用默认那份（有成员）。 */
    pool?: Record<string, unknown> | undefined,
  ): Promise<void> {
    const counts = { accountCredits: 0, test: 0 }
    const document_ = pool === undefined ? doc : { ...doc, pool }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/account-credits')) {
        counts.accountCredits += 1
        return { ok: true, status: 200, json: async () => rows } as Response
      }
      // 页头那颗「刷新」走的就是设置页账号池工具栏同一条路：POST pool?action=test。
      if (url.includes('/pool') && url.includes('action=test') && method === 'POST') {
        counts.test += 1
        return { ok: true, status: 200, json: async () => ({ action: 'test', rows: [] }) } as Response
      }
      // 进度轮询是只读的：这里不给批次，pull 会安静地什么都不做。
      if (url.includes('/pool') && url.includes('action=progress')) {
        return { ok: true, status: 200, json: async () => ({}) } as Response
      }
      return { ok: true, status: 200, json: async () => document_ } as Response
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(ComposerCredits, { t, provider: 'qoder', region: 'cn', ...openSettings === undefined ? {} : { openSettings } } as any))
      })
      const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')!
      await act(async () => { trigger.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      const panel = document.querySelector('.dsm-qoder-composer-panel') as HTMLElement
      expect(panel).not.toBeNull()
      await run(panel, counts)
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    }
  }

  /** 每一行的点色（style 属性原文）与高亮，按账号名索引。 */
  function rowsOf(panel: HTMLElement): Map<string, { style: string, current: boolean }> {
    const map = new Map<string, { style: string, current: boolean }>()
    for (const tr of Array.from(panel.querySelectorAll('tbody tr'))) {
      const name = tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent ?? ''
      const dot = tr.querySelector('.dsm-qoder-composer-panel-dot')
      map.set(name, {
        style: dot?.getAttribute('style') ?? '',
        current: tr.className.includes('dsm-qoder-composer-panel-row-current'),
      })
    }
    return map
  }

  it('在用号（current=true）没测过也是绿点，且行高亮 —— 主回归', async () => {
    // 宿主还没发 probeOutcome（旧包）时，「在用」本身就该画绿；此前这条
    // 落在 unknown 的灰上，正是用户实拍的「当前用的那个号没有用绿色」。
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: false, current: true, credits: 165 },
      { id: 'a-sel', accountName: 'sel', selected: true, current: false, excludedBy: 'out-of-credit', probeOutcome: 'out-of-credit', credits: 500 },
    ], async panel => {
      const rows = rowsOf(panel)
      expect(rows.get('cur')!.style).toContain(GREEN)
      expect(rows.get('cur')!.current).toBe(true)
      // 被排除的选中号：红点，不高亮。
      expect(rows.get('sel')!.style).toContain(RED)
      expect(rows.get('sel')!.current).toBe(false)
    })
  })

  it('在用号测过且 ok → 绿；证据在场时走证据', async () => {
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true, probeOutcome: 'ok', credits: 165 },
    ], async panel => {
      expect(rowsOf(panel).get('cur')!.style).toContain(GREEN)
    })
  })

  it('在用但被排除（池关时第一发号额度用尽仍 current）→ 红点 + 高亮，不复活绿点', async () => {
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true, excludedBy: 'out-of-credit', probeOutcome: 'out-of-credit', credits: 0 },
    ], async panel => {
      const row = rowsOf(panel).get('cur')!
      expect(row.style).toContain(RED)
      expect(row.current).toBe(true)
    })
  })

  it('能用的一律绿、不能用的一律红（颜色不再分「测过/没测过」）', async () => {
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
      { id: 'a-rl', accountName: 'rl', selected: false, current: false, excludedBy: 'rate-limited', probeOutcome: 'rate-limited' },
      { id: 'a-rej', accountName: 'rej', selected: false, current: false, excludedBy: 'credential-rejected', probeOutcome: 'credential-rejected' },
      { id: 'a-unknown', accountName: 'unknown', selected: false, current: false },
      { id: 'a-ok', accountName: 'ok', selected: false, current: false, probeOutcome: 'ok' },
    ], async panel => {
      const rows = rowsOf(panel)
      // 限流也红：红点说的是「现在别指望它」，还能等多久由原因里的解禁时长说。
      expect(rows.get('rl')!.style).toContain(RED)
      expect(rows.get('rej')!.style).toContain(RED)
      // 没测过但没被排除 = 能用 → 绿。
      expect(rows.get('unknown')!.style).toContain(GREEN)
      expect(rows.get('ok')!.style).toContain(GREEN)
    })
  })

  it('旧宿主不给 current 时退回选中号（兼容面）：两行都能用，就都绿', async () => {
    await withPanel([
      { id: 'a-sel', accountName: 'sel', selected: true },
      { id: 'a-other', accountName: 'other', selected: false },
    ], async panel => {
      const rows = rowsOf(panel)
      expect(rows.get('sel')!.current).toBe(true)
      expect(rows.get('sel')!.style).toContain(GREEN)
      expect(rows.get('other')!.style).toContain(GREEN)
    })
  })

  it('当前选用写在第二行：在用号绿点 + 「当前选用」，其他能用的号不写', async () => {
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true, credits: 165 },
      { id: 'a-other', accountName: 'other', selected: false, current: false, credits: 77 },
    ], async panel => {
      const rows = Array.from(panel.querySelectorAll('tbody tr'))
      const curRow = rows.find(tr => tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent === 'cur')!
      expect(curRow.querySelector('.dsm-qoder-composer-panel-pick')?.textContent).toBe(t('composer.currentPick'))
      expect(curRow.querySelector('.dsm-qoder-composer-panel-mark')).toBeNull()
      const otherRow = rows.find(tr => tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent === 'other')!
      expect(otherRow.querySelector('.dsm-qoder-composer-panel-pick')).toBeNull()
    })
  })

  it('不能用的写原因；上游给了解禁时刻就补相对时长，不写绝对时刻', async () => {
    const until = Date.now() + 12 * 60 * 1000
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
      { id: 'a-rl', accountName: 'rl', selected: false, current: false, excludedBy: 'rate-limited', probeOutcome: 'rate-limited', retryAtMs: until },
      { id: 'a-rej', accountName: 'rej', selected: false, current: false, excludedBy: 'credential-rejected', probeOutcome: 'credential-rejected' },
    ], async panel => {
      const rows = Array.from(panel.querySelectorAll('tbody tr'))
      const rl = rows.find(tr => tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent === 'rl')!
      const mark = rl.querySelector('.dsm-qoder-composer-panel-mark')?.textContent ?? ''
      expect(mark).toContain(t('row.poolExcludedRateLimited'))
      // 测试里的 t 是保键翻译器：解禁时刻经 row.unlockSuffix + row.remainingMinutes
      // 变成相对时长，count=12 说明给的是「约 12 分钟后」而不是绝对时刻。
      expect(mark).toContain('row.unlockSuffix|when=row.remainingMinutes|count=12')
      // 「解禁时间」用相对时长给，不出现绝对时刻。
      expect(mark).not.toMatch(/\d{1,2}[:：]\d{2}/)
      // 不会自己好的（凭据被拒）：只有原因，没有倒计时。
      const rej = rows.find(tr => tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent === 'rej')!
      expect(rej.querySelector('.dsm-qoder-composer-panel-mark')?.textContent).toBe(t('row.poolExcludedRejected'))
    })
  })

  it('页头有两颗按钮：左边「刷新」（重测玩家池），右边「设置」（打开插件设置页）', async () => {
    let opened = 0
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
    ], async (panel, counts) => {
      // 右那颗：设置。
      const settings = panel.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-settings')!
      expect(settings).not.toBeNull()
      // 标签只算文字：齿轮是 aria-hidden 的 svg，不参与 textContent。
      expect(settings.textContent).toBe(t('composer.openSettings'))
      expect(settings.disabled).toBe(false)
      // 齿轮在场且**不被播报**：按钮自己的文字已经报了名，图标再报一次就是噪音。
      const gear = settings.querySelector('svg.dsm-qoder-composer-panel-settings-icon')
      expect(gear).not.toBeNull()
      expect(gear!.getAttribute('aria-hidden')).toBe('true')
      // 右对齐靠外壳的 auto margin，不靠按钮自己 —— 按钮缺席时标题不该移位。
      expect(settings.parentElement?.className).toBe('dsm-qoder-composer-panel-actions')

      // 左那颗：刷新。它走的是**玩家池**的批量探针 —— 与设置页账号池工具栏
      // 那颗「一键测试所有账号」同一条路（POST /pool?action=test），所以两处
      // 测出来的结论必然一致。
      const refresh = panel.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-refresh')!
      expect(refresh).not.toBeNull()
      expect(refresh.textContent).toBe(t('composer.refresh'))
      expect(refresh.disabled).toBe(false)
      // 循环箭头同样不被播报。
      const icon = refresh.querySelector('svg.dsm-qoder-composer-panel-refresh-icon')
      expect(icon).not.toBeNull()
      expect(icon!.getAttribute('aria-hidden')).toBe('true')
      // **顺序**：刷新在左、设置在右（先看结论，再去改配置）。
      const actions = panel.querySelector('.dsm-qoder-composer-panel-actions')!
      expect(Array.from(actions.children).map(child => child.className)).toEqual([
        'dsm-qoder-composer-panel-refresh',
        'dsm-qoder-composer-panel-settings',
      ])

      await act(async () => { refresh.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      // 它发的是批量探针请求。
      expect(counts.test).toBe(1)
      // 点「刷新」**不**关面板：用户要看的就是圆点一行一行翻新。
      expect(document.querySelector('.dsm-qoder-composer-panel')).not.toBeNull()

      await act(async () => { settings.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(opened).toBe(1)
      // 面板自己先关闭：设置页要接管中央面板，浮层留在半空只会挡路。
      expect(document.querySelector('.dsm-qoder-composer-panel')).toBeNull()
    }, () => { opened += 1 })
  })

  it('没有池成员时，「刷新」那颗是禁用的（而不是点下去才发现没事可做）', async () => {
    // 两种「没有可测的东西」：宿主不发 pool 段（旧宿主）、池成员名单空。它们都
    // 该得到同一颗置灰的按钮。
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
    ], async (panel) => {
      const refresh = panel.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-refresh')!
      expect(refresh).not.toBeNull()
      expect(refresh.disabled).toBe(true)
    }, undefined, {
      enabled: true,
      checkinSupported: true,
      targetModelId: 'qmodel_38max',
      targetModelSource: 'preferred',
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [],
    })
  })

  it('池关着时「刷新」那颗**照样可点**（手动动作不受池开关约束）', async () => {
    // 宿主的 `pool.test` 走 `scope = prefs.memberAccountIds`——它**不看**池的开关：
    // 池的开关管的是「插件要不要替用户自动选号/换号」，不是「用户能不能对勾选过
    // 的号点一下测试」（workbuddy 在那边把这条写成了显式理由）。
    // 若这里按 `pool.enabled` 判定，池关着的用户就点不到那颗按钮，而宿主明明会
    // 照跑 —— 按钮会「点不动」，但请求其实是能发的。
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
    ], async (panel, counts) => {
      const refresh = panel.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-refresh')!
      expect(refresh.disabled).toBe(false)
      await act(async () => { refresh.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(counts.test).toBe(1)
    }, undefined, {
      enabled: false,
      checkinSupported: true,
      targetModelId: 'qmodel_38max',
      targetModelSource: 'preferred',
      memberAccountIds: ['a-cur'],
      effectiveMemberAccountIds: ['a-cur'],
      accounts: [],
    })
  })

  it('宿主没挂 Plugins 页时，页头不渲染那颗按钮（而不是渲染一个点了没反应的）', async () => {
    // 一台不声明 `pluginNavigation` 的宿主没有可去的地方。渲染一颗死按钮比
    // 干脆不渲染更糟 —— 用户会以为它坏了。
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
    ], async (panel) => {
      expect(panel.querySelector('button.dsm-qoder-composer-panel-settings')).toBeNull()
      // 但那个外壳**仍在**：页头排布在两种情形下必须一致，否则按钮消失时
      // 标题会因为 auto margin 一起消失而左移。
      expect(panel.querySelector('.dsm-qoder-composer-panel-actions')).not.toBeNull()
      // 「刷新」不依赖任何宿主服务（走本插件自己的池路由），所以它照常在。
      expect(panel.querySelector('button.dsm-qoder-composer-panel-refresh')).not.toBeNull()
    })
  })

  it('openSettings 穿过 gate 那一层到达面板（漏转发就等于按钮不存在）', async () => {
    // 真实缺陷的回归：`ComposerCreditsGate` 只做「该不该画」的判定，但它站在
    // props 的必经之路上。早先它收下 `openSettings` 却没往下传 —— 入口传了、
    // 面板也支持，可按钮就是不出现，而且两侧各自的测试全绿（一个只测面板、一个
    // 只测入口）。这条用例走的是**完整的 gate → 面板**链路，所以漏转发会红。
    // 不用 `drawGate`：它在返回前就卸载并移除了容器，这里要一直挂着才点得到。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'signed-out', accounts: [] }),
    } as Response)))
    let opened = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(ComposerCreditsGate, {
        t,
        openSettings: () => { opened += 1 },
        useProjection: () => ({ next: { provider: 'qoder' } }),
      } as any))
    })
    // 空应答（signed-out），面板仍会画出自己的根节点。
    const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const button = document.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-settings')
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    expect(opened).toBe(1)
  })
})

/**
 * 页头控件的 CSS 契约。
 *
 * 与组件测试同一条纪律，但断的是**样式表本身**：组件测试跑在 jsdom 里，而 jsdom
 * 不做样式计算，所以「按钮用了哪个类」能断，「那颗药丸有没有底色」断不了 —— 它
 * 只会读到类名。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 同款契约测试（`tests/settings-route.spec.tsx` 的「settings control CSS
 *   contract」一组）。
 */
describe('页头控件的 CSS 契约', () => {
  const ruleOf = (className: string): string =>
    new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(QODER_COMPOSER_CSS)?.[1] ?? ''

  it('页头渲染的每个类都有对应规则（没规则的类 = 浏览器默认按钮）', () => {
    for (const name of [
      'dsm-qoder-composer-panel-actions',
      'dsm-qoder-composer-panel-settings',
      'dsm-qoder-composer-panel-settings-icon',
      'dsm-qoder-composer-panel-settings-label',
      'dsm-qoder-composer-panel-refresh',
      'dsm-qoder-composer-panel-refresh-icon',
      'dsm-qoder-composer-panel-refresh-label',
    ]) {
      expect(QODER_COMPOSER_CSS, `${name} 应当有规则`).toContain(`.${name}{`)
    }
  })

  it('「刷新」是**透明底**的安静药丸，「设置」才是有底色的那颗', () => {
    // 参照图（workbuddy 真实宿主里的渲染）：刷新是灰字透明底，设置是淡紫底深色字。
    // 两个一样响的胶囊会让页头读成一条工具栏，而「设置」是那个离开面板的动作。
    const refresh = ruleOf('dsm-qoder-composer-panel-refresh')
    expect(refresh).toContain('background:transparent')
    expect(refresh).not.toContain('background:rgba')
    // 文字用次级色。
    expect(refresh).toContain('color:var(--dsw-alias-label-secondary')
    // 设置那颗有底色（品牌色 10%）。
    expect(ruleOf('dsm-qoder-composer-panel-settings')).toContain('background:rgba(86,134,254,.10)')
  })

  it('右对齐由**外壳**负责，不是按钮自己', () => {
    // 外壳总是渲染，按钮不是（宿主没有去处的路由时不渲染）。把 auto margin 放在
    // 按钮上，就等于让页头排布取决于宿主恰好提供不提供那条路由。
    const wrapper = ruleOf('dsm-qoder-composer-panel-actions')
    expect(wrapper).toContain('margin-left:auto')
    expect(wrapper).toContain('display:flex')
    expect(ruleOf('dsm-qoder-composer-panel-settings')).not.toContain('margin-left:auto')
    expect(ruleOf('dsm-qoder-composer-panel-refresh')).not.toContain('margin-left:auto')
  })

  it('批次在飞时箭头会转，且减弱动效下**不消失**（它是「还活着」的唯一提示）', () => {
    expect(QODER_COMPOSER_CSS).toContain('.dsm-qoder-composer-panel-refresh-icon-spin{animation:')
    // 减弱动效下改成变暗，而不是 `animation:none` 之后什么都不剩。样式表里有**两段**
    // `prefers-reduced-motion` 块（设置按钮一段、刷新按钮一段），所以逐段看。
    const blocks = QODER_COMPOSER_CSS.match(/@media \(prefers-reduced-motion:reduce\)\{[^@]*?\n\}/g) ?? []
    const mentions = blocks.some(block => block.includes('dsm-qoder-composer-panel-refresh-icon-spin'))
    expect(mentions, '减弱动效的块里必须有刷新箭头那条规则').toBe(true)
    // 变暗，而不是消失。
    const dimmed = blocks.find(block => block.includes('dsm-qoder-composer-panel-refresh-icon-spin')) ?? ''
    expect(dimmed).toContain('opacity:')
  })
})
