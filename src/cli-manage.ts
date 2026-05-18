import type { Account } from "./types.js"

/**
 * Build options for the Manage Accounts select prompt.
 * Shows each account with status, request count, and active indicator.
 */
export function buildManageOptions(
  accounts: Account[],
  current?: Account
): { label: string; value: string; hint: string }[] {
  const options: { label: string; value: string; hint: string }[] = []

  for (const acc of accounts) {
    const isActive = acc.id === current?.id
    const prefix = isActive ? "* " : "  "
    const health = acc.is_healthy ? "healthy" : acc.last_error || "unhealthy"
    const quota = acc.quota_state === "exhausted" ? " [EXHAUSTED]" : ""
    const reqs = acc.request_count ?? 0
    const label = `${prefix}${acc.email}${quota} (${reqs} reqs, ${health})`
    const hint = `${acc.region} | ${acc.auth_method}`
    options.push({ label, value: `acc:${acc.id}`, hint })
  }

  options.push({ label: "Add account (sync kiro-cli)", value: "sync", hint: "Re-import from kiro-cli" })
  options.push({ label: "Refresh all tokens", value: "refresh-all", hint: "Force token refresh for all" })
  options.push({ label: "Refresh all usage", value: "refresh-usage", hint: "Update quota info" })

  return options
}

/**
 * Build sub-action options when a specific account is selected.
 */
export function buildAccountActions(): { label: string; value: string; hint: string }[] {
  return [
    { label: "Activate", value: "activate", hint: "Set as primary account" },
    { label: "Refresh token", value: "refresh", hint: "Force token refresh" },
    { label: "Remove", value: "delete", hint: "Remove from registry" },
  ]
}
