import { describe, it, expect } from "bun:test"
import DefaultExport, { MultiKiroPlugin } from "../src/index.js"

// Minimal mock PluginInput
const mockInput = {
  client: { tui: { showToast: () => Promise.resolve() } },
} as any

describe("plugin contract", () => {
  it("default export is a function (Plugin type)", () => {
    expect(typeof DefaultExport).toBe("function")
  })

  it("named export MultiKiroPlugin is a function", () => {
    expect(typeof MultiKiroPlugin).toBe("function")
  })

  it('when called with mock input, returns object with auth.provider === "kiro"', async () => {
    const result = await MultiKiroPlugin(mockInput)
    expect(result.auth.provider).toBe("kiro")
  })

  it("auth.methods has exactly 2 entries", async () => {
    const result = await MultiKiroPlugin(mockInput)
    expect(result.auth.methods).toHaveLength(2)
  })

  it('auth.methods[0].label contains "kiro-cli"', async () => {
    const result = await MultiKiroPlugin(mockInput)
    expect(result.auth.methods[0].label.toLowerCase()).toContain("kiro-cli")
  })

  it('auth.methods[1].label contains "Manage"', async () => {
    const result = await MultiKiroPlugin(mockInput)
    expect(result.auth.methods[1].label).toContain("Manage")
  })
})
