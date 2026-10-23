/**
 * Qoder 的活动优惠规则（`promotion`）：解析与「此刻是否成立」的判定。
 *
 * 三件事都在这里，且都围绕**不替上游说话**：
 *
 * 1. 什么是活动。`model/list` 的每个模型行自带一个 `promotion` 对象，里面既有
 *    上游自己的文案（`badge.zh` / `badge.en`、`description`），也有规则本身
 *    （`rule_id`、`discount_factor`、`window_start/end`、`timezone`）。实测两个
 *    区域都是同一套 schema，只有时区与文案不同（国内 `Asia/Shanghai`，国际
 *    `Asia/Singapore`；国内写「错峰 4 折」，国际写「错峰 4 折」/「Off-Peak 60%
 *    off」）。**文案是上游给的，插件不翻译、不改写**——这与 workbuddy 的促销
 *    徽标同规，也与 Trae 那边故意留白的做法相反（Trae 只发数字，所以那边只能
 *    自造「闲时」这类词）。
 * 2. 什么时候画。上游同时给了一个服务端算好的 `active` 和一个墙钟时段。实测
 *    2026-10-21T16:2x（窗口 22:00–08:00 之外）两个区域全部 `active: false`，说明
 *    它是**按当时那一刻算的**，不是常量；而目录是 DSH 进程启动时取的一份内存快照
 *    （之后只有点「从 Qoder 刷新」才换）。所以：**有窗口就用窗口**（渲染时刻现算，
 *    快照多旧都不影响），没有窗口才退回 `active`。若把 `active` 也当成门，白天启动
 *    的进程会拿着 16:00 的 `false` 一直用到退出，22:00 窗口开了也不画——这个功能
 *    对「一直开着 DSH」的用户等于不存在。反过来，窗口是「此刻」的纯函数，不会因为
 *    快照旧而说错话。
 * 3. 时段怎么算。`window_start` / `window_end` 是**上游声明时区里的墙钟时间**
 *    （`HH:MM`，终点允许 `24:00`），且可以跨零点（22:00→08:00）。所以判定必须按那条
 *    记录的 `timezone` 求当地分钟数，不能拿浏览器本地时间直接比——用户在 UTC+0 打开
 *    卡片时，「22:00–08:00」说的是 Asia/Shanghai 的 22:00，不是他的。时区读不懂就
 *    不画（退回本地时区会让跨零点窗口错位几小时，比不画更糟）。
 *
 * 这里**不做**的事：不猜活动意图、不从 `discount_factor` 反推文案、不把
 * `link_url` 变成可点击动作（卡片上的胶囊只是提示）、不在解析时挑定一枚
 * 徽标（判定放在渲染时刻，理由同 workbuddy 的 `selectPromoBadge`）。
 *
 * @module dsh-connect-qoder/promo
 */

// ---------------------------------------------------------------------------
// 上游形状与解析
// ---------------------------------------------------------------------------

/** 上游的中英双语字段（`badge` / `description` / `link_url` 都是这个形状）。 */
export interface QoderPromoLabel {
  zh?: string
  en?: string
}

/** 上游声明的时段（`window_start` / `window_end`，墙钟 `HH:MM`，可跨零点）。 */
export interface QoderPromoWindow {
  /** 原样保留的起点文本（`22:00`）。 */
  start: string
  /** 原样保留的终点文本（`08:00`）。 */
  end: string
  /** 起点的当天分钟数（0–1439）。 */
  startMinute: number
  /** 终点的当天分钟数（0–1439）。 */
  endMinute: number
}

/**
 * 一条已解析的活动规则。
 *
 * 字段名用 camelCase（上游是 snake_case），存储与投影都只认这一种形状——落盘
 * 的形状与运行期的形状是同一个，读回时不需要第二套解析（`readPromotion`）。
 */
export interface QoderPromotion {
  /**
   * 上游在**取目录那一刻**算出的「此刻生效」。
   *
   * 它是一份快照：目录在 DSH 进程启动时取一次，之后只有点「从 Qoder 刷新」才会换。
   * 所以只在**没有窗口声明**时拿它作依据（那种活动没有起止，快照旧了也不会错）；
   * 有窗口时窗口说了算，见 `promoLiveAt`。
   */
  active: boolean
  /** 上游自己的徽标文案。没有它就没有可画的东西，解析直接丢弃。 */
  badge: QoderPromoLabel
  /** 上游自己的悬停说明。 */
  description?: QoderPromoLabel
  /** 上游声明的时区（`Asia/Shanghai`）；缺席时按账号所在区域兜底。 */
  timeZone?: string
  /** 上游声明的每日时段；缺席表示没有窗口声明。 */
  window?: QoderPromoWindow
  /**
   * 上游**声明了**窗口但读不懂（`24:30`、只给一端、`HH:MM` 以外的写法）。
   *
   * 与「没有窗口声明」是两件事：读不懂的窗口不能被当成「全天」，也不能退回去信
   * `active`——那会把一句读不懂的规则放大成整天都在打折。这种条目一律不画。
   */
  windowUnreadable?: boolean
  /** 上游的活动说明页。 */
  link?: QoderPromoLabel
}

/** 读取一个非空、非全空白的字符串。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 读取一个有限数。 */
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读取一个双语字段；两边都没有时返回 undefined。 */
function label(value: unknown): QoderPromoLabel | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const zh = text(raw['zh'])
  const en = text(raw['en'])
  if (zh === undefined && en === undefined) return undefined
  return {
    ...zh === undefined ? {} : { zh },
    ...en === undefined ? {} : { en },
  }
}

/**
 * `HH:MM` → 当天分钟数。
 *
 * 起点只接受 0–23 时、0–59 分；**终点额外接受 `24:00`**（那是「到当天结束」的常见
 * 写法，映射成 1440，判定时正好等价于 `[start, 24:00)`）。其余越界/写坏的值返回
 * `undefined`：一份读不懂的窗口不该被解释成任何一个方向，由调用方标记成
 * `windowUnreadable` 并停止画。
 */
export function clockMinute(value: string, role: 'start' | 'end' = 'start'): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (role === 'end' && hour === 24 && minute === 0) return 1440
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 解析上游的时段；两端都读得懂才算有窗口。 */
export function parsePromoWindow(startRaw: unknown, endRaw: unknown): QoderPromoWindow | undefined {
  const start = text(startRaw)
  const end = text(endRaw)
  if (start === undefined || end === undefined) return undefined
  const startMinute = clockMinute(start)
  const endMinute = clockMinute(end, 'end')
  if (startMinute === undefined || endMinute === undefined) return undefined
  return { start, end, startMinute, endMinute }
}

/**
 * 解析上游的 `promotion` 对象。
 *
 * 丢弃的判据很干脆：没有 `badge.zh` 也没有 `badge.en` 的条目一律不要——那意味着
 * 上游没有给出可显示的话，插件没有可画的东西（也不该自己编）。`active` / 规则
 * 字段缺失时只是「此刻不画」，条目本身仍保留：规则是上游目录里的一份事实，丢了
 * 会让落盘往返悄悄少一段上游声明，也让 `scripts/probe-promo.mjs` 这类复核失去依据。
 *
 * 实测形状（`qmodel_38max`，截断）：
 * ```json
 * { "active": false, "rule_id": "idle_time_model_credit_discount",
 *   "discount_factor": 0.4, "before_promotion_price_factor": 0.5,
 *   "badge": { "zh": "错峰 4 折", "en": "Off-Peak 60% off" },
 *   "timezone": "Asia/Shanghai", "window_start": "22:00", "window_end": "08:00",
 *   "link_url": { "zh": "https://docs.qoder.cn/..." }, "description": { "zh": "..." } }
 * ```
 *
 * `discount_factor` / `before_promotion_price_factor` / `rule_id` 不保留：插件不从数字
 * 反推文案，也没有任何界面消费它们，留一份没人读的副本只会随目录一起落盘。
 */
export function parseQoderPromotion(value: unknown): QoderPromotion | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const badge = label(raw['badge'])
  if (badge === undefined) return undefined
  const description = label(raw['description'])
  const link = label(raw['link_url'])
  const timeZone = text(raw['timezone'])
  const window = parsePromoWindow(raw['window_start'], raw['window_end'])
  // 「声明了但读不懂」与「没声明」必须分开：前者不能退化成全天，见 `windowUnreadable`。
  const declared = text(raw['window_start']) !== undefined || text(raw['window_end']) !== undefined
  const unreadable = window === undefined && declared
  return {
    active: raw['active'] === true,
    badge,
    ...description === undefined ? {} : { description },
    ...link === undefined ? {} : { link },
    ...timeZone === undefined ? {} : { timeZone },
    ...window === undefined ? {} : { window },
    ...unreadable ? { windowUnreadable: true } : {},
  }
}

/**
 * 把**已落盘**的条目读回一条规则（`catalog` 的持久化往返）。
 *
 * 与 `parseQoderPromotion` 分开，是因为落盘形状是上面这个 camelCase 的
 * `QoderPromotion`，不是上游的 snake_case：同一份 schema 若在两处各写一遍解析，
 * 迟早漂移（workbuddy 的 `modelFromStored` 就是被这样咬过一次）。这里只做形状
 * 校验，值原样返回。
 */
export function readPromotion(value: unknown): QoderPromotion | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const badge = raw['badge']
  if (badge === null || typeof badge !== 'object' || Array.isArray(badge)) return undefined
  const badgeText = badge as Record<string, unknown>
  if (text(badgeText['zh']) === undefined && text(badgeText['en']) === undefined) return undefined
  const promo: QoderPromotion = {
    active: raw['active'] === true,
    badge: {
      ...text(badgeText['zh']) === undefined ? {} : { zh: text(badgeText['zh']) as string },
      ...text(badgeText['en']) === undefined ? {} : { en: text(badgeText['en']) as string },
    },
  }
  const description = label(raw['description'])
  if (description !== undefined) promo.description = description
  const link = label(raw['link'])
  if (link !== undefined) promo.link = link
  const timeZone = text(raw['timeZone'])
  if (timeZone !== undefined) promo.timeZone = timeZone
  const window = raw['window']
  if (window !== null && typeof window === 'object' && !Array.isArray(window)) {
    const rawWindow = window as Record<string, unknown>
    const start = text(rawWindow['start'])
    const end = text(rawWindow['end'])
    const startMinute = number(rawWindow['startMinute'])
    const endMinute = number(rawWindow['endMinute'])
    // 分钟数必须与文本一致；对不上时宁可整条窗口当不存在，也不拿错的时间判定。
    // 读不回窗口但**确实存过**（`windowUnreadable` 或 `window` 键还在）时保留标记：
    // 那原本就是「声明了但读不懂」的条目，读回后仍然不该画。
    if (
      start !== undefined && end !== undefined
      && startMinute !== undefined && endMinute !== undefined
      && clockMinute(start) === startMinute && clockMinute(end, 'end') === endMinute
    ) {
      promo.window = { start, end, startMinute, endMinute }
    } else {
      promo.windowUnreadable = true
    }
  }
  if (promo.window === undefined && raw['windowUnreadable'] === true) promo.windowUnreadable = true
  return promo
}

// ---------------------------------------------------------------------------
// 判定：此刻是否成立
// ---------------------------------------------------------------------------

/** 上游没给时区时的兜底（国内区域的窗口就是按它写的）。 */
export const QODER_PROMO_DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/**
 * 某一时刻在指定时区里的当天分钟数。
 *
 * 只用来把「上游声明的墙钟时间」和「此刻」放到同一个坐标系里。时区名读不懂时
 * 返回 `undefined`，由调用方决定回落——**不静默退回浏览器本地时间**：那会让
 * 一个跨零点窗口在别的时区悄悄错位 8 小时。
 *
 * `hourCycle: 'h23'` 是刻意的：部分引擎在 `hour12: false` 下会把午夜报成 24，
 * 那会让「22:00–08:00」在 00:00 判定失败。
 */
export function zonedClock(now: Date, timeZone: string): { minutes: number } | undefined {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now)
  } catch {
    return undefined
  }
  const read = (type: string): string | undefined => parts.find(part => part.type === type)?.value
  const hour = Number(read('hour'))
  const minute = Number(read('minute'))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  // 分钟归一化物理上不会发生（h23 已把 24 折成 0），保留取模只是兜底。
  return { minutes: (hour % 24) * 60 + minute }
}

/**
 * 此刻是否落在该规则的时段内。
 *
 * 语义与 Qoder 自己的描述一致（「10 PM-8 AM UTC+8」）：
 * - **起点含、终点不含**：22:00 已生效，08:00 已失效；`22:00–24:00` 覆盖到当天结束。
 * - **跨零点**：`start > end` 时命中区间是 `[start, 24:00) ∪ [0, end)`。
 * - `start === end` 视为**全天**：上游写「22:00–22:00」只可能是这个意思（与
 *   Trae 那边 `start===end` 的取舍一致）。
 * - **读不懂的时区一律返回 `false`**：judge 不了就不画。退回浏览器时区会让一个
 *   跨零点窗口在别的时区错位几小时，比不画更糟。
 * - 没有窗口声明时返回 `true`——这一支只由 `promoLiveAt` 在「确实没声明」时走到。
 */
export function promoWithinWindow(promo: QoderPromotion, now: Date): boolean {
  const window = promo.window
  if (window === undefined) return true
  const clock = zonedClock(now, promo.timeZone ?? QODER_PROMO_DEFAULT_TIME_ZONE)
  if (clock === undefined) return false
  const { startMinute, endMinute } = window
  if (startMinute === endMinute) return true
  if (startMinute < endMinute) return clock.minutes >= startMinute && clock.minutes < endMinute
  return clock.minutes >= startMinute || clock.minutes < endMinute
}

/**
 * 徽标此刻该以什么姿态出现。
 *
 * - `live`：此刻成立，正常画。
 * - `pending`：上游声明了**读得懂**的窗口，但此刻不在窗口内——优惠是排定的、还没
 *   到点。这一支存在的唯一理由是「白天看不见」：只画成立的那一种，一个白天开着
 *   DSH 的用户永远发现不了晚上有折扣（2026-10-23 实拍：14:5x 时 Qwen3.8-Max 行上
 *   什么都没有，而它的规则、文案、窗口在目录里全都齐）。卡片对 `pending` 画一枚
 *   降饱和的胶囊，悬停里写明几点生效——**说明「还没到点」，不是「正在打折」**。
 * - `none`：不画。三种情况：根本没有规则；声明了窗口但读不懂（`windowUnreadable`
 *   不能被当成全天，也不能说「几点生效」）；没有窗口而 `active` 为 false（常驻
 *   活动此刻没开，既没有窗口也没有「生效时间」可说，画出来只能是一句空话）。
 */
export type PromoDisplay = 'live' | 'pending' | 'none'

export function promoDisplayAt(promo: QoderPromotion | undefined, now: Date): PromoDisplay {
  if (promo === undefined) return 'none'
  if (promo.windowUnreadable === true) return 'none'
  if (promo.window === undefined) return promo.active ? 'live' : 'none'
  return promoWithinWindow(promo, now) ? 'live' : 'pending'
}

/**
 * 此刻是否成立（`promoDisplayAt(...) === 'live'`）。
 *
 * **有窗口时窗口说了算**（渲染时刻现算，快照多旧都不影响），没有窗口时才信上游的
 * `active`。为什么不是「两者都要成立」：目录是进程启动时取的一份内存快照，「从
 * Qoder 刷新」之外没有任何东西会换它。若把 `active` 也当成门，白天启动的进程会
 * 拿着 16:00 的 `active: false` 一直用到退出——22:00 窗口开了也不会画，等于这个
 * 功能对「一直开着 DSH」的用户完全不存在。反过来，窗口是「此刻」的纯函数，它不会
 * 因为快照旧而说错话。
 *
 * 判「画不画成实心」用它；判「要不要画成灰的」用 `promoDisplayAt`。两个函数必须
 * 保持同一套前提（窗口优先、读不懂不画），所以这里直接复用后者而不是重写一遍。
 */
export function promoLiveAt(promo: QoderPromotion | undefined, now: Date): promo is QoderPromotion {
  return promoDisplayAt(promo, now) === 'live'
}
