import assert from "node:assert/strict"
import test from "node:test"

import { CapabilityHealthService } from "../src/capabilities/health.js"

test("capability health reports runtime even without optional services", async () => {
  const health = new CapabilityHealthService()
  const snapshot = await health.snapshot()
  assert.ok(snapshot.components.some((component) => component.id === "openchatx"))
  assert.ok(snapshot.components.some((component) => component.id === "tunnel"))
  assert.ok(["healthy", "degraded"].includes(snapshot.status))
})
