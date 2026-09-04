// ─── release-view.js — the Release realm, read rather than typed ─────────────
//
// Everything this realm knows is a terminal command: `release:check` classifies
// the deploy you are about to make, `deploy:journal` says what is serving, and
// `deploy:revert --plan` says whether you can take it back. Each of them is run
// when something is already wrong, which is the wrong moment to learn that the
// change in your tree crosses the pivot.
//
// So this is the same two questions, answered where somebody is already looking
// — `fli gui`'s front page, beside *what proves this change* and *checks*.
//
// ── The split is the whole design ───────────────────────────────────────────
//
// **Local reads the TREE. Remote touches a MACHINE.** Every other panel on that
// page is local: free, instant, correct on a train. A Release panel is tempting
// to fill with what is actually serving, and that means ssh on page load — a
// side effect, a timeout, and a page that hangs because a bastion is down.
//
// So the halves are separate functions with separate routes, and the remote one
// is reached by a button. A poll would make `fli gui` a monitoring agent, which
// is the orchestrator this realm refuses.
//
// ── Nothing here re-derives a verdict ───────────────────────────────────────
//
// `classifyPivot` lives in litestone and the revert refusals live in
// `core/revert.js`; both are reached by running the command that owns them and
// reading its JSON. A second implementation is how the GUI ends up disagreeing
// with the terminal about whether a deploy can be undone, which is the one
// disagreement that costs a database.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync }                from 'node:child_process'
import { join, relative, resolve }  from 'node:path'

import { findApps } from './runnables.js'

// ─── running a command that owns an answer ───────────────────────────────────

/**
 * `fli <command>` in one app's directory, with both streams and the exit code.
 *
 * `spawnSync` and an argv array, never a shell string: the app directory is
 * derived from the tree and the target is checked against an allow-list below,
 * but Invariant 8's rule is about the SHAPE of the call and not about whether
 * this particular caller can be trusted today.
 *
 * **Both streams come back on every path, and that is not tidiness.** A deploy
 * command that REFUSES prints its reason and exits 0 (`FJS-589`), so a reader
 * that only inspects stderr when the exit code is non-zero is handed an empty
 * string and reports *the command said nothing* about a command that said
 * exactly what was wrong. Measured here: `deploy:journal` against an app with
 * no deploy block. Reading both unconditionally is correct whichever way that
 * defect is eventually settled.
 */
function fli(fliRoot, cwd, argv, { timeout = 20_000 } = {}) {
  const r = spawnSync(process.execPath, [resolve(fliRoot, 'bin/fli.js'), ...argv], {
    cwd, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    ok:     r.status === 0 && !r.error,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? '') || (r.error ? String(r.error.message) : ''),
    code:   r.status ?? null,
  }
}

/** The first well-formed JSON object in a stream, or null. A command may log around it. */
function firstJson(text) {
  const s = String(text ?? '')
  const i = s.indexOf('{')
  if (i < 0) return null
  // Commands print one object; a trailing log line after it is common, a second
  // object is not. Walking back from the last brace is enough and needs no parser.
  for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) {
    try { return JSON.parse(s.slice(i, j + 1)) } catch { /* keep walking back */ }
  }
  return null
}

// ─── the local half ──────────────────────────────────────────────────────────

const VERDICT_TONE = {
  expand:    'success',
  unchanged: 'success',
  contract:  'danger',
  unknown:   'warning',
}

/**
 * Every app in the tree, classified against the release before it.
 *
 * `fli release:check --json` per app, which is `litestone release` with the
 * app's own schema path resolved — so an app that declares two databases, or
 * puts its seed somewhere unusual, is asked the way it would be asked on the
 * command line.
 *
 * An app with no `release.snapshot.md` baseline is not a failure and not
 * silence: it comes back `unavailable` with the reason the command gave, since
 * *nothing to compare against* is a different sentence from *nothing changed*.
 */
export async function releaseLocal({ root, fliRoot }) {
  const apps = []

  for (const dir of findApps(root)) {
    // One subprocess each, and `runChecks`'s lesson applies: yielding does not
    // make it faster, it makes the server answerable while it runs.
    await new Promise(setImmediate)

    const label = relative(root, dir) || '.'
    const r     = fli(fliRoot, dir, ['release:check', '--json'])
    const body  = firstJson(r.stdout)

    if (!body || !body.verdict) {
      apps.push({
        label, dir: label, verdict: 'unavailable', tone: 'muted',
        counts: null, findings: [], baseline: null,
        note: (r.stdout + '\n' + r.stderr).trim().split('\n').filter(Boolean).pop() ?? 'no verdict',
      })
      continue
    }

    apps.push({
      label,
      dir:      label,
      verdict:  body.verdict,
      tone:     VERDICT_TONE[body.verdict] ?? 'muted',
      counts:   body.counts ?? null,
      baseline: body.baseline?.label ?? null,
      note:     body.baseline?.note ?? null,
      findings: (body.findings ?? []).map(f => ({
        severity: f.severity, subject: f.subject, detail: f.detail,
        needsBackfill: Boolean(f.needsBackfill),
      })),
    })
  }

  return { apps, attachments: attachmentsDeclared(root) }
}

// ─── attachments ─────────────────────────────────────────────────────────────

/**
 * What each app says it needs and does not own (`FJS-D158`), and whether THIS
 * machine's environment binds it.
 *
 * Read as TEXT rather than by importing the config. A `junction.config.js` is
 * the app's module — it may import from the app, read the environment, or throw
 * — and importing it into the GUI server to render a panel is a side effect
 * nobody asked for. What is wanted here is the declaration, which is a literal.
 *
 * The grading is deliberately coarse and says so: this reports *declared* and
 * *how many of its keys this shell carries*, never the verdict. The verdict is
 * `checkAttachments`' and it runs in the app's own process at startup, where
 * the defaults, the optional flag and the field specs are all in scope.
 */
function attachmentsDeclared(root) {
  const out = []

  for (const dir of findApps(root)) {
    for (const rel of ['api/config/junction.config.js', 'config/junction.config.js']) {
      const file = join(dir, rel)
      if (!existsSync(file)) continue

      let src = ''
      try { src = readFileSync(file, 'utf8') } catch { continue }

      const block = src.match(/attachments\s*:\s*\{/)
      if (!block) continue

      // The service names and their keys, from the declaration's own shape. A
      // regex over a literal is enough to LIST them; anything that needs the
      // resolved value belongs in the app's process, not here.
      const body = balanced(src, block.index + block[0].length - 1)
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{([\s\S]*?)\n\s*\}/g)) {
        const keys = [...m[2].matchAll(/([A-Z][A-Z0-9_]{2,})\s*:/g)].map(k => k[1])
        out.push({
          app:      relative(root, dir) || '.',
          service:  m[1],
          optional: /optional\s*:\s*true/.test(m[2]),
          keys,
          bound:    keys.filter(k => String(process.env[k] ?? '').trim() !== '').length,
        })
      }
    }
  }

  return out
}

/** The text between a `{` and its match. Brace counting — the input is a literal, not a language. */
function balanced(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

// ─── the remote half ─────────────────────────────────────────────────────────

/**
 * The targets a caller may name.
 *
 * An ALLOW-LIST and not a validation, because the value arrives over HTTP and
 * ends up in an argv: `fli` resolves a target from a branch by default, and the
 * only two it takes explicitly are these. A name that is not one of them is
 * refused rather than sanitised (Invariant 8 — a caller-supplied name never
 * enters a pattern, and a shell is a pattern).
 */
export const TARGETS = {
  default:    [],
  production: ['--production'],
  stage:      ['--stage'],
}

/**
 * What is serving on a target, and whether it can be taken back.
 *
 * Two commands, because two commands own the two answers. The journal is read
 * with `--json`; the revert plan has no JSON mode and is captured as the text
 * it prints, which is what an operator would have read anyway — the panel
 * renders it verbatim rather than parsing a sentence into a shape and losing
 * the refusal's own wording, which is the part worth reading.
 *
 * Never called on page load. `fli` reaches a target one command at a time over
 * ssh, and a panel that did this while you typed would be a monitoring agent.
 */
export async function releaseTarget({ root, fliRoot, target = 'default', app = null }) {
  if (!Object.hasOwn(TARGETS, target))
    return { ok: false, error: `unknown target: ${JSON.stringify(String(target).slice(0, 40))}` }

  const flags = TARGETS[target]
  const dir   = app ? pickApp(root, app) : root
  if (!dir) return { ok: false, error: `no app in this tree called ${JSON.stringify(String(app).slice(0, 60))}` }

  // A target is over a network. The journal is one round trip and the plan is
  // several, so they are bounded separately and generously — a slow bastion is
  // not a failure, and the message says which half timed out.
  const j    = fli(fliRoot, dir, ['deploy:journal', ...flags, '--json', '-n', '8'], { timeout: 60_000 })
  const body = firstJson(j.stdout)

  if (!body) return {
    ok: false, target, app: relative(root, dir) || '.',
    error: (j.stdout + '\n' + j.stderr).trim().split('\n').filter(Boolean).pop() ?? 'the journal answered nothing',
  }

  const transitions = body.transitions ?? []
  // The most recent SUCCEEDED transition, not the most recent one: a failed
  // deploy leaves the previous release up, and calling the attempt *serving*
  // would be wrong in exactly the situation somebody opened this to get out of.
  const serving = transitions.find(t => t.status === 'succeeded') ?? null

  const p = fli(fliRoot, dir, ['deploy:revert', ...flags, '--plan'], { timeout: 90_000 })

  return {
    ok:      true,
    target,
    app:     relative(root, dir) || '.',
    serving: serving && {
      releaseId: serving.releaseId, id: serving.id, startedAt: serving.startedAt,
      actor: serving.actor ?? null, crossesPivot: Boolean(serving.crossesPivot),
    },
    transitions: transitions.map(t => ({
      id: t.id, kind: t.kind, releaseId: t.releaseId, status: t.status,
      startedAt: t.startedAt ?? null, actor: t.actor ?? null,
      crossesPivot: Boolean(t.crossesPivot),
      serving: t.id === serving?.id,
    })),
    // Both streams: a refusal is printed and the command may still exit 0
    // (`FJS-589`), so an empty stdout with a populated stderr is the shape to
    // show rather than the shape to call success.
    plan: {
      text: [p.stdout, p.stderr].filter(t => t.trim()).join('\n').trimEnd(),
      code: p.code,
    },
  }
}

/** An app by its tree-relative label, matched exactly. Never a path a caller composed. */
function pickApp(root, label) {
  for (const dir of findApps(root))
    if ((relative(root, dir) || '.') === label) return dir
  return null
}
