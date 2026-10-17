import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createAppFixture } from "../../fixture/app"
import { directory, json } from "../../fixture/tui-client"

const session = {
  id: "ses_marker_jump",
  title: "Marker jump",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
// More rows than TRANSCRIPT_TAIL_ROWS so the transcript opens tail-first and the oldest rows
// stay unmounted until a jump reveals them.
const messages = Array.from({ length: 60 }, (_, index) => ({
  id: `message-${index}`,
  type: "user" as const,
  text: `History message ${String(index).padStart(4, "0")}`,
  time: { created: index },
}))

const findScroll = (root: Renderable): ScrollBoxRenderable | undefined =>
  root instanceof ScrollBoxRenderable && root.getRenderable("message-59")
    ? root
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

test("an empty transcript mounts no marker column", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: {
      animations: false,
      tabs: { mode: "off" },
      session: { sidebar: "hide", scrollbar: true, scrollbar_markers: true },
    },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
    },
  })
  await setup.ready
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(findColumn(setup.renderer.root)).toBeUndefined()
}, 20000)

test("clicking the top band reveals the transcript and scrolls to the first row", async () => {
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: {
      animations: false,
      tabs: { mode: "off" },
      session: { sidebar: "hide", scrollbar: true, scrollbar_markers: true },
    },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages.toReversed(), cursor: {} })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("History message 0059"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  // The oldest rows are not mounted yet, so the transcript opens without them.
  expect(setup.captureCharFrame()).not.toContain("History message 0001")

  const scroll = findScroll(setup.renderer.root)
  if (!scroll) throw new Error("Session scrollbox not found")
  const column = findColumn(setup.renderer.root)
  if (!column) throw new Error("Marker column not found")

  // The top band's row is the first row, so the click mounts a bounded window that starts there and
  // the previously unmounted opening rows appear.
  await setup.mockMouse.click(column.x, column.y)
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(setup.captureCharFrame()).toContain("History message 0001")
}, 20000)
