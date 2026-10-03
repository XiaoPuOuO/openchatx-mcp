export async function createProjectSnapshot(projectId: string): Promise<unknown> {
  const body = await request<{ snapshot: unknown }>(
    `/ui/api/project-workspaces/${encodeURIComponent(projectId)}/snapshot`,
    { method: "POST" }
  )
  return body.snapshot
}

export async function exportProjectWorkspace(
  projectId: string,
  destination?: string
): Promise<{ path: string }> {
  return request(`/ui/api/project-workspaces/${encodeURIComponent(projectId)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination }),
  })
}

export async function importProjectWorkspace(
  path: string
): Promise<{ project: { id: string; name: string }; snapshot: unknown }> {
  return request("/ui/api/project-workspaces/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
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
