import { describe, expect, it } from "bun:test"
import { repairHistoryToolPairs, transformRequest } from "../src/transform.js"

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

describe("repairHistoryToolPairs", () => {
  it("drops orphaned toolResults left behind after front-trimming removed their toolUse", () => {
    // Front-trimming shifted off the assistant turn that carried toolUseId "t1",
    // leaving a user turn with a toolResult that now points nowhere.
    const history = [
      {
        userInputMessage: {
          content: "here is the result",
          userInputMessageContext: {
            toolResults: [{ toolUseId: "t1", content: [{ text: "done" }], status: "success" }],
          },
        },
      },
    ]

    const repaired = repairHistoryToolPairs(history)

    expect(repaired[0].userInputMessage.userInputMessageContext).toBeUndefined()
  })

  it("shifts history to start on a user turn when it begins with an assistant turn", () => {
    const history = [
      { assistantResponseMessage: { content: "stray assistant turn", toolUses: [] } },
      { userInputMessage: { content: "first real user turn" } },
    ]

    const repaired = repairHistoryToolPairs(history)

    expect(repaired.length).toBe(1)
    expect(repaired[0].userInputMessage.content).toBe("first real user turn")
  })

  it("preserves a toolResult whose matching toolUse is still present earlier in history", () => {
    const history = [
      { userInputMessage: { content: "do the thing" } },
      {
        assistantResponseMessage: {
          content: "",
          toolUses: [{ toolUseId: "t1", name: "foo", input: {} }],
        },
      },
      {
        userInputMessage: {
          content: "here is the result",
          userInputMessageContext: {
            toolResults: [{ toolUseId: "t1", content: [{ text: "done" }], status: "success" }],
          },
        },
      },
    ]

    const repaired = repairHistoryToolPairs(history)

    expect(repaired.length).toBe(3)
    expect(repaired[2].userInputMessage.userInputMessageContext.toolResults).toEqual([
      { toolUseId: "t1", content: [{ text: "done" }], status: "success" },
    ])
  })
})
