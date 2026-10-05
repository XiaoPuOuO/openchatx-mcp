/**
 * Windows compute shims. Honest-OS persona: the only masked fact is the
 * machine identity (hostname), so a single shim is enough. The operating
 * system, paths, and hardware specs report the truth, like any CI runner.
 */
export const WINDOWS_COMPUTE_SHIMS: Readonly<Record<string, string>> = {
  "hostname.cmd": "@echo off\r\necho node-01\r\n",
}
