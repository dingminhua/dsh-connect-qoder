/**
 * Qoder 真实体积探针：probeUserMessage / resolveProbeInputTokens / parseRetryAfter /
 * parseUpstreamResetAt / cooldownOf / outcomeOfFailure / redactUpstreamText / probeModel。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/probe.spec.ts` ——「一次真实体积请求的构造与解读」整体沿用，包括
 *   冷却三来源（Retry-After 头 / `将在…重置` 句子 / 额度刷新点）、文案入库前
 *   脱敏、错误结果按上游错误类别分类。Qoder 端口的差异：
 *   - 请求体是 **user-first**：Qoder 网关接受无 system 的消息，所以没有
 *     PROBE_SYSTEM_PROMPT；
 *   - 探测请求真正发送靠 Host 组装（`QoderProbeClient.probeChat` 注入），
 *     本文件只测纯函数与 `probeModel` 的归并。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  cooldownOf,
  DEFAULT_PROBE_INPUT_TOKENS,
  outcomeOfFailure,
  parseRetryAfter,
  parseUpstreamResetAt,
  probeModel,
  probeSucceeded,
  probeUserMessage,
  PROBE_INPUT_TOKEN_CHOICES,
  redactUpstreamText,
  resolveProbeInputTokens,
} from '../src/probe.ts'
import type { QoderProbeClient, QoderProbeError } from '../src/probe.ts'
import type { QoderWebProbeResult } from '../src/status-paths.ts'

const NOW = 1_800_000_000_000

describe('resolveProbeInputTokens', () => {
  it('accepts every offered size unchanged and falls back for anything else', () => {
    for (const choice of PROBE_INPUT_TOKEN_CHOICES) {
      expect(resolveProbeInputTokens(choice)).toBe(choice)
    }
    expect(resolveProbeInputTokens(undefined)).toBe(DEFAULT_PROBE_INPUT_TOKENS)
    expect(resolveProbeInputTokens(0)).toBe(DEFAULT_PROBE_INPUT_TOKENS)
    expect(resolveProbeInputTokens(42_000)).toBe(DEFAULT_PROBE_INPUT_TOKENS)
  })
})

describe('probeUserMessage', () => {
  it('grows with the requested input size and carries the actual prompt', () => {
    const small = probeUserMessage(10_000)
    const large = probeUserMessage(100_000)
    expect(large.length).toBeGreaterThan(small.length)
    expect(small).toContain('Reply with a single word.')
  })

  it('defaults to the family default input when no size is given', () => {
    const message = probeUserMessage()
    expect(message).toContain('Reply with a single word.')
    // 真实体积：不是一两个 token。
    expect(message.length).toBeGreaterThan(1_000)
    // 用户消息开头干净地落回提示词，没有编造系统消息。
    expect(message.startsWith('Reply with a single word.')).toBe(false)
  })

  it('contains only neutral filler — no user content', () => {
    const message = probeUserMessage(20_000)
    expect(message).not.toMatch(/eyJ[A-Za-z0-9_-]+\./u)
  })
})

describe('parseRetryAfter', () => {
  it('reads the delay-seconds form', () => {
    expect(parseRetryAfter('120', NOW)).toBe(NOW + 120_000)
  })

  it('reads the HTTP-date form', () => {
    const date = new Date(NOW + 300_000).toUTCString()
    expect(parseRetryAfter(date, NOW)).toBe(NOW + 300_000)
  })

  it('refuses a delay that is not a cooldown (zero/negative)', () => {
    expect(parseRetryAfter('0', NOW)).toBeUndefined()
    expect(parseRetryAfter('-5', NOW)).toBeUndefined()
  })

  it('refuses an absent or unparsable value', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('', NOW)).toBeUndefined()
    expect(parseRetryAfter('abc', NOW)).toBeUndefined()
  })

  it('refuses an HTTP-date already in the past', () => {
    const date = new Date(NOW - 1).toUTCString()
    expect(parseRetryAfter(date, NOW)).toBeUndefined()
  })
})

describe('parseUpstreamResetAt', () => {
  it('reads the shipped UTC offset instead of assuming the host zone', () => {
    // 2026-09-30 02:30:30 UTC+8 → 2018-… 之前 8 小时。
    const message = '您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，请稍后再试。'
    const parsed = parseUpstreamResetAt(message)
    expect(parsed).toBeDefined()
    if (parsed === undefined) return
    const date = new Date(parsed)
    expect(date.getUTCFullYear()).toBe(2026)
    expect(date.getUTCMonth()).toBe(8) // 9 月
    expect(date.getUTCDate()).toBe(29) // 减去 8 小时 → 前一天
    expect(date.getUTCHours()).toBe(18)
  })

  it('accepts an ISO-style T separator and a compact offset', () => {
    const parsed = parseUpstreamResetAt('将在 2026-09-30T02:30:30 UTC+8 重置')
    expect(parsed).toBeDefined()
  })

  it('honours a negative offset', () => {
    // UTC-5 的 02:30:30 → 世界时 07:30:30。
    const parsed = parseUpstreamResetAt('将在 2026-09-30 02:30:30 UTC-5 重置')
    if (parsed === undefined) { expect(parsed).toBeDefined(); return }
    const date = new Date(parsed)
    expect(date.getUTCHours()).toBe(7)
  })

  it('returns undefined rather than guessing when the time is incomplete', () => {
    expect(parseUpstreamResetAt('将在某时重置')).toBeUndefined()
    expect(parseUpstreamResetAt('升级中')).toBeUndefined()
  })

  it('rejects an impossible calendar date instead of normalizing it', () => {
    expect(parseUpstreamResetAt('将在 2026-02-30 10:00:00 UTC+8 重置')).toBeUndefined()
  })

  it('rejects an out-of-range offset', () => {
    // 偏移超过 ±14 小时不可信。
    expect(parseUpstreamResetAt('将在 2026-09-30 10:00:00 UTC+16 重置')).toBeUndefined()
  })
})

describe('cooldownOf', () => {
  it('prefers a Retry-After header over everything else', () => {
    const cool = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: '3600',
      nowMs: NOW,
      body: '将在 2026-09-30 02:30:30 UTC+8 重置',
      quotaRefreshAtMs: NOW + 1,
    })
    expect(cool).toEqual({ retryAtMs: NOW + 3_600_000, retrySource: 'retry-after' })
  })

  it('reads the reset time out of the upstream failure body', () => {
    const cool = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: null,
      nowMs: NOW,
      body: '用量超限，将在 2026-09-30 02:30:30 UTC+8 重置',
    })
    expect(cool.retrySource).toBe('upstream-message')
    expect(cool.retryAtMs).toBeDefined()
  })

  it('falls back to the quota refresh point for an out-of-credit outcome', () => {
    const cool = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 3_600_000,
    })
    expect(cool).toEqual({ retryAtMs: NOW + 3_600_000, retrySource: 'quota-refresh' })
  })

  it('does NOT borrow the quota refresh point for a non-quota outcome', () => {
    const cool = cooldownOf({
      outcome: 'rate-limited',
      retryAfter: null,
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 3_600_000,
    })
    expect(cool).toEqual({})
  })

  it('invents NO time when the upstream stated none', () => {
    expect(cooldownOf({ outcome: 'rate-limited', retryAfter: null, nowMs: NOW })).toEqual({})
    expect(cooldownOf({ outcome: 'failed', retryAfter: null, nowMs: NOW })).toEqual({})
  })
})

describe('outcomeOfFailure', () => {
  const err = (kind: QoderProbeError['kind'], status: number, message: string): QoderProbeError =>
    ({ kind, status, message })

  it('classifies auth as credential-rejected', () => {
    expect(outcomeOfFailure(err('auth', 401, 'token invalid'))).toEqual({ outcome: 'credential-rejected' })
  })

  it('classifies rate-limited', () => {
    expect(outcomeOfFailure(err('rate-limited', 429, 'usage exceeded'))).toEqual({ outcome: 'rate-limited' })
  })

  it('classifies quota-exhausted as out-of-credit', () => {
    expect(outcomeOfFailure(err('quota-exhausted', 429, '重试额度耗尽'))).toEqual({ outcome: 'out-of-credit' })
  })

  it('classifies content-policy as policy-rejected', () => {
    expect(outcomeOfFailure(err('content-policy', 400, '内容审核拒绝'))).toEqual({ outcome: 'policy-rejected' })
  })

  it('classifies a 400 naming the model as not-found, and any other 400 as failed', () => {
    expect(outcomeOfFailure(err('invalid-request', 400, 'model qmodel not found'))).toEqual({ outcome: 'not-found' })
    expect(outcomeOfFailure(err('invalid-request', 400, 'bad prompt'))).toEqual({ outcome: 'failed' })
  })

  it('classifies not-found-model as not-found', () => {
    expect(outcomeOfFailure(err('not-found-model', 400, 'model unknown'))).toEqual({ outcome: 'not-found' })
  })

  it('classifies network and transient as unavailable', () => {
    expect(outcomeOfFailure(err('network', 0, 'ECONNREFUSED'))).toEqual({ outcome: 'unavailable' })
    expect(outcomeOfFailure(err('transient', 502, 'upstream error'))).toEqual({ outcome: 'unavailable' })
  })

  it('classifies an unknown error as unavailable only on transport-style status', () => {
    expect(outcomeOfFailure(err('unknown', 0, 'boom'))).toEqual({ outcome: 'unavailable' })
    expect(outcomeOfFailure(err('unknown', 503, 'boom'))).toEqual({ outcome: 'unavailable' })
    expect(outcomeOfFailure(err('unknown', 400, 'boom'))).toEqual({ outcome: 'failed' })
  })
})

describe('probeSucceeded', () => {
  it('is true only for ok', () => {
    expect(probeSucceeded('ok')).toBe(true)
    expect(probeSucceeded('failed')).toBe(false)
  })
})

describe('redactUpstreamText', () => {
  it('fully removes a JWT-shaped token (the secret, if not the exact placeholder string)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'
    const redacted = redactUpstreamText(`error token=${jwt} ends`)
    // 真正的安全属性：JWT 的字符体 `eyJ…sig` 全部删除。
    expect(redacted).not.toContain('sig')
    expect(redacted).not.toContain('eyJ')
    // 至少留下一个脱敏标记。
    expect(redacted).toContain('[redacted]')
  })

  it('strips a `key=secret` value while keeping the key name', () => {
    const redacted = redactUpstreamText('access_token=pt-abc123abc123bc refresh_token=supersecretvalue')
    expect(redacted).toContain('access_token=[redacted]')
    expect(redacted).not.toContain('pt-abc123abc123bc')
    expect(redacted).not.toContain('supersecretvalue')
  })

  it('strips a bare `pt-` credential entirely', () => {
    const redacted = redactUpstreamText('refused for pt-abc123abc123bc user')
    expect(redacted).toContain('[redacted credential]')
    expect(redacted).not.toContain('pt-abc123abc123bc')
  })

  it('bounds upstream copy to 300 chars', () => {
    const long = 'x'.repeat(5_000)
    expect(redactUpstreamText(long).length).toBeLessThanOrEqual(300)
    expect(redactUpstreamText('').length).toBeLessThanOrEqual(300)
  })
})

describe('probeModel', () => {
  /** A client stub returning scripted answers. */
  function client(impl: Partial<QoderProbeClient> = {}): QoderProbeClient {
    return {
      probeChat: impl.probeChat ?? (async () => ({ ok: true, status: 200, retryAfter: null })),
    }
  }

  it('reports a successful probe with its round-trip time', async () => {
    const probeChat = vi.fn(async () => ({ ok: true, status: 200, retryAfter: null }))
    const result = await probeModel({
      client: client({ probeChat }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'qmodel',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('ok')
    expect(result.modelId).toBe('qmodel')
    expect(result.status).toBe(200)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(probeChat).toHaveBeenCalledOnce()
  })

  it('passes the input-token option through to the client', async () => {
    const probeChat = vi.fn<NonNullable<QoderProbeClient['probeChat']>>(
      async () => ({ ok: true, status: 200, retryAfter: null }),
    )
    await probeModel({
      client: client({ probeChat }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
      inputTokens: 100_000,
    })
    expect(probeChat.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 100_000 })
  })

  it('surfaces the reset time a real 429 body carries', async () => {
    const result = await probeModel({
      client: client({
        probeChat: async () => ({
          ok: false,
          status: 429,
          retryAfter: null,
          body: '用量超限，将在 2026-09-30 02:30:30 UTC+8 重置',
          error: { kind: 'rate-limited', status: 429, message: 'lim' },
        }),
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('rate-limited')
    expect(result.retrySource).toBe('upstream-message')
    expect(result.retryAtMs).toBeDefined()
  })

  it('stamps the quota refresh time onto an out-of-credit result', async () => {
    const result = await probeModel({
      client: client({
        probeChat: async () => ({
          ok: false,
          status: 429,
          retryAfter: null,
          body: '额度耗尽',
          error: { kind: 'quota-exhausted', status: 429, message: 'quota' },
        }),
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
      quotaRefreshAtMs: NOW + 3_600_000,
    })
    expect(result.outcome).toBe('out-of-credit')
    expect(result).toMatchObject({ retryAtMs: NOW + 3_600_000, retrySource: 'quota-refresh' })
  })

  it('never throws: a transport explosion becomes an unavailable result', async () => {
    const result = await probeModel({
      client: client({
        probeChat: async () => { throw new Error('ECONNREFUSED 127.0.0.1') },
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('unavailable')
  })

  it('reports a failure with no client error as a plain failed result', async () => {
    const result = await probeModel({
      client: client({
        probeChat: async () => ({ ok: false, status: 500, retryAfter: null }),
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe(500)
  })

  it('redacts a JWT-shaped token out of a failure message', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    const result = await probeModel({
      client: client({
        probeChat: async () => ({
          ok: false,
          status: 401,
          retryAfter: null,
          body: `failed with ${jwt}`,
          error: { kind: 'auth', status: 401, message: 'auth' },
        }),
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('credential-rejected')
    expect(result.message).not.toContain('sig')
    expect(result.message).not.toContain('eyJ')
  })

  it('skips a non-ok result with no error and no cooldown cleanly', async () => {
    const result = await probeModel({
      client: client({
        probeChat: async () => ({ ok: false, status: 0, retryAfter: null }),
      }),
      credential: { pat: 'pt-x', accountName: 'A' },
      modelKey: 'm',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('failed')
  })
})
// ==========================================================================
// issue #26：上游说「在排队」时，结论、冷却与文案都必须照上游说的来
//
// 用户实拍：池子报「✗ 连不上上游」，账号其实完全正常（六个模型同时可用）。
// 上游逐字说的是「排队中，30 秒后再来，服务是好的」。
// ==========================================================================
describe('issue #26：排队是一条独立的结论', () => {
  it('上游说在排队 → queued，不是 unavailable（连不上上游）', () => {
    const outcome = outcomeOfFailure({
      kind: 'transient',
      status: 403,
      message: '上游信封错误: HTTP 403 …',
      queue: { isQueued: true, queueCount: 1027, queueType: 'p3', retryAfterSeconds: 30 },
    })
    expect(outcome).toEqual({ outcome: 'queued' })
    // 变异检查：把 queued 分支去掉，这条立刻红。
  })

  it('没有排队证据时，transient 仍然是 unavailable（别把别的故障说成排队）', () => {
    expect(outcomeOfFailure({ kind: 'transient', status: 503, message: 'boom' }))
      .toEqual({ outcome: 'unavailable' })
  })

  it('上游申报 30 秒 → 冷却就是 30 秒（此前是 30 分钟，差 60 倍）', () => {
    const cool = cooldownOf({
      outcome: 'queued',
      retryAfter: null,
      nowMs: NOW,
      retryAfterMs: 30_000,
    })
    expect(cool).toEqual({ retryAtMs: NOW + 30_000, retrySource: 'upstream-reported' })
  })

  it('申报值优先于报文里刮出来的重置句子（上游明说的数字更具体）', () => {
    const cool = cooldownOf({
      outcome: 'queued',
      retryAfter: null,
      nowMs: NOW,
      body: '将在 2026-09-30 02:30:30 UTC+8 重置',
      retryAfterMs: 30_000,
    })
    expect(cool.retrySource).toBe('upstream-reported')
    expect(cool.retryAtMs).toBe(NOW + 30_000)
  })

  it('上游没申报就一个字都不编（仍然返回空）', () => {
    expect(cooldownOf({ outcome: 'queued', retryAfter: null, nowMs: NOW })).toEqual({})
    expect(cooldownOf({ outcome: 'queued', retryAfter: null, nowMs: NOW, retryAfterMs: 0 })).toEqual({})
    expect(cooldownOf({ outcome: 'queued', retryAfter: null, nowMs: NOW, retryAfterMs: -5 })).toEqual({})
  })

  it('probeModel 把排队与等待时刻一起带出来', async () => {
    const client: QoderProbeClient = {
      probeChat: async () => ({
        ok: false,
        status: 403,
        retryAfter: null,
        retryAfterMs: 30_000,
        body: '上游信封错误: HTTP 403 {"code":"10605",…}',
        error: {
          kind: 'transient',
          status: 403,
          message: '上游信封错误: HTTP 403 …',
          retryAfterMs: 30_000,
          queue: { isQueued: true, queueCount: 1027, queueType: 'p3', retryAfterSeconds: 30 },
        },
      }),
    }
    const result = await probeModel({
      client,
      credential: { pat: 'pt-x', accountName: 'a' },
      modelKey: 'dfmodel',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('queued')
    expect(result.retryAtMs).toBe(NOW + 30_000)
    expect(result.retrySource).toBe('upstream-reported')
    expect(result.queue?.queueCount).toBe(1027)
    expect(result.queue?.queueType).toBe('p3')
  })

  it('探针自己抛错但带排队证据时也照实说排队', async () => {
    const client: QoderProbeClient = {
      probeChat: async () => {
        throw Object.assign(new Error('排队中'), {
          queue: { isQueued: true, queueCount: 1027 },
          retryAfterMs: 30_000,
        })
      },
    }
    const result = await probeModel({
      client,
      credential: { pat: 'pt-x', accountName: 'a' },
      modelKey: 'dfmodel',
      nowMs: NOW,
    })
    expect(result.outcome).toBe('queued')
    expect(result.retryAtMs).toBe(NOW + 30_000)
  })
})
