import { describe, expect, test } from "bun:test"
import { planContext, roughTokens, yesAbove } from "../src/policy.ts"

const chunk = (id: string, text: string) => ({ id, text })

const history = [
  chunk("task", "rename the label"),
  chunk("weather", "lisbon"),
  chunk("grep", "the button"),
  chunk("edit", "i will edit it"),
  chunk("log", "x".repeat(2000)),
  chunk("latest", "just the label"),
]

const scores = [
  { id: "task", keep: 0.93 },
  { id: "weather", keep: 0.04 },
  { id: "grep", keep: 0.97 },
  { id: "edit", keep: 0.88 },
  { id: "log", keep: 0.02 },
]

describe("planContext", () => {
  test("a large early drop is worth a broken prefix", () => {
    const plan = planContext(history, ["task", "weather", "grep", "edit", "log"], scores, ["latest"])
    expect(plan.mode).toBe("prefix")
    expect(plan.ids).toEqual(["task", "grep", "edit", "latest"])
    expect(plan.prefix).toBe(1)
    expect(plan.savedTokens).toBeGreaterThan(400)
  })

  test("a small early drop keeps the cached prefix", () => {
    const chunks = [chunk("a", "short"), chunk("b", "also short"), chunk("c", "new")]
    const plan = planContext(chunks, ["a", "b"], [{ id: "a", keep: 0.1 }, { id: "b", keep: 0.9 }], ["c"])
    expect(plan.mode).toBe("hold")
    expect(plan.ids).toEqual(["a", "b", "c"])
    expect(plan.prefix).toBe(2)
    expect(plan.savedTokens).toBeLessThan(400)
  })

  test("an append leaves the prefix intact", () => {
    const chunks = [chunk("a", "x"), chunk("b", "y")]
    const plan = planContext(chunks, ["a"], [{ id: "a", keep: 0.9 }, { id: "b", keep: 0.9 }], [])
    expect(plan.mode).toBe("extend")
    expect(plan.ids).toEqual(["a", "b"])
    expect(plan.prefix).toBe(1)
  })

  test("a pin survives a low score", () => {
    const chunks = [chunk("a", "x".repeat(2000))]
    const plan = planContext(chunks, ["a"], [{ id: "a", keep: 0.01 }], ["a"])
    expect(plan.ids).toEqual(["a"])
    expect(plan.mode).toBe("extend")
  })
})

describe("constants", () => {
  test("the cutoff is half, and a long chunk is enough to pay for a cold prefill", () => {
    expect(yesAbove).toBe(0.5)
    expect(roughTokens("x".repeat(2000))).toBeGreaterThan(400)
  })
})
