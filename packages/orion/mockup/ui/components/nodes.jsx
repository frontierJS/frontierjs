import { useState, useEffect, useRef, useMemo } from 'react'
import { CRED_TYPE_META, ACCOUNT_DATA, FLOWS, now } from './mock.js'
import { Btn, Mono, Toggle, Avatar } from './primitives.jsx'
import { resolveNodeType, allNodeTypes, pluginStore, subflowStore,
         usePluginList, useSubflowList, NODE_CONFIG_FIELDS,
         schemaToFields, resolveNodeFields, ENODE_TYPES } from './node-types.js'

export const WebhookTestPanel = ({ path, nodeId, sampleData, onSampleCapture, runTrigger, onResult, config }) => {
  const [phase,    setPhase]   = useState(sampleData ? "saved" : "idle")
  // "idle" | "listening" | "received" | "saved"
  const [captured, setCaptured] = useState(null)
  const [copied,   setCopied]   = useState(false)
  const [saveFlash,setSaveFlash]= useState(false)
  const [countdown,setCountdown]= useState(null)
  const timerRef = useRef([])

  const testUrl = `/hooks/test${path && path !== "" ? (path.startsWith("/") ? path : "/" + path) : "/my-flow"}`
  const fullTestUrl = `http://localhost:3000${testUrl}`

  // Build defaults object from contextFields
  const buildDefaults = () => {
    const fields = config?.contextFields ?? []
    return Object.fromEntries(
      fields.filter(f => f.name?.trim()).map(f => {
        let val = f.value ?? ""
        try {
          if (f.type === "number")  val = Number(f.value)
          if (f.type === "boolean") val = f.value === "true"
          if (f.type === "object" || f.type === "array") val = JSON.parse(f.value || (f.type==="array"?"[]":"{}"))
        } catch {}
        return [f.name, val]
      })
    )
  }

  const clearTimers = () => { timerRef.current.forEach(clearTimeout); timerRef.current = [] }
  useEffect(() => { if (runTrigger > 0) startListening() }, [runTrigger])

  const startListening = () => {
    clearTimers()
    setPhase("listening")
    setCaptured(null)
    setCountdown(3)

    // Tick countdown
    timerRef.current.push(setTimeout(() => setCountdown(2), 1000))
    timerRef.current.push(setTimeout(() => setCountdown(1), 2000))
    // Auto-fire after 3s
    timerRef.current.push(setTimeout(() => firePayload(), 3000))
  }

  const firePayload = () => {
    const rawPayload = MOCK_WEBHOOK_PAYLOADS[Math.floor(Math.random() * MOCK_WEBHOOK_PAYLOADS.length)]
    const defaults   = buildDefaults()
    // Defaults fill in missing keys; incoming payload wins on conflict
    const merged     = Object.keys(defaults).length > 0
      ? { ...defaults, ...rawPayload }
      : rawPayload
    clearTimers()
    setCaptured({ merged, defaults, rawPayload, hadDefaults: Object.keys(defaults).length > 0 })
    setCountdown(null)
    setPhase("received")
    onResult?.({ output: merged, logs: [], error: null, durationMs: 0 })
  }

  const useSample = () => {
    onSampleCapture(captured.merged)
    setPhase("saved")
    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 2500)
    toast.success("Webhook sample pinned")
  }

  const copy = () => {
    navigator.clipboard?.writeText(fullTestUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  useEffect(() => () => clearTimers(), [])

  // ── colour & border shared ────────────────────────────────────────────────
  const accentCyan   = "var(--cyan)"
  const accentGreen  = "var(--green)"
  const accentAmber  = "var(--amber)"

  return (
    <div style={{ marginTop:14, borderTop:"1px solid var(--border)", paddingTop:14 }}>

      {/* Section label row */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)", fontWeight:500 }}>Test Webhook</span>
          {phase === "listening" && (
            <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, fontFamily:"var(--font-mono)", color:accentAmber }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:accentAmber, display:"inline-block", animation:"pulse 0.9s ease-in-out infinite" }}/>
              listening{countdown != null ? ` · auto-fire in ${countdown}s` : ""}
            </span>
          )}
          {phase === "received" && (
            <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:accentGreen }}>● payload received</span>
          )}
          {phase === "saved" && (
            <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:accentGreen }}>✓ sample saved</span>
          )}
        </div>
        <div style={{ display:"flex", gap:5 }}>
          {(phase === "received" || phase === "saved") && (
            <button onClick={startListening} style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", padding:"1px 4px" }}
              onMouseEnter={e=>e.currentTarget.style.color=accentCyan} onMouseLeave={e=>e.currentTarget.style.color="var(--muted)"}>
              ↺ listen again
            </button>
          )}
          {phase === "listening" && (
            <button onClick={() => { clearTimers(); setPhase("idle"); setCountdown(null) }}
              style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", padding:"1px 4px" }}
              onMouseEnter={e=>e.currentTarget.style.color="var(--red)"} onMouseLeave={e=>e.currentTarget.style.color="var(--muted)"}>
              ✕ stop
            </button>
          )}
        </div>
      </div>

      {/* ── IDLE ─────────────────────────────────────────────────────────── */}
      {phase === "idle" && (
        <button onClick={startListening} style={{
          width:"100%", padding:"9px 0", borderRadius:7, cursor:"pointer",
          background:"transparent", border:`1.5px dashed ${accentCyan}55`,
          color:accentCyan, fontSize:12, fontFamily:"var(--font-ui)",
          display:"flex", alignItems:"center", justifyContent:"center", gap:7,
          transition:"all 0.12s",
        }}
          onMouseEnter={e=>{ e.currentTarget.style.background=`${accentCyan}0d`; e.currentTarget.style.borderColor=accentCyan }}
          onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.borderColor=`${accentCyan}55` }}
        >
          <span style={{ fontSize:14 }}>⏺</span> Listen for test request
        </button>
      )}

      {/* ── LISTENING ────────────────────────────────────────────────────── */}
      {phase === "listening" && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {/* Test URL */}
          <div style={{ background:"var(--bg)", border:`1px solid ${accentAmber}44`, borderRadius:6, padding:"8px 10px" }}>
            <div style={{ fontSize:10, color:"var(--muted)", marginBottom:4, fontFamily:"var(--font-ui)", textTransform:"uppercase", letterSpacing:"0.07em" }}>Send a POST request to</div>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <code style={{ flex:1, fontFamily:"var(--font-mono)", fontSize:11, color:accentAmber, wordBreak:"break-all" }}>{fullTestUrl}</code>
              <button onClick={copy} style={{ background:"none", border:`1px solid var(--border2)`, borderRadius:4, cursor:"pointer", fontSize:10, color: copied ? accentGreen : "var(--muted)", fontFamily:"var(--font-mono)", padding:"2px 7px", flexShrink:0, transition:"color 0.15s" }}>
                {copied ? "✓" : "copy"}
              </button>
            </div>
          </div>
          {/* Manual fire */}
          <button onClick={firePayload} style={{
            width:"100%", padding:"7px 0", borderRadius:6, cursor:"pointer",
            background:`${accentAmber}12`, border:`1px solid ${accentAmber}44`,
            color:accentAmber, fontSize:12, fontFamily:"var(--font-ui)", transition:"all 0.1s",
          }}
            onMouseEnter={e=>{ e.currentTarget.style.background=`${accentAmber}22`; e.currentTarget.style.borderColor=accentAmber }}
            onMouseLeave={e=>{ e.currentTarget.style.background=`${accentAmber}12`; e.currentTarget.style.borderColor=`${accentAmber}44` }}
          >
            ↯ Send mock payload now
          </button>
        </div>
      )}

      {/* ── RECEIVED — payload shown with merge breakdown ────────────────── */}
      {phase === "received" && captured && (
        <div>
          {/* Merge indicator */}
          {captured.hadDefaults && (
            <div style={{ marginBottom:8, padding:"7px 10px", borderRadius:6,
              background:"var(--purple)08", border:"1px solid var(--purple)25",
              fontSize:10, fontFamily:"var(--font-ui)", color:"var(--purple)cc", lineHeight:1.6 }}>
              <div style={{ fontWeight:600, marginBottom:3, display:"flex", alignItems:"center", gap:5 }}>
                <span>⊕</span> Default values merged
              </div>
              <div>
                {Object.keys(captured.defaults).map(k => {
                  const overridden = k in captured.rawPayload
                  return (
                    <span key={k} style={{
                      display:"inline-flex", alignItems:"center", gap:3,
                      marginRight:6, marginBottom:2,
                      padding:"1px 6px", borderRadius:4,
                      background: overridden ? "var(--amber)15" : "var(--purple)15",
                      border: `1px solid ${overridden ? "var(--amber)33" : "var(--purple)33"}`,
                      color: overridden ? "var(--amber)" : "var(--purple)dd",
                      fontFamily:"var(--font-mono)", fontSize:9,
                      textDecoration: overridden ? "line-through" : "none",
                      opacity: overridden ? 0.6 : 1,
                    }}>
                      {k}{overridden ? " ↯" : ""}
                    </span>
                  )
                })}
              </div>
              {Object.keys(captured.defaults).some(k => k in captured.rawPayload) && (
                <div style={{ marginTop:4, fontSize:9, color:"var(--amber)aa" }}>
                  Struck-through keys were overridden by the incoming payload.
                </div>
              )}
            </div>
          )}
          {/* Merged payload preview */}
          <div style={{ position:"relative" }}>
            <div style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.07em",
              color:"var(--dim)", fontFamily:"var(--font-ui)", marginBottom:4 }}>
              {captured.hadDefaults ? "Merged payload" : "Received payload"}
            </div>
            <pre style={{ fontFamily:"var(--font-mono)", fontSize:10.5, color:"var(--green)",
              background:"var(--bg)", border:"1px solid var(--green)22",
              borderRadius:5, padding:"8px 10px", margin:0,
              overflow:"auto", maxHeight:160, lineHeight:1.65 }}>
              {JSON.stringify(captured.merged, null, 2)}
            </pre>
          </div>
          <button onClick={useSample} style={{
            marginTop:8, width:"100%", padding:"6px 0", borderRadius:6, cursor:"pointer",
            background:`${accentGreen}12`, border:`1px solid ${accentGreen}44`,
            color:accentGreen, fontSize:12, fontFamily:"var(--font-ui)", transition:"all 0.1s",
          }}
            onMouseEnter={e=>{ e.currentTarget.style.background=`${accentGreen}22`; e.currentTarget.style.borderColor=accentGreen }}
            onMouseLeave={e=>{ e.currentTarget.style.background=`${accentGreen}12`; e.currentTarget.style.borderColor=`${accentGreen}44` }}
          >📌 Pin as sample data</button>
        </div>
      )}

      {/* ── SAVED — pinned data shown in Output pane ───────────────────── */}
      {phase === "saved" && (
        <div style={{ padding:"9px 12px", background:"var(--green)0a", border:"1px solid var(--green)22", borderRadius:6, fontSize:11, color:"var(--green)", fontFamily:"var(--font-ui)" }}>
          ✓ Sample pinned — downstream steps can reference <code style={{ fontFamily:"var(--font-mono)", fontSize:10 }}>$.{nodeId ?? "trigger"}.*</code>
        </div>
      )}
    </div>
  )
}

// ── CredentialPicker ────────────────────────────────────────────────────────
export const CredentialPicker = ({ value, onChange, filterTypes }) => {
  const creds  = ACCOUNT_DATA.credentials ?? []
  const credId = value?.type === "literal" ? String(value.value ?? "") : ""
  const sel    = creds.find(c => c.id === credId)
  const meta   = sel ? CRED_TYPE_META[sel.type] : null
  const inject = meta?.inject

  // optional filterTypes: only show credentials of certain types (e.g. ["http","oauth2"])
  const visible = filterTypes ? creds.filter(c => filterTypes.includes(c.type)) : creds

  const intoColor = {
    header:     "var(--cyan)",
    basic:      "var(--purple)",
    context:    "var(--amber)",
    smtp:       "var(--cyan)",
    connection: "var(--green)",
  }[inject?.into] ?? "var(--muted)"

  const preview = sel && inject ? inject.preview(sel) : null

  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
        <label style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)" }}>
          Credential
        </label>
        {sel && meta && (
          <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:meta.color, display:"flex", alignItems:"center", gap:4 }}>
            <span>{meta.icon}</span> {meta.label}
          </span>
        )}
      </div>

      <select
        value={credId}
        onChange={e => onChange(e.target.value)}
        style={{ width:"100%", background:"var(--bg)", border:`1px solid ${sel ? meta?.color+"44" ?? "var(--border2)" : "var(--border2)"}`,
          borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none",
          boxSizing:"border-box", fontFamily:"var(--font-ui)", cursor:"pointer" }}
        onFocus={e => e.target.style.borderColor = meta?.color ?? "var(--cyan)"}
        onBlur={e  => e.target.style.borderColor = sel ? meta?.color+"44" ?? "var(--border2)" : "var(--border2)"}
      >
        <option value="">— no credential —</option>
        {visible.map(c => {
          const m = CRED_TYPE_META[c.type]
          return <option key={c.id} value={c.id}>{m?.icon ?? "○"} {c.name}  ({m?.label ?? c.type})</option>
        })}
      </select>

      {/* Injection preview */}
      {preview && (
        <div style={{
          marginTop:7, padding:"8px 10px", borderRadius:6,
          background:`${intoColor}08`, border:`1px solid ${intoColor}22`,
        }}>
          <div style={{ fontSize:10, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.06em", fontFamily:"var(--font-ui)", marginBottom:5 }}>
            Auto-injected at runtime
          </div>
          <div style={{ display:"flex", alignItems:"baseline", gap:6, fontFamily:"var(--font-mono)", fontSize:11, marginBottom:3 }}>
            <span style={{ color:intoColor, flexShrink:0 }}>{preview.label}:</span>
            <span style={{ color:"var(--muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{preview.value}</span>
          </div>
          <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.4 }}>
            {preview.description}
          </div>
        </div>
      )}

      {!visible.length && (
        <div style={{ fontSize:10, color:"var(--dim)", marginTop:4, fontFamily:"var(--font-ui)" }}>
          No credentials yet — add them in Settings → Credentials.
        </div>
      )}

      {visible.length > 0 && !sel && (
        <div style={{ fontSize:10, color:"var(--dim)", marginTop:4, fontFamily:"var(--font-ui)" }}>
          Select a credential — auth will be injected automatically, no manual header config needed.
        </div>
      )}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE-BUILT NODE CONFIG COMPONENTS
// Each covers one node type with proper UX — credential pickers, conditional
// sections, template fields, mode-aware layouts.
// Props: { config, onCfg, upstreamSamples }
//   config        — Record<string, Expression>
//   onCfg(k, v)   — set config[k] = v (v is an Expression or null)
//   upstreamSamples — flattened sample data from upstream nodes
// ═══════════════════════════════════════════════════════════════════════════

// ── Shared micro-helpers ────────────────────────────────────────────────────
export const _Divider = ({ label }) => (
  <div style={{ display:"flex", alignItems:"center", gap:8, margin:"16px 0 12px" }}>
    {label && <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--dim)", fontFamily:"var(--font-ui)", flexShrink:0 }}>{label}</span>}
    <div style={{ flex:1, height:1, background:"var(--border)" }} />
  </div>
)

export const _Field = ({ label, required, hint, children }) => (
  <div style={{ marginBottom:12 }}>
    <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:4 }}>
      <label style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)" }}>{label}</label>
      {required && <span style={{ fontSize:8, color:"var(--amber)", fontFamily:"var(--font-mono)" }}>required</span>}
    </div>
    {children}
    {hint && <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:3, lineHeight:1.4 }}>{hint}</div>}
  </div>
)

export const _Select = ({ value, opts, onChange, def }) => {
  const base = { width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }
  const cur = value?.type === "literal" ? String(value.value ?? "") : def ?? opts[0] ?? ""
  return (
    <select value={cur} onChange={e => onChange({ type:"literal", value:e.target.value })}
      style={base}
      onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}>
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  )
}

// ExprField — ExpressionInput wired for config[key]
export const _ExprField = ({ field, config, onCfg, upstreamSamples }) => (
  <ExpressionInput
    field={field}
    value={config?.[field.key] ?? null}
    onChange={v => onCfg(field.key, v)}
    upstreamSamples={upstreamSamples}
  />
)

// Render a list of ExpressionInput fields from a field-spec array
export const _FieldList = ({ fields, config, onCfg, upstreamSamples }) => (
  <>
    {fields.map(f => (
      <_ExprField key={f.key} field={f} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
    ))}
  </>
)

// ── AiNodeConfig ─────────────────────────────────────────────────────────────
const AI_MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo",
  "claude-sonnet-4-6", "claude-opus-4-6",
  "gemini-2.0-flash", "gemini-1.5-pro",
]
export const AiNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const mode = config?.mode?.value ?? "complete"
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />

  return (
    <div>
      {/* Mode selector — drives which fields show */}
      <_Field label="Mode" required>
        <_Select value={config?.mode} opts={["complete","embed","classify","extract"]} def="complete"
          onChange={v => onCfg("mode", v)} />
      </_Field>

      {/* Credential picker — for all modes */}
      <_Field label="Credential">
        <CredentialPicker value={config?.credential} onChange={v => onCfg("credential", { type:"literal", value:v })} />
      </_Field>

      {/* Model — complete / classify / extract */}
      {(mode === "complete" || mode === "classify" || mode === "extract") && (
        <_Field label="Model" hint="Leave blank to use the workspace default">
          <div style={{ position:"relative" }}>
            {EF({ key:"model", label:"Model", t:"str", ph:"gpt-4o" })}
            {/* Model quick-picks */}
            <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:4 }}>
              {AI_MODELS.slice(0,4).map(m => (
                <button key={m} onClick={() => onCfg("model", { type:"literal", value:m })}
                  style={{
                    fontSize:9, padding:"2px 7px", borderRadius:4, cursor:"pointer", fontFamily:"var(--font-mono)",
                    background: config?.model?.value === m ? "var(--purple)22" : "var(--surface)",
                    border: `1px solid ${config?.model?.value === m ? "var(--purple)55" : "var(--border)"}`,
                    color: config?.model?.value === m ? "var(--purple)" : "var(--dim)",
                    transition:"all 0.1s",
                  }}
                >{m}</button>
              ))}
            </div>
          </div>
        </_Field>
      )}

      {/* ── complete mode ─────────────────────────────── */}
      {mode === "complete" && (
        <>
          <_Divider label="Prompt" />
          {EF({ key:"prompt", label:"Prompt", t:"ta", ph:"You are a helpful assistant. User: {{$.webhookNode.message}}" })}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {EF({ key:"temperature", label:"Temperature", t:"num", ph:"0.7" })}
            {EF({ key:"maxTokens",   label:"Max Tokens",  t:"num", ph:"1024" })}
          </div>
          <_Field label="System Prompt">
            {EF({ key:"systemPrompt", label:"System Prompt", t:"ta", ph:"You are a concise, helpful assistant." })}
          </_Field>
        </>
      )}

      {/* ── embed mode ────────────────────────────────── */}
      {mode === "embed" && (
        <>
          <_Divider label="Input" />
          {EF({ key:"input", label:"Text to embed", t:"ta", ph:"$.prevNode.content" })}
          <_Field label="Dimensions" hint="Optional — defaults to model's native size">
            {EF({ key:"dimensions", label:"Dimensions", t:"num", ph:"1536" })}
          </_Field>
        </>
      )}

      {/* ── classify mode ─────────────────────────────── */}
      {mode === "classify" && (
        <>
          <_Divider label="Classification" />
          {EF({ key:"input", label:"Text to classify", t:"ta", ph:"{{$.webhookNode.body}}" })}
          <_Field label="Categories" hint="One category per line — output: { label, confidence }">
            <textarea
              value={config?.categories?.type === "literal" ? String(config.categories.value ?? "") : ""}
              onChange={e => onCfg("categories", { type:"literal", value:e.target.value })}
              rows={4}
              placeholder={"positive\nnegative\nneutral"}
              style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-mono)", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.6 }}
              onFocus={e=>e.target.style.borderColor="var(--purple)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
          </_Field>
          <div style={{ padding:"8px 10px", borderRadius:6, background:"var(--purple)08", border:"1px solid var(--purple)22", fontSize:10, color:"var(--purple)cc", fontFamily:"var(--font-ui)", lineHeight:1.5 }}>
            Output shape: <code style={{ fontFamily:"var(--font-mono)" }}>{"{ label: string, confidence: number }"}</code><br/>
            Use with edge conditions: <code style={{ fontFamily:"var(--font-mono)" }}>$.{"{nodeId}"}.label == "positive"</code>
          </div>
        </>
      )}

      {/* ── extract mode ──────────────────────────────── */}
      {mode === "extract" && (
        <>
          <_Divider label="Extraction" />
          {EF({ key:"input", label:"Source text", t:"ta", ph:"{{$.webhookNode.body}}" })}
          <_Field label="Output Schema (JSON)" hint="Define the fields to extract — drives output shape">
            <textarea
              value={config?.schema?.type === "literal" ? JSON.stringify(config.schema.value ?? {}, null, 2) : '{\n  "type": "object",\n  "properties": {\n    "name":  { "type": "string" },\n    "email": { "type": "string" },\n    "score": { "type": "number" }\n  }\n}'}
              onChange={e => { try { onCfg("schema", { type:"literal", value:JSON.parse(e.target.value) }) } catch{} }}
              rows={7}
              style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:11, color:"var(--green)", fontFamily:"var(--font-mono)", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
              onFocus={e=>e.target.style.borderColor="var(--purple)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
          </_Field>
        </>
      )}
    </div>
  )
}

// ── NotifySlackNodeConfig ─────────────────────────────────────────────────────
export const NotifySlackNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  return (
    <div>
      <_Field label="Credential">
        <CredentialPicker value={config?.credential} onChange={v => onCfg("credential", { type:"literal", value:v })} />
      </_Field>
      {EF({ key:"channel", label:"Channel", t:"str", ph:"#alerts", required:true })}
      {EF({ key:"message", label:"Message", t:"ta", ph:"New lead from {{$.webhookNode.company}}: {{$.webhookNode.email}}", required:true })}
      <_Divider label="Optional" />
      {EF({ key:"username",  label:"Bot Username",  t:"str", ph:"Orion Bot" })}
      {EF({ key:"iconEmoji", label:"Icon Emoji",    t:"str", ph:":robot_face:" })}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        {EF({ key:"threadTs",   label:"Reply to Thread", t:"str", ph:"$.prevNode.ts" })}
        {EF({ key:"unfurlLinks",label:"Unfurl Links",    t:"sel", opts:["yes","no"], def:"yes" })}
      </div>
      {/* Blocks editor — JSON textarea for rich layout blocks */}
      <_Field label="Blocks (optional)" hint="Slack Block Kit JSON — overrides Message if set">
        <textarea
          value={config?.blocks?.type === "literal" ? JSON.stringify(config.blocks.value ?? [], null, 2) : ""}
          onChange={e => { try { onCfg("blocks", { type:"literal", value:JSON.parse(e.target.value) }) } catch{} }}
          rows={4}
          placeholder={'[\n  { "type": "section", "text": { "type": "mrkdwn", "text": "*Hello*" } }\n]'}
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:11, color:"var(--green)", fontFamily:"var(--font-mono)", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
          onFocus={e=>e.target.style.borderColor="var(--purple)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
        />
      </_Field>
    </div>
  )
}

// ── NotifyEmailNodeConfig ─────────────────────────────────────────────────────
export const NotifyEmailNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  return (
    <div>
      <_Field label="Credential" hint="SMTP / SendGrid / Postmark credential">
        <CredentialPicker value={config?.credential} onChange={v => onCfg("credential", { type:"literal", value:v })} />
      </_Field>
      {EF({ key:"to",      label:"To",      t:"str", ph:"{{$.webhookNode.email}}", required:true })}
      {EF({ key:"cc",      label:"CC",      t:"str", ph:"manager@company.com" })}
      {EF({ key:"from",    label:"From",    t:"str", ph:"noreply@yourapp.com" })}
      {EF({ key:"subject", label:"Subject", t:"str", ph:"Alert: {{$.webhookNode.company}} signed up", required:true })}
      <_Divider label="Body" />
      <_Field label="Content Type">
        <_Select value={config?.contentType} opts={["text","html"]} def="text" onChange={v=>onCfg("contentType",v)} />
      </_Field>
      {EF({ key:"body", label:"Body", t:"ta", ph:"Hello {{$.webhookNode.name}},\n\nYour account is ready.", required:true })}
      <_Divider label="Options" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        {EF({ key:"replyTo",    label:"Reply-To",      t:"str", ph:"support@yourapp.com" })}
        {EF({ key:"retryCount", label:"Retry Attempts", t:"num", ph:"2" })}
      </div>
    </div>
  )
}

// ── StoreNodeConfig ───────────────────────────────────────────────────────────
export const StoreNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const mode = config?.mode?.value ?? "get"
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
        <_Field label="Mode" required>
          <_Select value={config?.mode} opts={["get","set","delete"]} def="get" onChange={v=>onCfg("mode",v)} />
        </_Field>
        <_Field label="Scope">
          <_Select value={config?.scope} opts={["workspace","flow"]} def="workspace" onChange={v=>onCfg("scope",v)} />
        </_Field>
      </div>
      {EF({ key:"key", label:"Key", t:"str", ph:"user:{{$.webhookNode.userId}}", required:true })}
      {mode === "get" && EF({ key:"default", label:"Default (if missing)", t:"str", ph:"null" })}
      {mode === "set" && (
        <>
          {EF({ key:"value", label:"Value", t:"json", ph:'{ "score": 0.92, "tier": "hot" }', required:true })}
          {EF({ key:"ttl",   label:"TTL (ms)", t:"num", ph:"3600000" })}
        </>
      )}
      {mode !== "delete" && (
        <div style={{ padding:"7px 10px", borderRadius:6, background:"var(--green)08", border:"1px solid var(--green)22", fontSize:10, color:"var(--green)aa", fontFamily:"var(--font-mono)", marginTop:4 }}>
          Output: <code>{"{ ok: true, value: … }"}</code> — access via <code>$.{"{nodeId}"}.value</code>
        </div>
      )}
    </div>
  )
}

// ── DataParseNodeConfig ───────────────────────────────────────────────────────
export const DataParseNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const fmt = config?.format?.value ?? "json"
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  return (
    <div>
      {EF({ key:"input", label:"Input", t:"str", ph:"$.httpNode.body", required:true })}
      <_Field label="Format" required>
        <_Select value={config?.format} opts={["json","csv","yaml"]} def="json" onChange={v=>onCfg("format",v)} />
      </_Field>
      {fmt === "csv" && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {EF({ key:"delimiter", label:"Delimiter", t:"str", ph:"," })}
            {EF({ key:"encoding",  label:"Encoding",  t:"str", ph:"utf-8" })}
          </div>
          <_Field label="Headers">
            <_Select value={config?.headers} opts={["first-row","none"]} def="first-row" onChange={v=>onCfg("headers",v)} />
          </_Field>
        </>
      )}
      <_Field label="Output Schema (optional)" hint="Validate and coerce parsed output">
        <textarea
          value={config?.schema?.type === "literal" ? JSON.stringify(config.schema.value ?? {}, null, 2) : ""}
          onChange={e => { try { onCfg("schema", { type:"literal", value:JSON.parse(e.target.value) }) } catch{} }}
          rows={3}
          placeholder={'{ "type": "array", "items": { "type": "object" } }'}
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:11, color:"var(--green)", fontFamily:"var(--font-mono)", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
          onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
        />
      </_Field>
    </div>
  )
}

// ── TransformNodeConfig ───────────────────────────────────────────────────────
export const TRANSFORM_MODES = [
  { id:"map",       icon:"⇒", label:"Map",       desc:"Reshape each item or the whole input" },
  { id:"filter",    icon:"⌥", label:"Filter",    desc:"Keep items matching a condition" },
  { id:"sort",      icon:"↕", label:"Sort",      desc:"Order items by one or more keys" },
  { id:"aggregate", icon:"∑", label:"Aggregate", desc:"Group-by, count, sum, avg, min, max" },
  { id:"dedup",     icon:"◫", label:"Dedup",     desc:"Remove duplicate items by key" },
  { id:"split",     icon:"⊕", label:"Split",     desc:"Explode an array field into separate items" },
]

export const TransformNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const EF   = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  const get  = (k, def="") => config?.[k]?.type === "literal" ? String(config[k].value ?? def) : def
  const set  = (k, v)      => onCfg(k, { type:"literal", value:v })
  const mode = get("mode", "map")

  const modeColor = {
    map:"var(--cyan)", filter:"var(--green)", sort:"var(--amber)",
    aggregate:"var(--purple)", dedup:"var(--red)", split:"var(--cyan)",
  }[mode] ?? "var(--cyan)"

  // Derived expression preview for guided modes
  const exprPreview = () => {
    if (mode === "filter") {
      const arr  = get("inputArray","$.node.items")
      const cond = get("whereCondition","$.item.score > 0.7")
      return JSON.stringify({ type:"filter", over:{ type:"ref", path:arr }, as:"item", where:{ type:"literal", value:cond } }, null, 2)
    }
    if (mode === "sort") {
      const arr = get("inputArray","$.node.items")
      const key = get("sortKey","score")
      const dir = get("sortDir","desc")
      return JSON.stringify({ type:"sort", over:{ type:"ref", path:arr }, by:key, dir }, null, 2)
    }
    if (mode === "aggregate") {
      const arr = get("inputArray","$.node.items")
      const op  = get("aggOp","count")
      const val = get("aggValueKey","score")
      const grp = get("groupByKey","")
      const expr = { type:"aggregate", over:{ type:"ref", path:arr }, op, ...(val && op!=="count" ? { field:val } : {}), ...(grp ? { groupBy:grp } : {}) }
      return JSON.stringify(expr, null, 2)
    }
    if (mode === "dedup") {
      const arr  = get("inputArray","$.node.items")
      const key  = get("dedupKey","id")
      const keep = get("dedupKeep","first")
      return JSON.stringify({ type:"dedup", over:{ type:"ref", path:arr }, by:key, keep }, null, 2)
    }
    if (mode === "split") {
      const path  = get("splitArrayPath","$.node.items")
      const merge = get("splitMergeParent","yes") === "yes"
      return JSON.stringify({ type:"split", path:{ type:"ref", path }, mergeParent:merge }, null, 2)
    }
    return null
  }

  const preview = exprPreview()

  return (
    <div>
      {/* ── Mode picker ── */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontFamily:"var(--font-ui)" }}>Mode</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
          {TRANSFORM_MODES.map(m => {
            const active = mode === m.id
            const c = modeColor
            return (
              <div key={m.id} onClick={() => set("mode", m.id)}
                style={{
                  padding:"7px 9px", borderRadius:6, cursor:"pointer",
                  border:`1px solid ${active ? c+"66" : "var(--border)"}`,
                  background: active ? c+"0f" : "var(--surface)",
                  transition:"all 0.1s",
                }}
                onMouseEnter={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border2)" }}
                onMouseLeave={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border)" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                  <span style={{ fontSize:12, color: active ? c : "var(--muted)" }}>{m.icon}</span>
                  <span style={{ fontSize:11, fontWeight: active ? 600 : 400,
                    color: active ? c : "var(--text)", fontFamily:"var(--font-ui)" }}>{m.label}</span>
                </div>
                <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.3 }}>{m.desc}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Map mode — full expression editor ── */}
      {mode === "map" && (<>
        <_Field label="Expression" required hint="An Orion Expression object that reshapes the input">
          <textarea
            value={config?.expression?.type === "literal"
              ? JSON.stringify(config.expression.value ?? {}, null, 2)
              : config?.expression ? JSON.stringify(config.expression, null, 2) : ""}
            onChange={e => { try { onCfg("expression", JSON.parse(e.target.value)) } catch{} }}
            rows={6}
            placeholder={'{\n  "type": "object",\n  "properties": {\n    "name": { "type": "ref", "path": "lead.name" },\n    "score": { "type": "ref", "path": "lead.score" }\n  }\n}'}
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"6px 10px", fontSize:11, color:"var(--green)", fontFamily:"var(--font-mono)",
              resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </_Field>
        <div style={{ marginTop:4 }}>
          <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", marginBottom:5 }}>Starters:</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
            {[
              { label:"pick fields",
                expr:'{"type":"object","properties":{"name":{"type":"ref","path":"lead.name"},"email":{"type":"ref","path":"lead.email"}}}' },
              { label:"map array",
                expr:'{"type":"map","over":{"type":"ref","path":"$.node.items"},"as":"item","body":{"type":"ref","path":"item.id"}}' },
              { label:"merge objects",
                expr:'{"type":"object","properties":{"source":{"type":"ref","path":"$.nodeA"},"extra":{"type":"ref","path":"$.nodeB"}}}' },
            ].map(ex => (
              <button key={ex.label} onClick={() => { try { onCfg("expression", JSON.parse(ex.expr)) } catch{} }}
                style={{ fontSize:9, padding:"2px 8px", borderRadius:4, cursor:"pointer", fontFamily:"var(--font-mono)",
                  background:"var(--surface)", border:"1px solid var(--border)", color:"var(--muted)", transition:"all 0.1s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)66";e.currentTarget.style.color="var(--cyan)"}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--muted)"}}
              >{ex.label}</button>
            ))}
          </div>
        </div>
      </>)}

      {/* ── Filter mode ── */}
      {mode === "filter" && (<>
        {EF({ key:"inputArray",     label:"Input array",     t:"str", ph:"$.parseNode.items", required:true,
          hint:"Path to the array you want to filter" })}
        {EF({ key:"whereCondition", label:"Keep item when",  t:"str", ph:"$.item.score > 0.7  or  $.item.status === 'active'", required:true,
          hint:"Expression evaluated per item — truthy = keep. Use $.item to reference the current element." })}
      </>)}

      {/* ── Sort mode ── */}
      {mode === "sort" && (<>
        {EF({ key:"inputArray", label:"Input array", t:"str", ph:"$.parseNode.items", required:true })}
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:8 }}>
          {EF({ key:"sortKey", label:"Sort by key", t:"str", ph:"score  or  meta.date", required:true })}
          <_Field label="Direction" required>
            <div style={{ display:"flex", gap:5, marginTop:0 }}>
              {["asc","desc"].map(d => (
                <button key={d} onClick={() => set("sortDir", d)}
                  style={{ flex:1, padding:"6px 0", borderRadius:5, cursor:"pointer", fontSize:11,
                    fontFamily:"var(--font-ui)", fontWeight: get("sortDir","desc")===d ? 600 : 400,
                    background: get("sortDir","desc")===d ? "var(--amber)18" : "var(--surface)",
                    border:`1px solid ${get("sortDir","desc")===d ? "var(--amber)55" : "var(--border)"}`,
                    color: get("sortDir","desc")===d ? "var(--amber)" : "var(--muted)",
                    transition:"all 0.1s" }}>
                  {d === "asc" ? "↑ asc" : "↓ desc"}
                </button>
              ))}
            </div>
          </_Field>
        </div>
      </>)}

      {/* ── Aggregate mode ── */}
      {mode === "aggregate" && (<>
        {EF({ key:"inputArray", label:"Input array", t:"str", ph:"$.parseNode.rows", required:true })}
        <_Field label="Operation" required>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {["count","sum","avg","min","max"].map(op => (
              <button key={op} onClick={() => set("aggOp", op)}
                style={{ padding:"5px 12px", borderRadius:5, cursor:"pointer", fontSize:11,
                  fontFamily:"var(--font-mono)", fontWeight: get("aggOp","count")===op ? 600 : 400,
                  background: get("aggOp","count")===op ? "var(--purple)18" : "var(--surface)",
                  border:`1px solid ${get("aggOp","count")===op ? "var(--purple)55" : "var(--border)"}`,
                  color: get("aggOp","count")===op ? "var(--purple)" : "var(--muted)",
                  transition:"all 0.1s" }}>
                {op}
              </button>
            ))}
          </div>
        </_Field>
        {get("aggOp","count") !== "count" &&
          EF({ key:"aggValueKey", label:"Value field", t:"str", ph:"score  or  amount", required:true,
            hint:"The numeric field to aggregate" })
        }
        {EF({ key:"groupByKey", label:"Group by key (optional)", t:"str", ph:"category  or  status",
          hint:"Leave empty to aggregate the whole array into one result" })}
      </>)}

      {/* ── Dedup mode ── */}
      {mode === "dedup" && (<>
        {EF({ key:"inputArray", label:"Input array", t:"str", ph:"$.fetchNode.leads", required:true })}
        {EF({ key:"dedupKey",   label:"Unique key",  t:"str", ph:"id  or  email", required:true,
          hint:"Items with the same value for this key are considered duplicates" })}
        <_Field label="Keep">
          <div style={{ display:"flex", gap:5 }}>
            {["first","last"].map(k => (
              <button key={k} onClick={() => set("dedupKeep", k)}
                style={{ flex:1, padding:"6px 0", borderRadius:5, cursor:"pointer", fontSize:11,
                  fontFamily:"var(--font-ui)", fontWeight: get("dedupKeep","first")===k ? 600 : 400,
                  background: get("dedupKeep","first")===k ? "var(--red)18" : "var(--surface)",
                  border:`1px solid ${get("dedupKeep","first")===k ? "var(--red)44" : "var(--border)"}`,
                  color: get("dedupKeep","first")===k ? "var(--red)" : "var(--muted)",
                  transition:"all 0.1s" }}>
                {k} occurrence
              </button>
            ))}
          </div>
        </_Field>
      </>)}

      {/* ── Split mode ── */}
      {mode === "split" && (<>
        {EF({ key:"splitArrayPath", label:"Array to split", t:"str", ph:"$.fetchNode.items", required:true,
          hint:"Each element becomes its own item in the execution context" })}
        <_Field label="Merge parent fields">
          <div style={{ display:"flex", gap:5 }}>
            {[["yes","Merge parent into each item"],["no","Array elements only"]].map(([v,lbl]) => (
              <button key={v} onClick={() => set("splitMergeParent", v)}
                style={{ flex:1, padding:"6px 8px", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-ui)", textAlign:"left", lineHeight:1.3,
                  background: get("splitMergeParent","yes")===v ? "var(--cyan)12" : "var(--surface)",
                  border:`1px solid ${get("splitMergeParent","yes")===v ? "var(--cyan)44" : "var(--border)"}`,
                  color: get("splitMergeParent","yes")===v ? "var(--cyan)" : "var(--muted)",
                  transition:"all 0.1s" }}>
                {lbl}
              </button>
            ))}
          </div>
        </_Field>
      </>)}

      {/* ── Expression preview for guided modes ── */}
      {preview && (<>
        <_Divider label="Generated expression" />
        <div style={{ position:"relative" }}>
          <pre style={{ margin:0, padding:"8px 10px", background:"var(--bg)", border:"1px solid var(--border)",
            borderRadius:5, fontSize:10, color:"var(--green)", fontFamily:"var(--font-mono)",
            lineHeight:1.5, overflow:"auto", maxHeight:140 }}>{preview}</pre>
          <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:4, lineHeight:1.4 }}>
            This expression is passed to the executor. Switch to <strong>Map</strong> mode to edit it directly.
          </div>
        </div>
      </>)}

      {/* ── Output contract ── */}
      <_Divider label="Output" />
      <div style={{ padding:"6px 10px", borderRadius:5, background:"var(--surface)", border:"1px solid var(--border)",
        fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)", lineHeight:1.8 }}>
        {mode === "split"     && <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.items[]</span> <span style={{color:"var(--dim)"}}>// one item per element</span></div>}
        {mode === "aggregate" && <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.result</span> <span style={{color:"var(--dim)"}}>// aggregated value or grouped object</span></div>}
        {(mode==="filter"||mode==="sort"||mode==="dedup") && <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.items[]</span> <span style={{color:"var(--dim)"}}>// transformed array</span></div>}
        {mode === "map"       && <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.result</span> <span style={{color:"var(--dim)"}}>// expression output</span></div>}
        <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.count</span>  <span style={{color:"var(--dim)"}}>// item count</span></div>
      </div>
    </div>
  )
}

// ── FlowLoopNodeConfig ────────────────────────────────────────────────────────
export const FlowLoopNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  return (
    <div>
      {EF({ key:"over",     label:"Iterate Over",   t:"str", ph:"$.parseNode.rows", required:true })}
      {EF({ key:"as",       label:"Item Variable",  t:"str", ph:"item", required:true })}
      <_Field label="Max Runs" hint="Hard safety ceiling — prevents infinite loops">
        {EF({ key:"maxRuns", label:"Max Runs", t:"num", ph:"100" })}
      </_Field>
      {EF({ key:"breakWhen", label:"Break Condition", t:"str", ph:"$.item.done == true" })}
      <div style={{ padding:"7px 10px", borderRadius:6, background:"var(--amber)08", border:"1px solid var(--amber)22", fontSize:10, color:"var(--amber)aa", fontFamily:"var(--font-ui)", lineHeight:1.5, marginTop:4 }}>
        Each iteration: downstream nodes see <code style={{ fontFamily:"var(--font-mono)" }}>$.{"{nodeId}"}.current</code> as the current item and <code style={{ fontFamily:"var(--font-mono)" }}>$.{"{nodeId}"}.index</code> as the loop counter.
      </div>
    </div>
  )
}

// ── FlowErrorNodeConfig ───────────────────────────────────────────────────────
export const FlowErrorNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const strategy = config?.strategy?.value ?? "stop"
  const EF = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  const stratColors = { stop:"var(--red)", continue:"var(--amber)", retry:"var(--cyan)" }
  const stratDesc = {
    stop:     "Halt execution immediately. The run is marked as failed.",
    continue: "Log the error and continue. Downstream nodes receive null from the failed node.",
    retry:    "Re-queue the failed node up to the configured attempt limit.",
  }
  return (
    <div>
      <_Field label="Strategy" required>
        <div style={{ display:"flex", gap:6 }}>
          {["stop","continue","retry"].map(s => (
            <button key={s} onClick={() => onCfg("strategy", { type:"literal", value:s })}
              style={{
                flex:1, padding:"7px 0", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"var(--font-ui)", fontWeight:500,
                background: strategy===s ? `${stratColors[s]}18` : "var(--surface)",
                border: `1px solid ${strategy===s ? stratColors[s]+"55" : "var(--border)"}`,
                color: strategy===s ? stratColors[s] : "var(--muted)",
                transition:"all 0.1s",
              }}>
              {s}
            </button>
          ))}
        </div>
      </_Field>
      <div style={{ padding:"8px 10px", borderRadius:6, background:"var(--surface)", border:"1px solid var(--border)", fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.5, marginTop:4 }}>
        {stratDesc[strategy]}
      </div>
      {strategy === "retry" && (
        <>
          <_Divider label="Retry Policy" />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {EF({ key:"maxAttempts", label:"Max Attempts", t:"num", ph:"3" })}
            {EF({ key:"delayMs",     label:"Delay (ms)",   t:"num", ph:"1000" })}
          </div>
          <_Field label="Backoff">
            <_Select value={config?.backoff} opts={["fixed","exponential"]} def="fixed" onChange={v=>onCfg("backoff",v)} />
          </_Field>
        </>
      )}
      <div style={{ marginTop:12, padding:"7px 10px", borderRadius:6, background:"var(--red)06", border:"1px solid var(--red)22", fontSize:10, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.5 }}>
        Receives: <code style={{ fontFamily:"var(--font-mono)", color:"var(--red)aa" }}>{"{ nodeId, error, message, attempt, config }"}</code><br/>
        Connect nodes to this via <strong>error</strong> edges (red edge kind).
      </div>
    </div>
  )
}

// ── TriggerCronNodeConfig ─────────────────────────────────────────────────────
export const CRON_PRESETS = [
  { label:"Every minute",     expr:"* * * * *" },
  { label:"Every hour",       expr:"0 * * * *" },
  { label:"Daily at 9am",     expr:"0 9 * * *" },
  { label:"Weekdays at 9am",  expr:"0 9 * * 1-5" },
  { label:"Weekly (Mon)",     expr:"0 9 * * 1" },
  { label:"Monthly (1st)",    expr:"0 9 1 * *" },
]
// ── TriggerContextEditor ──────────────────────────────────────────────────────
// Shared key/value editor used by all trigger types.
// mode: "initial"  → values seed the execution context from scratch (cron, manual)
// mode: "defaults" → values merged with incoming payload; incoming wins (webhook, event)
const TRIGGER_CTX_FIELD_TYPES = ["string","number","boolean","object","array"]
const TRIGGER_CTX_TYPE_COLOR = {
  string:"var(--cyan)", number:"var(--amber)", boolean:"var(--purple)",
  object:"var(--green)", array:"var(--green)",
}
const TRIGGER_CTX_TYPE_PH = {
  string:"Hello world", number:"42", boolean:"true",
  object:'{"key":"value"}', array:'["a","b"]',
}

export const TriggerContextEditor = ({ config, onCfg, mode = "initial", nodeId = "trigger" }) => {
  const fields = config?.contextFields ?? []

  const setFields = (next) => onCfg("contextFields", next)
  const addField  = () => setFields([...fields, { id:`cf_${Date.now().toString(36)}`, name:"", type:"string", value:"" }])
  const delField  = (id) => setFields(fields.filter(f => f.id !== id))
  const patch     = (id, k, v) => setFields(fields.map(f => f.id===id ? {...f,[k]:v} : f))

  const preview = Object.fromEntries(
    fields.filter(f => f.name.trim()).map(f => {
      let val = f.value
      try {
        if (f.type === "number")  val = Number(f.value)
        if (f.type === "boolean") val = f.value === "true"
        if (f.type === "object" || f.type === "array") val = JSON.parse(f.value || (f.type==="array"?"[]":"{}"))
      } catch {}
      return [f.name, val]
    })
  )

  const isDefaults = mode === "defaults"
  const accentColor = isDefaults ? "var(--purple)" : "var(--green)"
  const sectionLabel = isDefaults ? "Default Values" : "Initial Context"
  const emptyHint = isDefaults
    ? "No defaults defined.\nAdd fields to fill in any keys the incoming payload might be missing."
    : "No initial context defined.\nAdd fields to seed the execution with data when this trigger fires."
  const footerHint = isDefaults
    ? `These values are merged with the incoming payload at <code style="font-family:var(--font-mono)">$.${nodeId}</code>. Incoming keys take priority over defaults.`
    : `These values are injected into the execution context at <code style="font-family:var(--font-mono)">$.${nodeId}</code> when this trigger fires.`

  return (
    <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid var(--border)" }}>
      {/* Header row */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:12, color:accentColor }}>{ isDefaults ? "⊕" : "⟐" }</span>
          <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em",
            color:"var(--muted)", fontFamily:"var(--font-ui)", fontWeight:600 }}>
            {sectionLabel}
          </div>
          {fields.length > 0 && (
            <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:accentColor,
              background:`${accentColor}15`, border:`1px solid ${accentColor}33`,
              padding:"0px 6px", borderRadius:8 }}>{fields.length}</span>
          )}
        </div>
        <button onClick={addField} style={{
          display:"flex", alignItems:"center", gap:4,
          fontSize:11, fontFamily:"var(--font-ui)", cursor:"pointer",
          background:`${accentColor}0d`, border:`1px solid ${accentColor}33`,
          color:accentColor, borderRadius:5, padding:"3px 9px", transition:"all 0.1s",
        }}
          onMouseEnter={e=>{e.currentTarget.style.background=`${accentColor}1a`}}
          onMouseLeave={e=>{e.currentTarget.style.background=`${accentColor}0d`}}>
          + Add field
        </button>
      </div>

      {fields.length === 0 ? (
        <div style={{ padding:"16px 14px", textAlign:"center",
          border:`1px dashed ${accentColor}30`, borderRadius:7, background:`${accentColor}05` }}>
          <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.7,
            whiteSpace:"pre-line" }}>{emptyHint}</div>
          <button onClick={addField} style={{
            marginTop:10, fontSize:11, fontFamily:"var(--font-ui)", cursor:"pointer",
            background:"transparent", border:"1px solid var(--border2)",
            color:"var(--muted)", borderRadius:5, padding:"4px 12px",
          }}>+ Add first field</button>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {/* Column headers */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 88px 1fr 22px",
            gap:5, paddingBottom:4, borderBottom:"1px solid var(--border)" }}>
            {["Key","Type","Default value",""].map(h => (
              <div key={h} style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.07em",
                color:"var(--dim)", fontFamily:"var(--font-ui)" }}>{h}</div>
            ))}
          </div>
          {fields.map(field => {
            const tc = TRIGGER_CTX_TYPE_COLOR[field.type] ?? "var(--muted)"
            return (
              <div key={field.id} style={{ display:"grid", gridTemplateColumns:"1fr 88px 1fr 22px", gap:5, alignItems:"center" }}>
                <input value={field.name} onChange={e=>patch(field.id,"name",e.target.value)}
                  placeholder="keyName"
                  style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:4,
                    padding:"5px 8px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-mono)",
                    outline:"none", width:"100%", boxSizing:"border-box" }}
                  onFocus={e=>e.target.style.borderColor=`${accentColor}55`}
                  onBlur={e=>e.target.style.borderColor="var(--border2)"} />
                <select value={field.type} onChange={e=>patch(field.id,"type",e.target.value)}
                  style={{ background:"var(--bg)", border:`1px solid ${tc}55`, borderRadius:4,
                    padding:"5px 6px", fontSize:11, color:tc, fontFamily:"var(--font-ui)",
                    outline:"none", cursor:"pointer", width:"100%", boxSizing:"border-box" }}>
                  {TRIGGER_CTX_FIELD_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                {field.type === "boolean" ? (
                  <select value={field.value} onChange={e=>patch(field.id,"value",e.target.value)}
                    style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:4,
                      padding:"5px 6px", fontSize:12, color:"var(--purple)", fontFamily:"var(--font-ui)",
                      outline:"none", cursor:"pointer", width:"100%", boxSizing:"border-box" }}>
                    <option value="true">true</option><option value="false">false</option>
                  </select>
                ) : (
                  <input value={field.value} onChange={e=>patch(field.id,"value",e.target.value)}
                    placeholder={TRIGGER_CTX_TYPE_PH[field.type]}
                    style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:4,
                      padding:"5px 8px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-mono)",
                      outline:"none", width:"100%", boxSizing:"border-box" }}
                    onFocus={e=>e.target.style.borderColor=`${tc}55`}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"} />
                )}
                <button onClick={()=>delField(field.id)} style={{
                  background:"none", border:"none", cursor:"pointer", color:"var(--muted)",
                  fontSize:14, lineHeight:1, padding:0, display:"flex", alignItems:"center", justifyContent:"center",
                  transition:"color 0.1s",
                }}
                  onMouseEnter={e=>e.currentTarget.style.color="var(--red)"}
                  onMouseLeave={e=>e.currentTarget.style.color="var(--muted)"}>×</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Live preview */}
      {fields.some(f=>f.name.trim()) && (
        <div style={{ marginTop:10 }}>
          <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em",
            color:"var(--dim)", fontFamily:"var(--font-ui)", marginBottom:5 }}>
            {isDefaults ? "Merged defaults preview" : "Injected context preview"}
          </div>
          <pre style={{ fontFamily:"var(--font-mono)", fontSize:10.5, color:accentColor,
            background:"var(--bg)", border:`1px solid ${accentColor}22`,
            borderRadius:5, padding:"9px 11px", margin:0,
            overflow:"auto", maxHeight:110, lineHeight:1.65 }}>
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}

      {/* Footer hint */}
      <div style={{ marginTop:10, padding:"7px 10px", borderRadius:6,
        background:`${accentColor}06`, border:`1px solid ${accentColor}18`,
        fontSize:10, color:`${accentColor}99`, fontFamily:"var(--font-ui)", lineHeight:1.6 }}
        dangerouslySetInnerHTML={{ __html: footerHint }} />
    </div>
  )
}

export const TriggerCronNodeConfig = ({ config, onCfg }) => {
  const expr = config?.expression?.type === "literal" ? String(config.expression.value ?? "") : ""
  // Naive next-run preview
  const parts = expr.trim().split(/\s+/)
  const validParts = parts.length >= 5
  return (
    <div>
      <_Field label="Cron Expression" required hint="Standard 5-part cron: minute hour day month weekday">
        <input value={expr} onChange={e => onCfg("expression", { type:"literal", value:e.target.value })}
          placeholder="0 9 * * 1-5"
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:13, color:"var(--text)", fontFamily:"var(--font-mono)", outline:"none", boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
        />
      </_Field>
      {/* Presets */}
      <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:12 }}>
        {CRON_PRESETS.map(p => (
          <button key={p.expr} onClick={() => onCfg("expression", { type:"literal", value:p.expr })}
            style={{
              fontSize:10, padding:"3px 8px", borderRadius:4, cursor:"pointer", fontFamily:"var(--font-ui)",
              background: expr===p.expr ? "var(--cyan)18" : "var(--surface)",
              border: `1px solid ${expr===p.expr ? "var(--cyan)55" : "var(--border)"}`,
              color: expr===p.expr ? "var(--cyan)" : "var(--muted)",
              transition:"all 0.1s",
            }}
          >{p.label}</button>
        ))}
      </div>
      {/* Breakdown */}
      {validParts && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:4, marginBottom:12 }}>
          {["Min","Hour","Day","Mon","Dow"].map((l, i) => (
            <div key={l} style={{ background:"var(--surface)", borderRadius:5, padding:"5px 0", textAlign:"center", border:"1px solid var(--border)" }}>
              <div style={{ fontSize:12, fontFamily:"var(--font-mono)", color:"var(--cyan)" }}>{parts[i]}</div>
              <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:2 }}>{l}</div>
            </div>
          ))}
        </div>
      )}
      <_Field label="Timezone" hint="IANA timezone name">
        <input value={config?.timezone?.type==="literal"?String(config.timezone.value??""):"UTC"}
          onChange={e=>onCfg("timezone",{type:"literal",value:e.target.value})}
          placeholder="UTC"
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", outline:"none", boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
        />
      </_Field>
      <TriggerContextEditor config={config} onCfg={onCfg} mode="initial" nodeId="cronTrigger" />
    </div>
  )
}

// ── TriggerEventNodeConfig ────────────────────────────────────────────────────
const COMMON_EVENTS = [
  "user.created","user.updated","user.deleted",
  "payment.completed","payment.failed","subscription.created",
  "email.opened","email.clicked","form.submitted",
]
export const TriggerEventNodeConfig = ({ config, onCfg }) => {
  const evtName = config?.eventName?.type === "literal" ? String(config.eventName.value ?? "") : ""
  return (
    <div>
      <_Field label="Event Name" required hint="Emitted via POST /events/:name or the SDK">
        <input value={evtName} onChange={e => onCfg("eventName", { type:"literal", value:e.target.value })}
          placeholder="user.created"
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:13, color:"var(--text)", fontFamily:"var(--font-mono)", outline:"none", boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
        />
      </_Field>
      <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:12 }}>
        {COMMON_EVENTS.map(e => (
          <button key={e} onClick={() => onCfg("eventName", { type:"literal", value:e })}
            style={{
              fontSize:9, padding:"2px 8px", borderRadius:4, cursor:"pointer", fontFamily:"var(--font-mono)",
              background: evtName===e ? "var(--purple)18" : "var(--surface)",
              border: `1px solid ${evtName===e ? "var(--purple)55" : "var(--border)"}`,
              color: evtName===e ? "var(--purple)" : "var(--dim)",
              transition:"all 0.1s",
            }}
          >{e}</button>
        ))}
      </div>
      <div style={{ padding:"7px 10px", borderRadius:6, background:"var(--purple)08", border:"1px solid var(--purple)22", fontSize:10, color:"var(--purple)cc", fontFamily:"var(--font-ui)", lineHeight:1.5 }}>
        Emit via SDK: <code style={{ fontFamily:"var(--font-mono)" }}>orion.emit("{evtName || "event.name"}", payload)</code><br/>
        Or: <code style={{ fontFamily:"var(--font-mono)" }}>POST /events/{evtName || ":name"}</code>
      </div>
      <TriggerContextEditor config={config} onCfg={onCfg} mode="defaults" nodeId="eventTrigger" />
    </div>
  )
}

// ── TriggerManualNodeConfig ───────────────────────────────────────────────────

export const TriggerManualNodeConfig = ({ config, onCfg, runTrigger, onResult, onSample }) => {
  const label  = config?.label?.type === "literal" ? String(config.label.value ?? "") : ""

  // Build preview from shared contextFields key
  const fields = config?.contextFields ?? []
  const preview = Object.fromEntries(
    fields.filter(f => f.name?.trim()).map(f => {
      let val = f.value ?? ""
      try {
        if (f.type === "number")  val = Number(f.value)
        if (f.type === "boolean") val = f.value === "true"
        if (f.type === "object" || f.type === "array") val = JSON.parse(f.value || (f.type==="array"?"[]":"{}"))
      } catch {}
      return [f.name, val]
    })
  )

  // Fire when the ▶ Run button is pressed
  useEffect(() => {
    if (!runTrigger) return
    const t0 = Date.now()
    const output = Object.keys(preview).length > 0 ? preview : {}
    onResult?.({
      output,
      logs:  [{ level:"info", message:`Manual trigger fired${label ? ` — "${label}"` : ""}`, ts: t0 }],
      error: null, durationMs: Date.now() - t0,
    })
    onSample?.(output)
  }, [runTrigger])

  return (
    <div>
      {/* Label */}
      <_Field label="Trigger label" hint="Shows up in the run history trigger column">
        <input value={label} onChange={e => onCfg("label", { type:"literal", value:e.target.value })}
          placeholder="e.g. Test run, Seed data…"
          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
            padding:"6px 10px", fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)",
            outline:"none", boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor="var(--cyan)"}
          onBlur={e=>e.target.style.borderColor="var(--border2)"} />
      </_Field>
      <TriggerContextEditor config={config} onCfg={onCfg} mode="initial" nodeId={label || "manualTrigger"} />
    </div>
  )
}

// ── SubflowNodeConfig ─────────────────────────────────────────────────────────
// Shown inside NodeInspector when the node type is subflow.*
export const SubflowNodeConfig = ({ node, onCfg, upstreamSamples }) => {
  const nt = resolveNodeType(node.type)
  const inputs  = nt.inputs  ?? []
  const outputs = nt.outputs ?? []
  if (!inputs.length && !outputs.length) {
    return <div style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)", padding:"8px 0" }}>No ports declared on this subflow.</div>
  }
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {inputs.length > 0 && (
        <div>
          <div style={{ fontSize:11, color:"var(--green)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)", marginBottom:8, fontWeight:600 }}>
            Inputs
          </div>
          {inputs.map(p => (
            <div key={p.id} style={{ marginBottom:8 }}>
              <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-mono)", marginBottom:3 }}>
                {p.name} <span style={{ color:"var(--muted)" }}>:{p.type}</span>
              </div>
              <ExpressionInput
                value={node.config?.[p.name] ?? { type:"literal", value:"" }}
                onChange={v => onCfg(p.name, v)}
                upstreamSamples={upstreamSamples}
                placeholder={`$.upstream.${p.name}`}
              />
            </div>
          ))}
        </div>
      )}
      {outputs.length > 0 && (
        <div>
          <div style={{ fontSize:11, color:"var(--cyan)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)", marginBottom:6, fontWeight:600 }}>
            Outputs
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
            {outputs.map(p => (
              <span key={p.id} style={{ fontSize:10, fontFamily:"var(--font-mono)", padding:"2px 8px", borderRadius:3,
                background:"var(--cyan)10", border:"1px solid var(--cyan)33", color:"var(--cyan)" }}>
                $.{node.id}.{p.name}
              </span>
            ))}
          </div>
          <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:6, lineHeight:1.5 }}>
            Output fields are written to context after the subflow completes and are available to downstream nodes.
          </div>
        </div>
      )}
    </div>
  )
}

// ── _NodeConfigBody — used by both SlotCard and NodeInspector ─────────────────
// Returns the right config component or falls back to field list for generics
export const _NodeConfigBody = ({ type, config, onCfg, upstreamSamples, onSample, runTrigger, onResult, node, onPatch }) => {
  // Subflow node — show port bindings
  if (type?.startsWith("subflow.")) return <SubflowNodeConfig node={node} onCfg={onCfg} upstreamSamples={upstreamSamples} />

  const CustomComp = NODE_CONFIG_COMPONENT[type]

  // Custom purpose-built components
  if (type === "trigger.webhook") return (
    <>
      <WebhookNodeConfig config={config} onCfg={onCfg} />
      <WebhookTestPanel
        path={config?.path?.type==="literal"?String(config.path.value??""):""}
        nodeId={node?.id ?? "trigger"}
        sampleData={node?.sampleData??null}
        onSampleCapture={onSample ?? (data=>onPatch?.({sampleData:data}))}
        runTrigger={runTrigger}
        onResult={onResult}
        config={config}
      />
    </>
  )
  if (type === "http.request") return (
    <HttpRequestNodeConfig config={config} onCfg={onCfg}
      onSampleCapture={onSample ?? (data=>onPatch?.({sampleData:data}))}
      runTrigger={runTrigger} upstreamSamples={upstreamSamples} />
  )
  if (type === "code") return (
    <CodeNodeEditor node={node} upstreamSamples={upstreamSamples} onCfg={onCfg}
      onPatch={onPatch ?? (patch=>{ if(patch.sampleData) onSample?.(patch.sampleData) })}
      onResult={onResult} runTrigger={runTrigger} />
  )
  if (CustomComp) {
    // trigger.manual gets run wiring; other custom comps get config only
    if (type === "trigger.manual") return (
      <CustomComp config={config} onCfg={onCfg} upstreamSamples={upstreamSamples}
        runTrigger={runTrigger} onResult={onResult}
        onSample={onSample ?? (data => onPatch?.({ sampleData: data }))} />
    )
    return <CustomComp config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  }

  // Generic field list fallback (trigger.manual, plugin nodes without custom comp, etc.)
  const fields = resolveNodeFields(type)
  if (!fields.length) return (
    <div style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)", padding:"8px 0" }}>No configuration needed.</div>
  )
  return <_FieldList fields={fields} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
}

// ── WebhookNodeConfig ────────────────────────────────────────────────────────
export const WebhookNodeConfig = ({ config, onCfg }) => {
  const get  = (k, def="") => config?.[k]?.type==="literal" ? String(config[k].value ?? def) : def
  const set  = (k, v) => onCfg(k, { type:"literal", value:v })
  const auth = get("auth","none")
  const respondWith = get("respondWith","onReceived")
  const [showAdvanced, setShowAdvanced] = useState(false)

  const LBL  = { fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4, display:"block", fontFamily:"var(--font-ui)" }
  const base = { width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", boxSizing:"border-box", fontFamily:"var(--font-ui)" }
  const mono = { ...base, fontFamily:"var(--font-mono)", color:"var(--green)" }
  const fo   = e=>e.target.style.borderColor="var(--cyan)", bl = e=>e.target.style.borderColor="var(--border2)"

  const AUTH_META = {
    header: { label:"Header Token",  color:"var(--cyan)",   icon:"⌗", hint:"Caller must send a matching value in a request header (e.g. X-Webhook-Secret)." },
    basic:  { label:"Basic Auth",    color:"var(--purple)", icon:"◉", hint:"Caller must provide a valid username and password via HTTP Basic authentication." },
    bearer: { label:"Bearer Token",  color:"var(--green)",  icon:"⬡", hint:"Caller must send Authorization: Bearer <token> with a token you define here." },
    hmac:   { label:"HMAC Signature",color:"var(--amber)",  icon:"⟁", hint:"Orion verifies the request payload signature using a shared secret. Common for GitHub, Stripe, etc." },
  }
  const am = AUTH_META[auth]

  // Detect if any advanced options are non-default so we can show a badge
  const hasAdvanced = get("rawBody","no") === "yes"
    || get("binary","no") === "yes"
    || (get("allowedIPs","") && get("allowedIPs","") !== "0.0.0.0/0" && get("allowedIPs","") !== "")

  return (
    <div>
      {/* Method + Path — same line */}
      <div style={{ marginBottom:12 }}>
        <label style={LBL}>Endpoint</label>
        <div style={{ display:"flex", gap:6 }}>
          <select
            value={get("method","POST")}
            onChange={e=>set("method",e.target.value)}
            style={{ ...base, width:"auto", minWidth:82, cursor:"pointer", flexShrink:0 }}
            onFocus={fo} onBlur={bl}
          >
            {["POST","GET","PUT","PATCH","DELETE","ANY"].map(m=><option key={m}>{m}</option>)}
          </select>
          <input
            value={get("path")}
            onChange={e=>set("path",e.target.value)}
            placeholder="/hooks/my-flow"
            style={{ ...base, flex:1, fontFamily:"var(--font-mono)", color:"var(--green)" }}
            onFocus={fo} onBlur={bl}
          />
        </div>
        <div style={{ fontSize:10, color:"var(--dim)", marginTop:3, fontFamily:"var(--font-ui)" }}>
          Full URL: <code style={{ fontFamily:"var(--font-mono)", color:"var(--cyan)" }}>
            {get("method","POST")} /hooks{get("path","/my-flow")}
          </code>
        </div>
      </div>

      {/* Authentication type selector */}
      <div style={{ marginBottom: auth==="none" ? 12 : 10 }}>
        <label style={LBL}>Authentication</label>
        <select value={auth} onChange={e=>set("auth",e.target.value)} style={{ ...base, cursor:"pointer" }}>
          {[["none","None — public endpoint"],["header","Header Token"],["basic","Basic Auth"],["bearer","Bearer Token"],["hmac","HMAC Signature"]].map(([v,l])=>(
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      {/* Per-auth inline fields */}
      {auth !== "none" && am && (
        <div style={{ marginBottom:14, padding:"12px 14px", borderRadius:7,
          background:`${am.color}08`, border:`1px solid ${am.color}30` }}>
          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:6 }}>
            <span style={{ fontSize:14, color:am.color }}>{am.icon}</span>
            <span style={{ fontSize:12, fontWeight:600, color:am.color, fontFamily:"var(--font-ui)" }}>{am.label}</span>
          </div>
          <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.5, marginBottom:12 }}>{am.hint}</div>

          {auth === "header" && (<>
            <div style={{ marginBottom:8 }}>
              <label style={LBL}>Header Name</label>
              <input value={get("authHeaderName","X-Webhook-Secret")} onChange={e=>set("authHeaderName",e.target.value)}
                placeholder="X-Webhook-Secret" style={base} onFocus={fo} onBlur={bl} />
            </div>
            <div>
              <label style={LBL}>Expected Value <span style={{ color:"var(--dim)", textTransform:"none", letterSpacing:0 }}>(secret token)</span></label>
              <input type="password" value={get("authHeaderValue","")} onChange={e=>set("authHeaderValue",e.target.value)}
                placeholder="••••••••••••••••" style={mono} onFocus={fo} onBlur={bl} />
              <div style={{ fontSize:10, color:"var(--dim)", marginTop:3 }}>Orion will reject requests where this header is missing or doesn't match.</div>
            </div>
          </>)}

          {auth === "basic" && (<>
            <div style={{ marginBottom:8 }}>
              <label style={LBL}>Username</label>
              <input value={get("authUsername","")} onChange={e=>set("authUsername",e.target.value)}
                placeholder="webhook-user" style={base} onFocus={fo} onBlur={bl} />
            </div>
            <div>
              <label style={LBL}>Password</label>
              <input type="password" value={get("authPassword","")} onChange={e=>set("authPassword",e.target.value)}
                placeholder="••••••••••••••••" style={mono} onFocus={fo} onBlur={bl} />
              <div style={{ fontSize:10, color:"var(--dim)", marginTop:3 }}>Caller must send a valid <code style={{ fontFamily:"var(--font-mono)" }}>Authorization: Basic …</code> header.</div>
            </div>
          </>)}

          {auth === "bearer" && (
            <div>
              <label style={LBL}>Expected Token</label>
              <input type="password" value={get("authBearerToken","")} onChange={e=>set("authBearerToken",e.target.value)}
                placeholder="••••••••••••••••" style={mono} onFocus={fo} onBlur={bl} />
              <div style={{ fontSize:10, color:"var(--dim)", marginTop:3 }}>Caller must send <code style={{ fontFamily:"var(--font-mono)", color:"var(--green)" }}>Authorization: Bearer &lt;token&gt;</code></div>
            </div>
          )}

          {auth === "hmac" && (<>
            <div style={{ marginBottom:8 }}>
              <label style={LBL}>Signing Secret</label>
              <input type="password" value={get("authHmacSecret","")} onChange={e=>set("authHmacSecret",e.target.value)}
                placeholder="••••••••••••••••" style={mono} onFocus={fo} onBlur={bl} />
            </div>
            <div style={{ marginBottom:8 }}>
              <label style={LBL}>Algorithm</label>
              <select value={get("authHmacAlgo","sha256")} onChange={e=>set("authHmacAlgo",e.target.value)} style={{ ...base, cursor:"pointer" }}>
                {["sha256","sha1","sha512"].map(a=><option key={a} value={a}>HMAC-{a.toUpperCase()}</option>)}
              </select>
            </div>
            <div>
              <label style={LBL}>Signature Header</label>
              <input value={get("authHmacHeader","X-Hub-Signature-256")} onChange={e=>set("authHmacHeader",e.target.value)}
                placeholder="X-Hub-Signature-256" style={base} onFocus={fo} onBlur={bl} />
              <div style={{ fontSize:10, color:"var(--dim)", marginTop:3 }}>Orion reads the signature from this header and validates it against the request body.</div>
            </div>
          </>)}
        </div>
      )}

      {/* Respond with */}
      <div style={{ marginBottom:6 }}>
        <label style={LBL}>Respond With</label>
        <select value={respondWith} onChange={e=>set("respondWith",e.target.value)} style={{ ...base, cursor:"pointer" }}>
          {[["onReceived","Immediately (202 Accepted)"],["lastNode","Last node output"],["fixed","Fixed response"]].map(([v,l])=>(
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
      {respondWith === "fixed" && (
        <div style={{ marginBottom:12, paddingLeft:10, borderLeft:"2px solid var(--border2)" }}>
          <div style={{ marginBottom:8 }}>
            <label style={LBL}>Status Code</label>
            <input type="number" value={get("responseCode","200")} onChange={e=>set("responseCode",e.target.value)} style={base} onFocus={fo} onBlur={bl} />
          </div>
          <div>
            <label style={LBL}>Response Body</label>
            <textarea rows={3} value={get("responseBody","")} onChange={e=>set("responseBody",e.target.value)} placeholder={'{"ok":true}'}
              style={{ ...base, fontFamily:"var(--font-mono)", color:"var(--green)", resize:"vertical" }} onFocus={fo} onBlur={bl} />
          </div>
        </div>
      )}

      {/* ── Advanced options ─────────────────────────────────────── */}
      <div style={{ marginTop:14, borderTop:"1px solid var(--border)", paddingTop:10 }}>
        <button
          onClick={() => setShowAdvanced(v => !v)}
          style={{
            display:"flex", alignItems:"center", gap:6, width:"100%",
            background:"none", border:"none", cursor:"pointer", padding:"2px 0",
            color:"var(--muted)", fontFamily:"var(--font-ui)", fontSize:11,
            textAlign:"left",
          }}
        >
          <span style={{ fontSize:9, color:"var(--dim)", transition:"transform 0.15s",
            display:"inline-block", transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
          <span>Advanced</span>
          {hasAdvanced && (
            <span style={{ fontSize:9, background:"var(--cyan)22", color:"var(--cyan)",
              border:"1px solid var(--cyan)33", borderRadius:8, padding:"0 5px", lineHeight:"15px" }}>
              active
            </span>
          )}
        </button>

        {showAdvanced && (
          <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:12 }}>

            {/* Raw body */}
            <div>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", marginBottom:2 }}>Pass Raw Body</div>
                  <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.4 }}>
                    Expose the unparsed request body as <code style={{ fontFamily:"var(--font-mono)", color:"var(--cyan)" }}>$.trigger.rawBody</code> — required for HMAC signature verification.
                  </div>
                </div>
                <Toggle
                  value={get("rawBody","no") === "yes"}
                  onChange={v => set("rawBody", v ? "yes" : "no")}
                />
              </div>
            </div>

            {/* Binary data */}
            <div>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:"var(--text)", fontFamily:"var(--font-ui)", marginBottom:2 }}>Accept Binary Data</div>
                  <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.4 }}>
                    Treat the body as binary (Buffer) instead of parsing as JSON or text. Available as <code style={{ fontFamily:"var(--font-mono)", color:"var(--cyan)" }}>$.trigger.binary</code> — base64-encoded.
                  </div>
                </div>
                <Toggle
                  value={get("binary","no") === "yes"}
                  onChange={v => set("binary", v ? "yes" : "no")}
                />
              </div>
            </div>

            {/* IP Allowlist */}
            <div>
              <label style={LBL}>IP Allowlist <span style={{ textTransform:"none", letterSpacing:0, color:"var(--dim)" }}>— CIDR, comma-separated</span></label>
              <input
                value={get("allowedIPs","")}
                onChange={e=>set("allowedIPs",e.target.value)}
                placeholder="192.168.1.0/24, 10.0.0.1/32"
                style={base} onFocus={fo} onBlur={bl}
              />
              <div style={{ fontSize:10, color:"var(--dim)", marginTop:3 }}>
                Leave blank to allow all sources. Requests from unlisted IPs receive a 403.
              </div>
            </div>

          </div>
        )}
      </div>

      <div style={{ marginTop:14 }}>
        <TriggerContextEditor config={config} onCfg={onCfg} mode="defaults" nodeId="webhookTrigger" />
      </div>
    </div>
  )
}

// ── WaitNodeConfig ────────────────────────────────────────────────────────────
// Suspend execution until: a webhook resumes it, a human approves, a duration
// elapses, or a named event fires. The most architecturally interesting node.
export const WaitNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const get  = (k, def="") => config?.[k]?.type === "literal" ? String(config[k].value ?? def) : def
  const set  = (k, v)      => onCfg(k, { type:"literal", value:v })
  const EF   = (field)     => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />

  const mode      = get("mode", "webhook")
  const onTimeout = get("onTimeout", "fail")

  // Simulated resume token for display
  const resumeToken = "rtkn_" + (config?._tokenPreview ?? "7f3a9c2b")

  const MODE_OPTS = [
    { id:"webhook",  icon:"⚡", label:"Webhook",  desc:"Parks until a unique URL receives a POST" },
    { id:"approval", icon:"✓",  label:"Approval", desc:"Sends approve/reject links, branches on answer" },
    { id:"duration", icon:"⏱", label:"Duration", desc:"Waits a fixed amount of time before continuing" },
    { id:"event",    icon:"◎", label:"Event",    desc:"Resumes when a named event fires (with optional filter)" },
  ]

  const modeColor = { webhook:"var(--cyan)", approval:"var(--green)", duration:"var(--amber)", event:"var(--purple)" }[mode]

  return (
    <div>

      {/* ── Mode picker ─────────────────────────────────────────── */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontFamily:"var(--font-ui)" }}>
          Resume Mode
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          {MODE_OPTS.map(m => {
            const active = mode === m.id
            return (
              <div key={m.id} onClick={() => set("mode", m.id)}
                style={{
                  padding:"9px 11px", borderRadius:6, cursor:"pointer",
                  border:`1px solid ${active ? modeColor+"66" : "var(--border)"}`,
                  background: active ? modeColor+"0f" : "var(--surface)",
                  transition:"all 0.1s",
                }}
                onMouseEnter={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border2)" }}
                onMouseLeave={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border)" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                  <span style={{ fontSize:13, color: active ? modeColor : "var(--muted)" }}>{m.icon}</span>
                  <span style={{ fontSize:12, fontWeight: active ? 600 : 400,
                    color: active ? modeColor : "var(--text)", fontFamily:"var(--font-ui)" }}>{m.label}</span>
                </div>
                <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.4 }}>{m.desc}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Webhook mode ────────────────────────────────────────── */}
      {mode === "webhook" && (
        <>
          {/* Generated resume URL display */}
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:5, fontFamily:"var(--font-ui)" }}>
              Resume URL <span style={{ fontSize:9, color:"var(--cyan)88", textTransform:"none", letterSpacing:0 }}> — generated at runtime</span>
            </div>
            <div style={{
              display:"flex", alignItems:"center", gap:8,
              padding:"7px 10px", borderRadius:5,
              background:"var(--cyan)0a", border:"1px solid var(--cyan)22",
            }}>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--cyan)", flex:1,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                POST /resume/{resumeToken}
              </span>
              <span style={{ fontSize:10, color:"var(--cyan)66", fontFamily:"var(--font-mono)", flexShrink:0 }}>unique / execution</span>
            </div>
            <div style={{ fontSize:10, color:"var(--dim)", marginTop:4, lineHeight:1.4 }}>
              Available as <code style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.resumeUrl</code> — pass to upstream HTTP nodes or include in emails.
            </div>
          </div>

          {EF({ key:"responseBody", label:"Response to caller", t:"json", ph:'{ "status": "received" }' })}

          {/* Expected payload schema */}
          <_Field label="Expected payload schema" hint="Optional — validates the resume payload before continuing">
            <textarea
              value={config?.payloadSchema?.type === "literal" ? JSON.stringify(config.payloadSchema.value ?? {}, null, 2) : ""}
              onChange={e => { try { onCfg("payloadSchema", { type:"literal", value:JSON.parse(e.target.value) }) } catch{} }}
              rows={3}
              placeholder={'{ "type": "object", "properties": { "approved": { "type": "boolean" } } }'}
              style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 10px", fontSize:11, color:"var(--green)", fontFamily:"var(--font-mono)",
                resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
              onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
          </_Field>
        </>
      )}

      {/* ── Approval mode ───────────────────────────────────────── */}
      {mode === "approval" && (
        <>
          <_Field label="Send via" required>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:4 }}>
              {["slack", "email"].map(v => {
                const active = get("via","slack") === v
                return (
                  <div key={v} onClick={() => set("via", v)}
                    style={{
                      padding:"7px 12px", borderRadius:5, cursor:"pointer", textAlign:"center",
                      border:`1px solid ${active ? "var(--green)55" : "var(--border)"}`,
                      background: active ? "var(--green)0e" : "var(--surface)",
                      fontSize:12, color: active ? "var(--green)" : "var(--muted)",
                      fontFamily:"var(--font-ui)", fontWeight: active ? 600 : 400,
                      transition:"all 0.1s",
                    }}
                  >{v === "slack" ? "⬡ Slack" : "✉ Email"}</div>
                )
              })}
            </div>
          </_Field>

          {get("via","slack") === "slack"
            ? EF({ key:"recipient", label:"Channel or @user", t:"str", ph:"#approvals or @manager", required:true })
            : EF({ key:"recipient", label:"Email address", t:"str", ph:"manager@company.com", required:true })
          }

          {EF({ key:"message", label:"Request message", t:"ta", ph:"Please review and approve the lead pipeline run for {{$.fetchLead.company}}.", required:true })}

          {/* Approve / reject button labels */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {EF({ key:"approveLabel", label:"Approve label", t:"str", ph:"Approve" })}
            {EF({ key:"rejectLabel",  label:"Reject label",  t:"str", ph:"Reject" })}
          </div>

          {/* Branch info */}
          <div style={{
            padding:"9px 12px", borderRadius:6, marginTop:4,
            background:"var(--green)08", border:"1px solid var(--green)1a",
          }}>
            <div style={{ fontSize:11, color:"var(--green)", fontWeight:600, marginBottom:6 }}>Outgoing edges</div>
            <div style={{ display:"flex", gap:8 }}>
              {[
                { label: get("approveLabel","Approve") || "Approve", color:"var(--green)" },
                { label: get("rejectLabel","Reject")   || "Reject",  color:"var(--red)"   },
              ].map(e => (
                <div key={e.label} style={{
                  fontSize:11, fontFamily:"var(--font-mono)",
                  padding:"2px 9px", borderRadius:3,
                  background:`${e.color}14`, border:`1px solid ${e.color}33`,
                  color: e.color,
                }}>{e.label}</div>
              ))}
              {onTimeout === "branch" && (
                <div style={{ fontSize:11, fontFamily:"var(--font-mono)", padding:"2px 9px", borderRadius:3, background:"var(--amber)14", border:"1px solid var(--amber)33", color:"var(--amber)" }}>
                  timed out
                </div>
              )}
            </div>
            <div style={{ fontSize:10, color:"var(--dim)", marginTop:6 }}>
              Connect edges to <code style={{color:"var(--green)"}}>approved</code> and <code style={{color:"var(--red)"}}>rejected</code> paths in the DAG.
              Access result via <code style={{color:"var(--text)"}}>$.{"{nodeId}"}.approved</code>.
            </div>
          </div>
        </>
      )}

      {/* ── Duration mode ───────────────────────────────────────── */}
      {mode === "duration" && (
        <>
          <_Field label="Wait for" required>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <input
                  type="number" min="1"
                  value={get("amount","30")}
                  onChange={e => set("amount", e.target.value)}
                  style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                    padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none",
                    boxSizing:"border-box", fontFamily:"var(--font-mono)" }}
                  onFocus={e=>e.target.style.borderColor="var(--amber)"}
                  onBlur={e=>e.target.style.borderColor="var(--border2)"}
                />
              </div>
              <select
                value={get("unit","minutes")}
                onChange={e => set("unit", e.target.value)}
                style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                  padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none",
                  cursor:"pointer", fontFamily:"var(--font-ui)" }}
                onFocus={e=>e.target.style.borderColor="var(--amber)"}
                onBlur={e=>e.target.style.borderColor="var(--border2)"}
              >
                {["seconds","minutes","hours","days"].map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
          </_Field>

          {/* Human-readable preview */}
          <div style={{ fontSize:11, color:"var(--amber)", fontFamily:"var(--font-mono)",
            padding:"6px 10px", borderRadius:5, background:"var(--amber)0a", border:"1px solid var(--amber)22", marginTop:-4, marginBottom:12 }}>
            ⏱ Will resume {get("amount","30")} {get("unit","minutes")} after this node is reached
          </div>

          {EF({ key:"resumeAt", label:"Or resume at exact time (overrides above)", t:"str", ph:"$.booking.scheduledAt  or  2025-12-01T09:00:00Z" })}
        </>
      )}

      {/* ── Event mode ──────────────────────────────────────────── */}
      {mode === "event" && (
        <>
          {EF({ key:"eventName", label:"Event name", t:"str", ph:"payment.confirmed", required:true })}

          {EF({ key:"correlationKey", label:"Correlation key", t:"str", ph:"$.webhookNode.orderId",
            hint:"Match only events where this key equals the same field in the event payload. Prevents cross-execution collisions." })}

          <_Field label="Resume filter (optional)" hint="Expression evaluated against the event payload — only resume if truthy">
            <textarea
              value={config?.filter?.type === "literal" ? String(config.filter.value ?? "") : ""}
              onChange={e => onCfg("filter", { type:"literal", value:e.target.value })}
              rows={2}
              placeholder={"$.event.amount > 100 && $.event.currency === 'usd'"}
              style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 10px", fontSize:11, color:"var(--purple)", fontFamily:"var(--font-mono)",
                resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
              onFocus={e=>e.target.style.borderColor="var(--purple)"} onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
          </_Field>
        </>
      )}

      {/* ── Timeout (shared) ────────────────────────────────────── */}
      <_Divider label="Timeout" />

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4, fontFamily:"var(--font-ui)" }}>
            Max wait
          </div>
          <div style={{ display:"flex", gap:6 }}>
            <input
              type="number" min="1"
              value={get("timeoutAmount","24")}
              onChange={e => set("timeoutAmount", e.target.value)}
              style={{ flex:1, background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none",
                fontFamily:"var(--font-mono)" }}
              onFocus={e=>e.target.style.borderColor="var(--red)"}
              onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
            <select
              value={get("timeoutUnit","hours")}
              onChange={e => set("timeoutUnit", e.target.value)}
              style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 8px", fontSize:12, color:"var(--text)", outline:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }}
              onFocus={e=>e.target.style.borderColor="var(--red)"}
              onBlur={e=>e.target.style.borderColor="var(--border2)"}
            >
              {["minutes","hours","days"].map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
        </div>

        <_Field label="On timeout">
          <select
            value={onTimeout}
            onChange={e => set("onTimeout", e.target.value)}
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }}
            onFocus={e=>e.target.style.borderColor="var(--red)"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          >
            <option value="fail">Fail execution</option>
            <option value="continue">Continue anyway</option>
            <option value="branch">Branch (timed out edge)</option>
          </select>
        </_Field>
      </div>

      {onTimeout === "branch" && (
        <div style={{ fontSize:10, color:"var(--amber)", fontFamily:"var(--font-ui)", lineHeight:1.5,
          padding:"6px 10px", borderRadius:5, background:"var(--amber)0a", border:"1px solid var(--amber)22" }}>
          Add an edge from this node labeled <code style={{fontFamily:"var(--font-mono)"}}>timed out</code> in the DAG to handle the timeout path.
          Check <code style={{fontFamily:"var(--font-mono)"}}>$.{"{nodeId}"}.timedOut === true</code> downstream.
        </div>
      )}

      {/* ── Output contract ─────────────────────────────────────── */}
      <_Divider label="Output" />
      <div style={{ padding:"9px 12px", borderRadius:6, background:"var(--surface)", border:"1px solid var(--border)", fontSize:11, fontFamily:"var(--font-mono)", lineHeight:1.8, color:"var(--muted)" }}>
        <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.resumedAt</span>   <span style={{color:"var(--dim)"}}>// ISO timestamp</span></div>
        <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.data</span>        <span style={{color:"var(--dim)"}}>// payload from resume request</span></div>
        {mode === "approval" && <div><span style={{color:"var(--green)"}}>$.{"{nodeId}"}.approved</span>   <span style={{color:"var(--dim)"}}>// true | false</span></div>}
        <div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.timedOut</span>   <span style={{color:"var(--dim)"}}>// true if timeout expired</span></div>
        {mode === "webhook" && <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.resumeUrl</span>  <span style={{color:"var(--dim)"}}>// unique URL to resume this execution</span></div>}
      </div>
    </div>
  )
}

// ── FlowRespondNodeConfig ─────────────────────────────────────────────────────
// Sends an HTTP response back to the webhook caller mid-flow.
// Only meaningful when the flow was triggered by a trigger.webhook node.
export const FlowRespondNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const get = (k, def="") => config?.[k]?.type === "literal" ? String(config[k].value ?? def) : def
  const set = (k, v) => onCfg(k, { type:"literal", value:v })
  const EF  = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  const sc  = Number(get("statusCode", "200"))
  const scColor = sc >= 500 ? "var(--red)" : sc >= 400 ? "var(--amber)" : sc >= 300 ? "var(--cyan)" : "var(--green)"

  return (
    <div>
      <div style={{ padding:"8px 12px", borderRadius:6, marginBottom:12,
        background:"var(--green)08", border:"1px solid var(--green)22",
        fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.5 }}>
        Sends an HTTP response to the original webhook caller. Place this anywhere after a
        <code style={{ color:"var(--cyan)", fontFamily:"var(--font-mono)" }}> trigger.webhook</code> — the
        flow continues executing after responding.
      </div>

      {/* Status code */}
      <_Field label="Status Code" required>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <input
            type="number" min="100" max="599"
            value={get("statusCode","200")}
            onChange={e => set("statusCode", e.target.value)}
            style={{ width:80, background:"var(--bg)", border:`1px solid ${scColor}44`,
              borderRadius:5, padding:"6px 10px", fontSize:13, color:scColor,
              outline:"none", fontFamily:"var(--font-mono)", fontWeight:600 }}
            onFocus={e=>e.target.style.borderColor=scColor}
            onBlur={e=>e.target.style.borderColor=`${scColor}44`}
          />
          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
            {[[200,"OK"],[201,"Created"],[204,"No Content"],[400,"Bad Request"],[401,"Unauth"],[422,"Unprocessable"],[500,"Error"]].map(([code,label]) => (
              <button key={code} onClick={() => set("statusCode", String(code))}
                style={{ padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)",
                  background: get("statusCode","200")===String(code) ? `${scColor}18` : "var(--surface)",
                  border:`1px solid ${get("statusCode","200")===String(code) ? `${scColor}44` : "var(--border)"}`,
                  color: get("statusCode","200")===String(code) ? scColor : "var(--muted)",
                  transition:"all 0.1s" }}>
                {code}
              </button>
            ))}
          </div>
        </div>
      </_Field>

      {EF({ key:"body", label:"Body", t:"json",
        ph:'{ "ok": true, "id": "{{$.triggerNode.payload.id}}" }',
        hint:"Expression object — resolved against execution context. Leave empty for no body." })}

      {EF({ key:"headers", label:"Response Headers", t:"obj",
        ph:'{ "X-Request-Id": "{{$.execution.id}}" }',
        hint:"Optional extra headers merged with Content-Type." })}

      <_Divider label="Output" />
      <div style={{ padding:"6px 10px", borderRadius:5, background:"var(--surface)", border:"1px solid var(--border)",
        fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)", lineHeight:1.8 }}>
        <div><span style={{color:"var(--green)"}}>$.{"{nodeId}"}.respondedAt</span> <span style={{color:"var(--dim)"}}>// ISO timestamp</span></div>
        <div><span style={{color:"var(--green)"}}>$.{"{nodeId}"}.statusCode</span>  <span style={{color:"var(--dim)"}}>// the code sent</span></div>
      </div>
    </div>
  )
}

// ── CryptoNodeConfig ──────────────────────────────────────────────────────────
export const CRYPTO_MODES = [
  { id:"hash",    icon:"#",  label:"Hash",    desc:"SHA256 / MD5 / SHA512 of a value" },
  { id:"hmac",    icon:"⌗",  label:"HMAC",    desc:"Keyed hash for signature verification" },
  { id:"encrypt", icon:"⬡",  label:"Encrypt", desc:"AES-256-GCM symmetric encryption" },
  { id:"decrypt", icon:"⬡",  label:"Decrypt", desc:"AES-256-GCM symmetric decryption" },
  { id:"random",  icon:"∿",  label:"Random",  desc:"Cryptographically secure random bytes" },
  { id:"uuid",    icon:"◈",  label:"UUID",    desc:"Generate a v4 UUID" },
]

export const CryptoNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const get = (k, def="") => config?.[k]?.type === "literal" ? String(config[k].value ?? def) : def
  const set = (k, v) => onCfg(k, { type:"literal", value:v })
  const EF  = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  const mode = get("mode", "hash")
  const modeColor = "var(--amber)"

  return (
    <div>
      {/* Mode picker */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em",
          marginBottom:8, fontFamily:"var(--font-ui)" }}>Mode</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
          {CRYPTO_MODES.map(m => {
            const active = mode === m.id
            return (
              <div key={m.id} onClick={() => set("mode", m.id)}
                style={{ padding:"7px 9px", borderRadius:6, cursor:"pointer",
                  border:`1px solid ${active ? "var(--amber)66" : "var(--border)"}`,
                  background: active ? "var(--amber)0f" : "var(--surface)", transition:"all 0.1s" }}
                onMouseEnter={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border2)" }}
                onMouseLeave={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border)" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                  <span style={{ fontSize:12, color: active ? "var(--amber)" : "var(--muted)" }}>{m.icon}</span>
                  <span style={{ fontSize:11, fontWeight: active ? 600 : 400,
                    color: active ? "var(--amber)" : "var(--text)", fontFamily:"var(--font-ui)" }}>{m.label}</span>
                </div>
                <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.3 }}>{m.desc}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Hash */}
      {mode === "hash" && (<>
        {EF({ key:"input", label:"Input", t:"str", ph:"$.node.email  or  $.node.payload", required:true })}
        <_Field label="Algorithm" required>
          <div style={{ display:"flex", gap:5 }}>
            {["sha256","sha512","sha1","md5"].map(a => (
              <button key={a} onClick={() => set("algorithm", a)}
                style={{ flex:1, padding:"5px 0", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)", fontWeight: get("algorithm","sha256")===a ? 700 : 400,
                  background: get("algorithm","sha256")===a ? "var(--amber)18" : "var(--surface)",
                  border:`1px solid ${get("algorithm","sha256")===a ? "var(--amber)44" : "var(--border)"}`,
                  color: get("algorithm","sha256")===a ? "var(--amber)" : "var(--muted)", transition:"all 0.1s" }}>
                {a}
              </button>
            ))}
          </div>
        </_Field>
        <_Field label="Encoding">
          <div style={{ display:"flex", gap:5 }}>
            {["hex","base64"].map(e => (
              <button key={e} onClick={() => set("encoding", e)}
                style={{ flex:1, padding:"5px 0", borderRadius:5, cursor:"pointer", fontSize:11,
                  fontFamily:"var(--font-mono)", fontWeight: get("encoding","hex")===e ? 600 : 400,
                  background: get("encoding","hex")===e ? "var(--amber)12" : "var(--surface)",
                  border:`1px solid ${get("encoding","hex")===e ? "var(--amber)33" : "var(--border)"}`,
                  color: get("encoding","hex")===e ? "var(--amber)" : "var(--muted)", transition:"all 0.1s" }}>
                {e}
              </button>
            ))}
          </div>
        </_Field>
      </>)}

      {/* HMAC */}
      {mode === "hmac" && (<>
        {EF({ key:"input",  label:"Input",  t:"str", ph:"$.node.body  or  $.webhookNode.rawBody", required:true })}
        {EF({ key:"secret", label:"Secret", t:"str", ph:"$.credential.value  or  literal-secret", required:true,
          hint:"Reference a credential via $.credential.value to avoid hardcoding secrets" })}
        <_Field label="Algorithm" required>
          <div style={{ display:"flex", gap:5 }}>
            {["sha256","sha512","sha1"].map(a => (
              <button key={a} onClick={() => set("algorithm", a)}
                style={{ flex:1, padding:"5px 0", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)", fontWeight: get("algorithm","sha256")===a ? 700 : 400,
                  background: get("algorithm","sha256")===a ? "var(--amber)18" : "var(--surface)",
                  border:`1px solid ${get("algorithm","sha256")===a ? "var(--amber)44" : "var(--border)"}`,
                  color: get("algorithm","sha256")===a ? "var(--amber)" : "var(--muted)", transition:"all 0.1s" }}>
                {a}
              </button>
            ))}
          </div>
        </_Field>
        <div style={{ padding:"7px 10px", borderRadius:5, background:"var(--amber)08",
          border:"1px solid var(--amber)22", fontSize:10, color:"var(--amber)aa",
          fontFamily:"var(--font-ui)", lineHeight:1.5, marginTop:4 }}>
          Common pattern: compute HMAC of <code style={{fontFamily:"var(--font-mono)"}}>$.webhookNode.rawBody</code> and
          compare to the signature header to verify the webhook source (GitHub, Stripe, etc.)
        </div>
      </>)}

      {/* Encrypt / Decrypt */}
      {(mode === "encrypt" || mode === "decrypt") && (<>
        {EF({ key:"input",  label: mode === "encrypt" ? "Plaintext" : "Ciphertext",
          t:"str", ph: mode==="encrypt" ? "$.node.sensitiveValue" : "$.node.encryptedValue", required:true })}
        {EF({ key:"secret", label:"Key (32 bytes, hex or base64)", t:"str",
          ph:"$.credential.value", required:true,
          hint:"AES-256-GCM requires a 256-bit key. Reference a credential — never hardcode." })}
        {mode === "encrypt" && EF({ key:"aad", label:"Additional Authenticated Data (AAD)", t:"str",
          ph:"$.node.userId", hint:"Optional — binds the ciphertext to a specific context." })}
        <div style={{ padding:"7px 10px", borderRadius:5, background:"var(--surface)",
          border:"1px solid var(--border)", fontSize:10, color:"var(--muted)",
          fontFamily:"var(--font-mono)", lineHeight:1.8, marginTop:4 }}>
          {mode==="encrypt"
            ? <><div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.ciphertext</span> <span style={{color:"var(--dim)"}}>// base64</span></div>
                <div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.iv</span> <span style={{color:"var(--dim)"}}>// base64 — store alongside ciphertext</span></div>
                <div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.tag</span> <span style={{color:"var(--dim)"}}>// GCM auth tag — base64</span></div></>
            : <div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.plaintext</span> <span style={{color:"var(--dim)"}}>// decrypted string</span></div>
          }
        </div>
      </>)}

      {/* Random bytes */}
      {mode === "random" && (<>
        <_Field label="Byte length" required>
          <input type="number" min="4" max="256"
            value={get("length","32")} onChange={e => set("length", e.target.value)}
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", fontFamily:"var(--font-mono)" }}
            onFocus={e=>e.target.style.borderColor="var(--amber)"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </_Field>
        <_Field label="Encoding">
          <div style={{ display:"flex", gap:5 }}>
            {["hex","base64","base64url"].map(e => (
              <button key={e} onClick={() => set("encoding", e)}
                style={{ flex:1, padding:"5px 0", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)", fontWeight: get("encoding","hex")===e ? 600 : 400,
                  background: get("encoding","hex")===e ? "var(--amber)12" : "var(--surface)",
                  border:`1px solid ${get("encoding","hex")===e ? "var(--amber)33" : "var(--border)"}`,
                  color: get("encoding","hex")===e ? "var(--amber)" : "var(--muted)", transition:"all 0.1s" }}>
                {e}
              </button>
            ))}
          </div>
        </_Field>
      </>)}

      {/* UUID — nothing to configure */}
      {mode === "uuid" && (
        <div style={{ padding:"10px 12px", borderRadius:6, background:"var(--surface)",
          border:"1px solid var(--border)", fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>
          Generates a cryptographically random UUID v4 on each execution.
          No configuration needed.
        </div>
      )}

      {/* Output */}
      {mode !== "encrypt" && mode !== "decrypt" && (<>
        <_Divider label="Output" />
        <div style={{ padding:"6px 10px", borderRadius:5, background:"var(--surface)", border:"1px solid var(--border)",
          fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)", lineHeight:1.8 }}>
          <div><span style={{color:"var(--amber)"}}>$.{"{nodeId}"}.result</span> <span style={{color:"var(--dim)"}}>// the computed value (string)</span></div>
        </div>
      </>)}
    </div>
  )
}

// ── DateNodeConfig ─────────────────────────────────────────────────────────────
export const DATE_MODES = [
  { id:"now",      icon:"●",  label:"Now",      desc:"Current timestamp in any format" },
  { id:"parse",    icon:"⇒",  label:"Parse",    desc:"String or epoch → Date object" },
  { id:"format",   icon:"⌥",  label:"Format",   desc:"Date → formatted string" },
  { id:"add",      icon:"+",  label:"Add",      desc:"Add/subtract a duration" },
  { id:"diff",     icon:"↔",  label:"Diff",     desc:"Difference between two dates" },
  { id:"timezone", icon:"⊕",  label:"Timezone", desc:"Convert between timezones" },
]

export const DateNodeConfig = ({ config, onCfg, upstreamSamples }) => {
  const get = (k, def="") => config?.[k]?.type === "literal" ? String(config[k].value ?? def) : def
  const set = (k, v) => onCfg(k, { type:"literal", value:v })
  const EF  = (field) => <_ExprField field={field} config={config} onCfg={onCfg} upstreamSamples={upstreamSamples} />
  const mode = get("mode", "now")

  const UNITS = ["milliseconds","seconds","minutes","hours","days","weeks","months","years"]
  const FORMAT_PRESETS = [
    { label:"ISO 8601",    val:"YYYY-MM-DDTHH:mm:ssZ" },
    { label:"Date only",   val:"YYYY-MM-DD" },
    { label:"US date",     val:"MM/DD/YYYY" },
    { label:"Human",       val:"MMMM D, YYYY" },
    { label:"Time only",   val:"HH:mm:ss" },
    { label:"Unix epoch",  val:"X" },
    { label:"Unix ms",     val:"x" },
  ]

  return (
    <div>
      {/* Mode picker */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em",
          marginBottom:8, fontFamily:"var(--font-ui)" }}>Mode</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
          {DATE_MODES.map(m => {
            const active = mode === m.id
            return (
              <div key={m.id} onClick={() => set("mode", m.id)}
                style={{ padding:"7px 9px", borderRadius:6, cursor:"pointer",
                  border:`1px solid ${active ? "var(--cyan)66" : "var(--border)"}`,
                  background: active ? "var(--cyan)0f" : "var(--surface)", transition:"all 0.1s" }}
                onMouseEnter={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border2)" }}
                onMouseLeave={e=>{ if(!active) e.currentTarget.style.borderColor="var(--border)" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                  <span style={{ fontSize:12, color: active ? "var(--cyan)" : "var(--muted)" }}>{m.icon}</span>
                  <span style={{ fontSize:11, fontWeight: active ? 600 : 400,
                    color: active ? "var(--cyan)" : "var(--text)", fontFamily:"var(--font-ui)" }}>{m.label}</span>
                </div>
                <div style={{ fontSize:9, color:"var(--dim)", fontFamily:"var(--font-ui)", lineHeight:1.3 }}>{m.desc}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Now */}
      {mode === "now" && (<>
        <_Field label="Format" hint="Leave empty for ISO 8601">
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:6 }}>
            {FORMAT_PRESETS.map(p => (
              <button key={p.val} onClick={() => set("format", p.val)}
                style={{ padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)",
                  background: get("format")===p.val ? "var(--cyan)18" : "var(--surface)",
                  border:`1px solid ${get("format")===p.val ? "var(--cyan)44" : "var(--border)"}`,
                  color: get("format")===p.val ? "var(--cyan)" : "var(--muted)", transition:"all 0.1s" }}>
                {p.label}
              </button>
            ))}
          </div>
          <input value={get("format","")} onChange={e=>set("format",e.target.value)}
            placeholder="YYYY-MM-DD  (custom format)"
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"6px 10px", fontSize:11, color:"var(--cyan)", outline:"none",
              fontFamily:"var(--font-mono)", boxSizing:"border-box" }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </_Field>
        {EF({ key:"timezone", label:"Timezone (optional)", t:"str", ph:"America/New_York  or  UTC" })}
      </>)}

      {/* Parse */}
      {mode === "parse" && (<>
        {EF({ key:"input",  label:"Input",  t:"str", ph:"$.node.createdAt  or  '2025-01-15T09:00:00Z'", required:true })}
        {EF({ key:"inputFormat", label:"Input format (if not ISO)", t:"str", ph:"MM/DD/YYYY  or  unix" })}
        {EF({ key:"timezone", label:"Assume timezone", t:"str", ph:"UTC" })}
      </>)}

      {/* Format */}
      {mode === "format" && (<>
        {EF({ key:"input", label:"Input date", t:"str", ph:"$.node.createdAt  or  $.dateNode.result", required:true })}
        <_Field label="Output format" required>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:6 }}>
            {FORMAT_PRESETS.map(p => (
              <button key={p.val} onClick={() => set("format", p.val)}
                style={{ padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)",
                  background: get("format","YYYY-MM-DD")===p.val ? "var(--cyan)18" : "var(--surface)",
                  border:`1px solid ${get("format","YYYY-MM-DD")===p.val ? "var(--cyan)44" : "var(--border)"}`,
                  color: get("format","YYYY-MM-DD")===p.val ? "var(--cyan)" : "var(--muted)", transition:"all 0.1s" }}>
                {p.label}
              </button>
            ))}
          </div>
          <input value={get("format","YYYY-MM-DD")} onChange={e=>set("format",e.target.value)}
            style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
              padding:"6px 10px", fontSize:11, color:"var(--cyan)", outline:"none",
              fontFamily:"var(--font-mono)", boxSizing:"border-box" }}
            onFocus={e=>e.target.style.borderColor="var(--cyan)"}
            onBlur={e=>e.target.style.borderColor="var(--border2)"}
          />
        </_Field>
        {EF({ key:"timezone", label:"Output timezone", t:"str", ph:"Europe/London" })}
      </>)}

      {/* Add */}
      {mode === "add" && (<>
        {EF({ key:"input", label:"Base date", t:"str", ph:"$.node.createdAt", required:true })}
        <_Field label="Duration" required>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <input type="number"
              value={get("amount","1")} onChange={e=>set("amount",e.target.value)}
              placeholder="Amount"
              style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", fontFamily:"var(--font-mono)" }}
              onFocus={e=>e.target.style.borderColor="var(--cyan)"}
              onBlur={e=>e.target.style.borderColor="var(--border2)"}
            />
            <select value={get("unit","days")} onChange={e=>set("unit",e.target.value)}
              style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"6px 10px", fontSize:12, color:"var(--text)", outline:"none", cursor:"pointer", fontFamily:"var(--font-ui)" }}
              onFocus={e=>e.target.style.borderColor="var(--cyan)"}
              onBlur={e=>e.target.style.borderColor="var(--border2)"}
            >
              {UNITS.map(u=><option key={u}>{u}</option>)}
            </select>
          </div>
        </_Field>
        <div style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:4 }}>
          Use negative amounts to subtract. e.g. -7 days = one week ago.
        </div>
      </>)}

      {/* Diff */}
      {mode === "diff" && (<>
        {EF({ key:"input",  label:"Start date", t:"str", ph:"$.node.createdAt", required:true })}
        {EF({ key:"input2", label:"End date",   t:"str", ph:"$.node.resolvedAt  or  now()", required:true })}
        <_Field label="Unit" required>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {["milliseconds","seconds","minutes","hours","days","weeks","months"].map(u => (
              <button key={u} onClick={() => set("unit",u)}
                style={{ padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)", fontWeight: get("unit","days")===u ? 600 : 400,
                  background: get("unit","days")===u ? "var(--cyan)18" : "var(--surface)",
                  border:`1px solid ${get("unit","days")===u ? "var(--cyan)44" : "var(--border)"}`,
                  color: get("unit","days")===u ? "var(--cyan)" : "var(--muted)", transition:"all 0.1s" }}>
                {u}
              </button>
            ))}
          </div>
        </_Field>
        <_Field label="Rounding">
          <div style={{ display:"flex", gap:5 }}>
            {["floor","round","ceil","float"].map(r => (
              <button key={r} onClick={() => set("round",r)}
                style={{ flex:1, padding:"5px 0", borderRadius:5, cursor:"pointer", fontSize:10,
                  fontFamily:"var(--font-mono)", fontWeight: get("round","floor")===r ? 600 : 400,
                  background: get("round","floor")===r ? "var(--cyan)12" : "var(--surface)",
                  border:`1px solid ${get("round","floor")===r ? "var(--cyan)33" : "var(--border)"}`,
                  color: get("round","floor")===r ? "var(--cyan)" : "var(--muted)", transition:"all 0.1s" }}>
                {r}
              </button>
            ))}
          </div>
        </_Field>
      </>)}

      {/* Timezone */}
      {mode === "timezone" && (<>
        {EF({ key:"input",    label:"Input date",      t:"str", ph:"$.node.createdAt", required:true })}
        {EF({ key:"fromZone", label:"From timezone",   t:"str", ph:"UTC  or  America/New_York" })}
        {EF({ key:"timezone", label:"To timezone",     t:"str", ph:"Europe/Berlin", required:true })}
        {EF({ key:"format",   label:"Output format",   t:"str", ph:"YYYY-MM-DD HH:mm:ss z" })}
      </>)}

      {/* Output */}
      <_Divider label="Output" />
      <div style={{ padding:"6px 10px", borderRadius:5, background:"var(--surface)", border:"1px solid var(--border)",
        fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)", lineHeight:1.8 }}>
        {mode === "diff"
          ? <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.result</span> <span style={{color:"var(--dim)"}}>// numeric difference</span></div>
          : <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.result</span> <span style={{color:"var(--dim)"}}>// formatted string or ISO date</span></div>
        }
        <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.epoch</span>    <span style={{color:"var(--dim)"}}>// unix ms (always present)</span></div>
        <div><span style={{color:"var(--cyan)"}}>$.{"{nodeId}"}.iso</span>      <span style={{color:"var(--dim)"}}>// ISO 8601 string (always present)</span></div>
      </div>
    </div>
  )
}

// ── NODE_CONFIG_COMPONENT — central dispatch map ─────────────────────────────
export const NODE_CONFIG_COMPONENT = {
  "ai":               AiNodeConfig,
  "notify.slack":     NotifySlackNodeConfig,
  "notify.email":     NotifyEmailNodeConfig,
  "store":            StoreNodeConfig,
  "data.parse":       DataParseNodeConfig,
  "transform":        TransformNodeConfig,
  "flow.loop":        FlowLoopNodeConfig,
  "flow.error":       FlowErrorNodeConfig,
  "flow.wait":        WaitNodeConfig,
  "flow.respond":     FlowRespondNodeConfig,
  "crypto":           CryptoNodeConfig,
  "date":             DateNodeConfig,
  "trigger.webhook":  WebhookNodeConfig,
  "trigger.cron":     TriggerCronNodeConfig,
  "trigger.event":    TriggerEventNodeConfig,
  "trigger.manual":   TriggerManualNodeConfig,
}

// ── HttpRequestNodeConfig ────────────────────────────────────────────────────