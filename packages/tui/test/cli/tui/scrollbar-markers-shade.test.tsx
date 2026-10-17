import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ScrollbarMarkers } from "../../../src/routes/session/scrollbar-markers"
import { markerColor } from "../../../src/routes/session/markers"

const SHARES = [0.25, 0.5, 0.75, 1] as const

async function render(cells: { kind: "prompt" | "response" | undefined; share: number }[]) {
  const prompt = RGBA.fromHex("#ff4400")
  const response = RGBA.fromHex("#1144ff")
  const app = await testRender(
    () => (
      <ScrollbarMarkers
        cells={cells.map((cell, row) => ({ ...cell, secondary: undefined, secondaryShare: 0, row }))}
        color={(kind) =>
          markerColor(kind, { agentAccent: prompt, thinking: prompt, info: prompt, responseNeutral: response })
        }
        onJump={() => {}}
      />
    ),
    { width: 4, height: cells.length + 2 },
  )
  app.renderer.start()
  await app.renderOnce()
  const bg = (row: number) => app.captureSpans().lines[row]!.spans[0]!.bg
  const tone = (row: number) => {
    const color = bg(row)
    return { a: color.a, r: color.r, g: color.g, b: color.b, hex: `#${[color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` }
  }
  return { app, prompt, response, tone }
}

test("shade increases with the winning kind's share and keeps the kind's hue", async () => {
  const { app, prompt, tone } = await render(SHARES.map((share) => ({ kind: "prompt" as const, share })))
  try {
    const cells = SHARES.map((share, row) => ({ share, ...tone(row) }))
    console.log(`prompt ${cells.map((cell) => `${cell.share}:${cell.hex}`).join(" ")}`)
    const brightness = cells.map((cell) => cell.r)
    for (let index = 1; index < brightness.length; index++) expect(brightness[index]!).toBeGreaterThan(brightness[index - 1]!)
    console.log(`prompt brightness ${brightness.map((value) => value.toFixed(3)).join(" < ")}`)
    // hue: every share is the same red, only darker (the composited value loses the alpha channel)
    const hue = prompt.r / Math.max(prompt.g, 1e-6)
    for (const cell of cells) {
      expect(cell.g / Math.max(cell.r, 1e-6)).toBeCloseTo(1 / hue, 2)
      expect(cell.b).toBe(0)
    }
  } finally {
    app.renderer.destroy()
  }
})

test("a second kind shades with its own colour", async () => {
  const { app, response, tone } = await render(SHARES.map((share) => ({ kind: "response" as const, share })))
  try {
    const cells = SHARES.map((share, row) => ({ share, ...tone(row) }))
    console.log(`response ${cells.map((cell) => `${cell.share}:${cell.hex}`).join(" ")}`)
    for (let index = 1; index < cells.length; index++) expect(cells[index]!.b).toBeGreaterThan(cells[index - 1]!.b)
    for (const cell of cells) {
      expect(cell.b).toBeGreaterThan(cell.r)
      expect(cell.r / Math.max(cell.b, 1e-6)).toBeCloseTo(response.r / response.b, 2)
    }
  } finally {
    app.renderer.destroy()
  }
})

test("share 0 is fully transparent and share 1 is the raw kind colour", async () => {
  const { app, prompt, tone } = await render([
    { kind: undefined, share: 0 },
    { kind: "prompt", share: 1 },
  ])
  try {
    expect(tone(0).a).toBe(0)
    expect(tone(1).a).toBe(1)
    expect(tone(1).hex).toBe("#ff4400")
    expect(prompt.a).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("hover brightens exactly one cell and mouse-out restores every cell", async () => {
  const { app, tone } = await render([
    { kind: "prompt", share: 0.5 },
    { kind: "prompt", share: 0.5 },
    { kind: "prompt", share: 0.5 },
  ])
  const shades = () => [0, 1, 2].map((row) => tone(row).hex)
  try {
    const resting = shades()
    console.log(`hover resting ${resting.join(",")}`)
    expect(new Set(resting).size).toBe(1)

    await app.mockMouse.moveTo(0, 1)
    await app.renderOnce()
    const hovered = shades()
    console.log(`hover cell 1 ${hovered.join(",")}`)
    expect(hovered[1]).toBe("#ff4400")
    expect(hovered.filter((hex, index) => hex !== resting[index])).toHaveLength(1)

    await app.mockMouse.moveTo(3, 3)
    await app.renderOnce()
    const restored = shades()
    console.log(`after mouse-out ${restored.join(",")}`)
    expect(restored).toEqual(resting)
  } finally {
    app.renderer.destroy()
  }
})
