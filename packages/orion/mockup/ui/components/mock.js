export const now = Date.now()

export const FLOWS = [
  {
    id: "flow_lead_pipeline", version: "1.4.2", name: "Lead Enrichment Pipeline",
    description: "Fetches CRM leads, scores via AI, enriches from Clearbit, sends to Slack",
    tags: ["crm", "ai", "leads"], accountId: "acc_1", workspaceId: "ws_1",
    createdBy: "kobami", createdAt: 1700000000000, updatedAt: 1710000000000,
    nodes: { fetchLead:{}, scoreLead:{}, enrichLead:{}, notifySlack:{} },
    edges: [],
    settings: { timeoutMs: 30000, concurrency: 5 },
    _triggerCount: 2, _lastStatus: "completed", _lastRun: Date.now() - 120000,
    _avgDuration: 1240, _totalRuns: 847, _enabled: true,
    _triggers: [{kind:"webhook",path:"/hooks/crm-new-lead"},{kind:"cron",expression:"0 9 * * 1-5"},{kind:"manual"}],
  },
  {
    id: "flow_invoice_sync", version: "2.1.0", name: "Invoice Sync",
    description: "Syncs invoices from Stripe to internal DB every hour",
    tags: ["billing", "stripe", "sync"], accountId: "acc_1", workspaceId: "ws_1",
    createdBy: "kobami", createdAt: 1705000000000, updatedAt: 1711000000000,
    nodes: { fetchInvoices:{}, transformData:{}, writeDB:{} },
    edges: [],
    settings: { timeoutMs: 60000 },
    _triggerCount: 1, _lastStatus: "completed", _lastRun: Date.now() - 3600000,
    _avgDuration: 890, _totalRuns: 2103, _enabled: true,
    _triggers: [{kind:"cron",expression:"0 * * * *"}],
  },
  {
    id: "flow_email_classifier", version: "0.9.1", name: "Email AI Classifier",
    description: "Classifies inbound support emails, routes to queues, generates draft replies",
    tags: ["ai", "support", "email"], accountId: "acc_1", workspaceId: "ws_1",
    createdBy: "kobami", createdAt: 1708000000000, updatedAt: 1711500000000,
    nodes: { ingestEmail:{}, classifyAI:{}, routeQueue:{}, draftReply:{} },
    edges: [],
    settings: { timeoutMs: 20000, concurrency: 10 },
    _triggerCount: 1, _lastStatus: "failed", _lastRun: Date.now() - 900000,
    _avgDuration: 2100, _totalRuns: 412, _enabled: false,
    _triggers: [{kind:"webhook",path:"/hooks/email-ingest"}],
  },
  {
    id: "flow_data_export", version: "1.0.0", name: "Nightly Data Export",
    description: "Exports analytics snapshots to S3 as Parquet at midnight UTC",
    tags: ["data", "export", "s3"], accountId: "acc_1", workspaceId: "ws_1",
    createdBy: "kobami", createdAt: 1706000000000, updatedAt: 1710500000000,
    nodes: { queryDB:{}, transformParquet:{}, uploadS3:{} },
    edges: [],
    settings: { timeoutMs: 120000 },
    _triggerCount: 1, _lastStatus: "completed", _lastRun: Date.now() - 28800000,
    _avgDuration: 14200, _totalRuns: 89, _enabled: true,
    _triggers: [{kind:"cron",expression:"0 0 * * *"}],
  },
  {
    id: "flow_health_monitor", version: "3.0.0", name: "Service Health Monitor",
    description: "Pings endpoints, checks response codes/latency, pages on-call on anomaly",
    tags: ["ops", "monitoring"], accountId: "acc_1", workspaceId: "ws_1",
    createdBy: "kobami", createdAt: 1703000000000, updatedAt: 1711800000000,
    nodes: { pingEndpoints:{}, analyzeResults:{}, alertOnCall:{} },
    edges: [],
    settings: { timeoutMs: 5000, concurrency: 20 },
    _triggerCount: 3, _lastStatus: "completed", _lastRun: Date.now() - 60000,
    _avgDuration: 320, _totalRuns: 14872, _enabled: true,
    _triggers: [{kind:"cron",expression:"*/1 * * * *"},{kind:"webhook",path:"/hooks/health-manual"},{kind:"event",eventName:"incident.opened"}],
  },
]

export const EXECUTIONS = [
  {
    executionId: "exec_a1b2c3", flowId: "flow_lead_pipeline", version: "1.4.2",
    status: "completed", trigger: { type: "webhook", path: "/hooks/crm-new-lead" },
    startedAt: now - 120000, endedAt: now - 118760, durationMs: 1240,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, input:{ leadId:"lead_99", source:"crm" }, output:{ id:"lead_99", email:"dan@acme.com", company:"Acme" }, logs:[] },
      scoreLead:  { status:"completed", attempts:1, fromCache:false, input:{ lead:{ id:"lead_99", email:"dan@acme.com" } }, output:{ score:0.87, label:"hot" }, logs:[] },
      enrichLead: { status:"completed", attempts:1, fromCache:true,  input:{ email:"dan@acme.com" }, output:{ employees:340, industry:"SaaS", funding:"Series B" }, logs:[] },
      notifySlack:{ status:"completed", attempts:1, fromCache:false, input:{ channel:"#sales", text:"Hot lead: dan@acme.com (0.87)" }, output:{ ok:true, ts:"1741872000.000100" }, logs:[] },
    },
    nodeTimings: { fetchLead:200, scoreLead:700, enrichLead:800, notifySlack:240 },
    slowNodes: ["enrichLead"], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_d4e5f6", flowId: "flow_email_classifier", version: "0.9.1",
    status: "failed", trigger: { type: "webhook", path: "/hooks/email-ingest" },
    startedAt: now - 900000, endedAt: now - 897900, durationMs: 2100,
    nodeStates: {
      ingestEmail: { status:"completed", attempts:1, fromCache:false, input:{ source:"smtp", messageId:"msg_4829xz" }, output:{ subject:"Billing issue", from:"user@example.com", body:"I was charged twice this month." }, logs:[] },
      classifyAI:  { status:"failed",    attempts:3, fromCache:false, input:{ text:"Billing issue — I was charged twice this month.", model:"gpt-4o" }, error:"OpenAI rate limit: 429 Too Many Requests", logs:[{level:"warn",message:"Retry 1/3 after 500ms"},{level:"warn",message:"Retry 2/3 after 1000ms"},{level:"error",message:"All retries exhausted"}] },
      routeQueue:  { status:"skipped",   attempts:0, fromCache:false, logs:[] },
      draftReply:  { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { ingestEmail:500, classifyAI:1600 },
    slowNodes: ["classifyAI"], error: "Node classifyAI failed after 3 attempts", finalContext: {},
    _stages: [{ index:0, nodes:["ingestEmail"] },{ index:1, nodes:["classifyAI"] },{ index:2, nodes:["routeQueue"] },{ index:3, nodes:["draftReply"] }],
  },
  {
    executionId: "exec_g7h8i9", flowId: "flow_lead_pipeline", version: "1.4.2",
    status: "completed", trigger: { type: "manual" },
    startedAt: now - 3600000, endedAt: now - 3598800, durationMs: 1200,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, output:{ id:"lead_88" }, logs:[] },
      scoreLead:  { status:"completed", attempts:1, fromCache:true,  output:{ score:0.62, label:"warm" }, logs:[] },
      enrichLead: { status:"completed", attempts:1, fromCache:true,  output:{ employees:12 }, logs:[] },
      notifySlack:{ status:"completed", attempts:1, fromCache:false, output:{ ok:true }, logs:[] },
    },
    nodeTimings: { fetchLead:180, scoreLead:650, enrichLead:750, notifySlack:220 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_j1k2l3", flowId: "flow_health_monitor", version: "3.0.0",
    status: "completed", trigger: { type: "cron", schedule:"*/1 * * * *" },
    startedAt: now - 60000, endedAt: now - 59680, durationMs: 320,
    nodeStates: {
      pingEndpoints: { status:"completed", attempts:1, fromCache:false, output:[{url:"api.orion.dev",ms:42,ok:true}], logs:[] },
      analyzeResults:{ status:"completed", attempts:1, fromCache:false, output:{ allHealthy:true }, logs:[] },
      alertOnCall:   { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { pingEndpoints:180, analyzeResults:140 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["pingEndpoints"] },{ index:1, nodes:["analyzeResults"] },{ index:2, nodes:["alertOnCall"] }],
  },
  {
    executionId: "exec_live_001", flowId: "flow_lead_pipeline", version: "1.4.2",
    status: "running", trigger: { type: "webhook", path: "/hooks/crm-new-lead" },
    startedAt: now - 12000, endedAt: null, durationMs: null,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, output:{ id:"lead_102", email:"ali@startup.io" }, logs:[] },
      scoreLead:  { status:"running",   attempts:1, fromCache:false, logs:[{level:"info",message:"Calling OpenAI..."}] },
      enrichLead: { status:"pending",   attempts:0, fromCache:false, logs:[] },
      notifySlack:{ status:"pending",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { fetchLead:200 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_m4n5o6", flowId: "flow_invoice_sync", version: "2.1.0",
    status: "completed", trigger: { type: "cron", schedule:"0 * * * *" },
    startedAt: now - 3700000, endedAt: now - 3699110, durationMs: 890,
    nodeStates: {
      fetchInvoices:{ status:"completed", attempts:1, fromCache:false, output:{ count:23 }, logs:[] },
      transformData:{ status:"completed", attempts:1, fromCache:false, output:{ rows:23 }, logs:[] },
      writeDB:      { status:"completed", attempts:1, fromCache:false, output:{ inserted:23 }, logs:[] },
    },
    nodeTimings: { fetchInvoices:310, transformData:280, writeDB:300 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchInvoices"] },{ index:1, nodes:["transformData"] },{ index:2, nodes:["writeDB"] }],
  },
  // ── additional entries for filter testing ──────────────────────────────────
  {
    executionId: "exec_p7q8r9", flowId: "flow_health_monitor", version: "3.0.0",
    status: "failed", trigger: { type: "cron", schedule:"*/1 * * * *" },
    startedAt: now - 180000, endedAt: now - 179650, durationMs: 350,
    nodeStates: {
      pingEndpoints: { status:"completed", attempts:1, fromCache:false, output:[{url:"api.orion.dev",ms:42,ok:false}], logs:[] },
      analyzeResults:{ status:"completed", attempts:1, fromCache:false, output:{ allHealthy:false, failed:["api.orion.dev"] }, logs:[] },
      alertOnCall:   { status:"failed",    attempts:2, fromCache:false, error:"PagerDuty API 503", logs:[{level:"error",message:"Webhook delivery failed"}] },
    },
    nodeTimings: { pingEndpoints:180, analyzeResults:90, alertOnCall:80 },
    slowNodes: [], error: "Node alertOnCall failed", finalContext: {},
    _stages: [{ index:0, nodes:["pingEndpoints"] },{ index:1, nodes:["analyzeResults"] },{ index:2, nodes:["alertOnCall"] }],
  },
  {
    executionId: "exec_s1t2u3", flowId: "flow_data_export", version: "1.0.0",
    status: "completed", trigger: { type: "cron", schedule:"0 0 * * *" },
    startedAt: now - 28800000, endedAt: now - 28785800, durationMs: 14200,
    nodeStates: {
      queryDB:        { status:"completed", attempts:1, fromCache:false, output:{ rows:48210 }, logs:[] },
      transformParquet:{ status:"completed", attempts:1, fromCache:false, output:{ bytes:9218340 }, logs:[] },
      uploadS3:       { status:"completed", attempts:1, fromCache:false, output:{ key:"snapshots/2026-03-10.parquet" }, logs:[] },
    },
    nodeTimings: { queryDB:5800, transformParquet:2400, uploadS3:6000 },
    slowNodes: ["queryDB","uploadS3"], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["queryDB"] },{ index:1, nodes:["transformParquet"] },{ index:2, nodes:["uploadS3"] }],
  },
  {
    executionId: "exec_v4w5x6", flowId: "flow_email_classifier", version: "0.9.1",
    status: "cancelled", trigger: { type: "webhook", path: "/hooks/email-ingest" },
    startedAt: now - 7200000, endedAt: now - 7199200, durationMs: 800,
    nodeStates: {
      ingestEmail: { status:"completed", attempts:1, fromCache:false, output:{ subject:"Refund request" }, logs:[] },
      classifyAI:  { status:"skipped",   attempts:0, fromCache:false, error:"Cancelled by user", logs:[] },
      routeQueue:  { status:"skipped",   attempts:0, fromCache:false, logs:[] },
      draftReply:  { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { ingestEmail:500 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["ingestEmail"] },{ index:1, nodes:["classifyAI"] },{ index:2, nodes:["routeQueue"] },{ index:3, nodes:["draftReply"] }],
  },
  {
    executionId: "exec_y7z8a9", flowId: "flow_lead_pipeline", version: "1.4.1",
    status: "completed", trigger: { type: "event", eventName:"crm.lead.created" },
    startedAt: now - 14400000, endedAt: now - 14397600, durationMs: 2400,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, output:{ id:"lead_77", email:"jess@bigco.com" }, logs:[] },
      scoreLead:  { status:"completed", attempts:1, fromCache:false, output:{ score:0.94, label:"hot" }, logs:[] },
      enrichLead: { status:"completed", attempts:2, fromCache:false, output:{ employees:1200, industry:"Finance" }, logs:[{level:"warn",message:"Retry 1/3: timeout"}] },
      notifySlack:{ status:"completed", attempts:1, fromCache:false, output:{ ok:true }, logs:[] },
    },
    nodeTimings: { fetchLead:220, scoreLead:800, enrichLead:1180, notifySlack:200 },
    slowNodes: ["enrichLead"], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_b2c3d4", flowId: "flow_invoice_sync", version: "2.1.0",
    status: "failed", trigger: { type: "cron", schedule:"0 * * * *" },
    startedAt: now - 7600000, endedAt: now - 7599100, durationMs: 900,
    nodeStates: {
      fetchInvoices:{ status:"completed", attempts:1, fromCache:false, output:{ count:5 }, logs:[] },
      transformData:{ status:"completed", attempts:1, fromCache:false, output:{ rows:5 }, logs:[] },
      writeDB:      { status:"failed",    attempts:3, fromCache:false, error:"ETIMEDOUT: connect to db.internal:5432", logs:[{level:"error",message:"Connection pool exhausted"}] },
    },
    nodeTimings: { fetchInvoices:300, transformData:250, writeDB:350 },
    slowNodes: [], error: "Node writeDB failed after 3 attempts", finalContext: {},
    _stages: [{ index:0, nodes:["fetchInvoices"] },{ index:1, nodes:["transformData"] },{ index:2, nodes:["writeDB"] }],
  },
  {
    executionId: "exec_e5f6g7", flowId: "flow_health_monitor", version: "3.0.0",
    status: "completed", trigger: { type: "event", eventName:"incident.opened" },
    startedAt: now - 5400000, endedAt: now - 5399750, durationMs: 250,
    nodeStates: {
      pingEndpoints: { status:"completed", attempts:1, fromCache:false, output:[{url:"api.orion.dev",ms:38,ok:true}], logs:[] },
      analyzeResults:{ status:"completed", attempts:1, fromCache:false, output:{ allHealthy:true }, logs:[] },
      alertOnCall:   { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { pingEndpoints:160, analyzeResults:90 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["pingEndpoints"] },{ index:1, nodes:["analyzeResults"] },{ index:2, nodes:["alertOnCall"] }],
  },
  {
    executionId: "exec_h8i9j0", flowId: "flow_lead_pipeline", version: "1.4.2",
    status: "completed", trigger: { type: "webhook", path: "/hooks/crm-new-lead" },
    startedAt: now - 86400000, endedAt: now - 86398500, durationMs: 1500,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, output:{ id:"lead_55" }, logs:[] },
      scoreLead:  { status:"completed", attempts:1, fromCache:false, output:{ score:0.41, label:"cold" }, logs:[] },
      enrichLead: { status:"completed", attempts:1, fromCache:false, output:{ employees:8 }, logs:[] },
      notifySlack:{ status:"completed", attempts:1, fromCache:false, output:{ ok:true }, logs:[] },
    },
    nodeTimings: { fetchLead:250, scoreLead:780, enrichLead:260, notifySlack:210 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_k1l2m3", flowId: "flow_data_export", version: "1.0.0",
    status: "failed", trigger: { type: "cron", schedule:"0 0 * * *" },
    startedAt: now - 172800000, endedAt: now - 172789000, durationMs: 11000,
    nodeStates: {
      queryDB:         { status:"completed", attempts:1, fromCache:false, output:{ rows:51000 }, logs:[] },
      transformParquet:{ status:"completed", attempts:1, fromCache:false, output:{ bytes:9800000 }, logs:[] },
      uploadS3:        { status:"failed",    attempts:2, fromCache:false, error:"S3 PutObject: AccessDenied", logs:[{level:"error",message:"IAM policy rejected write"}] },
    },
    nodeTimings: { queryDB:4800, transformParquet:2200, uploadS3:4000 },
    slowNodes: ["queryDB","uploadS3"], error: "S3 PutObject: AccessDenied", finalContext: {},
    _stages: [{ index:0, nodes:["queryDB"] },{ index:1, nodes:["transformParquet"] },{ index:2, nodes:["uploadS3"] }],
  },
  {
    executionId: "exec_n4o5p6", flowId: "flow_invoice_sync", version: "2.1.0",
    status: "completed", trigger: { type: "cron", schedule:"0 * * * *" },
    startedAt: now - 10800000, endedAt: now - 10799200, durationMs: 800,
    nodeStates: {
      fetchInvoices:{ status:"completed", attempts:1, fromCache:false, output:{ count:41 }, logs:[] },
      transformData:{ status:"completed", attempts:1, fromCache:false, output:{ rows:41 }, logs:[] },
      writeDB:      { status:"completed", attempts:1, fromCache:false, output:{ inserted:41 }, logs:[] },
    },
    nodeTimings: { fetchInvoices:290, transformData:260, writeDB:250 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchInvoices"] },{ index:1, nodes:["transformData"] },{ index:2, nodes:["writeDB"] }],
  },
  {
    executionId: "exec_q7r8s9", flowId: "flow_email_classifier", version: "0.9.1",
    status: "completed", trigger: { type: "webhook", path: "/hooks/email-ingest" },
    startedAt: now - 18000000, endedAt: now - 17997700, durationMs: 2300,
    nodeStates: {
      ingestEmail: { status:"completed", attempts:1, fromCache:false, output:{ subject:"Feature request" }, logs:[] },
      classifyAI:  { status:"completed", attempts:1, fromCache:false, output:{ label:"feature", confidence:0.91 }, logs:[] },
      routeQueue:  { status:"completed", attempts:1, fromCache:false, output:{ queue:"product" }, logs:[] },
      draftReply:  { status:"completed", attempts:1, fromCache:false, output:{ draft:"Thank you for..." }, logs:[] },
    },
    nodeTimings: { ingestEmail:480, classifyAI:1500, routeQueue:120, draftReply:200 },
    slowNodes: ["classifyAI"], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["ingestEmail"] },{ index:1, nodes:["classifyAI"] },{ index:2, nodes:["routeQueue"] },{ index:3, nodes:["draftReply"] }],
  },
  {
    executionId: "exec_t1u2v3", flowId: "flow_health_monitor", version: "3.0.0",
    status: "completed", trigger: { type: "manual" },
    startedAt: now - 1800000, endedAt: now - 1799720, durationMs: 280,
    nodeStates: {
      pingEndpoints: { status:"completed", attempts:1, fromCache:false, output:[{url:"api.orion.dev",ms:35,ok:true}], logs:[] },
      analyzeResults:{ status:"completed", attempts:1, fromCache:false, output:{ allHealthy:true }, logs:[] },
      alertOnCall:   { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { pingEndpoints:160, analyzeResults:120 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["pingEndpoints"] },{ index:1, nodes:["analyzeResults"] },{ index:2, nodes:["alertOnCall"] }],
  },
  {
    executionId: "exec_w4x5y6", flowId: "flow_lead_pipeline", version: "1.4.2",
    status: "failed", trigger: { type: "webhook", path: "/hooks/crm-new-lead" },
    startedAt: now - 43200000, endedAt: now - 43197800, durationMs: 2200,
    nodeStates: {
      fetchLead:  { status:"completed", attempts:1, fromCache:false, output:{ id:"lead_33" }, logs:[] },
      scoreLead:  { status:"failed",    attempts:3, fromCache:false, error:"Schema validation failed: missing field 'email'", logs:[{level:"error",message:"Invalid response shape"}] },
      enrichLead: { status:"skipped",   attempts:0, fromCache:false, logs:[] },
      notifySlack:{ status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { fetchLead:200, scoreLead:2000 },
    slowNodes: ["scoreLead"], error: "Schema validation failed: missing field 'email'", finalContext: {},
    _stages: [{ index:0, nodes:["fetchLead"] },{ index:1, nodes:["scoreLead","enrichLead"] },{ index:2, nodes:["notifySlack"] }],
  },
  {
    executionId: "exec_z7a8b9", flowId: "flow_invoice_sync", version: "2.1.0",
    status: "cancelled", trigger: { type: "manual" },
    startedAt: now - 600000, endedAt: now - 599100, durationMs: 900,
    nodeStates: {
      fetchInvoices:{ status:"completed", attempts:1, fromCache:false, output:{ count:12 }, logs:[] },
      transformData:{ status:"running",   attempts:1, fromCache:false, error:"Cancelled by user", logs:[] },
      writeDB:      { status:"skipped",   attempts:0, fromCache:false, logs:[] },
    },
    nodeTimings: { fetchInvoices:310 },
    slowNodes: [], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["fetchInvoices"] },{ index:1, nodes:["transformData"] },{ index:2, nodes:["writeDB"] }],
  },
  {
    executionId: "exec_c2d3e4", flowId: "flow_data_export", version: "1.0.0",
    status: "completed", trigger: { type: "cron", schedule:"0 0 * * *" },
    startedAt: now - 259200000, endedAt: now - 259185600, durationMs: 14400,
    nodeStates: {
      queryDB:         { status:"completed", attempts:1, fromCache:false, output:{ rows:47800 }, logs:[] },
      transformParquet:{ status:"completed", attempts:1, fromCache:false, output:{ bytes:9100000 }, logs:[] },
      uploadS3:        { status:"completed", attempts:1, fromCache:false, output:{ key:"snapshots/2026-03-08.parquet" }, logs:[] },
    },
    nodeTimings: { queryDB:5900, transformParquet:2500, uploadS3:6000 },
    slowNodes: ["queryDB","uploadS3"], error: null, finalContext: {},
    _stages: [{ index:0, nodes:["queryDB"] },{ index:1, nodes:["transformParquet"] },{ index:2, nodes:["uploadS3"] }],
  },
]

// ─── METRICS DATA ────────────────────────────────────────────────────────────
// Seeded PRNG so each window produces stable, deterministic data
export const _mkRng = (seed) => {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

export const FLOW_PERF = {
  flow_lead_pipeline:    { successRate:0.972, avgMs:1240,  p95Ms:4200,  errorRate:0.028 },
  flow_invoice_sync:     { successRate:0.995, avgMs:890,   p95Ms:2100,  errorRate:0.005 },
  flow_email_classifier: { successRate:0.891, avgMs:2100,  p95Ms:7800,  errorRate:0.109 },
  flow_data_export:      { successRate:0.978, avgMs:14200, p95Ms:28000, errorRate:0.022 },
  flow_health_monitor:   { successRate:0.999, avgMs:320,   p95Ms:890,   errorRate:0.001 },
}

export const METRIC_WINDOWS = {
  "1h":  { label:"1h",   points:12, ms:3600000,     fmt:(i)=>`${String(Math.floor(i*5)).padStart(2,"0")}m`,  baseScale:0.004  },
  "6h":  { label:"6h",   points:24, ms:21600000,    fmt:(i)=>`${i*15}m`,                                      baseScale:0.025  },
  "24h": { label:"24h",  points:24, ms:86400000,    fmt:(i)=>`${String(i).padStart(2,"0")}h`,                 baseScale:0.1    },
  "7d":  { label:"7d",   points:28, ms:604800000,   fmt:(i)=>{ const d=Math.floor(i/4); return `D${d+1} ${["00","06","12","18"][i%4]}h`}, baseScale:0.7 },
  "30d": { label:"30d",  points:30, ms:2592000000,  fmt:(i)=>`D${i+1}`,                                        baseScale:3      },
}

export const buildMetrics = (win="24h", flowFilter="all") => {
  const wc = METRIC_WINDOWS[win]
  const rng = _mkRng(win.split("").reduce((a,c)=>a+c.charCodeAt(0),0) * 31 + (flowFilter==="all"?0:flowFilter.length*7))

  // Which flows to include
  const flows = flowFilter === "all"
    ? FLOWS
    : FLOWS.filter(f => f.id === flowFilter)

  // Aggregate perf across selected flows weighted by run count
  const totalBase = flows.reduce((s,f) => s + f._totalRuns, 0)
  const wAvg = (key) => flows.reduce((s,f) => s + (FLOW_PERF[f.id]?.[key]??0) * f._totalRuns, 0) / (totalBase||1)

  const scale = wc.baseScale
  const totalRuns   = Math.round(totalBase * scale * (0.85 + rng()*0.3))
  const successRate = Math.min(0.9999, wAvg("successRate") * (0.98 + rng()*0.04))
  const avgMs       = Math.round(wAvg("avgMs") * (0.9 + rng()*0.2))
  const p95Ms       = Math.round(wAvg("p95Ms") * (0.9 + rng()*0.2))
  const errorRate   = 1 - successRate

  // Volume series
  const volumeSeries = Array.from({ length: wc.points }, (_, i) => {
    const base = Math.round(totalRuns / wc.points)
    const jitter = 0.4 + rng() * 1.2
    const s = Math.round(base * jitter * successRate)
    const f = Math.round(base * jitter * errorRate * (0.5 + rng()))
    return { label: wc.fmt(i), success: s, failed: f }
  })

  // Success rate trend
  const successTrend = Array.from({ length: wc.points }, (_, i) => ({
    label: wc.fmt(i),
    rate:  Math.min(1, Math.max(0.5, successRate + (rng()-0.5)*0.06)),
  }))

  // Duration trend
  const durationTrend = Array.from({ length: wc.points }, (_, i) => {
    const jit = 0.8 + rng()*0.4
    return { label: wc.fmt(i), avg: Math.round(avgMs*jit), p95: Math.round(p95Ms*(0.9+rng()*0.2)) }
  })

  // Per-flow breakdown (only relevant flows)
  const flowBreakdown = flows.map(f => {
    const fp = FLOW_PERF[f.id] ?? { successRate:0.95, avgMs:1000, p95Ms:3000 }
    const runs = Math.round(f._totalRuns * scale * (0.8 + rng()*0.4))
    const delta = (rng()-0.45)*0.04
    return {
      id: f.id,
      name: f.name,
      runs,
      successRate: Math.min(0.9999, fp.successRate + delta),
      avgMs: Math.round(fp.avgMs * (0.9+rng()*0.2)),
      p95Ms: Math.round(fp.p95Ms * (0.9+rng()*0.2)),
      trend: delta > 0.01 ? "up" : delta < -0.01 ? "down" : "flat",
      enabled: f._enabled,
    }
  }).sort((a,b) => b.runs - a.runs)

  // Errors
  const ALL_ERRORS = [
    "OpenAI rate limit: 429 Too Many Requests",
    "ETIMEDOUT: connect to db.internal:5432",
    "S3 PutObject: AccessDenied",
    "Schema validation failed: missing field 'email'",
    "Webhook response timeout after 30000ms",
    "JSON parse error: unexpected token at position 142",
    "DB connection pool exhausted (max: 10)",
  ]
  const errorSummary = ALL_ERRORS.slice(0, 4 + Math.floor(rng()*3)).map((error,i) => ({
    error, count: Math.max(1, Math.round(totalRuns * errorRate * (0.5 / (i+1)) * (0.5+rng())))
  })).filter(e=>e.count>0).sort((a,b)=>b.count-a.count)

  const slowNodes = [
    { nodeId:"classifyAI",  flow:"Email AI Classifier",    avgMs:Math.round(1600*(0.85+rng()*0.3)), p95Ms:Math.round(3200*(0.85+rng()*0.3)), count:Math.round(412*scale) },
    { nodeId:"uploadS3",    flow:"Nightly Data Export",    avgMs:Math.round(6200*(0.85+rng()*0.3)), p95Ms:Math.round(14000*(0.85+rng()*0.3)),count:Math.round(89*scale)  },
    { nodeId:"enrichLead",  flow:"Lead Enrichment",        avgMs:Math.round(800*(0.85+rng()*0.3)),  p95Ms:Math.round(2100*(0.85+rng()*0.3)), count:Math.round(847*scale) },
    { nodeId:"scoreLead",   flow:"Lead Enrichment",        avgMs:Math.round(700*(0.85+rng()*0.3)),  p95Ms:Math.round(1400*(0.85+rng()*0.3)), count:Math.round(847*scale) },
    { nodeId:"queryDB",     flow:"Nightly Data Export",    avgMs:Math.round(580*(0.85+rng()*0.3)),  p95Ms:Math.round(1800*(0.85+rng()*0.3)), count:Math.round(89*scale)  },
  ].filter(n => flowFilter==="all" || flows.some(f=>n.flow.toLowerCase().includes(f.name.split(" ")[0].toLowerCase())))
   .sort((a,b)=>b.avgMs-a.avgMs)

  return { totalRuns, successRate, avgMs, p95Ms, errorRate, activeFlows:flows.filter(f=>f._enabled).length,
           volumeSeries, successTrend, durationTrend, flowBreakdown, errorSummary, slowNodes }
}

// ─── SESSION (mock) ──────────────────────────────────────────────────────────
// In the real app this comes from your auth context / JWT claims.
// Flip isSuperAdmin to false to hide the System tab.
export const SESSION = {
  userId:       "usr_kobami",
  email:        "kobami@orionhq.dev",
  name:         "Kobami",
  accountId:    "acc_1",
  workspaceId:  "ws_1",
  ownsAccount:  "acc_1",
  isSuperAdmin: true,
}

// ─── SYSTEM ADMIN MOCK DATA ──────────────────────────────────────────────────

export const PLAN_COLOR = {
  free:       ["#ffffff11","#ffffff55"],
  starter:    ["#00d4ff18","#00d4ff"],
  pro:        ["#a78bfa22","#a78bfa"],
  enterprise: ["#ffaa0022","#ffaa00"],
}

export const ACCOUNT_STATUS_COLOR = {
  active:    "var(--green)",
  suspended: "var(--red)",
  trial:     "var(--amber)",
}

// Seed deterministic "random" values so they're stable across renders
const mkAccount = (id, name, plan, status, ownerName, ownerEmail, wsCount, userCount, flowCount, execCount, createdDaysAgo) => ({
  id,
  name,
  plan,
  status,
  owner: {
    id:    `usr_${id}_owner`,
    name:  ownerName,
    email: ownerEmail,
    ownsAccount: id,
    role:  "owner",
    createdAt: now - createdDaysAgo * 86400000,
  },
  workspaces: Array.from({ length: wsCount }, (_, i) => ({
    id:   `ws_${id}_${i}`,
    name: i === 0 ? "Default" : `Workspace ${i+1}`,
    flowCount: Math.floor(flowCount / wsCount) + (i === 0 ? flowCount % wsCount : 0),
    createdAt: now - (createdDaysAgo - i * 10) * 86400000,
  })),
  members: Array.from({ length: userCount }, (_, i) => ({
    id:    i === 0 ? `usr_${id}_owner` : `usr_${id}_m${i}`,
    name:  i === 0 ? ownerName : ["Priya Nair","James Liu","Sara Okonkwo","Tomás Reyes","Aiko Sato","Ben Walsh","Fatima Al-Amin","Carlos Dent"][i % 8],
    email: i === 0 ? ownerEmail : `member${i}@${name.toLowerCase().replace(/\s/g,"")}.io`,
    role:  i === 0 ? "owner" : i === 1 ? "admin" : "member",
    joinedAt: now - (createdDaysAgo - i * 5) * 86400000,
  })),
  stats: {
    totalFlows:      flowCount,
    totalExecutions: execCount,
    activeFlows:     Math.floor(flowCount * 0.7),
    failureRate:     parseFloat((Math.random() * 0.08).toFixed(3)),
    avgDurationMs:   Math.floor(Math.random() * 3000 + 400),
  },
  createdAt: now - createdDaysAgo * 86400000,
  updatedAt: now - Math.floor(Math.random() * 10) * 86400000,
})

export let SA_ACCOUNTS = [
  mkAccount("acc_1",        "Orion HQ (Internal)",   "enterprise","active",    "Kobami",        "kobami@orionhq.dev",       3, 6,  12, 21037, 180),
  mkAccount("acc_acme",     "Acme Corp",              "pro",       "active",    "Dan Harmon",    "dan@acme.com",             2, 18, 34, 88420, 142),
  mkAccount("acc_vertexai", "Vertex AI Labs",         "enterprise","active",    "Priya Sharma",  "priya@vertexailabs.io",    5, 41, 89, 312000,98 ),
  mkAccount("acc_pulse",    "Pulse Analytics",        "starter",   "active",    "James Liu",     "james@pulseanalytics.co",  1, 4,  7,  4210,  67 ),
  mkAccount("acc_contour",  "Contour Design",         "starter",   "trial",     "Sara Okonkwo",  "sara@contourdesign.com",   1, 2,  3,  890,   14 ),
  mkAccount("acc_nomad",    "Nomad Fintech",          "pro",       "active",    "Tomás Reyes",   "tomas@nomadfintech.io",    2, 9,  21, 52100, 88 ),
  mkAccount("acc_frozen",   "FrostedByte LLC",        "starter",   "suspended", "Aiko Sato",     "aiko@frostedbyte.dev",     1, 1,  2,  210,   201),
  mkAccount("acc_apex",     "Apex Automation",        "pro",       "trial",     "Ben Walsh",     "ben@apexautomation.co",    1, 3,  6,  1840,  9  ),
]

// ─── UTILITIES ──────────────────────────────────────────────────────────────

export const fmt = {
  time: (ms) => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    return `${h}h ago`
  },
  duration: (ms) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  },
  num: (n) => n.toLocaleString(),
  pct: (n) => `${(n * 100).toFixed(1)}%`,
}

export const STATUS_COLOR = {
  completed: "var(--green)",
  failed:    "var(--red)",
  running:   "var(--cyan)",
  pending:   "var(--muted)",
  cancelled: "var(--muted)",
  skipped:   "var(--dim)",
  active:    "var(--green)",
  inactive:  "#3a3f4a",
  error:     "var(--red)",
  warning:   "var(--amber)",
}

export const TAG_COLORS = {
  ai:         ["#a78bfa22","#a78bfa"],
  crm:        ["#00d4ff22","#00d4ff"],
  leads:      ["#00e59922","#00e599"],
  billing:    ["#ffaa0022","#ffaa00"],
  stripe:     ["#ff6b8122","#ff6b81"],
  sync:       ["#60a5fa22","#60a5fa"],
  support:    ["#fb923c22","#fb923c"],
  email:      ["#f472b622","#f472b6"],
  data:       ["#34d39922","#34d399"],
  export:     ["#a3e63522","#a3e635"],
  s3:         ["#ff953022","#ff9530"],
  ops:        ["#94a3b822","#94a3b8"],
  monitoring: ["#e879f922","#e879f9"],
}
export const getTagColor = (t) => TAG_COLORS[t] ?? ["#ffffff11","#ffffff66"]

// ─── SHARED COMPONENTS ──────────────────────────────────────────────────────

const StatusDot = ({ status, size = 7 }) => (
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

const StatusPill = ({ status }) => (
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

const Tag = ({ label }) => {
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

const Mono = ({ children, color, size = 12 }) => (
  <span style={{
    fontFamily: "var(--font-mono)",
    fontSize: size,
    color: color ?? "var(--text)",
    letterSpacing: "0.02em",
  }}>{children}</span>
)

const SectionHeader = ({ children, action }) => (
  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 20 }}>
    <h2 style={{ fontFamily:"var(--font-head)", fontSize:18, fontWeight:700, color:"var(--text)", letterSpacing:"-0.02em" }}>
      {children}
    </h2>
    {action}
  </div>
)

const Btn = ({ children, onClick, variant = "default", small }) => {
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

const Stat = ({ label, value, sub, accent }) => (
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

const Card = ({ children, style, onClick }) => (
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

const Table = ({ cols, rows, onRowClick }) => (
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


// ─── SYSTEM RUNTIME MOCK DATA ────────────────────────────────────────────────
// Simulates /admin/triggers, /admin/health, and eventBus.subscribers() responses

export const SA_TRIGGERS = [
  { flowId:"flow_lead_pipeline",   version:"1.4.2", nodeId:"triggerNode_1", registeredAt: now-3600000,  kind:"webhook", path:"/hooks/crm-new-lead" },
  { flowId:"flow_lead_pipeline",   version:"1.4.2", nodeId:"triggerNode_2", registeredAt: now-3600000,  kind:"cron",    expression:"0 9 * * 1-5",   jitterMs:4200 },
  { flowId:"flow_invoice_sync",    version:"2.1.0", nodeId:"triggerNode_1", registeredAt: now-7200000,  kind:"cron",    expression:"0 * * * *",      jitterMs:1800 },
  { flowId:"flow_data_export",     version:"1.0.0", nodeId:"triggerNode_1", registeredAt: now-86400000, kind:"cron",    expression:"0 0 * * *",      jitterMs:980  },
  { flowId:"flow_health_monitor",  version:"3.0.0", nodeId:"triggerNode_1", registeredAt: now-120000,   kind:"cron",    expression:"*/1 * * * *",    jitterMs:220  },
  { flowId:"flow_health_monitor",  version:"3.0.0", nodeId:"triggerNode_2", registeredAt: now-120000,   kind:"webhook", path:"/hooks/health-manual" },
  { flowId:"flow_health_monitor",  version:"3.0.0", nodeId:"triggerNode_3", registeredAt: now-120000,   kind:"event",   eventName:"incident.opened" },
]

// email_classifier is DISABLED so its trigger is deregistered — omitted above

export const SA_HEALTH = {
  status: "ok",
  queue:    { depth: 3, capacity: 500 },
  scheduler:{ activeJobs: 1, concurrency: 10 },
  triggers: { count: SA_TRIGGERS.length },
  planCache:{ size: 4 },
  uptime:   { startedAt: now - 18 * 3600000 },  // 18h ago
  time:     now,
}

export const SA_EVENTS = {
  "incident.opened":   [{ flowId:"flow_health_monitor",  version:"3.0.0" }],
  "user.created":      [{ flowId:"flow_lead_pipeline",   version:"1.4.2" }],
  "invoice.paid":      [{ flowId:"flow_invoice_sync",    version:"2.1.0" }],
  "email.received":    [],   // email_classifier is disabled — no subscriber
  "export.requested":  [{ flowId:"flow_data_export",     version:"1.0.0" }],
}

// ─── SETTINGS MOCK DATA ─────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  free:       { workspaces: 1,  members: 3,   flows: 5,   apiKeys: 1,  credentials: 3  },
  starter:    { workspaces: 1,  members: 10,  flows: 20,  apiKeys: 3,  credentials: 10 },
  pro:        { workspaces: 5,  members: 50,  flows: 100, apiKeys: 10, credentials: 50 },
  enterprise: { workspaces: -1, members: -1,  flows: -1,  apiKeys: -1, credentials: -1 },
}

export const CRED_TYPE_META = {
  http: {
    label:"HTTP Header", icon:"⟨⟩", color:"var(--cyan)",
    hint:"Adds a custom header to every request. Ideal for API key or Bearer token auth.",
    fields:[
      { key:"headerName",  label:"Header Name",  placeholder:"Authorization",  hint:"e.g. Authorization, X-API-Key" },
      { key:"headerValue", label:"Header Value",  placeholder:"Bearer sk-...", hint:"The full header value — will be redacted in logs.", secret:true },
    ],
    // inject: describes what the executor does automatically at runtime
    inject: {
      into: "header",
      preview: (cred) => ({
        label: cred?.fields?.headerName || "Authorization",
        value: cred?.fields?.headerValue ? "••••••" : "<header value>",
        description: `Sets header ${cred?.fields?.headerName || "Authorization"}: ••••••`,
      }),
    },
  },
  basic: {
    label:"Basic Auth", icon:"◉", color:"var(--purple)",
    hint:"Standard HTTP Basic authentication — username and password are base64-encoded.",
    fields:[
      { key:"username", label:"Username", placeholder:"api_user" },
      { key:"password", label:"Password", placeholder:"••••••••", secret:true },
    ],
    inject: {
      into: "header",
      preview: (cred) => ({
        label: "Authorization",
        value: `Basic base64(${cred?.fields?.username || "username"}:••••••)`,
        description: "Sets Authorization: Basic <base64(user:pass)>",
      }),
    },
  },
  secret: {
    label:"Secret / Token", icon:"⌗", color:"var(--amber)",
    hint:"A single opaque secret string — webhook signing key, API token, etc.",
    fields:[
      { key:"value", label:"Secret Value", placeholder:"whsec_••••••••", secret:true },
    ],
    inject: {
      into: "context",
      preview: () => ({
        label: "$.credential.value",
        value: "••••••",
        description: "Available as $.credential.value in expressions — not auto-injected into headers.",
      }),
    },
  },
  oauth2: {
    label:"OAuth2 Client", icon:"⟳", color:"var(--green)",
    hint:"Client credentials flow — Orion exchanges client ID + secret for a bearer token before each use.",
    fields:[
      { key:"clientId",     label:"Client ID",     placeholder:"my-client-id" },
      { key:"clientSecret", label:"Client Secret", placeholder:"••••••••",                              secret:true },
      { key:"tokenUrl",     label:"Token URL",     placeholder:"https://auth.example.com/oauth/token", hint:"POST endpoint that issues access tokens" },
      { key:"scopes",       label:"Scopes",        placeholder:"read:flows write:flows",               hint:"Space-separated list of OAuth scopes" },
      { key:"audience",     label:"Audience",      placeholder:"https://api.example.com",              hint:"Optional — required by some providers (e.g. Auth0)" },
    ],
    inject: {
      into: "header",
      preview: (cred) => ({
        label: "Authorization",
        value: "Bearer <token fetched at runtime>",
        description: `POSTs to ${cred?.fields?.tokenUrl || "tokenUrl"} before each request, injects Bearer token`,
      }),
    },
  },
  smtp: {
    label:"SMTP / Email", icon:"✉", color:"var(--cyan)",
    hint:"SMTP credentials for the notify.email node.",
    fields:[
      { key:"host",     label:"SMTP Host",        placeholder:"smtp.mailgun.org" },
      { key:"port",     label:"Port",             placeholder:"587",             hint:"587 for STARTTLS, 465 for SSL" },
      { key:"username", label:"Username",          placeholder:"postmaster@mg.example.com" },
      { key:"password", label:"Password",         placeholder:"••••••••",        secret:true },
      { key:"fromName", label:"Default From Name", placeholder:"Orion Alerts",   hint:"Shown as sender name if the node doesn't override it" },
    ],
    inject: {
      into: "smtp",
      preview: (cred) => ({
        label: "SMTP connection",
        value: `${cred?.fields?.host || "host"}:${cred?.fields?.port || "587"}`,
        description: "Used by notify.email — not injected into HTTP requests.",
      }),
    },
  },
  database: {
    label:"Database", icon:"⬡", color:"var(--green)",
    hint:"Connection string for database nodes (Postgres, MySQL, SQLite).",
    fields:[
      { key:"connectionString", label:"Connection String", placeholder:"postgresql://user:pass@host:5432/db", secret:true, hint:"Full DSN — driver prefix determines the adapter" },
      { key:"ssl",              label:"SSL Mode",          placeholder:"require",  hint:"disable | allow | prefer | require | verify-full" },
    ],
    inject: {
      into: "connection",
      preview: () => ({
        label: "Connection string",
        value: "postgresql://••••••",
        description: "Used by database nodes — not injected into HTTP requests.",
      }),
    },
  },
}

export let ACCOUNT_DATA = {
  id:          "acc_1",
  name:        "Orion HQ (Internal)",
  plan:        "enterprise",   // change to "starter" to test plan-gated workspace view
  status:      "active",
  createdAt:   now - 180 * 86400000,
  workspaces: [
    { id:"ws_1", name:"Default",          description:"Primary workspace",                    createdAt: now-180*86400000, memberIds:["usr_kobami","usr_m1","usr_m2","usr_m3"], flowCount:5, color:"#00d4ff",
      variables:[
        { id:"wv_1",  name:"OPENAI_BASE_URL",  type:"string",  defaultValue:"https://api.openai.com/v1",  description:"Base URL for OpenAI API calls" },
        { id:"wv_2",  name:"DEFAULT_FROM_EMAIL",type:"string", defaultValue:"noreply@orionhq.dev",        description:"Sender address for all email notifications" },
        { id:"wv_3",  name:"ALERT_CHANNEL",    type:"string",  defaultValue:"#alerts",                    description:"Default Slack channel for alert nodes" },
        { id:"wv_4",  name:"MAX_RETRY_COUNT",  type:"number",  defaultValue:"3",                          description:"Global retry ceiling for error-handling nodes" },
        { id:"wv_5",  name:"FEATURE_AI_ENRICH",type:"boolean", defaultValue:"true",                       description:"Feature flag — enable AI enrichment nodes" },
      ],
      git: {
        provider: "github",
        repoUrl: "https://github.com/orionhq/flows-default",
        repoName: "orionhq/flows-default",
        connectedAt: now - 45*86400000,
        environments: [
          { id:"env_prod",    branch:"main",    label:"Production", autoDeploy:false, requiresApproval:true,
            lastDeployedAt: now-3*3600000,  lastDeployedSha:"a3f9c12", lastDeployedBy:"kobami@orionhq.dev", status:"deployed",
            deployHistory:[
              { sha:"a3f9c12", message:"fix: tighten lead scoring threshold",    deployedAt: now-3*3600000,   deployedBy:"kobami@orionhq.dev",  status:"success", duration:8200  },
              { sha:"e72b441", message:"feat: add enrichment fallback node",      deployedAt: now-2*86400000,  deployedBy:"kobami@orionhq.dev",  status:"success", duration:7400  },
              { sha:"c91d830", message:"fix: invoice sync timeout",               deployedAt: now-5*86400000,  deployedBy:"priya@orionhq.dev",   status:"success", duration:6800  },
            ],
          },
          { id:"env_dev",     branch:"dev",     label:"Dev",        autoDeploy:true,  requiresApproval:false,
            lastDeployedAt: now-22*60000,   lastDeployedSha:"f5a1b33", lastDeployedBy:"auto",               status:"deployed",
            deployHistory:[
              { sha:"f5a1b33", message:"wip: wait node approval mode",            deployedAt: now-22*60000,    deployedBy:"auto",                status:"success", duration:5100  },
              { sha:"d40c992", message:"wip: transform aggregate mode",           deployedAt: now-4*3600000,   deployedBy:"auto",                status:"success", duration:4900  },
              { sha:"b88e201", message:"fix: cron jitter calculation",            deployedAt: now-7*3600000,   deployedBy:"auto",                status:"failed",  duration:3200, error:"Compiler error: cycle detected in flow_invoice_sync"  },
            ],
          },
          { id:"env_staging", branch:"staging", label:"Staging",    autoDeploy:true,  requiresApproval:false,
            lastDeployedAt: now-2*86400000, lastDeployedSha:"e72b441", lastDeployedBy:"auto",               status:"behind",
            deployHistory:[
              { sha:"e72b441", message:"feat: add enrichment fallback node",      deployedAt: now-2*86400000,  deployedBy:"auto",                status:"success", duration:6100  },
            ],
          },
        ],
      },
    },
    { id:"ws_2", name:"ML Platform",      description:"AI model pipelines and training jobs", createdAt: now-90*86400000,  memberIds:["usr_kobami","usr_m2","usr_m4"],           flowCount:4, color:"#a78bfa",
      variables:[
        { id:"wv_6",  name:"MODEL_ENDPOINT",   type:"string",  defaultValue:"https://ml.internal/v1",    description:"Internal model serving endpoint" },
        { id:"wv_7",  name:"BATCH_SIZE",        type:"number",  defaultValue:"32",                        description:"Default batch size for inference jobs" },
      ],
      git: null,
    },
    { id:"ws_3", name:"Data Engineering", description:"ETL, exports, and warehouse syncs",    createdAt: now-60*86400000,  memberIds:["usr_kobami","usr_m1","usr_m5"],           flowCount:3, color:"#00e599",
      variables:[
        { id:"wv_8",  name:"DW_SCHEMA",         type:"string",  defaultValue:"analytics",                 description:"Target schema for warehouse writes" },
      ],
      git: null,
    },
  ],
  members: [
    { id:"usr_kobami", name:"Kobami",       email:"kobami@orionhq.dev", role:"owner",  status:"active",  joinedAt: now-180*86400000, lastActiveAt: now-300000    },
    { id:"usr_m1",     name:"Priya Nair",   email:"priya@orionhq.dev",  role:"admin",  status:"active",  joinedAt: now-120*86400000, lastActiveAt: now-3600000   },
    { id:"usr_m2",     name:"James Liu",    email:"james@orionhq.dev",  role:"member", status:"active",  joinedAt: now-90*86400000,  lastActiveAt: now-86400000  },
    { id:"usr_m3",     name:"Sara Okonkwo", email:"sara@orionhq.dev",   role:"member", status:"active",  joinedAt: now-60*86400000,  lastActiveAt: now-172800000 },
    { id:"usr_m4",     name:"Tomás Reyes",  email:"tomas@orionhq.dev",  role:"member", status:"active",  joinedAt: now-45*86400000,  lastActiveAt: now-43200000  },
    { id:"usr_m5",     name:"Aiko Sato",    email:"aiko@orionhq.dev",   role:"member", status:"pending", joinedAt: now-2*86400000,   lastActiveAt: null          },
  ],
  apiKeys: [
    { id:"key_1", name:"Production", prefix:"sk-prod-xK9m", lastUsedAt: now-3600000,   createdAt: now-120*86400000, scopes:["flows:read","flows:run"]                  },
    { id:"key_2", name:"CI / CD",    prefix:"sk-cicd-aP2n", lastUsedAt: now-86400000,  createdAt: now-60*86400000,  scopes:["flows:read","flows:run","flows:write"]     },
    { id:"key_3", name:"Staging",    prefix:"sk-stag-mL7q", lastUsedAt: now-604800000, createdAt: now-30*86400000,  scopes:["flows:read"]                              },
  ],
  auditLog: [
    { id:"aud_1",  actor:"kobami@orionhq.dev", action:"member.invited",    subject:"aiko@orionhq.dev",         meta:{ role:"member" },                    at: now-2*86400000   },
    { id:"aud_2",  actor:"kobami@orionhq.dev", action:"flow.disabled",     subject:"flow_email_classifier",     meta:{ reason:"manual" },                  at: now-1*86400000   },
    { id:"aud_3",  actor:"kobami@orionhq.dev", action:"credential.created",subject:"OpenAI Production",        meta:{ type:"http" },                      at: now-30*86400000  },
    { id:"aud_4",  actor:"priya@orionhq.dev",  action:"flow.enabled",      subject:"flow_email_classifier",     meta:{},                                   at: now-86400000+3600000 },
    { id:"aud_5",  actor:"kobami@orionhq.dev", action:"apikey.created",    subject:"CI / CD",                  meta:{ scopes:["flows:read","flows:run","flows:write"] }, at: now-60*86400000  },
    { id:"aud_6",  actor:"priya@orionhq.dev",  action:"member.role_changed",subject:"james@orionhq.dev",        meta:{ from:"admin", to:"member" },        at: now-45*86400000  },
    { id:"aud_7",  actor:"kobami@orionhq.dev", action:"apikey.revoked",    subject:"Development",              meta:{},                                   at: now-120*86400000 },
    { id:"aud_8",  actor:"kobami@orionhq.dev", action:"workspace.created", subject:"ML Platform",              meta:{ color:"#a78bfa" },                  at: now-90*86400000  },
    { id:"aud_9",  actor:"kobami@orionhq.dev", action:"credential.updated",subject:"Internal DB",              meta:{ type:"basic" },                     at: now-10*86400000  },
    { id:"aud_10", actor:"james@orionhq.dev",  action:"flow.triggered",    subject:"flow_data_export",          meta:{ trigger:"manual" },                 at: now-3600000      },
  ],
  credentials: [
    { id:"cred_1", name:"OpenAI Production",   type:"http",   workspaceId:"ws_1", fields:{ headerName:"Authorization", headerValue:"Bearer sk-prod-••••••••••••••••" }, usedBy:["flow_lead_pipeline","flow_email_classifier"], createdAt: now-120*86400000, updatedAt: now-30*86400000 },
    { id:"cred_2", name:"Clearbit API",         type:"http",   workspaceId:"ws_1", fields:{ headerName:"X-API-Key",     headerValue:"cb-live-••••••••" },                 usedBy:["flow_lead_pipeline"],                          createdAt: now-90*86400000,  updatedAt: now-90*86400000 },
    { id:"cred_3", name:"Stripe Webhook Secret",type:"secret", workspaceId:"ws_1", fields:{ value:"whsec_••••••••••••••••" },                                             usedBy:["flow_invoice_sync"],                           createdAt: now-142*86400000, updatedAt: now-142*86400000 },
    { id:"cred_4", name:"Internal DB",          type:"basic",  workspaceId:"ws_3", fields:{ username:"etl_user", password:"••••••••" },                                   usedBy:["flow_data_export"],                            createdAt: now-60*86400000,  updatedAt: now-10*86400000 },
    { id:"cred_5", name:"Slack Bot Token",      type:"http",   workspaceId:"ws_2", fields:{ headerName:"Authorization", headerValue:"Bearer xoxb-••••" },                 usedBy:["flow_health_monitor"],                         createdAt: now-45*86400000,  updatedAt: now-45*86400000 },
  ],
}


// ─── SYSTEM INFRASTRUCTURE MOCK DATA ────────────────────────────────────────
// Mirrors the live data surfaces from GET /admin/health, GET /admin/triggers,
// and eventBus.subscribers() — all already implemented in the backend.

export const TRIGGER_REGISTRY_RAW = [
  { flowId:"flow_lead_pipeline",   workspaceId:"ws_1", version:"1.4.2", nodeId:"webhookTrigger",  registeredAt: now-180*86400000, kind:"webhook", path:"/hooks/crm-new-lead",  status:"active",  lastFiredAt: now-1800000,  fireCount:2341, missedCount:0 },
  { flowId:"flow_lead_pipeline",   workspaceId:"ws_1", version:"1.4.2", nodeId:"cronTrigger",     registeredAt: now-60*86400000,  kind:"cron",    expression:"0 9 * * 1-5",   jitterMs:4200, status:"active",  lastFiredAt: now-3*3600000, nextFireAt: now+21*3600000, fireCount:42, missedCount:0 },
  { flowId:"flow_invoice_sync",    workspaceId:"ws_1", version:"2.1.0", nodeId:"cronTrigger",     registeredAt: now-142*86400000, kind:"cron",    expression:"0 * * * *",     jitterMs:1800, status:"active",  lastFiredAt: now-2400000,   nextFireAt: now+600000,    fireCount:1891, missedCount:0 },
  { flowId:"flow_email_classifier",workspaceId:"ws_1", version:"0.9.1", nodeId:"inboundEmail",    registeredAt: now-67*86400000,  kind:"webhook", path:"/hooks/email-ingest", status:"paused",  lastFiredAt: now-86400000, fireCount:403, missedCount:0 },
  { flowId:"flow_data_export",     workspaceId:"ws_3", version:"1.0.0", nodeId:"nightlyCron",     registeredAt: now-89*86400000,  kind:"cron",    expression:"0 0 * * *",     jitterMs:7300, status:"active",  lastFiredAt: now-18*3600000,nextFireAt: now+6*3600000, fireCount:89, missedCount:3 },
  { flowId:"flow_health_monitor",  workspaceId:"ws_2", version:"3.0.0", nodeId:"minuteCron",      registeredAt: now-180*86400000, kind:"cron",    expression:"*/1 * * * *",   jitterMs:0,    status:"active",  lastFiredAt: now-62000,     nextFireAt: now+58000,     fireCount:28441, missedCount:0 },
  { flowId:"flow_health_monitor",  workspaceId:"ws_2", version:"3.0.0", nodeId:"manualTrigger",   registeredAt: now-180*86400000, kind:"manual",  status:"active",  lastFiredAt: now-7*86400000, fireCount:12, missedCount:0 },
  { flowId:"flow_health_monitor",  workspaceId:"ws_2", version:"3.0.0", nodeId:"incidentEvent",   registeredAt: now-45*86400000,  kind:"event",   eventName:"incident.opened", status:"active", lastFiredAt: now-3600000, fireCount:47, missedCount:0 },
]
// mutable copy so pause/resume works in UI
export let TRIGGER_REGISTRY = TRIGGER_REGISTRY_RAW.map(t => ({...t}))

export const QUEUE_HEALTH = {
  queueDepth:    3,
  queueCapacity: 500,
  activeJobs:    2,
  schedulerConcurrency: 10,
  planCacheSize: 5,
  recentThroughput: [
    { minute:"09:51", count:42 }, { minute:"09:52", count:38 }, { minute:"09:53", count:55 },
    { minute:"09:54", count:61 }, { minute:"09:55", count:47 }, { minute:"09:56", count:50 },
    { minute:"09:57", count:58 }, { minute:"09:58", count:44 }, { minute:"09:59", count:63 },
    { minute:"10:00", count:71 }, { minute:"10:01", count:48 }, { minute:"10:02", count:52 },
  ],
  activeExecutions: [
    { executionId:"exec_live_001", flowId:"flow_lead_pipeline",   startedAt: now-12000,  stage:1, totalStages:3 },
    { executionId:"exec_live_002", flowId:"flow_health_monitor",  startedAt: now-2000,   stage:0, totalStages:3 },
  ],
  deadLetterQueue: [
    { id:"dlq_001", flowId:"flow_invoice_sync",    executionId:"exec_fail_001", failedAt: now-7200000,  attempts:3, maxAttempts:3, error:"TimeoutError: upstream POST /stripe/invoices timed out after 30000ms", nodeId:"stripeWebhook",  triggeredBy:"cron" },
    { id:"dlq_002", flowId:"flow_data_export",     executionId:"exec_fail_002", failedAt: now-86400000, attempts:3, maxAttempts:3, error:"ConnectionError: ECONNREFUSED 10.0.1.4:5432 — database host unreachable", nodeId:"pgWrite",        triggeredBy:"cron" },
    { id:"dlq_003", flowId:"flow_email_classifier",executionId:"exec_fail_003", failedAt: now-3*3600000,attempts:2, maxAttempts:3, error:"RateLimitError: OpenAI API returned 429 — quota exceeded for org org-xK9m", nodeId:"classifyEmail",  triggeredBy:"webhook" },
  ],
}

export const EVENT_BUS = {
  events: [
    {
      name: "incident.opened",
      schema: { type:"object", properties:{ severity:{type:"string"}, service:{type:"string"}, message:{type:"string"} }, required:["severity","service"] },
      subscribers: [{ flowId:"flow_health_monitor", version:"3.0.0" }],
      emitCount: 47, lastEmittedAt: now - 3600000,
      recentEmissions: [
        { at: now-3600000,  executionIds:["exec_e001"], payloadSummary:'{ severity: "critical", service: "api-gateway" }' },
        { at: now-86400000, executionIds:["exec_e002"], payloadSummary:'{ severity: "warning", service: "ml-pipeline" }' },
        { at: now-2*86400000, executionIds:["exec_e003"], payloadSummary:'{ severity: "critical", service: "db-replica" }' },
      ],
    },
    {
      name: "user.created",
      schema: { type:"object", properties:{ userId:{type:"string"}, email:{type:"string"}, plan:{type:"string"} }, required:["userId","email"] },
      subscribers: [{ flowId:"flow_lead_pipeline", version:"1.4.2" }],
      emitCount: 312, lastEmittedAt: now - 120000,
      recentEmissions: [
        { at: now-120000,   executionIds:["exec_e010"], payloadSummary:'{ userId: "usr_new91", email: "new@acme.io", plan: "pro" }' },
        { at: now-480000,   executionIds:["exec_e011"], payloadSummary:'{ userId: "usr_new90", email: "hello@startup.co", plan: "starter" }' },
        { at: now-900000,   executionIds:["exec_e012"], payloadSummary:'{ userId: "usr_new89", email: "dev@corp.com", plan: "enterprise" }' },
        { at: now-3600000,  executionIds:["exec_e013"], payloadSummary:'{ userId: "usr_new88", email: "test@test.com", plan: "starter" }' },
      ],
    },
    {
      name: "invoice.paid",
      schema: { type:"object", properties:{ invoiceId:{type:"string"}, amount:{type:"number"}, currency:{type:"string"} }, required:["invoiceId","amount"] },
      subscribers: [{ flowId:"flow_invoice_sync", version:"2.1.0" }],
      emitCount: 89, lastEmittedAt: now - 3700000,
      recentEmissions: [
        { at: now-3700000,  executionIds:["exec_e020"], payloadSummary:'{ invoiceId: "inv_9921", amount: 499, currency: "usd" }' },
        { at: now-86400000, executionIds:["exec_e021"], payloadSummary:'{ invoiceId: "inv_9920", amount: 2499, currency: "usd" }' },
      ],
    },
    {
      name: "email.received",
      schema: { type:"object", properties:{ from:{type:"string"}, subject:{type:"string"}, body:{type:"string"} }, required:["from","subject"] },
      subscribers: [{ flowId:"flow_email_classifier", version:"0.9.1" }],
      emitCount: 403, lastEmittedAt: now - 900000,
      recentEmissions: [
        { at: now-900000,   executionIds:["exec_e030"], payloadSummary:'{ from: "leads@hubspot.com", subject: "New lead: Acme Corp" }' },
        { at: now-1800000,  executionIds:["exec_e031"], payloadSummary:'{ from: "support@stripe.com", subject: "Payment dispute opened" }' },
        { at: now-3600000,  executionIds:["exec_e032"], payloadSummary:'{ from: "alerts@pagerduty.com", subject: "CRITICAL: API latency" }' },
      ],
    },
    {
      name: "deploy.completed",
      schema: { type:"object", properties:{ service:{type:"string"}, version:{type:"string"}, environment:{type:"string"} }, required:["service","version"] },
      subscribers: [],
      emitCount: 28, lastEmittedAt: now - 86400000,
      recentEmissions: [
        { at: now-86400000, executionIds:[], payloadSummary:'{ service: "api-gateway", version: "2.14.0", environment: "prod" }' },
        { at: now-2*86400000, executionIds:[], payloadSummary:'{ service: "ml-pipeline", version: "1.8.3", environment: "staging" }' },
      ],
    },
  ],
}

// ─── NAVBAR ─────────────────────────────────────────────────────────────────

export const BASE_TABS  = ["Flows","Templates","Executions","Metrics","Plugins","Settings"]
export const ADMIN_TABS = [...BASE_TABS, "System"]


// ─────────────────────────────────────────────────────────────────────────────
// PLUGIN SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
//
// PluginManifest — the contract every plugin zip must include as manifest.json
//
// {
//   "id":          "orion-mattermost",          // unique, kebab-case
//   "name":        "Mattermost",
//   "version":     "1.0.0",                     // semver
//   "description": "Send messages to Mattermost channels",
//   "author":      "Kobami / FrontierJS",
//   "homepage":    "https://github.com/…",
//   "license":     "MIT",
//   "orionVersion":">=0.1.0",                   // engine compatibility range
//   "nodes": [                                  // node types this plugin adds
//     {
//       "type":        "notify.mattermost",     // must be namespaced
//       "label":       "Mattermost",
//       "category":    "Notify",
//       "icon":        "💬",
//       "color":       "#0058cc",
//       "description": "Post a message to a Mattermost channel",
//       "credentials": ["mattermost_url"],      // credential keys required
//       "configSchema": {                       // JSON Schema for config fields
//         "type": "object",
//         "properties": {
//           "channel":  { "type": "string" },
//           "message":  { "type": "string" },
//           "username": { "type": "string" }
//         },
//         "required": ["channel","message"]
//       }
//     }
//   ],
//   "credentials": [                            // credential schemas this plugin needs
//     {
//       "key":         "mattermost_url",
//       "label":       "Mattermost Instance URL",
//       "type":        "http",
//       "description": "Base URL of your Mattermost server"
//     }
//   ]
// }
//
// ZIP structure:
//   my-plugin-1.0.0.zip
//   ├── manifest.json      ← required
//   ├── index.js           ← compiled ESM bundle (node executors)
//   └── README.md          ← optional docs
// ─────────────────────────────────────────────────────────────────────────────

export const MOCK_PLUGINS = [
  {
    id: "orion-mattermost", name: "Mattermost", version: "1.2.0",
    description: "Post messages, files, and thread replies to Mattermost channels.",
    author: "FrontierJS", license: "MIT", homepage: "https://github.com/frontierjs/orion-mattermost",
    orionVersion: ">=0.1.0",
    status: "active",   // active | disabled | error
    installedAt: Date.now() - 14 * 86400000,
    nodes: [
      { type:"notify.mattermost", label:"Mattermost", category:"Notify", icon:"💬", color:"#0058cc",
        description:"Post a message to a Mattermost channel.",
        credentials:["mattermost_url"],
        configSchema:{ type:"object", properties:{ channel:{type:"string"}, message:{type:"string"}, username:{type:"string"}, iconEmoji:{type:"string"} }, required:["channel","message"] }
      },
      { type:"notify.mattermost.file", label:"MM File Upload", category:"Notify", icon:"📎", color:"#0058cc",
        description:"Upload a file or attachment to a channel.",
        credentials:["mattermost_url"],
        configSchema:{ type:"object", properties:{ channel:{type:"string"}, filename:{type:"string"}, content:{type:"string"} }, required:["channel","filename","content"] }
      },
    ],
    credentials: [
      { key:"mattermost_url", label:"Mattermost Instance URL", type:"http", description:"Base URL of your Mattermost server, e.g. https://chat.example.com" },
      { key:"mattermost_token", label:"Bot Token", type:"secret", description:"Personal access token or bot token from Mattermost" },
    ],
  },
  {
    id: "orion-stripe", name: "Stripe", version: "0.9.1",
    description: "Trigger flows on Stripe webhook events and make Stripe API calls.",
    author: "FrontierJS", license: "MIT", homepage: "https://github.com/frontierjs/orion-stripe",
    orionVersion: ">=0.1.0",
    status: "disabled",
    installedAt: Date.now() - 30 * 86400000,
    nodes: [
      { type:"trigger.stripe", label:"Stripe Webhook", category:"Triggers", icon:"💳", color:"#635bff",
        description:"Entry point for Stripe webhook events (payment_intent, customer, subscription, …).",
        credentials:["stripe_secret"],
        configSchema:{ type:"object", properties:{ events:{type:"array"} }, required:["events"] }
      },
      { type:"stripe.api", label:"Stripe API", category:"HTTP", icon:"⇄", color:"#635bff",
        description:"Call any Stripe API endpoint with automatic auth.",
        credentials:["stripe_secret"],
        configSchema:{ type:"object", properties:{ resource:{type:"string"}, action:{type:"string"}, params:{type:"object"} }, required:["resource","action"] }
      },
    ],
    credentials: [
      { key:"stripe_secret", label:"Stripe Secret Key", type:"secret", description:"sk_live_… or sk_test_…" },
    ],
  },
]
