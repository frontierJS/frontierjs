/**
 * dev-overlay.js — Sierra dev error overlay
 *
 * Injects a custom error overlay in dev mode that shows Sierra runtime errors
 * (module load failures, compilation errors, etc.) in a beautiful panel.
 *
 * Also forwards errors back to the Vite dev server terminal via WS so that
 * coding agents and CLI tooling can process them.
 *
 * The overlay is entirely self-contained — a single <div> injected into body
 * with inline styles so it works regardless of app CSS state.
 */

/**
 * Generate the client-side overlay script as a string.
 * Injected into virtual:sierra in dev mode.
 */
export function generateOverlayScript() {
  return `
// ── Sierra dev error overlay ────────────────────────────────────────────────

if (import.meta.env.DEV && import.meta.hot) {
  let _overlayEl = null

  function sierraShowError({ message, file, stack, type = 'error' }) {
    // Dismiss existing
    if (_overlayEl) _overlayEl.remove()

    const el = document.createElement('div')
    el.id = '__sierra_overlay__'
    el.setAttribute('style', [
      'position:fixed',
      'inset:0',
      'z-index:999999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.75)',
      'backdrop-filter:blur(4px)',
      'font-family:system-ui,sans-serif',
      '-webkit-font-smoothing:antialiased',
    ].join(';'))

    const fileDisplay = file ? file.replace(/^.*[\\/]/, '') : ''
    const stackLines = (stack || '')
      .split('\\n')
      .slice(1, 6)
      .map(l => l.trim())
      .filter(Boolean)
      .join('\\n')

    el.innerHTML = \`
      <div style="
        background:#0f0f18;
        border:1px solid #3a1a1a;
        border-radius:12px;
        padding:28px 32px;
        max-width:680px;
        width:calc(100% - 48px);
        box-shadow:0 24px 64px rgba(0,0,0,0.6);
        position:relative;
      ">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
          <span style="font-size:20px">⛰️</span>
          <span style="
            font-size:11px;
            font-weight:700;
            letter-spacing:0.1em;
            text-transform:uppercase;
            color:#f87171;
          ">Sierra Error</span>
          \${fileDisplay ? \`<span style="
            font-size:11px;
            color:#555;
            font-family:monospace;
            margin-left:auto;
            padding:2px 8px;
            background:#1a1a24;
            border-radius:4px;
          ">\${fileDisplay}</span>\` : ''}
        </div>

        <p style="
          font-size:14px;
          line-height:1.6;
          color:#e2e2e8;
          margin:0 0 16px;
          word-break:break-word;
        ">\${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>

        \${stackLines ? \`<pre style="
          font-size:11px;
          font-family:monospace;
          color:#555;
          line-height:1.7;
          margin:0 0 20px;
          padding:12px 14px;
          background:#0a0a10;
          border-radius:6px;
          overflow:auto;
          max-height:140px;
          white-space:pre-wrap;
          word-break:break-all;
        ">\${stackLines.replace(/</g,'&lt;')}</pre>\` : ''}

        <div style="display:flex;gap:10px">
          <button onclick="this.closest('#__sierra_overlay__').remove()" style="
            padding:8px 18px;
            background:#1a1a24;
            border:1px solid #2a2a3a;
            border-radius:6px;
            color:#9999bb;
            font-size:13px;
            cursor:pointer;
          ">Dismiss</button>
          <button onclick="location.reload()" style="
            padding:8px 18px;
            background:#3a1a1a;
            border:1px solid #f87171;
            border-radius:6px;
            color:#f87171;
            font-size:13px;
            cursor:pointer;
          ">Full reload</button>
          <button onclick="
            const text = [
              \'[Sierra] \' + (this.dataset.type || \'error\'),
              this.dataset.file ? \'File: \' + this.dataset.file : \'\',
              this.dataset.msg,
              this.dataset.stack || \'\'
            ].filter(Boolean).join(\'\\n\');
            navigator.clipboard.writeText(text).then(() => {
              const btn = this;
              btn.textContent = \'Copied!\';
              btn.style.borderColor = \'#34d399\';
              btn.style.color = \'#34d399\';
              setTimeout(() => {
                btn.textContent = \'Copy\';
                btn.style.borderColor = \'#2a2a3a\';
                btn.style.color = \'#9999bb\';
              }, 1500);
            });
          "
          data-type="\${type}"
          data-file="\${file ?? \'\'}"
          data-msg="\${message.replace(/"/g, \'&quot;\').replace(/\\n/g, \'\\\\n\')}"
          data-stack="\${(stack || \'\').replace(/"/g, \'&quot;\').replace(/\\n/g, \'\\\\n\')}"
          style="
            padding:8px 18px;
            background:#1a1a24;
            border:1px solid #2a2a3a;
            border-radius:6px;
            color:#9999bb;
            font-size:13px;
            cursor:pointer;
          ">Copy</button>
        </div>
      </div>
    \`

    document.body.appendChild(el)
    _overlayEl = el

    // Dismiss on backdrop click
    el.addEventListener('click', e => { if (e.target === el) el.remove() })
    // Dismiss on Escape
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', esc) }
    })
  }

  // Listen for sierra:error events from the server or client
  import.meta.hot.on('sierra:error', sierraShowError)

  // Also expose globally so router can call it directly
  window.__sierraError = sierraShowError

  // Forward errors back to the terminal via WS
  window.__sierraReportError = function(data) {
    import.meta.hot.send('sierra:error:client', data)
    sierraShowError(data)
  }
}
`.trim()
}
