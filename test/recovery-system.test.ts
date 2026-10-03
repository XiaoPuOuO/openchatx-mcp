import assert from "node:assert/strict"
import test from "node:test"

import { migrateOperationalState } from "../src/recovery/operational-state.js"
import { redactSecrets, redactText } from "../src/security/redact.js"
import { buildMacOSUpdaterScript } from "../src/update/macos-installer.js"

test("operational state migrates legacy unversioned state to low-risk defaults", () => {
  const state = migrateOperationalState({ onboardingCompleted: true })
  assert.equal(state.schemaVersion, 4)
  assert.equal(state.onboardingCompleted, true)
  assert.equal(state.update.channel, "beta")
  assert.equal(state.safeMode.enabled, false)
  assert.equal(state.accessMode, "allow-low-risk")
  assert.equal(state.agentAccess.paused, false)
  assert.equal(state.notifications.enabled, true)
  assert.equal(state.notifications.approvalRequired, true)
})

test("operational state preserves legacy full access trust mode during migration", () => {
  const state = migrateOperationalState({
    schemaVersion: 2,
    trustMode: { enabled: true, enabledAt: "2026-10-03T00:00:00.000Z" },
  })
  assert.equal(state.schemaVersion, 4)
  assert.equal(state.accessMode, "full-access")
})

test("operational state migrates disabled legacy trust mode to low-risk", () => {
  const state = migrateOperationalState({
    schemaVersion: 2,
    trustMode: { enabled: false },
  })
  assert.equal(state.accessMode, "allow-low-risk")
})

test("operational state preserves v3 access mode while adding tool-risk defaults", () => {
  const state = migrateOperationalState({
    schemaVersion: 3,
    accessMode: "full-access",
    dangerousActions: {},
    capabilityPermissions: {},
  })
  assert.equal(state.schemaVersion, 4)
  assert.equal(state.accessMode, "full-access")
  assert.deepEqual(state.toolRiskOverrides, {})
})

test("operational state rejects a newer unsupported schema", () => {
  assert.throws(() => migrateOperationalState({ schemaVersion: 99 }), /newer than supported/u)
})

test("diagnostic redaction removes structured and text secrets", () => {
  const redacted = redactSecrets({
    api_key: "sk-secret-value-123456789",
    nested: { authorization: "Bearer abc.def.ghi", normal: "keep" },
  })
  assert.deepEqual(redacted, {
    api_key: "[REDACTED]",
    nested: { authorization: "[REDACTED]", normal: "keep" },
  })
  assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [REDACTED]")
})

test("macOS updater keeps the old app until post-update health succeeds and rolls back on failure", () => {
  const script = buildMacOSUpdaterScript()
  assert.match(script, /OPENCHATX_UPDATE_HEALTH_URL/u)
  assert.match(script, /curl -fsS --max-time 1/u)
  assert.match(script, /new app did not become healthy/iu)
  assert.match(script, /mv "\$BACKUP_APP" "\$TARGET_APP"/u)
  assert.match(script, /open "\$TARGET_APP"/u)
})
