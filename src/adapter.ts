/**
 * The Qoder pi-ai providers: loopback-backed adapters registered into the
 * Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points.
 * One instance per region — `qoder` for the CN gateway, `qoder-global` for
 * the international one — each pointing at its own shim and catalog so the
 * two regions serve simultaneously.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）——
 * pi-ai provider 的装配（createProvider + openAICompletionsApi + inert auth
 * plane + 用 shim 的进程内 secret 当 apiKey）与 profile 组装沿用其做法。
 *
 * @module dsh-connect-qoder/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, Context, CredentialStore, Message, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderShim } from './shim.ts'
import { modelDisplayName } from './catalog.ts'
import type { QoderCatalog, QoderModelInfo } from './catalog.ts'
import type { QoderRegion } from './upstream.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import type { PiAiGeneration } from './pi-ai-runtime.ts'

/** Provider route this bundle owns for the domestic (CN) gateway. */
export const QODER_PROVIDER = 'qoder'

/** Provider route this bundle owns for the international gateway. */
export const QODER_GLOBAL_PROVIDER = 'qoder-global'

/** The provider id each region registers as. */
export const QODER_PROVIDERS: Readonly<Record<QoderRegion, string>> = {
  cn: QODER_PROVIDER,
  global: QODER_GLOBAL_PROVIDER,
}

/** Region a provider route id belongs to. */
export function regionOfProvider(provider: string): QoderRegion | undefined {
  for (const [region, id] of Object.entries(QODER_PROVIDERS) as [QoderRegion, string][]) {
    if (id === provider) return region
  }
  return undefined
}

/** Human-readable provider name, shown in the DSH model picker. */
export const QODER_PROVIDER_DISPLAY_NAMES: Readonly<Record<QoderRegion, string>> = {
  cn: 'Qoder',
  global: 'Qoder Global',
}

/** Provider idle ceiling while one stream read is outstanding. */
export const QODER_STREAM_IDLE_TIMEOUT_MS = 300_000

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/** Inert pi-ai auth plane: the route authenticates only through the shim secret. */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {},
  },
  authContext: {},
} as unknown as { credentials: CredentialStore; authContext: AuthContext }

export interface QoderAdapterOptions {
  shim: QoderShim
  catalog: QoderCatalog
  provider?: string
  displayName?: string
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Override the pi-ai generation gate (see {@link piAiRuntimeInfo}); tests
   * inject both branches because this checkout only ever RESOLVES one of
   * them. Production callers leave it unset.
   */
  piAiGeneration?: PiAiGeneration
}

export interface QoderAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
  /** Which pi-ai generation this checkout resolved (diagnostic for `bin doctor`). */
  piAiGeneration: PiAiGeneration
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type QoderThinkingLevel = typeof THINKING_LEVELS[number]
type QoderThinkingLevelMap = Partial<Record<'off' | QoderThinkingLevel, string | null>>

/** pi-ai input modalities: images only when Qoder advertises them. */
export function qoderModelInput(info: QoderModelInfo): ('text' | 'image')[] {
  return info.supportsImages === true ? ['text', 'image'] : ['text']
}

/**
 * The DSH-facing thinking level map for one Qoder model.
 *
 * **只映射上游真正声明的档位**（workbuddy 的 `workBuddyThinkingLevelMap` 同规）。
 * Qoder 的 `thinking_config.enabled.efforts` 会逐模型声明档位，且**不统一**：
 * Qwen 系是 `xhigh / low / medium`，DeepSeek/GLM 系是 `high / low / max`。
 * 把六个 DSH 档位全部置 null 会让 DSH 的模型设置里出现一排「可选但无效」的
 * 档位 —— 用户选了也不起作用。正确做法是：声明了的档位映射到**同名**的真实档位，
 * 没声明的映射为 `null`（DSH 据此不提供该档）。
 *
 * 上游声明可以关闭思考时额外提供 `off`；不能关闭则 `off` 映射为 null（DSH
 * 不提供「关闭」）。非推理模型没有 map。
 *
 * 注意：这与「请求线怎么带档位」是两件事 —— shim 侧按
 * `reasoningEffort` + `parameters.reasoning_effort` 发送（见 shim.ts）。
 */
export function qoderThinkingLevelMap(info: QoderModelInfo): QoderThinkingLevelMap | undefined {
  if (!info.supportsThinking) return undefined
  const declared = info.thinkingEfforts ?? []
  const supported = THINKING_LEVELS.filter(level =>
    (declared as readonly string[]).includes(level))
  // 上游声明的档位与 DSH 的档位名没有交集时，仍然要给出 map（模型是推理模型），
  // 但全部置 null —— 此时 DSH 的设置里不出现任何可选档位，而不是给出无效项。
  const map: QoderThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) map[level] = supported.includes(level) ? level : null
  if (info.canDisableThinking === true) map.off = 'off'
  return map
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(
  info: QoderModelInfo,
  baseUrl: string,
  providerId: string,
): Model<Api> {
  const thinkingLevelMap = qoderThinkingLevelMap(info)
  return {
    id: info.key,
    // DSH 面的显示名 = 模型名 + 上游倍率（workbuddy 的 workBuddyDisplayName 同规，
    // 也就是 `GLM-5.3 · x0.79` 那种写法）。用户实拍「没有倍数显示」指的就是这里：
    // 卡片自己的选择器早就会把倍率画在名字旁边，但 **DSH 内置的模型选择器**读的是
    // 这一行 —— 它此前只拿到裸名字，于是同一个模型在两处显示得不一样。
    // 纯显示用途：DSH 侧所有关联都按模型 id 做（选择器的当前项、会话事件、
    // agent 默认模型设置、请求线上的 `model: <id>`），改名不会影响任何一处。
    name: modelDisplayName(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: qoderModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
  } as unknown as Model<Api>
}

/**
 * Rewrite a pi-ai 0.87-shaped transcript into the 0.85 shape this plugin's
 * pi-ai understands — prompt AND tools.
 *
 * WHY THIS EXISTS: pi-ai 0.87's `normalizeContext` moves the system prompt
 * INTO `messages` as `{ role: 'system', content }`, and 0.85's own `Message`
 * union has no `system` variant — its token estimator then throws inside the
 * library. This plugin cannot patch the library, so it must not hand a 0.87
 * transcript to a 0.85 API object.
 *
 * The 0.87 transcript also carries the tool declarations on that leading
 * system message (`toolsAdded`/`toolsRemoved`) — the only place they live —
 * so the fold promotes them too, exactly the merge pi-ai 0.87's own
 * `getCurrentTools` performs, and leaves an existing top-level `tools` array
 * untouched.
 *
 * Unlike the sibling plugin, Qoder needs NO fallback system prompt: the Qoder
 * gateway accepts user-first conversations (there is no "first message must be
 * the system prompt" rule), so a transcript with no system message is passed
 * through as-is. All the 0.87-vs-0.85 shape work above is identical.
 *
 * Deliberately SHAPE-based within the legacy branch, not version-based, and
 * `withLegacyContext` generation-gates which API object consumes the result.
 */
export function adaptLegacyPiAiContext(context: Context): Context {
  if (context === null || typeof context !== 'object') return context
  if (context.systemPrompt) return context
  const messages = Array.isArray(context.messages) ? context.messages : undefined
  if (messages === undefined) return context

  const systemTexts: string[] = []
  const rest: Message[] = []
  const toolState = new Map<string, NonNullable<Context['tools']>[number]>()
  let sawSystemMessage = false
  for (const message of messages) {
    const role = (message as { role?: unknown } | null)?.role
    if (role !== 'system') {
      rest.push(message)
      continue
    }
    sawSystemMessage = true
    const text = systemTextOf(message)
    if (text !== '') systemTexts.push(text)
    replayToolState(message, toolState)
  }

  if (!sawSystemMessage) return context

  // systemPrompt stays ABSENT rather than '' so a provider never receives an
  // empty system message; an absent prompt is fine on the Qoder gateway.
  const systemPrompt = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined
  const tools = Array.isArray(context.tools)
    ? undefined
    : [...toolState.values()]

  return {
    ...context,
    ...systemPrompt === undefined ? {} : { systemPrompt },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    messages: rest,
  }
}

/** Replay one 0.87 system message's tool deltas into `state`. */
function replayToolState(message: Message, state: Map<string, NonNullable<Context['tools']>[number]>): void {
  const removed = (message as { toolsRemoved?: unknown }).toolsRemoved
  if (Array.isArray(removed)) {
    for (const tool of removed) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.delete(name)
    }
  }
  const added = (message as { toolsAdded?: unknown }).toolsAdded
  if (Array.isArray(added)) {
    for (const tool of added) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.set(name, tool as NonNullable<Context['tools']>[number])
    }
  }
}

/** The text of one system message, whether it is a string or text blocks. */
function systemTextOf(message: Message): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown, text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts.join('\n\n')
}

/**
 * Wrap one pi-ai API module so both stream entry points receive a context this
 * build can consume — but only when the module RESOLVED for this plugin is the
 * legacy generation.
 *
 * The gate is the plugin's own module, resolved via {@link piAiRuntimeInfo}: a
 * modern (0.87+) api consumes the normalized transcript natively, so folding
 * for it would delete its only carrier of prompt and tools. The unwrapped
 * modern api is passed through as-is.
 */
function withLegacyContext(api: ProviderStreams, generation: PiAiGeneration): ProviderStreams {
  if (generation === 'modern') return api
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, adaptLegacyPiAiContext(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, adaptLegacyPiAiContext(context), options),
  }
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, catalog } = options
  const providerId = options.provider ?? QODER_PROVIDER
  const providerName = options.displayName ?? QODER_PROVIDER_DISPLAY_NAMES.cn

  const generation = options.piAiGeneration ?? piAiRuntimeInfo()?.generation ?? 'modern'
  const api = withLegacyContext(openAICompletionsApi(), generation)

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'Qoder shim token',
        async resolve() {
          return undefined
        },
      },
    },
    models: buildModels(),
    api,
  })

  // `getModels` is delegated to a live read: stream dispatch still runs
  // through the constructed provider, while the catalog answer tracks the
  // upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-qoder retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.secret,
    ...(options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
    piAiGeneration: generation,
  }
}