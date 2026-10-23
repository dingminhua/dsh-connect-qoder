/**
 * Browser half: Qoder model management inside Plugin configuration.
 *
 * 注册形态沿用 dsh-connect-workbuddy 的 `client/index.tsx`：`slots` /
 * `locale` 两项注入、`LocaleNamespaceMap` 模块增强、`plugins.bundle.config`
 * 与 `plugins.row.config` 槽位 + `key` / `priority` 写法；apply 体包
 * try/catch 以便槽位 API 变更时降级为 console.error 而不触发红色横幅。
 *
 * @module dsh-connect-qoder/client
 */

import { QODER_SETTINGS_NAMESPACE_CANDIDATES, QODER_SETTINGS_NS } from '../status-paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { QoderCard } from './QoderCard.tsx'
import type { QoderCardInjected } from './QoderCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { createQoderModelLabel, QODER_MODEL_LABEL_SLOT } from './QoderModelLabel.tsx'
import type { QoderModelLabelSlots } from './QoderModelLabel.tsx'
import { qoderLocales } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QODER_CARD_SLOT_KEYS } from './slot-keys.ts'

export type QoderClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-qoder-client'

/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/** Register card copy and the Qoder card under Plugin configuration. */
export function apply(ctx: QoderClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, qoderLocales), 'dsh-connect-qoder: settings copy')
    const t = ctx.locale.bind(namespace) as QoderCardInjected['t']

    const softGet = (name: string): unknown => (ctx as unknown as { get(name: string): unknown }).get(name)

    let settingsScope: QoderCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): QoderCardInjected['settingsScope']
          whileServed(
            namespaces: readonly string[],
            register: (served: ReadonlySet<string>) => () => void,
          ): () => void
        }
      | undefined
    // **不在这里先猜一个命名空间绑上**（workbuddy #46 的原始缺陷，别把它移植回来）：
    // 镜像由异步 `remote.settings.describe()` 填充，apply 时刻通常还是空的；此时
    // `forms.get(声明名)` 铸出的是一个宿主并不服务的 form，它会永远 `unavailable`。
    // 那比 `undefined` 更糟 —— 卡片判「能不能写」只看 `settingsScope !== undefined`
    // （`canEditPool` / `canSwitch`），拿到一个 unavailable 的 form 就会让用户去写
    // 一个写不进去的地方。绑定统一交给下面的 `bindSettingsScope()`：宿主镜像说话之后
    // 才绑，说话之前是 `undefined`（只读降级，这是有文档的降级形态）。

    const registerCard = (slotName: string, key: string): (() => void) | undefined => {
      try {
        return ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, QoderCard))
      } catch (error: unknown) {
        console.error(`[dsh-connect-qoder] card slot "${slotName}" failed to register (host provider unaffected):`, error)
        return undefined
      }
    }

    // Slot keys are keyed by PACKAGE identity, not by our settings namespace:
    // `plugins.bundle.config` wants the bare package name and
    // `plugins.row.config` wants `<package name>#<row id>`. Both are built from
    // the build-injected package name — see `slot-keys.ts` for why hardcoding
    // them made the card render nothing after the scoped rename.
    //
    // 注册改由 `bindSettingsScope()` 在下方统一收口：settings 命名空间在宿主镜像
    // 就绪后才确定，早期就注册会绑错 scope 且永不回看（workbuddy #46/#55）。

    /**
     * Credit readout in the composer tool row (`conversation.input.left`, a
     * session-scope list slot).
     *
     * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
     *   — 该项目的 `registerComposerCredits`：无条件注册插槽、由 gate 读
     *     `modelSelection` 投影自行决定是否渲染。Qoder 沿用同一形态；不同在于
     *     读数标注与 provider 路由不同（`qoder` / `qoder-global`）。
     *
     * Provider-scoped on purpose: it renders only while the session's selected
     * model belongs to this plugin, which keeps two connector plugins from
     * competing for one shared row. Registration is unconditional; the gate
     * reads the Host's `modelSelection` projection and returns null for every
     * other provider.
     */
    const registerComposerCredits = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.input.left' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.input.left',
          id: 'dsh-connect-qoder-composer-credits',
          order: 4,
          locale: namespace,
          // `settingsScope` rides along so the gate can honor the card's
          // per-region switch without a second writer.
          inject: () => settingsScope === undefined
            ? { t, position: 'composer' as const }
            : { t, position: 'composer' as const, settingsScope },
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] composer credits slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * 同一个读数，注册在输入框卡片下方的常驻栏（`conversation.composer.dock`）。
     *
     * 与输入框席位一样**无条件注册**，因为「两个席位选哪个」这个决定在 gate 里：
     * 它只在设置点名的席位渲染、在另一个席位 return null。只注册被选中的席位，
     * 就意味着每次改设置都要重新注册插槽——而本仓库已写明这种绑定是脆的（晚到的
     * settings 命名空间必须产生新注册而非改闭包）。
     *
     * 参考：dingminhua/dsh-connect-workbuddy 的 `registerStatsCredits`（issue #62，
     * MIT，Copyright (c) 2026 LaoDing）。Qoder 沿用同一形态；不同在于读数标注与
     * provider 路由（`qoder` / `qoder-global`）。
     *
     * 这个席位为什么存在：输入框工具栏是**共享的 list 插槽**，任何其他 bundle 都
     * 注册在那里，而 list 插槽无法保证每个占用者都可见——第三方插件把读数挤没的
     * 报告正是这么来的。这一行是 shell 渲染自己「轮次 / tok/s / token / 缓存命中」
     * 的地方，本来就是用户读会话数字的位置；`order` 10 排在 shell 统计（注册在 0）
     * 之后，所以自带统计仍在最左，读数是**追加**而不是顶替。
     */
    const registerStatsCredits = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.composer.dock' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.composer.dock',
          id: 'dsh-connect-qoder-stats-credits',
          order: 10,
          locale: namespace,
          inject: () => settingsScope === undefined
            ? { t, position: 'stats' as const }
            : { t, position: 'stats' as const, settingsScope },
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] stats credits slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * 把本插件贡献的所有槽位收口成一组注册，供 `rebindSlots` 统一 dispose/重建。
     * 参考：dingminhua/dsh-connect-workbuddy（MIT）的 `registerAllSlots` ——
     * settings 命名空间的绑定与槽位注册必须**一起**移动：晚到的 namespace 必须
     * 产生全新的注册而非改写旧闭包，否则渲染器按 entry 身份缓存 inject 结果，
     * 旧注册永远不被重新求值（issue #55：空 Plugins 页且无报错）。
     */
    const registerModelLabel = (): (() => void) | undefined => {
      try {
        const label = createQoderModelLabel(ctx.slots as unknown as QoderModelLabelSlots)
        return ctx.slots.inject(QODER_MODEL_LABEL_SLOT as never, () => (ctx.slots as unknown as {
          register(options: { name: string; priority: number; locale: string }, component: unknown): () => void
        }).register({
          name: QODER_MODEL_LABEL_SLOT,
          priority: -1,
          locale: namespace,
        }, label))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] model label slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    const registerAllSlots = (): Array<() => void> => [
      registerCard('plugins.bundle.config', QODER_CARD_SLOT_KEYS.bundle),
      registerCard('plugins.row.config', QODER_CARD_SLOT_KEYS.row),
      registerComposerCredits(),
      registerStatsCredits(),
      registerModelLabel(),
    ].filter((disposer): disposer is () => void => disposer !== undefined)

    /** 当前绑定下已注册的槽位 disposer。 */
    let liveDisposers: Array<() => void> = []

    /**
     * 用当前 `settingsScope` 重建全部槽位注册。先 dispose 旧的，再注册新的——
     * 顺序不能反（同 key 同优先级的 keyed 槽位重复注册会抛 "already has an entry"）。
     */
    const rebindSlots = (): void => {
      for (const dispose of liveDisposers) {
        try { dispose() } catch { /* 已被槽位服务 dispose 过 */ }
      }
      liveDisposers = []
      liveDisposers = registerAllSlots()
      try {
        console.info(
          `[dsh-connect-qoder] registered ${String(liveDisposers.length)} slots `
            + `(settings form: ${settingsScope === undefined ? 'none — card is read-only' : 'bound'})`,
        )
      } catch { /* 无 console 的宿主也要能注册 */ }
    }

    /**
     * 把 `settingsScope` 绑到宿主**真正在服务的**命名空间，并在该答案变化时重注册。
     *
     * 为什么不是启动时读一次：宿主的 `configForms` mirror 由异步
     * `remote.settings.describe()` 填充，apply 时刻通常还是空的。把这份空当成
     * 「声明名一定对」再 `forms.get(声明名)`，铸出的就是一个宿主并不服务的 form，
     * 它会永远 `unavailable`；宿主按命名空间**精确**匹配，所以猜错不会自己纠正
     * （workbuddy #46 的原始缺陷，qoder 这里不重踩）。
     *
     * `whileServed` 是宿主自己的惯用法（mirror 订阅 + 即时同步），只在
     * unserved→served 的**边缘**触发 register，且会顺着把旧注册 withdraw ——
     * 这正是「新命名空间要到货才能重绑」所需的语义。宿主若不支持（旧线），回退成
     * 「问一次镜像 + 绑上 + 注册一次」，代价是镜像晚到时绑错且不回看 —— 没有
     * 订阅机制时，这仍好过永远不注册。
     *
     * ⚠️ 监视的是 `QODER_SETTINGS_NAMESPACE_CANDIDATES` **整份表**，不是单一拼写：
     * 少一种拼写，宿主用那种拼写挂载时边缘就永不触发，回调里的 `/qoder/i` 兜底
     * 也随之成为死代码（见该常量的注释）。
     */
    const bindSettingsScope = (): void => {
      if (forms === undefined || typeof forms.whileServed !== 'function') {
        // 无 settings 面，或宿主那条线还没有 `whileServed`：回退成「问一次镜像、
        // 绑声明名、注册一次」。镜像没就绪时这就是个猜测 —— 但没有订阅机制可用，
        // 猜错的代价（卡片只读 / 写不进去）小于永远不注册。与 workbuddy 同形。
        if (forms !== undefined) {
          let ns: string = QODER_SETTINGS_NS
          try {
            const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
            const served = namespaces.find(entry =>
              QODER_SETTINGS_NAMESPACE_CANDIDATES.includes(entry.ns) || /qoder/i.test(entry.ns))
            if (served !== undefined) ns = served.ns
          } catch { /* 镜像未就绪：声明名仍是最优猜测 */ }
          settingsScope = forms.get(ns)
        }
        liveDisposers = registerAllSlots()
        return
      }
      // 用 `ctx.effect` 包起来，让这次订阅随插件 fiber 一起拆掉 —— 这是宿主对该
      // 服务的要求（`whileServed` 自己不在我们的 context 上注册任何东西）。
      ctx.effect(() => forms.whileServed(
        QODER_SETTINGS_NAMESPACE_CANDIDATES,
        (served) => {
          // 镜像说话了。候选表是**有序**的，宿主真正服务的第一种拼写胜出；
          // `/qoder/i` 那一扫是兜底，用于候选表没预料到的 entry id（包裹前缀、
          // 后缀之类）。
          const ns = QODER_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
            ?? [...served].find(entry => /qoder/i.test(entry))
          settingsScope = ns === undefined ? undefined : forms.get(ns)
          // **替换，不是追加**：渲染器按 entry 身份缓存 inject 结果，留着旧注册
          // 就等于一直发旧 props。
          rebindSlots()
          return () => {
            for (const dispose of liveDisposers) {
              try { dispose() } catch { /* 已被槽位服务 dispose 过 */ }
            }
            liveDisposers = []
          }
        },
      ), 'dsh-connect-qoder: settings namespace binding')
      // **并且无条件先注册一次**，不等边缘。
      //
      // `whileServed` 只在 unserved→served 的**边缘**触发 register。镜像首答就含
      // 本命名空间时，`sync()` 在 `whileServed` 内部同步跑、边缘当场触发，于是
      // 下面这次调用与它走的是同一条路（先 dispose 再注册，所以不会重复）。但
      // 首答**不含**本命名空间时（拼写没预料到、settings 面答得晚或直接失败、
      // 部署根本没挂可配置项），边缘永不触发，卡片就永远不注册 —— 那正是
      // workbuddy #55：Plugins 页一片空白且没有任何报错（整个 apply 体被一个
      // 只打日志的 try/catch 包着）。
      //
      // 卡片**没有** form 也有用：它从宿主自己的 status 路由读状态、按只读渲染，
      // 与上面 `forms === undefined` 那条分支的降级形态完全一致。所以注册不能
      // 以「拿到 settings 命名空间」为前提；之后若真有边缘来，它会用绑好的注册
      // 替换掉这一批。
      rebindSlots()
    }

    bindSettingsScope()
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-qoder] client apply failed:', error)
  }
}