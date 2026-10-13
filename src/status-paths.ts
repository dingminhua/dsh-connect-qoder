/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 *   `status-paths.ts` ——「同源路由常量 + 区域参数 + 与浏览器共享的
 *   node-free DTO + 配置读取 helper（volatile 解包）」的 host↔client
 *   桥梁形态整体沿用；其又上承 dingminhua/dsh-connect-trae（MIT）与
 *   corrinehu/dsh-workbuddy-connect（MIT）的 status-route 模式。
 * 改动（按 Qoder 上游的实际能力）：
 *   1. 凭据是 PAT，不是桌面端登录文件——没有 searched-paths 诊断，
 *      账号来源是 settings / 环境变量 / 插件自有保险库三种；
 *   2. 每日签到走 Qoder 的 campaigns 端点（CN 与国际版都已接通），池的批量动作
 *      因此是 checkin / test 两个；`checkinSupported` 仍按区域可判，字段保留；
 *   3. 扫码登录换成「添加 PAT」：accounts 路由的 add/remove 动作；
 *   4. 积分模型是「基础/附加/组织」三个额度桶，聚合成与家族一致的
 *      packages 形状；模型字段是倍率/上下文档位/推理与多模态标记。
 *
 * @module dsh-connect-qoder/status-paths
 */

// ---------------------------------------------------------------------------
// 路由常量
// ---------------------------------------------------------------------------

/** Plugin-owned usage endpoint consumed by its browser half. */
export const QODER_USAGE_PATH = '/plugins/dsh-connect-qoder/usage'

/**
 * Per-account credit balances for one region, read ONLY while the composer
 * panel is open.
 *
 * Separate from {@link QODER_USAGE_PATH} because its cost is different in
 * kind: the usage document is one upstream read for the selected account,
 * while this is one read PER account in the region. Folding it into the usage
 * route would make every 5-minute refresh pay for a table nobody is looking
 * at, so it is fetched on demand instead — the same principle the pool
 * applies to its per-account figures.
 */
export const QODER_ACCOUNT_CREDITS_PATH = '/plugins/dsh-connect-qoder/account-credits'

/**
 * The project's public repository.
 *
 * Lives here rather than beside one component because TWO sections link to it
 * — the model section and the account pool — and a second copy of a URL is a
 * second thing to forget when it moves. Node-free and side-effect free, so it
 * costs nothing on the Host side either.
 */
export const QODER_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-qoder'

/**
 * 创建 PAT 的逐步指南。挂在「添加 PAT」弹窗里而不是页脚：用户打开那个弹窗的
 * 时刻正是需要它的时刻，而页脚那条常驻提示已按用户要求删除。用仓库内的绝对
 * 地址（GitHub blob），因为 DSH 里没有内嵌文档路由可指。
 */
export const QODER_PAT_DOC_URL = `${QODER_GITHUB_URL}/blob/main/docs/PAT.md`

/** Plugin-owned live model refresh endpoint. */
export const QODER_MODELS_REFRESH_PATH = '/plugins/dsh-connect-qoder/models/refresh'

/** Plugin-owned account rescan endpoint (re-reads settings / env / vault). */
export const QODER_ACCOUNTS_REFRESH_PATH = '/plugins/dsh-connect-qoder/accounts/refresh'

/**
 * Plugin-owned account mutation endpoint: add or remove one account.
 *
 * `?action=add` POSTs `{ pat, name? }`: the Host validates the PAT against
 * the region's gateway (a jobToken exchange doubles as the cheapest
 * authenticated check and yields the account's display name) and stores it in
 * the plugin-owned vault. `?action=remove` POSTs `{ accountId }` and deletes
 * the vault entry. POST + loopback-only: both carry token material or mutate
 * stored credentials.
 */
export const QODER_ACCOUNTS_PATH = '/plugins/dsh-connect-qoder/accounts'

/**
 * Plugin-owned model probe endpoint.
 *
 * Sends one minimal chat request per named model so the card can answer "is
 * this model usable right now, and if it is limited, when can it be used
 * again?". Lives on the Host because the credential must never reach the
 * browser half.
 */
export const QODER_PROBE_PATH = '/plugins/dsh-connect-qoder/probe'

/**
 * Plugin-owned account-pool endpoint: one batch action per call.
 *
 * `?action=test` probes every checked account against the region's target
 * model; `?action=remove` drops one account's membership. Both are POST and
 * loopback-only because a probe spends credits and removal mutates a
 * preference.
 *
 * Deliberately ONE endpoint rather than two: the actions share every guard
 * (method, origin, region) and differ only in the work, so splitting them
 * would duplicate the guards and invite them to drift apart.
 */
export const QODER_POOL_PATH = '/plugins/dsh-connect-qoder/pool'

/**
 * Plugin-owned account transfer endpoint: the batch export / import of PAT
 * credentials between machines.
 *
 * `?action=export` POSTs account ids, answers a JSON ARRAY of credential
 * records; `?action=preview` POSTs file text, answers a token-free listing;
 * `?action=import` POSTs file text plus selected indexes, merges into the
 * vault. POST + loopback-only like every other mutation: the file content is
 * arbitrary user data and export carries token material.
 */
export const QODER_TRANSFER_PATH = '/plugins/dsh-connect-qoder/transfer'

/**
 * Plugin-owned settings write fallback: the card's writes go through the
 * settings mirror when it is healthy, and through this Host-side endpoint
 * when the mirror refuses or lags (a measured 0.1.7 behaviour the sibling
 * plugin hit: `settings/mutate` from the browser can leave the mirror stale
 * while the Host accepted the write).
 */
export const QODER_SAVE_PATH = '/plugins/dsh-connect-qoder/__save'

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

/**
 * Region of a Qoder account: the CN gateway (`qoder.com.cn`) or the
 * international one (`qoder.sh`). The card uses this to read and write the
 * matching per-region model slot.
 */
export type QoderWebRegion = 'cn' | 'global'

/** Query parameter naming the region a card request addresses. */
export const QODER_REGION_PARAM = 'region'

/** Every region, in card tab order. */
export const QODER_REGIONS: readonly QoderWebRegion[] = ['cn', 'global']

/**
 * Address one region's status route. The two regions are separate provider
 * stacks; every card request carries the region whose tab the user is on.
 */
export function withQoderRegion(path: string, region: QoderWebRegion): string {
  return `${path}?${QODER_REGION_PARAM}=${region}`
}

/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of guessing.
 */
export function regionOfStatusUrl(url: string): QoderWebRegion | undefined {
  const at = url.indexOf('?')
  const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(QODER_REGION_PARAM)
  if (value === null || value === '') return 'cn'
  return (QODER_REGIONS as readonly string[]).includes(value) ? value as QoderWebRegion : undefined
}

// ---------------------------------------------------------------------------
// 动作参数（pool / accounts / transfer 共用 `action` 查询参数）
// ---------------------------------------------------------------------------

/** Query parameter selecting which action a request means. */
export const QODER_ACTION_PARAM = 'action'

/**
 * The pool actions. `remove` is per-account and never batch-wide; `checkin`
 * 与 `test` 一样是批量动作（对勾选的成员逐个执行）。
 *
 * `checkin` 只在区域真的提供每日签到时才被路由接受（两个区域都有；国际版的
 * 活动只下发给带 UMID 设备风控头的请求）——见 `QoderWebPoolPreferences.checkinSupported`。
 */
export type QoderPoolAction = 'checkin' | 'test' | 'remove'

/** Read the pool action off a request URL; unknown/absent means undefined. */
export function poolActionOf(url: string): QoderPoolAction | undefined {
  const value = actionParamOf(url)
  return value === 'checkin' || value === 'test' || value === 'remove' ? value : undefined
}

/** The account mutation actions (see {@link QODER_ACCOUNTS_PATH}). */
export type QoderAccountAction = 'add' | 'remove'

/** Read the account action off a request URL; unknown/absent means undefined. */
export function accountActionOf(url: string): QoderAccountAction | undefined {
  const value = actionParamOf(url)
  return value === 'add' || value === 'remove' ? value : undefined
}

/** The transfer endpoint's steps. */
export type QoderTransferAction = 'export' | 'preview' | 'import'

/** Read the transfer action off a request URL; unknown/absent means undefined. */
export function transferActionOf(url: string): QoderTransferAction | undefined {
  const value = actionParamOf(url)
  return value === 'export' || value === 'preview' || value === 'import' ? value : undefined
}

/** Every action the shared `action` query parameter can carry. */
export type QoderRouteAction = QoderPoolAction | QoderAccountAction | QoderTransferAction

/**
 * Address one region's endpoint for ANY route that dispatches on `action`.
 *
 * The accounts and transfer routes reject a request with no action (400), so
 * their callers must build the URL here rather than with
 * {@link withQoderRegion} — a request missing the parameter fails the same
 * way whether the omission was a mistake or not.
 */
export function withQoderRouteAction(
  path: string,
  region: QoderWebRegion,
  action: QoderRouteAction,
): string {
  return `${withQoderRegion(path, region)}&${QODER_ACTION_PARAM}=${action}`
}

/** Read the shared action parameter; unknown/absent means undefined. */
function actionParamOf(url: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(QODER_ACTION_PARAM)
  return value === null || value === '' ? undefined : value
}

/** Query parameter naming ONE pool account a per-row request addresses. */
export const QODER_POOL_ACCOUNT_PARAM = 'accountId'

/** Read the per-row account id off a request URL, when the action takes one. */
export function poolAccountIdOf(url: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(QODER_POOL_ACCOUNT_PARAM)
  return value !== null && value !== '' ? value : undefined
}

/** Address one region's pool endpoint with an action. */
export function withQoderRegionAndAction(
  path: string,
  region: QoderWebRegion,
  action: QoderPoolAction,
): string {
  return `${withQoderRegion(path, region)}&${QODER_ACTION_PARAM}=${action}`
}

/** All region keys, in display order. The single source for region loops. */
export const QODER_WEB_REGIONS: readonly QoderWebRegion[] = ['cn', 'global']

/** Every domain {@link knownQoderRegionOfDomain} admits, i.e. the transfer domains. */
const TRANSFER_DOMAINS: readonly string[] = ['qoder.com.cn', 'qoder.sh']

/**
 * The login domain a transfer record must carry to belong to a region.
 *
 * Qoder has two gateways with distinct hosts, so a transferred PAT identifies
 * its region by the host it was minted against — `qoder.com.cn` is the CN
 * gateway's domain, `qoder.sh` the international one.
 */
export function knownQoderRegionOfDomain(domain: string): QoderWebRegion | undefined {
  if (domain === 'qoder.com.cn') return 'cn'
  if (domain === 'qoder.sh') return 'global'
  // An empty/spoofed/misspelled value is NOT admitted to either vault.
  return undefined
}

/**
 * 该区域的**传输域名**：导出账号时写进 transfer 文件的 `domain` 字段。
 *
 * 与 {@link knownQoderRegionOfDomain}（域名 → 区域）是同一组事实的**反向读法**，
 * 所以在这里定义、并从那张反查表**推导**出来，而不是再手抄一遍域名 —— 手抄才是
 * 这两处漂移过一次就很难被发现的原因。推导失败即抛错，让漏登记的区域在编译期
 * 与首屏就暴露，而不是等到用户导出才发现。
 *
 * 注意这与 {@link QODER_CONSOLE_DOMAIN} **不是同一个域名**：那边是用户浏览器里
 * 申请 PAT 的控制台（国际版是 `qoder.com`），这边是 PAT 实际发证方所在的网关域
 * （国际版是 `qoder.sh`），导入时的区域门只认后者。
 */
export const QODER_REGION_TRANSFER_DOMAIN: Readonly<Record<QoderWebRegion, string>> = (() => {
  const table = {} as Record<QoderWebRegion, string>
  for (const region of QODER_WEB_REGIONS) table[region] = ''
  for (const domain of TRANSFER_DOMAINS) {
    const region = knownQoderRegionOfDomain(domain)
    if (region === undefined) throw new Error(`transfer domain is not a known Qoder region: ${domain}`)
    table[region] = domain
  }
  for (const region of QODER_WEB_REGIONS) {
    if (table[region] === '') throw new Error(`region has no transfer domain: ${region}`)
  }
  return table
})()

/**
 * 该区域的**控制台域名**，用于「PAT 去哪弄」这句说明。
 *
 * 与 {@link knownQoderRegionOfDomain} 是同一组事实的两种读法（那边由域名反查
 * 区域，这边由区域正查域名），所以放在一起维护 —— 两处域名漂移过一次就很难
 * 被发现。
 *
 * 注意国内版是 `qoder.com.cn`（控制台在 `https://qoder.com.cn` → 设置 →
 * API 令牌），**不是** `api.qoder.com.cn`（那个返回 503）。国际版是 `qoder.com`
 * （不是网关用的 `qoder.sh`）—— 用户在浏览器里看到的是前者。
 */
export const QODER_CONSOLE_DOMAIN: Readonly<Record<QoderWebRegion, string>> = {
  cn: 'qoder.com.cn',
  global: 'qoder.com',
}

// ---------------------------------------------------------------------------
// 探针体量（见 host 侧 `probe.ts`；这里不重复声明，避免两处菜单漂移）
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 传输文件（导出/导入）
// ---------------------------------------------------------------------------

/**
 * One entry of the transfer PREVIEW: display fields only, never token
 * material. `hasToken` is the import decision input — the import step skips
 * records without one — and the indexes are the FILE's positions, so the user
 * picks by the same numbers the import call sends back.
 */
export interface QoderTransferPreviewEntry {
  index: number
  uid: string
  nickname: string
  email: string
  hasToken: boolean
}

/** The preview answer: the desensitized listing plus the file's total count. */
export interface QoderTransferPreview {
  accounts: readonly QoderTransferPreviewEntry[]
  total: number
}

/**
 * The import answer. `imported` counts records merged into the vault (new OR
 * overwritten — both change the stored entry); `skipped` counts what was left
 * out: missing token, a bad index, or a record whose domain does not belong
 * to the addressed region.
 */
export interface QoderTransferImportAnswer {
  imported: number
  skipped: number
}

/**
 * The shared file format's record shape, subset the importer consumes.
 *
 * Contract kept from the sibling plugin so the same tooling reads both: a
 * JSON array of objects keyed in snake_case — `access_token` (required; the
 * PAT), `uid`, `nickname`, `email`, `domain` (`qoder.com.cn` / `qoder.sh`).
 * Extra fields ride along untouched.
 */
export interface QoderTransferRecord {
  access_token: string
  refresh_token?: string
  uid?: string
  nickname?: string
  email?: string
  domain?: string
  /** Token expiry in epoch MILLISECONDS, when known (PATs usually have none). */
  expiresAt?: number
}

/** The export answer: the records themselves, tokens included. */
export interface QoderTransferExportAnswer {
  accounts: QoderTransferRecord[]
}

// ---------------------------------------------------------------------------
// 积分 / 用量
// ---------------------------------------------------------------------------

/** One credit bucket as the card renders it, node-free. */
export interface QoderWebCreditPackage {
  /** Stable bucket key — 'base' | 'addon' | 'org'; the card localizes it. */
  packageName: string
  remain: number
  size: number
  /** Qoder has no monthly-refresh bucket; kept for the family shape. */
  monthly: boolean
  /** One-off expiry in ms, when the upstream states one. */
  expiresAtMs?: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface QoderWebCredits {
  total: number
  packages: readonly QoderWebCreditPackage[]
  /** Credits expiring within 3 days across every bucket. */
  expiringSoon: number
  /** When the nearest bucket expires, in ms. */
  nearestExpiryMs?: number
}

/**
 * What the user can do about a credential the upstream refused.
 *
 * Two different fixes hide behind one 401, and naming the wrong one is worse
 * than saying nothing: with a stale PAT SELECTED but a healthy one sitting in
 * the vault, "paste a new PAT" sends the user to re-create a token — which
 * changes nothing, because the credentials were never the problem.
 */
export interface QoderWebRecovery {
  /**
   * Another stored PAT answered the upstream during recovery, so switching to
   * it is a VERIFIED fix rather than a suggestion.
   */
  usableAccount?: { accountId: string, accountName: string }
  /**
   * Adding a fresh PAT is the only remaining fix: this region has no other
   * stored credential to switch to. Set only in that case — never as a
   * fallback for "nothing could be verified".
   */
  reloginRequired: boolean
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** Editable Qoder model row rendered by the plugin-owned settings card. */
export interface QoderWebModel {
  key: string
  name: string
  /** Effective DSH context after applying the saved local budget. */
  contextWindow: number
  /**
   * Native maximum advertised by the gateway, never clamped by a default.
   *
   * Models with several `context_config` tiers expose the tier selector;
   * whether the window is actually reduced is the user's stored
   * `contextBudgets` decision and nothing else.
   */
  nativeContextWindow: number
  maxTokens: number
  /** Credit multiplier (`price_factor`); absent means the gateway said none. */
  creditMultiplier?: number
  /** Upstream's image-input declaration (`is_vl`). */
  supportsImages?: boolean
  /** Upstream's reasoning declaration (`is_reasoning`). */
  supportsThinking?: boolean
  /**
   * Upstream's "thinking can be turned off" declaration
   * (`thinking_config.disabled` present). Carried through the card so it
   * RIDES ALONG in the saved `lastCatalog` entry: it is a persistence detail,
   * not the runtime answer — the adapter's level map is built from the
   * effective value stamped by the Host.
   */
  canDisableThinking?: boolean
  /**
   * Upstream's selectable thinking strengths (`thinking_config.enabled.efforts`
   * keys), ordered weakest → strongest.
   *
   * Names differ per model family (Qwen: `low/medium/xhigh`; DeepSeek/GLM:
   * `low/high/max`), and the upstream's own key order is NOT meaningful, so the
   * Host sorts them before they reach the card. Absent means the model declares
   * no choices — the row then omits the line rather than showing an empty one.
   */
  thinkingEfforts?: readonly string[]
  /** The strength upstream marks as default (`efforts[x].is_default`). */
  defaultThinkingEffort?: string
  isDefault?: boolean
  isFree?: boolean
  isNew?: boolean
  /** Context tiers offered by the gateway (`context_config`), ascending. */
  contextTiers?: readonly number[]
}

/**
 * The `lastCatalog` entry the Host's `modelConfig` schema actually declares.
 *
 * 只是**读取端视角的类型**（`modelFromStored` 解析出来的形状），不是投影的
 * 白名单 —— 投影按 workbuddy 的 spread 写法，白名单化就又会漂移。
 *
 * 布尔项与卡片行同样标成可选：投影 spread 卡片行，行的可选性就是落盘的可选性。
 * 运行时它们其实**总是**带值（`webModelOf` 从 `QoderModelInfo` 的必填布尔项
 * 无条件赋值），由 `tests/persisted-catalog.spec.tsx` 的「无 `undefined` 值」
 * 用例（照 workbuddy 同名用例）钉住 —— 那才是真正的保护，类型标注只是描摹。
 */
export interface QoderPersistedModel {
  key: string
  displayName: string
  priceFactor: number
  contextWindow: number
  maxOutputTokens: number
  supportsImages?: boolean
  supportsThinking?: boolean
  canDisableThinking?: boolean
  isDefault?: boolean
  isFree?: boolean
  isNew?: boolean
  thinkingEfforts?: readonly string[]
  defaultThinkingEffort?: string
  contextTiers?: readonly number[]
}

/**
 * Project one card row into its persisted `lastCatalog` entry.
 *
 * **写法照 `dsh-connect-workbuddy` 的 `toPersistedWorkBuddyModel`**：spread 整行
 * 再按名剔除卡片独有字段，**不逐个字段手写白名单**。这是同一处缺陷的第二次
 * 出诊 —— workbuddy 的注释写着「omitting it made one Save silently strip the
 * declaration from every model」：白名单只要漏一个字段，那次保存就把该字段从
 * 每个模型上抹掉，而且**没有任何东西会报错**。本仓库正是这样丢掉
 * `thinkingEfforts` / `defaultThinkingEffort` 的（用户实拍「每次保存都会思考
 * 强度不见了」）：卡片手写映射漏了这两个键，而读取端 `modelFromStored` 的判据是
 * `length > 0`、缺席的声明会被 schema 补成 `[]`，于是档位选择器整个消失。
 * 改成白名单只是把「漏」换了个位置，所以**必须**是 spread。
 *
 * 三处字段名在落盘时与卡片行不同，必须重命名（读取端 `modelFromStored` 只认
 * 落盘名）：`name → displayName`、`maxTokens → maxOutputTokens`、
 * `creditMultiplier → priceFactor`。**这三对名字必须与读取端逐字一致**，
 * 否则解析出 `undefined` → 回落默认值（`modelFromStored` 对
 * `maxOutputTokens` 默认 32 768，旧代码写的 `maxTokens` 因此从没被读到过）。
 *
 * 剔除的卡片独有键：
 * - `nativeContextWindow` —— 它的值已经装进 `contextWindow`（落盘存**原生**
 *   窗口，生效窗口由 `applyContextBudgets` 在读取时重新施加，见 issue 语境）。
 * - `maxTokens` / `name` / `creditMultiplier` —— 已重命名，原名不能带上去。
 *
 * **绝不写成 `undefined` 值**：显式 `undefined` 会挺过 `structuredClone`，被设置
 * 写入端那道严格 JSON codec 拒收（`client api: settings/mutate rejected "ops"`），
 * 整次保存失败。这里用解构剔除（真的没有这个键），而不是赋 `undefined`。可选键
 * 缺席时由 schema 的 `required(false)` 兜底，不需要在这里补默认值。
 *
 * `supportsImages` 是**覆盖**而非派生：卡片的待保存草稿持有用户尚未保存的勾选，
 * 而 model 上带的是上次保存过的值；从 model 派生会把用户刚勾的那一下在本次保存
 * 中抹掉。它是上游自己的声明（`is_vl`），随条目落盘、但运行时能力由独立的
 * `imageModelKeys` 盖印决定（同 workbuddy 的 `supportsImages` / `multimodal` 之分）。
 */
export function toPersistedCatalogEntry(
  model: QoderWebModel,
  overrides: { supportsImages?: boolean } = {},
): QoderPersistedModel {
  const {
    name,
    maxTokens,
    creditMultiplier,
    nativeContextWindow,
    thinkingEfforts,
    defaultThinkingEffort,
    contextTiers,
    supportsImages,
    ...rest
  } = model
  return {
    ...rest,
    displayName: name,
    maxOutputTokens: maxTokens,
    priceFactor: typeof creditMultiplier === 'number' ? creditMultiplier : 1,
    // 落盘存**原生**窗口：生效窗口是用户预算决定的事，读回来时重新施加，
    // 所以这里不能写 `model.contextWindow`（那是已应用预算的生效值）。
    contextWindow: nativeContextWindow,
    supportsImages: overrides.supportsImages ?? supportsImages === true,
    // 可选字段按缺席剔除，绝不留 `undefined`（严格 JSON codec）。空数组/空串
    // 也算「没声明」：读取端判据就是 `length > 0` 与非空串。
    ...thinkingEfforts === undefined || thinkingEfforts.length === 0
      ? {}
      : { thinkingEfforts: [...thinkingEfforts] },
    ...defaultThinkingEffort === undefined || defaultThinkingEffort === ''
      ? {}
      : { defaultThinkingEffort },
    ...contextTiers === undefined || contextTiers.length === 0
      ? {}
      : { contextTiers: [...contextTiers] },
  }
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/** One selectable account, token-free. */
export interface QoderWebAccount {
  id: string
  /** The account's human name, or `''` when none is known. */
  accountName: string
  /**
   * Where the credential came from: the settings card's PAT field, an
   * environment variable, or the plugin-owned vault (added on the card or
   * imported from a transfer file).
   */
  source: 'settings' | 'env' | 'vault'
  selected: boolean
}

/**
 * One account's credit balance, for the composer panel's table.
 *
 * `credits` is ABSENT when that account's balance could not be read — a
 * credential the upstream refused, or a gateway that did not answer.
 * Deliberately not `0`: a zero is a claim about the account, and the panel
 * renders an absent figure as "—" instead of telling the user they are out
 * of credits.
 */
export interface QoderWebAccountCredit {
  id: string
  accountName: string
  selected: boolean
  credits?: number
  /**
   * Why this account cannot serve right now, or absent when nothing is wrong
   * (or nothing has been measured yet). The composer panel marks the row with
   * this so the user can see, before switching, that an account is
   * rate-limited.
   */
  excludedBy?: QoderWebPoolExclusion
}

// ---------------------------------------------------------------------------
// 探针
// ---------------------------------------------------------------------------

/**
 * Outcome vocabulary of one model probe, shared by the Host and the card.
 *
 * Mirrors `QoderProbeOutcome` in `./probe.ts`; kept as its own declaration
 * here because this module is the node-free bridge and must not import the
 * Host-side probe module.
 */
export type QoderWebProbeOutcome =
  | 'ok'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'policy-rejected'
  | 'unavailable'
  | 'not-found'
  | 'failed'

/** One model's probe result, as the card renders it. */
export interface QoderWebProbeResult {
  modelId: string
  outcome: QoderWebProbeOutcome
  /** Round-trip time in ms; present once the request landed. */
  elapsedMs?: number
  /** HTTP status the upstream answered with; 0 means it never landed. */
  status?: number
  /** Upstream's own words, already redacted. */
  message?: string
  /**
   * A time the upstream named for using this model again, in ms.
   *
   * ABSENT means the upstream named none, and the card must say exactly that.
   * A client-invented countdown here would be fiction. Sources: a reset
   * sentence in the failure body, or a `Retry-After`/`Date` header pair.
   */
  retryAtMs?: number
  /** Which source supplied {@link retryAtMs}. */
  retrySource?: 'retry-after' | 'upstream-message' | 'quota-refresh'
}

/** The probe endpoint's answer document. */
export interface QoderWebProbeAnswer {
  results: readonly QoderWebProbeResult[]
}

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------

/** Why one account is currently out of the pool. */
export type QoderWebPoolExclusion =
  | 'unusable'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'not-found'
  | 'unavailable'
  | 'failed'

/**
 * One account's row in the pool, as the card renders it.
 *
 * Ties together the three facts the card shows per account — credits, the
 * last test, and whether it is currently eligible — so the ranking the card
 * displays comes from ONE Host answer rather than being re-derived in the
 * browser.
 */
export interface QoderWebPoolAccount {
  accountId: string
  accountName: string
  /** Total remaining credits, absent when the credits read failed. */
  credits?: number
  /** Credits expiring within the card's "soon" window (3 days). */
  expiringSoon?: number
  /** When the nearest bucket expires, in ms. */
  nearestExpiryMs?: number
  /** The last test of the target model, absent when never tested. */
  probe?: {
    outcome: QoderWebProbeOutcome
    atMs: number
    /**
     * What wrote this measurement, so the card can explain a change the user
     * watched happen: `test-batch` is a deliberate test, `live-request` is a
     * real request that failed and overwrote it. ABSENT for records written
     * before the field existed — the card must then say "unknown" rather than
     * guess which of the two it was.
     */
    source?: 'test-batch' | 'live-request'
    /** Only when the upstream named a time; never invented locally. */
    retryAtMs?: number
    /** Why it failed, in the upstream's own redacted words. */
    message?: string
  }
  /**
   * 今天是否已签到。`undefined` = 还没读过（UI 说「未知」，而不是断言「未签到」
   * ——那会与用户刚亲眼看到的领取结果矛盾）；只有真的读到了才给 true/false。
   * 仅在 `checkinSupported` 为 true 的区域有意义。
   */
  checkedInToday?: boolean
  /**
   * 下一窗每日签到的开门时刻（epoch 毫秒，来自上游活动行的 `endAt`）。
   *
   * **上游给的，不是本地按零点或「上次 +24h」算的**：实测活动窗是当天 10:00 到
   * 次日 09:59（UTC+8），与官方页面「每日 10:00（UTC+8）刷新」一致 —— 用户实拍
   * 里那个 `09:22:23` 就是 `endAt − 当前时间`。
   *
   * 缺席 = 上游没给这个时间（UI 就只说「已领取」，**绝不**编一个本地猜测）。
   */
  checkinRefreshAtMs?: number
  /** Set when this account cannot serve right now. */
  excludedBy?: QoderWebPoolExclusion
  /** Whether this is the account currently billing traffic for the region. */
  current: boolean
  /**
   * Whether the user checked this account into the pool.
   *
   * Listed rows include UNCHECKED accounts so the card can offer them to
   * check: membership is an explicit opt-in, and a user can only opt in to
   * something they can see. Only checked rows can bill or be batched.
   *
   * Membership is expressed by the row's CHECKBOX, never by a separate "remove
   * from pool" button: the checkbox already says "is this a member" and the
   * Save button already persists it, so a second control for the same fact can
   * only drift from it (workbuddy 同规).
   */
  member: boolean
  /**
   * Where this account's credential comes from — and therefore whether it can
   * be deleted here at all.
   *
   * `vault` is the only deletable source: those PATs were added through this
   * plugin and are stored in its vault. A `settings` / `env` PAT is owned by
   * whoever set it outside the plugin, so the delete route refuses it with
   * `account-not-deletable` rather than reporting a removal that changed
   * nothing. The card hides the delete button for those rows instead of
   * offering one that cannot work.
   */
  source: 'settings' | 'env' | 'vault'
}

/** One model as the pool's target picker needs it. */
export interface QoderWebPoolModel {
  id: string
  name: string
  /** Absent when the upstream stated no multiplier (NOT the same as free). */
  creditMultiplier?: number
}

/**
 * The pool's state for one region.
 *
 * `targetModelId`/`targetModelSource` exist so the card can state WHICH model
 * a test would use and WHERE that choice came from. `none` is a real, common
 * answer (a region whose catalog names no free model) and the card renders it
 * as "no free model" rather than silently substituting a paid one.
 */
export interface QoderWebPool {
  enabled: boolean
  /**
   * Whether this region offers a daily check-in.
   *
   * **CN 为 true**（`GET /sash/api/v1/me/campaigns` 拉活动、POST `/{id}/claim`
   * 领取，已实测）。早先这里写死 false 并注释「网关没有签到端点」——那是没实测
   * 就下的结论：真实路径叫 `campaigns`（活动/权益），名字里没有「签到」二字，
   * 所以照着 checkin / signin 猜必然 404。
   *
   * 国际版同样有该活动，但需要本机 UMID 组件生成的设备风控头
   * （`Cosy-MachineToken` / `MachineCode` / `MachineType`），暂未接通，故为
   * false —— 字段保留，卡片按它隐藏整个签到列与按钮。
   */
  checkinSupported: boolean
  /** The model a test would use right now; absent when none can be resolved. */
  targetModelId?: string
  /**
   * The saved target id that is no longer offered by this region's catalog.
   * Present only when {@link targetModelSource} is `'stale'`.
   */
  staleTargetModelId?: string
  /** Where the target came from. */
  targetModelSource: 'preferred' | 'free' | 'none' | 'stale'
  /** The account ids the user has checked into this region's pool. */
  memberAccountIds?: readonly string[]
  /**
   * Tokens each test probe sends, as the user saved it; `0`/absent = default.
   * The SAVED value, not the resolved one: the card needs to tell "the user
   * never chose a size" apart from "the user chose 25000".
   */
  probeInputTokens?: number
  /**
   * The subset of {@link memberAccountIds} that resolves to a stored
   * credential — i.e. what a batch actually runs on. Sent so the card never
   * re-derives it.
   */
  effectiveMemberAccountIds?: readonly string[]
  accounts: readonly QoderWebPoolAccount[]
  /**
   * The models a manual target can be chosen from, TRIMMED to what the picker
   * renders (id, name, multiplier): the model table above already ships the
   * full roster in the same document.
   */
  catalog?: readonly QoderWebPoolModel[]
}

/** One account's check-in row, as the card renders it. */
export interface QoderWebPoolCheckinRow {
  accountId: string
  accountName: string
  /**
   * `claimed` = 这次领到了；`already` = 今天已经领过（幂等，**不是**失败）；
   * `failed` = 真的失败了（凭据被拒、上游报错）。
   */
  status: 'claimed' | 'already' | 'failed'
  /** 本次领取到的 Credits 数（`claimed` 时）。 */
  credit?: number
  /** 有效天数（`claimed` 时），来自 `benefit.validity.days`。 */
  validityDays?: number
  /**
   * 下一窗每日签到的开门时刻（epoch 毫秒，来自上游活动行的 `endAt`）。
   *
   * `already` 时**同样要有**：「已领过」这句话离开「还有多久刷新」是不完整的 ——
   * 领取不是「今天到此为止」。实测活动窗是当天 10:00 → 次日 09:59（UTC+8）。
   * 缺席 = 上游这次没给（UI 就只说「已领取」，不编本地猜测）。
   */
  refreshAtMs?: number
  message?: string
}

/** The pool endpoint's answer for `action=checkin`. */
export interface QoderWebPoolCheckinAnswer {
  action: 'checkin'
  rows: readonly QoderWebPoolCheckinRow[]
}

/** One account's test row, as the card renders it. */
export interface QoderWebPoolTestRow {
  accountId: string
  accountName: string
  result: QoderWebProbeResult
}

/** The pool endpoint's answer for `action=test`. */
export interface QoderWebPoolTestAnswer {
  action: 'test'
  /** The model actually tested; absent when none could be resolved. */
  modelId?: string
  rows: readonly QoderWebPoolTestRow[]
}

// ---------------------------------------------------------------------------
// 用量快照（卡片的主文档）
// ---------------------------------------------------------------------------

/** The JSON document the plugin card renders. */
export type QoderWebUsage =
  /**
   * Not usable right now. `accounts` is still populated so the picker can
   * offer a way out, and `selectionLost` separates the two very different
   * reasons this happens: stored PATs exist but the SAVED choice no longer
   * matches any of them (re-select it, or clear it to follow the default),
   * versus nothing usable was stored at all (paste a PAT). Only the latter
   * makes the "add a PAT" hint truthful.
   */
  | {
    status: 'signed-out'
    accounts: readonly QoderWebAccount[]
    /** Whether this region's provider is currently offered to DSH. */
    enabled?: boolean
    /**
     * Whether this region's composer credit line is shown. Carried on the
     * Host's answer rather than read from the browser settings mirror: on
     * affected 0.1.7 deployments the mirror never picks up writes made
     * through the Host save endpoint, so a control reading it kept showing
     * the old value.
     */
    showCreditsInMainUi?: boolean
    message?: string
    /** The persisted account id matches no stored credential. */
    selectionLost?: boolean
    /** A saved per-region choice is in effect (false = following the default). */
    selectionExplicit: boolean
    /**
     * The account pool, present even with **zero** accounts.
     *
     * The pool section is the only surface that offers "add a PAT" and
     * export/import, so omitting it here left the one state that most needs an
     * add-account entry — a region with nothing stored — without any way in.
     * "No account is billing right now" is expressed per row (`current`), not by
     * this section's absence. Absent only when the Host serves no pool deps.
     */
    pool?: QoderWebPool
  }
  | {
    status: 'signed-in'
    accountId: string
    /** The account's human name, or `''` when none is known. */
    accountName: string
    /** Which per-region model directory and selection this account owns. */
    region: QoderWebRegion
    /** Whether this region's provider is currently offered to DSH. */
    enabled?: boolean
    /** See the signed-out variant. */
    showCreditsInMainUi?: boolean
    source?: 'settings' | 'env' | 'vault'
    /** A saved per-region choice is in effect (false = following the default). */
    selectionExplicit: boolean
    accounts: readonly QoderWebAccount[]
    models: readonly QoderWebModel[]
    enabledModelKeys: readonly string[]
    /**
     * Model keys whose `off` thinking level is offered: the saved selection,
     * seeded from the built-in rule (the upstream declaration) the first time
     * it is read.
     */
    offModelKeys: readonly string[]
    /**
     * Model keys the user explicitly enabled image input for — the ONLY source
     * of image capability, never the upstream's platform `is_vl` flag (see
     * `native-modality.ts`). Stored independently of `lastCatalog` so a
     * directory rewrite cannot silently change a model's image answer.
     */
    imageModelKeys: readonly string[]
    credits?: QoderWebCredits
    creditsError?: string
    /**
     * The LAST refresh failed, but the snapshot below is intact. Carried as
     * an overlay so a failed re-read never blanks the panel.
     */
    refreshError?: string
    /**
     * The upstream refused the credential itself (a 401/403 / business 105),
     * as opposed to a transient upstream fault. Distinguishes "your PAT is
     * not usable" from "the request failed", which need opposite advice.
     */
    credentialRejected?: boolean
    /** Present only alongside {@link credentialRejected}. */
    recovery?: QoderWebRecovery
    /** This region's account-pool state. */
    pool?: QoderWebPool
    /**
     * The persisted per-region context budgets as the Host reads them. The
     * browser settings mirror can lag a write made through the Host save
     * endpoint, so the card renders these rather than a possibly-stale
     * snapshot.
     */
    contextBudgets?: Record<string, number>
    /**
     * The saved thinking strength per model key (`low` / `medium` / `xhigh` …).
     *
     * This is a SETTING, not a per-request choice: once saved, every request for
     * that model carries it — the same shape as Qoder's own client, whose event
     * is literally `reasoning-effort-changed`. An absent key means the model's
     * own default strength.
     */
    thinkingEfforts?: Record<string, string>
  }
  | { status: 'error', message: string }

// ---------------------------------------------------------------------------
// 配置读取 helper（host 与浏览器共用；volatile 解包）
// ---------------------------------------------------------------------------

/**
 * Deep copy of a settings value with every `{get(): T}` live reference
 * replaced by the value it resolves to.
 *
 * `regions` is declared `asVolatile(...)`, and schemastery resolves a volatile
 * field to a live reference. A live reference is still `typeof === 'object'`,
 * so `{ ...reference }` does NOT read the field: it produces
 * `{ get: <function> }`. Any caller that spreads the resolved field to
 * preserve its siblings would otherwise DROP every sibling and leak a
 * function into the document. Both halves therefore unwrap before touching a
 * resolved field.
 */
export function unwrapVolatileDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (typeof (value as { get?: unknown }).get === 'function') {
    return unwrapVolatileDeep((value as unknown as { get: () => unknown }).get()) as T
  }
  if (Array.isArray(value)) return value.map(entry => unwrapVolatileDeep(entry)) as T
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    out[key] = unwrapVolatileDeep(source[key])
  }
  return out as T
}

/**
 * Narrow a settings value to the `regions` map. Accepts EITHER the whole
 * settings section (the Host's resolved `Config`) OR the `regions` map
 * itself, and unwraps the former. This tolerance is deliberate: passing the
 * whole section where the map was expected was a real shipped bug in the
 * sibling project — the lookup then read `section['cn']` (absent), so the
 * card's checkbox reported `true` forever.
 */
function regionsMapOf(value: unknown): Record<string, unknown> {
  const unwrapped = unwrapVolatileDeep(value)
  if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) return {}
  const record = unwrapped as Record<string, unknown>
  const nested = record['regions']
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return record
}

/** One region's stored slot as a plain object; any other shape reads as empty. */
function regionSlotOf(value: unknown, region: QoderWebRegion): Record<string, unknown> {
  const slot = regionsMapOf(value)[region]
  return typeof slot === 'object' && slot !== null && !Array.isArray(slot)
    ? slot as Record<string, unknown>
    : {}
}

/**
 * Whether one region's provider is switched on. Opt-out semantics: only an
 * explicit `false` disables it, so a config written before this switch
 * existed keeps both providers running exactly as before. The Host reads the
 * same rule through `regionStateOf`, so card and Host can never disagree.
 */
export function regionEnabledOf(value: unknown, region: QoderWebRegion): boolean {
  return regionSlotOf(value, region)['enabled'] !== false
}

/** Build the next `regions` settings value replacing one region's slot. */
export function nextRegionSlots<Slot extends object>(
  regions: unknown,
  region: QoderWebRegion,
  slot: Slot,
): Record<string, unknown> {
  const base = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  return { ...base, [region]: slot }
}

/**
 * Build the next `regions` settings value for a MODEL-LIST save.
 *
 * The model save replaces part of a region slot, so the merge has to start
 * from the EXISTING slot: the pool's preferences and the PAT live in that
 * same slot, and a save that omitted them would delete settings the user
 * configured elsewhere in the card.
 */
export function nextRegionModels(
  value: unknown,
  region: QoderWebRegion,
  models: Record<string, unknown>,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    ...models,
  })
}

/**
 * Build the next `regions` settings value for a POOL-PREFERENCES save.
 *
 * Same reasoning as {@link nextRegionModels}: the pool is one field of a slot
 * that also holds the model list, so the merge starts from the existing slot.
 */
export function nextRegionPool(
  value: unknown,
  region: QoderWebRegion,
  pool: Record<string, unknown>,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    pool,
  })
}

/**
 * Build the next `regions` settings value for a provider on/off toggle. ONLY
 * the target region's `enabled` flag changes: every other field of that slot
 * and every other region's slot are carried over verbatim.
 */
export function nextRegionEnabled(
  value: unknown,
  region: QoderWebRegion,
  enabled: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, { ...regionSlotOf(value, region), enabled })
}

/**
 * Whether one region's composer credit line is shown. Opt-out: only an
 * explicit `false` hides it.
 */
export function regionCreditsShownOf(value: unknown, region: QoderWebRegion): boolean {
  return regionSlotOf(value, region)['showCreditsInMainUi'] !== false
}

/**
 * Build the next `regions` settings value for the composer-credit on/off
 * toggle. Same merge rule as {@link nextRegionEnabled}.
 */
export function nextRegionCreditsShown(
  value: unknown,
  region: QoderWebRegion,
  shown: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    showCreditsInMainUi: shown,
  })
}

/**
 * The pool preferences stored in one region's slot, with defaults applied.
 *
 * `memberAccountIds` defaults to EMPTY — an explicit opt-in with no implicit
 * members, because the batch actions spend real credits.
 */
export function poolPreferencesOf(value: unknown, region: QoderWebRegion): {
  enabled: boolean
  targetModelId: string
  probeInputTokens: number
  memberAccountIds: string[]
} {
  const slot = regionSlotOf(value, region)
  const pool = slot['pool']
  const record = typeof pool === 'object' && pool !== null && !Array.isArray(pool)
    ? pool as Record<string, unknown>
    : {}
  return {
    enabled: record['enabled'] === true,
    targetModelId: typeof record['targetModelId'] === 'string' ? record['targetModelId'] : '',
    probeInputTokens: typeof record['probeInputTokens'] === 'number' && Number.isFinite(record['probeInputTokens'])
      ? record['probeInputTokens'] as number
      : 0,
    memberAccountIds: Array.isArray(record['memberAccountIds'])
      ? (record['memberAccountIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
  }
}

/**
 * The plugin's DECLARED settings namespace — the fallback name, not the value
 * the host necessarily serves.
 *
 * On 0.1.7 the settings service keys every form by the plugin's Loader entry
 * id (`describe()` returns `ns: entry.options.id`), and the harness resolves
 * a provider's namespace by EXACT match. The entry id is chosen by the
 * profile patch (`cordis.patch.yml`), so the declared id mirrors it.
 */
export const QODER_SETTINGS_NS = 'dsh-connect-qoder' as const
