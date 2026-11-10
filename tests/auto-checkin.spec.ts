/**
 * 自动签到的**规则**（issue #36）。
 *
 * 这个文件针对 `src/auto-checkin.ts` —— 一个不持定时器、不读时钟、不写盘的纯
 * 模块。所以这里可以在没有 Host、没有网络、没有假定时器的前提下把每条规则钉住。
 *
 * 移植来源：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 * 的 `tests/auto-checkin.spec.ts`。**改动集中在时间基准那一段**：Qoder 的活动窗
 * 是一个固定的绝对时刻（10:00 UTC+8），不是用户本地零点 —— 照抄 workbuddy 的
 * `localDayKey` 会让新窗口的那一份晚 14 小时才被领。下面第一条用例就是钉这件事。
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_BACKOFF_MS,
  AUTO_CHECKIN_IDLE_MS,
  AUTO_CHECKIN_MIN_IDLE_MS,
  AUTO_CHECKIN_TAIL_MS,
  autoCheckinRegions,
  checkinWindowOf,
  emptyAutoCheckinState,
  foldAttempt,
  idleDelayMs,
  isDue,
  latestRefreshAt,
  nextDelayMs,
  pendingTargets,
  qoderWindowDay,
  stateForWindow,
  summarizeAutoCheckin,
  summaryForWindow,
} from '../src/auto-checkin.ts'
import type { QoderWebPoolCheckinRow } from '../src/status-paths.ts'

function row(
  accountId: string,
  status: QoderWebPoolCheckinRow['status'],
  message?: string,
): QoderWebPoolCheckinRow {
  return {
    accountId,
    accountName: accountId,
    status,
    ...message === undefined ? {} : { message },
  }
}

/**
 * 一窗的开门时刻：2026-11-10 10:00 UTC+8 = 02:00Z。
 *
 * 用真实的绝对时刻而不是本地构造函数：被测的正是「窗口边界是绝对时刻」这件事，
 * 用 `new Date(2026, 10, 10, 10)` 会把它写成本地时间，测试便自己证实不了那个前提。
 */
const OPEN_AT_MS = Date.UTC(2026, 10, 10, 2, 0, 0)
/** 一窗的关门时刻 = 次日 09:59 UTC+8 = 01:59Z。 */
const CLOSE_AT_MS = Date.UTC(2026, 10, 11, 1, 59, 0)

describe('qoderWindowDay：日窗边界是绝对时刻，不是本地零点', () => {
  it('仍在同一窗内的两个时刻给出同一个键（本地零点不是边界）', () => {
    // 10:00 开窗之后的 5 分钟，与本地零点之后 5 分钟（= 23:05 那一窗之后），
    // 属于**同一个** Qoder 窗口。照抄「本地日历日」的写法在这里会给出两个键，
    // 于是 00:05 那一拍会把这一窗记成「已完成」，而 10:00 真正开窗时没人再去领
    // —— 新窗口的那一份要等到第二天 00:05，晚 14 小时。
    expect(qoderWindowDay(OPEN_AT_MS + 5 * 60_000)).toBe('2026-11-10')
    expect(qoderWindowDay(Date.UTC(2026, 10, 10, 16, 5, 0))).toBe('2026-11-10')
  })

  it('10:00 UTC+8 那一刻翻页，之前一秒还不翻', () => {
    expect(qoderWindowDay(OPEN_AT_MS - 1000)).toBe('2026-11-09')
    expect(qoderWindowDay(OPEN_AT_MS)).toBe('2026-11-10')
  })

  it('关门那一刻（次日 09:59）仍属于同一窗', () => {
    expect(qoderWindowDay(CLOSE_AT_MS)).toBe('2026-11-10')
  })

  it('与进程所在时区无关：同一瞬间永远同一个键', () => {
    // 纯算术，所以只要偏移对，任何 host 时区都得到同一个答案。这里顺带钉住
    // 「不能用 toISOString().slice(0,10)」—— 那会把 09:00Z 之前算成前一天，
    // 而 09:00Z = 17:00 UTC+8 明明还在同一窗里。
    const at = Date.UTC(2026, 10, 10, 8, 0, 0)
    expect(qoderWindowDay(at)).toBe('2026-11-10')
  })

  it('补零：一位数的月/日不能产生两种写法', () => {
    // 重置判据是字符串相等，`2026-1-5` 与 `2026-01-05` 是同一天的两种写法。
    expect(qoderWindowDay(Date.UTC(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05')
  })
})

describe('checkinWindowOf：上游时刻优先，没有才退回边界日键', () => {
  it('上游给了未来的关门时刻就用它，且键里带着那个时刻', () => {
    const window = checkinWindowOf(OPEN_AT_MS, CLOSE_AT_MS)
    expect(window).toEqual({ key: `upstream:${CLOSE_AT_MS}`, refreshAtMs: CLOSE_AT_MS })
  })

  it('上游时刻已经过去就不采用，退回边界日键', () => {
    // 落盘的 `windows` 里留着的正是历史值。拿它当「下一窗」会让翻页判定永远
    // 不成立 —— 状态永远不重置、新窗口永远不领。
    // 用「关门后一分钟」（= 次日 10:00 UTC+8，新窗已开）而不是「关门后一毫秒」：
    // 09:59 到 10:00 之间仍是同一窗，一毫秒之后日键根本不该翻页。
    const window = checkinWindowOf(CLOSE_AT_MS + 60_000, CLOSE_AT_MS)
    expect(window.key).toBe('boundary:2026-11-11')
    expect(window.refreshAtMs).toBeUndefined()
  })

  it('没有上游时刻时按边界算，且不带 refreshAtMs', () => {
    expect(checkinWindowOf(OPEN_AT_MS, undefined)).toEqual({ key: 'boundary:2026-11-10' })
  })

  it('两种来源的键一定不同 —— 从一条切到另一条必须重置状态', () => {
    const boundary = checkinWindowOf(OPEN_AT_MS, undefined)
    const upstream = checkinWindowOf(OPEN_AT_MS, CLOSE_AT_MS)
    expect(boundary.key).not.toBe(upstream.key)
  })
})

describe('latestRefreshAt', () => {
  it('取未来时刻里最远的那个（跨成员时保守地晚判翻页）', () => {
    expect(latestRefreshAt([CLOSE_AT_MS, CLOSE_AT_MS + 5000, OPEN_AT_MS], OPEN_AT_MS)).toBe(CLOSE_AT_MS + 5000)
  })

  it('过去的时刻一律丢掉', () => {
    expect(latestRefreshAt([OPEN_AT_MS - 1, CLOSE_AT_MS - 86_400_000], OPEN_AT_MS)).toBeUndefined()
  })

  it('非有限数与 undefined 不会污染结果', () => {
    expect(latestRefreshAt([undefined, Number.NaN, Number.POSITIVE_INFINITY, CLOSE_AT_MS], OPEN_AT_MS)).toBe(CLOSE_AT_MS)
  })

  it('空集合给出 undefined', () => {
    expect(latestRefreshAt([], OPEN_AT_MS)).toBeUndefined()
  })
})

describe('stateForWindow', () => {
  it('同一窗沿用已存的状态', () => {
    const state = foldAttempt(emptyAutoCheckinState('w1'), [row('a', 'claimed')], 1_000)
    expect(stateForWindow(state, { key: 'w1' })).toBe(state)
  })

  it('换窗整份重置（doneAccountIds 与 failures 都归零）', () => {
    const state = { ...foldAttempt(emptyAutoCheckinState('w1'), [row('a', 'claimed'), row('b', 'failed', 'x')], 1_000), failures: 3 }
    const next = stateForWindow(state, { key: 'w2' })
    expect(next).toEqual(emptyAutoCheckinState('w2'))
  })

  it('没有存过任何东西时给出一个空状态', () => {
    expect(stateForWindow(undefined, { key: 'w1' })).toEqual(emptyAutoCheckinState('w1'))
  })
})

describe('foldAttempt', () => {
  it('只把 claimed / already 记为完成，别的都不记', () => {
    const state = foldAttempt(emptyAutoCheckinState('w1'), [
      row('a', 'claimed'),
      row('b', 'already'),
      row('c', 'failed', '上游说不行'),
    ], 1_000)
    expect([...state.doneAccountIds].sort()).toEqual(['a', 'b'])
    expect(state.lastError).toBe('上游说不行')
  })

  it('同一窗内跨尝试累加（一次批量可以中途失败）', () => {
    // 只按这一次的结果重算集合，会让下一拍把已经成功的账号重新签一遍 ——
    // 每个账号每拍一次状态请求，白花。
    const first = foldAttempt(emptyAutoCheckinState('w1'), [row('a', 'claimed'), row('b', 'failed')], 1_000)
    const second = foldAttempt(first, [row('b', 'claimed')], 2_000)
    expect([...second.doneAccountIds].sort()).toEqual(['a', 'b'])
  })

  it('有进展就把失败计数归零（下一次失败该拿最短的退避）', () => {
    const failed = { ...emptyAutoCheckinState('w1'), failures: 4 }
    const progressed = foldAttempt(failed, [row('a', 'claimed')], 1_000)
    expect(progressed.failures).toBe(0)
  })

  it('一次全失败会让计数加一', () => {
    const state = foldAttempt({ ...emptyAutoCheckinState('w1'), failures: 1 }, [row('a', 'failed', 'boom')], 1_000, 3)
    expect(state.failures).toBe(2)
    expect(state.scopeSize).toBe(3)
    expect(state.lastAttemptAtMs).toBe(1_000)
  })

  it('空批次不加失败计数（没有账号可试不是失败）', () => {
    expect(foldAttempt(emptyAutoCheckinState('w1'), [], 1_000).failures).toBe(0)
  })

  it('清掉上一轮留下的 lastError —— 一次干净的成功之后不该还挂着旧原因', () => {
    const dirty = { ...emptyAutoCheckinState('w1'), lastError: '上一次的老错误' }
    expect(foldAttempt(dirty, [row('a', 'already')], 1_000)).not.toHaveProperty('lastError')
  })
})

describe('nextDelayMs / isDue', () => {
  it('没有待办时给 undefined（调用方改挂空闲心跳）', () => {
    expect(nextDelayMs(emptyAutoCheckinState('w1'), 0)).toBeUndefined()
  })

  it('按失败次数逐级放宽，走完落进尾巴', () => {
    for (let failures = 0; failures < AUTO_CHECKIN_BACKOFF_MS.length; failures++) {
      expect(nextDelayMs({ ...emptyAutoCheckinState('w1'), failures }, 1)).toBe(AUTO_CHECKIN_BACKOFF_MS[failures])
    }
    expect(nextDelayMs({ ...emptyAutoCheckinState('w1'), failures: AUTO_CHECKIN_BACKOFF_MS.length }, 1)).toBe(AUTO_CHECKIN_TAIL_MS)
    expect(nextDelayMs({ ...emptyAutoCheckinState('w1'), failures: 99 }, 1)).toBe(AUTO_CHECKIN_TAIL_MS)
  })

  it('第一次尝试永远到点（没有 lastAttemptAtMs）', () => {
    expect(isDue(emptyAutoCheckinState('w1'), 1, 0)).toBe(true)
  })

  it('没有待办时不算到点 —— 否则每一档退避都会醒来确认同一件事', () => {
    expect(isDue({ ...emptyAutoCheckinState('w1'), lastAttemptAtMs: 0 }, 0, 10 * 24 * 3600_000)).toBe(false)
  })

  it('间隔没到就不算到点，到了才算', () => {
    const state = { ...emptyAutoCheckinState('w1'), lastAttemptAtMs: 1_000, failures: 0 }
    expect(isDue(state, 1, 1_000 + AUTO_CHECKIN_BACKOFF_MS[0]! - 1)).toBe(false)
    expect(isDue(state, 1, 1_000 + AUTO_CHECKIN_BACKOFF_MS[0]!)).toBe(true)
  })
})

describe('idleDelayMs', () => {
  it('没有上游时刻时就是那个空闲心跳', () => {
    expect(idleDelayMs({ key: 'boundary:2026-11-10' }, OPEN_AT_MS)).toBe(AUTO_CHECKIN_IDLE_MS)
  })

  it('不晚于日窗开门：窗口 20 分钟后开，就睡 20 分钟', () => {
    const window = { key: 'upstream:x', refreshAtMs: OPEN_AT_MS + 20 * 60_000 }
    expect(idleDelayMs(window, OPEN_AT_MS)).toBe(20 * 60_000)
  })

  it('开门还很远也不睡过头 —— 上限是空闲心跳', () => {
    // 定时器一旦睡 20 小时，中途的时钟跳变 / 机器休眠都会让它错过开门那一刻，
    // 而它自己无从知道。每半小时醒一次的成本是零。
    const window = { key: 'upstream:x', refreshAtMs: OPEN_AT_MS + 20 * 3600_000 }
    expect(idleDelayMs(window, OPEN_AT_MS)).toBe(AUTO_CHECKIN_IDLE_MS)
  })

  it('刚过一点不空转（毫秒级偏差不许立刻醒来）', () => {
    const window = { key: 'upstream:x', refreshAtMs: OPEN_AT_MS + 1 }
    expect(idleDelayMs(window, OPEN_AT_MS)).toBe(AUTO_CHECKIN_MIN_IDLE_MS)
  })
})

describe('summarizeAutoCheckin / summaryForWindow', () => {
  it('done 不会超过分母，pending 不会为负', () => {
    const state = {
      ...emptyAutoCheckinState('w1'),
      scopeSize: 2,
      doneAccountIds: ['a', 'b', 'c'],
    }
    expect(summarizeAutoCheckin(state)).toEqual({ done: 2, total: 2, pending: 0 })
  })

  it('半途给出真实的 done / total / pending', () => {
    const state = { ...emptyAutoCheckinState('w1'), scopeSize: 3, doneAccountIds: ['a'] }
    expect(summarizeAutoCheckin(state)).toEqual({ done: 1, total: 3, pending: 2 })
  })

  it('带出失败原因', () => {
    const state = { ...emptyAutoCheckinState('w1'), scopeSize: 1, lastError: '凭据被拒' }
    expect(summarizeAutoCheckin(state).lastError).toBe('凭据被拒')
  })

  it('不是这一窗的状态 → undefined（卡片据此不渲染状态行）', () => {
    // 这一条是 issue #232 那类谎的 Qoder 版：一个做完的窗在下一拍之前不会被重写，
    // 于是新窗刚开的头几分钟里内存中仍是旧窗的状态。把它当今天汇报，卡片会写
    // 「今日 N 个全部已签」而下表每行都是「未签到」。
    const state = { ...emptyAutoCheckinState('w1'), scopeSize: 2, doneAccountIds: ['a', 'b'] }
    expect(summaryForWindow(state, { key: 'w2' })).toBeUndefined()
    expect(summaryForWindow(state, { key: 'w1' })).toEqual({ done: 2, total: 2, pending: 0 })
  })
})

describe('pendingTargets', () => {
  it('丢掉已完成的，保留顺序', () => {
    const state = { ...emptyAutoCheckinState('w1'), doneAccountIds: ['b'] }
    const targets = [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'c' }]
    expect(pendingTargets(targets, state).map(t => t.accountId)).toEqual(['a', 'c'])
  })

  it('全部完成时是空数组（不是 undefined）', () => {
    const state = { ...emptyAutoCheckinState('w1'), doneAccountIds: ['a'] }
    expect(pendingTargets([{ accountId: 'a' }], state)).toEqual([])
  })
})

describe('autoCheckinRegions', () => {
  it('两个区域都有每日签到', () => {
    // 国际版要本机 UMID 组件的设备风控头，取不到时签到如实报错 —— 那是「这次
    // 失败了、重试阶梯会再试」，不是「这里没有签到」。把它从名单里去掉会让国际版
    // 用户永远得不到后台签到。
    expect([...autoCheckinRegions()].sort()).toEqual(['cn', 'global'])
  })
})
