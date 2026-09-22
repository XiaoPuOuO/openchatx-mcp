export interface UpdateSignal {
  readonly version: number
  notify(): void
  wait(version: number, waitMs: number, signal?: AbortSignal): Promise<void>
}

export function createUpdateSignal(): UpdateSignal {
  let version = 0
  const waiters = new Set<() => void>()

  function notify(): void {
    version += 1
    const pending = [...waiters]
    waiters.clear()
    for (const resolve of pending) resolve()
  }

  async function wait(
    observedVersion: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (waitMs === 0 || version !== observedVersion || signal?.aborted) return

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      waiters.add(done)
      signal?.addEventListener("abort", done, { once: true })
      if (version !== observedVersion || signal?.aborted) done()
    })
  }

  return {
    get version() {
      return version
    },
    notify,
    wait,
  }
}
