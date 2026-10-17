/**
 * Qoder 账号池的纯逻辑：rankPool / exclusionOf / pickAccount / resolveTargetModel /
 * pickFreeModel / effectiveMembersOf / createLatestWins。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/account-pool.spec.ts` —— 打分明细与冷却分档原样沿用，但按 Qoder 的实际
 *   端口做了三处调整：
 *   1. 排名成员没有 `tokenExpiresAtMs`（PAT 通常不过期），全等并列只靠账号 id
 *      决胜，不再看凭据新鲜度；
 *   2. 免费语义落在 `creditMultiplier === 0` **唯一**判据（`is_free` 已由 Host
 *      折叠成 0），缺失倍数仍视为非免费；
 *   3. 冷却分档唯一来源是 `retryAtMs` / 未知冷却回退，`policy-rejected` 与
 *      `ok` 同为候选态，不进入 `default` 分支。
 *
 * 这些是登录/积分/PAT 语义差异导致的「别断言错」提醒，不是逐字照抄。
 */

import { describe, expect, it } from 'vitest'
import {
  createLatestWins,
  effectiveMembersOf,
  exclusionOf,
  pickAccount,
  pickFreeModel,
  POOL_UNKNOWN_COOLDOWN_MS,
  rankPool,
  resolveTargetModel,
} from '../src/account-pool.ts'
import type {
  QoderPoolMember,
  QoderPoolModel,
} from '../src/account-pool.ts'

const NOW = 1_800_000_000_000

/** A pool member with only the fields a test cares about. */
function member(
  id: string,
  options: {
    credits?: number
    /**
     * HOW MUCH is expiring inside the "soon" window (not when). Real credit
     * snapshots always carry both, and the ranking reads both: `expiringSoon`
     * decides "is anything at risk", `nearestExpiryMs` decides "who lapses
     * first". Set this whenever `nearestExpiryMs` is set, or the account is
     * ranked as "nothing at risk" — which is what the old single-key code did
     * by accident (upstream issue #70).
     */
    expiringSoon?: number
    nearestExpiryMs?: number
    probe?: QoderPoolMember['probe']
  } = {},
): QoderPoolMember {
  return {
    account: { id, accountName: id },
    ...options.credits === undefined
      ? {}
      : {
          credits: {
            total: options.credits,
            expiringSoon: options.expiringSoon ?? 0,
            ...options.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: options.nearestExpiryMs },
          },
        },
    ...options.probe === undefined ? {} : { probe: options.probe },
  }
}

/** A catalog entry. An absent `creditMultiplier` means the upstream stated none. */
function model(id: string, contextWindow: number, creditMultiplier?: number): QoderPoolModel {
  return {
    id,
    name: id,
    contextWindow,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
  }
}

describe('pickFreeModel', () => {
  it('picks a multiplier of exactly zero', () => {
    const picked = pickFreeModel([model('paid', 100_000, 0.79), model('free', 200_000, 0)])
    expect(picked?.id).toBe('free')
  })

  it('DOES NOT treat an absent multiplier as free', () => {
    // Qoder 的 CN 静态 fallback 目录不带 `creditMultiplier`（价格因子由上游目录
    // 给出，fallback 时未知）。把缺失读成 0 会把用户以为免费的批量真金白银地送去
    // 探测付费模型。
    const picked = pickFreeModel([model('unrated', 1_000_000), model('paid', 100_000, 3.31)])
    expect(picked).toBeUndefined()
  })

  it('prefers the largest context window among free models', () => {
    const picked = pickFreeModel([
      model('small', 192_000, 0),
      model('large', 1_000_000, 0),
      model('medium', 512_000, 0),
    ])
    expect(picked?.id).toBe('large')
  })

  it('returns undefined when the catalog has no free model', () => {
    expect(pickFreeModel([model('a', 100_000, 1.2)])).toBeUndefined()
  })

  it('returns undefined for an empty catalog', () => {
    expect(pickFreeModel([])).toBeUndefined()
  })

  it('treats a zero-multiplier model as free even with a tiny window', () => {
    // 0 是对「免费」的肯定声明，不等同于缺失，因此小窗口不能把它刷掉。
    expect(pickFreeModel([model('tiny', 8_000, 0)])?.id).toBe('tiny')
  })
})

describe('resolveTargetModel', () => {
  const catalog = [model('free', 1_000_000, 0), model('paid', 1_000_000, 0.79)]

  it('prefers an explicit id over the free default', () => {
    const target = resolveTargetModel(catalog, 'paid')
    expect(target).toEqual({ modelId: 'paid', source: 'preferred' })
  })

  it('falls back to the free model when no id is given', () => {
    expect(resolveTargetModel(catalog, undefined)).toEqual({ modelId: 'free', source: 'free' })
  })

  it('reports "none" rather than a paid fallback when nothing is free', () => {
    const picked = resolveTargetModel([model('paid', 1_000_000, 0.79)], undefined)
    expect(picked).toEqual({ source: 'none' })
    expect(picked.modelId).toBeUndefined()
  })

  it('treats an empty-string id as unspecified', () => {
    expect(resolveTargetModel(catalog, '')).toEqual({ modelId: 'free', source: 'free' })
  })

  it('reports a saved id that LEFT the catalog as stale, not as preferred', () => {
    const target = resolveTargetModel(catalog, 'model-that-left')
    expect(target.source).toBe('stale')
    expect(target.staleModelId).toBe('model-that-left')
  })

  it('omits modelId for a stale target, so an unguarded caller still fails safe', () => {
    expect(resolveTargetModel(catalog, 'model-that-left').modelId).toBeUndefined()
  })

  it('does NOT silently swap a stale saved id for the free model', () => {
    const target = resolveTargetModel(catalog, 'model-that-left')
    expect(target.modelId).not.toBe('free')
    expect(target.source).not.toBe('free')
  })

  it('reports stale, not none, when the catalog has not loaded yet', () => {
    const target = resolveTargetModel([], 'saved-model')
    expect(target.source).toBe('stale')
  })

  it('still resolves a saved id that IS in the catalog', () => {
    expect(resolveTargetModel(catalog, 'paid')).toEqual({ modelId: 'paid', source: 'preferred' })
  })

  it('distinguishes none from stale when no id is saved', () => {
    expect(resolveTargetModel([model('paid', 1000, 0.79)], undefined).source).toBe('none')
    expect(resolveTargetModel([], undefined).source).toBe('none')
  })
})

describe('exclusionOf', () => {
  it('treats an untested account as a candidate', () => {
    expect(exclusionOf(undefined, NOW)).toBeUndefined()
  })

  it('treats an ok measurement as usable', () => {
    expect(exclusionOf({ outcome: 'ok', atMs: NOW }, NOW)).toBeUndefined()
  })

  it('excludes a rate-limited account before its reset time', () => {
    const probe = { outcome: 'rate-limited' as const, atMs: NOW, retryAtMs: NOW + 60_000 }
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
  })

  it('RETURNS a rate-limited account to the pool after its reset time', () => {
    const probe = { outcome: 'rate-limited' as const, atMs: NOW, retryAtMs: NOW + 60_000 }
    expect(exclusionOf(probe, NOW + 60_001)).toBeUndefined()
  })

  it('excludes an out-of-credit account before its quota refresh', () => {
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: NOW + 3_600_000 }
    expect(exclusionOf(probe, NOW)).toBe('out-of-credit')
  })

  it('returns an out-of-credit account once the quota refreshes', () => {
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: NOW + 3_600_000 }
    expect(exclusionOf(probe, NOW + 3_600_001)).toBeUndefined()
  })

  it('excludes a rejected credential regardless of any cooldown', () => {
    expect(exclusionOf({ outcome: 'credential-rejected', atMs: NOW }, NOW)).toBe('credential-rejected')
    expect(exclusionOf(
      { outcome: 'credential-rejected', atMs: NOW, retryAtMs: NOW - 1 },
      NOW,
    )).toBe('credential-rejected')
  })

  it('excludes an unavailable account until its fallback cooldown elapses', () => {
    // 瞬时故障带未知冷却回退：30 分钟后自愈，而不是永久出池。
    const probe = { outcome: 'unavailable' as const, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('unavailable')
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS - 1)).toBe('unavailable')
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBeUndefined()
  })

  it('gives `failed` the same self-healing cooldown as an unreachable upstream', () => {
    expect(exclusionOf({ outcome: 'failed', atMs: NOW }, NOW)).toBe('failed')
    expect(exclusionOf(
      { outcome: 'failed', atMs: NOW },
      NOW + POOL_UNKNOWN_COOLDOWN_MS,
    )).toBeUndefined()
  })

  it('excludes a limited account for a bounded time when the upstream named none', () => {
    const probe = { outcome: 'rate-limited' as const, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBeUndefined()
  })

  it('honours a stated retry time over the fallback, for a transient outcome too', () => {
    const stated = NOW + 60_000
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW, retryAtMs: stated }, stated - 1))
      .toBe('unavailable')
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW, retryAtMs: stated }, stated))
      .toBeUndefined()
  })

  it('never heals a rejected credential or a missing model on a timer', () => {
    const year = 365 * 24 * 60 * 60_000
    expect(exclusionOf({ outcome: 'credential-rejected', atMs: NOW }, NOW + year))
      .toBe('credential-rejected')
    expect(exclusionOf({ outcome: 'not-found', atMs: NOW }, NOW + year)).toBe('not-found')
  })

  it('treats an unrecognised outcome as unusable rather than as a candidate', () => {
    const probe = { outcome: 'something-new' as never, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('unusable')
  })

  it('keeps an account in the pool after a content-policy refusal', () => {
    // 内容审核拒绝针对一次请求的内容，不是账号本身；把它 bench 掉会闲置一个
    // 健康账号，且它会被 `default` 分支永久标成 `unusable`。
    expect(exclusionOf({ outcome: 'policy-rejected', atMs: NOW }, NOW)).toBeUndefined()
    expect(exclusionOf({ outcome: 'policy-rejected', atMs: NOW }, NOW + 1)).toBeUndefined()
  })
})

describe('rankPool', () => {
  it('ranks by credits, highest first', () => {
    const ranked = rankPool([
      member('low', { credits: 10 }),
      member('high', { credits: 1_000 }),
      member('mid', { credits: 500 }),
    ], NOW)
    expect(ranked.map(row => row.account.id)).toEqual(['high', 'mid', 'low'])
  })

  it('puts usable accounts ahead of every excluded one', () => {
    const ranked = rankPool([
      member('rich-but-limited', {
        credits: 9_999,
        probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
      }),
      member('modest-but-ok', { credits: 1, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('modest-but-ok')
    expect(ranked[0]?.excludedBy).toBeUndefined()
    expect(ranked[1]?.excludedBy).toBe('rate-limited')
  })

  it('prefers the account whose credits expire soonest when totals tie', () => {
    const ranked = rankPool([
      member('late', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 30 * 86_400_000 }),
      member('soon', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('soon')
  })

  it('ranks an account with no expiry after one that expires', () => {
    const ranked = rankPool([
      member('never', { credits: 100 }),
      member('expires', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('expires')
  })

  /**
   * issue #70 —— 上游 4.6.7 的修复，本插件此前**继承了这个缺陷**。
   *
   * 旧排序把「积分总量」放在「临期」之前。总量几乎从不完全相等，于是临期规则
   * 是**数学上不可达**的死代码：一个当天就要作废的账号，只因总量比别的号少
   * 一点，就永远排在最后。报告者病例：账号 C 有 196.4 分当天 17:21 作废。
   */
  it('spends expiring credits FIRST even when another account holds far more (issue #70)', () => {
    const ranked = rankPool([
      member('rich', { credits: 1200 }),
      member('rich2', { credits: 1100 }),
      // 196.4 分当天就要作废 —— 总量最少的号，旧排序里永远排最后。
      member('expiring', { credits: 196.4, expiringSoon: 196.4, nearestExpiryMs: NOW + 3_600_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('expiring')
    // 其余仍按总量：多者优先。
    expect(ranked.map(row => row.account.id)).toEqual(['expiring', 'rich', 'rich2'])
  })

  it('prefers a single at-risk credit over a large non-expiring balance', () => {
    // 最小剂量验证：1 分临期也要压过 5 万分不过期。
    const ranked = rankPool([
      member('big', { credits: 50_000 }),
      member('tiny', { credits: 1, expiringSoon: 1, nearestExpiryMs: NOW + 60_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('tiny')
  })

  it('among accounts at risk, lapses-soonest wins before amount', () => {
    // 两者都有临期：先到期的优先，即使临期量更小 —— 它的时间更少。
    const ranked = rankPool([
      member('bigLater', { credits: 500, expiringSoon: 500, nearestExpiryMs: NOW + 2 * 86_400_000 }),
      member('smallSooner', { credits: 50, expiringSoon: 50, nearestExpiryMs: NOW + 3_600_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('smallSooner')
  })

  it('with the same expiry, the larger amount at risk wins', () => {
    // 同一到期时刻：临期量大者优先（否则小额的先花掉，大额的仍会烂）。
    const expiry = NOW + 86_400_000
    const ranked = rankPool([
      member('small', { credits: 10, expiringSoon: 10, nearestExpiryMs: expiry }),
      member('large', { credits: 900, expiringSoon: 900, nearestExpiryMs: expiry }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('large')
  })

  it('an account whose nearestExpiryMs is set but expiringSoon is 0 is NOT at risk', () => {
    // 这两个字段是**两件事**：过期时刻存在不等于有临期积分（可能已在上个窗口
    // 花光）。若把它们混成一个键，"有临期"就永远为真，规则再次失效。
    const ranked = rankPool([
      member('nothingAtRisk', { credits: 10, nearestExpiryMs: NOW + 3_600_000 }),
      member('nothingAtRiskButMore', { credits: 500 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('nothingAtRiskButMore')
  })

  it('never lets the expiry keys reorder excluded accounts ahead of usable ones', () => {
    // 可用性永远第一：再临期也不能把出池的号抬到可用的号前面。
    const ranked = rankPool([
      member('excludedExpiring', {
        credits: 900,
        expiringSoon: 900,
        nearestExpiryMs: NOW + 60_000,
        probe: { outcome: 'credential-rejected', atMs: NOW },
      }),
      member('usable', { credits: 1 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('usable')
    expect(ranked[1]?.excludedBy).toBeDefined()
  })

  it('ranks unreadable credits as zero, never first', () => {
    const ranked = rankPool([
      member('unknown'),
      member('known-full', { credits: 1 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('known-full')
  })

  it('still returns excluded accounts so the card can explain each one', () => {
    const ranked = rankPool([
      member('bad', { probe: { outcome: 'credential-rejected', atMs: NOW } }),
    ], NOW)
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.excludedBy).toBe('credential-rejected')
  })

  it('is order-independent, breaking a full tie by account id', () => {
    // 所有排名键相等时，没有最后的 id 键则胜负取决于调用方数组顺序，于是两次
    // 相同数据的 run 会旋转出不同赢家。Qoder 版本没有 `tokenExpiresAtMs` 档，
    // 所以全等并列直接落到账号 id。
    const rows = [
      member('a', { credits: 5 }),
      member('b', { credits: 5 }),
    ]
    const forward = rankPool(rows, NOW).map(row => row.account.id)
    const reversed = rankPool([...rows].reverse(), NOW).map(row => row.account.id)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(['a', 'b'])
  })

  it('handles an empty pool', () => {
    expect(rankPool([], NOW)).toEqual([])
  })
})

describe('pickAccount', () => {
  it('picks the highest-credit usable account', () => {
    const picked = pickAccount([
      member('a', { credits: 100, probe: { outcome: 'ok', atMs: NOW } }),
      member('b', { credits: 900, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(picked?.id).toBe('b')
  })

  it('skips an account whose limit has not reset', () => {
    const picked = pickAccount([
      member('limited', {
        credits: 900,
        probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
      }),
      member('ok', { credits: 10, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(picked?.id).toBe('ok')
  })

  it('returns undefined when every account is excluded', () => {
    const picked = pickAccount([
      member('a', { probe: { outcome: 'out-of-credit', atMs: NOW, retryAtMs: NOW + 60_000 } }),
      member('b', { probe: { outcome: 'credential-rejected', atMs: NOW } }),
    ], NOW)
    expect(picked).toBeUndefined()
  })

  it('returns undefined for an empty pool', () => {
    expect(pickAccount([], NOW)).toBeUndefined()
  })

  it('picks an untested account rather than nothing', () => {
    expect(pickAccount([member('fresh', { credits: 5 })], NOW)?.id).toBe('fresh')
  })
})

describe('createLatestWins (race guard for one region\' async work)', () => {
  it('reports the FIRST caller fresh and invalidates it once a newer call begins', () => {
    const guard = createLatestWins<'cn' | 'global'>()
    const first = guard.begin('cn')
    expect(first()).toBe(false)
    const second = guard.begin('cn')
    expect(first()).toBe(true)
    expect(second()).toBe(false)
  })

  it('keeps regions independent, so one region cannot stale another', () => {
    const guard = createLatestWins<'cn' | 'global'>()
    const cn = guard.begin('cn')
    const global = guard.begin('global')
    expect(cn()).toBe(false)
    expect(global()).toBe(false)
    const cn2 = guard.begin('cn')
    expect(cn()).toBe(true)
    expect(global()).toBe(false)
    expect(cn2()).toBe(false)
  })

  it('stays fresh when nothing newer begins', () => {
    const guard = createLatestWins<'cn'>()
    const probe = guard.begin('cn')
    for (let i = 0; i < 5; i += 1) expect(probe()).toBe(false)
  })

  it('invalidates EVERY earlier call, not just the immediately previous one', () => {
    const guard = createLatestWins<'cn'>()
    const first = guard.begin('cn')
    const second = guard.begin('cn')
    const third = guard.begin('cn')
    expect(first()).toBe(true)
    expect(second()).toBe(true)
    expect(third()).toBe(false)
  })

  it('hands out independent probes per call', () => {
    const guard = createLatestWins<'cn'>()
    const a = guard.begin('cn')
    const b = guard.begin('cn')
    expect(a).not.toBe(b)
    expect(a()).toBe(true)
    expect(b()).toBe(false)
  })
})

describe('effectiveMembersOf', () => {
  it('keeps only the ids that resolve to a listed account', () => {
    const listed = new Set(['a', 'b', 'c'])
    expect(effectiveMembersOf(['a', 'x', 'c'], listed)).toEqual(['a', 'c'])
  })

  it('preserves the caller\'s order across a filter, not just in an already-listed set', () => {
    const listedWithoutB = new Set(['a', 'c', 'd'])
    expect(effectiveMembersOf(['d', 'b', 'a', 'c'], listedWithoutB)).toEqual(['d', 'a', 'c'])
    const listed = new Set(['a', 'b', 'c', 'd'])
    expect(effectiveMembersOf(['c', 'b', 'a'], listed)).toEqual(['c', 'b', 'a'])
  })

  it('is empty when nothing resolves, and never mutates its inputs', () => {
    expect(effectiveMembersOf([], new Set(['a']))).toEqual([])
    expect(effectiveMembersOf(['x', 'y'], new Set(['a']))).toEqual([])
    const saved = ['a', 'x']
    const listed = new Set(['a'])
    effectiveMembersOf(saved, listed)
    expect(saved).toEqual(['a', 'x'])
    expect([...listed]).toEqual(['a'])
  })
})