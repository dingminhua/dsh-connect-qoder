/**
 * Best-effort jump to this plugin's **设置页分区**（Settings → Qoder）.
 *
 * 为什么不是一次函数调用：宿主没有给插件「打开某一 settings.section」的公开入口。
 * 外壳的 `settings.section` 页由 `ui-settings-general` 自己持有选中态
 * （`createSettingsShellStore` 的 `activeId`），`openSection(id)` 只发给
 * `settings.onboarding` 的注册者 —— 那是首启引导的座位，不是配置入口。整份
 * `@deepseek-ai/dsh-client-ui-settings` 的 client 契约里没有任何
 * `openSection` / `selectedSection` 之类的服务面。
 *
 * 所以这里驱动**真实 chrome**，与 dsh-context 的 `settingsJump` 同一路数：
 *
 *   1. 点侧边栏那颗设置触发器（`aria-haspopup="dialog"` + `aria-expanded`）；
 *   2. 等面板挂上（它按需渲染到 body），再在面板里按**导航标签**找本插件的行；
 *   3. 点它。
 *
 * 每一步都各自兜住：外壳换了形状（旧宿主、没有侧边栏、标签语种不同）时整次跳转
 * 降级成静默 no-op —— 这条路径从渲染路径上被调用，**绝不能把异常抛回调用方**。
 * 一个点了没反应的按钮不理想，但比让积分面板整块崩掉好。
 *
 * 为什么按标签找而不是按 id：外壳给导航行渲染的是 `row.label`（已本地化的
 * 字符串），DOM 上没有 `data-section-id` 之类的稳定锚点；`aria-current` 只在
 * 选中的那一行上。标签来自我们自己的 `section.label`，两个语种都在本仓库里，
 * 所以「找到的」与「注册的」是同一个常量，不会漂移。
 *
 * @module dsh-connect-qoder/client/settings-jump
 */

/**
 * 设置面板的容器选择器。
 *
 * `data-shortcut-modal="settings"` 是外壳自己写的属性（快捷键路由靠它判断
 * 「当前弹出的模态是不是设置」），比任何类名都稳 —— 类名是 CSS Modules 的哈希。
 */
const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

/** 侧边栏那颗设置触发器：对话框语义 + 展开状态。 */
const TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'

/**
 * 面板挂载 + 导航行渲染的等待预算。
 *
 * 面板是点击后**同步**挂到 body 的，但导航行的 `label` 要等 locale 快照，
 * 所以在同一帧里查一次往往差一点点。四次、每次 70ms：足够覆盖一次布局，
 * 又短到用户感知不到「点了没反应」。
 */
const RETRY_DELAYS_MS = [0, 70, 70, 120] as const

export interface SettingsJumpOptions {
  /** 文档；测试注入。 */
  doc?: Document
  /** 本插件导航行的标签（取当前语言的 `section.label`），每次点击时求值。 */
  label: () => string
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
 * 打开设置面板并选中本插件的分区。
 *
 * @returns 是否已经点到了导航行（`false` = 这次跳转降级成了 no-op）。
 */
export function openQoderSettingsSection(options: SettingsJumpOptions): boolean {
  const { doc = document, label } = options
  const schedule = options.schedule ?? defaultSchedule
  try {
    // 面板可能已经开着（用户刚看过别的分区）：那就别再点触发器 —— 那一下会
    // 把面板关掉，跳转反而变成「消失」。
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
