/**
 * 模型选择器里的胶囊：**一个模型一行，只说一件事**。
 *
 * 为什么要有这个模块（而不是把促销画在标签组件里就完事）：
 * `conversation.input.model.label` 是宿主的 **single 槽**——全仓只有一个占位者渲染，
 * 它要替**所有** provider 的行画名字。于是本插件自己的行能不能带上胶囊，取决于
 * 「谁赢了那个槽」；而同族插件的标签不会替我们画促销，它们只复现宿主目录里的
 * `props.model.badge`（见 dsh-connect-workbuddy 的 `docs/MODEL-LABEL-SPEC.md`）。
 *
 * 所以胶囊必须走**数据**那条路：
 *
 * ```
 * 这里的 modelBadgeOf()          ← 唯一需要本插件写的判定
 *   → adapter.listModels() 的 spread ← `LlmModelInfo.badge`（宿主 0.2.2 起）
 *     → 宿主的模型目录
 *       → 赢家的组件读 props.model.badge 并原样画出来
 * ```
 *
 * 这条路与「谁赢了槽」无关：赢了画得更多，输了也还有这枚胶囊。
 *
 * ## 说什么
 *
 * 只放**此刻成立的促销**（`promoDisplayAt(...) === 'live'`），文案用上游自己的
 * `badge.zh` / `badge.en`，一个字符都不改（理由见 `src/client/promo-badge.ts`：胶囊只说
 * 上游的话，不翻译、不补词、不从 `discount_factor` 反推「4 折」）。
 *
 * 为什么**不**放「免费」：免费模型的名字里已经带着倍率（`Qwen3.8-Flash · x0.00`），
 * 再挂一枚「免费」胶囊是把同一句话说两遍；而促销在名字里完全看不出来。
 *
 * 为什么**不**放 `pending`（窗口还没到）：宿主只会按 tone 上色，没有「虚线灰显」
 * 这一档，画出来就是一句假的「正在打折」。未生效这件事由卡片与本插件自己的标签
 * 组件说（它们能同时换颜色、底色与描边形状），不交给一枚只有四个 tone 的胶囊。
 *
 * ## 文案长度
 *
 * 上限 **16 个 grapheme**，超了**整枚不画**（不截断、不加省略号）。
 *
 * 宿主对自家目录的建议上限是 12（同族 dsh-connect-workbuddy 的
 * `docs/MODEL-LABEL-SPEC.md`「文本与类型规则」），
 * 换成 16 是本插件的一个明示偏离：上游国内区英文原文 `Off-Peak 60% off` 正好是
 * 16 个 grapheme，按 12 截会把它截成半个词（`Off-Peak 60`），截断后的文案比不画
 * 更容易被误读成一个完整结论。所以这里的选择是：**完整的 16 以内就画，超出就
 * 什么都不画**——宁缺勿错。
 *
 * 判定按 **grapheme** 数，不按 `length`：`'🚦'.length === 2`、
 * `'👨‍👩‍👧'.length === 8`，用 `Intl.Segmenter` 数才是用户看到的字数。
 *
 * ## 为什么类型是本地声明的
 *
 * 本插件的 peer 范围仍从 `0.1.7-rc.1` 起，那一版的 `LlmModelInfo` **没有** `badge`
 * 字段。import 宿主类型会让 0.1.x 上的 typecheck 失败，而「展开一个变量」不受
 * 对象字面量的多余属性检查约束——所以形状在这里写死，`listModels()` 用展开写法，
 * 同一份代码在 0.1.x 与 0.2.x 上都能编译。旧宿主会静默丢掉这个字段（不报错、
 * 不崩），两个方向都自然退化成「今天的样子」。
 *
 * @module dsh-connect-qoder/model-badge
 */

import { promoDisplayAt } from './promo.ts'
import type { QoderModelInfo } from './catalog.ts'

/** 强调程度，逐字对齐宿主的 `LlmModelBadgeTone`。 */
export type QoderModelBadgeTone = 'neutral' | 'info' | 'success' | 'warning'

/**
 * 一张翻译表：**`en` 必填**。
 *
 * 宿主的 `resolveText` 把 `text.en` 当兜底值（`fallbackChain(...).reduceRight(...,
 * text.en)`），缺了它，任何没命中的语言都会得到 `undefined`——界面上就是一颗
 * 没有字的空胶囊。所以这个形状里 `en` 不是可选的。
 */
export interface QoderModelBadgeText {
  en: string
  [locale: string]: string
}

/** 宿主 0.2.2 起的 `LlmModelInfo.badge`，本地声明（理由见文件头）。 */
export interface QoderModelBadge {
  text: string | QoderModelBadgeText
  tone: QoderModelBadgeTone
}

/**
 * 文案上限（grapheme）。**偏离宿主的 12，见文件头「文案长度」**。
 *
 * 16 不是随手取的：它是上游国内区英文原文 `Off-Peak 60% off` 的 grapheme 数，
 * 也就是「不截断、不编词」这条底线能容下的最小整数。
 */
export const MODEL_BADGE_MAX_GRAPHEMES = 16

/** `Intl.Segmenter` 在 Node 16+ 与全部现代浏览器里都有；缺席时退回码点数。 */
const segmenter: Intl.Segmenter | undefined = typeof Intl !== 'undefined'
  && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

/**
 * 用户看到的字数。
 *
 * 缺席 `Intl.Segmenter` 时退回码点数：那对纯中文与纯 ASCII 是同一个答案，只对
 * emoji / 组合字符偏大——偏大只会让「超出上限」更容易触发，方向是安全的。
 */
export function badgeGraphemeCount(text: string): number {
  if (segmenter === undefined) return [...text].length
  let count = 0
  for (const _segment of segmenter.segment(text)) count += 1
  return count
}

/**
 * 上游文案 → 胶囊文案。
 *
 * 三种形状，全部来自上游那一行 `promotion.badge`：
 *
 * - 中英都有且不同 → 翻译表 `{ en, zh }`。**这是常态**：宿主的 `resolveText` 按
 *   读者语言取，中文界面得到「错峰 4 折」，英文界面得到 `Off-Peak 60% off`。
 *   在宿主进程里读不到浏览器语言，所以两种都发，由宿主挑。
 * - 只有一种（或中英恰好一致）→ 字面量。上游只给了一种，就只画那一种，不用
 *   另一种去猜——那会变成「插件替上游说话」。
 * - 都没有 → `undefined`。解析层（`src/promo.ts`）本来就会丢弃没有文案的规则，
 *   这里再挡一次是为了不画出空胶囊。
 */
export function modelBadgeText(promo: { badge: { zh?: string, en?: string } }): string | QoderModelBadgeText | undefined {
  // 空白的条目当「没有」：`{ en: '' }` 在宿主那边会画出一颗**真的空胶囊**
  // （它的 `resolveText` 只兜底缺失的键，不过滤空值）。这里先剔掉，再决定发什么。
  const clean = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value
  const zh = clean(promo.badge.zh)
  const en = clean(promo.badge.en)
  if (en !== undefined && zh !== undefined && en !== zh) return { en, zh }
  const single = en ?? zh
  return single === undefined ? undefined : single
}

/** 发布出去的每一条文案都在上限之内吗？（任何一条超了都算超） */
function withinLimit(text: string | QoderModelBadgeText): boolean {
  const entries = typeof text === 'string' ? [text] : Object.values(text)
  return entries.every(entry => entry.trim() !== '' && badgeGraphemeCount(entry) <= MODEL_BADGE_MAX_GRAPHEMES)
}

/**
 * 这一行此刻该挂的胶囊；`undefined` 表示什么都不挂。
 *
 * 判定读的是**渲染/列目录那一刻**的时钟，而不是解析目录时的时钟：窗口是上游声明的
 * 墙钟时段，按那一刻重算才不会因为快照旧而说错话（`src/promo.ts` 里那条取舍，
 * 与卡片、与标签组件是同一个判据）。
 *
 * 一个已知边界（写下来，免得被当成 bug 重新查一遍）：`badge` 是**目录数据**，宿主
 * 只在重建目录时读一次 `listModels()`。所以窗口关掉之后，这枚胶囊会挂到下一次
 * 目录刷新为止。要做到分钟级准确，得在每次窗口翻面时发 `llm/models-updated`，
 * 而宿主收到它会对**每个模型**调一次 `resolveModelInfo()`——为了一枚胶囊让整份
 * 目录重解析，代价不成比例。宁可在自己的行上由组件按分钟重算（那里已经在做了）。
 *
 * @param info - 该模型在目录里的那一行；缺席（id 对不上）时不画。
 * @param now - 判定用的时刻。
 */
export function modelBadgeOf(info: QoderModelInfo | undefined, now: Date): QoderModelBadge | undefined {
  if (info === undefined) return undefined
  const promo = info.promotion
  if (promo === undefined) return undefined
  if (promoDisplayAt(promo, now) !== 'live') return undefined
  const text = modelBadgeText(promo)
  if (text === undefined || !withinLimit(text)) return undefined
  // `success` 而不是 `info`：宿主对 tone 的定义是「`success` 标记优惠」，
  // 而这枚胶囊说的正是「此刻这项优惠成立」。Qoder 的活动字段里没有颜色
  // （对比 workbuddy 的 `badge.color`），所以不存在「按上游颜色映射」这一步。
  return { text, tone: 'success' }
}
