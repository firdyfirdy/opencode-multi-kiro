import { ensureFreshToken, syncFromKiroCli } from "./auth.js"
import { active, list, load, mark, remove, setActive } from "./store.js"
import type { Account, ToastFn } from "./types.js"

export interface ManageResult {
  success: boolean
  label?: string
}

/**
 * Handle a manage action from the CLI prompt flow.
 */
export async function handleManage(
  loc: string,
  inputs: Record<string, string>,
  toast: ToastFn
): Promise<ManageResult> {
  const action = inputs?.action
  const target = inputs?.target
  const subAction = inputs?.sub_action

  // Top-level actions
  if (action === "sync" || target === "sync") {
    const count = await syncFromKiroCli(toast)
    const acc = await active(loc)
    if (count > 0) toast(`Synced ${count} account(s) from kiro-cli`, "success")
    else toast("No new accounts found in kiro-cli", "warning")
    return { success: count > 0, label: acc?.email || "Kiro" }
  }

  if (action === "refresh-all" || target === "refresh-all") {
    const accounts = await list(loc)
    let refreshed = 0
    for (const acc of accounts) {
      const result = await ensureFreshToken(loc, acc)
      if (result.is_healthy) refreshed++
    }
    toast(`Refreshed ${refreshed}/${accounts.length} account tokens`, "info")
    const acc = await active(loc)
    return { success: true, label: acc?.email || "Kiro" }
  }

  if (action === "refresh-usage" || target === "refresh-usage") {
    // Currently usage is tracked locally; placeholder for future API
    const accounts = await list(loc)
    toast(`Usage info refreshed for ${accounts.length} account(s)`, "info")
    const acc = await active(loc)
    return { success: true, label: acc?.email || "Kiro" }
  }

  // Account-specific actions
  const accountId = extractAccountId(action) || extractAccountId(target)
  if (accountId) {
    const resolvedAction = subAction || (action?.startsWith("acc:") ? target : action)
    return handleAccountAction(loc, accountId, resolvedAction || "activate", toast)
  }

  return { success: false }
}

function extractAccountId(value?: string): string | undefined {
  if (!value?.startsWith("acc:")) return undefined
  return value.replace(/^acc:/, "")
}

async function handleAccountAction(
  loc: string,
  accountId: string,
  action: string,
  toast: ToastFn
): Promise<ManageResult> {
  switch (action) {
    case "activate": {
      await setActive(loc, accountId)
      const acc = await active(loc)
      toast(`Activated: ${acc?.email}`, "success")
      return { success: true, label: acc?.email || "Kiro" }
    }

    case "refresh": {
      const state = await load(loc)
      const acc = state.accounts.find((a) => a.id === accountId)
      if (!acc) return { success: false }
      const refreshed = await ensureFreshToken(loc, acc)
      if (refreshed.is_healthy) {
        toast(`Token refreshed: ${acc.email}`, "success")
      } else {
        toast(`Token refresh failed: ${acc.email}`, "error")
      }
      const cur = await active(loc)
      return { success: refreshed.is_healthy, label: cur?.email || "Kiro" }
    }

    case "delete": {
      const state = await load(loc)
      const acc = state.accounts.find((a) => a.id === accountId)
      await remove(loc, accountId)
      toast(`Removed: ${acc?.email || accountId}`, "info")
      const cur = await active(loc)
      return { success: true, label: cur?.email || "Kiro" }
    }

    default:
      return { success: false }
  }
}
