import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Account, QuotaState, Registry, Strategy, Usage } from "./types.js"

function getBaseDir(): string {
  if (process.platform === "win32")
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode")
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

/** Path to the multi-kiro registry JSON */
export function file(): string {
  return join(getBaseDir(), "multi-kiro.json")
}

const DEFAULT_REGISTRY: Registry = {
  strategy: "hybrid",
  accounts: [],
}

/** Load registry from disk */
export async function load(loc: string): Promise<Registry> {
  try {
    if (!existsSync(loc)) return { ...DEFAULT_REGISTRY, accounts: [] }
    const raw = readFileSync(loc, "utf-8")
    const data = JSON.parse(raw) as Registry
    return {
      strategy: data.strategy || "hybrid",
      active_account_id: data.active_account_id,
      accounts: data.accounts || [],
    }
  } catch {
    return { ...DEFAULT_REGISTRY, accounts: [] }
  }
}

/** Save registry to disk */
export async function save(loc: string, registry: Registry): Promise<void> {
  const dir = dirname(loc)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(loc, JSON.stringify(registry, null, 2), "utf-8")
}

/** Get active account */
export async function active(loc: string): Promise<Account | undefined> {
  const reg = await load(loc)
  if (!reg.active_account_id) return reg.accounts[0]
  return reg.accounts.find((a) => a.id === reg.active_account_id) || reg.accounts[0]
}

/** List all accounts */
export async function list(loc: string): Promise<Account[]> {
  const reg = await load(loc)
  return reg.accounts
}

/** Set active account */
export async function setActive(loc: string, id: string): Promise<void> {
  const reg = await load(loc)
  reg.active_account_id = id
  await save(loc, reg)
}

/** Upsert an account (add or update by matching email+auth_method) */
export async function upsert(loc: string, account: Account): Promise<Account> {
  const reg = await load(loc)
  const idx = reg.accounts.findIndex(
    (a) => a.email === account.email && a.auth_method === account.auth_method
  )
  if (idx >= 0) {
    // merge: keep metrics, update tokens/health
    reg.accounts[idx] = {
      ...reg.accounts[idx],
      access_token: account.access_token,
      refresh_token: account.refresh_token || reg.accounts[idx].refresh_token,
      expires_at: account.expires_at,
      region: account.region,
      oidc_region: account.oidc_region || reg.accounts[idx].oidc_region,
      client_id: account.client_id || reg.accounts[idx].client_id,
      client_secret: account.client_secret || reg.accounts[idx].client_secret,
      profile_arn: account.profile_arn || reg.accounts[idx].profile_arn,
      start_url: account.start_url || reg.accounts[idx].start_url,
      is_healthy: true,
      consecutive_failures: 0,
      last_error: undefined,
      cooldown_until: undefined,
    }
    await save(loc, reg)
    return reg.accounts[idx]
  }

  reg.accounts.push(account)
  if (!reg.active_account_id) reg.active_account_id = account.id
  await save(loc, reg)
  return account
}

/** Update partial fields on an account */
export async function mark(
  loc: string,
  id: string,
  fields: Partial<Pick<Account, "request_count" | "consecutive_failures" | "last_used" | "cooldown_until" | "last_error" | "usage" | "quota_state" | "quota_updated_at" | "is_healthy" | "access_token" | "refresh_token" | "expires_at">>
): Promise<void> {
  const reg = await load(loc)
  const acc = reg.accounts.find((a) => a.id === id)
  if (!acc) return
  Object.assign(acc, fields)
  await save(loc, reg)
}

/** Remove an account */
export async function remove(loc: string, id: string): Promise<void> {
  const reg = await load(loc)
  reg.accounts = reg.accounts.filter((a) => a.id !== id)
  if (reg.active_account_id === id) {
    reg.active_account_id = reg.accounts[0]?.id
  }
  await save(loc, reg)
}

/** Set strategy */
export async function setStrategy(loc: string, strategy: Strategy): Promise<void> {
  const reg = await load(loc)
  reg.strategy = strategy
  await save(loc, reg)
}
