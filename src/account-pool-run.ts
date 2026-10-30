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
  /** Per-probe hard limit; defaults to `POOL_PROBE_TIMEOUT_MS`. */
  probeTimeoutMs?: number
}

/** Pause between accounts inside one batch. */
export const POOL_BATCH_GAP_MS = 400

/**
 * 单个探针的硬上限。
 *
 * 探针是一次**真实**模型调用（约 25k 输入 token），慢是常态；但「慢」与
 * 「永不返回」在界面上长得一模一样，而整批是串行的 —— 只要有一个账号的请求
 * 挂住，整批就永远出不来，用户看到的是「一键测试卡住」。用户实拍过这一幕。
 *
 * 所以每个探针套一层硬超时：到点按「这次没测出来」落成一行（`unavailable` +
 * 原因），而不是拖住整批。90 秒是一个正常探针的数倍：正常探针几十秒就回来了，
 * 回不来的基本是死链，继续等只是在浪费用户的时间。
 */
export const POOL_PROBE_TIMEOUT_MS = 90_000

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
  return {
    ...base,
    result: await withProbeTimeout(
      deps.probe(credential, modelId),
      modelId,
      deps.probeTimeoutMs ?? POOL_PROBE_TIMEOUT_MS,
    ),
  }
}

/**
 * Race one probe against a hard limit.
 *
 * A timeout is a **row** too — `unavailable` with its own words — never a throw
 * and never an endless wait: the batch is serial, so one request that never
 * comes back would otherwise hold every account behind it, forever.
 *
 * A late rejection after the timeout lands on an already-settled promise and is
 * swallowed here: `then` keeps a handler attached, so it cannot surface as an
 * unhandled rejection.
 */
export function withProbeTimeout(
  probe: Promise<QoderWebProbeResult>,
  modelId: string,
  timeoutMs: number,
): Promise<QoderWebProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<QoderWebProbeResult>(resolve => {
    timer = setTimeout(() => {
      resolve({
        modelId,
        outcome: 'unavailable',
        // 至少说「1s」：测试里把上限压到毫秒级时，也不该出现「超时 0 秒」这种
        // 自己都读不通的句子。
        message: `probe timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`,
      })
    }, timeoutMs)
  })
  return Promise.race([
    // 探针自己抛错也落成一行：`testOne` 的契约是「一个账号失败不中断整批」，
    // 整批又是串行的，一条 throw 出去就会把后面所有账号一起带走。
    probe.catch((error: unknown): QoderWebProbeResult => ({
      modelId,
      outcome: 'unavailable',
      message: messageOf(error),
    })),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
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
      ...row.result.queue === undefined ? {} : { queue: row.result.queue },
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