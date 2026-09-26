// ─── file-kind.js — what a path IS, read off the path alone ─────────────────
//
// `codegraph.js` asks it which files to draw and score, and `proofs.js` asks it
// which files a diff is evidence from. One classifier, because a file that is a
// test to one reader and source to the other is one change graded two ways.
//
// Zero dependencies, plain ESM: `checks.js` reaches this through `proofs.js`,
// and `scripts/ci.mjs` runs `checks.js` on plain node.

import { posix } from 'node:path'

export const ASSET = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|wasm)$/i
const DOC          = /\.(md|mdx|txt|rst)$/i
const CONFIG       = /\.(json|jsonc|ya?ml|toml|ini|env)$/i
const LOCKFILE     = /^(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/
// A build's output directory. One under `src/` is a module named for what it
// does — sierra's and jetty's `src/build/` are their build pipelines — and read
// as output it took both off the map.
const OUTPUT       = /(^|\/)(dist|out|build)\//
// Code that demonstrates the project rather than being it. Counted as source, a
// kitchen-sink app is the biggest package on the map and its imports decide
// which package reads most used.
const EXAMPLE      = /(^|\/)(examples?|website)\//

/** `source`, `test`, `doc`, `config`, `generated`, `asset` or `example`. */
export function kindOf(path) {
  const base = posix.basename(path)
  if (/\.snapshot\./.test(base) || isOutput(path) || LOCKFILE.test(base))                             return 'generated'
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) || /\.(test|spec)\.[a-z]+$/i.test(base)) return 'test'
  if (ASSET.test(base))                                                                              return 'asset'
  if (DOC.test(base) || /^(LICENSE|CHANGELOG)$/.test(base))                                          return 'doc'
  if (CONFIG.test(base) || base.startsWith('.') || /\.config\.[cm]?[jt]s$/.test(base) || /^(Dockerfile|Makefile|tsconfig.*)$/.test(base)) return 'config'
  if (EXAMPLE.test(path))                                                                            return 'example'
  return 'source'
}

function isOutput(path) {
  const at = path.search(OUTPUT)
  return at >= 0 && !/(^|\/)src\//.test(path.slice(0, at + 1))
}
