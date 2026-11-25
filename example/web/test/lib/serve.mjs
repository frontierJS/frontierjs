// web/test/lib/serve.mjs — the readiness wait for a server a drive started.
//
// A server that dies at boot -- a sink port a peer drive still holds, a port
// the previous drive's API has not let go of -- otherwise reads as a slow start
// for the whole wait and is reported as one, with its stderr thrown away
// (FJS-3655, FJS-4324, FJS-4626). So the wait watches the process as well as
// the URL, and a drive's own copy of it is refused by serve.test.mjs.

/** Keep the last 2000 characters of a process's output, for `waitForServer` to print. */
export function keepTail(proc) {
  proc.tail = ''
  const keep = d => { proc.tail = (proc.tail + d).slice(-2000) }
  proc.stdout?.on('data', keep)
  proc.stderr?.on('data', keep)
  return proc
}

/**
 * Poll `url` until `ready(response)`, the process exits, or `tries` × 250ms pass.
 * `init` is the fetch init, for a readiness route that only answers a POST.
 */
export async function waitForServer(url, label, proc, { tries = 120, init, ready = r => r.ok } = {}) {
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      console.error(`${label} exited (${proc.exitCode ?? proc.signalCode}) before answering on ${url}:\n${(proc.tail ?? '').trim()}`)
      return false
    }
    try { if (ready(await fetch(url, init))) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} gave no answer on ${url} within ${tries * 250}ms`)
  return false
}
