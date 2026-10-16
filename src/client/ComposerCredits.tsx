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
  QODER_USAGE_PATH,
  withQoderRegion,
} from '../status-paths.ts'
import { writeAccountSlot } from './account-selection.ts'
import type { QoderAccountScope } from './account-selection.ts'
import { exclusionText } from './exclusion-text.ts'
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
  const [failed, setFailed] = useState(false)
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
              disabled={busy || switchingId !== undefined}
              onClick={() => { void fetchUsage() }}
            >
              {busy ? t('composer.refreshing') : t('composer.refresh')}
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
                      const current = row.id === selectedId
                      const excluded = exclusionText(t, row.excludedBy)
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
                              <span className="dsm-qoder-composer-panel-dot" aria-hidden="true" />
                              <span className="dsm-qoder-composer-panel-who">
                                <span className="dsm-qoder-composer-panel-name">{row.accountName}</span>
                                {excluded === undefined
                                  ? null
                                  : <span className="dsm-qoder-composer-panel-mark">{excluded}</span>}
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
          {failed || signedIn?.refreshError !== undefined
            ? <p className="dsm-qoder-composer-panel-error" role="status">{t('composer.refreshFailed')}</p>
            : null}
        </div>,
        document.body,
      )}
    </span>
  )
}
