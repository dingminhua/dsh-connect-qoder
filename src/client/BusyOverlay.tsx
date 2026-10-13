/**
 * The shared busy veil: one overlay for every account operation whose result
 * only lands on screen after the list re-read.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * 不只表示「请求还在飞」，而是持续到**列表刷新落地**为止。这两个时刻之间有一段
 * 真空期（Host 已改完、卡片的 usage 快照还没回来），把遮罩的关闭条件绑在刷新完
 * 成上，延迟就从「看不见」变成「看着它发生」。
 *
 * 文案由调用方按场景给出（删除中 / 导入中 / 添加中）；超时由调用方控制，这里只
 * 负责「显示什么」。
 *
 * @module dsh-connect-qoder/client/BusyOverlay
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'

/** Props: the veil's message, whether it is showing, and an optional detail line. */
export interface BusyOverlayProps {
  /** The scenario line, already translated by the caller. */
  message: string
  /** Extra detail under the message, already translated; omitted when absent. */
  hint?: string
  /**
   * Whether the veil is up. Rendering nothing while false keeps the common
   * resting case free of an invisible layer that would still eat clicks.
   */
  visible: boolean
}

/**
 * The shared busy veil's spinner: an arc that breathes while it turns.
 *
 * Deliberately the host's own state-spinner shape (dsh's `_dsh-state-dot-spin`)
 * rather than a border-ring: a two-tone CSS ring at .7s read as a loading
 * indicator from another decade and was out of step with every spinner in the
 * shell. The motion lives in CSS (`dsm-qoder-veil-spin` / `-dash`), so this
 * element only describes the geometry; `currentColor` lets it inherit whatever
 * tier it sits in.
 *
 * `aria-hidden` because the veil's `role="status"` already announces the
 * message — a second announcement from a decorative arc is noise.
 *
 * 对齐：dingminhua/dsh-connect-workbuddy 的 VeilSpinner（MIT，LaoDing）。类名换
 *   `dsm-qoder-*`，几何与节奏（20px / 1.5s / dash 呼吸 / currentColor）逐条沿用。
 */
function VeilSpinner(): ReactElement {
  return (
    <svg className="dsm-qoder-veil-spinner" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle className="dsm-qoder-veil-spinner-track" cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle className="dsm-qoder-veil-spinner-arc" cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The veil. Deliberately NOT a modal dialog: it carries no focusable control
 * and no dismissal — there is nothing for the user to decide, only a step to
 * wait through.
 */
export function BusyOverlay({ message, hint, visible }: BusyOverlayProps): ReactElement | null {
  if (!visible) return null
  return (
    <div className="dsm-qoder-veil" role="status" aria-busy="true" aria-live="polite">
      <div className="dsm-qoder-veil-card">
        <VeilSpinner />
        <span className="dsm-qoder-veil-text">{message}</span>
        {hint === undefined ? null : <span className="dsm-qoder-veil-hint">{hint}</span>}
      </div>
    </div>
  )
}