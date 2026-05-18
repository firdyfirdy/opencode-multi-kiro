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
export function transformResponseStream(kiroResponse: Response, model: string): Response {
  const reader = kiroResponse.body?.getReader()
  if (!reader) {
    return new Response(JSON.stringify({ error: "No response body" }), { status: 502 })
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const conversationId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`

  let buffer = ""
  let toolCallIndex = 0

  // Accumulate tool calls: Kiro streams name, then input chunks, then stop
  interface PendingToolCall {
    index: number
    id: string
    name: string
    input: string
  }
  let pendingToolCall: PendingToolCall | null = null

  function flushBuffer(): any[] {
    const results: any[] = []

    const patterns = [
      '{"content":',
      '{"name":',
      '{"input":',
      '{"stop":',
      '{"usage":',
      '{"contextUsagePercentage":',
      '{"unit":',
    ]

    let safety = 0
    while (safety++ < 1000) {
      let earliest = -1
      for (const pat of patterns) {
        const idx = buffer.indexOf(pat)
        if (idx !== -1 && (earliest === -1 || idx < earliest)) {
          earliest = idx
        }
      }

      if (earliest === -1) break

      const end = findMatchingBrace(buffer, earliest)
      if (end === -1) break

      const jsonStr = buffer.slice(earliest, end + 1)
      buffer = buffer.slice(end + 1)

      try {
        const event = JSON.parse(jsonStr)
        const chunk = eventToOpenAIChunk(event)
        if (chunk) results.push(chunk)
      } catch {}
    }

    return results
  }

  function eventToOpenAIChunk(event: any): any | null {
    const created = Math.floor(Date.now() / 1000)

    // Content event - emit immediately
    if (event.content !== undefined && !event.name && !event.toolUseId) {
      return {
        id: conversationId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: { content: event.content },
          finish_reason: null,
        }],
      }
    }

    // Tool use event: every chunk has name + toolUseId + input
    // Accumulate input until toolUseId changes or stop event
    if (event.toolUseId && event.name) {
      if (!pendingToolCall || pendingToolCall.id !== event.toolUseId) {
        // New tool call - flush previous if exists
        const flushed = flushPendingToolCall()
        pendingToolCall = {
          index: toolCallIndex++,
          id: event.toolUseId,
          name: event.name,
          input: event.input || "",
        }
        return flushed
      } else {
        // Same tool call - accumulate input
        pendingToolCall.input += event.input || ""
        return null
      }
    }

    // Stop event
    if (event.stop !== undefined) {
      return flushPendingToolCall()
    }

    // Usage/metering events - skip
    if (event.usage !== undefined || event.contextUsagePercentage !== undefined || event.unit !== undefined) return null

    // Content with modelId (assistantResponseEvent style)
    if (event.content !== undefined) {
      return {
        id: conversationId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: { content: event.content },
          finish_reason: null,
        }],
      }
    }

    return null
  }

  function flushPendingToolCall(): any | null {
    if (!pendingToolCall) return null
    const tc = pendingToolCall
    pendingToolCall = null

    let args = tc.input
    // Validate JSON
    try {
      JSON.parse(args)
    } catch {
      // If not valid JSON, wrap it
      if (args) {
        args = JSON.stringify({ raw: args })
      } else {
        args = "{}"
      }
    }

    return {
      id: conversationId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: tc.index,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: args },
          }],
        },
        finish_reason: null,
      }],
    }
  }

  function makeStopChunk(): any {
    return {
      id: conversationId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: toolCallIndex > 0 ? "tool_calls" : "stop",
      }],
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const rawChunk = decoder.decode(value, { stream: true })
          buffer += rawChunk

          const chunks = flushBuffer()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
        }

        // Flush remaining
        const remaining = flushBuffer()
        for (const chunk of remaining) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }

        // Flush any pending tool call that wasn't stopped
        if (pendingToolCall) {
          const toolChunk = flushPendingToolCall()
          if (toolChunk) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`))
          }
        }

        // Send stop + done
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeStopChunk())}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (err) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeStopChunk())}\n\n`))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch {
          controller.error(err)
        }
      }
    },
    cancel() {
      reader.cancel()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}

/**
 * Find the index of the matching closing brace for a JSON object starting at `start`.
 * Handles string escaping. Returns -1 if incomplete.
 */
function findMatchingBrace(str: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < str.length; i++) {
    const ch = str[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === "\\") {
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return -1 // incomplete
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
