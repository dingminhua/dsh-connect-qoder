/**
 * 一条探针结果的**唯一**渲染规则（文案 + 色调）。
 *
 * 为什么要有这个模块：同一份测量会在两处显示——模型行（`QoderCard`）与账号池
 * 表格（`AccountPool`）。它们此前各写了一套格式化：耗时一处是原始毫秒、另一处
 * 是秒；恢复时刻一处只显示时钟、另一处显示日期+时间。**同一份测量、两个表格、
 * 两种说法**，正是用户学会「两个都别信」的原因。抽到这里之后，两个调用方
 * 保证对同一次测量给出完全一致的说法。
 *
 * 规则（与 workbuddy 的 `probeResultView` 一致）：
 *   - `ok` 显示真实往返耗时（秒，一位小数）；
 *   - 限流 / 额度不足显示上游**明确给出的**恢复时刻（本地化日期+时间），并附
 *     相对时长（由同一个时刻推导，故两者永不矛盾）；
 *   - 上游未给时刻时如实说「上游没给时间」，绝不编造倒计时；
 *   - 其余结论各给一句固定文案，未取到 `status` 的失败只说「失败」。
 *
 * @module dsh-connect-qoder/client/probe-label
 */

import type { QoderWebProbeOutcome, QoderWebProbeResult } from '../status-paths.ts'
import type { Translate } from './locales.ts'
import { remainingText } from './remaining.ts'

/** 账号池表格里的探测形状（没有 `modelId`），与完整结果结构兼容。 */
export type ProbeLike = {
  outcome: QoderWebProbeOutcome
  elapsedMs?: number
  status?: number
  retryAtMs?: number
  message?: string
}

/** 恢复时刻的本地化显示（日期 + 时间，24 小时制）。 */
export function formatProbeMoment(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(atMs))
}

/** 「何时恢复」的相对后缀（` · 约 1 小时后`），无时刻或已过期时为空串。 */
function retrySuffix(t: Translate, untilMs: number | undefined, nowMs: number): string {
  if (untilMs === undefined) return ''
  const remaining = remainingText(t, untilMs, nowMs)
  return remaining === '' ? '' : ` · ${remaining}`
}

/** 一位小数的秒数（`1.5s`）。 */
function secondsOf(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 一条探针结果的文字与色调。两个调用方都必须走这里。 */
export function probeResultView(
  result: ProbeLike,
  t: Translate,
  nowMs: number = Date.now(),
): { text: string, tone: 'ok' | 'warn' | 'bad' } {
  switch (result.outcome) {
    case 'ok':
      return {
        text: result.elapsedMs === undefined ? t('row.probeOk') : t('row.probeOkMs', { ms: secondsOf(result.elapsedMs) }),
        tone: 'ok',
      }
    case 'rate-limited':
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeRateLimitedUnknown')
          : t('row.probeRateLimitedAt', { at: formatProbeMoment(result.retryAtMs) })
            + retrySuffix(t, result.retryAtMs, nowMs),
        tone: 'warn',
      }
    case 'out-of-credit':
      return {
        text: result.retryAtMs === undefined
          ? t('row.probeOutOfCreditUnknown')
          : t('row.probeOutOfCreditAt', { at: formatProbeMoment(result.retryAtMs) })
            + retrySuffix(t, result.retryAtMs, nowMs),
        tone: 'bad',
      }
    case 'credential-rejected': return { text: t('row.probeCredentialRejected'), tone: 'bad' }
    case 'policy-rejected': return { text: t('row.probePolicyRejected'), tone: 'bad' }
    case 'not-found': return { text: t('row.probeNotFound'), tone: 'bad' }
    case 'unavailable': return { text: t('row.probeUnavailable'), tone: 'bad' }
    default:
      return {
        text: result.status === undefined
          ? t('row.probeFailed')
          : t('row.probeFailedStatus', { status: String(result.status) }),
        tone: 'bad',
      }
  }
}

/** 便捷包装：完整结果与池表格形状共用同一条规则。 */
export function probeLabelOf(t: Translate, result: ProbeLike | undefined, nowMs: number = Date.now()): string {
  if (result === undefined) return t('row.poolNeverTested')
  return probeResultView(result, t, nowMs).text
}

/** 类型守卫用的窄化（`QoderWebProbeResult` 可直接传入 {@link ProbeLike}）。 */
export type { QoderWebProbeResult }
