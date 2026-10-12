import { describe, expect, it } from 'vitest'
import {
  jobTokenBody,
  parseStreamDelta,
  classifyHttpStatus,
  classifyBusinessCode,
  isContentPolicy,
  parseUsage,
  QoderUpstreamError,
  QoderUpstreamClient,
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
describe('sash usage credential (regression)', () => {
  // 实测（2026-10，CN）：`sash/api/v2/me/usage` 只认 jobToken 交换产出的
  // `securityOauthToken`（`jt-…`）。
  //   - 裸 PAT        → 401 TOKEN_EXPIRE / token is not active
  //   - COSY 签名 bearer → 401 TOKEN_INVALID / invalid token
  //   - jt- 令牌       → 200 + 完整 qoderUsage
  // 之前用 COSY bearer 打这个端点，于是「令牌明明是好的、聊天也正常，积分却
  // 永远拿不到」。这里把选凭据的契约钉住。
  it('sends the jobToken oauth token, not the PAT or a COSY bearer', async () => {
    const seen: Array<{ url: string, auth: string | undefined }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const h = new Headers(init?.headers ?? {})
      seen.push({ url: u, auth: h.get('authorization') ?? undefined })
      // jobToken 交换返回一个 jt- 令牌；usage 端点据此答 200。
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-TESTTOKEN', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ qoderUsage: { addOnQuota: { total: 100, used: 8, remaining: 92 } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl })
    const usage = await client.fetchUsage('pt-whatever')

    const usageCall = seen.find(c => c.url.includes('/sash/api/v2/me/usage'))
    expect(usageCall).toBeDefined()
    // 关键断言：带的是 jt- 令牌（裸 PAT 与 COSY bearer 都会被拒）。
    expect(usageCall!.auth).toBe('Bearer jt-TESTTOKEN')
    expect(usage?.addOnQuota?.remaining).toBe(92)
  })
})

describe('每日签到（sash campaigns）', () => {
  // 协议来自社区参考实现（L0NE-6/Qoder-Daily），已在本机 CN 账号实测通过。
  // 路径里**没有**「签到」二字——它叫 campaigns（活动/权益），这正是早期把
  // `checkinSupported` 写死成 false 的原因（照 checkin/signin/reward 猜了 13 个
  // 路径全 404，于是误判成「Qoder 没有签到」）。
  function stub(campaigns: unknown[], claimResponse: { status: number, body: unknown }): { calls: Array<{ url: string, method: string, auth: string | undefined }>, client: QoderUpstreamClient } {
    const calls: Array<{ url: string, method: string, auth: string | undefined }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const h = new Headers(init?.headers ?? {})
      calls.push({ url: u, method: init?.method ?? 'GET', auth: h.get('authorization') ?? undefined })
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-CHECKIN', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.endsWith('/claim')) {
        return new Response(JSON.stringify(claimResponse.body), {
          status: claimResponse.status, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ campaigns }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { calls, client: new QoderUpstreamClient('cn', { fetch: fetchImpl }) }
  }

  it('parses a claimable campaign with its reward and validity', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100, validity: { days: 30 } } },
      { campaignId: 'c2', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
    ], { status: 200, body: { status: 'CLAIMED' } })
    const campaigns = await client.fetchCampaigns('pt-x')
    expect(campaigns).toHaveLength(2)
    expect(campaigns[0]).toMatchObject({ campaignId: 'c1', claimStatus: 'CLAIMABLE', amount: 100, validityDays: 30 })
  })

  it('claims the CLAIMABLE campaign and reports what was granted', async () => {
    const { calls, client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100, validity: { days: 30 } } },
    ], { status: 200, body: { status: 'CLAIMED' } })
    const out = await client.claimDailyCredits('pt-x')
    expect(out).toEqual({ status: 'claimed', amount: 100, validityDays: 30 })
    // 领取打的是 /{campaignId}/claim，且用与用量同一套 jt- 令牌。
    const claim = calls.find(c => c.url.endsWith('/claim'))
    expect(claim?.url).toContain('/sash/api/v1/me/campaigns/c1/claim')
    expect(claim?.method).toBe('POST')
    expect(claim?.auth).toBe('Bearer jt-CHECKIN')
  })

  it('treats a CLAIMED campaign as already claimed (idempotent, not an error)', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } },
    ], { status: 200, body: {} })
    expect(await client.claimDailyCredits('pt-x')).toEqual({ status: 'already-claimed' })
  })

  it('treats HTTP 409 on claim as already claimed', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' },
    ], { status: 409, body: { result: 'ALREADY_CLAIMED' } })
    expect(await client.claimDailyCredits('pt-x')).toEqual({ status: 'already-claimed' })
  })

  it('reports unavailable when no benefit campaign is issued today', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
    ], { status: 200, body: {} })
    const out = await client.claimDailyCredits('pt-x')
    expect(out.status).toBe('unavailable')
  })

  it('skips VIEW_DETAILS entries when picking what to claim', async () => {
    const { calls, client } = stub([
      { campaignId: 'detail', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' },
      { campaignId: 'benefit', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
    ], { status: 200, body: { status: 'CLAIMED' } })
    await client.claimDailyCredits('pt-x')
    expect(calls.find(c => c.url.endsWith('/claim'))?.url).toContain('/campaigns/benefit/claim')
  })
})
