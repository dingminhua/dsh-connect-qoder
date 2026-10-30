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

// 纯类型导入（构建时擦除）：本模块是 node-free 桥梁，不能把 Host 侧的实现模块
// 拖进来——但 `promo.ts` 本身就无依赖，只借它的形状，不借它的代码。
import type { QoderPromotion } from './promo.ts'

// ---------------------------------------------------------------------------
// 路由常量
// ---------------------------------------------------------------------------

/** Plugin-owned usage endpoint consumed by its browser half. */
export const QODER_USAGE_PATH = '/plugins/dsh-connect-qoder/usage'

/**
 * Plugin-owned campaign feed endpoint for one region.
 *
 * Answers the card's activity area: the daily 100-Credits check-in row plus every
 * `VIEW_DETAILS` banner upstream currently serves (集结 / 首月翻倍 / …), each with
 * its title, description and detail link. Read-only and lazy like the credits
 * endpoint — the activities live next to the usage readout and are only worth one
 * upstream read while the panel is open.
 */
export const QODER_CAMPAIGNS_PATH = '/plugins/dsh-connect-qoder/campaigns'

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
 * Query parameter selecting HOW MUCH of the usage document a request wants.
 *
 * Absent means the full document — every caller written before this parameter
 * existed keeps getting exactly what it used to, which is why the default is
 * `full` rather than an opt-in flag.
 */
export const QODER_DETAIL_PARAM = 'detail'

/**
 * The one non-default detail level: a first-paint document built from LOCAL
 * state only.
 *
 * The card's first paint used to wait for the full document, whose tail
 * includes one live upstream read for the selected account's credits plus one
 * per pool member. Each of those can stall for seconds, and the card rendered
 * nothing about accounts until all of them came back — the complaint this
 * exists to fix (同一族插件的 issue #77，见 dsh-connect-workbuddy)。
 *
 * A `fast` document answers from what the Host already knows: the stored
 * credential (no token refresh), the cached credit reading, the pool's saved
 * member list and the check-in state measured this process. It never performs
 * an upstream read, so it cannot be held by a slow upstream.
 */
export const QODER_DETAIL_FAST = 'fast'

/**
 * Address one region's usage route asking for the first-paint document.
 *
 * Separate from {@link withQoderRegion} so that "this call only wants the
 * cheap document" is visible at the call site.
 */
export function withQoderRegionFastDetail(path: string, region: QoderWebRegion): string {
  return `${withQoderRegion(path, region)}&${QODER_DETAIL_PARAM}=${QODER_DETAIL_FAST}`
}

/**
 * Does this request URL ask for the first-paint document?
 *
 * Only the exact value `fast` counts. Anything else — a typo, a future level
 * this build does not know, an empty value — degrades to the FULL document.
 * That direction is deliberate: a typo must cost a slow paint, never an
 * emptier panel that looks like data loss.
 */
export function fastDetailOf(url: string): boolean {
  const at = url.indexOf('?')
  if (at === -1) return false
  return new URLSearchParams(url.slice(at + 1)).get(QODER_DETAIL_PARAM) === QODER_DETAIL_FAST
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
 *
 * `progress` 不是动作，而是**只读的 GET 轮询**：回报正在飞的那一批已经处理完
 * 哪几行，卡片据此逐条写活动日志。批量是串行的真实探针（一池六个号就是几分
 * 钟），若等整批响应回来才一次性落日志，那几分钟里日志是空的——用户实拍到的
 * 「六条全在 05:44:54」就是这个形状。它只读宿主内存里的进度、不碰上游，
 * 所以可以每秒问一次。
 */
export type QoderPoolAction = 'checkin' | 'test' | 'remove' | 'progress'

/** Read the pool action off a request URL; unknown/absent means undefined. */
export function poolActionOf(url: string): QoderPoolAction | undefined {
  const value = actionParamOf(url)
  if (value === 'checkin' || value === 'test' || value === 'remove' || value === 'progress') return value
  return undefined
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

/**
 * `withQoderRouteAction` plus the id of the ONE account a per-row request
 * addresses.
 *
 * Kept separate from the plain action builder so that "this request acts on a
 * single row" is a property of the call site, not a value a caller can forget
 * to append — the row-level test button silently degrading into a whole-pool
 * batch is exactly the bug this exists to prevent.
 */
export function withQoderRouteAccount(
  path: string,
  region: QoderWebRegion,
  action: QoderRouteAction,
  accountId: string,
): string {
  return `${withQoderRouteAction(path, region, action)}&${QODER_POOL_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`
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

/**
 * 该区域请求实际打到的**网关主机名**（不含协议），只用于诊断展示。
 *
 * 为什么要有这一行：卡片的「诊断」栏要如实回答「这次请求打到哪个域名」，而这句话
 * 必须与 `QODER_REGIONS[region].gateway` **同一个事实**。此前卡片只有
 * {@link QODER_CONSOLE_DOMAIN}（用户浏览器里申请 PAT 的控制台），两者在区域之间
 * 恰好是相反的形状（控制台是 `qoder.com`，网关却是 `api1.qoder.sh`）—— 拿控制台
 * 域名去回答诊断问题会给出一个**看起来对、实际不是请求目标**的答案。所以这张表
 * 放在这里，并由 `upstream.ts` 的 `QODER_REGIONS` **直接消费**（见那里的
 * `gateway` 字段），不手抄第二遍：两处域名漂移过一次就很难被发现。
 */
export const QODER_UPSTREAM_DOMAIN: Readonly<Record<QoderWebRegion, string>> = {
  cn: 'gateway.qoder.com.cn',
  global: 'api1.qoder.sh',
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
  /**
   * The upstream's promotion rule for this model (`model/list` → `promotion`).
   *
   * Carried as the parsed rule (`src/promo.ts`), not the upstream snake_case
   * payload, so the card, the persisted catalog and the Host all speak one
   * shape. Whether it is *live* is NOT decided here: the card asks
   * `promoLiveAt` against the clock on every render.
   */
  promotion?: QoderPromotion
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
  promotion?: QoderPromotion
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
  /**
   * 这个账号**此刻是否真的在发号**（与 `QoderWebPoolAccount.current` 同义）。
   *
   * 判据与 `src/shim.ts` 的请求路径逐字对齐：每个请求第一发都打给区域选中的
   * 号，所以「在用」通常就是它；只有池开启且选中号此刻被排除时，第一发被硬拒
   * 后由排序第一的可用成员接管计费，`current` 才落在那个接管者身上。
   * 面板不能拿 `selected` 顶替：用户实拍（2026-10-18）——额度用尽的选中号
   * 顶着绿点、真正接管的号是灰的，正是因为面板读的是 `selected`。
   * 缺席（未登录、宿主未解析）时面板退回 `selected`，与旧宿主保持兼容。
   */
  current?: boolean
  /**
   * 这个账号最近一次探针的**原始结论**（与池行 `probe.outcome` 同一次测量，
   * 不做目标模型过滤——两张表同色才是目标）。
   *
   * 面板的行标记需要它来区分「能用」与「不能用」之外的第三件事：能不能自己
   * 好起来。缺席 = 从没测过。
   */
  probeOutcome?: QoderWebProbeOutcome
  /**
   * 上游给出的**解禁时刻**（毫秒时间戳），只有 `rate-limited` / `out-of-credit`
   * 这类会自己恢复的排除才有；凭据被拒、账号不存在这类不会自己好，永远缺席。
   *
   * 面板把它写成相对时长（「约 12 分钟后解禁」）而不是绝对时刻：用户要求
   * （2026-10-18）原因是给人判断「还要等多久」的，不是给人做减法的。值仍来自
   * 上游的 `retryAtMs`，没给就只显示原因、不编倒计时。
   */
  retryAtMs?: number
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
    /**
     * WHICH MODEL this measurement is about.
     *
     * The card must show it when it is not the currently-selected target
     * model: a verdict about model A says nothing about model B (Qoder
     * rate-limits per model). ABSENT means the writer recorded no model —
     * treat as applying to anything, which is the coarse pre-field behaviour.
     */
    modelId?: string
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
  /**
   * Whether this is the account currently billing traffic for the region.
   *
   * 与 `src/shim.ts` 的请求路径逐字对齐：第一发永远打给选中号，所以
   * `current` 通常就是选中号——**即使它正被排除**（池关着时没有换号机制，
   * 下一个请求确实还会打给它），此时一行可以同时是 `current: true` 与
   * `excludedBy: 'out-of-credit'`，「谁在计费」与「它坏了」是两个问题的
   * 答案，不是矛盾；红点由状态色表达，不由 current 表达。
   * 只有池开着且选中号被排除时，`current` 才移到接管者身上
   * （见 `QoderWebPool.servingSource`）。
   */
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
  /**
   * 这一行的 `current` 是从哪来的 —— 决定「当前使用」到底意味着什么。
   *
   * - `selected`：第一发就在这一行身上——池关着，或池开着但选中号此刻还能用
   *   （每个请求都先打给选中号，池的排序只是候补名单）；
   * - `failover`：池开着且选中号此刻被排除，这一行是**接管者**：请求仍先打给
   *   选中号，它在首字节前被硬拒后由这一行接管并计费（用户实拍：标着
   *   「当前使用」的行写着「用量已达上限」——那是旧模型把两个角色叠在一行，
   *   新模型下「当前使用」与「用量已达上限」分属两行，两句话都对）。
   *
   * 缺席（旧宿主 / 已登出）时卡片只说「当前使用」，不猜它属于哪一种。
   */
  servingSource?: 'selected' | 'failover'
  /**
   * 池开启时的**接管候选人**（`rankPool` 第一个可用的，与
   * `nextFailoverCredential` 的同一条判据）。
   *
   * ⚠️ 它**不是**第一发——第一发永远是选中号；只有选中号被排除时接管才发生。
   * 面板/卡片的绿点必须读每行的 `current`（宿主已按请求路径算好），不要拿
   * 这个字段当绿点，也不要拿 `selected` 当绿点（用户实拍：额度用尽的选中号
   * 顶着绿点、真正接管的号是灰的）。池关闭时此字段缺席——没有接管一说。
   */
  priorityAccountId?: string
  /**
   * 池里当前**没有任何账号能服务**：serving 号自己被排除，且所有成员都被排除。
   *
   * 这时 `accounts[].current` 全是 false —— 因为「谁在计费」这个问题的诚实答案
   * 是「没有人」。卡片据此把标题读作「无可用账号」并收起「当前使用」，而不是
   * 硬指一个已被限流的号（workbuddy 的 `currentAccountId` 返回 `undefined`
   * 的同一条理由：把它报成在用，会和正下方写着「已排除」的那一行打架）。
   *
   * 缺席表示「有账号在服务」，或「还判断不了」（旧宿主）。
   */
  servingUnavailable?: boolean
  /**
   * 用户手动排定的账号优先级（靠前的先用）。
   *
   * 卡片据此在成员表里显示「第 1 位」「第 2 位」，并提供上移/下移。
   * 空 = 没排过，此时顺序完全由积分策略决定（`rankPool`）——
   * 卡片必须显示「自动排序」而不是伪造一个名次。
   */
  orderAccountIds?: readonly string[]
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

/**
 * 正在飞的批量动作的进度（`action=progress` 轮询的答案）。
 *
 * 只列出**已经处理完**的行（完成顺序），每行额外带 `atMs`（完成时刻，epoch
 * 毫秒）——活动日志要按真实完成时刻落行，不能等整批回来才用同一个时刻盖章。
 * 批次结束时槽位清空，答案里的 `action=progress` 仍照常回，只是不再带 `batch`
 * 字段（「现在没有批量在跑」是正常状态，不是错误）。
 */
export interface QoderWebPoolBatch {
  action: 'checkin' | 'test'
  /** 已处理完的行，按完成顺序；每行带完成时刻。 */
  done: readonly { atMs: number, row: QoderWebPoolTestRow | QoderWebPoolCheckinRow }[]
}

/** The pool endpoint's answer for `action=progress`. */
export interface QoderWebPoolProgressAnswer {
  action: 'progress'
  batch?: QoderWebPoolBatch
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
    /** WHERE this region's readout sits; absent means `composer`. */
    creditPosition?: QoderCreditPosition
    /** See the signed-in variant: the last upstream-asserted quota exhaustion. */
    lastQuotaExhaustion?: QoderWebQuotaExhaustion
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
    /** See the signed-out variant: WHERE this region's readout sits. */
    creditPosition?: QoderCreditPosition
    /**
     * The last upstream-asserted quota exhaustion on the chat path, or absent
     * when upstream never said so this process. Region-level on purpose —
     * see {@link QoderWebQuotaExhaustion} for why it exists beside the pool.
     */
    lastQuotaExhaustion?: QoderWebQuotaExhaustion
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
     *
     * It is a WHITELIST: an empty array means "no model has image input", which
     * is also what a never-saved region looks like. {@link imageSelectionSaved}
     * is what tells those two apart — see below.
     */
    imageModelKeys: readonly string[]
    /**
     * Whether the user ever SAVED an image selection for this region.
     *
     * Needed because `imageModelKeys` is a whitelist: "never chosen" and "chose
     * nothing" are both `[]`, but the correct behaviour is opposite — the first
     * seeds from the reviewed table, the second must stay all-off. Without this
     * flag the card cannot tell them apart, so unchecking every model and
     * refreshing would re-check the seeded ones (issue #22).
     */
    imageSelectionSaved: boolean
    credits?: QoderWebCredits
    creditsError?: string
    /**
     * The LAST refresh failed, but the snapshot below is intact. Carried as
     * an overlay so a failed re-read never blanks the panel.
     */
    refreshError?: string
    /**
     * WHEN these credits were actually read upstream (ms epoch), not when the
     * browser last fetched this document.
     *
     * composer 页脚此前显示的是「客户端 fetch 返回的时刻」，所以刷新失败时它照样
     * 往前走一步 —— 数字是旧的、时间却显示刚刚，用户无从判断哪个能信。宿主手里
     * 一直有这个值（缓存条目的 `atMs`），只是此前在路由里被丢掉。
     */
    creditsAtMs?: number
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
 * The two seats this region's credit readout can occupy.
 *
 * 参考：dsh-connect-workbuddy 的 `WorkBuddyCreditPosition`（issue #62，MIT，
 * Copyright (c) 2026 LaoDing）—— 位置是**用户的**选择，因为第一个席位本身不
 * 一定可用。
 *
 * `composer` 是输入框工具栏（`conversation.input.right`，渲染在模型选择器
 * 之前）；`stats` 是输入框
 * 卡片下方的常驻栏（`conversation.composer.dock`），即 shell 渲染「轮次 / tok/s /
 * token / 缓存命中」那一行。用联合类型而不是布尔，因为第三个席位是可预见的，
 * 而 `showAtTop: boolean` 只能迁移、不能扩展。
 */
export type QoderCreditPosition = 'composer' | 'stats'

/**
 * Which seat one region's readout uses, defaulting to the composer tool row.
 *
 * 默认 `composer` 是刻意的：它是该设置存在之前**唯一**的席位，所以升级不会
 * 移动任何人屏幕上的东西。
 */
export function regionCreditPositionOf(value: unknown, region: QoderWebRegion): QoderCreditPosition {
  return regionSlotOf(value, region)['creditPosition'] === 'stats' ? 'stats' : 'composer'
}

/**
 * Build the next `regions` settings value for one region's credit seat.
 *
 * Same merge rule as {@link nextRegionCreditsShown}: only the target region's
 * field changes, so every other field of that slot and every other region's slot
 * survive the write.
 */
export function nextRegionCreditPosition(
  value: unknown,
  region: QoderWebRegion,
  position: QoderCreditPosition,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    creditPosition: position,
  })
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
 * 最近一次**上游明说**的额度耗尽（对话路径上 `quota-exhausted` 的那次失败）。
 *
 * 为什么需要它：逐账号的 `out-of-credit` 只活在账号池的视图里，而池的记账有
 * 两道门（池关不记盘、非成员不记）——池关着时一次 code 110 的失败在任何 UI 上
 * 都无处可看（0.7.x 时代的「今日额度疑似已用尽」胶囊就是干这个的，后来随本地
 * 计数器一起被拆掉了）。这份记录按**区域**存、与池开关无关，是那条信息现在的
 * 出口。
 *
 * 注意它是**事实**不是推断：只有上游的业务码命中配额族（110/113/118/…）才产生
 * 它，措辞用「上游报」，不用旧版的「疑似（本地统计）」。
 */
export interface QoderWebQuotaExhaustion {
  /** 上游业务码（如 `110` 当日用量 / `118` 个人 Credits 耗尽），读不到则缺席。 */
  code?: string
  /** 脱敏后的上游原文（与探针 message 同一处理，pt- 形态绝不落盘）。 */
  message: string
  /** 上游报出这件事的时刻；展示口径是「最近一次」。 */
  atMs: number
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

/**
 * Every namespace spelling the browser half follows when looking for the
 * settings form the host actually serves, in preference order.
 *
 * `describe()` keys a form by its Loader ENTRY ID, and the profile patch picks
 * that id — so the plugin must ASK rather than assume. The observed spellings
 * are the bare entry id and the `include:`-wrapped id (the sibling workbuddy
 * plugin records that the live Desktop host mounts it that way), with the
 * declared name as the last resort.
 *
 * ⚠️ **这份表是 `whileServed` 的监视对象，不只是「匹配时的候选」**：宿主只在
 * **被监视的命名空间之一**到货时才触发 register 边缘。少一种拼写 ⇒ 宿主若正好
 * 用那种拼写挂载，边缘**永不触发**，于是回调里那条 `/qoder/i` 兜底成了死代码，
 * 卡片永远停在只读降级上（用户看得见卡片、却存不了设置，且无任何报错）。
 *
 * Lives here, not in the host entry, because the browser half needs the same
 * list and must not import node-only host code.
 */
export const QODER_SETTINGS_NAMESPACE_CANDIDATES: readonly string[] = [
  QODER_SETTINGS_NS,
  `include:${QODER_SETTINGS_NS}`,
  'qoder',
]
