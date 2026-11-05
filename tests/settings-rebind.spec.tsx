// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

/**
 * 针对**真实** `apply()`（`src/client/index.tsx`）的绑定回归，不是镜像副本。
 *
 * workbuddy 上游的同名测试只能测「手抄的 apply 镜像」，因为它那边导入真实入口会
 * 拉进浏览器专属的宿主包；qoder 这边实测可以直接 import（jsdom 下 511ms 解析完
 * 成），所以这里断言的是**产品代码本身**——镜像副本会随产品漂移而静默失效，
 * 真实入口不会。
 *
 * 钉的是 workbuddy #46/#55 移植到 qoder 后的两个失效面：
 *
 *  1. 宿主以 `include:` 前缀挂载时，`whileServed` 的边缘**永不触发**（它只在被
 *     监视的命名空间之一到货时 register），于是回调里那条 `/qoder/i` 兜底是
 *     **死代码**；
 *  2. 边缘不触发时，`settingsScope` 必须退回 `undefined`（卡片按只读降级），
 *     而不是一个「猜出来、宿主并不服务」的 form —— 后者会让卡片以为自己能写
 *     （`canEditPool` / `canSwitch` 都只判 `settingsScope !== undefined`），
 *     写入落进一个永远 `unavailable` 的 form：正是 #46 的原始症状。
 */

/** key-preserving 翻译器：断言里能直接读出用了哪个 key。 */
const keyT = ((key: string) => key) as never

/** 一个 `configForms` 桩，模仿宿主 `ConfigFormService` 的可观测行为。 */
function formsStub(options: { served?: string[]; mirrorLandsLater?: boolean } = {}) {
  const minted: string[] = []
  const state = { namespaces: options.mirrorLandsLater === true ? [] : (options.served ?? []) }
  const watchers = new Set<() => void>()
  const forms = {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: state.namespaces.map(ns => ({ ns })) } }),
    }),
    /** 宿主按命名空间精确匹配铸造 form；不存在的那个会永远 `unavailable`。 */
    get: (ns: string) => {
      minted.push(ns)
      return { __form: ns, status: state.namespaces.includes(ns) ? 'ready' : 'unavailable' }
    },
    /** 与宿主 `whileServed` 逐字同构：只在 unserved→served 的**边缘** register。 */
    whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) {
      let off: (() => void) | undefined
      const sync = (): void => {
        const served = new Set(state.namespaces)
        const watched = namespaces.some(n => served.has(n))
        if (watched && off === undefined) off = register(served)
        else if (!watched && off !== undefined) { off(); off = undefined }
      }
      watchers.add(sync)
      void Promise.resolve().then(sync)
      sync()
      return () => { watchers.delete(sync); off?.(); off = undefined }
    },
  }
  return {
    forms: forms as any,
    minted,
    watches: (): number => watchers.size,
    land: (ns: string[]): void => { state.namespaces = ns; for (const w of [...watchers]) w() },
  }
}

/**
 * 一个槽位账本，模仿宿主的去重规则：list 槽位（设置分区、分区图标、两个 composer
 * 读数槽）按 `id` 占格，同格重复注册**抛错**
 * （宿主 `ui-slots/src/index.ts`：`keyed slot … already has an entry for key …` /
 * `list slot … already has an entry with id …`）。
 */
function slotsStub() {
  const ledger = new Map<string, { inject: () => any; dispose: () => void }>()
  const injected: Array<{ slot: string; cell: string; props: () => any; options: Record<string, unknown>; first: any }> = []
  const slots = {
    inject: (slotName: string, factory: () => (() => void)) => {
      const dispose = factory()
      return dispose
    },
    register: (options: { name: string; key?: string; id?: string; priority?: number; order?: number; inject: () => any }, _component: unknown) => {
      const cell = `${options.name}#${String(options.key ?? options.id)}`
      if (ledger.has(cell)) {
        throw new Error(`slot "${options.name}" already has an entry for ${options.key === undefined ? 'id' : 'key'} "${String(options.key ?? options.id)}"`)
      }
      const entry = { inject: options.inject, dispose: () => { ledger.delete(cell) } }
      ledger.set(cell, entry)
      // **注册那一刻就求值一次**，与渲染器的 `runInject` 同序（它把 `inject()`
      // 的结果喂给 `useMemo`，依赖是 `[actions, definition, scopeBinding]` ——
      // 注册对象不变就不会重算）。求值后才有的字段，等于产品里永远拿不到。
      // 只对**带 inject 面**的注册求值：`conversation.input.model.label` 那格
      // 本来就没有 inject（它是 single 槽 + priority），无条件调用会抛。
      const first = typeof options.inject === 'function' ? options.inject() : undefined
      injected.push({ slot: options.name, cell, props: options.inject, options, first })
      return entry.dispose
    },
  }
  return {
    slots: slots as any,
    /** 当前**在册**的注册（已 dispose 的不算）。 */
    live: (): string[] => [...ledger.keys()],
    injected,
    /**
     * 某格当前在册那一次的 props（重绑后应是新一代）。
     *
     * 没有 `inject` 面的注册（例如 `settings.section.icon` —— 外壳只给它
     * `{ size, active }`，不经过我们）返回 `undefined`，而不是抛：调用方常按
     * 名单逐格取值，一格没有 inject 不该让整条用例炸掉。
     */
    propsOf: (cell: string): any => {
      const inject = ledger.get(cell)?.inject as (() => any) | undefined
      return typeof inject === 'function' ? inject() : undefined
    },
  }
}

/**
 * 跑一次真实 apply，返回可观测面。
 *
 * `pluginNavigation` 走的是 **`ctx.inject([...])` 子作用域**，不是 `ctx.get()`：
 * 那个服务由 ui-plugin-manager 在自己的 slot 生成器里 `reflect.provide`，加载顺序
 * 由 profile 决定，所以 `ctx.get()` 在 apply 时刻必然拿不到它。桩必须模拟同一套
 * 机制 —— 有服务就同步调一次回调，没服务就干脆不调（真实 cordis 正是如此）。
 */
function mount(forms: any, pluginNavigation?: { openBundle(name: string): void }) {
  const stub = slotsStub()
  const effects: Array<{ run: () => unknown; label: string | undefined; disposer: unknown }> = []
  const ctx: any = {
    // 退路是**现查**的（`softGet('pluginNavigation')`）：跳转失败那一刻服务在不在，
    // 决定退路能不能用。所以桩要按同一个语义回答 `get`。
    get: (name: string) => (name === 'configForms' ? forms : name === 'pluginNavigation' ? pluginNavigation : undefined),
    inject: (deps: string[], run: (scope: any) => unknown) => {
      if (!Array.isArray(deps) || !deps.includes('pluginNavigation')) return
      // 服务缺席时不进入回调，与 cordis 一致。
      if (pluginNavigation === undefined) return
      return run({ ...ctx, pluginNavigation })
    },
    effect: (run: () => unknown, label?: string) => {
      const disposer = run()
      effects.push({ run, label, disposer })
    },
    locale: { register: () => () => {}, bind: () => keyT },
    slots: stub.slots,
  }
  apply(ctx)
  return { ...stub, effects }
}

/**
 * 同一套 apply，但 `pluginNavigation` **可以晚到** —— 用来复现真实的加载顺序：
 * profile 的 bundles 数组把本插件排在 ui-plugin-manager 前面，那个服务是在对方
 * 自己的 slot 生成器里才 `reflect.provide` 的。
 */
function mountDeferred(forms: any) {
  const stub = slotsStub()
  const effects: Array<{ run: () => unknown; label: string | undefined; disposer: unknown }> = []
  // 等服务的回调先挂起来，`deliver()` 时再跑（cordis 正是这个语义）。
  const waiting: Array<() => void> = []
  let navigation: { openBundle(name: string): void } | undefined
  const ctx: any = {
    get: (name: string) => (name === 'configForms' ? forms : name === 'pluginNavigation' ? navigation : undefined),
    inject: (deps: string[], run: (scope: any) => unknown) => {
      if (!Array.isArray(deps) || !deps.includes('pluginNavigation')) return
      waiting.push(() => run({ ...ctx, pluginNavigation: navigation }))
    },
    effect: (run: () => unknown, label?: string) => {
      const disposer = run()
      effects.push({ run, label, disposer })
    },
    locale: { register: () => () => {}, bind: () => keyT },
    slots: stub.slots,
  }
  apply(ctx)
  return {
    ...stub,
    effects,
    /** 宿主把 Plugins 页挂上来（等价于那个服务终于 provide 了）。 */
    host: { attachNavigation: (service: { openBundle(name: string): void }) => { navigation = service } },
    /** 服务到货：跑那些一直在等的回调。 */
    deliver: () => { for (const run of waiting.splice(0)) run() },
  }
}

describe('真实 apply() 的 settings 命名空间绑定', () => {
  it('镜像晚到且以 include: 前缀挂载时，卡片必须绑到宿主真正服务的那个命名空间', () => {
    // workbuddy 上游注释记着：实测 Desktop 宿主把插件挂成 `include:<id>`。
    // 宿主 `describe()` 返回的 ns 就是 Loader entry id，且**精确匹配**。
    const stub = formsStub({ mirrorLandsLater: true })
    const { injected } = mount(stub.forms)
    stub.land(['include:dsh-connect-qoder'])

    const cardProps = injected
      .filter(e => e.slot === 'settings.section')
      .map(e => e.props())
      .at(-1)
    // 绑到 include: 那个才算绑对；绑到裸名（宿主不服务）就是 #46 的原始症状。
    expect((cardProps?.settingsScope as any)?.__form).toBe('include:dsh-connect-qoder')
  })

  it('宿主从不服务本命名空间时，settingsScope 必须是 undefined（只读降级），不是猜出来的 form', () => {
    const stub = formsStub({ mirrorLandsLater: true })
    const { injected } = mount(stub.forms)
    stub.land(['some-other-plugin'])

    const cardProps = injected
      .filter(e => e.slot === 'settings.section')
      .map(e => e.props())
      .at(-1)
    // 卡片用 `settingsScope !== undefined` 决定能不能写（canEditPool / canSwitch）。
    // 给它一个 unavailable 的 form = 让它以为能写，写入落空且无报错。
    expect(cardProps?.settingsScope).toBeUndefined()
  })

  it('边缘永不触发时卡片仍必须注册（#55：空 Plugins 页且无报错）', () => {
    const stub = formsStub({ mirrorLandsLater: true })
    const { live } = mount(stub.forms)
    // 还没等到任何镜像答案，五个槽位就应该在册（#12 起含模型选择器标签）。
    expect(live()).toHaveLength(5)
    // **不止数条数**：1.18.0 把插件页那两格卡片换成了「设置页 + 导航图标」，
    // 条数恰好还是 5 —— 只数条数的话这次换血完全看不出来。所以逐格点名。
    expect(live()).toEqual(expect.arrayContaining([
      'settings.section#dsh-connect-qoder',
      'settings.section.icon#dsh-connect-qoder',
      'conversation.input.right#dsh-connect-qoder-composer-credits',
      'conversation.composer.dock#dsh-connect-qoder-stats-credits',
    ]))
    // 插件市场那两个卡片槽必须已经消失：同一份配置不该有两个编辑入口。
    expect(live().some(cell => cell.startsWith('plugins.'))).toBe(false)
  })

  it('重绑是先 dispose 再注册：同 key 同优先级不会撞「already has an entry」', () => {
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const { live } = mount(stub.forms)
    expect(live()).toHaveLength(5)
    // 命名空间答案变化 → 重绑。若顺序反了（先注册再 dispose），这里就抛。
    expect(() => stub.land(['include:dsh-connect-qoder'])).not.toThrow()
    expect(live()).toHaveLength(5)
  })

  it('旧宿主（无 whileServed）回退成单次绑定 + 单次注册', () => {
    const legacy = {
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-connect-qoder' }] } }) }),
      get: (ns: string) => ({ __form: ns, status: 'ready' }),
    }
    const { injected, live } = mount(legacy)
    expect(live()).toHaveLength(5)
    const cardProps = injected.filter(e => e.slot === 'settings.section').map(e => e.props()).at(-1)
    expect((cardProps?.settingsScope as any)?.__form).toBe('dsh-connect-qoder')
  })

  it('无 settings 面（configForms 缺席）时卡片仍注册，且只读', () => {
    const { injected, live } = mount(undefined)
    expect(live()).toHaveLength(5)
    const cardProps = injected.filter(e => e.slot === 'settings.section').map(e => e.props()).at(-1)
    expect(cardProps?.settingsScope).toBeUndefined()
    expect(cardProps?.t).toBeDefined()
  })

  it('真正的重绑（served → unserved → served）：五条注册**全部**换新，且不吞掉重复注册', () => {
    // 这条盯的是「每条注册的 disposer 都被追踪」：`registerAllSlots` 靠各
    // register* 的**返回值**收集 disposer，少一个 `return` 就会让那两个 composer
    // 读数槽漏出 `liveDisposers` —— 后果有两层：① 插件 fiber 拆除时它们不被
    // dispose（泄漏）；② 每次重绑都撞宿主「already has an entry」并被那个只打
    // 日志的 try/catch 吞掉，于是 composer 读数**永远停在第一代闭包**里，
    // settingsScope 换绑了它也看不见。
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const { live, propsOf } = mount(stub.forms)
    expect(live()).toHaveLength(5)

    stub.land([])                            // 宿主停止服务 → whileServed 拆除注册
    expect(live()).toHaveLength(0)

    stub.land(['include:dsh-connect-qoder'])  // 换个拼写再服务 → 边缘触发重绑
    expect(live()).toHaveLength(5)

    // 四个槽位当前在册的那一代，都得读到**新**命名空间的 form。
    const cells = [
      'settings.section#dsh-connect-qoder',
      'settings.section.icon#dsh-connect-qoder',
      'conversation.input.right#dsh-connect-qoder-composer-credits',
      'conversation.composer.dock#dsh-connect-qoder-stats-credits',
    ]
    for (const cell of cells) {
      const props = propsOf(cell)
      // 图标那格没有我们自己的 inject 面（外壳直接喂 `{ size, active }`），
      // 只要求它在册；其余每一格都必须读到**新**命名空间的 form。
      if (props === undefined) continue
      expect((props.settingsScope as any)?.__form, cell).toBe('include:dsh-connect-qoder')
    }
  })

  it('设置按钮在**首次注册**那一刻就有值（晚赋值等于按钮不存在）', () => {
    // 真实缺陷：`openPluginSettings` 一度在 `bindSettingsScope()` **之后**才赋值，
    // 而 `bindSettingsScope()` 会立刻跑一次 `registerAllSlots()` —— `inject`
    // 闭包在那一刻读到的是 `undefined`。积分面板据此不渲染那颗齿轮，之后也没有
    // 任何东西会纠正它：渲染器把 `inject()` 的结果 `useMemo` 掉了（依赖
    // `[actions, definition, scopeBinding]`），注册对象不变就不会重算。
    //
    // 所以断言的是**注册那一刻求值出来的 props**（`first`），不是事后再取一次。
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const { injected } = mount(stub.forms)
    const first = injected.filter(e => e.slot === 'conversation.input.right').at(0)
    expect(first).toBeDefined()
    expect(first!.first?.t).toBeDefined()
    expect(typeof first!.first?.openSettings).toBe('function')
    // 再取一次也要一样（重绑之后仍然有值）。
    const latest = injected
      .filter(e => e.slot === 'conversation.input.right')
      .map(e => e.props())
      .at(-1)
    expect(typeof latest?.openSettings).toBe('function')
  })

  it('跳转命中导航行：点了设置触发器、点了那一行，且不退回插件市场', () => {
    vi.useFakeTimers()
    const opened: string[] = []
    let selected = 0
    try {
      const stub = formsStub({ served: ['dsh-connect-qoder'] })
      const { injected } = mount(stub.forms, { openBundle: name => { opened.push(name) } })
      const composerProps = injected
        .filter(e => e.slot === 'conversation.input.right')
        .map(e => e.props())
        .at(-1)

      // 造出真实外壳的两块：侧边栏触发器 + 点击后挂到 body 的设置面板。
      const trigger = document.createElement('button')
      trigger.setAttribute('aria-haspopup', 'dialog')
      trigger.setAttribute('aria-expanded', 'false')
      trigger.addEventListener('click', () => {
        const panel = document.createElement('div')
        panel.setAttribute('data-shortcut-modal', 'settings')
        const row = document.createElement('button')
        // 真实标签由 `section.label` 给，这里的 t 是 key 直通桩。
        row.textContent = 'section.label'
        row.addEventListener('click', () => { selected += 1 })
        panel.append(row)
        document.body.append(panel)
      })
      document.body.append(trigger)

      composerProps.openSettings()
      // 跳转是分帧重试的（面板刚挂上时导航行还没渲染），把定时器跑完。
      vi.runAllTimers()
      expect(selected).toBe(1)
      expect(opened).toEqual([])
    } finally {
      vi.useRealTimers()
      document.body.innerHTML = ''
    }
  })

  it('标签对不上时退回 openBundle（那颗按钮不能是死的）', () => {
    vi.useFakeTimers()
    const opened: string[] = []
    try {
      const stub = formsStub({ served: ['dsh-connect-qoder'] })
      const { injected } = mount(stub.forms, { openBundle: name => { opened.push(name) } })
      const composerProps = injected
        .filter(e => e.slot === 'conversation.input.right')
        .map(e => e.props())
        .at(-1)
      // 面板在，但里面没有标签等于 `section.label` 的行（外壳换了文案 / 被截断）。
      const panel = document.createElement('div')
      panel.setAttribute('data-shortcut-modal', 'settings')
      const other = document.createElement('button')
      other.textContent = 'some other section'
      panel.append(other)
      document.body.append(panel)

      composerProps.openSettings()
      vi.runAllTimers()
      // 重试全部用尽 ⇒ 退路接管，且收的是 npm 包名（插件市场按包名索引 bundle 行）。
      expect(opened).toEqual(['@dmh2002/dsh-connect-qoder'])
    } finally {
      vi.useRealTimers()
      document.body.innerHTML = ''
    }
  })

  it('插件市场比本插件晚加载时，退路仍然可用（服务是查的时候才需要的）', async () => {
    // `pluginNavigation` 由 ui-plugin-manager 在自己的 slot 生成器里
    // `reflect.provide`，而 profile 的 bundles 数组把本插件排在它前面。
    //
    // 现在它只是**退路**：主路径是 DOM 跳转，不需要任何服务。退路要活下来，
    // 就不能在 apply 时刻探一次再存起来（那时必然 undefined，且没有第二次机会），
    // 必须在真正要退的时候现查 —— 这条断言钉的就是「现查」。
    vi.useFakeTimers()
    const opened: string[] = []
    try {
      const stub = formsStub({ served: ['dsh-connect-qoder'] })
      const late = mountDeferred(stub.forms)
      const props = () => late.injected
        .filter(e => e.slot === 'conversation.input.right')
        .map(e => e.props())
        .at(-1)
      // apply 那一刻服务还没到，按钮也已经有了。
      expect(typeof props()?.openSettings).toBe('function')
      // 服务到货（晚到）。
      late.host.attachNavigation({ openBundle: name => { opened.push(name) } })
      // 没有设置面板 → 跳转无从下手 → 退路现查到刚挂上来的服务。
      props()!.openSettings()
      vi.runAllTimers()
      expect(opened).toEqual(['@dmh2002/dsh-connect-qoder'])
    } finally {
      vi.useRealTimers()
      document.body.innerHTML = ''
    }
  })

  it('重绑期间不得有任何注册失败被吞掉（含 already-has-an-entry）', () => {
    // 上一条断言「五条都在册」；这一条断言「过程中没有静默失败」。两者要分开：
    // 注册失败被 try/catch 降级成 console.error 时，槽位数可能仍然凑够（旧一代
    // 没被 dispose 掉，还挂在账本上），只有这条能看出差别。
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(stub.forms)
    stub.land(['include:dsh-connect-qoder'])
    const failures = errorSpy.mock.calls.map(call => String(call[1] ?? call[0]))
    errorSpy.mockRestore()
    expect(failures).toEqual([])
  })

  it('模型选择器标签以 priority -1 + locale 注册（single 槽：与他人同优先级会直接抛）', () => {
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const { injected } = mount(stub.forms)
    const label = injected.filter(e => e.slot === 'conversation.input.model.label').at(-1)
    expect(label).toBeDefined()
    // workbuddy 占着默认优先级 0；同优先级注册在 single 槽上会抛
    // 「already has a registration at priority ...」。升序取首条 ⇒ 要排在它前面。
    expect(label?.options.priority).toBe(-1)
    // locale 决定渲染器是否把命名空间绑好的 t 递进来（#12 报告的坑 D）。
    expect(label?.options.locale).toBe('settings.qoder')
  })

  it('单个槽位注册失败不拖垮其余槽位（每槽各自 try/catch）', () => {
    const stub = formsStub({ served: ['dsh-connect-qoder'] })
    const slots = slotsStub()
    const failing = {
      ...slots.slots,
      register: (options: any, component: unknown) => {
        if (options.name === 'conversation.composer.dock') throw new Error('slot gone on this host line')
        return slots.slots.register(options, component)
      },
    }
    const ctx: any = {
      get: (name: string) => (name === 'configForms' ? stub.forms : undefined),
      effect: (run: () => unknown) => run(),
      locale: { register: () => () => {}, bind: () => keyT },
      slots: failing,
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => apply(ctx)).not.toThrow()
    // 五条里坏了一条，其余四条仍在册。
    expect(slots.live()).toHaveLength(4)
    errorSpy.mockRestore()
  })
})

describe('积分读数的座位（同步自 trae issue #71）', () => {
  it('composer 读数注册在 conversation.input.right，而不是贴着权限选择器的 input.left', () => {
    // 这条盯的是「读数登在哪个座位」。宿主把 input.right 渲染在
    // standardControls 内、模型选择器**之前**，而 input.left 在 div.tools 最末尾、
    // 距权限选择器仅 8px——两者都可点，想点「完全权限」会点到读数并弹出积分浮层。
    //
    // 之所以单独写一条：本文件的 `live()` 只数条数（5 条），`propsOf()` 用固定
    // cell 查 props 且在查不到时静默返回 undefined——所以把座位名从 right 改回
    // left，整个文件仍然全绿（实测如此）。座位本身此前没有任何断言。
    const { live } = mount(undefined)

    // 两个读数座位都在册，且「输入框工具栏」那一档落在 input.right。
    expect(live()).toContain('conversation.input.right#dsh-connect-qoder-composer-credits')
    expect(live()).toContain('conversation.composer.dock#dsh-connect-qoder-stats-credits')

    // 反向：不得再注册到 input.left。只断言「right 存在」是不够的——
    // 若两处都注册，右侧那个会覆盖左侧、症状被掩盖。
    expect(live().some(cell => cell.startsWith('conversation.input.left#'))).toBe(false)
  })
})
