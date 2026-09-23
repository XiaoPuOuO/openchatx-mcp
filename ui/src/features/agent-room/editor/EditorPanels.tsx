import {
  Armchair,
  BrickWall,
  Copy,
  FlipHorizontal2,
  Grid2X2,
  Layers3,
  MousePointer2,
  PaintBucket,
  PawPrint,
  Trash2,
} from "lucide-react"

import { Button } from "../../../components/ui/button"
import {
  ROOM_STATIONS,
  type RoomDirection,
  type RoomLayout,
  type RoomStation,
  resolveRoomAssetPath,
} from "../layout"
import type { PixelAgentsCatalog } from "../pixel-agents-catalog"
import {
  type FurnitureList,
  type Selection,
  sameSelection,
  selectionKey,
  selectionLabel,
} from "./editor-selection"

export type EditorTool = "select" | "furniture" | "floor" | "wall" | "carpet" | "entities"

export interface AssetChoice {
  asset: string
  label: string
  category: string
  list: FurnitureList
}

export const FALLBACK_ASSET_CHOICES: AssetChoice[] = [
  { asset: "deskFront", label: "Desk front", category: "Desks", list: "furniture" },
  { asset: "deskSide", label: "Desk side", category: "Desks", list: "furniture" },
  { asset: "pcFront", label: "PC front", category: "Electronics", list: "furniture" },
  { asset: "pcSide", label: "PC side", category: "Electronics", list: "furniture" },
  {
    asset: "cushionedChairSide",
    label: "Cushioned chair",
    category: "Chairs",
    list: "furniture",
  },
  { asset: "plant", label: "Plant", category: "Decor", list: "furniture" },
]

const DIRECTIONS: RoomDirection[] = ["up", "right", "down", "left"]
const TOOL_BUTTONS: Array<{ id: EditorTool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "furniture", label: "Furniture", icon: Armchair },
  { id: "floor", label: "Floor", icon: PaintBucket },
  { id: "wall", label: "Wall", icon: BrickWall },
  { id: "carpet", label: "Carpet", icon: Layers3 },
  { id: "entities", label: "Entities", icon: PawPrint },
]

export function EditorToolsPanel(props: {
  tool: EditorTool
  onToolChange: (tool: EditorTool) => void
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
  return (
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
            onClick={() => props.onToolChange(id)}
            className={`flex h-9 items-center justify-center gap-1.5 rounded-md border text-xs ${props.tool === id ? "border-blue-500 bg-blue-50 text-blue-800" : "bg-background hover:bg-muted"}`}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>
      <div className="mt-4 max-h-[calc(100vh-15rem)] overflow-auto pr-1">
        <ToolPalette {...props} />
      </div>
    </aside>
  )
}

export function EditorInspectorPanel({
  layout,
  selection,
  itemsHere,
  assetChoices,
  pets,
  onChange,
  onDelete,
  onDuplicate,
  onSelect,
}: {
  layout: RoomLayout
  selection?: Selection
  itemsHere: Selection[]
  assetChoices: AssetChoice[]
  pets: Array<{ id: string; label: string; path: string }>
  onChange: (mutator: (next: RoomLayout) => void) => void
  onDelete: (selection: Selection) => void
  onDuplicate: (selection: Selection) => void
  onSelect: (selection: Selection) => void
}) {
  return (
    <aside className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Inspector</h2>
        {selection ? (
          <SelectionInspector
            layout={layout}
            selection={selection}
            assetChoices={assetChoices}
            pets={pets}
            onChange={onChange}
            onDelete={() => onDelete(selection)}
            onDuplicate={() => onDuplicate(selection)}
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
                onClick={() => onSelect(item)}
              >
                {selectionLabel(layout, item)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
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
            {ROOM_STATIONS.map((station) => (
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
