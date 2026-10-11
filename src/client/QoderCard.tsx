/**
 * Qoder 设置卡片：PAT 配置 / 区域开关 / 模型目录勾选与探针 / 额度展示。
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
import type { QoderSettingsKey } from './locales.ts'
import { render } from './locales.ts'
import { QODER_STATUS_PATH, QODER_USAGE_PATH, QODER_PROBE_PATH, QODER_MODELS_REFRESH_PATH, QODER_GITHUB_URL, QODER_REGION_KEYS, type QoderStatusRegion } from '../status-paths.ts'
import { QODER_PAT_ENV_VARS } from '../credentials.ts'
import type { QoderRegion } from '../upstream.ts'

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

export function QoderCard({ t, settingsScope, view }: QoderCardInjected & { view?: string }): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>(() => unwrap(settingsScope?.getSnapshot().value) as Record<string, unknown>)
  const [status, setStatus] = useState<Record<string, QoderStatusRegion> | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshState, setRefreshState] = useState<string>('idle')
  const [probes, setProbes] = useState<Record<string, ProbeRow>>({})
  const [patDrafts, setPatDrafts] = useState<Record<string, string>>({})
  const mounted = useRef(true)

  const regions = (QODER_REGION_KEYS as readonly string[]).slice()
  const [activeRegion, setActiveRegion] = useState<string>(regions[0] ?? 'cn')

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
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const resp = await fetch(QODER_STATUS_PATH)
        if (resp.ok) {
          const data = (await resp.json()) as { regions?: Record<string, QoderStatusRegion> }
          if (alive && data.regions) setStatus(data.regions)
        }
      } catch {
        // 路由不可用时卡片保持静态
      }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [settingsScope])

  const config = useMemo(() => regionConfigOf(snapshot, activeRegion), [snapshot, activeRegion])
  const regionStatus = status?.[activeRegion]

  const savePat = async (value: string): Promise<void> => {
    if (settingsScope === undefined) return
    setBusy(true)
    try {
      const trimmed = value.trim()
      if (trimmed === '') {
        await settingsScope.unset(`regions.${activeRegion}.pat`)
      } else {
        await settingsScope.set(`regions.${activeRegion}.pat`, trimmed)
      }
      setPatDrafts(prev => ({ ...prev, [activeRegion]: '' }))
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
      if (resp.ok) {
        setRefreshState('done')
      } else {
        setRefreshState('failed')
      }
    } catch {
      setRefreshState('failed')
    }
    // 触发一次状态轮询以看到新目录
    const resp = await fetch(QODER_STATUS_PATH)
    if (resp.ok) {
      const data = (await resp.json()) as { regions?: Record<string, QoderStatusRegion> }
      setStatus(data.regions ?? null)
    }
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
  const usagePercent = usage?.userQuota?.percentage ?? usage?.addOnQuota?.percentage ?? 0

  return (
    <div data-view={view} style={{ padding: '0 4px', fontSize: 13, lineHeight: 1.5 }}>
      {/* 区域 tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {regions.map(region => (
          <button
            key={region}
            type="button"
            onClick={() => setActiveRegion(region)}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: activeRegion === region ? '1px solid var(--dsh-color-accent, #4f8cff)' : '1px solid var(--dsh-color-border, #444)',
              background: activeRegion === region ? 'var(--dsh-color-accent-weak, #2b2f4a)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t(region === 'cn' ? 'regionCn' : 'regionGlobal')}
          </button>
        ))}
      </div>

      {/* 状态行 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, opacity: 0.85 }}>
        <span>{regionStatus?.hasCredential ? t('credentialOk') : t('credentialMissing')}</span>
        <span>·</span>
        <span>{regionStatus?.upstreamReachable ? t('upstreamOk') : t('upstreamMissing')}</span>
        {regionStatus?.modelCount !== undefined && (
          <span>· {regionStatus.modelCount} models</span>
        )}
      </div>

      {/* PAT 配置 */}
      <section style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>{t('patLabel')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="password"
            value={patDrafts[activeRegion] ?? config.pat ?? ''}
            placeholder={t('patPlaceholder')}
            onChange={event => setPatDrafts(prev => ({ ...prev, [activeRegion]: event.target.value }))}
            style={{ flex: 1, minWidth: 260, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--dsh-color-border, #444)', background: 'transparent', color: 'inherit' }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void savePat(patDrafts[activeRegion] ?? config.pat ?? '')}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--dsh-color-border, #444)', background: 'transparent', cursor: 'pointer' }}
          >
            {busy ? t('saving') : t('save')}
          </button>
        </div>
        <div style={{ marginTop: 4, opacity: 0.75 }}>
          {t('envVarHint', { var: QODER_PAT_ENV_VARS[activeRegion as QoderRegion] ?? '' })}
        </div>
      </section>

      {/* 区域开关 */}
      <section style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={config.enabled !== false} onChange={event => void toggleRegion(event.target.checked)} />
          {t('regionEnabled')}
        </label>
        <div style={{ opacity: 0.75, marginTop: 2 }}>{t('regionDisabledHint')}</div>
      </section>

      {/* 额度 */}
      <section style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('usageTitle')}</div>
        {usage === null || usage === undefined ? (
          <div style={{ opacity: 0.75 }}>{t('usageUnavailable')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {usage.userQuota !== null && (
              <UsageBar label={t('usageUserQuota')} used={usage.userQuota.used} total={usage.userQuota.total} percent={usage.userQuota.percentage} />
            )}
            {usage.addOnQuota !== null && (
              <UsageBar label={t('usageAddOn')} used={usage.addOnQuota.used} total={usage.addOnQuota.total} percent={usage.addOnQuota.percentage} />
            )}
            {usage.orgResourcePackage !== null && (
              <UsageBar label={t('usageOrg')} used={usage.orgResourcePackage.used} total={usage.orgResourcePackage.cap} percent={usage.orgResourcePackage.percentage} />
            )}
          </div>
        )}
      </section>

      {/* 模型目录 */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontWeight: 600 }}>{t('modelsTitle')}</span>
          <button
            type="button"
            disabled={refreshState === 'running'}
            onClick={() => void refreshModels()}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsh-color-border, #444)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
          >
            {refreshState === 'running' ? t('modelsRefreshing') : t('modelsRefresh')}
          </button>
          {regionStatus?.upstreamReachable === false && (
            <span style={{ opacity: 0.75, fontSize: 12 }}>{t('modelFallback')}</span>
          )}
        </div>
        {models.length === 0 ? (
          <div style={{ opacity: 0.75 }}>{t('noModels')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {models.map(model => {
              const enabled = (config.enabledModelKeys ?? []).includes(model.key)
              const probe = probes[model.key]
              const tags: string[] = []
              if (model.supportsThinking) tags.push(t('reasoningTag'))
              if (model.supportsImages) tags.push(t('imageTag'))
              if (model.isDefault) tags.push(t('defaultTag'))
              if (model.isFree) tags.push(t('freeTag'))
              return (
                <div key={model.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsh-color-border, #333)', flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={event => void toggleModel(model.key, event.target.checked)}
                  />
                  <span style={{ fontWeight: 500 }}>{model.displayName}</span>
                  {tags.length > 0 && (
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {tags.map(tag => (
                        <span key={tag} style={{ fontSize: 11, opacity: 0.75, border: '1px solid var(--dsh-color-border, #444)', borderRadius: 4, padding: '0 5px' }}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={probe?.kind === 'running'}
                    onClick={() => void runProbe(model.key)}
                    style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--dsh-color-border, #444)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
                  >
                    {t('probeRun')}
                  </button>
                  {probe !== undefined && probe.kind !== 'running' && (
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      {probe.ok ? t('probeOk', { ms: String(probe.latencyMs) }) : t(PROBE_KIND_KEYS[probe.kind] ?? 'probeFail', { message: probe.message })}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <footer style={{ marginTop: 16, display: 'flex', gap: 10, opacity: 0.7, fontSize: 12 }}>
        <a href={QODER_GITHUB_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{t('gitHub')}</a>
        <span>{t('docsHint')}</span>
      </footer>
    </div>
  )
}

function UsageBar({ label, used, total, percent }: { label: string; used: number; total: number; percent: number }): JSX.Element {
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ minWidth: 64 }}>{label}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--dsh-color-border, #333)', overflow: 'hidden' }}>
        <div style={{ width: `${safePercent}%`, height: '100%', background: safePercent >= 90 ? '#d33' : 'var(--dsh-color-accent, #4f8cff)' }} />
      </div>
      <span style={{ fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap' }}>
        {used.toLocaleString()} / {total.toLocaleString()}（{safePercent.toFixed(1)}%）
      </span>
    </div>
  )
}