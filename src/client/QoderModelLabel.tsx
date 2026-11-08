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
 * ## 三处出口，一条底线
 *
 * 本组件占的是 single 槽，**所有** provider 的行都从这里出去：
 *
 * | 行 | 出口 |
 * | --- | --- |
 * | 本插件的 provider | 自己的标签（名字 + 活动徽标 + 免费标记），见下方 |
 * | 别家 provider，账本里有可委托的组件 | `jsx(Other, ownerProps)`，把对方自己的 `t` 绑好递过去 |
 * | 别家 provider，交不出去 | `ForeignModelLabel`：名字 + 该模型自带的 `model.badge` |
 *
 * 第三条那一格此前是裸名字。`docs/MODEL-LABEL-SPEC.md` §4 的结论是它必须复现
 * 宿主 fallback 的「名字 + 可选胶囊」：我们占了槽，宿主那句 fallback 就再也不会
 * 执行，只画名字等于把别家挂在目录里的胶囊抹掉。委托仍然是首选（它保住了别人的
 * 完整装饰），只是退路不再是「什么都不画」。
 *
 * 底线是这一支**绝不抛、绝不发请求**：它一抛，宿主会把整个组件从那一格摘掉，
 * 整片模型标签换成别家或裸名字。
 *
 * @module dsh-connect-qoder/client/QoderModelLabel
 */
import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { promoDisplayAt } from '../promo.ts'
import type { QoderPromotion } from '../promo.ts'
import { hostLanguage, promoBadgeLabel, promoBadgeTooltip } from './promo-badge.ts'
import { ForeignModelLabel } from './host-badge.tsx'
import { QODER_COMPOSER_PROVIDERS } from './ComposerCredits.tsx'
import { QODER_USAGE_PATH, withQoderRegionFastDetail } from '../status-paths.ts'
import type { QoderWebModel, QoderWebRegion, QoderWebUsage } from '../status-paths.ts'
import type { Translate } from './locales.ts'

/** The slot key（宿主 model-selection 声明的槽，ownerProps 见 `QoderModelLabelProps`）. */
export const QODER_MODEL_LABEL_SLOT = 'conversation.input.model.label'

/**
 * 本插件拥有的每一个 provider id。
 *
 * 导出是因为 keyed 宿主上「一条注册 = 一个 provider」：注册侧需要的清单必须与
 * 组件判定「这行是不是我的」用的是同一份，否则两处字面量迟早漂移。由
 * `QODER_COMPOSER_PROVIDERS` 推导而不是另写一遍——那正是本仓库已经维护的那张表。
 */
export const QODER_MODEL_LABEL_PROVIDERS: readonly string[] = Object.keys(QODER_COMPOSER_PROVIDERS)

/**
 * 本插件在这个 single 槽上的注册优先级。
 *
 * **必须小于 -100**，那是 workbuddy 的 `MODEL_LABEL_PRIORITY`。宿主的 single 槽
 * 只渲染一条注册，按 priority **升序取首条**（小者先）。所以「排在哪」就是
 * 「能不能被看见」。
 *
 * 为什么非要排在它前面：workbuddy 是**终点型**组件 —— 它的文件头明确写着
 * `does not read the slot ledger, does not look for another plugin's
 * registration, and does not render another plugin's component`，它不会把座位
 * 交还给别人。此前这里是 -1（注释误以为对方用的是默认的 0），于是 workbuddy
 * 稳稳抢在前面，**qoder 的促销胶囊在模型选择器里一次都没显示过**（用户实拍：
 * 卡片里有「错峰 4 折」，选择器里没有）。
 *
 * 取 **-101** 而不是一个大得多的负数：只争一格，把身后的位置留给将来任何正常
 * 的插件。这条优先级只影响「这一行由谁画」，不会动到别人的 provider 行 ——
 * 本组件会把非 qoder 的行委托回去（见 `createQoderModelLabel`）。
 *
 * keyed 宿主上这条数值的含义变了、数值不必变。宿主把槽声明成 `keyed` 后，每条
 * 注册按 provider id 各占一格，priority 不再决定「谁可见」，只剩「同一格内谁先」
 * （两个插件抢同一个 provider id：同值抛错、低者渲染）。于是与 workbuddy 的
 * `-105`、trae 的 `-102` 之间不再有压制关系——**停战不是靠再往下压，是靠换
 * 槽的基数**。`-101` 因此保留为「本插件自己那两格的排序」，既不下探也不改回。
 */
export const QODER_MODEL_LABEL_PRIORITY = -101

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
  model: {
    id: string
    name: string
    /**
     * The model's own catalog badge, if its provider published one.
     *
     * 宿主 0.2.2 起把模型目录里的每一项整个展开成这组 props，所以同族插件在**它
     * 自己的** `adapter.listModels()` 里挂上的 `LlmModelInfo.badge` 会从这里到达。
     * 类型写成 `unknown` 而不是 `HostModelBadge`：这一格是**别人**的数据，我们
     * 读不懂的形状必须能安全退化（`host-badge.tsx` 的 `drawableHostBadge`）。
     * 0.2.2 之前它永远缺席，两种情况在运行时不可区分 —— 所以没有任何版本分支。
     */
    badge?: unknown
  }
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
 *   面（priority 升序、小者渲染 ⇒ 取 -101，必须小于 workbuddy 的 -100，见
 *   {@link QODER_MODEL_LABEL_PRIORITY}），同时**把外来 provider 原样交还**，
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
    //
    // 但「交还」有时交不出去（账本里没有别人、拿不到 locale 面、对方要求的
    // 命名空间绑不出来）。这些情况下**不能只画裸名字**：宿主自己的 fallback 在
    // 0.2.2 起是「名字 + 该模型自带的 model.badge」，我们占了槽，那句 fallback 就
    // 再也不会执行 —— 只画名字等于把别家挂在目录里的胶囊一起抹掉。所以每一条
    // 退路都落到 {@link ForeignModelLabel}（顺序、文案、退化规则见那里与
    // docs/MODEL-LABEL-SPEC.md §4）。
    //
    // 这一支是**纯函数**：不发请求、不读快照、不起定时器。一个菜单可能同时有二十
    // 行别家的模型，二十个请求会随「打开选择器」这个动作一起发出去。
    const foreign = region === undefined
    if (foreign) {
      const entries = slots.entries(QODER_MODEL_LABEL_SLOT)
        .filter(entry => entry.component !== QoderModelLabel && typeof entry.component === 'function')
      const other = entries[0]
      // 没有可委托的组件，或拿不到 locale 面 → 自己的 fallback（名字 + 胶囊）。
      if (other === undefined || slots.bindLocale === undefined) {
        return <ForeignModelLabel model={model} placement={placement} t={t} />
      }
      const Other = other.component as (p: QoderModelLabelProps) => ReactNode
      // **对方自己命名空间的 t**（issue #23）：宿主按 entry 的 locale 注入，
      // 我们绕过框架直接渲染，就得自己替它绑。
      //
      // 绑不出来（命名空间没注册 / 面缺席）时**不委托**、落回自己的 fallback ——
      // 不能带着 `t: undefined` 硬渲染：对方若无条件调用 t，抛错会把整片 label 槽
      // 打掉，那正是 #23 的后果。少一枚别家的徽标比整片消失好。
      let otherT: Translate | undefined
      if (other.locale !== undefined && other.locale !== '') {
        try {
          otherT = slots.bindLocale(other.locale)
        } catch {
          return <ForeignModelLabel model={model} placement={placement} t={t} />
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
    // 位置规则：**胶囊永远在名字后面，不随 placement 换边**。
    //
    // 这里曾经是「自己的行永远把胶囊放在名字后」，而外来行按 placement 换边 —— 同一份
    // 菜单里两种摆法并存：别家模型是「胶囊 名字」，自家模型是「名字 胶囊」。这不是
    // 审美差异，是两条分支各写了一套顺序。
    //
    // 后来的修法是「自己行也跟着换边」，与宿主 fallback 对齐；但那样又有了新问题：
    // 宿主 fallback 只在**没人占格**时出现，一旦本插件赢下这一格，全菜单都由本插件画，
    // 于是「换边」不再带来任何好处，只剩「同一份菜单里胶囊位置会变」这一个坏处。
    // 现在的规则是**所有行、所有 placement 一律在后**，见 `docs/MODEL-LABEL-SPEC.md`。
    const promo = row?.promotion === undefined
      ? null
      : <QoderModelLabelPromoChip promo={row.promotion} language={language} compact={compact} t={translate} />
    // 免费标签也在最后：它说的是**模型属性**（这个模型不消耗积分），不是限时事件。
    const freeTag = row?.isFree !== true
      ? null
      : <span className="dsm-qoder-model-meta-tag" title={translate('row.modelFreeHint')}>{translate('row.modelFree')}</span>
    return (
      <span className={compact ? 'dsm-qoder-model-label dsm-qoder-model-label-compact' : 'dsm-qoder-model-label'}>
        {/* 名字原样在位：宿主契约是「addition 渲染在旁边，名字归宿主」，永不替换。 */}
        <span>{model.name}</span>
        {promo}
        {freeTag}
      </span>
    )
  }
  return QoderModelLabel
}
