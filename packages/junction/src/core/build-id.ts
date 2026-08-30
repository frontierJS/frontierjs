// core/build-id.ts
// Which build is this, and which build is the browser on.
//
// A deploy replaces the code under browsers that are already running. Their HTML
// and their JavaScript are the previous build's, and they keep calling this API
// — which is fine until it isn't, and the failure is silent on both sides: the
// person sees a screen that half works, and nothing anywhere connects it to the
// deploy that caused it.
//
// **The server STATES its build; the client compares.** That is the whole
// protocol, and it is arranged this way because the alternative — the server
// reading the caller's build and diffing it per request — puts a comparison on
// every call to answer a question that changes at most once per deploy, and it
// has to be implemented twice because the two transports carry headers
// differently. Stating a value once per response and once per connection is the
// same fact on both wires, and the side that knows what to do about it is the
// side holding the stale code.
//
// ─── it is the BUILD and not the Release, on purpose ─────────────────────────
//
// A Release is the image digest, the bindings, the schema surface and the pivot
// (`packages/cli/core/release.js`). A browser holds none of that — it holds the
// web bundle. Two Releases can share one web bundle, which is every API-only or
// schema-only deploy, and telling those browsers they are stale would be a
// reload prompt for a change that cannot affect them.
//
// It also happens to be the only identity available where it has to be stamped:
// `03-build-web` runs before `04-build-api`, so no Release id exists yet when
// the HTML is written. That is a consequence of the argument above rather than
// the reason for it — if the two disagreed, the argument would win.

/**
 * The header a response carries, and the frame field its socket equivalent uses.
 *
 * One name for both wires. It is the SERVER's build in both directions: nothing
 * here reads a build off a request, because the comparison is the client's.
 */
export const BUILD_HEADER = 'x-fjs-build'

/**
 * The field the socket's `connected` frame carries when this app knows its build.
 *
 * It rides a frame that already exists rather than a new one: `connected` is
 * sent once per socket, which is the cadence this needs — a deploy restarts the
 * container, every socket drops, and the reconnect is when a stale client finds
 * out. A client that predates the field ignores it.
 */
export const BUILD_FIELD = 'build'

/**
 * This app's build identity, or null.
 *
 * `config.build` wins so a test or an embedding app can state one; the
 * environment is how a deploy supplies it, which is what `06-swap` passes into
 * the container. Null is the ordinary answer for an app nobody deployed, and
 * every reader is inert on it — a dev server that announced a build id would be
 * announcing the string it was started with.
 */
export function resolveBuildId(config: { build?: unknown } | null | undefined): string | null {
  const declared = config?.build
  if (typeof declared === 'string' && declared.trim()) return declared.trim()

  // Reached through `globalThis` rather than the bare `process`, because this
  // module is imported by the BROWSER CLIENT for the two wire names above — and
  // a client is compiled under the app's own tsconfig, which has no node types.
  // The bare spelling put `Cannot find name 'process'` into every consuming
  // app's `tsc`, which is FJS-268's class exactly; `tests/client-types.test.ts`
  // is what caught it, by compiling a fixture the way an app does.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const env  = proc?.env?.FJS_BUILD
  if (typeof env === 'string' && env.trim()) return env.trim()

  return null
}
