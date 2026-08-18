// tests/helpers.ts
//
// The two casts this suite kept rewriting, each with one owner.
//
// Both exist because the runtime declares something more precisely than a test
// stub can say it: Bun's `fetch` carries `preconnect`, and `App` has no index
// signature on purpose (Invariant 5 — a slot is claimed with `app.claim()` and
// typed by augmenting an interface, never by making every key legal). Written
// at the call site instead, that is twenty casts, and then one of them quietly
// widens to `any`.

/**
 * `globalThis`, with `fetch` loosened to anything that answers a Response.
 *
 * `globalThis.fetch = async () => new Response(…)` does not compile: Bun's
 * `typeof fetch` declares `preconnect`, and a stub has no reason to. Assign
 * through this instead of casting the stub — the cast lives here, once, and
 * still refuses anything that is not a function answering a Response.
 */
export const stubbable = globalThis as unknown as {
  fetch: (...args: never[]) => Promise<Response>
}

/**
 * Read an object as a bag of keys — for a test asserting on a property the
 * TYPE does not declare, which is the normal shape of a test about a plugin
 * having claimed one.
 */
export function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}
