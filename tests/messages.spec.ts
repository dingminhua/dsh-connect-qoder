import { describe, expect, it } from 'vitest'
import {
  buildQoderMessages,
  convertIncomingMessage,
  extractLatestUserPrompt,
  normalizeMessageText,
  parseToolCallsText,
  createChatBodyTemplate,
  applyModelKey,
  type QoderIncomingMessage,
} from '../src/messages.ts'

describe('message text normalization', () => {
  it('handles string, array, and missing content', () => {
    expect(normalizeMessageText({ role: 'user', content: 'hi' })).toBe('hi')
    expect(normalizeMessageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab')
    expect(normalizeMessageText({ role: 'user' })).toBe('')
  })
})

describe('convertIncomingMessage', () => {
  it('converts plain user text to contents-part shape', () => {
    const out = convertIncomingMessage({ role: 'user', content: 'hello' }, false, false)
    expect(out?.role).toBe('user')
    expect(out?.content).toBe('')
    expect((out as QoderIncomingMessage).contents?.[0]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('carries image_url parts', () => {
    const out = convertIncomingMessage({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'text', text: 'what is this' },
      ],
    }, false, false)
    const contents = (out as QoderIncomingMessage).contents ?? []
    expect(contents[0]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    expect(contents[1]).toMatchObject({ type: 'text', text: 'what is this' })
  })

  it('renders tool result as user text when tools are disabled', () => {
    const out = convertIncomingMessage({ role: 'tool', name: 'bash', tool_call_id: 'call_1', content: '42' }, false, false)
    expect(out?.role).toBe('user')
    expect(out?.content).toContain('Tool result')
    expect(out?.content).toContain('bash')
  })

  it('keeps tool role with name and id when tools are enabled', () => {
    const out = convertIncomingMessage({ role: 'tool', name: 'bash', tool_call_id: 'call_1', content: '42' }, true, false)
    expect(out?.role).toBe('tool')
    expect(out?.name).toBe('bash')
    expect(out?.tool_call_id).toBe('call_1')
  })

  it('structured assistant tool_calls survive', () => {
    const calls = [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }]
    const out = convertIncomingMessage({ role: 'assistant', content: '', tool_calls: calls }, true, true)
    expect(out?.tool_calls).toEqual(calls)
  })
})

describe('parseToolCallsText', () => {
  it('parses the "Tool calls:" JSON fallback', () => {
    const text = 'Let me run that.\nTool calls:\n[{"id":"c1","name":"bash","input":{"x":1}}]'
    const calls = parseToolCallsText(text)
    expect(calls?.length).toBe(1)
    expect(calls?.[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"x":1}' } })
  })

  it('returns undefined for plain text', () => {
    expect(parseToolCallsText('no calls here')).toBeUndefined()
  })
})

describe('buildQoderMessages', () => {
  it('rebuilds a full conversation preserving order', () => {
    const incoming = [
      { role: 'user', content: 'list directory' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'thanks' },
    ]
    const out = buildQoderMessages(incoming, 'list directory', false)
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[0]?.content).toBe('')
  })

  it('falls back to the prompt when messages are empty', () => {
    const out = buildQoderMessages([], 'fallback prompt', false)
    expect(out.length).toBe(1)
    expect(extractLatestUserPrompt([])).toBe('')
    expect((out[0] as QoderIncomingMessage).contents?.[0]?.text).toBe('fallback prompt')
  })
})

describe('template', () => {
  it('produces a fresh template per call with empty ids', () => {
    const a = createChatBodyTemplate()
    const b = createChatBodyTemplate()
    expect(a).not.toBe(b)
    expect(a.request_id).toBe('')
    expect(a.stream).toBe(true)
    expect(a.model_config.key).toBe('lite')
  })

  it('applyModelKey sets key and vl on both places', () => {
    const t = createChatBodyTemplate()
    applyModelKey(t, 'dmodel', 'personal_pro', true)
    expect(t.model_config.key).toBe('dmodel')
    expect(t.model_config.is_vl).toBe(true)
    expect(t.model_config.is_reasoning).toBe(false)
    expect(t.chat_context.extra.modelConfig.key).toBe('dmodel')
    expect(t.aliyun_user_type).toBe('personal_pro')
  })
})