/**
 * Host 端浏览器路由：用量 / 账号积分 / 目录刷新 / 账号增删 / 探针 / 账号池 /
 * 传输 / __save 设置回退。
 *
 * 形态沿用 dsh-connect-workbuddy（MIT）的 `web-status.ts`：`ctx.webServer
 * .register({kind:'exact', path, handler})`，loopback Origin 校验 + 超长实体上限，
 * 每个（通常每区域）读写路由先做方法/来源/区域三查再干活。浏览器设置镜像只读；
 * 写入要么走宿主 settings 服务，要么走本文件的 `__save` 回退。
 *
 * 改动（按 Qoder 上游）：
 *   - 没有 daily check-in：无 checkin 动作，`pool` 只处理 test / remove，且回报的
 *     `checkinSupported: false` 让卡片整体隐藏签到列；
 *   - 没有扫码 OAuth：账号增删走 `accounts` 路由的 add（PAT 粘贴，JobToken 交换
 *     验证并取显示名）/ remove（删 vault 条目）；
 *   - 没有桌面临终诊断 / markup 恢复：无 `diagnostics:write`；
 *   - 探针按**具体账号**寻址（池批量指定者或当前选择者），不是「当前目录随便
 *     哪个账号」。
 *
 * @module dsh-connect-qoder/web-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  QODER_ACCOUNT_CREDITS_PATH,
  QODER_ACCOUNTS_PATH,
  QODER_ACCOUNTS_REFRESH_PATH,
  QODER_MODELS_REFRESH_PATH,
  QODER_POOL_PATH,
  QODER_PROBE_PATH,
  QODER_SAVE_PATH,
  QODER_TRANSFER_PATH,
  QODER_USAGE_PATH,
  accountActionOf,
  knownQoderRegionOfDomain,
  poolAccountIdOf,
  poolActionOf,
  regionEnabledOf,
  regionCreditsShownOf,
  regionOfStatusUrl,
  transferActionOf,
  type QoderWebRegion,
  type QoderWebUsage,
  type QoderWebAccount,
  type QoderWebAccountCredit,
  type QoderWebCredits,
  type QoderWebModel,
  type QoderWebPool,
  type QoderWebPoolAccount,
  type QoderWebPoolExclusion,
  type QoderWebPoolTestRow,
  type QoderWebProbeResult,
  type QoderWebRecovery,
} from './status-paths.ts'
import type { QoderRegion } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'
import { resolveTargetModel, exclusionOf } from './account-pool.ts'
import type { QoderPoolProbe } from './account-pool.ts'
import type { QoderStoredAccount } from './accounts.ts'

// ---------------------------------------------------------------------------
// 构件类型（Host 端注入给路由层）
// ---------------------------------------------------------------------------

/** One region's account + credential read/write surface. */
export interface QoderAccountDeps {
  /** All accounts (settings + env + vault) as display entries. */
  accounts(sources: { settingsPat?: string | undefined, envPat?: string | undefined }): Promise<QoderAccountEntryLike[]>
  /** The PAT for one account id, without changing selection. */
  credentialFor(accountId: string, sources: { settingsPat?: string | undefined, envPat?: string | undefined }): Promise<{ pat: string, accountName: string, source: 'settings' | 'env' | 'vault' } | undefined>
  /** Resolve the serving credential for the region's selection. */
  resolve(sources: { settingsPat?: string | undefined, envPat?: string | undefined }, selectedId: string | undefined): Promise<{ id: string, pat: string, accountName: string, source: 'settings' | 'env' | 'vault' } | undefined>
  /** Add (or refresh) one vault entry; `name` from a validated JobToken. */
  add(pat: string, name: string): Promise<QoderStoredAccount>
  /** Remove one vault entry. */
  remove(accountId: string): Promise<boolean>
  /** Backfill a display name learned from a JobToken exchange. */
  rename(accountId: string, name: string): Promise<void>
}

export interface QoderAccountEntryLike {
  id: string
  accountName: string
  source: 'settings' | 'env' | 'vault'
}

/** What the account route needs to validate an added PAT. */
export interface QoderAccountValidationDeps {
  /** Region-gateway JobToken exchange; resolves the display name, throws on refusal. */
  validateForRegion(region: QoderRegion, pat: string): Promise<{ name: string }>
}

/** What the pool route needs from the Host. Everything region-scoped. */
export interface QoderPoolDeps {
  preferences(region: QoderRegion): {
    enabled: boolean
    targetModelId: string
    probeInputTokens?: number
    memberAccountIds: readonly string[]
  }
  catalog(region: QoderRegion): readonly QoderModelInfo[]
  /** The measured probes currently in the runtime store. */
  poolProbes(region: QoderRegion): Record<string, QoderPoolProbe>
  /** Resolve one account's PAT WITHOUT changing selection. */
  credentialFor(region: QoderRegion, accountId: string): Promise<{ pat: string, accountName: string } | undefined>
  /** Probe one model through one specific PAT. */
  probeOne(region: QoderRegion, credit: { pat: string, accountName: string }, modelId: string): Promise<QoderWebProbeResult>
  /** Issue a `test` batch for the region's members. OnRow for progress. */
  test(region: QoderRegion, modelId: string): Promise<QoderWebPoolTestRow[]>
  /** Persist the batch's measurements back to the runtime store. */
  applyProbes(region: QoderRegion, probes: Record<string, QoderPoolProbe>): Promise<void>
  /** Drop one account's membership from the prefs. */
  updateMembership(region: QoderRegion, memberAccountIds: readonly string[], enabled?: boolean): void
}

/** What the transfer route needs from the Host. */
export interface QoderTransferDeps {
  exportAccounts(region: QoderRegion): Promise<{ accounts: Array<{ pat: string, accountName: string, id: string }> }>
  previewImport(region: QoderRegion, text: string): Promise<{ accounts: readonly { index: number, uid: string, nickname: string, email: string, hasToken: boolean }[], total: number }>
  importAccounts(region: QoderRegion, text: string, indexes: readonly number[]): Promise<{ imported: number, skipped: number }>
}

/** A settings write surface for the __save fallback. */
export interface QoderSettingsDeps {
  describe(): Array<{ ns: string, value: unknown }>
  set(field: string, value: unknown): Promise<void>
}

export interface QoderWebRouteDeps {
  regionEnabled(region: QoderRegion): boolean
  regionCreditsShown(region: QoderRegion): boolean
  regionUsable?(region: QoderRegion, usable: boolean): void
  store(region: QoderRegion): QoderAccountDeps
  credentialSources(region: QoderRegion): { settingsPat?: string | undefined, envPat?: string | undefined }
  selectedAccountId(region: QoderRegion): string | undefined
  /** The per-region RUNTIME catalog. */
  catalogs: Record<QoderRegion, { current(): QoderModelInfo[] }>
  /** Persisted context budgets by model key, one region. */
  contextBudgets(region: QoderRegion): Record<string, number>
  offModelKeys(region: QoderRegion): readonly string[]
  enabledModelKeys(region: QoderRegion): readonly string[]
  discoverModels?(region: QoderRegion, signal?: AbortSignal): Promise<QoderModelInfo[]>
  /** A cached usage read for one region. */
  usage(region: QoderRegion): { usage?: { credits: QoderWebCredits, atMs: number }, error?: string } | undefined
  /** Probe one model through the region's selected credential. */
  probeModel?(region: QoderRegion, modelId: string, signal?: AbortSignal): Promise<QoderWebProbeResult>
  /** Fetch one region's per-account credit balances fresh (composer panel). */
  accountCredits?(region: QoderRegion, signal?: AbortSignal): Promise<QoderWebAccountCredit[]>
  pool?: QoderPoolDeps
  transfer?: QoderTransferDeps
  accountValidation?: QoderAccountValidationDeps
  settings: QoderSettingsDeps
  logger: (message: string) => void
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(text)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || /^http:\/\/localhost:\d+$/.test(origin)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      // Body cap: transfer files can be large but are bounded; 1 MiB is enough
      // for a realistic account list.
      if (total > 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Narrow the region on a route URL; 400 when absent/unknown. */
function requiredRegion(res: ServerResponse, url: string): QoderRegion | undefined {
  const region = regionOfStatusUrl(url)
  if (region === undefined) {
    json(res, 400, { error: 'unknown region' })
    return undefined
  }
  return region
}

/** Project one model into the card's web row. */
function webModelOf(m: QoderModelInfo): QoderWebModel {
  return {
    key: m.key,
    name: m.displayName,
    contextWindow: m.contextWindow,
    nativeContextWindow: m.contextWindow,
    maxTokens: m.maxOutputTokens,
    ...(m.priceFactor === 1 ? {} : { creditMultiplier: m.priceFactor }),
    ...(m.supportsImages === true ? { supportsImages: true } : {}),
    supportsThinking: m.supportsThinking,
    ...(m.canDisableThinking === true ? { canDisableThinking: true } : {}),
    ...(m.isDefault === true ? { isDefault: true } : {}),
    ...(m.isFree === true ? { isFree: true } : {}),
    ...(m.isNew === true ? { isNew: true } : {}),
    ...(m.contextTiers === undefined ? {} : { contextTiers: m.contextTiers }),
  }
}

/** Redact upstream failure text for safe display/storage. */
export function redactQoderText(text: string): string {
  // eslint-disable-next-line no-useless-escape
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\b(pt-|eyJ)[A-Za-z0-9_\-]{6,}\b/giu, '[redacted credential]')
    .slice(0, 300)
}

/** Project one model into the pool's target picker shape. */
function poolModelOf(m: QoderModelInfo): { id: string, name: string, creditMultiplier?: number, contextWindow: number } {
  return {
    id: m.key,
    name: m.displayName,
    ...(m.isFree === true ? { creditMultiplier: 0 } : {}),
    contextWindow: m.contextWindow,
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface QoderWebStatusMounted {
  status(region: QoderRegion): Promise<QoderWebUsage>
}

/**
 * Mount the web routes for dsh-connect-qoder. Returns the status builder so
 * the Host can also answer from a cache (the route itself re-derives it).
 */
export function registerQoderWebRoutes(ctx: Context, deps: QoderWebRouteDeps): QoderWebStatusMounted {
  const disposers: Array<() => void> = []
  const regionOf = requiredRegion

  const mount = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    try {
      const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch {
      // A route already registered (e.g. re-inject) is fine; watch for it at shutdown.
    }
  }

  // -------------------------------------------------------------------------
  // GET /usage — per-region snapshot (the card's main document).
  // -------------------------------------------------------------------------
  mount(QODER_USAGE_PATH, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const region = regionOfStatusUrl(req.url ?? '')
    if (region === undefined) return json(res, 400, { error: 'unknown region' })
    const usage = await buildWebUsage(deps, region)
    return json(res, 200, usage)
  })

  // -------------------------------------------------------------------------
  // GET /account-credits — per-account balances for the composer panel.
  // -------------------------------------------------------------------------
  mount(QODER_ACCOUNT_CREDITS_PATH, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    if (deps.accountCredits === undefined) return json(res, 503, { reason: 'credits-unavailable', error: 'account credits unavailable' })
    try {
      const credits = await deps.accountCredits(region)
      return json(res, 200, credits)
    } catch (error: unknown) {
      return json(res, 502, { error: safeMessage(error) })
    }
  })

  // -------------------------------------------------------------------------
  // POST /models/refresh — re-read one region's catalog.
  // -------------------------------------------------------------------------
  mount(QODER_MODELS_REFRESH_PATH, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    if (deps.discoverModels === undefined) return json(res, 503, { reason: 'refresh-unavailable', error: 'model discovery unavailable' })
    try {
      const models = await deps.discoverModels(region)
      return json(res, 200, { models: models.map(webModelOf) })
    } catch (error: unknown) {
      return json(res, 502, { error: safeMessage(error) })
    }
  })

  // -------------------------------------------------------------------------
  // POST /accounts/refresh — re-scan sources (settings / env / vault).
  // -------------------------------------------------------------------------
  mount(QODER_ACCOUNTS_REFRESH_PATH, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const accounts = await deps.store(region).accounts(deps.credentialSources(region))
    return json(res, 200, accounts.map(webAccountOf(deps, region)))
  })

  // -------------------------------------------------------------------------
  // POST /accounts?action=add|remove — one vault mutation (add-PAT + remove).
  // -------------------------------------------------------------------------
  mount(QODER_ACCOUNTS_PATH, async (req, res) => {
    if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const action = accountActionOf(req.url ?? '')
    if (action === undefined) return json(res, 400, { error: 'action is required (add|remove)' })
    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body || '{}') as Record<string, unknown>
    } catch {
      return json(res, 400, { error: 'invalid JSON body' })
    }
    if (action === 'add') {
      const pat = typeof parsed.pat === 'string' ? parsed.pat.trim() : ''
      if (pat === '') return json(res, 400, { error: 'pat is required' })
      if (deps.accountValidation === undefined) return json(res, 503, { reason: 'validation-unavailable', error: 'account validation unavailable' })
      try {
        const { name } = await deps.accountValidation.validateForRegion(region, pat)
        const stored = await deps.store(region).add(pat, name)
        // Resolve the account's name later only if validation returned none.
        if (name === '' || name !== stored.accountName) {
          await deps.store(region).rename(stored.id, name)
        }
        return json(res, 200, { accountId: stored.id })
      } catch (error: unknown) {
        return json(res, 502, { error: safeMessage(error) })
      }
    }
    // remove
    const accountId = typeof parsed.accountId === 'string' ? parsed.accountId : ''
    if (accountId === '') return json(res, 400, { error: 'accountId is required' })
    const removed = await deps.store(region).remove(accountId)
    return json(res, 200, { removed })
  })

  // -------------------------------------------------------------------------
  // GET /probe?region=&model= — probe one model via the region's selection.
  // -------------------------------------------------------------------------
  mount(QODER_PROBE_PATH, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const model = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('model') ?? ''
    if (model === '') return json(res, 400, { error: 'model is required' })
    if (deps.probeModel === undefined) return json(res, 503, { reason: 'probe-unavailable', error: 'probe unavailable' })
    try {
      const result = await deps.probeModel(region, model)
      return json(res, 200, result)
    } catch (error: unknown) {
      return json(res, 502, { error: safeMessage(error) })
    }
  })

  // -------------------------------------------------------------------------
  // POST /pool?region=&action=test|remove
  // -------------------------------------------------------------------------
  mount(QODER_POOL_PATH, async (req, res) => {
    if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const action = poolActionOf(req.url ?? '')
    if (action === undefined) return json(res, 400, { error: 'action is required (test|remove)' })
    if (deps.pool === undefined) return json(res, 503, { reason: 'pool-unavailable', error: 'pool unavailable' })
    const pool = deps.pool

    if (action === 'test') {
      const target = resolveTargetModel(pool.catalog(region).map(poolModelOf), pool.preferences(region).targetModelId)
      if (target.modelId === undefined) {
        return json(res, 200, { action: 'test', rows: [], modelId: undefined })
      }
      const rows = await pool.test(region, target.modelId)
      return json(res, 200, { action: 'test', modelId: target.modelId, rows })
    }

    // remove one account's membership
    const accountId = poolAccountIdOf(req.url ?? '')
    if (accountId === undefined) return json(res, 400, { error: 'accountId is required' })
    const prefs = pool.preferences(region)
    pool.updateMembership(region, prefs.memberAccountIds.filter(id => id !== accountId), prefs.enabled)
    return json(res, 200, { removed: true })
  })

  // -------------------------------------------------------------------------
  // POST /transfer?region=&action=export|preview|import
  // -------------------------------------------------------------------------
  mount(QODER_TRANSFER_PATH, async (req, res) => {
    if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const action = transferActionOf(req.url ?? '')
    if (action === undefined) return json(res, 400, { error: 'action is required (export|preview|import)' })
    if (deps.transfer === undefined) return json(res, 503, { reason: 'transfer-unavailable', error: 'transfer unavailable' })
    const transfer = deps.transfer
    const body = await readBody(req)
    let parsed: { text?: unknown, indexes?: unknown } = {}
    try {
      parsed = JSON.parse(body || '{}') as { text?: unknown, indexes?: unknown }
    } catch {
      return json(res, 400, { error: 'invalid JSON body' })
    }

    if (action === 'export') {
      const answer = await transfer.exportAccounts(region)
      return json(res, 200, answer)
    }
    if (action === 'preview') {
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const answer = await transfer.previewImport(region, text)
      return json(res, 200, answer)
    }
    // import
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    const indexes = Array.isArray(parsed.indexes)
      ? (parsed.indexes as unknown[]).filter((i): i is number => typeof i === 'number' && Number.isFinite(i))
      : []
    const answer = await transfer.importAccounts(region, text, indexes)
    return json(res, 200, answer)
  })

  // -------------------------------------------------------------------------
  // POST /__save — Host-side settings write fallback (field/value).
  // -------------------------------------------------------------------------
  mount(QODER_SAVE_PATH, async (req, res) => {
    if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const bodyText = await readBody(req)
    let body: { field?: unknown, value?: unknown }
    try {
      body = JSON.parse(bodyText) as { field?: unknown, value?: unknown }
    } catch {
      return json(res, 400, { error: 'invalid JSON body' })
    }
    const field = body.field
    if (typeof field !== 'string' || field === '') return json(res, 400, { error: 'field is required' })
    try {
      await deps.settings.set(field, body.value)
      return json(res, 200, { ok: true })
    } catch (error: unknown) {
      return json(res, 500, { error: safeMessage(error) })
    }
  })

  const mounted: QoderWebStatusMounted = { status: region => buildWebUsage(deps, region) }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
  })

  return mounted
}

// ---------------------------------------------------------------------------
// 快照组装
// ---------------------------------------------------------------------------

/** Project one account entry to its web shape with the selection flag. */
function webAccountOf(deps: QoderWebRouteDeps, region: QoderRegion) {
  return (account: QoderAccountEntryLike): QoderWebAccount => ({
    id: account.id,
    accountName: account.accountName,
    source: account.source,
    selected: account.id === deps.selectedAccountId(region) || (account.source !== 'vault' && deps.selectedAccountId(region) === undefined),
  })
}

/** Build one region's main usage document. */
export async function buildWebUsage(deps: QoderWebRouteDeps, region: QoderRegion): Promise<QoderWebUsage> {
  const sources = deps.credentialSources(region)
  const store = deps.store(region)
  const accounts = await store.accounts(sources)
  const selectedId = deps.selectedAccountId(region)

  // Resolve the serving credential; decide signed-in vs signed-out.
  let serving = await store.resolve(sources, selectedId)
  if (serving === undefined) {
    const selectionExplicit = selectedId !== undefined && selectedId !== ''
    const selectionLost = selectionExplicit && accounts.length > 0
    deps.regionUsable?.(region, false)
    return {
      status: 'signed-out',
      accounts: accounts.map(webAccountOf(deps, region)),
      enabled: deps.regionEnabled(region),
      showCreditsInMainUi: deps.regionCreditsShown(region),
      message: selectionLost
        ? '所选账号已不存在，请重新选择或填写 PAT'
        : '请填写 Qoder PAT（或设置环境变量）',
      selectionLost,
      selectionExplicit,
    }
  }

  deps.regionUsable?.(region, true)

  const catalog = deps.catalogs[region].current()
  const enabledKeys = new Set(deps.enabledModelKeys(region))
  const budgets = deps.contextBudgets(region)
  const models = catalog.map(model => {
    // apply the saved context budget to each model's web row.
    const budget = budgets[model.key]
    const effectiveWindow = budget !== undefined && model.contextTiers?.includes(budget)
      ? { contextWindow: budget, nativeContextWindow: model.contextWindow }
      : { contextWindow: model.contextWindow, nativeContextWindow: model.contextWindow }
    return {
      ...webModelOf(model),
      ...effectiveWindow,
    }
  })

  const usageEntry = deps.usage(region)
  const offKeysRaw = deps.offModelKeys(region)
  const offModelKeys = catalog.filter(m => offKeysRaw.includes(m.key) || !m.supportsThinking).map(m => m.key)

  const credentialRejected = usageEntry?.error === 'credential-rejected'
  const recovery: QoderWebRecovery | undefined = credentialRejected
    ? { reloginRequired: accounts.length <= 1 }
    : undefined

  let pool: QoderWebPool | undefined
  if (deps.pool !== undefined) {
    pool = await buildPoolView(deps, region, accounts, catalog)
  }

  return {
    status: 'signed-in',
    accountId: serving.id,
    accountName: serving.accountName,
    region,
    enabled: deps.regionEnabled(region),
    showCreditsInMainUi: deps.regionCreditsShown(region),
    source: serving.source,
    selectionExplicit: selectedId !== undefined && selectedId !== '',
    accounts: accounts.map(webAccountOf(deps, region)),
    models,
    enabledModelKeys: models.filter(m => enabledKeys.has(m.key)).map(m => m.key),
    offModelKeys,
    ...(usageEntry?.usage?.credits === undefined ? {} : { credits: usageEntry.usage.credits }),
    ...(usageEntry?.error !== undefined ? { creditsError: redactQoderText(usageEntry.error) } : {}),
    ...(credentialRejected && recovery ? { credentialRejected: true, recovery } : {}),
    contextBudgets: budgets,
    ...(pool === undefined ? {} : { pool }),
  }
}

/** Build the pool's web view, including per-account rows tied to the probes. */
async function buildPoolView(
  deps: QoderWebRouteDeps,
  region: QoderRegion,
  accounts: readonly QoderAccountEntryLike[],
  catalog: readonly QoderModelInfo[],
): Promise<QoderWebPool> {
  const pool = deps.pool!
  const prefs = pool.preferences(region)
  const probes = pool.poolProbes(region)
  const now = Date.now()
  const memberSet = new Set(prefs.memberAccountIds)
  const targetId = prefs.targetModelId || ''
  const targetModels = catalog.map(m => ({
    id: m.key,
    name: m.displayName,
    ...(m.isFree === true ? { creditMultiplier: 0 } : {}),
    contextWindow: m.contextWindow,
  }))
  const target = resolveTargetModel(targetModels, prefs.targetModelId)

  // Membership is explicit; effective membership is what the pool can actually
  // resolve a credential for.
  const effectiveIds: string[] = []
  const rows: QoderWebPoolAccount[] = []
  for (const [index, account] of accounts.entries()) {
    const member = memberSet.has(account.id)
    const probe = probes[account.id]
    const excludedBy = exclusionOf(probe, now)
    const currentId = targetId
    const isCurrent = target.modelId !== undefined && account.id === currentId
    if (member) {
      const cred = member ? await pool.credentialFor(region, account.id) : undefined
      if (cred !== undefined) effectiveIds.push(account.id)
    }
    rows.push({
      accountId: account.id,
      accountName: account.accountName,
      ...(probe === undefined ? {} : {
        probe: {
          outcome: probe.outcome,
          atMs: probe.atMs,
          ...(probe.source === undefined ? {} : { source: probe.source }),
          ...(probe.retryAtMs === undefined ? {} : { retryAtMs: probe.retryAtMs }),
          ...(probe.message === undefined ? {} : { message: probe.message }),
        },
      }),
      ...(excludedBy === undefined ? {} : { excludedBy }),
      ...(index === 0 && deps.selectedAccountId(region) === undefined ? { current: true } : { current: isCurrent }),
      ...(isCurrent ? { current: true } : {}),
      member,
    })
  }

  return {
    enabled: prefs.enabled,
    checkinSupported: false,
    ...(target.modelId === undefined ? {} : { targetModelId: target.modelId }),
    ...(target.source === 'stale' && target.staleModelId !== undefined ? { staleTargetModelId: target.staleModelId } : {}),
    targetModelSource: target.source,
    memberAccountIds: prefs.memberAccountIds,
    ...(prefs.probeInputTokens && prefs.probeInputTokens > 0 ? { probeInputTokens: prefs.probeInputTokens } : {}),
    effectiveMemberAccountIds: effectiveIds,
    accounts: rows,
    catalog: targetModels,
  }
}
