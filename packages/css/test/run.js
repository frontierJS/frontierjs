#!/usr/bin/env bun
/*
 * run.js — the test driver.
 *
 * Generates one HTML page that <link>s the real ./index.css, inlines the
 * harness and every spec, runs it in headless Chrome, and reads the results
 * back out of the dumped DOM.
 *
 *   bun run test              all specs
 *   bun run test focus tone   only specs whose filename matches
 *   bun run test --keep       leave the generated page on disk for eyeballing
 *
 * ── Why Chrome and not jsdom ──────────────────────────────────────────
 *
 * Every invariant this package has is a *computed style* invariant:
 * cascade layers, color-mix(), @property inherits:false, :focus-visible,
 * :user-invalid, relative luminance. None of that exists in a DOM shim, so
 * a jsdom test would assert on the text of the CSS rather than its effect,
 * which is exactly the failure mode that let v0.6 ship documentation for a
 * system that did not exist.
 *
 * Chrome is driven with --dump-dom rather than the DevTools protocol so the
 * package keeps zero dependencies: the page computes its own results, writes
 * them into a <script type="application/json">, and the dump carries them
 * back. No puppeteer, no npm install, no lockfile entry.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { glow } from '@frontierjs/toolbelt/glow';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
/* The stylesheets live under src/ since v0.11 — the package root now holds
   only the manifest, the docs, and the tooling directories. */
const srcDir = join(pkg, 'src');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const filters = argv.filter((a) => !a.startsWith('--'));

/* ── Locate a browser ──────────────────────────────────────────────── */

const CANDIDATES = [
  process.env.FJS_CHROME,
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  for (const c of CANDIDATES) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return { bin: c, version: (r.stdout || '').trim() };
  }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error(
    'No Chrome/Chromium found. Install one, or point FJS_CHROME at a binary.\n' +
    'Tried: ' + CANDIDATES.join(', ')
  );
  process.exit(2);
}

/* ── Collect specs ─────────────────────────────────────────────────── */

const specDir = join(here, 'specs');
let specFiles = readdirSync(specDir)
  .filter((f) => f.endsWith('.spec.js'))
  .sort();

if (filters.length) {
  specFiles = specFiles.filter((f) => filters.some((x) => f.includes(x)));
  if (!specFiles.length) {
    console.error(`No spec files match: ${filters.join(', ')}`);
    process.exit(2);
  }
}

/*
 * Specs are inlined as classic scripts, so a `</script>` appearing inside a
 * spec's markup string would close the tag early and silently truncate the
 * suite. Escaping it is not optional.
 */
const escapeForInlineScript = (s) => s.replace(/<\/script/gi, '<\\/script');

const harness = readFileSync(join(here, 'harness.js'), 'utf8');

/*
 * The shipped file list, handed to the page.
 *
 * A spec runs in the browser and cannot read the filesystem, so it cannot
 * tell whether a .css file exists that index.css forgot to import. That is
 * the failure the v0.11 directory grouping made possible: a file moves into
 * components/, the @import is not updated, and *nothing breaks* — the rule
 * simply never loads, and every test still passes because no test asks for
 * it. `meta: every shipped stylesheet is reachable from index.css` closes it.
 *
 * guide/, demo/ and test/ are tooling, not the package; package.json's
 * "files" list is the same boundary.
 */
const SKIP_DIRS = new Set(['guide', 'demo', 'test', 'node_modules', 'dist']);

function collectCss(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...collectCss(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.css')) {
      out.push(rel);
    }
  }
  return out;
}

const shippedCss = collectCss(srcDir).sort();

/*
 * ../vocabulary.js, inlined into the page the same way harness.js is.
 *
 * It declares a top-level `const VOCAB` and nothing else, so injecting the
 * source hands the specs the global directly. The guide loads the identical
 * file with a plain <script src>, so there is one definition and neither
 * reader can drift.
 *
 * It cannot be `require`d — the package is "type": "module", so a CJS export
 * would not load. It cannot be an ES module either: injecting the source of
 * one into a classic <script> throws on the `export`, and giving it its own
 * module script would defer it past the suite.
 */
const vocabulary = readFileSync(join(pkg, 'vocabulary.js'), 'utf8');

/*
 * vocabulary.json is GENERATED from the file above by build-vocabulary.js, and
 * it is committed rather than built into dist/ — dist/ is gitignored and wiped
 * every build, so a consumer installing from git would find the file missing.
 *
 * A generated file that is committed goes stale silently: someone adds a term,
 * the guide and these specs see it immediately because they read the .js, and
 * the .json every OTHER consumer reads keeps describing the old vocabulary.
 * Nothing would say so until an app asked for a term that exists.
 *
 * So the runner regenerates the payload in memory and hands the specs a verdict
 * on whether the committed file matches. Regenerating rather than diffing
 * timestamps: a rebuild that changes nothing must not fail the suite.
 */
const vocabularyJsonState = (() => {
  let onDisk = null;
  try {
    onDisk = readFileSync(join(pkg, 'vocabulary.json'), 'utf8');
  } catch {
    return { present: false, fresh: false, terms: 0 };
  }
  try {
    const { VOCAB, ANATOMY } = new Function(
      `${vocabulary}\n;return { VOCAB, ANATOMY };`
    )();
    const terms = VOCAB.reduce((n, [, , rows]) => n + rows.length, 0);
    const parsed = JSON.parse(onDisk);
    return {
      present: true,
      /*
       * Compare the counts the generator derives, not the whole file: the
       * payload carries the package version, so a version bump alone would
       * otherwise read as vocabulary drift.
       */
      fresh:
        parsed.counts?.terms === terms &&
        parsed.counts?.anatomy === Object.keys(ANATOMY).length &&
        parsed.terms?.length === terms,
      terms,
    };
  } catch (err) {
    return { present: true, fresh: false, terms: 0, error: err.message };
  }
})();

/*
 * guide/decisions.js — the Learn wizard's routing tree, inlined like
 * vocabulary.js.
 *
 * It is guide chrome rather than package data, so it is not in "files" and
 * no consumer ever sees it. It is tested here anyway because the property
 * worth holding is a relationship between the two files: the wizard names
 * vocabulary terms, and neither a renamed term nor a newly shipped one
 * announces itself to the other side.
 */
const decisions = readFileSync(join(pkg, 'guide', 'decisions.js'), 'utf8');

/*
 * guide/search.js — the guide's ranker, inlined for the same reason.
 *
 * It is split out of guide.js precisely so it can be tested: guide.js is an
 * ES module that imports glow, so injecting its source into a classic
 * <script> throws on the import and giving it a module script would defer it
 * past the suite. Everything in search.js is a plain function over data, and
 * a search box whose ranking nothing checks goes subtly wrong in silence —
 * a term that stops being findable looks like a term nobody wanted.
 *
 * It reads VOCAB, so it is injected after it.
 */
const search = readFileSync(join(pkg, 'guide', 'search.js'), 'utf8');

/*
 * demo/index.html — the flagship consumer's markup, as a string.
 *
 * The demo is tooling and its CSS is deliberately outside the package (see
 * SKIP_DIRS above), but its MARKUP is the one place that claims to speak
 * the vocabulary fluently, and nothing checked that it did. It wrote
 * `class="page"` on every pagination control — a class the package does
 * not ship and whose absence nav.css documents by name — so the demo's
 * pagination rendered as raw UA links (measured: `rgb(0,0,238)`, no
 * padding, no radius) for as long as it existed.
 *
 * Handed over as text rather than parsed here: the page can put it in a
 * detached node and ask the real CSSOM, which is what every other spec in
 * this suite does.
 *
 * It is escaped even though JSON.stringify already quoted it. The demo is
 * an HTML document and carries its own `</script>` tags — the parser ends
 * the inline block at the first one, whatever the JavaScript around it
 * means, so the assignment never completes and the spec reads `undefined`.
 * The other payloads here are .js files that happen not to contain the
 * sequence.
 */
const demoHtml = readFileSync(join(pkg, 'demo', 'index.html'), 'utf8');

/*
 * guide/guide.css, guide/instruments.css and guide/guide.js — as TEXT.
 *
 * The guide is the package's reference implementation, and until 2026-08-09
 * nothing in this suite loaded any part of it: SKIP_DIRS keeps guide/ out of
 * the shipped-stylesheet collection, which is right, and the consequence was
 * that the guide could name anything at all. It did. It hand-rolled a shell
 * while frame.css shipped one, restated 28 tokens tokens.css already
 * declares, and wrote `--ring: var(--color-primary)` — the alias trap
 * tokens.css forbids by name.
 *
 * Text rather than a <link>, and that is not a shortcut. Loading guide.css
 * into this page would apply it: it is unlayered, so it would beat every
 * layer of the package and quietly change what all 300 other assertions
 * measure. guide.spec.js parses these strings instead, and asks the real
 * CSSOM only about the package's own rules.
 *
 * The split is the thing being held. instruments.css is the classes that
 * DRAW the system — ramps, ladders, wireframes — and guide.css is chrome
 * plus whatever debt is left; guide/AUDIT.md is the register. Two files
 * make the debt countable, and a spec is what stops the boundary rotting
 * back into one.
 */
const guideCss = readFileSync(join(pkg, 'guide', 'guide.css'), 'utf8');
const instrumentsCss = readFileSync(join(pkg, 'guide', 'instruments.css'), 'utf8');
const guideJs = readFileSync(join(pkg, 'guide', 'guide.js'), 'utf8');

/*
 * Real glow output, rendered here and handed to the page as data.
 *
 * components/code.css themes markup this package does not produce, so the
 * only honest way to test it is against the highlighter that does. Markup
 * written by hand to look like glow's would pass while glow emitted
 * something else — the stand-in failure this repo has paid for before.
 *
 * It is injected rather than imported in the browser because the specs run
 * as classic scripts and glow is an ES module: a module script would be
 * deferred until after the suite had already reported.
 *
 * Between them the three samples produce every element the theme styles:
 * sup i b em strong label · del ins dfn mark u · span.
 */
const glowSamples = {
  css: glow(
    `/* the whole contract */
.card { --bg-mix: var(--color-danger); color: #f4403a !important; }`,
    { language: 'css', prefix: false }
  ),
  marked: glow(
    ['- gone', '+ added', '> noted •marked• and ••wrong••'].join('\n'),
    { language: 'js', prefix: true }
  ),
  numbered: glow('one\ntwo\nthree', { language: 'js', numbered: true }),
};

const specBlocks = specFiles
  .map((f) => {
    const src = readFileSync(join(specDir, f), 'utf8');
    return (
      `<script>\nwindow.__FJS_CURRENT_SPEC__ = ${JSON.stringify(basename(f, '.spec.js'))};\n` +
      escapeForInlineScript(src) +
      `\n</script>`
    );
  })
  .join('\n');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>@frontierjs/css test run</title>
<link rel="stylesheet" href="./index.css">
<style>
/*
 * Transitions off, globally.
 *
 * getComputedStyle during a transition returns the *interpolated* value,
 * so a property that is mid-flight reads as its old value — and Chrome
 * serialises an interpolating color in oklab(), which makes it look like a
 * different value again. Both bit this suite: .btn transitions box-shadow,
 * so a just-focused button reported its resting shadow re-serialized, and
 * the assertion blamed the CSS.
 *
 * Unlayered + !important so it beats every layer in the package.
 * Animations are deliberately left alone — the reduced-motion spinner
 * exception is a real invariant and something should be able to test it.
 */
*, *::before, *::after {
  transition: none !important;
}
</style>
</head>
<!--
  No theme class. Every "by default" assertion in this suite — a flat resting
  Card, an unset --heading-font-weight, --app-bg falling back to
  --surface-sunken — is a claim about tokens.css, and inside a theme class it
  is a claim about that theme instead. It read as true only while
  theme-default set nothing tokens.css did not already set.

  The themes are still graded, explicitly: themed(name, html) in the harness
  mounts into a themed wrapper, and contrast.spec.js sweeps all ten.
-->
<body>
<script>window.__FJS_SHIPPED_CSS__ = ${JSON.stringify(shippedCss)};</script>
<script>window.__FJS_VOCAB_JSON__ = ${JSON.stringify(vocabularyJsonState)};</script>
<script>window.__FJS_GLOW__ = ${JSON.stringify(glowSamples)};</script>
<script>window.__FJS_DEMO_HTML__ = ${escapeForInlineScript(JSON.stringify(demoHtml))};</script>
<!--
  The guide's own source, as strings. Escaped for the same reason the demo
  is: guide.js is 11k lines of markup builders and carries a closing script
  tag in its own page HTML, which would end the inline block wherever it
  appeared and leave the spec reading nothing at all.
-->
<script>window.__FJS_GUIDE_CSS__ = ${escapeForInlineScript(JSON.stringify(guideCss))};</script>
<script>window.__FJS_INSTRUMENTS_CSS__ = ${escapeForInlineScript(JSON.stringify(instrumentsCss))};</script>
<script>window.__FJS_GUIDE_JS__ = ${escapeForInlineScript(JSON.stringify(guideJs))};</script>
<script>${escapeForInlineScript(vocabulary)}</script>
<script>${escapeForInlineScript(decisions)}</script>
<script>${escapeForInlineScript(search)}</script>
<script>${escapeForInlineScript(harness)}</script>
${specBlocks}
<script>
(function () {
  var payload;
  try {
    payload = window.__FJS_RUN__();
  } catch (e) {
    payload = { fatal: (e && e.stack) || String(e) };
  }
  var s = document.createElement('script');
  s.type = 'application/json';
  s.id = 'fjs-results';
  s.textContent = JSON.stringify(payload);
  document.body.appendChild(s);
})();
</script>
</body>
</html>
`;

/*
 * The page must live beside index.css — it links the stylesheet relatively
 * and every @import inside it resolves against that directory — so it is
 * written into src/, not the package root.
 */
const pagePath = join(srcDir, '.fjs-test-run.html');
writeFileSync(pagePath, page);

/* ── Run ───────────────────────────────────────────────────────────── */

let dump;
try {
  const r = spawnSync(
    browser.bin,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--allow-file-access-from-files',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--virtual-time-budget=5000',
      '--dump-dom',
      `file://${pagePath}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 && !r.stdout) {
    console.error('Browser exited ' + r.status + '\n' + (r.stderr || ''));
    process.exit(2);
  }
  dump = r.stdout;
} finally {
  if (!keep && existsSync(pagePath)) unlinkSync(pagePath);
}

const match = dump.match(
  /<script type="application\/json" id="fjs-results">([\s\S]*?)<\/script>/
);
if (!match) {
  console.error(
    'The page produced no results block. The suite probably threw before it\n' +
    'could report. Re-run with --keep and open .fjs-test-run.html in a browser.'
  );
  process.exit(2);
}

const payload = JSON.parse(match[1]);
if (payload.fatal) {
  console.error('Fatal error inside the test page:\n' + payload.fatal);
  process.exit(2);
}

/* ── Report ────────────────────────────────────────────────────────── */

const { results, filtered } = payload;
const failures = results.filter((r) => !r.ok);

const byFile = new Map();
for (const r of results) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log('');
for (const [file, rows] of byFile) {
  const bad = rows.filter((r) => !r.ok).length;
  console.log(
    `${bad ? red('✗') : green('✓')} ${file} ${dim(`(${rows.length - bad}/${rows.length})`)}`
  );
  for (const r of rows) {
    if (!r.ok) console.log(`    ${red('✗')} ${r.name}\n      ${r.error.replace(/\n/g, '\n  ')}`);
  }
}

console.log('');
console.log(
  failures.length
    ? red(`${failures.length} failing`) + dim(`, ${results.length - failures.length} passing`)
    : green(`${results.length} passing`)
);
if (filtered) console.log(dim('note: test.only was used — this was not a full run'));
console.log(dim(`${browser.version}`));
console.log('');

process.exit(failures.length ? 1 : 0);
