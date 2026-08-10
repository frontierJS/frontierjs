import { useState, useEffect, useRef } from 'react'
import { useTheme } from './tokens.js'
import { STATUS_COLOR, TAG_COLORS, fmt, PLAN_COLOR, ACCOUNT_STATUS_COLOR, SESSION } from './mock.js'

// ─── SHARED COMPONENTS ──────────────────────────────────────────────────────

export const StatusDot = ({ status, size = 7 }) => (
  <span style={{
    display: "inline-block",
    width: size, height: size,
    borderRadius: "50%",
    background: STATUS_COLOR[status] ?? "var(--muted)",
    boxShadow: status === "running" ? `0 0 6px ${STATUS_COLOR.running}`
             : status === "active"  ? `0 0 5px ${STATUS_COLOR.active}`
             : "none",
    animation: (status === "running" || status === "active") ? "pulse-dot 2.4s ease infinite" : "none",
    flexShrink: 0,
  }} />
)

export const StatusPill = ({ status }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "2px 8px", borderRadius: 4,
    background: `${STATUS_COLOR[status]}18`,
    border: `1px solid ${STATUS_COLOR[status]}33`,
    color: STATUS_COLOR[status],
    fontFamily: "var(--font-mono)",
    fontSize: 11, fontWeight: 500,
    textTransform: "lowercase",
  }}>
    <StatusDot status={status} size={6} />
    {status}
  </span>
)

export const Tag = ({ label }) => {
  const [bg, fg] = getTagColor(label)
  return (
    <span style={{
      padding: "1px 7px", borderRadius: 3,
      background: bg, color: fg,
      border: `1px solid ${fg}33`,
      fontSize: 11, fontFamily: "var(--font-mono)",
    }}>{label}</span>
  )
}

export const Mono = ({ children, color, size = 12 }) => (
  <span style={{
    fontFamily: "var(--font-mono)",
    fontSize: size,
    color: color ?? "var(--text)",
    letterSpacing: "0.02em",
  }}>{children}</span>
)

export const SectionHeader = ({ children, action }) => (
  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 20 }}>
    <h2 style={{ fontFamily:"var(--font-head)", fontSize:18, fontWeight:700, color:"var(--text)", letterSpacing:"-0.02em" }}>
      {children}
    </h2>
    {action}
  </div>
)

export const Btn = ({ children, onClick, variant = "default", small }) => {
  const styles = {
    default: { background:"var(--panel)", border:"1px solid var(--border2)", color:"var(--text)" },
    primary: { background:"var(--cyan)", border:"1px solid var(--cyan)", color:"#000", fontWeight:600 },
    ghost:   { background:"transparent", border:"1px solid transparent", color:"var(--muted)" },
    danger:  { background:"var(--red)18", border:"1px solid var(--red)44", color:"var(--red)" },
  }
  return (
    <button onClick={onClick} style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: small ? "4px 10px" : "6px 14px",
      borderRadius: 5, cursor:"pointer",
      fontSize: small ? 11 : 12,
      fontFamily:"var(--font-ui)",
      transition:"all 0.12s",
      ...styles[variant],
    }}
    onMouseEnter={e => { e.currentTarget.style.opacity="0.82" }}
    onMouseLeave={e => { e.currentTarget.style.opacity="1" }}
    >{children}</button>
  )
}

export const Stat = ({ label, value, sub, accent }) => (
  <div style={{
    background:"var(--panel)", border:"1px solid var(--border)",
    borderRadius:8, padding:"18px 22px",
    borderLeft: accent ? `2px solid ${accent}` : "none",
  }}>
    <div style={{ fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:6 }}>{label}</div>
    <div style={{ fontFamily:"var(--font-mono)", fontSize:24, fontWeight:500, color:accent ?? "var(--text)", letterSpacing:"-0.02em" }}>{value}</div>
    {sub && <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>{sub}</div>}
  </div>
)

export const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{
    background:"var(--panel)", border:"1px solid var(--border)",
    borderRadius:8, padding:"16px 20px",
    cursor: onClick ? "pointer" : "default",
    transition:"border-color 0.12s",
    ...style,
  }}
  onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor="var(--border2)" }}
  onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor="var(--border)" }}
  >{children}</div>
)

export const Table = ({ cols, rows, onRowClick }) => (
  <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"hidden" }}>
    <table style={{ width:"100%", borderCollapse:"collapse" }}>
      <thead>
        <tr style={{ borderBottom:"1px solid var(--border)" }}>
          {cols.map(c => (
            <th key={c.key} style={{
              padding:"10px 16px", textAlign:"left",
              fontSize:12, fontWeight:500,
              color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.08em",
              fontFamily:"var(--font-ui)",
            }}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}
            onClick={() => onRowClick?.(row)}
            style={{
              borderBottom: i < rows.length-1 ? "1px solid var(--border)" : "none",
              cursor: onRowClick ? "pointer" : "default",
              transition:"background 0.1s",
            }}
            onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background="var(--surface)" }}
            onMouseLeave={e => { e.currentTarget.style.background="transparent" }}
          >
            {cols.map(c => (
              <td key={c.key} style={{ padding:"11px 16px", verticalAlign:"middle" }}>
                {c.render ? c.render(row) : row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export const Toggle = ({ enabled, onChange, disabled }) => (
  <div onClick={() => !disabled && onChange(!enabled)} style={{
    width:34, height:18, borderRadius:9, cursor: disabled?"not-allowed":"pointer",
    background: enabled ? "var(--green)" : "var(--border2)",
    position:"relative", flexShrink:0, transition:"background 0.18s",
    opacity: disabled ? 0.4 : 1,
  }}>
    <div style={{
      position:"absolute", top:2, left: enabled ? 18 : 2,
      width:14, height:14, borderRadius:"50%",
      background:"#fff", transition:"left 0.18s",
      boxShadow:"0 1px 3px rgba(0,0,0,0.4)",
    }}/>
  </div>
)

// ── Trigger chips ───────────────────────────────────────────────────────────
export const TriggerChips = ({ triggers, enabled, onRun }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
    {triggers.map((t,i) => {
      const isManual = t.kind === "manual"
      const icon  = t.kind==="cron" ? "⏱" : t.kind==="webhook" ? "⚡" : t.kind==="event" ? "◎" : "▶"
      const label = t.kind==="cron" ? t.expression : t.kind==="webhook" ? t.path : t.kind==="event" ? t.eventName : "manual"
      const color = !enabled ? "var(--dim)" : t.kind==="cron" ? "var(--amber)" : t.kind==="webhook" ? "var(--cyan)" : t.kind==="event" ? "var(--purple)" : "var(--green)"
      return (
        <div key={i} style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
          <span style={{
            display:"inline-flex", alignItems:"center", gap:4,
            fontFamily:"var(--font-mono)", fontSize:10,
            color, background:`${color}14`,
            border:`1px solid ${color}33`,
            padding:"1px 6px", borderRadius:3,
            textDecoration: !enabled ? "line-through" : "none",
            opacity: !enabled ? 0.5 : 1,
          }}>
            {icon} {label}
          </span>
          {isManual && onRun && (
            <button
              onClick={e => { e.stopPropagation(); enabled && onRun() }}
              title={enabled ? "Run manually" : "Flow is disabled"}
              style={{
                display:"inline-flex", alignItems:"center", gap:3,
                padding:"1px 7px", borderRadius:3, cursor: enabled ? "pointer" : "not-allowed",
                fontFamily:"var(--font-ui)", fontSize:10, fontWeight:600,
                background: enabled ? "var(--green)20" : "transparent",
                border:`1px solid ${enabled ? "var(--green)55" : "var(--border)"}`,
                color: enabled ? "var(--green)" : "var(--dim)",
                opacity: enabled ? 1 : 0.45,
                transition:"all 0.1s",
              }}
              onMouseEnter={e=>{ if(enabled){ e.currentTarget.style.background="var(--green)35"; e.currentTarget.style.borderColor="var(--green)88" }}}
              onMouseLeave={e=>{ e.currentTarget.style.background=enabled?"var(--green)20":"transparent"; e.currentTarget.style.borderColor=enabled?"var(--green)55":"var(--border)" }}
            >▶ run</button>
          )}
        </div>
      )
    })}
  </div>
)


export const OrionLogo = () => (
  <svg width="24" height="24" viewBox="0 0 22 22" fill="none" style={{ flexShrink:0 }}>
    <circle cx="11" cy="4"  r="2.2" fill="var(--cyan)" />
    <circle cx="4"  cy="17" r="2.2" fill="var(--cyan)" opacity="0.55"/>
    <circle cx="18" cy="17" r="2.2" fill="var(--cyan)" opacity="0.55"/>
    <circle cx="11" cy="11" r="1.6" fill="var(--cyan)" opacity="0.25"/>
    <line x1="11" y1="6.2"  x2="11" y2="9.4"   stroke="var(--cyan)" strokeWidth="0.8" opacity="0.35"/>
    <line x1="11" y1="12.6" x2="5.5"  y2="15.5" stroke="var(--cyan)" strokeWidth="0.8" opacity="0.35"/>
    <line x1="11" y1="12.6" x2="16.5" y2="15.5" stroke="var(--cyan)" strokeWidth="0.8" opacity="0.35"/>
  </svg>
)

export const NAV_PRIMARY = [
  { id:"Flows",      icon:"⬡", label:"Flows"      },
  { id:"Executions", icon:"◎", label:"Executions" },
  { id:"Settings",   icon:"⚙", label:"Settings"   },
]
export const NAV_MORE = [
  { id:"Templates",  icon:"⊞", label:"Templates"  },
  { id:"Plugins",    icon:"⬡", label:"Plugins"    },
  { id:"Metrics",    icon:"⟁", label:"Metrics"    },
]
export const NAV_SA = { id:"System", icon:"⬡", label:"System", danger:true }

export const COLLAPSED_W = 52
const EXPANDED_W  = 200

export const SideNav = ({ tab, setTab, session }) => {
  const [locked,   setLocked]  = useState(false)
  const [hovered,  setHovered] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [theme, setTheme] = useTheme()
  const moreRef = useRef(null)

  const expanded = locked || hovered

  const moreItems = session.isSuperAdmin
    ? [...NAV_MORE, NAV_SA]
    : NAV_MORE

  const moreActive = moreItems.some(i => i.id === tab)

  const NavItem = ({ item, indent=false }) => {
    const active = tab === item.id
    const color  = active
      ? (item.danger ? "var(--red)" : "var(--cyan)")
      : "var(--muted)"
    return (
      <button
        onClick={() => { setTab(item.id); setMoreOpen(false) }}
        title={!expanded ? item.label : undefined}
        style={{
          display:"flex", alignItems:"center", gap:12,
          width:"100%", padding: indent ? "7px 14px 7px 18px" : "9px 14px",
          background: active ? `${item.danger?"var(--red)":"var(--cyan)"}0d` : "none",
          border:"none",
          borderLeft: active
            ? `2px solid ${item.danger?"var(--red)":"var(--cyan)"}`
            : "2px solid transparent",
          cursor:"pointer", textAlign:"left",
          transition:"background 0.1s, border-color 0.1s",
          borderRadius: indent ? 0 : "0 6px 6px 0",
          marginRight: 6,
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--surface)" }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = active ? `${item.danger?"var(--red)":"var(--cyan)"}0d` : "none" }}
      >
        <span style={{ fontSize:14, color, flexShrink:0, width:20, textAlign:"center", lineHeight:1 }}>
          {item.icon}
        </span>
        <span style={{
          fontSize:13, fontWeight: active ? 600 : 400,
          fontFamily:"var(--font-ui)", color,
          whiteSpace:"nowrap", overflow:"hidden",
          opacity: expanded ? 1 : 0,
          transition:"opacity 0.15s",
          letterSpacing:"0.01em",
        }}>
          {item.label}
          {item.danger && (
            <span style={{ marginLeft:6, fontSize:8, fontFamily:"var(--font-mono)",
              color:"var(--red)", background:"var(--red)18",
              padding:"1px 4px", borderRadius:2, verticalAlign:"middle" }}>SA</span>
          )}
        </span>
      </button>
    )
  }

  return (
    <nav
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMoreOpen(false) }}
      style={{
        width: expanded ? EXPANDED_W : COLLAPSED_W,
        minHeight:"100vh", flexShrink:0,
        background:"var(--surface)",
        borderRight:"1px solid var(--border)",
        display:"flex", flexDirection:"column",
        transition:"width 0.2s cubic-bezier(0.4,0,0.2,1)",
        overflow:"hidden",
        position:"sticky", top:0,
        zIndex:100,
      }}
    >
      {/* Logo + lock */}
      <div style={{
        height:56, display:"flex", alignItems:"center",
        padding:"0 14px", gap:10, flexShrink:0,
        borderBottom:"1px solid var(--border)",
        justifyContent: expanded ? "space-between" : "center",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <OrionLogo />
          <span style={{
            fontFamily:"var(--font-head)", fontSize:15, fontWeight:800,
            color:"var(--text)", letterSpacing:"-0.03em",
            whiteSpace:"nowrap",
            maxWidth: expanded ? 100 : 0,
            overflow:"hidden",
            opacity: expanded ? 1 : 0,
            transition:"opacity 0.15s, max-width 0.2s cubic-bezier(0.4,0,0.2,1)",
          }}>Orion</span>
        </div>
        {/* lock pin — only visible when expanded */}
        <button
          onClick={() => setLocked(l => !l)}
          title={locked ? "Unpin sidebar" : "Pin sidebar open"}
          style={{
            background:"none", border:"none", cursor:"pointer",
            color: locked ? "var(--cyan)" : "var(--dim)",
            fontSize:13, padding:"2px 4px", lineHeight:1,
            maxWidth: expanded ? 24 : 0,
            overflow:"hidden",
            opacity: expanded ? 1 : 0,
            transition:"opacity 0.15s, max-width 0.2s cubic-bezier(0.4,0,0.2,1)",
            flexShrink:0,
          }}>
          {locked ? "⊠" : "⊡"}
        </button>
      </div>

      {/* Primary nav items */}
      <div style={{ flex:1, paddingTop:10, display:"flex", flexDirection:"column", gap:2 }}>
        {NAV_PRIMARY.map(item => <NavItem key={item.id} item={item} />)}

        {/* ⋯ More */}
        <div ref={moreRef} style={{ position:"relative", marginTop:4 }}>
          <button
            onClick={() => setMoreOpen(o => !o)}
            title={!expanded ? "More" : undefined}
            style={{
              display:"flex", alignItems:"center", gap:12,
              width:"100%", padding:"9px 14px",
              background: (moreActive || moreOpen) ? "var(--surface)" : "none",
              border:"none",
              borderLeft: moreActive ? "2px solid var(--amber)" : "2px solid transparent",
              cursor:"pointer", textAlign:"left",
              transition:"background 0.1s",
              borderRadius:"0 6px 6px 0", marginRight:6,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--surface)" }}
            onMouseLeave={e => { if (!moreOpen && !moreActive) e.currentTarget.style.background = "none" }}
          >
            <span style={{ fontSize:14, color: moreActive ? "var(--amber)" : "var(--dim)",
              flexShrink:0, width:20, textAlign:"center", lineHeight:1,
              letterSpacing:"0.08em" }}>···</span>
            <span style={{
              fontSize:13, fontFamily:"var(--font-ui)",
              color: moreActive ? "var(--amber)" : "var(--muted)",
              whiteSpace:"nowrap",
              opacity: expanded ? 1 : 0,
              transition:"opacity 0.15s",
            }}>More</span>
          </button>

          {/* More flyout — appears to the right when collapsed, inline when expanded */}
          {moreOpen && (
            <>
              <div style={{ position:"fixed", inset:0, zIndex:149 }} onClick={() => setMoreOpen(false)} />
              <div style={{
                position: expanded ? "relative" : "fixed",
                ...(expanded ? {
                  marginTop:4, marginLeft:6, marginRight:6,
                  background:"var(--bg)",
                  border:"1px solid var(--border2)",
                  borderRadius:8,
                  overflow:"hidden",
                } : {
                  left: COLLAPSED_W + 6,
                  top: moreRef.current
                    ? moreRef.current.getBoundingClientRect().top
                    : 200,
                  background:"var(--panel)",
                  border:"1px solid var(--border2)",
                  borderRadius:8,
                  overflow:"hidden",
                  minWidth:160,
                  boxShadow:"0 8px 32px rgba(0,0,0,0.5)",
                }),
                zIndex:150,
              }}>
                {moreItems.map(item => (
                  <button key={item.id}
                    onClick={() => { setTab(item.id); setMoreOpen(false) }}
                    style={{
                      display:"flex", alignItems:"center", gap:10,
                      width:"100%", padding:"9px 16px",
                      background: tab===item.id ? `${item.danger?"var(--red)":"var(--cyan)"}0d` : "none",
                      border:"none", cursor:"pointer", textAlign:"left",
                      borderLeft: tab===item.id
                        ? `2px solid ${item.danger?"var(--red)":"var(--cyan)"}`
                        : "2px solid transparent",
                      transition:"background 0.1s",
                    }}
                    onMouseEnter={e => { if (tab!==item.id) e.currentTarget.style.background="var(--surface)" }}
                    onMouseLeave={e => { if (tab!==item.id) e.currentTarget.style.background="none" }}
                  >
                    <span style={{ fontSize:14, color: item.danger?"var(--red)":tab===item.id?"var(--cyan)":"var(--muted)", width:18, textAlign:"center" }}>
                      {item.icon}
                    </span>
                    <span style={{ fontSize:13, fontFamily:"var(--font-ui)", whiteSpace:"nowrap",
                      color: item.danger?"var(--red)":tab===item.id?"var(--cyan)":"var(--text)",
                      fontWeight: tab===item.id ? 600 : 400 }}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom — search + user */}
      <div style={{ borderTop:"1px solid var(--border)", paddingTop:8, paddingBottom:10, display:"flex", flexDirection:"column", gap:2 }}>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          style={{
            display:"flex", alignItems:"center", gap:12,
            width:"100%", padding:"9px 14px",
            background:"none", border:"none", cursor:"pointer",
            transition:"background 0.1s",
            borderRadius:"0 6px 6px 0", marginRight:6,
          }}
          onMouseEnter={e => e.currentTarget.style.background="var(--surface)"}
          onMouseLeave={e => e.currentTarget.style.background="none"}
        >
          <span style={{ fontSize:15, color:"var(--dim)", flexShrink:0, width:20, textAlign:"center" }}>
            {theme === "dark" ? "☀" : "☾"}
          </span>
          <span style={{
            fontSize:13, fontFamily:"var(--font-ui)", color:"var(--muted)",
            whiteSpace:"nowrap", opacity: expanded ? 1 : 0, transition:"opacity 0.15s",
          }}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </span>
        </button>

        {/* Search */}
        <button
          onClick={() => { _paletteOpen = false; _paletteListeners.forEach(fn=>fn(true)) }}
          title="Search  ⌘K"
          style={{
            display:"flex", alignItems:"center", gap:12,
            width:"100%", padding:"9px 14px",
            background:"none", border:"none", cursor:"pointer",
            transition:"background 0.1s",
            borderRadius:"0 6px 6px 0", marginRight:6,
          }}
          onMouseEnter={e => e.currentTarget.style.background="var(--surface)"}
          onMouseLeave={e => e.currentTarget.style.background="none"}
        >
          <span style={{ fontSize:14, color:"var(--dim)", flexShrink:0, width:20, textAlign:"center" }}>⌕</span>
          <span style={{
            fontSize:13, fontFamily:"var(--font-ui)", color:"var(--muted)",
            whiteSpace:"nowrap", opacity: expanded ? 1 : 0, transition:"opacity 0.15s",
            display:"flex", alignItems:"center", gap:6, flex:1,
          }}>
            Search
            <kbd style={{ marginLeft:"auto", background:"var(--bg)", border:"1px solid var(--border2)",
              borderRadius:3, padding:"0 4px", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-mono)" }}>⌘K</kbd>
          </span>
        </button>

        {/* User row */}
        <div
          onClick={() => setTab("Profile")}
          title="View profile"
          style={{
            display:"flex", alignItems:"center", gap:10,
            padding:"8px 12px", margin:"4px 6px 0",
            borderRadius:8, cursor:"pointer",
            background: tab === "Profile" ? "var(--cyan)12" : "var(--bg)",
            border:`1px solid ${tab === "Profile" ? "var(--cyan)44" : "var(--border)"}`,
            overflow:"hidden", transition:"background 0.1s, border-color 0.1s",
          }}
          onMouseEnter={e=>{ if(tab!=="Profile"){ e.currentTarget.style.background="var(--surface)"; e.currentTarget.style.borderColor="var(--border2)" }}}
          onMouseLeave={e=>{ if(tab!=="Profile"){ e.currentTarget.style.background="var(--bg)"; e.currentTarget.style.borderColor="var(--border)" }}}
        >
          <div style={{
            width:26, height:26, borderRadius:"50%", flexShrink:0,
            background: session.isSuperAdmin ? "var(--red)22" : "var(--cyan)22",
            border:`1px solid ${session.isSuperAdmin?"var(--red)":"var(--cyan)"}44`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontFamily:"var(--font-mono)", fontSize:12,
            color: session.isSuperAdmin ? "var(--red)" : "var(--cyan)",
          }}>{session.name.charAt(0)}</div>
          <div style={{
            flex:1, minWidth:0,
            opacity: expanded ? 1 : 0,
            transition:"opacity 0.15s",
          }}>
            <div style={{ fontSize:12, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{session.name}</div>
            <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-mono)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{session.email}</div>
          </div>
        </div>
      </div>
    </nav>
  )
}

// ─── FLOWS PAGE ─────────────────────────────────────────────────────────────

// ── Toggle switch ──────────────────────────────────────────────────────────

export const FilterDropdown = ({ label, active, badge, children }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [open])
  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display:"flex", alignItems:"center", gap:6, padding:"5px 11px",
        borderRadius:6, cursor:"pointer", fontFamily:"var(--font-ui)", fontSize:12,
        background: active ? "var(--cyan)15" : "var(--surface)",
        border:`1px solid ${active ? "var(--cyan)55" : "var(--border2)"}`,
        color: active ? "var(--cyan)" : "var(--muted)",
        transition:"all 0.1s", whiteSpace:"nowrap",
      }}>
        {label}
        {badge ? <span style={{ fontSize:10, fontFamily:"var(--font-mono)", background:"var(--cyan)25", color:"var(--cyan)", padding:"0 5px", borderRadius:8, lineHeight:"16px" }}>{badge}</span> : null}
        <span style={{ fontSize:9, opacity:0.6, marginLeft:1 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <>
          <div style={{ position:"fixed", inset:0, zIndex:48 }} onClick={() => setOpen(false)} />
          <div style={{
            position:"absolute", top:"calc(100% + 5px)", left:0, zIndex:49,
            background:"var(--panel)", border:"1px solid var(--border2)",
            borderRadius:8, boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
            padding:"10px 12px", minWidth:180,
            animation:"fadeIn 0.1s ease-out",
          }}>
            {children}
          </div>
        </>
      )}
    </div>
  )
}

// ── Datetime Range Picker ─────────────────────────────────────────────────────
export const DatetimeRangePicker = ({ value, onChange }) => {
  // value: { preset:"24h"|"custom"|etc, from:Date|null, to:Date|null }
  const [open,   setOpen]   = useState(false)
  const [custom, setCustom] = useState({
    from: value.from ? dtLocalVal(value.from) : "",
    to:   value.to   ? dtLocalVal(value.to)   : "",
  })
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [open])

  const applyPreset = (p) => {
    if (p.id === "custom") {
      onChange({ preset:"custom", from: value.from, to: value.to ?? new Date() })
    } else {
      onChange({ preset: p.id, from: new Date(Date.now() - p.ms), to: null })
    }
  }

  const applyCustom = () => {
    const from = custom.from ? new Date(custom.from) : null
    const to   = custom.to   ? new Date(custom.to)   : null
    onChange({ preset:"custom", from, to })
    setOpen(false)
  }

  const active = value.preset !== "all"
  const activePreset = DT_PRESETS.find(p => p.id === value.preset)

  // Build label
  let btnLabel = "Date & Time"
  if (value.preset === "custom" && value.from) {
    btnLabel = `${dtShort(value.from)} → ${value.to ? dtShort(value.to) : "now"}`
  } else if (activePreset && value.preset !== "all") {
    btnLabel = `Last ${activePreset.label}`
  }

  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button onClick={() => setOpen(o=>!o)} style={{
        display:"flex", alignItems:"center", gap:7, padding:"5px 11px",
        borderRadius:6, cursor:"pointer", fontFamily:"var(--font-ui)", fontSize:12,
        background: active ? "var(--cyan)15" : "var(--surface)",
        border:`1px solid ${active ? "var(--cyan)55" : "var(--border2)"}`,
        color: active ? "var(--cyan)" : "var(--muted)",
        transition:"all 0.1s", whiteSpace:"nowrap", maxWidth:260,
        overflow:"hidden", textOverflow:"ellipsis",
      }}>
        <span style={{ fontSize:13, flexShrink:0 }}>⏱</span>
        <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{btnLabel}</span>
        {active && <span onClick={e=>{e.stopPropagation(); onChange({preset:"all",from:null,to:null})}}
          style={{ fontSize:12, color:"var(--cyan)", marginLeft:2, opacity:0.7, flexShrink:0 }}>✕</span>}
        {!active && <span style={{ fontSize:9, opacity:0.5, marginLeft:2 }}>▼</span>}
      </button>

      {open && (
        <>
          <div style={{ position:"fixed", inset:0, zIndex:48 }} onClick={() => setOpen(false)} />
          <div style={{
            position:"absolute", top:"calc(100% + 6px)", left:0, zIndex:49,
            background:"var(--panel)", border:"1px solid var(--border2)",
            borderRadius:10, boxShadow:"0 12px 40px rgba(0,0,0,0.5)",
            padding:0, minWidth:340, overflow:"hidden",
            animation:"fadeIn 0.1s ease-out",
          }}>
            {/* Presets */}
            <div style={{ padding:"12px 14px 10px", borderBottom:"1px solid var(--border)" }}>
              <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em",
                color:"var(--dim)", marginBottom:9, fontFamily:"var(--font-ui)" }}>Quick select</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {DT_PRESETS.filter(p=>p.id!=="custom").map(p => (
                  <button key={p.id} onClick={() => { applyPreset(p); setOpen(false) }} style={{
                    padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11,
                    fontFamily:"var(--font-ui)",
                    background: value.preset===p.id ? "var(--cyan)20" : "var(--surface)",
                    border:`1px solid ${value.preset===p.id ? "var(--cyan)55" : "var(--border2)"}`,
                    color: value.preset===p.id ? "var(--cyan)" : "var(--muted)",
                    transition:"all 0.1s",
                  }}>Last {p.label}</button>
                ))}
              </div>
            </div>

            {/* Custom range */}
            <div style={{ padding:"14px" }}>
              <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em",
                color:"var(--dim)", marginBottom:12, fontFamily:"var(--font-ui)" }}>Custom range</div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:5, fontFamily:"var(--font-ui)" }}>From</div>
                  <input type="datetime-local" value={custom.from}
                    onChange={e => setCustom(c=>({...c, from:e.target.value}))}
                    style={{
                      width:"100%", background:"var(--bg)", border:"1px solid var(--border2)",
                      borderRadius:6, padding:"7px 10px", fontSize:12,
                      color:"var(--text)", outline:"none", fontFamily:"var(--font-mono)",
                      colorScheme:"dark",
                    }}
                    onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                  />
                </div>
                <div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:5, fontFamily:"var(--font-ui)" }}>To</div>
                  <input type="datetime-local" value={custom.to}
                    onChange={e => setCustom(c=>({...c, to:e.target.value}))}
                    style={{
                      width:"100%", background:"var(--bg)", border:"1px solid var(--border2)",
                      borderRadius:6, padding:"7px 10px", fontSize:12,
                      color:"var(--text)", outline:"none", fontFamily:"var(--font-mono)",
                      colorScheme:"dark",
                    }}
                    onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                  />
                </div>
              </div>

              {/* Duration preview */}
              {custom.from && (
                <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-mono)", marginBottom:12 }}>
                  {(() => {
                    const f = new Date(custom.from), t = custom.to ? new Date(custom.to) : new Date()
                    const diff = t - f
                    if (diff <= 0) return <span style={{color:"var(--red)"}}>⚠ "To" must be after "From"</span>
                    const hrs = diff / 3600000
                    const label = hrs < 1 ? `${Math.round(hrs*60)} min window`
                      : hrs < 24 ? `${hrs.toFixed(1)} hr window`
                      : `${(hrs/24).toFixed(1)} day window`
                    return `⟷ ${label} · ${dtShort(f)} → ${dtShort(t)}`
                  })()}
                </div>
              )}

              <div style={{ display:"flex", gap:8 }}>
                <button onClick={applyCustom} style={{
                  flex:1, padding:"7px", borderRadius:6, cursor:"pointer",
                  background:"var(--cyan)", border:"none",
                  color:"var(--bg)", fontSize:12, fontWeight:600, fontFamily:"var(--font-ui)",
                }}>Apply range</button>
                <button onClick={() => { onChange({preset:"all",from:null,to:null}); setCustom({from:"",to:""}); setOpen(false) }}
                  style={{
                    padding:"7px 14px", borderRadius:6, cursor:"pointer",
                    background:"transparent", border:"1px solid var(--border2)",
                    color:"var(--muted)", fontSize:12, fontFamily:"var(--font-ui)",
                  }}>Clear</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}


// ── Plan badge ────────────────────────────────────────────────────────────
export const PlanBadge = ({ plan }) => {
  const [bg, fg] = PLAN_COLOR[plan] ?? ["#ffffff11","#ffffff55"]
  return (
    <span style={{
      padding:"1px 8px", borderRadius:3,
      background:bg, color:fg,
      border:`1px solid ${fg}44`,
      fontSize:12, fontFamily:"var(--font-mono)",
      textTransform:"uppercase", letterSpacing:"0.06em",
    }}>{plan}</span>
  )
}

// ── Account status pill ───────────────────────────────────────────────────
export const AccountStatus = ({ status }) => (
  <span style={{
    display:"inline-flex", alignItems:"center", gap:5,
    padding:"2px 8px", borderRadius:4,
    background:`${ACCOUNT_STATUS_COLOR[status]}18`,
    border:`1px solid ${ACCOUNT_STATUS_COLOR[status]}33`,
    color:ACCOUNT_STATUS_COLOR[status],
    fontFamily:"var(--font-mono)", fontSize:12,
  }}>
    <StatusDot status={status === "active" ? "completed" : status === "suspended" ? "failed" : "pending"} size={6}/>
    {status}
  </span>
)

// ── Mini stat bar ─────────────────────────────────────────────────────────
export const MiniStatBar = ({ value, max, color = "var(--cyan)" }) => (
  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
    <div style={{ width:60, height:4, background:"var(--surface)", borderRadius:2, flexShrink:0 }}>
      <div style={{ height:"100%", width:`${Math.min(100,(value/max)*100)}%`, background:color, borderRadius:2 }} />
    </div>
    <Mono size={11} color="var(--text)">{value.toLocaleString()}</Mono>
  </div>
)


// ─── SETTINGS PAGE ──────────────────────────────────────────────────────────

const PLAN_HAS_WORKSPACES = (plan) => plan === "pro" || plan === "enterprise"

// ── Shared helpers ────────────────────────────────────────────────────────
export const SettingsSection = ({ title, description, children, action }) => (
  <div style={{ marginBottom:32 }}>
    <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
      <div>
        <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", marginBottom:3 }}>{title}</div>
        {description && <div style={{ fontSize:13, color:"var(--muted)" }}>{description}</div>}
      </div>
      {action}
    </div>
    {children}
  </div>
)

export const Divider = () => <div style={{ height:1, background:"var(--border)", margin:"28px 0" }} />

export const InputField = ({ label, value, onChange, placeholder, type="text", disabled, hint, mono }) => (
  <div style={{ marginBottom:14 }}>
    {label && <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase",
      letterSpacing:"0.07em", marginBottom:5, fontFamily:"var(--font-ui)" }}>{label}</label>}
    <input
      type={type} value={value} onChange={onChange ? e=>onChange(e.target.value) : undefined}
      placeholder={placeholder} disabled={disabled}
      style={{
        width:"100%", background: disabled ? "var(--surface)" : "var(--bg)",
        border:"1px solid var(--border2)", borderRadius:5,
        padding:"8px 12px", fontSize:14,
        color: disabled ? "var(--muted)" : "var(--text)",
        outline:"none", fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
        cursor: disabled ? "not-allowed" : "text",
        transition:"border-color 0.12s",
      }}
      onFocus={e=>{ if(!disabled) e.target.style.borderColor="var(--cyan)" }}
      onBlur={e=>{ e.target.style.borderColor="var(--border2)" }}
    />
    {hint && <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>{hint}</div>}
  </div>
)

export const UsageBar = ({ used, limit, label, color="var(--cyan)" }) => {
  const pct = limit === -1 ? 0 : Math.min(100, (used/limit)*100)
  const isUnlimited = limit === -1
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
        <span style={{ fontSize:12, color:"var(--muted)" }}>{label}</span>
        <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color: pct>80?"var(--amber)":"var(--text)" }}>
          {used} {isUnlimited ? <span style={{color:"var(--muted)"}}>/ ∞</span> : `/ ${limit}`}
        </span>
      </div>
      {!isUnlimited && (
        <div style={{ height:4, background:"var(--surface)", borderRadius:2 }}>
          <div style={{ height:"100%", width:`${pct}%`, background: pct>80?"var(--amber)":color, borderRadius:2, transition:"width 0.4s" }} />
        </div>
      )}
    </div>
  )
}

// ── Avatar initials ───────────────────────────────────────────────────────
export const Avatar = ({ name, size=32, color="var(--cyan)" }) => (
  <div style={{
    width:size, height:size, borderRadius:"50%", flexShrink:0,
    background:`${color}22`, border:`1px solid ${color}44`,
    display:"flex", alignItems:"center", justifyContent:"center",
    fontFamily:"var(--font-mono)", fontSize:size*0.38, color, fontWeight:600,
  }}>{name.charAt(0).toUpperCase()}</div>
)

export const ROLE_COLORS = { owner:"var(--amber)", admin:"var(--cyan)", member:"var(--muted)", pending:"var(--dim)" }

// ── Workspace card ────────────────────────────────────────────────────────

// ── Toast system ──────────────────────────────────────────────────────────────
// Module-level pub-sub — no prop drilling, callable from anywhere
const _toastSubs = []
const _toastQueue = []
export let _toastId = 0

export const toast = (msg, opts = {}) => {
  // opts: { type: "success"|"error"|"warning"|"info", duration: ms, detail: string }
  const id = ++_toastId
  const entry = { id, msg, type: opts.type ?? "success", detail: opts.detail ?? null,
                  duration: opts.duration ?? 3200, createdAt: Date.now() }
  _toastQueue.push(entry)
  _toastSubs.forEach(fn => fn([..._toastQueue]))
  setTimeout(() => {
    const idx = _toastQueue.findIndex(t => t.id === id)
    if (idx !== -1) { _toastQueue.splice(idx, 1); _toastSubs.forEach(fn => fn([..._toastQueue])) }
  }, entry.duration)
  return id
}
toast.success = (msg, opts) => toast(msg, { ...opts, type:"success" })
toast.error   = (msg, opts) => toast(msg, { ...opts, type:"error"   })
toast.warning = (msg, opts) => toast(msg, { ...opts, type:"warning" })
toast.info    = (msg, opts) => toast(msg, { ...opts, type:"info"    })

export const useToasts = () => {
  const [toasts, setToasts] = useState([..._toastQueue])
  useEffect(() => {
    _toastSubs.push(setToasts)
    return () => { const i = _toastSubs.indexOf(setToasts); if (i !== -1) _toastSubs.splice(i,1) }
  }, [])
  return toasts
}

const TOAST_CFG = {
  success: { icon:"✓", color:"var(--green)",  bg:"var(--green)12",  border:"var(--green)35" },
  error:   { icon:"✗", color:"var(--red)",    bg:"var(--red)12",    border:"var(--red)35"   },
  warning: { icon:"⚠", color:"var(--amber)",  bg:"var(--amber)12",  border:"var(--amber)35" },
  info:    { icon:"◎", color:"var(--cyan)",   bg:"var(--cyan)12",   border:"var(--cyan)35"  },
}

export const ToastContainer = () => {
  const toasts = useToasts()
  const [exiting, setExiting] = useState({})   // id → true when dismissing

  const dismiss = (id) => {
    setExiting(e => ({...e, [id]:true}))
    setTimeout(() => {
      const idx = _toastQueue.findIndex(t => t.id === id)
      if (idx !== -1) { _toastQueue.splice(idx, 1); _toastSubs.forEach(fn => fn([..._toastQueue])) }
    }, 200)
  }

  if (!toasts.length) return null

  return (
    <div style={{
      position:"fixed", bottom:24, right:24, zIndex:9999,
      display:"flex", flexDirection:"column", gap:8,
      pointerEvents:"none",
    }}>
      <style>{`
        @keyframes toastIn  { from{transform:translateX(110%);opacity:0} to{transform:translateX(0);opacity:1} }
        @keyframes toastOut { from{transform:translateX(0);opacity:1}    to{transform:translateX(110%);opacity:0} }
      `}</style>
      {toasts.map(t => {
        const cfg = TOAST_CFG[t.type] ?? TOAST_CFG.info
        const leaving = exiting[t.id]
        return (
          <div key={t.id} style={{
            pointerEvents:"all",
            display:"flex", alignItems:"flex-start", gap:10,
            background: cfg.bg,
            border:`1px solid ${cfg.border}`,
            borderRadius:8, padding:"10px 14px",
            minWidth:260, maxWidth:360,
            boxShadow:"0 4px 24px rgba(0,0,0,0.4)",
            backdropFilter:"blur(8px)",
            animation: leaving ? "toastOut 0.2s ease-in forwards" : "toastIn 0.22s cubic-bezier(0.34,1.56,0.64,1) forwards",
            cursor:"pointer",
          }} onClick={() => dismiss(t.id)}>
            <span style={{ color:cfg.color, fontSize:14, lineHeight:1.3, flexShrink:0, marginTop:1 }}>{cfg.icon}</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)", lineHeight:1.4, fontWeight:500 }}>
                {t.msg}
              </div>
              {t.detail && (
                <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)",
                  marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {t.detail}
                </div>
              )}
            </div>
            <button onClick={(e)=>{e.stopPropagation();dismiss(t.id)}} style={{
              background:"none", border:"none", cursor:"pointer",
              color:"var(--dim)", fontSize:14, lineHeight:1, padding:0, flexShrink:0,
            }}>×</button>
          </div>
        )
      })}
    </div>
  )
}

// ── ShortcutsModal ────────────────────────────────────────────────────────────

// ── ShortcutsModal ────────────────────────────────────────────────────────────
const _shortcutSubs = []
let _shortcutsOpen  = false
export const useShortcutsModal = () => {
  const [open, setLocal] = useState(_shortcutsOpen)
  useEffect(() => {
    _shortcutSubs.push(setLocal)
    return () => { const i=_shortcutSubs.indexOf(setLocal); if(i>-1)_shortcutSubs.splice(i,1) }
  }, [])
  const setOpen = (v) => { _shortcutsOpen=v; _shortcutSubs.forEach(fn=>fn(v)) }
  return [open, setOpen]
}

export const GLOBAL_SHORTCUTS = [
  { section:"Navigation" },
  { key:"⌘K",          desc:"Open command palette" },
  { key:"?",            desc:"Show this shortcuts reference" },
  { key:"1–6",          desc:"Switch tab (Flows, Templates, Executions…)" },
  { section:"Flows" },
  { key:"⌘S",          desc:"Save flow (in editor)" },
  { key:"⌘Z",          desc:"Undo last change (in editor)" },
  { key:"Tab",          desc:"Switch Linear / DAG / JSON view" },
  { section:"DAG canvas" },
  { key:"Del / ⌫",     desc:"Delete selected node or edge" },
  { key:"Scroll",       desc:"Zoom in/out" },
  { key:"Drag bg",      desc:"Pan canvas" },
  { key:"Drag ●",       desc:"Connect node ports" },
  { key:"⌘0",          desc:"Fit all nodes in view" },
  { key:"Esc",          desc:"Deselect / close picker" },
  { section:"Expressions" },
  { key:"↑ / ↓",       desc:"Navigate autocomplete list" },
  { key:"Enter",        desc:"Accept autocomplete suggestion" },
  { key:"Click pill",   desc:"Cycle Literal → Expr → Template mode" },
  { section:"Execution" },
  { key:"▶ Run",        desc:"Run selected node (Linear view)" },
  { key:"⟲ Replay",    desc:"Replay a completed or failed execution" },
  { key:"⏹ Cancel",    desc:"Cancel a running execution" },
]

export const ShortcutsModal = () => {
  const [open, setOpen] = useShortcutsModal()
  if (!open) return null
  return (
    <div style={{ position:"fixed",inset:0,zIndex:300,background:"rgba(8,10,15,0.85)",
      backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center" }}
      onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}}>
      <div className="page-enter" style={{ background:"var(--panel)",border:"1px solid var(--border2)",
        borderRadius:12,width:560,maxHeight:"80vh",overflow:"hidden",
        boxShadow:"0 24px 64px rgba(0,0,0,0.6)",display:"flex",flexDirection:"column" }}>
        {/* Header */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"18px 22px 14px",borderBottom:"1px solid var(--border)",flexShrink:0 }}>
          <div style={{ fontFamily:"var(--font-head)",fontSize:15,fontWeight:700,color:"var(--text)" }}>
            Keyboard Shortcuts
          </div>
          <div style={{ display:"flex",gap:10,alignItems:"center" }}>
            <Mono size={9} color="var(--dim)">press ? to toggle</Mono>
            <button onClick={()=>setOpen(false)} style={{ background:"none",border:"none",cursor:"pointer",
              color:"var(--muted)",fontSize:18,lineHeight:1,padding:"2px 4px" }}>×</button>
          </div>
        </div>
        {/* Body */}
        <div style={{ overflowY:"auto",padding:"16px 22px 22px",
          display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 24px" }}>
          {GLOBAL_SHORTCUTS.map((item,i) =>
            item.section ? (
              <div key={i} style={{ gridColumn:"1/-1",fontSize:10,color:"var(--cyan)",
                textTransform:"uppercase",letterSpacing:"0.09em",fontFamily:"var(--font-ui)",
                fontWeight:600,marginTop:i>0?14:2,marginBottom:5 }}>
                {item.section}
              </div>
            ) : (
              <div key={i} style={{ display:"flex",alignItems:"center",
                justifyContent:"space-between",marginBottom:6,gap:8 }}>
                <Mono size={10} color="var(--cyan)"
                  style={{ background:"var(--cyan)10",border:"1px solid var(--cyan)22",
                    padding:"1px 7px",borderRadius:4,flexShrink:0 }}>
                  {item.key}
                </Mono>
                <span style={{ fontSize:12,color:"var(--muted)",fontFamily:"var(--font-ui)",textAlign:"right" }}>
                  {item.desc}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ─── COMMAND PALETTE ─────────────────────────────────────────────────────────

// usePalette — shared open/close state via a singleton ref trick
// Components call usePalette() to get [open, setOpen]
const _paletteListeners = []
let _paletteOpen = false
const usePalette = () => {
  const [open, setOpenLocal] = useState(_paletteOpen)
  useEffect(() => {
    _paletteListeners.push(setOpenLocal)
    return () => { const i = _paletteListeners.indexOf(setOpenLocal); if(i>-1) _paletteListeners.splice(i,1) }
  }, [])
  const setOpen = (v) => {
    _paletteOpen = v
    _paletteListeners.forEach(fn => fn(v))
  }
  return [open, setOpen]
}


export const CommandPalette = ({ onNavigate, onEditFlow, onViewExec, session }) => {
  const [open, setOpen]   = usePalette()
  const [query, setQuery] = useState("")
  const [idx,   setIdx]   = useState(0)
  const inputRef = useRef(null)
  const listRef  = useRef(null)

  // ── Build full command list ─────────────────────────────────────────────
  const buildCommands = () => {
    const cmds = []

    // Navigation
    const navItems = [
      { label:"Go to Flows",      icon:"⬡", tab:"Flows",      keywords:"workflows list" },
      { label:"Go to Templates",  icon:"◈", tab:"Templates",  keywords:"templates clone reuse" },
      { label:"Go to Executions", icon:"◎", tab:"Executions", keywords:"runs history logs" },
      { label:"Go to Metrics",    icon:"◈", tab:"Metrics",    keywords:"analytics stats performance" },
      { label:"Go to Settings",   icon:"⊙", tab:"Settings",   keywords:"account members api keys credentials" },
      ...(session.isSuperAdmin ? [{ label:"Go to System", icon:"⚠", tab:"System", keywords:"admin superadmin accounts" }] : []),
    ]
    navItems.forEach(n => cmds.push({ group:"Navigate", icon:n.icon, label:n.label, keywords:n.keywords, run:() => onNavigate(n.tab) }))
    cmds.push({
      group:"Navigate", icon:"＋", label:"Create New Flow",
      keywords:"new flow create blank",
      run:() => {
        const id = `flow_${Date.now().toString(36)}`
        CANVAS_FLOWS[id] = { id, name:"Untitled Flow", version:"1.0.0", description:"", tags:[], nodes:[], edges:[] }
        onEditFlow(id)
      },
    })

    // Flows
    FLOWS.forEach(f => {
      cmds.push({
        group:"Flows",
        icon: resolveNodeType("trigger." + (f._triggers[0]?.kind ?? "manual"))?.icon ?? "⬡",
        label:`Edit — ${f.name}`,
        keywords:`flow canvas nodes ${f.id} ${f.tags?.join(" ") ?? ""}`,
        run:() => onEditFlow(f.id),
      })
      cmds.push({
        group:"Flows",
        icon:"◎",
        label:`Executions — ${f.name}`,
        keywords:`runs history ${f.id}`,
        run:() => onViewExec(f.id),
      })
      if (f._enabled) cmds.push({
        group:"Flows",
        icon:"▶",
        label:`Run — ${f.name}`,
        keywords:`trigger manual ${f.id}`,
        run:() => toast.success("Flow triggered", { detail: `POST /flows/${f.id}/trigger` }),
      })
    })

    // Recent executions
    EXECUTIONS.slice(0,5).forEach(e => {
      const flow = FLOWS.find(f => f.id === e.flowId)
      cmds.push({
        group:"Recent Executions",
        icon: e.status==="completed"?"✓" : e.status==="failed"?"✗" : e.status==="running"?"◉":"○",
        label:`${flow?.name ?? e.flowId} · ${e.executionId}`,
        keywords:`execution run ${e.status} ${e.executionId}`,
        run:() => onViewExec(e.flowId),
      })
    })

    // Settings sections
    const settingsSections = [
      { label:"Account settings",      icon:"⊙", kw:"name plan usage",     section:"account" },
      { label:"Members & roles",        icon:"◎", kw:"invite user role",    section:"members" },
      { label:"Credentials",            icon:"⟨⟩",kw:"secret token oauth",  section:"credentials" },
      { label:"API Keys",               icon:"⌗", kw:"key token auth",      section:"apikeys" },
      { label:"Audit Log",              icon:"⊡", kw:"history changes log", section:"auditlog" },
      { label:"Notification preferences",icon:"◉",kw:"alerts email slack",  section:"notifications" },
      { label:"Billing & plan",         icon:"◈", kw:"subscription invoice",section:"billing" },
    ]
    settingsSections.forEach(s => cmds.push({
      group:"Settings",
      icon:s.icon, label:s.label, keywords:s.kw,
      run:() => { onNavigate("Settings"); setTimeout(()=>{ /* deep-link future */ },50) },
    }))

    // System (superadmin only)
    if (session.isSuperAdmin) {
      [
        { label:"Trigger Registry",  icon:"⚡", kw:"webhook cron event registered", sub:"triggers" },
        { label:"Queue & Health",    icon:"⬡", kw:"queue depth jobs health",        sub:"queue"    },
        { label:"Event Bus",         icon:"◎", kw:"events subscribers emit",        sub:"events"   },
      ].forEach(s => cmds.push({
        group:"System",
        icon:s.icon, label:s.label, keywords:s.kw,
        run:() => onNavigate("System"),
      }))
    }

    return cmds
  }

  // ── All hooks first, no early returns until after ──────────────────────

  // ── Reset index on query change ─────────────────────────────────────────
  useEffect(() => setIdx(0), [query])

  // ── Focus input on open ─────────────────────────────────────────────────
  useEffect(() => {
    if (open) { setQuery(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30) }
  }, [open])

  // ── Scroll active item into view ────────────────────────────────────────
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-pidx="${idx}"]`)
    el?.scrollIntoView({ block:"nearest" })
  }, [idx])

  // ── Global ⌘K / Ctrl+K shortcut ────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey||e.ctrlKey) && e.key==="k") { e.preventDefault(); setOpen(!_paletteOpen) }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // ── Derived state — plain computation, no useMemo needed for ~35 items ──
  const allCmds = open ? buildCommands() : []

  const q = query.trim().toLowerCase()
  const filteredCmds = q
    ? allCmds.filter(c =>
        c.label.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        (c.keywords ?? "").toLowerCase().includes(q))
    : allCmds

  const grouped = (() => {
    const groups = {}
    filteredCmds.forEach(c => { (groups[c.group] ??= []).push(c) })
    const flat = []
    for (const [grp, items] of Object.entries(groups)) {
      flat.push({ type:"header", label:grp })
      items.forEach(item => flat.push({ type:"cmd", ...item }))
    }
    return flat
  })()

  const cmdList = grouped.filter(i => i.type === "cmd")

  // ── Early return after all hooks ────────────────────────────────────────
  if (!open) return null

  const close = () => setOpen(false)
  const runCmd = (cmd) => { close(); setTimeout(() => cmd.run(), 60) }

  const onKey = (e) => {
    if (e.key==="ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i+1, cmdList.length-1)) }
    if (e.key==="ArrowUp")   { e.preventDefault(); setIdx(i => Math.max(i-1, 0)) }
    if (e.key==="Enter")     { e.preventDefault(); if(cmdList[idx]) runCmd(cmdList[idx]) }
    if (e.key==="Escape")    { close() }
  }

  const GROUP_COLORS = {
    Navigate:"var(--cyan)", Flows:"var(--green)", "Recent Executions":"var(--purple)",
    Settings:"var(--muted)", System:"var(--red)",
  }

  return (
    <>
      {/* Backdrop */}
      <div onClick={close} style={{
        position:"fixed", inset:0, zIndex:900,
        background:"rgba(4,6,10,0.72)", backdropFilter:"blur(6px)",
      }} />

      {/* Modal */}
      <div role="dialog" aria-modal="true" aria-label="Command palette" style={{
        position:"fixed", top:"18%", left:"50%", transform:"translateX(-50%)",
        zIndex:901, width:580, maxWidth:"calc(100vw - 32px)",
        background:"var(--panel)", border:"1px solid var(--border2)",
        borderRadius:12, boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
        overflow:"hidden", display:"flex", flexDirection:"column",
        maxHeight:"60vh",
        animation:"fadeUp 0.12s ease both",
      }}>

        {/* Search row */}
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:"1px solid var(--border)" }}>
          <span style={{ fontSize:16, color:"var(--muted)", flexShrink:0, lineHeight:1 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command or search…"
            autoComplete="off"
            spellCheck={false}
            style={{
              flex:1, background:"none", border:"none", outline:"none",
              fontSize:14, color:"var(--text)", fontFamily:"var(--font-ui)",
              caretColor:"var(--cyan)",
            }}
          />
          {query ? (
            <button onClick={()=>{setQuery("");inputRef.current?.focus()}} style={{
              background:"none", border:"none", cursor:"pointer",
              color:"var(--muted)", fontSize:18, lineHeight:1, padding:"0 2px",
            }}>×</button>
          ) : (
            <kbd style={{
              fontFamily:"var(--font-mono)", fontSize:11, color:"var(--dim)",
              background:"var(--surface)", border:"1px solid var(--border2)",
              borderRadius:4, padding:"2px 6px",
            }}>Esc</kbd>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} role="listbox" style={{ overflowY:"auto", flex:1 }}>
          {filteredCmds.length === 0 ? (
            <div style={{ padding:"32px 20px", textAlign:"center", fontSize:13, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>
              No commands match "{query}"
            </div>
          ) : (
            grouped.map((item, fi) => {
              if (item.type === "header") {
                const color = GROUP_COLORS[item.label] ?? "var(--muted)"
                return (
                  <div key={`h-${fi}`} style={{
                    padding:"8px 16px 4px",
                    fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em",
                    color, fontFamily:"var(--font-ui)", fontWeight:600,
                    borderTop: fi > 0 ? "1px solid var(--border)66" : "none",
                    marginTop: fi > 0 ? 4 : 0,
                  }}>{item.label}</div>
                )
              }
              const cmdIdx = cmdList.indexOf(item)
              const active = idx === cmdIdx
              return (
                <div key={`c-${fi}`}
                  data-pidx={cmdIdx}
                  role="option"
                  aria-selected={active}
                  onClick={() => runCmd(item)}
                  onMouseEnter={() => setIdx(cmdIdx)}
                  style={{
                    display:"flex", alignItems:"center", gap:12,
                    padding:"8px 16px", cursor:"pointer",
                    background: active ? "var(--cyan)14" : "transparent",
                    borderLeft: active ? "2px solid var(--cyan)" : "2px solid transparent",
                    transition:"background 0.07s, border-color 0.07s",
                  }}
                >
                  <span style={{
                    width:22, height:22, borderRadius:5, flexShrink:0,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:13,
                    background: active ? "var(--cyan)22" : "var(--surface)",
                    color: active ? "var(--cyan)" : "var(--muted)",
                    border: `1px solid ${active ? "var(--cyan)44" : "var(--border)"}`,
                    transition:"all 0.07s",
                  }}>{item.icon}</span>
                  <span style={{
                    flex:1, fontSize:14, color: active ? "var(--text)" : "var(--text)",
                    fontFamily:"var(--font-ui)", fontWeight: active ? 500 : 400,
                  }}>{item.label}</span>
                  <span style={{
                    fontSize:10, fontFamily:"var(--font-mono)",
                    color: GROUP_COLORS[item.group] ?? "var(--dim)",
                    background: `${GROUP_COLORS[item.group] ?? "var(--border)"}18`,
                    border: `1px solid ${GROUP_COLORS[item.group] ?? "var(--border)"}33`,
                    padding:"1px 6px", borderRadius:3, textTransform:"uppercase", letterSpacing:"0.05em",
                  }}>{item.group}</span>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          display:"flex", alignItems:"center", gap:12, padding:"8px 16px",
          borderTop:"1px solid var(--border)", flexShrink:0,
          background:"var(--bg)",
        }}>
          {[["↑↓","navigate"],["↵","run"],["Esc","close"]].map(([k,l]) => (
            <span key={k} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <kbd style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--text)", background:"var(--surface)", border:"1px solid var(--border2)", borderRadius:4, padding:"1px 5px" }}>{k}</kbd>
              <span style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{l}</span>
            </span>
          ))}
          <span style={{ marginLeft:"auto", fontSize:11, color:"var(--dim)", fontFamily:"var(--font-mono)" }}>
            {cmdList.length} commands
          </span>
        </div>
      </div>
    </>
  )
}