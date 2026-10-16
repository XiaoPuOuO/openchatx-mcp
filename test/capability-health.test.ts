import assert from "node:assert/strict"
import test from "node:test"

import {
  CapabilityHealthService,
  isTunnelOperational,
  tunnelHealthStatus,
  tunnelMcpObservation,
} from "../src/capabilities/health.js"

test("capability health reports runtime even without optional services", async () => {
  const health = new CapabilityHealthService()
  const snapshot = await health.snapshot()
  assert.ok(snapshot.components.some((component) => component.id === "openchatx"))
  assert.ok(snapshot.components.some((component) => component.id === "tunnel"))
  assert.ok(["healthy", "degraded"].includes(snapshot.status))
})

test("MCP health distinguishes available, sign-in required, authorizing, and unavailable", async () => {
  const health = new CapabilityHealthService({
    capabilities: () => [
      { id: "ready", name: "Ready", available: true, toolCount: 2 },
      { id: "login", name: "Login", available: true, toolCount: 1 },
      { id: "retry", name: "Retry", available: false, toolCount: 0 },
      { id: "pending", name: "Pending", available: false, toolCount: 0 },
      { id: "offline", name: "Offline", available: false, toolCount: 0 },
    ],
    authorization: () => ({
      ready: { status: "none" },
      login: { status: "auth_required" },
      retry: { status: "error" },
      pending: { status: "authorizing" },
      offline: { status: "none" },
    }),
  } as never)

  const components = (await health.snapshot()).components
  const mcp = Object.fromEntries(
    components.filter((item) => item.kind === "mcp").map((item) => [item.id, item])
  )
  assert.equal(mcp["mcp:ready"]?.status, "healthy")
  assert.equal(mcp["mcp:login"]?.status, "auth_required")
  assert.equal(mcp["mcp:login"]?.detail, "Authentication required")
  assert.equal(mcp["mcp:retry"]?.status, "auth_required")
  assert.equal(mcp["mcp:retry"]?.detail, "Authorization failed. Retry connection.")
  assert.equal(mcp["mcp:pending"]?.status, "starting")
  assert.equal(mcp["mcp:offline"]?.status, "unavailable")
})

test("tunnel health treats a connected control plane as operational even when readyz is degraded", () => {
  assert.equal(
    isTunnelOperational({
      live: true,
      ready: false,
      components: {
        "control-plane": { status: "ok", state: "polling" },
        oauth: { status: "degraded", reason_code: "discovery_failed" },
        mcp: { status: "unknown", state: "not_observed" },
      },
    }),
    true
  )
})

test("tunnel health distinguishes observed and unobserved MCP sub-probes", () => {
  assert.equal(
    tunnelMcpObservation({
      components: { mcp: { status: "unknown", state: "not_observed" } },
    }),
    "unobserved"
  )
  assert.equal(
    tunnelMcpObservation({
      components: { mcp: { status: "ok", state: "healthy" } },
    }),
    "observed"
  )
  assert.equal(tunnelMcpObservation({ components: {} }), "unobserved")
})

test("tunnel health rejects a live daemon without a connected control plane", () => {
  assert.equal(
    isTunnelOperational({
      live: true,
      components: {
        "control-plane": { status: "degraded", state: "failed" },
      },
    }),
    false
  )
})

test("tunnel startup grace reports starting instead of a false unavailable alert", () => {
  assert.equal(tunnelHealthStatus(false, true), "starting")
  assert.equal(tunnelHealthStatus(false, false), "unavailable")
  assert.equal(tunnelHealthStatus(true, true), "healthy")
})
