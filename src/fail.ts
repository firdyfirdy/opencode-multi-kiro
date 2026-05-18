import type { FailClassification } from "./types.js"

/** Default cooldown duration in ms */
const DEFAULT_COOLDOWN_MS = 30_000

/** Max cooldown cap */
const MAX_COOLDOWN_MS = 300_000

/**
 * Calculate exponential backoff cooldown based on consecutive failures.
 * Base: 30s, multiplied by 2^(failures-1), capped at 5 minutes.
 */
export function cooldownMs(consecutiveFailures: number, baseMs: number = DEFAULT_COOLDOWN_MS): number {
  const exp = Math.min(consecutiveFailures, 5) // cap exponent
  const ms = baseMs * Math.pow(2, Math.max(0, exp - 1))
  return Math.min(ms, MAX_COOLDOWN_MS)
}

/**
 * Classify an HTTP response to decide whether to switch accounts.
 */
export function classify(opts: {
  status: number
  headers: Headers
  code?: string
  body?: string
  consecutiveFailures?: number
}): FailClassification {
  const { status, headers, code, body, consecutiveFailures = 0 } = opts

  // Success
  if (status >= 200 && status < 300) return { kind: "ok" }

  // Rate limit
  if (status === 429) {
    const retryAfter = headers.get("retry-after")
    const wait = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : cooldownMs(consecutiveFailures + 1)
    return { kind: "cooldown-switch", wait }
  }

  // Auth failures - hard switch (token invalid/expired beyond refresh)
  if (status === 401 || status === 403) {
    if (code === "ExpiredTokenException" || code === "InvalidTokenException") {
      return { kind: "hard-switch" }
    }
    // AccessDenied might be profile/permission issue
    if (code === "AccessDeniedException") {
      return { kind: "hard-switch" }
    }
    return { kind: "hard-switch" }
  }

  // Throttling from AWS
  if (status === 400 && (code === "ThrottlingException" || body?.includes("ThrottlingException"))) {
    return { kind: "cooldown-switch", wait: cooldownMs(consecutiveFailures + 1) }
  }

  // Service unavailable - cooldown
  if (status === 503 || status === 502) {
    return { kind: "cooldown-switch", wait: cooldownMs(consecutiveFailures + 1, 10_000) }
  }

  // Server errors - retry once, then switch
  if (status >= 500) {
    return { kind: "retry" }
  }

  // Client errors we can't handle
  if (status >= 400 && status < 500) {
    return { kind: "fatal" }
  }

  return { kind: "fatal" }
}

/** Parse error code from Kiro/AWS JSON response body */
export function parseCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    return parsed.__type || parsed.code || parsed.Code || undefined
  } catch {
    return undefined
  }
}
