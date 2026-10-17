import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ScrollbarMarkers } from "../../../src/routes/session/scrollbar-markers"
import type { MarkerBand, MarkerKind } from "../../../src/routes/session/markers"

const band = (
  kind: MarkerKind | undefined,
  share: number,
  secondary: MarkerKind | undefined = undefined,
  secondaryShare = 0,
): MarkerBand => ({ kind, share, secondary, secondaryShare, row: 0 })

const colorOf = (prompt: RGBA, response: RGBA) => (kind: MarkerKind | undefined) =>
  kind === "prompt" ? prompt : kind === "response" ? response : undefined

/** Headless paint check: one cell per band, and a click reports the band that was clicked. */
test("paints a background per band and jumps to the clicked band", async () => {
  const prompt = RGBA.fromHex("#ff0000")
  const response = RGBA.fromHex("#00ff00")
  const jumps: number[] = []
  const app = await testRender(
    () => (
      <ScrollbarMarkers
        cells={[band("prompt", 1), band(undefined, 0), band("response", 1)]}
        color={colorOf(prompt, response)}
        onJump={(band) => jumps.push(band)}
      />
    ),
    { width: 8, height: 4 },
  )
  app.renderer.start()
  try {
    await app.renderOnce()
    const lines = app.captureSpans().lines
    // A whole-band kind is fully opaque; an unmarked cell stays transparent.
    expect(lines[0]?.spans[0]?.bg.equals(prompt)).toBe(true)
    expect(lines[1]?.spans[0]?.bg.a).toBe(0)
    // `response` is a present but quiet mark, so it is not transparent.
    expect(lines[2]?.spans[0]?.bg.equals(response)).toBe(true)
    expect(lines[2]?.spans[0]?.bg.a).toBeGreaterThan(0)

    await app.mockMouse.click(0, 2)
    expect(jumps).toEqual([2])
    // every cell is a jump target, marked or not: the band still covers a row
    await app.mockMouse.click(0, 1)
    expect(jumps).toEqual([2, 1])
  } finally {
    app.renderer.destroy()
  }
})

test("splits a two-kind cell: primary colour on the glyph, secondary behind it", async () => {
  const prompt = RGBA.fromHex("#ff0000")
  const response = RGBA.fromHex("#00ff00")
  const app = await testRender(
    () => (
      <ScrollbarMarkers
        cells={[
          band("prompt", 0.25, "response", 0.75),
          band("prompt", 0.25),
          band("response", 0.75),
          band("prompt", 1),
          band("response", 1),
        ]}
        color={colorOf(prompt, response)}
        onJump={() => {}}
      />
    ),
    { width: 8, height: 6 },
  )
  app.renderer.start()
  try {
    await app.renderOnce()
    const lines = app.captureSpans().lines
    const split = lines[0]!.spans[0]!
    // The half-block glyph takes the primary hue on the foreground, the secondary on the background.
    expect(split.text).toBe("▀")
    expect(split.fg.r).toBeGreaterThan(split.bg.r)
    expect(split.bg.g).toBeGreaterThan(split.fg.g)
    // Each half carries its own share's shade: its dominant channel matches the single-kind cell
    // at that share (the foreground composites over the secondary, so only its own channel is exact).
    expect(split.fg.r).toBeCloseTo(lines[1]!.spans[0]!.bg.r, 5)
    expect(split.bg.g).toBeCloseTo(lines[2]!.spans[0]!.bg.g, 5)

    // Hover lifts both halves to full opacity, the full-share single-kind cells.
    await app.mockMouse.moveTo(0, 0)
    await app.renderOnce()
    const hovered = app.captureSpans().lines[0]!.spans[0]!
    expect(hovered.fg.equals(prompt)).toBe(true)
    expect(hovered.bg.equals(response)).toBe(true)
    expect(lines[3]!.spans[0]!.bg.equals(prompt)).toBe(true)
    expect(lines[4]!.spans[0]!.bg.equals(response)).toBe(true)

    await app.mockMouse.moveTo(0, 5)
    await app.renderOnce()
    const restored = app.captureSpans().lines[0]!.spans[0]!
    expect(restored.fg.equals(split.fg)).toBe(true)
    expect(restored.bg.equals(split.bg)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("shades a cell by its dominant kind's share and fades a mixed cell", async () => {
  const prompt = RGBA.fromHex("#ff0000")
  const app = await testRender(
    () => (
      <ScrollbarMarkers cells={[band("prompt", 0.5), band("prompt", 1)]} color={() => prompt} onJump={() => {}} />
    ),
    { width: 8, height: 3 },
  )
  app.renderer.start()
  try {
    await app.renderOnce()
    // Alpha composites against the terminal cell, so the share shows as a darker or brighter tone.
    const lines = app.captureSpans().lines
    const mixed = lines[0]?.spans[0]?.bg
    const solid = lines[1]?.spans[0]?.bg
    expect(mixed?.a).toBeGreaterThan(0)
    expect(mixed?.r).toBeLessThan(solid?.r ?? 0)
    expect(solid?.r).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("hover brightens exactly one cell and mouse-out restores it", async () => {
  const prompt = RGBA.fromHex("#ff0000")
  const app = await testRender(
    () => (
      <ScrollbarMarkers
        cells={[band("prompt", 0.5), band("prompt", 0.5), band("prompt", 0.5)]}
        color={() => prompt}
        onJump={() => {}}
      />
    ),
    { width: 8, height: 4 },
  )
  app.renderer.start()
  try {
    await app.renderOnce()
    const shades = () =>
      app
        .captureSpans()
        .lines.slice(0, 3)
        .map((line) => line.spans[0]?.bg.r ?? 0)
    expect(shades().every((value) => value > 0 && value < 1)).toBe(true)

    await app.mockMouse.moveTo(0, 1)
    await app.renderOnce()
    expect(shades()[1]).toBe(1)
    expect(shades().filter((value) => value === 1)).toHaveLength(1)

    await app.mockMouse.moveTo(0, 0)
    await app.renderOnce()
    expect(shades()[0]).toBe(1)
    expect(shades().filter((value) => value === 1)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
