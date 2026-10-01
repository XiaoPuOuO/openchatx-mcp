import assert from "node:assert/strict"
import test from "node:test"

import { migrateOperationalState } from "../src/recovery/operational-state.js"
import { redactSecrets, redactText } from "../src/security/redact.js"
import { buildMacOSUpdaterScript } from "../src/update/macos-installer.js"

test("operational state migrates legacy unversioned state and applies defaults", () => {
  const state = migrateOperationalState({ onboardingCompleted: true })
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.onboardingCompleted, true)
  assert.equal(state.update.channel, "beta")
  assert.equal(state.safeMode.enabled, false)
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
