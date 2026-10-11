/**
 * Qoder 适配器：qoderModelInput / qoderThinkingLevelMap / adaptLegacyPiAiContext /
 * createQoderAdapter（含 legacy|modern 世代闸）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/adapter.spec.ts` —— 思维档位投影、legacy 世代上下文折叠、provider 装配
 *   沿用。Qoder 端口的差异：
 *   - 思维 wire 是布尔量（`is_reasoning`），不是力度标尺：每个 effort 档
 *     （minimal…max）映到 `null`，只有 `canDisableThinking` 时才提供 `off`；
 *   - 输入模态只看 `supportsImages`；
 *   - `adaptLegacyPiAiContext` **不注入回退系统提示词**：Qoder 网关接受
 *     user-first 消息，所以没有系统消息时原样放行，而非像 workbuddy 那样塞一个。
 */

import { describe, expect, it } from 'vitest'
import {
  createQoderAdapter,
  qoderModelInput,
  qoderThinkingLevelMap,
  QODER_GLOBAL_PROVIDER,
  QODER_PROVIDER,
  regionOfProvider,
  adaptLegacyPiAiContext,
} from '../src/adapter.ts'
import type { QoderModelInfo } from '../src/catalog.ts'

const MODEL: QoderModelInfo = {
  key: 'qmodel',
  displayName: 'Qwen3.7-Plus',
  priceFactor: 1,
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  supportsImages: true,
  supportsThinking: true,
  canDisableThinking: true,
  isDefault: true,
  isFree: false,
  isNew: false,
}

describe('qoderModelInput', () => {
  it('offers images only for models that advertise them', () => {
    expect(qoderModelInput(MODEL)).toEqual(['text', 'image'])
    expect(qoderModelInput({ ...MODEL, supportsImages: false })).toEqual(['text'])
  })
})

describe('qoderThinkingLevelMap', () => {
  it('maps every effort level to null and offers `off` only when thinking can be disabled', () => {
    const map = qoderThinkingLevelMap(MODEL)
    expect(map?.off).toBe('off')
    expect(map?.minimal).toBeNull()
    expect(map?.max).toBeNull()
  })

  it('offers no `off` when the upstream says thinking cannot be disabled', () => {
    const map = qoderThinkingLevelMap({ ...MODEL, canDisableThinking: false })
    expect(map).toBeDefined()
    expect(map?.off).toBeUndefined()
    expect(map?.high).toBeNull()
  })

  it('returns undefined for a non-reasoning model (no map at all)', () => {
    expect(qoderThinkingLevelMap({ ...MODEL, supportsThinking: false })).toBeUndefined()
  })
})

describe('regionOfProvider', () => {
  it('maps each provider route back to its region', () => {
    expect(regionOfProvider('qoder')).toBe('cn')
    expect(regionOfProvider('qoder-global')).toBe('global')
    expect(regionOfProvider('something-else')).toBeUndefined()
  })
})

describe('adaptLegacyPiAiContext', () => {

  /** What pi-ai 0.87's normalizeContext produces. */
  const normalized = () => ({
    messages: [
      { role: 'system', content: 'You are helpful.', toolsAdded: [], timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 0 },
    ],
  })

  it('folds a string system message back into systemPrompt and removes it from messages', () => {
    const adapted = adaptLegacyPiAiContext(normalized() as never)
    expect(adapted.systemPrompt).toBe('You are helpful.')
    expect(adapted.messages).toHaveLength(1)
    expect((adapted.messages[0] as { role: string }).role).toBe('user')
  })

  it('joins several system messages rather than dropping the later ones', () => {
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'First.', timestamp: 0 },
        { role: 'system', content: 'Second.', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('First.\n\nSecond.')
    expect(adapted.messages).toHaveLength(1)
  })

  it('reads text blocks, because 0.87 can emit block content too', () => {
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Sys A' }, { type: 'text', text: 'Sys B' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('Sys A\n\nSys B')
    expect(adapted.messages).toHaveLength(1)
  })

  it('is an IDENTITY on the native 0.85 shape (same object, not merely equal)', () => {
    const legacy = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    expect(adaptLegacyPiAiContext(legacy as never)).toBe(legacy)
  })

  it('is an identity when there is nothing to repair at all', () => {
    const empty = { messages: [] }
    expect(adaptLegacyPiAiContext(empty as never)).toBe(empty)
    const noArray = { messages: 'not-an-array' }
    expect(adaptLegacyPiAiContext(noArray as never)).toBe(noArray)
  })

  it('passes a user-first transcript through as-is — Qoder has NO fallback system prompt', () => {
    // 这与 workbuddy 相反：它的网关拒绝非 system 开头，需要回退提示词；Qoder
    // 网关接受 user-first，所以无系统消息时保持原样，绝不塞占位提示词。
    const userFirst = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }
    expect(adaptLegacyPiAiContext(userFirst as never)).toBe(userFirst)
    expect((adaptLegacyPiAiContext(userFirst as never)).systemPrompt).toBeUndefined()
  })

  it('treats an EMPTY systemPrompt as absent, so a real system message survives', () => {
    const adapted = adaptLegacyPiAiContext({
      systemPrompt: '',
      messages: [
        { role: 'system', content: 'The real prompt', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('The real prompt')
    expect(adapted.messages).toHaveLength(1)
  })

  it('keeps an existing top-level tools array untouched while folding', () => {
    const adapted = adaptLegacyPiAiContext({
      ...normalized(),
      tools: [{ name: 't' }],
    } as never) as { tools?: unknown[] }
    expect(adapted.tools).toEqual([{ name: 't' }])
  })

  it('promotes toolsAdded from the folded system message into context.tools', () => {
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'You are helpful.', toolsAdded: [{ name: 'pwsh' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never) as { systemPrompt?: string, tools?: { name: string }[] }
    expect(adapted.tools).toEqual([{ name: 'pwsh' }])
    expect(adapted.systemPrompt).toBe('You are helpful.')
  })

  it('replays toolsRemoved then toolsAdded across system messages, keyed by name', () => {
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'Base.', toolsAdded: [{ name: 'a' }, { name: 'b' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
        { role: 'system', content: '', toolsRemoved: [{ name: 'a' }], toolsAdded: [{ name: 'c' }], timestamp: 1 },
      ],
    } as never) as { tools?: { name: string }[] }
    expect(adapted.tools?.map(tool => tool.name)).toEqual(['b', 'c'])
  })

  it('sets no tools when the folded system messages declared none', () => {
    const adapted = adaptLegacyPiAiContext(normalized() as never) as { tools?: unknown[] }
    expect(adapted.tools).toBeUndefined()
  })

  it('never leaves systemPrompt as an empty string', () => {
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: [{ type: 'image', data: 'x' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBeUndefined()
    expect(adapted.messages).toHaveLength(1)
  })
})

describe('createQoderAdapter', () => {
  /** A stub shim (no real server) and catalog the adapter can build from. */
  const shim = { baseUrl: 'http://127.0.0.1:9999', secret: 'shim-secret' } as never
  const catalog = { current: () => [MODEL] } as never

  it('reports the injected generation and is constructible for BOTH branches', () => {
    const legacy = createQoderAdapter({ shim, catalog, provider: 'qoder-test', displayName: 'Qoder Test', piAiGeneration: 'legacy' })
    expect(legacy.piAiGeneration).toBe('legacy')
    // invalidate() is a no-op-safe refresh hook.
    expect(() => legacy.invalidate()).not.toThrow()

    const modern = createQoderAdapter({ shim, catalog, provider: 'qoder-test', displayName: 'Qoder Test', piAiGeneration: 'modern' })
    expect(modern.piAiGeneration).toBe('modern')
    expect(() => modern.invalidate()).not.toThrow()
  })

  it('exposes the public provider route constants for the two regions', () => {
    expect(QODER_PROVIDER).toBe('qoder')
    expect(QODER_GLOBAL_PROVIDER).toBe('qoder-global')
  })

  it('defaults the provider id/display name to the CN gateway and is constructible without overrides', () => {
    const q = createQoderAdapter({ shim, catalog })
    expect(q.piAiGeneration).toBeDefined()
    expect(() => q.invalidate()).not.toThrow()
  })
})