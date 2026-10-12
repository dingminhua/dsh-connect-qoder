/**
 * 每日签到的「下一窗倒计时」。
 *
 * 关键事实（实测只读拉取 cn 的 campaigns 原文）：每日活动窗是
 * `startAt` 当天 10:00:00 → `endAt` 次日 09:59:00（UTC+8），与官方活动文案
 * 「每日 10:00（UTC+8）刷新」一致。用户实拍里页面上那个 `09:22:23`
 * 就是 `endAt − 当前时间`。
 *
 * 两条不能破的规则：
 * 1. 倒计时只来自上游的 `endAt`，**绝不**用本地零点或「上次 +24h」编一个；
 * 2. 「已领取」**不是**「今天到此为止」——所以这一格必须同时给出还剩多久。
 */
import { describe, expect, it } from 'vitest'
import { countdownText, remainingText } from '../src/client/remaining.ts'

const t: any = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')

// 实测值：endAt = 1791856740（秒）→ 1791856740000 ms
const END_AT_MS = 1791856740 * 1000

describe('countdownText（每日签到下一窗）', () => {
  it('renders the upstream countdown as HH:MM:SS', () => {
    // 用户实拍里的形状：距刷新 9 小时 22 分 23 秒。
    const now = END_AT_MS - ((9 * 3600 + 22 * 60 + 23) * 1000)
    expect(countdownText(END_AT_MS, now)).toBe('09:22:23')
  })

  it('pads every field and does not cap the hours', () => {
    expect(countdownText(END_AT_MS, END_AT_MS - (1000))).toBe('00:00:01')
    expect(countdownText(END_AT_MS, END_AT_MS - (61 * 1000))).toBe('00:01:01')
    expect(countdownText(END_AT_MS, END_AT_MS - ((101 * 3600 + 23 * 60 + 45) * 1000))).toBe('101:23:45')
  })

  it('rounds UP, so the last second reads 00:00:01 rather than 00:00:00', () => {
    // 剩 1.2 秒时向上取整为 2 秒：`00:00:00` 读起来像「已经到刷新点了」，
    // 而那一秒其实还在倒计时里。
    expect(countdownText(END_AT_MS, END_AT_MS - 1200)).toBe('00:00:02')
  })

  it('is empty once the window has arrived — 「可以领了」与「没有倒计时」是两件事', () => {
    expect(countdownText(END_AT_MS, END_AT_MS)).toBe('')
    expect(countdownText(END_AT_MS, END_AT_MS + 5000)).toBe('')
  })

  it('is empty when the upstream stated no time — 绝不编一个本地猜测', () => {
    expect(countdownText(undefined, Date.now())).toBe('')
  })

  it('ticks as the clock moves, without ever going backwards', () => {
    const start = END_AT_MS - (2 * 3600 * 1000)
    const seen: string[] = []
    for (let i = 0; i < 4; i++) seen.push(countdownText(END_AT_MS, start + i * 1000))
    expect(seen).toEqual(['02:00:00', '01:59:59', '01:59:58', '01:59:57'])
  })

  it('stays distinct from the coarse remainingText (minutes, for cooldowns)', () => {
    const now = END_AT_MS - (3 * 3600 * 1000)
    // remainingText 回答「还要等多久」（冷却回池用），countdownText 回答精确时刻。
    expect(remainingText(t, END_AT_MS, now)).toBe('row.remainingHours|count=3')
    expect(countdownText(END_AT_MS, now)).toBe('03:00:00')
  })
})
