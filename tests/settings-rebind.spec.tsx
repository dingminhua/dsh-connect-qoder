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
 * 一个槽位账本，模仿宿主的去重规则：keyed 槽位（两个 config 槽）按 `key` 占格，
 * list 槽位（两个 composer 读数槽）按 `id` 占格，同格重复注册**抛错**
 * （宿主 `ui-slots/src/index.ts`：`keyed slot … already has an entry for key …` /
 * `list slot … already has an entry with id …`）。
 */
function slotsStub() {
  const ledger = new Map<string, { inject: () => any; dispose: () => void }>()
  const injected: Array<{ slot: string; cell: string; props: () => any; options: Record<string, unknown> }> = []
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
      injected.push({ slot: options.name, cell, props: options.inject, options })
      return entry.dispose
    },
  }
  return {
    slots: slots as any,
    /** 当前**在册**的注册（已 dispose 的不算）。 */
    live: (): string[] => [...ledger.keys()],
    injected,
    /** 某格当前在册那一次的 props（重绑后应是新一代）。 */
    propsOf: (cell: string): any => ledger.get(cell)?.inject(),
  }
}

/** 跑一次真实 apply，返回可观测面。 */
function mount(forms: any) {
  const stub = slotsStub()
  const effects: Array<{ run: () => unknown; label: string | undefined; disposer: unknown }> = []
  const ctx: any = {
    get: (name: string) => (name === 'configForms' ? forms : undefined),
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

describe('真实 apply() 的 settings 命名空间绑定', () => {
  it('镜像晚到且以 include: 前缀挂载时，卡片必须绑到宿主真正服务的那个命名空间', () => {
    // workbuddy 上游注释记着：实测 Desktop 宿主把插件挂成 `include:<id>`。
    // 宿主 `describe()` 返回的 ns 就是 Loader entry id，且**精确匹配**。
    const stub = formsStub({ mirrorLandsLater: true })
    const { injected } = mount(stub.forms)
    stub.land(['include:dsh-connect-qoder'])

    const cardProps = injected
      .filter(e => e.slot === 'plugins.bundle.config')
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
      .filter(e => e.slot === 'plugins.bundle.config')
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
    const cardProps = injected.filter(e => e.slot === 'plugins.row.config').map(e => e.props()).at(-1)
    expect((cardProps?.settingsScope as any)?.__form).toBe('dsh-connect-qoder')
  })

  it('无 settings 面（configForms 缺席）时卡片仍注册，且只读', () => {
    const { injected, live } = mount(undefined)
    expect(live()).toHaveLength(5)
    const cardProps = injected.filter(e => e.slot === 'plugins.bundle.config').map(e => e.props()).at(-1)
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
      'plugins.bundle.config#@dmh2002/dsh-connect-qoder',
      'conversation.input.left#dsh-connect-qoder-composer-credits',
      'conversation.composer.dock#dsh-connect-qoder-stats-credits',
    ]
    for (const cell of cells) {
      expect((propsOf(cell)?.settingsScope as any)?.__form, cell).toBe('include:dsh-connect-qoder')
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
