---
id: registers
status: proposed
dated: 2026-09-05
---

# Idea — the registers as a surface

**Status: IDEA. Nothing here is built.** Dated 2026-09-05. Two defects found while
asking the question are fixed and closed ([`FJS-916`](../ISSUES.md#fjs-916),
[`FJS-917`](../ISSUES.md#fjs-917)); everything this paper proposes is unbuilt. Do
not cite it as describing behavior — see [`VERIFYING.md`](../VERIFYING.md).

---

## The question

This repo keeps what is wrong in [`ISSUES.md`](../ISSUES.md), what is settled in
[`DECISIONS.md`](../DECISIONS.md) and what is not started in `IDEAS/`, and three
tools read all three: a checker, a map and an atlas. **Can a project that is not
this one do the same?**

The measured answer is that most of the READING already works, none of the WRITING
exists, and until this week the checker passed on registers it could not parse.

## What is already here

| Piece | Where | Outside this repo |
| --- | --- | --- |
| One reader | [`core/registers.js`](../packages/cli/core/registers.js) | `IDEAS/` yes, issues and decisions no — the id prefix is in the regexes |
| The grader | [`core/register-check.js`](../packages/cli/core/register-check.js), 15 rules, 11 of them errors | **Yes, today.** It runs off the project root, so a flat directory with an `ISSUES.md` is graded — measured |
| The CI phase | `registers`, in [`scripts/ci.mjs`](../scripts/ci.mjs) | This repo only |
| Two pages | `fli ws:atlas`, as a deck or `--as=report` | Needs a `packages/` monorepo; a flat project falls through to `$WORKSPACE_DIR` and then to a prompt |
| The prose rules | seven under *the notes* in [`core/checks.js`](../packages/cli/core/checks.js) | This repo only — every one is `scope: 'repo'` |
| The record shape | frontmatter per file | `IDEAS/` is already there; issues and decisions are still a table and a run of headings |

**The last row is the one that matters, and it is not a proposal — it is a
migration already declared.** `registers.js` opens by saying the three registers
are moving to one shape: a markdown file per record, frontmatter for what must be
typed, prose for the argument. `IDEAS/` arrived there first, which is exactly why
it is the one register that reads correctly under any id prefix: its ids come out
of frontmatter and a filename, and nothing pattern-matches them.

## What was actually run

Everything above is a probe rather than a reading, dated 2026-09-05. The fixture
is a throwaway two-package monorepo — a `package.json` declaring `workspaces`, a
`.git`, one package with a `verify` script, and an `ISSUES.md` whose rows are
`ACME-1` — because `findWorkspaceRoot` wants a `packages/` directory plus one of
those two markers and answers nothing without them.

**`fli ws:atlas` ran clean.** A 32KB page titled *acme — field atlas*, the
package and its drive on it, and no row of this repo anywhere in it. That is the
encouraging half of this whole paper: the deck already reads a tree it has never
seen, because every section whose source is absent is omitted rather than faked,
and the plates are dealt from that tree's own files.

**The report presentation printed this repo's port table as that project's**, which is
[`FJS-917`](../ISSUES.md#fjs-917) and is fixed. Worth keeping for the shape rather
than the defect: the map renders the registry as a section and the atlas looks one
project up by card key, so the same model leaked through one page and not the
other, and the page it leaked through is the one nobody diffs by eye.

**`fli register:check` answered `0 open · ✓ every register agrees with itself`,
exit 0**, over a table of live defects — [`FJS-916`](../ISSUES.md#fjs-916), also
fixed. It now names the lines it could not read.

**A flat directory is a different answer for each tool.** With an `ISSUES.md` and
no `packages/`, `register:check` grades it (it resolves the project root, not the
workspace root) and both pages fall through to `$WORKSPACE_DIR` and then to an
interactive prompt.

**Re-probe with `node packages/cli/bin/fli.js`, never a bare `fli`.** The global
binary on the machine this was measured on was linked to a different checkout, so
the first three runs described a tree nobody was editing. The package's own
`CLAUDE.md` names this trap for commands; it applies to probing them too.

## What is missing

Five things, in cost order, each measured rather than supposed.

**The prefix is written into the reader.** `FJS-` appears in the issue row
matcher, in both ruling matchers and in the citation scanner. A project using
`ACME-1` parses to nothing — and every rule is asked of the records that parsed,
so a file none of them came from is a file all of them pass. That was
[`FJS-916`](../ISSUES.md#fjs-916): the check now reports what it could not read,
which turns a silent pass into a legible refusal, and leaves the actual fix — one
declared prefix — unbuilt.

**Nothing writes a register.** `register:check` is the whole namespace. Adopting
this today means hand-writing a table row with an `<a id>` anchor in it, choosing
the next id by grepping the two files, and closing a row by moving it between two
sections. **That is the adoption cost, and it is not the half that has code.**

**A scaffolded app is given none of them.**
[`core/app-config.js`](../packages/cli/core/app-config.js) is the one owner of
what `fli new` hands an app — dependencies, the four check scripts, the configs —
and it does not mention a register.

**The two pages want a monorepo.** `findWorkspaceRoot` in
[`core/utils.js`](../packages/cli/core/utils.js) requires a `packages/` directory
plus either a `workspaces` field or a `.git`, which is right for what those
commands were written for and wrong for an app. A `--root` flag closes it.

**The prose rules are repo-scoped.** Of the seven, `doc-cites-dead` — every path,
link and register id a document cites resolves — is the one an adopting project
would want most, and it is the one it cannot have.

## What this is not

- **Not an issue tracker.** No assignment, no notifications, no outside reporters,
  no UI beyond a page that is generated and read.
- **Not a sync with GitHub Issues.** Two writable copies of one register is the
  restatement this whole idea is against.
- **Not a new format.** The target shape exists and one register is already in it.
- **Not a package.** It is `fli`, which an app already has.

## Why files, when the convention is a tracker

This is **coherence against convention** ([`PHILOSOPHY.md`](../PHILOSOPHY.md) §IV)
and it goes against the convention, so the reasons have to be written down rather
than assumed.

A register in the repo is **readable at rest** — an agent opening the tree has the
open defects, the settled arguments and the unstarted work without a network call
or a credential. It is **versioned with the code it describes**, so the branch that
fixes a thing closes it in the same diff. A citation from a code comment
**resolves**, which is what lets a rule grade one. And it can be **graded at all**:
`doc-cites-dead` and the fifteen register rules are only possible because the
register is a file in the tree.

The costs are real and are the tracker's advantages: no notification when
something changes, no way for somebody without a checkout to file, and a hot file
that merge-conflicts. A project with outside reporters should keep the tracker and
should probably not adopt this.

## The nine questions

Answered before any code was written, which is the only way the answers are a
decision rather than a defence.

| [§ V](../PHILOSOPHY.md) | Answer |
| --- | --- |
| Another origin of truth? | No — fewer. One record shape replaces three hand-parsed ones |
| Concept budget? | One noun, *register*, already coined and already the module name |
| Whose complexity? | The problem's. Every project has open defects, settled arguments and unstarted work |
| Predictability? | Held, if the prefix is declared in one place. Lost if each project invents its own field set |
| Derived, not restated? | The pages are pure derivation; the registers become the origin they read |
| One owner? | `core/registers.js` already is it |
| Boundary explicit? | `register:check` is the boundary, and it failed open until `FJS-916`. Closing that is a prerequisite, not a follow-on |
| Failure proportional? | Yes — a wrong page. The exception was a green check over an unreadable register, which was above the line and is fixed |
| Wrong with nothing saying so? | Was, twice, and both are closed. The remaining gaps are absences that announce themselves |

No standing adjudication is in tension except the one named above.

## If this is taken

**Build the first two and stop.** A declared prefix, and the verbs that write a
record. Three, four and five are conveniences and none of them is load-bearing —
an adopting project that hand-edits its registers still gets fifteen rules and two
pages, which is more than it had.

The first two are also **one piece of work rather than two**, and that is the
observation this paper exists for: once a record is a file with frontmatter, its id
is a declared field and there is no prefix to match. Finishing the migration
`registers.js` already describes removes the prefix problem instead of solving it,
and gives the write verbs something to write.

## Open questions

- **Where a prefix is declared**, if the migration does not remove the need —
  `.fli.json`, a `fli` key in `package.json`, or derived from the workspace name.
- **Whether closing a row is a verb or an edit.** Today it is a move between two
  sections of one file; file-per-record makes it a frontmatter field, and then
  `ISSUES.md` is a generated index rather than the register.
- **Whether `ISSUES.md` survives as a file at all** under that migration, or
  becomes what `IDEAS/overview.md` already is: derived, ranked, authoritative over
  nothing.
