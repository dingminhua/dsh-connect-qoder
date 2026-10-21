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

  it('returns the documented classification for a known id', () => {
    expect(nativeModalityOf('qwen3.7-max')).toBe('multimodal')
    expect(nativeModalityOf('kimi-k2.7-code')).toBe('text')
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

  it('leaves a documented text-only model unchecked', () => {
    expect(imageDefaultFor({ id: 'kimi-k2.7-code' })).toBe(false)
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
    expect(imageDefaultFor({ id: 'kimi-k2.7-code', supportsImages: true })).toBe(false)
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
