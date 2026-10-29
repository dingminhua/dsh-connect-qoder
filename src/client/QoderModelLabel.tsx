/**
 * The HOST's model picker label: the catalog name plus this plugin's badges.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— `WorkBuddyModelLabel.tsx` 的整体形态（WHY A SLOT / WHY THE BADGE
 *   BELONGS HERE AT ALL / 共享分钟时器 / provider→region 映射）沿用自该项目；
 *   徽标复用卡片已有的 `dsm-qoder-model-promo` 家族类，不另造一套视觉。
 *
 * 徽标为什么属于选择器（issue #12，workbuddy 文件头的判断）：选择器才是做选择
 * 的地方，「今晚打折」「免费」都是选择判据；卡片是设置面 —— 读到徽标时模型早
 * 选完了。这不是装饰搬家，是把同一个上游事实挪到它还能改变决定的位置。
 *
 * 与上游的两处有意差异：
 *
 * 1. **组件由工厂产出、按 fiber 捕获 `slots`**（issue #12 报告的补丁用的是模块级
 *    变量，那是真缺陷）：bundle 是单例，宿主若以多个 fiber 各跑一次 `apply`，
 *    后跑的会覆盖前者 —— 外来 provider 的委托就会调到**错误宿主**的注册表。
 *    工厂把 `slots` 关进每次注册各自的闭包，覆盖在结构上不可能。
 * 2. **委托渲染成子元素而不是直接调用**（报告的补丁直接 `other(props)` 调）：
 *    被委托的组件（workbuddy 的标签自己就有 `useState`/`useEffect`）作为函数
 *    调用时，它的 hooks 会混进**我们**的 hook 序列 —— 同一槽位在外来/本插件
 *    provider 之间切换时 hook 数量一变，React 直接崩。`jsx(Other, …)` 让它跑在
 *    自己的 fiber 里，两条路径的 hook 数量与顺序都恒定。
 *
 * @module dsh-connect-qoder/client/QoderModelLabel
 */
import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { promoDisplayAt } from '../promo.ts'
import type { QoderPromotion } from '../promo.ts'
import { hostLanguage, promoBadgeLabel, promoBadgeTooltip } from './promo-badge.ts'
import { QODER_COMPOSER_PROVIDERS } from './ComposerCredits.tsx'
import { QODER_USAGE_PATH, withQoderRegionFastDetail } from '../status-paths.ts'
import type { QoderWebModel, QoderWebRegion, QoderWebUsage } from '../status-paths.ts'
import type { Translate } from './locales.ts'

/** The slot key（宿主 model-selection 声明的 single 槽，ownerProps 见 `QoderModelLabelProps`）. */
export const QODER_MODEL_LABEL_SLOT = 'conversation.input.model.label'

/**
 * 账本里一条注册的最小形状。
 *
 * `locale` 就是**被委托组件自己声明的命名空间**——委托时必须按它绑一个 `t`
 * 递给对方，理由见 {@link createQoderModelLabel} 的委托段（issue #23）。
 */
export interface QoderModelLabelEntry {
  component: unknown
  locale?: string | undefined
}

/** The minimal registry face the delegation needs: the RAW ledger view. */
export interface QoderModelLabelSlots {
  entries(key: string): readonly QoderModelLabelEntry[]
  /**
   * 按命名空间绑翻译器（宿主 `ctx.locale.bind`）。
   *
   * 缺席 = 拿不到 locale 面（单测 / 老宿主）：此时**不委托**，落回裸名字。
   * 宁可少一枚别家的徽标，也不要递一个会让对方抛错的对象——那正是 #23 的
   * 现场：整个 label 子树陪葬。
   */
  bindLocale?(ns: string): Translate
}

/**
 * Props the host's picker hands the label slot —— ownerProps 契约，逐字：
 * `{ provider, model, placement, selected }`。`t` 是渲染器按注册时声明的
 * `locale` 注入的标准 seat（单测与降级路径下可能缺席，所以可选）。
 */
export interface QoderModelLabelProps {
  provider: { id: string }
  model: { id: string, name: string }
  placement: string
  /** 宿主恒给；类型允许缺席是「拿不到的线也别崩」（exactOptionalPropertyTypes 下 `?:` 不含 undefined）。 */
  selected?: boolean | undefined
  t?: Translate | undefined
}

/** 一分钟：窗口边界的翻面与快照的保鲜共用它（workbuddy 同规）。 */
const TICK_MS = 60_000

/**
 * 共享分钟时器：挂在选择器上的每一行都是一个组件实例，每行一个 timer 会在打开
 * 的菜单里堆出几十条。这里一个时器广播给所有实例，最后一个退订时关掉。
 * `unref` 防测试进程被它吊着（浏览器里没有这个方法，可选链）。
 */
const tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined

function subscribeMinute(fn: () => void): () => void {
  tickListeners.add(fn)
  if (tickTimer === undefined) {
    tickTimer = setInterval(() => {
      for (const listener of [...tickListeners]) listener()
    }, TICK_MS)
    ;(tickTimer as { unref?(): void }).unref?.()
  }
  return () => {
    tickListeners.delete(fn)
    if (tickListeners.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// usage 快照（区域级共享缓存 + 单飞）
// ---------------------------------------------------------------------------

/**
 * 行数据读卡片自己的路由，但带 `detail=fast`。
 *
 * 为什么不是 `full`：full 文档在路由侧会触发一次**上游重读**
 * （`freshUsageEntryOf`）—— 选择器每开一次都把「读别人的模型列表」变成一次
 * 真实的积分/配额请求，而这份数据的权威刷新者是卡片自己的 60 秒轮询。fast
 * 文档回答的是**本地已有状态**，`models[]` 连同每行的 `promotion` / `isFree`
 * 都在里面（issue #12 实机核对）。这个组件只是那份缓存的第二个读者。
 *
 * 缓存按区域共享 + 单飞：菜单里几十行同区只发一次请求；TTL 与分钟时器同长，
 * 打开选择器期间每分钟至多一次轻量读。
 */
type RegionSnapshot = { models?: readonly QoderWebModel[] | undefined, atMs: number }
const snapshots = new Map<QoderWebRegion, RegionSnapshot>()
const inFlight = new Map<QoderWebRegion, Promise<RegionSnapshot | undefined>>()

const SNAPSHOT_TTL_MS = 60_000

function freshEnough(region: QoderWebRegion): RegionSnapshot | undefined {
  const hit = snapshots.get(region)
  return hit !== undefined && Date.now() - hit.atMs < SNAPSHOT_TTL_MS ? hit : undefined
}

function fetchSnapshot(region: QoderWebRegion): Promise<RegionSnapshot | undefined> {
  const running = inFlight.get(region)
  if (running !== undefined) return running
  const task = fetch(withQoderRegionFastDetail(QODER_USAGE_PATH, region), {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
    .then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as QoderWebUsage
      // 只有 signed-in 那一支带 models；其余状态保留上一份快照（宁缺勿错地旧，
      // 也不把徽标在「暂时读不到」时抹掉 —— 消失比晚到更像坏掉了）。
      const snapshot: RegionSnapshot | undefined = value.status === 'signed-in'
        ? { models: value.models, atMs: Date.now() }
        : undefined
      if (snapshot !== undefined) snapshots.set(region, snapshot)
      return snapshot
    })
    // 失败保留旧快照（宁可旧一点也不要空白），不缓存 rejected promise。
    .catch((): RegionSnapshot | undefined => undefined)
    .finally(() => { inFlight.delete(region) })
  inFlight.set(region, task)
  return task
}

/** 测试缝：清掉跨用例的模块级缓存（vitest 同文件共享 import 图）。 */
export function __resetModelLabelCacheForTests(): void {
  snapshots.clear()
  inFlight.clear()
  tickListeners.clear()
  if (tickTimer !== undefined) {
    clearInterval(tickTimer)
    tickTimer = undefined
  }
}

/**
 * 按选择器给来的 id 找 usage 行：先 key，再显示名。
 *
 * 判据与 host 侧 `catalog.keyOf` 同规（宿主把目录的哪一列当 id 不由我们决定），
 * 两列都认才不会静默丢徽标。找不到返回 undefined —— 整行只剩裸名字，不报错。
 */
export function findUsageRow(
  models: readonly QoderWebModel[] | undefined,
  id: string,
): QoderWebModel | undefined {
  return models?.find(row => row.key === id || row.name === id)
}

// ---------------------------------------------------------------------------
// 徽标
// ---------------------------------------------------------------------------

/**
 * 活动徽标：卡片那一半的复用 —— 同一个 class、同一个三态、同一句悬停。
 *
 * `live` 实心，`pending` 灰显虚线并前缀「几点生效」，`none` 不画 —— 全部来自
 * `promoDisplayAt`（#11），两个表面永不打架。compact（菜单行比 trigger 窄）
 * 加一个修饰类限宽，徽标文字自己省略号。
 */
function QoderModelLabelPromoChip(props: {
  promo: QoderPromotion
  language: string
  compact: boolean
  t: Translate
}): ReactElement | null {
  const { promo, language, compact, t } = props
  const display = promoDisplayAt(promo, new Date())
  if (display === 'none') return null
  const label = promoBadgeLabel(promo, language)
  if (label === undefined) return null
  const pending = display === 'pending'
  const start = promo.window?.start
  // 与卡片同规：灰显必须说得出「几点生效」，说不出就整枚不画。
  if (pending && start === undefined) return null
  const tip = promoBadgeTooltip(promo, language)
  const title = pending
    ? [t('row.promoPending', { start }), tip].filter(part => part !== '').join(' · ')
    : tip
  const classes = ['dsm-qoder-model-promo']
  if (pending) classes.push('dsm-qoder-model-promo-pending')
  if (compact) classes.push('dsm-qoder-model-label-promo')
  return (
    <span
      className={classes.join(' ')}
      title={title === '' ? undefined : title}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 组件工厂
// ---------------------------------------------------------------------------

/**
 * 产出**本 fiber** 的标签组件。委托（single 槽只有一个座位）的取舍：
 *
 * - 宿主只渲染座位上的第一条注册。workbuddy 的标签（倍率后缀/忙图标）与 1017
 *   参考实现都注册在同一槽的默认优先级；qoder 想给自己的模型加徽标就必须抢在前
 *   面（priority 升序、小者渲染 ⇒ 取 -1），同时**把外来 provider 原样交还**，
 *   否则别人的标签在我们到场的那一刻集体消失（#12 报告本地实测踩过）。
 * - 交还靠原始账本 `entries()`：`entriesOfSlot()` 对 single 槽去重后只剩第一条
 *   （自己），拿不到别人。
 * - 两个都委托的插件理论上会互相委托成环；当前生态（workbuddy、1017 参考）都是
 *   「渲染裸名」的终点型组件，不成环。真出现互委托时 React 的最大更新深度会拦下
 *   它，宿主把抛错的 entry 一次性弃权（`reportEntryError` ⇒ 下一帧换幸存者），
 *   不会死循环。
 *
 * ## 委托必须把对方**自己命名空间的 `t`** 递过去（issue #23）
 *
 * 宿主对 `t` 的注入是「每个 entry 按自己注册时声明的 `locale`，由框架塞进 kit」
 * （`scoped-slots.tsx` 的 `if (entry.locale !== undefined) kit['t'] = localeSeat(...)`）。
 * 绕过框架直接 `jsx(Other, {...ownerProps})` 就没这个机会，于是：
 *
 * - 对方的组件若**无条件**调用 `t(...)`（宿主内置的 `DeepSeekModelLabel` 正是），
 *   立刻 `TypeError: t is not a function`；
 * - 宿主错误边界接住后**弃权**该 entry，整片 label 槽回退成裸名字 —— 触发按钮、
 *   菜单当前值、每个列表行一起死，用户零信号。
 *
 * 所以这里按 `entry.locale` 用 `ctx.locale.bind(ns)` 替对方绑一个 `t`。**不是**
 * 转发我们自己的 `t`：那会把我们的 `settings.qoder` 字典当成对方的字典用，
 * 对方的 key 查不到就回落成字面键名（`badge.label` 直接画在界面上）。
 *
 * 拿不到 locale 面（`bindLocale` 缺席：单测 / 老宿主）时**不委托**，落回裸名字：
 * 少一枚别家的徽标，好过整片槽被一个 TypeError 打掉。
 *
 * 委托仍然渲染成**子元素**（见文件头第 2 条）：直接函数调用会把对方的 hooks
 * 混进我们的序列，provider 切换时 hook 数量变化直接崩。
 */
export function createQoderModelLabel(
  slots: QoderModelLabelSlots,
): (props: QoderModelLabelProps) => ReactElement {
  const QoderModelLabel = (props: QoderModelLabelProps): ReactElement => {
    const { provider, model, placement, selected, t } = props
    const region: QoderWebRegion | undefined = QODER_COMPOSER_PROVIDERS[provider.id]

    // hooks 必须无条件跑在最前：同一槽位实例的 provider 可以外来↔本插件切换
    // （列表重排、模型增删），分支提前 return 会让 hook 数量变化 —— 直接崩。
    // 非本插件的行多跑两个无害的 hook（不 fetch、不订时器），是稳定换来的代价。
    const [snapshot, setSnapshot] = useState<RegionSnapshot | undefined>(
      () => (region === undefined ? undefined : freshEnough(region) ?? snapshots.get(region)),
    )
    const [, setTick] = useState(0)
    useEffect(() => {
      if (region === undefined) return undefined
      let alive = true
      const apply = (next: RegionSnapshot | undefined): void => {
        if (alive && next !== undefined) setSnapshot(next)
      }
      if (freshEnough(region) === undefined) void fetchSnapshot(region).then(apply)
      const unsubscribe = subscribeMinute(() => {
        // 分钟翻面：先重读时钟让徽标三态现算，再顺带保鲜快照（同长，一次不多问）。
        setTick(count => count + 1)
        void fetchSnapshot(region).then(apply)
      })
      return () => { alive = false; unsubscribe() }
    }, [region])

    // 唯一一处跨插件调用，也是「不做插件联动」的唯一例外（见 docs/DESIGN.md
    // 「一、边界：不做什么」）：single 槽只容一个占位者，占了槽就得把别家 provider
    // 的行还给它的标签组件——只经过宿主公开的槽位账本与 ownerProps，不按名字找人。
    const foreign = region === undefined
    if (foreign) {
      const entries = slots.entries(QODER_MODEL_LABEL_SLOT)
        .filter(entry => entry.component !== QoderModelLabel && typeof entry.component === 'function')
      const other = entries[0]
      // 没有可委托的组件，或拿不到 locale 面 → 裸名字（也是宿主的 fallback）。
      if (other === undefined || slots.bindLocale === undefined) return <span>{model.name}</span>
      const Other = other.component as (p: QoderModelLabelProps) => ReactNode
      // **对方自己命名空间的 t**（issue #23）：宿主按 entry 的 locale 注入，
      // 我们绕过框架直接渲染，就得自己替它绑。
      //
      // 绑不出来（命名空间没注册 / 面缺席）时**不委托**、落回裸名字 —— 不能
      // 带着 `t: undefined` 硬渲染：对方若无条件调用 t，抛错会把整片 label 槽
      // 打掉，那正是 #23 的后果。少一枚别家的徽标比整片消失好。
      let otherT: Translate | undefined
      if (other.locale !== undefined && other.locale !== '') {
        try {
          otherT = slots.bindLocale(other.locale)
        } catch {
          return <span>{model.name}</span>
        }
      }
      return (
        <Other
          provider={provider}
          model={model}
          placement={placement}
          selected={selected}
          {...otherT === undefined ? {} : { t: otherT }}
        />
      )
    }

    const compact = placement !== 'trigger'
    const row = findUsageRow(snapshot?.models, model.id)
    const language = hostLanguage(t)
    const translate: Translate = t ?? ((key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`)
    return (
      <span className={compact ? 'dsm-qoder-model-label dsm-qoder-model-label-compact' : 'dsm-qoder-model-label'}>
        {/* 名字原样在位：宿主契约是「addition 渲染在旁边，名字归宿主」，永不替换。 */}
        <span>{model.name}</span>
        {row?.promotion === undefined
          ? null
          : <QoderModelLabelPromoChip promo={row.promotion} language={language} compact={compact} t={translate} />}
        {row?.isFree !== true
          ? null
          : <span className="dsm-qoder-model-meta-tag" title={translate('row.modelFreeHint')}>{translate('row.modelFree')}</span>}
      </span>
    )
  }
  return QoderModelLabel
}
