/**
 * Qoder (Lingma) credits & models card contributed to Harness Plugin
 * configuration.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体结构（折叠外壳 `<li class="dsm-plugin-card">` + header/icon/title/
 *     description/chevron、国内/国际 tab 栏 + 供应商开关、账号下拉、积分区、模型表、
 *     探针行、60 秒轮询与 AbortController 清理、模块加载时注入一次 `<style>`、
 *     纯 CSS caret）、以及 `dsm-*` 类名体系与 `--dsw-alias-*` 主题变量用法，
 *     均沿用自该项目；其又逐字承接 dingminhua/dsh-connect-trae（MIT）与
 *     dingminhua/dsh-subagent-default-model（MIT）。
 * 改动（按 Qoder 现实）：
 *   1. 账号是 PAT（settings / env / vault），不是桌面端登录：无 searched-paths
 *      诊断、无 OAuth 登录；账号列表旁是「Add PAT」表单与每 vault 账号的删除；
 *   2. 没有每日签到：`QoderWebPool.checkinSupported` 恒 false，签到动作/列不渲染；
 *   3. 积分是「基础/附加/组织」三类额度桶（`QoderWebCredits.packages`）聚合渲染；
 *   4. 模型行：勾选（enabledModelKeys / offModelKeys）、图像开关（supportsImages）、
 *      上下文预算 tier 选择器（model.contextTiers + contextBudgets）、探针；
 *   5. 保存仍是草稿态 + dirty + 「保存/放弃」，写入走共享的 verified-write
 *      (`account-selection.write*`)，Host 端点优先、`__save` 回退。
 *
 * 数据流：
 * - 配置值（PAT、accountId、开关、勾选、contextBudgets、pool 偏好）经
 *   `settingsScope`（宿主 settings 镜像）读写，或经 `QODER_SAVE_PATH` 回退。
 * - 状态（账号、额度、模型目录、探针、池）经本插件只读路由获取。
 *
 * @module dsh-connect-qoder/client/QoderCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  QODER_ACCOUNTS_PATH,
  QODER_ACCOUNTS_REFRESH_PATH,
  QODER_GITHUB_URL,
  QODER_MODELS_REFRESH_PATH,
  QODER_PROBE_PATH,
  QODER_REGIONS,
  QODER_USAGE_PATH,
  withQoderRegion,
  withQoderRouteAction,
} from '../status-paths.ts'
import type {
  QoderWebModel,
  QoderWebProbeOutcome,
  QoderWebProbeResult,
  QoderWebRegion,
  QoderWebUsage,
} from '../status-paths.ts'
import type { QoderAccountScope } from './account-selection.ts'
import {
  writeAccountSlot,
  writeRegionCreditsShown,
  writeRegionEnabled,
  writeRegionModels,
} from './account-selection.ts'
import { AccountPool } from './AccountPool.tsx'
import { AddAccount } from './AddAccount.tsx'
import { AccountTransfer } from './AccountTransfer.tsx'
import { inlineProbeReason } from './probe-reason.ts'
import { QODER_PAT_ENV_VARS } from '../credentials.ts'
import type { QoderRegion } from '../upstream.ts'
import { QODER_PLUGIN_ICON } from './icon.ts'
import { QODER_CARD_CSS } from './styles.ts'
import { imageDefaultFor, nativeModalityOf } from '../native-modality.ts'
import type { Translate } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderCardInjected {
  t: Translate
  /**
   * Optional by design: a host line that provides neither settings surface
   * leaves this undefined, and the card renders read-only — saving is the only
   * capability that needs it.
   */
  settingsScope?: QoderAccountScope & { subscribe(listener: () => void): () => void }
}

/**
 * Props delivered by the Plugin configuration slot.
 */
export type QoderCardProps =
  Partial<QoderCardInjected>
  & { view?: string }

const POLL_INTERVAL_MS = 60_000

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-qoder/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = QODER_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-qoder'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = QODER_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

/** One region's unsaved model edits; switching tabs never drops these. */
interface QoderDraft {
  enabledModelKeys: Set<string>
  offModelKeys: Set<string>
  supportsImages: Set<string>
  contextBudgets: Record<string, number>
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

function dotStyle(status: QoderWebUsage['status']): Record<string, string> {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { background: color }
}

function probeOutcomeLabel(t: Translate, outcome: QoderWebProbeOutcome): string {
  switch (outcome) {
    case 'ok': return t('row.probeOk')
    case 'rate-limited': return t('row.probeRateLimitedUnknown')
    case 'out-of-credit': return t('row.probeOutOfCreditUnknown')
    case 'credential-rejected': return t('row.probeCredentialRejected')
    case 'policy-rejected': return t('row.probePolicyRejected')
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
  }
}

function probeResultTone(outcome: QoderWebProbeOutcome): 'ok' | 'warn' | 'bad' {
  switch (outcome) {
    case 'ok': return 'ok'
    case 'rate-limited':
    case 'out-of-credit': return 'warn'
    default: return 'bad'
  }
}

/** The credit bucket name label for one packageName. */
function bucketLabel(t: Translate, packageName: string): string {
  switch (packageName) {
    case 'base': return t('row.usageBucketBase')
    case 'addon': return t('row.usageBucketAddon')
    case 'org': return t('row.usageBucketOrg')
    default: return packageName
  }
}

/**
 * 某个模型图片开关的说明文字。
 *
 * 复选框只对**厂商文档确认原生 multimodal** 的模型默认勾选，所以另外两种
 * 结果必须说清「为什么没勾」——否则一个文档上纯文本的模型和一个未核实的
 * 模型，在已经勾选的兄弟旁边看起来是一样地「坏了」。三种状态各给一句不同
 * 的 tooltip，或直接不显示开关（`router`/`unknown` 的模型该不该勾没有依据，
 * 但用户仍可手动勾）。
 */
function imageCheckboxHint(modelKey: string, t: Translate): string {
  switch (nativeModalityOf(modelKey)) {
    case 'multimodal': return t('row.modelImage')
    case 'text': return t('row.modelImageText')
    default: return t('row.modelImageUnverified')
  }
}

export function QoderCard(props: QoderCardProps): ReactElement {
  const { view } = props
  // The injected `t` is always present in real wiring; fall back to the key when
  // a test renders without one.
  const t: Translate = props.t ?? ((key: string) => key)
  // Re-fetch the region's usage on the 60 s cadence, plus on demand.
  const [open, setOpen] = useState(view === 'summary')
  const [activeRegion, setActiveRegion] = useState<QoderWebRegion>(() => 'cn')
  const [usages, setUsages] = useState<Partial<Record<QoderWebRegion, QoderWebUsage | undefined>>>({})
  const [busyRegions, setBusyRegions] = useState<ReadonlySet<QoderWebRegion>>(new Set())
  const [probes, setProbes] = useState<Record<string, QoderWebProbeResult | undefined>>({})
  const [probeBusy, setProbeBusy] = useState<ReadonlySet<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [siblingBusy, setSiblingBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, QoderDraft | undefined>>({})
  const [revision, setRevision] = useState(0)
  const mounted = useRef(true)
  const controllers = useRef<AbortController | null>(null)

  const scope = props.settingsScope

  // Re-render when the mirror changes so a concurrent write (composer panel,
  // Add PAT) shows up without a remount.
  useEffect(() => scope?.subscribe(() => setRevision(v => v + 1)), [scope])

  const refresh = useCallback(async (region: QoderWebRegion, force?: boolean): Promise<void> => {
    controllers.current?.abort()
    const controller = new AbortController()
    controllers.current = controller
    setBusyRegions(prev => new Set(prev).add(region))
    try {
      const response = await fetch(withQoderRegion(QODER_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as QoderWebUsage
      if (!mounted.current || controller.signal.aborted) return
      setUsages(prev => ({ ...prev, [region]: value }))
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return
      setUsages(prev => ({
        ...prev,
        [region]: error instanceof Error ? { status: 'error', message: error.message } : { status: 'error', message: String(error) },
      }))
    } finally {
      if (mounted.current) setBusyRegions(prev => new Set([...prev].filter(r => r !== region)))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh('cn')
    if (typeof window !== 'undefined') {
      const timer = window.setInterval(() => {
        for (const region of QODER_REGIONS) void refresh(region)
      }, POLL_INTERVAL_MS)
      return () => { mounted.current = false; window.clearInterval(timer); controllers.current?.abort() }
    }
    return () => { mounted.current = false; controllers.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch the ACTIVE region whenever a settings write might have changed the
  // serving account (the write helpers call onChanged from sub-sections only;
  // the card itself re-reads here on revision bumps).
  useEffect(() => {
    void refresh(activeRegion, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const usage = usages[activeRegion]
  const regionOn = usage !== undefined && usage.status !== 'error' ? regionEnabledOfUsage(usage) : true

  const cartesianModels = usage?.status === 'signed-in' ? usage.models : []
  const enabledModelKeys = usage?.status === 'signed-in' ? usage.enabledModelKeys : []
  const offModelKeys = usage?.status === 'signed-in' ? usage.offModelKeys : []
  const savedBudgets = usage?.status === 'signed-in' ? (usage.contextBudgets ?? {}) : {}

  const draft: QoderDraft = drafts[activeRegion] ?? {
    enabledModelKeys: new Set(enabledModelKeys),
    offModelKeys: new Set(offModelKeys),
    // 图片开关的默认值来自**已核对的原生模态表**，不是平台的 `is_vl` 标记：
    // 后者在本插件的目录里几乎对每个模型都是 true（含纯文本模型），拿它当
    // 能力答案会在纯文本模型上默认开出图片输入。见 src/native-modality.ts。
    supportsImages: new Set(cartesianModels.filter(m => imageDefaultFor({ id: m.key, ...(m.supportsImages === undefined ? {} : { supportsImages: m.supportsImages }) })).map(m => m.key)),
    contextBudgets: { ...savedBudgets },
  }

  const toggleModel = (key: string, on: boolean): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.enabledModelKeys.add(key)
      else d.enabledModelKeys.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const toggleOff = (key: string, on: boolean): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.offModelKeys.add(key)
      else d.offModelKeys.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const toggleImageLight = (key: string, on: boolean): void => {
    // The image toggle rides along in the saved lastCatalog model's
    // `supportsImages` field; it is a presentation/persistence preference.
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.supportsImages.add(key)
      else d.supportsImages.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const setContextBudget = (key: string, tokens: number): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (tokens > 0) d.contextBudgets[key] = tokens
      else delete d.contextBudgets[key]
      return { ...prev, [activeRegion]: d }
    })
  }

  const runProbe = async (modelKey: string): Promise<void> => {
    setProbeBusy(prev => new Set(prev).add(modelKey))
    try {
      const response = await fetch(`${withQoderRegion(QODER_PROBE_PATH, activeRegion)}&model=${encodeURIComponent(modelKey)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as QoderWebProbeResult
      if (mounted.current) setProbes(prev => ({ ...prev, [modelKey]: result }))
    } catch (error) {
      if (mounted.current) {
        const httpStatus = Number.parseFloat(String((error as Error)?.message ?? '').replace(/\D+/g, '')) || undefined
        const failed: QoderWebProbeResult = {
          modelId: modelKey,
          outcome: 'failed',
          message: String((error as Error)?.message ?? error),
        }
        if (httpStatus !== undefined) failed.status = httpStatus
        setProbes(prev => ({ ...prev, [modelKey]: failed }))
      }
    } finally {
      if (mounted.current) setProbeBusy(prev => new Set([...prev].filter(k => k !== modelKey)))
    }
  }

  const refreshModels = async (): Promise<void> => {
    setSiblingBusy(true)
    try {
      const response = await fetch(withQoderRegion(QODER_MODELS_REFRESH_PATH, activeRegion), {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh(activeRegion, true)
    } catch (error) {
      if (mounted.current) setSaveError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setSiblingBusy(false)
    }
  }

  const rescanAccounts = async (): Promise<void> => {
    setSiblingBusy(true)
    try {
      const response = await fetch(withQoderRegion(QODER_ACCOUNTS_REFRESH_PATH, activeRegion), {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh(activeRegion, true)
    } catch (error) {
      if (mounted.current) setSaveError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setSiblingBusy(false)
    }
  }

  const saveModels = async (): Promise<void> => {
    if (scope === undefined) return
    setSaving(true)
    setSaveError(undefined)
    const payload = buildModelsPayload(draft, cartesianModels)
    try {
      await writeRegionModels(scope, activeRegion, payload)
      setDrafts(prev => ({ ...prev, [activeRegion]: undefined }))
      setDirty(false)
      await refresh(activeRegion, true)
    } catch (error) {
      setSaveError(isContention(error)
        ? `${t('row.saveError', { message: String((error as Error)?.message ?? error) })}${t('row.saveContentionHint')}`
        : t('row.saveError', { message: String((error as Error)?.message ?? error) }))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const discardModels = (): void => {
    setDrafts(prev => ({ ...prev, [activeRegion]: undefined }))
    setDirty(false)
    setSaveError(undefined)
  }

  const removeVaultAccount = async (accountId: string): Promise<void> => {
    setSiblingBusy(true)
    try {
      const response = await fetch(withQoderRouteAction(QODER_ACCOUNTS_PATH, activeRegion, 'remove'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      await refresh(activeRegion, true)
    } catch (error) {
      if (mounted.current) setSaveError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setSiblingBusy(false)
    }
  }

  const signIn = usage?.status === 'signed-in' ? usage : undefined

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        onClick={() => { setOpen(!open) }}
        aria-expanded={open}
      >
        <img className="dsm-plugin-card-icon" src={QODER_PLUGIN_ICON} alt="" width="32" height="32" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{t('row.title')}</span>
          <span className="dsm-plugin-card-description">{t('row.desc')}</span>
        </span>
        <span className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`} aria-hidden="true" />
      </button>

      {open ? (
        <div className="dsm-plugin-card-body">
          {/* Tab bar: one tab = one provider (qoder / qoder-global). */}
          <div className="dsm-qoder-tabs">
            {QODER_REGIONS.map(region => {
              const on = region === activeRegion
              const regionStatus = usages[region]?.status ?? 'signed-out'
              return (
                <div key={region} className={`dsm-qoder-tab${hasStatusDot(usages[region]) ? ' dsm-qoder-tab-dot' : ''}${on ? ' dsm-qoder-tab-active' : ''}`}>
                  <button
                    type="button"
                    className="dsm-qoder-tab-cell"
                    onClick={() => { setActiveRegion(region as 'cn' | 'global'); setSaveError(undefined) }}
                  >
                    {usages[region] === undefined
                      ? null
                      : <span aria-hidden="true" className="dsm-qoder-tab-dot" style={dotStyle(usages[region]?.status ?? 'signed-out')} />}
                    {region === 'cn' ? t('row.tabCn') : t('row.tabGlobal')}
                  </button>
                  <label className="dsm-qoder-tab-switch" title={t('row.tabSwitchHint')}>
                    <input
                      type="checkbox"
                      checked={regionOnOf(usages[region])}
                      disabled={!canWrite(scope) || siblingBusy}
                      aria-label={t('row.tabSwitchAria', { region: region === 'cn' ? t('row.tabCn') : t('row.tabGlobal') })}
                      onChange={(event) => { toggleRegion(region, event.target.checked) }}
                    />
                  </label>
                </div>
              )
            })}
          </div>
          <p className="dsm-qoder-usage-hint">{t('row.tabHint')}</p>
          {!regionOn
            ? <p className="dsm-qoder-tab-off-notice">{t('row.tabOffNotice')}</p>
            : null}

          {/* Credits readout + sidebar-credit switch */}
          <div className="dsm-qoder-usage">
            <label
              className="dsm-qoder-credits-switch"
              title={activeRegion === 'cn' ? t('row.showCreditsCnHint') : t('row.showCreditsGlobalHint')}
            >
              <input
                type="checkbox"
                checked={regionOn ? creditsShownOf(usage) : false}
                disabled={!regionOn || !canWrite(scope) || siblingBusy}
                onChange={(event) => { toggleCreditsShown(event.target.checked) }}
              />
              {activeRegion === 'cn' ? t('row.showCreditsCn') : t('row.showCreditsGlobal')}
            </label>

            {renderCredits()}
          </div>

          {signIn?.credentialRejected === true ? renderRejected(signIn) : null}
          {usage?.status === 'error' ? <p className="dsm-qoder-usage-error" role="alert">{usage.message}</p> : null}
          {usage?.status === 'signed-in' && usage.refreshError !== undefined
            ? <p className="dsm-qoder-hint">{t('row.requestFailedHint', { message: usage.refreshError })}</p>
            : null}
          {usage?.status === 'signed-out' && usage.selectionLost === true
            ? <p className="dsm-qoder-hint">{t('row.selectionLostHint')}</p>
            : null}

          {regionOn ? (
            <>
              {/* Account selection + add-/remove-PAT + transfer */}
              {renderAccounts(signIn)}
              {renderModels()}
              {renderPool()}
            </>
          ) : null}

          <footer className="dsm-qoder-foot">
            <a href={QODER_GITHUB_URL} target="_blank" rel="noreferrer">{t('row.gitHub')}</a>
            <span style={{ marginLeft: 'auto' }}>{t('row.docsHint')}</span>
          </footer>
        </div>
      ) : null}
    </li>
  )

  // ------------- helper renderers (closures over the active region) -------------

  function toggleRegion(region: QoderWebRegion, on: boolean): void {
    if (scope === undefined) return
    setSiblingBusy(true)
    void writeRegionEnabled(scope, region, on, slotWith(scope, region, { enabled: on })).finally(() => {
      if (mounted.current) setSiblingBusy(false)
    })
  }

  function toggleCreditsShown(on: boolean): void {
    if (scope === undefined) return
    setSiblingBusy(true)
    void writeRegionCreditsShown(scope, activeRegion, on, slotWith(scope, activeRegion, { showCreditsInMainUi: on })).finally(() => {
      if (mounted.current) setSiblingBusy(false)
    })
  }

  function renderCredits(): ReactElement {
    const c = signIn?.credits
    return (
      <div className="dsm-qoder-usage">
        {c === undefined
          ? <p className="dsm-qoder-usage-text">{signIn?.creditsError === undefined ? t('row.usageUnavailable') : t('row.creditsError', { message: signIn.creditsError })}</p>
          : (
            <>
              <p className="dsm-qoder-usage-text">
                <b>{formatNumber(c.total)}</b> {t('row.usageToken')}
                {c.nearestExpiryMs === undefined ? null : <> · {t('row.usageNearestExpiry', { at: formatDate(c.nearestExpiryMs) })}</>}
                {c.expiringSoon > 0 ? <> · {t('row.usageExpiringSoon', { count: String(c.expiringSoon) })}</> : null}
              </p>
              {c.packages.map(pkg => {
                const pct = pkg.size <= 0 ? 0 : Math.min(100, Math.round((pkg.remain / pkg.size) * 100))
                return (
                  <div key={pkg.packageName} className="dsm-qoder-usage">
                    <div className="dsm-qoder-usage" style={{ gap: 4 }}>
                      <span className="dsm-qoder-usage-text">
                        <b>{bucketLabel(t, pkg.packageName)}</b> · {formatNumber(pkg.remain)} / {formatNumber(pkg.size)}
                        {pkg.expiresAtMs === undefined
                          ? pkg.monthly ? ` (${t('row.usageTotal')})` : ''
                          : ` (${pkg.expiresAtMs <= Date.now() ? t('row.usageExpired') : t('row.usageExpiresAt', { at: formatDate(pkg.expiresAtMs) })})`}
                      </span>
                      <progress className="dsm-qoder-usage-progress" value={pkg.remain} max={pkg.size} />
                    </div>
                  </div>
                )
              })}
            </>
          )}
      </div>
    )
  }

  function renderRejected(usage: Extract<QoderWebUsage, { status: 'signed-in' }>): ReactElement | null {
    const recovery = usage.recovery
    return (
      <div className="dsm-qoder-rejected">
        <b>{t('row.credentialRejectedTitle')}</b>
        <span>{t('row.credentialRejectedIntro', { accountName: usage.accountName })}</span>
        {recovery?.usableAccount !== undefined ? (
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canWrite(scope) || siblingBusy}
            onClick={() => {
              if (scope === undefined) return
              setSiblingBusy(true)
              void writeAccountSlot(scope, activeRegion, recovery.usableAccount!.accountId).finally(() => {
                if (mounted.current) { setSiblingBusy(false); void refresh(activeRegion, true) }
              })
            }}
          >
            {t('row.credentialRejectedSwitch', { accountName: recovery.usableAccount.accountName })}
          </button>
        ) : null}
        {recovery?.reloginRequired === true ? <span>{t('row.credentialRejectedRelogin')}</span> : null}
      </div>
    )
  }

  function renderAccounts(usage: Extract<QoderWebUsage, { status: 'signed-in' }> | undefined): ReactElement {
    const accounts = usage?.accounts ?? []
    return (
      <div className="dsm-qoder-usage">
        <div className="dsm-qoder-usage-select-wrap">
          <select
            className="dsm-qoder-usage-select"
            value={usage?.accountId ?? ''}
            disabled={!canWrite(scope) || siblingBusy}
            aria-label={t('row.accountSelectAria')}
            onChange={(event) => {
              if (scope === undefined) return
              setSiblingBusy(true)
              void writeAccountSlot(scope, activeRegion, event.target.value).finally(() => {
                if (mounted.current) { setSiblingBusy(false); void refresh(activeRegion, true) }
              })
            }}
          >
            <option value="">{t('row.accountSelectAuto')}</option>
            {accounts.map(account => (
              <option key={account.id} value={account.id}>{account.accountName === '' ? t('row.accountUnnamed') : account.accountName}</option>
            ))}
          </select>
        </div>

        <div className="dsm-qoder-usage-account-actions">
          <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={siblingBusy} onClick={() => { void rescanAccounts() }}>
            {t('row.accountsRescan')}
          </button>
          {accounts.filter(a => a.source === 'vault').map(a => (
            <button
              key={a.id}
              type="button"
              className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn"
              title={t('row.accountRemoveHint')}
              aria-label={t('row.accountRemoveAria', { accountName: a.accountName || t('row.accountUnnamed') })}
              disabled={siblingBusy}
              onClick={() => { void removeVaultAccount(a.id) }}
            >
              {t('row.accountRemoveHint')} · {a.accountName || t('row.accountUnnamed')}
            </button>
          ))}
        </div>

        <AddAccount t={t} region={activeRegion} onAdded={() => refresh(activeRegion, true)} />
        <AccountTransfer t={t} region={activeRegion} accounts={accounts.map(a => ({ id: a.id, accountName: a.accountName }))} onChanged={() => refresh(activeRegion, true)} />
      </div>
    )
  }

  function renderModels(): ReactElement {
    const modelList = signIn?.models ?? []
    const summary = `${t('row.modelsSummary', { enabled: String(draft.enabledModelKeys.size), total: String(modelList.length) })}${dirty ? ` · ${t('row.modelsDirty')}` : ''}`
    return (
      <section className="dsm-qoder-models">
        <div className="dsm-qoder-models-head">
          <div className="dsm-qoder-models-title-row">
            <h3 className="dsm-qoder-models-title">{t('row.modelsTitle')}</h3>
            <span className="dsm-qoder-models-summary">{summary}</span>
          </div>
          <div className="dsm-qoder-models-head-actions">
            <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-model-probe" disabled={siblingBusy} onClick={() => { void refreshModels() }}>
              {t('row.modelsRefresh')}
            </button>
          </div>
        </div>

        {modelList.length === 0 ? (
          <p className="dsm-qoder-usage-hint">{t('row.usageUnavailable')}</p>
        ) : (
          <div className="dsm-qoder-model-list">
            {modelList.map(model => (
              <div key={model.key} className={`dsm-qoder-model${draft.enabledModelKeys.has(model.key) ? '' : ' dsm-qoder-model-disabled'}`}>
                <div className="dsm-qoder-model-head">
                  <label className="dsm-qoder-model-enabled">
                    <input
                      type="checkbox"
                      checked={draft.enabledModelKeys.has(model.key)}
                      disabled={!canWrite(scope) || siblingBusy}
                      onChange={(e) => toggleModel(model.key, e.target.checked)}
                    />
                    <span className="dsm-qoder-model-copy">
                      <span className="dsm-qoder-model-name">
                        {t('row.usageTotal')}
                        <span className="dsm-qoder-model-id">{model.key}</span>
                        {typeof model.creditMultiplier === 'number' ? <span className="dsm-qoder-model-name-rate">{t('row.modelRate', { rate: String(model.creditMultiplier) })}</span> : null}
                      </span>
                    </span>
                  </label>
                  {model.supportsImages !== undefined ? (
                    <label className="dsm-qoder-model-image" title={imageCheckboxHint(model.key, t)}>
                      <input
                        type="checkbox"
                        checked={draft.supportsImages.has(model.key)}
                        onChange={(e) => toggleImageLight(model.key, e.target.checked)}
                      />
                      {t('row.modelImage')}
                    </label>
                  ) : null}
                  {model.canDisableThinking === true ? (
                    <label className="dsm-qoder-model-off" title={t('row.modelOff')}>
                      <input
                        type="checkbox"
                        disabled={!model.supportsThinking}
                        checked={draft.offModelKeys.has(model.key)}
                        onChange={(e) => toggleOff(model.key, e.target.checked)}
                      />
                      {t('row.modelOff')}
                    </label>
                  ) : null}
                </div>

                <div className="dsm-qoder-model-details">
                  <div className="dsm-qoder-model-meta">
                    <span>{t('row.modelContext', { context: formatCapacity(model.contextWindow) })}</span>
                    <span>{t('row.modelOutput', { output: formatCapacity(model.maxTokens) })}</span>
                    {model.supportsThinking === true ? <span className="dsm-qoder-model-meta-tag">{t('row.modelReasoning', { efforts: '' }).replace(': ', '')}</span> : null}
                    {model.isFree === true ? <span className="dsm-qoder-model-meta-tag">{t('row.usageTotal')}</span> : null}
                  </div>
                  {renderContextPicker(model)}
                </div>

                {/* Probe */}
                <div className="dsm-qoder-model-details">
                  <div className="dsm-qoder-model-meta" style={{ color: 'var(--dsw-alias-label-tertiary,#999)' }}>
                    {probeBusy.has(model.key)
                      ? t('row.probing')
                      : probes[model.key] === undefined
                        ? t('row.probeHint')
                        : (() => {
                            const p = probes[model.key] as QoderWebProbeResult
                            const label = probeOutcomeLabel(t, p.outcome)
                            const reason = inlineProbeReason(p.outcome, p.message)
                            return (
                              <span>
                                <span className={`dsm-qoder-model-probe-result dsm-qoder-model-probe-result-${probeResultTone(p.outcome)}`}>{label}</span>
                                {reason === undefined ? null : <span className="dsm-qoder-hint" style={{ marginLeft: 6 }} title={p.message}>{reason}</span>}
                              </span>
                            )
                          })()}
                  </div>
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline dsm-qoder-model-probe"
                    disabled={probeBusy.has(model.key) || signIn === undefined}
                    onClick={() => { void runProbe(model.key) }}
                  >
                    {probeBusy.has(model.key) ? t('row.probing') : t('row.probe')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="dsm-qoder-model-actions">
          <div className="dsm-qoder-model-save-error">{saveError ?? ''}</div>
          <div className="dsm-qoder-model-actions-buttons">
            {dirty ? (
              <button type="button" className="dsm-btn dsm-btn-outline" disabled={!canWrite(scope) || saving} onClick={discardModels}>{t('row.discard')}</button>
            ) : null}
            <button type="button" className="dsm-btn dsm-btn-primary" disabled={!canWrite(scope) || saving || !dirty} onClick={() => { void saveModels() }}>
              {saving ? t('row.saving') : t('row.save')}
            </button>
          </div>
        </div>
      </section>
    )
  }

  function renderContextPicker(model: QoderWebModel): ReactElement {
    const tiers = model.contextTiers ?? []
    if (tiers.length === 0) return <span />
    const current = draft.contextBudgets[model.key] ?? model.contextWindow
    return (
      <div className="dsm-qoder-context-budget" title={t('row.contextBudget')}>
        <label>
          {t('row.contextBudget')}{' '}
          <select
            className="dsm-qoder-pool-num"
            disabled={!canWrite(scope) || siblingBusy}
            value={String(current)}
            onChange={(e) => setContextBudget(model.key, Number(e.target.value))}
          >
            <option value={String(model.contextWindow)}>{formatCapacity(model.contextWindow)}</option>
            {tiers.map(tier => <option key={String(tier)} value={String(tier)}>{formatCapacity(tier)}</option>)}
          </select>
        </label>
      </div>
    )
  }

  function renderPool(): ReactElement {
    if (signIn?.pool === undefined) return <span />
    return (
      <AccountPool
        t={t}
        region={activeRegion}
        pool={signIn.pool}
        settingsScope={scope}
        siblingBusy={siblingBusy}
        canWrite={canWrite(scope)}
        onChanged={() => refresh(activeRegion, true)}
      />
    )
  }
}

// ------------------------------- local helpers -------------------------------

/** Whether the injected scope permits edits. */
function canWrite(scope: QoderAccountScope | undefined): boolean {
  return scope !== undefined
}

/** Build the region slot for a write (merge into the current slot). */
function slotWith(scope: QoderAccountScope, region: QoderWebRegion, patch: Record<string, unknown>): Record<string, unknown> {
  const root = scope.getSnapshot().value
  const regions = typeof root === 'object' && root !== null && !Array.isArray(root)
    ? (root as Record<string, unknown>)['regions']
    : undefined
  const map = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  const prior = typeof map[region] === 'object' && map[region] !== null && !Array.isArray(map[region])
    ? map[region] as Record<string, unknown>
    : {}
  return { ...prior, ...patch }
}

/** Whether a usage doc's region is switched on (opt-out). */
function regionEnabledOfUsage(usage: QoderWebUsage | undefined): boolean {
  if (usage === undefined) return true
  if (usage.status === 'signed-out') return usage.enabled !== false
  if (usage.status === 'signed-in') return usage.enabled !== false
  return true
}

function regionOnOf(usage: QoderWebUsage | undefined): boolean {
  return regionEnabledOfUsage(usage)
}

/** Whether a usage doc is signed-in / error enough to carry a status dot. */
function hasStatusDot(usage: QoderWebUsage | undefined): boolean {
  return usage !== undefined
}

function creditsShownOf(usage: QoderWebUsage | undefined): boolean {
  if (usage === undefined) return true
  if (usage.status === 'signed-out') return usage.showCreditsInMainUi !== false
  if (usage.status === 'signed-in') return usage.showCreditsInMainUi !== false
  return true
}

function cloneDraft(draft: QoderDraft): QoderDraft {
  return {
    enabledModelKeys: new Set(draft.enabledModelKeys),
    offModelKeys: new Set(draft.offModelKeys),
    supportsImages: new Set(draft.supportsImages),
    contextBudgets: { ...draft.contextBudgets },
  }
}

/** Build the `lastCatalog` array + enabled/off/image selections for the save. */
function buildModelsPayload(draft: QoderDraft, models: readonly QoderWebModel[]): { lastCatalog: readonly { key: string }[] } & Record<string, unknown> {
  const lastCatalog = models.map(model => ({
    key: model.key,
    displayName: model.name,
    priceFactor: typeof model.creditMultiplier === 'number' ? model.creditMultiplier : 1,
    contextWindow: model.contextWindow,
    nativeContextWindow: model.nativeContextWindow,
    maxTokens: model.maxTokens,
    supportsImages: draft.supportsImages.has(model.key),
    supportsThinking: model.supportsThinking === true,
    canDisableThinking: model.canDisableThinking === true,
    isDefault: model.isDefault === true,
    isFree: model.isFree === true,
    isNew: model.isNew === true,
    contextTiers: model.contextTiers,
  }))
  return {
    lastCatalog,
    enabledModelKeys: [...draft.enabledModelKeys],
    offModelKeys: [...draft.offModelKeys],
    contextBudgets: draft.contextBudgets,
  }
}

function isContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:EPERM|EBUSY|EACCES)\b/u.test(message)
}

function formatCapacity(value: number | undefined, unknown = '—'): string {
  if (value === undefined) return unknown
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return formatNumber(value)
}
