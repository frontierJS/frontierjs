// ─── questions.js — the graded set behind `tokens-to-fact` ───────────────────
//
// `PHILOSOPHY.md` §III *Predictability* claims you should know where something
// lives before you go looking for it. Nothing has ever put a number on that, so
// the claim has been true by assertion since it was written. This is the number:
// **what it costs to get one fact out of this workspace, and whether the fact
// came back right.**
//
// ── The answer is a CITATION, never prose ────────────────────────────────────
//
// A path, an `FJS-D##`, an `FJS-###`, a drive id. Grading is a string compare
// with no judge model in it, which is the only way the score means the same
// thing in six months. It also forces the useful shape: *where does this live*
// is answerable and *summarize this* is not.
//
// ── Written against the TREE, not against the router ─────────────────────────
//
// Every citation here was resolved by reading the artefact, before the resolver
// existed. That ordering is the whole value: an answer key written after the
// code is green passes by construction, which is the failure `decision-rules`
// names for the nine questions and it is the same failure here. The two live in
// separate files so that editing the key shows up in a diff as its own act.
//
// **Tuning a question until the router gets it is how this becomes worthless.**
// A question the router misses is a finding — usually that the fact has no home,
// or two. Change the tree or record the miss; do not change the question.
//
// ── Cost is what a READER would have to take in ──────────────────────────────
//
// Not what the resolver executed. A `grep` scans a whole file and hands back one
// row, and it is the row that lands in a context window or in a person's head.
// So the score reports both: `read`, the bytes that came back, and `scanned`,
// the bytes opened to find them. The first is the metric; the second is what
// says whether a small model could have done the same walk unaided.

/**
 * The six intents, and the artefact each one's answer is a citation INTO.
 *
 * They are separate because they take different walks, not because a question
 * feels different — `why is X this way` and `is X broken` both name X and land
 * in different registers, and a router that treats them as one returns the
 * ruling that closed the defect somebody is still hitting.
 */
export const INTENT_CITES = {
  owner:  'a source path — which file declares the seam',
  locate: 'a source path — where a named thing lives',
  ruling: 'an `FJS-D##` in DECISIONS.md',
  status: 'an `FJS-###` in ISSUES.md',
  blast:  'a drive id from DRIVES.md',
  recipe: "a package's CLAUDE.md",
}

export const QUESTIONS = [
  // ─── owner ─────────────────────────────────────────────────────────────────
  { intent: 'owner',  cite: 'packages/litestone/src/core/client.js',
    q: 'who owns $setAuth' },
  { intent: 'owner',  cite: 'packages/toolbelt/src/match/match.js',
    q: 'which file owns matchesQuery' },
  { intent: 'owner',  cite: 'packages/junction/src/core/envelope.ts',
    q: 'who owns wrapResult' },
  { intent: 'owner',  cite: 'packages/sierra/src/junction/field-rules.js',
    q: 'who owns toFieldErrors' },

  // ─── locate ────────────────────────────────────────────────────────────────
  { intent: 'locate', cite: 'packages/cli/core/ports.js',
    q: 'where does the port formula live' },
  { intent: 'locate', cite: 'packages/cli/core/checks.js',
    q: 'where is the fli check rule engine' },
  { intent: 'locate', cite: 'packages/cli/core/proofs.js',
    q: 'where is the drives table parsed' },
  { intent: 'locate', cite: 'packages/cli/core/register-check.js',
    q: 'where is the register check engine' },

  // ─── ruling ────────────────────────────────────────────────────────────────
  { intent: 'ruling', cite: 'FJS-D26',
    q: 'why may litestone import toolbelt' },
  { intent: 'ruling', cite: 'FJS-D32',
    q: 'why does frontierjs refuse a formatter' },
  { intent: 'ruling', cite: 'FJS-D263',
    q: 'why can a desktop surface use another surface src' },
  { intent: 'ruling', cite: 'FJS-D163',
    q: 'why is AGENTS.md permitted but not required' },

  // ─── status ────────────────────────────────────────────────────────────────
  { intent: 'status', cite: 'FJS-1180',
    q: 'is there an open issue about better-auth arriving with an empty body' },
  { intent: 'status', cite: 'FJS-257',
    q: 'has outpost ever run on a real machine' },
  { intent: 'status', cite: 'FJS-1193',
    q: 'is vector search built' },
  { intent: 'status', cite: 'FJS-1129',
    q: 'is there a known problem with fli proxy and a refused connection' },

  // ─── blast ─────────────────────────────────────────────────────────────────
  { intent: 'blast',  cite: 'example:verify:payrun',
    q: 'what proves a change to a pay run' },
  { intent: 'blast',  cite: 'example:verify:retro',
    q: 'which drive covers a backdated raise' },
  { intent: 'blast',  cite: 'example:verify:values',
    q: 'what proves a change to a valueset' },
  { intent: 'blast',  cite: 'example:verify:live',
    q: 'what proves a change reaches a second tab' },

  // ─── recipe ────────────────────────────────────────────────────────────────
  { intent: 'recipe', cite: 'packages/litestone/CLAUDE.md',
    q: 'how do I make a computed field in litestone' },
  { intent: 'recipe', cite: 'packages/caravan/CLAUDE.md',
    q: 'how do I declare a job in caravan' },
  { intent: 'recipe', cite: 'packages/ui/CLAUDE.md',
    q: 'how do I contribute a control to the ui kit' },
  { intent: 'recipe', cite: 'packages/mesa/CLAUDE.md',
    q: 'how does mesa decide a file is mesa and not markdown' },
]
