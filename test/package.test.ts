import { describe, it, expect } from "bun:test"
import pkg from "../package.json"

describe("package.json exports shape", () => {
  it('has "main" pointing to dist/index.js', () => {
    expect(pkg.main).toBe("./dist/index.js")
  })

  it('has "types" pointing to dist/index.d.ts', () => {
    expect(pkg.types).toBe("./dist/index.d.ts")
  })

  it('has opencode.type = "plugin"', () => {
    expect((pkg as any).opencode.type).toBe("plugin")
  })

  it('has opencode.hooks including "auth" and "config"', () => {
    const hooks: string[] = (pkg as any).opencode.hooks
    expect(hooks).toContain("auth")
    expect(hooks).toContain("config")
  })
})
