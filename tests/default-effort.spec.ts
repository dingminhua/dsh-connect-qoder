/**
 * 逐模型默认思考档位的**取值规则**。
 *
 * 用户实拍：「这里既然有默认设置选择的思考强度，选择的时候就应该直接进入到这个
 * 对应的默认设置，而不是跳动到 default」—— 卡片那一行写着「medium（上游默认）」，
 * 而 DSH 的模型选择器显示的是 **Default**。
 *
 * 这份规则决定「默认是几档」，因此它必须在**纯函数**层被钉住：界面上的默认档、
 * 请求里带下去的档位、以及宿主的模型选择器，三处读的是同一个答案。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 它的 `src/default-effort.ts` 是同一件事（它的 issue #179），本模块沿用
 *   它的形状与理由。
 */
import { describe, expect, it } from 'vitest'

import {
  declaredEfforts,
  defaultEffortFor,
  selectableEfforts,
  QODER_FALLBACK_EFFORT,
} from '../src/default-effort.ts'

/** Qwen 系：low / medium / xhigh，默认 medium（实测上游）。 */
const QWEN = {
  key: 'qmodel_38max',
  thinkingEfforts: ['low', 'medium', 'xhigh'],
  defaultThinkingEffort: 'medium',
}

/** DeepSeek 系：low / high / max，默认 max（实测上游）。 */
const DEEPSEEK = {
  key: 'dmodel',
  thinkingEfforts: ['low', 'high', 'max'],
  defaultThinkingEffort: 'max',
}

describe('declaredEfforts', () => {
  it('只保留 DSH 认识的档位，并按强度升序', () => {
    expect(declaredEfforts(QWEN)).toEqual(['low', 'medium', 'xhigh'])
    expect(declaredEfforts(DEEPSEEK)).toEqual(['low', 'high', 'max'])
  })

  it('上游偶尔冒出的、不在 DSH 词表里的名字被丢掉', () => {
    // 报一个 DSH 不认识的档位，宿主会以 UNSUPPORTED_REASONING_EFFORT 拒掉请求。
    expect(declaredEfforts({ key: 'x', thinkingEfforts: ['weird', 'low'] })).toEqual(['low'])
  })

  it('一个档位都没有时是空表', () => {
    expect(declaredEfforts({ key: 'x' })).toEqual([])
    expect(declaredEfforts({ key: 'x', thinkingEfforts: [] })).toEqual([])
  })
})

describe('defaultEffortFor', () => {
  it('上游声明的默认档就是答案', () => {
    expect(defaultEffortFor(QWEN)).toBe('medium')
    expect(defaultEffortFor(DEEPSEEK)).toBe('max')
  })

  it('用户保存过的档位胜过上游默认档', () => {
    expect(defaultEffortFor(QWEN, { qmodel_38max: 'xhigh' })).toBe('xhigh')
    expect(defaultEffortFor(DEEPSEEK, { dmodel: 'low' })).toBe('low')
  })

  it('保存的值不在该模型当前的档位表里时退回上游默认档', () => {
    // 目录换代后用户保存的档位可能已经不在了。报一个模型**没有**的档位，宿主会
    // 以 UNSUPPORTED_REASONING_EFFORT 拒掉整个请求 —— 那比显示 Default 糟得多。
    expect(defaultEffortFor(QWEN, { qmodel_38max: 'max' })).toBe('medium')
    // 保存的值属于**别的**模型时也不能串台。
    expect(defaultEffortFor(QWEN, { dmodel: 'xhigh' })).toBe('medium')
  })

  it('上游没标默认档时用兜底档（不是最弱的那一档）', () => {
    // Qwen 系声明 low/medium/xhigh —— 按强度排序的第一个是 `low`，那是**最弱**
    // 的一档，把它当兜底等于默认关掉思考。首选兜底是 `medium`。
    expect(defaultEffortFor({ key: 'x', thinkingEfforts: ['low', 'medium', 'xhigh'] })).toBe(QODER_FALLBACK_EFFORT)
    // `low/high/max` 这一族**没有** `medium`，那就取该模型自己声明的**中档**
    // （`high`）—— 仍然不是最弱的 `low`。
    expect(defaultEffortFor({ key: 'x', thinkingEfforts: ['low', 'high', 'max'] })).toBe('high')
  })

  it('兜底档也不在档位表里时用该模型声明的中档', () => {
    // 只声明 xhigh/max 的模型：`medium` 不在其中，那就用它声明的中档 ——
    // 仍然是一个**它声明过**的档位，而且不是最弱的。
    expect(defaultEffortFor({ key: 'x', thinkingEfforts: ['xhigh', 'max'] })).toBe('xhigh')
  })

  it('一个档位都没声明时不编一个出来', () => {
    // 这样的模型根本不提供推理强度（`qoderThinkingLevelMap` 返回 undefined），
    // 返回 undefined 让调用方按「不提供推理」处理。
    expect(defaultEffortFor({ key: 'x' })).toBeUndefined()
    expect(defaultEffortFor({ key: 'x', thinkingEfforts: [] })).toBeUndefined()
    // 兜底档也不能凭空出现。
    expect(defaultEffortFor({ key: 'x', thinkingEfforts: ['weird'] })).toBeUndefined()
  })

  it('空串的保存值等于没保存过', () => {
    expect(defaultEffortFor(QWEN, { qmodel_38max: '' })).toBe('medium')
  })
})

describe('selectableEfforts', () => {
  it('就是该模型自己声明的档位，不做跨模型统一', () => {
    // 各模型族的词表确实不同（`low/high/max` 对 `low/medium/xhigh`），合成一条
    // 阶梯只会列出选不动的行。
    expect(selectableEfforts(QWEN)).toEqual(['low', 'medium', 'xhigh'])
    expect(selectableEfforts(DEEPSEEK)).toEqual(['low', 'high', 'max'])
  })
})
