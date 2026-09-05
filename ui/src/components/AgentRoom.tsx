import { useEffect, useRef } from "react"

import type { Agent } from "../types"
import {
  createAgentRoomState,
  startAgentRoomLoop,
  STATIONS,
  syncAgentActivities,
  updateAgentRoom,
  type AgentRoomState,
} from "../game/agentRoomEngine"
import {
  gridToPixel,
  ROOM_ASSETS,
  ROOM_GRID_SIZE,
  ROOM_HEIGHT,
  ROOM_LAYOUT,
  ROOM_WIDTH,
  type RoomFurnitureItem,
} from "../game/agentRoomLayout"

const CHAR_FRAME_WIDTH = 16
const CHAR_FRAME_HEIGHT = 32
const PIXEL_SCALE = 2
const SITTING_OFFSET = gridToPixel(1.5)

const imageCache = new Map<string, HTMLImageElement>()

export function AgentRoom({ agent }: { agent: Agent }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<AgentRoomState>(createAgentRoomState())

  useEffect(() => {
    syncAgentActivities(stateRef.current, agent)
  }, [agent])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    return startAgentRoomLoop(canvas, {
      update: (dt) => updateAgentRoom(stateRef.current, dt, reducedMotion),
      render: (ctx) => renderRoom(ctx, stateRef.current, agent.id),
    })
  }, [agent.id])

  return (
    <div className="overflow-hidden rounded-lg border bg-[#d8e7c3]">
      <canvas
        ref={canvasRef}
        width={ROOM_WIDTH}
        height={ROOM_HEIGHT}
        className="block h-auto w-full [image-rendering:pixelated]"
        aria-label={`${agent.id} activity room`}
      />
    </div>
  )
}

function renderRoom(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string): void {
  ctx.clearRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)
  drawRoomSurface(ctx)
  drawWallDecor(ctx)
  drawStationFocus(ctx, state)
  drawBackFurniture(ctx, state)
  drawCharacter(ctx, state, agentId)
  const delegating = isDelegating(state)
  if (delegating) drawSubagentConversation(ctx, state, agentId)
  drawForegroundFurniture(ctx, state)
  if (state.bubble && !delegating) drawSpeechBubble(ctx, state.x, state.y, state.bubble)
  drawRoomBorder(ctx)
}

function drawRoomSurface(ctx: CanvasRenderingContext2D): void {
  const wallHeight = gridToPixel(ROOM_LAYOUT.wallHeight)
  ctx.fillStyle = "#26394d"
  ctx.fillRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)

  const floor = getImage(ROOM_ASSETS.floor)
  if (isReady(floor)) {
    const size = gridToPixel(ROOM_LAYOUT.floorTileSize)
    for (let y = wallHeight; y < ROOM_HEIGHT; y += size) {
      for (let x = 0; x < ROOM_WIDTH; x += size) ctx.drawImage(floor, x, y, size, size)
    }

    ctx.save()
    ctx.globalCompositeOperation = "multiply"
    ctx.fillStyle = "#b9784c"
    ctx.fillRect(0, wallHeight, ROOM_WIDTH, ROOM_HEIGHT - wallHeight)
    ctx.restore()
  }

  ctx.fillStyle = "#172331"
  ctx.fillRect(0, wallHeight - 4, ROOM_WIDTH, 8)

  for (const rug of ROOM_LAYOUT.rugs) drawRug(ctx, rug)
}

function drawRoomBorder(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#111923"
  ctx.fillRect(0, 0, ROOM_WIDTH, 5)
  ctx.fillRect(0, ROOM_HEIGHT - 5, ROOM_WIDTH, 5)
  ctx.fillRect(0, 0, 5, ROOM_HEIGHT)
  ctx.fillRect(ROOM_WIDTH - 5, 0, 5, ROOM_HEIGHT)
}

function drawRug(ctx: CanvasRenderingContext2D, rug: (typeof ROOM_LAYOUT.rugs)[number]): void {
  const x = gridToPixel(rug.x)
  const y = gridToPixel(rug.y)
  const width = gridToPixel(rug.width)
  const height = gridToPixel(rug.height)
  ctx.fillStyle = rug.border
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = rug.fill
  ctx.fillRect(x + ROOM_GRID_SIZE / 2, y + ROOM_GRID_SIZE / 2, width - ROOM_GRID_SIZE, height - ROOM_GRID_SIZE)
}

function drawWallDecor(ctx: CanvasRenderingContext2D): void {
  drawFurnitureItems(ctx, ROOM_LAYOUT.wallDecor)
}

function drawBackFurniture(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  drawFurnitureItems(ctx, ROOM_LAYOUT.furniture)
}

function drawForegroundFurniture(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  if (state.mode !== "working") return
  drawFurnitureItems(
    ctx,
    ROOM_LAYOUT.furniture.filter((item) => item.foregroundWhenWorkingAt === state.station)
  )
}

function drawCharacter(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string): void {
  const character = getImage(`/ui/pixel-agents/characters/char_${characterIndex(agentId)}.png`)
  if (!isReady(character)) return

  const row = state.direction === "down" ? 0 : state.direction === "up" ? 1 : 2
  const walkingFrames = [0, 1, 2, 1]
  const reading = state.currentTool ? isReadingTool(state.currentTool) : false
  const delegating = isDelegating(state)
  const frame =
    state.mode === "walking"
      ? walkingFrames[Math.floor(state.walkFrame) % walkingFrames.length]
      : delegating
        ? 1
        : state.mode === "working"
          ? (reading ? 5 : 3) + (Math.floor(state.workFrame) % 2)
          : state.station === "home"
            ? 3
            : 1

  const x = Math.round(state.x)
  const sittingOffset =
    state.station === "home" || (state.mode === "working" && (state.station === "terminal" || state.station === "agents")) ? SITTING_OFFSET : 0
  const y = Math.round(state.y) + sittingOffset
  drawCharacterFrame(ctx, character, frame, row, x, y, state.direction)
}

function drawSubagentConversation(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string): void {
  const subagent = getImage(`/ui/pixel-agents/characters/char_${(characterIndex(agentId) + 1) % 6}.png`)
  if (!isReady(subagent)) return

  const x = gridToPixel(ROOM_LAYOUT.subagentSeat.x)
  const y = gridToPixel(ROOM_LAYOUT.subagentSeat.y) + SITTING_OFFSET
  const frame = 1
  drawCharacterFrame(ctx, subagent, frame, 2, x, y, ROOM_LAYOUT.subagentSeat.facing)
  const station = STATIONS.agents
  drawConversationBubble(ctx, station.x + 24, station.y - 86, 2)
}

function drawCharacterFrame(
  ctx: CanvasRenderingContext2D,
  character: HTMLImageElement,
  frame: number,
  row: number,
  x: number,
  y: number,
  direction: "down" | "up" | "right" | "left"
): void {
  const destWidth = CHAR_FRAME_WIDTH * PIXEL_SCALE
  const destHeight = CHAR_FRAME_HEIGHT * PIXEL_SCALE

  ctx.save()
  if (direction === "left") {
    ctx.translate(x, 0)
    ctx.scale(-1, 1)
    ctx.translate(-x, 0)
  }
  ctx.drawImage(
    character,
    frame * CHAR_FRAME_WIDTH,
    row * CHAR_FRAME_HEIGHT,
    CHAR_FRAME_WIDTH,
    CHAR_FRAME_HEIGHT,
    x - destWidth / 2,
    y - destHeight,
    destWidth,
    destHeight
  )
  ctx.restore()
}

const CONVERSATION_BUBBLE = [
  "BBBBBBBBBBB",
  "BFFFFFFFFFB",
  "BFFFFFFFFFB",
  "BFFFFFFFFFB",
  "BFFFFFFFFFB",
  "BFFFAFAFAFB",
  "BFFFFFFFFFB",
  "BFFFFFFFFFB",
  "BFFFFFFFFFB",
  "BBBBBBBBBBB",
  "____BBB____",
  "_____B_____",
  "___________",
] as const

function drawConversationBubble(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  const palette: Record<string, string> = {
    B: "#555566",
    F: "#eeeeff",
    A: "#cca700",
  }

  for (let row = 0; row < CONVERSATION_BUBBLE.length; row += 1) {
    const pixels = CONVERSATION_BUBBLE[row]
    for (let col = 0; col < pixels.length; col += 1) {
      const color = palette[pixels[col]]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x + col * scale, y + row * scale, scale, scale)
    }
  }
}

function drawSpeechBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace"
  const width = Math.min(112, Math.ceil(ctx.measureText(text).width) + 14)
  const left = Math.max(6, Math.min(ROOM_WIDTH - width - 6, Math.round(x - width / 2)))
  const top = Math.max(6, Math.round(y - 40))

  ctx.fillStyle = "#2d352a"
  ctx.fillRect(left, top, width, 18)
  ctx.fillRect(Math.round(x) - 2, top + 18, 5, 4)
  ctx.fillStyle = "#fffdf5"
  ctx.fillRect(left + 2, top + 2, width - 4, 14)
  ctx.fillStyle = "#293026"
  ctx.textAlign = "center"
  ctx.fillText(text, left + width / 2, top + 12, width - 8)
}

function characterIndex(agentId: string): number {
  let hash = 0
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return Math.abs(hash) % 6
}

function isReadingTool(tool: string): boolean {
  return tool === "fetch_url" || tool.startsWith("web_") || tool === "image_view" || tool.startsWith("image_")
}

function isDelegating(state: AgentRoomState): boolean {
  const tool = state.currentTool
  return Boolean(tool && (tool.startsWith("subagent_") || tool.startsWith("clone_")) && state.station === "agents" && state.mode === "working")
}

function drawStationFocus(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  if (!state.currentTool) return
  const station = STATIONS[state.targetStation]
  const size = gridToPixel(ROOM_LAYOUT.stationFocusSize)
  ctx.fillStyle = "rgba(255,255,255,0.08)"
  ctx.fillRect(station.x - size / 2, station.y - size / 2, size, size)
}

function drawAsset(ctx: CanvasRenderingContext2D, path: string, x: number, y: number, scale = 1): void {
  const image = getImage(path)
  if (!isReady(image)) return
  ctx.drawImage(image, x, y, image.naturalWidth * scale, image.naturalHeight * scale)
}

function drawFurnitureItems(ctx: CanvasRenderingContext2D, items: readonly RoomFurnitureItem[]): void {
  for (const item of items) {
    const path = ROOM_ASSETS[item.asset]
    const x = gridToPixel(item.x)
    const y = gridToPixel(item.y)
    if (item.mirror) drawAssetMirrored(ctx, path, x, y, PIXEL_SCALE)
    else drawAsset(ctx, path, x, y, PIXEL_SCALE)
  }
}

function drawAssetMirrored(ctx: CanvasRenderingContext2D, path: string, x: number, y: number, scale = 1): void {
  const image = getImage(path)
  if (!isReady(image)) return
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  ctx.save()
  ctx.translate(x + width, y)
  ctx.scale(-1, 1)
  ctx.drawImage(image, 0, 0, width, height)
  ctx.restore()
}

function getImage(path: string): HTMLImageElement {
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
