interface SwitchOptions {
  root(): string
  config(): string
  setRoot(path: string): Promise<void>
  setConfig(path: string): Promise<void>
  publishConfig(path: string): void
  userRoot: string
  safeRoot: string
  userConfig: string
  safeConfig: string
}

export function createSafeModeSwitcher(
  options: SwitchOptions
): (enabled: boolean) => Promise<void> {
  let queue = Promise.resolve()
  return (enabled) => {
    const operation = queue.then(async () => {
      const oldRoot = options.root()
      const oldConfig = options.config()
      const root = enabled ? options.safeRoot : options.userRoot
      const config = enabled ? options.safeConfig : options.userConfig
      try {
        await options.setRoot(root)
        await options.setConfig(config)
        options.publishConfig(config)
      } catch (error) {
        const results = await Promise.allSettled([
          options.setRoot(oldRoot),
          options.setConfig(oldConfig),
        ])
        options.publishConfig(oldConfig)
        const failures = results.filter((result) => result.status === "rejected")
        if (failures.length) {
          // biome-ignore lint/style/useErrorCause: AggregateError receives the cause in its third argument.
          throw new AggregateError(
            [error, ...failures.map((result) => result.reason)],
            "Safe Mode switch and rollback failed",
            { cause: error }
          )
        }
        throw error
      }
    })
    queue = operation.catch(() => undefined)
    return operation
  }
}
