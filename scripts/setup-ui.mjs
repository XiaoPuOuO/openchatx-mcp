import process from "node:process"

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const paint = (code, value) => (useColor ? `\u001b[${code}m${value}\u001b[0m` : value)
const bold = (value) => paint("1", value)
const dim = (value) => paint("2", value)
const cyan = (value) => paint("36", value)
const green = (value) => paint("32", value)
const yellow = (value) => paint("33", value)
const red = (value) => paint("31", value)

export function intro() {
  process.stdout.write(
    `\n${bold("SHELLBY MCP")} ${dim("SETUP")}\n${dim("First-time local agent harness setup")}\n\n`
  )
}

export function spinner(label) {
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
    if (active) process.stdout.write(`\r${cyan(frames[index++ % frames.length])} ${label}`)
  }
  render()
  const timer = setInterval(render, 80)

  const stop = (symbol, message) => {
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

export function note(title, content) {
  const lines = String(content)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
  if (lines.length === 0) return

  process.stdout.write(`\n${cyan("◆")} ${bold(title)}\n`)
  for (const line of lines) process.stdout.write(`${dim("│")} ${line}\n`)
}

export function failure(title, lines) {
  process.stderr.write(`\n${red("✗")} ${bold(title)}\n`)
  for (const line of lines) process.stderr.write(`  ${line}\n`)
}

export function outro(lines) {
  process.stdout.write(`\n${green("✓")} ${bold("Setup complete")}\n`)
  for (const line of lines) process.stdout.write(`${dim("│")} ${line}\n`)
  process.stdout.write("\n")
}
