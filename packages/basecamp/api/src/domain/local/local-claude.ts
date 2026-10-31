// src/domain/local/local-claude.ts — who the operator's own `claude` is logged in as.
//
// The sibling of `local-git.ts`: one spawn of the Claude Code binary on the
// operator's machine, and the parse of what it prints in one place. Behind
// `LOCAL_MACHINE` at the service like the rest of `domain/local/`; a deployed
// control plane would be reading ITS server's login.
//
// `claude auth status --json` is a Claude Code output, so its fields move
// without notice. `readAuthStatus` is pure and names the fields it keeps; a
// field it does not keep is dropped rather than passed through, which is also
// why a token, should a later version print one, cannot reach a screen. A
// missing field is `null`, never a guess, and text that is not the expected
// object is `unreadable` with the reason.
//
// The spawn is argv only (no shell), the binary is `CLAUDE_BIN`, and it is
// killed at 10 s: a `claude` that wants a TTY or a browser must not hold a
// request open.

import { childEnv } from '@frontierjs/junction'
import { env } from '../../core/env.ts'
import { read, readJsonObject, unreadable, type Read } from '../claude/claude-read.ts'

export type AuthStatus = {
  loggedIn:         boolean
  /** `claude.ai`, `console`, `api-key`... as Claude Code spells it. */
  authMethod:       string | null
  apiProvider:      string | null
  email:            string | null
  orgId:            string | null
  orgName:          string | null
  /** `max`, `pro`, `team`... — absent for an API-key login. */
  subscriptionType: string | null
}

const TIMEOUT_MS = 10_000

const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null

/** `claude auth status --json` output as an AuthStatus, keeping only the named fields. */
export function readAuthStatus(text: string): Read<AuthStatus> {
  const json = readJsonObject(text)
  if (!json.ok) return unreadable(`claude auth status: ${json.reason}`)
  const o = json.value
  if (typeof o.loggedIn !== 'boolean') return unreadable("claude auth status: no 'loggedIn' field")
  return read({
    loggedIn:         o.loggedIn,
    authMethod:       str(o.authMethod),
    apiProvider:      str(o.apiProvider),
    email:            str(o.email),
    orgId:            str(o.orgId),
    orgName:          str(o.orgName),
    subscriptionType: str(o.subscriptionType),
  })
}

/** Run `claude auth status --json`. Never throws. */
export async function claudeAuthStatus(bin: string = env.CLAUDE_BIN): Promise<Read<AuthStatus>> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, 'auth', 'status', '--json'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
      env:   childEnv(env),
    })
  } catch (e) { return unreadable(`could not start '${bin}': ${(e as Error).message}`) }

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, TIMEOUT_MS)
  try {
    const out  = await new Response(proc.stdout as ReadableStream).text()
    const code = await proc.exited
    if (timedOut) return unreadable(`'${bin} auth status' took longer than ${TIMEOUT_MS / 1000}s`)
    // A logged-out `claude` may exit non-zero and still print the JSON, so the text is tried first.
    const parsed = readAuthStatus(out)
    if (parsed.ok || code === 0) return parsed
    return unreadable(`'${bin} auth status' exited ${code}`)
  } catch (e) { return unreadable(`'${bin} auth status' failed: ${(e as Error).message}`) }
  finally { clearTimeout(timer) }
}
