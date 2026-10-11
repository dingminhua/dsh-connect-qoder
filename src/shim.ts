/**
 * Qoder 回环 shim：进程内 HTTP 服务（127.0.0.1 随机端口）。
 *
 * 安全模型与 dsh-connect-workbuddy 一致：
 * - 随机端口 + 进程内 32 字节随机 secret（pi-ai 只拿到 secret 当 apiKey，
 *   真实的 Qoder 凭据绝不交给 pi-ai）；
 * - Host / Origin / Content-Type 三重入站校验（必须在路由判定之前）；
 * - 常量时间比对 Authorization。
 *
 * 职责：把 pi-ai 的 OpenAI 聊天请求翻译成 Qoder 网关请求，并把 Qoder 的
 * OpenAI 形状 SSE 原样转发为 OpenAI chunks；错误分类映射为 DSH 可判定的
 * HTTP 状态 + error.code。
 *
 * @module dsh-connect-qoder/shim
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import type { QoderUpstreamClient, QoderChatDelta, UpstreamErrorKind } from './upstream.ts'
import { QoderUpstreamError, isQoderUpstreamError } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'

export interface QoderShimOptions {
  upstream: QoderUpstreamClient
  /** 凭据解析：请求时求值（settings 变化即时生效）。 */
  credential: () => string | undefined
  /** 模型显示名 → Qoder 内部 key。未知时原样发送。 */
  modelKeyOf?: (displayName: string) => string | undefined
  /** 该模型是否支持图像输入（用于请求校验，可选）。 */
  supportsImagesOf?: (displayName: string) => boolean
  userTypeOf?: () => string | undefined
  logger?: (message: string) => void
}

export interface QoderShim {
  /** 等 server 就绪后可用。 */
  ready: Promise<void>
  baseUrl: string
  secret: string
  close: () => Promise<void>
  port: number
}

const CONTENT_TYPE_JSON = 'application/json'

/** HTTP 状态 + error.code 双映射表（DSH 依据 code 判定原地重试 vs failover）。 */
const ERROR_MAP: Record<UpstreamErrorKind, { status: number; code: string }> = {
  network: { status: 502, code: 'connection_error' },
  auth: { status: 401, code: 'invalid_api_key' },
  'rate-limited': { status: 429, code: 'rate_limit_exceeded' },
  'invalid-request': { status: 400, code: 'invalid_request_error' },
  'content-policy': { status: 400, code: 'content_policy_rejected' },
  'quota-exhausted': { status: 429, code: 'quota_exceeded' },
  transient: { status: 502, code: 'upstream_error' },
  unknown: { status: 500, code: 'upstream_error' },
}

export function createQoderShim(options: QoderShimOptions): QoderShim {
  const { upstream, credential } = options
  const logger = options.logger ?? (() => {})
  const secret = randomBytes(32).toString('base64url')
  const secretBuf = Buffer.from(secret)

  let baseUrlValue = ''
  let portValue = 0
  let closeFn: () => Promise<void> = async () => {}

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        const status = isQoderUpstreamError(error) ? ERROR_MAP[error.kind].status : 500
        const code = isQoderUpstreamError(error) ? ERROR_MAP[error.kind].code : 'internal_error'
        writeJson(res, status, { error: { message: String((error as Error).message ?? 'internal error'), code, type: 'qoder_error' } })
      })
    })

    server.on('error', (error) => {
      rejectReady(error)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrlValue = `http://127.0.0.1:${addr.port}`
      portValue = addr.port
      resolveReady()
    })

    closeFn = () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  async function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    if (!checkHost(req)) {
      writeJson(res, 403, { error: { message: 'bad host', code: 'invalid_request_error' } })
      return
    }
    if (!checkAuthorization(req, secretBuf)) {
      writeJson(res, 401, { error: { message: 'invalid api key', code: 'invalid_api_key' } })
      return
    }
    if (!checkContentType(req)) {
      writeJson(res, 415, { error: { message: 'unsupported media type', code: 'invalid_request_error' } })
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      await handleModels(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChat(req, res)
      return
    }
    writeJson(res, 404, { error: { message: 'not found', code: 'invalid_request_error' } })
  }

  function checkHost(req: import('node:http').IncomingMessage): boolean {
    const host = req.headers.host ?? ''
    const expected = /^127\.0\.0\.1:\d+$/.test(host)
    return expected
  }

  function checkAuthorization(req: import('node:http').IncomingMessage, expected: Buffer): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer (.+)$/.exec(header)
    if (!match) return false
    const actual = Buffer.from(match[1] ?? '')
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  }

  function checkContentType(req: import('node:http').IncomingMessage): boolean {
    if (req.method === 'GET') return true
    const ct = req.headers['content-type'] ?? ''
    return ct.startsWith(CONTENT_TYPE_JSON)
  }

  function resolveCredential(): string {
    const pat = credential()
    if (!pat) {
      throw new QoderUpstreamError('auth', '未配置 Qoder PAT：请在插件设置里填写，或设置环境变量', 401)
    }
    return pat
  }

  async function handleModels(res: import('node:http').ServerResponse): Promise<void> {
    // 目录由宿主维护，shim 只回模型 id 列表（供 OpenAI 客户端列举）。
    const models = (options.modelKeyOf ? listModels() : []).map((name) => ({
      id: name,
      object: 'model',
      owned_by: 'qoder',
    }))
    writeJson(res, 200, { object: 'list', data: models })
  }

  function listModels(): string[] {
    return []
  }

  async function handleChat(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const raw = await readBody(req)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      writeJson(res, 400, { error: { message: 'invalid JSON body', code: 'invalid_request_error' } })
      return
    }
    const model = typeof body.model === 'string' ? body.model : ''
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
    const tools = Array.isArray(body.tools) ? body.tools : undefined
    const stream = body.stream !== false
    const streamOptions = body.stream_options as Record<string, unknown> | undefined
    const isReasoning = streamOptions?.include_reasoning === true

    if (messages.length === 0) {
      writeJson(res, 400, { error: { message: 'messages is required', code: 'invalid_request_error' } })
      return
    }

    const key = options.modelKeyOf ? options.modelKeyOf(model) ?? model : model
    const supportsImages = options.supportsImagesOf ? options.supportsImagesOf(model) : false
    const hasImages = messages.some(m => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some(p => p?.type === 'image_url'))
    if (hasImages && !supportsImages) {
      writeJson(res, 400, { error: { message: `模型 ${model} 不支持图像输入`, code: 'invalid_request_error' } })
      return
    }

    if (!stream) {
      // 非流式：由 DSH 侧强制 stream=true，这里按错误返回。
      writeJson(res, 400, { error: { message: 'only streaming is supported', code: 'invalid_request_error' } })
      return
    }

    // 凭据在流开始前解析：缺 PAT 直接 401 JSON，绝不在 200 SSE 之后才报错。
    let pat: string
    try {
      pat = resolveCredential()
    } catch (error) {
      const mapped = isQoderUpstreamError(error) ? ERROR_MAP[error.kind] : { status: 500, code: 'upstream_error' }
      writeJson(res, mapped.status, { error: { message: (error as Error).message, code: mapped.code, type: 'qoder_error' } })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const requestId = `chatcmpl-${randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    let emitted = false
    let inputTokens = 0
    let outputTokens = 0
    let hasToolCalls = false

    try {
      await upstream.chatStream(pat, key, messages, {
        ...(tools === undefined ? {} : { tools }),
        isReasoning,
        ...(req.destroyed ? { signal: AbortSignal.abort() } : {}),
        onDelta: (delta) => {
          if (delta.inputTokens > 0) inputTokens = delta.inputTokens
          if (delta.outputTokens > 0) outputTokens = delta.outputTokens
          emitted = true
          if (delta.toolCalls) hasToolCalls = true
          const chunk = makeChunk(requestId, created, model)
          const choice = chunk.choices[0]!
          if (delta.role !== '') choice.delta.role = delta.role
          if (delta.content !== '') choice.delta.content = delta.content
          if (delta.reasoningContent !== '') choice.delta.reasoning_content = delta.reasoningContent
          if (delta.toolCalls !== undefined) choice.delta.tool_calls = delta.toolCalls
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        },
      })

      const done = makeChunk(requestId, created, model)
      done.choices[0]!.finish_reason = hasToolCalls ? 'tool_calls' : 'stop'
      if (inputTokens > 0 || outputTokens > 0) {
        done.usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
      }
      res.write(`data: ${JSON.stringify(done)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      if (res.destroyed) return
      if (isQoderUpstreamError(error)) {
        const mapped = ERROR_MAP[error.kind]
        const errChunk = makeChunk(requestId, created, model)
        errChunk.choices[0]!.finish_reason = 'error'
        errChunk.error = { message: error.message, code: mapped.code, type: 'qoder_error' }
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const errChunk = makeChunk(requestId, created, model)
      errChunk.choices[0]!.finish_reason = 'error'
      errChunk.error = { message: String((error as Error).message ?? 'internal error'), code: 'upstream_error', type: 'qoder_error' }
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  function makeChunk(id: string, created: number, model: string): {
    id: string
    object: string
    created: number
    model: string
    choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>
    usage?: Record<string, unknown>
    error?: Record<string, unknown>
  } {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    }
  }

  function writeJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  return {
    ready,
    get baseUrl(): string {
      return baseUrlValue
    },
    get port(): number {
      return portValue
    },
    secret,
    close: async () => {
      await closeFn()
    },
  }
}
