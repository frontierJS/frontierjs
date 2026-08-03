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

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

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
 * so a just-focused button reported its resting shadow re-serialised, and
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
<body class="theme-default">
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
 * The page must live beside index.css: the stylesheet is linked relatively
 * and every @import inside it resolves against the package root.
 */
const pagePath = join(pkg, '.fjs-test-run.html');
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
