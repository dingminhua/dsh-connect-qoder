/**
 * 别家 provider 的行上那枚胶囊：**原样复现宿主的 fallback**。
 *
 * ## 为什么需要它
 *
 * `conversation.input.model.label` 是宿主的 **single 槽**：一个槽只容一个占位者，
 * 而赢家要替**所有** provider 的行画名字。宿主自己的 fallback（没有插件占槽时它
 * 会画的那个）从 0.2.2 起是「名字 + 该模型自带的 `model.badge`」；本插件占了槽，
 * 那句 fallback 就再也不会执行 —— 所以别家的胶囊只能由我们按同样的样子画出来。
 *
 * 这不是「插件联动」，也不读任何人的注册：`model.badge` 是**宿主目录**搬运的
 * 数据字段（`LlmModelInfo.badge` → 选择器的 `props.model.badge`），我们不知道也
 * 不关心是谁填的。规则见同族仓库 dsh-connect-workbuddy 的 `docs/MODEL-LABEL-SPEC.md` §4
 * （那个文件不在本仓库）。
 *
 * ## 两条硬要求
 *
 * 1. **顺序**：`placement === 'trigger'`（输入框旁，当前选中）时胶囊在**前**；
 *    `menu` / `option`（菜单行）时在**后**。顺序抄错不会报错，只会让同一个模型的
 *    名字在触发器和菜单里长得不一样。
 * 2. **纯函数、绝不抛。** 一个菜单可能同时有二十行别家的模型；这一支里不能发请求、
 *    读快照、起定时器。更要紧的是不能抛：本组件一旦抛错，宿主会把它从那一格**摘掉**
 *    （`entriesOfSlot` 跳过已退役的条目），整片模型标签换成别家或裸名字 —— 一枚
 *    没见过的 `badge` 形状不该有这个后果。所以任何读不懂的形状都退化成纯名字。
 *
 * ## 空串与缺语言
 *
 * 宿主自己的 `resolveText` 对空字符串**原样返回**（它只兜底缺失的键），所以
 * `{ en: '' }` 在宿主那边会画出一颗真空胶囊。这里比宿主**更严**：空串当「没有」
 * 处理，不画废话。翻译表缺 `en` 时同理（宿主那边那会解析成 `undefined`）。
 *
 * @module dsh-connect-qoder/client/host-badge
 */

import type { ReactElement } from 'react'
import { hostLanguage } from './promo-badge.ts'
import type { Translate } from './locales.ts'

/** 强调程度，逐字对齐宿主的 `LlmModelBadgeTone`。 */
export type HostBadgeTone = 'neutral' | 'info' | 'success' | 'warning'

/**
 * 宿主 0.2.2 起的 `model.badge`，**本地声明**。
 *
 * 不从 `@deepseek-ai/dsh-llm` import：本插件的 peer 范围仍从 `0.1.7-rc.1` 起，
 * 那一版的类型里没有这个字段（也没有这个类型），import 会让旧宿主上的 typecheck
 * 直接失败。形状只有两个字段，且它是宿主对外契约的一部分，写死是安全的。
 */
export interface HostModelBadge {
  text: string | Record<string, string>
  tone: HostBadgeTone
}

/**
 * 宿主那枚 `Tag` 的四档配色，逐条抄自 `Tag.module.css`（0.2.2-rc.1）。
 *
 * 两个最容易抄错的地方：`info` 用的是 `state-business-primary` 而**不是**
 * `brand-primary`；`warning` 用的是 `state-warn-primary` 而**不是**
 * `state-warn-secondary`。抄错了，同一行里两颗胶囊的颜色就对不上。
 *
 * 宿主那颗**没有描边**，所以这里也不加。
 */
const HOST_BADGE_TONES: Record<HostBadgeTone, { color: string, background: string }> = {
  neutral: {
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  info: {
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)',
  },
  success: {
    color: 'var(--dsw-alias-state-success-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
  },
  warning: {
    color: 'var(--dsw-alias-state-warn-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
  },
}

/** 认不出来的 tone 按 `neutral` 画：旧宿主与未来新增的 tone 都可能落到这一支。 */
export function hostBadgePaint(tone: HostBadgeTone): { color: string, background: string } {
  return HOST_BADGE_TONES[tone] ?? HOST_BADGE_TONES.neutral
}

/**
 * 胶囊上那一行字，取读者语言。
 *
 * 查找顺序与宿主的 `resolveText` 同规：当前语言 → 它的基语言（`de-DE` → `de`）
 * → `en`（宿主契约里的必填兜底）。空串与缺席等价：这是本插件加的判断，比宿主
 * 更严，目的只是不画一颗没有字的胶囊。
 *
 * @param text - 上游/别家写进 `badge.text` 的东西；读不懂就返回 `undefined`。
 * @param language - 界面语言（见 `hostLanguage`）。
 */
export function resolveHostBadgeText(text: unknown, language: string): string | undefined {
  if (typeof text === 'string') return text.trim() === '' ? undefined : text
  if (text === null || typeof text !== 'object' || Array.isArray(text)) return undefined
  const table = text as Record<string, unknown>
  const read = (key: string): string | undefined => {
    const value = table[key]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  const lower = language.toLowerCase()
  const base = lower.split('-')[0] ?? ''
  return read(lower) ?? (base === '' ? undefined : read(base)) ?? read('en')
}

/**
 * 这枚 `badge` 能不能画：能画就给出「格式化后的 badge + 那一行字」。
 *
 * 调用方要先知道「画不画」再决定**要不要那个分隔符**：`<Chip/>` 自己可能渲染成
 * `null`，而外面那个空格会留下，于是名字后面挂一个看不见的空白。
 *
 * `tone` 认不出来时按 `neutral` 画（`hostBadgePaint` 的兜底），**不抛、不留白**：
 * 旧宿主或未来新增的 tone 都可能落到这一支。
 */
export function drawableHostBadge(
  badge: unknown,
  language: string,
): { badge: HostModelBadge, label: string } | undefined {
  if (badge === null || typeof badge !== 'object' || Array.isArray(badge)) return undefined
  const candidate = badge as Partial<HostModelBadge>
  const label = resolveHostBadgeText(candidate.text, language)
  if (label === undefined) return undefined
  const tone = typeof candidate.tone === 'string' ? candidate.tone as HostBadgeTone : 'neutral'
  return { badge: { text: candidate.text as HostModelBadge['text'], tone }, label }
}

/** The chip itself, geometrically the host's `Tag` (`padding:1px 8px`, `999px`, 11px). */
export function HostBadgeChip(props: { badge: HostModelBadge, label: string }): ReactElement {
  const paint = hostBadgePaint(props.badge.tone)
  return (
    <span
      className="dsm-qoder-model-label-host-badge"
      style={{ color: paint.color, background: paint.background }}
    >
      {props.label}
    </span>
  )
}

/**
 * 一行别家 provider 的标签：名字 + （有的话）该模型自带的胶囊。
 *
 * `placement === 'trigger'` 时胶囊在前，`menu` / `option` 时在后 —— 这是宿主
 * fallback 的逐字顺序，也是**唯一**一件不能凭偏好决定的事。分隔符就是一个空格，
 * 不用 flex `gap`：宿主 fallback 里写的就是文本空格，两者在窄行里的换行行为不同。
 *
 * 读不到胶囊（没有 / 形状读不懂 / 文案为空）时返回纯名字：那是槽位契约的下限，
 * 也是宿主自己在没有 badge 时画的东西。`model.name` 一个字符都不改 —— 名字是稳定
 * 标识，胶囊是会变的东西，把易变的塞进稳定标识会污染悬停、读屏、搜索排序。
 */
export function ForeignModelLabel(props: {
  model: { name: string, badge?: unknown }
  placement: string
  t?: Translate | undefined
}): ReactElement {
  const { model, placement, t } = props
  const name = model.name
  const drawable = drawableHostBadge(model.badge, hostLanguage(t))
  if (drawable === undefined) return <span>{name}</span>
  const chip = <HostBadgeChip badge={drawable.badge} label={drawable.label} />
  return placement === 'trigger'
    ? <span>{chip} {name}</span>
    : <span>{name} {chip}</span>
}
