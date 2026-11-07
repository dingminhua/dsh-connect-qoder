// @vitest-environment jsdom
/**
 * `settings-jump.ts` 的单元回归。
 *
 * 这颗「设置」按钮有**两条**路：
 *
 *  1. 外壳自己的 store 座位（`sidebar.settings` 的 `store.create().actions.openSection(id)`），
 *     一次调用就把对话框开在本插件这一页；
 *  2. 驱动真实 chrome —— 点侧边栏的设置触发器，再在面板里按导航标签找本插件那一行。
 *
 * 钉住的事：
 *
 *  1. **座位优先**：有座位时一次调用落地，一次 chrome 都不碰；
 *  2. 座位**每次按下现探**，所以后加载的侧边栏 bundle 仍能被找到；
 *  3. 座位只有 `open()`（早于 `openSection` 的 shell）时，仍要落到本插件那一行；
 *  4. **面板已经开着时不能再点触发器**（那一下会把面板关掉，跳转变成「消失」）；
 *  5. 面板刚挂上、导航行还没渲染的那一帧要**重试**，不能一次失手就放弃；
 *  6. 找不到路时必须**退回** `onGiveUp`，而不是留一颗点了没反应的按钮。
 *
 * 前三条是 1.20.0 加的；后三条是 1.18.0 就有的 chrome 路径，一条都没放松。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openQoderSettingsSection } from '../src/client/settings-jump.ts'

/** 每次调度立即执行的调度器：把重试压成同步，断言不用等真定时器。 */
const immediate = (run: () => void): void => { run() }

/** 一个让 `slots.entries('sidebar.settings')` 交出 `store` 的 `ctx.get`。 */
function getWithSeat(store: unknown): (name: string) => unknown {
  return (name: string) =>
    name === 'slots'
      ? { entries: (key: string) => (key === 'sidebar.settings' ? [{ store }] : []) }
      : undefined
}

interface Harness {
  doc: Document
  triggerClicks: number
  rowClicks: number
  gaveUp: number
}

/**
 * 造一台外壳：侧边栏触发器（`aria-haspopup="dialog"` + `aria-expanded`），
 * 点下去把设置面板挂到 body，面板里有一行标签等于 `rowLabel` 的导航按钮。
 */
function mountShell(options: {
  open?: boolean
  rowLabel?: string
  omitRow?: boolean
} = {}): Harness {
  const doc = document.implementation.createHTMLDocument('shell')
  const state: Harness = {
    doc,
    triggerClicks: 0,
    rowClicks: 0,
    gaveUp: 0,
  }
  const panel = doc.createElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')

  if (options.open === true) doc.body.append(panel)
  else panel.remove()

  const trigger = doc.createElement('button')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', options.open === true ? 'true' : 'false')
  trigger.addEventListener('click', () => {
    state.triggerClicks += 1
    doc.body.append(panel)
    trigger.setAttribute('aria-expanded', 'true')
  })
  doc.body.append(trigger)

  if (options.omitRow !== true) {
    const row = doc.createElement('button')
    row.textContent = options.rowLabel ?? 'Qoder'
    row.addEventListener('click', () => { state.rowClicks += 1 })
    panel.append(row)
  }
  return state
}

describe('openQoderSettingsSection', () => {
  afterEach(() => { vi.useRealTimers() })

  it('面板关着时：点触发器 → 找到导航行 → 点它', () => {
    const harness = mountShell({})
    const ok = openQoderSettingsSection({
      doc: harness.doc,
      label: () => 'Qoder',
      schedule: immediate,
    })
    expect(ok).toBe(true)
    expect(harness.triggerClicks).toBe(1)
    expect(harness.rowClicks).toBe(1)
    expect(harness.gaveUp).toBe(0)
  })

  it('面板已经开着时不再点触发器（点了会把面板关掉）', () => {
    const harness = mountShell({ open: true })
    openQoderSettingsSection({ doc: harness.doc, label: () => 'Qoder', schedule: immediate })
    expect(harness.triggerClicks).toBe(0)
    expect(harness.rowClicks).toBe(1)
  })

  it('导航行晚一帧渲染时重试能接上（不是一次失手就放弃）', () => {
    const harness = mountShell({})
    let frame = 0
    // 第一次查不到，第二次才「渲染出来」。
    const schedule = (run: () => void): void => {
      frame += 1
      if (frame === 1) { run(); return }
      // 第二次调度之前把行补进去，模拟面板刚挂上的那一帧。
      if (frame === 2) {
        const row = harness.doc.createElement('button')
        row.textContent = 'Qoder'
        row.addEventListener('click', () => { harness.rowClicks += 1 })
        harness.doc.querySelector('[data-shortcut-modal="settings"]')!.append(row)
      }
      run()
    }
    openQoderSettingsSection({ doc: harness.doc, label: () => 'Qoder', schedule })
    expect(harness.rowClicks).toBe(1)
    expect(harness.gaveUp).toBe(0)
  })

  it('标签对不上时退回 onGiveUp（那颗按钮不能是死的）', () => {
    const harness = mountShell({ rowLabel: 'Plugins' })
    const result = openQoderSettingsSection({
      doc: harness.doc,
      label: () => 'Qoder',
      schedule: immediate,
      onGiveUp: () => { harness.gaveUp += 1 },
    })
    expect(result).toBe(true)
    // 行在，但标签不是我们要的那一行 —— 一次都不该点它。
    expect(harness.rowClicks).toBe(0)
    expect(harness.gaveUp).toBe(1)
  })

  it('这台宿主没有设置触发器时走退路，而不是静默什么都不做', () => {
    const doc = document.implementation.createHTMLDocument('bare')
    let gaveUp = 0
    const result = openQoderSettingsSection({
      doc,
      label: () => 'Qoder',
      schedule: immediate,
      onGiveUp: () => { gaveUp += 1 },
    })
    expect(result).toBe(false)
    expect(gaveUp).toBe(1)
  })

  it('没有标签（空串）时不误点任何行', () => {
    const harness = mountShell({ rowLabel: '' })
    openQoderSettingsSection({
      doc: harness.doc,
      label: () => '   ',
      schedule: immediate,
      onGiveUp: () => { harness.gaveUp += 1 },
    })
    expect(harness.rowClicks).toBe(0)
    expect(harness.gaveUp).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 第 1 条路：外壳自己的 store 座位
// ---------------------------------------------------------------------------

describe('openQoderSettingsSection — store 座位', () => {
  // 与上面同一套约定：断言「这台宿主上没有 chrome」的用例必须从空文档开始，
  // 否则上一条用例残留的 trigger 会替它应答，那条断言就什么也没证明。
  beforeEach(() => { document.body.innerHTML = '' })

  it('一次调用就开在本插件这一页，且完全不碰 chrome', () => {
    // 这条路的全部意义：`openSection(id)` 同时选中分区并打开对话框，所以不存在
    // 用户先看到「错误的页」的窗口。id 必须是**注册过的**那个 —— 未知 id 对外壳
    // 的 store 不是错误，它会静默打开回退分区（第一页）。
    const opened: string[] = []
    const store = { create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-expanded', 'false')
    let triggerClicks = 0
    trigger.addEventListener('click', () => { triggerClicks += 1 })
    document.body.append(trigger)

    const taken = openQoderSettingsSection({
      label: () => 'Qoder',
      get: getWithSeat(store),
      schedule: immediate,
    })
    expect(taken).toBe(true)
    expect(opened).toEqual(['dsh-connect-qoder'])
    // 座位已经答了，就不该再退回去点界面。
    expect(triggerClicks, '座位能走通却还点了侧边栏触发器').toBe(0)
  })

  it('每次按下都重新探测，后加载的侧边栏 bundle 仍能被找到', () => {
    // 座位属于**另一个** bundle，apply 顺序不由我们决定。在 apply 时缓存一次
    // 探测结果，在这条用例里第一次就是 `undefined`，那颗按钮整个会话都是死的。
    let seats: unknown[] = []
    const get = (name: string): unknown =>
      name === 'slots'
        ? { entries: (key: string) => (key === 'sidebar.settings' ? seats.map(store => ({ store })) : []) }
        : undefined

    // 第一次按下：侧边栏还没 apply，也没有 chrome —— 一条路都走不了。
    const first = openQoderSettingsSection({
      label: () => 'Qoder', get, onGiveUp: () => {}, schedule: immediate,
    })
    expect(first, '在没有座位也没有 chrome 的宿主上报告了「已采取」').toBe(false)

    // 之后 bundle 到货；**同一份 options** 现在能找到它。
    const opened: string[] = []
    seats = [{ create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }]
    const second = openQoderSettingsSection({
      label: () => 'Qoder', get, onGiveUp: () => {}, schedule: immediate,
    })
    expect(second).toBe(true)
    expect(opened).toEqual(['dsh-connect-qoder'])
  })

  it('不传 sectionId 时用自己的 id，也认调用方的覆盖', () => {
    const opened: string[] = []
    const store = { create: () => ({ actions: { openSection: (id: string) => opened.push(id) } }) }
    openQoderSettingsSection({ label: () => 'X', get: getWithSeat(store), schedule: immediate })
    openQoderSettingsSection({
      label: () => 'X', get: getWithSeat(store), sectionId: 'other-id', schedule: immediate,
    })
    expect(opened).toEqual(['dsh-connect-qoder', 'other-id'])
  })

  it('座位早于 openSection（只有 open）时，仍落到本插件那一行', () => {
    // 这种 shell 上按下按钮绝不能停在「设置随便某页」：调 open() 打开面板，然后
    // 继续走第 2 条路去点这一行。
    let openedDialog = 0
    const store = { create: () => ({ actions: { open: () => { openedDialog += 1 } } }) }
    let rowClicks = 0
    const panel = document.createElement('div')
    panel.setAttribute('data-shortcut-modal', 'settings')
    const row = document.createElement('button')
    row.textContent = 'Qoder'
    row.addEventListener('click', () => { rowClicks += 1 })
    panel.append(row)
    document.body.append(panel)

    const taken = openQoderSettingsSection({
      label: () => 'Qoder', get: getWithSeat(store), schedule: immediate,
    })
    expect(taken).toBe(true)
    expect(openedDialog, '没有调用 open()').toBe(1)
    expect(rowClicks, 'open() 之后没有去点本插件的导航行').toBe(1)
  })

  it('座位缺席 / 不可用 / 抛错时，退到 chrome 那条路', () => {
    const cases: Array<[string, (name: string) => unknown]> = [
      ['没有 slots 服务', () => undefined],
      ['slots 没有 entries', () => ({ entries: undefined })],
      ['空账本', getWithSeat(undefined)],
      ['座位没有 create', getWithSeat({})],
      ['create() 抛错', getWithSeat({ create: () => { throw new Error('nope') } })],
      ['create() 返回垃圾', getWithSeat({ create: () => null })],
      ['get 本身抛错', () => { throw new Error('nope') }],
    ]
    for (const [why, get] of cases) {
      // 每种情况都必须走到第 2 条路：面板已开着且有一行对得上标签时，它会点那一行。
      // 「点到了」就是「确实落下来了」的观测点。
      let rowClicks = 0
      const panel = document.createElement('div')
      panel.setAttribute('data-shortcut-modal', 'settings')
      const row = document.createElement('button')
      row.textContent = 'Qoder'
      row.addEventListener('click', () => { rowClicks += 1 })
      panel.append(row)
      document.body.append(panel)
      try {
        const taken = openQoderSettingsSection({ label: () => 'Qoder', get, schedule: immediate })
        expect(taken, why).toBe(true)
        expect(rowClicks, `${why}：第 2 条路没有跑`).toBe(1)
      } finally {
        panel.remove()
      }
    }
  })
})
