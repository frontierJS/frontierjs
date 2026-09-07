---
title: db:export
description: Take an extract, graded as an account — the rows that leave are the rows that account can read
alias: db-export
examples:
  - fli db:export
  - fli db:export Order --as alice@example.com
  - fli db:export Order --as alice@example.com --gate ./api/src/core/gate.ts
  - fli db:export Order --system --since 2026-09-01T00:00:00Z
flags:
  as:
    char: a
    type: string
    description: Take it as this person — an email, username, name or id in the @@auth model, or Model:value
    defaultValue: ''
  system:
    type: boolean
    description: Take it as the system, which reads everything. Explicit, and stamped in the manifest
    defaultValue: false
  gate:
    char: g
    type: string
    description: The app's own getLevel — path[#export]. Without it the run grades with the default resolver
    defaultValue: ''
  tenant:
    char: t
    type: string
    description: Whose data leaves, under tenancy { strategy database }
    defaultValue: ''
  since:
    type: string
    description: Resume from a cursor a previous manifest answered
    defaultValue: ''
  format:
    char: f
    type: string
    description: Override the declared format — ndjson or csv
    defaultValue: ''
  out:
    char: o
    type: string
    description: Directory for <dataset>.<ext> and <dataset>.manifest.json
    defaultValue: ''
  stdout:
    type: boolean
    description: Rows to stdout, manifest to stderr
    defaultValue: false
  include-protected:
    type: boolean
    description: Keep @encrypted, @secret and @guarded columns. Recorded in the manifest
    defaultValue: false
  with-deleted:
    type: boolean
    description: Include soft-deleted rows
    defaultValue: false
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

const opts = [
  flag.as      ? `--as ${flag.as}`         : '',
  flag.system  ? '--system'                : '',
  flag.gate    ? `--gate ${flag.gate}`     : '',
  flag.tenant  ? `--tenant ${flag.tenant}` : '',
  flag.since   ? `--since ${flag.since}`   : '',
  flag.format  ? `--format ${flag.format}` : '',
  flag.out     ? `--out ${flag.out}`       : '',
  flag.stdout  ? '--stdout'                : '',
  flag['include-protected'] ? '--include-protected' : '',
  flag['with-deleted']      ? '--with-deleted'      : '',
].filter(Boolean).join(' ')

const dataset = context.args[0] ?? ''

await context.stream({
  command: `${litestone(context)} export ${dataset} --schema ${schema} ${opts}`,
})
```

## What it is

The one governed way data leaves this app. Before it, the only way out was a
person clicking the CSV button in Studio — a development tool, not something that
runs in production, and one that answers as the file's owner rather than as a
principal (`FJS-D230`).

**The rows that leave are exactly the rows the named account could read one at a
time.** That is not enforced by this command: an export is a paginated scoped
read, so the `@@gate` refuses below its level, the row policies narrow the file
rather than failing it, a field policy or `@guarded` column is simply absent, and
under tenancy the extract is one tenant's because the client is. Nothing grades
an extract a second time, which is why there is no second answer to who may read.

## Why `--as` names a person

A synthesized standing (`--level 5`) would evaluate every claim-based policy
against nothing, and an absent claim is `NULL` — which the SQL half reads as
*nobody* and the JS half as *everybody*. So the standing comes off a real row and
`--gate` names the app's own resolver, exactly as `fli tinker` does.

`--system` is the explicit escape. It reads everything, and the manifest says so.

## What travels beside the rows

A `<dataset>.manifest.json`, which records the principal, the declared read gate,
the policies that bounded the extract, the cursor to resume from — and
**`omitted`, the columns that did not leave and why**. A manifest that lists only
what an extract contains is a receipt; one that names the omissions is evidence,
and it is what lets somebody tell an incomplete export from a complete one later.

**Protected columns are omitted by default even for an account that may read
them.** An interactive read is a screen; an extract is a file that leaves the
machine — the same principal, a different blast radius. `--include-protected` is
the escape and it is recorded.
