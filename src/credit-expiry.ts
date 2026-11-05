/**
 * 「签到得到的这批积分什么时候作废」——按签到批次推算的上界（issue #31）。
 *
 * 上游只告诉我们两件事：这次签到领到多少（`benefit.amount`），以及这一批的有效
 * 天数（`benefit.validity.days`，`mode: 'RELATIVE_DAYS'`）。**它不告诉我们花掉的
 * 是哪一批**，也没有「每批还剩多少」的读数。所以这是一个近似，而近似的方向必须
 * 选对 —— 这一行字存在的意义就是「提醒你别让积分悄悄过期」，报晚了等于没有提醒。
 *
 * 因此：
 *
 * - 内部记账按 FIFO（先花最早的），这与上游大概率一致，也便于将来对账；
 * - **显示取悲观的那一侧**：不冲销任何批次，直接用「最早一批还没过期的」当上界。
 *   FIFO 的假设若成立，手上剩的其实都是新批次，真实到期会比这个晚 —— 也就是说
 *   我们宁可早报几天。
 * - `claimAtMs` 缺席（老记录 / 只见过 `already-claimed`）时**不算**：宁缺勿错，
 *   与 `row.poolRetryUnknown` 同一条规矩。
 * - 只对 `RELATIVE_DAYS` 生效。上游哪天给出绝对时刻（`ABSOLUTE`），直接信上游，
 *   不掺 FIFO 近似。
 *
 * 本模块是纯函数：不碰网络、不碰文件、不读时间（`nowMs` 由调用方给）。
 *
 * @module dsh-connect-qoder/credit-expiry
 */

/** 「3 天内过期」的窗口；与卡片文案 `row.poolCreditSoon` 是同一个数。 */
export const CREDIT_SOON_MS = 3 * 24 * 3600 * 1000

const DAY_MS = 24 * 3600 * 1000

/**
 * 一次签到领到的积分批次。
 *
 * `validityDays` 缺席 = 上游这次没说有效天数（不猜）。`amount` 缺席 = 没说数额
 * （只影响「临期多少分」，不影响「哪一批先过期」）。
 */
export interface QoderCheckinBatch {
  /** 领取时刻（epoch ms）。这是上游没给的 `claimAtMs`，由本地在领到的那一刻记下。 */
  atMs: number
  /** 有效天数，来自 `benefit.validity.days`。 */
  validityDays: number
  /** 这一批的数额，来自 `benefit.amount`。 */
  amount?: number
}

/** 一批积分的到期时刻（epoch ms）。 */
export function batchExpiresAtMs(batch: QoderCheckinBatch): number {
  return batch.atMs + batch.validityDays * DAY_MS
}

/**
 * 按签到批次推算的「最早可能到期」与「临期金额」。
 *
 * 两条都取**悲观**的一侧，理由见文件头：宁可早报。返回值缺席（`undefined` /
 * `0`）表示「我们不知道」，UI 就此闭嘴，而不是显示一个 0。
 *
 * @param batches 该账号的签到批次（顺序无关，本函数自己排序）。
 * @param nowMs   现在（epoch ms）；`<= nowMs` 的到期时刻已经作废，不参与。
 */
export function creditExpiryOf(
  batches: readonly QoderCheckinBatch[],
  nowMs: number,
): { nearestExpiryMs?: number, expiringAmount: number } {
  let nearestExpiryMs: number | undefined
  let expiringAmount = 0
  for (const batch of batches) {
    if (!Number.isFinite(batch.validityDays) || batch.validityDays <= 0) continue
    const expiresAtMs = batchExpiresAtMs(batch)
    // 已经过去的批次不再挂「即将过期」——它要么早被花掉，要么真的作废了；两种
    // 情况下再提前提醒都没有意义（与 `creditsOf` 的下界是同一条 issue #31 教训）。
    if (expiresAtMs <= nowMs) continue
    if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs
    if (expiresAtMs - nowMs < CREDIT_SOON_MS) expiringAmount += batch.amount ?? 0
  }
  return {
    ...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }),
    expiringAmount,
  }
}

/**
 * 把一批新的签到并进历史，并裁掉不可能再影响显示的旧批次。
 *
 * 裁剪规则只看时间：到期已经过去的批次对「最近到期」与「临期金额」都不再有
 * 贡献，留着只会让落盘文件无限长。保留 `KEEP` 批是按「一天一批」估的余量。
 *
 * 同一时刻、同一天数、同数额的重复记录会被折叠 —— `already-claimed` 与重试都
 * 可能让同一批被记两次，重复一次会让「临期金额」翻倍。
 */
export function appendCheckinBatch(
  batches: readonly QoderCheckinBatch[],
  batch: QoderCheckinBatch,
  nowMs: number,
): QoderCheckinBatch[] {
  const KEEP = 12
  const same = (a: QoderCheckinBatch, b: QoderCheckinBatch): boolean =>
    a.atMs === b.atMs && a.validityDays === b.validityDays && a.amount === b.amount
  const next = [...batches.filter(existing => !same(existing, batch)), batch]
  return next
    .filter(existing => batchExpiresAtMs(existing) > nowMs)
    .sort((left, right) => left.atMs - right.atMs)
    .slice(-KEEP)
}
