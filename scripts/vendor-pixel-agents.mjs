#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const PIXEL_AGENTS_REPOSITORY = "https://github.com/pablodelucca/pixel-agents.git"
const PIXEL_AGENTS_COMMIT = "3537e140c2094761beae748592aeb92ece8edfdd"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const vendorRoot = path.join(repoRoot, "ui", "public", "pixel-agents")
const assetsTarget = path.join(vendorRoot, "assets")
const catalogTarget = path.join(vendorRoot, "catalog.json")

const args = process.argv.slice(2)
const checkOnly = args.includes("--check")
const sourceArgIndex = args.indexOf("--source")
const sourceOverride = sourceArgIndex >= 0 ? args[sourceArgIndex + 1] : undefined

if (checkOnly) {
  await checkVendorSnapshot()
  process.exit(0)
}

let tempDir
try {
  const sourceRoot = sourceOverride ? path.resolve(sourceOverride) : await fetchPinnedSource()
  if (!sourceOverride) tempDir = path.dirname(sourceRoot)

  const sourceAssets = path.join(sourceRoot, "webview-ui", "public", "assets")
  await assertDirectory(sourceAssets)

  const catalog = await buildCatalog(sourceAssets)
  const license = await readFile(path.join(sourceRoot, "LICENSE"), "utf8")

  await mkdir(vendorRoot, { recursive: true })
  await rm(assetsTarget, { recursive: true, force: true })
  await cp(sourceAssets, assetsTarget, { recursive: true })

  // Remove the pre-catalog legacy subset so there is only one source of truth.
  for (const legacyDir of ["characters", "floors", "furniture", "walls", "carpets", "pets"]) {
    await rm(path.join(vendorRoot, legacyDir), { recursive: true, force: true })
  }

  await writeFile(path.join(vendorRoot, "UPSTREAM_COMMIT"), `${PIXEL_AGENTS_COMMIT}\n`)
  await writeFile(path.join(vendorRoot, "UPSTREAM_REPOSITORY"), `${PIXEL_AGENTS_REPOSITORY}\n`)
  await writeFile(path.join(vendorRoot, "LICENSE"), license)
  await writeFile(catalogTarget, `${JSON.stringify(catalog, null, 2)}\n`)

  console.log(`Vendored Pixel Agents ${PIXEL_AGENTS_COMMIT}`)
  console.log(`Furniture variants: ${catalog.furniture.length}`)
  console.log(`PNG assets: ${catalog.images.length}`)
} finally {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
}

async function fetchPinnedSource() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "shellby-pixel-agents-"))
  const source = path.join(temp, "pixel-agents")
  await mkdir(source)
  execFileSync("git", ["init", "-q"], { cwd: source })
  execFileSync("git", ["remote", "add", "origin", PIXEL_AGENTS_REPOSITORY], { cwd: source })
  execFileSync("git", ["fetch", "-q", "--depth", "1", "origin", PIXEL_AGENTS_COMMIT], {
    cwd: source,
  })
  execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: source })
  return source
}

async function buildCatalog(sourceAssets) {
  const furnitureRoot = path.join(sourceAssets, "furniture")
  const furniture = []

  for (const directory of (await readdir(furnitureRoot)).sort()) {
    const manifestPath = path.join(furnitureRoot, directory, "manifest.json")
    if (!(await exists(manifestPath))) continue
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const directoryPath = path.join(furnitureRoot, directory)
    const variants = await flattenFurnitureManifest(manifest, directoryPath, directory)
    furniture.push(...variants)
  }

  const pngFiles = await walkFiles(sourceAssets, (file) => file.endsWith(".png"))
  const images = pngFiles
    .map((file) => {
      const relative = slash(path.relative(sourceAssets, file))
      return {
        kind: relative.split("/")[0],
        path: `/ui/pixel-agents/assets/${relative}`,
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))

  const floors = images
    .filter((image) => image.kind === "floors")
    .map((image, index) => ({
      id: `floor_${index}`,
      label: `Floor ${index + 1}`,
      path: image.path,
    }))
  const walls = images
    .filter((image) => image.kind === "walls")
    .map((image, index) => ({ id: `wall_${index}`, label: `Wall ${index + 1}`, path: image.path }))
  const carpets = images
    .filter((image) => image.kind === "carpets")
    .map((image, index) => ({
      id: `carpet_${index}`,
      label: `Carpet ${index + 1}`,
      path: image.path,
    }))
  const characters = images
    .filter((image) => image.kind === "characters")
    .map((image, index) => ({
      id: `char_${index}`,
      label: `Character ${index + 1}`,
      path: image.path,
    }))
  const pets = []
  const petsRoot = path.join(sourceAssets, "pets")
  if (await exists(petsRoot)) {
    for (const directory of (await readdir(petsRoot)).sort()) {
      const manifestPath = path.join(petsRoot, directory, "manifest.json")
      const imagePath = path.join(petsRoot, directory, "pet.png")
      if (!(await exists(manifestPath)) || !(await exists(imagePath))) continue
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
      pets.push({
        id: manifest.id ?? directory,
        label: manifest.name ?? manifest.id ?? directory,
        path: `/ui/pixel-agents/assets/pets/${directory}/pet.png`,
      })
    }
  }

  return {
    version: 2,
    upstream: {
      repository: PIXEL_AGENTS_REPOSITORY,
      commit: PIXEL_AGENTS_COMMIT,
    },
    furniture: furniture.sort((left, right) =>
      `${left.category}:${left.label}:${left.id}`.localeCompare(
        `${right.category}:${right.label}:${right.id}`
      )
    ),
    floors,
    walls,
    carpets,
    characters,
    pets,
    images,
  }
}

async function flattenFurnitureManifest(manifest, directoryPath, directory) {
  const base = {
    category: manifest.category ?? "misc",
    canPlaceOnWalls: Boolean(manifest.canPlaceOnWalls),
    canPlaceOnSurfaces: Boolean(manifest.canPlaceOnSurfaces),
    backgroundTiles: manifest.backgroundTiles ?? 0,
    baseName: manifest.name ?? manifest.id ?? directory,
  }

  if (manifest.type === "asset") {
    const file = await inferAssetFile(directoryPath, manifest.id)
    return [catalogFurnitureEntry(manifest, base, directory, file, {})]
  }

  return flattenMembers(manifest.members ?? [], base, directory, {})
}

function flattenMembers(members, base, directory, inherited) {
  const output = []
  for (const member of members) {
    const context = {
      orientation: member.orientation ?? inherited.orientation,
      state: member.state ?? inherited.state,
      mirrorSide: member.mirrorSide ?? inherited.mirrorSide,
    }

    if (member.type === "asset") {
      // Animation groups contain every frame. One representative frame is enough
      // for room placement; the complete frame set remains present in catalog.images.
      if (member.frame !== undefined && member.frame !== 0) continue
      output.push(catalogFurnitureEntry(member, base, directory, member.file, context))
      continue
    }

    output.push(...flattenMembers(member.members ?? [], base, directory, context))
  }
  return output
}

function catalogFurnitureEntry(asset, base, directory, file, context) {
  const orientation = asset.orientation ?? context.orientation
  const state = asset.state ?? context.state
  const mirrorSide = asset.mirrorSide ?? context.mirrorSide ?? false
  const suffix = [orientation && titleCase(orientation), state && titleCase(state)]
    .filter(Boolean)
    .join(" · ")
  return {
    id: asset.id,
    label: suffix ? `${base.baseName} · ${suffix}` : base.baseName,
    category: base.category,
    path: `/ui/pixel-agents/assets/furniture/${directory}/${file}`,
    width: asset.width,
    height: asset.height,
    footprintW: asset.footprintW,
    footprintH: asset.footprintH,
    orientation: orientation ?? null,
    state: state ?? null,
    mirrorSide: Boolean(mirrorSide),
    canPlaceOnWalls: base.canPlaceOnWalls,
    canPlaceOnSurfaces: base.canPlaceOnSurfaces,
    backgroundTiles: base.backgroundTiles,
  }
}

async function inferAssetFile(directoryPath, id) {
  const expected = `${id}.png`
  if (await exists(path.join(directoryPath, expected))) return expected
  const pngs = (await readdir(directoryPath)).filter((file) => file.endsWith(".png")).sort()
  if (pngs.length !== 1) throw new Error(`Could not infer PNG for ${directoryPath}`)
  return pngs[0]
}

async function checkVendorSnapshot() {
  const commit = (await readFile(path.join(vendorRoot, "UPSTREAM_COMMIT"), "utf8")).trim()
  if (commit !== PIXEL_AGENTS_COMMIT)
    throw new Error(`Vendored commit is ${commit}; expected ${PIXEL_AGENTS_COMMIT}`)

  const catalog = JSON.parse(await readFile(catalogTarget, "utf8"))
  if (catalog.upstream?.commit !== PIXEL_AGENTS_COMMIT)
    throw new Error("catalog.json commit does not match pinned commit")
  if (!Array.isArray(catalog.furniture) || catalog.furniture.length === 0)
    throw new Error("catalog.json has no furniture entries")
  for (const key of ["floors", "walls", "carpets", "characters", "pets"]) {
    if (!Array.isArray(catalog[key]) || catalog[key].length === 0)
      throw new Error(`catalog.json has no ${key} entries`)
  }
  if (!Array.isArray(catalog.images) || catalog.images.length === 0)
    throw new Error("catalog.json has no image entries")

  for (const entry of [
    ...catalog.furniture,
    ...catalog.floors,
    ...catalog.walls,
    ...catalog.carpets,
    ...catalog.characters,
    ...catalog.pets,
    ...catalog.images,
  ]) {
    const prefix = "/ui/pixel-agents/assets/"
    if (!entry.path.startsWith(prefix)) throw new Error(`Unexpected catalog path: ${entry.path}`)
    const relative = entry.path.slice(prefix.length)
    if (!(await exists(path.join(assetsTarget, relative))))
      throw new Error(`Missing vendored asset: ${relative}`)
  }

  console.log(`Pixel Agents vendor snapshot OK: ${commit}`)
  console.log(
    `Furniture variants: ${catalog.furniture.length}; PNG assets: ${catalog.images.length}`
  )
}

async function walkFiles(root, predicate) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(target, predicate)))
    else if (predicate(target)) files.push(target)
  }
  return files
}

async function assertDirectory(target) {
  const info = await stat(target).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`Expected directory: ${target}`)
}

async function exists(target) {
  return Boolean(await stat(target).catch(() => undefined))
}

function slash(value) {
  return value.split(path.sep).join("/")
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
