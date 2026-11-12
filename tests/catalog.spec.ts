import { describe, expect, it } from 'vitest'
import {
  parseUpstreamModel,
  fallbackModelInfo,
  modelDisplayName,
  initialEnabledKeys,
  deriveCatalog,
  withoutRouters,
  withoutAbstractModels,
  withoutForeignRegionModels,
  ABSTRACT_MODEL_IDS,
  GLOBAL_ONLY_MODEL_IDS,
  QoderCatalog,
  QODER_FALLBACK_MODELS,
  pickDefaultContextWindow,
  contextTiersOf,
  applyContextBudgets,
  mapContextTier,
  mapContextTiers,
  migrateContextBudgets,
} from '../src/catalog.ts'
import type { QoderUpstreamModel } from '../src/upstream.ts'
import { qoderThinkingLevelMap } from '../src/adapter.ts'
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

  // -------------------------------------------------------------------------
  // issue #1「不能调节推理等级」：`is_reasoning` 与 `thinking_config` 自相矛盾。
  //
  // 下面的条目形状**逐字取自实测的 `GET /algo/api/v2/model/list`**（2026-10-19，
  // cn 与 global 两个区域），不是构造出来的极端情况。
  // -------------------------------------------------------------------------

  it('believes thinking_config over is_reasoning when the two disagree (issue #1)', () => {
    // 实测 cn `dfmodel`（DeepSeek-Flash）：is_reasoning=false，却给了完整三档
    // 与 disabled。旧写法 `supportsThinking: raw.is_reasoning` 让它在 DSH 里
    // 连思考强度控件都不渲染 —— 这正是用户报的症状。
    const reasoning = { disabled: { description: 'Disable thinking' }, enabled: { description: 'Enable thinking', is_default: true, efforts: { high: {}, max: {}, low: {} } } }
    const info = parseUpstreamModel(rawModel({ display_name: 'DeepSeek-Flash', is_reasoning: false, thinking_config: reasoning }))
    expect(info.supportsThinking).toBe(true)
    expect(info.thinkingEfforts).toEqual(['low', 'high', 'max'])
    // 声明了档位就一定支持强度选择 → 适配器才会产出档位表。
    expect(qoderThinkingLevelMap(info)).toBeDefined()
  })

  it('covers every contradictory entry the two regions actually serve', () => {
    // 实测 5 条自相矛盾条目（cn 2 条 + global 3 条），原生键序也照抄，用来钉住
    // 「键序不可信」与「以 efforts 为准」两件事同时成立。
    const cases: Array<{ key: string, efforts: Record<string, unknown> }> = [
      { key: 'dfmodel', efforts: { high: {}, max: { is_default: true }, low: {} } },
      { key: 'kmodel_latest', efforts: { high: {}, low: {}, max: {} } },
      { key: 'performance', efforts: { xhigh: {}, high: {}, low: {}, max: {}, medium: {} } },
      { key: 'kmodel', efforts: { high: {}, low: {}, max: {} } },
    ]
    for (const c of cases) {
      const info = parseUpstreamModel(rawModel({
        key: c.key,
        is_reasoning: false,
        thinking_config: { enabled: { efforts: c.efforts } },
      }))
      expect(info.supportsThinking, `${c.key} 必须被认作推理模型`).toBe(true)
      expect(info.thinkingEfforts?.length, `${c.key} 的档位不能丢`).toBe(Object.keys(c.efforts).length)
    }
  })

  it('never turns a declared reasoning model into a non-reasoning one', () => {
    // 方向的偏置：修正只会把 false 补成 true。efforts 缺席的条目（auto、
    // efficient、qmodel 等）必须保持 is_reasoning 原值，不能被误开。
    for (const isReasoning of [true, false]) {
      const info = parseUpstreamModel(rawModel({
        is_reasoning: isReasoning,
        thinking_config: { enabled: { is_default: true, efforts: undefined } },
      }))
      expect(info.supportsThinking).toBe(isReasoning)
      expect(info.thinkingEfforts).toBeUndefined()
    }
    // 推理模型不会因为「没写 thinking_config」被降级。
    expect(parseUpstreamModel(rawModel({ is_reasoning: true, thinking_config: undefined })).supportsThinking).toBe(true)
  })

  it('offers off only where the upstream actually describes it', () => {
    // 旧写法 `canDisable || raw.is_reasoning === false` 把**每个**非推理模型都标成
    // 可关闭思考 —— 卡片上就是一排打不开的勾选。现在只看上游是否真的描述了
    // disabled（或它本来就推理）。
    const bare = parseUpstreamModel(rawModel({ is_reasoning: false, thinking_config: undefined }))
    expect(bare.supportsThinking).toBe(false)
    expect(bare.canDisableThinking).toBe(false)

    // 实测 global `qmodel` / `qmodel_latest` / `kmodel`：disabled 有、efforts 没有。
    const disabledOnly = parseUpstreamModel(rawModel({
      is_reasoning: false,
      thinking_config: { disabled: { description: 'Disable thinking' }, enabled: { description: 'Enable thinking' } },
    }))
    expect(disabledOnly.thinkingEfforts).toBeUndefined()
    expect(disabledOnly.canDisableThinking).toBe(true)

    // 推理模型默认可以关闭（「不能关」是一句反事实断言，不采信）。
    expect(parseUpstreamModel(rawModel({ is_reasoning: true })).canDisableThinking).toBe(true)
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
    // 用「Qwen3.8-Max」这一条（兜底表的第一行）：它现在是上游真实的模型名。
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 0.79 })).toBe('Qwen3.8-Max · x0.79')
    // 倍率 1 也照写——Qoder 自家菜单如此，workbuddy 的选择器同名规则也不省略 1。
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 1 })).toBe('Qwen3.8-Max · x1.00')
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

  it('deriveCatalog narrows to the enabled keys (what DSH is offered)', () => {
    // 用户实拍：「保存的模型，还是那么多」——此前这个函数一律返回整份目录，
    // 于是无论卡片里勾了几个，DSH 的模型选择器都列出全部。现在与 workbuddy
    // 同义：勾选决定注册给 DSH 的集合。
    const models = [
      fallbackModelInfo(QODER_FALLBACK_MODELS[0]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[1]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[2]!),
    ]
    const derived = deriveCatalog(models, new Set([models[1]!.key]))
    expect(derived.map(m => m.key)).toEqual([models[1]!.key])
  })

  it('deriveCatalog treats "nothing enabled" as "not chosen yet", not "none"', () => {
    // 全不勾不等于全不选：把整份目录交给 DSH，否则新用户的选择器是空的
    // （workbuddy 的 enabled.size === 0 ? catalog : filter 同义）。
    const models = [
      fallbackModelInfo(QODER_FALLBACK_MODELS[0]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[1]!),
    ]
    expect(deriveCatalog(models, new Set()).map(m => m.key))
      .toEqual(models.map(m => m.key))
  })

  it('deriveCatalog falls back to the whole roster when the selection matches nothing', () => {
    // 真实场景，不是假设：`auto` 路由器不再进名册之后，某个**只勾过 `auto`**
    // 的人，他的 enabledModelKeys 与目录交集为空。若这里老实返回空数组，
    // DSH 的选择器会一个模型都没有，且**没有任何报错**（issue #32 的故障形态：
    // 模型静默消失，用户不知道发生了什么）。退回整份目录，至少每个模型都还能
    // 被看见、被重新勾选。
    const models = [
      fallbackModelInfo(QODER_FALLBACK_MODELS[0]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[1]!),
    ]
    expect(deriveCatalog(models, new Set(['auto'])).map(m => m.key))
      .toEqual(models.map(m => m.key))
    expect(deriveCatalog(models, new Set(['已下架的模型'])).map(m => m.key))
      .toEqual(models.map(m => m.key))
  })

  it('withoutRouters drops the saved `auto` row, which is what every old profile carries', () => {
    // 实测（本机真实存档 profiles/desktop/cordis.patch.yml）：两个区域的
    // lastCatalog 都是 **`auto` 打头**，displayName `Auto`、`isDefault: true`、
    // 没有思考档位。它是旧版本写下的快照，读点不过滤的话，升级后卡片里那一行
    // 会一直在，直到用户手动刷新一次。
    const models = [
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key: 'auto', displayName: 'Auto', isDefault: true },
      fallbackModelInfo(QODER_FALLBACK_MODELS[1]!),
    ]
    expect(withoutRouters(models).map(m => m.key)).toEqual([models[1]!.key])
  })

  it('那几个抽象命名的条目不出现在可勾选目录里（两个区域都一样）', () => {
    // 用户先要求「国际版不要显示这些抽象选项」，随后在国内版模型栏里看到
    // `Fast (0.80x)` 仍在，追加「国内版的 fast 也取消掉」。
    //
    // 所以这条判据**不属于区域**：`Fast` / `Ultimate` / `Efficient` 只有一个
    // 抽象形容词，换到哪个区域都看不出背后是哪个模型。
    // 我此前按「只有国际版过滤」实现，依据是「上游只为国际版下发」——那条依据
    // 是**错的**：兜底表里 `fast` 两个区域共用，国内版一样会出现。
    //
    // 判据用**显式表**（与 `auto` 路由器同一条做法）：名字启发式（「首字母大写的
    // 单词都丢」）会误伤真模型。
    const models = [
      fallbackModelInfo(QODER_FALLBACK_MODELS[0]!),
      ...['fast', 'ultimate', 'efficient'].map(key => ({
        ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key, displayName: key.toUpperCase(),
      })),
    ]
    const kept = withoutAbstractModels(models).map(m => m.key)
    expect(kept, '抽象命名的条目没被过滤掉').toEqual([models[0]!.key])
  })

  it('Sonus / Cantus 不是抽象词，绝不能被那一条判据吃掉（issue #37）', () => {
    // 判据是「看不出背后是哪家的哪个模型」，而 Sonus / Cantus 是**产品名**，
    // 与 Qwen3.8-Max、GLM-5.3 同一层级：上游给它们 `is_new: true`（fast /
    // efficient / ultimate 都没有），说明上游把它们当新模型推送，不是路由档位；
    // 它们还是全目录里最贵的两条（x8 / x4），恰恰是付费用户最想主动选的。
    //
    // 这一条是**回归护栏**，钉的是「别再把产品名塞进那张表」：把 `smodel` /
    // `cmodel` 加回 `ABSTRACT_MODEL_IDS`，这里立刻红。
    for (const key of ['smodel', 'cmodel']) {
      expect(ABSTRACT_MODEL_IDS.has(key), `${key} 又被当成抽象命名了`).toBe(false)
    }
    const models = ['smodel', 'cmodel'].map(key => ({
      ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key, displayName: key.toUpperCase(),
    }))
    expect(withoutAbstractModels(models).map(m => m.key)).toEqual(['smodel', 'cmodel'])
  })

  it('国内版过滤「上游没有的」条目：Sonus / Cantus 只在国际版出现', () => {
    // issue #37 的直接后果，值得单独一条：兜底表 `QODER_FALLBACK_MODELS` 是
    // **两个区域共用**的（它没有区域轴），里面就写着 `smodel` / `cmodel`。
    // 它们过去被「抽象命名」那张表顺手挡住，所以没人发现兜底目录在国内版其实
    // 是超集。把产品名从那张表移出之后，这层遮挡消失 —— 如果不补这一条判据，
    // 国内版用户会在选择器里看到一只点下去就失败的模型。
    const models = ['smodel', 'cmodel', 'qmodel_38max'].map(key => ({
      ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key, displayName: key,
    }))
    expect(withoutForeignRegionModels(models, 'global').map(m => m.key), '国际版被误删')
      .toEqual(['smodel', 'cmodel', 'qmodel_38max'])
    expect(withoutForeignRegionModels(models, 'cn').map(m => m.key), '国内版还在列上游没有的模型')
      .toEqual(['qmodel_38max'])
    // 不传区域 = 不按区域收窄（老调用点 / 纯函数测试的兼容面）。
    expect(withoutForeignRegionModels(models).map(m => m.key)).toHaveLength(3)
    // 产品名只受**区域**那一条约束，否则「把它们从抽象表移出去」这个修复就白做
    // 了 —— 这一对断言是这次修复的正身。
    for (const key of ['smodel', 'cmodel']) {
      expect(ABSTRACT_MODEL_IDS.has(key), `${key} 又回到抽象表里了`).toBe(false)
      expect(GLOBAL_ONLY_MODEL_IDS.has(key), `${key} 应当受区域判据约束`).toBe(true)
    }
    // 反向：区域表只放**拿得出实测证据**的 id。`ultimate` / `efficient` 虽然在
    // 兜底目录里被注释成「仅国际版下发」，实测条数表（国内 10 / 国际 14）证明
    // 国内版有它们；而它们已被抽象表在两区过滤，放不放进这张表都看不出差别 ——
    // 所以宁可空着，也不要让一张解释性表格写着一条没核实的结论。
    for (const key of ['ultimate', 'efficient']) {
      expect(GLOBAL_ONLY_MODEL_IDS.has(key), `${key} 没有实测依据却被写进区域表`).toBe(false)
    }
  })

  it('国内版与国际版都过滤：这条判据不属于区域', () => {
    // 我此前写成「只有 global 过滤」，理由是「CN 的上游不下发这几条」——实测
    // 推翻了这个理由：兜底表两个区域共用，`fast` 在国内版目录里就在（用户实拍
    // 「国内版的 fast 也取消掉」）。
    //
    // 保留区域参数是**为了不影响别的判据**（有些过滤确实按区域），但这个函数
    // 自己的答案与区域无关 —— 两个区域必须给出同一个结果。
    const ids = ['fast', 'ultimate', 'efficient']
    const models = ids.map(key => ({
      ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key, displayName: key,
    }))
    expect(withoutAbstractModels(models, 'global')).toEqual([])
    expect(withoutAbstractModels(models, 'cn'), '国内版还在列这些条目').toEqual([])
    // 真模型在两个区域都必须保留（过滤只认显式表）。
    const real = [fallbackModelInfo(QODER_FALLBACK_MODELS[0]!)]
    expect(withoutAbstractModels(real, 'cn').map(m => m.key)).toEqual([real[0]!.key])
    expect(withoutAbstractModels(real, 'global').map(m => m.key)).toEqual([real[0]!.key])
  })

  it('withoutRouters leaves real models alone and never mutates its input', () => {
    // 过滤必须只命中路由器：「叫 auto 的都丢」这种名字启发式迟早会误伤真模型，
    // 所以判据是显式表。同时不得改写入参——目录是共享的只读数据。
    const models = [
      fallbackModelInfo(QODER_FALLBACK_MODELS[0]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[1]!),
      fallbackModelInfo(QODER_FALLBACK_MODELS[2]!),
    ]
    const before = models.map(m => m.key)
    const out = withoutRouters(models)
    expect(out.map(m => m.key)).toEqual(before)
    expect(out).not.toBe(models)
    expect(models.map(m => m.key)).toEqual(before)
  })

  it('initialEnabledKeys never seeds the router, even when it claims isDefault', () => {
    // `auto` 曾经**就是**默认项（isDefault: true）。它的名字若还出现在某种旧
    // 目录里，「初始勾选」这条路径会把它重新勾上，然后借 deriveCatalog 变成
    // DSH 里唯一的模型。所以这里必须再排除一次，而不是指望目录已经干净。
    const models = [
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), key: 'auto', displayName: 'Auto', isDefault: true },
      { ...fallbackModelInfo(QODER_FALLBACK_MODELS[1]!), isDefault: false, isFree: true },
    ]
    const keys = initialEnabledKeys(models)
    expect(keys.has('auto')).toBe(false)
    expect(keys.has(models[1]!.key)).toBe(true)
  })

  it('display names always carry the multiplier, so the DSH picker shows it', () => {
    // 用户实拍的第二半：「没有倍数显示」。DSH 选择器显示的就是这个名字，所以
    // 倍率必须拼在这里而不是只在卡片里（实测上游 price_factor 0.5 / 0.1 / 0）。
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 0.5 }))
      .toContain('x0.50')
    expect(modelDisplayName({ ...fallbackModelInfo(QODER_FALLBACK_MODELS[0]!), priceFactor: 0 }))
      .toContain('x0.00')
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

describe('档位改写表（400K → 500K，用户要求 2026-10-24）', () => {
  it('mapContextTier 只改写表里的值，其余原样', () => {
    expect(mapContextTier(400_000)).toBe(500_000)
    expect(mapContextTier(200_000)).toBe(200_000)
    expect(mapContextTier(1_000_000)).toBe(1_000_000)
    expect(mapContextTier(500_000)).toBe(500_000) // 已是 500K 时不再翻倍改写
  })

  it('mapContextTiers 改写后去重升序（上游同时发 400K 与 500K 也不出重项）', () => {
    expect(mapContextTiers([200_000, 400_000, 1_000_000])).toEqual([200_000, 500_000, 1_000_000])
    expect(mapContextTiers([400_000, 500_000, 200_000])).toEqual([200_000, 500_000])
    expect(mapContextTiers([])).toEqual([])
  })

  it('migrateContextBudgets 把旧存档里的 400K 选择读成 500K', () => {
    expect(migrateContextBudgets({ qmodel_38max: 400_000, dmodel: 200_000 }))
      .toEqual({ qmodel_38max: 500_000, dmodel: 200_000 })
    expect(migrateContextBudgets({})).toEqual({})
  })

  it('上游声明 400K 档时，解析出的档位表与默认窗口都是改写后的值', () => {
    // 实测上游形状：`[200000, 400000, 1000000]`，默认档 is_default 在 400K 上。
    const info = parseUpstreamModel(rawModel({
      context_config: {
        c200k: { token_count: 200_000 },
        c400k: { token_count: 400_000, is_default: true },
        c1m: { token_count: 1_000_000 },
      },
    }))
    expect(info.contextTiers).toEqual([200_000, 500_000, 1_000_000])
    expect(info.contextWindow).toBe(500_000)
    // 保存的 500K 预算能命中改写后的档位表（applyContextBudgets 不再把它当「不在档里」丢掉）。
    expect(applyContextBudgets([info], { dmodel: 500_000 })[0]?.contextWindow).toBe(500_000)
  })

  it('默认档不在改写表里时窗口不受影响', () => {
    const info = parseUpstreamModel(rawModel({
      context_config: { c200k: { token_count: 200_000, is_default: true }, c1m: { token_count: 1_000_000 } },
    }))
    expect(info.contextWindow).toBe(200_000)
    expect(info.contextTiers).toEqual([200_000, 1_000_000])
  })
})

// ---------------------------------------------------------------------------
// 静态兜底目录（网关不可达时保底）
// ---------------------------------------------------------------------------

describe('静态兜底目录', () => {
  /**
   * 兜底目录**照抄上游实测**，而不是抄旧版本。
   *
   * 事实来源：2026-11-02 用探针（`/tmp/dump-full.mjs`）拉 cn 与 global 两区的
   * `model/list` 原始行，逐字段抄下来。下表是那两次抓取的结果。
   */
  const UPSTREAM_FACTS: Record<string, {
    name: string
    vl: boolean
    /** 上游 `thinking_config.enabled.efforts` 的键（无则 undefined）。 */
    efforts?: string[]
    defaultEffort?: string
    /** 上游 `thinking_config.disabled` 是否存在。 */
    canOff: boolean
  }> = {
    qmodel_38max: { name: 'Qwen3.8-Max', vl: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', canOff: true },
    qfmodel: { name: 'Qwen3.8-Flash', vl: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', canOff: true },
    dmodel: { name: 'DeepSeek-V4-Pro', vl: true, efforts: ['high', 'max'], defaultEffort: 'max', canOff: true },
    dfmodel: { name: 'DeepSeek-Flash', vl: true, efforts: ['high', 'low', 'max'], defaultEffort: 'high', canOff: true },
    gmodel: { name: 'GLM-5.3', vl: true, efforts: ['high', 'low', 'max'], defaultEffort: 'high', canOff: false },
    gfmodel: { name: 'GLM-5.3-Flash', vl: true, efforts: ['high', 'max'], defaultEffort: 'max', canOff: false },
    kmodel_latest: { name: 'Kimi-K3.1-Pro', vl: true, efforts: ['high', 'low', 'max'], defaultEffort: 'high', canOff: false },
    kmodel: { name: 'Kimi-K2.8-Preview', vl: true, efforts: ['high', 'low', 'max'], defaultEffort: 'high', canOff: false },
    // 上游对 MiniMax 明确 `is_reasoning: false`，且**没有** `thinking_config`。
    mmodel: { name: 'MiniMax-M3.1-Flash', vl: true, canOff: false },
    fast: { name: 'Fast', vl: true, canOff: false },
    ultimate: { name: 'Ultimate', vl: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', canOff: false },
    efficient: { name: 'Efficient', vl: true, canOff: false },
    smodel: { name: 'Sonus', vl: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', canOff: false },
    cmodel: { name: 'Cantus', vl: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', canOff: false },
  }

  it('表里的每一个 key 都是上游真实存在的（不再有过期的 key）', () => {
    // 旧表里的 `qmodel_latest` / `qmodel_preview` / `qmodel` / `q36fmodel` /
    // `gm51model` 五个 key 上游早已不存在，兜底出来的目录有一半是幻觉。
    const keys = QODER_FALLBACK_MODELS.map(m => m.key)
    for (const key of keys) {
      expect(UPSTREAM_FACTS[key], `兜底表里的 ${key} 必须是上游存在的模型`).toBeDefined()
    }
    expect(keys).toEqual(Object.keys(UPSTREAM_FACTS))
  })

  it('模型名与上游一致', () => {
    for (const m of QODER_FALLBACK_MODELS) {
      expect(m.displayName, `${m.key} 的显示名`).toBe(UPSTREAM_FACTS[m.key]!.name)
    }
  })

  it('档位与默认档与上游一致（顺序按强度升序）', () => {
    const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    for (const m of QODER_FALLBACK_MODELS) {
      const fact = UPSTREAM_FACTS[m.key]!
      const sorted = fact.efforts === undefined
        ? undefined
        : [...fact.efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
      expect(m.thinkingEfforts, `${m.key} 的档位表`).toEqual(sorted)
      expect(m.defaultThinkingEffort, `${m.key} 的默认档`).toBe(fact.defaultEffort)
      expect(m.canDisableThinking, `${m.key} 能否关掉思考`).toBe(fact.canOff)
    }
  })

  it('投影后的模型带着档位（不是只在表里写着）', () => {
    // 上一条断言的是**表里的原始条目**；这一条断言**投影后的结果**。
    // 两者必须都断：表里写了档位、而 `fallbackModelInfo` 忘了带出去，兜底目录
    // 就会在网关不可达时丢掉全部思考档位 —— 而那正是这张表存在的意义。
    for (const m of QODER_FALLBACK_MODELS) {
      const fact = UPSTREAM_FACTS[m.key]!
      const info = fallbackModelInfo(m)
      expect(info.thinkingEfforts, `${m.key} 投影后的档位表`).toEqual(m.thinkingEfforts)
      expect(info.defaultThinkingEffort, `${m.key} 投影后的默认档`).toBe(fact.defaultEffort)
      expect(info.canDisableThinking, `${m.key} 投影后能否关掉思考`).toBe(fact.canOff)
      // 支持思考 = 有档位，或者是上游明确声明的推理模型。
      expect(info.supportsThinking, `${m.key} 投影后是否支持思考`)
        .toBe(m.thinkingEfforts !== undefined || m.isReasoning)
    }
  })

  it('MiniMax 与上游一致：不是推理模型，也没有档位', () => {
    // 这一条是用户问的那件事：上游对 MiniMax-M3.1-Flash 声明
    // `is_reasoning: false` 且没有 `thinking_config`。兜底表此前写的是
    // `isReasoning: true` —— 那是上游早已不承认的旧声明（那时它还是 M2.7）。
    const minimax = QODER_FALLBACK_MODELS.find(m => m.key === 'mmodel')!
    expect(minimax.isReasoning).toBe(false)
    expect(minimax.thinkingEfforts).toBeUndefined()
    const info = fallbackModelInfo(minimax)
    expect(info.supportsThinking).toBe(false)
    expect(info.thinkingEfforts).toBeUndefined()
    expect(info.canDisableThinking).toBe(false)
  })

  it('兜底出来的模型仍然能拿到真实的档位表（不是全 null 的 map）', () => {
    // DSH 内核对推理元数据是硬校验：档位表全 null 会让整条 provider 路由作废。
    // 兜底目录若丢掉了档位，网关不可达时 DSH 会直接报「Provider is not configured」。
    for (const m of QODER_FALLBACK_MODELS) {
      const info = fallbackModelInfo(m)
      const map = qoderThinkingLevelMap(info)
      if (info.thinkingEfforts === undefined) {
        expect(map, `${m.key} 没有档位时应返回 undefined（而不是全 null 的 map）`).toBeUndefined()
      } else {
        expect(map, `${m.key} 必须有真实档位`).toBeDefined()
        expect(Object.values(map!).filter(v => v !== null).length).toBeGreaterThan(0)
      }
    }
  })
})
