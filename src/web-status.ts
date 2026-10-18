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
 *   - **有** daily check-in（CN）：`pool` 的 checkin 动作拉活动列表并领取每日
 *     Credits（`sash/api/v1/me/campaigns`）。早先此处写着「没有 daily check-in」
 *     并回报 `checkinSupported: false` —— 那是没实测就下的结论；真实路径叫
 *     `campaigns`，名字里没有「签到」二字，所以照着 checkin/signin 猜必然 404；
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
  type QoderCreditPosition,
  type QoderWebUsage,
  type QoderWebAccount,
  type QoderWebAccountCredit,
  type QoderWebCredits,
  type QoderWebModel,
  type QoderWebPool,
  type QoderWebPoolAccount,
  type QoderWebPoolBatch,
  type QoderWebPoolCheckinRow,
  type QoderWebPoolExclusion,
  type QoderWebPoolTestRow,
  type QoderWebProbeResult,
  type QoderWebRecovery,
  type QoderTransferRecord,
} from './status-paths.ts'
import type { QoderRegion } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'
import { resolveTargetModel, exclusionOf, rankPool } from './account-pool.ts'
import type { QoderPoolCredits, QoderPoolProbe } from './account-pool.ts'
import type { QoderStoredAccount } from './accounts.ts'
import { isQoderAccountId } from './credentials.ts'

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
  /**
   * The vault entries only — NOT settings/env PATs.
   *
   * Deleting needs this distinction: a settings or env PAT is owned by whoever set
   * it (outside this plugin), so removing a vault entry cannot delete it. Asking
   * "is this id one we store?" is what lets the delete route refuse honestly
   * instead of reporting a removal that changed nothing.
   */
  vaultAccounts(): Promise<QoderStoredAccount[]>
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
    /** 用户手动排定的优先级；空 = 完全由积分策略决定。 */
    orderAccountIds?: readonly string[]
  }
  catalog(region: QoderRegion): readonly QoderModelInfo[]
  /** The measured probes currently in the runtime store. */
  poolProbes(region: QoderRegion): Record<string, QoderPoolProbe>
  /**
   * 池成员的最新积分读数（成员 id → 余额），供成员表的积分列使用。
   * workbuddy 同规：这一列由卡片路由付费（每成员一次 usage 读数），结果同时
   * 写入宿主侧快照供请求路径的排名使用；非成员不读，显示「—」。
   */
  memberCredits?(region: QoderRegion, accountIds: readonly string[]): Promise<ReadonlyMap<string, QoderPoolCredits>>
  /** Resolve one account's PAT WITHOUT changing selection. */
  credentialFor(region: QoderRegion, accountId: string): Promise<{ pat: string, accountName: string } | undefined>
  /** Probe one model through one specific PAT. */
  probeOne(region: QoderRegion, credit: { pat: string, accountName: string }, modelId: string): Promise<QoderWebProbeResult>
  /**
   * Issue a `test` batch for the region's members, or for ONE account when
   * `onlyAccountId` is given.
   *
   * The card's row-level "测试" button must touch only its own row: a batch
   * there would re-probe every member (a real request and ~25k input tokens
   * each) for a control that appears to act on one line.
   */
  test(region: QoderRegion, onlyAccountId?: string): Promise<QoderWebPoolTestRow[]>
  /**
   * 该区域是否提供每日签到。两个区域都为 true（国际版需要本机 UMID 组件产出的
   * 设备风控头，取不到时签到如实报错）。路由据此在**到达上游之前**拒绝 checkin 动作。
   */
  checkinSupported(region: QoderRegion): boolean
  /** Issue a `checkin` batch for the region's members (每个成员各领一次). */
  checkin?(region: QoderRegion): Promise<QoderWebPoolCheckinRow[]>
  /**
   * 今日签到状态快照（成员 id → 是否已领）。由签到批次回写、成员表读取。
   * 缺席的成员表示**还没读过**（UI 说「未知」），不是「未签到」。
   *
   * @deprecated 改用 {@link checkinSnapshot}：这个布尔表装不下「下一窗什么时候
   * 刷新」—— 而那正是「已领取」这句话必须带的另一半（上游 `endAt`）。
   */
  checkinState?(region: QoderRegion): Readonly<Record<string, boolean>>
  /**
   * 今日签到快照：每个成员「是否已领」**与**「下一窗何时刷新」（epoch 毫秒，
   * 来自上游活动行的 `endAt`）。
   *
   * 两个字段同源：都只有真的打过上游才存在。`refreshAtMs` 缺席时 UI 只说
   * 「已领取」，**绝不**编一个本地猜测的倒计时。
   */
  checkinSnapshot?(region: QoderRegion): Readonly<Record<string, { claimed: boolean, refreshAtMs?: number }>>
  /**
   * 正在飞的批量动作（签到或测试）已经处理完的那几行，供卡片的 `action=progress`
   * 轮询逐条写活动日志。
   *
   * 只读宿主内存、不碰上游：每处理完一个账号追加一行（带完成时刻），批次结束
   * 即清空（响应里本来就有完整结果，这个槽位只服务「在飞期间」）。两个批量动作
   * 共用一个锁，所以每个区域只需要一个槽位。
   */
  batchProgress?(region: QoderRegion): QoderWebPoolBatch | undefined
  /** Persist the batch's measurements back to the runtime store. */
  applyProbes(region: QoderRegion, probes: Record<string, QoderPoolProbe>): Promise<void>
  /** Drop one account's membership from the prefs. */
  updateMembership(region: QoderRegion, memberAccountIds: readonly string[], enabled?: boolean): void
}

/**
 * What the transfer route needs from the Host.
 *
 * `exportAccounts` must return records in the **transfer-file shape**
 * (`access_token` / `uid` / `nickname` / `domain`) — NOT the vault's internal
 * shape. The exported document gets re-imported through `importAccounts`, whose
 * region gate recognises a record only by its `domain`, so exporting the vault's
 * raw fields made every exported record unimportable (0 imported, all skipped).
 */
export interface QoderTransferDeps {
  exportAccounts(region: QoderRegion): Promise<{ accounts: QoderTransferRecord[] }>
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
  /**
   * WHERE this region's credit readout sits.
   *
   * Optional, and absent reads as `composer` —— 该设置存在之前唯一的席位，
   * 所以早于本设置的宿主渲染得与从前完全一样。
   */
  creditPosition?(region: QoderRegion): QoderCreditPosition
  regionUsable?(region: QoderRegion, usable: boolean): void
  store(region: QoderRegion): QoderAccountDeps
  credentialSources(region: QoderRegion): { settingsPat?: string | undefined, envPat?: string | undefined }
  selectedAccountId(region: QoderRegion): string | undefined
  /**
   * Drop the region's saved `accountId` selection (back to "automatic").
   *
   * Called after the account it pointed at is deleted: the choice is gone with its
   * credential, and leaving it behind makes the card keep reporting
   * `selectionLost` — "the account you selected no longer exists" — for a region
   * that is in fact fine. Optional so an older Host without it still works; the
   * stale selection then resolves to automatic on its own.
   */
  clearSelection?(region: QoderRegion): Promise<void> | void
  /** The per-region RUNTIME catalog. */
  catalogs: Record<QoderRegion, { current(): QoderModelInfo[] }>
  /** Persisted context budgets by model key, one region. */
  contextBudgets(region: QoderRegion): Record<string, number>
  /** Persisted thinking strength per model key (`low` / `medium` / `xhigh` …). */
  thinkingEfforts(region: QoderRegion): Record<string, string>
  offModelKeys(region: QoderRegion): readonly string[]
  /** Model keys the user explicitly enabled image input for (independent set). */
  imageModelKeys(region: QoderRegion): readonly string[]
  enabledModelKeys(region: QoderRegion): readonly string[]
  discoverModels?(region: QoderRegion, signal?: AbortSignal): Promise<QoderModelInfo[]>
  /**
   * Full refresh behind the card's refresh button: re-reads the upstream
   * catalog AND installs it into the runtime catalog (plus a usage refresh),
   * then returns the fresh list. Preferred over {@link discoverModels} for the
   * refresh route; discoverModels alone never mutates runtime state, so a route
   * wired to it answers new data while the card's next poll still sees the old.
   */
  refreshModels?(region: QoderRegion): Promise<QoderModelInfo[]>
  /** A cached usage read for one region. */
  usage(region: QoderRegion): {
    usage?: { credits: QoderWebCredits, atMs: number }
    error?: string
    /** The last RE-READ failed but the snapshot below is intact (see refreshError). */
    staleError?: string
  } | undefined
  /**
   * Re-read this region's credits from upstream **into the cache** the `usage`
   * dep reads from, awaited before the document is assembled.
   *
   * 对齐 workbuddy：那边的 usage 路由每次请求都现场并发拉积分
   * （`web-status.ts` 的 `Promise.allSettled` + `toCredits`）。Qoder 移植时把这一处
   * 换成了纯缓存读，而缓存只在「启动 / 配置写入 / 刷新模型 / 签到」四个时机被写，
   * 于是聊天扣费后触发器上的数字**永远不会自己变新**，而面板表格（每账号现场读）
   * 是新的 —— 同一个账号在同一个面板里显示两个数（用户实拍 800 vs 738）。
   *
   * Optional: a host that does not wire this dep falls back to the old pure
   * cache read and the document still builds.
   */
  refreshUsage?(region: QoderRegion): Promise<void>
  /** Probe one model through the region's selected credential. */
  probeModel?(region: QoderRegion, modelId: string, signal?: AbortSignal): Promise<QoderWebProbeResult>
  /** Fetch one region's per-account credit balances fresh (composer panel). */
  accountCredits?(region: QoderRegion, signal?: AbortSignal): Promise<QoderWebAccountCredit[]>
  /**
   * What to tell the user after the upstream refused this region's credential.
   *
   * Probes the OTHER stored accounts and promises a switch only to one that
   * actually answered — the alternative (guessing from the account count) says
   * "try switching" about an account that may be just as expired.
   */
  credentialRecovery?(region: QoderRegion, rejectedAccountId: string): Promise<QoderWebRecovery>
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
    // 倍率总是带上——包括恰好 1。workbuddy 的卡片行对「已声明的倍率」一律
    // 渲染 `(1.00x)`，Qoder 自家菜单也写 `· x1.0`；把 1 当「无」丢掉，卡片上
    // 就只剩没倍率的裸名字，与其他模型视觉不一致。
    creditMultiplier: m.priceFactor,
    ...(m.supportsImages === true ? { supportsImages: true } : {}),
    supportsThinking: m.supportsThinking,
    ...(m.canDisableThinking === true ? { canDisableThinking: true } : {}),
    // 思考强度档位：上游 `thinking_config.enabled.efforts` 的键（已按强度升序）。
    // 缺失时不写字段，卡片据此不渲染这一项——而不是渲染一个空标签。
    ...(m.thinkingEfforts === undefined ? {} : { thinkingEfforts: m.thinkingEfforts }),
    ...(m.defaultThinkingEffort === undefined ? {} : { defaultThinkingEffort: m.defaultThinkingEffort }),
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
    // 同 pool 视图的规则：免费折叠为 0（resolveTargetModel 只认 === 0），付费
    // 透传真实倍率。
    creditMultiplier: m.isFree === true ? 0 : m.priceFactor,
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
    const refresh = deps.refreshModels ?? deps.discoverModels
    if (refresh === undefined) return json(res, 503, { reason: 'refresh-unavailable', error: 'model discovery unavailable' })
    try {
      const models = await refresh(region)
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
      // 用户在这次添加里填的显示名（可空）。**必须**用上：qoder 是 PAT 模式，
      // 上游校验只回一个账号标识，而用户给这个 PAT 起的名字（「公司号」「备用」）
      // 才是他认得的那个。此前只做在客户端、路由完全忽略它——名字填了等于没填，
      // 存进去的永远是上游解析出的那个。
      const preferred = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      if (deps.accountValidation === undefined) return json(res, 503, { reason: 'validation-unavailable', error: 'account validation unavailable' })
      try {
        const { name } = await deps.accountValidation.validateForRegion(region, pat)
        // 用户没填才退回上游解析出的名字（两者都空时写空串，卡片渲染「未命名」）。
        const displayName = preferred !== '' ? preferred : name
        const stored = await deps.store(region).add(pat, displayName)
        // `add` 命中已存在的 id 时只更新凭据、保留旧名；这次明确填了名字就改过去。
        if (displayName !== stored.accountName) {
          await deps.store(region).rename(stored.id, displayName)
        }
        return json(res, 200, { accountId: stored.id, accountName: displayName })
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
  // /pool?region=&action=checkin|test|remove|progress
  //
  // 前三个是 POST 动作；`progress` 是**只读的 GET 轮询**（卡片在批量在飞期间
  // 每秒问一次「哪几行已经处理完」），所以必须在方法检查之前分岔。
  // -------------------------------------------------------------------------
  mount(QODER_POOL_PATH, async (req, res) => {
    if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
    const region = regionOf(res, req.url ?? '')
    if (region === undefined) return
    const action = poolActionOf(req.url ?? '')
    if (action === undefined) return json(res, 400, { error: 'action is required (checkin|test|remove|progress)' })
    if (deps.pool === undefined) return json(res, 503, { reason: 'pool-unavailable', error: 'pool unavailable' })
    const pool = deps.pool

    if (action === 'progress') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const batch = pool.batchProgress?.(region)
      return json(res, 200, batch === undefined ? { action: 'progress' } : { action: 'progress', batch })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

    if (action === 'checkin') {
      // 区域没有每日签到时**在到达上游之前**就拒绝：不值得为一个「这里没有」
      // 花一次请求。作为能力拒绝（409 + reason）回报，而不是失败——调用方
      // 要能分清「这里不提供」与「提供了但坏了」。卡片隐藏按钮是同一规则的
      // UI 半边（workbuddy 同规）。
      if (pool.checkinSupported(region) !== true) {
        return json(res, 409, { reason: 'checkin-unsupported', error: 'this region does not offer a daily check-in' })
      }
      if (pool.checkin === undefined) {
        return json(res, 503, { reason: 'pool-unavailable', error: 'pool check-in unavailable' })
      }
      const rows = await pool.checkin(region)
      return json(res, 200, { action: 'checkin', rows })
    }

    if (action === 'test') {
      const target = resolveTargetModel(pool.catalog(region).map(poolModelOf), pool.preferences(region).targetModelId)
      if (target.modelId === undefined) {
        return json(res, 200, { action: 'test', rows: [], modelId: undefined })
      }
      // `accountId` 存在时只测那一个（行级按钮）。畸形值按形状拒掉，别让它
      // 走到宿主内部才炸：与下方 delete 分支同一条规矩。
      const only = poolAccountIdOf(req.url ?? '')
      if (only !== undefined && !isQoderAccountId(only)) {
        return json(res, 400, { error: 'accountId is not a well-formed account id' })
      }
      // 查一下这个号还在不在：不在就明确回报，而不是回一个空数组让人以为
      // 「测过了、没问题」。
      if (only !== undefined) {
        const stored = (await deps.store(region).vaultAccounts()).find(entry => entry.id === only)
        if (stored === undefined) {
          return json(res, 409, { reason: 'account-not-found', error: 'no stored account with that id' })
        }
      }
      const rows = await pool.test(region, only)
      return json(res, 200, { action: 'test', modelId: target.modelId, ...only === undefined ? {} : { accountId: only }, rows })
    }

    // ---- 彻底删除一个账号（凭据 + 池成员 + 区域选择，一次做完）----
    //
    // 这一支以前只做了「从 memberAccountIds 里剔掉」——也就是**移出池**，不是删除。
    // 用户点它期望账号消失，PAT 却原封不动留在 vault 里，下一次「全选」又勾回来，
    // 于是看起来像「删不掉」（用户实拍：「删除唯一的号，但是号并没有删除干净」）。
    // 移出池现在由**勾选框**表达（workbuddy 同规），这个动作只保留「彻底删除」。
    const accountId = poolAccountIdOf(req.url ?? '')
    if (accountId === undefined) return json(res, 400, { error: 'accountId is required' })
    // id 来自查询参数、马上就要拿去当 vault 里的键比对。先在这里按形状拒掉畸形值：
    // 让一次构造出来的请求得到 400，而不是走到宿主内部才炸成 500。
    if (!isQoderAccountId(accountId)) {
      return json(res, 400, { error: 'accountId is not a well-formed account id' })
    }
    // settings / env 里的 PAT **不属于本插件**：它们由用户在插件之外管理，删掉
    // vault 条目对它无效。所以先问清楚这个 id 是不是本插件自己存的凭据，
    // 不是的话明确回报，而不是回一个「其实没删掉什么」的 200。
    const store = deps.store(region)
    const stored = (await store.vaultAccounts()).find(entry => entry.id === accountId)
    if (stored === undefined) {
      return json(res, 409, { reason: 'account-not-deletable', error: 'only accounts added by this plugin can be deleted' })
    }
    const removed = await store.remove(accountId)
    // 凭据没了，配置里指向它的两处残骸必须一起收掉，否则卡片会一直说
    // 「所选账号已不存在」：区域的 accountId 与池的 memberAccountIds。
    if (deps.selectedAccountId(region) === accountId) {
      await deps.clearSelection?.(region)
    }
    const prefs = pool.preferences(region)
    if (prefs.memberAccountIds.includes(accountId)) {
      pool.updateMembership(region, prefs.memberAccountIds.filter(id => id !== accountId), prefs.enabled)
    }
    return json(res, 200, { removed })
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
      // **必须在服务端按槽位合并。**
      //
      // 客户端只发它要写的那一个区域（`{ [region]: value }`），因为它无法读到
      // 另一侧的当前状态。此前这里直接把 body.value 整个写进 settings，于是
      // 保存 cn 模型的这一次操作会把**整个 global 槽位删掉**——用户看到的现象
      // 是「保存模型保存不了」，而磁盘上被抹掉的是另一侧的全部配置（已发生）。
      //
      // 服务端有 `describe()`，能读到现值，所以这里做一次真正的按槽位合并：
      // 请求里没提到的区域原样保留。
      await deps.settings.set(field, mergeSlotWise(field, deps.settings.describe(), body.value))
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

/**
 * 按区域槽位合并一次 settings 写入。
 *
 * 客户端只带它要写的那一个区域（`{ [region]: value }`）——它没有另一侧的当前
 * 状态，无法自己做合并；而宿主有 `describe()`，所以合并必须发生在这里。
 *
 * 规则：
 *   - `regions.<region>` 是**槽位级**的：请求里出现的槽位整份替换（槽位内部的
 *     字段级合并已经在客户端完成——`nextRegionModels` 从现槽位起 merge），未出现
 *     的槽位**原样保留**；
 *   - 若宿主当前没有这个槽位，则整份采用请求值。
 *
 * 这条规则是必须的，不是优化：缺了它，保存任一区域都会静默删除另一区域的全部
 * 配置（用户实拍「保存模型保存不了」）。
 */
function mergeSlotWise(
  field: string,
  described: Array<{ ns: string, value: unknown }>,
  incoming: unknown,
): unknown {
  // 非 `regions` 字段（未来扩展）：没有槽位语义，整份采用请求值。
  if (field !== 'regions') return incoming
  if (!isRecord(incoming)) return incoming

  const current = described.find(entry => entry.value !== undefined)?.value
  const currentRegions = isRecord(current) && isRecord(current['regions']) ? current['regions'] : undefined
  if (currentRegions === undefined) return incoming

  const merged: Record<string, unknown> = { ...currentRegions }
  for (const [region, value] of Object.entries(incoming)) {
    merged[region] = isRecord(value) && isRecord(currentRegions[region])
      ? { ...(currentRegions[region] as Record<string, unknown>), ...value }
      : value
  }
  return { ...(isRecord(current) ? current : {}), regions: merged }
}

/** Whether a value is a plain (non-array, non-null) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * This region's usage entry, refreshed from upstream first.
 *
 * 对齐 workbuddy：那边的 usage 路由每次请求都现场拉积分，所以数字总是新的。Qoder
 * 移植时换成了纯缓存读，而缓存只在「启动 / 配置写入 / 刷新模型 / 签到」四个时机
 * 被写 —— 聊天扣费后触发器上的数字**永远不会自己变新**，而面板表格（每账号现场
 * 读）是新的，于是同一个账号在同一个面板里显示两个数（用户实拍 800 vs 738）。
 *
 * 三条约束，缺一不可：
 *   1. **失败绝不能把文档打回空白**。`refreshUsage` 的失败由宿主记成覆盖层
 *      （`staleError` → 文档的 `refreshError`），这里只 await、不抛；
 *   2. **dep 缺席（旧宿主）时退回原来的缓存读**，行为与从前一致；
 *   3. 刷新**之后**才读缓存，否则读到的还是上一轮的旧快照 —— 修了等于没修。
 */
async function freshUsageEntryOf(deps: QoderWebRouteDeps, region: QoderRegion): Promise<
  { usage?: { credits: QoderWebCredits, atMs: number }, error?: string, staleError?: string } | undefined
> {
  try {
    await deps.refreshUsage?.(region)
  } catch {
    // 刷新链本身出错（不该发生：宿主侧已把上游异常收进缓存），照常回落到缓存读。
  }
  return deps.usage(region)
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
    // 账号池**在没有账号时也必须给出来**：它是「添加 PAT / 导入账号」的**唯一**
    // 入口（账号工具由账号池区渲染，见客户端 `renderPool`）。此前这一支刻意不带
    // `pool`，理由是「不出现 pool 段就等于没有任何账号正在使用」——但那个表达
    // 让最需要添加账号的页面（一个账号都没有）恰恰没有添加入口（用户实拍）。
    // 「当前没有正在计费的账号」这件事改由每一行的 `current` 表达：没有账号时
    // 自然全为 false，无需靠整段缺席来暗示。
    const pool = deps.pool === undefined
      ? undefined
      : await buildPoolView(deps, region, accounts, deps.catalogs[region].current(), undefined)
    return {
      status: 'signed-out',
      accounts: accounts.map(webAccountOf(deps, region)),
      enabled: deps.regionEnabled(region),
      showCreditsInMainUi: deps.regionCreditsShown(region),
      creditPosition: deps.creditPosition?.(region) ?? 'composer',
      message: selectionLost
        ? '所选账号已不存在，请重新选择或填写 PAT'
        : '请填写 Qoder PAT（或设置环境变量）',
      selectionLost,
      selectionExplicit,
      ...(pool === undefined ? {} : { pool }),
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

  const usageEntry = await freshUsageEntryOf(deps, region)
  const offKeysRaw = deps.offModelKeys(region)
  const offModelKeys = catalog.filter(m => offKeysRaw.includes(m.key) || !m.supportsThinking).map(m => m.key)

  const credentialRejected = usageEntry?.error === 'credential-rejected'
  // 恢复建议必须建立在**实测**上：把「本区域还有其他账号，但刚才都没能通过
  // 上游校验」这句话说出口之前，得真的去问过那些账号。此前这里是
  // `accounts.length <= 1` 的猜测——只要存在第二条记录就宣称「可以切换一个
  // 试试」，而那条记录可能同样过期（用户实拍：两条同名记录、一条已过期，卡片
  // 却说「试试上面那个」）。`credentialRecovery` 逐个探测其余账号，只把真正
  // 答过话的那个承诺给用户；dep 缺席（旧宿主）时退回原来的保守猜测。
  let recovery: QoderWebRecovery | undefined
  if (credentialRejected) {
    recovery = deps.credentialRecovery === undefined
      ? { reloginRequired: accounts.length <= 1 }
      : await deps.credentialRecovery(region, serving.id)
  }

  let pool: QoderWebPool | undefined
  if (deps.pool !== undefined) {
    pool = await buildPoolView(deps, region, accounts, catalog, serving.id)
  }

  return {
    status: 'signed-in',
    accountId: serving.id,
    accountName: serving.accountName,
    region,
    enabled: deps.regionEnabled(region),
    showCreditsInMainUi: deps.regionCreditsShown(region),
    creditPosition: deps.creditPosition?.(region) ?? 'composer',
    source: serving.source,
    selectionExplicit: selectedId !== undefined && selectedId !== '',
    accounts: accounts.map(webAccountOf(deps, region)),
    models,
    enabledModelKeys: models.filter(m => enabledKeys.has(m.key)).map(m => m.key),
    offModelKeys,
    imageModelKeys: deps.imageModelKeys(region).filter(key => catalog.some(m => m.key === key)),
    ...(usageEntry?.usage?.credits === undefined ? {} : { credits: usageEntry.usage.credits }),
    ...(usageEntry?.error !== undefined ? { creditsError: redactQoderText(usageEntry.error) } : {}),
    // 上次**重读**失败、但快照完好：卡片/composer 显示旧数字并说明它旧，而不是
    // 把数字抹掉。这个覆盖层与 `refreshError` 字段在契约里写了几版，宿主此前
    // 从没人赋值（卡片分支一直是死代码）。
    ...(usageEntry?.staleError === undefined ? {} : { refreshError: redactQoderText(usageEntry.staleError) }),
    // 数据的**真实读取时刻**。composer 页脚此前显示的是「客户端 fetch 返回的
    // 时刻」，于是刷新失败时它会跟着更新 —— 看起来像数据是新的。宿主手里一直
    // 有 `atMs`，只是在上面那行被丢掉了。
    ...(usageEntry?.usage?.atMs === undefined ? {} : { creditsAtMs: usageEntry.usage.atMs }),
    ...(credentialRejected && recovery ? { credentialRejected: true, recovery } : {}),
    contextBudgets: budgets,
    thinkingEfforts: deps.thinkingEfforts(region),
    ...(pool === undefined ? {} : { pool }),
  }
}

/** Build the pool's web view, including per-account rows tied to the probes. */
async function buildPoolView(
  deps: QoderWebRouteDeps,
  region: QoderRegion,
  accounts: readonly QoderAccountEntryLike[],
  catalog: readonly QoderModelInfo[],
  /** The account actually billing traffic, from the region's resolved serving credential. */
  servingAccountId: string | undefined,
): Promise<QoderWebPool> {
  const pool = deps.pool!
  const prefs = pool.preferences(region)
  const probes = pool.poolProbes(region)
  const now = Date.now()
  const memberSet = new Set(prefs.memberAccountIds)
  /** 当前确实存在的账号 id —— 用来把配置里的残渣过滤掉。 */
  const knownIds = new Set(accounts.map(account => account.id))
  const targetId = prefs.targetModelId || ''
  const targetModels = catalog.map(m => ({
    id: m.key,
    name: m.displayName,
    // 「免费即 0」是 resolveTargetModel 的契约（只认 === 0）；付费模型透传真实
    // 倍率，让选项标签能定价（`名字 (x0.79)`）。此前只写免费项，付费模型一个
    // 数字都没有——读起来全像免费。
    creditMultiplier: m.isFree === true ? 0 : m.priceFactor,
    contextWindow: m.contextWindow,
  }))
  const target = resolveTargetModel(targetModels, prefs.targetModelId)

  // Membership is explicit; effective membership is what the pool can actually
  // resolve a credential for.
  //
  // `current` answers "who is BILLING traffic right now" — a DIFFERENT question
  // from "who the ranking says should serve" or "which model is the test
  // target". It must come from the region's resolved serving credential
  // (`servingAccountId`), never from the target model id or a list position:
  // guessing it would make the card assert a switch that was never applied.
  const checkinSupported = pool.checkinSupported(region)
  // 新形态（含刷新时刻）；dep 缺席（旧宿主）时退回旧的布尔表。
  const checkinSnapshot = pool.checkinSnapshot?.(region) ?? {}
  const checkinLegacy = pool.checkinState?.(region) ?? {}
  const effectiveIds: string[] = []
  const rows: QoderWebPoolAccount[] = []
  /**
   * 「serving 号自己是否已被排除」与「池里还有没有人能接管」。
   *
   * 这两件事必须在**循环之前**算出来，因为每一行的 `current` 都要用它。
   * 「还有没有人能接管」按 `prefs.memberAccountIds` 直接算，不等
   * `effectiveIds` —— 后者要跑完循环才知道，而循环里就要这个答案。
   * 判据与请求路径一致：成员 ∩ 未被排除（`nextFailoverCredential` 里
   * `rankPool(...)[0]` 用的同一条 `exclusionOf`）。
   */
  const servingExcluded = servingAccountId !== undefined
    && exclusionOf(probes[servingAccountId], now, target.modelId) !== undefined
  const anyMemberCanServe = prefs.memberAccountIds
    .some(id => exclusionOf(probes[id], now, target.modelId) === undefined)
  /**
   * 实际在服务的账号。
   *
   * 用户实拍（2026-10-18）：serving 号标着「当前使用」，同一行却写着
   * 「✗ 用量已达上限」，读起来像自相矛盾。工作簿（workbuddy）对这件事的处理
   * 是：serving 号被排除且无人接管时直接答 `undefined` —— 注释写明理由是
   * 「把它报成在用，会和正下方那张写着同一个号被限流的表自相矛盾」。
   *
   * 这里照做，但把条件收窄到**真的没人接管**：池开着、且所有成员都被排除。
   * 只要还有别的号能接管，`current` 就落在接管者身上（见下面的行循环），
   * 「有人在买单」这句话仍然成立。
   * 池关着时不做这个降级 —— 没有第二个人，报「没人在用」只会让标题变空。
   */
  const liveServing = servingExcluded && prefs.enabled && !anyMemberCanServe
    ? undefined
    : servingAccountId
  // 成员积分：卡片路由付费拉取（workbuddy 同规），失败降级为「—」而不是
  // 让整个文档失败。非成员不读（从未测量过，显示「—」是诚实的）。
  const memberCredits = await pool.memberCredits?.(region, prefs.memberAccountIds).catch(() => undefined)
  /**
   * 池开启时的**接管候选人**：`rankPool` 第一个可用的成员。
   *
   * ⚠️ 它**不是**「每个请求的第一发」——此前这里的注释把方向写反了。真实请求
   * 路径（`src/shim.ts` 的 `handleChat`）每次都先 `resolveServing()`，也就是
   * `store.resolve(sources, selectedAccountId)`：**第一发永远打给用户选中的号**。
   * 只有首字节之前被硬拒（auth / 限流 / 额度 / 瞬时），才走
   * `nextFailoverCredential` → `rankPool(candidates,...)[0]` 重试。所以这个
   * 候选人只在「选中号此刻被排除」时才会真正接管；选中号好着时，第一发根本
   * 轮不到它，把它报成「当前使用」同样是假话。
   *
   * 判据必须与请求路径逐字相同（同一个 `rankPool`、同一个 `orderAccountIds`、
   * 同一个目标模型作用域），否则接管发生时卡片会指错人。
   * 取不到候选（没有可用成员）时退回 `undefined` —— 说不出就不说。
   */
  let livePriorityAccount: string | undefined
  if (prefs.enabled) {
    const candidates = []
    for (const accountId of prefs.memberAccountIds) {
      const probe = probes[accountId]
      const reading = memberCredits?.get(accountId)
      candidates.push({
        account: { id: accountId, accountName: accountId },
        ...reading === undefined ? {} : { credits: reading },
        ...probe === undefined ? {} : { probe },
      })
    }
    const chosen = rankPool(candidates, now, target.modelId, prefs.orderAccountIds)
      .find(row => row.excludedBy === undefined)
    livePriorityAccount = chosen?.account.id
  }
  for (const account of accounts) {
    const member = memberSet.has(account.id)
    const probe = probes[account.id]
    // 按**目标模型**作用域判：卡片测的就是 `targetModelId`，所以拿它对。
    // 一条关于别的模型的结论不适用——A 可用、B 429 时，两个模型下都写
    // 「可用」就是错的（此前正是如此，因为 probe 不带模型）。
    const excludedBy = exclusionOf(probe, now, target.modelId)
    // 「此刻在发号」的真实判据（与请求路径逐字对齐，见上面 livePriorityAccount）：
    //   · 池开 **且** 选中号被排除 → 接管者（rankPool 第一个可用的成员）——
    //     每个请求仍先打给选中号，首字节前被拒后由接管者重试并计费。
    //   · 其余情形 → `liveServing`，即 `resolveServing` 的第一发目标：池开着但
    //     选中号好着时，第一发就在它身上，rankPool 名次只是候补；池关着时即使
    //     它被排除也是它 —— 没有换号机制，下一个请求确实还会打给它，报「在用」
    //     才是诚实的（`index.ts` 的 `accountCreditsOf` 同规）。
    // 被排除的号不会因此拿到绿点——点色由 `accountDotTone` 决定（current 且可用
    // 才绿），「当前」标记与红点并存说的是真话：它在服务，但它坏了。
    const isCurrent = prefs.enabled && servingExcluded
      ? livePriorityAccount === account.id
      : liveServing === account.id
    if (member) {
      const cred = await pool.credentialFor(region, account.id)
      if (cred !== undefined) effectiveIds.push(account.id)
    }
    const reading = member === true ? memberCredits?.get(account.id) : undefined
    rows.push({
      accountId: account.id,
      accountName: account.accountName,
      // 这个 PAT 归谁管：只有 `vault` 的能在这里删（见 QoderWebPoolAccount.source）。
      // 卡片据此不给 settings/env 的行显示删除按钮，而不是给一个点了会 409 的按钮。
      source: account.source,
      ...(reading === undefined ? {} : {
        credits: reading.total,
        expiringSoon: reading.expiringSoon,
        ...(reading.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: reading.nearestExpiryMs }),
      }),
      ...(probe === undefined ? {} : {
        probe: {
          outcome: probe.outcome,
          atMs: probe.atMs,
          ...(probe.source === undefined ? {} : { source: probe.source }),
          ...(probe.retryAtMs === undefined ? {} : { retryAtMs: probe.retryAtMs }),
          ...(probe.message === undefined ? {} : { message: probe.message }),
          // 透传作用域，卡片才能在「这条结论不是当前模型」时说出来。
          // 写侧加字段而读侧不透传，卡片就永远看不到它——那就是没改。
          ...(probe.modelId === undefined ? {} : { modelId: probe.modelId }),
        },
      }),
      ...(excludedBy === undefined ? {} : { excludedBy }),
      // 今天是否已签到 + 下一窗何时刷新：两者同源，都只有真打过上游才存在。
      // `undefined` 表示还没读过 —— UI 说「未知」而不是断言「未签到」
      // （见 QoderWebPoolAccount.checkedInToday）。`refreshAtMs` 缺席时不说倒计时，
      // 绝不用本地零点或「上次 +24h」编一个（用户实拍：官网页面上那个数字才是对的）。
      ...(checkinSupported && checkinSnapshot[account.id] !== undefined
        ? {
            checkedInToday: checkinSnapshot[account.id]!.claimed,
            ...(checkinSnapshot[account.id]!.refreshAtMs === undefined
              ? {}
              : { checkinRefreshAtMs: checkinSnapshot[account.id]!.refreshAtMs }),
          }
        : checkinSupported && checkinLegacy[account.id] !== undefined
          ? { checkedInToday: checkinLegacy[account.id] === true }
          : {}),
      current: isCurrent,
      member,
    })
  }

  /**
   * 「这一行的 current 是怎么来的」。
   *
   * 用户实拍（2026-10-18）：nick1064248741 标着「当前使用」，同一行却写着
   * 「✗ 用量已达上限」；上面 nick2223682662 还有 100 分、目标模型列写着
   * 「✓ 可用」。读起来像自相矛盾。真实请求路径（`src/shim.ts`）是：
   *
   *   · 每一发的第一击都是 `resolveServing()` —— 用户**选中**的号；池开着不会
   *     改变这一点（此前本文件的注释把它写成「请求先发 rankPool 第一名」，方向
   *     是反的，本轮已按代码逐行核实并纠正）。
   *   · 只有选中号在首字节前被硬拒，池才会让 `rankPool` 第一个可用的成员
   *     **接管**这次请求并由它计费。
   *
   * 所以 `current` 有两种来源，必须让 UI 说出来，否则「当前使用」与同一行的
   * 「用量已达上限」会读起来互相打架：
   *
   *   - `selected`：选中号在服务（池开与否都一样——它没被排除时第一发就在它身上）；
   *   - `failover`：选中号此刻被排除、接管者是这个成员 ——「接管」不是「回落」，
   *     它是当前唯一真正在买单的人。
   *
   * 还有一种更糟的情形（workbuddy 同款判断）：选中号被排除、而**池里没有别人
   * 能接管**时，`current` 全是 false、本字段缺席，配 `servingUnavailable: true` —
   * 「谁在计费」的诚实答案是「没有人」：下一个请求会直接失败而不是记在谁头上。
   */
  const servingSource = liveServing === undefined
    ? undefined
    : prefs.enabled && servingExcluded ? 'failover' : 'selected'
  /**
   * 清洗过的用户顺序：只保留**当前确实存在的账号**。
   *
   * 配置里的 `orderAccountIds` 在删除账号后不会自动收缩（与 `memberAccountIds`
   * 同一个残渣问题），原样透传会让卡片把名次算在一个已经不存在的行上。
   */
  const orderedIds = (prefs.orderAccountIds ?? []).filter(id => knownIds.has(id))
  return {
    enabled: prefs.enabled,
    checkinSupported: pool.checkinSupported(region),
    ...(target.modelId === undefined ? {} : { targetModelId: target.modelId }),
    ...(target.source === 'stale' && target.staleModelId !== undefined ? { staleTargetModelId: target.staleModelId } : {}),
    targetModelSource: target.source,
    ...(servingSource === undefined ? {} : { servingSource }),
    // 池开启时**选中号被拒后的接管候选**（rankPool 第一个可用的）。仅当选中号
    // 被排除时它才是「在发号的人」（`current` 已按这条判据落好）；面板不要拿它
    // 直接当绿点依据，读每行的 `current`。
    ...(livePriorityAccount === undefined ? {} : { priorityAccountId: livePriorityAccount }),
    // serving 号被排除、又没人接管：没有「在用的账号」这件事本身也是事实，
    // 交给卡片去说「池里没有可用的账号」而不是留一个空白标题。
    ...(servingExcluded && liveServing === undefined ? { servingUnavailable: true } : {}),
    memberAccountIds: prefs.memberAccountIds,
    // 只透传「真的还在池里的」id：删掉的账号残留在配置里时，卡片拿它排
    // 名次会得到一个指向不存在的行号。
    ...(orderedIds.length === 0 ? {} : { orderAccountIds: orderedIds }),
    ...(prefs.probeInputTokens && prefs.probeInputTokens > 0 ? { probeInputTokens: prefs.probeInputTokens } : {}),
    effectiveMemberAccountIds: effectiveIds,
    accounts: rows,
    catalog: targetModels,
  }
}
