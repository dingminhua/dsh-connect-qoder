/**
 * The card's Add-PAT section: one resting bar row plus a dialog opened by the
 * "Add PAT" button.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `OAuthSignIn.tsx` 的组件形态：静态入口一行 + 弹窗 + 就地管理全部
 *     状态（busy / 结果 / 错误）+ 完成后回调让卡片重新读取快照。样式沿用
 *     transfer-dialog / bar 类。
 * 改动：Qoder 用 PAT 而不是桌面端 OAuth——扫码/网页登录整块替换为「粘贴 pt-…
 *   触发添加」的普通表单。Host 用 JobToken 交换验证该 token（合法才取得到显示
 *   名并创建 vault 条目），客户端只在格式上做前置校验（期望 `pt-` 前缀），把
 *   真正的验证留给 Host。
 *
 * @module dsh-connect-qoder/client/AddAccount
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { QODER_ACCOUNTS_PATH, QODER_PAT_DOC_URL, withQoderRouteAction } from '../status-paths.ts'
import type { QoderWebRegion } from '../status-paths.ts'
import type { Translate } from './locales.ts'
import { BusyOverlay } from './BusyOverlay.tsx'

/** Props: the region tab the section is rendered on, and the card's copy. */
export interface AddAccountProps {
  t: Translate
  region: QoderWebRegion
  /**
   * Called once the Host has stored the PAT, so the CARD can re-read its
   * snapshot and show the new account immediately.
   */
  onAdded?: () => void | Promise<unknown>
}

/** PAT is the Qoder token shape; a trivially-wrong paste fails before the POST. */
function looksLikePat(value: string): boolean {
  return /^pt-/u.test(value.trim())
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'validating' }
  /** The Host stored the credential; the card's re-read is still in flight. */
  | { kind: 'syncing' }
  | { kind: 'done', accountName: string }
  | { kind: 'error', message: string }

/**
 * The section. Rendered on BOTH account states: a region with no account gains
 * its first here; a signed-in one can add another without leaving the card.
 */
export function AddAccount({ t, region, onAdded }: AddAccountProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pat, setPat] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const closeDialog = (): void => {
    if (phase.kind === 'validating' || phase.kind === 'syncing') return
    setDialogOpen(false)
    setPhase({ kind: 'idle' })
    setPat('')
    setName('')
    setTouched(false)
  }

  const runAdd = async (): Promise<void> => {
    const trimmed = pat.trim()
    if (!looksLikePat(trimmed)) {
      setPhase({ kind: 'error', message: t('row.addAccountInvalid') })
      return
    }
    setPhase({ kind: 'validating' })
    try {
      const response = await fetch(withQoderRouteAction(QODER_ACCOUNTS_PATH, region, 'add'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pat: trimmed, ...(name.trim() === '' ? {} : { name: name.trim() }) }),
      })
      const body = await response.json().catch(() => ({})) as { accountId?: string, error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${String(response.status)}`)
      }
      if (body.accountId === undefined) {
        throw new Error(t('row.addAccountError', { message: `HTTP ${String(response.status)}` }))
      }
      if (!mounted.current) return
      setPhase({ kind: 'syncing' })
      await onAdded?.()
      if (!mounted.current) return
      setPhase({ kind: 'done', accountName: name.trim() !== '' ? name.trim() : t('row.accountUnnamed') })
      setPat('')
      setName('')
      setTouched(false)
    } catch (error: unknown) {
      if (!mounted.current) return
      setPhase({ kind: 'error', message: t('row.addAccountError', { message: String((error as Error)?.message ?? error) }) })
    }
  }

  const finishText = phase.kind === 'done'
    ? t('row.addAccountDone', { accountName: phase.accountName })
    : phase.kind === 'error'
      ? phase.message
      : ''

  return (
    <section className="dsm-qoder-bar" aria-label={t('row.addAccountStart')}>
        <p className="dsm-qoder-bar-label">{t('row.addAccountStart')}</p>
        {/* 状态行只在有状态时出现（workbuddy 的 bar-status 同规）。此前这里常驻
            一行「本区域生效的账号，从设置中的 PAT……」——那讲的是账号行的话题，
            不是「添加 PAT」，常驻还把这一行撑成三行高。 */}
        {finishText === '' ? null : (
          <p className={`dsm-qoder-bar-status ${phase.kind === 'done' ? 'dsm-qoder-bar-ok' : 'dsm-qoder-bar-error'}`}>{finishText}</p>
        )}
        <div className="dsm-qoder-bar-actions">
          <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { setPat(''); setName(''); setTouched(false); setPhase({ kind: 'idle' }); setDialogOpen(true) }}>
            {t('row.addAccountStart')}
          </button>
        </div>

      {dialogOpen ? (
        <div className="dsm-qoder-transfer-dialog" role="dialog" aria-label={t('row.addAccountTitle')}>
          <p>{t('row.addAccountTitle')}</p>
          <input
            className="dsm-qoder-addpat-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('row.addAccountPlaceholder')}
            value={pat}
            onChange={(event) => { setPat(event.target.value); setTouched(true) }}
          />
          <input
            className="dsm-qoder-addpat-name"
            type="text"
            placeholder={t('row.addAccountNameHint')}
            value={name}
            onChange={(event) => { setName(event.target.value) }}
          />
          <p>{t('row.addAccountTouchedOnce')}</p>
          {/* PAT 指南入口放在这里而不是页脚：用户正在找「PAT 从哪来」的时刻，
              正是这一行有用的时刻。页脚那条常驻提示已按用户要求删除。 */}
          <p className="dsm-qoder-addpat-doc">
            <a href={QODER_PAT_DOC_URL} target="_blank" rel="noopener noreferrer">{t('row.docsHint')}</a>
          </p>
          <div className="dsm-qoder-transfer-dialog-actions">
            <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.addAccountDialogClose')}</button>
            <button
              type="button"
              className="dsm-btn dsm-btn-primary"
              disabled={phase.kind === 'validating' || phase.kind === 'syncing' || !touched}
              onClick={() => { void runAdd() }}
            >
              {phase.kind === 'validating' ? t('row.addAccountValidating') : t('row.addAccountStart')}
            </button>
          </div>
          {finishText !== ''
            ? <p className={`dsm-qoder-bar-${phase.kind === 'done' ? 'ok' : 'error'}`} role="status">{finishText}</p>
            : null}
        </div>
      ) : null}

      <BusyOverlay
        message={t('row.addAccountSyncing')}
        hint={t('row.veilHintList')}
        visible={phase.kind === 'syncing'}
      />
    </section>
  )
}