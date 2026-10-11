/**
 * Qoder 回环 shim：进程内 HTTP 服务（127.0.0.1 随机端口）。
 *
 * 安全模型与 dsh-connect-workbuddy 一致（参考其 `src/shim.ts`）：
 * - 随机端口 + 进程内 32 字节随机 secret（pi-ai 只拿到 secret 当 apiKey，
 *   真实的 Qoder 凭据绝不交给 pi-ai）；
 * - Host / Origin / Content-Type 三重入站校验（必须在路由判定之前）；
 * - 常量时间比对 Authorization。
 *
 * 职责：把 pi-ai 的 OpenAI 聊天请求翻译成 Qoder 网关请求，并把 Qoder 的
 * OpenAI 形状 SSE 原样转发为 OpenAI chunks；错误分类映射为 DSH 可判定的
 * HTTP 状态 + error.code。
 *
 * 账号池故障转移（参考 dsh-connect-workbuddy 的 `src/shim.ts` 相同模式）：
 * - 每次请求先 `resolveServing()` 解析**本次该买单的账号**（账号池排序结果或
 *   用户显式选择；缺省落到 `credential()` 的默认解析）；
 * - 首块字节写出前若上游硬拒（auth / 限流 / 额度 / 瞬时），记录该账号的失败
 *   （`onServingFailure` → live-request 写回账号池），再 `failoverAccount()`
 *   取下一个候选重试 —— **只在未写任何 SSE 前重试**，一旦首个 delta 已转发，
 *   之后的错误原样进流（不回放、不换号）；
 * - 被账号池接管时，首块 delta 携带 `notice` 字段说明「本次由账号池账号 X
 *   服务」，便于用户在流里看到买单账号并非默认选择。
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

/** One resolvable serving credential, as the shim sees it. */
export interface QoderServingAccount {
  accountId: string
  accountName: string
  pat: string
}

export interface QoderShimOptions {
  upstream: QoderUpstreamClient
  /**
   * Fallback credential resolution (settings → env). Used when the pool-elected
   * serving account is undefined, i.e. the "auto"/default path.
   */
  credential: () => string | undefined
  /**
   * The account this request should bill through, decided BEFORE any byte is
   * written. Undefined means "fall back to `credential()`", which is how a pool
   * disabled / no-usable-member region keeps serving its selected account.
   */
  resolveServing?: () => Promise<QoderServingAccount | undefined>
  /**
   * The next account to try after `triedIds` all failed before the first byte.
   * Undefined means failover is exhausted; the request then reports the last
   * failure.
   */
  failoverAccount?: (triedIds: readonly string[]) => Promise<QoderServingAccount | undefined>
  /** Record one serving account's pre-first-byte failure (pool measurement). */
  onServingFailure?: (accountId: string, kind: UpstreamErrorKind, message: string) => void
  /**
   * Optional notice text to carry on the first chunk when the serving account
   * is not the user's explicit selection (i.e. the pool took over).
   */
  poolServingNotice?: (accountId: string) => string | undefined
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

/**
 * Round about which upstream failures are worth spending a failover attempt
 * on. A request never starts, wait / fix input / the model is gone, a
 * content-policy refusal is about THIS message (the next account would be
 * refused the same way), and a mid-stream error has already committed bytes.
 * Only a failure where the serving account was the problem and nothing has
 * been written yet deserves to move to the next account.
 */
function isFailoverEligible(kind: UpstreamErrorKind): boolean {
  return kind === 'auth'
    || kind === 'rate-limited'
    || kind === 'quota-exhausted'
    || kind === 'network'
    || kind === 'transient'
}

export function createQoderShim(options: QoderShimOptions): QoderShim {
  const { upstream } = options
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
    return /^127\.0\.0\.1:\d+$/.test(host)
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

  function resolveFallbackCredential(): string {
    const pat = options.credential()
    if (!pat) {
      throw new QoderUpstreamError('auth', '未配置 Qoder PAT：请在插件设置里填写，或设置环境变量', 401)
    }
    return pat
  }

  async function handleModels(res: import('node:http').ServerResponse): Promise<void> {
    // 目录由宿主维护，shim 只回 id 列表；这里从 catalog 的 key 派生出 id 序列。
    const ids = listModelIds()
    const models = ids.map((id) => ({ id, object: 'model', owned_by: 'qoder' }))
    writeJson(res, 200, { object: 'list', data: models })
  }

  function listModelIds(): string[] {
    // The Host owns the roster; this shim serves the ids of the current catalog
    // so OpenAI clients that enumerate before model selection see the same set.
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
      writeJson(res, 400, { error: { message: 'only streaming is supported', code: 'invalid_request_error' } })
      return
    }

    // reasoning 档：DSH 的 thinking 选择落在 `reasoning_effort` 上。Qoder 的
    // 线是布尔 `is_reasoning`：`off` → false；任何正档 → true；否则回落到
    // stream_options.include_reasoning。
    const isReasoning = isReasoningRequested(body)

    // 用账号池解析本次服务的账号（可多账号 / 池接管 / 默认回落）。
    let serving: QoderServingAccount | undefined
    try {
      serving = await (options.resolveServing ? options.resolveServing() : Promise.resolve(undefined))
      if (serving === undefined) {
        serving = { accountId: 'default', accountName: '', pat: resolveFallbackCredential() }
      }
    } catch (error) {
      const mapped = isQoderUpstreamError(error) ? ERROR_MAP[error.kind] : { status: 500, code: 'upstream_error' }
      writeJson(res, mapped.status, { error: { message: (error as Error).message, code: mapped.code, type: 'qoder_error' } })
      return
    }

    const requestId = `chatcmpl-${randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const tried: string[] = []

    // 本轮尝试：写 SSE 头 + 转发流。返回前若抛错且尚未写出任何字节，则上游
    // `wroteAny` 保持 false，可进入换号重试。
    for (;;) {
      let wroteAny = false
      let hasToolCalls = false
      let inputTokens = 0
      let outputTokens = 0
      let notice = options.poolServingNotice ? options.poolServingNotice(serving.accountId) : undefined
      // 已显式选择的账号不因池接管而被错误标注 —— 由 poolServingNotice 自行决定
      // 何时返回文案（默认返回 undefined → 不标）。
      try {
        await upstream.chatStream(serving.pat, key, messages, {
          ...(tools === undefined ? {} : { tools }),
          isReasoning,
          isVl: supportsImages,
          ...(req.destroyed ? { signal: AbortSignal.abort() } : {}),
          onDelta: (delta) => {
            if (!wroteAny) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              })
              // 池接管时在首个 delta 帧后补一个空 choices 的 notice 帧，不动首块
              // delta 的 JSON 形状（对任何 OpenAI SSE 消费者都是合法 chunk）。
              if (notice !== undefined) {
                res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', id: requestId, created, model, choices: [], notice })}\n\n`)
                notice = undefined
              }
              wroteAny = true
            }
            if (delta.inputTokens > 0) inputTokens = delta.inputTokens
            if (delta.outputTokens > 0) outputTokens = delta.outputTokens
            if (delta.toolCalls !== undefined) hasToolCalls = true
            writeDeltaChunk(res, requestId, created, model, delta)
          },
        })
        // chatStream 正常结束：统计块 + [DONE]。finish_reason 依据是否出现过
        // tool_call；有 token 统计时附带 usage。
        if (res.destroyed) return
        const done = makeChunk(requestId, created, model)
        done.choices[0]!.finish_reason = hasToolCalls ? 'tool_calls' : 'stop'
        if (inputTokens > 0 || outputTokens > 0) {
          done.usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
        }
        res.write(`data: ${JSON.stringify(done)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      } catch (error) {
        if (wroteAny) {
          // 已提交字节：错误进流（不换号）。
          writeErrorChunk(res, requestId, created, model, error)
          return
        }
        if (isQoderUpstreamError(error) && isFailoverEligible(error.kind)) {
          options.onServingFailure?.(serving.accountId, error.kind, error.message)
          tried.push(serving.accountId)
          let next: QoderServingAccount | undefined
          try {
            next = options.failoverAccount ? await options.failoverAccount(tried) : undefined
          } catch {
            next = undefined
          }
          if (next !== undefined) {
            logger(`shim failover: ${serving.accountId} → ${next.accountId} (${error.kind})`)
            serving = next
            continue
          }
          // 没有下一个候选：以 SSE 错误流如实回传（先写头 + 错误块 + [DONE]）。
          // 与工作清单族内一致：上游已判定的失败（凭据/限流/额度/瞬时）一律进
          // SSE 错误帧，让 DSH 按 code 判定后续（原地重试 vs 跨 provider）；只有
          // 请求组装阶段的问题（缺 PAT / 坏 body）才是前置 JSON 状态。绝不静默
          // 换上别的东西。
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          writeErrorChunk(res, requestId, created, model, error)
          return
        }
        // 请求本身不合法 / 内容审核 / 未知错误：不进换号逻辑。
        throw error
      }
    }
  }

  /** 从请求体决定本次的 `is_reasoning`（见在线路上的注释）。 */
  function isReasoningRequested(body: Record<string, unknown>): boolean {
    const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
    if (effort === 'off') return false
    if (effort !== undefined && effort !== '') return true
    const streamOptions = body.stream_options as Record<string, unknown> | undefined
    return streamOptions?.include_reasoning === true
  }

  function writeDeltaChunk(
    res: import('node:http').ServerResponse,
    id: string,
    created: number,
    model: string,
    delta: QoderChatDelta,
  ): void {
    const chunk = makeChunk(id, created, model)
    const choice = chunk.choices[0]!
    if (delta.role !== '') choice.delta.role = delta.role
    if (delta.content !== '') choice.delta.content = delta.content
    if (delta.reasoningContent !== '') choice.delta.reasoning_content = delta.reasoningContent
    if (delta.toolCalls !== undefined) choice.delta.tool_calls = delta.toolCalls
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  function writeErrorChunk(
    res: import('node:http').ServerResponse,
    id: string,
    created: number,
    model: string,
    error: unknown,
  ): void {
    if (res.destroyed) return
    const errChunk = makeChunk(id, created, model)
    errChunk.choices[0]!.finish_reason = 'error'
    const code = isQoderUpstreamError(error) ? ERROR_MAP[error.kind].code : 'upstream_error'
    errChunk.error = { message: String((error as Error).message ?? 'internal error'), code, type: 'qoder_error' }
    res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
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