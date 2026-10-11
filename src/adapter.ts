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
import type { Api, AuthContext, Context, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderShim } from './shim.ts'
import type { QoderCatalog } from './catalog.ts'
import type { QoderRegion } from './upstream.ts'

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
}

export interface QoderAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

function toPiModel(
  info: ReturnType<QoderCatalog['current']>[number],
  baseUrl: string,
  providerId: string,
): Model<Api> {
  return {
    id: info.key,
    name: info.displayName,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: info.supportsThinking,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, catalog } = options
  const providerId = options.provider ?? QODER_PROVIDER
  const providerName = options.displayName ?? 'Qoder'

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
    api: openAICompletionsApi(),
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
  }
}