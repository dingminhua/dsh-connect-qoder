/**
 * How long until a stated recovery time, in the reader's own words.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * The card has always shown the ABSOLUTE instant the upstream named
 * (`05:23:27`). That answers "when", but it forces the reader to subtract it from
 * the clock in their head — the one mental step that makes a cooldown hard to act
 * on. "约 1 小时后" is the answer to "how long do I wait", and it is derived from
 * the SAME instant, so the two can never disagree.
 *
 * Only ever applied to a time the UPSTREAM stated. Inventing a countdown for an
 * outcome that named none is still forbidden; this module adds no new source of
 * truth, it only reformats one that already exists.
 *
 * @module dsh-connect-qoder/client/remaining
 */

import type { Translate } from './locales.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How far out hours stop being the useful unit.
 *
 * Below this, hours; at or above it, days. The cut is at TWO days rather than
 * one so that 30 hours reads as "约 30 小时后" instead of rounding to "约 1 天后",
 * which would understate it by six hours.
 */
const DAYS_AT_MS = 2 * DAY_MS

/**
 * A short "约 N 分钟后 / 约 N 小时后 / 约 N 天后", or `''` once the moment passed.
 *
 * The empty string is the contract callers depend on: an elapsed cooldown means
 * the account is already back, so appending "in 0 minutes" would assert the
 * opposite of the state the card is showing. Callers append this only when it is
 * non-empty.
 */
export function remainingText(t: Translate, untilMs: number, nowMs: number): string {
  const left = untilMs - nowMs
  if (left <= 0) return ''
  if (left < MINUTE_MS) return t('row.remainingImminent')
  if (left < HOUR_MS) return t('row.remainingMinutes', { count: Math.round(left / MINUTE_MS) })
  if (left < DAYS_AT_MS) return t('row.remainingHours', { count: Math.round(left / HOUR_MS) })
  return t('row.remainingDays', { count: Math.round(left / DAY_MS) })
}

/**
 * An exact `HH:MM:SS` countdown to a stated instant, or `''` once it has passed.
 *
 * 与 {@link remainingText} 的分工：那个回答「还要等多久」（约 N 小时后，适合冷却
 * 回池这类不需要盯着看的场景），这个回答「精确到秒」（适合每日签到刷新 —— 用户要
 * 知道自己得等多久才能点下一次，看到「约 1 天后」没有用）。
 *
 * **同样只用于上游给出的时刻**：每日签到的这一窗什么时候开是上游活动行的 `endAt`
 * （实测当天 10:00 → 次日 09:59 UTC+8），这里只换一种写法，不发明新的时间来源。
 * 上游没给（`untilMs === undefined`）就没有倒计时，调用方也不许自己补一个。
 *
 * 秒级向上取整：剩 1 秒时显示 `00:00:01` 而不是 `00:00:00`（后者读起来像「已经到
 * 时间了」，而那一秒其实还在倒计时里）。到点之后一律 `''`。
 */
export function countdownText(untilMs: number | undefined, nowMs: number): string {
  if (untilMs === undefined) return ''
  const left = Math.ceil((untilMs - nowMs) / 1000)
  if (left <= 0) return ''
  const hours = Math.floor(left / 3600)
  const minutes = Math.floor((left % 3600) / 60)
  const seconds = left % 60
  // 小时不封顶：活动窗理论上不会超过一天，但万一上游给了更远的时刻，
  // `101:23:45` 仍然比把它截成 `01:23:45` 诚实（后者会说错刷新时间）。
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}