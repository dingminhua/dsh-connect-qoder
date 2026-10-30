/**
 * The real-volume model probe: what it sends, what an answer means, and
 * what (if anything) can honestly be said about a cooldown.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）的 `src/probe.ts` ——「一次
 *   探测请求」的构造与解读（真实体积、冷却时间解析三来源、文案脱敏、错误
 *   结果分类）整体沿用。
 * 改动：把「构造探测请求」与「跑一次探测」拆为两层 ——
 *
 *   - 分类/冷却/文案/请求体构造是**纯函数**（本文件），可无网单测；
 *   - 真正发请求的 `probeModel` 依赖注入 `QoderProbeClient`（encode）。
 *     Qoder 的聊天请求必须走 cosy 签名 + 模板组包（system 归并、思维开关、
 *     `applyModelKey` 等），这层全部在 Host 侧（`src/index.ts`）实现，因为
 *     `QoderUpstreamClient.chatStream` 一次只服务一个区域实例；探针要按
 *     **某个账号**寻址，必须由 Host 把该账号的 PAT 装配好交给 chatStream。
 *
 * 保留的族内结论：
 *   1. **探测故意发真实体积**的输入（默认 25k）：极小请求永远「可用」，而真实
 *      长会话会被体积限流拒掉。本端口不重新测量 Qoder 的节流线，25k/档位表取
 *      家族默认值 —— 当作「一次写实对话的体积」而非对某条精确阈值的赌注；
 *   2. **冷却只有三处来源**：`Retry-After` 头、失败响应体里的 `将在 … 重置`
 *      句子、以及「额度耗尽 + 已知刷新时刻」；三处都没有时如实返回「上游未
 *      给出」，绝不编造倒计时；
 *   3. **文案在入库前脱敏**（`redactUpstreamText`），失败的 chat 请求也会把原因
 *      持久化进账号池，同一处实现避免两处写法漂移。
 *
 * @module dsh-connect-qoder/probe
 */

import type { QoderWebProbeOutcome, QoderWebProbeResult } from './status-paths.ts'
import type { UpstreamErrorKind } from './upstream.ts'

/** The family's default probe input, in tokens (a realistic conversation size). */
export const DEFAULT_PROBE_INPUT_TOKENS = 25_000

/**
 * The probe sizes the card offers, in tokens — carried from the sibling plugin
 * so the two cards read one family set.
 */
export const PROBE_INPUT_TOKEN_CHOICES: readonly number[] = [10_000, 20_000, 30_000, 50_000, 100_000]

/**
 * A requested probe size reduced to a size this build will send.
 */
export function resolveProbeInputTokens(requested: number | undefined): number {
  return requested !== undefined && PROBE_INPUT_TOKEN_CHOICES.includes(requested)
    ? requested
    : DEFAULT_PROBE_INPUT_TOKENS
}

/** Characters per token for the filler text (family estimate, 4.5 c/tok). */
const CHARS_PER_TOKEN = 4.5

/** Neutral filler; carries no user content, only volume. */
const FILLER_LINE = 'The quick brown fox jumps over the lazy dog. '

/**
 * The probe sizes the card's dropdown offers, as labelled values.
 *
 * Kept here so the schema's description, the card's dropdown, and the coercion
 * in {@link resolveProbeInputTokens} cannot drift apart into three menus.
 */
export const PROBE_INPUT_TOKEN_CHOICES_LABELLED: readonly { value: number, label: string }[] = [
  { value: 10_000, label: '10K' },
  { value: 20_000, label: '20K' },
  { value: 30_000, label: '30K' },
  { value: 50_000, label: '50K' },
  { value: 100_000, label: '100K' },
]

/**
 * Build the user message a probe carries: a padded filler (for volume) plus
 * the actual prompt. Qoder's gateway takes user-first messages (no system
 * requirement), so no PROBE_SYSTEM_PROMPT is needed.
 */
export function probeUserMessage(inputTokens: number = DEFAULT_PROBE_INPUT_TOKENS): string {
  const targetChars = Math.ceil(resolveProbeInputTokens(inputTokens) * CHARS_PER_TOKEN)
  const filler = FILLER_LINE.repeat(Math.ceil(targetChars / FILLER_LINE.length))
  return `${filler}Reply with a single word.`
}

// ---------------------------------------------------------------------------
// 冷却时间
// ---------------------------------------------------------------------------

/**
 * Parse a `Retry-After` header value into an absolute time.
 *
 * Both RFC 9110 forms are accepted: delay-seconds (`120`) and an HTTP-date.
 * Returns undefined for anything else, including negative/zero delays.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    return nowMs + seconds * 1_000
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  if (parsed <= nowMs) return undefined
  return parsed
}

/**
 * The upstream's reset sentence, as Qoder's gateways write it in Chinese —
 * e.g. `您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，…`.
 * Loose around the wording, strict about the parts that must not be guessed:
 * the keyword 重置, the timestamp shape, and an explicit UTC offset.
 */
const UPSTREAM_RESET_PATTERN
  = /将在?\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\s*([+-])(\d{1,2})(?::?(\d{2}))?[\s\S]*?重置/u

/**
 * Parse the reset time out of an upstream failure message.
 *
 * The offset is honoured, not assumed: `Date.UTC` with the stated offset
 * subtracted, returned as epoch ms. A whole-second resolution is what the
 * upstream prints.
 */
export function parseUpstreamResetAt(message: string): number | undefined {
  const match = UPSTREAM_RESET_PATTERN.exec(message)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match
  const offsetTotalMinutes
    = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? '0'))
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  )
  const parsed = new Date(utcMs)
  if (parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)
    || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute)
    || parsed.getUTCSeconds() !== Number(second)) {
    return undefined
  }
  if (Math.abs(offsetTotalMinutes) > 14 * 60) return undefined
  return utcMs - offsetTotalMinutes * 60_000
}

/**
 * The cooldown the upstream stated, if it stated one.
 *
 * Four sources, in order of authority: `Retry-After` on the failure response;
 * the upstream's OWN declared wait (`retryAfterSeconds` in the queue envelope,
 * issue #26); the reset time written into the failure body (the case that
 * actually fires — a 429 carries `将在 … 重置`, no header); and the region's
 * quota refresh point ONLY for an out-of-credit outcome. None of these → `{}`,
 * which the card renders as "the upstream did not say when".
 *
 * ⚠️ The declared wait comes **before** the body reset sentence on purpose:
 * issue #26's field report is an upstream that says "wait 30 seconds" while the
 * plugin amplified it into a 30-minute cooldown — a 60× error caused by one
 * dropped field. The upstream's explicit number is the most specific statement
 * it can make, so it outranks a sentence we scraped out of a body.
 */
export function cooldownOf(input: {
  outcome: QoderWebProbeOutcome
  retryAfter: string | null
  nowMs: number
  body?: string
  quotaRefreshAtMs?: number
  /**
   * 上游申报的等待时长（毫秒），来自排队信封里的 `retryAfterSeconds`。
   *
   * 缺席 = 上游没申报（那就不许编倒计时）。
   */
  retryAfterMs?: number
}): Pick<QoderWebProbeResult, 'retryAtMs' | 'retrySource'> {
  const fromHeader = parseRetryAfter(input.retryAfter, input.nowMs)
  if (fromHeader !== undefined) return { retryAtMs: fromHeader, retrySource: 'retry-after' }
  if (input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0) {
    return { retryAtMs: input.nowMs + input.retryAfterMs, retrySource: 'upstream-reported' }
  }
  const fromBody = input.body === undefined ? undefined : parseUpstreamResetAt(input.body)
  if (fromBody !== undefined) return { retryAtMs: fromBody, retrySource: 'upstream-message' }
  if (input.outcome === 'out-of-credit' && input.quotaRefreshAtMs !== undefined) {
    return { retryAtMs: input.quotaRefreshAtMs, retrySource: 'quota-refresh' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// 结果分类
// ---------------------------------------------------------------------------

/** One probe outcome, bridged to the shared web contract. */
export type QoderProbeOutcome = QoderWebProbeOutcome

/** The upstream error kind `probe` gets when a chat request fails. */
export interface QoderProbeError {
  kind: UpstreamErrorKind | 'not-found-model'
  status: number
  message: string
  /**
   * 上游申报的等待时长（毫秒），issue #26。
   *
   * 缺席 = 上游没申报。此前这一个字段在 `probeChat` 门口被丢掉，于是上游说
   * 「等 30 秒」被放大成 30 分钟冷却。
   */
  retryAfterMs?: number
  /**
   * 上游说「我在排队」的证据，issue #26。
   *
   * 缺席 = 上游没提排队；这时不许把失败说成「排队中」。
   */
  queue?: {
    isQueued: boolean
    queueCount?: number
    queueType?: string
    retryAfterSeconds?: number
  }
}

/**
 * Classify one failed probe into the card's outcome vocabulary, from the
 * upstream error kind rather than raw status codes, so a probe and a real chat
 * request never disagree about the same answer.
 *
 * **排队单独成一档（issue #26）**：上游明说「在排队、服务是好的、30 秒后再来」
 * —— 把它归进 `unavailable`（「连不上上游」）是**两句都不对的话**：连接是通的，
 * 上游也是好的，只是这个模型在排队。用户看到那句话会以为账号坏了、要求换
 * PAT，而真相是「等 30 秒就好」。
 */
export function outcomeOfFailure(error: QoderProbeError): { outcome: QoderProbeOutcome, notFound?: boolean } {
  // 排队优先于 kind：`transient` 是 10605 的通用分类，但**上游自己说了在排队**
  // 时，那才是更具体的事实。
  if (error.queue?.isQueued === true) return { outcome: 'queued' }
  switch (error.kind) {
    case 'auth': return { outcome: 'credential-rejected' }
    case 'rate-limited': return { outcome: 'rate-limited' }
    case 'quota-exhausted': return { outcome: 'out-of-credit' }
    case 'content-policy': return { outcome: 'policy-rejected' }
    case 'invalid-request':
      // A 400 naming the model ("model … not found") is a catalog fact, not a
      // transient fault; everything else asks the user for a fix.
      return error.status === 400 && /model/i.test(error.message)
        ? { outcome: 'not-found' }
        : { outcome: 'failed' }
    case 'not-found-model': return { outcome: 'not-found' }
    case 'network':
    case 'transient':
      return { outcome: 'unavailable' }
    case 'unknown':
      return error.status === 0 || error.status >= 500 ? { outcome: 'unavailable' } : { outcome: 'failed' }
  }
}

/** Whether a probe outcome means the model answered. */
export function probeSucceeded(outcome: QoderProbeOutcome): boolean {
  return outcome === 'ok'
}

// ---------------------------------------------------------------------------
// 文案脱敏
// ---------------------------------------------------------------------------

/** Max characters of upstream text kept for display, after redaction. */
const PROBE_MESSAGE_LIMIT = 300

/**
 * Redact token-shaped content out of upstream text before it is stored or sent.
 *
 * Lives here because this module is the one that reads raw failure bodies, so
 * the redaction belongs at the point of capture. Also used by the pool's
 * `recordAccountFailure` path so the two writers cannot drift apart.
 */
export function redactUpstreamText(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    // `key=secret` 形式：保留键名，抹掉值。
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^\s&,]+/giu, '$1[redacted]')
    // 裸 token 形态：Qoder 的 PAT 以 `pt-` 开头。整段替换掉——**只**替换匹配
    // 本身，绝不把匹配再拼回结果里（早期实现写的是 `'$1[redacted]'`，把密钥
    // 原样保留了下来，等于没脱敏）。长度下限 6 避免误伤普通词里的 "pt-"。
    .replace(/\bpt-[A-Za-z0-9_-]{6,}\b/giu, '[redacted credential]')
    .slice(0, PROBE_MESSAGE_LIMIT)
}

// ---------------------------------------------------------------------------
// 探测运行
// ---------------------------------------------------------------------------

/** What one probe needs from the upstream client, injected for testability. */
export interface QoderProbeClient {
  /**
   * Send one probe for one model through one PAT, and report whether it
   * answered and — if not — what the upstream said.
   *
   * The Host implements this by calling `QoderUpstreamClient.chatStream` with
   * the padded user message and constructing a `status`/`body` description of
   * any thrown `QoderUpstreamError`; the return value is the probe's verdict.
   */
  probeChat(
    credential: { pat: string; accountName: string },
    modelKey: string,
    opts: { inputTokens?: number; signal?: AbortSignal },
  ): Promise<{
    ok: boolean
    status: number
    retryAfter: string | null
    /** The upstream's own failure body, redaction happens later. */
    body?: string
    error?: QoderProbeError
    /**
     * 上游申报的等待时长（毫秒），issue #26。
     *
     * 此前**没有这一条**：值在上游客户端里已经解析出来了（`error.retryAfterMs`），
     * 却在 `probeChat` 门口被丢掉 —— 于是「等 30 秒」被放大成 30 分钟冷却。
     */
    retryAfterMs?: number
  }>
}

/**
 * Run one probe for one model and reduce it to a result row.
 *
 * Never throws: a probe is a diagnostic the user asked for, so every failure is
 * a RESULT — one dead model must not abort a batch and hide the other rows.
 */
export async function probeModel(input: {
  client: QoderProbeClient
  credential: { pat: string; accountName: string }
  modelKey: string
  nowMs: number
  inputTokens?: number
  quotaRefreshAtMs?: number
  signal?: AbortSignal
}): Promise<QoderWebProbeResult> {
  const startedAt = Date.now()
  let answer
  try {
    answer = await input.client.probeChat(input.credential, input.modelKey, {
      ...input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens },
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
  } catch (error: unknown) {
    // 探针自己抛错（Host 那边应当自己接住上游错误，这里是兜底）：能看出排队
    // 证据就照实说排队，别退回「连不上上游」（issue #26）。
    const thrown = error as { queue?: { isQueued?: boolean, queueCount?: number, queueType?: string }, retryAfterMs?: number }
    const queued = thrown.queue?.isQueued === true
    return {
      modelId: input.modelKey,
      outcome: queued ? 'queued' : 'unavailable',
      message: redactUpstreamText(error instanceof Error ? error.message : String(error)),
      ...queued
        ? {
            queue: {
              ...thrown.queue?.queueCount === undefined ? {} : { queueCount: thrown.queue.queueCount },
              ...thrown.queue?.queueType === undefined ? {} : { queueType: thrown.queue.queueType },
            },
          }
        : {},
      ...thrown.retryAfterMs === undefined ? {} : { retryAtMs: input.nowMs + thrown.retryAfterMs, retrySource: 'upstream-reported' as const },
    }
  }
  const elapsedMs = Date.now() - startedAt

  if (answer.ok) {
    return {
      modelId: input.modelKey,
      outcome: 'ok',
      elapsedMs,
      status: answer.status,
      ...cooldownOf({
        outcome: 'ok',
        retryAfter: answer.retryAfter,
        nowMs: input.nowMs,
        ...input.quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs: input.quotaRefreshAtMs },
      }),
    }
  }

  const error = answer.error
  if (error === undefined) {
    return { modelId: input.modelKey, outcome: 'failed', elapsedMs, status: answer.status }
  }
  const { outcome } = outcomeOfFailure(error)
  const body = answer.body ?? ''
  // 上游申报的等待时长：客户端返回的与错误对象上挂的是**同一个值**，取任一即可
  // （上游客户端两条构造路径都挂了它，见 `QoderUpstreamError.retryAfterMs`）。
  const retryAfterMs = answer.retryAfterMs ?? error.retryAfterMs
  return {
    modelId: input.modelKey,
    outcome,
    elapsedMs,
    status: answer.status,
    ...body === '' ? {} : { message: redactUpstreamText(body) },
    // 排队信息只在上游明说时带出（issue #26）：缺席 = 上游没提排队。
    ...error.queue?.isQueued === true
      ? {
          queue: {
            ...error.queue.queueCount === undefined ? {} : { queueCount: error.queue.queueCount },
            ...error.queue.queueType === undefined ? {} : { queueType: error.queue.queueType },
          },
        }
      : {},
    ...cooldownOf({
      outcome,
      retryAfter: answer.retryAfter,
      nowMs: input.nowMs,
      body,
      ...retryAfterMs === undefined ? {} : { retryAfterMs },
      ...input.quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs: input.quotaRefreshAtMs },
    }),
  }
}