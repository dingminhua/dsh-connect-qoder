// @vitest-environment jsdom
/**
 * 自动签到在**卡片**上的那一半（issue #36）。
 *
 * 宿主侧接线与规则分别有 `tests/index.spec.ts` 与 `tests/auto-checkin.spec.ts`
 * 钉着；这个文件只回答三个 UI 问题：
 *
 * 1. 开关住哪 —— 它必须与「启用账号池」在**同一个模式条**里（两者都是「这一页的
 *    模式」），而不是藏进设置卡片那堆偏好里。它是这张卡片里唯一授权后台写入用户
 *    账号的开关。
 * 2. 进度行说什么 —— 三态三句话（全签完 / 半途 / 还欠重试），而且**只在保存着的
 *    开关为真时**才出现：给一个草稿状态的开关显示进度，等于宣称一个任务在跑。
 * 3. 缺席时说什么 —— `autoCheckinToday` 缺席（开关刚打开、还没跑过第一拍）时
 *    **不渲染**进度行，而不是打印「0 / 0」：后者为一天编了一个分母。
 *
 * 区域不支持签到时整行都不渲染 —— 与签到列、签到按钮同一条判据。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
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

const scope = { getSnapshot: () => ({ value: {} }), set: async () => true }

/** One member, signed in, pool on. Everything the switch needs to be editable. */
function poolFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    targetModelId: 'qwen3-coder',
    targetModelSource: 'preferred',
    checkinSupported: true,
    memberAccountIds: ['a1'],
    effectiveMemberAccountIds: ['a1'],
    catalog: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', creditMultiplier: 0.79 }],
    accounts: [{
      accountId: 'a1',
      accountName: 'Alpha',
      current: true,
      member: true,
      source: 'vault',
      credits: 1200,
    }],
    ...overrides,
  }
}

async function mountPool(overrides: Record<string, unknown> = {}): Promise<{
  container: HTMLDivElement
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(AccountPool as any, {
      t,
      region: 'cn',
      pool: poolFixture(overrides),
      settingsScope: scope,
      canWrite: true,
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

/** The auto check-in row's checkbox, found by its own wrapper class. */
function switchOf(container: HTMLElement): HTMLInputElement {
  const row = container.querySelector('.dsm-qoder-pool-auto-checkin')
  expect(row, '没找到自动签到那一行').not.toBeNull()
  const box = row!.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  expect(box, '自动签到那一行里没有复选框').not.toBeNull()
  return box!
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('开关的位置与语义', () => {
  it('与「启用账号池」住在同一个模式条里，且排在它之后', async () => {
    // 两个开关管的是两件事（谁挑号 / 插件能不能自己动手），但都是「这一页的
    // 模式」。把它塞进设置卡片，等于把它埋在它所影响的一切下面。
    const { container, unmount } = await mountPool()
    try {
      const modebar = container.querySelector('.dsm-qoder-pool-modebar')
      expect(modebar).not.toBeNull()
      expect(switchOf(modebar as HTMLElement)).not.toBeNull()
      const boxes = Array.from(modebar!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
      // 第一个仍是模式开关：它决定下面每一列怎么读。
      expect(boxes).toHaveLength(2)
      expect(boxes[1]).toBe(switchOf(container))
    } finally {
      await unmount()
    }
  })

  it('缺席的 autoCheckin 读作关 —— 这是唯一授权后台写入的开关', async () => {
    // 「宿主答不上来」绝不能变成「开着」。升级后的老 profile 里根本没有这个键。
    const { container, unmount } = await mountPool({ autoCheckin: undefined })
    try {
      expect(switchOf(container).checked).toBe(false)
    } finally {
      await unmount()
    }
  })

  it('拨一下就是草稿改动（要保存才生效，与这一页其它开关同规）', async () => {
    const { container, unmount } = await mountPool()
    try {
      const box = switchOf(container)
      await act(async () => { box.click() })
      expect(box.checked).toBe(true)
      expect(container.querySelector('.dsm-qoder-pool-modebar .dsm-qoder-pool-dirty')?.textContent)
        .toBe('row.poolDirty')
    } finally {
      await unmount()
    }
  })

  it('区域不支持签到时整行都不渲染（与签到列、签到按钮同一条判据）', async () => {
    // 给一个「这里没有」的开关，用户勾了也只会得到一次失败。
    const { container, unmount } = await mountPool({ checkinSupported: false })
    try {
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin')).toBeNull()
      // 说明文字也一起走，不留一段解释一个不存在控件的段落。
      expect(container.textContent).not.toContain('row.poolAutoCheckinHint')
    } finally {
      await unmount()
    }
  })

  it('只读权限下开关禁用', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(AccountPool as any, {
        t,
        region: 'cn',
        pool: poolFixture({ autoCheckin: true }),
        settingsScope: scope,
        canWrite: false,
      }))
    })
    const box = switchOf(container)
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('进度行', () => {
  it('开关开着、这一窗全签完：说「全部已签」，不出现「待重试」', async () => {
    const { container, unmount } = await mountPool({
      autoCheckin: true,
      autoCheckinToday: { done: 2, total: 2, pending: 0 },
    })
    try {
      const status = container.querySelector('.dsm-qoder-pool-auto-checkin-status')
      expect(status).not.toBeNull()
      expect(status!.textContent).toContain('row.poolAutoCheckinDone')
      expect(status!.textContent).toContain('total=2')
      // 「待重试」只在真的还欠着时出现 —— 否则三个数字里两个说同一件事。
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-pending')).toBeNull()
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-error')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('半途：写真实的 done / total，并说明还欠几个重试', async () => {
    const { container, unmount } = await mountPool({
      autoCheckin: true,
      autoCheckinToday: { done: 1, total: 3, pending: 2 },
    })
    try {
      const status = container.querySelector('.dsm-qoder-pool-auto-checkin-status')
      expect(status!.textContent).toContain('row.poolAutoCheckinToday')
      expect(status!.textContent).toContain('done=1')
      expect(status!.textContent).toContain('total=3')
      // 这句话是用户唯一能知道「它还在试」而不是「它悄悄卡住了」的地方。
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-pending')?.textContent)
        .toContain('count=2')
      // 全签完那句不能同时出现。
      expect(status!.textContent).not.toContain('row.poolAutoCheckinDone')
    } finally {
      await unmount()
    }
  })

  it('上次失败过：把原因写出来（否则「待重试」没有缘由）', async () => {
    const { container, unmount } = await mountPool({
      autoCheckin: true,
      autoCheckinToday: { done: 0, total: 1, pending: 1, lastError: '凭据被拒' },
    })
    try {
      const error = container.querySelector('.dsm-qoder-pool-auto-checkin-error')
      expect(error?.textContent).toContain('message=凭据被拒')
      // 悬停里放完整原因：这一行会被 CSS 截断，截掉的正是「为什么」。
      expect(error?.getAttribute('title')).toBe('凭据被拒')
    } finally {
      await unmount()
    }
  })

  it('还没跑过（`autoCheckinToday` 缺席）：一行都不渲染，而不是「0 / 0」', async () => {
    // 全零会为一天编一个分母，并让「什么都没跑」与「跑了、没活可干」在屏幕上同形。
    const { container, unmount } = await mountPool({ autoCheckin: true })
    try {
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-status')).toBeNull()
      expect(container.textContent).not.toContain('row.poolAutoCheckinToday')
      expect(container.textContent).not.toContain('row.poolAutoCheckinDone')
    } finally {
      await unmount()
    }
  })

  it('开关关着时，即使宿主给了进度也不渲染 —— 它描述的是运行器在做什么', async () => {
    // 关掉之后的下一拍才会清掉宿主那份状态；这一帧里宿主可能还在报昨天的进度。
    // 显示它等于对着一关掉的开关宣称任务在跑。
    const { container, unmount } = await mountPool({
      autoCheckin: false,
      autoCheckinToday: { done: 1, total: 1, pending: 0 },
    })
    try {
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-status')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('草稿里刚打开、还没保存：不显示进度 —— 它还没启动任何东西', async () => {
    const { container, unmount } = await mountPool({
      // 宿主侧还没看到这次打开，所以没有进度；但先造一个「有进度」的现场，
      // 确认那段进度是跟着**保存着的**开关走的。
      autoCheckin: false,
      autoCheckinToday: { done: 1, total: 1, pending: 0 },
    })
    try {
      const box = switchOf(container)
      await act(async () => { box.click() })
      expect(box.checked).toBe(true)
      expect(container.querySelector('.dsm-qoder-pool-auto-checkin-status')).toBeNull()
    } finally {
      await unmount()
    }
  })
})

describe('说明文字', () => {
  it('把两条要点都说出来：先读状态不会重复领，漏一窗就是白丢', async () => {
    // 用户授权一次真实写入之前，必须看得到「它会做什么、不会做什么、不做会怎样」。
    const { container, unmount } = await mountPool()
    try {
      // 模式条里有两条 note：模式那句 + 自动签到那句。按 key 找那一句，
      // 而不是按下标 —— 位置会随着布局调整而变，key 不会。
      const notes = Array.from(container.querySelectorAll('.dsm-qoder-pool-modebar .dsm-qoder-pool-note'))
        .map(node => node.textContent ?? '')
      expect(notes).toHaveLength(2)
      expect(notes.some(value => value.includes('row.poolAutoCheckinHint'))).toBe(true)
      // 模式那句仍然在（不是被这一条顶掉了）。
      expect(notes.some(value => value.includes('row.poolEnabledHint'))).toBe(true)
    } finally {
      await unmount()
    }
  })
})
