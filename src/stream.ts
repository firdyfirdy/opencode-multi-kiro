/**
 * AWS Event Stream binary parser + OpenAI SSE response transformation.
 * Ported from kiro-gateway: parsers.py, streaming_openai.py, thinking_parser.py
 */

// --- Thinking block extraction (FSM from kiro-gateway: thinking_parser.py) ---

const THINKING_OPEN_TAG = "<thinking>"
const THINKING_CLOSE_TAG = "</thinking>"

interface ThinkingParserState {
  inThinking: boolean
  thinkingBuffer: string
  contentBuffer: string
  tagBuffer: string
}

function createThinkingParser(): ThinkingParserState {
  return {
    inThinking: false,
    thinkingBuffer: "",
    contentBuffer: "",
    tagBuffer: "",
  }
}

/**
 * Process a chunk of text through the thinking parser.
 * Separates <thinking>...</thinking> blocks from regular content.
 * Returns { thinking: string, content: string } for this chunk.
 */
function processThinkingChunk(
  state: ThinkingParserState,
  text: string
): { thinking: string; content: string } {
  let thinking = ""
  let content = ""

  for (const char of text) {
    if (state.inThinking) {
      state.tagBuffer += char
      if (state.tagBuffer.endsWith(THINKING_CLOSE_TAG)) {
        // End of thinking block
        const thinkingContent = state.tagBuffer.slice(0, -THINKING_CLOSE_TAG.length)
        thinking += thinkingContent
        state.tagBuffer = ""
        state.inThinking = false
      } else if (state.tagBuffer.length > 100_000) {
        // Safety: if tag buffer gets too large, flush as thinking content
        thinking += state.tagBuffer
        state.tagBuffer = ""
      }
    } else {
      state.tagBuffer += char
      if (state.tagBuffer.endsWith(THINKING_OPEN_TAG)) {
        // Start of thinking block - flush content before tag
        const beforeTag = state.tagBuffer.slice(0, -THINKING_OPEN_TAG.length)
        content += beforeTag
        state.tagBuffer = ""
        state.inThinking = true
      } else if (!THINKING_OPEN_TAG.startsWith(state.tagBuffer) && !state.tagBuffer.includes("<")) {
        // Not a potential tag start - flush buffer as content
        content += state.tagBuffer
        state.tagBuffer = ""
      } else if (state.tagBuffer.length > THINKING_OPEN_TAG.length + 10) {
        // Buffer too long to be a tag - flush as content
        content += state.tagBuffer
        state.tagBuffer = ""
      }
    }
  }

  return { thinking, content }
}

/**
 * Flush remaining buffer from thinking parser.
 */
function flushThinkingParser(state: ThinkingParserState): { thinking: string; content: string } {
  let thinking = ""
  let content = ""

  if (state.inThinking) {
    thinking += state.tagBuffer
  } else {
    content += state.tagBuffer
  }
  state.tagBuffer = ""

  return { thinking, content }
}

// --- AWS Event Stream binary parser (from kiro-gateway: parsers.py) ---

/**
 * Parse one AWS Event Stream message from buffer at given offset.
 * AWS Event Stream format:
 *   [4 bytes total_length] [4 bytes headers_length] [4 bytes prelude_crc]
 *   [headers...] [payload...] [4 bytes message_crc]
 */
function parseOneMessage(buf: Uint8Array, offset: number): { payload: string; nextOffset: number } | null {
  if (offset + 12 > buf.length) return null

  const totalLength =
    ((buf[offset] & 0xff) << 24) |
    ((buf[offset + 1] & 0xff) << 16) |
    ((buf[offset + 2] & 0xff) << 8) |
    (buf[offset + 3] & 0xff)

  if (totalLength < 16 || totalLength > 64 * 1024 * 1024) return null
  if (offset + totalLength > buf.length) return null

  const headersLength =
    ((buf[offset + 4] & 0xff) << 24) |
    ((buf[offset + 5] & 0xff) << 16) |
    ((buf[offset + 6] & 0xff) << 8) |
    (buf[offset + 7] & 0xff)

  const payloadStart = offset + 12 + headersLength
  const payloadEnd = offset + totalLength - 4

  if (payloadStart >= payloadEnd || payloadEnd > buf.length) {
    return { payload: "", nextOffset: offset + totalLength }
  }

  const payload = new TextDecoder().decode(buf.slice(payloadStart, payloadEnd))
  return { payload, nextOffset: offset + totalLength }
}

// --- OpenAI SSE stream transformation (from kiro-gateway: streaming_openai.py) ---

export function transformResponseStream(kiroResponse: Response, model: string): Response {
  const reader = kiroResponse.body?.getReader()
  if (!reader) {
    return new Response(JSON.stringify({ error: "No response body" }), { status: 502 })
  }

  const conversationId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`
  const encoder = new TextEncoder()
  const thinkingState = createThinkingParser()

  function sse(obj: any): Uint8Array {
    return encoder.encode("data: " + JSON.stringify(obj) + "\n\n")
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let binaryBuf = new Uint8Array(0)
        let textContent = ""
        let thinkingContent = ""
        const toolCalls: Array<{ id: string; name: string; input: string; inputObj?: Record<string, any> }> = []
        let curTool: { id: string; name: string; input: string; inputObj?: Record<string, any> } | null = null
        let sentFirstThinking = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Append to binary buffer
          const newBuf = new Uint8Array(binaryBuf.length + value.length)
          newBuf.set(binaryBuf)
          newBuf.set(value, binaryBuf.length)
          binaryBuf = newBuf

          // Parse AWS Event Stream messages
          let offset = 0
          while (offset + 12 <= binaryBuf.length) {
            const result = parseOneMessage(binaryBuf, offset)
            if (!result) {
              // Check if this is just incomplete data or truly invalid
              const totalLen =
                ((binaryBuf[offset] & 0xff) << 24) |
                ((binaryBuf[offset + 1] & 0xff) << 16) |
                ((binaryBuf[offset + 2] & 0xff) << 8) |
                (binaryBuf[offset + 3] & 0xff)
              if (totalLen < 16 || totalLen > 64 * 1024 * 1024) {
                offset++
                continue
              }
              // Incomplete message - wait for more data
              break
            }

            const { payload, nextOffset } = result
            offset = nextOffset

            if (!payload || !payload.startsWith("{")) continue

            try {
              const event = JSON.parse(payload)

              // Debug logging
              if (process.env.DEBUG_KIRO_STREAM === "1") {
                console.error("[kiro.stream.event]", JSON.stringify(event).slice(0, 500))
              }

              // Text content event
              if (event.content !== undefined && !event.toolUseId) {
                const rawText = event.content as string

                // Process through thinking parser
                const { thinking, content } = processThinkingChunk(thinkingState, rawText)

                // Stream thinking content as reasoning
                if (thinking) {
                  thinkingContent += thinking
                  // Emit as reasoning_content (OpenAI extended thinking format)
                  if (!sentFirstThinking) {
                    controller.enqueue(sse({
                      id: conversationId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{
                        index: 0,
                        delta: { role: "assistant", reasoning_content: thinking },
                        finish_reason: null,
                      }],
                    }))
                    sentFirstThinking = true
                  } else {
                    controller.enqueue(sse({
                      id: conversationId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{
                        index: 0,
                        delta: { reasoning_content: thinking },
                        finish_reason: null,
                      }],
                    }))
                  }
                }

                // Stream regular content
                if (content) {
                  textContent += content
                  controller.enqueue(sse({
                    id: conversationId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: { content },
                      finish_reason: null,
                    }],
                  }))
                }
              }

              // Tool use events
              if (event.toolUseId) {
                if (event.stop) {
                  if (curTool) {
                    toolCalls.push(curTool)
                    curTool = null
                  }
                } else if (curTool && curTool.id === event.toolUseId) {
                  // Continue existing tool
                  if (event.input !== undefined) {
                    if (typeof event.input === "string") {
                      curTool.input += event.input
                    } else {
                      if (!curTool.inputObj) {
                        try {
                          curTool.inputObj = curTool.input ? JSON.parse(curTool.input) : {}
                        } catch {
                          curTool.inputObj = {}
                        }
                      }
                      Object.assign(curTool.inputObj!, event.input as Record<string, any>)
                    }
                  }
                  if (event.name && !curTool.name) curTool.name = event.name
                } else {
                  // New tool
                  if (curTool) toolCalls.push(curTool)
                  if (typeof event.input === "string") {
                    curTool = { id: event.toolUseId, name: event.name || "", input: event.input }
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
            } catch {
              // Skip unparseable payloads
            }
          }

          // Keep unprocessed bytes
          if (offset > 0) binaryBuf = binaryBuf.slice(offset)
        }

        // Flush thinking parser
        const flushed = flushThinkingParser(thinkingState)
        if (flushed.thinking) {
          controller.enqueue(sse({
            id: conversationId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { reasoning_content: flushed.thinking },
              finish_reason: null,
            }],
          }))
        }
        if (flushed.content) {
          controller.enqueue(sse({
            id: conversationId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: flushed.content },
              finish_reason: null,
            }],
          }))
        }

        // Finalize remaining tool
        if (curTool) toolCalls.push(curTool)

        // Emit tool calls (chunked, like OpenAI streaming)
        const created = Math.floor(Date.now() / 1000)
        const CHUNK_SIZE = 512

        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]

          // Resolve final args
          let args: string
          if (tc.inputObj) {
            args = JSON.stringify(tc.inputObj)
          } else {
            args = tc.input || "{}"
            try {
              JSON.parse(args)
            } catch {
              args = "{}"
            }
          }

          // First chunk: id + type + name + start of arguments
          const firstPiece = args.slice(0, CHUNK_SIZE)
          controller.enqueue(sse({
            id: conversationId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: firstPiece },
                }],
              },
              finish_reason: null,
            }],
          }))

          // Subsequent chunks: arguments continuation
          for (let j = CHUNK_SIZE; j < args.length; j += CHUNK_SIZE) {
            const piece = args.slice(j, j + CHUNK_SIZE)
            controller.enqueue(sse({
              id: conversationId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{ index: i, function: { arguments: piece } }],
                },
                finish_reason: null,
              }],
            }))
          }
        }

        // Final stop chunk
        controller.enqueue(sse({
          id: conversationId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          }],
        }))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (err) {
        try {
          controller.enqueue(sse({
            id: conversationId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: `\n\n[Stream Error: ${err}]` },
              finish_reason: "stop",
            }],
          }))
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
      Connection: "keep-alive",
    },
  })
}
