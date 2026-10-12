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

  it('模型行渲染思考强度档位，并括注默认档；无档位的模型不渲染这一项', async () => {
    const { container, unmount } = await mountCard()
    try {
      const metas = Array.from(container.querySelectorAll('.dsm-qoder-model-meta'))
      expect(metas).toHaveLength(2)

      // 第一行有档位：`推理强度：low / medium（默认） / xhigh`——顺序即强度序，
      // 默认档带括注（用户才知道不改设置时用的是哪一档）。
      const first = metas[0]!.textContent ?? ''
      expect(first).toContain('row.modelReasoning')
      expect(first).toContain('low')
      expect(first).toContain('row.modelReasoningDefault')
      expect(first.indexOf('low')).toBeLessThan(first.indexOf('xhigh'))

      // 第二行（无档位）不渲染这一项：空标签会让人以为「支持思考却没有强度可选」。
      const second = metas[1]!.textContent ?? ''
      expect(second).not.toContain('row.modelReasoning')
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

  it('账号选择器只在多个候选账号时出现', async () => {
    // One account (the fixture's state): switching is a no-op, so the picker
    // must not render — an "自动 —— 设置 → 环境变量 → 保险库" dropdown with no
    // alternative is pure noise (and this was rendered with ZERO accounts).
    const { container, unmount } = await mountCard()
    try {
      expect(container.querySelectorAll('.dsm-qoder-usage-select-wrap')).toHaveLength(0)
    } finally {
      await unmount()
    }
  })

  it('两个账号时账号选择器出现，并列出两个候选', async () => {
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
            accounts: [
              { id: 'a1', accountName: 'A1', source: 'settings', selected: true },
              { id: 'a2', accountName: 'A2', source: 'vault', selected: false },
            ],
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const { container, unmount } = await mountCard()
    try {
      const select = container.querySelector<HTMLSelectElement>('.dsm-qoder-usage-select')
      expect(select).not.toBeNull()
      const options = Array.from(select!.querySelectorAll('option')).map(o => o.textContent)
      expect(options[0]).toBe('row.accountSelectAuto')
      // 正在计费的那条带「使用中」标记——用户才知道选哪个等于「保持现状」。
      expect(options).toContain('A1（row.poolCurrentBadge）')
      expect(options).toContain('A2')
    } finally {
      await unmount()
    }
  })

  it('同名账号用 id 尾号区分，并标出哪条在使用', async () => {
    // 回归：同一个邮箱重新签发 PAT 会得到两条记录（id 由 PAT 推导，不同），
    // 两条都叫同一个名字。只显示名字的话，「移除哪一个」看不出答案——用户
    // 实拍的就是这种两条同名、一条已过期的情况。
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
      const options = Array.from(container.querySelectorAll<HTMLOptionElement>('.dsm-qoder-usage-select option'))
        .map(o => o.textContent ?? '')
        .filter(text => text.startsWith('same@msn.com'))
      expect(options).toHaveLength(2)
      // 尾号来自 id 末 4 位；在用的那条另带「使用中」。
      expect(options.some(text => text.includes('2d10'))).toBe(true)
      expect(options.some(text => text.includes('9f87') && text.includes('row.poolCurrentBadge'))).toBe(true)

      // 移除按钮用同一套标签，否则用户在下拉里选中一个、到按钮上又认不出。
      const removeButtons = Array.from(container.querySelectorAll('button'))
        .filter(b => (b.textContent ?? '').startsWith('row.accountRemoveShort'))
      expect(removeButtons).toHaveLength(2)
      expect(removeButtons.some(b => (b.textContent ?? '').includes('2d10'))).toBe(true)
    } finally {
      await unmount()
    }
  })
})
