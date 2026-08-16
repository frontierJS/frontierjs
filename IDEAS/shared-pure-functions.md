# Idea — What actually belongs in `@frontierjs/toolbelt`

**Status: ASSESSMENT + RANKED WORK.** Dated 2026-08-11. Every claim below was
grepped against the tree and the implementations were read side by side, not
counted by name (`VERIFYING.md`). Two live defects were found while surveying
and are filed as `FJS-191` and `FJS-192`; they are not proposals.

The question this answers: *the substrate package is meant to hold the shareable
pure functions of the whole repo — will that make the project meaningfully
smaller?*

**Short answer: no, and that is the wrong measure.** The extractable pure-function
surface is roughly **250–400 lines**. What the survey found instead is that
**four of the duplicated helpers have already diverged**, and in three cases the
divergence is a defect rather than waste. The value of this package is not DRY.
It is that two copies of a rule cannot disagree.

---

## The measure that misleads

A first pass counting function names suggested eight copies of `chunk`, six of
`delay`, five of `sleep`. Reading them, most were local variables in a `for` loop
or a `const` in a retry path — `chunk` had **zero** real duplicate definitions.
The name census overstated the haul by about 3×.

The honest count, after reading every hit:

| Helper | Real copies | Do they agree? |
| --- | --- | --- |
| `glow` | 2 | **No** — one is the pre-fix fork |
| pluralise / singularise | 4 | **No** — three different rule sets, three quality levels |
| `slugify` | 4 | **No** — four different outputs for the same input |
| `escapeHTML` | 2 | **No** — one omits `'` |
| `deepMerge` | 3 | **No**, and correctly so — see § Refuse |
| `toCamelCase` | 3 | Two agree; the third is a different domain |
| `EMAIL_RE` | 2 | Yes, character for character |
| `sleep` | 5 | Yes, trivially |

The four rows that disagree are the whole case for this package. The rows that
agree are the ones to leave alone.

---

## Tier 1 — extract, because the copies have already diverged

### 1. `glow` is forked, and mesa runs the version with the known bugs

`packages/mesa/src/glow.js` (211 lines) and `packages/toolbelt/src/glow/glow.js`
(371 lines) are the same highlighter. The toolbelt copy is the one that received
the fixes recorded in `packages/toolbelt/CLAUDE.md`; the mesa copy predates them.
Both bugs that file documents as *fixed* are live in mesa:

- **Encoding is still in `elem()`, per token** — `glow.js:73` encodes only a
  lone `<` or `>`. toolbelt moved it to `renderRow`, because a rule matching more
  than one character sends raw markup to the page. `compiler-md.js:302`
  explicitly HTML-*decodes* the fence body before calling `glow()`, so an HTML
  comment inside a markdown code block is decoded, not re-encoded, and reaches
  the page as live markup.
- **No `isTrailingComment`** — zero occurrences in mesa, two in toolbelt. A `/*`
  opening mid-line still starts a block and swallows the code before it, which
  renders as a disabled line.

The exported API is identical in both files — `parseRow`, `renderRow`,
`parseSyntax`, `glow` — so this is a one-line import change in `compiler-md.js`
and a deletion, not a port. Filed as **`FJS-191`**.

**It collided with Invariant 1**, which said *Mesa is a leaf with zero workspace
deps* while the substrate package's own README claimed the exemption. **Ruled
2026-08-15**: toolbelt is substrate below the graph and mesa may import it, so
`FJS-191` is now a straight import change. Was filed as
`FJS-D26`**, and it is the single most consequential thing here: without
it, the packages with the most duplication (mesa, litestone, sierra) are exactly
the ones that cannot use the package meant to hold it.

### 2. Four inflection rule sets, and the weakest one is in the resolver users hit

Invariant 2 (`model Lead` → `db.lead`) is enforced by three resolvers that must
agree. Each carries its own plural rules:

| Where | Rules | `statuses` → | `people` → |
| --- | --- | --- | --- |
| [ddl.js:44](packages/litestone/src/core/ddl.js#L44) `pluralizeWord` | 20 irregulars + `es`/`ies` | *(pluraliser)* | `person` → `people` ✓ |
| [introspect.js:62](packages/litestone/src/tools/introspect.js#L62) `toSingular` | 20 irregulars, mirrored | `status` ✓ | `person` ✓ |
| [litestone.ts:271](packages/junction/src/core/litestone.ts#L271) `deriveModelName` | `ies`/`ses`, no irregulars | `status` ✓ | `people` ✗ |
| [resource.js:501](packages/sierra/src/junction/resource.js#L501) inline | `ies`/`s` only | `statuse` ✗ | `people` ✗ |

Litestone knows that `model Status` gets table `statuses` and that `Person`
gets `people`. Sierra's inline singulariser — the one behind `createResource`,
the thing an app author actually calls — knows neither, so `modelNameFor` misses
and the resource degrades to a bare `make()` with a warning. That is why
`schema-registry.js` is documented as "regular English plurals only" and why
irregulars need `createResource('people', { model: 'Person' })` stated by hand:
**not a limit of the design, a limit of one of four copies.**

Currently **latent, not live** — no model in `basecamp` or `example` ends in
`s`, `x`, `ch`, `sh` or `z`, so the `statuses` case has never been hit. It fires
the day someone writes `model Status` or `model Address`. Filed as **`FJS-192`**.

One `inflect.js` in toolbelt — `pluralize(word)` / `singularize(word)`, one
irregular table — imported by litestone's ddl and introspect, junction's
`deriveModelName` and sierra's registry, makes a disagreement between the three
resolvers structurally impossible rather than tested for.

### 3. `slugify` — four spellings, and the schema owns one of them

| Where | Separator | Other |
| --- | --- | --- |
| [migrations.js:60](packages/litestone/src/core/migrations.js#L60) | `_` | for a filename |
| [validate.js:103](packages/litestone/src/core/validate.js#L103) | `-` | **this is what `@slug` writes** |
| [resource.ts:35](packages/basecamp/api/src/core/resource.ts#L35) | `-` | `.trim()`, `.slice(0, 64)` |
| basecamp `create.mesa` / `[id]/index.mesa` | `-` | `.slice(0, 64)`, no trim |

The migration one is a different function wearing the same name and should be
`migrationFilename()` regardless. Of the other three, **`validate.js`'s is the
authority** — it is the `@slug` transform (`validate.js:138`), so it is what the
server actually writes to the column — and it is the one no client shares. The
outputs differ on real input: `a.b_c` becomes `ab-c` through the schema and
`a-b-c` through basecamp's UI, because one strips `.` before splitting and the
other treats every non-alphanumeric as a separator.

**Latent today**: basecamp's only `@slug` field is `FeatureFlag.key`
(`schema.lite:1181`), and `Project.slug` is computed client-side and sent, so no
screen currently previews a value the server will rewrite. It becomes live the
day `@slug` is added to a field whose form shows a preview — which is precisely
the shape `create.mesa` already has, minus the annotation. The symptom then is
the worst kind: the field looks right until it is saved.

Extraction: `slugify(str, { max })` in toolbelt, with litestone's `@slug` transform
and every UI preview calling the same one.

### 4. `escapeHTML` — two copies, one incomplete

[render.js:131](packages/mesa/src/render.js#L131) escapes `&`, `<`, `>`, `"`.
[auto-gen.js:162](packages/jetty/src/build/auto-gen.js#L162) escapes those plus
`'`. Mesa's three call sites are `<title>` and double-quoted `<meta>` attributes,
so the omission is not exploitable **as currently called** — but an escaper that
is correct only for its current call sites is a trap the moment a fifth one
appears, and the file exports it. One implementation, the complete one.

---

## Tier 2 — extract, cheap, no divergence yet

- **Case conversion.** `toCamelCase` in [ddl.js:38](packages/litestone/src/core/ddl.js#L38)
  and [introspect.js:51](packages/litestone/src/tools/introspect.js#L51) are the
  same job (column ⇄ identifier); `toSnakeCase` and `toPascalCase` sit beside
  them. [compiler.js:76](packages/mesa/src/compiler.js#L76)'s is a **different
  domain** — HTML attribute to DOM property — and should keep its own name
  rather than be merged into a general one.
- **The validator regex table.** `EMAIL_RE` is byte-identical in
  [validate.js:32](packages/litestone/src/core/validate.js#L32) and
  [schema.ts:473](packages/junction/src/core/schema.ts#L473). Litestone's
  `VALIDATORS` and `DEFAULT_MESSAGES` are the fuller table and already reach the
  client as `x-messages`; junction re-states several of the same strings inline.
  Worth doing carefully rather than quickly — junction's is keyword-driven
  (JSON Schema) and litestone's is rule-driven, so the shareable part is the
  **regexes and the message strings**, not the dispatch. Note also that
  `url` disagrees outright: litestone tests `/^https?:\/\/.+/`, junction
  constructs `new URL()`. That is a third divergence, unfiled because it is
  arguably two different questions.
- **`isPlainObject`, `deepClone`** — [config/index.ts:230](packages/junction/src/config/index.ts#L230)
  has the only real copy of each today, so by toolbelt's own proposed rule
  (*anything with exactly one caller does not belong*) they wait for a second.

---

## Refuse — the extractions that would make things worse

**`deepMerge` is three functions, not one.** Jetty and junction replace arrays;
[sierra/build/index.js:271](packages/sierra/src/build/index.js#L271) **concatenates**
them, deliberately, because vite plugins accumulate. Publishing one `deepMerge`
means a caller picks array semantics by accident and a config silently gains or
loses plugins. If it moves at all it moves as two named functions —
`mergeReplacingArrays` / `mergeConcatArrays` — and the naming is most of the
value. Low priority: three callers, no drift, and the current comments each
state their own rule.

**`sleep` / `delay`.** Five copies of `ms => new Promise(r => setTimeout(r, ms))`
— three in conduit's transports, two in example drives. Nothing can diverge.
Extracting adds an import, a version, a peer range and a reinstall hazard to
save fifteen characters. Leave them.

**Backoff.** Four reconnect ladders with four different value sets, and
`backoffWithJitter` calls `Math.random()` — impure by the package's own rule, so
it could not live here even if the values agreed.

**Id generation.** `crypto.randomUUID`, a module-level counter, a seeded rng —
all impure. Toolbelt's territory, per its README.

---

## What toolbelt cannot fix

The repo's largest duplications are the ones CLAUDE.md § Open questions already
names, and **none of them are pure functions**:

- the HMR algorithm copied into sierra ×2 and jetty (sockets, module graph)
- jetty's copy of sierra's `resources/` (files, not functions)
- `auth/install.md`'s hand copy of the schema fragments (markdown)
- one frontmatter parser, three call sites — already filed as overview row 5.2

The interesting exception is **`sessionGateLevel()`**, hand-copied on both sides
of the litestone/junction boundary and *is* pure. It still cannot simply move:
toolbelt would have to hold the `SessionContext` shape, which is the same coupling
under a different name. That is a decision about where the shape lives, not a
refactor — and `toDataPrincipal()` is its other half, so both move or neither.

---

## The rule to adopt

Toolbelt's README already proposes *anything with exactly one caller does not
belong here*. The survey suggests a stronger companion rule, because a two-caller
threshold is what fills a junk drawer:

> **Extract when two copies drifting apart would be a defect — not when two
> copies exist.**

By that test `sleep` stays where it is at five copies, and `slugify` moves at
two. Every Tier 1 item above passes it; every Refuse item fails it.

---

## The hazards this package inherits

- **`bun install` copies `workspace:*` under `node_modules/.bun/` rather than
  symlinking** (CLAUDE.md § Repo). A toolbelt edit is invisible to importers until
  reinstall. toolbelt is the highest-fan-in package in the tree by design, so one
  stale copy is a stale copy in every consumer at once, and a green suite proves
  nothing. In-repo consumers must import by relative path, which is what
  `packages/css` already does.
- **Publishing silences a loose peer range.** While toolbelt is unpublished a peer
  of `"*"` fails at install by name; once published, it resolves from the
  registry silently. Below 1.0 a caret pins the minor.
- **The purity rule is unenforced.** "No I/O, no clock, no globals" is stated in
  two READMEs and checked by nothing. One `Date.now()` in a helper and the
  package's whole claim — testable with no mocks, importable from anywhere —
  quietly stops being true. A lint over `src/` for `Date.now`, `Math.random`,
  `process`, `fetch` and `node:` imports is about twenty lines and belongs in
  the `hygiene` phase of `scripts/ci.mjs`.

---

## Order of work

1. ~~**Rule `FJS-D26`**~~ — **ruled 2026-08-15**: a core package may import the
   substrate, which is now `@frontierjs/toolbelt`. Everything below was waiting
   on it.
2. ~~**`FJS-191`**~~ — **done 2026-08-15**: `compiler-md.js` imports
   `@frontierjs/toolbelt/glow`, `packages/mesa/src/glow.js` is deleted, and the
   first core package importing the substrate proved step 1 end to end. It also
   surfaced `FJS-260`, which the fork was hiding behind its own bugs.
3. ~~**`inflect.js`**~~ — **done 2026-08-15**, and it was five callers rather
   than four: sierra holds two. The shared module is the union of what the
   copies knew — litestone's irregular table and junction's `us`/`is`/`as`
   guards — which is what closed `FJS-192`.
4. **`slugify` + `escapeHTML`** — same shape, much smaller.
5. **The purity lint**, before the package grows past two exports.
6. Case conversion and the validator regexes, once 1–5 have shown the seam holds.

Tier 2 and the Refuse list should be re-derived, not assumed: this survey read
the tree on 2026-08-11 and a helper is added every week.
