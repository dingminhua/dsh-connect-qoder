// @vitest-environment jsdom
/**
 * 卡片正文的分栏（账号 / 模型 / 诊断）。
 *
 * 卡片原来是一列长页，把两件互不相干的事混排在一起：运维账号（谁在服务、剩多少
 * 积分、池里哪几个）与编辑目录（勾模型、上下文预算、思考强度）。它们连**提交
 * 语义**都不同——账号改动点一下即生效，目录改动是草稿、必须点保存——于是保存
 * 按钮常常离它要保存的东西隔着几屏。
 *
 * 这里的每条断言各钉一个具体缺陷：
 *
 *   DEFAULT   默认落在账号栏。开在别的栏会把用户来看的账号状态藏起来。
 *   HIDDEN    非活动栏带 `hidden`，活动栏带 role="tabpanel"——前者把它移出无障碍树。
 *   MOUNTED   非活动栏**仍挂载**。这不是实现细节：卸载重挂会重新拉取 usage，并把
 *             一份填到一半的目录草稿丢掉。
 *   ARIA      恰好一个 tab 是 aria-selected，且每个 tab 与它的 panel 互相指向。
 *   DIAG      诊断栏只读：区域、上游域名、服务账号名、目录模型数、已启用数、
 *             账号池开关，失败原文照引。不许出现账号 id，也不许出现任何控件。
 *   DRAFT     诊断读的是**已保存**的值，不是草稿——把没保存的改动当事实报出去，
 *             给出的就是错的答案。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { QODER_UPSTREAM_DOMAIN } from '../src/status-paths.ts'

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

/** A signed-in usage document, trimmed to what these assertions read. */
function usageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'acct-id-should-not-be-printed',
    accountName: 'Alpha',
    region: 'cn',
    enabled: true,
    source: 'vault',
    showCreditsInMainUi: true,
    selectionExplicit: true,
    accounts: [{ id: 'acct-id-should-not-be-printed', accountName: 'Alpha', source: 'vault', selected: true }],
    models: [
      { key: 'qwen3-coder', name: 'Qwen3 Coder', contextWindow: 262_144, nativeContextWindow: 262_144, maxTokens: 65_536, creditMultiplier: 1 },
      { key: 'qwen3-free', name: 'Qwen3 Free', contextWindow: 131_072, nativeContextWindow: 131_072, maxTokens: 32_768, creditMultiplier: 0, isFree: true },
    ],
    enabledModelKeys: ['qwen3-coder'],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 92, expiringSoon: 0, packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'none',
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [],
      catalog: [],
    },
    ...overrides,
  }
}

function stubUsage(doc: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes(USAGE_PATH)) {
      return { ok: true, status: 200, json: async () => doc } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))
}

async function mountCard(): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(QoderCard, { t, view: 'page', settingsScope: writableScope() }))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

/**
 * A writable settings scope.
 *
 * Needed by every assertion that CLICKS a control: the card gates each one on
 * `canWrite(scope)`, which is false without a scope — so a checkbox would be
 * `disabled` and the click would silently do nothing, i.e. the draft test would
 * pass for the wrong reason (nothing was ever edited).
 */
function writableScope(): {
  getSnapshot: () => { value: Record<string, unknown> }
  set: () => Promise<boolean>
  subscribe: () => () => void
} {
  return {
    getSnapshot: () => ({ value: {} }),
    set: async () => true,
    subscribe: () => () => {},
  }
}

type Mounted = Awaited<ReturnType<typeof mountCard>>

/**
 * 按 id 找一个分栏或一个分栏 tab。
 *
 * 用「类名 + 对应 id」筛选而不是 `#id` 选择器：在这套 harness 里 id 选择器偶尔会
 * 对一棵明显存在的子树返回 null（同一个元素用 getElementById 与类名查询都能拿到）。
 * 逐项比对 id 既确定，也正是断言真正要表达的东西。
 */
const panel = (m: Mounted, id: string): HTMLElement => {
  const found = Array.from(m.container.querySelectorAll<HTMLElement>('.dsm-qoder-panel'))
    .find(element => element.id === `dsm-qoder-panel-${id}`)
  if (found === undefined) throw new Error(`no panel dsm-qoder-panel-${id}`)
  return found
}

const tab = (m: Mounted, id: string): HTMLButtonElement => {
  const found = Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-qoder-panels [role="tab"]'))
    .find(element => element.id === `dsm-qoder-tab-${id}`)
  if (found === undefined) throw new Error(`no tab dsm-qoder-tab-${id}`)
  return found
}

describe('卡片分栏（账号 / 模型 / 诊断）', () => {
  beforeEach(() => { stubUsage(usageOf()) })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('默认落在账号栏，另外两栏 hidden', async () => {
    const m = await mountCard()
    try {
      expect(panel(m, 'accounts').hidden).toBe(false)
      expect(panel(m, 'models').hidden).toBe(true)
      expect(panel(m, 'diag').hidden).toBe(true)
    } finally {
      await m.unmount()
    }
  })

  it('点「模型」切到模型栏，账号栏随之 hidden', async () => {
    const m = await mountCard()
    try {
      await act(async () => { tab(m, 'models').click() })
      expect(panel(m, 'models').hidden).toBe(false)
      expect(panel(m, 'accounts').hidden).toBe(true)
      // 栏里是真的模型区，不是摘要。
      expect(panel(m, 'models').querySelector('.dsm-qoder-model-list')).not.toBeNull()
      expect(panel(m, 'models').textContent).toContain('row.modelsTitle')
    } finally {
      await m.unmount()
    }
  })

  it('诊断栏报出卡片实际读到的值，且不打印账号 id', async () => {
    const m = await mountCard()
    try {
      await act(async () => { tab(m, 'diag').click() })
      const text = panel(m, 'diag').textContent ?? ''
      expect(panel(m, 'diag').hidden).toBe(false)

      // 区域与上游域名：域名为空/错就等于没回答这个问题。
      expect(text).toContain('row.diagRegion')
      expect(text).toContain('row.tabCn')
      expect(text).toContain('row.diagDomain')
      expect(text).toContain(QODER_UPSTREAM_DOMAIN.cn)
      // 国内版与国际版是**不同**的网关主机——这里的断言顺带钉住没读错区域。
      expect(QODER_UPSTREAM_DOMAIN.cn).not.toBe(QODER_UPSTREAM_DOMAIN.global)

      // 服务账号按**名字**报，不是 id。
      expect(text).toContain('row.diagAccount')
      expect(text).toContain('Alpha')
      expect(text).not.toContain('acct-id-should-not-be-printed')

      // 目录规模与已启用数。
      expect(text).toContain('row.diagCatalog')
      expect(text).toContain('row.diagEnabled')

      // 池开关，以及「没有报错」。
      expect(text).toContain('row.diagPool')
      expect(text).toContain('row.diagNoFailures')
    } finally {
      await m.unmount()
    }
  })

  it('诊断栏里没有任何控件 —— 它存在的唯一理由是被整段贴进反馈', async () => {
    const m = await mountCard()
    try {
      await act(async () => { tab(m, 'diag').click() })
      const diag = panel(m, 'diag')
      // 表里只有 label / value 两种 span；一个 input / select / button 都不许有。
      // 能改设置的「诊断」栏，只是一个名字更差的设置栏。
      for (const selector of ['input', 'select', 'textarea', 'button', 'a[href]']) {
        expect(diag.querySelectorAll(selector), `诊断栏不应渲染 ${selector}`).toHaveLength(0)
      }
    } finally {
      await m.unmount()
    }
  })

  it('非活动栏仍然挂载 —— 切回来不重新拉取、不丢未保存的草稿', async () => {
    const m = await mountCard()
    try {
      // 隐藏在 DOM 里：卸载重挂会重新拉取 usage，并把填到一半的目录草稿丢掉。
      expect(panel(m, 'accounts').querySelector('.dsm-qoder-pool')).not.toBeNull()
      expect(panel(m, 'models').querySelector('.dsm-qoder-model-list')).not.toBeNull()

      // 在模型栏勾一个模型（草稿），切去诊断栏再切回来。
      await act(async () => { tab(m, 'models').click() })
      const freeRow = Array.from(panel(m, 'models').querySelectorAll<HTMLElement>('.dsm-qoder-model'))
        .find(row => (row.textContent ?? '').includes('Qwen3 Free'))
      expect(freeRow).toBeDefined()
      const checkbox = freeRow!.querySelector<HTMLInputElement>('.dsm-qoder-model-enabled input')!
      await act(async () => { checkbox.click() })

      await act(async () => { tab(m, 'diag').click() })
      await act(async () => { tab(m, 'models').click() })

      // 草稿还在：那一行现在是勾上的，且「有未保存的修改」徽章仍挂着。
      const afterTrip = Array.from(panel(m, 'models').querySelectorAll<HTMLElement>('.dsm-qoder-model'))
        .find(row => (row.textContent ?? '').includes('Qwen3 Free'))
      expect(afterTrip!.querySelector<HTMLInputElement>('.dsm-qoder-model-enabled input')!.checked).toBe(true)
      expect(panel(m, 'models').textContent).toContain('row.modelsDirty')
    } finally {
      await m.unmount()
    }
  })

  it('诊断读已保存的值，不读草稿', async () => {
    // 诊断栏若报草稿，「已启用的模型」就会说出一个**还没落地**的数字——一份把
    // 未保存改动当事实的反馈，只会让排查走错方向。
    const m = await mountCard()
    try {
      await act(async () => { tab(m, 'models').click() })
      const freeRow = Array.from(panel(m, 'models').querySelectorAll<HTMLElement>('.dsm-qoder-model'))
        .find(row => (row.textContent ?? '').includes('Qwen3 Free'))
      await act(async () => {
        freeRow!.querySelector<HTMLInputElement>('.dsm-qoder-model-enabled input')!.click()
      })

      await act(async () => { tab(m, 'diag').click() })
      const enabledRow = Array.from(panel(m, 'diag').querySelectorAll<HTMLElement>('.dsm-qoder-diag-row'))
        .find(row => (row.textContent ?? '').includes('row.diagEnabled'))
      expect(enabledRow).toBeDefined()
      // 已保存的只有 1 个（qwen3-coder），草稿里是 2 个。
      expect(enabledRow!.querySelector('.dsm-qoder-diag-value')!.textContent).toBe('1')
    } finally {
      await m.unmount()
    }
  })

  it('失败原文照引，不翻译也不概括', async () => {
    stubUsage(usageOf({ refreshError: 'HTTP 503 upstream is kaput' }))
    const m = await mountCard()
    try {
      await act(async () => { tab(m, 'diag').click() })
      const failures = Array.from(panel(m, 'diag').querySelectorAll<HTMLElement>('.dsm-qoder-diag-row'))
        .find(row => (row.textContent ?? '').includes('row.diagFailures'))
      expect(failures).toBeDefined()
      // 上游自己的话，一字不改——这一栏存在的意义就是被引用。
      expect(failures!.textContent).toContain('HTTP 503 upstream is kaput')
      expect(failures!.textContent).not.toContain('row.diagNoFailures')
      // 标成「不好」的那一档，而不是普通 value。
      expect(failures!.querySelector('.dsm-qoder-diag-bad')).not.toBeNull()
    } finally {
      await m.unmount()
    }
  })

  it('恰好一个 tab 选中，且每个 tab 与它的 panel 互相指向', async () => {
    const m = await mountCard()
    try {
      const selected = (): HTMLButtonElement[] =>
        Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-qoder-panels [role="tab"][aria-selected="true"]'))

      expect(selected().map(button => button.id)).toEqual(['dsm-qoder-tab-accounts'])
      expect(tab(m, 'accounts').getAttribute('aria-controls')).toBe('dsm-qoder-panel-accounts')

      await act(async () => { tab(m, 'diag').click() })
      expect(selected().map(button => button.id)).toEqual(['dsm-qoder-tab-diag'])
      expect(tab(m, 'diag').getAttribute('aria-controls')).toBe('dsm-qoder-panel-diag')

      for (const id of ['accounts', 'models', 'diag']) {
        expect(panel(m, id).getAttribute('aria-labelledby')).toBe(`dsm-qoder-tab-${id}`)
        expect(panel(m, id).getAttribute('role')).toBe('tabpanel')
      }
    } finally {
      await m.unmount()
    }
  })

  it('切换分栏不发任何额外请求（非活动栏不卸载的直接后果）', async () => {
    const m = await mountCard()
    try {
      const callsAfterMount = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
      await act(async () => { tab(m, 'models').click() })
      await act(async () => { tab(m, 'diag').click() })
      await act(async () => { tab(m, 'accounts').click() })
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
        .toBe(callsAfterMount)
    } finally {
      await m.unmount()
    }
  })

  it('告警不落在任何一个分栏里 —— 失败不该被藏在一个不可见的 tab 后面', async () => {
    // 这一条是分栏这件事最容易犯的错：把「刷新失败 / 凭据被拒 / 选择丢失」这些
    // **必须立刻看到**的告警顺手放进账号栏，于是用户停在模型栏时完全不知道上游
    // 已经报错了。它们是整张卡片的告警，不属于任何一栏。
    stubUsage(usageOf({ refreshError: 'HTTP 503 upstream is kaput' }))
    const m = await mountCard()
    try {
      for (const id of ['accounts', 'models', 'diag'] as const) {
        await act(async () => { tab(m, id).click() })
        // 无论停在哪一栏，这句告警都在（它在分栏之外）。
        expect(m.container.textContent, `停在 ${id} 栏时看不到刷新失败`).toContain('row.requestFailedHint')
      }
      // 而且它**不在**任何 tabpanel 里。
      for (const id of ['accounts', 'models', 'diag']) {
        expect(panel(m, id).textContent ?? '').not.toContain('row.requestFailedHint')
      }
    } finally {
      await m.unmount()
    }
  })
})
