/**
 * Qoder 模型目录：静态 fallback + 动态目录解析 + 勾选派生。
 *
 * 模型字段来自官方 SDK 的 ModelInfo（camelCase DTO）与服务端 snake_case
 * 原样的对照；积分倍率 `price_factor` 即模型名内嵌的 `· xN.NN` 来源。
 *
 * @module dsh-connect-qoder/catalog
 */

import type { QoderUpstreamModel } from './upstream.ts'
import { parseQoderPromotion, type QoderPromotion } from './promo.ts'
import { isRouterModelId } from './native-modality.ts'

// ---------------------------------------------------------------------------
// 静态 fallback 目录（网关不可达时保底，来自 qoder2api models.py + 官方目录）
// ---------------------------------------------------------------------------

export interface QoderFallbackModel {
  key: string
  displayName: string
  isVl: boolean
  isReasoning: boolean
  priceFactor?: number
  maxInputTokens?: number
  maxOutputTokens?: number
}

export const QODER_FALLBACK_MODELS: QoderFallbackModel[] = [
  { key: 'qmodel_latest', displayName: 'Qwen3.7-Max', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'qmodel_preview', displayName: 'Qwen3.8-Max-Preview', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'qmodel', displayName: 'Qwen3.7-Plus', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'q36fmodel', displayName: 'Qwen3.6-Flash', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'dmodel', displayName: 'DeepSeek-V4-Pro', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'dfmodel', displayName: 'DeepSeek-V4-Flash', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'gm51model', displayName: 'GLM-5.2', isVl: true, isReasoning: true, maxInputTokens: 200_000 },
  { key: 'kmodel', displayName: 'Kimi-K2.7-Code', isVl: true, isReasoning: true, maxInputTokens: 256_000 },
  { key: 'mmodel', displayName: 'MiniMax-M2.7', isVl: false, isReasoning: true, maxInputTokens: 200_000 },
]

// ---------------------------------------------------------------------------
// 模型信息（DSH 侧）
// ---------------------------------------------------------------------------

export interface QoderModelInfo {
  key: string
  displayName: string
  /** 积分倍率（模型名内嵌 `· xN.NN`）。 */
  priceFactor: number
  /** 原生输入窗口（由 context_config 首档或 max_input_tokens 决定）。 */
  contextWindow: number
  maxOutputTokens: number
  supportsImages: boolean
  supportsThinking: boolean
  /** 可完全关闭思考（thinking_config.disabled 存在）。 */
  canDisableThinking: boolean
  /**
   * 上游声明的思考强度档位（`thinking_config.enabled.efforts` 的键，按强度
   * 升序）。不存在时该模型没有可选档位，卡片不渲染这一项。
   *
   * 实测 Qoder 的档位名不统一：Qwen 系用 `low / medium / xhigh`，DeepSeek/GLM
   * 用 `low / high / max`——所以只做展示，不做跨模型比较。上游给出的键序也不
   * 可靠（JSON 里可能先出现 `xhigh`），必须按语义排序后再显示。
   */
  thinkingEfforts?: string[]
  /** 上游标为默认的档位（`efforts[x].is_default`）。 */
  defaultThinkingEffort?: string
  isDefault: boolean
  isFree: boolean
  isNew: boolean
  /**
   * 网关声明可用的上下文档位（`context_config` 各项的 token_count，升序）。
   * 不存在时无档位可选，卡片不渲染预算选择器。
   */
  contextTiers?: number[]
  /**
   * 上游的活动优惠规则（`model/list` 每行的 `promotion`）。
   *
   * 这里存的是**解析后**的规则（`src/promo.ts` 的 `QoderPromotion`），不是上游的
   * snake_case 原文：落盘、投影、卡片三处只认一种形状，读回时用 `readPromotion`
   * 校验，不会出现两套解析各自漂移。
   *
   * 缺席 = 上游没给活动（或给的活动没有可显示的文案）。**不要**从
   * `price_factor` 反推活动——倍率是基础价，活动是另一层，混起来会画出上游没
   * 说的折扣。
   */
  promotion?: QoderPromotion
}

/** 默认上下文预算（模型未声明任何档位时）。 */
export const QODER_DEFAULT_CONTEXT = 200_000

/** 从 context_config 档位表提取升序 token 档位（无档位返回 undefined）。 */
export function contextTiersOf(raw: QoderUpstreamModel): number[] | undefined {
  const cc = raw.context_config
  if (!cc) return undefined
  const counts = Object.values(cc).map(v => v.token_count).filter(Number.isFinite)
  if (counts.length === 0) return undefined
  return [...new Set(counts)].sort((a, b) => a - b)
}

/**
 * 档位改写表：上游声明的 400K 档一律按 **500K** 呈现与保存（用户要求，2026-10-24）。
 *
 * 为什么改在解析边界：档位表只有一个写点（`parseUpstreamModel`）与一个存档读点
 * （`modelFromStored`），在这里改写，卡片下拉、usage 投影、落盘往返、运行期预算
 * 四处拿到的就是同一份改写后的表——在渲染层改只会让「下拉里的选项」与「保存后
 * 生效的窗口」重新变成两张表。上游哪天真的改口发 500K，这张表变成恒等映射，
 * 不需要再动任何读点。
 *
 * 档位是**插件本地的上下文预算**（聊天请求体里没有任何上下文字段，实测
 * `createChatBodyTemplate`），所以改写只影响 DSH 侧的预算选择与显示，不替上游
 * 承诺它没声明的窗口。
 */
export const QODER_CONTEXT_TIER_OVERRIDES: ReadonlyMap<number, number> = new Map([
  [400_000, 500_000],
])

/** 单个档位值过改写表；表里没有的原样返回。 */
export function mapContextTier(value: number): number {
  return QODER_CONTEXT_TIER_OVERRIDES.get(value) ?? value
}

/** 整张档位表过改写表（去重 + 升序，防止上游同时声明 400K 与 500K 时出现重项）。 */
export function mapContextTiers(tiers: readonly number[]): number[] {
  return [...new Set(tiers.map(mapContextTier))].sort((a, b) => a - b)
}

/**
 * 已保存的预算过改写表：旧存档里的 400K 选择读回时就是 500K。
 *
 * 不做这一步，升级前勾了 400K 的人会在下拉里看到一个「不在选项里的选中值」——
 * `<select>` 的 value 命中不了任何 option，界面只会显示成空白或第一项，比没迁移
 * 更糟。
 */
export function migrateContextBudgets(budgets: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(budgets)) out[key] = mapContextTier(value)
  return out
}

/** 强度语义排序用的序表（`max` 与 `xhigh` 同属"最强"档，都排最后）。 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 从 `thinking_config` 提取可选档位。
 *
 * 实测形状（qmodel_38max）：
 *   `{ disabled: {}, enabled: { is_default: true,
 *      efforts: { xhigh: {}, low: {}, medium: { is_default: true } } } }`
 *
 * 两个要点：
 * - **键序不可信**：上游给的顺序是 `xhigh, low, medium`，直接显示会让用户
 *   以为 xhigh 是最弱档。按语义序表排。
 * - **不是每个模型都有档位**：`qmodel_latest`、`mmodel` 等 `efforts` 缺失，
 *   此时返回空对象（字段缺席），卡片据此不渲染这一项——而不是渲染一个空标签。
 *   （这一条也是 `auto` 曾经最难解释的地方：它是唯一天生没有档位、却常被当作
 *   默认模型勾上的条目；现在它按路由器被整个丢掉了。）
 */
export function thinkingOf(config: Record<string, unknown> | undefined): {
  thinkingEfforts?: string[]
  defaultThinkingEffort?: string
} {
  const enabled = config?.['enabled']
  if (enabled === null || enabled === undefined || typeof enabled !== 'object') return {}
  const efforts = (enabled as Record<string, unknown>)['efforts']
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) return {}
  const names = Object.keys(efforts as Record<string, unknown>)
  if (names.length === 0) return {}
  const sorted = [...names].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a)
    const ib = EFFORT_ORDER.indexOf(b)
    // 序表外的档位名排在已知档之后，再按字典序，保证顺序稳定。
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  const declared = sorted.find(name => {
    const entry = (efforts as Record<string, unknown>)[name]
    return entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>)['is_default'] === true
  })
  return {
    thinkingEfforts: sorted,
    ...(declared === undefined ? {} : { defaultThinkingEffort: declared }),
  }
}

/**
 * 该条目**是否支持思考**：上游的 `thinking_config` 说了算，`is_reasoning` 只作
 * 补充。任一为真即成立。
 *
 * 为什么不能只看 `is_reasoning`（issue #1「不能调节推理等级」的根因）：实测两个
 * 区域的 `model/list` 里 `is_reasoning` 与 `thinking_config` **自相矛盾**，而且
 * 同一个模型换个区域就翻转 ——
 *
 * | 区域   | key             | `is_reasoning` | `efforts`          |
 * | ------ | --------------- | -------------- | ------------------ |
 * | cn     | `dfmodel`       | false          | low / high / max   |
 * | cn     | `kmodel_latest` | false          | low / high / max   |
 * | global | `performance`   | false          | low / medium / high / xhigh / max |
 * | global | `kmodel_latest` | false          | low / high / max   |
 * | global | `kmodel`        | false          | low / high / max   |
 *
 * 还有 `dfmodel`（cn false / global true）、`qmodel`、`qmodel_latest`、`auto`
 * （cn true / global false）—— 同一模型两边声明相反，说明 `is_reasoning` 是上游
 * 侧的配置漂移，不是模型能力。而 `thinking_config` 给全了默认档、逐档
 * `is_default` 与 `disabled` 描述，是一份**完整**的推理配置；它声明了档位，就
 * 一定支持强度选择。采信 `is_reasoning:false` 的结果就是这些模型在 DSH 里连
 * 思考强度控件都不渲染（用户实拍）。
 *
 * 方向的偏置是刻意的：只把 false 补成 true，**绝不**把 true 降成 false（实测
 * 29 条目录中 5 条改变，24 条不动，0 条反向回退）。`efforts` 缺失的条目
 * （`auto`、`efficient`、`qmodel` 等）保持 `is_reasoning` 原值，不会被误开。
 *
 * 上面表与下面这段是**实测记录**，保留了观测当时的原名（含 `auto`）。其中 `auto`
 * 现在已按路由器被整个丢掉（见 `ROUTER_MODEL_IDS`），到不了这个函数；但记录不改：
 * 它证明的是「`is_reasoning` 与 `thinking_config` 会互相矛盾」这件事，抹掉它反而
 * 让这张表看起来比当时的证据更干净。
 */
export function supportsThinkingOf(raw: QoderUpstreamModel): boolean {
  if (raw.is_reasoning) return true
  return thinkingOf(raw.thinking_config).thinkingEfforts !== undefined
}

/**
 * 该条目**能否关闭思考**：`thinking_config.disabled` 存在，或它被声明为推理
 * 模型——此时「不能关」是一句反事实的断言，不采信（同一处数据漂移的另一面）。
 *
 * 上游真正做不到时，用户勾选后的一次请求会失败并被如实报出；而按 `is_reasoning`
 * 藏起一个本可用的 off 档，代价是用户**永远**没有这个选项（与
 * `src/off-thinking.ts` 的取舍方向一致：宁可多提供，因为它可撤回）。
 *
 * 注意顺序：这里用的是**修正后**的 `supportsThinking`，所以像 global 的
 * `qmodel` / `qmodel_latest` / `kmodel` 这类「`disabled` 有、`efforts` 没有」
 * 的条目也能拿到 off 档。
 */
export function canDisableThinkingOf(raw: QoderUpstreamModel, supportsThinking: boolean): boolean {
  return raw.thinking_config?.disabled !== undefined || supportsThinking
}

/** 把上游 snake_case 条目解析成 DSH 侧模型信息。 */
export function parseUpstreamModel(raw: QoderUpstreamModel): QoderModelInfo {
  // 默认档与档位表都过改写表（400K→500K）：只改表不改默认档，会出现「选中值不在
  // 选项里」的下拉（`<select>` 的 value 命中不了任何 option）。
  const contextWindow = mapContextTier(pickDefaultContextWindow(raw) ?? raw.max_input_tokens ?? QODER_DEFAULT_CONTEXT)
  const tiers = contextTiersOf(raw)
  const reasoning = thinkingOf(raw.thinking_config)
  const supportsThinking = supportsThinkingOf(raw)
  const promotion = parseQoderPromotion(raw.raw['promotion'])
  return {
    key: raw.key,
    displayName: raw.display_name,
    priceFactor: raw.price_factor ?? 1,
    contextWindow,
    maxOutputTokens: raw.max_output_tokens ?? 32_768,
    supportsImages: raw.is_vl,
    // 两项都按 `thinking_config` 判，不单看 `is_reasoning`（见上两处注释与
    // issue #1）。旧写法 `canDisableThinking: canDisable || raw.is_reasoning === false`
    // 会把**所有**非推理模型都标成可关闭思考，卡片上就是一堆打不开的勾选。
    supportsThinking,
    canDisableThinking: canDisableThinkingOf(raw, supportsThinking),
    ...reasoning,
    isDefault: raw.is_default,
    isFree: raw.is_free === true,
    isNew: false,
    ...tiersField(tiers === undefined ? undefined : mapContextTiers(tiers)),
    ...promotion === undefined ? {} : { promotion },
  }
}

/** 从 context_config 档位表选默认档（is_default=true，否则取 token_count 最小者）。 */
export function pickDefaultContextWindow(raw: QoderUpstreamModel): number | undefined {
  const cc = raw.context_config
  if (!cc) return undefined
  const entries = Object.entries(cc)
  if (entries.length === 0) return undefined
  const def = entries.find(([, v]) => v.is_default === true)
  if (def) return def[1].token_count
  return Math.min(...entries.map(([, v]) => v.token_count))
}

/** `contextTiers` 的可选字段投影（undefined 时略去字段，避免写入 undefined）。 */
function tiersField(tiers: number[] | undefined): { contextTiers?: number[] } {
  return tiers === undefined || tiers.length <= 1 ? {} : { contextTiers: tiers }
}

/** 把 fallback 条目解析成模型信息。 */
export function fallbackModelInfo(m: QoderFallbackModel): QoderModelInfo {
  return {
    key: m.key,
    displayName: m.displayName,
    priceFactor: m.priceFactor ?? 1,
    contextWindow: m.maxInputTokens ?? QODER_DEFAULT_CONTEXT,
    maxOutputTokens: m.maxOutputTokens ?? 32_768,
    supportsImages: m.isVl,
    supportsThinking: m.isReasoning,
    canDisableThinking: true,
    isDefault: false,
    isFree: false,
    isNew: false,
  }
}

/**
 * 应用用户保存的每模型上下文档位。
 *
 * Qoder 的窗口是**档位选择**而非任意上限：一模型说得出几个 `context_config`
 * 档，用户保存的预算就只能在档位里挑（选了不在档位里的值没有效果，保持原生）。
 * 这样卡片渲染的 `<select>` 选项与运行期生效的窗口永远一致 —— 不会出现存档里
 * 存了 200K 而该模型根本没这个档的时候，运行期悄悄用别的东西。
 *
 * `contextWindow` 不降反升的情形只可能发生在档位表的**原生档**高于默认窗口时
 * （例如默认档 96K、另有一档 400K），此时按档位选择是诚实的用户决定。
 */
export function applyContextBudgets(
  catalog: readonly QoderModelInfo[],
  budgets: Readonly<Record<string, number | undefined>> = {},
): QoderModelInfo[] {
  return catalog.map(model => {
    const chosen = budgets[model.key]
    if (model.contextTiers === undefined || chosen === undefined) return model
    return model.contextTiers.includes(chosen) ? { ...model, contextWindow: chosen } : model
  })
}

/**
 * 模型显示名：内嵌积分倍率（与 Qoder 自身菜单格式一致——倍率为 1 也照写，
 * `Qwen3.7-Max · x1.00`）。workbuddy 的选择器同名规则同样不省略 1。
 */
export function modelDisplayName(info: QoderModelInfo): string {
  return `${info.displayName} · x${info.priceFactor.toFixed(2)}`
}

/**
 * 目录派生：目录 ∩ 勾选（workbuddy 的 `deriveCatalog` 同规）。
 *
 * **注册给 DSH 的模型 = 用户勾选的那些**。此前实现是「一律全部保留」，于是
 * 无论用户在卡片里勾了几个，DSH 的模型选择器里都躺着整份上游目录（用户实拍：
 * 「保存的模型，还是那么多」）——勾选形同虚设。
 *
 * `enabled` 为空是特例：**全不勾不等于全不选**，而是「还没选过」——此时把整份
 * 目录交出去，否则新用户的选择器会是空的。这与 workbuddy 的
 * `enabled.size === 0 ? catalog : catalog.filter(...)` 逐字同义。
 *
 * **勾了、但一条都没命中时也退回整份目录**（workbuddy 同一条守卫）。这不是
 * 「宽容」，是修一个具体的坏形状：`auto` 路由器不再进名册之后，某个只勾过
 * `auto` 的人，他的 `enabledModelKeys` 与目录交集为空——运行时目录于是变成空的，
 * DSH 的选择器一个模型都没有，而且**没有任何报错**（issue #32 的故障形态：模型
 * 静默消失）。退回整份目录至少让每个模型还能被看见、被重新勾选。
 *
 * 卡片自己的模型列表走的是另一条路（`catalog.current()`，始终是完整目录），
 * 所以「未勾选的也要看得见、才勾得上」不受影响。
 */
export function deriveCatalog(
  models: QoderModelInfo[],
  enabledKeys: ReadonlySet<string>,
): QoderModelInfo[] {
  const selected = enabledKeys.size === 0 ? models : models.filter(model => enabledKeys.has(model.key))
  return selected.length === 0 ? models : selected
}

/**
 * 把上游的**路由器**行从目录里去掉。
 *
 * `auto` 不是模型，是该区的默认路由（网关在请求时才决定解析成哪一个）。它
 * 无法被如实标价、也没法说清上下文与档位，所以不该作为一个可勾选的模型出现。
 *
 * 为什么在两个地方都要过滤（这里是**读**点，`upstream.fetchModels` 是**写**点）：
 * 静态兜底、实时拉取都经 `fetchModels`，但 `lastCatalog` 是**用户档案里的旧
 * 快照**——上一版把它存进去的人，升级后每一次读（卡片的列表、运行时目录、注册
 * 给 provider 的目录）都还会看到那一行，直到他下次刷新为止。在读点过滤而不是
 * 迁移存档是刻意的：存档保持「上次刷新写下的原样」，加载时不悄悄改写用户数据，
 * 而这一行在新代码跑起来的那一刻就消失，不必等下一次刷新。
 */
export function withoutRouters(models: readonly QoderModelInfo[]): QoderModelInfo[] {
  return models.filter(model => !isRouterModelId(model.key))
}

/**
 * 初始勾选集合：目录中的默认模型 + 免费模型；其余不勾。
 *
 * `auto` 在这里**必须**再排除一次，尽管它已经不在目录里：曾经的默认项就是它
 * （`isDefault: true`），所以「初始勾选」这条路上，一个恰好只剩路由器行的旧
 * 目录会把它重新勾上，然后借下一行的 `deriveCatalog` 复活成 DSH 里唯一的模型。
 */
export function initialEnabledKeys(models: QoderModelInfo[]): Set<string> {
  return new Set(
    models.filter(m => !isRouterModelId(m.key) && (m.isDefault || m.isFree)).map(m => m.key),
  )
}

/**
 * 上下文的原生窗口选择：DSH 的上下文预算（可选档位）。
 * 返回模型原生窗口或用户预算上限。
 */
export function contextBudgetOf(model: QoderModelInfo, budget: 'native' | '200K' | '500K'): number {
  if (budget === 'native') return model.contextWindow
  return budget === '200K' ? 200_000 : 500_000
}

// ---------------------------------------------------------------------------
// 运行期目录容器
// ---------------------------------------------------------------------------

/**
 * 一区域的当前目录。启动时以静态 fallback 填充（离线也能立刻有 provider），
 * 上游目录拉取成功后整表替换；空结果不覆盖已有表。
 */
export class QoderCatalog {
  private models: QoderModelInfo[]

  constructor(initial: QoderModelInfo[]) {
    this.models = initial
  }

  current(): QoderModelInfo[] {
    return this.models
  }

  set(models: QoderModelInfo[]): void {
    if (models.length > 0) this.models = models
  }

  /** 按 key 或显示名查找模型。 */
  find(selector: string): QoderModelInfo | undefined {
    return this.models.find(m => m.key === selector || m.displayName === selector)
  }

  /** key 解析：优先内部 key，其次显示名；未知返回 undefined。 */
  keyOf(selector: string): string | undefined {
    const hit = this.find(selector)
    return hit?.key
  }

  supportsImagesOf(selector: string): boolean {
    return this.find(selector)?.supportsImages ?? false
  }

  isReasoningOf(selector: string): boolean {
    return this.find(selector)?.supportsThinking ?? false
  }
}