// core/basecamp.js — talking to a Basecamp: its API from this side as a key's
// owner, and the one enrollment command a box runs to join its fleet.
// `basecamp:app`, `basecamp:deploy`, `outpost:install` and `deploy`'s
// `08b-outpost` step share these, so a box cannot be enrolled two ways.

// The dev API's port in basecamp's own CLAUDE.md, as `fli ws:deps --push` has it.
export const LOCAL_BASECAMP = 'http://localhost:8120'

/** One call to Basecamp's API, answering the body, or throwing with what Basecamp said. */
export async function basecamp(origin, key, path, { method = 'GET', body, headers = {} } = {}) {
  let res
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new Error(`could not reach Basecamp at ${origin}: ${err.message}`)
  }
  // A path the proxy does not route reaches the SPA's file server: a GET
  // answers index.html with 200, a write a bare 405 that reads as a method bug.
  if (res.headers.get('content-type')?.includes('text/html'))
    throw new Error(`Basecamp answered ${method} ${path} with HTML (${res.status}), not the API — is ${path} a path its proxy routes?`)
  const answer = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Basecamp refused ${method} ${path} (${res.status}): ${answer?.message ?? answer?.error ?? res.statusText}`)
  return answer?.data ?? answer
}

// A root login on a box with no sudo installed runs the same scripts through a
// function of that name.
export const SUDO = 'command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }'

// The enrollment command Basecamp issued, run on the box. The command is
// written for a person with sudo. Its output is held, and a fresh image's
// first security pass is minutes of silence after this. Answers
// `{ outcome: 'installed' | 'failed', reason? }`.
export function installOutpost(machine, command, { host, log }) {
  log.info('Installing the Outpost — on a fresh box its security updates take several minutes')
  try {
    machine.run(`${SUDO}\n${command}`)
    log.success('Outpost installed — the box joins the fleet at its first heartbeat')
    return { outcome: 'installed' }
  } catch (err) {
    // The attributed message quotes the script, and the script holds a live
    // single-use token; the journal records what is logged here.
    const said = String(err.stdout ?? '').trim().split('\n').slice(-3).join(' · ')
    log.warn(`Outpost install failed on ${host}${said ? `: ${said}` : ''} — the Servers page issues a fresh command`)
    return { outcome: 'failed', reason: said || 'the install command failed' }
  }
}
