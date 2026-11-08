// @vitest-environment jsdom
/**
 * 打上游的自动刷新间隔（`pollMinutes`）：一个全局配置项，五档，默认 5 分钟。
 *
 * 为什么值得单独一个文件：这个设置同时驱动**两个**表面（设置页卡片的 60s→可配
 * 轮询、输入框积分读数的 300s→可配轮询）与**一条**服务端投影（`/usage` 文档里的
 * `pollMinutes`），三处读的是同一个字段。任何一处读错（读成区域级、读成自由数字、
 * 写入后不重建定时器）都不会报错，只会表现为「改了没反应」或「每分钟多打一次上游」。
 *
 * 变异验证见 CHANGELOG：把默认改回 60_000、把白名单去掉、把 effect 依赖去掉，
 * 各自都有用例转红。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import {
  QODER_POLL_MINUTES_DEFAULT,
  QODER_POLL_MINUTES_OPTIONS,
  pollMinutesOf,
} from '../src/status-paths.ts'
import type { QoderPollMinutes } from '../src/status-paths.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 与 locales.ts 的测试替身同规：键原样返回，参数拼在后面。 */
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as never

/** 一个最小可用的 signed-in 文档；轮询断言只数请求次数，不读数字。 */
const usageDoc = (region: string): Record<string, unknown> => ({
  status: 'signed-in',
  accountId: 'a1',
  accountName: 'acct-demo',
  region,
  enabled: true,
  showCreditsInMainUi: true,
  selectionExplicit: false,
  accounts: [{ id: 'a1', accountName: 'acct-demo', source: 'vault', selected: true }],
  models: [],
  enabledModelKeys: [],
  offModelKeys: [],
  imageModelKeys: [],
  credits: { total: 888, expiringSoon: 0, packages: [] },
})

/** 记录每一次 /usage 请求的时刻（假时钟下的 `Date.now()`）。 */
function stubUsageFetch(): { hits: number[] } {
  const hits: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/plugins/dsh-connect-qoder/usage')) {
      hits.push(Date.now())
      const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
      return { ok: true, status: 200, json: async () => usageDoc(region) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))
  return { hits }
}

/** 一个可写的 settings 镜像：getSnapshot 读活对象，set 写进去。 */
function scopeOf(value: Record<string, unknown>): {
  getSnapshot: () => { value: Record<string, unknown> }
  set: (field: string, next: unknown) => Promise<boolean>
  subscribe: (listener: () => void) => () => void
  value: Record<string, unknown>
} {
  const listeners = new Set<() => void>()
  const scope = {
    value,
    getSnapshot: () => ({ value: scope.value }),
    set: async (field: string, next: unknown) => {
      scope.value = { ...scope.value, [field]: next }
      for (const listener of [...listeners]) listener()
      return true
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return scope
}

async function mountCardWith(scope?: unknown): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(QoderCard, {
      t,
      view: 'page',
      ...scope === undefined ? {} : { settingsScope: scope },
    } as never))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date('2026-11-09T02:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('pollMinutesOf：配置是用户可编辑的 JSON，读它必须白名单', () => {
  it('没写过就是默认 5', () => {
    expect(pollMinutesOf(undefined)).toBe(QODER_POLL_MINUTES_DEFAULT)
    expect(pollMinutesOf({})).toBe(5)
    expect(QODER_POLL_MINUTES_DEFAULT).toBe(5)
  })

  it('五档都认', () => {
    expect(QODER_POLL_MINUTES_OPTIONS).toEqual([1, 5, 10, 30, 60])
    for (const minutes of QODER_POLL_MINUTES_OPTIONS) {
      expect(pollMinutesOf({ pollMinutes: minutes })).toBe(minutes)
    }
  })

  it('手改的坏值退回默认，而不是把 setInterval 交给一个没校验的数', () => {
    // 0 / 负数会变成每秒打点；字符串与浮点是「看起来像数字」。
    for (const bad of [0, -5, 2.5, '5', null, [], 7]) {
      expect(pollMinutesOf({ pollMinutes: bad })).toBe(5)
    }
  })
})

describe('卡片轮询：间隔来自配置，改完立即重建定时器', () => {
  it('没有 scope 时按默认 5 分钟轮询（不是旧的写死 60s）', async () => {
    const { hits } = stubUsageFetch()
    const { unmount } = await mountCardWith()
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const afterMount = hits.length
      expect(afterMount).toBeGreaterThan(0)

      // 4 分钟时还没有下一轮。
      await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
      expect(hits.length).toBe(afterMount)

      // 到 5 分钟整，两个区域各一次。
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterMount + 2)
    } finally {
      await unmount()
    }
  })

  it('scope 里写 1 分钟时，轮询就是每分钟一次', async () => {
    const { hits } = stubUsageFetch()
    const scope = scopeOf({ pollMinutes: 1 })
    const { unmount } = await mountCardWith(scope)
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const afterMount = hits.length
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterMount + 2)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterMount + 4)
    } finally {
      await unmount()
    }
  })

  it('运行中改配置：旧定时器被拆、新节奏接管（不必重开卡片）', async () => {
    // 时点刻意错开：旧节奏 10 分钟的下一跳在 t=10min，改配置发生在 t=5min，
    // 新节奏 1 分钟的跳在 6min、7min……若旧定时器没被拆，t=10min 那一刻会**多出**
    // 一跳（+2），与 1 分钟节奏的那一跳叠在同一毫秒 —— 计数就会是 +10 而不是 +8。
    const { hits } = stubUsageFetch()
    const scope = scopeOf({ pollMinutes: 10 })
    const { unmount } = await mountCardWith(scope)
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const afterMount = hits.length
      // 4 分钟没有动静（10 分钟节奏还没到）。
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
      expect(hits.length).toBe(afterMount)

      // 改配置的那一帧：卡片会**立即重读一次**（镜像变化触发 revision 重读，
      // 既有行为：设置改了，屏幕上的事实就该跟着问一遍）。这不是轮询跳。
      await act(async () => { await scope.set('pollMinutes', 1) })
      const afterBurst = hits.length
      expect(afterBurst).toBeGreaterThan(afterMount)

      // 之后是 1 分钟节奏：连续两个 60s 窗口各 +2。
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterBurst + 2)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterBurst + 4)

      // 推到旧 10 分钟定时器本该跳的时刻：只有 1 分钟节奏的跳，没有多出来的一跳。
      const before = hits.length
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
      expect(hits.length).toBe(before + 8)
    } finally {
      await unmount()
    }
  })
})

describe('能力栏里的下拉框', () => {
  it('五个选项、当前值来自配置、改它写回 scope', async () => {
    stubUsageFetch()
    const scope = scopeOf({ pollMinutes: 10 })
    const { container, unmount } = await mountCardWith(scope)
    try {
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-poll-minutes')
      expect(select).not.toBeNull()
      expect(Array.from(select!.options).map(o => o.value)).toEqual(['1', '5', '10', '30', '60'])
      expect(select!.value).toBe('10')

      await act(async () => {
        select!.value = '30'
        select!.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(scope.value['pollMinutes']).toBe(30)
    } finally {
      await unmount()
    }
  })

  it('没有 scope 时下拉框禁用（写不进去的东西不给点）', async () => {
    stubUsageFetch()
    const { container, unmount } = await mountCardWith()
    try {
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-poll-minutes')
      expect(select).not.toBeNull()
      expect(select!.disabled).toBe(true)
      // 仍然显示默认值，而不是空白 —— 「有这个选项」本身不该消失。
      expect(select!.value).toBe('5')
    } finally {
      await unmount()
    }
  })

  it('坏配置在界面上显示默认值，而不是空白或崩溃', async () => {
    stubUsageFetch()
    const scope = scopeOf({ pollMinutes: 0 })
    const { container, unmount } = await mountCardWith(scope)
    try {
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-poll-minutes')
      expect(select!.value).toBe('5')
    } finally {
      await unmount()
    }
  })
})

describe('输入框积分读数：同一条节奏', () => {
  async function mountComposer(scope?: unknown): Promise<{ unmount: () => Promise<void> }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(ComposerCredits, {
        t,
        provider: 'qoder',
        region: 'cn',
        ...scope === undefined ? {} : { settingsScope: scope },
      } as never))
    })
    return {
      async unmount() {
        await act(async () => { root.unmount() })
        container.remove()
      },
    }
  }

  it('scope 写 10 分钟时，读数按 10 分钟重读（不是写死的 5 分钟）', async () => {
    const { hits } = stubUsageFetch()
    const scope = scopeOf({ pollMinutes: 10 })
    const { unmount } = await mountComposer(scope)
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const afterMount = hits.length
      expect(afterMount).toBeGreaterThan(0)
      // 9 分钟没有第二次。
      await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000) })
      expect(hits.length).toBe(afterMount)
      // 到 10 分钟整重读。
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterMount + 1)
    } finally {
      await unmount()
    }
  })

  it('没有 scope 时仍是这个设置存在之前的 300s（升级不动屏幕）', async () => {
    const { hits } = stubUsageFetch()
    const { unmount } = await mountComposer()
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const afterMount = hits.length
      await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
      expect(hits.length).toBe(afterMount)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(hits.length).toBe(afterMount + 1)
    } finally {
      await unmount()
    }
  })
})

describe('类型边界', () => {
  it('五档是穷举的联合类型（编译期挡住第六个值）', () => {
    const minutes: QoderPollMinutes = 60
    expect(QODER_POLL_MINUTES_OPTIONS.includes(minutes)).toBe(true)
  })
})
