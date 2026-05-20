import { describe, expect, it } from "bun:test"
import { transformRequest } from "../src/transform.js"

const mockAccount: any = {
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
}

describe("transformRequest context preservation", () => {
  it("uses latest user message as current message instead of synthetic Continue", () => {
    const payload = transformRequest(
      {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "first task" },
          { role: "assistant", content: "tool done" },
          { role: "assistant", content: "more status" },
        ],
      },
      mockAccount,
    )

    const current = payload?.conversationState?.currentMessage?.userInputMessage?.content
    expect(current).toContain("first task")
    expect(current).not.toContain("Continue")
  })

  it("keeps developer message in conversation flow (not folded into system prompt)", () => {
    const payload = transformRequest(
      {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "system", content: "system-rules" },
          { role: "developer", content: "developer-instruction" },
          { role: "user", content: "user-question" },
        ],
      },
      mockAccount,
    )

    const current = payload?.conversationState?.currentMessage?.userInputMessage?.content || ""
    const firstHistory = payload?.conversationState?.history?.[0]?.userInputMessage?.content || ""

    // system prompt should still be injected
    expect(current.includes("system-rules") || firstHistory.includes("system-rules")).toBeTrue()
    // developer stays as conversation content somewhere in history/current
    expect(current.includes("developer-instruction") || firstHistory.includes("developer-instruction")).toBeTrue()
  })

  it("does not synthesize Continue when messages are empty", () => {
    const payload = transformRequest({ model: "claude-sonnet-4-5", messages: [] }, mockAccount)
    const current = payload?.conversationState?.currentMessage?.userInputMessage?.content || ""
    expect(current).not.toContain("Continue")
  })
})
