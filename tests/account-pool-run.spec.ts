/**
 * Qoder 账号池批量动作：testAllAccounts / probeUpdatesOf。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/account-pool-run.spec.ts` —— 串行不并发、逐账号失败不中断整批、批量
 *   结果带来源标记 / 单次时间戳、探不到的账号不污染测量这些规则沿用。Qoder
 *   没有 daily check-in，所以只有 testAllAccounts 一支，没有 checkinAllAccounts。
 *
 * 断言重点：testAllAccounts 的行/进度回调/账号间间隔/多账号并行上限为 1/永不
 * 抛出；probeUpdatesOf 把「no stored credential」的传输级失败整行丢弃，令该
 * 账号保留上次测量。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  POOL_BATCH_GAP_MS,
  probeUpdatesOf,
  testAllAccounts,
} from '../src/account-pool-run.ts'
import type { QoderPoolRunnerDeps, QoderPoolTestRow } from '../src/account-pool-run.ts'
import type { QoderWebProbeResult } from '../src/status-paths.ts'

const TARGETS: readonly { accountId: string, accountName: string }[] = [
  { accountId: 'a', accountName: 'Alpha' },
  { accountId: 'b', accountName: 'Beta' },
  { accountId: 'c', accountName: 'Gamma' },
]

/** Credentials by account id; a missing entry simulates an unreachable store. */
function credentialsFor(ids: readonly string[]): QoderPoolRunnerDeps['credentialFor'] {
  return async (accountId: string) => ids.includes(accountId) ? { pat: `pt-${accountId}`, accountName: accountId } : undefined
}

/** A runner double with no real delays and per-account scripted answers. */
function runner(
  overrides: Partial<QoderPoolRunnerDeps> = {},
): QoderPoolRunnerDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    credentialFor: overrides.credentialFor ?? credentialsFor(['a', 'b', 'c']),
    probe: overrides.probe ?? (async (cred: { pat: string }, modelId: string) => {
      calls.push(`probe:${cred.pat}:${modelId}`)
      return { modelId, outcome: 'ok', status: 200 } as QoderWebProbeResult
    }),
    wait: overrides.wait ?? (async () => {}),
    // 其余可注入项（如 `probeTimeoutMs`）原样透传：测试要把探针上限压到毫秒级，
    // 不能因为这里只抄了三个字段就静默退回 90 秒的默认值。
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) =>
      key !== 'credentialFor' && key !== 'probe' && key !== 'wait')),
  }
}

describe('testAllAccounts', () => {
  it('probes every account against the given model', async () => {
    const deps = runner()
    const rows = await testAllAccounts(TARGETS, 'qmodel', deps)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.result.outcome === 'ok')).toBe(true)
    expect(deps.calls).toEqual([
      'probe:pt-a:qmodel',
      'probe:pt-b:qmodel',
      'probe:pt-c:qmodel',
    ])
  })

  it('keeps one account failure from aborting the batch', async () => {
    const deps = runner({ credentialFor: credentialsFor(['a', 'c']) })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows.map(row => row.result.outcome)).toEqual(['ok', 'credential-rejected', 'ok'])
    expect(deps.calls).toContain('probe:pt-c:m')
  })

  it('records a per-account probe outcome without collapsing the batch', async () => {
    const deps = runner({
      probe: async (cred, modelId) => cred.pat === 'pt-b'
        ? { modelId, outcome: 'rate-limited', retryAtMs: Date.now() + 60_000 }
        : { modelId, outcome: 'ok' },
    })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows.map(row => row.result.outcome)).toEqual(['ok', 'rate-limited', 'ok'])
  })

  it('never throws when the credential store itself throws', async () => {
    const deps = runner({ credentialFor: async () => { throw new Error('store exploded') } })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.result.outcome === 'credential-rejected')).toBe(true)
    expect(rows[0]?.result.message).toBe('store exploded')
  })

  it('runs strictly serially, never exceeding one in-flight probe', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = runner({
      probe: async (cred, modelId) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 1))
        inFlight -= 1
        return { modelId, outcome: 'ok' }
      },
    })
    await testAllAccounts(TARGETS, 'm', deps)
    expect(maxInFlight).toBe(1)
  })

  it('fires onRow as each row is produced, so progress is reported incrementally', async () => {
    const seen: string[] = []
    await testAllAccounts(
      TARGETS,
      'm',
      runner({ probe: async () => ({ modelId: 'm', outcome: 'ok' }) }),
      row => { seen.push(row.accountId) },
    )
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('hands an endless probe a row instead of stalling the batch', async () => {
    // 探针挂住时整批就是「一键测试卡住」（用户实拍）：串行 runner 会一直等第一
    // 个账号，后面每个都轮不到，界面永远出不来结果。每个探针必须有自己的上限，
    // 到点落成一行，批次继续往下走。
    const deps = runner({ probe: () => new Promise<QoderWebProbeResult>(() => {}), probeTimeoutMs: 20 })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.result.outcome === 'unavailable')).toBe(true)
    expect(rows[0]?.result.message).toBe('probe timed out after 1s')
  })

  it('turns a throwing probe into a row too', async () => {
    // 契约是「一个账号失败不中断整批」；探针自己 throw 也得落成一行，否则串行
    // 批次的第一个异常就会把后面所有账号一起带走。
    const deps = runner({
      probe: async () => { throw new Error('socket hang up') },
    })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows.map(row => row.result.outcome)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(rows[0]?.result.message).toBe('socket hang up')
  })

  it('pauses between accounts but not before the first', async () => {
    const waits: number[] = []
    const deps = runner({ wait: async (ms) => { waits.push(ms) } })
    await testAllAccounts(TARGETS, 'm', deps)
    expect(waits).toEqual([POOL_BATCH_GAP_MS, POOL_BATCH_GAP_MS])
  })

  it('handles an empty pool without probing anything', async () => {
    const probe = vi.fn()
    expect(await testAllAccounts([], 'm', runner({ probe }))).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('probeUpdatesOf', () => {
  const row = (accountId: string, result: QoderWebProbeResult): QoderPoolTestRow =>
    ({ accountId, accountName: accountId, result })

  it('labels every measured row as a test batch', () => {
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'ok' }),
      row('beta', { modelId: 'm', outcome: 'rate-limited', retryAtMs: 123 }),
    ])
    expect(updates['alpha']?.source).toBe('test-batch')
    expect(updates['beta']?.source).toBe('test-batch')
  })

  it('carries outcome, retry time and message through unchanged', () => {
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'rate-limited', retryAtMs: 456, message: 'code 6004' }),
    ])
    expect(updates['alpha']).toMatchObject({
      outcome: 'rate-limited',
      retryAtMs: 456,
      message: 'code 6004',
      source: 'test-batch',
    })
  })

  it('omits a transport failure (`no stored credential`) entirely rather than labelling it', () => {
    // 探不到账号的失败对本方取凭据失败，请求从未发出，说明不了模型；把它记下来
    // 会污染该账号的测量。整行丢弃，让账号保留上次测量。
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'credential-rejected', message: 'no stored credential for this account' }),
      row('beta', { modelId: 'm', outcome: 'ok' }),
    ])
    expect(updates['alpha']).toBeUndefined()
    expect(updates['beta']?.source).toBe('test-batch')
  })

  it('does NOT drop a real credential-rejection that reached the upstream', () => {
    // 只有 `no stored credential`（请求从未发出）是传输级失败；上游真的拒了这个
    // PAT，则测量必须保留（这是关于账号的事实）。
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'credential-rejected', message: '401 invalid token' }),
    ])
    expect(updates['alpha']?.outcome).toBe('credential-rejected')
  })

  it('stamps one time for the whole batch', () => {
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'ok' }),
      row('beta', { modelId: 'm', outcome: 'ok' }),
    ])
    expect(updates['alpha']?.atMs).toBe(updates['beta']?.atMs)
  })
})