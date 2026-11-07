import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { installDesktopBundle } from "../scripts/desktop-install.js"
import { tempDir } from "./helpers/temp.js"

test("desktop install stages the new bundle and preserves the old one", async (t) => {
  const root = await tempDir(t, "openchatx-desktop-install-")
  const source = join(root, "new.app")
  const destination = join(root, "OpenChatX.app")
  await mkdir(source)
  await mkdir(destination)
  await writeFile(join(source, "version"), "new")
  await writeFile(join(destination, "version"), "old")
  const backup = await installDesktopBundle(source, destination)
  assert.ok(backup)
  assert.equal(await readFile(join(destination, "version"), "utf8"), "new")
  assert.equal(await readFile(join(backup, "version"), "utf8"), "old")
})
