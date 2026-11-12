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
  /** 上游声明的思考强度档位（`thinking_config.enabled.efforts` 的键，已按强度升序）。 */
  thinkingEfforts?: string[]
  /** 上游标为默认的档位（`efforts[x].is_default`）。 */
  defaultThinkingEffort?: string
  /** 上游声明可完全关闭思考（`thinking_config.disabled` 存在）。 */
  canDisableThinking?: boolean
}

/**
 * 静态兜底目录（网关不可达时保底）。
 *
 * ## 这张表的依据
 *
 * 每一行都抄自**上游 `model/list` 的实测结果**（2026-11-02，cn 与 global 两区
 * 各抓一次，`/tmp/dump-full.mjs` 探针）。不是凭模型名推的，也不是抄旧版本。
 *
 * 它此前已经**整体过期**：表里的 `qmodel_latest` / `qmodel_preview` /
 * `qmodel` / `q36fmodel` / `gm51model` 五个 key 在上游**已经不存在**了
 * （上游换成了 `qmodel_38max` / `qfmodel` / `gmodel`），模型名也停在
 * Qwen3.7-Max、GLM-5.2、MiniMax-M2.7 那一代。网关不可达时兜出来的目录因此
 * 一半是**上游没有的模型**。
 *
 * ## 为什么兜底目录也要照抄上游的思考声明
 *
 * 兜底目录不是「随便列几个模型」——它会被当成真的目录注册给 DSH
 * （`src/index.ts` 的 `configuredModels` 在既无存档又无实时目录时用它）。所以它
 * 的每一项都必须能回答与上游同样的三个问题：这个模型支不支持思考、有哪些档位、
 * 能不能关掉。
 *
 * MiniMax 是这件事的现成例子：上游对 `mmodel` 声明 `is_reasoning: false` 且
 * **根本没有** `thinking_config` 字段（旧兜底表却写着 `isReasoning: true`）。
 * 兜底目录若继续这么写，一个网关不可达的用户就会看到一个「上游没有的档位」。
 *
 * ## 两区的差异怎么处理
 *
 * 实测两区的档位表**完全一致**，只有 `is_reasoning` 在三个模型上相反
 * （`dfmodel` / `fast` / `kmodel`）——而这三个模型**都有** `thinking_config`，
 * 所以 `supportsThinkingOf` 按 `thinking_config` 判时结论相同（见该函数的
 * 注释：只把 false 补成 true，绝不把 true 降成 false）。
 *
 * 因此这张表按 **`thinking_config` 说了算**：有档位就是推理模型，无论
 * `is_reasoning` 写的是什么。`isReasoning` 只在**既无档位、又无 disabled**
 * 时才为 false（那才是「上游明确说它不思考」）。
 *
 * ## 兜底目录不声明的字段
 *
 * `contextTiers` **不**在这里写：兜底表只保底「有哪些模型」，窗口档位在拉不到
 * 目录时无从得知，写死一档反而会让卡片渲染出一个上游没有的预算下拉
 * （`parseUpstreamModel` 的 `tiersField` 也是「只有一档就不写」）。
 */
export const QODER_FALLBACK_MODELS: QoderFallbackModel[] = [
  // ── cn 与 global 共有的 ──
  {
    key: 'qmodel_38max', displayName: 'Qwen3.8-Max', isVl: true, isReasoning: true,
    priceFactor: 0.5, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'medium', 'xhigh'], defaultThinkingEffort: 'medium',
    canDisableThinking: true,
  },
  {
    key: 'qfmodel', displayName: 'Qwen3.8-Flash', isVl: true, isReasoning: true,
    priceFactor: 0, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'medium', 'xhigh'], defaultThinkingEffort: 'medium',
    canDisableThinking: true,
  },
  {
    key: 'dmodel', displayName: 'DeepSeek-V4-Pro', isVl: true, isReasoning: true,
    priceFactor: 0.5, maxInputTokens: 180_000,
    thinkingEfforts: ['high', 'max'], defaultThinkingEffort: 'max',
    canDisableThinking: true,
  },
  {
    key: 'dfmodel', displayName: 'DeepSeek-Flash', isVl: true, isReasoning: true,
    priceFactor: 0.1, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'high', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: true,
  },
  {
    key: 'gmodel', displayName: 'GLM-5.3', isVl: true, isReasoning: true,
    priceFactor: 0.8, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'high', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
  {
    key: 'gfmodel', displayName: 'GLM-5.3-Flash', isVl: true, isReasoning: true,
    priceFactor: 0.1, maxInputTokens: 180_000,
    thinkingEfforts: ['high', 'max'], defaultThinkingEffort: 'max',
    canDisableThinking: false,
  },
  {
    key: 'kmodel_latest', displayName: 'Kimi-K3.1-Pro', isVl: true, isReasoning: true,
    priceFactor: 1, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'high', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
  {
    key: 'kmodel', displayName: 'Kimi-K2.8-Preview', isVl: true, isReasoning: true,
    priceFactor: 0.8, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'high', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
  {
    // MiniMax：上游 `is_reasoning: false` 且**没有** `thinking_config` 字段，
    // 所以它没有档位、也没有 off 档。老兜底表写的 `isReasoning: true` 是上游
    // 早已不承认的旧声明（那时它还是 MiniMax-M2.7）。
    key: 'mmodel', displayName: 'MiniMax-M3.1-Flash', isVl: true, isReasoning: false,
    priceFactor: 0.1, maxInputTokens: 180_000,
    canDisableThinking: false,
  },
  {
    key: 'fast', displayName: 'Fast', isVl: true, isReasoning: false,
    priceFactor: 0.8, maxInputTokens: 200_000,
    canDisableThinking: false,
  },

  // ── 仅国际版下发（cn 没有这几条）──
  {
    key: 'ultimate', displayName: 'Ultimate', isVl: true, isReasoning: true,
    priceFactor: 2, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
  {
    key: 'efficient', displayName: 'Efficient', isVl: true, isReasoning: false,
    priceFactor: 0.3, maxInputTokens: 200_000,
    canDisableThinking: false,
  },
  {
    key: 'smodel', displayName: 'Sonus', isVl: true, isReasoning: true,
    priceFactor: 8, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
  {
    key: 'cmodel', displayName: 'Cantus', isVl: true, isReasoning: true,
    priceFactor: 4, maxInputTokens: 180_000,
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingEffort: 'high',
    canDisableThinking: false,
  },
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

/**
 * 把 fallback 条目解析成模型信息。
 *
 * 思考相关的三个字段与上游走**同一套语义**（否则兜底目录就会变成「另一个
 * 真相」）：
 *
 * - `supportsThinking` —— 有档位就是推理模型；没有档位时按条目自报的
 *   `isReasoning`（上游对 `mmodel` 明确说 false）；
 * - `thinkingEfforts` / `defaultThinkingEffort` —— 上游声明的档位，原样带上；
 * - `canDisableThinking` —— 上游声明了 `disabled` 才是 true。**没有声明时是
 *   false**，而不是老写法的 `true`：老写法给**每一个**模型都发 off 档，包括
 *   MiniMax 这种上游根本没提思考的模型 —— 而 `qoderThinkingLevelMap` 只在
 *   有真实档位时才返回 map，off 档也就跟着不出现，所以这里 false 与 true
 *   在运行时等价；但它诚实，且让 `offDefaultFor` 的语义（「上游**显式**声明
 *   才给」）在兜底路径上同样成立。
 */
export function fallbackModelInfo(m: QoderFallbackModel): QoderModelInfo {
  return {
    key: m.key,
    displayName: m.displayName,
    priceFactor: m.priceFactor ?? 1,
    contextWindow: m.maxInputTokens ?? QODER_DEFAULT_CONTEXT,
    maxOutputTokens: m.maxOutputTokens ?? 32_768,
    supportsImages: m.isVl,
    supportsThinking: m.thinkingEfforts !== undefined || m.isReasoning,
    canDisableThinking: m.canDisableThinking === true,
    ...m.thinkingEfforts === undefined ? {} : { thinkingEfforts: m.thinkingEfforts },
    ...m.defaultThinkingEffort === undefined ? {} : { defaultThinkingEffort: m.defaultThinkingEffort },
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
 * 那几条「抽象命名」的模型 id —— **两个区域都过滤**。
 *
 * 指的是目录里这几行：`Fast` / `Ultimate` / `Efficient`。它们与 `Qwen3.8-Max`
 * 那种「看名字就知道是谁家的哪个型号」的条目不同：只有一个抽象形容词，看不出
 * 背后是哪一家的模型，勾了也不知道自己勾的是什么。
 *
 * 用户先要求「国际版不要显示这些抽象选项」，随后在国内版模型栏里看到
 * `Fast (0.80x)` 仍在，追加「国内版的 fast 也取消掉」。所以这条判据**不属于
 * 区域** —— 我此前按「上游只为国际版下发」把它限定在 global，那条依据是错的：
 * 兜底表两个区域共用，`fast` 在国内版目录里本来就在。
 *
 * **`Sonus` / `Cantus` 曾经也在这张表里，是错的（issue #37）。** 判据是「看不
 * 出背后是哪家的哪个模型」，而这两个是**产品名**，与 `Qwen3.8-Max`、`GLM-5.3`
 * 同一层级：上游对它们下发 `is_new: true`（`fast` / `efficient` / `ultimate`
 * 都没有），说明上游把它们当新模型推送，而不是路由档位；它们还是全目录最贵的
 * 两条（x8 / x4），恰恰是付费用户最想主动选的。把它们归进这一档，等于拿一句
 * 「用户不想看抽象词」去藏两只具体模型。
 *
 * 它们**不属于区域**，但**属于上游的哪个区域**是另一件事：见
 * {@link GLOBAL_ONLY_MODEL_IDS}。
 *
 * **用显式表，不用名字启发式**（与 `ROUTER_MODEL_IDS` 同一条判据）：「首字母
 * 大写的单词都丢」迟早会误伤一个真的叫这个名字的模型。要往这里加 id，先拿到
 * 与这一次同等强度的证据（名字确实是抽象词、且不指向任何具体厂商型号）。
 *
 * 过滤发生在**读点**（`modelsOf` / 卡片目录），不动 `lastCatalog` 存档：
 * 存档保持「上次刷新写下的原样」，而这一行在新代码跑起来的那一刻就消失。
 */
export const ABSTRACT_MODEL_IDS: ReadonlySet<string> = new Set([
  'fast',
  'ultimate',
  'efficient',
])

/**
 * 上游**只在国际版**下发的模型 id —— 国内版目录里一律去掉。
 *
 * 这一条与 {@link ABSTRACT_MODEL_IDS} 是**两套判据**，混过一次，值得写清楚：
 *
 *   - 抽象命名：说什么都不该列（用户不想做无谓的选择）；
 *   - 区域专属：**上游国内版根本没有这个模型**，列出来是一个点下去就失败的选项。
 *
 * 依据是 `src/upstream.ts` 的实测表（2026-10-29，两个区域各一枚真实 PAT）：
 * 国内版 10 条、国际版 14 条，多出来的正是 `smodel` / `cmodel`（`fast` 两区
 * 都有）。这张表是**静默**的差异——国内版请求一个不存在的 key，上游不会提前
 * 告诉你。
 *
 * 为什么这条判据必须存在（issue #37 的直接后果）：静态兜底目录 `QODER_FALLBACK_MODELS`
 * 是**两个区域共用**的（它没有区域轴），里面就写着 `smodel` / `cmodel`
 * （注释原文：「仅国际版下发（cn 没有这几条）」）。它们过去被「抽象命名」那张
 * 表顺手挡住了，所以没人发现兜底目录在国内版其实是**超集**。把 `smodel` /
 * `cmodel` 从那张表里移出之后，这层遮挡消失，兜底目录会把两只国内版没有的
 * 模型摆到国内版用户面前——于是这条判据从「将来也许用得上」变成**现在必须
 * 有效**。
 *
 * 过滤同样发生在读点，不动存档：存档里若有，新代码跑起来那一刻就消失。
 *
 * ## 为什么表里**只有** `smodel` / `cmodel`
 *
 * 兜底目录的注释把 `ultimate` / `efficient` 也写在「仅国际版下发」那一栏里，但
 * `src/upstream.ts` 的实测表（同一组两个真实 PAT 的目录条数）说国内版是 10 条、
 * 国际版 14 条，多出来的只有 `smodel` / `cmodel` / `fast` —— 也就是说 `ultimate`
 * 与 `efficient` 在国内版**是有的**。两份记录互相矛盾。
 *
 * 这条矛盾不碍事（那两条已被 `ABSTRACT_MODEL_IDS` 在**两个区域**都过滤掉，这张
 * 表怎么写都不改变它们的可见性），所以这里选择**不背书**自己没实测过的那一半：
 * 一张将来可能被用来解释「为什么国内版少了某个模型」的表，只该放能拿出证据的 id。
 * 哪天 `ultimate` / `efficient` 从抽象表里移出（它们确实是抽象词，移出的理由不会
 * 成立），再补一次两区实测来决定它们归不归这里。
 */
export const GLOBAL_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  'smodel',
  'cmodel',
])

/**
 * 去掉那几个抽象命名的条目。
 *
 * @param models - 一个区域的目录。
 * @param region - 目录所属区域。**这个参数不改变结果**：判据本身与区域无关
 *   （见 {@link ABSTRACT_MODEL_IDS}），两个区域给出同一个答案。
 *
 *   保留它有两个理由：调用点本来就握着区域（传了比不传更省心）；以及这里是
 *   「按区域过滤」这一类判据将来会加进来的地方 —— 到时候它就有用了。签名里
 *   写清楚「现在不按区域分支」，比让后来的人以为漏判了一次要好。
 *
 *   ⚠️ 「按区域过滤」的那一条**没有**加进这个函数，而是另开了
 *   {@link withoutForeignRegionModels}：两个判据的理由完全不同（一个说「看不
 *   出是什么」，一个说「国内版根本没有」），合在一个函数里就没人能单独改其中
 *   一条，而 issue #37 正是「改一条时必须不动另一条」。
 */
export function withoutAbstractModels(
  models: readonly QoderModelInfo[],
  _region?: 'cn' | 'global',
): QoderModelInfo[] {
  return models.filter(model => !ABSTRACT_MODEL_IDS.has(model.key.trim().toLowerCase()))
}

/**
 * 去掉**该区域上游不提供**的条目（见 {@link GLOBAL_ONLY_MODEL_IDS}）。
 *
 * 只对国内版生效：国际版是那张表的全集，没什么可去的。
 *
 * 为什么不写在 `upstream.fetchModels`（真实的写点）里：那里拿不到「目录是从哪
 * 个区域的存档里读回来的」——`lastCatalog` 是用户档案里的旧快照，而静态兜底
 * 表两个区域共用。读点过滤是唯一能同时盖住这三条来源的位置（存档 / 兜底 /
 * 实时），与 `withoutRouters` 的选择相同、理由相同。
 *
 * @param models - 一个区域的目录（可能是存档、兜底或实时拉取的结果）。
 * @param region - 目录所属区域。**这一条按区域分支**：`global` 原样返回。
 */
export function withoutForeignRegionModels(
  models: readonly QoderModelInfo[],
  region?: 'cn' | 'global',
): QoderModelInfo[] {
  if (region !== 'cn') return [...models]
  return models.filter(model => !GLOBAL_ONLY_MODEL_IDS.has(model.key.trim().toLowerCase()))
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