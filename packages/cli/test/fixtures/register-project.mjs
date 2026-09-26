// register-project.mjs — a client app's registers, written to a temp dir.
//
// The shape `fli register:atlas` exists for: registers under `.project/` with
// a prefix that is not FJS, so a reader still keyed to the workspace root or to
// `FJS-` reads it as empty. Every link is written relative to the file it sits
// in, the way a real register writes it — `../api/…` from `.project/ISSUES.md`,
// `../../web/…` from `.project/IDEAS/` — because resolving those against the
// wrong directory is the failure the page's links can have.
//
// Shared by `test/register-atlas.test.js` and `test/browser/register-atlas.mjs`.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join }   from 'node:path'
import { tmpdir } from 'node:os'

const HEAD = ['| Id | Area | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |']

export function registerProject() {
  const root = mkdtempSync(join(tmpdir(), 'fli-register-atlas-'))
  const reg  = join(root, '.project')

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acme.app', registers: { prefix: 'ACME', dir: '.project' } }))
  mkdirSync(join(reg, 'IDEAS'), { recursive: true })
  mkdirSync(join(root, 'api', 'src'), { recursive: true })
  mkdirSync(join(root, 'web', 'src'), { recursive: true })
  writeFileSync(join(root, 'api', 'src', 'texts.js'), '')
  writeFileSync(join(root, 'web', 'src', 'Board.svelte'), '')

  writeFileSync(join(reg, 'ISSUES.md'), [
    '# Issues', '',
    '## S2 — high', '', ...HEAD,
    '| <a id="acme-001"></a>ACME-001 | api | **STOP throws on a commented-out column** | open | 2026-09-25 | Patches a field the schema dropped. See [texts.js](../api/src/texts.js). |',
    '',
    '## S3 — medium', '', ...HEAD,
    '| <a id="acme-002"></a>ACME-002 | web | **The board hides snoozed rows** | open | 2026-09-25 | Found beside ACME-001; blocked by ACME-001. [Board](../web/src/Board.svelte) |',
    '',
    '## Needs a decision', '',
    '| Id | Area | Question | Raised | Detail |', '| --- | --- | --- | --- | --- |',
    '| <a id="acme-d2"></a>ACME-D2 | repo | **Should support run on the API?** Argued nowhere yet. | 2026-09-25 | — |',
    '',
    '## Closed', '',
    '| Id | Title | Closed | How |', '| --- | --- | --- | --- |',
    '| <a id="acme-000"></a>ACME-000 | **The login loop** | 2026-09-24 | Fixed the redirect and proved it in a browser. |',
    '',
  ].join('\n'))

  writeFileSync(join(reg, 'ISSUES_ARCHIVE.md'), '# Issues — archive\n')

  writeFileSync(join(reg, 'DECISIONS.md'), [
    '# Decisions', '',
    '## Data & schema', '',
    '### <a id="acme-d1"></a>2026-09-20 · `ACME-D1` — texting consent lives on the Client, not the User', '',
    'Picked over a per-number table. Leans on ACME-001.', '',
    '## Repo conventions', '',
    '## Open (discussed, not yet ruled)', '',
  ].join('\n'))

  writeFileSync(join(reg, 'IDEAS', 'texting.md'), [
    '---', 'id: texting', 'status: proposed', 'dated: 2026-09-25', '---', '',
    '# Idea — two-way SMS on a real number', '',
    'Outbound goes through [the board](../../web/src/Board.svelte).', '',
    '## Open questions', '',
    '- **Where does the call run?**',
    '  - **A** — the API, with a key in env.',
    '  - **B** — the CLI on the owner\'s machine.',
    '  - **Recommend A** — staff use the tab, not a laptop.',
    '- **What may leave for the provider?** Names and numbers.',
    '',
  ].join('\n'))

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
