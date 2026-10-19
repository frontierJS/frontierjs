/*
 * exports-map.test.ts
 *
 * FJS-2958. Every sibling package is imported by its bare name; orion exported
 * only `./plugin`, so an app wrote `@frontierjs/orion/plugin` for the one thing
 * the package is. The plugin is the root.
 */

import { test, expect } from "bun:test"
import pkg from "../package.json"

test("the package root is the plugin, and no second key reaches it", () => {
  const exports = pkg.exports as Record<string, string>
  expect(exports["."]).toBe("./src/plugin.ts")
  expect(Object.entries(exports).filter(([key, file]) => file === "./src/plugin.ts").map(([key]) => key)).toEqual(["."])
})
