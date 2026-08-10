import { useState, useEffect } from "react"

// ─── GOOGLE FONTS ────────────────────────────────────────────────────────────
const fontLink = document.createElement("link")
fontLink.rel = "stylesheet"
fontLink.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap"
document.head.appendChild(fontLink)

// ─── DESIGN TOKENS ───────────────────────────────────────────────────────────
const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --font-ui:  'DM Sans', sans-serif;
    --font-mono:'IBM Plex Mono', monospace;
    --font-head:'Syne', sans-serif;
  }

  /* ── DARK MODE (default) ── */
  :root, [data-theme="dark"] {
    --bg:       #06080d;
    --surface:  #0b0e16;
    --panel:    #0f1320;
    --border:   #181d2c;
    --border2:  #222840;
    --cyan:     #00d4ff;
    --cyan-dim: #00d4ff22;
    --green:    #00e599;
    --red:      #ff4757;
    --amber:    #ffaa00;
    --purple:   #a78bfa;
    --text:     #dde3f0;
    --muted:    #6b7693;
    --dim:      #333c58;
  }

  /* ── LIGHT MODE ── */
  [data-theme="light"] {
    --bg:       #f0f2f7;
    --surface:  #e8eaf2;
    --panel:    #ffffff;
    --border:   #d4d9e8;
    --border2:  #bcc4d8;
    --cyan:     #0099cc;
    --cyan-dim: #0099cc22;
    --green:    #00a86b;
    --red:      #e0303e;
    --amber:    #d4880a;
    --purple:   #7c5cbf;
    --text:     #1a2035;
    --muted:    #4a5470;
    --dim:      #8892aa;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }

  .page-enter { animation: fade-in 0.18s ease forwards; }
  .recharts-tooltip-wrapper { outline: none !important; }
`

const styleEl = document.createElement("style")
styleEl.textContent = css
document.head.appendChild(styleEl)

// ─── THEME STORE ─────────────────────────────────────────────────────────────
let _theme = "dark"
const _themeSubs = new Set()

export const themeStore = {
  get: () => _theme,
  set: (t) => {
    _theme = t
    document.documentElement.setAttribute("data-theme", t)
    _themeSubs.forEach(fn => fn(t))
  },
  sub: (fn) => { _themeSubs.add(fn); return () => _themeSubs.delete(fn) },
}

document.documentElement.setAttribute("data-theme", _theme)

export const useTheme = () => {
  const [theme, setTheme] = useState(themeStore.get())
  useEffect(() => themeStore.sub(setTheme), [])
  return [theme, themeStore.set]
}
