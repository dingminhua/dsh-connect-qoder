/**
 * Qoder 账号保险库与账号解析：QoderAccountStore + sources 优先级 + 0600 权限。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/transfer-vault.spec.ts` / `tests/vault-file-filter.spec.ts` /
 *   相关 auth 测试 —— 凭据文档的 withFileLock + writeFileAtomic + `0o600`
 *   约定、读取永不抛异常的语义、以及「账号列表与选中分离」沿用。但 Qoder 的
 *   来源是 settings PAT / 环境变量 / 本插件保险库三种，而非桌面登录文件。
 *
 * 断言重点：add/remove/rename/clear 的落盘与去重、accounts() 的
 * settings>env>vault 去重优先级、resolve() 的自动回退与 selectionLost、
 * credentialFor() 按 id 取 PAT 且不改选中、以及 0600 文件权限。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QoderAccountStore, qoderAccountsPath } from '../src/accounts.ts'
import { qoderAccountId } from '../src/credentials.ts'

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'qoder-accounts-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

const store = (region: 'cn' | 'global' = 'cn') => new QoderAccountStore(region)

describe('qoderAccountsPath + file permissions', () => {
  it('keys the vault file by region and writes mode 0600', async () => {
    expect(qoderAccountsPath('cn')).not.toBe(qoderAccountsPath('global'))
    expect(qoderAccountsPath('cn')).toContain('.qoder-accounts.cn.json')
    await store('cn').add('pt-12345678abcdef', 'Alpha')
    const perms = (await stat(qoderAccountsPath('cn'))).mode & 0o777
    // 0600: owner read/write only. 目录项上 0o777 也可能带 0700 的 dirMode，
    // 文件本身必须 0600。
    expect(perms).toBe(0o600)
  })
})

describe('vaultAccounts', () => {
  it('reads nothing for a missing or malformed vault', async () => {
    expect(await store().vaultAccounts()).toEqual([])
    // 直接写坏文件：不抛异常，读成空。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(qoderAccountsPath('cn'), '{ not json', 'utf8')
    expect(await store().vaultAccounts()).toEqual([])
  })

  it('ignores a document from an unknown format version', async () => {
    await store().add('pt-11111111aaaaaaaa', 'Alpha')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      qoderAccountsPath('cn'),
      JSON.stringify({ version: 99, accounts: [] }),
      'utf8',
    )
    expect(await store().vaultAccounts()).toEqual([])
  })

  it('filters malformed per-row entries without discarding the good ones', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      qoderAccountsPath('cn'),
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'pat-aaaaaaaaaaaaaaaa', pat: 'pt-x', accountName: 'Alpha', addedAtMs: 1 },
          { id: '', pat: 'pt-y', accountName: 'Beta', addedAtMs: 1 },   // id 为空 → 丢弃
          { id: 'pat-bbbbbbbbbbbbbbbb', pat: '', accountName: '', addedAtMs: 1 },  // pat 为空 → 丢弃
          'nonsense',
        ],
      }),
      'utf8',
    )
    const accounts = await store().vaultAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.accountName).toBe('Alpha')
  })
})

describe('add / remove / rename / clear', () => {
  it('adds a vault entry and returns the stored account', async () => {
    const stored = await store().add('pt-some-secret-value', 'Alpha')
    expect(stored.id).toBe(qoderAccountId('pt-some-secret-value'))
    expect(stored.accountName).toBe('Alpha')
    expect(stored.addedAtMs).toBeGreaterThan(0)
    expect(stored.pat).toBe('pt-some-secret-value')
    expect(await store().vaultAccounts()).toHaveLength(1)
  })

  it('re-adding the same PAT refreshes its name in place instead of duplicating it', async () => {
    const s = store()
    await s.add('pt-same-token-12345678', 'First')
    const updated = await s.add('pt-same-token-12345678', 'Renamed')
    expect(await s.vaultAccounts()).toHaveLength(1)
    expect((await s.vaultAccounts())[0]?.accountName).toBe('Renamed')
    expect(updated.accountName).toBe('Renamed')
  })

  it('keeps two different PATs as two vault entries', async () => {
    const s = store()
    await s.add('pt-one-aaaaaaaaaaaa', 'A')
    await s.add('pt-two-bbbbbbbbbbbb', 'B')
    expect(await s.vaultAccounts()).toHaveLength(2)
  })

  it('removes one vault entry and reports whether anything was removed', async () => {
    const s = store()
    await s.add('pt-one-aaaaaaaaaaaa', 'A')
    await s.add('pt-two-bbbbbbbbbbbb', 'B')
    const removed = await s.remove(qoderAccountId('pt-one-aaaaaaaaaaaa'))
    expect(removed).toBe(true)
    expect((await s.vaultAccounts()).map(a => a.accountName)).toEqual(['B'])
    expect(await s.remove(qoderAccountId('pt-one-aaaaaaaaaaaa'))).toBe(false)
  })

  it('rename backfills a display name learned later', async () => {
    const s = store()
    const st = await s.add('pt-one-aaaaaaaaaaaa', '')
    await s.rename(st.id, 'Learned Name')
    expect((await s.vaultAccounts())[0]?.accountName).toBe('Learned Name')
    // 空名字 no-op。
    await s.rename(st.id, '')
    expect((await s.vaultAccounts())[0]?.accountName).toBe('Learned Name')
  })

  it('clear empties the vault', async () => {
    const s = store()
    await s.add('pt-one-aaaaaaaaaaaa', 'A')
    await s.clear()
    expect(await s.vaultAccounts()).toEqual([])
  })
})

describe('accounts (settings > env > vault, dedup by PAT-derived id)', () => {
  it('merges all three sources, deduplicating an identical PAT to the higher source', async () => {
    const s = store()
    await s.add('pt-vault-secret-1111', 'VaultNamed')
    // settings 与 vault 同 PAT：只列 settings，且不重复 vault 那条。
    const entries = await s.accounts({ settingsPat: 'pt-vault-secret-1111' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ source: 'settings', accountName: '' })
  })

  it('orders settings first, then env, then vault', async () => {
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'VaultA')
    await s.add('pt-vault-bbbbbbbbbbbb', 'VaultB')
    const entries = await s.accounts({ settingsPat: 'pt-settings-cc', envPat: 'pt-env-dd' })
    expect(entries.map(e => e.source)).toEqual(['settings', 'env', 'vault', 'vault'])
    expect(entries[0]?.source).toBe('settings')
    expect(entries[1]?.source).toBe('env')
  })

  it('drops a duplicate PAT appearing in both env and vault', async () => {
    const s = store()
    await s.add('pt-dupe-effect-env', 'Vault')
    const entries = await s.accounts({ envPat: 'pt-dupe-effect-env' })
    expect(entries.map(e => e.source)).toEqual(['env'])
    // 同名 PAT 出现两次（settings + env）只列一次；vault 里那条不同的仍保留。
    const again = await s.accounts({ settingsPat: 'pt-x-111', envPat: 'pt-x-111' })
    expect(again.map(e => e.source)).toEqual(['settings', 'vault'])
  })

  it('carries the vault display name only for vault-sourced rows', async () => {
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'Named')
    const entries = await s.accounts({ settingsPat: 'pt-settings-cc' })
    const named = entries.find(e => e.source === 'vault')
    expect(named?.accountName).toBe('Named')
  })
})

describe('credentialFor (by id, never changes the selection)', () => {
  it('resolves the settings PAT when its id matches', async () => {
    const pat = 'pt-settings-value-1'
    const cred = await store().credentialFor(qoderAccountId(pat), { settingsPat: pat })
    expect(cred).toEqual({ id: qoderAccountId(pat), accountName: '', source: 'settings', pat })
  })

  it('resolves the env PAT when its id matches', async () => {
    const pat = 'pt-env-value-2'
    const cred = await store().credentialFor(qoderAccountId(pat), { envPat: pat })
    expect(cred).toMatchObject({ source: 'env', pat })
  })

  it('falls back to the vault for a stored id', async () => {
    const s = store()
    await s.add('pt-vault-value-3', 'VaultName')
    const id = qoderAccountId('pt-vault-value-3')
    const cred = await s.credentialFor(id, {})
    expect(cred).toMatchObject({ source: 'vault', accountName: 'VaultName', pat: 'pt-vault-value-3' })
  })

  it('returns undefined for an unknown id', async () => {
    expect(await store().credentialFor('pat-0000000000000000', {})).toBeUndefined()
  })
})

describe('resolve (serving credential + selection lost)', () => {
  it('follows the explicit selection when it resolves', async () => {
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'Vault')
    const pat = 'pt-settings-value'
    const cred = await s.resolve({ settingsPat: pat }, qoderAccountId(pat))
    expect(cred?.source).toBe('settings')
    expect(cred?.pat).toBe(pat)
  })

  it('falls back to automatic when the explicit selection resolves to nothing (selectionLost)', async () => {
    // 显式 id 无效 → 回退到默认（settings > env > vault 首条），而不是让区域
    // 断流。调用方拿 accounts 与 selectedId 判断 selectionLost。
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'Primary')
    const cred = await s.resolve({}, 'pat-deadbeefdeadbeef')
    expect(cred?.id).toBe(qoderAccountId('pt-vault-aaaaaaaaaaaa'))
    expect(cred?.source).toBe('vault')
  })

  it('resolves settings PAT before env PAT before the first vault entry', async () => {
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'Primary')
    await s.add('pt-vault-bbbbbbbbbbbb', 'Secondary')
    expect((await s.resolve({ settingsPat: 'pt-settings-cc', envPat: 'pt-env-dd' }, undefined))?.source)
      .toBe('settings')
    expect((await s.resolve({ envPat: 'pt-env-dd' }, undefined))?.source)
      .toBe('env')
    expect((await s.resolve({}, undefined))?.accountName).toBe('Primary')
  })

  it('returns undefined when nothing resolves at all', async () => {
    expect(await store().resolve({}, undefined)).toBeUndefined()
    expect(await store().resolve({}, '')).toBeUndefined()
  })

  it('treats an empty/undefined explicit selection as automatic', async () => {
    const s = store()
    await s.add('pt-vault-aaaaaaaaaaaa', 'Primary')
    expect((await s.resolve({}, ''))?.source).toBe('vault')
    expect((await s.resolve({}, undefined))?.source).toBe('vault')
  })
})