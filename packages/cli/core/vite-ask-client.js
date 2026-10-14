// ─── vite-ask-client.js — the panel a shift+alt-click opens ────────────────
//
// Served as a module by `vite-ask.js`, dev only. It registers as Mesa's
// inspector picker, so it is inert on a page where the inspector is off. Every
// string from the server is set as text, never as HTML: a reply quotes the
// page's markup back, and that markup is the app's.
//
// The session id survives a full reload in sessionStorage, because an edit that
// HMR cannot swap in place reloads the page out from under the conversation.
// So does the log, and the panel reopens over it: a run's Undo lives in the
// log, and a reload that took the log took the only way back.
//
// Every run that changed a file ends in a row with its own Undo, so an older
// run can be undone after a newer one. The undo never overwrites another
// writer's lines, and a later run in the same file is one.
//
// "Edit text" changes a pick's words without a model: an input laid OVER the
// element, which is never made editable itself, so nothing the page does with
// a contenteditable — pasted formatting, a layout that shifts — can happen.
// When the server cannot make the swap without guessing, the same edit goes to
// Claude as an instruction, and the log says which path ran.
//
// Picks stack until a send: each shift+alt-click before it adds an element, and
// the one instruction covers them all, as one run with one Undo. The first pick
// after a send, or into a closed panel, starts the next list.
//
// The chips say what kind of change and how far it reaches, as keys the server
// turns into sentences. "All ×N" is offered only when a pick's source draws
// more than one element on the page, which is a loop.
//
// A pick goes as an OUTLINE rather than its outerHTML: a loop's items share a
// loc, so a run of siblings from one source keeps the first and counts the
// rest, and long text is clipped. With it go the locs under the element, which
// is the only way to the route's file when the pick is a layout's slot wrapper.
//
// "Continue in terminal" copies `claude --resume` for the conversation, so the
// person goes on with every tool their own session has. Before there is a
// conversation it copies what a first ask would send instead, for any agent.
//
// "Make a plan" is for what has no element to pick yet, a new feature: the
// box takes a goal instead of a change, and the run writes PLAN.md at the app
// root for the Workbench to carry out. Picks and chips stay for the next ask;
// a pick while planning goes back to asking.
//
// "Pick mode" latches shift+alt in the inspector, so a plain click picks the
// next element. The inspector owns the mode and draws its own way out; the
// button only flips it and redraws when the inspector says it changed.
//
// An image pasted into the box goes with the next send, shrunk first to the
// size the model reads at, so a retina screenshot does not outgrow the request.
// The log keeps a thumbnail of each, never the image: it lives in sessionStorage.
//
// "Clear" hides the log and forgets nothing: the session goes on with what
// it knew, and a cleared run's Undo is one "Show cleared" away. "New chat" is
// the button that forgets.
//
// The panel shrinks to a tab in the bottom-right corner, where it stays out of
// the page it is editing. The tab survives a reload like the panel
// does, and a pick expands it.
//
// Every request carries the app's own token when the page holds one: on a dev
// server other people reach, the server asks the app's API who that is. Submit
// is drawn only when the server says the checkout is a Workbench branch.

// Led by a semicolon: the plugin prepends a line, and a bare `(` would call it.
;(function () {
  if (typeof window === 'undefined' || window.__fjsAsk) return
  window.__fjsAsk = true

  const keep = key => ({
    get()  { try { return sessionStorage.getItem(key) } catch { return null } },
    set(v) { try { v ? sessionStorage.setItem(key, v) : sessionStorage.removeItem(key) } catch {} },
  })
  // `ASK` is prepended by the plugin that serves this file.
  const TOKEN_KEY = (typeof ASK !== 'undefined' && ASK.tokenKey) || 'junction_token'
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } }

  const store = keep('fli:ask:session')
  const shown = keep('fli:ask:open')
  const saved = keep('fli:ask:log')
  const foldKeep = keep('fli:ask:fold')
  const miniKeep = keep('fli:ask:mini')
  // How hard Claude thinks follows the Change chip unless one is pressed; a
  // pressed one is a preference rather than part of one ask, so it outlives
  // the tab where the rest of the panel's state does not, until the kind's own
  // is pressed again.
  const EFFORT_KEY = 'fli:ask:effort'
  const EFFORTS = (typeof ASK !== 'undefined' && ASK.efforts) || []
  const EFFORT  = (typeof ASK !== 'undefined' && ASK.effort) || null
  const KIND_EFFORTS = (typeof ASK !== 'undefined' && ASK.kinds) || {}
  const kindEffort = () => KIND_EFFORTS[kind] || EFFORT
  const pressedEffort = () => { try { const v = localStorage.getItem(EFFORT_KEY); return EFFORTS.includes(v) ? v : null } catch { return null } }
  const setEffort = v => { try { v === kindEffort() ? localStorage.removeItem(EFFORT_KEY) : localStorage.setItem(EFFORT_KEY, v) } catch {} }

  let panel, tab, list, hint, chips, effortBox, tray, input, send, stop, submit, fresh, log, rail, folds, latch, planner
  let picks = [], sent = false, busy = false, planning = false
  // The reply entry still streaming, and what the run said it is doing.
  let draft = null, doing = 'working'
  // Closed hides the panel and its tab; shrunk hides the panel behind the tab.
  let closed = false, shrunk = !!miniKeep.get()
  // Pasted images waiting for the next send: `{ type, data, thumb }`.
  let shots = []
  // The chips' answers, keys of the server's EDIT_KINDS and EDIT_SCOPES.
  let kind = null, scope = null
  // The inspector's modifier, as the last pick named it.
  let pickKey = 'alt'
  // What the log holds, as data, so a reload can draw it again.
  let entries = []
  // Whether the rows "Clear" hid are drawn again, until the next Clear.
  let unhide = false

  // The server's limit, and its whole HTML budget: a page section's outerHTML is
  // easily 50KB, and ten of them would outgrow the request before the prompt.
  const MAX_PICKS = 10
  const HTML_CUT  = 4000
  const MAX_TEXT  = 2000
  const MAX_INNER = 60
  const CLIP_TEXT = 80
  const CLIP_ATTR = 120
  // The server keeps 20 runs to undo; the log keeps what draws more than that.
  const MAX_ENTRIES = 300
  // The server's limit. The long edge past which the model downsamples anyway,
  // and the PNG size past which a screenshot goes as a JPEG instead.
  const MAX_IMAGES = 5
  const SHOT_EDGE  = 1568
  const SHOT_PNG   = 1024 * 1024
  const THUMB_EDGE = 120

  const words = el => (el.textContent || '').replace(/\s+/g, ' ').trim()

  const css = (el, s) => { el.style.cssText = s; return el }
  const make = (tag, s, text) => { const el = css(document.createElement(tag), s || ''); if (text) el.textContent = text; return el }
  const BTN = 'font:13px/1 ui-sans-serif,system-ui;padding:6px 11px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer'
  // A control is an icon, so the header and a pick's row stay one line. Its
  // word is the aria-label and its title says what it does.
  const ICON = BTN + ';padding:6px;display:inline-flex;align-items:center;justify-content:center'
  const ICONS = {
    pick:  ['M14 4.1 12 6', 'm5.1 8-2.9-.8', 'm6 12-1.9 2', 'M7.2 2.2 8 5.1', 'M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z'],
    term:  ['m4 17 6-6-6-6', 'M12 19h8'],
    clear: ['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9'],
    fresh: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M12 7v6', 'M9 10h6'],
    shrink: ['M5 12h14'],
    close: ['M18 6 6 18', 'm6 6 12 12'],
    edit:  ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
    open:  ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    plan:  ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  }
  const SVG = 'http://www.w3.org/2000/svg'
  const iconButton = (name, label, title) => {
    const b = make('button', ICON)
    b.type = 'button'
    b.title = title
    b.setAttribute('aria-label', label)
    const svg = document.createElementNS(SVG, 'svg')
    for (const [k, v] of [['width', 16], ['height', 16], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', 2], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
    for (const d of ICONS[name]) { const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.appendChild(path) }
    b.appendChild(svg)
    return b
  }
  const CHIP = 'font:12px/1 ui-sans-serif,system-ui;padding:4px 9px;border-radius:999px;border:1px solid #334155;background:transparent;color:#94a3b8;cursor:pointer'
  const CHIP_ON = ';background:#0369a1;border-color:#0369a1;color:#f8fafc'
  // The kind, scope and effort groups are segmented controls: one tray per
  // group, so a row reads as a label and a single choice rather than a pile of pills.
  const SEG = 'font:12px/1 ui-sans-serif,system-ui;padding:5px 10px;border-radius:5px;border:0;background:transparent;color:#cbd5e1;cursor:pointer'
  const SEG_ON = ';background:#0369a1;color:#f8fafc'
  // The panel floats over the page it edits, so it is glass: the page stays
  // in view behind it. The dimming in the filter is what keeps the light text
  // legible when the page behind is white, and why there is no third, dimmer
  // grey: over a white page it cannot be read at any dimming that keeps the
  // page in view.
  const GLASS = 'blur(3px) saturate(1.4) brightness(.5)'
  const WELL = 'rgba(2,6,23,.1)'

  const KINDS = [
    ['text',     'Text',     'Only the words'],
    ['style',    'Style',    'How it looks: classes, tones and treatments'],
    ['layout',   'Layout',   'Arrangement and size'],
    ['behavior', 'Behavior', 'What it does: handlers and script'],
    ['data',     'Data',     'What it shows: fields, records, order, filter'],
  ]

  const locOf = el => el.getAttribute('data-fjs-loc')
  const drawnFrom = loc => loc ? document.querySelectorAll(`[data-fjs-loc="${CSS.escape(loc)}"]`).length : 0

  // The locs under an element, each once, in the page's order.
  const innerLocs = el => [...new Set([...el.querySelectorAll('[data-fjs-loc]')].map(locOf))].slice(0, MAX_INNER)

  // An svg's drawing is dropped whole: path data is the bulk of an icon and
  // says nothing about the change. Comments go too; Mesa's are anchors.
  function outline(el) {
    const copy = el.cloneNode(true)
    const walk = node => {
      for (const a of [...node.attributes]) if (a.value.length > CLIP_ATTR) node.setAttribute(a.name, a.value.slice(0, CLIP_ATTR) + '…')
      if (node.localName === 'svg') return node.replaceChildren()
      if (node.localName === 'script' || node.localName === 'style') return node.replaceChildren()
      let first = null, extra = 0
      const fold = () => { if (extra) first.after(document.createComment(` +${extra} more from the same source `)); extra = 0 }
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 8) { child.remove(); continue }
        if (child.nodeType === 3) {
          const t = child.data.replace(/\s+/g, ' ')
          child.data = t.length > CLIP_TEXT ? t.slice(0, CLIP_TEXT) + '…' : t
          continue
        }
        if (child.nodeType !== 1) continue
        const loc = locOf(child)
        if (loc && first && locOf(first) === loc) { child.remove(); extra++; continue }
        fold()
        first = child
        walk(child)
      }
      fold()
    }
    walk(copy)
    return copy.outerHTML.replace(/>\s+</g, '> <')
  }

  function remember(entry) {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  }
  const save = () => saved.set(entries.length ? JSON.stringify(entries) : null)

  function line(text, tone, imgs) {
    remember({ k: 'line', text, tone, at: Date.now(), ...(imgs?.length ? { imgs } : {}) })
    if (tone === 'you') toBottom = true
    drawSoon()
  }

  // Reply text as it streams: one entry grown in place, which the whole
  // block replaces when it lands.
  function streamed(text) {
    if (!draft) { line(''); draft = entries[entries.length - 1] }
    draft.text += text
    drawSoon()
  }

  function diff(files) {
    remember({ k: 'diff', files })
    drawSoon()
  }

  // The end of a run that changed something, with the Undo for that run.
  function ended(run, text) {
    remember({ k: 'run', run, text, undone: false })
    drawSoon()
  }

  // ─── the chat ────────────────────────────────────────────────────────
  // The log is redrawn whole from `entries`, so a fold, a flip or an undo is
  // a change to data and never to a node another draw would throw away.
  // A timer and not requestAnimationFrame: a hidden tab never runs a frame,
  // and the log would stay empty until somebody looked.

  const SHOW_TOOLS = 4
  const FOLDS = [['none', 'None'], ['you', 'Mine'], ['ai', 'Claude'], ['both', 'Both']]
  let flips = new WeakSet()
  // Whether the reader is at the end of the log, kept from the last scroll:
  // a row above it growing shrinks the log, and only this says to follow.
  let drawing = 0, toBottom = false, stuck = true

  // The save rides the same tick: the whole log, diffs and thumbnails, is
  // one stringify, and a run streams a tool call every few hundred ms.
  function drawSoon() {
    if (drawing) return
    drawing = setTimeout(() => { drawing = 0; save(); if (log) draw() }, 16)
  }

  // A run is mostly tool calls; a row of them is one block showing the last
  // few, so the words are not lost between the calls.
  function grouped(list) {
    const out = []
    for (const e of list) {
      const kind = e.k === 'line' ? ({ you: 'you', tool: 'tools', error: 'error', meta: 'meta' }[e.tone] || 'ai') : e.k
      const last = out[out.length - 1]
      if (kind === 'tools' && last?.kind === 'tools') { last.calls.push(e.text.replace(/^· /, '')); continue }
      out.push({ kind, e, calls: kind === 'tools' ? [e.text.replace(/^· /, '')] : null })
    }
    return out
  }

  const sideOf = kind => kind === 'you' ? 'you' : kind === 'ai' || kind === 'tools' || kind === 'diff' ? 'ai' : null
  function folded(g) {
    const side = sideOf(g.kind)
    if (!side) return false
    const mode = foldKeep.get() || 'none'
    return (mode === 'both' || mode === side) !== flips.has(g.e)
  }
  function flip(e) {
    flips.has(e) ? flips.delete(e) : flips.add(e)
    drawSoon()
  }

  const ago = at => {
    if (!at) return ''
    const s = Math.round((Date.now() - at) / 1000)
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(at).toLocaleDateString()
  }

  const HEAD = 'display:flex;align-items:baseline;gap:6px;width:100%;padding:0;border:0;background:none;color:inherit;font:12px/1.4 ui-sans-serif,system-ui;text-align:start;cursor:pointer'
  const CLAMP = ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'

  function bubble(g, i) {
    const you = g.kind === 'you', shut = folded(g)
    const box = make('div', `max-width:88%;padding:7px 11px;border:1px solid ${you ? '#0369a1' : '#334155'};border-radius:10px;background:${you ? 'rgba(3,105,161,.22)' : '#1e293b'};align-self:${you ? 'flex-end;border-bottom-right-radius:3px' : 'flex-start;border-bottom-left-radius:3px'}`)
    if (you) box.dataset.turn = i
    const head = make('button', HEAD + ';margin-bottom:2px')
    head.type = 'button'
    head.setAttribute('aria-expanded', String(!shut))
    head.onclick = () => flip(g.e)
    head.appendChild(make('strong', `color:${you ? '#7dd3fc' : '#e2e8f0'}`, you ? 'You' : 'Claude'))
    if (you && g.e.at) head.appendChild(make('span', 'color:#94a3b8', ago(g.e.at)))
    head.appendChild(make('span', 'margin-left:auto;color:#94a3b8', shut ? '▸' : '▾'))
    box.append(head, make('div', 'white-space:pre-wrap;overflow-wrap:anywhere' + (shut ? CLAMP : ''), g.e.text))
    if (g.e.imgs && !shut) {
      const row = make('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px')
      for (const src of g.e.imgs) { const img = make('img', 'max-height:64px;max-width:120px;border-radius:4px;border:1px solid #334155'); img.src = src; img.alt = 'pasted image'; row.appendChild(img) }
      box.appendChild(row)
    }
    return box
  }

  function tools(g) {
    const box = make('div', 'align-self:flex-start;max-width:100%;padding:0 11px;color:#94a3b8;font:12px/1.5 ui-monospace,monospace;cursor:pointer')
    box.title = 'Show or hide these calls'
    box.onclick = () => flip(g.e)
    const n = g.calls.length
    if (folded(g)) { box.appendChild(make('div', '', `› ${n} tool call${n === 1 ? '' : 's'}`)); return box }
    if (n > SHOW_TOOLS) box.appendChild(make('div', 'color:#94a3b8', `… ${n - SHOW_TOOLS} more`))
    for (const c of g.calls.slice(-SHOW_TOOLS)) box.appendChild(make('div', 'overflow-wrap:anywhere', `› ${c}`))
    return box
  }

  // One block per file: its path, then each line marked removed, added or kept.
  // Folded, only the path and its counts stay.
  function diffs(g) {
    const tones = { '-': 'background:rgba(239,68,68,.18);color:#fecaca', '+': 'background:rgba(34,197,94,.16);color:#bbf7d0', '…': 'color:#94a3b8', ' ': 'color:#94a3b8' }
    const shut = folded(g)
    const wrap = make('div', 'display:flex;flex-direction:column;gap:6px;align-self:stretch')
    for (const f of g.e.files) {
      const box = make('div', 'border:1px solid #334155;border-radius:6px;overflow:hidden')
      box.dataset.diff = f.file
      const head = make('button', HEAD + ';align-items:center;padding:5px 9px;background:#1e293b;color:#e2e8f0;font:12px/1.4 ui-monospace,monospace')
      head.type = 'button'
      head.setAttribute('aria-expanded', String(!shut))
      head.onclick = () => flip(g.e)
      const added = f.lines.filter(l => l[0] === '+').length, removed = f.lines.filter(l => l[0] === '-').length
      // The path is the LAST node, so the page's text reads it straight into
      // its lines; `order` puts the counts back on the right.
      head.append(
        make('span', 'color:#94a3b8', shut ? '▸' : '▾'),
        make('span', 'order:1;margin-left:auto;white-space:nowrap;color:#94a3b8', `+${added} −${removed}`),
        make('span', 'min-width:0;overflow-wrap:anywhere', f.file + (f.created ? '  (new file)' : '')),
      )
      box.appendChild(head)
      if (!shut) {
        const pre = make('div', 'overflow-x:auto;padding:3px 0;background:' + WELL + ';font:12px/1.45 ui-monospace,monospace')
        for (const [op, text] of f.lines)
          pre.appendChild(make('div', `white-space:pre;padding:0 9px;${tones[op] || ''}`, op === '…' ? `… ${text}` : `${op} ${text}`))
        box.appendChild(pre)
      }
      wrap.appendChild(box)
    }
    return wrap
  }

  function runRow(e) {
    const row = make('div', 'display:flex;align-items:center;gap:8px;padding:0 11px;font-size:12.5px')
    row.dataset.run = e.run
    row.appendChild(make('div', 'flex:1;white-space:pre-wrap;color:#94a3b8', e.text))
    const btn = make('button', BTN, e.undone ? 'Undone' : 'Undo')
    btn.title = 'Put back what this run changed, leaving any later change alone'
    btn.disabled = e.undone || !!e.undoing
    btn.onclick = () => undoRun(e)
    row.appendChild(btn)
    return row
  }

  function node(g, i) {
    if (g.kind === 'you' || g.kind === 'ai') return bubble(g, i)
    if (g.kind === 'tools') return tools(g)
    if (g.kind === 'diff')  return diffs(g)
    if (g.kind === 'run')   return runRow(g.e)
    if (g.kind === 'error') return make('div', 'align-self:stretch;padding:7px 11px;border:1px solid rgba(239,68,68,.45);border-radius:8px;background:rgba(239,68,68,.12);color:#fca5a5;white-space:pre-wrap;overflow-wrap:anywhere', g.e.text)
    return make('div', 'padding:0 11px;color:#94a3b8;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere', g.e.text)
  }

  // A reader who scrolled up to an earlier turn stays there; one at the
  // bottom, or one who just sent, follows the run.
  function draw() {
    const top = log.scrollTop
    log.textContent = ''
    const hidden = entries.filter(e => e.hid).length
    if (hidden) {
      const n = grouped(entries.filter(e => e.hid)).length
      const more = make('button', 'align-self:center;padding:2px 9px;border:0;border-radius:999px;background:none;color:#94a3b8;font:12px/1.4 ui-sans-serif,system-ui;cursor:pointer', unhide ? 'Hide cleared' : `Show ${n} cleared`)
      more.type = 'button'
      more.onclick = () => { unhide = !unhide; drawSoon() }
      log.appendChild(more)
    }
    grouped(unhide ? entries : entries.filter(e => !e.hid)).forEach((g, i) => log.appendChild(node(g, i)))
    if (busy) log.appendChild(make('div', 'align-self:flex-start;padding:0 11px;color:#94a3b8;font-size:12.5px;font-style:italic', `Claude is ${doing}…`))
    log.scrollTop = stuck || toBottom ? log.scrollHeight : top
    toBottom = false
    drawTab()
    folds.style.display = entries.length ? 'flex' : 'none'
    for (const b of folds.querySelectorAll('button')) {
      const on = (foldKeep.get() || 'none') === b.dataset.fold
      b.style.cssText = CHIP + (on ? CHIP_ON : '')
      b.setAttribute('aria-pressed', String(on))
    }
    drawRail()
  }

  // ─── the jump rail ───────────────────────────────────────────────────
  // A notch per message you sent, placed where it sits in the log, so a fold
  // that shortens the log moves the notches with it. The thumb is the part
  // of the log on screen; the lit notch is the turn being read, the last one
  // starting above the upper third of it.

  function drawRail() {
    const h = log.scrollHeight || 1
    const turns = [...log.querySelectorAll('[data-turn]')]
    rail.textContent = ''
    rail.style.display = turns.length ? '' : 'none'
    if (!turns.length) return
    const thumbTop = log.scrollTop / h * 100, thumbH = log.clientHeight / h * 100
    if (thumbH < 99) rail.appendChild(make('span', `position:absolute;left:0;right:0;top:${thumbTop}%;height:${thumbH}%;border-radius:999px;background:#334155;pointer-events:none`))
    const tops = turns.map(el => el.offsetTop / h * 100)
    let at = -1
    tops.forEach((t, k) => { if (t <= thumbTop + thumbH / 3) at = k })
    turns.forEach((el, k) => {
      const lit = k === at
      const text = (el.lastChild?.textContent || '').slice(0, 80)
      // A 4px notch is too thin to hit; the border is the hit area.
      const n = make('button', `position:absolute;left:-6px;right:-6px;top:calc(${tops[k]}% - 5px);height:${lit ? 6 : 4}px;box-sizing:content-box;padding:0;border:5px solid transparent;border-left-width:4px;border-right-width:4px;background-color:${lit ? '#7dd3fc' : '#0369a1'};background-clip:content-box;cursor:pointer`)
      n.type = 'button'
      n.title = text
      n.setAttribute('aria-label', `Message ${k + 1}: ${text}`)
      if (lit) n.setAttribute('aria-current', 'true')
      n.onmouseenter = () => { n.style.backgroundColor = '#7dd3fc' }
      n.onmouseleave = () => { if (!lit) n.style.backgroundColor = '#0369a1' }
      n.onclick = () => log.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
      rail.appendChild(n)
    })
  }

  function setBusy(on) {
    busy = on
    doing = 'working'
    draft = null
    send.disabled = on
    submit.disabled = on
    stop.style.display = on ? '' : 'none'
    drawTab()
    drawSoon()
  }

  function build() {
    panel = make('div', `position:fixed;right:12px;bottom:12px;z-index:2147483646;box-sizing:border-box;width:min(680px,calc(100vw - 24px));max-height:85vh;display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid rgba(148,163,184,.22);border-radius:10px;background:rgba(15,23,42,.5);-webkit-backdrop-filter:${GLASS};backdrop-filter:${GLASS};color:#e2e8f0;font:14px/1.5 ui-sans-serif,system-ui;box-shadow:0 8px 30px rgba(0,0,0,.35)`)
    const head = make('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:6px')
    fresh = iconButton('fresh', 'New chat', 'New chat: forget the conversation; the next ask starts a new session')
    // The log stays: its Undo buttons still undo, whichever conversation ran them.
    fresh.onclick = () => { store.set(null); line('New conversation.', 'meta') }
    const wipe = iconButton('clear', 'Clear', 'Clear: hide the messages so far; the conversation and its Undos are kept')
    wipe.onclick = () => {
      for (const e of entries) e.hid = true
      unhide = false
      save()
      drawSoon()
    }
    const term = iconButton('term', 'Continue in terminal', 'Continue in terminal: copy a command that resumes this conversation, or, before there is one, this ask for any agent')
    term.onclick = handoff
    latch = iconButton('pick', 'Pick mode', 'Pick mode: click elements to pick them, without holding shift+alt (Esc leaves)')
    latch.onclick = () => { const i = inspector(); if (i) i.pickMode(!i.pickMode()) }
    drawLatch()
    planner = iconButton('plan', 'Make a plan', 'Make a plan: for a new feature, with nothing on the page to pick — Claude writes PLAN.md at the app root and builds nothing')
    planner.onclick = () => { planning = !planning; render(); input.focus() }
    const shrink = iconButton('shrink', 'Shrink to a tab', 'Shrink to a tab in the corner (the conversation is kept)')
    shrink.onclick = () => fit(true)
    const close = iconButton('close', 'Close', 'Close (the conversation is kept)')
    close.onclick = () => { closed = true; shown.set(null); layout() }
    head.append(latch, planner, term, wipe, fresh, make('span', 'flex:1'), shrink, close)

    list = make('div', 'display:flex;flex-direction:column;gap:6px;max-height:24vh;overflow:auto')
    hint = make('div', 'margin-top:-6px;color:#94a3b8;font-size:12.5px')

    folds = make('div', 'display:none;flex-wrap:wrap;align-items:center;gap:4px 6px;font-size:12px;color:#94a3b8')
    folds.setAttribute('role', 'group')
    folds.setAttribute('aria-label', 'Collapse messages')
    folds.appendChild(make('span', 'margin-right:2px', 'Collapse'))
    for (const [key, text] of FOLDS) {
      const b = make('button', CHIP, text)
      b.type = 'button'
      b.dataset.fold = key
      b.onclick = () => { foldKeep.set(key === 'none' ? null : key); flips = new WeakSet(); drawSoon() }
      folds.appendChild(b)
    }

    const chat = make('div', 'display:flex;gap:8px;flex:1;min-height:96px')
    // The rail is its scrollbar.
    log = make('div', 'flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;padding:2px 0')
    log.onscroll = () => { stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 24; drawRail() }
    rail = make('nav', 'position:relative;flex:none;width:10px;border-radius:999px;background:' + WELL + ';display:none')
    rail.setAttribute('aria-label', 'Jump to a message')
    chat.append(log, rail)

    chips = make('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;font-size:12px;color:#94a3b8')

    input = make('textarea', 'box-sizing:border-box;width:100%;resize:vertical;min-height:84px;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:' + WELL + ';color:#e2e8f0;font:14px/1.45 ui-sans-serif,system-ui')
    input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask() } }
    input.onpaste = paste
    tray = make('div', 'display:none;flex-wrap:wrap;gap:6px')

    const row = make('div', 'display:flex;gap:6px;justify-content:flex-end;padding-top:12px;border-top:1px solid #1e293b')
    submit = make('button', BTN, 'Submit for review')
    submit.title = 'Commit what the panel changed and open a pull request for the owner to review'
    submit.style.display = 'none'
    submit.onclick = submitAll
    stop = make('button', BTN, 'Stop')
    stop.style.display = 'none'
    stop.onclick = () => post('/__fjs/ask/stop', {}).catch(() => {})
    send = make('button', BTN + ';background:#0369a1;border-color:#0369a1', 'Send')
    send.onclick = ask
    effortBox = make('div', 'display:flex;align-items:center;gap:6px;margin-right:auto;font-size:11px;color:#64748b')
    row.append(effortBox, submit, stop, send)

    panel.append(head, list, hint, folds, chat, tray, input, chips, row)

    tab = make('button', `position:fixed;right:12px;bottom:12px;z-index:2147483646;display:none;align-items:center;gap:10px;box-sizing:border-box;width:min(680px,calc(100vw - 24px));padding:9px 14px;border:1px solid rgba(148,163,184,.22);border-radius:10px;background:rgba(15,23,42,.5);-webkit-backdrop-filter:${GLASS};backdrop-filter:${GLASS};color:#e2e8f0;font:14px/1.2 ui-sans-serif,system-ui;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.35)`)
    tab.type = 'button'
    tab.title = 'Open the Ask Claude panel'
    tab.onclick = () => fit(false)
    document.body.append(panel, tab)
    drawTab()
    layout()
    // The rail is drawn in fractions of the log, which a resize of the
    // panel moves without a scroll.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (stuck) log.scrollTop = log.scrollHeight; drawRail() }).observe(log)
    toBottom = true
    draw()
    refresh()
  }

  async function refresh() {
    let r
    try { r = await post('/__fjs/ask/status', {}).then(res => res.json()) } catch { return }
    if (r.error) return line(r.error, 'error')
    submit.style.display = r.submit ? '' : 'none'
  }

  async function submitAll() {
    if (busy) return
    line('Submitting for review…', 'meta')
    let r
    setBusy(true)
    try {
      r = await post('/__fjs/ask/submit', {}).then(res => res.json())
    } catch (err) {
      return line(String(err && err.message || err), 'error')
    } finally {
      setBusy(false)
    }
    if (r.error) {
      line(r.error, 'error')
      for (const f of r.files || []) line(`  ${f}`, 'error')
      return
    }
    line(`${r.created ? 'Opened' : 'Updated'} the pull request: ${r.pr}`, 'meta')
  }

  const inspector = () => window.__fjsInspect && window.__fjsInspect.pickMode ? window.__fjsInspect : null

  function drawLatch() {
    if (!latch) return
    const i = inspector()
    const on = !!(i && i.pickMode())
    latch.style.cssText = ICON + (on ? ';background:#0369a1;border-color:#0369a1' : '') + (i ? '' : ';display:none')
    latch.setAttribute('aria-pressed', String(on))
    drawHint()
  }

  function drawHint() {
    if (!hint) return
    const i = inspector()
    hint.textContent = i && i.pickMode()
      ? `Pick mode: a click adds an element · ${pickKey}-click opens its source · Esc leaves`
      : `${pickKey}-click opens the source in your editor · shift+${pickKey}-click asks here, and adds another element before you send`
  }

  function show() {
    closed = false
    shown.set('1')
    layout()
  }

  function layout() {
    panel.style.display = closed || shrunk ? 'none' : 'flex'
    tab.style.display = !closed && shrunk ? 'flex' : 'none'
  }

  function fit(small) {
    shrunk = small
    miniKeep.set(small ? '1' : null)
    layout()
    if (!small) { stuck = true; drawSoon(); input.focus() }
  }

  // The tab shows where the conversation left off: the last thing you asked,
  // clipped to one line by the browser.
  function drawTab() {
    if (!tab) return
    const last = entries.findLast(e => e.k === 'line' && e.tone === 'you')
    const status = busy ? 'working…' : picks.length ? `${picks.length} picked` : ''
    tab.textContent = ''
    tab.append(
      make('strong', 'flex:none', 'Ask Claude'),
      make('span', 'flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:start;color:#94a3b8;font-size:13px', last ? last.text.replace(/\s+/g, ' ').trim() : ''),
      ...(status ? [make('span', 'flex:none;color:#7dd3fc;font-size:12px', status)] : []),
      make('span', 'flex:none;color:#94a3b8', '▴'),
    )
  }

  function post(path, body) {
    const headers = { 'content-type': 'application/json' }
    const t = token()
    if (t) headers.authorization = `Bearer ${t}`
    return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  // One row per pick: where its source is, a glimpse of what it is (two items
  // of one loop share a loc), and the controls for that one element.
  function drawChips() {
    chips.textContent = ''
    const most = Math.max(0, ...picks.map(p => p.repeats))
    if (scope === 'every' && most < 2) scope = null
    const scopes = [
      ...(most > 1 ? [['every', `All ×${most}`, 'Every item its loop draws']] : []),
      ['component', 'Component', 'The whole component or section it belongs to'],
      ['page', 'Page', 'Wherever the same thing appears on the page'],
    ]
    const row = (label, buttons) => {
      const tray = make('div', 'display:flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:7px;background:#0f172a')
      tray.append(...buttons)
      const line = make('div', 'display:flex;align-items:center;gap:10px')
      chips.appendChild(line)
      line.append(make('span', 'flex:none;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b', label), tray)
    }
    const seg = (text, tip, on, onclick) => {
      const b = make('button', SEG + (on ? SEG_ON : ''), text)
      b.type = 'button'
      b.title = tip
      b.setAttribute('aria-pressed', String(on))
      b.onclick = onclick
      return b
    }
    const group = (label, options, current, pick) => {
      row(label, options.map(([key, text, tip]) =>
        seg(text, tip, current === key, () => { pick(current === key ? null : key); drawChips() })))
    }
    group('Change', KINDS, kind, v => { kind = v })
    group('Scope', scopes, scope, v => { scope = v })
    if (!EFFORTS.length) return
    // One effort is always on, so a second press on it keeps it rather than
    // clearing it the way a Change or Scope chip clears.
    const auto = kindEffort()
    const on = pressedEffort() || auto
    effortBox.textContent = ''
    const tray = make('div', 'display:flex;gap:1px;padding:1px;border-radius:5px;background:#0f172a')
    for (const key of EFFORTS) {
      const b = make('button', SEG + ';font-size:10.5px;padding:3px 6px' + (on === key ? SEG_ON : ''), key)
      b.type = 'button'
      b.title = key === auto ? `How long Claude thinks before it edits — the default for ${kind ? 'this kind of change' : 'an ask with no Change chip'}` : 'How long Claude thinks before it edits'
      b.setAttribute('aria-pressed', String(on === key))
      b.onclick = () => { setEffort(key); drawChips() }
      tray.appendChild(b)
    }
    effortBox.append('Effort', tray)
  }

  function drawPlanner() {
    planner.style.cssText = ICON + (planning ? ';background:#0369a1;border-color:#0369a1' : '')
    planner.setAttribute('aria-pressed', String(planning))
    input.placeholder = planning
      ? 'What should the new feature do? Claude writes a plan and builds nothing. (⌘/Ctrl+Enter sends)'
      : 'What should change? Paste a screenshot to show it. (⌘/Ctrl+Enter sends)'
    send.textContent = planning ? 'Make a plan' : 'Send'
    chips.style.display = planning ? 'none' : 'flex'
  }

  function render() {
    drawChips()
    drawPlanner()
    drawTab()
    list.textContent = ''
    list.style.display = picks.length && !planning ? 'flex' : 'none'
    for (const p of picks) {
      const row = make('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 8px 7px 11px;border:1px solid #1e293b;border-radius:8px;background:' + WELL + '')
      row.dataset.pick = p.loc
      const what = make('div', 'flex:1 1 180px;min-width:0')
      what.appendChild(make('div', 'font:12.5px/1.4 ui-monospace,monospace;color:#38bdf8;word-break:break-all', p.loc))
      const text = words(p.el)
      what.appendChild(make('div', 'color:#94a3b8;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
        `<${p.el.localName}>${text ? ' ' + text.slice(0, 60) : ''}`))
      row.appendChild(what)
      const acts = make('div', 'display:flex;flex:none;gap:6px;margin-left:auto')
      if (text && text.length <= MAX_TEXT) {
        const edit = iconButton('edit', 'Edit text', 'Edit text: change the words in place, without asking Claude when it can')
        edit.onclick = () => editText(p)
        acts.appendChild(edit)
      }
      if (p.open) {
        const source = iconButton('open', 'Open source', 'Open source: open this line in your editor')
        source.onclick = p.open
        acts.appendChild(source)
      }
      const drop = iconButton('close', 'Leave out', 'Leave this element out')
      drop.onclick = () => { picks = picks.filter(x => x !== p); render() }
      acts.appendChild(drop)
      row.appendChild(acts)
      list.appendChild(row)
    }
  }

  function open(p) {
    if (!panel) build()
    if (sent || closed) { picks = []; sent = false; kind = null; scope = null }
    planning = false
    if (!picks.some(x => x.el === p.el)) {
      if (picks.length >= MAX_PICKS) line(`${MAX_PICKS} elements is the most one ask takes`, 'error')
      else picks.push({ el: p.el, loc: p.loc, html: outline(p.el), inner: innerLocs(p.el), repeats: drawnFrom(p.loc), open: p.open })
    }
    pickKey = p.key || 'alt'
    drawHint()
    render()
    show()
    fit(false)
    input.focus()
  }

  // An edit made while the page reloaded leaves the pick holding an element
  // that is gone; the one now carrying its loc is it, when there is just one.
  function current(p) {
    if (p.el.isConnected) return p.el
    const same = document.querySelectorAll(`[data-fjs-loc="${CSS.escape(p.loc)}"]`)
    if (same.length === 1) p.el = same[0]
    return p.el.isConnected ? p.el : null
  }

  function editText(p) {
    if (busy) return
    const el = current(p)
    if (!el) return line(`${p.loc} is gone from the page — pick it again`, 'error')
    const old = words(el)
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
    const box = make('textarea', `position:absolute;z-index:2147483646;box-sizing:border-box;margin:0;padding:2px 4px;resize:none;outline:none;border:2px solid #38bdf8;border-radius:3px;background:#020617;color:#e2e8f0;top:${r.top + scrollY}px;left:${r.left + scrollX}px;width:${Math.max(r.width, 160)}px`)
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign']) box.style[k] = cs[k]
    box.dataset.fjsTextEdit = p.loc
    box.value = old
    document.body.appendChild(box)
    box.style.height = Math.max(r.height, box.scrollHeight) + 'px'
    box.focus()
    box.select()
    let over = false
    const finish = (commit) => {
      if (over) return
      over = true
      const next = box.value.replace(/\s+/g, ' ').trim()
      box.remove()
      if (commit && next && next !== old) direct(p, el, old, next)
    }
    box.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true) }
    }
    box.onblur = () => finish(false)
  }

  async function direct(p, el, old, next) {
    if (busy) return
    line(`“${old}” → “${next}”`, 'you')
    let r
    setBusy(true)
    try {
      r = await post('/__fjs/ask/text', { loc: p.loc, tag: el.localName, old, new: next }).then(res => res.json())
    } catch (err) {
      return line(String(err && err.message || err), 'error')
    } finally {
      setBusy(false)
    }
    if (r.error) return line(r.error, 'error')
    if (r.fallback) {
      line(`not a plain text edit (${r.fallback}) — asking Claude`, 'meta')
      return request(`Change the text "${old}" to exactly: ${next}`, [p], { kind: 'text', scope: null })
    }
    diff(r.files)
    ended(r.run, 'done · edited directly, no Claude run')
  }

  // ─── pasted images ───────────────────────────────────────────────────
  // Copying from a page can put text and an image on the clipboard together;
  // the text still pastes, and only a paste with no text is taken over.

  function paste(e) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
      .map(i => i.getAsFile()).filter(Boolean)
    if (!files.length) return
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault()
    for (const f of files) {
      if (shots.length >= MAX_IMAGES) { line(`${MAX_IMAGES} images is the most one ask takes`, 'error'); break }
      const slot = { pending: true }
      shots.push(slot)
      shrink(f).then(s => Object.assign(slot, s, { pending: false }), err => {
        shots = shots.filter(x => x !== slot)
        line(`could not read the pasted image — ${err && err.message || err}`, 'error')
      }).finally(drawTray)
    }
    drawTray()
  }

  const canvasOf = (bitmap, edge) => {
    const k = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bitmap.width * k))
    c.height = Math.max(1, Math.round(bitmap.height * k))
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height)
    return c
  }
  const blobOf = (c, type, q) => new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('the browser would not encode it')), type, q))
  const base64Of = blob => new Promise((ok, no) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => no(r.error)
    r.readAsDataURL(blob)
  })

  // A JPEG has no alpha, so a transparent PNG drawn onto one goes black where
  // it was clear; the white underneath is what a page shows through it.
  async function shrink(file) {
    const bitmap = await createImageBitmap(file)
    const c = canvasOf(bitmap, SHOT_EDGE)
    let blob = await blobOf(c, 'image/png')
    if (blob.size > SHOT_PNG) {
      const flat = document.createElement('canvas')
      flat.width = c.width; flat.height = c.height
      const g = flat.getContext('2d')
      g.fillStyle = '#fff'; g.fillRect(0, 0, flat.width, flat.height); g.drawImage(c, 0, 0)
      blob = await blobOf(flat, 'image/jpeg', 0.85)
    }
    const thumb = canvasOf(bitmap, THUMB_EDGE).toDataURL('image/jpeg', 0.7)
    bitmap.close?.()
    return { type: blob.type, data: await base64Of(blob), thumb }
  }

  function drawTray() {
    if (!tray) return
    tray.textContent = ''
    tray.style.display = shots.length ? 'flex' : 'none'
    shots.forEach((s, k) => {
      const box = make('div', 'position:relative;width:64px;height:64px;border:1px solid #334155;border-radius:6px;overflow:hidden;background:' + WELL)
      box.dataset.shot = k
      if (s.pending) box.appendChild(make('div', 'padding:22px 0;text-align:center;color:#94a3b8;font-size:11px', '…'))
      else { const img = make('img', 'width:100%;height:100%;object-fit:cover'); img.src = s.thumb; img.alt = `pasted image ${k + 1}`; box.appendChild(img) }
      const drop = make('button', 'position:absolute;top:2px;right:2px;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:rgba(15,23,42,.85);color:#e2e8f0;font:12px/18px ui-sans-serif,system-ui;cursor:pointer', '×')
      drop.type = 'button'
      drop.title = 'Leave this image out'
      drop.onclick = () => { shots = shots.filter(x => x !== s); drawTray() }
      box.appendChild(drop)
      tray.appendChild(box)
    })
  }

  async function ask() {
    const instruction = input.value.trim()
    if (!instruction || busy) return
    if (planning) {
      input.value = ''
      line(`Make a plan: ${instruction}`, 'you')
      return stream('/__fjs/ask/plan', { goal: instruction, page: location.href, effort: pressedEffort() || undefined })
    }
    if (shots.some(s => s.pending)) return line('an image is still being read — send again in a moment', 'error')
    const images = shots
    input.value = ''
    shots = []
    drawTray()
    sent = true
    return request(instruction, picks, { kind, scope }, images)
  }

  function request(instruction, list, chosen, images = []) {
    line(instruction, 'you', images.map(s => s.thumb))
    return stream('/__fjs/ask', {
      instruction,
      ...chosen,
      images:  images.map(s => ({ type: s.type, data: s.data })),
      picks:   wire(list),
      page:    location.href,
      session: store.get(),
      effort:  pressedEffort() || undefined,
    })
  }

  // One run, read as it streams: an ask, or a plan, whose last word is where
  // the plan was written.
  async function stream(path, body) {
    setBusy(true)
    let run = null
    try {
      const res = await post(path, body)
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}))
        line(err.error || `the dev server answered ${res.status}`, 'error')
        return
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const l of lines) {
          let e
          try { e = JSON.parse(l) } catch { continue }
          if (e.type === 'run') run = e.id
          else if (e.type === 'session') store.set(e.id)
          else if (e.type === 'delta') streamed(e.text)
          else if (e.type === 'text') { if (draft) { draft.text = e.text; draft = null; drawSoon() } else line(e.text) }
          else if (e.type === 'status') { doing = e.text; drawSoon() }
          else if (e.type === 'tool') { draft = null; line('· ' + e.text, 'tool') }
          else if (e.type === 'error') line(e.text, 'error')
          else if (e.type === 'diff') diff(e.files)
          else if (e.type === 'plan') line(`The plan is at ${e.path}. In the Workbench, Open plan with that path, then Go.`, 'meta')
          else if (e.type === 'result') {
            const bits = [e.ok ? 'done' : `stopped (${e.stop})`]
            if (e.cost != null) bits.push(`$${e.cost.toFixed(2)}`)
            if (e.denied) bits.push(`${e.denied} call(s) denied`)
            if (e.edits && run) ended(run, bits.join(' · '))
            else line(bits.join(' · '), 'meta')
          }
        }
      }
    } catch (err) {
      line(String(err && err.message || err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const wire = list => list.map(p => ({ loc: p.loc, html: p.html.slice(0, HTML_CUT), size: p.html.length, inner: p.inner, repeats: p.repeats }))

  async function handoff() {
    const session = store.get()
    let r
    try {
      r = await post('/__fjs/ask/handoff', session ? { session }
        : { instruction: input.value.trim(), kind, scope, picks: wire(picks), page: location.href }).then(res => res.json())
    } catch (err) {
      return line(String(err && err.message || err), 'error')
    }
    if (r.error) return line(r.error, 'error')
    // The clipboard is a secure-context API, so on a page reached over plain
    // http from another machine the text is shown to select by hand.
    let copied = false
    try { await navigator.clipboard.writeText(r.command || r.text); copied = true } catch {}
    if (r.command) {
      line(copied ? 'Copied — paste it into a terminal to go on there:' : 'Run this in a terminal to go on there:', 'meta')
      line(r.command, 'meta')
    } else {
      line(copied ? `Copied this ask (${r.text.length} chars) — paste it into any agent` : 'Copy this ask into any agent:', 'meta')
      if (!copied) line(r.text, 'meta')
      if (shots.length) line('The pasted images are not in it — paste them into the agent too.', 'meta')
    }
  }

  async function undoRun(entry) {
    if (entry.undone || entry.undoing) return
    entry.undoing = true
    drawSoon()
    let r
    try {
      r = await post('/__fjs/ask/undo', { run: entry.run }).then(res => res.json())
    } catch (err) {
      return line(String(err && err.message || err), 'error')
    } finally {
      delete entry.undoing
      drawSoon()
    }
    // The server forgets a run once asked, so an error is as final as a success.
    entry.undone = true
    save()
    if (r.error) return line(r.error, 'error')
    for (const f of r.undone) line(`undone: ${f}`, 'meta')
    for (const s of r.skipped) line(`not undone: ${s.file} — ${s.why}`, 'error')
  }

  // A reload with the panel open draws it again over the log it had.
  try { entries = JSON.parse(saved.get() || '[]') } catch { entries = [] }
  if (shown.get() && entries.length) { build(); render(); show() }

  // The inspector may load after this module; it is a sibling script tag.
  let tries = 0
  ;(function attach() {
    if (window.__fjsInspect && window.__fjsInspect.onPick) {
      window.__fjsInspect.onPick(open)
      if (window.__fjsInspect.onPickMode) window.__fjsInspect.onPickMode(drawLatch)
      drawLatch()
      console.log('%c[fli] ask ready — hold shift+alt and click an element to ask Claude to change it', 'color:#38bdf8')
      return
    }
    if (++tries < 50) setTimeout(attach, 100)
  })()
})()
