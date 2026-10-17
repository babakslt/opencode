import { expect, test } from "bun:test"
import type { PartRef, SessionEntry, SessionGroup, SessionRow } from "../../../src/routes/session/grouping/session"
import { rowAnchorTarget } from "../../../src/routes/session/anchors"
import {
  buildMarkerBands,
  buildMarkerBandsWithShares,
  markerAnchorRow,
  markerColor,
  MIN_COLOURED_SHARE,
  NOMINAL_LINE_WIDTH,
  rowMarkerKind,
  rowMarkerWeight,
  rowMarkerWeightDeep,
} from "../../../src/routes/session/markers"

type PartLike = { type: string; text?: string; command?: string }

const message = (messageID: string): SessionEntry => ({ type: "message", messageID })
const part = (messageID: string, partID: string): SessionEntry => ({ type: "part", ref: { messageID, partID } })
const child = (entry: SessionEntry) => ({ type: "entry" as const, entry, size: 1 as const })
const reasoningGroup = (children: SessionGroup["children"]) => ({
  type: "group" as const,
  kind: "reasoning" as const,
  completed: true,
  size: children.length,
  children,
})
const toolGroup = (kind: "activity" | "exploration", children: SessionGroup["children"]) => ({
  type: "group" as const,
  kind,
  pending: [],
  completed: true,
  size: children.length,
  children,
})

const resolve = (parts: Record<string, PartLike>) => (ref: PartRef) => parts[`${ref.messageID}:${ref.partID}`]

test("maps prompt, shell and part rows to their marker kind", () => {
  const parts = {
    "user-1:message": { type: "user", text: "Question" },
    "shell-1:message": { type: "shell" },
    "assistant-1:reasoning:0": { type: "reasoning", text: "Think" },
    "assistant-1:text:0": { type: "text", text: "Answer" },
    "assistant-1:bash-1": { type: "tool" },
  }

  expect(rowMarkerKind(message("user-1"), resolve(parts))).toBe("prompt")
  expect(rowMarkerKind(message("shell-1"), resolve(parts))).toBe("tool")
  expect(rowMarkerKind(part("assistant-1", "reasoning:0"), resolve(parts))).toBe("thinking")
  expect(rowMarkerKind(part("assistant-1", "text:0"), resolve(parts))).toBe("response")
  expect(rowMarkerKind(part("assistant-1", "bash-1"), resolve(parts))).toBe("tool")
})

test("maps group rows to their kind and leaves the rest unmarked", () => {
  const parts = {
    "assistant-1:reasoning:0": { type: "reasoning", text: "Think" },
    "assistant-1:read-1": { type: "tool" },
  }
  const none = resolve({})

  expect(rowMarkerKind(reasoningGroup([child(part("assistant-1", "reasoning:0"))]), resolve(parts))).toBe("thinking")
  expect(rowMarkerKind(toolGroup("activity", [child(part("assistant-1", "read-1"))]), resolve(parts))).toBe("tool")
  expect(rowMarkerKind(toolGroup("exploration", [child(part("assistant-1", "read-1"))]), resolve(parts))).toBe("tool")
  expect(rowMarkerKind(message("system-1"), resolve({ "system-1:message": { type: "system" } }))).toBeUndefined()
  expect(
    rowMarkerKind(part("assistant-1", "media-1"), resolve({ "assistant-1:media-1": { type: "media" } })),
  ).toBeUndefined()
  expect(rowMarkerKind({ type: "assistant-footer", messageID: "assistant-1" }, none)).toBeUndefined()
})

test("maps group rows to their own kind", () => {
  const parts = {
    "assistant-1:text:0": { type: "text", text: "Answer" },
    "assistant-1:text:1": { type: "text", text: "More" },
    "assistant-1:read-1": { type: "tool" },
  }
  const children = [
    child(part("assistant-1", "text:0")),
    child(part("assistant-1", "text:1")),
    child(part("assistant-1", "read-1")),
  ]
  // The group's kind names its summary; a majority of text children does not override it.
  expect(rowMarkerKind(toolGroup("activity", children), resolve(parts))).toBe("tool")

  expect(
    rowMarkerKind(
      toolGroup("activity", [child(part("assistant-1", "text:0")), child(part("assistant-1", "read-1"))]),
      resolve({ "assistant-1:text:0": { type: "text", text: "Answer" }, "assistant-1:read-1": { type: "tool" } }),
    ),
  ).toBe("tool")
})

test("weighs rows by nominal lines, monotonic in text length", () => {
  const short = resolve({ "assistant-1:text:0": { type: "text", text: "x".repeat(10) } })
  const long = resolve({ "assistant-1:text:0": { type: "text", text: "x".repeat(200) } })
  const row = part("assistant-1", "text:0")

  expect(rowMarkerWeight(row, long)).toBeGreaterThan(rowMarkerWeight(row, short))
  expect(
    rowMarkerWeight(part("assistant-1", "text:0"), resolve({ "assistant-1:text:0": { type: "text", text: "" } })),
  ).toBe(1)
  expect(
    rowMarkerWeight(row, resolve({ "assistant-1:text:0": { type: "text", text: "x".repeat(NOMINAL_LINE_WIDTH) } })),
  ).toBe(2)
  expect(
    rowMarkerWeight(row, resolve({ "assistant-1:text:0": { type: "text", text: "x".repeat(NOMINAL_LINE_WIDTH + 1) } })),
  ).toBe(1 + (NOMINAL_LINE_WIDTH + 1) / NOMINAL_LINE_WIDTH)
})

test("weighs groups, tools and user messages", () => {
  const group = toolGroup("activity", [child(part("assistant-1", "read-1")), child(part("assistant-1", "read-2"))])
  expect(rowMarkerWeight(group, resolve({}))).toBe(1)
  expect(rowMarkerWeight(part("assistant-1", "read-1"), resolve({ "assistant-1:read-1": { type: "tool" } }))).toBe(2)
  expect(
    rowMarkerWeight(
      message("user-1"),
      resolve({ "user-1:message": { type: "user", text: "x".repeat(NOMINAL_LINE_WIDTH + 5) } }),
    ),
  ).toBe(1 + (NOMINAL_LINE_WIDTH + 5) / NOMINAL_LINE_WIDTH)
  expect(rowMarkerWeight(message("shell-1"), resolve({ "shell-1:message": { type: "shell" } }))).toBe(1)
  expect(
    rowMarkerWeight(
      message("shell-1"),
      resolve({ "shell-1:message": { type: "shell", command: "x".repeat(NOMINAL_LINE_WIDTH + 5) } }),
    ),
  ).toBe(1 + (NOMINAL_LINE_WIDTH + 5) / NOMINAL_LINE_WIDTH)
})

test.each([0, 1, 5, 17])("returns exactly cellCount bands for cellCount %i", (cellCount) => {
  expect(buildMarkerBands([3, 1, 2], ["prompt", "tool", "response"], cellCount)).toHaveLength(cellCount)
  expect(buildMarkerBands([], [], cellCount)).toHaveLength(cellCount)
})

test("targets the row that produced the band's primary kind, not the band centre", () => {
  // One cell: prompt covers 1/6 of it, response the rest. The primary is prompt (it reaches the
  // floor) and its row is row 0, while the band centre (240 of 480) falls in the response row 1.
  const kinds = ["prompt", "response"] as const
  const band = buildMarkerBandsWithShares([1, 5], [...kinds], 1)[0]!
  expect(band.kind).toBe("prompt")
  expect(band.row).toBe(0)
  expect(kinds[band.row]).toBe("prompt")

  // Across two cells the target follows the row that owns each band, not the half-way centre.
  const split = buildMarkerBandsWithShares([1, 1], ["response", "prompt"], 2)
  expect(split.map((item) => item.kind)).toEqual(["response", "prompt"])
  expect(split.map((item) => item.row)).toEqual([0, 1])

  // No primary kind: the band falls back to its centre row.
  expect(buildMarkerBandsWithShares([1, 1], [undefined, undefined], 1)[0]!.row).toBe(1)
  expect(buildMarkerBandsWithShares([1, 1], [undefined, undefined], 2).map((item) => item.row)).toEqual([0, 1])
})

test("returns all-undefined bands without rows or positive weight", () => {
  expect(buildMarkerBands([], [], 4)).toEqual([undefined, undefined, undefined, undefined])
  expect(buildMarkerBands([1, 2], [undefined, undefined], 3)).toEqual([undefined, undefined, undefined])
  expect(buildMarkerBands([0, 0], ["prompt", "tool"], 3)).toEqual([undefined, undefined, undefined])
})

test("fills every band with a single row's kind", () => {
  expect(buildMarkerBands([5], ["prompt"], 4)).toEqual(["prompt", "prompt", "prompt", "prompt"])
  expect(buildMarkerBands([5], [undefined], 3)).toEqual([undefined, undefined, undefined])
})

test("distributes bands proportionally to weight", () => {
  expect(buildMarkerBands([1, 3], ["prompt", "tool"], 4)).toEqual(["prompt", "tool", "tool", "tool"])
})

test("breaks equal shares by priority prompt > tool > thinking > response", () => {
  expect(buildMarkerBands([1, 1], ["tool", "prompt"], 1)).toEqual(["prompt"])
  expect(buildMarkerBands([1, 1], ["response", "thinking"], 1)).toEqual(["thinking"])
  expect(buildMarkerBands([1, 1], ["thinking", "tool"], 1)).toEqual(["tool"])
})

test("maps marker kinds to theme colors", () => {
  const colors = { agentAccent: "#a", thinking: "#b", info: "#c", responseNeutral: "#d" }
  expect(markerColor("prompt", colors)).toBe("#a")
  expect(markerColor("thinking", colors)).toBe("#b")
  expect(markerColor("tool", colors)).toBe("#c")
  expect(markerColor("response", colors)).toBe("#d")
  expect(markerColor(undefined, colors)).toBeUndefined()
})

test("band shares expose how much of a cell each kind covers", () => {
  // one cell split halfway: prompt wins as the coloured primary and response is the secondary
  expect(buildMarkerBandsWithShares([1, 1], ["response", "prompt"], 1)).toEqual([
    { kind: "prompt", share: 0.5, secondary: "response", secondaryShare: 0.5, row: 1 },
  ])
  // a kind that owns the whole cell is fully opaque and carries no secondary
  expect(buildMarkerBandsWithShares([5], ["prompt"], 4)).toEqual([
    { kind: "prompt", share: 1, secondary: undefined, secondaryShare: 0, row: 0 },
    { kind: "prompt", share: 1, secondary: undefined, secondaryShare: 0, row: 0 },
    { kind: "prompt", share: 1, secondary: undefined, secondaryShare: 0, row: 0 },
    { kind: "prompt", share: 1, secondary: undefined, secondaryShare: 0, row: 0 },
  ])
  // an unmarked cell has no kind, no secondary and no share
  expect(buildMarkerBandsWithShares([1], [undefined], 2)).toEqual([
    { kind: undefined, share: 0, secondary: undefined, secondaryShare: 0, row: 0 },
    { kind: undefined, share: 0, secondary: undefined, secondaryShare: 0, row: 0 },
  ])
  // `buildMarkerBands` is the kind projection of the same result
  expect(buildMarkerBandsWithShares([1, 3], ["prompt", "tool"], 4).map((band) => band.kind)).toEqual(
    buildMarkerBands([1, 3], ["prompt", "tool"], 4),
  )
})

test("floor boundary: a share of exactly 1/10 is coloured, just under it is not", () => {
  // weights [1, 9] over one cell: prompt covers 80 of 800 = exactly MIN_COLOURED_SHARE
  const atFloor = buildMarkerBandsWithShares([1, 9], ["prompt", "response"], 1)[0]!
  expect(atFloor.kind).toBe("prompt")
  expect(atFloor.share).toBe(MIN_COLOURED_SHARE)
  expect(atFloor.secondary).toBe("response")
  expect(atFloor.secondaryShare).toBe(0.9)

  // weights [1, 721/80] over one cell: prompt covers 80 of 801, one unit under the exact floor
  const under = buildMarkerBandsWithShares([1, 721 / NOMINAL_LINE_WIDTH], ["prompt", "response"], 1)[0]!
  expect(under.kind).toBe("response")
  expect(under.secondary).toBeUndefined()
})

test("primary picks a coloured kind over a larger response", () => {
  const band = buildMarkerBandsWithShares([1, 9], ["tool", "response"], 1)[0]!
  expect(band.kind).toBe("tool")
  expect(band.share).toBe(MIN_COLOURED_SHARE)
  expect(band.secondary).toBe("response")
  expect(band.secondaryShare).toBe(0.9)
})

test("no secondary when only one kind, or a below-floor sliver, is present", () => {
  expect(buildMarkerBandsWithShares([5], ["thinking"], 1)[0]!.secondary).toBeUndefined()
  const sliver = buildMarkerBandsWithShares([1, 721 / NOMINAL_LINE_WIDTH], ["prompt", "response"], 1)[0]!
  expect(sliver.kind).toBe("response")
  expect(sliver.secondary).toBeUndefined()
  expect(sliver.secondaryShare).toBe(0)
})

test("a pure response band stays response with no secondary", () => {
  const band = buildMarkerBandsWithShares([4], ["response"], 3)
  expect(band.map((cell) => cell.kind)).toEqual(["response", "response", "response"])
  expect(band.every((cell) => cell.secondary === undefined)).toBe(true)
  expect(band.every((cell) => cell.share === 1)).toBe(true)
})

/** One turn of a tool-heavy transcript: prompt, a group, then two rows that register no anchor. */
const turnRows = (turn: number): SessionRow[] => [
  message(`user-${turn}`),
  reasoningGroup([child(part(`assistant-${turn}`, "reasoning:0"))]),
  { type: "assistant-footer", messageID: `assistant-${turn}` },
  { type: "turn-usage", messageIDs: [`assistant-${turn}`] },
]

test("every band's target row resolves to a row that registers an anchor", () => {
  const rows = Array.from({ length: 15 }, (_, turn) => turnRows(turn)).flat()
  const parts = Object.fromEntries(
    Array.from({ length: 15 }, (_, turn) => [
      [`user-${turn}:message`, { type: "user", text: `Prompt ${turn}` }],
      [`assistant-${turn}:reasoning:0`, { type: "reasoning", text: `Thinking ${turn}` }],
    ]).flat(),
  )
  const anchored = (row: SessionRow) => rowAnchorTarget(row) !== undefined
  // Derived rows (footer, usage) never register an anchor; every band must still find one.
  expect(rows.filter((row) => !anchored(row)).length).toBe(30)

  const resolveRow = resolve(parts)
  const kinds = rows.map((row) => rowMarkerKind(row, resolveRow))
  const weights = rows.map((row) => rowMarkerWeightDeep(row, resolveRow, () => true))
  const targets = buildMarkerBandsWithShares(weights, kinds, 60).map((band) => band.row)
  targets.forEach((target) => {
    const resolved = markerAnchorRow(rows, target, anchored)
    expect(resolved).toBeDefined()
    if (resolved === undefined) return
    expect(anchored(rows[resolved])).toBe(true)
  })
})

test("anchor resolution walks backward first, then forward, then gives up", () => {
  const anchored = (row: SessionRow) => rowAnchorTarget(row) !== undefined
  const rows = turnRows(0)
  // the footer and the usage row reference the entry above them
  expect(markerAnchorRow(rows, 2, anchored)).toBe(1)
  expect(markerAnchorRow(rows, 3, anchored)).toBe(1)
  // an anchored row resolves to itself
  expect(markerAnchorRow(rows, 0, anchored)).toBe(0)
  // nothing above: fall forward to the next anchored row
  const head: SessionRow[] = [{ type: "assistant-footer", messageID: "a1" }, message("u1")]
  expect(markerAnchorRow(head, 0, anchored)).toBe(1)
  // no anchor at all anywhere: the caller falls back to a proportional scroll
  const derived: SessionRow[] = [
    { type: "assistant-footer", messageID: "a1" },
    { type: "turn-usage", messageIDs: ["a1"] },
    { type: "compaction-queued", inboxID: "i1" },
  ]
  expect(markerAnchorRow(derived, 1, anchored)).toBeUndefined()
})
