/**
 * 换号时的用户可见提示。
 *
 * ## 为什么需要它
 *
 * 账号池换号是**插件自己做的决定**：用户选中 A，A 被限流，插件静默改由 B
 * 回答。不提示的话，用户看到的是一段正常回答，既不知道换过号，也不知道自己
 * 选的 A 已经出问题——下次还会踩进去。池子的价值一半在可见性，静默换号等于
 * 把池藏起来。
 *
 * ## 三条硬约束
 *
 * 1. **不点名接管账号**。接管账号是「接下来继续对话的对象」，点名会让人误以为
 *    现在得去管它。用户需要知道的是「你选的那个失败了」，不是「现在是谁在答」。
 *    与 dsh-connect-workbuddy 保持一致。
 * 2. **`quota-exhausted` 不等于积分耗尽**。qoder 的业务码 `110` 是「用量已达
 *    上限」，次日恢复；写成「积分耗尽」是错的，还会误导用户去充值。
 * 3. **未知 kind 不编造原因**。宁可用中性措辞，也不猜一个可能错的理由——用户
 *    会照着这句话去行动。
 */

import type { UpstreamErrorKind } from './upstream.ts'

/**
 * 每种失败对用户该怎么讲。
 *
 * 键必须覆盖 `UpstreamErrorKind` 全集；`satisfies Record<…>` 让上游新增 kind
 * 时这里**编译期报错**，而不是运行时悄悄走到兜底分支。
 */
const REASON_TEXT = {
  network: '网络中断',
  auth: '凭证已失效',
  'rate-limited': '被限流',
  'invalid-request': '请求被上游拒绝',
  'content-policy': '触发内容策略',
  // ⚠️ 不是「积分耗尽」：qoder 110 = 当日用量已达上限，次日恢复。
  'quota-exhausted': '当日用量已达上限',
  transient: '上游暂时异常',
  unknown: '上游返回了无法识别的失败',
} as const satisfies Record<UpstreamErrorKind, string>

/** 失败种类的用户可读理由。未知 kind 走中性兜底，不编造。 */
export function failoverReasonText(kind: UpstreamErrorKind | string): string {
  return (REASON_TEXT as Record<string, string | undefined>)[kind] ?? REASON_TEXT.unknown
}

/**
 * 排队这一档的专属说法（issue #26）。
 *
 * 排队在 kind 那一层是 `transient`（上游业务码 10605），所以光看 kind 只能说
 * 「上游暂时异常」—— 而上游逐字说的是「在排队，服务是好的」。这两句对用户的
 * 行动指导完全不同：前者像是要等，后者是「等 30 秒就好，账号没坏」。
 */
export const QUEUE_REASON_TEXT = '上游排队中'

/**
 * 排队时的换号提示正文（issue #26）。
 *
 * 与 {@link failoverNoticeText} 同构，只是理由换成「上游排队中」。
 */
export function queuedFailoverNoticeText(
  failed: { accountName: string; accountId: string },
): string {
  const label = accountLabelOf(failed.accountName, failed.accountId)
  return `「${label}」${QUEUE_REASON_TEXT}，已改用池中另一个账号回答。`
}

/**
 * 账号在提示里怎么称呼。
 *
 * 账号名可能为空（env 路径下 `accountName` 是空串），也可能就是内部 id。
 * 空名时退回 id；两者都空时用中性说法，绝不出现「「」被限流」这种空书名号。
 */
export function accountLabelOf(accountName: string, accountId: string): string {
  const name = accountName.trim()
  if (name !== '') return name
  const id = accountId.trim()
  if (id !== '') return id
  return '所选账号'
}

/**
 * 换号提示正文（不含任何前缀、不含换行）。
 *
 * 是否该显示由调用方判断——见 `shouldAnnounceFailover`。
 */
export function failoverNoticeText(
  failed: { accountName: string; accountId: string },
  kind: UpstreamErrorKind | string,
): string {
  const label = accountLabelOf(failed.accountName, failed.accountId)
  return `「${label}」${failoverReasonText(kind)}，已改用池中另一个账号回答。`
}

/**
 * 这次失败要不要向用户播报。
 *
 * 只播报**真正换成了另一个账号**的情况。以下几种都不播报：
 *
 * - 池没启用 / 没有任何账号被换过（`switched === false`）；
 * - 拿不到失败原因（换号逻辑没告诉我们是哪种失败）；
 * - 新旧账号相同（等价于没换）。
 *
 * 提取成纯函数而非内联判断，是为了让测试能钉住「什么情况下不提示」——内联
 * 的闭包此前有过悄悄失去可验证性的记录。
 */
export function shouldAnnounceFailover(input: {
  switched: boolean
  fromAccountId: string
  toAccountId: string
  kind: UpstreamErrorKind | string | undefined
}): boolean {
  if (!input.switched) return false
  if (input.kind === undefined) return false
  if (input.fromAccountId === '') return false
  return input.fromAccountId !== input.toAccountId
}
