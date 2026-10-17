/**
 * Guards for the marker band kernel. Two behaviours the other suites only sample:
 *   - a band's `row` is the row holding the primary kind's largest overlap, so a click lands on
 *     what it coloured (checked against an independent per-band overlap computation);
 *   - the `MIN_COLOURED_SHARE` floor is decided in the exact integer domain, at the boundary and
 *     when the same ratio is scaled.
 */
import { expect, test } from "bun:test"
import {
  buildMarkerBandsWithShares,
  MIN_COLOURED_SHARE,
  NOMINAL_LINE_WIDTH,
  type MarkerKind,
} from "../../../src/routes/session/markers"

type Kind = MarkerKind | undefined

/** Overlap of every row with one band, in the same scaled integer domain the kernel compares in. */
function overlaps(weights: number[], cells: number, band: number) {
  const exact = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? Math.round(weight * NOMINAL_LINE_WIDTH) : 0,
  )
  const total = exact.reduce((sum, weight) => sum + weight, 0)
  const bandStart = band * total
  const bandEnd = (band + 1) * total
  let position = 0
  return exact.map((weight) => {
    const start = position * cells
    position += weight
    return Math.max(0, Math.min(bandEnd, position * cells) - Math.max(bandStart, start))
  })
}

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

test("a band's row is a row of its own primary kind, holding that kind's largest overlap", () => {
  const rnd = rng(0xb0a7)
  const kinds = ["prompt", "thinking", "response", "tool", undefined] as Kind[]
  const failures: string[] = []
  for (let round = 0; round < 200; round++) {
    const rows = 1 + Math.floor(rnd() * 40)
    const cells = 2 + Math.floor(rnd() * 59)
    const weights = Array.from({ length: rows }, () => Math.floor(rnd() * 11))
    const rowKinds = weights.map(() => kinds[Math.floor(rnd() * kinds.length)])
    buildMarkerBandsWithShares(weights, rowKinds, cells).forEach((cell, band) => {
      if (cell.kind === undefined) return
      const overlap = overlaps(weights, cells, band)
      const best = Math.max(...rowKinds.flatMap((kind, row) => (kind === cell.kind ? [overlap[row]!] : [])))
      if (rowKinds[cell.row] !== cell.kind)
        failures.push(`r${round} b${band}: row ${cell.row} kind ${String(rowKinds[cell.row])} != ${cell.kind}`)
      if (overlap[cell.row] !== best)
        failures.push(`r${round} b${band}: overlap ${overlap[cell.row]} != max ${best} for ${cell.kind}`)
    })
  }
  expect(failures.slice(0, 10)).toEqual([])
})

test("floor boundary: exactly 1/10 is coloured, one integer unit under is not, at any scale", () => {
  // cells=1 makes the band the whole track, so a row's share is exactly its weight share.
  expect(buildMarkerBandsWithShares([1, 9], ["prompt", "response"], 1)[0]!.kind).toBe("prompt")
  expect(buildMarkerBandsWithShares([9, 91], ["prompt", "response"], 1)[0]!.kind).toBe("response")
  expect(buildMarkerBandsWithShares([1, 9], ["prompt", "response"], 1)[0]!.share).toBeCloseTo(
    MIN_COLOURED_SHARE,
    12,
  )
  for (const scale of [8, 80, 800, 8000]) {
    expect(buildMarkerBandsWithShares([scale, 9 * scale], ["prompt", "response"], 1)[0]!.kind).toBe("prompt")
    expect(buildMarkerBandsWithShares([9 * scale, 91 * scale], ["prompt", "response"], 1)[0]!.kind).toBe("response")
  }
})

test("a coloured kind under the floor only wins when it is still the largest share of the band", () => {
  // prompt 9%, response 8%, unmarked 83%: nothing reaches the floor, so the largest share overall
  // takes the band — a coloured kind below the floor.
  const sliver = buildMarkerBandsWithShares([9, 8, 83], ["prompt", "response", undefined], 1)[0]!
  expect(sliver.kind).toBe("prompt")
  expect(sliver.share).toBeLessThan(MIN_COLOURED_SHARE)
  // prompt 9%, response 60%: the below-floor prompt is not shown at all.
  const response = buildMarkerBandsWithShares([9, 60, 31], ["prompt", "response", undefined], 1)[0]!
  expect(response.kind).toBe("response")
  expect(response.secondary).toBeUndefined()
})
