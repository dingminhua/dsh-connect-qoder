// @vitest-environment jsdom
/**
 * 胶囊的数字必须跟着**此刻在计费的号**走，而不是跟着文档级总额走。
 *
 * 用户截图（2026-10-24）：面板高亮「当前选用 丁晓潇 100」，胶囊却读
 * 「QD AI · 773」——773 是已用量上限的 `ddd`（选中号）的余额。根因是胶囊读
 * usage 文档的文档级 `credits`，而那份文档是 `refreshUsage` 用**第一发目标**
 * （选中号）读上来的；池接管时真正计费的号另有其人，两个数必然分叉。
 *
 * 这里钉住四条：
 *   1. 表格给了 `current` 行 → 胶囊读**那一行**的余额，不读文档总额；
 *   2. 表格缺席但池视图给了 `current` 行 → 同上（composer 拉的是 full 文档，恒带）；
 *   3. 两者都缺席（旧宿主 / 池关）→ 退回选中号 = 文档总额（兼容面，行为不变）；
 *   4. 计费号哪都没有余额读数 → 显示「—」，不拿别的号的余额冒充。
 *
 * 参考：`tests/credit-position.spec.tsx`（同款挂载 harness）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Key-preserving translator：`{name}` 会被插进去，其余键名原样回显。 */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  if (params === undefined || params === null) return key
  return [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')
}

/** 截图同款现场：ddd 被排除（773）、丁晓潇接管（100）。 */
function takenOverDoc(poolAccounts: Array<Record<string, unknown>> | undefined): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'ddd',
    accountName: 'ddd',
    credits: { total: 773 },
    creditsAtMs: Date.now(),
    accounts: [
      { id: 'ddd', accountName: 'ddd', selected: true },
      { id: 'ding', accountName: '丁晓潇', selected: false },
    ],
    ...poolAccounts === undefined ? {} : { pool: { enabled: true, accounts: poolAccounts } },
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
  }
}

function stubFetch(input: {
  table: Array<Record<string, unknown>> | 'none'
  doc: Record<string, unknown>
}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/account-credits')) {
      if (input.table === 'none') return { ok: true, status: 200, json: async () => [] } as Response
      return { ok: true, status: 200, json: async () => input.table } as Response
    }
    return { ok: true, status: 200, json: async () => input.doc } as Response
  }))
}

async function mountTrigger(): Promise<{ text: string, title: string | null, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ComposerCredits, { t, provider: 'qoder', region: 'cn' } as any))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')
  const text = trigger?.textContent ?? ''
  const title = trigger?.getAttribute('title') ?? null
  return {
    text,
    title,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    },
  }
}

/** 挂载并**点开面板**：表格（/account-credits）只在面板打开时才拉。 */
async function mountOpen(input: {
  table: Array<Record<string, unknown>>
  doc: Record<string, unknown>
}): Promise<{ triggerText: string, rowCredits: Map<string, string>, unmount: () => Promise<void> }> {
  stubFetch({ table: input.table, doc: input.doc })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ComposerCredits, { t, provider: 'qoder', region: 'cn' } as any))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')!
  await act(async () => { trigger.click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const panel = document.querySelector('.dsm-qoder-composer-panel') as HTMLElement
  expect(panel).not.toBeNull()
  const rowCredits = new Map<string, string>()
  for (const tr of Array.from(panel.querySelectorAll('tbody tr'))) {
    // 名字在 `th[scope=row]` 里（可点切换按钮包着），余额在唯一的 `td` 里。
    const name = tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent ?? ''
    rowCredits.set(name, tr.querySelector('td')?.textContent ?? '')
  }
  return {
    triggerText: trigger.textContent ?? '',
    rowCredits,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('胶囊数字跟着计费号走', () => {
  it('表格给了 current 行：读那一行的余额，不读文档总额（截图现场）', async () => {
    stubFetch({
      table: [
        { id: 'ddd', accountName: 'ddd', selected: true, current: false, credits: 773, excludedBy: 'out-of-credit' },
        { id: 'ding', accountName: '丁晓潇', selected: false, current: true, credits: 100 },
      ],
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: false, credits: 773 },
        { accountId: 'ding', accountName: '丁晓潇', current: true, credits: 100 },
      ]),
    })
    const { text, title, unmount } = await mountTrigger()
    expect(text).toContain('100')
    expect(text).not.toContain('773')
    // 悬停说清 100 是谁的 —— 接管时「QD AI · 100」本身不说归属。
    expect(title).toContain('丁晓潇')
    await unmount()
  })

  it('表格缺席但池视图给了 current 行：读池视图那一行', async () => {
    stubFetch({
      table: 'none',
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: false, credits: 773 },
        { accountId: 'ding', accountName: '丁晓潇', current: true, credits: 100 },
      ]),
    })
    const { text, unmount } = await mountTrigger()
    expect(text).toContain('100')
    expect(text).not.toContain('773')
    await unmount()
  })

  it('计费号哪都没有余额读数：显示「—」，不拿别的号的余额冒充', async () => {
    stubFetch({
      table: 'none',
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: false, credits: 773 },
        // current 行没有 credits（逐号读失败）—— 文档总额是 ddd 的，不能拿来顶。
        { accountId: 'ding', accountName: '丁晓潇', current: true },
      ]),
    })
    const { text, unmount } = await mountTrigger()
    expect(text).toContain('—')
    expect(text).not.toContain('773')
    await unmount()
  })

  it('旧宿主 / 池关（无 current 行）：退回选中号 = 文档总额，行为不变', async () => {
    stubFetch({
      table: 'none',
      doc: takenOverDoc(undefined),
    })
    const { text, unmount } = await mountTrigger()
    expect(text).toContain('773')
    await unmount()
  })

  it('面板打开后表格给了 current 行：胶囊仍读计费号（表格路径）', async () => {
    const { triggerText, unmount } = await mountOpen({
      table: [
        { id: 'ddd', accountName: 'ddd', selected: true, current: false, credits: 773, excludedBy: 'out-of-credit' },
        { id: 'ding', accountName: '丁晓潇', selected: false, current: true, credits: 100 },
      ],
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: false, credits: 773 },
        { accountId: 'ding', accountName: '丁晓潇', current: true, credits: 100 },
      ]),
    })
    expect(triggerText).toContain('100')
    expect(triggerText).not.toContain('773')
    await unmount()
  })

  it('选中行自己没有读数时回填**文档总额**，不回填胶囊显示值（否则 ddd 行会显示接管号的 100）', async () => {
    const { rowCredits, unmount } = await mountOpen({
      // 表格只给身份不给余额：回填必须走文档总额（ddd 自己的 773）。
      table: [
        { id: 'ddd', accountName: 'ddd', selected: true, current: false },
        { id: 'ding', accountName: '丁晓潇', selected: false, current: true },
      ],
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: false, credits: 773 },
        { accountId: 'ding', accountName: '丁晓潇', current: true, credits: 100 },
      ]),
    })
    expect(rowCredits.get('ddd')).toContain('773')
    expect(rowCredits.get('ddd')).not.toContain('100')
    await unmount()
  })

  it('没有接管（current 就是选中号）：文档总额即计费号余额，两路同值', async () => {
    stubFetch({
      table: 'none',
      doc: takenOverDoc([
        { accountId: 'ddd', accountName: 'ddd', current: true, credits: 773 },
        { accountId: 'ding', accountName: '丁晓潇', current: false, credits: 100 },
      ]),
    })
    const { text, unmount } = await mountTrigger()
    expect(text).toContain('773')
    await unmount()
  })
})

/**
 * 专属积分那一列（issue #38）。
 *
 * 诉求很具体：点开对话框下方那个积分面板时，**SOTA 专属积分作为独立一列出现在
 * 普通积分的左边**；没有专属包时不显示（国内版与没有包的用户完全无感）。
 *
 * 这里钉四条，每一条都能单独把实现打回：
 *   1. 上游给了 `dedicated` → 表头多一格、且在「积分」左边；
 *   2. 没有 `dedicated` → 连 `th` 都不渲染，表头仍是两格（国内版形态）；
 *   3. 专属读数**不进**普通积分那一列（两个池子，加在一起是个花不掉的数）；
 *   4. 多个包显示合计，逐包细节进悬停。
 */
describe('composer 面板的专属积分列（issue #38）', () => {
  /** 面板打开后的表头文字与每行两格读数。 */
  async function openPanel(input: {
    table: Array<Record<string, unknown>>
    doc: Record<string, unknown>
  }): Promise<{
    headers: string[]
    dedicatedCells: Map<string, string>
    creditCells: Map<string, string>
    panelClass: string
    unmount: () => Promise<void>
  }> {
    stubFetch({ table: input.table, doc: input.doc })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(ComposerCredits, { t, provider: 'qoder-global', region: 'global' } as any))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')!
    await act(async () => { trigger.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const panel = document.querySelector('.dsm-qoder-composer-panel') as HTMLElement
    expect(panel).not.toBeNull()
    const headers = Array.from(panel.querySelectorAll('thead th')).map(th => th.textContent ?? '')
    const dedicatedCells = new Map<string, string>()
    const creditCells = new Map<string, string>()
    for (const tr of Array.from(panel.querySelectorAll('tbody tr'))) {
      const name = tr.querySelector('.dsm-qoder-composer-panel-name')?.textContent ?? ''
      const dedicated = tr.querySelector('td.dsm-qoder-composer-panel-dedicated')
      if (dedicated !== null) dedicatedCells.set(name, dedicated.textContent ?? '')
      const cells = Array.from(tr.querySelectorAll('td.dsm-qoder-composer-panel-num'))
      creditCells.set(name, cells[cells.length - 1]?.textContent ?? '')
    }
    return {
      headers,
      dedicatedCells,
      creditCells,
      panelClass: panel.className,
      async unmount() {
        await act(async () => { root.unmount() })
        container.remove()
        document.body.innerHTML = ''
      },
    }
  }

  /** 一行专属包（上游实测形状，只留下面板用得上的那几个字段）。 */
  const SOTA = {
    id: 'pkg-example',
    title: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' },
    description: { zh: '在模型选择器中选择 Sonus 模型时优先抵扣该积分。', en: 'Used first for Sonus.' },
    remaining: 888,
    total: 888,
    expiresAtMs: 1798732800000,
  }

  it('有专属包：多一列、在「积分」左边、数字是它自己的余额', async () => {
    const view = await openPanel({
      table: [
        { id: 'a', accountName: 'acct-a', selected: true, current: true, credits: 300, dedicated: [SOTA] },
        { id: 'b', accountName: 'acct-b', selected: false, current: false, credits: 120 },
      ],
      doc: { ...takenOverDoc(undefined), accountId: 'a', accountName: 'acct-a', credits: { total: 300 } },
    })
    // 三格：账号、专属（在左）、积分（在右）。
    expect(view.headers).toHaveLength(3)
    expect(view.headers[2]).toBe('composer.credits')
    // 表头用**上游自己的话**。这里的语言是 jsdom 的 `navigator.language`（`en-US`）：
    // 测试里的 `t` 是直通键名的，`hostLanguage(t)` 因此读不到宿主语言、按设计退回
    // 浏览器语言 —— 于是取的是上游 `valueI18n['en-US']` 那一句，而不是字典里的兜底。
    expect(view.headers[1]).toBe('SOTA Exclusive Credits')
    expect(view.dedicatedCells.get('acct-a')).toBe('888')
    // 另一个号没有专属包：画「—」，不借 a 的数字。
    expect(view.dedicatedCells.get('acct-b')).toBe('—')
    // 两个池子各归各的：专属那一列**没有**混进普通积分（300 仍在右边）。
    expect(view.creditCells.get('acct-a')).toBe('300')
    expect(view.creditCells.get('acct-b')).toBe('120')
    // 多一列时浮层加宽（否则账号名被压成一截省略号）。
    expect(view.panelClass).toContain('dsm-qoder-composer-panel-wide')
    await view.unmount()
  })

  it('没有专属包：连表头都不多一格，浮层也不加宽（国内版形态）', async () => {
    const view = await openPanel({
      table: [
        { id: 'a', accountName: 'acct-a', selected: true, current: true, credits: 300 },
      ],
      doc: { ...takenOverDoc(undefined), accountId: 'a', accountName: 'acct-a', credits: { total: 300 } },
    })
    expect(view.headers).toEqual(['composer.account', 'composer.credits'])
    expect(view.dedicatedCells.size).toBe(0)
    expect(view.panelClass).not.toContain('dsm-qoder-composer-panel-wide')
    await view.unmount()
  })

  it('多个专属包显示合计，逐包细节进悬停', async () => {
    const view = await openPanel({
      table: [
        {
          id: 'a', accountName: 'acct-a', selected: true, current: true, credits: 100,
          dedicated: [
            { id: 'p1', title: { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' }, remaining: 888 },
            { id: 'p2', title: { zh: 'Cantus 专属积分', en: 'Cantus Exclusive Credits' }, remaining: 112 },
          ],
        },
      ],
      doc: { ...takenOverDoc(undefined), accountId: 'a', accountName: 'acct-a', credits: { total: 100 } },
    })
    expect(view.dedicatedCells.get('acct-a')).toBe('1,000')
    const cell = document.querySelector('td.dsm-qoder-composer-panel-dedicated')
    const title = cell?.querySelector('span')?.getAttribute('title') ?? ''
    // 合计那一行 + 每个包各一行（标题、余额、上游说明都在）。标题取上游
    // `displayLabels` 里与界面语言对应的那一侧（此处 en-US，见上一条用例）。
    expect(title).toContain('composer.dedicatedMultiple')
    expect(title).toContain('SOTA Exclusive Credits: 888')
    expect(title).toContain('Cantus Exclusive Credits: 112')
    await view.unmount()
  })
})
