// src/services/workbench/workbench.service.ts
// The workbench — a Claude Code chat per pinned checkout (`domain/workbench/workbench.ts`).
//
// No model and nothing in the database: a pin names a folder on the machine
// this API runs on. Gated at ADMINISTRATOR, and a run here is more than a
// listing: it is Claude Code with every permission, in that folder, as the
// operator's own account.
//
//   POST /workbench               pins        the pins, each with its git state, workspace members and run status
//   POST /workbench               status      every pin's run status — the grid's poll, no git
//   POST /workbench/:id           transcript  { chat? } — one chat, the shown one by default, folded from its log, with the checkout's checks and review
//   POST /workbench/:id           diff        the checkout's working tree against HEAD, a branch's against its base
//   POST /workbench/:id           runnables   `fli dev` per app, every package.json script, each member's test (`domain/workbench/workbench-run.ts`)
//   POST /workbench/:id           output      { row } — the tail of what a started row wrote
//   POST /workbench/:id           plan        the shown plan — its path, the steps Go started with what each cost, and the file parsed now (null until written)
//   POST /workbench               pin         { path }
//   POST /workbench/:id           send        { prompt, chat?, images? } — queued behind a run in the same chat, refused while another chat runs
//   POST /workbench/:id           check       { chat? } — the checkout's own `fli done`, now, over the files that chat wrote
//   POST /workbench/:id           review      a read-only Claude Code session over the tree, now
//   POST /workbench/:id           buildPlan   { goal, path } — a new chat writing the plan at path, allowed to edit that file and no other; that plan shown
//   POST /workbench/:id           openPlan    { path } — the plan shown: one on the pin, or a file already in the checkout, added
//   POST /workbench/:id           closePlan   { path } — forgotten here with its steps; the file stays; refused while a run is live
//   POST /workbench/:id           go          the shown plan's first open box, run in the shown chat; refused while any run is live
//   POST /workbench/:id           next        that box in a new chat, handed the plan's path and the last reply; refused like go, and while a plan Q is unruled
//   POST /workbench/:id           tick        { step } — the owner's tick on a box a Go'd step's run left open; refused while a run is live
//   POST /workbench/:id           file        { severity, area, title, detail } — a row in the checkout's ISSUES.md through fli's `fileIssue`; severity decision is a question
//   POST /workbench/:id           decide      { question, pick, why?, section } — a letter on a plan Q through fli's `decide`, the plan named as its file; refused while a run is live
//   POST /workbench/:id           fork        { slug?, preview? } — a branch: the tree snapshotted into a worktree, pinned, its copy list and install run;
//                                             with preview, Open: Basecamp's `apps.preview` makes a preview Environment and its rows, routed to the branch's web port
//   POST /workbench/:id           freeze      a preview's web/ built and released by digest; the hostname serves the build
//   POST /workbench/:id           thaw        a preview's hostname routed back to the branch's dev server
//   POST /workbench/:id           land        a branch's work into its parent's tree, uncommitted
//   POST /workbench/:id           commit      { message, files: [{ path, blob }] } — those files as the diff showed them, committed on a
//                                             checkout's HEAD; refused on a branch, while a run is live, and where a file moved since
//   POST /workbench/:id           archive     { discard? } — a branch's worktree removed, its git branch kept;
//                                             a preview is RETIRED first — off the machine, its Environment removed
//   POST /workbench/:id           fresh       { about? } — a new chat, shown — or the shown one, when it is still empty; about is the register row { id, title } it is for
//   POST /workbench/:id           select      { chat } — the chat shown
//   POST /workbench/:id           close       { chat } — forgotten here, what it cost kept; Claude Code keeps the session
//   POST /workbench/:id           importable  the terminal sessions started in this folder that no chat holds, newest first (read from ~/.claude, not the index)
//   POST /workbench/:id           importSession { session } — a terminal session adopted as a chat, shown; the next message resumes it
//   POST /workbench/:id           nextFor     { chat? } — the top ready rows of `fli next` (the Atlas's cached ranking) for the chat's chosen package, repo-wide where none
//   POST /workbench/:id           setPackage  { chat, package } — a member path, '.' for repo-wide, or null to infer it
//   POST /workbench/:id           stop · seen · unpin
//   POST /workbench/:id           configure   { name?, budget?, hooks?, review?, copy?, preview? }
//   POST /workbench/:id           run         { row } — started detached by row id, never by command
//   POST /workbench/:id           halt        { row } — stopped, its process group with it; on one already stopped, forgotten
//
// A preview's settings name a project and a machine in Basecamp, and cutting
// one is Basecamp's `apps.preview`, dialed as a signed peer (`$.app.basecamp`).
// Basecamp checks the settings name its rows on every call.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { existsSync }              from 'node:fs'
import { dirname, join }           from 'node:path'
import { describeRepo }            from '../../domain/local/local-git.ts'
import { doneScript, refOf }       from '../../domain/workbench/workbench.ts'
import { readAtlas, nextRows }     from '../../domain/atlas/atlas.ts'
import type { Opened, PreviewSettings } from '../../domain/workbench/workbench-preview.ts'

const READS  = ['pins', 'status', 'transcript', 'diff', 'runnables', 'output', 'plan', 'importable', 'nextFor']
const WRITES = ['pin', 'unpin', 'configure', 'send', 'stop', 'fresh', 'select', 'close', 'importSession', 'setPackage', 'seen', 'check', 'review', 'buildPlan', 'openPlan', 'closePlan', 'go', 'next', 'tick', 'file', 'decide', 'fork', 'freeze', 'thaw', 'land', 'commit', 'archive', 'run', 'halt']

const wb = () => $.app.workbench

function pinned() {
  const p = wb().getPin(String($.id ?? ''))
  if (!p) throw new NotFound(`No pinned checkout '${$.id}'`)
  return p
}

const body = () => ($.data ?? {}) as Record<string, unknown>

/** A preview branch: what Open made, and the settings of the checkout it
 *  was forked from. */
function previewOf(p: ReturnType<typeof pinned>): { opened: Opened, settings: PreviewSettings } {
  const parent = p.from ? wb().getPin(p.from) : null
  if (!p.opened?.appId || !p.opened.environmentId) throw new Conflict(`${p.name} is not a preview — fork one with { preview: true }`)
  if (!parent?.preview) throw new Conflict(`${p.name}'s checkout no longer carries preview settings`)
  return { opened: p.opened as Opened, settings: parent.preview }
}

export default createService({
  name: 'workbench',

  methods: [
    ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
    ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async pins() {
    const pins = wb().readPins()
    return {
      dir:  wb().dir,
      pins: await Promise.all(pins.map(async p => {
        // A renamed or deleted folder: git there answers nothing, and every
        // run is refused, so the screen says so instead of a blank card.
        const missing = !existsSync(p.path)
        return {
          ...p,
          missing,
          git:    missing ? null : await describeRepo(dirname(p.path), p.path),
          checkable: !missing && !!doneScript(p.path),
          // Where Build plan writes by default: IDEAS/<slug>.md beside the
          // other papers, PLAN.md where the checkout has none (FJS-D966).
          hasIdeas:  !missing && existsSync(join(p.path, 'IDEAS')),
          // The tab menu's choices; the status poll carries only each chat's.
          members:   missing ? [] : await wb().members(p.id) ?? [],
          status: await wb().status(p),
        }
      })),
    }
  },

  async status() {
    return { status: await wb().statuses() }
  },

  async transcript() {
    const p = pinned()
    const t = await wb().transcript(p.id, body().chat)
    if (!t) throw new NotFound(`${p.name} has no chat '${body().chat}'`)
    return t
  },

  async diff() {
    const p = pinned()
    return wb().diff(p.id)
  },

  async runnables() {
    const p = pinned()
    return wb().runnables(p.id)
  },

  async output() {
    const p = pinned()
    const out = wb().output(p.id, body().row)
    if (!out) throw new NotFound(`Nothing called '${body().row}' was started in ${p.name}`)
    return out
  },

  async plan() {
    const p = pinned()
    const plan = await wb().readPlan(p.id)
    if (!plan) throw new NotFound(`${p.name} has no plan — Build plan writes one`)
    return plan
  },

  async buildPlan() {
    const p = pinned()
    const r = await wb().buildPlan(p.id, { goal: body().goal, path: body().path })
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async openPlan() {
    const p = pinned()
    const r = wb().openPlan(p.id, body().path)
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async closePlan() {
    const p = pinned()
    const r = wb().closePlan(p.id, body().path)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async go() {
    const p = pinned()
    const r = await wb().go(p.id)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async next() {
    const p = pinned()
    const r = await wb().next(p.id)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async tick() {
    const p = pinned()
    const r = await wb().tick(p.id, body().step)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async file() {
    const p = pinned()
    const { severity, area, title, detail } = body()
    const r = await wb().file(p.id, { severity, area, title, detail })
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async decide() {
    const p = pinned()
    const { question, pick, why, section } = body()
    const r = await wb().decide(p.id, { question, pick, why, section })
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async run() {
    const p = pinned()
    const r = await wb().run(p.id, body().row)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async halt() {
    const p = pinned()
    const r = wb().halt(p.id, body().row)
    if ('refused' in r) throw new NotFound(r.refused)
    return r
  },

  async pin() {
    const r = wb().pin(body().path)
    if ('refused' in r) throw new BadRequest(r.refused)
    return r.pin
  },

  async unpin() {
    const p = pinned()
    const r = wb().unpin(p.id)
    if (r) throw new Conflict(r.refused)
    return { id: p.id }
  },

  async fork() {
    const p = pinned()
    const preview = body().preview === true
    // Asked before the worktree is cut, so an unenrolled machine leaves no branch to archive.
    const unready = preview ? $.app.basecamp.refusal('open') : null
    if (unready) throw new Conflict(unready)
    const r = await wb().fork(p.id, { slug: body().slug, preview })
    if ('refused' in r) throw new Conflict(r.refused)
    if (!preview) return r.pin
    const b = r.pin
    try {
      const opened = await $.app.basecamp.preview({ action: 'open', settings: p.preview!, branch: { slug: b.branch!.slice('wb/'.length), branch: b.branch!, port: b.opened!.port } })
      return wb().recordOpened(b.id, opened)
    } catch (e) {
      await wb().archive(b.id, { discard: true })
      throw new Conflict(`Open failed, so the branch was archived (${b.branch} is kept): ${(e as Error).message}`)
    }
  },

  async freeze() {
    const p = pinned()
    const { opened, settings } = previewOf(p)
    return $.app.basecamp.preview({ action: 'freeze', settings, branch: { path: p.path, branch: p.branch!, appId: opened.appId } })
  },

  async thaw() {
    const p = pinned()
    const { opened, settings } = previewOf(p)
    const { port, hosts, ...route } = await $.app.basecamp.preview({ action: 'thaw', settings, opened })
    if (!route.ok) throw new Conflict(`The hostnames were not routed back: ${route.why}`)
    return { hosts, port, route }
  },

  async land() {
    const p = pinned()
    const r = wb().land(p.id)
    if ('refused' in r) throw new Conflict(r.refused, { files: r.files ?? [] })
    return r
  },

  async commit() {
    const p = pinned()
    const r = wb().commit(p.id, body())
    if ('refused' in r) throw new Conflict(r.refused, { files: r.files ?? [] })
    return r
  },

  async archive() {
    const p = pinned()
    const refused = wb().archiveRefusal(p.id, { discard: body().discard })
    if (refused) throw new Conflict(refused.refused, { pending: refused.pending ?? 0 })
    // Before the worktree goes and its port with it: a route left dialing a
    // released port serves whichever branch claims that port next.
    const retired = p.opened?.environmentId ? await $.app.basecamp.preview({ action: 'retire', ...previewOf(p) }) : null
    const r = await wb().archive(p.id, { discard: body().discard })
    if ('refused' in r) throw new Conflict(r.refused, { pending: r.pending ?? 0 })
    return retired ? { ...r, retired } : r
  },

  async configure() {
    const p = pinned()
    const r = wb().configure(p.id, body())
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async send() {
    const p = pinned()
    const r = await wb().send(p.id, String(body().prompt ?? ''), body().chat, body().images)
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async check() {
    const p = pinned()
    const r = await wb().check(p.id, body().chat)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async review() {
    const p = pinned()
    const r = await wb().review(p.id)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async stop() {
    const p = pinned()
    return { stopped: wb().stop(p.id) }
  },

  async fresh() {
    const p = pinned()
    let about
    try { about = refOf(body().about) } catch (e) { throw new BadRequest((e as Error).message) }
    return wb().fresh(p.id, about)
  },

  async select() {
    const p = pinned()
    const r = wb().select(p.id, body().chat)
    if ('refused' in r) throw new NotFound(r.refused)
    return r
  },

  async close() {
    const p = pinned()
    const r = await wb().close(p.id, body().chat)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async importable() {
    const p = pinned()
    return { sessions: await wb().importable(p.id) }
  },

  async nextFor() {
    const p = pinned()
    const chat = p.chats.find(c => c.id === (body().chat ?? p.chat)) ?? p.chats[0]
    const member = chat?.package && chat.package !== '.' ? (await wb().members(p.id))?.find(m => m.path === chat.package) ?? null : null
    let atlas
    try { atlas = await readAtlas(p.path) } catch (e) { throw new Conflict(`${p.name} has no registers to rank: ${(e as Error).message}`) }
    return { package: member, rows: nextRows(atlas, { member }) }
  },

  async importSession() {
    const p = pinned()
    const r = await wb().importSession(p.id, body().session)
    if ('refused' in r) throw new Conflict(r.refused)
    return r
  },

  async setPackage() {
    const p = pinned()
    const r = await wb().setPackage(p.id, $.data)
    if ('refused' in r) throw new BadRequest(r.refused)
    return r
  },

  async seen() {
    const p = pinned()
    return wb().seen(p.id)
  },

})
