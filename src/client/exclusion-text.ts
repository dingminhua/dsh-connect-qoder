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
 */
import type { QoderWebPoolExclusion } from '../status-paths.ts'
import type { Translate } from './locales.ts'

/** The exclusion label for one account, or undefined when it is usable. */
export function exclusionText(
  t: Translate,
  excludedBy: QoderWebPoolExclusion | undefined,
): string | undefined {
  switch (excludedBy) {
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedRejected')
    // These four reuse the probe labels, so one measurement yields one
    // consistent story across the name column and the probe column.
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
    case 'unusable': return t('row.poolExcludedUnusable')
    default: return undefined
  }
}