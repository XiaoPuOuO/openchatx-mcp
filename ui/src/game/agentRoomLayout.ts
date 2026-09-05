export const ROOM_GRID_SIZE = 8
export const ROOM_WIDTH = 448
export const ROOM_HEIGHT = 288

export type RoomDirection = "down" | "up" | "right" | "left"

export const ROOM_ASSETS = {
  floor: "/ui/pixel-agents/floors/floor_5.png",
  deskSide: "/ui/pixel-agents/furniture/DESK/DESK_SIDE.png",
  pcSide: "/ui/pixel-agents/furniture/PC/PC_SIDE.png",
  doubleBookshelf: "/ui/pixel-agents/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png",
  whiteboard: "/ui/pixel-agents/furniture/WHITEBOARD/WHITEBOARD.png",
  smallTable: "/ui/pixel-agents/furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png",
  smallTableSide: "/ui/pixel-agents/furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png",
  painting: "/ui/pixel-agents/furniture/LARGE_PAINTING/LARGE_PAINTING.png",
  sofa: "/ui/pixel-agents/furniture/SOFA/SOFA_FRONT.png",
  cushionedChairSide: "/ui/pixel-agents/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_SIDE.png",
  plant: "/ui/pixel-agents/furniture/PLANT/PLANT.png",
  largePlant: "/ui/pixel-agents/furniture/LARGE_PLANT/LARGE_PLANT.png",
  clock: "/ui/pixel-agents/furniture/CLOCK/CLOCK.png",
  hangingPlant: "/ui/pixel-agents/furniture/HANGING_PLANT/HANGING_PLANT.png",
  coffeeTable: "/ui/pixel-agents/furniture/COFFEE_TABLE/COFFEE_TABLE.png",
  coffee: "/ui/pixel-agents/furniture/COFFEE/COFFEE.png",
  smallPainting: "/ui/pixel-agents/furniture/SMALL_PAINTING/SMALL_PAINTING.png",
} as const

export type RoomAsset = keyof typeof ROOM_ASSETS
export type RoomStation = "home" | "terminal" | "patch" | "web" | "image" | "agents"

export interface RoomFurnitureItem {
  asset: RoomAsset
  x: number
  y: number
  mirror?: boolean
  foregroundWhenWorkingAt?: RoomStation
}

// All x/y/width/height values below are in 8px grid units.
// Decimals are intentional: x: 8.5 means 68 canvas pixels.
export const ROOM_LAYOUT = {
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
