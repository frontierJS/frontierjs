---
title: 02-gui
description: fli gui — what is there, what is running, what fails a check
---

## Start here — `fli gui`

```console
fli gui            # http://localhost:{{guiPort}}
```

One page, and it is the only one that knows about the rest. Three things on it
earn their place, and each is something you would otherwise do by hand:

**What can I start?** Every surface, every tool and every script in this
project, with the command that starts it and the port it will be on — read out
of the app rather than listed anywhere. The port is DERIVED: `port = env*1000 +
category*100 + project*10 + service`, one table for every app, which is why the
GUI can tell you where the API will be before it has ever been started.

**What is up right now?** Each of those, probed. This is the one that pays for
itself: *the page is blank* and *the API is not running* look identical from a
browser, and the difference is one glance here.

**Does anything fail a check?** `fli check` is the arch-test surface — around
two dozen rules over the shape of an app, most of which are silent when broken.
The page runs it, so *I should probably run that* stops being a thing you have
to remember.

The GUI is started for you now, and then asked all three questions.

```js
if (!await narrate(context)) return

context.config.__step = 2

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app = context.config.appDir

// The GUI reports which surfaces are up, so there has to be one up to report.
const api = await ensureApi(context)
if (!await must(context, api, {
  likely:    'the API did not come up — see .tutor/api.log in the workspace',
  reproduce: `cd ${app} && bun run start`,
})) return

const gui = await startServer(context, {
  name: 'gui',
  argv: fliArgv('fli:gui', '--port', String(context.config.guiPort)),
  cwd:  app,
  port: context.config.guiPort,
  // Not /api/health — the GUI does not answer that path, and a readiness probe
  // against a 404 waits out its whole retry budget before saying so.
  path: '/api/meta',
})
if (!await must(context, gui.up, {
  likely:    `something already holds ${context.config.guiPort}`,
  reproduce: `cd ${app} && fli gui --port ${context.config.guiPort}`,
})) return

const at = (path) => `http://127.0.0.1:${context.config.guiPort}${path}`

const runnables = await probe.httpJson({
  url:      at('/api/runnables'),
  expect:   (j) => (j.rows ?? []).some((r) => r.id === 'surface:./api'),
  describe: 'the API surface is listed as startable',
  name:     'what can I start',
})
if (!await must(context, runnables, {
  likely: 'the GUI reads the app in front of it — check it was started inside the app directory',
})) return

// Which port that surface is at is DERIVED — `port = env*1000 + category*100 +
// project*10 + service`, one table for every app — so the GUI knows where the
// API is supposed to be without the app telling it, and knows it before the app
// has ever been started.
const apiRow = runnables.json.rows.find((r) => r.id === 'surface:./api')

// The question a browser cannot answer about itself. Graded by AGREEMENT rather
// than by `up`: this lesson can be run with the API on another port, and then
// `down` is the correct answer and asserting `up` would be asserting the
// default. So the same port is probed here, independently, and the two verdicts
// have to match — which is false for a page that reports whatever it was told
// last, in either direction.
const mine = await probe.portAnswering({
  port:    apiRow.port,
  retries: 4,
  name:    `something answers ${apiRow.port}`,
})
if (!await must(context, await probe.httpJson({
  url:      at('/api/state'),
  expect:   (j) => (j.state?.['surface:./api']?.state === 'up') === mine.ok,
  describe: `the API reads as ${mine.ok ? 'up' : 'down'}, which is what port ${apiRow.port} is doing`,
  name:     'what is running',
  retries:  6,
}), {
  likely: 'the GUI probes the port the ports table assigns — a disagreement here is a stale reading, not a stopped app',
})) return

if (!mine.ok)
  log.info(`  (the API is on ${context.config.apiPort} for this run, so the GUI reads ${apiRow.port} as down — correctly)`)

// A scaffolded app passes its own checks. That is the assertion: an app that
// warns about itself out of the box teaches everybody to ignore the output.
//
// PASSES, not *has no findings*. An app that has declared debt in a
// `check-baseline.json` is an app whose own `bun run check` is green, and
// grading the finding count here would report it as broken — which is the panel
// disagreeing with the command it runs.
const clean = (j) => (j.scopes ?? []).length > 0 && j.scopes.every((s) =>
  (s.findings ?? []).length === 0 || (s.baseline && s.baseline.ok))

if (!await must(context, await probe.httpJson({
  url:      at('/api/check'),
  expect:   clean,
  describe: 'fli check runs and finds nothing',
  name:     'does anything fail a check',
  retries:  4,
  everyMs:  1500,
}), {
  likely:    'a finding is a real one — the page lists it with the file and the line',
  reproduce: `cd ${app} && fli check`,
})) return

// ── and now break it ────────────────────────────────────────────────────────
//
// A page that reports *nothing wrong* is indistinguishable from a page that
// cannot report anything, and the whole value of this panel is the second
// reading being false. So one file is written that breaks two named rules, the
// panel is asked again, and the file is removed.
//
// A `.mesa` in `src/resources/` is a Resource: PascalCase singular, named for
// its model, with a `<script module>` holding the data half. `notes.mesa`
// holding only markup is neither — a component in the wrong folder.
const ghost = join(app, 'web', 'src', 'resources', 'notes.mesa')
writeFileSync(ghost, '<div>a component, in the wrong folder</div>\n', 'utf8')

const broken = await probe.httpJson({
  url:      at('/api/check'),
  expect:   (j) => (j.scopes ?? []).some((s) => (s.findings ?? [])
              .some((f) => f.rule === 'resource-script' || f.rule === 'resource-file-name')),
  describe: 'the panel reports the rules that file breaks',
  name:     'and it says so when something is wrong',
  retries:  4,
  everyMs:  1500,
})

rmSync(ghost, { force: true })

if (!await must(context, broken, {
  likely: 'the panel reads the same engine `fli check` does — a clean answer over a broken file is the finding',
})) return

// Back to clean, so the fault is shown to be the FILE and not the app.
if (!await must(context, await probe.httpJson({
  url:      at('/api/check'),
  expect:   clean,
  describe: 'nothing again, with the file gone',
  name:     'and clean again once it is removed',
  retries:  4,
  everyMs:  1500,
}), {
  likely: `the file was removed — if this still reports, look at what it names: ${ghost}`,
})) return

const rules = broken.json.scopes.flatMap((s) => s.findings ?? []).map((f) => f.rule)
log.info('')
log.info(`  one file, two rules: ${[...new Set(rules)].join(' · ')}`)
log.info('')

log.info('')
log.info(`  the GUI is at http://localhost:${context.config.guiPort} — leave it open`)
log.info('')

remember(context, '02-gui', {})
```
