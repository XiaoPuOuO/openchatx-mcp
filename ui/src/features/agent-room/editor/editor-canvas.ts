import {
  gridToPixel,
  ROOM_GRID_SIZE,
  ROOM_HEIGHT,
  ROOM_STATIONS,
  ROOM_WIDTH,
  type RoomLayout,
} from "../layout"
import {
  drawRoomBorder,
  drawRoomFurnitureItems,
  drawRoomPets,
  drawRoomSurface,
  drawRoomWalls,
} from "../renderer"
import { type Selection, selectionBounds } from "./editor-selection"

export function renderEditor(
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
  for (const key of ROOM_STATIONS) {
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
