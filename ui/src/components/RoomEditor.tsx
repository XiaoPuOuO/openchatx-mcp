import {
  Armchair,
  ArrowLeft,
  BrickWall,
  Copy,
  FlipHorizontal2,
  Grid2X2,
  Layers3,
  MousePointer2,
  PaintBucket,
  PawPrint,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react"
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"

import {
  cloneDefaultRoomLayout,
  DEFAULT_FLOOR_TINT,
  DEFAULT_WALL_TINT,
  gridToPixel,
  ROOM_GRID_SIZE,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type RoomDirection,
  type RoomFurnitureItem,
  type RoomLayout,
  type RoomPet,
  type RoomStation,
  resolveRoomAssetPath,
} from "../game/agentRoomLayout"
import {
  drawRoomBorder,
  drawRoomFurnitureItems,
  drawRoomPets,
  drawRoomSurface,
  drawRoomWalls,
  roomFurnitureBounds,
  roomPetBounds,
} from "../game/agentRoomRenderer"
import { fetchPixelAgentsCatalog, type PixelAgentsCatalog } from "../game/pixelAgentsCatalog"
import { loadRoomLayout, saveRoomLayout } from "../game/roomLayoutStorage"
import { Button } from "./ui/button"

type FurnitureList = "furniture" | "wallDecor"
type EditorTool = "select" | "furniture" | "floor" | "wall" | "carpet" | "entities"

type Selection =
  | { kind: "furniture"; list: FurnitureList; index: number }
  | { kind: "rug"; index: number }
  | { kind: "station"; station: RoomStation }
  | { kind: "pet"; index: number }

interface AssetChoice {
  asset: string
  label: string
  category: string
  list: FurnitureList
}

const FALLBACK_ASSET_CHOICES: AssetChoice[] = [
  { asset: "deskFront", label: "Desk front", category: "Desks", list: "furniture" },
  { asset: "deskSide", label: "Desk side", category: "Desks", list: "furniture" },
  { asset: "pcFront", label: "PC front", category: "Electronics", list: "furniture" },
  { asset: "pcSide", label: "PC side", category: "Electronics", list: "furniture" },
  { asset: "cushionedChairSide", label: "Cushioned chair", category: "Chairs", list: "furniture" },
  { asset: "plant", label: "Plant", category: "Decor", list: "furniture" },
]

const STATION_KEYS: RoomStation[] = ["home", "terminal", "patch", "web", "image", "agents"]
const DIRECTIONS: RoomDirection[] = ["up", "right", "down", "left"]
const TOOL_BUTTONS: Array<{ id: EditorTool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "furniture", label: "Furniture", icon: Armchair },
  { id: "floor", label: "Floor", icon: PaintBucket },
  { id: "wall", label: "Wall", icon: BrickWall },
  { id: "carpet", label: "Carpet", icon: Layers3 },
  { id: "entities", label: "Entities", icon: PawPrint },
]

const DEFAULT_FLOOR = "/ui/pixel-agents/assets/floors/floor_5.png"
const DEFAULT_WALL = "/ui/pixel-agents/assets/walls/wall_0.png"
const DEFAULT_CARPET = "/ui/pixel-agents/assets/carpets/carpet_0.png"

export function RoomEditor() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<
    | {
        selection: Selection
        pointerX: number
        pointerY: number
        originX: number
        originY: number
        hits: Selection[]
        cycleOnClick: boolean
        moved: boolean
      }
    | undefined
  >(undefined)
  const paintRef = useRef<{ tool: EditorTool; erase: boolean; lastCell?: string } | undefined>(
    undefined
  )

  const [layout, setLayout] = useState<RoomLayout>(loadRoomLayout)
  const [selection, setSelection] = useState<Selection>()
  const [itemsHere, setItemsHere] = useState<Selection[]>([])
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(loadRoomLayout()))
  const [tool, setTool] = useState<EditorTool>("select")
  const [catalog, setCatalog] = useState<PixelAgentsCatalog>()
  const [assetChoices, setAssetChoices] = useState<AssetChoice[]>(FALLBACK_ASSET_CHOICES)
  const [assetFilter, setAssetFilter] = useState("")
  const [placingFurniture, setPlacingFurniture] = useState<AssetChoice>()
  const [placingPet, setPlacingPet] = useState<string>()
  const [floorAsset, setFloorAsset] = useState(DEFAULT_FLOOR)
  const [wallAsset, setWallAsset] = useState(DEFAULT_WALL)
  const [carpetAsset, setCarpetAsset] = useState(DEFAULT_CARPET)
  const [floorTint, setFloorTint] = useState(DEFAULT_FLOOR_TINT)
  const [wallTint, setWallTint] = useState(DEFAULT_WALL_TINT)

  const dirty = JSON.stringify(layout) !== savedJson
  const filteredAssetChoices = assetChoices.filter((choice) =>
    `${choice.label} ${choice.category}`.toLowerCase().includes(assetFilter.trim().toLowerCase())
  )
  const categories = [...new Set(filteredAssetChoices.map((choice) => choice.category))]

  useEffect(() => {
    void fetchPixelAgentsCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog)
        setAssetChoices(
          nextCatalog.furniture.map((entry) => ({
            asset: entry.path,
            label: entry.label,
            category: categoryLabel(entry.category),
            list: entry.category === "wall" || entry.canPlaceOnWalls ? "wallDecor" : "furniture",
          }))
        )
        setFloorAsset(
          nextCatalog.floors.find((entry) => entry.path.endsWith("floor_5.png"))?.path ??
            nextCatalog.floors[0]?.path ??
            DEFAULT_FLOOR
        )
        setWallAsset(nextCatalog.walls[0]?.path ?? DEFAULT_WALL)
        setCarpetAsset(nextCatalog.carpets[0]?.path ?? DEFAULT_CARPET)
      })
      .catch(() => setAssetChoices(FALLBACK_ASSET_CHOICES))
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    let frameId = 0
    const render = () => {
      ctx.imageSmoothingEnabled = false
      renderEditor(ctx, layout, selection)
      frameId = requestAnimationFrame(render)
    }
    frameId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frameId)
  }, [layout, selection])

  // biome-ignore lint/correctness/useExhaustiveDependencies: These helpers only capture stable React state setters.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || !selection) return
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        deleteSelection(selection)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault()
        duplicateSelection(selection)
        return
      }
      const step = event.shiftKey ? 0.5 : 1
      const movement =
        event.key === "ArrowLeft"
          ? { x: -step, y: 0 }
          : event.key === "ArrowRight"
            ? { x: step, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -step }
              : event.key === "ArrowDown"
                ? { x: 0, y: step }
                : undefined
      if (!movement) return
      event.preventDefault()
      moveSelection(selection, movement.x, movement.y)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selection])

  function mutateLayout(mutator: (next: RoomLayout) => void) {
    setLayout((current) => {
      const next = structuredClone(current)
      mutator(next)
      return next
    })
  }

  function moveSelection(target: Selection, dx: number, dy: number) {
    mutateLayout((next) => {
      const position = selectionPosition(next, target)
      if (!position) return
      position.x = snap(position.x + dx)
      position.y = snap(position.y + dy)
    })
  }

  function deleteSelection(target: Selection) {
    if (target.kind === "station") return
    mutateLayout((next) => {
      if (target.kind === "rug") next.rugs.splice(target.index, 1)
      else if (target.kind === "pet") next.pets.splice(target.index, 1)
      else next[target.list].splice(target.index, 1)
    })
    setSelection(undefined)
  }

  function duplicateSelection(target: Selection) {
    if (target.kind === "station") return
    mutateLayout((next) => {
      if (target.kind === "rug") {
        const source = next.rugs[target.index]
        next.rugs.push({ ...source, x: source.x + 1, y: source.y + 1 })
        setSelection({ kind: "rug", index: next.rugs.length - 1 })
      } else if (target.kind === "pet") {
        const source = next.pets[target.index]
        next.pets.push({ ...source, id: crypto.randomUUID(), x: source.x + 1, y: source.y + 1 })
        setSelection({ kind: "pet", index: next.pets.length - 1 })
      } else {
        const list = next[target.list]
        const source = list[target.index]
        list.push({ ...source, x: source.x + 1, y: source.y + 1 })
        setSelection({ kind: "furniture", list: target.list, index: list.length - 1 })
      }
    })
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event)
    if (tool === "floor" || tool === "wall" || tool === "carpet") {
      paintRef.current = { tool, erase: event.button === 2 }
      paintAt(point.x, point.y)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (tool === "furniture" && placingFurniture) {
      const item: RoomFurnitureItem = {
        asset: placingFurniture.asset,
        x: snap(point.x / ROOM_GRID_SIZE),
        y: snap(point.y / ROOM_GRID_SIZE),
      }
      mutateLayout((next) => next[placingFurniture.list].push(item))
      setSelection({
        kind: "furniture",
        list: placingFurniture.list,
        index: layout[placingFurniture.list].length,
      })
      return
    }
    if (tool === "entities" && placingPet) {
      const pet: RoomPet = {
        id: crypto.randomUUID(),
        asset: placingPet,
        x: snap(point.x / ROOM_GRID_SIZE),
        y: snap(point.y / ROOM_GRID_SIZE),
      }
      mutateLayout((next) => next.pets.push(pet))
      setSelection({ kind: "pet", index: layout.pets.length })
      return
    }

    const hits = hitSelections(layout, point.x, point.y)
    setItemsHere(hits)
    if (hits.length === 0) {
      setSelection(undefined)
      return
    }
    const selectedAlreadyHit = Boolean(
      selection && hits.some((hit) => sameSelection(hit, selection))
    )
    const selectedHit = selectedAlreadyHit && selection ? selection : hits[0]
    setSelection(selectedHit)
    const position = selectionPosition(layout, selectedHit)
    if (!position) return
    dragRef.current = {
      selection: selectedHit,
      pointerX: point.x,
      pointerY: point.y,
      originX: position.x,
      originY: position.y,
      hits,
      cycleOnClick: selectedAlreadyHit && hits.length > 1,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event)
    if (paintRef.current) {
      paintAt(point.x, point.y)
      return
    }
    const drag = dragRef.current
    if (!drag) return
    if (Math.hypot(point.x - drag.pointerX, point.y - drag.pointerY) > 2) drag.moved = true
    const dx = (point.x - drag.pointerX) / ROOM_GRID_SIZE
    const dy = (point.y - drag.pointerY) / ROOM_GRID_SIZE
    mutateLayout((next) => {
      const position = selectionPosition(next, drag.selection)
      if (!position) return
      position.x = snap(drag.originX + dx)
      position.y = snap(drag.originY + dy)
    })
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    paintRef.current = undefined
    const drag = dragRef.current
    if (drag && !drag.moved && drag.cycleOnClick) {
      const index = drag.hits.findIndex((hit) => sameSelection(hit, drag.selection))
      setSelection(drag.hits[(index + 1) % drag.hits.length])
    }
    dragRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function paintAt(x: number, y: number) {
    const paint = paintRef.current
    if (!paint) return
    const tileSize = gridToPixel(layout.tileSize)
    const col = Math.floor(x / tileSize)
    const row = Math.floor(y / tileSize)
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return
    const cell = `${col}:${row}:${paint.erase ? 1 : 0}`
    if (paint.lastCell === cell) return
    paint.lastCell = cell
    mutateLayout((next) => {
      const index = row * next.cols + col
      if (paint.tool === "floor") {
        next.tiles[index] = paint.erase
          ? { type: "void" }
          : { type: "floor", asset: floorAsset, tint: floorTint }
        if (paint.erase) next.carpetTiles[index] = null
      } else if (paint.tool === "wall") {
        next.tiles[index] = paint.erase
          ? { type: "floor", asset: floorAsset, tint: floorTint }
          : { type: "wall", asset: wallAsset, tint: wallTint }
        next.carpetTiles[index] = null
      } else if (paint.tool === "carpet") {
        if (paint.erase) next.carpetTiles[index] = null
        else if (next.tiles[index]?.type === "floor")
          next.carpetTiles[index] = { asset: carpetAsset }
      }
    })
  }

  function save() {
    saveRoomLayout(layout)
    setSavedJson(JSON.stringify(layout))
  }

  function resetDraft() {
    setLayout(cloneDefaultRoomLayout())
    setSelection(undefined)
    setItemsHere([])
  }

  return (
    <main className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-5 py-3 lg:px-8">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back to Shellby Control"
              onClick={() => (window.location.href = "/ui/")}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h1 className="text-base font-semibold tracking-tight">Room Editor</h1>
              <p className="text-xs text-muted-foreground">
                8px object grid · 32px tile map · right-click erases paint
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`hidden text-xs sm:inline ${dirty ? "text-amber-700" : "text-muted-foreground"}`}
            >
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={resetDraft}>
              <RotateCcw className="size-3.5" /> Reset draft
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={!dirty}>
              <Save className="size-3.5" /> Save layout
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-4 px-5 py-5 lg:grid-cols-[270px_minmax(0,1fr)_280px] lg:px-8">
        <aside className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Grid2X2 className="size-4" />
            <h2 className="text-sm font-semibold">Editor tools</h2>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {TOOL_BUTTONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTool(id)}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-md border text-xs ${tool === id ? "border-blue-500 bg-blue-50 text-blue-800" : "bg-background hover:bg-muted"}`}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          <div className="mt-4 max-h-[calc(100vh-15rem)] overflow-auto pr-1">
            <ToolPalette
              tool={tool}
              catalog={catalog}
              assetChoices={filteredAssetChoices}
              categories={categories}
              assetFilter={assetFilter}
              onAssetFilter={setAssetFilter}
              placingFurniture={placingFurniture}
              onPlaceFurniture={setPlacingFurniture}
              floorAsset={floorAsset}
              onFloorAsset={setFloorAsset}
              floorTint={floorTint}
              onFloorTint={setFloorTint}
              wallAsset={wallAsset}
              onWallAsset={setWallAsset}
              wallTint={wallTint}
              onWallTint={setWallTint}
              carpetAsset={carpetAsset}
              onCarpetAsset={setCarpetAsset}
              placingPet={placingPet}
              onPlacePet={setPlacingPet}
              characterAsset={layout.characterAsset}
              onCharacterAsset={(asset) =>
                mutateLayout((next) => {
                  next.characterAsset = asset
                })
              }
            />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="overflow-auto rounded-xl border bg-[#d8e7c3] p-3 shadow-sm">
            <canvas
              ref={canvasRef}
              width={ROOM_WIDTH}
              height={ROOM_HEIGHT}
              className={`mx-auto block w-full max-w-[1000px] touch-none [image-rendering:pixelated] ${tool === "floor" || tool === "wall" || tool === "carpet" || placingFurniture || placingPet ? "cursor-crosshair" : "cursor-default"}`}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onContextMenu={(event) => event.preventDefault()}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Select: click/drag objects · repeated clicks cycle overlaps · paint tools drag across
            32px cells · right-click erases · Shift+arrow nudges objects 0.5
          </p>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold">Inspector</h2>
            {selection ? (
              <SelectionInspector
                layout={layout}
                selection={selection}
                assetChoices={assetChoices}
                pets={catalog?.pets ?? []}
                onChange={mutateLayout}
                onDelete={() => deleteSelection(selection)}
                onDuplicate={() => duplicateSelection(selection)}
              />
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                Select furniture, a rug, a pet, or a station marker in the room.
              </p>
            )}
          </div>
          {itemsHere.length > 1 ? (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold">Items here</h2>
              <div className="space-y-1">
                {itemsHere.map((item) => (
                  <button
                    key={selectionKey(item)}
                    type="button"
                    className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${selection && sameSelection(item, selection) ? "bg-blue-50 text-blue-800" : "hover:bg-muted"}`}
                    onClick={() => setSelection(item)}
                  >
                    {selectionLabel(layout, item)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  )
}

function ToolPalette(props: {
  tool: EditorTool
  catalog?: PixelAgentsCatalog
  assetChoices: AssetChoice[]
  categories: string[]
  assetFilter: string
  onAssetFilter: (value: string) => void
  placingFurniture?: AssetChoice
  onPlaceFurniture: (choice?: AssetChoice) => void
  floorAsset: string
  onFloorAsset: (asset: string) => void
  floorTint: string
  onFloorTint: (value: string) => void
  wallAsset: string
  onWallAsset: (asset: string) => void
  wallTint: string
  onWallTint: (value: string) => void
  carpetAsset: string
  onCarpetAsset: (asset: string) => void
  placingPet?: string
  onPlacePet: (asset?: string) => void
  characterAsset: string | null
  onCharacterAsset: (asset: string | null) => void
}) {
  if (props.tool === "select")
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        Click objects, pets, rugs, or station markers. Drag to move. Use the inspector for exact
        coordinates.
      </p>
    )

  if (props.tool === "furniture") {
    return (
      <div className="space-y-4">
        <input
          value={props.assetFilter}
          onChange={(event) => props.onAssetFilter(event.target.value)}
          placeholder="Filter furniture..."
          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
        />
        {props.categories.map((category) => (
          <section key={category}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {category}
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {props.assetChoices
                .filter((choice) => choice.category === category)
                .map((choice) => (
                  <AssetButton
                    key={choice.asset}
                    asset={choice.asset}
                    label={choice.label}
                    active={props.placingFurniture?.asset === choice.asset}
                    onClick={() =>
                      props.onPlaceFurniture(
                        props.placingFurniture?.asset === choice.asset ? undefined : choice
                      )
                    }
                  />
                ))}
            </div>
          </section>
        ))}
      </div>
    )
  }

  if (props.tool === "floor")
    return (
      <>
        <SimpleAssetPalette
          title="Floor patterns"
          items={props.catalog?.floors ?? []}
          selected={props.floorAsset}
          onSelect={props.onFloorAsset}
        />
        <TintField label="Floor tint" value={props.floorTint} onChange={props.onFloorTint} />
      </>
    )
  if (props.tool === "wall")
    return (
      <>
        <SimpleAssetPalette
          title="Wall sets"
          items={props.catalog?.walls ?? []}
          selected={props.wallAsset}
          onSelect={props.onWallAsset}
        />
        <TintField label="Wall tint" value={props.wallTint} onChange={props.onWallTint} />
      </>
    )
  if (props.tool === "carpet")
    return (
      <SimpleAssetPalette
        title="Carpet variants"
        items={props.catalog?.carpets ?? []}
        selected={props.carpetAsset}
        onSelect={props.onCarpetAsset}
      />
    )

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pets
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          {(props.catalog?.pets ?? []).map((pet) => (
            <AssetButton
              key={pet.id}
              asset={pet.path}
              label={pet.label}
              active={props.placingPet === pet.path}
              onClick={() => props.onPlacePet(props.placingPet === pet.path ? undefined : pet.path)}
            />
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agent appearance
        </h3>
        <button
          type="button"
          className={`mb-1.5 h-8 w-full rounded-md border text-xs ${props.characterAsset === null ? "border-blue-500 bg-blue-50" : "bg-background"}`}
          onClick={() => props.onCharacterAsset(null)}
        >
          Automatic by agent
        </button>
        <div className="grid grid-cols-2 gap-1.5">
          {(props.catalog?.characters ?? []).map((character) => (
            <AssetButton
              key={character.id}
              asset={character.path}
              label={character.label}
              active={props.characterAsset === character.path}
              onClick={() => props.onCharacterAsset(character.path)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function SimpleAssetPalette({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string
  items: Array<{ id: string; label: string; path: string }>
  selected: string
  onSelect: (asset: string) => void
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <AssetButton
            key={item.id}
            asset={item.path}
            label={item.label}
            active={selected === item.path}
            onClick={() => onSelect(item.path)}
          />
        ))}
      </div>
    </section>
  )
}

function AssetButton({
  asset,
  label,
  active,
  onClick,
}: {
  asset: string
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`flex min-h-20 flex-col items-center justify-center gap-1 rounded-md border p-2 text-center text-[11px] ${active ? "border-blue-500 bg-blue-50" : "bg-background hover:bg-muted"}`}
      onClick={onClick}
    >
      <img
        src={resolveRoomAssetPath(asset)}
        alt=""
        className="max-h-12 max-w-16 [image-rendering:pixelated]"
      />
      <span>{label}</span>
    </button>
  )
}

function TintField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="mt-3 block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background p-1"
      />
    </label>
  )
}

function SelectionInspector({
  layout,
  selection,
  assetChoices,
  pets,
  onChange,
  onDelete,
  onDuplicate,
}: {
  layout: RoomLayout
  selection: Selection
  assetChoices: AssetChoice[]
  pets: Array<{ id: string; label: string; path: string }>
  onChange: (mutator: (next: RoomLayout) => void) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  if (selection.kind === "station") {
    const station = layout.stations[selection.station]
    return (
      <div className="space-y-3">
        <p className="text-xs font-medium">{station.label} station</p>
        <CoordinateInputs
          x={station.x}
          y={station.y}
          onChange={(axis, value) =>
            onChange((next) => {
              next.stations[selection.station][axis] = value
            })
          }
        />
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">Facing</span>
          <select
            value={station.facing}
            onChange={(event) =>
              onChange((next) => {
                next.stations[selection.station].facing = event.target.value as RoomDirection
              })
            }
            className="h-8 w-full rounded-md border bg-background px-2"
          >
            {DIRECTIONS.map((direction) => (
              <option key={direction}>{direction}</option>
            ))}
          </select>
        </label>
      </div>
    )
  }
  if (selection.kind === "rug") {
    const rug = layout.rugs[selection.index]
    if (!rug) return null
    return (
      <div className="space-y-3">
        <p className="text-xs font-medium">Rug {selection.index + 1}</p>
        <CoordinateInputs
          x={rug.x}
          y={rug.y}
          onChange={(axis, value) =>
            onChange((next) => {
              next.rugs[selection.index][axis] = value
            })
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Width"
            value={rug.width}
            onChange={(value) =>
              onChange((next) => {
                next.rugs[selection.index].width = value
              })
            }
          />
          <NumberField
            label="Height"
            value={rug.height}
            onChange={(value) =>
              onChange((next) => {
                next.rugs[selection.index].height = value
              })
            }
          />
        </div>
        <InspectorActions onDuplicate={onDuplicate} onDelete={onDelete} />
      </div>
    )
  }
  if (selection.kind === "pet") {
    const pet = layout.pets[selection.index]
    if (!pet) return null
    return (
      <div className="space-y-3">
        <p className="text-xs font-medium">Pet</p>
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">Type</span>
          <select
            value={pet.asset}
            onChange={(event) =>
              onChange((next) => {
                next.pets[selection.index].asset = event.target.value
              })
            }
            className="h-8 w-full rounded-md border bg-background px-2"
          >
            {pets.map((item) => (
              <option key={item.id} value={item.path}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <CoordinateInputs
          x={pet.x}
          y={pet.y}
          onChange={(axis, value) =>
            onChange((next) => {
              next.pets[selection.index][axis] = value
            })
          }
        />
        <InspectorActions onDuplicate={onDuplicate} onDelete={onDelete} />
      </div>
    )
  }

  const item = layout[selection.list][selection.index]
  if (!item) return null
  return (
    <div className="space-y-3">
      <label className="block text-xs">
        <span className="mb-1 block text-muted-foreground">Asset</span>
        <select
          value={item.asset}
          onChange={(event) =>
            onChange((next) => {
              next[selection.list][selection.index].asset = event.target.value
            })
          }
          className="h-8 w-full rounded-md border bg-background px-2"
        >
          {assetChoices.map((choice) => (
            <option key={choice.asset} value={choice.asset}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <CoordinateInputs
        x={item.x}
        y={item.y}
        onChange={(axis, value) =>
          onChange((next) => {
            next[selection.list][selection.index][axis] = value
          })
        }
      />
      <button
        type="button"
        className={`flex h-8 w-full items-center justify-center gap-2 rounded-md border text-xs ${item.mirror ? "bg-muted" : "bg-background"}`}
        onClick={() =>
          onChange((next) => {
            next[selection.list][selection.index].mirror =
              !next[selection.list][selection.index].mirror
          })
        }
      >
        <FlipHorizontal2 className="size-3.5" /> Mirror horizontally
      </button>
      {selection.list === "furniture" ? (
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">Foreground while working at</span>
          <select
            value={item.foregroundWhenWorkingAt ?? ""}
            onChange={(event) =>
              onChange((next) => {
                next.furniture[selection.index].foregroundWhenWorkingAt = event.target.value
                  ? (event.target.value as RoomStation)
                  : undefined
              })
            }
            className="h-8 w-full rounded-md border bg-background px-2"
          >
            <option value="">Never</option>
            {STATION_KEYS.map((station) => (
              <option key={station} value={station}>
                {layout.stations[station].label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <InspectorActions onDuplicate={onDuplicate} onDelete={onDelete} />
    </div>
  )
}

function CoordinateInputs({
  x,
  y,
  onChange,
}: {
  x: number
  y: number
  onChange: (axis: "x" | "y", value: number) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField label="X" value={x} onChange={(value) => onChange("x", value)} />
      <NumberField label="Y" value={y} onChange={(value) => onChange("y", value)} />
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        type="number"
        step="0.5"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-8 w-full rounded-md border bg-background px-2 font-mono"
      />
    </label>
  )
}

function InspectorActions({
  onDuplicate,
  onDelete,
}: {
  onDuplicate: () => void
  onDelete: () => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 border-t pt-3">
      <Button type="button" variant="outline" size="sm" onClick={onDuplicate}>
        <Copy className="size-3.5" /> Duplicate
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" /> Delete
      </Button>
    </div>
  )
}

function renderEditor(
  ctx: CanvasRenderingContext2D,
  layout: RoomLayout,
  selection?: Selection
): void {
  ctx.clearRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)
  drawRoomSurface(ctx, layout)
  drawGrid(ctx)
  drawRoomWalls(ctx, layout)
  drawRoomFurnitureItems(ctx, layout.wallDecor)
  drawRoomFurnitureItems(ctx, layout.furniture)
  drawRoomPets(ctx, layout.pets)
  drawStations(ctx, layout)
  if (selection) drawSelection(ctx, layout, selection)
  drawRoomBorder(ctx)
}

function drawGrid(ctx: CanvasRenderingContext2D): void {
  ctx.save()
  ctx.lineWidth = 1
  for (let x = ROOM_GRID_SIZE; x < ROOM_WIDTH; x += ROOM_GRID_SIZE) {
    ctx.strokeStyle =
      x % (ROOM_GRID_SIZE * 4) === 0 ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)"
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, ROOM_HEIGHT)
    ctx.stroke()
  }
  for (let y = ROOM_GRID_SIZE; y < ROOM_HEIGHT; y += ROOM_GRID_SIZE) {
    ctx.strokeStyle =
      y % (ROOM_GRID_SIZE * 4) === 0 ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)"
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(ROOM_WIDTH, y + 0.5)
    ctx.stroke()
  }
  ctx.restore()
}

function drawStations(ctx: CanvasRenderingContext2D, layout: RoomLayout): void {
  ctx.save()
  ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace"
  ctx.textAlign = "center"
  for (const key of STATION_KEYS) {
    const station = layout.stations[key]
    const x = gridToPixel(station.x)
    const y = gridToPixel(station.y)
    ctx.fillStyle = "rgba(255,255,255,0.88)"
    ctx.fillRect(x - 5, y - 5, 10, 10)
    ctx.strokeStyle = "#111827"
    ctx.strokeRect(x - 5.5, y - 5.5, 11, 11)
    ctx.fillStyle = "#111827"
    ctx.fillText(station.label, x, y - 9)
  }
  ctx.restore()
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  layout: RoomLayout,
  selection: Selection
): void {
  const bounds = selectionBounds(layout, selection)
  if (!bounds) return
  ctx.save()
  ctx.strokeStyle = "#2563eb"
  ctx.lineWidth = 2
  ctx.setLineDash([4, 3])
  ctx.strokeRect(bounds.x - 2, bounds.y - 2, bounds.width + 4, bounds.height + 4)
  ctx.restore()
}

function hitSelections(layout: RoomLayout, x: number, y: number): Selection[] {
  const hits: Selection[] = []
  for (const station of STATION_KEYS) {
    const selection: Selection = { kind: "station", station }
    const bounds = selectionBounds(layout, selection)
    if (bounds && contains(bounds, x, y)) hits.push(selection)
  }
  for (let index = layout.pets.length - 1; index >= 0; index -= 1)
    if (contains(roomPetBounds(layout.pets[index]), x, y)) hits.push({ kind: "pet", index })
  for (let index = layout.furniture.length - 1; index >= 0; index -= 1)
    if (contains(roomFurnitureBounds(layout.furniture[index]), x, y))
      hits.push({ kind: "furniture", list: "furniture", index })
  for (let index = layout.wallDecor.length - 1; index >= 0; index -= 1)
    if (contains(roomFurnitureBounds(layout.wallDecor[index]), x, y))
      hits.push({ kind: "furniture", list: "wallDecor", index })
  for (let index = layout.rugs.length - 1; index >= 0; index -= 1) {
    const selection: Selection = { kind: "rug", index }
    const bounds = selectionBounds(layout, selection)
    if (bounds && contains(bounds, x, y)) hits.push(selection)
  }
  return hits
}

function selectionBounds(layout: RoomLayout, selection: Selection) {
  if (selection.kind === "furniture") {
    const item = layout[selection.list][selection.index]
    return item ? roomFurnitureBounds(item) : undefined
  }
  if (selection.kind === "pet")
    return layout.pets[selection.index] ? roomPetBounds(layout.pets[selection.index]) : undefined
  if (selection.kind === "rug") {
    const rug = layout.rugs[selection.index]
    return rug
      ? {
          x: gridToPixel(rug.x),
          y: gridToPixel(rug.y),
          width: gridToPixel(rug.width),
          height: gridToPixel(rug.height),
        }
      : undefined
  }
  const station = layout.stations[selection.station]
  const x = gridToPixel(station.x)
  const y = gridToPixel(station.y)
  return { x: x - 8, y: y - 8, width: 16, height: 16 }
}

function selectionPosition(
  layout: RoomLayout,
  selection: Selection
): { x: number; y: number } | undefined {
  if (selection.kind === "station") return layout.stations[selection.station]
  if (selection.kind === "rug") return layout.rugs[selection.index]
  if (selection.kind === "pet") return layout.pets[selection.index]
  return layout[selection.list][selection.index]
}

function selectionLabel(layout: RoomLayout, selection: Selection): string {
  if (selection.kind === "station") return `${layout.stations[selection.station].label} station`
  if (selection.kind === "rug") return `Rug ${selection.index + 1}`
  if (selection.kind === "pet")
    return `Pet · ${layout.pets[selection.index]?.asset.split("/").at(-2) ?? "unknown"}`
  const item = layout[selection.list][selection.index]
  return `${item?.asset.split("/").at(-1) ?? "Item"} · ${selection.list === "wallDecor" ? "wall" : "furniture"}`
}

function selectionKey(selection: Selection): string {
  if (selection.kind === "station") return `station:${selection.station}`
  if (selection.kind === "pet") return `pet:${selection.index}`
  return `${selection.kind}:${"list" in selection ? `${selection.list}:` : ""}${selection.index}`
}

function sameSelection(left: Selection, right: Selection): boolean {
  return selectionKey(left) === selectionKey(right)
}
function contains(
  bounds: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
): boolean {
  return (
    x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
  )
}

function canvasPoint(event: {
  currentTarget: HTMLCanvasElement
  clientX: number
  clientY: number
}) {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * ROOM_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * ROOM_HEIGHT,
  }
}

function snap(value: number): number {
  return Math.round(value * 2) / 2
}
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}
function categoryLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
