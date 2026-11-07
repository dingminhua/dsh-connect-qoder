/**
 * Browser half: Qoder accounts, credits and model management, rendered as a
 * **Settings page** (`settings.section`).
 *
 * 注册形态沿用 dsh-connect-workbuddy 的 `client/index.tsx`：`slots` / `locale`
 * 两项注入、`LocaleNamespaceMap` 模块增强、apply 体包 try/catch 以便槽位 API
 * 变更时降级为 console.error 而不触发红色横幅。
 *
 * 1.18.0 起配置入口不再挂在插件市场详情页的卡片上
 * （`plugins.bundle.config` / `plugins.row.config` 两处注册已删除），而是设置面板
 * 左侧导航里的独立一页；同一份正文另有一个 opt-in 的侧边栏整屏入口。
 *
 * @module dsh-connect-qoder/client
 */

import { QODER_SETTINGS_NAMESPACE_CANDIDATES, QODER_SETTINGS_NS, QODER_SIDEBAR_PANEL_ID, QODER_USAGE_PATH, sidebarPanelEnabledOf, withQoderRegion } from '../status-paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { QoderCard } from './QoderCard.tsx'
import type { QoderCardInjected } from './QoderCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { createQoderModelLabel, QODER_MODEL_LABEL_PRIORITY, QODER_MODEL_LABEL_SLOT } from './QoderModelLabel.tsx'
import type { QoderModelLabelSlots } from './QoderModelLabel.tsx'
import { qoderLocales } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'
import { openQoderSettingsSection } from './settings-jump.ts'
import { QODER_PACKAGE_NAME } from '../version.ts'
import { QODER_PLUGIN_ICON } from './icon.ts'
import { setSidebarPanelWanted, sidebarPanelWanted, subscribeSidebarPanelWanted } from './panel-switch.ts'

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

    /**
     * 打开本插件的设置页（「设置 → Qoder」）。
     *
     * 由 `settings-jump.ts` 在 DOM 里自己找路（点侧边栏的设置触发器 → 在面板里
     * 按导航标签找本插件那一行 → 点它），不依赖任何宿主服务到货 —— 所以它在
     * `apply` 里就有一个确定的值，积分面板那颗按钮因此**总是**渲染。
     *
     * 唯一的外部依赖是 `pluginNavigation.openBundle(<npm 包名>)`，而它只在跳转
     * 找不到导航行时被当作退路：那时把用户送回插件市场本插件那一页，比一颗点了
     * 没反应的按钮好。它是软探测（`ctx.get`），缺席时退路静默不做任何事 ——
     * 绝不能把它写进 `inject: ['slots','locale']`，那会让整个客户端插件在没装
     * Plugins 页的 profile 上不激活（读数、模型徽标一起消失）。
     */
    let openPluginSettings: (() => void) | undefined

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

    /**
     * 设置页分区（`settings.section`）—— 本插件**唯一**的配置入口。
     *
     * 从 1.18.0 起，配置界面不再挂在插件市场详情页的卡片里
     * （`plugins.bundle.config` / `plugins.row.config` 两处注册已删除），而是
     * 注册成设置面板左侧导航里的独立一页，与「账号与余额 / 通用设置 / 模型 /
     * 插件」并列。理由是那张卡片一直兼任两件事：它是插件列表里的一行（谁装的、
     * 在跑什么），同时又是一整页配置（PAT、账号池、模型目录、诊断）。把入口
     * 挪进设置之后，插件列表只回答「装了什么」。
     *
     * **没有能力探测**：`settings.section` 是 0.2.1-rc.5 才引入的槽位，而本插件
     * 的 peer 下限更低，但 `ctx.slots.inject()` 本身就是探测 —— 宿主没声明这个
     * 槽位时它只等待、不抛错、也不执行回调，插件其余部分完全不受影响。反过来
     * 写一层 `typeof ctx.slots.specOf === 'function'` 的探测会让失败的探测静默
     * 关掉整页（兄弟项目 dsh-subagent-default-model 2.1.16/2.1.17 就是这么丢了
     * 整个设置页的）。**探测失败必须往「能用」的方向失败。**
     *
     * 图标与页面在**同一个** `inject` 回调里注册、disposer 成对返回：外壳给导航
     * 行取图标用的是 `renderSlot('settings.section.icon', …, { only: row.id })`，
     * id 必须与页面完全一致才会命中，否则静默回落到默认齿轮。
     */
    const registerSection = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('settings.section' as never, () => {
          const disposers: Array<() => void> = []
          disposers.push((ctx.slots as unknown as {
            register(
              options: {
                name: string
                id: string
                order: number
                label: () => string
                locale: string
                inject: () => QoderCardInjected
              },
              component: unknown,
            ): () => void
          }).register({
            name: 'settings.section',
            id: QODER_SETTINGS_NS,
            // 排在内置分区之后（账号 -10 / 通用 0 / 模型 10 / 插件 15）。
            order: 30,
            label: () => t('section.label'),
            locale: namespace,
            // `surface: 'section'`：设置页不是插件列表里的一行，正文按页面渲染
            // （见 QoderCard 的三种形态）。不传它就会掉回 `<li>` 折叠外壳。
            inject: () => settingsScope === undefined
              ? { t, surface: 'section' as const }
              : { t, settingsScope, surface: 'section' as const },
          }, QoderCard))
          try {
            const iconDisposer = (ctx.slots as unknown as {
              inject(name: string, factory: () => () => void): (() => void) | undefined
            }).inject('settings.section.icon', () => (ctx.slots as unknown as {
              register(options: { name: string, id: string, locale: string }, component: unknown): () => void
            }).register({
              name: 'settings.section.icon',
              id: QODER_SETTINGS_NS,
              locale: namespace,
            }, QoderSectionIcon))
            if (typeof iconDisposer === 'function') disposers.push(iconDisposer)
          } catch (error: unknown) {
            // 图标失败不该带走页面：少一枚品牌标，导航行仍在，外壳回落到默认齿轮。
            console.error('[dsh-connect-qoder] settings.section.icon failed to register (page still renders):', error)
          }
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch { /* 已被槽位服务 dispose 过 */ }
            }
          }
        })
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] settings.section failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    // 配置入口的注册改由 `bindSettingsScope()` 在下方统一收口：settings 命名空间
    // 在宿主镜像就绪后才确定，早期就注册会绑错 scope 且永不回看（workbuddy #46/#55）。

    /**
     * Credit readout in the composer row (`conversation.input.right`, a
     * session-scope list slot rendered immediately before the model picker).
     *
     * `input.right` 而不是 `input.left`（同步自 dsh-connect-trae 的 issue #71）：
     * 宿主把 `input.right` 渲染在 `div.trailing` 的 `standardControls` 内、模型
     * 选择器**之前**，而 `input.left` 在 `div.tools` 最末尾、距权限选择器只有
     * 8px。两者都是可点元素，想点「完全权限」会点到读数并弹出积分浮层。
     * 读数是读数不是按钮，挨着模型选择器就不再和用户真正想点的控件争位置。
     * `composer` 这个设置值含义不变（「带模型选择器的那一行」），老 profile
     * 无需迁移。
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
        return ctx.slots.inject('conversation.input.right' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.input.right',
          id: 'dsh-connect-qoder-composer-credits',
          order: 4,
          locale: namespace,
          // `settingsScope` rides along so the gate can honor the card's
          // per-region switch without a second writer.
          inject: () => ({
            t,
            position: 'composer' as const,
            ...settingsScope === undefined ? {} : { settingsScope },
            ...openPluginSettings === undefined ? {} : { openSettings: openPluginSettings },
          }),
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
          inject: () => ({
            t,
            position: 'stats' as const,
            ...settingsScope === undefined ? {} : { settingsScope },
            ...openPluginSettings === undefined ? {} : { openSettings: openPluginSettings },
          }),
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
        const label = createQoderModelLabel({
          entries: key => (ctx.slots as unknown as QoderModelLabelSlots).entries(key),
          // 委托时按**对方 entry 自己的 locale** 绑 t（issue #23）。宿主用
          // `ctx.locale.bind(ns)` 给每个 entry 注入同一套座位；我们绕过框架渲染
          // 别家的组件，就得用同一个入口替它绑——绝不能转发我们自己的 t。
          bindLocale: ns => ctx.locale.bind(ns),
        })
        return ctx.slots.inject(QODER_MODEL_LABEL_SLOT as never, () => (ctx.slots as unknown as {
          register(options: { name: string; priority: number; locale: string }, component: unknown): () => void
        }).register({
          name: QODER_MODEL_LABEL_SLOT,
          // **必须小于 workbuddy 的 -100。**
          //
          // single 槽只渲染一条注册，按 priority **升序取首条**（小者先）。这里
          // 原先是 -1，注释说「workbuddy 占着默认优先级 0」——那条判断是错的：
          // workbuddy 用的是 -100，比 -1 小，所以它抢到了座位。
          //
          // 而 workbuddy 是**终点型**组件（它的文件头写明不读槽位账本、不渲染
          // 别家的组件，所以永远不会把这一行交还给我们）。结果就是：卡片里
          // 有「错峰 4 折」胶囊，模型选择器里却没有 —— 用户实拍的正是这个。
          //
          // 取 -101 而不是一个更大的负数（比如 -1000）：只争一格，不把将来
          // 任何正常的插件挤到身后。
          priority: QODER_MODEL_LABEL_PRIORITY,
          locale: namespace,
        }, label))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] model label slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    const registerAllSlots = (): Array<() => void> => [
      registerSection(),
      registerComposerCredits(),
      registerStatsCredits(),
      registerModelLabel(),
      // `registerPanel()` 刻意**不在**这里：它是唯一一个「只在开关打开时才存在」
      // 的座位，因此由 {@link syncPanelRegistration} 单独持有。
    ].filter((disposer): disposer is () => void => disposer !== undefined)

    /** 当前绑定下已注册的槽位 disposer。 */
    let liveDisposers: Array<() => void> = []

    /**
     * 设置面板左侧导航那一格的图标（`settings.section.icon`）。
     *
     * 外壳以 `{ size, active }` 渲染它，尺寸由外壳给（不是硬编码 16），选中态
     * 由外壳围着画、我们只把未选中时的不透明度降一档。`inline: true` 的槽位把
     * cell 包在 `<span>` 里，所以用 `<img>` + `display:block` 精确占位，不破坏
     * 导航行的基线。
     */
    function QoderSectionIcon(props: { size?: number, active?: boolean }): ReactElement {
      const edge = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h('img', {
        className: 'dsm-qoder-section-icon',
        src: QODER_PLUGIN_ICON,
        alt: '',
        width: edge,
        height: edge,
        style: {
          width: `${edge}px`,
          height: `${edge}px`,
          display: 'block',
          borderRadius: '3px',
          objectFit: 'contain',
          opacity: props.active === false ? 0.75 : 1,
        },
        'aria-hidden': 'true',
      })
    }

    /**
     * 侧边栏那一行的图标（`sidebar.panellist` 的组件位置）。
     *
     * 侧边栏以 `{ size, active }` 在一个 `currentColor` 主题的图标格里渲染它，
     * 所以品牌标画成一个小 `<img>`：PNG 自己的颜色读起来就是插件的身份，选中
     * 状态由宿主围着它画。
     *
     * 参考：dsh-connect-workbuddy 的 `WorkBuddyPanelIcon`（PR #188，MIT，
     * Copyright (c) 2026 LaoDing）。
     */
    function QoderPanelIcon(props: { size?: number }): ReactElement {
      const edge = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h('img', {
        className: 'dsm-qoder-panel-icon',
        src: QODER_PLUGIN_ICON,
        alt: '',
        width: edge,
        height: edge,
        'aria-hidden': 'true',
      })
    }

    /**
     * DSH 侧边栏里的 Qoder 面板：一个 `sidebar.panellist` 行 + 一个 `main` 整页。
     *
     * 形态照宿主自己的 Plugins 行（`ui-plugin-manager`）：`id` 与 `main` 的
     * `key` 必须**同值**——侧边栏按钮点下去是「选中 id 等于自己的中央面板」，
     * 两者对不上就只是一个点了没反应的按钮。
     *
     * **OPT-IN**（`Config.sidebarPanel`，默认 false）。注册它不等于显示它：
     * `ui-sidebar` 那一行是拿插槽的**注册元数据**渲染的（`usePanels` →
     * `PanelRow`，标签取 `options.label`、图标取 `renderSlot(...)`），所以一个
     * 返回 `null` 的组件留下的是一个空白但**仍可点击**的按钮，而不是没有按钮。
     * 因此行只能在开关打开时注册——由 {@link syncPanelRegistration} 负责。
     * 见 `panel-switch.ts` 里那条 store 为什么必须在入口而不在组件。
     *
     * 返回对话复用宿主的 layout 服务：`selectPanel(null)` 把中央那一列交回会话。
     * 它是软探测的，所以一台不声明 `layout` 的宿主只是少一个返回按钮，不会整页
     * 卡死（与卡片对缺失 settings 表单的降级同规）。
     */
    const registerPanel = (): Array<() => void> => {
      const PANEL_ID = QODER_SIDEBAR_PANEL_ID
      const disposers: Array<() => void> = []
      const backToConversation = (): void => {
        const layout = softGet('layout') as { selectPanel?: (id: string | null) => void } | undefined
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      }
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist' as never, () => (ctx.slots as unknown as {
          register(options: { name: string; id: string; order: number; label: () => string; locale: string }, component: unknown): () => void
        }).register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          // 1：紧挨着宿主的 Plugins 行（0）之后、`dsh-market`（1）旁边。`order`
          // 只在本插件自己这一行有意义——别的 bundle 各报各的序，宿主的排布是
          // 「按 order 升序、同序按注册先后」。
          order: 1,
          label: () => t('nav.panel'),
          locale: namespace,
        }, QoderPanelIcon)))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] sidebar panel row failed to register (host provider unaffected):', error)
      }
      try {
        disposers.push(ctx.slots.inject('main' as never, () => (ctx.slots as unknown as {
          register(options: { name: string; key: string; locale: string; inject: () => QoderCardInjected & { surface: 'page', backToConversation: () => void } }, component: unknown): () => void
        }).register({
          name: 'main',
          key: PANEL_ID,
          locale: namespace,
          inject: () => settingsScope === undefined
            ? { t, surface: 'page' as const, backToConversation }
            : { t, settingsScope, surface: 'page' as const, backToConversation },
        }, QoderCard)))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] sidebar panel page failed to register (host provider unaffected):', error)
      }
      return disposers
    }

    /**
     * 已在册的面板注册，**与 {@link liveDisposers} 分开**。
     *
     * 这是本插件唯一会随页面存活期来去的槽位（因为那个 opt-in 开关），单独持有
     * 它的意义是：翻开关不会把卡片、composer 读数等五个座位一起拆掉重建——那会
     * 让「插件」页为了一件与它无关的改动闪一下。
     */
    let panelDisposers: Array<() => void> = []

    /**
     * 让面板注册与 opt-in 开关保持一致。
     *
     * **先 dispose 再 register**，理由与 {@link rebindSlots} 相同：keyed 槽位的
     * 同一个 `key` / `id` 不能重复注册，那次抛错会被只打日志的 try/catch 吞掉，
     * 结果是「一个注册都没有」。
     *
     * 重新注册（而不是只注销）是 settings 作用域换绑之后也必须做的：渲染器按
     * entry 身份缓存 `inject` 的结果，作用域到货之前创建的 entry 会永远拿不到它。
     */
    const syncPanelRegistration = (): void => {
      for (const dispose of panelDisposers) {
        try { dispose() } catch { /* 已被槽位服务 dispose 过 */ }
      }
      panelDisposers = []
      if (!sidebarPanelWanted()) return
      panelDisposers = registerPanel()
    }

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
            + `(settings form: ${settingsScope === undefined ? 'none — card is read-only' : 'bound'}, `
            + `sidebar panel: ${sidebarPanelWanted() ? 'on' : 'off'})`,
        )
      } catch { /* 无 console 的宿主也要能注册 */ }
      // 面板走它**自己**的开关，所以是「对齐」而不是「列在清单里」：已经打开的
      // 面板要在这里拆掉重建，让它的 `inject` 闭包看见刚刚绑好的作用域。
      syncPanelRegistration()
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

    /**
     * 「设置」按钮的目的地：**设置 → Qoder** 那一页。
     *
     * 1.18.0 之前这里等的是 `pluginNavigation.openBundle(包名)`（打开插件市场里
     * 本插件那一页），因为配置卡片就渲染在那儿。卡片搬进设置之后那个落点已经
     * 没有配置可看，所以改成驱动真实 chrome：`settings-jump.ts` 点开设置面板、
     * 再点本插件的导航行。
     *
     * 1.20.0 起先走**外壳自己的 store 座位**：设置外壳把状态句柄发布在
     * `sidebar.settings` 的 `store` 上，`create().actions.openSection(id)` 一次
     * 调用同时设 `activeId` 与 `open` —— 没有重试窗口，也不依赖导航行的文案。
     * 驱动 chrome 降为第二条路（老外壳没有座位时仍能到本插件页）。
     * 依据读自 0.2.2-rc.1 的 `ui-settings-general`，逐条记在 `settings-jump.ts`。
     *
     * **为什么还要留一条 `pluginNavigation` 的退路**：跳转靠导航行的**标签**定位，
     * 而标签是本地化字符串。万一宿主换了外壳（标签被截断、面板换了容器属性），
     * 那次跳转会落空；此时退回 `openBundle(包名)` 至少把用户送到插件市场那一页
     * ——比一颗彻底死掉的按钮好，也不会误导（那一页现在只说「已安装」，不再承诺
     * 有配置）。
     *
     * `openPluginSettings` 因此**总是**有值：不再取决于某个宿主服务是否到货。
     * 一颗「服务不到就不渲染」的按钮，在跳转这件事上已经没有必要 —— 跳转本身
     * 在 DOM 里自己找路。
     *
     * ⚠️ **必须在 `bindSettingsScope()` 之前赋值**（1.18.0 的第一个发布候选就把
     * 这颗按钮弄丢过）：`bindSettingsScope()` 会立刻 `registerAllSlots()` 跑一次
     * 首次注册，而 `inject` 闭包在**那一刻**读的就是 `openPluginSettings`。写在
     * 它后面，首次注册拿到的就是 `undefined` —— 积分面板据此不渲染那颗齿轮，
     * 之后也没有任何东西会再去纠正它。
     *
     * 也不能指望「之后再重绑一次」来救：渲染器对 `inject()` 的结果做了
     * `useMemo`（依赖是 `[actions, definition, scopeBinding]`），注册对象不变就
     * 不会重算 —— 只有**换掉 entry 身份**（重建注册）才会。那意味着每次改设置
     * 都要拆了重挂一遍 composer 读数，代价远大于「先赋值再注册」。
     */
    openPluginSettings = () => {
      openQoderSettingsSection({
        label: () => t('section.label'),
        // 第 1 条路：设置外壳的 store 座位，一次调用就把对话框开在本插件这一页。
        // 每次按下才探测（不在这里捕获），因为侧边栏那个 bundle 的 apply 顺序
        // 不归我们假设 —— 早探一次，后加载的侧边栏会让按钮整个会话都是死的。
        get: softGet,
        onGiveUp: () => {
          const navigation = softGet('pluginNavigation') as { openBundle?: (name: string) => void } | undefined
          if (navigation !== undefined && typeof navigation.openBundle === 'function') {
            try { navigation.openBundle(QODER_PACKAGE_NAME) } catch { /* 退路自己失败：保持 no-op */ }
          }
        },
      })
    }

    bindSettingsScope()

    /**
     * 跟随 opt-in 开关，并用 Host 的答案做**种子**。
     *
     * 种子是一次状态读取，而不是读 settings 作用域：这个命名空间的浏览器镜像
     * 在受影响的 0.1.7 部署上被记录为陈旧，而这里一个陈旧的 `false` 意味着那一
     * 行永远不会出现——之后也没有任何事件去纠正它，因为 `whileServed` 只在命名
     * 空间边缘触发、不在值变化时触发。Host 自己的答案才是权威
     * （usage 文档上的 `sidebarPanelEnabled`），与本插件其它 Host 承载开关一致。
     *
     * 读取失败**不是**要展示的错误：OFF 是一个合法答案，而且事实上就是默认值，
     * 所以一个连不上状态路由的插件只是没有那一行——用户在这里也无事可做。
     *
     * **订阅**才是让开关生效的东西：卡片在写入被验证之后调用
     * `setSidebarPanelWanted`，于是那一行出现或消失都不需要刷新。`ui-layout`
     * 会丢掉 `main` key 已不存在的 `activePanelId`，所以页面开着时关掉它，中央
     * 那一列自己回到对话。
     */
    ctx.effect(
      () => subscribeSidebarPanelWanted(() => { syncPanelRegistration() }),
      'dsh-connect-qoder: sidebar panel opt-in',
    )
    // 种子优先问 SETTINGS 快照（同步、无网络），它已经有了就一定是对的；镜像
    // 还没到货时才去问 Host 的路由。两条都不通 = 不打开。
    try {
      if (sidebarPanelEnabledOf(settingsScope?.getSnapshot().value) === true) setSidebarPanelWanted(true)
    } catch { /* 没有作用域 / 读不出来：交给下面那条路由 */ }
    if (!sidebarPanelWanted()) {
      void (async () => {
        try {
          const response = await fetch(withQoderRegion(QODER_USAGE_PATH, 'cn'), {
            headers: { accept: 'application/json' },
          })
          if (!response.ok) return
          const document = await response.json() as { sidebarPanelEnabled?: unknown }
          if (document.sidebarPanelEnabled === true) setSidebarPanelWanted(true)
        } catch { /* 没有答案就没有那一行；开关保持关闭 */ }
      })()
    }
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-qoder] client apply failed:', error)
  }
}