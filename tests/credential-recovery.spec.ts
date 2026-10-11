/**
 * Qoder 恢复建议：createAccountUsabilityProbe / resolveCredentialRecovery。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/credential-recovery.spec.ts` —— 「切到另一个已认证账号」 vs「只能新增
 *   PAT」的区分沿用：只在前者是被验证的修法时点名，只有在没有任何其他可切账号时
 *   才 reloginRequired。Qoder 端口的差异：
 *   - 最便宜的已认证只读探针是 `fetchUsage`（同走 cosy bearer 头），而非签到状态；
 *   - 缓存键是区域 + PAT 派生 id：PAT 换掉 id 就不同，无需额外失效。
 */

import { describe, expect, it } from 'vitest'
import {
  createAccountUsabilityProbe,
  resolveCredentialRecovery,
} from '../src/credential-recovery.ts'
import { qoderAccountId } from '../src/credentials.ts'

const ALPHA = { id: 'pat-a', accountName: 'Alpha' }
const BETA = { id: 'pat-b', accountName: 'Beta' }

/** A store whose credentialFor resolves each account to its own PAT. */
function storeOf(ids: readonly string[], accountNames: Record<string, string> = {}) {
  return {
    accounts: async () => ids.map(id => ({ id, accountName: accountNames[id] ?? id })),
    credentialFor: async (accountId: string) => ids.includes(accountId)
      ? { pat: `pt-${accountId}`, accountName: accountNames[accountId] ?? accountId }
      : undefined,
  }
}

describe('createAccountUsabilityProbe', () => {
  it('reports usable when the usage read answers for that account', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([ALPHA.id, BETA.id]),
      client: { fetchUsage: async () => ({}) } as never,
    })
    expect(await probe('cn', BETA)).toBe(true)
  })

  it('reports unusable when the usage read refuses the credential', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([ALPHA.id, BETA.id]),
      client: { fetchUsage: async () => { throw new Error('401 refused') } } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
  })

  it('reports unusable for an account absent from the store', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([ALPHA.id]),
      client: { fetchUsage: async () => ({}) } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
  })

  it('caches a verdict within its TTL so a polling card does not re-probe', async () => {
    let calls = 0
    let clock = 1_000
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([BETA.id]),
      client: { fetchUsage: async () => { calls += 1; return {} } } as never,
      ttlMs: 60_000,
      now: () => clock,
    })
    expect(await probe('cn', BETA)).toBe(true)
    expect(await probe('cn', BETA)).toBe(true)
    expect(calls).toBe(1)
    clock += 60_001
    await probe('cn', BETA)
    expect(calls).toBe(2)
  })

  it('re-probes after the TTL because the underlying PAT may have changed', async () => {
    // PAT 换掉 → PAT 派生 id 就不同 → 是新的事实，不会被旧拒绝误判。这里断言
    // TTL 内不重探、过期后重新判定，而其 id 派生免去显式失效。
    let usable = false
    let calls = 0
    let clock = 1_000
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([BETA.id]),
      client: { fetchUsage: async () => {
        calls += 1
        if (!usable) throw new Error('401')
        return {}
      } } as never,
      ttlMs: 60_000,
      now: () => clock,
    })
    expect(await probe('cn', BETA)).toBe(false)
    // 用户在别处换了个 PAT（同一账号 id，因为 jsme 用固定 id……这里用新 id 表示换号）。
    usable = true
    clock += 60_001
    expect(await probe('cn', BETA)).toBe(true)
    expect(calls).toBe(2)
  })

  it('keeps verdicts apart per region and per account', async () => {
    const seen: string[] = []
    const probe = createAccountUsabilityProbe({
      store: () => storeOf([ALPHA.id, BETA.id]),
      client: {
        fetchUsage: async (pat: string) => { seen.push(pat); return {} },
      } as never,
    })
    await probe('cn', ALPHA)
    await probe('cn', BETA)
    await probe('global', ALPHA)
    // cn-alpha、cn-beta、global-alpha 三个不同键，各自探一次。
    expect(seen).toEqual([`pt-${ALPHA.id}`, `pt-${BETA.id}`, `pt-${ALPHA.id}`])
  })

  it('survives a throwing credential read by reporting unusable', async () => {
    const probe = createAccountUsabilityProbe({
      store: () => ({ ...storeOf([BETA.id]), credentialFor: async () => { throw new Error('disk') } }),
      client: { fetchUsage: async () => ({}) } as never,
    })
    expect(await probe('cn', BETA)).toBe(false)
  })
})

describe('resolveCredentialRecovery', () => {
  it('demands a re-login (add PAT) only when nothing else exists to switch to', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id]),
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery.reloginRequired).toBe(true)
    expect(recovery.usableAccount).toBeUndefined()
  })

  it('names the verified account when another stored PAT still works', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id, BETA.id], { [BETA.id]: 'Beta' }),
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => account.id === BETA.id,
    })
    expect(recovery.usableAccount).toEqual({ accountId: BETA.id, accountName: 'Beta' })
    expect(recovery.reloginRequired).toBe(false)
  })

  it('never demands a re-login while an unverified alternative exists', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id, BETA.id]),
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery.reloginRequired).toBe(false)
    expect(recovery.usableAccount).toBeUndefined()
  })

  it('never probes the account that was just refused', async () => {
    const probed: string[] = []
    await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id, BETA.id]),
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return false },
    })
    expect(probed).toEqual([BETA.id])
  })

  it('stops probing at the first usable account', async () => {
    const GAMMA = { id: 'pat-c', accountName: 'Gamma' }
    const probed: string[] = []
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id, BETA.id, GAMMA.id]),
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return account.id === BETA.id },
    })
    expect(probed).toEqual([BETA.id])
    expect(recovery.usableAccount?.accountId).toBe(BETA.id)
  })

  it('probes every alternative when none survives, then stays silent about re-login', async () => {
    const GAMMA = { id: 'pat-c', accountName: 'Gamma' }
    const probed: string[] = []
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: storeOf([ALPHA.id, BETA.id, GAMMA.id]),
      rejectedAccountId: ALPHA.id,
      probe: async (_region, account) => { probed.push(account.id); return false },
    })
    expect(probed).toEqual([BETA.id, GAMMA.id])
    expect(recovery.reloginRequired).toBe(false)
  })

  it('survives an unreadable account list without crashing the route', async () => {
    const recovery = await resolveCredentialRecovery({
      region: 'cn',
      store: { ...storeOf([ALPHA.id]), accounts: async () => { throw new Error('scan failed') } } as never,
      rejectedAccountId: ALPHA.id,
      probe: async () => false,
    })
    expect(recovery).toEqual({ reloginRequired: false })
  })
})

// 引用 qoderAccountId 以确保 id 派生参与该模块的契约形状可被编译校验。
export const _contractCheck = qoderAccountId