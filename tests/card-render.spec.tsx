// @vitest-environment jsdom
/**
 * 真实渲染 QoderCard 的结构性回归测试。
 *
 * 这两个用例盯的是 0.2.0 实际漏出去过的两类缺陷——它们都通过了 363 个
 * host 侧测试，因为那些测试从不执行组件：
 *
 * 1. **tab 栏结构**：曾把 `dsm-qoder-tab-dot`（7px 圆点样式）拼到 tab 容器上，
 *    整条 tab 栏塌成两个被裁掉的小药丸。源文本检查防不住这种错位（类名都
 *    合法、顺序换一下就漏），只有真的挂载组件、断言 DOM 结构才行。
 * 2. **模型名文案键**：曾把 `{model.name}` 写成 `{t('row.usageTotal')}`，每行
 *    模型名都渲染成「总量 / total」。用 key-preserving 的 `t` 渲染后，错误
 *    的键会以字面量 `row.usageTotal` 出现在 DOM 里，一眼可断。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— `tests/pool-render-helpers.tsx` 的挂载 harness 模式（act + key-preserving t）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'

// React 18.3 moved `act` onto the react export; the test-utils copy warns.
const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * A key-preserving translator: rendering real locale strings would couple
 * assertions to wording; returning the bare key makes a wrong-key regression
 * show up as the literal key text in the DOM.
 */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  if (params === undefined || params === null) return key
  return [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')
}

/** One model the way the host's usage route ships it. */
function modelOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    key: 'qwen3-coder',
    name: 'Qwen3 Coder',
    contextWindow: 262_144,
    nativeContextWindow: 262_144,
    maxTokens: 65_536,
    creditMultiplier: 1,
    ...overrides,
  }
}

/** A signed-in usage document for both regions. */
function usageDoc(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region,
    enabled: true,
    showCreditsInMainUi: true,
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'settings', selected: true }],
    models: [
      // 0.79 exercises the two-decimal padding: `(0.79x)`, never `(0.8x)`.
      modelOf({
        creditMultiplier: 0.79,
        // 实测档位序是 xhigh/low/medium——宿主已排好序，卡片照序显示，
        // 并把默认档括注出来。
        thinkingEfforts: ['low', 'medium', 'xhigh'],
        defaultThinkingEffort: 'medium',
      }),
      // 无档位模型（实测 auto / kmodel_latest）：不渲染那一项。
      modelOf({ key: 'qwen3-free', name: 'Qwen3 Free', creditMultiplier: 0, isFree: true }),
    ],
    enabledModelKeys: ['qwen3-coder'],
    offModelKeys: [],
    imageModelKeys: [],
  }
}

async function mountCard(): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  // view 'page'（bundle 页视图）下卡片默认展开 —— 与 workbuddy 的
  // `useState(view === 'page')` 同规；曾写成 `view === 'summary'` 导致
  // 设置页上默认收起。这里直接断言，不再点头部。
  await act(async () => { root.render(React.createElement(QoderCard, { t, view: 'page' })) })
  const header = container.querySelector<HTMLButtonElement>('button.dsm-plugin-card-header')
  expect(header).not.toBeNull()
  expect(header!.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('.dsm-plugin-card-body')).not.toBeNull()
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

describe('QoderCard render', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        return { ok: true, status: 200, json: async () => usageDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('tab 栏：每个 tab 是 cell > button.tab + label.switch，圆点只在按钮里', async () => {
    const { container, unmount } = await mountCard()
    try {
      const tabs = container.querySelector('.dsm-qoder-tabs')
      expect(tabs).not.toBeNull()
      expect(tabs!.getAttribute('role')).toBe('tablist')

      const cells = Array.from(tabs!.querySelectorAll(':scope > .dsm-qoder-tab-cell'))
      expect(cells).toHaveLength(2)
      for (const cell of cells) {
        expect(cell.querySelector(':scope > button.dsm-qoder-tab')).not.toBeNull()
        expect(cell.querySelector(':scope > label.dsm-qoder-tab-switch input[type="checkbox"]')).not.toBeNull()
      }

      // The 0.2.0 regression this guards: the dot class landed on the tab
      // CONTAINER, and `dsm-qoder-tab-dot` shrinks whatever carries it to a
      // 7px circle — the whole tab bar collapsed into two clipped pills.
      expect(container.querySelector('.dsm-qoder-tab.dsm-qoder-tab-dot')).toBeNull()
      // The dot is a span INSIDE the tab button, never a sibling class.
      const activeButton = tabs!.querySelector('button.dsm-qoder-tab-active')
      expect(activeButton).not.toBeNull()
      expect(activeButton!.getAttribute('role')).toBe('tab')
      expect(activeButton!.querySelector('span.dsm-qoder-tab-dot')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  // 形状照 `dsh-connect-trae` 的供应商格：**选中态挂在整格上**（描彩色边），
  // 不挂在里面的按钮上。按钮自带 inset 边框时，它外面还有一条通栏边框，两道
  // 边框相距几像素，看起来像渲染出错——用户给的参照图是一格一张卡片。
  it('tab 选中态挂在格子上：选中格的按钮与开关同属一个描边单位', async () => {
    const { container, unmount } = await mountCard()
    try {
      const tabs = container.querySelector('.dsm-qoder-tabs')!
      const cells = Array.from(tabs.querySelectorAll<HTMLElement>(':scope > .dsm-qoder-tab-cell'))
      const activeCells = cells.filter(cell => cell.classList.contains('dsm-qoder-tab-cell-active'))
      expect(activeCells).toHaveLength(1)
      const activeCell = activeCells[0]!
      // 那一格内部：选中的 tab 按钮 + 它的开关
      expect(activeCell.querySelector('button.dsm-qoder-tab-active')).not.toBeNull()
      expect(activeCell.querySelector('label.dsm-qoder-tab-switch input[type="checkbox"]')).not.toBeNull()
      // 另外那格不许冒领选中态
      for (const cell of cells) {
        if (cell === activeCell) continue
        expect(cell.classList.contains('dsm-qoder-tab-cell-active')).toBe(false)
      }
    } finally {
      await unmount()
    }
  })

  it('模型行渲染 displayName 与「免费」标记，而不是文案键字面量', async () => {
    const { container, unmount } = await mountCard()
    try {
      const names = Array.from(container.querySelectorAll('.dsm-qoder-model-name')).map(el => el.textContent ?? '')
      expect(names.length).toBeGreaterThanOrEqual(2)
      expect(names[0]).toContain('Qwen3 Coder')
      expect(names[1]).toContain('Qwen3 Free')
      // With the key-preserving translator a wrong key is literal DOM text:
      // both the model-name bug and the free-badge bug rendered
      // `row.usageTotal` ("总量") where the name / "免费" belonged.
      for (const name of names) expect(name).not.toContain('row.usageTotal')

      const freeBadge = Array.from(container.querySelectorAll('.dsm-qoder-model-meta-tag'))
        .find(el => el.textContent === 'row.modelFree')
      expect(freeBadge).toBeDefined()
    } finally {
      await unmount()
    }
  })

  it('模型行提供思考强度选择器（设置项），无档位的模型不渲染', async () => {
    const { container, unmount } = await mountCard()
    try {
      const metas = Array.from(container.querySelectorAll('.dsm-qoder-model-meta'))
      expect(metas).toHaveLength(2)

      // 第一行有档位：一个**可选择**的下拉（这是设置，选好保存后每个请求都
      // 带上），不是一行只读文字。
      const picker = metas[0]!.querySelector('.dsm-qoder-effort select')
      expect(picker).not.toBeNull()
      const values = Array.from(picker!.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value)
      // 空值 = 跟随上游默认（没有它用户选过一次就再也回不到默认）；其余是档位。
      expect(values[0]).toBe('')
      expect(values.slice(1)).toEqual(['low', 'medium', 'xhigh'])
      expect(metas[0]!.textContent).toContain('row.modelReasoningLabel')

      // 第二行（无档位）不渲染这一项：空控件会让人以为「支持思考却没有强度可选」。
      expect(metas[1]!.querySelector('.dsm-qoder-effort')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('模型行倍率用 workbuddy 的 (N.NNx) 形态，且不渲染模型 id 行', async () => {
    const { container, unmount } = await mountCard()
    try {
      const rates = Array.from(container.querySelectorAll('.dsm-qoder-model-name-rate')).map(el => el.textContent)
      // Two-decimal padding matters: 0.79 must not collapse to "0.8", and a
      // free model renders "(0.00x)" exactly as workbuddy spells it. The old
      // form was the localised sentence `积分 0.79x`.
      expect(rates).toEqual(['(0.79x)', '(0.00x)'])

      // The model id used to occupy its own line under the name. workbuddy's
      // row never shows it; here it survives only as the name's title tooltip.
      expect(container.querySelector('.dsm-qoder-model-id')).toBeNull()
      const first = container.querySelector('.dsm-qoder-model-name')
      expect(first!.getAttribute('title')).toBe('qwen3-coder')
    } finally {
      await unmount()
    }
  })

  it('模型行：测试按钮在头部行（带悬停提示），未测试时不渲染提示段落', async () => {
    const { container, unmount } = await mountCard()
    try {
      // workbuddy 同构：提示只作按钮 title；未探测的行没有任何探测文字。
      // 旧版把整段 probeHint 铺在每个模型行的独立 details 行里（截图里 9 行
      // 重复的同一句说明）。
      const head = container.querySelector('.dsm-qoder-model-head')
      expect(head).not.toBeNull()
      const probe = head!.querySelector('button.dsm-qoder-model-probe')
      expect(probe).not.toBeNull()
      expect(probe!.getAttribute('title')).toBe('row.probeHint')
      expect(container.querySelector('p.dsm-qoder-model-probe-result')).toBeNull()
      expect(container.textContent).not.toContain('row.probeHint')

      // 上下文档位选择器也挪进了头部行（workbuddy 的 fieldset 同位）。
      // 该 fixture 的模型无 contextTiers，picker 渲染为空 span——断言的是位置。
      // 能力注记在列表尾部出现一次。
      const notes = container.querySelectorAll('.dsm-qoder-model-capability-note')
      expect(notes).toHaveLength(1)
      expect(notes[0]!.textContent).toBe('row.modelCapabilityPending')
    } finally {
      await unmount()
    }
  })

  it('上下文档位选择器只留下拉，且档位不重复', async () => {
    // 两点都在用户实拍里暴露过：
    //  1. 标签「上下文」也被去掉——它挨着模型自己的上下文信息，下拉里的
    //     200K / 400K / 1M 已经说明在选什么。
    //  2. **档位重复**：此前额外前置了一个「原生窗口」选项，而上游的
    //     contextTiers 本身就以原生窗口开头（实测 [200000, 400000,
    //     1000000]），于是 200K 出现两次。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        const doc = usageDoc(region) as Record<string, unknown>
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...doc,
            // 原生窗口在档位里（上游实际形态），用来重现重复。
            models: [modelOf({ contextWindow: 262_144, contextTiers: [262_144, 524_288, 1_000_000] })],
            enabledModelKeys: ['qwen3-coder'],
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { container, unmount } = await mountCard()
    try {
      const picker = container.querySelector('.dsm-qoder-context-budget')
      expect(picker).not.toBeNull()
      // 没有可见标签了（无障碍名仍保留，读屏用户不能失去这一行的含义）。
      expect(picker!.textContent).not.toContain('row.contextBudget')
      expect(picker!.querySelector('select')?.getAttribute('aria-label')).toBe('row.contextBudget')

      const options = Array.from(picker!.querySelectorAll('option')).map(o => o.textContent)
      // 档位数 = 上游声明的档位数，一个不多。
      expect(options).toEqual(['262,144', '524,288', '1M'])
      // 重复项是这次回归的正题：同值只能出现一次。
      expect(new Set(options).size).toBe(options.length)

      // 样式：模型行里的选择器必须是「行内值」而非账号池的实心方块
      // （pool-num 是 13px 的框，放进 11px 的 meta/头部行会突兀——
      // 用户实拍：「这个字体样式很突兀」）。
      const select = picker!.querySelector('select')
      expect(select?.classList.contains('dsm-qoder-inline-select')).toBe(true)
      expect(select?.classList.contains('dsm-qoder-pool-num')).toBe(false)
      // 箭头由外层容器绘制（原生箭头在暗色主题下不可控）。
      expect(select?.closest('.dsm-qoder-inline')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('保存行与页脚：cheer 链接进 actions 行、无空错误容器、无未排版的 foot', async () => {
    const { container, unmount } = await mountCard()
    try {
      // The cheer link sits LEFT inside the model actions row, grey underlined,
      // with the star — the family pattern (workbuddy's model-actions row).
      const actions = container.querySelector('.dsm-qoder-model-actions')
      expect(actions).not.toBeNull()
      const cheer = actions!.querySelector('a.dsm-qoder-usage-cheer')
      expect(cheer).not.toBeNull()
      expect(cheer!.querySelector('.dsm-qoder-usage-cheer-star')).not.toBeNull()

      // No always-rendered empty error container: the error span exists only
      // alongside an actual error (an empty one still ate vertical space).
      expect(actions!.querySelector('.dsm-qoder-model-save-error')).toBeNull()

      // Discard is always rendered, disabled until the draft is dirty — the
      // same enabled-shape workbuddy's save row has.
      const buttons = Array.from(actions!.querySelectorAll('.dsm-qoder-model-actions-buttons button'))
      expect(buttons).toHaveLength(2)
      expect(buttons[0]!.textContent).toBe('row.discard')
      expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
      expect(buttons[1]!.textContent).toBe('row.save')

      // The old bare <footer> (class never had a CSS rule: default-blue link,
      // inert margin-left:auto) is gone, and no standing docs-hint line takes
      // its place: workbuddy's `usage-hint` appears only when it has something
      // to say (relogin needed / selection lost), never as a permanent footer.
      // (`tabHint` is a different, legitimate line — it explains the tab axis.)
      expect(container.querySelector('.dsm-qoder-foot')).toBeNull()
      const hints = Array.from(container.querySelectorAll('.dsm-qoder-usage-hint')).map(el => el.textContent ?? '')
      expect(hints).not.toContain('row.docsHint')
      expect(hints).not.toContain('')
    } finally {
      await unmount()
    }
  })

  it('卡片头部不再有账号选择器（它搬进了账号池设置区）', async () => {
    // 回归：这个下拉框原本在账号行区域，任何时候都出现——池开着时它改了不生效
    // （那时谁服务由排序决定），却长得像一个权威控件，「看着能改、其实改不了」
    // 比没有控件更糟。用户实拍 workbuddy 后要求照做：搬进账号池区块，变成
    // 「使用哪个账号」设置行，只在池确实关闭时渲染（见 pool-render.spec.tsx）。
    // 这里钉的是「头部不再有」，否则搬家会变成两处都有。
    const { container, unmount } = await mountCard()
    try {
      expect(container.querySelectorAll('.dsm-qoder-usage-select-wrap')).toHaveLength(0)
      expect(container.querySelectorAll('.dsm-qoder-usage-select')).toHaveLength(0)
    } finally {
      await unmount()
    }
  })

  it('账号行上的「重新读取账号」「移除」按钮已删除', async () => {
    // 「同名账号用 id 尾号区分」这条规则**没有消失**，它随下拉框一起搬进了
    // 账号池（`poolAccountLabel`，覆盖在 pool-render.spec.tsx）；这里只剩
    // 「账号行上这两个按钮已删除」这一半。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        const doc = usageDoc(region) as Record<string, unknown>
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...doc,
            accountId: 'pat-5d76517ac7699f87',
            accounts: [
              { id: 'pat-84ad6cf5b4f62d10', accountName: 'same@msn.com', source: 'vault', selected: false },
              { id: 'pat-5d76517ac7699f87', accountName: 'same@msn.com', source: 'vault', selected: true },
            ],
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { container, unmount } = await mountCard()
    try {
      // 账号行里那两个按钮（重新读取账号 / 移除）已删除（用户实拍要求）：
      // 前者做的事现在自动发生、且「重新读取授权文件」的语义早已过时；后者
      // 与账号池里的「移除」语义不同（删保险库记录 vs 移出池成员），容易混淆。
      const row = container.querySelector('.dsm-qoder-usage-account-actions')
      expect(row).toBeNull()
      expect(container.textContent).not.toContain('row.accountsRescan')
      expect(container.textContent).not.toContain('row.accountRemoveShort')
    } finally {
      await unmount()
    }
  })

  it('正文首块自带顶部间距：tab 栏不顶着上面那条分隔线', async () => {
    // 用户实拍：「国际版 国内版 不要顶着上面这条线，最基本的统一样式」。
    // `.dsm-plugin-card-body` 只有 padding:0 0 8px（上内边距为 0），所以正文的
    // 首个元素必须自带顶部间距。workbuddy 的 tab 栏被 `.dsm-workbuddy-usage`
    // （padding:16px 0 4px）托住，qoder 此前把这层容器拆掉了 → 直接贴线。
    const { container, unmount } = await mountCard()
    try {
      const body = container.querySelector('.dsm-plugin-card-body')
      expect(body).not.toBeNull()
      const first = body!.firstElementChild as HTMLElement | null
      // 首个元素是那层提供顶部间距的容器，tab 栏在它里面。
      expect(first?.classList.contains('dsm-qoder-usage')).toBe(true)
      expect(body!.querySelector('.dsm-qoder-tabs')?.parentElement?.classList.contains('dsm-qoder-usage'))
        .toBe(true)
    } finally {
      await unmount()
    }
  })

  it('卡片正文不再重复额度明细（下方账号池已按账号逐行显示）', async () => {
    // 用户实拍：红框那行「附加额度 · 92 / 100」与账号池表格的「积分」列说的是
    // 同一组数字（连到期时间都一样），而池里是逐账号显示、粒度更细。
    // 但**读不到**的情况必须留下：池行只能显示一个「—」，说不出为什么，而
    // `creditsError` 只存在于这份 usage 文档里。
    const withCredits = (credits: unknown): void => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/plugins/dsh-connect-qoder/usage')) {
          const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
          return { ok: true, status: 200, json: async () => ({ ...usageDoc(region), ...credits as object }) } as Response
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }))
    }

    // ① 有额度：正文里什么都不渲染（明细在池表格）。
    withCredits({
      credits: {
        total: 92,
        expiringSoon: 0,
        nearestExpiryMs: Date.UTC(2026, 11, 31, 0, 0),
        packages: [{ packageName: 'addon', remain: 92, size: 100, monthly: false }],
      },
    })
    {
      const { container, unmount } = await mountCard()
      try {
        const text = container.textContent ?? ''
        expect(text).not.toContain('row.usageBucketAddon')
        expect(text).not.toContain('row.usageExpiresAt')
        expect(container.querySelector('.dsm-qoder-usage-progress')).toBeNull()
      } finally {
        await unmount()
      }
    }

    // ② 读不到：仍然说出来，否则用户只看到一个「—」而不知道为什么。
    withCredits({ creditsError: 'credential-rejected' })
    {
      const { container, unmount } = await mountCard()
      try {
        expect(container.textContent).toContain('row.creditsError')
      } finally {
        await unmount()
      }
    }
  })
  // ==========================================================================
  // 零凭据区域（国际版实拍「看起来就是空的」）：账号池与它的添加入口必须在。
  //
  // `renderPool` 此前第一行就是 `if (signIn?.pool === undefined) return <span />`，
  // 而 `signIn` 只在 `status === 'signed-in'` 时存在 —— 于是没有 PAT 的区域永远
  // 拿到 `signed-out`，账号池整块不渲染，连同由它渲染的「添加 PAT / 导出导入」
  // 一起消失。**最需要添加第一个账号的页面，反而没有任何添加账号的入口。**
  // 宿主侧已修好一半（signed-out 支也带 pool），这一半是客户端剩下的部分。
  // ==========================================================================
  describe('零凭据区域（signed-out）', () => {
    /** A signed-out usage document carrying a zero-account pool, as the Host now sends. */
    const signedOutDoc = (region: string): Record<string, unknown> => ({
      status: 'signed-out',
      enabled: true,
      showCreditsInMainUi: true,
      selectionExplicit: false,
      selectionLost: false,
      accounts: [],
      message: '请填写 Qoder PAT（或设置环境变量）',
      // The Host includes the pool even with zero accounts; every row would be
      // `current: false`. With no rows at all, this is the empty-pool shape.
      pool: {
        enabled: false,
        checkinSupported: true,
        targetModelSource: 'none',
        memberAccountIds: [],
        effectiveMemberAccountIds: [],
        accounts: [],
        catalog: [],
      },
    })

    const withSignedOut = (doc?: Record<string, unknown>): void => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/plugins/dsh-connect-qoder/usage')) {
          const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
          return { ok: true, status: 200, json: async () => doc ?? signedOutDoc(region) } as Response
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }))
    }

    it('账号池仍然渲染 —— 国际版零凭据时不是一片空白', async () => {
      withSignedOut()
      const { container, unmount } = await mountCard()
      try {
        // 整块账号池在。这是这次修复的全部意义。
        expect(container.querySelector('.dsm-qoder-pool')).not.toBeNull()
        expect(container.textContent).toContain('row.poolTitle')
      } finally {
        await unmount()
      }
    })

    it('「添加 PAT」入口在 —— 零账号时唯一能添加账号的地方', async () => {
      withSignedOut()
      const { container, unmount } = await mountCard()
      try {
        // 添加 PAT 由账号池设置区渲染（renderPool 的 accountTools），所以
        // 账号池一消失，这个入口就没了。这就是「没有地方添加账号」。
        expect(container.querySelector('.dsm-qoder-pool-tools')).not.toBeNull()
        expect(container.textContent).toContain('row.addAccountStart')
        // 导出 / 导入同一处，也不能一起消失。
        // 按 **aria-label** 断言：账号工具条不再自己念一遍标题（workbuddy
        // 94c339f）——「导出 / 导入账号」压在「导出」「导入」两个同名按钮上，
        // 只是把按钮重说一次。名字保留在 <section> 的 aria-label 里，属性不进
        // textContent，所以这里必须换靶子，否则删掉标题后断言会悄悄变绿。
        expect(container.querySelector('.dsm-qoder-pool-tools [aria-label="row.transferTitle"]')).not.toBeNull()
        // 而且那条标题**不在屏幕上**：两个工具条都不再自己念一遍名字。
        expect(container.querySelectorAll('.dsm-qoder-bar-label').length).toBe(0)
      } finally {
        await unmount()
      }
    })

    it('空池给出「还没有账号」的说法，而不是「成员限流/积分耗尽」', async () => {
      withSignedOut()
      const { container, unmount } = await mountCard()
      try {
        expect(container.querySelector('.dsm-qoder-pool-empty')?.textContent).toBe('row.poolEmptyHint')
        // 一个成员都还没有，就不能说成员出了问题。
        expect(container.textContent).not.toContain('row.poolNoCandidate')
      } finally {
        await unmount()
      }
    })

    it('usage 读失败（status=error）时仍不渲染空壳池', async () => {
      // error 变体根本没有 pool 字段（那份文档没读成）。渲染一个空壳只会把错误行
      // 挤到下面 —— 与 workbuddy 同规，只留错误行。
      withSignedOut({ status: 'error', message: 'HTTP 500' })
      const { container, unmount } = await mountCard()
      try {
        expect(container.textContent).toContain('HTTP 500')
        expect(container.querySelector('.dsm-qoder-pool')).toBeNull()
      } finally {
        await unmount()
      }
    })
  })
})

// ==========================================================================
// cn / global 对等：一个区域被另一个区域取消掉请求 → 那个 tab 永远空白
// ==========================================================================

/**
 * 用户实拍「国际版还是缺少账号池这些功能」。两个独立缺陷叠在一起，都只影响
 * **非 cn** 的那个 tab，所以「cn 一切正常」的观察完全查不出来：
 *
 * 1. **共享一个 AbortController**：轮询里 `for (const region of QODER_REGIONS)
 *    void refresh(region)` 背靠背连发两次，cn 的请求刚建好就被 global 那次
 *    `controllers.current?.abort()` 取消掉（反之亦然）——同一时刻只有一个区域的
 *    usage 能落地。
 * 2. **挂载时只读 `cn`**：另一个区域要等 60 秒轮询才第一次有数据，所以切过去
 *    是空白，且没有任何补读。
 *
 * 断言用的是**同一份 signed-in 文档**：若两 tab 渲染出的东西不等，问题一定在
 * 客户端的区域分发，与上游、凭据、PAT 都无关。
 */
describe('cn / global 两个 tab 的渲染对等', () => {
  /** One signed-in document, region filled in per request. */
  const signedInDoc = (region: string): Record<string, unknown> => ({
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region,
    enabled: true,
    showCreditsInMainUi: true,
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'vault', selected: true }],
    models: [modelOf({ key: 'm1', name: 'M1', creditMultiplier: 0 })],
    enabledModelKeys: ['m1'],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 92, expiringSoon: 0, packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelId: 'm1',
      targetModelSource: 'preferred',
      memberAccountIds: ['a1'],
      effectiveMemberAccountIds: ['a1'],
      accounts: [{ accountId: 'a1', accountName: 'A1', current: true, member: true, source: 'vault', credits: 92 }],
      catalog: [{ id: 'm1', name: 'M1', creditMultiplier: 0 }],
    },
  })

  /** Everything a tab shows, so a one-sided gap shows up as an unequal object. */
  const inventoryOf = (host: HTMLElement): Record<string, unknown> => ({
    pool: host.querySelector('.dsm-qoder-pool') !== null,
    poolRows: host.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)').length,
    modelRows: host.querySelectorAll('.dsm-qoder-model').length,
    checkinButton: (host.textContent ?? '').includes('row.poolCheckinAll'),
    testButton: (host.textContent ?? '').includes('row.poolTestAll'),
    addPat: (host.textContent ?? '').includes('row.addAccountStart'),
    // 导出/导入的标题只存在于 aria-label（见上一条的说明）。
    transfer: host.querySelector('.dsm-qoder-pool-tools [aria-label="row.transferTitle"]') !== null,
    checkinColumn: (host.textContent ?? '').includes('row.poolColumnCheckin'),
  })

  it('国际版 tab 与国内版 tab 渲染出完全一样的池 / 模型 / 账号工具', async () => {
    /** The abort signal per request, so the stub can honour a real cancellation. */
    const signals = new Map<string, AbortSignal | undefined>()
    // **刻意让 usage 响应有延迟**：共享一个 AbortController 的那个缺陷只在请求
    // **重叠**时才显形 —— 挂载时两个区域背靠背连发，先发的那次会被后发的
    // `abort()` 掉。零延迟的桩两者都能立刻落地，缺陷就被掩盖了（第一版测试
    // 正是这样假通过的）。真实网络有延迟，所以这里必须模拟。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        signals.set(region, init?.signal as AbortSignal | undefined)
        await new Promise(resolve => setTimeout(resolve, 20))
        // 真实的 abort 会让 fetch 以 AbortError 拒绝；这里如实模拟，
        // 否则被取消的请求仍会「成功」，缺陷又被掩盖。
        if (signals.get(region)?.aborted === true) throw new DOMException('aborted', 'AbortError')
        return { ok: true, status: 200, json: async () => signedInDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { container, unmount } = await mountCard()
    try {
      // 两个区域都要有数据才谈得上对等：等待挂载时的两次读取落地（含延迟）。
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
      const cn = inventoryOf(container)
      // 切到国际版。切 tab 必须自己补读 —— 不许依赖「下一次轮询」。
      const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('button.dsm-qoder-tab'))
      expect(tabs).toHaveLength(2)
      await act(async () => {
        tabs[1]!.click()
        await new Promise(resolve => setTimeout(resolve, 30))
      })
      const global = inventoryOf(container)

      // 国际版一个都不少：账号池、成员行、模型行、签到、测试、添加 PAT、导出导入、签到列。
      expect(global.pool).toBe(true)
      expect(global.poolRows).toBe(1)
      expect(global.modelRows).toBe(1)
      expect(global.addPat).toBe(true)
      // 两条必须完全一致 —— 任何一侧少一样东西，这里就炸。
      expect(global).toEqual(cn)
    } finally {
      await unmount()
    }
  })

  it('一个区域的请求**不会**取消另一个区域的请求', async () => {
    // 直接钉住那条规则本身。`controllers[region].abort()` 取消的**只能是该区域
    // 上一次的请求**（同区域连续刷新只认最后一次）；若它取消的是**另一个区域**的
    // 请求，那个区域的数据永远落不了地。
    //
    // 判据：把请求按发起顺序排好，第 i 个被取消只可能是被第 i+1 个取消 ——
    // 所以「第 i 个被取消，而第 i+1 个属于别的区域」就是缺陷。
    // 注意：seq 只收**本次**挂载发起的请求 —— 断言时按发起顺序两两配对，
    // 若把别的挂载混进来，配对关系就乱了（第一版就是这么假通过的）。
    const seq: Array<{ region: string, signal: AbortSignal | undefined }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        seq.push({ region, signal: init?.signal as AbortSignal | undefined })
        // 有延迟，两个请求才会真正重叠（零延迟时缺陷被掩盖）。
        await new Promise(resolve => setTimeout(resolve, 25))
        if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
        return { ok: true, status: 200, json: async () => signedInDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { container, unmount } = await mountCard()
    try {
      // 等待足够长，让「有延迟」的两个 usage 请求都落地（每次 25ms，加上 act 的批处理）。
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
      // 两个区域都真的读过 —— 否则下面这条断言是空转。
      expect(new Set(seq.map(r => r.region))).toEqual(new Set(['cn', 'global']))
      // 判据：对每个**被取消**的请求，它之后必须还有一个**同区域**的请求 ——
      // 那才是合法的「只认最后一次」。若它之后只有别的区域的请求，说明它是被
      // 另一个区域顶掉的（缺陷），而它自己那个区域的数据也就永远落不了地。
      const crossRegion: string[] = []
      for (let i = 0; i < seq.length; i++) {
        if (seq[i]!.signal?.aborted !== true) continue
        const laterSame = seq.slice(i + 1).some(r => r.region === seq[i]!.region)
        if (!laterSame) crossRegion.push(seq[i]!.region)
      }
      expect(crossRegion).toEqual([])
      // 两个区域最终都必须有 usage 落地。这一条才是「跨区域取消」的真实后果：
      // 被顶掉的那个区域 `usages[region]` 永远停在 undefined，圆点也就永远不画。
      // 圆点是 `<span class="dsm-qoder-tab-dot">`，只在读到文档后才画。
      expect(container.querySelectorAll('.dsm-qoder-tab-dot')).toHaveLength(2)
    } finally {
      await unmount()
    }
  })

  it('轮询同时刷新两个区域时，不会互相取消（共享 AbortController 的缺陷在此显形）', async () => {
    // 挂载那一次现在两个区域都能落地（挂载读已经修好），**共享 AbortController
    // 的缺陷要到轮询才显形**：`for (const region of QODER_REGIONS) void
    // refresh(region)` 背靠背连发两次，只有共享一个 controller 时，先发的那次
    // 才会被后发的那次取消掉。用假定时器直接推进 60 秒。
    const seq: Array<{ region: string, signal: AbortSignal | undefined }> = []
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        seq.push({ region, signal: init?.signal as AbortSignal | undefined })
        await new Promise(resolve => setTimeout(resolve, 25))
        if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
        return { ok: true, status: 200, json: async () => signedInDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { unmount } = await mountCard()
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
      const beforePoll = seq.length
      expect(beforePoll).toBeGreaterThan(0)
      // 推进到下一次 60 秒轮询：两个区域各发一次。
      await act(async () => { vi.advanceTimersByTime(60_000) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
      const poll = seq.slice(beforePoll)
      // 轮询确实同时刷新了两个区域。
      expect(new Set(poll.map(r => r.region))).toEqual(new Set(['cn', 'global']))
      // 而它们**互不取消**：跨区域被取消即为缺陷。
      const crossRegion: string[] = []
      for (let i = 0; i < poll.length; i++) {
        if (poll[i]!.signal?.aborted !== true) continue
        if (!poll.slice(i + 1).some(r => r.region === poll[i]!.region)) crossRegion.push(poll[i]!.region)
      }
      expect(crossRegion).toEqual([])
    } finally {
      vi.useRealTimers()
      await unmount()
    }
  })

  it('挂载时两个区域都被读取（而不是只读 cn）', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        seen.push(region)
        return { ok: true, status: 200, json: async () => signedInDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { unmount } = await mountCard()
    try {
      // 首次挂载就把两个区域都读了。此前只有 cn，另一个区域要等 60 秒。
      expect(seen).toContain('cn')
      expect(seen).toContain('global')
    } finally {
      await unmount()
    }
  })
})

// ==========================================================================
// 积分读数席位：卡片上的二选一控件（对齐 workbuddy issue #62）
// ==========================================================================

/**
 * 这个控件曾经完全不存在 —— 读数被**焊死**在输入框工具栏那一个席位上，而那是
 * 一个共享的 list 插槽，另一个插件停在那里就可能把读数挤没。
 *
 * 这里钉的不是「有没有渲染一个 select」，而是三件会真正骗到用户的事：
 *   1. **值来自 Host 的 usage 应答**，不是浏览器设置镜像 —— 后者在受影响的部署上
 *      从不拾取经 Host 保存端点写入的值，控件会一直显示旧席位；
 *   2. **写的是 `regions.<region>.creditPosition`**，且只动目标区域；
 *   3. **开关关掉时控件置灰**（而不是消失）—— 两个席位此时都不渲染，位置无从谈起，
 *      但「有这个选项」这件事本身不该从界面上消失。
 */
describe('积分读数席位控件', () => {
  /** Drive the card with one usage answer whose `creditPosition` we control. */
  const withPosition = (position: unknown): Record<string, unknown> => ({
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region: 'cn',
    enabled: true,
    showCreditsInMainUi: true,
    ...position === undefined ? {} : { creditPosition: position },
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'settings', selected: true }],
    models: [modelOf({})],
    enabledModelKeys: ['qwen3-coder'],
    offModelKeys: [],
    imageModelKeys: [],
    // 控件由账号池的标题行渲染（`creditsSwitch` 是传给 AccountPool 的节点），
    // 没有 pool 就整段不渲染——这正是第一版用例拿到 null 的原因。
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
  })

  const stubUsage = (doc: (region: string) => Record<string, unknown>, record?: string[]): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        record?.push(region)
        return { ok: true, status: 200, json: async () => doc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
  }

  it('积分那两行在卡片正文里、账号池之上（用户实拍要求）', async () => {
    stubUsage(region => withPosition('stats'))
    const { container, unmount } = await mountCard()
    try {
      const prefs = container.querySelector('.dsm-qoder-prefs')
      expect(prefs).not.toBeNull()
      const pool = container.querySelector('.dsm-qoder-pool')
      expect(pool).not.toBeNull()
      // 在账号池之前，且不落在账号池内部（不在它的设置区里，否则会重复渲染）。
      expect(prefs!.compareDocumentPosition(pool!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(pool!.contains(prefs!)).toBe(false)
      // 同一个容器里只出现一次。
      expect(container.querySelectorAll('.dsm-qoder-prefs')).toHaveLength(1)
    } finally {
      await unmount()
    }
  })

  it('渲染二选一控件，值取自 Host 的 usage 应答', async () => {
    stubUsage(region => withPosition('stats'))
    const { container, unmount } = await mountCard()
    try {
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-credit-position')
      expect(select).not.toBeNull()
      // 关键：值来自 Host 应答。若改成读浏览器设置镜像，这里会是 composer。
      expect(select!.value).toBe('stats')
      const values = Array.from(select!.querySelectorAll('option')).map(o => o.value)
      expect(values).toEqual(['composer', 'stats'])
      // 位置控件现在是**下级一格**（用户圈出参照图要求照 dsh-connect-trae
      // 的「显示位置 [下拉]」：开关行在前，位置与它的说明缩进在后）。
      // 它不再与勾选框同一 flex 行，但必须仍与勾选框同属一个 .dsm-qoder-prefs 块。
      const row = select!.closest('.dsm-qoder-credit-position-pref')
      expect(row).not.toBeNull()
      expect(row!.closest('.dsm-qoder-prefs')).not.toBeNull()
      expect(row!.closest('.dsm-qoder-prefs'))
        .toBe(container.querySelector('.dsm-qoder-credit-toggle')!.closest('.dsm-qoder-prefs'))
    } finally {
      await unmount()
    }
  })

  it('缺席或不可识别时回落 composer（升级不移屏 / 手工改坏不至于没有值）', async () => {
    stubUsage(region => withPosition(undefined))
    const a = await mountCard()
    try {
      expect(a.container.querySelector<HTMLSelectElement>('select.dsm-qoder-credit-position')!.value).toBe('composer')
    } finally {
      await a.unmount()
    }
    stubUsage(region => withPosition('sidebar'))
    const b = await mountCard()
    try {
      expect(b.container.querySelector<HTMLSelectElement>('select.dsm-qoder-credit-position')!.value).toBe('composer')
    } finally {
      await b.unmount()
    }
  })

  it('改选席位写入 regions.<region>.creditPosition，且只动目标区域', async () => {
    // 记录 Host 保存端点收到的 payload。这是唯一能证明「写对了字段、没吃掉
    // 兄弟字段」的地方——读取端测试证明不了写入端。
    const saves: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...withPosition('composer'),
            region,
            // global 带着自己的、不同的席位：写入若越界，下面的断言会抓到。
            ...region === 'global' ? { creditPosition: 'stats' } : {},
          }),
        } as Response
      }
      if (url.includes('/plugins/dsh-connect-qoder/__save') || url.includes('/settings')) {
        saves.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return { ok: true, status: 200, json: async () => ({ regions: { cn: { creditPosition: 'stats' } } }) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    // 必须给 scope：`changeCreditPosition` 在没有写权限时直接 return（卡片
    // 从不假装写入）。`mountCard` 不带 scope，所以这里自己挂载。
    const wrote: Record<string, unknown> = { cn: { accountId: 'a1', showCreditsInMainUi: true } }
    const settingsScope = {
      getSnapshot: () => ({ status: 'ready', value: { regions: wrote }, writable: true }),
      subscribe: () => () => {},
      set: async () => true,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(QoderCard, { t, view: 'page', settingsScope } as any))
      })
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-credit-position')!
      await act(async () => {
        select.value = 'stats'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      // Host 保存端点的 body 形状是 `{ field: 'regions', value: { <region>: <slot> } }`
      // —— 区域槽在 `value` 下，不在顶层 `regions` 下。
      const regionWrites = saves
        .filter(s => (s as { field?: unknown }).field === 'regions')
        .map(s => (s as { value?: Record<string, unknown> }).value)
        .filter((r): r is Record<string, unknown> => r !== undefined)
      expect(regionWrites.length).toBeGreaterThan(0)
      const cn = regionWrites[0]!.cn as Record<string, unknown>
      expect(cn.creditPosition).toBe('stats')
      // 兄弟字段没被这次写入吃掉。
      expect(cn.accountId).toBe('a1')
      expect(cn.showCreditsInMainUi).toBe(true)
      // 另一个区域不在这次写入里。
      expect(regionWrites[0]!.global).toBeUndefined()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('积分开关关掉时控件置灰而不是消失', async () => {
    stubUsage(region => ({ ...withPosition('composer'), showCreditsInMainUi: false }))
    const { container, unmount } = await mountCard()
    try {
      const select = container.querySelector<HTMLSelectElement>('select.dsm-qoder-credit-position')
      // 仍在 DOM 里（选项本身不该消失），但不可操作。
      expect(select).not.toBeNull()
      expect(select!.disabled).toBe(true)
    } finally {
      await unmount()
    }
  })
})

/**
 * 账号工具区：两条动作条并成一行。
 *
 * 这里钉 DOM 事实（两条 bar 仍是兄弟、三颗按钮的归属与无障碍名），排版本身由
 * 样式规则保证，见 pool-architecture 里那三条正则。
 */
describe('账号工具区：添加 PAT 与导出 / 导入共用一行', () => {
  it('两条工具条是同一容器下的兄弟，名字挂在各自的按钮组上', async () => {
    const { container, unmount } = await mountCard()
    try {
      const tools = container.querySelector('.dsm-qoder-pool-tools')
      expect(tools).not.toBeNull()
      // 壳仍留在 DOM 里（display:contents 只塌陷布局），两条工具条是兄弟节点。
      const bars = Array.from(tools!.children).filter(el => el.classList.contains('dsm-qoder-bar'))
      expect(bars.length).toBe(2)

      const groups = Array.from(tools!.querySelectorAll('.dsm-qoder-bar-actions'))
      // 名字改挂在按钮组上：壳塌陷后 <section> 的名字在部分浏览器里会从无障碍树消失。
      expect(groups.map(group => group.getAttribute('role'))).toEqual(['group', 'group'])
      expect(groups.map(group => group.getAttribute('aria-label')))
        .toEqual(['row.addAccountStart', 'row.transferTitle'])
      // 三颗按钮，DOM 顺序即视觉顺序（添加 PAT 在最左，导出、导入依次向右）。
      expect(groups.flatMap(group => Array.from(group.querySelectorAll('button')).map(b => b.textContent)))
        .toEqual(['row.addAccountStart', 'row.transferExport', 'row.transferImport'])
    } finally {
      await unmount()
    }
  })

  // 「上游报额度耗尽」通知：池关着时一次 code 110 的失败唯一可见的 UI 出口。
  // key-preserving t 让文案键以字面量出现在 DOM 里，可直接断言。
  it('usage 文档带 lastQuotaExhaustion 时渲染区域级通知，不带时什么都不画', async () => {
    const stubUsageDoc = (doc: Record<string, unknown>): void => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => doc } as Response)))
    }
    stubUsageDoc({
      ...usageDoc('cn'),
      lastQuotaExhaustion: {
        code: '110',
        message: '上游信封错误: HTTP 403 {"code":"110","message":"Billing daily count exceeded"}',
        // 用本地时间分量构造（而非带时区的 ISO 串）：通知按查看者的本地钟渲染
        // 时刻，断言写成「本地 14:32 的那种写法」才能在任何时区的 CI 上都成立。
        //
        // 注意断言的写法：它按**读者语言**算，而不是写死 '14:32'。通知此前把
        // locale 钉死成 'zh-CN'，所以写死 24 小时制反而是能过的；改成跟随读者
        // 之后（同步自 dsh-connect-trae，issue #71），英文界面显示的是 `02:32 PM`，
        // 写死的 '14:32' 就成了钉住旧行为的断言。
        atMs: new Date(2026, 9, 24, 14, 32, 0).getTime(),
      },
    })
    const { container, unmount } = await mountCard()
    try {
      const notices = container.querySelectorAll('.dsm-qoder-quota-exhausted')
      expect(notices.length).toBeGreaterThan(0)
      const text = notices[0]!.textContent ?? ''
      expect(text).toContain('row.quotaExhaustedTitle')
      expect(text).toContain('110')
      // 时刻按读者语言渲染，不钉死 24 小时制。
      expect(text).toContain(
        new Date(2026, 9, 24, 14, 32, 0).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      )
      // 脱敏原文挂在悬停上，不占版面。
      expect(notices[0]!.getAttribute('title')).toContain('Billing daily count exceeded')
    } finally {
      await unmount()
    }

    // 不带字段（上游从没说过）→ 一条通知都没有。
    stubUsageDoc(usageDoc('cn'))
    const plain = await mountCard()
    try {
      expect(plain.container.querySelector('.dsm-qoder-quota-exhausted')).toBeNull()
    } finally {
      await plain.unmount()
    }
  })
})

/**
 * 「配额耗尽」通知的时刻按**读者**语言渲染。
 *
 * 同步自 dsh-connect-trae（issue #71）：这条通知此前把 locale 钉死成 `'zh-CN'`，
 * 于是英文界面印的是中文习惯的 `14:32`，而不是 `02:32 PM`。
 *
 * 这一处是**内联**的 `toLocaleTimeString`（不在 `formatClock` 里），所以上面那条
 * 「`formatClock` 不得钉死 locale」的源码级守卫**覆盖不到它**——需要单独一条。
 */
describe('配额耗尽通知的时刻跟随读者语言', () => {
  it('不为这条通知钉死 locale', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'QoderCard.tsx'),
      'utf8',
    )
    expect(
      source.includes("'zh-CN'"),
      "QoderCard.tsx 仍钉死了 locale —— 通知里的时刻必须按读者语言渲染",
    ).toBe(false)
  })
})
