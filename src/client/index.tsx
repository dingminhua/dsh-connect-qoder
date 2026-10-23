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

import { QODER_SETTINGS_NS } from '../status-paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { QoderCard } from './QoderCard.tsx'
import type { QoderCardInjected } from './QoderCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
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
        }
      | undefined
    if (forms !== undefined) {
      // The namespace is the Host's Loader entry id; ask the mirror rather
      // than assume a name (exact match on the Host side).
      let ns: string = QODER_SETTINGS_NS
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(entry => entry.ns === QODER_SETTINGS_NS || /qoder/i.test(entry.ns))
        if (served !== undefined) ns = served.ns
      } catch { /* mirror not ready: the declared id is still correct */ }
      settingsScope = forms.get(ns)
    }

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
        ctx.slots.inject('conversation.input.left' as never, () => (ctx.slots as unknown as {
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
        ctx.slots.inject('conversation.composer.dock' as never, () => (ctx.slots as unknown as {
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
    const registerAllSlots = (): Array<() => void> => [
      registerCard('plugins.bundle.config', QODER_CARD_SLOT_KEYS.bundle),
      registerCard('plugins.row.config', QODER_CARD_SLOT_KEYS.row),
      registerComposerCredits(),
      registerStatsCredits(),
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
     * `remote.settings.describe()` 填充，apply 时刻通常还是空的。旧代码把这份空
     * 当成「声明名一定对」、绑了 `forms.get('qoder')`，之后不再回看；宿主精确按
     * 命名空间匹配，于是这个猜错的 form 永远 `unavailable`，卡片空白且无报错
     * （workbuddy #46/#55）。
     *
     * `whileServed` 是宿主自己的惯用法（mirror 订阅 + 即时同步），只在
     * unserved→served 的**边缘**触发 register，且会顺着把旧注册 withdraw——
     * 这正是「新命名空间要到货才能重绑」所需的语义。宿主若不支持（旧线），回退成
     * 「声明名一次性绑定 + 注册一次」。
     */
    const bindSettingsScope = (): void => {
      const candidates = [QODER_SETTINGS_NS]
      // 宿主支持 whileServed 时，订阅镜像、命名空间到货即重绑；否则回退单次绑定。
      if (forms !== undefined && typeof (forms as { whileServed?: unknown }).whileServed === 'function') {
        // 宿主动态拿到的 `forms` 没有静态类型；这里把它当黑盒，只断言我们用的形状。
        const servedForms = forms as unknown as {
          whileServed(c: string[], cb: (served: Set<string>) => (() => void) | void): unknown
        }
        // `ctx.effect` 期望回调返回一个 effect 对象；`whileServed` 的真实返回就是它，
        // 但此处无静态类型，故把 `ctx.effect` 当 `() => unknown` 的黑盒调用。
        ;(ctx.effect as (execute: () => unknown, label?: string) => unknown)(
          () => servedForms.whileServed(
            candidates,
            (served: Set<string>) => {
              const ns = candidates.find(candidate => served.has(candidate))
                ?? [...served].find(entry => /qoder/i.test(entry))
              settingsScope = ns === undefined ? undefined : forms.get(ns)
              rebindSlots()
              return () => {
                for (const dispose of liveDisposers) {
                  try { dispose() } catch { /* 已被槽位服务 dispose 过 */ }
                }
                liveDisposers = []
              }
            },
          ),
          'dsh-connect-qoder: settings namespace binding',
        )
        // 先无条件注册一次：若 mirror 首答已含本命名空间，边缘同步内已触发；若不含
        // （命名不预期、settings 面迟迟未答、或部署未挂可配置项），边缘永不触发、
        // 卡片永不注册——所以这里兜底注册一次，后续边缘若有则替换。
        rebindSlots()
        return
      }
      // 无 settings 面或旧宿主：沿用单次绑定回退。
      if (forms !== undefined) {
        let ns: string = QODER_SETTINGS_NS
        try {
          const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
          const served = namespaces.find(entry => entry.ns === QODER_SETTINGS_NS || /qoder/i.test(entry.ns))
          if (served !== undefined) ns = served.ns
        } catch { /* mirror 未就绪：声明名仍正确 */ }
        settingsScope = forms.get(ns)
      }
      liveDisposers = registerAllSlots()
    }

    bindSettingsScope()
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-qoder] client apply failed:', error)
  }
}