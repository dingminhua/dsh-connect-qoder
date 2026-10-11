/**
 * The two shell behaviours the composer credit panel needs: hanging the panel
 * off its trigger, and dismissing it on an outside press.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `client/popover.ts`，逐条沿用其判断：同样的上下放置、同样的
 *     视口收边、同样的 scroll(capture)/resize/自身尺寸变化重测、同样的
 *     「pointerdown 落在触发器与面板之外即关闭」。这些不是随手写的——那边
 *     2.12.0/2.13.0 的客户端加载失败与面板位置错乱都留下了记录，这里直接
 *     采用其最终结论。
 *
 * Implemented locally rather than imported from
 * `@deepseek-ai/dsh-client-ui-primitives`. The shell DOES register that package
 * for plugin bundles, so importing it is legal — this is a deliberate choice,
 * not a workaround: the two behaviours are ~40 lines of DOM geometry, and owning
 * them keeps this component renderable in the Node test suite without mocking a
 * package that itself reaches `*.module.css` and further DSH dependencies.
 *
 * @module dsh-connect-qoder/client/popover
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** Inputs for {@link useAnchoredPosition}. */
export interface AnchoredPositionOptions {
  /** Whether the floating element is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating element, measured so the clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
  /** Which anchor edge the panel hangs from: above (`top`) or below (`bottom`). */
  side?: 'top' | 'bottom'
  /** Which anchor edge the panel lines up with: left (`start`) or right (`end`). */
  align?: 'start' | 'end'
  /** Distance kept between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
}

/**
 * Clearance to keep from the top of the viewport.
 *
 * The shell reserves a strip at the top of the frame
 * (`--dsh-frame-top-clearance`) for the window chrome, so a panel clamped to
 * `margin` alone can still land under it.
 */
export function overlayTopMargin(min: number): number {
  if (typeof document === 'undefined') return min
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}

/** Keep a `position: fixed` floating element anchored to a trigger. */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return undefined
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = align === 'end' ? rect.right - width : rect.left
      let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin)
      setPosition({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])

  return position
}

/**
 * Close an open popover when a pointerdown lands outside it.
 *
 * `portal` counts as inside: the panel is portaled to `document.body`, so it is
 * not a descendant of `root` and a click on the panel itself would otherwise
 * read as "outside" and dismiss the popover the user is trying to use.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && root.current?.contains(event.target) !== true
        && portal?.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}