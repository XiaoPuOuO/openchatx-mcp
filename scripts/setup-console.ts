import process from "node:process"

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const paint = (code: string, value: string) =>
  useColor ? `\u001b[${code}m${value}\u001b[0m` : value
const bold = (value: string) => paint("1", value)
const dim = (value: string) => paint("2", value)
const cyan = (value: string) => paint("36", value)
const green = (value: string) => paint("32", value)
const yellow = (value: string) => paint("33", value)
const red = (value: string) => paint("31", value)

export interface SetupSpinner {
  succeed(message?: string): void
  warn(message?: string): void
  fail(message?: string): void
}

export function intro(): void {
  process.stdout.write(
    `\n${bold("OPENCHATX-MCP")} ${dim("SETUP")}\n${dim("First-time local agent platform setup")}\n\n`
  )
}

export function spinner(label: string): SetupSpinner {
  if (!process.stdout.isTTY) {
    process.stdout.write(`• ${label}...\n`)
    return {
      succeed: (message = label) => process.stdout.write(`${green("✓")} ${message}\n`),
      warn: (message = label) => process.stdout.write(`${yellow("!")} ${message}\n`),
      fail: (message = label) => process.stdout.write(`${red("✗")} ${message}\n`),
    }
  }

  let index = 0
  let active = true
  const render = () => {
    const frame = frames[index++ % frames.length] ?? "⠋"
    if (active) process.stdout.write(`\r${cyan(frame)} ${label}`)
  }
  render()
  const timer = setInterval(render, 80)

  const stop = (symbol: string, message: string) => {
    active = false
    clearInterval(timer)
    process.stdout.write(`\r\u001b[2K${symbol} ${message}\n`)
  }

  return {
    succeed: (message = label) => stop(green("✓"), message),
    warn: (message = label) => stop(yellow("!"), message),
    fail: (message = label) => stop(red("✗"), message),
  }
}

export function note(title: string, content: unknown): void {
  const lines = String(content)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
  if (lines.length === 0) return

  process.stdout.write(`\n${cyan("◆")} ${bold(title)}\n`)
  for (const line of lines) process.stdout.write(`${dim("│")} ${line}\n`)
}

export function failure(title: string, lines: readonly string[]): void {
  process.stderr.write(`\n${red("✗")} ${bold(title)}\n`)
  for (const line of lines) process.stderr.write(`  ${line}\n`)
}

export function outro(lines: readonly string[]): void {
  process.stdout.write(`\n${green("✓")} ${bold("Setup complete")}\n`)
  for (const line of lines) process.stdout.write(`${dim("│")} ${line}\n`)
  process.stdout.write("\n")
}
