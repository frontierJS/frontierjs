import { useState, useEffect } from 'react'
import { MOCK_PLUGINS } from './mock.js'

export const ENODE_TYPES = {
  "trigger.webhook": { label:"Webhook",   cat:"Triggers", icon:"⚡", color:"#00d4ff" },
  "trigger.cron":    { label:"Cron",      cat:"Triggers", icon:"⏱", color:"#ffaa00" },
  "trigger.event":   { label:"Event",     cat:"Triggers", icon:"◎", color:"#a78bfa" },
  "trigger.manual":  { label:"Manual",    cat:"Triggers", icon:"▶", color:"#64748b" },
  "http.request":    { label:"HTTP",      cat:"HTTP",     icon:"⇄", color:"#00d4ff" },
  "code":            { label:"Code",      cat:"Code",     icon:"⌥", color:"#f59e0b" },
  "ai":              { label:"AI",        cat:"AI",       icon:"◈", color:"#a78bfa" },
  "data.parse":      { label:"Parse",     cat:"Data",     icon:"{ }",color:"#00e599" },
  "store":           { label:"Store",     cat:"Data",     icon:"⬡", color:"#00e599" },
  "transform":       { label:"Transform", cat:"Data",     icon:"⇒", color:"#94a3b8" },
  "flow.loop":       { label:"Loop",      cat:"Control",  icon:"↻", color:"#ffaa00" },
  "flow.error":      { label:"Error",     cat:"Control",  icon:"⚠", color:"#ff4757" },
  "flow.wait":       { label:"Wait",      cat:"Control",  icon:"⏸", color:"#a78bfa" },
  "flow.respond":    { label:"Respond",   cat:"Control",  icon:"↩", color:"#00e599" },
  "crypto":          { label:"Crypto",    cat:"Utility",  icon:"⌗", color:"#ffaa00" },
  "date":            { label:"Date",      cat:"Utility",  icon:"⏱", color:"#00d4ff" },
  "notify.slack":    { label:"Slack",     cat:"Notify",   icon:"⬡", color:"#a78bfa" },
  "notify.email":    { label:"Email",     cat:"Notify",   icon:"✉", color:"#00d4ff" },
}

export const EDGE_KIND_COLORS = { success:"#00e599", error:"#ff4757", always:"#64748b" }

export const NODE_CONFIG_FIELDS = {
  // webhook + http.request are rendered by custom components; fields listed here are only used
  // by the JSON schema sidebar and getNodePreview — actual config UI is WebhookNodeConfig /
  // HttpRequestNodeConfig injected by SlotCard / NodeInspector.
  "trigger.webhook": [
    { key:"path",         label:"Path",              t:"str",  ph:"/hooks/my-flow" },
    { key:"method",       label:"HTTP Method",       t:"sel",  opts:["POST","GET","PUT","PATCH","DELETE","ANY"], def:"POST" },
    { key:"auth",         label:"Authentication",    t:"sel",  opts:["none","header","basic","bearer","oauth2"], def:"none" },
    { key:"credential",   label:"Credential",        t:"cred" },
    { key:"respondWith",  label:"Respond With",      t:"sel",  opts:["onReceived","lastNode","fixed"], def:"onReceived" },
    { key:"responseCode", label:"Response Code",     t:"num",  ph:"200" },
    { key:"rawBody",      label:"Pass Raw Body",     t:"sel",  opts:["no","yes"], def:"no" },
    { key:"allowedIPs",   label:"IP Allowlist (CIDR)",t:"str", ph:"0.0.0.0/0" },
  ],
  "trigger.cron": [
    { key:"expression", label:"Cron Expression", t:"str", ph:"0 9 * * 1-5" },
    { key:"timezone",   label:"Timezone",        t:"str", ph:"UTC" },
  ],
  "trigger.event":  [{ key:"eventName", label:"Event Name", t:"str", ph:"user.created" }],
  "trigger.manual": [],
  "http.request": [
    { key:"url",            label:"URL",               t:"str",  ph:"https://api.example.com/path" },
    { key:"method",         label:"Method",            t:"sel",  opts:["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"], def:"GET" },
    { key:"auth",           label:"Authentication",    t:"sel",  opts:["none","credential","basic","bearer","oauth2"], def:"none" },
    { key:"credential",     label:"Credential",        t:"cred" },
    { key:"contentType",    label:"Content Type",      t:"sel",  opts:["application/json","application/x-www-form-urlencoded","multipart/form-data","text/plain","none"], def:"application/json" },
    { key:"headers",        label:"Headers",           t:"json", ph:'{"X-Custom-Header":"value"}' },
    { key:"queryParams",    label:"Query Params",      t:"json", ph:'{"page":"1","limit":"50"}' },
    { key:"body",           label:"Body",              t:"json", ph:'{"key":"value"}' },
    { key:"timeout",        label:"Timeout (ms)",      t:"num",  ph:"30000" },
    { key:"followRedirects",label:"Follow Redirects",  t:"sel",  opts:["yes","no"], def:"yes" },
    { key:"sslVerify",      label:"Verify SSL",        t:"sel",  opts:["yes","no"], def:"yes" },
    { key:"onError",        label:"On Error",          t:"sel",  opts:["throw","continue"], def:"throw" },
  ],
  "ai": [
    { key:"mode",        label:"Mode",        t:"sel", opts:["complete","embed","classify","extract"], def:"complete" },
    { key:"model",       label:"Model",       t:"str", ph:"gpt-4o" },
    { key:"prompt",      label:"Prompt",      t:"ta",  ph:"You are a helpful assistant…" },
    { key:"temperature", label:"Temperature", t:"num", ph:"0.7" },
  ],
  "data.parse": [
    { key:"input",  label:"Input",  t:"str", ph:"$.prevNode.body" },
    { key:"format", label:"Format", t:"sel", opts:["json","csv","yaml"], def:"json" },
  ],
  "store": [
    { key:"mode",  label:"Mode",  t:"sel", opts:["get","set","delete"], def:"get" },
    { key:"key",   label:"Key",   t:"str", ph:"user:{{$.userId}}" },
    { key:"value", label:"Value", t:"json",ph:'{"field":"value"}' },
    { key:"scope", label:"Scope", t:"sel", opts:["workspace","flow"], def:"workspace" },
  ],
  "transform": [
    { key:"mode",           label:"Mode",         t:"sel", opts:["map","filter","sort","aggregate","dedup","split"], def:"map" },
    { key:"inputArray",     label:"Input Array",  t:"str", ph:"$.node.items" },
    { key:"whereCondition", label:"Where",        t:"str", ph:"$.item.score > 0.7" },
    { key:"sortKey",        label:"Sort Key",     t:"str", ph:"score" },
    { key:"sortDir",        label:"Direction",    t:"sel", opts:["asc","desc"], def:"desc" },
    { key:"aggOp",          label:"Operation",    t:"sel", opts:["count","sum","avg","min","max"], def:"count" },
    { key:"aggValueKey",    label:"Value Field",  t:"str", ph:"amount" },
    { key:"groupByKey",     label:"Group By",     t:"str", ph:"category" },
    { key:"dedupKey",       label:"Unique Key",   t:"str", ph:"id" },
    { key:"dedupKeep",      label:"Keep",         t:"sel", opts:["first","last"], def:"first" },
    { key:"splitArrayPath", label:"Array Path",   t:"str", ph:"$.node.items" },
    { key:"expression",     label:"Expression",   t:"json", ph:'{"type":"object","properties":{}}' },
  ],
  "flow.loop": [
    { key:"over",     label:"Iterate Over", t:"str", ph:"$.items" },
    { key:"as",       label:"Variable As",  t:"str", ph:"item" },
    { key:"maxRuns",  label:"Max Runs",     t:"num", ph:"100" },
    { key:"breakWhen",label:"Break When",   t:"str", ph:"$.item.done == true" },
  ],
  "flow.error": [{ key:"strategy", label:"Strategy", t:"sel", opts:["stop","continue","retry"], def:"stop" }],
  "flow.wait": [
    { key:"mode",       label:"Mode",            t:"sel", opts:["webhook","approval","duration","event"], def:"webhook" },
    { key:"timeout",    label:"Timeout",         t:"num", ph:"3600000" },
    { key:"onTimeout",  label:"On Timeout",      t:"sel", opts:["fail","continue","branch"], def:"fail" },
  ],
  "flow.respond": [
    { key:"statusCode", label:"Status Code", t:"num", ph:"200" },
    { key:"body",       label:"Body",        t:"json", ph:'{ "ok": true }' },
    { key:"headers",    label:"Headers",     t:"json", ph:'{ "Content-Type": "application/json" }' },
  ],
  "crypto": [
    { key:"mode",      label:"Mode",      t:"sel", opts:["hash","hmac","encrypt","decrypt","random","uuid"], def:"hash" },
    { key:"algorithm", label:"Algorithm", t:"sel", opts:["sha256","sha512","md5","sha1"], def:"sha256" },
    { key:"input",     label:"Input",     t:"str", ph:"$.node.value" },
    { key:"secret",    label:"Secret",    t:"str", ph:"$.credential.value" },
  ],
  "date": [
    { key:"mode",     label:"Mode",   t:"sel", opts:["now","parse","format","add","diff","timezone"], def:"now" },
    { key:"input",    label:"Input",  t:"str", ph:"$.node.createdAt" },
    { key:"format",   label:"Format", t:"str", ph:"YYYY-MM-DD HH:mm:ss" },
    { key:"timezone", label:"Timezone",t:"str", ph:"America/New_York" },
  ],
  "notify.slack": [
    { key:"channel", label:"Channel", t:"str", ph:"#alerts" },
    { key:"message", label:"Message", t:"ta",  ph:"New lead: {{$.fetchLead.company}}" },
  ],
  "notify.email": [
    { key:"to",      label:"To",      t:"str", ph:"user@example.com" },
    { key:"subject", label:"Subject", t:"str", ph:"Alert: {{$.title}}" },
    { key:"body",    label:"Body",    t:"ta",  ph:"…" },
  ],
  "code": [],
}


// ── Plugin registry — global store shared by PluginsPage + NodeTypePicker ──
// Uses a minimal pub-sub so changes in PluginsPage re-render NodeTypePicker/
// NodePalette without prop-drilling through FlowEditor.
export let _pluginList = MOCK_PLUGINS.filter(p => p.status === "active")
const _pluginSubs = new Set()
export const pluginStore = {
  get:    ()  => _pluginList,
  set:    (ps) => { _pluginList = ps; _pluginSubs.forEach(fn => fn()) },
  sub:    (fn) => { _pluginSubs.add(fn);    return () => _pluginSubs.delete(fn) },
}

// React hook — re-renders on every registry update
export const usePluginList = () => {
  const [, tick] = useState(0)
  useEffect(() => pluginStore.sub(() => tick(t => t + 1)), [])
  return pluginStore.get()
}

// Flatten active plugin nodes into an ENODE_TYPES-compatible map
export const pluginNodeTypes = () => {
  const out = {}
  pluginStore.get().filter(p => p.status === "active").forEach(p => {
    p.nodes.forEach(n => {
      out[n.type] = {
        label:    n.label,
        cat:      n.category ?? "Plugins",
        icon:     n.icon    ?? "⬡",
        color:    n.color   ?? "#7c6af7",
        pluginId: p.id,
        pluginName: p.name,
        configSchema: n.configSchema ?? null,
        credentials:  n.credentials  ?? [],
      }
    })
  })
  return out
}

// Resolve a node type — core first, then plugins
export const resolveNodeType = (type) =>
  type ? (ENODE_TYPES[type] ?? pluginNodeTypes()[type] ?? subflowNodeTypes()[type] ?? { label:type, cat:"Unknown", icon:"○", color:"#94a3b8" }) : { label:"…", cat:"Unknown", icon:"○", color:"#64748b" }

// All effective node types (core + active plugins)
export const allNodeTypes = () => ({ ...ENODE_TYPES, ...pluginNodeTypes(), ...subflowNodeTypes() })

// Build ExpressionInput field descriptors from a JSON Schema properties map
export const schemaToFields = (schema) => {
  if (!schema?.properties) return []
  return Object.entries(schema.properties).map(([key, s]) => {
    const required = schema.required?.includes(key) ?? false
    const t = s.type === "boolean"  ? "sel"
            : s.type === "number"   ? "num"
            : s.type === "object"   ? "json"
            : s.type === "array"    ? "json"
            :                         "str"
    const opts = s.type === "boolean" ? ["true","false"] : undefined
    return { key, label: key.replace(/([A-Z])/g," $1").trim(), t, ph: s.example ?? "", def: s.default, ...(opts ? { opts } : {}), required }
  })
}

// Resolve config fields for any node type (core + plugin)
export const resolveNodeFields = (type) => {
  if (NODE_CONFIG_FIELDS[type]) return NODE_CONFIG_FIELDS[type]
  const pnt = pluginNodeTypes()[type]
  if (!pnt) return []
  return schemaToFields(pnt.configSchema)
}


// ── Subflow registry ──────────────────────────────────────────────────────────
// When a flow declares I/O ports (subflow schema) and is saved, it registers here
// so it appears as a draggable node in every other flow's node picker.
let _subflowList = []
const _subflowSubs = new Set()
export const subflowStore = {
  get:    ()        => _subflowList,
  set:    (list)    => { _subflowList = list; _subflowSubs.forEach(fn => fn()) },
  reg:    (entry)   => {
    _subflowList = [..._subflowList.filter(s => s.id !== entry.id), entry]
    _subflowSubs.forEach(fn => fn())
  },
  unreg:  (id)      => { _subflowList = _subflowList.filter(s => s.id !== id); _subflowSubs.forEach(fn => fn()) },
  sub:    (fn)      => { _subflowSubs.add(fn); return () => _subflowSubs.delete(fn) },
}
const useSubflowList = () => {
  const [, tick] = useState(0)
  useEffect(() => subflowStore.sub(() => tick(t => t + 1)), [])
  return subflowStore.get()
}

// Flatten registered subflows into ENODE_TYPES-compatible map
export const subflowNodeTypes = () => {
  const out = {}
  subflowStore.get().forEach(sf => {
    out[`subflow.${sf.id}`] = {
      label:    sf.name,
      cat:      "Subflows",
      icon:     "◈",
      color:    "#a78bfa",
      isSubflow: true,
      subflowId: sf.id,
      inputs:   sf.inputs  ?? [],
      outputs:  sf.outputs ?? [],
    }
  })
  return out
}

// ── Canvas flow mock data ─────────────────────────────────────────────────