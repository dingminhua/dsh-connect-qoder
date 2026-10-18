/**
 * 账号状态点的颜色语义（两个表格共用的那份判定）。
 *
 * 钉住的是用户的最终口径（2026-10-18）：
 *
 *   1. 「能用的 绿色圆点」——没被排除就是绿，不再分「测过/没测过」；
 *   2. 「不能用的 红色圆点+原因」——被排除一律红，包括会自己好的限流
 *      （「还能等多久」交给原因里的解禁时长，不靠琥珀色再表达一层含义）；
 *   3. 「当前选择的，绿色圆点加第二行提示当前选用」——「在用」不再改颜色：
 *      能用本来就绿；不能用（池关时额度用尽的选中号仍算 current）必须保持红，
 *      不能复活「当前使用 + 用量已达上限」顶着绿点的老矛盾。
 */
import { describe, expect, it } from 'vitest'
import {
  accountDotTone,
  accountStateColor,
  accountStateTone,
} from '../src/client/account-state.ts'

describe('accountStateTone：能不能用，只有两色', () => {
  it('没被排除 → 绿（不管测没测过）', () => {
    expect(accountStateTone({})).toBe('ok')
    expect(accountStateTone({ probeOutcome: 'ok' })).toBe('ok')
  })

  it('被排除 → 红；会自己好的（限流/上游暂不可用）也是红', () => {
    expect(accountStateTone({ excludedBy: 'rate-limited' })).toBe('bad')
    expect(accountStateTone({ excludedBy: 'unavailable' })).toBe('bad')
    expect(accountStateTone({ excludedBy: 'credential-rejected' })).toBe('bad')
    expect(accountStateTone({ excludedBy: 'out-of-credit' })).toBe('bad')
  })

  it('排除优先于探针：excludedBy 在场时不管 probe 说什么', () => {
    expect(accountStateTone({ excludedBy: 'out-of-credit', probeOutcome: 'ok' })).toBe('bad')
  })
})

describe('accountDotTone：「在用」不再改颜色', () => {
  it('在用且能用 → 绿（本来也是绿）', () => {
    expect(accountDotTone({ current: true })).toBe('ok')
    expect(accountDotTone({ current: true, probeOutcome: 'ok' })).toBe('ok')
  })

  it('在用但不能用 → 保持红，不因「在用」复活绿点', () => {
    // 池关时第一发号额度用尽仍算 current；「当前使用 + 用量已达上限」顶着
    // 绿点正是第一轮用户实拍的自相矛盾。
    expect(accountDotTone({ current: true, excludedBy: 'out-of-credit' })).toBe('bad')
    expect(accountDotTone({ current: true, excludedBy: 'rate-limited' })).toBe('bad')
  })

  it('不在用的号：颜色只由能不能用决定', () => {
    expect(accountDotTone({ current: false })).toBe('ok')
    expect(accountDotTone({ current: false, probeOutcome: 'ok' })).toBe('ok')
    expect(accountDotTone({ current: false, excludedBy: 'credential-rejected' })).toBe('bad')
  })
})

describe('accountStateColor：两档在用色 + 保留其余语义', () => {
  it('ok=绿 bad=红（带主题令牌回落）', () => {
    expect(accountStateColor('ok')).toBe('var(--dsw-alias-state-success-primary, #22a06b)')
    expect(accountStateColor('bad')).toBe('var(--dsw-alias-state-error-primary, #ef4444)')
  })

  it('warn/unknown 仍在词表里（其它消费者可用），只是判定不再产出它们', () => {
    expect(accountStateColor('warn')).toBe('var(--dsw-alias-state-warn-primary, #f59e0b)')
    expect(accountStateColor('unknown')).toBe('var(--dsw-alias-label-dimmed, #9aa0a6)')
  })
})
