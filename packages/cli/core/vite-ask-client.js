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
// "Continue in terminal" copies `claude --resume` for the conversation, so the
// person goes on with every tool their own session has. Before there is a
// conversation it copies what a first ask would send instead, for any agent.

(function () {
  if (typeof window === 'undefined' || window.__fjsAsk) return
  window.__fjsAsk = true

  const keep = key => ({
    get()  { try { return sessionStorage.getItem(key) } catch { return null } },
    set(v) { try { v ? sessionStorage.setItem(key, v) : sessionStorage.removeItem(key) } catch {} },
  })
  const store = keep('fli:ask:session')
  const shown = keep('fli:ask:open')
  const saved = keep('fli:ask:log')

  let panel, title, list, hint, input, send, stop, fresh, log
  let picks = [], sent = false, busy = false
  // What the log holds, as data, so a reload can draw it again.
  let entries = []

  // The server's limit, and its whole HTML budget: a page section's outerHTML is
  // easily 50KB, and ten of them would outgrow the request before the prompt.
  const MAX_PICKS = 10
  const HTML_CUT  = 4000
  const MAX_TEXT  = 2000
  // The server keeps 20 runs to undo; the log keeps what draws more than that.
  const MAX_ENTRIES = 300

  const words = el => (el.textContent || '').replace(/\s+/g, ' ').trim()

  const css = (el, s) => { el.style.cssText = s; return el }
  const make = (tag, s, text) => { const el = css(document.createElement(tag), s || ''); if (text) el.textContent = text; return el }
  const BTN = 'font:12px/1 ui-sans-serif,system-ui;padding:5px 9px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer'

  function remember(entry) {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    save()
  }
  const save = () => saved.set(entries.length ? JSON.stringify(entries) : null)

  const COLORS = { tool: '#94a3b8', error: '#fca5a5', you: '#7dd3fc', meta: '#64748b' }

  function line(text, tone) {
    remember({ k: 'line', text, tone })
    drawLine(text, tone)
  }

  function drawLine(text, tone) {
    log.appendChild(make('div', `white-space:pre-wrap;margin:0 0 6px;color:${COLORS[tone] || '#e2e8f0'}`, text))
    log.scrollTop = log.scrollHeight
  }

  function diff(files) {
    remember({ k: 'diff', files })
    drawDiff(files)
  }

  // The end of a run that changed something, with the Undo for that run.
  function ended(run, text) {
    const entry = { k: 'run', run, text, undone: false }
    remember(entry)
    drawEnded(entry)
  }

  function drawEnded(entry) {
    const row = make('div', 'display:flex;align-items:center;gap:6px;margin:0 0 6px')
    row.dataset.run = entry.run
    row.appendChild(make('div', `flex:1;white-space:pre-wrap;color:${COLORS.meta}`, entry.text))
    const btn = make('button', BTN, entry.undone ? 'Undone' : 'Undo')
    btn.title = 'Put back what this run changed, leaving any later change alone'
    btn.disabled = entry.undone
    btn.onclick = () => undoRun(entry, btn)
    row.appendChild(btn)
    log.appendChild(row)
    log.scrollTop = log.scrollHeight
  }

  // One block per file: its path, then each line marked removed, added or kept.
  function drawDiff(files) {
    const tones = { '-': 'background:rgba(239,68,68,.18);color:#fecaca', '+': 'background:rgba(34,197,94,.16);color:#bbf7d0', '…': 'color:#64748b', ' ': 'color:#94a3b8' }
    for (const f of files) {
      const box = make('div', 'margin:0 0 8px;border:1px solid #1e293b;border-radius:4px;overflow:hidden')
      box.dataset.diff = f.file
      box.appendChild(make('div', 'padding:3px 6px;background:#1e293b;color:#e2e8f0;font:11px/1.4 ui-monospace,monospace', f.file + (f.created ? '  (new file)' : '')))
      const pre = make('div', 'overflow-x:auto;font:11px/1.45 ui-monospace,monospace')
      for (const [op, text] of f.lines)
        pre.appendChild(make('div', `white-space:pre;padding:0 6px;${tones[op] || ''}`, op === '…' ? `… ${text}` : `${op} ${text}`))
      box.appendChild(pre)
      log.appendChild(box)
    }
    log.scrollTop = log.scrollHeight
  }

  function setBusy(on) {
    busy = on
    send.disabled = on
    stop.style.display = on ? '' : 'none'
  }

  function build() {
    panel = make('div', 'position:fixed;right:12px;bottom:12px;z-index:2147483646;width:min(380px,calc(100vw - 24px));max-height:60vh;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:8px;background:#0f172a;color:#e2e8f0;font:12px/1.5 ui-sans-serif,system-ui;box-shadow:0 8px 30px rgba(0,0,0,.35)')
    const head = make('div', 'display:flex;align-items:center;gap:6px')
    title = make('strong', 'flex:1')
    head.appendChild(title)
    fresh = make('button', BTN, 'New chat')
    fresh.title = 'Forget the conversation; the next ask starts a new session'
    // The log stays: its Undo buttons still undo, whichever conversation ran them.
    fresh.onclick = () => { store.set(null); line('New conversation.', 'meta') }
    const term = make('button', BTN, 'Continue in terminal')
    term.title = 'Copy a command that resumes this conversation in a terminal, or, before there is one, this ask for any agent'
    term.onclick = handoff
    const close = make('button', BTN, '×')
    close.title = 'Close (the conversation is kept)'
    close.onclick = () => { panel.style.display = 'none'; shown.set(null) }
    head.append(term, fresh, close)

    list = make('div', 'display:flex;flex-direction:column;gap:4px;max-height:30vh;overflow:auto')
    hint = make('div', 'color:#64748b;font-size:11px')
    log = make('div', 'overflow:auto;flex:1;min-height:0')

    input = make('textarea', 'resize:vertical;min-height:52px;padding:6px;border-radius:4px;border:1px solid #334155;background:#020617;color:#e2e8f0;font:12px/1.4 ui-sans-serif,system-ui')
    input.placeholder = 'What should change? (⌘/Ctrl+Enter sends)'
    input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask() } }

    const row = make('div', 'display:flex;gap:6px;justify-content:flex-end')
    stop = make('button', BTN, 'Stop')
    stop.style.display = 'none'
    stop.onclick = () => post('/__fjs/ask/stop', {}).catch(() => {})
    send = make('button', BTN + ';background:#0369a1;border-color:#0369a1', 'Send')
    send.onclick = ask
    row.append(stop, send)

    panel.append(head, list, hint, log, input, row)
    document.body.appendChild(panel)
    for (const e of entries) {
      if (e.k === 'line') drawLine(e.text, e.tone)
      else if (e.k === 'diff') drawDiff(e.files)
      else if (e.k === 'run') drawEnded(e)
    }
  }

  function show() {
    panel.style.display = 'flex'
    shown.set('1')
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  // One row per pick: where its source is, a glimpse of what it is (two items
  // of one loop share a loc), and the controls for that one element.
  function render() {
    title.textContent = picks.length > 1 ? `Ask Claude to change these ${picks.length}` : picks.length ? 'Ask Claude to change this' : 'Ask Claude'
    list.textContent = ''
    for (const p of picks) {
      const row = make('div', 'display:flex;align-items:center;gap:6px')
      row.dataset.pick = p.loc
      const what = make('div', 'flex:1;min-width:0')
      what.appendChild(make('div', 'font:11px/1.4 ui-monospace,monospace;color:#38bdf8;word-break:break-all', p.loc))
      const text = words(p.el)
      what.appendChild(make('div', 'color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
        `<${p.el.localName}>${text ? ' ' + text.slice(0, 60) : ''}`))
      row.appendChild(what)
      if (text && text.length <= MAX_TEXT) {
        const edit = make('button', BTN, 'Edit text')
        edit.title = 'Change the words in place, without asking Claude when it can'
        edit.onclick = () => editText(p)
        row.appendChild(edit)
      }
      if (p.open) {
        const source = make('button', BTN, 'Open source')
        source.title = 'Open this line in your editor'
        source.onclick = p.open
        row.appendChild(source)
      }
      const drop = make('button', BTN, '×')
      drop.title = 'Leave this element out'
      drop.onclick = () => { picks = picks.filter(x => x !== p); render() }
      row.appendChild(drop)
      list.appendChild(row)
    }
  }

  function open(p) {
    if (!panel) build()
    if (sent || panel.style.display === 'none') { picks = []; sent = false }
    if (!picks.some(x => x.el === p.el)) {
      if (picks.length >= MAX_PICKS) line(`${MAX_PICKS} elements is the most one ask takes`, 'error')
      else picks.push({ el: p.el, loc: p.loc, html: p.el.outerHTML, open: p.open })
    }
    const key = p.key || 'alt'
    hint.textContent = `${key}-click opens the source in your editor · shift+${key}-click asks here, and adds another element before you send`
    render()
    show()
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
      return request(`Change the text "${old}" to exactly: ${next}`, [p])
    }
    diff(r.files)
    ended(r.run, 'done · edited directly, no Claude run')
  }

  async function ask() {
    const instruction = input.value.trim()
    if (!instruction || busy) return
    input.value = ''
    sent = true
    return request(instruction, picks)
  }

  async function request(instruction, list) {
    line(instruction, 'you')
    setBusy(true)
    let run = null
    try {
      const res = await post('/__fjs/ask', {
        instruction,
        picks:   wire(list),
        page:    location.href,
        session: store.get(),
      })
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
          else if (e.type === 'text') line(e.text)
          else if (e.type === 'tool') line('· ' + e.text, 'tool')
          else if (e.type === 'error') line(e.text, 'error')
          else if (e.type === 'diff') diff(e.files)
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

  const wire = list => list.map(p => ({ loc: p.loc, html: p.html.slice(0, HTML_CUT), size: p.html.length }))

  async function handoff() {
    const session = store.get()
    let r
    try {
      r = await post('/__fjs/ask/handoff', session ? { session }
        : { instruction: input.value.trim(), picks: wire(picks), page: location.href }).then(res => res.json())
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
      line(r.command)
    } else {
      line(copied ? `Copied this ask (${r.text.length} chars) — paste it into any agent` : 'Copy this ask into any agent:', 'meta')
      if (!copied) line(r.text)
    }
  }

  async function undoRun(entry, btn) {
    if (entry.undone) return
    btn.disabled = true
    let r
    try {
      r = await post('/__fjs/ask/undo', { run: entry.run }).then(res => res.json())
    } catch (err) {
      btn.disabled = false
      return line(String(err && err.message || err), 'error')
    }
    // The server forgets a run once asked, so an error is as final as a success.
    entry.undone = true
    btn.textContent = 'Undone'
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
      console.log('%c[fli] ask ready — hold shift+alt and click an element to ask Claude to change it', 'color:#38bdf8')
      return
    }
    if (++tries < 50) setTimeout(attach, 100)
  })()
})()
