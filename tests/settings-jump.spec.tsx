// @vitest-environment jsdom
/**
 * `settings-jump.ts` 的单元回归。
 *
 * 这个模块负责 composer 积分面板里那颗「设置」按钮的落点：宿主**没有**给插件
 * 「打开某一 settings.section」的公开入口（`openSection` 只发给
 * `settings.onboarding` 的注册者），所以跳转只能驱动真实 chrome —— 点侧边栏的
 * 设置触发器，再在面板里按导航标签找本插件那一行。
 *
 * 钉住三件事：
 *
 *  1. **面板已经开着时不能再点触发器**（那一下会把面板关掉，跳转变成「消失」）；
 *  2. 面板刚挂上、导航行还没渲染的那一帧要**重试**，不能一次失手就放弃；
 *  3. 找不到路时必须**退回** `onGiveUp`，而不是留一颗点了没反应的按钮。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openQoderSettingsSection } from '../src/client/settings-jump.ts'

/** 每次调度立即执行的调度器：把重试压成同步，断言不用等真定时器。 */
const immediate = (run: () => void): void => { run() }

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
