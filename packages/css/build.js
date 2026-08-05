#!/usr/bin/env bun
/*
 * build.js — bundle src/ into one file, for consumers who want one file.
 *
 * This package has no build step and does not need one: `@import
 * '@frontierjs/css'` works as-is, and that is what most apps should do. This
 * exists for the cases where 41 requests or an @import chain is inconvenient —
 * a CDN drop-in, a CodePen, an email tool, a bundler you do not control.
 *
 *   bun run build     → dist/frontier.css + dist/frontier.min.css
 *
 * dist/ is gitignored and built on publish (prepublishOnly). The source is
 * still the product; this is a convenience artifact.
 *
 * ── The one thing that makes this non-trivial ────────────────────────
 *
 * `bun build` inlines each @import as an `@layer name { … }` block but DROPS
 * the `@layer a, b, c;` statement at the top of index.css — the line that
 * declares the order. Without it, layer order falls back to first appearance
 * in the file.
 *
 * Today those agree, because index.css happens to import in layer order. But
 * the whole point of the declaration is that they do NOT have to agree: the
 * source is order-independent, and a bundle without the statement is not.
 * Measured — move the utilities import above the first components import and
 * rebuild, and `.btn.text-lg` goes 16px → 14px in the bundle while the source
 * stays 16px. Silent, and it would look like a CSS bug.
 *
 * So the statement is read out of index.css and prepended, and the check at
 * the bottom refuses to write a bundle without it.
 */

import { rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here  = dirname(fileURLToPath(import.meta.url));
const src   = join(here, 'src');
const dist  = join(here, 'dist');
const entry = join(src, 'index.css');

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

/* ── The layer declaration, taken from the source, never retyped ───── */

const indexSrc = readFileSync(entry, 'utf8');
const layerDecl = indexSrc.match(/^@layer\s+[^;]+;/m);
if (!layerDecl) {
  console.error('\n  ✗ No `@layer …;` statement found in src/index.css.\n' +
                '    The bundle cannot declare an order it cannot read.\n');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const BANNER = `/*! @frontierjs/css — bundled. Source: src/. */\n`;

async function build(outName, minify) {
  const tmp = join(dist, '.tmp-' + outName);
  const r = await Bun.build({ entrypoints: [entry], outdir: dist, naming: '.tmp-' + outName, minify });
  if (!r.success) {
    console.error('\n  ✗ bun build failed\n' + r.logs.join('\n'));
    process.exit(1);
  }

  let css = readFileSync(tmp, 'utf8');
  rmSync(tmp);

  /*
   * Prepend rather than replace: bun emits no statement of its own, so this
   * is the only declaration in the file and it wins by being first.
   */
  css = BANNER + layerDecl[0] + '\n\n' + css;

  const out = join(dist, outName);
  writeFileSync(out, css);
  return out;
}

const plain = await build('frontier.css', false);
const min   = await build('frontier.min.css', true);

/* ── Refuse to ship a bundle that lost the order ───────────────────── */

for (const f of [plain, min]) {
  const css = readFileSync(f, 'utf8');
  if (!/@layer\s+[a-z0-9]+\s*,/i.test(css)) {
    console.error(`\n  ✗ ${f} has no @layer order declaration — refusing to write it.\n`);
    process.exit(1);
  }
  const blocks = (css.match(/@layer\s+[a-z0-9]+\s*\{/gi) || []).length;
  if (blocks < 20) {
    console.error(`\n  ✗ ${f} has only ${blocks} layer blocks — the bundle looks truncated.\n`);
    process.exit(1);
  }
}

console.log(`\n  @frontierjs/css → dist/\n`);
console.log(`  frontier.css      ${kb(statSync(plain).size)}`);
console.log(`  frontier.min.css  ${kb(statSync(min).size)}`);
console.log(`\n  Layer order preserved: ${layerDecl[0]}\n`);
