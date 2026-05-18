import type { Account, Strategy } from "./types.js"

/**
 * Select initial account based on strategy.
 * Skips accounts in cooldown or already attempted.
 */
export function selectInitial(
  strategy: Strategy,
  accounts: Account[],
  activeId: string | undefined,
  attempted: Set<string>
): Account | undefined {
  const now = Date.now()
  const eligible = accounts.filter(
    (a) => a.is_healthy && !attempted.has(a.id) && (!a.cooldown_until || a.cooldown_until <= now)
  )
  if (eligible.length === 0) return undefined

  switch (strategy) {
    case "sticky": {
      const current = eligible.find((a) => a.id === activeId)
      return current || eligible[0]
    }
    case "round-robin": {
      // pick least recently used
      return eligible.sort((a, b) => a.last_used - b.last_used)[0]
    }
    case "hybrid":
    default: {
      // prefer active if healthy, else pick by lowest usage
      const current = eligible.find((a) => a.id === activeId)
      if (current && current.quota_state !== "exhausted") return current
      return eligible.sort((a, b) => (a.request_count ?? 0) - (b.request_count ?? 0))[0]
    }
  }
}

/**
 * Advance to next account after failure.
 * Returns next eligible account or undefined if none left.
 */
export function advance(
  accounts: Account[],
  currentId: string,
  attempted: Set<string>
): Account | undefined {
  const now = Date.now()
  const eligible = accounts.filter(
    (a) =>
      a.id !== currentId &&
      a.is_healthy &&
      !attempted.has(a.id) &&
      (!a.cooldown_until || a.cooldown_until <= now)
  )
  if (eligible.length === 0) return undefined

  // prefer lowest usage
  return eligible.sort((a, b) => (a.request_count ?? 0) - (b.request_count ?? 0))[0]
}
