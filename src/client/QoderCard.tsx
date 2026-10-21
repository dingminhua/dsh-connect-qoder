/**
 * Qoder (Lingma) credits & models card contributed to Harness Plugin
 * configuration.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片的整体结构（折叠外壳 `<li class="dsm-plugin-card">` + header/icon/title/
 *     description/chevron、国内/国际 tab 栏 + 供应商开关、账号下拉、积分区、模型表、
 *     探针行、60 秒轮询与 AbortController 清理、模块加载时注入一次 `<style>`、
 *     纯 CSS caret）、以及 `dsm-*` 类名体系与 `--dsw-alias-*` 主题变量用法，
 *     均沿用自该项目；其又逐字承接 dingminhua/dsh-connect-trae（MIT）与
 *     dingminhua/dsh-subagent-default-model（MIT）。
 * 改动（按 Qoder 现实）：
 *   1. 账号是 PAT（settings / env / vault），不是桌面端登录：无 searched-paths
 *      诊断、无 OAuth 登录；账号列表旁是「Add PAT」表单与每 vault 账号的删除；
 *   2. 每日签到走 campaigns 端点：`QoderWebPool.checkinSupported` 按区域判定
 *      （CN 与国际版均已接通），为 false 时签到动作与那一列不渲染；
 *   3. 积分逐账号显示在账号池表格里（卡片正文不再重复一份额度明细，只在读不到
 *      时渲染失败原因）；
 *   4. 模型行：勾选（enabledModelKeys / offModelKeys）、图像开关（supportsImages）、
 *      上下文预算 tier 选择器（model.contextTiers + contextBudgets）、探针；
 *   5. 保存仍是草稿态 + dirty + 「保存/放弃」，写入走共享的 verified-write
 *      (`account-selection.write*`)，Host 端点优先、`__save` 回退。
 *
 * 数据流：
 * - 配置值（PAT、accountId、开关、勾选、contextBudgets、pool 偏好）经
 *   `settingsScope`（宿主 settings 镜像）读写，或经 `QODER_SAVE_PATH` 回退。
 * - 状态（账号、额度、模型目录、探针、池）经本插件只读路由获取。
 *
 * @module dsh-connect-qoder/client/QoderCard
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  QODER_GITHUB_URL,
  QODER_MODELS_REFRESH_PATH,
  QODER_PROBE_PATH,
  QODER_REGIONS,
  QODER_USAGE_PATH,
  toPersistedCatalogEntry,
  withQoderRegion,
  withQoderRegionFastDetail,
} from '../status-paths.ts'
import type {
  QoderPersistedModel,
  QoderCreditPosition,
  QoderWebModel,
  QoderWebProbeOutcome,
  QoderWebProbeResult,
  QoderWebRegion,
  QoderWebUsage,
} from '../status-paths.ts'
import type { QoderAccountScope } from './account-selection.ts'
import {
  writeAccountSlot,
  writeRegionCreditPosition,
  writeRegionCreditsShown,
  writeRegionEnabled,
  writeRegionModels,
} from './account-selection.ts'
import { AccountPool } from './AccountPool.tsx'
import { AddAccount } from './AddAccount.tsx'
import { AccountTransfer } from './AccountTransfer.tsx'
import { inlineProbeReason } from './probe-reason.ts'
import { probeResultView } from './probe-label.ts'
import { QODER_PAT_ENV_VARS } from '../credentials.ts'
import type { QoderRegion } from '../upstream.ts'
import { QODER_PLUGIN_ICON } from './icon.ts'
import { QODER_CARD_CSS } from './styles.ts'
import { imageDefaultFor, nativeModalityOf } from '../native-modality.ts'
import { promoLiveAt } from '../promo.ts'
import { promoBadgeLabel, promoBadgeTooltip, hostLanguage } from './promo-badge.ts'
import type { Translate } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderCardInjected {
  t: Translate
  /**
   * Optional by design: a host line that provides neither settings surface
   * leaves this undefined, and the card renders read-only — saving is the only
   * capability that needs it.
   */
  settingsScope?: QoderAccountScope & { subscribe(listener: () => void): () => void }
}

/**
 * Props delivered by the Plugin configuration slot.
 */
export type QoderCardProps =
  Partial<QoderCardInjected>
  & { view?: string }

const POLL_INTERVAL_MS = 60_000

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-qoder/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = QODER_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-qoder'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = QODER_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

/** One region's unsaved model edits; switching tabs never drops these. */
export interface QoderDraft {
  enabledModelKeys: Set<string>
  offModelKeys: Set<string>
  supportsImages: Set<string>
  contextBudgets: Record<string, number>
  /**
   * 逐模型保存的思考强度（模型 key → 档位名）。这是一项**设置**：选好之后
   * 每个请求都会带上它，与 Qoder 客户端的 `reasoning-effort-changed` 同形态。
   * 缺席表示用模型自己声明的默认档。
   */
  thinkingEfforts: Record<string, string>
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)
}

function dotStyle(status: QoderWebUsage['status']): Record<string, string> {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { background: color }
}

/**
 * 某个模型图片开关的说明文字。
 *
 * 复选框只对**厂商文档确认原生 multimodal** 的模型默认勾选，所以另外两种
 * 结果必须说清「为什么没勾」——否则一个文档上纯文本的模型和一个未核实的
 * 模型，在已经勾选的兄弟旁边看起来是一样地「坏了」。三种状态各给一句不同
 * 的 tooltip，或直接不显示开关（`router`/`unknown` 的模型该不该勾没有依据，
 * 但用户仍可手动勾）。
 */
function imageCheckboxHint(modelKey: string, t: Translate): string {
  switch (nativeModalityOf(modelKey)) {
    case 'multimodal': return t('row.modelImage')
    case 'text': return t('row.modelImageText')
    default: return t('row.modelImageUnverified')
  }
}

export function QoderCard(props: QoderCardProps): ReactElement {
  const { view } = props
  // The injected `t` is always present in real wiring; fall back to the key when
  // a test renders without one.
  const t: Translate = props.t ?? ((key: string) => key)
  // Re-fetch the region's usage on the 60 s cadence, plus on demand.
  const [open, setOpen] = useState(view === 'page')
  const [activeRegion, setActiveRegion] = useState<QoderWebRegion>(() => 'cn')
  // 积分那两行的无障碍关联（复选框 aria-describedby → 它自己那行说明）。
  // 用 useId 而不是手写 id：同一页可能挂两张同样的卡片，写死的 id 会重复。
  const creditsLabelId = useId()
  const creditsHintId = useId()
  const [usages, setUsages] = useState<Partial<Record<QoderWebRegion, QoderWebUsage | undefined>>>({})
  const [busyRegions, setBusyRegions] = useState<ReadonlySet<QoderWebRegion>>(new Set())
  const [probes, setProbes] = useState<Partial<Record<QoderWebRegion, Record<string, QoderWebProbeResult | undefined>>>>({})
  const [probeBusy, setProbeBusy] = useState<ReadonlySet<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // 账号池保存的 in-flight 信号（workbuddy 的 poolBusy 同规）：池与模型列表写
  // 同一个 region slot，两边必须互斥——池保存期间模型保存/区域开关/积分开关
  // 一律禁用，反之由 siblingBusy 覆盖。
  const [poolBusy, setPoolBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [siblingBusy, setSiblingBusy] = useState(false)
  /**
   * 等待二次确认的「删除账号」目标 id。
   *
   * 删除是**硬删** vault 条目：vault 是这一个账号的唯一存储位置，删掉就再也
   * 找不回来（workbuddy 的删除是「暂时隐藏」，可 rescan 找回，所以它不需要确认；
   * 本插件没有第二来源可按，因此必须有一次确认）。这里用两步内联确认而不是
   * `window.confirm`：不阻塞、可被测试，且在禁用态下也能正确复位。
   */
  const [drafts, setDrafts] = useState<Record<string, QoderDraft | undefined>>({})
  const [revision, setRevision] = useState(0)
  const mounted = useRef(true)
  /** Per-region in-flight usage requests, so one region never cancels another's. */
  const controllers = useRef<Partial<Record<QoderWebRegion, AbortController>>>({})
  /**
   * Per-region in-flight FIRST-PAINT requests (`detail=fast`), kept apart from
   * `controllers` on purpose.
   *
   * `controllers` is a latest-wins cancellation chain for the FULL document:
   * a newer read aborts the older one so a stale response can never overwrite
   * a fresh one. The first-paint request has different semantics — it is
   * worthless the moment a full document exists, and it must never cancel (or
   * be cancelled by) the real read. Mixing them would mean the fast request
   * aborts the full one or vice versa, i.e. exactly the bug this card already
   * had once with a shared controller across regions.
   */
  const fastControllers = useRef<Partial<Record<QoderWebRegion, AbortController>>>({})

  const scope = props.settingsScope

  // Re-render when the mirror changes so a concurrent write (composer panel,
  // Add PAT) shows up without a remount.
  useEffect(() => scope?.subscribe(() => setRevision(v => v + 1)), [scope])

  const refresh = useCallback(async (region: QoderWebRegion, force?: boolean): Promise<void> => {
    // **每区域一个 AbortController**，不是一个共享的。
    //
    // 此前 `controllers.current?.abort()` 取消的是「上一次发起的那个请求」，而那个
    // 请求可能属于**另一个区域**：60 秒轮询里 `for (const region of QODER_REGIONS)
    // void refresh(region)` 背靠背连发两次，cn 的请求刚建好就被 global 那次
    // 取消掉（反之亦然）。结果是**同一时刻只有一个区域的 usage 能落地**，另一个
    // 永远停在 `undefined` —— 切到那个 tab 就是一片空白，连账号池带「添加 PAT」
    // 一起没有（用户实拍：「国际版还是缺少账号池这些功能」）。
    //
    // 取消自己的用途只有一个：同一区域连续刷新时只认最后一次（避免旧响应覆盖新
    // 响应）。所以按区域分别取消，互不干涉。
    controllers.current[region]?.abort()
    const controller = new AbortController()
    controllers.current[region] = controller
    setBusyRegions(prev => new Set(prev).add(region))
    try {
      const response = await fetch(withQoderRegion(QODER_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as QoderWebUsage
      if (!mounted.current || controller.signal.aborted) return
      setUsages(prev => ({ ...prev, [region]: value }))
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return
      setUsages(prev => ({
        ...prev,
        [region]: error instanceof Error ? { status: 'error', message: error.message } : { status: 'error', message: String(error) },
      }))
    } finally {
      if (mounted.current) setBusyRegions(prev => new Set([...prev].filter(r => r !== region)))
    }
  }, [])

  /**
   * First paint: ask for the LOCAL-ONLY document so the account rows can appear
   * immediately, then let the full read above upgrade the numbers.
   *
   * The full document's tail awaits a live upstream credit read (the serving
   * account) plus one live read per pool member — six members means six
   * network reads stacked in front of the account table. Any one of them being
   * slow holds the whole page on a blank body; that is the exact complaint
   * this fixes (workbuddy issue #77, 同一族).
   *
   * `detail=fast` answers from state the Host already has: the stored PAT (no
   * token exchange), the cached credit reading, the saved member list and this
   * process's check-in snapshot. It performs NO upstream read, so it cannot be
   * held by one.
   *
   * Deliberate asymmetry with `refresh`: a fast answer NEVER replaces a region
   * that already has a document. The full read stays authoritative — the fast
   * one only fills a hole that would otherwise render as an empty page, and it
   * carries no error state (a failed first paint is simply no paint yet; the
   * full read will report the failure properly).
   */
  const refreshFast = useCallback(async (region: QoderWebRegion): Promise<void> => {
    fastControllers.current[region]?.abort()
    const controller = new AbortController()
    fastControllers.current[region] = controller
    try {
      const response = await fetch(withQoderRegionFastDetail(QODER_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok) return
      const value = await response.json() as QoderWebUsage
      if (!mounted.current || controller.signal.aborted) return
      setUsages(prev => {
        // A region that already answered in full must not be downgraded to a
        // credit-less first paint — the numbers would flicker backwards.
        if (prev[region] !== undefined) return prev
        return { ...prev, [region]: value }
      })
    } catch {
      // Swallowed on purpose: the first paint is an optimisation, never a
      // failure path. `refresh` owns the error document.
    } finally {
      if (fastControllers.current[region] === controller) delete fastControllers.current[region]
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    // **两个区域都要读，不是只读 `cn`。** 此前只 `refresh('cn')`，另一个区域要
    // 等到 60 秒轮询才第一次有数据 —— 于是「切到国际版」看到的是一片空白
    // （连账号池带「添加 PAT」一起没有），要等一分钟才自己长出来
    // （用户实拍：「国际版还是缺少账号池这些功能」）。
    // 两个 tab 的状态圆点也依赖这个：没读过的区域只能画成「未知」。
    //
    // 首屏先要那份**本地文档**（快、不打上游），完整文档随后照常补齐数字。
    // 顺序刻意是先 fast 后 full：两者互不取消，谁先回来都能落地；fast 只补
    // 空洞，不会把完整文档盖回去。
    for (const region of QODER_REGIONS) void refreshFast(region)
    for (const region of QODER_REGIONS) void refresh(region)
    if (typeof window !== 'undefined') {
      const timer = window.setInterval(() => {
        for (const region of QODER_REGIONS) void refresh(region)
      }, POLL_INTERVAL_MS)
      return () => { mounted.current = false; window.clearInterval(timer); abortAllRegions() }
    }
    return () => { mounted.current = false; abortAllRegions() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切 tab 时若那个区域**还没读过**，立刻补读一次。否则首次打开设置页、国际版
  // 又恰好排在轮询窗口之后，用户要盯着空白等一分钟才看到内容。
  // 同样先要本地文档：切过去的一瞬间就该看到账号行，而不是又一段空白。
  useEffect(() => {
    if (usages[activeRegion] === undefined) {
      void refreshFast(activeRegion)
      void refresh(activeRegion)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRegion])

  /** Cancel every region's in-flight usage read (unmount only). */
  const abortAllRegions = (): void => {
    for (const controller of Object.values(controllers.current)) controller?.abort()
    for (const controller of Object.values(fastControllers.current)) controller?.abort()
  }

  // Re-fetch the ACTIVE region whenever a settings write might have changed the
  // serving account (the write helpers call onChanged from sub-sections only;
  // the card itself re-reads here on revision bumps).
  useEffect(() => {
    void refresh(activeRegion, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const usage = usages[activeRegion]
  const regionOn = usage !== undefined && usage.status !== 'error' ? regionEnabledOfUsage(usage) : true

  const cartesianModels = usage?.status === 'signed-in' ? usage.models : []
  const enabledModelKeys = usage?.status === 'signed-in' ? usage.enabledModelKeys : []
  const offModelKeys = usage?.status === 'signed-in' ? usage.offModelKeys : []
  const imageModelKeys = usage?.status === 'signed-in' ? usage.imageModelKeys : []
  const savedBudgets = usage?.status === 'signed-in' ? (usage.contextBudgets ?? {}) : {}
  const savedEfforts = usage?.status === 'signed-in' ? (usage.thinkingEfforts ?? {}) : {}

  const draft: QoderDraft = drafts[activeRegion] ?? {
    enabledModelKeys: new Set(enabledModelKeys),
    offModelKeys: new Set(offModelKeys),
    // 图片勾选以**宿主保存的独立集合**为准（与运行时同一份事实）。用户从未
    // 保存过（集合为空）时，才回落到厂商核对表 `imageDefaultFor` 的默认值——
    // 绝不采信平台的 `is_vl` 标记：它几乎对每个模型都是 true（含纯文本模型），
    // 拿它当能力答案会在纯文本模型上默认开出图片输入。见 src/native-modality.ts。
    supportsImages: imageModelKeys.length > 0
      ? new Set(imageModelKeys)
      : new Set(cartesianModels.filter(m => imageDefaultFor({ id: m.key, ...(m.supportsImages === undefined ? {} : { supportsImages: m.supportsImages }) })).map(m => m.key)),
    contextBudgets: { ...savedBudgets },
    thinkingEfforts: { ...savedEfforts },
  }

  const toggleModel = (key: string, on: boolean): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.enabledModelKeys.add(key)
      else d.enabledModelKeys.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const toggleOff = (key: string, on: boolean): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.offModelKeys.add(key)
      else d.offModelKeys.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const toggleImageLight = (key: string, on: boolean): void => {
    // The image toggle rides along in the saved lastCatalog model's
    // `supportsImages` field; it is a presentation/persistence preference.
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (on) d.supportsImages.add(key)
      else d.supportsImages.delete(key)
      return { ...prev, [activeRegion]: d }
    })
  }
  const setContextBudget = (key: string, tokens: number): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (tokens > 0) d.contextBudgets[key] = tokens
      else delete d.contextBudgets[key]
      return { ...prev, [activeRegion]: d }
    })
  }

  /** 保存某个模型的思考强度；空串表示「跟随上游默认」（删掉保存值）。 */
  const setThinkingEffort = (key: string, effort: string): void => {
    setDirty(true)
    setSaveError(undefined)
    setDrafts(prev => {
      const d = cloneDraft(prev[activeRegion] ?? draft)
      if (effort === '') delete d.thinkingEfforts[key]
      else d.thinkingEfforts[key] = effort
      return { ...prev, [activeRegion]: d }
    })
  }

  const runProbe = async (modelKey: string): Promise<void> => {
    // 捕获发起时的区域：结果按区域分别存放，切换 tab 或刷新目录都不会把另一个
    // 区域的测量结果覆盖掉（workbuddy 的 probes 同样按区域键控）。
    const probeRegion = activeRegion
    setProbeBusy(prev => new Set(prev).add(modelKey))
    try {
      const response = await fetch(`${withQoderRegion(QODER_PROBE_PATH, probeRegion)}&model=${encodeURIComponent(modelKey)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as QoderWebProbeResult
      if (mounted.current) setProbes(prev => ({ ...prev, [probeRegion]: { ...prev[probeRegion], [modelKey]: result } }))
    } catch (error) {
      if (mounted.current) {
        const httpStatus = Number.parseFloat(String((error as Error)?.message ?? '').replace(/\D+/g, '')) || undefined
        const failed: QoderWebProbeResult = {
          modelId: modelKey,
          outcome: 'failed',
          message: String((error as Error)?.message ?? error),
        }
        if (httpStatus !== undefined) failed.status = httpStatus
        setProbes(prev => ({ ...prev, [probeRegion]: { ...prev[probeRegion], [modelKey]: failed } }))
      }
    } finally {
      if (mounted.current) setProbeBusy(prev => new Set([...prev].filter(k => k !== modelKey)))
    }
  }

  const refreshModels = async (): Promise<void> => {
    setSiblingBusy(true)
    try {
      const response = await fetch(withQoderRegion(QODER_MODELS_REFRESH_PATH, activeRegion), {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh(activeRegion, true)
    } catch (error) {
      if (mounted.current) setSaveError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setSiblingBusy(false)
    }
  }

  const saveModels = async (): Promise<void> => {
    if (scope === undefined) return
    setSaving(true)
    setSaveError(undefined)
    const payload = buildModelsPayload(draft, cartesianModels)
    try {
      await writeRegionModels(scope, activeRegion, payload)
      setDrafts(prev => ({ ...prev, [activeRegion]: undefined }))
      setDirty(false)
      await refresh(activeRegion, true)
    } catch (error) {
      setSaveError(isContention(error)
        ? `${t('row.saveError', { message: String((error as Error)?.message ?? error) })}${t('row.saveContentionHint')}`
        : t('row.saveError', { message: String((error as Error)?.message ?? error) }))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const discardModels = (): void => {
    setDrafts(prev => ({ ...prev, [activeRegion]: undefined }))
    setDirty(false)
    setSaveError(undefined)
  }

  const signIn = usage?.status === 'signed-in' ? usage : undefined
  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        onClick={() => { setOpen(!open) }}
        aria-expanded={open}
        aria-label={`${t(open ? 'row.collapse' : 'row.expand')}: ${t('row.title')}`}
      >
        <img className="dsm-plugin-card-icon" src={QODER_PLUGIN_ICON} alt="" width="32" height="32" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{t('row.title')}</span>
          <span className="dsm-plugin-card-description">{t('row.desc')}</span>
        </span>
        <span className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`} aria-hidden="true" />
      </button>

      {open ? (
        <div className="dsm-plugin-card-body">
          {/* 卡片正文的第一块套一层容器，因为 `.dsm-plugin-card-body` 只有
              `padding:0 0 8px`（**上内边距为 0**）：正文的首个元素必须自带顶部
              间距，否则会直接贴住上面那条分隔线——用户实拍「国际版 国内版
              不要顶着上面这条线」。
              workbuddy 的 tab 栏正是这样被 `.dsm-workbuddy-usage`
              （padding:16px 0 4px）托住的；这里用同一条规则 `.dsm-qoder-usage`
              恢复同样的呼吸空间（规则本来就在，是此前删掉积分块时把这层
              容器一并拆掉了）。 */}
          <div className="dsm-qoder-usage">
            {/* Tab bar: one tab = one provider (qoder / qoder-global). */}
            <div className="dsm-qoder-tabs" role="tablist" aria-label={t('row.title')}>
              {QODER_REGIONS.map(region => {
                const on = region === activeRegion
                const regionStatus = usages[region]?.status ?? 'signed-out'
                const regionOnState = regionOnOf(usages[region])
                return (
                  // 选中的那一格把激活类挂在 CELL 上（`dsm-qoder-tab-cell-active`），
                  // 不挂在按钮上——照 `dsh-connect-trae` 的做法：边框画在最外层那个
                  // 圆角块上，内部的按钮与右侧开关才同属一个视觉单位。此前是按钮自己
                  // 描一圈 inset 边框，而它外面还套着整条 tab 栏的边框，两道边框相距
                  // 几像素，看起来像渲染出错。用户给的参照图就是这个形状：**一格一个
                  // 卡片，选中的那格描彩色边**。
                  <div key={region} className={`dsm-qoder-tab-cell${on ? ' dsm-qoder-tab-cell-active' : ''}`}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={on}
                      // 按钮保留 `dsm-qoder-tab-active`：它是给测试与辅助技术读的
                      // 状态标记（既有用例按 `button.dsm-qoder-tab-active` 取选中页），
                      // 但**不再由它自己画边框**。
                      className={`dsm-qoder-tab${on ? ' dsm-qoder-tab-active' : ''}${regionOnState ? '' : ' dsm-qoder-tab-off'}`}
                      onClick={() => { setActiveRegion(region as 'cn' | 'global'); setSaveError(undefined) }}
                    >
                      {usages[region] === undefined
                        ? null
                        : <span aria-hidden="true" className="dsm-qoder-tab-dot" style={dotStyle(regionStatus)} />}
                      {region === 'cn' ? t('row.tabCn') : t('row.tabGlobal')}
                    </button>
                    <label className="dsm-qoder-tab-switch" title={t('row.tabSwitchHint')}>
                      <input
                        type="checkbox"
                        checked={regionOnState}
                        disabled={!canWrite(scope) || siblingBusy || poolBusy}
                        aria-label={t('row.tabSwitchAria', { region: region === 'cn' ? t('row.tabCn') : t('row.tabGlobal') })}
                        onChange={(event) => { toggleRegion(region, event.target.checked) }}
                      />
                    </label>
                  </div>
                )
              })}
            </div>
            <p className="dsm-qoder-usage-hint">{t('row.tabHint')}</p>
            {!regionOn
              ? <p className="dsm-qoder-tab-off-notice">{t('row.tabOffNotice')}</p>
              : null}

            {/* 额度**读不到**时才说话：池行只能显示一个「—」，说不出为什么，而
                `creditsError`（凭据被拒 / 上游未响应）只存在于这份 usage 文档里，
                池行拿不到。成功时这一块什么都不渲染——明细在账号池表格里。
                「在对话框显示积分」开关本身已移到账号池标题行（见 renderPool）。 */}
            {signIn === undefined || signIn.credits !== undefined ? null : (
              <p className="dsm-qoder-usage-text">
                {signIn.creditsError === undefined
                  ? t('row.usageUnavailable')
                  : t('row.creditsError', { message: signIn.creditsError })}
              </p>
            )}
          </div>

          {signIn?.credentialRejected === true ? renderRejected(signIn) : null}
          {usage?.status === 'error' ? <p className="dsm-qoder-usage-error" role="alert">{usage.message}</p> : null}
          {usage?.status === 'signed-in' && usage.refreshError !== undefined
            ? <p className="dsm-qoder-hint">{t('row.requestFailedHint', { message: usage.refreshError })}</p>
            : null}
          {usage?.status === 'signed-out' && usage.selectionLost === true
            ? <p className="dsm-qoder-hint">{t('row.selectionLostHint')}</p>
            : null}

          {regionOn && usage?.status !== 'error' ? (
            <>
              {/* 顺序对齐 workbuddy：账号行 → 账号池管理 → 模型列表。
                  账号池是「谁在服务、花多少」的决定区，排在模型列表之前；
                  原先排在模型列表之后，用户要先翻过整张模型表才够到它。
                  error 分支不渲染这些空壳——与 workbuddy 同规，只留错误行。 */}
              {/* 积分显示那两行在账号池**之上**（用户实拍要求「这段内容移动到账号池
                  上面」）。它管的是读数显不显示、立即生效，既不属于「谁在服务」那张
                  表，也不属于要保存的偏好；放在两者之间的这道缝上最容易找到，且
                  不随区域有没有字节池而消失。 */}
              {renderCreditsSwitch()}
              {/* 还没拿到任何文档的那一瞬：说「正在加载」，而不是渲染一片空白。
                  空白与「这个区域没有账号」在屏幕上长得一模一样，用户无法分辨
                  （issue #77 同族：workbuddy 那边此时甚至渲染成了「未登录」）。
                  首个文档一落地这条就消失，账号行在它的位置上出现。 */}
              {usage === undefined
                ? <p className="dsm-qoder-usage-text" role="status">{t('row.accountsLoading')}</p>
                : null}
              {renderPool()}
              {renderModels()}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  )

  // ------------- helper renderers (closures over the active region) -------------

  function toggleRegion(region: QoderWebRegion, on: boolean): void {
    if (scope === undefined) return
    setSiblingBusy(true)
    void writeRegionEnabled(scope, region, on, slotWith(scope, region, { enabled: on })).finally(() => {
      if (mounted.current) setSiblingBusy(false)
    })
  }

  function toggleCreditsShown(on: boolean): void {
    if (scope === undefined) return
    setSiblingBusy(true)
    void writeRegionCreditsShown(scope, activeRegion, on, slotWith(scope, activeRegion, { showCreditsInMainUi: on })).finally(() => {
      if (mounted.current) setSiblingBusy(false)
    })
  }

  /**
   * Move this region's readout to another seat.
   *
   * A settings write, not a slot re-registration: both seats are registered
   * unconditionally and the gate picks between them, so this returns as soon as
   * the Host accepts it.
   */
  function changeCreditPosition(position: QoderCreditPosition): void {
    if (scope === undefined) return
    setSiblingBusy(true)
    void writeRegionCreditPosition(scope, activeRegion, position, slotWith(scope, activeRegion, { creditPosition: position })).finally(() => {
      if (mounted.current) setSiblingBusy(false)
    })
  }

  function renderRejected(usage: Extract<QoderWebUsage, { status: 'signed-in' }>): ReactElement | null {
    const recovery = usage.recovery
    // 与 workbuddy 同构：usage-error 容器 + strong/p，三态说明互斥
    // （可切换→切换说明 / 无号可切→重新添加 / 有号但都失败→自行选择），
    // 切换动作是独立按钮，busy 时显示扫描文案。
    return (
      <section className="dsm-qoder-usage-error" role="alert">
        <strong>{t('row.credentialRejectedTitle')}</strong>
        <p>{t('row.credentialRejectedIntro', { accountName: usage.accountName })}</p>
        {recovery?.usableAccount !== undefined
          ? <p>{t('row.credentialRejectedSwitch', { accountName: recovery.usableAccount.accountName })}</p>
          : recovery?.reloginRequired === true
            ? <p>{t('row.credentialRejectedRelogin')}</p>
            : <p>{t('row.credentialRejectedChoose')}</p>}
        {recovery?.usableAccount === undefined ? null : (
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canWrite(scope) || siblingBusy}
            onClick={() => {
              if (scope === undefined) return
              setSiblingBusy(true)
              void writeAccountSlot(scope, activeRegion, recovery.usableAccount!.accountId).finally(() => {
                if (mounted.current) { setSiblingBusy(false); void refresh(activeRegion, true) }
              })
            }}
          >
            {siblingBusy
              ? t('row.accountsScanning')
              : t('row.credentialRejectedSwitchAction', { accountName: recovery.usableAccount.accountName })}
          </button>
        )}
      </section>
    )
  }

  // 账号选择器与账号行都**已不在这里**：
  // - 「使用哪个账号」搬进账号池区块（`AccountPool` 的 `onSelectAccount`），
  //   变成一个设置行，只在池确实关闭时渲染。搬走的原因（与 workbuddy 同一套
  //   演进）：它原本任何时候都出现，池开着时改了不生效却长得像一个权威控件——
  //   「看着能改、其实改不了」比没有控件更糟；而且它离账号池那张表很远，
  //   「现在到底谁在服务」要跨半个卡片才能对上。
  // - 账号行上的两个按钮（重新读取账号 / 移除）在更早一轮已按用户实拍删除：
  //   前者的事现在自动发生、且「重新读取授权文件」语义早已过时（凭据走 PAT）；
  //   后者删的是保险库 PAT 记录，与账号池的「移出池成员」是两个不同操作，
  //   「真正要删凭据时用 `dsh-connect-qoder logout`」。
  // 同名账号的 id 尾号区分逻辑随之搬到 `AccountPool` 的下拉里（见
  // `poolAccountLabel`）——它是那条下拉唯一还需要的显示规则。

  function renderModels(): ReactElement {
    const modelList = signIn?.models ?? []
    /**
     * 活动徽标的判定时钟：**一次渲染一个时刻**。
     *
     * 不在解析目录时挑定徽标——上游的活动是墙钟窗口（22:00–08:00 Asia/Shanghai），
     * 写死一枚会让夜里读到的「错峰 4 折」在第二天早上继续挂着。卡片打开期间本来
     * 就会随轮询重渲染，这里只要每次用「现在的时刻」重判即可，不需要额外定时器。
     * 同一帧里所有行共用一个 `Date`，避免同一份数据被两个时刻判出两种结果。
     */
    const promoNow = new Date()
    const promoLanguage = hostLanguage(t)
    return (
      <section className="dsm-qoder-models" aria-label={t('row.modelsTitle')}>
        {/* 头部结构对齐 workbuddy：标题行（h3 + dirty 徽章）在上、计数摘要在下，
            刷新按钮在右；摘要不内联在标题旁，dirty 不追加进摘要文本。 */}
        <div className="dsm-qoder-models-head">
          <div>
            <div className="dsm-qoder-models-title-row">
              <h3 className="dsm-qoder-models-title">
                {t('row.modelsTitle')}
                {dirty ? <span className="dsm-qoder-models-dirty">{t('row.modelsDirty')}</span> : null}
              </h3>
            </div>
            <p className="dsm-qoder-models-summary">{t('row.modelsSummary', { count: String(draft.enabledModelKeys.size) })}</p>
          </div>
          <div className="dsm-qoder-models-head-actions">
            <button type="button" className="dsm-btn dsm-btn-outline" disabled={siblingBusy} onClick={() => { void refreshModels() }}>
              {siblingBusy ? t('row.modelsRefreshing') : t('row.modelsRefresh')}
            </button>
          </div>
        </div>

        {modelList.length === 0 ? (
          <p className="dsm-qoder-usage-hint">{t('row.usageUnavailable')}</p>
        ) : (
          <div className="dsm-qoder-model-list">
            {modelList.map(model => (
              <div key={model.key} className={`dsm-qoder-model${draft.enabledModelKeys.has(model.key) ? '' : ' dsm-qoder-model-disabled'}`}>
                <div className="dsm-qoder-model-head">
                  <label className="dsm-qoder-model-enabled">
                    <input
                      type="checkbox"
                      checked={draft.enabledModelKeys.has(model.key)}
                      disabled={!canWrite(scope) || siblingBusy}
                      onChange={(e) => toggleModel(model.key, e.target.checked)}
                    />
                    <span className="dsm-qoder-model-copy">
                      <span className="dsm-qoder-model-name" title={model.key}>
                        {model.name}
                        {typeof model.creditMultiplier === 'number'
                          ? <span className="dsm-qoder-model-name-rate">({model.creditMultiplier.toFixed(2)}x)</span>
                          : null}
                      </span>
                      {/* 活动徽标放在**名字外面**（同一行、名字之后）：模型名是
                          省略号截断的，塞进去会被一起裁掉。文案是上游自己的话，
                          只在「此刻落在上游的窗口内」（没有窗口时才看 active）时画一枚。 */}
                      {(() => {
                        const promo = model.promotion
                        if (!promoLiveAt(promo, promoNow)) return null
                        const label = promoBadgeLabel(promo, promoLanguage)
                        if (label === undefined) return null
                        return (
                          <span
                            className="dsm-qoder-model-promo"
                            title={promoBadgeTooltip(promo, promoLanguage)}
                            // 整行是包着复选框的 `<label>`，点胶囊会顺手把模型取消勾选。
                            // 胶囊只是提示，不该携带那个副作用。
                            onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
                          >
                            {label}
                          </span>
                        )
                      })()}
                    </span>
                  </label>
                  {/* image/off 两个复选框与 workbuddy 同规：恒渲染、是否可用只看
                      写权限——不按上游字段有无隐藏（隐藏会让能力未知的模型行缺控件，
                      行与行控件数量不一，视觉抖动）。 */}
                  <label className="dsm-qoder-model-image" title={imageCheckboxHint(model.key, t)}>
                    <input
                      type="checkbox"
                      checked={draft.supportsImages.has(model.key)}
                      disabled={!canWrite(scope) || siblingBusy}
                      onChange={(e) => toggleImageLight(model.key, e.target.checked)}
                    />
                    <span>{t('row.modelImage')}</span>
                  </label>
                  <label className="dsm-qoder-model-off" title={t('row.modelOffHint')}>
                    <input
                      type="checkbox"
                      disabled={!canWrite(scope) || siblingBusy}
                      checked={draft.offModelKeys.has(model.key)}
                      onChange={(e) => toggleOff(model.key, e.target.checked)}
                    />
                    <span>{t('row.modelOff')}</span>
                  </label>
                  {renderContextPicker(model)}
                  <div className="dsm-qoder-model-actions-buttons">
                    {/* 测试按钮：与 workbuddy 同位（头部行右端）。提示只作 title
                        悬停——不再在未测试时把整段说明文字铺在每个模型行里。
                        不写设置，所以只门槛登录状态，不门槛 canWrite/saving。 */}
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline dsm-qoder-model-probe"
                      disabled={probeBusy.has(model.key) || signIn === undefined}
                      title={t('row.probeHint')}
                      onClick={() => { void runProbe(model.key) }}
                    >
                      {probeBusy.has(model.key) ? t('row.probing') : t('row.probe')}
                    </button>
                  </div>
                </div>

                <div className="dsm-qoder-model-details">
                  <div className="dsm-qoder-model-meta">
                    <span>{t('row.modelContext', { context: formatCapacity(model.contextWindow) })}</span>
                    <span>{t('row.modelOutput', { output: formatCapacity(model.maxTokens) })}</span>
                    {/* 思考强度：一项**设置**（选好保存后每个请求自动带上），所以
                        是可选的控件而不是只读文字。没有档位的模型（auto、
                        kmodel_latest 等）不渲染——空控件会让人以为该模型支持思考
                        却没有强度可选。 */}
                    {renderEffortPicker(model)}
                    {model.isFree === true ? <span className="dsm-qoder-model-meta-tag">{t('row.modelFree')}</span> : null}
                  </div>
                </div>

                {/* 探测结果只在有结果时出现——与 workbuddy 的 `result === undefined
                    → return null` 同规；未测试的行不渲染任何探测文字。 */}
                {(() => {
                  const p = probes[activeRegion]?.[model.key]
                  if (p === undefined) return null
                  const view = probeResultView(p, t)
                  const reason = inlineProbeReason(p.outcome, p.message)
                  return (
                    <p
                      className={`dsm-qoder-model-probe-result dsm-qoder-model-probe-result-${view.tone}`}
                      role="status"
                      {...p.message === undefined ? {} : { title: p.message }}
                    >
                      {view.text}
                      {reason === undefined ? null : ' · ' + reason}
                    </p>
                  )
                })()}
              </div>
            ))}
          </div>
        )}

        {/* 能力声明边界——workbuddy 列表尾部同款注记；locale 键早已存在但
            此前从未渲染。 */}
        <p className="dsm-qoder-model-capability-note">{t('row.modelCapabilityPending')}</p>

        <div className="dsm-qoder-model-actions">
          <a
            className="dsm-qoder-usage-cheer"
            href={QODER_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('row.cheer')}
            <span className="dsm-qoder-usage-cheer-star" aria-hidden="true">★</span>
          </a>
          {saveError === undefined ? null
            : <span className="dsm-qoder-model-save-error">{t('row.saveError', { message: saveError })}</span>}
          <div className="dsm-qoder-model-actions-buttons">
            <button type="button" className="dsm-btn dsm-btn-outline" disabled={!dirty || !canWrite(scope) || saving || poolBusy} onClick={discardModels}>
              {t('row.discard')}
            </button>
            <button type="button" className="dsm-btn dsm-btn-primary" disabled={!canWrite(scope) || saving || !dirty || poolBusy || draft.enabledModelKeys.size === 0} onClick={() => { void saveModels() }}>
              {saving ? t('row.saving') : t('row.save')}
            </button>
          </div>
        </div>
      </section>
    )
  }

  /**
   * 思考强度选择器（一项设置，保存后每个请求自动带上）。
   *
   * 档位名由上游逐模型声明，且**不统一**（Qwen 系 low/medium/xhigh，
   * DeepSeek/GLM 系 low/high/max），所以选项直接显示上游给的档位名，不做
   * 本地化、也不跨模型比较。多出一个「默认」项表示不干预（清掉保存值，请求
   * 不带档位字段，由上游用它自己的默认档）——没有这一项的话，用户选过一次
   * 就再也回不到「跟随上游默认」。
   */
  function renderEffortPicker(model: QoderWebModel): ReactElement {
    const efforts = model.thinkingEfforts ?? []
    if (efforts.length === 0) return <span />
    const saved = draft.thinkingEfforts[model.key] ?? ''
    return (
      <span className="dsm-qoder-effort">
        <label>
          {t('row.modelReasoningLabel')}{' '}
          {/* 行内样式（`.dsm-qoder-inline-select`）而不是 `pool-num`：后者是
              账号池表格里的 13px 实心方块，放进 11px 的 meta 行很突兀。 */}
          <span className="dsm-qoder-inline">
            <select
              className="dsm-qoder-inline-select"
              disabled={!canWrite(scope) || siblingBusy}
              value={saved}
              onChange={(e) => setThinkingEffort(model.key, e.target.value)}
            >
              <option value="">
                {model.defaultThinkingEffort === undefined
                  ? t('row.modelReasoningFollowUpstream')
                  : t('row.modelReasoningFollowUpstreamNamed', { effort: model.defaultThinkingEffort })}
              </option>
              {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </span>
        </label>
      </span>
    )
  }

  function renderContextPicker(model: QoderWebModel): ReactElement {
    const tiers = model.contextTiers ?? []
    if (tiers.length === 0) return <span />
    const current = draft.contextBudgets[model.key] ?? model.contextWindow
    // 选项**只**来自上游声明的档位。此前额外前置了一个「原生窗口」选项，
    // 而上游的 contextTiers 本身就以原生窗口开头（实测 `[200000, 400000,
    // 1000000]`），于是 200K 出现两次——用户一眼就看出来了。
    // 无标签：这一列就挨着模型的上下文信息，下拉里的 200K / 400K / 1M
    // 本身已经说明它在选什么（只留下拉，与旁边的思考强度选择器对齐）。
    return (
      <div className="dsm-qoder-context-budget" title={t('row.contextBudget')}>
        <label>
          <span className="dsm-qoder-inline">
            <select
              className="dsm-qoder-inline-select"
              aria-label={t('row.contextBudget')}
              disabled={!canWrite(scope) || siblingBusy}
              value={String(current)}
              onChange={(e) => setContextBudget(model.key, Number(e.target.value))}
            >
              {tiers.map(tier => <option key={String(tier)} value={String(tier)}>{formatCapacity(tier)}</option>)}
            </select>
          </span>
        </label>
      </div>
    )
  }

  /**
   * 账号池区。**读 `usage` 而不是 `signIn`** —— 这一行是国际版整块空白的直接原因。
   *
   * 此前它第一行就 `if (signIn?.pool === undefined) return <span />`，而 `signIn`
   * 只在 `status === 'signed-in'` 时存在。于是国际版（一个 PAT 都没有）永远拿到
   * `signed-out`，账号池整块不渲染 —— 连同由它渲染的「添加 PAT / 导出导入」
   * 一起消失。**最需要添加第一个账号的页面，反而没有任何添加账号的入口**
   * （用户实拍：国际版看起来就是空的）。
   *
   * 宿主侧此前已经修好了一半：`buildWebUsage` 的 `signed-out` 支现在也构建并带上
   * `pool`（零账号时 `current` 全为 false）。这一行是剩下的另一半 —— 两边都改完，
   * 零凭据的区域才会既能看到「这里还没有账号」的说法，又拿得到添加入口。
   *
   * `status === 'error'` 仍不渲染：那是一份没读成的文档，它的 pool 字段根本没
   * 有过，渲染一个空壳只会把错误行挤到下面（与 workbuddy 同规）。
   */
  /** 「在对话框显示积分」那两行（- 复选框+标题+说明 / - 显示位置+说明）。
   *
   *  池存在时交给账号池的设置区渲染在最上面；池不存在时由 renderPool 就地
   *  渲染——它管的是「读数显不显示」，跟有没有账号池是两件事。
   */
  function renderCreditsSwitch(): ReactElement {
    return (
        <div className="dsm-qoder-prefs">
          <label className="dsm-qoder-pref dsm-qoder-credit-toggle" title={activeRegion === 'cn' ? t('row.showCreditsCnHint') : t('row.showCreditsGlobalHint')}>
            <input
              type="checkbox"
              className="dsm-qoder-pref-check"
              checked={regionOn ? creditsShownOf(usage) : false}
              disabled={!regionOn || !canWrite(scope) || siblingBusy || poolBusy}
              aria-describedby={creditsHintId}
              onChange={(event) => { toggleCreditsShown(event.target.checked) }}
            />
            <span className="dsm-qoder-pref-copy">
              <span className="dsm-qoder-pref-label" id={creditsLabelId}>
                {activeRegion === 'cn' ? t('row.showCreditsCn') : t('row.showCreditsGlobal')}
              </span>
              <span className="dsm-qoder-pref-hint" id={creditsHintId}>
                {activeRegion === 'cn' ? t('row.showCreditsCnDesc') : t('row.showCreditsGlobalDesc')}
              </span>
            </span>
          </label>
          {/* 读数位置：这一行没有复选框，靠 padding 借用复选框那一列，让它的标题
              和上面那条主标题对齐到同一条左边缘（15px 勾选框 + 10px 间距）。
              关掉开关时置灰而不是藏起来——藏起来会让「有这个选项」本身消失。 */}
          <label className="dsm-qoder-pref dsm-qoder-credit-position-pref" title={t('row.creditPositionHint')}>
            <span className="dsm-qoder-pref-copy">
              <span className="dsm-qoder-pref-lead">
                <span className="dsm-qoder-pref-label">{t('row.creditPositionLabel')}</span>
                <select
                  className="dsm-qoder-credit-position"
                  value={creditsPositionOf(usage)}
                  disabled={!regionOn || !creditsShownOf(usage) || !canWrite(scope) || siblingBusy || poolBusy}
                  aria-label={t('row.creditPositionAria', { region: activeRegion === 'cn' ? 'QD CN' : 'QD AI' })}
                  onChange={(event) => { changeCreditPosition(event.target.value === 'stats' ? 'stats' : 'composer') }}
                >
                  <option value="composer">{t('row.creditPositionComposer')}</option>
                  <option value="stats">{t('row.creditPositionStats')}</option>
                </select>
              </span>
              <span className="dsm-qoder-pref-hint">{t('row.creditPositionHint')}</span>
            </span>
          </label>
    </div>
    )
  }

  function renderPool(): ReactElement {
    // `error` 变体没有 pool / accounts 字段（那份文档根本没读成），所以在这里
    // 就把它排除掉 —— 早于任何 `.accounts` 访问，窄化才有意义。
    const doc = usage?.status === 'error' ? undefined : usage
    const pool = doc?.pool
    // 没有字节池就整段不渲染（否则会读到 undefined）。积分显示那两行**不在这里**
    // ——它们已上移到卡片正文、账号池之上（用户实拍要求「这段内容移动到账号池上面」），
    // 因此与本函数是否渲染无关。
    if (pool === undefined || doc === undefined) return <span />
    // 账号工具（添加 PAT / 导出导入）交给账号池设置区渲染：workbuddy 把它们
    // 放在「账号池设置」标题下、说明行之前的虚线框里（`pool-tools`），而不是
    // 塞在账号行末尾。两者回答的是同一个问题——「这个区域有哪些账号」。
    const accountTools = (
      <>
        <AddAccount t={t} region={activeRegion} onAdded={() => refresh(activeRegion, true)} />
        <AccountTransfer
          t={t}
          region={activeRegion}
          accounts={doc.accounts.map(a => ({ id: a.id, accountName: a.accountName }))}
          onChanged={() => refresh(activeRegion, true)}
        />
      </>
    )
    return (
      <AccountPool
        t={t}
        region={activeRegion}
        pool={pool}
        settingsScope={scope}
        siblingBusy={siblingBusy}
        canWrite={canWrite(scope)}
        onBusyChange={setPoolBusy}
        accountTools={accountTools}
        onChanged={() => refresh(activeRegion, true)}
        onSelectAccount={(accountId) => {
          // 「使用哪个账号」立即生效、不走保存（与账号池的草稿式保存不同）：
          // 它回答的是「池关着时谁在服务」这个当下事实，草稿语义会让用户看着
          // 一个没生效的值。写入期间置 siblingBusy，顺带把同卡片其它控件锁住，
          // 避免并发写同一个 slot。
          if (scope === undefined) return
          setSiblingBusy(true)
          void writeAccountSlot(scope, activeRegion, accountId).finally(() => {
            if (mounted.current) {
              setSiblingBusy(false)
              void refresh(activeRegion, true)
            }
          })
        }}
      />
    )
  }
}

// ------------------------------- local helpers -------------------------------

/** Whether the injected scope permits edits. */
function canWrite(scope: QoderAccountScope | undefined): boolean {
  return scope !== undefined
}

/** Build the region slot for a write (merge into the current slot). */
function slotWith(scope: QoderAccountScope, region: QoderWebRegion, patch: Record<string, unknown>): Record<string, unknown> {
  const root = scope.getSnapshot().value
  const regions = typeof root === 'object' && root !== null && !Array.isArray(root)
    ? (root as Record<string, unknown>)['regions']
    : undefined
  const map = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  const prior = typeof map[region] === 'object' && map[region] !== null && !Array.isArray(map[region])
    ? map[region] as Record<string, unknown>
    : {}
  return { ...prior, ...patch }
}

/** Whether a usage doc's region is switched on (opt-out). */
function regionEnabledOfUsage(usage: QoderWebUsage | undefined): boolean {
  if (usage === undefined) return true
  if (usage.status === 'signed-out') return usage.enabled !== false
  if (usage.status === 'signed-in') return usage.enabled !== false
  return true
}

function regionOnOf(usage: QoderWebUsage | undefined): boolean {
  return regionEnabledOfUsage(usage)
}

function creditsShownOf(usage: QoderWebUsage | undefined): boolean {
  if (usage === undefined) return true
  if (usage.status === 'signed-out') return usage.showCreditsInMainUi !== false
  if (usage.status === 'signed-in') return usage.showCreditsInMainUi !== false
  return true
}

/**
 * Which seat this region's readout uses, read from the HOST's answer.
 *
 * Read from the usage document rather than the browser settings mirror, for the
 * same measured reason as the switch above: on affected deployments that mirror
 * never picks up writes made through the Host save endpoint, so a control
 * reading it would keep showing the old seat.
 */
function creditsPositionOf(usage: QoderWebUsage | undefined): QoderCreditPosition {
  if (usage === undefined) return 'composer'
  if (usage.status === 'error') return 'composer'
  return usage.creditPosition === 'stats' ? 'stats' : 'composer'
}

function cloneDraft(draft: QoderDraft): QoderDraft {
  return {
    enabledModelKeys: new Set(draft.enabledModelKeys),
    offModelKeys: new Set(draft.offModelKeys),
    supportsImages: new Set(draft.supportsImages),
    contextBudgets: { ...draft.contextBudgets },
    thinkingEfforts: { ...draft.thinkingEfforts },
  }
}

/** Build the `lastCatalog` array + enabled/off/image selections for the save. */
export function buildModelsPayload(draft: QoderDraft, models: readonly QoderWebModel[]): { lastCatalog: readonly QoderPersistedModel[] } & Record<string, unknown> {
  // 逐字段投影走 `toPersistedCatalogEntry`（**spread 写法**，照
  // dsh-connect-workbuddy 的 `toPersistedWorkBuddyModel`），**不在这里手写映射**。
  //
  // 这里是同一处缺陷的第二次出诊：workbuddy 的注释写着「omitting it made one
  // Save silently strip the declaration from every model」—— 手写映射只要漏一个
  // 字段，那次保存就把该字段从每个模型上抹掉，而且**没有任何东西会报错**。
  // 本仓库正是这样丢掉 `thinkingEfforts` / `defaultThinkingEffort` 的（用户实拍
  // 「每次保存都会思考强度不见了」）：读取端 `modelFromStored` 的判据是
  // `length > 0`，而缺席的声明会被 schema 补成 `[]`，档位选择器整个消失。
  // 保存的落地校验只比对 `key` 列表（见 `writeRegionModels`），所以字段丢了
  // 永远不会让保存失败 —— 这正是它长期潜伏的原因。
  //
  // 还有一处**看不见的**漂移同轮修掉：旧代码写 `maxTokens`，
  // 而读取端读的是 `maxOutputTokens` —— 名字对不上，永远读不回、静默回落 32768。
  // 三对重命名（name/displayName、maxTokens/maxOutputTokens、
  // creditMultiplier/priceFactor）现在只在投影函数里出现一次，并与读取端逐字对齐。
  // 投影与 schema 一起被测（tests/persisted-catalog.spec.tsx），漂移即变红。
  const lastCatalog = models.map(model => toPersistedCatalogEntry(model, {
    // 图片勾选以**草稿**为准：`supportsImages` 是待保存的用户编辑，而 model
    // 上带的是上一次保存过的值——用后者会让刚勾的那一下在本次保存中被抹掉。
    supportsImages: draft.supportsImages.has(model.key),
  }))
  return {
    lastCatalog,
    enabledModelKeys: [...draft.enabledModelKeys],
    // 图片勾选以**独立集合**持久化（workbuddy 的 `imageModelIds` 语义）：它不随
    // lastCatalog 一起被重写，运行时也只从它派生图像能力，不从上游 `is_vl`。
    imageModelKeys: [...draft.supportsImages],
    offModelKeys: [...draft.offModelKeys],
    contextBudgets: draft.contextBudgets,
    thinkingEfforts: draft.thinkingEfforts,
  }
}

function isContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:EPERM|EBUSY|EACCES)\b/u.test(message)
}

function formatCapacity(value: number | undefined, unknown = '—'): string {
  if (value === undefined) return unknown
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return formatNumber(value)
}
