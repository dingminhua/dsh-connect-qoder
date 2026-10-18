// @vitest-environment jsdom
/**
 * 积分读数的**席位**可选（对齐 dsh-connect-workbuddy issue #62 / 其 commit
 * f16b05f，MIT，Copyright (c) 2026 LaoDing）。
 *
 * 报告的问题是：装了第三方插件之后，输入框里的积分余额就不显示了。根因是位置
 * 本身——`conversation.input.left`（输入框工具栏）是**共享的 list 插槽**，shell
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextRegionCreditPosition,
  regionCreditPositionOf,
  regionCreditsShownOf,
  unwrapVolatileDeep,
} from '../src/status-paths.ts'
import { ComposerCreditsGate, composerCreditsRegionOf } from '../src/client/ComposerCreditsGate.tsx'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'

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
  }

  /**
   * 挂载 → 开面板 → 把面板交给断言回调 → 拆卸。
   * `counts.accountCredits` 数账号表请求次数、`counts.test` 数「一键测试」的
   * 探针请求次数（两者都是既有回归点）。
   */
  async function withPanel(
    rows: Record<string, unknown>[],
    run: (panel: HTMLElement, counts: { accountCredits: number, test: number }) => Promise<void>,
  ): Promise<void> {
    const counts = { accountCredits: 0, test: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/account-credits')) {
        counts.accountCredits += 1
        return { ok: true, status: 200, json: async () => rows } as Response
      }
      // 面板那颗「一键测试」走的就是设置页工具栏同一条路：POST pool?action=test。
      if (url.includes('/pool') && url.includes('action=test') && method === 'POST') {
        counts.test += 1
        return { ok: true, status: 200, json: async () => ({ action: 'test', rows: [] }) } as Response
      }
      // 进度轮询是只读的：这里不给批次，pull 会安静地什么都不做。
      if (url.includes('/pool') && url.includes('action=progress')) {
        return { ok: true, status: 200, json: async () => ({}) } as Response
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

  it('「一键测试」真的对池成员发探针，并把账号表重新取一遍', async () => {
    await withPanel([
      { id: 'a-cur', accountName: 'cur', selected: true, current: true },
    ], async (panel, counts) => {
      expect(counts.accountCredits).toBe(1) // 打开时取过一次
      const button = panel.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-panel-refresh')!
      // 这颗按钮不再是「刷新积分」：余额读不出「还能不能用」，点色靠探针。
      expect(button.textContent).toBe(t('composer.testAll'))
      expect(button.disabled).toBe(false)
      await act(async () => { button.click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(counts.test).toBe(1)
      expect(counts.accountCredits).toBe(2)
    })
  })
})
