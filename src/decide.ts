import { experimental_evaluate as evaluate, type ModelMessage } from "ai"
import { roughTokens, yes } from "./policy.ts"
import { applyPlan, brief, piecesOf, type Piece } from "./view.ts"
import { slices } from "./workspace.ts"

type BooleanAnswer = { type: "boolean"; probability: number }
type ChoiceAnswer = { type: "choice"; choice: string }
type Answer = BooleanAnswer | ChoiceAnswer

export type DecisionRow = {
  id: string
  role: string
  preview: string
  keep: number | null
  verdict: "keep" | "hide" | "pin"
}

export type Decision = {
  messages: ModelMessage[]
  tools: Array<"read" | "edit" | "write" | "bash">
  mounts: { read: number; edit: number; write: number; bash: number }
  rows: DecisionRow[]
  slice: keyof typeof slices
  sent: string[]
  hidden: string[]
  mode: "extend" | "prefix" | "hold"
  prefix: number
  savedTokens: number
  windowBefore: number
  windowAfter: number
  jevIn: number
  jevOut: number
}

function pieceQuestion(piece: Piece) {
  return {
    type: "boolean" as const,
    instructions: `Does the writer still need this earlier turn to do the ask?\n\n${piece.text.slice(0, 3000)}`,
    criteria: {
      true: "Hiding it would drop a path, an edit, or a fact the ask depends on",
      false: "It is off the ask, or a later turn already superseded it",
    },
  }
}

export async function decide(messages: ModelMessage[], previous: string[], pinnedIndexes: number[], currentAsk = ""): Promise<Decision> {
  const pieces = piecesOf(messages)
  const pinned = new Set(pieces.filter((piece) => pinnedIndexes.includes(piece.messageIndex)).map((piece) => piece.id))
  const questions: Record<string, ReturnType<typeof pieceQuestion> | { type: "boolean"; instructions: string; criteria: { true: string; false: string } } | { type: "choice"; instructions: string; criteria: Record<string, string> }> = {
    mount_read: {
      type: "boolean",
      instructions: "Mount read? It opens an existing file. Read the user lines in the state, not only the latest sentence.",
      criteria: { true: "The writer needs to see a file before changing it", false: "Nothing on disk needs to be opened" },
    },
    mount_edit: {
      type: "boolean",
      instructions: "Mount edit? It changes a file that already exists. Read the user lines in the state.",
      criteria: { true: "An existing file needs a change", false: "No existing file needs a change" },
    },
    mount_write: {
      type: "boolean",
      instructions: "Mount write? It creates files. A short latest line like 'do it' or 'build it' still means write when an earlier user line asked for an app, a page, or a new file.",
      criteria: { true: "A file still has to be created", false: "They only wanted a plan, or the files are already written and they did not ask to change them" },
    },
    mount_bash: {
      type: "boolean",
      instructions: "Mount bash? It runs a command in the workspace. Do not mount it just because they said to build an app.",
      criteria: { true: "A command has to run", false: "Creating files does not need a shell" },
    },
    slice: {
      type: "choice",
      instructions: "Which slice should be pinned? Read every user line. 'Do it' or 'build it' after a plan means they want the files now.",
      criteria: {
        plan: "They asked what to do, and have not said to build it.",
        code: "They want files created or changed now, including a short 'do it' or 'build it'.",
        review: "They want a look at files that already exist, and no change.",
      },
    },
  }
  for (const piece of pieces) {
    if (pinned.has(piece.id)) continue
    questions[`keep_${piece.id.replaceAll(".", "_")}`] = pieceQuestion(piece)
  }
  const result = await evaluate({
    model: "typesafe-ai/jev",
    state: {
      latest: currentAsk,
      user: messages.flatMap((message) => message.role === "user" && typeof message.content === "string" ? [message.content] : []).slice(-8),
    },
    questions,
  })
  const answers = result.answers as Record<string, Answer>
  const scored = pieces.flatMap((piece) => {
    if (pinned.has(piece.id)) return []
    const answer = answers[`keep_${piece.id.replaceAll(".", "_")}`]
    if (!answer || answer.type !== "boolean") return []
    return [{ id: piece.id, keep: answer.probability }]
  })
  const applied = applyPlan(messages, previous, scored, [...pinned])
  const hidden = pieces.filter((piece) => !applied.plan.ids.includes(piece.id)).map((piece) => piece.id)
  const mounts = { read: 0, edit: 0, write: 0, bash: 0 }
  for (const name of ["read", "edit", "write", "bash"] as const) {
    const answer = answers[`mount_${name}`]
    if (answer?.type === "boolean") mounts[name] = answer.probability
  }
  const tools = (["read", "edit", "write", "bash"] as const).filter((name) => yes(mounts[name]))
  if (tools.includes("edit") && !tools.includes("write")) tools.push("write")
  const sentIds = new Set(applied.plan.ids)
  const rows: DecisionRow[] = pieces.map((piece) => ({
    id: piece.id,
    role: messages[piece.messageIndex]?.role ?? "piece",
    preview: typeof messages[piece.messageIndex]?.content === "string" ? piece.text.replace(/\s+/g, " ").slice(0, 72) : brief(messages[piece.messageIndex]!),
    keep: pinned.has(piece.id) ? null : scored.find((row) => row.id === piece.id)?.keep ?? null,
    verdict: pinned.has(piece.id) ? "pin" : sentIds.has(piece.id) ? "keep" : "hide",
  }))
  const windowBefore = pieces.reduce((sum, piece) => sum + roughTokens(piece.text), 0)
  const windowAfter = pieces.filter((piece) => sentIds.has(piece.id)).reduce((sum, piece) => sum + roughTokens(piece.text), 0)
  const sliceAnswer = answers.slice
  const slice = sliceAnswer?.type === "choice" && sliceAnswer.choice in slices ? sliceAnswer.choice as keyof typeof slices : "code"
  return {
    messages: applied.messages,
    tools,
    mounts,
    rows,
    slice,
    sent: applied.plan.ids,
    hidden,
    mode: applied.plan.mode,
    prefix: applied.plan.prefix,
    savedTokens: applied.plan.savedTokens,
    windowBefore,
    windowAfter,
    jevIn: result.usage.inputTokens ?? 0,
    jevOut: result.usage.outputTokens ?? 0,
  }
}

export async function allowCommand(command: string, body?: string, currentAsk = ""): Promise<number> {
  const result = await evaluate({
    model: "typesafe-ai/jev",
    state: { ask: currentAsk, command, body: body ?? "" },
    questions: {
      allow: {
        type: "boolean",
        instructions: "May this command run with no person in the loop?",
        criteria: {
          true: "A read of the workspace, or a local search",
          false: "A push, a secret, a write outside the ask, or anything a person should see first",
        },
      },
    },
  })
  return result.answers.allow.probability
}
