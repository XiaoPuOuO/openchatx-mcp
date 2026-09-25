import assert from "node:assert/strict"
import test from "node:test"

import {
  dismissToast,
  EMPTY_TOAST_QUEUE,
  enqueueToast,
  type ToastQueueState,
} from "../ui/src/lib/toast-queue.js"

test("toast queue shows at most three notifications", () => {
  let state: ToastQueueState = EMPTY_TOAST_QUEUE

  for (let id = 1; id <= 5; id += 1) {
    state = enqueueToast(state, { id, message: `toast-${id}` })
  }

  assert.deepEqual(
    state.visible.map((toast) => toast.id),
    [1, 2, 3]
  )
  assert.deepEqual(
    state.queued.map((toast) => toast.id),
    [4, 5]
  )
})

test("toast queue promotes queued notifications in FIFO order", () => {
  let state: ToastQueueState = EMPTY_TOAST_QUEUE

  for (let id = 1; id <= 5; id += 1) {
    state = enqueueToast(state, { id, message: `toast-${id}` })
  }

  state = dismissToast(state, 2)
  assert.deepEqual(
    state.visible.map((toast) => toast.id),
    [1, 3, 4]
  )
  assert.deepEqual(
    state.queued.map((toast) => toast.id),
    [5]
  )

  state = dismissToast(state, 1)
  assert.deepEqual(
    state.visible.map((toast) => toast.id),
    [3, 4, 5]
  )
  assert.deepEqual(state.queued, [])
})
