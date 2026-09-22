import type { ModelMessage } from "ai"
import { planContext, roughTokens, type Chunk, type ContextPlan, type Scored } from "./policy.ts"

export type Piece = Chunk & { messageIndex: number }

const hunkLines = 25

export function brief(message: ModelMessage): string {
  const content = message.content
  if (typeof content === "string") return content.replace(/\s+/g, " ").slice(0, 72)
  const text = content.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "tool-call") {
      const input = part.input as { file?: string; command?: string }
      if (input.file) return `${part.toolName} ${input.file}`
      if (input.command) return `${part.toolName} ${input.command}`
      return part.toolName
    }
    if (part.type === "tool-result") {
      const output = part.output as { value?: string }
      const value = typeof output?.value === "string" ? output.value : JSON.stringify(part.output)
      const one = value.replace(/\s+/g, " ")
      if (one.includes("ENOENT") || one.includes("no such file")) return "failed: no such file"
      if (one.includes("blocked by the workspace sandbox")) return "blocked: path left the workspace"
      return one.slice(0, 72)
    }
    return ""
  }).filter(Boolean).join(" ")
  return text.replace(/\s+/g, " ").slice(0, 72)
}

export function messageText(message: ModelMessage): string {
  const content = message.content
  if (typeof content === "string") return content
  return content.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "tool-result") return JSON.stringify(part.output)
    if (part.type === "tool-call") return JSON.stringify(part.input)
    return ""
  }).join("\n")
}

export function piecesOf(messages: ModelMessage[]): Piece[] {
  const pieces: Piece[] = []
  messages.forEach((message, index) => {
    const text = messageText(message)
    const lines = text.split("\n")
    if (lines.length <= hunkLines) {
      pieces.push({ id: String(index), text, messageIndex: index })
      return
    }
    for (let start = 0; start < lines.length; start += hunkLines) {
      pieces.push({
        id: `${index}.${start}`,
        text: lines.slice(start, start + hunkLines).join("\n"),
        messageIndex: index,
      })
    }
  })
  return pieces
}

export function project(messages: ModelMessage[], kept: string[]): ModelMessage[] {
  const pieces = piecesOf(messages)
  const keep = new Set(kept)
  return messages.flatMap((message, index) => {
    if (typeof message.content !== "string") return [message]
    const mine = pieces.filter((piece) => piece.messageIndex === index)
    const staying = mine.filter((piece) => keep.has(piece.id))
    if (staying.length === 0) return []
    if (staying.length === mine.length) return [message]
    return [{ ...message, content: staying.map((piece) => piece.text).join("\n") }]
  })
}

export function applyPlan(messages: ModelMessage[], previous: string[], scored: Scored[], pinned: string[]): { messages: ModelMessage[]; plan: ContextPlan } {
  const pieces = piecesOf(messages)
  const plan = planContext(pieces, previous, scored, pinned)
  return { messages: project(messages, plan.ids), plan }
}

export function logTokens(text: string): number {
  return roughTokens(text)
}
