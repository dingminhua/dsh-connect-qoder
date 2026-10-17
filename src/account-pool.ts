/**
 * The account pool: which PAT should be billed, and why.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 *   `src/account-pool.ts` ——「选哪个账号」的打分/排序/挑免费模型规则整体沿用，
 *   含这三条猜不出来、必须显式表达的结论。
 * 改动：
 *   1. 账号是 PAT 而不是桌面端登录：排名成员只有「能解析出 PAT」与「累积了
 *      某次探测」两个信息维度，没有 `tokenExpiresAtMs` 这一档（PAT 通常不过期，
 *      也就没有「更接近过期的凭据先花掉」的决胜项），该档删除；
 *   2. 免费语义落在 `creditMultiplier === 0` **唯一**判据上。Qoder 目录项带
 *      显式 `is_free` 布尔量，但倍数/免费表述在历史存档里未必可靠——因此
 *      Host 在组装成员的模型视图时把 `is_free` 折叠成 `creditMultiplier: 0`，
 *      这里仍按「缺失不等于免费」的老规矩读：上层没有提供倍数就不是免费，
 *      避免把存档里没有倍率的收费模型当成免费反复探测；
 *   3. 每日签到确实存在（Qoder 的 campaigns 端点），但它不是「选谁服务」的排序
 *      输入，所以仍不进本模块：签到在 `index.ts` 的批量动作里执行，这里只译
 *      「探针结果 → 是否出池」的冷却语义；
 *   4. `policy-rejected` 分支保留为一个候选态（同 `ok`）：一次内容审核拒绝是
 *      对单次请求的事实，不是对账号的健康结论。
 *
 * 本模块只做**纯逻辑**，不碰网络、不碰文件系统，以便单测直接钉住规则。
 *
 * @module dsh-connect-qoder/account-pool
 */

import type { QoderWebPoolExclusion } from './status-paths.ts'
import type { QoderWebProbeOutcome } from './status-paths.ts'

/**
 * Which of the pool's writers produced a measurement.
 *
 * `test-batch` — the user pressed "test", so the outcome is a deliberate
 *   measurement of the target model.
 * `live-request` — a real chat request failed and its failure was recorded so
 *   the NEXT request starts from a measurement instead of rediscovering the
 *   same wall.
 */
export type QoderPoolProbeSource = 'test-batch' | 'live-request'

/** One account's pool entry: what the picker needs, plus its last measurement. */
export interface QoderPoolAccount {
  /** Stable account id (the PAT-derived id). */
  id: string
  /** Human name, or `''` when none is known. */
  accountName: string
}

/**
 * What the pool knows about ONE account's last test of the target model.
 *
 * `undefined` means "never tested", deliberately distinct from every measured
 * outcome: an untested account is a candidate (the user may want to use it
 * now) whereas a measured failure is not.
 */
export interface QoderPoolProbe {
  outcome: QoderWebProbeOutcome
  /** When this measurement was taken, in epoch ms. */
  atMs: number
  /**
   * WHAT WROTE THIS MEASUREMENT. Absent for any measurement written before the
   * field existed, so old probe files stay readable — an absent source means
   * "unknown", never a guess.
   */
  source?: QoderPoolProbeSource
  /**
   * When this account may be usable again, when the upstream stated a time.
   * ABSENT when the upstream named no time — never a locally invented one.
   */
  retryAtMs?: number
  /**
   * The upstream's own words on the failure, already redacted by the probe.
   * ABSENT for a success.
   */
  message?: string
}

/** One account's live credit situation, as the pool ranks it. */
export interface QoderPoolCredits {
  total: number
  /** Credits expiring within the card's "soon" window (3 days). */
  expiringSoon: number
  /** When the nearest package expires, if any does. */
  nearestExpiryMs?: number
}

/**
 * Everything the ranking rule reads about one account. Assembled by the Host
 * from the account store, the credits route, and the runtime probe store —
 * this module only consumes it.
 */
export interface QoderPoolMember {
  account: QoderPoolAccount
  credits?: QoderPoolCredits
  probe?: QoderPoolProbe
}

/** Why one account was excluded from being billed. */
export type QoderPoolExclusion = QoderWebPoolExclusion

/** One ranked account: its score, and whether it can serve right now. */
export interface QoderPoolRanked {
  account: QoderPoolAccount
  /** Higher wins. Only comparable between rows of the same ranking call. */
  score: number
  /** Absent when the account is a candidate; set when it is excluded. */
  excludedBy?: QoderPoolExclusion
}

/**
 * How long an account stays out of the pool when the upstream stated no time.
 *
 * A conservative FALLBACK, not a measurement. It keeps a transient failure or
 * an unstated rate limit from idling a healthy account forever, and it is what
 * lets the pool heal itself — nothing else re-probes an excluded member.
 */
export const POOL_UNKNOWN_COOLDOWN_MS = 30 * 60_000

/**
 * Whether one account can be billed at `nowMs`.
 *
 * Returns the exclusion reason, or undefined when the account is a candidate.
 * The order matters and is NOT arbitrary:
 *
 * - A `credential-rejected` / `not-found` account is excluded regardless of any
 *   cooldown: the token is refused / the model is gone, so waiting cannot help
 *   and the user must act.
 * - A limited, unreachable or failed outcome is checked against its stated (or
 *   fallback) cooldown, so an account whose limit has already reset — or whose
 *   gateway blipped once — is back in the pool without another test first.
 * - An `ok` measurement, and no measurement at all, are both candidates.
 *
 * WHY TRANSIENT OUTCOMES GET A COOLDOWN: a transport failure (DNS blip, a 5xx,
 * a cancelled request) says nothing about the ACCOUNT, so excluding it
 * permanently would idle a good account and drain the pool of candidates. The
 * cooldown is what makes the pool RECOVER instead of staying broken.
 */
export function exclusionOf(
  probe: QoderPoolProbe | undefined,
  nowMs: number,
): QoderPoolExclusion | undefined {
  if (probe === undefined) return undefined
  switch (probe.outcome) {
    case 'ok':
      return undefined
    case 'credential-rejected':
      return 'credential-rejected'
    case 'not-found':
      return 'not-found'
    case 'unavailable':
      return retryDue(probe, nowMs) ? undefined : 'unavailable'
    case 'failed':
      return retryDue(probe, nowMs) ? undefined : 'failed'
    case 'rate-limited':
      return retryDue(probe, nowMs) ? undefined : 'rate-limited'
    case 'out-of-credit':
      return retryDue(probe, nowMs) ? undefined : 'out-of-credit'
    case 'policy-rejected':
      // NOT the `default` branch. A content-policy refusal is a fact about ONE
      // request, not about the account: the server refused that message's
      // content, and the same account will happily serve a different one. It is
      // therefore a candidate, exactly like `ok`.
      return undefined
    default:
      // An outcome this build does not know is treated as unusable.
      return 'unusable'
  }
}

/** Whether an account's cooldown has elapsed (or was never stated). */
function retryDue(probe: QoderPoolProbe, nowMs: number): boolean {
  const until = probe.retryAtMs ?? probe.atMs + POOL_UNKNOWN_COOLDOWN_MS
  return nowMs >= until
}

/**
 * Rank a pool's members best-first.
 *
 * The rule, in priority order — this is the whole feature:
 *
 * 1. **Usability.** Only accounts that can be billed right now are candidates.
 * 2. **Has credits about to lapse.** An account with any points expiring inside
 *    the "soon" window is spent FIRST. Points are worth zero the moment they
 *    expire, so an account carrying them is strictly worth more than one that
 *    merely holds a larger pile that does not lapse.
 * 3. **Lapses soonest first.** Among accounts at risk, the one whose nearest
 *    expiry comes up first goes first — it has the least time to be spent.
 * 4. **Largest amount at risk.** Same expiry (or neither at risk): the bigger
 *    amount wins; with nothing expiring this falls through to total credits.
 * 5. **Credits, highest first.** Spend the account that has the most.
 * 6. **Account id.** Final tie-break, making the order TOTAL.
 *
 * ⚠️ **Steps 2–4 used to be a dead branch** (upstream issue #70, fixed in the
 * sibling plugin's 4.6.7 and inherited here). The old order put `score`
 * (total credits) BEFORE the expiry key. Totals are almost never exactly equal,
 * so the expiry rule was UNREACHABLE — mathematics, not luck: an account whose
 * 196 expiring points lapse today would sit last forever behind accounts
 * holding ~1200 non-expiring ones. Worse, the single `_expiring` key held the
 * raw `nearestExpiryMs` timestamp and `expiringSoon` (the AMOUNT) was never
 * consulted at all, so "largest amount at risk" could not even be expressed.
 * The three keys are separate now precisely so this cannot silently regress:
 * `_atRisk` (bool), `_expiring` (when), `_expiringAmount` (how much).
 *
 * Excluded accounts are still RETURNED (sorted after the candidates) so the
 * card can explain why each is out.
 *
 * Pure and total: the same input always yields the same order, and it never
 * throws on missing data (an account with no credits is ranked as 0).
 */
export function rankPool(
  members: readonly QoderPoolMember[],
  nowMs: number,
): QoderPoolRanked[] {
  const rows = members.map(member => {
    const excludedBy = exclusionOf(member.probe, nowMs)
    return {
      account: member.account,
      score: scoreOf(member),
      ...excludedBy === undefined ? {} : { excludedBy },
      _usable: excludedBy === undefined,
      // Three SEPARATE keys on purpose: "has something at risk" (bool), "when it
      // lapses" (timestamp) and "how much is at risk" (amount). The old single
      // key conflated them, which is how the amount became unconsultable.
      _atRisk: (member.credits?.expiringSoon ?? 0) > 0,
      _expiringAmount: member.credits?.expiringSoon ?? 0,
      _expiring: member.credits?.nearestExpiryMs ?? Number.POSITIVE_INFINITY,
    }
  })
  rows.sort((left, right) => {
    if (left._usable !== right._usable) return left._usable ? -1 : 1
    // Expiring credits before anything else among usable accounts (issue #70).
    if (left._atRisk !== right._atRisk) return left._atRisk ? -1 : 1
    // Both at risk: whichever lapses FIRST goes first.
    if (left._atRisk && right._atRisk && left._expiring !== right._expiring) {
      return left._expiring - right._expiring
    }
    // Same expiry (or neither at risk): the larger amount at stake wins, which
    // for accounts with nothing expiring falls through to total credits.
    if (left._expiringAmount !== right._expiringAmount) {
      return right._expiringAmount - left._expiringAmount
    }
    if (left.score !== right.score) return right.score - left.score
    // Final key: the account id. Without it, two accounts identical on every
    // ranking key would keep whatever order the caller happened to pass, so
    // the same pool could rotate differently between runs — an instability
    // that makes the feature hard to reason about and impossible to test.
    // Ids are unique, so this makes the order TOTAL.
    return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0
  })
  return rows.map(({ account, score, excludedBy }) => ({
    account,
    score,
    ...excludedBy === undefined ? {} : { excludedBy },
  }))
}

/**
 * The checked ids that still resolve to a stored credential, in the caller's
 * order. Pure and never mutates its input.
 */
export function effectiveMembersOf(
  orderedIds: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return orderedIds.filter(id => listedIds.has(id))
}

/**
 * The account to bill, or undefined when the pool has no usable member.
 */
export function pickAccount(
  members: readonly QoderPoolMember[],
  nowMs: number,
): QoderPoolAccount | undefined {
  return rankPool(members, nowMs).find(row => row.excludedBy === undefined)?.account
}

/** The credit figure used for ordering. Absent credits rank as zero. */
function scoreOf(member: QoderPoolMember): number {
  return member.credits?.total ?? 0
}

/**
 * One model as the pool's target picker sees it — the projection the Host
 * assembles (id = catalog key, creditMultiplier folded from is_free).
 */
export interface QoderPoolModel {
  id: string
  name: string
  /** Present ONLY when the Host states a multiplier (folded from is_free). */
  creditMultiplier?: number
  /** Model context window, used to prefer the biggest free model. */
  contextWindow: number
}

/** The resolved target model, and where the choice came from. */
export interface QoderPoolTarget {
  /**
   * The model a batch may test, present ONLY when it is safe to run.
   * Deliberately ABSENT for `stale`.
   */
  modelId?: string
  /** The saved id that could not be resolved; present only for `stale`. */
  staleModelId?: string
  source: 'preferred' | 'free' | 'none' | 'stale'
}

/**
 * Resolve the model the pool should test against.
 *
 * A user-specified id always wins (it is a preference, not a computed default),
 * and is returned even when it is a PAID model: the card says so explicitly.
 * The choice is VALIDATED against the region's catalog: a saved id no longer
 * offered is reported as `stale` — never silently replaced by the free model —
 * and a catalog that has not loaded yet reads as `stale` too (the safe
 * direction: no credits are spent while the roster is unknown).
 */
export function resolveTargetModel(
  catalog: readonly QoderPoolModel[],
  preferredId: string | undefined,
): QoderPoolTarget {
  if (preferredId !== undefined && preferredId !== '') {
    return catalog.some(model => model.id === preferredId)
      ? { modelId: preferredId, source: 'preferred' }
      : { staleModelId: preferredId, source: 'stale' }
  }
  const free = pickFreeModel(catalog)
  return free === undefined ? { source: 'none' } : { modelId: free.id, source: 'free' }
}

/**
 * Pick the free model to test against, from one region's projected catalog.
 *
 * "Free" means `creditMultiplier === 0` EXACTLY. An absent multiplier is NOT
 * free — the Host only folds `is_free` to 0 when it positively knows the model
 * is free, so an absent multiplier stays a non-free (unknown) model rather than
 * silently billing real credits on a probe. Among the free candidates the
 * LARGEST context window wins, because the probe sends a real-sized payload.
 *
 * Returns undefined when there is no free model, which the caller must render
 * as "none available" — never as a fallback to a paid model.
 */
export function pickFreeModel(
  catalog: readonly QoderPoolModel[],
): QoderPoolModel | undefined {
  let best: QoderPoolModel | undefined
  for (const model of catalog) {
    if (model.creditMultiplier !== 0) continue
    if (best === undefined || model.contextWindow > best.contextWindow) best = model
  }
  return best
}

/**
 * A latest-wins guard for one region's asynchronous work.
 *
 * `begin()` claims a new generation and returns a probe; the caller must check
 * it after EVERY await and bail when it reports stale. Extracted as a pure
 * factory so the rule is unit-testable.
 */
export function createLatestWins<Key extends string>(): {
  begin(key: Key): () => boolean
} {
  const generations: Partial<Record<Key, number>> = {}
  return {
    begin(key: Key): () => boolean {
      const generation = (generations[key] ?? 0) + 1
      generations[key] = generation
      return () => generations[key] !== generation
    },
  }
}