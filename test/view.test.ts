import path from "node:path"
import { describe, expect, test } from "bun:test"
import { commandLeavesWorkspace } from "../src/tools.ts"
import { piecesOf, project } from "../src/view.ts"
import type { ModelMessage } from "ai"

const long = Array.from({ length: 80 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n")

const messages: ModelMessage[] = [
  { role: "user", content: "what is the weather" },
  { role: "user", content: long },
  { role: "user", content: "keep this" },
]

describe("pieces", () => {
  test("a long message splits into hunks", () => {
    const pieces = piecesOf(messages)
    expect(pieces.filter((piece) => piece.messageIndex === 1).length).toBeGreaterThan(1)
  })

  test("a hidden early message drops out and a later one stays", () => {
    const pieces = piecesOf(messages)
    const kept = pieces.filter((piece) => piece.messageIndex !== 0).map((piece) => piece.id)
    const view = project(messages, kept)
    expect(view.some((message) => message.content === "what is the weather")).toBe(false)
    expect(view.some((message) => message.content === "keep this")).toBe(true)
  })
})

describe("shell", () => {
  test("paths that leave the workspace are refused", () => {
    const root = import.meta.dir
    expect(commandLeavesWorkspace(root, "cat view.test.ts")).toBe(false)
    expect(commandLeavesWorkspace(root, "git push origin main")).toBe(false)
    expect(commandLeavesWorkspace(root, `cat ${root}/view.test.ts`)).toBe(false)
    expect(commandLeavesWorkspace(root, "cat /etc/passwd")).toBe(true)
    expect(commandLeavesWorkspace(root, "cat ../../.ssh/id_rsa")).toBe(true)
    expect(commandLeavesWorkspace(root, `ls ${path.dirname(root)}`)).toBe(true)
    expect(commandLeavesWorkspace(root, "curl https://example.com")).toBe(true)
  })
})
