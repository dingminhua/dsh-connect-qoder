/**
 * dsh-connect-qoder：为 DeepSeek Harness 提供 Qoder（通义灵码国际/国内）
 * 模型供应商的 Cordis 插件。
 *
 * 设计沿用 dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 * 骨架：每区域一条「凭据 → 回环 shim → pi-ai 适配器 → registerAdapter /
 * registerConfigurableProviders / registerModelDiscovery」栈，CN 与 Global
 * 双区域并行服务。区别：本插件凭据是 Qoder PAT（设置卡片填写或环境变量），
 * 不读取桌面端加密凭据文件；聊天直接走 Qoder cosy 网关协议（见
 * src/upstream.ts），模型目录为网关 model/list 的实时快照。
 *
 * @module dsh-connect-qoder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { QoderUpstreamClient } from './upstream.ts'
import type { QoderUsage } from './upstream.ts'
import { QoderUpstreamError } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'
import { QoderCatalog, fallbackModelInfo, modelDisplayName, initialEnabledKeys, deriveCatalog } from './catalog.ts'
import { QODER_FALLBACK_MODELS } from './catalog.ts'
import { createQoderShim, type QoderShim } from './shim.ts'
import { createQoderAdapter, type QoderAdapter, QODER_PROVIDERS, QODER_PROVIDER_DISPLAY_NAMES, regionOfProvider } from './adapter.ts'
import { createQoderProbe } from './probe.ts'
import { registerQoderStatusRoute } from './web-status.ts'
import { QODER_SETTINGS_NS, QODER_USAGE_CACHE_MS, QODER_REGION_KEYS, QODER_GITHUB_URL } from './status-paths.ts'
import { resolvePat } from './credentials.ts'
import type { QoderRegion } from './upstream.ts'
import { QODER_CONNECT_VERSION } from './version.ts'

export { QODER_CONNECT_VERSION }

export { QODER_GITHUB_URL }

// ---------------------------------------------------------------------------
// 标识与注入
// ---------------------------------------------------------------------------

export const name = 'dsh-connect-qoder'

/** The model registry and settings service required before the provider can register. */
export const inject = ['llm', 'settings']

/**
 * The namespace the HOST actually serves this plugin under.
 *
 * 0.1.7 的 settings 服务以 Loader 条目 id 推导命名空间，宿主按**精确匹配**
 * 查表；`ctx.fiber.entry` 由 Loader 添加（Cordis 自身的类型里没有），缺失
 * 时回落到声明值。此探测沿用 workbuddy 的做法。
 */
export function settingsNamespaceOf(ctx: unknown): string {
  const id = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } })?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : QODER_SETTINGS_NS
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function asVolatile<T>(schema: z<T>): z<T> {
  if (typeof (schema as unknown as { volatile?: () => z<T> }).volatile === 'function') {
    return (schema as unknown as { volatile: () => z<T> }).volatile()
  }
  return schema
}

function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && 'get' in (value as object) && typeof (value as unknown as { get(): unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

const modelConfig = z.object({
  key: z.string(),
  displayName: z.string(),
  priceFactor: z.number(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
  supportsImages: z.boolean(),
  supportsThinking: z.boolean(),
  canDisableThinking: z.boolean(),
  isDefault: z.boolean(),
  isFree: z.boolean(),
  isNew: z.boolean(),
})

const regionStateConfig = z.object({
  /** 本区域 PAT（Personal Access Token）。留空则读环境变量。 */
  pat: z.string().default('').description('Qoder PAT（留空时读取环境变量）'),
  /** 本区域 provider 是否启用；显式 false 才停用（opt-out）。 */
  enabled: z.boolean(),
  /** 用户保存的模型目录（卡片“保存”时写入）。 */
  lastCatalog: z.array(modelConfig),
  /** 用户勾选的模型 key 集合。 */
  enabledModelKeys: z.array(z.string()).default([]),
})

export interface Config {
  regions: Record<string, {
    pat?: unknown
    enabled?: boolean
    lastCatalog?: QoderModelInfo[]
    enabledModelKeys?: string[]
  }>
}

// volatile 必须放在固定路径上（`$.regions`），不能放在 dict 通配路径内
// （`regions.*.pat`）——0.2 线的 schema 校验会拒绝后者。
export const Config: z<Config> = z.object({
  regions: asVolatile(z.dict(regionStateConfig).default({}).description('Per-region PAT and model selection, keyed cn | global')),
}) as unknown as z<Config>

/** 某区域的配置状态（缺省 slots 返回空对象）。 */
export function regionStateOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): Record<string, unknown> {
  const regions = unwrapVolatile(config.regions) as Record<string, unknown> | undefined
  const stored = regions?.[region]
  if (stored !== undefined && stored !== null && typeof stored === 'object') return stored as Record<string, unknown>
  return {}
}

/** 某区域是否启用：只有显式 false 才停用。 */
export function regionEnabled(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): boolean {
  const state = regionStateOf(config, region)
  return state.enabled !== false
}

/** 某区域是否配置了 PAT（设置或环境变量其一）。 */
export function regionHasCredential(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): boolean {
  const state = regionStateOf(config, region)
  const pat = typeof state.pat === 'string' ? (state.pat as string) : ''
  return pat.trim() !== '' || resolvePat(region, undefined) !== undefined
}

/** 把保存的目录条目解析为模型信息（历史兼容，缺字段时用默认值）。 */
function modelFromStored(raw: Record<string, unknown>): QoderModelInfo | undefined {
  if (typeof raw.key !== 'string' || typeof raw.displayName !== 'string') return undefined
  return {
    key: raw.key,
    displayName: raw.displayName,
    priceFactor: typeof raw.priceFactor === 'number' ? raw.priceFactor : 1,
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : 200_000,
    maxOutputTokens: typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : 32_768,
    supportsImages: raw.supportsImages === true,
    supportsThinking: raw.supportsThinking === true,
    canDisableThinking: raw.canDisableThinking === true,
    isDefault: raw.isDefault === true,
    isFree: raw.isFree === true,
    isNew: raw.isNew === true,
  }
}

/**
 * 某区域当前应展示的目录：
 * 保存过 lastCatalog 用保存的；否则用运行期目录（fallback 或已刷新的实时表）。
 */
export function configuredModels(
  config: { regions?: Record<string, unknown> | null },
  region: QoderRegion,
  live: QoderModelInfo[],
): QoderModelInfo[] {
  const state = regionStateOf(config, region)
  const saved = state.lastCatalog
  if (Array.isArray(saved) && saved.length > 0) {
    const parsed = saved
      .map(item => modelFromStored((item ?? {}) as Record<string, unknown>))
      .filter((m): m is QoderModelInfo => m !== undefined)
    if (parsed.length > 0) return parsed
  }
  return live.length > 0 ? live : QODER_FALLBACK_MODELS.map(fallbackModelInfo)
}

export interface QoderProbe {
  probe: (modelId: string) => Promise<{ ok: boolean; kind: string; message: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null }>
}

interface QoderRegionStack {
  upstream: QoderUpstreamClient
  catalog: QoderCatalog
  shim: QoderShim
}

export function apply(ctx: Context, config: Config): void {
  const settingsNs = settingsNamespaceOf(ctx)
  const log = (message: string): void => ctx.logger.warn(`dsh-connect-qoder: ${message}`)
  let stopped = false

  const stacks = {} as Record<QoderRegion, QoderRegionStack>
  const probes = {} as Record<QoderRegion, ReturnType<typeof createQoderProbe>>
  const usageCache: Partial<Record<QoderRegion, { usage: QoderUsage | undefined; atMs: number }>> = {}
  const registration: Record<QoderRegion, {
    adapter?: AdapterRegistrationHandle
    directory?: DirectoryRegistrationHandle
  }> = { cn: {}, global: {} }

  for (const region of QODER_REGION_KEYS) {
    const upstream = new QoderUpstreamClient(region, { logger: log })
    const catalog = new QoderCatalog(QODER_FALLBACK_MODELS.map(fallbackModelInfo))
    const shim = createQoderShim({
      upstream,
      credential: () => resolvePat(region, typeof regionStateOf(config, region).pat === 'string' ? (regionStateOf(config, region).pat as string) : undefined),
      modelKeyOf: selector => catalog.keyOf(selector),
      supportsImagesOf: selector => catalog.supportsImagesOf(selector),
      logger: log,
    })
    stacks[region] = { upstream, catalog, shim }
    probes[region] = createQoderProbe({ shim, logger: log })
  }

  let invalidateCatalog = (): void => {}

  const refreshUsage = async (region: QoderRegion): Promise<void> => {
    const cached = usageCache[region]
    if (cached !== undefined && Date.now() - cached.atMs < QODER_USAGE_CACHE_MS) return
    const pat = resolvePat(region, typeof regionStateOf(config, region).pat === 'string' ? (regionStateOf(config, region).pat as string) : undefined)
    if (!pat) return
    try {
      const usage = await stacks[region].upstream.fetchUsage(pat)
      usageCache[region] = { usage, atMs: Date.now() }
    } catch {
      // 用量查询失败不打断主流程；卡片显示「不可用」。
    }
  }

  const syncRegionRegistration = (value: Config): void => {
    for (const region of QODER_REGION_KEYS) {
      const enabled = regionEnabled(value, region)
      const handle = registration[region].adapter
      if (handle === undefined) continue
      try {
        // 每个区域有自己的 adapter 注册：per-region replace 即该区域完整路由集。
        handle.replace(enabled ? [QODER_PROVIDERS[region]] : [])
      } catch (error: unknown) {
        log(`region ${region} adapter sync failed: ${String((error as Error)?.message ?? error)}`)
      }
    }
    // 目录是「一条注册、双条目」：replace 是全量语义，必须一次写入完整启用列表，
    // 逐区域 replace 会让最后一个区域胜出、把启用的兄弟条目顶掉。
    const dirHandle = registration.cn.directory
    if (dirHandle === undefined) return
    try {
      dirHandle.replace(QODER_REGION_KEYS
        .filter(region => regionEnabled(value, region))
        .map(region => ({
          provider: QODER_PROVIDERS[region],
          displayName: QODER_PROVIDER_DISPLAY_NAMES[region],
          settingsNs,
          settingsPath: [],
          declared: false,
        })))
    } catch (error: unknown) {
      log(`provider directory sync failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  const applySelection = (value: Config): void => {
    for (const region of QODER_REGION_KEYS) {
      stacks[region].catalog.set(configuredModels(value, region, stacks[region].catalog.current()))
    }
    invalidateCatalog()
    syncRegionRegistration(value)
    for (const region of QODER_REGION_KEYS) {
      void refreshUsage(region)
    }
  }

  const refreshModels = (region: QoderRegion): void => {
    const pat = resolvePat(region, typeof regionStateOf(config, region).pat === 'string' ? (regionStateOf(config, region).pat as string) : undefined)
    if (!pat) {
      log(`models refresh skipped for ${region}: no PAT configured`)
      return
    }
    void (async () => {
      try {
        const models = await stacks[region].upstream.fetchModels(pat)
        const state = regionStateOf(config, region)
        const saved = new Set(Array.isArray(state.enabledModelKeys) ? state.enabledModelKeys as string[] : [])
        const parsed = models.map(m => ({
          key: m.key,
          displayName: m.display_name,
          priceFactor: m.price_factor ?? 1,
          contextWindow: pickContext(m),
          maxOutputTokens: m.max_output_tokens ?? 32_768,
          supportsImages: m.is_vl,
          supportsThinking: m.is_reasoning,
          canDisableThinking: true,
          isDefault: m.is_default,
          isFree: m.is_free,
          isNew: false,
        } as QoderModelInfo))
        stacks[region].catalog.set(deriveCatalog(parsed, saved.size > 0 ? saved : initialEnabledKeys(parsed)))
        invalidateCatalog()
        void refreshUsage(region)
      } catch (error: unknown) {
        log(`dynamic ${region} model catalog unavailable; serving the static fallback list: ${String((error as Error)?.message ?? error)}`)
      }
    })()
  }

  function pickContext(m: { context_config?: Record<string, { token_count: number; is_default?: boolean }> | undefined; max_input_tokens?: number | undefined }): number {
    const cc = m.context_config
    if (cc) {
      const entries = Object.entries(cc)
      if (entries.length > 0) {
        const def = entries.find(([, v]) => v.is_default === true)
        if (def) return def[1].token_count
        return Math.min(...entries.map(([, v]) => v.token_count))
      }
    }
    return m.max_input_tokens ?? 200_000
  }

  // 立即应用当前配置（目录 + 注册同步 + 用量预取）。
  applySelection(config)

  // 每区域 shim 就绪后注册 provider；注册失败只记日志，不影响其他区域。
  void Promise.all(QODER_REGION_KEYS.map(region => stacks[region].shim.ready))
    .then(async () => {
      if (stopped) return

      const adapters = {} as Record<QoderRegion, QoderAdapter>
      try {
        for (const region of QODER_REGION_KEYS) {
          adapters[region] = createQoderAdapter({
            shim: stacks[region].shim,
            catalog: stacks[region].catalog,
            provider: QODER_PROVIDERS[region],
            displayName: QODER_PROVIDER_DISPLAY_NAMES[region],
            resolveAttachments: () => ctx.get('attachments'),
          })
        }
        invalidateCatalog = () => {
          for (const region of QODER_REGION_KEYS) adapters[region].invalidate()
        }

        const releaseAdapter = {} as Record<QoderRegion, (() => void) | undefined>
        let releaseDirectory: (() => void) | undefined
        try {
          for (const region of QODER_REGION_KEYS) {
            // Always register the route first: an empty INITIAL registration is
            // invalid, while `replace([])` on a live one is legal.
            releaseAdapter[region] = registration[region].adapter = ctx.llm.registerAdapter([QODER_PROVIDERS[region]], adapters[region].adapter)
          }
          releaseDirectory = registration.cn.directory = ctx.llm.registerConfigurableProviders([
            {
              provider: QODER_PROVIDERS.cn,
              displayName: QODER_PROVIDER_DISPLAY_NAMES.cn,
              settingsNs,
              settingsPath: [],
              declared: false,
            },
            {
              provider: QODER_PROVIDERS.global,
              displayName: QODER_PROVIDER_DISPLAY_NAMES.global,
              settingsNs,
              settingsPath: [],
              declared: false,
            },
          ])
        } finally {
          const missing = QODER_REGION_KEYS.some(region => releaseAdapter[region] === undefined) || releaseDirectory === undefined
          if (missing) {
            for (const region of QODER_REGION_KEYS) releaseAdapter[region]?.()
            releaseDirectory?.()
          }
        }

        ctx.effect(() => () => {
          for (const region of QODER_REGION_KEYS) releaseAdapter[region]?.()
          releaseDirectory?.()
        })

        syncRegionRegistration(config)

        ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
          const region = regionOfProvider(request.provider ?? '')
          if (region === undefined) return []
          if (!regionEnabled(config, region)) return []
          let models: QoderModelInfo[]
          try {
            const pat = resolvePat(region, typeof regionStateOf(config, region).pat === 'string' ? (regionStateOf(config, region).pat as string) : undefined)
            if (!pat) return []
            const upstream = await stacks[region].upstream.fetchModels(pat, signal)
            models = upstream.map(m => ({
              key: m.key,
              displayName: m.display_name,
              priceFactor: m.price_factor ?? 1,
              contextWindow: pickContext(m),
              maxOutputTokens: m.max_output_tokens ?? 32_768,
              supportsImages: m.is_vl,
              supportsThinking: m.is_reasoning,
              canDisableThinking: true,
              isDefault: m.is_default,
              isFree: m.is_free,
              isNew: false,
            }))
          } catch (error: unknown) {
            log(`model discovery for ${region} failed: ${String((error as Error)?.message ?? error)}`)
            return []
          }
          const state = regionStateOf(config, region)
          const saved = new Set(Array.isArray(state.enabledModelKeys) ? state.enabledModelKeys as string[] : [])
          return deriveCatalog(models, saved.size > 0 ? saved : initialEnabledKeys(models)).map(model => ({
            id: model.key,
            name: modelDisplayName(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutputTokens,
            inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
          }))
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-qoder: provider registration failed', error)
        return
      }

      // 每区域异步刷新目录（失败静默，fallback 目录继续服务）。
      for (const region of QODER_REGION_KEYS) {
        refreshModels(region)
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-connect-qoder: loopback endpoint failed to start; providers not registered', error)
    })

  // 浏览器路由（webServer 可选注入；缺失时卡片读镜像即可）。
  ctx.inject(['webServer'], (ctxWithWeb) => {
    registerQoderStatusRoute(ctxWithWeb, {
      regionEnabled: region => regionEnabled(config, region),
      hasCredential: region => regionHasCredential(config, region),
      catalogs: {
        cn: stacks.cn.catalog,
        global: stacks.global.catalog,
      },
      probes: {
        cn: probes.cn,
        global: probes.global,
      },
      usage: region => usageCache[region],
      refreshModels,
      logger: log,
    })
  })

  // 0.1.7 在每次设置写入后发 `loader/volatile-update`；借此收敛目录/注册/用量。
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => {
      applySelection(config)
    })

  // 析构：关闭 shims（副作用一次执行）。
  ctx.effect(() => () => {
    stopped = true
    for (const region of QODER_REGION_KEYS) {
      void stacks[region].shim.close()
    }
  })
}