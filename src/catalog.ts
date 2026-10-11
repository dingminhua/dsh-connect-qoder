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

/** 把上游 snake_case 条目解析成 DSH 侧模型信息。 */
export function parseUpstreamModel(raw: QoderUpstreamModel): QoderModelInfo {
  const contextWindow = pickDefaultContextWindow(raw) ?? raw.max_input_tokens ?? QODER_DEFAULT_CONTEXT
  const canDisable = raw.thinking_config?.disabled !== undefined
  return {
    key: raw.key,
    displayName: raw.display_name,
    priceFactor: raw.price_factor ?? 1,
    contextWindow,
    maxOutputTokens: raw.max_output_tokens ?? 32_768,
    supportsImages: raw.is_vl,
    supportsThinking: raw.is_reasoning,
    canDisableThinking: canDisable || raw.is_reasoning === false,
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
 * 模型显示名：内嵌积分倍率（与 Qoder 自身菜单格式一致）。
 * `GLM-5.2 · x0.79` / `Qwen3.7-Max · x1.0`。
 */
export function modelDisplayName(info: QoderModelInfo): string {
  const factor = info.priceFactor
  const suffix = factor !== 1 ? ` · x${factor.toFixed(2)}` : ''
  return `${info.displayName}${suffix}`
}

/**
 * 目录派生：目录 ∩ 勾选。上过线的模型保持勾选状态；新目录条目按
 * 「默认/免费/多模态」启发式初始勾选，其余不勾（用户可手动改）。
 */
export function deriveCatalog(
  models: QoderModelInfo[],
  enabledKeys: ReadonlySet<string>,
): QoderModelInfo[] {
  return models.map((model) => {
    if (enabledKeys.has(model.key)) return model
    // 未勾选的也保留在目录里（卡片可见、可勾），只是默认不启用。
    return model
  })
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