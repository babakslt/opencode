import { expect, test } from "bun:test"
import type { PartRef, SessionEntry, SessionGroup, SessionRow } from "../../../src/routes/session/grouping/session"
import { rowAnchorTarget } from "../../../src/routes/session/anchors"
import {
  buildMarkerBandsWithShares,
  markerAnchorRow,
  rowMarkerKind,
  rowMarkerWeightDeep,
} from "../../../src/routes/session/markers"

type PartLike = { type: string; text?: string; command?: string }

const message = (messageID: string): SessionEntry => ({ type: "message", messageID })
const part = (messageID: string, partID: string): SessionEntry => ({ type: "part", ref: { messageID, partID } })
const child = (entry: SessionEntry) => ({ type: "entry" as const, entry, size: 1 as const })
const toolGroup = (children: SessionGroup["children"]) => ({
  type: "group" as const,
  kind: "activity" as const,
  pending: [],
  completed: true,
  size: children.length,
  children,
})
const reasoningGroup = (children: SessionGroup["children"]) => ({
  type: "group" as const,
  kind: "reasoning" as const,
  completed: true,
  size: children.length,
  children,
})
const resolve = (parts: Record<string, PartLike>) => (ref: PartRef) => parts[`${ref.messageID}:${ref.partID}`]

/** One turn of a tool-heavy transcript: a prompt, a tool group, then three derived rows. */
const turnRows = (turn: number): SessionRow[] => [
  message(`user-${turn}`),
  toolGroup([
    child(part(`assistant-${turn}`, "read-1")),
    child(part(`assistant-${turn}`, "bash-1")),
    child(part(`assistant-${turn}`, "grep-1")),
  ]),
  reasoningGroup([child(part(`assistant-${turn}`, "reasoning:0"))]),
  { type: "assistant-footer", messageID: `assistant-${turn}` },
  { type: "turn-usage", messageIDs: [`assistant-${turn}`] },
]

const toolHeavy = (turns: number) => Array.from({ length: turns }, (_, turn) => turnRows(turn)).flat()

function transcriptParts(turns: number) {
  return Object.fromEntries(
    Array.from({ length: turns }, (_, turn) => [
      [`user-${turn}:message`, { type: "user", text: `Prompt ${turn}` }],
      [`assistant-${turn}:read-1`, { type: "tool" }],
      [`assistant-${turn}:bash-1`, { type: "tool" }],
      [`assistant-${turn}:grep-1`, { type: "tool" }],
      [`assistant-${turn}:reasoning:0`, { type: "reasoning", text: `Thinking about step ${turn}` }],
    ]).flat(),
  )
}

/** Independent reference: same chain, written without index arithmetic on the shared helper. */
function referenceAnchor(rows: readonly SessionRow[], index: number, anchored: (row: SessionRow) => boolean) {
  if (rows[index] && anchored(rows[index]!)) return index
  const above: number[] = []
  const below: number[] = []
  rows.forEach((row, candidate) => {
    if (!anchored(row)) return
    if (candidate < index) above.push(candidate)
    if (candidate > index) below.push(candidate)
  })
  if (above.length > 0) return above[above.length - 1]
  if (below.length > 0) return below[0]
  return undefined
}

/** How much further the backward-first chain lands than the nearest anchored row overall. */
function walkOvershoot(rows: readonly SessionRow[], index: number, anchored: (row: SessionRow) => boolean) {
  const resolved = markerAnchorRow(rows, index, anchored)
  const nearest = rows.reduce<number | undefined>((best, row, candidate) => {
    if (!anchored(row)) return best
    if (best === undefined) return candidate
    return Math.abs(candidate - index) < Math.abs(best - index) ? candidate : best
  }, undefined)
  if (resolved === undefined || nearest === undefined) return 0
  return Math.abs(resolved - index) - Math.abs(nearest - index)
}

test("tool-heavy transcript: every band targets the row of its primary kind and resolves to an anchor", () => {
  const anchors = (row: SessionRow) => rowAnchorTarget(row) !== undefined
  const rows = [...toolHeavy(12), { type: "compaction-queued", inboxID: "i1" } as SessionEntry]
  const resolveRow = resolve(transcriptParts(12))
  const kinds = rows.map((row) => rowMarkerKind(row, resolveRow))
  const weights = rows.map((row) => rowMarkerWeightDeep(row, resolveRow, () => false))
  const cells = 60
  const bands = buildMarkerBandsWithShares(weights, kinds, cells)
  expect(bands).toHaveLength(cells)

  // Change 2: a band with a primary kind must target a row carrying that very kind, i.e. the row
  // that produced the colour — not the band's centre, whose kind may differ.
  const mistargeted = bands.filter((band) => band.kind !== undefined && kinds[band.row] !== band.kind)
  const unmarked = bands.filter((band) => band.kind === undefined).length

  const resolved = bands.map((band) => markerAnchorRow(rows, band.row, anchors))
  const unresolved = resolved.filter((index) => index === undefined).length
  const mismatched = resolved.filter((index, band) => index !== referenceAnchor(rows, bands[band]!.row, anchors)).length
  const notAnchored = resolved.filter((index) => index !== undefined && !anchors(rows[index]!)).length
  const overshoot = resolved.filter((_, band) => walkOvershoot(rows, bands[band]!.row, anchors) > 0).length
  const distances = resolved.map((index, band) => Math.abs(index! - bands[band]!.row))
  const adjacentCollisions = resolved.filter((index, band) => band > 0 && index === resolved[band - 1]).length
  // Cross-boundary collisions: a band that had to walk (its sampled row is derived) and landed on
  // the previous band's target.
  const crossing = resolved.filter(
    (index, band) => band > 0 && index === resolved[band - 1] && !anchors(rows[bands[band]!.row]),
  ).length

  console.log(
    `rows=${rows.length} unmarked=${unmarked}/${cells} mistargeted=${mistargeted.length} unresolved=${unresolved} ` +
      `mismatched=${mismatched} notAnchored=${notAnchored} backwardOvershootBands=${overshoot} ` +
      `maxWalk=${Math.max(...distances)} adjacentCollisions=${adjacentCollisions}/${cells - 1} ` +
      `crossBandCollisions=${crossing}`,
  )

  expect(mistargeted.map((band) => `${String(band.kind)}@${band.row}`)).toEqual([])
  expect(unresolved).toBe(0)
  expect(mismatched).toBe(0)
  expect(notAnchored).toBe(0)

  // Same shape at a realistic band density (60 turns, 301 rows, 60 cells).
  for (const turns of [60, 200]) {
    const dense = toolHeavy(turns)
    const resolveDense = resolve(transcriptParts(turns))
    const denseKinds = dense.map((row) => rowMarkerKind(row, resolveDense))
    const denseWeights = dense.map((row) => rowMarkerWeightDeep(row, resolveDense, () => false))
    const denseBands = buildMarkerBandsWithShares(denseWeights, denseKinds, cells)
    const denseResolved = denseBands.map((band) => markerAnchorRow(dense, band.row, anchors))
    const denseCollisions = denseResolved.filter((index, band) => band > 0 && index === denseResolved[band - 1]).length
    console.log(
      `density turns=${turns} rows=${dense.length} bands=${cells}: adjacentCollisions=${denseCollisions}/${cells - 1}`,
    )
    expect(denseResolved.filter((index) => index === undefined).length).toBe(0)
  }
})

test("backward walk never resolves further than the spec chain allows", () => {
  const anchors = (row: SessionRow) => rowAnchorTarget(row) !== undefined
  const rows = toolHeavy(6)
  let overshoot = 0
  for (let index = 0; index < rows.length; index++) {
    const resolved = markerAnchorRow(rows, index, anchors)
    expect(resolved).toBe(referenceAnchor(rows, index, anchors))
    overshoot += walkOvershoot(rows, index, anchors) > 0 ? 1 : 0
  }
  // Backward-first is the spec; when the next prompt is nearer than the previous tool row the
  // chain still lands on the previous row. Report how often, so the cost is visible.
  console.log(`backward-first overshoot rows (6 turns): ${overshoot}/${rows.length}`)
  expect(overshoot).toBeLessThan(rows.length / 3)
})

test("proportional fallback is the only option when nothing registers an anchor", () => {
  const none = () => false
  const rows = toolHeavy(3)
  for (let index = 0; index < rows.length; index++) expect(markerAnchorRow(rows, index, none)).toBeUndefined()
  // and it must not fire while any row is anchored, even a far one
  const lastAnchored = rows.findLastIndex((row) => rowAnchorTarget(row) !== undefined)
  const onlyLast = (row: SessionRow) => rows.indexOf(row) === lastAnchored
  expect(markerAnchorRow(rows, 0, onlyLast)).toBe(lastAnchored)
  // a single anchored row anywhere is enough for every band
  const oneAnchor = (row: SessionRow) => row === rows[0]
  expect(markerAnchorRow(rows, rows.length - 1, oneAnchor)).toBe(0)
})

test("dense derived cluster: adjacent bands sharing one target (collision rate)", () => {
  const anchors = (row: SessionRow) => rowAnchorTarget(row) !== undefined
  // Pathological shape: one prompt, then 40 derived rows in a row.
  const rows: SessionRow[] = [
    message("user-0"),
    ...Array.from({ length: 40 }, (_, index) => ({ type: "assistant-footer", messageID: `a-${index}` }) as SessionEntry),
  ]
  const resolveRow = resolve({ "user-0:message": { type: "user", text: "Prompt" } })
  const kinds = rows.map((row) => rowMarkerKind(row, resolveRow))
  const weights = rows.map((row) => rowMarkerWeightDeep(row, resolveRow, () => false))
  const bands = buildMarkerBandsWithShares(weights, kinds, 60)
  const resolved = bands.map((band) => markerAnchorRow(rows, band.row, anchors))
  const collisions = resolved.filter((index, band) => band > 0 && index === resolved[band - 1]).length
  console.log(`pathological one-anchor shape: collisions=${collisions}/${bands.length - 1}`)
  expect(resolved.every((index) => index === 0)).toBe(true)
})

test("perf: 4000 rows x 60 cells band recompute", () => {
  const rows: SessionRow[] = Array.from({ length: 4000 }, (_, index) => ({
    type: "part" as const,
    ref: { messageID: `m-${index}`, partID: "text:0" },
  }))
  const resolveRow = resolve(
    Object.fromEntries(rows.map((row, index) => [`m-${index}:text:0`, { type: "text", text: `Line ${index}` }])),
  )
  const run = () => {
    const kinds = rows.map((row) => rowMarkerKind(row, resolveRow))
    const weights = rows.map((row) => rowMarkerWeightDeep(row, resolveRow, () => true))
    return buildMarkerBandsWithShares(weights, kinds, 60)
  }
  run()
  const samples: number[] = []
  for (let i = 0; i < 12; i++) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  console.log(`perf 4000x60 recompute: median=${samples[6]!.toFixed(2)}ms min=${samples[0]!.toFixed(2)}ms`)
  expect(samples[6]!).toBeLessThan(50)
})
