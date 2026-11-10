/**
 * 池偏好的**写盘落地校验**（含 issue #36 的自动签到开关）。
 *
 * 为什么这一条值得单独钉：`writePoolPreferences` 的契约不是「调用了 set 就算成功」，
 * 而是「**回读之后值真的在那儿**」。宿主与 settings 镜像都可能静默丢掉一次写入，
 * 而「保存成功」的后果是卡片丢弃草稿 —— 用户看到的就是「我改了，但它自己弹回去
 * 了，而且没有报错」。
 *
 * 自动签到开关是这条契约里最严重的一例：它是这张卡片里唯一授权**后台写入用户
 * 账号**的配置项。它静默丢失，用户以为开着，实际一次都不会跑。
 *
 * 因此每个断言都对着「被丢掉的写入必须**抛**」，而不是「写入被发出去了」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderSettingsWriteError, writePoolPreferences } from '../src/client/account-selection.ts'

/**
 * 一个假的 settings scope：`drop` 里的键在**回读时**消失，模拟被镜像吞掉的写入。
 */
function fakeScope(drop: readonly string[] = []): {
  getSnapshot: () => { value: unknown }
  set: (field: string, value: unknown) => Promise<boolean>
} {
  let regions: Record<string, unknown> = {}
  return {
    getSnapshot: () => ({ value: { regions } }),
    set: async (field, value) => {
      if (field !== 'regions') return false
      const incoming = value as Record<string, { pool: Record<string, unknown> }>
      const next: Record<string, unknown> = { ...regions }
      for (const [region, slot] of Object.entries(incoming)) {
        const pool: Record<string, unknown> = { ...slot.pool }
        for (const key of drop) delete pool[key]
        next[region] = { ...slot, pool }
      }
      regions = next
      return true
    },
  }
}

const prefs = {
  enabled: true,
  targetModelId: 'qwen3-coder',
  memberAccountIds: ['a1'],
  orderAccountIds: ['a1'],
  autoCheckin: true,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writePoolPreferences 的落地校验', () => {
  it('全部字段落地时不抛，且开关真的写进了池槽', async () => {
    // Host 端点不可用 → 走 scope 兜底，这条路才是校验真正执行的地方
    // （端点那条是「服务端合并并返回」，失败就抛）。
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('endpoint down'))))
    const scope = fakeScope()
    await expect(writePoolPreferences(scope, 'cn', prefs)).resolves.toBeUndefined()
    const stored = (scope.getSnapshot().value as { regions: Record<string, { pool: Record<string, unknown> }> })
      .regions['cn']!.pool
    expect(stored['autoCheckin']).toBe(true)
    expect(stored['orderAccountIds']).toEqual(['a1'])
  })

  it('开关被静默丢掉时必须抛 —— 否则用户以为开着，实际一次都不跑', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('endpoint down'))))
    const scope = fakeScope(['autoCheckin'])
    await expect(writePoolPreferences(scope, 'cn', prefs)).rejects.toBeInstanceOf(QoderSettingsWriteError)
  })

  it('缺省（省略 autoCheckin）写的是 false，而不是留空', async () => {
    // 留空的键参与不了落地比对：宿主把它丢了与「用户没要」在屏幕上完全同形。
    // 用解构把键**真的摘掉**，而不是赋 `undefined` —— `exactOptionalPropertyTypes`
    // 下这两件事不同，而这一条测的正是「完全没写这个键」的那种调用。
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('endpoint down'))))
    const scope = fakeScope()
    const { autoCheckin: _omitted, ...withoutSwitch } = prefs
    await writePoolPreferences(scope, 'cn', withoutSwitch)
    const stored = (scope.getSnapshot().value as { regions: Record<string, { pool: Record<string, unknown> }> })
      .regions['cn']!.pool
    expect(stored['autoCheckin']).toBe(false)
  })

  it('顺序被吞也照旧要抛（既有契约不能被这次改动碰松）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('endpoint down'))))
    const scope = fakeScope(['orderAccountIds'])
    await expect(writePoolPreferences(scope, 'cn', prefs)).rejects.toBeInstanceOf(QoderSettingsWriteError)
  })
})
