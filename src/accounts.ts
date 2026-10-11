/**
 * Qoder 账号库：按区域隔离的 PAT 保险库 + 账号解析。
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 *   `src/auth.ts` —— 插件自有凭据文件的约定（`$DSH_HOME` 下按区域分文件、
 *   `withFileLock` + `writeFileAtomic`、`mode: 0o600`）、「账号列表与选中
 *   分离，选中存设置」「读取永不抛异常」的语义沿用其做法。
 * 改动：WorkBuddy 的账号来自桌面端登录文件 + OAuth 扫码；Qoder 的账号
 *   就是 PAT 本身，来源三种——设置卡片的 PAT 字段、环境变量、以及本模块
 *   维护的插件自有保险库（卡片「添加账号」与转账导入写入）。账号 id 由
 *   PAT 单向派生（见 `credentials.ts` 的 `qoderAccountId`），不依赖联机
 *   验证，也不把 token 材料泄进 id。
 *
 * 本模块不碰网络：PAT 的有效性验证（jobToken 交换）在 Host 路由层完成，
 * 这里只负责持久化与解析。
 *
 * @module dsh-connect-qoder/accounts
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { qoderAccountId } from './credentials.ts'
import type { QoderRegion } from './upstream.ts'

/** On-disk format version; readers reject anything else. */
const VAULT_FORMAT_VERSION = 1

/** Filename prefix for one region's account vault. */
const VAULT_PREFIX = '.qoder-accounts'

/** One stored PAT entry. */
export interface QoderStoredAccount {
  /** Stable id derived from the PAT (`pat-<sha256[:16]>`). */
  id: string
  /** Display name from the gateway's jobToken exchange, or `''`. */
  accountName: string
  /** The credential itself. Never leaves the Host. */
  pat: string
  /** When the entry was added, epoch ms. */
  addedAtMs: number
}

/** The vault document actually written to disk. */
interface VaultDocument {
  version: typeof VAULT_FORMAT_VERSION
  accounts: QoderStoredAccount[]
}

/**
 * One account as the account table sees it — token-free.
 *
 * `source` says where the credential lives: the settings card's PAT field,
 * an environment variable, or this vault. The first two are managed outside
 * the plugin (edit the field / the environment), so only `vault` entries are
 * removable through the card.
 */
export interface QoderAccountEntry {
  id: string
  accountName: string
  source: 'settings' | 'env' | 'vault'
}

/** One resolved credential: the account plus its PAT. */
export interface QoderResolvedCredential extends QoderAccountEntry {
  pat: string
}

/** Whether a parsed value looks like a stored account entry. */
function isStoredAccount(value: unknown): value is QoderStoredAccount {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['id'] === 'string' && candidate['id'] !== ''
    && typeof candidate['pat'] === 'string' && candidate['pat'] !== ''
    && typeof candidate['accountName'] === 'string'
    && typeof candidate['addedAtMs'] === 'number'
}

/** One region's vault path. */
export function qoderAccountsPath(region: QoderRegion): string {
  return join(resolveDshHome(), `${VAULT_PREFIX}.${region}.json`)
}

/**
 * One region's account store.
 *
 * Reads never throw: a missing, unreadable, malformed, or version-mismatched
 * vault all mean "no stored accounts", which is a valid state — the pool and
 * the card simply show an empty account list. Writes go through the file lock
 * and an atomic replace, same as the credential copies in the sibling plugin.
 */
export class QoderAccountStore {
  readonly region: QoderRegion

  constructor(region: QoderRegion) {
    this.region = region
  }

  /** The vault entries, in insertion order. */
  async vaultAccounts(): Promise<QoderStoredAccount[]> {
    let raw: string
    try {
      raw = await readFile(qoderAccountsPath(this.region), 'utf8')
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const document = parsed as Partial<VaultDocument>
    if (document.version !== VAULT_FORMAT_VERSION) return []
    if (!Array.isArray(document.accounts)) return []
    return document.accounts.filter(isStoredAccount)
  }

  /**
   * Every account this region can bill, merged from all three sources.
   *
   * Order is the resolution priority: the settings PAT first, then the
   * environment PAT, then the vault. A PAT appearing in two sources is listed
   * ONCE, under the higher-priority source — the id is derived from the PAT
   * itself, so duplicates are exact.
   */
  async accounts(sources: { settingsPat?: string | undefined, envPat?: string | undefined }): Promise<QoderAccountEntry[]> {
    const out: QoderAccountEntry[] = []
    const seen = new Set<string>()
    const settingsPat = sources.settingsPat?.trim()
    if (settingsPat) {
      const id = qoderAccountId(settingsPat)
      seen.add(id)
      out.push({ id, accountName: '', source: 'settings' })
    }
    const envPat = sources.envPat?.trim()
    if (envPat) {
      const id = qoderAccountId(envPat)
      if (!seen.has(id)) {
        seen.add(id)
        out.push({ id, accountName: '', source: 'env' })
      }
    }
    for (const stored of await this.vaultAccounts()) {
      if (seen.has(stored.id)) continue
      seen.add(stored.id)
      out.push({ id: stored.id, accountName: stored.accountName, source: 'vault' })
    }
    return out
  }

  /**
   * The PAT for one account id, from whichever source holds it.
   *
   * Resolving by id — rather than touching the region's selection — is what
   * lets a pool batch address every account while the user's chosen account
   * keeps serving traffic.
   */
  async credentialFor(
    accountId: string,
    sources: { settingsPat?: string | undefined, envPat?: string | undefined },
  ): Promise<QoderResolvedCredential | undefined> {
    const settingsPat = sources.settingsPat?.trim()
    if (settingsPat && qoderAccountId(settingsPat) === accountId) {
      return { id: accountId, accountName: '', source: 'settings', pat: settingsPat }
    }
    const envPat = sources.envPat?.trim()
    if (envPat && qoderAccountId(envPat) === accountId) {
      return { id: accountId, accountName: '', source: 'env', pat: envPat }
    }
    const stored = (await this.vaultAccounts()).find(account => account.id === accountId)
    return stored === undefined
      ? undefined
      : { id: stored.id, accountName: stored.accountName, source: 'vault', pat: stored.pat }
  }

  /**
   * The credential that serves traffic right now.
   *
   * `selectedId` is the user's explicit per-region choice (`''`/undefined =
   * automatic). Automatic resolution follows source priority: settings PAT,
   * then env PAT, then the first vault entry. An explicit id that resolves to
   * nothing falls back to automatic rather than stranding the region — the
   * card reports `selectionLost` so the user sees why.
   */
  async resolve(
    sources: { settingsPat?: string | undefined, envPat?: string | undefined },
    selectedId?: string,
  ): Promise<QoderResolvedCredential | undefined> {
    if (selectedId !== undefined && selectedId !== '') {
      const chosen = await this.credentialFor(selectedId, sources)
      if (chosen !== undefined) return chosen
    }
    const settingsPat = sources.settingsPat?.trim()
    if (settingsPat) return { id: qoderAccountId(settingsPat), accountName: '', source: 'settings', pat: settingsPat }
    const envPat = sources.envPat?.trim()
    if (envPat) return { id: qoderAccountId(envPat), accountName: '', source: 'env', pat: envPat }
    const first = (await this.vaultAccounts())[0]
    return first === undefined
      ? undefined
      : { id: first.id, accountName: first.accountName, source: 'vault', pat: first.pat }
  }

  /**
   * Add (or refresh) one vault entry. Keyed by the PAT-derived id: re-adding
   * the same token updates its name in place rather than duplicating it.
   */
  async add(pat: string, accountName: string): Promise<QoderStoredAccount> {
    const entry: QoderStoredAccount = {
      id: qoderAccountId(pat),
      accountName,
      pat,
      addedAtMs: Date.now(),
    }
    await this.mutate(accounts => {
      const index = accounts.findIndex(account => account.id === entry.id)
      if (index === -1) return [...accounts, entry]
      const next = [...accounts]
      next[index] = { ...next[index]!, accountName: entry.accountName, pat: entry.pat }
      return next
    })
    return entry
  }

  /**
   * Remove one vault entry. Only vault entries are removable — the settings
   * and env PATs are managed outside the plugin. Returns whether anything
   * was actually removed.
   */
  async remove(accountId: string): Promise<boolean> {
    let removed = false
    await this.mutate((accounts) => {
      const next = accounts.filter(account => account.id !== accountId)
      removed = next.length !== accounts.length
      return next
    })
    return removed
  }

  /** Backfill a display name learned later (from a jobToken exchange). */
  async rename(accountId: string, accountName: string): Promise<void> {
    if (accountName === '') return
    await this.mutate(accounts => accounts.map(account =>
      account.id === accountId && account.accountName !== accountName
        ? { ...account, accountName }
        : account,
    ))
  }

  /** Empty the vault. Used by the CLI's `logout`. */
  async clear(): Promise<void> {
    await this.mutate(() => [])
  }

  /** One locked read-modify-write of the vault document. */
  private async mutate(edit: (accounts: QoderStoredAccount[]) => QoderStoredAccount[]): Promise<void> {
    const path = qoderAccountsPath(this.region)
    await withFileLock(path, async () => {
      const accounts = edit(await this.vaultAccounts())
      const document: VaultDocument = { version: VAULT_FORMAT_VERSION, accounts }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }
}
