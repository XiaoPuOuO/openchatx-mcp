import { CheckCircle2 } from "lucide-react"
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import {
  dismissToast,
  EMPTY_TOAST_QUEUE,
  enqueueToast,
  type ToastQueueItem,
} from "../lib/toast-queue"

const AUTO_DISMISS_MS = 3000
const EXIT_ANIMATION_MS = 180
const SWIPE_DISMISS_DISTANCE = 96
const SWIPE_DISMISS_VELOCITY = 0.65

export function useNotificationToasts() {
  const [state, setState] = useState(EMPTY_TOAST_QUEUE)
  const nextId = useRef(1)

  const pushToast = useCallback((message: string) => {
    const toast = { id: nextId.current++, message }
    setState((current) => enqueueToast(current, toast))
    return toast.id
  }, [])

  const dismiss = useCallback((id: number) => {
    setState((current) => dismissToast(current, id))
  }, [])

  return {
    toasts: state.visible,
    pushToast,
    dismissToast: dismiss,
  }
}

export function NotificationToastStack({
  toasts,
  title,
  onDismiss,
}: {
  toasts: ToastQueueItem[]
  title: string
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed right-5 top-16 z-50 flex flex-col items-end gap-2"
      aria-live="polite"
      aria-relevant="additions removals"
    >
      {toasts.map((toast) => (
        <NotificationToast key={toast.id} toast={toast} title={title} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function NotificationToast({
  toast,
  title,
  onDismiss,
}: {
  toast: ToastQueueItem
  title: string
  onDismiss: (id: number) => void
}) {
  const [entered, setEntered] = useState(false)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exiting, setExiting] = useState(false)
  const dragDistance = useRef(0)
  const dragStart = useRef<{ x: number; time: number } | null>(null)
  const dismissTimer = useRef<number | null>(null)
  const exitTimer = useRef<number | null>(null)
  const dismissing = useRef(false)

  const finishDismiss = useCallback(() => {
    if (dismissing.current) return
    dismissing.current = true
    setDragging(false)
    setExiting(true)
    exitTimer.current = window.setTimeout(() => onDismiss(toast.id), EXIT_ANIMATION_MS)
  }, [onDismiss, toast.id])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true))
    dismissTimer.current = window.setTimeout(finishDismiss, AUTO_DISMISS_MS)

    return () => {
      window.cancelAnimationFrame(frame)
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current)
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
    }
  }, [finishDismiss])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (exiting) return
    dragStart.current = { x: event.clientX, time: performance.now() }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !dragging || exiting) return
    const distance = Math.max(0, event.clientX - dragStart.current.x)
    dragDistance.current = distance
    setDragX(distance)
  }

  const finishPointerGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const start = dragStart.current
    dragStart.current = null
    setDragging(false)

    if (!start || exiting) return

    const distance = dragDistance.current
    const elapsed = Math.max(performance.now() - start.time, 1)
    const velocity = distance / elapsed
    const shouldDismiss =
      !cancelled && (distance >= SWIPE_DISMISS_DISTANCE || velocity >= SWIPE_DISMISS_VELOCITY)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (shouldDismiss) {
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current)
      finishDismiss()
      return
    }

    dragDistance.current = 0
    setDragX(0)
  }

  const translateX = exiting ? "calc(100% + 32px)" : `${entered ? dragX : 24}px`
  const opacity = exiting || !entered ? 0 : Math.max(0.35, 1 - dragX / 360)

  return (
    <div
      className="pointer-events-auto flex w-[min(360px,calc(100vw-2.5rem))] select-none items-center gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur will-change-transform"
      style={{
        opacity,
        transform: `translateX(${translateX})`,
        transition: dragging
          ? "none"
          : `transform ${EXIT_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${EXIT_ANIMATION_MS}ms ease`,
        touchAction: "pan-y",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointerGesture(event)}
      onPointerCancel={(event) => finishPointerGesture(event, true)}
      role="status"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
        <CheckCircle2 className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{toast.message}</div>
      </div>
    </div>
  )
}
