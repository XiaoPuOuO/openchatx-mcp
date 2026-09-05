import { useEffect, useRef } from "react"

import type { Agent } from "../types"
import {
  createAgentRoomState,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  startAgentRoomLoop,
  STATIONS,
  syncAgentActivities,
  updateAgentRoom,
  type AgentRoomState,
} from "../game/agentRoomEngine"

const CHAR_FRAME_WIDTH = 16
const CHAR_FRAME_HEIGHT = 32
const PIXEL_SCALE = 2

const ASSETS = {
  floor: "/ui/pixel-agents/floors/floor_5.png",
  desk: "/ui/pixel-agents/furniture/DESK/DESK_FRONT.png",
  pc1: "/ui/pixel-agents/furniture/PC/PC_FRONT_ON_1.png",
  pc2: "/ui/pixel-agents/furniture/PC/PC_FRONT_ON_2.png",
  pc3: "/ui/pixel-agents/furniture/PC/PC_FRONT_ON_3.png",
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
  const wallHeight = 64
  ctx.fillStyle = "#26394d"
  ctx.fillRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)

  const floor = getImage(ASSETS.floor)
  if (isReady(floor)) {
    const size = 16 * PIXEL_SCALE
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

  drawRug(ctx, 18, 214, 154, 68, "#466b64", "#2f4a46")
  drawRug(ctx, 304, 208, 126, 70, "#4b7190", "#334e65")
}

function drawRoomBorder(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#111923"
  ctx.fillRect(0, 0, ROOM_WIDTH, 5)
  ctx.fillRect(0, ROOM_HEIGHT - 5, ROOM_WIDTH, 5)
  ctx.fillRect(0, 0, 5, ROOM_HEIGHT)
  ctx.fillRect(ROOM_WIDTH - 5, 0, 5, ROOM_HEIGHT)
}

function drawRug(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  border: string
): void {
  ctx.fillStyle = border
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = fill
  ctx.fillRect(x + 4, y + 4, width - 8, height - 8)
}

function drawWallDecor(ctx: CanvasRenderingContext2D): void {
  drawAsset(ctx, ASSETS.hangingPlant, 8, 6, 2)
  drawAsset(ctx, ASSETS.painting, 48, 4, 2)
  drawAsset(ctx, ASSETS.smallPainting, 132, 4, 2)
  drawAsset(ctx, ASSETS.clock, ROOM_WIDTH / 2 - 16, 4, 2)
  drawAsset(ctx, ASSETS.doubleBookshelf, 336, 4, 2)
  drawAssetMirrored(ctx, ASSETS.hangingPlant, 408, 6, 2)
}

function drawBackFurniture(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  drawImageStation(ctx)
  drawWebStation(ctx)
  drawShellStationBack(ctx, state)
  drawHomeStation(ctx)
  drawPatchStationBack(ctx)
  drawAgentsStation(ctx)
  drawLounge(ctx)
}

function drawImageStation(ctx: CanvasRenderingContext2D): void {
  // The wall painting itself is the visual target for image inspection.
}

function drawWebStation(ctx: CanvasRenderingContext2D): void {
  const station = STATIONS.web
  drawAsset(ctx, ASSETS.plant, station.x + 24, station.y - 20, 2)
}

function drawShellStationBack(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  const station = STATIONS.terminal
  drawPc(ctx, station.x - 16, station.y - 76, state)
  drawAsset(ctx, ASSETS.desk, station.x - 48, station.y - 64, 2)
}

function drawHomeStation(ctx: CanvasRenderingContext2D): void {
  const station = STATIONS.home
  drawAsset(ctx, ASSETS.cushionedChairSide, station.x - 16, station.y - 4, 2)
  drawAsset(ctx, ASSETS.smallTableSide, station.x + 22, station.y - 86, 2)
  drawAsset(ctx, ASSETS.pcSide, station.x + 22, station.y - 72, 2)
  drawAsset(ctx, ASSETS.plant, station.x + 55, station.y - 72, 2)
}

function drawPatchStationBack(ctx: CanvasRenderingContext2D): void {
  const station = STATIONS.patch
  drawAsset(ctx, ASSETS.whiteboard, station.x - 32, station.y - 90, 2)
  drawAsset(ctx, ASSETS.smallTable, station.x - 32, station.y - 48, 2)
}

function drawAgentsStation(ctx: CanvasRenderingContext2D): void {
  const station = STATIONS.agents
  drawAsset(ctx, ASSETS.cushionedChairSide, station.x - 16, station.y - 4, 2)
  drawAssetMirrored(ctx, ASSETS.cushionedChairSide, station.x + 48, station.y - 4, 2)
  drawAsset(ctx, ASSETS.coffeeTable, station.x + 8, station.y - 16, 1)
  drawAsset(ctx, ASSETS.coffee, station.x + 16, station.y - 12, 1)
}

function drawLounge(ctx: CanvasRenderingContext2D): void {
  drawAsset(ctx, ASSETS.sofa, 326, 236, 2)
  drawAsset(ctx, ASSETS.coffeeTable, 352, 214, 1)
  drawAsset(ctx, ASSETS.coffee, 360, 218, 1)
  drawAsset(ctx, ASSETS.largePlant, 396, 198, 2)
}

function drawForegroundFurniture(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  if (state.station === "terminal" && state.mode === "working") {
    const station = STATIONS.terminal
    drawAsset(ctx, ASSETS.desk, station.x - 48, station.y - 64, 2)
  }

  if (state.station === "patch" && state.mode === "working") {
    const station = STATIONS.patch
    drawAsset(ctx, ASSETS.smallTable, station.x - 32, station.y - 48, 2)
  }
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
    (state.mode === "idle" && state.station === "home") || delegating ? 6 * PIXEL_SCALE : 0
  const y = Math.round(state.y) + sittingOffset
  drawCharacterFrame(ctx, character, frame, row, x, y, state.direction)
}

function drawSubagentConversation(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string): void {
  const station = STATIONS.agents
  const subagent = getImage(`/ui/pixel-agents/characters/char_${(characterIndex(agentId) + 1) % 6}.png`)
  if (!isReady(subagent)) return

  const x = station.x + 64
  const y = station.y + 6 * PIXEL_SCALE
  const frame = 1
  drawCharacterFrame(ctx, subagent, frame, 2, x, y, "left")
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
  return Boolean(
    tool &&
      (tool.startsWith("subagent_") || tool.startsWith("clone_")) &&
      state.station === "agents" &&
      state.mode === "working"
  )
}

function drawPc(ctx: CanvasRenderingContext2D, x: number, y: number, state: AgentRoomState): void {
  const frames = [ASSETS.pc1, ASSETS.pc2, ASSETS.pc3]
  drawAsset(ctx, frames[Math.floor(state.workFrame) % frames.length], x, y, 2)
}

function drawStationFocus(ctx: CanvasRenderingContext2D, state: AgentRoomState): void {
  if (!state.currentTool) return
  const station = STATIONS[state.targetStation]
  ctx.fillStyle = "rgba(255,255,255,0.08)"
  ctx.fillRect(station.x - 28, station.y - 24, 56, 32)
}

function drawAsset(ctx: CanvasRenderingContext2D, path: string, x: number, y: number, scale = 1): void {
  const image = getImage(path)
  if (!isReady(image)) return
  ctx.drawImage(image, x, y, image.naturalWidth * scale, image.naturalHeight * scale)
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
