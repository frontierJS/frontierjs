# Rank

## Overview

`@rank` is a position a person drags: a card in a board column, a page among its siblings. The value is a fractional key, a short base-62 string, so a key can always be minted between two neighbors. Moving a row writes that one row, and never renumbers the rows around it (`FJS-D366`).

```lite
model Issue {
  id      Int    @id
  title   String
  stateId Int
  rank    String @rank(scope: stateId)

  @@index([stateId, rank])
}
```

```js
const a = await db.issue.create({ data: { id: 1, title: 'First', stateId: 1 } })
const b = await db.issue.create({ data: { id: 2, title: 'Second', stateId: 1 } })
const c = await db.issue.create({ data: { id: 3, title: 'Elsewhere', stateId: 2 } })

a.rank  // → 'V'  (first in state 1)
b.rank  // → 'W'  (after it)
c.rank  // → 'V'  (state 2 is a scope of its own)
```

The `@@index` is yours to declare. A create reads the last key in its scope, and without the index that read is a scan.

## What litestone does with it

- **A create with no key lands at the end of its scope.** The lookup runs inside the write, so two creates in one scope get two keys.
- **An update that moves a row to another scope without stating `rank` lands at the end of the new scope.** One that states both is taken as written. One that names the scope the row is already in does not move it.
- **A read sorted by the rank ties on the primary key**, in the same direction. Two devices that split one gap at the same moment mint the same key, and the id after it keeps that tie in one order on every read.
- **A key you state must be one the toolbelt could mint**: base-62 digits, not ending in `0`. Anything else is refused by name.
- **`updateMany` that moves rows to another scope without stating `rank` is refused.** One statement would give every row the same key. Move each row with `update()`.
- **`upsertMany` keeps a conflicting row's key** unless the conflict moves it to another scope.

## Minting a key yourself

A drag is a move between two neighbors, and the device mints the key from the rows it read. The functions are `@frontierjs/toolbelt/rank`, the same ones litestone uses:

```js
import { between, jittered } from '@frontierjs/toolbelt/rank'

const x = await db.issue.create({ data: { id: 1, title: 'First', stateId: 1 } })
const y = await db.issue.create({ data: { id: 2, title: 'Second', stateId: 1 } })
await db.issue.create({ data: { id: 3, title: 'Elsewhere', stateId: 2 } })

// Drag issue 3 into state 1, between the two.
await db.issue.update({ where: { id: 3 }, data: { stateId: 1, rank: between(x.rank, y.rank) } })

const moved = await db.issue.findUnique({ where: { id: 3 } })
x.rank < moved.rank && moved.rank < y.rank  // → true
```

`between(a, b)` is the middle of the gap, and `null` on either side is the start or the end of the list. `jittered(a, b)` takes a random path into the gap instead, so two people dropping into one gap at once rarely mint the same key. Sierra's `resource.move()` uses it.

## Rebalancing

Every drop into one gap adds about a fifth of a character. A spot dropped onto a few hundred times grows its keys long enough to outgrow a `@length`. `rebalance()` rewrites a scope's keys, evenly spaced and all one width, keeping the order:

```js
for (let id = 1; id <= 3; id++) await db.issue.create({ data: { id, title: `Issue ${id}`, stateId: 1 } })

await db.issue.rebalance({ where: { stateId: 1 } })  // → { count: 3 }
```

It reads through the caller's own policy and writes each row whose key changes as its own `update()`, so each one is announced and its `@version` bumps. A `where` spanning several scopes spreads each one on its own. On a model with more than one `@rank`, name the field: `rebalance({ where, field: 'rank' })`.

## The scope

The scope is the columns the order is kept within, one or a list. They are compared with `IS`, so every row whose `parentId` is NULL shares one scope, which a tree's top level needs:

```lite
model Page {
  id          Int    @id
  workspaceId Int
  parentId    Int?
  rank        String @rank(scope: [workspaceId, parentId])
}
```

```js
const root1 = await db.page.create({ data: { id: 1, workspaceId: 1 } })
const root2 = await db.page.create({ data: { id: 2, workspaceId: 1 } })
const child = await db.page.create({ data: { id: 3, workspaceId: 1, parentId: 1 } })

root1.rank < root2.rank  // → true  (both roots, one scope)
child.rank               // → 'V'   (first under page 1)
```

## Adopting it on a column that already holds keys

`@rank` on an existing `String` column changes no DDL, so there is no migration. If the column holds keys the toolbelt would not mint, such as `'a0'` from a literal `@default`, the next create in that scope is refused and names `rebalance()`. Run it once per scope, and the keys are ones `@rank` can extend.
