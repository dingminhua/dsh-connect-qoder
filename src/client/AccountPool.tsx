/**
 * The account pool's card section.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `AccountPool.tsx`：草稿态 + dirty 标记 + 「保存/放弃」、`writeField` 验证
 *     写入、批量测试进度、活动日志的计时/配色、池表格的分列与配色，全部沿用。
 * 改动（按 Qoder 现实）：
 *   1. 没有每日签到：`checkinSupported` 恒 false，签到按钮与那一列整体不渲染；
 *   2. 批量测试走 `POST /pool?action=test`，Host 一次性返回 JSON
 *      `{action, modelId, rows}`（Qoder 上游不支持逐 account 流式），不再逐行
 *      流式进度；
 *   3. 账号来自 PAT（settings / env / vault）；「删除」仅移除池成员，不影响
 *      vault 条目（真正的 vault 删除在卡片的账号列表里）。
 *
 * Add-PAT 与导出/导入由卡片以单独小节渲染（`AddAccount` / `AccountTransfer`），
 * 本模块只负责池本身：批量动作、成员勾选、偏好设置、活动日志。
 *
 * @module dsh-connect-qoder/client/AccountPool
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import {
  QODER_POOL_ACCOUNT_PARAM,
  QODER_POOL_PATH,
  withQoderRegionAndAction,
  withQoderRouteAction,
} from '../status-paths.ts'
import type {
  QoderWebPool,
  QoderWebPoolTestRow,
  QoderWebProbeOutcome,
  QoderWebProbeResult,
  QoderWebRegion,
} from '../status-paths.ts'
import { exclusionText } from './exclusion-text.ts'
import { BusyOverlay } from './BusyOverlay.tsx'
import type { Translate } from './locales.ts'
import { inlineProbeReason } from './probe-reason.ts'
import { probeAgeText, probeSourceText } from './probe-age.ts'
import { PROBE_INPUT_TOKEN_CHOICES } from '../probe.ts'
import { remainingText } from './remaining.ts'
import {
  draftBaseFor,
  effectiveMemberIds,
  ghostMemberIds,
  poolFailureText,
} from './pool-state.ts'
import { isFileContentionWriteError, writePoolPreferences } from './account-selection.ts'
import type { QoderAccountScope } from './account-selection.ts'

/** One line in the pool's activity log. */
interface PoolLogEntry {
  atMs: number
  text: string
  tone: 'ok' | 'warn' | 'error' | 'info'
}

/** The preferences the card edits as a draft. */
export interface PoolPreferences {
  enabled: boolean
  targetModelId: string
  /** Tokens each test probe sends; `0` means the host's measured default. */
  probeInputTokens: number
  /** The account ids checked into this pool. */
  memberAccountIds: readonly string[]
}

export interface AccountPoolProps {
  t: Translate
  region: QoderWebRegion
  /** The Host's pool state; absent when the Host has no pool support. */
  pool?: QoderWebPool
  settingsScope?: QoderAccountScope | undefined
  /** Whether the SAME card's other save (the model list) is in flight. */
  siblingBusy?: boolean | undefined
  /** Whether this region may be edited (not while the provider is off). */
  canWrite: boolean
  /** Force the card to re-read its usage snapshot after a Host-side action. */
  onChanged?: (() => void | Promise<unknown>) | undefined
}

function formatClock(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * The subset of a probe result the pool table renders (the pool account's own
 * `probe` omits `modelId`, so accept a structural union that covers both).
 */
interface PoolProbeLike {
  outcome: QoderWebProbeOutcome
  retryAtMs?: number | undefined
  elapsedMs?: number | undefined
  status?: number | undefined
  atMs?: number | undefined
  source?: string | undefined
  message?: string | undefined
}

/** The probe result label for one pool row. */
function probeLabelOf(t: Translate, result: PoolProbeLike | undefined, nowMs: number): string {
  if (result === undefined) return t('row.poolNeverTested')
  if (result.retryAtMs !== undefined && (result.outcome === 'rate-limited' || result.outcome === 'out-of-credit')) {
    const base = result.outcome === 'rate-limited'
      ? t('row.probeRateLimitedAt', { at: formatClock(result.retryAtMs) })
      : t('row.probeOutOfCreditAt', { at: formatClock(result.retryAtMs) })
    const rel = remainingText(t, result.retryAtMs, nowMs)
    return rel === '' ? base : `${base} ${rel}`.trim()
  }
  switch (result.outcome) {
    case 'ok': return result.elapsedMs === undefined
      ? t('row.probeOk')
      : t('row.probeOkMs', { ms: String(result.elapsedMs) })
    case 'rate-limited': return t('row.probeRateLimitedUnknown')
    case 'out-of-credit': return t('row.probeOutOfCreditUnknown')
    case 'credential-rejected': return t('row.probeCredentialRejected')
    case 'policy-rejected': return t('row.probePolicyRejected')
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return result.status === undefined
      ? t('row.probeFailed')
      : t('row.probeFailedStatus', { status: String(result.status) })
  }
}

export function AccountPool(props: AccountPoolProps): ReactNode {
  const { t, region, pool, settingsScope, siblingBusy, canWrite, onChanged } = props
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [batchBusy, setBatchBusy] = useState(false)
  const [removingId, setRemovingId] = useState<string | undefined>(undefined)
  const [log, setLog] = useState<readonly PoolLogEntry[]>([])
  const [draftRegion, setDraftRegion] = useState<string | undefined>(undefined)
  const [draftPool, setDraftPool] = useState<PoolPreferences | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    setNowMs(Date.now())
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 20_000)
    return () => window.clearInterval(timer)
  }, [])

  const saved: PoolPreferences = {
    enabled: pool?.enabled ?? false,
    targetModelId: pool?.targetModelId ?? '',
    probeInputTokens: pool?.probeInputTokens ?? 0,
    memberAccountIds: pool?.memberAccountIds ?? [],
  }
  const active: PoolPreferences = draftPool !== null && draftRegion === region
    ? draftPool
    : saved

  const listed = new Set(pool?.accounts.map(a => a.accountId) ?? [])
  const effective = pool?.effectiveMemberAccountIds?.slice() ??
    effectiveMemberIds({
      savedEffective: pool?.effectiveMemberAccountIds ?? [],
      draftMembers: active.memberAccountIds,
      listedIds: listed,
      dirty,
    })
  const ghost = ghostMemberIds(active.memberAccountIds, listed)
  const canEditPool = settingsScope !== undefined && canWrite && !siblingBusy

  const editDraft = useCallback((update: (prev: PoolPreferences) => PoolPreferences) => {
    setDraftPool(update(draftBaseFor<PoolPreferences>(draftPool, draftRegion, region, saved)))
    setDraftRegion(region)
    setDirty(true)
    setSaveError(undefined)
  }, [draftPool, draftRegion, region, saved])

  const toggleMember = (accountId: string, next: boolean) => {
    editDraft(prev => ({
      ...prev,
      memberAccountIds: next
        ? [...prev.memberAccountIds, accountId]
        : prev.memberAccountIds.filter(id => id !== accountId),
    }))
  }
  const selectAll = (on: boolean) => {
    editDraft(prev => ({ ...prev, memberAccountIds: on ? pool?.accounts.map(a => a.accountId) ?? [] : [] }))
  }

  const savePool = async (): Promise<void> => {
    if (settingsScope === undefined) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await writePoolPreferences(settingsScope, region, active)
      setDraftPool(active)
      setDirty(false)
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      setSaveError(isFileContentionWriteError(error)
        ? `${t('row.poolSaveFailed', { message: String((error as Error)?.message ?? error) })}${t('row.saveContentionHint')}`
        : t('row.poolSaveFailed', { message: String((error as Error)?.message ?? error) }))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const appendLog = useCallback((entry: PoolLogEntry) => {
    setLog(entries => [entry, ...entries])
  }, [])

  const runTestBatch = async (): Promise<void> => {
    setActionError(undefined)
    setBatchBusy(true)
    try {
      const response = await fetch(withQoderRouteAction(QODER_POOL_PATH, region, 'test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined
        const error = typeof raw['error'] === 'string' ? raw['error'] : undefined
        throw new Error(poolFailureText(t, { status: response.status, reason, error }))
      }
      if (raw['action'] === 'test' && Array.isArray(raw['rows'])) {
        const rows = (raw['rows'] as unknown[]).map(parseTestRow).filter(row => row !== undefined)
        const modelId = typeof raw['modelId'] === 'string' && raw['modelId'] !== '' ? raw['modelId'] : t('row.modelUnknown')
        appendLog({ atMs: Date.now(), text: t('row.poolLogTestStart', { count: rows.length, model: modelId }), tone: 'info' })
        if (rows.length === 0) {
          appendLog({ atMs: Date.now(), text: t('row.poolLogBatchFailed', { message: t('row.poolTargetNone') }), tone: 'warn' })
        } else {
          for (const row of rows) {
            appendLog({
              atMs: Date.now(),
              text: t('row.poolLogTestRow', { accountName: row.accountName, outcome: probeLabelOf(t, row.result, Date.now()) }),
              tone: row.result.outcome === 'ok' ? 'ok' : 'warn',
            })
          }
          appendLog({ atMs: Date.now(), text: t('row.poolLogTestDone'), tone: 'info' })
        }
      }
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      if (mounted.current) setActionError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setBatchBusy(false)
    }
  }

  const runRowRemove = async (accountId: string): Promise<void> => {
    setActionError(undefined)
    setRemovingId(accountId)
    try {
      const url = `${withQoderRegionAndAction(QODER_POOL_PATH, region, 'remove')}&${QODER_POOL_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined
        const error = typeof raw['error'] === 'string' ? raw['error'] : undefined
        throw new Error(poolFailureText(t, { status: response.status, reason, error }))
      }
      const accountName = pool?.accounts.find(a => a.accountId === accountId)?.accountName ?? t('row.accountUnnamed')
      appendLog({ atMs: Date.now(), text: t('row.poolRowRemoved', { accountName }), tone: 'ok' })
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      if (mounted.current) setActionError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setRemovingId(undefined)
    }
  }

  const targetMisses = pool?.targetModelSource === 'none' || pool?.targetModelSource === 'stale'

  return (
    <section className="dsm-qoder-pool">
      <BusyOverlay
        visible={batchBusy}
        message={t('row.poolTesting')}
        hint={t('row.poolBusyHint')}
      />

      <div className="dsm-qoder-pool-head">
        <h3 className="dsm-qoder-pool-title">{t('row.poolTitle')}</h3>
      </div>
      <p className="dsm-qoder-pool-note">{t('row.poolRegionNote')}</p>

      <div className="dsm-qoder-pool-actions">
        <div className="dsm-qoder-pool-actions-group">
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canEditPool || effective.length === 0 || batchBusy || targetMisses}
            onClick={() => { void runTestBatch() }}
          >
            {batchBusy ? t('row.poolTesting') : t('row.poolTestAll')}
          </button>
          <span className="dsm-qoder-pool-hint">
            {t('row.poolSelectedCount', { count: effective.length, total: pool?.accounts.length ?? 0 })}
          </span>
        </div>
      </div>

      {pool?.targetModelSource === 'none'
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolTargetNone')} ${t('row.poolTargetNoneHint')}`)
        : null}
      {pool?.targetModelSource === 'stale' ? (
        <div className="dsm-qoder-pool-conflict">
          <span className="dsm-qoder-pool-conflict-main">
            <b>{t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })}</b>
            <span>{t('row.poolTargetStaleHint')}</span>
          </span>
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canEditPool}
            onClick={() => { editDraft(current => ({ ...current, targetModelId: '' })) }}
          >
            {t('row.poolTargetStaleClear')}
          </button>
        </div>
      ) : null}

      {actionError === undefined ? null
        : h('p', { className: 'dsm-qoder-pool-error', role: 'alert' }, actionError)}

      {/* Pool table — no check-in column (checkinSupported is always false). */}
      <div className="dsm-qoder-pool-table">
        <div className="dsm-qoder-pool-row dsm-qoder-pool-row-head">
          <span>{t('row.poolColumnAccount')}</span>
          <span>{t('row.poolColumnCredits')}</span>
          <span>{t('row.poolColumnProbe')}</span>
          <span />
        </div>
        {(pool?.accounts ?? []).map(account => (
          <div
            key={account.accountId}
            className={`dsm-qoder-pool-row${account.current ? ' dsm-qoder-pool-row-current' : ''}`}
          >
            <span className="dsm-qoder-pool-account">
              <span className="dsm-qoder-pool-account-name">
                <b>{account.accountName === '' ? t('row.accountUnnamed') : account.accountName}</b>
                {exclusionText(t, account.excludedBy) === undefined ? null
                  : <span className="dsm-qoder-pool-excluded">{exclusionText(t, account.excludedBy)}</span>}
              </span>
            </span>
            <span className="dsm-qoder-pool-credits">
              {account.credits === undefined
                ? <span className="dsm-qoder-pool-unknown">{'—'}</span>
                : <b>{String(account.credits)}</b>}
              {account.nearestExpiryMs === undefined ? null
                : <span className="dsm-qoder-pool-soon-plain">{t('row.poolCreditNearest', { at: formatClock(account.nearestExpiryMs) })}</span>}
            </span>
            <span className="dsm-qoder-pool-probe">
              <span className="dsm-qoder-pool-probe-main">{probeLabelOf(t, account.probe, nowMs)}</span>
              {account.probe === undefined ? null : (
                <span className="dsm-qoder-pool-probe-prov">
                  {inlineProbeReason(account.probe.outcome, account.probe.message) === undefined ? null : (
                    <>
                      <span className="dsm-qoder-pool-prov-tag dsm-qoder-pool-prov-live" title={account.probe.message}>
                        {inlineProbeReason(account.probe.outcome, account.probe.message) as string}
                      </span>
                      <span className="dsm-qoder-pool-prov-sep">·</span>
                    </>
                  )}
                  <span className="dsm-qoder-pool-prov-tag">{probeSourceText(t, account.probe.source) ?? t('row.poolProbeSourceUnknown')}</span>
                  <span className="dsm-qoder-pool-prov-sep">·</span>
                  <span className="dsm-qoder-pool-prov-age">{probeAgeText(t, account.probe.atMs, nowMs)}</span>
                </span>
              )}
            </span>
            <span className="dsm-qoder-pool-row-actions">
              <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" title={t('row.poolRowTest')} aria-label={t('row.poolRowTest')} disabled={!canEditPool || batchBusy || targetMisses} onClick={() => { void runTestBatch() }}>
                {t('row.poolRowTest')}
              </button>
              {account.member ? (
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn"
                  title={t('row.poolRowRemoveHint')}
                  aria-label={t('row.poolRowRemoveAria', { accountName: account.accountName || t('row.accountUnnamed') })}
                  disabled={!canEditPool || removingId !== undefined}
                  onClick={() => { void runRowRemove(account.accountId) }}
                >
                  {removingId === account.accountId ? t('row.poolRowRemoving') : t('row.poolRowRemove')}
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </div>

      {effective.length === 0
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolNoneSelected')} ${t('row.poolNoneSelectedHint')}`)
        : null}
      {ghost.length === 0 ? null
        : h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            t('row.poolGhostMembers', { count: ghost.length }))}
      {dirty && !sameIds(active.memberAccountIds, saved.memberAccountIds)
        ? h('p', { className: 'dsm-qoder-pool-dirty' }, t('row.poolUnsavedMembers'))
        : null}

      <div className="dsm-qoder-pool-settings-wrap">
        {/* Members selection */}
        <div className="dsm-qoder-pool-members">
          <div className="dsm-qoder-pool-members-head">
            <div>
              <h4 className="dsm-qoder-pool-members-title">{t('row.poolMembersTitle')}</h4>
              <p className="dsm-qoder-pool-note">{t('row.poolMembersHint')}</p>
            </div>
            <div className="dsm-qoder-pool-members-actions">
              <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={pool?.accounts.length === 0 || !canEditPool} onClick={() => selectAll(true)}>{t('row.poolSelectAll')}</button>
              <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={effective.length === 0 || !canEditPool} onClick={() => selectAll(false)}>{t('row.poolSelectNone')}</button>
            </div>
          </div>
          <div className="dsm-qoder-pool-table">
            {(pool?.accounts ?? []).map(account => {
              const inPool = active.memberAccountIds.includes(account.accountId)
              return (
                <div key={account.accountId} className="dsm-qoder-pool-row">
                  <span className="dsm-qoder-pool-account">
                    <label className="dsm-qoder-pool-check">
                      <input
                        type="checkbox"
                        checked={inPool}
                        disabled={!canEditPool}
                        aria-label={t('row.poolSelectAria', { accountName: account.accountName || t('row.accountUnnamed') })}
                        onChange={(e) => toggleMember(account.accountId, e.target.checked)}
                      />
                    </label>
                    <span className="dsm-qoder-pool-account-name">
                      <b>{account.accountName === '' ? t('row.accountUnnamed') : account.accountName}</b>
                      <span className={inPool ? 'dsm-qoder-pool-member' : 'dsm-qoder-pool-not-member'}>
                        {inPool ? t('row.poolMember') : t('row.poolNotMember')}
                      </span>
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Preferences */}
        <div className="dsm-qoder-pool-settings">
          <RenderSettings
            t={t}
            active={active}
            dirty={dirty}
            saving={saving}
            canEditPool={canEditPool}
            saveError={saveError}
            catalog={pool?.catalog?.map(model => model.id)}
            onEdit={editDraft}
            onSave={() => { void savePool() }}
            onDiscard={() => { setDraftPool(saved); setDraftRegion(region); setDirty(false); setSaveError(undefined) }}
          />
        </div>
      </div>

      {/* Activity log */}
      <div className="dsm-qoder-pool-log">
        <div className="dsm-qoder-pool-log-head">
          <span>{t('row.poolLogTitle')}</span>
          <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-log-clear" onClick={() => setLog([])}>{t('row.poolLogClear')}</button>
        </div>
        {log.length === 0
          ? <div className="dsm-qoder-pool-log-empty">{t('row.poolLogEmpty')}</div>
          : <div className="dsm-qoder-pool-log-body">
              {[...log].map((entry, index) => (
                <div key={`${entry.atMs}-${index}`} className="dsm-qoder-pool-log-row">
                  <span className="dsm-qoder-pool-log-time">{formatClock(entry.atMs)}</span>
                  <span className={`dsm-qoder-pool-log-text dsm-qoder-pool-log-${entry.tone}`}>{entry.text}</span>
                </div>
              ))}
            </div>}
      </div>
    </section>
  )
}

function RenderSettings(props: {
  t: Translate
  active: PoolPreferences
  dirty: boolean
  saving: boolean
  canEditPool: boolean
  saveError?: string | undefined
  catalog?: readonly string[] | undefined
  onEdit: (update: (prev: PoolPreferences) => PoolPreferences) => void
  onSave: () => void
  onDiscard: () => void
}): ReactNode {
  const { t, active, dirty, saving, canEditPool, saveError, catalog, onEdit, onSave, onDiscard } = props
  return (
    <>
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolEnabled')}</b>
          <span>{t('row.poolEnabledHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <label className="sw">
            <input
              type="checkbox"
              checked={active.enabled}
              disabled={!canEditPool}
              onChange={(e) => onEdit(prev => ({ ...prev, enabled: e.target.checked }))}
            />
            <span className="sw-track" />
          </label>
        </div>
      </div>
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolTargetLabel')}</b>
          <span>{t('row.poolTargetHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <select className="dsm-qoder-pool-select" value={active.targetModelId} disabled={!canEditPool} onChange={(e) => onEdit(prev => ({ ...prev, targetModelId: e.target.value }))}>
            <option value="">{t('row.poolTargetAutoOption')}</option>
            {(catalog ?? []).map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      </div>
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolProbeSizeLabel')}</b>
          <span>{t('row.poolProbeSizeHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <select className="dsm-qoder-pool-select" value={String(active.probeInputTokens)} disabled={!canEditPool} onChange={(e) => onEdit(prev => ({ ...prev, probeInputTokens: Number(e.target.value) }))}>
            <option value="0">{t('row.poolProbeSizeDefault')}</option>
            {PROBE_INPUT_TOKEN_CHOICES.map(tokens => (
              <option key={String(tokens)} value={String(tokens)}>{t('row.poolProbeSizeOption', { tokens: String(Math.round(tokens / 1000)) })}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="dsm-qoder-pool-save-bar">
        <div className="dsm-qoder-pool-save-buttons">
          {dirty ? <span className="dsm-qoder-pool-dirty">{t('row.poolDirty')}</span> : null}
          {saveError === undefined ? null : <span className="dsm-qoder-pool-pending">{saveError}</span>}
          {dirty ? (
            <button type="button" className="dsm-btn dsm-btn-outline" disabled={!canEditPool || saving} onClick={onDiscard}>{t('row.poolDiscard')}</button>
          ) : null}
          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!canEditPool || saving || !dirty} onClick={onSave}>
            {saving ? t('row.poolSaving') : t('row.poolSaved')}
          </button>
        </div>
      </div>
    </>
  )
}

function parseTestRow(value: unknown): QoderWebPoolTestRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const accountId = typeof row['accountId'] === 'string' ? row['accountId'] : undefined
  const accountName = typeof row['accountName'] === 'string' ? row['accountName'] : undefined
  const result = row['result']
  if (accountId === undefined || accountName === undefined || typeof result !== 'object' || result === null) return undefined
  return { accountId, accountName, result: result as QoderWebProbeResult }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every(id => set.has(id))
}
