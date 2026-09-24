import type { Tool } from "./tool.js"

export interface ToolboxContext {
  readonly id: string
  readonly path: string
}

/** Parent class for a toolbox/plugin. One toolbox may expose many tools and skills. */
export abstract class Toolbox {
  abstract readonly id: string
  abstract readonly name: string
  readonly description?: string
  readonly enabled: boolean = true

  abstract tools(): readonly Tool[] | Promise<readonly Tool[]>

  onLoad?(_context: ToolboxContext): void | Promise<void>
  onUnload?(_context: ToolboxContext): void | Promise<void>
}
