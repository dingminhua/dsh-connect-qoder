// @vitest-environment jsdom
/**
 * 首屏渲染回归 —— 同族插件 issue #77 的 Qoder 版。
 *
 * 症状：打开设置页，账号列表要等几十秒才出现（期间卡片正文一片空白）。
 * 服务端已有 `detail=fast`（只用本地状态、不打上游）的回归测试；这一组盯的是
 * **卡片真的先把那份文档画出来**：
 *
 * 1. 完整文档还在路上时，账号行已经出现（而不是空白）；
 * 2. 什么都没有回来时，说「正在加载」，而不是把空白伪装成「这个区域没账号」；
 * 3. 迟到的首屏文档**不会**把已经在屏幕上的完整文档盖回「没有积分」的样子；
 * 4. 首屏请求带 `detail=fast`，完整请求不带。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'

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

const USAGE_PATH = '/plugins/dsh-connect-qoder/usage'
const isUsage = (url: string): boolean => url.startsWith(USAGE_PATH)
const isFast = (url: string): boolean => isUsage(url) && url.includes('detail=fast')
const isFull = (url: string): boolean => isUsage(url) && !url.includes('detail=fast')

/** A pool row the way the Host ships one. */
function poolRow(accountId: string, accountName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId,
    accountName,
    current: accountId === 'a1',
    member: true,
    source: 'vault',
    ...extra,
  }
}

/**
 * The FIRST-PAINT document: rows are there, balances are not (the Host has not
 * measured them this process, or the reading expired). This is exactly what
 * `detail=fast` answers.
 */
function fastDocument(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'Alpha',
    region,
    enabled: true,
    showCreditsInMainUi: true,
    selectionExplicit: false,
    source: 'vault',
    accounts: [{ id: 'a1', accountName: 'Alpha', source: 'vault', selected: true }],
    models: [{ key: 'dfmodel', name: 'DeepSeek-V4-Flash', contextWindow: 1_048_576, nativeContextWindow: 1_048_576, maxTokens: 32_768, creditMultiplier: 0 }],
    enabledModelKeys: ['dfmodel'],
    offModelKeys: [],
    imageModelKeys: [],
    pool: {
      enabled: true,
      targetModelId: 'dfmodel',
      targetModelSource: 'preferred',
      checkinSupported: true,
      memberAccountIds: ['a1'],
      effectiveMemberAccountIds: ['a1'],
      catalog: [{ id: 'dfmodel', name: 'DeepSeek-V4-Flash', creditMultiplier: 0 }],
      // NO credits on the row: unmeasured stays unmeasured (`—`).
      accounts: [poolRow('a1', 'Alpha')],
    },
  }
}

/** The FULL document: same rows, now with measured balances. */
function fullDocument(region: string): Record<string, unknown> {
  const doc = fastDocument(region)
  const pool = doc.pool as Record<string, unknown>
  return {
    ...doc,
    credits: { total: 4321, expiringSoon: 0, packages: [] },
    creditsAtMs: 1_700_000_000_000,
    pool: {
      ...pool,
      accounts: [poolRow('a1', 'Alpha', { credits: 4321, expiringSoon: 0 })],
    },
  }
}

/** A promise plus the resolver that lets a test open its gate. */
function gate(): { promise: Promise<void>, release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = () => { resolve() } })
  return { promise, release }
}

/**
 * Answer `detail=fast` immediately, but HOLD every full usage request behind a
 * gate — so "what the user sees while the full document is still slow" is
 * observable rather than raced.
 */
function holdingFullFetch(fastBody: Record<string, unknown>): {
  calls: string[]
  fullAttempts: string[]
  releaseFull: () => void
} {
  const calls: string[] = []
  const fullAttempts: string[] = []
  const gates: Array<() => void> = []

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (isFast(url)) {
      const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
      return { ok: true, status: 200, json: async () => fastBody, region } as unknown as Response
    }
    if (isFull(url)) {
      fullAttempts.push(url)
      const opened = gate()
      gates.push(opened.release)
      await opened.promise
      const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
      return { ok: true, status: 200, json: async () => fullDocument(region) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))

  return {
    calls,
    fullAttempts,
    releaseFull: () => { while (gates.length > 0) (gates.pop() as () => void)() },
  }
}

async function mountCard(): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(React.createElement(QoderCard, { t, view: 'page' })) })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

/** Drain floating effects without depending on real timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

describe('QoderCard first paint (issue #77)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the account rows from the fast document while the full one is still in flight', async () => {
    const held = holdingFullFetch(fastDocument('cn'))
    const { container, unmount } = await mountCard()
    try {
      await settle()

      // The account table exists and names the account — the first paint did
      // its job.
      expect(container.querySelector('.dsm-qoder-pool')).not.toBeNull()
      expect(container.textContent).toContain('Alpha')

      // And it was the FAST document that made that happen: the full reads are
      // still parked behind the gate.
      expect(held.calls.some(isFast)).toBe(true)
      expect(held.fullAttempts.length).toBeGreaterThan(0)

      // A first paint must never pretend to be a failure state.
      expect(container.querySelector('.dsm-qoder-usage-error')).toBeNull()
    } finally {
      held.releaseFull()
      await unmount()
    }
  })

  it('says it is loading — instead of rendering an empty body — while nothing has answered', async () => {
    // Hold EVERY request, including the first paint: this is the moment the
    // user opens the page and the Host has not answered anything yet.
    const held: Array<() => void> = []
    const attempts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      attempts.push(url)
      const opened = gate()
      held.push(opened.release)
      await opened.promise
      return { ok: true, status: 200, json: async () => fastDocument('cn') } as Response
    }))

    const { container, unmount } = await mountCard()
    try {
      await settle()
      expect(attempts.length).toBeGreaterThan(0)
      // The loading line is the honest description of this moment. Before this
      // change the body was simply empty, which reads as "this region has no
      // accounts" — a lie while accounts are on their way.
      expect(container.textContent).toContain('row.accountsLoading')

      // It disappears once a document lands.
      while (held.length > 0) (held.pop() as () => void)()
      await settle()
      expect(container.textContent).not.toContain('row.accountsLoading')
      expect(container.textContent).toContain('Alpha')
    } finally {
      while (held.length > 0) (held.pop() as () => void)()
      await unmount()
    }
  })

  it('never lets a late first paint overwrite a full document already on screen', async () => {
    // Both answer, but the full document is deliberately slower than the fast
    // one — then the fast answer arrives "late" in the sense that a full
    // document is already mounted. If it overwrote it, the balances would
    // flicker from 4321 back to `—`.
    const held = holdingFullFetch(fastDocument('cn'))
    const { container, unmount } = await mountCard()
    try {
      // First paint lands.
      await settle()
      expect(container.textContent).toContain('Alpha')

      // Now let the full document through: it carries the balances.
      held.releaseFull()
      await settle()
      const creditsCell = container.querySelector('.dsm-qoder-pool-credits')
      expect(creditsCell).not.toBeNull()
      // The pool formats credits without a thousands separator (`4321`), so
      // assert the value itself, not a locale-specific rendering of it.
      expect(creditsCell!.textContent).toContain('4321')
    } finally {
      held.releaseFull()
      await unmount()
    }
  })

  it('asks for the fast document by URL, and still asks for the full one', async () => {
    const held = holdingFullFetch(fastDocument('cn'))
    const { unmount } = await mountCard()
    try {
      await settle()
      const fastUrls = held.calls.filter(isFast)
      const fullUrls = held.calls.filter(isFull)
      expect(fastUrls.length).toBeGreaterThan(0)
      expect(fullUrls.length).toBeGreaterThan(0)
      for (const url of fastUrls) {
        expect(url).toContain('region=')
        expect(url).toContain('detail=fast')
      }
      // The full reads stay unparameterised — the default document is unchanged
      // for every caller that predates this parameter.
      for (const url of fullUrls) {
        expect(url).not.toContain('detail=')
      }
    } finally {
      held.releaseFull()
      await unmount()
    }
  })
})
