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
import { QODER_CARD_CSS } from '../src/client/styles.ts'

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

  it('保存条钉在视口底部——面板比一屏高，改完时按钮必须在看得见的地方', () => {
    // jsdom 不做布局，只能断言规则本身在。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-save-bar\{[^}]*position:sticky/)
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-pool-save-bar\{[^}]*bottom:0/)
  })
})
