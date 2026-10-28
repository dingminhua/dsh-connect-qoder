import { describe, expect, it } from 'vitest'
import {
  jobTokenBody,
  parseStreamDelta,
  classifyHttpStatus,
  classifyBusinessCode,
  classifyFailure,
  businessCodeOf,
  deepestBusinessCode,
  isContentPolicy,
  parseUsage,
  projectCampaignEntry,
  QoderUpstreamError,
  QoderUpstreamClient,
  QODER_REGIONS,
} from '../src/upstream.ts'
import { cosyDecode } from '../src/cosy.ts'
import { QODER_CONSOLE_DOMAIN, QODER_UPSTREAM_DOMAIN } from '../src/status-paths.ts'

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

  it('网关主机名与卡片「诊断」栏读的是同一处事实', () => {
    // 诊断栏要回答「这次请求打到哪个域名」，它读 `QODER_UPSTREAM_DOMAIN`。
    // 若两者各存一份域名，漂移过一次就会让面板写着 A、请求打着 B——而两边都
    // 看起来完全正常。这里钉住它们逐字相等。
    expect(QODER_REGIONS.cn.gateway).toBe(`https://${QODER_UPSTREAM_DOMAIN.cn}`)
    expect(QODER_REGIONS.global.gateway).toBe(`https://${QODER_UPSTREAM_DOMAIN.global}`)
    // 网关域名与控制台域名**不是**同一个（国际版尤其明显：控制台 qoder.com，
    // 网关 api1.qoder.sh），所以诊断栏不能用控制台域名顶替。
    expect(QODER_UPSTREAM_DOMAIN.global).not.toBe(QODER_CONSOLE_DOMAIN.global)
    expect(QODER_UPSTREAM_DOMAIN.cn).not.toBe(QODER_CONSOLE_DOMAIN.cn)
  })
})

describe('fetchModels 丢掉上游的 `auto` 路由器', () => {
  /**
   * 实测（本机真实存档）：上游名册的第一条就是 `auto` —— displayName `Auto`、
   * `is_default: true`、没有任何思考档位。它是该区的**默认路由**，网关在请求时
   * 才决定把它解析成哪一个模型，所以价格、窗口与行为都由别人临时决定，插件无法
   * 如实描述。把它当成一个可勾选的模型列出来，用户勾的是一个「未知会变成谁」的
   * 条目。
   *
   * 参考 dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）：
   * 那边用显式表 `ROUTER_MODEL_IDS` 而非名字启发式，本仓库照做。
   */
  function rosterStub(chat: unknown[]): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'n', expireTime: Date.now() + 1e6,
          securityOauthToken: 'jt-T', refreshToken: 'jrt-x', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ chat }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  it('名册里的 auto 不出现，真模型一个不少', async () => {
    const client = new QoderUpstreamClient('cn', {
      fetch: rosterStub([
        { key: 'auto', display_name: 'Auto', is_default: true, is_free: false, is_vl: false },
        { key: 'qfmodel', display_name: 'Qwen3.8-Flash', is_free: true, is_vl: true },
        { key: 'dfmodel', display_name: 'DeepSeek-Flash', is_vl: true },
      ]),
    })
    const models = await client.fetchModels('pt-x')
    expect(models.map(m => m.key)).toEqual(['qfmodel', 'dfmodel'])
  })

  it('名册只有 auto 时得到空数组，而不是抛错', async () => {
    // 「上游改了路由器」不该被放大成「这个区域坏了」。调用方（`QoderCatalog.set`
    // 拒绝空数组、`configuredModels` 有兜底）本来就能处理空结果。
    const client = new QoderUpstreamClient('cn', {
      fetch: rosterStub([{ key: 'auto', display_name: 'Auto', is_default: true }]),
    })
    await expect(client.fetchModels('pt-x')).resolves.toEqual([])
  })

  it('只认显式表，不按名字模糊匹配', async () => {
    // `auto` 之外还有真模型名字里带 auto（`autopilot`）——把它们一起丢掉就是
    // 名字启发式的代价。判据是显式 id 表。
    const client = new QoderUpstreamClient('cn', {
      fetch: rosterStub([
        { key: 'autopilot', display_name: 'Autopilot', is_vl: false },
        { key: 'auto', display_name: 'Auto', is_default: true },
      ]),
    })
    const models = await client.fetchModels('pt-x')
    expect(models.map(m => m.key)).toEqual(['autopilot'])
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

  /**
   * 缓存命中数（issue #4）。
   *
   * 下面这个 `usage` 块是**真实抓包的原文**（2026-10-22，cn 区 `qfmodel`，两轮
   * 带同一段长前缀的请求），不是构造出来的例子：
   *
   * ```
   * { billable: false, completion_tokens: 38,
   *   completion_tokens_details: { reasoning_tokens: 35 }, credits: 0.006901532,
   *   original_credits: 0.006901532, prompt_tokens: 2038,
   *   prompt_tokens_details: { cacheable_tokens: 0, cached_tokens: 2032 },
   *   total_tokens: 2076 }
   * ```
   *
   * 它同时证明三件事：上游**确实**下发 `cached_tokens`（所以这是本插件的透传
   * 缺陷，不是上游没给）；它就在 `prompt_tokens_details` 里（宿主读的那一处）；
   * 而且它是 `prompt_tokens` 的**子集**（2032 < 2038），不能相加。
   */
  it('extracts prompt_tokens_details.cached_tokens from a real captured frame', () => {
    const frame = JSON.stringify({
      body: JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: {
          billable: false,
          completion_tokens: 38,
          completion_tokens_details: { reasoning_tokens: 35 },
          credits: 0.006901532,
          original_credits: 0.006901532,
          prompt_tokens: 2038,
          prompt_tokens_details: { cacheable_tokens: 0, cached_tokens: 2032 },
          total_tokens: 2076,
        },
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.cachedTokens).toBe(2032)
    // **子集，不是增量**：inputTokens 必须仍是原始的 prompt_tokens。
    // 写 `prompt_tokens + cached_tokens` 会把命中前缀算两遍，宿主那边也会再减一次。
    expect(delta?.inputTokens).toBe(2038)
  })

  it('reads the two other spellings providers use for the same quantity', () => {
    // 同一个量的三种写法（宿主 parseChunkUsage 里列过同一张表）：OpenAI 的
    // `prompt_tokens_details.cached_tokens`、DeepSeek 的
    // `prompt_cache_hit_tokens`、以及平铺的 `cached_tokens`。
    const frameOf = (usage: Record<string, unknown>): string => JSON.stringify({
      body: JSON.stringify({ choices: [{ index: 0, delta: {} }], usage }),
      statusCodeValue: 200,
    })
    expect(parseStreamDelta(frameOf({ prompt_tokens: 100, prompt_cache_hit_tokens: 64 }))?.cachedTokens).toBe(64)
    expect(parseStreamDelta(frameOf({ prompt_tokens: 100, cached_tokens: 32 }))?.cachedTokens).toBe(32)
    // 两个都在时取第一个（标准位置优先），**不相加**——它们是同一个量。
    expect(parseStreamDelta(frameOf({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 64 },
      prompt_cache_hit_tokens: 64,
    }))?.cachedTokens).toBe(64)
  })

  it('leaves cachedTokens undefined when upstream did not report it', () => {
    // 「上游没报」与「命中 0 个」必须能分开：前者是 undefined，后者是 0。
    // 折成 0 就等于用一个默认值假装上游报了数——issue #4 的症状正是「那个 0%
    // 不可信」，用一个假 0 去修它只是把病留下。
    const frame = JSON.stringify({
      body: JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.cachedTokens).toBeUndefined()
    expect('cachedTokens' in (delta ?? {})).toBe(false)
  })

  it('accepts a reported zero, which is a real answer', () => {
    // 上游明确报 `cached_tokens: 0` = 「这次一个都没命中」（冷启动那一轮就是
    // 这个形状）。它是有效答案，必须原样透传，不能因为「假值」被吞掉。
    const frame = JSON.stringify({
      body: JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
      }),
      statusCodeValue: 200,
    })
    const delta = parseStreamDelta(frame)
    expect(delta?.cachedTokens).toBe(0)
    expect('cachedTokens' in (delta ?? {})).toBe(true)
  })

  it('ignores nonsense in the cached field instead of reporting it', () => {
    // 上游的字段类型偶尔会漂（字符串、负数、NaN）。这些都不是「命中数」，
    // 当没报处理 —— 宁可显示「上游未提供」，也不显示一个编出来的数字。
    const frameOf = (usage: Record<string, unknown>): string => JSON.stringify({
      body: JSON.stringify({ choices: [{ index: 0, delta: {} }], usage }),
      statusCodeValue: 200,
    })
    expect(parseStreamDelta(frameOf({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: '64' } }))?.cachedTokens)
      .toBeUndefined()
    expect(parseStreamDelta(frameOf({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: -1 } }))?.cachedTokens)
      .toBeUndefined()
    expect(parseStreamDelta(frameOf({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: Number.NaN } }))?.cachedTokens)
      .toBeUndefined()
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

// ==========================================================================
// 业务码藏在第二/三层（issue #6）
//
// 现场帧（用户实拍，CN 区）：
//
//   {"code":403,"message":"{\"code\":\"10605\",\"message\":\"qmodel 排队中，请稍后重试\"}"}
//
// 外层那个 403 是 HTTP 语义的码，认不出；真正的业务码 10605（排队）藏在内层
// message 里。旧实现只剥一层 ⇒ 读不到码 ⇒ 回落 HTTP 状态 ⇒ 403 → auth ⇒
// credential-rejected ⇒ **账号被永久剔除且不自愈**，同时叫用户去换一个
// 根本没坏的 PAT。
//
// 10605 / 10408 本来就在 TRANSIENT_CODES 里：码表没缺，缺的是「读到它」。
// ==========================================================================
describe('嵌套业务码下钻（issue #6）', () => {
  /** 用户实拍的那一帧，逐字照抄。 */
  const QUEUE_FRAME = '{"code":403,"message":"{\\"code\\":\\"10605\\",\\"message\\":\\"qmodel 排队中，请稍后重试\\"}"}'

  it('实拍帧：403 外壳里的 10605 判成 transient，不是 auth', () => {
    expect(classifyFailure(403, QUEUE_FRAME)).toBe('transient')
    // 变异检查：把 classifyFailure 换回 classifyHttpStatus / businessCodeOf，
    // 这条立刻红（旧实现给的是 auth）。
    expect(classifyHttpStatus(403, QUEUE_FRAME)).toBe('auth')
  })

  it('已知码藏在深层（外层 403 + 内层 402）判成 quota-exhausted', () => {
    const frame = '{"code":403,"message":"{\\"code\\":\\"402\\",\\"message\\":\\"insufficient balance\\"}"}'
    expect(classifyFailure(403, frame)).toBe('quota-exhausted')
  })

  it('10408（p2 排队）在 429 外壳里也判成 transient', () => {
    const frame = '{"code":429,"message":"{\\"code\\":\\"10408\\",\\"message\\":\\"p2 queueing\\"}"}'
    expect(classifyFailure(429, frame)).toBe('transient')
    // 变异检查：旧实现只读外层 ⇒ 回落 429 ⇒ rate-limited。
    expect(classifyHttpStatus(429, frame)).toBe('rate-limited')
  })

  it('错误上带的是**真正的**业务码（卡片与池记录靠它溯源）', () => {
    expect(deepestBusinessCode(QUEUE_FRAME)).toBe('10605')
    // 外层那个 HTTP 语义的 403 不该盖住里层的真码。
    expect(deepestBusinessCode('{"code":403,"message":"{\\"code\\":\\"10605\\"}"}')).toBe('10605')
  })

  it('认不出的外层码不早退：记下来、继续往里找', () => {
    // 外层 403 认不出（不在官方码表），里层 110 才认得出 —— 先返回外层就还是
    // auth，所以「认不出就继续找」这条纪律是承重的。
    const frame = '{"code":403,"message":"{\\"code\\":\\"110\\",\\"message\\":\\"Billing daily count exceeded\\"}"}'
    expect(classifyFailure(403, frame)).toBe('quota-exhausted')
  })

  it('下钻只沿 message 走（不走 error/data 这类更宽的键）', () => {
    // 刻意不宽化：宽化会把外层信封那个 HTTP 语义的 code（或 code: 0 之类无关
    // 字段）当成业务码返回 —— 那比旧实现更糟，因为认出的码会盖住真码。
    const frame = '{"code":403,"error":"{\\"code\\":\\"10605\\"}"}'
    expect(deepestBusinessCode(frame)).toBe('403')
    expect(classifyFailure(403, frame)).toBe('auth')
  })

  it('认不出就原样回落 HTTP 状态（真被拒的那一侧逐字不变）', () => {
    expect(classifyFailure(401, '{"code":"TOKEN_EXPIRE","message":"token is not active"}')).toBe('auth')
    expect(classifyFailure(403, 'not json at all')).toBe('auth')
    expect(classifyFailure(403, '')).toBe('auth')
    expect(classifyFailure(429, '{"code":"99999"}')).toBe('rate-limited')
    // 业务码 105（登录态/令牌过期）仍然是 auth —— 修复不能把另一侧改坏。
    expect(classifyFailure(403, '{"code":"105","message":"Login expired"}')).toBe('auth')
  })

  it('深度有上限：自嵌套不会把解析变成死循环', () => {
    // 三层（在下钻上限内）：读到最深的真码。
    let shallow = '{"code":"10605"}'
    for (let i = 0; i < 3; i += 1) shallow = JSON.stringify({ code: 403, message: shallow })
    expect(deepestBusinessCode(shallow)).toBe('10605')

    // 二十层（远超上限）：不崩、不死循环，认不出的外层码作为 fallback 返回。
    let deep = '{"code":"10605"}'
    for (let i = 0; i < 20; i += 1) deep = JSON.stringify({ code: 403, message: deep })
    expect(() => classifyFailure(403, deep)).not.toThrow()
    expect(deepestBusinessCode(deep)).toBe('403')
  })

  it('非对象 / 数组 / 非整数码都不产出业务码', () => {
    expect(deepestBusinessCode('[1,2,3]')).toBeUndefined()
    expect(deepestBusinessCode('{"code":1.5}')).toBeUndefined()
    expect(deepestBusinessCode('{"message":"no code here"}')).toBeUndefined()
    expect(deepestBusinessCode('')).toBeUndefined()
  })
})

// ==========================================================================
// 活动面（feed）：banner 与顶层字段。
//
// 用户实拍（2026-10-25，CN）：旧版能读「每天领 100 Credits / 1024 创造力集结 /
// 首月翻倍」，本版此前把 `VIEW_DETAILS` 的活动行**跳过了**。这里测的是卡片「活动」
// 区真正消费的那份 feed——`fetchCampaigns` 只是它的窄投影，两者不许漂移。
// ==========================================================================

describe('campaign feed (活动面)', () => {
  /** 一个「交换令牌 + 指定活动响应」的桩，记录每次请求的 url 与 authorization。 */
  function feedStub(body: unknown): {
    client: QoderUpstreamClient
    calls: Array<{ url: string, auth: string | undefined }>
  } {
    const calls: Array<{ url: string, auth: string | undefined }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, auth: new Headers(init?.headers ?? {}).get('authorization') ?? undefined })
      if (u.includes('/api/v1/jobToken/exchange')) {
        return new Response(JSON.stringify({ token: 'jt-SASH-TOKEN', expires_at: new Date(Date.now() + 86_400_000).toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({ id: 'u1', name: 'n', expireTime: Date.now() + 1e6, securityOauthToken: 'jt-CHAT-TOKEN', refreshToken: 'jrt-x' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { client: new QoderUpstreamClient('cn', { fetch: fetchImpl }), calls }
  }

  /** 2026-10-25 CN 实测形状（两条 placement 的文案重复，见 `projectCampaignEntry`）。 */
  const PLACED = {
    campaignId: 'c1', campaignKey: 'act-20261021-587', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE',
    startAt: 1792893600, endAt: 1792979940,
    benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    placements: [
      {
        type: 'POPUP', campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
        content: {
          zh: { title: '每天领 100 Credits', description: '每日 10:00（UTC+8）刷新，领取后 30 天有效', detailUrl: 'https://docs.qoder.cn/events/100credits' },
          en: { title: 'Claim 100 Credits Daily', description: 'Daily reset: 10:00 (UTC+8). Valid for 30 days after claiming.', detailUrl: 'https://docs.qoder.cn/en/events/100credits' },
        },
      },
      {
        type: 'USAGE', campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
        content: { zh: { title: '每天领 100 Credits', description: '每日 10:00（UTC+8）刷新，领取后 30 天有效', detailUrl: 'https://docs.qoder.cn/events/100credits' } },
      },
    ],
  }

  it('把 placements 里的中英文案与 detailUrl 收进条目', async () => {
    const { client } = feedStub({ uid: 'u1', showCampaign: true, claimable: false, campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe', campaigns: [PLACED] })
    const feed = await client.fetchCampaignFeed('pt-x')
    expect(feed.campaigns).toHaveLength(1)
    const row = feed.campaigns[0]
    expect(row?.content?.zh?.title).toBe('每天领 100 Credits')
    expect(row?.content?.zh?.description).toContain('每日 10:00')
    expect(row?.content?.zh?.detailUrl).toBe('https://docs.qoder.cn/events/100credits')
    expect(row?.content?.en?.title).toBe('Claim 100 Credits Daily')
    expect(row?.amount).toBe(100)
    expect(row?.validityDays).toBe(30)
    expect(row?.campaignKey).toBe('act-20261021-587')
  })

  it('透出顶层的 campaignUrl / showCampaign / claimable', async () => {
    const { client } = feedStub({ showCampaign: true, claimable: false, campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe', campaigns: [PLACED] })
    const feed = await client.fetchCampaignFeed('pt-x')
    expect(feed.campaignUrl).toBe('https://openapi.qoder.com.cn/growth-page/activity-iframe')
    expect(feed.showCampaign).toBe(true)
    expect(feed.claimable).toBe(false)
  })

  it('顶层字段缺席时不造（宽容解析）', async () => {
    const { client } = feedStub({ campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }] })
    const feed = await client.fetchCampaignFeed('pt-x')
    expect(feed.campaignUrl).toBeUndefined()
    expect(feed.showCampaign).toBeUndefined()
    expect(feed.claimable).toBeUndefined()
    expect(feed.campaigns[0]?.campaignUrl).toBeUndefined()
    expect(feed.campaigns[0]?.content).toBeUndefined()
  })

  it('VIEW_DETAILS banner 也被收进 feed（不只是挑 CLAIM_BENEFIT）', async () => {
    const { client } = feedStub({ campaigns: [PLACED, { campaignId: 'c2', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED', placements: [{ type: 'POPUP', content: { zh: { title: '1024 创造力集结' } } }] }] })
    const feed = await client.fetchCampaignFeed('pt-x')
    expect(feed.campaigns.map(c => c.campaignId)).toEqual(['c1', 'c2'])
    expect(feed.campaigns[1]?.content?.zh?.title).toBe('1024 创造力集结')
  })

  it('fetchCampaigns 仍是 feed 的窄投影（不带顶层字段）', async () => {
    const { client } = feedStub({ campaignUrl: 'https://x/y', showCampaign: true, campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }] })
    const list = await client.fetchCampaigns('pt-x')
    expect(list).toHaveLength(1)
    // QoderCampaign 没有索引签名，先过 unknown 再断言「feed 投影里不该有的字段」。
    const only = list[0] as unknown as Record<string, unknown>
    expect(only.campaignUrl).toBeUndefined()
    expect(only.content).toBeUndefined()
  })

  it('读取走 sash 令牌，打的还是同一路径与 forceRefresh', async () => {
    const { client, calls } = feedStub({ campaigns: [] })
    await client.fetchCampaignFeed('pt-x')
    const hit = calls.find(c => c.url.includes('/sash/api/v1/me/campaigns'))
    expect(hit?.auth).toBe('Bearer jt-SASH-TOKEN')
    expect(hit?.url).toContain('?forceRefresh=true')
  })
})

describe('projectCampaignEntry', () => {
  it('非对象 / 无 campaignId 不产出条目', () => {
    expect(projectCampaignEntry(undefined)).toBeUndefined()
    expect(projectCampaignEntry('x')).toBeUndefined()
    expect(projectCampaignEntry({ actionType: 'CLAIM_BENEFIT' })).toBeUndefined()
  })

  it('多份 placements 取第一份非空（不重复渲染）', () => {
    const row = projectCampaignEntry({
      campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED',
      placements: [
        { type: 'POPUP', content: { zh: { title: 'A' } } },
        { type: 'USAGE', content: { zh: { title: 'B', description: 'dup' } } },
      ],
    })
    expect(row?.content?.zh?.title).toBe('A')
    expect(row?.content?.zh?.description).toBeUndefined()
  })

  it('actionType / claimStatus 缺失时留空串（宽容解析，未知状态不画状态词）', () => {
    const row = projectCampaignEntry({ campaignId: 'c1' })
    expect(row?.actionType).toBe('')
    expect(row?.claimStatus).toBe('')
  })
})

/**
 * **cosy 面（chat + models）的协议版本**（issue #21）。
 *
 * 上游按 `cosy-clienttype` / `cosy-version` 决定下发哪一套模型目录。旧值
 * `5` / `0.1.43` 让国际版静默少 3 个模型（`smodel` / `cmodel` / `fast`）、
 * 国内版少 `fast` —— 目录照常返回、对话照常能跑，没有任何报错指向那里，所以
 * 只能靠测试钉住，不能靠「跑起来看着没问题」。
 *
 * 实测矩阵（2026-10-29，两个区域各一枚真实 PAT，只读目录）：
 *
 * | 区域   | `5` / `0.1.43` | `10` / `1.1.69`                  |
 * | ------ | -------------- | -------------------------------- |
 * | cn     | 9 条           | 10 条（+`fast`）                 |
 * | global | 11 条          | 14 条（+`smodel`/`cmodel`/`fast`）|
 *
 * 两个值**成对**生效：国内版只提 clienttype、version 留旧值时目录不变，且
 * chat 报 `HTTP 403 code 112`。所以这里同时断言两者，不许只改一个。
 */
describe('cosy 面协议版本（issue #21）', () => {
  /** 捕获每个请求实际发出的头，并应答 jobToken / models / chat。 */
  function capture(): { calls: Array<{ url: string, headers: Record<string, string> }>, client: QoderUpstreamClient } {
    const calls: Array<{ url: string, headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      calls.push({ url: target, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) })
      if (target.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (target.includes('/model/list')) {
        return new Response(JSON.stringify({ chat: [{ key: 'qfmodel', display_name: 'Qwen3.8-Flash' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      // sash 的 campaigns：sashRequest 要求 JSON 响应，空串会被判「不是 JSON」。
      if (target.includes('/campaigns')) {
        return new Response(JSON.stringify({ campaigns: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      // chat：一个空 SSE 帧就够——这条用例只关心请求头。
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { calls, client: new QoderUpstreamClient('cn', { fetch: fetchImpl }) }
  }

  it('模型目录请求带 clienttype 10 + version 1.1.69', async () => {
    const { calls, client } = capture()
    await client.fetchModels('pt-x')
    const models = calls.find(c => c.url.includes('/model/list'))
    expect(models).toBeDefined()
    expect(models!.headers['cosy-clienttype']).toBe('10')
    expect(models!.headers['cosy-version']).toBe('1.1.69')
  })

  it('对话请求带同一对协议版本（两条路径不许各说一套）', async () => {
    const { calls, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))
    expect(chat).toBeDefined()
    expect(chat!.headers['cosy-clienttype']).toBe('10')
    expect(chat!.headers['cosy-version']).toBe('1.1.69')
  })

  it('jobToken 交换也带同一对版本（否则 chat 拿到的是半改的会话）', async () => {
    const { calls, client } = capture()
    await client.exchangeJobToken('pt-x')
    const exchange = calls.find(c => c.url.includes('jobToken'))
    expect(exchange).toBeDefined()
    expect(exchange!.headers['cosy-clienttype']).toBe('10')
    expect(exchange!.headers['cosy-version']).toBe('1.1.69')
  })

  it('sash 面不受影响：不带 cosy-version，clienttype 仍是 sash 自己的 10', async () => {
    // 两条路径互不干扰是本改动的**前提**：sash 逐条手写请求头，不展开
    // DEFAULT_HEADERS。这里钉住这一点——若哪天有人把 DEFAULT_HEADERS 展开进
    // sash，签到与用量会被 cosy 协议头污染（`:928` 的注释警告的正是这个）。
    const { calls, client } = capture()
    await client.fetchCampaigns('pt-x')
    const sash = calls.find(c => c.url.includes('/campaigns'))
    expect(sash).toBeDefined()
    expect(sash!.headers['cosy-clienttype']).toBe('10')
    expect(sash!.headers['cosy-version']).toBeUndefined()
  })
})

describe('parseStreamDelta 对空帧的宽容（实测回归）', () => {
  /**
   * 实测（2026-10-29，cn，`mmodel` / MiniMax-M3.1-Flash）：上游在一个正常的
   * role-only 首帧之后，会投递一帧 `body: "null"`。
   *
   * `JSON.parse('null')` **合法**返回 `null`，于是 `inner.code` 抛
   * `TypeError: Cannot read properties of null` —— 整个流被打断，用户看到的是
   * 「这个模型坏了」，而模型完全正常（同一个 key 用 64×64 的图问颜色答得对）。
   *
   * 空帧的语义是「本帧无可消费内容」，与解析失败同义：跳过，不报错。
   */
  it('body 为 "null" 的帧返回 undefined，而不是抛 TypeError', () => {
    const frame = JSON.stringify({ headers: {}, body: 'null', statusCodeValue: 200 })
    expect(() => parseStreamDelta(frame)).not.toThrow()
    expect(parseStreamDelta(frame)).toBeUndefined()
  })

  it('body 为其他非对象 JSON（字符串 / 数组 / 数字）同样跳过', () => {
    for (const body of ['"hello"', '[1,2]', '42', 'true']) {
      const frame = JSON.stringify({ headers: {}, body, statusCodeValue: 200 })
      expect(() => parseStreamDelta(frame)).not.toThrow()
      expect(parseStreamDelta(frame)).toBeUndefined()
    }
  })

  it('空帧之后的正常帧仍然解析（跳过不等于中断）', () => {
    const empty = JSON.stringify({ headers: {}, body: 'null', statusCodeValue: 200 })
    const good = JSON.stringify({
      headers: {},
      body: JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '收到' } }] }),
      statusCodeValue: 200,
    })
    expect(parseStreamDelta(empty)).toBeUndefined()
    expect(parseStreamDelta(good)?.content).toBe('收到')
  })
})
