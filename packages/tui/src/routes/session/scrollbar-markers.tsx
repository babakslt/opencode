import { RGBA } from "@opentui/core"
import { Index, Show, createSignal } from "solid-js"
import type { MarkerBand, MarkerKind } from "./markers"

/** Faintest a marked cell may render; a whole-band kind is fully opaque. */
const SHADE_FLOOR = 0.45

/** One band per cell, top down. A click jumps to the row that band covers. */
export function ScrollbarMarkers(props: {
  cells: MarkerBand[]
  color: (kind: MarkerKind | undefined) => RGBA | undefined
  onJump: (band: number) => void
}) {
  const [hovered, setHovered] = createSignal<number>()
  // Busy bands look solid, mixed bands faint: the alpha carries the kind's share.
  const shade = (color: RGBA | undefined, share: number, hovered: boolean) => {
    if (!color) return undefined
    const shaded = RGBA.clone(color)
    shaded.a = hovered ? 1 : SHADE_FLOOR + (1 - SHADE_FLOOR) * Math.min(1, Math.max(0, share))
    return shaded
  }
  const tone = (kind: MarkerKind | undefined, share: number, band: number) =>
    shade(props.color(kind), share, hovered() === band)
  // Index keeps the boxes themselves stable: only their colours change as rows stream in. A band
  // that picked up a secondary kind splits the cell with `▀` — its upper half takes the primary's
  // foreground, its lower half the secondary's background.
  return (
    <box width={1} flexShrink={0} flexDirection="column">
      <Index each={props.cells}>
        {(cell, band) => (
          <box
            height={1}
            flexShrink={0}
            backgroundColor={cell().secondary ? undefined : tone(cell().kind, cell().share, band)}
            onMouseUp={() => props.onJump(band)}
            onMouseOver={() => setHovered(band)}
            onMouseOut={() => setHovered(undefined)}
          >
            <Show when={cell().secondary}>
              <text fg={tone(cell().kind, cell().share, band)} bg={tone(cell().secondary, cell().secondaryShare, band)}>
                ▀
              </text>
            </Show>
          </box>
        )}
      </Index>
    </box>
  )
}
