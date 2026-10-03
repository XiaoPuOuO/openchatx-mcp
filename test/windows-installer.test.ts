import assert from "node:assert/strict"
import test from "node:test"

import { buildWindowsUpdaterScript } from "../src/update/windows-installer.js"

test("Windows updater health-checks the new app and rolls back install plus operational state", () => {
  const script = buildWindowsUpdaterScript()

  assert.match(script, /OPENCHATX_UPDATE_BACKUP_DIR/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_PATH/u)
  assert.match(script, /OPENCHATX_OPERATIONAL_STATE_BACKUP/u)
  assert.match(script, /function Restore-PreviousVersion/u)
  assert.match(script, /Copy-Item -Path \(Join-Path \$BackupDir "\*"\)/u)
  assert.match(script, /Copy-Item -LiteralPath \$StateBackup -Destination \$StatePath -Force/u)
  assert.match(script, /Invoke-WebRequest -UseBasicParsing -Uri \$HealthUrl/u)
  assert.match(script, /Start-Process -FilePath \$TargetExe/u)
  assert.match(script, /Restore-PreviousVersion/u)
})
