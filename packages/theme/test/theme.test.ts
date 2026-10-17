import { expect, test } from "bun:test"
import { migrateV1, parseThemeDocument, resolveThemeDocument } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const source: ThemeV1Json = await Bun.file(
  new URL("../../tui/src/theme/assets/opencode.json", import.meta.url),
).json()
const document = migrateV1(source)

const builtinSource = await Bun.file(
  new URL("../../tui/src/theme/assets/v2/opencode.json", import.meta.url),
).json()
const builtin = parseThemeDocument(builtinSource, "opencode")

test.each(["light", "dark"] as const)("resolves %s themes without status tokens", (mode) => {
  const theme = resolveThemeDocument(document, mode)
  expect("status" in theme.text).toBeFalse()
  expect(theme.hue.accent[800]).toBeDefined()
  expect(theme.hue.interactive[800]).toBeDefined()
})

test.each(["light", "dark"] as const)("resolves marker roles in the built-in %s theme", (mode) => {
  const theme = resolveThemeDocument(builtin, mode)
  // The marker roles keep the colors the marker column borrowed before the roles existed.
  expect(theme.marker.thinking.toInts()).toEqual(theme.text.feedback.warning.base.toInts())
  expect(theme.marker.tool.toInts()).toEqual(theme.text.feedback.info.base.toInts())
  expect(theme.marker.response.toInts()).toEqual(theme.decrease(theme.background.raised.base).toInts())
  expect(theme.marker.prompt.toInts()).toEqual(theme.hue.accent[200].toInts())
})

test.each(["light", "dark"] as const)("falls back to marker defaults for migrated custom %s themes", (mode) => {
  // A custom theme has no marker roles; migration must supply every role.
  const theme = resolveThemeDocument(document, mode)
  expect(theme.marker.thinking.toInts()).toEqual(theme.text.feedback.warning.base.toInts())
  expect(theme.marker.tool.toInts()).toEqual(theme.text.feedback.info.base.toInts())
  expect(theme.marker.response.toInts()).toEqual(theme.decrease(theme.background.raised.base).toInts())
  expect(theme.marker.prompt.toInts()).toEqual(theme.hue.accent[200].toInts())
})
