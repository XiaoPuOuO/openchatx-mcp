import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { asRecord, booleanValue, finiteNumber as numberValue } from "../../utils.js"
import {
  type PeekabooClient,
  PeekabooError,
  type PeekabooObservation,
  type PeekabooResult,
  type PeekabooSnapshotTarget,
} from "./peekaboo.js"

const appInput = z.string().min(1).describe("App name, bundle ID, or PID:12345.")
const snapshotInput = z
  .string()
  .min(1)
  .describe("Snapshot ID from computer_observe or computer_inspect.")
const windowIdInput = z.number().int().positive().describe("Window ID from computer_list.")
const KEY_TOKEN_PATTERN = /^[A-Za-z0-9_]+$/u

const targetFields = {
  app: appInput.optional(),
  window_id: windowIdInput.optional(),
  snapshot_id: snapshotInput.optional(),
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Registration stays together so shared schemas and tool contracts remain locally auditable.
export function registerComputerUseTools(server: McpServer, peekaboo: PeekabooClient): void {
  const listSchema = z.object({
    kind: z.enum(["apps", "windows", "screens", "permissions"]).default("apps"),
    app: appInput.optional().describe("App whose windows to list."),
    include_hidden: z.boolean().optional(),
    include_background: z.boolean().optional(),
  })

  server.registerTool(
    "computer_list",
    {
      description: "List apps, windows, screens, or permission status.",
      inputSchema: listSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ kind, app, include_hidden, include_background }, ctx) => {
      let args: string[]
      if (kind === "apps") {
        args = ["app", "list"]
        if (include_hidden) args.push("--include-hidden")
        if (include_background) args.push("--include-background")
      } else if (kind === "windows") {
        if (!app) throw new Error("app is required when kind is windows")
        args = ["window", "list", "--app", app]
      } else if (kind === "screens") {
        args = ["screen", "list"]
      } else {
        args = ["permissions", "status", "--all-sources"]
      }
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Listed computer ${kind}.`)
    }
  )

  const observeSchema = z
    .object({
      app: appInput.optional(),
      window_id: windowIdInput.optional(),
      screen_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Display index. Omit for the frontmost window."),
      annotate: z.boolean().default(false).describe("Overlay element IDs."),
    })
    .superRefine((value, context) => {
      if (
        value.screen_index !== undefined &&
        (value.app !== undefined || value.window_id !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "screen_index cannot be combined with app or window_id.",
        })
      }
    })

  server.registerTool(
    "computer_observe",
    {
      description:
        "Capture a screenshot and snapshot ID for an app, window, screen, or the frontmost window. Observe again after the UI changes.",
      inputSchema: observeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ app, window_id, screen_index, annotate }, ctx) => {
      const args: string[] = []
      if (screen_index !== undefined) {
        args.push("--mode", "screen", "--screen-index", String(screen_index))
      } else {
        if (app !== undefined) args.push("--app", app)
        if (window_id !== undefined) args.push("--window-id", String(window_id))
        if (app === undefined && window_id === undefined) args.push("--mode", "frontmost")
      }
      args.push("--no-web-focus")

      try {
        const observation = await peekaboo.observe(args, { annotate }, ctx.mcpReq.signal)
        return observationResult(observation)
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  server.registerTool(
    "computer_inspect",
    {
      description:
        "Inspect an observed snapshot for accessible elements. Use the returned snapshot_id with its element IDs.",
      inputSchema: z.object({
        snapshot_id: snapshotInput,
        max_depth: z.number().int().min(1).max(20).default(8),
        max_elements: z.number().int().min(1).max(500).default(100),
        max_children: z.number().int().min(1).max(100).default(25),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ snapshot_id, max_depth, max_elements, max_children }, ctx) => {
      try {
        const target = requireSnapshotTarget(peekaboo, snapshot_id)
        const args = ["see"]
        addObservationTargetArgs(args, target)
        args.push(
          "--tree",
          "--no-screenshot",
          "--depth",
          String(max_depth),
          "--max-elements",
          String(max_elements),
          "--max-children",
          String(max_children)
        )
        const result = await peekaboo.run(args, ctx.mcpReq.signal)
        const inspectedSnapshotId = stringValue(asRecord(result.data)?.snapshot_id)
        if (inspectedSnapshotId) peekaboo.rememberSnapshotTarget(inspectedSnapshotId, target)
        return inspectionResult(result)
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  const clickSchema = z
    .object({
      snapshot_id: snapshotInput,
      element_id: z.string().min(1).optional(),
      query: z.string().min(1).optional().describe("Visible label or text."),
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_count: z.number().int().min(1).max(3).optional(),
      long_press: z.boolean().optional(),
      foreground: z.boolean().optional().describe("Use the physical pointer."),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
    })
    .superRefine((value, context) => {
      const hasCoordinates = value.x !== undefined && value.y !== undefined
      if ((value.x === undefined) !== (value.y === undefined)) {
        context.addIssue({
          code: "custom",
          message: "x and y must be supplied together.",
        })
      }
      const targetCount = [value.element_id, value.query, hasCoordinates ? true : undefined].filter(
        (item) => item !== undefined
      ).length
      if (targetCount !== 1) {
        context.addIssue({
          code: "custom",
          message: "Supply exactly one target: element_id, query, or x and y.",
        })
      }
      if (
        value.long_press &&
        ((value.button !== undefined && value.button !== "left") ||
          (value.click_count !== undefined && value.click_count !== 1))
      ) {
        context.addIssue({
          code: "custom",
          message: "long_press cannot be combined with a non-left button or multi-click.",
        })
      }
      if (
        value.button !== undefined &&
        value.button !== "left" &&
        value.click_count !== undefined &&
        value.click_count !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "right and middle buttons cannot be combined with double- or triple-click.",
        })
      }
    })

  server.registerTool(
    "computer_click",
    {
      description: "Click an element, visible text, or coordinates from a snapshot.",
      inputSchema: clickSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Click dispatch mirrors the mutually exclusive target modes in the public tool schema.
    async (input, ctx) => {
      const args = ["click"]
      let forceForeground = false
      let localExactWindowTarget: Pick<PeekabooSnapshotTarget, "app" | "windowId"> | undefined
      if (input.element_id) {
        args.push("--on", input.element_id, "--snapshot", input.snapshot_id)
      } else if (input.query) {
        args.push(input.query, "--snapshot", input.snapshot_id)
      } else {
        try {
          const target = requireSnapshotTarget(peekaboo, input.snapshot_id)
          if (input.x === undefined || input.y === undefined) {
            throw new PeekabooError("INVALID_TARGET", "Coordinate clicks require both x and y.")
          }
          const coordinates = clickCoordinates(target, input.x, input.y)
          args.push("--at", `${coordinates.x},${coordinates.y}`)
          addSnapshotTargetArgs(args, target)
          const exactWindowTarget =
            target.windowId !== undefined &&
            !(target.kind?.toLowerCase().includes("screen") ?? false)
          if (exactWindowTarget) {
            if (!input.foreground) localExactWindowTarget = target
          } else {
            forceForeground = true
          }
          if (coordinates.global) {
            args.push("--global")
          }
        } catch (error) {
          return peekabooToolError(error)
        }
      }
      if (input.button === "right") args.push("--right")
      if (input.button === "middle") args.push("--middle")
      if (input.click_count === 2) args.push("--double")
      if (input.click_count === 3) args.push("--triple")
      if (input.long_press) args.push("--long-press")
      if (input.foreground || forceForeground) {
        args.push("--foreground")
      }
      if (input.wait_ms !== undefined) args.push("--wait-for", String(input.wait_ms))
      if (localExactWindowTarget) {
        try {
          const result = await peekaboo.runWithFreshLocalWindowSnapshot(
            localExactWindowTarget,
            args,
            ctx.mcpReq.signal
          )
          return commandResult(result, "Click completed.")
        } catch (error) {
          return peekabooToolError(error)
        }
      }
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Click completed.")
    }
  )

  const typeSchema = z
    .object({
      ...targetFields,
      text: z.string().min(1),
      clear: z.boolean().optional(),
      press_return: z.boolean().optional(),
      foreground: z.boolean().optional(),
      delay_ms: z.number().int().min(0).max(1_000).optional(),
    })
    .superRefine((value, context) => {
      if (
        !value.foreground &&
        value.app === undefined &&
        value.window_id === undefined &&
        value.snapshot_id === undefined
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Background typing requires app, window_id, or snapshot_id; otherwise set foreground=true.",
        })
      }
    })

  server.registerTool(
    "computer_type",
    {
      description: "Type text into an app, window, or snapshot.",
      inputSchema: typeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      const args = ["type", "--text", input.press_return ? `${input.text}\n` : input.text]
      addTargetArgs(args, input)
      if (input.clear) args.push("--clear")
      if (input.foreground) args.push("--foreground")
      if (input.delay_ms !== undefined) args.push("--delay", String(input.delay_ms))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Typing completed.")
    }
  )

  const keyToken = z
    .string()
    .regex(KEY_TOKEN_PATTERN)
    .describe("Key such as return, tab, escape, cmd, shift, or a letter.")

  const pressSchema = z
    .object({
      ...targetFields,
      keys: z.array(keyToken).min(1).max(16),
      count: z.number().int().min(1).max(100).optional(),
      foreground: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (!value.foreground && value.window_id === undefined && value.snapshot_id === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Background key presses require an exact window_id or fresh snapshot_id; app-only and targetless presses require foreground=true.",
        })
      }
    })

  server.registerTool(
    "computer_press",
    {
      description: "Press keys sequentially. Use computer_hotkey for simultaneous shortcuts.",
      inputSchema: pressSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      const args = ["press", ...input.keys]
      addTargetArgs(args, input)
      if (input.count !== undefined) args.push("--count", String(input.count))
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Key press completed.")
    }
  )

  const hotkeySchema = z
    .object({
      ...targetFields,
      keys: z.array(keyToken).min(1).max(8),
      foreground: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (!value.foreground && value.window_id === undefined && value.snapshot_id === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Background hotkeys require an exact window_id or fresh snapshot_id; app-only and targetless hotkeys require foreground=true.",
        })
      }
    })

  server.registerTool(
    "computer_hotkey",
    {
      description: "Press a keyboard shortcut. Use computer_press for sequential keys.",
      inputSchema: hotkeySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      const args = ["press", input.keys.join("+")]
      addTargetArgs(args, input)
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Shortcut completed.")
    }
  )

  const scrollSchema = z
    .object({
      ...targetFields,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(100).optional(),
      element_id: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      smooth: z.boolean().optional(),
      foreground: z.boolean().optional().describe("Scroll at the current pointer."),
    })
    .superRefine((value, context) => {
      const hasCoordinates = value.x !== undefined && value.y !== undefined
      const hasBackgroundTarget = hasScrollBackgroundTarget(value, hasCoordinates)
      if ((value.x === undefined) !== (value.y === undefined)) {
        context.addIssue({ code: "custom", message: "x and y must be supplied together." })
      }
      if (value.element_id && hasCoordinates) {
        context.addIssue({ code: "custom", message: "Supply element_id or x and y, not both." })
      }
      if (value.element_id && !value.snapshot_id) {
        context.addIssue({
          code: "custom",
          message: "snapshot_id is required when element_id is supplied.",
        })
      }
      if (hasCoordinates && !value.snapshot_id) {
        context.addIssue({
          code: "custom",
          message: "snapshot_id is required for background coordinate scrolling.",
        })
      }
      if (!value.element_id && !hasCoordinates && !value.foreground) {
        context.addIssue({
          code: "custom",
          message: "Supply element_id or x and y for background scrolling, or set foreground=true.",
        })
      }
      if (value.foreground && hasBackgroundTarget) {
        context.addIssue({
          code: "custom",
          message: "foreground pointer scrolling cannot be combined with a background target.",
        })
      }
      if (value.smooth && !value.foreground) {
        context.addIssue({
          code: "custom",
          message: "smooth scrolling requires foreground=true.",
        })
      }
    })

  async function scrollAtCoordinates(
    input: z.infer<typeof scrollSchema>,
    args: string[],
    signal: AbortSignal
  ): Promise<CallToolResult> {
    try {
      if (!input.snapshot_id) {
        throw new PeekabooError(
          "SNAPSHOT_TARGET_MISSING",
          "Background coordinate scrolling requires a snapshot ID."
        )
      }
      const target = requireSnapshotTarget(peekaboo, input.snapshot_id)
      const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
      if (screenCapture || target.windowId === undefined) {
        throw new PeekabooError(
          "EXACT_WINDOW_REQUIRED",
          "Background coordinate scrolling requires an exact window observation."
        )
      }
      args.push("--at", `${input.x},${input.y}`, "--window-id", String(target.windowId))
      if (input.smooth) args.push("--smooth")
      const result = await peekaboo.runWithFreshLocalWindowSnapshot(target, args, signal)
      return commandResult(result, "Scroll completed.")
    } catch (error) {
      return peekabooToolError(error)
    }
  }

  server.registerTool(
    "computer_scroll",
    {
      description:
        "Scroll an element or screenshot coordinate in the background, or set foreground=true to use the physical pointer.",
      inputSchema: scrollSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      const args = ["scroll", "--direction", input.direction]
      if (input.amount !== undefined) args.push("--amount", String(input.amount))
      if (input.element_id) {
        args.push("--on", input.element_id)
        addTargetArgs(args, input)
      }
      if (input.x !== undefined && input.y !== undefined) {
        return scrollAtCoordinates(input, args, ctx.mcpReq.signal)
      }
      if (input.smooth) args.push("--smooth")
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Scroll completed.")
    }
  )

  const dragPoint = z.object({ x: z.number(), y: z.number() }).strict()
  const dragSchema = z
    .object({
      snapshot_id: snapshotInput,
      from: dragPoint,
      to: dragPoint,
      duration_ms: z.number().int().min(50).max(10_000).optional(),
      steps: z.number().int().min(2).max(96).optional(),
    })
    .strict()

  server.registerTool(
    "computer_drag",
    {
      description:
        "Drag between coordinates inside one exact observed window without moving the physical pointer.",
      inputSchema: dragSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      let target: PeekabooSnapshotTarget
      try {
        target = requireSnapshotTarget(peekaboo, input.snapshot_id)
      } catch (error) {
        return peekabooToolError(error)
      }

      try {
        const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
        if (screenCapture || target.windowId === undefined) {
          throw new PeekabooError(
            "EXACT_WINDOW_REQUIRED",
            "Background dragging requires an exact window observation."
          )
        }
        const args = [
          "drag",
          "--from",
          `${input.from.x},${input.from.y}`,
          "--to",
          `${input.to.x},${input.to.y}`,
          "--window-id",
          String(target.windowId),
        ]
        if (input.duration_ms !== undefined) args.push("--duration", String(input.duration_ms))
        if (input.steps !== undefined) args.push("--steps", String(input.steps))

        const result = await peekaboo.runWithFreshLocalWindowSnapshot(
          target,
          args,
          ctx.mcpReq.signal
        )
        return commandResult(result, "Drag completed.")
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  const appSchema = z
    .object({
      action: z.enum(["launch", "switch", "quit", "relaunch", "hide", "unhide"]),
      app: appInput,
      open: z.array(z.string().min(1)).max(10).default([]).describe("Files or URLs to open."),
      force: z.boolean().default(false).describe("Force quit when quitting or relaunching."),
    })
    .superRefine((value, context) => {
      if (value.open.length > 0 && value.action !== "launch") {
        context.addIssue({
          code: "custom",
          message: "open is valid only for launch.",
        })
      }
      if (value.force && value.action !== "quit" && value.action !== "relaunch") {
        context.addIssue({
          code: "custom",
          message: "force is valid only for quit or relaunch.",
        })
      }
    })

  server.registerTool(
    "computer_app",
    {
      description: "Launch, switch to, quit, relaunch, hide, or unhide an app.",
      inputSchema: appSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, app, open, force }, ctx) => {
      const args = appCommandArgs(action, app, open, force)
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Application ${action} completed.`)
    }
  )

  const windowSchema = z
    .object({
      action: z.enum([
        "focus",
        "close",
        "minimize",
        "restore",
        "maximize",
        "move",
        "resize",
        "set_bounds",
      ]),
      app: appInput.optional(),
      window_id: windowIdInput.optional(),
      window_title: z.string().min(1).optional(),
      foreground: z
        .boolean()
        .optional()
        .describe("Allow focusing the window if needed to close it."),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .superRefine((value, context) => {
      if (value.app === undefined && value.window_id === undefined) {
        context.addIssue({
          code: "custom",
          message: "Supply at least one window anchor: app or window_id.",
        })
      }
      if (value.window_title && !value.app) {
        context.addIssue({
          code: "custom",
          message: "window_title requires app.",
        })
      }
      if (value.foreground && value.action !== "close") {
        context.addIssue({
          code: "custom",
          message: "foreground is valid only for close.",
        })
      }
      const requiredGeometry: Record<typeof value.action, Array<keyof typeof value>> = {
        focus: [],
        close: [],
        minimize: [],
        restore: [],
        maximize: [],
        move: ["x", "y"],
        resize: ["width", "height"],
        set_bounds: ["x", "y", "width", "height"],
      }
      const geometryFields = ["x", "y", "width", "height"] as const
      for (const field of requiredGeometry[value.action]) {
        if (value[field] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${String(field)} is required for ${value.action}.`,
          })
        }
      }
      for (const field of geometryFields) {
        if (value[field] !== undefined && !requiredGeometry[value.action].includes(field)) {
          context.addIssue({
            code: "custom",
            message: `${field} is not valid for ${value.action}.`,
          })
        }
      }
    })

  server.registerTool(
    "computer_window",
    {
      description: "Focus, close, minimize, restore, maximize, move, resize, or set window bounds.",
      inputSchema: windowSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      const subcommand = input.action === "set_bounds" ? "set-bounds" : input.action
      const args = ["window", subcommand]
      if (input.app) args.push("--app", input.app)
      if (input.window_id !== undefined) args.push("--window-id", String(input.window_id))
      if (input.window_title) args.push("--window-title", input.window_title)
      if (input.x !== undefined) args.push("--x", String(input.x))
      if (input.y !== undefined) args.push("--y", String(input.y))
      if (input.width !== undefined) args.push("--width", String(input.width))
      if (input.height !== undefined) args.push("--height", String(input.height))
      if (input.action === "focus") args.push("--verify")
      if (input.foreground) args.push("--foreground")
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, `Window ${input.action} completed.`)
    }
  )
}

function hasScrollBackgroundTarget(
  value: {
    element_id?: string
    app?: string
    window_id?: number
    snapshot_id?: string
  },
  hasCoordinates: boolean
): boolean {
  return (
    value.element_id !== undefined ||
    hasCoordinates ||
    value.app !== undefined ||
    value.window_id !== undefined ||
    value.snapshot_id !== undefined
  )
}

function addTargetArgs(
  args: string[],
  target: { app?: string; window_id?: number; snapshot_id?: string }
): void {
  if (target.app !== undefined) args.push("--app", target.app)
  if (target.window_id !== undefined) args.push("--window-id", String(target.window_id))
  if (target.snapshot_id !== undefined) args.push("--snapshot", target.snapshot_id)
}

function requireSnapshotTarget(
  peekaboo: PeekabooClient,
  snapshotId: string
): PeekabooSnapshotTarget {
  const target = peekaboo.getSnapshotTarget(snapshotId)
  if (target) return target
  throw new PeekabooError(
    "SNAPSHOT_TARGET_MISSING",
    "The observation target is no longer available. Call computer_observe again."
  )
}

function clickCoordinates(
  target: PeekabooSnapshotTarget,
  x: number,
  y: number
): { x: number; y: number; global: boolean } {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  const needsGlobalCoordinates = screenCapture || (target.windowId === undefined && !target.app)
  if (!needsGlobalCoordinates) return { x, y, global: false }
  if (!target.bounds) {
    throw new PeekabooError(
      "SNAPSHOT_BOUNDS_MISSING",
      "The observation bounds are unavailable. Call computer_observe again."
    )
  }
  return {
    x: x + target.bounds.x,
    y: y + target.bounds.y,
    global: true,
  }
}

function addSnapshotTargetArgs(args: string[], target: PeekabooSnapshotTarget): void {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  if (screenCapture) return
  if (target.windowId !== undefined) {
    args.push("--window-id", String(target.windowId))
  } else if (target.app) {
    args.push("--app", target.app)
  }
}

function addObservationTargetArgs(args: string[], target: PeekabooSnapshotTarget): void {
  const screenCapture = target.kind?.toLowerCase().includes("screen") ?? false
  if (screenCapture) {
    args.push("--mode", "screen", "--screen-index", String(target.screenIndex ?? 0))
  } else if (target.windowId !== undefined) {
    if (target.app) args.push("--app", target.app)
    args.push("--window-id", String(target.windowId))
  } else if (target.app && target.windowTitle) {
    args.push("--app", target.app, "--window-title", target.windowTitle)
  } else if (target.app) {
    args.push("--app", target.app)
  } else {
    args.push("--mode", "frontmost")
  }
}

function appCommandArgs(
  action: "launch" | "switch" | "quit" | "relaunch" | "hide" | "unhide",
  app: string,
  open: string[],
  force: boolean
): string[] {
  if (action === "launch") {
    const args = ["app", "launch", app, "--wait-ready", "--foreground"]
    for (const item of open) args.push("--open", item)
    return args
  }
  if (action === "switch") return ["app", "switch", "--to", app, "--verify"]
  if (action === "quit") {
    return ["app", "quit", "--app", app, ...(force ? ["--force"] : [])]
  }
  if (action === "relaunch") {
    return [
      "app",
      "relaunch",
      app,
      "--wait-until-ready",
      "--foreground",
      ...(force ? ["--force"] : []),
    ]
  }
  if (action === "unhide") return ["app", "unhide", "--app", app, "--activate"]
  return ["app", action, "--app", app]
}

async function callPeekaboo(
  peekaboo: PeekabooClient,
  args: string[],
  signal: AbortSignal,
  fallbackSummary: string
): Promise<CallToolResult> {
  try {
    return commandResult(await peekaboo.run(args, signal), fallbackSummary)
  } catch (error) {
    return peekabooToolError(error)
  }
}

function commandResult(result: PeekabooResult, fallbackSummary: string): CallToolResult {
  const summary =
    typeof result.summary === "string"
      ? result.summary
      : (result.messages?.find((message) => message.trim()) ?? fallbackSummary)
  const structuredContent = asStructuredContent(result.data)
  return {
    content: [{ type: "text", text: summary }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

function observationResult(observation: PeekabooObservation): CallToolResult {
  const data = asRecord(observation.data) ?? {}
  const application = stringValue(data.application_name)
  const windowTitle = stringValue(data.window_title)
  const structuredContent = omitUndefined({
    snapshot_id: stringValue(data.snapshot_id),
    application_name: application,
    window_title: windowTitle,
    is_dialog: booleanValue(data.is_dialog),
    capture_mode: stringValue(data.capture_mode),
    element_count: numberValue(data.element_count),
    interactable_count: numberValue(data.interactable_count),
  })
  const target = [application, windowTitle].filter(Boolean).join(" — ") || "computer"

  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: `Observed ${target}.`,
      },
      {
        type: "image",
        data: observation.imageData,
        mimeType: observation.mimeType,
      },
    ],
  }
}

function inspectionResult(result: PeekabooResult): CallToolResult {
  const data = asRecord(result.data)
  const snapshotId = stringValue(data?.snapshot_id)
  const embeddedText = Array.isArray(data?.content)
    ? data.content
        .map(asRecord)
        .map((item) => stringValue(item?.text))
        .find((value) => value !== undefined)
    : undefined
  const elements = Array.isArray(data?.ui_elements)
    ? data.ui_elements
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => {
          const id = stringValue(item.id)
          const role = stringValue(item.role) ?? stringValue(item.role_description) ?? "element"
          const label =
            stringValue(item.label) ?? stringValue(item.title) ?? stringValue(item.value)
          return `${id ? `[${id}] ` : ""}${role}${label ? ` ${JSON.stringify(label)}` : ""}`
        })
        .filter(Boolean)
    : []
  const text =
    stringValue(data?.text) ??
    embeddedText ??
    (elements.length ? elements.join("\n") : undefined) ??
    (typeof result.summary === "string" ? result.summary : undefined) ??
    result.messages?.find((message) => message.trim()) ??
    "Inspected accessible UI."
  return {
    content: [{ type: "text", text: snapshotId ? `snapshot_id=${snapshotId}\n${text}` : text }],
    ...(snapshotId ? { structuredContent: { snapshot_id: snapshotId, text } } : {}),
  }
}

function peekabooToolError(error: unknown): CallToolResult {
  if (error instanceof PeekabooError) {
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${error.message}${error.details ? ` (${error.details})` : ""}`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  }
}

function asStructuredContent(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null
  return asRecord(value) ?? { value }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
