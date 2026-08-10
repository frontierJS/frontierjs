#!/usr/bin/env bun
/*
 * build-vocabulary.js — vocabulary.js → vocabulary.json.
 *
 *   bun run build:vocabulary   → vocabulary.json (committed, shipped)
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * `vocabulary.js` is the Structure half of the package and the only machine
 * readable statement of what the 55 terms are. It is a CLASSIC SCRIPT — it
 * declares `const VOCAB` at top level and exports nothing — because the guide
 * needs it to run before guide.js, and a module script is deferred until after
 * every classic one. test/run.js inlines its source into the generated page
 * for the same reason.
 *
 * That constraint is real and stays. Its cost is that the file ships in the
 * tarball and a consumer cannot read it: `import('@frontierjs/css/vocabulary.js')`
 * resolves to a module with no bindings. The only way in was to fetch the
 * source and `new Function` it, which is a thing no consumer should have to
 * do to ask which element a Card is.
 *
 * So the JSON is emitted FROM the script rather than the script rewritten.
 * One source, one direction, no second copy to edit.
 *
 * ── Why it is not built into dist/ ───────────────────────────────────
 *
 * dist/ is gitignored and rmSync'd at the top of every build. An artifact
 * there exists only on the publishing machine, so anyone reading the repo —
 * or installing from git — would find the JSON missing and the `exports` entry
 * pointing at nothing. It sits at the package root beside its own source, is
 * committed, and `meta.spec.js` fails if it drifts.
 *
 * ── Reading it ───────────────────────────────────────────────────────
 *
 * The file is evaluated, not parsed. A parser over the source would be a
 * second definition of the format and would rot the first time the shape
 * changed; evaluating it means the emitted JSON is by construction what the
 * guide and the specs see.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, 'vocabulary.js');
const outPath = join(here, 'vocabulary.json');

const source = readFileSync(srcPath, 'utf8');

/*
 * Capture the bindings the classic script declares. Named explicitly rather
 * than swept up, so a new top-level const in vocabulary.js does not silently
 * change the shape of the published JSON — adding one to the payload is a
 * decision, and it is made here.
 */
let bindings;
try {
  bindings = new Function(
    `${source}\n;return { VOCAB, ANATOMY, NOT_ANATOMY, NOT_A_TERM };`
  )();
} catch (err) {
  console.error(`\n  ✗ vocabulary.js did not evaluate: ${err.message}\n` +
                `    The JSON is generated from it, so it cannot be emitted.\n`);
  process.exit(1);
}

const { VOCAB, ANATOMY, NOT_ANATOMY, NOT_A_TERM } = bindings;

/*
 * VOCAB is [tier, blurb, [[Term, element, meaning, class?], …]] — positional,
 * which is right for a file a person edits and wrong for one a program reads.
 * The tuple becomes named keys here.
 *
 * `class` is the lowercased term unless the fourth slot says otherwise, and
 * `null` in that slot means the term has no class at all (Heading is <h1>–<h6>,
 * Section and Group are structural). Those are different facts and the JSON
 * keeps them different: an absent slot resolves to the derived class, an
 * explicit null emits `"class": null`. Collapsing them would tell a consumer
 * that `.heading` is a class it can write.
 */
const terms = [];
for (const [tier, blurb, rows] of VOCAB) {
  for (const [term, element, meaning, cls] of rows) {
    terms.push({
      term,
      tier,
      tierBlurb: blurb,
      element,
      meaning,
      class: cls === undefined ? term.toLowerCase() : cls,
    });
  }
}

const payload = {
  $comment:
    'Generated from vocabulary.js by build-vocabulary.js — do not edit. ' +
    'vocabulary.js is the source and is a classic script by necessity; see that file.',
  version: JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version,
  counts: {
    terms: terms.length,
    tiers: VOCAB.length,
    anatomy: Object.keys(ANATOMY).length,
  },
  terms,
  anatomy: ANATOMY,
  notAnatomy: NOT_ANATOMY,
  notATerm: NOT_A_TERM,
};

/*
 * Refuse to write an empty or truncated payload. The generator evaluates
 * arbitrary source; a vocabulary.js that parsed but declared nothing would
 * otherwise publish a valid JSON file describing no design system at all.
 */
if (terms.length < 50 || !Object.keys(ANATOMY).length) {
  console.error(`\n  ✗ Refusing to write: ${terms.length} terms, ` +
                `${Object.keys(ANATOMY).length} anatomy entries — that is not the vocabulary.\n`);
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

console.log(`\n  @frontierjs/css → vocabulary.json\n`);
console.log(`  ${payload.counts.terms} terms · ${payload.counts.tiers} tiers · ` +
            `${payload.counts.anatomy} with anatomy\n`);
