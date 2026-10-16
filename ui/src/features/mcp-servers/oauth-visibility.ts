import type { McpServerConfig, McpServerSnapshot } from "../../types.js"

type OAuthState = NonNullable<McpServerSnapshot["authorization"]>[string]

/**
 * Auto supports OAuth, but must not display OAuth controls before the
 * server actually requires it. Keep controls accessible after login.
 */
export function shouldShowMcpOAuthControls(server: McpServerConfig, oauth?: OAuthState): boolean {
  if (server.type !== "remote" || !server.enabled) return false
  if (server.auth === "none" || server.auth === "headers") return false
  if (
    server.auth !== "oauth" &&
    Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
  )
    return false

  return (
    server.auth === "oauth" ||
    oauth?.oauthDetected === true ||
    oauth?.status === "auth_required" ||
    oauth?.status === "authorizing" ||
    oauth?.status === "error"
  )
}
