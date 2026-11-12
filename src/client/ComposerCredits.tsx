/**
 * Credit readout for the composer row (`conversation.input.right`, rendered
 * immediately before the model picker).
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `ComposerCredits.tsx`：读数形态（`<区域> · <余额>`）、点击弹出锚定面板、
 *     面板内是**账号表格**（点行即切换账号）、刷新按钮放在面板里而不是读数上、
 *     每账号读数**只在面板打开时抓**、可配的自动刷新定时器（`pollMinutes`，默认 5 分钟）、失败保留上次数值。
 * 改动：按 Qoder 适配——provider 路由是 `qoder` / `qoder-global`，读数标注为
 *   「QD CN」/「QD AI」；`QODER_ACCOUNT_CREDITS_PATH` 直接返回 `QoderWebAccountCredit[]`
 *   数组（而非 `{accounts}` 包裹）；账号选择写在 `regions.<region>.accountId`，
 *   变更走共享的 `writeAccountSlot`。
 *
 * Shows the selected region's general credit balance, but ONLY while the
 * session's selected model belongs to this plugin (the gate decides that).
 *
 * @module dsh-connect-qoder/client/ComposerCredits
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismissOnOutsidePointer } from './popover.ts'
import {
  QODER_ACCOUNT_CREDITS_PATH,
  QODER_POOL_PATH,
  QODER_USAGE_PATH,
  withQoderRegion,
  withQoderRegionAndAction,
  withQoderRouteAction,
} from '../status-paths.ts'
import { writeAccountSlot } from './account-selection.ts'
import type { QoderAccountScope } from './account-selection.ts'
import { exclusionText } from './exclusion-text.ts'
import { hostLanguage } from './promo-badge.ts'
import { accountStateTone, accountStateColor } from './account-state.ts'
import { QODER_COMPOSER_CSS } from './styles.ts'
import { installPluginStyle } from './style-injector.ts'
import { pollMinutesOf } from '../status-paths.ts'
import type { QoderWebAccountCredit, QoderWebDedicatedPackage, QoderWebRegion, QoderWebUsage } from '../status-paths.ts'
import type { QoderSettingsKey, Translate } from './locales.ts'

/**
 * Inject the readout's styles into the document head, once, on module load.
 *
 * Same idempotent pattern as the card's injection: the classes are attached to
 * DOM this component owns, and `QODER_CARD_CSS` only loads when the settings
 * card does — which is not guaranteed on a host where the card is never rendered.
 *
 * The sheet is **refreshed in place**, not appended only when absent. The Host
 * rebuilds this bundle and re-imports it, which re-runs this code; with an
 * append-only sheet the browser would keep the very first version of the
 * stylesheet for the rest of the session. That is precisely what left this
 * plugin's "Settings" button rendering with the browser's default button
 * chrome while the CSS on disk already carried the intended pill styling.
 */
installPluginStyle('dsh-connect-qoder/composer-credits.css', QODER_COMPOSER_CSS)

/**
 * Automatic refresh period when the settings mirror cannot be read: five
 * minutes, matching a credit balance's actual rate of change —— and the value
 * this readout shipped before the interval became a setting.
 */
export const COMPOSER_CREDITS_REFRESH_INTERVAL_MS = 300_000

/** Localized copy injected by the browser-plugin registration. */
export interface ComposerCreditsInjected {
  t: Translate
}

export interface ComposerCreditsProps extends Partial<ComposerCreditsInjected> {
  /**
   * Provider route of the session's selected model, or undefined while the
   * projection has not landed.
   */
  provider?: string
  /** Which region's credits to read when the provider is this plugin's. */
  region?: QoderWebRegion
  /**
   * Settings scope from the configForms mirror. Present whenever a row click
   * should switch accounts; without it the table still renders but the rows are
   * inert.
   */
  settingsScope?: QoderAccountScope
  /**
   * Open this plugin's settings page.
   *
   * **Optional by design**, because the destination belongs to another plugin:
   * the Plugins page provides `pluginNavigation`, and a profile that does not
   * mount it has nowhere to go. When absent the button is not rendered at all —
   * a control that visibly does nothing is worse than one that is simply not
   * there.
   */
  openSettings?: () => void
}

/**
 * Provider routes whose credit balance this readout can show, mapped to the
 * region to read it from. Mirrors `QODER_PROVIDERS` on the host side; duplicated
 * here because the client bundle must not import the host entry.
 */
export const QODER_COMPOSER_PROVIDERS: Readonly<Record<string, QoderWebRegion>> = {
  'qoder': 'cn',
  'qoder-global': 'global',
}

/** The credit total out of one usage document, or undefined. */
function creditsOf(usage: QoderWebUsage): number | undefined {
  if (usage.status !== 'signed-in') return undefined
  return usage.credits?.total
}

/** Group the digits so a four-figure balance stays readable in a narrow row. */
function formatCredits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/**
 * A same-day instant, as the READER's locale writes it.
 *
 * The locale is `undefined` — the reader's, not a fixed one — so an English UI
 * shows `11:59 PM` rather than the Chinese convention's `23:59`. It used to
 * hardcode `'zh-CN'`, which meant the English interface printed a Chinese-style
 * time. Ported from dsh-connect-trae (issue #71).
 *
 * Only for instants that are the same day as the reader: a bare clock time on
 * a timestamp from another day is a different question (and a different
 * design), which is why this is not reused for anything but "now".
 */
function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * A calendar date in the reader's locale — for an expiry, which is usually not
 * today.
 *
 * Separate from {@link formatClock} on purpose: a bare `11:59 PM` on a package
 * that expires next week reads as tonight. The expiry of an exclusive credit
 * package is a date the user plans around, so it gets its own format.
 */
function formatDay(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/**
 * 上游给的双语文案按**界面语言**挑一侧（issue #38）。
 *
 * 语言信号复用 `promo-badge.ts` 的 `hostLanguage(t)`：宿主绑定好的 `t` 是这里
 * 唯一能读到的界面语言（浏览器语言不会跟着 DSH 的语言设置变，只看
 * `navigator.language` 会出现「中文界面配英文表头」）。
 *
 * 只在下发的那一侧缺席时退回另一侧 —— 两条都是上游自己的话，不是我们翻译的，
 * 所以「退回」不是降级，只是换了上游给的另一种说法。
 */
function localizedLabel(
  label: { zh?: string, en?: string } | undefined,
  english: boolean,
): string | undefined {
  if (label === undefined) return undefined
  return english ? (label.en ?? label.zh) : (label.zh ?? label.en)
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const { t, provider, region, settingsScope, openSettings } = props
  if (t === undefined) throw new Error('Composer credits readout requires its translation function')
  const owned = provider === undefined ? undefined : QODER_COMPOSER_PROVIDERS[provider]
  const activeRegion = region ?? owned

  const [usage, setUsage] = useState<QoderWebUsage | undefined>(undefined)
  const [accountCredits, setAccountCredits] = useState<QoderWebAccountCredit[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  /** A pool batch (probe every member) is in flight. */
  const [testing, setTesting] = useState(false)
  /** The last pool batch failed to start. */
  const [testFailed, setTestFailed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const position = useAnchoredPosition({
    open: open && activeRegion !== undefined,
    anchorRef: rootRef,
    panelRef,
    // Above the trigger: the composer sits at the bottom of the window.
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const fetchUsage = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (inFlight.current || activeRegion === undefined) return
    inFlight.current = true
    if (mounted.current) setBusy(true)
    try {
      const response = await fetch(withQoderRegion(QODER_USAGE_PATH, activeRegion), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as QoderWebUsage
      if (!mounted.current || signal?.aborted === true) return
      setUsage(value)
      setLastRefresh(Date.now())
      setFailed(false)
    } catch {
      // Keep the previous value: a stale number is better than a blank row.
      if (mounted.current && signal?.aborted !== true) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [activeRegion])

  /**
   * Every account's balance in the region — one upstream read per account.
   * Paid only while the panel is open. On failure keep the previous rows.
   */
  const fetchAccountCredits = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (activeRegion === undefined) return
    try {
      const response = await fetch(withQoderRegion(QODER_ACCOUNT_CREDITS_PATH, activeRegion), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as unknown
      if (!mounted.current || signal?.aborted === true) return
      // Qoder's account-credits route returns the array directly (no wrappers).
      if (Array.isArray(data)) setAccountCredits(data as QoderWebAccountCredit[])
    } catch {
      // Keep the previous rows; see above.
    }
  }, [activeRegion])

  /**
   * 本会话的刷新节奏（毫秒），活读设置镜像。
   *
   * 与卡片同一条规则、同一个字段：一个全局节奏管住所有打上游的自动读。镜像读不到
   * （老宿主、单测）时退回 {@link COMPOSER_CREDITS_REFRESH_INTERVAL_MS} —— 那正是
   * 这个读数在这个设置存在之前的间隔，所以「读不到」与「没改过」在屏幕上同形。
   */
  const pollIntervalMs = pollMinutesOf(settingsScope?.getSnapshot().value) * 60_000

  // Fetch usage on mount and when the region changes; a timer starts only after
  // the first fetch settles. `pollIntervalMs` is a dependency: changing the
  // setting rebuilds the timer instead of waiting for a remount.
  useEffect(() => {
    if (owned === undefined) return undefined
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    void fetchUsage(controller.signal).finally(() => {
      if (cancelled) return
      timer = window.setInterval(() => { void fetchUsage(controller.signal) }, pollIntervalMs)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      controller.abort()
    }
  }, [owned, fetchUsage, pollIntervalMs])

  // Per-account figures are read on OPEN, not on the 5-minute cycle.
  useEffect(() => {
    if (!open || activeRegion === undefined) return undefined
    const controller = new AbortController()
    void fetchAccountCredits(controller.signal)
    return () => { controller.abort() }
  }, [open, activeRegion, fetchAccountCredits])

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const switchTo = async (accountId: string): Promise<void> => {
    if (settingsScope === undefined) return
    if (activeRegion === undefined || switchingId !== undefined) return
    const currentId = accountCredits?.find(account => account.selected)?.id
      ?? (usage?.status === 'signed-in' ? usage.accountId : undefined)
    if (accountId === currentId) return
    setSwitchingId(accountId)
    setFailed(false)
    try {
      await writeAccountSlot(settingsScope, activeRegion, accountId)
      await fetchUsage()
      await fetchAccountCredits()
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setSwitchingId(undefined)
    }
  }

  /**
   * 「刷新」：把玩家池里的每个成员真跑一次探针。
   *
   * 面板回答的是「谁在服务、还剩多少」，而圆点与第二行的原因（被拒绝／用量
   * 达上限／限流 · 约 N 分钟后解禁）全部来自**探针结论**——只读余额读不出
   * 「还能不能用」。所以这颗按钮真正该做的是重测一遍：探针写回宿主快照之后，
   * 颜色与原因才是刚测出来的，而不是打开面板那一刻的旧账。
   *
   * 走的是设置页账号池工具栏那条**同一条**路（`POST /pool?action=test`），
   * 不另造一条：两条路测出来的结论必须一致，否则同一个号在两处显示不同。
   *
   * 批量是**串行**的真实探针（一个号十几秒到几十秒），因此不干等整批响应：
   * 边跑边读宿主的**只读**进度（`action=progress`，不碰上游），每落一行就把
   * 账号表重取一次，用户能看着圆点一行一行翻新。整批结束（成功或失败）后再补
   * 最后一读 —— 成败都补：失败时探针可能已经落了一部分，至少别让表格停在
   * 测试前的旧账上。
   */
  const runTestAll = async (): Promise<void> => {
    if (activeRegion === undefined || testing || busy || switchingId !== undefined) return
    setTesting(true)
    setTestFailed(false)
    setFailed(false)
    let cursor = 0
    const pull = async (): Promise<void> => {
      if (activeRegion === undefined) return
      try {
        const response = await fetch(withQoderRegionAndAction(QODER_POOL_PATH, activeRegion, 'progress'), { credentials: 'same-origin' })
        if (!response.ok) return
        const raw = await response.json().catch(() => ({})) as Record<string, unknown>
        const batch = raw['batch']
        if (typeof batch !== 'object' || batch === null) return
        const entry = batch as Record<string, unknown>
        // 动作对不上就不认：上一批的残行或另一个标签页在跑的别的动作，都不该
        // 让这里重取表格。
        if (entry['action'] !== 'test' || !Array.isArray(entry['done'])) return
        const done = entry['done'] as unknown[]
        if (done.length <= cursor) return
        cursor = done.length
        await fetchAccountCredits()
      } catch { /* 轮询失败不打扰用户：下一拍再试，整批响应仍是最终答案 */ }
    }
    let timer: number | undefined
    try {
      timer = window.setInterval(() => { void pull() }, 1_500)
      const response = await fetch(withQoderRouteAction(QODER_POOL_PATH, activeRegion, 'test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      if (mounted.current) setTestFailed(true)
    } finally {
      if (timer !== undefined) window.clearInterval(timer)
      // 成败都补一读：成功时把最后一行带进来；失败时探针可能已经落了一部分，
      // 至少别让表格停在测试前的旧账上。
      await fetchAccountCredits()
      if (mounted.current) setTesting(false)
    }
  }

  // Not this plugin's model: render nothing at all. 插件之间不做联动，所以别的
  // 连接器当家时这里没有该显示的读数（见 docs/DESIGN.md「边界：不做什么」）。
  if (owned === undefined) return null

  const signedIn = usage?.status === 'signed-in' ? usage : undefined
  /**
   * 文档级总额：**这份文档是用哪个号读上来的**，就是哪个号的余额 —— 也就是
   * 第一发目标（选中号）的余额。它不等于「此刻在计费的号」的余额，见 `total`。
   */
  const docTotal = signedIn === undefined ? undefined : creditsOf(signedIn)
  const signedOut = usage !== undefined && usage.status === 'signed-out'
  const label = t(activeRegion === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal' as QoderSettingsKey)

  const selectedId = accountCredits?.find(account => account.selected)?.id
    ?? (signedIn === undefined ? undefined : signedIn.accountId)

  /**
   * 此刻**真正在计费**的账号 —— 与面板「当前选用」同一条判据（表格的 `current`
   * 来自 `accountCreditsOf`、池视图的 `current` 来自 `web-status`，两者都与
   * `src/shim.ts` 的请求路径逐字同判）。两者都缺席（旧宿主 / 池关）时退回选中号：
   * 没有接管机制时第一发确实是它。
   */
  const billingId =
    accountCredits?.find(account => account.current === true)?.id
    ?? signedIn?.pool?.accounts.find(account => account.current === true)?.accountId
    ?? selectedId
  const billingName =
    accountCredits?.find(account => account.id === billingId)?.accountName
    ?? signedIn?.pool?.accounts.find(account => account.accountId === billingId)?.accountName
    ?? (signedIn !== undefined && signedIn.accountId === billingId ? signedIn.accountName : undefined)
  /**
   * 胶囊显示的数字：**计费账号**的余额，而不是文档级总额。
   *
   * 优先表格的逐号读数（面板打开 / 切号 / 测试后取，最新），其次同一份 usage 文档
   * 里池视图的每行余额（composer 拉的是 full 文档，恒带）；**只有当计费账号就是
   * 文档自己的账号时**才退回文档级总额 —— 否则胶囊会显示一个根本没在计费的号的
   * 余额：池接管的瞬间，文档级总额仍是被排除的选中号的读数（用户截图：面板高亮
   * 「丁晓潇 100」，胶囊却读着已禁用的 ddd 的 773）。拿不到计费号的余额就显示
   * 「—」：说不知道，比说一个错的号强。
   */
  const billingCredits =
    accountCredits?.find(account => account.id === billingId)?.credits
    ?? signedIn?.pool?.accounts.find(account => account.accountId === billingId)?.credits
  const total = billingCredits ?? (billingId === signedIn?.accountId ? docTotal : undefined)
  const valueText = total === undefined ? '—' : formatCredits(total)
  /** 悬停说清这个数字是谁的：接管发生时，光看「QD AI · 100」不知道 100 归谁。 */
  const billingTitle = billingName === undefined ? undefined : t('composer.billingAccount', { name: billingName })
  const sourceRows: QoderWebAccountCredit[] = accountCredits
    ?? (signedIn === undefined
      ? []
      : signedIn.accounts.map(account => ({
          id: account.id,
          accountName: account.accountName,
          selected: account.selected,
        })))
  const rows: QoderWebAccountCredit[] = sourceRows.map(row => {
    // The selected account's balance is already in the usage document the
    // readout rendered, so fall back to it when the table request carried none.
    if (row.id !== selectedId || row.credits !== undefined || docTotal === undefined) return row
    return { ...row, credits: docTotal }
  })
  const canSwitch = settingsScope !== undefined

  /**
   * 这一区**有没有东西可刷新**。
   *
   * 「刷新」跑的是**玩家池**的批量探针（`POST /pool?action=test`），宿主那一侧
   * 遍历的是「池成员」（`scope = prefs.memberAccountIds`）——不是面板上列出的
   * 全部账号。所以判据必须是**池成员**：
   *
   * - 成员名单空时无事可做；
   * - 宿主不发 `pool` 段（旧宿主）时无从得知 → 同样按「没有可测的」处理。
   *
   * 面板表格里的行是**账号**（含不在池里的选中号），不是池成员；用行数判会把
   * 「池空但有一个选中号」误判成「有东西可测」。
   *
   * **刻意不看池的开关。** 宿主那一侧的手动动作是**不受池开关约束**的（workbuddy
   * 同规，并写明了理由）：池的开关管的是「插件要不要替用户自动选号/换号」，不是
   * 「用户能不能对勾选过的号点一下测试」。若这里按 `pool.enabled` 判定，池关着的
   * 用户就点不到那颗按钮——而宿主明明会照跑（`scope` 只看成员名单）。
   *
   * 判据为假时按钮**仍然渲染、但禁用**（而不是消失）：它在页头右侧那颗外壳里，
   * 一颗按钮忽然消失会让标题往左跳一下；而「此刻没有可测的东西」由置灰说出来，
   * 比让用户点了才发现没反应好。
   */
  const poolMembers = signedIn?.pool?.effectiveMemberAccountIds ?? signedIn?.pool?.memberAccountIds
  const poolTestable = (poolMembers?.length ?? 0) > 0

  /**
   * 专属积分包那一列（issue #38）在**这一张表里**到底要不要画。
   *
   * 判据只有一条：**有没有哪一行真的带 `dedicated`**。不能按区域判（国内版实测
   * 没有这个字段，但那是上游的现状、不是契约），也不能按「这份文档是国际版」判
   * —— 面板列的是逐号读数，可能混着两个来源。没有专属包时整列（连 `th` 一起）
   * 不渲染，于是国内版与没有专属包的用户看到的仍是原来那两列。
   */
  const dedicatedShown = rows.some(row => (row.dedicated?.length ?? 0) > 0)
  /** 界面是否英文 —— 只用来挑上游双语标题/描述里的哪一侧。 */
  const english = hostLanguage(t).toLowerCase().startsWith('en')

  /**
   * 一行的专属积分读数（合计 + 悬停）。
   *
   * **多个包只显示合计**（issue #38 留了「合计或按包分行」两个选项）：这一列
   * 只有 56px，分行会让一个账号在某一行里占掉三四行高，而面板的用途是「谁在
   * 服务、还剩多少」。逐包的细节放进悬停 —— 那里放得下标题、说明与各自的到期
   * 时刻，也就没有丢信息。
   */
  const dedicatedOf = (packages: readonly QoderWebDedicatedPackage[] | undefined): {
    text: string
    title: string | undefined
  } | undefined => {
    if (packages === undefined || packages.length === 0) return undefined
    // 全部缺席 `remaining` 时合计没有意义 —— 那是「上游没报」而不是「0」。
    const known = packages.filter(entry => entry.remaining !== undefined)
    const total = known.length === 0
      ? undefined
      : known.reduce((sum, entry) => sum + (entry.remaining ?? 0), 0)
    const lines: string[] = []
    for (const entry of packages) {
      const name = localizedLabel(entry.title, english) ?? t('composer.dedicated')
      const hint = localizedLabel(entry.description, english) ?? t('composer.dedicatedHint')
      const amount = entry.remaining === undefined ? '—' : formatCredits(entry.remaining)
      const expires = entry.expiresAtMs === undefined
        ? ''
        : ` · ${t('composer.dedicatedExpires', { time: formatDay(entry.expiresAtMs) })}`
      lines.push(`${name}: ${amount}${expires} — ${hint}`)
    }
    // 多个包时先给一行合计：悬停里逐条列出之后，读者仍需要一个总数。
    if (packages.length > 1 && total !== undefined) {
      lines.unshift(t('composer.dedicatedMultiple', { count: packages.length, remaining: formatCredits(total) }))
    }
    return {
      text: total === undefined ? '—' : formatCredits(total),
      title: lines.join('\n'),
    }
  }

  /**
   * 这一列表头的文字：优先**上游自己的话**（`title` 的当前语言那一侧）。
   *
   * 上游在 `displayLabels` 里已经给了「SOTA 专属积分 / SOTA Exclusive Credits」，
   * 而这是个营销词、不是术语 —— 自己再写一份译文只会在上游改词时落后。字典里
   * 那条 `composer.dedicated` 只是上游没下发标题时的兜底，不是主文案。
   */
  const dedicatedHeader = (() => {
    for (const row of rows) {
      for (const entry of row.dedicated ?? []) {
        const label = localizedLabel(entry.title, english)
        if (label !== undefined) return label
      }
    }
    return t('composer.dedicated')
  })()

  /**
   * 页脚显示的时刻：优先用**数据的真实读取时刻**（宿主给的 `creditsAtMs`），
   * 没有才退回本组件 fetch 成功的时刻。
   *
   * 此前只有后者，于是刷新失败时页脚时间照样往前走 —— 数字是旧的、时间显示
   * 刚刚，用户无从判断哪个能信（截图里的 800 正是这样看起来像「刚刷新的」）。
   */
  const displayedAt = signedIn?.creditsAtMs ?? lastRefresh
  /** 显示的数字比最近一次 fetch 更老 = 这次没刷出新数据。 */
  const staleDisplay = signedIn?.creditsAtMs !== undefined
    && lastRefresh !== undefined
    && signedIn.creditsAtMs < lastRefresh - 5_000

  return (
    <span ref={rootRef} className="dsm-qoder-composer-credits">
      <button
        type="button"
        className="dsm-qoder-composer-credits-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
        {...billingTitle === undefined ? {} : { title: billingTitle }}
      >
        {label} · {valueText}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          // 多一列时把浮层加宽 56px（issue #38）：248px 是按「账号 + 64px 数字」
          // 调的，第三列直接从账号名身下抢位置。加宽的是**浮层**而不是表格 ——
          // 表格仍是 width:100%，`table-layout:fixed` 照旧（issue #34 的修复）。
          className={dedicatedShown
            ? 'dsm-qoder-composer-panel dsm-qoder-composer-panel-wide'
            : 'dsm-qoder-composer-panel'}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('composer.panelTitle')}
        >
          <div className="dsm-qoder-composer-panel-head">
            <span className="dsm-qoder-composer-panel-title">
              {t(activeRegion === 'cn' ? 'composer.panelTitleCn' : 'composer.panelTitleGlobal' as QoderSettingsKey)}
            </span>
            {/* 页头右侧两颗按钮：**刷新**（左，重测玩家池）与**设置**（右，
                去插件自己的设置页）。
                它们是**两件事**：刷新改的是「此刻的结论」（圆点与原因），设置改
                的是「以后怎么跑」（换号、开池、改阈值）。所以顺序是「先看结论、
                再去改配置」。
                没有 `openSettings`（宿主没挂 Plugins 页）时**只**渲染刷新那颗：
                一个点了没反应的按钮，比没有按钮更糟；而刷新这一颗不依赖任何宿主
                服务，它走的是本插件自己的池路由。 */}
            {/* 右对齐：**一个**外壳负责 `margin-left:auto`，让页头
                始终是「标题 … [刷新][设置]」；宿主没有去处的路由时（不渲染设置
                按钮）也不会留下一个奇怪的悬空定位。 */}
            <span className="dsm-qoder-composer-panel-actions">
              <button
                type="button"
                className="dsm-qoder-composer-panel-refresh"
                // 池关着、或这一区一个成员都没有时就没有「刷新」可言：按钮禁用，
                // 而不是点下去才发现什么也没发生。
                disabled={testing || busy || switchingId !== undefined || !poolTestable}
                title={t('composer.refreshHint')}
                aria-label={t('composer.refreshHint')}
                onClick={() => { void runTestAll() }}
              >
                {/* 循环箭头：这是「重新测一遍」，不是「重读余额」。在批次在飞时
                    **转起来**：一颗禁用按钮配一个不动的图标读起来像坏了，而串行
                    批次足够长，「我这一下到底按上了吗」是个真问题。
                    `aria-hidden` —— 按钮自己带着 aria-label，标签文字也报了名，
                    图标再报一次就是噪音。
                    1.5px 描边：11px 下细描边会糊成一个灰点。 */}
                <svg
                  className={testing
                    ? 'dsm-qoder-composer-panel-refresh-icon dsm-qoder-composer-panel-refresh-icon-spin'
                    : 'dsm-qoder-composer-panel-refresh-icon'}
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M13.4 2.2v2.9h-2.9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="dsm-qoder-composer-panel-refresh-label">
                  {testing ? t('composer.refreshing') : t('composer.refresh')}
                </span>
              </button>
              {openSettings === undefined
                ? null
                : (
                    <button
                      type="button"
                      className="dsm-qoder-composer-panel-settings"
                      title={t('composer.openSettingsHint')}
                      onClick={() => {
                        setOpen(false)
                        openSettings()
                      }}
                    >
                      {/* 齿轮：标签只有一个词，而下划线单词会读成「碰巧能点的
                          正文」。`aria-hidden` 是必须的 —— 按钮自己的文字已经
                          报了名，图标不能再被播报一次。
                          1.5px 描边而不是 1.3：11px 下齿轮的齿会糊成一个灰盘，
                          在标签旁边看成一块污渍；12px + 1.5 才让齿留得住 ——
                          形状本身就是可点击性。 */}
                      <svg
                        className="dsm-qoder-composer-panel-settings-icon"
                        viewBox="0 0 16 16"
                        width="12"
                        height="12"
                        fill="none"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path
                          d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                        <path
                          d="M12.9 9.6a1.2 1.2 0 0 0 .24 1.32l.04.04a1.4 1.4 0 1 1-1.98 1.98l-.04-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.72 1.1v.12a1.4 1.4 0 1 1-2.8 0v-.07a1.2 1.2 0 0 0-.78-1.1 1.2 1.2 0 0 0-1.32.24l-.04.04a1.4 1.4 0 1 1-1.98-1.98l.04-.04a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.72h-.12a1.4 1.4 0 1 1 0-2.8h.07a1.2 1.2 0 0 0 1.1-.78 1.2 1.2 0 0 0-.24-1.32l-.04-.04a1.4 1.4 0 1 1 1.98-1.98l.04.04a1.2 1.2 0 0 0 1.32.24h.05a1.2 1.2 0 0 0 .72-1.1v-.12a1.4 1.4 0 1 1 2.8 0v.07a1.2 1.2 0 0 0 .72 1.1 1.2 1.2 0 0 0 1.32-.24l.04-.04a1.4 1.4 0 1 1 1.98 1.98l-.04.04a1.2 1.2 0 0 0-.24 1.32v.05a1.2 1.2 0 0 0 1.1.72h.12a1.4 1.4 0 1 1 0 2.8h-.07a1.2 1.2 0 0 0-1.1.72Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="dsm-qoder-composer-panel-settings-label">
                        {t('composer.openSettings')}
                      </span>
                    </button>
                  )}
            </span>
          </div>
          {signedOut
            ? <p className="dsm-qoder-composer-panel-empty">{t('composer.signedOut')}</p>
            : rows.length === 0
              ? <p className="dsm-qoder-composer-panel-empty">{t('composer.noAccounts')}</p>
              : (
                <table className="dsm-qoder-composer-panel-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('composer.account')}</th>
                      {/* 专属积分（issue #38）：**独立一列、在普通积分左边**，因为
                          它是「选了某只模型才优先抵扣」的另一笔钱 —— 加进右边那个
                          数字会让胶囊显示一个用户花不掉的总数。没有专属包时这一列
                          （连 th 一起）不渲染，两列形态与以前逐字相同。 */}
                      {dedicatedShown
                        ? <th scope="col" className="dsm-qoder-composer-panel-num dsm-qoder-composer-panel-dedicated">{dedicatedHeader}</th>
                        : null}
                      <th scope="col" className="dsm-qoder-composer-panel-num">{t('composer.credits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      // 「在用」= 宿主算好的 `current`：第一发永远打给区域选中的号，
                      // 只有池开且选中号此刻被排除时，current 才落在接管它的成员身上
                      // （与 src/shim.ts 的请求路径同判）。旧宿主没这字段时才退回
                      // 选中号 —— 面板此前直接读 `selected`，于是绿点给了额度用尽的
                      // 号、真正在用的号反而是灰的（用户实拍，2026-10-18）。
                      const current = row.current ?? row.id === selectedId
                      // 第二行：不能用的写原因（能自己好的再补「约 N 分钟后解禁」），
                      // 能用且正在用的写「当前选用」——用户的规则（2026-10-18）：
                      // 「能用的绿色圆点；当前选择的，绿色圆点加第二行提示当前选用；
                      // 不能用的红色圆点+原因」。颜色只回答能不能用，哪一个是它靠
                      // 这行字说。
                      const excluded = exclusionText(t, row.excludedBy, row.retryAtMs, Date.now(), row.retrySource)
                      const mark = excluded ?? (current ? t('composer.currentPick') : undefined)
                      // 点色只有两种：能用绿、不能用红（account-state.ts 的同一判定，
                      // 与设置页大表同源）。此前它还要分辨「测过/没测过」，用户改口
                      // 后没测过但没被排除就是「能用」——绿。
                      /** 这一行的专属积分读数（合计 + 悬停）；没有包时 `undefined`。 */
                      const rowDedicated = dedicatedOf(row.dedicated)
                      const dotColor = accountStateColor(accountStateTone({
                        ...row.excludedBy === undefined ? {} : { excludedBy: row.excludedBy },
                        ...row.probeOutcome === undefined ? {} : { probeOutcome: row.probeOutcome },
                      }))
                      return (
                        <tr
                          key={row.id}
                          className={current ? 'dsm-qoder-composer-panel-row-current' : undefined}
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="dsm-qoder-composer-panel-switch"
                              disabled={!canSwitch || switchingId !== undefined || current}
                              aria-label={t('composer.switchTo', { account: row.accountName })}
                              onClick={() => { void switchTo(row.id) }}
                            >
                              <span
                                className="dsm-qoder-composer-panel-dot"
                                style={{ background: dotColor }}
                                aria-hidden="true"
                              />
                              <span className="dsm-qoder-composer-panel-who">
                                {/* 两行文字都可能被**省略/换行**（issue #34）：账号
                                    名有 ellipsis，状态文案换行但窄浮层里也可能被折到
                                    很不好读。两种情况下悬停都该能读到完整原文 ——
                                    尤其中文状态里「（按今日额度窗口推算）」这半句，
                                    它说的是这个时刻**是推算的**、不是上游承诺的。 */}
                                <span className="dsm-qoder-composer-panel-name" title={row.accountName}>{row.accountName}</span>
                                {mark === undefined
                                  ? null
                                  : excluded === undefined
                                    // 「当前选用」是中性/正向信息，不该用告警色。
                                    ? <span className="dsm-qoder-composer-panel-pick">{mark}</span>
                                    : <span className="dsm-qoder-composer-panel-mark" title={mark}>{mark}</span>}
                              </span>
                            </button>
                          </th>
                          {/* 专属包只填在**它自己的那一行**：`dedicated` 是逐号读
                              usage 时各号自己那份，别的行没有就是没有（不是 0）。 */}
                          {dedicatedShown
                            ? (
                              <td className="dsm-qoder-composer-panel-num dsm-qoder-composer-panel-dedicated">
                                {rowDedicated === undefined
                                  ? <span className="dsm-qoder-composer-panel-none">—</span>
                                  : <span title={rowDedicated.title}>{rowDedicated.text}</span>}
                              </td>
                              )
                            : null}
                          <td className="dsm-qoder-composer-panel-num">
                            {row.credits === undefined ? '—' : formatCredits(row.credits)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
          <div className="dsm-qoder-composer-panel-foot">
            <span>
              {t('composer.lastRefresh')} {displayedAt === undefined ? '—' : formatClock(displayedAt)}
              {/* 数据时刻与 fetch 时刻不是一回事：刷新失败时后者照样往前走，
                  只显示它就会让「旧数字」看起来像新数据。有真实读取时刻时，
                  两者不一致就把数字标成旧的。 */}
              {staleDisplay ? ` · ${t('composer.dataStale')}` : ''}
            </span>
          </div>
          {failed || signedIn?.refreshError !== undefined
            ? <p className="dsm-qoder-composer-panel-error" role="status">{t('composer.refreshFailed')}</p>
            : null}
          {/* 批量探针失败单独一行：它与「积分读不出来」是两件事 —— 读数可能好好的，
              而这次重测没跑起来。用户需要知道圆点为什么还是旧的。 */}
          {testFailed
            ? <p className="dsm-qoder-composer-panel-error" role="status">{t('composer.refreshAccountsFailed')}</p>
            : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
