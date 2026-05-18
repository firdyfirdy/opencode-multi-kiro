import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlinkSync, existsSync } from "node:fs"
import { selectInitial, advance } from "../src/router.js"
import { classify, cooldownMs } from "../src/fail.js"
import { load, save, upsert, mark, remove } from "../src/store.js"
import { KIRO_API_HOST } from "../src/auth.js"
import type { Account } from "../src/types.js"

// --- Helper: create a mock account ---
function mockAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: crypto.randomUUID(),
    label: "test@example.com",
    email: "test@example.com",
    auth_method: "desktop",
    region: "us-east-1",
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Date.now() + 3600_000,
    is_healthy: true,
    consecutive_failures: 0,
    quota_state: "unknown",
    quota_updated_at: 0,
    request_count: 0,
    last_used: 0,
    added_at: Date.now(),
    ...overrides,
  }
}

// --- Router tests ---

describe("router.selectInitial", () => {
  it('returns first healthy account for "sticky" strategy', () => {
    const a = mockAccount({ id: "a1" })
    const b = mockAccount({ id: "b1" })
    const result = selectInitial("sticky", [a, b], undefined, new Set())
    expect(result?.id).toBe("a1")
  })

  it("skips accounts in cooldown", () => {
    const a = mockAccount({ id: "a1", cooldown_until: Date.now() + 60_000 })
    const b = mockAccount({ id: "b1" })
    const result = selectInitial("sticky", [a, b], undefined, new Set())
    expect(result?.id).toBe("b1")
  })
})

describe("router.advance", () => {
  it("skips current account and attempted set", () => {
    const a = mockAccount({ id: "a1" })
    const b = mockAccount({ id: "b1" })
    const c = mockAccount({ id: "c1" })
    const attempted = new Set(["b1"])
    const result = advance([a, b, c], "a1", attempted)
    expect(result?.id).toBe("c1")
  })
})

// --- Fail classification tests ---

describe("fail.classify", () => {
  it('returns "ok" for 2xx', () => {
    const result = classify({ status: 200, headers: new Headers() })
    expect(result.kind).toBe("ok")
  })

  it('returns "cooldown-switch" for 429', () => {
    const result = classify({ status: 429, headers: new Headers() })
    expect(result.kind).toBe("cooldown-switch")
  })

  it('returns "hard-switch" for 401', () => {
    const result = classify({ status: 401, headers: new Headers() })
    expect(result.kind).toBe("hard-switch")
  })

  it('returns "hard-switch" for 403', () => {
    const result = classify({ status: 403, headers: new Headers() })
    expect(result.kind).toBe("hard-switch")
  })
})

describe("fail.cooldownMs", () => {
  it("returns exponential backoff values", () => {
    // base 30s: failures 1 -> 30s, 2 -> 60s, 3 -> 120s
    expect(cooldownMs(1)).toBe(30_000)
    expect(cooldownMs(2)).toBe(60_000)
    expect(cooldownMs(3)).toBe(120_000)
  })
})

// --- Store tests ---

describe("store", () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = join(tmpdir(), `multi-kiro-test-${crypto.randomUUID()}.json`)
  })

  afterEach(() => {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {}
  })

  it("load returns default registry for non-existent file", async () => {
    const reg = await load(tmpFile)
    expect(reg.strategy).toBe("hybrid")
    expect(reg.accounts).toEqual([])
  })

  it("save and load round-trip", async () => {
    const acc = mockAccount()
    await save(tmpFile, { strategy: "sticky", accounts: [acc], active_account_id: acc.id })
    const reg = await load(tmpFile)
    expect(reg.strategy).toBe("sticky")
    expect(reg.accounts).toHaveLength(1)
    expect(reg.accounts[0].id).toBe(acc.id)
  })

  it("upsert adds a new account", async () => {
    const acc = mockAccount()
    await upsert(tmpFile, acc)
    const reg = await load(tmpFile)
    expect(reg.accounts).toHaveLength(1)
    expect(reg.accounts[0].email).toBe(acc.email)
  })

  it("upsert updates existing account by email+auth_method", async () => {
    const acc = mockAccount({ email: "dup@test.com", auth_method: "desktop" })
    await upsert(tmpFile, acc)
    const updated = mockAccount({ email: "dup@test.com", auth_method: "desktop", access_token: "new-tok" })
    await upsert(tmpFile, updated)
    const reg = await load(tmpFile)
    expect(reg.accounts).toHaveLength(1)
    expect(reg.accounts[0].access_token).toBe("new-tok")
  })

  it("mark updates partial fields", async () => {
    const acc = mockAccount()
    await save(tmpFile, { strategy: "hybrid", accounts: [acc], active_account_id: acc.id })
    await mark(tmpFile, acc.id, { request_count: 5, last_error: "429" })
    const reg = await load(tmpFile)
    expect(reg.accounts[0].request_count).toBe(5)
    expect(reg.accounts[0].last_error).toBe("429")
  })

  it("remove deletes an account", async () => {
    const a = mockAccount({ id: "rm1" })
    const b = mockAccount({ id: "rm2", email: "other@test.com" })
    await save(tmpFile, { strategy: "hybrid", accounts: [a, b], active_account_id: "rm1" })
    await remove(tmpFile, "rm1")
    const reg = await load(tmpFile)
    expect(reg.accounts).toHaveLength(1)
    expect(reg.accounts[0].id).toBe("rm2")
  })
})

// --- Regression: resolvedBaseURL never returns undefined ---

describe("KIRO_API_HOST regression", () => {
  it("never returns undefined for any region string", () => {
    const regions = ["us-east-1", "eu-west-1", "ap-southeast-1", ""]
    for (const region of regions) {
      const result = KIRO_API_HOST(region)
      expect(result).toBeDefined()
      expect(typeof result).toBe("string")
      expect(result.startsWith("https://")).toBe(true)
    }
  })
})
