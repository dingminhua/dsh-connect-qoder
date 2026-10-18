/**
 * 一个账号状态点的颜色语义，两个表格共用。
 *
 * 抽取理由与 `exclusion-text.ts` 完全相同：账号池大表与 composer 小面板说的是
 * **同一次测量**。两处给出不同颜色，用户就没法从小面板（他先看到的那一个）
 * 判断「这个号现在到底能不能用」—— 那正是用户实拍的问题。
 *
 * 用户的最终口径（2026-10-18，覆盖此前两轮的说法）：
 *
 *   「能用的 绿色圆点，当前选择的，绿色圆点加第二行提示当前选用，
 *     不能用的 红色圆点+原因」
 *
 * 即：**颜色只回答「能不能用」，只有两种** ——
 *
 *   · 能用（此刻没有被排除）→ 绿；
 *   · 不能用（有 `excludedBy`）→ 红；原因由 `exclusionText` 那一行写出来，
 *     会自己恢复的（限流、额度用尽）再补「约 N 分钟后解禁」。
 *
 * 被排除但会自己好的（限流、上游暂不可用）也是**红**：红点说的不是「永久
 * 坏掉」，而是「现在别指望它」；「还能等多久」交给原因里的解禁时长，不再用
 * 琥珀色单独表达一层含义。探针结论不单独着色 —— `exclusionOf` 已经把它折算
 * 进 `excludedBy`，同一份事实不重复表达。
 *
 * 「当前选用」不再靠颜色区分（能用的本来就绿），改由第二行文字说明。
 */
import type { QoderWebPoolExclusion } from '../status-paths.ts'

/** 状态点的语义色。`warn` / `unknown` 保留在词表里（其它消费者可能用到），
 * 但本模块的判定只产出 `ok` / `bad` 两种。 */
export type AccountStateTone = 'ok' | 'warn' | 'bad' | 'unknown'

/**
 * 一个账号的状态色语义：能用绿、不能用红。
 *
 * 纯函数，只吃「此刻是否被排除」。`probeOutcome` 作为**兼容入参**保留：排除
 * 判定（`exclusionOf`）已经由探针结论推导过一遍，这里再判一次只会在边界上
 * 又分叉出第三种颜色。
 */
export function accountStateTone(input: {
  excludedBy?: QoderWebPoolExclusion
  probeOutcome?: string
}): AccountStateTone {
  return input.excludedBy === undefined ? 'ok' : 'bad'
}

/** CSS 颜色（两处表格共用同一组令牌，避免出现两种绿）。 */
export function accountStateColor(tone: AccountStateTone): string {
  switch (tone) {
    case 'ok': return 'var(--dsw-alias-state-success-primary, #22a06b)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
    case 'bad': return 'var(--dsw-alias-state-error-primary, #ef4444)'
    case 'unknown': return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  }
}

/**
 * 行状态点用色（两处表格的行循环都调它）。
 *
 * `current` **不影响颜色**：能用的一律绿，不能用的一律红 —— 包括池关时仍在
 * 发号、但额度已经用尽的选中号。给它绿点就是「当前使用 + 用量已达上限」这
 * 个自相矛盾的老 bug（用户实拍，2026-10-18）复活。「当前选用」改由第二行
 * 文字说明，不占用颜色。
 *
 * 保留这个包装（而不是让调用方直接用 `accountStateTone`）是为了让「行上的
 * 点在用与否」仍然是一个显式入参，将来若再引入第三种状态不必改两个调用方。
 */
export function accountDotTone(input: {
  current: boolean
  excludedBy?: QoderWebPoolExclusion
  probeOutcome?: string
}): AccountStateTone {
  return accountStateTone(input)
}
