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
 * The veil. Deliberately NOT a modal dialog: it carries no focusable control
 * and no dismissal — there is nothing for the user to decide, only a step to
 * wait through.
 */
export function BusyOverlay({ message, hint, visible }: BusyOverlayProps): ReactElement | null {
  if (!visible) return null
  return (
    <div className="dsm-qoder-veil" role="status" aria-busy="true" aria-live="polite">
      <div className="dsm-qoder-veil-card">
        <span className="dsm-qoder-veil-spinner" aria-hidden="true" />
        <span className="dsm-qoder-veil-text">{message}</span>
        {hint === undefined ? null : <span className="dsm-qoder-veil-hint">{hint}</span>}
      </div>
    </div>
  )
}