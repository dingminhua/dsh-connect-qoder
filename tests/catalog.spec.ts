import { describe, expect, it } from 'vitest'
import {
  parseUpstreamModel,
  fallbackModelInfo,
  modelDisplayName,
  initialEnabledKeys,
  deriveCatalog,
  QoderCatalog,
  QODER_FALLBACK_MODELS,
  pickDefaultContextWindow,
  contextTiersOf,
  applyContextBudgets,
} from '../src/catalog.ts'
import type { QoderUpstreamModel } from '../src/upstream.ts'
import { resolvePat, patFromEnv, QODER_PAT_ENV_VARS } from '../src/credentials.ts'

function rawModel(overrides: Partial<Record<string, unknown>> = {}): QoderUpstreamModel {
  return {
    key: 'dmodel',
    display_name: 'DeepSeek-V4-Pro',
    enable: true,
    is_default: false,
    is_vl: false,
    is_reasoning: true,
    is_free: false,
    price_factor: 2.5,
    max_input_tokens: 200_000,
    max_output_tokens: 32_768,
    thinking_config: undefined,
    context_config: undefined,
    raw: {},
    ...overrides,
  } as QoderUpstreamModel
}

describe('model parsing', () => {
  it('maps snake_case upstream entries', () => {
    const info = parseUpstreamModel(rawModel())
    expect(info.key).toBe('dmodel')
    expect(info.displayName).toBe('DeepSeek-V4-Pro')
    expect(info.priceFactor).toBe(2.5)
    expect(info.supportsThinking).toBe(true)
    expect(info.maxOutputTokens).toBe(32_768)
    expect(info.contextWindow).toBe(200_000)
  })

  it('picks the default context window from context_config', () => {
    const info = parseUpstreamModel(rawModel({
      context_config: { '200K': { token_count: 200_000, is_default: true }, '800K': { token_count: 800_000 } },
    }))
    expect(info.contextWindow).toBe(200_000)
    expect(pickDefaultContextWindow(rawModel({ context_config: { '800K': { token_count: 800_000 } } }))).toBe(800_000)
  })

  it('falls back to max_input_tokens and then the default', () => {
    expect(parseUpstreamModel(rawModel({ max_input_tokens: 500_000 })).contextWindow).toBe(500_000)
    expect(parseUpstreamModel(rawModel({ max_input_tokens: undefined })).contextWindow).toBe(200_000)
  })

  it('canDisableThinking is true when thinking_config.disabled exists', () => {
    expect(parseUpstreamModel(rawModel({ thinking_config: { disabled: true } })).canDisableThinking).toBe(true)
  })

  it('carries the thinking strengths, ordered weakest → strongest', () => {
    // 实测形状：上游给的键序是 xhigh/low/medium（**不是**强度序），直接显示会
    // 让用户以为 xhigh 是最弱档。解析必须按语义排序。
    const qwen = parseUpstreamModel(rawModel({
      thinking_config: { disabled: {}, enabled: { is_default: true, efforts: { xhigh: {}, low: {}, medium: { is_default: true } } } },
    }))
    expect(qwen.thinkingEfforts).toEqual(['low', 'medium', 'xhigh'])
    expect(qwen.defaultThinkingEffort).toBe('medium')

    // 另一族用 low/high/max——档位名不统一，不跨模型比较。
    const other = parseUpstreamModel(rawModel({
      thinking_config: { enabled: { efforts: { max: { is_default: true }, high: {}, low: {} } } },
    }))
    expect(other.thinkingEfforts).toEqual(['low', 'high', 'max'])
    expect(other.defaultThinkingEffort).toBe('max')
  })

  it('omits the strengths entirely when the model declares none', () => {
    // auto / kmodel_latest 等实测无 efforts：字段必须缺席（卡片据此不渲染这一
    // 项），而不是一个空数组——空数组会渲染出「推理强度：」这样的半句话。
    const bare = parseUpstreamModel(rawModel({ thinking_config: undefined }))
    expect(bare.thinkingEfforts).toBeUndefined()
    expect(bare.defaultThinkingEffort).toBeUndefined()
    const empty = parseUpstreamModel(rawModel({ thinking_config: { enabled: { efforts: {} } } }))
    expect(empty.thinkingEfforts).toBeUndefined()
  })
})

describe('display names', () => {
  it('embeds the credit multiplier like the Qoder menu', () => {
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 0.79 })).toBe('Qwen3.7-Max · x0.79')
    // 倍率 1 也照写——Qoder 自家菜单如此，workbuddy 的选择器同名规则也不省略 1。
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 1 })).toBe('Qwen3.7-Max · x1.00')
  })
})

describe('selection derivation', () => {
  it('initial check marks default and free models only', () => {
    const models = [
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), isDefault: true, isFree: false },
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[1]!), isDefault: false, isFree: true },
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[2]!), isDefault: false, isFree: false },
    ]
    const keys = initialEnabledKeys(models)
    expect(keys.has(models[0]!.key)).toBe(true)
    expect(keys.has(models[1]!.key)).toBe(true)
    expect(keys.has(models[2]!.key)).toBe(false)
  })

  it('deriveCatalog preserves the whole roster and respects saved keys', () => {
    const models = [fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), fallbackModelInfo(QODER_FALLBACK_MODELS[1]!)]
    const derived = deriveCatalog(models, new Set([models[0]!.key]))
    expect(derived.length).toBe(2)
    expect(derived[0]!.key).toBe(models[0]!.key)
  })
})

describe('QoderCatalog container', () => {
  it('serves the initial roster and replaces on set', () => {
    const catalog = new QoderCatalog([fallbackModelInfo(QODER_FALLBACK_MODELS[0]!)])
    expect(catalog.current().length).toBe(1)
    catalog.set([fallbackModelInfo(QODER_FALLBACK_MODELS[1]!), fallbackModelInfo(QODER_FALLBACK_MODELS[2]!)])
    expect(catalog.current().length).toBe(2)
  })

  it('keeps the previous table when set receives an empty list', () => {
    const catalog = new QoderCatalog([fallbackModelInfo(QODER_FALLBACK_MODELS[0]!)])
    catalog.set([])
    expect(catalog.current().length).toBe(1)
  })

  it('resolves keys by key or display name', () => {
    const m = fallbackModelInfo(QODER_FALLBACK_MODELS[0]!)
    const catalog = new QoderCatalog([m])
    expect(catalog.keyOf(m.key)).toBe(m.key)
    expect(catalog.keyOf(m.displayName)).toBe(m.key)
    expect(catalog.keyOf('nope')).toBeUndefined()
    expect(catalog.supportsImagesOf(m.displayName)).toBe(m.supportsImages)
  })
})

describe('credentials', () => {
  it('settings PAT wins over the environment variable', () => {
    const env = { [QODER_PAT_ENV_VARS.global]: 'env-pt' } as NodeJS.ProcessEnv
    expect(resolvePat('global', 'settings-pt', env)).toBe('settings-pt')
    expect(resolvePat('global', undefined, env)).toBe('env-pt')
    expect(resolvePat('global', '  ', env)).toBe('env-pt')
    expect(resolvePat('global', undefined, {})).toBeUndefined()
    expect(patFromEnv('cn', { [QODER_PAT_ENV_VARS.cn]: 'cn-pt' })).toBe('cn-pt')
    // CN and Global use different env var names
    expect(patFromEnv('cn', { [QODER_PAT_ENV_VARS.global]: 'global-pt' })).toBeUndefined()
  })
})
describe('contextTiers + applyContextBudgets', () => {
  it('contextTiersOf extracts the ascending tier table, or undefined when absent', () => {
    expect(contextTiersOf(rawModel({
      context_config: { '200K': { token_count: 200_000, is_default: true }, '800K': { token_count: 800_000 } },
    }))).toEqual([200_000, 800_000])
    expect(contextTiersOf(rawModel())).toBeUndefined()
  })

  it('applies a stored budget only when it is one of the model\'s declared tiers', () => {
    const tiered = parseUpstreamModel(rawModel({
      context_config: {
        '200K': { token_count: 200_000, is_default: true },
        '800K': { token_count: 800_000 },
      },
    }))
    const applied = applyContextBudgets([tiered], { [tiered.key]: 800_000 })
    expect(applied[0]?.contextWindow).toBe(800_000)
    // 不在档位表里的预算该模型没有 → 保持原生，绝不悄悄换。
    const kept = applyContextBudgets([tiered], { dmodel: 500_000 })
    expect(kept[0]?.contextWindow).toBe(200_000)
  })

  it('is an identity when the model has no tiers or the budget is absent', () => {
    const plain = parseUpstreamModel(rawModel())
    expect(applyContextBudgets([plain], { dmodel: 500_000 })[0]).toBe(plain)
    expect(applyContextBudgets([plain], {})[0]).toBe(plain)
  })

  it('returns a NEW model object only when the window actually changes, never mutating inputs', () => {
    const tiered = parseUpstreamModel(rawModel({
      context_config: { '200K': { token_count: 200_000, is_default: true }, '800K': { token_count: 800_000 } },
    }))
    const before = tiered.contextWindow
    applyContextBudgets([tiered], { dmodel: 800_000 })
    expect(tiered.contextWindow).toBe(before) // 原对象未变
  })
})
