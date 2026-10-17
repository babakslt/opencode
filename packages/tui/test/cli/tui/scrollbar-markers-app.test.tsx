/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import type { CapturedFrame, CapturedSpan, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { TuiInput } from "../../../src/app"
import type { Config } from "../../../src/config"
import { tmpdir } from "../../fixture/fixture"
import { createEventStream, createFetch, directory, json, type FetchHandler } from "../../fixture/tui-client"

const session = {
  id: "ses_marker_flip",
  title: "Marker flip",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const messages = Array.from({ length: 60 }, (_, index) => ({
  id: `message-${index}`,
  type: "user" as const,
  text: `History message ${String(index).padStart(4, "0")}`,
  time: { created: index },
}))

/** One turn per index: a user prompt, then an assistant step with reasoning, a tool and text. */
const turns = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const tag = String(index).padStart(4, "0")
    return [
      { id: `user-${index}`, type: "user" as const, text: `Prompt ${tag} with enough words to weigh the user row above the assistant rows`, time: { created: index * 10 } },
      {
        id: `assistant-${index}`,
        type: "assistant" as const,
        agent: "build",
        model: { providerID: "fixture", id: "fixture" },
        time: { created: index * 10 + 1, completed: index * 10 + 9 },
        content: [
          { type: "reasoning" as const, text: `Thinking ${tag}`, time: { created: index * 10 + 2, completed: index * 10 + 3 } },
          {
            type: "tool" as const,
            id: `read-${index}`,
            name: "read",
            time: { created: index * 10 + 3, completed: index * 10 + 4 },
            state: { status: "completed" as const, input: { path: `file-${index}.ts` }, content: [{ type: "text", text: "ok" }], metadata: {} },
          },
          { type: "text" as const, text: `Answer ${tag}`, time: { created: index * 10 + 5, completed: index * 10 + 6 } },
        ],
      },
    ]
  }).flat()

const sessionFetch =
  (data: unknown[]): FetchHandler =>
  (url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data, cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }

/** Same as the shared fixture, but the config service really applies the drafted update. */
async function createFlipFixture(input: { config: Config.Info; fetch: FetchHandler; height?: number }) {
  const { run } = await import("../../../src/app")
  const { createTestRenderer } = await import("@opentui/core/testing")
  const root = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: input.height ?? 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  let current = input.config
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => current,
        update: async (update: (draft: any) => void) => {
          const draft = structuredClone(current)
          update(draft)
          current = draft
          return current
        },
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: { sessionID: session.id } satisfies TuiInput["args"],
      log: () => {},
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: path.join(root.path, "home"),
          data: path.join(root.path, "data"),
          cache: path.join(root.path, "cache"),
          config: path.join(root.path, "config"),
          state: path.join(root.path, "state"),
          bin: path.join(root.path, "cache", "bin"),
          log: path.join(root.path, "data", "log"),
          repos: path.join(root.path, "data", "repos"),
          tmp: path.join(root.path, "tmp"),
        }),
      ),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    ready: ready.promise,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        await server.stop()
        await root[Symbol.asyncDispose]()
      }
    },
  }
}

const findScroll = (root: Renderable): ScrollBoxRenderable | undefined =>
  root instanceof Object && "scrollTop" in root
    ? (root as ScrollBoxRenderable)
    : root.getChildren().map(findScroll).find(Boolean)

/** The marker column is the tallest one-cell box in the tree: its children are the cells. */
const findColumn = (root: Renderable): Renderable | undefined => {
  const matches: Renderable[] = []
  const visit = (node: Renderable) => {
    if (node.width === 1 && node.getChildrenCount() > 4) matches.push(node)
    node.getChildren().forEach(visit)
  }
  visit(root)
  return matches.sort((a, b) => b.getChildrenCount() - a.getChildrenCount())[0]
}

const baseConfig = (markers: boolean): Config.Info => ({
  animations: false,
  tabs: { mode: "off" },
  session: { sidebar: "hide", scrollbar: true, scrollbar_markers: markers },
})

/** The captured span covering screen column x on row y. */
const spanAt = (frame: CapturedFrame, x: number, y: number): CapturedSpan | undefined => {
  let position = 0
  for (const span of frame.lines[y]?.spans ?? []) {
    if (x < position + span.width) return span
    position += span.width
  }
  return undefined
}

/** The topmost prompt id the frame shows, i.e. the row the jump aligned to the viewport top. */
const topPromptID = (frame: string) => {
  const match = frame.match(/Prompt (\d{4})/)
  return match ? Number(match[1]) : undefined
}

test("an empty transcript renders no column and reserves no padding", async () => {
  const frames: Renderable[] = []
  for (const markers of [true, false]) {
    await using setup = await createFlipFixture({
      config: baseConfig(markers),
      fetch: sessionFetch([]),
    })
    await setup.ready
    await setup.waitForVisualIdle({ quietFrames: 3 })
    await setup.waitFor(() => findScroll(setup.renderer.root) !== undefined)
    const scroll = findScroll(setup.renderer.root)
    if (!scroll) throw new Error("scrollbox not found")
    console.log(`markers=${markers} column=${!!findColumn(setup.renderer.root)} scrollX=${scroll.x} scrollWidth=${scroll.width}`)
    expect(findColumn(setup.renderer.root)).toBeUndefined()
    frames.push(scroll)
  }
  expect(frames[0]!.x).toBe(frames[1]!.x)
  expect(frames[0]!.width).toBe(frames[1]!.width)
}, 40000)

test("flipping the flag on shows the column with no resize or scroll event", async () => {
  await using setup = await createFlipFixture({ config: baseConfig(false), fetch: sessionFetch(messages.toReversed()) })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("History message 0059"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const scroll = findScroll(setup.renderer.root)
  if (!scroll) throw new Error("scrollbox not found")
  expect(findColumn(setup.renderer.root)).toBeUndefined()
  const widthBefore = scroll.width
  const framesBefore = setup.renderer.frameId
  const scrollTopBefore = scroll.scrollTop

  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Commands") && frame.includes("Suggested"))
  for (const key of "scrollbar markers") {
    setup.mockInput.pressKey(key)
    await setup.flush()
  }
  await setup.waitForFrame((frame) => /scrollbar markers/i.test(frame))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Scrollbar markers"))
  setup.mockInput.pressEnter()
  await setup.waitForVisualIdle({ quietFrames: 4 })
  setup.mockInput.pressEscape()
  // No resize() call anywhere: the refresh must come from the flag effect alone.
  await setup.waitForVisualIdle({ quietFrames: 4 })

  const column = findColumn(setup.renderer.root)
  const framesAfter = setup.renderer.frameId
  console.log(
    `column=${!!column} cells=${column?.getChildrenCount()} scrollWidth ${widthBefore} -> ${scroll.width} ` +
      `scrollTop ${scrollTopBefore} -> ${scroll.scrollTop} frames ${framesBefore} -> ${framesAfter}`,
  )
  expect(column).toBeDefined()
  expect(column!.getChildrenCount()).toBeGreaterThan(1)
  // The column is paid for out of the transcript's right padding, so enabling it live keeps the
  // transcript content width identical: no reflow of the text it is marking.
  expect(scroll.width).toBe(widthBefore)
  expect(scroll.scrollTop).toBe(scrollTopBefore)
  // A refresh loop would never settle; bounded frames prove the layout pass does not re-enter.
  expect(framesAfter - framesBefore).toBeLessThan(60)
}, 40000)

/**
 * The fixture makes prompts dominate each band, so every sampled cell's primary kind is `prompt`.
 * The contract under test is that a click lands the row that produced that colour — not the band's
 * centre — inside the viewport, leaves the column's colours unchanged, and mounts only a bounded
 * window rather than the whole transcript.
 */
test("marker clicks land the clicked band's own row, bound the reveal and leave the map unchanged", async () => {
  await using setup = await createFlipFixture({ config: baseConfig(true), fetch: sessionFetch(turns(200).toReversed()) })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Prompt 0199"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const scroll = findScroll(setup.renderer.root)
  const column = findColumn(setup.renderer.root)
  if (!scroll || !column) throw new Error("marker column or scrollbox not found")
  const cells = column.getChildrenCount()
  // The column's painted colours, index by band: this must survive every click.
  const snapshot = () =>
    Array.from({ length: cells }, (_, band) => {
      const span = spanAt(setup.captureSpans(), column.x, column.y + band)
      if (!span) return null
      const color = span.text === "▀" ? span.fg : span.bg
      return [color.r, color.g, color.b, color.a]
    })
  const initial = snapshot()

  // Band 0 covers the oldest rows, whose first row is this fixture's first prompt.
  await setup.mockMouse.click(column.x, column.y)
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(topPromptID(setup.captureCharFrame())).toBe(0)

  // Lower bands land later prompts: the clicked band's own row, in order.
  const samples = [Math.floor(cells * 0.3), Math.floor(cells * 0.55), Math.floor(cells * 0.8)]
  const landed: number[] = []
  for (const band of samples) {
    await setup.mockMouse.click(column.x, column.y + band)
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const id = topPromptID(setup.captureCharFrame())
    expect(id).not.toBeUndefined()
    if (id === undefined) return
    landed.push(id)
  }
  console.log(`cells=${cells} bands=${samples.join(",")} landed=${landed.join(",")}`)
  for (let index = 1; index < landed.length; index++) expect(landed[index]!).toBeGreaterThan(landed[index - 1]!)
  for (const id of landed) expect(id).toBeLessThan(199)

  // Bounded reveal: a mid-transcript jump must not mount the top of the transcript.
  expect(setup.captureCharFrame()).not.toContain("Prompt 0000")
  // The click must not repaint the map. Only the cell under the pointer lights up (its own hover),
  // so park the pointer off the column before comparing the whole column to its initial colours.
  await setup.mockMouse.moveTo(0, 0)
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(snapshot()).toEqual(initial)
}, 60000)
