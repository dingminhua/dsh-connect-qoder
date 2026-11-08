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
  QODER_POLL_MINUTES_FIELD,
  QODER_SIDEBAR_PANEL_FIELD,
  pollMinutesOf,
  sidebarPanelEnabledOf,
  unwrapVolatileDeep,
} from '../status-paths.ts'
import type { QoderCreditPosition, QoderPollMinutes, QoderWebRegion } from '../status-paths.ts'

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
 * 把一个**顶层**字段写到宿主的保存端点（没有区域轴，所以 body 直接是那个值）。
 *
 * `regions` 走 `{ [region]: value }`，因为它是按区域槽位合并的；顶层标量
 * （`sidebarPanel`）没有兄弟槽要保护，整份就是它自己的新值 —— 与 workbuddy
 * 的 `__save` 对顶层开关的处理一致（`region === undefined` 时 body 直接是值）。
 */
async function saveTopLevelViaHostEndpoint(field: string, value: unknown): Promise<Record<string, unknown> | undefined> {
  let response: Response
  try {
    response = await fetch(QODER_SAVE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ field, value }),
    })
  } catch (error) {
    throw new QoderSettingsWriteError(field, `Host save endpoint unreachable: ${String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as { errorName?: string, error?: string }
    const reason = `${String(detail.errorName ?? '')} ${String(detail.error ?? '')}`.trim()
    throw new QoderSettingsWriteError(field, `Host save refused: ${reason === '' ? String(detail.error) : reason}`)
  }
  // 端点的答案是它真正存下的那份值（或 `{ok:true}`）。返回给调用方去镜像
  // **真值**，而不是拿自己那份可能已经过期的镜像再推导一遍。
  const answer = await response.json().catch(() => undefined) as { value?: Record<string, unknown> } | undefined
  return answer?.value
}

/**
 * 写侧：全局的自动刷新间隔（分钟）。
 *
 * 与 {@link writeSidebarPanelEnabled} 逐字同形的顶层标量写入：宿主保存端点优先
 * （权威合并、自己报告拒绝），settings 作用域次之。落地校验读的是**解包后**的值
 * 与目标相等 —— 这个字段是枚举，写进去一个不在五档里的值等于没写。
 *
 * @throws {QoderSettingsWriteError} 两个写者都没能持久化时。
 */
export async function writePollMinutes(
  scope: QoderAccountScope,
  minutes: QoderPollMinutes,
): Promise<void> {
  const field = QODER_POLL_MINUTES_FIELD
  let hostError: unknown
  try {
    const authoritative = await saveTopLevelViaHostEndpoint(field, minutes)
    if (authoritative !== undefined) {
      try { await scope.set(field, authoritative[field]) } catch { /* 可选 */ }
    }
    return
  } catch (error) {
    hostError = error
  }
  let delivered = false
  try {
    delivered = (await scope.set(field, minutes)) !== false
  } catch {
    delivered = false
  }
  if (delivered && pollMinutesOf(scope.getSnapshot().value) === minutes) return
  throw hostError instanceof Error
    ? hostError
    : new QoderSettingsWriteError(field, 'neither the Host save endpoint nor the settings scope persisted the value')
}

/**
 * 写侧：打开 / 关闭侧边栏面板，并验证它真的落地了。
 *
 * 写者顺序与 {@link writeField} 相同、理由也相同：宿主端点优先（它是权威合并，
 * 且自己会报告拒绝），settings 作用域次之（这个命名空间的浏览器镜像在受影响的
 * 0.1.7 部署上被记录为陈旧 —— 一行「看起来在、Host 却不这么认为」的侧边栏
 * 比没有这一行更糟）。
 *
 * 这是一个顶层标量，所以写在自己那条路径上；字段里没有兄弟状态要保留。
 *
 * @throws {QoderSettingsWriteError} 两个写者都没能持久化时。
 */
export async function writeSidebarPanelEnabled(
  scope: QoderAccountScope,
  enabled: boolean,
): Promise<void> {
  const field = QODER_SIDEBAR_PANEL_FIELD
  let hostError: unknown
  try {
    const authoritative = await saveTopLevelViaHostEndpoint(field, enabled)
    if (authoritative !== undefined) {
      // 镜像 Host 存下的值，绝不拿客户端自己重新合并一遍。
      try { await scope.set(field, authoritative[field]) } catch { /* 可选 */ }
    }
    return
  } catch (error) {
    hostError = error
  }
  let delivered = false
  try {
    delivered = (await scope.set(field, enabled)) !== false
  } catch {
    delivered = false
  }
  if (delivered && sidebarPanelEnabledOf(scope.getSnapshot().value)) return
  throw hostError instanceof Error
    ? hostError
    : new QoderSettingsWriteError(field, 'neither the Host save endpoint nor the settings scope persisted the value')
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
 * Write one region's campaign-feed switch, with the same landed-check.
 *
 * Same shape as {@link writeRegionCreditsShown}: both are per-region content
 * switches written as a whole region slot, so a sibling region is never
 * dropped. The landed-check matters for the measured reason that switch
 * documents: the settings mirror can silently drop a write, and a checkbox that
 * keeps showing the old value is worse than one that reports failure.
 */
export async function writeRegionCampaignsShown(
  scope: QoderAccountScope,
  region: QoderWebRegion,
  shown: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['showCampaigns'] === shown
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
    /** 用户手动排定的优先级；省略或空 = 由积分策略自动排序。 */
    orderAccountIds?: readonly string[]
  },
): Promise<void> {
  const orderAccountIds = preferences.orderAccountIds ?? []
  const slot: Record<string, unknown> = {
    enabled: preferences.enabled,
    targetModelId: preferences.targetModelId,
    memberAccountIds: preferences.memberAccountIds,
    orderAccountIds,
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
    if (!stored.every(id => typeof id === 'string' && wanted.has(id))) return false
    // 顺序必须**逐位**比对：排序功能的意义就是这个数组的次序，
    // 只比集合会把「拖了但没生效」当成保存成功。
    const storedOrder = pool['orderAccountIds']
    if (!Array.isArray(storedOrder) || storedOrder.length !== orderAccountIds.length) return false
    return storedOrder.every((id, index) => id === orderAccountIds[index])
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