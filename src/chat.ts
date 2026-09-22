import { createInterface } from "node:readline/promises"
import { createWriteStream, mkdirSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { generateText, isStepCount, type ModelMessage } from "ai"
import { allowCommand, decide, type Decision } from "./decide.ts"
import { makeTools } from "./tools.ts"
import { freshWorkspace, slices } from "./workspace.ts"

const writer = "openai/gpt-5-mini"
const colorOn = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)

function paint(code: string, text: string): string {
  if (!colorOn) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

function rule(label: string, code: string): string {
  return paint(code, `── ${label} ${"─".repeat(Math.max(8, 28 - label.length))}`)
}

const roleName: Record<string, string> = { user: "you", assistant: "agent", tool: "result" }

function panel(decision: Decision): string {
  const tone: Record<Decision["rows"][number]["verdict"], string> = { hide: "31", keep: "32", pin: "36" }
  const sent = new Set(decision.sent)
  const lineFor = (row: Decision["rows"][number]) => {
    const probability = row.keep === null ? "  - " : row.keep.toFixed(2)
    const who = (roleName[row.role] ?? row.role).padEnd(6)
    return paint(tone[row.verdict], `  ${row.verdict.padEnd(4)} ${probability}  ${who} ${row.preview}`)
  }
  const hidden = decision.rows.filter((row) => row.verdict === "hide")
  const tools = (["read", "write", "edit", "bash"] as const).map((name) => {
    const on = decision.tools.includes(name)
    const text = `${name} ${decision.mounts[name].toFixed(2)} ${on ? "on" : "off"}`
    return on ? paint("32", text) : paint("31", text)
  })
  const going = decision.rows.filter((row) => sent.has(row.id))
  const heldBack = Math.max(0, decision.windowBefore - decision.windowAfter)
  const share = decision.windowBefore === 0 ? 0 : Math.round((heldBack / decision.windowBefore) * 100)
  const width = 32
  const keptCols = decision.windowBefore === 0 ? 0 : Math.round((decision.windowAfter / decision.windowBefore) * width)
  const bar = paint("32", "█".repeat(keptCols)) + paint("31", "█".repeat(Math.max(0, width - keptCols)))
  return [
    "",
    rule("jev", "35"),
    paint("35", `${decision.jevIn} in, ${decision.jevOut} out`),
    `${bar}  ${decision.windowAfter} sent, ${decision.windowBefore} in history`,
    heldBack ? paint("31", `held back ${heldBack} rough tokens, ${share}% of the history`) : paint("32", "held nothing back"),
    paint("35", "history"),
    ...decision.rows.map(lineFor),
    paint("35", "sent to the writer"),
    ...(going.length ? going.map(lineFor) : [paint("35", "  nothing")]),
    hidden.length ? paint("31", `hid ${hidden.length}. the writer does not see those lines.`) : paint("32", "hid nothing."),
    `tools  ${tools.join("  ")}`,
    paint("35", `slice ${decision.slice}`),
    paint("35", `cache ${decision.mode}, prefix ${decision.prefix}, drop ${decision.savedTokens}`),
  ].join("\n")
}

function rateWait(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes("Rate limit")) return undefined
  const match = message.match(/Retry after (\d+)/)
  return Number(match?.[1] ?? 60)
}

async function speak(run: () => Promise<Awaited<ReturnType<typeof generateText>>>): Promise<Awaited<ReturnType<typeof generateText>>> {
  try {
    return await run()
  } catch (error) {
    const wait = rateWait(error)
    if (wait === undefined) throw error
    emit(`\nrate limit. waiting ${wait}s`)
    await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    return run()
  }
}

const logsDir = path.join(import.meta.dir, "..", "logs")
mkdirSync(logsDir, { recursive: true })
const logPath = path.join(logsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
const latestPath = path.join(logsDir, "latest.log")
const log = createWriteStream(logPath, { flags: "a" })
try {
  unlinkSync(latestPath)
} catch {
  // no previous session
}
symlinkSync(logPath, latestPath)

function emit(text: string) {
  console.log(text)
  log.write(text.replace(/\x1b\[[0-9;]*m/g, "") + "\n")
}

const given = process.argv[2]
const root = !given ? freshWorkspace() : given.includes("/") || given.startsWith(".") ? path.resolve(given) : freshWorkspace(given)
const key = process.env.AI_GATEWAY_API_KEY
if (!key) {
  console.error("Set AI_GATEWAY_API_KEY.")
  process.exit(1)
}

const messages: ModelMessage[] = []
let previous: string[] = []
let last = ""
const tools = makeTools(root)
const rl = createInterface({ input: process.stdin, output: process.stdout })

emit(paint("1;33", root))
emit(paint("2", `writer ${writer}`))
emit(paint("2", `log ${logPath}`))
emit(paint("2", "Yellow is you. Magenta is Jev. Blue is the agent. /context reprints the last call. /quit leaves."))
rl.setPrompt(paint("33", "you ") )
if (process.stdin.isTTY) rl.prompt()

for await (const entry of rl) {
  const text = entry.trim()
  if (!text) {
    if (process.stdin.isTTY) rl.prompt()
    continue
  }
  if (text === "/quit" || text === "/exit") break
  if (text === "/context") {
    console.log(last || "no jev call yet")
    if (process.stdin.isTTY) rl.prompt()
    continue
  }
  emit(`\n${rule("you", "33")}\n${paint("33", text)}`)
  messages.push({ role: "user", content: text })
  const turnStart = messages.length - 1
  let prior = previous
  const result = await speak(() => generateText({
    model: writer,
    reasoning: "minimal",
    messages,
    tools,
    stopWhen: isStepCount(6),
    maxRetries: 0,
    timeout: { stepMs: 90_000, totalMs: 240_000 },
    prepareStep: async ({ initialMessages, responseMessages }) => {
      const full = [...initialMessages, ...responseMessages]
      const live = full.flatMap((message, index) => message.role === "user" || index >= turnStart ? [index] : [])
      const decision = await decide(full, prior, live, text)
      prior = decision.sent
      previous = decision.sent
      last = panel(decision)
      emit(last)
      return {
        instructions: `${slices[decision.slice]}\nWorkspace root: ${root}\nPaths are relative to that root.`,
        messages: decision.messages,
        activeTools: decision.tools,
      }
    },
    toolApproval: async ({ toolCall }) => {
      if (toolCall.toolName !== "bash" || toolCall.dynamic) return undefined
      const command = String(toolCall.input.command)
      const probability = await allowCommand(command, undefined, text)
      const verdict = probability > 0.5 ? "allow" : "hold"
      emit(paint("35", `\njev  ${verdict} ${probability.toFixed(2)}  ${command}`))
      if (verdict === "hold") return { type: "denied", reason: "Jev held this command" }
      return undefined
    },
    onToolExecutionStart({ toolCall }) {
      if (toolCall.dynamic) return
      const input = JSON.stringify(toolCall.input)
      emit(paint("34", `\ntool  ${toolCall.toolName}  ${input}`))
    },
  }))
  const usage = result.totalUsage
  emit(`\n${rule("agent", "34")}\n${result.text}`)
  emit(paint("2", `\nwriter  ${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out, cache read ${usage.inputTokenDetails?.cacheReadTokens ?? 0}\n`))
  messages.push(...result.responseMessages)
  if (process.stdin.isTTY) rl.prompt()
}

rl.close()
log.end()
