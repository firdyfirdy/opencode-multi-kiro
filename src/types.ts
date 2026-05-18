/** Routing strategy for multi-account selection */
export type Strategy = "hybrid" | "round-robin" | "sticky"

/** Quota state for an account */
export type QuotaState = "available" | "exhausted" | "unknown"

/** Auth method used to obtain tokens */
export type AuthMethod = "desktop" | "idc" | "builder"

/** Usage info fetched from Kiro */
export interface Usage {
  used: number
  limit: number
  fetched_at: number
}

/** Single Kiro account */
export interface Account {
  id: string
  label: string
  email: string
  auth_method: AuthMethod
  region: string
  oidc_region?: string
  client_id?: string
  client_secret?: string
  profile_arn?: string
  start_url?: string

  // tokens
  access_token: string
  refresh_token: string
  expires_at: number

  // health
  is_healthy: boolean
  consecutive_failures: number
  cooldown_until?: number
  last_error?: string

  // usage/quota
  usage?: Usage
  quota_state: QuotaState
  quota_updated_at: number

  // metrics
  request_count: number
  last_used: number
  added_at: number
}

/** Persisted registry (JSON file) */
export interface Registry {
  strategy: Strategy
  active_account_id?: string
  accounts: Account[]
}

/** Token response from Kiro refresh endpoints */
export interface TokenResponse {
  accessToken: string
  expiresAt?: number
  expiresIn?: number
}

/** Classification result from fail.ts */
export interface FailClassification {
  kind: "ok" | "hard-switch" | "cooldown-switch" | "retry" | "fatal"
  wait?: number
}

/** Toast function signature from OpenCode plugin client */
export type ToastFn = (message: string, variant: string) => void
