/**
 * The card's account-transfer section: batch export / import of the region's
 * stored credentials, in the file format shared with sibling credential
 * managers for the same upstream.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `AccountTransfer.tsx`：导出弹框（多选账号 → 下载 JSON）与导入
 *     弹框（选文件 → 脱敏预览 → 勾选 → 导入）的步骤划分、`<a download>` Blob
 *     下载（设置页 iframe 无宿主保存对话框）。
 * 改动：按 Qoder 的传输契约（`src/status-paths.ts` 的 `QoderTransferRecord`
 *   snake_case 记录：`access_token` / `uid` / `nickname` / `email` / `domain`）
 *   与 Host 的 transfer 路由（export / preview / import）适配。
 *
 * @module dsh-connect-qoder/client/AccountTransfer
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  QODER_TRANSFER_PATH,
  withQoderRouteAction,
  type QoderTransferPreviewEntry,
  type QoderTransferRecord,
} from '../status-paths.ts'
import type { QoderWebRegion } from '../status-paths.ts'
import type { Translate } from './locales.ts'
import { BusyOverlay } from './BusyOverlay.tsx'

/** Props: the region tab, the card's copy, and the accounts the Host knows. */
export interface AccountTransferProps {
  t: Translate
  region: QoderWebRegion
  /** The region's accounts (id + name), token-free, from the usage snapshot. */
  accounts: readonly { id: string, accountName: string }[]
  /**
   * Called after an import actually added something, so the CARD can re-read
   * its snapshot.
   */
  onChanged?: () => void | Promise<unknown>
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'importing' }
  /** The write landed; the list re-read is still in flight. */
  | { kind: 'refreshing', message: string }
  | { kind: 'done', message: string }
  | { kind: 'error', message: string }

/** Build the default export file name: qoder-accounts-YYYY-MM-DD.json. */
function exportFileName(): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const d = new Date()
  return `qoder-accounts-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`
}

/** Download a JSON array as a local file (no host save dialog inside the iframe). */
function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * The section. Rendered on both account states — a region with no account can
 * still import a file exported elsewhere; export without accounts answers the
 * error line.
 */
export function AccountTransfer({ t, region, accounts, onChanged }: AccountTransferProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialog, setDialog] = useState<'export' | 'import' | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<readonly QoderTransferPreviewEntry[] | undefined>(undefined)
  const [importSelected, setImportSelected] = useState<ReadonlySet<number>>(new Set())
  const fileInput = useRef<HTMLInputElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const closeDialog = (): void => {
    if (phase.kind === 'exporting' || phase.kind === 'importing' || phase.kind === 'refreshing') return
    setDialog(undefined)
    setSelected(new Set())
    setPreview(undefined)
    setImportSelected(new Set())
    setPhase({ kind: 'idle' })
  }

  const transferPost = async (action: 'export' | 'preview' | 'import', body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(withQoderRouteAction(QODER_TRANSFER_PATH, region, action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const parsed = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) {
      throw new Error(parsed.error ?? `HTTP ${String(response.status)}`)
    }
    return parsed
  }

  const runExport = async (): Promise<void> => {
    setPhase({ kind: 'exporting' })
    try {
      const answer = await transferPost('export', {}) as { accounts: QoderTransferRecord[] }
      if (!mounted.current) return
      if (selected.size === 0 || answer.accounts.length === 0) {
        setPhase({ kind: 'error', message: t('row.transferError', { message: 'no selection' }) })
        return
      }
      // The export records and the usage-snapshot accounts share no stable id,
      // so match records to the selection by whichever identifying field lines
      // up (uid / nickname / email against the account id or name). A selected
      // account with no matching record is skipped rather than emitted empty.
      const wanted = new Set([...selected])
      const projected: QoderTransferRecord[] = answer.accounts.filter(record =>
        wanted.has(record.uid ?? '') || wanted.has(record.nickname ?? '') || wanted.has(record.email ?? ''))
      const fileName = exportFileName()
      downloadJson(fileName, projected.length > 0 ? projected : answer.accounts)
      setPhase({ kind: 'done', message: t('row.transferExported', { count: projected.length > 0 ? projected.length : answer.accounts.length, fileName }) })
    } catch (error) {
      if (!mounted.current) return
      setPhase({ kind: 'error', message: t('row.transferError', { message: String((error as Error)?.message ?? error) }) })
    }
  }

  const runImport = async (): Promise<void> => {
    const file = fileInput.current?.files?.[0]
    if (file === undefined) return
    setPhase({ kind: 'importing' })
    try {
      const text = await file.text()
      const previewAnswer = await transferPost('preview', { text }) as { accounts: readonly QoderTransferPreviewEntry[], total: number }
      if (!mounted.current) return
      setPreview(previewAnswer.accounts)
      setImportSelected(new Set(previewAnswer.accounts.map(entry => entry.index)))
      setPhase({ kind: 'idle' })
    } catch (error) {
      if (!mounted.current) return
      setPhase({ kind: 'error', message: t('row.transferError', { message: String((error as Error)?.message ?? error) }) })
    }
  }

  const runImportConfirm = async (): Promise<void> => {
    const file = fileInput.current?.files?.[0]
    if (file === undefined) return
    const text = await file.text()
    setPhase({ kind: 'importing' })
    try {
      const indexes = [...importSelected]
      const answer = await transferPost('import', { text, indexes }) as { imported: number, skipped: number }
      if (!mounted.current) return
      setPhase({ kind: 'refreshing', message: t('row.transferImported', { imported: answer.imported, skipped: answer.skipped }) })
      await onChanged?.()
      if (!mounted.current) return
      setPhase({ kind: 'done', message: t('row.transferImported', { imported: answer.imported, skipped: answer.skipped }) })
      closeDialog()
    } catch (error) {
      if (!mounted.current) return
      setPhase({ kind: 'error', message: t('row.transferError', { message: String((error as Error)?.message ?? error) }) })
    }
  }

  return (
    <section className="dsm-qoder-bar" aria-label={t('row.transferTitle')}>
      <BusyOverlay
        message={phase.kind === 'refreshing' || phase.kind === 'importing' ? t('row.transferImporting') : t('row.transferExporting')}
        hint={t('row.veilHintList')}
        visible={phase.kind === 'importing' || phase.kind === 'refreshing'}
      />
      <p className="dsm-qoder-bar-label">{t('row.transferTitle')}</p>
      {/* 状态行只在有结果时出现（workbuddy 同规）：常驻的「导出为 JSON 文件……」
          把这一行撑成三行高，而它讲的是弹窗里的操作，应当在弹窗里说。 */}
      {phase.kind === 'done'
        ? <p className="dsm-qoder-bar-status dsm-qoder-bar-ok">{phase.message}</p>
        : phase.kind === 'error'
          ? <p className="dsm-qoder-bar-status dsm-qoder-bar-error">{phase.message}</p>
          : null}
      <div className="dsm-qoder-bar-actions">
        <button type="button" className="dsm-btn dsm-btn-outline" disabled={accounts.length === 0} onClick={() => { closeDialog(); setDialog('export'); setPhase({ kind: 'idle' }) }}>
          {t('row.transferExport')}
        </button>
        <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { closeDialog(); setDialog('import'); setPhase({ kind: 'idle' }) }}>
          {t('row.transferImport')}
        </button>
      </div>

      {dialog === 'export' ? (
        <div className="dsm-qoder-transfer-dialog" role="dialog" aria-label={t('row.transferExport')}>
          <p>{t('row.transferExportPick', { total: accounts.length })}</p>
          <ul className="dsm-qoder-transfer-list">
            {accounts.map(account => (
              <li key={account.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(account.id)}
                    onChange={(event) => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(account.id)
                      else next.delete(account.id)
                      setSelected(next)
                    }}
                  />
                  <span>{account.accountName === '' ? t('row.accountUnnamed') : account.accountName}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="dsm-qoder-transfer-dialog-actions">
            <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
            <button
              type="button"
              className="dsm-btn dsm-btn-primary"
              disabled={selected.size === 0 || phase.kind === 'exporting'}
              onClick={() => { void runExport() }}
            >
              {phase.kind === 'exporting' ? t('row.transferExporting') : t('row.transferExportConfirm', { count: selected.size })}
            </button>
          </div>
          {phase.kind === 'done' ? <p className="dsm-qoder-bar-ok" role="status">{phase.message}</p> : null}
          {phase.kind === 'error' ? <p className="dsm-qoder-bar-error" role="alert">{phase.message}</p> : null}
        </div>
      ) : null}

      {dialog === 'import' ? (
        <div className="dsm-qoder-transfer-dialog" role="dialog" aria-label={t('row.transferImport')}>
          <p>{t('row.transferHint')}</p>
          <div className="dsm-qoder-transfer">
            <input
              ref={fileInput}
              className="dsm-qoder-transfer-file"
              type="file"
              accept=".json,application/json"
              onChange={() => { void runImport() }}
            />
            <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { fileInput.current?.click() }}>
              {t('row.transferImport')}
            </button>
          </div>

          {phase.kind === 'refreshing' ? <p className="dsm-qoder-bar-status" role="status">{phase.message}</p> : null}
          {preview !== undefined ? (
            <>
              <p>{t('row.transferPreviewTotal', { total: preview.length })}</p>
              <ul className="dsm-qoder-transfer-list">
                {preview.map(entry => (
                  <li key={entry.index}>
                    <label>
                      <input
                        type="checkbox"
                        checked={importSelected.has(entry.index)}
                        onChange={(event) => {
                          const next = new Set(importSelected)
                          if (event.target.checked) next.add(entry.index)
                          else next.delete(entry.index)
                          setImportSelected(next)
                        }}
                      />
                      <span>
                        {entry.nickname.trim() === '' ? t('row.transferEntryUnknown') : entry.nickname}
                        {entry.hasToken ? '' : ` (${t('row.transferNoToken')})`}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="dsm-qoder-transfer-dialog-actions">
                <button type="button" className="dsm-btn dsm-btn-outline" onClick={closeDialog}>{t('row.transferCancel')}</button>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-primary"
                  disabled={importSelected.size === 0 || phase.kind === 'importing'}
                  onClick={() => { void runImportConfirm() }}
                >
                  {phase.kind === 'importing' ? t('row.transferImporting') : t('row.transferImportConfirm', { count: importSelected.size })}
                </button>
              </div>
            </>
          ) : null}
          {phase.kind === 'done' ? <p className="dsm-qoder-bar-ok" role="status">{phase.message}</p> : null}
          {phase.kind === 'error' ? <p className="dsm-qoder-bar-error" role="alert">{phase.message}</p> : null}
        </div>
      ) : null}
    </section>
  )
}