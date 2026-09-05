// Game-loop structure adapted from Pixel Agents (MIT).
// See ui/THIRD_PARTY_NOTICES.md.

import type { Agent, AgentCall } from "../types"
import { gridToPixel, ROOM_LAYOUT, type RoomDirection, type RoomStation } from "./agentRoomLayout"

export type AgentStation = RoomStation
export type AgentDirection = RoomDirection

type RoomMode = "idle" | "walking" | "working"

interface QueuedActivity {
  id: string
  tool: string
  running: boolean
}

export interface AgentRoomState {
  x: number
  y: number
  mode: RoomMode
  station: AgentStation
  targetStation: AgentStation
  currentTool?: string
  bubble?: string
  walkFrame: number
  workFrame: number
  direction: AgentDirection
  queue: QueuedActivity[]
  activeActivity?: QueuedActivity
  activeElapsed: number
  returningHome: boolean
  seenCallIds: Set<string>
  activityQueueInitialized: boolean
}

function station(layout: { x: number; y: number; label: string; facing: AgentDirection }) {
  return { ...layout, x: gridToPixel(layout.x), y: gridToPixel(layout.y) }
}

export const STATIONS: Record<AgentStation, { x: number; y: number; label: string; facing: AgentDirection }> = {
  home: station(ROOM_LAYOUT.stations.home),
  terminal: station(ROOM_LAYOUT.stations.terminal),
  patch: station(ROOM_LAYOUT.stations.patch),
  web: station(ROOM_LAYOUT.stations.web),
  image: station(ROOM_LAYOUT.stations.image),
  agents: station(ROOM_LAYOUT.stations.agents),
}

const WALK_SPEED = 86
const MAX_DELTA_TIME_SEC = 0.1
const MIN_ACTIVITY_DURATION_SEC = 3

export function createAgentRoomState(): AgentRoomState {
  const home = STATIONS.home
  return {
    x: home.x,
    y: home.y,
    mode: "idle",
    station: "home",
    targetStation: "home",
    walkFrame: 0,
    workFrame: 0,
    direction: home.facing,
    queue: [],
    activeElapsed: 0,
    returningHome: false,
    seenCallIds: new Set(),
    activityQueueInitialized: false,
  }
}

export function syncAgentActivities(state: AgentRoomState, agent: Agent): void {
  const calls = [...agent.recent, ...(agent.current ? [agent.current] : [])]

  for (const call of calls) updateKnownActivity(state, call)

  if (!state.activityQueueInitialized) {
    for (const call of agent.recent) state.seenCallIds.add(call.id)
    state.activityQueueInitialized = true
    if (agent.current) enqueueActivity(state, agent.current)
    return
  }

  const unseen = calls.filter((call) => !state.seenCallIds.has(call.id)).sort((a, b) => a.startedAt - b.startedAt)

  for (const call of unseen) enqueueActivity(state, call)
}

export function updateAgentRoom(state: AgentRoomState, dt: number, reducedMotion = false): void {
  const clampedDt = Math.min(dt, MAX_DELTA_TIME_SEC)

  if (!state.activeActivity && state.queue.length > 0 && state.station === "home") {
    startNextActivity(state)
  }

  if (state.activeActivity) {
    if (!state.returningHome) {
      const target = STATIONS[state.targetStation]
      if (state.mode === "walking") {
        moveToward(state, target.x, target.y, reducedMotion ? Number.POSITIVE_INFINITY : WALK_SPEED * clampedDt)
        state.walkFrame += clampedDt * 8
        if (distance(state.x, state.y, target.x, target.y) < 0.5) {
          state.x = target.x
          state.y = target.y
          state.station = state.targetStation
          state.mode = "working"
          state.direction = target.facing
          state.bubble = bubbleForTool(state.activeActivity.tool)
          state.workFrame = 0
          state.activeElapsed = 0
        }
        return
      }

      state.mode = "working"
      state.activeElapsed += clampedDt
      state.workFrame += clampedDt * 5
      if (state.activeElapsed >= MIN_ACTIVITY_DURATION_SEC && !state.activeActivity.running) {
        state.returningHome = true
        state.currentTool = undefined
        state.bubble = undefined
        state.mode = "walking"
        state.targetStation = "home"
      }
      return
    }

    const home = STATIONS.home
    moveToward(state, home.x, home.y, reducedMotion ? Number.POSITIVE_INFINITY : WALK_SPEED * clampedDt)
    state.walkFrame += clampedDt * 8
    if (distance(state.x, state.y, home.x, home.y) < 0.5) finishActivity(state)
    return
  }

  state.bubble = undefined
  const home = STATIONS.home
  if (distance(state.x, state.y, home.x, home.y) > 0.5) {
    state.mode = "walking"
    state.targetStation = "home"
    moveToward(state, home.x, home.y, reducedMotion ? Number.POSITIVE_INFINITY : WALK_SPEED * clampedDt)
    state.walkFrame += clampedDt * 8
    if (distance(state.x, state.y, home.x, home.y) < 0.5) {
      state.x = home.x
      state.y = home.y
      state.station = "home"
      state.mode = "idle"
      state.direction = home.facing
    }
    return
  }

  state.station = "home"
  state.targetStation = "home"
  state.mode = "idle"
  state.direction = home.facing
}

function enqueueActivity(state: AgentRoomState, call: AgentCall): void {
  state.seenCallIds.add(call.id)
  state.queue.push({
    id: call.id,
    tool: call.tool,
    running: call.status === "running",
  })
}

function updateKnownActivity(state: AgentRoomState, call: AgentCall): void {
  if (state.activeActivity?.id === call.id) {
    state.activeActivity.running = call.status === "running"
    return
  }

  const queued = state.queue.find((activity) => activity.id === call.id)
  if (queued) queued.running = call.status === "running"
}

function startNextActivity(state: AgentRoomState): void {
  const activity = state.queue.shift()
  if (!activity) return

  state.activeActivity = activity
  state.activeElapsed = 0
  state.returningHome = false
  state.currentTool = activity.tool
  state.targetStation = stationForTool(activity.tool)
  state.bubble = undefined
  state.mode = "walking"
}

function finishActivity(state: AgentRoomState): void {
  const home = STATIONS.home
  state.x = home.x
  state.y = home.y
  state.station = "home"
  state.targetStation = "home"
  state.mode = "idle"
  state.direction = home.facing
  state.currentTool = undefined
  state.bubble = undefined
  state.activeActivity = undefined
  state.activeElapsed = 0
  state.returningHome = false
}

export function startAgentRoomLoop(
  canvas: HTMLCanvasElement,
  callbacks: { update: (dt: number) => void; render: (ctx: CanvasRenderingContext2D) => void }
): () => void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return () => undefined
  ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let frameId = 0
  let stopped = false

  const frame = (time: number) => {
    if (stopped) return
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time
    callbacks.update(dt)
    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)
    frameId = requestAnimationFrame(frame)
  }

  frameId = requestAnimationFrame(frame)
  return () => {
    stopped = true
    cancelAnimationFrame(frameId)
  }
}

export function stationForTool(tool: string): AgentStation {
  if (tool === "apply_patch") return "patch"
  if (tool === "fetch_url" || tool.startsWith("web_")) return "web"
  if (tool === "image_view" || tool.startsWith("image_")) return "image"
  if (tool.startsWith("subagent_") || tool.startsWith("clone_")) return "agents"
  return "terminal"
}

export function bubbleForTool(tool: string): string {
  if (tool === "apply_patch") return "Applying patch..."
  if (tool === "fetch_url" || tool.startsWith("web_")) return "Browsing..."
  if (tool === "image_view" || tool.startsWith("image_")) return "Viewing image..."
  if (tool.startsWith("subagent_") || tool.startsWith("clone_")) return "Delegating..."
  if (tool === "shell_poll") return "Waiting on shell..."
  if (tool.startsWith("shell_")) return "Running command..."
  return tool.replaceAll("_", " ")
}

function moveToward(state: AgentRoomState, targetX: number, targetY: number, maxDistance: number): void {
  const dx = targetX - state.x
  const dy = targetY - state.y
  const length = Math.hypot(dx, dy)
  if (Math.abs(dx) >= Math.abs(dy)) state.direction = dx >= 0 ? "right" : "left"
  else state.direction = dy >= 0 ? "down" : "up"
  if (length === 0 || maxDistance >= length) {
    state.x = targetX
    state.y = targetY
    return
  }
  state.x += (dx / length) * maxDistance
  state.y += (dy / length) * maxDistance
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1)
}
