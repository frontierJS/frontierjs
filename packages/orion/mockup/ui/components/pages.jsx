import { useState, useEffect, useRef, useMemo } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { FLOWS, EXECUTIONS, MOCK_PLUGINS, METRIC_WINDOWS, buildMetrics, fmt, now, SA_ACCOUNTS } from './mock.js'
import { Btn, Mono, StatusDot, StatusPill, Tag, Card, Stat, Table, SectionHeader,
         Toggle, TriggerChips, FilterDropdown, DatetimeRangePicker, toast } from './primitives.jsx'
import { flowApi, executionApi, metricsApi, setApiOnline } from './api.js'
import { pluginStore, usePluginList } from './node-types.js'
import { CANVAS_FLOWS, FlowEditor } from './flow-editor.jsx'

// ── PluginsPage ───────────────────────────────────────────────────────────────
export const PluginsPage = () => {
  // Keep local state in sync with global plugin store
  const [plugins,   setPlugins]  = useState(MOCK_PLUGINS)
  // Write back to global registry whenever local state changes
  useEffect(() => { pluginStore.set(plugins) }, [plugins])
  const [selected,  setSelected] = useState(null)   // plugin id
  const [uploading, setUploading]= useState(false)
  const [uploadErr, setUploadErr]= useState(null)
  const [uploadOk,  setUploadOk] = useState(null)   // name of just-installed plugin
  const [dragging,  setDragging] = useState(false)
  const [search,    setSearch]   = useState("")
  const fileRef = useRef(null)

  const selPlugin = plugins.find(p => p.id === selected) ?? null

  // ── Upload handler ─────────────────────────────────────────────────────────
  const handleFile = async (file) => {
    if (!file) return
    if (!file.name.endsWith(".zip")) { setUploadErr("File must be a .zip"); return }
    setUploading(true); setUploadErr(null); setUploadOk(null)
    // Simulate parsing the manifest.json from inside the zip (2s delay)
    await new Promise(r => setTimeout(r, 1800))
    // Mock: pretend we parsed a new plugin from the zip
    const mockNew = {
      id: `plugin_${Date.now().toString(36)}`,
      name: file.name.replace(/[-_.]zip$/i,"").replace(/[-_]/g," ").replace(/\b\w/g,c=>c.toUpperCase()),
      version: "1.0.0",
      description: "Uploaded plugin — edit manifest to add a description.",
      author: "—", license: "MIT", homepage: null,
      orionVersion: ">=0.1.0",
      status: "active",
      installedAt: Date.now(),
      nodes: [], credentials: [],
    }
    setPlugins(ps => [...ps, mockNew])
    setSelected(mockNew.id)
    setUploadOk(mockNew.name)
    setUploading(false)
    setTimeout(() => setUploadOk(null), 4000)
  }

  const onFileInput = (e) => { handleFile(e.target.files?.[0]); e.target.value="" }
  const onDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files?.[0]) }
  const onDragOver = (e) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = () => setDragging(false)

  const toggleStatus = (id) => {
    const p = plugins.find(x => x.id === id)
    const next = p?.status === "active" ? "disabled" : "active"
    setPlugins(ps => ps.map(p => p.id===id ? {...p, status: next} : p))
    if (next === "active") toast.success("Plugin enabled", { detail: p?.name })
    else toast.warning("Plugin disabled", { detail: p?.name })
  }
  const removePlugin = (id) => {
    const p = plugins.find(x => x.id === id)
    setPlugins(ps => ps.filter(p => p.id!==id))
    if (selected===id) setSelected(null)
    toast.info("Plugin removed", { detail: p?.name })
  }

  const filtered = plugins.filter(p =>
    !search || p.name.toLowerCase().includes(search) || p.description.toLowerCase().includes(search)
  )

  const statusColor = s => s==="active"?"var(--green)":s==="error"?"var(--red)":"var(--dim)"
  const statusLabel = s => s==="active"?"active":s==="error"?"error":"disabled"

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── Left sidebar: plugin list ─────────────────────────────────────── */}
      <div style={{ width:280, flexShrink:0, borderRight:"1px solid var(--border)", display:"flex", flexDirection:"column", background:"var(--panel)" }}>

        {/* Header */}
        <div style={{ padding:"20px 18px 12px", borderBottom:"1px solid var(--border)" }}>
          <div style={{ fontSize:15, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)", marginBottom:10 }}>Plugins</div>
          <input value={search} onChange={e=>setSearch(e.target.value.toLowerCase())} placeholder="Search plugins…"
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6, padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", boxSizing:"border-box", fontFamily:"var(--font-ui)" }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
        </div>

        {/* List */}
        <div style={{ flex:1, overflowY:"auto" }}>
          {filtered.length === 0 && (
            <div style={{ padding:"24px 18px", fontSize:13, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>No plugins found.</div>
          )}
          {filtered.map(p => (
            <div key={p.id} onClick={()=>setSelected(p.id)} style={{
              padding:"10px 18px", cursor:"pointer", borderBottom:"1px solid var(--border)",
              background: selected===p.id ? "var(--bg)" : "transparent",
              borderLeft: selected===p.id ? "2px solid var(--cyan)" : "2px solid transparent",
              transition:"background 0.1s",
              display:"flex", alignItems:"center", gap:10,
            }}>
              <span style={{ fontSize:18, lineHeight:1, flexShrink:0 }}>{p.nodes[0]?.icon ?? "⬡"}</span>
              <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)", flex:1, minWidth:0,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</span>
              <StatusDot status={p.status==="active"?"active":p.status==="error"?"error":"inactive"} size={7} />
            </div>
          ))}
        </div>

        {/* Upload zone */}
        <div style={{ padding:"14px 16px", borderTop:"1px solid var(--border)" }}>
          {uploadOk && (
            <div style={{ marginBottom:10, padding:"7px 10px", background:"var(--green)12", border:"1px solid var(--green)33", borderRadius:6, fontSize:11, color:"var(--green)", fontFamily:"var(--font-ui)" }}>
              ✓ "{uploadOk}" installed
            </div>
          )}
          {uploadErr && (
            <div style={{ marginBottom:10, padding:"7px 10px", background:"var(--red)0a", border:"1px solid var(--red)33", borderRadius:6, fontSize:11, color:"var(--red)", fontFamily:"var(--font-ui)" }}>
              ⚠ {uploadErr}
            </div>
          )}
          {/* Drop zone */}
          <div
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
            onClick={()=>fileRef.current?.click()}
            style={{
              padding:"14px 10px", borderRadius:8, cursor:"pointer", textAlign:"center",
              border:`1.5px dashed ${dragging?"var(--cyan)":"var(--border2)"}`,
              background: dragging ? "var(--cyan)08" : "transparent",
              transition:"all 0.12s",
            }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)88";e.currentTarget.style.background="var(--cyan)05"}}
            onMouseLeave={e=>{if(!dragging){e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.background="transparent"}}}
          >
            <input ref={fileRef} type="file" accept=".zip" style={{ display:"none" }} onChange={onFileInput} />
            {uploading ? (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:18, animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
                <span style={{ fontSize:11, color:"var(--cyan)", fontFamily:"var(--font-ui)" }}>Installing…</span>
              </div>
            ) : (
              <>
                <div style={{ fontSize:20, marginBottom:5, opacity:0.5 }}>⬆</div>
                <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.5 }}>
                  Drop a <code style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--cyan)" }}>.zip</code> plugin here<br/>or click to browse
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: plugin detail ──────────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:"auto", background:"var(--bg)" }}>
        {!selPlugin ? (
          <_PluginEmptyState onBrowse={()=>fileRef.current?.click()} />
        ) : (
          <_PluginDetail plugin={selPlugin} onToggle={()=>toggleStatus(selPlugin.id)} onRemove={()=>removePlugin(selPlugin.id)} />
        )}
      </div>
    </div>
  )
}

// ── _PluginEmptyState ─────────────────────────────────────────────────────────
export const _PluginEmptyState = ({ onBrowse }) => (
  <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", flexDirection:"column", gap:14, padding:40 }}>
    <div style={{ fontSize:48, opacity:0.1 }}>⬡</div>
    <div style={{ fontSize:15, fontWeight:600, color:"var(--muted)", fontFamily:"var(--font-head)" }}>No plugin selected</div>
    <div style={{ fontSize:13, color:"var(--dim)", fontFamily:"var(--font-ui)", textAlign:"center", maxWidth:340, lineHeight:1.7 }}>
      Select a plugin from the list to view its details, or upload a <code style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--cyan)" }}>.zip</code> to install a new one.
    </div>
    <div style={{ marginTop:8, padding:"10px 18px", borderRadius:7, background:"var(--cyan)10", border:"1px solid var(--cyan)33", fontSize:12, color:"var(--cyan)", fontFamily:"var(--font-ui)", cursor:"pointer" }} onClick={onBrowse}>⬆ Upload Plugin</div>
    <div style={{ marginTop:16, maxWidth:480, background:"var(--panel)", borderRadius:10, border:"1px solid var(--border)", padding:"18px 22px" }}>
      <div style={{ fontSize:12, fontWeight:600, color:"var(--muted)", fontFamily:"var(--font-ui)", marginBottom:10, textTransform:"uppercase", letterSpacing:"0.07em" }}>Plugin ZIP structure</div>
      <pre style={{ margin:0, fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted)", lineHeight:1.8 }}>{`my-plugin-1.0.0.zip
├── manifest.json   ← required
├── index.js        ← compiled ESM node executors
└── README.md       ← optional`}</pre>
    </div>
  </div>
)

// ── _PluginDetail ─────────────────────────────────────────────────────────────
export const _PluginDetail = ({ plugin: p, onToggle, onRemove }) => {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [activeNodeIdx, setActiveNodeIdx] = useState(0)
  const activeNode = p.nodes[activeNodeIdx] ?? null

  const statusColor = p.status==="active"?"var(--green)":p.status==="error"?"var(--red)":"var(--dim)"

  return (
    <div style={{ padding:"28px 32px", maxWidth:820 }}>

      {/* ── Plugin header ────────────────────────────────────────────────── */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ width:52, height:52, borderRadius:12, background:"var(--panel)", border:"1px solid var(--border2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>
            {p.nodes[0]?.icon ?? "⬡"}
          </div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
              <span style={{ fontSize:20, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)" }}>{p.name}</span>
              <span style={{ fontSize:11, fontFamily:"var(--font-mono)", color:statusColor, background:`${statusColor}18`, padding:"2px 7px", borderRadius:4, textTransform:"uppercase", letterSpacing:"0.07em" }}>{p.status}</span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <Mono size={10} color="var(--dim)">v{p.version}</Mono>
              {p.author !== "—" && <Mono size={10} color="var(--dim)">by {p.author}</Mono>}
              <Mono size={10} color="var(--dim)">{p.license}</Mono>
              {p.homepage && <a href={p.homepage} target="_blank" rel="noreferrer" style={{ fontSize:11, color:"var(--cyan)", fontFamily:"var(--font-mono)", textDecoration:"none" }}>↗ repo</a>}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <button onClick={onToggle} style={{
            padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)",
            background: p.status==="active" ? "var(--amber)12" : "var(--green)12",
            border: `1px solid ${p.status==="active" ? "var(--amber)44" : "var(--green)44"}`,
            color: p.status==="active" ? "var(--amber)" : "var(--green)",
          }}>
            {p.status==="active" ? "Disable" : "Enable"}
          </button>
          {!confirmRemove ? (
            <button onClick={()=>setConfirmRemove(true)} style={{ padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)", background:"var(--red)0a", border:"1px solid var(--red)33", color:"var(--red)" }}>Remove</button>
          ) : (
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={onRemove} style={{ padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)", background:"var(--red)22", border:"1px solid var(--red)", color:"var(--red)", fontWeight:600 }}>Confirm Remove</button>
              <button onClick={()=>setConfirmRemove(false)} style={{ padding:"5px 10px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)", background:"none", border:"1px solid var(--border2)", color:"var(--muted)" }}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <div style={{ fontSize:14, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.65, marginBottom:28, paddingBottom:24, borderBottom:"1px solid var(--border)" }}>{p.description}</div>

      {/* ── Meta strip ─────────────────────────────────────────────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:28 }}>
        {[
          ["Nodes",    p.nodes.length],
          ["Credentials", p.credentials.length],
          ["Engine",   p.orionVersion],
          ["Installed", new Date(p.installedAt).toLocaleDateString()],
        ].map(([l,v])=>(
          <div key={l} style={{ background:"var(--panel)", borderRadius:8, border:"1px solid var(--border)", padding:"12px 14px" }}>
            <div style={{ fontSize:10, color:"var(--dim)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)", marginBottom:5 }}>{l}</div>
            <div style={{ fontSize:16, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)" }}>{v}</div>
          </div>
        ))}
      </div>

      {/* ── Nodes provided ──────────────────────────────────────────────────── */}
      {p.nodes.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <div style={{ fontSize:13, fontWeight:600, color:"var(--muted)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:12 }}>Node Types</div>

          {/* Node tabs */}
          <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
            {p.nodes.map((n,i) => (
              <button key={i} onClick={()=>setActiveNodeIdx(i)} style={{
                display:"flex", alignItems:"center", gap:6, padding:"5px 12px", borderRadius:6, cursor:"pointer",
                background: activeNodeIdx===i ? `${n.color}18` : "var(--panel)",
                border: `1px solid ${activeNodeIdx===i ? n.color+"55" : "var(--border)"}`,
                color: activeNodeIdx===i ? n.color : "var(--muted)", fontSize:12, fontFamily:"var(--font-ui)",
                transition:"all 0.1s",
              }}>
                <span style={{ fontSize:14 }}>{n.icon}</span>{n.label}
              </button>
            ))}
          </div>

          {/* Active node detail */}
          {activeNode && (
            <div style={{ background:"var(--panel)", borderRadius:10, border:"1px solid var(--border)", overflow:"hidden" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 18px", borderBottom:"1px solid var(--border)", background:`${activeNode.color}08` }}>
                <span style={{ fontSize:22 }}>{activeNode.icon}</span>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)" }}>{activeNode.label}</div>
                  <Mono size={9} color={activeNode.color}>{activeNode.type}</Mono>
                </div>
                <div style={{ marginLeft:"auto" }}>
                  <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--dim)", background:"var(--surface)", padding:"2px 7px", borderRadius:3, border:"1px solid var(--border)" }}>{activeNode.category}</span>
                </div>
              </div>
              <div style={{ padding:"14px 18px" }}>
                <div style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)", marginBottom:12 }}>{activeNode.description}</div>

                {/* Config fields from schema */}
                {activeNode.configSchema?.properties && (
                  <div>
                    <div style={{ fontSize:10, color:"var(--dim)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)", marginBottom:8 }}>Config Fields</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {Object.entries(activeNode.configSchema.properties).map(([key, schema]) => {
                        const required = activeNode.configSchema.required?.includes(key)
                        return (
                          <div key={key} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 10px", background:"var(--bg)", borderRadius:6, border:"1px solid var(--border)" }}>
                            <code style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--cyan)", minWidth:100 }}>{key}</code>
                            <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-mono)", flex:1 }}>{schema.type}</span>
                            {required && <span style={{ fontSize:9, color:"var(--amber)", fontFamily:"var(--font-mono)", background:"var(--amber)12", padding:"1px 5px", borderRadius:3 }}>required</span>}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Required credentials */}
                {activeNode.credentials?.length > 0 && (
                  <div style={{ marginTop:14 }}>
                    <div style={{ fontSize:10, color:"var(--dim)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)", marginBottom:8 }}>Required Credentials</div>
                    {activeNode.credentials.map(ck => {
                      const credDef = p.credentials.find(c=>c.key===ck)
                      return (
                        <div key={ck} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 10px", background:"var(--bg)", borderRadius:6, border:"1px solid var(--border)", marginBottom:5 }}>
                          <span style={{ fontSize:11 }}>⟨⟩</span>
                          <div>
                            <div style={{ fontSize:11, color:"var(--text)", fontFamily:"var(--font-ui)", fontWeight:500 }}>{credDef?.label ?? ck}</div>
                            {credDef?.description && <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{credDef.description}</div>}
                          </div>
                          <Mono size={8} color="var(--dim)" style={{ marginLeft:"auto" }}>{credDef?.type ?? "secret"}</Mono>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Credentials schema ─────────────────────────────────────────────── */}
      {p.credentials.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <div style={{ fontSize:13, fontWeight:600, color:"var(--muted)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:12 }}>Credential Schemas</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {p.credentials.map(c => (
              <div key={c.key} style={{ background:"var(--panel)", borderRadius:8, border:"1px solid var(--border)", padding:"12px 16px", display:"flex", alignItems:"flex-start", gap:14 }}>
                <div style={{ fontSize:18, marginTop:2 }}>⟨⟩</div>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)" }}>{c.label}</span>
                    <Mono size={8} color="var(--purple)">{c.type}</Mono>
                  </div>
                  {c.description && <div style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>{c.description}</div>}
                </div>
                <code style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--dim)", background:"var(--bg)", padding:"2px 7px", borderRadius:4, border:"1px solid var(--border)", flexShrink:0 }}>{c.key}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty node state ───────────────────────────────────────────────── */}
      {p.nodes.length === 0 && (
        <div style={{ padding:"32px 24px", background:"var(--panel)", borderRadius:10, border:"1px solid var(--border)", textAlign:"center" }}>
          <div style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.7 }}>
            This plugin declares no nodes. Make sure the <code style={{ fontFamily:"var(--font-mono)", fontSize:10 }}>manifest.json</code> contains a <code style={{ fontFamily:"var(--font-mono)", fontSize:10 }}>nodes</code> array.
          </div>
        </div>
      )}
    </div>
  )
}

export const FlowsPage = ({ onViewExec, onEditFlow, onOpenTemplates }) => {
  const [flows, setFlows] = useState(FLOWS)
  const [apiFlows, setApiFlows] = useState(null)  // null = not yet fetched
  const [loadingFlows, setLoadingFlows] = useState(false)
  const [newMenu, setNewMenu] = useState(false)
  const [filter, setFilter] = useState("")
  const [statusF, setStatusF] = useState("all")
  const [tagF,    setTagF]    = useState(null)
  const [confirmDisable, setConfirmDisable] = useState(null)
  const [dotMenu, setDotMenu] = useState(null)

  // Fetch from real API on mount; fall back to mock data silently
  useEffect(() => {
    setLoadingFlows(true)
    flowApi.list()
      .then(data => {
        // API returns { flows: FlowSummary[] }
        const apiList = (data.flows ?? []).map(f => ({
          ...f,
          _enabled: f.activated !== false,
          _triggerCount: f.triggerCount ?? 0,
          tags: f.tags ?? [],
        }))
        setFlows(apiList.length > 0 ? apiList : FLOWS)
        setApiFlows(apiList)
        setApiOnline(true)
      })
      .catch(() => {
        setApiOnline(false)
        // keep FLOWS mock data
      })
      .finally(() => setLoadingFlows(false))
  }, [])

  // All unique tags across all flows
  const allTags = [...new Set(flows.flatMap(f => f.tags))].sort()

  const filtered = flows.filter(f => {
    if (statusF === "enabled"  && !f._enabled) return false
    if (statusF === "disabled" &&  f._enabled) return false
    if (tagF && !f.tags.includes(tagF)) return false
    if (filter) {
      const q = filter.toLowerCase()
      return f.name.toLowerCase().includes(q) || f.description?.toLowerCase().includes(q) || f.tags.some(t => t.includes(q))
    }
    return true
  })

  const toggleFlow = async (id, enable) => {
    const f = flows.find(f => f.id === id)
    if (!enable && f?._triggerCount > 0) { setConfirmDisable(id); return }
    // Optimistic update
    setFlows(prev => prev.map(fl => fl.id === id ? {...fl, _enabled: enable} : fl))
    // API call
    try {
      if (enable) {
        await flowApi.activate(id)
        toast.success("Flow enabled", { detail: f?.name })
      } else {
        await flowApi.deactivate(id)
        toast.warning("Flow disabled", { detail: f?.name })
      }
      setApiOnline(true)
    } catch(e) {
      // Revert optimistic update on failure
      setFlows(prev => prev.map(fl => fl.id === id ? {...fl, _enabled: !enable} : fl))
      toast.error("Failed to update flow", { detail: e.message })
      setApiOnline(false)
    }
  }

  const confirmToggleOff = async (id) => {
    const f = flows.find(f => f.id === id)
    setFlows(prev => prev.map(fl => fl.id === id ? {...fl, _enabled: false} : fl))
    setConfirmDisable(null)
    try {
      await flowApi.deactivate(id)
      toast.warning("Flow disabled", { detail: f?.name })
    } catch(e) {
      setFlows(prev => prev.map(fl => fl.id === id ? {...fl, _enabled: true} : fl))
      toast.error("Failed to disable flow", { detail: e.message })
    }
  }

  const deleteFlow = async (id) => {
    const f = flows.find(f => f.id === id)
    setFlows(prev => prev.filter(fl => fl.id !== id))
    setDotMenu(null)
    try {
      await flowApi.delete(id)
      toast.info("Flow deleted", { detail: f?.name })
    } catch(e) {
      // Restore on failure
      setFlows(prev => [...prev, f])
      toast.error("Failed to delete flow", { detail: e.message })
    }
  }

  const enabledCount  = flows.filter(f => f._enabled).length
  const disabledCount = flows.filter(f => !f._enabled).length

  const createNewFlow = async () => {
    const id   = `flow_${Date.now().toString(36)}`
    const stub = { id, name:"Untitled Flow", version:"1.0.0", description:"", tags:[], nodes:[], edges:[], workspaceId:"ws_1" }
    CANVAS_FLOWS[id] = stub
    onEditFlow(id)
    // Fire-and-forget — the editor's own save() will POST properly on first save
    // Here we just pre-register so the flow list refreshes on next load
    flowApi.create({ id, name:"Untitled Flow", version:"1.0.0", workspaceId:"ws_1", nodes:{}, edges:[] })
      .then(() => setApiOnline(true))
      .catch(() => {}) // silently ignore — will be created on first explicit save
  }

  return (
    <div className="page-enter" style={{ display:"flex", flexDirection:"column", minHeight:"100vh" }}>

      {/* Confirm-disable modal */}
      {confirmDisable && (() => {
        const f = flows.find(x => x.id === confirmDisable)
        return (
          <div style={{
            position:"fixed", inset:0, zIndex:200,
            background:"rgba(8,10,15,0.8)", backdropFilter:"blur(4px)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <div className="page-enter" style={{
              background:"var(--panel)", border:"1px solid var(--border2)",
              borderRadius:10, width:420, padding:"26px 28px",
              boxShadow:"0 24px 64px rgba(0,0,0,0.6)",
            }}>
              <div style={{ fontSize:16, fontFamily:"var(--font-head)", fontWeight:700, color:"var(--text)", marginBottom:8 }}>
                Disable Flow?
              </div>
              <div style={{ fontSize:13, color:"var(--muted)", marginBottom:16, lineHeight:1.7 }}>
                <strong style={{color:"var(--text)"}}>{f?.name}</strong> has {f?._triggerCount} active trigger{f?._triggerCount!==1?"s":""}.
                Disabling will call <Mono size={11}>registry.deregisterFlow()</Mono> — no new executions will start
                until it is re-enabled. In-flight executions are not affected.
              </div>
              <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
                <Btn variant="ghost" onClick={() => setConfirmDisable(null)}>Cancel</Btn>
                <Btn variant="danger" onClick={() => confirmToggleOff(confirmDisable)}>Disable Flow</Btn>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Scrollable content */}
      <div style={{ flex:1, padding:"32px 28px 24px", maxWidth:1200, paddingBottom:80 }}>

      <SectionHeader
        children="Flows"
        action={
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <input
              value={filter} onChange={e=>setFilter(e.target.value)}
              placeholder="Search flows…"
              style={{
                background:"var(--panel)", border:"1px solid var(--border2)",
                borderRadius:5, padding:"5px 12px",
                fontSize:13, color:"var(--text)", outline:"none",
                fontFamily:"var(--font-ui)", width:180,
              }}
            />
            {["all","enabled","disabled"].map(s => (
              <button key={s} onClick={() => setStatusF(s)} style={{
                padding:"2px 10px", borderRadius:20, cursor:"pointer",
                fontSize:11, fontFamily:"var(--font-ui)", fontWeight: statusF===s ? 600 : 400,
                background: "transparent",
                border: `1px solid ${statusF===s ? "var(--cyan)" : "var(--border2)"}`,
                color: statusF===s ? "var(--cyan)" : "var(--muted)",
                transition:"all 0.1s", textTransform:"capitalize",
              }}>{s}</button>
            ))}
            <div style={{ position:"relative" }}>
              <div style={{ display:"flex", gap:0, borderRadius:6, overflow:"hidden", border:"1px solid var(--cyan)44" }}>
                <Btn variant="primary" style={{ borderRadius:0, borderRight:"1px solid var(--cyan)33" }}
                  onClick={createNewFlow}>+ New Flow</Btn>
                <button
                  onClick={()=>setNewMenu(v=>!v)}
                  style={{ padding:"0 10px", background:"var(--cyan)22", border:"none", cursor:"pointer",
                    color:"var(--cyan)", fontSize:11, borderRadius:0 }}>
                  ▾
                </button>
              </div>
              {newMenu && (
                <div style={{ position:"absolute", top:"calc(100% + 4px)", right:0, zIndex:50,
                  background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:8,
                  boxShadow:"0 8px 32px rgba(0,0,0,0.4)", minWidth:180, overflow:"hidden" }}
                  onMouseLeave={()=>setNewMenu(false)}>
                  <button onClick={()=>{ setNewMenu(false); createNewFlow() }}
                    style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 16px", background:"none", border:"none", cursor:"pointer",
                      fontSize:13, fontFamily:"var(--font-ui)", color:"var(--text)", borderBottom:"1px solid var(--border)" }}
                    onMouseEnter={e=>e.currentTarget.style.background="var(--surface)"}
                    onMouseLeave={e=>e.currentTarget.style.background="none"}>
                    ◻ Blank Flow
                  </button>
                  <button onClick={()=>{ setNewMenu(false); onOpenTemplates && onOpenTemplates() }}
                    style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 16px", background:"none", border:"none", cursor:"pointer",
                      fontSize:13, fontFamily:"var(--font-ui)", color:"var(--cyan)" }}
                    onMouseEnter={e=>e.currentTarget.style.background="var(--surface)"}
                    onMouseLeave={e=>e.currentTarget.style.background="none"}>
                    ◈ From Template…
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />

      {/* Flow table */}
      <Table
        cols={[
          {
            key:"name", label:"Flow",
            render: f => (
              <div style={{ opacity: f._enabled ? 1 : 0.55 }}>
                <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:3 }}>
                  <StatusDot status={f._enabled ? "active" : "inactive"} size={7} />
                  <span style={{ fontSize:14, fontWeight:500, color:"var(--text)" }}>{f.name}</span>
                  {!f._enabled && (
                    <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--red)",
                      background:"var(--red)18", border:"1px solid var(--red)33",
                      padding:"1px 5px", borderRadius:2 }}>DISABLED</span>
                  )}
                </div>
                <div style={{ fontSize:12, color:"var(--muted)" }}>{f.description}</div>
                {tagF && f.tags.includes(tagF) && (
                  <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginTop:5 }}>
                    {f.tags.map(t => (
                      <span key={t} onClick={e=>{e.stopPropagation();setTagF(tagF===t?null:t)}} style={{ cursor:"pointer" }}>
                        <Tag label={t} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          },
          {
            key:"lastRun", label:"Last Run",
            render: f => (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <StatusPill status={f._lastStatus} />
                <Mono color="var(--muted)" size={11}>{fmt.time(now - f._lastRun)}</Mono>
              </div>
            )
          },
          {
            key:"triggers", label:"Triggers",
            render: f => (
              <TriggerChips
                triggers={f._triggers}
                enabled={f._enabled}
                onRun={() => toast.success("Flow triggered manually", { detail: f.name })}
              />
            )
          },
          {
            key:"actions", label:"",
            render: f => (
              <div style={{ display:"flex", gap:6, alignItems:"center" }} onClick={e=>e.stopPropagation()}>
                <Btn small variant="primary" onClick={() => onEditFlow(f.id)}>Edit</Btn>
                {/* ⋯ context menu */}
                <div style={{ position:"relative" }}>
                  <button
                    onClick={e => { e.stopPropagation(); setDotMenu(dotMenu === f.id ? null : f.id) }}
                    style={{ background:"none", border:"1px solid transparent", borderRadius:4, cursor:"pointer",
                      color:"var(--muted)", fontSize:16, lineHeight:1, padding:"2px 6px",
                      transition:"all 0.1s",
                    }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--text)"}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="transparent";e.currentTarget.style.color="var(--muted)"}}>
                    ⋯
                  </button>
                  {dotMenu === f.id && (
                    <>
                      <div style={{ position:"fixed", inset:0, zIndex:49 }} onClick={()=>setDotMenu(null)} />
                      <div style={{
                        position:"absolute", right:0, top:"calc(100% + 4px)", zIndex:50,
                        background:"var(--panel)", border:"1px solid var(--border2)",
                        borderRadius:8, overflow:"hidden", minWidth:160,
                        boxShadow:"0 8px 32px rgba(0,0,0,0.4)",
                        animation:"fadeIn 0.1s ease-out",
                      }}>
                        {[
                          { label:"View Executions", icon:"◎", action:()=>{ onViewExec(f.id); setDotMenu(null) } },
                          { label:`v${f.version}`, icon:"⊙", action:null, muted:true },
                          { label:`${fmt.duration(f._avgDuration)} avg · ${fmt.num(f._totalRuns)} runs`, icon:"⏱", action:null, muted:true },
                          null,
                          f._enabled
                            ? { label:"Disable", icon:"⏸", action:()=>{ toggleFlow(f.id, false); setDotMenu(null) } }
                            : { label:"Enable",  icon:"▶", action:()=>{ toggleFlow(f.id, true);  setDotMenu(null) } },
                          null,
                          { label:"Duplicate", icon:"⧉", action:()=>{ toast.info("Duplicate — coming soon"); setDotMenu(null) } },
                          { label:"Copy Flow ID", icon:"⌗", action:()=>{
                            navigator.clipboard?.writeText(f.id)
                            toast.success("Copied", { detail: f.id })
                            setDotMenu(null)
                          }},
                          null,
                          { label:"Delete", icon:"×", danger:true, action:()=>{ deleteFlow(f.id); setDotMenu(null) } },
                        ].map((item, i) => item === null ? (
                          <div key={`div-${i}`} style={{ height:1, background:"var(--border)", margin:"2px 0" }} />
                        ) : (
                          <button key={item.label}
                            onClick={item.action ?? undefined}
                            disabled={!item.action}
                            style={{
                              display:"flex", alignItems:"center", gap:9, width:"100%",
                              padding:"8px 14px", background:"none", border:"none",
                              cursor: item.action ? "pointer" : "default",
                              fontSize:13, fontFamily:"var(--font-ui)", textAlign:"left",
                              color: item.danger ? "var(--red)" : item.muted ? "var(--dim)" : "var(--text)",
                              transition:"background 0.1s",
                            }}
                            onMouseEnter={e=>{ if(item.action) e.currentTarget.style.background="var(--surface)" }}
                            onMouseLeave={e=>{ e.currentTarget.style.background="none" }}>
                            <span style={{ fontSize:12, width:14, textAlign:"center", opacity:0.6 }}>{item.icon}</span>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          },
        ]}
        rows={filtered}
      />
      {filtered.length === 0 && (
        <div style={{ textAlign:"center", padding:"56px 20px" }}>
          <div style={{ fontSize:32, marginBottom:12, opacity:0.2 }}>⬡</div>
          <div style={{ fontSize:14, color:"var(--muted)", fontFamily:"var(--font-ui)", marginBottom:8 }}>
            {filter || tagF || statusF !== "all"
              ? "No flows match the current filters."
              : "No flows yet."}
          </div>
          {(filter || tagF || statusF !== "all") && (
            <Btn variant="ghost" small onClick={()=>{setFilter("");setTagF(null);setStatusF("all")}}>
              Clear filters
            </Btn>
          )}
          {!filter && !tagF && statusF === "all" && (
            <Btn variant="primary" small onClick={createNewFlow}>
              + Create your first flow
            </Btn>
          )}
        </div>
      )}

      </div>{/* end scrollable content */}

      {/* ── Sticky bottom bar ── */}
      <div style={{
        position:"sticky", bottom:0,
        background:"var(--surface)",
        borderTop:"1px solid var(--border)",
        padding:"10px 28px",
        display:"flex", alignItems:"center", gap:16,
        zIndex:10,
      }}>
        {/* Tag filter — collapsed until a tag is active */}
        <div style={{ display:"flex", gap:5, alignItems:"center", flex:1 }}>
          {tagF ? (
            <>
              <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)",
                textTransform:"uppercase", letterSpacing:"0.06em", flexShrink:0 }}>Tag</span>
              {allTags.map(t => (
                <button key={t} onClick={()=>setTagF(tagF===t?null:t)} style={{
                  padding:"2px 9px", borderRadius:10, cursor:"pointer", fontSize:11,
                  fontFamily:"var(--font-ui)", border:"1px solid",
                  background: tagF===t ? "var(--cyan)18" : "transparent",
                  borderColor: tagF===t ? "var(--cyan)55" : "var(--border2)",
                  color: tagF===t ? "var(--cyan)" : "var(--muted)",
                  transition:"all 0.1s",
                }}>{t}</button>
              ))}
              <button onClick={()=>setTagF(null)} style={{
                fontSize:10, color:"var(--dim)", background:"none",
                border:"none", cursor:"pointer", fontFamily:"var(--font-ui)",
              }}>clear ×</button>
            </>
          ) : (
            <div style={{ position:"relative" }}>
              <button
                onClick={e => {
                  // show a small flyup with all tags
                  e.currentTarget.nextSibling.style.display =
                    e.currentTarget.nextSibling.style.display === "none" ? "flex" : "none"
                }}
                style={{ display:"flex", alignItems:"center", gap:5, padding:"2px 9px", borderRadius:10,
                  cursor:"pointer", fontSize:11, fontFamily:"var(--font-ui)",
                  background:"transparent", border:"1px solid var(--border2)", color:"var(--dim)", transition:"all 0.1s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}
                onMouseLeave={e=>{e.currentTarget.style.color="var(--dim)"}}
              >
                ⊞ Tags
              </button>
              {/* Tag flyup */}
              <div style={{ display:"none", position:"absolute", bottom:"calc(100% + 8px)", left:0,
                background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:8, padding:"10px 12px",
                boxShadow:"0 8px 24px rgba(0,0,0,0.35)", gap:6, flexWrap:"wrap", minWidth:200, zIndex:40 }}>
                {allTags.map(t => (
                  <button key={t} onClick={e=>{ setTagF(t); e.currentTarget.closest('[style*="position:absolute"]').style.display="none" }}
                    style={{ padding:"3px 10px", borderRadius:10, cursor:"pointer", fontSize:11,
                      fontFamily:"var(--font-ui)", background:"transparent",
                      border:"1px solid var(--border2)", color:"var(--muted)", transition:"all 0.1s" }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)"}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}
                  >{t}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ width:1, height:28, background:"var(--border)", flexShrink:0 }} />

        {/* Summary stats */}
        <div style={{ display:"flex", gap:20, alignItems:"center", flexShrink:0 }}>
          {[
            { label:"Active",       value:enabledCount,  color:"var(--green)" },
            { label:"Disabled",     value:disabledCount, color: disabledCount > 0 ? "var(--red)" : "var(--dim)" },
            { label:"Triggers",     value:flows.filter(f=>f._enabled).reduce((s,f)=>s+f._triggerCount,0), color:"var(--cyan)" },
            { label:"Runs today",   value:"1,842",       color:"var(--text)" },
            { label:"Failure rate", value:"3.2%",        color:"var(--amber)" },
          ].map(s => (
            <div key={s.label} style={{ display:"flex", alignItems:"baseline", gap:5 }}>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:14, fontWeight:600, color:s.color }}>{s.value}</span>
              <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

// ─── EXECUTIONS PAGE ────────────────────────────────────────────────────────
// ─── EXECUTIONS PAGE ────────────────────────────────────────────────────────

export const ExecutionDetail = ({ exec: execProp, onBack }) => {
  const [exec, setExec]       = useState(execProp)
  const [selNode, setSelNode] = useState(null)
  const [cancelling, setCancelling]   = useState(false)
  const [replayModal, setReplayModal] = useState(false)
  const [replaying,   setReplaying]   = useState(false)
  const [replayDone,  setReplayDone]  = useState(null)  // new executionId after replay

  // Live SSE feed — simulates GET /executions/:id/stream (SchedulerEvent stream)
  const [liveEvents, setLiveEvents] = useState([])

  useEffect(() => {
    if (exec.status !== "running") return
    const SCRIPT = [
      { t:400,  event:"node:started",       nodeId:"scoreLead",   stage:1 },
      { t:1600, event:"node:completed",     nodeId:"fetchLead",   stage:0, durationMs:200  },
      { t:2200, event:"stage:completed",    stage:0 },
      { t:2800, event:"node:started",       nodeId:"enrichLead",  stage:1 },
      { t:4100, event:"node:completed",     nodeId:"scoreLead",   stage:1, durationMs:2300, output:{ score:0.87, label:"hot" } },
      { t:5600, event:"node:completed",     nodeId:"enrichLead",  stage:1, durationMs:2800, output:{ employees:340, industry:"SaaS" } },
      { t:5700, event:"stage:completed",    stage:1 },
      { t:6000, event:"node:started",       nodeId:"notifySlack", stage:2 },
      { t:7200, event:"node:completed",     nodeId:"notifySlack", stage:2, durationMs:1200, output:{ ok:true } },
      { t:7300, event:"stage:completed",    stage:2 },
      { t:7500, event:"execution:completed",durationMs:7500 },
    ]
    const timers = SCRIPT.map(ev => setTimeout(() => {
      setLiveEvents(prev => [...prev, { id: Date.now() + Math.random(), ts: Date.now(), ...ev }])
      if (ev.event === "execution:completed") {
        setExec(e => ({ ...e, status:"completed", endedAt:Date.now(), durationMs:7500 }))
      } else if (ev.event === "node:completed" && ev.output) {
        setExec(e => ({
          ...e,
          nodeStates:  { ...e.nodeStates,  [ev.nodeId]: { ...e.nodeStates[ev.nodeId],  status:"completed", output:ev.output } },
          nodeTimings: { ...e.nodeTimings, [ev.nodeId]: ev.durationMs },
        }))
      } else if (ev.event === "node:started") {
        setExec(e => ({ ...e, nodeStates: { ...e.nodeStates, [ev.nodeId]: { ...e.nodeStates[ev.nodeId], status:"running" } } }))
      }
    }, ev.t))
    return () => timers.forEach(clearTimeout)
  }, [])

  const nodeState = selNode ? exec.nodeStates[selNode] : null
  const flowDef = FLOWS.find(f => f.id === exec.flowId)

  const cancelExecution = () => {
    setCancelling(true)
    // Simulate async cancel call — in production: POST /executions/:id/cancel
    setTimeout(() => {
      setExec(e => ({
        ...e,
        status: "cancelled",
        endedAt: Date.now(),
        durationMs: Date.now() - e.startedAt,
        nodeStates: Object.fromEntries(
          Object.entries(e.nodeStates).map(([id, s]) => [
            id,
            s.status === "running" || s.status === "pending"
              ? { ...s, status: "skipped", error: s.status === "running" ? "Cancelled by user" : undefined }
              : s
          ])
        ),
      }))
      setCancelling(false)
    }, 600)
  }

  const replayExecution = () => {
    setReplaying(true)
    // In production: POST /flows/:id/trigger with exec.finalContext as payload
    // The backend creates a new ExecutionJob with resumeFrom populated from finalContext
    setTimeout(() => {
      const newId = `exec_replay_${Date.now().toString(36)}`
      setReplayDone(newId)
      setReplaying(false)
      setReplayModal(false)
    }, 700)
  }

  // Stage duration ranges for timeline bar widths
  const maxDur = Math.max(...Object.values(exec.nodeTimings), 1)

  return (
    <div className="page-enter" style={{ padding:"32px 28px" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:24 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <Btn variant="ghost" onClick={onBack}>← Back</Btn>
          <div style={{ height:16, width:1, background:"var(--border2)" }} />
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontFamily:"var(--font-head)", fontSize:16, fontWeight:700, color:"var(--text)" }}>
                {flowDef?.name ?? exec.flowId}
              </span>
              <StatusPill status={exec.status} />
              {exec.status === "cancelled" && (
                <span style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-mono)" }}>cancelled by user</span>
              )}
              {exec.error && exec.status !== "cancelled" && (
                <span style={{ fontSize:12, color:"var(--red)", fontFamily:"var(--font-mono)" }}>
                  {exec.error}
                </span>
              )}
            </div>
            <div style={{ display:"flex", gap:14, marginTop:3 }}>
              <Mono color="var(--muted)" size={11}>{exec.executionId}</Mono>
              <Mono color="var(--muted)" size={11}>v{exec.version}</Mono>
              <Mono color="var(--muted)" size={11}>{exec.durationMs ? fmt.duration(exec.durationMs) : "running…"}</Mono>
              <Mono color="var(--muted)" size={11}>{fmt.time(now - exec.startedAt)}</Mono>
              <Mono color="var(--muted)" size={11}>
                trigger: {typeof exec.trigger === "object" ? (exec.trigger.type ?? exec.trigger.path ?? "unknown") : exec.trigger}
              </Mono>
            </div>
          </div>
        </div>
        {/* Header action buttons */}
        <div style={{ display:"flex", gap:8, flexShrink:0 }}>
          {exec.status === "running" && (
            <Btn variant="danger" onClick={cancelExecution}>
              {cancelling ? "Cancelling…" : "⏹ Cancel"}
            </Btn>
          )}
          {(exec.status === "completed" || exec.status === "failed" || exec.status === "cancelled") && (
            <Btn variant="default" onClick={() => setReplayModal(true)}>⟲ Replay</Btn>
          )}
        </div>
      </div>

      {/* Replay modal */}
      {replayModal && (
        <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(8,10,15,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget)setReplayModal(false)}}>
          <div className="page-enter" style={{background:"var(--panel)",border:"1px solid var(--border2)",borderRadius:10,width:480,padding:"26px 28px",boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
            <div style={{fontFamily:"var(--font-head)",fontSize:16,fontWeight:700,color:"var(--text)",marginBottom:6}}>Replay Execution</div>
            <div style={{fontSize:13,color:"var(--muted)",marginBottom:16,lineHeight:1.7}}>
              A new execution will be created using the <Mono size={11}>finalContext</Mono> snapshot from this run as the trigger payload.
              This is equivalent to <Mono size={11}>POST /flows/{exec.flowId}/trigger</Mono> with the original context injected.
            </div>
            <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:6,padding:"12px 14px",marginBottom:16}}>
              <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:8}}>Final Context Snapshot</div>
              <pre style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--green)",lineHeight:1.6,maxHeight:140,overflow:"auto"}}>
                {JSON.stringify(
                  Object.keys(exec.nodeStates).reduce((acc,id) => ({...acc, [id]: exec.nodeStates[id].output ?? null}), {}),
                  null, 2
                )}
              </pre>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:12,color:"var(--muted)"}}>Trigger: <Mono size={11}>{typeof exec.trigger==="object"?exec.trigger.type:"manual"}</Mono></div>
              <div style={{display:"flex",gap:8}}>
                <Btn variant="ghost" onClick={()=>setReplayModal(false)}>Cancel</Btn>
                <Btn variant="primary" onClick={replayExecution}>{replaying ? "Replaying…" : "⟲ Replay"}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {replayDone && (
        <div style={{
          background:"var(--green)0a", border:"1px solid var(--green)33",
          borderRadius:7, padding:"12px 16px", marginBottom:16,
          display:"flex", alignItems:"center", gap:14,
        }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, color:"var(--green)", fontWeight:500, marginBottom:2 }}>
              ✓ Replay queued — new execution will appear in the Executions list
            </div>
            <Mono size={11} color="var(--muted)">{replayDone}</Mono>
          </div>
          <Btn small variant="ghost" onClick={() => setReplayDone(null)}>Dismiss</Btn>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 360px", gap:20 }}>
        {/* Left: Stage view + node grid */}
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

          {/* Stage timeline */}
          <Card>
            <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14 }}>
              Stage Timeline
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {exec._stages.map(stage => (
                <div key={stage.index} style={{ display:"grid", gridTemplateColumns:"64px 1fr", gap:10, alignItems:"start" }}>
                  <div style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted)", paddingTop:5 }}>
                    Stage {stage.index}
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                    {stage.nodes.map(nodeId => {
                      const dur = exec.nodeTimings[nodeId] ?? 0
                      const s = exec.nodeStates[nodeId]
                      const pct = Math.max(4, (dur / maxDur) * 100)
                      return (
                        <div key={nodeId}
                          onClick={() => setSelNode(nodeId === selNode ? null : nodeId)}
                          style={{
                            display:"flex", alignItems:"center", gap:10, cursor:"pointer",
                            padding:"3px 0",
                          }}>
                          <div style={{ width:120, fontFamily:"var(--font-mono)", fontSize:12, color: selNode===nodeId ? "var(--cyan)" : "var(--text)", flexShrink:0 }}>
                            {nodeId}
                          </div>
                          <div style={{ flex:1, height:20, background:"var(--surface)", borderRadius:3, overflow:"hidden" }}>
                            <div style={{
                              height:"100%", width:`${pct}%`,
                              background: s?.status==="failed" ? "var(--red)55"
                                        : s?.status==="skipped" ? "var(--dim)"
                                        : s?.fromCache ? "var(--purple)55"
                                        : "var(--cyan)33",
                              borderRight: `2px solid ${
                                s?.status==="failed" ? "var(--red)"
                                : s?.status==="skipped" ? "var(--muted)"
                                : s?.fromCache ? "var(--purple)"
                                : "var(--cyan)"}`,
                              transition:"width 0.3s ease",
                            }}/>
                          </div>
                          <div style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted)", width:45, textAlign:"right" }}>
                            {dur ? fmt.duration(dur) : "—"}
                          </div>
                          <StatusDot status={s?.status ?? "pending"} size={6} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            {/* Legend */}
            <div style={{ display:"flex", gap:16, marginTop:14, paddingTop:12, borderTop:"1px solid var(--border)" }}>
              {[
                ["var(--cyan)", "Success"],
                ["var(--purple)", "Cache hit"],
                ["var(--red)", "Failed"],
                ["var(--dim)", "Skipped"],
              ].map(([color, label]) => (
                <div key={label} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, color:"var(--muted)" }}>
                  <div style={{ width:20, height:3, background:color, borderRadius:2 }} />
                  {label}
                </div>
              ))}
            </div>
          </Card>

          {/* Live Event Feed — shown while running or after stream closes */}
          {(exec.status === "running" || liveEvents.length > 0) && (
            <Card>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)" }}>
                  Live Event Stream
                </div>
                {exec.status === "running" && (
                  <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, fontFamily:"var(--font-mono)", color:"var(--green)" }}>
                    <span style={{ width:6, height:6, borderRadius:"50%", background:"var(--green)", display:"inline-block", animation:"pulse 1.2s ease-in-out infinite" }}/>
                    SSE connected
                  </span>
                )}
                {exec.status !== "running" && liveEvents.length > 0 && (
                  <span style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--dim)" }}>stream closed</span>
                )}
              </div>
              <div style={{
                background:"var(--bg)", border:"1px solid var(--border)", borderRadius:5,
                padding:"6px 0", maxHeight:190, overflowY:"auto",
                fontFamily:"var(--font-mono)", fontSize:11,
              }}>
                {liveEvents.length === 0 ? (
                  <div style={{ padding:"8px 14px", color:"var(--dim)" }}>Waiting for events…</div>
                ) : liveEvents.map(ev => {
                  const color = ev.event.startsWith("execution:") ? "var(--cyan)"
                              : ev.event === "node:completed"   ? "var(--green)"
                              : ev.event === "node:failed"      ? "var(--red)"
                              : ev.event === "stage:completed"  ? "var(--purple)"
                              : "var(--text)"
                  return (
                    <div key={ev.id} style={{ padding:"3px 14px", display:"flex", gap:10, alignItems:"baseline", borderBottom:"1px solid var(--border)0a" }}>
                      <span style={{ color:"var(--dim)", flexShrink:0, width:38, textAlign:"right" }}>
                        +{((ev.ts - (liveEvents[0]?.ts ?? ev.ts))/1000).toFixed(2)}s
                      </span>
                      <span style={{ color, flex:1 }}>
                        <span style={{ opacity:0.7 }}>{ev.event}</span>
                        {ev.nodeId  && <span style={{ color:"var(--cyan)",   marginLeft:6 }}>{ev.nodeId}</span>}
                        {ev.stage != null && !ev.nodeId && <span style={{ color:"var(--purple)", marginLeft:6 }}>stage:{ev.stage}</span>}
                        {ev.durationMs != null && <span style={{ color:"var(--muted)", marginLeft:8 }}>{ev.durationMs}ms</span>}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Card>
          )}

          {/* Node states grid */}
          <Card>
            <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14 }}>
              Node States
            </div>
            <Table
              cols={[
                { key:"node", label:"Node",
                  render:([id]) => (
                    <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color: selNode===id ? "var(--cyan)" : "var(--text)" }}>
                      {id}
                    </span>
                  )
                },
                { key:"status", label:"Status",
                  render:([, s]) => <StatusPill status={s.status} />
                },
                { key:"dur", label:"Duration",
                  render:([id]) => <Mono>{exec.nodeTimings[id] ? fmt.duration(exec.nodeTimings[id]) : "—"}</Mono>
                },
                { key:"attempts", label:"Attempts",
                  render:([, s]) => <Mono color={s.attempts>1?"var(--amber)":"var(--muted)"}>{s.attempts||"—"}</Mono>
                },
                { key:"cache", label:"Cache",
                  render:([, s]) => (
                    <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color: s.fromCache ? "var(--purple)" : "var(--muted)" }}>
                      {s.fromCache ? "HIT" : "MISS"}
                    </span>
                  )
                },
                { key:"error", label:"Error",
                  render:([, s]) => s.error
                    ? <span style={{ fontSize:12, color:"var(--red)", fontFamily:"var(--font-mono)" }}>{s.error.slice(0,40)}…</span>
                    : <span style={{ color:"var(--dim)" }}>—</span>
                },
              ]}
              rows={Object.entries(exec.nodeStates)}
              onRowClick={([id]) => setSelNode(id === selNode ? null : id)}
            />
          </Card>
        </div>

        {/* Right: Node detail panel */}
        <div style={{ position:"sticky", top:72 }}>
          {nodeState ? (
            <Card style={{ display:"flex", flexDirection:"column", gap:16 }}>
              <div>
                <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:6 }}>Selected Node</div>
                <div style={{ fontFamily:"var(--font-mono)", fontSize:16, color:"var(--cyan)", marginBottom:6 }}>{selNode}</div>
                <StatusPill status={nodeState.status} />
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[
                  ["Duration",  exec.nodeTimings[selNode] ? fmt.duration(exec.nodeTimings[selNode]) : "—"],
                  ["Attempts",  nodeState.attempts],
                  ["Cache",     nodeState.fromCache ? "HIT" : "MISS"],
                  ["Logs",      nodeState.logs?.length ?? 0],
                ].map(([k,v]) => (
                  <div key={k} style={{ background:"var(--surface)", borderRadius:5, padding:"8px 10px" }}>
                    <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>{k}</div>
                    <div style={{ fontFamily:"var(--font-mono)", fontSize:13, color:"var(--text)" }}>{v}</div>
                  </div>
                ))}
              </div>

              {nodeState.error && (
                <div style={{
                  background:"var(--red)0d", border:"1px solid var(--red)33",
                  borderRadius:5, padding:"10px 12px",
                  fontFamily:"var(--font-mono)", fontSize:12, color:"var(--red)", lineHeight:1.6,
                }}>
                  {nodeState.error}
                </div>
              )}

              {nodeState.output != null && (
                <div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>Output</div>
                  <pre style={{
                    background:"var(--surface)", border:"1px solid var(--border)",
                    borderRadius:5, padding:"10px 12px",
                    fontFamily:"var(--font-mono)", fontSize:11, color:"var(--green)",
                    overflow:"auto", maxHeight:160, lineHeight:1.6,
                  }}>
                    {JSON.stringify(nodeState.output, null, 2)}
                  </pre>
                </div>
              )}

              {nodeState.logs?.length > 0 && (
                <div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em" }}>Logs</div>
                  <div style={{
                    background:"var(--surface)", border:"1px solid var(--border)",
                    borderRadius:5, padding:"10px 12px", maxHeight:140, overflow:"auto",
                  }}>
                    {nodeState.logs.map((l,i) => (
                      <div key={i} style={{ fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.8,
                        color: l.level==="error" ? "var(--red)" : l.level==="warn" ? "var(--amber)" : "var(--muted)" }}>
                        [{l.level}] {l.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <Card style={{ textAlign:"center", padding:"32px 20px" }}>
                <div style={{ fontSize:28, marginBottom:10 }}>⬡</div>
                <div style={{ fontSize:13, color:"var(--muted)" }}>Click a node to inspect its state, output, and logs</div>
              </Card>
              {typeof exec.trigger === "object" && (
                <Card>
                  <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:10 }}>
                    Trigger Detail
                  </div>
                  {(() => {
                    const t = exec.trigger
                    const color = t.type==="webhook"?"var(--cyan)":t.type==="cron"?"var(--amber)":t.type==="event"?"var(--purple)":"var(--muted)"
                    const rows = [
                      ["Type",    t.type],
                      ...(t.path       ? [["Path",         t.path]] : []),
                      ...(t.expression ? [["Expression",   t.expression]] : []),
                      ...(t.eventName  ? [["Event",        t.eventName]] : []),
                      ...(t.jitterMs   ? [["Jitter",       `${t.jitterMs}ms`]] : []),
                    ]
                    return (
                      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                        {rows.map(([k,v]) => (
                          <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <span style={{ fontSize:12, color:"var(--muted)" }}>{k}</span>
                            <Mono size={11} color={k==="Type" ? color : "var(--text)"}>{v}</Mono>
                          </div>
                        ))}
                        {t.payload && (
                          <div style={{ marginTop:4 }}>
                            <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.06em" }}>Payload</div>
                            <pre style={{ background:"var(--surface)", borderRadius:5, padding:"8px 10px", fontFamily:"var(--font-mono)", fontSize:10, color:"var(--green)", overflow:"auto", maxHeight:100, lineHeight:1.6 }}>
                              {JSON.stringify(t.payload, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </Card>
              )}

              {exec.status !== "running" && Object.keys(exec.finalContext ?? {}).length > 0 && (
                <Card>
                  <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:10 }}>
                    Final Context Snapshot
                  </div>
                  <div style={{ fontSize:12, color:"var(--muted)", marginBottom:8, lineHeight:1.6 }}>
                    Captured at completion — used as seed for ↺ Replay via <Mono size={10} color="var(--cyan)">resumeFrom</Mono>.
                  </div>
                  <pre style={{
                    background:"var(--surface)", border:"1px solid var(--border)",
                    borderRadius:5, padding:"10px 12px",
                    fontFamily:"var(--font-mono)", fontSize:11, color:"var(--green)",
                    overflow:"auto", maxHeight:220, lineHeight:1.6,
                  }}>
                    {JSON.stringify(exec.finalContext, null, 2)}
                  </pre>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ExecutionPreview — condensed panel shown in the 50/50 split ─────────────
export const ExecutionPreview = ({ exec: execProp, onClose, onDrilldown, onCancel, onReplay }) => {
  const [exec, setExec] = useState(execProp)
  const [selNode, setSelNode] = useState(null)
  const [liveEvents, setLiveEvents] = useState([])
  const flowDef = FLOWS.find(f => f.id === exec.flowId)
  const maxDur = Math.max(...Object.values(exec.nodeTimings ?? {}), 1)

  // Sync if parent swaps the exec
  useEffect(() => { setExec(execProp); setSelNode(null); setLiveEvents([]) }, [execProp.executionId])

  // Live SSE sim — mirrors ExecutionDetail
  useEffect(() => {
    if (exec.status !== "running") return
    const SCRIPT = [
      { t:400,  event:"node:started",       nodeId:"scoreLead",   stage:1 },
      { t:1600, event:"node:completed",     nodeId:"fetchLead",   stage:0, durationMs:200  },
      { t:2200, event:"stage:completed",    stage:0 },
      { t:2800, event:"node:started",       nodeId:"enrichLead",  stage:1 },
      { t:4100, event:"node:completed",     nodeId:"scoreLead",   stage:1, durationMs:2300, output:{ score:0.87, label:"hot" } },
      { t:5600, event:"node:completed",     nodeId:"enrichLead",  stage:1, durationMs:2800, output:{ employees:340, industry:"SaaS" } },
      { t:5700, event:"stage:completed",    stage:1 },
      { t:6000, event:"node:started",       nodeId:"notifySlack", stage:2 },
      { t:7200, event:"node:completed",     nodeId:"notifySlack", stage:2, durationMs:1200, output:{ ok:true } },
      { t:7500, event:"execution:completed", durationMs:7500 },
    ]
    const timers = SCRIPT.map(ev => setTimeout(() => {
      setLiveEvents(prev => [...prev, { id:Date.now()+Math.random(), ts:Date.now(), ...ev }])
      if (ev.event === "execution:completed") {
        setExec(e => ({ ...e, status:"completed", endedAt:Date.now(), durationMs:7500 }))
      } else if (ev.event === "node:completed" && ev.output) {
        setExec(e => ({
          ...e,
          nodeStates:  { ...e.nodeStates,  [ev.nodeId]: { ...e.nodeStates[ev.nodeId], status:"completed", output:ev.output } },
          nodeTimings: { ...e.nodeTimings, [ev.nodeId]: ev.durationMs },
        }))
      } else if (ev.event === "node:started") {
        setExec(e => ({ ...e, nodeStates: { ...e.nodeStates, [ev.nodeId]: { ...e.nodeStates[ev.nodeId], status:"running" } } }))
      }
    }, ev.t))
    return () => timers.forEach(clearTimeout)
  }, [exec.executionId])

  const nodeState = selNode ? exec.nodeStates[selNode] : null

  return (
    <div style={{
      display:"flex", flexDirection:"column", height:"100%",
      borderLeft:"1px solid var(--border)", background:"var(--bg)",
      overflow:"hidden",
    }}>
      {/* Panel header */}
      <div style={{
        display:"flex", alignItems:"center", gap:10,
        padding:"12px 18px", borderBottom:"1px solid var(--border)",
        background:"var(--panel)", flexShrink:0,
      }}>
        <div style={{ flex:1, minWidth:0 }}>
          {/* Flow name — click → drilldown */}
          <div
            onClick={onDrilldown}
            style={{
              fontSize:14, fontWeight:600, fontFamily:"var(--font-head)",
              color:"var(--cyan)", cursor:"pointer", letterSpacing:"-0.01em",
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
              marginBottom:2,
            }}
            title="Open full execution detail"
          >
            {flowDef?.name ?? exec.flowId} ↗
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <Mono size={10} color="var(--dim)">{exec.executionId}</Mono>
            <StatusPill status={exec.status} />
            {exec.replayOf && (
              <span style={{ fontSize:9, fontFamily:"var(--font-mono)", color:"var(--amber)", background:"var(--amber)12",
                border:"1px solid var(--amber)33", padding:"1px 5px", borderRadius:3 }}>
                replay
              </span>
            )}
            {exec.status === "running" && (
              <span style={{ display:"flex", alignItems:"center", gap:4, fontSize:10, fontFamily:"var(--font-mono)", color:"var(--green)" }}>
                <span style={{ width:5, height:5, borderRadius:"50%", background:"var(--green)", display:"inline-block", animation:"pulse 1.2s ease-in-out infinite" }}/>
                live
              </span>
            )}
          </div>
        </div>
        <div style={{ display:"flex", gap:5, flexShrink:0, alignItems:"center" }}>
          {exec.status === "running" && (
            <Btn small variant="danger" onClick={onCancel} title="Cancel execution">⏹ Cancel</Btn>
          )}
          {(exec.status === "completed" || exec.status === "failed" || exec.status === "cancelled") && (
            <Btn small variant="ghost" onClick={onReplay} title="Replay with same context">⟲ Replay</Btn>
          )}
          <Btn variant="ghost" small onClick={onDrilldown} style={{ fontSize:12 }}>Full detail →</Btn>
          <button onClick={onClose} style={{
            background:"none", border:"none", cursor:"pointer",
            color:"var(--muted)", fontSize:18, lineHeight:1, padding:"2px 4px",
          }}>×</button>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex:1, overflowY:"auto", padding:"16px 18px", display:"flex", flexDirection:"column", gap:14 }}>

        {/* Stage timeline */}
        <div style={{ background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:8, padding:"14px 16px" }}>
          <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:12 }}>Stage Timeline</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {(exec._stages ?? []).map(stage => (
              <div key={stage.index}>
                <div style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--dim)", marginBottom:4 }}>Stage {stage.index}</div>
                {stage.nodes.map(nodeId => {
                  const dur = exec.nodeTimings[nodeId] ?? 0
                  const s = exec.nodeStates[nodeId]
                  const pct = Math.max(4, (dur / maxDur) * 100)
                  const active = selNode === nodeId
                  return (
                    <div key={nodeId}
                      onClick={() => setSelNode(nodeId === selNode ? null : nodeId)}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 0", cursor:"pointer" }}
                    >
                      <div style={{ width:90, fontFamily:"var(--font-mono)", fontSize:11, color:active?"var(--cyan)":"var(--muted)", flexShrink:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {nodeId}
                      </div>
                      <div style={{ flex:1, height:14, background:"var(--surface)", borderRadius:2, overflow:"hidden" }}>
                        <div style={{
                          height:"100%", width:`${pct}%`, transition:"width 0.3s ease",
                          background: s?.status==="failed"  ? "var(--red)55"
                                    : s?.status==="skipped" ? "var(--dim)"
                                    : s?.fromCache          ? "var(--purple)55"
                                    : "var(--cyan)33",
                          borderRight:`2px solid ${s?.status==="failed"?"var(--red)":s?.status==="skipped"?"var(--muted)":s?.fromCache?"var(--purple)":"var(--cyan)"}`,
                        }}/>
                      </div>
                      <div style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--muted)", width:36, textAlign:"right", flexShrink:0 }}>
                        {dur ? fmt.duration(dur) : "—"}
                      </div>
                      <StatusDot status={s?.status ?? "pending"} size={5} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Selected node detail */}
        {nodeState && (
          <div style={{ background:"var(--panel)", border:"1px solid var(--cyan)33", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
              <Mono size={12} color="var(--cyan)">{selNode}</Mono>
              <StatusPill status={nodeState.status} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom: nodeState.output ? 10 : 0 }}>
              {[
                ["Duration", exec.nodeTimings[selNode] ? fmt.duration(exec.nodeTimings[selNode]) : "—"],
                ["Attempts", nodeState.attempts ?? "—"],
                ["Cache",    nodeState.fromCache ? "HIT" : "MISS"],
              ].map(([k,v]) => (
                <div key={k} style={{ background:"var(--surface)", borderRadius:5, padding:"6px 8px" }}>
                  <div style={{ fontSize:10, color:"var(--muted)", marginBottom:2 }}>{k}</div>
                  <div style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--text)" }}>{v}</div>
                </div>
              ))}
            </div>
            {nodeState.output && (
              <pre style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--green)", lineHeight:1.6, background:"var(--bg)", borderRadius:4, padding:"8px 10px", overflow:"auto", maxHeight:90, margin:0 }}>
                {JSON.stringify(nodeState.output, null, 2)}
              </pre>
            )}
            {nodeState.error && (
              <div style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--red)", marginTop:6 }}>{nodeState.error}</div>
            )}
          </div>
        )}

        {/* Live event stream */}
        {(exec.status === "running" || liveEvents.length > 0) && (
          <div style={{ background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)" }}>Events</div>
              {exec.status === "running" && (
                <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--green)", display:"flex", alignItems:"center", gap:4 }}>
                  <span style={{ width:5, height:5, borderRadius:"50%", background:"var(--green)", display:"inline-block", animation:"pulse 1.2s ease-in-out infinite" }}/>
                  streaming
                </span>
              )}
            </div>
            <div style={{ fontFamily:"var(--font-mono)", fontSize:10, background:"var(--bg)", border:"1px solid var(--border)", borderRadius:4, padding:"4px 0", maxHeight:120, overflowY:"auto" }}>
              {liveEvents.length === 0
                ? <div style={{ padding:"6px 10px", color:"var(--dim)" }}>Waiting for events…</div>
                : liveEvents.map(ev => {
                    const color = ev.event.startsWith("execution:") ? "var(--cyan)"
                                : ev.event === "node:completed"     ? "var(--green)"
                                : ev.event === "node:failed"        ? "var(--red)"
                                : ev.event === "stage:completed"    ? "var(--purple)"
                                : "var(--text)"
                    return (
                      <div key={ev.id} style={{ padding:"2px 10px", display:"flex", gap:8 }}>
                        <span style={{ color:"var(--dim)", flexShrink:0, width:32, textAlign:"right" }}>
                          +{((ev.ts - (liveEvents[0]?.ts ?? ev.ts))/1000).toFixed(1)}s
                        </span>
                        <span style={{ color }}>
                          {ev.event}
                          {ev.nodeId && <span style={{ color:"var(--cyan)", marginLeft:5 }}>{ev.nodeId}</span>}
                        </span>
                      </div>
                    )
                  })
              }
            </div>
          </div>
        )}

        {/* Node states summary */}
        <div style={{ background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:10 }}>Node States</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {Object.entries(exec.nodeStates).map(([id, s]) => (
              <div key={id}
                onClick={() => setSelNode(id === selNode ? null : id)}
                style={{
                  display:"flex", alignItems:"center", gap:8, padding:"5px 8px",
                  borderRadius:5, cursor:"pointer",
                  background: selNode===id ? "var(--cyan)0d" : "transparent",
                  border: `1px solid ${selNode===id ? "var(--cyan)33" : "transparent"}`,
                }}
              >
                <StatusDot status={s.status} size={6} />
                <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color: selNode===id ? "var(--cyan)" : "var(--text)", flex:1 }}>{id}</span>
                <span style={{ fontFamily:"var(--font-mono)", fontSize:10, color:"var(--muted)" }}>
                  {exec.nodeTimings[id] ? fmt.duration(exec.nodeTimings[id]) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}

// ── ExecFilterPanel ──────────────────────────────────────────────────────────
export const DURATION_BUCKETS = [
  { id:"all",  label:"Any duration" },
  { id:"xs",   label:"< 500 ms",    test: ms => ms != null && ms < 500 },
  { id:"sm",   label:"500 ms – 2 s", test: ms => ms != null && ms >= 500 && ms < 2000 },
  { id:"md",   label:"2 s – 10 s",  test: ms => ms != null && ms >= 2000 && ms < 10000 },
  { id:"lg",   label:"> 10 s",      test: ms => ms != null && ms >= 10000 },
]
export const TIME_WINDOWS = [
  { id:"all", label:"All time",  ms: Infinity },
  { id:"1h",  label:"Last hour", ms: 3600000 },
  { id:"6h",  label:"Last 6 h",  ms: 21600000 },
  { id:"24h", label:"Last 24 h", ms: 86400000 },
  { id:"7d",  label:"Last 7 d",  ms: 604800000 },
]
export const TRIGGER_TYPES = ["webhook","cron","event","manual","replay"]
export const EXEC_STATUSES = ["completed","failed","running","cancelled"]
export const SORT_OPTIONS = [
  { id:"started_desc",  label:"Newest first" },
  { id:"started_asc",   label:"Oldest first" },
  { id:"duration_desc", label:"Slowest first" },
  { id:"duration_asc",  label:"Fastest first" },
]

const _FChip = ({ active, onClick, children, color }) => (
  <button onClick={onClick} style={{
    padding:"3px 10px", borderRadius:10, cursor:"pointer", fontSize:12,
    fontFamily:"var(--font-ui)", border:"1px solid",
    background: active ? `${color ?? "var(--cyan)"}18` : "transparent",
    borderColor: active ? `${color ?? "var(--cyan)"}55` : "var(--border2)",
    color: active ? (color ?? "var(--cyan)") : "var(--muted)",
    transition:"all 0.1s", whiteSpace:"nowrap",
  }}>{children}</button>
)

// ── Datetime range presets ────────────────────────────────────────────────────
export const DT_PRESETS = [
  { id:"15m",    label:"15 min",  ms: 15*60*1000 },
  { id:"1h",     label:"1 hr",    ms: 60*60*1000 },
  { id:"4h",     label:"4 hr",    ms: 4*60*60*1000 },
  { id:"24h",    label:"24 hr",   ms: 24*60*60*1000 },
  { id:"3d",     label:"3 days",  ms: 3*24*60*60*1000 },
  { id:"7d",     label:"7 days",  ms: 7*24*60*60*1000 },
  { id:"30d",    label:"30 days", ms: 30*24*60*60*1000 },
  { id:"custom", label:"Custom",  ms: null },
]

// Format a Date to value for datetime-local input
const dtLocalVal = (d) => {
  if (!d) return ""
  const pad = n => String(n).padStart(2,"0")
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// Format for display label
const dtShort = (d) => {
  if (!d) return "—"
  return d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})
}

// ── Top filter bar ────────────────────────────────────────────────────────────
export const ExecFilterBar = ({ filters, onChange, total, matched }) => {
  const set = (key, val) => onChange({ ...filters, [key]: val })
  const toggleArr = (key, val) => {
    const arr = filters[key]
    set(key, arr.includes(val) ? arr.filter(x=>x!==val) : [...arr, val])
  }
  const hasFlags = filters.errorsOnly || filters.replaysOnly || filters.slowOnly || filters.cacheHits
  const flagCount = [filters.errorsOnly, filters.replaysOnly, filters.slowOnly, filters.cacheHits].filter(Boolean).length

  return (
    <div style={{ padding:"10px 24px 0", borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", paddingBottom:10 }}>

        {/* Search */}
        <div style={{ position:"relative", flexShrink:0 }}>
          <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", fontSize:12, color:"var(--dim)", pointerEvents:"none" }}>⌕</span>
          <input
            value={filters.search}
            onChange={e => set("search", e.target.value)}
            placeholder="Search ID, flow, error…"
            style={{
              background:"var(--bg)", border:"1px solid var(--border2)",
              borderRadius:6, padding:"5px 10px 5px 26px",
              fontSize:12, color:"var(--text)", outline:"none",
              fontFamily:"var(--font-ui)", width:210,
            }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)55"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </div>

        {/* Datetime picker */}
        <DatetimeRangePicker
          value={filters.datetime}
          onChange={v => set("datetime", v)}
        />

        {/* Status */}
        <FilterDropdown label="Status" active={filters.statuses.length > 0} badge={filters.statuses.length || null}>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {EXEC_STATUSES.map(s => {
              const on = filters.statuses.includes(s)
              const c = STATUS_COLOR[s] ?? "var(--muted)"
              return (
                <button key={s} onClick={() => toggleArr("statuses", s)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:6,
                  cursor:"pointer", background: on ? `${c}12` : "transparent",
                  border:`1px solid ${on ? c+"44" : "transparent"}`, transition:"all 0.1s",
                }}
                  onMouseEnter={e=>{ if(!on) e.currentTarget.style.background="var(--surface)" }}
                  onMouseLeave={e=>{ if(!on) e.currentTarget.style.background="transparent" }}>
                  <StatusDot status={s} />
                  <span style={{ fontSize:12, fontFamily:"var(--font-ui)", color: on ? "var(--text)" : "var(--muted)", textTransform:"capitalize" }}>{s}</span>
                  {on && <span style={{ marginLeft:"auto", fontSize:12, color:c }}>✓</span>}
                </button>
              )
            })}
          </div>
        </FilterDropdown>

        {/* Flow */}
        <FilterDropdown label="Flow" active={filters.flowIds.length > 0} badge={filters.flowIds.length || null}>
          <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:220, overflowY:"auto" }}>
            {FLOWS.map(f => {
              const on = filters.flowIds.includes(f.id)
              return (
                <button key={f.id} onClick={() => toggleArr("flowIds", f.id)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:6,
                  cursor:"pointer", textAlign:"left",
                  background: on ? "var(--cyan)0d" : "transparent",
                  border:`1px solid ${on ? "var(--cyan)33" : "transparent"}`,
                  transition:"all 0.1s",
                }}
                  onMouseEnter={e=>{ if(!on) e.currentTarget.style.background="var(--surface)" }}
                  onMouseLeave={e=>{ if(!on) e.currentTarget.style.background="transparent" }}>
                  <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0, background: on ? "var(--cyan)" : "var(--border2)" }}/>
                  <span style={{ fontSize:12, fontFamily:"var(--font-ui)", color: on ? "var(--cyan)" : "var(--muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }}>{f.name}</span>
                  {on && <span style={{ marginLeft:"auto", fontSize:12, color:"var(--cyan)", flexShrink:0 }}>✓</span>}
                </button>
              )
            })}
          </div>
        </FilterDropdown>

        {/* Trigger */}
        <FilterDropdown label="Trigger" active={filters.triggers.length > 0} badge={filters.triggers.length || null}>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5, maxWidth:200 }}>
            {TRIGGER_TYPES.map(t => (
              <_FChip key={t} active={filters.triggers.includes(t)} onClick={() => toggleArr("triggers", t)} color="var(--purple)">{t}</_FChip>
            ))}
          </div>
        </FilterDropdown>

        {/* Duration */}
        <FilterDropdown label="Duration" active={filters.duration !== "all"}>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {DURATION_BUCKETS.map(b => {
              const on = filters.duration === b.id
              return (
                <button key={b.id} onClick={() => set("duration", on ? "all" : b.id)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:5,
                  cursor:"pointer", background: on ? "var(--amber)0d" : "transparent",
                  border:`1px solid ${on ? "var(--amber)33" : "transparent"}`, transition:"all 0.1s",
                }}
                  onMouseEnter={e=>{ if(!on) e.currentTarget.style.background="var(--surface)" }}
                  onMouseLeave={e=>{ if(!on) e.currentTarget.style.background="transparent" }}>
                  <span style={{ fontSize:12, fontFamily:"var(--font-ui)", color: on ? "var(--amber)" : "var(--muted)" }}>{on?"●":"○"} {b.label}</span>
                </button>
              )
            })}
          </div>
        </FilterDropdown>

        {/* Flags */}
        <FilterDropdown label="Flags" active={hasFlags} badge={flagCount || null}>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {[
              { key:"errorsOnly",  label:"Has errors",    color:"var(--red)"    },
              { key:"replaysOnly", label:"Replays only",  color:"var(--amber)"  },
              { key:"slowOnly",    label:"Slow nodes",    color:"var(--amber)"  },
              { key:"cacheHits",   label:"Cache hits",    color:"var(--purple)" },
            ].map(({ key, label, color }) => {
              const on = filters[key]
              return (
                <button key={key} onClick={() => set(key, !on)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:6,
                  cursor:"pointer", background: on ? `${color}0d` : "transparent",
                  border:`1px solid ${on ? color+"33" : "transparent"}`, transition:"all 0.1s", width:"100%",
                }}
                  onMouseEnter={e=>{ if(!on) e.currentTarget.style.background="var(--surface)" }}
                  onMouseLeave={e=>{ if(!on) e.currentTarget.style.background="transparent" }}>
                  <div style={{
                    width:13, height:13, borderRadius:3, border:`1px solid ${on ? color : "var(--border2)"}`,
                    background: on ? `${color}33` : "transparent",
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color, flexShrink:0,
                  }}>{on ? "✓" : ""}</div>
                  <span style={{ fontSize:12, fontFamily:"var(--font-ui)", color: on ? color : "var(--muted)" }}>{label}</span>
                </button>
              )
            })}
          </div>
        </FilterDropdown>

        {/* Sort */}
        <FilterDropdown label={SORT_OPTIONS.find(s=>s.id===filters.sort)?.label ?? "Sort"} active={filters.sort !== "started_desc"}>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {SORT_OPTIONS.map(s => {
              const on = filters.sort === s.id
              return (
                <button key={s.id} onClick={() => set("sort", s.id)} style={{
                  display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:5,
                  cursor:"pointer", background: on ? "var(--surface)" : "transparent",
                  border:`1px solid ${on ? "var(--border2)" : "transparent"}`, transition:"all 0.1s",
                }}
                  onMouseEnter={e=>{ if(!on) e.currentTarget.style.background="var(--surface)" }}
                  onMouseLeave={e=>{ if(!on) e.currentTarget.style.background="transparent" }}>
                  <span style={{ fontSize:12, fontFamily:"var(--font-ui)", color: on ? "var(--text)" : "var(--muted)" }}>{on?"●":"○"} {s.label}</span>
                </button>
              )
            })}
          </div>
        </FilterDropdown>

        {/* Spacer + count */}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <span style={{ fontSize:12, fontFamily:"var(--font-mono)", color:"var(--muted)" }}>
            <span style={{ color: matched < total ? "var(--cyan)" : "var(--text)", fontWeight:600 }}>{matched}</span>
            <span style={{ color:"var(--dim)" }}> / {total}</span>
          </span>
        </div>

      </div>
    </div>
  )
}

// ── ExecutionsPage ───────────────────────────────────────────────────────────
export const EXEC_FILTER_DEFAULT = {
  search:      "",
  statuses:    [],
  flowIds:     [],
  triggers:    [],
  duration:    "all",
  datetime:    { preset:"all", from:null, to:null },
  sort:        "started_desc",
  errorsOnly:  false,
  replaysOnly: false,
  slowOnly:    false,
  cacheHits:   false,
}

export const ExecutionsPage = ({ filterFlowId, onClearFilter, onReviewExec }) => {
  const [detail,   setDetail]   = useState(null)
  const [preview,  setPreview]  = useState(null)
  const [execList, setExecList] = useState(EXECUTIONS)
  const [apiLoading, setApiLoading] = useState(false)
  const [filters,  setFilters]  = useState(() => ({
    ...EXEC_FILTER_DEFAULT,
    flowIds: filterFlowId ? [filterFlowId] : [],
  }))

  // Sync external filterFlowId prop into local state
  useEffect(() => {
    if (filterFlowId) setFilters(f => ({ ...f, flowIds: [filterFlowId] }))
  }, [filterFlowId])

  // Fetch executions from API; fall back to mock silently
  const fetchExecs = () => {
    setApiLoading(true)
    const params = {
      ...(filters.flowIds.length === 1 ? { flowId: filters.flowIds[0] } : {}),
      ...(filters.statuses.length === 1 ? { status: filters.statuses[0] } : {}),
      limit: 100,
    }
    executionApi.list(params)
      .then(data => {
        const list = data.executions ?? []
        if (list.length > 0) setExecList(list)
        setApiOnline(true)
      })
      .catch(() => setApiOnline(false))
      .finally(() => setApiLoading(false))
  }

  useEffect(() => { fetchExecs() }, [filters.flowIds[0], filters.statuses[0]])

  const execs = useMemo(() => {
    let list = [...execList]

    // Search: ID, flow name, error message, trigger path
    if (filters.search) {
      const q = filters.search.toLowerCase()
      list = list.filter(e =>
        e.executionId.toLowerCase().includes(q) ||
        (FLOWS.find(f=>f.id===e.flowId)?.name ?? "").toLowerCase().includes(q) ||
        (e.error ?? "").toLowerCase().includes(q) ||
        (typeof e.trigger === "object" ? JSON.stringify(e.trigger) : e.trigger).toLowerCase().includes(q)
      )
    }

    // Status
    if (filters.statuses.length)
      list = list.filter(e => filters.statuses.includes(e.status))

    // Flow
    if (filters.flowIds.length)
      list = list.filter(e => filters.flowIds.includes(e.flowId))

    // Trigger type
    if (filters.triggers.length)
      list = list.filter(e => {
        const t = typeof e.trigger === "object" ? e.trigger.type : e.trigger
        return filters.triggers.includes(t)
      })

    // Duration bucket
    if (filters.duration !== "all") {
      const bucket = DURATION_BUCKETS.find(b => b.id === filters.duration)
      if (bucket?.test) list = list.filter(e => bucket.test(e.durationMs))
    }

    // Datetime range
    if (filters.datetime.preset !== "all" || filters.datetime.from) {
      const { from, to } = filters.datetime
      if (from) {
        const toMs = to ? to.getTime() : Date.now()
        list = list.filter(e => e.startedAt >= from.getTime() && e.startedAt <= toMs)
      }
    }

    // Toggles
    if (filters.errorsOnly)  list = list.filter(e => e.error || Object.values(e.nodeStates).some(s => s.error))
    if (filters.replaysOnly) list = list.filter(e => !!e.replayOf)
    if (filters.slowOnly)    list = list.filter(e => e.slowNodes?.length > 0)
    if (filters.cacheHits)   list = list.filter(e => Object.values(e.nodeStates).some(s => s.fromCache))

    // Sort
    list.sort((a, b) => {
      if (filters.sort === "started_desc")  return b.startedAt - a.startedAt
      if (filters.sort === "started_asc")   return a.startedAt - b.startedAt
      if (filters.sort === "duration_desc") return (b.durationMs ?? 0) - (a.durationMs ?? 0)
      if (filters.sort === "duration_asc")  return (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity)
      return 0
    })

    return list
  }, [execList, filters])

  // Active filter chips — human-readable labels for each active filter
  const activeChips = useMemo(() => {
    const chips = []
    if (filters.statuses.length)  chips.push({ key:"statuses",    label:`Status: ${filters.statuses.join(", ")}` })
    if (filters.flowIds.length)   chips.push({ key:"flowIds",     label:`Flow: ${filters.flowIds.map(id=>FLOWS.find(f=>f.id===id)?.name??id).join(", ")}` })
    if (filters.triggers.length)  chips.push({ key:"triggers",    label:`Trigger: ${filters.triggers.join(", ")}` })
    if (filters.duration!=="all") chips.push({ key:"duration",    label:`Duration: ${DURATION_BUCKETS.find(b=>b.id===filters.duration)?.label}` })
    if (filters.datetime.preset !== "all") {
      const dt = filters.datetime
      if (dt.preset === "custom" && dt.from) {
        chips.push({ key:"datetime", label:`${dtShort(dt.from)} → ${dt.to ? dtShort(dt.to) : "now"}` })
      } else {
        const p = DT_PRESETS.find(p=>p.id===dt.preset)
        if (p) chips.push({ key:"datetime", label:`Last ${p.label}` })
      }
    }
    if (filters.errorsOnly)       chips.push({ key:"errorsOnly",  label:"Has errors" })
    if (filters.replaysOnly)      chips.push({ key:"replaysOnly", label:"Replays only" })
    if (filters.slowOnly)         chips.push({ key:"slowOnly",    label:"Slow nodes" })
    if (filters.cacheHits)        chips.push({ key:"cacheHits",   label:"Cache hits" })
    if (filters.sort !== "started_desc") chips.push({ key:"sort", label:SORT_OPTIONS.find(s=>s.id===filters.sort)?.label })
    return chips
  }, [filters])

  const clearChip = (key) => setFilters(f => ({
    ...f,
    [key]: key === "datetime" ? EXEC_FILTER_DEFAULT.datetime : EXEC_FILTER_DEFAULT[key]
  }))

  const clearAll = () => setFilters(EXEC_FILTER_DEFAULT)

  // Summary stats for the filtered set
  const stats = useMemo(() => {
    const terminal = execs.filter(e => e.status !== "running")
    const succeeded = execs.filter(e => e.status === "completed").length
    const failed    = execs.filter(e => e.status === "failed").length
    const durations = terminal.map(e => e.durationMs).filter(Boolean)
    const avgDur = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : null
    return { succeeded, failed, running: execs.filter(e=>e.status==="running").length, avgDur }
  }, [execs])

  const cancelExec = (e) => {
    setExecList(prev => prev.map(x => x.executionId !== e.executionId ? x : {
      ...x, status:"cancelled", endedAt:Date.now(), durationMs:Date.now()-x.startedAt,
      nodeStates: Object.fromEntries(Object.entries(x.nodeStates).map(([id,s]) => [
        id, (s.status==="running"||s.status==="pending") ? {...s,status:"skipped"} : s
      ])),
    }))
    if (preview?.executionId === e.executionId) setPreview(null)
  }

  const replayExec = (e) => {
    const newId = `exec_replay_${Date.now().toString(36)}`
    const newExec = {
      ...e,
      executionId: newId, status:"running",
      startedAt: Date.now(), endedAt:null, durationMs:null,
      replayOf: e.executionId,
      trigger: { type:"replay", sourceId:e.executionId },
      nodeStates: Object.fromEntries(Object.keys(e.nodeStates).map(id=>[id,{status:"pending"}])),
      nodeTimings: {},
    }
    setExecList(prev => [newExec, ...prev])
    setPreview(newExec)
  }

  if (detail) return <ExecutionDetail exec={detail} onBack={() => setDetail(null)} />

  return (
    <div className="page-enter" style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 56px)" }}>

      {/* ── Header ── */}
      <div style={{ padding:"22px 24px 14px", flexShrink:0, borderBottom:"1px solid var(--border)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: activeChips.length ? 12 : 0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ fontFamily:"var(--font-head)", fontSize:18, fontWeight:700, color:"var(--text)" }}>Executions</div>
            {/* Mini stat strip */}
            {[
              { label:"matched", val: execs.length, color:"var(--cyan)" },
              { label:"ok",      val: stats.succeeded, color:"var(--green)" },
              { label:"failed",  val: stats.failed,    color: stats.failed > 0 ? "var(--red)" : "var(--muted)" },
              { label:"running", val: stats.running,   color: stats.running > 0 ? "var(--cyan)" : "var(--muted)" },
              { label:"avg dur", val: stats.avgDur != null ? fmt.duration(stats.avgDur) : "—", color:"var(--muted)" },
            ].map(s => (
              <div key={s.label} style={{ display:"flex", alignItems:"baseline", gap:4 }}>
                <span style={{ fontFamily:"var(--font-mono)", fontSize:14, fontWeight:600, color:s.color }}>{s.val}</span>
                <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{s.label}</span>
              </div>
            ))}
          </div>
          {preview && (
            <span style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--muted)",
              background:"var(--surface)", border:"1px solid var(--border)",
              padding:"2px 8px", borderRadius:4 }}>
              preview active
            </span>
          )}
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 && (
          <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
            {activeChips.map(chip => (
              <span key={chip.key} style={{
                display:"flex", alignItems:"center", gap:4,
                fontSize:11, fontFamily:"var(--font-ui)",
                background:"var(--cyan)10", border:"1px solid var(--cyan)30",
                color:"var(--cyan)", padding:"2px 8px", borderRadius:10,
              }}>
                {chip.label}
                <button onClick={() => clearChip(chip.key)}
                  style={{ background:"none", border:"none", cursor:"pointer",
                    color:"var(--cyan)", fontSize:13, lineHeight:1, padding:"0 0 0 2px" }}>
                  ×
                </button>
              </span>
            ))}
            <button onClick={clearAll}
              style={{ fontSize:11, color:"var(--muted)", background:"none",
                border:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }}>
              clear all
            </button>
          </div>
        )}
      </div>

      {/* ── Filter bar (top) ── */}
      <ExecFilterBar
        filters={filters}
        onChange={setFilters}
        total={execList.length}
        matched={execs.length}
      />

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center",
          padding:"6px 24px 8px", borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0 }}>
          {activeChips.map(chip => (
            <span key={chip.key} style={{
              display:"flex", alignItems:"center", gap:4,
              fontSize:11, fontFamily:"var(--font-ui)",
              background:"var(--cyan)10", border:"1px solid var(--cyan)30",
              color:"var(--cyan)", padding:"2px 8px", borderRadius:10,
            }}>
              {chip.label}
              <button onClick={() => clearChip(chip.key)}
                style={{ background:"none", border:"none", cursor:"pointer",
                  color:"var(--cyan)", fontSize:13, lineHeight:1, padding:"0 0 0 2px" }}>×</button>
            </span>
          ))}
          <button onClick={clearAll}
            style={{ fontSize:11, color:"var(--muted)", background:"none",
              border:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }}>clear all</button>
        </div>
      )}

      {/* ── Body (table + preview) ── */}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* Table */}
        <div style={{ flex:1, overflowY:"auto", padding:"0 0 28px", minWidth:0,
          borderRight: preview ? "1px solid var(--border)" : "none" }}>
          <Table
            cols={[
              { key:"flow", label:"Flow",
                render: e => {
                  const flow = FLOWS.find(f=>f.id===e.flowId)
                  const started = new Date(e.startedAt)
                  const dateStr = started.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})
                  return (
                    <div>
                      <div style={{ fontSize:13, color:"var(--text)", fontWeight:600, fontFamily:"var(--font-ui)",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:220 }}>
                        {flow?.name ?? e.flowId}
                      </div>
                      <div style={{ display:"flex", alignItems:"baseline", gap:6, marginTop:2 }}>
                        <Mono size={11} color="var(--text)" style={{ opacity:0.75 }}>{dateStr}</Mono>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:1 }}>
                        <Mono size={10} color="var(--dim)">{fmt.time(now - e.startedAt)} ago</Mono>
                        <Mono size={9} color="var(--border2)">·</Mono>
                        <Mono size={9} color="var(--dim)">{e.executionId}</Mono>
                      </div>
                    </div>
                  )
                }
              },
              { key:"status", label:"Status",
                render: e => (
                  <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                      <StatusPill status={e.status} />
                      {e.replayOf && (
                        <span style={{ fontSize:9, fontFamily:"var(--font-mono)", color:"var(--amber)",
                          background:"var(--amber)12", border:"1px solid var(--amber)33",
                          padding:"1px 5px", borderRadius:3 }}>replay</span>
                      )}
                    </div>
                    {e.error && (
                      <Mono size={9} color="var(--red)"
                        style={{ maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", display:"block" }}
                        title={e.error}>{e.error}</Mono>
                    )}
                  </div>
                )
              },
              { key:"trigger", label:"Trigger",
                render: e => {
                  const t = typeof e.trigger === "object" ? e.trigger.type : e.trigger
                  const COLOR = { webhook:"var(--cyan)", cron:"var(--green)", event:"var(--purple)", manual:"var(--amber)", replay:"var(--amber)" }
                  return (
                    <span onClick={ev=>{ ev.stopPropagation(); setFilters(f=>({...f, triggers: f.triggers.includes(t)?f.triggers:[...f.triggers,t]})) }}
                      title="Filter by this trigger type"
                      style={{ fontFamily:"var(--font-mono)", fontSize:11, cursor:"pointer",
                        color: COLOR[t] ?? "var(--muted)",
                        background: `${COLOR[t] ?? "var(--border)"}14`,
                        border:`1px solid ${COLOR[t] ?? "var(--border)"}33`,
                        padding:"2px 7px", borderRadius:3 }}>
                      {t}
                    </span>
                  )
                }
              },
              { key:"duration", label:"Duration",
                render: e => {
                  const dur = e.durationMs
                  const isLong = dur != null && dur > 5000
                  const isRunning = e.status === "running"
                  return (
                    <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                      <Mono color={isLong ? "var(--amber)" : isRunning ? "var(--cyan)" : undefined}>
                        {isRunning ? "…" : fmt.duration(dur)}
                      </Mono>
                      {e.slowNodes?.length > 0 && (
                        <span title={`Slow: ${e.slowNodes.join(", ")}`}
                          style={{ fontSize:10, color:"var(--amber)" }}>⚠</span>
                      )}
                    </div>
                  )
                }
              },
              { key:"actions", label:"",
                render: e => (
                  <div style={{ display:"flex", gap:4, alignItems:"center" }} onClick={ev=>ev.stopPropagation()}>
                    {/* View Run — opens execution review overlay */}
                    <button
                      onClick={() => onReviewExec(e)}
                      title="View run in flow editor"
                      style={{
                        display:"flex", alignItems:"center", gap:5, padding:"4px 10px",
                        borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"var(--font-ui)", fontWeight:500,
                        background:"var(--surface)", border:"1px solid var(--border2)",
                        color:"var(--muted)", transition:"all 0.12s",
                      }}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)";e.currentTarget.style.background="var(--cyan)0d"}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)";e.currentTarget.style.background="var(--surface)"}}
                    >⬡ View run</button>
                    {e.status === "running" && (
                      <Btn small variant="danger" onClick={()=>cancelExec(e)} title="Cancel">⏹</Btn>
                    )}
                    {["completed","failed","cancelled"].includes(e.status) && (
                      <Btn small variant="ghost" onClick={()=>replayExec(e)} title="Replay">⟲</Btn>
                    )}
                  </div>
                )
              },
            ]}
            rows={execs}
            onRowClick={e => setPreview(prev => prev?.executionId===e.executionId ? null : execList.find(x=>x.executionId===e.executionId))}
          />

          {execs.length === 0 && (
            <div style={{ textAlign:"center", padding:"72px 20px" }}>
              <div style={{ fontSize:28, marginBottom:10, opacity:0.2 }}>◎</div>
              <div style={{ fontSize:14, color:"var(--muted)", fontFamily:"var(--font-ui)", marginBottom:10 }}>
                No executions match the current filters.
              </div>
              <Btn variant="ghost" small onClick={clearAll}>Clear all filters</Btn>
            </div>
          )}
        </div>

        {/* Preview panel */}
        {preview && (
          <div style={{ width:"44%", flexShrink:0, overflowY:"auto" }}>
            <ExecutionPreview
              exec={preview}
              onClose={() => setPreview(null)}
              onDrilldown={() => { setDetail(execList.find(x=>x.executionId===preview.executionId)); setPreview(null) }}
              onCancel={() => cancelExec(preview)}
              onReplay={() => replayExec(preview)}
            />
          </div>
        )}

      </div>
    </div>
  )
}

// ─── METRICS PAGE ───────────────────────────────────────────────────────────
// ─── METRICS PAGE ───────────────────────────────────────────────────────────

export const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background:"var(--panel)", border:"1px solid var(--border2)",
      borderRadius:6, padding:"10px 14px",
      fontFamily:"var(--font-mono)", fontSize:12,
    }}>
      <div style={{ color:"var(--muted)", marginBottom:6 }}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color:p.color, marginBottom:2 }}>
          {p.dataKey}: {p.value.toLocaleString()}
        </div>
      ))}
    </div>
  )
}

export const MetricsPage = () => {
  const [win,        setWin]        = useState("24h")
  const [flowFilter, setFlowFilter] = useState("all")
  const [apiMetrics, setApiMetrics] = useState(null)

  // Fetch real metrics; fall back to mock silently
  useEffect(() => {
    const windowMs = METRIC_WINDOWS[win]?.ms ?? 86400000
    const params   = { windowMs, ...(flowFilter !== "all" ? { flowId: flowFilter } : {}) }
    metricsApi.get(params)
      .then(data => { setApiMetrics(data); setApiOnline(true) })
      .catch(() => { setApiMetrics(null); setApiOnline(false) })
  }, [win, flowFilter])

  // Merge API data into the mock-derived shape, or fall back entirely
  const m = useMemo(() => {
    const base = buildMetrics(win, flowFilter)
    if (!apiMetrics) return base
    return {
      ...base,
      totalRuns:    apiMetrics.totalRuns    ?? base.totalRuns,
      successRate:  apiMetrics.successRate  != null ? Math.round(apiMetrics.successRate * 100) : base.successRate,
      avgDuration:  apiMetrics.avgDurationMs != null ? Math.round(apiMetrics.avgDurationMs) : base.avgDuration,
      p95Duration:  apiMetrics.p95DurationMs != null ? Math.round(apiMetrics.p95DurationMs) : base.p95Duration,
      slowNodes:    apiMetrics.slowNodes?.length ? apiMetrics.slowNodes.map(n => ({
        id: n.nodeId, label: n.nodeId, avgMs: n.avgMs, p95Ms: n.p95Ms, count: n.count,
      })) : base.slowNodes,
      errorSummary: apiMetrics.errorSummary?.length ? apiMetrics.errorSummary : base.errorSummary,
    }
  }, [win, flowFilter, apiMetrics])

  const LABEL_STYLE = { fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em",
    color:"var(--muted)", marginBottom:12, fontFamily:"var(--font-ui)", fontWeight:600 }
  const CARD = { background:"var(--panel)", border:"1px solid var(--border)", borderRadius:9, padding:"16px 18px" }

  const trendIcon  = (t) => t==="up" ? "↑" : t==="down" ? "↓" : "→"
  const trendColor = (t) => t==="up" ? "var(--green)" : t==="down" ? "var(--red)" : "var(--muted)"
  const maxSlow = m.slowNodes[0]?.avgMs ?? 1

  // X-axis tick interval — fewer ticks on dense series
  const tickInterval = m.volumeSeries.length > 20 ? Math.floor(m.volumeSeries.length/6) : 3

  return (
    <div className="page-enter" style={{ padding:"28px 28px 48px", maxWidth:1300, boxSizing:"border-box" }}>

      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:24, flexWrap:"wrap" }}>
        <div style={{ fontSize:20, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)", flex:1 }}>Metrics</div>

        {/* Flow filter */}
        <select value={flowFilter} onChange={e=>setFlowFilter(e.target.value)} style={{
          background:"var(--surface)", border:"1px solid var(--border2)", borderRadius:6,
          padding:"5px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)",
          outline:"none", cursor:"pointer", minWidth:180,
        }}>
          <option value="all">All flows</option>
          {FLOWS.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>

        {/* Window pills */}
        <div style={{ display:"flex", gap:2, background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6, padding:2 }}>
          {Object.keys(METRIC_WINDOWS).map(w => (
            <button key={w} onClick={()=>setWin(w)} style={{
              padding:"4px 12px", borderRadius:4, border:"none", cursor:"pointer", fontSize:12,
              fontFamily:"var(--font-mono)", transition:"all 0.12s",
              background: win===w ? "var(--panel)" : "transparent",
              color:       win===w ? "var(--cyan)"  : "var(--muted)",
              boxShadow:   win===w ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
            }}>{w}</button>
          ))}
        </div>
      </div>

      {/* ── Stat strip ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:20 }}>
        {[
          { label:"Total Runs",    value:fmt.num(m.totalRuns),      accent:"var(--cyan)",  sub:`in last ${win}` },
          { label:"Success Rate",  value:fmt.pct(m.successRate),    accent:"var(--green)", sub:`${Math.round(m.totalRuns*m.errorRate)} failures` },
          { label:"Avg Duration",  value:fmt.duration(m.avgMs),     accent:"var(--text)",  sub:`p95 ${fmt.duration(m.p95Ms)}` },
        ].map(s => (
          <div key={s.label} style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:9, padding:"13px 15px" }}>
            <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:6, fontFamily:"var(--font-ui)" }}>{s.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color:s.accent, fontFamily:"var(--font-head)", lineHeight:1.1 }}>{s.value}</div>
            <div style={{ fontSize:10, color:"var(--dim)", marginTop:4, fontFamily:"var(--font-ui)" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Charts row 1: Volume + Success Rate ── */}
      <div style={{ display:"grid", gridTemplateColumns:"3fr 2fr", gap:14, marginBottom:14 }}>

        {/* Volume */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Run Volume</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={m.volumeSeries} barGap={1} barSize={win==="30d"?8:win==="7d"?6:9}>
              <XAxis dataKey="label" tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} interval={tickInterval} />
              <YAxis tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} width={30} />
              <Tooltip content={<CustomTooltip/>} />
              <Bar dataKey="success" name="Success" fill="var(--cyan)" opacity={0.55} radius={[2,2,0,0]} />
              <Bar dataKey="failed"  name="Failed"  fill="var(--red)"  opacity={0.75} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display:"flex", gap:16, marginTop:6 }}>
            {[["var(--cyan)","Success"],["var(--red)","Failed"]].map(([c,l])=>(
              <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>
                <div style={{ width:10, height:3, background:c, borderRadius:1 }}/>{l}
              </div>
            ))}
          </div>
        </div>

        {/* Success rate trend */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Success Rate Trend</div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={m.successTrend}>
              <XAxis dataKey="label" tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} interval={tickInterval} />
              <YAxis domain={[0.7,1]} tickFormatter={v=>`${(v*100).toFixed(0)}%`}
                tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} width={34} />
              <Tooltip content={<CustomTooltip/>} formatter={v=>`${(v*100).toFixed(1)}%`} />
              <Line type="monotone" dataKey="rate" name="Success rate" stroke="var(--green)"
                strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Charts row 2: Duration + Per-flow ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>

        {/* Duration trend */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Duration Trend</div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={m.durationTrend}>
              <XAxis dataKey="label" tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} interval={tickInterval} />
              <YAxis tickFormatter={v=>fmt.duration(v)}
                tick={{ fontSize:9, fill:"var(--muted)", fontFamily:"var(--font-mono)" }}
                tickLine={false} axisLine={false} width={38} />
              <Tooltip content={<CustomTooltip/>} formatter={v=>fmt.duration(v)} />
              <Line type="monotone" dataKey="avg" name="Avg" stroke="var(--cyan)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95" name="p95" stroke="var(--amber)" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display:"flex", gap:16, marginTop:6 }}>
            {[["var(--cyan)","Avg"],["var(--amber)","p95"]].map(([c,l])=>(
              <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>
                <div style={{ width:10, height:2, background:c, borderRadius:1 }}/>{l}
              </div>
            ))}
          </div>
        </div>

        {/* Per-flow breakdown */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Flow Breakdown</div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {m.flowBreakdown.map(f => {
              const maxRuns = m.flowBreakdown[0]?.runs ?? 1
              const barW = `${Math.max(3,(f.runs/maxRuns)*100).toFixed(1)}%`
              const srColor = f.successRate > 0.98 ? "var(--green)" : f.successRate > 0.92 ? "var(--amber)" : "var(--red)"
              return (
                <div key={f.id}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                    <StatusDot status={f.enabled?"active":"inactive"} />
                    <span style={{ fontSize:11, color:"var(--text)", fontFamily:"var(--font-ui)", flex:1,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                    <span style={{ fontSize:10, color:srColor, fontFamily:"var(--font-mono)", flexShrink:0 }}>
                      {fmt.pct(f.successRate)}
                    </span>
                    <span style={{ fontSize:10, color:trendColor(f.trend), fontFamily:"var(--font-mono)", flexShrink:0, width:12 }}>
                      {trendIcon(f.trend)}
                    </span>
                  </div>
                  <div style={{ height:4, background:"var(--surface)", borderRadius:2, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:barW, borderRadius:2, transition:"width 0.4s",
                      background:`linear-gradient(90deg, var(--cyan)66, var(--cyan)33)` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Bottom row: Error summary + Slow nodes ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>

        {/* Error summary */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Top Errors</div>
          {m.errorSummary.length === 0 ? (
            <div style={{ fontSize:12, color:"var(--green)", fontFamily:"var(--font-ui)", padding:"12px 0", textAlign:"center" }}>
              ✓ No errors in this window
            </div>
          ) : m.errorSummary.map((e,i) => {
            const pct = (e.count / m.errorSummary[0].count) * 100
            return (
              <div key={i} style={{ marginBottom:11 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3, gap:10 }}>
                  <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--text)",
                    flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {e.error}
                  </span>
                  <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--red)", flexShrink:0 }}>×{e.count}</span>
                </div>
                <div style={{ height:3, background:"var(--surface)", borderRadius:2 }}>
                  <div style={{ height:"100%", width:`${pct}%`, background:"var(--red)55", borderRadius:2, transition:"width 0.5s" }} />
                </div>
              </div>
            )
          })}
        </div>

        {/* Slow nodes */}
        <div style={CARD}>
          <div style={LABEL_STYLE}>Slowest Nodes</div>
          {m.slowNodes.length === 0 ? (
            <div style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)", padding:"12px 0", textAlign:"center" }}>
              No data for selected filter
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
              {m.slowNodes.map((n,i) => (
                <div key={n.nodeId} style={{ display:"grid", gridTemplateColumns:"16px 1fr auto auto", gap:8, alignItems:"center" }}>
                  <Mono size={9} color="var(--dim)">{i+1}</Mono>
                  <div>
                    <Mono size={11}>{n.nodeId}</Mono>
                    <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:1 }}>{n.flow}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ width:80, height:4, background:"var(--surface)", borderRadius:2, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${(n.avgMs/maxSlow)*100}%`,
                        background:"var(--amber)55", borderRadius:2 }} />
                    </div>
                    <Mono size={9} color="var(--amber)">{fmt.duration(n.avgMs)}</Mono>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>p95</div>
                    <Mono size={9} color="var(--muted)">{fmt.duration(n.p95Ms)}</Mono>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── SYSTEM ADMIN ───────────────────────────────────────────────────────────

export const TEMPLATE_CATEGORIES = ["All", "AI & LLM", "CRM & Sales", "DevOps", "Data", "Notifications", "Finance"]

export const TEMPLATES = [
  {
    id: "tpl_lead_score",
    name: "AI Lead Scoring",
    description: "Webhook receives CRM lead → AI scores hot/warm/cold → enriches from Clearbit → notifies Slack",
    category: "AI & LLM",
    tags: ["ai", "crm", "leads", "slack"],
    nodes: 5, complexity: "medium",
    icon: "🎯",
    accent: "var(--cyan)",
    canvasFlowId: "flow_lead_pipeline",
  },
  {
    id: "tpl_email_classify",
    name: "Email AI Classifier",
    description: "Ingest inbound emails → classify with AI → route to support queues → draft reply",
    category: "AI & LLM",
    tags: ["ai", "email", "support"],
    nodes: 4, complexity: "medium",
    icon: "📧",
    accent: "var(--purple)",
    canvasFlowId: null,
  },
  {
    id: "tpl_llm_summary",
    name: "LLM Document Summariser",
    description: "Pull docs from S3 or URL → chunk → summarize with GPT-4o → store result",
    category: "AI & LLM",
    tags: ["ai", "llm", "documents"],
    nodes: 6, complexity: "simple",
    icon: "📄",
    accent: "var(--green)",
    canvasFlowId: null,
  },
  {
    id: "tpl_health_monitor",
    name: "Service Health Monitor",
    description: "Ping endpoints every minute → analyze latency → page on-call via PagerDuty on anomaly",
    category: "DevOps",
    tags: ["ops", "monitoring", "alerts"],
    nodes: 3, complexity: "simple",
    icon: "💚",
    accent: "var(--green)",
    canvasFlowId: "flow_health_monitor",
  },
  {
    id: "tpl_deploy_notify",
    name: "Deploy Notification",
    description: "GitHub webhook on push → compile status check → Slack deploy message to #engineering",
    category: "DevOps",
    tags: ["github", "slack", "ci"],
    nodes: 4, complexity: "simple",
    icon: "🚀",
    accent: "var(--amber)",
    canvasFlowId: null,
  },
  {
    id: "tpl_incident_response",
    name: "Incident Response",
    description: "PagerDuty alert → classify severity with AI → escalate on-call → post war-room channel",
    category: "DevOps",
    tags: ["ops", "incidents", "ai"],
    nodes: 6, complexity: "advanced",
    icon: "🚨",
    accent: "var(--red)",
    canvasFlowId: null,
  },
  {
    id: "tpl_invoice_sync",
    name: "Invoice Sync",
    description: "Poll Stripe for new invoices hourly → transform → upsert to internal DB",
    category: "Finance",
    tags: ["stripe", "billing", "sync"],
    nodes: 3, complexity: "simple",
    icon: "💳",
    accent: "var(--cyan)",
    canvasFlowId: "flow_invoice_sync",
  },
  {
    id: "tpl_nightly_export",
    name: "Nightly Data Export",
    description: "Cron at midnight → query analytics DB → transform to Parquet → upload to S3",
    category: "Data",
    tags: ["data", "export", "s3", "cron"],
    nodes: 4, complexity: "simple",
    icon: "📦",
    accent: "var(--muted)",
    canvasFlowId: "flow_data_export",
  },
  {
    id: "tpl_db_backup",
    name: "Database Backup",
    description: "Scheduled cron → dump SQLite/Postgres → compress → push to S3 with retention policy",
    category: "Data",
    tags: ["data", "backup", "cron"],
    nodes: 5, complexity: "medium",
    icon: "🗄️",
    accent: "var(--amber)",
    canvasFlowId: null,
  },
  {
    id: "tpl_slack_notify",
    name: "Slack Notifier",
    description: "Generic webhook → format message with template → send to one or more Slack channels",
    category: "Notifications",
    tags: ["slack", "webhook", "notify"],
    nodes: 2, complexity: "simple",
    icon: "💬",
    accent: "var(--green)",
    canvasFlowId: null,
  },
  {
    id: "tpl_email_digest",
    name: "Daily Email Digest",
    description: "Cron at 8am → query recent records → render HTML template → send via SMTP",
    category: "Notifications",
    tags: ["email", "cron", "digest"],
    nodes: 4, complexity: "simple",
    icon: "📬",
    accent: "var(--cyan)",
    canvasFlowId: null,
  },
  {
    id: "tpl_crm_onboard",
    name: "CRM Onboarding Flow",
    description: "New signup webhook → enrich lead → create CRM contact → send welcome email → add to drip",
    category: "CRM & Sales",
    tags: ["crm", "email", "onboarding"],
    nodes: 6, complexity: "medium",
    icon: "🤝",
    accent: "var(--purple)",
    canvasFlowId: null,
  },
]

export const COMPLEXITY_COLOR = { simple:"var(--green)", medium:"var(--amber)", advanced:"var(--red)" }

// ─── TEMPLATES PAGE ───────────────────────────────────────────────────────────

export const TemplatesPage = ({ onUseTemplate }) => {
  const [cat,    setCat]    = useState("All")
  const [search, setSearch] = useState("")
  const [preview, setPreview] = useState(null)  // template being previewed

  const filtered = TEMPLATES.filter(t => {
    const matchCat    = cat === "All" || t.category === cat
    const matchSearch = !search || t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()) ||
      t.tags.some(tag => tag.includes(search.toLowerCase()))
    return matchCat && matchSearch
  })

  const useTemplate = (tpl) => {
    // Clone from canvasFlowId if available, else create skeleton
    const newId   = `flow_${Date.now().toString(36)}`
    const srcFlow = tpl.canvasFlowId ? CANVAS_FLOWS[tpl.canvasFlowId] : null
    CANVAS_FLOWS[newId] = {
      id:          newId,
      name:        tpl.name,
      description: tpl.description,
      tags:        [...tpl.tags],
      version:     "1.0.0",
      nodes:       srcFlow ? srcFlow.nodes.map(n => ({ ...n, id:`${n.id}_${newId.slice(-4)}` })) : [],
      edges:       srcFlow ? srcFlow.edges.map(e => ({
        ...e,
        id:   `${e.id}_${newId.slice(-4)}`,
        from: `${e.from}_${newId.slice(-4)}`,
        to:   `${e.to}_${newId.slice(-4)}`,
      })) : [],
      variables:   [],
      fromTemplate: tpl.id,
    }
    setPreview(null)
    onUseTemplate(newId)
  }

  return (
    <div className="page-enter" style={{ padding:"32px 28px", maxWidth:1200 }}>

      {/* Header */}
      <SectionHeader
        children="Templates"
        action={
          <input
            value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search templates…"
            style={{ background:"var(--panel)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"5px 12px", fontSize:13, color:"var(--text)", outline:"none",
              fontFamily:"var(--font-ui)", width:220 }}
          />
        }
      />

      {/* Category tabs */}
      <div style={{ display:"flex", gap:6, marginBottom:24, flexWrap:"wrap" }}>
        {TEMPLATE_CATEGORIES.map(c => (
          <button key={c} onClick={()=>setCat(c)}
            style={{
              padding:"5px 14px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"var(--font-ui)",
              fontWeight: cat===c ? 600 : 400,
              background: cat===c ? "var(--cyan)18" : "var(--surface)",
              border:     `1px solid ${cat===c ? "var(--cyan)55" : "var(--border)"}`,
              color:      cat===c ? "var(--cyan)" : "var(--muted)",
              transition: "all 0.12s",
            }}>
            {c}
            {c !== "All" && (
              <span style={{ marginLeft:5, fontSize:10, opacity:0.7 }}>
                {TEMPLATES.filter(t=>t.category===c).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--muted)", fontSize:14 }}>
          No templates match "{search}".
        </div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14 }}>
          {filtered.map(tpl => (
            <div key={tpl.id}
              onClick={()=>setPreview(tpl)}
              style={{
                background:"var(--panel)", border:`1px solid var(--border)`,
                borderRadius:10, padding:"18px 20px", cursor:"pointer",
                transition:"border-color 0.15s, transform 0.1s",
                position:"relative", overflow:"hidden",
              }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=tpl.accent;e.currentTarget.style.transform="translateY(-1px)"}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.transform="none"}}>

              {/* Accent glow */}
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:tpl.accent, borderRadius:"10px 10px 0 0", opacity:0.6 }} />

              <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:10 }}>
                <span style={{ fontSize:24, flexShrink:0 }}>{tpl.icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-head)", marginBottom:4, lineHeight:1.2 }}>
                    {tpl.name}
                  </div>
                  <span style={{ fontSize:9, fontFamily:"var(--font-mono)", padding:"1px 6px", borderRadius:3,
                    background:`${COMPLEXITY_COLOR[tpl.complexity]}15`,
                    border:`1px solid ${COMPLEXITY_COLOR[tpl.complexity]}40`,
                    color: COMPLEXITY_COLOR[tpl.complexity], textTransform:"uppercase", letterSpacing:"0.06em" }}>
                    {tpl.complexity}
                  </span>
                </div>
              </div>

              <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.6 }}>
                {tpl.description}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(8,10,15,0.8)",
          backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={e => { if(e.target===e.currentTarget) setPreview(null) }}>
          <div className="page-enter" style={{ background:"var(--panel)", border:"1px solid var(--border2)",
            borderRadius:12, width:520, padding:"28px 30px", boxShadow:"0 24px 64px rgba(0,0,0,0.6)", position:"relative", overflow:"hidden" }}>

            {/* Accent bar */}
            <div style={{ position:"absolute", top:0, left:0, right:0, height:3, background:preview.accent, borderRadius:"12px 12px 0 0" }} />

            <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:16 }}>
              <span style={{ fontSize:32 }}>{preview.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:17, fontWeight:700, fontFamily:"var(--font-head)", color:"var(--text)", marginBottom:4 }}>
                  {preview.name}
                </div>
                <div style={{ display:"flex", gap:7, alignItems:"center" }}>
                  <span style={{ fontSize:10, fontFamily:"var(--font-mono)", padding:"2px 7px", borderRadius:3,
                    background:`${COMPLEXITY_COLOR[preview.complexity]}15`,
                    border:`1px solid ${COMPLEXITY_COLOR[preview.complexity]}40`,
                    color: COMPLEXITY_COLOR[preview.complexity], textTransform:"uppercase", letterSpacing:"0.06em" }}>
                    {preview.complexity}
                  </span>
                  <span style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-mono)" }}>{preview.nodes} nodes</span>
                  <span style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-mono)" }}>{preview.category}</span>
                </div>
              </div>
            </div>

            <div style={{ fontSize:13, color:"var(--muted)", lineHeight:1.8, marginBottom:16 }}>
              {preview.description}
            </div>

            {/* Tags */}
            <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:20 }}>
              {preview.tags.map(t => <Tag key={t} label={t} />)}
            </div>

            {/* What you get */}
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"12px 16px", marginBottom:20 }}>
              <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontFamily:"var(--font-ui)" }}>
                What you get
              </div>
              {[
                `${preview.nodes} pre-wired nodes`,
                preview.canvasFlowId ? "Full canvas layout — ready to run" : "Skeleton flow — fill in your credentials",
                "All edges and conditions configured",
                "Edit in DAG or Linear mode",
              ].map((item,i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5, fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)" }}>
                  <span style={{ color:"var(--green)", fontSize:11 }}>✓</span>
                  {item}
                </div>
              ))}
            </div>

            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <Btn variant="ghost" onClick={()=>setPreview(null)}>Cancel</Btn>
              <Btn variant="primary" onClick={()=>useTemplate(preview)}>
                Use Template →
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Toast system ──────────────────────────────────────────────────────────────
export const ExecReviewMode = ({ exec, onBack }) => {
  const flow = CANVAS_FLOWS[exec.flowId]
    ?? { id:exec.flowId, name: FLOWS.find(f=>f.id===exec.flowId)?.name ?? exec.flowId,
         nodes:[], edges:[] }

  // Auto-layout nodes if they have no position
  const rawNodes = Array.isArray(flow.nodes)
    ? flow.nodes
    : Object.entries(flow.nodes ?? {}).map(([id,n]) => ({ id, ...n }))
  const rawEdges = Array.isArray(flow.edges) ? flow.edges : []

  // Fallback: synthesise nodes from nodeStates if flow has no nodes
  const syntheticNodes = rawNodes.length === 0
    ? Object.keys(exec.nodeStates ?? {}).map((id,i) => ({
        id, type:"code", meta:{ name:id }, config:{},
      }))
    : rawNodes

  const layoutNodes = (() => {
    const ids = syntheticNodes.map(n => n.id)
    const inDeg = Object.fromEntries(ids.map(id => [id,0]))
    rawEdges.forEach(e => { if(inDeg[e.to]!==undefined) inDeg[e.to]++ })
    const stages = [], visited = new Set()
    let queue = ids.filter(id => inDeg[id]===0)
    while(queue.length) {
      stages.push([...queue]); queue.forEach(id=>visited.add(id))
      const next = []
      queue.forEach(id=>rawEdges.filter(e=>e.from===id).forEach(e=>{
        if(!visited.has(e.to)){ inDeg[e.to]--; if(inDeg[e.to]===0)next.push(e.to) }
      }))
      queue=next
    }
    ids.filter(id=>!visited.has(id)).forEach(id=>stages.push([id]))
    const STAGE_H=180,GAP=220,SX=200,SY=100
    return syntheticNodes.map(n=>{
      if(typeof n.x==="number"&&typeof n.y==="number") return n
      const si=stages.findIndex(s=>s.includes(n.id))
      const stage=stages[si]??[n.id], pi=stage.indexOf(n.id)
      const tw=(stage.length-1)*GAP
      return {...n, x:SX+pi*GAP-tw/2, y:SY+si*STAGE_H}
    })
  })()

  const [zoom,   setZoom]   = useState(1)
  const [pan,    setPan]    = useState({x:80,y:80})
  const [panSt,  setPanSt]  = useState(null)
  const [selNid, setSelNid] = useState(null)
  const ref = useRef(null)
  const W=190, H=72

  // Fit on mount
  useEffect(() => {
    if(!ref.current||!layoutNodes.length) return
    const r=ref.current.getBoundingClientRect()
    const xs=layoutNodes.map(n=>n.x??0), ys=layoutNodes.map(n=>n.y??0)
    const minX=Math.min(...xs)-60, minY=Math.min(...ys)-60
    const maxX=Math.max(...layoutNodes.map(n=>(n.x??0)+W))+60
    const maxY=Math.max(...layoutNodes.map(n=>(n.y??0)+H))+60
    const z=Math.min(r.width/(maxX-minX),r.height/(maxY-minY),1.4)*0.88
    setPan({x:(r.width-(maxX-minX)*z)/2-minX*z, y:(r.height-(maxY-minY)*z)/2-minY*z})
    setZoom(z)
  },[])

  const makeBez=(x1,y1,x2,y2)=>{
    const dy=Math.abs(y2-y1)*0.5
    return `M${x1},${y1} C${x1},${y1+dy} ${x2},${y2-dy} ${x2},${y2}`
  }

  const STATE_STYLE = {
    completed: { border:"var(--green)",  bg:"var(--green)18",  glow:"0 0 0 2px var(--green)30" },
    failed:    { border:"var(--red)",    bg:"var(--red)18",    glow:"0 0 0 2px var(--red)30"   },
    running:   { border:"var(--cyan)",   bg:"var(--cyan)12",   glow:"0 0 0 2px var(--cyan)30"  },
    skipped:   { border:"var(--border2)",bg:"transparent",     glow:"none"                      },
    pending:   { border:"var(--border2)",bg:"transparent",     glow:"none"                      },
  }
  const STATE_ICON = { completed:"✓", failed:"✗", running:"…", skipped:"—", pending:"·" }
  const STATE_COLOR = { completed:"var(--green)", failed:"var(--red)", running:"var(--cyan)", skipped:"var(--dim)", pending:"var(--dim)" }

  const selNode = layoutNodes.find(n=>n.id===selNid)
  const selState = selNid ? exec.nodeStates?.[selNid] : null
  const selTiming = selNid ? exec.nodeTimings?.[selNid] : null

  const started = new Date(exec.startedAt)
  const dateStr = started.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})
  const flowName = FLOWS.find(f=>f.id===exec.flowId)?.name ?? exec.flowId

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, height:"100%", background:"var(--bg)" }}>

      {/* ── Toolbar ── */}
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"0 20px", height:50,
        borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0 }}>
        <button onClick={onBack} style={{
          display:"flex", alignItems:"center", gap:6, background:"none", border:"none",
          cursor:"pointer", color:"var(--muted)", fontSize:13, fontFamily:"var(--font-ui)", padding:"4px 0",
          transition:"color 0.1s",
        }}
          onMouseEnter={e=>e.currentTarget.style.color="var(--text)"}
          onMouseLeave={e=>e.currentTarget.style.color="var(--muted)"}
        >← Back</button>
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        <div style={{ display:"flex", flexDirection:"column" }}>
          <span style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)", lineHeight:1.2 }}>{flowName}</span>
          <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--dim)" }}>{exec.executionId}</span>
        </div>
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        <StatusPill status={exec.status} />
        {exec.error && (
          <Mono size={11} color="var(--red)" style={{ maxWidth:300, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{exec.error}</Mono>
        )}
        <div style={{ flex:1 }} />
        {/* Run metadata */}
        <div style={{ display:"flex", gap:18, alignItems:"center" }}>
          {[
            { label:"started", val: dateStr, color:"var(--muted)" },
            { label:"duration", val: exec.durationMs ? fmt.duration(exec.durationMs) : "—", color: exec.durationMs>5000?"var(--amber)":"var(--muted)" },
            { label:"trigger", val: typeof exec.trigger==="object" ? exec.trigger.type : exec.trigger, color:"var(--purple)" },
            { label:"nodes", val: Object.keys(exec.nodeStates??{}).length, color:"var(--muted)" },
          ].map(s => (
            <div key={s.label} style={{ display:"flex", flexDirection:"column", alignItems:"flex-end" }}>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:12, fontWeight:600, color:s.color }}>{s.val}</span>
              <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{s.label}</span>
            </div>
          ))}
        </div>
        <div style={{ width:1, height:18, background:"var(--border2)" }} />
        <Mono size={10} color="var(--dim)">{Math.round(zoom*100)}%</Mono>
        <Btn variant="ghost" small onClick={() => {
          if(!ref.current||!layoutNodes.length) return
          const r=ref.current.getBoundingClientRect()
          const xs=layoutNodes.map(n=>n.x??0), ys=layoutNodes.map(n=>n.y??0)
          const minX=Math.min(...xs)-60, minY=Math.min(...ys)-60
          const maxX=Math.max(...layoutNodes.map(n=>(n.x??0)+W))+60
          const maxY=Math.max(...layoutNodes.map(n=>(n.y??0)+H))+60
          const z=Math.min(r.width/(maxX-minX),r.height/(maxY-minY),1.4)*0.88
          setPan({x:(r.width-(maxX-minX)*z)/2-minX*z, y:(r.height-(maxY-minY)*z)/2-minY*z}); setZoom(z)
        }}>⊞ Fit</Btn>
        <div style={{ padding:"3px 8px", borderRadius:4, background:"var(--amber)15", border:"1px solid var(--amber)44",
          fontSize:10, fontFamily:"var(--font-mono)", color:"var(--amber)" }}>review mode</div>
      </div>

      {/* ── Canvas + detail panel ── */}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* Canvas */}
        <div ref={ref} style={{ flex:1, position:"relative", overflow:"hidden", cursor:panSt?"grabbing":"default" }}
          onMouseDown={e=>{
            if(e.button!==0||e.target.closest("[data-rnode]")) return
            setPanSt({sx:e.clientX,sy:e.clientY,opx:pan.x,opy:pan.y})
            setSelNid(null); e.preventDefault()
          }}
          onMouseMove={e=>{ if(panSt) setPan({x:panSt.opx+(e.clientX-panSt.sx),y:panSt.opy+(e.clientY-panSt.sy)}) }}
          onMouseUp={()=>setPanSt(null)}
          onMouseLeave={()=>setPanSt(null)}
          onWheel={e=>{
            e.preventDefault()
            const r=ref.current.getBoundingClientRect()
            const mx=e.clientX-r.left,my=e.clientY-r.top
            const f=e.deltaY<0?1.08:0.93
            const nz=Math.max(0.15,Math.min(3,zoom*f))
            const ratio=nz/zoom
            setPan(p=>({x:mx-(mx-p.x)*ratio,y:my-(my-p.y)*ratio})); setZoom(nz)
          }}
        >
          {/* Dot grid */}
          {(() => {
            const dotSz=22*zoom
            const dotOx=((pan.x%dotSz)+dotSz)%dotSz
            const dotOy=((pan.y%dotSz)+dotSz)%dotSz
            return (
              <div style={{ position:"absolute",inset:0,pointerEvents:"none",
                backgroundImage:"radial-gradient(circle,#ffffff12 1.3px,transparent 1.3px)",
                backgroundSize:`${dotSz}px ${dotSz}px`,backgroundPosition:`${dotOx}px ${dotOy}px` }} />
            )
          })()}

          {/* World */}
          <div style={{ position:"absolute", transformOrigin:"0 0", transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`, width:5000, height:4000 }}>

            {/* Edges */}
            <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",overflow:"visible" }}>
              {rawEdges.map((edge,i) => {
                const fn=layoutNodes.find(n=>n.id===edge.from), tn=layoutNodes.find(n=>n.id===edge.to)
                if(!fn||!tn) return null
                const sp={x:fn.x+W/2, y:fn.y+H}, ep={x:tn.x+W/2, y:tn.y}
                const fromState=exec.nodeStates?.[edge.from]?.status
                const col=fromState==="completed"?"var(--green)":fromState==="failed"?"var(--red)":"var(--border2)"
                return (
                  <g key={i}>
                    <path d={makeBez(sp.x,sp.y,ep.x,ep.y)} stroke={col} strokeWidth={2} fill="none" strokeOpacity={0.6} />
                    <circle cx={ep.x} cy={ep.y} r={4} fill={col} opacity={0.8} />
                  </g>
                )
              })}
            </svg>

            {/* Nodes */}
            {layoutNodes.map(node => {
              const ns = exec.nodeStates?.[node.id] ?? { status:"pending" }
              const timing = exec.nodeTimings?.[node.id]
              const nt = resolveNodeType(node.type)
              const ss = STATE_STYLE[ns.status] ?? STATE_STYLE.pending
              const isSel = node.id === selNid
              const isSlow = exec.slowNodes?.includes(node.id)
              return (
                <div key={node.id} data-rnode={node.id}
                  onClick={() => setSelNid(id => id===node.id ? null : node.id)}
                  style={{
                    position:"absolute", left:node.x, top:node.y, width:W, height:H,
                    background: isSel ? (ss.bg.replace("18","28")) : ss.bg,
                    border:`1.5px solid ${isSel ? ss.border : ss.border+"88"}`,
                    borderRadius:9, cursor:"pointer", userSelect:"none",
                    boxShadow: isSel ? ss.glow : "0 2px 8px rgba(0,0,0,0.35)",
                    transition:"border-color 0.1s, box-shadow 0.1s",
                  }}>

                  {/* Top status stripe */}
                  <div style={{ position:"absolute", top:0, left:0, right:0, height:3, borderRadius:"9px 9px 0 0",
                    background: STATE_COLOR[ns.status] ?? "var(--border2)", opacity:0.8 }} />

                  {/* Content */}
                  <div style={{ padding:"10px 12px 6px", display:"flex", flexDirection:"column", gap:3, height:"100%", boxSizing:"border-box" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <span style={{ fontSize:13, lineHeight:1, color:nt.color }}>{nt.icon}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
                        {node.meta?.name ?? node.id}
                      </span>
                      {/* Status badge */}
                      <span style={{
                        fontSize:10, fontFamily:"var(--font-mono)", fontWeight:700,
                        color: STATE_COLOR[ns.status],
                        flexShrink:0,
                      }}>{STATE_ICON[ns.status] ?? ns.status}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontSize:9, fontFamily:"var(--font-mono)", color:`${nt.color}88`, textTransform:"uppercase", letterSpacing:"0.05em" }}>{node.type}</span>
                      {timing != null && (
                        <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color: isSlow?"var(--amber)":"var(--dim)",
                          marginLeft:"auto", display:"flex", alignItems:"center", gap:3 }}>
                          {isSlow && <span>⚠</span>}{fmt.duration(timing)}
                        </span>
                      )}
                    </div>
                    {ns.error && (
                      <span style={{ fontSize:9, fontFamily:"var(--font-mono)", color:"var(--red)",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", display:"block" }}
                        title={ns.error}>{ns.error}</span>
                    )}
                  </div>

                  {/* Selection ring */}
                  {isSel && <div style={{ position:"absolute", inset:-3, border:`2px solid ${ss.border}`, borderRadius:12, pointerEvents:"none" }} />}
                </div>
              )
            })}
          </div>

          {/* Empty state */}
          {layoutNodes.length === 0 && (
            <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none" }}>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:36,opacity:0.15,marginBottom:10 }}>⬡</div>
                <div style={{ fontSize:13,color:"var(--muted)",opacity:0.4 }}>No flow definition found for this execution</div>
              </div>
            </div>
          )}
        </div>

        {/* ── Node detail panel ── */}
        {selNid && selState && (
          <div style={{ width:300, borderLeft:"1px solid var(--border)", background:"var(--panel)",
            display:"flex", flexDirection:"column", flexShrink:0, overflowY:"auto" }}>
            <div style={{ padding:"16px 18px", borderBottom:"1px solid var(--border)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <span style={{ fontSize:13, color: resolveNodeType(selNode?.type).color }}>
                  {resolveNodeType(selNode?.type).icon}
                </span>
                <span style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)" }}>
                  {selNode?.meta?.name ?? selNid}
                </span>
                <span style={{ marginLeft:"auto", fontSize:11, fontFamily:"var(--font-mono)", fontWeight:700,
                  color: STATE_COLOR[selState.status] }}>
                  {STATE_ICON[selState.status]} {selState.status}
                </span>
              </div>
              <Mono size={10} color="var(--dim)">{selNid}</Mono>
            </div>

            {/* Timing */}
            {selTiming != null && (
              <div style={{ padding:"12px 18px", borderBottom:"1px solid var(--border)" }}>
                <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--dim)", marginBottom:8 }}>Timing</div>
                <div style={{ display:"flex", gap:16 }}>
                  <div>
                    <div style={{ fontSize:18, fontFamily:"var(--font-mono)", fontWeight:700,
                      color: exec.slowNodes?.includes(selNid) ? "var(--amber)" : "var(--text)" }}>
                      {fmt.duration(selTiming)}
                    </div>
                    <div style={{ fontSize:10, color:"var(--dim)" }}>execution time</div>
                  </div>
                  {exec.slowNodes?.includes(selNid) && (
                    <div style={{ padding:"4px 10px", borderRadius:6, background:"var(--amber)15",
                      border:"1px solid var(--amber)44", fontSize:11, color:"var(--amber)",
                      display:"flex", alignItems:"center", gap:5 }}>
                      ⚠ Slow node
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error */}
            {selState.error && (
              <div style={{ padding:"12px 18px", borderBottom:"1px solid var(--border)" }}>
                <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--red)", marginBottom:8 }}>Error</div>
                <div style={{ fontSize:12, fontFamily:"var(--font-mono)", color:"var(--red)",
                  background:"var(--red)0d", border:"1px solid var(--red)33", borderRadius:6,
                  padding:"10px 12px", lineHeight:1.6, wordBreak:"break-word" }}>
                  {selState.error}
                </div>
              </div>
            )}

            {/* Input */}
            {selState.input && (
              <div style={{ padding:"12px 18px", borderBottom:"1px solid var(--border)" }}>
                <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--cyan)", marginBottom:8 }}>Input</div>
                <pre style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--text)",
                  background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6,
                  padding:"10px 12px", margin:0, overflowX:"auto", lineHeight:1.5, maxHeight:180, overflowY:"auto" }}>
                  {JSON.stringify(selState.input, null, 2)}
                </pre>
              </div>
            )}

            {/* Output */}
            {selState.output && (
              <div style={{ padding:"12px 18px" }}>
                <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--green)", marginBottom:8 }}>Output</div>
                <pre style={{ fontSize:11, fontFamily:"var(--font-mono)", color:"var(--text)",
                  background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6,
                  padding:"10px 12px", margin:0, overflowX:"auto", lineHeight:1.5, maxHeight:180, overflowY:"auto" }}>
                  {JSON.stringify(selState.output, null, 2)}
                </pre>
              </div>
            )}

            {/* Placeholder when no IO captured */}
            {!selState.input && !selState.output && !selState.error && (
              <div style={{ padding:"24px 18px", textAlign:"center" }}>
                <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.6 }}>
                  No input/output captured for this node in this execution.
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── Node status legend ── */}
      <div style={{ display:"flex", alignItems:"center", gap:16, padding:"7px 20px",
        borderTop:"1px solid var(--border)", background:"var(--surface)", flexShrink:0 }}>
        <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.07em" }}>Node states</span>
        {Object.entries(STATE_COLOR).map(([s,c]) => (
          <span key={s} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, fontFamily:"var(--font-mono)", color:c }}>
            <span style={{ fontSize:12 }}>{STATE_ICON[s]}</span> {s}
          </span>
        ))}
        <div style={{ flex:1 }} />
        <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)" }}>Click a node to inspect input / output</span>
      </div>
    </div>
  )
}

// ─── APP SHELL ───────────────────────────────────────────────────────────────