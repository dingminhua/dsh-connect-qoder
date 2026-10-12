/**
 * Qoder 模型目录：静态 fallback + 动态目录解析 + 勾选派生。
 *
 * 模型字段来自官方 SDK 的 ModelInfo（camelCase DTO）与服务端 snake_case
 * 原样的对照；积分倍率 `price_factor` 即模型名内嵌的 `· xN.NN` 来源。
 *
 * @module dsh-connect-qoder/catalog
 */

import type { QoderUpstreamModel } from './upstream.ts'

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
 * - **不是每个模型都有档位**：`auto`、`qmodel_latest` 等 `efforts` 缺失，
 *   此时返回空对象（字段缺席），卡片据此不渲染这一项——而不是渲染一个空标签。
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

/** 把上游 snake_case 条目解析成 DSH 侧模型信息。 */
export function parseUpstreamModel(raw: QoderUpstreamModel): QoderModelInfo {
  const contextWindow = pickDefaultContextWindow(raw) ?? raw.max_input_tokens ?? QODER_DEFAULT_CONTEXT
  const canDisable = raw.thinking_config?.disabled !== undefined
  const reasoning = thinkingOf(raw.thinking_config)
  return {
    key: raw.key,
    displayName: raw.display_name,
    priceFactor: raw.price_factor ?? 1,
    contextWindow,
    maxOutputTokens: raw.max_output_tokens ?? 32_768,
    supportsImages: raw.is_vl,
    supportsThinking: raw.is_reasoning,
    canDisableThinking: canDisable || raw.is_reasoning === false,
    ...reasoning,
    isDefault: raw.is_default,
    isFree: raw.is_free === true,
    isNew: false,
    ...tiersField(contextTiersOf(raw)),
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
 * 卡片自己的模型列表走的是另一条路（`catalog.current()`，始终是完整目录），
 * 所以「未勾选的也要看得见、才勾得上」不受影响。
 */
export function deriveCatalog(
  models: QoderModelInfo[],
  enabledKeys: ReadonlySet<string>,
): QoderModelInfo[] {
  return enabledKeys.size === 0 ? models : models.filter(model => enabledKeys.has(model.key))
}

/** 初始勾选集合：目录中的默认模型 + 免费模型；其余不勾。 */
export function initialEnabledKeys(models: QoderModelInfo[]): Set<string> {
  return new Set(models.filter(m => m.isDefault || m.isFree).map(m => m.key))
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