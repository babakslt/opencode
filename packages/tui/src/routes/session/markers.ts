import { groupID } from "./anchors"
import type { GroupKind, PartRef, SessionEntry, SessionNode, SessionRow } from "./grouping/session"

export type MarkerKind = "prompt" | "thinking" | "response" | "tool"

/** The estimator's nominal terminal width; the one knob that tunes weight drift. */
export const NOMINAL_LINE_WIDTH = 80

/** Kinds that earn a mark; `response` is only the track behind them. */
const COLOURED: MarkerKind[] = ["prompt", "tool", "thinking"]

/** Ties between kinds in one band or group: prompt > tool > thinking > response. */
const kindPriority: MarkerKind[] = ["prompt", "tool", "thinking", "response"]

/**
 * Smallest share of a band a coloured kind needs to become its primary. The decision stays in the
 * exact integer domain — `share >= MIN_COLOURED_SHARE` is evaluated as `10 * overlap >= total`.
 */
export const MIN_COLOURED_SHARE = 0.1

/** Resolved message/part shape the caller supplies; only the fields used here. */
type PartLike = { type: string; text?: string; command?: string }

type Resolve = (ref: PartRef) => PartLike | undefined

/** One colour per marker role: prompts carry `agentAccent`, tools carry `info`. */
export type MarkerColors<T = string> = {
  agentAccent: T
  thinking: T
  info: T
  responseNeutral: T
}

type GroupNode = Extract<SessionNode, { type: "group" }>

export function rowMarkerKind(row: SessionRow, resolve: Resolve): MarkerKind | undefined {
  if (row.type === "group") return groupMarkerKind(row, resolve)
  return entryKind(row, resolve)
}

/** Leaf weight: a group row costs its one-line summary until disclosure is known. */
export function rowMarkerWeight(row: SessionRow, resolve: Resolve): number {
  if (row.type === "group") return 1
  return entryWeight(row, resolve)
}

/**
 * Rendered weight, including disclosure: markers must follow what is on screen, so an
 * expanded group weighs its header plus the rows it shows and a collapsed one weighs a
 * single header line. Traversal and level accounting mirror mount-budget's `rowWeight`.
 */
export function rowMarkerWeightDeep(
  row: SessionRow,
  resolve: Resolve,
  expanded: (groupID: string, kind: GroupKind) => boolean,
): number {
  if (row.type !== "group") return entryWeight(row, resolve)
  const visit = (node: GroupNode, level: number): number => {
    const id = groupID(node, level)
    if (!id || !expanded(id, node.kind)) return 1
    return node.children.reduce(
      (total, child) => total + (child.type === "group" ? visit(child, level + 1) : entryWeight(child.entry, resolve)),
      1,
    )
  }
  return visit(row, 0)
}

/**
 * One cell: the coloured kind that earns its mark (primary), that kind's share, the runner-up kind
 * worth splitting the cell with (secondary), and the row that produced the primary kind.
 */
export type MarkerBand = {
  kind: MarkerKind | undefined
  share: number
  secondary: MarkerKind | undefined
  secondaryShare: number
  row: number
}

/**
 * Every band takes the highest-priority coloured kind holding at least `MIN_COLOURED_SHARE` of it,
 * plus the largest other kind that still holds enough to show; only a band no coloured kind reaches
 * falls back to the largest share overall. Shares are never divided: each weight is scaled by
 * NOMINAL_LINE_WIDTH into an integer, rows and bands then live in the shared domain `total * cellCount`
 * and compare exactly. Exact arithmetic keeps true ties from drifting and keeps a band that only
 * touches a row boundary from picking up a phantom share of it. The band's `row` is the row holding
 * the primary kind's largest overlap — the row that produced the colour, not the band's centre — so a
 * click lands on what it clicked. An `undefined` primary (no share at all) falls back to the centre.
 */
export function buildMarkerBandsWithShares(
  weights: number[],
  kinds: (MarkerKind | undefined)[],
  cellCount: number,
): MarkerBand[] {
  const cells = Math.max(0, Math.trunc(cellCount))
  const exact = exactWeights(weights)
  const total = exact.reduce((sum, weight) => sum + weight, 0n)
  const cellWidth = BigInt(cells)
  const bands: MarkerBand[] = []
  // Bands, rows and their centres advance together, so each row is visited only while a band
  // overlaps it and each centre only while a band's centre passes it.
  let row = 0
  let rowStart = 0n
  let centreRow = 0
  let centreStart = 0n
  for (let band = 0; band < cells; band++) {
    if (total <= 0n) {
      bands.push({ kind: undefined, share: 0, secondary: undefined, secondaryShare: 0, row: 0 })
      continue
    }
    const point = (BigInt(2 * band + 1) * total) / BigInt(2 * cells)
    while (centreRow + 1 < exact.length && centreStart + exact[centreRow] <= point) {
      centreStart += exact[centreRow]
      centreRow++
    }
    const bandStart = BigInt(band) * total
    const bandEnd = BigInt(band + 1) * total
    while (row < exact.length && (rowStart + exact[row]) * cellWidth <= bandStart) {
      rowStart += exact[row]
      row++
    }
    const shares = new Map<MarkerKind, bigint>()
    // The row holding the largest overlap of each kind; the primary's is the click target.
    const heaviest = new Map<MarkerKind, { row: number; overlap: bigint }>()
    let index = row
    let start = rowStart * cellWidth
    while (index < exact.length && start < bandEnd) {
      const end = start + exact[index] * cellWidth
      const kind = kinds[index]
      if (exact[index] > 0n && kind !== undefined) {
        const overlap = (bandEnd < end ? bandEnd : end) - (bandStart > start ? bandStart : start)
        if (overlap > 0n) {
          shares.set(kind, (shares.get(kind) ?? 0n) + overlap)
          const heaviestRow = heaviest.get(kind)
          if (!heaviestRow || overlap > heaviestRow.overlap) heaviest.set(kind, { row: index, overlap })
        }
      }
      start = end
      index++
    }
    const kind = primaryKind(shares, total)
    const secondary = secondaryKind(shares, total, kind)
    bands.push({
      kind,
      share: kind ? Number(shares.get(kind) ?? 0n) / Number(total) : 0,
      secondary,
      secondaryShare: secondary ? Number(shares.get(secondary) ?? 0n) / Number(total) : 0,
      row: (kind && heaviest.get(kind)?.row) ?? centreRow,
    })
  }
  return bands
}

/** The dominant kind of every band; see `buildMarkerBandsWithShares` for the weighting. */
export function buildMarkerBands(
  weights: number[],
  kinds: (MarkerKind | undefined)[],
  cellCount: number,
): (MarkerKind | undefined)[] {
  return buildMarkerBandsWithShares(weights, kinds, cellCount).map((band) => band.kind)
}

/** Highest-priority coloured kind holding at least the floor, else the largest share overall. */
function primaryKind(shares: Map<MarkerKind, bigint>, total: bigint): MarkerKind | undefined {
  for (const kind of kindPriority) {
    if (!COLOURED.includes(kind)) continue
    if (meetsFloor(shares.get(kind) ?? 0n, total)) return kind
  }
  let best: MarkerKind | undefined
  let bestShare = 0n
  for (const kind of kindPriority) {
    const share = shares.get(kind) ?? 0n
    if (share > bestShare) {
      best = kind
      bestShare = share
    }
  }
  return best
}

/** The largest-share kind other than the primary that still reaches the floor, if any. */
function secondaryKind(
  shares: Map<MarkerKind, bigint>,
  total: bigint,
  primary: MarkerKind | undefined,
): MarkerKind | undefined {
  let best: MarkerKind | undefined
  let bestShare = 0n
  for (const kind of kindPriority) {
    if (kind === primary) continue
    const share = shares.get(kind) ?? 0n
    if (meetsFloor(share, total) && share > bestShare) {
      best = kind
      bestShare = share
    }
  }
  return best
}

/** Exact `share >= MIN_COLOURED_SHARE` (`overlap / total >= 1 / 10`) without leaving the integers. */
function meetsFloor(overlap: bigint, total: bigint): boolean {
  return 10n * overlap >= total
}

export function markerColor<T>(kind: MarkerKind | undefined, colors: MarkerColors<T>) {
  if (kind === "prompt") return colors.agentAccent
  if (kind === "thinking") return colors.thinking
  if (kind === "tool") return colors.info
  if (kind === "response") return colors.responseNeutral
}

/**
 * A band's row resolved to the row that actually registers a scroll anchor, so a click is never a
 * no-op. Chain: 1. the row itself; 2. the nearest row above it (derived footer/usage rows scroll to
 * the entry they follow); 3. the nearest row below it; 4. nothing, when no row is anchored at all —
 * the caller then falls back to a proportional scroll.
 */
export function markerAnchorRow(
  rows: readonly SessionRow[],
  index: number,
  anchored: (row: SessionRow) => boolean,
): number | undefined {
  const own = rows[index]
  if (own && anchored(own)) return index
  for (let above = index - 1; above >= 0; above--) if (anchored(rows[above])) return above
  for (let below = index + 1; below < rows.length; below++) if (anchored(rows[below])) return below
  return undefined
}

/** Scaling by the nominal width makes `1 + length / NOMINAL_LINE_WIDTH` exactly `80 + length`. */
function exactWeights(weights: number[]): bigint[] {
  return weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? BigInt(Math.round(weight * NOMINAL_LINE_WIDTH)) : 0n,
  )
}

function entryKind(entry: SessionEntry, resolve: Resolve): MarkerKind | undefined {
  if (entry.type === "message") {
    const message = resolve({ messageID: entry.messageID, partID: "message" })
    if (message?.type === "user") return "prompt"
    if (message?.type === "shell") return "tool"
    return undefined
  }
  if (entry.type !== "part") return undefined
  const part = resolve(entry.ref)
  if (part?.type === "reasoning") return "thinking"
  if (part?.type === "text") return "response"
  if (part?.type === "tool") return "tool"
  return undefined
}

/** A group's own kind names its visible summary; only an unnamed kind defers to its children. */
function groupMarkerKind(group: GroupNode, resolve: Resolve): MarkerKind | undefined {
  if (group.kind === "reasoning") return "thinking"
  if (group.kind === "activity" || group.kind === "exploration") return "tool"
  const shares = new Map<MarkerKind, number>()
  group.children.forEach((child) => {
    const kind = child.type === "group" ? groupMarkerKind(child, resolve) : entryKind(child.entry, resolve)
    if (kind === undefined) return
    const weight = child.type === "group" ? 1 : entryWeight(child.entry, resolve)
    shares.set(kind, (shares.get(kind) ?? 0) + weight)
  })
  return pickKind(shares)
}

function entryWeight(entry: SessionEntry, resolve: Resolve): number {
  if (entry.type === "message") {
    const message = resolve({ messageID: entry.messageID, partID: "message" })
    if (message?.type === "user") return lineWeight(message.text ?? "")
    // Shell rows render their command; the output stays hidden.
    if (message?.type === "shell") return lineWeight(message.command ?? "")
    return 1
  }
  if (entry.type !== "part") return 1
  const part = resolve(entry.ref)
  if (part?.type === "tool") return 2
  if (part?.type === "text" || part?.type === "reasoning") return lineWeight(part.text ?? "")
  return 1
}

function lineWeight(text: string) {
  return 1 + text.length / NOMINAL_LINE_WIDTH
}

function pickKind(shares: Map<MarkerKind, number>): MarkerKind | undefined {
  let best: MarkerKind | undefined
  let bestShare = 0
  kindPriority.forEach((kind) => {
    const share = shares.get(kind) ?? 0
    if (share > bestShare) {
      best = kind
      bestShare = share
    }
  })
  return best
}
