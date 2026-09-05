import {
  gridToPixel,
  ROOM_ASSETS,
  ROOM_GRID_SIZE,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  resolveRoomAssetPath,
  type RoomCarpetTile,
  type RoomFurnitureItem,
  type RoomLayout,
  type RoomPet,
  type RoomStation,
  type RoomTile,
} from "./agentRoomLayout"

export const ROOM_PIXEL_SCALE = 2

const imageCache = new Map<string, HTMLImageElement>()

export function drawRoomSurface(ctx: CanvasRenderingContext2D, layout: RoomLayout): void {
  const tileSize = gridToPixel(layout.tileSize)
  ctx.fillStyle = "#26394d"
  ctx.fillRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)

  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const tile = layout.tiles[row * layout.cols + col]
      if (!tile || tile.type === "void") continue
      const x = col * tileSize
      const y = row * tileSize
      if (tile.type === "wall") {
        ctx.fillStyle = "#26394d"
        ctx.fillRect(x, y, tileSize, tileSize)
        continue
      }
      const floor = getRoomImage(tile.asset)
      if (isReady(floor)) {
        ctx.drawImage(floor, x, y, tileSize, tileSize)
        if (tile.tint) multiplyTint(ctx, x, y, tileSize, tileSize, tile.tint)
      }
    }
  }

  for (const rug of layout.rugs) {
    const x = gridToPixel(rug.x)
    const y = gridToPixel(rug.y)
    const width = gridToPixel(rug.width)
    const height = gridToPixel(rug.height)
    ctx.fillStyle = rug.border
    ctx.fillRect(x, y, width, height)
    ctx.fillStyle = rug.fill
    ctx.fillRect(x + ROOM_GRID_SIZE / 2, y + ROOM_GRID_SIZE / 2, width - ROOM_GRID_SIZE, height - ROOM_GRID_SIZE)
  }

  drawCarpetLayer(ctx, layout)
}

export function drawRoomWalls(ctx: CanvasRenderingContext2D, layout: RoomLayout): void {
  const tileSize = gridToPixel(layout.tileSize)
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const tile = layout.tiles[row * layout.cols + col]
      if (!tile || tile.type !== "wall") continue
      const image = getRoomImage(tile.asset)
      if (!isReady(image)) continue
      const mask = wallMask(layout, col, row, tile.asset)
      const sx = (mask % 4) * 16
      const sy = Math.floor(mask / 4) * 32
      const x = col * tileSize
      const y = row * tileSize - tileSize
      ctx.drawImage(image, sx, sy, 16, 32, x, y, tileSize, tileSize * 2)
      if (tile.tint) multiplyTint(ctx, x, y, tileSize, tileSize * 2, tile.tint)
    }
  }
}

export function drawRoomFurnitureItems(ctx: CanvasRenderingContext2D, items: readonly RoomFurnitureItem[]): void {
  for (const item of items) drawRoomFurnitureItem(ctx, item)
}

export function drawRoomFurnitureItem(ctx: CanvasRenderingContext2D, item: RoomFurnitureItem): void {
  const path = resolveRoomAssetPath(item.asset)
  const image = getRoomImage(path)
  if (!isReady(image)) return
  const x = gridToPixel(item.x)
  const y = gridToPixel(item.y)
  const width = image.naturalWidth * ROOM_PIXEL_SCALE
  const height = image.naturalHeight * ROOM_PIXEL_SCALE
  if (!item.mirror) {
    ctx.drawImage(image, x, y, width, height)
    return
  }
  ctx.save()
  ctx.translate(x + width, y)
  ctx.scale(-1, 1)
  ctx.drawImage(image, 0, 0, width, height)
  ctx.restore()
}

export function roomFurnitureBounds(item: RoomFurnitureItem): { x: number; y: number; width: number; height: number } {
  const image = getRoomImage(resolveRoomAssetPath(item.asset))
  return {
    x: gridToPixel(item.x),
    y: gridToPixel(item.y),
    width: (isReady(image) ? image.naturalWidth : 16) * ROOM_PIXEL_SCALE,
    height: (isReady(image) ? image.naturalHeight : 16) * ROOM_PIXEL_SCALE,
  }
}

export function drawRoomBorder(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#111923"
  ctx.fillRect(0, 0, ROOM_WIDTH, 5)
  ctx.fillRect(0, ROOM_HEIGHT - 5, ROOM_WIDTH, 5)
  ctx.fillRect(0, 0, 5, ROOM_HEIGHT)
  ctx.fillRect(ROOM_WIDTH - 5, 0, 5, ROOM_HEIGHT)
}

export function drawRoomForeground(ctx: CanvasRenderingContext2D, layout: RoomLayout, station: RoomStation): void {
  drawRoomFurnitureItems(
    ctx,
    layout.furniture.filter((item) => item.foregroundWhenWorkingAt === station)
  )
}

export function drawRoomPets(ctx: CanvasRenderingContext2D, pets: readonly RoomPet[]): void {
  const frame = Math.floor(Date.now() / 550) % 3
  for (const pet of pets) {
    const image = getRoomImage(pet.asset)
    if (!isReady(image)) continue
    const x = gridToPixel(pet.x)
    const y = gridToPixel(pet.y)
    const width = 16 * ROOM_PIXEL_SCALE
    const height = 32 * ROOM_PIXEL_SCALE
    ctx.drawImage(image, (3 + frame) * 16, 0, 16, 32, x - width / 2, y - height, width, height)
  }
}

export function roomPetBounds(pet: RoomPet): { x: number; y: number; width: number; height: number } {
  const width = 16 * ROOM_PIXEL_SCALE
  const height = 32 * ROOM_PIXEL_SCALE
  const x = gridToPixel(pet.x)
  const y = gridToPixel(pet.y)
  return { x: x - width / 2, y: y - height, width, height }
}

export function getRoomImage(path: string): HTMLImageElement {
  const cached = imageCache.get(path)
  if (cached) return cached
  const image = new Image()
  image.src = path
  imageCache.set(path, image)
  return image
}

function isReady(image: HTMLImageElement): boolean {
  return image.complete && image.naturalWidth > 0
}

function wallMask(layout: RoomLayout, col: number, row: number, asset: string): number {
  let mask = 0
  if (isMatchingWall(layout, col, row - 1, asset)) mask |= 1
  if (isMatchingWall(layout, col + 1, row, asset)) mask |= 2
  if (isMatchingWall(layout, col, row + 1, asset)) mask |= 4
  if (isMatchingWall(layout, col - 1, row, asset)) mask |= 8
  return mask
}

function isMatchingWall(layout: RoomLayout, col: number, row: number, asset: string): boolean {
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return false
  const tile = layout.tiles[row * layout.cols + col]
  return tile?.type === "wall" && tile.asset === asset
}

function drawCarpetLayer(ctx: CanvasRenderingContext2D, layout: RoomLayout): void {
  const tileSize = gridToPixel(layout.tileSize)
  for (let jy = 0; jy <= layout.rows; jy += 1) {
    for (let jx = 0; jx <= layout.cols; jx += 1) {
      const variants = carpetVariantsAtJunction(layout, jx, jy)
      for (const { asset } of variants) {
        const msCase = carpetJunctionCase(layout, jx, jy, asset)
        if (msCase === 0) continue
        const image = getRoomImage(asset)
        if (!isReady(image)) continue
        const sx = (msCase % 4) * 16
        const sy = Math.floor(msCase / 4) * 16
        ctx.drawImage(
          image,
          sx,
          sy,
          16,
          16,
          jx * tileSize - tileSize / 2,
          jy * tileSize - tileSize / 2,
          tileSize,
          tileSize
        )
      }
    }
  }
}

function carpetVariantsAtJunction(layout: RoomLayout, jx: number, jy: number): Array<{ asset: string; order: number }> {
  const variants = new Map<string, number>()
  for (const [col, row] of [[jx - 1, jy - 1], [jx, jy - 1], [jx, jy], [jx - 1, jy]]) {
    const tile = carpetTileAt(layout, col, row)
    if (!tile) continue
    variants.set(tile.asset, Math.max(variants.get(tile.asset) ?? 0, tile.order ?? 0))
  }
  return [...variants.entries()]
    .map(([asset, order]) => ({ asset, order }))
    .sort((left, right) => left.order - right.order)
}

function carpetJunctionCase(layout: RoomLayout, jx: number, jy: number, asset: string): number {
  let msCase = 0
  if (carpetTileAt(layout, jx - 1, jy - 1)?.asset === asset) msCase |= 1
  if (carpetTileAt(layout, jx, jy - 1)?.asset === asset) msCase |= 2
  if (carpetTileAt(layout, jx, jy)?.asset === asset) msCase |= 4
  if (carpetTileAt(layout, jx - 1, jy)?.asset === asset) msCase |= 8
  return msCase
}

function carpetTileAt(layout: RoomLayout, col: number, row: number): RoomCarpetTile | null {
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null
  return layout.carpetTiles[row * layout.cols + col] ?? null
}

function multiplyTint(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, tint: string): void {
  ctx.save()
  ctx.globalCompositeOperation = "multiply"
  ctx.fillStyle = tint
  ctx.fillRect(x, y, width, height)
  ctx.restore()
}
