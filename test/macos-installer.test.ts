import assert from "node:assert/strict"
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
  assert.match(script, /backup-/u)
  assert.match(script, /mv "\$BACKUP_APP" "\$TARGET_APP"/u)
  assert.match(script, /open "\$TARGET_APP"/u)
  assert.doesNotMatch(script, /Application Support/u)
  assert.doesNotMatch(script, /Keychain/u)
})
