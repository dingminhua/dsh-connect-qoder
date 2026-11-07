/**
 * 通往本插件**设置页分区**（设置 → Qoder）的路。两条，好的一条在前。
 *
 * ## 两条路
 *
 * 1. **外壳自己的 store 座位** —— 一次调用，精确，不依赖时序：
 *    `slots.entries('sidebar.settings')[0].store.create().actions.openSection(id)`。
 * 2. **驱动真实 chrome** —— 点侧边栏的设置触发器，等面板挂上，再按导航标签点
 *    本插件那一行。
 *
 * 第 1 条正是这颗按钮该做的事（「点一下，设置直接落在本插件这一页」），且在本插件
 * 支持的宿主线上都在。第 2 条保留给外壳还没有座位的老线：那里它仍能把用户送到本
 * 插件页，删掉等于拿可用的兜底换一个空。第 1 条在有座位的地方**严格更好**：
 * `openSection(id)` 一次同时设 `activeId` 与 `open`，不存在「先停在别的分区再跳」
 * 的重试窗口，也不依赖导航行的本地化文案。
 *
 * ## 为什么座位是合法的公开面（读过的，不是照抄兄弟项目）
 *
 * 从随包发布的宿主里逐条读出来（0.2.2-rc.1，`ui-settings-general` 的 client bundle）：
 *
 *     ctx.remoteAccess.whenAccess('settings/describe', () => ctx.slots.inject('sidebar.settings', () => {
 *       const shellHandle = createSettingsShellStore()
 *       const shellInstance = shellHandle.create()
 *       const shellStore = { ...shellHandle, create: () => shellInstance }
 *       …
 *       ctx.slots.register({ name: 'sidebar.settings', locale: NS, store: shellStore, … })
 *     }))
 *
 * 以及 store 本身：
 *
 *     defineStore({
 *       init: () => ({ open: false, activeId: void 0 }),
 *       actions: {
 *         open:        (d) => { d.open = true },
 *         close:       (d) => { d.open = false; d.activeId = void 0 },
 *         select:      (d, id) => { d.activeId = id },
 *         openSection: (d, id) => { d.activeId = id; d.open = true },
 *       },
 *     })
 *
 * 三件事都承重：
 *
 *  - `create: () => shellInstance` 把座位**钉在**外壳唯一的活动实例上。裸句柄每次
 *    `create()` 另造一份，`openSection` 推动的就是一个没人渲染的副本。
 *  - `store` 是注册的**声明字段**（契约里写的是「Declared store seat; instance
 *    resolution and lifecycle live with the host machinery」），`slots.entries(key)`
 *    是公开服务方法（宿主自己的 client 测试就是这么读这块座位的）。
 *  - **只有 `openSection` 能回答这个需求。** 公开契约里 `settings.section` 的注册方
 *    只拿到 `close`；`settings.launcher` 拿到的是不带 id 的 `openSettings`；
 *    `openSection(id)` 只发给 `settings.onboarding` 的步骤。为了拿它去注册一个假的
 *    首启步骤，比读一块外壳自己发布的座位侵入得多。
 *
 * ## 为什么每次**按下**才探测，而不是 `apply` 时探测一次
 *
 * 座位属于**另一个 bundle**，它的 apply 顺序不归我们假设。在 `apply` 里探一次，
 * 在侧边栏后加载的宿主上会永远拿到 `undefined`，那颗按钮整个会话都是死的。
 * `entries()` 对未声明的槽位返回 `[]`，所以每次按下现探是无状态且永远当前的。
 *
 * ## 第 2 条路（驱动 chrome）为什么留着
 *
 * 本插件声明的宿主范围跨到了可能早于该座位的 shell 线。座位缺席时旧路仍把用户送到
 * 本插件页，所以不能删。它现在是**第二选择**，这意味着它已知的弱点（导航行按本地化
 * 标签匹配，我们没出过的语种匹配不上）再也不会影响有座位的宿主。
 *
 *   1. 点外壳的设置触发器（`aria-haspopup="dialog"` + `aria-expanded`）—— 除非面板
 *      已经开着，那时再点会把它关掉，跳转变成「消失」；
 *   2. 等面板挂上（它按需渲染到 body）；
 *   3. 按**标签**找到本插件那一行并点它。
 *
 * ## 为什么它从不抛异常
 *
 * 每一步都从渲染路径被调用（积分浮层里的一个点击处理器）。这里抛出去毁的是整块读数，
 * 而不是一颗按钮 —— 所以每一级各自吞掉自己的失败，外壳形状不同时整次跳转降级成
 * 静默 no-op。
 *
 * @module dsh-connect-qoder/client/settings-jump
 */

import { QODER_SETTINGS_NS } from '../status-paths.ts'

/**
 * 设置面板的容器选择器。
 *
 * `data-shortcut-modal="settings"` 是外壳自己写的属性（快捷键路由靠它判断
 * 「当前弹出的模态是不是设置」），比任何类名都稳 —— 类名是 CSS Modules 的哈希。
 */
const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

/** 侧边栏那颗设置触发器：对话框语义 + 展开状态。 */
const TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'

/** 外壳发布设置状态句柄的那个槽位。 */
const SETTINGS_SLOT = 'sidebar.settings'

/**
 * 面板挂载 + 导航行渲染的等待预算。
 *
 * 面板是点击后**同步**挂到 body 的，但导航行的 `label` 要等 locale 快照，
 * 所以在同一帧里查一次往往差一点点。四次、每次 70ms：足够覆盖一次布局，
 * 又短到用户感知不到「点了没反应」。
 *
 * 只有第 2 条路（驱动 chrome）用到它：第 1 条路一次调用就落地。
 */
const RETRY_DELAYS_MS = [0, 70, 70, 120] as const

/** 从这里调用到的那一小片活动外壳实例。 */
interface SettingsShellInstanceLike {
  actions?: {
    /** 同时设 `activeId` 与 `open` —— 「打开设置并停在这一页」。 */
    openSection?: (id: string) => void
    /** 只打开对话框，不选分区。 */
    open?: () => void
  } | undefined
}

/** 声明式 store 座位里本模块会碰到的那一片。 */
interface SettingsShellSeatLike {
  create?: () => SettingsShellInstanceLike
}

/** 槽位账本条目里本模块会读的那一片。 */
interface SlotLedgerEntryLike {
  store?: unknown
}

/** `slots` 服务里本模块会调用的那一片。 */
interface SlotsServiceLike {
  entries?: (key: string) => readonly SlotLedgerEntryLike[]
}

export interface SettingsJumpOptions {
  /** 文档；测试注入。 */
  doc?: Document
  /** 本插件导航行的标签（取当前语言的 `section.label`），每次点击时求值。 */
  label: () => string
  /**
   * 软服务探测（`ctx.get`）：缺席的服务返回 `undefined` 而不是抛错。**每次按下
   * 都调一次**，所以 apply 之后才到货的服务仍能被找到。
   */
  get?: (name: string) => unknown
  /**
   * 本插件注册的 `settings.section` id。默认取自同一个常量，页面注册、导航行与
   * 这次调用因此不会漂移 —— 未知 id 对外壳的 store **不是**错误，它会静默打开
   * 回退分区（第一页）。
   */
  sectionId?: string
  /**
   * 重试全部用尽仍未找到导航行时调用。调用方用它退回旧落点（Plugins 页），
   * 免得「标签对不上」变成一颗彻底死掉的按钮。
   */
  onGiveUp?: () => void
  /** 调度器：默认 `window.setTimeout`。 */
  schedule?: (run: () => void, ms: number) => void
}

function defaultSchedule(run: () => void, ms: number): void {
  try {
    window.setTimeout(run, ms)
  } catch {
    run()
  }
}

function buttonsIn(scope: ParentNode): HTMLButtonElement[] {
  // `Array.from` 而不是展开：tsconfig 的 lib 里没有 DOM.Iterable，NodeList 在
  // 类型层面不可迭代（运行期当然可以）。
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
}

/** 找到标签等于本插件行的那颗导航按钮。 */
function findSectionRow(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  const want = label.trim()
  if (want === '') return undefined
  return buttonsIn(scope).find(button => (button.textContent ?? '').trim() === want)
}

/**
 * 通过外壳的 store 座位打开设置并选中本插件分区。
 *
 * @returns `'opened'` = 对话框已经停在正确的分区上（完事）；`'shell'` = 对话框
 *   已打开但没预选（第 2 条路还能去点那一行）；`undefined` = 座位缺席或不可用。
 */
function openThroughStoreSeat(
  get: (name: string) => unknown,
  sectionId: string,
): 'opened' | 'shell' | undefined {
  let slots: SlotsServiceLike | undefined
  try {
    slots = get('slots') as SlotsServiceLike | undefined
  } catch {
    return undefined
  }
  if (slots === undefined || typeof slots.entries !== 'function') return undefined

  let seat: unknown
  try {
    // 一次普通的账本读取 —— 但它是**别人**的服务：组合出来的 profile 可以把
    // `slots` 换成一个到这里就抛错的实现。
    seat = slots.entries(SETTINGS_SLOT)[0]?.store
  } catch {
    return undefined
  }
  if (seat === null || typeof seat !== 'object') return undefined

  const handle = seat as SettingsShellSeatLike
  if (typeof handle.create !== 'function') return undefined

  try {
    const instance = handle.create()
    const openSection = instance?.actions?.openSection
    if (typeof openSection === 'function') {
      openSection(sectionId)
      return 'opened'
    }
    // store 早于 `openSection` 的 shell：按下它仍会打开对话框，所以交回 `'shell'`
    // 让第 2 条路去点那一行。这样老外壳上也不会只停在「设置里随便某页」。
    const open = instance?.actions?.open
    if (typeof open === 'function') {
      open()
      return 'shell'
    }
  } catch {
    // `create()` 或某个烘焙进去的 action 抛了。这里没有别的可试。
  }
  return undefined
}

/**
 * 打开设置面板并选中本插件的分区。
 *
 * @returns 是否**采取了**某条路（`false` = 一条都走不了，外壳不可识别且
 *   `onGiveUp` 已经跑过）。
 */
export function openQoderSettingsSection(options: SettingsJumpOptions): boolean {
  const { doc = document, label } = options
  const schedule = options.schedule ?? defaultSchedule
  const sectionId = options.sectionId ?? QODER_SETTINGS_NS

  // ---- 第 1 条路：外壳自己的 store 座位（精确，一次调用）-------------------
  if (options.get !== undefined) {
    let seatResult: 'opened' | 'shell' | undefined
    try {
      seatResult = openThroughStoreSeat(options.get, sectionId)
    } catch {
      // 探测本身也绝不能把按钮弄坏。
      seatResult = undefined
    }
    if (seatResult === 'opened') return true
    // `'shell'`：对话框开着但停在别的分区 —— 继续往下走，让第 2 条路去点这一行
    // （面板现在是开着的，正是第 2 条路会识别、且不会再去点触发器的状态）。
  }

  // ---- 第 2 条路：驱动真实 chrome ------------------------------------------
  try {
    // 面板可能已经开着（用户刚看过别的分区，或第 1 条路刚把它打开）。那时再点
    // 触发器会把面板关掉，所以只有面板确实不在时才驱动触发器。
    const existing = doc.querySelector(SETTINGS_PANEL_SELECTOR)
    if (existing === null) {
      const triggers = Array.from(doc.querySelectorAll<HTMLButtonElement>(TRIGGER_SELECTOR))
      const collapsed = triggers.find(button => button.getAttribute('aria-expanded') !== 'true')
      // 没有触发器 = 这台宿主没有设置面板（或侧边栏收起了）。不猜：直接走退路，
      // 而不是留一颗点了没反应的按钮。
      if (collapsed === undefined) {
        try { options.onGiveUp?.() } catch { /* 退路自己失败：保持 no-op */ }
        return false
      }
      collapsed.click()
    }

    let clicked = false
    let remaining = RETRY_DELAYS_MS.length
    for (const delay of RETRY_DELAYS_MS) {
      schedule(() => {
        if (clicked) return
        remaining -= 1
        try {
          const scope = doc.querySelector(SETTINGS_PANEL_SELECTOR) ?? doc
          const row = findSectionRow(scope, label())
          if (row !== undefined) {
            clicked = true
            row.click()
            return
          }
        } catch { /* 外壳形状不同：这一次尝试作罢，交给下一次 */ }
        // 最后一次也找不到：交给调用方退回旧落点。降级发生在**已经放弃**之后，
        // 不在第一次失手时 —— 面板刚挂上、导航行还没渲染是正常的一帧。
        if (remaining === 0) {
          try { options.onGiveUp?.() } catch { /* 退路自己失败：保持 no-op */ }
        }
      }, delay)
    }
    return true
  } catch {
    return false
  }
}
