/**
 * 上游活动徽标，在卡片上的那一半：挑文案、拼悬停。
 *
 * 判定「此刻成不成立」不在这里（那是 Host 的 `promoLiveAt`，卡片只拿到已经
 * 过筛的规则），这里只做两件纯显示的事：
 *
 * 1. **说什么**——上游自己的话。`badge.zh` / `badge.en` 原样上胶囊，中文界面
 *    优先 `zh`，英文界面优先 `en`；两边都只在上游真的给了其中一边时回落。
 *    插件不翻译、不改写、不补「限时」这类上游没说的词（Trae 那边只发数字，才
 *    不得不自己造词；Qoder 不需要）。
 * 2. **悬停里说什么**——上游的描述、它的时段（含上游声明的时区）、它的说明页。
 *    时区必须写出来：「22:00–08:00」离开时区就没有意义，而这段窗口是上游按
 *    Asia/Shanghai / Asia/Singapore 写的，不是用户本地的。
 *
 * @module dsh-connect-qoder/client/promo-badge
 */

import type { Translate } from './locales.ts'
import type { QoderPromotion } from '../promo.ts'
import type { MultiplierSource } from '../promo.ts'
import { displayMultiplierOf } from '../promo.ts'

/**
 * 界面语言，由浏览器报告。
 *
 * 只在拿不到宿主语言时当兜底（见 `hostLanguage`）。`navigator` 防御性读取：这个
 * 模块会被运行在纯 Node 环境的单测导入。
 */
export function uiLanguage(): string {
  return typeof navigator === 'undefined' ? '' : navigator.language
}

/**
 * 卡片按哪一种语言选上游文案。
 *
 * **宿主的界面语言优先**：DSH 允许在设置里切换界面语言，而浏览器语言不会跟着变，
 * 只看 `navigator.language` 会出现「中文界面配英文胶囊」。宿主绑定好的 `t` 是唯一
 * 我们能读到的语言信号（它按当前语言解析），所以用一条只给机器读的字典项
 * （`promo.locale`）把语言名问出来；读不到（未绑定 / 单测里的直通 `t`）才退回浏览器。
 */
export function hostLanguage(t: Translate | undefined): string {
  const marker = t?.('promo.locale')
  // `t` 在缺键时通常回显键名本身，那不算「知道语言」。
  if (marker === undefined || marker === '' || marker === 'promo.locale') return uiLanguage()
  return marker
}

/** 该语言是否属于英语。 */
function isEnglish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('en')
}

/**
 * 胶囊上的文案。
 *
 * 中文界面优先上游的 `zh`，英文界面优先 `en`；缺哪边就用另一边——上游两个区域
 * 都同时发中英，但字段可能只写了一半（国内 `qmodel` 的 `zh` 是「错峰4折」而
 * 国际同一行写「错峰 4 折」，空格也不一样，都是上游的写法，一律原样）。
 */
export function promoBadgeLabel(promo: QoderPromotion, language?: string): string | undefined {
  const { zh, en } = promo.badge
  return isEnglish(language) ? (en ?? zh) : (zh ?? en)
}

/** 双语字段按界面语言取一侧。 */
function pick(copy: { zh?: string, en?: string } | undefined, language: string | undefined): string | undefined {
  if (copy === undefined) return undefined
  return isEnglish(language) ? (copy.en ?? copy.zh) : (copy.zh ?? copy.en)
}

/**
 * 胶囊的悬停：上游的描述、活动时段（含时区）、上游的说明页。
 *
 * 空项直接略去，而不是渲染空分隔符——只发了一个 `badge` 的规则就只有一个悬停
 * 标题，不会拖一串 `· ·`。
 */
export function promoBadgeTooltip(promo: QoderPromotion, language?: string): string {
  const parts: string[] = []
  const description = pick(promo.description, language)
  if (description !== undefined) parts.push(description)
  const window = promo.window
  if (window !== undefined) {
    const zone = promo.timeZone
    const hours = zone === undefined ? `${window.start}–${window.end}` : `${window.start}–${window.end} (${zone})`
    parts.push(hours)
  }
  const link = pick(promo.link, language)
  if (link !== undefined) parts.push(link)
  return parts.join(' · ')
}

/**
 * 倍率标签的悬停（issue #41）：显示的是活动实际价时，补一句「这是活动价，
 * 基准价是 N.NN」，避免用户拿它去和别处（或下个月的账单）对不上而误以为出错。
 *
 * 只有显示倍率与基准价**不同**时才给提示；相同（没有折扣、窗口外、不采信折扣）
 * 时返回 `undefined`，调用方不挂 title——没有差异就不必解释。
 *
 * 这句是插件自己写的解释，不是上游的话：上游 `promotion` 只给折扣数字，没给
 * 「基准价是多少」的文案，而用户需要知道屏幕上那个 0 是活动价（与「免费」徽标
 * 的判据解释 `row.modelFreeHint` 同一类用法）。
 *
 * @param source - 该模型的基准价与活动规则。
 * @param now - 与显示倍率同一个渲染时刻，保证「显示值」与「提示里的基准价」同源。
 * @param t - 当前界面的翻译函数。
 */
export function rateHint(
  source: MultiplierSource,
  now: Date,
  t: Translate | undefined,
): string | undefined {
  const shown = displayMultiplierOf(source, now)
  if (shown === source.priceFactor) return undefined
  const key: 'row.ratePromoHint' = 'row.ratePromoHint'
  // `t` 在单测里可能是直通 key 的假翻译器，这里也只要求它填 {base}。
  const template = t?.(key, { base: source.priceFactor.toFixed(2) }) ?? key
  return template === key
    ? `Base rate x${source.priceFactor.toFixed(2)} during this promotion`
    : template
}
