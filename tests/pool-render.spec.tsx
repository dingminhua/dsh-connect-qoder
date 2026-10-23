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

/**
 * 批量动作的 fetch 替身：POST（真正的动作）挂起，等测试调用 `hold.release`；
 * GET（进度轮询）立刻回「还没有处理完的行」。
 *
 * 两者必须分开。进度轮询是批量在飞期间每秒一次的读，替身若把同一个挂起的
 * promise 也发给它，`release` 就会指到**轮询**那一次上——POST 永远不返回，
 * 批量永远「在飞」，测试测到的就不是它以为的东西（首轮三处失败的真正原因）。
 */
function batchFetchMock(hold: { release?: (value: Response) => void }): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ action: 'progress' }) } as Response)
    }
    return new Promise<Response>(resolve => { hold.release = resolve })
  }))
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
      // 成员资格只给**不在池里**的行写一句话：勾选框已勾、行底色已标出的成员
      // 行再写「已在池中」是同一件事说第三遍（94c339f 判据）。
      expect(first.querySelector('.dsm-qoder-pool-member')).toBeNull()
      expect(first.querySelector('.dsm-qoder-pool-not-member')).toBeNull()

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
      // 「更多设置」是小标题（h4），不是第二个页面标题——面板只有一个主标题。
      expect(container.querySelector('.dsm-qoder-pool-settings-wrap .dsm-qoder-pool-card-title')?.textContent)
        .toBe('row.poolSettingsTitle')

      // 目标模型来源一句话出现在目标设置里。
      // 排除模式条：它复用了同一个带框类（见下方「保存行」那条的说明）。
      const settings = container.querySelector('.dsm-qoder-pool-settings:not(.dsm-qoder-pool-modebar)')
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
      // 模式条刻意复用了 `.dsm-qoder-pool-settings` 的带框样式（它就是这个
      // 形状），所以这里必须排除它——否则 `card` 会命中页面顶部的模式条。
      const card = container.querySelector('.dsm-qoder-pool-settings:not(.dsm-qoder-pool-modebar)')
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

  it('账号工具在「更多设置」标题之上、说明行之前', async () => {
    const tools = React.createElement('span', { className: 'test-tool' }, 'TOOL')
    const { container, unmount } = await mountPool({ accountTools: tools })
    try {
      const box = container.querySelector('.dsm-qoder-pool-tools')
      expect(box).not.toBeNull()
      expect(box!.querySelector('.test-tool')?.textContent).toBe('TOOL')
      // 位置：「更多设置」标题**之上**（94c339f）。工具立即生效，而标题之下
      // 的一切都要按保存——立即生效的控件不能住在承诺「点保存才生效」的区块里。
      const html = container.innerHTML
      const titleAt = html.indexOf('row.poolSettingsTitle')
      const toolsAt = html.indexOf('dsm-qoder-pool-tools')
      const hintAt = html.indexOf('row.poolSettingsHint')
      expect(titleAt).toBeGreaterThan(-1)
      expect(toolsAt).toBeGreaterThan(-1)
      expect(toolsAt).toBeLessThan(titleAt)
      expect(hintAt).toBeGreaterThan(titleAt)
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

  it('账号池不再接收积分开关：它已上移到卡片正文、账号池之上', async () => {
    // 它搬过好几次家：卡片正文独占一行 → 挤在 <h3>账号池</h3> 后面 → 设置区顶部
    // → 现在是**卡片正文里、账号池之上**（用户实拍：「这段内容移动到账号池上面」）。
    // 因此账号池这一层不再有安置它的职责：既没有 props，设置区里也不该冒出
    // `.dsm-qoder-prefs`——否则同一块会渲染两次。
    const { container, unmount } = await mountPool()
    try {
      expect(container.querySelector('.dsm-qoder-prefs')).toBeNull()
      // 设置区仍是「标题 → 账号工具虚线框（若有）→ 说明行 → 设置卡片」。
      const wrap = container.querySelector('.dsm-qoder-pool-settings-wrap')
      expect(wrap).not.toBeNull()
      // 设置区不再有页面级标题行：它被降级为一个 h4 小标题（card-head）。
      expect(wrap!.querySelector('.dsm-qoder-pool-head')).toBeNull()
      const head = wrap!.querySelector('.dsm-qoder-pool-card-head')
      expect(head).not.toBeNull()
      expect(head!.querySelector('.dsm-qoder-pool-card-title')).not.toBeNull()
      // 芯片仍靠 CSS 的 margin-left:auto 靠右，而不是靠 space-between 容器。
      expect(container.querySelector('.dsm-qoder-pool-head-right')).toBeNull()
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

  /**
   * 行内「测试」的在飞表达：轻度提示，不锁界面。
   *
   * 此前它和「测试全部」共用同一个全屏遮罩，于是点一行的测试期间整个卡片点
   * 什么都点不动（用户要求：「逐账号测试，不能锁住操作，改用其他轻度的提示
   * 方式」）。这里盯住五件事：遮罩**不出现**；那一行的按钮自己变成「测试中…」
   * 并禁用；同类按钮互斥（其他行 + 批量）；批量话术「正在逐个账号执行…」
   * **不**被行内借用；其余控件（勾选、保存、删除入口）不受影响。
   *
   * 提示按**文案**找，不按 `.dsm-qoder-pool-hint` 找 —— 同一个类名也被
   * 「已选 N / M」用着，按类名断言会把无关的那行算进来。
   */
  it('行内测试在飞时不抬遮罩，只改那一行的按钮', async () => {
    const hold: { release?: (value: Response) => void } = {}
    batchFetchMock(hold)
    const { container, unmount } = await mountPool()
    try {
      const busyHint = (): HTMLSpanElement | undefined =>
        Array.from(container.querySelectorAll('.dsm-qoder-pool-hint'))
          .find(node => (node.textContent ?? '') === 'row.poolBusyHint') as HTMLSpanElement | undefined
      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      const testOf = (index: number): HTMLButtonElement =>
        rows[index]!.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement
      const batchTest = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      const batchCheckin = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolCheckinAll') as HTMLButtonElement
      const save = container.querySelector('.dsm-qoder-pool-save-buttons button.dsm-btn-primary') as HTMLButtonElement

      expect(testOf(0).disabled).toBe(false)

      await act(async () => { testOf(0).click() })

      // 1. **没有遮罩**。这是这次改动的全部理由。
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
      // 2. 那一行的按钮自己说话：文字与无障碍名都换成「测试中…」。
      expect(testOf(0).textContent).toBe('row.poolTesting')
      expect(testOf(0).disabled).toBe(true)
      // 3. 同类按钮互斥：另一行的测试、批量的测试与签到都禁用——两拨探针同时
      //    打向宿主就说不清谁的结果是谁了。
      expect(testOf(1).disabled).toBe(true)
      expect(batchTest.disabled).toBe(true)
      expect(batchCheckin.disabled).toBe(true)
      // 4. 「正在逐个账号执行…」是**批量专属**：只跑一行时说「逐个」是句假话
      //    （workbuddy 同规——它的 hint 挂在批量态 `busy` 上，行内不挂）。行内
      //    的轻提示就是那颗按钮自己的「测试中…」。
      expect(busyHint()).toBeUndefined()
      // 5. 其余控件**照旧可用**：勾选框与删除入口没有被测试锁住，保存按钮也没
      //    被改成「保存中」（它的禁用态来自「未改动」，不是来自这次测试）。
      const box = rows[1]!.querySelector('.dsm-qoder-pool-check input[type="checkbox"]') as HTMLInputElement
      expect(box.disabled).toBe(false)
      expect(save.textContent).toBe('row.poolSaved')
      expect((rows[0]!.querySelector('.dsm-qoder-pool-delete-btn') as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        hold.release?.({
          ok: true,
          status: 200,
          json: async () => ({
            action: 'test',
            modelId: 'qwen3-coder',
            rows: [{ accountId: 'a1', accountName: 'Alpha', result: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } }],
          }),
        } as Response)
      })

      // 收尾：按钮复位、全程没有遮罩出现过。
      expect(testOf(0).textContent).toBe('row.poolRowTest')
      expect(testOf(0).disabled).toBe(false)
      expect(testOf(1).disabled).toBe(false)
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('行内测试只打一行结果日志，不借用批量话术', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        action: 'test',
        modelId: 'qwen3-coder',
        rows: [{ accountId: 'a1', accountName: 'Alpha', result: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } }],
      }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPool()
    try {
      // 日志种子是模块级的（折叠卡片不清空历史），所以先清空再断言，本条测试
      // 才不依赖前面哪条跑过。
      await act(async () => { (container.querySelector('.dsm-qoder-pool-log-clear') as HTMLButtonElement).click() })
      const first = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')!
      await act(async () => { (first.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement).click() })

      // 请求确实只指向这一行。
      const url = String((fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown[])[0])
      expect(url).toContain('action=test')
      expect(url).toContain('accountId=a1')

      const texts = Array.from(container.querySelectorAll('.dsm-qoder-pool-log-text')).map(node => node.textContent ?? '')
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain('row.poolLogTestRow')
      // 「开始测试 N 个账号」「测试完成，已重新计算候选账号」在只测一行时是
      // 噪声，第二句还在宣称一件没发生的事（整池重排）。
      expect(container.textContent).not.toContain('row.poolLogTestStart')
      expect(container.textContent).not.toContain('row.poolLogTestDone')
    } finally {
      await unmount()
    }
  })

  it('行内测试时宿主没返回这一行的结果，就直说没返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ action: 'test', modelId: 'qwen3-coder', rows: [] }),
    } as Response)))
    const { container, unmount } = await mountPool()
    try {
      await act(async () => { (container.querySelector('.dsm-qoder-pool-log-clear') as HTMLButtonElement).click() })
      const first = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')!
      await act(async () => { (first.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement).click() })
      const texts = Array.from(container.querySelectorAll('.dsm-qoder-pool-log-text')).map(node => node.textContent ?? '')
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain('row.poolLogTestRowMalformed')
      // 锁已释放：不能因为一次没有结果的测试把按钮永久禁用。
      const btn = first.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement
      expect(btn.textContent).toBe('row.poolRowTest')
      expect(btn.disabled).toBe(false)
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('行内测试失败时报出原因并释放锁', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'qoder upstream unavailable' }),
    } as Response)))
    const { container, unmount } = await mountPool()
    try {
      await act(async () => { (container.querySelector('.dsm-qoder-pool-log-clear') as HTMLButtonElement).click() })
      const first = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')!
      await act(async () => { (first.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement).click() })
      expect(container.querySelector('.dsm-qoder-pool-error')?.textContent).toContain('qoder upstream unavailable')
      const btn = first.querySelectorAll('.dsm-qoder-pool-row-actions button')[0] as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      // 行内测试没有遮罩，横幅又会被下一次动作清掉，所以这一行必须落进活动日志。
      const logRows = Array.from(container.querySelectorAll('.dsm-qoder-pool-log-row'))
      expect(logRows).toHaveLength(1)
      expect(logRows[0]?.querySelector('.dsm-qoder-pool-log-text')?.textContent).toContain('qoder upstream unavailable')
      expect(logRows[0]?.querySelector('.dsm-qoder-pool-log-error')).not.toBeNull()
      // 行内不借用「批量操作失败 —— 没有执行」：这一次请求真的发出去了。
      expect(logRows[0]?.textContent).not.toContain('row.poolLogBatchFailed')
    } finally {
      await unmount()
    }
  })

  it('批量测试也不抬遮罩：只锁测试按钮并挂一句进度提示', async () => {
    const hold: { release?: (value: Response) => void } = {}
    batchFetchMock(hold)
    const { container, unmount } = await mountPool()
    try {
      const batchTest = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      await act(async () => { batchTest.click() })
      // 批量是几分钟级的串行真实探针（每个账号一次真实模型调用）。遮罩挡住一切
      // 又不给进度，用户把它当成「卡住」——现在整批也只锁测试按钮，界面照常可用。
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
      // 轻量在飞表达：那颗按钮自己变「测试中…」且禁用。
      const after = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTesting') as HTMLButtonElement
      expect(after).not.toBeUndefined()
      expect(after.disabled).toBe(true)
      // 行内测试按钮同样互斥（两拨探针不能同时打向宿主）。
      const rowTest = container.querySelector('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head) .dsm-qoder-pool-row-actions button') as HTMLButtonElement
      expect(rowTest.disabled).toBe(true)
      // 「正在逐个账号执行…」只在批量时挂，且此时它是真话（逐行进度会落位）。
      const hint = Array.from(container.querySelectorAll('.dsm-qoder-pool-hint'))
        .find(node => (node.textContent ?? '') === 'row.poolBusyHint')
      expect(hint).not.toBeUndefined()
      await act(async () => {
        hold.release?.({ ok: true, status: 200, json: async () => ({ action: 'test', rows: [] }) } as Response)
      })
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
      const idle = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      expect(idle.disabled).toBe(false)
    } finally {
      await unmount()
    }
  })

  it('批量测试在飞期间周期性重读快照（逐行进度自己会动）', async () => {
    vi.useFakeTimers()
    const hold: { release?: (value: Response) => void } = {}
    batchFetchMock(hold)
    const onChanged = vi.fn()
    const { container, unmount } = await mountPool({ onChanged })
    try {
      const batchTest = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      await act(async () => { batchTest.click() })
      expect(onChanged).not.toHaveBeenCalled()
      // 宿主每测完一个账号就把那条测量写进快照；卡片靠这次重读把那一行翻新。
      await act(async () => { vi.advanceTimersByTime(2_600) })
      expect(onChanged).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(2_500) })
      expect(onChanged).toHaveBeenCalledTimes(2)
      // 批次结束后轮询必须停下，否则会一直白白重读。
      await act(async () => {
        hold.release?.({ ok: true, status: 200, json: async () => ({ action: 'test', rows: [] }) } as Response)
      })
      const settled = onChanged.mock.calls.length
      await act(async () => { vi.advanceTimersByTime(10_000) })
      expect(onChanged).toHaveBeenCalledTimes(settled)
    } finally {
      vi.useRealTimers()
      await unmount()
    }
  })

  it('签到也不抬遮罩：按钮自变「签到中…」+ 进度提示', async () => {
    const hold: { release?: (value: Response) => void } = {}
    batchFetchMock(hold)
    const { container, unmount } = await mountPool()
    try {
      const batchCheckin = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolCheckinAll') as HTMLButtonElement
      await act(async () => { batchCheckin.click() })
      // 签到同样是串行批量动作（每个账号两次往返），用户要求它一起离开遮罩。
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
      const running = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolCheckingIn') as HTMLButtonElement
      expect(running).not.toBeUndefined()
      expect(running.disabled).toBe(true)
      const hint = Array.from(container.querySelectorAll('.dsm-qoder-pool-hint'))
        .find(node => (node.textContent ?? '') === 'row.poolBusyHint')
      expect(hint).not.toBeUndefined()
      // 签到在飞时测试类按钮同样互斥（两拨动作都要打宿主）。
      const batchTest = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      expect(batchTest.disabled).toBe(true)
      await act(async () => {
        hold.release?.({ ok: true, status: 200, json: async () => ({ action: 'checkin', rows: [] }) } as Response)
      })
      expect(container.querySelector('.dsm-qoder-veil')).toBeNull()
      const idle = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolCheckinAll') as HTMLButtonElement
      expect(idle.disabled).toBe(false)
    } finally {
      await unmount()
    }
  })

  it('批量动作逐条落日志：每行带自己的完成时刻，且整批响应不重复落行', async () => {
    vi.useFakeTimers()
    const hold: { release?: (value: Response) => void } = {}
    // 两个账号的完成时刻刻意不同：用户实拍的毛病正是「六条共用同一秒」。
    const atAlpha = new Date(2026, 0, 2, 10, 0, 5).getTime()
    const atBeta = new Date(2026, 0, 2, 10, 0, 9).getTime()
    const alphaRow = { accountId: 'a1', accountName: 'Alpha', result: { outcome: 'ok', atMs: atAlpha } }
    const betaRow = { accountId: 'a2', accountName: 'Beta', result: { outcome: 'ok', atMs: atBeta } }
    let done: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        // 进度轮询：只读宿主内存里的「已经处理完哪几行」。
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ action: 'progress', batch: { action: 'test', done } }),
        } as Response)
      }
      return new Promise<Response>(resolve => { hold.release = resolve })
    }))
    const { container, unmount } = await mountPool()
    try {
      await act(async () => { (container.querySelector('.dsm-qoder-pool-log-clear') as HTMLButtonElement).click() })
      const textsOf = (): string[] =>
        Array.from(container.querySelectorAll('.dsm-qoder-pool-log-text')).map(node => node.textContent ?? '')
      const timesOf = (): string[] =>
        Array.from(container.querySelectorAll('.dsm-qoder-pool-log-time')).map(node => node.textContent ?? '')
      const batchTest = Array.from(container.querySelectorAll('.dsm-qoder-pool-actions-group button'))
        .find(b => b.textContent === 'row.poolTestAll') as HTMLButtonElement
      await act(async () => { batchTest.click() })
      // 「开始」是按下按钮那一刻写的，不等结果——否则它会排到结果下面（日志新的在上）。
      expect(textsOf()).toHaveLength(1)
      expect(textsOf()[0]).toContain('row.poolLogTestStart')
      expect(textsOf()[0]).toContain('count=2')
      // 宿主测完第一个账号后，卡片在下一拍轮询里读到它，并**用它自己的完成时刻**落行。
      done = [{ atMs: atAlpha, row: alphaRow }]
      await act(async () => { vi.advanceTimersByTime(1_000) })
      expect(textsOf()).toHaveLength(2)
      expect(textsOf()[0]).toContain('row.poolLogTestRow')
      expect(textsOf()[0]).toContain('Alpha')
      expect(timesOf()[0]).toBe('10:00:05')
      // 第二个账号：一行一行出现，时间各自不同（这正是本次要修的观感）。
      done = [{ atMs: atAlpha, row: alphaRow }, { atMs: atBeta, row: betaRow }]
      await act(async () => { vi.advanceTimersByTime(1_000) })
      expect(textsOf()).toHaveLength(3)
      expect(textsOf()[0]).toContain('Beta')
      expect(timesOf()[0]).toBe('10:00:09')
      expect(timesOf()[1]).toBe('10:00:05')
      // 整批响应回来：它是权威答案，但轮询报过的两行**不能再写一遍**（否则看起来
      // 像跑了两轮），只补「完成」这一行。
      await act(async () => {
        hold.release?.({ ok: true, status: 200, json: async () => ({ action: 'test', rows: [alphaRow, betaRow] }) } as Response)
      })
      const texts = textsOf()
      expect(texts).toHaveLength(4)
      expect(texts[0]).toContain('row.poolLogTestDone')
      expect(texts.filter(text => text.includes('Alpha'))).toHaveLength(1)
      expect(texts.filter(text => text.includes('Beta'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await unmount()
    }
  })
})

/**
 * 「使用哪个账号」设置行。
 *
 * 它从 QoderCard 的账号行区域搬到这里（用户实拍 workbuddy 后要求照做），
 * 并且**只在池确实关闭时**渲染。判据必须是宿主已知的真实状态 `pool.enabled`，
 * 不是设置区的草稿——否则用户把开关拨到「开」还没保存时这一行就消失了，
 * 而他其实还没关闭池。
 */
describe('AccountPool「使用哪个账号」设置行', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  /** 池关闭、两个账号在册：设置行的正常形态。 */
  function poolOff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const fixture = poolFixture()
    return {
      ...fixture,
      enabled: false,
      ...overrides,
    }
  }

  /** 选号下拉现在住在标题行右侧（与「当前使用」芯片同一个槽位）。 */
  function manualSelect(container: HTMLElement): HTMLSelectElement | null {
    return container.querySelector<HTMLSelectElement>('.dsm-qoder-pool-head-pick select')
  }

  it('池开着时不渲染：那时谁服务由排序决定，控件改了也不生效', async () => {
    const { container, unmount } = await mountPool({ pool: poolFixture(), onSelectAccount: () => {} })
    try {
      expect(poolFixture()['enabled']).toBe(true)
      expect(manualSelect(container)).toBeNull()
      expect(container.textContent).not.toContain('row.poolManualAccountLabel')
    } finally {
      await unmount()
    }
  })

  it('池关闭时在标题行给出选号下拉，选中值就是在服务的账号', async () => {
    const { container, unmount } = await mountPool({ pool: poolOff(), onSelectAccount: () => {} })
    try {
      const pick = container.querySelector('.dsm-qoder-pool-head-pick')
      expect(pick).not.toBeNull()
      // 控件自带名字（workbuddy 判据：名字由控件本身携带，不再单占一行说明）。
      expect(pick!.querySelector('.dsm-qoder-pool-head-pick-label')?.textContent).toBe('row.poolManualAccountLabel')

      const select = manualSelect(container)!
      // a1 在 fixture 里 current: true —— 下拉显示的必须正是它，不能是列表第一项。
      expect(select.value).toBe('a1')
      const labels = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
      expect(labels[0]).toBe('row.accountSelectAuto')
      expect(labels).toContain('Alpha')
      expect(labels).toContain('Beta')
    } finally {
      await unmount()
    }
  })

  it('改选账号时把 id 交给宿主（立即生效，不走保存）', async () => {
    const picked: string[] = []
    const { container, unmount } = await mountPool({
      pool: poolOff(),
      onSelectAccount: (accountId: string) => { picked.push(accountId) },
    })
    try {
      const select = manualSelect(container)!
      await act(async () => {
        select.value = 'a2'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(picked).toEqual(['a2'])
    } finally {
      await unmount()
    }
  })

  it('「自动」是真实选项：选中它把空串交给宿主', async () => {
    // qoder 的账号来源是 settings → env → vault 三级回退，`state.accountId`
    // 为空时正是按这个顺序解析，所以「自动」不是占位符。（workbuddy 没有这条
    // 回退链，它的下拉里没有自动项，这里不能照抄。）
    const picked: string[] = []
    const { container, unmount } = await mountPool({
      pool: poolOff(),
      onSelectAccount: (accountId: string) => { picked.push(accountId) },
    })
    try {
      const select = manualSelect(container)!
      await act(async () => {
        select.value = ''
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(picked).toEqual([''])
    } finally {
      await unmount()
    }
  })

  it('没有账号在生效时显示「当前没有生效的账号」，且不冒充「自动」', async () => {
    // 回归：哨兵值曾经和「自动」共用空串，于是没有生效账号时下拉显示成
    // 「自动 —— 设置 → 环境变量 → 保险库」，等于替用户宣称了一个他没做过的
    // 选择。哨兵必须是另一个不可选中的值。
    const fixture = poolOff()
    const accounts = (fixture['accounts'] as Record<string, unknown>[]).map(account => ({ ...account, current: false }))
    const { container, unmount } = await mountPool({ pool: { ...fixture, accounts }, onSelectAccount: () => {} })
    try {
      const select = manualSelect(container)!
      expect(select.selectedOptions[0]?.textContent).toBe('row.poolManualAccountNone')
      expect(select.selectedOptions[0]?.disabled).toBe(true)
      // 「自动」仍在，且是另一个值：两者共存才说明没有混淆。
      const auto = Array.from(select.querySelectorAll('option')).find(o => o.textContent === 'row.accountSelectAuto')!
      expect(auto.value).toBe('')
      expect(select.value).not.toBe('')
    } finally {
      await unmount()
    }
  })

  it('同名账号补 id 尾号，才分得清选的是哪一条', async () => {
    // 同一个邮箱重新签发 PAT 会得到两条记录（id 由 PAT 推导，不同），两条
    // 显示名一模一样。只显示名字的话「我当前在用哪一条」答案是「看不出」。
    // （这条规则原先在 QoderCard 的旧下拉里，随控件一起搬过来。）
    const fixture = poolOff()
    const accounts = [
      { ...((fixture['accounts'] as Record<string, unknown>[])[0]!), accountId: 'pat-84ad6cf5b4f62d10', accountName: 'same@msn.com', current: false },
      { ...((fixture['accounts'] as Record<string, unknown>[])[1]!), accountId: 'pat-5d76517ac7699f87', accountName: 'same@msn.com', current: true },
    ]
    const { container, unmount } = await mountPool({ pool: { ...fixture, accounts }, onSelectAccount: () => {} })
    try {
      const labels = Array.from(manualSelect(container)!.querySelectorAll('option'))
        .map(o => o.textContent ?? '')
        .filter(text => text.startsWith('same@msn.com'))
      expect(labels).toHaveLength(2)
      expect(labels.some(text => text.includes('2d10'))).toBe(true)
      expect(labels.some(text => text.includes('9f87'))).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('调用方不提供 onSelectAccount 时整行不渲染（没有写权限就别摆控件）', async () => {
    const { container, unmount } = await mountPool({ pool: poolOff() })
    try {
      expect(container.textContent).not.toContain('row.poolManualAccountLabel')
    } finally {
      await unmount()
    }
  })

  it('池里一个账号都没有时不渲染（下拉只剩「自动」，等于噪声）', async () => {
    const { container, unmount } = await mountPool({ pool: { ...poolOff(), accounts: [] }, onSelectAccount: () => {} })
    try {
      expect(container.textContent).not.toContain('row.poolManualAccountLabel')
    } finally {
      await unmount()
    }
  })
})

describe('AccountPool 标题芯片：谁在服务', () => {
  /** 池里没人能用：宿主答「没有人在服务」，且给出用户保存的选择。 */
  function poolAllBenched(): Record<string, unknown> {
    const base = poolFixture()
    const accounts = (base.accounts as Record<string, unknown>[]).map(row => ({
      ...row,
      current: false,
      excludedBy: 'out-of-credit',
    }))
    return { ...base, accounts, servingUnavailable: true, selectedAccountId: 'a1' }
  }

  it('全员被排除时芯片改说「没有账号可用」，不再指着一个已排除的号', async () => {
    // 用户实拍（2026-10-18）的极端版：那个号自己也用尽了。此时任何一行标
    // 「当前使用」都是假话 —— 它并没有在服务，下一个请求会直接失败。
    const { container, unmount } = await mountPool({ pool: poolAllBenched(), onSelectAccount: () => {} })
    try {
      const badge = container.querySelector('.dsm-qoder-pool-current-badge')
      expect(badge).not.toBeNull()
      expect(badge!.textContent).toBe('row.poolCurrentHeaderUnavailable')
      expect(badge!.className).toContain('dsm-qoder-pool-current-badge-off')
      // 行内不能还有任何一行被标成在计费。
      expect(container.querySelectorAll('.dsm-qoder-pool-current-tag').length).toBe(0)
    } finally {
      await unmount()
    }
  })

  it('只要还有账号能用，芯片就仍是「当前使用」', async () => {
    // 正常路径不能被上面的降级误伤：有号在服务时如实报出它的名字。
    const { container, unmount } = await mountPool({ pool: poolFixture(), onSelectAccount: () => {} })
    try {
      const badge = container.querySelector('.dsm-qoder-pool-current-badge')
      expect(badge!.textContent).toContain('Alpha')
      expect(badge!.className).not.toContain('dsm-qoder-pool-current-badge-off')
    } finally {
      await unmount()
    }
  })
})

/**
 * 优先级排序 UI。
 *
 * 最要紧的一条是「没排过就说自动排序」：如果卡片对着一个由积分策略决定的
 * 顺序显示「第 1 位」「第 2 位」，用户会以为这是自己的选择，而它每次刷新都在变。
 * 这比不显示名次更糟。
 */
describe('AccountPool 优先级排序', () => {
  const rn = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      .map(row => row.querySelector('.dsm-qoder-pool-account-name b')?.textContent ?? '')

  it('没有手动排序时显示「自动排序」，不伪造名次', async () => {
    const { container, unmount } = await mountPool()
    try {
      const tags = Array.from(container.querySelectorAll('.dsm-qoder-pool-rank-auto')).map(n => n.textContent)
      expect(tags).toEqual(['row.poolRankAuto', 'row.poolRankAuto'])
      // 一个「第 N 位」都不能出现。
      expect(container.querySelector('.dsm-qoder-pool-rank')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('保存过顺序就显示真实名次', async () => {
    const { container, unmount } = await mountPool({ pool: { ...poolFixture(), orderAccountIds: ['a2', 'a1'] } })
    try {
      // a2 被编排在第 1 位，但它在 fixture 里是 out-of-credit —— 可用性优先，
      // 所以它沉到末尾；a1 虽然被编排为第 2 位，实际最先发号，名次也随之升到第 1。
      expect(rn(container)).toEqual(['Alpha', 'Beta'])
      const ranks = Array.from(container.querySelectorAll('.dsm-qoder-pool-rank')).map(n => n.textContent)
      expect(ranks).toEqual(['row.poolRank|rank=2', 'row.poolRankExcluded|rank=1'])
    } finally {
      await unmount()
    }
  })

  it('上移/下移按钮在首尾各自禁用而不是消失', async () => {
    const { container, unmount } = await mountPool({ pool: { ...poolFixture(), orderAccountIds: ['a1', 'a2'] } })
    try {
      const rows = Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      const firstBtns = rows[0]!.querySelectorAll('.dsm-qoder-pool-move-btn')
      const lastBtns = rows[1]!.querySelectorAll('.dsm-qoder-pool-move-btn')
      // 按钮数量恒定：隐藏会让按钮在行间跳位。
      expect(firstBtns).toHaveLength(2)
      expect(lastBtns).toHaveLength(2)
      expect((firstBtns[0] as HTMLButtonElement).disabled).toBe(true)
      expect((firstBtns[1] as HTMLButtonElement).disabled).toBe(false)
      expect((lastBtns[0] as HTMLButtonElement).disabled).toBe(false)
      expect((lastBtns[1] as HTMLButtonElement).disabled).toBe(true)
    } finally {
      await unmount()
    }
  })

  it('池关闭时不给排序控件 —— 没有「先发谁」这回事', async () => {
    const { container, unmount } = await mountPool({ pool: { ...poolFixture(), enabled: false } })
    try {
      expect(container.querySelector('.dsm-qoder-pool-move')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('点「↓」把这一行与下一行对调，并标为未保存', async () => {
    const { container, unmount } = await mountPool()
    try {
      expect(rn(container)).toEqual(['Alpha', 'Beta'])
      const rows = container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)')
      const down = container.querySelectorAll('.dsm-qoder-pool-move-btn')
      // [0]=Alpha↑ [1]=Alpha↓ [2]=Beta↑ [3]=Beta↓
      await act(async () => { (down[1] as HTMLButtonElement).click() })
      // 第一次拖动就把可见顺序整个落下来：从此不再自动排。
      expect(rn(container)).toEqual(['Alpha', 'Beta'])
      expect(rows.length).toBe(2)
    } finally {
      await unmount()
    }
  })
})

/**
 * 名次表必须与实际发号顺序一致。
 *
 * 用户实拍（2026-10-18）：`nick1064248741` 用量已达上限却排在第 1 位，
 * 第 2 位才是「✓ 可用」的号。宿主 `rankPool` 第 1 层就是可用性，请求实际
 * 发给第 2 位，而表格宣称第 1 位优先 —— **名次表撒谎比没有名次表更糟**。
 */
describe('AccountPool 名次与可用性', () => {
  const rn = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('.dsm-qoder-pool-row:not(.dsm-qoder-pool-row-head)'))
      .map(row => row.querySelector('.dsm-qoder-pool-account-name b')?.textContent ?? '')

  it('被排除的号即使排在第 1 位，也沉到所有可用号之后', async () => {
    const { container, unmount } = await mountPool({
      // a2 是 out-of-credit（fixture 里就是），用户却把它排第一。
      pool: { ...poolFixture(), orderAccountIds: ['a2', 'a1'] },
    })
    try {
      // a1 可用 → 前；a2 用尽 → 后。与宿主的发号顺序一致。
      expect(rn(container)).toEqual(['Alpha', 'Beta'])
    } finally {
      await unmount()
    }
  })

  it('出池的号标「暂不参与」，不把自己报成当前优先', async () => {
    const { container, unmount } = await mountPool({
      pool: { ...poolFixture(), orderAccountIds: ['a2', 'a1'] },
    })
    try {
      const tags = Array.from(container.querySelectorAll('.dsm-qoder-pool-rank')).map(n => n.textContent)
      // a2 被编排在第 1 位却出池 → 沉到最后，标注保留它的编排位次但说「暂不参与」；
      // a1 因此成为实际第 1 个发号的账号。
      expect(tags).toEqual(['row.poolRank|rank=2', 'row.poolRankExcluded|rank=1'])
    } finally {
      await unmount()
    }
  })

  it('可用号之间仍完全按用户顺序', async () => {
    const pool = poolFixture()
    // 让 a2 也可用，才谈得上「两者都能用谁先」。
    const accounts = (pool.accounts as Record<string, unknown>[]).map(a =>
      a.accountId === 'a2' ? { ...a, excludedBy: undefined, probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' } } : a)
    const { container, unmount } = await mountPool({ pool: { ...pool, accounts, orderAccountIds: ['a2', 'a1'] } })
    try {
      expect(rn(container)).toEqual(['Beta', 'Alpha'])
    } finally {
      await unmount()
    }
  })
})

