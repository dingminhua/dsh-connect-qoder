/**
 * One account's "cannot serve right now" reason, as a short localized label.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * Extracted from `AccountPool.tsx` (where the pool table first needed it) so the
 * composer panel's account table states the SAME thing about the SAME account:
 * two tables on one screen giving different names to one measurement is how a
 * user learns to trust neither. This module depends only on the translate
 * function and the exclusion union, so both callers can share it — and it stays
 * testable without a Host.
 *
 * 用户要求（2026-10-18）：「不能用的 红色圆点+原因，原因里不显示绝对时间而
 * 显示解禁时间」。所以上游给过恢复时刻的排除多带一句**相对**的解禁时长
 * （「约 12 分钟后解禁」）——绝对时刻要读者自己拿现在减一下，而「还要等多久」
 * 才是能直接行动的数字。时刻仍来自上游（`retryAtMs`），没给就不编。
 */
import type { QoderWebPoolExclusion } from '../status-paths.ts'
import type { Translate } from './locales.ts'
import { remainingText } from './remaining.ts'

/** The exclusion label for one account, or undefined when it is usable. */
export function exclusionText(
  t: Translate,
  excludedBy: QoderWebPoolExclusion | undefined,
  retryAtMs?: number,
  nowMs: number = Date.now(),
): string | undefined {
  const label = exclusionLabel(t, excludedBy)
  if (label === undefined) return undefined
  // 只有上游明确给了解禁时刻才补时长；凭据被拒这类不会自己好的没有时刻，
  // 也就没有倒计时 —— 绝不拿「30 分钟后」去安慰一个等不会好的状态。
  const remaining = retryAtMs === undefined ? '' : remainingText(t, retryAtMs, nowMs)
  if (remaining === '') return label
  return `${label} · ${t('row.unlockSuffix', { when: remaining })}`
}

/** 排除原因的固定短标签（不含时间）。 */
function exclusionLabel(
  t: Translate,
  excludedBy: QoderWebPoolExclusion | undefined,
): string | undefined {
  switch (excludedBy) {
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedRejected')
    // 排队单独一档（issue #26）：这不是「连不上上游」——上游说了服务是好的，
    // 只是这个模型在排队。「等多久」由外层的解禁时长补上。
    case 'queued': return t('row.poolExcludedQueued')
    // These four reuse the probe labels, so one measurement yields one
    // consistent story across the name column and the probe column.
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
    case 'unusable': return t('row.poolExcludedUnusable')
    default: return undefined
  }
}
