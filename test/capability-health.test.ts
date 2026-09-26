import assert from "node:assert/strict"
import test from "node:test"

import {
  CapabilityHealthService,
  isTunnelOperational,
  tunnelHealthStatus,
} from "../src/capabilities/health.js"

test("capability health reports runtime even without optional services", async () => {
  const health = new CapabilityHealthService()
  const snapshot = await health.snapshot()
  assert.ok(snapshot.components.some((component) => component.id === "openchatx"))
  assert.ok(snapshot.components.some((component) => component.id === "tunnel"))
  assert.ok(["healthy", "degraded"].includes(snapshot.status))
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
