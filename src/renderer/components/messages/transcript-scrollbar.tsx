import { useEffect, useRef, type RefObject } from 'react'

// How long the thumb stays after the last scroll input before it fades.
const HIDE_AFTER_MS = 1000
const MIN_THUMB_PX = 32
// A pointer this close to the rail brings the thumb back, so it can be found and grabbed.
const EDGE_REVEAL_PX = 16

interface TranscriptScrollbarProps {
  /** The transcript's scroller. The rail is rendered beside it, in the same positioned wrapper. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** Tells the follow engine a scrollbar press now owns the viewport (use-message-list-scroll.ts). */
  onPress: () => void
}

/**
 * The transcript's overlay scrollbar. The native one is hidden (`.transcript-scroller`): it could not leave the
 * chat column, so it sat a gutter away from the drawer's card, it ran behind the floating header and off the
 * bottom edge, and with scroll bars set to show it never went away. This thumb lives in a rail inset from the
 * header and the bottom; docked beside the drawer it sits 2px off the card's edge (globals.css). It shows
 * while the reader scrolls, or points near it, and fades a second after.
 *
 * Only input reveals it, never the follow engine's own writes, so a streaming reply does not keep it lit.
 * Position and visibility are written straight to the DOM: no re-render per scroll event.
 */
export function TranscriptScrollbar({ scrollRef, onPress }: TranscriptScrollbarProps) {
  const railRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = scrollRef.current
    const rail = railRef.current
    const thumb = thumbRef.current
    const host = rail?.parentElement
    if (!scroller || !rail || !thumb || !host) return

    let overflowing = false
    let hovering = false
    let drag: { pointerId: number; startY: number; startScrollTop: number } | null = null
    let hideTimer: ReturnType<typeof setTimeout> | undefined

    const setVisible = (visible: boolean) => rail.toggleAttribute('data-visible', visible)
    const hideIfIdle = () => {
      if (!hovering && !drag) setVisible(false)
    }
    const reveal = () => {
      if (!overflowing) return
      setVisible(true)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(hideIfIdle, HIDE_AFTER_MS)
    }

    const layout = () => {
      const range = scroller.scrollHeight - scroller.clientHeight
      overflowing = range > 1
      if (!overflowing) {
        setVisible(false)
        return
      }
      const track = rail.clientHeight
      const height = Math.min(track, Math.max(MIN_THUMB_PX, Math.round((track * scroller.clientHeight) / scroller.scrollHeight)))
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / range))
      thumb.style.height = `${height}px`
      thumb.style.transform = `translateY(${Math.round((track - height) * progress)}px)`
    }

    const onHostPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      if (event.clientX >= rail.getBoundingClientRect().left - EDGE_REVEAL_PX) reveal()
    }
    const onThumbEnter = () => {
      hovering = true
      reveal()
    }
    const onThumbLeave = () => {
      hovering = false
      reveal()
    }
    const onThumbDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      thumb.setPointerCapture(event.pointerId)
      drag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: scroller.scrollTop }
      rail.toggleAttribute('data-dragging', true)
      onPress()
      reveal()
    }
    const onThumbMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const travel = rail.clientHeight - thumb.offsetHeight
      if (travel <= 0) return
      const range = scroller.scrollHeight - scroller.clientHeight
      scroller.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) * range) / travel
    }
    const onThumbUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      drag = null
      rail.toggleAttribute('data-dragging', false)
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId)
      reveal()
    }

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layout)
    resizeObserver?.observe(scroller)
    resizeObserver?.observe(rail)
    if (scroller.firstElementChild) resizeObserver?.observe(scroller.firstElementChild)
    layout()

    scroller.addEventListener('scroll', layout, { passive: true })
    scroller.addEventListener('wheel', reveal, { passive: true })
    scroller.addEventListener('touchmove', reveal, { passive: true })
    scroller.addEventListener('keydown', reveal)
    host.addEventListener('pointermove', onHostPointerMove)
    thumb.addEventListener('pointerenter', onThumbEnter)
    thumb.addEventListener('pointerleave', onThumbLeave)
    thumb.addEventListener('pointerdown', onThumbDown)
    thumb.addEventListener('pointermove', onThumbMove)
    thumb.addEventListener('pointerup', onThumbUp)
    thumb.addEventListener('pointercancel', onThumbUp)
    return () => {
      clearTimeout(hideTimer)
      resizeObserver?.disconnect()
      scroller.removeEventListener('scroll', layout)
      scroller.removeEventListener('wheel', reveal)
      scroller.removeEventListener('touchmove', reveal)
      scroller.removeEventListener('keydown', reveal)
      host.removeEventListener('pointermove', onHostPointerMove)
      thumb.removeEventListener('pointerenter', onThumbEnter)
      thumb.removeEventListener('pointerleave', onThumbLeave)
      thumb.removeEventListener('pointerdown', onThumbDown)
      thumb.removeEventListener('pointermove', onThumbMove)
      thumb.removeEventListener('pointerup', onThumbUp)
      thumb.removeEventListener('pointercancel', onThumbUp)
    }
  }, [scrollRef, onPress])

  return (
    <div ref={railRef} className="transcript-scroll-rail" aria-hidden="true" data-testid="transcript-scroll-rail">
      <div ref={thumbRef} className="transcript-scroll-thumb" />
    </div>
  )
}
