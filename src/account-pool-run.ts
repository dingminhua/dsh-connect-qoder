/**
 * The pool's batch action: test every account, one at a time.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）的 `src/account-pool-run.ts`。
 * 改动：Qoder 没有 daily check-in，所以本模块只留 `testAllAccounts` 一支，
 *   删掉 `checkinAllAccounts` / `fetchCheckinStatus` / `claimDailyCheckin`
 *   依赖；其余三条规则原样保留 ——
 *
 *   1. **串行，绝不并发。** 上游的限流与体积相关，同时打整池正是把好账号
 *      打成 429 的最快方式。串行 + 账号间小间隔。
 *   2. **一个账号失败不中断整批。** 批量结果**逐个账号**返回。
 *   3. **探不到的账号不污染测量。** `credential-rejected` + 「no stored
 *      credential」是本方的取凭据失败（请求从未发出），`probeUpdatesOf`
 *      丢弃这类行，让该账号保留上次测量。
 *
 * 本模块不持有定时器、不写盘：编排纯依赖注入，可被单测直接驱动。
 *
 * @module dsh-connect-qoder/account-pool-run
 */

import type { QoderPoolProbe } from './account-pool.ts'
import type { QoderWebProbeResult } from './status-paths.ts'

/** One account's test outcome. */
export interface QoderPoolTestRow {
  accountId: string
  accountName: string
  result: QoderWebProbeResult
}

/** One pool member as the batch runner addresses it. */
export interface QoderPoolTarget {
  accountId: string
  accountName: string
}

/** What the batch runner needs from the Host, injected so it stays testable. */
export interface QoderPoolRunnerDeps {
  /**
   * The stored PAT for one account, WITHOUT changing the region's selection.
   * Resolving through `credentialFor` is what lets a batch address every
   * account while the user's chosen account keeps serving traffic.
   */
  credentialFor(accountId: string): Promise<{ pat: string; accountName: string } | undefined>
  /** One real-volume probe of one model through one PAT. */
  probe(
    credential: { pat: string; accountName: string },
    modelId: string,
  ): Promise<QoderWebProbeResult>
  /** Pause between accounts; injected so tests run without real delays. */
  wait?: (ms: number) => Promise<void>
}

/** Pause between accounts inside one batch. */
export const POOL_BATCH_GAP_MS = 400

/**
 * Test every account against one model, one at a time.
 *
 * The model is resolved by the caller (see `resolveTargetModel`) so this
 * function never has to decide "free or not". Never throws: a failed probe is
 * a ROW, not an aborted batch.
 *
 * `onRow` fires the moment one account's row exists, so a caller can report
 * progress instead of waiting for the SLOWEST member.
 */
export async function testAllAccounts(
  targets: readonly QoderPoolTarget[],
  modelId: string,
  deps: QoderPoolRunnerDeps,
  onRow?: (row: QoderPoolTestRow) => void,
): Promise<QoderPoolTestRow[]> {
  const rows: QoderPoolTestRow[] = []
  for (const [index, target] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(POOL_BATCH_GAP_MS)
    const row = await testOne(target, modelId, deps)
    rows.push(row)
    onRow?.(row)
  }
  return rows
}

/**
 * Test ONE account, returning its row.
 *
 * Exported because the card's per-row "测试" button used to call the BATCH
 * runner, so clicking one account's test re-probed the whole pool — a real
 * cost, not just a UI oddity: every member spends a real probe request
 * (~25k input tokens on Qoder's side), and the row you clicked was not
 * necessarily the one that changed anything. A row-level control must touch
 * that row only.
 *
 * Same row contract as the batch (`QoderPoolTestRow`): a failed probe is a
 * ROW, never a throw.
 */
export async function testOne(
  target: QoderPoolTarget,
  modelId: string,
  deps: QoderPoolRunnerDeps,
): Promise<QoderPoolTestRow> {
  const base = { accountId: target.accountId, accountName: target.accountName }
  let credential: { pat: string; accountName: string } | undefined
  try {
    credential = await deps.credentialFor(target.accountId)
  } catch (error: unknown) {
    return {
      ...base,
      result: { modelId, outcome: 'credential-rejected', message: messageOf(error) },
    }
  }
  if (credential === undefined) {
    return {
      ...base,
      result: {
        modelId,
        outcome: 'credential-rejected',
        message: 'no stored credential for this account',
      },
    }
  }
  return { ...base, result: await deps.probe(credential, modelId) }
}

/**
 * Turn a test batch's rows into the per-account measurements to remember.
 *
 * A row that failed because the credential could not even be read says nothing
 * about the model, so it is skipped and the account keeps its previous
 * measurement. `atMs` is stamped once for the batch. `message` is carried
 * through (already redacted by the probe).
 */
export function probeUpdatesOf(
  rows: readonly QoderPoolTestRow[],
): Record<string, QoderPoolProbe> {
  const atMs = Date.now()
  const updates: Record<string, QoderPoolProbe> = {}
  for (const row of rows) {
    if (isTransportFailure(row.result)) continue
    updates[row.accountId] = {
      outcome: row.result.outcome,
      atMs,
      source: 'test-batch',
      ...row.result.retryAtMs === undefined ? {} : { retryAtMs: row.result.retryAtMs },
      ...row.result.message === undefined ? {} : { message: row.result.message },
    }
  }
  return updates
}

/**
 * Whether a probe result measures the transport rather than the model:
 * `credential-rejected` with the pool's own "no stored credential" message is
 * the one case we can attribute to ourselves rather than the upstream.
 */
function isTransportFailure(result: QoderWebProbeResult): boolean {
  return result.outcome === 'credential-rejected'
    && result.message?.startsWith('no stored credential') === true
}

/** The default inter-account pause. */
function defaultWait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A safe message from an unknown throwable, bounded in length. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 300)
}