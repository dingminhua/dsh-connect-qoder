/**
 * Account transfer: the export / import file format shared with sibling
 * credential managers for the same upstream.
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 *   `src/transfer.ts` —— 传输文件格式（JSON 数组、snake_case 字段、去重、
 *   预览不回明文、解析不依赖文件系统、区域门放在纯函数里以便无 UI 单测）
 *   的形态整体沿用；工作清单上又是家族内各 DSH 插件的既有互操作约定。
 * 改动（按 Qoder 上游的实际能力）：
 *   1. 凭据是 PAT，不是桌面端登录文件——记录只承载 `access_token`（即
 *      PAT）、`uid`（PAT 派生的账号 id）、`nickname`、`email`、`domain`，
 *      没有 refresh_token / expiresAt 一族字段（PAT 一般无过期）；
 *   2. domain 只取两个上游区域值——`qoder.com.cn`（cn）/ `qoder.sh`
 *      （global）——区域门用白名单正匹配：值不属于目标区域的记录一律跳过，
 *      不做「当作哪个区域都行」的默认，避免跨区导入交叉计费或收进伪装域；
 *   3. 账号 id 由 PAT 单向散列派生（`credentials.ts` 的 `qoderAccountId`），
 *      合并按 id 去重、以同 id 覆盖；import 落库由 Host 侧的
 *      `QoderAccountStore.add(pat, accountName)` 完成，`nickname` → accountName。
 *
 * @module dsh-connect-qoder/transfer
 */

import { qoderAccountId } from './credentials.ts'
import type { QoderStoredAccount } from './accounts.ts'
import { QODER_REGION_TRANSFER_DOMAIN, type QoderWebRegion } from './status-paths.ts'
import type {
  QoderTransferPreview,
  QoderTransferPreviewEntry,
  QoderTransferRecord,
} from './status-paths.ts'

/**
 * Parse transfer-file text: a JSON array, every element an object.
 *
 * The error strings carry the position (1-based item number) because a file
 * from another tool can be big, and "第 N 项" is what lets the user find the
 * broken record in their editor.
 */
export function parseTransferFile(text: string): QoderTransferRecord[] {
  if (text.trim() === '') throw new Error('transfer file is empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error('transfer file is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (!Array.isArray(parsed)) throw new Error('transfer file must be a JSON array of account records')
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('transfer file item ' + (index + 1) + ' is not an account object')
    }
  }
  return parsed as QoderTransferRecord[]
}

/** One string field of a record, tolerating the sibling format's odd shapes. */
function displayString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Whether a record carries a usable token, envelope-shaped or plain. */
function hasToken(record: QoderTransferRecord): boolean {
  const token: unknown = record['access_token']
  return typeof token === 'string' && token !== ''
}

/**
 * The transfer file's desensitized preview: display fields only.
 *
 * Fields come from EXTERNAL files, so a display field may hold an object or an
 * array (a sibling tool can store the desktop app's encrypted-wrapper nickname
 * verbatim); every preview field is normalized to a string or emptied rather
 * than letting a non-renderable value reach the card.
 */
export function previewTransferFile(text: string): QoderTransferPreview {
  const records = parseTransferFile(text)
  const accounts: QoderTransferPreviewEntry[] = records.map((record, index) => ({
    index,
    uid: displayString(record['uid']),
    nickname: displayString(record['nickname']),
    email: displayString(record['email']),
    hasToken: hasToken(record),
  }))
  return { accounts, total: records.length }
}

/**
 * Project one stored vault account into the shared transfer record shape.
 *
 * `regionDomain` is the target region's login domain (`qoder.com.cn` for cn,
 * `qoder.sh` for global); the export caller passes it so the imported file
 * self-describes which region each record belongs to. `uid` is the PAT-derived
 * account id so a re-import converges on the SAME vault key. `nickname` is
 * dropped — never set to empty/undefined — when the account has no name, and
 * `access_token` carries the PAT itself.
 */
export function transferRecordOf(
  account: QoderStoredAccount,
  regionDomain: string,
): QoderTransferRecord {
  const record: QoderTransferRecord = {
    access_token: account.pat,
    uid: account.id,
    ...(account.accountName !== '' ? { nickname: account.accountName } : {}),
    domain: regionDomain,
  }
  return record
}

/**
 * Project a region's whole vault into the exported transfer document.
 *
 * This is the ONE place the export path turns vault accounts into records;
 * the `exportAccounts` dep (`index.ts`) MUST go through it. It used to be
 * written inline in `exportAccounts` as a raw `{pat, accountName, id}` map,
 * which is what produced files that could never be re-imported: the region
 * gate (`mergeTransferRecords`) reads `domain`, and the raw vault shape has
 * none. Keeping the projection here — rather than in the Host wiring — is what
 * lets a test export through it and immediately import the result.
 */
export function transferRecordsFor(
  region: QoderWebRegion,
  accounts: readonly QoderStoredAccount[],
): QoderTransferRecord[] {
  const domain = QODER_REGION_TRANSFER_DOMAIN[region]
  return accounts.map(account => transferRecordOf(account, domain))
}

/**
 * Positive-match a record's login domain to a region.
 *
 * Distinct from any upstream-side registry: `domain` is whatever the FILE'S
 * author wrote, so only an exactly-known Qoder domain counts. `qoder.com.cn`
 * and `qoder.sh` are the plugin's two per-region domains; an empty, misspelled,
 * spoofed, or registrable-domain-lookalike value classifies as undecidable and
 * is refused rather than being filed under either region.
 */
function knownRegionOfDomain(domain: string | undefined): QoderWebRegion | undefined {
  if (domain === 'qoder.com.cn') return 'cn'
  if (domain === 'qoder.sh') return 'global'
  return undefined
}

/**
 * Pure merge: fold the selected records of a transfer file into a CHANGES map.
 *
 * Mirrors the sibling merger's contract: a record with the same account id
 * OVERWRITES the stored entry (the imported PAT replaces what is stored —
 * re-importing a rotated PAT must refresh it; the write layer stores the record
 * atomically, so "overwrite" needs no knowledge of the incumbent), and a
 * record without a token is skipped. The region gate lives HERE rather than in
 * the route so it is testable without a Host: a record whose login domain maps
 * to the other region's tab is skipped, because the two regions' providers are
 * parallel stacks and a cross-region import would cross-bill.
 *
 * The caller persists each map entry via `QoderAccountStore.add`; an importing
 * selection that is already stored rewrites those entries with identical
 * content — idempotent, and the steady state of importing the same file twice.
 */
export function mergeTransferRecords(
  region: QoderWebRegion,
  text: string,
  indexes: readonly number[],
): { changes: Map<string, { pat: string, accountName: string }>, imported: number, skipped: number } {
  const records = parseTransferFile(text)
  const changes = new Map<string, { pat: string, accountName: string }>()
  let imported = 0
  let skipped = 0
  for (const index of indexes) {
    const record = records[index]
    if (record === undefined) {
      skipped += 1
      continue
    }
    const accessToken = record['access_token']
    if (typeof accessToken !== 'string' || accessToken === '') {
      skipped += 1
      continue
    }
    // Region gate: the record's OWN domain decides, and the decision must be
    // a POSITIVE match. An empty, unrecognised, or provably other region's
    // domain is skipped, so a rejected import reports `skipped` instead of
    // pretending to have stored a foreign credential.
    if (knownRegionOfDomain(record['domain']) !== region) {
      skipped += 1
      continue
    }
    const id = qoderAccountId(accessToken)
    changes.set(id, { pat: accessToken, accountName: displayString(record['nickname']) })
    imported += 1
  }
  return { changes, imported, skipped }
}