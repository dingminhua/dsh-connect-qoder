import { afterEach, describe, expect, it } from 'vitest'
import { createQoderShim, type QoderShim } from '../src/shim.ts'
import { QoderUpstreamError, type QoderUpstreamClient } from '../src/upstream.ts'

const shims: QoderShim[] = []

function stubUpstream(behavior: 'ok' | 'rate-limited' | 'auth'): QoderUpstreamClient {
  return {
    chatStream: async (_credential: string, _modelKey: string, _messages: Array<Record<string, unknown>>, options: {
      tools?: unknown[]
      isReasoning?: boolean
      isVl?: boolean
      signal?: AbortSignal
      onDelta: (delta: { role: string; content: string; reasoningContent: string; toolCalls: unknown[] | undefined; inputTokens: number; outputTokens: number }) => void
      userType?: string
    }) => {
      if (behavior === 'rate-limited') throw new QoderUpstreamError('rate-limited', '429 upstream', 429)
      if (behavior === 'auth') throw new QoderUpstreamError('auth', '401 upstream', 401)
      options.onDelta({ role: 'assistant', content: 'Hello', reasoningContent: '', toolCalls: undefined, inputTokens: 5, outputTokens: 2 })
    },
  } as unknown as QoderUpstreamClient
}

async function startShim(behavior: 'ok' | 'rate-limited' | 'auth' = 'ok'): Promise<QoderShim> {
  const shim = createQoderShim({
    upstream: stubUpstream(behavior),
    credential: () => 'pt-stub',
    modelKeyOf: (name: string) => (name === 'dmodel' ? 'dmodel' : undefined),
    supportsImagesOf: () => false,
    logger: () => {},
  })
  shims.push(shim)
  await shim.ready
  return shim
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
})

describe('Qoder shim chat translation', () => {
  it('streams OpenAI-shaped SSE chunks and a final chunk', async () => {
    const shim = await startShim()
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/event-stream')
    const text = await resp.text()
    const lines = text.split('\n').filter(line => line.startsWith('data: '))
    const chunks = lines
      .filter(line => !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: Record<string, unknown>; error?: { code?: string } })
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

  it('maps upstream errors onto SSE error chunks with the DSH code', async () => {
    const shim = await startShim('rate-limited')
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await resp.text()
    const line = text.split('\n').find(line => line.startsWith('data: ') && line.includes('error'))!
    const chunk = JSON.parse(line.slice(6)) as { error: { code: string; message: string }; choices: Array<{ finish_reason: string }> }
    expect(chunk.error.code).toBe('rate_limit_exceeded')
    expect(chunk.choices[0]!.finish_reason).toBe('error')
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
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [] }),
    })
    expect(resp.status).toBe(400)
  })

  it('surfaces missing PAT as an auth error before streaming', async () => {
    const shim = createQoderShim({
      upstream: stubUpstream('ok'),
      credential: () => undefined,
      modelKeyOf: () => undefined,
      supportsImagesOf: () => false,
      logger: () => {},
    })
    shims.push(shim)
    await shim.ready
    const resp = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(resp.status).toBe(401)
    const data = (await resp.json()) as { error: { code: string } }
    expect(data.error.code).toBe('invalid_api_key')
  })
})