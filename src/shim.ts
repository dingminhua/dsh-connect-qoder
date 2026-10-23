/**
 * Qoder 回环 shim：进程内 HTTP 服务（127.0.0.1 随机端口）。
 *
 * 安全模型与 dsh-connect-workbuddy 一致（参考其 `src/shim.ts`）：
 * - 随机端口 + 进程内 32 字节随机 secret（pi-ai 只拿到 secret 当 apiKey，
 *   真实的 Qoder 凭据绝不交给 pi-ai）；
 * - Host / Origin / Content-Type 三重入站校验（必须在路由判定之前），
 *   请求体有 64MB 上限；
 * - 常量时间比对 Authorization。
 *
 * 职责：把 pi-ai 的 OpenAI 聊天请求翻译成 Qoder 网关请求，并把 Qoder 的
 * OpenAI 形状 SSE 原样转发为 OpenAI chunks；错误分类映射为 DSH 可判定的
 * HTTP 状态 + error.code。
 *
 * 首字节之前的失败一律回 **非 200 的 JSON 错误**（不是 SSE 错误帧）：pi-ai
 * 的 openai-completions 客户端只认非 2xx 响应体的 `error.message/code`，
 * 对 200 流里的 `error` 字段完全不读（chunk 循环只取 `choices[0]`，
 * `finish_reason:"error"` 会被塌缩成一句无信息的 "Provider finish_reason:
 * error"）。只有 JSON 错误能把真实的 kind/code 送进宿主的分类器。
 *
 * 账号池故障转移（参考 dsh-connect-workbuddy 的 `src/shim.ts` 相同模式）：
 * - 每次请求先 `resolveServing()` 解析**本次该买单的账号**——就是用户显式
 *   选中的号（缺省落到 `credential()` 的默认解析：settings → env → 首个
 *   vault）；账号池的排序**不参与第一发**，它只在下面的接管路径里出场；
 * - 首块字节写出前若上游硬拒（auth / 限流 / 额度 / 瞬时），记录该账号的失败
 *   （`onServingFailure` → live-request 写回账号池），间隔
 *   `failoverGapMs`（默认 2s，可中断）后再 `failoverAccount()` 取下一个候选
 *   重试 —— **只在未写任何 SSE 前重试**，一旦首个 delta 已转发，之后的错误
 *   原样进流（不回放、不换号）；策略层若重复返回已试过的账号，shim 侧也刹车；
 * - 客户端中途断开（响应流 close）会中止上游请求，且**不**为该次失败记测量
 *   （那是断开，不是账号的错）；
 * - 被账号池接管时，首个内容帧以引用块前缀说明「本次由账号池账号 X 服务」
 *   （必须走 `choices[0].delta.content`——空 choices 的自定义帧会被 pi-ai
 *   直接跳过，用户将完全看不到换号）。
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
import { shouldAnnounceFailover } from './failover-notice.ts'

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
  /**
   * Record one serving account's pre-first-byte failure (pool measurement).
   *
   * `context` 说这条失败**凭什么**被判成这个 kind（issue #6）：`kind` 只说「像
   * 什么」，不说「凭什么」。`auth` 既可能是业务码 `105` 确认的凭据被拒（此时
   * 永久剔除账号是对的），也可能只是 HTTP 403 兜底猜的（此时永久剔除会把一个
   * 排队/限流中的账号踢出池且不自愈）。宿主写池记录需要这个区别，所以把上游
   * 状态与业务码一起递过去。
   */
  onServingFailure?: (
    accountId: string,
    kind: UpstreamErrorKind,
    message: string,
    context?: { status?: number | undefined, code?: string | undefined },
  ) => void
  /**
   * 判定「这条换号通知是否已经对用户说过」，说过就把这条并入上一次、不再重复写。
   *
   * 为什么需要它：一次 Agent 回合里有十几轮模型调用（思考 / 运行命令 / 读取 /
   * 编辑…）。用户的账号当日用尽后，**每一轮**都会先撞 110、再换到同一个备用号
   * 回答——`notice` 是每轮请求的局部变量，于是十几条一模一样的引用条被逐条写进
   * 回答正文。用户看到的是复读，而不是信息。
   *
   * 判据（账号、失败种类、接管账号）全是稳定事实，重复即同一个事实；只要它们
   * 不变就不再播报，**换成了另一个账号回答时仍会播报**。
   *
   * 实现方应当有界且能自愈：上游恢复后清掉记录，否则「今天说过」会变成「永远
   * 不再说」。
   */
  hasAnnouncedFailover?: (from: QoderServingAccount, to: QoderServingAccount, kind: UpstreamErrorKind) => boolean
  /**
   * 这个（接管）账号目前是否还处于「当日用量用尽」的排除状态。
   *
   * 池关着（默认）时 `onServingFailure` 不写记录，`failoverAccount` 也不存在，
   * 于是没有账号池的单账号用户每轮都要付一次「换号失败 + 2 秒等待」：shim 无从
   * 知道这件事。由宿主用池状态回答，已知被排除时直接回错（或直接放行，取决于
   * `failoverAccount` 返回什么），不再空跑一次上游。
   */
  isAccountExcluded?: (accountId: string) => boolean
  /**
   * 换号成功后，把「哪个账号、因为什么、换成了谁」交给宿主措辞。
   *
   * 返回 undefined 表示不提示。**只有真正换了号才会被调用**（由
   * `shouldAnnounceFailover` 把关），所以这里不必再判断是否发生了换号。
   *
   * 措辞归宿主：账号名的展示方式、是否点名接管账号、哪些失败值得播报，都是
   * 产品决策，不该硬编码在 shim 里。
   */
  failoverNotice?: (
    from: QoderServingAccount,
    to: QoderServingAccount,
    kind: UpstreamErrorKind,
  ) => string | undefined
  /** 模型显示名 → Qoder 内部 key。未知时原样发送。 */
  modelKeyOf?: (displayName: string) => string | undefined
  /** 该模型是否支持图像输入（用于请求校验，可选）。 */
  supportsImagesOf?: (displayName: string) => boolean
  /**
   * 该模型在设置里保存的思考强度档位（模型显示名 → 档位名）。
   *
   * 「设置里选一次、之后每个请求自动带上」——与 Qoder 客户端同形态
   * （它的事件名就叫 `reasoning-effort-changed`）。返回 undefined 表示没保存
   * 过，请求不带档位字段，由上游用模型自己的默认档。
   */
  reasoningEffortOf?: (displayName: string) => string | undefined
  /**
   * 换号重试前的间隔（默认 {@link FAILOVER_ACCOUNT_GAP_MS}）。测试注入 0。
   * 上游限流按请求体积触发，零间隔连环重试会让每个候选都撞同一堵墙。
   */
  failoverGapMs?: number
  /** 请求体字节上限（默认 64MB，对齐 workbuddy）。测试可注入小值。 */
  requestBodyLimit?: number
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

/** 请求体上限（workbuddy 同值）：长对话体可以很大，但必须有界。 */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/**
 * 换号重试前的间隔（workbuddy 同值）。
 *
 * 上游限流按请求体积触发：零间隔连环重试会让每个候选账号都撞上同一堵墙
 * （4 个账号一秒内全部失败）。批量测试已在账号间等 400ms
 * （`POOL_BATCH_GAP_MS`）；故障转移重试是用户正在等的真实请求，给上游窗口
 * 更多喘息空间。等待是可中断的：客户端断开就立刻停，而不是睡满全程。
 */
const FAILOVER_ACCOUNT_GAP_MS = 2_000

/**
 * 浏览器 Origin（存在时）必须指向回环。非浏览器客户端（插件自己的 fetch、
 * pi-ai）根本不发 Origin，直接放行；DNS-rebinding 页面的 Host 可以伪造，
 * 但 Origin 会暴露它的真实域名。
 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * 写给宿主的 `code` 翻译表。
 *
 * 宿主（`@deepseek-ai/dsh-llm` + llm-pi-ai）从失败文案里读英文短语来决定
 * 「原地重试（默认 5 次指数退避）」还是「跨供应商故障转移」：`RATE_LIMIT` /
 * `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` 在原地重试集里。
 *
 * `rate-limited` 是那个被字面翻译害惨的 kind：上游 429 的冷却常常以小时计
 * （探针从响应体里解析恢复时间），若按 `rate_limit_exceeded` 送达，宿主会把
 * 整个重试预算烧在一个不可能在退避窗口内恢复的端点上。翻成 `quota_exceeded`
 * 是宿主认得的词，也符合上游「此刻不可用」的实际语义；HTTP 状态保持 429
 * 不动（那是上游真实返回的），上游自己的消息仍原文透传给人读。
 */
const KIND_HOST_CODE: Partial<Readonly<Record<UpstreamErrorKind, string>>> = {
  'rate-limited': 'quota_exceeded',
}

/** 首字节前失败写给宿主的 code（宿主按它分类）；流内错误帧仍用原 code。 */
function hostErrorCode(kind: UpstreamErrorKind): string {
  return KIND_HOST_CODE[kind] ?? ERROR_MAP[kind].code
}

/**
 * 净化写给宿主的失败文案里**裸的 401/403 数字**。
 *
 * 这是国际版「API 密钥无效」假警报的根因（用户实拍：对话报密钥无效、同一条
 * 账号在卡片里却只是「用量已达上限」）。
 *
 * 宿主对 pi-ai 失败**不是**按 HTTP 状态分类，而是**对文案跑正则**
 * （app.asar 内 `classifyPiAiError`）：
 *
 * ```js
 * if (/\b(?:401|403)\b/.test(message)) return "AUTH";   // ← 第一道，命中即返回
 * if (isQuotaExceededError(message)) return QUOTA_EXCEEDED;
 * ```
 *
 * 而本插件为了溯源，一直把上游原文（含 `HTTP 403 {"code":"110",…}`）拼进这条
 * 文案。于是**配额耗尽被第一道正则截走判成 AUTH**，宿主用中立文案
 * `message.failure.auth`（「API 密钥无效」）覆盖掉提供方消息 —— 一个明天就
 * 自动恢复的账号被读成凭据坏了。实测 `isQuotaExceededError` 对同一串文本是
 * `true`：分类结果是**顺序**造成的，不是判据不认。
 *
 * 只替换**裸数字**，且只在非 auth 类上做：
 * - `auth` 必须原文照送。上游真的吐 `401 TOKEN_EXPIRE` 时，AUTH 正是正确答案；
 *   而「未配置 PAT」那条中文没有状态码，宿主会显示原文（比换成「API 密钥无效」
 *   更有用），所以这一档**不做**任何装饰。
 * - `429`/`5xx`/`400` 不受影响：`429 → RATE_LIMIT`、`5xx → SERVER`（原地重试）、
 *   `400 → INVALID_REQUEST` 都是期望的分类。**状态码数字必须整词替换**，
 *   否则 `1401`、`4030` 这类业务数字会被改坏（这是溯源信息）。
 *
 * 边界判据是**两条否定环视**（对抗审核 S1 发现 `\b` 不够）：
 * - `(?<![\w.])` 左侧：数字/字母/下划线/句点之前不算独立状态码，于是 `1401`、
 *   `v403`、`a403b`、`code_403` 全部保留；`code=403`、`HTTP 403 {` 仍然命中。
 * - `(?!\d)(?!\.\d)` 右侧：后面跟数字或「小数点+数字」时不算，于是 `4030x` 保留、
 *   **`401.5` 这种小数不再被改写成非法的 `4xx.5`**。句末句号（`HTTP 403.`）不受
 *   影响，因为 `(?!\.\d)` 要求点后紧跟数字。
 *
 * 换成 `4xx` 而不是删掉数字：状态码是给人读的溯源信息，抹掉会让「为什么失败」
 * 变得不可查 —— 这是本项目反复吃过亏的地方。
 */
export function hostMessageText(kind: UpstreamErrorKind, message: string): string {
  if (kind === 'auth') return message
  return message.replace(SANITIZE_BARE_STATUS, '4xx')
}

/**
 * 「裸的 401/403」的判据，只有一处定义 —— 前缀、正文、后缀都由它统一净化。
 *
 * 抽成常量而不是在三处各写一遍：净化一旦漏掉某一段拼接文本，那个数字就会绕过
 * 它自己被送进宿主的正则分类器（前缀漏净化的那次回归就是这么来的）。
 */
const SANITIZE_BARE_STATUS = /(?<![\w.])(?:401|403)(?!\d)(?!\.\d)/gu

/**
 * 净化任意写给宿主的片段（前缀、正文、后缀都走它）。
 *
 * `auth` 档原文照送，所以调用方判断 kind 之后再决定要不要调它。
 */
function sanitizeForHost(text: string): string {
  return text.replace(SANITIZE_BARE_STATUS, '4xx')
}

/**
 * 写给宿主的**完整**失败文案：带 kind 名与状态码前缀，再统一净化。
 *
 * 为什么要带前缀：宿主只按正则猜分类，猜不中就落到 `TRANSPORT`（不可原地重试
 * 的兜底）。留一串没有任何线索的中文（例如只净化的 `上游信封错误: HTTP 4xx
 * {"code":"115"}`）会被猜成 `TRANSPORT`；而带上 `quota-exhausted` 之后，
 * `isQuotaExceededError` 的 `quota ... exceeded` 判据立刻命中。
 *
 * **状态码由本函数负责加、也由本函数负责净化，`note` 后缀同样一起净化**
 * （对抗审核 S3：原先 suffix 拼在净化之后，将来它若带上游信息就会绕过净化）。
 * 前置判断放在 `auth` 那一行：那一档必须原文送达，一个字符都不能改。
 */
export function hostFailureMessage(
  kind: UpstreamErrorKind,
  status: number,
  message: string,
  suffix = '',
): string {
  if (kind === 'auth') return message
  return sanitizeForHost(`qoder upstream ${kind} (http ${status}): ${hostMessageText(kind, message)}${suffix}`)
}

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

/** 可中断的等待：signal 中止时立即结束，而不是睡满全程。 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
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
        const upstream = isQoderUpstreamError(error)
        const status = upstream ? ERROR_MAP[error.kind].status : 500
        const code = upstream ? hostErrorCode(error.kind) : 'internal_error'
        const raw = String((error as Error).message ?? 'internal error')
        // 与下面两条路径用同一个 formatter：这条也会承载上游错误（`handleRequest`
        // 内层未捕获的抛出），只净化而不带 kind 前缀会落到宿主的 TRANSPORT 兜底。
        writeJson(res, status, {
          error: {
            message: upstream ? hostFailureMessage(error.kind, error.status, raw) : raw,
            code,
            type: 'qoder_error',
          },
        })
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
      writeJson(res, 403, { error: { message: 'bad host', code: 'host_not_allowed' } })
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeJson(res, 403, { error: { message: 'Origin must be a loopback origin', code: 'origin_not_allowed' } })
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
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/healthz/')) {
      writeJson(res, 200, { ok: true })
      return
    }
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
    let raw: string
    try {
      raw = await readBody(req, options.requestBodyLimit ?? REQUEST_BODY_LIMIT)
    } catch (error) {
      if ((error as Error).message === 'request body too large') {
        // 文案与宿主 INVALID_REQUEST 分类器的既有分支对齐（"request body too
        // large"），413 在原地重试集之外——同一个超大体换谁重发都一样被拒。
        writeJson(res, 413, { error: { message: 'request body too large', code: 'invalid_request_error' } })
        return
      }
      throw error
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      writeJson(res, 400, { error: { message: 'invalid JSON body', code: 'invalid_request_error' } })
      return
    }
    const model = typeof body.model === 'string' ? body.model : ''
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
    const stream = body.stream !== false

    if (messages.length === 0) {
      writeJson(res, 400, { error: { message: 'messages is required', code: 'invalid_request_error' } })
      return
    }

    const key = options.modelKeyOf ? options.modelKeyOf(model) ?? model : model
    const supportsImages = options.supportsImagesOf ? options.supportsImagesOf(model) : false
    // 设置里为该模型保存的思考强度。选中档位本身就是「开启思考并指定强度」，
    // 所以它与布尔 is_reasoning 是同一件事的两个粒度——档位存在时按开启处理。
    const savedEffort = options.reasoningEffortOf ? options.reasoningEffortOf(model) : undefined
    const hasImages = messages.some(m => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some(p => p?.type === 'image_url'))
    if (hasImages && !supportsImages) {
      // 模型名是**请求体**带来的动态文本，一样要过净化：宿主对这条 400 也用同一个
      // 正则分类器，而它的第一道判据是裸 401/403。若目录里存在 `gpt-401` 这类名字，
      // 原文送达就会把「不支持图片」读成「API 密钥无效」（对抗审核 §6.2 指出）。
      writeJson(res, 400, {
        error: {
          message: hostMessageText('invalid-request', `模型 ${model} 不支持图像输入`),
          code: 'invalid_request_error',
        },
      })
      return
    }

    if (!stream) {
      writeJson(res, 400, { error: { message: 'only streaming is supported', code: 'invalid_request_error' } })
      return
    }

    // `tool_choice` 的处理与 workbuddy 的 prepareChatBody 同义：cosy 模板没有
    // tool_choice 字段，其他形态无法透传；但 `"none"` 必须落实为「不带 tools」，
    // 否则宿主明确禁止工具时上游仍看得到它们。
    const toolChoice = body.tool_choice
    const tools = toolChoice === 'none' || !Array.isArray(body.tools) ? undefined : body.tools

    // reasoning 档：DSH 的 thinking 选择落在 `reasoning_effort` 上。Qoder 的
    // 线是布尔 `is_reasoning`：`off` → false；任何正档 → true；否则回落到
    // stream_options.include_reasoning。设置里为这个模型保存过档位时，档位
    // 本身即表示「开启并指定强度」，因此以它为准（除非请求明确说 off）。
    const requestedOff = body.reasoning_effort === 'off'
    const isReasoning = savedEffort !== undefined && !requestedOff ? true : isReasoningRequested(body)
    const reasoningEffort = requestedOff ? undefined : savedEffort

    // 客户端断开要中止上游（否则上游继续烧额度），且断开前的失败不该记成账号
    // 的测量。监听**响应**的 close 而非请求的：请求流被读完后 Node 会自行
    // destroy 请求对象（`req.destroyed` 在正常读完时也会变 true），只有响应
    // 的 close 才代表 socket 真的拆了。
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    if (res.destroyed) controller.abort()

    // 用账号池解析本次服务的账号（可多账号 / 池接管 / 默认回落）。
    let serving: QoderServingAccount | undefined
    try {
      serving = await (options.resolveServing ? options.resolveServing() : Promise.resolve(undefined))
      if (serving === undefined) {
        serving = { accountId: 'default', accountName: '', pat: resolveFallbackCredential() }
      }
    } catch (error) {
      const upstream = isQoderUpstreamError(error)
      const mapped = upstream ? ERROR_MAP[error.kind] : { status: 500, code: 'upstream_error' }
      const raw = String((error as Error).message ?? 'internal error')
      // 第三处写给宿主的失败路径（凭据解析阶段）。与 handleChat 用同一个
      // formatter：留一串没有 kind 线索的中文会被宿主猜成 TRANSPORT。
      writeJson(res, mapped.status, {
        error: {
          message: upstream ? hostFailureMessage(error.kind, error.status, raw) : raw,
          code: mapped.code,
          type: 'qoder_error',
        },
      })
      return
    }

    const requestId = `chatcmpl-${randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const tried: string[] = []
    const gapMs = options.failoverGapMs ?? FAILOVER_ACCOUNT_GAP_MS
    // 换号成功后置为提示文案，在写出首帧时一次性消费（置回 undefined）。
    //
    // ⚠️ 采集时机在**换号之后**，不是每轮开头：首轮还没失败，开头采集拿不到
    // 「为什么换」；换号发生在上一个 catch 里，那里的 error.kind 才是原因。
    let notice: string | undefined
    // 整条响应是否已经吐过字节（含提示帧）。提示只允许写在这里出现的第一次——
    // 之后写的任何内容都排在上一段已提交正文后面，会变成夹在回答中间的复读。
    let wroteBytes = false

    // 本轮尝试：写 SSE 头 + 转发流。返回前若抛错且尚未写出任何字节，则上游
    // `wroteAny` 保持 false，可进入换号重试。
    for (;;) {
      let wroteAny = false
      let hasToolCalls = false
      let inputTokens = 0
      let outputTokens = 0
      /**
       * 缓存命中数（issue #4）。与上面两个**计数方式不同**：
       *
       * `inputTokens` / `outputTokens` 是 `> 0` 才覆盖的（流里多帧会重复报，
       * 只认非零值）；缓存命中数则允许本身就是 0（上游明确报「缓存一个都没
       * 命中」是很正常的一件事）。所以用 `undefined` 当「还没拿到」，一旦上游
       * 报过就记下来（含 0），不再被后面的帧覆盖成别的数。
       */
      let cachedTokens: number | undefined
      try {
        await upstream.chatStream(serving.pat, key, messages, {
          ...(tools === undefined ? {} : { tools }),
          isReasoning,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          isVl: supportsImages,
          signal: controller.signal,
          onDelta: (delta) => {
            if (!wroteAny) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                // 反向代理（若有）不得缓冲 SSE。
                'X-Accel-Buffering': 'no',
              })
              // 池接管时必须让用户看见：通知文本作为首个**内容**帧写出
              // （choices[0].delta.content）。空 choices 的自定义帧会被 pi-ai
              // 的 chunk 循环直接跳过（`if (!choice) continue`），用户将完全
              // 不知道换号发生过。
              //
              // 闸门是「**整条响应**的第一个字节」：一次换号就是「第一次尝试
              // 失败 → 第二次尝试成功」，提示恰恰要在第二个尝试的首个 delta 上
              // 才有位置可写。而 `wroteAny` 每轮尝试都复位，用它当闸门会让
              // 「本轮先失败、换号后成功」把提示写在前一段已提交正文的后面。
              if (notice !== undefined && !wroteBytes) {
                writeNoticeChunk(res, requestId, created, model, notice)
              }
              notice = undefined
              wroteAny = true
              wroteBytes = true
            }
            if (delta.inputTokens > 0) inputTokens = delta.inputTokens
            if (delta.outputTokens > 0) outputTokens = delta.outputTokens
            // `!== undefined`（而不是 `> 0`）：上游报「0 个命中」是有效答案，
            // 而「这一帧没报」才是 undefined。两者在宿主那里含义不同。
            if (delta.cachedTokens !== undefined) cachedTokens = delta.cachedTokens
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
          done.usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            // 缓存命中数透传给宿主（issue #4）。宿主 `parseChunkUsage` 读的正是
            // `prompt_tokens_details.cached_tokens`，缺了它就按 0 显示 ——
            // 于是 GUI 的「缓存命中」恒为 0%，而那个 0% 是不可信的读数。
            //
            // **不要把 `cachedTokens` 加进 `prompt_tokens` / `total_tokens`**：
            // 实测上游 `cached_tokens` 是 `prompt_tokens` 的子集（2032 / 2038），
            // 相加会把缓存前缀算两遍。宿主自己会做减法，两边各按「子集」理解。
            ...cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } },
          }
        }
        res.write(`data: ${JSON.stringify(done)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      } catch (error) {
        if (wroteAny) {
          // 已提交字节：错误进流（不换号、不重放——回放会让客户端看到两段
          // 拼接的回答）。
          writeErrorChunk(res, requestId, created, model, error)
          return
        }
        if (isQoderUpstreamError(error) && isFailoverEligible(error.kind) && !controller.signal.aborted) {
          // 每一次失败尝试都记测量，包括没有后继可试的最后一次——那正是下一个
          // 请求最该避开的账号。客户端已断开时不记：断开不是账号的错。
          options.onServingFailure?.(serving.accountId, error.kind, error.message, { status: error.status, code: error.code })
          tried.push(serving.accountId)
          let next: QoderServingAccount | undefined
          try {
            next = options.failoverAccount ? await options.failoverAccount(tried) : undefined
          } catch {
            next = undefined
          }
          // 宿主已知「这个号今天已经用尽」时，别再拿同一个请求去撞一次墙。
          //
          // 这条守卫只在**有过候选**（`next !== undefined`）时才有意义：那说明
          // 宿主愿意换号，只是候选恰好又被池标记为排除。没有候选时什么都不改变，
          // 失败照常按原路径回给宿主。等待放在守卫**之后**——过去这里先睡 2 秒
          // 再重试，一个用尽的日子 = 每轮白等 2 秒 + 一次必然失败的上游调用。
          if (next !== undefined && options.isAccountExcluded?.(next.accountId) === true) {
            logger(`shim: failover candidate ${next.accountId} is already excluded; not retrying it`)
            next = undefined
          }
          // 策略层被要求跳过已试账号，但 shim 不依赖这一点：候选若重复，同一
          // 请求体会对同一账号无限重发、空烧额度。`tried` 是唯一刹车，shim 侧
          // 也查一遍。
          if (next !== undefined && !tried.includes(next.accountId)) {
            logger(`shim failover: ${serving.accountId} → ${next.accountId} (${error.kind})`)
            // 用户选中的账号失败了，这事必须让用户看见——否则他看到一段正常
            // 回答，既不知道换过号，也不知道自己选的账号已经出问题。
            // 文案正文由配置项提供（宿主据此决定是否提示、怎么措辞），shim 只
            // 负责「何时放进去」：首帧之前。
            const from = serving
            const to = next
            // 播报**紧邻这次换号的那次失败**，且后一次覆盖前一次。
            //
            // A 网络故障 → B 被限流 → C 成功时，要说的是「B 被限流」：B 才是
            // 差一点接管这次回答的账号，而「A 网络中断」是不完整且更没用的一半。
            // 首帧只会写出一条提示，所以多次换号最终只留最后一次——这正好是
            // 用户最需要知道的那一次：为什么最后不是由你选的账号回答。
            if (
              shouldAnnounceFailover({
                switched: true,
                fromAccountId: from.accountId,
                toAccountId: to.accountId,
                kind: error.kind,
              })
              // 同一个事实只说一次：一轮回合里每轮调用的失败原因与接管账号
              // 都一样时，用户不需要读十几遍。（换成了另一个账号回答，仍然会
              // 说——判据包含接管账号。）
              && options.hasAnnouncedFailover?.(from, to, error.kind) !== true
            ) {
              notice = options.failoverNotice?.(from, to, error.kind)
            }
            serving = next
            // 零间隔连环重试会让每个候选都撞上同一个按体积计费的限流墙；
            // 等待可中断，客户端断开就不再睡。
            await sleepAbortable(gapMs, controller.signal)
            if (controller.signal.aborted) return
            continue
          }
        }
        if (isQoderUpstreamError(error)) {
          // 没有下一个候选（或失败本就不值得换号）：首字节未写，回**非 200
          // JSON 错误**。pi-ai 对 200 流里的 error 字段完全失明（塌缩成
          // "Provider finish_reason: error"），只有非 2xx 响应体能把真实的
          // 状态、宿主可分类的 code 与上游原文送进宿主的分类器。尝试过多个
          // 账号时在消息里注明数量——否则池子换过号仍失败读起来就像用户选定
          // 的那一个账号单独失败。
          const note = tried.length > 1 ? ` (after trying ${tried.length} accounts)` : ''
          const mapped = ERROR_MAP[error.kind]
          writeJson(res, mapped.status, {
            error: {
              // 文案交给 `hostFailureMessage` 统一拼齐并净化：状态码由它加、也由
              // 它净化，`note` 也从它过一遍（S3：拼在净化之后就会绕过）。
              message: hostFailureMessage(error.kind, error.status, error.message.slice(0, 400), note),
              code: hostErrorCode(error.kind),
              type: 'qoder_error',
            },
          })
          return
        }
        // 非上游错误（组装问题等）：交外层统一 500。
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

  /** 池接管的通知帧：一段以引用块前缀开头的**内容**帧（pi-ai 可见）。 */
  function writeNoticeChunk(
    res: import('node:http').ServerResponse,
    id: string,
    created: number,
    model: string,
    notice: string,
  ): void {
    const chunk = makeChunk(id, created, model)
    chunk.choices[0]!.delta.content = `\n\n> [dsh-connect-qoder] ${notice}\n\n`
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
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
    const upstream = isQoderUpstreamError(error)
    const code = upstream ? ERROR_MAP[error.kind].code : 'upstream_error'
    const raw = String((error as Error).message ?? 'internal error')
    // 流内帧同样要净化：宿主对 pi-ai 的 `case "error"` 分支拿
    // `message.errorMessage` 跑同一个 `classifyPiAiError`，所以这条路径漏了
    // 净化，配额失败一样会被读成 AUTH —— 而且此时 200 已提交，用户已经在看
    // 一个半截回复，错误分类错得更难排查。
    errChunk.error = {
      message: upstream ? hostFailureMessage(error.kind, error.status, raw) : raw,
      code,
      type: 'qoder_error',
    }
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

  function readBody(req: import('node:http').IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      req.on('data', (chunk: Buffer) => {
        if (over) return
        size += chunk.length
        if (size > limit) {
          over = true
          reject(new Error('request body too large'))
          // 排干剩余上传而不是 destroy：destroy 会在 413 写回前拆掉 socket，
          // 客户端只会看到 "other side closed" 而不是可读的状态码。
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')) })
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