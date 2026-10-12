import { afterEach, describe, expect, it } from 'vitest'
import { createQoderShim, type QoderShim, type QoderShimOptions, type QoderServingAccount } from '../src/shim.ts'
import { QoderUpstreamError, type QoderUpstreamClient, type UpstreamErrorKind } from '../src/upstream.ts'

const shims: QoderShim[] = []

type Delta = { role: string; content: string; reasoningContent: string; toolCalls: unknown[] | undefined; inputTokens: number; outputTokens: number }

interface ChatCall {
  credential: string
  modelKey: string
  tools?: unknown[] | undefined
  signal?: AbortSignal | undefined
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
      isVl?: boolean
      signal?: AbortSignal
      onDelta: (d: Delta) => void
      userType?: string
    }) => {
      calls.push({ credential, modelKey, tools: options.tools, signal: options.signal })
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
    // [DONE]
    expect(lines.at(-1)).toBe('data: [DONE]')
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
      poolServingNotice: id => (id === 'acc-b' ? '本次由账号 B 服务' : undefined),
    })
    const resp = await chat(shim, {})
    expect(resp.status).toBe(200)
    expect(calls.map(c => c.credential)).toEqual(['pt-a', 'pt-b'])
    expect(failures).toEqual([['acc-a', 'rate-limited']])
    const chunks = parseSse(await resp.text()) as Array<{ choices?: Array<{ delta?: Record<string, unknown> }> }>
    // 通知必须是 pi-ai 可见的内容帧（choices[0].delta.content），不是空 choices 帧。
    const first = chunks[0]!
    expect(typeof first.choices?.[0]?.delta?.content).toBe('string')
    expect(first.choices?.[0]?.delta?.content as string).toContain('[dsh-connect-qoder]')
    expect(first.choices?.[0]?.delta?.content as string).toContain('本次由账号 B 服务')
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
