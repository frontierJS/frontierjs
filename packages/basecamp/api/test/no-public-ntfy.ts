// api/test/no-public-ntfy.ts — preloaded into every `bun test` here (bunfig.toml).
//
// A test that boots the app with no NTFY_BASE_URL and no running ntfy App gets
// rung 3 of the push ladder (`src/push.ts`), so every MonitorDown and
// ServerUnreachable it sent was published to public ntfy.sh, where a topic is
// readable by anyone who guesses it and a burst answers 429 (FJS-4608). The
// refusal is a thrown fetch, which the ntfy driver reports as a failed push
// exactly as it reports a refused one. A test that means to watch a push
// arrive names its own server, as crash.test.ts does.
//
// PUBLIC_NTFY is spelled out rather than imported: push.ts imports core/env.ts,
// which reads process.env once, and a preload would read it before any test
// file set the variables it boots with.

const PUBLIC_NTFY = 'https://ntfy.sh'
const realFetch = globalThis.fetch

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === PUBLIC_NTFY || url.startsWith(`${PUBLIC_NTFY}/`)) {
    throw new Error(`[test] refused a publish to public ${PUBLIC_NTFY}: name a local ntfy server in the test (FJS-4608)`)
  }
  return realFetch(input, init)
}, realFetch)
