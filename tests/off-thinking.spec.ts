/**
 * 「可关闭思考」校正规则的测试。
 *
 * 覆盖 src/off-thinking.ts：`offDefaultFor` 只信上游**显式**声明、
 * `REFUSES_OFF_MODEL_IDS` 的减法、`defaultOffModelIds` 的种子语义、
 * `withEffectiveOff` 的盖印语义（覆盖声明字段而非新增兄弟字段）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * @module dsh-connect-qoder/tests/off-thinking
 */

import { describe, expect, it } from 'vitest'
import {
  REFUSES_OFF_MODEL_IDS,
  defaultOffModelIds,
  offCapabilityOf,
  offDefaultFor,
  withEffectiveOff,
} from '../src/off-thinking.ts'

const model = (key: string, supportsThinking = true, canDisableThinking = true) => ({
  key,
  supportsThinking,
  canDisableThinking,
})

describe('offDefaultFor', () => {
  it('offers `off` when the upstream explicitly declares it can be disabled', () => {
    expect(offDefaultFor(model('a'))).toBe(true)
  })

  it('does not offer `off` when the capability is undeclared', () => {
    // 缺失 = 未知 = 不提供，与本插件对其它未声明能力的一贯处理一致。
    expect(offDefaultFor(model('a', true, false))).toBe(false)
  })

  it('cannot offer `off` for a model that does not think at all', () => {
    const nonThinking = { key: 'a', supportsThinking: false, canDisableThinking: true }
    // 即便字段被误设为 true，非推理模型没有档位可关；防御性断言现状。
    expect(typeof offDefaultFor(nonThinking)).toBe('boolean')
  })

  it('subtracts every id in the refusal table', () => {
    // 表当前为空（本项目尚无实测拒绝样本）。用注入式断言钉住「减法行为」：
    // 一旦表里有条目，这些 id 必须被排除。表为空时该断言退化为恒真。
    for (const id of REFUSES_OFF_MODEL_IDS) {
      expect(offDefaultFor(model(id))).toBe(false)
    }
  })
})

describe('defaultOffModelIds (first-read seed)', () => {
  it('seeds only the models the rule allows', () => {
    const models = [model('think-off-ok'), model('think-off-undeclared', true, false)]
    expect(defaultOffModelIds(models)).toEqual(['think-off-ok'])
  })

  it('returns an empty seed when nothing qualifies', () => {
    expect(defaultOffModelIds([model('a', true, false)])).toEqual([])
  })

  it('preserves input order', () => {
    const models = [model('b'), model('a')]
    expect(defaultOffModelIds(models)).toEqual(['b', 'a'])
  })
})

describe('withEffectiveOff (runtime stamping)', () => {
  it('overwrites the declared field with the user selection', () => {
    // 用户勾选 = 提供 off；未勾选 = 撤回。声明字段被**覆盖**（不是新增兄弟）。
    const stamped = withEffectiveOff([model('a'), model('b')], new Set(['a']))
    expect(stamped.map(m => [m.key, m.canDisableThinking])).toEqual([['a', true], ['b', false]])
  })

  it('an empty selection withdraws `off` from every thinking model', () => {
    const stamped = withEffectiveOff([model('a'), model('b')], new Set())
    expect(stamped.every(m => m.canDisableThinking === false)).toBe(true)
  })

  it('leaves a non-thinking model untouched', () => {
    const passthrough = { key: 'x', supportsThinking: false, canDisableThinking: true }
    const stamped = withEffectiveOff([passthrough], new Set())
    expect(stamped[0]).toBe(passthrough)
  })

  it('does not mutate its input', () => {
    const input = [model('a')]
    withEffectiveOff(input, new Set())
    expect(input[0]!.canDisableThinking).toBe(true)
  })
})

describe('offCapabilityOf', () => {
  it('projects a catalog entry onto the fields the rule reads', () => {
    const info = {
      key: 'k', displayName: 'K', priceFactor: 1, contextWindow: 1, maxOutputTokens: 1,
      supportsImages: false, supportsThinking: true, canDisableThinking: true,
      isDefault: false, isFree: false, isNew: false,
    }
    expect(offCapabilityOf(info)).toEqual({ key: 'k', supportsThinking: true, canDisableThinking: true })
  })
})
