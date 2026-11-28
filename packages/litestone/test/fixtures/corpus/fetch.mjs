// fetch.mjs — download a real published schema and read it into .lite, writing
// the result beside this file plus a gaps.json naming everything the reading
// could not express.
//
// The readers are `src/import/` — the same code `litestone import` runs — so
// what this regenerates is a regression fixture over the SHIPPED importer, not
// over a copy of it.
//
//   bun test/fixtures/corpus/fetch.mjs            # every target below
//   bun test/fixtures/corpus/fetch.mjs triggerdev # one
//
// Needs the network. See README.md for the licence split that decides which of
// these are committed and which are fetched on demand.

import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { convert, summarize } from '../../../src/import/index.js'
import { introspectToLite } from '../../../src/tools/introspect.js'
import { introspect } from '../../../src/index.js'

export const TARGETS = {
  erpnext: {
    repo: 'frappe/erpnext', licence: 'GPL-3.0', reader: 'frappe', branch: 'develop',
    path: 'erpnext/**/doctype/*/*.json',
    what: 'an ERP — accounting and stock, and the only source that DECLARES whether a polymorphic target set is closed',
  },
  hrms: {
    repo: 'frappe/hrms', licence: 'GPL-3.0', reader: 'frappe', branch: 'develop',
    path: 'hrms/**/doctype/*/*.json',
    what: 'payroll and HR — the half ERPNext no longer carries: salary structures, slips, components and tax slabs',
  },
  discourse: {
    repo: 'discourse/discourse', licence: 'GPL-2.0', reader: 'sql',
    path: 'db/structure.sql',
    what: 'a forum platform — the scale ceiling, and polymorphism at volume',
  },
  lago: {
    repo: 'getlago/lago-api', licence: 'AGPL-3.0', reader: 'sql',
    path: 'db/structure.sql',
    what: 'usage-based billing — plans, charges, subscriptions, invoices, credit notes, wallets',
  },
  mastodon: {
    repo: 'mastodon/mastodon', licence: 'AGPL-3.0', reader: 'rails',
    path: 'db/schema.rb',
    what: 'a federated social server — the first Rails source, for the constructs Prisma cannot express',
  },
  triggerdev: {
    reader: 'prisma',
    repo: 'triggerdotdev/trigger.dev', licence: 'Apache-2.0',
    path: 'internal-packages/database/prisma/schema.prisma',
    what: 'a background-jobs platform — runs, queues, schedules, deployments',
  },
  calcom: {
    reader: 'prisma',
    repo: 'calcom/cal.com', licence: 'AGPL-3.0 with a commercial /ee — check before vendoring',
    path: 'packages/prisma/schema.prisma',
    what: 'scheduling — availability, bookings, event types, teams',
  },
  documenso: {
    reader: 'prisma',
    repo: 'documenso/documenso', licence: 'AGPL-3.0',
    path: 'packages/prisma/schema.prisma',
    what: 'e-signature — envelopes, recipients, fields, an audit log',
  },

  // ─── the textbook samples ──────────────────────────────────────────────────
  // Small, and the schemas every ORM tutorial is written against — so they are
  // the first thing an adopter points `litestone import` at.
  chinook: {
    repo: 'lerocha/chinook-database', licence: 'MIT', reader: 'sqlite', branch: 'master',
    path: 'ChinookDatabase/DataSources/Chinook_Sqlite.sql',
    what: 'a music store — the only source that is a SQLite database, so it goes through introspect, the adoption door',
  },
  sakila: {
    repo: 'jOOQ/sakila', licence: 'BSD-2-Clause',
    path: 'mysql-sakila-db/mysql-sakila-schema.sql', reader: 'sql',
    what: 'DVD rental — the committed MySQL source: backticks, inline KEYs, ENGINE clauses, a FULLTEXT index',
  },
  pagila: {
    repo: 'devrimgunduz/pagila', licence: 'PostgreSQL', reader: 'sql', branch: 'master',
    path: 'pagila-schema.sql',
    what: 'Sakila ported to Postgres — domains, enums, arrays, and a payment table split into partitions',
  },
  employees: {
    repo: 'datacharmer/test_db', licence: 'CC BY-SA 3.0', reader: 'sql', branch: 'master',
    path: 'employees.sql',
    what: 'MySQL\'s own sample — composite keys over dates, uppercase types',
  },
  northwind: {
    repo: 'pthom/northwind_psql', licence: 'Ms-PL', reader: 'sql', branch: 'master',
    path: 'northwind.sql',
    what: 'orders and suppliers — the Access-era sample, ported to Postgres',
  },
  adventureworks: {
    repo: 'lorint/AdventureWorks-for-Postgres', licence: 'MIT', reader: 'sql', branch: 'master',
    path: 'install.sql',
    what: 'manufacturing and sales over five schemas — CREATE SCHEMA bodies, CamelCase identifiers, psql meta-commands',
  },

  // ─── applications ──────────────────────────────────────────────────────────
  gitlab: {
    repo: 'gitlabhq/gitlabhq', licence: 'MIT (outside ee/)', reader: 'sql', branch: 'master',
    path: 'db/structure.sql',
    what: 'a forge — three times Discourse, and the densest CHECK, partial-index and partition source there is',
  },
  chatwoot: {
    repo: 'chatwoot/chatwoot', licence: 'MIT (outside enterprise/)', reader: 'rails', branch: 'develop',
    path: 'db/schema.rb',
    what: 'customer support inboxes — the Rails source that writes check_constraint',
  },
  umami: {
    repo: 'umami-software/umami', licence: 'MIT', reader: 'prisma', branch: 'master',
    path: 'prisma/schema.prisma',
    what: 'web analytics — sessions, events, and the decimal defaults @scale has to restate',
  },
  hoppscotch: {
    repo: 'hoppscotch/hoppscotch', licence: 'MIT', reader: 'prisma',
    path: 'packages/hoppscotch-backend/prisma/schema.prisma',
    what: 'an API client\'s backend — teams, collections, shared requests',
  },
}

const here = new URL('.', import.meta.url).pathname

export async function fetchOne(key) {
  const t = TARGETS[key]
  if (!t) throw new Error(`unknown target '${key}' — one of ${Object.keys(TARGETS).join(', ')}`)
  const at = await pinCommit(key, t)
  const src = t.reader === 'frappe' ? await fetchDoctypes(key, t, at) : await fetchFile(key, t, at)

  const { lite, gaps, models } = t.reader === 'sqlite'
    ? readSqlite(src)
    : convert({ source: src, format: t.reader ?? 'prisma', label: key })
  const how = t.reader === 'sqlite' ? 'litestone introspect' : `litestone import --from ${t.reader ?? 'prisma'}`
  const header =
    `// ${key} — the data model of ${t.repo}, expressed in .lite.\n` +
    `//\n` +
    `// Derived mechanically from ${t.path} (${t.licence}) at\n` +
    `// ${at.sha.slice(0, 12)} (${at.date.slice(0, 10)}) by\n` +
    `// \`${how}\`. A CORPUS FIXTURE, not a design:\n` +
    `// nothing here is a claim about how any of it should be modelled, and every\n` +
    `// place the conversion made a choice the source did not is recorded in\n` +
    `// gaps.json. ${models.length} models. Regenerate with fetch.mjs.\n\n`

  writeFileSync(`${here}${key}.lite`, header + lite)
  return { key, models: models.length, gaps: gaps.map(g => ({ source: key, ...g })) }
}

// The commit is written into the header: a fixture that names only a branch
// cannot say whether a diff came from the importer or from upstream moving.
async function pinCommit(key, t) {
  const path = t.reader === 'frappe' ? '' : `&path=${encodeURIComponent(t.path)}`
  const url = `https://api.github.com/repos/${t.repo}/commits?sha=${t.branch ?? 'main'}${path}&per_page=1`
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`${key}: ${res.status} from ${url} — the API allows 60 unauthenticated calls an hour`)
  const [c] = await res.json()
  if (!c) throw new Error(`${key}: no commit on ${t.branch ?? 'main'} touches ${t.path} — the path moved`)
  return { sha: c.sha, date: c.commit.committer.date }
}

async function fetchFile(key, t, at) {
  const url = `https://raw.githubusercontent.com/${t.repo}/${at.sha}/${t.path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${key}: ${res.status} from ${url} — the path moves; check the repository`)
  return res.text()
}

// A source published as a SQLite script has no reader of its own: it is run
// into a database and read back through introspect, the door `fli db:pull`
// uses. Chinook's script opens with a byte-order mark SQLite refuses.
function readSqlite(src) {
  const db = new Database(':memory:')
  db.exec(src.replace(/^\uFEFF/, ''))
  const { lite, gaps } = introspectToLite(db)
  const models = Object.keys(introspect(db)).filter(k => !k.startsWith('__'))
  db.close()
  return { lite, gaps, models }
}

// A Frappe app keeps one JSON per doctype — 534 files for ERPNext — so the
// source arrives as a tarball rather than a file, and the reader is handed the
// parsed documents instead of a string. Needs `tar` on PATH.
async function fetchDoctypes(key, t, at) {
  const url = `https://codeload.github.com/${t.repo}/tar.gz/${at.sha}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${key}: ${res.status} from ${url}`)

  const tmp = `${here}.tmp-${key}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'src.tar.gz'), new Uint8Array(await res.arrayBuffer()))

  // GNU tar wants --wildcards for a pattern; BSD tar rejects the flag and
  // globs anyway. Try the portable order rather than sniffing the platform.
  const args = ['xzf', 'src.tar.gz', '*/doctype/*/*.json']
  let ok = Bun.spawnSync(['tar', ...args.slice(0, 2), '--wildcards', args[2]], { cwd: tmp }).exitCode === 0
  if (!ok) ok = Bun.spawnSync(['tar', ...args], { cwd: tmp }).exitCode === 0
  if (!ok) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`${key}: could not extract the tarball — is \`tar\` on PATH?`) }

  const docs = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry.endsWith('.json')) {
        try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j && j.doctype === 'DocType') docs.push(j) } catch { /* not a doctype */ }
      }
    }
  }
  walk(tmp)
  rmSync(tmp, { recursive: true, force: true })
  if (!docs.length) throw new Error(`${key}: the tarball held no DocType JSON — the layout moved`)
  return docs
}

if (import.meta.main) {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS)
  // One target re-read replaces that target's rows and keeps the rest; writing
  // only what this run read left gaps.json describing a single fixture.
  const prior = (() => { try { return JSON.parse(readFileSync(`${here}gaps.json`, 'utf8')) } catch { return [] } })()
  const all = prior.filter(g => g.source && !keys.includes(g.source))
  for (const k of keys) {
    const r = await fetchOne(k)
    const kinds = {}
    for (const g of r.gaps) (kinds[g.kind] ||= []).push(g)
    const s = summarize(r.gaps)
    console.log(`${k.padEnd(12)} ${String(r.models).padStart(3)} models · ${r.gaps.length} unexpressed ` +
                `(${s.changed} changed · ${s.lost} lost · ${s.noted} noted)`)
    for (const [kind, v] of Object.entries(kinds).sort((a, b) => b[1].length - a[1].length))
      console.log(`  ${String(v.length).padStart(4)}x ${kind}`)
    all.push(...r.gaps)
  }
  writeFileSync(`${here}gaps.json`, JSON.stringify(all, null, 1))
  console.log(`\n${all.length} recorded in gaps.json`)
}
