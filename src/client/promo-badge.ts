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

import type { QoderPromotion } from '../promo.ts'

/**
 * 界面语言，由浏览器报告。
 *
 * 卡片本来就用浏览器 locale 格式化日期与数字，上游文案读同一个信号才一致。
 * `navigator` 防御性读取：这个模块会被运行在纯 Node 环境的单测导入。
 */
export function uiLanguage(): string {
  return typeof navigator === 'undefined' ? '' : navigator.language
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
