import { describe, expect, it } from 'vitest'
import {
  jobTokenBody,
  parseStreamDelta,
  classifyHttpStatus,
  classifyBusinessCode,
  classifyFailure,
  businessCodeOf,
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

  // ==========================================================================
  // 「Qoder 拒绝了这个账号的 PAT」误判（用户实拍，国际版）
  //
  // 实测上游对**当日用量用尽**回的是 HTTP 403 + body `{"code":"110",…}`，而旧
  // 实现只看状态：403 → auth → credential-rejected → 叫用户去换 PAT。那个账号
  // 实测一切正常（换令牌 ✓、15 个模型 ✓、500 积分 ✓），只是今天用满了。
  // 官方码表里 105 才是凭据过期，110/113/115-119/122 全是用量与配额族。
  // ==========================================================================

  describe('业务码优先于 HTTP 状态（classifyFailure）', () => {
    // 现场抓到的那一条，逐字照抄（scripts/probe-cosy.mjs global --chat，2026-10-13）。
    const DAILY_LIMIT_BODY = '{"code":"110","message":"Billing daily count exceeded"}'

    it('实测的 403 + code 110 判成配额，不是凭据被拒', () => {
      expect(classifyFailure(403, DAILY_LIMIT_BODY)).toBe('quota-exhausted')
      // 变异检查：把 classifyFailure 改回 classifyHttpStatus，这条立刻红。
      expect(classifyHttpStatus(403, DAILY_LIMIT_BODY)).toBe('auth')
    })

    it('整条 SSE 信封路径也走同一个判断（用户实拍就是从这里来的）', () => {
      const frame = JSON.stringify({ body: DAILY_LIMIT_BODY, statusCodeValue: 403 })
      try {
        parseStreamDelta(frame)
        expect.unreachable('应该抛错')
      } catch (error) {
        expect((error as QoderUpstreamError).kind).toBe('quota-exhausted')
        // 业务码要留在错误上：卡片与池记录都靠它溯源。
        expect((error as QoderUpstreamError).code).toBe('110')
      }
    })

    it('真正的凭据过期（105）仍然判成 auth —— 修复不能把另一侧改坏', () => {
      expect(classifyFailure(403, '{"code":"105","message":"Login expired"}')).toBe('auth')
      expect(classifyFailure(401, '{"code":"105","message":"Login expired"}')).toBe('auth')
    })

    it('认不出的码回落到 HTTP 状态（行为与改动前一致）', () => {
      // sash 面的 TOKEN_EXPIRE 是**字符串**码，不在官方数值码表里：必须仍按
      // 状态判成 auth，否则「凭据真被拒」也会被吞掉。
      expect(classifyFailure(401, '{"code":"TOKEN_EXPIRE","message":"token is not active"}')).toBe('auth')
      expect(classifyFailure(403, 'not json at all')).toBe('auth')
      expect(classifyFailure(403, '')).toBe('auth')
      expect(classifyFailure(429, '{"code":"99999"}')).toBe('rate-limited')
    })

    it('配额族全覆盖（官方码表 110/113/115-119/122 + 早期实测的 402/6004）', () => {
      for (const code of ['110', '113', '115', '116', '117', '118', '119', '122', '402', '6004']) {
        expect(classifyFailure(403, `{"code":"${code}"}`)).toBe('quota-exhausted')
      }
    })

    it('请求类与瞬时类也按码分（406 内容策略 / 80411 输入过长 / 10500 服务内部错）', () => {
      expect(classifyFailure(400, '{"code":"406","message":"blocked"}')).toBe('content-policy')
      expect(classifyFailure(403, '{"code":"80411","message":"input too long"}')).toBe('invalid-request')
      expect(classifyFailure(403, '{"code":"10500","message":"internal"}')).toBe('transient')
    })
  })

  describe('businessCodeOf', () => {
    it('字符串码与裸数字码都收（上游两种写法都见过）', () => {
      expect(businessCodeOf('{"code":"110"}')).toBe('110')
      expect(businessCodeOf('{"code":110}')).toBe('110')
    })

    it('取不到就返回 undefined，绝不猜一个', () => {
      expect(businessCodeOf('')).toBeUndefined()
      expect(businessCodeOf('plain text')).toBeUndefined()
      expect(businessCodeOf('{ not json')).toBeUndefined()
      expect(businessCodeOf('{"message":"no code here"}')).toBeUndefined()
      // 非整数不是上游的错误码形态。
      expect(businessCodeOf('{"code":1.5}')).toBeUndefined()
      // 数组体没有 code 字段可言：首字符不是 `{` 就直接否掉。
      expect(businessCodeOf('[1,2,3]')).toBeUndefined()
    })
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
      // 两族交换端点都要应答：`/algo/api/v3/user/jobToken`（chat 那一族）与
      // `/api/v1/jobToken/exchange`（sash 那一族）。它们都含 "jobToken"，所以
      // 按路径区分而不是按子串 —— 否则 sash 那枚会被当成 chat 的答，桩就假了。
      if (u.includes('/api/v1/jobToken/exchange')) {
        return new Response(JSON.stringify({
          token: 'jt-SASH', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
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

  // ======================================================================
  // 两族令牌并存：chat 用旧的，sash 用新的。
  //
  // 国际版的实测（本机两个真实 PAT，见 tests/live-intl-session.spec.ts）：
  //   chat/cosy 面只认 `/algo/api/v3/user/jobToken` 的 securityOauthToken
  //   sash/额度面只认 `/api/v1/jobToken/exchange` 的 token
  // 国内版两族等价，所以这个差异**只在国际版显形**。
  // ======================================================================

  /** A stub that answers BOTH exchanges and records which token each call used. */
  function dualTokenStub(): {
    calls: Array<{ url: string, auth: string | undefined }>
    chatAuth: () => string | undefined
    sashAuth: () => string | undefined
    client: QoderUpstreamClient
  } {
    const calls: Array<{ url: string, auth: string | undefined }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const h = new Headers(init?.headers ?? {})
      calls.push({ url: u, auth: h.get('authorization') ?? undefined })
      if (u.includes('/api/v1/jobToken/exchange')) {
        return new Response(JSON.stringify({
          token: 'jt-SASH-TOKEN',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-CHAT-TOKEN', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/me/usage')) {
        return new Response(JSON.stringify({ qoderUsage: { userQuota: { total: 10 } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return {
      calls,
      chatAuth: () => calls.find(c => c.auth?.includes('COSY.'))?.auth,
      sashAuth: () => calls.find(c => c.url.includes('/sash/'))?.auth,
      client: new QoderUpstreamClient('cn', { fetch: fetchImpl }),
    }
  }

  it('两次交换都发生：chat 那一族 + sash 那一族', async () => {
    const { calls, client } = dualTokenStub()
    await client.fetchUsage('pt-x').catch(() => undefined)
    const exchanges = calls.filter(c => c.url.includes('jobToken')).map(c => c.url)
    // 两条都要在 —— 少任何一条，对应的面就通不了。
    expect(exchanges.some(u => u.includes('/api/v1/jobToken/exchange'))).toBe(true)
    expect(exchanges.some(u => u.includes('/algo/api/v3/user/jobToken'))).toBe(true)
  })

  it('sash 面用 sash 那一族的令牌，不是 chat 那一族的', async () => {
    const { client, sashAuth } = dualTokenStub()
    await client.fetchUsage('pt-x').catch(() => undefined)
    expect(sashAuth()).toBe('Bearer jt-SASH-TOKEN')
    // 明确不许回落到旧令牌：国际版会 401。
    expect(sashAuth()).not.toBe('Bearer jt-CHAT-TOKEN')
  })

  it('签到面同样用 sash 那一族的令牌', async () => {
    const { calls, client } = dualTokenStub()
    await client.fetchCampaigns('pt-x').catch(() => undefined)
    const campaigns = calls.find(c => c.url.includes('/campaigns'))
    expect(campaigns?.auth).toBe('Bearer jt-SASH-TOKEN')
  })

  it('sash 交换失败时不抛 —— 只让积分读不到，对话照常', async () => {
    // 「换不到 sash 令牌」绝不能变成「整个会话建立失败」：那是完全不同的两条链路。
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/v1/jobToken/exchange')) return new Response('nope', { status: 500 })
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-CHAT-TOKEN', refreshToken: 'jrt-x',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl })
    // 会话建立成功（没有抛）。
    const holder = await client.ensureSession('pt-x')
    expect(holder.jobToken.securityOauthToken).toBe('jt-CHAT-TOKEN')
    // sash 令牌缺席 → 读积分会失败，但那是「读不到」而不是「会话坏了」。
    expect(holder.sashToken).toBeUndefined()
  })

  it('上游不认 personal_access_token 那个拼写（回 400），所以 body 用 personal_token', async () => {
    // eghrhegpe 那个 fork 用的是 personal_access_token；实测当前上游回
    // 400 BadRequest，两个区域都是。这里钉住我们用的那个键。
    const bodies: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/v1/jobToken/exchange')) {
        bodies.push(String(init?.body ?? ''))
        return new Response(JSON.stringify({ token: 'jt-SASH-TOKEN' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6, securityOauthToken: 'jt-CHAT-TOKEN',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl })
    await client.fetchUsage('pt-x').catch(() => undefined)
    expect(bodies[0]).toContain('personal_token')
    expect(bodies[0]).not.toContain('personal_access_token')
  })

  it('**第一次**读积分就已经用 sash 令牌（不许有「先 401 再 200」的竞态）', async () => {
    // 曾经的真实故障：sash 交换放后台，于是紧接着的第一次读带着空令牌去，
    // 拿到 401 —— 而那个 401 与「真被拒」长得一模一样，排查极贵。
    const { sashAuth, client } = dualTokenStub()
    await client.fetchUsage('pt-x').catch(() => undefined)
    // 不重试、不等待：第一发就该带上正确的令牌。
    expect(sashAuth()).toBe('Bearer jt-SASH-TOKEN')
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
    // sash 面用**专用那族**令牌（`/api/v1/jobToken/exchange` 的 token），不是 chat
    // 那一族的 securityOauthToken —— 国际版只认前者（见 live-intl-session.spec.ts）。
    expect(claim?.auth).toBe('Bearer jt-SASH')
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

  // ======================================================================
  // 「下一次刷新」= 上游活动行的 `endAt`，不是本地算的。
  //
  // 实测（只读拉取，未领取）cn 区域的 campaigns 原文：
  //   { campaignId: '01a12102-…', campaignKey: 'act-20261009-057',
  //     actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED',
  //     startAt: 1791770400, endAt: 1791856740,      ← 活动窗
  //     benefit: { kind: 'CREDITS', amount: 100,
  //                 validity: { mode: 'RELATIVE_DAYS', days: 30 } } }
  // 换算（UTC+8）：startAt = 当天 10:00:00，endAt = 次日 09:59:00 —— 与活动文案
  // 「每日 10:00（UTC+8）刷新」一致。用户实拍里官网页面上那个 `09:22:23`
  // 就是 `endAt − 当前时间`。
  //
  // 领取**不是**「今天到此为止」：领取只是把这一窗从 CLAIMABLE 变成 CLAIMED，
  // 下一窗何时开上游早就写在 endAt 里了。此前 UI 只能说「已领取」，用户会以为
  // 要等到第二天零点。
  // ======================================================================

  it('parses the activity window (startAt/endAt, epoch SECONDS) from campaigns', async () => {
    const { client } = stub([
      { campaignId: 'c1', campaignKey: 'act-20261009-057', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1791770400, endAt: 1791856740, benefit: { amount: 100 } },
    ], { status: 200, body: {} })
    const [campaign] = await client.fetchCampaigns('pt-x')
    // 保持上游的**秒**，不做 ×1000：这个字段的「×1000」发生在它要变成
    // 毫秒时间戳的那一刻（`claimDailyCredits` 的 nextRefreshAtMs），
    // 在解析层就换算会让 startAt/endAt 单位不一致（实测 bug 的形状）。
    expect(campaign?.startAt).toBe(1791770400)
    expect(campaign?.endAt).toBe(1791856740)
  })

  it('reports nextRefreshAtMs after a claim (endAt → ms)', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', startAt: 1791770400, endAt: 1791856740, benefit: { amount: 100, validity: { days: 30 } } },
    ], { status: 200, body: { status: 'CLAIMED' } })
    const out = await client.claimDailyCredits('pt-x')
    expect(out.status).toBe('claimed')
    if (out.status !== 'claimed') throw new Error('expected claimed')
    expect(out.nextRefreshAtMs).toBe(1791856740 * 1000)
  })

  it('reports nextRefreshAtMs even when ALREADY claimed — 「已领过」也要带刷新时刻', async () => {
    // 否则用户看到「已领取」却不知道要等多久，只能猜到第二天零点。
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', startAt: 1791770400, endAt: 1791856740, benefit: { amount: 100 } },
    ], { status: 200, body: {} })
    const out = await client.claimDailyCredits('pt-x')
    expect(out.status).toBe('already-claimed')
    if (out.status !== 'already-claimed') throw new Error('expected already-claimed')
    expect(out.nextRefreshAtMs).toBe(1791856740 * 1000)
  })

  it('keeps nextRefreshAtMs on the 409 (repeat-claim) path too', async () => {
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', endAt: 1791856740 },
    ], { status: 409, body: { result: 'ALREADY_CLAIMED' } })
    const out = await client.claimDailyCredits('pt-x')
    expect(out.status).toBe('already-claimed')
    if (out.status !== 'already-claimed') throw new Error('expected already-claimed')
    expect(out.nextRefreshAtMs).toBe(1791856740 * 1000)
  })

  it('omits nextRefreshAtMs when the upstream states no window', async () => {
    // 上游没给就不编：绝不用本地零点或「上次 +24h」造一个倒计时。
    const { client } = stub([
      { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
    ], { status: 200, body: { status: 'CLAIMED' } })
    const out = await client.claimDailyCredits('pt-x')
    expect(out.status).toBe('claimed')
    expect('nextRefreshAtMs' in out).toBe(false)
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

// ==========================================================================
// 每条**真路径**都按业务码分（不是只有纯函数被覆盖）
//
// 这是本项目反复踩过的坑：判据（classifyFailure）写在纯函数里、测得很足，
// 而六个调用点各接线一次 —— 只要有一处仍用 classifyHttpStatus，那条路径
// 就照旧把 403 判成凭据被拒，而全量测试照样绿。第一轮就是这样：只改
// chatStream 那一行，43 条测试全过。下面按端点逐条钉，每条都让**上游真的
// 回 403 + code 110**，断言抛出来的 kind 与 code。
//
// 顺带钉住「认不出的码不能被改坏」：sash 面的 `TOKEN_EXPIRE` 是字符串码，
// 不在官方数值码表里，必须仍按状态判成 auth —— 否则真过期的凭据会被说成
// 「这次没读到」。
// ==========================================================================
describe('真路径按业务码分类（六个调用点逐一钉住）', () => {
  const DAILY = '{"code":"110","message":"Billing daily count exceeded"}'

  // 本组统一用 `cn` 区域：分类逻辑（classifyFailure）与区域无关，而 `global`
  // 会去 `deviceRiskHeaders()` 找本机 UMID 组件 —— CI 上没有它直接抛普通 Error，
  // 就测不到「上游回 403+110 该抛哪种 QoderUpstreamError」了。设备风控本身由
  // `tests/device-risk.spec.ts` 单独覆盖，不在这里混进分类断言。
  /** 让指定 URL 片段回 `status` + `body`，其余端点照常应答。 */
  function failingStub(failWhen: (u: string) => boolean, status: number, body: string): QoderUpstreamClient {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (failWhen(u)) {
        return new Response(body, { status, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/api/v1/jobToken/exchange')) {
        return new Response(JSON.stringify({
          token: 'jt-SASH', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-CHAT', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 其余一律给个能解析的空 JSON：本组只关心失败那一发。
      return new Response(JSON.stringify({ campaigns: [], models: [], qoderUsage: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return new QoderUpstreamClient('cn', { fetch: fetchImpl })
  }

  /** 跑一次并取回抛出的错误（不抛则直接失败——这些路径必须抛）。 */
  async function thrown(run: () => Promise<unknown>): Promise<QoderUpstreamError> {
    try {
      await run()
    } catch (error) {
      expect(error, '上游错误应当抛出').toBeInstanceOf(QoderUpstreamError)
      return error as QoderUpstreamError
    }
    return expect.unreachable('应该抛出 QoderUpstreamError') as never
  }

  it('exchangeJobToken：换令牌本身回 403+110 时不判成凭据被拒', async () => {
    // 直接打 exchangeJobToken（它是公开方法）：用 fetchUsage 包一层的话会先落进
    // 「403 → 回退直连」的分支，而直连在桩里是 200，于是测不到换令牌那一条。
    const client = failingStub(u => u.includes('jobToken'), 403, DAILY)
    const error = await thrown(() => client.exchangeJobToken('pt-x'))
    expect(error.kind).toBe('quota-exhausted')
    expect(error.code).toBe('110')
  })

  it('jobTokenGet（积分主路径）：403+110 判配额 —— 这条直通卡片的「PAT 已不被接受」', async () => {
    // 危害最大的一个：`refreshUsage` 把 `kind === 'auth'` 记成
    // credential-rejected，卡片于是说「PAT 已不被 Qoder 接受」。
    const client = failingStub(u => u.includes('/me/usage'), 403, DAILY)
    const error = await thrown(() => client.fetchUsage('pt-x'))
    expect(error.kind).toBe('quota-exhausted')
    expect(error.code).toBe('110')
  })

  it('sashRequest（积分回退路径）：两条都失败时抛出的仍是配额，不是凭据', async () => {
    // 回退路径 fetchUsageDirect 也走同一处分类：主路径与回退都回 403+110 时，
    // 报出去的 kind 决定用户被引导去干什么。
    const client = failingStub(u => u.includes('/me/usage'), 403, DAILY)
    const error = await thrown(() => client.fetchUsage('pt-x'))
    expect(error.kind).not.toBe('auth')
  })

  it('campaigns：活动列表面 403+110 同样不判成凭据被拒', async () => {
    const campaigns = await thrown(() => failingStub(u => u.includes('/campaigns'), 403, DAILY).fetchCampaigns('pt-x'))
    expect(campaigns.kind).toBe('quota-exhausted')
  })

  it('claim：领取那一发 403+110 不判成凭据被拒（用 claimable 活动让它走到 /claim）', async () => {
    // claimDailyCredits 先列活动：列表必须给出一个 CLAIMABLE 的 CLAIM_BENEFIT，
    // 否则它直接返回 unavailable，从不发 /claim —— 那就测不到领取那一条。
    const claimable = { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/claim')) {
        return new Response(DAILY, { status: 403, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/api/v1/jobToken/exchange')) {
        return new Response(JSON.stringify({
          token: 'jt-SASH', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-CHAT', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/campaigns')) {
        return new Response(JSON.stringify({ campaigns: [claimable] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl })
    const claim = await thrown(() => client.claimDailyCredits('pt-x'))
    expect(claim.kind).toBe('quota-exhausted')
  })

  it('fetchModels（模型列表）：403+110 判配额 —— 否则「加模型」也会被当成凭据被拒', async () => {
    // bearerGet 是 models 目录的主取数路径：上游回 403+110 时，卡片就会在
    // 「模型列表」上再报一句 PAT 被拒，用户会在每个刷新的入口重复撞上。
    const client = failingStub(u => u.includes('/model/list'), 403, DAILY)
    const error = await thrown(() => client.fetchModels('pt-x'))
    expect(error.kind).toBe('quota-exhausted')
    expect(error.code).toBe('110')
  })

  it('chatStream：上游回非 200 + code 110 时判配额，并把码带在错误上', async () => {
    const client = failingStub(u => u.includes('/sse/') || u.includes('chat'), 403, DAILY)
    const error = await thrown(() => client.chatStream('pt-any', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} }))
    expect(error.kind).toBe('quota-exhausted')
    expect(error.status).toBe(403)
    expect(error.code).toBe('110')
  })

  it('真被拒的那一侧不能被改坏：401 + 字符串码 TOKEN_EXPIRE 仍判 auth', async () => {
    // 官方码表里没有 TOKEN_EXPIRE 这个码：businessCodeOf 取得到值但
    // classifyBusinessCode 认不出 → 回落 HTTP 状态 → auth。这条是「修复不能
    // 把过期凭据说成没问题」的保险。
    const client = failingStub(u => u.includes('/me/usage'), 401, '{"code":"TOKEN_EXPIRE","message":"token is not active"}')
    const error = await thrown(() => client.fetchUsage('pt-x'))
    expect(error.kind).toBe('auth')
  })

  it('SSE 信封（HTTP 200 建流后包错误）也按码分 —— 用户实拍就是从这里来的', () => {
    const frame = JSON.stringify({ body: DAILY, statusCodeValue: 403 })
    try {
      parseStreamDelta(frame)
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as QoderUpstreamError).kind).toBe('quota-exhausted')
      expect((error as QoderUpstreamError).code).toBe('110')
    }
  })
})
