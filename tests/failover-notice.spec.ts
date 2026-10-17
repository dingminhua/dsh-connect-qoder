import { describe, expect, it } from 'vitest'
import {
  accountLabelOf,
  failoverNoticeText,
  failoverReasonText,
  shouldAnnounceFailover,
} from '../src/failover-notice.ts'
import type { UpstreamErrorKind } from '../src/upstream.ts'

/** 上游 `UpstreamErrorKind` 全集。新增 kind 时这里与 REASON_TEXT 都必须补。 */
const ALL_KINDS: readonly UpstreamErrorKind[] = [
  'network',
  'auth',
  'rate-limited',
  'invalid-request',
  'content-policy',
  'quota-exhausted',
  'transient',
  'unknown',
]

describe('failoverReasonText —— 每种失败都有话说，且不编造', () => {
  it('covers every UpstreamErrorKind with a non-empty reason', () => {
    for (const kind of ALL_KINDS) {
      const text = failoverReasonText(kind)
      expect(text.length, `kind ${kind} 没有文案`).toBeGreaterThan(0)
    }
  })

  it('rate-limited reads as 被限流', () => {
    expect(failoverReasonText('rate-limited')).toBe('被限流')
  })

  it('quota-exhausted 说的是「当日用量已达上限」，绝不说「积分耗尽」', () => {
    // qoder 业务码 110 = 当日用量已达上限、次日恢复。说成「积分耗尽」会误导
    // 用户去充值，而充值并不能解决当天的额度问题。
    const text = failoverReasonText('quota-exhausted')
    expect(text).toBe('当日用量已达上限')
    expect(text).not.toContain('积分')
    expect(text).not.toContain('耗尽')
  })

  it('未知 kind 走中性兜底，不编造具体原因', () => {
    const text = failoverReasonText('某个未来才有的kind')
    expect(text).toBe(failoverReasonText('unknown'))
    // 兜底文案不能出现任何具体的失败归因词。
    for (const word of ['限流', '额度', '积分', '凭证', '网络']) {
      expect(text).not.toContain(word)
    }
  })
})

describe('accountLabelOf —— 提示里怎么称呼账号', () => {
  it('有名字用名字', () => {
    expect(accountLabelOf('450702134816', 'acc-a')).toBe('450702134816')
  })

  it('名字为空时退回 id（env 路径下 accountName 就是空串）', () => {
    expect(accountLabelOf('', 'acc-a')).toBe('acc-a')
  })

  it('名字只有空白也算空', () => {
    expect(accountLabelOf('   ', 'acc-a')).toBe('acc-a')
  })

  it('名字与 id 都为空时给中性说法，绝不产出空书名号', () => {
    const label = accountLabelOf('', '')
    expect(label.length).toBeGreaterThan(0)
    expect(label.trim()).toBe(label)
  })
})

describe('failoverNoticeText —— 说失败的那个，不说接管者', () => {
  it('点名的是用户选中的账号与失败原因', () => {
    const text = failoverNoticeText({ accountName: '450702134816', accountId: 'acc-a' }, 'rate-limited')
    expect(text).toContain('「450702134816」')
    expect(text).toContain('被限流')
    expect(text).toContain('另一个账号')
  })

  it('不含任何换行——它会被放进单条内容帧', () => {
    const text = failoverNoticeText({ accountName: 'A', accountId: 'a' }, 'auth')
    expect(text).not.toContain('\n')
  })
})

describe('shouldAnnounceFailover —— 只在真的换了号时才提示', () => {
  const base = { switched: true, fromAccountId: 'acc-a', toAccountId: 'acc-b', kind: 'rate-limited' as const }

  it('换了号就提示', () => {
    expect(shouldAnnounceFailover(base)).toBe(true)
  })

  it('没换号不提示（单账号池、或失败后无后继可试）', () => {
    expect(shouldAnnounceFailover({ ...base, switched: false })).toBe(false)
  })

  it('拿不到失败原因就不提示——不知道原因的话，写出来的话都是编的', () => {
    expect(shouldAnnounceFailover({ ...base, kind: undefined })).toBe(false)
  })

  it('前后是同一个账号等于没换，不提示', () => {
    expect(shouldAnnounceFailover({ ...base, toAccountId: 'acc-a' })).toBe(false)
  })

  it('来源账号未知时不提示，避免产出「「」被限流」', () => {
    expect(shouldAnnounceFailover({ ...base, fromAccountId: '' })).toBe(false)
  })
})
