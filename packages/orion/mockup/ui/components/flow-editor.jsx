import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { CANVAS_FLOWS as _CANVAS_FLOWS, FLOWS, EXECUTIONS, now } from './mock.js'
import { Btn, Mono, Toggle, StatusDot, StatusPill, Tag, Card, Table, ToastContainer, toast } from './primitives.jsx'
import { resolveNodeType, allNodeTypes, ENODE_TYPES, EDGE_KIND_COLORS, getNodePreview,
         pluginStore, subflowStore, usePluginList, useSubflowList } from './node-types.js'
import { _NodeConfigBody, NodeInspector, EdgeInspector,
         FlowVariablesPanel, FlowPropertiesPanel, SubflowIOEditor,
         NodeTypePicker as _NodeTypePicker } from './nodes.jsx'
import { flowApi, setApiOnline } from './api.js'

export let CANVAS_FLOWS = {
  "flow_lead_pipeline": {
    id:"flow_lead_pipeline", name:"Lead Pipeline", version:"1.4.2",
    description:"CRM webhook → score + enrich in parallel → notify Slack",
    tags:["crm","ai","leads"],
    nodes:[
      { id:"webhook_in",  type:"trigger.webhook", x:295, y:60,
        config:{ path:{type:"literal",value:"/hooks/crm-new-lead"}, method:{type:"literal",value:"POST"} },
        meta:{ name:"New Lead", description:"Entry point from CRM" } },
      { id:"fetchLead",   type:"http.request",    x:295, y:218,
        config:{ url:{type:"literal",value:"https://api.crm.com/leads/{{$.body.leadId}}"}, method:{type:"literal",value:"GET"} },
        meta:{ name:"Fetch Lead", description:"Retrieve full lead record" } },
      { id:"scoreLead",   type:"ai",              x:80,  y:388,
        config:{ mode:{type:"literal",value:"classify"}, prompt:{type:"literal",value:"Classify this lead as: hot, warm, or cold."} },
        meta:{ name:"Score Lead", description:"AI-powered lead scoring" } },
      { id:"enrichLead",  type:"store",           x:510, y:388,
        config:{ mode:{type:"literal",value:"get"}, key:{type:"literal",value:"enrichment:{{$.fetchLead.domain}}"}, scope:{type:"literal",value:"workspace"} },
        meta:{ name:"Enrich Lead", description:"Lookup enrichment from cache" } },
      { id:"notifySlack", type:"notify.slack",    x:295, y:560,
        config:{ channel:{type:"literal",value:"#leads-pipeline"}, message:{type:"literal",value:"New {{$.scoreLead.label}} lead: {{$.fetchLead.company}}"} },
        meta:{ name:"Notify Slack", description:"Alert the sales team" } },
    ],
    edges:[
      { id:"e1", from:"webhook_in", to:"fetchLead",   kind:"success" },
      { id:"e2", from:"fetchLead",  to:"scoreLead",   kind:"success" },
      { id:"e3", from:"fetchLead",  to:"enrichLead",  kind:"success" },
      { id:"e4", from:"scoreLead",  to:"notifySlack", kind:"success" },
      { id:"e5", from:"enrichLead", to:"notifySlack", kind:"success" },
    ],
  },
}


export const makeBezier = (x1,y1,x2,y2) => {
  const bend = Math.max(Math.abs(y2-y1)*0.5, 50)
  return `M${x1},${y1} C${x1},${y1+bend} ${x2},${y2-bend} ${x2},${y2}`
}


// ── DAGMinimap ────────────────────────────────────────────────────────────────
// ── DAGMinimap ────────────────────────────────────────────────────────────────
export const DAGMinimap = ({ nodes, edges, pan, zoom, canvasW, canvasH, NODE_W, NODE_H, onPan }) => {
  const MM_W = 164, MM_H = 110
  if (!nodes.length) return null

  // World bounds
  const xs = nodes.map(n => n.x ?? 0)
  const ys = nodes.map(n => n.y ?? 0)
  const minX = Math.min(...xs) - 40
  const minY = Math.min(...ys) - 40
  const maxX = Math.max(...xs) + NODE_W + 40
  const maxY = Math.max(...ys) + NODE_H + 40
  const wW   = Math.max(maxX - minX, 400)
  const wH   = Math.max(maxY - minY, 300)
  const sx   = MM_W / wW
  const sy   = MM_H / wH

  const toMM  = (wx, wy) => ({ x:(wx-minX)*sx, y:(wy-minY)*sy })

  // Viewport rect in world coords
  const vpX = (-pan.x) / zoom
  const vpY = (-pan.y) / zoom
  const vpW = canvasW / zoom
  const vpH = canvasH / zoom
  const vp  = { x:(vpX-minX)*sx, y:(vpY-minY)*sy, w:vpW*sx, h:vpH*sy }

  const mmRef = useRef(null)
  const panTo = (e) => {
    const r  = mmRef.current.getBoundingClientRect()
    const mx = (e.clientX - r.left) / MM_W
    const my = (e.clientY - r.top)  / MM_H
    const wx = minX + mx * wW
    const wy = minY + my * wH
    onPan({ x: -wx * zoom + canvasW / 2, y: -wy * zoom + canvasH / 2 })
  }

  return (
    <div ref={mmRef}
      onMouseDown={e=>{e.stopPropagation();panTo(e)}}
      onMouseMove={e=>{if(e.buttons===1){e.stopPropagation();panTo(e)}}}
      style={{
        position:"absolute", bottom:12, left:12, zIndex:20,
        width:MM_W, height:MM_H,
        background:"rgba(8,10,15,0.82)", border:"1px solid var(--border2)",
        borderRadius:7, overflow:"hidden", cursor:"crosshair",
        backdropFilter:"blur(3px)",
        boxShadow:"0 4px 20px rgba(0,0,0,0.5)",
      }}>
      <svg width={MM_W} height={MM_H} style={{ position:"absolute", inset:0 }}>
        {/* Edges */}
        {edges.map(edge => {
          const fn = nodes.find(n=>n.id===edge.from), tn = nodes.find(n=>n.id===edge.to)
          if (!fn||!tn) return null
          const sp = toMM(fn.x+NODE_W/2, fn.y+NODE_H)
          const ep = toMM(tn.x+NODE_W/2, tn.y)
          return <line key={edge.id} x1={sp.x} y1={sp.y} x2={ep.x} y2={ep.y} stroke="#ffffff18" strokeWidth={1} />
        })}
        {/* Nodes */}
        {nodes.map(node => {
          const p  = toMM(node.x ?? 0, node.y ?? 0)
          const nw = NODE_W*sx, nh = NODE_H*sy
          return (
            <rect key={node.id} x={p.x} y={p.y} width={Math.max(nw,4)} height={Math.max(nh,3)}
              rx={1.5} fill="#00d4ff22" stroke="#00d4ff66" strokeWidth={0.5} />
          )
        })}
        {/* Viewport rect */}
        <rect x={vp.x} y={vp.y} width={Math.max(vp.w,8)} height={Math.max(vp.h,6)}
          rx={2} fill="none" stroke="var(--cyan)" strokeWidth={1} strokeOpacity={0.7}
          strokeDasharray="3 2" />
      </svg>
      <div style={{ position:"absolute", bottom:3, right:5, fontSize:8, fontFamily:"var(--font-mono)", color:"var(--dim)", pointerEvents:"none" }}>
        {nodes.length}n · {edges.length}e
      </div>
    </div>
  )
}

// ── NodePalette ────────────────────────────────────────────────────────────
export const PaletteInline = ({ onAdd }) => {
  const [search, setSearch] = useState("")
  usePluginList()
  const _all = allNodeTypes()
  const cats = [...new Set(Object.values(_all).map(t => t.cat))]
  const filtered = Object.entries(_all).filter(([k,v]) =>
    !search || v.label.toLowerCase().includes(search) || k.includes(search)
  )

  // Listen for palette-search events from the parent search input
  useEffect(() => {
    const handler = (e) => {
      const el = document.getElementById("node-palette-search")
      if (el) setSearch(el.dataset.search ?? "")
    }
    window.addEventListener("palette-search", handler)
    return () => window.removeEventListener("palette-search", handler)
  }, [])

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"8px" }}>
      {cats.map(cat => {
        const items = filtered.filter(([,v]) => v.cat === cat)
        if (!items.length) return null
        return (
          <div key={cat} style={{ marginBottom:14 }}>
            <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--dim)", marginBottom:4, paddingLeft:4, fontFamily:"var(--font-ui)" }}>{cat}</div>
            {items.map(([type, nt]) => (
              <div key={type}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData("orion/node-type", type)
                  e.dataTransfer.effectAllowed = "copy"
                  window.__orionDragType = type
                }}
                onDragEnd={() => { window.__orionDragType = null }}
                onClick={() => onAdd(type)}
                style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", borderRadius:6, marginBottom:2, cursor:"grab", border:"1px solid transparent", transition:"background 0.1s, border-color 0.1s", userSelect:"none" }}
                onMouseEnter={e=>{e.currentTarget.style.background="var(--surface)";e.currentTarget.style.borderColor="var(--border)"}}
                onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent"}}
              >
                <span style={{ fontSize:14, color:nt.color, flexShrink:0, width:18, textAlign:"center" }}>{nt.icon}</span>
                <div>
                  <div style={{ fontSize:12, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)" }}>{nt.label}</div>
                  <div style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)" }}>{type}</div>
                </div>
                <span style={{ marginLeft:"auto", fontSize:9, color:"var(--dim)", opacity:0.6 }}>⠿</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

export const NodePalette = ({ onAdd }) => {
  const [search, setSearch] = useState("")
  usePluginList()  // re-render on plugin changes
  const _all = allNodeTypes()
  const cats = [...new Set(Object.values(_all).map(t => t.cat))]
  const filtered = Object.entries(_all).filter(([k,v]) =>
    !search || v.label.toLowerCase().includes(search) || k.includes(search)
  )
  return (
    <div style={{ width:200, borderRight:"1px solid var(--border)", background:"var(--panel)", display:"flex", flexDirection:"column", flexShrink:0 }}>
      <div style={{ padding:"12px 12px 8px", borderBottom:"1px solid var(--border)" }}>
        <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:7, fontFamily:"var(--font-ui)" }}>Nodes</div>
        <input
          value={search} onChange={e => setSearch(e.target.value.toLowerCase())}
          placeholder="Search types…"
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"4px 8px", fontSize:12, color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)" }}
        />
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"8px" }}>
        {cats.map(cat => {
          const items = filtered.filter(([,v]) => v.cat === cat)
          if (!items.length) return null
          return (
            <div key={cat} style={{ marginBottom:14 }}>
              <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--dim)", marginBottom:4, paddingLeft:4, fontFamily:"var(--font-ui)" }}>{cat}</div>
              {items.map(([type, nt]) => (
                <div key={type} onClick={() => onAdd(type)} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", borderRadius:6, marginBottom:2, cursor:"pointer", border:"1px solid transparent", transition:"background 0.1s, border-color 0.1s" }}
                  onMouseEnter={e=>{e.currentTarget.style.background="var(--surface)";e.currentTarget.style.borderColor="var(--border)"}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent"}}
                >
                  <span style={{ fontSize:14, color:nt.color, flexShrink:0, width:18, textAlign:"center" }}>{nt.icon}</span>
                  <div>
                    <div style={{ fontSize:12, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)" }}>{nt.label}</div>
                    <div style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)" }}>{type}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── WebhookTestPanel ─────────────────────────────────────────────────────────
// Self-contained "listen for test request" widget.
// Props: path (string), nodeId (string), sampleData (object|null), onSampleCapture (fn)

const MOCK_WEBHOOK_PAYLOADS = [
  {
    leadId: "lead_7f3k2x", email: "alex@acme.com", company: "Acme Corp",
    source: "website", plan: "pro", createdAt: "2026-03-11T09:14:32Z",
    meta: { ip: "93.184.216.34", userAgent: "Mozilla/5.0" },
  },
  {
    event: "form_submit", userId: "usr_4829xz",
    fields: { name: "Jordan Lee", role: "Engineer", company: "Stripe" },
    submittedAt: "2026-03-11T11:02:07Z", source: "landing_page_v3",
  },
  {
    type: "customer.created",
    data: { id: "cus_9z1p8q", name: "Priya Sharma", email: "priya@startup.io", mrr: 149, trial: false },
    timestamp: 1741689600,
  },
]

// ── LinearEditor ─────────────────────────────────────────────────────────────
// A step-by-step pipeline builder for simple linear flows.
// State is kept as a plain ordered array of slots; caller lifts nodes/edges out.

// FLOW_TRIGGER_TYPES / ACTION_TYPES are now derived at render time via allNodeTypes()
// (kept as helpers for getNodePreview and other static uses)
export const FLOW_TRIGGER_TYPES = () => Object.entries(allNodeTypes()).filter(([k]) => k.startsWith("trigger."))
export const ACTION_TYPES  = () => Object.entries(allNodeTypes()).filter(([k]) => !k.startsWith("trigger."))



// ── NodeTypePicker ───────────────────────────────────────────────────────────
export const NodeTypePicker = ({ onPick, isTrigger }) => {
  usePluginList()  // re-render when plugin registry changes
  const [search, setSearch] = useState("")
  const all   = allNodeTypes()
  const pool  = Object.entries(all).filter(([k]) =>
    isTrigger ? k.startsWith("trigger.") : !k.startsWith("trigger.")
  )
  const filtered = search
    ? pool.filter(([k,v]) => v.label.toLowerCase().includes(search) || k.toLowerCase().includes(search))
    : pool

  // Group by category
  const cats = [...new Set(filtered.map(([,v]) => v.cat))]

  return (
    <div style={{ padding:"20px 24px" }}>
      <div style={{ fontSize:12, color:"var(--muted)", marginBottom:12, fontFamily:"var(--font-ui)" }}>
        {isTrigger ? "Choose a trigger" : "Add a step"}
      </div>
      <input autoFocus value={search} onChange={e=>setSearch(e.target.value.toLowerCase())} placeholder="Search nodes…"
        style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6, padding:"6px 10px", fontSize:13, color:"var(--text)", outline:"none", marginBottom:12, fontFamily:"var(--font-ui)", boxSizing:"border-box" }}
        onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />

      {search ? (
        /* Flat grid when searching */
        filtered.length === 0 ? (
          <div style={{ textAlign:"center", padding:"16px 0", fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>No nodes match "{search}"</div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
            {filtered.map(([type,nt]) => <_NodeTypeCard key={type} type={type} nt={nt} onPick={onPick} />)}
          </div>
        )
      ) : (
        /* Grouped by category */
        cats.map(cat => {
          const items = filtered.filter(([,v]) => v.cat === cat)
          if (!items.length) return null
          const isPlugin = cat === "Plugins" || items.some(([,v]) => v.pluginId)
          return (
            <div key={cat} style={{ marginBottom:18 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:8 }}>
                <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color: isPlugin ? "var(--purple)" : "var(--dim)", fontFamily:"var(--font-ui)", fontWeight:600 }}>{cat}</span>
                {isPlugin && <span style={{ fontSize:8, fontFamily:"var(--font-mono)", color:"var(--purple)88", background:"var(--purple)12", padding:"1px 5px", borderRadius:3, border:"1px solid var(--purple)22" }}>plugin</span>}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
                {items.map(([type,nt]) => <_NodeTypeCard key={type} type={type} nt={nt} onPick={onPick} />)}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

// ── _NodeTypeCard — single tile in NodeTypePicker ─────────────────────────────
export const _NodeTypeCard = ({ type, nt, onPick }) => (
  <button onClick={()=>onPick(type)} style={{
    display:"flex", flexDirection:"column", alignItems:"center", gap:5,
    padding:"12px 8px", borderRadius:7, cursor:"pointer", position:"relative",
    background:"var(--surface)", border:"1px solid var(--border)", transition:"all 0.1s",
  }}
    onMouseEnter={e=>{e.currentTarget.style.borderColor=nt.color;e.currentTarget.style.background=`${nt.color}12`}}
    onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.background="var(--surface)"}}
  >
    {nt.pluginId && (
      <div style={{ position:"absolute", top:5, right:5, width:5, height:5, borderRadius:"50%", background:"var(--purple)" }} title={`From plugin: ${nt.pluginName}`} />
    )}
    <span style={{ fontSize:20, color:nt.color }}>{nt.icon}</span>
    <span style={{ fontSize:11, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)", textAlign:"center", lineHeight:1.2 }}>{nt.label}</span>
    <span style={{ fontSize:8, fontFamily:"var(--font-mono)", color:"var(--dim)", textAlign:"center", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", width:"100%" }}>{type}</span>
  </button>
)

// ── linearToGraph / graphToLinear ─────────────────────────────────────────────
export const linearToGraph = (slots) => {
  const nodes = slots.map(s => ({ id:s.id, type:s.type, config:s.config??{}, meta:s.meta??{}, sampleData:s.sampleData }))
  const edges = []
  for (let i=0; i<slots.length-1; i++) edges.push({ id:`le_${i}`, from:slots[i].id, to:slots[i+1].id, kind:"success" })
  return { nodes, edges }
}
export const graphToLinear = (nodes, edges) => {
  if (!nodes.length) return []
  const outMap={}, inDeg={}
  nodes.forEach(n=>{ outMap[n.id]=[]; inDeg[n.id]=0 })
  edges.forEach(e=>{ outMap[e.from]?.push(e.to); if(inDeg[e.to]!==undefined) inDeg[e.to]++ })
  const roots = nodes.filter(n=>inDeg[n.id]===0)
  if (roots.length!==1) return null
  const chain=[], seen=new Set()
  let cur=roots[0].id
  while(cur){
    if(seen.has(cur)) return null
    seen.add(cur); chain.push(nodes.find(n=>n.id===cur))
    const nexts=outMap[cur]??[]
    if(nexts.length>1) return null
    cur=nexts[0]??null
  }
  if(chain.length!==nodes.length) return null
  return chain.map(n=>({...n}))
}

// ── InputPane — left panel of carousel ───────────────────────────────────────
// Shows upstream sample data, flow vars ($flow.*), and workspace vars ($ws.*)
// as draggable/clickable chips. Three accordion sections.
export const InputPane = ({ upstreamSamples, targetRef, flowVars, workspaceId, onPrev, hasPrev }) => {
  const entries  = Object.entries(upstreamSamples ?? {})
  const wsVars   = ACCOUNT_DATA.workspaces.find(w=>w.id===workspaceId)?.variables ?? []
  const [copied, setCopied] = useState(null)
  // Track which accordions are open
  const [open, setOpen] = useState({ upstream:true, flow:true, ws:true })
  const toggle = (k) => setOpen(o => ({...o, [k]:!o[k]}))

  const insertRef = (raw) => {
    const el = targetRef?.current
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      const s = el.selectionStart ?? el.value.length
      const e = el.selectionEnd ?? s
      const before = el.value.slice(0, s)
      const after  = el.value.slice(e)
      el.value = before + raw + after
      el.selectionStart = el.selectionEnd = s + raw.length
      el.dispatchEvent(new Event("input", { bubbles:true }))
      el.focus()
    } else {
      navigator.clipboard?.writeText(raw)
      setCopied(raw)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  // Reusable chip
  const Chip = ({ label, preview, ref: rawRef, color }) => (
    <div
      draggable
      onDragStart={e => e.dataTransfer.setData("text/plain", rawRef)}
      onClick={() => insertRef(rawRef)}
      style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 7px", marginBottom:3,
        borderRadius:5, cursor:"pointer", userSelect:"none",
        background:"var(--surface)", border:"1px solid var(--border)", transition:"all 0.08s" }}
      onMouseEnter={e=>{e.currentTarget.style.borderColor=`${color}66`;e.currentTarget.style.background=`${color}0a`}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.background="var(--surface)"}}
      title={`Click or drag to insert ${rawRef}`}
    >
      <code style={{ fontFamily:"var(--font-mono)", fontSize:10, color, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</code>
      <span style={{ fontFamily:"var(--font-mono)", fontSize:9, color: copied===rawRef ? "var(--green)" : "var(--dim)", flexShrink:0 }}>
        {copied===rawRef ? "✓ copied" : preview}
      </span>
    </div>
  )

  // Accordion header
  const AccordionHead = ({ label, count, isOpen, onToggle, color }) => (
    <button onClick={onToggle}
      style={{ display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%",
        padding:"6px 0", background:"none", border:"none", cursor:"pointer",
        borderBottom: isOpen ? "1px solid var(--border)" : "none", marginBottom: isOpen ? 7 : 3 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color, letterSpacing:"0.06em" }}>{label}</span>
        {count > 0 && <span style={{ fontSize:9, fontFamily:"var(--font-mono)", padding:"1px 5px", borderRadius:3,
          background:`${color}18`, color, border:`1px solid ${color}33` }}>{count}</span>}
      </div>
      <span style={{ fontSize:10, color:"var(--dim)", transition:"transform 0.15s", display:"inline-block",
        transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span>
    </button>
  )

  return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", background:"var(--bg)", borderRight:"1px solid var(--border)" }}>
      <div style={{ padding:"12px 14px 9px", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Input</div>
          <button
            onClick={onPrev}
            disabled={!hasPrev}
            title={hasPrev ? "Previous node" : "This is the first node"}
            style={{
              display:"flex", alignItems:"center", gap:4,
              padding:"3px 8px", borderRadius:5, cursor: hasPrev ? "pointer" : "default",
              background: hasPrev ? "var(--surface)" : "transparent",
              border: `1px solid ${hasPrev ? "var(--border2)" : "transparent"}`,
              color: hasPrev ? "var(--muted)" : "var(--border2)",
              fontSize:13, lineHeight:1, fontFamily:"var(--font-ui)",
              transition:"all 0.12s", userSelect:"none",
            }}
            onMouseEnter={e=>{ if(hasPrev){ e.currentTarget.style.borderColor="var(--cyan)55"; e.currentTarget.style.color="var(--cyan)"; e.currentTarget.style.background="var(--cyan)0d" } }}
            onMouseLeave={e=>{ if(hasPrev){ e.currentTarget.style.borderColor="var(--border2)"; e.currentTarget.style.color="var(--muted)"; e.currentTarget.style.background="var(--surface)" } }}
          >
            <span style={{ fontSize:11 }}>‹</span>
            <span style={{ fontSize:10, letterSpacing:"0.02em" }}>prev</span>
          </button>
        </div>
        <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:2 }}>Click or drag to insert a reference</div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"10px 12px" }}>

        {/* ── Upstream node outputs ──────────────────────────────────────── */}
        <AccordionHead
          label="$.upstream" count={entries.length} isOpen={open.upstream}
          onToggle={()=>toggle("upstream")} color="var(--cyan)" />
        {open.upstream && (
          entries.length === 0 ? (
            <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.6, paddingBottom:8 }}>
              Pin an upstream node's output to see fields here.
            </div>
          ) : entries.map(([nodeId, data]) => (
            <div key={nodeId} style={{ marginBottom:10 }}>
              <div style={{ fontSize:9, color:"var(--muted)", fontFamily:"var(--font-ui)", textTransform:"uppercase",
                letterSpacing:"0.06em", marginBottom:4 }}>{nodeId}</div>
              {data && typeof data === "object"
                ? Object.entries(data).map(([k, v]) => {
                    const path = `${nodeId}.${k}`
                    const preview = Array.isArray(v) ? `[${v.length}]` : typeof v==="object"&&v ? "{…}" : JSON.stringify(v).slice(0,18)
                    return <Chip key={k} label={`.${k}`} preview={preview} ref={`$.${path}`} color="var(--cyan)" />
                  })
                : <Chip label={`$.${nodeId}`} preview="" ref={`$.${nodeId}`} color="var(--cyan)" />
              }
            </div>
          ))
        )}

        {/* ── Flow variables ─────────────────────────────────────────────── */}
        <div style={{ marginTop:10 }}>
          <AccordionHead
            label="$flow" count={(flowVars??[]).length} isOpen={open.flow}
            onToggle={()=>toggle("flow")} color="var(--green)" />
          {open.flow && (
            (flowVars??[]).length === 0 ? (
              <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.6, paddingBottom:8 }}>
                No flow variables defined. Add them in the <em>Properties → Variables</em> panel.
              </div>
            ) : (flowVars??[]).map(v => {
              const raw  = `$flow.${v.name}`
              const icon = varTypeIcon(v.type)
              const col  = varTypeColor(v.type)
              const preview = v.type==="secret" ? "••••" : (v.defaultValue ? String(v.defaultValue).slice(0,14) : v.type)
              return (
                <Chip key={v.id}
                  label={`${icon} ${v.name}`}
                  preview={preview}
                  ref={raw}
                  color="var(--green)" />
              )
            })
          )}
        </div>

        {/* ── Workspace variables ────────────────────────────────────────── */}
        <div style={{ marginTop:10 }}>
          <AccordionHead
            label="$ws" count={wsVars.length} isOpen={open.ws}
            onToggle={()=>toggle("ws")} color="var(--purple)" />
          {open.ws && (
            wsVars.length === 0 ? (
              <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.6, paddingBottom:8 }}>
                No workspace variables. Add them in <em>Settings → Workspaces</em>.
              </div>
            ) : wsVars.map(v => {
              const raw  = `$ws.${v.name}`
              const icon = varTypeIcon(v.type)
              const preview = v.type==="secret" ? "••••" : (v.defaultValue ? String(v.defaultValue).slice(0,14) : v.type)
              return (
                <Chip key={v.id}
                  label={`${icon} ${v.name}`}
                  preview={preview}
                  ref={raw}
                  color="var(--purple)" />
              )
            })
          )}
        </div>

      </div>
    </div>
  )
}

// ── OutputPane — right panel of carousel ─────────────────────────────────────
export const OutputPane = ({ slot, runResult, onPin, pinFlash, onNext, isLast, lastIsUntyped }) => {
  const pinnedData = slot?.sampleData
  const hasResult  = !!runResult

  return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", background:"var(--bg)", borderLeft:"1px solid var(--border)" }}>
      {/* Header */}
      <div style={{ padding:"14px 16px 10px", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Output</div>
            {hasResult && (
              <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:runResult.error?"var(--red)":"var(--green)" }}>
                {runResult.error ? "✗ error" : `✓ ${runResult.durationMs}ms`}
              </span>
            )}
            {!hasResult && pinnedData && <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--green)" }}>● pinned</span>}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            {hasResult && !runResult.error && runResult.output !== undefined && (
              <button onClick={onPin} style={{
                display:"flex", alignItems:"center", gap:4, padding:"2px 8px", borderRadius:4, cursor:"pointer",
                background: pinFlash ? "var(--green)28" : "var(--green)12",
                border:`1px solid ${pinFlash?"var(--green)":"var(--green)44"}`,
                color: pinFlash ? "var(--green)" : "var(--green)cc",
                fontSize:10, fontFamily:"var(--font-ui)", transition:"all 0.15s",
              }}>{pinFlash ? "✓ Pinned" : "📌 Pin"}</button>
            )}
            {/* Next node arrow */}
            <button
              onClick={onNext}
              title={isLast && !lastIsUntyped ? "Add next node" : "Next node"}
              style={{
                display:"flex", alignItems:"center", gap:4,
                padding:"3px 8px", borderRadius:5, cursor:"pointer",
                background: isLast && !lastIsUntyped ? "var(--cyan)0d" : "var(--surface)",
                border: `1px solid ${isLast && !lastIsUntyped ? "var(--cyan)44" : "var(--border2)"}`,
                color: isLast && !lastIsUntyped ? "var(--cyan)" : "var(--muted)",
                fontSize:13, lineHeight:1, fontFamily:"var(--font-ui)",
                transition:"all 0.12s", userSelect:"none",
              }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor="var(--cyan)55"; e.currentTarget.style.color="var(--cyan)"; e.currentTarget.style.background="var(--cyan)0d" }}
              onMouseLeave={e=>{
                const addMode = isLast && !lastIsUntyped
                e.currentTarget.style.borderColor = addMode ? "var(--cyan)44" : "var(--border2)"
                e.currentTarget.style.color = addMode ? "var(--cyan)" : "var(--muted)"
                e.currentTarget.style.background = addMode ? "var(--cyan)0d" : "var(--surface)"
              }}
            >
              <span style={{ fontSize:10, letterSpacing:"0.02em" }}>{isLast && !lastIsUntyped ? "add" : "next"}</span>
              <span style={{ fontSize:11 }}>›</span>
            </button>
          </div>
        </div>
        {hasResult && runResult.logs?.length > 0 && (
          <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-mono)", marginTop:3 }}>
            {runResult.logs.length} console line{runResult.logs.length!==1?"s":""}
          </div>
        )}
        {pinFlash && (
          <div style={{ fontSize:10, color:"var(--green)", fontFamily:"var(--font-ui)", marginTop:4 }}>
            ✓ Pinned as <code style={{ fontFamily:"var(--font-mono)", fontSize:9 }}>$.{slot?.id}.*</code>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {!hasResult && !pinnedData && (
          <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.7, padding:"16px 14px" }}>
            No output yet.<br/>Press ▶ Run (or <code style={{ fontFamily:"var(--font-mono)", fontSize:10 }}>Ctrl+↵</code>) to execute this step.
          </div>
        )}

        {/* Run result: error */}
        {hasResult && runResult.error && (
          <div style={{ padding:"10px 12px", fontFamily:"var(--font-mono)", fontSize:11, color:"var(--red)", lineHeight:1.6, background:"var(--red)08", margin:"8px", borderRadius:6, border:"1px solid var(--red)22" }}>
            {runResult.error}
          </div>
        )}

        {/* Run result: output */}
        {hasResult && !runResult.error && (
          <div>
            <div style={{ padding:"6px 12px 2px", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.06em" }}>output</div>
            <pre style={{ margin:0, padding:"4px 12px 10px", fontFamily:"var(--font-mono)", fontSize:10.5, color:"var(--green)", lineHeight:1.65, whiteSpace:"pre-wrap", wordBreak:"break-all" }}>
              {runResult.output===undefined?"undefined":JSON.stringify(runResult.output,null,2)}
            </pre>
          </div>
        )}

        {/* Run result: console logs */}
        {hasResult && runResult.logs?.length > 0 && (
          <div style={{ borderTop:"1px solid var(--border)" }}>
            <div style={{ padding:"6px 12px 4px", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.06em" }}>console</div>
            {runResult.logs.map((l,i) => (
              <div key={i} style={{ display:"flex", gap:6, padding:"1px 12px" }}>
                <span style={{ fontSize:9, color:l.lvl==="error"?"var(--red)":l.lvl==="warn"?"var(--amber)":"var(--dim)", flexShrink:0, width:24, textAlign:"right", fontFamily:"var(--font-mono)" }}>
                  {l.lvl==="error"?"ERR":l.lvl==="warn"?"WRN":"LOG"}
                </span>
                <span style={{ fontFamily:"var(--font-mono)", fontSize:10, color:l.lvl==="error"?"var(--red)":l.lvl==="warn"?"var(--amber)":"#94a3b8", lineHeight:1.5, wordBreak:"break-all" }}>{l.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Pinned fallback when no fresh result */}
        {!hasResult && pinnedData && (
          <div>
            <div style={{ padding:"6px 12px 2px", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.06em" }}>pinned output</div>
            <pre style={{ margin:0, padding:"4px 12px", fontFamily:"var(--font-mono)", fontSize:10.5, color:"var(--green)88", lineHeight:1.65, whiteSpace:"pre-wrap", wordBreak:"break-all" }}>
              {JSON.stringify(pinnedData,null,2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ── NotePopover — floating note / metadata overlay ────────────────────────────
export const NotePopover = ({ slot, onMeta, onClose }) => {
  const ref = useRef(null)
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])
  return (
    <div ref={ref} style={{
      position:"absolute", top:40, right:0, zIndex:50, width:260,
      background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:9,
      boxShadow:"0 8px 32px rgba(0,0,0,0.5)", padding:"14px 16px",
    }}>
      <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--muted)", marginBottom:10, fontFamily:"var(--font-ui)" }}>Note & Metadata</div>
      <label style={{ display:"block", fontSize:11, color:"var(--dim)", marginBottom:4, fontFamily:"var(--font-ui)" }}>Note</label>
      <textarea
        autoFocus
        value={slot.meta?.description ?? ""}
        onChange={e => onMeta("description", e.target.value)}
        rows={4} placeholder="What does this step do?"
        style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"7px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", resize:"vertical", outline:"none", boxSizing:"border-box", marginBottom:10 }}
        onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
      <label style={{ display:"block", fontSize:11, color:"var(--dim)", marginBottom:4, fontFamily:"var(--font-ui)" }}>Display Name</label>
      <input value={slot.meta?.name ?? ""} onChange={e=>onMeta("name",e.target.value)}
        style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", outline:"none", boxSizing:"border-box" }}
        onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
      {slot.meta?.description && (
        <div style={{ marginTop:10, padding:"6px 8px", background:"var(--surface)", borderRadius:5, fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.6 }}>
          {slot.meta.description.slice(0,120)}{slot.meta.description.length>120?"…":""}
        </div>
      )}
    </div>
  )
}

// ── SlotCard — the main node card in the carousel ─────────────────────────────
export const SlotCard = ({ slot, index, isFirst, isOnly, isLast, onTypeChange, onCfg, onMeta, onDelete, onMoveUp, onMoveDown, onSample, upstreamSamples, isActive, onClick, onResult, runTrigger, onRun, fullView, onToggleFullView, forcePickOpen }) => {
  const [noteOpen, setNoteOpen] = useState(false)
  const [picking,  setPicking]  = useState(!slot.type)
  const nt = resolveNodeType(slot.type) ?? null

  // When the parent clears the type (e.g. "Change" from rail), open the picker
  useEffect(() => { if (forcePickOpen) setPicking(true) }, [forcePickOpen])
  const codeTextareaRef = useRef(null)

  // For drag-drop into textareas — track the last focused textarea
  const lastFocusRef = useRef(null)
  const handleDrop = (e) => {
    e.preventDefault()
    const text = e.dataTransfer.getData("text/plain")
    if (!text) return
    const el = lastFocusRef.current
    if (!el) return
    const s = el.selectionStart ?? el.value.length
    const en = el.selectionEnd ?? s
    const before = el.value.slice(0,s), after = el.value.slice(en)
    el.value = before + text + after
    el.selectionStart = el.selectionEnd = s + text.length
    el.dispatchEvent(new Event("input", {bubbles:true}))
    el.focus()
  }
  const handleDragOver = (e) => e.preventDefault()

  if (picking) {
    return (
      <div onClick={onClick} style={{ height:"100%", display:"flex", flexDirection:"column", background:"var(--panel)", cursor:"default" }}>
        <NodeTypePicker isTrigger={isFirst} onPick={type=>{onTypeChange(type);setPicking(false)}} />
      </div>
    )
  }

  return (
    <div
      onClick={onClick}
      onDrop={handleDrop} onDragOver={handleDragOver}
      onFocusCapture={e=>{ if(e.target.tagName==="TEXTAREA"||e.target.tagName==="INPUT") lastFocusRef.current=e.target }}
      style={{
        height:"100%", display:"flex", flexDirection:"column",
        background:"var(--panel)",
        outline: isActive ? `2px solid ${nt?.color ?? "var(--cyan)"}44` : "none",
        outlineOffset:-2, transition:"outline 0.12s",
      }}
    >
      {/* Card header */}
      <div style={{
        display:"flex", alignItems:"center", gap:9, padding:"11px 14px",
        borderBottom:"1px solid var(--border)", flexShrink:0,
        background: isActive ? `${nt?.color ?? "var(--cyan)"}08` : "transparent",
      }}>
        {/* Step badge */}
        <div style={{
          width:20, height:20, borderRadius:"50%", flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"center",
          background:`${nt?.color ?? "var(--dim)"}22`, border:`1px solid ${nt?.color ?? "var(--dim)"}44`,
          fontSize:10, fontFamily:"var(--font-mono)", color:nt?.color ?? "var(--muted)",
        }}>{index+1}</div>
        <span style={{ fontSize:15, color:nt?.color ?? "var(--muted)", flexShrink:0 }}>{nt?.icon ?? "○"}</span>
        {/* Name */}
        <input value={slot.meta?.name ?? ""} onChange={e=>{e.stopPropagation();onMeta("name",e.target.value)}} onClick={e=>e.stopPropagation()}
          style={{ flex:1, background:"none", border:"none", outline:"none", fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)", minWidth:0 }} />
        {/* Type badge */}
        {nt && <span style={{ fontSize:9, fontFamily:"var(--font-mono)", letterSpacing:"0.06em", background:`${nt.color}18`, color:nt.color, border:`1px solid ${nt.color}33`, padding:"2px 6px", borderRadius:3, textTransform:"uppercase", flexShrink:0 }}>{nt.label}</span>}
        {/* Reorder */}
        <div style={{ display:"flex", gap:2, flexShrink:0 }} onClick={e=>e.stopPropagation()}>
          {!isFirst && <button onClick={onMoveUp} style={{ background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:12,padding:"1px 3px" }} onMouseEnter={e=>e.currentTarget.style.color="var(--text)"} onMouseLeave={e=>e.currentTarget.style.color="var(--dim)"}>←</button>}
          {!isLast  && <button onClick={onMoveDown} style={{ background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:12,padding:"1px 3px" }} onMouseEnter={e=>e.currentTarget.style.color="var(--text)"} onMouseLeave={e=>e.currentTarget.style.color="var(--dim)"}>→</button>}
          <button onClick={()=>setPicking(true)} title="Change type" style={{ background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:11,padding:"1px 3px" }} onMouseEnter={e=>e.currentTarget.style.color="var(--muted)"} onMouseLeave={e=>e.currentTarget.style.color="var(--dim)"}>⇄</button>
          {/* Note button */}
          <div style={{ position:"relative" }} onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setNoteOpen(v=>!v)} title="Note & metadata"
              style={{
                background: noteOpen||slot.meta?.description ? "var(--cyan)18":"none",
                border: noteOpen||slot.meta?.description ? "1px solid var(--cyan)44":"1px solid transparent",
                cursor:"pointer", color: slot.meta?.description ? "var(--cyan)" : "var(--dim)",
                fontSize:11, padding:"1px 5px", borderRadius:4,
              }}
              onMouseEnter={e=>e.currentTarget.style.color="var(--cyan)"}
              onMouseLeave={e=>e.currentTarget.style.color=slot.meta?.description?"var(--cyan)":"var(--dim)"}
            >✎</button>
            {noteOpen && <NotePopover slot={slot} onMeta={onMeta} onClose={()=>setNoteOpen(false)} />}
          </div>
          {!isOnly && <button onClick={e=>{e.stopPropagation();onDelete()}} style={{ background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:14,lineHeight:1,padding:"1px 3px" }} onMouseEnter={e=>e.currentTarget.style.color="var(--red)"} onMouseLeave={e=>e.currentTarget.style.color="var(--dim)"}>×</button>}
        </div>
        {/* ▶ Run button — always visible, fires the node's test/execution action */}
        {slot.type && <button onClick={e=>{e.stopPropagation();onRun?.()}} style={{
          display:"flex", alignItems:"center", gap:4,
          padding:"3px 10px", borderRadius:5, cursor:"pointer",
          background:"var(--green)12", border:"1px solid var(--green)44",
          color:"var(--green)cc", fontSize:11, fontFamily:"var(--font-ui)",
          fontWeight:500, flexShrink:0, transition:"all 0.1s",
        }}
          onMouseEnter={e=>{e.currentTarget.style.background="var(--green)20";e.currentTarget.style.borderColor="var(--green)";e.currentTarget.style.color="var(--green)"}}
          onMouseLeave={e=>{e.currentTarget.style.background="var(--green)12";e.currentTarget.style.borderColor="var(--green)44";e.currentTarget.style.color="var(--green)cc"}}
        >▶ Run</button>}
        {/* Focus / unfocus: collapse side panes */}
        <button onClick={e=>{e.stopPropagation();onToggleFullView?.()}} title={fullView?"Exit focus mode":"Focus mode — collapse side panes"} style={{
          padding:"3px 8px", borderRadius:5, cursor:"pointer", flexShrink:0,
          background: fullView ? "var(--cyan)18" : "none",
          border: fullView ? "1px solid var(--cyan)55" : "1px solid transparent",
          color: fullView ? "var(--cyan)" : "var(--dim)",
          fontSize:13, lineHeight:1, transition:"all 0.1s",
        }}
          onMouseEnter={e=>{e.currentTarget.style.color="var(--cyan)";e.currentTarget.style.borderColor="var(--cyan)44"}}
          onMouseLeave={e=>{e.currentTarget.style.color=fullView?"var(--cyan)":"var(--dim)";e.currentTarget.style.borderColor=fullView?"var(--cyan)55":"transparent"}}
        >{fullView ? "⊠" : "⊡"}</button>
      </div>

      {/* Config body */}
      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
        <_NodeConfigBody
          type={slot.type}
          config={slot.config}
          onCfg={onCfg}
          upstreamSamples={upstreamSamples}
          onSample={onSample}
          runTrigger={runTrigger}
          onResult={onResult}
          node={slot}
        />
      </div>
    </div>
  )
}

// ── HorizontalConnector — arrow between cards ─────────────────────────────────
export const HorizontalConnector = ({ label }) => (
  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", width:36, flexShrink:0, gap:3 }}>
    <div style={{ width:36, height:1, background:"var(--border2)", position:"relative" }}>
      <div style={{ position:"absolute", right:-1, top:-3, width:0, height:0, borderTop:"4px solid transparent", borderBottom:"4px solid transparent", borderLeft:`6px solid var(--border2)` }}/>
    </div>
    {label && <span style={{ fontSize:8, fontFamily:"var(--font-mono)", color:"var(--dim)", textTransform:"uppercase" }}>{label}</span>}
  </div>
)

// ── AddStepButton ─────────────────────────────────────────────────────────────
export const AddStepButton = ({ onClick }) => (
  <div style={{ display:"flex", alignItems:"center", width:36, flexShrink:0 }}>
    <button onClick={onClick} style={{
      width:28, height:28, borderRadius:"50%", cursor:"pointer",
      background:"var(--surface)", border:"1.5px dashed var(--border2)",
      color:"var(--muted)", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center",
      transition:"all 0.12s", padding:0,
    }}
      onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)66";e.currentTarget.style.color="var(--cyan)";e.currentTarget.style.background="var(--cyan)0a"}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)";e.currentTarget.style.background="var(--surface)"}}
      title="Add step"
    >+</button>
  </div>
)

// ── DragHandle — resizable divider between panes ─────────────────────────────
export const DragHandle = ({ onMouseDown }) => {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width:6, flexShrink:0, cursor:"col-resize",
        background: hover ? "var(--cyan)44" : "var(--border)",
        transition:"background 0.1s",
        position:"relative", zIndex:2,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}
    >
      <div style={{
        display:"flex", flexDirection:"column", gap:3, pointerEvents:"none",
        opacity: hover ? 0.9 : 0.3, transition:"opacity 0.1s",
      }}>
        {[0,1,2,3,4].map(i => (
          <div key={i} style={{ width:2, height:2, borderRadius:"50%", background: hover ? "var(--cyan)" : "var(--muted)" }} />
        ))}
      </div>
    </div>
  )
}

// ── _ThreePane — resizable 3-pane layout for LinearEditor ───────────────────
export const PANE_MIN     = 48    // absolute minimum visible width (px) for side panes
export const PANE_DEFAULT = 220   // starting width for side panes
export const PANE_FOCUS   = 28    // side pane width in focus / full-view mode

export const _ThreePane = ({
  slots, activeIdx, activeSlot, upstreamSamples,
  runResult, pinFlash, onPin,
  onTypeChange, onCfg, onMeta, onDelete, onMoveUp, onMoveDown, onSample,
  onResult, runTrigger, onRun,
  flowVars, workspaceId,
  onPrev, onNext, isFirst, isLast, lastIsUntyped,
  forcePickOpen,
}) => {
  const containerRef = useRef(null)
  const [leftW,    setLeftW]    = useState(PANE_DEFAULT)
  const [rightW,   setRightW]   = useState(PANE_DEFAULT)
  const [fullView, setFullView] = useState(false)
  // Remember sizes before entering full view so we can restore them
  const savedSizes = useRef({ left: PANE_DEFAULT, right: PANE_DEFAULT })
  // Active drag: { side:"left"|"right", startX, startW }
  const drag = useRef(null)

  const toggleFullView = () => {
    if (!fullView) {
      savedSizes.current = { left: leftW, right: rightW }
      setLeftW(PANE_FOCUS); setRightW(PANE_FOCUS)
    } else {
      setLeftW(savedSizes.current.left); setRightW(savedSizes.current.right)
    }
    setFullView(v => !v)
  }

  // Clamp helper: keep side pane between PANE_MIN and 55% of container
  const clamp = (w) => {
    const maxW = containerRef.current
      ? Math.floor(containerRef.current.getBoundingClientRect().width * 0.55)
      : 600
    return Math.max(PANE_MIN, Math.min(maxW, w))
  }

  const onDragHandleDown = (side, e) => {
    if (e.button !== 0) return
    drag.current = { side, startX: e.clientX, startW: side === "left" ? leftW : rightW }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return
      const { side, startX, startW } = drag.current
      const delta = e.clientX - startX
      if (side === "left") {
        // Dragging left divider rightward grows left pane
        const newW = clamp(startW + delta)
        setLeftW(newW)
        if (fullView && newW > PANE_FOCUS + 4) setFullView(false)
      } else {
        // Dragging right divider leftward grows right pane
        const newW = clamp(startW - delta)
        setRightW(newW)
        if (fullView && newW > PANE_FOCUS + 4) setFullView(false)
      }
    }
    const onUp = () => { drag.current = null }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup",   onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, [fullView])

  // ── Drag handle visual ────────────────────────────────────────────────────

  return (
    <div ref={containerRef} style={{ flex:1, display:"flex", overflow:"hidden" }}>

      {/* Left pane */}
      <div style={{ width: leftW, minWidth: PANE_FOCUS, maxWidth: "55%", flexShrink: 0, overflow: "hidden", transition: drag.current ? "none" : "width 0.18s ease" }}>
        {leftW > PANE_FOCUS + 20
          ? <InputPane upstreamSamples={upstreamSamples} targetRef={null} flowVars={flowVars} workspaceId={workspaceId}
              onPrev={onPrev} hasPrev={!isFirst} />
          : <div style={{ height:"100%", background:"var(--bg)", borderRight:"1px solid var(--border)", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ writingMode:"vertical-rl", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", letterSpacing:"0.1em", textTransform:"uppercase", opacity:0.5, userSelect:"none" }}>Input</span>
            </div>
        }
      </div>

      {/* Left drag handle */}
      <DragHandle onMouseDown={e => onDragHandleDown("left", e)} />

      {/* Center pane */}
      <div style={{ flex:1, overflowY:"auto", minWidth: 200, borderLeft:"none", borderRight:"none" }}>
        {activeSlot && (
          <SlotCard
            key={activeSlot.id}
            slot={activeSlot}
            index={activeIdx}
            isFirst={activeIdx===0}
            isLast={activeIdx===slots.length-1}
            isOnly={slots.length===1}
            isActive
            onClick={()=>{}}
            onTypeChange={onTypeChange}
            onCfg={onCfg}
            onMeta={onMeta}
            onDelete={onDelete}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onSample={onSample}
            upstreamSamples={upstreamSamples}
            onResult={onResult}
            runTrigger={runTrigger}
            onRun={onRun}
            fullView={fullView}
            onToggleFullView={toggleFullView}
            forcePickOpen={forcePickOpen}
          />
        )}
      </div>

      {/* Right drag handle */}
      <DragHandle onMouseDown={e => onDragHandleDown("right", e)} />

      {/* Right pane */}
      <div style={{ width: rightW, minWidth: PANE_FOCUS, maxWidth: "55%", flexShrink: 0, overflow: "hidden", transition: drag.current ? "none" : "width 0.18s ease" }}>
        {rightW > PANE_FOCUS + 20
          ? <OutputPane slot={activeSlot} runResult={runResult} onPin={onPin} pinFlash={pinFlash}
              onNext={onNext} hasNext={!isLast || !lastIsUntyped} isLast={isLast} lastIsUntyped={lastIsUntyped} />
          : <div style={{ height:"100%", background:"var(--bg)", borderLeft:"1px solid var(--border)", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ writingMode:"vertical-rl", fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", letterSpacing:"0.1em", textTransform:"uppercase", opacity:0.5, userSelect:"none" }}>Output</span>
            </div>
        }
      </div>
    </div>
  )
}

// ── RailPill — individual pill in the step rail with hover actions + drag ────
// Defined outside LinearEditor so it doesn't remount on every render
export const RailPill = ({ slot, idx, isActive, isDragOver, canDelete, onActivate, onChange, onDelete, onDragStart, onDragEnter, onDragEnd }) => {
  const [hovered, setHovered] = useState(false)
  const nt    = resolveNodeType(slot.type) ?? null
  const color = nt?.color ?? "var(--cyan)"

  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart(idx) }}
      onDragEnter={e => { e.preventDefault(); onDragEnter(idx) }}
      onDragOver={e => e.preventDefault()}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position:"relative", flexShrink:0,
        opacity: isDragOver ? 0.4 : 1,
        transition:"opacity 0.12s",
      }}
    >

      {/* ── Pill: icon + label + slide-out actions ── */}
      <div
        onClick={onActivate}
        style={{
          display:"flex", alignItems:"center", gap:0,
          padding:"4px 6px 4px 8px",
          borderRadius:6, cursor:"grab",
          transition:"background 0.1s, outline 0.1s",
          background: isActive ? `${color}18` : hovered ? `${color}0e` : "transparent",
          outline: isActive ? `1.5px solid ${color}55` : hovered ? `1px solid ${color}33` : "1px solid transparent",
          userSelect:"none",
        }}
      >
        {/* Icon */}
        <span style={{ fontSize:13, color, flexShrink:0, marginRight:5 }}>
          {slot.type ? (nt?.icon ?? "○") : "○"}
        </span>

        {/* Label — always visible */}
        <span style={{
          fontSize:12, fontWeight: isActive ? 600 : 400,
          color: isActive ? "var(--text)" : hovered ? "var(--text)" : "var(--muted)",
          fontFamily:"var(--font-ui)",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          maxWidth:88, flexShrink:0,
        }}>
          {slot.meta?.name || (slot.type ? nt?.label : "…")}
        </span>

        {/* Sample dot */}
        {slot.sampleData && (
          <span style={{ width:5, height:5, borderRadius:"50%", background:"var(--green)", flexShrink:0, marginLeft:4 }}/>
        )}

        {/* Slide-out action buttons — appended after label */}
        <div style={{
          display:"flex", alignItems:"center", gap:3,
          maxWidth: hovered ? 64 : 0,
          overflow:"hidden",
          transition:"max-width 0.15s ease",
          flexShrink:0,
          marginLeft: hovered ? 6 : 0,
        }}>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onChange(idx) }}
            title="Change node type"
            style={{
              display:"flex", alignItems:"center",
              padding:"2px 6px", borderRadius:4, cursor:"pointer",
              background:"var(--cyan)15", border:"1px solid var(--cyan)33",
              color:"var(--cyan)", fontSize:11, fontFamily:"var(--font-ui)",
              whiteSpace:"nowrap", flexShrink:0,
              transition:"background 0.1s",
            }}
            onMouseEnter={e=>e.currentTarget.style.background="var(--cyan)25"}
            onMouseLeave={e=>e.currentTarget.style.background="var(--cyan)15"}
          >⇄</button>

          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); if (canDelete) onDelete(idx) }}
            disabled={!canDelete}
            title={canDelete ? "Remove node" : "Can't remove only node"}
            style={{
              display:"flex", alignItems:"center",
              padding:"2px 5px", borderRadius:4,
              cursor: canDelete ? "pointer" : "not-allowed",
              background: canDelete ? "var(--red)12" : "transparent",
              border:`1px solid ${canDelete ? "var(--red)33" : "transparent"}`,
              color: canDelete ? "var(--red)" : "var(--dim)",
              fontSize:14, lineHeight:1,
              whiteSpace:"nowrap", flexShrink:0,
              transition:"background 0.1s",
              opacity: canDelete ? 1 : 0.3,
            }}
            onMouseEnter={e=>{ if(canDelete) e.currentTarget.style.background="var(--red)22" }}
            onMouseLeave={e=>{ if(canDelete) e.currentTarget.style.background="var(--red)12" }}
          >×</button>
        </div>
      </div>
    </div>
  )
}

// ── LinearEditor ──────────────────────────────────────────────────────────────
export const LinearEditor = ({ nodes, edges, onChange, flowVars, workspaceId }) => {
  const initSlots = () => {
    if (nodes.length===0) return [{ id:`trigger_${Date.now().toString(36)}`, type:null, config:{}, meta:{name:"Trigger"} }]
    const linear = graphToLinear(nodes, edges)
    return linear ?? nodes.map(n=>({...n}))
  }

  const [slots,    setSlots]    = useState(initSlots)
  const [activeIdx,setActiveIdx]= useState(0)
  const [runResult,setRunResult]= useState(null)
  const [pinFlash, setPinFlash] = useState(false)
  const [runTrigger,setRunTrigger]= useState(0)
  const [changingIdx, setChangingIdx] = useState(null)

  const isLinear = graphToLinear(nodes, edges) !== null || nodes.length === 0

  useEffect(() => {
    const { nodes:ns, edges:es } = linearToGraph(slots.filter(s=>s.type))
    onChange(ns, es)
  }, [slots])

  const updateSlot = (idx, patch) => setSlots(ss => ss.map((s,i)=>i===idx?{...s,...patch}:s))
  const addSlot    = () => { const idx=slots.length; setSlots(ss=>[...ss,{id:`step_${Date.now().toString(36)}`,type:null,config:{},meta:{name:"New Step"}}]); setActive(idx) }
  const deleteSlot = (idx) => { setSlots(ss=>ss.filter((_,i)=>i!==idx)); setActiveIdx(Math.max(0,idx-1)); setRunResult(null) }
  const changeSlot = (idx) => {
    updateSlot(idx, { type:null, config:{}, meta:{ name: slots[idx].meta?.name ?? "Step" } })
    setActive(idx)
    setChangingIdx(idx)
    // clear the flag next tick so the useEffect in SlotCard only fires once
    setTimeout(() => setChangingIdx(null), 50)
  }

  // Reset run result when slide changes
  const setActive = (idx) => { setActiveIdx(idx); setRunResult(null); setRunTrigger(0) }

  const pinOutput = () => {
    if (!runResult?.output) return
    updateSlot(activeIdx, { sampleData: runResult.output })
    setPinFlash(true); setTimeout(() => setPinFlash(false), 2200)
  }
  const moveSlot   = (idx,dir) => { const ni=idx+dir; setSlots(ss=>{const n=[...ss];[n[idx],n[ni]]=[n[ni],n[idx]];return n}); setActive(ni) }

  if (!isLinear) {
    return (
      <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ textAlign:"center", maxWidth:340 }}>
          <div style={{ fontSize:28, marginBottom:12, opacity:0.3 }}>⬡</div>
          <div style={{ fontSize:14, color:"var(--text)", marginBottom:6, fontFamily:"var(--font-ui)", fontWeight:500 }}>This flow has branching or parallel paths</div>
          <div style={{ fontSize:13, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.7 }}>Linear view only works for straight pipelines. Switch to DAG view to edit this flow.</div>
        </div>
      </div>
    )
  }

  const activeSlot = slots[activeIdx] ?? slots[0]
  const upstreamSamples = Object.fromEntries(slots.slice(0,activeIdx).filter(s=>s.sampleData).map(s=>[s.id,s.sampleData]))

  // Drag-to-reorder state
  const dragFrom = useRef(null)
  const [dragOver, setDragOver] = useState(null)

  const handleDragStart = (idx) => { dragFrom.current = idx }
  const handleDragEnter = (idx) => { if (dragFrom.current !== null && idx !== dragFrom.current) setDragOver(idx) }
  const handleDragEnd   = () => {
    if (dragFrom.current !== null && dragOver !== null && dragFrom.current !== dragOver) {
      const from = dragFrom.current, to = dragOver
      setSlots(ss => {
        const next = [...ss]
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        return next
      })
      setActive(to)
    }
    dragFrom.current = null
    setDragOver(null)
  }

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

      {/* ── Step rail (top strip) ── */}
      {/* outer wrapper: fixed height, clips horizontal scroll but NOT vertical (for popup) */}
      <div style={{
        flexShrink:0,
        borderBottom:"1px solid var(--border)", background:"var(--panel)",
        position:"relative",
      }}>
        <div style={{
          display:"flex", alignItems:"center", gap:0,
          padding:"0 20px", height:52,
          overflowX:"auto", overflowY:"visible",
        }}>
          {slots.map((slot, idx) => (
            <div key={slot.id} style={{ display:"flex", alignItems:"center", flexShrink:0 }}>
              <RailPill
                slot={slot}
                idx={idx}
                isActive={idx === activeIdx}
                isDragOver={dragOver === idx}
                canDelete={slots.length > 1}
                onActivate={() => setActive(idx)}
                onChange={i => changeSlot(i)}
                onDelete={i => deleteSlot(i)}
                onDragStart={handleDragStart}
                onDragEnter={handleDragEnter}
                onDragEnd={handleDragEnd}
              />
              {idx < slots.length - 1 && (
                <div style={{ width:20, height:1, background: dragOver === idx+1 || dragOver === idx ? "var(--cyan)55" : "var(--border2)", position:"relative", flexShrink:0, transition:"background 0.1s" }}>
                  <div style={{ position:"absolute", right:-1, top:-3, width:0, height:0, borderTop:"4px solid transparent", borderBottom:"4px solid transparent", borderLeft:`6px solid ${dragOver === idx+1 || dragOver === idx ? "var(--cyan)55" : "var(--border2)"}` }}/>
                </div>
              )}
            </div>
          ))}
          {/* Add step */}
          {slots[slots.length-1]?.type && (
            <div style={{ display:"flex", alignItems:"center", flexShrink:0 }}>
              <div style={{ width:20, height:1, background:"var(--border2)", flexShrink:0 }}/>
              <button onClick={addSlot} style={{
                width:26, height:26, borderRadius:"50%", cursor:"pointer", flexShrink:0,
                background:"transparent", border:"1.5px dashed var(--border2)",
                color:"var(--muted)", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center",
                transition:"all 0.12s",
              }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)66";e.currentTarget.style.color="var(--cyan)"}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}
              >+</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Empty state: no steps yet ── */}
      {slots.length === 0 && (
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ textAlign:"center", maxWidth:360 }}>
            <div style={{ fontSize:40, marginBottom:12, opacity:0.15 }}>⬡</div>
            <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-head)", marginBottom:6 }}>
              Start with a trigger
            </div>
            <div style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.8, marginBottom:20 }}>
              Every flow begins with a trigger — a webhook, cron schedule, event, or manual call.<br/>
              Click <strong style={{ color:"var(--cyan)" }}>+ Add step</strong> in the rail above, or pick one below.
            </div>
            <div style={{ display:"flex", justifyContent:"center", gap:8, flexWrap:"wrap" }}>
              {[
                { icon:"⚡", label:"Webhook",  type:"trigger.webhook" },
                { icon:"⏰", label:"Schedule", type:"trigger.cron"    },
                { icon:"◎",  label:"Event",    type:"trigger.event"   },
                { icon:"▶",  label:"Manual",   type:"trigger.manual"  },
              ].map(t => (
                <button key={t.type}
                  onClick={() => {
                    const id = `${t.type.replace(".","_")}_${Date.now().toString(36)}`
                    setSlots([{ id, type:t.type, config:{}, meta:{ name:t.label }, isTrigger:true }])
                    setActive(0)
                  }}
                  style={{ padding:"7px 14px", borderRadius:7, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)",
                    background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text)",
                    display:"flex", alignItems:"center", gap:6, transition:"all 0.1s" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)"}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--text)"}}>
                  <span>{t.icon}</span>{t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 3-pane carousel body (draggable dividers) ── */}
      {slots.length > 0 && <_ThreePane
        slots={slots} activeIdx={activeIdx} activeSlot={activeSlot}
        upstreamSamples={upstreamSamples}
        runResult={runResult} pinFlash={pinFlash}
        onPin={pinOutput}
        onTypeChange={type=>updateSlot(activeIdx,{type,meta:{name:resolveNodeType(type)?.label??type}})}
        onCfg={(k,v)=>updateSlot(activeIdx,{config:{...activeSlot.config,[k]:v}})}
        onMeta={(k,v)=>updateSlot(activeIdx,{meta:{...(activeSlot.meta??{}),[k]:v}})}
        onDelete={()=>deleteSlot(activeIdx)}
        onMoveUp={()=>moveSlot(activeIdx,-1)}
        onMoveDown={()=>moveSlot(activeIdx,1)}
        onSample={(data)=>updateSlot(activeIdx,{sampleData:data})}
        onResult={setRunResult}
        runTrigger={runTrigger}
        onRun={()=>setRunTrigger(t=>t+1)}
        flowVars={flowVars}
        workspaceId={workspaceId}
        isFirst={activeIdx === 0}
        isLast={activeIdx === slots.length - 1}
        lastIsUntyped={!slots[slots.length - 1]?.type}
        forcePickOpen={changingIdx === activeIdx}
        onPrev={() => activeIdx > 0 && setActive(activeIdx - 1)}
        onNext={() => {
          if (activeIdx < slots.length - 1) {
            setActive(activeIdx + 1)
          } else {
            addSlot()
          }
        }}
      />}
    </div>
  )
}

// ── FlowRunsPanel ─────────────────────────────────────────────────────────────
// Slide-in panel showing recent executions for the current flow
export const FlowRunsPanel = ({ flowId, onClose, onDrilldown }) => {
  const [search, setSearch] = useState("")
  const flow = FLOWS.find(f => f.id === flowId)

  const execs = EXECUTIONS
    .filter(e => e.flowId === flowId)
    .filter(e => !search || e.id.includes(search) || e.status.includes(search) ||
      (e.trigger?.type ?? "").includes(search))
    .sort((a,b) => b.startedAt - a.startedAt)
    .slice(0, 40)

  const all   = EXECUTIONS.filter(e => e.flowId === flowId)
  const ok    = all.filter(e => e.status === "completed").length
  const fail  = all.filter(e => e.status === "failed").length
  const avgMs = all.length ? Math.round(all.reduce((s,e)=>s+(e.durationMs??0),0)/all.length) : 0

  const TRIG_COLOR = { webhook:"var(--cyan)", cron:"var(--purple)", event:"var(--amber)", manual:"var(--muted)", replay:"var(--green)" }
  const trigColor  = (t) => TRIG_COLOR[t] ?? "var(--dim)"

  return (
    <div style={{
      position:"absolute", top:0, right:0, bottom:0, width:340,
      background:"var(--panel)", borderLeft:"1px solid var(--border)",
      display:"flex", flexDirection:"column", zIndex:20,
      boxShadow:"-8px 0 32px rgba(0,0,0,0.35)",
      animation:"slideInRight 0.18s ease-out",
    }}>
      <style>{`@keyframes slideInRight{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`}</style>

      {/* Header */}
      <div style={{ padding:"12px 14px", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
          <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-head)", flex:1 }}>
            ⏱ Run History
          </div>
          <Mono size={9} color="var(--dim)">{flow?.name}</Mono>
          <button onClick={onClose} style={{
            background:"none", border:"none", cursor:"pointer",
            color:"var(--muted)", fontSize:16, lineHeight:1, padding:"0 2px",
            transition:"color 0.1s",
          }} onMouseEnter={e=>e.currentTarget.style.color="var(--text)"}
             onMouseLeave={e=>e.currentTarget.style.color="var(--muted)"}>×</button>
        </div>

        {/* Mini stats */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
          {[
            { label:"Total",  value:all.length,           color:"var(--text)"   },
            { label:"OK",     value:`${ok} (${all.length?Math.round(ok/all.length*100):0}%)`, color:"var(--green)" },
            { label:"Failed", value:String(fail),         color: fail>0?"var(--red)":"var(--muted)" },
          ].map(s => (
            <div key={s.label} style={{ background:"var(--surface)", borderRadius:6, padding:"6px 8px",
              border:"1px solid var(--border)" }}>
              <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", marginBottom:3,
                textTransform:"uppercase", letterSpacing:"0.06em" }}>{s.label}</div>
              <div style={{ fontSize:14, fontWeight:700, color:s.color, fontFamily:"var(--font-head)" }}>{s.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>
            avg <span style={{ color:"var(--amber)", fontFamily:"var(--font-mono)" }}>{fmt.duration(avgMs)}</span>
          </div>
          <div style={{ flex:1 }} />
          {/* Search */}
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Filter runs…"
            style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"4px 8px", fontSize:11, color:"var(--text)", fontFamily:"var(--font-ui)",
              outline:"none", width:130 }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)55"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </div>
      </div>

      {/* List */}
      <div style={{ flex:1, overflow:"auto" }}>
        {execs.length === 0 ? (
          <div style={{ padding:24, textAlign:"center" }}>
            <div style={{ fontSize:24, opacity:0.15, marginBottom:8 }}>◎</div>
            <div style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>No runs match</div>
          </div>
        ) : execs.map((ex, i) => {
          const isRunning = ex.status === "running"
          const isFailed  = ex.status === "failed"
          const dotStatus = ex.status === "completed" ? "active" : ex.status === "failed" ? "error" :
            ex.status === "running" ? "warning" : "inactive"
          const tc = trigColor(ex.trigger?.type)
          const ago = fmt.time(Date.now() - ex.startedAt)

          return (
            <div key={ex.id}
              onClick={() => onDrilldown(ex)}
              style={{
                padding:"10px 14px",
                borderBottom:"1px solid var(--border)",
                cursor:"pointer",
                transition:"background 0.1s",
                display:"flex", alignItems:"center", gap:10,
              }}
              onMouseEnter={e=>e.currentTarget.style.background="var(--surface)"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            >
              <StatusDot status={dotStatus} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                  <Mono size={10}>{ex.id}</Mono>
                  {ex.replayOf && <span style={{ fontSize:9, color:"var(--green)", fontFamily:"var(--font-ui)",
                    background:"var(--green)12", border:"1px solid var(--green)30",
                    padding:"0px 4px", borderRadius:3 }}>replay</span>}
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:tc }}>
                    {ex.trigger?.type ?? "manual"}
                    {ex.trigger?.path ? ` ${ex.trigger.path}` : ""}
                  </span>
                  <Mono size={9} color="var(--dim)">{ago}</Mono>
                </div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:11, fontFamily:"var(--font-mono)",
                  color: isFailed ? "var(--red)" : isRunning ? "var(--amber)" : "var(--muted)" }}>
                  {isRunning ? "running" : fmt.duration(ex.durationMs ?? 0)}
                </div>
                <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:2 }}>
                  {ex.status}
                </div>
              </div>
              <div style={{ color:"var(--border2)", fontSize:13, flexShrink:0 }}>›</div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{ padding:"8px 14px", borderTop:"1px solid var(--border)", flexShrink:0 }}>
        <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", textAlign:"center" }}>
          Showing {execs.length} of {all.length} runs · Full history in{" "}
          <span style={{ color:"var(--cyan)", cursor:"pointer" }} onClick={onClose}>Executions tab</span>
        </div>
      </div>
    </div>
  )
}

// ── FlowEditor ─────────────────────────────────────────────────────────────
export const FlowEditor = ({ flowId, onBack }) => {
  const fd = CANVAS_FLOWS[flowId] ?? { id:flowId, name:"New Flow", version:"1.0.0", description:"", nodes:[], edges:[] }

  const [nodes,    setNodes]    = useState(fd.nodes)
  const [edges,    setEdges]    = useState(fd.edges)
  const [flowName, setFlowName] = useState(fd.name)
  const [flowDesc, setFlowDesc] = useState(fd.description ?? "")
  const [flowVars, setFlowVars] = useState(fd.variables ?? [])
  const [subflow,  setSubflow]  = useState(fd.subflow   ?? null)
  const [editorLoading, setEditorLoading] = useState(false)
  const [zoom,     setZoom]     = useState(1)
  const [pan,      setPan]      = useState({ x:60, y:60 })
  const [selNode,  setSelNode]  = useState(null)
  const [selEdge,  setSelEdge]  = useState(null)
  const [dragging, setDragging] = useState(null)
  const [panning,  setPanning]  = useState(null)
  const [conn,     setConn]     = useState(null)
  const [mouse,    setMouse]    = useState({x:0,y:0})
  const [hoverIn,  setHoverIn]  = useState(null)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [changingNodeId, setChangingNodeId] = useState(null)
  const [saveFlash,   setSaveFlash]   = useState(false)
  const isNewFlow = fd.nodes.length === 0
  const [viewMode,    setViewMode]    = useState(isNewFlow ? "linear" : "dag")
  const [jsonText,    setJsonText]    = useState("")
  const [copied,      setCopied]      = useState(null)
  const [jsonError,   setJsonError]   = useState(null)
  const [jsonApplied, setJsonApplied] = useState(false)
  const [showRuns,    setShowRuns]    = useState(false)
  const [runsExec,    setRunsExec]    = useState(null)
  const [rightTab,    setRightTab]    = useState("nodes")
  const [selNodes,    setSelNodes]    = useState(new Set())
  const [boxSel,      setBoxSel]      = useState(null)
  const [dragOver,    setDragOver]    = useState(false)
  const [clipboard,   setClipboard]   = useState(null)

  // Load full flow definition from API — fall back to local cache silently
  useEffect(() => {
    if (!flowId) return
    setEditorLoading(true)
    flowApi.get(flowId)
      .then(data => {
        const flow = data.flow ?? data
        // Update local cache
        CANVAS_FLOWS[flowId] = flow
        // Hydrate editor state — only if editor hasn't been touched yet
        setNodes(flow.nodes ? Object.values(flow.nodes) : [])
        setEdges(flow.edges ?? [])
        setFlowName(flow.name ?? "")
        setFlowDesc(flow.description ?? "")
        setFlowVars(flow.variables ? Object.entries(flow.variables).map(([k,v]) => ({ id:k, name:k, ...v })) : [])
        setApiOnline(true)
      })
      .catch(() => setApiOnline(false))
      .finally(() => setEditorLoading(false))
  }, [flowId])
  const ref      = useRef(null)
  const nodesRef = useRef(nodes)
  const [canvasSize, setCanvasSize] = useState({ w:1200, h:800 })
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setCanvasSize({ w:e.contentRect.width, h:e.contentRect.height }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { window.__orionEdgesRef = edges }, [edges])

  // ── Auto-layout: assign x/y to any node missing them ─────────────────────
  // Builds a simple stage-based layout from edge topology (same logic as compiler)
  const autoLayout = (rawNodes, rawEdges) => {
    const ids = rawNodes.map(n => n.id)
    const inDeg = Object.fromEntries(ids.map(id => [id, 0]))
    rawEdges.forEach(e => { if (inDeg[e.to] !== undefined) inDeg[e.to]++ })

    // Kahn's BFS into stages
    const stages = []
    let queue = ids.filter(id => inDeg[id] === 0)
    const visited = new Set()
    while (queue.length) {
      stages.push([...queue])
      queue.forEach(id => visited.add(id))
      const next = []
      queue.forEach(id => {
        rawEdges.filter(e => e.from === id).forEach(e => {
          if (!visited.has(e.to)) {
            inDeg[e.to]--
            if (inDeg[e.to] === 0) next.push(e.to)
          }
        })
      })
      queue = next
    }
    // Orphans (cycles etc.) get their own stage
    ids.filter(id => !visited.has(id)).forEach(id => stages.push([id]))

    const STAGE_H = 180, NODE_GAP = 220, START_X = 180, START_Y = 80
    return rawNodes.map(n => {
      if (typeof n.x === "number" && typeof n.y === "number") return n
      const stageIdx = stages.findIndex(s => s.includes(n.id))
      const stage    = stages[stageIdx] ?? [n.id]
      const posIdx   = stage.indexOf(n.id)
      const totalW   = (stage.length - 1) * NODE_GAP
      return { ...n, x: START_X + posIdx * NODE_GAP - totalW / 2, y: START_Y + stageIdx * STAGE_H }
    })
  }

  // ── Enter JSON mode: serialise current canvas state ───────────────────────
  const enterJsonMode = () => {
    const flow = {
      id: fd.id, version: fd.version, name: flowName, description: flowDesc,
      nodes: Object.fromEntries(
        nodes.map(({ x, y, ...n }) => [n.id, n])   // strip canvas coords from export
      ),
      edges,
    }
    setJsonText(JSON.stringify(flow, null, 2))
    setJsonError(null)
    setJsonApplied(false)
    setViewMode("json")
  }

  // ── Apply pasted/edited JSON back to canvas ───────────────────────────────
  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText)
      // Accept both { nodes: Record<id,NodeDef> } and { nodes: NodeDef[] }
      const rawNodes = Array.isArray(parsed.nodes)
        ? parsed.nodes
        : Object.entries(parsed.nodes ?? {}).map(([id, n]) => ({ id, ...n }))
      const rawEdges = parsed.edges ?? []
      if (!Array.isArray(rawNodes)) throw new Error("nodes must be an array or object")
      if (!Array.isArray(rawEdges))  throw new Error("edges must be an array")
      const laid = autoLayout(rawNodes, rawEdges)
      setNodes(laid)
      setEdges(rawEdges)
      if (parsed.name)        setFlowName(parsed.name)
      if (parsed.description) setFlowDesc(parsed.description)
      setJsonError(null)
      setJsonApplied(true)
      toast.success("JSON applied", { detail:`${laid.length} nodes · ${rawEdges.length} edges` })
      setTimeout(() => { setViewMode("dag"); setJsonApplied(false); setTimeout(fitView, 50) }, 700)
    } catch (err) {
      setJsonError(err.message)
      toast.error("Invalid JSON", { detail: err.message })
    }
  }

  const onJsonChange = (val) => {
    setJsonText(val)
    setJsonApplied(false)
    try { JSON.parse(val); setJsonError(null) }
    catch (err) { setJsonError(err.message) }
  }

  const toCanvas = (sx, sy) => {
    const r = ref.current.getBoundingClientRect()
    return { x:(sx-r.left-pan.x)/zoom, y:(sy-r.top-pan.y)/zoom }
  }
  const outPt = n => ({ x:n.x+NODE_W/2, y:n.y+NODE_H })
  const inPt  = n => ({ x:n.x+NODE_W/2, y:n.y })

  const onMD = (e) => {
    if (e.button !== 0) return
    // Edge hit
    const edgeEl = e.target.closest('[data-edge]')
    if (edgeEl) { setSelEdge(edgeEl.dataset.edge); setSelNode(null); setSelNodes(new Set()); setRightTab("props"); e.preventDefault(); return }
    // Node events handle themselves
    if (e.target.closest('[data-node]')) return
    // Canvas background — start box-select (pan handled in onMM once a threshold is exceeded)
    const cp = toCanvas(e.clientX, e.clientY)
    setBoxSel({ sx:cp.x, sy:cp.y, ex:cp.x, ey:cp.y })
    if (!e.shiftKey) setSelNodes(new Set())
    setSelNode(null); setSelEdge(null)
    // Also store pan start so we can pan if they drag far without hitting any node
    setPanning({ sx:e.clientX, sy:e.clientY, opx:pan.x, opy:pan.y, isPan:false })
    e.preventDefault()
  }

  const onMM = (e) => {
    const cp = toCanvas(e.clientX, e.clientY)
    setMouse(cp)
    if (dragging) {
      const dx=cp.x-dragging.sx, dy=cp.y-dragging.sy
      if (selNodes.size > 1 && selNodes.has(dragging.nodeId)) {
        setNodes(ns=>ns.map(n=> selNodes.has(n.id)
          ? {...n, x:(dragging.origins[n.id]?.x??n.x)+dx, y:(dragging.origins[n.id]?.y??n.y)+dy}
          : n))
      } else {
        setNodes(ns=>ns.map(n=>n.id===dragging.nodeId?{...n,x:dragging.ox+dx,y:dragging.oy+dy}:n))
      }
    }
    if (panning) {
      const mdx = e.clientX - panning.sx, mdy = e.clientY - panning.sy
      const dist = Math.sqrt(mdx*mdx + mdy*mdy)
      // After 6px movement, switch to pure pan and kill box-select
      if (!panning.isPan && dist > 6) {
        setPanning(p => ({...p, isPan:true}))
        setBoxSel(null)
      }
      if (panning.isPan) setPan({x:panning.opx+mdx, y:panning.opy+mdy})
    }
    if (boxSel && !dragging && !(panning?.isPan)) {
      setBoxSel(b => b ? {...b, ex:cp.x, ey:cp.y} : b)
    }
    if (conn) {
      const hit = nodes.find(n=>n.id!==conn.fromId&&Math.hypot(cp.x-inPt(n).x,cp.y-inPt(n).y)<18)
      setHoverIn(hit?.id??null)
    }
  }

  const onMU = (e) => {
    if (conn) {
      const cp = toCanvas(e.clientX, e.clientY)
      const tgt = nodes.find(n=>n.id!==conn.fromId&&Math.hypot(cp.x-inPt(n).x,cp.y-inPt(n).y)<22)
      if (tgt && !edges.some(eg=>eg.from===conn.fromId&&eg.to===tgt.id)) {
        const ne={id:`e_${Date.now().toString(36)}`,from:conn.fromId,to:tgt.id,kind:"success"}
        setEdges(es=>[...es,ne]); setSelEdge(ne.id); setSelNode(null); setSelNodes(new Set()); setRightTab("props")
      } else if (!tgt) {
        const newId = `code_${Date.now().toString(36)}`
        const cp2 = toCanvas(e.clientX, e.clientY)
        const newNode = { id:newId, type:"code", x:cp2.x-NODE_W/2, y:cp2.y-NODE_H/2, config:{}, meta:{name:"Code"} }
        const ne = { id:`e_${Date.now().toString(36)}`, from:conn.fromId, to:newId, kind:"success" }
        setNodes(ns => [...ns, newNode])
        setEdges(es => [...es, ne])
        setSelNode(newId); setSelEdge(null); setSelNodes(new Set()); setRightTab("props")
      }
      setConn(null); setHoverIn(null)
    }
    // Finalise box select
    if (boxSel) {
      const minX=Math.min(boxSel.sx,boxSel.ex), maxX=Math.max(boxSel.sx,boxSel.ex)
      const minY=Math.min(boxSel.sy,boxSel.ey), maxY=Math.max(boxSel.sy,boxSel.ey)
      const hit = nodes.filter(n =>
        n.x+NODE_W > minX && n.x < maxX && n.y+NODE_H > minY && n.y < maxY
      ).map(n=>n.id)
      if (hit.length > 0) setSelNodes(new Set(hit))
      setBoxSel(null)
    }
    setDragging(null); setPanning(null)
  }

  const onWheel = (e) => {
    e.preventDefault()
    const r=ref.current.getBoundingClientRect()
    const mx=e.clientX-r.left, my=e.clientY-r.top
    const factor=e.deltaY<0?1.08:0.93
    const nz=Math.max(0.15,Math.min(3,zoom*factor))
    const ratio=nz/zoom
    setPan(p=>({x:mx-(mx-p.x)*ratio, y:my-(my-p.y)*ratio}))
    setZoom(nz)
  }

  useEffect(()=>{
    const onKey=(e)=>{
      if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return
      const meta = e.metaKey || e.ctrlKey

      if(e.key==="Escape"){ setSelNodes(new Set()); setSelNode(null); setSelEdge(null) }

      // Delete — works for single or multi selection
      if(e.key==="Delete"||e.key==="Backspace"){
        const toDelete = selNodes.size > 0 ? selNodes : selNode ? new Set([selNode]) : new Set()
        if(toDelete.size>0){
          setNodes(ns=>ns.filter(n=>!toDelete.has(n.id)))
          setEdges(es=>es.filter(e=>!toDelete.has(e.from)&&!toDelete.has(e.to)))
          setSelNode(null); setSelNodes(new Set())
        }
        if(selEdge&&selNodes.size===0&&!selNode){setEdges(es=>es.filter(e=>e.id!==selEdge));setSelEdge(null)}
      }

      // ⌘0 — reset view
      if(e.key==="0"&&meta){setZoom(1);setPan({x:60,y:60});e.preventDefault()}

      // ⌘A — select all
      if(e.key==="a"&&meta&&viewMode==="dag"){
        e.preventDefault()
        setSelNodes(new Set(nodesRef.current.map(n=>n.id)))
        setSelNode(null); setSelEdge(null)
      }

      // ⌘C — copy selected nodes + their internal edges
      if(e.key==="c"&&meta&&viewMode==="dag"){
        const ids = selNodes.size > 0 ? selNodes : selNode ? new Set([selNode]) : new Set()
        if(ids.size===0) return
        const ns = nodesRef.current.filter(n=>ids.has(n.id))
        const es = (window.__orionEdgesRef ?? []).filter(e=>ids.has(e.from)&&ids.has(e.to))
        setClipboard({ nodes:ns, edges:es })
        window.__orionClipboard = JSON.stringify({ nodes:ns, edges:es })
        toast.info(`Copied ${ns.length} node${ns.length!==1?"s":""}${es.length ? ` + ${es.length} edge${es.length!==1?"s":""}` : ""}`)
        e.preventDefault()
      }

      // ⌘V — paste centered in current viewport
      if(e.key==="v"&&meta&&viewMode==="dag"){
        const raw = window.__orionClipboard
        if(!raw) return
        try {
          const { nodes:cNodes, edges:cEdges } = JSON.parse(raw)
          if(!cNodes?.length) return

          // Centre of current viewport in canvas coords
          const canvasEl = ref.current
          const vw = canvasEl ? canvasEl.getBoundingClientRect().width  : 800
          const vh = canvasEl ? canvasEl.getBoundingClientRect().height : 600
          const vcx = (vw/2 - pan.x) / zoom
          const vcy = (vh/2 - pan.y) / zoom

          // Bounding box of copied nodes
          const xs = cNodes.map(n=>n.x??0), ys = cNodes.map(n=>n.y??0)
          const bx = (Math.min(...xs)+Math.max(...xs))/2
          const by = (Math.min(...ys)+Math.max(...ys))/2
          const dx = vcx - bx, dy = vcy - by

          const ts = Date.now().toString(36)
          const idMap = {}
          cNodes.forEach((n,i)=>{
            const base = n.type ? n.type.split(".").pop() : "node"
            idMap[n.id] = `${base}_paste_${ts}_${i}`
          })

          const newNodes = cNodes.map(n=>({ ...n, id:idMap[n.id], x:(n.x??0)+dx, y:(n.y??0)+dy }))
          const newEdges = cEdges.map(e=>({
            ...e,
            id:`e_paste_${ts}_${Math.random().toString(36).slice(2)}`,
            from: idMap[e.from] ?? e.from,
            to:   idMap[e.to]   ?? e.to,
          }))

          setNodes(ns=>[...ns,...newNodes])
          setEdges(es=>[...es,...newEdges])
          setSelNodes(new Set(newNodes.map(n=>n.id)))
          setSelNode(null); setSelEdge(null)
          toast.success(`Pasted ${newNodes.length} node${newNodes.length!==1?"s":""}`)
        } catch(err) { console.warn("Paste failed", err) }
        e.preventDefault()
      }

      // ⌘D — duplicate selection in place (copy + immediate paste)
      if(e.key==="d"&&meta&&viewMode==="dag"){
        e.preventDefault()
        const ids = selNodes.size > 0 ? selNodes : selNode ? new Set([selNode]) : new Set()
        if(ids.size===0) return
        const cNodes = nodesRef.current.filter(n=>ids.has(n.id))
        const cEdges = (window.__orionEdgesRef??[]).filter(e=>ids.has(e.from)&&ids.has(e.to))
        const ts = Date.now().toString(36)
        const idMap = {}
        cNodes.forEach((n,i)=>{
          const base = n.type ? n.type.split(".").pop() : "node"
          idMap[n.id] = `${base}_dup_${ts}_${i}`
        })
        const OFFSET = 80
        const newNodes = cNodes.map(n=>({ ...n, id:idMap[n.id], x:(n.x??0)+OFFSET, y:(n.y??0)+OFFSET }))
        const newEdges = cEdges.map(e=>({
          ...e,
          id:`e_dup_${ts}_${Math.random().toString(36).slice(2)}`,
          from: idMap[e.from]??e.from, to: idMap[e.to]??e.to,
        }))
        setNodes(ns=>[...ns,...newNodes])
        setEdges(es=>[...es,...newEdges])
        setSelNodes(new Set(newNodes.map(n=>n.id)))
        setSelNode(null)
      }
    }
    window.addEventListener("keydown",onKey)
    return ()=>window.removeEventListener("keydown",onKey)
  },[selNode,selEdge,selNodes,viewMode,pan,zoom])

  const addNode = (type) => {
    if (!ref.current) return
    const r=ref.current.getBoundingClientRect()
    const cx=(r.width/2-pan.x)/zoom, cy=(r.height/2-pan.y)/zoom
    const id=`${type.split(".").pop()}_${Date.now().toString(36)}`
    setNodes(ns=>[...ns,{id,type,x:cx-NODE_W/2,y:cy-NODE_H/2,config:{},meta:{name:resolveNodeType(type)?.label??type}}])
    setSelNode(id); setSelEdge(null); setRightTab("props")
  }

  const fitView = () => {
    const ns = nodesRef.current
    if (!ns.length || !ref.current) return
    const r   = ref.current.getBoundingClientRect()
    const xs  = ns.map(n => n.x ?? 0), ys = ns.map(n => n.y ?? 0)
    const minX = Math.min(...xs)-48,      minY = Math.min(...ys)-48
    const maxX = Math.max(...ns.map(n=>(n.x??0)+NODE_W))+48
    const maxY = Math.max(...ns.map(n=>(n.y??0)+NODE_H))+48
    const z = Math.min(r.width/(maxX-minX), r.height/(maxY-minY), 1.6)*0.9
    setPan({ x:(r.width-(maxX-minX)*z)/2-minX*z, y:(r.height-(maxY-minY)*z)/2-minY*z })
    setZoom(z)
  }

  const [saving, setSaving] = useState(false)

  const save = async () => {
    const updated = {...fd, name:flowName, description:flowDesc, nodes, edges, variables:flowVars, subflow, updatedAt:Date.now()}
    // Always update local cache immediately
    CANVAS_FLOWS[fd.id] = updated
    if (subflow?.enabled) subflowStore.reg({ id:fd.id, name:flowName, inputs:subflow.inputs??[], outputs:subflow.outputs??[] })
    else subflowStore.unreg(fd.id)

    setSaving(true)
    try {
      // Determine if this is a create or update
      const isNew = !fd.createdAt
      if (isNew) {
        await flowApi.create({
          id: fd.id, name: flowName, description: flowDesc,
          nodes, edges, variables: flowVars,
          version: fd.version ?? "1.0.0",
          workspaceId: fd.workspaceId ?? "ws_1",
        })
      } else {
        await flowApi.update(fd.id, {
          name: flowName, description: flowDesc,
          nodes, edges, variables: flowVars,
        })
      }
      setApiOnline(true)
      setSaveFlash(true); setTimeout(()=>setSaveFlash(false), 2000)
      toast.success("Flow saved", { detail: flowName })
    } catch(e) {
      setApiOnline(false)
      // Still show saved — local cache updated, will sync when back online
      setSaveFlash(true); setTimeout(()=>setSaveFlash(false), 2000)
      toast.warning("Saved locally — backend unreachable", { detail: e.message })
    } finally {
      setSaving(false)
    }
  }

  const selNodeObj = nodes.find(n=>n.id===selNode)??null
  const selEdgeObj = edges.find(e=>e.id===selEdge)??null
  const dotSz = 22*zoom
  const dotOx = ((pan.x%dotSz)+dotSz)%dotSz
  const dotOy = ((pan.y%dotSz)+dotSz)%dotSz
  const cursor = panning?"grabbing":conn?"crosshair":"default"

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, height:"100%", background:"var(--bg)", fontFamily:"var(--font-ui)", position:"relative" }}>
      {/* ── Toolbar ── */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"0 14px", height:50, borderBottom:"1px solid var(--border)", flexShrink:0, background:"var(--panel)" }}>
        <Btn variant="ghost" small onClick={onBack}>← Flows</Btn>
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        <input value={flowName} onChange={e=>setFlowName(e.target.value)}
          style={{ background:"none", border:"none", outline:"none", fontSize:14, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-head)", letterSpacing:"-0.01em", width:220, minWidth:0 }} />
        <Mono color="var(--dim)" size={10}>v{fd.version}</Mono>
        <div style={{ flex:1 }} />
        {viewMode === "dag" && <Mono color="var(--dim)" size={10}>{Math.round(zoom*100)}%</Mono>}
        {viewMode === "dag" && (selNodes.size > 0 || clipboard) && (
          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
            {selNodes.size > 0 && (
              <>
                {/* Selection count + clear */}
                <div style={{ display:"flex", alignItems:"center", gap:5, padding:"3px 8px", borderRadius:4,
                  background:"var(--cyan)15", border:"1px solid var(--cyan)44" }}>
                  <span style={{ fontSize:11, color:"var(--cyan)", fontFamily:"var(--font-mono)", fontWeight:600 }}>{selNodes.size} selected</span>
                  <button onClick={() => { setSelNodes(new Set()); setSelNode(null) }}
                    style={{ background:"none", border:"none", color:"var(--cyan)", cursor:"pointer", fontSize:11, lineHeight:1, padding:"0 1px", opacity:0.7 }}>✕</button>
                </div>

                {/* Copy */}
                <button
                  onClick={() => {
                    const ids = selNodes.size > 0 ? selNodes : selNode ? new Set([selNode]) : new Set()
                    const ns = nodesRef.current.filter(n=>ids.has(n.id))
                    const es = (window.__orionEdgesRef??[]).filter(e=>ids.has(e.from)&&ids.has(e.to))
                    setClipboard({ nodes:ns, edges:es })
                    window.__orionClipboard = JSON.stringify({ nodes:ns, edges:es })
                    toast.info(`Copied ${ns.length} node${ns.length!==1?"s":""}${es.length?` + ${es.length} edge${es.length!==1?"s":""}` : ""}`)
                  }}
                  title="Copy (⌘C)"
                  style={{ padding:"3px 9px", borderRadius:4, cursor:"pointer", fontSize:11,
                    background:"var(--surface)", border:"1px solid var(--border2)", color:"var(--muted)",
                    fontFamily:"var(--font-ui)", transition:"all 0.1s" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)"}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}
                >⌘C Copy</button>

                {/* Duplicate */}
                <button
                  onClick={() => {
                    const ids = selNodes.size > 0 ? selNodes : selNode ? new Set([selNode]) : new Set()
                    const cNodes = nodesRef.current.filter(n=>ids.has(n.id))
                    const cEdges = (window.__orionEdgesRef??[]).filter(e=>ids.has(e.from)&&ids.has(e.to))
                    const ts = Date.now().toString(36); const idMap = {}
                    cNodes.forEach((n,i)=>{ const base=n.type?n.type.split(".").pop():"node"; idMap[n.id]=`${base}_dup_${ts}_${i}` })
                    const newNodes = cNodes.map(n=>({...n,id:idMap[n.id],x:(n.x??0)+80,y:(n.y??0)+80}))
                    const newEdges = cEdges.map(e=>({...e,id:`e_dup_${ts}_${Math.random().toString(36).slice(2)}`,from:idMap[e.from]??e.from,to:idMap[e.to]??e.to}))
                    setNodes(ns=>[...ns,...newNodes]); setEdges(es=>[...es,...newEdges])
                    setSelNodes(new Set(newNodes.map(n=>n.id))); setSelNode(null)
                  }}
                  title="Duplicate (⌘D)"
                  style={{ padding:"3px 9px", borderRadius:4, cursor:"pointer", fontSize:11,
                    background:"var(--surface)", border:"1px solid var(--border2)", color:"var(--muted)",
                    fontFamily:"var(--font-ui)", transition:"all 0.1s" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)"}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}
                >⌘D Dupe</button>
              </>
            )}

            {/* Paste — shows whenever clipboard has content */}
            {clipboard && (
              <button
                onClick={() => {
                  const { nodes:cNodes, edges:cEdges } = clipboard
                  if(!cNodes?.length) return
                  const canvasEl = ref.current
                  const vw = canvasEl?.getBoundingClientRect().width  ?? 800
                  const vh = canvasEl?.getBoundingClientRect().height ?? 600
                  const vcx = (vw/2 - pan.x)/zoom, vcy = (vh/2 - pan.y)/zoom
                  const xs=cNodes.map(n=>n.x??0), ys=cNodes.map(n=>n.y??0)
                  const dx=vcx-(Math.min(...xs)+Math.max(...xs))/2, dy=vcy-(Math.min(...ys)+Math.max(...ys))/2
                  const ts=Date.now().toString(36); const idMap={}
                  cNodes.forEach((n,i)=>{ const base=n.type?n.type.split(".").pop():"node"; idMap[n.id]=`${base}_paste_${ts}_${i}` })
                  const newNodes=cNodes.map(n=>({...n,id:idMap[n.id],x:(n.x??0)+dx,y:(n.y??0)+dy}))
                  const newEdges=cEdges.map(e=>({...e,id:`e_paste_${ts}_${Math.random().toString(36).slice(2)}`,from:idMap[e.from]??e.from,to:idMap[e.to]??e.to}))
                  setNodes(ns=>[...ns,...newNodes]); setEdges(es=>[...es,...newEdges])
                  setSelNodes(new Set(newNodes.map(n=>n.id))); setSelNode(null); setSelEdge(null)
                  toast.success(`Pasted ${newNodes.length} node${newNodes.length!==1?"s":""}`)
                }}
                title="Paste (⌘V)"
                style={{ padding:"3px 9px", borderRadius:4, cursor:"pointer", fontSize:11,
                  background:"var(--purple)12", border:"1px solid var(--purple)44", color:"var(--purple)",
                  fontFamily:"var(--font-ui)", transition:"all 0.1s" }}
                onMouseEnter={e=>e.currentTarget.style.background="var(--purple)22"}
                onMouseLeave={e=>e.currentTarget.style.background="var(--purple)12"}
              >⌘V Paste ({clipboard.nodes.length})</button>
            )}
          </div>
        )}
        {viewMode === "dag" && <Btn variant="ghost" small onClick={fitView}>⊞ Fit</Btn>}
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        {/* 3-way mode switcher */}
        <div style={{ display:"flex", gap:2, background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6, padding:2 }}>
          {[
            { key:"linear", label:"≡ Linear" },
            { key:"dag",    label:"⬡ DAG"    },
            { key:"json",   label:"{ } JSON"  },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => {
              if (key === "json" && viewMode !== "json") {
                enterJsonMode()
              } else if (key === "dag" && viewMode !== "dag") {
                // Auto-layout any nodes that lack positions (e.g. from linear editor)
                setNodes(ns => {
                  const hasPos = ns.every(n => typeof n.x==="number" && typeof n.y==="number")
                  const laid = hasPos ? ns : autoLayout(ns.map(n=>({...n,x:undefined,y:undefined})), edges)
                  nodesRef.current = laid  // update ref immediately so fitView isn't stale
                  return laid
                })
                setViewMode("dag")
                setTimeout(fitView, 80)
              } else {
                setViewMode(key)
              }
            }} style={{
              padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:12,
              fontFamily: key === "json" ? "var(--font-mono)" : "var(--font-ui)",
              letterSpacing: key === "json" ? "0.03em" : "normal",
              border:"none", transition:"all 0.12s",
              background: viewMode === key ? "var(--panel)" : "transparent",
              color:       viewMode === key ? "var(--text)"     : "var(--muted)",
              boxShadow:   viewMode === key ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
            }}>{label}</button>
          ))}
        </div>
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        {/* Runs history button — amber badge if recent failures */}
        {(() => {
          const recentFails = EXECUTIONS.filter(e => e.flowId===fd.id && e.status==="failed" && Date.now()-e.startedAt < 86400000).length
          return (
            <button onClick={()=>setShowRuns(v=>!v)} style={{
              display:"flex", alignItems:"center", gap:5, padding:"3px 10px",
              background: showRuns ? "var(--amber)18" : "transparent",
              border: `1px solid ${showRuns ? "var(--amber)55" : "var(--border2)"}`,
              borderRadius:5, cursor:"pointer", fontFamily:"var(--font-ui)", fontSize:12,
              color: showRuns ? "var(--amber)" : "var(--muted)",
              transition:"all 0.12s",
            }}>
              ⏱ Runs
              {recentFails > 0 && (
                <span style={{ fontSize:9, background:"var(--red)", color:"#fff",
                  borderRadius:"50%", width:14, height:14, display:"flex",
                  alignItems:"center", justifyContent:"center", fontWeight:700 }}>
                  {recentFails}
                </span>
              )}
            </button>
          )
        })()}
        <Btn variant="ghost" small onClick={()=>toast.info("Compiled successfully", { detail:`${nodes.length} nodes · ${edges.length} edges` })}>⬡ Compile</Btn>
        <Btn variant="default" small onClick={()=>toast.success("Flow triggered", { detail:`POST /flows/${fd.id}/trigger` })}>▶ Run</Btn>
        <Btn variant="primary" small onClick={save} style={{ minWidth:60 }} disabled={editorLoading}>
          {editorLoading ? "Loading…" : saving ? "Saving…" : saveFlash ? "✓ Saved" : "Save"}
        </Btn>
      </div>

      {/* ── Body ── */}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* ── LINEAR MODE ───────────────────────────────────────────────── */}
        {viewMode === "linear" ? (
          <LinearEditor
            nodes={nodes} edges={edges}
            onChange={(ns, es) => { setNodes(ns); setEdges(es) }}
            flowVars={flowVars}
            workspaceId={CANVAS_FLOWS[flowId]?.workspaceId ?? "ws_1"}
          />
        ) : viewMode === "json" ? (
          <div style={{ flex:1, display:"flex", gap:0, overflow:"hidden" }}>

            {/* Editor pane */}
            <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
              {/* Editor toolbar */}
              <div style={{ padding:"8px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10, flexShrink:0, background:"var(--panel)" }}>
                <span style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>
                  Edit the flow definition directly, or paste a JSON object generated by an LLM.
                </span>
                <div style={{ flex:1 }} />
                {jsonError ? (
                  <span style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--red)", maxWidth:320, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    ✗ {jsonError}
                  </span>
                ) : (
                  <span style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--green)" }}>✓ valid JSON</span>
                )}
                <Btn variant="ghost" small onClick={() => {
                  try { setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2)); setJsonError(null) }
                  catch {}
                }}>Format</Btn>
                <Btn variant="ghost" small onClick={() => {
                  navigator.clipboard.writeText(jsonText).then(() => {
                    setCopied("json")
                    setTimeout(() => setCopied(null), 1500)
                  }).catch(() => {
                    // fallback for non-secure contexts
                    const ta = document.createElement("textarea")
                    ta.value = jsonText
                    document.body.appendChild(ta)
                    ta.select()
                    document.execCommand("copy")
                    document.body.removeChild(ta)
                    setCopied("json")
                    setTimeout(() => setCopied(null), 1500)
                  })
                }}>{copied === "json" ? "✓ copied" : "Copy"}</Btn>
                <Btn
                  variant={jsonApplied ? "default" : "primary"}
                  small
                  onClick={applyJson}
                  style={{ minWidth:80, opacity: jsonError ? 0.4 : 1 }}
                >
                  {jsonApplied ? "✓ Applied" : "Apply →"}
                </Btn>
              </div>

              {/* Textarea */}
              <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
                <textarea
                  value={jsonText}
                  onChange={e => onJsonChange(e.target.value)}
                  spellCheck={false}
                  style={{
                    position:"absolute", inset:0, width:"100%", height:"100%",
                    background:"var(--bg)", border:"none", outline:"none", resize:"none",
                    padding:"20px 24px", fontFamily:"var(--font-mono)", fontSize:13,
                    color:"var(--green)", lineHeight:1.7,
                    borderLeft: jsonError ? "3px solid var(--red)" : "3px solid var(--cyan)22",
                    transition:"border-color 0.2s",
                  }}
                />
              </div>
            </div>

            {/* Schema reference sidebar */}
            <div style={{ width:260, borderLeft:"1px solid var(--border)", background:"var(--panel)", overflow:"auto", flexShrink:0 }}>
              <div style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14, fontFamily:"var(--font-ui)" }}>Flow Schema</div>

                {/* Top-level structure */}
                {[
                  ["id",          "string",  "Flow identifier"],
                  ["name",        "string",  "Human-readable name"],
                  ["description", "string?", "Optional description"],
                  ["version",     "string",  "Semver e.g. 1.0.0"],
                  ["nodes",       "Record | NodeDef[]", "Node definitions"],
                  ["edges",       "Edge[]",  "Graph connections"],
                ].map(([k,t,d]) => (
                  <div key={k} style={{ marginBottom:8, paddingBottom:8, borderBottom:"1px solid var(--border)44" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                      <Mono size={11} color="var(--cyan)">{k}</Mono>
                      <Mono size={10} color="var(--purple)">{t}</Mono>
                    </div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>{d}</div>
                  </div>
                ))}

                {/* NodeDefinition */}
                <div style={{ marginTop:16, marginBottom:8 }}>
                  <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--amber)", marginBottom:8, fontFamily:"var(--font-ui)" }}>NodeDefinition</div>
                  {[
                    ["id",       "string", "Unique node id"],
                    ["type",     "string", "One of the node types"],
                    ["config",   "Record<string, Expression>", "Node configuration"],
                    ["meta.name","string?","Display name"],
                    ["retry",    "RetryPolicy?", "maxAttempts, backoff, delayMs"],
                    ["timeout",  "number?","Ms before timeout"],
                    ["x, y",     "number?","Canvas position (optional)"],
                  ].map(([k,t,d]) => (
                    <div key={k} style={{ marginBottom:7, paddingBottom:7, borderBottom:"1px solid var(--border)33" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:1 }}>
                        <Mono size={10} color="var(--text)">{k}</Mono>
                        <Mono size={9} color="var(--purple)">{t}</Mono>
                      </div>
                      <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>{d}</div>
                    </div>
                  ))}
                </div>

                {/* Edge */}
                <div style={{ marginTop:16, marginBottom:8 }}>
                  <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--green)", marginBottom:8, fontFamily:"var(--font-ui)" }}>Edge</div>
                  {[
                    ["id",        "string", "Unique edge id"],
                    ["from",      "string", "Source node id"],
                    ["to",        "string", "Target node id"],
                    ["kind",      '"success"|"error"|"always"', "Traversal trigger"],
                    ["condition", "Expression?", "Guard expression"],
                    ["label",     "string?",     "UI label only"],
                  ].map(([k,t,d]) => (
                    <div key={k} style={{ marginBottom:7, paddingBottom:7, borderBottom:"1px solid var(--border)33" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:1 }}>
                        <Mono size={10} color="var(--text)">{k}</Mono>
                        <Mono size={9} color="var(--purple)">{t}</Mono>
                      </div>
                      <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>{d}</div>
                    </div>
                  ))}
                </div>

                {/* Expression quick ref */}
                <div style={{ marginTop:16 }}>
                  <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--purple)", marginBottom:8, fontFamily:"var(--font-ui)" }}>Expression examples</div>
                  {[
                    ['Literal',   '{"type":"literal","value":42}'],
                    ['Ref',       '{"type":"ref","path":"$.node.field"}'],
                    ['Template',  '{"type":"template","parts":[...]}'],
                    ['Condition', '{"type":"cond","if":...,"then":...,"else":...}'],
                  ].map(([label, ex]) => (
                    <div key={label} style={{ marginBottom:8 }}>
                      <div style={{ fontSize:10, color:"var(--muted)", marginBottom:3, fontFamily:"var(--font-ui)" }}>{label}</div>
                      <div style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--green)66", lineHeight:1.5, wordBreak:"break-all" }}>{ex}</div>
                    </div>
                  ))}
                </div>

                {/* Node types quick list */}
                <div style={{ marginTop:16, borderTop:"1px solid var(--border)", paddingTop:14 }}>
                  <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--cyan)", marginBottom:8, fontFamily:"var(--font-ui)" }}>Node types</div>
                  {Object.entries(allNodeTypes()).map(([type, nt]) => (
                    <div key={type} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
                      <span style={{ fontSize:12, color:nt.color, width:16, textAlign:"center" }}>{nt.icon}</span>
                      <Mono size={9} color="var(--muted)">{type}</Mono>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── VISUAL MODE ──────────────────────────────────────────────── */
          <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

            {/* Canvas */}
            <div ref={ref}
              style={{ flex:1, position:"relative", overflow:"hidden", cursor: dragOver ? "copy" : cursor }}
              onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU} onWheel={onWheel}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect="copy"; setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false)
                const type = e.dataTransfer.getData("orion/node-type") || window.__orionDragType
                if (!type) return
                const cp = toCanvas(e.clientX, e.clientY)
                const id = `${type.split(".").pop()}_${Date.now().toString(36)}`
                const nt = resolveNodeType(type)
                setNodes(ns => [...ns, { id, type, x:cp.x-NODE_W/2, y:cp.y-NODE_H/2, config:{}, meta:{ name:nt?.label ?? type } }])
                setSelNode(id); setSelNodes(new Set()); setSelEdge(null); setRightTab("props")
                toast.success(`Added ${nt?.label ?? type}`)
              }}
            >
          {/* Dot grid */}
          <div style={{ position:"absolute", inset:0, pointerEvents:"none",
            backgroundImage:"radial-gradient(circle, #ffffff15 1.3px, transparent 1.3px)",
            backgroundSize:`${dotSz}px ${dotSz}px`,
            backgroundPosition:`${dotOx}px ${dotOy}px`,
          }} />

          {/* Drop zone highlight */}
          {dragOver && (
            <div style={{ position:"absolute", inset:0, pointerEvents:"none",
              border:"2px dashed var(--cyan)", borderRadius:4, opacity:0.4,
              background:"var(--cyan)06", zIndex:10,
            }} />
          )}

          {/* Box-select rectangle (screen-space, outside world transform) */}
          {boxSel && (() => {
            const r = ref.current?.getBoundingClientRect() ?? {left:0,top:0}
            const sx = Math.min(boxSel.sx,boxSel.ex)*zoom+pan.x
            const sy = Math.min(boxSel.sy,boxSel.ey)*zoom+pan.y
            const bw = Math.abs(boxSel.ex-boxSel.sx)*zoom
            const bh = Math.abs(boxSel.ey-boxSel.sy)*zoom
            return (
              <div style={{ position:"absolute", left:sx, top:sy, width:bw, height:bh,
                border:"1.5px solid var(--cyan)", background:"var(--cyan)12",
                pointerEvents:"none", zIndex:20, borderRadius:3,
              }} />
            )
          })()}

          {/* Empty hint */}
          {nodes.length===0&&(
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", pointerEvents:"none" }}>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:40, marginBottom:10, opacity:0.15 }}>⬡</div>
                <div style={{ fontSize:13, color:"var(--muted)", opacity:0.4 }}>Drag a node from the panel or click to add</div>
              </div>
            </div>
          )}

          {/* Canvas world */}
          <div style={{ position:"absolute", transformOrigin:"0 0", transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`, width:5000, height:4000 }}>
            {/* SVG edge layer */}
            <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", overflow:"visible" }}>
              <defs>
                {Object.entries(EDGE_KIND_COLORS).map(([k,c])=>(
                  <marker key={k} id={`mk-${k}`} markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">
                    <circle cx="3.5" cy="3.5" r="2.5" fill={c} opacity="0.9" />
                  </marker>
                ))}
              </defs>
              {edges.map(edge=>{
                const fn=nodes.find(n=>n.id===edge.from), tn=nodes.find(n=>n.id===edge.to)
                if(!fn||!tn) return null
                const sp=outPt(fn), ep=inPt(tn)
                const sel=edge.id===selEdge
                const col=EDGE_KIND_COLORS[edge.kind??"success"]
                const d=makeBezier(sp.x,sp.y,ep.x,ep.y)
                return (
                  <g key={edge.id}>
                    {/* Wide transparent hit target */}
                    <path d={d} stroke="transparent" strokeWidth={16} fill="none" data-edge={edge.id} style={{cursor:"pointer"}} />
                    {/* Visible path */}
                    <path d={d} stroke={sel?"#ffffff":col} strokeWidth={sel?2.5:1.8} fill="none" strokeOpacity={sel?1:0.7} markerEnd={`url(#mk-${edge.kind??"success"})`} style={{pointerEvents:"none"}} />
                    {edge.label&&(
                      <text x={(sp.x+ep.x)/2} y={(sp.y+ep.y)/2-(edge.condition?20:8)} textAnchor="middle" fontSize={9} fill={col} fontFamily="var(--font-mono)" style={{pointerEvents:"none"}}>{edge.label}</text>
                    )}
                    {edge.condition&&(()=>{
                      const mx=(sp.x+ep.x)/2, my=(sp.y+ep.y)/2
                      return (
                        <g style={{pointerEvents:"none"}}>
                          <rect x={mx-24} y={my-9} width={48} height={17} rx={4} fill="var(--panel)" stroke={col} strokeWidth={0.8} strokeOpacity={0.7} />
                          <text x={mx} y={my+4} textAnchor="middle" fontSize={8} fill={col} fontFamily="var(--font-mono)">◈ if</text>
                          <title>{condToEnglish(edge.condition)}</title>
                        </g>
                      )
                    })()}
                  </g>
                )
              })}
              {/* Live connection preview */}
              {conn&&(
                <path d={makeBezier(conn.sx,conn.sy,mouse.x,mouse.y)}
                  stroke={hoverIn?"#00e599":"#ffffff44"} strokeWidth={hoverIn?2:1.5} fill="none" strokeDasharray="8 5" style={{pointerEvents:"none"}} />
              )}
            </svg>

            {/* Nodes */}
            {nodes.map(node=>{
              const nt=resolveNodeType(node.type)
              const sel=node.id===selNode
              const multiSel=selNodes.has(node.id)
              const hi=node.id===hoverIn
              const col=nt?.color ?? "#64748b"
              const isTrigger=node.type?.startsWith("trigger.")
              return (
                <div key={node.id} data-node={node.id}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  onMouseDown={e=>{
                    if (e.button!==0) return
                    if (e.target.closest('[data-port]')) return
                    if (e.target.closest('[data-nodeaction]')) return
                    const cp=toCanvas(e.clientX,e.clientY)
                    // If clicking inside an existing multi-selection, drag all of them
                    if (selNodes.has(node.id) && selNodes.size > 1) {
                      const origins = {}
                      nodesRef.current.forEach(n => { origins[n.id] = { x:n.x, y:n.y } })
                      setDragging({nodeId:node.id, sx:cp.x, sy:cp.y, ox:node.x, oy:node.y, origins})
                    } else {
                      setDragging({nodeId:node.id,sx:cp.x,sy:cp.y,ox:node.x,oy:node.y})
                      setSelNode(node.id); setSelNodes(new Set()); setSelEdge(null); setRightTab("props")
                    }
                    e.preventDefault(); e.stopPropagation()
                  }}
                  style={{
                    position:"absolute", left:node.x, top:node.y, width:NODE_W, height:NODE_H,
                    background: multiSel ? `${col}22` : sel ? `${col}18` : "var(--panel)",
                    border:`1.5px solid ${sel ? col : multiSel ? col+"99" : hi ? col+"66" : "var(--border2)"}`,
                    borderTop:isTrigger?`2px solid ${col}`:undefined,
                    borderRadius:8, cursor:dragging?.nodeId===node.id?"grabbing":"grab", userSelect:"none",
                    boxShadow: sel ? `0 0 0 2px ${col}40, 0 8px 32px rgba(0,0,0,0.5)`
                             : multiSel ? `0 0 0 1.5px ${col}50`
                             : "0 2px 10px rgba(0,0,0,0.4)",
                    transition:"border-color 0.1s, box-shadow 0.1s",
                  }}>
                  {/* Input port */}
                  <div data-port="input" data-nid={node.id} style={{
                    position:"absolute", left:NODE_W/2-PORT_R, top:-PORT_R-1,
                    width:PORT_R*2, height:PORT_R*2, borderRadius:"50%",
                    background:hi?"var(--green)":"var(--bg)", border:`2px solid ${hi?"var(--green)":col}`,
                    zIndex:3, transition:"transform 0.1s, background 0.1s", cursor:"crosshair",
                    boxShadow:hi?`0 0 0 3px var(--green)44`:undefined,
                  }}
                    onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.5)"}}
                    onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)"}}
                  />

                  {/* Hover action buttons — upper right corner */}
                  {hoveredNode === node.id && (
                    <div
                      data-nodeaction="true"
                      style={{
                        position:"absolute", top:5, right:5,
                        display:"flex", gap:4, zIndex:10,
                      }}
                    >
                      {/* Change type */}
                      <button
                        data-nodeaction="true"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                          e.stopPropagation()
                          setNodes(ns => ns.map(n => n.id===node.id ? {...n, type:null, config:{}, meta:{...n.meta}} : n))
                          setSelNode(node.id); setSelEdge(null)
                          setChangingNodeId(node.id)
                          setRightTab("nodes")
                        }}
                        title="Change node type"
                        style={{
                          width:22, height:22, borderRadius:5, cursor:"pointer",
                          display:"flex", alignItems:"center", justifyContent:"center",
                          background:"var(--bg)", border:"1px solid var(--border2)",
                          color:"var(--cyan)", fontSize:12, lineHeight:1,
                          transition:"all 0.1s", boxShadow:"0 2px 8px rgba(0,0,0,0.4)",
                        }}
                        onMouseEnter={e=>{e.currentTarget.style.background="var(--cyan)22";e.currentTarget.style.borderColor="var(--cyan)55"}}
                        onMouseLeave={e=>{e.currentTarget.style.background="var(--bg)";e.currentTarget.style.borderColor="var(--border2)"}}
                      >⇄</button>

                      {/* Delete */}
                      <button
                        data-nodeaction="true"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                          e.stopPropagation()
                          setNodes(ns => ns.filter(n => n.id !== node.id))
                          setEdges(es => es.filter(e => e.from !== node.id && e.to !== node.id))
                          setSelNode(null)
                          setHoveredNode(null)
                          setChangingNodeId(null)
                        }}
                        title="Delete node"
                        style={{
                          width:22, height:22, borderRadius:5, cursor:"pointer",
                          display:"flex", alignItems:"center", justifyContent:"center",
                          background:"var(--bg)", border:"1px solid var(--border2)",
                          color:"var(--red)", fontSize:15, lineHeight:1,
                          transition:"all 0.1s", boxShadow:"0 2px 8px rgba(0,0,0,0.4)",
                        }}
                        onMouseEnter={e=>{e.currentTarget.style.background="var(--red)22";e.currentTarget.style.borderColor="var(--red)55"}}
                        onMouseLeave={e=>{e.currentTarget.style.background="var(--bg)";e.currentTarget.style.borderColor="var(--border2)"}}
                      >×</button>
                    </div>
                  )}

                  {/* Content */}
                  <div style={{ padding:"8px 12px", pointerEvents:"none", display:"flex", flexDirection:"column", gap:3, height:"100%", justifyContent:"center" }}>
                    {node.type === null ? (
                      <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                        <span style={{ fontSize:14, color:"var(--muted)" }}>○</span>
                        <span style={{ fontSize:12, color:"var(--muted)", fontStyle:"italic", fontFamily:"var(--font-ui)" }}>Pick a type…</span>
                      </div>
                    ) : (<>
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <span style={{ fontSize:14, lineHeight:1, color:col }}>{nt.icon}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", letterSpacing:"-0.01em", fontFamily:"var(--font-ui)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:130 }}>
                        {node.meta?.name??node.id}
                      </span>
                    </div>
                    {/* For trigger nodes: env pill strip. For others: type + preview */}
                    {isTrigger ? (() => {
                      const wsId   = FLOWS.find(f=>f.id===flowId)?.workspaceId ?? "ws_1"
                      const envs   = ACCOUNT_DATA.workspaces.find(w=>w.id===wsId)?.git?.environments ?? []
                      const STATUS = { deployed:"var(--green)", behind:"var(--amber)", failed:"var(--red)", pending:"var(--dim)" }
                      const cronBehaviourIcon = { active:"●", paused:"⏸", simulate:"◎" }
                      const isCronOrEvent = node.type === "trigger.cron" || node.type === "trigger.event"
                      if (!envs.length) return (
                        <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:`${col}99`, textTransform:"uppercase", letterSpacing:"0.06em" }}>{node.type}</span>
                      )
                      return (
                        <div style={{ display:"flex", alignItems:"center", gap:4, flexWrap:"nowrap", overflow:"hidden" }}>
                          {envs.map(env => {
                            const sc   = STATUS[env.status] ?? "var(--dim)"
                            const cb   = env.cronBehaviour ?? (env.requiresApproval ? "active" : "paused")
                            const icon = isCronOrEvent ? (cronBehaviourIcon[cb] ?? "●") : "●"
                            const iconColor = isCronOrEvent
                              ? (cb === "active" ? "var(--green)" : cb === "simulate" ? "var(--purple)" : "var(--amber)")
                              : sc
                            return (
                              <span key={env.id} style={{
                                display:"inline-flex", alignItems:"center", gap:2,
                                fontSize:9, fontFamily:"var(--font-mono)",
                                color:"var(--muted)", background:"var(--bg)",
                                border:"1px solid var(--border)", borderRadius:3,
                                padding:"1px 5px", flexShrink:0,
                              }}>
                                <span style={{ color:iconColor, fontSize:8 }}>{icon}</span>
                                {env.label.toLowerCase()}
                              </span>
                            )
                          })}
                        </div>
                      )
                    })() : (
                      <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:`${col}99`, textTransform:"uppercase", letterSpacing:"0.06em" }}>{node.type}</span>
                    )}
                    <span style={{ fontSize:10.5, fontFamily:"var(--font-mono)", color:"var(--muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{getNodePreview(node)}</span>
                    </>)}
                  </div>
                  {/* Output port */}
                  <div data-port="output" data-nid={node.id}
                    onMouseDown={e=>{
                      if (e.button!==0) return
                      const op=outPt(node)
                      setConn({fromId:node.id,sx:op.x,sy:op.y})
                      setSelNode(null); setSelEdge(null)
                      e.preventDefault(); e.stopPropagation()
                    }}
                    style={{
                      position:"absolute", left:NODE_W/2-PORT_R, bottom:-PORT_R-1,
                      width:PORT_R*2, height:PORT_R*2, borderRadius:"50%",
                      background:col, border:`2px solid ${col}`,
                      zIndex:3, cursor:"crosshair", transition:"transform 0.1s",
                    }}
                    onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.6)"; e.currentTarget.style.boxShadow=`0 0 0 4px ${col}44`}}
                    onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)"; e.currentTarget.style.boxShadow="none"}}
                  />
                </div>
              )
            })}
          </div>
          {/* Minimap */}
          <DAGMinimap
            nodes={nodes} edges={edges}
            pan={pan} zoom={zoom}
            canvasW={canvasSize.w} canvasH={canvasSize.h}
            NODE_W={NODE_W} NODE_H={NODE_H}
            onPan={setPan}
          />
        </div>

        {/* ── Tabbed Right Panel ── */}
        <div style={{ width:298, borderLeft:"1px solid var(--border)", background:"var(--panel)", display:"flex", flexDirection:"column", flexShrink:0, overflow:"hidden" }}>

          {/* Tab strip */}
          <div style={{ display:"flex", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
            {[
              { k:"nodes",   label:"Nodes"   },
              { k:"props",   label: selNodeObj ? selNodeObj.meta?.name ?? "Node" : selEdgeObj ? "Edge" : "Props" },
              { k:"vars",    label:`Vars${flowVars.length ? ` (${flowVars.length})` : ""}` },
              { k:"subflow", label: subflow?.enabled ? "◈ Sub" : "Sub" },
            ].map(t => (
              <button key={t.k} onClick={() => setRightTab(t.k)} style={{
                flex:1, padding:"9px 4px", background:"none",
                border:"none", borderBottom: rightTab===t.k ? "2px solid var(--cyan)" : "2px solid transparent",
                cursor:"pointer", fontFamily:"var(--font-ui)", fontSize:11,
                fontWeight: rightTab===t.k ? 600 : 400,
                color: rightTab===t.k ? "var(--cyan)" : "var(--muted)",
                transition:"all 0.1s", whiteSpace:"nowrap",
              }}>{t.label}</button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex:1, overflowY:"auto" }}>

            {/* NODES tab — node palette */}
            {rightTab === "nodes" && (
              <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
                {/* Change-mode banner */}
                {changingNodeId && (
                  <div style={{
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"7px 12px", background:"var(--cyan)0e", borderBottom:"1px solid var(--cyan)33",
                    flexShrink:0,
                  }}>
                    <span style={{ fontSize:11, color:"var(--cyan)", fontFamily:"var(--font-ui)" }}>
                      ⇄ Pick a new type for <strong>{nodes.find(n=>n.id===changingNodeId)?.meta?.name ?? changingNodeId}</strong>
                    </span>
                    <button
                      onClick={() => { setChangingNodeId(null); setRightTab("nodes") }}
                      style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:14, lineHeight:1, padding:"0 2px" }}
                    >×</button>
                  </div>
                )}
                <div style={{ padding:"10px 12px 8px", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
                  <input
                    placeholder="Search node types…"
                    onChange={e => {
                      const el = document.getElementById("node-palette-search")
                      if (el) el.dataset.search = e.target.value.toLowerCase()
                      e.target.dispatchEvent(new Event("palette-search", {bubbles:true}))
                    }}
                    id="node-palette-search"
                    style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                      padding:"5px 9px", fontSize:12, color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)",
                      boxSizing:"border-box" }}
                    onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                  />
                </div>
                <PaletteInline onAdd={(type) => {
                  if (changingNodeId) {
                    // Replace type on existing node — preserve position, id, name
                    setNodes(ns => ns.map(n => n.id === changingNodeId
                      ? { ...n, type, config:{}, meta:{ ...n.meta, name: resolveNodeType(type)?.label ?? type } }
                      : n
                    ))
                    setSelNode(changingNodeId)
                    setChangingNodeId(null)
                    setRightTab("props")
                  } else {
                    addNode(type)
                  }
                }} />
              </div>
            )}

            {/* PROPS tab — NodeInspector / EdgeInspector / FlowProps */}
            {rightTab === "props" && (
              selNodeObj ? (
                <NodeInspector
                  node={selNodeObj}
                  onCfg={(k,v)=>setNodes(ns=>ns.map(n=>n.id===selNode?{...n,config:{...n.config,[k]:v}}:n))}
                  onMeta={(k,v)=>setNodes(ns=>ns.map(n=>n.id===selNode?{...n,meta:{...(n.meta??{}),[k]:v}}:n))}
                  onPatch={(p)=>setNodes(ns=>ns.map(n=>n.id===selNode?{...n,...p}:n))}
                  onDelete={()=>{setNodes(ns=>ns.filter(n=>n.id!==selNode));setEdges(es=>es.filter(e=>e.from!==selNode&&e.to!==selNode));setSelNode(null)}}
                  upstreamSamples={Object.fromEntries(nodes.filter(n=>n.id!==selNode&&n.sampleData).map(n=>[n.id,n.sampleData]))}
                />
              ) : selEdgeObj ? (
                <EdgeInspector
                  edge={selEdgeObj} nodes={nodes}
                  onChange={(p)=>setEdges(es=>es.map(e=>e.id===selEdge?{...e,...p}:e))}
                  onDelete={()=>{setEdges(es=>es.filter(e=>e.id!==selEdge));setSelEdge(null)}}
                  upstreamSamples={(() => {
                    const fromId = selEdgeObj.from
                    const ancestorIds = new Set()
                    const visit = (id) => { if(ancestorIds.has(id)) return; ancestorIds.add(id); edges.filter(e=>e.to===id).forEach(e=>visit(e.from)) }
                    visit(fromId)
                    return Object.fromEntries(nodes.filter(n=>ancestorIds.has(n.id)&&n.sampleData).map(n=>[n.id,n.sampleData]))
                  })()}
                />
              ) : (
                <div style={{ padding:16 }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
                    {[["Nodes",nodes.length,"var(--cyan)"],["Edges",edges.length,"var(--muted)"]].map(([l,v,c])=>(
                      <div key={l} style={{ background:"var(--surface)", borderRadius:6, padding:"10px 12px" }}>
                        <div style={{ fontSize:10, color:"var(--muted)", marginBottom:3, fontFamily:"var(--font-ui)" }}>{l}</div>
                        <div style={{ fontFamily:"var(--font-mono)", fontSize:20, color:c, fontWeight:500 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginBottom:12 }}>
                    <label style={{ display:"block", fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4, fontFamily:"var(--font-ui)" }}>Name</label>
                    <input value={flowName} onChange={e=>setFlowName(e.target.value)}
                      style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"7px 10px", fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)", outline:"none", boxSizing:"border-box" }}
                      onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
                  </div>
                  <div style={{ marginBottom:20 }}>
                    <label style={{ display:"block", fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4, fontFamily:"var(--font-ui)" }}>Description</label>
                    <textarea value={flowDesc} onChange={e=>setFlowDesc(e.target.value)} rows={3}
                      style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"7px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", resize:"vertical", outline:"none", boxSizing:"border-box" }}
                      onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
                  </div>
                  <div style={{ background:"var(--surface)", borderRadius:7, padding:"12px 14px" }}>
                    <div style={{ fontSize:11, color:"var(--muted)", marginBottom:8, fontFamily:"var(--font-ui)" }}>Keyboard shortcuts</div>
                    {[["Del / ⌫","Delete selected"],["Scroll","Zoom"],["Drag bg","Pan"],["Drag ●","Connect"],["⌘0","Reset view"]].map(([k,v])=>(
                      <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                        <Mono size={10} color="var(--cyan)">{k}</Mono>
                        <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}

            {/* VARS tab */}
            {rightTab === "vars" && (
              <div style={{ padding:12 }}>
                <FlowVariablesPanel
                  flowVars={flowVars}
                  setFlowVars={setFlowVars}
                  workspaceId={CANVAS_FLOWS[flowId]?.workspaceId ?? "ws_1"}
                />
              </div>
            )}

            {/* SUBFLOW tab */}
            {rightTab === "subflow" && (
              <div style={{ padding:12 }}>
                <SubflowIOEditor
                  flowId={flowId ?? ""}
                  flowName={flowName}
                  subflow={subflow}
                  setSubflow={setSubflow}
                />
              </div>
            )}

          </div>
        </div>

          </div>
        )}

      </div>

      {/* ── Runs history panel (slide-in overlay) ── */}
      {showRuns && (
        <div style={{ position:"absolute", inset:0, pointerEvents:"none", zIndex:19 }}>
          <div style={{ pointerEvents:"all", position:"absolute", top:0, right:0, bottom:0 }}>
            <FlowRunsPanel
              flowId={fd.id}
              onClose={() => setShowRuns(false)}
              onDrilldown={(exec) => { setRunsExec(exec) }}
            />
          </div>
        </div>
      )}

      {/* ── Execution drilldown modal ── */}
      {runsExec && (
        <div style={{
          position:"absolute", inset:0, background:"rgba(8,10,15,0.75)",
          zIndex:30, display:"flex", alignItems:"flex-start", justifyContent:"flex-end",
          backdropFilter:"blur(2px)",
        }} onClick={(e)=>{ if(e.target===e.currentTarget) setRunsExec(null) }}>
          <div style={{ width:"min(860px,92%)", height:"100%", background:"var(--bg)",
            borderLeft:"1px solid var(--border)", overflow:"auto",
            animation:"slideInRight 0.18s ease-out" }}>
            <ExecutionDetail exec={runsExec} onBack={()=>setRunsExec(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

const TEMPLATE_CATEGORIES = ["All", "AI & LLM", "CRM & Sales", "DevOps", "Data", "Notifications", "Finance"]