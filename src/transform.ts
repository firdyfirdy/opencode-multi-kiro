import type { Account } from "./types.js"

// --- Model mapping (OpenAI-style to Kiro internal) ---

const MODEL_MAP: Record<string, string> = {
  "auto": "auto",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-7": "claude-opus-4.7",
  "minimax-m2.5": "minimax-m2.5",
  "minimax-m2.1": "minimax-m2.1",
  "qwen3-coder-next": "qwen3-coder-next",
  "deepseek-3.2": "deepseek-3.2",
}

function resolveModel(model: string): string {
  if (MODEL_MAP[model]) return MODEL_MAP[model]
  // Try normalizing dashes to dots for version numbers
  const normalized = model.replace(/-(\d+)-(\d+)/, "-$1.$2")
  if (MODEL_MAP[normalized]) return MODEL_MAP[normalized]
  return model
}

// --- Request body transformation ---

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | any[] | null
  tool_calls?: any[]
  tool_call_id?: string
  name?: string
}

interface OpenAITool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: any
  }
}

interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

interface KiroToolSpec {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: any }
  }
}

interface KiroToolUse {
  name: string
  input: any
  toolUseId: string
}

interface KiroToolResult {
  content: { text: string }[]
  status: string
  toolUseId: string
}

/**
 * Transform OpenAI chat/completions request body into Kiro generateAssistantResponse format.
 */
export function transformRequest(body: string | any, account: Account): any {
  const req: OpenAIRequest = typeof body === "string" ? JSON.parse(body) : body
  const model = resolveModel(req.model || "auto")
  const profileArn = account.profile_arn

  // Detect thinking mode: model name contains "thinking" or request has thinking/reasoning params
  const isThinkingMode =
    (req.model || "").toLowerCase().includes("thinking") ||
    !!(req as any).thinking ||
    !!(req as any).reasoning

  // Extract system messages
  let systemPrompt = ""
  const nonSystemMessages: OpenAIMessage[] = []

  for (const msg of req.messages || []) {
    if (msg.role === "system") {
      const text = extractText(msg.content)
      systemPrompt += (systemPrompt ? "\n\n" : "") + text
    } else {
      nonSystemMessages.push(msg)
    }
  }

  // Prepend thinking mode directive before system prompt content
  if (isThinkingMode) {
    const thinkingPrefix = `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>32768</max_thinking_length>\n\n`
    systemPrompt = thinkingPrefix + systemPrompt
  }

  // Append large-file safety instruction to prevent output token truncation
  const largeFileSafetyInstruction = `\n\n<system-reminder>
CRITICAL: When writing or creating files with content larger than 8KB (approximately 200+ lines or large JSON/data), you MUST use the bash tool with a heredoc or a script (e.g., python3/node) to generate the file instead of the write/edit tool directly. This prevents output token truncation that causes tool call failures. For smaller files (<8KB), use write/edit tools normally.
</system-reminder>`
  systemPrompt += largeFileSafetyInstruction

  // Build history + current message
  const { history, currentContent, currentToolResults } = buildConversation(nonSystemMessages)

  // Prepend system prompt to first user message content or current
  let finalContent = currentContent || "Continue"
  if (systemPrompt && history.length === 0) {
    finalContent = systemPrompt + "\n\n" + finalContent
  }

  // Convert tools
  const tools: KiroToolSpec[] = (req.tools || []).map(convertTool)
  const historyToolNames = collectToolNamesFromHistory(history)
  for (const name of historyToolNames) {
    if (!tools.some((t) => t.toolSpecification.name === name)) {
      tools.push({
        toolSpecification: {
          name: name.slice(0, 64),
          description: `Tool ${name}`,
          inputSchema: { json: { type: "object", properties: {} } },
        },
      })
    }
  }

  // Extract images from all non-system messages (image_url content parts)
  const images = extractImages(nonSystemMessages)

  // Build current message
  const currentMessage: any = {
    userInputMessage: {
      content: finalContent,
      modelId: model,
      origin: "AI_EDITOR",
    },
  }

  // Attach images if present
  if (images.length > 0) {
    currentMessage.userInputMessage.images = images
  }

  // Add tool context if present
  if (tools.length > 0 || currentToolResults.length > 0) {
    currentMessage.userInputMessage.userInputMessageContext = {}
    if (tools.length > 0) currentMessage.userInputMessage.userInputMessageContext.tools = tools
    if (currentToolResults.length > 0) {
      currentMessage.userInputMessage.userInputMessageContext.toolResults = currentToolResults
    }
  }

  // Build final payload
  const payload: any = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      currentMessage,
    },
  }

  // Add history if present (inject system prompt into first history entry)
  if (history.length > 0) {
    if (systemPrompt && history[0]?.userInputMessage) {
      history[0].userInputMessage.content = systemPrompt + "\n\n" + history[0].userInputMessage.content
    }
    payload.conversationState.history = history
  }

  // Add profileArn
  if (profileArn) {
    payload.profileArn = profileArn
  }

  return payload
}

function buildConversation(messages: OpenAIMessage[]) {
  const history: any[] = []
  let currentContent = ""
  const currentToolResults: KiroToolResult[] = []

  if (messages.length === 0) {
    return { history, currentContent: "Continue", currentToolResults }
  }

  // Last user/tool message(s) become currentMessage, rest become history
  // Walk backwards to find the boundary
  let currentIdx = messages.length

  // Find last user message index (current turn)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      currentIdx = i
      break
    }
    if (messages[i].role === "tool") {
      // tool results belong to current turn if after last assistant
      continue
    }
    if (messages[i].role === "assistant") {
      currentIdx = i + 1
      break
    }
  }

  // Collect current turn messages
  for (let i = currentIdx; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "user") {
      currentContent += (currentContent ? "\n" : "") + extractText(msg.content)
    } else if (msg.role === "tool") {
      currentToolResults.push({
        content: [{ text: extractText(msg.content) || "(empty)" }],
        status: "success",
        toolUseId: msg.tool_call_id || crypto.randomUUID(),
      })
    }
  }

  if (!currentContent) currentContent = "Continue"

  // Build history from messages before currentIdx
  const historyMessages = messages.slice(0, currentIdx)
  let i = 0
  while (i < historyMessages.length) {
    const msg = historyMessages[i]

    if (msg.role === "user" || msg.role === "tool") {
      // Collect consecutive user/tool messages
      let userContent = ""
      const toolResults: KiroToolResult[] = []

      while (i < historyMessages.length && (historyMessages[i].role === "user" || historyMessages[i].role === "tool")) {
        const m = historyMessages[i]
        if (m.role === "user") {
          userContent += (userContent ? "\n" : "") + extractText(m.content)
        } else if (m.role === "tool") {
          toolResults.push({
            content: [{ text: extractText(m.content) || "(empty)" }],
            status: "success",
            toolUseId: m.tool_call_id || crypto.randomUUID(),
          })
        }
        i++
      }

      const entry: any = {
        userInputMessage: {
          content: userContent || "(empty)",
          modelId: "auto",
          origin: "AI_EDITOR",
        },
      }

      if (toolResults.length > 0) {
        entry.userInputMessage.userInputMessageContext = { toolResults }
      }

      history.push(entry)
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content)
      const toolUses: KiroToolUse[] = (msg.tool_calls || []).map((tc: any) => ({
        name: tc.function?.name || "unknown",
        input: safeParseJson(tc.function?.arguments),
        toolUseId: tc.id || crypto.randomUUID(),
      }))

      const entry: any = {
        assistantResponseMessage: {
          content: text || "(empty)",
        },
      }

      if (toolUses.length > 0) {
        entry.assistantResponseMessage.toolUses = toolUses
      }

      history.push(entry)
      i++
    } else {
      i++
    }
  }

  // Ensure history alternates correctly: must start with user, end with user (for current turn)
  // If history ends with assistant, that's fine (current turn is the next user message)
  // If history starts with assistant, prepend a synthetic user message
  if (history.length > 0 && history[0].assistantResponseMessage) {
    history.unshift({
      userInputMessage: {
        content: "(system)",
        modelId: "auto",
        origin: "AI_EDITOR",
      },
    })
  }

  return { history, currentContent, currentToolResults }
}

function collectToolNamesFromHistory(history: any[]): string[] {
  const names = new Set<string>()
  for (const entry of history) {
    const uses = entry?.assistantResponseMessage?.toolUses
    if (!Array.isArray(uses)) continue
    for (const u of uses) {
      if (u?.name && typeof u.name === "string") names.add(u.name)
    }
  }
  return Array.from(names)
}

function convertTool(tool: OpenAITool): KiroToolSpec {
  const fn = tool.function
  const schema = fn.parameters || { type: "object", properties: {} }

  // Remove additionalProperties (Kiro doesn't support it)
  const cleanSchema = cleanJsonSchema(schema)

  return {
    toolSpecification: {
      name: (fn.name || "unknown").slice(0, 64),
      description: (fn.description || fn.name || "No description").slice(0, 9216),
      inputSchema: { json: cleanSchema },
    },
  }
}

function cleanJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema
  const result = { ...schema }
  delete result.additionalProperties
  if (Array.isArray(result.required) && result.required.length === 0) {
    delete result.required
  }
  if (result.properties) {
    const cleaned: any = {}
    for (const [key, val] of Object.entries(result.properties)) {
      cleaned[key] = cleanJsonSchema(val)
    }
    result.properties = cleaned
  }
  if (result.items) {
    result.items = cleanJsonSchema(result.items)
  }
  return result
}

function extractText(content: string | any[] | null | undefined): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part.type === "text") return part.text || ""
        return ""
      })
      .join("")
  }
  return String(content)
}

/**
 * Extract images from messages that have content arrays with image_url parts.
 * Converts OpenAI image_url format to Kiro image format.
 * Skips PDF content parts (not supported by Kiro images).
 */
function extractImages(messages: OpenAIMessage[]): Array<{ format: string; source: { bytes: string } }> {
  const images: Array<{ format: string; source: { bytes: string } }> = []

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      // Skip non-image parts and PDF parts
      if (part.type !== "image_url" || !part.image_url?.url) continue

      const url: string = part.image_url.url

      // Only handle base64 data URLs
      if (!url.startsWith("data:")) continue

      // Parse data URL: data:<mime>;base64,<data>
      const match = url.match(/^data:image\/([^;]+);base64,(.+)$/)
      if (!match) continue

      // Skip PDFs that might be disguised as image URLs
      const mimeSubtype = match[1]
      if (mimeSubtype === "pdf") continue

      // Map mime subtypes to format strings
      let format = mimeSubtype
      if (format === "jpeg" || format === "jpg") format = "jpeg"
      else if (format === "png") format = "png"
      else if (format === "gif") format = "gif"
      else if (format === "webp") format = "webp"

      images.push({
        format,
        source: { bytes: match[2] },
      })
    }
  }

  return images
}

function safeParseJson(str: string | undefined): any {
  if (!str) return {}
  try {
    return JSON.parse(str)
  } catch {
    return { raw: str }
  }
}

// --- Response transformation (Kiro event-stream -> OpenAI SSE) ---

/**
 * Transform Kiro event-stream response into OpenAI-compatible SSE stream.
 * Kiro returns a proprietary binary stream with embedded JSON objects.
 * We scan for JSON patterns and extract them using brace counting.
 */
/**
 * Parse one AWS Event Stream message from buffer at given offset.
 * Returns { payload, nextOffset } or null if incomplete.
 */
function parseOneMessage(buf: Uint8Array, offset: number): { payload: string; nextOffset: number } | null {
  if (offset + 12 > buf.length) return null

  const totalLength =
    ((buf[offset] & 0xFF) << 24) |
    ((buf[offset + 1] & 0xFF) << 16) |
    ((buf[offset + 2] & 0xFF) << 8) |
    (buf[offset + 3] & 0xFF)

  if (totalLength < 16 || totalLength > 64 * 1024 * 1024) return null
  if (offset + totalLength > buf.length) return null

  const headersLength =
    ((buf[offset + 4] & 0xFF) << 24) |
    ((buf[offset + 5] & 0xFF) << 16) |
    ((buf[offset + 6] & 0xFF) << 8) |
    (buf[offset + 7] & 0xFF)

  const payloadStart = offset + 12 + headersLength
  const payloadEnd = offset + totalLength - 4

  if (payloadStart >= payloadEnd || payloadEnd > buf.length) {
    return { payload: "", nextOffset: offset + totalLength }
  }

  const payload = new TextDecoder().decode(buf.slice(payloadStart, payloadEnd))
  return { payload, nextOffset: offset + totalLength }
}

/**
 * Transform Kiro event-stream response into OpenAI-compatible SSE stream.
 * Properly decodes AWS Event Stream binary framing.
 */
export function transformResponseStream(kiroResponse: Response, model: string): Response {
  const reader = kiroResponse.body?.getReader()
  if (!reader) {
    return new Response(JSON.stringify({ error: "No response body" }), { status: 502 })
  }

  const conversationId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`
  const encoder = new TextEncoder()

  function sse(obj: any): Uint8Array {
    return encoder.encode("data: " + JSON.stringify(obj) + "\n\n")
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let binaryBuf = new Uint8Array(0)
        let textContent = ""
        const toolCalls: Array<{ id: string; name: string; input: string; inputObj?: Record<string, any> }> = []
        let curTool: { id: string; name: string; input: string; inputObj?: Record<string, any> } | null = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const newBuf = new Uint8Array(binaryBuf.length + value.length)
          newBuf.set(binaryBuf)
          newBuf.set(value, binaryBuf.length)
          binaryBuf = newBuf

          let offset = 0
          while (offset + 12 <= binaryBuf.length) {
            const totalLen = ((binaryBuf[offset] & 0xFF) << 24) | ((binaryBuf[offset+1] & 0xFF) << 16) | ((binaryBuf[offset+2] & 0xFF) << 8) | (binaryBuf[offset+3] & 0xFF)
            if (totalLen < 16 || totalLen > 64 * 1024 * 1024) { offset++; continue }
            if (offset + totalLen > binaryBuf.length) break

            const headersLen = ((binaryBuf[offset+4] & 0xFF) << 24) | ((binaryBuf[offset+5] & 0xFF) << 16) | ((binaryBuf[offset+6] & 0xFF) << 8) | (binaryBuf[offset+7] & 0xFF)
            const payloadStart = offset + 12 + headersLen
            const payloadEnd = offset + totalLen - 4

            if (payloadStart < payloadEnd && payloadEnd <= binaryBuf.length) {
              const payloadStr = new TextDecoder().decode(binaryBuf.slice(payloadStart, payloadEnd))
              if (payloadStr.startsWith("{")) {
                try {
                  const event = JSON.parse(payloadStr)

                  if (event.content !== undefined && !event.toolUseId) {
                    textContent += event.content
                    // Stream text content immediately
                    controller.enqueue(sse({
                      id: conversationId, object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000), model,
                      choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
                    }))
                  }

                  if (event.toolUseId) {
                    if (event.stop) {
                      if (curTool) { toolCalls.push(curTool); curTool = null }
                    } else if (curTool && curTool.id === event.toolUseId) {
                      if (event.input !== undefined) {
                        if (typeof event.input === "string") {
                          curTool.input += event.input
                        } else {
                          // Merge object inputs instead of stringify+concatenate
                          if (!curTool.inputObj) {
                            // Parse existing input string into object if possible
                            try { curTool.inputObj = curTool.input ? JSON.parse(curTool.input) : {} } catch { curTool.inputObj = {} }
                          }
                          Object.assign(curTool.inputObj!, event.input as Record<string, any>)
                        }
                      }
                      if (event.name && !curTool.name) curTool.name = event.name
                    } else {
                      if (curTool) toolCalls.push(curTool)
                      if (typeof event.input === "string") {
                        curTool = {
                          id: event.toolUseId,
                          name: event.name || "",
                          input: event.input,
                        }
                      } else {
                        curTool = {
                          id: event.toolUseId,
                          name: event.name || "",
                          input: "",
                          inputObj: event.input !== undefined ? { ...event.input } : undefined,
                        }
                      }
                    }
                  }
                } catch {}
              }
            }
            offset += totalLen
          }
          if (offset > 0) binaryBuf = binaryBuf.slice(offset)
        }

        if (curTool) toolCalls.push(curTool)

        // Emit tool calls incrementally (like OpenAI streaming)
        const created = Math.floor(Date.now() / 1000)
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]
          // Resolve final args: prefer inputObj (merged objects), fallback to input string
          let args: string
          if (tc.inputObj) {
            args = JSON.stringify(tc.inputObj)
          } else {
            args = tc.input || "{}"
            try { JSON.parse(args) } catch { args = "{}" }
          }

          // First chunk: id + type + name + start of arguments
          const CHUNK_SIZE = 512
          const firstPiece = args.slice(0, CHUNK_SIZE)
          controller.enqueue(sse({
            id: conversationId, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: firstPiece } }] }, finish_reason: null }],
          }))

          // Subsequent chunks: only arguments continuation
          for (let j = CHUNK_SIZE; j < args.length; j += CHUNK_SIZE) {
            const piece = args.slice(j, j + CHUNK_SIZE)
            controller.enqueue(sse({
              id: conversationId, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: piece } }] }, finish_reason: null }],
            }))
          }
        }

        // Stop chunk
        controller.enqueue(sse({
          id: conversationId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
        }))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (err) {
        try {
          controller.enqueue(sse({
            id: conversationId, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { content: `Error: ${err}` }, finish_reason: "stop" }],
          }))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch { controller.error(err) }
      }
    },
    cancel() { reader.cancel() },
  })

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  })
}

// --- Usage/email fetch ---

/**
 * Fetch usage limits and email from Kiro API.
 * Tries multiple parameter combinations (same as opencode-kiro-auth).
 */
export async function fetchUsageAndEmail(
  accessToken: string,
  region: string,
  profileArn?: string
): Promise<{ email?: string; used?: number; limit?: number } | null> {
  if (!profileArn) return null

  const attempts: Array<{ resourceType?: string; origin?: string }> = [
    { resourceType: "AGENTIC_REQUEST", origin: "AI_EDITOR" },
    { origin: "AI_EDITOR" },
    { resourceType: "CONVERSATION", origin: "AI_EDITOR" },
    {},
  ]

  for (const [index, params] of attempts.entries()) {
    try {
      const url = new URL(`https://q.${region}.amazonaws.com/getUsageLimits`)
      url.searchParams.set("isEmailRequired", "true")
      if (params.origin) url.searchParams.set("origin", params.origin)
      if (params.resourceType) url.searchParams.set("resourceType", params.resourceType)
      url.searchParams.set("profileArn", profileArn)

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "x-amzn-kiro-agent-mode": "vibe",
          "amz-sdk-request": "attempt=1; max=1",
        },
      })

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        if (body.includes("FEATURE_NOT_SUPPORTED") && index < attempts.length - 1) {
          continue
        }
        continue
      }

      const data = await res.json() as any
      let usedCount = 0
      let limitCount = 0

      if (Array.isArray(data.usageBreakdownList)) {
        for (const s of data.usageBreakdownList) {
          if (s.freeTrialInfo) {
            usedCount += s.freeTrialInfo.currentUsage || 0
            limitCount += s.freeTrialInfo.usageLimit || 0
          }
          usedCount += s.currentUsage || 0
          limitCount += s.usageLimit || 0
        }
      }

      return {
        email: data.userInfo?.email,
        used: usedCount,
        limit: limitCount,
      }
    } catch {
      if (index < attempts.length - 1) continue
    }
  }

  return null
}
