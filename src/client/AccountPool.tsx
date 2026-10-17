/**
 * The account pool's card section.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `AccountPool.tsx`：草稿态 + dirty 标记 + 「保存/放弃」、`writeField` 验证
 *     写入、批量测试进度、活动日志的计时/配色、池表格的分列与配色，全部沿用。
 * 改动（按 Qoder 现实）：
 *   1. 每日签到走 campaigns 端点，`checkinSupported` 按区域判定（CN 与国际版均已
 *      接通）；为 false 的区域，签到按钮与那一列整体不渲染；
 *   2. 批量测试走 `POST /pool?action=test`，Host 一次性返回 JSON
 *      `{action, modelId, rows}`（Qoder 上游不支持逐 account 流式），不再逐行
 *      流式进度；
 *   3. 账号来自 PAT（settings / env / vault）。**两件不同的事必须分开**：
 *        - 移出池 = 取消勾选并保存（只改 `memberAccountIds`，凭据留着）；
 *        - 彻底删除 = 行内「删除」按钮 + 二次确认（删 vault 条目，并连带收掉
 *          配置里指向它的 `accountId` 与 `memberAccountIds` 残骸）。
 *      此前只有一个「移除」按钮，它做的其实是移出池，却长得像删除：用户点它
 *      期望账号消失，PAT 却原封不动留在 vault 里，「全选」一下又回来了（用户
 *      实拍：「删除唯一的号，但是号并没有删除干净」）。移出池现在只由勾选框表达
 *      （workbuddy 同规），按钮留给真正不可恢复的那个动作。
 *   4. settings / env 的 PAT 不归本插件管，删不动，所以那些行不给删除按钮。
 *
 * Add-PAT 与导出/导入由卡片以单独小节渲染（`AddAccount` / `AccountTransfer`），
 * 本模块只负责池本身：批量动作、成员勾选、偏好设置、活动日志。
 *
 * @module dsh-connect-qoder/client/AccountPool
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import {
  QODER_POOL_ACCOUNT_PARAM,
  QODER_POOL_PATH,
  QODER_GITHUB_URL,
  withQoderRegionAndAction,
  withQoderRouteAction,
  withQoderRouteAccount,
} from '../status-paths.ts'
import type {
  QoderWebPool,
  QoderWebPoolAccount,
  QoderWebPoolCheckinRow,
  QoderWebPoolModel,
  QoderWebPoolTestRow,
  QoderWebProbeOutcome,
  QoderWebProbeResult,
  QoderWebRegion,
} from '../status-paths.ts'
import { exclusionText } from './exclusion-text.ts'
import { BusyOverlay } from './BusyOverlay.tsx'
import type { Translate } from './locales.ts'
import { inlineProbeReason } from './probe-reason.ts'
import { probeLabelOf, formatProbeMoment } from './probe-label.ts'
import { probeAgeText, probeSourceText } from './probe-age.ts'
import { PROBE_INPUT_TOKEN_CHOICES } from '../probe.ts'
import { remainingText, countdownText } from './remaining.ts'

/** 池日志行的时间戳：只要时钟（日志是「刚刚/刚才」的语境，不需要日期）。 */
function formatClock(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
import {
  draftBaseFor,
  effectiveMemberIds,
  poolFailureText,
  usableMemberIds,
} from './pool-state.ts'
import { isFileContentionWriteError, writePoolPreferences } from './account-selection.ts'
import type { QoderAccountScope } from './account-selection.ts'

/** One line in the pool's activity log. */
interface PoolLogEntry {
  atMs: number
  text: string
  tone: 'ok' | 'warn' | 'error' | 'info'
}

/** 活动日志条数上限（超出裁最旧）。 */
const LOG_LIMIT = 50

/**
 * 「使用哪个账号」下拉里代表「当前没有任何账号在生效」的哨兵值。
 *
 * 不能用 `''`：那正是「自动（设置 → 环境变量 → 保险库）」这个**真实选项**的
 * 值。共用会让下拉在没有生效账号时显示成「自动」，等于替用户宣称了一个他没做
 * 过的选择——而这正是这个控件存在的意义所在（不显示看起来正常、实际没在跑的
 * 东西）。哨兵带下划线前缀，不可能与真实账号 id 撞上（id 形如 `pat-<hex>`）。
 */
const MANUAL_ACCOUNT_NONE = '__none__'

/**
 * 跨 remount 的活动日志。折叠卡片/切换 tab 会 unmount 本组件，组件 state 会
 * 丢空；日志属于「刚刚发生了什么」的事实记录，丢了会让用户以为操作没发生。
 * （workbuddy 的 logStore 同款方案。）
 */
const logStore = new Map<QoderWebRegion, readonly PoolLogEntry[]>()

/** The preferences the card edits as a draft. */
export interface PoolPreferences {
  enabled: boolean
  targetModelId: string
  /** Tokens each test probe sends; `0` means the host's measured default. */
  probeInputTokens: number
  /** The account ids checked into this pool. */
  memberAccountIds: readonly string[]
}

export interface AccountPoolProps {
  t: Translate
  region: QoderWebRegion
  /** The Host's pool state; absent when the Host has no pool support. */
  pool?: QoderWebPool
  settingsScope?: QoderAccountScope | undefined
  /** Whether the SAME card's other save (the model list) is in flight. */
  siblingBusy?: boolean | undefined
  /**
   * Reports THIS pool's own save in flight, so the card can disable the model
   * save / region switch / credits switch while it runs (workbuddy's
   * `onBusyChange` pattern): pool and models write into ONE region slot, and a
   * stale-snapshot save from either side would roll back the other's write.
   */
  onBusyChange?: ((busy: boolean) => void) | undefined
  /**
   * The account tools (add a PAT / export-import), rendered in a dashed box at
   * the TOP of the settings block — after the heading, before the hint — so
   * "which accounts does this region have" is answered in one place. The card
   * owns these (they need its refresh + region), so they arrive as a node.
   */
  accountTools?: ReactNode | undefined
  /**
   * 「在对话框显示积分」开关，渲染在账号池标题那一行的右侧（`pool-head`）。
   *
   * 它原来在卡片正文里独占一行，约 30px 高却只有一个勾选框。用户要求
   * 「放到账号池这个标题旁边吧，节约点空间」——放在这里语义也顺：它决定的是
   * 「积分怎么显示」，而积分明细正是下面这张表的内容。
   * 卡片持有写权限与区域，所以它作为节点传进来（与 `accountTools` 同规）。
   * 与「当前使用」芯片并列时开关排在前：一个是可操作的控件，一个是状态。
   */
  creditsSwitch?: ReactNode | undefined
  /** Whether this region may be edited (not while the provider is off). */
  canWrite: boolean
  /** Force the card to re-read its usage snapshot after a Host-side action. */
  onChanged?: (() => void | Promise<unknown>) | undefined
  /**
   * 「使用哪个账号」——**账号池关闭时**由用户手动选定服务账号。
   *
   * 这个控件原来在卡片头部（账号行区域），本轮搬到这里，理由有两条：
   *
   * 1. **池开着时它改了不生效**。那时谁服务由 `rankPool` 排序决定，而它仍然
   *    写着 `regions.<region>.accountId`——写了但没人读。控件长得像个权威开关，
   *    实际是个空操作，「看着能改、其实改不了」比没有控件更糟。
   * 2. 它离账号池那张表很远，「现在到底谁在服务」要跨半个卡片才能对上。
   *
   * 现在它是设置区里的一行，且**只在池关闭时渲染**——池关闭时插件不再自己选号，
   * 这时候它是唯一的入口。
   *
   * 由卡片持有写权限与区域，所以作为回调传进来（与 `accountTools` 同规）。
   */
  onSelectAccount?: ((accountId: string) => void) | undefined
}

export function AccountPool(props: AccountPoolProps): ReactNode {
  const { t, region, pool, settingsScope, siblingBusy, canWrite, onChanged, onBusyChange, accountTools, creditsSwitch, onSelectAccount } = props
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /** 正在跑的批量动作（'checkin' | 'test'），undefined = 空闲。两者互斥。 */
  const [batchAction, setBatchAction] = useState<'checkin' | 'test' | undefined>(undefined)
  /** 任一批量动作在跑。两个按钮共用同一把锁，避免签到与测试交错。 */
  const batchBusy = batchAction !== undefined
  /**
   * 正在跑「行内测试」的那一行账号 id；undefined = 空闲。
   *
   * 与 `batchAction` 分开记，是因为**这两件事对使用者的意义不同**：批量会改动
   * 整张表的排名，值得全屏挡一道；而行内测试只测一个账号、结果自有一行日志，
   * 抬遮罩等于让一次轻操作绑架整个界面——用户在其他区域点什么都点不动。
   *
   * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
   *   — 该项目的 `rowBusyAccountId` / `rowBusyAction`：注释原话是测试「keeps no
   *     veil — it changes no row membership, and its result already has its own
   *     line in the log」。workbuddy 用一个 id + 一个动作名，因为它行内还有
   *     remove；这里删除已经由 `removingId` 单独表达，所以只需要一个 id。
   */
  const [rowTestingId, setRowTestingId] = useState<string | undefined>(undefined)
  /**
   * 行内测试在飞。**它不进遮罩**，但仍然是锁：表里的测试按钮彼此互斥，批量
   * 按钮也要禁用——批量与单行交错会让两拨探针同时打向宿主，谁的结果是谁就
   * 说不清了。
   */
  const rowTestBusy = rowTestingId !== undefined
  /** 正在删除的账号 id；undefined = 空闲。删除过程中锁住整张表。 */
  const [removingId, setRemovingId] = useState<string | undefined>(undefined)
  /**
   * 等待二次确认的「删除账号」目标 id。
   *
   * 删除是**硬删** vault 条目：那是这个账号在本插件里的唯一存储位置，删掉就
   * 找不回来（对比「勾选框」表达的移出池——那只改名单，凭据留着，随时能勾回来）。
   * 所以按第一下只把这一行换成确认条，第二个按钮才真的删。
   *
   * 用两步内联确认而不是 `window.confirm`：不阻塞、可被测试、禁用态下也能复位
   * （workbuddy 的删除是「暂时隐藏」、可 rescan 找回，所以它不需要确认；这里
   * 没有第二来源可按，必须有）。
   */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined)
  // 日志种子来自模块级 logStore：折叠卡片/切换 tab 导致的 unmount 不再清空
  // 历史（workbuddy 同规）。两个区域各持一份，切 tab 是换历史而不是混历史。
  const [log, setLog] = useState<readonly PoolLogEntry[]>(() => logStore.get(region) ?? [])
  useEffect(() => {
    setLog(logStore.get(region) ?? [])
  }, [region])
  const [draftRegion, setDraftRegion] = useState<string | undefined>(undefined)
  const [draftPool, setDraftPool] = useState<PoolPreferences | null>(null)
  const mounted = useRef(true)
  /** 幽灵成员自愈的防重入标记（见 render 前的那个 effect）。 */
  const pruningRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    setNowMs(Date.now())
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 20_000)
    return () => window.clearInterval(timer)
  }, [])

  // 签到 / 测试在飞期间每 2.5 秒重读一次快照。
  //
  // 两种整批动作都是串行的（测试是真实探针，一池六个号就是几分钟），宿主每处理
  // 完一个账号就把那一条写进快照（测试见 src/index.ts 的 `onRow`，签到见
  // `applyCheckinRow`），所以重读到的是**逐行翻新的进度**：一行接一行变成这次的
  // 结果。两种动作都不再抬遮罩，界面必须自己动起来，否则「不锁」只是把「转圈的
  // 等待」换成「不动的等待」——用户照样会说卡住。
  //
  // `onChanged` 走 ref：父组件每次重渲染都会换一个内联箭头（`() => refresh(...)`），
  // 放进依赖里会让 effect 每次渲染都拆了重建，轮询被一次次重置——重读的节奏跟着
  // 渲染节奏走，而不是跟着「每 2.5 秒」走。
  const onChangedRef = useRef(onChanged)
  useEffect(() => { onChangedRef.current = onChanged }, [onChanged])
  useEffect(() => {
    if (batchAction === undefined) return
    const timer = window.setInterval(() => { void onChangedRef.current?.() }, 2_500)
    return () => window.clearInterval(timer)
  }, [batchAction])

  // 上报本池保存的 in-flight 窗口（卸载时务必归零）。workbuddy 同款的
  // useEffect 上报模式。
  useEffect(() => {
    onBusyChange?.(saving)
    return () => { onBusyChange?.(false) }
  }, [onBusyChange, saving])

  const saved: PoolPreferences = {
    enabled: pool?.enabled ?? false,
    // 陈旧目标回退：保存的 id 已掉出目录时 `targetModelId` 为空而
    // `staleTargetModelId` 存着原值——select 必须显示那个原值（以一个禁用的
    // 「已失效」option 呈现），而不是退回「自动」让用户以为从没选过。
    targetModelId: pool?.targetModelId || pool?.staleTargetModelId || '',
    probeInputTokens: pool?.probeInputTokens ?? 0,
    memberAccountIds: pool?.memberAccountIds ?? [],
  }

  /**
   * 正在计费的那个账号，或 undefined（池里没有 `current` 行时）。
   *
   * 这个事实由宿主给出（取自该区域解析出的服务凭据），卡片只渲染、不推断。
   */
  const currentAccount = pool?.accounts.find(account => account.current === true)
  /**
   * 「使用哪个账号」下拉框的当前值。
   *
   * `undefined` = 没有任何账号在生效（保存的 id 已失效、刷新失败）。这时**不能**
   * 退回空串让 select 显示「自动」——「自动」是一个真实选项，显示它等于宣称
   * 用户选了自动。所以给一个单独的禁用项，见下面那个 `poolManualAccountNone`。
   */
  const currentAccountId = currentAccount?.accountId
  const active: PoolPreferences = draftPool !== null && draftRegion === region
    ? draftPool
    : saved

  const listed = new Set(pool?.accounts.map(a => a.accountId) ?? [])
  const effective = pool?.effectiveMemberAccountIds?.slice() ??
    effectiveMemberIds({
      savedEffective: pool?.effectiveMemberAccountIds ?? [],
      draftMembers: active.memberAccountIds,
      listedIds: listed,
      dirty,
    })
  const canEditPool = settingsScope !== undefined && canWrite && !siblingBusy
  /** 该区域是否提供每日签到（决定整列与批量按钮是否出现）。 */
  const checkinOn = pool?.checkinSupported === true

  /**
   * 幽灵成员自愈：名单里留有「凭据已被删除」的 id 时，静默把名单收敛为实际
   * 存在的成员并写回。
   *
   * 为什么不提示用户（用户实拍：「你应该直接就清理掉，而不是再给我这么一个
   * 提示」）：删掉 PAT 之后配置里的 `memberAccountIds` 不会自动收缩，残渣是
   * 插件的内部记账问题。原先的文案（「再保存一次即可移除它们」）把这件事推回
   * 给用户——他删完 PAT 还得回到池设置里再点一次保存，而他本来就不想要这些
   * 账号；更糟的是批量测试仍会遍历它们，白跑一轮。
   *
   * 只在不脏、不忙、可写时动手：正在编辑草稿时不能偷改（会覆盖用户的选择），
   * 只读权限下也不能写。ref 防重入——写回后 pool 以新快照回流，effect 再跑时
   * kept 已等于 savedIds，自然停下。
   */
  useEffect(() => {
    if (dirty || saving || settingsScope === undefined || !canEditPool) return
    const savedIds = pool?.memberAccountIds
    if (savedIds === undefined) return
    const kept = savedIds.filter(id => listed.has(id))
    if (kept.length === savedIds.length) return
    if (pruningRef.current) return
    pruningRef.current = true
    void writePoolPreferences(settingsScope, region, { ...saved, memberAccountIds: kept })
      .then(() => onChanged?.())
      .catch(() => { /* 自愈失败不弹错；下次快照回流再试 */ })
      .finally(() => { pruningRef.current = false })
  }, [dirty, saving, settingsScope, canEditPool, pool?.memberAccountIds, region, saved, listed, onChanged])
  // 现在就能服务的成员（workbuddy 的 usable）：有效成员 ∩ 未被排除。
  const usable = pool === undefined ? [] : usableMemberIds(pool.accounts, effective, active.memberAccountIds)
  // 目标模型来源一句话：「当前用的是谁、是不是你选的」先于「自动怎么工作」的
  // 静态说明出现（workbuddy 的 targetProvenance 同规）。
  const targetProvenance = pool === undefined ? null
    : pool.targetModelSource === 'preferred'
      ? t('row.poolTargetCurrentPreferred', { model: pool.targetModelId ?? '' })
      : pool.targetModelSource === 'free'
        ? t('row.poolTargetCurrentFree', { model: pool.targetModelId ?? '' })
        : pool.targetModelSource === 'stale'
          ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })
          : pool.targetModelSource === 'none' ? t('row.poolTargetNone') : null

  const editDraft = useCallback((update: (prev: PoolPreferences) => PoolPreferences) => {
    setDraftPool(update(draftBaseFor<PoolPreferences>(draftPool, draftRegion, region, saved)))
    setDraftRegion(region)
    setDirty(true)
    setSaveError(undefined)
  }, [draftPool, draftRegion, region, saved])

  const toggleMember = (accountId: string, next: boolean) => {
    editDraft(prev => ({
      ...prev,
      memberAccountIds: next
        ? [...prev.memberAccountIds, accountId]
        : prev.memberAccountIds.filter(id => id !== accountId),
    }))
  }
  const selectAll = (on: boolean) => {
    editDraft(prev => ({ ...prev, memberAccountIds: on ? pool?.accounts.map(a => a.accountId) ?? [] : [] }))
  }

  const savePool = async (): Promise<void> => {
    if (settingsScope === undefined) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await writePoolPreferences(settingsScope, region, active)
      setDraftPool(active)
      setDirty(false)
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      setSaveError(isFileContentionWriteError(error)
        ? `${t('row.poolSaveFailed', { message: String((error as Error)?.message ?? error) })}${t('row.saveContentionHint')}`
        : t('row.poolSaveFailed', { message: String((error as Error)?.message ?? error) }))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  /**
   * 一键签到：对勾选的成员逐个领取当日 Credits。
   *
   * 与测试批次共用同一把锁（`batchAction`），两者不会交错。日志逐行写明每个
   * 账号的结果——`claimed`（领到，带数额）、`already`（今天已领）、`failed`
   * （失败原因）。「今天已领」是**正常**结果，不该显示成失败。
   */
  const runCheckinBatch = async (): Promise<void> => {
    setActionError(undefined)
    setBatchAction('checkin')
    try {
      const response = await fetch(withQoderRouteAction(QODER_POOL_PATH, region, 'checkin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined
        const error = typeof raw['error'] === 'string' ? raw['error'] : undefined
        throw new Error(poolFailureText(t, { status: response.status, reason, error }))
      }
      if (raw['action'] === 'checkin' && Array.isArray(raw['rows'])) {
        const rows = (raw['rows'] as unknown[]).map(parseCheckinRow).filter(row => row !== undefined)
        appendLog({ atMs: Date.now(), text: t('row.poolLogCheckinStart', { count: rows.length }), tone: 'info' })
        for (const row of rows) {
          appendLog({
            atMs: Date.now(),
            text: checkinLogText(t, row),
            tone: row.status === 'failed' ? 'warn' : 'ok',
          })
        }
        if (rows.length > 0) appendLog({ atMs: Date.now(), text: t('row.poolLogCheckinDone'), tone: 'info' })
      }
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      if (mounted.current) setActionError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) setBatchAction(undefined)
    }
  }

  const appendLog = useCallback((entry: PoolLogEntry) => {
    setLog(entries => {
      const next = [entry, ...entries].slice(0, LOG_LIMIT)
      logStore.set(region, next)
      return next
    })
  }, [region])

  /**
   * 测试一个账号，或整批。
   *
   * 行级按钮**必须**传 `accountId`：此前它调的是整批，于是点一行「测试」会把
   * 池里每个成员都真跑一遍（每个都是一次真实探针、约 25k 输入 token），而且
   * 动的不一定是用户点的那一行。整批仍由工具栏按钮与「测试全部」使用。
   *
   * 两条路径的「在飞表达」相同（学 workbuddy 的 `runRowTest` 与 `runAction`
   * 之分）：**都不抬全屏遮罩**，只锁测试类按钮，在飞期间界面照常可用。
   * 行内只让那一行的按钮自变「测试中…」；整批在顶部挂一句「正在逐个账号执行…」，
   * 并且每 2.5 秒重读一次快照，让每一行的结果逐个落位——批量是几分钟级的串行
   * 真实探针，一次轻操作（乃至一次长操作）都不该把使用者锁在整个界面外面；
   * 用户把它当成「卡住」过，而那时遮罩挡着、表也不动，确实与卡死无异。
   * 两条路径仍是同一把锁：测试类按钮互斥，批量与单行交错会让两拨探针同时
   * 打向宿主，谁的结果是谁就说不清了。
   * 「正在逐个账号执行…」那句提示**只在批量时挂**（workbuddy 同规：它的 hint
   * 挂在批量态 `busy` 上）——只测一行时「逐个」是句假话，行内的轻提示就是那
   * 颗按钮自己的「测试中…」。
   */
  const runTestBatch = async (onlyAccountId?: string): Promise<void> => {
    const inline = onlyAccountId !== undefined
    // 连点保护：已有任何测试（行内或批量）在飞就不再叠第二拨探针。
    if (batchBusy || rowTestBusy) return
    setActionError(undefined)
    if (inline) setRowTestingId(onlyAccountId)
    else setBatchAction('test')
    try {
      const url = inline
        ? withQoderRouteAccount(QODER_POOL_PATH, region, 'test', onlyAccountId)
        : withQoderRouteAction(QODER_POOL_PATH, region, 'test')
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined
        const error = typeof raw['error'] === 'string' ? raw['error'] : undefined
        throw new Error(poolFailureText(t, { status: response.status, reason, error }))
      }
      if (raw['action'] === 'test' && Array.isArray(raw['rows'])) {
        const rows = (raw['rows'] as unknown[]).map(parseTestRow).filter(row => row !== undefined)
        const modelId = typeof raw['modelId'] === 'string' && raw['modelId'] !== '' ? raw['modelId'] : t('row.modelUnknown')
        if (inline) {
          // 行内**不打批量话术**：「开始测试 N 个账号 × model」「测试完成，已重新
          // 计算候选账号」在只测一行时是噪声，第二句还在暗示一件没发生的事（整池
          // 重排）。一行只留一行结果，没返回结果就说没返回（workbuddy 同规）。
          if (rows.length === 0) {
            const target = pool?.accounts.find(account => account.accountId === onlyAccountId)
            appendLog({
              atMs: Date.now(),
              text: t('row.poolLogTestRowMalformed', { accountName: target?.accountName || target?.accountId || onlyAccountId || '' }),
              tone: 'warn',
            })
          } else {
            for (const row of rows) {
              appendLog({
                atMs: Date.now(),
                text: t('row.poolLogTestRow', { accountName: row.accountName, outcome: probeLabelOf(t, row.result, Date.now()) }),
                tone: row.result.outcome === 'ok' ? 'ok' : 'warn',
              })
            }
          }
        } else {
          appendLog({ atMs: Date.now(), text: t('row.poolLogTestStart', { count: rows.length, model: modelId }), tone: 'info' })
          if (rows.length === 0) {
            appendLog({ atMs: Date.now(), text: t('row.poolLogBatchFailed', { message: t('row.poolTargetNone') }), tone: 'warn' })
          } else {
            for (const row of rows) {
              appendLog({
                atMs: Date.now(),
                text: t('row.poolLogTestRow', { accountName: row.accountName, outcome: probeLabelOf(t, row.result, Date.now()) }),
                tone: row.result.outcome === 'ok' ? 'ok' : 'warn',
              })
            }
          }
          appendLog({ atMs: Date.now(), text: t('row.poolLogTestDone'), tone: 'info' })
        }
      }
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      if (!mounted.current) return
      const message = String((error as Error)?.message ?? error)
      setActionError(message)
      // 失败也要在日志里留一行。批量时遮罩会消失、横幅会被下一次动作清掉，行内
      // 时连遮罩都没有，而探针烧掉的额度不会——活动日志是事后唯一能查「那次为
      // 什么没结果」的地方（workbuddy 同规：它的 runRowTest 在 catch 里既
      // setActionError 又 appendLog）。行内不套用 'Batch failed — nothing ran'
      // 那句：请求确实发起了、且只发起一条，说「批量没执行」是假话。
      if (inline) {
        const target = pool?.accounts.find(account => account.accountId === onlyAccountId)
        appendLog({
          atMs: Date.now(),
          // 沿用 `{accountName}：{outcome}` 这句式：outcome 这里就是失败原因，
          // 中英各自的分隔符由 locales 负责，不在代码里手工拼冒号。
          text: t('row.poolLogTestRow', {
            accountName: target?.accountName || target?.accountId || onlyAccountId || '',
            outcome: message,
          }),
          tone: 'error',
        })
      } else {
        appendLog({ atMs: Date.now(), text: t('row.poolLogBatchFailed', { message }), tone: 'error' })
      }
    } finally {
      if (!mounted.current) return
      if (inline) setRowTestingId(undefined)
      else setBatchAction(undefined)
    }
  }

  /**
   * 彻底删除一个账号（凭据 + 池成员 + 区域选择）。
   *
   * 这一支以前叫 `runRowRemove`，做的却只是「从池名单里剔掉」——也就是移出池。
   * 用户点它期望账号消失，PAT 却留在 vault 里，下一次「全选」又勾回来，看起来
   * 就是「删不掉」（用户实拍：「删除唯一的号，但是号并没有删除干净」）。
   * 现在两件事彻底分开：移出池 = 取消勾选并保存；删除 = 这里，且要二次确认。
   */
  const runDeleteAccount = async (accountId: string): Promise<void> => {
    setActionError(undefined)
    setRemovingId(accountId)
    setConfirmDeleteId(undefined)
    try {
      const url = `${withQoderRegionAndAction(QODER_POOL_PATH, region, 'remove')}&${QODER_POOL_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) {
        const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined
        const error = typeof raw['error'] === 'string' ? raw['error'] : undefined
        throw new Error(poolFailureText(t, { status: response.status, reason, error }))
      }
      const accountName = pool?.accounts.find(a => a.accountId === accountId)?.accountName ?? t('row.accountUnnamed')
      appendLog({ atMs: Date.now(), text: t('row.poolRowRemoved', { accountName }), tone: 'ok' })
      // 硬删会连带把池名单与区域选择里的残骸收掉。草稿里若还留着这个 id，保存
      // 会把它写回去、复活成一个勾不上的幽灵——这里跟着一起摘掉。
      if (draftPool !== null && draftRegion === region) {
        setDraftPool({ ...draftPool, memberAccountIds: draftPool.memberAccountIds.filter(id => id !== accountId) })
        if (draftPool.memberAccountIds.includes(accountId)) setDirty(true)
      }
      try { await onChanged?.() } catch { /* reconciled on the next poll */ }
    } catch (error) {
      if (mounted.current) setActionError(String((error as Error)?.message ?? error))
    } finally {
      if (mounted.current) { setRemovingId(undefined); setConfirmDeleteId(undefined) }
    }
  }

  const targetMisses = pool?.targetModelSource === 'none' || pool?.targetModelSource === 'stale'

  /**
   * 本区域「下一窗什么时候开」的倒计时，来自上游活动行的 `endAt`。
   *
   * 区域级而不是账号级：活动窗对整个区域是同一批（所有成员领的是同一份每日
   * 额度），所以取第一条**已领取且给了时间**的成员行即可 —— 不去猜哪条才对。
   * 一个都没有 → `undefined`：上游没给就不显示倒计时，而不是拿本地区时编一个。
   *
   * 返回 `''` 表示「倒计时走完了，此刻就可以领了」——与「没有倒计时」（undefined）
   * 是两件事，UI 要分开说。
   */
  const checkinCountdown = useMemo(() => {
    if (!checkinOn) return { state: 'off' as const }
    const row = pool?.accounts.find(row => row.checkedInToday === true && row.checkinRefreshAtMs !== undefined)
    // **四态，不能塌成两态**：`off`（本区域没有签到列）、`unknown`（已领取但上游
    // 没给刷新时刻 —— 只说「已领取」，不编倒计时）、`ticking`、`due`。
    // 此前直接 `countdownText(until, nowMs)`，而它在 `until === undefined` 时返回
    // `''`，于是「上游没给时间」被渲染成「现在可以领取」—— 把「不知道下一窗什么时候
    // 开」说成了「已经可以领了」（本轮测试接住的第二个缺陷）。
    if (row === undefined) return { state: 'unknown' as const }
    const text = countdownText(row.checkinRefreshAtMs, nowMs)
    return text === '' ? { state: 'due' as const } : { state: 'ticking' as const, text }
  }, [checkinOn, pool?.accounts, nowMs])

  return (
    <section className="dsm-qoder-pool">
      {/* 遮罩只剩两件事：保存与删除。
          签到与测试（整批、单行）都已改成轻提示——它们都不改动行的归属，又都
          可能跑上几秒到几分钟，抬遮罩只是在拿界面当抵押。删除不同：它不可逆，
          且用户此刻只有一屏可看，值得挡住；保存是配置写入的收尾，同样留遮罩。 */}
      <BusyOverlay
        visible={saving || removingId !== undefined}
        message={t('row.poolSaving')}
      />

      <div className="dsm-qoder-pool-head">
        <h3 className="dsm-qoder-pool-title">{t('row.poolTitle')}</h3>
        {/* 积分开关紧挨着标题（workbuddy 的 `pool-head-extra` 同位同形）：
            它是这一行里标题之外唯一**可操作**的东西，放在标题正后方读起来
            像它的附属，而不是被推到右端跟状态芯片挤在一起。 */}
        {creditsSwitch === undefined
          ? null
          : <span className="dsm-qoder-pool-head-extra">{creditsSwitch}</span>}
        {/* 「当前使用」芯片：由宿主给出的 `current` 事实驱动（正在计费的那个
            账号），不是从排序或列表位置猜出来的——否则卡片会宣称一次并未发生
            的切换。靠 `margin-left:auto` 推到右端（workbuddy 同规）：这样开关
            的文案长度随区域变化时，芯片的位置不会跟着左右晃。 */}
        {currentAccount === undefined ? null : (
          <span className="dsm-qoder-pool-current-badge" title={t('row.poolCurrentHeader', { account: currentAccount.accountName || currentAccount.accountId })}>
            {t('row.poolCurrentHeader', { account: currentAccount.accountName || currentAccount.accountId })}
          </span>
        )}
      </div>

      <div className="dsm-qoder-pool-actions">
        <div className="dsm-qoder-pool-actions-group">
          {/* 签到是这一行里唯一会**带来收益**的动作，所以用 primary 并且在最左
              （workbuddy 同规：签到按钮在前、测试在后）。区域不支持签到时整个
              按钮不渲染——空按钮会暗示「这里能签到，只是现在不行」。 */}
          {pool?.checkinSupported !== true
            ? null
            : <button
                type="button"
                className="dsm-btn dsm-btn-primary"
                disabled={!canEditPool || effective.length === 0 || batchBusy || rowTestBusy}
                onClick={() => { void runCheckinBatch() }}
              >
                {batchAction === 'checkin' ? t('row.poolCheckingIn') : t('row.poolCheckinAll')}
              </button>}
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canEditPool || effective.length === 0 || batchBusy || rowTestBusy || targetMisses}
            title={pool?.targetModelSource === 'none'
              ? t('row.poolTargetNone')
              : pool?.targetModelSource === 'stale' ? t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' }) : undefined}
            onClick={() => { void runTestBatch() }}
          >
            {batchAction === 'test' ? t('row.poolTesting') : t('row.poolTestAll')}
          </button>
          {/* 批量测试期间说明「正在逐个处理」并逐行落位进度：宿主每测完一个
              账号就把那条测量写进快照，卡片在飞期间每 2.5 秒重读一次（见上方
              那个 effect），所以这句话是真的——并不是「一次性等到最后」。
              行内测试**不挂这句**：它只测一个账号，「正在逐个账号执行」在只跑
              一行时是一句假话；行内自己的「测试中…」按钮就是那句轻提示。 */}
          {batchAction === undefined ? null : <span className="dsm-qoder-pool-hint">{t('row.poolBusyHint')}</span>}
        </div>
      </div>

      {/* 池开关关掉时说明它的语义：手动测试仍可用，只是不再自动选号。 */}
      {pool?.enabled === false
        ? h('p', { className: 'dsm-qoder-pool-note' }, t('row.poolEnabledHint'))
        : null}
      {/* 开着却没有可用成员时直说：失败会被直接报出来而不是被重试。
          但**一个账号都没有**时不能说这句 —— 那段文案在讲「成员要么限流、要么
          积分耗尽……」，而这里根本还没有成员，读起来像账号出了问题而不是还没添加。
          那种情况由下面的空状态负责。 */}
      {pool?.enabled === true && usable.length === 0 && (pool?.accounts.length ?? 0) > 0
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolNoCandidate')} ${t('row.poolNoCandidateHint')}`)
        : null}
      {/* 空状态：这一区一个账号都没有。账号池是**添加 PAT / 导入账号**的唯一入口，
          所以这里必须把话说清楚，而不是留一张没有行的表格让人猜去哪加。 */}
      {(pool?.accounts.length ?? 0) === 0
        ? h('p', { className: 'dsm-qoder-pool-empty', role: 'status' }, t('row.poolEmptyHint'))
        : null}

      {/* 成员选择就在这张表里完成：复选框即成员资格（workbuddy 的单表同构）。
          表头带全选/清空，默认全不选——什么都不勾绝不等于「全部」。 */}
      <div className="dsm-qoder-pool-members">
        <div className="dsm-qoder-pool-members-head">
          <div>
            <h4 className="dsm-qoder-pool-members-title">{t('row.poolMembersTitle')}</h4>
            <p className="dsm-qoder-pool-note">{t('row.poolMembersHint')}</p>
          </div>
          <div className="dsm-qoder-pool-members-actions">
            <span className="dsm-qoder-pool-hint">
              {t('row.poolSelectedCount', { count: effective.length, total: pool?.accounts.length ?? 0 })}
            </span>
            <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={pool?.accounts.length === 0 || !canEditPool} onClick={() => selectAll(true)}>{t('row.poolSelectAll')}</button>
            <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn" disabled={effective.length === 0 || !canEditPool} onClick={() => selectAll(false)}>{t('row.poolSelectNone')}</button>
          </div>
        </div>
        {/* 签到列只在区域真的支持签到时出现——空列会暗示「这个状态存在，只是
            未知」（workbuddy 同规）。 */}
        <div className={`dsm-qoder-pool-table${checkinOn ? ' dsm-qoder-pool-table-checkin' : ''}`}>
          <div className="dsm-qoder-pool-row dsm-qoder-pool-row-head">
            <span>{t('row.poolColumnAccount')}</span>
            <span>{t('row.poolColumnCredits')}</span>
            <span>{t('row.poolColumnProbe')}</span>
            {checkinOn ? <span>{t('row.poolColumnCheckin')}</span> : null}
            <span />
          </div>
          {(pool?.accounts ?? []).map(account => {
            const name = account.accountName === '' ? t('row.accountUnnamed') : account.accountName
            const excluded = exclusionText(t, account.excludedBy)
            const inPool = active.memberAccountIds.includes(account.accountId)
            return (
              <div
                key={account.accountId}
                className={`dsm-qoder-pool-row${account.current ? ' dsm-qoder-pool-row-current' : ''}`}
              >
                <span className="dsm-qoder-pool-account">
                  <label className="dsm-qoder-pool-check">
                    <input
                      type="checkbox"
                      checked={inPool}
                      disabled={!canEditPool}
                      aria-label={t('row.poolSelectAria', { accountName: name })}
                      onChange={(e) => toggleMember(account.accountId, e.target.checked)}
                    />
                  </label>
                  {/* 状态点：排除=红/琥珀、未测=灰、测过=绿/琥珀（workbuddy 同规）。 */}
                  <span className="dsm-qoder-usage-dot" style={{ background: stateColor(account) }} />
                  <span className="dsm-qoder-pool-account-name">
                    <b>{name}</b>
                    {/* 谁正在计费，用文字说出来：行底色只有 7% 透明度，
                        「到底哪一行」不能只靠颜色回答。 */}
                    {account.current ? <span className="dsm-qoder-pool-current-tag">{t('row.poolCurrentBadge')}</span> : null}
                    {/* 成员资格每行写明：未勾选账号的空积分/探针列，否则与
                        「勾了但还没数据」无法区分。 */}
                    <span className={inPool ? 'dsm-qoder-pool-member' : 'dsm-qoder-pool-not-member'}>
                      {inPool ? t('row.poolMember') : t('row.poolNotMember')}
                    </span>
                    {excluded === undefined
                      ? account.probe === undefined ? null : <span>{t('row.poolTestedAt', { at: formatProbeMoment(account.probe.atMs) })}</span>
                      : <span className="dsm-qoder-pool-excluded">{excluded}</span>}
                  </span>
                </span>
                <span className="dsm-qoder-pool-credits">
                  {account.credits === undefined
                    ? <span className="dsm-qoder-pool-unknown">{'—'}</span>
                    : <b>{String(account.credits)}</b>}
                  {account.expiringSoon !== undefined && account.expiringSoon > 0
                    ? <span className="dsm-qoder-pool-soon">{t('row.poolCreditSoon', { count: String(account.expiringSoon) })}</span>
                    : account.nearestExpiryMs === undefined ? null
                      : <span className="dsm-qoder-pool-soon-plain">{t('row.poolCreditNearest', { at: formatProbeMoment(account.nearestExpiryMs) })}</span>}
                </span>
                <span className="dsm-qoder-pool-probe" {...(account.probe?.message === undefined ? {} : { title: account.probe.message })}>
                  {/* 主行 = 结果 · 原因（workbuddy 的 probeLine 同规）：原因写进主行
                      而不是另做药丸——它回答的正是「为什么是现在这个结果」，与结果
                      同句读才顺；全文仍在行 title 里。 */}
                  <span className="dsm-qoder-pool-probe-main">
                    {[
                      probeLabelOf(t, account.probe, nowMs),
                      account.probe === undefined ? undefined : inlineProbeReason(account.probe.outcome, account.probe.message),
                    ]
                      .filter(part => part !== undefined && part !== '')
                      .join(' · ')}
                  </span>
                  {account.probe === undefined ? null : (
                    <span className="dsm-qoder-pool-probe-prov">
                      <span className={probeSourceClass(account.probe.source)}>
                        {probeSourceText(t, account.probe.source) ?? t('row.poolProbeSourceUnknown')}
                      </span>
                      <span className="dsm-qoder-pool-prov-sep">·</span>
                      <span className="dsm-qoder-pool-prov-age">{probeAgeText(t, account.probe.atMs, nowMs)}</span>
                      {/* 作用域：这条结论测的是**别的**模型时，必须说出来。
                          否则「可用」会被读成「对现在这个模型可用」——而 Qoder
                          按模型限流，同一个号完全可能 A 可用、B 被限。只说这一
                          点，不重复主行已经给出的结果。 */}
                      {account.probe.modelId === undefined || account.probe.modelId === ''
                        || account.probe.modelId === saved.targetModelId
                        ? null
                        : <>
                            <span className="dsm-qoder-pool-prov-sep">·</span>
                            <span
                              className="dsm-qoder-pool-probe-scope"
                              title={t('row.poolProbeOtherModelHint')}
                            >
                              {t('row.poolProbeOtherModel', { model: account.probe.modelId })}
                            </span>
                          </>}
                    </span>
                  )}
                </span>
                {/* 签到单元格（仅在有签到列时渲染）。**一格只说一句话**，四态：
                    · 没读到 → 「未知」（说「未签到」会与用户刚亲眼看到的领取结果矛盾）
                    · 已领取但上游没给开窗时刻 → 「已签到」（绝不编一个本地倒计时）
                    · 倒计时中 → **只有**「HH:MM:SS 后可再领」
                    · 到点 → **只有**「现在可以领取」

                    后两态**不再并排「已签到」**（用户实拍：「已签到 · 00:39:22 后刷新」）。
                    「已签到」说的是**上一窗**，而那个数字是**下一窗什么时候开** —— 两个
                    不同窗口的状态并排，读起来就是「今天已经签完了，可 39 分钟后又有事
                    可做」，自相矛盾。去掉它不丢任何事实：「**再**领」这个词本身就蕴含
                    「已经领过」。旧文案里的「后刷新」也一并改掉 —— 它字面说的是这一行
                    数据多久刷新，而数字其实是可再领的时刻。 */}
                {checkinOn
                  ? <span className="dsm-qoder-pool-checkin">
                      {account.checkedInToday === undefined
                        ? <span className="dsm-qoder-pool-unknown" title={t('row.poolNeverTested')}>{t('row.poolCheckinUnknown')}</span>
                        : account.checkedInToday
                          ? checkinCountdown.state === 'ticking'
                            ? <span className="dsm-qoder-pool-checkin-next" title={t('row.poolCheckinNextHint')}>
                                {t('row.poolCheckinNext', { countdown: checkinCountdown.text })}
                              </span>
                            : checkinCountdown.state === 'due'
                              ? <span className="dsm-qoder-pool-checkin-due" title={t('row.poolCheckinDueHint')}>{t('row.poolCheckinDue')}</span>
                              : <span className="dsm-qoder-pool-checked">{t('row.poolCheckedIn')}</span>
                          : t('row.poolNotCheckedIn')}
                    </span>
                  : null}
                <span className="dsm-qoder-pool-row-actions">
                  {/* 行内测试：在飞时**只**改这一行的按钮文字并锁住同类按钮，
                      不抬遮罩（workbuddy 同规：测试「keeps no veil」）。按钮自变
                      「测试中…」+ 禁用，就是这一行的轻提示——与删除按钮在飞的
                      「正在删除账号…」是同一套语言。测试类按钮全表互斥（任一行
                      在飞则其他行禁用），其余控件（勾选、下拉、保存、删除入口）
                      不受影响。 */}
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn"
                    title={rowTestingId === account.accountId ? t('row.poolTesting') : t('row.poolRowTest')}
                    aria-label={rowTestingId === account.accountId ? t('row.poolTesting') : t('row.poolRowTest')}
                    disabled={!canEditPool || batchBusy || rowTestBusy || targetMisses}
                    onClick={() => { void runTestBatch(account.accountId) }}
                  >
                    {rowTestingId === account.accountId ? t('row.poolTesting') : t('row.poolRowTest')}
                  </button>
                  {/* 移出池**不用按钮**：这一行的勾选框已经表达「是不是成员」，再给
                      一个只改同一件事的按钮，两处迟早会不一致（这正是此前「移除了
                      账号却还在」的由来）。取消勾选 + 保存 = 移出池，凭据留着。
                      这一列是**彻底删除**——另一个动作、另一种后果，所以要有
                      二次确认。 */}
                  {account.source !== 'vault'
                    ? null
                    : confirmDeleteId === account.accountId
                      ? (
                        <span className="dsm-qoder-pool-confirm" role="group" aria-label={t('row.poolDeleteConfirmAria', { accountName: name })}>
                          <span className="dsm-qoder-pool-confirm-text">{t('row.poolDeleteConfirm', { accountName: name })}</span>
                          <button
                            type="button"
                            className="dsm-btn dsm-btn-danger dsm-qoder-pool-small-btn"
                            disabled={removingId !== undefined}
                            onClick={() => { void runDeleteAccount(account.accountId) }}
                          >
                            {t('row.poolDeleteConfirmYes')}
                          </button>
                          <button
                            type="button"
                            className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn"
                            disabled={removingId !== undefined}
                            onClick={() => setConfirmDeleteId(undefined)}
                          >
                            {t('row.poolDeleteCancel')}
                          </button>
                        </span>
                      )
                      : (
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline dsm-qoder-pool-small-btn dsm-qoder-pool-delete-btn"
                          title={t('row.poolRowDeleteHint')}
                          aria-label={t('row.poolRowDeleteAria', { accountName: name })}
                          disabled={!canEditPool || removingId !== undefined}
                          onClick={() => { setConfirmDeleteId(account.accountId) }}
                        >
                          {removingId === account.accountId ? t('row.poolRowDeleting') : t('row.poolRowDelete')}
                        </button>
                      )}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {effective.length === 0
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolNoneSelected')} ${t('row.poolNoneSelectedHint')}`)
        : null}
      {/* 幽灵成员没有提示行：上面那个 effect 静默收敛名单（用户实拍：
          「你应该直接就清理掉，而不是再给我这么一个提示」）。 */}
      {dirty && !sameIds(active.memberAccountIds, saved.memberAccountIds)
        ? h('p', { className: 'dsm-qoder-pool-dirty' }, t('row.poolUnsavedMembers'))
        : null}

      {pool?.targetModelSource === 'none'
        ? h('p', { className: 'dsm-qoder-pool-warn', role: 'status' },
            `${t('row.poolTargetNone')} ${t('row.poolTargetNoneHint')}`)
        : null}
      {pool?.targetModelSource === 'stale' ? (
        <div className="dsm-qoder-pool-conflict">
          <span className="dsm-qoder-pool-conflict-main">
            <b>{t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })}</b>
            <span>{t('row.poolTargetStaleHint')}</span>
          </span>
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={!canEditPool}
            onClick={() => { editDraft(current => ({ ...current, targetModelId: '' })) }}
          >
            {t('row.poolTargetStaleClear')}
          </button>
        </div>
      ) : null}

      {actionError === undefined ? null
        : h('p', { className: 'dsm-qoder-pool-error', role: 'alert' }, actionError)}

      {/* Preferences（外壳与保存行由 RenderSettings 自己渲染，与 workbuddy 同构） */}
      <RenderSettings
        t={t}
        active={active}
        saved={saved}
        dirty={dirty}
        saving={saving}
        canEditPool={canEditPool}
        saveError={saveError}
        catalog={pool?.catalog}
        targetProvenance={targetProvenance}
        accountTools={accountTools}
        accounts={pool?.accounts ?? []}
        currentAccountId={currentAccountId}
        onSelectAccount={onSelectAccount}
        onEdit={editDraft}
        onSave={() => { void savePool() }}
        onDiscard={() => { setDraftPool(saved); setDraftRegion(region); setDirty(false); setSaveError(undefined) }}
      />

      {/* 这里**不再**重复「国内版与国际版互相独立」那句话（用户实拍：「都重复
          了」）：tab 栏下方已经有一行 `row.tabHint` 说明每个 tab 是独立供应商、
          一侧的改动不影响另一侧，而这一行只是把它换了个说法再说一遍。 */}

      {/* Activity log */}
      <div className="dsm-qoder-pool-log">
        <div className="dsm-qoder-pool-log-head">
          <span>{t('row.poolLogTitle')}</span>
          <button type="button" className="dsm-btn dsm-btn-outline dsm-qoder-pool-log-clear" onClick={() => { logStore.set(region, []); setLog([]) }}>{t('row.poolLogClear')}</button>
        </div>
        {log.length === 0
          ? <div className="dsm-qoder-pool-log-empty">{t('row.poolLogEmpty')}</div>
          : <div className="dsm-qoder-pool-log-body">
              {[...log].map((entry, index) => (
                <div key={`${entry.atMs}-${index}`} className="dsm-qoder-pool-log-row">
                  <span className="dsm-qoder-pool-log-time">{formatClock(entry.atMs)}</span>
                  <span className={`dsm-qoder-pool-log-text dsm-qoder-pool-log-${entry.tone}`}>{entry.text}</span>
                </div>
              ))}
            </div>}
      </div>
    </section>
  )
}

function RenderSettings(props: {
  t: Translate
  active: PoolPreferences
  /**
   * 宿主已知的真实偏好。`active` 是**草稿**（改了要按保存才生效），而
   * 「使用哪个账号」这一行立即生效、不走保存——它的在场判据必须跟真实状态，
   * 不能跟草稿。
   */
  saved: PoolPreferences
  dirty: boolean
  saving: boolean
  canEditPool: boolean
  saveError?: string | undefined
  /**
   * The region's pickable models, as objects rather than ids: the option label
   * carries the display name and the credit multiplier, so a manual choice is
   * both recognisable and priced before it is made.
   */
  catalog?: readonly QoderWebPoolModel[] | undefined
  /** 目标模型的来源一句话（「当前：xx（你指定）」），null 表示无话可说。 */
  targetProvenance: string | null
  /** 账号工具（添加 PAT / 导出导入），虚线框放在标题之下、说明行之上。 */
  accountTools?: ReactNode | undefined
  /** 池里的账号，供「使用哪个账号」下拉列出。 */
  accounts: readonly QoderWebPoolAccount[]
  /** 当前真正在服务的账号 id；undefined = 没有任何账号在生效。 */
  currentAccountId?: string | undefined
  /**
   * 池关闭时由用户手选服务账号。`undefined` 表示调用方不提供这个控件（此时
   * 整行不渲染）——这样「能不能改」只有一个真值来源，不必再传一个 flag。
   */
  onSelectAccount?: ((accountId: string) => void) | undefined
  onEdit: (update: (prev: PoolPreferences) => PoolPreferences) => void
  onSave: () => void
  onDiscard: () => void
}): ReactNode {
  const { t, active, saved, dirty, saving, canEditPool, saveError, catalog, targetProvenance, accountTools, accounts, currentAccountId, onSelectAccount, onEdit, onSave, onDiscard } = props
  // 同名计数只依赖账号列表，整块渲染算一次即可（每次 map 里重算就是 O(n²)）。
  const counts = nameCountsOf(accounts)
  return (
    <div className="dsm-qoder-pool-settings-wrap">
      {/* 设置区自己的小标题 + 脏标记（workbuddy 同构）：下面几行是草稿，
          与上方立即生效的表格区分开。 */}
      <div className="dsm-qoder-pool-head">
        <h3 className="dsm-qoder-pool-title">{t('row.poolSettingsTitle')}</h3>
        {dirty ? <span className="dsm-qoder-pool-dirty">{t('row.poolDirty')}</span> : null}
      </div>
      {/* 账号工具在说明行之前（workbuddy 同构）：它们立即生效，而说明行提到的
          是「下面这些偏好要点保存」，顺序颠倒会让读者以为工具也要保存。 */}
      {accountTools === undefined ? null : <div className="dsm-qoder-pool-tools">{accountTools}</div>}
      <p className="dsm-qoder-pool-note">{t('row.poolSettingsHint')}</p>
      <div className="dsm-qoder-pool-settings">
      {/* 「使用哪个账号」——**只在池确实关闭时**出现。
          判据用 `saved.enabled`（宿主已知的真实状态），**不是** `active.enabled`
          （草稿）：这一行立即生效、不走保存，若跟着草稿走，用户把开关拨到「开」
          但还没保存时，这一行会消失，而他其实还没关闭池；反过来拨到「关」时它
          又提前出现，仿佛现在就由它决定了。控件在不在，必须和「现在谁真正在
          选号」一致。
          位置在池开关之上：先回答「池关着时谁服务」，再回答「要不要让池接管」。 */}
      {saved.enabled || onSelectAccount === undefined || accounts.length === 0
        ? null
        : <div className="dsm-qoder-pool-set">
            <div className="dsm-qoder-pool-set-copy">
              <b>{t('row.poolManualAccountLabel')}</b>
              <span>{t('row.poolManualAccountHint')}</span>
            </div>
            <div className="dsm-qoder-pool-set-ctl">
              <select
                className="dsm-qoder-pool-select"
                value={currentAccountId ?? MANUAL_ACCOUNT_NONE}
                disabled={!canEditPool}
                aria-label={t('row.accountSelectAria')}
                onChange={(e) => {
                  // 哨兵值只用于显示「没有账号在生效」，选中它不是一个动作。
                  if (e.target.value === MANUAL_ACCOUNT_NONE) return
                  onSelectAccount(e.target.value)
                }}
              >
                {/* 「没有账号在生效」是真实状态（保存的 id 已失效、刷新失败）。
                    没有匹配项时受控 select 会静默显示第一项——那就是「看着正常，
                    但不是真正在跑的」那种混淆，正是这个控件要避免的。
                    哨兵用非空串而非 `''`：`''` 是「自动」这个**真实选项**的值，
                    两者共用会让 select 在无生效账号时显示成「自动」，等于宣称
                    用户选了自动。 */}
                {currentAccountId === undefined
                  ? <option value={MANUAL_ACCOUNT_NONE} disabled>{t('row.poolManualAccountNone')}</option>
                  : null}
                {/* 「自动」保留：qoder 的账号来源有 settings / env / vault 三级，
                    `state.accountId` 为空时正是按这个顺序回退，所以它不是一个
                    占位选项，而是一个真的第三态。workbuddy 没有这条回退链，它
                    的下拉里没有自动项，这里不能照抄。 */}
                <option value="">{t('row.accountSelectAuto')}</option>
                {accounts.map(account => (
                  <option key={account.accountId} value={account.accountId}>
                    {poolAccountLabel(t, account, counts)}
                  </option>
                ))}
              </select>
            </div>
          </div>}
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolEnabled')}</b>
          <span>{t('row.poolEnabledHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <label className="sw">
            <input
              type="checkbox"
              checked={active.enabled}
              disabled={!canEditPool}
              onChange={(e) => onEdit(prev => ({ ...prev, enabled: e.target.checked }))}
            />
            <span className="sw-track" />
          </label>
        </div>
      </div>
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolTargetLabel')}</b>
          {/* 来源先行：先回答「当前是谁、是不是我选的」，再解释自动怎么工作
              （workbuddy 同规）。 */}
          <span>{targetProvenance === null ? null : `${targetProvenance} `}{t('row.poolTargetHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <select className="dsm-qoder-pool-select" value={active.targetModelId} disabled={!canEditPool} onChange={(e) => onEdit(prev => ({ ...prev, targetModelId: e.target.value }))}>
            <option value="">{t('row.poolTargetAutoOption')}</option>
            {/* 已保存但已不在目录里的 id 需要它**自己**的一个 option：否则这个受控
                select 找不到匹配项，浏览器会退回显示第一项（「自动」），而存的值仍是
                旧 id——显示与取值就此分叉，下一次保存又把旧 id 写回去。设为 disabled
                使其不可能被重新选中，同时让用户看见到底存的是什么。 */}
            {active.targetModelId !== '' && !(catalog ?? []).some(m => m.id === active.targetModelId)
              ? <option value={active.targetModelId} disabled>{t('row.poolTargetStaleOption', { model: active.targetModelId })}</option>
              : null}
            {/* 显示名 + 倍率，与 workbuddy 同构（`名字 (x0.79)`）：选项文本此前
                直接渲染模型 id（`qmodel_latest`），既不是用户认得的名字，也让
                「这次测试花不花积分」无从判断——而那正是选目标的全部意义。 */}
            {(catalog ?? []).map(model => (
              <option key={model.id} value={model.id}>
                {model.creditMultiplier === undefined
                  ? model.name
                  : `${model.name} (x${model.creditMultiplier.toFixed(2)})`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="dsm-qoder-pool-set">
        <div className="dsm-qoder-pool-set-copy">
          <b>{t('row.poolProbeSizeLabel')}</b>
          <span>{t('row.poolProbeSizeHint')}</span>
        </div>
        <div className="dsm-qoder-pool-set-ctl">
          <select className="dsm-qoder-pool-select" value={String(active.probeInputTokens)} disabled={!canEditPool} onChange={(e) => onEdit(prev => ({ ...prev, probeInputTokens: Number(e.target.value) }))}>
            <option value="0">{t('row.poolProbeSizeDefault')}</option>
            {PROBE_INPUT_TOKEN_CHOICES.map(tokens => (
              <option key={String(tokens)} value={String(tokens)}>{t('row.poolProbeSizeOption', { tokens: String(Math.round(tokens / 1000)) })}</option>
            ))}
          </select>
        </div>
      </div>
      </div>
      {/* 保存行是那张带边框的设置卡片的**兄弟**，不在它里面（workbuddy 同构）：
          放进卡片就落进 `overflow:hidden` 的圆角边框内，左端的仓库链接会紧贴
          边框，而上方的「启用账号池」内缩 14px——同一条左对齐线断成两截（用户
          实拍：「还是不对」）。它自带的 border-top 也正是这一行与卡片之间的分隔。 */}
      <div className="dsm-qoder-pool-save-bar">
        {/* 仓库链接在保存行左端（workbuddy 同构）：与模型保存行同一个位置，
            不给它单独一行。 */}
        <a
          className="dsm-qoder-usage-cheer"
          href={QODER_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('row.cheer')}
          <span className="dsm-qoder-usage-cheer-star" aria-hidden="true">★</span>
        </a>
        <div className="dsm-qoder-pool-save-buttons">
          {saveError === undefined ? null : <span className="dsm-qoder-pool-pending">{saveError}</span>}
          {/* 「放弃修改」恒在（未改动时禁用），与模型保存行一致——条件渲染会让
              这一行在改动/还原之间左右跳动。 */}
          <button type="button" className="dsm-btn dsm-btn-outline" disabled={!canEditPool || saving || !dirty} onClick={onDiscard}>{t('row.poolDiscard')}</button>
          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!canEditPool || saving || !dirty} onClick={onSave}>
            {saving ? t('row.poolSaving') : t('row.poolSaved')}
          </button>
        </div>
      </div>
    </div>
  )
}

function parseTestRow(value: unknown): QoderWebPoolTestRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const accountId = typeof row['accountId'] === 'string' ? row['accountId'] : undefined
  const accountName = typeof row['accountName'] === 'string' ? row['accountName'] : undefined
  const result = row['result']
  if (accountId === undefined || accountName === undefined || typeof result !== 'object' || result === null) return undefined
  return { accountId, accountName, result: result as QoderWebProbeResult }
}

function parseCheckinRow(value: unknown): QoderWebPoolCheckinRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const accountId = typeof row['accountId'] === 'string' ? row['accountId'] : undefined
  const accountName = typeof row['accountName'] === 'string' ? row['accountName'] : undefined
  const status = row['status']
  if (accountId === undefined || accountName === undefined) return undefined
  if (status !== 'claimed' && status !== 'already' && status !== 'failed') return undefined
  return {
    accountId,
    accountName,
    status,
    ...(typeof row['credit'] === 'number' ? { credit: row['credit'] } : {}),
    ...(typeof row['validityDays'] === 'number' ? { validityDays: row['validityDays'] } : {}),
    ...(typeof row['message'] === 'string' ? { message: row['message'] } : {}),
  }
}

/** 一行签到日志的文案（三态各说各的，`already` 不能写成失败）。 */
function checkinLogText(t: Translate, row: QoderWebPoolCheckinRow): string {
  if (row.status === 'claimed') {
    return row.credit === undefined
      ? t('row.poolLogCheckinClaimed', { accountName: row.accountName })
      : t('row.poolLogCheckinClaimedAmount', { accountName: row.accountName, credit: String(row.credit) })
  }
  if (row.status === 'already') {
    return t('row.poolLogCheckinAlready', { accountName: row.accountName })
  }
  // 失败原因理论上总有（上游错误消息）；万一没有就退回「未知」这个通用词，
  // 而不是让整行显示成 `{message}`。
  return t('row.poolLogCheckinFailed', {
    accountName: row.accountName,
    message: row.message ?? t('row.poolCheckinUnknown'),
  })
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every(id => set.has(id))
}

/**
 * 溯源药丸的样式类（workbuddy 的 probeLabel 同规）：来源未知用带描边的
 * 「未知」态——它必须与「测试写入」的默认态看得出区别，否则一条旧记录
 * 看起来就像刚测过。
 */
function probeSourceClass(source: 'test-batch' | 'live-request' | undefined): string {
  if (source === undefined) return 'dsm-qoder-pool-prov-tag dsm-qoder-pool-prov-unknown'
  return source === 'live-request'
    ? 'dsm-qoder-pool-prov-tag dsm-qoder-pool-prov-live'
    : 'dsm-qoder-pool-prov-tag'
}

/**
 * 成员行状态点的颜色（workbuddy 的 stateColor 同规）：被排除的看性质——
 * 限流/不可用是自己会好的等待态（琥珀），凭据被拒等需要用户动手（红）；
 * 未测灰、测过按结果绿/琥珀。
 */
function stateColor(account: QoderWebPoolAccount): string {
  if (account.excludedBy !== undefined) {
    return account.excludedBy === 'rate-limited' || account.excludedBy === 'unavailable'
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : 'var(--dsw-alias-state-error-primary, #ef4444)'
  }
  if (account.probe === undefined) return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return account.probe.outcome === 'ok'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : 'var(--dsw-alias-state-warn-primary, #f59e0b)'
}

/** 统计同名字号出现次数（`accountName` 为空串也算一组，显示名会是「未命名」）。 */
function nameCountsOf(accounts: readonly QoderWebPoolAccount[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const account of accounts) {
    counts.set(account.accountName, (counts.get(account.accountName) ?? 0) + 1)
  }
  return counts
}

/**
 * 「使用哪个账号」下拉里一个账号显示成什么。
 *
 * 同名账号必须还能分辨：同一个邮箱重新签发 PAT 会得到**两条**记录（id 由 PAT
 * 推导，是不同的），两条显示名一模一样。只显示名字的话，「我当前在用哪一条」
 * 这个问题的答案是「看不出」——用户实拍的就是这种两条同名、一条已过期的情况。
 * 重名时补 id 尾号（id 形如 `pat-5d76517ac7699f87`，末 4 位足够区分）。
 *
 * 这里**不**再加「使用中」后缀：下拉的选中值本身就是当前在服务的账号，头部还
 * 有一枚 `row.poolCurrentHeader` 标签，同一个事实说三遍反而是噪音。
 */
function poolAccountLabel(
  t: Translate,
  account: QoderWebPoolAccount,
  counts: ReadonlyMap<string, number>,
): string {
  const base = account.accountName === '' ? t('row.accountUnnamed') : account.accountName
  return (counts.get(account.accountName) ?? 0) > 1
    ? `${base} · ${account.accountId.slice(-4)}`
    : base
}
