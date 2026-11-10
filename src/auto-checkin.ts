/**
 * 每日签到，由插件在后台执行，而不是等用户点按钮（issue #36）。
 *
 * ## 为什么会有这个文件，而这个插件在此前明确「不提供自动签到」
 *
 * README 与 CHANGELOG 都写过「不提供自动签到：签到会真实领取奖励，只在你点按钮
 * 时执行」。那条理由本身是对的 —— 领取是用户账号上的一笔真实写入，插件不该替
 * 他决定。所以这里的东西是一个**默认关闭的开关**：用户不勾，一行代码都不会跑。
 *
 * 改变的是另一头的代价。Qoder 的每日积分窗是 10:00（UTC+8）开、次日 09:59 关，
 * 一整天没领就白丢一份（个人用户 100 Credits、30 天有效）；而签到本身是
 * **幂等**的、不消耗任何积分。于是诚实的说法不是「插件该不该做这件事」，而是
 * 「用户可以决定一次，让它自己做」—— 开关就是他做这个决定的地方。
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 * `src/auto-checkin.ts`；本文件沿用它的四条安全性质，第 2 条（时间基准）按
 * Qoder 的现实**重写**，理由见 {@link qoderWindowDay}。
 *
 * ## 四条让它安全的前提
 *
 * 1. **构造上幂等。** 它调的是手动按钮调的**同一个** `claimDailyCredits`：先拉
 *    活动列表看 `claimStatus`，已经是 `CLAIMED` 就报「已领」而**不发**领取请求。
 *    所以重启、重试、重复的定时器都不可能领两次 —— 根本不存在第二条写入路径。
 * 2. **只作用于用户勾进池的成员。** 成员资格就是这个插件里「可以花这个账号的
 *    积分」的同意书。不在池里的账号不签到，正如它们不被测试、不被换号。
 * 3. **有界重试，然后慢等。** 一次瞬时失败按逐级放宽的退避重试，之后落到慢
 *    轮询直到日窗翻页。它既不轰上游，也不在当天永久放弃。
 * 4. **可观测。** 卡片写着「今日：N 个已签」，所以后台动作从来不是不可见的。
 *
 * ## 为什么调度是纯的
 *
 * 每一个决定 ——「到点了吗」「哪些账号」「回报什么」—— 都是对普通数据的导出
 * 函数。本模块不持定时器、不读时钟、不写盘。`src/index.ts` 持有定时器与磁盘，
 * 本文件持有规则，于是规则可以在没有 Host、没有网络、没有假时钟的情况下被测。
 * 这与 `account-pool-run.ts` 对批量动作的拆分是同一种取舍，理由也相同。
 *
 * @module dsh-connect-qoder/auto-checkin
 */

import type { QoderWebPoolCheckinRow } from './status-paths.ts'
import type { QoderRegion } from './upstream.ts'

/**
 * 提供每日签到的区域。
 *
 * 两个区域**都有**（sash 的 campaigns 活动，见 `QoderUpstreamClient.fetchCampaignFeed`
 * 的实测记录）。差别只在认证：国际版额外要本机 UMID 组件的设备风控头，取不到时
 * 签到如实报错 —— 那种失败由重试阶梯处理，不是「这里没有签到」。
 */
export function autoCheckinRegions(): readonly QoderRegion[] {
  return ['cn', 'global']
}

/**
 * 失败后的重试退避，单位毫秒。
 *
 * 五级、逐级放宽，然后进入慢轮询。形状比数字更重要：第一次重试要快（一次
 * socket 抖动几秒就恢复了），尾巴要慢（上游故障不该被每分钟捅一次直到天黑）。
 * 走完这一串之后按 {@link AUTO_CHECKIN_TAIL_MS} 重复，直到日窗翻页。
 *
 * 与 workbuddy 取同一组数：签到的单次成本是「一次活动列表 GET + 一次领取 POST」，
 * 没有探针那种真实 token 花费，所以 30 秒起步是安全的。
 */
export const AUTO_CHECKIN_BACKOFF_MS: readonly number[] = [
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
]

/** {@link AUTO_CHECKIN_BACKOFF_MS} 走完之后，稳态的重试间隔。 */
export const AUTO_CHECKIN_TAIL_MS = 30 * 60_000

/**
 * 一个**已完成**的日窗之后，定时器醒来一次的最大间隔。
 *
 * 它不是重试，是「今天都做完了，明天再来」的心跳。存在的理由只有一个：定时器
 * 一旦停死，就再也没人能发现日窗翻页了，而这个功能会安静地只工作一天 —— 正是
 * 这套设计想避免的失效形态。空闲的那一拍**不发**任何请求：`isDue` 在
 * 「没有待办」时先于任何 I/O 给出答案。
 */
export const AUTO_CHECKIN_IDLE_MS = 30 * 60_000

/**
 * 空闲时最早多久醒一次。
 *
 * 两个用途：一是日窗刚开的那一刻不要连打（下一次醒来必须真的过了一点时间）；
 * 二是把上游给的「下一窗开门时刻」夹进一个不会空转的区间 —— 见
 * {@link idleDelayMs}。
 */
export const AUTO_CHECKIN_MIN_IDLE_MS = 5_000

/**
 * 日窗（每日签到的那一窗）的开门相对 UTC 的偏移：`02:00Z` = `10:00` UTC+8。
 *
 * **实测**（`tests/checkin-countdown.spec.ts` 与上游活动原文）：活动窗是
 * `startAt` 当天 10:00:00 → `endAt` 次日 09:59:00（UTC+8），与官方活动文案
 * 「每日 10:00（UTC+8）刷新」一致。
 */
const WINDOW_OPEN_OFFSET_MS = 2 * 60 * 60_000

/**
 * 这一时刻属于哪一个 **Qoder 日窗**，形如 `2026-11-10`。
 *
 * ## 为什么不能用「本地日历日」（workbuddy 的 `localDayKey` 在这里是错的）
 *
 * workbuddy 的上游在当地零点重置签到，所以它的日键就是用户的本地日历日。Qoder
 * 的窗口边界是一个**固定的绝对时刻**（10:00 UTC+8），与用户所在时区无关。照抄
 * 本地日历日会同时错两头：
 *
 *   - 对 UTC+8 以外的用户，本地零点与 10:00 UTC+8 根本不是同一个时刻，「今天」
 *     的边界落在了窗口中间；
 *   - 即使在 UTC+8，本地零点也在窗口**中间**（窗口 10:00 开、次日 09:59 关）。
 *     于是 00:05 会被判定成「新的一天」而去领一次（幂等，报「已领」，记成完成），
 *     而 10:00 真正开窗时状态仍写着「今天已完成」—— **新窗口的那一份要等到
 *     第二天 00:05 才会被领**，晚 14 小时，且卡片上的倒计时会一直是「现在可以
 *     签到」而没人去签。这一条是移植时最容易照抄错的地方。
 *
 * 所以日键 = 「(now − 2h) 的 UTC 日期」：10:00 UTC+8 开窗的那一刻它翻页，次日
 * 09:59 之前它都不变。用 UTC 取数而不是本地取数，是因为窗口边界本来就是 UTC 的
 * 一个固定偏移 —— 这样同一个窗口对全世界所有用户都是同一个键。
 */
export function qoderWindowDay(nowMs: number): string {
  const shifted = new Date(nowMs - WINDOW_OPEN_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${shifted.getUTCDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 进度所描述的那一窗。
 *
 * `key` 是这一窗的身份：换了键就把「今天已经签过谁」整个清零。
 */
export interface CheckinWindow {
  /** 身份。两种来源，见 {@link checkinWindowOf}。 */
  key: string
  /** 这一窗的关门时刻 / 下一窗的开门时刻（epoch 毫秒），上游说过才有。 */
  refreshAtMs?: number
}

/**
 * 当前属于哪一窗。
 *
 * 优先用**上游说过的**关门时刻：只要它还在未来，这一窗就没翻页，而那个键是
 * 上游自己的一个绝对时刻，不会因为本机时钟跨时区而移动。
 *
 * 没有上游时刻时（还没成功打过一次上游），退回按固定边界算的日键
 * （{@link qoderWindowDay}）。这条退路只在一天里第一次尝试之前有效 —— 任何一次
 * `claimed` / `already` 都会带回 `endAt`，之后就一直走上游那条。
 *
 * 两种来源的键**前缀不同**（`upstream:` / `boundary:`），所以从一条切到另一条时
 * 键一定变、状态一定重置。那次重置只是多一轮幂等重跑（先读状态、已领报 already），
 * 代价是一人一次活动列表 GET —— 而换来的是「窗口一旦翻页就一定会重新看一眼」，
 * 这正是漏一天的原因。
 */
export function checkinWindowOf(nowMs: number, refreshAtMs: number | undefined): CheckinWindow {
  if (refreshAtMs !== undefined && Number.isFinite(refreshAtMs) && refreshAtMs > nowMs) {
    return { key: `upstream:${refreshAtMs}`, refreshAtMs }
  }
  return { key: `boundary:${qoderWindowDay(nowMs)}` }
}

/**
 * 各成员身上记着的「下一窗开门时刻」里，仍然在未来、且最远的那个。
 *
 * 为什么要取**最大**：那些时刻都是「下一次可以再领」的时刻，而日窗对整区是同一
 * 批（所有成员领的是同一份每日活动）。取最大的那个等于「最后一个成员报的下一窗」，
 * 对判定翻页是保守的：早判只会多一轮幂等重跑，晚判会漏掉一窗 —— 后者才是要害。
 *
 * 已经过去的时刻一律丢掉：拿一个旧日期当「下一窗」会让翻页判定永远不成立，
 * 于是状态永远不重置、新窗口永远不领（`windows` 键里留着的正是历史值）。
 */
export function latestRefreshAt(values: Iterable<number | undefined>, nowMs: number): number | undefined {
  let latest: number | undefined
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value) || value <= nowMs) continue
    if (latest === undefined || value > latest) latest = value
  }
  return latest
}

/**
 * 一次区域运行在两次 tick 之间记得的东西（按窗存储，落盘）。
 *
 * 落盘是为了重启能接着跑：否则每次重启都把这一窗当成没试过，重跑一遍批次 ——
 * 幂等，但要为每个成员各花一次活动列表请求。
 */
export interface AutoCheckinState {
  /** 这份状态描述的那一窗（{@link CheckinWindow.key}）。换窗即整份重置。 */
  window: string
  /**
   * 今天已确认完成的账号：`claimed` 或 `already`。
   *
   * `failed` 的行**刻意不记**，于是下一拍只重试它们，已经成功的账号不再被打扰。
   */
  doneAccountIds: readonly string[]
  /**
   * 上一次尝试面对的**在范围内**账号数（成员里能解析出凭据的那些）。
   *
   * 记在这里而不是让卡片自己算：卡片的轮询付不起枚举凭据库的代价，而成员资格
   * 一天里可能变 —— 这一窗的进度是拿哪个分母量的，只有那个分母才是诚实的「N / M」。
   */
  scopeSize: number
  /**
   * 这一窗里**连续**失败的次数，用来选退避档。
   *
   * 一次尝试只要推进了至少一个账号就归零：有进展说明上游是通的，下一次失败理应从
   * 最短的那一档重来，而不是直接跳到 30 分钟。
   */
  failures: number
  /** 上一次尝试结束的时刻（epoch 毫秒）。 */
  lastAttemptAtMs?: number
  /** 上一次尝试失败的原因，给卡片看；一次干净的成功之后不该留。 */
  lastError?: string
}

/** 一窗、什么都没做时的状态。 */
export function emptyAutoCheckinState(window: string): AutoCheckinState {
  return { window, doneAccountIds: [], scopeSize: 0, failures: 0 }
}

/**
 * 把存下来的状态折算成**当前这一窗**的状态。
 *
 * 窗口不同就整份重置 —— 这是「翻页了，重新看一眼」的唯一入口。`window` 是唯一
 * 决定这件事的字段：本机时钟跳一下（笔记本换时区、用户改了系统时间）只会让键
 * 变成另一窗，于是痛快地重来，而不是相信一份过期的 `doneAccountIds`。
 */
export function stateForWindow(
  previous: AutoCheckinState | undefined,
  window: CheckinWindow,
): AutoCheckinState {
  if (previous !== undefined && previous.window === window.key) return previous
  return emptyAutoCheckinState(window.key)
}

/**
 * 把一次尝试的行折进这一窗的状态。
 *
 * `doneAccountIds` 在**同一天里跨尝试累加**：一次批量可能中途失败，答上来的那些
 * 就算完成，下一拍只需要补剩下的。只按这一次的结果重算集合，会让运行器把已经
 * 成功的账号再签一遍。
 *
 * `failures` 数的是**连续**失败，而一次有进展的尝试会把它归零 ——
 * 见 {@link AutoCheckinState.failures}。
 */
export function foldAttempt(
  previous: AutoCheckinState,
  rows: readonly QoderWebPoolCheckinRow[],
  nowMs: number,
  scopeSize: number = previous.scopeSize,
): AutoCheckinState {
  const done = new Set(previous.doneAccountIds)
  let progressed = false
  const failures: string[] = []
  for (const row of rows) {
    if (row.status === 'claimed' || row.status === 'already') {
      if (!done.has(row.accountId)) {
        done.add(row.accountId)
        progressed = true
      }
      continue
    }
    failures.push(row.message ?? row.accountId)
  }
  return {
    window: previous.window,
    doneAccountIds: [...done],
    scopeSize,
    failures: progressed ? 0 : previous.failures + (failures.length > 0 ? 1 : 0),
    lastAttemptAtMs: nowMs,
    ...failures.length === 0 ? {} : { lastError: failures[0]! },
  }
}

/**
 * 下一次尝试前等多久。
 *
 * 返回 `undefined` 表示这一窗已经没有待办 —— 调用方此时该按 {@link idleDelayMs}
 * 挂一个空闲心跳，而不是重试：空闲心跳会让定时器活到能发现翻页的那一刻，且不发
 * 任何请求。
 *
 * `pending` 是还欠着的账号数，由调用方传入而不是从状态里推：只有调用方能枚举
 * 池子（状态记的是「谁做完了」，不是「谁存在」）。
 */
export function nextDelayMs(state: AutoCheckinState, pending: number): number | undefined {
  if (pending === 0) return undefined
  if (state.failures >= AUTO_CHECKIN_BACKOFF_MS.length) return AUTO_CHECKIN_TAIL_MS
  return AUTO_CHECKIN_BACKOFF_MS[Math.max(0, state.failures)]!
}

/**
 * 空闲时该睡多久：不晚于日窗开门，也不长过 {@link AUTO_CHECKIN_IDLE_MS}。
 *
 * 上限用空闲心跳而不是「睡到开门」：定时器一旦睡 20 小时，中途的时钟跳变、
 * 用户改配置、机器休眠都会让它错过开门那一刻，而它自己无从知道（`setTimeout`
 * 的时间基准在挂起之后不再可靠）。每半小时醒一次的成本是零（待办为空时
 * `isDue` 先于 I/O 返回），换来的是「最迟半小时内一定会看一眼」。
 *
 * 下限 {@link AUTO_CHECKIN_MIN_IDLE_MS} 防的是「刚过一点就醒」的空转：上游给的
 * 时刻与本机时钟一般会有毫秒级偏差，`refreshAtMs − nowMs` 可能算出 1ms。
 */
export function idleDelayMs(window: CheckinWindow, nowMs: number): number {
  if (window.refreshAtMs === undefined) return AUTO_CHECKIN_IDLE_MS
  const until = window.refreshAtMs - nowMs
  return Math.min(Math.max(until, AUTO_CHECKIN_MIN_IDLE_MS), AUTO_CHECKIN_IDLE_MS)
}

/**
 * 现在是否该试一次。
 *
 * `pending === 0` 是「没事可做」，**不是**「到点了」：给空集合挂一个重试，只会让
 * 定时器每一档退避都醒来确认一次同一件事。
 */
export function isDue(state: AutoCheckinState, pending: number, nowMs: number): boolean {
  if (pending === 0) return false
  if (state.lastAttemptAtMs === undefined) return true
  const delay = nextDelayMs(state, pending)
  if (delay === undefined) return false
  return nowMs - state.lastAttemptAtMs >= delay
}

/**
 * 卡片对「今日」的回报。
 *
 * `pending` 数的是还欠一次尝试的账号。用普通形状而不是一句话：两个语种都要渲染
 * 它，而放在哪里由卡片决定（用户要的是开关旁边那一行状态）。
 */
export interface AutoCheckinSummary {
  /** 今天已确认完成的账号数。 */
  done: number
  /** 今天在范围内的账号数。 */
  total: number
  /** 今天还欠着的尝试数；0 表示这一窗做完了。 */
  pending: number
  /** 上一次尝试失败的原因（真的失败过才有）。 */
  lastError?: string
}

/**
 * 由状态拼出摘要。
 *
 * 只吃**状态**：分母在当天第一次尝试时就记下了（见
 * {@link AutoCheckinState.scopeSize}），所以卡片的轮询不需要扫凭据库，而中途
 * 改成员资格也不会偷偷改写它正在汇报的进度。
 */
export function summarizeAutoCheckin(state: AutoCheckinState): AutoCheckinSummary {
  const inScope = Math.max(0, state.scopeSize)
  const done = Math.min(state.doneAccountIds.length, inScope)
  return {
    done,
    total: inScope,
    pending: Math.max(0, inScope - done),
    ...state.lastError === undefined ? {} : { lastError: state.lastError },
  }
}

/**
 * 当前这一窗的摘要 —— `state` 不属于 `window` 时是 `undefined`。
 *
 * 这一道检查**不是**锦上添花。状态只在 tick 真的跑过之后才被重写，而一个做完
 * 的窗口之后下一拍可能隔了整整 {@link AUTO_CHECKIN_IDLE_MS} —— 所以新窗口开始的
 * 头半小时里，内存中的状态描述的仍然是**上一窗**。把它当成今天汇报，卡片就会在
 * 10:05 写着「今日：N 个全部已签」而下面每一行都是「未签到」—— 本该证明运行器
 * 在工作的那一格，恰恰说了反话。（workbuddy 的 issue #232 是同一种谎，只是它的
 * 边界在零点。）
 *
 * 返回 `undefined`（而不是一份全零的摘要）正是卡片已经渲染成「没有状态行」的那个
 * 形状，也是诚实的答案：今天什么都还没跑过。全零反而会为一天编一个分母。
 */
export function summaryForWindow(
  state: AutoCheckinState,
  window: CheckinWindow,
): AutoCheckinSummary | undefined {
  if (state.window !== window.key) return undefined
  // 这一窗**一次都没试过**时不报进度 —— 两个 0 会让卡片说「0 个全部已签」。
  //
  // 这条不是防御性代码，是 CI 在 Windows 上抓到的一个真 bug（1.24.0 发布时）：
  // 运行器在**开批之前**就把一份 `scopeSize: 0` 的空状态发布进了内存，于是卡片在
  // 那个窗口里读到的就是 `{ done: 0, total: 0, pending: 0 }`。卡片的判据是
  // `pending === 0 && done === total`，两个 0 相等 —— 它把「什么都没做」渲染成了
  // 「全部做完了」。同一份空状态还有第二个来源：窗口翻页时 `stateForWindow`
  // 重置出来的那一份，在下一拍真的跑起来之前同样会被读到。
  //
  // 判据用 `lastAttemptAtMs`：它只在一次尝试**真的跑完之后**才被 `foldAttempt`
  // 写上。没有它 = 这一窗一次都没试过 = 没有可报的进度。
  //
  // 注意不能改成「`scopeSize === 0` 就不报」：池里一个成员都没有时，确实**没有**
  // 可报的东西；但「试过了、两个号都失败了」必须照实报（`scopeSize: 2`），否则
  // 用户永远看不到它在重试。两种情形靠 `lastAttemptAtMs` 分开，不靠分母。
  if (state.lastAttemptAtMs === undefined) return undefined
  return summarizeAutoCheckin(state)
}

/**
 * 一次尝试应当处理的账号，按池子自己的顺序。
 *
 * 只留还没做完的。幽灵 id（配置里留着、凭据已删）在调用方枚举时就被丢掉了 ——
 * 这里拿到的是已经能解析出凭据的目标，所以「还欠着」这个数字是准的。
 */
export function pendingTargets<T extends { accountId: string }>(
  targets: readonly T[],
  state: AutoCheckinState,
): T[] {
  const done = new Set(state.doneAccountIds)
  return targets.filter(target => !done.has(target.accountId))
}
