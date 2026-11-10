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

  it('脏标记在模式条里，不在设置区里——它警告的就是开关这一处', async () => {
    const { container, unmount } = await mountPool()
    try {
      const box = container.querySelector('.dsm-qoder-pool-modebar input[type="checkbox"]') as HTMLInputElement
      await act(async () => { box.click() })
      expect(container.querySelector('.dsm-qoder-pool-modebar .dsm-qoder-pool-dirty')).not.toBeNull()
      // 设置区没有标题行也没有自己的脏标记（1.20.0 起「更多设置」整块删除）。
      const wrap = container.querySelector('.dsm-qoder-pool-settings-wrap')
      expect(wrap!.querySelector('.dsm-qoder-pool-dirty')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('「更多设置」标题与那句说明都不再渲染，设置区也没有外围的框', async () => {
    // 用户实拍：红框圈住「更多设置 + 下面那句偏好说明」，要求「圈出来的不要」；
    // 并追加一句「下面的功能设置也不要外围的框」——即那两条设置外面的圆角边框。
    //
    // 为什么能删：标题下面的每一行自己就写着是做什么的（「测试用模型（全池统一）」、
    // 「测试请求体积」都是行内标题），上面再加一个「更多设置」只是给它们命名两次；
    // 而那句说明解释的是「点保存才生效」，保存行本身就在下面那一条里。
    const { container, unmount } = await mountPool()
    try {
      // 标题与说明整块不存在。
      expect(container.querySelector('.dsm-qoder-pool-card-head')).toBeNull()
      expect(container.querySelector('.dsm-qoder-pool-card-title')).toBeNull()
      expect(container.textContent).not.toContain('row.poolSettingsTitle')
      expect(container.textContent).not.toContain('row.poolSettingsHint')

      // 设置区仍然是两行，只是不再有边框/底色/圆角（CSS 断言放在下面那条）。
      const settings = container.querySelector('.dsm-qoder-pool-settings:not(.dsm-qoder-pool-modebar)')
      expect(settings, '设置区整个没了——只该去掉标题与框').not.toBeNull()
      expect(settings!.querySelector('.dsm-qoder-pool-set')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('设置区的两行不再左右内缩：宽度与账号工具、保存行对齐', () => {
    // 用户实拍「宽度也要调整啊」。去掉外框之后，`.dsm-qoder-pool-set` 那 14px 的
    // 左右内边距就**没有承托物**了：它原本是卡片的内边距，卡片没了，它就只是让两行
    // 比周围的块窄一截。
    //
    // 实测（564px 列，去内边距之前）：
    //   账号工具虚线框 / 保存行  x=24
    //   两行设置                x=38  ← 多出 14px
    // 两行设置的说明文字因此只有 292px，折成四行。
    const rule = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-set\{([^}]*)\}/)?.[1] ?? ''
    expect(rule, '没有 .dsm-qoder-pool-set 规则').not.toBe('')
    // 纵向留白保留（两行之间要透气），横向归零（与上下各块对齐）。
    expect(rule, '两行设置还在左右内缩').toMatch(/(?:^|;)padding:12px 0(?:;|$)/)
  })

  it('设置区的两行分栏有上限：说明文字不被下拉框挤成一条', () => {
    // 下拉框原来只受 `max-width` 约束，于是它按内容撑开、把说明文字挤窄。给它一个
    // 明确的宽度上限，说明文字才拿得到剩下的宽度。
    const ctl = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-set-ctl\{([^}]*)\}/)?.[1] ?? ''
    expect(ctl, '没有 .dsm-qoder-pool-set-ctl 规则').not.toBe('')
    // 控件列不参与伸展：它窄，文字才宽。
    expect(ctl, '控件列会抢走说明文字的宽度').toContain('flex:none')
    // 下拉框本身也要有个上限，否则长模型名会把文字挤到只能容下几个字。
    const select = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-select\{([^}]*)\}/)?.[1] ?? ''
    expect(select, '下拉框没有宽度上限').toMatch(/max-width:\s*\d+px/)
  })

  it('窄列里设置行改成上下两段：说明文字独占整宽，不跟下拉框抢', () => {
    // 设置面板的内容列只有 564px。两行设置若坚持「左文字 + 右下拉」并排，说明文字
    // 只剩约 320px，那句「全池共用这一个模型…」要折四行；而下拉框右侧还有一片用不掉
    // 的空白。改成上下两段之后文字独占整宽（约 516px），行数减半。
    //
    // 判据与 workbuddy 同一条（它那边是 @container max-width:620px）。这里用容器查询
    // 而不是媒体查询：这张卡在输入框、整页版、设置面板三处渲染，视口宽度与这张表的
    // 宽度毫无关系。
    const at = QODER_CARD_CSS.indexOf('@container (max-width:')
    expect(at, '没有窄列形态的容器查询').toBeGreaterThan(-1)
    const narrow = QODER_CARD_CSS.slice(at)
    expect(narrow, '窄列里设置行还是并排').toMatch(
      /\.dsm-qoder-pool-set\{[^}]*flex-direction:column/,
    )
    expect(narrow, '窄列里下拉框没有占满整宽').toMatch(
      /\.dsm-qoder-pool-select\{[^}]*width:100%/,
    )
  })

  it('设置区不再自带边框：`.dsm-qoder-pool-settings` 去壳', () => {
    // 「下面的功能设置也不要外围的框」。模式条复用了同一个类名，但它自己另有一条
    // 带框规则（.dsm-qoder-pool-modebar），所以这里去掉边框不会把模式条也一起去掉。
    const rule = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-settings\{([^}]*)\}/)?.[1] ?? ''
    expect(rule, '没有 .dsm-qoder-pool-settings 规则').not.toBe('')
    expect(rule, '设置区还留着边框').not.toMatch(/(?:^|;)border:/)
    expect(rule, '设置区还留着圆角').not.toContain('border-radius')
    // 模式条那一层仍然有框（它是整页的模式选择器，与设置区不是一回事）。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-modebar\{[^}]*border:1px solid/)
  })

  it('「启用账号池」不在设置卡片里了——它上移为页面级模式，不该出现两次', async () => {
    const { container, unmount } = await mountPool()
    try {
      // 模式条里现在有**两个**复选框：模式（启用账号池）与自动签到（issue #36）。
      // 原来断言「恰好一个」，而它真正想守的是「同一个开关不该出现两次」——
      // 所以改成**点名**：第一个仍是模式开关（它决定下面每一列怎么读），自动签到
      // 排在它之后的独立行上。按数量断的话，任何新开关都会让这条无差别变红。
      const boxes = Array.from(
        container.querySelectorAll('.dsm-qoder-pool-modebar input[type="checkbox"]'),
      ) as HTMLInputElement[]
      expect(boxes).toHaveLength(2)
      expect(boxes[0]!.closest('.dsm-qoder-pool-modebar-row')?.querySelector('.dsm-qoder-pool-modebar-label')).not.toBeNull()
      expect(boxes[1]!.closest('.dsm-qoder-pool-auto-checkin')).not.toBeNull()
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

  it('上下移紧贴「当前使用」，不被推到第一行最右端', () => {
    // 用户第四次实拍：↑↓ 被 margin-left:auto 推到了整行最右，离「当前使用」隔着
    // 一大段空白，箭头指着要求「这个要紧贴」。
    //
    // 它读起来是「名字 · 第 1 位 · 当前使用 · ↑↓」这一句话，是**名次**的控件 ——
    // 隔开之后它像掉队的第四个徽章。右侧的空白由积分占据（积分才是第一行的右端
    // 元素），所以这里不需要 auto 去撑。
    const lineRule = QODER_CARD_CSS.match(
      /\n\.dsm-qoder-pool-account-line \.dsm-qoder-pool-move\{([^}]*)\}/,
    )?.[1] ?? ''
    expect(lineRule, '没有 .dsm-qoder-pool-account-line .dsm-qoder-pool-move 规则').not.toBe('')
    expect(lineRule, '↑↓ 还被推到整行最右端').not.toContain('margin-left:auto')
  })

  it('窄形态两行：积分在第一行右端，操作按钮在第二行右端', () => {
    // 用户第三次实拍确定的形态（三行 → 两行）：
    //
    //   第一行：账号 … 积分（推到最右）
    //   第二行：状态 · 签到 … 操作按钮（推到最右）
    //
    // 走过的三条路都失败过一次，所以断言同时钉住「现在是什么」和「不该回到什么」。
    const credits = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-credits\{([^}]*)\}/)?.[1] ?? ''
    expect(credits, '没有 .dsm-qoder-pool-credits 规则').not.toBe('')
    // 积分靠 auto 外边距贴第一行右端。
    expect(credits, '积分没有贴到第一行右端').toContain('margin-left:auto')
    // 且不许折行：数字是这一行的右边界，一折行两行形态就塌了。
    expect(credits, '积分可折行，第一行会被撑成两行').toContain('white-space:nowrap')
    expect(credits, '积分会被压缩').toContain('flex:none')

    const checkin = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-checkin\{([^}]*)\}/)?.[1] ?? ''
    // 右端只有一个主人：签到不再靠 auto 抢（那时按钮在第三行）。
    expect(checkin, '签到还在抢右端，会和按钮把第二行撕成三截').not.toContain('margin-left:auto')

    const actions = QODER_CARD_CSS.match(/\n\.dsm-qoder-pool-row-actions\{([^}]*)\}/)?.[1] ?? ''
    expect(actions, '没有 .dsm-qoder-pool-row-actions 规则').not.toBe('')
    expect(actions, '按钮没有贴到第二行右端').toContain('margin-left:auto')
    expect(actions, '按钮不该被压缩').toContain('flex:none')
    // 独占整行（三行时代）必须不再出现。
    expect(QODER_CARD_CSS, '还留着 flex:1 1 100% 的整行覆盖')
      .not.toMatch(/\.dsm-qoder-pool-row-actions\{[^}]*flex:1 1 100%/)

    // 宽屏是单行网格，按钮在**自己的最后一格**（justify-self:end），窄形态那条
    // auto 外边距必须在容器查询里让位，否则按钮会被顶出格子。
    const wide = QODER_CARD_CSS.slice(QODER_CARD_CSS.indexOf('@container (min-width:700px)'))
    expect(wide).toMatch(/\.dsm-qoder-pool-row-actions\{justify-self:end;margin-left:0\}/)
  })

  it('账号行的断点测**表格**宽度，不测视口——视口断点在设置页里恒成立', () => {
    // 这条钉的是一个真出过的缺陷，前后两版都错在同一个地方：拿视口当依据。
    //
    //   1.0–1.17 是「5 列 + @media(max-width:760px) 折成 2 列」；
    //   1.18 改成「默认窄 + @media (min-width:761px) 升级 5 列」。
    //
    // 两次都以为改了方向就修好了，其实**断点测错了对象**：设置面板的内容栏是固定
    // 578px（800 的对话框 − 188 的导航栏），而窗口是 1440px —— `min-width:761px`
    // 在那里永远成立，578px 的表格于是拿到了宽屏那套。实测（1440 视口 / 578px 表）：
    //   账号 x=1159 w=402 │ 积分 x=1573 w=134 │ 状态 x=1159 w=402 │ 签到 x=1573 w=36
    // 账号列独占 402px、行高 108px，而右边 134px 的积分列里只有「888」三位数。
    //
    // 更隐蔽的是：`@media` 那套**从来没赢过**。宽屏分支写的是一个类
    // （.dsm-qoder-pool-row），而「有签到列」那条窄屏规则是两个类
    // （.dsm-qoder-pool-table-checkin .dsm-qoder-pool-row）——后者在层叠上更具体，
    // 于是两区域只要支持签到（CN 与国际版都支持），宽屏形态就是**死代码**。
    //
    // 现在：断点改成表级容器查询，列轨道只在一处声明（CSS 变量），行与表头读同一个
    // 变量。jsdom 不做布局，所以这里钉的是三条规则本身。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-table\{[\s\S]*?container-type:inline-size/)
    // 窄形态是默认值：它必须在**任何** @media / @container 之外。
    const firstAt = QODER_CARD_CSS.indexOf('@container (')
    expect(firstAt).toBeGreaterThan(0)
    const defaults = QODER_CARD_CSS.slice(
      QODER_CARD_CSS.indexOf('.dsm-qoder-pool-row{'),
      firstAt,
    )
    expect(defaults).toMatch(/display:flex;flex-wrap:wrap/)
    // 宽屏那套在容器查询里，读的是那个变量——不是又写一遍列定义。
    const wide = QODER_CARD_CSS.slice(firstAt)
    expect(wide).toMatch(/@container \(min-width:700px\)\{[\s\S]*?\.dsm-qoder-pool-row\{display:grid;grid-template-columns:var\(--dsm-qoder-pool-cols\)/)
    // 列轨道只在变量里声明一次；行与表头都消费它，不可能再分叉。
    expect(QODER_CARD_CSS).toMatch(/--dsm-qoder-pool-cols:minmax/)
    expect(QODER_CARD_CSS).not.toMatch(/\.dsm-qoder-pool-row\{[^}]*grid-template-columns:minmax/)
  })

  it('表头与数据行读同一个列变量——末尾那条轨道是固定 px', () => {
    // 尾部轨道用固定 px 而不是 fr/auto，理由具体：轨道宽度必须与格子里有没有内容
    // 无关，否则表头与数据行各自算出的宽度会差出一截——实测过表头「账号」w=275
    // 而数据格 w=246，越往右错得越多。
    //
    // ⚠️ **没有第 5 条轨道了**（1.20.0）：行内操作（测试 / 删除）从网格的最后一格
    // 挪进了账号格的名字行，独立的那一列随之取消。留一条空轨道等于在每一行右边
    // 留 96px 空白——workbuddy 那一版就还留着一条 150px 的空轨（实测 tracks
    // 300/188/244/169/150，而 cells 只有四格），这里不再照抄那个遗留。
    const cols = QODER_CARD_CSS.match(/--dsm-qoder-pool-cols:([^;}]+)/)?.[1] ?? ''
    expect(cols).toBeTruthy()
    // 末尾两条轨道（签到 118px、操作 96px）都是固定 px；整份定义里没有 fr/auto
    // 被误写成固定值之外的形态（前三列仍是 fr）。
    expect(cols.trim()).toMatch(/\d+px \d+px$/)
    expect(cols).not.toContain('auto')
    // 签到列容得下它最长的那句话（「23:59:59 后可再签到」，实测 116px）：
    // 给窄了它会溢出自己的轨道，而数字每秒在变，溢出量也跟着变——看着像这一格在抖。
    const tracks = cols.trim().split(/\s+/)
    const checkinTrack = Number(tracks.at(-2)!.replace('px', ''))
    expect(checkinTrack).toBeGreaterThanOrEqual(118)
    // 操作列：两颗小按钮（测试 / 删除）横排。
    const actionsTrack = Number(tracks.at(-1)!.replace('px', ''))
    expect(actionsTrack).toBeGreaterThanOrEqual(90)
    // 不支持签到的区域少一条签到轨道，但**操作列仍在**（末尾固定 96px）。
    expect(QODER_CARD_CSS).toMatch(
      /\.dsm-qoder-pool-table:not\(\.dsm-qoder-pool-table-checkin\)\{--dsm-qoder-pool-cols:minmax\(0,1\.9fr\) minmax\(0,\.9fr\) minmax\(0,1\.4fr\) 96px\}/,
    )
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
