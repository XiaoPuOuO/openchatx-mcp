export const ROOM_GRID_SIZE = 8
export const ROOM_WIDTH = 448
export const ROOM_HEIGHT = 288
export const ROOM_TILE_SIZE = 4
export const ROOM_TILE_COLS = ROOM_WIDTH / (ROOM_GRID_SIZE * ROOM_TILE_SIZE)
const ROOM_TILE_ROWS = ROOM_HEIGHT / (ROOM_GRID_SIZE * ROOM_TILE_SIZE)

export type RoomDirection = "down" | "up" | "right" | "left"

const ROOM_ASSETS = {
  floor: "/ui/pixel-agents/assets/floors/floor_5.png",
  deskFront: "/ui/pixel-agents/assets/furniture/DESK/DESK_FRONT.png",
  deskSide: "/ui/pixel-agents/assets/furniture/DESK/DESK_SIDE.png",
  pcFront: "/ui/pixel-agents/assets/furniture/PC/PC_FRONT_ON_1.png",
  pcSide: "/ui/pixel-agents/assets/furniture/PC/PC_SIDE.png",
  bookshelf: "/ui/pixel-agents/assets/furniture/BOOKSHELF/BOOKSHELF.png",
  doubleBookshelf: "/ui/pixel-agents/assets/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png",
  whiteboard: "/ui/pixel-agents/assets/furniture/WHITEBOARD/WHITEBOARD.png",
  smallTable: "/ui/pixel-agents/assets/furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png",
  smallTableSide: "/ui/pixel-agents/assets/furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png",
  painting: "/ui/pixel-agents/assets/furniture/LARGE_PAINTING/LARGE_PAINTING.png",
  sofa: "/ui/pixel-agents/assets/furniture/SOFA/SOFA_FRONT.png",
  cushionedChairSide: "/ui/pixel-agents/assets/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_SIDE.png",
  woodenChairSide: "/ui/pixel-agents/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png",
  plant: "/ui/pixel-agents/assets/furniture/PLANT/PLANT.png",
  largePlant: "/ui/pixel-agents/assets/furniture/LARGE_PLANT/LARGE_PLANT.png",
  clock: "/ui/pixel-agents/assets/furniture/CLOCK/CLOCK.png",
  hangingPlant: "/ui/pixel-agents/assets/furniture/HANGING_PLANT/HANGING_PLANT.png",
  coffeeTable: "/ui/pixel-agents/assets/furniture/COFFEE_TABLE/COFFEE_TABLE.png",
  coffee: "/ui/pixel-agents/assets/furniture/COFFEE/COFFEE.png",
  smallPainting: "/ui/pixel-agents/assets/furniture/SMALL_PAINTING/SMALL_PAINTING.png",
} as const

export type RoomAsset = string
export type RoomStation = "home" | "terminal" | "patch" | "web" | "image" | "agents"
export const ROOM_STATIONS: RoomStation[] = ["home", "terminal", "patch", "web", "image", "agents"]

export interface RoomFurnitureItem {
  asset: RoomAsset
  x: number
  y: number
  mirror?: boolean
  foregroundWhenWorkingAt?: RoomStation
}

interface RoomRug {
  x: number
  y: number
  width: number
  height: number
  fill: string
  border: string
}

interface RoomStationConfig {
  x: number
  y: number
  label: string
  facing: RoomDirection
}

export type RoomTile =
  | { type: "floor"; asset: string; tint?: string }
  | { type: "wall"; asset: string; tint?: string }
  | { type: "void" }

export interface RoomCarpetTile {
  asset: string
  order?: number
}

export interface RoomPet {
  id: string
  asset: string
  x: number
  y: number
}

export interface RoomLayout {
  version: 2
  cols: number
  rows: number
  tileSize: number
  tiles: RoomTile[]
  carpetTiles: Array<RoomCarpetTile | null>
  pets: RoomPet[]
  characterAsset: string | null
  wallHeight: number
  floorTileSize: number
  stationFocusSize: number
  rugs: RoomRug[]
  stations: Record<RoomStation, RoomStationConfig>
  wallDecor: RoomFurnitureItem[]
  furniture: RoomFurnitureItem[]
  subagentSeat: { x: number; y: number; facing: RoomDirection }
}

const DEFAULT_FLOOR_ASSET = "/ui/pixel-agents/assets/floors/floor_5.png"
const DEFAULT_WALL_ASSET = "/ui/pixel-agents/assets/walls/wall_0.png"
export const DEFAULT_FLOOR_TINT = "#b9784c"
export const DEFAULT_WALL_TINT = "#26394d"

function createDefaultTiles(): RoomTile[] {
  const tiles: RoomTile[] = []
  for (let row = 0; row < ROOM_TILE_ROWS; row += 1) {
    for (let col = 0; col < ROOM_TILE_COLS; col += 1) {
      tiles.push(
        row < 2
          ? { type: "wall", asset: DEFAULT_WALL_ASSET, tint: DEFAULT_WALL_TINT }
          : { type: "floor", asset: DEFAULT_FLOOR_ASSET, tint: DEFAULT_FLOOR_TINT }
      )
    }
  }
  return tiles
}

// All x/y/width/height values below are in 8px grid units.
// Decimals are intentional: x: 8.5 means 68 canvas pixels.
export const ROOM_LAYOUT = {
  version: 2,
  cols: ROOM_TILE_COLS,
  rows: ROOM_TILE_ROWS,
  tileSize: ROOM_TILE_SIZE,
  tiles: createDefaultTiles(),
  carpetTiles: Array.from({ length: ROOM_TILE_COLS * ROOM_TILE_ROWS }, () => null),
  pets: [],
  characterAsset: null,
  wallHeight: 8,
  floorTileSize: 4,
  stationFocusSize: 4,
  rugs: [
    { x: 14.5, y: 27, width: 19.25, height: 8.5, fill: "#466b64", border: "#2f4a46" },
    { x: 38, y: 26, width: 15.75, height: 8.75, fill: "#4b7190", border: "#334e65" },
  ],
  stations: {
    home: { x: 26, y: 22, label: "Home", facing: "right" },
    terminal: { x: 7, y: 30, label: "Shell", facing: "left" },
    patch: { x: 46, y: 26, label: "Patch", facing: "up" },
    web: { x: 46, y: 14, label: "Web", facing: "up" },
    image: { x: 10, y: 14, label: "Image", facing: "up" },
    agents: { x: 18, y: 32, label: "Agents", facing: "right" },
  } satisfies Record<RoomStation, { x: number; y: number; label: string; facing: RoomDirection }>,
  wallDecor: [
    { asset: "hangingPlant", x: 0, y: 0 },
    { asset: "painting", x: 4, y: 0 },
    // { asset: "smallPainting", x: 16, y: 0 },
    { asset: "clock", x: 28, y: 0 },
    { asset: "doubleBookshelf", x: 40, y: 0 },
    { asset: "hangingPlant", x: 52, y: 0 },
  ] satisfies RoomFurnitureItem[],
  furniture: [
    // Web

    // Shell
    { asset: "cushionedChairSide", x: 5, y: 28, mirror: true },
    { asset: "deskSide", x: 1, y: 20, foregroundWhenWorkingAt: "terminal" },
    { asset: "pcSide", x: 1, y: 24, mirror: true, foregroundWhenWorkingAt: "terminal" },

    // Home / idle
    { asset: "plant", x: 28, y: 10 },
    { asset: "cushionedChairSide", x: 24, y: 20 },
    { asset: "smallTableSide", x: 28, y: 12 },
    { asset: "pcSide", x: 28, y: 16 },

    // Patch
    { asset: "whiteboard", x: 40, y: 12 },
    { asset: "smallTable", x: 40, y: 20, foregroundWhenWorkingAt: "patch" },

    // Delegation
    { asset: "cushionedChairSide", x: 16, y: 29 },
    { asset: "cushionedChairSide", x: 28, y: 29, mirror: true },
    { asset: "coffeeTable", x: 20, y: 26 },
    { asset: "coffee", x: 20, y: 30 },

    // Lounge
    { asset: "sofa", x: 40, y: 24 },
    { asset: "coffeeTable", x: 40, y: 28 },
    { asset: "coffee", x: 40, y: 28 },
    { asset: "largePlant", x: 48, y: 24 },
  ] satisfies RoomFurnitureItem[],
  subagentSeat: { x: 30, y: 32, facing: "left" as RoomDirection },
} as const

export function gridToPixel(value: number): number {
  return value * ROOM_GRID_SIZE
}

export function resolveRoomAssetPath(asset: RoomAsset): string {
  return ROOM_ASSETS[asset as keyof typeof ROOM_ASSETS] ?? asset
}

export function cloneDefaultRoomLayout(): RoomLayout {
  return structuredClone(ROOM_LAYOUT) as unknown as RoomLayout
}

export function migrateRoomLayout(value: Partial<RoomLayout> | undefined): RoomLayout {
  const defaults = cloneDefaultRoomLayout()
  if (!value) return defaults

  const next = { ...defaults, ...value } as RoomLayout
  next.version = 2
  next.cols = Number.isInteger(value.cols) ? Number(value.cols) : defaults.cols
  next.rows = Number.isInteger(value.rows) ? Number(value.rows) : defaults.rows
  next.tileSize = typeof value.tileSize === "number" ? value.tileSize : defaults.tileSize
  const tileCount = next.cols * next.rows
  next.tiles =
    Array.isArray(value.tiles) && value.tiles.length === tileCount
      ? value.tiles.map((tile) => {
          if (tile.type === "floor") return { ...tile, tint: tile.tint ?? DEFAULT_FLOOR_TINT }
          if (tile.type === "wall") return { ...tile, tint: tile.tint ?? DEFAULT_WALL_TINT }
          return { type: "void" as const }
        })
      : createDefaultTiles()
  next.carpetTiles =
    Array.isArray(value.carpetTiles) && value.carpetTiles.length === tileCount
      ? structuredClone(value.carpetTiles)
      : Array.from({ length: tileCount }, () => null)
  next.pets = Array.isArray(value.pets) ? structuredClone(value.pets) : []
  next.characterAsset = typeof value.characterAsset === "string" ? value.characterAsset : null
  next.rugs = Array.isArray(value.rugs) ? structuredClone(value.rugs) : defaults.rugs
  next.wallDecor = Array.isArray(value.wallDecor)
    ? structuredClone(value.wallDecor)
    : defaults.wallDecor
  next.furniture = Array.isArray(value.furniture)
    ? structuredClone(value.furniture)
    : defaults.furniture
  next.stations = value.stations
    ? (structuredClone(value.stations) as RoomLayout["stations"])
    : defaults.stations
  next.subagentSeat = value.subagentSeat
    ? structuredClone(value.subagentSeat)
    : defaults.subagentSeat
  return next
}
