/**
 * Verified writes of the per-region account / settings slots.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 写入后回读并与写入值比对的验证形态、Host 端点优先再回填浏览器镜像的顺序、
 *     file-contention 诊断，均沿用自该项目的 `account-selection.ts`。
 *
 * Qoder 差异（按 `src/index.ts` 的 settings 契约）：
 *   1. 账号选择不在顶层 `accounts` 字段，而是 `regions.<region>.accountId`（'' =
 *      自动：settings → env → vault）；PAT 凭据由 Host 的 vault 保存。所以本模块
 *      只写 `regions` 这一字段，每个写入都带整个区域槽。
 *   2. `__save` 端点只接受 `field: 'regions'`（Host 侧 `mutateField` 做两层合并），
 *      因此这里没有 workbuddy 的 `'accounts'` 分支。
 *
 * Kept out of `QoderCard.tsx` — and free of any browser-only import — so the
 * write contract stays unit-testable without a DOM.
 *
 * @module dsh-connect-qoder/client/account-selection
 */

import {
  nextRegionModels,
  nextRegionPool,
  QODER_SAVE_PATH,
  unwrapVolatileDeep,
} from '../status-paths.ts'
import type { QoderCreditPosition, QoderWebRegion } from '../status-paths.ts'

/**
 * The slice of the bound settings scope this module writes through.
 */
export interface QoderAccountScope {
  getSnapshot(): { value?: unknown }
  /**
   * Whether the Host accepted the write. `false` means refused (not rejected);
   * `undefined`/`void` (an older scope) counts as accepted.
   */
  set(field: string, value: unknown): Promise<boolean | void>
}

/** A settings write that did not take effect. */
export class QoderSettingsWriteError extends Error {
  /** The settings field that did not land. */
  readonly field: string

  constructor(field: string, reason?: string) {
    super(`qoder: settings field "${field}" was not persisted by the settings write${reason === undefined ? '' : `: ${reason}`}`)
    this.name = 'QoderSettingsWriteError'
    this.field = field
  }
}

/**
 * Whether a save failure is a FILE-CONTENTION refusal.
 */
export function isFileContentionWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:EPERM|EBUSY|EACCES)\b/u.test(message)
}

/**
 * Read one settings field's current object value from the scope snapshot
 * (a volatile `regions` field is a `{get()}` live reference — unwrap first).
 */
function fieldSnapshotOf(
  scope: QoderAccountScope,
  field: 'regions',
): Record<string, unknown> {
  const value = unwrapVolatileDeep(
    (scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field],
  )
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Fallback write: POST `${field: 'regions', value: { [region]: slot }}` to the
 * plugin's own Host endpoint. The host's `mutateField` merges the posted region
 * into the authoritative value, preserving the sibling region and slot fields.
 */
async function saveViaHostEndpoint(
  field: 'regions',
  region: QoderWebRegion,
  value: unknown,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(QODER_SAVE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ field, value: { [region]: value } }),
    })
  } catch (error) {
    throw new QoderSettingsWriteError(field, `Host save endpoint unreachable: ${String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as { errorName?: string, error?: string }
    const reason = `${String(detail.errorName ?? '')} ${String(detail.error ?? '')}`.trim()
    throw new QoderSettingsWriteError(field, `Host save refused: ${reason === '' ? String(detail.error) : reason}`)
  }
}

/**
 * Write one volatile field, then confirm the value actually landed.
 *
 * The Host endpoint goes FIRST — it is the only writer that cannot delete a
 * sibling region. `scope.set` is then attempted purely to refresh the mirror,
 * and only when it alone both delivers AND lands is the write considered done
 * without the endpoint.
 *
 * @throws {QoderSettingsWriteError} when neither path persists the value.
 */
async function writeField(
  scope: QoderAccountScope,
  field: 'regions',
  region: QoderWebRegion,
  value: unknown,
  landed: (readBack: unknown) => boolean,
): Promise<void> {
  // 1. Authoritative, server-side merge: cannot drop the sibling region.
  let hostError: unknown
  try {
    await saveViaHostEndpoint(field, region, value)
    return
  } catch (error) {
    hostError = error
  }

  // 2. Endpoint unavailable/refused (older Host, or route not mounted): fall
  //    back to the scope, and verify the value really landed.
  let scopeDelivered = false
  try {
    scopeDelivered = (await scope.set(field, {
      ...fieldSnapshotOf(scope, field),
      [region]: value,
    })) !== false
  } catch {
    scopeDelivered = false
  }
  if (scopeDelivered && landed(fieldSnapshotOf(scope, field)[region])) return
  throw hostError instanceof Error
    ? hostError
    : new QoderSettingsWriteError(field, 'neither the Host save endpoint nor the settings scope persisted the value')
}

/**
 * Write one region's account selection, then confirm it actually landed.
 *
 * `accountId` of `''` means auto (settings → env → vault). Verification is
 * exact, because `undefined` (slot absent) and `''` (slot cleared) are different
 * states with different meanings, and only the second is a successful clear.
 */
export async function writeAccountSlot(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  value: string,
): Promise<void> {
  await writeField(scope, 'regions', region,
    { ...regionSlotOf(scope.getSnapshot().value, region), accountId: value },
    readBack => (readBack as Record<string, unknown> | null | undefined)?.['accountId'] === value)
}

/**
 * Write one region's saved model state, then confirm it actually landed.
 */
export async function writeRegionModels(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  payload: { lastCatalog: readonly { key: string }[] } & Record<string, unknown>,
): Promise<void> {
  const merged = nextRegionModels(scope.getSnapshot().value, region, payload)
  const next = merged[region] as Record<string, unknown>
  const written = payload.lastCatalog.map(model => model.key)
  await writeField(scope, 'regions', region, next, readBack => {
    const stored = (readBack as { lastCatalog?: { key?: string }[] } | undefined)?.lastCatalog?.map(model => model.key)
    return stored !== undefined
      && stored.length === written.length
      && stored.every((key, index) => key === written[index])
  })
}

/**
 * Switch one region's provider off or on, with the same landed-check.
 */
export async function writeRegionEnabled(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  enabled: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['enabled'] === enabled
  })
}

/**
 * Show or hide one region's composer credit line, with the same landed-check.
 */
export async function writeRegionCreditsShown(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  shown: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['showCreditsInMainUi'] === shown
  })
}

/**
 * Write one region's credit-readout SEAT, with the same landed-check.
 *
 * The read-back check matters for the same measured reason it does for the
 * switch: the settings mirror can silently drop a write, and a control that
 * keeps showing the old seat is worse than one that reports failure.
 */
export async function writeRegionCreditPosition(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  position: QoderCreditPosition,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['creditPosition'] === position
  })
}

/**
 * Write one region's account-pool PREFERENCES, verifying they landed.
 */
export async function writePoolPreferences(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  preferences: {
    enabled: boolean
    targetModelId: string
    probeInputTokens?: number
    memberAccountIds: readonly string[]
  },
): Promise<void> {
  const slot: Record<string, unknown> = {
    enabled: preferences.enabled,
    targetModelId: preferences.targetModelId,
    memberAccountIds: preferences.memberAccountIds,
  }
  if (preferences.probeInputTokens !== undefined) {
    slot['probeInputTokens'] = preferences.probeInputTokens
  }
  const merged = nextRegionPool(scope.getSnapshot().value, region, slot)
  const next = merged[region] as Record<string, unknown>
  await writeField(scope, 'regions', region, next, readBack => {
    const pool = (readBack as { pool?: Record<string, unknown> } | null | undefined)?.pool
    if (pool === undefined || pool === null) return false
    if (pool['enabled'] !== preferences.enabled
      || pool['targetModelId'] !== preferences.targetModelId) {
      return false
    }
    const wantedTokens = preferences.probeInputTokens ?? 0
    const storedTokens = pool['probeInputTokens'] ?? 0
    if (storedTokens !== wantedTokens) return false
    const stored = pool['memberAccountIds']
    if (!Array.isArray(stored) || stored.length !== preferences.memberAccountIds.length) return false
    const wanted = new Set(preferences.memberAccountIds)
    return stored.every(id => typeof id === 'string' && wanted.has(id))
  })
}

/** One region's stored slot as a plain object (node-free source of truth). */
function regionSlotOf(value: unknown, region: QoderWebRegion): Record<string, unknown> {
  const unwrapped = unwrapVolatileDeep(value)
  const regions = typeof unwrapped === 'object' && unwrapped !== null && !Array.isArray(unwrapped)
    ? (unwrapped as Record<string, unknown>)['regions']
    : undefined
  const map = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  const slot = map[region]
  return typeof slot === 'object' && slot !== null && !Array.isArray(slot)
    ? slot as Record<string, unknown>
    : {}
}

/**
 * Read the current (non-settings) account source state. Qoder keeps PAT-based
 * vault entries; this returns the stored region slot's `pat`/`accountId` so the
 * card can render the settings-PAT and the chosen account faithfully.
 */
export function regionConfigOf(value: unknown, region: QoderWebRegion): {
  pat?: string | undefined
  accountId?: string | undefined
  enabledModelKeys: readonly string[]
  offModelKeys: readonly string[]
  contextBudgets: Readonly<Record<string, number>>
} {
  const slot = regionSlotOf(value, region)
  return {
    ...(typeof slot['pat'] === 'string' ? { pat: slot['pat'] } : {}),
    ...(typeof slot['accountId'] === 'string' ? { accountId: slot['accountId'] } : {}),
    enabledModelKeys: Array.isArray(slot['enabledModelKeys'])
      ? (slot['enabledModelKeys'] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
    offModelKeys: Array.isArray(slot['offModelKeys'])
      ? (slot['offModelKeys'] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
    contextBudgets: typeof slot['contextBudgets'] === 'object' && slot['contextBudgets'] !== null
      ? slot['contextBudgets'] as Record<string, number>
      : {},
  }
}

/** The saved region PAT, or undefined when none is stored. */
export function storedPatOf(value: unknown, region: QoderWebRegion): string | undefined {
  const pat = regionSlotOf(value, region)['pat']
  return typeof pat === 'string' && pat !== '' ? pat : undefined
}