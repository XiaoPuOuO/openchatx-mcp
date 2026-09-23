import { ArrowLeft, RotateCcw, Save } from "lucide-react"
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"

import { Button } from "../../../components/ui/button"
import {
  cloneDefaultRoomLayout,
  DEFAULT_FLOOR_TINT,
  DEFAULT_WALL_TINT,
  gridToPixel,
  ROOM_GRID_SIZE,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type RoomFurnitureItem,
  type RoomLayout,
  type RoomPet,
} from "../layout"
import { fetchPixelAgentsCatalog, type PixelAgentsCatalog } from "../pixel-agents-catalog"
import { loadRoomLayout, saveRoomLayout } from "../room-layout-storage"
import {
  type AssetChoice,
  EditorInspectorPanel,
  type EditorTool,
  EditorToolsPanel,
  FALLBACK_ASSET_CHOICES,
} from "./EditorPanels"
import { renderEditor } from "./editor-canvas"
import { hitSelections, type Selection, sameSelection, selectionPosition } from "./editor-selection"

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
        <EditorToolsPanel
          tool={tool}
          onToolChange={setTool}
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

        <EditorInspectorPanel
          layout={layout}
          selection={selection}
          itemsHere={itemsHere}
          assetChoices={assetChoices}
          pets={catalog?.pets ?? []}
          onChange={mutateLayout}
          onDelete={deleteSelection}
          onDuplicate={duplicateSelection}
          onSelect={setSelection}
        />
      </div>
    </main>
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
