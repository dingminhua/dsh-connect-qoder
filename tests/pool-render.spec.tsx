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
    checkinSupported: false,
    memberAccountIds: ['a1', 'a2'],
    effectiveMemberAccountIds: ['a1', 'a2'],
    catalog: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', creditMultiplier: 0.79, contextWindow: 262_144 }],
    accounts: [
      {
        accountId: 'a1',
        accountName: 'Alpha',
        current: true,
        member: true,
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
})
