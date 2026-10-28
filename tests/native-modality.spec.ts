/**
 * 原生多模态表与图片默认值的规则测试。
 *
 * 覆盖 src/native-modality.ts：为什么这张表存在（平台标记不可信）、
 * `imageDefaultFor` 的三条分支（文档 multimodal / 文档 text / unknown）、
 * 平台 `supportsImages:false` 的一票否决、精确匹配（绝不从同族/显示名继承）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * @module dsh-connect-qoder/tests/native-modality
 */

import { describe, expect, it } from 'vitest'
import {
  NATIVE_MODALITY_BY_MODEL_ID,
  ROUTER_MODEL_IDS,
  imageDefaultFor,
  isRouterModelId,
  modalityKeyOf,
  nativeModalityOf,
} from '../src/native-modality.ts'

describe('isRouterModelId', () => {
  it('recognises the upstream `auto` router', () => {
    expect(isRouterModelId('auto')).toBe(true)
    expect(nativeModalityOf('auto')).toBe('router')
  })

  it('is an explicit table, not a name heuristic', () => {
    // 路由是上游的概念、没有声明字段。按名字猜（「叫 auto 的都算路由」）迟早
    // 会误伤一个真的叫这个名字的模型——所以判据只有这张表。要往里加 id，先
    // 拿到与 `auto` 同等强度的证据（它是该区默认路由、被网关解析成别的模型、
    // 是名册里唯一无法标价的那一行）。
    expect(ROUTER_MODEL_IDS.has('auto')).toBe(true)
    expect(isRouterModelId('autopilot')).toBe(false)
    expect(isRouterModelId('qmodel_38max')).toBe(false)
    expect(isRouterModelId('')).toBe(false)
  })

  it('normalises case and whitespace like every other lookup in this module', () => {
    // `nativeModalityOf` 一直走 normalizeModelId；这里若不走，`AUTO` 就会在
    // 图片开关的判定里得到 unknown、却在目录过滤里逃过一劫。
    expect(isRouterModelId('AUTO')).toBe(true)
    expect(isRouterModelId(' auto ')).toBe(true)
  })
})

describe('nativeModalityOf', () => {
  it('treats `auto` as a router, not a model', () => {
    expect(nativeModalityOf('auto')).toBe('router')
  })

  it('returns the reviewed classification for a known id', () => {
    // 主键是 Qoder 内部短 id（稳定），厂商名是别名键。
    expect(nativeModalityOf('qmodel_38max')).toBe('multimodal')
    expect(nativeModalityOf('qwen3.8-max')).toBe('multimodal')
    expect(nativeModalityOf('kmodel')).toBe('multimodal')
  })

  it('returns unknown for an id that is not in the reviewed table', () => {
    // 这正是这张表存在的理由：没有依据时必须是 unknown，而不是猜一个。
    expect(nativeModalityOf('brand-new-model-9000')).toBe('unknown')
    expect(nativeModalityOf('')).toBe('unknown')
  })

  it('matches by EXACT id and never by family prefix', () => {
    // `qwen3.7-max-preview` 之类的新变体不得从 `qwen3.7-max` 继承结论。
    expect(nativeModalityOf('qwen3.7-max-preview-xyz')).toBe('unknown')
    expect(nativeModalityOf('qwen3')).toBe('unknown')
  })

  it('is case- and whitespace-insensitive on the id', () => {
    expect(nativeModalityOf('  QWEN3.7-MAX  ')).toBe('multimodal')
  })
})

describe('imageDefaultFor', () => {
  it('pre-checks only a documented multimodal model', () => {
    expect(imageDefaultFor({ id: 'qwen3.7-max' })).toBe(true)
  })

  it('leaves a model with no table entry unchecked', () => {
    // 当前目录里没有确认的纯文本模型（见 src/native-modality.ts 的实测记录），
    // 所以「不勾」的样本用未登记 id，而不是某个被标成 text 的模型。
    expect(imageDefaultFor({ id: 'kimi-k9-unreleased' })).toBe(false)
  })

  it('leaves an unverified model unchecked rather than guessing', () => {
    expect(imageDefaultFor({ id: 'mystery-model' })).toBe(false)
  })

  it('lets a platform `supportsImages: false` veto even a documented multimodal id', () => {
    // 平台的明确「不支持」拥有一票否决权。
    expect(imageDefaultFor({ id: 'qwen3.7-max', supportsImages: false })).toBe(false)
  })

  it('does NOT pre-check merely because the platform flag says true', () => {
    // 关键回归：平台的 `is_vl` 几乎对每个模型都是 true，绝不能因此预勾选。
    expect(imageDefaultFor({ id: 'mystery-model', supportsImages: true })).toBe(false)
    expect(imageDefaultFor({ id: 'brand-new-model-9000', supportsImages: true })).toBe(false)
  })
})

describe('modalityKeyOf', () => {
  it('prefers an exact key hit', () => {
    expect(modalityKeyOf('qwen3.7-max', 'Qwen3.7-Max')).toBe('qwen3.7-max')
  })

  it('falls back to the display name when the key is an internal short id', () => {
    expect(modalityKeyOf('qmodel_latest', 'Qwen3.7-Max')).toBe('qwen3.7-max')
  })

  it('returns the normalized key when neither matches (caller sees unknown)', () => {
    expect(modalityKeyOf('  UNKNOWN-ID ', 'Also Unknown')).toBe('unknown-id')
  })
})

describe('the reviewed table', () => {
  it('only ever records the two confirmable states', () => {
    for (const [id, value] of Object.entries(NATIVE_MODALITY_BY_MODEL_ID)) {
      expect(id).toBe(id.trim().toLowerCase())
      expect(value === 'text' || value === 'multimodal').toBe(true)
    }
  })
})

/**
 * **issue #22 的防回归**：种子的键必须能命中真实目录。
 *
 * 缺陷形状：表的键是厂商模型名，而目录里的 `key` 是内部短 id，调用方只传了
 * `key` ⇒ 每次 seed 都落到 `undefined` ⇒ 整张表是死代码，所有模型默认关图。
 * 这条测试拿**真实的目录形状**（`key` = 短 id、`displayName` = 厂商名）跑一遍，
 * 断言表里登记过的每一个都真的被勾上。它在修复前是 0 命中。
 */
describe('图片默认种子能命中真实目录（issue #22）', () => {
  /** 上游真实目录的形状（2026-10-29 两个区域实测）。 */
  const LIVE_CATALOG = [
    { key: 'qmodel_38max', name: 'Qwen3.8-Max' },
    { key: 'qfmodel', name: 'Qwen3.8-Flash' },
    { key: 'dmodel', name: 'DeepSeek-V4-Pro' },
    { key: 'dfmodel', name: 'DeepSeek-Flash' },
    { key: 'gmodel', name: 'GLM-5.3' },
    { key: 'gfmodel', name: 'GLM-5.3-Flash' },
    { key: 'kmodel_latest', name: 'Kimi-K3.1-Pro' },
    { key: 'kmodel', name: 'Kimi-K2.8-Preview' },
    { key: 'mmodel', name: 'MiniMax-M3.1-Flash' },
    { key: 'fast', name: 'Fast' },
    { key: 'ultimate', name: 'Ultimate' },
    { key: 'efficient', name: 'Efficient' },
    { key: 'smodel', name: 'Sonus' },
    { key: 'cmodel', name: 'Cantus' },
  ]

  it('每个真实目录条目都命中（短 id 直查）', () => {
    // 短 id 是主键：只传 id 就必须命中，不依赖显示名兜底。
    const missed = LIVE_CATALOG.filter(m => !imageDefaultFor({ id: m.key }))
    expect(missed.map(m => m.key)).toEqual([])
  })

  it('即使调用方只传显示名也能命中（别名键）', () => {
    // 旧存档 / 外部选择器可能只拿得到厂商名。
    const missed = LIVE_CATALOG.filter(m => !imageDefaultFor({ id: '', name: m.name }))
    expect(missed.map(m => m.name)).toEqual([])
  })

  it('真实目录里的每个 id 都不是 unknown（表没有落后于目录）', () => {
    // 这条是给「模型改名」这类漂移准备的：目录换了名字而表没跟上时，这里变红，
    // 而不是让用户在每个新模型上手动静默地勾一次。
    const unknown = LIVE_CATALOG.filter(m => nativeModalityOf(modalityKeyOf(m.key, m.name)) === 'unknown')
    expect(unknown.map(m => `${m.key}/${m.name}`)).toEqual([])
  })

  it('平台的 supportsImages:false 仍然否决真实目录里的条目', () => {
    expect(imageDefaultFor({ id: 'qmodel_38max', name: 'Qwen3.8-Max', supportsImages: false })).toBe(false)
  })

  it('表里每个键都规范化（小写、无空白），且只有两种状态', () => {
    for (const [id, value] of Object.entries(NATIVE_MODALITY_BY_MODEL_ID)) {
      expect(id).toBe(id.trim().toLowerCase())
      expect(id).toBe(id.replace(/\s+/gu, '-'))
      expect(value === 'text' || value === 'multimodal').toBe(true)
    }
  })

  it('内置 fallback 目录（升级前的旧存档）同样全部命中', () => {
    // 内置目录是旧模型名，升级后保存的 lastCatalog 里可能还留着它们。
    const fallback = [
      ['qmodel_latest', 'Qwen3.7-Max'], ['qmodel_preview', 'Qwen3.8-Max-Preview'],
      ['qmodel', 'Qwen3.7-Plus'], ['q36fmodel', 'Qwen3.6-Flash'],
      ['dmodel', 'DeepSeek-V4-Pro'], ['dfmodel', 'DeepSeek-V4-Flash'],
      ['gm51model', 'GLM-5.2'], ['kmodel', 'Kimi-K2.7-Code'], ['mmodel', 'MiniMax-M2.7'],
    ] as const
    const missed = fallback.filter(([key, name]) => !imageDefaultFor({ id: key, name }))
    expect(missed.map(([key]) => key)).toEqual([])
  })
})

/**
 * **表不许悄悄落后于内置目录。**
 *
 * `QODER_FALLBACK_MODELS` 是网关不可达时的保底目录，也是升级前存档的形状。
 * 表里若漏掉其中任何一个，那个模型在 fallback 场景下就默认关图——而这正是
 * issue #22 的病灶（用户看到的是「某些模型没勾」，没有任何东西报错）。
 * 所以这里直接遍历内置目录，断言每一个都命中，而不是手抄一份清单。
 */
describe('核对表覆盖内置目录（防落后）', () => {
  it('QODER_FALLBACK_MODELS 的每一条都命中种子', async () => {
    const { QODER_FALLBACK_MODELS } = await import('../src/catalog.ts')
    const missed = QODER_FALLBACK_MODELS.filter(m => !imageDefaultFor({ id: m.key, name: m.displayName }))
    expect(missed.map(m => `${m.key}/${m.displayName}`)).toEqual([])
  })

  it('内置目录的每一条都不是 unknown', async () => {
    const { QODER_FALLBACK_MODELS } = await import('../src/catalog.ts')
    const unknown = QODER_FALLBACK_MODELS.filter(m => nativeModalityOf(modalityKeyOf(m.key, m.displayName)) === 'unknown')
    expect(unknown.map(m => `${m.key}/${m.displayName}`)).toEqual([])
  })
})
