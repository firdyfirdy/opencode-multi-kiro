import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { ensureFreshToken, KIRO_API_HOST, syncFromKiroCli } from "./auth.js"
import { buildAccountActions, buildManageOptions } from "./cli-manage.js"
import { classify, parseCode } from "./fail.js"
import { handleManage } from "./manage.js"
import { advance, selectInitial } from "./router.js"
import { active, file, list, load, mark, setActive } from "./store.js"
import { fetchUsageAndEmail, transformRequest, transformResponseStream } from "./transform.js"
import type { Account, ToastFn } from "./types.js"

const PROVIDER_ID = "kiro"

// Kiro request headers (matches kiro-gateway pattern)
function kiroHeaders(accessToken: string, profileArn?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonQDeveloperStreamingService.GenerateAssistantResponse",
    "User-Agent": "opencode-multi-kiro/0.1.0",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1",
  }
  if (profileArn) h["x-amzn-codewhisperer-profile-arn"] = profileArn
  return h
}

// Kiro API endpoint
function kiroEndpoint(region: string): string {
  return `${KIRO_API_HOST(region)}/generateAssistantResponse`
}

// Resolved base URL for OpenAI-compatible adapter (never undefined)
function resolvedBaseURL(region: string): string {
  return KIRO_API_HOST(region)
}

export const MultiKiroPlugin: Plugin = async (input: PluginInput) => {
  const loc = file()
  const toast: ToastFn = (message, variant) => {
    try {
      (input as any).client?.tui?.showToast?.({ body: { message, variant } })?.catch?.(() => {})
    } catch {}
  }

  // Initial sync from kiro-cli
  const accounts = await list(loc)
  if (accounts.length === 0) {
    await syncFromKiroCli(toast)
  }

  const current = await active(loc)
  const defaultRegion = current?.region || "us-east-1"

  return {
    config: async (cfg: any) => {
      if (!cfg.provider) cfg.provider = {}
      if (!cfg.provider[PROVIDER_ID]) cfg.provider[PROVIDER_ID] = {}
      const p = cfg.provider[PROVIDER_ID]
      p.npm = "@ai-sdk/openai-compatible"
      p.baseURL = resolvedBaseURL(defaultRegion)
      p.baseUrl = resolvedBaseURL(defaultRegion)
      if (!p.models) {
        p.models = {
          "auto": {
            name: "Auto (1.0x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-sonnet-4-5": {
            name: "Claude Sonnet 4.5 (1.3x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-sonnet-4-6": {
            name: "Claude Sonnet 4.6 (1.3x)",
            limit: { context: 1000000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-sonnet-4": {
            name: "Claude Sonnet 4.0 (1.3x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-haiku-4-5": {
            name: "Claude Haiku 4.5 (0.4x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          "claude-opus-4-5": {
            name: "Claude Opus 4.5 (2.2x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-opus-4-6": {
            name: "Claude Opus 4.6 (2.2x)",
            limit: { context: 1000000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "claude-opus-4-7": {
            name: "Claude Opus 4.7 (2.2x)",
            limit: { context: 1000000, output: 64000 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
          "minimax-m2.5": {
            name: "MiniMax M2.5 (0.25x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "minimax-m2.1": {
            name: "MiniMax M2.1 (0.15x)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "qwen3-coder-next": {
            name: "Qwen3 Coder Next (0.05x)",
            limit: { context: 256000, output: 64000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        }
      }
    },

    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth: any) {
        await getAuth()

        // Sync on every loader invocation if no accounts
        const accs = await list(loc)
        if (accs.length === 0) {
          await syncFromKiroCli(toast)
        }

        return {
          apiKey: "kiro",
          baseURL: resolvedBaseURL(defaultRegion),
          baseUrl: resolvedBaseURL(defaultRegion),
          async fetch(req: RequestInfo | URL, init?: RequestInit) {
            const attempted = new Set<string>()
            let state = await load(loc)

            // Select initial account
            let acc = selectInitial(
              state.strategy,
              state.accounts,
              state.active_account_id,
              attempted
            )

            if (!acc) {
              // Try sync one more time
              await syncFromKiroCli(toast)
              state = await load(loc)
              acc = selectInitial(state.strategy, state.accounts, state.active_account_id, attempted)
              if (!acc) {
                toast("No Kiro accounts. Run: kiro-cli login", "error")
                return new Response(JSON.stringify({ error: "No Kiro accounts" }), { status: 401 })
              }
            }

            if (state.active_account_id !== acc.id) {
              await setActive(loc, acc.id)
            }

            // Request loop with account switching
            while (true) {
              // Ensure fresh token
              acc = await ensureFreshToken(loc, acc)
              if (!acc.is_healthy) {
                const next = advance(state.accounts, acc.id, attempted)
                if (!next) {
                  toast(`All accounts exhausted`, "error")
                  return new Response(JSON.stringify({ error: "All accounts exhausted" }), { status: 429 })
                }
                attempted.add(acc.id)
                acc = next
                await setActive(loc, acc.id)
                continue
              }

              attempted.add(acc.id)

              // Fetch usage if not yet available
              if (!acc.usage && acc.profile_arn) {
                const usageInfo = await fetchUsageAndEmail(acc.access_token, acc.region || defaultRegion, acc.profile_arn)
                if (usageInfo) {
                  if (usageInfo.email && acc.email.startsWith("kiro-")) {
                    await mark(loc, acc.id, { usage: { used: usageInfo.used ?? 0, limit: usageInfo.limit ?? 1000, fetched_at: Date.now() } })
                    acc = { ...acc, email: usageInfo.email, usage: { used: usageInfo.used ?? 0, limit: usageInfo.limit ?? 1000, fetched_at: Date.now() } }
                  } else {
                    await mark(loc, acc.id, { usage: { used: usageInfo.used ?? 0, limit: usageInfo.limit ?? 1000, fetched_at: Date.now() } })
                    acc = { ...acc, usage: { used: usageInfo.used ?? 0, limit: usageInfo.limit ?? 1000, fetched_at: Date.now() } }
                  }
                }
              }

              // Show toast with active account + usage
              const usageStr = acc.usage ? `${acc.usage.used}/${acc.usage.limit} credits` : `${acc.request_count ?? 0} reqs`
              toast(`[${acc.email}] ${usageStr}`, "info")

              // Transform request: OpenAI format -> Kiro format
              const region = acc.region || defaultRegion
              const endpoint = kiroEndpoint(region)
              const hdrs = kiroHeaders(acc.access_token, acc.profile_arn)

              // Parse and transform body
              let requestBody: any
              let reqModel = "auto"
              try {
                const rawBody = init?.body
                const bodyStr = typeof rawBody === "string"
                  ? rawBody
                  : rawBody instanceof ArrayBuffer
                    ? new TextDecoder().decode(rawBody)
                    : rawBody instanceof Uint8Array
                      ? new TextDecoder().decode(rawBody)
                      : await new Response(rawBody as any).text()
                const parsed = typeof bodyStr === "string" ? JSON.parse(bodyStr) : bodyStr
                reqModel = parsed?.model || "auto"
                requestBody = transformRequest(parsed, acc)
              } catch (e) {
                // If transform fails, try forwarding raw body
                requestBody = init?.body
              }

              const res = await fetch(endpoint, {
                method: "POST",
                headers: hdrs,
                body: typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody),
              })

              if (res.ok) {
                // Refresh usage after successful request
                const postUsage = await fetchUsageAndEmail(acc.access_token, acc.region || defaultRegion, acc.profile_arn)
                const newUsed = postUsage?.used ?? (acc.usage ? acc.usage.used + 1 : (acc.request_count ?? 0) + 1)
                const newLimit = postUsage?.limit ?? acc.usage?.limit ?? 1000

                await mark(loc, acc.id, {
                  request_count: (acc.request_count ?? 0) + 1,
                  consecutive_failures: 0,
                  last_used: Date.now(),
                  cooldown_until: undefined,
                  last_error: undefined,
                  usage: { used: newUsed, limit: newLimit, fetched_at: Date.now() },
                })

                // Transform Kiro response stream to OpenAI SSE format
                return transformResponseStream(res, reqModel)
              }

              // Handle failure
              const resBody = await res.clone().text().catch(() => "")
              const code = parseCode(resBody)
              const result = classify({ status: res.status, headers: res.headers, code, body: resBody })

              if (result.kind === "fatal" || result.kind === "ok") return res

              // Mark failure
              await mark(loc, acc.id, {
                cooldown_until: result.kind === "cooldown-switch" && result.wait
                  ? Date.now() + result.wait
                  : undefined,
                last_error: code || `${res.status}`,
                consecutive_failures: (acc.consecutive_failures ?? 0) + 1,
              })

              if (result.kind === "retry") {
                // Retry once with same account
                continue
              }

              // Switch account
              state = await load(loc)
              const next = advance(state.accounts, acc.id, attempted)
              if (!next) {
                toast(`All accounts tried, returning last error`, "warning")
                return res
              }

              toast(`Switching to [${next.email}]`, "warning")
              await setActive(loc, next.id)
              acc = next
            }
          },
        }
      },

      methods: [
        {
          label: "Kiro (sync from kiro-cli)",
          type: "oauth" as const,
          authorize: async () => {
            return {
              url: "",
              instructions: "Syncing accounts from kiro-cli...",
              method: "auto" as const,
              callback: async () => {
                const count = await syncFromKiroCli(toast)
                if (count > 0) {
                  const acc = await active(loc)
                  return { type: "success" as const, key: "kiro", provider: PROVIDER_ID, metadata: { email: acc?.email || "" } }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
        {
          label: "Manage Accounts",
          type: "oauth" as const,
          prompts: [
            {
              type: "select" as const,
              key: "target",
              message: "Manage Kiro Accounts",
              options: buildManageOptions(await list(loc), current),
            },
            {
              type: "select" as const,
              key: "sub_action",
              message: "Account Action",
              options: buildAccountActions(),
              when: { key: "target", op: "neq" as const, value: "sync" },
            },
          ],
          authorize: async (inputs: any) => {
            return {
              url: "",
              instructions: "Processing...",
              method: "auto" as const,
              callback: async () => {
                const result = await handleManage(loc, inputs || {}, toast)
                if (result.success) {
                  return { type: "success" as const, key: "kiro", provider: PROVIDER_ID, metadata: { email: result.label || "" } }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },

    provider: {
      id: PROVIDER_ID,
      models: async (provider: any) => {
        const models = provider?.models || {}
        const normalized: Record<string, any> = {}
        for (const [modelID, model] of Object.entries(models)) {
          const m = model as any
          normalized[modelID] = {
            ...m,
            api: { ...(m.api || {}), npm: "@ai-sdk/openai-compatible" },
          }
        }
        return normalized
      },
    },
  }
}

export default MultiKiroPlugin
