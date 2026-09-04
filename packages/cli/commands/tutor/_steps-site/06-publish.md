---
title: 06-publish
description: Raise the gate, and watch the build refuse to publish
---

## The refusal

Nothing about the page changes in this step. One line in `db/schema.lite` does:

```text
@@gate("0.4.4.6")   →   @@gate("4.4.4.6")
```

Notes now need a signed-in caller to read. The page's `load()` still runs — it
uses `asSystem()`, which bypasses every rule at the Data boundary, exactly as a
build-time script legitimately does.

And the build **stops**.

That is the check this surface exists for. Sierra taps the client while `load()`
runs, compares every model it read against that model's `@@gate`, and refuses to
write a file containing data the model says needs a session. It fails **closed**:
a route it cannot decide about is refused, not assumed safe.

Then the override, in the route's own frontmatter:

```text
publishes: 4
```

*I know, and I mean it.* The build goes through. It is a line in the page rather
than a flag on the command for a reason — a reviewer reading this route sees the
claim, and it is in the committed route snapshot.

```js
if (!await narrate(context)) return

context.config.__step = 6

if (!needs(context, ['appDir', 'siteDir'], { from: '04-site' })) return

const app  = context.config.appDir
const site = context.config.siteDir
const page = join(site, 'src', 'routes', 'notes', 'index.mesa')

const edit = editSchema(context, '@@gate("0.4.4.6")', '@@gate("4.4.4.6")')
if (!await must(context, {
  ok:    edit.ok,
  name:  'reads on Note now need a signed-in caller',
  asked: 'the gate raised from 0 to 4',
  got:   edit.ok ? (edit.already ? 'it was already raised' : 'it was raised') : edit.why,
}, {
  likely: 'the scaffold wrote a different gate — raise the first number by hand',
})) return

pushSchema(context)

// The build MUST fail here, so the exec is expected to throw and a success is
// the finding. Stated this way round because a check that passes everything is
// indistinguishable from one that works until somebody publishes a user table.
let refused = false
try {
  context.exec({ command: `${context.fli} site:build`, cwd: app, stdio: 'pipe' })
} catch {
  refused = true
}

if (!await must(context, {
  ok:    refused,
  name:  'the build refuses to publish a gated model',
  asked: 'site:build to stop',
  got:   refused ? 'it stopped' : 'it published the page anyway',
}, {
  likely:    'config/sierra.config.js has no db: line, so nothing is tapped and nothing is checked',
  reproduce: `cd ${app} && fli site:build`,
})) return

// And now the override, which is the other half: a refusal you cannot get past
// is a check people work around by deleting it.
let src = readFileSync(page, 'utf8')
if (!src.includes('publishes:')) {
  if (!src.startsWith('---\n')) {
    await must(context, {
      ok: false, name: 'the page has frontmatter to add the override to',
      asked: 'a --- block at the top of index.mesa', got: 'no frontmatter',
    }, { likely: 'the page was rewritten by hand — add `publishes: 4` to its frontmatter' })
    return
  }
  writeFileSync(page, src.replace('render: static', 'render: static\npublishes: 4'), 'utf8')
}

context.exec({ command: `${context.fli} site:build`, cwd: app })

if (!await must(context, probe.fileExists({
  path: join(site, 'dist', 'notes', 'index.html'),
  name: 'with publishes: 4 declared, it builds',
}), {
  likely:    'the override is in the wrong file — it belongs in the ROUTE, not the config',
  reproduce: `sed -n '1,8p' ${page}`,
})) return

log.info('')
log.info('  the page now says, in its own frontmatter, what it publishes')
log.info('')
```
