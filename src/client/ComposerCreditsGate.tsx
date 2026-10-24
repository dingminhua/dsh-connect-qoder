/**
 * Decides whether the composer credit readout belongs in this session, by
 * reading the Host's own `modelSelection` projection and the plugin's
 * per-region `showCreditsInMainUi` switch.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `client/ComposerCreditsGate.tsx`：从 `modelSelection` 投影读
 *     「本会话当前用哪个 provider」来决定要不要渲染，以及 `next` 优先于
 *     `lastUsed` 的判定。这是本项目把积分读数放到输入框的核心机制。
 *
 * WHY the projection rather than this plugin's own state: the projection is what
 * the model picker writes and what the next request will use, so the readout
 * cannot disagree with the model actually in effect. `next` outranks `lastUsed`.
 *
 * Kept separate from {@link ComposerCredits} (and from the browser-plugin entry)
 * so the decision can be unit-tested without a Host.
 */
import { useEffect, useState } from 'react'
import { ComposerCredits, QODER_COMPOSER_PROVIDERS } from './ComposerCredits.tsx'
import { QODER_REGIONS } from '../status-paths.ts'
import { regionCreditPositionOf, regionCreditsForeignOf, regionCreditsShownOf, regionEnabledOf, unwrapVolatileDeep } from '../status-paths.ts'
import type { QoderCreditPosition, QoderWebRegion } from '../status-paths.ts'
import type { Translate } from './locales.ts'

/** The slice of the `modelSelection` projection this decision needs. */
export interface ModelSelectionProjectionLike {
  lastUsed?: { provider?: unknown } | null
  next?: { provider?: unknown } | null
}

/** The provider route the session is currently pointed at. */
export function selectedProviderOf(projection: ModelSelectionProjectionLike | undefined): string | undefined {
  const candidate = projection?.next ?? projection?.lastUsed
  const provider = candidate?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/** Minimal reading slice of the settings scope the gate needs. */
export interface ComposerScopeLike {
  getSnapshot(): { value?: unknown }
  set(field: string, value: unknown): Promise<boolean | void>
}

/**
 * The settings tree this plugin writes, unwrapped to a plain object.
 *
 * `unwrapVolatileDeep` first: the scope's value is a live cosmokit reference,
 * and reading fields off it without unwrapping yields proxies whose `===`
 * comparison against a string is false.
 */
function scopeValueOf(scope: ComposerScopeLike | undefined): unknown {
  return scope === undefined ? undefined : unwrapVolatileDeep(scope.getSnapshot().value)
}

/**
 * Which region's readout this session should show, or undefined for none.
 *
 * Two regimes:
 *
 * - The session's model is **this plugin's** (`provider` maps to a region):
 *   that region, gated by its shown/enabled switches —— 原有行为，逐字未动。
 * - The provider is foreign or has not landed: the FIRST region that opted
 *   into cross-connector compare (`showCreditsForForeignModels`, issue #14),
 *   still gated by that region's shown/enabled switches. Several connectors
 *   each render their own capsule this way, side by side in the shared row —
 *   the labels ("QD CN" vs the other connector's own) keep them apart.
 *
 * 区域顺序沿 `QODER_REGIONS`（cn 先于 global）：两个区域都开了对比时取 cn，
 * 与「provider 属于本插件」时按 provider 映射取区域的可预测性一致。
 */
export function composerCreditsRegionOf(
  projection: ModelSelectionProjectionLike | undefined,
  scope: ComposerScopeLike | undefined,
): QoderWebRegion | undefined {
  const value = scopeValueOf(scope)
  const provider = selectedProviderOf(projection)
  const region = provider === undefined ? undefined : QODER_COMPOSER_PROVIDERS[provider]
  if (region === undefined) {
    return QODER_REGIONS.find(candidate =>
      regionCreditsForeignOf(value, candidate)
      && regionCreditsShownOf(value, candidate)
      && regionEnabledOf(value, candidate))
  }
  if (!regionCreditsShownOf(value, region)) return undefined
  if (!regionEnabledOf(value, region)) return undefined
  return region
}

export interface ComposerCreditsGateProps {
  t: Translate
  /**
   * WHICH seat this registration occupies.
   *
   * The component is registered once per seat and renders only in the seat the
   * setting names, so switching seats is a settings write rather than a slot
   * re-registration. Absent means `composer` —— 该设置存在之前唯一的席位，
   * 这让所有既有调用方与测试都留在旧行为上。
   */
  position?: QoderCreditPosition
  /** Settings scope from the configForms mirror; the card writes the same field. */
  settingsScope?: ComposerScopeLike
  /**
   * Standard slot hook: reads one Host-computed projection for this session.
   * Injected by the slot, so it is absent when this gate is rendered directly
   * from a test.
   */
  useProjection?: (key: 'modelSelection') => unknown
}

export function ComposerCreditsGate(props: ComposerCreditsGateProps) {
  const { t, position, settingsScope, useProjection } = props
  const [, setRevision] = useState(0)
  useEffect(
    () => {
      if (settingsScope?.getSnapshot === undefined) return undefined
      return subscribeScope(settingsScope, setRevision)
    },
    [settingsScope],
  )
  const projection = useProjection === undefined
    ? undefined
    : useProjection('modelSelection') as ModelSelectionProjectionLike | undefined

  const region = composerCreditsRegionOf(projection, settingsScope)
  if (region === undefined) return null
  // The seat test comes AFTER ownership and the on/off switches, so a region
  // that is switched off renders nothing in EITHER seat (rather than the
  // inactive seat briefly drawing before the region test rejects it).
  if (regionCreditPositionOf(scopeValueOf(settingsScope), region) !== (position ?? 'composer')) return null

  const provider = selectedProviderOf(projection)
  // 对比模式下 provider 可能缺席（投影未落地）或属于别的连接器；读数的一切
  // 判定都挂在上面解出的 region 上，provider 只是 `ComposerCredits` 的附加
  // 信息（区分「本插件计费」与「对比显示」两条悬停文案）。
  return <ComposerCredits t={t} {...provider === undefined ? {} : { provider }} region={region} {...settingsScope === undefined ? {} : { settingsScope }} />
}

function subscribeScope(scope: ComposerScopeLike & { subscribe?: (l: () => void) => () => void }, setRevision: (fn: (v: number) => number) => void): (() => void) | undefined {
  return scope.subscribe === undefined
    ? undefined
    : scope.subscribe(() => { setRevision(value => value + 1) })
}
