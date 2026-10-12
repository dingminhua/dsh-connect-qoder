/**
 * Qoder 上游 HTTP 客户端：cosy 签名请求、jobToken 交换、聊天 SSE、
 * 模型目录与用量查询。
 *
 * 端点映射（CN 与 Global 双区域，来自 Go 版 qoder2api 的 account/region.go
 * 与官方 SDK 的用量说明）：
 *
 * ```text
 * CN     chat: gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
 *        models: gateway.qoder.com.cn/algo/api/v2/model/list
 *        jobToken: gateway.qoder.com.cn/algo/api/v3/user/jobToken
 *        openapi: openapi.qoder.com.cn
 * Global chat: api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *        models: api2.qoder.sh/algo/api/v2/model/list
 *        jobToken: center.qoder.sh/algo/api/v3/user/jobToken
 *        openapi: openapi.qoder.sh
 * ```
 *
 * @module dsh-connect-qoder/upstream
 */

import {
  buildPayloadB64,
  composeBearer,
  cosyEncode,
  currentRfc1123Date,
  deriveFingerprint,
  newCosySession,
  pathSigFrom,
  signLegacy,
  signRequest,
  type CosyFingerprint,
  type CosySessionContext,
} from './cosy.ts'
import { createChatBodyTemplate, buildQoderMessages, extractLatestUserPrompt, deepClone, applyModelKey, type QoderChatTemplate } from './messages.ts'
import { readDeviceRisk } from './device-risk.ts'

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

export type QoderRegion = 'cn' | 'global'

export interface QoderRegionConfig {
  /** 网关主机（chat / models / jobToken 共用）。 */
  gateway: string
  /** OpenAPI 主机（用量/计划/签到等 sash 接口）。 */
  openapi: string
  /** SSE 聊天端点。 */
  chatPath: string
  /** 模型目录端点。 */
  modelsPath: string
  /** jobToken 交换端点。 */
  jobTokenPath: string
  /** 每日签到的活动列表端点（sash 的 v1 campaigns）。 */
  campaignsPath: string
  /**
   * 该区域的签到是否需要**设备风控头**（`Cosy-MachineToken/Code/Type`）。
   *
   * 国际版为 true：它的签到活动只下发给带这些头的请求，缺了拿不到活动列表
   * （实测端点存在，返回 401 而不是 404）。国内版为 false —— 实测不需要，
   * 多发反而在另一侧成为噪音。三件套由本机 UMID 组件生成，见 device-risk.ts。
   */
  requiresDeviceRisk: boolean
}

/** 一条签到活动（`GET /sash/api/v1/me/campaigns` 的条目，只取用得到的字段）。 */
export interface QoderCampaign {
  campaignId: string
  /** `CLAIM_BENEFIT` = 可领权益；`VIEW_DETAILS` = 纯展示，跳过。 */
  actionType: string
  /** `CLAIMABLE` = 今天可领；`CLAIMED` = 已领。 */
  claimStatus: string
  /** 奖励数额（Credits），来自 `benefit.amount`。 */
  amount?: number
  /** 有效期天数，来自 `benefit.validity.days`。 */
  validityDays?: number
}

/** 一次签到尝试的结果。 */
export type QoderCheckinOutcome =
  | { status: 'claimed', amount?: number, validityDays?: number }
  | { status: 'already-claimed' }
  | { status: 'unavailable', message: string }

const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
/**
 * 每日签到走 `sash` 的**活动**接口。路径里没有「签到」二字（叫 campaigns），
 * 所以照着 checkin / signin / reward 猜永远猜不到——实测猜了 13 个全 404。
 * 注意是 **v1**（用量那套是 v2）。
 */
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
const CAMPAIGNS_QUERY = '?forceRefresh=true'
/** sash 接口要求的客户端标识（参考实现如此，缺了会被拒）。 */
const SASH_CLIENT_TYPE = '10'
const SASH_USER_AGENT = 'Qoder'
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1'
const JOB_TOKEN_PATH = '/algo/api/v3/user/jobToken?Encode=1'

export const QODER_REGIONS: Readonly<Record<QoderRegion, QoderRegionConfig>> = {
  cn: {
    gateway: 'https://gateway.qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
    chatPath: CHAT_PATH,
    modelsPath: MODELS_PATH,
    jobTokenPath: JOB_TOKEN_PATH,
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: false,
  },
  global: {
    gateway: 'https://api1.qoder.sh',
    openapi: 'https://openapi.qoder.sh',
    chatPath: CHAT_PATH,
    modelsPath: '/algo/api/v2/model/list?Encode=1',
    jobTokenPath: '/algo/api/v3/user/jobToken?Encode=1',
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: true,
  },
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 上游错误分类，供 shim 映射为 DSH 可判定的 code。 */
export type UpstreamErrorKind =
  | 'network'           // 传输层（TLS/EOF/reset/超时）
  | 'auth'              // 401/403：凭证被拒 / 会话过期
  | 'rate-limited'      // 429：限流
  | 'invalid-request'   // 400：请求不合法（重试无意义）
  | 'content-policy'    // 内容审核拒绝
  | 'quota-exhausted'   // 业务 code 表示额度耗尽
  | 'transient'         // 418/5xx/provider_error：瞬时
  | 'unknown'

export class QoderUpstreamError extends Error {
  readonly kind: UpstreamErrorKind
  readonly status: number
  readonly code?: string | undefined
  constructor(kind: UpstreamErrorKind, message: string, status = 0, code?: string) {
    super(message)
    this.name = 'QoderUpstreamError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export function isQoderUpstreamError(error: unknown): error is QoderUpstreamError {
  return error instanceof QoderUpstreamError
}

/** jobToken 交换结果。 */
export interface QoderJobToken {
  id: string
  name: string
  expireTime: number
  securityOauthToken: string
  refreshToken: string
  userType: string
}

/** 模型目录条目（服务端 snake_case 原样透传 + 常用字段解析）。 */
export interface QoderUpstreamModel {
  key: string
  display_name: string
  enable: boolean
  is_default: boolean
  is_vl: boolean
  is_reasoning: boolean
  is_free: boolean
  price_factor: number | undefined
  max_input_tokens: number | undefined
  max_output_tokens: number | undefined
  thinking_config: Record<string, unknown> | undefined
  context_config: Record<string, { token_count: number; is_default?: boolean }> | undefined
  /** 其余字段原样保留。 */
  raw: Record<string, unknown>
}

/** 用量信息（sash/api/v2/me/usage 的 qoderUsage 形状，官方 SDK UsageInfo 核对）。 */
export interface QoderUsage {
  userType?: string | undefined
  expiresAt?: number | undefined
  upgradeUrl?: string | undefined
  userQuota?: { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined } | undefined
  addOnQuota?: { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined; detailUrl?: string | undefined } | undefined
  orgResourcePackage?: { used?: number | undefined; cap?: number | undefined; remaining?: number | undefined; percentage?: number | undefined; available?: boolean | undefined } | undefined
  isQuotaExceeded?: boolean
}

/** 聊天流增量。 */
export interface QoderChatDelta {
  role: string
  content: string
  reasoningContent: string
  toolCalls: unknown[] | undefined
  inputTokens: number
  outputTokens: number
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface QoderUpstreamOptions {
  logger?: (message: string) => void
  /** 本机指纹盐（可选，混入派生种子）。 */
  installSalt?: string
  fetch?: typeof fetch
}

/** cosy 会话 + 指纹的持有者（每次 jobToken 交换后重建）。 */
export interface QoderSessionHolder {
  session: CosySessionContext
  fingerprint: CosyFingerprint
  jobToken: QoderJobToken
  /** 会话过期毫秒时间戳；0 表示未知。 */
  expireAtMs: number
}

const DEFAULT_HEADERS: Record<string, string> = {
  'cosy-data-policy': 'agree',
  'content-type': 'application/json',
  'cosy-clienttype': '5',
  'login-version': 'v2',
  'user-agent': 'Go-http-client/2.0',
  'cosy-scene': 'assistant',
  'cosy-business-product': 'ide',
  'cosy-business-type': 'agent',
}

/**
 * Qoder 上游客户端。每个区域一个实例；会话按需惰性交换与续期。
 */
export class QoderUpstreamClient {
  readonly region: QoderRegionConfig
  /** 本实例所属区域（`region` 是它的配置表；这里保留区域名本身）。 */
  private readonly regionKey: QoderRegion
  private readonly logger: (message: string) => void
  private readonly installSalt: string | undefined
  private readonly fetchImpl: typeof fetch
  /**
   * 按凭证键控的会话缓存。
   *
   * 一个区域实例会同时服务多个账号（账号池批量探测、按账号查额度），
   * 不同 PAT 的 cosy 会话互不相通，所以会话必须按凭证分开缓存——用单个
   * 字段会互相覆盖（上一个账号的会话被下一个冲掉）。键是 PAT 本身：
   * 会话不可再交换，必须绑定到它交换来的那份凭证。
   */
  private readonly holders = new Map<string, QoderSessionHolder>()
  /** 最近使用的主会话（默认解析路径复用它）。 */
  private currentKey: string | undefined

  constructor(region: QoderRegion, options: QoderUpstreamOptions = {}) {
    this.region = QODER_REGIONS[region]!
    this.regionKey = region
    this.logger = options.logger ?? (() => {})
    this.installSalt = options.installSalt
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private log(message: string): void {
    this.logger(`dsh-connect-qoder: ${message}`)
  }

  /** 某一凭证的会话是否已过期（或即将过期）。 */
  isSessionValid(credential: string, nowMs = Date.now()): boolean {
    const holder = this.holders.get(credential)
    if (holder === undefined) return false
    const remaining = holder.expireAtMs - nowMs
    // 提前 5 分钟视为过期，给续期留时间。
    return remaining > 5 * 60_000
  }

  /** 最近使用的凭证，沿用直觉意义上「当前账号」的引用。 */
  currentCredential(): string | undefined {
    return this.holders.has(this.currentKey ?? '') ? this.currentKey : undefined
  }

  /**
   * 用 PAT（`pt-...` 或任意凭证）或 refresh token（`drt-...`）交换 jobToken。
   * 设备指纹以凭证为种子派生（无 uid 可用前），保证稳定。
   */
  async exchangeJobToken(credential: string): Promise<QoderJobToken> {
    const fingerprint = deriveFingerprint('', credential, this.installSalt)
    const body = jobTokenBody(credential)
    const date = currentRfc1123Date()
    const sig = signLegacy(date)

    const headers: Record<string, string> = {
      'cosy-machinetoken': fingerprint.machineToken,
      'cosy-machinetype': fingerprint.machineType,
      'login-version': 'v2',
      appcode: 'cosy',
      accept: 'application/json',
      'accept-encoding': 'identity',
      'cosy-version': '0.1.43',
      'cosy-clienttype': '5',
      date,
      signature: sig,
      'content-type': 'application/json',
      'cosy-machineid': fingerprint.machineId,
      'user-agent': 'Go-http-client/2.0',
    }

    const url = `${this.region.gateway}${this.region.jobTokenPath}`
    const resp = await this.fetchImpl(url, { method: 'POST', headers, body })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyHttpStatus(resp.status, text), `jobToken 交换失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status)
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `jobToken 响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
    const jobToken: QoderJobToken = {
      id: String(data.id ?? ''),
      name: String(data.name ?? ''),
      expireTime: Number(data.expireTime ?? 0),
      securityOauthToken: String(data.securityOauthToken ?? ''),
      refreshToken: String(data.refreshToken ?? ''),
      userType: String(data.userType ?? 'personal_standard'),
    }
    if (!jobToken.id && !jobToken.securityOauthToken) {
      throw new QoderUpstreamError('auth', `jobToken 交换响应缺少身份字段: ${truncate(text, 200)}`, resp.status)
    }
    const identity = { name: jobToken.name, aid: jobToken.id, uid: jobToken.id, yx_uid: '', organization_id: '', organization_name: '', user_type: jobToken.userType, security_oauth_token: jobToken.securityOauthToken, refresh_token: jobToken.refreshToken }
    const session = newCosySession(identity, fingerprint.machineId, fingerprint.machineToken, fingerprint.machineType)
    const holder: QoderSessionHolder = {
      session,
      fingerprint,
      jobToken,
      expireAtMs: jobToken.expireTime > 0 ? jobToken.expireTime : 0,
    }
    this.holders.set(credential, holder)
    this.currentKey = credential
    this.log(`jobToken 已交换: ${jobToken.name} (${jobToken.id})`)
    return jobToken
  }

  /**
   * 确保存在未过期会话。credential 提供 PAT 或 refreshToken（`drt-` 前缀）。
   * 已有有效会话时直接复用（不重复交换）。
   */
  async ensureSession(credential: string): Promise<QoderSessionHolder> {
    if (this.isSessionValid(credential)) {
      return this.holders.get(credential)!
    }
    await this.exchangeJobToken(credential)
    return this.holders.get(credential)!
  }

  /**
   * 拉取模型目录。响应形状（服务端 snake_case）：
   * `{"chat":[{key, display_name, enable, is_vl, is_default, ...}], ...}`
   */
  async fetchModels(credential: string, signal?: AbortSignal): Promise<QoderUpstreamModel[]> {
    const holder = await this.ensureSession(credential)
    const url = `${this.region.gateway}${this.region.modelsPath}`
    const data = await this.bearerGet(holder, url, signal)
    const chat = Array.isArray(data.chat) ? data.chat : []
    return chat
      .map((entry): QoderUpstreamModel | undefined => {
        if (!entry || typeof entry !== 'object') return undefined
        const raw = entry as Record<string, unknown>
        const key = typeof raw.key === 'string' ? raw.key : ''
        const displayName = typeof raw.display_name === 'string' ? raw.display_name : ''
        if (!key || !displayName) return undefined
        return {
          key,
          display_name: displayName,
          enable: raw.enable !== false,
          is_default: raw.is_default === true,
          is_vl: raw.is_vl === true,
          is_reasoning: raw.is_reasoning === true,
          is_free: raw.is_free === true,
          price_factor: typeof raw.price_factor === 'number' ? raw.price_factor : undefined,
          max_input_tokens: typeof raw.max_input_tokens === 'number' ? raw.max_input_tokens : undefined,
          max_output_tokens: typeof raw.max_output_tokens === 'number' ? raw.max_output_tokens : undefined,
          thinking_config: typeof raw.thinking_config === 'object' ? raw.thinking_config as Record<string, unknown> : undefined,
          context_config: typeof raw.context_config === 'object'
            ? raw.context_config as Record<string, { token_count: number; is_default?: boolean }>
            : undefined,
          raw,
        }
      })
      .filter((m): m is QoderUpstreamModel => m !== undefined)
  }

  /**
   * 聊天 SSE 流。onDelta 逐行回调；返回 null 表示正常结束。
   * 令牌：`credential` 只在会话续期时使用。
   */
  async chatStream(
    credential: string,
    modelKey: string,
    messages: Array<Record<string, unknown>>,
    options: {
      tools?: unknown[]
      isReasoning?: boolean
      /**
       * 思考强度档位名（`low` / `medium` / `xhigh` …），来自插件设置里为该
       * 模型保存的值。
       *
       * 实测自 Qoder 官方客户端（app.asar.unpacked 的 SDK）：档位**不走**
       * `model_config`，而是请求体顶层的 `reasoningEffort` 加
       * `parameters.reasoning_effort`——官方客户端两者同时写
       * （`{..., reasoningEffort:"none", parameters:{...A.parameters,
       *   reasoning_effort:"none"}}`），只写一个有可能被网关忽略。
       * 缺席时不下发任何档位字段，由上游用模型自己的默认档。
       */
      reasoningEffort?: string
      isVl?: boolean
      signal?: AbortSignal
      onDelta: (delta: QoderChatDelta) => void
      userType?: string
    },
  ): Promise<void> {
    const holder = await this.ensureSession(credential)
    const template = deepClone(createChatBodyTemplate())
    applyModelKey(template, modelKey, options.userType ?? holder.jobToken.userType, options.isVl ?? false)
    if (options.isReasoning) {
      template.model_config.is_reasoning = true
      template.chat_context.extra.modelConfig.is_reasoning = true
    }
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== '') {
      // 两个位置都写：官方客户端如此，照抄以避免网关只认其中一个。
      template.reasoningEffort = options.reasoningEffort
      const params = (template.parameters ?? {}) as Record<string, unknown>
      template.parameters = { ...params, reasoning_effort: options.reasoningEffort }
    }
    const prompt = extractLatestUserPrompt(messages)
    const built = buildQoderMessages(messages, prompt, Array.isArray(options.tools) && options.tools.length > 0)
    template.messages = built as unknown as unknown[]
    if (options.tools !== undefined) {
      template.tools = options.tools
    }
    template.request_id = randomId()
    template.chat_record_id = template.request_id
    template.request_set_id = randomId()
    template.session_id = randomId()
    template.business.id = randomId()
    template.business.name = prompt.slice(0, 30) || 'hi'
    template.business.begin_at = Date.now()

    const body = JSON.stringify(template)
    const url = `${this.region.gateway}${this.region.chatPath}`
    const pathSig = pathSigFrom(url)

    const encoded = cosyEncode(new TextEncoder().encode(body))
    const date = String(Math.floor(Date.now() / 1000))
    const payloadB64 = buildPayloadB64(holder.session.info)
    const sig = signRequest(payloadB64, holder.session.cosyKey, date, encoded, pathSig)
    const bearer = composeBearer(payloadB64, sig)

    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'cosy-machinetype': holder.session.machineType,
      'cosy-date': date,
      'cosy-user': holder.session.identity.uid,
      'cosy-key': holder.session.cosyKey,
      'cache-control': 'no-cache',
      accept: 'text/event-stream',
      authorization: bearer,
      'cosy-version': '0.1.43',
      'cosy-machineid': holder.session.machineId,
      'cosy-machinetoken': holder.session.machineToken,
      'x-model-key': modelKey,
      'x-model-source': 'system',
    }

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: encoded,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (resp.status !== 200) {
      const errText = await resp.text()
      throw new QoderUpstreamError(classifyHttpStatus(resp.status, errText), `聊天请求失败: HTTP ${resp.status} ${truncate(errText, 300)}`, resp.status)
    }
    if (!resp.body) {
      throw new QoderUpstreamError('transient', '聊天响应没有 body')
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          const payload = trimmed.slice('data:'.length).trim()
          if (payload === '[DONE]') continue
          const delta = parseStreamDelta(payload)
          if (delta !== undefined) options.onDelta(delta)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 查询用量（只读）。`GET {openapi}/sash/api/v2/me/usage`。
   *
   * **认证用的是 jobToken 里的 `securityOauthToken`（`jt-…`），不是 PAT，
   * 也不是 COSY 签名 bearer。** 三者实测（2026-10，CN）：
   *
   * | 凭据 | 结果 |
   * | --- | --- |
   * | 裸 PAT `pt-…` | 401 `TOKEN_EXPIRE / token is not active` |
   * | COSY 签名 bearer（chat/models 用的那套） | 401 `TOKEN_INVALID / invalid token` |
   * | `jt-…`（jobToken 交换产出） | **200，返回完整 qoderUsage** |
   *
   * 前两种之所以失败，是因为 `sash` 是**浏览器会话面**的接口：它既不收 PAT，
   * 也不认 cosy 协议头（缺 Authorization 时它回
   * `UNAUTHORIZED / missing cookie header`，可见它本来是给 cookie 会话用的）。
   * 这解释了「令牌明明是好的、聊天也正常，积分却永远拿不到」——以前用错凭据。
   */
  async fetchUsage(credential: string, signal?: AbortSignal): Promise<QoderUsage | undefined> {
    const url = `${this.region.openapi}/sash/api/v2/me/usage`
    try {
      const holder = await this.ensureSession(credential)
      const data = await this.jobTokenGet(holder, url, signal)
      return parseUsage(data)
    } catch (error) {
      // 凭据被上游拒（401/403，实测 Qoder 回 `TOKEN_EXPIRE / token is not
      // active`）必须**抛出去**，不能和「网络抖了一下」一起降级成 undefined：
      //  - 卡片需要它来说「积分为什么是空的」，否则用户只看到一片空白；
      //  - credential-recovery 的 `try { await fetchUsage } catch { usable =
      //    false }` 靠这个异常判定凭据是否可用——原实现静默返回 undefined，
      //    await 正常结束，于是**过期凭据被判为可用**。
      // 其他错误（超时、5xx、网关抖动）仍旧返回 undefined：那是「这次没读到」，
      // 不是「凭据坏了」，报成凭据被拒会把用户引去换一个没问题的 PAT。
      if (error instanceof QoderUpstreamError && (error.status === 401 || error.status === 403)) {
        // 兜底：万一某个区域只认 PAT 直连，再试一次。两条都失败才报凭据被拒。
        const direct = await this.fetchUsageDirect(url, credential, signal)
        if (direct !== undefined) return direct
        throw error
      }
      return undefined
    }
  }

  /**
   * `sash` 系列接口的取数：带 `Authorization: Bearer <jobToken.securityOauthToken>`。
   *
   * 与 {@link bearerGet} 的区别只有一个——**认证凭据不同**：`sash` 要的是
   * jobToken 交换产出的 `jt-…`，不是 COSY 签名 bearer（实测后者回
   * `TOKEN_INVALID / invalid token`），也不是裸 PAT（回 `TOKEN_EXPIRE`）。
   * 也正因为如此，这里**不**带那套 cosy-* 头：它们属于 cosy 协议面。
   */
  private async jobTokenGet(
    holder: QoderSessionHolder,
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const oauthToken = holder.jobToken.securityOauthToken
    if (oauthToken === '') {
      throw new QoderUpstreamError('auth', 'jobToken 未返回 securityOauthToken，无法查询用量', 401)
    }
    const resp = await this.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${oauthToken}`,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyHttpStatus(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status)
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }

  /**
   * 拉当日的签到活动列表。
   *
   * 协议来自社区参考实现（L0NE-6/Qoder-Daily），已在本机 CN 账号实测通过：
   * `GET {openapi}/sash/api/v1/me/campaigns?forceRefresh=true`，认证用与用量
   * 查询同一套 `jt-` 令牌（`jobToken.securityOauthToken`）。
   *
   * 注意路径里**没有**「签到」二字——它叫 campaigns（活动/权益）。这也是我早期
   * 把 `checkinSupported` 写死成 false 的原因：照着 checkin / signin / reward
   * 猜路径一律 404（实测猜了 13 个），于是误判成「Qoder 没有签到」。
   */
  async fetchCampaigns(credential: string, signal?: AbortSignal): Promise<QoderCampaign[]> {
    const holder = await this.ensureSession(credential)
    const url = `${this.region.openapi}${this.region.campaignsPath}${CAMPAIGNS_QUERY}`
    const data = await this.sashRequest('GET', holder, url, undefined, signal)
    const rows = Array.isArray(data.campaigns)
      ? data.campaigns
      : Array.isArray((data.data as Record<string, unknown> | undefined)?.campaigns)
        ? ((data.data as Record<string, unknown>).campaigns as unknown[])
        : []
    return rows
      .map((entry): QoderCampaign | undefined => {
        if (!entry || typeof entry !== 'object') return undefined
        const raw = entry as Record<string, unknown>
        const campaignId = typeof raw.campaignId === 'string' ? raw.campaignId : ''
        if (campaignId === '') return undefined
        const benefit = (typeof raw.benefit === 'object' && raw.benefit !== null ? raw.benefit : {}) as Record<string, unknown>
        const validity = (typeof benefit.validity === 'object' && benefit.validity !== null ? benefit.validity : {}) as Record<string, unknown>
        return {
          campaignId,
          actionType: typeof raw.actionType === 'string' ? raw.actionType : '',
          claimStatus: typeof raw.claimStatus === 'string' ? raw.claimStatus : '',
          ...(typeof benefit.amount === 'number' ? { amount: benefit.amount } : {}),
          ...(typeof validity.days === 'number' ? { validityDays: validity.days } : {}),
        }
      })
      .filter((c): c is QoderCampaign => c !== undefined)
  }

  /**
   * 签到：领取今天那一份每日 Credits。
   *
   * 一次调用自足——先拉活动列表找出可领的那条，再领取。三种结果分得很清：
   *   - `claimed`：领到了（带回数额与有效期）；
   *   - `already-claimed`：今天已经领过（`CLAIMED` / 409 / `ALREADY_CLAIMED` /
   *     `replayed`），**不是错误**——重复调用是幂等的；
   *   - `unavailable`：今天上游没下发活动（未开窗 / 已领到活动行消失 / 企业号
   *     不支持该活动），带上说明。
   */
  async claimDailyCredits(credential: string, signal?: AbortSignal): Promise<QoderCheckinOutcome> {
    const campaigns = await this.fetchCampaigns(credential, signal)
    const claimable = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE')
    if (claimable === undefined) {
      const claimed = campaigns.some(c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMED')
      return claimed
        ? { status: 'already-claimed' }
        : { status: 'unavailable', message: '上游今日没有下发可领取的签到活动' }
    }
    const holder = await this.ensureSession(credential)
    const url = `${this.region.openapi}${this.region.campaignsPath}/${encodeURIComponent(claimable.campaignId)}/claim`
    try {
      const data = await this.sashRequest('POST', holder, url, {}, signal)
      // 上游用 `status` 回报领取结果；`CLAIMED` 才算成功。
      if (String(data.status ?? '') === 'CLAIMED') {
        return {
          status: 'claimed',
          ...(claimable.amount === undefined ? {} : { amount: claimable.amount }),
          ...(claimable.validityDays === undefined ? {} : { validityDays: claimable.validityDays }),
        }
      }
      return { status: 'unavailable', message: `签到未完成（上游状态 ${String(data.status ?? '未知')}）` }
    } catch (error) {
      // 重复领取是幂等的：409 / ALREADY_CLAIMED / replayed 一律当「今天已领」。
      if (error instanceof QoderUpstreamError && error.status === 409) return { status: 'already-claimed' }
      throw error
    }
  }

  /**
   * `sash` 接口的通用请求（活动列表 / 领取共用）。
   *
   * 认证与用量查询同一套：`Authorization: Bearer <jobToken.securityOauthToken>`。
   * 但那两个接口需要 `cosy-clienttype: 10` 与 `user-agent: Qoder`——参考实现
   * 如此，缺了会被拒；而夹带 cosy 协议头（chat/models 那套）反而不认。
   *
   * **国际版额外需要设备风控头**（`Cosy-MachineToken/Code/Type`，见 device-risk.ts）：
   * 签到活动只下发给带这些头的请求，缺了就拿不到活动列表。国内版不需要，所以按
   * region 条件附加 —— 不要无条件发，多余的头在另一侧是噪音。
   */
  private async sashRequest(
    method: 'GET' | 'POST',
    holder: QoderSessionHolder,
    url: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const oauthToken = holder.jobToken.securityOauthToken
    if (oauthToken === '') {
      throw new QoderUpstreamError('auth', 'jobToken 未返回 securityOauthToken，无法访问签到接口', 401)
    }
    const resp = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${oauthToken}`,
        'cosy-clienttype': SASH_CLIENT_TYPE,
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': SASH_USER_AGENT,
        ...(await this.deviceRiskHeaders()),
        ...(method === 'POST' ? { 'content-type': 'application/json', origin: this.region.openapi } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200 && resp.status !== 201) {
      throw new QoderUpstreamError(classifyHttpStatus(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status)
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }

  /**
   * 本区域签到需要的设备风控头。
   *
   * 国内版返回空对象（不需要，发了反而是噪音）；国际版读取本机 UMID 组件的
   * 三件套。读取失败**不**静默降级成「无头请求」——那样只会拿到一个空的活动
   * 列表，用户看到「今天没有活动」而真实原因是取不到设备身份。所以这里让错误
   * 抛出去，由调用方带着原因回报。
   */
  private async deviceRiskHeaders(): Promise<Record<string, string>> {
    if (!this.region.requiresDeviceRisk) return {}
    const risk = await readDeviceRisk(this.regionKey)
    return {
      'cosy-machinetoken': risk.machineToken,
      'cosy-machinecode': risk.machineCode,
      'cosy-machinetype': risk.machineType,
    }
  }

  /**
   * 直连回退：`Bearer <PAT>` 打同一个端点。返回 undefined 表示这条回退路径
   * 也没给出 200（端点不接受直连 PAT，或网络失败）——由调用方决定是否把原始
   * 的凭据被拒错误抛出去。
   */
  private async fetchUsageDirect(
    url: string,
    credential: string,
    signal?: AbortSignal,
  ): Promise<QoderUsage | undefined> {
    try {
      const resp = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
          'cosy-clienttype': '10',
          'user-agent': 'Qoder',
        },
        ...(signal === undefined ? {} : { signal }),
      })
      if (resp.status === 200) {
        const data = await resp.json() as Record<string, unknown>
        return parseUsage(data)
      }
      if (resp.status === 401 || resp.status === 403) {
        // 两条路径都拒绝同一个 PAT：这就是凭据被拒，保留原始错误抛出。
        return undefined
      }
    } catch {
      // 直连路径失败不代表凭据坏了，交给调用方用原始错误判定。
    }
    return undefined
  }

  private async bearerGet(holder: QoderSessionHolder, url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const pathSig = pathSigFrom(url)
    const payloadB64 = buildPayloadB64(holder.session.info)
    const date = String(Math.floor(Date.now() / 1000))
    const sig = signRequest(payloadB64, holder.session.cosyKey, date, '', pathSig)
    const bearer = composeBearer(payloadB64, sig)
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'cosy-machinetype': holder.session.machineType,
      'cosy-date': date,
      'cosy-user': holder.session.identity.uid,
      'cosy-key': holder.session.cosyKey,
      accept: 'application/json',
      authorization: bearer,
      'cosy-version': '0.1.43',
      'cosy-machineid': holder.session.machineId,
      'cosy-machinetoken': holder.session.machineToken,
    }
    const resp = await this.fetchImpl(url, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyHttpStatus(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status)
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数（导出供测试）
// ---------------------------------------------------------------------------

/** jobToken 交换请求体。PAT 或 `drt-` refreshToken 二选一。 */
export function jobTokenBody(credential: string): string {
  const isRefresh = credential.startsWith('drt-')
  const inner = {
    personalToken: isRefresh ? '' : credential,
    securityOauthToken: '',
    refreshToken: isRefresh ? credential : '',
    needRefresh: isRefresh,
    authInfo: {},
  }
  const outer = { payload: JSON.stringify(inner), encodeVersion: '1' }
  const plain = JSON.stringify(outer)
  return cosyEncode(new TextEncoder().encode(plain))
}

function randomId(): string {
  return crypto.randomUUID()
}

/**
 * 解析一条 SSE 帧：
 * `data: {"headers":{...},"body":"<inner json>","statusCodeValue":200}`
 * 内层：`{"choices":[{"delta":{...}}], "usage":{...}}` 或业务错误 `{"code":"115","message":"..."}`。
 * 返回 undefined 表示本帧无可消费内容（或 [DONE] 之前的空帧）。
 */
export function parseStreamDelta(dataPayload: string): QoderChatDelta | undefined {
  let wrapper: Record<string, unknown>
  try {
    wrapper = JSON.parse(dataPayload) as Record<string, unknown>
  } catch {
    return undefined
  }
  // 信封层错误：HTTP 200 建流后，上游把 provider 故障包在信封里投递。
  const scv = wrapper.statusCodeValue
  if (scv !== undefined && scv !== null && Number(scv) !== 200) {
    const detail = typeof wrapper.body === 'string' ? wrapper.body : dataPayload.slice(0, 400)
    throw new QoderUpstreamError(classifyHttpStatus(Number(scv), detail), `上游信封错误: HTTP ${scv} ${truncate(detail, 300)}`, Number(scv))
  }
  const innerStr = wrapper.body
  if (typeof innerStr !== 'string' || innerStr === '') return undefined
  let inner: Record<string, unknown>
  try {
    inner = JSON.parse(innerStr) as Record<string, unknown>
  } catch {
    return undefined
  }

  // 业务错误：{"code":"115","message":"..."}
  if (typeof inner.code === 'string' && inner.code !== '' && inner.code !== '0') {
    throw new QoderUpstreamError(classifyBusinessCode(inner.code), `上游业务错误 code=${inner.code}: ${String(inner.message ?? '')}`, 0, inner.code)
  }

  const usageIn = readTokens(inner.usage, 'prompt_tokens')
  const usageOut = readTokens(inner.usage, 'completion_tokens')

  const choices = Array.isArray(inner.choices) ? inner.choices : []
  for (const ch of choices as Array<Record<string, unknown>>) {
    const delta = ch.delta as Record<string, unknown> | undefined
    if (!delta) continue
    const role = typeof delta.role === 'string' ? delta.role : ''
    const content = typeof delta.content === 'string' ? delta.content : ''
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 ? delta.tool_calls : undefined
    if (role !== '' || content !== '' || reasoning !== '' || toolCalls !== undefined) {
      return { role, content, reasoningContent: reasoning, toolCalls, inputTokens: usageIn, outputTokens: usageOut }
    }
  }
  if (usageIn > 0 || usageOut > 0) {
    return { role: '', content: '', reasoningContent: '', toolCalls: undefined, inputTokens: usageIn, outputTokens: usageOut }
  }
  return undefined
}

function readTokens(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object') return 0
  const v = (usage as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : 0
}

/** 解析用量响应（兼容 qoderUsage 内层与平铺两种形状）。 */
export function parseUsage(data: Record<string, unknown>): QoderUsage | undefined {
  const qoderUsage = data.qoderUsage as Record<string, unknown> | undefined
  const source = qoderUsage ?? data
  const userQuota = readBucket(source.userQuota)
  const addOn = source.addOnQuota as Record<string, unknown> | undefined
  const org = source.orgResourcePackage as Record<string, unknown> | undefined
  const out: QoderUsage = {
    userType: typeof source.userType === 'string' ? source.userType : undefined,
    expiresAt: typeof source.expiresAt === 'number' ? source.expiresAt : undefined,
    upgradeUrl: typeof source.upgradeUrl === 'string' ? source.upgradeUrl : undefined,
    isQuotaExceeded: source.isQuotaExceeded === true,
  }
  if (userQuota) out.userQuota = userQuota
  if (addOn) {
    out.addOnQuota = {
      ...readBucket(addOn),
      detailUrl: typeof addOn.detailUrl === 'string' ? addOn.detailUrl : undefined,
    }
  }
  if (org) {
    out.orgResourcePackage = {
      used: num(org.used), cap: num(org.cap), remaining: num(org.remaining),
      percentage: num(org.percentage), available: org.available === true,
    }
  }
  return out
}

function readBucket(value: unknown): { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  return {
    total: num(v.total), used: num(v.used), remaining: num(v.remaining), percentage: num(v.percentage),
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/** HTTP 状态 → 错误分类（内容审核标记优先于状态码，与 Go 版一致）。 */
export function classifyHttpStatus(status: number, detail: string): UpstreamErrorKind {
  // DataInspectionFailed / inappropriate content 等标记即使出现在
  // 5xx/200 流里也按内容策略拒绝处理（Go 版 errors_test 同判）。
  if (isContentPolicy(detail)) return 'content-policy'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'invalid-request'
  if (status === 418 || status >= 500) return 'transient'
  return 'unknown'
}

/** 业务 code → 错误分类。 */
export function classifyBusinessCode(code: string): UpstreamErrorKind {
  if (code === '105') return 'auth' // Login expired
  if (code === '115' || code === '402' || code === '6004') return 'quota-exhausted'
  return 'unknown'
}

const CONTENT_POLICY_MARKERS = [
  'DataInspectionFailed',
  'inappropriate content',
  'input text data may contain',
  'ContentFilter',
  'SensitiveContent',
]

export function isContentPolicy(detail: string): boolean {
  return CONTENT_POLICY_MARKERS.some(marker => detail.includes(marker))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
