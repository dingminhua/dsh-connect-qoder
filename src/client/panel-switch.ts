/**
 * 可选侧边栏面板的开关，在浏览器半边怎么存、怎么通知注册控制器。
 *
 * 参考：dingminhua/dsh-connect-workbuddy 的 `client/panel-switch.ts`（PR #188，
 * MIT，Copyright (c) 2026 LaoDing）——模块级小 store + 订阅的形态逐字沿用。
 *
 * ## 为什么是模块级 store，而不是组件状态
 *
 * `sidebar.panellist` 那一行是由**注册元数据**渲染的，不是由组件自己决定：
 * `ui-sidebar` 的 `SidebarRoot` 把 `usePanels(...)`（插槽的 entries）映射成
 * `PanelRow` 按钮 —— 标签来自 `options.label`、图标来自 `renderSlot(...)`。
 * 因此一个 `return null` 的组件**不会**让那一行消失：它留下的是一个空白但
 * 仍可点击的导航按钮。
 *
 * 这正是本插件**不能**照搬 `ComposerCreditsGate` 那种「渲染时决定」的原因：
 * 那个席位渲染的是一个组件列表，`null` 就是「不存在」；这一行是元数据。
 * 所以行只能在开关打开时**注册**，关掉时**注销**。
 *
 * 按条件注册又要求有人负责「设置变了就重注册」——那个人在入口（`apply`）里，
 * 不在组件里。本模块就是两者的接缝：卡片在**确认写入落地之后**把值写进这里，
 * 入口订阅它、按需注册或注销。
 *
 * ## 为什么用 Host 的答案做种子
 *
 * 值由 Host 在状态文档里下发（`sidebarPanelEnabled`），理由与本插件每个其它
 * 开关相同：这个命名空间的浏览器镜像在受影响的 0.1.7 部署上被记录为「陈旧」。
 * 只在启动时读 settings 作用域，会让一个陈旧的 `false` 藏起 Host 认为正在
 * 服务的行 —— 而之后**没有任何事件**去纠正它，因为 `whileServed` 只在命名空间
 * 边缘触发，不在值变化时触发。
 *
 * 页面开着时把面板关掉不需要特殊处理：`ui-layout` 的 `retainMainPanels` 会丢掉
 * 一个 `main` key 已不存在的 `activePanelId`，中央那一列自己回到对话。
 */

/** 等待开关变化的监听者。 */
const listeners = new Set<() => void>()

/**
 * 当前答案，默认**关闭**。
 *
 * 关闭正是这个开关的全部意义：缺席或读不出来的值绝不能把这一行打开。
 * 见 `src/index.ts` 的 `Config.sidebarPanel`。
 */
let wanted = false

/** 侧边栏面板此刻是否应该被注册。 */
export function sidebarPanelWanted(): boolean {
  return wanted
}

/**
 * 设置开关状态并通知注册控制器。
 *
 * 幂等：控制器每次都会重新注册，而 settings 订阅完全可能把同一个值报告两次。
 * 无法判断值是否真的变了的调用方不必先比较。
 *
 * @param next - 期望状态。
 */
export function setSidebarPanelWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  for (const listener of [...listeners]) {
    try { listener() } catch { /* 一个坏监听者不能拖垮其余 */ }
  }
}

/**
 * 观察开关状态的变化。
 *
 * @param listener - 每次变化后调用。
 * @returns 移除该监听者的 disposer。
 */
export function subscribeSidebarPanelWanted(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 在测试之间复位 store。
 *
 * 只导出给用例：生产代码永远不会想把这一项「取消设置」。
 */
export function resetSidebarPanelWanted(): void {
  wanted = false
  listeners.clear()
}
