/**
 * Qoder 设置卡片：PAT 配置 / 区域开关 / 模型目录勾选与探针 / 额度展示。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体外观语言（折叠外壳 `<li class="dsm-plugin-card">` +
 *     header/icon/title/description/chevron、tab 栏内嵌区域开关、
 *     分节行节奏、模型列表与探针结果行、模块加载时注入一次 `<style>`、
 *     纯 CSS caret、60 秒轮询与清理），以及 `dsm-*` 类名体系与
 *     `--dsw-alias-*` 主题变量用法，均沿用自该项目；其又逐字承接
 *     dingminhua/dsh-connect-trae（MIT）与
 *     dingminhua/dsh-subagent-default-model（MIT）。
 *     沿用的目的：同族插件在同一张卡片列表里必须看起来是一套东西。
 * 改动：
 *   1. 功能区换成 Qoder 的字段——PAT 输入、额度进度条、模型倍率/上限/
 *      推理与图像标记；
 *   2. 区域开关从独立小节移到 tab 内（与 workbuddy 一致），
 *      并保留「停用即撤下该区域模型」的原语义；
 *   3. 勾选仍按原设计**立即写入**（无草稿态，故没有 Save/Discard 行），
 *      因此不引入 workbuddy 的 dirty 标记。
 *
 * 数据流：
 * - 配置值（PAT、开关、勾选）经 `settingsScope`（宿主 settings 镜像）
 *   读写；每次 `set()` 是原子命名空间写入，宿主侧 `loader/volatile-update`
 *   事件会让 provider 立即收敛。
 * - 状态（上游可达性、额度、探针）经本插件只读路由
 *   `/plugins/dsh-connect-qoder/{status,usage,probe,models/refresh}` 获取。
 *
 * @module dsh-connect-qoder/client
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { QoderSettingsKey } from './locales.ts'
import { QODER_STATUS_PATH, QODER_USAGE_PATH, QODER_PROBE_PATH, QODER_MODELS_REFRESH_PATH, QODER_GITHUB_URL, QODER_REGION_KEYS } from '../status-paths.ts'
import type { QoderStatusRegion } from '../status-paths.ts'
import { QODER_PAT_ENV_VARS } from '../credentials.ts'
import type { QoderRegion } from '../upstream.ts'
import { QODER_PLUGIN_ICON } from './icon.ts'
import { QODER_CARD_CSS } from './styles.ts'

export type QoderT = (key: QoderSettingsKey, vars?: Record<string, string>) => string

export interface QoderCardInjected {
  t: QoderT
  settingsScope?: {
    getSnapshot(): { value: Record<string, unknown> }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<boolean>
    unset(field: string): Promise<boolean>
  }
}

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

interface RegionConfig {
  pat?: string | undefined
  enabled?: boolean
  lastCatalog?: unknown[] | undefined
  enabledModelKeys?: string[]
}

function regionConfigOf(value: Record<string, unknown>, region: string): RegionConfig {
  const regions = value.regions
  if (regions === null || typeof regions !== 'object') return {}
  const stored = (regions as Record<string, unknown>)[region]
  if (stored === null || typeof stored !== 'object') return {}
  const r = stored as Record<string, unknown>
  return {
    pat: typeof r.pat === 'string' ? r.pat : undefined,
    enabled: r.enabled !== false,
    lastCatalog: Array.isArray(r.lastCatalog) ? r.lastCatalog : undefined,
    enabledModelKeys: Array.isArray(r.enabledModelKeys) ? r.enabledModelKeys as string[] : [],
  }
}

function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'get' in (value as object) && typeof (value as { get(): unknown }).get === 'function') {
    return (value as { get(): unknown }).get()
  }
  return value
}

interface ProbeRow {
  kind: string
  message: string
  latencyMs: number
  ok: boolean
}

const PROBE_KIND_KEYS: Record<string, QoderSettingsKey> = {
  'rate-limited': 'probeRateLimited',
  auth: 'probeAuth',
  'content-policy': 'probeContentPolicy',
  'quota-exhausted': 'probeQuotaExhausted',
  transient: 'probeTransient',
  error: 'probeFail',
}

/** Tab dot: one glance says whether this region is usable at all. */
function dotStyle(region: QoderStatusRegion | undefined): CSSProperties {
  if (region === undefined) return { background: 'var(--dsw-alias-label-dimmed,#777)' }
  if (!region.hasCredential) return { background: 'var(--dsw-alias-state-error-primary,#ef4444)' }
  if (!region.upstreamReachable) return { background: 'var(--dsw-alias-state-warn-primary,#f59e0b)' }
  return { background: 'var(--dsw-alias-state-success-primary,#22a06b)' }
}

/** `200000` → `200K`; a missing/zero window reads as the localized "unknown". */
function formatCapacity(value: number, unknown: string): string {
  if (!Number.isFinite(value) || value <= 0) return unknown
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

/** Ok / warn / bad tone for a probe answer, matching the family's colour use. */
function probeTone(probe: ProbeRow): string {
  if (probe.ok) return 'ok'
  if (probe.kind === 'rate-limited' || probe.kind === 'quota-exhausted' || probe.kind === 'transient') return 'warn'
  return 'bad'
}

/** Fill tone for a quota bar: empty-ish is fine, nearly-gone is not. */
function quotaTone(percent: number): string {
  if (percent >= 90) return ' bad'
  if (percent >= 75) return ' warn'
  return ''
}

function UsageBar({ label, used, total, percent, suffix }: {
  label: string
  used: number
  total: number
  percent: number
  suffix?: string | undefined
}): JSX.Element {
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const tone = quotaTone(safePercent)
  return (
    <div className="dsm-qoder-usage-row">
      <span className="dsm-qoder-usage-label">{label}</span>
      <div className="dsm-qoder-usage-track">
        <div
          className={`dsm-qoder-usage-fill${tone === '' ? '' : ` dsm-qoder-usage-fill-${tone.trim()}`}`}
          style={{ width: `${safePercent}%` }}
        />
      </div>
      <span className="dsm-qoder-usage-num">
        {used.toLocaleString()} / {total.toLocaleString()}（{safePercent.toFixed(1)}%）{suffix === undefined ? '' : ` ${suffix}`}
      </span>
    </div>
  )
}

export function QoderCard({ t, settingsScope, view }: QoderCardInjected & { view?: string }): JSX.Element | null {
  if (t === undefined) throw new Error('Qoder plugin card requires its translation function')
  const [open, setOpen] = useState(view === 'page')
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>(() => unwrap(settingsScope?.getSnapshot().value) as Record<string, unknown>)
  const [status, setStatus] = useState<Record<string, QoderStatusRegion> | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshState, setRefreshState] = useState<string>('idle')
  const [probes, setProbes] = useState<Record<string, ProbeRow>>({})
  const [patDrafts, setPatDrafts] = useState<Record<string, string>>({})
  const [patNote, setPatNote] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  const regions = (QODER_REGION_KEYS as readonly string[]).slice()
  const [activeRegion, setActiveRegion] = useState<string>(regions[0] ?? 'cn')

  const loadStatus = async (): Promise<void> => {
    try {
      const resp = await fetch(QODER_STATUS_PATH)
      if (resp.ok) {
        const data = (await resp.json()) as { regions?: Record<string, QoderStatusRegion> }
        if (mounted.current && data.regions) setStatus(data.regions)
      }
    } catch {
      // 路由不可用时卡片保持静态
    }
  }

  useEffect(() => {
    mounted.current = true
    const dispose = settingsScope?.subscribe(() => {
      if (mounted.current) {
        setSnapshot(unwrap(settingsScope.getSnapshot().value) as Record<string, unknown>)
      }
    })
    return () => {
      mounted.current = false
      dispose?.()
    }
  }, [settingsScope])

  useEffect(() => {
    if (settingsScope === undefined) return
    setSnapshot(unwrap(settingsScope.getSnapshot().value) as Record<string, unknown>)
  }, [settingsScope])

  useEffect(() => {
    void loadStatus()
    const timer = setInterval(() => void loadStatus(), 60_000)
    return () => clearInterval(timer)
  }, [])

  const config = useMemo(() => regionConfigOf(snapshot, activeRegion), [snapshot, activeRegion])
  const regionStatus = status?.[activeRegion]
  const activeRegionOn = config.enabled !== false

  const savePat = async (value: string): Promise<void> => {
    if (settingsScope === undefined) return
    setBusy(true)
    setPatNote(undefined)
    try {
      const trimmed = value.trim()
      if (trimmed === '') {
        await settingsScope.unset(`regions.${activeRegion}.pat`)
        setPatNote(t('patCleared'))
      } else {
        await settingsScope.set(`regions.${activeRegion}.pat`, trimmed)
        setPatNote(t('patSaved'))
      }
      setPatDrafts(prev => ({ ...prev, [activeRegion]: '' }))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setPatNote(t('patFailed', { message }))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const toggleRegion = async (enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    await settingsScope.set(`regions.${activeRegion}.enabled`, enabled)
  }

  const toggleModel = async (key: string, on: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    const keys = new Set(config.enabledModelKeys ?? [])
    if (on) keys.add(key)
    else keys.delete(key)
    await settingsScope.set(`regions.${activeRegion}.enabledModelKeys`, [...keys])
  }

  const refreshModels = async (): Promise<void> => {
    if (refreshState === 'running') return
    setRefreshState('running')
    try {
      const resp = await fetch(`${QODER_MODELS_REFRESH_PATH}?region=${activeRegion}`)
      setRefreshState(resp.ok ? 'done' : 'failed')
    } catch {
      setRefreshState('failed')
    }
    await loadStatus()
    if (mounted.current) setRefreshState('idle')
  }

  const runProbe = async (modelKey: string): Promise<void> => {
    setProbes(prev => ({ ...prev, [modelKey]: { kind: 'running', message: '', latencyMs: 0, ok: false } }))
    try {
      const resp = await fetch(`${QODER_PROBE_PATH}?region=${activeRegion}&model=${encodeURIComponent(modelKey)}`)
      const data = (await resp.json()) as { ok: boolean; kind: string; message: string; latencyMs: number }
      setProbes(prev => ({ ...prev, [modelKey]: { kind: data.kind, message: data.message, latencyMs: data.latencyMs, ok: data.ok } }))
    } catch {
      setProbes(prev => ({ ...prev, [modelKey]: { kind: 'error', message: 'network error', latencyMs: 0, ok: false } }))
    }
  }

  const models = regionStatus?.models ?? []
  const usage = regionStatus?.usage
  const enabledKeys = new Set(config.enabledModelKeys ?? [])
  const enabledCount = models.filter(model => enabledKeys.has(model.key)).length
  const title = t('pluginName')

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <img className="dsm-plugin-card-icon" src={QODER_PLUGIN_ICON} alt="" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{title}</span>
          <span className="dsm-plugin-card-description">{t('cardDesc')}</span>
        </span>
        <span aria-hidden="true" className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`} />
      </button>
      <div className="dsm-plugin-card-body" hidden={!open} data-view={view}>
        {open
          ? <div className="dsm-qoder-body">
              {/* 区域 tab：一个 tab 就是一个独立 provider */}
              <div className="dsm-qoder-tabs" role="tablist" aria-label={title}>
                {regions.map(region => {
                  const tabStatus = status?.[region]
                  const tabOn = regionConfigOf(snapshot, region).enabled !== false
                  return (
                    <div key={region} className="dsm-qoder-tab-cell">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={region === activeRegion}
                        className={`dsm-qoder-tab${region === activeRegion ? ' dsm-qoder-tab-active' : ''}${tabOn ? '' : ' dsm-qoder-tab-off'}`}
                        onClick={() => { setActiveRegion(region); setPatNote(undefined) }}
                      >
                        {tabStatus === undefined
                          ? null
                          : <span aria-hidden="true" className="dsm-qoder-tab-dot" style={dotStyle(tabStatus)} />}
                        {t(region === 'cn' ? 'regionCn' : 'regionGlobal')}
                      </button>
                      <label className="dsm-qoder-tab-switch" title={t('tabSwitchHint')}>
                        <input
                          type="checkbox"
                          checked={tabOn}
                          disabled={settingsScope === undefined}
                          aria-label={t('tabSwitchAria', { region: t(region === 'cn' ? 'regionCn' : 'regionGlobal') })}
                          onChange={(event) => { void toggleRegion(event.target.checked) }}
                        />
                      </label>
                    </div>
                  )
                })}
              </div>
              <p className="dsm-qoder-models-summary">{t('tabHint')}</p>
              {!activeRegionOn
                ? <p className="dsm-qoder-tab-off-notice">{t('tabOffNotice')}</p>
                : null}

              {/* 状态行：凭据 / 上游 / 目录规模 */}
              <div className="dsm-qoder-bar">
                <p className="dsm-qoder-bar-label">{t('statusTitle')}</p>
                <p className="dsm-qoder-bar-status">
                  <span className={regionStatus?.hasCredential === true ? 'dsm-qoder-bar-ok' : 'dsm-qoder-bar-error'}>
                    {regionStatus?.hasCredential === true ? t('credentialOk') : t('credentialMissing')}
                  </span>
                  {' · '}
                  <span className={regionStatus?.upstreamReachable === true ? 'dsm-qoder-bar-ok' : 'dsm-qoder-hint'}>
                    {regionStatus?.upstreamReachable === true ? t('upstreamOk') : t('upstreamMissing')}
                  </span>
                  {regionStatus === undefined ? null : ` · ${t('modelCount', { count: String(regionStatus.modelCount) })}`}
                </p>
                <div className="dsm-qoder-bar-actions">
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline dsm-qoder-model-probe"
                    onClick={() => { void loadStatus() }}
                  >
                    {t('refreshUsage')}
                  </button>
                </div>
              </div>

              {/* PAT 配置（设置行节奏） */}
              <section className="dsm-qoder-section" aria-label={t('patLabel')}>
                <div className="dsm-qoder-set">
                  <div className="dsm-qoder-set-copy">
                    <b>{t('patLabel')}</b>
                    <span>{t('patHint')}</span>
                  </div>
                </div>
                <div className="dsm-qoder-set">
                  <div className="dsm-qoder-pat-row">
                    <input
                      className="dsm-qoder-input"
                      type="password"
                      spellCheck={false}
                      autoComplete="off"
                      value={patDrafts[activeRegion] ?? config.pat ?? ''}
                      placeholder={t('patPlaceholder')}
                      disabled={settingsScope === undefined}
                      onChange={event => setPatDrafts(prev => ({ ...prev, [activeRegion]: event.target.value }))}
                    />
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-primary"
                      disabled={busy || settingsScope === undefined}
                      onClick={() => void savePat(patDrafts[activeRegion] ?? config.pat ?? '')}
                    >
                      {busy ? t('saving') : t('save')}
                    </button>
                  </div>
                </div>
                <div className="dsm-qoder-set">
                  <div className="dsm-qoder-set-copy">
                    <span>{t('envVarHint', { var: QODER_PAT_ENV_VARS[activeRegion as QoderRegion] ?? '' })}</span>
                    {patNote === undefined ? null : <span>{patNote}</span>}
                  </div>
                </div>
              </section>

              {/* 额度（只读） */}
              <section className="dsm-qoder-models" aria-label={t('usageTitle')}>
                <div className="dsm-qoder-models-head">
                  <div className="dsm-qoder-models-title-row">
                    <h3 className="dsm-qoder-models-title">{t('usageTitle')}</h3>
                  </div>
                  {usage?.expiresAt === null || usage?.expiresAt === undefined
                    ? null
                    : (
                        <p className="dsm-qoder-models-summary">
                          {t('usageExpiresAt')} {new Date(usage.expiresAt).toLocaleDateString()}
                        </p>
                      )}
                </div>
                {usage === null || usage === undefined
                  ? <p className="dsm-qoder-usage-note">{t('usageUnavailable')}</p>
                  : (
                      <div className="dsm-qoder-usage">
                        {usage.userQuota === null
                          ? null
                          : <UsageBar label={t('usageUserQuota')} used={usage.userQuota.used} total={usage.userQuota.total} percent={usage.userQuota.percentage} />}
                        {usage.addOnQuota === null
                          ? null
                          : <UsageBar label={t('usageAddOn')} used={usage.addOnQuota.used} total={usage.addOnQuota.total} percent={usage.addOnQuota.percentage} />}
                        {usage.orgResourcePackage === null
                          ? null
                          : <UsageBar label={t('usageOrg')} used={usage.orgResourcePackage.used} total={usage.orgResourcePackage.cap} percent={usage.orgResourcePackage.percentage} />}
                        {usage.userQuota === null && usage.addOnQuota === null && usage.orgResourcePackage === null
                          ? <p className="dsm-qoder-usage-note">{t('usageUnavailable')}</p>
                          : null}
                      </div>
                    )}
              </section>

              {/* 模型目录 */}
              <section className="dsm-qoder-models" aria-label={t('modelsTitle')}>
                <div className="dsm-qoder-models-head">
                  <div className="dsm-qoder-models-title-row">
                    <h3 className="dsm-qoder-models-title">{t('modelsTitle')}</h3>
                  </div>
                  <div className="dsm-qoder-models-head-actions">
                    {regionStatus?.upstreamReachable === false
                      ? <span className="dsm-qoder-hint" style={{ fontSize: 12 }}>{t('modelFallback')}</span>
                      : null}
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline dsm-qoder-model-probe"
                      disabled={refreshState === 'running'}
                      onClick={() => void refreshModels()}
                    >
                      {refreshState === 'running' ? t('modelsRefreshing') : t('modelsRefresh')}
                    </button>
                  </div>
                </div>
                {models.length === 0
                  ? <p className="dsm-qoder-usage-note">{t('noModels')}</p>
                  : (
                      <>
                        <p className="dsm-qoder-models-summary">
                          {t('modelsSummary', { enabled: String(enabledCount), total: String(models.length) })}
                        </p>
                        <div className="dsm-qoder-model-list">
                          {models.map(model => {
                            const enabled = enabledKeys.has(model.key)
                            const probe = probes[model.key]
                            const tags: Array<{ key: QoderSettingsKey; brand?: boolean }> = []
                            if (model.supportsThinking) tags.push({ key: 'reasoningTag' })
                            if (model.supportsImages) tags.push({ key: 'imageTag' })
                            if (model.isDefault) tags.push({ key: 'defaultTag', brand: true })
                            if (model.isFree) tags.push({ key: 'freeTag', brand: true })
                            return (
                              <div key={model.key} className={`dsm-qoder-model${enabled ? '' : ' dsm-qoder-model-disabled'}`}>
                                <div className="dsm-qoder-model-head">
                                  <label className="dsm-qoder-model-enabled">
                                    <input
                                      type="checkbox"
                                      checked={enabled}
                                      disabled={settingsScope === undefined}
                                      onChange={event => void toggleModel(model.key, event.target.checked)}
                                    />
                                    <span className="dsm-qoder-model-copy">
                                      <span className="dsm-qoder-model-name">
                                        {model.displayName}
                                        {!Number.isFinite(model.priceFactor) || model.priceFactor <= 0
                                          ? null
                                          : <span className="dsm-qoder-model-name-rate">· x{model.priceFactor.toFixed(2)}</span>}
                                      </span>
                                    </span>
                                  </label>
                                  <div className="dsm-qoder-model-actions-buttons">
                                    <button
                                      type="button"
                                      className="dsm-btn dsm-btn-outline dsm-qoder-model-probe"
                                      disabled={probe?.kind === 'running' || settingsScope === undefined}
                                      title={t('probeHint')}
                                      onClick={() => void runProbe(model.key)}
                                    >
                                      {probe?.kind === 'running' ? t('probing') : t('probeRun')}
                                    </button>
                                  </div>
                                </div>
                                <div className="dsm-qoder-model-details">
                                  <div className="dsm-qoder-model-meta">
                                    <span className="dsm-qoder-model-id">{model.key}</span>
                                    <span>{t('modelContext', { value: formatCapacity(model.contextWindow, t('modelUnknown')) })}</span>
                                    <span>{t('modelOutput', { value: formatCapacity(model.maxOutputTokens, t('modelUnknown')) })}</span>
                                    {tags.map(tag => (
                                      <span
                                        key={tag.key}
                                        className={`dsm-qoder-model-meta-tag${tag.brand === true ? ' dsm-qoder-model-meta-tag-brand' : ''}`}
                                      >
                                        {t(tag.key)}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                {probe === undefined || probe.kind === 'running'
                                  ? null
                                  : (
                                      <p className={`dsm-qoder-model-probe-result dsm-qoder-model-probe-result-${probeTone(probe)}`}>
                                        {probe.ok
                                          ? t('probeOk', { ms: String(probe.latencyMs) })
                                          : t(PROBE_KIND_KEYS[probe.kind] ?? 'probeFail', { message: probe.message })}
                                      </p>
                                    )}
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}
              </section>

              <footer className="dsm-qoder-foot">
                <a href={QODER_GITHUB_URL} target="_blank" rel="noreferrer">{t('gitHub')}</a>
                <span style={{ marginLeft: 'auto' }}>{t('docsHint')}</span>
              </footer>
            </div>
          : null}
      </div>
    </li>
  )
}
