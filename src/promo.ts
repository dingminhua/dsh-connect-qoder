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
 *    2026-10-21T16:2x（窗口 22:00–08:00 之外）两个区域全部 `active: false`，
 *    说明它是**按当前时刻算的**，不是常量。但它是**上游算的那一刻**——插件手里
 *    的目录是几秒到几分钟前的快照，所以还叠一道本地窗口校验：
 *    `active === true` **且**（有窗口时）此刻落在窗口内才画。窗口校验只做减法，
 *    不会把上游的 false 变成 true：迟到的 true 不会在早上继续挂着。
 * 3. 时段怎么算。`window_start` / `window_end` 是**上游声明时区里的墙钟时间**
 *    （`HH:MM`），且可以跨零点（22:00→08:00）。所以判定必须按那条记录的
 *    `timezone` 求当地分钟数，不能拿浏览器本地时间直接比——用户在 UTC+0 打开
 *    卡片时，「22:00–08:00」说的是 Asia/Shanghai 的 22:00，不是他的。
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
  /** 上游算好的「此刻生效」；缺席按 `false` 处理。 */
  active: boolean
  /** 上游自己的徽标文案。没有它就没有可画的东西，解析直接丢弃。 */
  badge: QoderPromoLabel
  /** 上游自己的悬停说明。 */
  description?: QoderPromoLabel
  /** 上游声明的时区（`Asia/Shanghai`）；缺席时按账号所在区域兜底。 */
  timeZone?: string
  /** 上游声明的每日时段；缺席表示没有窗口声明。 */
  window?: QoderPromoWindow
  /** 折扣系数（`0.4` = 4 折）。只用于说明，不从它反推文案。 */
  discountFactor?: number
  /** 活动前的倍率（`before_promotion_price_factor`）。 */
  beforePriceFactor?: number
  /** 上游的规则 id（`idle_time_model_credit_discount`）。 */
  ruleId?: string
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
 * 只接受 0–23 时、0–59 分。越界的值当作**没有窗口**而不是「全天」：一份读不懂的
 * 窗口声明不该被解释成任何一个方向（画与不画都是替上游下结论）。
 */
export function clockMinute(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 解析上游的时段；两端都读得懂才算有窗口。 */
export function parsePromoWindow(startRaw: unknown, endRaw: unknown): QoderPromoWindow | undefined {
  const start = text(startRaw)
  const end = text(endRaw)
  if (start === undefined || end === undefined) return undefined
  const startMinute = clockMinute(start)
  const endMinute = clockMinute(end)
  if (startMinute === undefined || endMinute === undefined) return undefined
  return { start, end, startMinute, endMinute }
}

/**
 * 解析上游的 `promotion` 对象。
 *
 * 丢弃的判据很干脆：没有 `badge.zh` 也没有 `badge.en` 的条目一律不要——那意味着
 * 上游没有给出可显示的话，插件没有可画的东西（也不该自己编）。`active` / 规则
 * 字段缺失时下沉为「不画」，但条目本身仍保留，好让悬停能说明它为什么没画。
 *
 * 实测形状（`qmodel_38max`，截断）：
 * ```json
 * { "active": false, "rule_id": "idle_time_model_credit_discount",
 *   "discount_factor": 0.4, "before_promotion_price_factor": 0.5,
 *   "badge": { "zh": "错峰 4 折", "en": "Off-Peak 60% off" },
 *   "timezone": "Asia/Shanghai", "window_start": "22:00", "window_end": "08:00",
 *   "link_url": { "zh": "https://docs.qoder.cn/..." }, "description": { "zh": "..." } }
 * ```
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
  const discountFactor = number(raw['discount_factor'])
  const beforePriceFactor = number(raw['before_promotion_price_factor'])
  const ruleId = text(raw['rule_id'])
  return {
    active: raw['active'] === true,
    badge,
    ...description === undefined ? {} : { description },
    ...link === undefined ? {} : { link },
    ...timeZone === undefined ? {} : { timeZone },
    ...window === undefined ? {} : { window },
    ...discountFactor === undefined ? {} : { discountFactor },
    ...beforePriceFactor === undefined ? {} : { beforePriceFactor },
    ...ruleId === undefined ? {} : { ruleId },
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
    if (
      start !== undefined && end !== undefined
      && startMinute !== undefined && endMinute !== undefined
      && clockMinute(start) === startMinute && clockMinute(end) === endMinute
    ) {
      promo.window = { start, end, startMinute, endMinute }
    }
  }
  const discountFactor = number(raw['discountFactor'])
  if (discountFactor !== undefined) promo.discountFactor = discountFactor
  const beforePriceFactor = number(raw['beforePriceFactor'])
  if (beforePriceFactor !== undefined) promo.beforePriceFactor = beforePriceFactor
  const ruleId = text(raw['ruleId'])
  if (ruleId !== undefined) promo.ruleId = ruleId
  return promo
}

// ---------------------------------------------------------------------------
// 判定：此刻是否成立
// ---------------------------------------------------------------------------

/** 上游没给时区时的兜底（国内区域的窗口就是按它写的）。 */
export const QODER_PROMO_DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/**
 * 某一时刻在指定时区里的当天分钟数与 ISO 星期。
 *
 * 只用来把「上游声明的墙钟时间」和「此刻」放到同一个坐标系里。时区名读不懂时
 * 返回 `undefined`，由调用方决定回落——**不静默退回浏览器本地时间**：那会让
 * 一个跨零点窗口在别的时区悄悄错位 8 小时。
 *
 * `hourCycle: 'h23'` 是刻意的：部分引擎在 `hour12: false` 下会把午夜报成 24，
 * 那会让「22:00–08:00」在 00:00 判定失败。
 */
export function zonedClock(now: Date, timeZone: string): { isoWeekday: number, minutes: number } | undefined {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
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
  const weekday = read('weekday')
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const isoWeekday = order.indexOf(weekday ?? '') === -1 ? 1 : order.indexOf(weekday ?? '') === 0 ? 7 : order.indexOf(weekday ?? '')
  // 分钟归一化物理上不会发生（h23 已把 24 折成 0），保留取模只是兜底。
  return { isoWeekday, minutes: (hour % 24) * 60 + minute }
}

/**
 * 此刻是否落在该规则的时段内。
 *
 * 语义与 Qoder 自己的描述一致（「10 PM-8 AM UTC+8」）：
 * - **起点含、终点不含**：22:00 已生效，08:00 已失效。
 * - **跨零点**：`start > end` 时命中区间是 `[start, 24:00) ∪ [0, end)`。
 * - `start === end` 视为**全天**：上游写「22:00–22:00」只可能是这个意思（与
 *   Trae 那边 `start===end` 的取舍一致）。
 * - 没有窗口声明时返回 `true`——此时唯一的依据是上游的 `active`。
 */
export function promoWithinWindow(promo: QoderPromotion, now: Date): boolean {
  const window = promo.window
  if (window === undefined) return true
  const clock = zonedClock(now, promo.timeZone ?? QODER_PROMO_DEFAULT_TIME_ZONE)
  if (clock === undefined) return true
  const { startMinute, endMinute } = window
  if (startMinute === endMinute) return true
  if (startMinute < endMinute) return clock.minutes >= startMinute && clock.minutes < endMinute
  return clock.minutes >= startMinute || clock.minutes < endMinute
}

/**
 * 此刻是否该画这枚徽标。
 *
 * **两道门都必须过**：上游的 `active`（服务端按它的时钟算的）与本地的窗口校验
 * （按上游声明的时区算的）。为什么不是二选一，见模块头注释第 2 点——`active`
 * 是快照里的过去时，窗口是随手可算的现在时；只有两者都说「成立」才画，任何一边
 * 说「不成立」都不画。
 */
export function promoLiveAt(promo: QoderPromotion | undefined, now: Date): promo is QoderPromotion {
  if (promo === undefined) return false
  if (!promo.active) return false
  return promoWithinWindow(promo, now)
}
