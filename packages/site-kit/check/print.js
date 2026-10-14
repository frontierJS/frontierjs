// check/print.js — a check result as a terminal report: findings by group,
// `file:line` for content and the page path for built output, each location
// relative to where the command was run so a terminal can open it.

import { join, relative } from 'node:path'

export function printCheck(r, { all = false, out = console.log } = {}) {
  const tty = process.stdout.isTTY
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  const icon = { error: c(31, '✗ error'), warn: c(33, '! warn '), info: c(36, '· note ') }
  const here = process.env.INIT_CWD || process.cwd()
  const loc = ({ file, line }) => `${relative(here, join(r.root, file))}${line ? `:${line}` : ''}`
  const cap = (list) => (all ? list : list.slice(0, 5))
  const more = (list) => (!all && list.length > 5 ? c(2, ` (+${list.length - 5} more, --all)`) : '')

  const read = [r.stages.includes('source') && 'content/', r.source && `${r.source === 'dist' ? 'dist/' : 'live'} (${r.pages.length} indexable pages)`]
    .filter(Boolean)
    .join(' + ')
  out(`\n${c(1, 'site-kit check')} — ${r.site || '(no siteUrl)'}${r.preset ? ` · ${r.preset}` : ''} · ${read}`)
  for (const n of r.notes) out(c(33, `  ⚠ ${n}`))

  let group
  for (const f of r.findings) {
    if (f.group !== group) {
      group = f.group
      out(`\n${c(1, `── ${group}`)}`)
    }
    // A preset rule marks a finding it will raise to an error later (ksite's launch_date).
    const tag = f.atLaunch ? c(35, '  [error at launch]') : ''
    const fix = f.fix ? c(2, `  → ${/^nothing/.test(f.fix) ? '' : 'fix in '}${f.fix}`) : ''
    out(`\n  ${icon[f.level]}  ${c(2, f.key)}${tag}${fix}`)
    out(wrap(f.message, 6))
    const where = (f.where || []).filter((w) => w.file)
    if (where.length) out(c(2, `      ${cap(where).map(loc).join(', ')}`) + more(where))
    if (f.pages?.length) out(c(2, `      on ${cap(f.pages).join(', ')}`) + more(f.pages))
  }
  if (!r.findings.length) out('\n  Nothing to fix.')
  const { error, warn, info } = r.counts
  const later = r.findings.filter((f) => f.atLaunch).length
  out(
    `\n${error ? c(31, `${error} errors`) : '0 errors'}, ${warn} warnings, ${info} notes.` +
      (later ? c(35, ` ${later} ${later === 1 ? 'becomes an error' : 'become errors'} at launch.`) : '') +
      '\n'
  )
}

function wrap(s, indent) {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 110)) - indent
  const out = []
  let line = ''
  for (const word of s.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) {
      out.push(line)
      line = word
    } else line = (line + ' ' + word).trim()
  }
  if (line) out.push(line)
  return out.map((l) => ' '.repeat(indent) + l).join('\n')
}
