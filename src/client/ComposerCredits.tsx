/**
 * Credit readout for the composer tool row (`conversation.input.left`).
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `ComposerCredits.tsx`：读数形态（`<区域> · <余额>`）、点击弹出锚定面板、
 *     面板内是**账号表格**（点行即切换账号）、刷新按钮放在面板里而不是读数上、
 *     每账号读数**只在面板打开时抓**、5 分钟定时器、失败保留上次数值。
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
import { accountStateTone, accountStateColor } from './account-state.ts'
import { QODER_COMPOSER_CSS } from './styles.ts'
import type { QoderWebAccountCredit, QoderWebRegion, QoderWebUsage } from '../status-paths.ts'
import type { QoderSettingsKey, Translate } from './locales.ts'

/**
 * Inject the readout's styles into the document head, once, on module load.
 *
 * Same idempotent pattern as the card's injection: the classes are attached to
 * DOM this component owns, and `QODER_CARD_CSS` only loads when the settings
 * card does — which is not guaranteed on a host where the card is never rendered.
 */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-qoder/composer-credits.css'
  if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-qoder'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = QODER_COMPOSER_CSS
    document.head.appendChild(styleTag)
  }
}

/** Automatic refresh period. Five minutes, matching a credit balance's actual rate of change. */
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

function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function ComposerCredits(props: ComposerCreditsProps) {
  const { t, provider, region, settingsScope } = props
  if (t === undefined) throw new Error('Composer credits readout requires its translation function')
  const owned = provider === undefined ? undefined : QODER_COMPOSER_PROVIDERS[provider]
  const activeRegion = region ?? owned

  const [usage, setUsage] = useState<QoderWebUsage | undefined>(undefined)
  const [accountCredits, setAccountCredits] = useState<QoderWebAccountCredit[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [failed, setFailed] = useState(false)
  const [testFailed, setTestFailed] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
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

  // Fetch usage on mount and when the region changes; a timer starts only after
  // the first fetch settles.
  useEffect(() => {
    if (owned === undefined) return undefined
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    void fetchUsage(controller.signal).finally(() => {
      if (cancelled) return
      timer = window.setInterval(() => { void fetchUsage(controller.signal) }, COMPOSER_CREDITS_REFRESH_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      controller.abort()
    }
  }, [owned, fetchUsage])

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
   * 「一键测试」：设置页工具栏那颗「一键测试所有账号」的同一件事，搬进面板。
   *
   * 原来的按钮是「刷新积分」，只重读余额——余额读不出「还能不能用」，而面板的
   * 点色、第二行的「被拒绝／用量已达上限／限流 · 约 N 分钟后解禁」全部来自
   * 探针结论。所以这颗按钮真正该做的是把每个成员真跑一次：探针写回宿主快照
   * 之后，颜色与原因才是刚测出来的，而不是打开面板那一刻的旧账。
   *
   * 批量是串行的真实探针（一个号十几秒到几十秒），因此不干等整批响应：边跑边读
   * 宿主的只读进度（`action=progress`，不碰上游），每落一行就把账号表重取一次，
   * 用户能看着圆点一行一行翻新。整批结束（成功或失败）后再补最后一读。
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

  // Not this plugin's model: render nothing at all.
  if (owned === undefined) return null

  const signedIn = usage?.status === 'signed-in' ? usage : undefined
  const total = signedIn === undefined ? undefined : creditsOf(signedIn)
  const signedOut = usage !== undefined && usage.status === 'signed-out'
  const valueText = total === undefined ? '—' : formatCredits(total)
  const label = t(activeRegion === 'cn' ? 'composer.pointsCn' : 'composer.pointsGlobal' as QoderSettingsKey)

  const selectedId = accountCredits?.find(account => account.selected)?.id
    ?? (signedIn === undefined ? undefined : signedIn.accountId)
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
    if (row.id !== selectedId || row.credits !== undefined || total === undefined) return row
    return { ...row, credits: total }
  })
  const canSwitch = settingsScope !== undefined

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
      >
        {label} · {valueText}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="dsm-qoder-composer-panel"
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('composer.panelTitle')}
        >
          <div className="dsm-qoder-composer-panel-head">
            <span className="dsm-qoder-composer-panel-title">
              {t(activeRegion === 'cn' ? 'composer.panelTitleCn' : 'composer.panelTitleGlobal' as QoderSettingsKey)}
            </span>
            <button
              type="button"
              className="dsm-qoder-composer-panel-refresh"
              disabled={testing || busy || switchingId !== undefined}
              title={t('composer.testAllHint')}
              onClick={() => { void runTestAll() }}
            >
              {testing ? t('composer.testing') : t('composer.testAll')}
            </button>
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
                      const excluded = exclusionText(t, row.excludedBy, row.retryAtMs)
                      const mark = excluded ?? (current ? t('composer.currentPick') : undefined)
                      // 点色只有两种：能用绿、不能用红（account-state.ts 的同一判定，
                      // 与设置页大表同源）。此前它还要分辨「测过/没测过」，用户改口
                      // 后没测过但没被排除就是「能用」——绿。
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
                                <span className="dsm-qoder-composer-panel-name">{row.accountName}</span>
                                {mark === undefined
                                  ? null
                                  : excluded === undefined
                                    // 「当前选用」是中性/正向信息，不该用告警色。
                                    ? <span className="dsm-qoder-composer-panel-pick">{mark}</span>
                                    : <span className="dsm-qoder-composer-panel-mark">{mark}</span>}
                              </span>
                            </button>
                          </th>
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
          {testFailed
            ? <p className="dsm-qoder-composer-panel-error" role="status">{t('composer.testFailed')}</p>
            : failed || signedIn?.refreshError !== undefined
              ? <p className="dsm-qoder-composer-panel-error" role="status">{t('composer.refreshFailed')}</p>
              : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
