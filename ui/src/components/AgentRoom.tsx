import { useEffect, useRef } from "react"

import type { Agent } from "../types"
import {
  createAgentRoomState,
  startAgentRoomLoop,
  stationsForLayout,
  syncAgentActivities,
  updateAgentRoom,
  type AgentRoomState,
  type AgentStationMap,
} from "../game/agentRoomEngine"
import {
  gridToPixel,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type RoomLayout,
} from "../game/agentRoomLayout"
import {
  drawRoomBorder,
  drawRoomForeground,
  drawRoomFurnitureItems,
  drawRoomPets,
  drawRoomSurface,
  drawRoomWalls,
  getRoomImage,
  ROOM_PIXEL_SCALE,
} from "../game/agentRoomRenderer"
import { useRoomLayout } from "../game/roomLayoutStorage"

const CHAR_FRAME_WIDTH = 16
const CHAR_FRAME_HEIGHT = 32
const SITTING_OFFSET = gridToPixel(1.5)

export function AgentRoom({ agent }: { agent: Agent }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<AgentRoomState>(createAgentRoomState())
  const layout = useRoomLayout()

  useEffect(() => {
    syncAgentActivities(stateRef.current, agent)
  }, [agent])

  useEffect(() => {
    stateRef.current = createAgentRoomState(stationsForLayout(layout))
    syncAgentActivities(stateRef.current, agent)
  }, [layout])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const stations = stationsForLayout(layout)
    return startAgentRoomLoop(canvas, {
      update: (dt) => updateAgentRoom(stateRef.current, dt, reducedMotion, stations),
      render: (ctx) => renderRoom(ctx, stateRef.current, agent.id, layout, stations),
    })
  }, [agent.id, layout])

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

function renderRoom(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string, layout: RoomLayout, stations: AgentStationMap): void {
  ctx.clearRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT)
  drawRoomSurface(ctx, layout)
  drawRoomWalls(ctx, layout)
  drawRoomFurnitureItems(ctx, layout.wallDecor)
  drawStationFocus(ctx, state, layout, stations)
  drawRoomFurnitureItems(ctx, layout.furniture)
  drawRoomPets(ctx, layout.pets)
  drawCharacter(ctx, state, agentId, layout)
  const delegating = isDelegating(state)
  if (delegating) drawSubagentConversation(ctx, state, agentId, layout, stations)
  if (state.mode === "working") drawRoomForeground(ctx, layout, state.station)
  if (state.bubble && !delegating) drawSpeechBubble(ctx, state.x, state.y, state.bubble)
  drawRoomBorder(ctx)
}

function drawCharacter(ctx: CanvasRenderingContext2D, state: AgentRoomState, agentId: string, layout: RoomLayout): void {
  const character = getRoomImage(layout.characterAsset ?? `/ui/pixel-agents/assets/characters/char_${characterIndex(agentId)}.png`)
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

function drawSubagentConversation(
  ctx: CanvasRenderingContext2D,
  state: AgentRoomState,
  agentId: string,
  layout: RoomLayout,
  stations: AgentStationMap
): void {
  const subagent = getRoomImage(`/ui/pixel-agents/assets/characters/char_${(characterIndex(agentId) + 1) % 6}.png`)
  if (!isReady(subagent)) return

  const x = gridToPixel(layout.subagentSeat.x)
  const y = gridToPixel(layout.subagentSeat.y) + SITTING_OFFSET
  const frame = 1
  drawCharacterFrame(ctx, subagent, frame, 2, x, y, layout.subagentSeat.facing)
  const station = stations.agents
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
  const destWidth = CHAR_FRAME_WIDTH * ROOM_PIXEL_SCALE
  const destHeight = CHAR_FRAME_HEIGHT * ROOM_PIXEL_SCALE

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

function drawStationFocus(ctx: CanvasRenderingContext2D, state: AgentRoomState, layout: RoomLayout, stations: AgentStationMap): void {
  if (!state.currentTool) return
  const station = stations[state.targetStation]
  const size = gridToPixel(layout.stationFocusSize)
  ctx.fillStyle = "rgba(255,255,255,0.08)"
  ctx.fillRect(station.x - size / 2, station.y - size / 2, size, size)
}

function isReady(image: HTMLImageElement): boolean {
  return image.complete && image.naturalWidth > 0
}
