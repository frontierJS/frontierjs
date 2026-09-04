---
id: claim-checking
status: proposed
dated: 2026-09-03
---

# Idea — Claim checking: a compiler for the prose in a repo

**Status: IDEA. Nothing here is built.** Dated 2026-09-03. No code in this repo
implements it as a general tool, though four things in the tree are pieces of it
and are named below. Do not cite this file as describing behaviour — see
`VERIFYING.md`.

**This is the only file in `IDEAS/` that is not about FrontierJS.** It is about
what this repo discovered while building FrontierJS, which is a different thing
and possibly a larger one. It is filed here because there is nowhere else to file
it, and because the argument depends entirely on evidence that only exists here.

---

## The claim

Code has a compiler. Prose does not.

Every repository carries statements about itself — in `README.md`, in
`CLAUDE.md`, in design notes, in comments, in a register of open defects. Those
statements reference the tree: a file path, a function name, a command, a flag, a
line number, a count. **Nothing resolves those references.** A type checker fails
when code names a symbol that is not there; nothing fails when prose does.

That was tolerable while the reader was a person, because a person notices the
file is missing and loses ten minutes. It stopped being tolerable when the reader
became an agent, because an agent reads a stale claim as a premise and writes code
from it at speed, and the output looks exactly as confident as correct output does.

Every team that adopted coding agents in the last eighteen months started writing
these files — `CLAUDE.md`, `AGENTS.md`, editor rule files, instruction files.
**None of them is checked by anything.** There is no linter, no CI phase, no gate.
The category is empty.

---

## The evidence

Two prototypes, forty lines each, run against this tree on 2026-09-03. This repo
is the hardest possible case for the argument: 613 markdown files, a
`register-check` CI phase that already grades three registers, a `fli check`
engine of 3,127 lines, and `VERIFYING.md` at the root telling everyone not to
trust a status file. If claims rot here they rot anywhere.

**Class 1 — does the referenced path exist?**

```
1,797 markdown links to repo-relative paths      28 unresolved
```

The 28 break down, and the breakdown is more useful than the number:

| Kind | Count | What it is |
| --- | --- | --- |
| **Link rot** | 17 | The path is written from the repo root inside a nested document, so it resolves to `IDEAS/packages/litestone/…`. The file exists; the link is dead in every browser and editor that follows it. Sixteen are one file, `IDEAS/shared-pure-functions.md` |
| **Genuinely gone** | 2 | `example/web/test/verify-public.mjs` and `packages/junction/tests/service-actions.test.ts`, both cited from `ISSUES_ARCHIVE.md`. Arguably acceptable in an archive, which is itself a rule the tool would need to be told |
| **False positive** | 9 | Regex literals in prose that happen to match link syntax. Stripping fenced code blocks removed ten more; the rest need a real parser |

**No false claims in this class.** Every path that a reader would go looking for
is a path that exists. That is a good result and it is the ceiling of what a link
checker can tell you.

**Class 2 — is the claim about the contents true?**

Several documents here cite a symbol at a line number — a markdown link whose
target ends `#L44`, followed by a backticked `pluralizeWord`. That is a checkable
assertion: read line 44 of the named file, look for the symbol.

(Written out literally here rather than shown as a link, because `fli
register:check`'s own `dead-link` rule reads any link target in a document as a
claim about the tree — including one inside an example. The first draft of this
file was the only error in the whole register. That is the tool working, and it
is the false-positive budget in § Open questions arriving early.)

```
3 line-precise symbol claims                     3 wrong
```

```
IDEAS/shared-pure-functions.md
    claims  packages/litestone/src/core/ddl.js:44 = `pluralizeWord`
    line 44 is: }
    pluralizeWord actually at line 7

IDEAS/shared-pure-functions.md
    claims  packages/litestone/src/tools/introspect.js:62 = `toSingular`
    line 62 is: function toPascalCase(str) {
    toSingular actually at line 25

IDEAS/shared-pure-functions.md
    claims  packages/junction/src/core/litestone.ts:271 = `deriveModelName`
    line 271 is: }
    deriveModelName actually at line 340
```

Three of three. **The rot rate rises with the precision of the claim**, which is
the finding: a vague claim survives because nothing can contradict it, and the
useful ones — the ones an agent would act on — are exactly the ones that decay.
A sample of three is a sample of three; what it establishes is that the class
exists and that this repo, which is the strongest counter-example available,
scores zero on it.

The scripts are below in § *Reproducing the measurement*.

---

## What the tool is

Three parts, and it is worth stating them against `tsc` because the shape is the
same and the analogy is the whole design:

| `tsc` | this |
| --- | --- |
| code references a symbol | prose references a path, a symbol, a command, a flag, a count |
| the resolver finds it | the resolver finds it |
| a type error when it is absent or the wrong shape | a **claim error** |

Five classes of check, cheapest first. The order matters: each one costs more to
implement than the last and each finds a defect the one above it cannot see.

1. **Reference.** A document names a file, a function, a command, a flag. Does it
   exist? Cheap, language-agnostic, and it found 19 real defects here in an hour.

2. **Generated.** A block declares it was produced by a command. Rerun it, diff
   the output. **This repo already has the best design for this and it is buried
   in a CI script**: every `*.snapshot.*` file names the command that wrote it in
   its own header, and the `snapshots` phase reruns that command with `--check`
   from the file's own directory. It carries no central list, so a new kind of
   snapshot costs a generator and never a CI edit. It also solved the deletion
   problem — discovery alone fails open, so the expectation comes from the base
   ref. That is a genuinely good piece of design and nothing outside this repo
   has it.

3. **Register.** Ids unique, citations resolving, statuses inside a declared
   vocabulary, rows the shape their table's header declares. This is
   `packages/cli/core/register-check.js`, already built and already generic —
   289 lines, zero dependencies, plain ESM. Its own header records what the first
   parse found: *three ids each naming two different defects, one id naming three
   rulings, and 84 rulings with no id at all.*

4. **Coverage.** Code changed and no claim covers it. `packages/cli/core/proofs.js`
   is the prototype — it resolves *which drive proves the change you just made*
   and grades the match `path` · `area` · `symbol` · `package`. Its checked half
   (`proof-target`, `proof-drive-named`) is the interesting one: advice that
   fails when taken, and knowledge that exists and cannot be found.

5. **Freshness.** A claim asserted N days ago, never re-verified, whose subject
   has moved since. `ISSUES.md` already models this as a first-class status —
   `stale?` — with the measurement that makes it credible: eight rows inherited
   from an audit were re-probed and **five were wrong**.

---

## The part that is actually new

The four pieces above check claims that were written for other reasons and happen
to be machine-readable. The invention is a way to write a claim that **carries its
own authority**:

```md
The parser refuses a fractional `@default` on `@scale`.
<!-- @claim exit: bun test/schema.test.ts -t "fractional-default" -->
```

Now the sentence is a test. It compiles or it is deleted.

The design rule this repo already states, and which is the whole of what makes it
tractable: **what a rule may grade is a claim with an authority in the tree, never
what a paragraph argues.** Most prose is argument and must stay ungraded. A claim
checker that tried to grade arguments would be a hallucination detector with a
config file. What it grades is the subset that names something.

Three verdicts, not two, for the same reason every other boundary here has three:
**true** · **false** · **undecidable**. An undecidable claim is reported and never
failed, because the alternative is a tool that trains people to delete the
sentences it cannot read.

---

## Why nothing else has this

Not because it is hard. Because until recently the cost was borne by a human who
could route around it.

The adjacent things that exist are each one class and stop:

- **Doc link checkers** (`lychee`, `markdown-link-check`) are class 1 and only
  external URLs in practice.
- **Literate programming and doctests** (Rust's `cargo test --doc`, Python's
  `doctest`) are class 2 for one language, for code samples only, and require the
  claim to *be* code.
- **ADR tooling** (`adr-tools`) manages files and checks nothing.
- **`.mdx`/docs sites** render prose and verify none of it.

Nothing spans the classes, nothing is language-agnostic, and nothing has a
vocabulary for a claim that is not a code sample.

---

## Why it could only have been found here

It was not designed. It was **paid for, one defect at a time**, which is why the
pieces are odd shapes and why they are right. Every rule in `checks.js` exists
because something broke silently and cost a day. `stale?` exists because five of
eight inherited rows were wrong. `register-check.js` exists because the register's
own rules were held up by nobody.

A clean-room version of this would be somebody's opinion about documentation
hygiene. This one is a bill.

It also needed a rare environment: one very large system, one maintainer, heavy
agent use, and an obsessive record. Few repositories have all four, which is
plausibly why the category is still empty.

---

## What would have to be built

The prototypes prove the cheap half. What is unbuilt:

- **A parser worth the name.** Ten of the 28 findings above were regex literals in
  prose. A real reader has to know code spans from prose, and reference syntax
  from a sentence that happens to contain a slash.
- **The claim syntax**, and a decision about whether it is an HTML comment (invisible
  in rendered output, which is right) or a fenced directive.
- **A resolver per language** for the symbol class. The line-number check above is
  a substring scan; a real one wants a parse.
- **Baselines and a ratchet**, which this repo already has the shape of
  (`check-baseline.json`, `typecheck-baselines.json`, `--update` unable to raise,
  `--adopt` as the separate verb). No repository can adopt a claim checker
  big-bang; every one of them starts red.
- **The extraction itself.** `checks.js`, `register-check.js` and `proofs.js` are
  written against this workspace's own conventions. What is generic is maybe a
  third of it and the boundary has never been drawn.

---

## Reproducing the measurement

Both scripts are plain node, no dependencies, run from the repo root.

```js
// class 1 — does the referenced path exist?
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
const docs = execSync('git ls-files "*.md"').toString().trim().split('\n')
let checked = 0; const broken = []
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8').replace(/```[\s\S]*?```/g, '')
  for (const m of text.matchAll(/\[[^\]]*\]\((?!https?:|#|mailto:)([^)#\s]+)[^)]*\)/g)) {
    const t = m[1], base = doc.split('/').slice(0, -1).join('/')
    const abs = t.startsWith('/') ? t.slice(1) : (base ? base + '/' + t : t)
    const norm = abs.split('/').reduce((a, p) =>
      (p === '..' ? (a.pop(), a) : p === '.' ? a : (a.push(p), a)), []).join('/')
    checked++
    if (!existsSync(norm)) broken.push(`${doc}  ->  ${t}`)
  }
}
console.log(`checked ${checked} refs - BROKEN ${broken.length}\n` + broken.join('\n'))
```

The class-2 script is the same walk, matching a link carrying `#L<n>` followed by
a backticked symbol, then reading that line of that file and looking for the
symbol in it. Both are reproduced verbatim in the session that filed this.

---

## Open questions

- **Is this a product or a phase of `fli check`?** Filed as an idea because the
  answer is probably *both*, and because the interesting version is the one that
  runs in a repository that has never heard of FrontierJS.
- **What is the relationship to `atlas`** (`IDEAS/package-map.md`), which is *the
  app model as a product*? Atlas describes an app from its seed. This describes
  any repository from its prose. They share the instinct and share no code.
- **Does a claim need a stable id**, the way a defect does, so it can be cited,
  retired, and allowed? The registers say yes for defects and rulings. A claim is
  cheaper and more numerous, and an id per claim may be the thing that makes it
  unusable.
- **What is the honest false-positive budget?** A claim checker that cries wolf is
  a claim checker people baseline to zero and forget, which is the failure mode
  `check-baseline.json` was invented to survive.

---

## See also

- `VERIFYING.md` — the practice this would automate
- `packages/cli/core/register-check.js` · `core/proofs.js` · `core/checks.js` — the three built pieces
- `scripts/ci.mjs` § the `snapshots` phase — the best design in the tree, and the one most worth generalising
- `ISSUES.md` § Conventions — `stale?`, and why it is load-bearing
- `IDEAS/committed-artifacts.md` — the adjacent argument about generated files
- `IDEAS/package-map.md` § `atlas` — the app-model-as-product sibling
