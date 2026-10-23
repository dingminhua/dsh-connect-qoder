import { afterEach, describe, expect, it } from 'vitest'
import { classifyPiAiError, hostRendersOwnCopy, verifyFixtureAgainstInstalledHost } from './host-piai.ts'
import { createQoderShim, hostFailureMessage, hostMessageText, type QoderShim, type QoderShimOptions, type QoderServingAccount } from '../src/shim.ts'
import { failoverNoticeText } from '../src/failover-notice.ts'
import { QoderUpstreamError, type QoderUpstreamClient, type UpstreamErrorKind } from '../src/upstream.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const shims: QoderShim[] = []

type Delta = { role: string; content: string; reasoningContent: string; toolCalls: unknown[] | undefined; inputTokens: number; outputTokens: number; cachedTokens?: number | undefined }

interface ChatCall {
  credential: string
  modelKey: string
  tools?: unknown[] | undefined
  signal?: AbortSignal | undefined
  isReasoning?: boolean | undefined
  reasoningEffort?: string | undefined
}

function delta(text: string): Delta {
  return { role: 'assistant', content: text, reasoningContent: '', toolCalls: undefined, inputTokens: 5, outputTokens: 2 }
}

/** A stub upstream that fails selected PATs with the given kind and answers the rest. */
function stubUpstream(failures: Record<string, UpstreamErrorKind>, calls: ChatCall[] = []): QoderUpstreamClient {
  return {
    chatStream: async (credential: string, modelKey: string, _messages: Array<Record<string, unknown>>, options: {
      tools?: unknown[]
      isReasoning?: boolean
      reasoningEffort?: string
      isVl?: boolean
      signal?: AbortSignal
      onDelta: (d: Delta) => void
      userType?: string
    }) => {
      calls.push({
        credential, modelKey, tools: options.tools, signal: options.signal,
        isReasoning: options.isReasoning, reasoningEffort: options.reasoningEffort,
      })
      const kind = failures[credential]
      if (kind !== undefined) {
        const status = kind === 'rate-limited' ? 429 : kind === 'auth' ? 401 : 502
        throw new QoderUpstreamError(kind, `${status} upstream`, status)
      }
      options.onDelta(delta('Hello'))
    },
  } as unknown as QoderUpstreamClient
}

function startShim(overrides: Partial<QoderShimOptions> = {}): Promise<QoderShim> {
  const shim = createQoderShim({
    upstream: stubUpstream({}),
    credential: () => 'pt-stub',
    modelKeyOf: (name: string) => (name === 'dmodel' ? 'dmodel' : undefined),
    supportsImagesOf: () => false,
    logger: () => {},
    failoverGapMs: 0,
    ...overrides,
  })
  shims.push(shim)
  return shim.ready.then(() => shim)
}

function chat(shim: QoderShim, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}`, ...headers },
    body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }], ...body }),
  })
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text.split('\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

afterEach(async () => {
  while (shims.length > 0) {
    const shim = shims.pop()!
    await shim.close()
  }
})

describe('Qoder shim security model', () => {
  it('rejects requests without the shared secret', async () => {
    const shim = await startShim()
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(resp.status).toBe(401)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('invalid_api_key')
  })

  it('rejects wrong-origin hosts before auth', async () => {
    const shim = await startShim()
    const resp = await fetch(shim.baseUrl.replace('127.0.0.1', 'localhost'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Host header must be 127.0.0.1:<port>; localhost is rejected.
    expect(resp.status).toBe(403)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('host_not_allowed')
  })

  it('rejects a browser Origin that is not loopback', async () => {
    const shim = await startShim()
    const resp = await chat(shim, {}, { Origin: 'https://evil.example.com' })
    expect(resp.status).toBe(403)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('origin_not_allowed')
  })

  it('accepts a loopback browser Origin', async () => {
    const shim = await startShim()
    const resp = await chat(shim, {}, { Origin: 'http://127.0.0.1:19387' })
    expect(resp.status).toBe(200)
  })

  it('rejects bodies over the size cap', async () => {
    const shim = await startShim({ requestBodyLimit: 1024 })
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'x'.repeat(4096) }] }),
    })
    expect(resp.status).toBe(413)
    const data = (await resp.json()) as { error: { code: string; message: string } }
    expect(data.error.message).toBe('request body too large')
  })

  it('rejects non-JSON content types', async () => {
    const shim = await startShim()
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${shim.secret}` },
      body: 'hi',
    })
    expect(resp.status).toBe(415)
  })

  it('answers /healthz for an authorized caller', async () => {
    const shim = await startShim()
    const ok = await fetch(`${shim.baseUrl}/healthz`, { headers: { Authorization: `Bearer ${shim.secret}` } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
    const denied = await fetch(`${shim.baseUrl}/healthz`)
    expect(denied.status).toBe(401)
  })
})

describe('Qoder shim chat translation', () => {
  it('streams OpenAI-shaped SSE chunks and a final chunk', async () => {
    const shim = await startShim()
    const resp = await chat(shim, { stream: true })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/event-stream')
    const text = await resp.text()
    const lines = text.split('\n').filter(line => line.startsWith('data: '))
    const chunks = parseSse(text) as Array<{ choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: Record<string, unknown> }>
    expect(chunks.length).toBe(2)
    // content chunk
    expect(chunks[0]!.choices?.[0]?.delta?.content).toBe('Hello')
    // done chunk
    expect(chunks[1]!.choices?.[0]?.finish_reason).toBe('stop')
    expect(chunks[1]!.usage?.prompt_tokens).toBe(5)
    expect(chunks[1]!.usage?.completion_tokens).toBe(2)
    // 上游没报缓存命中时，**不写** `prompt_tokens_details`（不是写 0）：
    // 「没报」与「命中 0 个」在宿主那里含义不同（issue #4）。
    expect(chunks[1]!.usage?.prompt_tokens_details).toBeUndefined()
    // [DONE]
    expect(lines.at(-1)).toBe('data: [DONE]')
  })

  /**
   * 缓存命中数要一路透传到宿主读的那一帧（issue #4）。
   *
   * 断言的落点是**最终 `done` 帧的 `usage.prompt_tokens_details.cached_tokens`**
   * ——宿主 `parseChunkUsage` 只读这一处。这里刻意检查「原样、不相加」：
   * 上游实测 `cached_tokens` 是 `prompt_tokens` 的子集（2032 / 2038），宿主自己
   * 会做 `input = prompt_tokens - cacheRead`，我们若在这之前加过一次就会重复计数。
   */
  it('forwards cached_tokens to the host without folding it into prompt_tokens', async () => {
    const upstream = {
      chatStream: async (_c: string, _m: string, _msgs: unknown[], options: { onDelta: (d: Delta) => void }) => {
        options.onDelta({ ...delta('Hello'), inputTokens: 2038, outputTokens: 38, cachedTokens: 2032 })
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({ upstream })
    const text = await (await chat(shim, {})).text()
    const chunks = parseSse(text) as Array<{ usage?: Record<string, unknown> }>
    const usage = chunks.at(-1)!.usage as {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(2032)
    // **关键的「别双重计数」**：prompt_tokens 与 total_tokens 仍按上游给的原样，
    // 缓存命中数没有加进任何一个。
    expect(usage.prompt_tokens).toBe(2038)
    expect(usage.total_tokens).toBe(2038 + 38)
  })

  /**
   * 端到端的最后一步：**把这一帧真的交给宿主的解析器**，看它读成什么。
   *
   * 前面那条只证明「我们写进了帧里」。可 issue #4 的症状是「宿主显示 0%」，
   * 而写对位置与宿主读对位置是两件事 —— 只断言前者，等于假设宿主一定会读。
   * 所以这里把宿主 `parseChunkUsage` 的原文（从 app.asar 提取，见
   * `tests/host-usage-parsing.spec.ts`）拿来执行一遍。
   *
   * 这是本仓库付过一次学费的教训：手抄宿主实现做断言，两份一起漂移，测试
   * 全绿而线上照坏。
   */
  it('the frame it writes is read back by the HOST parser as a non-zero cache read', async () => {
    const fixture = JSON.parse(readFileSync(
      fileURLToPath(new URL('./fixtures/host-usage-parsing.json', import.meta.url)), 'utf8',
    )) as { calculateCost: string, parseChunkUsage: string }
    const hostParse = new Function(
      `${fixture.calculateCost}\n${fixture.parseChunkUsage}\nreturn parseChunkUsage;`,
    )() as (u: Record<string, unknown>, m: unknown) => { input: number, cacheRead: number }

    const upstream = {
      chatStream: async (_c: string, _m: string, _msgs: unknown[], options: { onDelta: (d: Delta) => void }) => {
        options.onDelta({ ...delta('Hello'), inputTokens: 2038, outputTokens: 38, cachedTokens: 2032 })
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({ upstream })
    const text = await (await chat(shim, {})).text()
    const chunks = parseSse(text) as Array<{ usage?: Record<string, unknown> }>
    const raw = chunks.at(-1)!.usage!
    const parsed = hostParse(raw, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(parsed.cacheRead).toBe(2032)
    expect(parsed.input).toBe(2038 - 2032)
  })

  it('forwards a reported zero, because "no hits" is a real answer', async () => {
    // 冷启动那一轮上游报的就是 `cached_tokens: 0`（实测）。它必须透传成 0，
    // 而不是被「假值」判断吞掉、变成「上游没报」。
    const upstream = {
      chatStream: async (_c: string, _m: string, _msgs: unknown[], options: { onDelta: (d: Delta) => void }) => {
        options.onDelta({ ...delta('Hello'), cachedTokens: 0 })
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({ upstream })
    const text = await (await chat(shim, {})).text()
    const chunks = parseSse(text) as Array<{ usage?: { prompt_tokens_details?: { cached_tokens?: number } } }>
    expect(chunks.at(-1)!.usage?.prompt_tokens_details?.cached_tokens).toBe(0)
  })

  it('answers pre-first-byte failures with a NON-200 JSON error, not an SSE frame', async () => {
    // pi-ai 对 200 流里的 error 字段完全失明（塌缩成 "Provider finish_reason:
    // error"）；只有非 2xx 响应体能把真实 code 送进宿主分类器。
    const shim = await startShim({ upstream: stubUpstream({ 'pt-stub': 'rate-limited' }) })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(429)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const data = (await resp.json()) as { error: { code: string; message: string } }
    // rate-limited 翻成 quota_exceeded：宿主因此原地不重试（冷却是小时级）。
    expect(data.error.code).toBe('quota_exceeded')
    expect(data.error.message).toContain('rate-limited')
    expect(data.error.message).toContain('429 upstream')
  })

  it('keeps mid-stream failures inside the SSE stream', async () => {
    const upstream = {
      chatStream: async (_c: string, _m: string, _msgs: unknown[], options: { onDelta: (d: Delta) => void }) => {
        options.onDelta(delta('partial'))
        throw new QoderUpstreamError('transient', 'boom', 502)
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({ upstream })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    const chunks = parseSse(await resp.text()) as Array<{ error?: { code: string }; choices?: Array<{ finish_reason?: string | null }> }>
    const errorChunk = chunks.find(chunk => chunk.error !== undefined)
    expect(errorChunk?.error?.code).toBe('upstream_error')
  })

  it('drops tools when the host forbids them via tool_choice: none', async () => {
    const calls: ChatCall[] = []
    const shim = await startShim({ upstream: stubUpstream({}, calls) })
    const resp = await chat(shim, { tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'none' })
    expect(resp.status).toBe(200)
    expect(calls[0]!.tools).toBeUndefined()
  })

  it('forwards tools when no tool_choice forbids them', async () => {
    const calls: ChatCall[] = []
    const shim = await startShim({ upstream: stubUpstream({}, calls) })
    const tools = [{ type: 'function', function: { name: 'f' } }]
    const resp = await chat(shim, { tools })
    expect(resp.status).toBe(200)
    expect(calls[0]!.tools).toEqual(tools)
  })

  it('carries the saved thinking strength into every request', async () => {
    // 整条链路的成败点：设置里存的档位必须真的到达上游调用，否则那个下拉
    // 只是装饰。官方客户端的形态是顶层 reasoningEffort + parameters
    // .reasoning_effort；shim 把存档读出来交给 chatStream。
    const calls: ChatCall[] = []
    const shim = await startShim({
      upstream: stubUpstream({}, calls),
      reasoningEffortOf: (name: string) => (name === 'dmodel' ? 'xhigh' : undefined),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    expect(calls[0]!.reasoningEffort).toBe('xhigh')
    // 选中档位本身即「开启思考」，所以布尔侧也必须是 true。
    expect(calls[0]!.isReasoning).toBe(true)
  })

  it('sends no strength when the model has none saved', async () => {
    const calls: ChatCall[] = []
    const shim = await startShim({
      upstream: stubUpstream({}, calls),
      reasoningEffortOf: () => undefined,
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    // 不下发档位字段 → 上游用它自己的默认档。
    expect(calls[0]!.reasoningEffort).toBeUndefined()
  })

  it('honours an explicit host "off" over the saved strength', async () => {
    // 宿主明确要求关闭思考时，保存的档位必须让位：用户此刻的意图优先于设置。
    const calls: ChatCall[] = []
    const shim = await startShim({
      upstream: stubUpstream({}, calls),
      reasoningEffortOf: () => 'xhigh',
    })
    const resp = await chat(shim, { reasoning_effort: 'off' })
    expect(resp.status).toBe(200)
    expect(calls[0]!.reasoningEffort).toBeUndefined()
    expect(calls[0]!.isReasoning).toBe(false)
  })

  it('refuses image requests when the model is not multimodal', async () => {
    const shim = await startShim()
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({
        model: 'dmodel',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }],
      }),
    })
    expect(resp.status).toBe(400)
  })

  it('rejects empty message lists', async () => {
    const shim = await startShim()
    const resp = await chat(shim, { messages: [] })
    expect(resp.status).toBe(400)
  })

  it('surfaces missing PAT as an auth error before streaming', async () => {
    const shim = await startShim({ credential: () => undefined })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(401)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('invalid_api_key')
  })
})

describe('Qoder shim pool failover', () => {
  const accountA: QoderServingAccount = { accountId: 'acc-a', accountName: 'A', pat: 'pt-a' }
  const accountB: QoderServingAccount = { accountId: 'acc-b', accountName: 'B', pat: 'pt-b' }

  function poolShim(overrides: Partial<QoderShimOptions>): Promise<QoderShim> {
    return startShim({
      resolveServing: async () => accountA,
      failoverGapMs: 0,
      ...overrides,
    })
  }

  it('fails over to the next account and prefixes a VISIBLE notice into the first content chunk', async () => {
    const calls: ChatCall[] = []
    const failures: Array<[string, UpstreamErrorKind]> = []
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited' }, calls),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
      onServingFailure: (id, kind) => { failures.push([id, kind]) },
      failoverNotice: (from, _to, kind) =>
        failoverNoticeText({ accountName: from.accountName, accountId: from.accountId }, kind),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    expect(calls.map(c => c.credential)).toEqual(['pt-a', 'pt-b'])
    expect(failures).toEqual([['acc-a', 'rate-limited']])
    const chunks = parseSse(await resp.text()) as Array<{ choices?: Array<{ delta?: Record<string, unknown> }> }>
    // 通知必须是 pi-ai 可见的内容帧（choices[0].delta.content），不是空 choices 帧。
    const first = chunks[0]!
    expect(typeof first.choices?.[0]?.delta?.content).toBe('string')
    const text = first.choices?.[0]?.delta?.content as string
    expect(text).toContain('[dsh-connect-qoder]')
    // 说的是**失败的那个**账号（用户选中的 A），不是接管者 B。
    expect(text).toContain('「A」被限流')
    expect(text).not.toContain('「B」')
  })

  it('says nothing when the pool takes over without a swap (single account)', async () => {
    // 没有换号就没有可播报的事：首帧不得出现任何提示。
    const calls: ChatCall[] = []
    const shim = await poolShim({
      upstream: stubUpstream({}, calls),
      failoverAccount: async () => undefined,
      failoverNotice: () => '不该出现',
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    const chunks = parseSse(await resp.text()) as Array<{ choices?: Array<{ delta?: Record<string, unknown> }> }>
    expect(JSON.stringify(chunks)).not.toContain('[dsh-connect-qoder]')
  })

  it('writes exactly one notice even when several accounts fail in a row', async () => {
    // 连换两次只写一条提示（首帧只消费一次），说的是**紧邻的那次**失败。
    const accountC: QoderServingAccount = { accountId: 'acc-c', accountName: 'C', pat: 'pt-c' }
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited', 'pt-b': 'auth' }),
      failoverAccount: async tried => {
        if (!tried.includes('acc-b')) return accountB
        if (!tried.includes('acc-c')) return accountC
        return undefined
      },
      failoverNotice: (from, _to, kind) =>
        failoverNoticeText({ accountName: from.accountName, accountId: from.accountId }, kind),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    const text = await resp.text()
    const hits = text.split('[dsh-connect-qoder]').length - 1
    expect(hits).toBe(1)
    // A 被限流 → B 凭证失效 → C 成功：说的是 B（紧邻换号的那次）。
    expect(text).toContain('「B」凭证已失效')
    expect(text).not.toContain('「A」')
  })

  it('says nothing when no failoverNotice is configured (host opted out)', async () => {
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited' }),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    const chunks = parseSse(await resp.text()) as Array<{ choices?: Array<{ delta?: Record<string, unknown> }> }>
    expect(JSON.stringify(chunks)).not.toContain('[dsh-connect-qoder]')
  })

  it('reports the failure from the LAST attempt before the swap, not a stale first-attempt reason', async () => {
    // A 网络故障 → B 被限流 → C 成功。提示必须说「B 被限流」（紧邻换号的那次
    // 失败），而不是首轮的「网络中断」。
    const accountC: QoderServingAccount = { accountId: 'acc-c', accountName: 'C', pat: 'pt-c' }
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'network', 'pt-b': 'rate-limited' }, []),
      failoverAccount: async tried => {
        if (!tried.includes('acc-b')) return accountB
        if (!tried.includes('acc-c')) return accountC
        return undefined
      },
      failoverNotice: (from, _to, kind) =>
        failoverNoticeText({ accountName: from.accountName, accountId: from.accountId }, kind),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    const chunks = parseSse(await resp.text()) as Array<{ choices?: Array<{ delta?: Record<string, unknown> }> }>
    const text = JSON.stringify(chunks)
    expect(text).toContain('「B」被限流')
    expect(text).not.toContain('网络中断')
  })

  it('hands the upstream status AND business code to the host (issue #6)', async () => {
    // `kind` 只说「像什么」，不说「凭什么」：宿主要写池记录，就得知道这次 auth
    // 是业务码 105 确认的（该永久剔除），还是只是 403 兜底猜的（只该冷却）。
    // 少了这两个字段，宿主只能一律当永久剔除 —— 排队中的账号就此被踢出池。
    const seen: Array<{ kind: UpstreamErrorKind, status?: number | undefined, code?: string | undefined }> = []
    const upstream = {
      chatStream: async () => {
        throw new QoderUpstreamError('auth', '403 upstream', 403, '10605')
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({
      upstream,
      onServingFailure: (_id, kind, _message, context) => {
        seen.push({ kind, status: context?.status, code: context?.code })
      },
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(401)
    expect(seen).toEqual([{ kind: 'auth', status: 403, code: '10605' }])
  })

  it('records EVERY failed attempt and answers JSON when the pool is exhausted', async () => {
    const failures: Array<[string, UpstreamErrorKind]> = []
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited', 'pt-b': 'quota-exhausted' }),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
      onServingFailure: (id, kind) => { failures.push([id, kind]) },
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(429)
    const data = (await resp.json()) as { error: { code: string; message: string } }
    expect(data.error.code).toBe('quota_exceeded')
    // 两个账号都失败过：消息注明尝试数，最后一次失败也必须记测量。
    expect(data.error.message).toContain('after trying 2 accounts')
    expect(failures).toEqual([['acc-a', 'rate-limited'], ['acc-b', 'quota-exhausted']])
  })

  it('brakes when the policy repeats an already-tried account', async () => {
    const calls: ChatCall[] = []
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited' }, calls),
      // 策略层出错：不断把同一个账号还回来。shim 侧必须自己刹车。
      failoverAccount: async () => accountA,
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(429)
    expect(calls.length).toBe(1)
  })

  it('says the same thing only once across an agent round (hasAnnouncedFailover)', async () => {
    const seen = new Map<string, number>()
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'quota-exhausted' }),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
      failoverNotice: (from, _to, kind) =>
        failoverNoticeText({ accountName: from.accountName, accountId: from.accountId }, kind),
      // 与 src/index.ts 的 shouldAnnounceFailoverOnce 同一语义：第一次允许，之后同键拒绝。
      hasAnnouncedFailover: (from, to, kind) => {
        const key = `${from.accountId}|${to.accountId}|${kind}`
        if (seen.has(key)) return true
        seen.set(key, 0)
        return false
      },
    })
    const countNotices = async (): Promise<number> => {
      const resp = await chat(shim, {})
      const text = await resp.text()
      return text.split('[dsh-connect-qoder]').length - 1
    }
    // 一次 Agent 回合 = 十几轮调用，每轮都以同样方式换号。
    expect(await countNotices()).toBe(1)
    expect(await countNotices()).toBe(0)
    expect(await countNotices()).toBe(0)
  })

  it('announces a later failover with a different cause, on a later request', async () => {
    const accountC: QoderServingAccount = { accountId: 'acc-c', accountName: 'C', pat: 'pt-c' }
    // 第一轮：A 被限流 → B 接管（提示）。
    // 第二轮：B 用尽 → C 接管，**换了原因也换了接管账号**。
    //
    // 两轮必须是两条独立的 HTTP 请求。换号提示是「首个内容帧」——同一条响应里
    // 第二次换号没有可以写的位置（那一段已经排在成功尝试的正文之后，见
    // `firstAttemptOfRound`），而且 A→B 那条提示已经交给了客户端，不能想撤回。
    let serving: QoderServingAccount = accountA
    const shim = await poolShim({
      resolveServing: async () => serving,
      upstream: {
        chatStream: async (credential: string, _modelKey: string, _messages: Array<Record<string, unknown>>, options: {
          onDelta: (d: Delta) => void
        }) => {
          // ⚠️ 必须抛真正的 `QoderUpstreamError`：shim 用 `instanceof` 判定
          // 「上游错误」，同形状的普通 Error 会被当成组装问题、直接 500，换号
          // 根本不会发生（本用例第一版就踩了这个坑）。
          // 第一个请求只会试 A；重试用的这一次必须是**成功**的那一次，提示才有
          // 落点（第二个号在「另一轮」才用尽——那样两轮是两条独立请求，见注释）。
          if (credential === 'pt-a' && serving === accountA) {
            throw new QoderUpstreamError('rate-limited', 'code 429', 429)
          }
          if (credential === 'pt-b' && serving === accountB) {
            throw new QoderUpstreamError('quota-exhausted', 'code 110', 429)
          }
          options.onDelta(delta('Hello'))
        },
      } as unknown as QoderUpstreamClient,
      // 候选按「本轮已经试过谁」给：A 失败交 B，B 失败交 C。
      //
      // ⚠️ 不要按测试外层的 `serving` 分支：那个变量在**同一请求内不会**随 shim
      // 换号而变（shim 各自保存自己的 serving），第二轮会把 B 再交一次，被
      // shim 的 `tried` 刹车拦下（同一请求体对同一账号重发 = 空烧额度）→ 429。
      failoverAccount: async tried => {
        // 第一轮：只试过 A → 交 B。第二轮：只试过 B → 交 C。
        if (tried.length === 1) return tried[0] === 'acc-a' ? accountB : accountC
        return undefined
      },
      failoverNotice: (from, _to, kind) =>
        failoverNoticeText({ accountName: from.accountName, accountId: from.accountId }, kind),
      // 刻意**不提供** hasAnnouncedFailover：本用例只钉「不同的换号事实仍会播报」，
      // 去重逻辑本身由 src/index.ts 的 shouldAnnounceFailoverOnce 单测覆盖。
    })
    const first = await (await chat(shim, {})).text()
    expect(first).toContain('「A」')
    expect(first.split('[dsh-connect-qoder]').length - 1).toBe(1)

    serving = accountB
    const second = await (await chat(shim, {})).text()
    expect(second).toContain('当日用量已达上限')
    expect(second.split('[dsh-connect-qoder]').length - 1).toBe(1)
  })

  it('skips a failover candidate the host already knows is excluded', async () => {
    const calls: ChatCall[] = []
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'quota-exhausted' }, calls),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
      // 宿主：B 今天也用尽了（探针还在排除冷却里）。
      isAccountExcluded: accountId => accountId === 'acc-b',
    })
    const started = Date.now()
    const resp = await chat(shim, {})
    // 不再空跑一次必然失败的上游，也不先睡 2 秒。
    expect(calls.map(c => c.credential)).toEqual(['pt-a'])
    expect(resp.status).toBe(429)
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('waits the failover gap between attempts', async () => {
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'rate-limited' }),
      failoverAccount: async tried => (tried.includes('acc-b') ? undefined : accountB),
      failoverGapMs: 30,
    })
    const started = Date.now()
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it('does not fail over a client-invalid request (400)', async () => {
    const calls: ChatCall[] = []
    const shim = await poolShim({
      upstream: stubUpstream({ 'pt-a': 'invalid-request' }, calls),
      failoverAccount: async () => accountB,
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(400)
    expect(calls.length).toBe(1)
  })
})

// ==========================================================================
// 国际版「API 密钥无效」假警报（用户实拍）
//
// 现象：对话里报「密钥无效」，而同一条账号在插件卡片里只显示「用量已达上限」。
//
// 根因：宿主对 pi-ai 失败**不按 HTTP 状态分类，而是对文案跑正则**
// （app.asar 内 `classifyPiAiError`）：
//
//     if (/\b(?:401|403)\b/.test(message)) return "AUTH";      // 第一道
//     if (isQuotaExceededError(message))    return QUOTA;
//
// 而本插件为了溯源一直把上游原文（`HTTP 403 {"code":"110",…}`）拼进这条文案。
// `110` 是**配额族**（当日用量用尽，明天自动恢复），HTTP 403 只是上游用它承载
// 这个业务码的习惯。于是第一道正则把配额截走判成 AUTH，宿主再用中立文案
// `message.failure.auth`（「API 密钥无效」）**覆盖掉提供方消息** —— 一个明天
// 就自愈的账号被读成凭据坏了，还被要求去换 PAT。
//
// 下面断言的是**宿主真实代码的行为**：`classifyPiAiError` 从 app.asar 逐字提取
// 后由 `tests/host-piai.ts` 直接执行（不再手抄副本 —— 副本会跟宿主一起漂移，
// 「测试通过」就只证明副本自洽）。来源与哈希见 tests/fixtures/host-piai-classifier.json。
// ==========================================================================
describe('写给宿主的失败文案：宿主正则分类器必须读对', () => {

  it('golden 分类器仍与装机宿主逐字一致（宿主升级即变红，提示重新提取）', () => {
    // 这些用例的执行体是 app.asar 提取出来的原文，而 asar 不在仓库里 —— 所以
    // 自检直接读装机 asar 逐字比对。宿主没装（CI）时返回 undefined，跳过即可。
    const check = verifyFixtureAgainstInstalledHost()
    if (check !== undefined) expect(check).toEqual({ ok: true })
  })

  it('配额失败（上游用 403 承载 code 110）必须被读成配额，不是 AUTH', async () => {
    // 现场抓到的原文：上游对当日用量用尽回 HTTP 403 + `{"code":"110",…}`。
    const body = '上游信封错误: HTTP 403 {"code":"110","message":"Billing daily count exceeded"}'
    const shim = await startShim({
      upstream: {
        chatStream: async () => {
          throw new QoderUpstreamError('quota-exhausted', body, 403)
        },
      } as unknown as QoderUpstreamClient,
    })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string, code: string } }

    // 宿主看到的那串文本 → 必须落到 QUOTA（否则 UI 显示「API 密钥无效」）。
    expect(classifyPiAiError(data.error.message)).toBe('QUOTA')
    // 这才是**用户实拍的那句抱怨**的判据：落到会被中立文案覆盖的 code，用户就
    // 看不到上游的真实解释。配额与 AUTH 都会被覆盖（只是覆盖成不同的话），所以
    // 真正的验收是「不能是 AUTH」——
    expect(hostRendersOwnCopy(classifyPiAiError(data.error.message))).toBe(true)
    expect(classifyPiAiError(data.error.message)).not.toBe('AUTH')
    // 溯源信息不能丢：原文仍在，只是裸状态码被改写成 4xx。
    expect(data.error.message).toContain('110')
    expect(data.error.message).toContain('上游信封错误')
    expect(data.error.message).toContain('4xx')
    expect(data.error.message).not.toMatch(/\b(?:401|403)\b/u)
    expect(data.error.code).toBe('quota_exceeded')
  })

  it('限流失败（上游同样可能用 403 承载）不再被读成 AUTH', async () => {
    const shim = await startShim({
      upstream: {
        chatStream: async () => {
          throw new QoderUpstreamError('rate-limited', '上游信封错误: HTTP 403 {"code":"113"}', 403)
        },
      } as unknown as QoderUpstreamClient,
    })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string, code: string } }
    // 修复前这里读成 AUTH（「API 密钥无效」）。修复后落到宿主可原地重试的
    // RATE_LIMIT —— 这正是限流应有的分类。
    expect(classifyPiAiError(data.error.message)).not.toBe('AUTH')
    expect(classifyPiAiError(data.error.message)).toBe('RATE_LIMIT')
    // code 字段的既有翻译不动：KIND_HOST_CODE 把 rate-limited 翻成
    // quota_exceeded，避免宿主把重试预算烧在一个以小时计的上游冷却上。
    expect(data.error.code).toBe('quota_exceeded')
  })

  it('真正的凭据失败仍然读成 AUTH（修复不能把另一侧改坏）', async () => {
    const shim = await startShim({
      upstream: {
        chatStream: async () => {
          throw new QoderUpstreamError('auth', '401 TOKEN_EXPIRE', 401)
        },
      } as unknown as QoderUpstreamClient,
    })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string, code: string } }
    // `auth` 必须原文送达 —— AUTH 正是正确的答案，净化绝不能碰这一档。
    expect(classifyPiAiError(data.error.message)).toBe('AUTH')
    expect(data.error.message).toContain('401')
    expect(data.error.code).toBe('invalid_api_key')
  })

  it('hostMessageText / hostFailureMessage：只净化非 auth 档的裸 401/403', () => {
    expect(hostMessageText('quota-exhausted', 'HTTP 403 {"code":"110"}')).toBe('HTTP 4xx {"code":"110"}')
    expect(hostMessageText('rate-limited', 'HTTP 403 / 429')).toBe('HTTP 4xx / 429')
    expect(hostMessageText('auth', '401 TOKEN_EXPIRE')).toBe('401 TOKEN_EXPIRE')
    // 5xx 不能被动：宿主按它判 SERVER（可原地重试）。
    expect(hostMessageText('transient', 'HTTP 503 provider error')).toBe('HTTP 503 provider error')
    // 400 保留：宿主按它判 INVALID_REQUEST（不重试）。
    expect(hostMessageText('invalid-request', 'HTTP 400 bad')).toBe('HTTP 400 bad')
    // 404 里含 "40" 不该被半截匹配成 4xx 之外的怪东西。
    expect(hostMessageText('quota-exhausted', 'HTTP 404 nope')).toBe('HTTP 404 nope')
    // 数字边界：`\b` 只认整词，长数字里的 401/403 不能被改坏（那是溯源信息）。
    expect(hostMessageText('quota-exhausted', 'code=1401 ok')).toBe('code=1401 ok')
    expect(hostMessageText('quota-exhausted', 'err 4030x')).toBe('err 4030x')
    // 对抗审核 S1：`\b` 会在 `401.5` 的 `1` 与 `.` 之间成立，把它改写成非法的
    // `4xx.5`。小数（价格、倍率、耗时）不能被篡改。
    expect(hostMessageText('quota-exhausted', 'HTTP 401.5 half')).toBe('HTTP 401.5 half')
    expect(hostMessageText('quota-exhausted', 'ratio 1.403 ok')).toBe('ratio 1.403 ok')
    // 左边界：紧贴字母/下划线的不算独立状态码。
    expect(hostMessageText('quota-exhausted', 'v403 a403b code_403')).toBe('v403 a403b code_403')
    // 但句末句号不是小数，必须仍然净化。
    expect(hostMessageText('quota-exhausted', 'HTTP 403.')).toBe('HTTP 4xx.')
    // 该净化的必须净化：多次出现一次全换。
    expect(hostMessageText('quota-exhausted', '403 then 401')).toBe('4xx then 4xx')
    // 前缀里的状态码也由 formatter 负责净化 —— 这是第一版的漏洞（只净化原文、
    // 漏掉了自己写进 `(http …)` 的那个 403）。
    expect(hostFailureMessage('quota-exhausted', 403, 'boom')).toBe('qoder upstream quota-exhausted (http 4xx): boom')
    expect(hostFailureMessage('quota-exhausted', 403, 'boom')).not.toMatch(/\b403\b/u)
    // 对抗审核 S3：`suffix` 也必须在净化范围之内，否则将来它带上上游信息就绕过。
    expect(hostFailureMessage('quota-exhausted', 403, 'boom', ' HTTP 403 extra')).toBe(
      'qoder upstream quota-exhausted (http 4xx): boom HTTP 4xx extra',
    )
    // auth 档不带任何装饰：它一个字都不许改（连 suffix 也不加）。
    expect(hostFailureMessage('auth', 401, '未配置 Qoder PAT')).toBe('未配置 Qoder PAT')
    expect(hostFailureMessage('auth', 401, '401 TOKEN_EXPIRE', ' HTTP 403')).toBe('401 TOKEN_EXPIRE')
    // 429 保留：宿主按它判 RATE_LIMIT。
    expect(hostFailureMessage('rate-limited', 429, 'slow down')).toBe('qoder upstream rate-limited (http 429): slow down')
  })

  it('流内错误帧（200 已提交后的 SSE error）同样被净化', async () => {
    // 宿主对 pi-ai 的 `case "error"` 分支拿 message 跑同一个 classifyPiAiError，
    // 所以这条路径漏了净化，配额失败一样会被读成 AUTH。
    const upstream = {
      chatStream: async (_c: string, _m: string, _msgs: unknown[], options: { onDelta: (d: Delta) => void }) => {
        options.onDelta(delta('partial'))
        throw new QoderUpstreamError(
          'quota-exhausted',
          '上游信封错误: HTTP 403 {"code":"110","message":"Billing daily count exceeded"}',
          403,
        )
      },
    } as unknown as QoderUpstreamClient
    const shim = await startShim({ upstream })
    const resp = await chat(shim, {})
    // 已提交字节 → 错误进流，HTTP 200 不变。
    expect(resp.status).toBe(200)
    const chunks = parseSse(await resp.text()) as Array<{ error?: { code: string, message: string } }>
    const errorChunk = chunks.find(chunk => chunk.error !== undefined)
    expect(errorChunk?.error?.code).toBe('quota_exceeded')
    const message = errorChunk!.error!.message
    expect(classifyPiAiError(message)).toBe('QUOTA')
    expect(classifyPiAiError(message)).not.toBe('AUTH')
    // 溯源信息不丢：业务码 110 与上游原文仍在。
    expect(message).toContain('110')
    expect(message).toContain('Billing daily count exceeded')
  })

  it('凭据解析阶段的失败（第三条路径）也被净化并带上 kind 线索', async () => {
    const shim = await startShim({
      resolveServing: async () => {
        throw new QoderUpstreamError('quota-exhausted', '上游信封错误: HTTP 403 {"code":"115"}', 403)
      },
    })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string } }
    // 去掉 kind 前缀会落到 TRANSPORT（宿主的兜底），所以前缀是必须的。
    expect(classifyPiAiError(data.error.message)).toBe('QUOTA')
    expect(data.error.message).toContain('115')
    expect(data.error.message).not.toMatch(/\b403\b/u)
  })

  it('未配置 PAT：原文送达，不被换成宿主的中立「API 密钥无效」', async () => {
    // `resolveFallbackCredential` 抛的 auth。这条中文没有状态码，宿主判不出 AUTH
    // 就会**原样显示**它（TRANSPORT 兜底），对人来说比「API 密钥无效」更有用，
    // 所以 auth 档刻意不加任何装饰。
    const shim = await startShim({ credential: () => undefined as unknown as string })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string, code: string } }
    expect(resp.status).toBe(401)
    expect(data.error.code).toBe('invalid_api_key')
    expect(data.error.message).toContain('PAT')
    expect(classifyPiAiError(data.error.message)).not.toBe('AUTH')
  })

  it('请求体带来的模型名不能让 400 被读成 AUTH（同一类缺陷的动态版本）', async () => {
    // 对抗审核 §6.2：`模型 ${model} 不支持图像输入` 里的 model 来自**请求体**，
    // 是唯一一条带动态插值的静态校验文案。目录里若存在 `gpt-401` 这类名字，
    // 原文送达会把「不支持图片」读成「API 密钥无效」。
    //
    // 注意分类发生在 **pi-ai 拼上响应状态码之后**：单看 message 是
    // `PI_AI_ERROR`（没有 400 也没有关键词），`400 <msg>` 才是宿主真正看到的
    // 文本 —— 所以断言必须带上状态码前缀，否则测的不是真实管线。
    const shim = await startShim()
    const resp = await chat(shim, {
      model: 'gpt-401',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }],
    })
    expect(resp.status).toBe(400)
    const data = (await resp.json()) as { error: { message: string, code: string } }
    expect(classifyPiAiError(`${resp.status} ${data.error.message}`)).toBe('INVALID_REQUEST')
    expect(classifyPiAiError(`${resp.status} ${data.error.message}`)).not.toBe('AUTH')
    // 模型名本身仍可读（改的只是那个裸状态码数字）。
    expect(data.error.message).toContain('gpt-4xx')
    expect(data.error.code).toBe('invalid_request_error')
  })

  it('真正的 TOKEN_EXPIRE（上游原文自带 401）仍判 AUTH', async () => {
    const shim = await startShim({
      upstream: {
        chatStream: async () => {
          throw new QoderUpstreamError('auth', '401 TOKEN_EXPIRE', 401)
        },
      } as unknown as QoderUpstreamClient,
    })
    const resp = await chat(shim, {})
    const data = (await resp.json()) as { error: { message: string, code: string } }
    // auth 档原文照送 → 宿主判 AUTH，这正是该账号真被拒时的正确答案。
    expect(classifyPiAiError(data.error.message)).toBe('AUTH')
    expect(data.error.message).toContain('TOKEN_EXPIRE')
    expect(data.error.code).toBe('invalid_api_key')
  })

  it('整条真实管线：pi-ai 会把响应状态码前缀到文案上，净化后仍判对', async () => {
    // pi-ai 的 `ApiError.makeMessage` 是 `return `${status} ${msg}`` —— 所以宿主
    // 分类器看到的文本 = **shim 的响应状态码 + shim 的 message**。
    //
    // 这带来一个必须钉住的前提：配额族**必须以 429 送达**（`ERROR_MAP` 如此），
    // 否则那个被前缀上去的状态码自己就是 AUTH 的判据，净化文案也救不回来。
    const shim = await startShim({
      upstream: {
        chatStream: async () => {
          throw new QoderUpstreamError(
            'quota-exhausted',
            '上游信封错误: HTTP 403 {"code":"110","message":"Billing daily count exceeded"}',
            403,
          )
        },
      } as unknown as QoderUpstreamClient,
    })
    const resp = await chat(shim, {})
    // 前提一：响应状态不是 401/403（否则 pi-ai 前缀上去就注定被判 AUTH）。
    expect(resp.status).toBe(429)
    const data = (await resp.json()) as { error: { message: string } }
    // 前提二：拼上 pi-ai 的前缀之后，分类仍然是配额。
    expect(classifyPiAiError(`${resp.status} ${data.error.message}`)).toBe('QUOTA')
    expect(classifyPiAiError(`${resp.status} ${data.error.message}`)).not.toBe('AUTH')
  })
})
