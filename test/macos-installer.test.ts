import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import {
  buildMacOSUpdaterScript,
  isTrustedMacOSUpdateAsset,
} from "../src/update/macos-installer.js"

test("macOS updater only accepts official OpenChatX app archives", () => {
  assert.equal(
    isTrustedMacOSUpdateAsset(
      "OpenChatX-macos-arm64.app.zip",
      "https://github.com/XiaoPuOuO/openchatx-mcp/releases/download/v1.2.3/OpenChatX-macos-arm64.app.zip"
    ),
    true
  )
  assert.equal(
    isTrustedMacOSUpdateAsset(
      "OpenChatX-macos-arm64.dmg",
      "https://github.com/XiaoPuOuO/openchatx-mcp/releases/download/v1.2.3/OpenChatX-macos-arm64.dmg"
    ),
    false
  )
  assert.equal(
    isTrustedMacOSUpdateAsset(
      "OpenChatX-macos-arm64.app.zip",
      "https://example.test/OpenChatX-macos-arm64.app.zip"
    ),
    false
  )
})

test("macOS updater verifies, swaps, rolls back, and relaunches only the app bundle", () => {
  const script = buildMacOSUpdaterScript()
  assert.match(script, /ditto -x -k/u)
  assert.match(script, /CFBundleIdentifier/u)
  assert.match(script, /com\.openchatx\.desktop/u)
  assert.match(script, /codesign --verify --deep --strict/u)
  assert.match(script, /spctl --assess --type execute/u)
  assert.match(script, /\/bin\/test -d "\$NEW_APP"/u)
  assert.doesNotMatch(script, /\/usr\/bin\/test/u)
  assert.doesNotMatch(script, /\bstatus=\$\?/u)
  assert.match(script, /backup-/u)
  assert.match(script, /mv "\$BACKUP_APP" "\$TARGET_APP"/u)
  assert.match(script, /open "\$TARGET_APP"/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_PATH/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_BACKUP/u)
  assert.match(script, /restore_state/u)
  assert.match(script, /cp -f "\$STATE_BACKUP" "\$STATE_PATH"/u)
  assert.doesNotMatch(script, /Application Support/u)
  assert.doesNotMatch(script, /Keychain/u)
})

test("macOS updater records a failed installation without touching a live app", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "openchatx-updater-regression-"))
  try {
    const work = join(directory, "work")
    const script = join(directory, "install.zsh")
    const statePath = join(directory, "state.json")
    const zip = join(directory, "bad-archive.zip")
    mkdirSync(work)
    writeFileSync(zip, "not a zip")
    writeFileSync(script, buildMacOSUpdaterScript())
    writeFileSync(
      statePath,
      JSON.stringify({ update: { phase: "installing", progress: 75, pendingHealthCheck: "1.1.2" } })
    )
    const result = spawnSync("/bin/zsh", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCHATX_UPDATE_ZIP: zip,
        OPENCHATX_TARGET_APP: join(directory, "OpenChatX.app"),
        OPENCHATX_TARGET_PID: "99999999",
        OPENCHATX_UPDATE_WORK_DIR: work,
        OPENCHATX_UPDATE_HEALTH_URL: "http://127.0.0.1:1/healthz",
        OPENCHATX_OPERATIONAL_STATE_PATH: statePath,
        OPENCHATX_RUNTIME_NODE: process.execPath,
        OPENCHATX_OPERATIONAL_STATE_BACKUP: join(work, "state.backup.json"),
        OPENCHATX_OPERATIONAL_STATE_EXISTED: "1",
      },
    })
    assert.notEqual(result.status, 0)
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    assert.equal(state.update.phase, "failed")
    assert.equal(state.update.progress, 100)
    assert.equal(state.update.pendingHealthCheck, undefined)
    const log = readFileSync(join(work, "install.log"), "utf8")
    assert.match(log, /OpenChatX update failed/u)
    assert.doesNotMatch(log, /read-only variable: status/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
