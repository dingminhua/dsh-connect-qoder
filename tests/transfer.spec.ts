/**
 * Qoder 账号传输：parseTransferFile / previewTransferFile / transferRecordOf /
 * mergeTransferRecords（含区域域正匹配门）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/transfer.spec.ts` —— JSON 数组 + snake_case 字段 + uid 键合并 +
 *   预览不回明文的格式沿用。但 Qoder 的凭据是 PAT 不是桌面登录：
 *   - 记录只承载 access_token / uid / nickname / email / domain，没有
 *     refresh_token / expiresAt 一族；
 *   - id 由 PAT 单向派生（`qoderAccountId`），合并按 id 覆盖；
 *   - 区域门是**白名单正匹配**：只有 `qoder.com.cn`（cn）/ `qoder.sh`（global）
 *     被接收，空/拼错/伪装的域一律跳过，不做「当作哪个区域都行」的默认。
 *
 * 断言重点：解析错误定位、预览脱敏归一、transferRecordOf 的导出形状、
 * merge 的覆盖/跳过统计、以及区域正匹配门拒绝跨区与未知域。
 */

import { describe, expect, it } from 'vitest'
import {
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  transferRecordOf,
  transferRecordsFor,
} from '../src/transfer.ts'
import { qoderAccountId } from '../src/credentials.ts'
import type { QoderStoredAccount } from '../src/accounts.ts'

/** A sibling-format record, keyed snake_case with the Qoder subset. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'pt-12345678-abcdef',  // PAT 本身
    uid: 'u-1',
    nickname: '小明',
    email: 'a@b.c',
    domain: 'qoder.com.cn',
    ...overrides,
  }
}

/** A vault-shaped stored account for export tests. */
function vaultAccount(overrides: Partial<QoderStoredAccount> = {}): QoderStoredAccount {
  return {
    id: qoderAccountId('pt-vault-token-1'),
    accountName: '阿九',
    pat: 'pt-vault-token-1',
    addedAtMs: 1_800_000_000_000,
    ...overrides,
  }
}

describe('parseTransferFile', () => {
  it('accepts a JSON array of objects and rejects everything else with a positioned error', () => {
    expect(parseTransferFile(JSON.stringify([record(), record({ uid: 'u-2' })]))).toHaveLength(2)
    expect(() => parseTransferFile('')).toThrow('empty')
    expect(() => parseTransferFile('not json')).toThrow('JSON')
    expect(() => parseTransferFile('{"a":1}')).toThrow('array')
    expect(() => parseTransferFile('[{"uid":"u1"},42]')).toThrow('item 2')
  })
})

describe('previewTransferFile', () => {
  it('exposes only desensitized fields plus hasToken, normalizing dirty display values', () => {
    const dirty = JSON.stringify([
      { uid: { nested: true }, nickname: { zh: '信封昵称' }, email: ['a@b.c'], access_token: 'tok' },
      { uid: 'u-2', nickname: 12345, email: 'x@y.z' },
    ])
    const preview = previewTransferFile(dirty)
    expect(preview.total).toBe(2)
    const [first, second] = preview.accounts
    expect(first?.hasToken).toBe(true)
    expect(first?.uid).toBe('')
    expect(first?.nickname).toBe('')
    expect(second?.hasToken).toBe(false)
    // 数字昵称是合法数据：转成字符串，而非丢弃。
    expect(second?.nickname).toBe('12345')
  })

  it('never returns raw token material in the preview', () => {
    const preview = previewTransferFile(JSON.stringify([record({ access_token: 'pt-secret-value' })]))
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('pt-secret-value')
    expect(preview.accounts[0]?.hasToken).toBe(true)
  })
})

describe('transferRecordOf (export shape)', () => {
  it('emits snake_case fields with the PAT as access_token', () => {
    const rec = transferRecordOf(vaultAccount(), 'qoder.com.cn')
    expect(rec.access_token).toBe('pt-vault-token-1')
    expect(rec.uid).toBe(qoderAccountId('pt-vault-token-1'))
    expect(rec.nickname).toBe('阿九')
    expect(rec.domain).toBe('qoder.com.cn')
  })

  it('omits nickname when the account has no name, and omits expiresAt for a PAT', () => {
    const rec = transferRecordOf(vaultAccount({ accountName: '' }), 'qoder.sh')
    expect(RecHasKey(rec, 'nickname')).toBe(false)
    // PAT 一般无过期：家族字段 `expiresAt` 不应被编造出来。
    expect(RecHasKey(rec, 'expiresAt')).toBe(false)
    expect(rec.domain).toBe('qoder.sh')
  })

  it('sets the region domain from the caller so the imported record self-describes', () => {
    expect(transferRecordOf(vaultAccount(), 'qoder.com.cn').domain).toBe('qoder.com.cn')
    expect(transferRecordOf(vaultAccount(), 'qoder.sh').domain).toBe('qoder.sh')
  })
})

describe('mergeTransferRecords (region domain positive-match gate)', () => {
  it('admits a record whose domain positively matches the addressed region', () => {
    const merged = mergeTransferRecords('cn', JSON.stringify([record()]), [0])
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    const entry = [...merged.changes.values()][0]
    expect(entry?.pat).toBe('pt-12345678-abcdef')
    expect(entry?.accountName).toBe('小明')
  })

  it('keys the changes map by the PAT-derived account id', () => {
    const merged = mergeTransferRecords('cn', JSON.stringify([record()]), [0])
    expect([...merged.changes.keys()]).toEqual([qoderAccountId('pt-12345678-abcdef')])
  })

  it('overwrites a record with the same id, counting both imports', () => {
    // 同一个 PAT 出现在两条记录里（如轮换后的同 token 重复导出）：按 id 合并，
    // 后者覆盖前者，两条都计为 imported。
    const text = JSON.stringify([
      record({ nickname: 'old-name', access_token: 'pt-same-token-value' }),
      record({ nickname: 'new-name', access_token: 'pt-same-token-value' }),
    ])
    const merged = mergeTransferRecords('cn', text, [0, 1])
    expect(merged.imported).toBe(2)
    expect(merged.changes.size).toBe(1)
    expect([...merged.changes.values()][0]?.accountName).toBe('new-name')
  })

  it('skips token-less records, bad indexes, and the OTHER region\'s records', () => {
    const text = JSON.stringify([
      record({ access_token: '' }),
      record({ domain: 'qoder.sh' }),       // 其他区域的记录
      record({ uid: 'u-3', access_token: 'pt-third' }),
    ])
    const merged = mergeTransferRecords('cn', text, [0, 1, 2, 9])
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(3)
    expect([...merged.changes.keys()]).toEqual([qoderAccountId('pt-third')])
  })

  it('skips a record whose domain cannot be positively classified', () => {
    // 门必须 fail-closed：domain 来自别人给的文件，「未知」就是「无法归类」，把它
    // 当 cn 导入会把外部或伪装的凭据塞进 cn 保险库。
    for (const domain of ['', 'qoder.com.cn.evil.com', 'notqoder.sh', 'example.com']) {
      const merged = mergeTransferRecords('cn', JSON.stringify([record({ domain })]), [0])
      expect(merged.imported, `domain ${JSON.stringify(domain)} must not be admitted to cn`).toBe(0)
      expect(merged.skipped).toBe(1)
    }
  })

  it('admits a positively classified record in its own region only', () => {
    const cn = mergeTransferRecords('cn', JSON.stringify([record({ domain: 'qoder.com.cn' })]), [0])
    expect(cn.imported).toBe(1)
    const global = mergeTransferRecords('global', JSON.stringify([record({ domain: 'qoder.sh' })]), [0])
    expect(global.imported).toBe(1)
    // 同一文件导入到另一区域：全部跳过。
    const crossCn = mergeTransferRecords('global', JSON.stringify([record({ domain: 'qoder.com.cn' })]), [0])
    expect(crossCn.imported).toBe(0)
    expect(crossCn.skipped).toBe(1)
  })

  it('skips a record whose domain is the EMPTY string rather than guessing a region', () => {
    const merged = mergeTransferRecords('global', JSON.stringify([record({ domain: undefined })]), [0])
    expect(merged.imported).toBe(0)
    expect(merged.skipped).toBe(1)
  })
})

/**
 * **往返回归**：导出 → 原样喂回导入。
 *
 * 这两个函数各自测过都正常，但没人把真实的导出路径接到导入路径上，于是
 * `exportAccounts`（index.ts）长期直接吐 vault 内部字段 `{pat, accountName, id}`
 * —— 既不调用 transferRecordOf，也就没有 `domain`、字段名也不是 snake_case。
 * 后果是用户导出的文件再导入时**全判 skipped（0 条成功）**，功能等于不可用，
 * 而两侧的单元测试一直是绿的。
 *
 * 这里固定住这条接缝：导出物必须原样导得回来，且导回自己那一侧、导不到另一侧。
 */
describe('export → import round trip', () => {
  /**
   * 走**真实的导出投影**（`index.ts` 的 exportAccounts 也调这一个），而不是在
   * 测试里另写一份形状。上一版曾在这里直接调 `transferRecordOf`，结果把 bug 还原
   * 后测试仍然全绿 —— 又是「两半各自对、接缝没人测」。共享这个函数正是为了
   * 让接缝有唯一入口。
   */
  function exportedFileFor(region: 'cn' | 'global', accounts: readonly QoderStoredAccount[]): string {
    return JSON.stringify(transferRecordsFor(region, accounts), null, 2)
  }

  it('round-trips a CN account back into CN', () => {
    const account = vaultAccount({ accountName: '阿九' })
    const file = exportedFileFor('cn', [account])
    const merged = mergeTransferRecords('cn', file, [0])
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    expect(merged.changes.get(account.id)).toEqual({ pat: account.pat, accountName: account.accountName })
  })

  it('round-trips a GLOBAL account back into global', () => {
    const account = vaultAccount({ pat: 'pt-global-token-9', id: qoderAccountId('pt-global-token-9'), accountName: 'Nine' })
    const file = exportedFileFor('global', [account])
    const merged = mergeTransferRecords('global', file, [0])
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    expect(merged.changes.get(account.id)).toEqual({ pat: account.pat, accountName: account.accountName })
  })

  it('gets the region domain right per region, so a record cannot cross regions', () => {
    const account = vaultAccount()
    const cnFile = exportedFileFor('cn', [account])
    const globalFile = exportedFileFor('global', [account])
    // 各自导回自己
    expect(mergeTransferRecords('cn', cnFile, [0]).imported).toBe(1)
    expect(mergeTransferRecords('global', globalFile, [0]).imported).toBe(1)
    // 交叉导入一律跳过
    expect(mergeTransferRecords('global', cnFile, [0]).skipped).toBe(1)
    expect(mergeTransferRecords('cn', globalFile, [0]).skipped).toBe(1)
  })

  it('an export carrying the raw vault shape would NOT round-trip (the old bug)', () => {
    // 这正是 exportAccounts 过去吐出的形状：没有 domain、字段名也不是 snake_case。
    const legacy = JSON.stringify([{ pat: 'pt-vault-token-1', accountName: '阿九', id: qoderAccountId('pt-vault-token-1') }])
    const merged = mergeTransferRecords('cn', legacy, [0])
    expect(merged.imported).toBe(0)
    expect(merged.skipped).toBe(1)
  })
})

/** Whether a record object carries the key (the type is optional-keyed). */
function RecHasKey(rec: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key)
}