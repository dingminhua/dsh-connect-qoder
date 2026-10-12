/**
 * dsh-connect-qoder：为 DeepSeek Harness 提供 Qoder（通义灵码国际/国内）模型
 * 供应商的 Cordis 插件。
 *
 * 设计沿用 dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的骨架：
 * 每个区域一条「凭据存储 → 回环 shim → pi-ai 适配器 → registerAdapter /
 * registerConfigurableProviders / registerModelDiscovery」栈，CN 与 Global
 * 双区域并行服务。区别（按 Qoder 上游的现实）：
 *   - 凭据是 Qoder PAT：设置卡片填 `regions.<region>.pat`，环境变量兜底
 *     （QODERCN_PERSONAL_ACCESS_TOKEN / QODER_PERSONAL_ACCESS_TOKEN），并叠加
 *     `$DSH_HOME/.qoder-accounts.<region>.json` vault 的多账号池；
 *   - 聊天直接走 Qoder cosy 网关协议（见 src/upstream.ts），模型目录为网关
 *     model/list 的实时快照（src/catalog.ts）；
 *   - **有** daily check-in（两个区域都有）：CN 直接调 sash 的 campaigns 活动；
 *     国际版额外需要设备风控头（本机 UMID 组件，见 device-risk.ts）。
 *     没有扫码 OAuth
 *     （账号增删走 PAT 粘贴的 accounts 路由），没有桌面临终诊断 / markup 恢复；
 *   - 多账号池「实测优先」：test 批量用各成员凭据探测目标模型，落
 *     `$DSH_HOME/.qoder-pool.<region>.json`；failover 循环在流首字节前按 rankPool
 *     换账号。
 *
 * @module dsh-connect-qoder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { QoderUpstreamClient } from './upstream.ts'
import type { QoderUsage, QoderChatDelta, QoderRegion, QoderUpstreamError } from './upstream.ts'
import { isQoderUpstreamError } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'
import { QoderCatalog, fallbackModelInfo, deriveCatalog, initialEnabledKeys, parseUpstreamModel, applyContextBudgets, modelDisplayName } from './catalog.ts'
import { QODER_FALLBACK_MODELS } from './catalog.ts'
import { defaultOffModelIds, offCapabilityOf, withEffectiveOff } from './off-thinking.ts'
import { imageDefaultFor } from './native-modality.ts'
import { createQoderShim, type QoderShim, type QoderServingAccount } from './shim.ts'
import { createQoderAdapter, type QoderAdapter, QODER_PROVIDERS, QODER_PROVIDER_DISPLAY_NAMES, regionOfProvider } from './adapter.ts'
import { probeModel, probeUserMessage, type QoderProbeClient, type QoderProbeError } from './probe.ts'
import {
  registerQoderWebRoutes,
  type QoderPoolDeps,
  type QoderAccountDeps,
  type QoderAccountEntryLike,
  type QoderAccountValidationDeps,
  type QoderSettingsDeps,
  type QoderTransferDeps,
} from './web-status.ts'
import {
  QODER_SETTINGS_NS,
  QODER_GITHUB_URL,
  QODER_REGIONS,
  unwrapVolatileDeep,
  type QoderWebProbeResult,
  type QoderWebProbeOutcome,
  type QoderWebPoolTestRow,
  type QoderWebPoolCheckinRow,
  type QoderWebCredits,
  type QoderWebCreditPackage,
  type QoderWebAccountCredit,
  type QoderWebRecovery,
} from './status-paths.ts'
import { qoderAccountId, maskPat, patFromEnv } from './credentials.ts'
import { QoderAccountStore, type QoderStoredAccount } from './accounts.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import {
  rankPool,
  resolveTargetModel,
  type QoderPoolCredits,
  type QoderPoolProbe,
  type QoderPoolMember,
} from './account-pool.ts'
import { readPoolProbes, writePoolProbes } from './account-pool-store.ts'
import { testAllAccounts, POOL_BATCH_GAP_MS, type QoderPoolRunnerDeps } from './account-pool-run.ts'
import { resolveCredentialRecovery, createAccountUsabilityProbe, type QoderProbeStore } from './credential-recovery.ts'
import { writeHostHeartbeat, clearHostHeartbeat } from './host-heartbeat.ts'

export { QODER_CONNECT_VERSION }
export { QODER_GITHUB_URL }

// ---------------------------------------------------------------------------
// 标识与注入
// ---------------------------------------------------------------------------

export const name = 'dsh-connect-qoder'

/** The model registry and settings service required before providers register. */
export const inject = ['llm', 'settings']

/** The namespace the HOST actually serves this plugin under (workbuddy probe). */
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

/** Unwrap a schemastery volatile's reactive `.get()` into a plain snapshot. */
export function unwrapVolatile<T>(value: T): T {
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
  /**
   * 该模型声明的思考强度档位（`['xhigh','low','medium']` 之类，已按强度升序）。
   *
   * 必须在这里声明，否则 zod 解析保存的 `lastCatalog` 时会**静默剥掉**它 ——
   * 客户端明明写进了 payload，宿主读回来却没有，思考强度选择器于是整个不渲染
   * （用户实拍「拉取的思考模式又不见了」）。`contextTiers` 同理：它在客户端被
   * 写入，但同样没被声明，于是上下文预算选择器也会随之失效。
   */
  thinkingEfforts: z.array(z.string()).required(false),
  defaultThinkingEffort: z.string().required(false),
  contextTiers: z.array(z.number()).required(false),
})

const poolConfig = z.object({
  enabled: z.boolean().default(false),
  targetModelId: z.string().default(''),
  probeInputTokens: z.number().default(0),
  memberAccountIds: z.array(z.string()).default([]),
})

const regionConfig = z.object({
  /** 本区域 PAT。留空读环境变量；env 与 vault 承接连带选择。 */
  pat: z.string().default('').description('Qoder PAT（留空时读取环境变量）'),
  /** 本区域 provider 是否启用；显式 false 才停用（opt-out）。 */
  enabled: z.boolean().default(true),
  /** 用户显式选择的账号 id（'' = 自动：settings → env → vault）。 */
  accountId: z.string().default(''),
  /** 是否在主界面展示积分（composer 面板）；opt-out。 */
  showCreditsInMainUi: z.boolean().default(true),
  /** 用户勾选的模型 key 集合。 */
  enabledModelKeys: z.array(z.string()).default([]),
  /**
   * 用户**显式**开启图片输入的模型 key 集合。
   *
   * 图像能力只来自这里，绝不从上游的 `is_vl` 平台标记推断（见
   * src/native-modality.ts：平台标记几乎对每个模型都是 true，含纯文本模型）。
   * 与 lastCatalog 分开存储，使勾选状态不随目录重写而耦合丢失。
   */
  imageModelKeys: z.array(z.string()).default([]),
  /** 用户关闭的模型 key 集合（独立于硬性关闭）。 */
  offModelKeys: z.array(z.string()).default([]),
  /** 每个模型的显式上下文预算（必须是模型声明的 tier，否则用原生值）。 */
  contextBudgets: z.dict(z.number()).default({}),
  /**
   * 每个模型保存的思考强度（档位名，如 `low` / `medium` / `xhigh`）。
   *
   * 「设置里选好、之后每个请求自动带上」——与 Qoder 客户端同形态（它的事件
   * 名就叫 `reasoning-effort-changed`）。缺省表示用模型自己声明的默认档。
   * 键是模型 key：不同模型的档位名不统一（Qwen 系 low/medium/xhigh，
   * DeepSeek/GLM 系 low/high/max），所以必须逐模型存。
   */
  thinkingEfforts: z.dict(z.string()).default({}),
  /** 账号池偏好。 */
  pool: poolConfig.default({ enabled: false, targetModelId: '', probeInputTokens: 0, memberAccountIds: [] }),
  /** 保存的模型目录（卡片“保存”时写入）。 */
  lastCatalog: z.array(modelConfig).default([]),
})

export interface Config {
  regions: Record<string, unknown>
}

export const Config: z<Config> = z.object({
  regions: asVolatile(z.dict(regionConfig).default({}).description('Per-region Qoder settings, keyed cn | global')),
}) as unknown as z<Config>

/** 某区域的配置状态（缺省返回空对象）。 */
export function regionStateOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): Record<string, unknown> {
  const regions = unwrapVolatile(config.regions) as Record<string, unknown> | undefined
  const stored = regions?.[region]
  if (stored !== undefined && stored !== null && typeof stored === 'object') return stored as Record<string, unknown>
  return {}
}

/** 某区域是否启用（opt-out）。 */
export function regionEnabled(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): boolean {
  const state = regionStateOf(config, region)
  return state.enabled !== false
}

/** 某区域是否在主界面显示积分（opt-out）。 */
function regionCreditsShown(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): boolean {
  const state = regionStateOf(config, region)
  return state.showCreditsInMainUi !== false
}

/** 某区域是否配置了凭据（设置 PAT 或环境变量其一）。 */
export function regionHasCredential(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): boolean {
  const state = regionStateOf(config, region)
  const pat = typeof state.pat === 'string' ? state.pat.trim() : ''
  if (pat !== '') return true
  return patFromEnv(region) !== undefined
}

/** 某区域显式选择的账号 id（undefined = 自动）。 */
function selectedAccountId(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): string | undefined {
  const state = regionStateOf(config, region)
  const id = state.accountId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 某区域保存的 contextBudgets。 */
function contextBudgetsOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): Record<string, number> {
  const state = regionStateOf(config, region)
  const raw = state.contextBudgets
  if (raw === null || raw === undefined || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** 某区域保存的 offModelKeys。 */
function offModelKeysOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): readonly string[] {
  const state = regionStateOf(config, region)
  return Array.isArray(state.offModelKeys) ? (state.offModelKeys as string[]) : []
}

/** 某区域保存的逐模型思考强度（模型 key → 档位名）。 */
function thinkingEffortsOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): Record<string, string> {
  const state = regionStateOf(config, region)
  const raw = state.thinkingEfforts
  if (raw === null || raw === undefined || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** 某区域保存的 imageModelKeys（用户显式开启图片输入的模型）。 */
function imageModelKeysOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): readonly string[] {
  const state = regionStateOf(config, region)
  return Array.isArray(state.imageModelKeys) ? (state.imageModelKeys as string[]) : []
}

/**
 * 把用户的**显式**图片 opt-in 盖印到模型列表上——这是 `supportsImages`
 * 在运行时的**唯一**来源，上游的 `is_vl` 平台标记一律不采信。
 *
 * 与 workbuddy 的 `withImageSelection` 同构：所有运行时目录路径（启动种子、
 * 刷新、保存）都经过它，保证同一模型在三条路径上得到一致的图像能力答案。
 * 用户从未保存过（集合为空）时，用 `imageDefaultFor` 的厂商表结论作种子，
 * 使首次打开就能显示正确默认，而不必先保存一次。
 */
function withImageSelection(
  models: QoderModelInfo[],
  images: ReadonlySet<string>,
  seeded: boolean,
): QoderModelInfo[] {
  return models.map(model => ({
    ...model,
    supportsImages: images.has(model.key)
      ? true
      : seeded
        ? false
        : imageDefaultFor({ id: model.key, ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }) }),
  }))
}

/**
 * 把用户保存的「可关闭思考」选择盖印到运行时目录上。
 *
 * 上游声明的 `canDisableThinking` 并不可全信（见 src/off-thinking.ts）。运行时
 * 适配器只读模型自报的该字段，所以必须在此之前把校正后的答案写上去。用户尚未
 * 保存过（选择为空）时用 `defaultOffModelIds` 作为种子——只对上游显式声明可关闭、
 * 且不在已知拒绝集里的模型提供 off。
 */
function stampOffSelection(
  config: { regions?: Record<string, unknown> | null },
  region: QoderRegion,
  models: QoderModelInfo[],
): QoderModelInfo[] {
  const saved = new Set(offModelKeysOf(config, region))
  const selection = saved.size > 0
    ? saved
    : new Set(defaultOffModelIds(models.map(offCapabilityOf)))
  return withEffectiveOff(models, selection)
}

/**
 * 把用户的两项显式选择（图片输入、可关闭思考）盖印到运行时目录上。
 *
 * 两者机制相同：上游声明不可全信，用户的选择是唯一权威；未保存过时用厂商表/
 * 内置规则作种子。合在一处便于所有运行时目录路径（启动、刷新、保存）一次盖齐，
 * 避免漏盖导致「某条路径上模型能力与另一条不一致」。
 */
function stampRuntimeCatalog(
  config: { regions?: Record<string, unknown> | null },
  region: QoderRegion,
  models: QoderModelInfo[],
): QoderModelInfo[] {
  const images = new Set(imageModelKeysOf(config, region))
  const withImages = withImageSelection(models, images, images.size > 0)
  return stampOffSelection(config, region, withImages)
}

/** 某区域保存的 enabledModelKeys。 */
function enabledModelKeysOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): readonly string[] {
  const state = regionStateOf(config, region)
  return Array.isArray(state.enabledModelKeys) ? (state.enabledModelKeys as string[]) : []
}

/** 某区域保存的 pool 偏好。 */
function poolPreferencesOf(config: { regions?: Record<string, unknown> | null }, region: QoderRegion): {
  enabled: boolean
  targetModelId: string
  probeInputTokens: number
  memberAccountIds: readonly string[]
} {
  const state = regionStateOf(config, region)
  const raw = (state.pool ?? {}) as Record<string, unknown>
  return {
    enabled: raw.enabled === true,
    targetModelId: typeof raw.targetModelId === 'string' ? raw.targetModelId : '',
    probeInputTokens: typeof raw.probeInputTokens === 'number' ? raw.probeInputTokens : 0,
    memberAccountIds: Array.isArray(raw.memberAccountIds) ? (raw.memberAccountIds as string[]) : [],
  }
}

/** 把保存的目录条目解析为模型信息（历史兼容）。 */
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
    ...Array.isArray(raw.contextTiers) ? { contextTiers: (raw.contextTiers as unknown[]).filter((v): v is number => typeof v === 'number') } : {},
    // 思考强度档位：从保存的目录里读回来，否则重启后模型行不再显示档位选择器。
    ...Array.isArray(raw.thinkingEfforts) && raw.thinkingEfforts.length > 0
      ? { thinkingEfforts: (raw.thinkingEfforts as unknown[]).filter((v): v is string => typeof v === 'string') }
      : {},
    ...typeof raw.defaultThinkingEffort === 'string' && raw.defaultThinkingEffort !== ''
      ? { defaultThinkingEffort: raw.defaultThinkingEffort }
      : {},
  }
}

/** 某区域当前应展示的目录（保存 → 运行期 → fallback）。 */
function configuredModels(
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

/** 把一次用量解析成卡片可渲染的积分包。 */
function creditsOf(usage: QoderUsage): QoderWebCredits {
  const packages: QoderWebCreditPackage[] = []
  let total = 0
  let expiringSoon = 0
  let nearestExpiryMs: number | undefined
  const SOON_MS = 3 * 24 * 3600 * 1000

  const add = (packageName: string, remaining: number, size: number, expiresAtMs?: number): void => {
    if (size <= 0) return
    total += remaining
    if (expiresAtMs !== undefined && remaining > 0) {
      nearestExpiryMs = nearestExpiryMs === undefined ? expiresAtMs : Math.min(nearestExpiryMs, expiresAtMs)
      if (expiresAtMs - Date.now() < SOON_MS) expiringSoon += 1
    }
    packages.push({
      packageName,
      remain: remaining,
      size,
      monthly: false,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    })
  }

  const userQuota = usage.userQuota
  if (userQuota !== undefined && typeof userQuota.total === 'number') {
    add('base', Math.max(userQuota.total - (userQuota.used ?? 0), 0), userQuota.total)
  }
  const addOnQuota = usage.addOnQuota
  if (addOnQuota !== undefined && typeof addOnQuota.total === 'number') {
    add('addon', Math.max(addOnQuota.total - (addOnQuota.used ?? 0), 0), addOnQuota.total, usage.expiresAt)
  }
  const org = usage.orgResourcePackage
  if (org !== undefined && typeof org.cap === 'number') {
    add('org', Math.max(org.cap - (org.used ?? 0), 0), org.cap)
  }

  return {
    total,
    packages,
    expiringSoon,
    ...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }),
  }
}

interface QoderRegionStack {
  upstream: QoderUpstreamClient
  catalog: QoderCatalog
  shim: QoderShim
  store: QoderAccountStore
  probeClient: QoderProbeClient
  adapter?: QoderAdapter
  /** Runtime probe store (batch tests + live failures), mirrors the disk store. */
  poolRuntime: Record<string, QoderPoolProbe>
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: Config): void {
  const settingsNs = settingsNamespaceOf(ctx)
  const log = (message: string): void => ctx.logger.warn(`dsh-connect-qoder: ${message}`)
  let stopped = false

  const stacks = {} as Record<QoderRegion, QoderRegionStack>
  const usageCache: Partial<Record<QoderRegion, { usage: QoderUsage | undefined; atMs: number; error?: string }>> = {}
  const registration: Record<QoderRegion, { adapter?: AdapterRegistrationHandle, directory?: DirectoryRegistrationHandle }> = { cn: {}, global: {} }
  /**
   * 今日签到状态快照（区域 → 成员 id → 是否已领）。签到批次回写、成员表读取。
   * 进程内即可：它描述的是「今天」，重启后由下一次签到重新写入。
   */
  const checkinState: Record<QoderRegion, Record<string, boolean>> = { cn: {}, global: {} }

  /**
   * 每区域最近一次**实时**拉到的完整目录（含上游声明的思考档位），未过滤。
   *
   * 为什么要单独存：`stacks[region].catalog` 装的是**过滤后**（只含勾选模型）
   * 的运行时目录，卡片不能用它；而保存的 `lastCatalog` 可能是**旧快照**，
   * 上游新声明的思考档位会缺失（用户实拍「还是没有思考强度」——即使刚刚
   * 「从 Qoder 刷新」成功过，卡片读的仍是那份没有档位的旧快照）。
   * 实时目录优先于保存快照，才能反映上游当前声明了什么。
   */
  const fullCatalog: Record<QoderRegion, readonly QoderModelInfo[]> = { cn: [], global: [] }

/**
 * 卡片展示用的模型列表（workbuddy 的 `displayModels` 同规）。
 *
 * 与运行时目录（`stacks[region].catalog`）的区别只有一条，但它是关键：
 * **运行时目录只含用户勾选的模型**（DSH 的选择器读它），而卡片必须看到**完整
 * 目录**，否则未勾选的模型根本不出现在卡片里，用户再也勾不上它们。
 *
 * 三步优先序与 workbuddy 一致：上次保存的目录 → 实时目录 → 静态兜底。用保存的
 * 快照优先，是为了让卡片重新读取的是**当前**目录而不是过期的旧快照（issue #32
 * 的教训：保存槽位丢了目录时，必须显示实时目录，否则卡片会把用户正在用的模型
 * 报成「已下架」）。
 */
function displayModels(
  config: { regions?: Record<string, unknown> | null },
  region: QoderRegion,
): readonly QoderModelInfo[] {
  // 实时目录优先：它反映上游**当前**声明了什么（含思考档位），而保存的
  // lastCatalog 是上一次保存时的快照 —— 上游新增或修正档位后，快照里没有，
  // 卡片就一直不渲染档位选择器（用户实拍「还是没有思考强度」）。
  const live = fullCatalog[region].length > 0
    ? fullCatalog[region]
    : stacks[region].catalog.current()
  if (live.length > 0) return live
  const state = regionStateOf(config, region)
  if (Array.isArray(state.lastCatalog) && state.lastCatalog.length > 0) {
    const parsed = state.lastCatalog
      .map(item => modelFromStored((item ?? {}) as Record<string, unknown>))
      .filter((m): m is QoderModelInfo => m !== undefined)
    if (parsed.length > 0) return parsed
  }
  return QODER_FALLBACK_MODELS.map(fallbackModelInfo)
}

  let invalidateCatalog = (): void => {}

  // 每个区域：上游客户端 + 回环 shim + vault store + 池运行期。
  for (const region of QODER_REGIONS) {
    const upstream = new QoderUpstreamClient(region, { logger: log })
    const catalog = new QoderCatalog(QODER_FALLBACK_MODELS.map(fallbackModelInfo))
    const store = new QoderAccountStore(region)
    let poolRuntime: Record<string, QoderPoolProbe> = {}
    void readPoolProbes(region).then(probes => { poolRuntime = probes })

    const shim = createQoderShim({
      upstream,
      credential: () => resolveServingPat(region),
      modelKeyOf: selector => catalog.keyOf(selector),
      supportsImagesOf: selector => catalog.supportsImagesOf(selector),
      // 设置里为这个模型保存的思考强度（模型选择器名 → 档位名）。目录换代后
      // 旧 key 自然失配（返回 undefined），请求退回模型默认档，不需要额外清理。
      reasoningEffortOf: selector => {
        const key = catalog.keyOf(selector)
        if (key === undefined) return undefined
        return thinkingEffortsOf(config, region)[key]
      },
      logger: log,
      resolveServing: async () => {
        const serving = await resolveServing(region)
        return serving === undefined
          ? undefined
          : { accountId: serving.id, accountName: serving.accountName, pat: serving.pat }
      },
      failoverAccount: async tried => nextFailoverCredential(region, tried),
      onServingFailure: (accountId, kind, _message) => {
        const outcome = FAIL_OVER_OUTCOME[kind]
        if (outcome !== undefined && accountId !== '') {
          poolRuntime[accountId] = { outcome, atMs: Date.now(), source: 'live-request' }
          void writePoolProbes(region, { [accountId]: poolRuntime[accountId]! })
          log(`pool ${region}: ${maskPat(accountId)} marked ${outcome} by live request`)
        }
      },
      poolServingNotice: accountId => {
        const selected = selectedAccountId(config, region)
        return selected === accountId ? undefined : `将由账号 ${maskPat(accountId)} 回答本次问题`
      },
    })

    stacks[region] = { upstream, catalog, shim, store, probeClient: buildProbeClient(region), poolRuntime }
  }

  /** The region's source PATs (settings + env). */
  function sourcesOf(region: QoderRegion): { settingsPat?: string | undefined, envPat?: string | undefined } {
    const state = regionStateOf(config, region)
    const settingsPat = typeof state.pat === 'string' ? (state.pat as string).trim() : ''
    const envPat = patFromEnv(region)
    return {
      ...settingsPat === '' ? {} : { settingsPat },
      ...envPat === undefined ? {} : { envPat },
    }
  }

  /** The region's auto-resolved serving PAT (settings → env). Vault is async. */
  function resolveServingPat(region: QoderRegion): string | undefined {
    const sources = sourcesOf(region)
    if (sources.settingsPat) return sources.settingsPat
    if (sources.envPat) return sources.envPat
    return undefined
  }

  /** Full serving credential via the store (honors selection + vault). */
  async function resolveServing(region: QoderRegion): Promise<
    { id: string, pat: string, accountName: string, source: 'settings' | 'env' | 'vault' } | undefined
  > {
    return stacks[region].store.resolve(sourcesOf(region), selectedAccountId(config, region))
  }

  /** Next usable PAT for failover: rankPool over members, skip tried. */
  async function nextFailoverCredential(region: QoderRegion, tried: readonly string[]): Promise<QoderServingAccount | undefined> {
    const store = stacks[region].store
    const memberIds = poolPreferencesOf(config, region).memberAccountIds
    const probes = stacks[region].poolRuntime
    const now = Date.now()
    // 请求路径不能上网，积分取卡片路由写入的快照（workbuddy 的 creditsSnapshot
    // 同规）：新鲜时用真实余额参与排名，过期则退回「只有探针」的排名。
    const fresh = now - (poolCreditsSnapshotAt[region] ?? 0) <= POOL_CREDITS_SNAPSHOT_MS
    const snapshot = fresh ? poolCreditsSnapshot[region] : undefined
    const candidates: QoderPoolMember[] = []
    for (const accountId of memberIds) {
      if (tried.includes(accountId)) continue
      const credit = await store.credentialFor(accountId, sourcesOf(region))
      if (credit === undefined) continue
      const probe = probes[accountId]
      const reading = snapshot?.get(accountId)
      candidates.push({
        account: { id: credit.id, accountName: credit.accountName },
        ...reading === undefined ? {} : { credits: reading },
        ...probe === undefined ? {} : { probe },
      })
    }
    const chosen = rankPool(candidates, now)[0]
    if (chosen === undefined || chosen.excludedBy !== undefined) return undefined
    const credit = await store.credentialFor(chosen.account.id, sourcesOf(region))
    return credit === undefined ? undefined : { accountId: credit.id, accountName: credit.accountName, pat: credit.pat }
  }

  /** 成员积分快照：请求路径不能上网，排名用卡片路由最近一次的读数。 */
  const poolCreditsSnapshot: Partial<Record<QoderRegion, ReadonlyMap<string, QoderPoolCredits>>> = {}
  const POOL_CREDITS_SNAPSHOT_MS = 10 * 60_000
  const poolCreditsSnapshotAt: Partial<Record<QoderRegion, number>> = {}

  /**
   * 池成员的最新积分（每成员一次 usage 读数）。由卡片路由付费——卡片正在看的
   * 数字与排名快照同一次读取（workbuddy 的 poolMembersOf 同规），单个账号失败
   * 只让那一行显示「—」，不拖垮整张表。
   */
  async function poolMemberCredits(region: QoderRegion, accountIds: readonly string[]): Promise<ReadonlyMap<string, QoderPoolCredits>> {
    const store = stacks[region].store
    const SOON_MS = 3 * 24 * 3600 * 1000
    const entries = await Promise.all(accountIds.map(async accountId => {
      const credit = await store.credentialFor(accountId, sourcesOf(region)).catch(() => undefined)
      if (credit === undefined) return undefined
      const usage = await stacks[region].upstream.fetchUsage(credit.pat).catch(() => undefined)
      if (usage === undefined) return undefined
      const view = creditsOf(usage)
      const expiringSoon = view.packages.reduce(
        (sum, pkg) => pkg.expiresAtMs !== undefined && pkg.expiresAtMs - Date.now() < SOON_MS ? sum + pkg.remain : sum,
        0,
      )
      return [accountId, {
        total: view.total,
        expiringSoon,
        ...(view.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: view.nearestExpiryMs }),
      }] as const
    }))
    const map = new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined))
    poolCreditsSnapshot[region] = map
    poolCreditsSnapshotAt[region] = Date.now()
    return map
  }

  /** A probe client for one region backed by chatStream. */
  function buildProbeClient(region: QoderRegion): QoderProbeClient {
    return {
      probeChat: async (credential, modelKey, opts) => {
        let firstBytes = 0
        let error: QoderUpstreamError | undefined
        try {
          await stacks[region].upstream.chatStream(credential.pat, modelKey, [
            { role: 'user', content: probeUserMessage(opts.inputTokens) },
          ], {
            ...opts.signal === undefined ? {} : { signal: opts.signal },
            isReasoning: false,
            isVl: false,
            onDelta: (delta: QoderChatDelta) => {
              // 探针只关心“有没有吐出首包”。
              if (firstBytes === 0) firstBytes = cheapProbeLength(delta)
            },
          })
        } catch (caught: unknown) {
          if (isQoderUpstreamError(caught)) error = caught
          else throw caught
        }
        if (error !== undefined) {
          const probeError: QoderProbeError = { kind: error.kind, status: error.status, message: error.message }
          return {
            ok: false,
            status: error.status,
            retryAfter: null,
            body: error.message,
            error: probeError,
          }
        }
        return { ok: true, status: 200, retryAfter: null }
      },
    }
  }

  /** Cheap text length of a delta for probe first-byte accounting. */
  function cheapProbeLength(delta: QoderChatDelta): number {
    let length = delta.content.length
    if (delta.reasoningContent.length > 0) length += delta.reasoningContent.length
    if (delta.toolCalls !== undefined) length += delta.toolCalls.length
    return length
  }

  /** One real probe of one model through one credential. Never throws. */
  async function probeThrough(region: QoderRegion, credential: { pat: string, accountName: string }, modelId: string, signal?: AbortSignal): Promise<QoderWebProbeResult> {
    return probeModel({
      client: stacks[region].probeClient,
      credential,
      modelKey: modelId,
      nowMs: Date.now(),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /**
   * 对一个区域勾选的成员逐个签到（领取当日 Credits）。
   *
   * 与 `test` 批次同构：只跑**真的有凭据**的成员（幽灵 id 跳过，见 test 里那段
   * 注释），逐个之间留间隔避免撞限流。每个成员独立成败——一个账号失败不影响
   * 其余账号，结果逐行回报（workbuddy 的 checkin 批次同规）。
   *
   * 三种状态分得很清：`claimed`（这次领到）/ `already`（今天已领，幂等，
   * **不是**失败）/ `failed`（真的失败：凭据被拒、上游报错）。
   */
  async function runCheckinBatch(region: QoderRegion): Promise<QoderWebPoolCheckinRow[]> {
    const store = stacks[region].store
    const prefs = poolPreferencesOf(config, region)
    const client = stacks[region].upstream
    const rows: QoderWebPoolCheckinRow[] = []
    let first = true
    for (const accountId of prefs.memberAccountIds) {
      const credit = await store.credentialFor(accountId, sourcesOf(region))
      if (credit === undefined) continue
      if (!first) await new Promise(resolve => setTimeout(resolve, POOL_BATCH_GAP_MS))
      first = false
      const base = { accountId, accountName: credit.accountName }
      try {
        const outcome = await client.claimDailyCredits(credit.pat)
        if (outcome.status === 'claimed') {
          rows.push({
            ...base,
            status: 'claimed',
            ...(outcome.amount === undefined ? {} : { credit: outcome.amount }),
            ...(outcome.validityDays === undefined ? {} : { validityDays: outcome.validityDays }),
          })
        } else if (outcome.status === 'already-claimed') {
          rows.push({ ...base, status: 'already' })
        } else {
          rows.push({ ...base, status: 'failed', message: outcome.message })
        }
      } catch (error: unknown) {
        rows.push({ ...base, status: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    }
    // 把结果写进快照：成员表据此显示「已签到 / 未签到」。
    // `claimed` 与 `already` 都算「今天已领」——两者的区别只对**本次操作**有意义
    // （领到了 vs 早就领过），对「今天是否已签到」这个事实没有区别。
    const next = { ...(checkinState[region] ?? {}) }
    for (const row of rows) {
      if (row.status === 'claimed' || row.status === 'already') next[row.accountId] = true
      else if (row.status === 'failed') next[row.accountId] = false
    }
    checkinState[region] = next
    // 签到会改变积分余额：必须**重新拉一次**，否则这个区域的积分会一直停在签到
    // 前的数字，直到某个**与签到无关**的动作（改配置 / 点「从 Qoder 刷新」）
    // 顺带触发 `refreshUsage` —— 用户看到的就是「我领了积分，但积分没刷新」
    // （用户实拍）。此前这里只 `delete usageCache[region]`：作废了缓存却没有
    // 任何人来重新填充它，等于把「读到新值」这件事推给了一个不会到来的下一次
    // 无关动作。
    //
    // **await 而非 fire-and-forget**：客户端在收到签到响应后立刻调 `onChanged()`
    // 重新读一次 usage（`AccountPool.runCheckinBatch` 末尾）。若这里不等待，
    // 这次重读会发生在上游返回之前、读到刚被作废的空缓存，积分仍然不刷新 ——
    // 竞态，而不是修复。
    //
    // 失败不影响签到本身：结果已经如实回报给用户了，积分补读失败只是这一格数字
    // 没更新，下一次轮询会再试。
    await refreshUsage(region).catch(() => {})
    return rows
  }

  /** Cached usage read for one region. */
  function usageEntryOf(region: QoderRegion): { usage?: { credits: QoderWebCredits, atMs: number }, error?: string } | undefined {
    const entry = usageCache[region]
    if (entry === undefined) return undefined
    return {
      ...(entry.usage === undefined ? {} : { usage: { credits: creditsOf(entry.usage), atMs: entry.atMs } }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }

  const refreshUsage = async (region: QoderRegion): Promise<void> => {
    const serving = await resolveServing(region)
    if (!serving) return
    try {
      const usage = await stacks[region].upstream.fetchUsage(serving.pat)
      usageCache[region] = { usage, atMs: Date.now() }
    } catch (error: unknown) {
      // `auth` 必须记为 `credential-rejected`，不能塞一个笼统的 kind 字符串：
      // 卡片只认这三个字来渲染「凭据被拒」区块（以及切换到可用账号的按钮）。
      // 过期 PAT 此前既没有积分、也没有任何提示，就是这一步把错误吞成了
      // 「无数据」。其他 kind 原样保留，卡片按普通错误行显示上游原文。
      const kind = isQoderUpstreamError(error) ? error.kind : undefined
      usageCache[region] = {
        usage: undefined,
        atMs: Date.now(),
        error: kind === 'auth' ? 'credential-rejected' : (kind ?? 'unknown'),
      }
    }
  }

  /** The region's catalog projected into the pool target picker's shape. */
  function poolModelsOf(region: QoderRegion): Array<{ id: string, name: string, creditMultiplier?: number, contextWindow: number }> {
    return stacks[region].catalog.current().map(m => ({
      id: m.key,
      name: m.displayName,
      // 「免费即 0」是 resolveTargetModel 的契约；付费模型透传真实倍率，与
      // web-status 的两处投影同规则。
      creditMultiplier: m.isFree === true ? 0 : m.priceFactor,
      contextWindow: m.contextWindow,
    }))
  }

  // -------------------------------------------------------------------------
  // 目录 / 注册同步
  // -------------------------------------------------------------------------

  /** On-demand model read for discovery + refresh. */
  async function discoverModels(region: QoderRegion, signal?: AbortSignal): Promise<QoderModelInfo[]> {
    const serving = await resolveServing(region)
    if (!serving) return []
    const upstream = await stacks[region].upstream.fetchModels(serving.pat, signal)
    const parsed = upstream.map(parseUpstreamModel)
    return applyContextBudgets(parsed, contextBudgetsOf(config, region))
  }

  /**
   * 拉取并安装一个区域的动态目录。返回安装后的目录；拉取失败抛错——
   * 路由层据此答 500，启动路径自己吞掉落回兜底目录。
   */
  async function refreshRegionCatalog(region: QoderRegion, pat: string): Promise<QoderModelInfo[]> {
    const upstream = await stacks[region].upstream.fetchModels(pat)
    const parsed = upstream.map(parseUpstreamModel)
    const withTiers = applyContextBudgets(parsed, contextBudgetsOf(config, region))
    const stamped = stampRuntimeCatalog(config, region, withTiers)
    // 运行时目录 = **只含勾选的模型**（workbuddy 同规）。DSH 的选择器通过适配器的
    // `getModels()` 读它，所以这里过滤才是「选择器只列出我勾的那些」真正生效的地方。
    // 卡片另走 `displayModels()`（完整目录），否则未勾选的模型会从卡片里消失、
    // 用户再也勾不上——两个视图分开正是 workbuddy 的做法。
    const saved = new Set(enabledModelKeysOf(config, region))
    // 完整目录（含上游声明的思考档位）另存一份给卡片；运行时目录只留勾选的。
    // 两者必须分开：卡片要看到未勾选的模型才勾得上，而档位信息只有实时目录里
    // 才有（保存的 lastCatalog 可能是旧快照，甚至被旧 schema 剥掉档位字段）。
    fullCatalog[region] = stamped
    stacks[region].catalog.set(deriveCatalog(stamped, saved))
    invalidateCatalog()
    return stamped
  }

  /**
   * 路由层（卡片「从 Qoder 刷新」按钮）用的完整刷新：装目录 + 刷积分。
   * 此前的路由只调只读的 discoverModels——返回了新模型给卡片，却从不写入
   * 运行时目录，卡片随后重取 usage 文档看到的仍是旧目录，刷了个寂寞。
   */
  async function refreshRegionForRoute(region: QoderRegion): Promise<QoderModelInfo[]> {
    const serving = await resolveServing(region)
    if (!serving) throw new Error(`no PAT configured for ${region}`)
    const models = await refreshRegionCatalog(region, serving.pat)
    void refreshUsage(region)
    return models
  }

  const refreshModels = (region: QoderRegion): void => {
    void (async () => {
      const serving = await resolveServing(region)
      if (!serving) {
        log(`models refresh skipped for ${region}: no PAT configured`)
        return
      }
      try {
        await refreshRegionCatalog(region, serving.pat)
      } catch (error: unknown) {
        log(`dynamic ${region} model catalog unavailable; serving the static fallback list: ${String((error as Error)?.message ?? error)}`)
      }
      // 积分与目录独立成败：目录拉取失败绝不能拖死积分——此前 refreshUsage
      // 链在目录成功的分支里，目录一挂积分永远不来，卡片上「看不到积分」。
      void refreshUsage(region)
    })()
  }

  const syncRegionRegistration = (value: Config): void => {
    for (const region of QODER_REGIONS) {
      const enabled = regionEnabled(value, region)
      const handle = registration[region].adapter
      if (handle === undefined) continue
      try {
        handle.replace(enabled ? [QODER_PROVIDERS[region]] : [])
      } catch (error: unknown) {
        log(`region ${region} adapter sync failed: ${String((error as Error)?.message ?? error)}`)
      }
    }
    const dirHandle = registration.cn.directory
    if (dirHandle === undefined) return
    try {
      dirHandle.replace(QODER_REGIONS
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
    for (const region of QODER_REGIONS) {
      const full = configuredModels(value, region, stacks[region].catalog.current())
      const withTiers = applyContextBudgets(full, contextBudgetsOf(value, region))
      const stamped = stampRuntimeCatalog(value, region, withTiers)
      // **必须在这里也过滤**：`applySelection` 在每次配置写入时跑，它若把完整
      // 目录重新装回运行时目录，就会覆盖 refreshRegionCatalog 的过滤结果——
      // 这正是「保存了模型，选择器里还是一整份」的原因（用户实拍两次）。
      // 运行时目录只含勾选的；完整目录由 displayModels() 供卡片。
      const saved = new Set(enabledModelKeysOf(value, region))
      stacks[region].catalog.set(deriveCatalog(stamped, saved))
    }
    invalidateCatalog()
    syncRegionRegistration(value)
    for (const region of QODER_REGIONS) void refreshUsage(region)
  }

  applySelection(config)

  // -------------------------------------------------------------------------
  // web-status deps
  // -------------------------------------------------------------------------

  const accountDeps = (region: QoderRegion): QoderAccountDeps => {
    const store = stacks[region].store
    return {
      accounts: sources => store.accounts(sources ?? sourcesOf(region)),
      credentialFor: (accountId, sources) => store.credentialFor(accountId, sources ?? sourcesOf(region)),
      resolve: (sources, selectedId) => store.resolve(sources ?? sourcesOf(region), selectedId ?? selectedAccountId(config, region)),
      add: (pat, name) => store.add(pat, name),
      vaultAccounts: () => store.vaultAccounts(),
      remove: accountId => store.remove(accountId),
      rename: (accountId, name) => store.rename(accountId, name),
    }
  }

  const accountValidationDeps: QoderAccountValidationDeps = {
    validateForRegion: async (region, pat) => {
      const job = await stacks[region].upstream.exchangeJobToken(pat)
      return { name: job.name || '' }
    },
  }

  /** Region-dispatch table for the single pool deps the route gets. */
  function poolFor(region: QoderRegion): QoderPoolDeps {
    const store = stacks[region].store
    return {
      preferences: reg => poolPreferencesOf(config, reg),
      catalog: reg => stacks[reg].catalog.current(),
      poolProbes: reg => stacks[reg].poolRuntime,
      credentialFor: (reg, accountId) => store.credentialFor(accountId, sourcesOf(reg)),
      probeOne: (reg, credit, modelId) => probeThrough(reg, credit, modelId),
      // 两个区域**都有**每日签到（sash 的 campaigns 活动，已实测）。
      // 差别只在认证细节：国际版额外需要设备风控头（本机 UMID 组件的三件套），
      // 由 upstream 按 region 条件附加（见 QoderRegionConfig.requiresDeviceRisk）。
      // 本机没有 Qoder 客户端（取不到组件）时，签到会在读取那一步如实报错，
      // 而不是把「取不到设备身份」伪装成「今天没有活动」。
      checkinSupported: () => true,
      checkin: async reg => runCheckinBatch(reg),
      test: async reg => {
        const prefs = poolPreferencesOf(config, reg)
        const target = resolveTargetModel(poolModelsOf(reg), prefs.targetModelId)
        if (target.modelId === undefined) return []
        const deps: QoderPoolRunnerDeps = {
          credentialFor: accountId => store.credentialFor(accountId, sourcesOf(reg)),
          probe: (credit, modelId) => probeThrough(reg, credit, modelId),
        }
        const targets: Array<{ accountId: string, accountName: string }> = []
        for (const accountId of prefs.memberAccountIds) {
          // 只测**真的还有凭据**的成员。用户的 PAT 被删除后 memberAccountIds
          // 里会留下幽灵 id（配置里的名单不会随 vault 自动收缩），它们既测不出
          // 结果、又会往池里写一条假的「凭据被拒」——用户看到的就是「有 2 个
          // 已保存的账号当前没有可用的 PAT」这种本该自动消失的提示。
          const credit = await store.credentialFor(accountId, sourcesOf(reg))
          if (credit === undefined) continue
          targets.push({ accountId, accountName: credit.accountName })
        }
        const rows = await testAllAccounts(targets, target.modelId, deps)
        const probes: Record<string, QoderPoolProbe> = {}
        for (const row of rows) {
          const p = poolProbeFromResult(row.result)
          if (p) probes[row.accountId] = p
        }
        stacks[reg].poolRuntime = { ...stacks[reg].poolRuntime, ...probes }
        void writePoolProbes(reg, probes)
        return rows
      },
      applyProbes: async (reg, probes) => {
        stacks[reg].poolRuntime = { ...stacks[reg].poolRuntime, ...probes }
        void writePoolProbes(reg, probes)
      },
      updateMembership: (reg, memberAccountIds, enabled) => {
        const next = { ...poolPreferencesOf(config, reg), memberAccountIds, ...(enabled === undefined ? {} : { enabled }) }
        submitRegionSettings(reg, { pool: next })
      },
    }
  }

  function buildPoolDeps(): QoderPoolDeps {
    return {
      preferences: region => poolPreferencesOf(config, region),
      catalog: region => stacks[region].catalog.current(),
      poolProbes: region => stacks[region].poolRuntime,
      memberCredits: (region, accountIds) => poolMemberCredits(region, accountIds),
      credentialFor: (region, accountId) => stacks[region].store.credentialFor(accountId, sourcesOf(region)),
      probeOne: (region, credit, modelId) => probeThrough(region, credit, modelId),
      test: (region, modelId) => poolFor(region).test(region, modelId),
      checkinSupported: region => poolFor(region).checkinSupported(region),
      checkin: region => poolFor(region).checkin!(region),
      checkinState: region => checkinState[region],
      applyProbes: async (region, probes) => poolFor(region).applyProbes(region, probes),
      updateMembership: (region, memberAccountIds, enabled) => poolFor(region).updateMembership(region, memberAccountIds, enabled),
    }
  }

  /** Build the transfer deps once (region-dispatched). */
  const transferDeps: QoderTransferDeps = {
    exportAccounts: async region => {
      // 必须经 transferRecordsFor 投影成 transfer 文件形状（`access_token` /
      // `uid` / `nickname` / `domain`）。此前这里直接吐 vault 原始字段
      // （`pat` / `accountName` / `id`）——**既没有 domain，字段名也不是
      // snake_case**，于是导出物再导入时被区域门整批判 skipped
      // （导出即导入 = 0 条成功）。投影留在 transfer.ts（而非内联在此），
      // 是为了往返回归测试能直接走同一条代码路径。
      const { transferRecordsFor } = await import('./transfer.ts')
      const vault = await stacks[region].store.vaultAccounts()
      return { accounts: transferRecordsFor(region, vault) }
    },
    previewImport: async (_region, text) => {
      const { previewTransferFile } = await import('./transfer.ts')
      return previewTransferFile(text)
    },
    importAccounts: async (region, text, indexes) => {
      const { mergeTransferRecords } = await import('./transfer.ts')
      const { changes, imported, skipped } = mergeTransferRecords(region, text, indexes)
      for (const entry of changes.values()) await stacks[region].store.add(entry.pat, entry.accountName)
      return { imported, skipped }
    },
  }

  // Settings service (0.1.7+ `configure`/`mutate` surface; captured once the
  // optional `settings` service is actually present).
  interface SettingsRow { ns: string, value: Record<string, unknown> }
  interface SettingsShapes {
    describe(): SettingsRow[]
    mutate(ns: string, ops: Array<{ op: 'set', path: string[], value: unknown }>, options?: unknown): Promise<void>
  }
  let settingsService: SettingsShapes | undefined
  const settingsNsOf = settingsNs
  ctx.inject(['settings'], (sctx) => {
    settingsService = (sctx as unknown as { settings?: SettingsShapes }).settings
  })

  const pluginRow = (): SettingsRow | undefined => {
    if (settingsService === undefined) return undefined
    return settingsService.describe().find(row => String(row.ns).includes('dsh-connect-qoder'))
  }

  /**
   * Two-level merge a settings field write, then `mutate` it (workbuddy's
   * `__save` contract, so a partial payload never deletes sibling regions).
   */
  async function mutateField(field: string, incoming: unknown): Promise<void> {
    const row = pluginRow()
    if (row === undefined) throw new Error('settings namespace not yet available')
    const current = unwrapVolatileDeep((row.value?.[field] ?? {}) as unknown) as Record<string, unknown>
    const patch = (incoming ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...current }
    for (const [key, slot] of Object.entries(patch)) {
      const prior = current[key]
      const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
      merged[key] = isPlain(prior) && isPlain(slot) ? { ...prior, ...slot } : slot
    }
    await settingsService!.mutate(row.ns, [{ op: 'set', path: [field], value: merged }], undefined)
  }

  const settingsDeps: QoderSettingsDeps = {
    describe: () => (settingsService === undefined ? [] : settingsService.describe()),
    set: async (field, value) => {
      if (field !== 'regions') throw new Error(`unsupported settings field: ${String(field)}`)
      await mutateField(field, value)
    },
  }

  /** Write one region's settings patch (whole `regions` dict replace). */
  function submitRegionSettings(region: QoderRegion, patch: Record<string, unknown>): void {
    const regions = (unwrapVolatile(config.regions) ?? {}) as Record<string, unknown>
    const next = { ...regions, [region]: { ...((regions[region] as Record<string, unknown>) ?? {}), ...patch } }
    void mutateField('regions', next)
  }

  /** Fresh per-account credit balances for the composer panel. */
  async function accountCreditsOf(region: QoderRegion, signal?: AbortSignal): Promise<QoderWebAccountCredit[]> {
    const store = stacks[region].store
    const accounts = await store.accounts(sourcesOf(region))
    const out: QoderWebAccountCredit[] = []
    for (const account of accounts) {
      const credit = await store.credentialFor(account.id, sourcesOf(region))
      const pat = credit?.pat
      if (!pat) continue
      let usage: QoderUsage | undefined
      try {
        usage = await stacks[region].upstream.fetchUsage(pat, signal)
      } catch {
        usage = undefined
      }
      out.push({
        id: account.id,
        accountName: account.accountName || account.source,
        selected: account.id === selectedAccountId(config, region) || (account.source !== 'vault' && selectedAccountId(config, region) === undefined),
        ...usage === undefined ? {} : { credits: creditsOf(usage).total },
      })
    }
    return out
  }

  /**
   * 凭据被拒后的恢复建议：逐个探测本区域其余账号，只把**真正答过话**的那个
   * 承诺给用户（`credential-recovery.ts` 的实现早就写好了，此前从未接线——
   * 卡片一直用「账号数 ≤ 1」猜，于是对着一条同样过期的记录说「可以切换试试」）。
   */
  async function credentialRecoveryOf(region: QoderRegion, rejectedAccountId: string): Promise<QoderWebRecovery> {
    // 两个组件都要「按区域取到账号与凭据」，共用一份适配器。
    const probeStore = (reg: QoderRegion): QoderProbeStore => ({
      accounts: () => stacks[reg].store.accounts(sourcesOf(reg)).then(list => list.map(a => ({ id: a.id, accountName: a.accountName }))),
      credentialFor: (accountId: string) => stacks[reg].store.credentialFor(accountId, sourcesOf(reg)),
    })
    const probe = createAccountUsabilityProbe({ store: probeStore, client: stacks[region].upstream })
    return resolveCredentialRecovery({ region, store: probeStore(region), rejectedAccountId, probe })
  }

  /** The serving credential for a probe route (region's selection). */
  async function probeModelOf(region: QoderRegion, modelId: string, signal?: AbortSignal): Promise<QoderWebProbeResult> {
    const serving = await resolveServing(region)
    if (!serving) return { modelId, outcome: 'credential-rejected', message: '未配置凭据' }
    return probeThrough(region, { pat: serving.pat, accountName: serving.accountName }, modelId, signal)
  }

  // 宿主存活心跳：卡片用于「存活判定 / 一键不再显示」。
  void writeHostHeartbeat()

  // 浏览器路由（webServer 可选注入；缺失时卡片读镜像即可）。
  ctx.inject(['webServer'], (ctxWithWeb) => {
    registerQoderWebRoutes(ctxWithWeb, {
      regionEnabled: region => regionEnabled(config, region),
      regionCreditsShown: region => regionCreditsShown(config, region),
      regionUsable: (region, usable) => {
        if (!usable) log(`region ${region} is signed out`)
      },
      store: accountDeps,
      credentialSources: sourcesOf,
      selectedAccountId: region => selectedAccountId(config, region),
      // 删除账号后清掉指向它的区域选择：凭据没了，这个选择也没意义了。写 `''`
      // 而不是删键——`''` 就是「自动」，正是 `writeAccountSlot` 在用户选「自动」
      // 时写的那个值，两条路径落到同一状态。
      clearSelection: region => { submitRegionSettings(region, { accountId: '' }) },
      // 卡片读的是**完整目录**（displayModels），不是过滤后的运行时目录。
      catalogs: {
        cn: { current: () => [...displayModels(config, 'cn')] },
        global: { current: () => [...displayModels(config, 'global')] },
      },
      contextBudgets: region => contextBudgetsOf(config, region),
      thinkingEfforts: region => thinkingEffortsOf(config, region),
      offModelKeys: region => offModelKeysOf(config, region),
      imageModelKeys: region => imageModelKeysOf(config, region),
      enabledModelKeys: region => enabledModelKeysOf(config, region),
      discoverModels,
      refreshModels: refreshRegionForRoute,
      usage: usageEntryOf,
      probeModel: probeModelOf,
      accountCredits: accountCreditsOf,
      pool: buildPoolDeps(),
      transfer: transferDeps,
      accountValidation: accountValidationDeps,
      settings: settingsDeps,
      logger: log,
    })
  })

  // 0.1.7 在每次设置写入后发 `loader/volatile-update`；借此收敛目录/注册/用量。
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => applySelection(config))

  // 析构：关闭 shims + 清心跳（副作用一次执行）。
  let disposed = false
  ctx.effect(() => () => {
    if (disposed) return
    disposed = true
    stopped = true
    for (const region of QODER_REGIONS) void stacks[region].shim.close()
    void clearHostHeartbeat()
  })

  // -------------------------------------------------------------------------
  // 每区域 shim 就绪后注册 provider
  // -------------------------------------------------------------------------

  void Promise.all(QODER_REGIONS.map(region => stacks[region].shim.ready))
    .then(async () => {
      if (stopped) return

      try {
        const adapters = {} as Record<QoderRegion, QoderAdapter>
        for (const region of QODER_REGIONS) {
          adapters[region] = createQoderAdapter({
            shim: stacks[region].shim,
            catalog: stacks[region].catalog,
            provider: QODER_PROVIDERS[region],
            displayName: QODER_PROVIDER_DISPLAY_NAMES[region],
            resolveAttachments: () => ctx.get('attachments'),
          })
          stacks[region].adapter = adapters[region]
        }
        invalidateCatalog = () => {
          for (const region of QODER_REGIONS) adapters[region].invalidate()
        }

        const releaseAdapter = {} as Record<QoderRegion, (() => void) | undefined>
        let releaseDirectory: (() => void) | undefined
        try {
          for (const region of QODER_REGIONS) {
            releaseAdapter[region] = registration[region].adapter = ctx.llm.registerAdapter([QODER_PROVIDERS[region]], adapters[region].adapter)
          }
          // registerConfigurableProviders 一次登记**两个区域**的 provider 条目
          // （map 遍历 QODER_REGIONS），所以这里只有**一个**句柄。它沿用
          // `registration.cn.directory` 这个槽位只是为了不新增字段：整个目录
          // 条目集由这一个句柄持有，并按区域整体 replace（见 syncRegionRegistration）。
          // 不要读成「global 漏了 directory 句柄」。
          releaseDirectory = registration.cn.directory = ctx.llm.registerConfigurableProviders(
            QODER_REGIONS.map(region => ({
              provider: QODER_PROVIDERS[region],
              displayName: QODER_PROVIDER_DISPLAY_NAMES[region],
              settingsNs,
              settingsPath: [],
              declared: false,
            })),
          )
        } finally {
          const missing = QODER_REGIONS.some(region => releaseAdapter[region] === undefined) || releaseDirectory === undefined
          if (missing) {
            for (const region of QODER_REGIONS) releaseAdapter[region]?.()
            releaseDirectory?.()
          }
        }

        ctx.effect(() => () => {
          for (const region of QODER_REGIONS) releaseAdapter[region]?.()
          releaseDirectory?.()
        })

        syncRegionRegistration(config)

        ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
          const region = regionOfProvider(request.provider ?? '')
          if (region === undefined) return []
          if (!regionEnabled(config, region)) return []
          try {
            const models = await discoverModels(region, signal)
            const saved = new Set(enabledModelKeysOf(config, region))
            return deriveCatalog(models, saved.size > 0 ? saved : initialEnabledKeys(models)).map(model => ({
              id: model.key,
              name: modelDisplayName(model),
              contextWindow: model.contextWindow,
              maxTokens: model.maxOutputTokens,
              inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
            }))
          } catch {
            return []
          }
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-qoder: provider registration failed', error)
        return
      }

      // 每区域异步刷新目录（失败静默，fallback 目录继续服务）。
      for (const region of QODER_REGIONS) refreshModels(region)
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-connect-qoder: loopback endpoint failed to start; providers not registered', error)
    })

  /** One batch result → a persisted pool probe. */
  function poolProbeFromResult(result: QoderWebProbeResult): QoderPoolProbe | undefined {
    return {
      outcome: result.outcome,
      atMs: Date.now(),
      source: 'test-batch',
      ...(result.retryAtMs === undefined ? {} : { retryAtMs: result.retryAtMs }),
      ...(result.message === undefined ? {} : { message: result.message }),
    }
  }
}

const FAIL_OVER_OUTCOME: Record<string, QoderWebProbeOutcome> = {
  auth: 'credential-rejected',
  'rate-limited': 'rate-limited',
  'quota-exhausted': 'out-of-credit',
  network: 'unavailable',
  transient: 'unavailable',
}