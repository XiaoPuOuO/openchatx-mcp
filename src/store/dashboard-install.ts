import type { Request, Response } from "express"

import { loadOperationalState, updateOperationalState } from "../recovery/operational-state.js"
import type { CapabilityStoreService } from "./store-service.js"
import { communityToolboxId } from "./store-utils.js"

export async function handleCapabilityInstall(
  req: Request,
  res: Response,
  capabilityStore: CapabilityStoreService
): Promise<void> {
  try {
    const capabilityId = String(req.params.id ?? "")
    const revision = typeof req.body?.revision === "string" ? req.body.revision : undefined
    const review = await capabilityStore.review(capabilityId, revision)
    const requiredPermissions = Object.entries(review.observedPermissions)
      .filter(([, required]) => required)
      .map(([permission]) => permission)
    const approvedPermissions = stringArray(req.body?.approvedPermissions)
    const deniedPermissions = stringArray(req.body?.deniedPermissions)

    if (deniedPermissions.length > 0) {
      await persistCapabilityPolicies(capabilityId, deniedPermissions, "deny")
      res
        .status(403)
        .json({ error: `Capability permission denied: ${deniedPermissions.join(", ")}.` })
      return
    }

    const operationalState = await loadOperationalState()
    const fullAccess = operationalState.accessMode === "full-access"
    const policies = operationalState.capabilityPermissions[capabilityId] ?? {}

    if (!fullAccess) {
      const denied = requiredPermissions.filter((permission) => policies[permission] === "deny")
      if (denied.length > 0) {
        res.status(403).json({ error: `Capability permission denied: ${denied.join(", ")}.` })
        return
      }

      const missing = requiredPermissions.filter(
        (permission) =>
          policies[permission] !== "allow" && !approvedPermissions.includes(permission)
      )
      if (missing.length > 0) {
        res.status(409).json({
          error: "Capability permissions require explicit approval.",
          requiredPermissions,
          review,
        })
        return
      }
    }

    if (!fullAccess && req.body?.rememberPermissions === true && approvedPermissions.length > 0) {
      await persistCapabilityPolicies(capabilityId, approvedPermissions, "allow")
    }

    const entry = await capabilityStore.install(capabilityId, revision)
    const toolboxId = entry.source === "github" ? communityToolboxId(entry.repository) : entry.id
    if (requiredPermissions.length > 0) {
      await persistCapabilityPolicies(
        `toolbox:${toolboxId}`,
        requiredPermissions,
        !fullAccess && req.body?.rememberPermissions === true ? "allow" : "ask"
      )
    }
    res.status(201).json({ entry })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

async function persistCapabilityPolicies(
  key: string,
  permissions: string[],
  policy: "ask" | "allow" | "deny"
): Promise<void> {
  await updateOperationalState((state) => {
    const current = state.capabilityPermissions[key] ?? {}
    state.capabilityPermissions[key] = {
      ...current,
      ...Object.fromEntries(permissions.map((permission) => [permission, policy])),
    }
  })
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}
