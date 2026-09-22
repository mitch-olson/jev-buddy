import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tool } from "ai"
import { z } from "zod"

export function commandLeavesWorkspace(root: string, command: string): boolean {
  if (command.includes("~")) return true
  if (/\b(curl|wget|ssh|sudo|nc|rm)\b/.test(command)) return true
  const tokens = command.split(/[\s;'"`|&<>]+/)
  for (const token of tokens) {
    if (!token.includes("/") && !token.includes("..")) continue
    const resolved = path.resolve(root, token)
    const relative = path.relative(root, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return true
  }
  return false
}

function inside(root: string, target: string): string {
  const resolved = path.resolve(root, target)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path leaves the workspace")
  return resolved
}

export function shell(root: string, command: string): string {
  if (commandLeavesWorkspace(root, command)) return "blocked by the workspace sandbox"
  try {
    return execFileSync("/bin/bash", ["-lc", command], {
      cwd: root,
      timeout: 8000,
      maxBuffer: 100_000,
      encoding: "utf8",
    }).slice(0, 4000)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string }
    return [failed.stdout, failed.stderr, failed.message].filter(Boolean).join("\n").slice(0, 4000)
  }
}

export function makeTools(root: string) {
  return {
    read: tool({
      description: "Read a file in the workspace",
      inputSchema: z.object({ file: z.string() }),
      execute: async ({ file }) => readFileSync(inside(root, file), "utf8").slice(0, 8000),
    }),
    edit: tool({
      description: "Replace one exact string in an existing workspace file. Paths are relative to the workspace.",
      inputSchema: z.object({ file: z.string(), old: z.string(), next: z.string() }),
      execute: async ({ file, old, next }) => {
        const target = inside(root, file)
        let current: string
        try {
          current = readFileSync(target, "utf8")
        } catch {
          return `no such file: ${file}. use write to create it`
        }
        if (!current.includes(old)) return "old string was not in the file"
        writeFileSync(target, current.replace(old, next))
        return `edited ${file}`
      },
    }),
    write: tool({
      description: "Create or overwrite a workspace file. Paths are relative to the workspace.",
      inputSchema: z.object({ file: z.string(), content: z.string() }),
      execute: async ({ file, content }) => {
        const target = inside(root, file)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, content)
        return `wrote ${file}`
      },
    }),
    bash: tool({
      description: "Run a shell command in the workspace",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => shell(root, command),
    }),
  }
}
