// @vitest-environment jsdom
/**
 * AccountPool 的结构性回归测试（0.4.x 对齐 workbuddy 后的单表结构）。
 *
 * 这组断言盯的是合并重排本身：成员资格复选框、状态点、当前/成员标签、
 * 积分与临期高亮、区块顺序（settings 在表后、regionNote 在尾部）。这些
 * 都曾经（或容易）在「双表拆写」结构里漏掉——host 侧测试从不执行组件，
 * 只有真挂载才能防住结构漂移。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../src/client/AccountPool.tsx'

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

/** A minimal writable settings scope (the pool edits need one). */
const scope = { getSnapshot: () => ({ value: {} }), set: async () => true }

/** A pool with two members: one serving+probed, one excluded. */
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
        accountId: 'a1',
        accountName: 'Alpha',
        current: true,
        member: true,
        // 只有 vault 的凭据能在这里删；settings/env 的 PAT 由插件之外管理。
        source: 'vault',
        credits: 1200,
        expiringSoon: 300,
        nearestExpiryMs: Date.now() + 86_400_000,
        probe: { outcome: 'ok', atMs: Date.now() - 60_000, source: 'test-batch' },
      },
      {
        accountId: 'a2',
        accountName: 'Beta',
        current: false,
        member: true,
        source: 'vault',
        credits: 0,
        excludedBy: 'out-of-credit',
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

describe('AccountPool render（workbuddy 单表同构）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('只有一张成员表：复选框、状态点、标签与积分同处一行', async () => {
    const { container, unmount } = await mountPool()
    try {
      // 单表：整池只有一张 pool-table，且它在 members 区块里。
      const tables = container.querySelectorAll('.dsm-qoder-pool-table')
      expect(tables).toHaveLength(1)
      expect(container.querySelector('.dsm-qoder-pool-members .dsm-qoder-pool-table')).not.toBeNull()

      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        // 成员资格复选框与状态点必须在行内（双表时代的成员表已合并回来）。
        expect(row.querySelector('.dsm-qoder-pool-check input[type="checkbox"]')).not.toBeNull()
        expect(row.querySelector('.dsm-qoder-usage-dot')).not.toBeNull()
      }

      // 当前计费账号用文字标签标出，不只靠行底色。
      const first = rows[0]!
      expect(first.querySelector('.dsm-qoder-pool-current-tag')?.textContent).toBe('row.poolCurrentBadge')
      expect(first.querySelector('.dsm-qoder-pool-member')?.textContent).toBe('row.poolMember')

      // 积分列：总数 + 临期高亮（expiringSoon > 0 用 soon 而不是 soon-plain）。
      const credits = first.querySelector('.dsm-qoder-pool-credits')
      expect(credits?.textContent).toContain('1200')
      expect(credits?.querySelector('.dsm-qoder-pool-soon')?.textContent).toContain('row.poolCreditSoon')

      // 测过的账号写测试时间；被排除的写排除原因。
      expect(first.textContent).toContain('row.poolTestedAt')
      expect(rows[1]!.querySelector('.dsm-qoder-pool-excluded')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('区块顺序：表 → 目标告警 → settings（含来源行）→ regionNote → 日志', async () => {
    const { container, unmount } = await mountPool()
    try {
      // 设置区外壳（标题 + 脏标记 + 说明行）与 workbuddy 同构；双表结构已拆除，
      // 整池只有一张成员表。
      expect(container.querySelector('.dsm-qoder-pool-settings-wrap')).not.toBeNull()
      expect(container.querySelectorAll('.dsm-qoder-pool-table')).toHaveLength(1)
      expect(container.querySelector('.dsm-qoder-pool-settings-wrap .dsm-qoder-pool-title')?.textContent)
        .toBe('row.poolSettingsTitle')

      // 目标模型来源一句话出现在目标设置里。
      const settings = container.querySelector('.dsm-qoder-pool-settings')
      expect(settings).not.toBeNull()
      expect(settings!.textContent).toContain('row.poolTargetCurrentPreferred')

      // 区域独立性那句话**不再**出现在池区（tab 栏下方已经说过，用户实拍
      // 「都重复了」）；区块顺序仍是 表 → settings → 日志。
      const text = container.textContent ?? ''
      const settingsAt = text.indexOf('row.poolTargetLabel')
      const logAt = text.indexOf('row.poolLogTitle')
      expect(settingsAt).toBeGreaterThan(-1)
      expect(logAt).toBeGreaterThan(settingsAt)
      expect(text).not.toContain('row.poolRegionNote')

      // 成员表在 settings 之前。
      const tableAt = text.indexOf('row.poolColumnAccount')
      expect(tableAt).toBeGreaterThan(-1)
      expect(tableAt).toBeLessThan(settingsAt)
    } finally {
      await unmount()
    }
  })

  it('保存行在设置卡片之外（不在带边框的圆角框里）', async () => {
    // 回归：保存行曾被放进 dsm-qoder-pool-settings（那张 overflow:hidden 的
    // 带边框卡片）内部——左端的仓库链接于是紧贴边框，而上方的「启用账号池」
    // 内缩 14px，同一条左对齐线断成两截（用户实拍：「还是不对」）。
    // workbuddy 里它是那张卡片的**兄弟**。
    const { container, unmount } = await mountPool()
    try {
      const card = container.querySelector('.dsm-qoder-pool-settings')
      const bar = container.querySelector('.dsm-qoder-pool-save-bar')
      expect(card).not.toBeNull()
      expect(bar).not.toBeNull()
      // 不在卡片里。
      expect(card!.contains(bar!)).toBe(false)
      // 仍在设置区外壳里，且紧随卡片之后。
      const wrap = container.querySelector('.dsm-qoder-pool-settings-wrap')
      expect(wrap!.contains(bar!)).toBe(true)
      expect(card!.nextElementSibling).toBe(bar)
    } finally {
      await unmount()
    }
  })

  it('账号工具在设置区顶部的虚线框里（标题之下、说明行之上）', async () => {
    const tools = React.createElement('span', { className: 'test-tool' }, 'TOOL')
    const { container, unmount } = await mountPool({ accountTools: tools })
    try {
      const box = container.querySelector('.dsm-qoder-pool-tools')
      expect(box).not.toBeNull()
      expect(box!.querySelector('.test-tool')?.textContent).toBe('TOOL')
      // 位置：设置区标题之后、说明行之前——工具立即生效，说明行讲的是下面
      // 那些「要保存才生效」的偏好，顺序颠倒会让读者以为工具也要保存。
      const html = container.innerHTML
      const titleAt = html.indexOf('row.poolSettingsTitle')
      const toolsAt = html.indexOf('dsm-qoder-pool-tools')
      const hintAt = html.indexOf('row.poolSettingsHint')
      expect(titleAt).toBeGreaterThan(-1)
      expect(toolsAt).toBeGreaterThan(titleAt)
      expect(hintAt).toBeGreaterThan(toolsAt)
    } finally {
      await unmount()
    }
  })

  it('没有传入工具时不渲染空虚线框', async () => {
    const { container, unmount } = await mountPool()
    try {
      expect(container.querySelector('.dsm-qoder-pool-tools')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('签到列与「一键签到」按钮随 checkinSupported 出现/消失', async () => {
    // Qoder **确实有**每日签到（用户指出后实测确认：sash 的 campaigns 活动）。
    // 此前 checkinSupported 写死 false，整个签到列与按钮都不存在。
    {
      const { container, unmount } = await mountPool()
      try {
        expect(container.querySelector('.dsm-qoder-pool-table')?.className)
          .toContain('dsm-qoder-pool-table-checkin')
        // 5 列：账号 / 积分 / 目标模型 / 签到 / 操作
        expect(container.querySelectorAll('.dsm-qoder-pool-row-head > span')).toHaveLength(5)
        expect(container.textContent).toContain('row.poolColumnCheckin')
        // 「一键签到」按钮（primary）在批量动作里排最前。
        expect(container.textContent).toContain('row.poolCheckinAll')
      } finally {
        await unmount()
      }
    }
    // 区域不支持签到时：列与按钮都不该出现（空列会暗示「状态存在，只是未知」）。
    {
      const { container, unmount } = await mountPool({
        pool: { ...poolFixture(), checkinSupported: false },
      })
      try {
        expect(container.querySelector('.dsm-qoder-pool-table')?.className)
          .not.toContain('dsm-qoder-pool-table-checkin')
        expect(container.querySelectorAll('.dsm-qoder-pool-row-head > span')).toHaveLength(4)
        expect(container.textContent).not.toContain('row.poolCheckinAll')
      } finally {
        await unmount()
      }
    }
  })

  it('签到单元格是三态：已签到 / 未签到 / 未知（没读到不能说「未签到」）', async () => {
    // 「未知」很重要：账号还没被读过时说「未签到」，会与用户刚亲眼看到的领取
    // 结果矛盾。
    const withState = async (checkedInToday: boolean | undefined): Promise<string> => {
      const base = (poolFixture().accounts as Array<Record<string, unknown>>)[0]!
      const account = { ...base, ...(checkedInToday === undefined ? {} : { checkedInToday }) }
      const { container, unmount } = await mountPool({
        pool: { ...poolFixture(), accounts: [account] },
      })
      try {
        return container.querySelector('.dsm-qoder-pool-checkin')?.textContent ?? ''
      } finally {
        await unmount()
      }
    }
    expect(await withState(true)).toContain('row.poolCheckedIn')
    expect(await withState(false)).toContain('row.poolNotCheckedIn')
    expect(await withState(undefined)).toContain('row.poolCheckinUnknown')
  })

  it('积分开关紧挨标题同排，芯片靠 margin-left:auto 推右（workbuddy 同规）', async () => {
    // 用户要求把「在对话框显示积分」挪到账号池标题旁边省一行空间。
    // 卡片构造这个节点（它持有写权限与区域），账号池只负责安置。
    const { container, unmount } = await mountPool({
      creditsSwitch: React.createElement('label', { className: 'dsm-qoder-credits-switch' }, 'SW'),
    })
    try {
      const head = container.querySelector('.dsm-qoder-pool-head')
      const extra = head?.querySelector('.dsm-qoder-pool-head-extra')
      expect(head).not.toBeNull()
      expect(extra).not.toBeNull()
      // 开关包在自己的壳里，壳紧挨标题（不是被推到右端的独立分组）。
      expect(extra!.querySelector('.dsm-qoder-credits-switch')).not.toBeNull()
      expect(container.querySelector('.dsm-qoder-credits-row')).toBeNull()
      expect(container.querySelector('.dsm-qoder-pool-head-right')).toBeNull()
      // DOM 顺序 = 标题 → 开关壳 → 芯片；芯片靠 CSS 的 margin-left:auto 靠右，
      // 而不是靠一层 justify-content:space-between 的容器。
      const html = head!.innerHTML
      expect(html.indexOf('pool-title')).toBeLessThan(html.indexOf('head-extra'))
      expect(html.indexOf('head-extra')).toBeLessThan(html.indexOf('current-badge'))
    } finally {
      await unmount()
    }
  })

  it('幽灵成员不再有提示行，而是静默把名单收敛后写回', async () => {
    // 回归（用户实拍）：「有 2 个已保存的账号当前没有可用的 PAT，因此不计入、
    // 也不会被使用。再保存一次即可移除它们。」——删掉 PAT 是用户已经做过的动作，
    // 名单不随 vault 收缩是插件的内部记账问题，不该要求用户回来点保存；而且
    // 批量测试还会遍历这些空壳（白跑一轮）。
    const saved: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/__save') || url.includes('save')) {
        saved.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }))
    // 名单里有 a1/a2（存在）与两个已被删除凭据的幽灵 id。
    const pool = { ...poolFixture(), memberAccountIds: ['a1', 'a2', 'pat-dead0001', 'pat-dead0002'] }
    const { container, unmount } = await mountPool({ pool })
    try {
      // 不再出现那句提示（文案键已删除，重新引入会渲染成字面量而被捕获）。
      expect(container.textContent).not.toContain('row.poolGhostMembers')
      // 表里只列真实存在的两个账号（行选择器含表头行，排除它）。
      const dataRows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row'))
        .filter(r => !r.classList.contains('dsm-qoder-pool-row-head'))
      expect(dataRows).toHaveLength(2)
      // 自愈是 effect 里异步落盘的：等它跑完再断言写入。
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    } finally {
      await unmount()
    }
    // 自愈已发生：写回的成员名单只剩真实成员。
    expect(saved.length).toBeGreaterThan(0)
    const members = JSON.stringify(saved)
    expect(members).toContain('a1')
    expect(members).not.toContain('pat-dead0001')
    expect(members).not.toContain('pat-dead0002')
  })

  /**
   * 一个账号都没有时，账号池**仍然必须渲染**：它是「添加 PAT / 导入账号」的唯一
   * 入口（账号工具由本组件渲染）。此前 host 在 signed-out 支里不带 pool，客户端
   * `renderPool()` 直接返回空 span —— 最需要添加账号的页面反而没有添加入口。
   */
  it('零账号时仍然渲染账号池、给出空状态，并保留添加账号的入口', async () => {
    const emptyPool = {
      ...poolFixture(),
      // 开着一个空池：这是「一个成员都还没有」的状态，不是「成员都不可用」。
      enabled: true,
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [],
    }
    const tools = React.createElement('button', { type: 'button', className: 'fake-add-pat' }, 'Add PAT')
    const { container, unmount } = await mountPool({ pool: emptyPool, accountTools: tools })
    try {
      // 账号池整块在。
      expect(container.querySelector('.dsm-qoder-pool')).not.toBeNull()
      // 空状态说清楚了去哪加（而不是留一张没有行的表格）。
      const empty = container.querySelector('.dsm-qoder-pool-empty')
      expect(empty?.textContent).toBe('row.poolEmptyHint')
      // 添加账号的入口确实渲染出来了 —— 这正是这次修复的目的。
      expect(container.querySelector('.fake-add-pat')).not.toBeNull()
      expect(container.querySelector('.dsm-qoder-pool-tools')).not.toBeNull()
      // 但不能说「成员要么限流、要么积分耗尽」——这里根本还没有成员。
      // 断文案而不是类名：`.dsm-qoder-pool-warn` 还被「一个都没勾选」那句复用。
      expect(container.textContent).not.toContain('row.poolNoCandidate')
    } finally {
      await unmount()
    }
  })

  it('有账号但都不可用时，才显示「没有可用候选」的警告', async () => {
    const unusable = {
      ...poolFixture(),
      enabled: true,
      memberAccountIds: ['a1'],
      effectiveMemberAccountIds: [],
      accounts: [{
        accountId: 'a1',
        accountName: 'Alpha',
        current: false,
        member: true,
        excludedBy: 'out-of-credit',
        probe: { outcome: 'out-of-credit', atMs: Date.now(), source: 'test-batch' },
      }],
    }
    const { container, unmount } = await mountPool({ pool: unusable })
    try {
      expect(container.querySelector('.dsm-qoder-pool-warn')).not.toBeNull()
      // 有账号时不该再显示「还没有账号」那句。
      expect(container.querySelector('.dsm-qoder-pool-empty')).toBeNull()
    } finally {
      await unmount()
    }
  })

  // ==========================================================================
  // 每日签到的「下一窗倒计时」：领取不是「今天到此为止」。
  //
  // 上游活动行带 `startAt`/`endAt`（实测当天 10:00 → 次日 09:59 UTC+8），
  // 用户实拍里页面上的 `09:22:23` 就是 `endAt − 现在`。宿主把 `endAt` 以
  // `checkinRefreshAtMs` 送到行上，这一格把它显示成倒计时。
  // ==========================================================================

  describe('每日签到的下一窗倒计时', () => {
    /** A pool whose first member is checked in, with a stated refresh time. */
    const claimedPool = (refreshAtMs?: number): Record<string, unknown> => ({
      ...poolFixture(),
      accounts: [
        {
          accountId: 'a1', accountName: 'Alpha', current: true, member: true, source: 'vault',
          credits: 1200, checkedInToday: true,
          ...(refreshAtMs === undefined ? {} : { checkinRefreshAtMs: refreshAtMs }),
          probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' },
        },
      ],
    })

    /** Mount with `nowMs` pinned so the countdown text is exact. */
    async function mountAt(nowMs: number, pool: Record<string, unknown>) {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(nowMs)
      return mountPool({ pool })
    }

    it('倒计时中的那一格**只说倒计时**，不再并排「已签到」（用户实拍）', async () => {
      // 用户实拍「已签到 · 00:39:22 后刷新」并指出：39 分钟后**可以签到**，所以这句
      // 不能显示「已签到」。「已签到」说的是上一窗，数字说的是下一窗什么时候开 ——
      // 两个不同窗口的状态并排就是自相矛盾。去掉它不丢事实：「**再**签到」本身
      // 已经蕴含「这一窗签过了」。
      const refreshAt = Date.now() + ((9 * 3600 + 22 * 60 + 23) * 1000)
      const { container, unmount } = await mountAt(Date.now(), claimedPool(refreshAt))
      try {
        const cell = container.querySelector('.dsm-qoder-pool-checkin')
        expect(cell?.textContent).toContain('row.poolCheckinNext')
        // 倒计时在，且是上游那个时刻。
        expect(cell?.querySelector('.dsm-qoder-pool-checkin-next')?.textContent).toContain('countdown=09:22:23')
        // 关键：这一格里没有「已签到」。变异检查：把它加回去，这条立刻红。
        expect(cell?.textContent).not.toContain('row.poolCheckedIn')
      } finally {
        vi.useRealTimers()
        await unmount()
      }
    })

    it('倒计时逐秒递减（心跳驱动，不是一次性文本）', async () => {
      const refreshAt = Date.now() + (3600 * 1000)
      const { container, unmount } = await mountAt(Date.now(), claimedPool(refreshAt))
      try {
        expect(container.querySelector('.dsm-qoder-pool-checkin-next')?.textContent).toContain('countdown=01:00:00')
        // 心跳是 20 秒（`setInterval(…, 20_000)`），所以推进一个心跳周期：
        // 1:00:00 → 00:59:40。证明它跟着时钟走，而不是把第一次算好的字符串钉死。
        await act(async () => { vi.advanceTimersByTime(20_000) })
        expect(container.querySelector('.dsm-qoder-pool-checkin-next')?.textContent).toContain('countdown=00:59:40')
      } finally {
        vi.useRealTimers()
        await unmount()
      }
    })

    it('倒计时走完 → 「现在可以签到」，而不是一个 00:00:00，也不是「已签到 · 现在可以签到」', async () => {
      const now = Date.now()
      const { container, unmount } = await mountAt(now, claimedPool(now - 1000))
      try {
        const cell = container.querySelector('.dsm-qoder-pool-checkin')
        expect(cell?.querySelector('.dsm-qoder-pool-checkin-due')?.textContent).toBe('row.poolCheckinDue')
        // 关键：不能显示一个「00:00:00」假装还在倒计时。
        expect(cell?.textContent).not.toContain('00:00:00')
        // 同样关键：到点之后「已签到」是**上一窗**的事，与「现在可以签到」并排自相
        // 矛盾（用户实拍指出的就是这个位置）。变异检查：把「已签到」并回来即红。
        expect(cell?.textContent).not.toContain('row.poolCheckedIn')
      } finally {
        vi.useRealTimers()
        await unmount()
      }
    })

    it('上游没给刷新时刻时只说「已签到」，不编倒计时', async () => {
      const { container, unmount } = await mountAt(Date.now(), claimedPool(undefined))
      try {
        const cell = container.querySelector('.dsm-qoder-pool-checkin')
        expect(cell?.textContent).toContain('row.poolCheckedIn')
        expect(cell?.querySelector('.dsm-qoder-pool-checkin-next')).toBeNull()
        expect(cell?.querySelector('.dsm-qoder-pool-checkin-due')).toBeNull()
      } finally {
        vi.useRealTimers()
        await unmount()
      }
    })

    it('没签到时不说倒计时 —— 那是「已领取」那一格的附注', async () => {
      const notClaimed = {
        ...poolFixture(),
        accounts: [
          { accountId: 'a1', accountName: 'Alpha', current: true, member: true, source: 'vault', checkedInToday: false, probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } },
        ],
      }
      const { container, unmount } = await mountAt(Date.now(), notClaimed)
      try {
        const cell = container.querySelector('.dsm-qoder-pool-checkin')
        expect(cell?.textContent).toContain('row.poolNotCheckedIn')
        expect(cell?.querySelector('.dsm-qoder-pool-checkin-next')).toBeNull()
      } finally {
        vi.useRealTimers()
        await unmount()
      }
    })
  })

  // ==========================================================================
  // 移出池 = 勾选；删除 = 按钮 + 二次确认。
  // 此前行内只有一个「移除」，它做的其实是移出池却长得像删除：用户点它期望账号
  // 消失，PAT 却留在 vault 里，「全选」一下又回来（用户实拍：「删除唯一的号，
  // 但是号并没有删除干净」）。
  // ==========================================================================

  it('行内没有「移除」按钮：移出池只由勾选框表达', async () => {
    const { container, unmount } = await mountPool()
    try {
      // 同一件事实（是不是成员）只能有一个控件。两个控件迟早会不一致 ——
      // 上一次的「移除了却还在」就是这么来的。
      expect(container.textContent).not.toContain('row.poolRowRemove')
      // 勾选框在，且已勾选的行是 checked。
      const boxes = Array.from(container.querySelectorAll('.dsm-qoder-pool-check input[type="checkbox"]')) as HTMLInputElement[]
      expect(boxes).toHaveLength(2)
      expect(boxes.every(b => b.checked)).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('点「删除」只展开确认条，不发请求；确认后才真删', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ removed: true }) }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPool()
    try {
      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      const first = rows[0]!
      const deleteBtn = first.querySelector('.dsm-qoder-pool-delete-btn') as HTMLButtonElement
      expect(deleteBtn.textContent).toBe('row.poolRowDelete')

      // 第一下：就地换成确认条，**还没有任何网络请求**。不可恢复的动作不能
      // 一点就生效。
      await act(async () => { deleteBtn.click() })
      expect(fetchMock).not.toHaveBeenCalled()
      const confirm = first.querySelector('.dsm-qoder-pool-confirm')
      expect(confirm).not.toBeNull()
      // 确认条要说清删的是谁、以及不可恢复。
      expect(confirm?.textContent).toContain('row.poolDeleteConfirm')
      // 危险动作的那颗按钮才带危险样式；取消那颗是中性。
      const yes = Array.from(confirm!.querySelectorAll('button')).find(b => b.textContent === 'row.poolDeleteConfirmYes') as HTMLButtonElement
      const no = Array.from(confirm!.querySelectorAll('button')).find(b => b.textContent === 'row.poolDeleteCancel') as HTMLButtonElement
      expect(yes.className).toContain('dsm-btn-danger')
      expect(no.className).not.toContain('dsm-btn-danger')

      // 第二下：才发请求，且走的是 pool remove 路由并带上 accountId。
      await act(async () => { yes.click() })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const url = String((fetchMock.mock.calls[0] as unknown[])[0])
      expect(url).toContain('action=remove')
      expect(url).toContain('accountId=a1')
    } finally {
      await unmount()
    }
  })

  it('确认条上「保留」会撤掉它，同样不发请求', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPool()
    try {
      const first = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')!
      await act(async () => { (first.querySelector('.dsm-qoder-pool-delete-btn') as HTMLButtonElement).click() })
      expect(first.querySelector('.dsm-qoder-pool-confirm')).not.toBeNull()
      const cancel = Array.from(first.querySelectorAll('.dsm-qoder-pool-confirm button'))
        .find(b => b.textContent === 'row.poolDeleteCancel') as HTMLButtonElement
      await act(async () => { cancel.click() })
      // 回到静止态，且什么都没删。
      expect(first.querySelector('.dsm-qoder-pool-confirm')).toBeNull()
      expect(first.querySelector('.dsm-qoder-pool-delete-btn')).not.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await unmount()
    }
  })

  it('settings/env 的账号不给删除按钮（那个 PAT 删不动，给了只会 409）', async () => {
    const withEnv = {
      ...poolFixture(),
      accounts: [
        { accountId: 'a1', accountName: 'Alpha', current: true, member: true, source: 'settings', probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } },
        { accountId: 'a2', accountName: 'Beta', current: false, member: true, source: 'vault', probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } },
      ],
    }
    const { container, unmount } = await mountPool({ pool: withEnv })
    try {
      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      // 第一行来自 settings：没有删除按钮；第二行来自 vault：有。
      expect(rows[0]!.querySelector('.dsm-qoder-pool-delete-btn')).toBeNull()
      expect(rows[1]!.querySelector('.dsm-qoder-pool-delete-btn')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('删除失败时把宿主的话显示出来（settings/env 的 PAT 删不动）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ reason: 'account-not-deletable', error: 'only accounts added by this plugin can be deleted' }),
    }) as Response))
    const { container, unmount } = await mountPool()
    try {
      const first = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')!
      await act(async () => { (first.querySelector('.dsm-qoder-pool-delete-btn') as HTMLButtonElement).click() })
      const yes = Array.from(first.querySelectorAll('.dsm-qoder-pool-confirm button'))
        .find(b => b.textContent === 'row.poolDeleteConfirmYes') as HTMLButtonElement
      await act(async () => { yes.click() })
      // 结构化 reason 要翻成文案，而不是把英文原文甩给用户。
      expect(container.querySelector('.dsm-qoder-pool-error')?.textContent).toContain('row.poolErrNotDeletable')
      // 失败后确认条复位，用户还能再试或改主意。
      expect(container.querySelector('.dsm-qoder-pool-confirm')).toBeNull()
    } finally {
      await unmount()
    }
  })
})
