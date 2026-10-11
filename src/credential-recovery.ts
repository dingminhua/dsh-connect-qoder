/**
 * Recovery advice for a credential the upstream has refused.
 *
 * A 401 from the upstream has two very different fixes on this machine, and
 * telling them apart is the whole point of this module:
 *
 *   - the SELECTED account is stale while another stored PAT is healthy →
 *     switching accounts fixes it, and pasting a new PAT changes nothing;
 *   - no stored credential is accepted anymore → adding a fresh PAT is the fix.
 *
 * The probe never changes the selection and never switches on its own: choosing
 * which account gets billed is the user's decision, so this module only answers
 * "would switching help?" and the card offers it.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）的
 *   `src/credential-recovery.ts`。改动：workbuddy 用「签到状态」做最便宜的
 *   已认证只读探针，Qoder 没有签到端点，改用 `fetchUsage`（一条只读用量查询，
 *   走同一套 cosy bearer 头）作为代理；缓存键改为区域 + PAT 派生 id（PAT
 *   没有 lastRefresh/expires 这类可作代际标记的字段，id 本身就是哈希）。
 *
 * @module dsh-connect-qoder/credential-recovery
 */

import type { QoderRegion } from './upstream.ts'
import type { QoderUpstreamClient } from './upstream.ts'

/** What the user can do about a refused credential. */
export interface QoderCredentialRecovery {
  /**
   * Another stored credential answered the upstream during this recovery, so
   * switching to it is a fix that has been verified — not a guess.
   */
  usableAccount?: { accountId: string; accountName: string }
  /**
   * Whether adding a PAT is the only remaining fix: no other stored credential
   * exists at all, so there is nothing to switch to.
   */
  reloginRequired: boolean
}

/** One account as the recovery path needs to see it. */
export interface QoderRecoveryCandidate {
  id: string
  accountName: string
}

/** Reads one account's PAT for probing, without changing the selection. */
export interface QoderProbeStore {
  accounts(): Promise<readonly QoderRecoveryCandidate[]>
  credentialFor(accountId: string): Promise<{ pat: string; accountName: string } | undefined>
}

/** Constructor options for {@link createAccountUsabilityProbe}. */
export interface QoderUsabilityProbeOptions {
  /** The account store for one region (its selection is never touched). */
  store(region: QoderRegion): QoderProbeStore
  /** The upstream client; only its cheap read-only call is used. */
  client: Pick<QoderUpstreamClient, 'fetchUsage'>
  /** How long a probe verdict is reused. */
  ttlMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
}

/** How long a verdict stays fresh by default. */
const DEFAULT_PROBE_TTL_MS = 60_000

/**
 * Cached "is this account still accepted upstream?" probe.
 *
 * The cache key is the region + the account's PAT-derived id. A PAT change
 * means a DIFFERENT id, so a fresh credential is never judged by an old
 * rejection — no explicit invalidation is needed.
 */
export function createAccountUsabilityProbe(
  options: QoderUsabilityProbeOptions,
): (region: QoderRegion, account: QoderRecoveryCandidate) => Promise<boolean> {
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS
  const now = options.now ?? Date.now
  const verdicts = new Map<string, { at: number; usable: boolean }>()

  return async (region, account) => {
    let credential: { pat: string; accountName: string } | undefined
    try {
      credential = await options.store(region).credentialFor(account.id)
    } catch {
      return false
    }
    if (credential === undefined) return false

    const key = `${region}\0${account.id}`
    const cached = verdicts.get(key)
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.usable

    let usable = false
    try {
      // fetchUsage is the cheapest authenticated read that exercises the same
      // cosy bearer header set as the billing APIs, so "it answers" is real
      // evidence about the credential.
      await options.client.fetchUsage(credential.pat)
      usable = true
    } catch {
      usable = false
    }
    verdicts.set(key, { at: now(), usable })
    return usable
  }
}

/**
 * Decide what to tell the user after the upstream refused the selected
 * credential: switch to a verified-usable account, or add a new PAT.
 *
 * `reloginRequired` is set ONLY when there is no other stored credential to
 * switch to. When other accounts exist but none was verified, both fields stay
 * empty and the card says so honestly.
 */
export async function resolveCredentialRecovery(options: {
  region: QoderRegion
  store: QoderProbeStore
  rejectedAccountId?: string
  probe: (region: QoderRegion, account: QoderRecoveryCandidate) => Promise<boolean>
}): Promise<QoderCredentialRecovery> {
  let accounts: readonly QoderRecoveryCandidate[]
  try {
    accounts = await options.store.accounts()
  } catch {
    return { reloginRequired: false }
  }
  const others = accounts.filter(account => account.id !== options.rejectedAccountId)
  if (others.length === 0) {
    return { reloginRequired: true }
  }
  for (const account of others) {
    if (await options.probe(options.region, account)) {
      return {
        usableAccount: { accountId: account.id, accountName: account.accountName },
        reloginRequired: false,
      }
    }
  }
  return { reloginRequired: false }
}