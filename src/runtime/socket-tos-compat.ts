import { Socket } from "node:net"
import process from "node:process"

let installed = false

/** Node 24 on macOS can throw while Undici retries a disconnected local MCP socket. */
export function installMacosDefaultTosGuard(): void {
  if (installed || process.platform !== "darwin") return

  const setTypeOfService: unknown = Reflect.get(Socket.prototype, "setTypeOfService")
  if (typeof setTypeOfService !== "function") return
  const nativeSetTypeOfService = setTypeOfService

  function guarded(this: Socket, value: number): void {
    try {
      Reflect.apply(nativeSetTypeOfService, this, [value])
    } catch (error) {
      if (
        value === 0 &&
        this.remoteAddress === undefined &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EINVAL" &&
        "syscall" in error &&
        error.syscall === "setTypeOfService"
      ) {
        return
      }
      throw error
    }
  }
  if (!Reflect.set(Socket.prototype, "setTypeOfService", guarded)) {
    throw new Error("Cannot install the macOS socket TOS compatibility guard.")
  }
  installed = true
}
