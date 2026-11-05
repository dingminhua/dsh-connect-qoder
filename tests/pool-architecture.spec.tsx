// @vitest-environment jsdom
/**
 * 账号池的信息架构守卫（移植 workbuddy 94c339f 的**判据**，不是它的 DOM）。
 *
 * 这组断言盯的不是「某个节点长什么样」，而是「谁决定什么、那个决定站在页面的
 * 哪个位置」——这类结构一旦被后续重构搬回去，界面依然能渲染、类型依然通过，
 * 只有挂载才能抓住：
 *
 *   1. 模式开关必须排在它所控制的一切**之前**（它原来在页面底部）；
 *   2. 模式芯片说的是**运行中**的模式，不是草稿（「显示 A、实际记 B」）；
 *   3. 批量按钮必须紧挨着它作用的那个集合（「已选 N / M」与复选框）；
 *   4. 禁用原因就近，不再是一屏之外的琥珀横幅；
 *   5. 保存动作钉在视口底部（面板比一屏高）。
 *
 * 与 `pool-render.spec.tsx` 分开：那个文件盯「表里画了什么」，这个文件盯
 * 「东西放在哪、为什么放在那」。混在一起时，改布局会和改渲染互相淹。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../src/client/AccountPool.tsx'
import { QODER_CARD_CSS, QODER_COMPOSER_CSS } from '../src/client/styles.ts'

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

const scope = { getSnapshot: () => ({ value: {} }), set: async () => true }

/** 两个账号：a1 在服务（且已测通），a2 被积分排除。 */
function poolFixture(): Record<string, unknown> {
  return {
    enabled: true,
    targetModelId: 'qwen3-coder',
    targetModelSource: 'preferred',
    checkinSupported: true,
    memberAccountIds: ['a1', 'a2'],
    effectiveMemberAccountIds: ['a1', 'a2'],
    catalog: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', creditMultiplier: 0.79, contextWindow: 262_144 }],
    accounts: [
      {
        accountId: 'a1', accountName: 'Alpha', current: true, member: true, source: 'vault',
        credits: 1200, probe: { outcome: 'ok', atMs: Date.now() - 60_000, source: 'test-batch' },
      },
      {
        accountId: 'a2', accountName: 'Beta', current: false, member: true, source: 'vault',
        credits: 0, excludedBy: 'out-of-credit',
        probe: { outcome: 'out-of-credit', atMs: Date.now() - 120_000, source: 'live-request' },
      },
    ],
  }
}

async function mountPool(overrides: Record<string, unknown> = {}): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(AccountPool as any, {
      t,
      region: 'cn',
      pool: poolFixture(),
      settingsScope: scope,
      canWrite: true,
      ...overrides,
    }))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

describe('AccountPool 信息架构：模式条与就近原则', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('模式条紧跟标题、排在成员表之前——它决定下面每一列怎么读', async () => {
    const { container, unmount } = await mountPool()
    try {
      const head = container.querySelector('.dsm-qoder-pool-head')
      const modebar = container.querySelector('.dsm-qoder-pool-modebar')
      const members = container.querySelector('.dsm-qoder-pool-members')
      expect(head).not.toBeNull()
      expect(modebar).not.toBeNull()
      expect(members).not.toBeNull()
      // 紧跟标题，中间不夹别的块。
      expect(head!.nextElementSibling).toBe(modebar)
      // 在成员表之前：「未入池」这一列只在池负责挑号时才有意义。
      expect(modebar!.compareDocumentPosition(members!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // 「启用账号池」是模式条里的第一个复选框：学会了「设置住在带框块里」的
      // 用户，不该为最重要的那个开关再学第二种形状。
      const firstBox = modebar!.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(firstBox).not.toBeNull()
      expect(firstBox.checked).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('模式芯片说的是运行中的模式，不是草稿：拨了开关还没保存，它仍写「手动选号」', async () => {
    // 这一节最容易写错的地方：读草稿会让页面写着「自动挑号」，而保存着的池
    // 其实还关着、手动选号仍在生效——正是「显示 A、实际记 B」。
    const { container, unmount } = await mountPool({ pool: { ...poolFixture(), enabled: false } })
    try {
      const state = (): string | null | undefined =>
        container.querySelector('.dsm-qoder-pool-modebar-state')?.textContent
      expect(state()).toBe('row.poolModeManual')

      const box = container.querySelector('.dsm-qoder-pool-modebar input[type="checkbox"]') as HTMLInputElement
      await act(async () => { box.click() })

      // 开关自己勾上（草稿），脏标记出现，而模式芯片**不动**。
      expect(box.checked).toBe(true)
      expect(container.querySelector('.dsm-qoder-pool-modebar .dsm-qoder-pool-dirty')?.textContent)
        .toBe('row.poolDirty')
      expect(state()).toBe('row.poolModeManual')
    } finally {
      await unmount()
    }
  })

  it('脏标记在模式条里，不在设置卡片标题上——它警告的就是开关这一处', async () => {
    const { container, unmount } = await mountPool()
    try {
      const box = container.querySelector('.dsm-qoder-pool-modebar input[type="checkbox"]') as HTMLInputElement
      await act(async () => { box.click() })
      expect(container.querySelector('.dsm-qoder-pool-modebar .dsm-qoder-pool-dirty')).not.toBeNull()
      const cardHead = container.querySelector('.dsm-qoder-pool-card-head')
      expect(cardHead!.querySelector('.dsm-qoder-pool-dirty')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('「启用账号池」不在设置卡片里了——它上移为页面级模式，不该出现两次', async () => {
    const { container, unmount } = await mountPool()
    try {
      const modeboxes = container.querySelectorAll('.dsm-qoder-pool-modebar input[type="checkbox"]')
      expect(modeboxes).toHaveLength(1)
      // 设置卡片（排除复用了同一个带框类的模式条）里不再有第二个开关行。
      const card = container.querySelector('.dsm-qoder-pool-settings:not(.dsm-qoder-pool-modebar)')
      expect(card!.querySelector('input[type="checkbox"]')).toBeNull()
      // 那段「开启后……关闭后……」只出现一次。
      const occurrences = (container.innerHTML.match(/row\.poolEnabledHint/g) ?? []).length
      expect(occurrences).toBe(1)
    } finally {
      await unmount()
    }
  })

  it('批量按钮在成员区标题之后、账号表之前，且属于成员块', async () => {
    // 条上每个按钮都只对「已选 N / M」声明的集合做事；那个数字在上一行、
    // 被计数的复选框在下一行。它原来站在整个成员块之上，像一条页面级工具栏。
    const { container, unmount } = await mountPool()
    try {
      const actions = container.querySelector('.dsm-qoder-pool-actions')
      const membersHead = container.querySelector('.dsm-qoder-pool-members-head')
      const table = container.querySelector('.dsm-qoder-pool-table')
      expect(actions).not.toBeNull()
      expect(membersHead!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(actions!.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // 是成员块的子节点，不是它的兄弟。
      expect(actions!.closest('.dsm-qoder-pool-members')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('一个都没勾时，禁用原因就写在两颗按钮旁边，表下不再有琥珀横幅', async () => {
    const empty = { ...poolFixture(), memberAccountIds: [], effectiveMemberAccountIds: [] }
    const { container, unmount } = await mountPool({ pool: empty })
    try {
      const actions = container.querySelector('.dsm-qoder-pool-actions')
      expect(actions!.textContent).toContain('row.poolNoneSelectedHint')
      // 同一句话不再在表下再来一份——那才是让页面看着在两处坏掉的原因。
      // 正则里排除 `Hint` 后缀：`row.poolNoneSelected` 是 `…Hint` 的前缀，
      // 用子串断言会永远命中（本用例第一版就这么假红过）。
      expect(container.textContent).not.toMatch(/row\.poolNoneSelected(?!Hint)/)
      // 而那句 Hint 只出现一次，且就在按钮旁边。
      expect((container.innerHTML.match(/row\.poolNoneSelectedHint/g) ?? []).length).toBe(1)
    } finally {
      await unmount()
    }
  })

  it('池开着、在服务的号却不在池里时，模式条下有一句旁注；在池里就不出现', async () => {
    // 「当前使用」与「未入池」正交，同框会读成 bug——解释只在该状态出现。
    const outside = { ...poolFixture(), memberAccountIds: ['a2'], effectiveMemberAccountIds: ['a2'] }
    {
      const { container, unmount } = await mountPool({ pool: outside })
      try {
        const note = container.querySelector('.dsm-qoder-pool-serving-note')
        expect(note).not.toBeNull()
        expect(note!.textContent).toContain('row.poolServingOutside')
        expect(note!.textContent).toContain('account=Alpha')
      } finally {
        await unmount()
      }
    }
    {
      const { container, unmount } = await mountPool()
      try {
        expect(container.querySelector('.dsm-qoder-pool-serving-note')).toBeNull()
      } finally {
        await unmount()
      }
    }
  })

  it('池关着时标题行是选号下拉，池开着时是「当前使用」芯片——一个槽位只给一个答案', async () => {
    const off = await mountPool({ pool: { ...poolFixture(), enabled: false }, onSelectAccount: () => {} })
    try {
      expect(off.container.querySelector('.dsm-qoder-pool-head-pick')).not.toBeNull()
      expect(off.container.querySelector('.dsm-qoder-pool-current-badge')).toBeNull()
    } finally {
      await off.unmount()
    }
    const on = await mountPool()
    try {
      expect(on.container.querySelector('.dsm-qoder-pool-head-pick')).toBeNull()
      expect(on.container.querySelector('.dsm-qoder-pool-current-badge')).not.toBeNull()
    } finally {
      await on.unmount()
    }
  })

  it('成员行不再复述「已在池中」，只有未入池的行需要文字', async () => {
    // 勾选框已勾、行底色已标出的成员行，再写一次是同一件事说第三遍。
    const { container, unmount } = await mountPool()
    try {
      expect(container.querySelector('.dsm-qoder-pool-member')).toBeNull()
      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      expect(rows[0]!.querySelector('.dsm-qoder-pool-not-member')).toBeNull()
    } finally {
      await unmount()
    }
    // 非成员行仍然说「未入池」：空复选框配空积分列，否则与「勾了但没数据」分不开。
    const partial = await mountPool({ pool: { ...poolFixture(), memberAccountIds: ['a1'], effectiveMemberAccountIds: ['a1'] } })
    try {
      const rows = Array.from(partial.container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      const beta = rows.find(row => (row.textContent ?? '').includes('Beta'))
      expect(beta!.querySelector('.dsm-qoder-pool-not-member')?.textContent).toBe('row.poolNotMember')
    } finally {
      await partial.unmount()
    }
  })

  it('三颗账号工具按钮共用一行：拆壳 + 边距归零 + 对话框排最后', () => {
    // 三条规则环环相扣，少一条就退回「三行按钮」或「打开对话框后导出 / 导入整行
    // 消失」——这两种都在真机截图里出现过。
    //
    // 1) 拆壳：两条 <section class="dsm-qoder-bar"> 各自是 flex 容器，不塌陷就
    //    各占一行；display:contents 把按钮与对话框交给外层排列。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-tools > \.dsm-qoder-bar\{display:contents\}/)
    // 2) 两组按钮都带 margin-left:auto，在外层会**平分**剩余空间（实测第一颗停在
    //    行的中间），归零后由容器的 justify-content:flex-end 统一右对齐。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-tools \.dsm-qoder-bar-actions\{margin-left:0\}/)
    // 3) DOM 里「添加 PAT」的对话框夹在两组按钮中间，不指定 order 时它一换行就把
    //    跟在后面的「导出 / 导入」挤到下一行。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-tools \.dsm-qoder-transfer-dialog\{order:2;flex:1 1 100%;margin:0\}/)
  })

  it('保存条钉在视口底部——面板比一屏高，改完时按钮必须在看得见的地方', () => {
    // jsdom 不做布局，只能断言规则本身在。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-save-bar\{[^}]*position:sticky/)
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-save-bar\{[^}]*bottom:0/)
  })

  it('账号行的**默认**布局是两行紧凑排法，宽屏才升级 5 列', () => {
    // 这条钉的是一个真出过的缺陷：原来写的是「5 列 + @media(max-width:760px) 折成
    // 2 列」，而本插件现在住在设置面板里 —— 那里面板内容栏**固定 612px**
    // （800 的对话框 − 188 的导航栏），于是 max-width 分支在设置页里**恒成立**：
    // 每个账号被折成 264px 宽的两列堆叠，五行内容竖摞成 155px，横向还空着整片。
    //
    // 现在反过来：默认窄、`min-width:761px` 才升宽。jsdom 不做布局，所以断言的是
    // 「哪套规则在媒体查询之外」——那正是决定设置页里长什么样的那一套。
    // 注意切的是 `@media (` 而不是裸 `@media`：上面那段注释里就写着
    // 「@media(max-width:760px)」，裸字符串会切在注释中间。
    const beforeMedia = QODER_CARD_CSS.slice(0, QODER_CARD_CSS.indexOf('@media ('))
    // 规则体是多行的，所以用 [\s\S] 而不是 [^}]（后者照样能过，但意图不明）。
    expect(beforeMedia).toMatch(/\.dsm-qoder-pool-row\{[\s\S]*?grid-template-areas:/)
    // 5 列那套必须在媒体查询**里面**，不能是默认值。
    const media = QODER_CARD_CSS.slice(QODER_CARD_CSS.indexOf('@media (min-width:761px)'))
    expect(media).toMatch(/\.dsm-qoder-pool-row\{[\s\S]*?grid-template-columns:minmax\(0,1\.5fr\)/)
  })

  it('活动区的样式在**卡片**样式表里（它由卡片渲染，不由 composer 渲染）', () => {
    // 真出过的缺陷：`.dsm-qoder-campaigns*` 那十几条规则一度住在
    // QODER_COMPOSER_CSS 里，而那份样式表由 composer 积分读数组件注入 ——
    // 设置页从不渲染那个组件，于是活动区一条规则都没生效：界面上是一列没有
    // 边框、没有分栏的裸文字。样式必须跟着**渲染它的组件**走。
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-campaigns{')
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-campaigns-grid{')
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-campaign-row-foot{')
    expect(QODER_COMPOSER_CSS).not.toContain('.dsm-qoder-campaigns{')
    expect(QODER_COMPOSER_CSS).not.toContain('.dsm-qoder-campaign-row{')
  })

  it('「删除」的三档强度：静止淡红、悬停满饱和、确认条实心', () => {
    // 用户实拍「删除按钮红色弱一点」。它和「测试」并排，两个都是 outline 小按钮
    // —— 删除若用满饱和红，整行右侧会一直有一块红在喊，而这一行绝大多数时候是
    // 被扫视而不是被操作的。
    //
    // 钉三件事，少一件就不是「分档」而是「统一变淡」：
    //   1. 静止态不是满饱和（那条声明里必须有一个非 var 的兜底色，且带 color-mix）；
    //   2. 悬停回到满饱和（指针停在上面时该明确）；
    //   3. 确认条里的按钮仍是实心红底（真正要删的那一步不能被弱化）。
    const resting = QODER_CARD_CSS.match(/\.dsm-qoder-pool-delete-btn\{[^}]*\}/)?.[0] ?? ''
    expect(resting).toContain('color-mix')
    // 兜底色必须是柔和的那条，不是 #ef4444 —— 老 WebView 上会原样用兜底值。
    expect(resting).toContain('#c76a6a')
    expect(resting).not.toContain('color:var(--dsw-alias-state-error-primary,#ef4444)')
    // 悬停要查 **color 属性本身**，不能只查「这一条规则里出现过 error 变量」——
    // 边框色里也有它，那样写的话「把文字色改成灰」也能过（这个宽松版本当时确实
    // 放过了变异 2）。用 `(?:^|;)color:` 锚住属性名，避免匹配到 border-color。
    const hover = QODER_CARD_CSS.match(/\.dsm-qoder-pool-delete-btn:hover[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(hover).toMatch(/(?:^|[{;])color:var\(--dsw-alias-state-error-primary/)
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool \.dsm-btn-danger\{[^}]*background:var\(--dsw-alias-state-error-primary/)
  })

  it('活动排成瓦片：用足宽度，不是一行一条压到底', () => {
    // 每条活动用掉整栏宽度 1/3 不到、右侧整片空白，三条就吃掉近 300px 高度。
    // 网格 auto-fill + 260px 下限让它在 612px 的正文栏里自然排两列。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-campaigns-grid\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(260px,1fr\)\)/)
    // 描述限两行：否则卡片高度随上游文案长短跳动，同排瓦片高低不齐。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-campaign-row-desc\{[^}]*-webkit-line-clamp:2/)
    // 页脚贴底：状态与出口落在同一条基线上。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-campaign-row-foot\{[^}]*margin-top:auto/)
  })
})
