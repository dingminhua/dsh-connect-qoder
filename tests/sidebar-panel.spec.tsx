// @vitest-environment jsdom
/**
 * 可选的**侧边栏面板**（对齐 dsh-connect-workbuddy PR #188 / 其
 * `client/panel-switch.ts` + `Config.sidebarPanel`，MIT，Copyright (c) 2026
 * LaoDing）。
 *
 * 三件必须钉住的事，每件都在浏览器里才看得见、且错了都不会报错：
 *
 *  1. **默认关闭**：一项没写过的配置绝不能长出一行侧边栏。这一行占的是
 *     `sidebar.panellist` —— 所有插件共用的全局座位，还带一个 `main` 整页；
 *     「缺席」必须读成「没要」（`=== true`），不是「不反对」（`!== false`）。
 *  2. **注册是条件的**：`sidebar.panellist` 的行是拿插槽注册**元数据**渲染的
 *     （标签取 `options.label`、图标取 `renderSlot(...)`），所以一个 `return null`
 *     的组件留下的是**空白但可点击**的按钮，不是没有按钮。开关关着 => 这一行
 *     必须根本没有在册。
 *  3. **写什么、怎么算落地**：卡片把开关写到顶层的 `sidebarPanel`（不是
 *     `regions.<region>.`），并且只在写入被验证之后才让那一行出现。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QODER_SIDEBAR_PANEL_FIELD,
  QODER_SIDEBAR_PANEL_ID,
  sidebarPanelEnabledOf,
} from '../src/status-paths.ts'
import { apply } from '../src/client/index.tsx'
import {
  resetSidebarPanelWanted,
  setSidebarPanelWanted,
  sidebarPanelWanted,
  subscribeSidebarPanelWanted,
} from '../src/client/panel-switch.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// `apply` 的种子读取会真的 fetch 一次 `/usage`；这里让它失败，于是「种子」只可能
// 来自下面每条用例自己搭的那份输入。
beforeEach(() => {
  resetSidebarPanelWanted()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response))
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetSidebarPanelWanted()
})

// ---------------------------------------------------------------------------
// 读写 helper（纯函数，不需要 DOM）
// ---------------------------------------------------------------------------

describe('sidebarPanel 的读与写', () => {
  it('缺席 / false / 垃圾值都读成关闭，「没写过」不等于「同意」', () => {
    expect(sidebarPanelEnabledOf(undefined)).toBe(false)
    expect(sidebarPanelEnabledOf({})).toBe(false)
    expect(sidebarPanelEnabledOf({ regions: { cn: {} } })).toBe(false)
    expect(sidebarPanelEnabledOf({ sidebarPanel: false })).toBe(false)
    // 字符串 "true" 不是布尔真——一个手改坏的配置文件不能把全局座位占上。
    expect(sidebarPanelEnabledOf({ sidebarPanel: 'true' })).toBe(false)
    expect(sidebarPanelEnabledOf({ sidebarPanel: 1 })).toBe(false)
  })

  it('只有显式的 true 才读成打开（含 volatile 的 {get()} 形态）', () => {
    expect(sidebarPanelEnabledOf({ sidebarPanel: true })).toBe(true)
    // 宿主把 volatile 字段解析成活的 `{ get() }` 引用；不先解包就永远读到 false。
    expect(sidebarPanelEnabledOf({ sidebarPanel: { get: () => true } })).toBe(true)
  })

  it('写到**顶层** `sidebarPanel`，而不是某个区域槽里（没有区域轴）', () => {
    // 这一项决定的是「整个侧边栏有没有那一行」，与国内版/国际版无关。写进
    // `regions.<region>.` 就会出现「cn 开着、global 关着，那这一行算谁的」这种
    // 没有答案的状态。
    const body = { field: QODER_SIDEBAR_PANEL_FIELD, value: true }
    expect(body.field).toBe('sidebarPanel')
    expect(sidebarPanelEnabledOf({ [QODER_SIDEBAR_PANEL_FIELD]: body.value })).toBe(true)
    // 反过来：只写在区域槽里不算数。
    expect(sidebarPanelEnabledOf({ regions: { cn: { sidebarPanel: true } } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 开关 store
// ---------------------------------------------------------------------------

describe('panel-switch store', () => {
  it('默认关闭，且变化时才通知', () => {
    expect(sidebarPanelWanted()).toBe(false)
    const seen: boolean[] = []
    const off = subscribeSidebarPanelWanted(() => seen.push(sidebarPanelWanted()))
    setSidebarPanelWanted(false)   // 同值：不通知
    expect(seen).toEqual([])
    setSidebarPanelWanted(true)
    setSidebarPanelWanted(true)    // 同值：不通知（控制器会重复注册）
    expect(seen).toEqual([true])
    off()
    setSidebarPanelWanted(false)
    // 退订之后不再收到。
    expect(seen).toEqual([true])
  })

  it('一个坏监听者不拖垮其余', () => {
    expect(sidebarPanelWanted()).toBe(false)
    let good = 0
    const offBad = subscribeSidebarPanelWanted(() => { throw new Error('boom') })
    const offGood = subscribeSidebarPanelWanted(() => { good += 1 })
    setSidebarPanelWanted(true)
    expect(good).toBe(1)
    offBad()
    offGood()
  })
})

// ---------------------------------------------------------------------------
// 真实 apply()：注册是条件的
// ---------------------------------------------------------------------------

/** 一个保留 key 的翻译器：断言里能直接读出用了哪个 locale key。 */
const keyT = ((key: string) => key) as never

/** 一个槽位账本，模仿宿主「同一个 key/id 不能注册两次」的去重规则。 */
function slotsStub() {
  const ledger = new Map<string, { inject: () => unknown, dispose: () => void }>()
  const slots = {
    inject: (slotName: string, factory: () => (() => void)) => factory(),
    register: (options: { name: string; key?: string; id?: string; inject?: () => unknown }, _component: unknown) => {
      const cell = `${options.name}#${String(options.key ?? options.id)}`
      if (ledger.has(cell)) {
        throw new Error(`slot "${options.name}" already has an entry for "${String(options.key ?? options.id)}"`)
      }
      const entry = { inject: options.inject ?? ((): unknown => ({})), dispose: () => { ledger.delete(cell) } }
      ledger.set(cell, entry)
      return entry.dispose
    },
  }
  return {
    slots: slots as never,
    /** 当前在册的注册。 */
    live: (): string[] => [...ledger.keys()],
  }
}

/** 跑一次真实 apply，返回可观测面。 */
function mount(served: string[] = ['dsh-connect-qoder']): { live: () => string[] } {
  const stub = slotsStub()
  const ctx = {
    get: (name: string) => (name === 'configForms'
      ? {
          describe: () => ({ getSnapshot: () => ({ view: { namespaces: served.map(ns => ({ ns })) } }) }),
          get: (ns: string) => ({ __form: ns, status: 'ready' }),
          whileServed: (_namespaces: readonly string[], register: (s: ReadonlySet<string>) => () => void) => register(new Set(served)),
        }
      : undefined),
    effect: (run: () => unknown) => { run() },
    locale: { register: () => () => {}, bind: () => keyT },
    slots: stub.slots,
  }
  apply(ctx as never)
  return { live: stub.live }
}

describe('真实 apply()：侧边栏面板的注册是条件的', () => {
  it('默认（开关关闭）不注册侧边栏行，也不注册 main 页', () => {
    const { live } = mount()
    // 五个常驻座位仍在册。
    expect(live()).toHaveLength(5)
    expect(live()).not.toContain(`sidebar.panellist#${QODER_SIDEBAR_PANEL_ID}`)
    expect(live()).not.toContain(`main#${QODER_SIDEBAR_PANEL_ID}`)
  })

  it('打开开关后行与页都出现，且 id 与 key 同值（否则点了没反应）', () => {
    const { live } = mount()
    expect(live()).toHaveLength(5)
    setSidebarPanelWanted(true)
    expect(live()).toContain(`sidebar.panellist#${QODER_SIDEBAR_PANEL_ID}`)
    // 侧边栏按钮点下去选中的是「id 等于自己的 main 面板」：两者必须同值。
    expect(live()).toContain(`main#${QODER_SIDEBAR_PANEL_ID}`)
    expect(live()).toHaveLength(7)
  })

  it('再关掉时两条注册都被撤回（而不是留下一个空白按钮）', () => {
    const { live } = mount()
    setSidebarPanelWanted(true)
    expect(live()).toHaveLength(7)
    setSidebarPanelWanted(false)
    expect(live()).toHaveLength(5)
    expect(live()).not.toContain(`sidebar.panellist#${QODER_SIDEBAR_PANEL_ID}`)
    expect(live()).not.toContain(`main#${QODER_SIDEBAR_PANEL_ID}`)
  })

  it('反复翻开关不会撞「already has an entry」（先 dispose 再 register）', () => {
    const { live } = mount()
    for (let i = 0; i < 3; i += 1) {
      setSidebarPanelWanted(true)
      setSidebarPanelWanted(false)
    }
    setSidebarPanelWanted(true)
    expect(live()).toHaveLength(7)
  })
})

// ---------------------------------------------------------------------------
// 卡片：开关渲染 + 写入
// ---------------------------------------------------------------------------

/** usage 文档（只要够渲染出积分偏好那一段即可）。 */
function usageDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region: 'cn',
    enabled: true,
    showCreditsInMainUi: true,
    creditPosition: 'composer',
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'settings', selected: true }],
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
    imageSelectionSaved: true,
    pool: {
      enabled: false,
      checkinSupported: true,
      targetModelId: '',
      targetModelSource: 'none',
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [],
      catalog: [],
    },
    ...extra,
  }
}

/** Mount the real card with a settings scope, answering `/usage` from `doc`. */
async function mountCard(options: {
  doc?: (() => Record<string, unknown>)
  value?: unknown
  set?: (field: string, value: unknown) => Promise<boolean | void>
  save?: (body: Record<string, unknown>) => { ok: boolean, body?: Record<string, unknown> }
  surface?: 'card' | 'page'
  back?: () => void
} = {}): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const doc = options.doc ?? ((): Record<string, unknown> => usageDoc())
  const saves: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/plugins/dsh-connect-qoder/usage')) {
      return { ok: true, status: 200, json: async () => doc() } as Response
    }
    if (url.includes('/plugins/dsh-connect-qoder/__save')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      saves.push(body)
      const answer = options.save?.(body) ?? { ok: true }
      return {
        ok: answer.ok,
        status: answer.ok ? 200 : 500,
        json: async () => answer.body ?? { ok: true },
      } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))
  const settingsScope = {
    getSnapshot: () => ({ status: 'ready', value: options.value ?? {}, writable: true }),
    subscribe: () => () => {},
    set: options.set ?? (async () => true),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const { QoderCard } = await import('../src/client/QoderCard.tsx')
  await act(async () => {
    root.render(React.createElement(QoderCard, {
      t: keyT,
      view: 'page',
      settingsScope,
      ...options.surface === undefined ? {} : { surface: options.surface },
      ...options.back === undefined ? {} : { backToConversation: options.back },
    } as never))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
      void saves
    },
  }
}

describe('卡片里的侧边栏开关', () => {
  it('值取自 Host 的 usage 应答（不是可能陈旧的浏览器镜像）', async () => {
    // settings 镜像说 false，Host 说 true：控件必须跟 Host。
    const { container, unmount } = await mountCard({
      doc: () => usageDoc({ sidebarPanelEnabled: true }),
      value: { sidebarPanel: false },
    })
    try {
      const box = container.querySelector<HTMLInputElement>('input.dsm-qoder-sidebar-panel-check')
      expect(box).not.toBeNull()
      expect(box!.checked).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('Host 没提这一项时读作关闭', async () => {
    const { container, unmount } = await mountCard()
    try {
      const box = container.querySelector<HTMLInputElement>('input.dsm-qoder-sidebar-panel-check')
      expect(box).not.toBeNull()
      expect(box!.checked).toBe(false)
    } finally {
      await unmount()
    }
  })

  it('写的是顶层的 sidebarPanel，不是 regions.<region>', async () => {
    const bodies: Record<string, unknown>[] = []
    const { container, unmount } = await mountCard({
      save: body => { bodies.push(body); return { ok: true, body: { ok: true } } },
    })
    try {
      const box = container.querySelector<HTMLInputElement>('input.dsm-qoder-sidebar-panel-check')!
      await act(async () => {
        box.click()
      })
      await act(async () => { await Promise.resolve() })
      expect(bodies.length).toBeGreaterThan(0)
      const body = bodies[0]!
      expect(body['field']).toBe(QODER_SIDEBAR_PANEL_FIELD)
      // 顶层标量：body 的 value 就是这个布尔值本身，没有区域包装。
      expect(body['value']).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('写入落地之后才发布到开关 store（Host 拒绝过的值不长出一行）', async () => {
    const { container, unmount } = await mountCard({
      // 端点明确拒绝 —— 卡片必须既不显示打开、也不打开侧边栏那一行。
      save: () => ({ ok: false, body: { error: 'refused' } }),
      // 没有作用域可回退，于是写入的兜底也失败。
      set: async () => false,
    })
    try {
      const box = container.querySelector<HTMLInputElement>('input.dsm-qoder-sidebar-panel-check')!
      await act(async () => { box.click() })
      await act(async () => { await Promise.resolve() })
      expect(sidebarPanelWanted()).toBe(false)
      // 失败必须**就地**说出来：这一行在「账号」栏，而通用那条错误长在「模型」栏的
      // 保存行上——那一栏此刻可能根本没显示，只写在那里等于点了没反应。
      const alert = container.querySelector('.dsm-qoder-sidebar-panel-error')
      expect(alert).not.toBeNull()
      expect(alert!.getAttribute('role')).toBe('alert')
      expect(alert!.textContent).toContain('row.sidebarPanelFailed')
    } finally {
      await unmount()
    }
  })

  it('写入成功时把开关发布出去（那一行才会出现）', async () => {
    const { container, unmount } = await mountCard()
    try {
      const box = container.querySelector<HTMLInputElement>('input.dsm-qoder-sidebar-panel-check')!
      await act(async () => { box.click() })
      await act(async () => { await Promise.resolve() })
      expect(sidebarPanelWanted()).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('整页形态：有页头、没有折叠外壳（<li>），正文照常渲染', async () => {
    const back = vi.fn()
    const { container, unmount } = await mountCard({ surface: 'page', back })
    try {
      expect(container.querySelector('.dsm-qoder-page')).not.toBeNull()
      expect(container.querySelector('.dsm-qoder-page-head')).not.toBeNull()
      // 整页不是设置页里的一行：套上 <li class="dsm-plugin-card"> 会得到一个
      // 既不像列表项也不像页面的东西。
      expect(container.querySelector('li.dsm-plugin-card')).toBeNull()
      // 正文仍在（账号池就是它的证据）。
      expect(container.querySelector('.dsm-qoder-pool')).not.toBeNull()
      const button = container.querySelector<HTMLButtonElement>('button.dsm-qoder-page-back')!
      await act(async () => { button.click() })
      expect(back).toHaveBeenCalledTimes(1)
    } finally {
      await unmount()
    }
  })
})
