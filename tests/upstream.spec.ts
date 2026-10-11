import { describe, expect, it } from 'vitest'
import {
  jobTokenBody,
  parseStreamDelta,
  classifyHttpStatus,
  classifyBusinessCode,
  isContentPolicy,
  parseUsage,
  QoderUpstreamError,
  QODER_REGIONS,
} from '../src/upstream.ts'
import { cosyDecode } from '../src/cosy.ts'

describe('region endpoints', () => {
  it('CN chat / models / jobToken share the gateway host', () => {
    const cn = QODER_REGIONS.cn
    expect(cn.gateway).toBe('https://gateway.qoder.com.cn')
    expect(cn.openapi).toBe('https://openapi.qoder.com.cn')
    expect(cn.chatPath).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation')
  })

  it('Global uses the qoder.sh hosts', () => {
    const global = QODER_REGIONS.global
    expect(global.gateway).toBe('https://api1.qoder.sh')
    expect(global.openapi).toBe('https://openapi.qoder.sh')
  })
})

describe('jobTokenBody', () => {
  it('encodes PAT payload with custom base64 and decodable inner JSON', () => {
    const body = jobTokenBody('pt-test-123')
    const decoded = Buffer.from(cosyDecode(body)).toString('utf8')
    const outer = JSON.parse(decoded) as { payload: string; encodeVersion: string }
    expect(outer.encodeVersion).toBe('1')
    const inner = JSON.parse(outer.payload) as Record<string, unknown>
    expect(inner.personalToken).toBe('pt-test-123')
    expect(inner.needRefresh).toBe(false)
    expect(inner.authInfo).toEqual({})
  })

  it('uses refreshToken when credential starts with drt-', () => {
    const body = jobTokenBody('drt-refresh-1')
    const decoded = Buffer.from(cosyDecode(body)).toString('utf8')
    const outer = JSON.parse(decoded) as { payload: string }
    const inner = JSON.parse(outer.payload) as Record<string, unknown>
    expect(inner.personalToken).toBe('')
    expect(inner.refreshToken).toBe('drt-refresh-1')
    expect(inner.needRefresh).toBe(true)
  })
})

describe('parseStreamDelta', () => {
  it('extracts content from the OpenAI-shaped inner JSON', () => {
    const frame = JSON.stringify({
      headers: {},
      body: JSON.stringify({
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }],
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.role).toBe('assistant')
    expect(delta?.content).toBe('Hello')
  })

  it('extracts reasoning_content and tool_calls', () => {
    const frame = JSON.stringify({
      body: JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: 'thinking…',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          },
        }],
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.reasoningContent).toBe('thinking…')
    expect(delta?.toolCalls?.length).toBe(1)
  })

  it('extracts usage-only frames', () => {
    const frame = JSON.stringify({
      body: JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.inputTokens).toBe(12)
    expect(delta?.outputTokens).toBe(3)
  })

  it('throws on envelope-level errors', () => {
    const frame = JSON.stringify({
      body: '{"message":"provider error"}',
      statusCodeValue: 502,
    })
    expect(() => parseStreamDelta(frame)).toThrow(QoderUpstreamError)
    try {
      parseStreamDelta(frame)
    } catch (error) {
      expect((error as QoderUpstreamError).kind).toBe('transient')
    }
  })

  it('throws on business errors and classifies quota codes', () => {
    const frame = JSON.stringify({
      body: JSON.stringify({ code: '115', message: 'token modle quota is exhausted' }),
      statusCodeValue: 200,
    })
    try {
      parseStreamDelta(frame)
      expect.unreachable('should throw')
    } catch (error) {
      expect((error as QoderUpstreamError).kind).toBe('quota-exhausted')
      expect((error as QoderUpstreamError).code).toBe('115')
    }
  })

  it('returns undefined for non-chat frames and garbage', () => {
    expect(parseStreamDelta('data: [DONE]')).toBeUndefined()
    expect(parseStreamDelta('not json')).toBeUndefined()
    expect(parseStreamDelta(JSON.stringify({ headers: {}, body: '', statusCodeValue: 200 }))).toBeUndefined()
  })
})

describe('error classification', () => {
  it('maps HTTP statuses', () => {
    expect(classifyHttpStatus(401, '')).toBe('auth')
    expect(classifyHttpStatus(403, '')).toBe('auth')
    expect(classifyHttpStatus(429, '')).toBe('rate-limited')
    expect(classifyHttpStatus(400, '')).toBe('invalid-request')
    expect(classifyHttpStatus(418, '')).toBe('transient')
    expect(classifyHttpStatus(500, '')).toBe('transient')
    expect(classifyHttpStatus(502, '')).toBe('transient')
  })

  it('detects content policy markers', () => {
    expect(isContentPolicy('DataInspectionFailed: input text data may contain inappropriate content')).toBe(true)
    // 即使 HTTP 200，内容审核标记也分类为 content-policy（消费方不应原地重试）
    expect(classifyHttpStatus(200, 'ContentFilter')).toBe('content-policy')
    expect(classifyHttpStatus(400, 'the input text data may contain sensitive content')).toBe('content-policy')
    expect(classifyHttpStatus(502, 'provider error')).toBe('transient')
  })

  it('classifies business codes per precedence', () => {
    expect(classifyBusinessCode('105')).toBe('auth')
    expect(classifyBusinessCode('115')).toBe('quota-exhausted')
    expect(classifyBusinessCode('9999')).toBe('unknown')
  })
})

describe('parseUsage', () => {
  it('parses the qoderUsage wrapper shape', () => {
    const usage = parseUsage({
      qoderUsage: {
        userType: 'personal_standard',
        expiresAt: 1780000000000,
        upgradeUrl: 'https://qoder.com/pricing',
        userQuota: { total: 1000, used: 200, remaining: 800, percentage: 0.2 },
        addOnQuota: { total: 500, used: 0, remaining: 500, percentage: 0 },
      },
    })
    expect(usage?.userQuota?.total).toBe(1000)
    expect(usage?.userQuota?.percentage).toBe(0.2)
    expect(usage?.addOnQuota?.remaining).toBe(500)
    expect(usage?.upgradeUrl).toBe('https://qoder.com/pricing')
  })

  it('parses requests quota shape', () => {
    const usage = parseUsage({
      requestsQuota: { total: 10, used: 3, remaining: 7, percentage: 0.3 },
    })
    expect(usage?.userQuota).toBeUndefined()
  })

  it('returns undefined-ish object for empty documents', () => {
    const usage = parseUsage({})
    expect(usage).toBeDefined()
    expect(usage?.userQuota).toBeUndefined()
  })
})