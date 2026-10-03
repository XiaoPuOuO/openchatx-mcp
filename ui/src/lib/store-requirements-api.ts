export type CapabilityRequirementStatus = {
  compatible: boolean
  platform: { required: string[]; current: string; ok: boolean }
  architecture: { required: string[]; current: string; ok: boolean }
  minOpenChatXVersion?: { required: string; current: string; ok: boolean }
  dependencies: {
    executables: Array<{ name: string; available: boolean }>
    environment: Array<{ name: string; available: boolean }>
    capabilities: Array<{ id: string; available: boolean }>
  }
  issues: string[]
}

export async function fetchCapabilityRequirements(
  id: string,
  revision?: string
): Promise<CapabilityRequirementStatus> {
  const params = revision ? `?revision=${encodeURIComponent(revision)}` : ""
  return request(`/ui/api/store/${encodeURIComponent(id)}/requirements${params}`)
}

export async function fixCapabilityDependencies(
  id: string,
  revision?: string
): Promise<{
  installed: string[]
  requiresApproval: string[]
  unresolvedExecutables: string[]
  unresolvedEnvironment: string[]
  requirements: CapabilityRequirementStatus
}> {
  return request(`/ui/api/store/${encodeURIComponent(id)}/dependencies/fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  })
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Request failed (${response.status})`)
  }
  return body
}
