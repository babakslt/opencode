/**
 * QA suite (independent of the author's suite) for `src/routes/session/markers.ts`.
 *
 * Contains two independent reference implementations of `buildMarkerBands`:
 *  - `bandsExact`  : exact BigInt rational interval mapping (no floats at all)
 *  - `bandsSweep`  : float event-sweep segmentation (different structure)
 * plus a sampling smoke check. The SPEC PROBES section intentionally encodes the intended
 * rule rather than the implementation.
 */
import { expect, test } from "bun:test"
import type { GroupKind, PartRef, SessionEntry, SessionGroup } from "../../../src/routes/session/grouping/session"
import type { GroupNode } from "../../../src/routes/session/grouping/tree"
import {
  buildMarkerBands,
  markerColor,
  MIN_COLOURED_SHARE,
  NOMINAL_LINE_WIDTH,
  rowMarkerKind,
  rowMarkerWeight,
  type MarkerKind,
} from "../../../src/routes/session/markers"

type PartLike = { type: string; text?: string }
type Bands = (MarkerKind | undefined)[]

const message = (messageID: string): SessionEntry => ({ type: "message", messageID })
const part = (messageID: string, partID: string): SessionEntry => ({ type: "part", ref: { messageID, partID } })
const child = (entry: SessionEntry): GroupNode<SessionEntry, GroupKind> => ({ type: "entry", entry, size: 1 })
const group = (
  kind: GroupKind,
  children: readonly GroupNode<SessionEntry, GroupKind>[],
): SessionGroup & Extract<GroupNode<SessionEntry, GroupKind>, { type: "group" }> =>
  kind === "activity" || kind === "exploration"
    ? { type: "group", kind, children, size: children.length, completed: true, pending: [] }
    : { type: "group", kind, children, size: children.length, completed: true }

const resolve = (parts: Record<string, PartLike>) => (ref: PartRef) => parts[`${ref.messageID}:${ref.partID}`]
const none = () => undefined

const priority: MarkerKind[] = ["prompt", "tool", "thinking", "response"]
const coloured: MarkerKind[] = ["prompt", "tool", "thinking"]
const allKinds: (MarkerKind | undefined)[] = ["prompt", "thinking", "response", "tool", undefined]

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * The spec rule, in float fractions: the highest-priority coloured kind at or above the floor,
 * else the largest share overall (ties by priority).
 */
function pickKindShares(shares: Map<MarkerKind, number>): MarkerKind | undefined {
  for (const kind of coloured) if ((shares.get(kind) ?? 0) >= MIN_COLOURED_SHARE) return kind
  let best: MarkerKind | undefined
  let bestShare = 0
  priority.forEach((kind) => {
    const share = shares.get(kind) ?? 0
    if (share > bestShare) {
      best = kind
      bestShare = share
    }
  })
  return best
}

/** The same rule in the exact integer domain (`10 * overlap >= total`). */
function pickKindExact(shares: Map<MarkerKind, bigint>, total: bigint): MarkerKind | undefined {
  for (const kind of coloured) if (10n * (shares.get(kind) ?? 0n) >= total) return kind
  let best: MarkerKind | undefined
  let bestShare = 0n
  priority.forEach((kind) => {
    const share = shares.get(kind) ?? 0n
    if (share > bestShare) {
      best = kind
      bestShare = share
    }
  })
  return best
}

/** Reference A: exact rational (BigInt) interval mapping, integer weights only. */
function bandsExact(weights: number[], kinds: (MarkerKind | undefined)[], cellCount: number): Bands {
  const cells = Math.max(0, Math.trunc(cellCount))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const out: Bands = []
  for (let band = 0; band < cells; band++) {
    if (!(total > 0)) {
      out.push(undefined)
      continue
    }
    const bandStart = BigInt(band) * BigInt(total)
    const bandEnd = BigInt(band + 1) * BigInt(total)
    const shares = new Map<MarkerKind, bigint>()
    let position = 0n
    weights.forEach((weight, index) => {
      const start = position
      position = start + BigInt(weight) * BigInt(cells)
      const kind = kinds[index]
      if (weight <= 0 || kind === undefined) return
      const overlap = (bandEnd < position ? bandEnd : position) - (bandStart > start ? bandStart : start)
      if (overlap <= 0n) return
      shares.set(kind, (shares.get(kind) ?? 0n) + overlap)
    })
    out.push(pickKindExact(shares, BigInt(total)))
  }
  return out
}

/** Reference B: float event-sweep segmentation inside each band. */
function bandsSweep(weights: number[], kinds: (MarkerKind | undefined)[], cellCount: number): Bands {
  const cells = Math.max(0, Math.trunc(cellCount))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let position = 0
  const rows = weights.map((weight, index) => {
    const start = position
    position += weight / total
    return { start, end: position, kind: kinds[index], weight }
  })
  const out: Bands = []
  for (let band = 0; band < cells; band++) {
    if (!(total > 0)) {
      out.push(undefined)
      continue
    }
    const lower = band / cellCount
    const upper = (band + 1) / cellCount
    const points = [lower, upper]
    rows.forEach((row) => {
      if (row.start > lower && row.start < upper) points.push(row.start)
      if (row.end > lower && row.end < upper) points.push(row.end)
    })
    const sorted = [...new Set(points)].sort((a, b) => a - b)
    const shares = new Map<MarkerKind, number>()
    for (let index = 0; index + 1 < sorted.length; index++) {
      const left = sorted[index]
      const right = sorted[index + 1]
      if (right <= left) continue
      const mid = (left + right) / 2
      const row = rows.find((item) => item.weight > 0 && mid >= item.start && mid < item.end)
      if (!row || row.kind === undefined) continue
      shares.set(row.kind, (shares.get(row.kind) ?? 0) + (right - left))
    }
    out.push(pickKindShares(shares))
  }
  return out
}

/** Reference C: uniform sampling (majority of sampled positions inside the band). */
function bandsSampled(weights: number[], kinds: (MarkerKind | undefined)[], cellCount: number, samples = 1024): Bands {
  const cells = Math.max(0, Math.trunc(cellCount))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const out: Bands = []
  for (let band = 0; band < cells; band++) {
    if (!(total > 0)) {
      out.push(undefined)
      continue
    }
    const tally = new Map<MarkerKind, number>()
    for (let sample = 0; sample < samples; sample++) {
      const position = (band + (sample + 0.5) / samples) / cellCount
      const kind = kinds[positionToIndex(weights, total, position)]
      if (kind === undefined) continue
      tally.set(kind, (tally.get(kind) ?? 0) + 1)
    }
    out.push(pickKindShares(tally))
  }
  return out
}

function positionToIndex(weights: number[], total: number, position: number) {
  let cumulative = 0
  for (let index = 0; index < weights.length; index++) {
    cumulative += weights[index] / total
    if (position < cumulative) return index
  }
  return weights.length - 1
}

function report(label: string, mismatches: string[]) {
  if (mismatches.length === 0) return
  throw new Error(`${label}: ${mismatches.length} mismatch(es)\n${mismatches.slice(0, 12).join("\n")}`)
}

// ---------------------------------------------------------------- band length

test("band length equals cellCount for 0, negative, 1 and huge cell counts", () => {
  expect(buildMarkerBands([], [], 0)).toHaveLength(0)
  expect(buildMarkerBands([1, 2, 3], ["prompt", "tool", "response"], 1)).toHaveLength(1)
  expect(buildMarkerBands([1, 2, 3], ["prompt", "tool", "response"], 0)).toHaveLength(0)
  expect(buildMarkerBands([1, 2, 3], ["prompt", "tool", "response"], -1)).toHaveLength(0)
  expect(buildMarkerBands([1, 2, 3], ["prompt", "tool", "response"], -1000)).toHaveLength(0)
  expect(buildMarkerBands([1, 2, 3], ["prompt", "tool", "response"], 5000)).toHaveLength(5000)
  expect(buildMarkerBands([1], ["prompt"], 999)).toHaveLength(999)
  expect(buildMarkerBands([], [], 7)).toEqual(new Array(7).fill(undefined))
})

test("is deterministic for identical inputs, including float weights", () => {
  const rnd = rng(12345)
  for (let round = 0; round < 200; round++) {
    const weights = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => rnd() * 400)
    const kinds = weights.map(() => allKinds[Math.floor(rnd() * allKinds.length)])
    const cells = 20 + Math.floor(rnd() * 41)
    expect(buildMarkerBands(weights, kinds, cells)).toEqual(buildMarkerBands(weights, kinds, cells))
  }
})

// ------------------------------------------------- independent references

test("exact rational reference: 100 seeded cases, cellCount 20-60 (integer weights)", () => {
  const rnd = rng(20261015)
  const mismatches: string[] = []
  for (let round = 0; round < 100; round++) {
    const cells = 20 + Math.floor(rnd() * 41)
    const rows = 1 + Math.floor(rnd() * 30)
    const weights = Array.from({ length: rows }, () => Math.floor(rnd() * 11))
    const kinds = weights.map(() => allKinds[Math.floor(rnd() * allKinds.length)])
    const actual = buildMarkerBands(weights, kinds, cells)
    const expected = bandsExact(weights, kinds, cells)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const diff = actual.map((kind, band) => (kind === expected[band] ? null : `b${band}:${String(kind)}!=${String(expected[band])}`)).filter(Boolean)
      mismatches.push(`case${round} cells=${cells} w=[${weights}] k=[${kinds.map(String)}] diff=${diff.join(",")}`)
    }
  }
  report("exact reference mismatch", mismatches)
})

test("float event-sweep reference: 100 seeded cases, cellCount 20-60 (integer weights)", () => {
  const rnd = rng(777)
  const mismatches: string[] = []
  const artifacts: string[] = []
  for (let round = 0; round < 100; round++) {
    const cells = 20 + Math.floor(rnd() * 41)
    const rows = 1 + Math.floor(rnd() * 30)
    const weights = Array.from({ length: rows }, () => Math.floor(rnd() * 11))
    const kinds = weights.map(() => allKinds[Math.floor(rnd() * allKinds.length)])
    const actual = buildMarkerBands(weights, kinds, cells)
    const expected = bandsSweep(weights, kinds, cells)
    const exact = bandsExact(weights, kinds, cells)
    actual.forEach((kind, band) => {
      if (kind === expected[band]) return
      // The sweep resolves every segment by a float midpoint against a float running sum, so
      // a band that splits within one ulp of a row boundary gains a phantom sliver. That is
      // the resolution of the reference, not a disagreement: the exact reference settles it.
      if (exact[band] === kind) {
        artifacts.push(`case${round} b${band}: impl/exact=${String(kind)} sweep=${String(expected[band])}`)
        return
      }
      mismatches.push(
        `case${round} cells=${cells} w=[${weights}] k=[${kinds.map(String)}] b${band}: impl=${String(kind)} sweep=${String(expected[band])}`,
      )
    })
  }
  if (artifacts.length > 0) console.log(`event-sweep float resolution artifacts: ${artifacts.length}`)
  report("event-sweep mismatch", mismatches)
})

test("sampling reference smoke: 30 seeded cases (resolution-limited bands skipped)", () => {
  const rnd = rng(4242)
  const mismatches: string[] = []
  const artifacts: string[] = []
  for (let round = 0; round < 30; round++) {
    const cells = 20 + Math.floor(rnd() * 41)
    const rows = 2 + Math.floor(rnd() * 12)
    const weights = Array.from({ length: rows }, () => 1 + Math.floor(rnd() * 8))
    const kinds = weights.map(() => allKinds[Math.floor(rnd() * allKinds.length)])
    const actual = buildMarkerBands(weights, kinds, cells)
    const expected = bandsSampled(weights, kinds, cells)
    const exact = bandsExact(weights, kinds, cells)
    actual.forEach((kind, band) => {
      if (kind === expected[band]) return
      // a sliver smaller than the sampling resolution is not a disagreement
      if (exact[band] === kind) {
        artifacts.push(`case${round} b${band}: impl/exact=${String(kind)} sampled=${String(expected[band])}`)
        return
      }
      mismatches.push(`case${round} cells=${cells} w=[${weights}] k=[${kinds.map(String)}] b${band}: impl=${String(kind)} sampled=${String(expected[band])}`)
    })
  }
  if (artifacts.length > 0) console.log(`sampling resolution artifacts: ${artifacts.length}`)
  report("sampling mismatch", mismatches)
})

// --------------------------------------------------------- proportionality

test("proportionality: 10x weight occupies ~10x bands", () => {
  for (const cells of [20, 40, 60]) {
    const bands = buildMarkerBands([1, 10], ["prompt", "tool"], cells)
    const promptBands = bands.filter((kind) => kind === "prompt").length
    const toolBands = bands.filter((kind) => kind === "tool").length
    expect(promptBands + toolBands).toBe(cells)
    expect(Math.abs(promptBands - cells / 11)).toBeLessThanOrEqual(1)
    expect(Math.abs(toolBands - (10 * cells) / 11)).toBeLessThanOrEqual(1)
    expect(toolBands / promptBands).toBeGreaterThan(8)
    expect(toolBands / promptBands).toBeLessThan(12)
  }
})

test("exact ties resolve by priority on equal-weight sweeps", () => {
  const mismatches: string[] = []
  for (const weight of [1, 2, 3, 5, 7]) {
    for (const cells of [2, 3, 4, 5, 6, 8, 9, 12]) {
      for (const rows of [2, 3, 4]) {
        const weights = new Array(rows).fill(weight)
        const permutations = rows === 2 ? [["prompt", "tool"]] : rows === 3 ? [["response", "thinking", "tool"]] : [["response", "thinking", "tool", "prompt"]]
        for (const kinds of permutations) {
          const actual = buildMarkerBands(weights, kinds as MarkerKind[], cells)
          const expected = bandsExact(weights, kinds as MarkerKind[], cells)
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            mismatches.push(`w=${weight} cells=${cells} k=[${kinds}] actual=[${actual}] exact=[${expected}]`)
          }
        }
      }
    }
  }
  report("equal-weight tie mismatch vs exact reference", mismatches)
})

test("tie breakers: prompt > tool > thinking > response, independent of input order", () => {
  // single band, every kind exactly tied
  expect(buildMarkerBands([1, 1], ["response", "prompt"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([1, 1], ["prompt", "response"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([1, 1], ["response", "thinking"], 1)).toEqual(["thinking"])
  expect(buildMarkerBands([1, 1], ["thinking", "tool"], 1)).toEqual(["tool"])
  expect(buildMarkerBands([1, 1, 1, 1], ["response", "thinking", "tool", "prompt"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([1, 1, 1], ["response", "thinking", "tool"], 1)).toEqual(["tool"])
  expect(buildMarkerBands([1, 1, 1], ["tool", "thinking", "response"], 1)).toEqual(["tool"])
})

test("BUG minimal repro: an exact tie across 3+ kinds must go to the highest priority", () => {
  // three equal rows, one band: every share is exactly 1 -> the tie rule must pick tool
  expect(buildMarkerBands([1, 1, 1], ["tool", "thinking", "response"], 1)).toEqual(["tool"])
  expect(buildMarkerBands([7, 7, 7], ["tool", "thinking", "response"], 1)).toEqual(["tool"])
  expect(buildMarkerBands([3, 3, 3], ["tool", "thinking", "response"], 1)).toEqual(["tool"])
})

test("BUG from the seeded sweep: band 6 of a 20-cell layout is an exact thinking/response tie", () => {
  // total 40, cell 20 columns; band 6 = [0.300, 0.350)
  //   response row spans [0.200, 0.325) -> share 5 * (0.025 / 0.125) = 1
  //   thinking row spans [0.325, 0.500) -> share 7 * (0.025 / 0.175) = 1
  // exact tie -> priority thinking > response
  const weights = [5, 0, 3, 5, 7, 2, 8, 0, 10]
  const kinds: MarkerKind[] = ["prompt", "tool", "tool", "response", "thinking", "prompt", "prompt", "prompt", "thinking"]
  expect(buildMarkerBands(weights, kinds, 20)[6]).toBe("thinking")
})

test("BUG minimal repro: tied bands must not depend on row order", () => {
  const permutations = [
    ["tool", "thinking", "response"],
    ["tool", "response", "thinking"],
    ["thinking", "tool", "response"],
    ["thinking", "response", "tool"],
    ["response", "tool", "thinking"],
    ["response", "thinking", "tool"],
  ]
  const results = permutations.map((kinds) => ({ kinds, band: buildMarkerBands([1, 1, 1], kinds as MarkerKind[], 1)[0] }))
  const wrong = results.filter((result) => result.band !== "tool")
  expect(wrong.map((result) => `${result.kinds.join(",")} -> ${String(result.band)}`)).toEqual([])
})

test("BUG minimal repro: a band with zero true overlap must stay unmarked", () => {
  // total 5, rows: [0,0.4) unmarked, [0.4,0.6) prompt, [0.6,1) unmarked; 5 bands of 0.2
  // band 3 = [0.6,0.8) lies entirely inside the unmarked row -> undefined
  expect(buildMarkerBands([2, 1, 2], [undefined, "prompt", undefined], 5)[3]).toBeUndefined()
  expect(buildMarkerBands([4, 2, 4], [undefined, "prompt", undefined], 5)[3]).toBeUndefined()
  expect(buildMarkerBands([2, 1, 2], ["thinking", "response", "thinking"], 5)).toEqual([
    "thinking",
    "thinking",
    "response",
    "thinking",
    "thinking",
  ])
})

test("BUG sweep: no band with zero true overlap gets a kind, no tie goes to the wrong kind", () => {
  const variants: [number[], (MarkerKind | undefined)[]][] = [
    [[1, 1], ["thinking", "response"]],
    [[1, 1, 1], ["tool", "thinking", "response"]],
    [[1, 1, 1], ["prompt", "thinking", "response"]],
    [[1, 1, 1], [undefined, "prompt", undefined]],
    [[1, 1, 1, 1], ["prompt", "thinking", "tool", "response"]],
    [[2, 1, 2], [undefined, "prompt", undefined]],
    [[1, 2, 1], ["prompt", "thinking", "response"]],
    [[1, 1, 2, 2], ["prompt", "thinking", "tool", "response"]],
  ]
  const phantom: string[] = []
  const ties: string[] = []
  for (let cells = 2; cells <= 16; cells++) {
    for (let a = 1; a <= 8; a++) {
      for (let b = 1; b <= 8; b++) {
        for (const [base, kinds] of variants) {
          const weights = base.map((weight, index) => (index % 2 === 0 ? weight * a : weight * b))
          const actual = buildMarkerBands(weights, kinds, cells)
          const expected = bandsExact(weights, kinds, cells)
          actual.forEach((kind, band) => {
            if (kind === expected[band]) return
            const label = `cells=${cells} w=[${weights}] k=[${kinds.map(String)}] band=${band} impl=${String(kind)} exact=${String(expected[band])}`
            if (expected[band] === undefined) phantom.push(label)
            else ties.push(label)
          })
        }
      }
    }
  }
  report(
    `sweep: ${phantom.length} phantom band(s), ${ties.length} tie-break violation(s)`,
    [...phantom.slice(0, 6), ...ties.slice(0, 6)],
  )
})

test("a coloured sliver at or above the floor wins over a larger response", () => {
  expect(buildMarkerBands([51, 49], ["response", "prompt"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([49, 51], ["prompt", "response"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([5100, 4900], ["response", "prompt"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([50, 50], ["response", "prompt"], 1)).toEqual(["prompt"])
  // below the floor the response keeps the band
  expect(buildMarkerBands([990, 10], ["response", "prompt"], 1)).toEqual(["response"])
  expect(buildMarkerBands([1, 1], ["response", "prompt"], 2)).toEqual(["response", "prompt"])

  // a scoped band [0.25, 0.50): prompt covers 49% of the band, response 51% -> prompt is primary
  const scoped = [2500, 1225, 1275, 5000]
  expect(buildMarkerBands(scoped, ["tool", "prompt", "response", "thinking"], 4)[1]).toBe("prompt")
  const tied = [2500, 1250, 1250, 5000]
  expect(buildMarkerBands(tied, ["tool", "prompt", "response", "thinking"], 4)[1]).toBe("prompt")
})

// ------------------------------------------------------------------- edge cases

test("undefined kinds consume band space but never win", () => {
  const bands = buildMarkerBands([10, 1], [undefined, "prompt"], 10)
  expect(bands.filter((kind) => kind === undefined)).toHaveLength(9)
  expect(bands.filter((kind) => kind === "prompt")).toHaveLength(1)
  expect(bands[9]).toBe("prompt")
  expect(buildMarkerBands([1, 10], ["prompt", undefined], 10)[0]).toBe("prompt")
  expect(buildMarkerBands([1], [undefined], 5)).toEqual([undefined, undefined, undefined, undefined, undefined])
  // an undefined-kind row carrying most of the weight still leaves every band undefined
  expect(buildMarkerBands([100, 0], [undefined, "prompt"], 8)).toEqual(new Array(8).fill(undefined))
})

test("empty weights, zero total weight, single row", () => {
  expect(buildMarkerBands([], [], 6)).toEqual(new Array(6).fill(undefined))
  expect(buildMarkerBands([], ["prompt"], 4)).toEqual(new Array(4).fill(undefined))
  expect(buildMarkerBands([0, 0, 0], ["prompt", "tool", "response"], 5)).toEqual(new Array(5).fill(undefined))
  expect(buildMarkerBands([0], ["prompt"], 3)).toEqual(new Array(3).fill(undefined))
  expect(buildMarkerBands([7], ["thinking"], 5)).toEqual(new Array(5).fill("thinking"))
  expect(buildMarkerBands([7], ["thinking"], 0)).toEqual([])
  // rows with no kind entry (index past the kinds array) consume space but never win
  expect(buildMarkerBands([1, 1, 1], ["prompt"], 3)).toEqual(["prompt", undefined, undefined])
  expect(buildMarkerBands([1, 1], [], 2)).toEqual([undefined, undefined])
})

test("markerColor covers every kind and the unmarked case", () => {
  const colors = { agentAccent: "A", thinking: "B", info: "C", responseNeutral: "D" }
  expect(markerColor("prompt", colors)).toBe("A")
  expect(markerColor("thinking", colors)).toBe("B")
  expect(markerColor("tool", colors)).toBe("C")
  expect(markerColor("response", colors)).toBe("D")
  expect(markerColor(undefined, colors)).toBeUndefined()
})

// --------------------------------------------------------------------- weights

test("weights are finite, at least 1, and land on exact integers once scaled by the nominal width", () => {
  const lengths = [0, 1, 80, 81, 8000]
  const measured: number[] = []
  lengths.forEach((length) => {
    const text = "x".repeat(length)
    const parts = { "a:text:0": { type: "text", text }, "a:reasoning:0": { type: "reasoning", text }, "u:message": { type: "user", text } }
    const partWeight = rowMarkerWeight(part("a", "text:0"), resolve(parts))
    const reasoningWeight = rowMarkerWeight(part("a", "reasoning:0"), resolve(parts))
    const userWeight = rowMarkerWeight(message("u"), resolve(parts))
    measured.push(partWeight)
    ;[partWeight, reasoningWeight, userWeight].forEach((weight) => {
      expect(Number.isFinite(weight)).toBe(true)
      expect(Number.isNaN(weight)).toBe(false)
      expect(weight).toBeGreaterThanOrEqual(1)
      // Spec weights are fractional (`1 + length / NOMINAL_LINE_WIDTH`); scaling by the
      // nominal width is what makes the band math exact (see the SPEC PROBES section below).
      expect(Number.isInteger(weight * NOMINAL_LINE_WIDTH)).toBe(true)
    })
    expect(reasoningWeight).toBe(partWeight)
  })
  expect(measured[0]).toBe(1)
  // non-decreasing (80 and 1 chars round to the same nominal line), and 8000 grows a lot
  for (let index = 1; index < measured.length; index++) expect(measured[index]).toBeGreaterThanOrEqual(measured[index - 1])
  expect(measured[4]).toBeGreaterThan(measured[3])
})

test("empty text on a user message still weighs at least 1, even without a text field", () => {
  expect(rowMarkerWeight(message("u"), resolve({ "u:message": { type: "user", text: "" } }))).toBe(1)
  expect(rowMarkerWeight(message("u"), resolve({ "u:message": { type: "user" } }))).toBe(1)
  expect(rowMarkerWeight(message("u"), none)).toBe(1)
  expect(rowMarkerWeight(part("a", "text:0"), resolve({ "a:text:0": { type: "text" } }))).toBe(1)
  expect(rowMarkerWeight(part("a", "reasoning:0"), none)).toBe(1)
  expect(rowMarkerWeight(group("reasoning", [child(part("a", "reasoning:0"))]), none)).toBe(1)
  expect(rowMarkerWeight(message("s"), resolve({ "s:message": { type: "shell" } }))).toBe(1)
})

// ---------------------------------------------------------------- kind mapping

test("kind mapping for the real entry/message/part shapes", () => {
  const parts = {
    "u1:message": { type: "user", text: "hi" },
    "s1:message": { type: "shell" },
    "a1:reasoning:0": { type: "reasoning", text: "think" },
    "a1:text:0": { type: "text", text: "answer" },
    "a1:text:1": { type: "text", text: "more" },
    "a1:bash-1": { type: "tool" },
    "sy1:message": { type: "synthetic" },
    "a2:message": { type: "assistant" },
  }
  const parts2 = resolve(parts)
  expect(rowMarkerKind(message("u1"), parts2)).toBe("prompt")
  expect(rowMarkerKind(message("s1"), parts2)).toBe("tool")
  expect(rowMarkerKind(part("a1", "text:0"), parts2)).toBe("response")
  expect(rowMarkerKind(part("a1", "reasoning:0"), parts2)).toBe("thinking")
  expect(rowMarkerKind(part("a1", "bash-1"), parts2)).toBe("tool")
  expect(rowMarkerKind(message("sy1"), parts2)).toBeUndefined()
  expect(rowMarkerKind(message("a2"), parts2)).toBeUndefined()
})

test("part refs that resolve to nothing, or to messages that do not exist", () => {
  expect(rowMarkerKind(part("ghost", "text:0"), none)).toBeUndefined()
  expect(rowMarkerKind(part("ghost", "text:0"), resolve({ "other:text:0": { type: "text", text: "x" } }))).toBeUndefined()
  expect(rowMarkerKind(message("ghost"), none)).toBeUndefined()
  expect(rowMarkerKind(part("a1", "does-not-exist"), resolve({ "a1:text:0": { type: "text", text: "x" } }))).toBeUndefined()
  expect(rowMarkerKind(part("a1", "media-1"), resolve({ "a1:media-1": { type: "media" } }))).toBeUndefined()
  expect(rowMarkerWeight(part("ghost", "text:0"), none)).toBe(1)
  expect(rowMarkerWeight(message("ghost"), none)).toBe(1)
})

test("kind mapping for every group kind, including nested groups and a missing child", () => {
  const parts = {
    "a1:reasoning:0": { type: "reasoning", text: "think" },
    "a1:read-1": { type: "tool" },
    "a1:text:0": { type: "text", text: "answer" },
    "sy1:message": { type: "synthetic" },
  }
  const parts2 = resolve(parts)
  const missing = resolve({})

  expect(rowMarkerKind(group("reasoning", [child(part("a1", "reasoning:0"))]), parts2)).toBe("thinking")
  expect(rowMarkerKind(group("reasoning", []), parts2)).toBe("thinking")
  expect(rowMarkerKind(group("reasoning", [child(part("ghost", "reasoning:0"))]), missing)).toBe("thinking")
  expect(rowMarkerKind(group("activity", [child(part("a1", "read-1"))]), parts2)).toBe("tool")
  expect(rowMarkerKind(group("activity", []), parts2)).toBe("tool")
  expect(rowMarkerKind(group("exploration", [child(part("a1", "read-1"))]), parts2)).toBe("tool")
  expect(rowMarkerKind(group("exploration", []), parts2)).toBe("tool")
  expect(rowMarkerKind(group("instructions", [child(message("sy1"))]), parts2)).toBeUndefined()
  expect(rowMarkerKind(group("instructions", []), parts2)).toBeUndefined()
  // nested group as a direct child node (the real tree shape), not wrapped in an entry
  // the group's own kind wins: an activity summary marks tool use, not the thoughts inside
  expect(rowMarkerKind(group("activity", [group("reasoning", [child(part("a1", "reasoning:0"))])]), parts2)).toBe("tool")
})

test("derived rows (footer, usage, compaction, queued) never crash and stay unmarked", () => {
  const rows: SessionEntry[] = [
    { type: "assistant-footer", messageID: "a1" },
    { type: "turn-usage", messageIDs: ["a1"] },
    { type: "compaction-queued", inboxID: "i1" },
  ]
  rows.forEach((row) => {
    expect(rowMarkerKind(row, none)).toBeUndefined()
    expect(rowMarkerWeight(row, none)).toBe(1)
  })
})

test("kind mapping never throws for an unknown part/message type", () => {
  const weird = resolve({ "a1:text:0": { type: "" }, "u1:message": { type: "USER" }, "x:message": { type: "system", text: "x" } })
  expect(rowMarkerKind(part("a1", "text:0"), weird)).toBeUndefined()
  expect(rowMarkerKind(message("u1"), weird)).toBeUndefined()
  expect(rowMarkerKind(message("x"), weird)).toBeUndefined()
})

// ------------------------------------------------------------------ SPEC PROBES
// These encode the intended rule, not the implementation.
// A failure here is a spec/implementation divergence, not a broken test harness.

test("activity/exploration groups map to tool regardless of child share", () => {
  const parts = {
    "a1:reasoning:0": { type: "reasoning", text: "think" },
    "a1:reasoning:1": { type: "reasoning", text: "think more" },
    "a1:read-1": { type: "tool" },
  }
  const parts2 = resolve(parts)
  // spec: 'group kind "activity" | "exploration" -> tool'
  expect(rowMarkerKind(group("activity", [child(part("a1", "reasoning:0")), child(part("a1", "reasoning:1")), child(part("a1", "read-1"))]), parts2)).toBe("tool")
  // spec: 'group kind "reasoning" -> thinking' holds either way
  expect(rowMarkerKind(group("reasoning", [child(part("a1", "reasoning:0"))]), parts2)).toBe("thinking")
})

test("rowMarkerWeight uses 1 + text.length / 80", () => {
  const weight = rowMarkerWeight(part("a1", "text:0"), resolve({ "a1:text:0": { type: "text", text: "x".repeat(81) } }))
  expect(weight).toBe(1 + 81 / 80)
})
