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
  QODER_GITHUB_URL,
  withQoderRegionAndAction,
  withQoderRouteAction,
} from '../status-paths.ts'
import type {
  QoderWebPool,
  QoderWebPoolAccount,
  QoderWebPoolModel,
  QoderWebPoolTestRow,
  QoderWebProbeOutcome,
  QoderWebProbeResult,
  QoderWebRegion,
} from '../status-paths.ts'
import { exclusionText } from './exclusion-text.ts'
import { BusyOverlay } from './BusyOverlay.tsx'
import type { Translate } from './locales.ts'
import { inlineProbeReason } from './probe-reason.ts'
import { probeLabelOf, formatProbeMoment } from './probe-label.ts'
import { probeAgeText, probeSourceText } from './probe-age.ts'
import { PROBE_INPUT_TOKEN_CHOICES } from '../probe.ts'
import { remainingText } from './remaining.ts'

/** 池日志行的时间戳：只要时钟（日志是「刚刚/刚才」的语境，不需要日期）。 */
function formatClock(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
import {
  draftBaseFor,
  effectiveMemberIds,
  poolFailureText,
  usableMemberIds,
} from './pool-state.ts'
import { isFileContentionWriteError, writePoolPreferences } from './account-selection.ts'
import type { QoderAccountScope } from './account-selection.ts'

/** One line in the pool's activity log. */
interface PoolLogEntry {
  atMs: number
  text: string
  tone: 'ok' | 'warn' | 'error' | 'info'
}

/** 活动日志条数上限（超出裁最旧）。 */
const LOG_LIMIT = 50

/**
 * 跨 remount 的活动日志。折叠卡片/切换 tab 会 unmount 本组件，组件 state 会
 * 丢空；日志属于「刚刚发生了什么」的事实记录，丢了会让用户以为操作没发生。
 * （workbuddy 的 logStore 同款方案。）
 */
const logStore = new Map<QoderWebRegion, readonly PoolLogEntry[]>()

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
  /**
   * Reports THIS pool's own save in flight, so the card can disable the model
   * save / region switch / credits switch while it runs (workbuddy's
   * `onBusyChange` pattern): pool and models write into ONE region slot, and a
   * stale-snapshot save from either side would roll back the other's write.
   */
  onBusyChange?: ((busy: boolean) => void) | undefined
  /**
   * The account tools (add a PAT / export-import), rendered in a dashed box at
   * the TOP of the settings block — after the heading, before the hint — so
   * "which accounts does this region have" is answered in one place. The card
   * owns these (they need its refresh + region), so they arrive as a node.
   */
  accountTools?: ReactNode | undefined
  /** Whether this region may be edited (not while the provider is off). */
  canWrite: boolean
  /** Force the card to re-read its usage snapshot after a Host-side action. */
  onChanged?: (() => void | Promise<unknown>) | undefined
}

export function AccountPool(props: AccountPoolProps): ReactNode {
  const { t, region, pool, settingsScope, siblingBusy, canWrite, onChanged, onBusyChange, accountTools } = props
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [batchBusy, setBatchBusy] = useState(false)
  const [removingId, setRemovingId] = useState<string | undefined>(undefined)
  // 日志种子来自模块级 logStore：折叠卡片/切换 tab 导致的 unmount 不再清空
  // 历史（workbuddy 同规）。两个区域各持一份，切 tab 是换历史而不是混历史。
  const [log, setLog] = useState<readonly PoolLogEntry[]>(() => logStore.get(region) ?? [])
  useEffect(() => {
    setLog(logStore.get(region) ?? [])
  }, [region])
  const [draftRegion, setDraftRegion] = useState<string | undefined>(undefined)
  const [draftPool, setDraftPool] = useState<PoolPreferences | null>(null)
  const mounted = useRef(true)
  /** 幽灵成员自愈的防重入标记（见 render 前的那个 effect）。 */
  const pruningRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    setNowMs(Date.now())
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 20_000)
    return () => window.clearInterval(timer)
  }, [])

  // 上报本池保存的 in-flight 窗口（卸载时务必归零）。workbuddy 同款的
  // useEffect 上报模式。
  useEffect(() => {
    onBusyChange?.(saving)
    return () => { onBusyChange?.(false) }
  }, [onBusyChange, saving])

  const saved: PoolPreferences = {
    enabled: pool?.enabled ?? false,
    // 陈旧目标回退：保存的 id 已掉出目录时 `targetModelId` 为空而
    // `staleTargetModelId` 存着原值——select 必须显示那个原值（以一个禁用的
    // 「已失效」option 呈现），而不是退回「自动」让用户以为从没选过。
    targetModelId: pool?.targetModelId || pool?.staleTargetModelId || '',
    probeInputTokens: pool?.probeInputTokens ?? 0,
    memberAccountIds: pool?.memberAccountIds ?? [],
  }

  /**
   * 正在计费的那个账号，或 undefined（池里没有 `current` 行时）。
   *
   * 这个事实由宿主给出（取自该区域解析出的服务凭据），卡片只渲染、不推断。
   */
  const currentAccount = pool?.accounts.find(account => account.current === true)
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
  const canEditPool = settingsScope !== undefined && canWrite && !siblingBusy

  /**
   * 幽灵成员自愈：名单里留有「凭据已被删除」的 id 时，静默把名单收敛为实际
   * 存在的成员并写回。
   *
   * 为什么不提示用户（用户实拍：「你应该直接就清理掉，而不是再给我这么一个
   * 提示」）：删掉 PAT 之后配置里的 `memberAccountIds` 不会自动收缩，残渣是
   * 插件的内部记账问题。原先的文案（「再保存一次即可移除它们」）把这件事推回
   * 给用户——他删完 PAT 还得回到池设置里再点一次保存，而他本来就不想要这些
   * 账号；更糟的是批量测试仍会遍历它们，白跑一轮。
   *
   * 只在不脏、不忙、可写时动手：正在编辑草稿时不能偷改（会覆盖用户的选择），
   * 只读权限下也不能写。ref 防重入——写回后 pool 以新快照回流，effect 再跑时
   * kept 已等于 savedIds，自然停下。
   */
  useEffect(() => {
    if (dirty || saving || settingsScope === undefined || !canEditPool) return
    const savedIds = pool?.memberAccountIds
    if (savedIds === undefined) return
    const kept = savedIds.filter(id => listed.has(id))
    if (kept.length === savedIds.length) return
    if (pruningRef.current) return
    pruningRef.current = true
    void writePoolPreferences(settingsScope, region, { ...saved, memberAccountIds: kept })
      .then(() => onChanged?.())
      .catch(() => { /* 自愈失败不弹错；下次快照回流再试 */ })
      .finally(() => { pruningRef.current = false })
  }, [dirty, saving, settingsScope, canEditPool, pool?.memberAccountIds, region, saved, listed, onChanged])
  // 现在就能服务的成员（workbuddy 的 usable）：有效成员 ∩ 未被排除。
  const usable = pool === undefined ? [] : usableMemberIds(pool.accounts, effective, active.memberAccountIds)
  // 目标模型来源一句话：「当前用的是谁、是不是你选的」先于「自动怎么工作」的
  // 静态说明出现（workbuddy 的 targetProvenance 同规）。
  const targetProvenance = pool === undefined ? null
    : pool.targetModelSource === 'preferred'
      ? t('row.poolTargetCurrentPreferred', { model: pool.targetModelId ?? '' })
      : pool.targetModelSource === 'free'
        ? t('row.poolTargetCurrentFree', { model: pool.targetModelId ?? '' })
        : pool.targetModelSource === 'stale'
          ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })
          : pool.targetModelSource === 'none' ? t('row.poolTargetNone') : null

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
    setLog(entries => {
      const next = [entry, ...entries].slice(0, LOG_LIMIT)
      logStore.set(region, next)
      return next
    })
  }, [region])

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
        visible={batchBusy || saving || removingId !== undefined}
        message={batchBusy ? t('row.poolTesting') : t('row.poolSaving')}
        hint={t('row.poolBusyHint')}
      />

      <div className="dsm-qoder-pool-head">
        <h3 className="dsm-qoder-pool-title">{t('row.poolTitle')}</h3>
        {/* 「当前使用」芯片：由宿主给出的 `current` 事实驱动（正在计费的那个账号），
            不是从排序或列表位置猜出来的——否则卡片会宣称一次并未发生的切换。 */}
        {currentAccount === undefined ? null : (
          <span className="dsm-qoder-pool-current-badge" title={t('row.poolCurrentHeader', { account: currentAccount.accountName || currentAccount.accountId })}>
            {t('row.poolCurrentHeader', { account: currentAccount.accountName || currentAccount.accountId })}
          </span>
        )}
      </div>

      <div className="dsm-qoder-pool-actions">
        <div className="dsm-qoder-pool-actions-group">
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canEditPool || effective.length === 0 || batchBusy || targetMisses}
            title={pool?.targetModelSource === 'none'
              ? t('row.poolTargetNone')
              : pool?.targetModelSource === 'stale' ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' }) : undefined}
            onClick={() => { void runTestBatch() }}
          >
            {batchBusy ? t('row.poolTesting') : t('row.poolTestAll')}
          </button>
          {/* 批量测试期间说明「正在逐个处理」：宿主只在批量结束时一次性返回，
              没有逐行进度可报（workbuddy 同规）。 */}
          {batchBusy ? <span className="dsm-qoder-pool-hint">{t('row.poolBusyHint')}</span> : null}
        </div>
      </div>

      {/* 池开关关掉时说明它的语义：手动测试仍可用，只是不再自动选号。 */}
      {pool?.enabled === false
        ? h('p', { className: 'dsm-qoder-pool-note' }, t('row.poolEnabledHint'))
        : null}
      {/* 开着却没有可用成员时直说：失败会被直接报出来而不是被重试。 */}
      {pool?.enabled === true && usable.length === 0
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolNoCandidate')} ${t('row.poolNoCandidateHint')}`)
        : null}

      {/* 成员选择就在这张表里完成：复选框即成员资格（workbuddy 的单表同构）。
          表头带全选/清空，默认全不选——什么都不勾绝不等于「全部」。 */}
      <div className="dsm-qoder-pool-members">
        <div className="dsm-qoder-pool-members-head">
          <div>
            <h4 className="dsm-qoder-pool-members-title">{t('row.poolMembersTitle')}</h4>
            <p className="dsm-qoder-pool-note">{t('row.poolMembersHint')}</p>
          </div>
          <div className="dsm-qoder-pool-members-actions">
            <span className="dsm-qoder-pool-hint">
              {t('row.poolSelectedCount', { count: effective.length, total: pool?.accounts.length ?? 0 })}
            </span>
            <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={pool?.accounts.length === 0 || !canEditPool} onClick={() => selectAll(true)}>{t('row.poolSelectAll')}</button>
            <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={effective.length === 0 || !canEditPool} onClick={() => selectAll(false)}>{t('row.poolSelectNone')}</button>
          </div>
        </div>
        {/* Pool table — no check-in column (checkinSupported is always false). */}
        <div className="dsm-qoder-pool-table">
          <div className="dsm-qoder-pool-row dsm-qoder-pool-row-head">
            <span>{t('row.poolColumnAccount')}</span>
            <span>{t('row.poolColumnCredits')}</span>
            <span>{t('row.poolColumnProbe')}</span>
            <span />
          </div>
          {(pool?.accounts ?? []).map(account => {
            const name = account.accountName === '' ? t('row.accountUnnamed') : account.accountName
            const excluded = exclusionText(t, account.excludedBy)
            const inPool = active.memberAccountIds.includes(account.accountId)
            return (
              <div
                key={account.accountId}
                className={`dsm-qoder-pool-row${account.current ? ' dsm-qoder-pool-row-current' : ''}`}
              >
                <span className="dsm-qoder-pool-account">
                  <label className="dsm-qoder-pool-check">
                    <input
                      type="checkbox"
                      checked={inPool}
                      disabled={!canEditPool}
                      aria-label={t('row.poolSelectAria', { accountName: name })}
                      onChange={(e) => toggleMember(account.accountId, e.target.checked)}
                    />
                  </label>
                  {/* 状态点：排除=红/琥珀、未测=灰、测过=绿/琥珀（workbuddy 同规）。 */}
                  <span className="dsm-qoder-usage-dot" style={{ background: stateColor(account) }} />
                  <span className="dsm-qoder-pool-account-name">
                    <b>{name}</b>
                    {/* 谁正在计费，用文字说出来：行底色只有 7% 透明度，
                        「到底哪一行」不能只靠颜色回答。 */}
                    {account.current ? <span className="dsm-qoder-pool-current-tag">{t('row.poolCurrentBadge')}</span> : null}
                    {/* 成员资格每行写明：未勾选账号的空积分/探针列，否则与
                        「勾了但还没数据」无法区分。 */}
                    <span className={inPool ? 'dsm-qoder-pool-member' : 'dsm-qoder-pool-not-member'}>
                      {inPool ? t('row.poolMember') : t('row.poolNotMember')}
                    </span>
                    {excluded === undefined
                      ? account.probe === undefined ? null : <span>{t('row.poolTestedAt', { at: formatProbeMoment(account.probe.atMs) })}</span>
                      : <span className="dsm-qoder-pool-excluded">{excluded}</span>}
                  </span>
                </span>
                <span className="dsm-qoder-pool-credits">
                  {account.credits === undefined
                    ? <span className="dsm-qoder-pool-unknown">{'—'}</span>
                    : <b>{String(account.credits)}</b>}
                  {account.expiringSoon !== undefined && account.expiringSoon > 0
                    ? <span className="dsm-qoder-pool-soon">{t('row.poolCreditSoon', { count: String(account.expiringSoon) })}</span>
                    : account.nearestExpiryMs === undefined ? null
                      : <span className="dsm-qoder-pool-soon-plain">{t('row.poolCreditNearest', { at: formatProbeMoment(account.nearestExpiryMs) })}</span>}
                </span>
                <span className="dsm-qoder-pool-probe" {...(account.probe?.message === undefined ? {} : { title: account.probe.message })}>
                  {/* 主行 = 结果 · 原因（workbuddy 的 probeLine 同规）：原因写进主行
                      而不是另做药丸——它回答的正是「为什么是现在这个结果」，与结果
                      同句读才顺；全文仍在行 title 里。 */}
                  <span className="dsm-qoder-pool-probe-main">
                    {[
                      probeLabelOf(t, account.probe, nowMs),
                      account.probe === undefined ? undefined : inlineProbeReason(account.probe.outcome, account.probe.message),
                    ]
                      .filter(part => part !== undefined && part !== '')
                      .join(' · ')}
                  </span>
                  {account.probe === undefined ? null : (
                    <span className="dsm-qoder-pool-probe-prov">
                      <span className={probeSourceClass(account.probe.source)}>
                        {probeSourceText(t, account.probe.source) ?? t('row.poolProbeSourceUnknown')}
                      </span>
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
                      aria-label={t('row.poolRowRemoveAria', { accountName: name })}
                      disabled={!canEditPool || removingId !== undefined}
                      onClick={() => { void runRowRemove(account.accountId) }}
                    >
                      {removingId === account.accountId ? t('row.poolRowRemoving') : t('row.poolRowRemove')}
                    </button>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {effective.length === 0
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolNoneSelected')} ${t('row.poolNoneSelectedHint')}`)
        : null}
      {/* 幽灵成员没有提示行：上面那个 effect 静默收敛名单（用户实拍：
          「你应该直接就清理掉，而不是再给我这么一个提示」）。 */}
      {dirty && !sameIds(active.memberAccountIds, saved.memberAccountIds)
        ? h('p', { className: 'dsm-qoder-pool-dirty' }, t('row.poolUnsavedMembers'))
        : null}

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

      {/* Preferences（外壳与保存行由 RenderSettings 自己渲染，与 workbuddy 同构） */}
      <RenderSettings
        t={t}
        active={active}
        dirty={dirty}
        saving={saving}
        canEditPool={canEditPool}
        saveError={saveError}
        catalog={pool?.catalog}
        targetProvenance={targetProvenance}
        accountTools={accountTools}
        onEdit={editDraft}
        onSave={() => { void savePool() }}
        onDiscard={() => { setDraftPool(saved); setDraftRegion(region); setDirty(false); setSaveError(undefined) }}
      />

      {/* 这里**不再**重复「国内版与国际版互相独立」那句话（用户实拍：「都重复
          了」）：tab 栏下方已经有一行 `row.tabHint` 说明每个 tab 是独立供应商、
          一侧的改动不影响另一侧，而这一行只是把它换了个说法再说一遍。 */}

      {/* Activity log */}
      <div className="dsm-qoder-pool-log">
        <div className="dsm-qoder-pool-log-head">
          <span>{t('row.poolLogTitle')}</span>
          <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-log-clear" onClick={() => { logStore.set(region, []); setLog([]) }}>{t('row.poolLogClear')}</button>
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
  /**
   * The region's pickable models, as objects rather than ids: the option label
   * carries the display name and the credit multiplier, so a manual choice is
   * both recognisable and priced before it is made.
   */
  catalog?: readonly QoderWebPoolModel[] | undefined
  /** 目标模型的来源一句话（「当前：xx（你指定）」），null 表示无话可说。 */
  targetProvenance: string | null
  /** 账号工具（添加 PAT / 导出导入），虚线框放在标题之下、说明行之上。 */
  accountTools?: ReactNode | undefined
  onEdit: (update: (prev: PoolPreferences) => PoolPreferences) => void
  onSave: () => void
  onDiscard: () => void
}): ReactNode {
  const { t, active, dirty, saving, canEditPool, saveError, catalog, targetProvenance, accountTools, onEdit, onSave, onDiscard } = props
  return (
    <div className="dsm-qoder-pool-settings-wrap">
      {/* 设置区自己的小标题 + 脏标记（workbuddy 同构）：下面几行是草稿，
          与上方立即生效的表格区分开。 */}
      <div className="dsm-qoder-pool-head">
        <h3 className="dsm-qoder-pool-title">{t('row.poolSettingsTitle')}</h3>
        {dirty ? <span className="dsm-qoder-pool-dirty">{t('row.poolDirty')}</span> : null}
      </div>
      {/* 账号工具在说明行之前（workbuddy 同构）：它们立即生效，而说明行提到的
          是「下面这些偏好要点保存」，顺序颠倒会让读者以为工具也要保存。 */}
      {accountTools === undefined ? null : <div className="dsm-qoder-pool-tools">{accountTools}</div>}
      <p className="dsm-qoder-pool-note">{t('row.poolSettingsHint')}</p>
      <div className="dsm-qoder-pool-settings">
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
          {/* 来源先行：先回答「当前是谁、是不是我选的」，再解释自动怎么工作
              （workbuddy 同规）。 */}
          <span>{targetProvenance === null ? null : `${targetProvenance} `}{t('row.poolTargetHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <select className="dsm-qoder-pool-select" value={active.targetModelId} disabled={!canEditPool} onChange={(e) => onEdit(prev => ({ ...prev, targetModelId: e.target.value }))}>
            <option value="">{t('row.poolTargetAutoOption')}</option>
            {/* 已保存但已不在目录里的 id 需要它**自己**的一个 option：否则这个受控
                select 找不到匹配项，浏览器会退回显示第一项（「自动」），而存的值仍是
                旧 id——显示与取值就此分叉，下一次保存又把旧 id 写回去。设为 disabled
                使其不可能被重新选中，同时让用户看见到底存的是什么。 */}
            {active.targetModelId !== '' && !(catalog ?? []).some(m => m.id === active.targetModelId)
              ? <option value={active.targetModelId} disabled>{t('row.poolTargetStaleOption', { model: active.targetModelId })}</option>
              : null}
            {/* 显示名 + 倍率，与 workbuddy 同构（`名字 (x0.79)`）：选项文本此前
                直接渲染模型 id（`qmodel_latest`），既不是用户认得的名字，也让
                「这次测试花不花积分」无从判断——而那正是选目标的全部意义。 */}
            {(catalog ?? []).map(model => (
              <option key={model.id} value={model.id}>
                {model.creditMultiplier === undefined
                  ? model.name
                  : `${model.name} (x${model.creditMultiplier.toFixed(2)})`}
              </option>
            ))}
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
      </div>
      {/* 保存行是那张带边框的设置卡片的**兄弟**，不在它里面（workbuddy 同构）：
          放进卡片就落进 `overflow:hidden` 的圆角边框内，左端的仓库链接会紧贴
          边框，而上方的「启用账号池」内缩 14px——同一条左对齐线断成两截（用户
          实拍：「还是不对」）。它自带的 border-top 也正是这一行与卡片之间的分隔。 */}
      <div className="dsm-qoder-pool-save-bar">
        {/* 仓库链接在保存行左端（workbuddy 同构）：与模型保存行同一个位置，
            不给它单独一行。 */}
        <a
          className="dsm-qoder-usage-cheer"
          href={QODER_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('row.cheer')}
          <span className="dsm-qoder-usage-cheer-star" aria-hidden="true">★</span>
        </a>
        <div className="dsm-qoder-pool-save-buttons">
          {saveError === undefined ? null : <span className="dsm-qoder-pool-pending">{saveError}</span>}
          {/* 「放弃修改」恒在（未改动时禁用），与模型保存行一致——条件渲染会让
              这一行在改动/还原之间左右跳动。 */}
          <button type="button" className="dsm-btn dsm-btn-outline" disabled={!canEditPool || saving || !dirty} onClick={onDiscard}>{t('row.poolDiscard')}</button>
          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!canEditPool || saving || !dirty} onClick={onSave}>
            {saving ? t('row.poolSaving') : t('row.poolSaved')}
          </button>
        </div>
      </div>
    </div>
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

/**
 * 溯源药丸的样式类（workbuddy 的 probeLabel 同规）：来源未知用带描边的
 * 「未知」态——它必须与「测试写入」的默认态看得出区别，否则一条旧记录
 * 看起来就像刚测过。
 */
function probeSourceClass(source: 'test-batch' | 'live-request' | undefined): string {
  if (source === undefined) return 'dsm-qoder-pool-prov-tag dsm-qoder-pool-prov-unknown'
  return source === 'live-request'
    ? 'dsm-qoder-pool-prov-tag dsm-qoder-pool-prov-live'
    : 'dsm-qoder-pool-prov-tag'
}

/**
 * 成员行状态点的颜色（workbuddy 的 stateColor 同规）：被排除的看性质——
 * 限流/不可用是自己会好的等待态（琥珀），凭据被拒等需要用户动手（红）；
 * 未测灰、测过按结果绿/琥珀。
 */
function stateColor(account: QoderWebPoolAccount): string {
  if (account.excludedBy !== undefined) {
    return account.excludedBy === 'rate-limited' || account.excludedBy === 'unavailable'
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : 'var(--dsw-alias-state-error-primary, #ef4444)'
  }
  if (account.probe === undefined) return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return account.probe.outcome === 'ok'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : 'var(--dsw-alias-state-warn-primary, #f59e0b)'
}
