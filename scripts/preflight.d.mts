export interface PublicRuntimeCheck {
  errors: string[]
  pm2Path: string
}

export function checkPublicRuntime(ngrokEnabled?: boolean): Promise<PublicRuntimeCheck>
export function isSupportedNodeVersion(version: string): boolean
export function isSupportedArchitecture(arch: string): boolean
export function checkRtkRuntime(enabled: boolean, executable?: string): string | undefined
export function printPreflightErrors(errors: readonly string[]): void
