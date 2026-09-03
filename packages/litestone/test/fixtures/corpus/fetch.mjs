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
import { convert, summarise } from '../../../src/import/index.js'

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
}

const here = new URL('.', import.meta.url).pathname

export async function fetchOne(key) {
  const t = TARGETS[key]
  if (!t) throw new Error(`unknown target '${key}' — one of ${Object.keys(TARGETS).join(', ')}`)
  const src = t.reader === 'frappe' ? await fetchDoctypes(key, t) : await fetchFile(key, t)

  const { lite, gaps, models } = convert({ source: src, format: t.reader ?? 'prisma', label: key })
  const header =
    `// ${key} — the data model of ${t.repo}, expressed in .lite.\n` +
    `//\n` +
    `// Derived mechanically from ${t.path} (${t.licence}) by\n` +
    `// \`litestone import --from ${t.reader ?? 'prisma'}\`. A CORPUS FIXTURE, not a design:\n` +
    `// nothing here is a claim about how any of it should be modelled, and every\n` +
    `// place the conversion made a choice the source did not is recorded in\n` +
    `// gaps.json. ${models.length} models. Regenerate with fetch.mjs.\n\n`

  writeFileSync(`${here}${key}.lite`, header + lite)
  return { key, models: models.length, gaps }
}

async function fetchFile(key, t) {
  const url = `https://raw.githubusercontent.com/${t.repo}/${t.branch ?? 'main'}/${t.path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${key}: ${res.status} from ${url} — the path moves; check the repository`)
  return res.text()
}

// A Frappe app keeps one JSON per doctype — 534 files for ERPNext — so the
// source arrives as a tarball rather than a file, and the reader is handed the
// parsed documents instead of a string. Needs `tar` on PATH.
async function fetchDoctypes(key, t) {
  const url = `https://codeload.github.com/${t.repo}/tar.gz/refs/heads/${t.branch ?? 'main'}`
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
  const all = []
  for (const k of keys) {
    const r = await fetchOne(k)
    const kinds = {}
    for (const g of r.gaps) (kinds[g.kind] ||= []).push(g)
    const s = summarise(r.gaps)
    console.log(`${k.padEnd(12)} ${String(r.models).padStart(3)} models · ${r.gaps.length} unexpressed ` +
                `(${s.changed} changed · ${s.lost} lost · ${s.noted} noted)`)
    for (const [kind, v] of Object.entries(kinds).sort((a, b) => b[1].length - a[1].length))
      console.log(`  ${String(v.length).padStart(4)}x ${kind}`)
    all.push(...r.gaps)
  }
  writeFileSync(`${here}gaps.json`, JSON.stringify(all, null, 1))
  console.log(`\n${all.length} recorded in gaps.json`)
}
