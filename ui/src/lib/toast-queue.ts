export const MAX_VISIBLE_TOASTS = 3

export type ToastQueueItem = {
  id: number
  message: string
}

export type ToastQueueState = {
  visible: ToastQueueItem[]
  queued: ToastQueueItem[]
}

export const EMPTY_TOAST_QUEUE: ToastQueueState = {
  visible: [],
  queued: [],
}

export function enqueueToast(
  state: ToastQueueState,
  toast: ToastQueueItem,
  maxVisible = MAX_VISIBLE_TOASTS
): ToastQueueState {
  if (state.visible.length < maxVisible) {
    return {
      visible: [...state.visible, toast],
      queued: state.queued,
    }
  }

  return {
    visible: state.visible,
    queued: [...state.queued, toast],
  }
}

export function dismissToast(
  state: ToastQueueState,
  id: number,
  maxVisible = MAX_VISIBLE_TOASTS
): ToastQueueState {
  const visible = state.visible.filter((toast) => toast.id !== id)
  if (visible.length === state.visible.length) {
    return state
  }

  const nextVisible = [...visible]
  const queued = [...state.queued]

  while (nextVisible.length < maxVisible && queued.length > 0) {
    const next = queued.shift()
    if (next) nextVisible.push(next)
  }

  return {
    visible: nextVisible,
    queued,
  }
}
