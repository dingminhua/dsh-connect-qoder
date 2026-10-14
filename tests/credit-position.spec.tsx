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
