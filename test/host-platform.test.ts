import assert from "node:assert/strict"
import test from "node:test"

import {
  defaultShellPath,
  hostDisplayName,
  interactiveReadyCommand,
  interactiveShellArgs,
  isSupportedHostPlatform,
  resolveConfiguredShell,
  shellCommandArgs,
} from "../src/host-platform.js"

test("host platform helpers describe macOS and native Windows", () => {
  assert.equal(isSupportedHostPlatform("darwin"), true)
  assert.equal(isSupportedHostPlatform("win32"), true)
  assert.equal(isSupportedHostPlatform("linux"), false)
  assert.equal(hostDisplayName("darwin"), "macOS")
  assert.equal(hostDisplayName("win32"), "Windows")
})

test("shell command construction is platform-native", () => {
  assert.equal(defaultShellPath("darwin"), "/bin/zsh")
  assert.equal(defaultShellPath("win32"), "pwsh.exe")
  assert.deepEqual(shellCommandArgs("echo ok", "darwin"), ["-f", "-c", "echo ok"])
  assert.deepEqual(shellCommandArgs("Write-Output ok", "win32"), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Write-Output ok",
  ])
  assert.deepEqual(interactiveShellArgs("darwin"), ["-f"])
  assert.deepEqual(interactiveShellArgs("win32"), ["-NoLogo", "-NoProfile"])
  assert.match(interactiveReadyCommand("darwin"), /OPENCHATX_READY/u)
  assert.match(interactiveReadyCommand("win32"), /OPENCHATX_READY/u)
})

test("Windows shell resolution falls back to Windows PowerShell when pwsh is unavailable", () => {
  const resolved = resolveConfiguredShell("pwsh.exe", "win32")
  assert.ok(
    resolved.toLowerCase().endsWith("pwsh.exe") || resolved.toLowerCase() === "powershell.exe"
  )
  assert.equal(resolveConfiguredShell("C:\\Custom\\shell.exe", "win32"), "C:\\Custom\\shell.exe")
})
