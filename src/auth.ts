import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { file, mark, upsert } from "./store.js"
import { fetchUsageAndEmail } from "./transform.js"
import type { Account, AuthMethod, TokenResponse, ToastFn, Usage } from "./types.js"

// --- Kiro CLI database paths ---

function getKiroCliDbPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli", "data.sqlite3")
}

/** Path to the old opencode-kiro-auth SQLite DB (fallback import source) */
function getOldKiroDbPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode", "kiro.db")
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "kiro.db")
}

// --- Kiro runtime endpoints (from kiro-gateway: config.py) ---

const KIRO_REFRESH_URL = (region: string) =>
  `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`

const KIRO_OIDC_URL = (region: string) =>
  `https://oidc.${region}.amazonaws.com/token`

const KIRO_API_HOST = (region: string) =>
  `https://runtime.${region}.kiro.dev`

export { KIRO_API_HOST }

// --- Fingerprint generation (from kiro-gateway: utils.py) ---

function generateFingerprint(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

const FINGERPRINT = generateFingerprint()

// --- User-Agent (from kiro-gateway: utils.py) ---

export function getKiroUserAgent(): string {
  return `aws-sdk-js/1.0.27 os/linux lang/js md/nodejs#v22.0.0 KiroIDE-0.7.45-${FINGERPRINT}`
}

// --- Token refresh threshold (from kiro-gateway: TOKEN_REFRESH_THRESHOLD = 600s) ---

const TOKEN_REFRESH_THRESHOLD_MS = 600_000 // 10 minutes before expiry

// --- Sync from kiro-cli SQLite ---

interface KiroCliRow {
  access_token: string
  refresh_token: string
  region?: string
  sso_region?: string
  client_id?: string
  client_secret?: string
  profile_arn?: string
  start_url?: string
  expires_at?: number
}

/**
 * Sync accounts from kiro-cli SQLite database.
 * Also tries importing from old opencode-kiro-auth kiro.db as fallback.
 * Returns number of accounts imported.
 */
export async function syncFromKiroCli(toast?: ToastFn): Promise<number> {
  let imported = 0

  // Try kiro-cli data.sqlite3 first
  imported += await syncFromKiroCliDb(toast)

  // Also try old kiro.db (opencode-kiro-auth) as additional source
  if (imported === 0) {
    imported += await syncFromOldKiroDb(toast)
  }

  return imported
}

async function syncFromKiroCliDb(toast?: ToastFn): Promise<number> {
  const dbPath = getKiroCliDbPath()
  if (!existsSync(dbPath)) return 0

  let Database: any
  try {
    Database = (await (Function('return import("bun:sqlite")')() as Promise<any>)).Database
  } catch {
    return 0
  }

  let db: any
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return 0
  }

  try {
    const loc = file()
    let imported = 0

    // Read tokens from kiro-cli auth_kv table
    const rows = readKiroCliTokens(db)
    for (const row of rows) {
      const region = row.region || "us-east-1"
      const oidcRegion = row.sso_region || region
      const authMethod: AuthMethod = row.client_id ? "idc" : "desktop"

      // CRITICAL: Immediately refresh to fork the token chain.
      // This gives the plugin its own independent refresh token,
      // so kiro-cli logout won't invalidate our token.
      let accessToken = row.access_token
      let refreshToken = row.refresh_token
      let expiresAt = row.expires_at || Date.now() + 3600_000

      const forked = await forkTokenChain(refreshToken, authMethod, oidcRegion, row.client_id, row.client_secret)
      if (forked) {
        accessToken = forked.accessToken
        refreshToken = forked.refreshToken
        expiresAt = forked.expiresAt
      }

      // Try to fetch email + usage from Kiro API
      let email: string | undefined
      let usedCount: number | undefined
      let limitCount: number | undefined
      const usageInfo = await fetchUsageAndEmail(accessToken, region, row.profile_arn)
      if (usageInfo) {
        email = usageInfo.email
        usedCount = usageInfo.used
        limitCount = usageInfo.limit
      }
      if (!email) email = `kiro-${authMethod}-${region}`

      const account: Account = {
        id: crypto.randomUUID(),
        label: email,
        email,
        auth_method: authMethod,
        region,
        oidc_region: oidcRegion,
        client_id: row.client_id,
        client_secret: row.client_secret,
        profile_arn: row.profile_arn,
        start_url: row.start_url,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        is_healthy: true,
        consecutive_failures: 0,
        usage: usedCount != null && limitCount != null
          ? { used: usedCount, limit: limitCount, fetched_at: Date.now() }
          : undefined,
        quota_state: "unknown",
        quota_updated_at: 0,
        request_count: 0,
        last_used: 0,
        added_at: Date.now(),
      }

      await upsert(loc, account)
      imported++
    }

    if (imported > 0 && toast) {
      toast(`Kiro CLI sync: imported ${imported} account(s)`, "info")
    }

    return imported
  } finally {
    try { db.close() } catch {}
  }
}

/** Import accounts from old opencode-kiro-auth kiro.db */
async function syncFromOldKiroDb(toast?: ToastFn): Promise<number> {
  const dbPath = getOldKiroDbPath()
  if (!existsSync(dbPath)) return 0

  let Database: any
  try {
    Database = (await (Function('return import("bun:sqlite")')() as Promise<any>)).Database
  } catch {
    return 0
  }

  let db: any
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return 0
  }

  try {
    const loc = file()
    let imported = 0

    // Read from accounts table (old plugin schema)
    let rows: any[] = []
    try {
      rows = db.prepare("SELECT * FROM accounts").all()
    } catch {
      return 0
    }

    for (const row of rows) {
      if (!row.access_token && !row.refresh_token) continue

      const account: Account = {
        id: crypto.randomUUID(),
        label: row.email || `kiro-${row.auth_method || "desktop"}`,
        email: row.email || `kiro-${row.auth_method || "desktop"}`,
        auth_method: (row.auth_method || "desktop") as AuthMethod,
        region: row.region || "us-east-1",
        oidc_region: row.oidc_region || row.region || "us-east-1",
        client_id: row.client_id || undefined,
        client_secret: row.client_secret || undefined,
        profile_arn: row.profile_arn || undefined,
        start_url: row.start_url || undefined,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: row.expires_at || Date.now() + 3600_000,
        is_healthy: row.is_healthy === 1 || row.is_healthy === true,
        consecutive_failures: row.fail_count || 0,
        quota_state: "unknown",
        quota_updated_at: 0,
        request_count: row.used_count || 0,
        last_used: row.last_used || 0,
        added_at: Date.now(),
      }

      await upsert(loc, account)
      imported++
    }

    if (imported > 0 && toast) {
      toast(`Old kiro.db: imported ${imported} account(s)`, "info")
    }

    return imported
  } finally {
    try { db.close() } catch {}
  }
}

function readKiroCliTokens(db: any): KiroCliRow[] {
  const results: KiroCliRow[] = []

  try {
    // Read state table for region/profile info
    let stateMap = new Map<string, string>()
    try {
      const stateRows = db.prepare("SELECT key, value FROM state").all() as { key: string; value: string }[]
      stateMap = new Map(stateRows.map((r: any) => [r.key, r.value]))
    } catch {}

    // Read auth_kv table for tokens (newer kiro-cli uses this)
    try {
      const authRows = db.prepare("SELECT key, value FROM auth_kv").all() as { key: string; value: string }[]
      for (const row of authRows) {
        if (!row.value) continue
        try {
          const data = JSON.parse(row.value)
          const accessToken = data.access_token || data.accessToken
          const refreshToken = data.refresh_token || data.refreshToken
          if (!accessToken || !refreshToken) continue

          // Parse profile ARN from state
          let profileArn: string | undefined
          const profileRaw = stateMap.get("api.codewhisperer.profile")
          if (profileRaw) {
            try {
              const parsed = JSON.parse(profileRaw)
              profileArn = parsed.arn || parsed.profileArn || profileRaw
            } catch {
              profileArn = profileRaw
            }
          }

          const region = data.region || "us-east-1"
          const ssoRegion = data.sso_region || data.ssoRegion || region
          const expiresAt = data.expires_at || data.expiresAt
            ? parseInt(String(data.expires_at || data.expiresAt), 10)
            : undefined

          results.push({
            access_token: accessToken,
            refresh_token: refreshToken,
            region,
            sso_region: ssoRegion,
            client_id: data.client_id || data.clientId || undefined,
            client_secret: data.client_secret || data.clientSecret || undefined,
            profile_arn: profileArn,
            start_url: data.start_url || data.startUrl || undefined,
            expires_at: expiresAt,
          })
        } catch {}
      }
    } catch {}

    // Fallback: try old state-based token storage
    if (results.length === 0) {
      const accessToken = stateMap.get("auth.access_token") || stateMap.get("accessToken")
      const refreshToken = stateMap.get("auth.refresh_token") || stateMap.get("refreshToken")

      if (accessToken && refreshToken) {
        const region = stateMap.get("auth.region") || stateMap.get("region") || "us-east-1"
        const ssoRegion = stateMap.get("auth.sso_region") || stateMap.get("ssoRegion")
        const clientId = stateMap.get("auth.client_id") || stateMap.get("clientId")
        const clientSecret = stateMap.get("auth.client_secret") || stateMap.get("clientSecret")
        const profileArn = stateMap.get("api.codewhisperer.profile") || stateMap.get("profileArn")
        const startUrl = stateMap.get("auth.start_url") || stateMap.get("startUrl")
        const expiresAtStr = stateMap.get("auth.expires_at") || stateMap.get("expiresAt")

        let parsedProfileArn = profileArn
        if (profileArn) {
          try {
            const p = JSON.parse(profileArn)
            parsedProfileArn = p.arn || p.profileArn || profileArn
          } catch {}
        }

        results.push({
          access_token: accessToken,
          refresh_token: refreshToken,
          region: region || undefined,
          sso_region: ssoRegion || undefined,
          client_id: clientId || undefined,
          client_secret: clientSecret || undefined,
          profile_arn: parsedProfileArn || undefined,
          start_url: startUrl || undefined,
          expires_at: expiresAtStr ? parseInt(expiresAtStr, 10) : undefined,
        })
      }
    }
  } catch {
    // Silently fail - DB might have different schema
  }

  return results
}

// --- Token chain forking ---

/**
 * Fork the token chain by immediately refreshing.
 * This gives the plugin its own independent refresh token,
 * so when kiro-cli does logout (which revokes the original token),
 * the plugin's forked chain remains valid.
 * 
 * Kiro uses rotating refresh tokens — each refresh returns a NEW refresh token
 * and invalidates the old one. By refreshing immediately on sync, we "fork"
 * the chain: kiro-cli keeps its token, plugin gets a new one.
 */
async function forkTokenChain(
  refreshToken: string,
  authMethod: AuthMethod,
  region: string,
  clientId?: string,
  clientSecret?: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  try {
    if (authMethod === "idc" && clientId && clientSecret) {
      const url = KIRO_OIDC_URL(region)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": getKiroUserAgent() },
        body: JSON.stringify({
          grantType: "refresh_token",
          clientId,
          clientSecret,
          refreshToken,
        }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as any
      const newAccess = data.accessToken || data.access_token
      const newRefresh = data.refreshToken || data.refresh_token || refreshToken
      const expiresIn = data.expiresIn || data.expires_in || 3600
      return { accessToken: newAccess, refreshToken: newRefresh, expiresAt: Date.now() + expiresIn * 1000 }
    } else {
      // Desktop auth
      const url = KIRO_REFRESH_URL(region)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": getKiroUserAgent() },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as any
      const newAccess = data.accessToken || data.access_token
      const newRefresh = data.refreshToken || data.refresh_token || refreshToken
      const expiresIn = data.expiresIn || data.expires_in || 3600
      return { accessToken: newAccess, refreshToken: newRefresh, expiresAt: Date.now() + expiresIn * 1000 }
    }
  } catch {
    return null
  }
}

// --- Token refresh (from kiro-gateway: auth.py) ---

/**
 * Refresh access token for an account.
 * Uses proper User-Agent header matching kiro-gateway.
 */
export async function refreshToken(account: Account): Promise<TokenResponse | null> {
  if (account.auth_method === "desktop") {
    return refreshDesktopToken(account)
  }
  if (account.auth_method === "idc" && account.client_id && account.client_secret) {
    return refreshOidcToken(account)
  }
  return null
}

/**
 * Desktop auth refresh (from kiro-gateway: KiroAuthManager._refresh_desktop)
 * Uses Kiro desktop auth endpoint with proper User-Agent.
 * Returns new refresh token (rotating tokens).
 */
async function refreshDesktopToken(account: Account): Promise<TokenResponse | null> {
  const region = account.oidc_region || account.region || "us-east-1"
  const url = KIRO_REFRESH_URL(region)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getKiroUserAgent(),
      },
      body: JSON.stringify({ refreshToken: account.refresh_token }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as any
    return {
      accessToken: data.accessToken || data.access_token,
      refreshToken: data.refreshToken || data.refresh_token,
      expiresAt: data.expiresAt,
      expiresIn: data.expiresIn || data.expires_in,
    }
  } catch {
    return null
  }
}

/**
 * OIDC auth refresh (from kiro-gateway: KiroAuthManager._refresh_sso_oidc)
 * Handles 400 retry by attempting once more.
 * Returns new refresh token (rotating tokens).
 */
async function refreshOidcToken(account: Account, retried = false): Promise<TokenResponse | null> {
  const region = account.oidc_region || account.region || "us-east-1"
  const url = KIRO_OIDC_URL(region)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getKiroUserAgent(),
      },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: account.client_id,
        clientSecret: account.client_secret,
        refreshToken: account.refresh_token,
      }),
    })

    if (!res.ok) {
      // Retry once on 400 (from kiro-gateway pattern)
      if (res.status === 400 && !retried) {
        return refreshOidcToken(account, true)
      }
      return null
    }

    const data = (await res.json()) as any
    return {
      accessToken: data.accessToken || data.access_token,
      refreshToken: data.refreshToken || data.refresh_token,
      expiresAt: data.expiresAt,
      expiresIn: data.expiresIn || data.expires_in,
    }
  } catch {
    return null
  }
}

/**
 * Ensure account has a valid (non-expired) access token.
 * Uses 10-minute threshold (from kiro-gateway: TOKEN_REFRESH_THRESHOLD = 600).
 * Saves new refresh token (rotating tokens) to persist the chain.
 */
export async function ensureFreshToken(loc: string, account: Account): Promise<Account> {
  if (account.expires_at > Date.now() + TOKEN_REFRESH_THRESHOLD_MS) return account

  const result = await refreshToken(account)
  if (!result) {
    // Mark unhealthy if refresh fails
    await mark(loc, account.id, { is_healthy: false, last_error: "token_refresh_failed" })
    return { ...account, is_healthy: false }
  }

  const expiresAt = result.expiresAt || (result.expiresIn ? Date.now() + result.expiresIn * 1000 : Date.now() + 3600_000)
  const newRefreshToken = result.refreshToken || account.refresh_token

  await mark(loc, account.id, {
    access_token: result.accessToken,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
    is_healthy: true,
  })

  return { ...account, access_token: result.accessToken, refresh_token: newRefreshToken, expires_at: expiresAt, is_healthy: true }
}

// --- Usage fetch ---

export async function fetchUsage(account: Account): Promise<Usage | null> {
  return null
}
