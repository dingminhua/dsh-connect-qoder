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
  // **必须至少有一个真实档位，否则不能返回 map。**
  //
  // DSH 内核（dsh-llm）对推理元数据是硬校验的：
  //   - `if (reasoning.efforts.length === 0) throw INVALID_MODEL_REASONING`
  //   - dsh-llm-pi-ai 的 `getSupportedThinkingLevels()` 把
  //     `thinkingLevelMap[level] === null` 判为不支持，于是「全 null 的 map」
  //     解析出**零个**档位。
  // 一旦某个模型那样，**整条 provider 路由作废** —— 用户在 DSH 里看到的是
  // 「Provider is not configured: <provider>」，而不是「这个模型没有档位」。
  // 实测：`auto` 与 `qmodel_latest` 上游不声明 efforts，正是这样把 qoder 整条
  // 路由打掉的（用户实拍）。
  //
  // 所以上游没声明档位时返回 `undefined`：DSH 把它读作「这个模型不提供推理」，
  // 于是不渲染档位选择器（正确的降级），而路由保持健康。
  if (supported.length === 0) return undefined
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
    // `supportsDeveloperRole: false` 是**必须**的，不是保守起见。
    //
    // pi-ai 的 openai-completions API 这样决定系统提示词的角色：
    //     const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole
    //     const role = useDeveloperRole ? 'developer' : 'system'
    // Qoder 上游只接受 `system` / `assistant` / `user` / `tool` / `function`，
    // 收到 `developer` 会直接 400：
    //     "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']"
    // （用户实拍）。
    //
    // 这个分支只在**同时**满足「reasoning 为真」与「compat 未显式关闭」时才走。
    // 我此前让档位真正生效（reasoning 从 false 变 true）恰好把第一个条件打开了，
    // 于是第二个条件默认值（开启）开始起作用 —— 两个改动叠加才暴露出来。
    compat: {
      supportsReasoningEffort: thinkingLevelMap !== undefined,
      supportsDeveloperRole: false,
    },
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
 *
 * LEGACY-ONLY (0.85). This produces the FLAT `{systemPrompt, tools, messages}`
 * shape that ONLY pi-ai 0.85 reads. Never hand its result to a 1.x api — 1.x
 * reads the prompt and tools from `messages[].toolsAdded` and would see none.
 * That is precisely the 0.2.1-rc.1 regression: `generationOf` misclassified
 * the 1.x major version as `legacy`, so this function was applied to a
 * transcript that pi-ai's `createModels` had already normalized, and the
 * request went out with no prompt and no tools. See {@link withLegacyContext}.
 * Type note: the parameter is the 0.85 `Context`, while pi-ai 1.x types the
 * api's second parameter as `TranscriptContext`; calling this with 1.x typings
 * is a TS2353 by design, which is exactly why the modern branch must not touch
 * it.
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
 * generation can actually consume.
 *
 * The gate is the plugin's own module, resolved via {@link piAiRuntimeInfo}
 * (manifest version of the copy this plugin resolves — no pi-ai import):
 *
 * - `legacy` (0.85) wants the flat `{systemPrompt, tools, messages}` shape, so
 *   a normalized transcript is UN-folded by {@link adaptLegacyPiAiContext}.
 * - `modern` (0.87+, incl. 1.x) wants the normalized transcript, which is
 *   already what it receives, so the api is passed through UNWRAPPED.
 *
 * WHY `modern` IS A PASS-THROUGH — and the 0.2.1-rc.1 regression this guards.
 * The normalizer that matters lives in pi-ai's **Models layer**
 * (`createModels().stream/streamSimple` → `normalizeContext(context)`), which
 * sits BETWEEN the host and the provider-facing api module. `PiAiAdapter`
 * registers this plugin's provider into that layer, so the api module is
 * handed an ALREADY-normalized transcript. Verified on the installed
 * 0.2.1-rc.1 host (pi-ai 1.x) with a real `createModels` + real
 * `openaiCompletionsApi()`: the api module receives
 * `{messages:[{role:'system',…toolsAdded}]}` and never a top-level
 * `systemPrompt`/`tools`.
 *
 * The 0.2.1-rc.1 regression was therefore NOT "the modern branch is empty". It
 * was {@link generationOf} failing to recognise the 1.x MAJOR version: its
 * `/^0\.(\d+)\./` pattern only matches a leading `0.`, so `1.1.0` / `1.3.0`
 * fell through to `legacy`. The plugin then applied
 * {@link adaptLegacyPiAiContext} — which UN-folds the transcript back into the
 * flat 0.85 shape — and handed that to a 1.x api that reads only
 * `context.messages`. Measured wire result on the real stack:
 *
 *   legacy branch (bug)  → roles ["user"],  system null,       tools 0
 *   modern branch (fix)  → roles ["system","user"], prompt intact, tools 1
 *
 * i.e. NO prompt and NO tools, silently. The fix is in the detector, not here:
 * this branch must stay a pass-through, because folding on top of what
 * `createModels` already normalized would prepend a SECOND (empty) system
 * message.
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
        // **必须返回一个对象，绝不能返回 undefined。**
        //
        // pi-ai 的 `applyAuth` 只做存在性判断：
        //     const resolution = await this.getAuth(...)
        //     if (!resolution) throw new ModelsError('auth',
        //       `Provider is not configured: ${model.provider}`)
        // 返回 `undefined` 等于宣称「这个 provider 根本没配置」—— 用户在 DSH 里
        // 看到的正是那句 `Provider is not configured: qoder`（用户实拍）。
        //
        // 而真实凭据**不从这里来**：本 route 只通过 shim 的进程内 secret 认证，
        // secret 由 `PiAiAdapter` 的 `resolveApiKey` 逐请求提供给 pi-ai（见下方
        // `resolveApiKey: async () => shim.secret`）。所以这里报「没有 key」是
        // 诚实的、也是正确的 —— 只要它是一个对象。
        //
        // 形状对齐 dsh-llm-pi-ai 自己的 `harnessApiKeyAuth()`：即使 credential
        // 缺席也返回 `{ auth: {}, source }`，把是否真的需要 key 交给协议层判断。
        async resolve({ credential }) {
          const apiKey = credential?.key
          return {
            auth: apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
            source: 'Qoder shim token',
          }
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