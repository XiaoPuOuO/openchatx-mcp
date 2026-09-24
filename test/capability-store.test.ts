import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { CapabilityStoreService } from "../src/store/store-service.js"

test("Capability Store installs and removes bundled toolboxes with ownership state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-store-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundles = join(root, "bundles")
  const toolboxRoot = join(root, "toolboxes")
  await mkdir(join(bundles, "demo"), { recursive: true })
  await writeFile(join(bundles, "demo", "toolbox.json"), '{"name":"Demo"}\n')
  const catalog = join(root, "catalog.json")
  await writeFile(
    catalog,
    JSON.stringify({
      entries: [
        {
          id: "demo",
          name: "Demo",
          description: "Demo capability",
          kind: "toolbox",
          bundle: "demo",
          tags: ["demo"],
        },
      ],
    })
  )

  const store = new CapabilityStoreService(catalog, bundles, toolboxRoot, undefined, root)
  assert.equal((await store.list())[0]?.installed, false)
  const installed = await store.install("demo")
  assert.equal(installed.installed, true)
  assert.match(await readFile(join(toolboxRoot, "demo", "toolbox.json"), "utf8"), /Demo/u)
  await assert.rejects(() => store.install("demo"), /already installed/u)
  await store.uninstall("demo")
  assert.equal((await store.list())[0]?.installed, false)
})
