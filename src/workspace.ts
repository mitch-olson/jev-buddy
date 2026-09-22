import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const runsRoot = path.join(import.meta.dir, "..", "runs")

export const slices = {
  plan: "Write the plan. Do not edit files.",
  code: "Create and edit files in the workspace. Paths are relative to the workspace root.",
  review: "Read the result and report defects. Do not edit.",
}

export function freshWorkspace(name?: string): string {
  const folder = name ?? new Date().toISOString().replace(/[:.]/g, "-")
  const root = path.join(runsRoot, folder)
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(runsRoot, "latest"), `${root}\n`)
  return root
}
