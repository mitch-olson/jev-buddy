export const yesAbove = 0.5
export const coldPrefillTokens = 400

export type Chunk = {
  id: string
  text: string
}

export type Scored = {
  id: string
  keep: number
}

export type ContextPlan = {
  ids: string[]
  mode: "extend" | "prefix" | "hold"
  prefix: number
  savedTokens: number
}

export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function yes(probability: number): boolean {
  return probability > yesAbove
}

export function keepIds(chunks: Chunk[], scored: Scored[], pinned: string[]): string[] {
  const keep = new Map(scored.map((row) => [row.id, row.keep]))
  const pin = new Set(pinned)
  return chunks.filter((chunk) => pin.has(chunk.id) || (keep.get(chunk.id) ?? 1) > yesAbove).map((chunk) => chunk.id)
}

export function sharedPrefix(previous: string[], next: string[]): number {
  let index = 0
  while (index < previous.length && index < next.length && previous[index] === next[index]) index += 1
  return index
}

export function planContext(chunks: Chunk[], previous: string[], scored: Scored[], pinned: string[]): ContextPlan {
  const wanted = keepIds(chunks, scored, pinned)
  const prefix = sharedPrefix(previous, wanted)
  const dropped = new Set(previous.filter((id) => !wanted.includes(id)))
  const savedTokens = chunks.filter((chunk) => dropped.has(chunk.id)).reduce((sum, chunk) => sum + roughTokens(chunk.text), 0)
  if (prefix < previous.length && savedTokens < coldPrefillTokens) {
    const seen = new Set(previous)
    const held = previous.filter((id) => chunks.some((chunk) => chunk.id === id))
    const tail = chunks.map((chunk) => chunk.id).filter((id) => !seen.has(id))
    const ids = [...held, ...tail]
    return { ids, mode: "hold", prefix: sharedPrefix(previous, ids), savedTokens }
  }
  return { ids: wanted, mode: prefix === previous.length ? "extend" : "prefix", prefix, savedTokens }
}
