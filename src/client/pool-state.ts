/**
 * Pure decision helpers for the account pool's card section.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * 本模块不 import React、不碰网络，纯函数、全函数，规则本身可被单测直接钉住。
 *
 * 改动（按 Qoder 现实）：
 *   1. 池的批量动作只有 test / remove，没有 checkin——`poolErrNoCheckin` 键保留
 *      以维持家族形状，但 host 永远不会给 checkin-unsupported 的 reason；
 *   2. `poolFailureText` / `poolErrorText` 沿用，供池路由失败时给出结构化文案。
 *
 * @module dsh-connect-qoder/client/pool-state
 */

import { effectiveMembersOf } from '../account-pool.ts'
import type { Translate } from './locales.ts'

/** The preference fields the pool section edits. */
export interface PoolPreferencesLike {
  enabled: boolean
  targetModelId: string
  /** Tokens each test probe sends, or `undefined`/`0` for the host's default. */
  probeInputTokens?: number
  memberAccountIds: readonly string[]
}

/**
 * The base a draft edit starts from.
 *
 * Resolved at EDIT time rather than captured when the callback was built.
 */
export function draftBaseFor<T extends PoolPreferencesLike>(
  previous: T | null,
  previousRegion: string | undefined,
  region: string,
  saved: T,
): T {
  return previous !== null && previousRegion === region ? previous : saved
}

/**
 * Membership that resolves to a real credential — what a batch runs on.
 *
 * The HOST computes this and sends it; this helper only chooses which answer to
 * trust. While the draft is CLEAN the Host's answer is authoritative; while it
 * is DIRTY it must be derived from the edited list.
 */
export function effectiveMemberIds(input: {
  savedEffective: readonly string[]
  draftMembers: readonly string[]
  listedIds: ReadonlySet<string>
  dirty: boolean
}): string[] {
  if (!input.dirty) return [...input.savedEffective]
  // The dirty branch is the shared rule, not a fourth copy of it.
  return effectiveMembersOf(input.draftMembers, input.listedIds)
}

/**
 * How many accounts a batch will really touch, as the log announces it.
 */
export function announcedBatchCount(input: {
  savedEffective: readonly string[] | undefined
  savedMembers: readonly string[]
}): number {
  return (input.savedEffective ?? input.savedMembers).length
}

/**
 * Localize a pool route failure from its structured cause.
 */
export function poolErrorText(
  t: Translate,
  reason: string | undefined,
  detail?: string,
): string | undefined {
  switch (reason) {
    case 'no-members': return t('row.poolErrNoMembers')
    case 'no-live-members': return t('row.poolErrNoLiveMembers')
    case 'no-free-model': return t('row.poolErrNoFreeModel')
    case 'target-model-stale': return t('row.poolErrStaleModel')
    case 'checkin-unsupported': return t('row.poolErrNoCheckin')
    case 'account-not-deletable': return t('row.poolErrNotDeletable')
    case 'pool-unavailable': return t('row.poolErrUnavailable')
    case 'pool-failed': return t('row.poolErrFailed', { message: detail ?? '' })
    default: return undefined
  }
}

/**
 * The message to show for a failed pool request, from every signal available.
 *
 * 移植自 dsh-connect-workbuddy（issue #86）：status tier 在响应体根本不是 JSON
 * 时再分流一次。每条池路由的 handler 都用 JSON 作答（含自身的 405
 * `{error:'method not allowed'}`），所以一个 body 为空或不可解析的 405 不是本插件
 * 拒绝该方法，而是宿主 HTTP 层在为一个从未注册的路由作答——即宿主进程还在跑更旧的
 * 构建。这种情形下应提示「重启应用」而非「升级插件」，后者正是被 #86 修正的误导文案。
 */
export interface PoolFailureInput {
  status: number
  reason?: string | undefined
  error?: string | undefined
  /**
   * 响应体根本不是 JSON（无法解析）。每条路由都以 JSON 作答，含自身的 405，
   * 所以一个不可解析的 405 来自宿主而非插件。
   */
  bodyUnreadable?: boolean
}

export function poolFailureText(
  t: Translate,
  input: PoolFailureInput,
): string {
  return poolErrorText(t, input.reason, input.error)
    ?? input.error
    ?? (input.bodyUnreadable === true && input.status === 405
      ? t('row.poolErrRouteMissing')
      : t('row.poolErrHttp', { status: String(input.status) }))
}

/**
 * Pool MEMBERS that can serve right now.
 */
export function usableMemberIds<T extends { accountId: string, excludedBy?: string }>(
  accounts: readonly T[],
  effectiveMembers: readonly string[],
  draftMembers: readonly string[],
): string[] {
  const wanted = new Set([...effectiveMembers, ...draftMembers])
  return accounts
    .filter(account => wanted.has(account.accountId) && account.excludedBy === undefined)
    .map(account => account.accountId)
}