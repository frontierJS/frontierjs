import { useState, useEffect, useRef, useCallback } from "react";

// ─── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg:'#0b0d14', sidebar:'#0e1019', card:'#151820', elevated:'#1b1f2c',
  modal:'#12151f', overlay:'rgba(0,0,0,0.72)',
  border:'rgba(255,255,255,0.07)', borderMd:'rgba(255,255,255,0.13)',
  text:'#dde1ed', sec:'#636882', muted:'#383d52',
  blue:'#5a8ef8', green:'#2dd4a0', amber:'#f5b540', red:'#f06b6b',
  purple:'#9d87f5', cyan:'#1ec8d4', orange:'#f09a4a',
  // Sysadmin accent — slightly warmer so it reads as a different "zone"
  sys:'#e8a84c',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DATA
// ═══════════════════════════════════════════════════════════════════════════════

const SERVERS = [
  {id:'s1',name:'prod-web-01',status:'online',role:'general',region:'us-east-1',ip:'10.0.1.10',cpu:23,mem:61,disk:44,agent:'1.2.3',beat:'12s',containers:8},
  {id:'s2',name:'prod-web-02',status:'online',role:'general',region:'us-east-1',ip:'10.0.1.11',cpu:45,mem:72,disk:44,agent:'1.2.3',beat:'8s',containers:7},
  {id:'s3',name:'prod-db-01',status:'online',role:'database',region:'us-east-1',ip:'10.0.2.10',cpu:12,mem:88,disk:67,agent:'1.2.3',beat:'15s',containers:3},
  {id:'s4',name:'prod-worker-01',status:'draining',role:'worker',region:'us-east-1',ip:'10.0.3.10',cpu:8,mem:45,disk:33,agent:'1.2.2',beat:'21s',containers:4},
  {id:'s5',name:'build-runner-01',status:'online',role:'build',region:'us-east-1',ip:'10.0.4.10',cpu:78,mem:56,disk:21,agent:'1.2.3',beat:'9s',containers:2},
  {id:'s6',name:'stg-app-01',status:'online',role:'general',region:'us-west-2',ip:'10.0.5.10',cpu:5,mem:31,disk:18,agent:'1.2.3',beat:'18s',containers:5},
  {id:'s7',name:'prod-gateway-01',status:'unreachable',role:'gateway',region:'us-east-1',ip:'10.0.0.1',cpu:null,mem:null,disk:null,agent:'1.2.1',beat:'4m',containers:null},
  {id:'s8',name:'dev-sandbox-01',status:'stopped',role:'general',region:'us-east-2',ip:'10.0.6.10',cpu:null,mem:null,disk:null,agent:null,beat:'2d',containers:null},
];

// ─── Per-server Docker state (mirrors DockerState type from hub.types.ts) ──────
const DOCKER_STATE = {
  s1: {
    collected_at: Date.now() - 18000,
    containers: [
      {id:'c1a2b3',name:'web-nginx-1',    image:'nginx:1.25-alpine',    status:'running',  cpu_pct:2.1, memory_mb:48,  ports:[{host_port:80,container_port:80,protocol:'tcp'},{host_port:443,container_port:443,protocol:'tcp'}], compose_project:'dashboard', compose_service:'nginx',   restart_count:0, started_at:Date.now()-864000},
      {id:'c2b3c4',name:'web-app-1',      image:'registry/dashboard:v2.14.1', status:'running',cpu_pct:8.4, memory_mb:312, ports:[{host_port:3000,container_port:3000,protocol:'tcp'}],                                             compose_project:'dashboard', compose_service:'app',     restart_count:1, started_at:Date.now()-864000},
      {id:'c3c4d5',name:'web-app-2',      image:'registry/dashboard:v2.14.1', status:'running',cpu_pct:6.7, memory_mb:298, ports:[{host_port:3001,container_port:3000,protocol:'tcp'}],                                             compose_project:'dashboard', compose_service:'app',     restart_count:0, started_at:Date.now()-864000},
      {id:'c4d5e6',name:'api-router-1',   image:'registry/api-gateway:v1.9.0',status:'running',cpu_pct:3.2, memory_mb:128, ports:[{host_port:8080,container_port:8080,protocol:'tcp'}],                                             compose_project:'api-gateway',compose_service:'router',  restart_count:0, started_at:Date.now()-432000},
      {id:'c5e6f7',name:'api-router-2',   image:'registry/api-gateway:v1.9.0',status:'running',cpu_pct:2.9, memory_mb:124, ports:[{host_port:8081,container_port:8080,protocol:'tcp'}],                                             compose_project:'api-gateway',compose_service:'router',  restart_count:0, started_at:Date.now()-432000},
      {id:'c6f7g8',name:'hub-agent',      image:'hub-agent:1.2.3',            status:'running',cpu_pct:0.3, memory_mb:22,  ports:[{host_port:7700,container_port:7700,protocol:'tcp'}],                                             compose_project:null,        compose_service:null,      restart_count:0, started_at:Date.now()-900000},
      {id:'c7g8h9',name:'prometheus-exporter',image:'prom/node-exporter:v1.7',status:'running',cpu_pct:0.1, memory_mb:12,  ports:[{host_port:9100,container_port:9100,protocol:'tcp'}],                                             compose_project:null,        compose_service:null,      restart_count:0, started_at:Date.now()-900000},
      {id:'c8h9i0',name:'web-app-old',    image:'registry/dashboard:v2.13.9', status:'exited', cpu_pct:null,memory_mb:null,ports:[],                                                                                                compose_project:'dashboard', compose_service:'app',     restart_count:0, started_at:null},
    ],
    volumes: [
      {name:'dashboard_data',  driver:'local', mountpoint:'/var/lib/docker/volumes/dashboard_data/_data',   size_bytes:2.1e9,  labels:{project:'dashboard'}, in_use:true},
      {name:'nginx_certs',     driver:'local', mountpoint:'/var/lib/docker/volumes/nginx_certs/_data',      size_bytes:12e3,   labels:{},                    in_use:true},
      {name:'prometheus_data', driver:'local', mountpoint:'/var/lib/docker/volumes/prometheus_data/_data',  size_bytes:840e6,  labels:{},                    in_use:true},
      {name:'tmp_build_cache', driver:'local', mountpoint:'/var/lib/docker/volumes/tmp_build_cache/_data',  size_bytes:450e6,  labels:{},                    in_use:false},
    ],
    networks: [
      {id:'net1a2b',name:'dashboard_default', driver:'bridge',  scope:'local', subnet:'172.18.0.0/16',gateway:'172.18.0.1', internal:false, containers:['c1a2b3','c2b3c4','c3c4d5']},
      {id:'net2b3c',name:'api_default',       driver:'bridge',  scope:'local', subnet:'172.19.0.0/16',gateway:'172.19.0.1', internal:false, containers:['c4d5e6','c5e6f7']},
      {id:'net3c4d',name:'hub_internal',      driver:'bridge',  scope:'local', subnet:'172.20.0.0/16',gateway:'172.20.0.1', internal:true,  containers:['c6f7g8']},
    ],
    images: [
      {id:'sha256:a1b2c3d4', tags:['registry/dashboard:v2.14.1'],          size_bytes:184e6,  created_at:Date.now()-86400*2,  in_use:true},
      {id:'sha256:b2c3d4e5', tags:['registry/api-gateway:v1.9.0'],         size_bytes:112e6,  created_at:Date.now()-86400*5,  in_use:true},
      {id:'sha256:c3d4e5f6', tags:['nginx:1.25-alpine'],                   size_bytes:41e6,   created_at:Date.now()-86400*30, in_use:true},
      {id:'sha256:d4e5f6g7', tags:['hub-agent:1.2.3'],                     size_bytes:28e6,   created_at:Date.now()-86400*7,  in_use:true},
      {id:'sha256:e5f6g7h8', tags:['prom/node-exporter:v1.7'],             size_bytes:22e6,   created_at:Date.now()-86400*14, in_use:true},
      {id:'sha256:f6g7h8i9', tags:['registry/dashboard:v2.13.9'],          size_bytes:181e6,  created_at:Date.now()-86400*8,  in_use:false},
      {id:'sha256:g7h8i9j0', tags:['registry/dashboard:v2.13.5','registry/dashboard:stable'], size_bytes:178e6, created_at:Date.now()-86400*20, in_use:false},
    ],
  },
  s3: {
    collected_at: Date.now() - 22000,
    containers: [
      {id:'d1a2b3',name:'postgres-primary', image:'postgres:16-alpine',    status:'running',  cpu_pct:4.2, memory_mb:612, ports:[{host_port:5432,container_port:5432,protocol:'tcp'}], compose_project:'databases',compose_service:'postgres',restart_count:0,started_at:Date.now()-2592000},
      {id:'d2b3c4',name:'postgres-exporter',image:'prometheuscommunity/postgres-exporter:v0.15',status:'running',cpu_pct:0.2,memory_mb:18,ports:[{host_port:9187,container_port:9187,protocol:'tcp'}],compose_project:'databases',compose_service:'exporter',restart_count:0,started_at:Date.now()-2592000},
      {id:'d3c4d5',name:'hub-agent',        image:'hub-agent:1.2.3',       status:'running',  cpu_pct:0.1, memory_mb:22,  ports:[{host_port:7700,container_port:7700,protocol:'tcp'}], compose_project:null,       compose_service:null,     restart_count:0,started_at:Date.now()-900000},
    ],
    volumes: [
      {name:'pgdata', driver:'local', mountpoint:'/var/lib/docker/volumes/pgdata/_data', size_bytes:14.2e9, labels:{project:'databases'}, in_use:true},
      {name:'pgwal',  driver:'local', mountpoint:'/var/lib/docker/volumes/pgwal/_data',  size_bytes:2.1e9,  labels:{},                    in_use:true},
    ],
    networks: [
      {id:'net4d5e',name:'databases_default',driver:'bridge',scope:'local',subnet:'172.21.0.0/16',gateway:'172.21.0.1',internal:true,containers:['d1a2b3','d2b3c4']},
    ],
    images: [
      {id:'sha256:h8i9j0k1',tags:['postgres:16-alpine'],size_bytes:88e6,created_at:Date.now()-86400*60,in_use:true},
      {id:'sha256:i9j0k1l2',tags:['prometheuscommunity/postgres-exporter:v0.15'],size_bytes:34e6,created_at:Date.now()-86400*30,in_use:true},
      {id:'sha256:d4e5f6g7',tags:['hub-agent:1.2.3'],size_bytes:28e6,created_at:Date.now()-86400*7,in_use:true},
    ],
  },
};

// ─── Server events mock data ───────────────────────────────────────────────────
const SERVER_EVENTS = {
  s1: [
    {id:'ev1',kind:'heartbeat',    message:'Agent heartbeat received',          metadata:{agent_version:'1.2.3',cpu:23,mem:61}, created_at:Date.now()-12000},
    {id:'ev2',kind:'heartbeat',    message:'Agent heartbeat received',          metadata:{agent_version:'1.2.3',cpu:21,mem:60}, created_at:Date.now()-42000},
    {id:'ev3',kind:'sync_requested',message:'Status sync requested',           metadata:{requested_by:'sarah'},                created_at:Date.now()-3600000},
    {id:'ev4',kind:'came_online',  message:'Agent connected',                   metadata:{agent_version:'1.2.3'},               created_at:Date.now()-86400000},
    {id:'ev5',kind:'reboot_requested',message:'Reboot requested',              metadata:{requested_by:'james'},                created_at:Date.now()-86400000*2},
    {id:'ev6',kind:'came_online',  message:'Agent reconnected after reboot',    metadata:{agent_version:'1.2.2'},               created_at:Date.now()-86400000*2+180000},
    {id:'ev7',kind:'created',      message:'Server registered',                 metadata:{created_by:'sarah'},                  created_at:Date.now()-86400000*30},
  ],
  s3: [
    {id:'ev8',kind:'heartbeat',    message:'Agent heartbeat received',          metadata:{agent_version:'1.2.3',cpu:12,mem:88}, created_at:Date.now()-15000},
    {id:'ev9',kind:'heartbeat',    message:'Agent heartbeat received',          metadata:{agent_version:'1.2.3',cpu:11,mem:87}, created_at:Date.now()-45000},
    {id:'ev10',kind:'came_online', message:'Agent connected',                   metadata:{agent_version:'1.2.3'},               created_at:Date.now()-86400000*5},
    {id:'ev11',kind:'created',     message:'Server registered',                 metadata:{created_by:'system'},                 created_at:Date.now()-86400000*45},
  ],
  s7: [
    {id:'ev12',kind:'came_online', message:'Agent last connected',              metadata:{agent_version:'1.2.1'},               created_at:Date.now()-240000},
    {id:'ev13',kind:'heartbeat',   message:'Last heartbeat before timeout',     metadata:{agent_version:'1.2.1',cpu:14,mem:32}, created_at:Date.now()-240000},
    {id:'ev14',kind:'created',     message:'Server registered',                 metadata:{created_by:'james'},                  created_at:Date.now()-86400000*12},
  ],
};

const PROJECTS = [
  {id:'p1',name:'api-gateway',desc:'Main API gateway and routing',envs:{production:'healthy',staging:'healthy',development:'healthy'},apps:4,lastDeploy:'2h ago',deploying:false},
  {id:'p2',name:'dashboard',desc:'Customer-facing web dashboard',envs:{production:'healthy',staging:'deploying',development:'healthy'},apps:2,lastDeploy:'14m ago',deploying:true},
  {id:'p3',name:'data-pipeline',desc:'ETL pipeline & data processing',envs:{production:'degraded',staging:'healthy',development:'healthy'},apps:6,lastDeploy:'1d ago',deploying:false},
  {id:'p4',name:'auth-service',desc:'Authentication and authorization',envs:{production:'healthy',staging:'healthy',development:'stopped'},apps:3,lastDeploy:'3d ago',deploying:false},
  {id:'p5',name:'notifications',desc:'Email, push & webhook delivery',envs:{production:'healthy',staging:'healthy',development:'healthy'},apps:2,lastDeploy:'5h ago',deploying:false},
];

const DEPLOYMENTS = [
  {id:'d1',project:'dashboard',app:'web',env:'production',status:'success',version:'v2.14.1',commit:'a3f2c91',by:'sarah',duration:'2m 14s',ago:'14m ago'},
  {id:'d2',project:'dashboard',app:'web',env:'staging',status:'running',version:'v2.14.2-rc',commit:'b7d8e02',by:'ci-bot',duration:'—',ago:'3m ago'},
  {id:'d3',project:'api-gateway',app:'router',env:'staging',status:'success',version:'v1.9.0',commit:'c4a1d55',by:'james',duration:'1m 42s',ago:'2h ago'},
  {id:'d4',project:'data-pipeline',app:'worker',env:'production',status:'failed',version:'v3.2.1',commit:'e8b3f19',by:'ci-bot',duration:'45s',ago:'1d ago'},
  {id:'d5',project:'auth-service',app:'api',env:'production',status:'success',version:'v4.1.0',commit:'f2c9a87',by:'mike',duration:'1m 55s',ago:'3d ago'},
  {id:'d6',project:'notifications',app:'worker',env:'production',status:'success',version:'v1.3.2',commit:'d6e1b44',by:'ci-bot',duration:'58s',ago:'5h ago'},
];

// ─── Deployment detail data (steps + logs per deployment) ─────────────────────
const STEP_DEFS = [
  { key:'validate',    label:'Validate',         icon:'✦', desc:'Check image exists, verify env vars, test agent connectivity' },
  { key:'pull',        label:'Pull image',        icon:'⬇', desc:'Pull container image from registry to target server' },
  { key:'stop',        label:'Stop previous',     icon:'⏹', desc:'Gracefully shut down the running container (SIGTERM → SIGKILL)' },
  { key:'start',       label:'Start container',   icon:'▶', desc:'Create and start new container with updated config' },
  { key:'healthcheck', label:'Health check',      icon:'♥', desc:'HTTP ping container health endpoint until 200 or timeout' },
];

const DEPLOY_DETAILS = {
  d1: { // success — production
    steps: [
      { key:'validate',    status:'success', duration:'3s',  started_at: Date.now()-860000, log:[
        '→ Resolving target server prod-web-01 via Conduit…',
        '✓ Agent reachable at http://10.0.1.10:7700 (12ms)',
        '→ Checking image registry/dashboard:v2.14.1…',
        '✓ Image digest sha256:a1b2c3d4 confirmed in registry',
        '→ Validating environment variables (7 required)…',
        '✓ All environment variables present',
        '→ Checking disk space on prod-web-01…',
        '✓ 56 GB free — sufficient',
      ]},
      { key:'pull',        status:'success', duration:'28s', started_at: Date.now()-857000, log:[
        '→ docker pull registry/dashboard:v2.14.1',
        'v2.14.1: Pulling from registry/dashboard',
        'a1b2c3d4: Already exists',
        'b2c3d4e5: Pull complete',
        'c3d4e5f6: Pull complete',
        'Digest: sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        'Status: Downloaded newer image for registry/dashboard:v2.14.1',
        '✓ Image pulled (184 MB, 28s)',
      ]},
      { key:'stop',        status:'success', duration:'4s',  started_at: Date.now()-829000, log:[
        '→ Finding running container for app web in production…',
        '✓ Found: web-app-1 (c2b3c4) — uptime 10d 4h',
        '→ docker stop web-app-1 --time 30',
        '  Sending SIGTERM…',
        '  Container exited gracefully after 2.1s',
        '✓ Previous container stopped',
      ]},
      { key:'start',       status:'success', duration:'6s',  started_at: Date.now()-825000, log:[
        '→ docker create --name web-app-1 \\',
        '    --env-file /opt/hub/envs/dashboard-production.env \\',
        '    --network dashboard_default \\',
        '    --restart unless-stopped \\',
        '    -p 3000:3000 \\',
        '    registry/dashboard:v2.14.1',
        'Container ID: c9d0e1f2a3b4',
        '→ docker start web-app-1',
        '✓ Container started',
        '  Waiting for process to initialize…',
        '✓ Process running (PID 1 inside container)',
      ]},
      { key:'healthcheck', status:'success', duration:'9s',  started_at: Date.now()-819000, log:[
        '→ GET http://10.0.1.10:3000/health (attempt 1/10)…',
        '  Response: 503 — container still initializing',
        '→ GET http://10.0.1.10:3000/health (attempt 2/10)…',
        '  Response: 503 — container still initializing',
        '→ GET http://10.0.1.10:3000/health (attempt 3/10)…',
        '  Response: 200 OK {"status":"ok","version":"v2.14.1","uptime":6}',
        '✓ Health check passed (9s)',
        '✓ Deployment complete — v2.14.1 live on prod-web-01',
      ]},
    ],
    meta: { server:'prod-web-01', server_ip:'10.0.1.10', triggered:'manual', rollback_to:'v2.13.9' },
  },

  d2: { // running — staging (will be animated live)
    steps: [
      { key:'validate',    status:'success', duration:'2s',  started_at: Date.now()-190000, log:[
        '→ Resolving target server prod-web-02 via Conduit…',
        '✓ Agent reachable at http://10.0.1.11:7700 (9ms)',
        '→ Checking image registry/dashboard:v2.14.2-rc…',
        '✓ Image confirmed in registry',
        '✓ Environment variables validated (7/7)',
        '✓ Disk space OK (44 GB free)',
      ]},
      { key:'pull',        status:'success', duration:'31s', started_at: Date.now()-188000, log:[
        '→ docker pull registry/dashboard:v2.14.2-rc',
        'v2.14.2-rc: Pulling from registry/dashboard',
        'a1b2c3d4: Already exists',
        'd4e5f6g7: Pull complete',
        'e5f6g7h8: Pull complete',
        'f6g7h8i9: Pull complete',
        'Digest: sha256:b2c3d4e5f6a7b8c9',
        '✓ Image pulled (187 MB, 31s)',
      ]},
      { key:'stop',        status:'running', duration:null,  started_at: Date.now()-5000,   log:[
        '→ Finding running container for app web in staging…',
        '✓ Found: web-app-stg-1 (a0b1c2) — uptime 2d 6h',
        '→ docker stop web-app-stg-1 --time 30',
        '  Sending SIGTERM…',
      ]},
      { key:'start',       status:'pending', duration:null,  started_at: null, log:[] },
      { key:'healthcheck', status:'pending', duration:null,  started_at: null, log:[] },
    ],
    meta: { server:'prod-web-02', server_ip:'10.0.1.11', triggered:'push', rollback_to:'v2.14.1' },
  },

  d4: { // failed — production
    steps: [
      { key:'validate',    status:'success', duration:'2s',  started_at: Date.now()-86500000, log:[
        '✓ Agent reachable at http://10.0.3.10:7700 (14ms)',
        '✓ Image registry/data-pipeline:v3.2.1 confirmed',
        '✓ Environment variables validated (12/12)',
      ]},
      { key:'pull',        status:'success', duration:'18s', started_at: Date.now()-86498000, log:[
        '→ docker pull registry/data-pipeline:v3.2.1',
        '✓ Image pulled (221 MB, 18s)',
      ]},
      { key:'stop',        status:'success', duration:'3s',  started_at: Date.now()-86480000, log:[
        '✓ Found: pipeline-worker-1 — stopped cleanly',
      ]},
      { key:'start',       status:'failed',  duration:'2s',  started_at: Date.now()-86477000, log:[
        '→ docker create --name pipeline-worker-1 \\',
        '    --env-file /opt/hub/envs/data-pipeline-production.env \\',
        '    registry/data-pipeline:v3.2.1',
        '  Error response from daemon: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
        '  Is the docker daemon running?',
        '',
        '✗ docker: Error response from daemon: OCI runtime create failed:',
        '  container_linux.go:380: starting container process caused: process_linux.go:545:',
        '  container init caused: rootfs_linux.go:76: mounting "/run/secrets/db_password"',
        '  to rootfs at "/run/secrets/db_password" caused: mount through procfd:',
        '  not a directory: unknown.',
        '',
        '✗ Exit code 125 — secret mount failed',
      ]},
      { key:'healthcheck', status:'skipped', duration:null,  started_at: null, log:[] },
    ],
    meta: { server:'prod-worker-01', server_ip:'10.0.3.10', triggered:'push', rollback_to:'v3.1.8', error:'Secret mount failed — /run/secrets/db_password is not a directory. Check secret configuration.' },
  },
};

const PEERS = [
  {id:'pr1',name:'prod-web-01',ip:'100.64.0.1',status:'connected',kind:'server',seen:'now'},
  {id:'pr2',name:'prod-web-02',ip:'100.64.0.2',status:'connected',kind:'server',seen:'now'},
  {id:'pr3',name:'prod-db-01',ip:'100.64.0.10',status:'connected',kind:'server',seen:'now'},
  {id:'pr4',name:'prod-worker-01',ip:'100.64.0.20',status:'connected',kind:'server',seen:'2m ago'},
  {id:'pr5',name:'prod-gateway-01',ip:'100.64.0.30',status:'disconnected',kind:'server',seen:'4m ago'},
  {id:'pr6',name:'stg-app-01',ip:'100.64.1.1',status:'connected',kind:'server',seen:'now'},
  {id:'pr7',name:'james-macbook',ip:'100.64.100.1',status:'connected',kind:'device',seen:'1m ago'},
  {id:'pr8',name:'sarah-laptop',ip:'100.64.100.2',status:'connected',kind:'device',seen:'5m ago'},
];

const JOBS = [
  {id:'j1',name:'db-backup',project:'data-pipeline',schedule:'0 2 * * *',lastRun:'2h ago',status:'success',duration:'4m 12s',nextRun:'in 22h'},
  {id:'j2',name:'cache-warm',project:'api-gateway',schedule:'*/15 * * * *',lastRun:'8m ago',status:'success',duration:'12s',nextRun:'in 7m'},
  {id:'j3',name:'cleanup-logs',project:'data-pipeline',schedule:'0 0 * * 0',lastRun:'6d ago',status:'success',duration:'1m 45s',nextRun:'in 1d'},
  {id:'j4',name:'send-digest',project:'notifications',schedule:'0 9 * * 1-5',lastRun:'1h ago',status:'running',duration:'—',nextRun:'tomorrow'},
  {id:'j5',name:'index-sync',project:'dashboard',schedule:'0 */4 * * *',lastRun:'4h ago',status:'failed',duration:'2s',nextRun:'in 0h'},
];

const ALERTS = [
  {id:'a1',sev:'critical',msg:'prod-gateway-01 unreachable — 4m',time:'4m ago'},
  {id:'a2',sev:'warning',msg:'prod-db-01 memory at 88%',time:'12m ago'},
  {id:'a3',sev:'warning',msg:'data-pipeline deploy failed',time:'1d ago'},
];

const LOGS = [
  {ts:'12:41:03',level:'info',svc:'api-gateway',msg:'GET /api/users 200 14ms'},
  {ts:'12:41:02',level:'warn',svc:'prod-db-01',msg:'Memory usage at 88.2% — above threshold'},
  {ts:'12:41:01',level:'info',svc:'api-gateway',msg:'POST /api/deployments 201 32ms'},
  {ts:'12:41:00',level:'error',svc:'prod-gateway-01',msg:'Agent heartbeat timeout after 240s'},
  {ts:'12:40:58',level:'info',svc:'notifications',msg:'Digest sent to 142 subscribers'},
  {ts:'12:40:57',level:'info',svc:'auth-service',msg:'Token refresh: usr_x7k2m9'},
  {ts:'12:40:55',level:'warn',svc:'data-pipeline',msg:'index-sync failed: connection refused'},
  {ts:'12:40:53',level:'info',svc:'api-gateway',msg:'GET /api/servers 200 8ms'},
];

// ─── Sysadmin mock data ────────────────────────────────────────────────────────

// ─── SSH Keys ─────────────────────────────────────────────────────────────────
const SSH_KEYS = [
  {
    id:'sk1', name:'prod-deploy-key', fingerprint:'SHA256:4pjM3K9vXzQw8nR2sT6uY1bD5fH0cE7lA',
    public_key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHv4pjM3K9vXzQw8nR2sT6uY1bD5fH0cE7lAjKmNpQrs deploy@acme.com',
    algo:'ed25519', bits:null, servers:['prod-web-01','prod-web-02','prod-db-01','prod-worker-01','build-runner-01'],
    created_by:'sarah', created_at:Date.now()-86400000*45, last_used:Date.now()-12000,
  },
  {
    id:'sk2', name:'staging-access', fingerprint:'SHA256:9kLmN2oP4qRsT6uV8wXyZ0aB3cD5eF7g',
    public_key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINpQ9kLmN2oP4qRsT6uV8wXyZ0aB3cD5eF7gHiJkLm staging@acme.com',
    algo:'ed25519', bits:null, servers:['stg-app-01'],
    created_by:'james', created_at:Date.now()-86400000*30, last_used:Date.now()-3600000*2,
  },
  {
    id:'sk3', name:'ci-bot-key', fingerprint:'SHA256:2bCdEfGhIjKlMnOpQrStUvWxYz1A3B5C7D',
    public_key:'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC2bCdEfGhIjKlMnOpQrStUvWxYz1A3B5C7DeFgHiJkLm ci-bot@acme.com',
    algo:'rsa', bits:4096, servers:['prod-web-01','prod-web-02','build-runner-01'],
    created_by:'sarah', created_at:Date.now()-86400000*60, last_used:Date.now()-3600000*6,
  },
  {
    id:'sk4', name:'james-personal', fingerprint:'SHA256:7hIjKlMnOpQrStUvWxYz1A3B5C7DeFgHiJ',
    public_key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN7hIjKlMnOpQrStUvWxYz1A3B5C7DeFgHiJkLmNoP james@acme.com',
    algo:'ed25519', bits:null, servers:['stg-app-01','dev-sandbox-01'],
    created_by:'james', created_at:Date.now()-86400000*20, last_used:Date.now()-86400000*3,
  },
  {
    id:'sk5', name:'legacy-rsa-2048', fingerprint:'SHA256:0AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp',
    public_key:'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC0AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRr legacy@acme.com',
    algo:'rsa', bits:2048, servers:[],
    created_by:'sarah', created_at:Date.now()-86400000*180, last_used:null,
  },
];

const WORKSPACES = [
  {id:'w1',name:'Acme Corp',slug:'acme',plan:'enterprise',status:'active',members:12,servers:8,projects:5,created:'Jan 12, 2024',owner:'sarah@acme.com',region:'us-east-1',dbSize:'142 MB'},
  {id:'w2',name:'Skyline Labs',slug:'skyline',plan:'team',status:'active',members:5,servers:3,projects:3,created:'Mar 3, 2024',owner:'john@skyline.io',region:'us-west-2',dbSize:'44 MB'},
  {id:'w3',name:'Nova Systems',slug:'nova',plan:'starter',status:'active',members:2,servers:1,projects:2,created:'Apr 18, 2024',owner:'dev@nova.systems',region:'eu-west-1',dbSize:'9 MB'},
  {id:'w4',name:'Redwood Co',slug:'redwood',plan:'team',status:'suspended',members:7,servers:0,projects:4,created:'Feb 7, 2024',owner:'ops@redwood.co',region:'us-east-1',dbSize:'61 MB'},
  {id:'w5',name:'Ember Stack',slug:'ember',plan:'starter',status:'active',members:1,servers:2,projects:1,created:'May 1, 2024',owner:'me@emberstack.dev',region:'ap-southeast-1',dbSize:'3 MB'},
];

const ALL_USERS = [
  {id:'u1',name:'Sarah Chen',email:'sarah@acme.com',type:'human',workspace:'Acme Corp',role:'owner',status:'active',last:'2m ago',avatar:'SC'},
  {id:'u2',name:'James Okafor',email:'james@acme.com',type:'human',workspace:'Acme Corp',role:'developer',status:'active',last:'1h ago',avatar:'JO'},
  {id:'u3',name:'ci-bot',email:null,type:'bot',workspace:'Acme Corp',role:'developer',status:'active',last:'3m ago',avatar:'CI'},
  {id:'u4',name:'deploy-agent',email:null,type:'ai',workspace:'Acme Corp',role:'developer',status:'active',last:'14m ago',avatar:'DA'},
  {id:'u5',name:'Mike Torres',email:'mike@acme.com',type:'human',workspace:'Acme Corp',role:'admin',status:'active',last:'3h ago',avatar:'MT'},
  {id:'u6',name:'John Park',email:'john@skyline.io',type:'human',workspace:'Skyline Labs',role:'owner',status:'active',last:'5h ago',avatar:'JP'},
  {id:'u7',name:'skyline-ci',email:null,type:'bot',workspace:'Skyline Labs',role:'developer',status:'active',last:'22m ago',avatar:'SC'},
  {id:'u8',name:'ops@redwood.co',email:'ops@redwood.co',type:'human',workspace:'Redwood Co',role:'owner',status:'suspended',last:'14d ago',avatar:'RW'},
  {id:'u9',name:'nova-deploy',email:null,type:'bot',workspace:'Nova Systems',role:'developer',status:'active',last:'1d ago',avatar:'ND'},
  {id:'u10',name:'frontier-ai',email:null,type:'ai',workspace:'Acme Corp',role:'developer',status:'active',last:'just now',avatar:'FA'},
];

const ADAPTERS = [
  {id:'secrets',    name:'Secrets',       desc:'Encrypted key-value store for credentials and tokens',                 env:'INFISICAL_URL',    adapter:'Infisical',      status:'connected', icon:'🔐'},
  {id:'flags',      name:'Feature Flags', desc:'Runtime feature toggles with per-workspace context',                   env:'UNLEASH_URL',      adapter:'Unleash',        status:'connected', icon:'🚩'},
  {id:'queue',      name:'Job Queue',     desc:'Background job queue for async task processing',                       env:'FAKTORY_URL',      adapter:'Faktory',        status:'stub',      icon:'⚡'},
  {id:'search',     name:'Search',        desc:'Full-text search index for projects, deployments, logs',               env:'TYPESENSE_URL',    adapter:'Typesense',      status:'connected', icon:'🔍'},
  {id:'registry',   name:'Container Registry', desc:'Docker image registry for built container artifacts',             env:'ZOT_URL',          adapter:'Zot (OCI)',       status:'stub',      icon:'📦'},
  {id:'git',        name:'Git',           desc:'Source code hosting for project repositories and webhooks',            env:'FORGEJO_URL',      adapter:'Forgejo',        status:'connected', icon:'🗂'},
  {id:'observability',name:'Observability','desc':'Metrics, logs, and traces aggregation layer',                      env:'GRAFANA_URL',      adapter:'Grafana + Loki', status:'connected', icon:'📡'},
  {id:'networking', name:'Networking',    desc:'Private mesh network management for peer-to-peer connectivity',        env:'NETBIRD_URL',      adapter:'NetBird',        status:'stub',      icon:'🕸'},
  {id:'integrations',name:'Integrations','desc':'OAuth connection manager for third-party services',                  env:'NANGO_URL',        adapter:'Nango',          status:'stub',      icon:'🔗'},
];

const AUDIT_LOG = [
  {id:'ae1', ts:'12:41:03', actor:'sarah',       atype:'human', action:'deployment.created',   subject:'dashboard/web@staging',         ws:'Acme Corp',    ip:'203.0.113.14'},
  {id:'ae2', ts:'12:40:51', actor:'ci-bot',      atype:'bot',   action:'deployment.success',   subject:'dashboard/web@production',      ws:'Acme Corp',    ip:'10.0.0.5'},
  {id:'ae3', ts:'12:39:20', actor:'james',       atype:'human', action:'server.drain',         subject:'prod-worker-01',                ws:'Acme Corp',    ip:'203.0.113.22'},
  {id:'ae4', ts:'12:38:05', actor:'system',      atype:'system',action:'alert.fired',          subject:'prod-gateway-01',               ws:'Acme Corp',    ip:'—'},
  {id:'ae5', ts:'12:35:44', actor:'sarah',       atype:'human', action:'workspace.member_added',subject:'james@acme.com',              ws:'Acme Corp',    ip:'203.0.113.14'},
  {id:'ae6', ts:'12:30:11', actor:'frontier-ai', atype:'ai',    action:'job.triggered',        subject:'index-sync',                    ws:'Acme Corp',    ip:'10.0.0.1'},
  {id:'ae7', ts:'11:54:38', actor:'john',        atype:'human', action:'server.created',       subject:'stg-db-02 (nyc3)',              ws:'Skyline Labs', ip:'198.51.100.8'},
  {id:'ae8', ts:'11:40:00', actor:'system',      atype:'system',action:'workspace.suspended',  subject:'Redwood Co',                    ws:'—',            ip:'—'},
  {id:'ae9', ts:'10:22:15', actor:'sarah',       atype:'human', action:'adapter.configured',   subject:'secrets → Infisical',           ws:'Acme Corp',    ip:'203.0.113.14'},
  {id:'ae10',ts:'09:15:00', actor:'nova-deploy', atype:'bot',   action:'deployment.failed',    subject:'nova/api@production',           ws:'Nova Systems', ip:'10.1.0.4'},
];

const FLAGS = [
  {id:'f1', key:'feature.deployment_v2_engine',  desc:'New deployment engine with parallel steps',       enabled:true,  env:'all',          created:'2024-02-01'},
  {id:'f2', key:'feature.wireguard_mesh',         desc:'WireGuard mesh networking portal',                enabled:true,  env:'all',          created:'2024-03-10'},
  {id:'f3', key:'feature.ai_agents',              desc:'AI user type and agent orchestration',            enabled:true,  env:'all',          created:'2024-04-20'},
  {id:'f4', key:'feature.dag_workflows',          desc:'DAG-based automation workflow builder',           enabled:false, env:'development',  created:'2024-05-01'},
  {id:'f5', key:'feature.infra_graph',            desc:'Interactive infrastructure dependency graph',     enabled:false, env:'staging',      created:'2024-05-05'},
  {id:'f6', key:'feature.multi_provider_deploy',  desc:'Deploy to Hetzner and Vultr providers',          enabled:false, env:'development',  created:'2024-05-10'},
  {id:'f7', key:'experiment.command_palette_v2',  desc:'Redesigned command palette with inline actions',  enabled:true,  env:'all',          created:'2024-04-15'},
  {id:'f8', key:'killswitch.api_ratelimit',        desc:'Emergency rate limiting on all API endpoints',   enabled:false, env:'production',   created:'2024-01-01'},
];

const SYS_HEALTH = {
  version: '0.9.4',
  uptime: '14d 3h 22m',
  dbSize: '284 MB',
  dbPath: '/data/hub.db',
  sqliteVersion: '3.45.1',
  bunVersion: '1.1.8',
  nodeEnv: 'production',
  pid: 1842,
  memUsed: 312,
  memTotal: 2048,
  cpuPct: 4,
  wsConnections: 7,
  queueDepths: {deployments: 0, jobs: 2, notifications: 14},
  conduitTargets: 9,
  eventBusSubscribers: 23,
};

// ─── DO wizard config ──────────────────────────────────────────────────────────
const DO_REGIONS = [
  {slug:'nyc3',name:'New York 3',   flag:'🇺🇸',area:'US East'},
  {slug:'sfo3',name:'San Francisco',flag:'🇺🇸',area:'US West'},
  {slug:'ams3',name:'Amsterdam 3',  flag:'🇳🇱',area:'EU West'},
  {slug:'fra1',name:'Frankfurt 1',  flag:'🇩🇪',area:'EU Central'},
  {slug:'lon1',name:'London 1',     flag:'🇬🇧',area:'EU West'},
  {slug:'sgp1',name:'Singapore 1',  flag:'🇸🇬',area:'Asia Pacific'},
  {slug:'syd1',name:'Sydney 1',     flag:'🇦🇺',area:'Asia Pacific'},
  {slug:'tor1',name:'Toronto 1',    flag:'🇨🇦',area:'CA East'},
];
const DO_PLANS = [
  {slug:'s-1vcpu-1gb',  name:'Basic',   vcpu:1, mem:'1 GB',  disk:'25 GB SSD',  bw:'1 TB',  price:6,   tag:''},
  {slug:'s-1vcpu-2gb',  name:'Basic',   vcpu:1, mem:'2 GB',  disk:'50 GB SSD',  bw:'2 TB',  price:12,  tag:''},
  {slug:'s-2vcpu-4gb',  name:'Basic',   vcpu:2, mem:'4 GB',  disk:'80 GB SSD',  bw:'4 TB',  price:24,  tag:'popular'},
  {slug:'s-4vcpu-8gb',  name:'Basic',   vcpu:4, mem:'8 GB',  disk:'160 GB SSD', bw:'5 TB',  price:48,  tag:''},
  {slug:'c-4',          name:'CPU-Opt', vcpu:4, mem:'8 GB',  disk:'50 GB NVMe', bw:'5 TB',  price:84,  tag:''},
  {slug:'m-4vcpu-32gb', name:'Mem-Opt', vcpu:4, mem:'32 GB', disk:'100 GB NVMe',bw:'5 TB',  price:168, tag:''},
];
const DO_IMAGES = [
  {slug:'ubuntu-24-04-x64',name:'Ubuntu 24.04 LTS',icon:'🐧'},
  {slug:'ubuntu-22-04-x64',name:'Ubuntu 22.04 LTS',icon:'🐧'},
  {slug:'debian-12-x64',   name:'Debian 12',        icon:'🌀'},
  {slug:'rocky-9-x64',     name:'Rocky Linux 9',    icon:'⛰️'},
];
const SERVER_ROLES = ['general','build','database','gateway','worker'];
const PROVISION_STEPS = [
  {label:'Creating Droplet via DigitalOcean API',  ms:1800},
  {label:'Waiting for network reachability',        ms:3200},
  {label:'Establishing SSH connection',             ms:1200},
  {label:'Installing system dependencies',          ms:2800},
  {label:'Installing Docker Engine',                ms:3400},
  {label:'Pulling hub-agent binary',                ms:900 },
  {label:'Starting hub-agent service',              ms:600 },
  {label:'Registering agent with Platform Hub',     ms:800 },
  {label:'Verifying heartbeat',                     ms:700 },
];

// ─── Color helpers ─────────────────────────────────────────────────────────────
const sColor = s => ({online:T.green,draining:T.amber,unreachable:T.red,stopped:T.muted,pending:T.amber}[s]||T.muted);
const dColor = s => ({success:T.green,running:T.blue,failed:T.red,pending:T.amber}[s]||T.muted);
const eColor = s => ({healthy:T.green,deploying:T.blue,degraded:T.amber,stopped:T.muted,failed:T.red}[s]||T.muted);
const rColor = r => ({general:T.blue,database:T.purple,worker:T.cyan,build:T.amber,gateway:T.green}[r]||T.muted);
const jColor = s => ({success:T.green,running:T.blue,failed:T.red}[s]||T.muted);
const lColor = l => ({info:T.sec,warn:T.amber,error:T.red}[l]||T.sec);
const uColor = t => ({human:T.blue,bot:T.cyan,ai:T.purple}[t]||T.muted);
const wColor = s => ({active:T.green,suspended:T.red,pending:T.amber}[s]||T.muted);
const aColor = s => ({connected:T.green,stub:T.muted,error:T.red}[s]||T.muted);
const planColor = p => ({enterprise:T.purple,team:T.blue,starter:T.cyan}[p]||T.muted);

// ─── Atoms ─────────────────────────────────────────────────────────────────────

function Dot({color,size=7}) {
  return <span style={{display:'inline-block',width:size,height:size,borderRadius:'50%',background:color,flexShrink:0}}/>;
}

function Bar({value,label}) {
  if(value===null) return <span style={{color:T.muted,fontSize:12}}>—</span>;
  const c=value>=90?T.red:value>=75?T.amber:T.green;
  return (
    <div style={{minWidth:72}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
        {label&&<span style={{fontSize:10,color:T.sec}}>{label}</span>}
        <span style={{fontSize:11,color:c,fontFamily:'monospace',marginLeft:'auto'}}>{value}%</span>
      </div>
      <div style={{height:2,background:T.elevated,borderRadius:1}}>
        <div style={{height:'100%',width:value+'%',background:c,borderRadius:1}}/>
      </div>
    </div>
  );
}

function Pill({label,color}) {
  return <span style={{fontSize:11,padding:'2px 7px',borderRadius:4,background:`${color}22`,color,border:`0.5px solid ${color}44`,fontWeight:500,letterSpacing:'0.02em',whiteSpace:'nowrap'}}>{label}</span>;
}

function Card({children,style={}}) {
  return <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'16px 20px',...style}}>{children}</div>;
}

function StatCard({label,value,sub,color}) {
  return (
    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'16px 20px'}}>
      <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:10}}>{label}</div>
      <div style={{fontSize:26,fontWeight:600,color:color||T.text,letterSpacing:'-0.02em',lineHeight:1}}>{value}</div>
      {sub&&<div style={{marginTop:7,fontSize:12,color:T.sec}}>{sub}</div>}
    </div>
  );
}

function SecHead({title,action,label}) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
      <h3 style={{margin:0,fontSize:11,fontWeight:500,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em'}}>{title}</h3>
      {action&&<button onClick={action} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,fontSize:12,padding:'2px 6px',borderRadius:4}}>{label||'View all →'}</button>}
    </div>
  );
}

function Kbd({children}) {
  return <kbd style={{fontSize:10,padding:'2px 5px',borderRadius:3,background:T.elevated,border:`0.5px solid ${T.borderMd}`,color:T.sec,fontFamily:'monospace',lineHeight:'14px'}}>{children}</kbd>;
}

function Input({label,value,onChange,placeholder,type='text',hint,error,mono=false,...rest}) {
  return (
    <div style={{marginBottom:16}}>
      {label&&<label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>{label}</label>}
      <input type={type} value={value} onChange={onChange} placeholder={placeholder}
        style={{width:'100%',boxSizing:'border-box',background:T.elevated,border:`0.5px solid ${error?T.red:T.borderMd}`,borderRadius:6,padding:'9px 12px',fontSize:13,color:T.text,fontFamily:mono?'monospace':'inherit',outline:'none'}}
        onFocus={e=>e.target.style.borderColor=error?T.red:T.blue}
        onBlur={e=>e.target.style.borderColor=error?T.red:T.borderMd}
        {...rest}/>
      {hint&&!error&&<div style={{fontSize:11,color:T.muted,marginTop:5}}>{hint}</div>}
      {error&&<div style={{fontSize:11,color:T.red,marginTop:5}}>{error}</div>}
    </div>
  );
}

function Avatar({initials,color=T.purple,size=28}) {
  return <div style={{width:size,height:size,borderRadius:'50%',background:color,display:'flex',alignItems:'center',justifyContent:'center',fontSize:size*0.38,color:'#fff',fontWeight:700,flexShrink:0}}>{initials}</div>;
}

// ─── DigitalOcean logo ─────────────────────────────────────────────────────────
function DOLogo({size=28}) {
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" fill="none">
      <circle cx="25" cy="25" r="25" fill="#0069ff"/>
      <path d="M25.1 37.6v-6c6.1 0 10.8-6 8.6-12.4-0.9-2.6-3-4.7-5.6-5.6C22 11.4 16 16.1 16 22.2h-6c0-9.7 9.3-17.2 19.4-14.6 5.3 1.4 9.5 5.7 10.9 11C42.7 27.6 35 37.6 25.1 37.6z" fill="white"/>
      <path d="M25.1 43.6v-6c3.4 0 6.6-1.3 9-3.7l4.2 4.2C35 41.5 30.2 43.6 25.1 43.6z" fill="white"/>
      <path d="M12.9 37.9l4.2-4.2c1.5 1.5 3.4 2.6 5.5 3.1v6C18.8 42.1 15.4 40.4 12.9 37.9z" fill="white"/>
      <rect x="19.1" y="43" width="6" height="4.8" fill="white"/>
      <rect x="12.9" y="37.9" width="5" height="4.5" fill="white"/>
    </svg>
  );
}

// ─── Table shell ───────────────────────────────────────────────────────────────
function Table({cols,rows,renderRow}) {
  return (
    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,overflow:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
        <thead>
          <tr style={{borderBottom:`0.5px solid ${T.borderMd}`}}>
            {cols.map(c=><th key={c} style={{padding:'10px 16px',textAlign:'left',fontSize:11,color:T.sec,fontWeight:500,textTransform:'uppercase',letterSpacing:'0.06em',whiteSpace:'nowrap'}}>{c}</th>)}
          </tr>
        </thead>
        <tbody>{rows.map((r,i)=>renderRow(r,i,rows.length))}</tbody>
      </table>
    </div>
  );
}

function TR({i,total,children}) {
  return <tr style={{borderBottom:i<total-1?`0.5px solid ${T.border}`:'none'}}>{children}</tr>;
}

function TD({children,style={}}) {
  return <td style={{padding:'11px 16px',...style}}>{children}</td>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSADMIN VIEWS
// ═══════════════════════════════════════════════════════════════════════════════

function SysHeader({title,sub,children}) {
  return (
    <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
      <div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
          <span style={{fontSize:11,padding:'2px 8px',borderRadius:3,background:`${T.sys}18`,color:T.sys,border:`0.5px solid ${T.sys}44`,fontWeight:600,letterSpacing:'0.08em',textTransform:'uppercase'}}>System Admin</span>
        </div>
        <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{title}</h2>
        {sub&&<p style={{margin:'5px 0 0',fontSize:13,color:T.sec}}>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Hub Overview ──────────────────────────────────────────────────────────────
function SysOverviewView() {
  const h = SYS_HEALTH;
  return (
    <div style={{padding:'28px 30px',maxWidth:1000}}>
      <SysHeader title="Hub Overview" sub={`Platform Hub v${h.version} · PID ${h.pid} · ${h.nodeEnv}`}/>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Uptime"            value={h.uptime.split(' ')[0]}  sub={h.uptime}                     color={T.green}/>
        <StatCard label="WS Connections"    value={h.wsConnections}          sub="live clients"                 color={T.blue}/>
        <StatCard label="Conduit Targets"   value={h.conduitTargets}         sub="agents + providers"           color={T.text}/>
        <StatCard label="Event Subscribers" value={h.eventBusSubscribers}    sub="in-process bus"               color={T.text}/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
        <Card>
          <SecHead title="Runtime"/>
          {[
            ['Bun version',   h.bunVersion],
            ['SQLite',        h.sqliteVersion],
            ['DB path',       h.dbPath],
            ['DB size',       h.dbSize],
            ['Memory used',   `${h.memUsed} MB / ${h.memTotal} MB`],
            ['CPU',           `${h.cpuPct}%`],
            ['Environment',   h.nodeEnv],
          ].map(([k,v])=>(
            <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:`0.5px solid ${T.border}`}}>
              <span style={{fontSize:12,color:T.sec}}>{k}</span>
              <span style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{v}</span>
            </div>
          ))}
        </Card>

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <Card>
            <SecHead title="Queue depths"/>
            {Object.entries(h.queueDepths).map(([q,n])=>(
              <div key={q} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'7px 0',borderBottom:`0.5px solid ${T.border}`}}>
                <span style={{fontSize:12,color:T.sec,fontFamily:'monospace'}}>{q}</span>
                <span style={{fontSize:13,fontWeight:600,color:n>0?T.amber:T.green}}>{n}</span>
              </div>
            ))}
          </Card>

          <Card>
            <SecHead title="Workspaces"/>
            {WORKSPACES.map((w,i)=>(
              <div key={w.id} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:i<WORKSPACES.length-1?`0.5px solid ${T.border}`:'none'}}>
                <Dot color={wColor(w.status)} size={6}/>
                <span style={{fontSize:12,color:T.text,flex:1}}>{w.name}</span>
                <Pill label={w.plan} color={planColor(w.plan)}/>
                <span style={{fontSize:11,color:T.muted}}>{w.members}m · {w.servers}s</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Card>
        <SecHead title="Adapter health"/>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
          {ADAPTERS.map(a=>(
            <div key={a.id} style={{background:T.elevated,borderRadius:7,padding:'11px 14px',display:'flex',alignItems:'center',gap:10,border:`0.5px solid ${a.status==='connected'?T.green+'33':T.border}`}}>
              <span style={{fontSize:18}}>{a.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:500,color:T.text}}>{a.name}</div>
                <div style={{fontSize:11,color:T.sec,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.adapter}</div>
              </div>
              <Pill label={a.status} color={aColor(a.status)}/>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ── Workspaces ─────────────────────────────────────────────────────────────────
function WorkspacesView() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const ws = WORKSPACES.filter(w=>!search||w.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div style={{padding:'28px 30px'}}>
      <SysHeader title="Workspaces" sub={`${WORKSPACES.length} workspaces · ${WORKSPACES.filter(w=>w.status==='active').length} active`}>
        <button style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New Workspace</button>
      </SysHeader>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Total"     value={WORKSPACES.length}                                     sub="all workspaces"/>
        <StatCard label="Active"    value={WORKSPACES.filter(w=>w.status==='active').length}       sub="running" color={T.green}/>
        <StatCard label="Suspended" value={WORKSPACES.filter(w=>w.status==='suspended').length}   sub="access revoked" color={T.red}/>
        <StatCard label="Total DBs" value={WORKSPACES.reduce((a,w)=>a+parseFloat(w.dbSize),0).toFixed(0)+' MB'} sub="combined storage"/>
      </div>

      <div style={{marginBottom:16}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter workspaces…"
          style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:13,color:T.text,outline:'none',width:280}}
          onFocus={e=>e.target.style.borderColor=T.blue} onBlur={e=>e.target.style.borderColor=T.borderMd}/>
      </div>

      <Table
        cols={['Workspace','Plan','Status','Members','Servers','Projects','DB Size','Owner','Created','']}
        rows={ws}
        renderRow={(w,i,n)=>(
          <TR key={w.id} i={i} total={n}>
            <TD>
              <div style={{fontWeight:500,color:T.text}}>{w.name}</div>
              <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',marginTop:2}}>{w.slug}</div>
            </TD>
            <TD><Pill label={w.plan} color={planColor(w.plan)}/></TD>
            <TD>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <Dot color={wColor(w.status)} size={6}/>
                <span style={{color:wColor(w.status),fontSize:12}}>{w.status}</span>
              </div>
            </TD>
            <TD style={{color:T.sec,fontSize:13}}>{w.members}</TD>
            <TD style={{color:T.sec,fontSize:13}}>{w.servers}</TD>
            <TD style={{color:T.sec,fontSize:13}}>{w.projects}</TD>
            <TD style={{color:T.sec,fontSize:12,fontFamily:'monospace'}}>{w.dbSize}</TD>
            <TD style={{color:T.sec,fontSize:12}}>{w.owner}</TD>
            <TD style={{color:T.muted,fontSize:12}}>{w.created}</TD>
            <TD>
              <div style={{display:'flex',gap:6}}>
                <button onClick={()=>toast.info('Impersonating',`Opening ${w.name} as ${w.owner}`,{duration:3500})} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Impersonate</button>
                {w.status==='active'
                  ? <button onClick={()=>toast.error('Workspace suspended',`${w.name} members can no longer sign in.`)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer'}}>Suspend</button>
                  : <button onClick={()=>toast.success('Workspace reinstated',`${w.name} is active again.`)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.green}44`,background:`${T.green}11`,color:T.green,cursor:'pointer'}}>Reinstate</button>
                }
              </div>
            </TD>
          </TR>
        )}
      />
    </div>
  );
}

// ── Users & Bots ───────────────────────────────────────────────────────────────
function UsersView() {
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const users = filter==='all' ? ALL_USERS : ALL_USERS.filter(u=>u.type===filter);
  const counts = {human:ALL_USERS.filter(u=>u.type==='human').length, bot:ALL_USERS.filter(u=>u.type==='bot').length, ai:ALL_USERS.filter(u=>u.type==='ai').length};

  return (
    <div style={{padding:'28px 30px'}}>
      <SysHeader title="Users & Bots" sub={`${ALL_USERS.length} total actors across ${WORKSPACES.length} workspaces`}>
        <button style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Invite User</button>
      </SysHeader>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Human users"    value={counts.human} sub="email + password" color={T.blue}/>
        <StatCard label="Bot accounts"   value={counts.bot}   sub="API key only"     color={T.cyan}/>
        <StatCard label="AI agents"      value={counts.ai}    sub="LLM actors"       color={T.purple}/>
        <StatCard label="Suspended"      value={ALL_USERS.filter(u=>u.status==='suspended').length} sub="access revoked" color={T.red}/>
      </div>

      <div style={{display:'flex',gap:3,marginBottom:20,background:T.elevated,borderRadius:7,padding:4,width:'fit-content'}}>
        {['all','human','bot','ai'].map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{padding:'5px 14px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===f?500:400,background:filter===f?T.card:'transparent',color:filter===f?T.text:T.sec}}>
            {f}{f!=='all'?` (${counts[f]||0})`:''}
          </button>
        ))}
      </div>

      <Table
        cols={['User','Type','Workspace','Role','Status','Last Active','']}
        rows={users}
        renderRow={(u,i,n)=>(
          <TR key={u.id} i={i} total={n}>
            <TD>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <Avatar initials={u.avatar} color={uColor(u.type)} size={30}/>
                <div>
                  <div style={{fontWeight:500,color:T.text,fontSize:13}}>{u.name}</div>
                  <div style={{fontSize:11,color:T.muted,marginTop:1}}>{u.email||'no email'}</div>
                </div>
              </div>
            </TD>
            <TD><Pill label={u.type} color={uColor(u.type)}/></TD>
            <TD style={{fontSize:12,color:T.sec}}>{u.workspace}</TD>
            <TD><Pill label={u.role} color={u.role==='owner'?T.amber:u.role==='admin'?T.orange:T.blue}/></TD>
            <TD>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <Dot color={u.status==='active'?T.green:T.red} size={6}/>
                <span style={{fontSize:12,color:u.status==='active'?T.green:T.red}}>{u.status}</span>
              </div>
            </TD>
            <TD style={{fontSize:12,color:T.muted,fontFamily:'monospace'}}>{u.last}</TD>
            <TD>
              <div style={{display:'flex',gap:6}}>
                {u.type==='human'&&<button onClick={()=>toast.info('Impersonating',`Viewing as ${u.name}`,{duration:3500})} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Impersonate</button>}
                {u.status==='active'
                  ? <button onClick={()=>toast.error('User suspended',`${u.name} can no longer sign in.`)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer'}}>Suspend</button>
                  : <button onClick={()=>toast.success('User restored',`${u.name} can sign in again.`)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.green}44`,background:`${T.green}11`,color:T.green,cursor:'pointer'}}>Restore</button>
                }
              </div>
            </TD>
          </TR>
        )}
      />
    </div>
  );
}

// ── Adapters ───────────────────────────────────────────────────────────────────
function AdaptersView() {
  const toast = useToast();
  const [selected, setSelected] = useState(null);
  const connected = ADAPTERS.filter(a=>a.status==='connected').length;

  return (
    <div style={{padding:'28px 30px',maxWidth:1000}}>
      <SysHeader title="Infrastructure Adapters" sub={`${connected} of ${ADAPTERS.length} connected · Stubs log warnings, real adapters activate via env vars`}/>

      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Connected"  value={connected}                      sub="real adapters"  color={T.green}/>
        <StatCard label="Stub mode"  value={ADAPTERS.length-connected}      sub="log + no-op"    color={T.muted}/>
        <StatCard label="Interfaces" value={ADAPTERS.length}                sub="total adapters"/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        {ADAPTERS.map(a=>{
          const sel=selected===a.id;
          return (
            <div key={a.id} onClick={()=>setSelected(sel?null:a.id)} style={{background:sel?`${T.sys}08`:T.card,border:`0.5px solid ${sel?T.sys:a.status==='connected'?T.green+'33':T.border}`,borderRadius:9,padding:'16px 18px',cursor:'pointer',transition:'border-color 0.12s'}}>
              <div style={{display:'flex',alignItems:'flex-start',gap:12}}>
                <div style={{width:36,height:36,borderRadius:8,background:T.elevated,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{a.icon}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{a.name}</span>
                    <Pill label={a.status} color={aColor(a.status)}/>
                  </div>
                  <div style={{fontSize:12,color:T.sec,lineHeight:'18px',marginBottom:8}}>{a.desc}</div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontSize:11,color:T.muted}}>Adapter:</span>
                    <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{a.adapter}</span>
                  </div>
                </div>
              </div>

              {sel&&(
                <div style={{marginTop:16,paddingTop:14,borderTop:`0.5px solid ${T.border}`}}>
                  <div style={{fontSize:11,color:T.sec,marginBottom:8,textTransform:'uppercase',letterSpacing:'0.07em'}}>Configuration</div>
                  <div style={{background:T.elevated,borderRadius:6,padding:'10px 12px',fontFamily:'monospace',fontSize:12}}>
                    <span style={{color:T.muted}}># Set to activate real adapter{'\n'}</span>
                    <span style={{color:T.amber}}>{a.env}</span>
                    <span style={{color:T.sec}}>=</span>
                    <span style={{color:T.green}}>"http://your-{a.adapter.toLowerCase().split(' ')[0]}:port"</span>
                  </div>
                  {a.status==='connected'&&(
                    <div style={{marginTop:10,display:'flex',alignItems:'center',gap:6,fontSize:12,color:T.green}}>
                      <span>✓</span><span>Adapter healthy · last checked 30s ago</span>
                    </div>
                  )}
                  {a.status==='stub'&&(
                    <div style={{marginTop:10,fontSize:12,color:T.amber}}>
                      ⚠ Running in stub mode — all calls are no-ops. Set <code style={{fontFamily:'monospace',fontSize:11}}>{a.env}</code> to activate.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Audit Log ──────────────────────────────────────────────────────────────────
function AuditLogView() {
  const atypeColor = t => ({human:T.blue,bot:T.cyan,ai:T.purple,system:T.muted}[t]||T.muted);
  const actionColor = a => {
    if(a.includes('created')||a.includes('success')) return T.green;
    if(a.includes('failed')||a.includes('suspended')||a.includes('fired')) return T.red;
    if(a.includes('drain')||a.includes('warned')) return T.amber;
    return T.sec;
  };
  return (
    <div style={{padding:'28px 30px'}}>
      <SysHeader title="Audit Log" sub="Immutable system-wide event trail. All mutations across all workspaces."/>

      <div style={{display:'flex',gap:10,marginBottom:20,alignItems:'center'}}>
        <input placeholder="Filter events, actors, actions…"
          style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:13,color:T.text,outline:'none',width:320}}
          onFocus={e=>e.target.style.borderColor=T.blue} onBlur={e=>e.target.style.borderColor=T.borderMd}/>
        <select style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:12,color:T.sec,outline:'none'}}>
          <option>All workspaces</option>
          {WORKSPACES.map(w=><option key={w.id}>{w.name}</option>)}
        </select>
        <select style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:12,color:T.sec,outline:'none'}}>
          <option>All actor types</option>
          <option>human</option><option>bot</option><option>ai</option><option>system</option>
        </select>
      </div>

      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,overflow:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead>
            <tr style={{borderBottom:`0.5px solid ${T.borderMd}`}}>
              {['Time','Actor','Type','Action','Subject','Workspace','IP'].map(c=>(
                <th key={c} style={{padding:'10px 14px',textAlign:'left',fontSize:11,color:T.sec,fontWeight:500,textTransform:'uppercase',letterSpacing:'0.06em',whiteSpace:'nowrap'}}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AUDIT_LOG.map((e,i)=>(
              <tr key={e.id} style={{borderBottom:i<AUDIT_LOG.length-1?`0.5px solid ${T.border}`:'none'}}>
                <TD><span style={{fontFamily:'monospace',color:T.muted,fontSize:11}}>{e.ts}</span></TD>
                <TD>
                  <div style={{display:'flex',alignItems:'center',gap:7}}>
                    <Avatar initials={e.actor.slice(0,2).toUpperCase()} color={atypeColor(e.atype)} size={20}/>
                    <span style={{color:T.text,fontWeight:500}}>{e.actor}</span>
                  </div>
                </TD>
                <TD><Pill label={e.atype} color={atypeColor(e.atype)}/></TD>
                <TD><span style={{fontFamily:'monospace',fontSize:11,color:actionColor(e.action)}}>{e.action}</span></TD>
                <TD style={{color:T.sec,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.subject}</TD>
                <TD style={{color:T.muted,fontSize:11}}>{e.ws}</TD>
                <TD style={{fontFamily:'monospace',fontSize:11,color:T.muted}}>{e.ip}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{marginTop:12,fontSize:12,color:T.muted,textAlign:'right'}}>Showing 10 of 14,842 events · <span style={{color:T.blue,cursor:'pointer'}}>Load more</span></div>
    </div>
  );
}

// ── Feature Flags ──────────────────────────────────────────────────────────────
function FlagsView() {
  const toast = useToast();
  const [flags, setFlags] = useState(FLAGS);
  const toggle = id => {
    const f = flags.find(x=>x.id===id);
    const next = !f.enabled;
    setFlags(fs=>fs.map(x=>x.id===id?{...x,enabled:next}:x));
    if(f.key.startsWith('killswitch.')) {
      toast(next?'error':'success', next?`Killswitch activated`:`Killswitch deactivated`, f.key, {duration:5000});
    } else {
      toast(next?'success':'warning', next?'Flag enabled':'Flag disabled', f.key);
    }
  };
  const envColor = e => ({all:T.green,production:T.red,staging:T.amber,development:T.blue}[e]||T.muted);

  const groups = {feature:flags.filter(f=>f.key.startsWith('feature.')), experiment:flags.filter(f=>f.key.startsWith('experiment.')), killswitch:flags.filter(f=>f.key.startsWith('killswitch.'))};

  return (
    <div style={{padding:'28px 30px',maxWidth:880}}>
      <SysHeader title="Feature Flags" sub="Runtime toggles. Changes take effect immediately — no redeploy required.">
        <button style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New Flag</button>
      </SysHeader>

      {Object.entries(groups).map(([group,gflags])=>(
        <div key={group} style={{marginBottom:24}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
            <span style={{fontSize:11,color:T.muted,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:500}}>{group}</span>
            <div style={{flex:1,height:'0.5px',background:T.border}}/>
            <span style={{fontSize:11,color:T.muted}}>{gflags.length}</span>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {gflags.map(f=>(
              <div key={f.id} style={{background:T.card,border:`0.5px solid ${f.enabled?T.green+'33':T.border}`,borderRadius:8,padding:'14px 18px',display:'flex',alignItems:'center',gap:14}}>
                {/* Toggle */}
                <div onClick={()=>toggle(f.id)} style={{width:36,height:20,borderRadius:10,background:f.enabled?T.green:T.elevated,border:`0.5px solid ${f.enabled?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
                  <div style={{position:'absolute',top:2,left:f.enabled?18:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <span style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:'monospace'}}>{f.key}</span>
                    <Pill label={f.env} color={envColor(f.env)}/>
                    {group==='killswitch'&&<Pill label="killswitch" color={T.red}/>}
                  </div>
                  <div style={{fontSize:12,color:T.sec}}>{f.desc}</div>
                </div>
                <div style={{flexShrink:0,textAlign:'right'}}>
                  <div style={{fontSize:12,fontWeight:600,color:f.enabled?T.green:T.muted}}>{f.enabled?'enabled':'disabled'}</div>
                  <div style={{fontSize:11,color:T.muted,marginTop:2}}>since {f.created}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Hub Settings ───────────────────────────────────────────────────────────────
function HubSettingsView() {
  const toast = useToast();
  const [tab, setTab] = useState('general');
  const tabs = ['general','auth','smtp','secrets','danger'];

  return (
    <div style={{padding:'28px 30px',maxWidth:760}}>
      <SysHeader title="Hub Settings" sub="Global configuration for this Platform Hub instance"/>

      <div style={{display:'flex',gap:2,marginBottom:24,borderBottom:`0.5px solid ${T.border}`,paddingBottom:0}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 16px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1}}>
            {t.charAt(0).toUpperCase()+t.slice(1)}
          </button>
        ))}
      </div>

      {tab==='general'&&(
        <div>
          <Card style={{marginBottom:16}}>
            <SecHead title="Instance"/>
            <Input label="Hub name" value="Platform Hub" onChange={()=>{}} hint="Displayed in the browser tab and emails"/>
            <Input label="Base URL" value="https://hub.acme.com" onChange={()=>{}} mono hint="Used for webhooks, agent callback URLs, and email links"/>
            <Input label="Admin email" value="ops@acme.com" onChange={()=>{}} hint="Receives system alerts and critical notifications"/>
          </Card>
          <Card>
            <SecHead title="Defaults"/>
            <div style={{marginBottom:16}}>
              <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Default workspace plan</label>
              <select style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:13,color:T.text,outline:'none',width:'100%'}}>
                <option>starter</option><option>team</option><option>enterprise</option>
              </select>
            </div>
            <Input label="Agent heartbeat timeout (seconds)" value="120" onChange={()=>{}} type="number" hint="Servers become 'unreachable' after this interval without a heartbeat"/>
          </Card>
        </div>
      )}

      {tab==='auth'&&(
        <Card>
          <SecHead title="Authentication"/>
          <Input label="Auth secret" value="••••••••••••••••••••••••••••••••" onChange={()=>{}} type="password" mono hint="64-char random string. Rotating this invalidates all existing sessions."/>
          <Input label="Session TTL (hours)" value="168" onChange={()=>{}} type="number" hint="How long a session token stays valid. Default: 7 days (168h)"/>
          <Input label="Agent secret" value="••••••••••••••••••••" onChange={()=>{}} type="password" mono hint="Shared HMAC secret between Hub and all hub-agent instances"/>
          <div style={{display:'flex',gap:12,marginTop:8}}>
            {['Require 2FA for owners','Allow API key auth','Allow bot user creation'].map(label=>(
              <label key={label} style={{display:'flex',alignItems:'center',gap:7,fontSize:12,color:T.sec,cursor:'pointer'}}>
                <input type="checkbox" defaultChecked style={{accentColor:T.blue}}/>{label}
              </label>
            ))}
          </div>
        </Card>
      )}

      {tab==='smtp'&&(
        <Card>
          <SecHead title="Outbound Email (Resend)"/>
          <Input label="Resend API key" value="re_••••••••••••••••••••••••" onChange={()=>{}} type="password" mono hint="Used for transactional email — deployment notifications, invites, alerts"/>
          <Input label="From address" value="hub@acme.com" onChange={()=>{}}/>
          <Input label="From name" value="Platform Hub" onChange={()=>{}}/>
          <button style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 16px',color:'#fff',fontSize:13,fontWeight:500,cursor:'pointer'}}>Send test email</button>
        </Card>
      )}

      {tab==='secrets'&&(
        <Card>
          <SecHead title="Secrets backend"/>
          <div style={{marginBottom:16,background:`${T.blue}10`,border:`0.5px solid ${T.blue}33`,borderRadius:6,padding:'12px 14px',fontSize:12,color:T.sec}}>
            Secrets are fetched through the <strong style={{color:T.text}}>ISecrets</strong> adapter. Configure the backend below — the adapter interface stays constant regardless of which backend you use.
          </div>
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Backend</label>
            <select style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:13,color:T.text,outline:'none',width:'100%'}}>
              <option>Infisical (connected)</option><option>HashiCorp Vault</option><option>SQLite (encrypted)</option><option>Environment variables</option>
            </select>
          </div>
          <Input label="Infisical URL" value="http://infisical:8080" onChange={()=>{}} mono/>
          <Input label="Infisical token" value="st.••••••••••••••••" onChange={()=>{}} type="password" mono/>
        </Card>
      )}

      {tab==='danger'&&(
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          {[
            {label:'Flush event bus queue',     desc:'Discards all pending in-process events. Running deployments may stall.',  btn:'Flush queue',  color:T.amber},
            {label:'Invalidate all sessions',   desc:'Logs out every user immediately. They must re-authenticate.',            btn:'Invalidate',   color:T.amber},
            {label:'Rebuild search index',      desc:'Re-indexes all projects, servers, and deployments in Typesense.',        btn:'Rebuild index',color:T.amber},
            {label:'Delete all audit logs',     desc:'Permanently removes all audit records. This cannot be undone.',          btn:'Delete logs',  color:T.red},
            {label:'Wipe Hub database',         desc:'Destroys all data. The Hub process will exit. Use with extreme caution.',btn:'Wipe database',color:T.red},
          ].map(a=>(
            <div key={a.label} style={{background:T.card,border:`0.5px solid ${a.color==='red'?T.red+'44':T.border}`,borderRadius:8,padding:'16px 20px',display:'flex',alignItems:'center',gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:3}}>{a.label}</div>
                <div style={{fontSize:12,color:T.sec}}>{a.desc}</div>
              </div>
              <button style={{fontSize:12,padding:'7px 14px',borderRadius:5,border:`0.5px solid ${a.color}44`,background:`${a.color}11`,color:a.color,cursor:'pointer',fontWeight:500,flexShrink:0}}>{a.btn}</button>
            </div>
          ))}
        </div>
      )}

      {tab!=='danger'&&(
        <div style={{marginTop:20,display:'flex',gap:10}}>
          <button onClick={()=>toast.success('Settings saved','Changes will take effect immediately — no restart required.')} style={{background:T.blue,border:'none',borderRadius:6,padding:'9px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Save changes</button>
          <button onClick={()=>toast.info('Changes discarded','Settings reverted to last saved state.')} style={{background:'none',border:`0.5px solid ${T.border}`,borderRadius:6,padding:'9px 16px',color:T.sec,fontSize:13,cursor:'pointer'}}>Discard</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVISION WIZARD
// ═══════════════════════════════════════════════════════════════════════════════

function WizardSteps({steps,current}) {
  return (
    <div style={{display:'flex',alignItems:'center',marginBottom:28}}>
      {steps.map((s,i)=>{
        const done=i<current, active=i===current;
        return (
          <div key={i} style={{display:'flex',alignItems:'center',flex:i<steps.length-1?1:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
              <div style={{width:24,height:24,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:600,flexShrink:0,background:done?T.green:active?T.blue:T.elevated,color:done||active?'#fff':T.muted,border:`1.5px solid ${done?T.green:active?T.blue:T.border}`}}>
                {done?'✓':i+1}
              </div>
              <span style={{fontSize:12,color:active?T.text:done?T.sec:T.muted,fontWeight:active?500:400,whiteSpace:'nowrap'}}>{s}</span>
            </div>
            {i<steps.length-1&&<div style={{flex:1,height:1,background:done?T.green:T.border,margin:'0 12px'}}/>}
          </div>
        );
      })}
    </div>
  );
}

function ProvisionProgress({serverName,onDone}) {
  const [stepIdx,setStepIdx]=useState(0);
  const [done,setDone]=useState(false);
  const [logs,setLogs]=useState([{ts:'00:00',type:'muted',text:`→ Provisioning ${serverName}…`}]);
  const ref=useRef(null);
  const addLog=useCallback((text,type='normal')=>{
    const now=new Date(), ts=`${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    setLogs(l=>[...l,{ts,type,text}]);
  },[]);
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[logs]);
  useEffect(()=>{
    if(done)return;
    const step=PROVISION_STEPS[stepIdx];
    if(!step){setDone(true);addLog('✓ Server provisioned and online','ok');return;}
    addLog(step.label+'…');
    const t=setTimeout(()=>{addLog('✓ '+step.label,'ok');setStepIdx(i=>i+1);},step.ms);
    return()=>clearTimeout(t);
  },[stepIdx,done,addLog]);
  useEffect(()=>{if(done){const t=setTimeout(onDone,800);return()=>clearTimeout(t);}},[done,onDone]);
  const pct=Math.round((stepIdx/PROVISION_STEPS.length)*100);
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
        <span style={{fontSize:12,color:T.sec}}>{done?'Complete':PROVISION_STEPS[stepIdx]?.label}</span>
        <span style={{fontSize:12,color:done?T.green:T.blue,fontWeight:500}}>{done?'100%':pct+'%'}</span>
      </div>
      <div style={{height:3,background:T.elevated,borderRadius:2,marginBottom:20}}>
        <div style={{height:'100%',width:(done?100:pct)+'%',background:done?T.green:T.blue,borderRadius:2,transition:'width 0.4s ease'}}/>
      </div>
      <div style={{marginBottom:14,display:'flex',flexDirection:'column',gap:5}}>
        {PROVISION_STEPS.map((s,i)=>{
          const sd=i<stepIdx||done, active=i===stepIdx&&!done;
          return (
            <div key={i} style={{display:'flex',alignItems:'center',gap:10,opacity:i>stepIdx&&!done?0.3:1}}>
              <div style={{width:16,height:16,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,flexShrink:0,background:sd?`${T.green}22`:active?`${T.blue}22`:T.elevated,border:`1px solid ${sd?T.green:active?T.blue:T.border}`,color:sd?T.green:active?T.blue:T.muted}}>
                {sd?'✓':active?'◌':'·'}
              </div>
              <span style={{fontSize:12,color:sd?T.sec:active?T.text:T.muted}}>{s.label}</span>
            </div>
          );
        })}
      </div>
      <div ref={ref} style={{background:T.elevated,borderRadius:6,padding:'10px 14px',fontFamily:'monospace',fontSize:11,lineHeight:'19px',maxHeight:160,overflowY:'auto',border:`0.5px solid ${T.border}`}}>
        {logs.map((l,i)=>(
          <div key={i} style={{color:l.type==='ok'?T.green:l.type==='muted'?T.muted:T.sec}}>
            <span style={{color:T.muted,marginRight:10}}>{l.ts}</span>{l.text}
          </div>
        ))}
        {!done&&<span style={{display:'inline-block',width:6,height:12,background:T.blue,verticalAlign:'text-bottom',animation:'blink 1s step-end infinite'}}/>}
      </div>
    </div>
  );
}

const PROVIDERS=[
  {id:'digitalocean',name:'DigitalOcean',avail:true, desc:'Droplets · Managed DBs · Spaces'},
  {id:'hetzner',     name:'Hetzner',     avail:false,desc:'Coming soon'},
  {id:'vultr',       name:'Vultr',       avail:false,desc:'Coming soon'},
  {id:'custom',      name:'Custom / SSH',avail:true, desc:'Import any server via SSH'},
];

function ProvisionServerView({ nav }) {
  const toast = useToast();
  const [step,setStep]     = useState(0);
  const [provider,setProvider] = useState('digitalocean');
  // Pre-filled test token — starts with dop_v1_ so validation passes immediately
  const [apiToken, setApiToken] = useState('')
  const [tokenError,setTokErr] = useState('');
  const [validating,setValid]  = useState(false);
  const [cfg,setCfg] = useState({name:'',region:'nyc3',plan:'s-2vcpu-4gb',image:'ubuntu-24-04-x64',role:'general',sshKeyIds:['sk1']});
  const [showRole,    setShowRole]    = useState(false);
  const [showRegions, setShowRegions] = useState(false);
  const [showPlans,   setShowPlans]   = useState(false);
  const [showImages,  setShowImages]  = useState(false);
  const RECENT_NAMES = ['prod-web-03','prod-worker-02','stg-app-02','build-runner-02','prod-db-02'];
    const NA_REGIONS   = DO_REGIONS.filter(r=>['nyc3','sfo3','tor1'].includes(r.slug));
    const MORE_REGIONS = DO_REGIONS.filter(r=>!['nyc3','sfo3','tor1'].includes(r.slug));
    const FEATURED_PLANS = [
      DO_PLANS.find(p=>p.slug==='s-1vcpu-2gb'),
      DO_PLANS.find(p=>p.slug==='s-2vcpu-4gb'),
      DO_PLANS.find(p=>p.slug==='s-4vcpu-8gb'),
    ].filter(Boolean);
    const MORE_PLANS   = DO_PLANS.filter(p=>!FEATURED_PLANS.includes(p));
    const PRIMARY_IMAGE= DO_IMAGES.find(i=>i.slug==='ubuntu-24-04-x64');
    const MORE_IMAGES  = DO_IMAGES.filter(i=>i.slug!=='ubuntu-24-04-x64');
  const set = (k,v) => setCfg(c=>({...c,[k]:v}));
  const selRegion = DO_REGIONS.find(r=>r.slug===cfg.region);
  const selPlan   = DO_PLANS.find(p=>p.slug===cfg.plan);
  const selImage  = DO_IMAGES.find(i=>i.slug===cfg.image);

  const validateToken = () => {
    if (!apiToken.trim()) { setTokErr('API token is required'); return; }
    if (!apiToken.startsWith('dop_v1_')) { setTokErr('Token must start with dop_v1_'); return; }
    setValid(true);
    setTimeout(()=>{ setValid(false); setTokErr(''); setStep(2); }, 800);
  };

  const onDone = () => {
    toast.success('Server provisioned', `${cfg.name} is online and reporting heartbeats.`, {
      action:{ label:'View fleet →', fn:()=>nav('servers') }
    });
    nav('servers');
  };

  // Auth config per provider
  const PROVIDER_AUTH = {
    digitalocean: {
      label: 'Personal Access Token',
      hint: 'Stored encrypted via Infisical. Never logged.',
      tip: 'Create a dedicated token scoped to droplet:create read delete.',
      link: 'https://cloud.digitalocean.com/account/api/tokens',
      linkLabel: 'Generate ↗',
      validate: v => v.startsWith('dop_v1_') ? null : 'Token must start with dop_v1_',
    },
    hetzner: {
      label: 'API Token',
      hint: 'Found in Hetzner Cloud Console → Security → API Tokens.',
      tip: 'Create a Read & Write token scoped to the target project.',
      link: 'https://console.hetzner.cloud',
      linkLabel: 'Open console ↗',
      validate: v => v.length > 10 ? null : 'Enter a valid Hetzner API token',
    },
    vultr: {
      label: 'Personal Access Token',
      hint: 'Found in Vultr Account → API.',
      tip: 'Enable the "Manage Servers" permission on the token.',
      link: 'https://my.vultr.com/settings/#settingsapi',
      linkLabel: 'Open settings ↗',
      validate: v => v.length > 10 ? null : 'Enter a valid Vultr API token',
    },
    custom: {
      label: null, // no auth needed
    },
  };

  const STEP_LABELS = ['Connect provider','Configure','Review','Provisioning…','Online'];

  return (
    <div style={{flex:1,display:'flex',flexDirection:'column',background:T.bg,minHeight:0}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>

      {/* Page header */}
      <div style={{padding:'24px 30px 0',flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:6}}>
          <button onClick={()=>nav('servers')} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,fontSize:13,padding:0}}>← Servers</button>
          <span style={{color:T.muted}}>/</span>
          <span style={{fontSize:13,color:T.sec}}>Provision new server</span>
        </div>
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
          <div>
            <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>
              {step < 4 ? 'Provision New Server' : step===4 ? 'Provisioning…' : `${cfg.name} is online`}
            </h2>
            <p style={{margin:'5px 0 0',fontSize:13,color:T.sec}}>{STEP_LABELS[step]}</p>
          </div>
          {step < 4 && (
            <div style={{flexShrink:0,paddingTop:4}}>
              <WizardSteps steps={['Connect','Configure','Review','Provision']} current={step}/>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content area */}
      <div style={{flex:1,overflowY:'auto',padding:'0 30px 30px'}}>
        <div style={{maxWidth:680}}>

          {/* ── Step 0: Provider + Auth combined ── */}
          {step===0 && (
            <div>
              <p style={{fontSize:13,color:T.sec,marginTop:0,marginBottom:18}}>
                Platform Hub handles the full lifecycle — provisioning, hub-agent install, heartbeat registration, and deployment routing.
              </p>

              {/* Provider picker */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:20}}>
                {PROVIDERS.map(p=>{
                  const sel = provider===p.id;
                  return (
                    <button key={p.id} onClick={()=>p.avail&&setProvider(p.id)}
                      style={{background:sel?`${T.blue}15`:T.card,border:`1.5px solid ${sel?T.blue:T.border}`,borderRadius:9,padding:'14px 16px',cursor:p.avail?'pointer':'default',textAlign:'left',opacity:p.avail?1:0.4,display:'flex',gap:12,alignItems:'center'}}>
                      <div style={{width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:T.elevated,flexShrink:0}}>
                        {p.id==='digitalocean'?<DOLogo size={22}/>:<span style={{fontSize:18}}>{p.id==='hetzner'?'🇩🇪':p.id==='vultr'?'💠':'🖥️'}</span>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:sel?T.blue:T.text,marginBottom:2}}>{p.name}</div>
                        <div style={{fontSize:11,color:T.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.desc}</div>
                      </div>
                      {sel&&<div style={{width:16,height:16,borderRadius:'50%',background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,color:'#fff',flexShrink:0}}>✓</div>}
                    </button>
                  );
                })}
              </div>

              {/* Auth section — shown for non-custom providers */}
              {provider !== 'custom' && (() => {
                const auth = PROVIDER_AUTH[provider];
                if (!auth?.label) return null;
                return (
                  <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',marginBottom:18}}>
                    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,paddingBottom:14,borderBottom:`0.5px solid ${T.border}`}}>
                      <div style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:6,background:T.elevated,flexShrink:0}}>
                        {provider==='digitalocean'?<DOLogo size={18}/>:<span style={{fontSize:14}}>{provider==='hetzner'?'🇩🇪':'💠'}</span>}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12,fontWeight:600,color:T.text}}>{PROVIDERS.find(p=>p.id===provider)?.name} — {auth.label}</div>
                        <div style={{fontSize:11,color:T.muted,marginTop:1}}>Read + Write scope required</div>
                      </div>
                      <a href={auth.link} target="_blank" rel="noreferrer" style={{fontSize:11,color:T.blue,textDecoration:'none',flexShrink:0,whiteSpace:'nowrap'}}>{auth.linkLabel}</a>
                    </div>
                    <Input
                      label={auth.label}
                      value={apiToken}
                      onChange={e=>{setApiToken(e.target.value);setTokErr('');}}
                      type="password"
                      mono
                      hint={auth.hint}
                      error={tokenError}
                    />
                    <div style={{background:`${T.amber}10`,border:`0.5px solid ${T.amber}33`,borderRadius:6,padding:'9px 14px',fontSize:11,color:T.amber}}>
                      💡 {auth.tip}
                    </div>
                    <div style={{background:`${T.green}08`,border:`0.5px solid ${T.green}33`,borderRadius:6,padding:'9px 14px',fontSize:11,color:T.green,marginTop:8,display:'flex',alignItems:'center',gap:6}}>
                      🧪 <span><strong>Test mode:</strong> Token prefilled — click Validate &amp; Continue.</span>
                    </div>
                  </div>
                );
              })()}

              {/* CTA */}
              <button
                onClick={()=>{
                  if (provider==='custom') { setStep(1); return; }
                  const auth = PROVIDER_AUTH[provider];
                  const err  = auth?.validate?.(apiToken);
                  if (err) { setTokErr(err); return; }
                  setValid(true);
                  setTimeout(()=>{ setValid(false); setTokErr(''); setStep(1); }, 800);
                }}
                disabled={validating}
                style={{background:T.blue,border:'none',borderRadius:7,padding:'10px 28px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',opacity:validating?0.7:1,display:'flex',alignItems:'center',gap:8}}>
                {validating
                  ? <><span style={{display:'inline-block',width:13,height:13,border:'2px solid #fff',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Validating…</>
                  : (provider==='custom' ? 'Continue →' : 'Validate & Continue →')}
              </button>
            </div>
          )}


          {/* ── Step 1: Configure ── */}
          {step===1 && (
            <div>

              {/* Row 1: Name + OS side by side */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                <div>
                  <Input label="Server name" value={cfg.name} onChange={e=>set('name',e.target.value)} placeholder="prod-web-03" hint="Lowercase, hyphens only."/>
                  <div style={{display:'flex',gap:5,marginTop:5,flexWrap:'wrap'}}>
                    <span style={{fontSize:10,color:T.muted,alignSelf:'center'}}>Recent:</span>
                    {RECENT_NAMES.map(n=>(
                      <button key={n} onClick={()=>set('name',n)} style={{fontSize:10,padding:'2px 7px',borderRadius:3,border:`0.5px solid ${cfg.name===n?T.blue:T.border}`,background:cfg.name===n?`${T.blue}12`:T.elevated,color:cfg.name===n?T.blue:T.muted,cursor:'pointer',fontFamily:'monospace'}}>{n}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>OS image</label>
                  {PRIMARY_IMAGE && (
                    <button onClick={()=>set('image',PRIMARY_IMAGE.slug)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,background:cfg.image===PRIMARY_IMAGE.slug?`${T.blue}15`:T.card,border:`1px solid ${cfg.image===PRIMARY_IMAGE.slug?T.blue:T.green+'44'}`,borderRadius:7,padding:'9px 12px',cursor:'pointer',textAlign:'left',boxSizing:'border-box',marginBottom:5}}>
                      <span style={{fontSize:18}}>🐧</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:2}}>
                          <span style={{fontSize:12,fontWeight:600,color:cfg.image===PRIMARY_IMAGE.slug?T.blue:T.text}}>Ubuntu 24.04 LTS</span>
                          <span style={{fontSize:9,padding:'1px 5px',borderRadius:3,background:`${T.green}15`,color:T.green,border:`0.5px solid ${T.green}33`}}>recommended</span>
                        </div>
                        <div style={{fontSize:10,color:T.muted}}>Latest LTS · kernel 6.8</div>
                      </div>
                      {cfg.image===PRIMARY_IMAGE.slug&&<span style={{fontSize:12,color:T.blue,flexShrink:0}}>✓</span>}
                    </button>
                  )}
                  {showImages && (
                    <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:5}}>
                      {MORE_IMAGES.map(img=>{
                        const sel=cfg.image===img.slug;
                        return (
                          <button key={img.slug} onClick={()=>set('image',img.slug)} style={{display:'flex',alignItems:'center',gap:8,background:sel?`${T.blue}12`:T.elevated,border:`1px solid ${sel?T.blue:T.border}`,borderRadius:6,padding:'7px 10px',cursor:'pointer',textAlign:'left'}}>
                            <span style={{fontSize:14}}>{img.icon}</span>
                            <span style={{fontSize:11,color:sel?T.text:T.sec,fontWeight:sel?500:400}}>{img.name}</span>
                            {sel&&<span style={{fontSize:11,color:T.blue,marginLeft:'auto'}}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <button onClick={()=>setShowImages(v=>!v)} style={{fontSize:10,padding:'2px 8px',borderRadius:3,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer'}}>{showImages?'▲ less':'··· more'}</button>
                </div>
              </div>

              {/* Row 2: Region + Role side by side */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
                {/* Region */}
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Region</label>
                  <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:4}}>
                    {NA_REGIONS.map(r=>{
                      const sel=cfg.region===r.slug;
                      return (
                        <button key={r.slug} onClick={()=>set('region',r.slug)} style={{display:'flex',alignItems:'center',gap:8,background:sel?`${T.blue}15`:T.card,border:`1px solid ${sel?T.blue:T.border}`,borderRadius:6,padding:'7px 10px',cursor:'pointer',textAlign:'left'}}>
                          <span style={{fontSize:16}}>{r.flag}</span>
                          <div style={{flex:1}}>
                            <div style={{fontSize:11,color:sel?T.text:T.sec,fontWeight:sel?600:400}}>{r.area}</div>
                            <div style={{fontSize:10,color:T.muted,fontFamily:'monospace'}}>{r.slug}</div>
                          </div>
                          {sel&&<span style={{fontSize:11,color:T.blue,flexShrink:0}}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                  {showRegions && (
                    <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:4}}>
                      {MORE_REGIONS.map(r=>{
                        const sel=cfg.region===r.slug;
                        return (
                          <button key={r.slug} onClick={()=>set('region',r.slug)} style={{display:'flex',alignItems:'center',gap:8,background:sel?`${T.blue}15`:T.elevated,border:`1px solid ${sel?T.blue:T.border}`,borderRadius:6,padding:'7px 10px',cursor:'pointer',textAlign:'left'}}>
                            <span style={{fontSize:16}}>{r.flag}</span>
                            <div style={{flex:1}}>
                              <div style={{fontSize:11,color:sel?T.text:T.sec,fontWeight:sel?600:400}}>{r.area}</div>
                              <div style={{fontSize:10,color:T.muted,fontFamily:'monospace'}}>{r.slug}</div>
                            </div>
                            {sel&&<span style={{fontSize:11,color:T.blue,flexShrink:0}}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <button onClick={()=>setShowRegions(v=>!v)} style={{fontSize:10,padding:'2px 8px',borderRadius:3,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer'}}>{showRegions?'▲ less':'··· more regions'}</button>
                </div>

                {/* Role */}
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Role</label>
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    {SERVER_ROLES.map(r=>{
                      const sel=cfg.role===r;
                      return (
                        <button key={r} onClick={()=>set('role',r)} style={{display:'flex',alignItems:'center',gap:8,background:sel?`${rColor(r)}12`:T.card,border:`1px solid ${sel?rColor(r):T.border}`,borderRadius:6,padding:'7px 10px',cursor:'pointer',textAlign:'left'}}>
                          <div style={{width:8,height:8,borderRadius:'50%',background:sel?rColor(r):T.border,flexShrink:0}}/>
                          <span style={{fontSize:12,color:sel?rColor(r):T.sec,fontWeight:sel?600:400,textTransform:'capitalize'}}>{r}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Droplet plan — compact line items */}
              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Droplet plan</label>
                <div style={{display:'flex',flexDirection:'column',gap:3,marginBottom:5}}>
                  {FEATURED_PLANS.map((p,i)=>{
                    const sel=cfg.plan===p.slug;
                    const tier=i===0?'Starter':i===1?'Recommended':'Pro';
                    const tc=i===0?T.muted:i===1?T.green:T.blue;
                    return (
                      <button key={p.slug} onClick={()=>set('plan',p.slug)} style={{display:'flex',alignItems:'center',gap:10,background:sel?`${T.blue}12`:T.card,border:`1px solid ${sel?T.blue:i===1&&!sel?T.green+'44':T.border}`,borderRadius:7,padding:'9px 14px',cursor:'pointer',textAlign:'left'}}>
                        <div style={{width:14,height:14,borderRadius:'50%',border:`1.5px solid ${sel?T.blue:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          {sel&&<div style={{width:6,height:6,borderRadius:'50%',background:T.blue}}/>}
                        </div>
                        <span style={{fontSize:10,fontWeight:600,color:sel?T.blue:tc,textTransform:'uppercase',letterSpacing:'0.06em',width:76}}>{tier}</span>
                        <span style={{fontSize:12,fontWeight:500,color:T.text,width:44}}>{p.vcpu} vCPU</span>
                        <span style={{fontSize:12,color:T.sec,width:44}}>{p.mem}</span>
                        <span style={{fontSize:11,color:T.muted,flex:1}}>{p.disk}</span>
                        <span style={{fontSize:13,fontWeight:700,color:sel?T.blue:T.text}}>${p.price}<span style={{fontSize:10,color:T.muted,fontWeight:400}}>/mo</span></span>
                      </button>
                    );
                  })}
                </div>
                {showPlans && (
                  <div style={{display:'flex',flexDirection:'column',gap:3,marginBottom:5}}>
                    {MORE_PLANS.map(p=>{
                      const sel=cfg.plan===p.slug;
                      return (
                        <button key={p.slug} onClick={()=>set('plan',p.slug)} style={{display:'flex',alignItems:'center',gap:10,background:sel?`${T.blue}12`:T.elevated,border:`1px solid ${sel?T.blue:T.border}`,borderRadius:7,padding:'8px 14px',cursor:'pointer',textAlign:'left'}}>
                          <div style={{width:14,height:14,borderRadius:'50%',border:`1.5px solid ${sel?T.blue:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                            {sel&&<div style={{width:6,height:6,borderRadius:'50%',background:T.blue}}/>}
                          </div>
                          <span style={{fontSize:10,color:T.muted,width:76}}>{p.name}</span>
                          <span style={{fontSize:12,fontWeight:500,color:T.text,width:44}}>{p.vcpu} vCPU</span>
                          <span style={{fontSize:12,color:T.sec,width:44}}>{p.mem}</span>
                          <span style={{fontSize:11,color:T.muted,flex:1}}>{p.disk}</span>
                          <span style={{fontSize:13,fontWeight:700,color:sel?T.blue:T.text}}>${p.price}<span style={{fontSize:10,color:T.muted,fontWeight:400}}>/mo</span></span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button onClick={()=>setShowPlans(v=>!v)} style={{fontSize:10,padding:'2px 8px',borderRadius:3,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer'}}>{showPlans?'▲ less':'··· more plans'}</button>
              </div>

              {/* SSH keys — scrollable after 3 */}
              <div style={{marginBottom:20}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>SSH keys</label>
                <div style={{display:'flex',flexDirection:'column',gap:4,maxHeight:SSH_KEYS.length>3?168:undefined,overflowY:SSH_KEYS.length>3?'auto':'visible',paddingRight:SSH_KEYS.length>3?4:0}}>
                  {SSH_KEYS.map(k=>{
                    const checked=cfg.sshKeyIds.includes(k.id);
                    const algoC=({ed25519:T.green,rsa:T.blue,ecdsa:T.cyan}[k.algo]||T.muted);
                    return (
                      <button key={k.id} onClick={()=>set('sshKeyIds',checked?cfg.sshKeyIds.filter(x=>x!==k.id):[...cfg.sshKeyIds,k.id])} style={{display:'flex',alignItems:'center',gap:8,background:checked?`${T.blue}10`:T.card,border:`1px solid ${checked?T.blue:T.border}`,borderRadius:6,padding:'8px 12px',cursor:'pointer',textAlign:'left',flexShrink:0}}>
                        <div style={{width:14,height:14,borderRadius:3,border:`1.5px solid ${checked?T.blue:T.border}`,background:checked?T.blue:'none',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          {checked&&<span style={{fontSize:8,color:'#fff',fontWeight:700}}>✓</span>}
                        </div>
                        <span style={{fontSize:12,fontWeight:500,color:T.text,flex:1}}>{k.name}</span>
                        <span style={{fontSize:9,padding:'1px 6px',borderRadius:3,background:`${algoC}15`,color:algoC,border:`0.5px solid ${algoC}33`,fontFamily:'monospace'}}>{k.algo}{k.bits?'-'+k.bits:''}</span>
                        <span style={{fontSize:10,color:T.muted,fontFamily:'monospace',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{k.fingerprint.slice(0,22)}…</span>
                      </button>
                    );
                  })}
                </div>
                {cfg.sshKeyIds.length===0&&<div style={{fontSize:11,color:T.amber,marginTop:5}}>⚠ No keys selected — you won't be able to SSH in</div>}
              </div>

              <div style={{display:'flex',gap:10}}>
                <button onClick={()=>setStep(0)} style={{background:'none',border:`0.5px solid ${T.border}`,borderRadius:7,padding:'9px 20px',color:T.sec,fontSize:13,cursor:'pointer'}}>← Back</button>
                <button onClick={()=>setStep(2)} disabled={cfg.name.length<2} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 24px',color:'#fff',fontSize:13,fontWeight:600,cursor:cfg.name.length>=2?'pointer':'not-allowed',opacity:cfg.name.length>=2?1:0.4}}>Review →</button>
              </div>
            </div>
          )}

          {/* ── Step 2: Review ── */}
          {step===2 && (
            <div>
              <div style={{background:T.card,borderRadius:10,padding:'20px 22px',marginBottom:16,border:`0.5px solid ${T.border}`}}>
                <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:18,paddingBottom:16,borderBottom:`0.5px solid ${T.border}`}}>
                  <DOLogo size={24}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:16,fontWeight:700,color:T.text}}>{cfg.name}</div>
                    <div style={{fontSize:12,color:T.sec,marginTop:2}}>DigitalOcean Droplet</div>
                  </div>
                  <Pill label={cfg.role} color={rColor(cfg.role)}/>
                </div>
                {[
                  ['Region',      `${selRegion?.flag} ${selRegion?.name} (${cfg.region})`],
                  ['Plan',        `${selPlan?.vcpu} vCPU · ${selPlan?.mem} · ${selPlan?.disk}`],
                  ['OS',          `${selImage?.icon} ${selImage?.name}`],
                  ['SSH keys',    cfg.sshKeyIds.length>0?SSH_KEYS.filter(k=>cfg.sshKeyIds.includes(k.id)).map(k=>k.name).join(', '):'⚠ none selected'],
                  ['Monthly cost',`$${selPlan?.price}/mo`],
                  ['Agent',       'hub-agent latest (auto-installed)'],
                  ['Heartbeat',   '30s interval'],
                ].map(([k,v])=>(
                  <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:`0.5px solid ${T.border}`}}>
                    <span style={{fontSize:12,color:T.sec}}>{k}</span>
                    <span style={{fontSize:12,color:T.text,fontWeight:500}}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:7,padding:'12px 16px',fontSize:12,color:T.sec,marginBottom:24}}>
                Clicking <strong style={{color:T.text}}>Provision Server</strong> will create a Droplet, install hub-agent, and register the server. Takes about 60–90 seconds.
              </div>
              <div style={{display:'flex',gap:10}}>
                <button onClick={()=>setStep(1)} style={{background:'none',border:`0.5px solid ${T.border}`,borderRadius:7,padding:'9px 20px',color:T.sec,fontSize:13,cursor:'pointer'}}>← Back</button>
                <button onClick={()=>setStep(3)} style={{background:T.green,border:'none',borderRadius:7,padding:'9px 28px',color:'#111',fontSize:14,fontWeight:700,cursor:'pointer'}}>⚡ Provision Server</button>
              </div>
            </div>
          )}

          {/* ── Step 3: Provisioning progress ── */}
          {step===3 && (
<ProvisionProgress serverName={cfg.name} onDone={()=>setStep(4)}/>
          )}

          {/* ── Step 4: Done ── */}
          {step===4 && (
            <div style={{textAlign:'center',padding:'32px 0 16px'}}>
              <div style={{width:64,height:64,borderRadius:'50%',background:`${T.green}18`,border:`2px solid ${T.green}`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px',fontSize:30}}>✓</div>
              <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:8,letterSpacing:'-0.02em'}}>{cfg.name} is online</div>
              <div style={{fontSize:13,color:T.sec,marginBottom:28}}>{selRegion?.flag} {selRegion?.name} · {selPlan?.vcpu} vCPU · {selPlan?.mem} · {selImage?.name}</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,textAlign:'left',maxWidth:380,margin:'0 auto 32px'}}>
                {[{l:'Status',v:'Online',c:T.green},{l:'Agent',v:'v1.2.4',c:T.text},{l:'Heartbeat',v:'just now',c:T.text}].map(s=>(
                  <div key={s.l} style={{background:T.card,borderRadius:8,padding:'12px 14px',border:`0.5px solid ${T.border}`}}>
                    <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:5}}>{s.l}</div>
                    <div style={{fontSize:14,fontWeight:600,color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'flex',gap:10,justifyContent:'center'}}>
                <button onClick={()=>{ setStep(0); setProvider('digitalocean'); setCfg({name:'',region:'nyc3',plan:'s-2vcpu-4gb',image:'ubuntu-24-04-x64',role:'general',sshKeyIds:['sk1']}); }} style={{background:'none',border:`0.5px solid ${T.border}`,borderRadius:7,padding:'9px 20px',color:T.sec,fontSize:13,cursor:'pointer'}}>Provision another</button>
                <button onClick={onDone} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 24px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>View in Fleet →</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND PALETTE
// ═══════════════════════════════════════════════════════════════════════════════

function buildCommands(nav) {
  return [
    {id:'nav-bc', group:'Navigate',icon:'⊞',label:'Go to Basecamp',     kbd:'G B',action:()=>nav('basecamp')},
    {id:'nav-srv',group:'Navigate',icon:'▣',label:'Go to Servers',       kbd:'G S',action:()=>nav('servers')},
    {id:'nav-prj',group:'Navigate',icon:'◫',label:'Go to Projects',      kbd:'G P',action:()=>nav('projects')},
    {id:'nav-dep',group:'Navigate',icon:'⇥',label:'Go to Deployments',   kbd:'G D',action:()=>nav('deployments')},
    {id:'nav-job',group:'Navigate',icon:'⚡',label:'Go to Jobs',          kbd:'G J',action:()=>nav('jobs')},
    {id:'nav-net',group:'Navigate',icon:'⬡',label:'Go to Networking',    kbd:'G N',action:()=>nav('networking')},
    {id:'nav-prt',group:'Navigate',icon:'⬡',label:'Go to Portal',        kbd:'G R',action:()=>nav('portal')},
    {id:'nav-reg',group:'Navigate',icon:'📦',label:'Go to Registry',      kbd:'G I',action:()=>nav('registry')},
    {id:'nav-vol',group:'Navigate',icon:'💾',label:'Go to Volumes',        kbd:'G V',action:()=>nav('volumes')},
    {id:'nav-dsk',group:'Navigate',icon:'🗑',label:'Go to Disk Cleanup',   kbd:'G K',action:()=>nav('disk-cleanup')},
    {id:'nav-bp', group:'Navigate',icon:'🧩',label:'App Blueprints',        kbd:'G B',action:()=>nav('blueprints')},
    {id:'nav-mem',group:'Navigate',icon:'👥',label:'Go to Members',       kbd:'G M',action:()=>nav('members')},
    {id:'nav-act',group:'Navigate',icon:'◎',label:'Go to Activity',       kbd:'G A',action:()=>nav('activity')},
    {id:'nav-dash',group:'Navigate',icon:'📊',label:'Go to Dashboards',  kbd:'G D',action:()=>nav('dashboards')},
    {id:'nav-usr', group:'Navigate',icon:'👤',label:'Account settings',    kbd:'G U',action:()=>nav('user-settings')},
    {id:'nav-grp',group:'Navigate',icon:'◈',label:'Go to Infra Graph',   kbd:'G G',action:()=>nav('infra-graph')},
    {id:'nav-obs',group:'Navigate',icon:'◈',label:'Go to Observability', kbd:'G O',action:()=>nav('observability')},
    // Sysadmin
    {id:'sys-ov', group:'System Admin',icon:'⬡',label:'Hub Overview',              action:()=>nav('sys-overview')},
    {id:'sys-ws', group:'System Admin',icon:'◫',label:'Manage workspaces',         action:()=>nav('sys-workspaces')},
    {id:'sys-usr',group:'System Admin',icon:'▣',label:'Manage users & bots',       action:()=>nav('sys-users')},
    {id:'sys-adp',group:'System Admin',icon:'🔌',label:'Configure adapters',       action:()=>nav('sys-adapters')},
    {id:'sys-aud',group:'System Admin',icon:'📋',label:'View audit log',           action:()=>nav('sys-audit')},
    {id:'sys-flg',group:'System Admin',icon:'🚩',label:'Feature flags',            action:()=>nav('sys-flags')},
    {id:'sys-cfg',group:'System Admin',icon:'⚙', label:'Hub settings',            action:()=>nav('sys-settings')},
    // Servers
    {id:'srv-new',group:'Servers',icon:'＋',label:'Provision new server',badge:'New',action:()=>nav('provision')},
    ...SERVERS.map(s=>({id:'srv-'+s.id,group:'Servers',icon:'▣',label:`Open ${s.name}`,sub:s.status,color:sColor(s.status),action:()=>nav('servers')})),
    {id:'dep-new',group:'Deployments',icon:'🚀',label:'Trigger deploy…',action:()=>nav('deployments')},
    ...DEPLOYMENTS.map(d=>({id:'dep-'+d.id,group:'Deployments',icon:'⇥',label:`${d.project}/${d.app} ${d.version}`,sub:d.status,color:dColor(d.status),action:()=>nav('deployments')})),
    ...PROJECTS.map(p=>({id:'prj-'+p.id,group:'Projects',icon:'◫',label:`Open ${p.name}`,sub:p.lastDeploy,action:()=>nav('projects')})),
    ...JOBS.map(j=>({id:'job-'+j.id,group:'Jobs',icon:'⚡',label:`Run ${j.name}`,sub:j.schedule,action:()=>nav('jobs')})),
    {id:'ak-view',  group:'API Keys',   icon:'⚿',  label:'API Keys',                 action:()=>nav('api-keys')},
    {id:'ak-new',   group:'API Keys',   icon:'＋',  label:'New API key',              action:()=>nav('api-keys')},
    {id:'alr-view', group:'Alerts & Channels', icon:'▲',  label:'Alert rules',             action:()=>nav('alert-rules')},
    {id:'alr-new',  group:'Alerts & Channels', icon:'＋',  label:'New alert rule',          action:()=>nav('alert-rules')},
    {id:'ch-view',  group:'Alerts & Channels', icon:'📣', label:'Notification channels',   action:()=>nav('channels')},
    {id:'ch-new',   group:'Alerts & Channels', icon:'＋',  label:'New notification channel',action:()=>nav('channels')},
    ...CHANNELS_INIT.map(c=>({id:'ch-'+c.id,group:'Alerts & Channels',icon:(CHANNEL_KIND_META[c.kind]||{}).icon||'📣',label:c.name,sub:c.kind,color:T.sec,action:()=>nav('channels')})),
    {id:'ssh-new', group:'SSH Keys',  icon:'🔑',label:'SSH Keys',           action:()=>nav('ssh-keys')},
    {id:'ssh-add', group:'SSH Keys',  icon:'＋',label:'Add SSH key',          action:()=>nav('ssh-keys')},
    ...SSH_KEYS.map(k=>({id:'sshk-'+k.id,group:'SSH Keys',icon:'🔑',label:k.name,sub:k.algo+(k.bits?'-'+k.bits:''),color:({ed25519:T.green,rsa:T.blue,ecdsa:T.cyan}[k.algo]||T.muted),action:()=>nav('ssh-keys')})),
    {id:'net-peer',group:'Networking',icon:'⬡',label:'Add WireGuard peer',action:()=>nav('networking')},
  ];
}

function CommandPalette({onClose,nav}) {
  const [query,setQuery]=useState('');
  const [idx,setIdx]=useState(0);
  const inputRef=useRef(null);
  const listRef=useRef(null);
  const all=buildCommands(nav);
  const filtered=query.trim()?all.filter(c=>{const q=query.toLowerCase();return c.label.toLowerCase().includes(q)||c.group.toLowerCase().includes(q)||(c.sub||'').toLowerCase().includes(q);}):all;
  const groups=filtered.reduce((acc,c)=>{if(!acc[c.group])acc[c.group]=[];acc[c.group].push(c);return acc;},{});
  const flat=Object.values(groups).flat();
  useEffect(()=>setIdx(0),[query]);
  useEffect(()=>inputRef.current?.focus(),[]);
  useEffect(()=>{listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[idx]);
  const run=c=>{c.action();onClose();};
  const onKey=e=>{
    if(e.key==='ArrowDown'){e.preventDefault();setIdx(i=>Math.min(i+1,flat.length-1));}
    if(e.key==='ArrowUp'){e.preventDefault();setIdx(i=>Math.max(i-1,0));}
    if(e.key==='Enter'){if(flat[idx])run(flat[idx]);}
    if(e.key==='Escape')onClose();
  };
  return (
    <div onClick={onClose} style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:'11vh',zIndex:2000}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:580,maxHeight:'62vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.75)'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'13px 16px',borderBottom:`0.5px solid ${T.border}`}}>
          <span style={{fontSize:16,color:T.muted}}>⌕</span>
          <input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search commands, servers, projects, sysadmin…" style={{flex:1,background:'none',border:'none',outline:'none',fontSize:14,color:T.text,fontFamily:'inherit'}}/>
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} style={{flex:1,overflowY:'auto',padding:'4px 0'}}>
          {flat.length===0&&<div style={{padding:'28px',textAlign:'center',color:T.muted,fontSize:13}}>No results for "{query}"</div>}
          {Object.entries(groups).map(([group,cmds])=>(
            <div key={group}>
              <div style={{fontSize:10,color:group==='System Admin'?T.sys:T.muted,fontWeight:500,textTransform:'uppercase',letterSpacing:'0.08em',padding:'8px 14px 3px',display:'flex',alignItems:'center',gap:6}}>
                {group==='System Admin'&&<span style={{fontSize:9}}>⚙</span>}{group}
              </div>
              {cmds.map(cmd=>{
                const gi=flat.indexOf(cmd),active=gi===idx;
                return (
                  <button key={cmd.id} data-active={active} onMouseEnter={()=>setIdx(gi)} onClick={()=>run(cmd)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,padding:'8px 14px',border:'none',background:active?`${T.blue}15`:'none',cursor:'pointer',textAlign:'left'}}>
                    <span style={{fontSize:13,width:18,textAlign:'center',color:active?T.blue:T.sec,flexShrink:0}}>{cmd.icon}</span>
                    <span style={{flex:1,fontSize:13,color:active?T.text:T.sec,fontWeight:active?500:400}}>{cmd.label}</span>
                    {cmd.sub&&<span style={{fontSize:11,color:cmd.color||T.muted}}>{cmd.sub}</span>}
                    {cmd.badge&&<span style={{fontSize:10,padding:'2px 6px',borderRadius:3,background:`${T.green}22`,color:T.green,border:`0.5px solid ${T.green}44`}}>{cmd.badge}</span>}
                    {cmd.kbd&&!active&&<span style={{fontSize:10,color:T.muted,fontFamily:'monospace'}}>{cmd.kbd}</span>}
                    {active&&<Kbd>↵</Kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{padding:'8px 14px',borderTop:`0.5px solid ${T.border}`,display:'flex',gap:14,alignItems:'center'}}>
          {[['↑↓','navigate'],['↵','select'],['Esc','close']].map(([k,v])=>(<div key={k} style={{display:'flex',alignItems:'center',gap:5}}><Kbd>{k}</Kbd><span style={{fontSize:11,color:T.muted}}>{v}</span></div>))}
          <div style={{marginLeft:'auto',fontSize:11,color:T.muted}}>{flat.length} results</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE VIEWS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENTION SYSTEM — Notice engine + Action Queue
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Notice types ─────────────────────────────────────────────────────────────
// priority: critical → warning → info
// category: fleet | deploy | cert | app | job | alert | system
//
// Each notice has:
//   id         — stable key for dismissal
//   priority   — critical | warning | info
//   category   — for grouping / icons
//   title      — one line, actionable
//   detail     — optional second line
//   action     — { label, view, ... } — where to go to fix it
//   age        — when it was first detected (ms timestamp)

const NOTICE_PRIORITY_ORDER = { critical:0, warning:1, info:2 };
const NOTICE_ICONS = {
  fleet:   '🖥',
  deploy:  '🚀',
  cert:    '🔒',
  app:     '📦',
  job:     '⚡',
  alert:   '▲',
  system:  '⚙',
  cleanup: '🗑',
};
const NOTICE_COLORS = {
  critical: T.red,
  warning:  T.amber,
  info:     T.blue,
};

function computeNotices() {
  const now = Date.now();
  const notices = [];
  let seq = 0;
  const add = (n) => notices.push({ id: String(seq++), age: now, ...n });

  // ── Fleet / Servers ──────────────────────────────────────────────────────
  SERVERS.forEach(s => {
    // Server unreachable
    if (s.status === 'unreachable') {
      add({ priority:'critical', category:'fleet',
        title:`${s.name} is unreachable`,
        detail:'Agent has not responded. Check the server or restart the agent.',
        action:{ label:'View server', view:'servers', server:s },
      });
    }
    // Heartbeat overdue — online but last beat was >10 min ago (simulated as stale)
    if (s.status === 'online' && s.lastBeat && now - s.lastBeat > 10*60*1000) {
      add({ priority:'warning', category:'fleet',
        title:`${s.name} heartbeat overdue`,
        detail:`Last seen ${fmtAge(s.lastBeat)} — may have lost agent connection.`,
        action:{ label:'View server', view:'servers', server:s },
      });
    }
    // High CPU
    if (s.cpu !== null && s.cpu >= 85) {
      add({ priority:'warning', category:'fleet',
        title:`${s.name} CPU at ${s.cpu}%`,
        detail:'Sustained high CPU may affect app performance.',
        action:{ label:'View metrics', view:'servers', server:s },
      });
    }
    // High memory
    if (s.mem !== null && s.mem >= 90) {
      add({ priority:'critical', category:'fleet',
        title:`${s.name} memory at ${s.mem}%`,
        detail:'Risk of OOM-kill. Consider scaling up or restarting apps.',
        action:{ label:'View server', view:'servers', server:s },
      });
    }
    // Draining for a long time
    if (s.status === 'draining') {
      add({ priority:'info', category:'fleet',
        title:`${s.name} is still draining`,
        detail:'Drain has been active. Undrain when workloads have migrated.',
        action:{ label:'Manage server', view:'servers', server:s },
      });
    }
  });

  // ── Deployments ──────────────────────────────────────────────────────────
  const recentFailed = DEPLOYMENTS.filter(d => d.status === 'failed');
  recentFailed.forEach(d => {
    add({ priority:'critical', category:'deploy',
      title:`Deploy failed: ${d.project}/${d.app}`,
      detail:`${d.env} · ${d.version} · ${d.ago}`,
      action:{ label:'View deploy', view:'deployments', deploy:d },
    });
  });

  // Deploy running for a long time (>15 min simulated)
  DEPLOYMENTS.filter(d => d.status === 'running').forEach(d => {
    add({ priority:'warning', category:'deploy',
      title:`Deploy has been running a while: ${d.project}/${d.app}`,
      detail:`Started ${d.ago} — may be stuck on a step.`,
      action:{ label:'View progress', view:'deployments', deploy:d },
    });
  });

  // ── SSL certs ────────────────────────────────────────────────────────────
  // Simulate certs expiring soon based on APP_DOMAINS data
  const soonMs = 14 * 24 * 60 * 60 * 1000;
  Object.values(APP_DOMAINS).forEach(appData => {
    (appData.domains || []).forEach(d => {
      if (d.cert?.status === 'expiring') {
        add({ priority:'warning', category:'cert',
          title:`SSL cert expiring: ${d.hostname}`,
          detail:'Less than 14 days remaining. Renew or upload a new cert.',
          action:{ label:'Manage domain', view:'projects' },
        });
      }
      if (d.cert?.status === 'expired') {
        add({ priority:'critical', category:'cert',
          title:`SSL cert expired: ${d.hostname}`,
          detail:'HTTPS is broken for this domain. Replace the cert immediately.',
          action:{ label:'Fix now', view:'projects' },
        });
      }
    });
  });

  // ── Apps ─────────────────────────────────────────────────────────────────
  Object.values(PROJECT_DATA).forEach(proj => {
    Object.values(proj.envs).forEach(env => {
      (env.apps || []).forEach(app => {
        // App has no image configured
        if (!app.image || app.image === '') {
          add({ priority:'warning', category:'app',
            title:`${app.name} has no image configured`,
            detail:'App was created but never configured. It cannot be deployed.',
            action:{ label:'Configure app', view:'projects' },
          });
        }
        // App in error state
        if (app.status === 'error') {
          add({ priority:'critical', category:'app',
            title:`${app.name} is in error state`,
            detail:'Container failed to start or keep running. Check logs.',
            action:{ label:'View logs', view:'projects' },
          });
        }
        // App stopped in production
        if (app.status === 'stopped' && app.image) {
          add({ priority:'info', category:'app',
            title:`${app.name} is stopped in production`,
            detail:'App has an image but is not running. Intentional?',
            action:{ label:'Check app', view:'projects' },
          });
        }
      });
    });
  });

  // ── Jobs ─────────────────────────────────────────────────────────────────
  JOBS_INIT.filter(j => j.status === 'failed').forEach(j => {
    add({ priority:'warning', category:'job',
      title:`Job failed: ${j.name}`,
      detail:`${j.project} · last run ${j.lastRun} · took ${j.duration}`,
      action:{ label:'View jobs', view:'jobs' },
    });
  });

  // ── Firing alerts ─────────────────────────────────────────────────────────
  const firing = ALERT_RULES_INIT.filter(r => r.state === 'firing');
  if (firing.length > 0) {
    // Surface the critical ones individually, group the rest
    firing.filter(r => r.severity === 'critical').forEach(r => {
      add({ priority:'critical', category:'alert',
        title:`Alert firing: ${r.name}`,
        detail:`${r.target_label} · firing since ${fmtAge(r.last_fired)}`,
        action:{ label:'View alerts', view:'alert-rules' },
      });
    });
    const warnings = firing.filter(r => r.severity !== 'critical');
    if (warnings.length > 0) {
      add({ priority:'warning', category:'alert',
        title:`${warnings.length} alert rule${warnings.length>1?'s':''} firing`,
        detail:warnings.map(r => r.name).join(', '),
        action:{ label:'View alerts', view:'alert-rules' },
      });
    }
  }

  // ── Disk cleanup ─────────────────────────────────────────────────────────
  const highDisk = DISK_DATA_INIT.filter(s => s.build_cache_gb > 5 || s.images.dangling > 15);
  if (highDisk.length > 0) {
    const totalReclaim = highDisk.reduce((a,s)=>a+s.build_cache_gb*0.9+s.images.dangling*0.08,0);
    add({ priority:'info', category:'cleanup',
      title:`~${totalReclaim.toFixed(1)} GB reclaimable across ${highDisk.length} server${highDisk.length>1?'s':''}`,
      detail:`${highDisk.map(s=>s.name).join(', ')} have significant unused images and build cache.`,
      action:{ label:'Run cleanup', view:'disk-cleanup' },
    });
  }

  // Sort: critical first, then warning, then info; within same priority by age desc
  notices.sort((a,b) => {
    const po = NOTICE_PRIORITY_ORDER[a.priority] - NOTICE_PRIORITY_ORDER[b.priority];
    return po !== 0 ? po : b.age - a.age;
  });

  return notices;
}

// ─── Inline notice bar — shown at the top of a view when relevant ─────────────
function NoticeBar({ notices, onDismiss }) {
  if (!notices || notices.length === 0) return null;
  return (
    <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:16}}>
      {notices.map(n=>{
        const c = NOTICE_COLORS[n.priority];
        return (
          <div key={n.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',background:`${c}0d`,border:`0.5px solid ${c}44`,borderRadius:8}}>
            <span style={{fontSize:14,flexShrink:0}}>{NOTICE_ICONS[n.category]}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,fontWeight:600,color:T.text}}>{n.title}</div>
              {n.detail&&<div style={{fontSize:11,color:T.sec,marginTop:2}}>{n.detail}</div>}
            </div>
            <Pill label={n.priority} color={c}/>
            {onDismiss&&<button onClick={()=>onDismiss(n.id)} style={{background:'none',border:'none',cursor:'pointer',color:T.muted,fontSize:14,padding:'0 4px',flexShrink:0}}>✕</button>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Action Queue — full list with grouping, used on Basecamp ─────────────────
function ActionQueue({ notices, onDismiss, onNavigate }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? notices : notices.slice(0, 6);
  const hidden  = notices.length - 6;
  const critCount = notices.filter(n=>n.priority==='critical').length;
  const warnCount = notices.filter(n=>n.priority==='warning').length;

  if (notices.length === 0) {
    return (
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'24px 20px',textAlign:'center'}}>
        <div style={{fontSize:28,marginBottom:10}}>✓</div>
        <div style={{fontSize:13,fontWeight:600,color:T.green,marginBottom:4}}>All clear</div>
        <div style={{fontSize:12,color:T.muted}}>No issues detected across your workspace.</div>
      </div>
    );
  }

  return (
    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
      {/* Header */}
      <div style={{padding:'12px 16px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',gap:10}}>
        <span style={{fontSize:13,fontWeight:700,color:T.text,flex:1}}>Needs attention</span>
        {critCount>0&&<span style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:`${T.red}15`,color:T.red,border:`0.5px solid ${T.red}33`,fontWeight:600}}>{critCount} critical</span>}
        {warnCount>0&&<span style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:`${T.amber}15`,color:T.amber,border:`0.5px solid ${T.amber}33`,fontWeight:600}}>{warnCount} warning</span>}
      </div>

      {/* Notice list */}
      <div style={{display:'flex',flexDirection:'column'}}>
        {visible.map((n,i)=>{
          const c = NOTICE_COLORS[n.priority];
          return (
            <div key={n.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',borderBottom:i<visible.length-1?`0.5px solid ${T.border}`:'none',borderLeft:`3px solid ${c}`}}>
              <span style={{fontSize:13,flexShrink:0}}>{NOTICE_ICONS[n.category]}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{n.title}</div>
                {n.detail&&<div style={{fontSize:11,color:T.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:1}}>{n.detail}</div>}
              </div>
              {n.action&&(
                <button
                  onClick={()=>onNavigate&&onNavigate(n)}
                  style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${c}44`,background:`${c}0d`,color:c,cursor:'pointer',flexShrink:0,fontWeight:500,whiteSpace:'nowrap'}}>
                  {n.action.label} →
                </button>
              )}
              <button onClick={()=>onDismiss(n.id)} style={{background:'none',border:'none',cursor:'pointer',color:T.muted,fontSize:13,padding:'0 2px',flexShrink:0}}>✕</button>
            </div>
          );
        })}
      </div>

      {/* Show more */}
      {notices.length > 6 && (
        <div style={{padding:'10px 16px',borderTop:`0.5px solid ${T.border}`}}>
          <button onClick={()=>setShowAll(v=>!v)} style={{fontSize:12,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>
            {showAll ? '▲ Show less' : `▼ Show ${hidden} more issue${hidden>1?'s':''}`}
          </button>
        </div>
      )}
    </div>
  );
}

function BasecampView({nav}) {
  const [dismissed, setDismissed] = useState(new Set());
  const allNotices = computeNotices().filter(n => !dismissed.has(n.id));
  const dismiss = id => setDismissed(s => new Set([...s, id]));

  const handleNoticeNav = (notice) => {
    if (!notice.action) return;
    nav(notice.action.view);
  };

  const online     = SERVERS.filter(s=>s.status==='online').length;
  const deploying  = DEPLOYMENTS.filter(d=>d.status==='running').length;
  const critAlerts = allNotices.filter(n=>n.priority==='critical').length;
  const jobsRunning= JOBS_INIT.filter(j=>j.status==='running').length;

  return (
    <div style={{padding:'28px 30px',maxWidth:1080}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:28}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,color:T.text,letterSpacing:'-0.03em'}}>Acme Corp</div>
          <div style={{fontSize:13,color:T.sec,marginTop:4}}>Infrastructure Basecamp · Enterprise Plan</div>
        </div>
        <button onClick={()=>nav('provision')} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Provision Server</button>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Fleet"          value={`${online} / ${SERVERS.length}`} sub={`${SERVERS.length-online} offline`}        color={T.green}/>
        <StatCard label="Deploying"      value={deploying}   sub="in progress now"     color={deploying>0?T.blue:T.text}/>
        <StatCard label="Issues"         value={allNotices.length} sub={critAlerts>0?`${critAlerts} critical`:'all clear'} color={critAlerts>0?T.red:allNotices.length>0?T.amber:T.green}/>
        <StatCard label="Jobs Running"   value={jobsRunning} sub="of 5 scheduled"      color={jobsRunning>0?T.amber:T.text}/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16}}>
        {/* Left column */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <Card>
            <SecHead title="Recent Deployments" action={()=>nav('deployments')} label="View all →"/>
            {DEPLOYMENTS.map((d,i)=>(
              <div key={d.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:i<DEPLOYMENTS.length-1?`0.5px solid ${T.border}`:'none'}}>
                <Dot color={dColor(d.status)} size={7}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:7}}>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>{d.project}</span>
                    <span style={{fontSize:12,color:T.sec}}>/{d.app}</span>
                    <Pill label={d.env} color={d.env==='production'?T.red:d.env==='staging'?T.amber:T.blue}/>
                  </div>
                  <div style={{display:'flex',gap:12,marginTop:3}}>
                    <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{d.version}</span>
                    <span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{d.commit}</span>
                    <span style={{fontSize:11,color:T.sec}}>by {d.by}</span>
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <Pill label={d.status} color={dColor(d.status)}/>
                  <div style={{fontSize:11,color:T.muted,marginTop:4}}>{d.ago}</div>
                </div>
              </div>
            ))}
          </Card>

          <Card>
            <SecHead title="Server Fleet" action={()=>nav('servers')} label="View all →"/>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10}}>
              {SERVERS.filter(s=>s.status!=='stopped').map(s=>(
                <div key={s.id} style={{background:T.elevated,borderRadius:7,padding:'10px 13px',border:`0.5px solid ${s.status==='unreachable'?T.red+'55':T.border}`}}>
                  <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:8}}>
                    <Dot color={sColor(s.status)} size={7}/>
                    <span style={{fontSize:12,fontWeight:500,color:T.text,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</span>
                    <Pill label={s.role} color={rColor(s.role)}/>
                  </div>
                  {s.cpu!==null
                    ? <div style={{display:'flex',gap:8}}><div style={{flex:1}}><Bar value={s.cpu} label="CPU"/></div><div style={{flex:1}}><Bar value={s.mem} label="MEM"/></div></div>
                    : <div style={{fontSize:11,color:T.red}}>Agent unreachable</div>
                  }
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right column — Action Queue + supporting cards */}
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <ActionQueue
            notices={allNotices}
            onDismiss={dismiss}
            onNavigate={handleNoticeNav}
          />

          <Card>
            <SecHead title="Projects" action={()=>nav('projects')} label="View all →"/>
            <div style={{display:'flex',flexDirection:'column',gap:7}}>
              {PROJECTS.map(p=>(
                <div key={p.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 11px',background:T.elevated,borderRadius:6}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</div>
                    <div style={{fontSize:11,color:T.sec,marginTop:2}}>{p.apps} apps · {p.lastDeploy}</div>
                  </div>
                  <div style={{display:'flex',gap:4,flexShrink:0}}>
                    {Object.entries(p.envs).map(([env,st])=>(
                      <div key={env} title={`${env}: ${st}`} style={{width:8,height:8,borderRadius:'50%',background:eColor(st)}}/>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SecHead title="Scheduled Jobs" action={()=>nav('jobs')} label="View all →"/>
            {JOBS_INIT.slice(0,4).map((j,i)=>(
              <div key={j.id} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 0',borderBottom:i<3?`0.5px solid ${T.border}`:'none'}}>
                <Dot color={jColor(j.status)} size={6}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{j.name}</div>
                  <div style={{fontSize:10,color:T.muted,fontFamily:'monospace',marginTop:2}}>{j.schedule}</div>
                </div>
                <span style={{fontSize:11,color:T.sec,flexShrink:0}}>{j.nextRun}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function fmtBytes(b) {
  if(!b) return '—';
  if(b>=1e9) return (b/1e9).toFixed(1)+' GB';
  if(b>=1e6) return (b/1e6).toFixed(0)+' MB';
  return (b/1e3).toFixed(0)+' KB';
}
function fmtAge(ts) {
  if(!ts) return '—';
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60)  return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
const csColor = s => ({running:T.green,paused:T.amber,restarting:T.amber,exited:T.muted,dead:T.red,created:T.blue}[s]||T.muted);
const evColor = k => ({came_online:T.green,heartbeat:T.muted,reboot_requested:T.amber,drain_started:T.amber,drain_cancelled:T.green,sync_requested:T.blue,status_synced:T.blue,created:T.cyan,removed:T.red}[k]||T.sec);

function MiniBar({value,width=60}) {
  if(value===null||value===undefined) return <span style={{color:T.muted,fontSize:11}}>—</span>;
  const c=value>=90?T.red:value>=75?T.amber:T.green;
  return (
    <div style={{display:'flex',alignItems:'center',gap:6}}>
      <div style={{width,height:3,background:T.elevated,borderRadius:2,flexShrink:0}}>
        <div style={{height:'100%',width:value+'%',background:c,borderRadius:2}}/>
      </div>
      <span style={{fontSize:11,color:c,fontFamily:'monospace',minWidth:30}}>{value}%</span>
    </div>
  );
}

function ActionBtn({label,color=T.sec,onClick,icon}) {
  return (
    <button onClick={onClick} style={{display:'flex',alignItems:'center',gap:6,padding:'7px 13px',borderRadius:6,border:`0.5px solid ${color}44`,background:`${color}11`,color,fontSize:12,fontWeight:500,cursor:'pointer'}}>
      {icon&&<span style={{fontSize:12}}>{icon}</span>}{label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

const ToastCtx = React.createContext(()=>{});
const useToast = () => React.useContext(ToastCtx);

const TOAST_ICONS = { success:'✓', error:'✗', info:'ℹ', warning:'⚠', loading:'◌' };
const TOAST_COLORS = {
  success: { border:T.green,  bg:`${T.green}14`,  icon:T.green  },
  error:   { border:T.red,    bg:`${T.red}14`,    icon:T.red    },
  warning: { border:T.amber,  bg:`${T.amber}12`,  icon:T.amber  },
  info:    { border:T.blue,   bg:`${T.blue}12`,   icon:T.blue   },
  loading: { border:T.blue,   bg:`${T.blue}10`,   icon:T.blue   },
};

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div style={{position:'fixed',bottom:24,right:24,zIndex:9000,display:'flex',flexDirection:'column',gap:8,alignItems:'flex-end',pointerEvents:'none'}}>
      <style>{`
        @keyframes toast-in  { from{opacity:0;transform:translateY(8px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes toast-out { from{opacity:1;transform:translateY(0) scale(1)} to{opacity:0;transform:translateY(4px) scale(0.97)} }
        @keyframes toast-spin { to{transform:rotate(360deg)} }
        @keyframes toast-prog { from{width:100%} to{width:0%} }
      `}</style>
      {toasts.map(t => {
        const c = TOAST_COLORS[t.kind] || TOAST_COLORS.info;
        return (
          <div key={t.id} style={{
            pointerEvents:'all',
            background: T.card,
            border:`0.5px solid ${c.border}`,
            borderLeft:`3px solid ${c.border}`,
            borderRadius:8,
            padding:'11px 14px 11px 12px',
            minWidth:280,
            maxWidth:380,
            boxShadow:`0 8px 32px rgba(0,0,0,0.45), 0 0 0 0.5px ${T.border}`,
            animation: t.leaving ? 'toast-out 0.18s ease forwards' : 'toast-in 0.22s ease',
            overflow:'hidden',
            position:'relative',
          }}>
            {/* Progress bar */}
            {t.duration && !t.leaving && (
              <div style={{position:'absolute',bottom:0,left:0,height:2,background:`${c.border}55`,borderRadius:'0 0 0 8px',
                animation:`toast-prog ${t.duration}ms linear forwards`}}/>
            )}
            <div style={{display:'flex',alignItems:'flex-start',gap:10}}>
              {/* Icon */}
              <div style={{
                width:20,height:20,borderRadius:'50%',background:c.bg,border:`1px solid ${c.border}44`,
                display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1,
              }}>
                {t.kind==='loading'
                  ? <div style={{width:10,height:10,border:`1.5px solid ${c.icon}`,borderTopColor:'transparent',borderRadius:'50%',animation:'toast-spin 0.7s linear infinite'}}/>
                  : <span style={{fontSize:10,fontWeight:700,color:c.icon,lineHeight:1}}>{TOAST_ICONS[t.kind]}</span>
                }
              </div>
              {/* Content */}
              <div style={{flex:1,minWidth:0}}>
                {t.title && <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:t.message?3:0,lineHeight:'18px'}}>{t.title}</div>}
                {t.message && <div style={{fontSize:12,color:T.sec,lineHeight:'17px'}}>{t.message}</div>}
                {t.action && (
                  <button onClick={()=>{t.action.fn();onDismiss(t.id);}} style={{marginTop:7,fontSize:11,fontWeight:600,color:c.icon,background:'none',border:`0.5px solid ${c.border}44`,borderRadius:4,padding:'3px 10px',cursor:'pointer'}}>
                    {t.action.label}
                  </button>
                )}
              </div>
              {/* Dismiss */}
              <button onClick={()=>onDismiss(t.id)} style={{background:'none',border:'none',cursor:'pointer',color:T.muted,fontSize:14,lineHeight:1,padding:'1px 2px',marginTop:-1,flexShrink:0}}>✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useToastState() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    setToasts(ts => ts.map(t => t.id===id ? {...t,leaving:true} : t));
    setTimeout(() => setToasts(ts => ts.filter(t => t.id!==id)), 200);
    if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
  }, []);

  const toast = useCallback((kind, title, message, opts={}) => {
    const id = Math.random().toString(36).slice(2);
    const duration = opts.duration ?? (kind==='loading' ? null : kind==='error' ? 6000 : 4000);
    const entry = { id, kind, title, message, duration, action:opts.action, leaving:false };
    setToasts(ts => [...ts.slice(-4), entry]); // max 5 visible
    if (duration) {
      timers.current[id] = setTimeout(() => dismiss(id), duration);
    }
    // Return an updater so callers can mutate (e.g. loading → success)
    return {
      update: (newKind, newTitle, newMsg) => {
        if (timers.current[id]) { clearTimeout(timers.current[id]); }
        setToasts(ts => ts.map(t => t.id===id ? {...t, kind:newKind, title:newTitle, message:newMsg||t.message, duration:4000, leaving:false} : t));
        timers.current[id] = setTimeout(() => dismiss(id), 4000);
      },
      dismiss: () => dismiss(id),
    };
  }, [dismiss]);

  // Convenience wrappers
  toast.success = (title, msg, opts)  => toast('success', title, msg, opts);
  toast.error   = (title, msg, opts)  => toast('error',   title, msg, opts);
  toast.info    = (title, msg, opts)  => toast('info',    title, msg, opts);
  toast.warning = (title, msg, opts)  => toast('warning', title, msg, opts);
  toast.loading = (title, msg, opts)  => toast('loading', title, msg, opts);

  // Promise helper: loading → success/error
  toast.promise = (promise, { loading, success, error }) => {
    const t = toast('loading', loading.title, loading.message);
    promise
      .then(()  => t.update('success', success.title, success.message))
      .catch(()  => t.update('error',   error.title,   error.message));
    return promise;
  };

  return { toasts, toast, dismiss };
}

function ConfirmAction({action,color,onConfirm,onCancel}) {
  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1500}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:10,padding:'24px',width:360,boxShadow:'0 20px 60px rgba(0,0,0,0.6)'}}>
        <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:8}}>Confirm: {action}</div>
        <div style={{fontSize:13,color:T.sec,marginBottom:20}}>This action will be recorded in the audit log. Are you sure?</div>
        <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
          <button onClick={onCancel} style={{padding:'8px 16px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,fontSize:13,cursor:'pointer'}}>Cancel</button>
          <button onClick={onConfirm} style={{padding:'8px 16px',borderRadius:6,border:'none',background:color,color:'#111',fontSize:13,fontWeight:700,cursor:'pointer'}}>{action}</button>
        </div>
      </div>
    </div>
  );
}

function ServerDetailView({server, onBack, nav}) {
  const toast = useToast();
  const [tab, setTab]         = useState('overview');
  const [confirm, setConfirm] = useState(null); // {action, color}
  const docker  = DOCKER_STATE[server.id]  || null;
  const events  = SERVER_EVENTS[server.id] || [];
  const tabs = ['overview','metrics','containers','volumes','networks','images','events'];
  const runningCtrs = docker?.containers.filter(c=>c.status==='running').length ?? 0;

  const doAction = (action) => {
    setConfirm(null);
    const msgs = {
      'Drain server':   ['warning', 'Draining server',   `${server.name} will finish in-flight work, then stop accepting new jobs.`],
      'Undrain server': ['success', 'Server undrained',  `${server.name} is back in active rotation.`],
      'Reboot server':  ['info',    'Reboot requested',  `${server.name} will restart — expect ~30s of downtime.`],
      'Remove server':  ['error',   'Server removed',    `${server.name} has been removed from the fleet.`],
    };
    const [kind, title, msg] = msgs[action] || ['info', action, ''];
    toast(kind, title, msg);
  };

  return (
    <div style={{padding:'24px 30px'}}>
      {confirm && <ConfirmAction action={confirm.action} color={confirm.color} onConfirm={()=>doAction(confirm.action)} onCancel={()=>setConfirm(null)}/>}

      {/* Breadcrumb + header */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:20}}>
        <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,fontSize:13,padding:0,display:'flex',alignItems:'center',gap:4}}>
          ← Servers
        </button>
        <span style={{color:T.muted}}>/</span>
        <span style={{fontSize:13,color:T.sec}}>{server.name}</span>
      </div>

      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:22}}>
        <div style={{display:'flex',alignItems:'center',gap:14}}>
          <div style={{width:44,height:44,borderRadius:10,background:T.elevated,border:`1px solid ${sColor(server.status)}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>
            {server.role==='database'?'🗄':server.role==='build'?'🔨':server.role==='gateway'?'🔀':server.role==='worker'?'⚙':'🖥'}
          </div>
          <div>
            <div style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{server.name}</div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginTop:4}}>
              <div style={{display:'flex',alignItems:'center',gap:5}}>
                <Dot color={sColor(server.status)} size={7}/>
                <span style={{fontSize:12,color:sColor(server.status)}}>{server.status}</span>
              </div>
              <span style={{color:T.muted,fontSize:12}}>·</span>
              <Pill label={server.role} color={rColor(server.role)}/>
              <span style={{color:T.muted,fontSize:12}}>·</span>
              <span style={{fontSize:12,color:T.sec,fontFamily:'monospace'}}>{server.ip}</span>
              <span style={{color:T.muted,fontSize:12}}>·</span>
              <span style={{fontSize:12,color:T.sec}}>{server.region}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div style={{display:'flex',gap:8,flexShrink:0}}>
          {server.status==='online' && <>
            <ActionBtn label="Drain"   color={T.amber} icon="⏸" onClick={()=>setConfirm({action:'Drain server',  color:T.amber})}/>
            <ActionBtn label="Reboot"  color={T.amber} icon="↺" onClick={()=>setConfirm({action:'Reboot server', color:T.amber})}/>
          </>}
          {server.status==='draining' && <ActionBtn label="Undrain" color={T.green} icon="▶" onClick={()=>setConfirm({action:'Undrain server',color:T.green})}/>}
          <ActionBtn label="Sync"    color={T.blue}  icon="⟳" onClick={()=>{}}/>
          <ActionBtn label="SSH"     color={T.sec}   icon="⌨" onClick={()=>{}}/>
          <button onClick={()=>setConfirm({action:'Remove server',color:T.red})} style={{padding:'7px 13px',borderRadius:6,border:`0.5px solid ${T.red}33`,background:'none',color:T.muted,fontSize:12,cursor:'pointer'}}>Remove</button>
        </div>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:10,marginBottom:22}}>
        {[
          {l:'CPU',    v:<MiniBar value={server.cpu}/>,    raw:server.cpu!==null},
          {l:'Memory', v:<MiniBar value={server.mem}/>,    raw:server.mem!==null},
          {l:'Disk',   v:<MiniBar value={server.disk}/>,   raw:server.disk!==null},
          {l:'Agent',  v:<span style={{fontSize:13,fontWeight:600,color:server.agent?T.text:T.muted}}>{server.agent?'v'+server.agent:'—'}</span>},
          {l:'Heartbeat',v:<span style={{fontSize:13,fontWeight:600,color:server.beat?T.text:T.muted}}>{server.beat+' ago'}</span>},
          {l:'Containers',v:<span style={{fontSize:18,fontWeight:700,color:T.text,lineHeight:1}}>{server.containers??'—'}</span>,sub:docker?`${runningCtrs} running`:'no data'},
        ].map(s=>(
          <div key={s.l} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:7,padding:'11px 14px'}}>
            <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:7}}>{s.l}</div>
            {s.v}
            {s.sub&&<div style={{fontSize:10,color:T.muted,marginTop:4}}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`0.5px solid ${T.border}`,marginBottom:20}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,textTransform:'capitalize'}}>
            {t}
            {t==='containers'&&docker&&<span style={{fontSize:10,marginLeft:5,color:T.muted}}>({docker.containers.length})</span>}
            {t==='volumes'   &&docker&&<span style={{fontSize:10,marginLeft:5,color:T.muted}}>({docker.volumes.length})</span>}
            {t==='networks'  &&docker&&<span style={{fontSize:10,marginLeft:5,color:T.muted}}>({docker.networks.length})</span>}
            {t==='images'    &&docker&&<span style={{fontSize:10,marginLeft:5,color:T.muted}}>({docker.images.length})</span>}
            {t==='events'    &&<span style={{fontSize:10,marginLeft:5,color:T.muted}}>({events.length})</span>}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab==='overview' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
          <Card>
            <SecHead title="Server details"/>
            {[
              ['ID',       server.id],
              ['Hostname', server.name],
              ['IP (v4)',  server.ip||'—'],
              ['Region',   server.region],
              ['Provider', 'DigitalOcean'],
              ['SSH port', '22'],
              ['SSH user', 'root'],
            ].map(([k,v])=>(
              <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:`0.5px solid ${T.border}`}}>
                <span style={{fontSize:12,color:T.sec}}>{k}</span>
                <span style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{v}</span>
              </div>
            ))}
          </Card>
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <Card>
              <SecHead title="Agent"/>
              {[
                ['Version',      server.agent ? 'v'+server.agent : '—'],
                ['Status',       server.status],
                ['Last beat',    server.beat ? server.beat+' ago' : '—'],
                ['Conduit URL',  server.status==='online'?`http://${server.ip}:7700`:'—'],
              ].map(([k,v])=>(
                <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:`0.5px solid ${T.border}`}}>
                  <span style={{fontSize:12,color:T.sec}}>{k}</span>
                  <span style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{v}</span>
                </div>
              ))}
            </Card>
            {docker && (
              <Card>
                <SecHead title="Docker snapshot"/>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  {[
                    {l:'Running', v:docker.containers.filter(c=>c.status==='running').length, c:T.green},
                    {l:'Stopped', v:docker.containers.filter(c=>c.status==='exited').length,  c:T.muted},
                    {l:'Volumes', v:docker.volumes.length,  c:T.text},
                    {l:'Images',  v:docker.images.length,   c:T.text},
                  ].map(s=>(
                    <div key={s.l} style={{background:T.elevated,borderRadius:6,padding:'10px 12px'}}>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:5}}>{s.l}</div>
                      <div style={{fontSize:18,fontWeight:700,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:10,fontSize:11,color:T.muted}}>Collected {fmtAge(docker.collected_at)}</div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ── Metrics ── */}
      {tab==='metrics' && (() => {
        const [range, setRange] = React.useState('1h');
        const [tick,  setTick]  = React.useState(0);
        React.useEffect(()=>{ const t=setInterval(()=>setTick(n=>n+1),3000); return()=>clearInterval(t); },[]);

        // Generate fake time-series: N points over range
        const pts = range==='1h'?60:range==='6h'?72:range==='24h'?96:48;
        const mkSeries=(base,noise,min=0,max=100)=>Array.from({length:pts},(_,i)=>{
          const trend=Math.sin(i/pts*Math.PI*2)*noise*0.3;
          return Math.max(min,Math.min(max,Math.round(base+trend+(Math.random()-0.5)*noise)));
        });

        const cpu    = mkSeries(server.cpu||38, 20);
        const mem    = mkSeries(server.mem||62, 10);
        const disk_r = mkSeries(45, 30, 0, 200);
        const disk_w = mkSeries(20, 25, 0, 200);
        const net_in = mkSeries(120, 60, 0, 500);
        const net_out= mkSeries(80,  40, 0, 500);

        const MiniChart=({data,color,height=52,fill=true,unit=''})=>{
          const w=360,h=height,pad=2;
          const mn=Math.min(...data),mx=Math.max(...data)||1;
          const xs=data.map((_,i)=>pad+i*(w-pad*2)/(data.length-1));
          const ys=data.map(v=>h-pad-(v-mn)/(mx-mn||1)*(h-pad*2));
          const pts_str=xs.map((x,i)=>`${x},${ys[i]}`).join(' ');
          const last=data[data.length-1];
          return (
            <div style={{position:'relative'}}>
              <svg viewBox={`0 0 ${w} ${h}`} style={{width:'100%',height,display:'block'}}>
                {fill&&<polygon points={`${xs[0]},${h} ${pts_str} ${xs[xs.length-1]},${h}`} fill={`${color}18`}/>}
                <polyline points={pts_str} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
                <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="2.5" fill={color}/>
              </svg>
              <div style={{position:'absolute',top:4,right:6,fontSize:11,fontFamily:'monospace',fontWeight:700,color}}>{last}{unit}</div>
            </div>
          );
        };

        const MetricCard=({title,value,sub,color,children})=>(
          <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
            <div style={{padding:'12px 14px 8px',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:4,fontWeight:500}}>{title}</div>
                <div style={{fontSize:22,fontWeight:800,color,letterSpacing:'-0.02em',lineHeight:1}}>{value}</div>
                {sub&&<div style={{fontSize:10,color:T.muted,marginTop:3}}>{sub}</div>}
              </div>
            </div>
            <div style={{padding:'0 0 8px'}}>{children}</div>
          </div>
        );

        const cpuNow=cpu[cpu.length-1], memNow=mem[mem.length-1];
        const cpuC=cpuNow>80?T.red:cpuNow>60?T.amber:T.green;
        const memC=memNow>85?T.red:memNow>70?T.amber:T.blue;

        return (
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <div style={{fontSize:12,color:T.muted}}>Live metrics from hub-agent heartbeat · refreshes every 30s</div>
              <div style={{display:'flex',gap:4,background:T.elevated,borderRadius:6,padding:3}}>
                {['1h','6h','24h','7d'].map(r=>(
                  <button key={r} onClick={()=>setRange(r)} style={{padding:'4px 11px',borderRadius:4,border:'none',cursor:'pointer',fontSize:11,fontWeight:range===r?600:400,background:range===r?T.card:'transparent',color:range===r?T.text:T.sec}}>{r}</button>
                ))}
              </div>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
              <MetricCard title="CPU usage" value={`${cpuNow}%`} sub={`${server.specs?.cpu_cores||4} cores · load avg ${(cpuNow/100*server.specs?.cpu_cores||1.4).toFixed(2)}`} color={cpuC}>
                <MiniChart data={cpu} color={cpuC} unit="%"/>
              </MetricCard>
              <MetricCard title="Memory" value={`${memNow}%`} sub={`${Math.round((server.specs?.memory_mb||4096)*memNow/100)} MB / ${server.specs?.memory_mb||4096} MB`} color={memC}>
                <MiniChart data={mem} color={memC} unit="%"/>
              </MetricCard>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
              <MetricCard title="Disk I/O" value={`${disk_r[disk_r.length-1]}↓`} sub={`${disk_w[disk_w.length-1]} MB/s write`} color={T.cyan}>
                <div style={{position:'relative',padding:'0 0 8px'}}>
                  <svg viewBox="0 0 360 52" style={{width:'100%',height:52,display:'block'}}>
                    {disk_r.map((_,i)=>{
                      const x=2+i*(356/(disk_r.length-1)),h_r=disk_r[i]/200*48,h_w=disk_w[i]/200*48;
                      return <g key={i}><rect x={x-1} y={50-h_r} width={2} height={h_r} fill={`${T.cyan}66`}/><rect x={x+1} y={50-h_w} width={2} height={h_w} fill={`${T.purple}66`}/></g>;
                    })}
                  </svg>
                  <div style={{position:'absolute',bottom:10,right:8,display:'flex',gap:8,fontSize:9}}>
                    <span style={{color:T.cyan}}>■ read</span><span style={{color:T.purple}}>■ write</span>
                  </div>
                </div>
              </MetricCard>
              <MetricCard title="Network" value={`${net_in[net_in.length-1]} KB/s`} sub={`${net_out[net_out.length-1]} KB/s out`} color={T.amber}>
                <MiniChart data={net_in} color={T.amber} unit=" KB/s"/>
              </MetricCard>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
              {[
                ['Uptime',    server.health?.uptime_s ? `${Math.floor(server.health.uptime_s/86400)}d ${Math.floor((server.health.uptime_s%86400)/3600)}h` : '14d 6h', T.green],
                ['Disk',      `${server.health?.disk_pct||42}%`,   server.health?.disk_pct>85?T.red:T.text],
                ['Load 1m',   `${server.health?.load_1m||0.8}`,    server.health?.load_1m>4?T.red:T.text],
                ['Load 15m',  `${server.health?.load_15m||0.6}`,   T.text],
              ].map(([label,val,color])=>(
                <div key={label} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:7,padding:'10px 12px'}}>
                  <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:4}}>{label}</div>
                  <div style={{fontSize:16,fontWeight:700,color,fontFamily:'monospace'}}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Containers ── */}
      {tab==='containers' && (
        docker ? (
          <div>
            <div style={{marginBottom:14,display:'flex',gap:8}}>
              {['all','running','exited'].map(f=>(
                <button key={f} onClick={()=>{}} style={{padding:'4px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,fontSize:12,cursor:'pointer'}}>{f}</button>
              ))}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {docker.containers.map(c=>(
                <div key={c.id} style={{background:T.card,border:`0.5px solid ${c.status==='running'?csColor(c.status)+'33':T.border}`,borderRadius:8,padding:'14px 18px'}}>
                  <div style={{display:'flex',alignItems:'flex-start',gap:12}}>
                    {/* Status + name */}
                    <div style={{flexShrink:0,display:'flex',alignItems:'center',gap:8,minWidth:220}}>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                        <Dot color={csColor(c.status)} size={8}/>
                      </div>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:T.text}}>{c.name}</div>
                        <div style={{fontSize:10,color:T.muted,fontFamily:'monospace',marginTop:2}}>{c.id}</div>
                      </div>
                    </div>
                    {/* Image */}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,color:T.sec,marginBottom:2}}>Image</div>
                      <div style={{fontSize:12,color:T.text,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.image}</div>
                    </div>
                    {/* Ports */}
                    <div style={{flexShrink:0,minWidth:120}}>
                      <div style={{fontSize:11,color:T.sec,marginBottom:2}}>Ports</div>
                      {c.ports.length>0
                        ? c.ports.map((p,i)=><div key={i} style={{fontSize:11,fontFamily:'monospace',color:T.blue}}>{p.host_port}:{p.container_port}/{p.protocol}</div>)
                        : <span style={{fontSize:11,color:T.muted}}>—</span>
                      }
                    </div>
                    {/* CPU/Mem */}
                    <div style={{flexShrink:0,minWidth:140}}>
                      <div style={{marginBottom:6}}><div style={{fontSize:10,color:T.sec,marginBottom:3}}>CPU</div><MiniBar value={c.cpu_pct!==null?Math.round(c.cpu_pct):null} width={80}/></div>
                      <div><div style={{fontSize:10,color:T.sec,marginBottom:3}}>Memory</div><span style={{fontSize:11,color:T.text,fontFamily:'monospace'}}>{c.memory_mb!==null?c.memory_mb+' MB':'—'}</span></div>
                    </div>
                    {/* Status + compose */}
                    <div style={{flexShrink:0,textAlign:'right'}}>
                      <Pill label={c.status} color={csColor(c.status)}/>
                      {c.compose_project&&<div style={{fontSize:10,color:T.muted,marginTop:5,fontFamily:'monospace'}}>{c.compose_project}/{c.compose_service}</div>}
                      {c.restart_count>0&&<div style={{fontSize:10,color:T.amber,marginTop:3}}>↺ {c.restart_count} restart{c.restart_count!==1?'s':''}</div>}
                      {c.started_at&&<div style={{fontSize:10,color:T.muted,marginTop:3}}>up {fmtAge(c.started_at)}</div>}
                    </div>
                  </div>
                  {/* Actions */}
                  {c.status==='running'&&(
                    <div style={{display:'flex',gap:7,marginTop:12,paddingTop:10,borderTop:`0.5px solid ${T.border}`}}>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Exec shell</button>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Tail logs</button>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.amber}44`,background:`${T.amber}11`,color:T.amber,cursor:'pointer'}}>Restart</button>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer'}}>Stop</button>
                    </div>
                  )}
                  {c.status==='exited'&&(
                    <div style={{display:'flex',gap:7,marginTop:12,paddingTop:10,borderTop:`0.5px solid ${T.border}`}}>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.green}44`,background:`${T.green}11`,color:T.green,cursor:'pointer'}}>Start</button>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>View logs</button>
                      <button style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer'}}>Remove</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13}}>No Docker data — agent hasn't reported Docker state yet. Ensure the agent has access to <code style={{fontFamily:'monospace'}}>/var/run/docker.sock</code>.</div>
      )}

      {/* ── Volumes ── */}
      {tab==='volumes' && (
        docker ? (
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {docker.volumes.map(v=>(
              <div key={v.name} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'14px 18px',display:'flex',alignItems:'center',gap:16}}>
                <div style={{fontSize:22,flexShrink:0}}>💾</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:3}}>{v.name}</div>
                  <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.mountpoint}</div>
                </div>
                <div style={{flexShrink:0,textAlign:'center'}}>
                  <div style={{fontSize:11,color:T.sec,marginBottom:3}}>Driver</div>
                  <Pill label={v.driver} color={T.blue}/>
                </div>
                <div style={{flexShrink:0,textAlign:'center',minWidth:80}}>
                  <div style={{fontSize:11,color:T.sec,marginBottom:3}}>Size</div>
                  <div style={{fontSize:14,fontWeight:600,color:T.text}}>{fmtBytes(v.size_bytes)}</div>
                </div>
                <div style={{flexShrink:0}}>
                  <Pill label={v.in_use?'in use':'unused'} color={v.in_use?T.green:T.muted}/>
                </div>
                {!v.in_use&&<button style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer',flexShrink:0}}>Prune</button>}
              </div>
            ))}
          </div>
        ) : <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13}}>No volume data available.</div>
      )}

      {/* ── Networks ── */}
      {tab==='networks' && (
        docker ? (
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {docker.networks.map(n=>(
              <div key={n.id} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'16px 18px'}}>
                <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
                  <div style={{fontSize:20}}>🕸</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:3}}>{n.name}</div>
                    <div style={{display:'flex',gap:8}}>
                      <Pill label={n.driver} color={T.blue}/>
                      <Pill label={n.scope}  color={T.cyan}/>
                      {n.internal&&<Pill label="internal" color={T.purple}/>}
                    </div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:11,color:T.sec,marginBottom:3}}>Subnet</div>
                    <div style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{n.subnet||'—'}</div>
                  </div>
                  <div style={{textAlign:'right',minWidth:90}}>
                    <div style={{fontSize:11,color:T.sec,marginBottom:3}}>Gateway</div>
                    <div style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{n.gateway||'—'}</div>
                  </div>
                </div>
                <div style={{fontSize:11,color:T.sec,marginBottom:5}}>{n.containers.length} container{n.containers.length!==1?'s':''} attached</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {n.containers.map(cid=>{
                    const ctr = docker.containers.find(c=>c.id===cid);
                    return ctr ? (
                      <div key={cid} style={{display:'flex',alignItems:'center',gap:5,padding:'3px 8px',borderRadius:4,background:T.elevated,border:`0.5px solid ${T.border}`}}>
                        <Dot color={csColor(ctr.status)} size={5}/>
                        <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{ctr.name}</span>
                      </div>
                    ) : <span key={cid} style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{cid}</span>;
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13}}>No network data available.</div>
      )}

      {/* ── Images ── */}
      {tab==='images' && (
        docker ? (
          <div>
            <div style={{display:'flex',justifyContent:'flex-end',marginBottom:12}}>
              <button style={{fontSize:12,padding:'6px 14px',borderRadius:6,border:`0.5px solid ${T.amber}44`,background:`${T.amber}11`,color:T.amber,cursor:'pointer'}}>
                🧹 Prune unused ({docker.images.filter(i=>!i.in_use).length})
              </button>
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:7}}>
              {docker.images.map(img=>(
                <div key={img.id} style={{background:T.card,border:`0.5px solid ${img.in_use?T.border:T.border}`,borderRadius:8,padding:'12px 18px',display:'flex',alignItems:'center',gap:14,opacity:img.in_use?1:0.7}}>
                  <div style={{fontSize:18,flexShrink:0}}>📦</div>
                  <div style={{flex:1,minWidth:0}}>
                    {img.tags.map(tag=>(
                      <div key={tag} style={{fontSize:12,color:img.in_use?T.text:T.sec,fontFamily:'monospace',fontWeight:img.in_use?500:400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{tag}</div>
                    ))}
                    <div style={{fontSize:10,color:T.muted,fontFamily:'monospace',marginTop:3}}>{img.id.slice(0,19)}</div>
                  </div>
                  <div style={{flexShrink:0,textAlign:'right',minWidth:70}}>
                    <div style={{fontSize:11,color:T.sec,marginBottom:2}}>Size</div>
                    <div style={{fontSize:13,fontWeight:600,color:T.text}}>{fmtBytes(img.size_bytes)}</div>
                  </div>
                  <div style={{flexShrink:0,textAlign:'right',minWidth:80}}>
                    <div style={{fontSize:11,color:T.sec,marginBottom:2}}>Pulled</div>
                    <div style={{fontSize:12,color:T.muted}}>{fmtAge(img.created_at)}</div>
                  </div>
                  <div style={{flexShrink:0}}>
                    <Pill label={img.in_use?'in use':'unused'} color={img.in_use?T.green:T.muted}/>
                  </div>
                  {!img.in_use&&<button style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}44`,background:`${T.red}11`,color:T.red,cursor:'pointer',flexShrink:0}}>Remove</button>}
                </div>
              ))}
            </div>
            <div style={{marginTop:12,fontSize:12,color:T.sec,textAlign:'right'}}>
              Total: {fmtBytes(docker.images.reduce((a,i)=>a+i.size_bytes,0))} · {fmtBytes(docker.images.filter(i=>!i.in_use).reduce((a,i)=>a+i.size_bytes,0))} reclaimable
            </div>
          </div>
        ) : <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13}}>No image data available.</div>
      )}

      {/* ── Events ── */}
      {tab==='events' && (
        <div>
          {events.length===0
            ? <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13}}>No events recorded for this server.</div>
            : (
              <div style={{display:'flex',flexDirection:'column',gap:0,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,overflow:'hidden'}}>
                {events.map((ev,i)=>(
                  <div key={ev.id} style={{display:'flex',alignItems:'flex-start',gap:12,padding:'12px 18px',borderBottom:i<events.length-1?`0.5px solid ${T.border}`:'none'}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:evColor(ev.kind),flexShrink:0,marginTop:4}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                        <span style={{fontSize:12,fontFamily:'monospace',color:evColor(ev.kind)}}>{ev.kind}</span>
                        <span style={{fontSize:12,color:T.text}}>{ev.message}</span>
                      </div>
                      {Object.keys(ev.metadata).length>0&&(
                        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                          {Object.entries(ev.metadata).map(([k,v])=>(
                            <span key={k} style={{fontSize:10,color:T.muted,fontFamily:'monospace'}}>{k}=<span style={{color:T.sec}}>{String(v)}</span></span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',flexShrink:0,whiteSpace:'nowrap'}}>{fmtAge(ev.created_at)}</div>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      )}
    </div>
  );
}

function ServersView({onSelect, nav}) {
  const [dismissed, setDismissed] = useState(new Set());
  const fleetNotices = computeNotices().filter(n => n.category === 'fleet' && !dismissed.has(n.id));
  const [filter,setFilter]=useState('all');
  const filtered=filter==='all'?SERVERS:SERVERS.filter(s=>s.status===filter);
  return (
    <div style={{padding:'28px 30px'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div><h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Server Fleet</h2><p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>8 servers · 3 regions · hub-agent v1.2.3</p></div>
        <button onClick={()=>nav('provision')} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'8px 15px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Provision Server</button>
      </div>
      <NoticeBar notices={fleetNotices} onDismiss={id=>setDismissed(s=>new Set([...s,id]))}/>
      <div style={{display:'flex',gap:3,marginBottom:20,background:T.elevated,borderRadius:7,padding:4,width:'fit-content'}}>
        {['all','online','draining','unreachable','stopped'].map(f=><button key={f} onClick={()=>setFilter(f)} style={{padding:'5px 14px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===f?500:400,background:filter===f?T.card:'transparent',color:filter===f?T.text:T.sec}}>{f}</button>)}
      </div>
      <Table cols={['Server','Status','Role','Region','IP','CPU','Memory','Disk','Heartbeat','Ctrs','']} rows={filtered} renderRow={(s,i,n)=>(
        <TR key={s.id} i={i} total={n}>
          <TD>
            <button onClick={()=>onSelect&&onSelect(s)} style={{background:'none',border:'none',cursor:'pointer',padding:0,textAlign:'left'}}>
              <div style={{fontWeight:500,color:T.blue}}>{s.name}</div>
              <div style={{fontSize:10,color:T.muted,fontFamily:'monospace',marginTop:2}}>{s.id}</div>
            </button>
          </TD>
          <TD><div style={{display:'flex',alignItems:'center',gap:6}}><Dot color={sColor(s.status)} size={7}/><span style={{color:sColor(s.status),fontSize:12}}>{s.status}</span></div></TD>
          <TD><Pill label={s.role} color={rColor(s.role)}/></TD>
          <TD style={{color:T.sec,fontFamily:'monospace',fontSize:12}}>{s.region}</TD>
          <TD style={{color:T.sec,fontFamily:'monospace',fontSize:12}}>{s.ip}</TD>
          <TD style={{minWidth:80}}><Bar value={s.cpu}/></TD>
          <TD style={{minWidth:80}}><Bar value={s.mem}/></TD>
          <TD style={{minWidth:80}}><Bar value={s.disk}/></TD>
          <TD style={{color:T.sec,fontSize:12,fontFamily:'monospace',whiteSpace:'nowrap'}}>{s.beat} ago</TD>
          <TD style={{color:s.containers!==null?T.text:T.muted,fontSize:13}}>{s.containers!==null?s.containers:'—'}</TD>
          <TD><button onClick={()=>onSelect&&onSelect(s)} style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Open →</button></TD>
        </TR>
      )}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT / ENVIRONMENT / APP DATA
// ═══════════════════════════════════════════════════════════════════════════════

const APP_TYPE_ICON = { container:'📦', worker:'⚙', database:'🗄', cron:'⏰', static:'🌐' };
const APP_TYPE_COLOR = { container:T.blue, worker:T.cyan, database:T.purple, cron:T.amber, static:T.green };

const PROJECT_DATA = {
  p1: { // api-gateway
    envs: {
      production: {
        status:'healthy', server:'prod-web-01', lastDeploy:'2h ago',
        apps: [
          { id:'a1', name:'router',      type:'container', status:'running',  image:'registry/api-gateway:v1.9.0',  replicas:2, cpu:3,  mem:128, uptime:'5d 4h',  domain:'api.acme.com',        port:8080 },
          { id:'a2', name:'middleware',  type:'container', status:'running',  image:'registry/api-middleware:v2.1', replicas:1, cpu:1,  mem:64,  uptime:'5d 4h',  domain:null,                  port:9000 },
          { id:'a3', name:'auth-proxy',  type:'container', status:'running',  image:'registry/auth-proxy:v1.2',    replicas:1, cpu:0.5,mem:48,  uptime:'5d 4h',  domain:null,                  port:9001 },
          { id:'a4', name:'admin-api',   type:'container', status:'running',  image:'registry/api-admin:v1.1',     replicas:1, cpu:1,  mem:80,  uptime:'2d 1h',  domain:'admin-api.acme.com',  port:8090 },
        ],
      },
      staging: {
        status:'healthy', server:'stg-app-01', lastDeploy:'1d ago',
        apps: [
          { id:'a5', name:'router',      type:'container', status:'running',  image:'registry/api-gateway:v1.10.0-rc', replicas:1, cpu:1, mem:112, uptime:'1d 2h', domain:'api-stg.acme.com', port:8080 },
          { id:'a6', name:'middleware',  type:'container', status:'running',  image:'registry/api-middleware:v2.2-rc', replicas:1, cpu:0.5,mem:60, uptime:'1d 2h', domain:null, port:9000 },
          { id:'a7', name:'auth-proxy',  type:'container', status:'running',  image:'registry/auth-proxy:v1.2',        replicas:1, cpu:0.2,mem:44, uptime:'1d 2h', domain:null, port:9001 },
          { id:'a8', name:'admin-api',   type:'container', status:'stopped',  image:'registry/api-admin:v1.1',         replicas:0, cpu:0,  mem:0,  uptime:null,    domain:null, port:8090 },
        ],
      },
      development: {
        status:'healthy', server:'dev-sandbox-01', lastDeploy:'3h ago',
        apps: [
          { id:'a9',  name:'router',     type:'container', status:'running',  image:'registry/api-gateway:dev',  replicas:1, cpu:0.8, mem:98, uptime:'3h', domain:'localhost:8080', port:8080 },
          { id:'a10', name:'middleware', type:'container', status:'running',  image:'registry/api-middleware:dev', replicas:1, cpu:0.3, mem:52, uptime:'3h', domain:null, port:9000 },
        ],
      },
    },
  },
  p2: { // dashboard
    envs: {
      production: {
        status:'healthy', server:'prod-web-01', lastDeploy:'14m ago',
        apps: [
          { id:'b1', name:'web',    type:'container', status:'running',   image:'registry/dashboard:v2.14.1', replicas:2, cpu:7, mem:310, uptime:'14m', domain:'app.acme.com',  port:3000 },
          { id:'b2', name:'worker', type:'worker',    status:'running',   image:'registry/dash-worker:v1.3',  replicas:1, cpu:1, mem:88,  uptime:'5d',  domain:null,            port:null },
        ],
      },
      staging: {
        status:'deploying', server:'stg-app-01', lastDeploy:'3m ago',
        apps: [
          { id:'b3', name:'web',    type:'container', status:'deploying', image:'registry/dashboard:v2.14.2-rc', replicas:1, cpu:6,   mem:295, uptime:'3m',  domain:'app-stg.acme.com', port:3001 },
          { id:'b4', name:'worker', type:'worker',    status:'running',   image:'registry/dash-worker:v1.3',     replicas:1, cpu:0.8, mem:82,  uptime:'2d',  domain:null, port:null },
        ],
      },
      development: {
        status:'healthy', server:'dev-sandbox-01', lastDeploy:'6h ago',
        apps: [
          { id:'b5', name:'web', type:'container', status:'running', image:'registry/dashboard:dev', replicas:1, cpu:2, mem:190, uptime:'6h', domain:'localhost:3000', port:3000 },
        ],
      },
    },
  },
  p3: { // data-pipeline
    envs: {
      production: {
        status:'degraded', server:'prod-worker-01', lastDeploy:'1d ago',
        apps: [
          { id:'c1', name:'worker',      type:'worker',    status:'running',  image:'registry/data-pipeline:v3.2.1', replicas:2, cpu:5, mem:420, uptime:'0m', domain:null, port:null },
          { id:'c2', name:'scheduler',   type:'cron',      status:'running',  image:'registry/scheduler:v1.4',       replicas:1, cpu:0.5,mem:60, uptime:'5d', domain:null, port:null },
          { id:'c3', name:'transformer', type:'container', status:'running',  image:'registry/transformer:v2.0',     replicas:2, cpu:8, mem:512, uptime:'5d', domain:null, port:4000 },
          { id:'c4', name:'indexer',     type:'worker',    status:'stopped',  image:'registry/indexer:v1.1',         replicas:0, cpu:0, mem:0,   uptime:null, domain:null, port:null },
          { id:'c5', name:'reporter',    type:'container', status:'running',  image:'registry/reporter:v1.0',        replicas:1, cpu:1, mem:128, uptime:'5d', domain:'reports.acme.com', port:5000 },
          { id:'c6', name:'exporter',    type:'container', status:'running',  image:'registry/exporter:v0.9',        replicas:1, cpu:0.8,mem:90, uptime:'5d', domain:null, port:9090 },
        ],
      },
      staging: {
        status:'healthy', server:'stg-app-01', lastDeploy:'2d ago',
        apps: [
          { id:'c7', name:'worker',      type:'worker',    status:'running',  image:'registry/data-pipeline:v3.2.0', replicas:1, cpu:3, mem:280, uptime:'2d', domain:null, port:null },
          { id:'c8', name:'scheduler',   type:'cron',      status:'running',  image:'registry/scheduler:v1.4',       replicas:1, cpu:0.3,mem:55, uptime:'2d', domain:null, port:null },
          { id:'c9', name:'transformer', type:'container', status:'running',  image:'registry/transformer:v2.0',     replicas:1, cpu:4, mem:300, uptime:'2d', domain:null, port:4000 },
        ],
      },
      development: {
        status:'healthy', server:'dev-sandbox-01', lastDeploy:'3d ago',
        apps: [
          { id:'c10', name:'worker', type:'worker', status:'stopped', image:'registry/data-pipeline:dev', replicas:0, cpu:0, mem:0, uptime:null, domain:null, port:null },
        ],
      },
    },
  },
};

// Per-app env vars (shared pattern — in real app these are per-environment)
const APP_ENV_VARS = {
  a1: [
    { key:'NODE_ENV',         value:'production',           secret:false },
    { key:'PORT',             value:'8080',                 secret:false },
    { key:'LOG_LEVEL',        value:'info',                 secret:false },
    { key:'DATABASE_URL',     value:'••••••••••••••••••••', secret:true  },
    { key:'REDIS_URL',        value:'••••••••••••••••••••', secret:true  },
    { key:'JWT_SECRET',       value:'••••••••••••••••••••', secret:true  },
    { key:'HUB_WORKSPACE_ID', value:'ws_acme_prod',         secret:false },
    { key:'SENTRY_DSN',       value:'https://xxx@sentry.io/123', secret:false },
  ],
  b1: [
    { key:'NODE_ENV',        value:'production',                  secret:false },
    { key:'PORT',            value:'3000',                        secret:false },
    { key:'API_URL',         value:'https://api.acme.com',        secret:false },
    { key:'AUTH_SECRET',     value:'••••••••••••••••••••',        secret:true  },
    { key:'DATABASE_URL',    value:'••••••••••••••••••••',        secret:true  },
    { key:'NEXT_PUBLIC_ENV', value:'production',                  secret:false },
    { key:'RESEND_API_KEY',  value:'••••••••••••••••••••',        secret:true  },
  ],
};

// Per-app deploy history
const APP_DEPLOYS = {
  a1: [
    { id:'x1', version:'v1.9.0', status:'success', by:'james', ago:'2h ago',  commit:'c4a1d55', duration:'1m 42s' },
    { id:'x2', version:'v1.8.5', status:'success', by:'ci-bot',ago:'2d ago',  commit:'b3f0e44', duration:'1m 38s' },
    { id:'x3', version:'v1.8.4', status:'failed',  by:'ci-bot',ago:'3d ago',  commit:'a2e9d33', duration:'28s'    },
    { id:'x4', version:'v1.8.3', status:'success', by:'james', ago:'5d ago',  commit:'99c8b22', duration:'1m 51s' },
  ],
  b1: [
    { id:'y1', version:'v2.14.1', status:'success', by:'sarah',  ago:'14m ago', commit:'a3f2c91', duration:'2m 14s' },
    { id:'y2', version:'v2.14.0', status:'success', by:'ci-bot', ago:'1d ago',  commit:'92e1b80', duration:'2m 01s' },
    { id:'y3', version:'v2.13.9', status:'success', by:'sarah',  ago:'3d ago',  commit:'81d0a79', duration:'1m 58s' },
  ],
};

// ─── App type create options ───────────────────────────────────────────────────
const NEW_APP_TYPES = [
  { id:'container', label:'Container',  icon:'📦', desc:'Stateless HTTP service. Auto-restarts, health-checked.' },
  { id:'worker',    label:'Worker',     icon:'⚙',  desc:'Long-running background process. No inbound traffic.' },
  { id:'database',  label:'Database',   icon:'🗄',  desc:'Persistent data store. Volumes auto-mounted, port exposed on mesh only.' },
  { id:'cron',      label:'Cron job',   icon:'⏰', desc:'Scheduled task. Define a cron expression.' },
  { id:'static',    label:'Static site',icon:'🌐', desc:'Serve a built static bundle via nginx.' },
];

// ─── Git repo + log mock data ──────────────────────────────────────────────────
const APP_GIT = {
  b1: {
    provider:'forgejo', repo:'acme/dashboard', branch:'main',
    auto_deploy:true, deploy_on_push:true,
    last_push:{ sha:'b7d8e02', msg:'feat: add dark mode toggle', author:'sarah', at:'3m ago' },
    webhooks_url:'https://hub.acme.com/api/webhooks/git/app-b1',
    deploy_preview:false,
    branch_deploys:[ {branch:'main',env:'production'},{branch:'staging',env:'staging'},{branch:'dev',env:'development'} ],
  },
  a1: {
    provider:'forgejo', repo:'acme/api-gateway', branch:'main',
    auto_deploy:true, deploy_on_push:true,
    last_push:{ sha:'c4a1d55', msg:'fix: rate limit header handling', author:'james', at:'2h ago' },
    webhooks_url:'https://hub.acme.com/api/webhooks/git/app-a1',
    deploy_preview:false,
    branch_deploys:[ {branch:'main',env:'production'},{branch:'staging',env:'staging'} ],
  },
};

// Mock log lines for live tail simulation
const MOCK_LOG_LINES = [
  {ts:'12:41:03.214', stream:'stdout', msg:'GET /api/users 200 14ms'},
  {ts:'12:41:02.988', stream:'stdout', msg:'POST /api/deployments 201 32ms'},
  {ts:'12:41:02.701', stream:'stdout', msg:'Cache hit: session:usr_x7k2m9 (0.2ms)'},
  {ts:'12:41:02.100', stream:'stderr', msg:'Warning: deprecated API endpoint /api/v1/status called'},
  {ts:'12:41:01.550', stream:'stdout', msg:'GET /api/servers 200 8ms'},
  {ts:'12:41:01.312', stream:'stdout', msg:'WebSocket client connected: ws://10.0.1.10/ws (total: 7)'},
  {ts:'12:41:00.890', stream:'stdout', msg:'Healthcheck: OK {"status":"ok","version":"v2.14.1","uptime":86402}'},
  {ts:'12:41:00.445', stream:'stdout', msg:'GET /api/projects 200 12ms'},
  {ts:'12:40:59.991', stream:'stdout', msg:'Rate limit: 0/100 (usr_x7k2m9)'},
  {ts:'12:40:59.203', stream:'stdout', msg:'POST /api/servers/s3/heartbeat 200 4ms'},
  {ts:'12:40:58.812', stream:'stderr', msg:'Error: connection pool at 80% capacity (16/20)'},
  {ts:'12:40:58.100', stream:'stdout', msg:'GET /api/deployments?limit=20 200 22ms'},
  {ts:'12:40:57.400', stream:'stdout', msg:'Deployment event: dashboard/web@staging → running'},
  {ts:'12:40:56.800', stream:'stdout', msg:'GET /health 200 1ms'},
];

const MORE_LOG_LINES = [
  'Auth token validated: usr_x7k2m9 (scope: read:all)',
  'Scheduler: next run in 420s (cache-warm)',
  'GET /api/ssh-keys 200 7ms',
  'Conduit: agent heartbeat — prod-web-01 (cpu:23% mem:61%)',
  'GET /api/alert-rules 200 9ms',
  'Job queued: notifications/send_digest',
  'Webhook delivered: deploy-webhook (200, 142ms)',
  'GET /api/portal 200 18ms',
  'Rate limit check: 12/100 (ci-bot)',
  'Deployment step: start container web-app-1 → success',
];

// Mock database connection data
const DB_APP_DATA = {
  c3: { // data-pipeline transformer (pretend it's a DB for demo)
    engine:'postgres', version:'16', port:5432,
    db_name:'pipeline_db', db_user:'pipeline',
    conn_string:'postgresql://pipeline:••••••••@prod-db-01:5432/pipeline_db',
    conn_string_plain:'postgresql://pipeline:s3cr3t@100.64.0.10:5432/pipeline_db',
    volume_name:'pipeline_data', volume_size:'14.2 GB', volume_path:'/var/lib/postgresql/data',
    backup_schedule:'0 2 * * *', last_backup:'2h ago', backup_size:'1.8 GB',
    metrics:{ connections:8, max_connections:100, db_size_mb:14540, cache_hit_rate:94, tx_per_sec:142, slow_queries:0 },
  },
};

// ─── SSL / Domain data ─────────────────────────────────────────────────────────

const APP_DOMAINS = {
  // dashboard/web (b1) — production, two domains, one cert active
  b1: {
    domains: [
      {
        id:'dom1', hostname:'app.acme.com', primary:true,
        cf_proxy:true, cf_ssl_mode:'Full (strict)',
        cert:{
          id:'cert1', kind:'cloudflare_origin',
          status:'active',
          issued:'2024-01-12', expires:'2039-01-12',
          days_remaining:5112,
          cert_path:'/etc/ssl/certs/acme-app.pem',
          key_path:'/etc/ssl/private/acme-app.key',
          deployed_to:['prod-web-01','prod-web-02'],
          nginx_reload:'14d ago',
        },
        nginx_port:443,
      },
      {
        id:'dom2', hostname:'www.acme.com', primary:false,
        cf_proxy:true, cf_ssl_mode:'Full (strict)',
        cert:null, // same cert — redirect to app.acme.com
        nginx_port:443,
        redirect_to:'app.acme.com',
      },
    ],
  },
  // api-gateway/router (a1) — one domain, cert active
  a1: {
    domains: [
      {
        id:'dom3', hostname:'api.acme.com', primary:true,
        cf_proxy:true, cf_ssl_mode:'Full (strict)',
        cert:{
          id:'cert2', kind:'cloudflare_origin',
          status:'expiring_soon',
          issued:'2023-06-01', expires:'2025-06-01',
          days_remaining:77,
          cert_path:'/etc/ssl/certs/acme-api.pem',
          key_path:'/etc/ssl/private/acme-api.key',
          deployed_to:['prod-web-01'],
          nginx_reload:'3d ago',
        },
        nginx_port:443,
      },
    ],
  },
  // admin-api (a4) — no cert yet
  a4: {
    domains: [
      {
        id:'dom4', hostname:'admin-api.acme.com', primary:true,
        cf_proxy:true, cf_ssl_mode:'Full (strict)',
        cert:null,
        nginx_port:443,
      },
    ],
  },
};

const CERT_STATUS_COLOR = {
  active:        T.green,
  expiring_soon: T.amber,
  expired:       T.red,
  pending:       T.blue,
  none:          T.muted,
};

const NGINX_TEMPLATE = (hostname, certPath, keyPath, proxyPort) =>
`server {
    listen 443 ssl http2;
    server_name ${hostname};

    ssl_certificate     ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # Cloudflare origin — only trust CF IP ranges
    # (managed separately via cloudflare-ips.conf)
    include /etc/nginx/cloudflare-ips.conf;

    location / {
        proxy_pass         http://127.0.0.1:${proxyPort};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $http_cf_connecting_ip;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name ${hostname};
    return 301 https://$host$request_uri;
}`;

function parsePem(text) {
  const t = text.trim();
  if (t.startsWith('-----BEGIN CERTIFICATE-----') || t.startsWith('-----BEGIN ORIGIN CERTIFICATE-----')) return { ok:true, kind:'cert' };
  if (t.startsWith('-----BEGIN PRIVATE KEY-----') || t.startsWith('-----BEGIN EC PRIVATE KEY-----') || t.startsWith('-----BEGIN RSA PRIVATE KEY-----')) return { ok:true, kind:'key' };
  return { ok:false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE APP MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function CreateAppModal({ project, env, onClose, onCreated }) {
  const [mode, setMode]         = useState('choice'); // 'choice' | 'scratch' | 'blueprint'
  const [selectedBp, setSelBp]  = useState(null);
  const [name, setName]         = useState('');
  const [hasData, setHasData]   = useState(null); // null | true | false
  const [nameError, setNameError] = useState('');

  const create = () => {
    if (!name.trim()) { setNameError('App name is required'); return; }
    if (!/^[a-z0-9-]+$/.test(name.trim())) { setNameError('Lowercase letters, numbers, and hyphens only'); return; }
    const newApp = {
      id: 'app-' + Date.now(),
      name: name.trim(),
      type: hasData ? 'database' : 'container',
      status: 'stopped',
      image: '',
      replicas: 1,
      cpu: 0,
      mem: 0,
      uptime: null,
      domain: null,
      port: 3000,
      persistent: hasData === true,
    };
    onCreated(newApp);
    onClose();
  };

  // If blueprint selected, render BlueprintDeployModal instead
  if (mode==='blueprint' && selectedBp) {
    return <BlueprintDeployModal blueprint={selectedBp} project={project} env={env} onClose={onClose} onCreated={onCreated}/>;
  }

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:mode==='choice'?520:420,overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:T.text}}>
              {mode==='choice'?'New app':mode==='scratch'?'New app — from scratch':''}
            </div>
            <div style={{fontSize:12,color:T.sec,marginTop:2}}>{project.name} · {env}</div>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {mode!=='choice'&&<button onClick={()=>setMode('choice')} style={{fontSize:12,color:T.blue,background:'none',border:'none',cursor:'pointer'}}>← back</button>}
            <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
          </div>
        </div>

        {/* Choice screen */}
        {mode==='choice'&&(
          <div style={{padding:'22px'}}>
            <div style={{fontSize:13,color:T.sec,marginBottom:16}}>How do you want to set up this app?</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:20}}>
              <button onClick={()=>setMode('scratch')} style={{padding:'20px 16px',borderRadius:9,border:`1px solid ${T.border}`,background:T.card,cursor:'pointer',textAlign:'left',display:'flex',flexDirection:'column',gap:8}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.borderMd}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:26}}>✦</span>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>From scratch</div>
                <div style={{fontSize:11,color:T.muted,lineHeight:'16px'}}>Name your app, choose storage, configure everything yourself.</div>
              </button>
              <button onClick={()=>setMode('blueprint')} style={{padding:'20px 16px',borderRadius:9,border:`1px solid ${T.green}44`,background:`${T.green}08`,cursor:'pointer',textAlign:'left',display:'flex',flexDirection:'column',gap:8}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.green+'88'}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.green+'44'}>
                <span style={{fontSize:26}}>🧩</span>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>Use a blueprint</div>
                <div style={{fontSize:11,color:T.muted,lineHeight:'16px'}}>Pick a pre-configured template — n8n, Postgres, Redis, and more.</div>
              </button>
            </div>
            <button onClick={onClose} style={{background:'none',border:'none',color:T.muted,fontSize:12,cursor:'pointer',padding:0}}>Cancel</button>
          </div>
        )}

        {/* Blueprint picker inline */}
        {mode==='blueprint'&&!selectedBp&&(
          <div style={{padding:'16px 22px',flex:1,overflowY:'auto',maxHeight:'60vh'}}>
            <div style={{fontSize:12,color:T.sec,marginBottom:12}}>Pick a blueprint to deploy:</div>
            <div style={{display:'flex',flexDirection:'column',gap:7}}>
              {BLUEPRINTS.map(bp=>(
                <button key={bp.id} onClick={()=>setSelBp(bp)} style={{display:'flex',alignItems:'center',gap:12,padding:'11px 14px',borderRadius:8,border:`1px solid ${T.border}`,background:T.card,cursor:'pointer',textAlign:'left'}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=bp.color+'66'}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                  <div style={{width:32,height:32,borderRadius:7,background:`${bp.color}15`,border:`1px solid ${bp.color}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{bp.icon}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:2}}>{bp.name}</div>
                    <div style={{fontSize:11,color:T.muted}}>{bp.desc}</div>
                  </div>
                  <span style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:`${bp.color}12`,color:bp.color,border:`0.5px solid ${bp.color}33`}}>{bp.category}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* From scratch form */}
        {mode==='scratch'&&(
          <>
            <div style={{padding:'22px 22px 20px'}}>
              <Input label="App name" value={name} onChange={e=>{setName(e.target.value);setNameError('');}} placeholder="web" hint="Lowercase, hyphens only. Unique within this environment." error={nameError}/>
              <div style={{marginBottom:4}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:10,fontWeight:500}}>Does this app need persistent data storage?</label>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <button onClick={()=>setHasData(false)} style={{padding:'14px 12px',borderRadius:8,border:`1.5px solid ${hasData===false?T.blue:T.border}`,background:hasData===false?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'center'}}>
                    <div style={{fontSize:22,marginBottom:6}}>📦</div>
                    <div style={{fontSize:13,fontWeight:600,color:hasData===false?T.blue:T.text,marginBottom:3}}>No</div>
                    <div style={{fontSize:11,color:T.muted,lineHeight:'15px'}}>Stateless — containers, workers, crons</div>
                  </button>
                  <button onClick={()=>setHasData(true)} style={{padding:'14px 12px',borderRadius:8,border:`1.5px solid ${hasData===true?T.purple:T.border}`,background:hasData===true?`${T.purple}12`:T.elevated,cursor:'pointer',textAlign:'center'}}>
                    <div style={{fontSize:22,marginBottom:6}}>🗄</div>
                    <div style={{fontSize:13,fontWeight:600,color:hasData===true?T.purple:T.text,marginBottom:3}}>Yes</div>
                    <div style={{fontSize:11,color:T.muted,lineHeight:'15px'}}>Persistent — databases, file stores</div>
                  </button>
                </div>
                {hasData===false&&<div style={{marginTop:8,fontSize:11,color:T.muted,padding:'6px 10px',background:T.elevated,borderRadius:5}}>Data does not survive container restarts.</div>}
                {hasData===true&&<div style={{marginTop:8,fontSize:11,color:T.muted,padding:'6px 10px',background:T.elevated,borderRadius:5}}>A persistent volume will be mounted.</div>}
              </div>
            </div>
            <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
              <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
              <button onClick={create} disabled={hasData===null||!name.trim()} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 24px',color:'#fff',fontSize:13,fontWeight:600,cursor:hasData!==null&&name.trim()?'pointer':'not-allowed',opacity:hasData!==null&&name.trim()?1:0.4}}>
                Create &amp; configure →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// APP DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Domains & SSL tab ────────────────────────────────────────────────────────

function UploadCertModal({ domain, onClose, onSave }) {
  const toast = useToast();
  const [certPem, setCertPem] = useState('');
  const [keyPem,  setKeyPem]  = useState('');
  const [showNginx, setShowNginx] = useState(false);
  const [applying, setApplying]   = useState(false);

  const certOk = parsePem(certPem).ok && parsePem(certPem).kind === 'cert';
  const keyOk  = parsePem(keyPem).ok  && parsePem(keyPem).kind  === 'key';
  const valid  = certOk && keyOk;

  const certPath = `/etc/ssl/certs/${domain.hostname.replace(/\./g,'-')}.pem`;
  const keyPath  = `/etc/ssl/private/${domain.hostname.replace(/\./g,'-')}.key`;
  const nginxBlock = NGINX_TEMPLATE(domain.hostname, certPath, keyPath, domain.nginx_port||3000);

  const apply = () => {
    setApplying(true);
    setTimeout(() => {
      setApplying(false);
      toast.success('SSL configured', `${domain.hostname} — cert uploaded, nginx reloaded.`);
      onSave({
        kind:'cloudflare_origin',
        status:'active',
        issued: new Date().toISOString().slice(0,10),
        expires:'2039-01-01',
        days_remaining: 5115,
        cert_path: certPath,
        key_path:  keyPath,
        deployed_to:['prod-web-01'],
        nginx_reload:'just now',
      });
      onClose();
    }, 1800);
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:640,maxHeight:'92vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>

        {/* Header */}
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:T.text}}>Configure SSL — {domain.hostname}</div>
            <div style={{fontSize:12,color:T.sec,marginTop:3}}>Paste Cloudflare Origin Certificate + private key</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>

          {/* Instructions */}
          <div style={{background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:8,padding:'12px 16px',marginBottom:20}}>
            <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:6}}>How to get your Cloudflare Origin Certificate</div>
            <ol style={{margin:0,padding:'0 0 0 18px',fontSize:12,color:T.sec,lineHeight:'20px'}}>
              <li>Cloudflare Dashboard → your domain → <strong style={{color:T.text}}>SSL/TLS → Origin Server</strong></li>
              <li>Click <strong style={{color:T.text}}>Create Certificate</strong> → choose RSA or ECDSA → 15 years</li>
              <li>Copy the <strong style={{color:T.text}}>Origin Certificate</strong> (PEM) and <strong style={{color:T.text}}>Private Key</strong> below</li>
              <li>Set Cloudflare SSL mode to <strong style={{color:T.text}}>Full (strict)</strong></li>
            </ol>
          </div>

          {/* Cert paste */}
          <div style={{marginBottom:16}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
              <label style={{fontSize:12,color:T.sec,fontWeight:500}}>Origin Certificate (PEM)</label>
              {certPem && (
                <span style={{fontSize:11,color:certOk?T.green:T.red,fontWeight:500}}>
                  {certOk ? '✓ Valid certificate' : '✗ Not a valid certificate'}
                </span>
              )}
            </div>
            <textarea
              value={certPem}
              onChange={e=>setCertPem(e.target.value)}
              placeholder={'-----BEGIN CERTIFICATE-----\nMIIE...\n-----END CERTIFICATE-----'}
              rows={6}
              style={{width:'100%',boxSizing:'border-box',background:T.elevated,border:`0.5px solid ${certPem?(certOk?T.green+'66':T.red+'66'):T.borderMd}`,borderRadius:6,padding:'9px 12px',fontSize:11,fontFamily:'monospace',color:T.text,outline:'none',resize:'vertical',lineHeight:'18px'}}
              onFocus={e=>e.target.style.borderColor=T.blue}
              onBlur={e=>e.target.style.borderColor=certPem?(certOk?T.green+'66':T.red+'66'):T.borderMd}
            />
          </div>

          {/* Key paste */}
          <div style={{marginBottom:20}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
              <label style={{fontSize:12,color:T.sec,fontWeight:500}}>Private Key (PEM)</label>
              {keyPem && (
                <span style={{fontSize:11,color:keyOk?T.green:T.red,fontWeight:500}}>
                  {keyOk ? '✓ Valid private key' : '✗ Not a valid private key'}
                </span>
              )}
            </div>
            <textarea
              value={keyPem}
              onChange={e=>setKeyPem(e.target.value)}
              placeholder={'-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----'}
              rows={6}
              style={{width:'100%',boxSizing:'border-box',background:T.elevated,border:`0.5px solid ${keyPem?(keyOk?T.green+'66':T.red+'66'):T.borderMd}`,borderRadius:6,padding:'9px 12px',fontSize:11,fontFamily:'monospace',color:T.text,outline:'none',resize:'vertical',lineHeight:'18px'}}
              onFocus={e=>e.target.style.borderColor=T.blue}
              onBlur={e=>e.target.style.borderColor=keyPem?(keyOk?T.green+'66':T.red+'66'):T.borderMd}
            />
            <div style={{fontSize:11,color:T.muted,marginTop:5}}>
              ⚠ The private key is transmitted to the server via hub-agent over HMAC-signed Conduit. It is never logged or stored in the Hub database.
            </div>
          </div>

          {/* Nginx preview */}
          <div>
            <button
              onClick={()=>setShowNginx(v=>!v)}
              style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0,marginBottom:8}}>
              <span style={{fontSize:10}}>{showNginx?'▼':'▶'}</span>
              {showNginx?'Hide':'Preview'} generated nginx config
            </button>
            {showNginx && (
              <div style={{background:'#090b11',borderRadius:8,padding:'14px 16px',fontFamily:'monospace',fontSize:11,color:T.sec,whiteSpace:'pre',overflowX:'auto',lineHeight:'18px',border:`0.5px solid ${T.border}`}}>
                {nginxBlock.split('\n').map((line,i)=>{
                  const c = line.match(/^\s*#/)  ? T.muted
                    : line.match(/\bssl_\w+|listen|server_name|proxy_pass|location|include/)  ? T.blue
                    : line.match(/\$\w+|http_cf_connecting_ip/)  ? T.amber
                    : line.match(/https?:|return /)  ? T.green
                    : T.sec;
                  return <div key={i} style={{color:c}}>{line||'\u00a0'}</div>;
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
          <button
            onClick={apply}
            disabled={!valid||applying}
            style={{display:'flex',alignItems:'center',gap:8,background:valid?T.green:T.elevated,border:'none',borderRadius:6,padding:'9px 22px',color:valid?'#111':T.muted,fontSize:13,fontWeight:700,cursor:valid?'pointer':'not-allowed',opacity:applying?0.7:1,transition:'background 0.15s'}}>
            {applying
              ? <><span style={{display:'inline-block',width:13,height:13,border:`2px solid #111`,borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Applying…</>
              : '⚡ Upload & apply to server'}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function DomainsSslTab({ app, domainData, setDomainData }) {
  const toast = useToast();
  const [uploadFor, setUploadFor] = useState(null);   // domain being configured
  const [showNginxFor, setNginxFor] = useState(null); // domain nginx preview
  const [newHostname, setNewHostname] = useState('');
  const [adding, setAdding] = useState(false);

  const certStatusLabel = c => ({active:'Active',expiring_soon:'Expiring soon',expired:'Expired',pending:'Pending'}[c?.status||'none']||'No cert');
  const certStatusColor = c => CERT_STATUS_COLOR[c?.status||'none'];

  const addDomain = () => {
    if (!newHostname.trim() || !newHostname.includes('.')) { toast.error('Invalid hostname','Enter a valid hostname like app.acme.com'); return; }
    const dup = domainData.domains.find(d=>d.hostname===newHostname.trim());
    if (dup) { toast.warning('Already exists',`${newHostname} is already configured.`); return; }
    setDomainData(dd=>({...dd,domains:[...dd.domains,{id:'dom'+Date.now(),hostname:newHostname.trim(),primary:false,cf_proxy:true,cf_ssl_mode:'Full (strict)',cert:null,nginx_port:app.port||3000}]}));
    setNewHostname('');
    setAdding(false);
    toast.success('Domain added',`${newHostname} — configure SSL to go live.`);
  };

  const removeDomain = (d) => {
    if (d.primary) { toast.error('Cannot remove primary domain','Assign another domain as primary first.'); return; }
    setDomainData(dd=>({...dd,domains:dd.domains.filter(x=>x.id!==d.id)}));
    toast.warning('Domain removed',d.hostname);
  };

  const onCertSaved = (domainId, cert) => {
    setDomainData(dd=>({...dd,domains:dd.domains.map(d=>d.id===domainId?{...d,cert:{...cert,id:'cert'+Date.now()}}:d)}));
  };

  return (
    <div>
      {uploadFor && (
        <UploadCertModal
          domain={uploadFor}
          onClose={()=>setUploadFor(null)}
          onSave={cert=>{ onCertSaved(uploadFor.id, cert); setUploadFor(null); }}
        />
      )}

      {/* Domain list */}
      <div style={{display:'flex',flexDirection:'column',gap:12,marginBottom:20}}>
        {domainData.domains.map(dom=>{
          const cert = dom.cert;
          const sc   = certStatusColor(cert);
          const isNginxOpen = showNginxFor === dom.id;
          const nginxBlock  = cert ? NGINX_TEMPLATE(dom.hostname, cert.cert_path, cert.key_path, dom.nginx_port||3000) : null;

          return (
            <div key={dom.id} style={{background:T.card,border:`0.5px solid ${cert?sc+'44':T.border}`,borderRadius:10,overflow:'hidden'}}>

              {/* Domain header row */}
              <div style={{padding:'16px 20px',display:'flex',alignItems:'flex-start',gap:14}}>
                {/* Icon */}
                <div style={{width:40,height:40,borderRadius:9,background:cert?`${sc}12`:T.elevated,border:`1px solid ${cert?sc+'44':T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,flexShrink:0}}>
                  {cert ? (cert.status==='expiring_soon'?'⚠':'🔒') : '🔓'}
                </div>

                {/* Hostname + meta */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                    <a href={`https://${dom.hostname}`} target="_blank" rel="noreferrer" style={{fontSize:15,fontWeight:700,color:T.blue,textDecoration:'none'}}>{dom.hostname} ↗</a>
                    {dom.primary&&<Pill label="primary" color={T.blue}/>}
                    {dom.redirect_to&&<Pill label={`→ ${dom.redirect_to}`} color={T.sec}/>}
                  </div>

                  <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                    {/* Cloudflare proxy */}
                    <div style={{display:'flex',alignItems:'center',gap:5}}>
                      <span style={{fontSize:13}}>☁</span>
                      <span style={{fontSize:11,color:dom.cf_proxy?T.amber:T.muted}}>{dom.cf_proxy?'CF proxy on':'CF proxy off'}</span>
                    </div>
                    {/* SSL mode */}
                    <div style={{display:'flex',alignItems:'center',gap:5}}>
                      <Pill label={dom.cf_ssl_mode||'—'} color={T.sec}/>
                    </div>
                    {/* Cert status */}
                    <div style={{display:'flex',alignItems:'center',gap:5}}>
                      <Dot color={sc} size={6}/>
                      <span style={{fontSize:11,color:sc,fontWeight:500}}>{certStatusLabel(cert)}</span>
                      {cert&&<span style={{fontSize:11,color:T.muted}}>· expires {cert.expires}</span>}
                      {cert?.days_remaining<=90&&<span style={{fontSize:11,color:T.amber,fontWeight:600}}>· {cert.days_remaining}d left</span>}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div style={{display:'flex',gap:7,flexShrink:0}}>
                  <button
                    onClick={()=>setUploadFor(dom)}
                    style={{fontSize:12,padding:'6px 14px',borderRadius:6,border:'none',background:cert?T.elevated:T.green,color:cert?T.sec:'#111',cursor:'pointer',fontWeight:cert?400:600}}>
                    {cert ? '↺ Replace cert' : '🔒 Configure SSL'}
                  </button>
                  {cert&&(
                    <button
                      onClick={()=>setNginxFor(isNginxOpen?null:dom.id)}
                      style={{fontSize:12,padding:'6px 12px',borderRadius:6,border:`0.5px solid ${isNginxOpen?T.borderMd:T.border}`,background:isNginxOpen?T.elevated:'none',color:T.sec,cursor:'pointer'}}>
                      nginx {isNginxOpen?'▲':'▼'}
                    </button>
                  )}
                  {!dom.primary&&(
                    <button onClick={()=>removeDomain(dom)} style={{fontSize:12,padding:'6px 12px',borderRadius:6,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Remove</button>
                  )}
                </div>
              </div>

              {/* Cert detail strip */}
              {cert && (
                <div style={{display:'flex',gap:0,borderTop:`0.5px solid ${T.border}`,background:T.elevated}}>
                  {[
                    ['Type',         cert.kind==='cloudflare_origin'?'Cloudflare Origin':'Custom'],
                    ['Cert path',    cert.cert_path],
                    ['Key path',     cert.key_path],
                    ['Deployed to',  cert.deployed_to?.join(', ')||'—'],
                    ['nginx reload', cert.nginx_reload],
                  ].map(([k,v],i,arr)=>(
                    <div key={k} style={{flex:1,padding:'9px 14px',borderRight:i<arr.length-1?`0.5px solid ${T.border}`:'none'}}>
                      <div style={{fontSize:9,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>{k}</div>
                      <div style={{fontSize:11,color:T.sec,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Expiring soon warning */}
              {cert?.status==='expiring_soon' && (
                <div style={{padding:'10px 20px',background:`${T.amber}10`,borderTop:`0.5px solid ${T.amber}33`,display:'flex',alignItems:'center',gap:10}}>
                  <span style={{color:T.amber,fontSize:14}}>⚠</span>
                  <div style={{fontSize:12,color:T.amber}}>
                    Certificate expires in <strong>{cert.days_remaining} days</strong>.
                    Renew your Cloudflare Origin Certificate and upload it before it expires.
                  </div>
                  <button onClick={()=>setUploadFor(dom)} style={{marginLeft:'auto',fontSize:11,padding:'4px 12px',borderRadius:5,border:`0.5px solid ${T.amber}55`,background:`${T.amber}15`,color:T.amber,cursor:'pointer',flexShrink:0,fontWeight:600}}>Renew now</button>
                </div>
              )}

              {/* Nginx config preview */}
              {isNginxOpen && nginxBlock && (
                <div style={{borderTop:`0.5px solid ${T.border}`}}>
                  <div style={{padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',background:T.elevated}}>
                    <div style={{fontSize:11,fontWeight:500,color:T.sec,fontFamily:'monospace'}}>
                      /etc/nginx/sites-enabled/{dom.hostname.replace(/\./g,'-')}.conf
                    </div>
                    <div style={{display:'flex',gap:8}}>
                      <button
                        onClick={()=>{
                          navigator.clipboard?.writeText(nginxBlock).catch(()=>{});
                          toast.success('Copied','nginx config copied to clipboard.');
                        }}
                        style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>
                        Copy
                      </button>
                      <button
                        onClick={()=>{
                          const t=toast.loading('Applying nginx config…',dom.hostname);
                          setTimeout(()=>{ t.update('success','nginx reloaded',`${dom.hostname} config applied.`);
                            setDomainData(dd=>({...dd,domains:dd.domains.map(d=>d.id===dom.id?{...d,cert:{...d.cert,nginx_reload:'just now'}}:d)}));
                          },1200);
                        }}
                        style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>
                        ↺ Reload nginx
                      </button>
                    </div>
                  </div>
                  <div style={{padding:'14px 20px',background:'#090b11',fontFamily:'monospace',fontSize:11,lineHeight:'18px',overflowX:'auto',maxHeight:340,overflowY:'auto'}}>
                    {nginxBlock.split('\n').map((line,i)=>{
                      const c = line.match(/^\s*#/) ? T.muted
                        : line.match(/\bssl_\w+|listen\b|server_name\b|proxy_pass\b|location\b|include\b|return\b/) ? T.blue
                        : line.match(/\$\w+|http_cf_connecting_ip/) ? T.amber
                        : line.match(/https?:\/\/|\/etc\/ssl/) ? T.green
                        : T.sec;
                      return <div key={i} style={{color:c,whiteSpace:'pre'}}>{line||'\u00a0'}</div>;
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add domain */}
      {adding ? (
        <div style={{display:'flex',gap:8,alignItems:'center',padding:'12px 16px',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
          <input
            value={newHostname}
            onChange={e=>setNewHostname(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter')addDomain();if(e.key==='Escape'){setAdding(false);setNewHostname('');}}}
            placeholder="staging.acme.com"
            autoFocus
            style={{flex:1,background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 12px',fontSize:13,color:T.text,outline:'none',fontFamily:'monospace'}}
          />
          <button onClick={addDomain} style={{padding:'8px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Add</button>
          <button onClick={()=>{setAdding(false);setNewHostname('');}} style={{padding:'8px 12px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,fontSize:13,cursor:'pointer'}}>Cancel</button>
        </div>
      ) : (
        <button onClick={()=>setAdding(true)} style={{display:'flex',alignItems:'center',gap:7,padding:'8px 16px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,fontSize:12,cursor:'pointer'}}>
          ＋ Add domain
        </button>
      )}

      {/* Cloudflare guidance */}
      <div style={{marginTop:20,background:T.elevated,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'14px 18px'}}>
        <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:8,display:'flex',alignItems:'center',gap:7}}>
          <span>☁</span> Cloudflare setup checklist
        </div>
        {[
          ['Set SSL/TLS mode to Full (strict)',             true],
          ['Generate Origin Certificate in CF dashboard',  null],
          ['Upload cert + key via Hub (above)',             null],
          ['Verify CF proxy (orange cloud) is enabled',    true],
          ['Test: curl -I https://app.acme.com',           null],
        ].map(([item,done])=>(
          <div key={item} style={{display:'flex',alignItems:'center',gap:8,padding:'5px 0',borderBottom:`0.5px solid ${T.border}`}}>
            <span style={{fontSize:13,color:done?T.green:T.muted,flexShrink:0}}>{done?'✓':'○'}</span>
            <span style={{fontSize:12,color:done?T.sec:T.text}}>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AppDetailView({ app, project, envName, onBack, onOpenDeploy, editMode=false }) {
  const toast   = useToast();
  const [tab, setTab]             = useState(editMode ? 'http' : 'http');
  const [isEditing, setEditing]   = useState(editMode);

  // HTTP Settings state
  const [port,      setPort]      = useState(String(app.port||3000));
  const [domain,    setDomain]    = useState(app.domain||'');
  const [protocol,  setProtocol]  = useState('https');
  const [healthPath,setHealth]    = useState('/health');
  const [websocket, setWS]        = useState(false);
  const [forceHTTPS,setForceHTTPS]= useState(true);

  // App Configs state
  const [image,     setImage]     = useState(app.image||'');
  const [envVarList,setEnvVarList]= useState(APP_ENV_VARS[app.id]||APP_ENV_VARS.b1);
  const [showVals,  setShowVals]  = useState({});
  const [newKey,    setNewKey]    = useState('');
  const [newVal,    setNewVal]    = useState('');
  const [newSecret, setNewSecret] = useState(false);
  const [replicas,  setReplicas]  = useState(String(app.replicas||1));
  const [cpuLimit,  setCpuLimit]  = useState('500m');
  const [memLimit,  setMemLimit]  = useState('512Mi');
  // Volume (persistent apps)
  const isDb = app.type==='database' || app.persistent;
  const [volName,   setVolName]   = useState(app.name+'-data');
  const [volPath,   setVolPath]   = useState('/data');
  const [volSize,   setVolSize]   = useState('10');

  // Deploy state
  const [image2,    setImage2]    = useState(app.image||'');
  const [gitData,   setGitData]   = useState(APP_GIT[app.id]||null);
  const [deployHooks,setDeployHooks]=useState(DEPLOY_HOOKS_INIT[app.id]||[]);
  const [hookCopied,setHookCopied]=useState(null);
  const [newHookEnv,setNewHookEnv]=useState('production');
  const deploys = APP_DEPLOYS[app.id]||APP_DEPLOYS.b1;

  // Build from source state
  const [buildMethod, setBuildMethod]   = useState('dockerfile'); // dockerfile | nixpacks | buildpack
  const [buildBranch, setBuildBranch]   = useState('main');
  const [buildContext,setBuildContext]  = useState('.');
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [buildLog,   setBuildLog]       = useState([]);
  const [buildRunning,setBuildRunning]  = useState(false);
  const [buildHistory,setBuildHistory]  = useState([
    { id:'b1', status:'success', branch:'main',   commit:'a3f2c91', started:'2h ago',  duration:'1m 42s', image:'registry/'+app.name+':sha-a3f2c91' },
    { id:'b2', status:'success', branch:'main',   commit:'92e1b80', started:'1d ago',  duration:'1m 38s', image:'registry/'+app.name+':sha-92e1b80' },
    { id:'b3', status:'failed',  branch:'feature/new-api', commit:'81d0a79', started:'2d ago', duration:'0m 22s', image:null },
  ]);

  // Logs state
  const [logLines,  setLogLines]  = useState(MOCK_LOG_LINES);
  const [logRunning,setLogRun]    = useState(false);
  const [logFilter, setLogFilt]   = useState('all');
  const logRef = useRef(null);

  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; },[logLines]);
  useEffect(()=>{
    if(!logRunning) return;
    let i=0;
    const t=setInterval(()=>{
      const msg=MORE_LOG_LINES[i%MORE_LOG_LINES.length];
      const now=new Date();
      const ts=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
      setLogLines(ls=>[...ls.slice(-200),{ts,stream:msg.startsWith('Error')||msg.startsWith('Warning')?'stderr':'stdout',msg}]);
      i++;
    },800);
    return()=>clearInterval(t);
  },[logRunning]);

  const TABS = ['http','configs','deploy','build','logs','log-analysis','advanced'];
  const TAB_LABELS = { http:'HTTP Settings', configs:'App Configs', deploy:'Deploy', build:'Build', logs:'Logs', 'log-analysis':'Log Analysis', advanced:'Advanced' };

  const saveTab = () => {
    toast.success('Saved', `${tab} settings updated — redeploy to apply.`);
  };

  const doDeployNow = () => {
    const t = toast.loading('Queueing deploy…', `${app.name} @ ${envName}`);
    setTimeout(()=>t.update('success','Deploy triggered',`${app.name} is deploying.`),1400);
  };

  return (
    <div style={{padding:'0',maxWidth:880,margin:'0 auto'}}>
      {/* Breadcrumb + header */}
      <div style={{padding:'24px 30px 0'}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:16,fontSize:13}}>
          <button onClick={()=>onBack('projects')} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,padding:0}}>Projects</button>
          <span style={{color:T.muted}}>/</span>
          <button onClick={()=>onBack('project')} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,padding:0}}>{project.name}</button>
          <span style={{color:T.muted}}>/</span>
          <button onClick={()=>onBack('env')} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,padding:0}}>{envName}</button>
          <span style={{color:T.muted}}>/</span>
          <span style={{color:T.sec}}>{app.name}</span>
        </div>

        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:42,height:42,borderRadius:10,background:T.elevated,border:`1px solid ${isDb?T.purple:T.blue}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>
              {isDb?'🗄':'📦'}
            </div>
            <div>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <span style={{fontSize:19,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{app.name}</span>
                <Pill label={isDb?'persistent':'stateless'} color={isDb?T.purple:T.blue}/>
                <Pill label={envName} color={envName==='production'?T.red:envName==='staging'?T.amber:T.blue}/>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <Dot color={app.status==='running'?T.green:T.muted} size={6}/>
                <span style={{fontSize:12,color:app.status==='running'?T.green:T.muted}}>{app.status}</span>
                {app.image&&<span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{app.image.slice(0,40)}{app.image.length>40?'…':''}</span>}
              </div>
            </div>
          </div>
          <div style={{display:'flex',gap:8,flexShrink:0}}>
            {app.status==='running'&&<button onClick={()=>toast.warning('Stopped',app.name)} style={{padding:'7px 13px',borderRadius:6,border:`0.5px solid ${T.amber}44`,background:`${T.amber}10`,color:T.amber,fontSize:12,cursor:'pointer'}}>⏹ Stop</button>}
            {app.status==='stopped'&&<button onClick={()=>toast.success('Starting…',app.name)} style={{padding:'7px 13px',borderRadius:6,border:`0.5px solid ${T.green}44`,background:`${T.green}10`,color:T.green,fontSize:12,cursor:'pointer'}}>▶ Start</button>}
            <button onClick={doDeployNow} style={{padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>🚀 Deploy</button>
          </div>
        </div>

        {/* Attention notices for this specific app */}
        {(()=>{
          const appNotices = computeNotices()
            .filter(n => (n.category==='deploy'||n.category==='cert'||n.category==='app') &&
              (n.title.includes(app.name) || n.title.toLowerCase().includes(app.name.toLowerCase())));
          return appNotices.length>0 ? <NoticeBar notices={appNotices}/> : null;
        })()}

        {/* New-app notice */}
        {editMode&&!image&&(
          <div style={{background:`${T.blue}10`,border:`0.5px solid ${T.blue}33`,borderRadius:8,padding:'12px 16px',marginBottom:16,display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:16}}>👋</span>
            <div style={{fontSize:13,color:T.sec}}>
              <strong style={{color:T.text}}>App created.</strong> Configure your settings below, then hit <strong style={{color:T.text}}>Deploy</strong> when ready.
            </div>
          </div>
        )}

        {/* Tabs */}
        <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`}}>
          {TABS.map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,whiteSpace:'nowrap'}}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{padding:'24px 30px'}}>

        {/* ── HTTP Settings ── */}
        {tab==='http'&&(
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <Card>
              <SecHead title="Port & protocol"/>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:4}}>
                <Input label="Container port" value={port} onChange={e=>setPort(e.target.value)} type="number" hint="The port your app listens on inside the container."/>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Protocol</label>
                  <div style={{display:'flex',gap:6}}>
                    {['http','https','tcp'].map(p=>(
                      <button key={p} onClick={()=>setProtocol(p)} style={{padding:'7px 16px',borderRadius:5,border:`1px solid ${protocol===p?T.blue:T.border}`,background:protocol===p?`${T.blue}15`:T.elevated,color:protocol===p?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:protocol===p?600:400,textTransform:'uppercase'}}>{p}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {[
                  [forceHTTPS,setForceHTTPS,'Force HTTPS','Redirect all HTTP traffic to HTTPS.'],
                  [websocket, setWS,         'WebSocket support','Enable Upgrade header passthrough for WS connections.'],
                ].map(([val,setter,label,desc])=>(
                  <div key={label} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',background:T.elevated,borderRadius:7,border:`0.5px solid ${T.border}`}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:500,color:T.text,marginBottom:2}}>{label}</div>
                      <div style={{fontSize:11,color:T.muted}}>{desc}</div>
                    </div>
                    <div onClick={()=>setter(v=>!v)} style={{width:36,height:20,borderRadius:10,background:val?T.green:T.elevated,border:`0.5px solid ${val?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
                      <div style={{position:'absolute',top:2,left:val?18:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <SecHead title="Domain & SSL"/>
              <Input label="Domain" value={domain} onChange={e=>setDomain(e.target.value)} placeholder="app.acme.com" hint="Leave blank to skip. Once set, configure SSL in the domain settings."/>
              {domain&&(
                <div style={{background:`${T.amber}10`,border:`0.5px solid ${T.amber}33`,borderRadius:6,padding:'10px 14px',fontSize:12,color:T.amber}}>
                  ⚠ Don't forget to configure your Cloudflare Origin Certificate after deploying.
                </div>
              )}
            </Card>

            <Card>
              <SecHead title="Health check"/>
              <Input label="Path" value={healthPath} onChange={e=>setHealth(e.target.value)} mono hint="HTTP GET — must return 2xx. App restarts after 3 consecutive failures."/>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
                <Input label="Interval (s)"  value="30" onChange={()=>{}} type="number"/>
                <Input label="Timeout (s)"   value="5"  onChange={()=>{}} type="number"/>
                <Input label="Fail threshold" value="3" onChange={()=>{}} type="number"/>
              </div>
            </Card>


            <Card>
              <SecHead title="SSL certificate"/>
              {(()=>{
                const [sslMode,  setSslMode]  = React.useState('cf'); // cf | le | manual | none
                const [cfCert,   setCfCert]   = React.useState('');
                const [cfKey,    setCfKey]    = React.useState('');
                const [leEmail,  setLeEmail]  = React.useState('');
                const [sslSaved, setSslSaved] = React.useState(false);

                const saveSsl = () => {
                  toast.success('SSL configured', sslMode==='cf'?'Cloudflare Origin CA installed':sslMode==='le'?"Let's Encrypt certificate requested":'Manual certificate saved');
                  setSslSaved(true); setTimeout(()=>setSslSaved(false),2000);
                };

                return (
                  <div>
                    {/* Mode picker */}
                    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:7,marginBottom:16}}>
                      {[
                        { id:'cf',     icon:'🟠', label:'Cloudflare',     desc:'Origin CA + Full (Strict). Recommended.' },
                        { id:'le',     icon:'🔒', label:"Let's Encrypt",  desc:'ACME auto-renew. Needs port 80 open.' },
                        { id:'manual', icon:'📄', label:'Upload cert',    desc:'Paste your own PEM cert and key.' },
                        { id:'none',   icon:'🔓', label:'No SSL',         desc:'HTTP only. Not recommended.' },
                      ].map(m=>{
                        const sel=sslMode===m.id;
                        return (
                          <button key={m.id} onClick={()=>setSslMode(m.id)} style={{padding:'10px 8px',borderRadius:8,border:`1.5px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                            <div style={{fontSize:16,marginBottom:4}}>{m.icon}</div>
                            <div style={{fontSize:11,fontWeight:600,color:sel?T.blue:T.text,marginBottom:2}}>{m.label}</div>
                            <div style={{fontSize:10,color:T.muted,lineHeight:'13px'}}>{m.desc}</div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Cloudflare flow */}
                    {sslMode==='cf'&&(
                      <div>
                        <div style={{background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:7,padding:'12px 14px',marginBottom:14}}>
                          <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:6}}>Setup: Cloudflare Origin CA</div>
                          <ol style={{margin:0,paddingLeft:18,fontSize:12,color:T.sec,lineHeight:'20px'}}>
                            <li>In Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate</li>
                            <li>Select RSA 2048 bit. Add your domain (e.g. <code style={{fontFamily:'monospace'}}>{domain||'app.acme.com'}</code>).</li>
                            <li>Set expiry to 15 years. Copy the certificate and private key.</li>
                            <li>Paste both below. Set Cloudflare SSL mode to <strong>Full (Strict)</strong>.</li>
                          </ol>
                        </div>
                        <div style={{marginBottom:12}}>
                          <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:5,fontWeight:500}}>Origin Certificate (PEM)</label>
                          <textarea value={cfCert} onChange={e=>setCfCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" rows={4} style={{width:'100%',boxSizing:'border-box',background:'#090b11',border:`0.5px solid ${cfCert?T.green+'55':T.borderMd}`,borderRadius:6,padding:'10px 12px',fontSize:11,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'18px',outline:'none',resize:'vertical'}}/>
                        </div>
                        <div style={{marginBottom:14}}>
                          <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:5,fontWeight:500}}>Private Key (PEM)</label>
                          <textarea value={cfKey} onChange={e=>setCfKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" rows={4} style={{width:'100%',boxSizing:'border-box',background:'#090b11',border:`0.5px solid ${cfKey?T.green+'55':T.borderMd}`,borderRadius:6,padding:'10px 12px',fontSize:11,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'18px',outline:'none',resize:'vertical'}}/>
                        </div>
                        <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:6,padding:'9px 12px',fontSize:11,color:T.amber,marginBottom:14}}>
                          💡 After saving, set Cloudflare SSL/TLS mode to <strong>Full (Strict)</strong> — not just "Full". This encrypts traffic all the way to your origin server.
                        </div>
                      </div>
                    )}

                    {/* Let's Encrypt flow */}
                    {sslMode==='le'&&(
                      <div>
                        <div style={{background:`${T.amber}10`,border:`0.5px solid ${T.amber}33`,borderRadius:7,padding:'10px 14px',marginBottom:14,fontSize:12,color:T.amber}}>
                          ⚠ Let's Encrypt requires port 80 to be publicly reachable for the ACME HTTP-01 challenge. If your server is behind Cloudflare, use the Cloudflare Origin CA method instead.
                        </div>
                        <Input label="Email address" value={leEmail} onChange={e=>setLeEmail(e.target.value)} placeholder="ops@acme.com" hint="Used for expiry reminders from Let's Encrypt."/>
                        <div style={{fontSize:12,color:T.sec,marginBottom:14}}>
                          Certificate will be issued for <code style={{fontFamily:'monospace',color:T.blue}}>{domain||'(set a domain first)'}</code> and auto-renewed every 60 days via hub-agent.
                        </div>
                      </div>
                    )}

                    {/* Manual cert */}
                    {sslMode==='manual'&&(
                      <div>
                        <div style={{marginBottom:12}}>
                          <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:5,fontWeight:500}}>Certificate (PEM)</label>
                          <textarea value={cfCert} onChange={e=>setCfCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" rows={4} style={{width:'100%',boxSizing:'border-box',background:'#090b11',border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'10px 12px',fontSize:11,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'18px',outline:'none',resize:'vertical'}}/>
                        </div>
                        <div style={{marginBottom:14}}>
                          <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:5,fontWeight:500}}>Private Key (PEM)</label>
                          <textarea value={cfKey} onChange={e=>setCfKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" rows={4} style={{width:'100%',boxSizing:'border-box',background:'#090b11',border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'10px 12px',fontSize:11,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'18px',outline:'none',resize:'vertical'}}/>
                        </div>
                      </div>
                    )}

                    {/* No SSL */}
                    {sslMode==='none'&&(
                      <div style={{background:`${T.red}08`,border:`0.5px solid ${T.red}33`,borderRadius:7,padding:'10px 14px',marginBottom:14,fontSize:12,color:T.red}}>
                        ⚠ HTTP only — all traffic to this app will be unencrypted. Credentials and data transmitted in plain text.
                      </div>
                    )}

                    <button onClick={saveSsl} disabled={sslMode==='cf'&&(!cfCert||!cfKey)} style={{padding:'8px 20px',borderRadius:6,border:'none',background:sslSaved?T.green:sslMode==='cf'&&(!cfCert||!cfKey)?T.elevated:T.blue,color:sslSaved||sslMode==='cf'&&(!cfCert||!cfKey)?sslSaved?'#fff':T.muted:'#fff',fontSize:12,fontWeight:600,cursor:sslMode==='cf'&&(!cfCert||!cfKey)?'not-allowed':'pointer',transition:'background 0.2s'}}>
                      {sslSaved?'✓ Saved':'Save SSL config'}
                    </button>
                  </div>
                );
              })()}
            </Card>

            <div style={{display:'flex',justifyContent:'flex-end'}}>
              <button onClick={saveTab} style={{padding:'9px 22px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Save HTTP settings</button>
            </div>
          </div>
        )}

        {/* ── App Configs ── */}
        {tab==='configs'&&(
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <Card>
              <SecHead title="Container image"/>
              <Input label="Image" value={image} onChange={e=>setImage(e.target.value)} placeholder="registry/my-app:latest" mono hint="Full image reference. Hub pulls this on every deploy."/>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                <Input label="CPU limit"    value={cpuLimit} onChange={e=>setCpuLimit(e.target.value)} mono hint="Millicores. 500m = 0.5 vCPU."/>
                <Input label="Memory limit" value={memLimit} onChange={e=>setMemLimit(e.target.value)} mono hint="Mi or Gi. Container OOM-killed if exceeded."/>
              </div>
              {!isDb&&(
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Replicas</label>
                  <div style={{display:'flex',gap:6}}>
                    {['1','2','3','4'].map(n=>(
                      <button key={n} onClick={()=>setReplicas(n)} style={{padding:'5px 16px',borderRadius:5,border:`1px solid ${replicas===n?T.blue:T.border}`,background:replicas===n?`${T.blue}15`:T.elevated,color:replicas===n?T.blue:T.sec,fontSize:13,cursor:'pointer',fontWeight:replicas===n?600:400}}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Persistent volume — only for persistent apps */}
            {isDb&&(
              <Card>
                <SecHead title="Persistent volume"/>
                <div style={{background:`${T.purple}08`,border:`0.5px solid ${T.purple}33`,borderRadius:7,padding:'10px 14px',marginBottom:14,fontSize:12,color:T.purple}}>
                  This app has persistent storage. Data survives container restarts and redeployments.
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
                  <Input label="Volume name" value={volName} onChange={e=>setVolName(e.target.value)} mono hint="Unique name on the host."/>
                  <Input label="Mount path"  value={volPath} onChange={e=>setVolPath(e.target.value)} mono hint="Path inside the container."/>
                  <Input label="Size (GB)"   value={volSize} onChange={e=>setVolSize(e.target.value)} type="number" hint="Initial size. Can grow, hard to shrink."/>
                </div>
              </Card>
            )}

            {/* Env vars */}
            <Card>
              <SecHead title="Environment variables" action={()=>{}} label={`${envVarList.length} vars`}/>
              <div style={{background:T.elevated,borderRadius:7,overflow:'hidden',border:`0.5px solid ${T.border}`,marginBottom:12}}>
                {envVarList.map((v,i)=>(
                  <div key={v.key} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderBottom:i<envVarList.length-1?`0.5px solid ${T.border}`:'none'}}>
                    <span style={{fontSize:10,padding:'1px 5px',borderRadius:3,background:v.secret?`${T.purple}18`:`${T.cyan}12`,color:v.secret?T.purple:T.cyan,border:`0.5px solid ${v.secret?T.purple+'33':T.cyan+'33'}`,flexShrink:0}}>{v.secret?'secret':'plain'}</span>
                    <span style={{fontSize:12,fontFamily:'monospace',fontWeight:600,color:T.text,flex:1}}>{v.key}</span>
                    <span style={{fontSize:12,fontFamily:'monospace',color:T.muted,flex:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{showVals[v.key]?v.value:v.secret?'••••••••••••':v.value}</span>
                    <div style={{display:'flex',gap:5,flexShrink:0}}>
                      {v.secret&&<button onClick={()=>setShowVals(s=>({...s,[v.key]:!s[v.key]}))} style={{fontSize:10,padding:'2px 7px',borderRadius:3,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer'}}>{showVals[v.key]?'hide':'show'}</button>}
                      <button onClick={()=>setEnvVarList(l=>l.filter(x=>x.key!==v.key))} style={{fontSize:10,padding:'2px 7px',borderRadius:3,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
              {/* Add row */}
              <div style={{display:'flex',gap:7,alignItems:'flex-start'}}>
                <input value={newKey} onChange={e=>setNewKey(e.target.value)} placeholder="KEY" style={{flex:1,background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:5,padding:'7px 10px',fontSize:12,fontFamily:'monospace',color:T.text,outline:'none'}}/>
                <input value={newVal} onChange={e=>setNewVal(e.target.value)} placeholder="value" type={newSecret?'password':'text'} style={{flex:2,background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:5,padding:'7px 10px',fontSize:12,fontFamily:'monospace',color:T.text,outline:'none'}}/>
                <button onClick={()=>setNewSecret(v=>!v)} style={{padding:'7px 10px',borderRadius:5,border:`0.5px solid ${newSecret?T.purple+'55':T.border}`,background:newSecret?`${T.purple}12`:T.elevated,color:newSecret?T.purple:T.muted,fontSize:11,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>{newSecret?'🔒 secret':'plain'}</button>
                <button onClick={()=>{if(!newKey.trim())return;setEnvVarList(l=>[...l,{key:newKey.trim(),value:newVal,secret:newSecret}]);setNewKey('');setNewVal('');setNewSecret(false);}} style={{padding:'7px 14px',borderRadius:5,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',flexShrink:0}}>Add</button>
              </div>
              <div style={{marginTop:10,fontSize:11,color:T.amber}}>Changes require a redeploy to take effect.</div>
            </Card>

            <div style={{display:'flex',justifyContent:'flex-end'}}>
              <button onClick={saveTab} style={{padding:'9px 22px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Save config</button>
            </div>
          </div>
        )}

        {/* ── Deploy ── */}
        {tab==='deploy'&&(
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            {/* Manual deploy */}
            <Card>
              <SecHead title="Manual deploy"/>
              <Input label="Image to deploy" value={image2} onChange={e=>setImage2(e.target.value)} placeholder="registry/my-app:v1.2.3" mono hint="Override the configured image for this one deploy."/>
              <button onClick={doDeployNow} style={{padding:'10px 24px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:8}}>
                🚀 Deploy now
              </button>
            </Card>

            {/* Deploy history */}
            <Card>
              <SecHead title="Recent deploys" action={()=>{}} label="view all →"/>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {deploys.map((d,i)=>(
                  <div key={d.id} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',background:T.elevated,borderRadius:7}}>
                    <Dot color={dColor(d.status)} size={7}/>
                    <span style={{fontSize:12,fontFamily:'monospace',fontWeight:600,color:T.text,flex:1}}>{d.version}</span>
                    <Pill label={d.status} color={dColor(d.status)}/>
                    {i===0&&<span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:`${T.blue}18`,color:T.blue,border:`0.5px solid ${T.blue}44`}}>current</span>}
                    <span style={{fontSize:11,color:T.muted}}>{d.ago}</span>
                    <span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{d.commit}</span>
                    {i>0&&<button onClick={()=>{const t=toast.loading('Rolling back…',`${app.name} → ${d.version}`);setTimeout(()=>t.update('success','Rollback complete',`${app.name} running ${d.version}`),2000);}} style={{fontSize:10,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.amber}44`,background:`${T.amber}10`,color:T.amber,cursor:'pointer'}}>↩ Rollback</button>}
                  </div>
                ))}
              </div>
            </Card>

            {/* Git */}
            <Card>
              <SecHead title="Git repository"/>
              {gitData ? (
                <div>
                  <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:T.elevated,borderRadius:7,border:`0.5px solid ${T.green}33`,marginBottom:12}}>
                    <span style={{fontSize:18}}>🗂</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:T.blue}}>{gitData.repo}</div>
                      <div style={{fontSize:11,color:T.muted}}>branch: {gitData.branch} · auto-deploy {gitData.auto_deploy?'on':'off'}</div>
                    </div>
                    <button onClick={()=>setGitData(null)} style={{fontSize:11,color:T.red,background:'none',border:'none',cursor:'pointer'}}>Disconnect</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{fontSize:12,color:T.sec,marginBottom:12}}>Connect a repository to auto-deploy on push. You can always do this later.</div>
                  <button onClick={()=>{setGitData({...APP_GIT.b1,repo:`acme/${app.name}`});toast.success('Repository connected',`acme/${app.name}`)}} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>Connect Forgejo repo</button>
                </div>
              )}
            </Card>

            {/* Deploy hooks */}
            <Card>
              <SecHead title="Deploy hooks"/>
              <div style={{fontSize:12,color:T.sec,marginBottom:12}}>Secret URLs to trigger deploys from any CI system without an API key.</div>
              <div style={{display:'flex',flexDirection:'column',gap:7,marginBottom:12}}>
                {deployHooks.map(hook=>{
                  const isCopied=hookCopied===hook.id;
                  return (
                    <div key={hook.id} style={{background:T.elevated,borderRadius:6,padding:'10px 12px',border:`0.5px solid ${T.border}`}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
                        <Pill label={hook.env} color={hook.env==='production'?T.red:hook.env==='staging'?T.amber:T.blue}/>
                        <span style={{fontSize:11,color:T.muted,marginLeft:'auto'}}>used {hook.uses}×</span>
                      </div>
                      <div style={{display:'flex',gap:7,alignItems:'center'}}>
                        <code style={{fontSize:10,fontFamily:'monospace',color:T.muted,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{hook.url}</code>
                        <button onClick={()=>{navigator.clipboard?.writeText(hook.url).catch(()=>{});setHookCopied(hook.id);setTimeout(()=>setHookCopied(null),2000);toast.success('Copied','Hook URL copied.');}} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${isCopied?T.green+'55':T.border}`,background:isCopied?`${T.green}10`:'none',color:isCopied?T.green:T.muted,cursor:'pointer',transition:'all 0.15s'}}>{isCopied?'✓':'copy'}</button>
                        <button onClick={()=>{setDeployHooks(hs=>hs.filter(h=>h.id!==hook.id));toast.warning('Deleted',hook.env+' hook');}} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{display:'flex',gap:7}}>
                <select value={newHookEnv} onChange={e=>setNewHookEnv(e.target.value)} style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:5,padding:'7px 10px',fontSize:12,color:T.text,outline:'none'}}>
                  {['production','staging','development'].map(e=><option key={e} value={e}>{e}</option>)}
                </select>
                <button onClick={()=>{const secret='dhk_'+Math.random().toString(36).slice(2,18);const id='dh'+Date.now();setDeployHooks(hs=>[...hs,{id,name:`${newHookEnv} deploy`,env:newHookEnv,branch:newHookEnv==='production'?'main':newHookEnv,secret,secret_full:secret,url:`https://hub.acme.com/api/hooks/deploy/${app.name}-${newHookEnv.slice(0,4)}-${secret.slice(4,12)}`,created_at:Date.now(),last_used:null,uses:0}]);toast.success('Hook created',newHookEnv+' deploy hook');}} style={{padding:'7px 14px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,fontSize:12,cursor:'pointer'}}>＋ Generate hook</button>
              </div>
            </Card>
          </div>
        )}


        {tab==='build'&&(
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            {/* Source connection */}
            {!gitData?(
              <Card>
                <SecHead title="Source repository"/>
                <div style={{fontSize:12,color:T.sec,marginBottom:14}}>Connect a repository to build images directly from source. Requires git integration to be configured in Hub settings.</div>
                <button onClick={()=>{setGitData({...APP_GIT.b1,repo:`acme/${app.name}`});toast.success('Repository connected',`acme/${app.name}`);}} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>Connect Forgejo repo</button>
              </Card>
            ):(
              <Card>
                <SecHead title="Source repository"/>
                <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:T.elevated,borderRadius:7,border:`0.5px solid ${T.green}33`,marginBottom:14}}>
                  <span style={{fontSize:18}}>🗂</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.blue}}>{gitData.repo}</div>
                    <div style={{fontSize:11,color:T.muted}}>Connected · auto-deploy {gitData.auto_deploy?'on':'off'}</div>
                  </div>
                  <button onClick={()=>setGitData(null)} style={{fontSize:11,color:T.red,background:'none',border:'none',cursor:'pointer'}}>Disconnect</button>
                </div>

                {/* Build method */}
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Build method</label>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:16}}>
                  {[
                    { id:'dockerfile', icon:'🐳', label:'Dockerfile',  desc:'Uses your Dockerfile. Full control.' },
                    { id:'nixpacks',   icon:'📦', label:'Nixpacks',    desc:'Auto-detects language & runtime. Zero config.' },
                    { id:'buildpack',  icon:'🏗',  label:'Buildpack',   desc:'Cloud Native Buildpacks (Heroku-style).' },
                  ].map(m=>{
                    const sel=buildMethod===m.id;
                    return (
                      <button key={m.id} onClick={()=>setBuildMethod(m.id)} style={{padding:'12px 10px',borderRadius:8,border:`1.5px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                        <div style={{fontSize:20,marginBottom:6}}>{m.icon}</div>
                        <div style={{fontSize:12,fontWeight:600,color:sel?T.blue:T.text,marginBottom:2}}>{m.label}</div>
                        <div style={{fontSize:10,color:T.muted,lineHeight:'14px'}}>{m.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {/* Build config */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
                  <Input label="Branch" value={buildBranch} onChange={e=>setBuildBranch(e.target.value)} mono placeholder="main"/>
                  <Input label="Build context" value={buildContext} onChange={e=>setBuildContext(e.target.value)} mono placeholder="." hint="Relative path to build context"/>
                  {buildMethod==='dockerfile'&&(
                    <Input label="Dockerfile path" value={dockerfilePath} onChange={e=>setDockerfilePath(e.target.value)} mono placeholder="Dockerfile"/>
                  )}
                  <Input label="Output image" value={`registry/acme/${app.name}:sha-{git}`} onChange={()=>{}} mono hint="Auto-populated with git SHA on each build." readOnly/>
                </div>

                {/* Trigger build */}
                <button
                  onClick={()=>{
                    setBuildRunning(true);
                    setBuildLog([]);
                    const lines=[
                      `→ Cloning ${gitData.repo}@${buildBranch}`,
                      '✓ Clone complete (0.8s)',
                      buildMethod==='dockerfile'?`→ docker build -f ${dockerfilePath} -t registry/acme/${app.name}:sha-build .`:`→ nixpacks build . --name registry/acme/${app.name}:sha-build`,
                      'Step 1/8: FROM node:20-alpine',
                      'Step 2/8: WORKDIR /app',
                      'Step 3/8: COPY package*.json ./',
                      'Step 4/8: RUN npm ci --only=production',
                      'Step 5/8: COPY . .',
                      'Step 6/8: RUN npm run build',
                      'Step 7/8: EXPOSE 3000',
                      'Step 8/8: CMD ["node","dist/index.js"]',
                      '✓ Image built (1m 24s)',
                      `→ Pushing registry/acme/${app.name}:sha-a3f2c91`,
                      '✓ Pushed (14.2s)',
                      '✓ Build complete → registry/acme/${app.name}:sha-a3f2c91',
                    ];
                    let i=0;
                    const iv=setInterval(()=>{
                      i++;
                      setBuildLog(l=>[...l,lines[i-1]]);
                      if(i>=lines.length){
                        clearInterval(iv);
                        setBuildRunning(false);
                        setBuildHistory(h=>[{id:'b'+Date.now(),status:'success',branch:buildBranch,commit:'a3f2c91',started:'just now',duration:'1m 38s',image:`registry/acme/${app.name}:sha-a3f2c91`},...h]);
                        toast.success('Build complete',`registry/acme/${app.name}:sha-a3f2c91`);
                      }
                    },120);
                  }}
                  disabled={buildRunning}
                  style={{display:'flex',alignItems:'center',gap:8,padding:'9px 22px',borderRadius:7,border:'none',background:buildRunning?T.elevated:T.green,color:buildRunning?T.muted:'#111',fontSize:13,fontWeight:700,cursor:buildRunning?'not-allowed':'pointer'}}>
                  {buildRunning?<><span style={{display:'inline-block',width:12,height:12,border:'2px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Building…</>:'🏗 Build now'}
                </button>
              </Card>
            )}

            {/* Build log */}
            {buildLog.length>0&&(
              <Card>
                <SecHead title="Build output"/>
                <div style={{background:'#090b11',borderRadius:7,padding:'12px 14px',fontFamily:'monospace',fontSize:11,lineHeight:'19px',maxHeight:300,overflowY:'auto',border:`0.5px solid ${buildRunning?T.green+'44':T.green+'22'}`}}>
                  {buildLog.map((line,i)=>(
                    <div key={i} style={{color: line.startsWith('✓')?T.green: line.startsWith('→')?T.blue: line.includes('Step')?T.cyan:'#e2e8f0'}}>{line}</div>
                  ))}
                  {buildRunning&&<span style={{display:'inline-block',width:6,height:12,background:T.green,verticalAlign:'text-bottom',animation:'blink 1s step-end infinite',marginLeft:2}}/>}
                </div>
              </Card>
            )}

            {/* Build history */}
            <Card>
              <SecHead title="Build history"/>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {buildHistory.map((b,i)=>(
                  <div key={b.id} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',background:T.elevated,borderRadius:7}}>
                    <Dot color={b.status==='success'?T.green:T.red} size={7}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:500,color:T.text}}>{b.branch} <span style={{fontFamily:'monospace',color:T.muted}}>@{b.commit}</span></div>
                      {b.image&&<div style={{fontSize:10,fontFamily:'monospace',color:T.blue,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.image}</div>}
                    </div>
                    <Pill label={b.status} color={b.status==='success'?T.green:T.red}/>
                    <span style={{fontSize:11,color:T.muted,flexShrink:0}}>{b.started}</span>
                    <span style={{fontSize:11,fontFamily:'monospace',color:T.muted,flexShrink:0}}>{b.duration}</span>
                    {b.image&&<button onClick={()=>toast.success('Deploy triggered',b.image)} style={{fontSize:10,padding:'3px 9px',borderRadius:4,border:'none',background:T.blue,color:'#fff',cursor:'pointer'}}>Deploy</button>}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* ── Logs ── */}
        {tab==='logs'&&(
          <div>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <div style={{display:'flex',gap:3,background:T.elevated,borderRadius:6,padding:3}}>
                {['all','stdout','stderr'].map(f=>(
                  <button key={f} onClick={()=>setLogFilt(f)} style={{padding:'4px 12px',borderRadius:4,border:'none',cursor:'pointer',fontSize:11,fontWeight:logFilter===f?500:400,background:logFilter===f?T.card:'transparent',color:logFilter===f?T.text:T.sec}}>{f}</button>
                ))}
              </div>
              <button onClick={()=>setLogRun(r=>!r)} style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',borderRadius:6,border:`0.5px solid ${logRunning?T.green+'66':T.border}`,background:logRunning?`${T.green}12`:T.elevated,color:logRunning?T.green:T.sec,fontSize:12,cursor:'pointer',fontWeight:500}}>
                {logRunning?<><span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:T.green,animation:'blink 1s step-end infinite'}}/>Live</>:'▶ Stream live'}
              </button>
              <button onClick={()=>setLogLines(MOCK_LOG_LINES)} style={{fontSize:11,padding:'5px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer'}}>Clear</button>
              <div style={{marginLeft:'auto',fontSize:11,color:T.muted}}>{app.name} · {envName}</div>
            </div>
            <div ref={logRef} style={{background:'#090b11',borderRadius:8,padding:'12px 16px',fontFamily:'"SF Mono",Menlo,monospace',fontSize:11,lineHeight:'19px',height:480,overflowY:'auto',border:`0.5px solid ${logRunning?T.green+'44':T.border}`}}>
              {(logFilter==='all'?logLines:logLines.filter(l=>l.stream===logFilter)).map((l,i)=>{
                const isErr=l.stream==='stderr';
                const mc=isErr?T.red:l.msg.includes('Error')||l.msg.includes('failed')?T.red:l.msg.includes('Warning')||l.msg.includes('deprecated')?T.amber:T.text;
                return (
                  <div key={i} style={{display:'flex',gap:12,padding:'1px 0'}}>
                    <span style={{color:T.muted,flexShrink:0,userSelect:'none',minWidth:92}}>{l.ts}</span>
                    <span style={{color:isErr?T.red:T.blue,flexShrink:0,width:44,fontSize:10}}>{l.stream}</span>
                    <span style={{color:mc}}>{l.msg}</span>
                  </div>
                );
              })}
              {logRunning&&<span style={{display:'inline-block',width:6,height:12,background:T.green,verticalAlign:'text-bottom',animation:'blink 1s step-end infinite',marginLeft:2}}/>}
            </div>
          </div>
        )}

        {/* ── Advanced ── */}
        {tab==='log-analysis'&&(
          (() => {
            const [laRange, setLaRange] = React.useState('24h');
            const [tick2, setTick2]     = React.useState(0);
            React.useEffect(()=>{ const t=setInterval(()=>setTick2(n=>n+1),5000); return()=>clearInterval(t); },[]);

            // Mock nginx access log analytics
            const totalReqs  = 48320 + Math.floor(Math.random()*200);
            const totalBytes = 2.4 + Math.random()*0.1;
            const uniqueIPs  = 1842 + Math.floor(Math.random()*20);

            const TOP_URLS = [
              { path:'/api/v1/workflows',       reqs:12400, pct:25.7, p50:42,  p95:210, status:'2xx' },
              { path:'/api/v1/executions',       reqs:9800,  pct:20.3, p50:88,  p95:450, status:'2xx' },
              { path:'/webhook/:id',             reqs:7200,  pct:14.9, p50:12,  p95:89,  status:'2xx' },
              { path:'/api/v1/credentials',      reqs:4100,  pct:8.5,  p50:35,  p95:180, status:'2xx' },
              { path:'/healthz',                 reqs:2880,  pct:6.0,  p50:2,   p95:8,   status:'2xx' },
              { path:'/api/v1/users/me',         reqs:2400,  pct:5.0,  p50:28,  p95:95,  status:'2xx' },
              { path:'/static/js/main.bundle.js',reqs:1920,  pct:4.0,  p50:5,   p95:22,  status:'2xx' },
              { path:'/api/v1/nodes',            reqs:1600,  pct:3.3,  p50:55,  p95:290, status:'2xx' },
            ];

            const STATUS_DIST = [
              { code:'2xx', label:'Success',  count:45100, color:T.green  },
              { code:'3xx', label:'Redirect', count:1820,  color:T.blue   },
              { code:'4xx', label:'Client err',count:1180, color:T.amber  },
              { code:'5xx', label:'Server err',count:220,  color:T.red    },
            ];
            const totalStatus = STATUS_DIST.reduce((a,s)=>a+s.count,0);

            const TOP_IPS = [
              { ip:'100.64.0.10', label:'prod-web-01 (mesh)', reqs:8400, bytes:'180 MB' },
              { ip:'100.64.0.11', label:'prod-web-02 (mesh)', reqs:7900, bytes:'168 MB' },
              { ip:'203.0.113.42',label:'Unknown',            reqs:1240, bytes:'28 MB'  },
              { ip:'198.51.100.9',label:'Monitoring',         reqs:2880, bytes:'4 MB'   },
            ];

            // Hourly request sparkline (24 points)
            const hourlyData = Array.from({length:24},(_,i)=>{
              const base = i>=8&&i<=22 ? 2400 : 400;
              return Math.round(base+(Math.random()-0.5)*600);
            });
            const hMax=Math.max(...hourlyData);
            const sparkW=400,sparkH=40;

            return (
              <div>
                {/* Range selector */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
                  <div style={{fontSize:12,color:T.muted}}>nginx access log analysis · {app.name} · {envName}</div>
                  <div style={{display:'flex',gap:4,background:T.elevated,borderRadius:6,padding:3}}>
                    {['1h','24h','7d','30d'].map(r=>(
                      <button key={r} onClick={()=>setLaRange(r)} style={{padding:'4px 11px',borderRadius:4,border:'none',cursor:'pointer',fontSize:11,fontWeight:laRange===r?600:400,background:laRange===r?T.card:'transparent',color:laRange===r?T.text:T.sec}}>{r}</button>
                    ))}
                  </div>
                </div>

                {/* Top stat strip */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
                  {[
                    ['Total requests',  totalReqs.toLocaleString(), T.text],
                    ['Unique visitors', uniqueIPs.toLocaleString(), T.blue],
                    ['Data transferred',totalBytes.toFixed(1)+' GB', T.text],
                    ['Error rate',      ((STATUS_DIST[2].count+STATUS_DIST[3].count)/totalStatus*100).toFixed(1)+'%', T.amber],
                  ].map(([label,val,color])=>(
                    <div key={label} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'12px 14px'}}>
                      <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:4}}>{label}</div>
                      <div style={{fontSize:18,fontWeight:800,color,letterSpacing:'-0.02em'}}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Requests over time sparkline */}
                <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'14px 16px',marginBottom:14}}>
                  <div style={{fontSize:11,color:T.sec,fontWeight:500,marginBottom:10}}>Requests / hour</div>
                  <svg viewBox={`0 0 ${sparkW} ${sparkH}`} style={{width:'100%',height:sparkH,display:'block'}}>
                    {hourlyData.map((v,i)=>{
                      const x=i*(sparkW/(hourlyData.length-1));
                      const h2=Math.max(2,(v/hMax)*(sparkH-4));
                      return <rect key={i} x={x-3} y={sparkH-h2} width={6} height={h2} rx={1} fill={`${T.blue}66`}/>;
                    })}
                  </svg>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:T.muted,marginTop:4}}>
                    <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
                  </div>
                </div>

                <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:12,marginBottom:14}}>
                  {/* Top URLs */}
                  <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
                    <div style={{padding:'12px 14px',borderBottom:`0.5px solid ${T.border}`,fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em'}}>Top endpoints</div>
                    {TOP_URLS.map((u,i)=>(
                      <div key={u.path} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 14px',borderBottom:i<TOP_URLS.length-1?`0.5px solid ${T.border}`:'none'}}>
                        <span style={{fontSize:10,color:T.muted,width:16,flexShrink:0,textAlign:'right'}}>{i+1}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:11,fontFamily:'monospace',color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:3}}>{u.path}</div>
                          <div style={{height:3,background:T.elevated,borderRadius:1}}>
                            <div style={{height:'100%',width:`${u.pct}%`,background:T.blue,borderRadius:1}}/>
                          </div>
                        </div>
                        <div style={{textAlign:'right',flexShrink:0}}>
                          <div style={{fontSize:11,fontWeight:600,color:T.text}}>{u.reqs.toLocaleString()}</div>
                          <div style={{fontSize:9,color:T.muted}}>p95 {u.p95}ms</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Status codes */}
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
                      <div style={{padding:'12px 14px',borderBottom:`0.5px solid ${T.border}`,fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em'}}>Status codes</div>
                      {STATUS_DIST.map(s=>(
                        <div key={s.code} style={{display:'flex',alignItems:'center',gap:8,padding:'9px 14px',borderBottom:`0.5px solid ${T.border}`}}>
                          <Dot color={s.color} size={7}/>
                          <span style={{fontSize:12,fontWeight:600,color:s.color,width:32}}>{s.code}</span>
                          <div style={{flex:1,height:4,background:T.elevated,borderRadius:2}}>
                            <div style={{height:'100%',width:`${s.count/totalStatus*100}%`,background:s.color,borderRadius:2}}/>
                          </div>
                          <span style={{fontSize:11,color:T.text,fontWeight:500,width:44,textAlign:'right'}}>{(s.count/totalStatus*100).toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>

                    {/* Top IPs */}
                    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
                      <div style={{padding:'12px 14px',borderBottom:`0.5px solid ${T.border}`,fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em'}}>Top sources</div>
                      {TOP_IPS.map(ip=>(
                        <div key={ip.ip} style={{padding:'9px 14px',borderBottom:`0.5px solid ${T.border}`}}>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                            <code style={{fontSize:10,fontFamily:'monospace',color:T.blue}}>{ip.ip}</code>
                            <span style={{fontSize:10,fontWeight:600,color:T.text}}>{ip.reqs.toLocaleString()}</span>
                          </div>
                          <div style={{fontSize:10,color:T.muted}}>{ip.label} · {ip.bytes}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:7,padding:'9px 14px',fontSize:11,color:T.amber,display:'flex',alignItems:'center',gap:8}}>
                  ℹ Log analysis pulls from the nginx access log via hub-agent. Configure <code style={{fontFamily:'monospace'}}>LOKI_URL</code> in Hub settings to stream to Loki for persistent history.
                </div>
              </div>
            );
          })()
        )}

        {tab==='advanced'&&(
          <div style={{display:'flex',flexDirection:'column',gap:16}}>
            <Card>
              <SecHead title="Restart policy"/>
              <div style={{display:'flex',gap:6}}>
                {['always','on-failure','unless-stopped','never'].map(p=>(
                  <button key={p} onClick={()=>toast.success('Restart policy saved',p)} style={{padding:'6px 14px',borderRadius:5,border:`1px solid ${p==='unless-stopped'?T.blue:T.border}`,background:p==='unless-stopped'?`${T.blue}15`:T.elevated,color:p==='unless-stopped'?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:p==='unless-stopped'?600:400}}>{p}</button>
                ))}
              </div>
            </Card>

            <Card>
              <SecHead title="Network"/>
              <Input label="Network name" value={`${app.name}_default`} onChange={()=>{}} mono hint="Docker network this app joins. Other containers on the same network can reach it by name."/>
              <Input label="Extra hosts" value="" onChange={()=>{}} mono placeholder="db:100.64.0.10" hint="Injected into /etc/hosts. Useful for mesh IP aliases."/>
            </Card>

            <Card>
              <SecHead title="Labels"/>
              <Input label="Labels" value={`hub.project=${project.name}\nhub.env=${envName}`} onChange={()=>{}} mono hint="Docker labels applied to this container. One KEY=VALUE per line."/>
            </Card>

            <div style={{background:`${T.red}08`,border:`0.5px solid ${T.red}33`,borderRadius:8,padding:'14px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:T.red,marginBottom:2}}>Delete app</div>
                <div style={{fontSize:12,color:T.sec}}>{isDb?'Deletes the app and its persistent volume. Data is permanently lost. Make a backup first.':'Removes this app and all deploy history.'}</div>
              </div>
              <button onClick={()=>toast.error('Confirm required','Type the app name to confirm deletion.')} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:`0.5px solid ${T.red}44`,background:`${T.red}10`,color:T.red,cursor:'pointer',fontWeight:500,flexShrink:0}}>Delete</button>
            </div>
          </div>
        )}

      </div>
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT DETAIL VIEW  (project overview → environment tabs → app list)
// ═══════════════════════════════════════════════════════════════════════════════

function ProjectDetailView({ project, onBack, onOpenApp, onOpenDeploy }) {
  const toast = useToast();
  const data = PROJECT_DATA[project.id];
  const envNames = data ? Object.keys(data.envs) : ['production','staging','development'];
  const [activeEnv, setActiveEnv] = useState(envNames[0]);
  const [showNewApp, setShowNewApp] = useState(false);
  const envData = data?.envs[activeEnv];
  const apps    = envData?.apps || [];

  return (
    <div style={{padding:'24px 30px',maxWidth:1000}}>
      {showNewApp && <CreateAppModal project={project} env={activeEnv} onClose={()=>setShowNewApp(false)} onCreated={app=>{setShowNewApp(false);onOpenApp(app,activeEnv,true);}}/>}

      {/* Breadcrumb */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:20,fontSize:13}}>
        <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,padding:0}}>← Projects</button>
        <span style={{color:T.muted}}>/</span>
        <span style={{color:T.sec}}>{project.name}</span>
      </div>

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:22}}>
        <div>
          <div style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em',marginBottom:5}}>{project.name}</div>
          <div style={{fontSize:13,color:T.sec}}>{project.desc}</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button style={{padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,fontSize:12,cursor:'pointer'}}>⚙ Settings</button>
          <button onClick={()=>{ const t=toast.loading('Queueing deploys…',`${project.name} — all apps`); setTimeout(()=>t.update('success','All deploys triggered',`${project.name} apps are deploying.`),1200); }} style={{padding:'7px 14px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>🚀 Deploy all</button>
        </div>
      </div>

      {/* Env summary strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:22}}>
        {envNames.map(env=>{
          const ed = data?.envs[env];
          const appCount = ed?.apps.length||0;
          const running  = ed?.apps.filter(a=>a.status==='running').length||0;
          const isActive = activeEnv===env;
          return (
            <button key={env} onClick={()=>setActiveEnv(env)} style={{background:isActive?T.card:T.elevated,border:`0.5px solid ${isActive?T.borderMd:T.border}`,borderRadius:8,padding:'14px 16px',cursor:'pointer',textAlign:'left',borderTop:`2px solid ${eColor(ed?.status||'stopped')}`}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <span style={{fontSize:13,fontWeight:600,color:isActive?T.text:T.sec,textTransform:'capitalize'}}>{env}</span>
                <Pill label={ed?.status||'unknown'} color={eColor(ed?.status||'stopped')}/>
              </div>
              <div style={{fontSize:12,color:T.muted}}>{running}/{appCount} apps running · {ed?.lastDeploy||'—'}</div>
              {ed?.server&&<div style={{fontSize:11,color:T.muted,fontFamily:'monospace',marginTop:3}}>{ed.server}</div>}
            </button>
          );
        })}
      </div>

      {/* App list for active env */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <h3 style={{margin:0,fontSize:13,fontWeight:500,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em'}}>{activeEnv}</h3>
          <span style={{fontSize:12,color:T.muted}}>{apps.length} apps</span>
        </div>
        <button onClick={()=>setShowNewApp(true)} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 13px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,fontSize:12,cursor:'pointer'}}>
          ＋ New app
        </button>
      </div>

      {apps.length===0 ? (
        <div style={{padding:'48px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
          <div style={{fontSize:32,marginBottom:12}}>📦</div>
          <div style={{fontSize:14,fontWeight:500,color:T.text,marginBottom:6}}>No apps in {activeEnv}</div>
          <div style={{fontSize:12,color:T.sec,marginBottom:16}}>Add your first app to start deploying.</div>
          <button onClick={()=>setShowNewApp(true)} style={{padding:'8px 20px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New app</button>
        </div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {apps.map(app=>{
            const statusColor = app.status==='running'?T.green:app.status==='deploying'?T.blue:app.status==='stopped'?T.muted:T.amber;
            return (
              <div key={app.id} style={{background:T.card,border:`0.5px solid ${app.status==='deploying'?T.blue+'44':T.border}`,borderRadius:9,padding:'14px 18px',display:'flex',alignItems:'center',gap:14}}>
                <div style={{width:36,height:36,borderRadius:8,background:T.elevated,border:`1px solid ${APP_TYPE_COLOR[app.type]||T.blue}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
                  {APP_TYPE_ICON[app.type]||'📦'}
                </div>
                {/* Name + image */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <button onClick={()=>onOpenApp(app,activeEnv)} style={{background:'none',border:'none',cursor:'pointer',padding:0,fontSize:14,fontWeight:600,color:T.blue}}>{app.name}</button>
                    <Pill label={app.type} color={APP_TYPE_COLOR[app.type]||T.blue}/>
                  </div>
                  <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{app.image}</div>
                </div>
                {/* Domain */}
                <div style={{flexShrink:0,minWidth:140}}>
                  {app.domain
                    ? <a href={`https://${app.domain}`} style={{fontSize:12,color:T.blue,textDecoration:'none'}}>{app.domain} ↗</a>
                    : app.port ? <span style={{fontSize:12,color:T.muted,fontFamily:'monospace'}}>:{app.port}</span>
                    : <span style={{fontSize:12,color:T.muted}}>no domain</span>
                  }
                </div>
                {/* CPU/Mem */}
                <div style={{flexShrink:0,minWidth:110}}>
                  {app.status!=='stopped' ? (
                    <div>
                      <div style={{marginBottom:5}}><MiniBar value={app.cpu!==null?Math.round(app.cpu):null} width={80}/></div>
                      <div style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{app.mem ? app.mem+' MB' : '—'}</div>
                    </div>
                  ) : <span style={{fontSize:12,color:T.muted}}>—</span>}
                </div>
                {/* Replicas */}
                <div style={{flexShrink:0,textAlign:'center',minWidth:50}}>
                  <div style={{fontSize:11,color:T.sec,marginBottom:2}}>replicas</div>
                  <div style={{fontSize:14,fontWeight:600,color:app.replicas>0?T.text:T.muted}}>{app.replicas}</div>
                </div>
                {/* Status + actions */}
                <div style={{flexShrink:0,display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <Dot color={statusColor} size={6}/>
                    <span style={{fontSize:12,color:statusColor}}>{app.status}</span>
                  </div>
                  <div style={{display:'flex',gap:6}}>
                    <button onClick={()=>onOpenApp(app,activeEnv)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Open</button>
                    <button onClick={()=>{ const t=toast.loading('Queueing…',`${app.name} @ ${activeEnv}`); setTimeout(()=>t.update('success','Deploy triggered',`${app.name} deployment is running.`),1000); }} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:500}}>Deploy</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS LIST VIEW (clickable cards)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE PROJECT WIZARD
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ICONS = ['◫','⬡','◈','▣','⚡','🚀','⚙','🗂','📦','🔍','🕸','💾'];
const PROJECT_COLORS = [T.blue, T.green, T.cyan, T.purple, T.amber, T.orange, T.red];

function CreateProjectWizard({ onClose, onCreated, nav }) {
  const toast = useToast();
  const [step, setStep]         = useState(0); // 0=basics, 1=done
  const [name, setName]         = useState('');
  const [desc, setDesc]         = useState('');
  const [slug, setSlug]         = useState('');
  const [icon, setIcon]         = useState('◫');
  const [color, setColor]       = useState(T.blue);
  const [showMoreEnvs, setMoreEnvs] = useState(false);
  const [stagingOn, setStagingOn]   = useState(false);
  const [devOn, setDevOn]           = useState(false);
  const [nameError, setNameError]   = useState('');

  // Auto-slug from name
  const autoSlug = n => n.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);
  const handleName = v => {
    setName(v);
    setSlug(autoSlug(v));
    if (nameError) setNameError('');
  };

  const create = () => {
    if (!name.trim()) { setNameError('Project name is required'); return; }
    if (name.trim().length < 2) { setNameError('Name must be at least 2 characters'); return; }
    setStep(1);
  };

  const finish = (goTo) => {
    toast.success('Project created', `${name} — production environment is ready.`);
    onClose();
    if (goTo === 'project' && onCreated) onCreated({ name, slug, desc, icon, color });
    else nav('projects');
  };

  const ENV_CARD = ({ label, enabled, canToggle, onToggle, description, color: ec }) => (
    <div style={{background:T.card,border:`0.5px solid ${enabled?ec+'44':T.border}`,borderRadius:9,padding:'14px 16px',opacity:canToggle?1:1}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:enabled&&canToggle?0:0}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <Dot color={enabled?ec:T.muted} size={8}/>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.text,textTransform:'capitalize'}}>{label}</div>
            <div style={{fontSize:11,color:T.muted,marginTop:1}}>{description}</div>
          </div>
        </div>
        {canToggle && (
          <div onClick={onToggle} style={{width:36,height:20,borderRadius:10,background:enabled?ec:T.elevated,border:`0.5px solid ${enabled?ec:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
            <div style={{position:'absolute',top:2,left:enabled?18:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.35)'}}/>
          </div>
        )}
        {!canToggle && <Pill label="always on" color={ec}/>}
      </div>
      {!enabled && canToggle && (
        <div style={{fontSize:11,color:T.muted,marginTop:8,padding:'6px 10px',background:T.elevated,borderRadius:5}}>
          Enable to configure servers, env vars, and deploy apps in this environment.
        </div>
      )}
    </div>
  );

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:520,maxHeight:'90vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>

        {/* Header */}
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:T.text}}>
              {step===0 ? 'New project' : `${name} is ready`}
            </div>
            <div style={{fontSize:12,color:T.sec,marginTop:2}}>
              {step===0 ? 'Set up a project to organize your apps and deployments' : 'Production environment created'}
            </div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>

        {/* Body */}
        <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>

          {/* ── Step 0: Basics ── */}
          {step===0 && (
            <div>
              {/* Name */}
              <div style={{marginBottom:16}}>
                <Input
                  label="Project name"
                  value={name}
                  onChange={e=>handleName(e.target.value)}
                  placeholder="dashboard"
                  hint="The product or service this project represents."
                  error={nameError}
                />
                {slug && (
                  <div style={{fontSize:11,color:T.muted,marginTop:4,fontFamily:'monospace'}}>
                    slug: <span style={{color:T.sec}}>{slug}</span>
                  </div>
                )}
              </div>

              {/* Description */}
              <Input
                label="Description"
                value={desc}
                onChange={e=>setDesc(e.target.value)}
                placeholder="Customer-facing web app and API"
                hint="Optional — shown on the project card."
              />

              {/* Icon + colour */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:20}}>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Icon</label>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    {PROJECT_ICONS.map(ic=>(
                      <button key={ic} onClick={()=>setIcon(ic)} style={{width:32,height:32,borderRadius:7,border:`1px solid ${icon===ic?T.blue:T.border}`,background:icon===ic?`${T.blue}15`:T.elevated,fontSize:15,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>
                        {ic}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Colour</label>
                  <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
                    {PROJECT_COLORS.map(c=>(
                      <button key={c} onClick={()=>setColor(c)} style={{width:26,height:26,borderRadius:'50%',background:c,border:color===c?`2.5px solid #fff`:'1.5px solid transparent',boxShadow:color===c?`0 0 0 2px ${c}`:'none',cursor:'pointer',transition:'all 0.12s'}}/>
                    ))}
                  </div>
                  {/* Preview */}
                  <div style={{marginTop:10,display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:T.elevated,borderRadius:6,border:`0.5px solid ${T.border}`}}>
                    <div style={{width:22,height:22,borderRadius:5,background:`${color}18`,border:`1px solid ${color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13}}>{icon}</div>
                    <span style={{fontSize:12,fontWeight:500,color:T.text}}>{name||'my-project'}</span>
                  </div>
                </div>
              </div>

              {/* Environments */}
              <div style={{marginBottom:4}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Environments</label>

                {/* Production — always on */}
                <div style={{marginBottom:8}}>
                  <ENV_CARD
                    label="production"
                    enabled={true}
                    canToggle={false}
                    color={T.red}
                    description="Always created. Your live, customer-facing environment."
                  />
                </div>

                {/* Staging + dev — behind more */}
                {showMoreEnvs ? (
                  <div style={{display:'flex',flexDirection:'column',gap:8}}>
                    <ENV_CARD
                      label="staging"
                      enabled={stagingOn}
                      canToggle={true}
                      onToggle={()=>setStagingOn(v=>!v)}
                      color={T.amber}
                      description="Pre-production testing. Enable when you're ready to configure it."
                    />
                    <ENV_CARD
                      label="development"
                      enabled={devOn}
                      canToggle={true}
                      onToggle={()=>setDevOn(v=>!v)}
                      color={T.blue}
                      description="Local or shared dev environment. Enable when you need it."
                    />
                    <button onClick={()=>setMoreEnvs(false)} style={{fontSize:11,color:T.muted,background:'none',border:'none',cursor:'pointer',padding:'4px 0',textAlign:'left'}}>
                      ▲ hide
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>setMoreEnvs(true)} style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.muted,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
                    <span>··· add staging / development</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Step 1: Done ── */}
          {step===1 && (
            <div style={{textAlign:'center',padding:'12px 0 8px'}}>
              {/* Project card preview */}
              <div style={{display:'inline-flex',alignItems:'center',gap:12,padding:'16px 22px',background:T.elevated,border:`0.5px solid ${color}44`,borderRadius:12,marginBottom:24,textAlign:'left'}}>
                <div style={{width:42,height:42,borderRadius:10,background:`${color}18`,border:`1px solid ${color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>
                  {icon}
                </div>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:3}}>{name}</div>
                  {desc&&<div style={{fontSize:12,color:T.muted,marginBottom:6}}>{desc}</div>}
                  <div style={{display:'flex',gap:6}}>
                    <span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:`${T.red}15`,color:T.red,border:`0.5px solid ${T.red}33`}}>production</span>
                    {stagingOn&&<span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:`${T.amber}15`,color:T.amber,border:`0.5px solid ${T.amber}33`}}>staging</span>}
                    {devOn&&<span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:`${T.blue}15`,color:T.blue,border:`0.5px solid ${T.blue}33`}}>development</span>}
                  </div>
                </div>
              </div>

              <div style={{fontSize:14,fontWeight:600,color:T.text,marginBottom:6}}>Project created</div>
              <div style={{fontSize:13,color:T.sec,marginBottom:8,lineHeight:'20px'}}>
                Next: add your first app — choose a container, worker, or database to deploy into production.
              </div>
              {(stagingOn||devOn) && (
                <div style={{fontSize:12,color:T.muted,marginBottom:20,padding:'8px 14px',background:T.elevated,borderRadius:6,border:`0.5px solid ${T.border}`,textAlign:'left'}}>
                  {[stagingOn&&'Staging',devOn&&'Development'].filter(Boolean).join(' + ')} {stagingOn&&devOn?'are':'is'} included but disabled — configure servers and env vars when you're ready.
                </div>
              )}

              {/* What's next checklist */}
              <div style={{background:T.elevated,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'12px 14px',textAlign:'left',marginBottom:20}}>
                <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10,fontWeight:500}}>Next steps</div>
                {[
                  ['Add your first app',       '→ Deploy a container, worker, or database'],
                  ['Connect a repository',     '→ Wire Forgejo/GitHub to auto-deploy on push'],
                  ['Configure env vars',       '→ Set secrets before first deploy'],
                  ['Set up a domain',          '→ Add a hostname and SSL cert'],
                ].map(([title,sub])=>(
                  <div key={title} style={{display:'flex',gap:10,padding:'6px 0',borderBottom:`0.5px solid ${T.border}`}}>
                    <span style={{color:T.muted,fontSize:13}}>○</span>
                    <div>
                      <div style={{fontSize:12,fontWeight:500,color:T.text}}>{title}</div>
                      <div style={{fontSize:11,color:T.muted}}>{sub}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          {step===0 ? (
            <>
              <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
              <button onClick={create} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 24px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
                Create project →
              </button>
            </>
          ) : (
            <>
              <button onClick={()=>finish('projects')} style={{background:'none',border:`0.5px solid ${T.border}`,borderRadius:7,padding:'8px 16px',color:T.sec,fontSize:13,cursor:'pointer'}}>
                Back to projects
              </button>
              <button onClick={()=>finish('project')} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
                Open project →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectsView({ onSelect, nav }) {
  const [showWizard, setShowWizard] = useState(false);
  const toast = useToast();
  return (
    <div style={{padding:'28px 30px'}}>
      {showWizard && (
        <CreateProjectWizard
          onClose={()=>setShowWizard(false)}
          onCreated={p=>{ setShowWizard(false); if(onSelect) onSelect({...p,id:'p'+Date.now(),apps:0,lastDeploy:'just now',deploying:false,envs:{production:'healthy',...(p.stagingOn?{staging:'stopped'}:{}),...(p.devOn?{development:'stopped'}:{})}}); }}
          nav={nav}
        />
      )}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Projects</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>5 projects · 17 apps · 3 environments</p>
        </div>
        <button onClick={()=>setShowWizard(true)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New project</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
        {PROJECTS.map(p=>(
          <div key={p.id} onClick={()=>onSelect&&onSelect(p)} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',cursor:'pointer',transition:'border-color 0.12s'}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=T.borderMd}
            onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:14}}>
              <div>
                <div style={{fontSize:15,fontWeight:600,color:T.blue,letterSpacing:'-0.01em'}}>{p.name}</div>
                <div style={{fontSize:12,color:T.sec,marginTop:4}}>{p.desc}</div>
              </div>
              {p.deploying&&<Pill label="deploying" color={T.blue}/>}
            </div>
            <div style={{display:'flex',gap:7,marginBottom:14}}>
              {Object.entries(p.envs).map(([env,st])=>(<div key={env} style={{flex:1,background:T.elevated,borderRadius:5,padding:'6px 10px',borderTop:`2px solid ${eColor(st)}`}}><div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em'}}>{env.slice(0,4)}</div><div style={{fontSize:11,color:eColor(st),marginTop:3,fontWeight:500}}>{st}</div></div>))}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:T.sec}}><span>{p.apps} apps</span><span>last deploy {p.lastDeploy}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOYMENT DETAIL VIEW
// ═══════════════════════════════════════════════════════════════════════════════

const LIVE_LOG_LINES = [
  '  Container exited gracefully after 1.8s',
  '✓ Previous container stopped',
  '→ docker create --name web-app-stg-1 \\',
  '    --env-file /opt/hub/envs/dashboard-staging.env \\',
  '    --network dashboard_default \\',
  '    --restart unless-stopped \\',
  '    -p 3001:3000 \\',
  '    registry/dashboard:v2.14.2-rc',
  'Container ID: f7a8b9c0d1e2',
  '→ docker start web-app-stg-1',
  '✓ Container started',
  '  Waiting for process to initialize…',
  '→ GET http://10.0.1.11:3001/health (attempt 1/10)…',
  '  Response: 503 — container still initializing',
  '→ GET http://10.0.1.11:3001/health (attempt 2/10)…',
  '  Response: 200 OK {"status":"ok","version":"v2.14.2-rc"}',
  '✓ Health check passed (4s)',
  '✓ Deployment complete — v2.14.2-rc live on prod-web-02',
];

function StepStatusIcon({ status, index }) {
  const base = { width:32, height:32, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, border:'2px solid' };
  if (status === 'success') return <div style={{...base, background:`${T.green}20`, borderColor:T.green, color:T.green}}>✓</div>;
  if (status === 'failed')  return <div style={{...base, background:`${T.red}20`,   borderColor:T.red,   color:T.red}}>✗</div>;
  if (status === 'skipped') return <div style={{...base, background:T.elevated,       borderColor:T.muted, color:T.muted}}>—</div>;
  if (status === 'pending') return <div style={{...base, background:T.elevated,       borderColor:T.muted, color:T.muted, fontSize:11}}>{index+1}</div>;
  // running
  return (
    <div style={{...base, background:`${T.blue}20`, borderColor:T.blue}}>
      <div style={{width:14,height:14,border:`2px solid ${T.blue}`,borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
    </div>
  );
}

function LogPanel({ lines, live=false, liveLines=[] }) {
  const ref = useRef(null);
  const allLines = live ? [...lines, ...liveLines] : lines;
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [allLines.length]);
  if (allLines.length === 0) return null;
  return (
    <div ref={ref} style={{background:'#090b11', borderRadius:6, padding:'10px 14px', fontFamily:'"SF Mono",Menlo,monospace', fontSize:11, lineHeight:'19px', maxHeight:220, overflowY:'auto', border:`0.5px solid ${T.border}`, marginTop:12}}>
      {allLines.map((line, i) => {
        const color = line.startsWith('✓') ? T.green : line.startsWith('✗') || line.includes('Error') || line.includes('failed') || line.includes('caused') ? T.red : line.startsWith('→') ? T.blue : line.startsWith('  ') ? T.sec : T.text;
        return <div key={i} style={{color, whiteSpace:'pre-wrap', wordBreak:'break-all'}}>{line||'\u00a0'}</div>;
      })}
      {live && <span style={{display:'inline-block',width:6,height:12,background:T.blue,verticalAlign:'text-bottom',animation:'blink 1s step-end infinite',marginLeft:2}}/>}
    </div>
  );
}

function DeploymentDetailView({ deployment, onBack }) {
  const detail   = DEPLOY_DETAILS[deployment.id];
  const isLive   = deployment.status === 'running';
  const isFailed = deployment.status === 'failed';

  // Which step is expanded
  const [expanded, setExpanded] = useState(() => {
    if (!detail) return null;
    // Auto-open the active/failed step
    const active = detail.steps.findIndex(s => s.status === 'running' || s.status === 'failed');
    return active >= 0 ? active : detail.steps.length - 1;
  });

  // Live simulation state for d2 (running deploy)
  const [liveStepIdx, setLiveStepIdx]   = useState(2); // stop is step index 2
  const [livePhase, setLivePhase]       = useState('stopping'); // stopping | starting | healthcheck | done
  const [liveLogLines, setLiveLogLines] = useState([]);
  const [liveSteps, setLiveSteps]       = useState(detail?.steps ? [...detail.steps] : []);
  const liveLogRef = useRef(0);

  useEffect(() => {
    if (!isLive || !detail) return;

    // Feed log lines one at a time into the active step
    const feedLog = (lines, stepIdx, onDone, delayMs=220) => {
      let i = 0;
      const tick = () => {
        if (i >= lines.length) { onDone(); return; }
        setLiveLogLines(prev => [...prev, lines[i++]]);
        setTimeout(tick, delayMs);
      };
      tick();
    };

    // Phase: finish stop step, then start, then healthcheck
    const stopLines = ['  Container exited gracefully after 1.8s', '✓ Previous container stopped'];
    const startLines = LIVE_LOG_LINES.slice(2, 12);
    const hcLines    = LIVE_LOG_LINES.slice(12);

    // Stop → done after 2.5s
    const t1 = setTimeout(() => {
      feedLog(stopLines, 2, () => {
        // Transition stop → success, start → running
        setLiveSteps(prev => prev.map((s,i) =>
          i===2 ? {...s, status:'success', duration:'4s'} :
          i===3 ? {...s, status:'running', started_at:Date.now()} : s
        ));
        setLiveStepIdx(3);
        setExpanded(3);
        setLiveLogLines([]);
        setLivePhase('starting');

        // Start → done after 4s
        const t2 = setTimeout(() => {
          feedLog(startLines, 3, () => {
            setLiveSteps(prev => prev.map((s,i) =>
              i===3 ? {...s, status:'success', duration:'5s'} :
              i===4 ? {...s, status:'running', started_at:Date.now()} : s
            ));
            setLiveStepIdx(4);
            setExpanded(4);
            setLiveLogLines([]);
            setLivePhase('healthcheck');

            // Health check → done after 4s
            const t3 = setTimeout(() => {
              feedLog(hcLines, 4, () => {
                setLiveSteps(prev => prev.map((s,i) =>
                  i===4 ? {...s, status:'success', duration:'4s'} : s
                ));
                setLiveStepIdx(5);
                setLivePhase('done');
              }, 280);
            }, 800);
            return () => clearTimeout(t3);
          }, 260);
        }, 600);
        return () => clearTimeout(t2);
      }, 260);
    }, 1200);

    return () => clearTimeout(t1);
  }, [isLive]);

  if (!detail) {
    return (
      <div style={{padding:'28px 30px'}}>
        <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,fontSize:13,padding:0,marginBottom:20}}>← Deployments</button>
        <div style={{padding:'60px',textAlign:'center',color:T.muted,fontSize:13}}>No detail data for this deployment.</div>
      </div>
    );
  }

  const steps = isLive ? liveSteps : detail.steps;
  const currentStatus = isLive && livePhase !== 'done' ? 'running' : deployment.status;
  const overallColor  = {success:T.green, running:T.blue, failed:T.red, pending:T.amber}[currentStatus] || T.muted;

  // Overall elapsed
  const elapsed = deployment.duration !== '—' ? deployment.duration
    : isLive ? Math.round((Date.now() - (steps[0]?.started_at||Date.now())) / 1000) + 's' : '—';

  return (
    <div style={{padding:'24px 30px', maxWidth:1000}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes blink{0%,100%{opacity:1}50%{opacity:0}} @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>

      {/* Breadcrumb */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:20}}>
        <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,fontSize:13,padding:0}}>← Deployments</button>
        <span style={{color:T.muted}}>/</span>
        <span style={{fontSize:13,color:T.sec}}>{deployment.project}/{deployment.app}</span>
        <span style={{color:T.muted}}>/</span>
        <span style={{fontSize:13,color:T.sec,fontFamily:'monospace'}}>{deployment.version}</span>
      </div>

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:22}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:6}}>
            <div style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>
              {deployment.project}<span style={{color:T.sec,fontWeight:400}}> / {deployment.app}</span>
            </div>
            <Pill label={deployment.env} color={deployment.env==='production'?T.red:deployment.env==='staging'?T.amber:T.blue}/>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:8,height:8,borderRadius:'50%',background:overallColor,boxShadow:currentStatus==='running'?`0 0 0 3px ${T.blue}30`:undefined,animation:currentStatus==='running'?'pulse 2s ease-in-out infinite':undefined}}/>
              <span style={{fontSize:13,fontWeight:500,color:overallColor}}>
                {currentStatus==='running'&&livePhase!=='done'?'Deploying…':currentStatus}
              </span>
            </div>
            <span style={{color:T.muted}}>·</span>
            <span style={{fontSize:12,color:T.sec,fontFamily:'monospace'}}>{deployment.version}</span>
            <span style={{color:T.muted}}>·</span>
            <span style={{fontSize:12,color:T.sec,fontFamily:'monospace'}}>{deployment.commit}</span>
            <span style={{color:T.muted}}>·</span>
            <span style={{fontSize:12,color:T.sec}}>by {deployment.by}</span>
            <span style={{color:T.muted}}>·</span>
            <span style={{fontSize:12,color:T.muted}}>{deployment.ago}</span>
          </div>
        </div>
        <div style={{display:'flex',gap:8,flexShrink:0}}>
          {(currentStatus==='success'||currentStatus==='failed') && detail.meta?.rollback_to && (
            <button style={{display:'flex',alignItems:'center',gap:6,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.amber}44`,background:`${T.amber}11`,color:T.amber,fontSize:12,fontWeight:500,cursor:'pointer'}}>
              ↩ Rollback to {detail.meta.rollback_to}
            </button>
          )}
          {currentStatus==='failed' && (
            <button style={{display:'flex',alignItems:'center',gap:6,padding:'7px 14px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>
              ↻ Redeploy
            </button>
          )}
        </div>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,marginBottom:24}}>
        {[
          {l:'Status',    v:<span style={{fontSize:14,fontWeight:600,color:overallColor}}>{currentStatus==='running'&&livePhase!=='done'?'running':currentStatus}</span>},
          {l:'Duration',  v:<span style={{fontSize:14,fontWeight:600,color:T.text,fontFamily:'monospace'}}>{isLive&&livePhase!=='done'?elapsed:deployment.duration}</span>},
          {l:'Server',    v:<span style={{fontSize:13,fontWeight:500,color:T.text,fontFamily:'monospace'}}>{detail.meta?.server}</span>},
          {l:'Triggered', v:<span style={{fontSize:13,color:T.sec}}>{detail.meta?.triggered==='push'?'git push':'manual trigger'}</span>},
          {l:'Steps',     v:<span style={{fontSize:14,fontWeight:600,color:T.text}}>{steps.filter(s=>s.status==='success').length}<span style={{color:T.muted,fontWeight:400,fontSize:12}}> / {steps.length}</span></span>},
        ].map(s=>(
          <div key={s.l} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:7,padding:'11px 14px'}}>
            <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:7}}>{s.l}</div>
            {s.v}
          </div>
        ))}
      </div>

      {/* Error banner */}
      {isFailed && detail.meta?.error && (
        <div style={{background:`${T.red}10`,border:`0.5px solid ${T.red}44`,borderRadius:8,padding:'12px 16px',marginBottom:20,display:'flex',gap:10,alignItems:'flex-start'}}>
          <span style={{color:T.red,fontSize:16,flexShrink:0}}>✗</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.red,marginBottom:4}}>Deployment failed</div>
            <div style={{fontSize:12,color:T.sec}}>{detail.meta.error}</div>
          </div>
        </div>
      )}

      {/* Pipeline */}
      <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:20}}>

        {/* Left: step list */}
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {steps.map((step, i) => {
            const def     = STEP_DEFS[i];
            const isExp   = expanded === i;
            const isAct   = step.status === 'running';
            const isDone  = step.status === 'success';
            const isFail  = step.status === 'failed';
            const isSkip  = step.status === 'skipped';
            const isPend  = step.status === 'pending';

            return (
              <div key={step.key} style={{display:'flex',gap:0,opacity:isPend?0.45:1,transition:'opacity 0.3s'}}>
                {/* Connector line */}
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',width:32,flexShrink:0}}>
                  <StepStatusIcon status={step.status} index={i}/>
                  {i < steps.length-1 && (
                    <div style={{width:2,flex:1,minHeight:20,background:isDone?T.green:isAct?T.blue:T.elevated,transition:'background 0.4s',margin:'4px 0'}}/>
                  )}
                </div>

                {/* Step card */}
                <div
                  onClick={() => !isPend && !isSkip && setExpanded(isExp ? null : i)}
                  style={{flex:1,marginLeft:12,marginBottom:i<steps.length-1?0:0,paddingBottom:i<steps.length-1?16:0,cursor:(!isPend&&!isSkip)?'pointer':'default'}}
                >
                  <div style={{
                    background: isExp ? (isFail?`${T.red}08`:isAct?`${T.blue}08`:T.card) : T.card,
                    border:`0.5px solid ${isExp?(isFail?T.red+'44':isAct?T.blue+'44':T.borderMd):T.border}`,
                    borderRadius:8, padding:'10px 14px', transition:'border-color 0.15s,background 0.15s',
                  }}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:isDone?T.text:isAct?T.blue:isFail?T.red:T.sec}}>{def.label}</div>
                        <div style={{fontSize:11,color:T.muted,marginTop:2}}>{def.desc}</div>
                      </div>
                      <div style={{textAlign:'right',flexShrink:0,marginLeft:12}}>
                        {step.duration && <div style={{fontSize:11,fontFamily:'monospace',color:T.muted}}>{step.duration}</div>}
                        {isAct && <div style={{fontSize:10,color:T.blue,marginTop:2}}>in progress</div>}
                        {isSkip && <div style={{fontSize:10,color:T.muted}}>skipped</div>}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right: log panel for expanded step */}
        <div>
          {expanded !== null && steps[expanded] && (() => {
            const step   = steps[expanded];
            const def    = STEP_DEFS[expanded];
            const isRunning = step.status === 'running';
            const logs   = isLive && isRunning ? step.log : step.log;
            const live   = isLive && isRunning;

            return (
              <div style={{animation:'fadein 0.2s ease'}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
                  <span style={{fontSize:16}}>{def.icon}</span>
                  <div>
                    <div style={{fontSize:14,fontWeight:600,color:T.text}}>{def.label}</div>
                    <div style={{fontSize:12,color:T.sec,marginTop:2}}>{def.desc}</div>
                  </div>
                  {step.duration && (
                    <div style={{marginLeft:'auto',fontSize:12,fontFamily:'monospace',color:T.muted}}>{step.duration}</div>
                  )}
                </div>

                {/* Timing bar */}
                {step.status !== 'pending' && step.status !== 'skipped' && (
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'8px 12px',background:T.elevated,borderRadius:6,border:`0.5px solid ${T.border}`}}>
                    <Dot color={step.status==='success'?T.green:step.status==='running'?T.blue:step.status==='failed'?T.red:T.muted} size={7}/>
                    <span style={{fontSize:12,color:T.sec}}>
                      {step.status==='success' ? `Completed in ${step.duration}` :
                       step.status==='running' ? 'In progress…' :
                       step.status==='failed'  ? `Failed after ${step.duration||'—'}` : step.status}
                    </span>
                    {step.started_at && (
                      <span style={{marginLeft:'auto',fontSize:11,color:T.muted}}>{fmtAge(step.started_at)}</span>
                    )}
                  </div>
                )}

                {/* Log output */}
                {(logs.length > 0 || live) ? (
                  <LogPanel
                    lines={logs}
                    live={live}
                    liveLines={liveLogLines}
                  />
                ) : (
                  <div style={{padding:'24px',textAlign:'center',color:T.muted,fontSize:12,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:6}}>
                    {step.status==='pending' ? 'Waiting for previous step…' : 'No log output captured.'}
                  </div>
                )}

                {/* Done banner */}
                {isLive && livePhase==='done' && expanded===4 && (
                  <div style={{marginTop:12,background:`${T.green}10`,border:`0.5px solid ${T.green}44`,borderRadius:6,padding:'10px 14px',display:'flex',alignItems:'center',gap:10,animation:'fadein 0.3s ease'}}>
                    <span style={{fontSize:16}}>✓</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:T.green}}>Deployment complete</div>
                      <div style={{fontSize:12,color:T.sec,marginTop:2}}>{deployment.version} is live on {detail.meta?.server}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {expanded === null && (
            <div style={{padding:'40px',textAlign:'center',color:T.muted,fontSize:13,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
              Select a step on the left to view its log output.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeploymentsView({ onSelect }) {
  const [dismissed, setDismissed] = React.useState(new Set());
  const deployNotices = computeNotices()
    .filter(n => n.category === 'deploy' && !dismissed.has(n.id));
  const toast = useToast();
  return (
    <div style={{padding:'28px 30px'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Deployments</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Deployment history across all projects and environments</p>
        </div>
        <button onClick={()=>toast.info('Deploy wizard','Select a project and environment in the project view to trigger a deploy.',{duration:5000})} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>🚀 Trigger deploy</button>
      </div>
      <NoticeBar notices={deployNotices} onDismiss={id=>setDismissed(s=>new Set([...s,id]))}/>
      <Table cols={['Status','Project / App','Environment','Version','Commit','By','Duration','When','']} rows={DEPLOYMENTS} renderRow={(d,i,n)=>(
        <TR key={d.id} i={i} total={n}>
          <TD>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <Dot color={dColor(d.status)} size={7}/>
              <span style={{color:dColor(d.status),fontSize:12}}>{d.status}</span>
            </div>
          </TD>
          <TD>
            <button onClick={()=>onSelect&&onSelect(d)} style={{background:'none',border:'none',cursor:'pointer',padding:0,textAlign:'left'}}>
              <span style={{fontWeight:500,color:T.blue}}>{d.project}</span>
              <span style={{color:T.sec}}> / {d.app}</span>
            </button>
          </TD>
          <TD><Pill label={d.env} color={d.env==='production'?T.red:d.env==='staging'?T.amber:T.blue}/></TD>
          <TD style={{fontFamily:'monospace',fontSize:12,color:T.text}}>{d.version}</TD>
          <TD style={{fontFamily:'monospace',fontSize:12,color:T.sec}}>{d.commit}</TD>
          <TD style={{color:T.sec,fontSize:12}}>{d.by}</TD>
          <TD style={{fontFamily:'monospace',fontSize:12,color:T.sec}}>{d.duration}</TD>
          <TD style={{color:T.muted,fontSize:12}}>{d.ago}</TD>
          <TD>
            <button onClick={()=>onSelect&&onSelect(d)} style={{fontSize:11,padding:'3px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>
              {DEPLOY_DETAILS[d.id] ? 'Open →' : 'View →'}
            </button>
          </TD>
        </TR>
      )}/>
    </div>
  );
}

// ─── Network topology / policy data ──────────────────────────────────────────
const ACCESS_POLICIES_INIT = [
  { id:'pol1', name:'web-to-db',      src_group:'web-servers',   dst_group:'databases',     ports:['5432/tcp','6379/tcp'], enabled:true,  direction:'bidirectional' },
  { id:'pol2', name:'workers-to-db',  src_group:'workers',       dst_group:'databases',     ports:['5432/tcp'],            enabled:true,  direction:'unidirectional' },
  { id:'pol3', name:'ci-to-web',      src_group:'build-runners', dst_group:'web-servers',   ports:['22/tcp','7700/tcp'],   enabled:true,  direction:'unidirectional' },
  { id:'pol4', name:'admin-to-all',   src_group:'admin-devices', dst_group:'all',           ports:['22/tcp','7700/tcp'],   enabled:true,  direction:'unidirectional' },
  { id:'pol5', name:'staging-to-prod',src_group:'staging',       dst_group:'web-servers',   ports:[],                     enabled:false, direction:'unidirectional' },
];

const PEER_GROUPS = [
  { id:'web-servers',   label:'Web servers',   color:T.green,  peers:['prod-web-01','prod-web-02','stg-app-01'] },
  { id:'databases',     label:'Databases',     color:T.purple, peers:['prod-db-01'] },
  { id:'workers',       label:'Workers',       color:T.cyan,   peers:['prod-worker-01'] },
  { id:'build-runners', label:'Build runners', color:T.amber,  peers:['build-runner-01'] },
  { id:'admin-devices', label:'Admin devices', color:T.blue,   peers:['james-macbook','sarah-laptop'] },
  { id:'staging',       label:'Staging',       color:T.sec,    peers:['stg-app-01'] },
  { id:'all',           label:'All peers',     color:T.muted,  peers:[] },
];

function NetworkingView() {
  const toast = useToast();
  const [tab, setTab] = useState('peers');
  const [policies, setPolicies] = useState(ACCESS_POLICIES_INIT);
  const [showNewPolicy, setShowNewPolicy] = useState(false);
  const connected = PEERS.filter(p=>p.status==='connected').length;

  // New policy form state
  const [npName,  setNpName]  = useState('');
  const [npSrc,   setNpSrc]   = useState('web-servers');
  const [npDst,   setNpDst]   = useState('databases');
  const [npPorts, setNpPorts] = useState('');
  const [npDir,   setNpDir]   = useState('unidirectional');

  const togglePolicy = id => {
    const p = policies.find(x=>x.id===id);
    setPolicies(ps=>ps.map(x=>x.id===id?{...x,enabled:!x.enabled}:x));
    toast(p.enabled?'warning':'success', p.enabled?`Policy disabled`:`Policy enabled`, p.name);
  };

  const deletePolicy = id => {
    const p = policies.find(x=>x.id===id);
    setPolicies(ps=>ps.filter(x=>x.id!==id));
    toast.success('Policy deleted', p.name);
  };

  const addPolicy = () => {
    if (!npName.trim()) { toast.error('Name required',''); return; }
    const ports = npPorts.split(',').map(s=>s.trim()).filter(Boolean);
    setPolicies(ps=>[...ps,{id:'pol'+Date.now(),name:npName,src_group:npSrc,dst_group:npDst,ports,enabled:true,direction:npDir}]);
    toast.success('Policy created', npName);
    setShowNewPolicy(false); setNpName(''); setNpPorts('');
  };

  const groupColor = id => PEER_GROUPS.find(g=>g.id===id)?.color || T.muted;

  return (
    <div style={{padding:'28px 30px'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Networking</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>{connected}/{PEERS.length} peers connected · WireGuard mesh · 100.64.0.0/16</p>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:22}}>
        <StatCard label="Connected"     value={connected}      sub="WireGuard tunnels" color={T.green}/>
        <StatCard label="Subnet"        value="100.64/16"      sub="CG-NAT range"/>
        <StatCard label="Policies"      value={policies.filter(p=>p.enabled).length} sub={`${policies.length} total`}/>
        <StatCard label="Peer groups"   value={PEER_GROUPS.length-1} sub="named groups"/>
      </div>

      <div style={{display:'flex',gap:2,borderBottom:`0.5px solid ${T.border}`,marginBottom:20}}>
        {['peers','topology','policies','setup-keys'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,textTransform:'capitalize'}}>
            {t.replace('-',' ')}
          </button>
        ))}
      </div>

      {/* ── Peers list ── */}
      {tab==='peers' && (
        <div>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:12}}>
            <button onClick={()=>toast.info('Generate setup key','Copy the key and run hub-agent --setup-key=<key> on the new peer.')} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>＋ Add peer</button>
          </div>
          <Table cols={['','Peer','IP Address','Kind','Group','Last seen','Actions']} rows={PEERS} renderRow={(p,i,n)=>(
            <TR key={p.id} i={i} total={n}>
              <TD style={{width:32}}><span style={{fontSize:13,color:p.status==='connected'?T.green:T.red}}>{p.status==='connected'?'⬤':'◯'}</span></TD>
              <TD style={{fontWeight:500,color:T.text}}>{p.name}</TD>
              <TD style={{fontFamily:'monospace',fontSize:12,color:T.sec}}>{p.ip}</TD>
              <TD><Pill label={p.kind} color={p.kind==='server'?T.blue:T.purple}/></TD>
              <TD><Pill label={p.kind==='server'?'web-servers':'admin-devices'} color={p.kind==='server'?T.green:T.blue}/></TD>
              <TD style={{color:T.muted,fontSize:12}}>{p.seen}</TD>
              <TD>
                <div style={{display:'flex',gap:6}}>
                  <button onClick={()=>toast.info('Peer info',`${p.name} · ${p.ip}`)} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Info</button>
                  {p.status==='disconnected'&&<button onClick={()=>toast.warning('Peer removed',p.name)} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Remove</button>}
                </div>
              </TD>
            </TR>
          )}/>
        </div>
      )}

      {/* ── Topology / groups ── */}
      {tab==='topology' && (
        <div>
          <div style={{fontSize:12,color:T.sec,marginBottom:16}}>Peer groups define the sources and destinations in access policies. Peers inherit group membership based on their kind and name.</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:10}}>
            {PEER_GROUPS.filter(g=>g.id!=='all').map(g=>(
              <div key={g.id} style={{background:T.card,border:`0.5px solid ${g.color}44`,borderRadius:9,padding:'14px 18px'}}>
                <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:10}}>
                  <div style={{width:10,height:10,borderRadius:'50%',background:g.color}}/>
                  <span style={{fontSize:13,fontWeight:600,color:T.text}}>{g.label}</span>
                  <span style={{fontSize:11,color:T.muted,marginLeft:'auto'}}>{g.peers.length} peer{g.peers.length!==1?'s':''}</span>
                </div>
                <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
                  {g.peers.map(peer=>{
                    const peerObj = PEERS.find(p=>p.name===peer);
                    const isConn  = peerObj?.status==='connected';
                    return (
                      <div key={peer} style={{display:'flex',alignItems:'center',gap:5,padding:'3px 8px',borderRadius:4,background:T.elevated,border:`0.5px solid ${T.border}`}}>
                        <Dot color={isConn?T.green:T.muted} size={5}/>
                        <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{peer}</span>
                      </div>
                    );
                  })}
                  {g.peers.length===0&&<span style={{fontSize:11,color:T.muted}}>all peers</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Traffic flow diagram */}
          <div style={{marginTop:20,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'18px 20px'}}>
            <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:14,fontWeight:500}}>Active traffic flows</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {policies.filter(p=>p.enabled).map(pol=>{
                const src = PEER_GROUPS.find(g=>g.id===pol.src_group);
                const dst = PEER_GROUPS.find(g=>g.id===pol.dst_group);
                return (
                  <div key={pol.id} style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:5,background:`${src?.color||T.sec}18`,border:`0.5px solid ${src?.color||T.sec}44`}}>
                      <Dot color={src?.color||T.sec} size={6}/>
                      <span style={{fontSize:11,color:src?.color||T.sec,fontWeight:500}}>{src?.label||pol.src_group}</span>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:4,flex:1}}>
                      <div style={{flex:1,height:1,background:T.border}}/>
                      {pol.ports.length>0&&<span style={{fontSize:9,color:T.muted,fontFamily:'monospace',flexShrink:0}}>{pol.ports.slice(0,2).join(', ')}</span>}
                      <span style={{color:T.muted,fontSize:11}}>→</span>
                      {pol.direction==='bidirectional'&&<span style={{color:T.muted,fontSize:11}}>←</span>}
                      <div style={{flex:1,height:1,background:T.border}}/>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:5,background:`${dst?.color||T.sec}18`,border:`0.5px solid ${dst?.color||T.sec}44`}}>
                      <Dot color={dst?.color||T.sec} size={6}/>
                      <span style={{fontSize:11,color:dst?.color||T.sec,fontWeight:500}}>{dst?.label||pol.dst_group}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Policies ── */}
      {tab==='policies' && (
        <div>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            <button onClick={()=>setShowNewPolicy(v=>!v)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>＋ New policy</button>
          </div>

          {showNewPolicy&&(
            <div style={{background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:9,padding:'16px 20px',marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>New access policy</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
                <Input label="Policy name" value={npName} onChange={e=>setNpName(e.target.value)} placeholder="web-to-db"/>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Direction</label>
                  <div style={{display:'flex',gap:6}}>
                    {['unidirectional','bidirectional'].map(d=>(
                      <button key={d} onClick={()=>setNpDir(d)} style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${npDir===d?T.blue:T.border}`,background:npDir===d?`${T.blue}15`:T.elevated,color:npDir===d?T.blue:T.sec,fontSize:11,cursor:'pointer',fontWeight:npDir===d?600:400}}>{d}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:16}}>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Source group</label>
                  <select value={npSrc} onChange={e=>setNpSrc(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:12,color:T.text,outline:'none'}}>
                    {PEER_GROUPS.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Destination group</label>
                  <select value={npDst} onChange={e=>setNpDst(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:12,color:T.text,outline:'none'}}>
                    {PEER_GROUPS.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </div>
                <Input label="Ports (comma-separated)" value={npPorts} onChange={e=>setNpPorts(e.target.value)} placeholder="5432/tcp, 6379/tcp" hint="Leave blank for all ports"/>
              </div>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={()=>setShowNewPolicy(false)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Cancel</button>
                <button onClick={addPolicy} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>Create policy</button>
              </div>
            </div>
          )}

          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {policies.map(pol=>{
              const src = PEER_GROUPS.find(g=>g.id===pol.src_group);
              const dst = PEER_GROUPS.find(g=>g.id===pol.dst_group);
              return (
                <div key={pol.id} style={{background:T.card,border:`0.5px solid ${pol.enabled?T.border:T.muted+'33'}`,borderRadius:8,padding:'13px 18px',display:'flex',alignItems:'center',gap:12,opacity:pol.enabled?1:0.55}}>
                  <div onClick={()=>togglePolicy(pol.id)} style={{width:32,height:18,borderRadius:9,background:pol.enabled?T.green:T.elevated,border:`0.5px solid ${pol.enabled?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
                    <div style={{position:'absolute',top:1,left:pol.enabled?15:1,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:5}}>{pol.name}</div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <Pill label={src?.label||pol.src_group} color={src?.color||T.sec}/>
                      <span style={{fontSize:11,color:T.muted}}>{pol.direction==='bidirectional'?'↔':'→'}</span>
                      <Pill label={dst?.label||pol.dst_group} color={dst?.color||T.sec}/>
                      {pol.ports.length>0&&(
                        <div style={{display:'flex',gap:4}}>
                          {pol.ports.slice(0,3).map(p=><code key={p} style={{fontSize:10,padding:'1px 5px',borderRadius:3,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`,fontFamily:'monospace'}}>{p}</code>)}
                          {pol.ports.length>3&&<span style={{fontSize:10,color:T.muted}}>+{pol.ports.length-3}</span>}
                        </div>
                      )}
                      {pol.ports.length===0&&<span style={{fontSize:11,color:T.muted}}>all ports</span>}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,flexShrink:0}}>
                    <button onClick={()=>deletePolicy(pol.id)} style={{fontSize:11,padding:'4px 9px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Setup keys ── */}
      {tab==='setup-keys' && (
        <div>
          <div style={{fontSize:12,color:T.sec,marginBottom:16,lineHeight:'18px'}}>
            Setup keys are one-time tokens used to register a new peer with the mesh. Generate a key, run the hub-agent command on the target machine, and it will join automatically.
          </div>
          <div style={{background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:8,padding:'14px 18px',marginBottom:20,fontFamily:'monospace',fontSize:12,color:T.sec}}>
            <div style={{color:T.muted,marginBottom:6}}># On the new server:</div>
            <span style={{color:T.blue}}>hub-agent</span>{' '}
            <span style={{color:T.amber}}>--setup-key</span>=<span style={{color:T.green}}>nhk_Abc123...</span>{' '}
            <span style={{color:T.amber}}>--hub-url</span>=<span style={{color:T.green}}>https://hub.acme.com</span>
          </div>
          <button onClick={()=>{
            const key='nhk_'+Math.random().toString(36).slice(2,18).toUpperCase();
            toast.success('Setup key generated',key+' · expires in 24h');
          }} style={{padding:'9px 18px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Generate setup key</button>
        </div>
      )}
    </div>
  );
}

// ─── Cron builder helpers ─────────────────────────────────────────────────────
const CRON_PRESETS = [
  { label:'Every minute',     cron:'* * * * *' },
  { label:'Every 5 minutes',  cron:'*/5 * * * *' },
  { label:'Every 15 minutes', cron:'*/15 * * * *' },
  { label:'Every hour',       cron:'0 * * * *' },
  { label:'Every 6 hours',    cron:'0 */6 * * *' },
  { label:'Daily at 2am',     cron:'0 2 * * *' },
  { label:'Daily at midnight',cron:'0 0 * * *' },
  { label:'Weekly (Sun 2am)', cron:'0 2 * * 0' },
  { label:'Monthly (1st)',    cron:'0 0 1 * *' },
];

function describeCron(c) {
  if (!c) return '';
  const preset = CRON_PRESETS.find(p=>p.cron===c);
  if (preset) return preset.label;
  const parts = c.split(' ');
  if (parts.length!==5) return c;
  const [min,hr,dom,mon,dow]=parts;
  if (min==='*'&&hr==='*') return 'Every minute';
  if (hr==='*'&&min.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
  if (dom==='*'&&mon==='*'&&dow==='*') return `Daily at ${hr}:${min==='0'?'00':min}`;
  if (dom==='*'&&mon==='*') return `Weekly on day ${dow} at ${hr}:${min==='0'?'00':min}`;
  return c;
}

function CronBuilder({ value, onChange }) {
  const [mode, setMode] = useState('preset');
  const [raw, setRaw]   = useState(value||'0 2 * * *');
  const [min,  setMin]  = useState('0');
  const [hr,   setHr]   = useState('2');
  const [dom,  setDom]  = useState('*');
  const [mon,  setMon]  = useState('*');
  const [dow,  setDow]  = useState('*');

  const builtCron = `${min} ${hr} ${dom} ${mon} ${dow}`;

  useEffect(()=>{ if(mode==='builder') onChange(builtCron); },[builtCron,mode]);
  useEffect(()=>{ if(mode==='raw') onChange(raw); },[raw,mode]);

  return (
    <div style={{background:T.elevated,borderRadius:8,border:`0.5px solid ${T.border}`,overflow:'hidden'}}>
      {/* Mode tabs */}
      <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`}}>
        {['preset','builder','raw'].map(m=>(
          <button key={m} onClick={()=>setMode(m)} style={{flex:1,padding:'8px',border:'none',background:mode===m?T.card:'transparent',color:mode===m?T.text:T.sec,fontSize:12,cursor:'pointer',textTransform:'capitalize',fontWeight:mode===m?500:400}}>
            {m==='raw'?'Custom':m.charAt(0).toUpperCase()+m.slice(1)}
          </button>
        ))}
      </div>

      <div style={{padding:'14px 16px'}}>
        {mode==='preset' && (
          <div style={{display:'flex',flexDirection:'column',gap:5}}>
            {CRON_PRESETS.map(p=>(
              <button key={p.cron} onClick={()=>{ onChange(p.cron); }} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 12px',borderRadius:6,border:`1px solid ${value===p.cron?T.blue:T.border}`,background:value===p.cron?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                <span style={{fontSize:12,color:value===p.cron?T.text:T.sec,fontWeight:value===p.cron?500:400}}>{p.label}</span>
                <code style={{fontSize:11,fontFamily:'monospace',color:value===p.cron?T.blue:T.muted}}>{p.cron}</code>
              </button>
            ))}
          </div>
        )}

        {mode==='builder' && (
          <div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:10}}>
              {[
                ['Minute', min, setMin, '0-59 or */n'],
                ['Hour',   hr,  setHr,  '0-23 or */n'],
                ['Day',    dom, setDom, '1-31 or *'],
                ['Month',  mon, setMon, '1-12 or *'],
                ['Weekday',dow, setDow, '0-6 or *'],
              ].map(([label,val,setter,hint])=>(
                <div key={label}>
                  <label style={{display:'block',fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:4}}>{label}</label>
                  <input value={val} onChange={e=>setter(e.target.value)} placeholder={hint}
                    style={{width:'100%',boxSizing:'border-box',background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:5,padding:'6px 8px',fontSize:12,color:T.text,fontFamily:'monospace',outline:'none'}}/>
                </div>
              ))}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:T.card,borderRadius:6,border:`0.5px solid ${T.border}`}}>
              <code style={{fontSize:13,fontFamily:'monospace',color:T.blue,flex:1}}>{builtCron}</code>
              <span style={{fontSize:12,color:T.sec}}>{describeCron(builtCron)}</span>
            </div>
          </div>
        )}

        {mode==='raw' && (
          <div>
            <input value={raw} onChange={e=>setRaw(e.target.value)}
              placeholder="0 2 * * *"
              style={{width:'100%',boxSizing:'border-box',background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'9px 12px',fontSize:13,color:T.blue,fontFamily:'monospace',outline:'none',marginBottom:8}}/>
            <div style={{fontSize:12,color:T.sec}}>{describeCron(raw)||'Enter a valid cron expression'}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const JOBS_INIT = [
  {id:'j1',name:'db-backup',project:'data-pipeline',schedule:'0 2 * * *',lastRun:'2h ago',status:'success',duration:'4m 12s',nextRun:'in 22h',cmd:'./scripts/backup.sh',enabled:true},
  {id:'j2',name:'cache-warm',project:'api-gateway',schedule:'*/15 * * * *',lastRun:'8m ago',status:'success',duration:'12s',nextRun:'in 7m',cmd:'curl -X POST http://localhost:8080/cache/warm',enabled:true},
  {id:'j3',name:'cleanup-logs',project:'data-pipeline',schedule:'0 0 * * 0',lastRun:'6d ago',status:'success',duration:'1m 45s',nextRun:'in 1d',cmd:'find /var/log -name "*.log" -mtime +7 -delete',enabled:true},
  {id:'j4',name:'send-digest',project:'notifications',schedule:'0 9 * * 1-5',lastRun:'1h ago',status:'running',duration:'—',nextRun:'tomorrow',cmd:'node scripts/send-digest.js',enabled:true},
  {id:'j5',name:'index-sync',project:'dashboard',schedule:'0 */4 * * *',lastRun:'4h ago',status:'failed',duration:'2s',nextRun:'in 0h',cmd:'npm run sync:index',enabled:true},
];

function JobsView() {
  const toast = useToast();
  const [jobs, setJobs]       = useState(JOBS_INIT);
  const [editJob, setEditJob] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCmd,  setNewCmd]  = useState('');
  const [newSched,setNewSched]= useState('0 2 * * *');
  const [newProj, setNewProj] = useState('api-gateway');

  const runJob = j => {
    const t=toast.loading('Running…',j.name);
    setJobs(js=>js.map(x=>x.id===j.id?{...x,status:'running'}:x));
    setTimeout(()=>{
      t.update('success','Job completed',j.name);
      setJobs(js=>js.map(x=>x.id===j.id?{...x,status:'success',lastRun:'just now'}:x));
    },2000);
  };

  const createJob = () => {
    if (!newName.trim()) { toast.error('Name required',''); return; }
    setJobs(js=>[...js,{id:'j'+Date.now(),name:newName,project:newProj,schedule:newSched,lastRun:'never',status:'success',duration:'—',nextRun:describeCron(newSched),cmd:newCmd,enabled:true}]);
    toast.success('Job created',newName);
    setShowNew(false); setNewName(''); setNewCmd('');
  };

  return (
    <div style={{padding:'28px 30px'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Scheduled Jobs</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Cron jobs and automation tasks across all projects</p>
        </div>
        <button onClick={()=>setShowNew(v=>!v)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New job</button>
      </div>

      {/* New job form */}
      {showNew&&(
        <div style={{background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:9,padding:'18px 20px',marginBottom:20}}>
          <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>New scheduled job</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
            <Input label="Job name" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="cleanup-logs"/>
            <div>
              <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Project</label>
              <select value={newProj} onChange={e=>setNewProj(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none'}}>
                {PROJECTS.map(p=><option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <Input label="Command" value={newCmd} onChange={e=>setNewCmd(e.target.value)} placeholder="./scripts/backup.sh" mono hint="Runs via hub-agent exec on the target server."/>
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Schedule</label>
            <CronBuilder value={newSched} onChange={setNewSched}/>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowNew(false)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Cancel</button>
            <button onClick={createJob} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>Create job</button>
          </div>
        </div>
      )}

      {/* Inline schedule editor */}
      {editJob&&(
        <div style={{background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:9,padding:'18px 20px',marginBottom:20}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:600,color:T.text}}>Edit schedule — {editJob.name}</div>
            <button onClick={()=>setEditJob(null)} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:18}}>✕</button>
          </div>
          <CronBuilder value={editJob.schedule} onChange={s=>setEditJob(j=>({...j,schedule:s}))}/>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:14}}>
            <button onClick={()=>setEditJob(null)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Cancel</button>
            <button onClick={()=>{
              setJobs(js=>js.map(j=>j.id===editJob.id?{...j,schedule:editJob.schedule}:j));
              toast.success('Schedule updated',editJob.name+' — '+describeCron(editJob.schedule));
              setEditJob(null);
            }} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>Save schedule</button>
          </div>
        </div>
      )}

      {/* Jobs table */}
      <Table cols={['Status','Job','Project','Schedule','Last Run','Duration','Next Run','Actions']} rows={jobs} renderRow={(j,i,n)=>(
        <TR key={j.id} i={i} total={n}>
          <TD><div style={{display:'flex',alignItems:'center',gap:6}}><Dot color={jColor(j.status)} size={6}/><span style={{color:jColor(j.status),fontSize:12}}>{j.status}</span></div></TD>
          <TD>
            <div style={{fontWeight:500,color:T.text}}>{j.name}</div>
            {j.cmd&&<div style={{fontSize:10,color:T.muted,fontFamily:'monospace',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}}>{j.cmd}</div>}
          </TD>
          <TD style={{color:T.sec,fontSize:12}}>{j.project}</TD>
          <TD>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <code style={{fontSize:11,fontFamily:'monospace',color:T.sec}}>{j.schedule}</code>
              <button onClick={()=>setEditJob(j)} style={{fontSize:9,padding:'1px 5px',borderRadius:3,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.muted,cursor:'pointer'}}>edit</button>
            </div>
            <div style={{fontSize:10,color:T.muted,marginTop:1}}>{describeCron(j.schedule)}</div>
          </TD>
          <TD style={{color:T.muted,fontSize:12}}>{j.lastRun}</TD>
          <TD style={{fontFamily:'monospace',fontSize:12,color:T.sec}}>{j.duration}</TD>
          <TD style={{color:T.sec,fontSize:12}}>{j.nextRun}</TD>
          <TD>
            <div style={{display:'flex',gap:5}}>
              <button onClick={()=>runJob(j)} disabled={j.status==='running'} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:'none',background:T.blue,color:'#fff',cursor:j.status==='running'?'not-allowed':'pointer',opacity:j.status==='running'?0.5:1}}>Run</button>
              <button onClick={()=>{setJobs(js=>js.filter(x=>x.id!==j.id));toast.success('Job deleted',j.name);}} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>
            </div>
          </TD>
        </TR>
      )}/>
    </div>
  );
}

function ObservabilityView() {
  const metrics=[{label:'Avg response time',value:'124 ms',sub:'+2ms vs yesterday',ok:true},{label:'Requests / min',value:'8,241',sub:'+12% vs last hour',ok:true},{label:'Error rate',value:'0.12%',sub:'-0.03% improving',ok:true},{label:'P95 latency',value:'380 ms',sub:'+15ms above baseline',ok:false}];
  return (
    <div style={{padding:'28px 30px'}}>
      <div style={{marginBottom:24}}><h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Observability Portal</h2><p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Metrics, logs, traces · Last 5 minutes</p></div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>{metrics.map(m=><StatCard key={m.label} label={m.label} value={m.value} sub={m.sub} color={m.ok?T.text:T.amber}/>)}</div>
      <Card>
        <SecHead title="Live Log Stream"/>
        <div style={{background:T.elevated,borderRadius:6,padding:'12px 16px',fontFamily:'"SF Mono",Menlo,monospace',fontSize:12,lineHeight:'22px'}}>
          {LOGS.map((l,i)=>(<div key={i} style={{display:'flex',gap:12}}><span style={{color:T.muted,flexShrink:0}}>{l.ts}</span><span style={{color:lColor(l.level),flexShrink:0,width:38}}>{l.level}</span><span style={{color:T.blue,flexShrink:0,width:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.svc}</span><span style={{color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.msg}</span></div>))}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHELL — Sidebar + TopBar + App
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SSH KEYS VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function AddKeyModal({ onClose, onAdd }) {
  const [name, setName]     = useState('');
  const [pubkey, setPubkey] = useState('');
  const [error, setError]   = useState('');
  const toast = useToast();

  const parsed = (() => {
    const t = pubkey.trim();
    if (!t) return null;
    const parts = t.split(' ');
    if (parts.length < 2) return null;
    const algo = parts[0].replace('ssh-', '').toUpperCase();
    const comment = parts[2] || null;
    return { algo, comment };
  })();

  const fingerprint = parsed
    ? 'SHA256:' + [...pubkey].reduce((h,c)=>((h<<5)-h+c.charCodeAt(0))|0, 0).toString(36).padEnd(43,'x').slice(0,43)
    : null;

  const submit = () => {
    if (!name.trim())  { setError('Key name is required'); return; }
    if (!pubkey.trim()) { setError('Public key is required'); return; }
    if (!parsed)        { setError('Key must start with ssh-rsa, ssh-ed25519, or ecdsa-sha2-nistp256'); return; }
    toast.success('SSH key added', `${name} is now available for server provisioning.`);
    onAdd({ name: name.trim(), pubkey: pubkey.trim(), parsed });
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:560,overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:T.text}}>Add SSH public key</div>
            <div style={{fontSize:12,color:T.sec,marginTop:2}}>Key will be installed on servers at provision time</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{padding:'20px 22px'}}>
          <Input
            label="Key name"
            value={name}
            onChange={e=>{ setName(e.target.value); setError(''); }}
            placeholder="prod-deploy-key"
            hint="A memorable label. Used when selecting keys for server provisioning."
            error={!name&&error?error:null}
          />
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Public key</label>
            <textarea
              value={pubkey}
              onChange={e=>{ setPubkey(e.target.value); setError(''); }}
              placeholder="ssh-ed25519 AAAAC3Nz... user@host"
              rows={4}
              style={{width:'100%',boxSizing:'border-box',background:T.elevated,border:`0.5px solid ${error&&!parsed&&pubkey?T.red:T.borderMd}`,borderRadius:6,padding:'9px 12px',fontSize:11,fontFamily:'monospace',color:T.text,outline:'none',resize:'vertical',lineHeight:'18px'}}
              onFocus={e=>e.target.style.borderColor=T.blue}
              onBlur={e=>e.target.style.borderColor=T.borderMd}
            />
            <div style={{fontSize:11,color:T.muted,marginTop:5}}>
              Paste the contents of your <code style={{fontFamily:'monospace',color:T.sec}}>~/.ssh/id_ed25519.pub</code> (or id_rsa.pub)
            </div>
          </div>

          {/* Live parse preview */}
          {pubkey.trim() && (
            <div style={{background:T.elevated,border:`0.5px solid ${parsed?T.green+'44':T.red+'44'}`,borderRadius:6,padding:'10px 14px',marginBottom:16}}>
              {parsed ? (
                <div style={{display:'flex',flexDirection:'column',gap:5}}>
                  <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                    <span style={{fontSize:12,color:T.green,fontWeight:600}}>✓ Valid {parsed.algo} key</span>
                  </div>
                  <div style={{display:'flex',gap:12}}>
                    <div>
                      <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Algorithm</div>
                      <div style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{parsed.algo}</div>
                    </div>
                    {parsed.comment && <div>
                      <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Comment</div>
                      <div style={{fontSize:12,color:T.text,fontFamily:'monospace'}}>{parsed.comment}</div>
                    </div>}
                    <div>
                      <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Fingerprint</div>
                      <div style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{fingerprint?.slice(0,24)}…</div>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{fontSize:12,color:T.red}}>✗ Unrecognised key format — must start with <code style={{fontFamily:'monospace'}}>ssh-ed25519</code>, <code style={{fontFamily:'monospace'}}>ssh-rsa</code>, or <code style={{fontFamily:'monospace'}}>ecdsa-sha2-nistp256</code></div>
              )}
            </div>
          )}

          {error && <div style={{fontSize:12,color:T.red,marginBottom:12}}>{error}</div>}
        </div>
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
          <button onClick={submit} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Add key</button>
        </div>
      </div>
    </div>
  );
}

function SSHKeysView() {
  const toast = useToast();
  const [keys, setKeys]           = useState(SSH_KEYS);
  const [showAdd, setShowAdd]     = useState(false);
  const [expanded, setExpanded]   = useState(null);
  const [copied, setCopied]       = useState(null);

  const copyKey = (id, text) => {
    navigator.clipboard?.writeText(text).catch(()=>{});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Copied', 'Public key copied to clipboard.');
  };

  const deleteKey = (key) => {
    if (key.servers.length > 0) {
      toast.warning('Key in use', `Remove from ${key.servers.length} server${key.servers.length!==1?'s':''} before deleting.`);
      return;
    }
    setKeys(ks => ks.filter(k => k.id !== key.id));
    toast.success('Key deleted', `${key.name} has been removed.`);
  };

  const algoColor = a => ({ ed25519:T.green, rsa:T.blue, ecdsa:T.cyan }[a.toLowerCase()] || T.muted);
  const algoWarn  = k => k.algo==='rsa' && k.bits && k.bits < 3072;

  return (
    <div style={{padding:'28px 30px', maxWidth:900}}>
      {showAdd && <AddKeyModal onClose={()=>setShowAdd(false)} onAdd={k=>setKeys(ks=>[...ks,{id:'sk'+Date.now(),servers:[],created_by:'sarah',created_at:Date.now(),last_used:null,fingerprint:'SHA256:new…',public_key:k.pubkey,algo:k.parsed.algo.toLowerCase(),bits:null,name:k.name}])}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>SSH Keys</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            {keys.length} workspace keys · installed on servers at provision time
          </p>
        </div>
        <button onClick={()=>setShowAdd(true)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ Add key
        </button>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Total keys"   value={keys.length}                                                    sub="in this workspace"/>
        <StatCard label="Ed25519"      value={keys.filter(k=>k.algo==='ed25519').length}                      sub="recommended" color={T.green}/>
        <StatCard label="RSA"          value={keys.filter(k=>k.algo==='rsa').length}                          sub={keys.some(algoWarn)?'⚠ weak key present':undefined} color={keys.some(algoWarn)?T.amber:T.text}/>
        <StatCard label="Unused"       value={keys.filter(k=>k.servers.length===0).length}                    sub="not on any server" color={T.muted}/>
      </div>

      {/* Weak-key warning */}
      {keys.some(algoWarn) && (
        <div style={{background:`${T.amber}10`,border:`0.5px solid ${T.amber}44`,borderRadius:8,padding:'12px 16px',marginBottom:20,display:'flex',gap:10,alignItems:'flex-start'}}>
          <span style={{color:T.amber,fontSize:16,flexShrink:0}}>⚠</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.amber,marginBottom:2}}>Weak RSA key detected</div>
            <div style={{fontSize:12,color:T.sec}}>
              <strong style={{color:T.text}}>legacy-rsa-2048</strong> uses RSA-2048, which is below the recommended minimum of 3072 bits.
              Consider replacing it with an Ed25519 key. Ed25519 is faster, more secure, and produces shorter keys.
            </div>
          </div>
        </div>
      )}

      {/* Key list */}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {keys.map(k => {
          const isExp  = expanded === k.id;
          const warn   = algoWarn(k);
          return (
            <div key={k.id} style={{background:T.card,border:`0.5px solid ${warn?T.amber+'44':isExp?T.borderMd:T.border}`,borderRadius:9,overflow:'hidden',transition:'border-color 0.15s'}}>
              {/* Main row */}
              <div style={{display:'flex',alignItems:'center',gap:14,padding:'14px 18px'}}>
                {/* Icon */}
                <div style={{width:36,height:36,borderRadius:8,background:T.elevated,border:`1px solid ${algoColor(k.algo)}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
                  🔑
                </div>

                {/* Name + fingerprint */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{k.name}</span>
                    <span style={{fontSize:11,padding:'1px 7px',borderRadius:4,background:`${algoColor(k.algo)}18`,color:algoColor(k.algo),border:`0.5px solid ${algoColor(k.algo)}44`,fontWeight:500,fontFamily:'monospace'}}>
                      {k.algo}{k.bits?`-${k.bits}`:''}
                    </span>
                    {warn && <span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:`${T.amber}18`,color:T.amber,border:`0.5px solid ${T.amber}44`}}>weak</span>}
                    {k.servers.length===0 && <span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`}}>unused</span>}
                  </div>
                  <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {k.fingerprint}
                  </div>
                </div>

                {/* Server count */}
                <div style={{flexShrink:0,textAlign:'center',minWidth:70}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Servers</div>
                  <div style={{fontSize:15,fontWeight:700,color:k.servers.length>0?T.text:T.muted}}>{k.servers.length}</div>
                </div>

                {/* Last used */}
                <div style={{flexShrink:0,textAlign:'right',minWidth:90}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Last used</div>
                  <div style={{fontSize:12,color:k.last_used?T.sec:T.muted}}>{k.last_used?fmtAge(k.last_used):'never'}</div>
                </div>

                {/* Created */}
                <div style={{flexShrink:0,textAlign:'right',minWidth:90}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Added</div>
                  <div style={{fontSize:12,color:T.muted}}>{fmtAge(k.created_at)}</div>
                </div>

                {/* Actions */}
                <div style={{display:'flex',gap:7,flexShrink:0,marginLeft:8}}>
                  <button
                    onClick={()=>copyKey(k.id, k.public_key)}
                    style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${copied===k.id?T.green+'66':T.border}`,background:copied===k.id?`${T.green}10`:'none',color:copied===k.id?T.green:T.sec,cursor:'pointer',transition:'all 0.15s',whiteSpace:'nowrap'}}>
                    {copied===k.id ? '✓ Copied' : 'Copy'}
                  </button>
                  <button
                    onClick={()=>setExpanded(isExp?null:k.id)}
                    style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${isExp?T.borderMd:T.border}`,background:isExp?T.elevated:'none',color:T.sec,cursor:'pointer',whiteSpace:'nowrap'}}>
                    {isExp?'▲ Less':'▼ More'}
                  </button>
                  <button
                    onClick={()=>deleteKey(k)}
                    style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.red}33`,background:'none',color:k.servers.length>0?T.muted:T.red,cursor:'pointer',whiteSpace:'nowrap'}}>
                    Delete
                  </button>
                </div>
              </div>

              {/* Expanded panel */}
              {isExp && (
                <div style={{borderTop:`0.5px solid ${T.border}`,padding:'16px 18px',background:T.elevated}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
                    {/* Public key block */}
                    <div>
                      <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8,fontWeight:500}}>Public key</div>
                      <div style={{background:'#090b11',borderRadius:6,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.sec,wordBreak:'break-all',lineHeight:'16px',border:`0.5px solid ${T.border}`,position:'relative'}}>
                        {k.public_key}
                        <button onClick={()=>copyKey(k.id+'-expanded', k.public_key)} style={{position:'absolute',top:6,right:6,fontSize:10,padding:'2px 7px',borderRadius:4,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>
                          {copied===k.id+'-expanded'?'✓':'Copy'}
                        </button>
                      </div>
                    </div>

                    {/* Details + servers */}
                    <div style={{display:'flex',flexDirection:'column',gap:14}}>
                      <div>
                        <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8,fontWeight:500}}>Details</div>
                        {[
                          ['Algorithm',   `${k.algo.toUpperCase()}${k.bits?`-${k.bits}`:''}`],
                          ['Fingerprint', k.fingerprint],
                          ['Added by',    k.created_by],
                          ['Created',     fmtAge(k.created_at)],
                          ['Last used',   k.last_used?fmtAge(k.last_used):'never'],
                        ].map(([label,val])=>(
                          <div key={label} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:`0.5px solid ${T.border}`}}>
                            <span style={{fontSize:11,color:T.sec}}>{label}</span>
                            <span style={{fontSize:11,color:T.text,fontFamily:label==='Fingerprint'?'monospace':'inherit',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',textAlign:'right'}}>{val}</span>
                          </div>
                        ))}
                      </div>

                      {k.servers.length > 0 && (
                        <div>
                          <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8,fontWeight:500}}>
                            Installed on ({k.servers.length})
                          </div>
                          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                            {k.servers.map(s=>(
                              <div key={s} style={{display:'flex',alignItems:'center',gap:5,padding:'3px 9px',borderRadius:4,background:T.card,border:`0.5px solid ${T.border}`}}>
                                <Dot color={T.green} size={5}/>
                                <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{s}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {keys.length === 0 && (
        <div style={{padding:'60px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,marginTop:8}}>
          <div style={{fontSize:36,marginBottom:14}}>🔑</div>
          <div style={{fontSize:15,fontWeight:500,color:T.text,marginBottom:6}}>No SSH keys yet</div>
          <div style={{fontSize:13,color:T.sec,marginBottom:20}}>Add a public key to install it on servers when you provision them.</div>
          <button onClick={()=>setShowAdd(true)} style={{padding:'9px 20px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Add first key</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE GRAPH
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Graph data ───────────────────────────────────────────────────────────────
// Nodes: servers, apps, networks, external services
// Edges: connections between them

const GRAPH_NODES = [
  // ── Internet / entry ──────────────────────────────────────────────────────
  { id:'ext-internet', kind:'external', label:'Internet',       icon:'🌐', x:460, y:40,  color:'#5a8ef8' },

  // ── Load balancer / DNS ───────────────────────────────────────────────────
  { id:'ext-dns',      kind:'external', label:'Cloudflare DNS', icon:'☁',  x:240, y:130, color:'#f5b540' },
  { id:'ext-cdn',      kind:'external', label:'CDN Edge',       icon:'⚡', x:680, y:130, color:'#f5b540' },

  // ── Gateway tier ──────────────────────────────────────────────────────────
  { id:'s7',           kind:'server',   label:'prod-gateway-01',icon:'🔀', x:460, y:230, color:'#f06b6b', status:'unreachable' },

  // ── Web tier (prod) ───────────────────────────────────────────────────────
  { id:'s1',           kind:'server',   label:'prod-web-01',    icon:'🖥', x:240, y:370, color:'#2dd4a0', status:'online' },
  { id:'s2',           kind:'server',   label:'prod-web-02',    icon:'🖥', x:680, y:370, color:'#2dd4a0', status:'online' },

  // ── Apps on web servers ───────────────────────────────────────────────────
  { id:'app-router',   kind:'app',      label:'api-gateway/router',   icon:'📦', x:120, y:490, color:'#5a8ef8', env:'production' },
  { id:'app-web',      kind:'app',      label:'dashboard/web',        icon:'📦', x:340, y:490, color:'#5a8ef8', env:'production' },
  { id:'app-router2',  kind:'app',      label:'api-gateway/router',   icon:'📦', x:560, y:490, color:'#5a8ef8', env:'production' },
  { id:'app-web2',     kind:'app',      label:'auth-service/api',     icon:'📦', x:800, y:490, color:'#9d87f5', env:'production' },

  // ── Worker / build tier ───────────────────────────────────────────────────
  { id:'s4',           kind:'server',   label:'prod-worker-01', icon:'⚙', x:240, y:640, color:'#f5b540', status:'draining' },
  { id:'s5',           kind:'server',   label:'build-runner-01',icon:'🔨',x:680, y:640, color:'#2dd4a0', status:'online'   },

  // ── Worker apps ───────────────────────────────────────────────────────────
  { id:'app-worker',   kind:'app',      label:'data-pipeline/worker', icon:'⚙', x:120, y:750, color:'#1ec8d4', env:'production' },
  { id:'app-notif',    kind:'app',      label:'notifications/worker', icon:'⚙', x:360, y:750, color:'#1ec8d4', env:'production' },

  // ── Database tier ─────────────────────────────────────────────────────────
  { id:'s3',           kind:'server',   label:'prod-db-01',     icon:'🗄', x:460, y:850, color:'#9d87f5', status:'online'   },

  // ── DB apps ───────────────────────────────────────────────────────────────
  { id:'app-pg',       kind:'app',      label:'postgres-primary',     icon:'🗄', x:340, y:960, color:'#9d87f5', env:'production' },
  { id:'app-redis',    kind:'app',      label:'redis/cache',          icon:'💾', x:580, y:960, color:'#f06b6b', env:'production' },

  // ── Staging server ────────────────────────────────────────────────────────
  { id:'s6',           kind:'server',   label:'stg-app-01',     icon:'🖥', x:1000, y:490, color:'#2dd4a0', status:'online' },
  { id:'app-stg',      kind:'app',      label:'dashboard/web (stg)',  icon:'📦', x:1000, y:600, color:'#f5b540', env:'staging' },

  // ── Private mesh network ──────────────────────────────────────────────────
  { id:'net-prod',     kind:'network',  label:'WireGuard mesh',  icon:'🕸', x:460, y:1060, color:'#636882' },
];

const GRAPH_EDGES = [
  // Internet → DNS/CDN
  { id:'e1',  src:'ext-internet', tgt:'ext-dns',      label:'HTTPS',      kind:'traffic' },
  { id:'e2',  src:'ext-internet', tgt:'ext-cdn',      label:'static',     kind:'traffic' },
  // DNS/CDN → gateway
  { id:'e3',  src:'ext-dns',      tgt:'s7',           label:'80/443',     kind:'traffic' },
  { id:'e4',  src:'ext-cdn',      tgt:'s7',           label:'cached',     kind:'traffic' },
  // Gateway → web servers (dashed = unreachable)
  { id:'e5',  src:'s7',           tgt:'s1',           label:'proxy',      kind:'unreachable' },
  { id:'e6',  src:'s7',           tgt:'s2',           label:'proxy',      kind:'unreachable' },
  // Web servers → apps
  { id:'e7',  src:'s1',           tgt:'app-router',   label:'runs',       kind:'host' },
  { id:'e8',  src:'s1',           tgt:'app-web',      label:'runs',       kind:'host' },
  { id:'e9',  src:'s2',           tgt:'app-router2',  label:'runs',       kind:'host' },
  { id:'e10', src:'s2',           tgt:'app-web2',     label:'runs',       kind:'host' },
  // Apps → DB
  { id:'e11', src:'app-router',   tgt:'s3',           label:'pg:5432',    kind:'data' },
  { id:'e12', src:'app-web',      tgt:'s3',           label:'pg:5432',    kind:'data' },
  { id:'e13', src:'app-router2',  tgt:'s3',           label:'pg:5432',    kind:'data' },
  // Apps → workers (async)
  { id:'e14', src:'app-web',      tgt:'s4',           label:'queue',      kind:'async' },
  { id:'e15', src:'app-web2',     tgt:'s4',           label:'queue',      kind:'async' },
  // Worker server → apps
  { id:'e16', src:'s4',           tgt:'app-worker',   label:'runs',       kind:'host' },
  { id:'e17', src:'s4',           tgt:'app-notif',    label:'runs',       kind:'host' },
  // Workers → DB
  { id:'e18', src:'app-worker',   tgt:'s3',           label:'pg:5432',    kind:'data' },
  // DB server → db apps
  { id:'e19', src:'s3',           tgt:'app-pg',       label:'runs',       kind:'host' },
  { id:'e20', src:'s3',           tgt:'app-redis',    label:'runs',       kind:'host' },
  // Apps → redis
  { id:'e21', src:'app-router',   tgt:'app-redis',    label:'cache',      kind:'data' },
  { id:'e22', src:'app-router2',  tgt:'app-redis',    label:'cache',      kind:'data' },
  // Staging
  { id:'e23', src:'s6',           tgt:'app-stg',      label:'runs',       kind:'host' },
  { id:'e24', src:'app-stg',      tgt:'s3',           label:'pg:5432',    kind:'data' },
  // Mesh
  { id:'e25', src:'net-prod',     tgt:'s1',           label:'peer',       kind:'network' },
  { id:'e26', src:'net-prod',     tgt:'s2',           label:'peer',       kind:'network' },
  { id:'e27', src:'net-prod',     tgt:'s3',           label:'peer',       kind:'network' },
  { id:'e28', src:'net-prod',     tgt:'s4',           label:'peer',       kind:'network' },
  { id:'e29', src:'net-prod',     tgt:'s7',           label:'peer',       kind:'network' },
  // Build
  { id:'e30', src:'s5',           tgt:'s1',           label:'deploys to', kind:'deploy' },
  { id:'e31', src:'s5',           tgt:'s2',           label:'deploys to', kind:'deploy' },
];

const EDGE_STYLES = {
  traffic:     { stroke:'#5a8ef8', dash:null,   width:1.5, arrow:true  },
  host:        { stroke:'#636882', dash:null,   width:1,   arrow:false },
  data:        { stroke:'#9d87f5', dash:'6,3',  width:1.5, arrow:true  },
  async:       { stroke:'#f5b540', dash:'4,4',  width:1,   arrow:true  },
  network:     { stroke:'#383d52', dash:'3,5',  width:1,   arrow:false },
  deploy:      { stroke:'#2dd4a0', dash:'8,3',  width:1.5, arrow:true  },
  unreachable: { stroke:'#f06b6b', dash:'4,4',  width:1,   arrow:true  },
};

const NODE_KINDS = {
  server:   { shape:'rect',   w:130, h:44 },
  app:      { shape:'rect',   w:120, h:36 },
  network:  { shape:'diamond',w:120, h:44 },
  external: { shape:'pill',   w:120, h:36 },
};

// ─── InfraGraphView ───────────────────────────────────────────────────────────

function InfraGraphView({ onOpenServer, onOpenProject }) {
  const svgRef    = useRef(null);
  const [nodes, setNodes]         = useState(() => GRAPH_NODES.map(n => ({...n})));
  const [selected, setSelected]   = useState(null);
  const [hovered, setHovered]     = useState(null);
  const [pan, setPan]             = useState({ x: 0, y: -20 });
  const [zoom, setZoom]           = useState(0.72);
  const [filter, setFilter]       = useState('all'); // all | servers | apps | networks
  const [dragging, setDragging]   = useState(null);  // { nodeId, ox, oy }
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef(null);

  const selectedNode = nodes.find(n => n.id === selected);

  // ── Zoom with wheel ──────────────────────────────────────────────────────
  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    setZoom(z => Math.max(0.25, Math.min(2, z * factor)));
  };

  // ── Pan with middle-button or space+drag ─────────────────────────────────
  const onSvgMouseDown = (e) => {
    if (e.button === 1 || e.altKey) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
    }
  };
  const onMouseMove = (e) => {
    if (isPanning && panStart.current) {
      setPan({ x: panStart.current.px + e.clientX - panStart.current.mx, y: panStart.current.py + e.clientY - panStart.current.my });
      return;
    }
    if (dragging) {
      const svg   = svgRef.current;
      const rect  = svg.getBoundingClientRect();
      const svgX  = (e.clientX - rect.left - pan.x) / zoom;
      const svgY  = (e.clientY - rect.top  - pan.y) / zoom;
      setNodes(ns => ns.map(n => n.id === dragging.nodeId ? { ...n, x: svgX - dragging.ox, y: svgY - dragging.oy } : n));
    }
  };
  const onMouseUp = () => { setIsPanning(false); setDragging(null); panStart.current = null; };

  const startDrag = (e, node) => {
    e.stopPropagation();
    if (e.button !== 0 || e.altKey) return;
    const svg  = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const svgX = (e.clientX - rect.left - pan.x) / zoom;
    const svgY = (e.clientY - rect.top  - pan.y) / zoom;
    setDragging({ nodeId: node.id, ox: svgX - node.x, oy: svgY - node.y });
    setSelected(node.id);
  };

  // ── Filter ───────────────────────────────────────────────────────────────
  const visibleNodes = filter === 'all' ? nodes
    : nodes.filter(n => n.kind === filter || (filter === 'servers' && n.kind === 'external'));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = GRAPH_EDGES.filter(e => visibleIds.has(e.src) && visibleIds.has(e.tgt));

  // ── Edge path (straight with slight curve) ───────────────────────────────
  const edgePath = (src, tgt) => {
    const sn = nodes.find(n => n.id === src);
    const tn = nodes.find(n => n.id === tgt);
    if (!sn || !tn) return '';
    const sk = NODE_KINDS[sn.kind] || NODE_KINDS.server;
    const tk = NODE_KINDS[tn.kind] || NODE_KINDS.server;
    const x1 = sn.x + sk.w / 2, y1 = sn.y + sk.h / 2;
    const x2 = tn.x + tk.w / 2, y2 = tn.y + tk.h / 2;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    // small quadratic bend
    const dx = -(y2 - y1) * 0.08, dy = (x2 - x1) * 0.08;
    return `M ${x1} ${y1} Q ${cx + dx} ${cy + dy} ${x2} ${y2}`;
  };

  // ── Node render ──────────────────────────────────────────────────────────
  const renderNode = (node) => {
    const k    = NODE_KINDS[node.kind] || NODE_KINDS.server;
    const isSel = selected === node.id;
    const isHov = hovered === node.id;
    const c    = node.color;

    const glow = isSel
      ? `drop-shadow(0 0 8px ${c}88)`
      : isHov ? `drop-shadow(0 0 4px ${c}55)` : 'none';

    let shape;
    if (k.shape === 'pill') {
      shape = <rect x={0} y={0} width={k.w} height={k.h} rx={k.h/2} fill={`${c}18`} stroke={isSel?c:`${c}66`} strokeWidth={isSel?1.5:0.8}/>;
    } else if (k.shape === 'diamond') {
      const cx = k.w/2, cy = k.h/2;
      shape = <polygon points={`${cx},2 ${k.w-2},${cy} ${cx},${k.h-2} 2,${cy}`} fill={`${c}18`} stroke={isSel?c:`${c}66`} strokeWidth={isSel?1.5:0.8}/>;
    } else {
      shape = <rect x={0} y={0} width={k.w} height={k.h} rx={6} fill={`${c}15`} stroke={isSel?c:`${c}55`} strokeWidth={isSel?1.5:0.8}/>;
    }

    const hasStatus = node.status;
    const statusC   = { online:T.green, offline:T.red, draining:T.amber, unreachable:T.red }[node.status] || T.muted;

    return (
      <g
        key={node.id}
        transform={`translate(${node.x}, ${node.y})`}
        style={{ cursor: 'pointer', filter: glow, transition: 'filter 0.12s' }}
        onMouseDown={e => startDrag(e, node)}
        onMouseEnter={() => setHovered(node.id)}
        onMouseLeave={() => setHovered(null)}
        onClick={e => { e.stopPropagation(); setSelected(isSel ? null : node.id); }}
      >
        {shape}
        {/* Icon */}
        <text x={10} y={k.h/2 + 4} fontSize={13} style={{userSelect:'none'}}>{node.icon}</text>
        {/* Label */}
        <text x={27} y={k.h/2 - 3} fontSize={9} fontWeight={500} fill={c} style={{userSelect:'none'}}>
          {node.label.length > 14 ? node.label.slice(0,13)+'…' : node.label}
        </text>
        {node.kind !== 'external' && node.kind !== 'network' && (
          <text x={27} y={k.h/2 + 8} fontSize={8} fill={`${c}99`} style={{userSelect:'none'}}>
            {node.kind === 'app' ? (node.env||'prod') : node.kind}
          </text>
        )}
        {/* Status dot */}
        {hasStatus && (
          <circle cx={k.w - 8} cy={8} r={4} fill={statusC} stroke={T.bg} strokeWidth={1.5}/>
        )}
      </g>
    );
  };

  // ── Tier labels ──────────────────────────────────────────────────────────
  const tiers = [
    { y: 10,   label: 'Internet' },
    { y: 100,  label: 'Edge / DNS' },
    { y: 200,  label: 'Gateway' },
    { y: 340,  label: 'Web tier' },
    { y: 460,  label: 'Application layer' },
    { y: 610,  label: 'Workers / CI' },
    { y: 720,  label: 'Worker processes' },
    { y: 820,  label: 'Database tier' },
    { y: 930,  label: 'Data services' },
    { y: 1030, label: 'Mesh network' },
  ];

  // ── Legend ────────────────────────────────────────────────────────────────
  const legendItems = [
    { label:'Traffic',     style: EDGE_STYLES.traffic     },
    { label:'Host',        style: EDGE_STYLES.host        },
    { label:'Data',        style: EDGE_STYLES.data        },
    { label:'Async',       style: EDGE_STYLES.async       },
    { label:'Deploy',      style: EDGE_STYLES.deploy      },
    { label:'Unreachable', style: EDGE_STYLES.unreachable },
    { label:'Network peer',style: EDGE_STYLES.network     },
  ];

  // ── Detail panel for selected node ───────────────────────────────────────
  const renderDetail = () => {
    if (!selectedNode) return null;
    const server = SERVERS.find(s => s.id === selectedNode.id);
    const isServer = selectedNode.kind === 'server' && server;
    const connectedEdges = GRAPH_EDGES.filter(e => e.src === selectedNode.id || e.tgt === selectedNode.id);

    return (
      <div style={{position:'absolute',top:60,right:0,width:240,background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:10,padding:'14px 16px',boxShadow:'0 8px 32px rgba(0,0,0,0.4)',zIndex:10,pointerEvents:'all'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:18}}>{selectedNode.icon}</span>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:T.text,lineHeight:'16px'}}>{selectedNode.label}</div>
              <div style={{fontSize:10,color:T.muted,marginTop:1,textTransform:'uppercase',letterSpacing:'0.07em'}}>{selectedNode.kind}</div>
            </div>
          </div>
          <button onClick={()=>setSelected(null)} style={{background:'none',border:'none',cursor:'pointer',color:T.muted,fontSize:16,lineHeight:1,padding:'0 2px'}}>✕</button>
        </div>

        {selectedNode.status && (
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
            <Dot color={{online:T.green,draining:T.amber,unreachable:T.red,stopped:T.muted}[selectedNode.status]||T.muted} size={7}/>
            <span style={{fontSize:12,color:T.sec}}>{selectedNode.status}</span>
          </div>
        )}

        {isServer && (
          <div style={{marginBottom:10}}>
            <div style={{marginBottom:6}}><Bar value={server.cpu} label="CPU"/></div>
            <div><Bar value={server.mem} label="MEM"/></div>
            <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',marginTop:6}}>{server.ip} · {server.region}</div>
          </div>
        )}

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:5}}>Connections ({connectedEdges.length})</div>
          {connectedEdges.slice(0,5).map(e => {
            const other = nodes.find(n => n.id === (e.src === selectedNode.id ? e.tgt : e.src));
            const dir   = e.src === selectedNode.id ? '→' : '←';
            const es    = EDGE_STYLES[e.kind];
            return (
              <div key={e.id} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 0',borderBottom:`0.5px solid ${T.border}`}}>
                <svg width={24} height={4} style={{flexShrink:0}}>
                  <line x1={0} y1={2} x2={24} y2={2} stroke={es.stroke} strokeWidth={es.width} strokeDasharray={es.dash||undefined}/>
                </svg>
                <span style={{fontSize:11,color:T.muted}}>{dir}</span>
                <span style={{fontSize:11,color:T.sec,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{other?.label||e.tgt}</span>
                <span style={{fontSize:10,color:T.muted,marginLeft:'auto'}}>{e.label}</span>
              </div>
            );
          })}
          {connectedEdges.length > 5 && <div style={{fontSize:10,color:T.muted,marginTop:4}}>+{connectedEdges.length-5} more</div>}
        </div>

        {isServer && (
          <button
            onClick={() => onOpenServer && onOpenServer(server)}
            style={{width:'100%',padding:'7px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>
            Open server →
          </button>
        )}
        {selectedNode.kind === 'app' && (
          <button
            onClick={() => onOpenProject && onOpenProject(selectedNode)}
            style={{width:'100%',padding:'7px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>
            Open app →
          </button>
        )}
      </div>
    );
  };

  const CANVAS_W = 1160, CANVAS_H = 1120;

  return (
    <div style={{position:'relative',height:'100%',display:'flex',flexDirection:'column',background:T.bg,overflow:'hidden'}}>

      {/* Toolbar */}
      <div style={{display:'flex',alignItems:'center',gap:12,padding:'12px 20px',borderBottom:`0.5px solid ${T.border}`,background:T.sidebar,flexShrink:0,zIndex:5}}>
        <div>
          <span style={{fontSize:15,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Infrastructure Graph</span>
          <span style={{fontSize:12,color:T.sec,marginLeft:10}}>{visibleNodes.length} nodes · {visibleEdges.length} edges</span>
        </div>

        {/* Filter tabs */}
        <div style={{display:'flex',gap:3,marginLeft:20,background:T.elevated,borderRadius:7,padding:3}}>
          {['all','server','app','network'].map(f=>(
            <button key={f} onClick={()=>setFilter(f)} style={{padding:'4px 12px',borderRadius:5,border:'none',cursor:'pointer',fontSize:11,fontWeight:filter===f?500:400,background:filter===f?T.card:'transparent',color:filter===f?T.text:T.sec,textTransform:'capitalize'}}>
              {f==='all'?'All':f+'s'}
            </button>
          ))}
        </div>

        <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center'}}>
          {/* Zoom controls */}
          <button onClick={()=>setZoom(z=>Math.min(2,z*1.2))} style={{width:28,height:28,borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer',fontSize:16,display:'flex',alignItems:'center',justifyContent:'center'}}>+</button>
          <span style={{fontSize:11,color:T.muted,fontFamily:'monospace',minWidth:36,textAlign:'center'}}>{Math.round(zoom*100)}%</span>
          <button onClick={()=>setZoom(z=>Math.max(0.25,z/1.2))} style={{width:28,height:28,borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer',fontSize:16,display:'flex',alignItems:'center',justifyContent:'center'}}>−</button>
          <button onClick={()=>{ setZoom(0.72); setPan({x:0,y:-20}); }} style={{padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer',fontSize:11}}>Reset</button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{flex:1,position:'relative',overflow:'hidden'}}>
        <svg
          ref={svgRef}
          width="100%" height="100%"
          style={{cursor: isPanning?'grabbing':dragging?'grabbing':'grab', userSelect:'none'}}
          onWheel={onWheel}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={()=>setSelected(null)}
        >
          <defs>
            <marker id="arrow-traffic"     markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill={EDGE_STYLES.traffic.stroke}/></marker>
            <marker id="arrow-data"        markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill={EDGE_STYLES.data.stroke}/></marker>
            <marker id="arrow-async"       markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill={EDGE_STYLES.async.stroke}/></marker>
            <marker id="arrow-deploy"      markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill={EDGE_STYLES.deploy.stroke}/></marker>
            <marker id="arrow-unreachable" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill={EDGE_STYLES.unreachable.stroke}/></marker>
            {/* Dot grid background */}
            <pattern id="dotgrid" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.8" fill="#1f2433"/>
            </pattern>
          </defs>

          {/* Background dot grid */}
          <rect width="100%" height="100%" fill="url(#dotgrid)"/>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Tier band labels */}
            {filter === 'all' && tiers.map(tier => (
              <text key={tier.y} x={-10} y={tier.y + 14} fontSize={9} fill={T.muted} textAnchor="end" style={{userSelect:'none'}}>
                {tier.label}
              </text>
            ))}
            {/* Tier band lines */}
            {filter === 'all' && tiers.map(tier => (
              <line key={'tl'+tier.y} x1={0} y1={tier.y} x2={CANVAS_W} y2={tier.y} stroke={T.border} strokeWidth={0.5} strokeDasharray="3,6"/>
            ))}

            {/* Edges */}
            {visibleEdges.map(edge => {
              const es  = EDGE_STYLES[edge.kind] || EDGE_STYLES.host;
              const isHovEdge = hovered === edge.src || hovered === edge.tgt || selected === edge.src || selected === edge.tgt;
              const p   = edgePath(edge.src, edge.tgt);
              if (!p) return null;
              return (
                <path
                  key={edge.id}
                  d={p}
                  fill="none"
                  stroke={es.stroke}
                  strokeWidth={isHovEdge ? es.width * 2 : es.width}
                  strokeDasharray={es.dash || undefined}
                  strokeOpacity={isHovEdge ? 1 : 0.45}
                  markerEnd={es.arrow ? `url(#arrow-${edge.kind})` : undefined}
                  style={{transition:'stroke-opacity 0.15s,stroke-width 0.15s'}}
                />
              );
            })}

            {/* Nodes */}
            {visibleNodes.map(renderNode)}
          </g>
        </svg>

        {/* Legend */}
        <div style={{position:'absolute',bottom:16,left:16,background:`${T.card}ee`,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'10px 14px',zIndex:5,pointerEvents:'none'}}>
          <div style={{fontSize:9,color:T.muted,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:7}}>Edge types</div>
          <div style={{display:'flex',flexDirection:'column',gap:5}}>
            {legendItems.map(li=>(
              <div key={li.label} style={{display:'flex',alignItems:'center',gap:8}}>
                <svg width={32} height={4}><line x1={0} y1={2} x2={32} y2={2} stroke={li.style.stroke} strokeWidth={li.style.width*1.5} strokeDasharray={li.style.dash||undefined}/></svg>
                <span style={{fontSize:10,color:T.sec,whiteSpace:'nowrap'}}>{li.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Hint */}
        <div style={{position:'absolute',bottom:16,right:selected?260:16,background:`${T.card}cc`,border:`0.5px solid ${T.border}`,borderRadius:6,padding:'6px 12px',pointerEvents:'none',zIndex:5}}>
          <div style={{fontSize:10,color:T.muted}}>
            Scroll to zoom · Alt+drag to pan · Drag nodes to reposition · Click to inspect
          </div>
        </div>

        {/* Detail panel */}
        <div style={{position:'absolute',top:0,right:0,bottom:0,width:256,pointerEvents:'none',padding:'8px 8px 8px 0'}}>
          {renderDetail()}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTAL — INTERNAL SERVICE HEALTH DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

const PORTAL_SERVICES = [
  {
    id:'valkey',      name:'Valkey',          group:'Cache / Queue',
    icon:'💾',        adapter:'Valkey 7.2',    url:'redis://valkey:6379',
    status:'healthy', configured:true,
    env:'VALKEY_URL', envSet:true,
    metrics:{ latency_ms:0.4, ops_sec:2840, memory_mb:128, memory_max_mb:512, hit_rate:94, conn:7 },
    sparkline:[0.3,0.4,0.4,0.5,0.4,0.3,0.4,0.4,0.5,0.4,0.3,0.4],
    desc:'Primary in-memory cache. Used by api-gateway for session data and rate-limit counters.',
    events:[
      {ts:'12:38',level:'info', msg:'FLUSHDB completed — test run cache cleared'},
      {ts:'09:12',level:'info', msg:'Maxmemory policy: allkeys-lru'},
      {ts:'2d ago',level:'warn',msg:'Memory usage reached 72% of limit'},
    ],
  },
  {
    id:'faktory',     name:'Faktory',          group:'Job Queue',
    icon:'⚡',        adapter:'Faktory 1.6',   url:'tcp://:password@faktory:7419',
    status:'stub',    configured:false,
    env:'FAKTORY_URL', envSet:false,
    metrics:{ enqueued:16, retries:2, scheduled:4, dead:1, processed_today:4821, failed_today:3 },
    sparkline:[4,6,8,5,4,7,9,6,5,4,3,2],
    desc:'Background job processing. Currently running as a stub — jobs are logged and dropped. Set FAKTORY_URL to activate.',
    events:[
      {ts:'12:41',level:'warn', msg:'Stub mode: job enqueue no-op — notifications/send_digest'},
      {ts:'12:40',level:'warn', msg:'Stub mode: job enqueue no-op — jobs/index-sync'},
      {ts:'12:39',level:'warn', msg:'Stub mode: job enqueue no-op — deployments/cleanup'},
    ],
  },
  {
    id:'typesense',   name:'Typesense',         group:'Search',
    icon:'🔍',        adapter:'Typesense 26',   url:'http://typesense:8108',
    status:'healthy', configured:true,
    env:'TYPESENSE_URL', envSet:true,
    metrics:{ latency_ms:3.2, docs:18420, collections:4, queries_sec:12, memory_mb:84 },
    sparkline:[3,4,3,5,4,3,3,4,2,3,3,4],
    desc:'Full-text search for projects, deployments, servers, and audit log. 4 collections indexed.',
    events:[
      {ts:'12:41',level:'info', msg:'Index: server "prod-web-02" updated'},
      {ts:'12:38',level:'info', msg:'Collection reindex: deployments (18,241 docs)'},
      {ts:'11:20',level:'info', msg:'Collection reindex: servers (8 docs)'},
    ],
  },
  {
    id:'infisical',   name:'Infisical',          group:'Secrets',
    icon:'🔐',        adapter:'Infisical Cloud',  url:'http://infisical:8080',
    status:'healthy', configured:true,
    env:'INFISICAL_URL', envSet:true,
    metrics:{ secrets:47, last_rotation:'2d ago', fetch_ms:18, cache_hit:true },
    sparkline:[18,20,17,19,18,21,18,17,19,18,17,18],
    desc:'Encrypted secret store. 47 secrets across 3 environments. Rotation via Infisical dynamic secrets.',
    events:[
      {ts:'10:22',level:'info', msg:'Secret rotated: DATABASE_URL (auto-rotation)'},
      {ts:'9:15', level:'info', msg:'Adapter configured by sarah'},
      {ts:'3d ago',level:'info',msg:'Secret added: RESEND_API_KEY'},
    ],
  },
  {
    id:'unleash',     name:'Unleash',             group:'Feature Flags',
    icon:'🚩',        adapter:'Unleash OSS 5',    url:'http://unleash:4242',
    status:'healthy', configured:true,
    env:'UNLEASH_URL', envSet:true,
    metrics:{ flags:8, enabled:5, toggles_today:12, sdk_clients:3 },
    sparkline:[2,3,4,2,3,4,3,2,3,4,2,3],
    desc:'Runtime feature flag evaluation. 8 flags, 3 SDK clients polling every 15s.',
    events:[
      {ts:'12:40',level:'info', msg:'Flag toggled: feature.dag_workflows → disabled'},
      {ts:'11:54',level:'info', msg:'SDK client connected: hub-agent@prod-web-01'},
      {ts:'8:30', level:'info', msg:'Flag created: feature.multi_provider_deploy'},
    ],
  },
  {
    id:'forgejo',     name:'Forgejo',             group:'Git',
    icon:'🗂',        adapter:'Forgejo 7.0',       url:'http://forgejo:3000',
    status:'healthy', configured:true,
    env:'FORGEJO_URL', envSet:true,
    metrics:{ repos:14, webhooks:9, push_today:7, open_prs:3 },
    sparkline:[1,2,1,3,2,1,2,1,0,1,2,1],
    desc:'Internal git hosting for project source repositories. Webhooks trigger Hub deployments on push.',
    events:[
      {ts:'14m ago',level:'info', msg:'Push: dashboard/main → v2.14.2-rc (b7d8e02)'},
      {ts:'2h ago', level:'info', msg:'Push: api-gateway/main → v1.9.0 (c4a1d55)'},
      {ts:'1d ago', level:'info', msg:'PR merged: data-pipeline/fix-secret-mount'},
    ],
  },
  {
    id:'grafana',     name:'Grafana',             group:'Observability',
    icon:'📡',        adapter:'Grafana 10 + Loki', url:'http://grafana:3000',
    status:'healthy', configured:true,
    env:'GRAFANA_URL', envSet:true,
    metrics:{ dashboards:6, datasources:3, active_alerts:2, loki_ingestion_kb_s:18 },
    sparkline:[15,18,22,19,17,21,18,16,19,20,18,18],
    desc:'Metrics (Prometheus), logs (Loki), and dashboards. 2 active alert rules firing.',
    events:[
      {ts:'4m ago', level:'warn', msg:'Alert: prod-db-01 memory > 85% (3rd consecutive)'},
      {ts:'12m ago',level:'warn', msg:'Alert: prod-gateway-01 unreachable'},
      {ts:'1h ago', level:'info', msg:'Dashboard updated: Server Fleet Overview'},
    ],
  },
  {
    id:'netbird',     name:'NetBird',             group:'Networking',
    icon:'🕸',        adapter:'NetBird Cloud',    url:'https://netbird.example.com',
    status:'stub',    configured:false,
    env:'NETBIRD_URL', envSet:false,
    metrics:{ peers:0, policies:0, setup_keys:0 },
    sparkline:[0,0,0,0,0,0,0,0,0,0,0,0],
    desc:'WireGuard mesh networking. Currently stub — peer registration is no-op. Set NETBIRD_URL to activate.',
    events:[
      {ts:'12:25',level:'warn', msg:'Stub mode: createPeer no-op — prod-web-01'},
      {ts:'12:24',level:'warn', msg:'Stub mode: createPeer no-op — prod-db-01'},
    ],
  },
  {
    id:'zot',         name:'Zot Registry',        group:'Container Registry',
    icon:'📦',        adapter:'Zot OCI 2.1',      url:'http://zot:5080',
    status:'stub',    configured:false,
    env:'ZOT_URL', envSet:false,
    metrics:{ repos:0, tags:0, size_gb:0 },
    sparkline:[0,0,0,0,0,0,0,0,0,0,0,0],
    desc:'OCI-compliant container image registry. Stub — image pushes are no-op. Set ZOT_URL to activate.',
    events:[
      {ts:'12:41',level:'warn', msg:'Stub mode: imageExists returns false — dashboard:v2.14.1'},
    ],
  },
  {
    id:'nango',       name:'Nango',               group:'Integrations',
    icon:'🔗',        adapter:'Nango Cloud',       url:'http://nango:3003',
    status:'stub',    configured:false,
    env:'NANGO_URL', envSet:false,
    metrics:{ connections:0, providers:0 },
    sparkline:[0,0,0,0,0,0,0,0,0,0,0,0],
    desc:'OAuth connection manager for third-party service integrations. Stub — all requests fail gracefully.',
    events:[
      {ts:'12:30',level:'warn', msg:'Stub mode: getToken no-op — provider github'},
    ],
  },
];

const PORTAL_INCIDENTS = [
  { id:'i1', service:'Grafana',  severity:'warning',  msg:'Alert: prod-gateway-01 unreachable (4m)',      ts:'4m ago',  resolved:false },
  { id:'i2', service:'Grafana',  severity:'warning',  msg:'Alert: prod-db-01 memory at 88% threshold',   ts:'12m ago', resolved:false },
  { id:'i3', service:'Faktory',  severity:'info',     msg:'Stub mode: 3 job enqueues dropped',           ts:'2m ago',  resolved:false },
  { id:'i4', service:'NetBird',  severity:'info',     msg:'Stub mode: mesh not configured',              ts:'—',       resolved:false },
  { id:'i5', service:'Valkey',   severity:'resolved', msg:'Memory spike to 72% — resolved after flush',  ts:'2d ago',  resolved:true  },
];

// ─── Sparkline SVG ────────────────────────────────────────────────────────────
function Sparkline({ data, color=T.blue, width=80, height=24 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 0.001);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x},${y}`;
  }).join(' ');
  const area = `M 0,${height} L ${pts.split(' ').map((p,i)=>i===0?`${p}`:`${p}`).join(' L ')} L ${width},${height} Z`;
  return (
    <svg width={width} height={height} style={{display:'block'}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
      <path d={`M 0,${height} L ${pts} L ${width},${height} Z`} fill={color} fillOpacity={0.08}/>
    </svg>
  );
}

// ─── PortalView ───────────────────────────────────────────────────────────────
function PortalView() {
  const toast = useToast();
  const [selected, setSelected] = useState(null);
  const [tick, setTick]         = useState(0);

  // Simulate live metric jitter every 3s
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 3000);
    return () => clearInterval(t);
  }, []);

  const jitter = (base, range) => Math.round((base + (Math.random() - 0.5) * range) * 10) / 10;

  const healthy  = PORTAL_SERVICES.filter(s => s.status === 'healthy').length;
  const stub     = PORTAL_SERVICES.filter(s => s.status === 'stub').length;
  const degraded = PORTAL_SERVICES.filter(s => s.status === 'degraded').length;
  const incidents = PORTAL_INCIDENTS.filter(i => !i.resolved);

  const statusColor  = s => ({ healthy:T.green, stub:T.muted, degraded:T.amber, error:T.red }[s] || T.muted);
  const statusLabel  = s => ({ healthy:'healthy', stub:'stub mode', degraded:'degraded', error:'error' }[s] || s);
  const sevColor     = s => ({ warning:T.amber, info:T.blue, error:T.red, resolved:T.muted }[s] || T.muted);
  const groupColors  = {
    'Cache / Queue':T.cyan, 'Job Queue':T.amber, 'Search':T.blue,
    'Secrets':T.purple, 'Feature Flags':T.green, 'Git':T.orange,
    'Observability':T.blue, 'Networking':T.sec, 'Container Registry':T.blue, 'Integrations':T.cyan,
  };

  const selectedSvc = PORTAL_SERVICES.find(s => s.id === selected);

  const pingService = (svc) => {
    if (!svc.configured) {
      toast.warning('Service not configured', `Set ${svc.env} to activate ${svc.name}.`);
      return;
    }
    const t = toast.loading('Pinging…', svc.url);
    setTimeout(() => t.update('success', `${svc.name} reachable`, `${jitter(svc.metrics.latency_ms||18, 5)}ms response time`), 900);
  };

  return (
    <div style={{padding:'28px 30px', maxWidth:1100}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Portal</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            Internal infrastructure services · {healthy} healthy · {stub} stub · {incidents.length} active incidents
          </p>
        </div>
        <button
          onClick={()=>toast.info('Refreshing…','Checking all service endpoints.')}
          style={{display:'flex',alignItems:'center',gap:7,padding:'8px 15px',borderRadius:7,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,fontSize:12,cursor:'pointer'}}>
          ↻ Refresh all
        </button>
      </div>

      {/* Summary strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Services"     value={PORTAL_SERVICES.length} sub="total registered"/>
        <StatCard label="Healthy"      value={healthy}   sub="fully operational"  color={T.green}/>
        <StatCard label="Stub mode"    value={stub}      sub="no-op, not wired"   color={T.muted}/>
        <StatCard label="Incidents"    value={incidents.length} sub="needs attention" color={incidents.length>0?T.amber:T.text}/>
        <StatCard label="DB size"      value={SYS_HEALTH.dbSize} sub="SQLite on disk"/>
      </div>

      {/* Incident feed */}
      {incidents.length > 0 && (
        <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:8,padding:'12px 16px',marginBottom:20}}>
          <div style={{fontSize:11,color:T.amber,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>Active incidents</div>
          <div style={{display:'flex',flexDirection:'column',gap:0}}>
            {incidents.map((inc,i)=>(
              <div key={inc.id} style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0',borderBottom:i<incidents.length-1?`0.5px solid ${T.border}`:'none'}}>
                <Dot color={sevColor(inc.severity)} size={6}/>
                <span style={{fontSize:12,fontWeight:500,color:T.text}}>{inc.service}</span>
                <span style={{fontSize:12,color:T.sec,flex:1}}>{inc.msg}</span>
                <span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{inc.ts}</span>
                <button onClick={()=>toast.success('Incident acknowledged',inc.msg)} style={{fontSize:10,padding:'2px 8px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Ack</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Service grid */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(310px,1fr))',gap:12}}>
        {PORTAL_SERVICES.map(svc => {
          const isSel = selected === svc.id;
          const sc    = statusColor(svc.status);
          const gc    = groupColors[svc.group] || T.blue;

          // Live-jittered metrics
          const liveLatency = svc.metrics.latency_ms
            ? jitter(svc.metrics.latency_ms, svc.metrics.latency_ms * 0.3)
            : null;

          return (
            <div
              key={svc.id}
              onClick={()=>setSelected(isSel ? null : svc.id)}
              style={{
                background:T.card,
                border:`0.5px solid ${isSel ? T.borderMd : T.border}`,
                borderTop:`2px solid ${svc.configured ? sc : T.muted}`,
                borderRadius:9,
                cursor:'pointer',
                transition:'border-color 0.12s',
                overflow:'hidden',
              }}
              onMouseEnter={e=>!isSel&&(e.currentTarget.style.borderColor=T.borderMd)}
              onMouseLeave={e=>!isSel&&(e.currentTarget.style.borderColor=T.border)}
            >
              {/* Card header */}
              <div style={{display:'flex',alignItems:'flex-start',gap:12,padding:'14px 16px 10px'}}>
                <div style={{width:36,height:36,borderRadius:8,background:`${gc}15`,border:`1px solid ${gc}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
                  {svc.icon}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:2}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{svc.name}</span>
                    <Pill label={statusLabel(svc.status)} color={sc}/>
                  </div>
                  <div style={{fontSize:11,color:T.muted}}>{svc.adapter}</div>
                </div>
                {/* Sparkline */}
                <div style={{flexShrink:0}}>
                  <Sparkline data={svc.sparkline} color={svc.configured?sc:T.muted} width={60} height={20}/>
                </div>
              </div>

              {/* Key metrics */}
              <div style={{display:'flex',gap:0,padding:'0 16px 12px',borderBottom:`0.5px solid ${T.border}`}}>
                {svc.configured ? (
                  <>
                    {liveLatency !== null && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px 0 0',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Latency</div>
                        <div style={{fontSize:15,fontWeight:700,color:liveLatency<5?T.green:liveLatency<50?T.amber:T.red,fontFamily:'monospace'}}>{liveLatency}<span style={{fontSize:9,color:T.muted}}> ms</span></div>
                      </div>
                    )}
                    {svc.metrics.ops_sec !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Ops/s</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{Math.round(jitter(svc.metrics.ops_sec, 200))}</div>
                      </div>
                    )}
                    {svc.metrics.enqueued !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Enqueued</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{svc.metrics.enqueued}</div>
                      </div>
                    )}
                    {svc.metrics.docs !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Docs</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{(svc.metrics.docs/1000).toFixed(1)}k</div>
                      </div>
                    )}
                    {svc.metrics.secrets !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Secrets</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{svc.metrics.secrets}</div>
                      </div>
                    )}
                    {svc.metrics.flags !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Flags</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{svc.metrics.flags}</div>
                      </div>
                    )}
                    {svc.metrics.repos !== undefined && svc.id==='forgejo' && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Repos</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{svc.metrics.repos}</div>
                      </div>
                    )}
                    {svc.metrics.dashboards !== undefined && (
                      <div style={{flex:1,textAlign:'center',padding:'0 8px',borderRight:`0.5px solid ${T.border}`}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Dashboards</div>
                        <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{svc.metrics.dashboards}</div>
                      </div>
                    )}
                    {/* Memory bar for Valkey */}
                    {svc.metrics.memory_mb !== undefined && (
                      <div style={{flex:2,padding:'0 0 0 12px'}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:4}}>Memory</div>
                        <div style={{height:4,background:T.elevated,borderRadius:2}}>
                          <div style={{height:'100%',width:`${(svc.metrics.memory_mb/svc.metrics.memory_max_mb)*100}%`,background:T.cyan,borderRadius:2}}/>
                        </div>
                        <div style={{fontSize:10,color:T.muted,marginTop:3}}>{svc.metrics.memory_mb} / {svc.metrics.memory_max_mb} MB</div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{flex:1,padding:'4px 0',fontSize:12,color:T.muted,display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontSize:14}}>⚠</span>
                    <span>Set <code style={{fontFamily:'monospace',fontSize:11,color:T.amber}}>{svc.env}</code> to activate</span>
                  </div>
                )}
              </div>

              {/* Expanded detail */}
              {isSel && (
                <div style={{padding:'14px 16px',background:T.elevated}}>
                  <div style={{fontSize:12,color:T.sec,lineHeight:'18px',marginBottom:12}}>{svc.desc}</div>

                  {/* URL */}
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'7px 10px',background:T.card,borderRadius:5,border:`0.5px solid ${T.border}`}}>
                    <span style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',flexShrink:0}}>Endpoint</span>
                    <span style={{fontSize:11,fontFamily:'monospace',color:svc.configured?T.sec:T.muted,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{svc.url}</span>
                    {svc.configured && (
                      <a href={svc.url.startsWith('http')?svc.url:'#'} style={{fontSize:10,color:T.blue,textDecoration:'none',flexShrink:0}}>Open ↗</a>
                    )}
                  </div>

                  {/* Recent events */}
                  <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:6}}>Recent events</div>
                  <div style={{display:'flex',flexDirection:'column',gap:0,marginBottom:12}}>
                    {svc.events.map((ev,i)=>(
                      <div key={i} style={{display:'flex',gap:8,padding:'5px 0',borderBottom:i<svc.events.length-1?`0.5px solid ${T.border}`:'none'}}>
                        <span style={{fontSize:10,color:T.muted,fontFamily:'monospace',flexShrink:0,minWidth:48}}>{ev.ts}</span>
                        <span style={{fontSize:10,color:{info:T.sec,warn:T.amber,error:T.red}[ev.level]||T.sec,flexShrink:0,width:30}}>{ev.level}</span>
                        <span style={{fontSize:11,color:T.sec}}>{ev.msg}</span>
                      </div>
                    ))}
                  </div>

                  {/* Actions */}
                  <div style={{display:'flex',gap:8}}>
                    <button
                      onClick={e=>{e.stopPropagation();pingService(svc);}}
                      style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>
                      ↻ Ping
                    </button>
                    {!svc.configured && (
                      <button
                        onClick={e=>{e.stopPropagation();toast.info('Configure adapter',`Add ${svc.env}="..." to your environment, then restart Hub.`);}}
                        style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.blue}44`,background:`${T.blue}11`,color:T.blue,cursor:'pointer'}}>
                        How to configure →
                      </button>
                    )}
                    {svc.configured && svc.url.startsWith('http') && (
                      <button
                        onClick={e=>{e.stopPropagation();toast.info('Opening UI',`Redirecting to ${svc.name} dashboard.`);}}
                        style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>
                        Open {svc.name} UI ↗
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Footer */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 16px',borderTop:`0.5px solid ${T.border}`}}>
                <span style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em'}}>{svc.group}</span>
                <span style={{fontSize:10,color:isSel?T.blue:T.muted}}>{isSel?'▲ collapse':'▼ details'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hub internals */}
      <div style={{marginTop:24}}>
        <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>Hub internals</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
          {[
            {l:'Event bus',    v:SYS_HEALTH.eventBusSubscribers+' subscribers', sub:'in-process, not Redis',  c:T.green},
            {l:'Conduit',      v:SYS_HEALTH.conduitTargets+' targets',          sub:'agents + providers',     c:T.green},
            {l:'WebSocket',    v:SYS_HEALTH.wsConnections+' clients',           sub:'live connections',        c:T.green},
            {l:'Queue depths', v:Object.values(SYS_HEALTH.queueDepths).reduce((a,b)=>a+b,0)+' pending',
              sub:Object.entries(SYS_HEALTH.queueDepths).map(([k,v])=>`${k}:${v}`).join(' · '), c:T.text},
          ].map(item=>(
            <div key={item.l} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'12px 16px'}}>
              <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:6}}>{item.l}</div>
              <div style={{fontSize:15,fontWeight:700,color:item.c,marginBottom:3}}>{item.v}</div>
              <div style={{fontSize:10,color:T.muted}}>{item.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION CHANNELS + ALERT RULES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Channel mock data ────────────────────────────────────────────────────────
const CHANNELS_INIT = [
  {
    id:'ch1', name:'#ops-alerts',    kind:'slack',      status:'active',
    config:{ webhook_url:'https://hooks.slack.com/services/T00/B00/xxx', channel:'#ops-alerts', username:'Platform Hub', icon_emoji:':bell:' },
    test_sent:'2h ago', created_by:'sarah', created_at:Date.now()-86400000*10,
    sent_today:14, last_alert:'4m ago',
  },
  {
    id:'ch2', name:'PagerDuty – Infra', kind:'pagerduty', status:'active',
    config:{ integration_key:'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', severity_map:{ critical:'critical', warning:'warning', info:'info' } },
    test_sent:'1d ago', created_by:'sarah', created_at:Date.now()-86400000*30,
    sent_today:2, last_alert:'4m ago',
  },
  {
    id:'ch3', name:'ops@acme.com',    kind:'email',      status:'active',
    config:{ to:['ops@acme.com','infra@acme.com'], from:'hub@acme.com', subject_prefix:'[Platform Hub]' },
    test_sent:'3d ago', created_by:'james', created_at:Date.now()-86400000*20,
    sent_today:2, last_alert:'12m ago',
  },
  {
    id:'ch4', name:'Deploy webhook',  kind:'webhook',    status:'active',
    config:{ url:'https://hooks.acme.com/hub-deploy', method:'POST', headers:{'X-Hub-Secret':'••••••••'}, include_payload:true },
    test_sent:'5d ago', created_by:'sarah', created_at:Date.now()-86400000*15,
    sent_today:7, last_alert:'14m ago',
  },
  {
    id:'ch5', name:'#dev-noise',      kind:'slack',      status:'paused',
    config:{ webhook_url:'https://hooks.slack.com/services/T00/B01/yyy', channel:'#dev-noise' },
    test_sent:null, created_by:'james', created_at:Date.now()-86400000*5,
    sent_today:0, last_alert:'never',
  },
];

const CHANNEL_KIND_META = {
  slack:     { icon:'💬', label:'Slack',      color:'#4A154B', fields:['Webhook URL','Channel','Username'] },
  pagerduty: { icon:'🚨', label:'PagerDuty',  color:'#06AC38', fields:['Integration Key','Severity map'] },
  email:     { icon:'✉',  label:'Email',      color:'#5a8ef8', fields:['To','From','Subject prefix'] },
  webhook:   { icon:'🔗', label:'Webhook',    color:'#9d87f5', fields:['URL','Method','Headers'] },
};

// ─── Alert rules mock data ────────────────────────────────────────────────────
const METRICS_LIST = [
  { id:'m_cpu',     label:'Server CPU %',         unit:'%',   subject:'server'  },
  { id:'m_mem',     label:'Server Memory %',       unit:'%',   subject:'server'  },
  { id:'m_disk',    label:'Server Disk %',         unit:'%',   subject:'server'  },
  { id:'m_hb',      label:'Agent heartbeat age',   unit:'s',   subject:'server'  },
  { id:'m_dep_fail',label:'Deployment failures',   unit:'count',subject:'project'},
  { id:'m_err_rate',label:'HTTP error rate',        unit:'%',   subject:'app'     },
  { id:'m_latency', label:'Response latency P95',  unit:'ms',  subject:'app'     },
  { id:'m_queue',   label:'Job queue depth',        unit:'jobs',subject:'global'  },
];

const ALERT_RULES_INIT = [
  {
    id:'r1', name:'Gateway unreachable',
    metric:'m_hb', op:'>', threshold:120, duration_s:60,
    severity:'critical', target_kind:'server', target_id:'s7', target_label:'prod-gateway-01',
    channels:['ch1','ch2'], enabled:true,
    state:'firing', last_fired:Date.now()-240000, resolved_at:null,
    fire_count:3, value_at_trigger:240,
  },
  {
    id:'r2', name:'DB memory high',
    metric:'m_mem', op:'>', threshold:85, duration_s:300,
    severity:'warning', target_kind:'server', target_id:'s3', target_label:'prod-db-01',
    channels:['ch1','ch3'], enabled:true,
    state:'firing', last_fired:Date.now()-720000, resolved_at:null,
    fire_count:1, value_at_trigger:88,
  },
  {
    id:'r3', name:'Build runner CPU spike',
    metric:'m_cpu', op:'>', threshold:90, duration_s:180,
    severity:'warning', target_kind:'server', target_id:'s5', target_label:'build-runner-01',
    channels:['ch1'], enabled:true,
    state:'ok', last_fired:Date.now()-3600000*4, resolved_at:Date.now()-3600000*3,
    fire_count:2, value_at_trigger:94,
  },
  {
    id:'r4', name:'Any server disk > 80%',
    metric:'m_disk', op:'>', threshold:80, duration_s:600,
    severity:'warning', target_kind:'server', target_id:null, target_label:'All servers',
    channels:['ch1','ch3'], enabled:true,
    state:'ok', last_fired:null, resolved_at:null,
    fire_count:0, value_at_trigger:null,
  },
  {
    id:'r5', name:'API error rate elevated',
    metric:'m_err_rate', op:'>', threshold:1, duration_s:120,
    severity:'critical', target_kind:'app', target_id:'a1', target_label:'api-gateway/router',
    channels:['ch1','ch2','ch3'], enabled:true,
    state:'ok', last_fired:Date.now()-86400000*2, resolved_at:Date.now()-86400000*2+1800000,
    fire_count:1, value_at_trigger:2.4,
  },
  {
    id:'r6', name:'Deploy failures (prod)',
    metric:'m_dep_fail', op:'>=', threshold:1, duration_s:0,
    severity:'critical', target_kind:'project', target_id:'p3', target_label:'data-pipeline',
    channels:['ch1','ch2'], enabled:true,
    state:'ok', last_fired:Date.now()-86400000, resolved_at:Date.now()-86400000+600000,
    fire_count:1, value_at_trigger:1,
  },
  {
    id:'r7', name:'Agent heartbeat timeout',
    metric:'m_hb', op:'>', threshold:60, duration_s:0,
    severity:'warning', target_kind:'server', target_id:null, target_label:'All servers',
    channels:['ch1'], enabled:false,
    state:'ok', last_fired:null, resolved_at:null,
    fire_count:0, value_at_trigger:null,
  },
];

const SEV_COLOR = { critical:T.red, warning:T.amber, info:T.blue };
const SEV_BG    = { critical:`${T.red}15`, warning:`${T.amber}12`, info:`${T.blue}10` };
const STATE_COLOR = { firing:T.red, ok:T.green, pending:T.amber, nodata:T.muted };

// ─── Channel kind icon badge ──────────────────────────────────────────────────
function KindBadge({ kind }) {
  const m = CHANNEL_KIND_META[kind] || { icon:'?', label:kind, color:T.sec };
  return (
    <div style={{display:'flex',alignItems:'center',gap:5}}>
      <div style={{width:22,height:22,borderRadius:5,background:`${m.color}20`,border:`0.5px solid ${m.color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,flexShrink:0}}>
        {m.icon}
      </div>
      <span style={{fontSize:12,color:T.sec}}>{m.label}</span>
    </div>
  );
}

// ─── Create/Edit Channel Modal ────────────────────────────────────────────────
function ChannelModal({ channel, onClose, onSave }) {
  const toast   = useToast();
  const editing = !!channel;
  const [kind, setKind]   = useState(channel?.kind || 'slack');
  const [name, setName]   = useState(channel?.name || '');
  const [url,  setUrl]    = useState(channel?.config?.webhook_url || channel?.config?.url || '');
  const [to,   setTo]     = useState((channel?.config?.to||[]).join(', ') || '');
  const [ikey, setIkey]   = useState(channel?.config?.integration_key || '');
  const [ch,   setCh]     = useState(channel?.config?.channel || '');
  const [testing, setTest]= useState(false);

  const testChannel = () => {
    setTest(true);
    setTimeout(() => {
      setTest(false);
      toast.success('Test delivered', `Test notification sent to ${name||kind}.`);
    }, 1200);
  };

  const save = () => {
    if (!name.trim()) { toast.error('Name required','Give this channel a name.'); return; }
    toast.success(editing?'Channel updated':'Channel created', name);
    onSave({ kind, name, url, to, ikey, ch });
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:520,overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>{editing?'Edit channel':'New notification channel'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{padding:'20px 22px',overflowY:'auto'}}>
          {/* Kind picker */}
          {!editing && (
            <div style={{marginBottom:18}}>
              <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Channel type</label>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:7}}>
                {Object.entries(CHANNEL_KIND_META).map(([k,m])=>{
                  const sel = kind===k;
                  return (
                    <button key={k} onClick={()=>setKind(k)} style={{background:sel?`${m.color}15`:T.elevated,border:`1px solid ${sel?m.color:T.border}`,borderRadius:7,padding:'10px 8px',cursor:'pointer',textAlign:'center'}}>
                      <div style={{fontSize:20,marginBottom:5}}>{m.icon}</div>
                      <div style={{fontSize:11,color:sel?T.text:T.sec,fontWeight:sel?500:400}}>{m.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Input label="Channel name" value={name} onChange={e=>setName(e.target.value)} placeholder={kind==='slack'?'#ops-alerts':kind==='email'?'ops@acme.com':'Deploy webhook'} hint="Used to identify this channel in alert rules."/>
          {kind==='slack' && <>
            <Input label="Slack webhook URL" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." mono type="password" hint="Incoming webhook URL from Slack app settings."/>
            <Input label="Channel" value={ch} onChange={e=>setCh(e.target.value)} placeholder="#ops-alerts" hint="Override the channel set in the webhook (optional)."/>
          </>}
          {kind==='pagerduty' && (
            <Input label="Integration key" value={ikey} onChange={e=>setIkey(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" mono type="password" hint="Events API v2 integration key from PagerDuty service."/>
          )}
          {kind==='email' && (
            <Input label="Recipients" value={to} onChange={e=>setTo(e.target.value)} placeholder="ops@acme.com, infra@acme.com" hint="Comma-separated email addresses."/>
          )}
          {kind==='webhook' && (
            <Input label="Endpoint URL" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://hooks.acme.com/hub-alerts" mono hint="POST requests will include a JSON alert payload."/>
          )}
        </div>
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <button onClick={testChannel} disabled={testing} style={{display:'flex',alignItems:'center',gap:7,fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer',opacity:testing?0.6:1}}>
            {testing?<><span style={{display:'inline-block',width:10,height:10,border:`1.5px solid ${T.sec}`,borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Sending…</>:'↗ Send test'}
          </button>
          <div style={{display:'flex',gap:10}}>
            <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 12px'}}>Cancel</button>
            <button onClick={save} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
              {editing?'Save changes':'Create channel'}
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── NotificationChannelsView ─────────────────────────────────────────────────
function NotificationChannelsView() {
  const toast = useToast();
  const [channels, setChannels] = useState(CHANNELS_INIT);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing]    = useState(null);

  const deleteChannel = (ch) => {
    const usedBy = ALERT_RULES_INIT.filter(r=>r.channels.includes(ch.id)).length;
    if (usedBy > 0) { toast.warning('Channel in use', `${usedBy} alert rule${usedBy!==1?'s':''} reference this channel. Remove them first.`); return; }
    setChannels(cs=>cs.filter(c=>c.id!==ch.id));
    toast.success('Channel deleted', ch.name);
  };

  const togglePause = (ch) => {
    setChannels(cs=>cs.map(c=>c.id===ch.id?{...c,status:c.status==='active'?'paused':'active'}:c));
    toast(ch.status==='active'?'warning':'success', ch.status==='active'?`${ch.name} paused`:`${ch.name} resumed`, ch.status==='active'?'No alerts will be sent.':'Alerts will resume.');
  };

  const sendTest = (ch) => {
    const t = toast.loading('Sending test…', ch.name);
    setTimeout(()=>t.update('success','Test delivered',`Test alert delivered to ${ch.name}.`), 1100);
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:900}}>
      {showModal && <ChannelModal channel={editing} onClose={()=>{setShowModal(false);setEditing(null);}} onSave={c=>setChannels(cs=>[...cs,{id:'ch'+Date.now(),...c,status:'active',sent_today:0,last_alert:'never',created_by:'sarah',created_at:Date.now(),test_sent:null}])}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Notification Channels</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            {channels.filter(c=>c.status==='active').length} active · {channels.length} total · where alerts get delivered
          </p>
        </div>
        <button onClick={()=>{setEditing(null);setShowModal(true);}} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ New channel
        </button>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Active channels" value={channels.filter(c=>c.status==='active').length} sub="receiving alerts" color={T.green}/>
        <StatCard label="Paused"          value={channels.filter(c=>c.status==='paused').length}  sub="temporarily silenced" color={T.muted}/>
        <StatCard label="Sent today"      value={channels.reduce((a,c)=>a+(c.sent_today||0),0)}   sub="total notifications"/>
        <StatCard label="Last alert"      value="4m ago" sub="prod-gateway-01 unreachable" color={T.red}/>
      </div>

      {/* Channel list */}
      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {channels.map(ch => {
          const m = CHANNEL_KIND_META[ch.kind] || {};
          const isPaused = ch.status === 'paused';
          const rulesUsingThis = ALERT_RULES_INIT.filter(r=>r.channels.includes(ch.id)).length;
          return (
            <div key={ch.id} style={{background:T.card,border:`0.5px solid ${isPaused?T.muted+'44':T.border}`,borderRadius:9,padding:'16px 20px',opacity:isPaused?0.75:1}}>
              <div style={{display:'flex',alignItems:'center',gap:14}}>
                {/* Icon */}
                <div style={{width:40,height:40,borderRadius:9,background:`${m.color||T.sec}18`,border:`1px solid ${m.color||T.sec}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,flexShrink:0}}>
                  {m.icon||'?'}
                </div>
                {/* Name + kind */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{ch.name}</span>
                    <Pill label={m.label||ch.kind} color={m.color||T.sec}/>
                    {isPaused && <Pill label="paused" color={T.muted}/>}
                  </div>
                  <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {ch.config?.webhook_url||ch.config?.url||ch.config?.to?.join(', ')||ch.config?.integration_key?.slice(0,16)+'…'}
                  </div>
                </div>
                {/* Stats */}
                <div style={{textAlign:'center',minWidth:70,flexShrink:0}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Sent today</div>
                  <div style={{fontSize:16,fontWeight:700,color:ch.sent_today>0?T.text:T.muted}}>{ch.sent_today}</div>
                </div>
                <div style={{textAlign:'right',minWidth:80,flexShrink:0}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Last alert</div>
                  <div style={{fontSize:12,color:T.muted}}>{ch.last_alert}</div>
                </div>
                <div style={{textAlign:'right',minWidth:60,flexShrink:0}}>
                  <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Rules</div>
                  <div style={{fontSize:14,fontWeight:600,color:rulesUsingThis>0?T.text:T.muted}}>{rulesUsingThis}</div>
                </div>
                {/* Actions */}
                <div style={{display:'flex',gap:7,flexShrink:0,marginLeft:8}}>
                  <button onClick={()=>sendTest(ch)} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer',whiteSpace:'nowrap'}}>Test</button>
                  <button onClick={()=>togglePause(ch)} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer',whiteSpace:'nowrap'}}>{isPaused?'Resume':'Pause'}</button>
                  <button onClick={()=>{setEditing(ch);setShowModal(true);}} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Edit</button>
                  <button onClick={()=>deleteChannel(ch)} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Create/Edit Alert Rule Modal ─────────────────────────────────────────────
function AlertRuleModal({ rule, channels, onClose, onSave }) {
  const toast   = useToast();
  const editing = !!rule;
  const [name, setName]         = useState(rule?.name||'');
  const [metric, setMetric]     = useState(rule?.metric||'m_cpu');
  const [op, setOp]             = useState(rule?.op||'>');
  const [threshold, setThresh]  = useState(String(rule?.threshold||80));
  const [duration, setDur]      = useState(String(rule?.duration_s||300));
  const [severity, setSev]      = useState(rule?.severity||'warning');
  const [selCh, setSelCh]       = useState(rule?.channels||[]);

  const toggleCh = id => setSelCh(cs=>cs.includes(id)?cs.filter(x=>x!==id):[...cs,id]);
  const selMetric = METRICS_LIST.find(m=>m.id===metric);

  const save = () => {
    if (!name.trim()) { toast.error('Name required','Give this rule a name.'); return; }
    if (selCh.length===0) { toast.warning('No channels','Select at least one notification channel.'); return; }
    toast.success(editing?'Rule updated':'Alert rule created', name);
    onSave({ name, metric, op, threshold:Number(threshold), duration_s:Number(duration), severity, channels:selCh });
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:560,maxHeight:'90vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>{editing?'Edit rule':'New alert rule'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>
          <Input label="Rule name" value={name} onChange={e=>setName(e.target.value)} placeholder="DB memory high"/>

          {/* Metric picker */}
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Metric</label>
            <div style={{display:'flex',flexDirection:'column',gap:5}}>
              {METRICS_LIST.map(m=>{
                const sel = metric===m.id;
                return (
                  <button key={m.id} onClick={()=>setMetric(m.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:6,border:`1px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                    <div style={{width:16,height:16,borderRadius:'50%',border:`1.5px solid ${sel?T.blue:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      {sel&&<div style={{width:7,height:7,borderRadius:'50%',background:T.blue}}/>}
                    </div>
                    <span style={{fontSize:13,color:sel?T.text:T.sec,flex:1}}>{m.label}</span>
                    <span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{m.unit}</span>
                    <span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`}}>{m.subject}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Condition */}
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Condition</label>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <span style={{fontSize:12,color:T.sec,fontFamily:'monospace',background:T.elevated,padding:'8px 12px',borderRadius:6,border:`0.5px solid ${T.border}`,whiteSpace:'nowrap'}}>{selMetric?.label}</span>
              <select value={op} onChange={e=>setOp(e.target.value)} style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none',cursor:'pointer'}}>
                {['>','>=','<','<=','==','!='].map(o=><option key={o} value={o}>{o}</option>)}
              </select>
              <input value={threshold} onChange={e=>setThresh(e.target.value)} type="number" style={{width:80,background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none',textAlign:'right'}}/>
              <span style={{fontSize:12,color:T.muted,fontFamily:'monospace'}}>{selMetric?.unit}</span>
            </div>
          </div>

          {/* Duration */}
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>For duration</label>
            <div style={{display:'flex',gap:7}}>
              {[['0','instantly'],['60','1 min'],['300','5 min'],['600','10 min'],['1800','30 min']].map(([v,l])=>{
                const sel=duration===v;
                return <button key={v} onClick={()=>setDur(v)} style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}15`:T.elevated,color:sel?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:sel?600:400}}>{l}</button>;
              })}
            </div>
            <div style={{fontSize:11,color:T.muted,marginTop:5}}>Condition must be true for this long before firing. "Instantly" fires on first evaluation.</div>
          </div>

          {/* Severity */}
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Severity</label>
            <div style={{display:'flex',gap:7}}>
              {['info','warning','critical'].map(s=>{
                const c=SEV_COLOR[s]; const sel=severity===s;
                return <button key={s} onClick={()=>setSev(s)} style={{padding:'6px 16px',borderRadius:5,border:`1px solid ${sel?c:T.border}`,background:sel?SEV_BG[s]:T.elevated,color:sel?c:T.sec,fontSize:12,cursor:'pointer',fontWeight:sel?600:400,textTransform:'capitalize'}}>{s}</button>;
              })}
            </div>
          </div>

          {/* Channels */}
          <div>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Notify via</label>
            <div style={{display:'flex',flexDirection:'column',gap:5}}>
              {channels.filter(c=>c.status==='active').map(c=>{
                const m = CHANNEL_KIND_META[c.kind]||{};
                const checked = selCh.includes(c.id);
                return (
                  <button key={c.id} onClick={()=>toggleCh(c.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:6,border:`1px solid ${checked?T.blue:T.border}`,background:checked?`${T.blue}10`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                    <div style={{width:16,height:16,borderRadius:3,border:`1.5px solid ${checked?T.blue:T.border}`,background:checked?T.blue:'none',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      {checked&&<span style={{fontSize:9,color:'#fff',fontWeight:700}}>✓</span>}
                    </div>
                    <span style={{fontSize:13}}>{m.icon}</span>
                    <span style={{fontSize:13,color:T.text,flex:1}}>{c.name}</span>
                    <Pill label={m.label||c.kind} color={m.color||T.sec}/>
                  </button>
                );
              })}
            </div>
            {selCh.length===0 && <div style={{fontSize:11,color:T.amber,marginTop:6}}>⚠ No channels selected — rule will fire silently</div>}
          </div>
        </div>
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',flexShrink:0}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
          <button onClick={save} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
            {editing?'Save changes':'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AlertRulesView ────────────────────────────────────────────────────────────
function AlertRulesView({ onGoChannels }) {
  const toast = useToast();
  const [alertDismissed, setAlertDismissed] = useState(new Set());
  const alertNotices = computeNotices().filter(n => n.category === 'alert' && !alertDismissed.has(n.id));
  const [rules, setRules]       = useState(ALERT_RULES_INIT);
  const [channels]              = useState(CHANNELS_INIT);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing]     = useState(null);
  const [filter, setFilter]       = useState('all'); // all | firing | ok

  const toggleRule = (id) => {
    setRules(rs=>rs.map(r=>r.id===id?{...r,enabled:!r.enabled}:r));
    const r = rules.find(x=>x.id===id);
    toast(r.enabled?'warning':'success', r.enabled?`Rule disabled`:`Rule enabled`, r.name);
  };

  const deleteRule = (r) => {
    setRules(rs=>rs.filter(x=>x.id!==r.id));
    toast.success('Rule deleted', r.name);
  };

  const filtered = filter==='all' ? rules
    : filter==='firing' ? rules.filter(r=>r.state==='firing')
    : rules.filter(r=>r.state==='ok'||r.state==='nodata');

  const firing = rules.filter(r=>r.state==='firing').length;

  return (
    <div style={{padding:'28px 30px',maxWidth:1000}}>
      {showModal && <AlertRuleModal rule={editing} channels={channels} onClose={()=>{setShowModal(false);setEditing(null);}}
        onSave={d=>setRules(rs=>[...rs,{id:'r'+Date.now(),state:'ok',last_fired:null,resolved_at:null,fire_count:0,value_at_trigger:null,target_kind:'server',target_id:null,target_label:'All',enabled:true,...d}])}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Alert Rules</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            {rules.filter(r=>r.enabled).length} enabled · <span style={{color:T.red,fontWeight:500}}>{firing} firing</span> · {rules.length} total
          </p>
        </div>
        <button onClick={()=>{setEditing(null);setShowModal(true);}} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ New rule
        </button>
      </div>

      {/* Stat strip */}
      <NoticeBar notices={alertNotices} onDismiss={id=>setAlertDismissed(s=>new Set([...s,id]))}/>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
        <StatCard label="Firing now"   value={firing}                                      sub="active alerts"         color={firing>0?T.red:T.text}/>
        <StatCard label="Enabled rules" value={rules.filter(r=>r.enabled).length}          sub="actively evaluated"/>
        <StatCard label="Channels"      value={channels.filter(c=>c.status==='active').length} sub={<span onClick={onGoChannels} style={{cursor:'pointer',color:T.blue}}>manage →</span>}/>
        <StatCard label="Fired today"   value={rules.reduce((a,r)=>a+r.fire_count,0)}      sub="total rule triggers"/>
      </div>

      {/* Firing banner */}
      {firing > 0 && (
        <div style={{background:`${T.red}10`,border:`0.5px solid ${T.red}44`,borderRadius:8,padding:'12px 16px',marginBottom:16,display:'flex',alignItems:'flex-start',gap:10}}>
          <span style={{color:T.red,fontSize:16,flexShrink:0}}>▲</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.red,marginBottom:4}}>{firing} rule{firing!==1?'s':''} currently firing</div>
            <div style={{display:'flex',flexDirection:'column',gap:3}}>
              {rules.filter(r=>r.state==='firing').map(r=>(
                <div key={r.id} style={{fontSize:12,color:T.sec}}>
                  <span style={{fontWeight:500,color:T.text}}>{r.name}</span>
                  {' — '}{r.target_label} · {METRICS_LIST.find(m=>m.id===r.metric)?.label} {r.op} {r.threshold}{METRICS_LIST.find(m=>m.id===r.metric)?.unit}
                  {r.value_at_trigger && <span style={{color:T.red}}> (current: {r.value_at_trigger}{METRICS_LIST.find(m=>m.id===r.metric)?.unit})</span>}
                  <span style={{color:T.muted}}> · {fmtAge(r.last_fired)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Filter */}
      <div style={{display:'flex',gap:3,marginBottom:16,background:T.elevated,borderRadius:7,padding:3,width:'fit-content'}}>
        {[['all','All'],['firing','Firing'],['ok','OK / Inactive']].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{padding:'5px 14px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===v?500:400,background:filter===v?T.card:'transparent',color:filter===v?T.text:T.sec}}>{l}{v==='firing'&&firing>0?` (${firing})`:''}</button>
        ))}
      </div>

      {/* Rules list */}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {filtered.map(rule => {
          const m    = METRICS_LIST.find(x=>x.id===rule.metric);
          const isFiring = rule.state==='firing';
          const sc   = SEV_COLOR[rule.severity]||T.muted;
          const ruleChannels = channels.filter(c=>rule.channels.includes(c.id));

          return (
            <div key={rule.id} style={{background:T.card,border:`0.5px solid ${isFiring?sc+'55':T.border}`,borderRadius:9,padding:'14px 18px',opacity:rule.enabled?1:0.5,transition:'opacity 0.2s'}}>
              <div style={{display:'flex',alignItems:'flex-start',gap:14}}>
                {/* Toggle */}
                <div onClick={()=>toggleRule(rule.id)} style={{width:32,height:18,borderRadius:9,background:rule.enabled?(isFiring?sc:T.green):T.elevated,border:`0.5px solid ${rule.enabled?(isFiring?sc:T.green):T.borderMd}`,cursor:'pointer',position:'relative',flexShrink:0,marginTop:2,transition:'background 0.15s'}}>
                  <div style={{position:'absolute',top:1,left:rule.enabled?15:1,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                </div>

                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{rule.name}</span>
                    <Pill label={rule.severity} color={sc}/>
                    <Pill label={rule.state}    color={STATE_COLOR[rule.state]||T.muted}/>
                    {!rule.enabled && <Pill label="disabled" color={T.muted}/>}
                  </div>

                  {/* Condition summary */}
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,flexWrap:'wrap'}}>
                    <div style={{display:'flex',alignItems:'center',gap:5,padding:'3px 9px',borderRadius:4,background:T.elevated,border:`0.5px solid ${T.border}`}}>
                      <span style={{fontSize:11,color:T.sec}}>{m?.label}</span>
                      <span style={{fontSize:12,fontWeight:600,color:T.text,fontFamily:'monospace'}}>{rule.op}</span>
                      <span style={{fontSize:12,fontWeight:600,color:sc,fontFamily:'monospace'}}>{rule.threshold}{m?.unit}</span>
                    </div>
                    {rule.duration_s > 0 && (
                      <span style={{fontSize:11,color:T.muted}}>for {rule.duration_s>=3600?rule.duration_s/3600+'h':rule.duration_s>=60?rule.duration_s/60+'m':rule.duration_s+'s'}</span>
                    )}
                    <span style={{fontSize:11,color:T.muted}}>on</span>
                    <span style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{rule.target_label}</span>
                  </div>

                  {/* Channels */}
                  <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{fontSize:10,color:T.muted}}>→</span>
                    {ruleChannels.map(c=>{
                      const cm = CHANNEL_KIND_META[c.kind]||{};
                      return <span key={c.id} style={{fontSize:11,padding:'2px 7px',borderRadius:4,background:`${cm.color||T.sec}12`,color:cm.color||T.sec,border:`0.5px solid ${cm.color||T.sec}33`}}>{cm.icon} {c.name}</span>;
                    })}
                    {ruleChannels.length===0 && <span style={{fontSize:11,color:T.amber}}>no channels</span>}
                  </div>
                </div>

                {/* Right: stats + actions */}
                <div style={{flexShrink:0,textAlign:'right',minWidth:140}}>
                  <div style={{display:'flex',gap:12,justifyContent:'flex-end',marginBottom:8}}>
                    <div>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Fired</div>
                      <div style={{fontSize:14,fontWeight:600,color:rule.fire_count>0?T.text:T.muted}}>{rule.fire_count}×</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Last</div>
                      <div style={{fontSize:12,color:T.muted}}>{rule.last_fired?fmtAge(rule.last_fired):'never'}</div>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                    <button onClick={()=>{setEditing(rule);setShowModal(true);}} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Edit</button>
                    <button onClick={()=>deleteRule(rule)} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// API KEYS MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const API_KEYS_INIT = [
  {
    id:'ak1', name:'ci-bot production', prefix:'hub_live_',
    token:'hub_live_sk_4pjM3K9vXzQw8nR2••••••••••••••••••••••••',
    token_full:'hub_live_sk_4pjM3K9vXzQw8nR2sT6uY1bD5fH0cE7lAjKmNpQrs9xZ2',
    scopes:['deployments:write','servers:read','projects:read'],
    user_id:'u3', user_name:'ci-bot', user_type:'bot',
    workspace:'Acme Corp', status:'active',
    created_by:'sarah', created_at:Date.now()-86400000*45,
    last_used:Date.now()-3*60000, expires_at:null,
    uses_today:14, total_uses:842,
  },
  {
    id:'ak2', name:'deploy-agent (prod-web-01)', prefix:'hub_live_',
    token:'hub_live_sk_9kLmN2oP4qRs••••••••••••••••••••••••••',
    token_full:'hub_live_sk_9kLmN2oP4qRsT6uV8wXyZ0aB3cD5eF7gHiJkLmNoP2qR',
    scopes:['deployments:write','servers:write','jobs:write'],
    user_id:'u4', user_name:'deploy-agent', user_type:'ai',
    workspace:'Acme Corp', status:'active',
    created_by:'sarah', created_at:Date.now()-86400000*30,
    last_used:Date.now()-14*60000, expires_at:null,
    uses_today:7, total_uses:321,
  },
  {
    id:'ak3', name:'GitHub Actions deploy', prefix:'hub_live_',
    token:'hub_live_sk_2bCdEfGhIj••••••••••••••••••••••••••••',
    token_full:'hub_live_sk_2bCdEfGhIjKlMnOpQrStUvWxYz1A3B5C7DeFgHiJkLmNo',
    scopes:['deployments:write','projects:read'],
    user_id:'u3', user_name:'ci-bot', user_type:'bot',
    workspace:'Acme Corp', status:'active',
    created_by:'james', created_at:Date.now()-86400000*20,
    last_used:Date.now()-2*3600000, expires_at:null,
    uses_today:3, total_uses:156,
  },
  {
    id:'ak4', name:'read-only monitoring', prefix:'hub_live_',
    token:'hub_live_sk_7hIjKlMnOp••••••••••••••••••••••••••••',
    token_full:'hub_live_sk_7hIjKlMnOpQrStUvWxYz1A3B5C7DeFgHiJkLmNoPqRsT',
    scopes:['servers:read','projects:read','deployments:read','jobs:read'],
    user_id:'u10', user_name:'frontier-ai', user_type:'ai',
    workspace:'Acme Corp', status:'active',
    created_by:'sarah', created_at:Date.now()-86400000*10,
    last_used:Date.now()-30000, expires_at:null,
    uses_today:48, total_uses:48,
  },
  {
    id:'ak5', name:'old staging bot', prefix:'hub_live_',
    token:'hub_live_sk_0AaBbCcDdEe••••••••••••••••••••••••••',
    token_full:'hub_live_sk_0AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuV',
    scopes:['deployments:write','servers:read'],
    user_id:'u7', user_name:'skyline-ci', user_type:'bot',
    workspace:'Acme Corp', status:'revoked',
    created_by:'james', created_at:Date.now()-86400000*60,
    last_used:Date.now()-86400000*14, expires_at:null,
    uses_today:0, total_uses:203,
  },
];

const ALL_SCOPES = [
  { id:'servers:read',       group:'Servers',      label:'Read servers & fleet data' },
  { id:'servers:write',      group:'Servers',      label:'Drain, reboot, sync servers' },
  { id:'projects:read',      group:'Projects',     label:'Read projects, environments, apps' },
  { id:'projects:write',     group:'Projects',     label:'Create and modify apps' },
  { id:'deployments:read',   group:'Deployments',  label:'View deployment history' },
  { id:'deployments:write',  group:'Deployments',  label:'Trigger and manage deployments' },
  { id:'jobs:read',          group:'Jobs',         label:'View scheduled jobs' },
  { id:'jobs:write',         group:'Jobs',         label:'Run and cancel jobs' },
  { id:'ssh-keys:read',      group:'SSH Keys',     label:'List SSH keys' },
  { id:'ssh-keys:write',     group:'SSH Keys',     label:'Add and delete SSH keys' },
  { id:'admin',              group:'Admin',        label:'Full system access (use with care)' },
];

const SCOPE_PRESETS = [
  { id:'readonly',  label:'Read-only',     scopes:['servers:read','projects:read','deployments:read','jobs:read'] },
  { id:'deploy',    label:'Deploy bot',    scopes:['deployments:write','projects:read','servers:read'] },
  { id:'ci',        label:'CI/CD',         scopes:['deployments:write','jobs:write','projects:read','servers:read'] },
  { id:'agent',     label:'Agent',         scopes:['deployments:write','servers:write','jobs:write'] },
  { id:'custom',    label:'Custom',        scopes:[] },
];

function CreateApiKeyModal({ onClose, onCreate }) {
  const toast = useToast();
  const [step, setStep]         = useState(0); // 0=config, 1=copy
  const [name, setName]         = useState('');
  const [preset, setPreset]     = useState('deploy');
  const [scopes, setScopes]     = useState(SCOPE_PRESETS[1].scopes);
  const [expires, setExpires]   = useState('never');
  const [newToken, setNewToken] = useState('');
  const [copied, setCopied]     = useState(false);

  const toggleScope = id => {
    setPreset('custom');
    setScopes(ss => ss.includes(id) ? ss.filter(x=>x!==id) : [...ss,id]);
  };

  const selectPreset = (p) => {
    setPreset(p.id);
    if (p.id !== 'custom') setScopes(p.scopes);
  };

  const generate = () => {
    if (!name.trim()) { toast.error('Name required','Give this key a name.'); return; }
    if (scopes.length === 0) { toast.warning('No scopes','Select at least one permission scope.'); return; }
    const token = 'hub_live_sk_' + Array.from({length:40},()=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*62)]).join('');
    setNewToken(token);
    setStep(1);
    onCreate({ name, scopes, token, expires });
  };

  const copyToken = () => {
    navigator.clipboard?.writeText(newToken).catch(()=>{});
    setCopied(true);
    setTimeout(()=>setCopied(false), 2500);
    toast.success('Token copied','Store it somewhere safe — you won\'t see it again.');
  };

  const scopeGroups = ALL_SCOPES.reduce((acc,s)=>{ (acc[s.group]=[...acc[s.group]||[],s]); return acc; },{});

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:560,maxHeight:'90vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>{step===0?'New API key':'Save your key'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>

        {step===0 ? (
          <>
            <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>
              <Input label="Key name" value={name} onChange={e=>setName(e.target.value)} placeholder="GitHub Actions deploy" hint="Describe what this key is used for."/>

              {/* Preset selector */}
              <div style={{marginBottom:16}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Permission preset</label>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {SCOPE_PRESETS.map(p=>{
                    const sel = preset===p.id;
                    return <button key={p.id} onClick={()=>selectPreset(p)} style={{padding:'5px 13px',borderRadius:5,border:`1px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}15`:T.elevated,color:sel?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:sel?600:400}}>{p.label}</button>;
                  })}
                </div>
              </div>

              {/* Scopes */}
              <div style={{marginBottom:16}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Scopes</label>
                <div style={{display:'flex',flexDirection:'column',gap:0,border:`0.5px solid ${T.border}`,borderRadius:8,overflow:'hidden'}}>
                  {Object.entries(scopeGroups).map(([group,gs],gi,arr)=>(
                    <div key={group}>
                      <div style={{padding:'6px 12px',background:T.elevated,fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',fontWeight:500}}>{group}</div>
                      {gs.map((s,si)=>{
                        const checked = scopes.includes(s.id);
                        return (
                          <button key={s.id} onClick={()=>toggleScope(s.id)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,padding:'8px 12px',border:'none',borderBottom:`0.5px solid ${T.border}`,background:checked?`${T.blue}08`:'none',cursor:'pointer',textAlign:'left'}}>
                            <div style={{width:15,height:15,borderRadius:3,border:`1.5px solid ${checked?T.blue:T.border}`,background:checked?T.blue:'none',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                              {checked&&<span style={{fontSize:8,color:'#fff',fontWeight:700}}>✓</span>}
                            </div>
                            <code style={{fontSize:11,fontFamily:'monospace',color:checked?T.blue:T.sec,flex:1}}>{s.id}</code>
                            <span style={{fontSize:11,color:T.muted}}>{s.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {scopes.length===0&&<div style={{fontSize:11,color:T.amber,marginTop:6}}>⚠ No scopes — this key won't be able to do anything</div>}
              </div>

              {/* Expiry */}
              <div>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Expiration</label>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {[['never','No expiry'],['30d','30 days'],['90d','90 days'],['1y','1 year']].map(([v,l])=>(
                    <button key={v} onClick={()=>setExpires(v)} style={{padding:'5px 13px',borderRadius:5,border:`1px solid ${expires===v?T.blue:T.border}`,background:expires===v?`${T.blue}15`:T.elevated,color:expires===v?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:expires===v?600:400}}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',flexShrink:0}}>
              <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
              <button onClick={generate} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Generate key →</button>
            </div>
          </>
        ) : (
          <>
            <div style={{flex:1,padding:'20px 22px'}}>
              {/* One-time reveal warning */}
              <div style={{background:`${T.amber}12`,border:`0.5px solid ${T.amber}44`,borderRadius:8,padding:'12px 16px',marginBottom:20,display:'flex',gap:10,alignItems:'flex-start'}}>
                <span style={{color:T.amber,fontSize:18,flexShrink:0}}>⚠</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:T.amber,marginBottom:3}}>Copy this token now</div>
                  <div style={{fontSize:12,color:T.sec}}>For security, we only show this once. If you lose it, revoke this key and create a new one.</div>
                </div>
              </div>

              {/* Token display */}
              <div style={{marginBottom:20}}>
                <div style={{background:'#090b11',borderRadius:8,padding:'14px 16px',fontFamily:'monospace',fontSize:12,color:T.green,wordBreak:'break-all',lineHeight:'20px',border:`1px solid ${T.green}44`,position:'relative'}}>
                  {newToken}
                </div>
                <button onClick={copyToken} style={{width:'100%',marginTop:10,padding:'10px',borderRadius:7,border:`1px solid ${copied?T.green+'66':T.blue}`,background:copied?`${T.green}12`:`${T.blue}12`,color:copied?T.green:T.blue,fontSize:13,fontWeight:600,cursor:'pointer',transition:'all 0.15s'}}>
                  {copied?'✓ Copied to clipboard':'Copy token'}
                </button>
              </div>

              {/* Summary */}
              <div style={{background:T.elevated,borderRadius:7,padding:'12px 16px',fontSize:12}}>
                {[['Name',name],['Scopes',scopes.join(', ')],['Expires',expires==='never'?'Never':expires],['Created','just now']].map(([k,v])=>(
                  <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:`0.5px solid ${T.border}`}}>
                    <span style={{color:T.sec}}>{k}</span>
                    <span style={{color:T.text,fontFamily:k==='Scopes'||k==='Name'?'inherit':'monospace',maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',textAlign:'right'}}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,flexShrink:0}}>
              <button onClick={onClose} style={{width:'100%',background:T.blue,border:'none',borderRadius:6,padding:'9px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Done — I've saved my token</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ApiKeysView() {
  const toast = useToast();
  const [keys, setKeys]       = useState(API_KEYS_INIT);
  const [showCreate, setCreate] = useState(false);
  const [filter, setFilter]   = useState('all');
  const [copied, setCopied]   = useState(null);
  const [revealed, setRevealed] = useState({});

  const revokeKey = k => {
    setKeys(ks=>ks.map(x=>x.id===k.id?{...x,status:'revoked'}:x));
    toast.error('Key revoked',`${k.name} can no longer authenticate.`);
  };

  const deleteKey = k => {
    setKeys(ks=>ks.filter(x=>x.id!==k.id));
    toast.success('Key deleted',k.name);
  };

  const copyPrefix = (k) => {
    navigator.clipboard?.writeText(k.token_full).catch(()=>{});
    setCopied(k.id);
    setTimeout(()=>setCopied(null),2000);
    toast.success('Copied',`${k.name} token copied.`);
  };

  const filtered = filter==='all' ? keys : keys.filter(k=>k.status===filter);
  const active = keys.filter(k=>k.status==='active');
  const uColor = t => ({human:T.blue,bot:T.cyan,ai:T.purple}[t]||T.muted);

  return (
    <div style={{padding:'28px 30px',maxWidth:920}}>
      {showCreate&&<CreateApiKeyModal onClose={()=>setCreate(false)} onCreate={k=>setKeys(ks=>[{id:'ak'+Date.now(),prefix:'hub_live_',token:'hub_live_sk_'+k.token.slice(12,24)+'••••••••',token_full:k.token,scopes:k.scopes,user_id:'u1',user_name:'sarah',user_type:'human',workspace:'Acme Corp',status:'active',created_by:'sarah',created_at:Date.now(),last_used:null,expires_at:null,uses_today:0,total_uses:0,...k},...ks])}/>}

      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>API Keys</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            {active.length} active keys · workspace-scoped · used by CI/CD, bots, and AI agents
          </p>
        </div>
        <button onClick={()=>setCreate(true)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ New key
        </button>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Active keys"  value={active.length}                                         sub="can authenticate"  color={T.green}/>
        <StatCard label="Revoked"      value={keys.filter(k=>k.status==='revoked').length}            sub="access removed"   color={T.muted}/>
        <StatCard label="Uses today"   value={keys.reduce((a,k)=>a+k.uses_today,0)}                  sub="API calls"/>
        <StatCard label="Scope types"  value={[...new Set(keys.flatMap(k=>k.scopes))].length}         sub="distinct scopes used"/>
      </div>

      {/* Security notice */}
      <div style={{background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:8,padding:'10px 16px',marginBottom:20,display:'flex',gap:10,alignItems:'center'}}>
        <span style={{fontSize:14,color:T.blue,flexShrink:0}}>ℹ</span>
        <div style={{fontSize:12,color:T.sec}}>
          API keys carry the permissions of the user account they belong to. For CI/CD, use a dedicated <strong style={{color:T.text}}>bot</strong> user with minimal scopes — never use a personal key in automated pipelines.
        </div>
      </div>

      {/* Filter */}
      <div style={{display:'flex',gap:3,marginBottom:18,background:T.elevated,borderRadius:7,padding:3,width:'fit-content'}}>
        {[['all','All'],['active','Active'],['revoked','Revoked']].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{padding:'5px 14px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===v?500:400,background:filter===v?T.card:'transparent',color:filter===v?T.text:T.sec}}>{l}</button>
        ))}
      </div>

      {/* Key list */}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {filtered.map(k=>{
          const isRevoked = k.status==='revoked';
          const isRevealed = revealed[k.id];
          return (
            <div key={k.id} style={{background:T.card,border:`0.5px solid ${isRevoked?T.muted+'33':T.border}`,borderRadius:9,padding:'16px 20px',opacity:isRevoked?0.6:1}}>
              <div style={{display:'flex',alignItems:'flex-start',gap:14}}>
                {/* Actor avatar */}
                <div style={{width:36,height:36,borderRadius:'50%',background:uColor(k.user_type),display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,color:'#fff',fontWeight:700,flexShrink:0}}>
                  {k.user_name.slice(0,2).toUpperCase()}
                </div>

                {/* Main content */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                    <span style={{fontSize:14,fontWeight:600,color:T.text}}>{k.name}</span>
                    <Pill label={k.status} color={k.status==='active'?T.green:T.muted}/>
                    <Pill label={k.user_type} color={uColor(k.user_type)}/>
                    {k.expires_at&&<Pill label={`expires ${fmtAge(k.expires_at)}`} color={T.amber}/>}
                  </div>

                  {/* Token display */}
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
                    <code style={{fontSize:11,fontFamily:'monospace',color:T.sec,background:T.elevated,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.border}`,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {isRevealed?k.token_full:k.token}
                    </code>
                    <button onClick={()=>setRevealed(r=>({...r,[k.id]:!r[k.id]}))} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
                      {isRevealed?'hide':'reveal'}
                    </button>
                    <button onClick={()=>copyPrefix(k)} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${copied===k.id?T.green+'66':T.border}`,background:copied===k.id?`${T.green}10`:'none',color:copied===k.id?T.green:T.muted,cursor:'pointer',flexShrink:0,transition:'all 0.15s'}}>
                      {copied===k.id?'✓ copied':'copy'}
                    </button>
                  </div>

                  {/* Scopes */}
                  <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                    {k.scopes.map(s=>(
                      <code key={s} style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.sec,border:`0.5px solid ${T.border}`,fontFamily:'monospace'}}>{s}</code>
                    ))}
                  </div>
                </div>

                {/* Stats + actions */}
                <div style={{flexShrink:0,textAlign:'right'}}>
                  <div style={{display:'flex',gap:12,justifyContent:'flex-end',marginBottom:10}}>
                    <div>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Today</div>
                      <div style={{fontSize:14,fontWeight:700,color:k.uses_today>0?T.text:T.muted}}>{k.uses_today}</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Total</div>
                      <div style={{fontSize:14,fontWeight:700,color:T.text}}>{k.total_uses}</div>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Last used</div>
                      <div style={{fontSize:12,color:T.muted,fontFamily:'monospace'}}>{k.last_used?fmtAge(k.last_used):'never'}</div>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                    {!isRevoked&&<button onClick={()=>revokeKey(k)} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.amber}44`,background:`${T.amber}10`,color:T.amber,cursor:'pointer'}}>Revoke</button>}
                    {isRevoked&&<button onClick={()=>deleteKey(k)} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {filtered.length===0&&(
          <div style={{padding:'60px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:36,marginBottom:14}}>🔑</div>
            <div style={{fontSize:14,fontWeight:500,color:T.text,marginBottom:6}}>{filter==='revoked'?'No revoked keys':'No API keys yet'}</div>
            {filter==='all'&&<button onClick={()=>setCreate(true)} style={{padding:'8px 20px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Create first key</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOY HOOKS DATA
// (injected into AppDetailView Git tab — see APP_GIT extension below)
// ═══════════════════════════════════════════════════════════════════════════════

const DEPLOY_HOOKS_INIT = {
  'b1': [
    { id:'dh1', name:'production deploy', env:'production', branch:'main',   secret:'dhk_4pjM3K9vXz••••••••••••', secret_full:'dhk_4pjM3K9vXzQw8nR2sT6uY1bD5fH0cE7lA', url:'https://hub.acme.com/api/hooks/deploy/app-b1-prod-4pjM3K9v', created_at:Date.now()-86400000*10, last_used:Date.now()-14*60000, uses:7 },
    { id:'dh2', name:'staging deploy',    env:'staging',    branch:'staging', secret:'dhk_9kLmN2oP4q••••••••••••', secret_full:'dhk_9kLmN2oP4qRsT6uV8wXyZ0aB3cD5eF7g', url:'https://hub.acme.com/api/hooks/deploy/app-b1-stg-9kLmN2oP', created_at:Date.now()-86400000*8,  last_used:Date.now()-2*3600000,  uses:3 },
  ],
  'a1': [
    { id:'dh3', name:'production deploy', env:'production', branch:'main',   secret:'dhk_2bCdEfGhIj••••••••••••', secret_full:'dhk_2bCdEfGhIjKlMnOpQrStUvWxYz1A3B5C7D', url:'https://hub.acme.com/api/hooks/deploy/app-a1-prod-2bCdEfGh', created_at:Date.now()-86400000*5,  last_used:Date.now()-2*3600000,  uses:2 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBERS & ROLES
// ═══════════════════════════════════════════════════════════════════════════════

const ROLE_DEFS = [
  { id:'owner',     label:'Owner',     color:T.amber,  desc:'Full access. Can delete workspace, manage billing, promote admins.' },
  { id:'admin',     label:'Admin',     color:T.orange, desc:'Manage members, projects, servers. Cannot delete workspace.' },
  { id:'developer', label:'Developer', color:T.blue,   desc:'Deploy apps, manage projects they\'re assigned to. Cannot manage members.' },
  { id:'viewer',    label:'Viewer',    color:T.sec,    desc:'Read-only access. Cannot trigger deploys or modify anything.' },
];

const WS_MEMBERS_INIT = [
  { id:'u1',  name:'Sarah Chen',    email:'sarah@acme.com',   type:'human', role:'owner',     status:'active',   last:'2m ago',    avatar:'SC', joined:'Jan 12, 2024', invited_by:null },
  { id:'u5',  name:'Mike Torres',   email:'mike@acme.com',    type:'human', role:'admin',     status:'active',   last:'3h ago',    avatar:'MT', joined:'Jan 15, 2024', invited_by:'sarah@acme.com' },
  { id:'u2',  name:'James Okafor',  email:'james@acme.com',   type:'human', role:'developer', status:'active',   last:'1h ago',    avatar:'JO', joined:'Feb 1, 2024',  invited_by:'sarah@acme.com' },
  { id:'u3',  name:'ci-bot',        email:null,               type:'bot',   role:'developer', status:'active',   last:'3m ago',    avatar:'CI', joined:'Feb 5, 2024',  invited_by:'sarah@acme.com' },
  { id:'u4',  name:'deploy-agent',  email:null,               type:'ai',    role:'developer', status:'active',   last:'14m ago',   avatar:'DA', joined:'Apr 20, 2024', invited_by:'sarah@acme.com' },
  { id:'u10', name:'frontier-ai',   email:null,               type:'ai',    role:'developer', status:'active',   last:'just now',  avatar:'FA', joined:'May 1, 2024',  invited_by:'mike@acme.com' },
  { id:'u11', name:'alex@acme.com', email:'alex@acme.com',    type:'human', role:'viewer',    status:'pending',  last:'never',     avatar:'AL', joined:'—',            invited_by:'sarah@acme.com' },
];

function InviteMemberModal({ onClose, onInvite }) {
  const toast = useToast();
  const [email, setEmail]   = useState('');
  const [role, setRole]     = useState('developer');
  const [error, setError]   = useState('');

  const send = () => {
    if (!email.trim() || !email.includes('@')) { setError('Enter a valid email address'); return; }
    toast.success('Invitation sent', `${email} will receive an invite link.`);
    onInvite({ email, role });
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:460,overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>Invite member</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{padding:'20px 22px'}}>
          <Input label="Email address" value={email} onChange={e=>{setEmail(e.target.value);setError('');}} placeholder="teammate@company.com" type="email" error={error} hint="They'll receive an email with a link to join this workspace."/>

          <div style={{marginBottom:8}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Role</label>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {ROLE_DEFS.filter(r=>r.id!=='owner').map(r=>{
                const sel = role===r.id;
                return (
                  <button key={r.id} onClick={()=>setRole(r.id)} style={{display:'flex',alignItems:'flex-start',gap:12,padding:'10px 12px',borderRadius:7,border:`1px solid ${sel?r.color:T.border}`,background:sel?`${r.color}10`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                    <div style={{width:16,height:16,borderRadius:'50%',border:`1.5px solid ${sel?r.color:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                      {sel&&<div style={{width:7,height:7,borderRadius:'50%',background:r.color}}/>}
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:sel?600:500,color:sel?r.color:T.text,marginBottom:2}}>{r.label}</div>
                      <div style={{fontSize:11,color:T.sec}}>{r.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
          <button onClick={send} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Send invite</button>
        </div>
      </div>
    </div>
  );
}

function MembersView() {
  const toast = useToast();
  const [members, setMembers] = useState(WS_MEMBERS_INIT);
  const [showInvite, setShowInvite] = useState(false);
  const [filter, setFilter] = useState('all');

  const filtered = filter==='all' ? members : members.filter(m=>m.status===filter||m.type===filter);

  const changeRole = (id, newRole) => {
    const m = members.find(x=>x.id===id);
    if (m.role==='owner' && newRole!=='owner') { toast.error('Cannot demote owner','Transfer ownership first.'); return; }
    setMembers(ms=>ms.map(x=>x.id===id?{...x,role:newRole}:x));
    toast.success('Role updated', `${m.name} is now ${newRole}.`);
  };

  const removeMember = (m) => {
    if (m.role==='owner') { toast.error('Cannot remove owner','Transfer ownership before removing.'); return; }
    setMembers(ms=>ms.filter(x=>x.id!==m.id));
    toast.warning('Member removed', `${m.name} no longer has access.`);
  };

  const resendInvite = (m) => {
    toast.success('Invite resent', `New invite link sent to ${m.email}.`);
  };

  const uColor = t => ({human:T.blue,bot:T.cyan,ai:T.purple}[t]||T.muted);
  const roleColor = r => ROLE_DEFS.find(x=>x.id===r)?.color || T.sec;

  const counts = {
    active: members.filter(m=>m.status==='active').length,
    pending: members.filter(m=>m.status==='pending').length,
    human: members.filter(m=>m.type==='human').length,
    bot: members.filter(m=>m.type==='bot'||m.type==='ai').length,
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:900}}>
      {showInvite&&<InviteMemberModal onClose={()=>setShowInvite(false)} onInvite={({email,role})=>{
        setMembers(ms=>[...ms,{id:'u'+Date.now(),name:email,email,type:'human',role,status:'pending',last:'never',avatar:email.slice(0,2).toUpperCase(),joined:'—',invited_by:'sarah@acme.com'}]);
      }}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Members</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            {counts.active} active · {counts.pending} pending · {counts.bot} bots & agents
          </p>
        </div>
        <button onClick={()=>setShowInvite(true)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ Invite member
        </button>
      </div>

      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:22}}>
        <StatCard label="Active"    value={counts.active}  sub="can sign in"        color={T.green}/>
        <StatCard label="Pending"   value={counts.pending} sub="invite not accepted" color={counts.pending>0?T.amber:T.muted}/>
        <StatCard label="Humans"    value={counts.human}   sub="email accounts"      color={T.blue}/>
        <StatCard label="Bots & AI" value={counts.bot}     sub="automated actors"    color={T.purple}/>
      </div>

      {/* Role legend */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {ROLE_DEFS.map(r=>(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:5,background:T.elevated,border:`0.5px solid ${T.border}`}}>
            <div style={{width:7,height:7,borderRadius:'50%',background:r.color}}/>
            <span style={{fontSize:11,fontWeight:500,color:r.color}}>{r.label}</span>
            <span style={{fontSize:11,color:T.muted}}>—</span>
            <span style={{fontSize:11,color:T.muted}}>{r.desc.split('.')[0]}</span>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div style={{display:'flex',gap:3,marginBottom:18,background:T.elevated,borderRadius:7,padding:3,width:'fit-content'}}>
        {[['all','All'],['active','Active'],['pending','Pending'],['bot','Bots & AI']].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{padding:'5px 14px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===v?500:400,background:filter===v?T.card:'transparent',color:filter===v?T.text:T.sec}}>{l}</button>
        ))}
      </div>

      {/* Member list */}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {filtered.map(m=>{
          const isPending = m.status==='pending';
          const isOwner   = m.role==='owner';
          const rc        = roleColor(m.role);
          return (
            <div key={m.id} style={{background:T.card,border:`0.5px solid ${isPending?T.amber+'33':T.border}`,borderRadius:9,padding:'14px 20px',display:'flex',alignItems:'center',gap:14,opacity:isPending?0.85:1}}>
              {/* Avatar */}
              <div style={{width:40,height:40,borderRadius:'50%',background:uColor(m.type),display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,color:'#fff',fontWeight:700,flexShrink:0,position:'relative'}}>
                {m.avatar}
                {isPending&&<div style={{position:'absolute',bottom:-2,right:-2,width:12,height:12,borderRadius:'50%',background:T.amber,border:`1.5px solid ${T.card}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:7,color:'#fff'}}>?</div>}
              </div>

              {/* Name + email */}
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                  <span style={{fontSize:14,fontWeight:600,color:T.text}}>{m.name}</span>
                  <Pill label={m.type} color={uColor(m.type)}/>
                  {isPending&&<Pill label="invite pending" color={T.amber}/>}
                </div>
                <div style={{fontSize:12,color:T.muted}}>{m.email||'no email'} · joined {m.joined}{m.invited_by?` · invited by ${m.invited_by}`:''}</div>
              </div>

              {/* Last active */}
              <div style={{textAlign:'center',minWidth:80,flexShrink:0}}>
                <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Last active</div>
                <div style={{fontSize:12,color:T.muted,fontFamily:'monospace'}}>{m.last}</div>
              </div>

              {/* Role selector */}
              <div style={{flexShrink:0}}>
                {isOwner ? (
                  <div style={{padding:'5px 12px',borderRadius:5,background:`${rc}15`,border:`1px solid ${rc}44`,fontSize:12,fontWeight:600,color:rc}}>Owner</div>
                ) : (
                  <select
                    value={m.role}
                    onChange={e=>changeRole(m.id,e.target.value)}
                    style={{background:T.elevated,border:`0.5px solid ${rc}55`,borderRadius:6,padding:'5px 10px',fontSize:12,color:rc,fontWeight:500,outline:'none',cursor:'pointer'}}
                  >
                    {ROLE_DEFS.filter(r=>r.id!=='owner').map(r=>(
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Actions */}
              <div style={{display:'flex',gap:6,flexShrink:0}}>
                {isPending&&<button onClick={()=>resendInvite(m)} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer',whiteSpace:'nowrap'}}>Resend</button>}
                {!isOwner&&<button onClick={()=>removeMember(m)} style={{fontSize:11,padding:'4px 10px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer',whiteSpace:'nowrap'}}>{isPending?'Cancel':'Remove'}</button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Permissions matrix */}
      <div style={{marginTop:28}}>
        <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>Permission matrix</div>
        <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,overflow:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead>
              <tr style={{borderBottom:`0.5px solid ${T.borderMd}`}}>
                <th style={{padding:'10px 16px',textAlign:'left',color:T.sec,fontWeight:500,width:220}}>Permission</th>
                {ROLE_DEFS.map(r=><th key={r.id} style={{padding:'10px 16px',textAlign:'center',color:r.color,fontWeight:600}}>{r.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[
                ['View servers & apps',      true,  true,  true,  true],
                ['Trigger deploys',          false, true,  true,  false],
                ['Manage servers',           false, true,  true,  false],
                ['Manage SSH & API keys',    false, true,  true,  false],
                ['Invite members',           false, true,  false, false],
                ['Change member roles',      false, true,  false, false],
                ['Manage alert rules',       false, true,  true,  false],
                ['Access sysadmin',          false, false, false, false],
                ['Delete workspace',         true,  false, false, false],
                ['Manage billing & plan',    true,  false, false, false],
              ].map(([perm,...roles])=>(
                <tr key={perm} style={{borderBottom:`0.5px solid ${T.border}`}}>
                  <td style={{padding:'9px 16px',color:T.sec,fontSize:12}}>{perm}</td>
                  {roles.map((allowed,i)=>(
                    <td key={i} style={{padding:'9px 16px',textAlign:'center'}}>
                      {allowed
                        ? <span style={{color:T.green,fontSize:14}}>✓</span>
                        : <span style={{color:T.muted,fontSize:14}}>—</span>
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY FEED
// ═══════════════════════════════════════════════════════════════════════════════

const ACTIVITY_EVENTS = [
  // Deployments
  { id:'ev1',  kind:'deploy',    icon:'🚀', color:T.blue,   actor:'ci-bot',      atype:'bot',   title:'dashboard/web deployed to staging',           detail:'v2.14.2-rc · b7d8e02 · 2m 14s',      ts:Date.now()-3*60000,      link:'deployments' },
  { id:'ev2',  kind:'deploy',    icon:'🚀', color:T.green,  actor:'sarah',       atype:'human', title:'dashboard/web deployed to production',         detail:'v2.14.1 · a3f2c91 · 2m 14s',          ts:Date.now()-14*60000,     link:'deployments' },
  // Alerts
  { id:'ev3',  kind:'alert',     icon:'▲',  color:T.red,    actor:'system',      atype:'system',title:'prod-gateway-01 unreachable',                  detail:'Alert: agent heartbeat timeout (240s)', ts:Date.now()-4*60000,      link:'alert-rules' },
  { id:'ev4',  kind:'alert',     icon:'▲',  color:T.amber,  actor:'system',      atype:'system',title:'prod-db-01 memory at 88%',                    detail:'Alert: memory > 85% for 5 min',        ts:Date.now()-12*60000,     link:'alert-rules' },
  // Server actions
  { id:'ev5',  kind:'server',    icon:'⚙',  color:T.amber,  actor:'james',       atype:'human', title:'prod-worker-01 drained',                       detail:'Server entering drain mode',           ts:Date.now()-39*60000,     link:'servers' },
  { id:'ev6',  kind:'server',    icon:'⚙',  color:T.cyan,   actor:'system',      atype:'system',title:'prod-web-01 heartbeat received',               detail:'cpu:23% mem:61% — agent v1.2.3',       ts:Date.now()-12000,        link:'servers' },
  // Jobs
  { id:'ev7',  kind:'job',       icon:'⚡', color:T.purple, actor:'frontier-ai', atype:'ai',    title:'index-sync job triggered',                     detail:'Scheduled: 0 */4 * * *',               ts:Date.now()-4*3600000,    link:'jobs' },
  { id:'ev8',  kind:'job',       icon:'⚡', color:T.red,    actor:'ci-bot',      atype:'bot',   title:'index-sync job failed',                        detail:'Exit code 1 — connection refused',      ts:Date.now()-4*3600000+2000,link:'jobs' },
  { id:'ev9',  kind:'job',       icon:'⚡', color:T.green,  actor:'ci-bot',      atype:'bot',   title:'db-backup completed',                          detail:'Duration: 4m 12s · size: 1.8 GB',      ts:Date.now()-2*3600000,    link:'jobs' },
  // Members
  { id:'ev10', kind:'member',    icon:'👤', color:T.blue,   actor:'sarah',       atype:'human', title:'james@acme.com invited',                       detail:'Role: developer',                      ts:Date.now()-86400000*10,  link:'members' },
  { id:'ev11', kind:'member',    icon:'👤', color:T.blue,   actor:'sarah',       atype:'human', title:'alex@acme.com invite sent',                    detail:'Role: viewer · pending acceptance',     ts:Date.now()-86400000*2,   link:'members' },
  // Git / deploy hooks
  { id:'ev12', kind:'git',       icon:'🗂', color:T.cyan,   actor:'ci-bot',      atype:'bot',   title:'Push to dashboard/main',                       detail:'feat: add dark mode toggle · b7d8e02',  ts:Date.now()-3*60000,      link:'projects' },
  { id:'ev13', kind:'git',       icon:'🗂', color:T.cyan,   actor:'ci-bot',      atype:'bot',   title:'Push to api-gateway/main',                     detail:'fix: rate limit header handling · c4a1d',ts:Date.now()-2*3600000,   link:'projects' },
  // SSH / API keys
  { id:'ev14', kind:'key',       icon:'🔑', color:T.sec,    actor:'sarah',       atype:'human', title:'API key created: GitHub Actions deploy',       detail:'Scopes: deployments:write, projects:read',ts:Date.now()-86400000*5, link:'api-keys' },
  { id:'ev15', kind:'key',       icon:'🔑', color:T.sec,    actor:'james',       atype:'human', title:'SSH key added: james-personal',                detail:'ed25519 · 2 servers',                   ts:Date.now()-86400000*20,  link:'ssh-keys' },
  // Portal / config
  { id:'ev16', kind:'config',    icon:'⚙',  color:T.muted,  actor:'sarah',       atype:'human', title:'Infisical secrets adapter configured',          detail:'INFISICAL_URL set and verified',        ts:Date.now()-86400000*5,   link:'portal' },
  { id:'ev17', kind:'config',    icon:'⚙',  color:T.muted,  actor:'sarah',       atype:'human', title:'Alert rule created: DB memory high',           detail:'Warning · prod-db-01 · mem > 85%',       ts:Date.now()-86400000*3,   link:'alert-rules' },
  // Provision
  { id:'ev18', kind:'server',    icon:'⚡', color:T.green,  actor:'sarah',       atype:'human', title:'prod-web-01 provisioned',                      detail:'DigitalOcean nyc3 · 2 vCPU · 4 GB',     ts:Date.now()-86400000*45,  link:'servers' },
  { id:'ev19', kind:'deploy',    icon:'🚀', color:T.red,    actor:'ci-bot',      atype:'bot',   title:'data-pipeline/worker deploy failed',           detail:'v3.2.1 · secret mount error',           ts:Date.now()-86400000,     link:'deployments' },
  { id:'ev20', kind:'member',    icon:'👤', color:T.amber,  actor:'system',      atype:'system',title:'Redwood Co workspace suspended',               detail:'Admin action by sysadmin',              ts:Date.now()-86400000*14,  link:'sys-workspaces' },
];

const ACTIVITY_KINDS = [
  { id:'all',    label:'All' },
  { id:'deploy', label:'Deploys' },
  { id:'alert',  label:'Alerts' },
  { id:'server', label:'Servers' },
  { id:'job',    label:'Jobs' },
  { id:'git',    label:'Git' },
  { id:'member', label:'Members' },
  { id:'key',    label:'Keys' },
  { id:'config', label:'Config' },
];

function ActivityFeedView({ nav }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const events = ACTIVITY_EVENTS
    .filter(e => filter==='all' || e.kind===filter)
    .filter(e => !search || e.title.toLowerCase().includes(search.toLowerCase()) || e.actor.toLowerCase().includes(search.toLowerCase()) || e.detail.toLowerCase().includes(search.toLowerCase()));

  const uColor = t => ({human:T.blue,bot:T.cyan,ai:T.purple,system:T.muted}[t]||T.muted);

  // Group events by day
  const grouped = events.reduce((acc,ev)=>{
    const d = new Date(ev.ts);
    const now = new Date();
    let label;
    if (d.toDateString()===now.toDateString()) label='Today';
    else if (d.toDateString()===new Date(now-86400000).toDateString()) label='Yesterday';
    else label = d.toLocaleDateString('en-US',{month:'long',day:'numeric'});
    if (!acc[label]) acc[label]=[];
    acc[label].push(ev);
    return acc;
  },{});

  return (
    <div style={{padding:'28px 30px',maxWidth:900}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Activity</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Everything happening in Acme Corp · real-time via WebSocket</p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="Search activity…"
            style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'7px 12px',fontSize:12,color:T.text,outline:'none',width:200}}
            onFocus={e=>e.target.style.borderColor=T.blue}
            onBlur={e=>e.target.style.borderColor=T.borderMd}
          />
        </div>
      </div>

      {/* Kind filter */}
      <div style={{display:'flex',gap:3,marginBottom:22,flexWrap:'wrap'}}>
        {ACTIVITY_KINDS.map(k=>{
          const count = k.id==='all' ? ACTIVITY_EVENTS.length : ACTIVITY_EVENTS.filter(e=>e.kind===k.id).length;
          const active = filter===k.id;
          return (
            <button key={k.id} onClick={()=>setFilter(k.id)} style={{padding:'5px 12px',borderRadius:20,border:`0.5px solid ${active?T.blue:T.border}`,background:active?`${T.blue}15`:T.elevated,color:active?T.blue:T.sec,fontSize:11,fontWeight:active?600:400,cursor:'pointer',whiteSpace:'nowrap'}}>
              {k.label} <span style={{fontSize:10,color:active?T.blue:T.muted}}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Event stream */}
      {Object.entries(grouped).map(([day,dayEvents])=>(
        <div key={day} style={{marginBottom:24}}>
          {/* Day separator */}
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',whiteSpace:'nowrap'}}>{day}</div>
            <div style={{flex:1,height:'0.5px',background:T.border}}/>
            <div style={{fontSize:11,color:T.muted}}>{dayEvents.length} event{dayEvents.length!==1?'s':''}</div>
          </div>

          {/* Events */}
          <div style={{display:'flex',flexDirection:'column',gap:0,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
            {dayEvents.map((ev,i)=>(
              <div
                key={ev.id}
                onClick={()=>ev.link&&nav&&nav(ev.link)}
                style={{display:'flex',alignItems:'flex-start',gap:14,padding:'12px 18px',borderBottom:i<dayEvents.length-1?`0.5px solid ${T.border}`:'none',cursor:ev.link?'pointer':'default',transition:'background 0.1s'}}
                onMouseEnter={e=>ev.link&&(e.currentTarget.style.background=T.elevated)}
                onMouseLeave={e=>ev.link&&(e.currentTarget.style.background='transparent')}
              >
                {/* Timeline dot + icon */}
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:0,flexShrink:0,width:32}}>
                  <div style={{width:28,height:28,borderRadius:'50%',background:`${ev.color}15`,border:`1px solid ${ev.color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,flexShrink:0}}>
                    {ev.icon}
                  </div>
                </div>

                {/* Content */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:2,flexWrap:'wrap'}}>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>{ev.title}</span>
                  </div>
                  <div style={{fontSize:11,color:T.muted,lineHeight:'16px'}}>{ev.detail}</div>
                </div>

                {/* Actor */}
                <div style={{flexShrink:0,display:'flex',alignItems:'center',gap:7,minWidth:110,justifyContent:'flex-end'}}>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:11,fontWeight:500,color:T.sec}}>{ev.actor}</div>
                    <div style={{fontSize:10,color:T.muted,marginTop:1}}>{fmtAge(ev.ts)}</div>
                  </div>
                  <div style={{width:22,height:22,borderRadius:'50%',background:uColor(ev.atype),display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,color:'#fff',fontWeight:700,flexShrink:0}}>
                    {ev.actor.slice(0,2).toUpperCase()}
                  </div>
                </div>

                {/* Link arrow */}
                {ev.link&&<span style={{fontSize:12,color:T.muted,flexShrink:0,marginLeft:4,alignSelf:'center'}}>›</span>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {events.length===0&&(
        <div style={{padding:'60px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
          <div style={{fontSize:36,marginBottom:14}}>🔍</div>
          <div style={{fontSize:14,fontWeight:500,color:T.text,marginBottom:6}}>No matching events</div>
          <div style={{fontSize:12,color:T.sec}}>Try a different filter or search term.</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTAINER REGISTRY BROWSER
// ═══════════════════════════════════════════════════════════════════════════════

const REGISTRY_DATA = [
  {
    repo:'acme/dashboard', tags:[
      {tag:'v2.14.1',    digest:'sha256:a3f2c91b',size_mb:184,pushed:'14m ago',  by:'ci-bot',  inUse:true},
      {tag:'v2.14.0',    digest:'sha256:92e1b80c',size_mb:183,pushed:'1d ago',   by:'ci-bot',  inUse:false},
      {tag:'v2.13.9',    digest:'sha256:81d0a79d',size_mb:181,pushed:'3d ago',   by:'ci-bot',  inUse:false},
      {tag:'v2.13.8',    digest:'sha256:70c9b68e',size_mb:180,pushed:'7d ago',   by:'ci-bot',  inUse:false},
      {tag:'dev',        digest:'sha256:ff001122',size_mb:190,pushed:'2h ago',   by:'sarah',   inUse:true},
      {tag:'latest',     digest:'sha256:a3f2c91b',size_mb:184,pushed:'14m ago',  by:'ci-bot',  inUse:false},
    ],
    total_size_gb:1.1,
  },
  {
    repo:'acme/api-gateway', tags:[
      {tag:'v1.9.0',     digest:'sha256:c4a1d55f',size_mb:97, pushed:'2h ago',   by:'ci-bot',  inUse:true},
      {tag:'v1.8.5',     digest:'sha256:b3f0e44g',size_mb:96, pushed:'2d ago',   by:'ci-bot',  inUse:false},
      {tag:'v1.8.4',     digest:'sha256:a2e9d33h',size_mb:96, pushed:'3d ago',   by:'ci-bot',  inUse:false},
      {tag:'dev',        digest:'sha256:aa112233',size_mb:101,pushed:'6h ago',   by:'james',   inUse:true},
    ],
    total_size_gb:0.4,
  },
  {
    repo:'acme/data-pipeline', tags:[
      {tag:'v3.2.1',     digest:'sha256:d5b0c44i',size_mb:312,pushed:'1d ago',   by:'ci-bot',  inUse:true},
      {tag:'v3.2.0',     digest:'sha256:c4a9b33j',size_mb:310,pushed:'3d ago',   by:'ci-bot',  inUse:true},
      {tag:'dev',        digest:'sha256:bb223344',size_mb:320,pushed:'3d ago',   by:'sarah',   inUse:false},
    ],
    total_size_gb:0.9,
  },
  {
    repo:'acme/notifications', tags:[
      {tag:'v1.2.0',     digest:'sha256:e6c1d55k',size_mb:68, pushed:'5d ago',   by:'ci-bot',  inUse:true},
      {tag:'v1.1.9',     digest:'sha256:d5b0c44l',size_mb:67, pushed:'12d ago',  by:'ci-bot',  inUse:false},
    ],
    total_size_gb:0.1,
  },
];

function RegistryView() {
  const toast = useToast();
  const [repos, setRepos]     = useState(REGISTRY_DATA);
  const [expanded, setExpanded] = useState('acme/dashboard');
  const [search, setSearch]   = useState('');

  const totalGb = repos.reduce((a,r)=>a+r.total_size_gb,0);
  const totalTags = repos.reduce((a,r)=>a+r.tags.length,0);
  const inUse  = repos.reduce((a,r)=>a+r.tags.filter(t=>t.inUse).length,0);

  const deleteTag = (repo, tag) => {
    if (tag.inUse) { toast.warning('Tag in use',`${tag.tag} is referenced by a running container. Stop the app first.`); return; }
    setRepos(rs=>rs.map(r=>r.repo===repo?{...r,tags:r.tags.filter(t=>t.tag!==tag.tag)}:r));
    toast.success('Tag deleted',`${repo}:${tag.tag}`);
  };

  const pruneUnused = (repo) => {
    const r = repos.find(x=>x.repo===repo);
    const unused = r.tags.filter(t=>!t.inUse).length;
    if (unused===0) { toast.info('Nothing to prune','All tags in this repo are in use.'); return; }
    const t = toast.loading('Pruning…',`${repo} · ${unused} unused tag${unused!==1?'s':''}`);
    setTimeout(()=>{
      setRepos(rs=>rs.map(r=>r.repo===repo?{...r,tags:r.tags.filter(t=>t.inUse)}:r));
      t.update('success','Prune complete',`Removed ${unused} tag${unused!==1?'s':''} from ${repo}`);
    },1200);
  };

  const filteredRepos = repos.filter(r =>
    r.repo.toLowerCase().includes(search.toLowerCase()) ||
    r.tags.some(t=>t.tag.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Container Registry</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Zot OCI registry · {repos.length} repos · {totalTags} tags · {totalGb.toFixed(1)} GB total</p>
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search repos or tags…"
          style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'8px 14px',fontSize:12,color:T.text,outline:'none',width:220}}
          onFocus={e=>e.target.style.borderColor=T.blue} onBlur={e=>e.target.style.borderColor=T.borderMd}/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <StatCard label="Repositories" value={repos.length}            sub="image repos"/>
        <StatCard label="Total tags"   value={totalTags}               sub="across all repos"/>
        <StatCard label="In use"       value={inUse}                   sub="live containers"  color={T.green}/>
        <StatCard label="Total size"   value={totalGb.toFixed(1)+' GB'} sub="registry storage"/>
      </div>

      <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:8,padding:'10px 16px',marginBottom:20,display:'flex',alignItems:'center',gap:10}}>
        <span style={{color:T.amber}}>⚠</span>
        <span style={{fontSize:12,color:T.sec}}>Zot registry is in <strong style={{color:T.text}}>stub mode</strong> — configure <code style={{fontFamily:'monospace',color:T.amber}}>ZOT_URL</code> in Hub settings to activate real image push/pull.</span>
      </div>

      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {filteredRepos.map(repo=>{
          const isExp = expanded===repo.repo;
          const unused = repo.tags.filter(t=>!t.inUse).length;
          return (
            <div key={repo.repo} style={{background:T.card,border:`0.5px solid ${isExp?T.borderMd:T.border}`,borderRadius:9,overflow:'hidden'}}>
              <div onClick={()=>setExpanded(isExp?null:repo.repo)}
                style={{display:'flex',alignItems:'center',gap:14,padding:'14px 20px',cursor:'pointer'}}
                onMouseEnter={e=>!isExp&&(e.currentTarget.style.background=T.elevated)}
                onMouseLeave={e=>!isExp&&(e.currentTarget.style.background='transparent')}>
                <div style={{width:36,height:36,borderRadius:8,background:`${T.blue}15`,border:`1px solid ${T.blue}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,flexShrink:0}}>📦</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:600,color:T.blue,marginBottom:2}}>{repo.repo}</div>
                  <div style={{fontSize:11,color:T.muted}}>{repo.tags.length} tags · {repo.total_size_gb.toFixed(1)} GB · {repo.tags.filter(t=>t.inUse).length} in use</div>
                </div>
                {unused>0&&<Pill label={`${unused} unused`} color={T.amber}/>}
                <button onClick={e=>{e.stopPropagation();pruneUnused(repo.repo);}} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Prune unused</button>
                <span style={{color:T.muted,fontSize:12}}>{isExp?'▲':'▼'}</span>
              </div>

              {isExp&&(
                <div style={{borderTop:`0.5px solid ${T.border}`}}>
                  <div style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr 1fr 1fr auto',gap:0,fontSize:11,color:T.muted,padding:'8px 20px',background:T.elevated,borderBottom:`0.5px solid ${T.border}`}}>
                    <span style={{width:20}}></span>
                    <span>Tag</span><span>Digest</span><span>Size</span><span>Pushed</span><span></span>
                  </div>
                  {repo.tags.map((tag,i)=>(
                    <div key={tag.tag} style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr 1fr 1fr auto',gap:0,alignItems:'center',padding:'10px 20px',borderBottom:i<repo.tags.length-1?`0.5px solid ${T.border}`:'none',background:tag.inUse?`${T.green}05`:'transparent'}}>
                      <div style={{width:20}}>{tag.inUse&&<Dot color={T.green} size={6}/>}</div>
                      <div>
                        <code style={{fontSize:12,fontFamily:'monospace',fontWeight:600,color:T.text}}>{tag.tag}</code>
                        {tag.inUse&&<span style={{fontSize:9,marginLeft:6,padding:'1px 5px',borderRadius:3,background:`${T.green}18`,color:T.green,border:`0.5px solid ${T.green}33`}}>live</span>}
                      </div>
                      <div style={{fontFamily:'monospace',fontSize:11,color:T.muted}}>{tag.digest}</div>
                      <div style={{fontSize:12,color:T.sec}}>{tag.size_mb} MB</div>
                      <div style={{fontSize:12,color:T.muted}}>{tag.pushed} · {tag.by}</div>
                      <div style={{display:'flex',gap:6}}>
                        <button onClick={()=>{navigator.clipboard?.writeText(`zot.acme.com/${repo.repo}:${tag.tag}`).catch(()=>{});toast.success('Copied',`${repo.repo}:${tag.tag}`);}} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Copy ref</button>
                        <button onClick={()=>deleteTag(repo.repo,tag)} style={{fontSize:10,padding:'3px 8px',borderRadius:4,border:`0.5px solid ${tag.inUse?T.muted+'33':T.red+'33'}`,background:'none',color:tag.inUse?T.muted:T.red,cursor:tag.inUse?'not-allowed':'pointer'}}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const VOLUMES_DATA = [
  {id:'v1',name:'postgres-data',      server:'prod-db-01',     driver:'local',size_gb:14.2,mountpoint:'/var/lib/docker/volumes/postgres-data/_data',  inUse:true,  containers:['postgres-primary'],  created:'45d ago'},
  {id:'v2',name:'redis-data',         server:'prod-db-01',     driver:'local',size_gb:0.3, mountpoint:'/var/lib/docker/volumes/redis-data/_data',      inUse:true,  containers:['redis-cache'],        created:'45d ago'},
  {id:'v3',name:'pipeline-data',      server:'prod-worker-01', driver:'local',size_gb:8.6, mountpoint:'/var/lib/docker/volumes/pipeline-data/_data',   inUse:true,  containers:['data-pipeline-worker-1'],created:'30d ago'},
  {id:'v4',name:'nginx-certs',        server:'prod-web-01',    driver:'local',size_gb:0.01,mountpoint:'/var/lib/docker/volumes/nginx-certs/_data',     inUse:true,  containers:['nginx-proxy'],        created:'44d ago'},
  {id:'v5',name:'nginx-certs',        server:'prod-web-02',    driver:'local',size_gb:0.01,mountpoint:'/var/lib/docker/volumes/nginx-certs/_data',     inUse:true,  containers:['nginx-proxy'],        created:'44d ago'},
  {id:'v6',name:'build-cache',        server:'build-runner-01',driver:'local',size_gb:4.1, mountpoint:'/var/lib/docker/volumes/build-cache/_data',     inUse:false, containers:[],                    created:'20d ago'},
  {id:'v7',name:'old-backup-scratch', server:'prod-worker-01', driver:'local',size_gb:2.3, mountpoint:'/var/lib/docker/volumes/old-backup-scratch/_data',inUse:false,containers:[],                   created:'60d ago'},
  {id:'v8',name:'stg-postgres',       server:'stg-app-01',     driver:'local',size_gb:1.2, mountpoint:'/var/lib/docker/volumes/stg-postgres/_data',    inUse:true,  containers:['postgres-stg'],       created:'28d ago'},
];

function VolumesView() {
  const toast = useToast();
  const [volumes, setVolumes] = useState(VOLUMES_DATA);
  const [filter, setFilter]   = useState('all');
  const [server, setServer]   = useState('all');

  const servers = [...new Set(volumes.map(v=>v.server))];
  const filtered = volumes
    .filter(v => filter==='all' ? true : filter==='unused' ? !v.inUse : v.inUse)
    .filter(v => server==='all' ? true : v.server===server);

  const totalGb = volumes.reduce((a,v)=>a+v.size_gb,0);
  const unusedGb = volumes.filter(v=>!v.inUse).reduce((a,v)=>a+v.size_gb,0);

  const deleteVolume = v => {
    if (v.inUse) { toast.error('Volume in use',`${v.name} is mounted by ${v.containers.join(', ')}. Stop the container first.`); return; }
    setVolumes(vs=>vs.filter(x=>x.id!==v.id));
    toast.success('Volume deleted',`${v.name} on ${v.server} · freed ${v.size_gb} GB`);
  };

  const pruneAll = () => {
    const unused = volumes.filter(v=>!v.inUse);
    if (unused.length===0) { toast.info('Nothing to prune','All volumes are in use.'); return; }
    const freed = unused.reduce((a,v)=>a+v.size_gb,0);
    const t = toast.loading('Pruning unused volumes…',`${unused.length} volumes · ${freed.toFixed(1)} GB`);
    setTimeout(()=>{
      setVolumes(vs=>vs.filter(v=>v.inUse));
      t.update('success','Prune complete',`Freed ${freed.toFixed(1)} GB across ${unused.length} volumes`);
    },1500);
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Volumes</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Persistent Docker volumes across the fleet · {totalGb.toFixed(1)} GB total</p>
        </div>
        <button onClick={pruneAll} style={{padding:'9px 16px',borderRadius:7,border:`0.5px solid ${T.amber}44`,background:`${T.amber}10`,color:T.amber,fontSize:13,fontWeight:600,cursor:'pointer'}}>
          🗑 Prune unused
        </button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:22}}>
        <StatCard label="Total volumes" value={volumes.length}         sub="across all servers"/>
        <StatCard label="In use"        value={volumes.filter(v=>v.inUse).length} sub="mounted containers" color={T.green}/>
        <StatCard label="Unused"        value={volumes.filter(v=>!v.inUse).length} sub={unusedGb.toFixed(1)+' GB reclaimable'} color={unusedGb>0?T.amber:T.muted}/>
        <StatCard label="Total storage" value={totalGb.toFixed(1)+' GB'} sub="across fleet"/>
      </div>

      {/* Filters */}
      <div style={{display:'flex',gap:10,marginBottom:18,alignItems:'center'}}>
        <div style={{display:'flex',gap:2,background:T.elevated,borderRadius:7,padding:3}}>
          {[['all','All'],['used','In use'],['unused','Unused']].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{padding:'5px 13px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filter===v?500:400,background:filter===v?T.card:'transparent',color:filter===v?T.text:T.sec}}>{l}</button>
          ))}
        </div>
        <select value={server} onChange={e=>setServer(e.target.value)} style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'7px 12px',fontSize:12,color:T.text,outline:'none',cursor:'pointer'}}>
          <option value="all">All servers</option>
          {servers.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {filtered.map(v=>(
          <div key={v.id} style={{background:T.card,border:`0.5px solid ${!v.inUse?T.amber+'33':T.border}`,borderRadius:9,padding:'14px 20px',display:'flex',alignItems:'center',gap:14}}>
            <div style={{width:36,height:36,borderRadius:8,background:v.inUse?`${T.green}12`:`${T.amber}12`,border:`1px solid ${v.inUse?T.green+'33':T.amber+'33'}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
              {v.inUse?'💾':'🗑'}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <span style={{fontSize:14,fontWeight:600,color:T.text}}>{v.name}</span>
                <Pill label={v.inUse?'in use':'unused'} color={v.inUse?T.green:T.amber}/>
              </div>
              <div style={{fontSize:11,color:T.muted,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:4}}>{v.mountpoint}</div>
              {v.inUse&&v.containers.length>0&&(
                <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                  {v.containers.map(c=>(
                    <div key={c} style={{display:'flex',alignItems:'center',gap:4,padding:'2px 7px',borderRadius:4,background:T.elevated,border:`0.5px solid ${T.border}`}}>
                      <Dot color={T.green} size={5}/>
                      <span style={{fontSize:10,color:T.sec,fontFamily:'monospace'}}>{c}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{textAlign:'center',minWidth:80,flexShrink:0}}>
              <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Server</div>
              <div style={{fontSize:11,color:T.sec,fontFamily:'monospace'}}>{v.server}</div>
            </div>
            <div style={{textAlign:'center',minWidth:70,flexShrink:0}}>
              <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Size</div>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>{v.size_gb<1?(v.size_gb*1024).toFixed(0)+' MB':v.size_gb.toFixed(1)+' GB'}</div>
            </div>
            <div style={{textAlign:'center',minWidth:60,flexShrink:0}}>
              <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:3}}>Created</div>
              <div style={{fontSize:11,color:T.muted}}>{v.created}</div>
            </div>
            <div style={{flexShrink:0}}>
              <button onClick={()=>deleteVolume(v)} style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${v.inUse?T.muted+'33':T.red+'44'}`,background:v.inUse?'none':`${T.red}08`,color:v.inUse?T.muted:T.red,cursor:v.inUse?'not-allowed':'pointer',fontWeight:500}}>
                {v.inUse?'In use':'Delete'}
              </button>
            </div>
          </div>
        ))}
        {filtered.length===0&&(
          <div style={{padding:'40px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:32,marginBottom:10}}>💾</div>
            <div style={{fontSize:13,color:T.sec}}>No volumes match the current filter.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING — FIRST-RUN SETUP WIZARD + EMPTY STATES
// ═══════════════════════════════════════════════════════════════════════════════

const ONBOARDING_STEPS = [
  { id:'workspace', icon:'🏢', title:'Create workspace',      desc:'Your workspace is ready.',                                     done:true  },
  { id:'server',    icon:'🖥', title:'Add your first server',  desc:'Provision or import a machine into the fleet.',               done:false },
  { id:'ssh-key',   icon:'🔑', title:'Add an SSH key',         desc:'Upload a public key to install on servers.',                  done:false },
  { id:'project',   icon:'◫', title:'Create a project',        desc:'Organize apps and deployments into a project.',               done:false },
  { id:'deploy',    icon:'🚀', title:'Deploy an app',           desc:'Point an image at an environment and deploy.',               done:false },
  { id:'team',      icon:'👥', title:'Invite a teammate',       desc:'Add a developer, admin, or viewer to your workspace.',       done:false },
];

function OnboardingView({ nav }) {
  const [steps, setSteps] = useState(ONBOARDING_STEPS);
  const toast = useToast();
  const done  = steps.filter(s=>s.done).length;
  const pct   = Math.round((done/steps.length)*100);

  const completeStep = id => {
    setSteps(ss=>ss.map(s=>s.id===id?{...s,done:true}:s));
    toast.success('Step completed!','');
  };

  const STEP_ACTIONS = {
    server:   { label:'Provision a server',  fn:()=>nav('provision') },
    'ssh-key':{ label:'Add SSH key',         fn:()=>nav('ssh-keys') },
    project:  { label:'Create project',      fn:()=>nav('projects') },
    deploy:   { label:'Go to projects',      fn:()=>nav('projects') },
    team:     { label:'Invite member',       fn:()=>nav('members') },
  };

  return (
    <div style={{padding:'48px 30px',maxWidth:700,margin:'0 auto'}}>
      {/* Header */}
      <div style={{textAlign:'center',marginBottom:40}}>
        <div style={{fontSize:40,marginBottom:16}}>🚀</div>
        <h1 style={{margin:0,fontSize:26,fontWeight:800,color:T.text,letterSpacing:'-0.03em',marginBottom:10}}>
          Welcome to Platform Hub
        </h1>
        <p style={{fontSize:14,color:T.sec,lineHeight:'22px',maxWidth:480,margin:'0 auto 24px'}}>
          Your infrastructure control plane is ready. Complete a few steps to go from zero to a working deployment.
        </p>

        {/* Progress bar */}
        <div style={{display:'flex',alignItems:'center',gap:12,maxWidth:400,margin:'0 auto'}}>
          <div style={{flex:1,height:6,background:T.elevated,borderRadius:3,overflow:'hidden'}}>
            <div style={{height:'100%',width:`${pct}%`,background:pct===100?T.green:T.blue,borderRadius:3,transition:'width 0.4s ease'}}/>
          </div>
          <span style={{fontSize:13,color:T.sec,whiteSpace:'nowrap',fontWeight:500}}>{done} / {steps.length}</span>
        </div>
        {pct===100&&<div style={{marginTop:12,fontSize:14,color:T.green,fontWeight:600}}>🎉 You're all set! Head to the Basecamp.</div>}
      </div>

      {/* Steps */}
      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        {steps.map((step,i)=>{
          const action = STEP_ACTIONS[step.id];
          const isNext = !step.done && steps.slice(0,i).every(s=>s.done);
          return (
            <div key={step.id} style={{
              background:T.card,
              border:`0.5px solid ${step.done?T.green+'33':isNext?T.blue+'44':T.border}`,
              borderRadius:10,
              padding:'16px 20px',
              display:'flex',
              alignItems:'center',
              gap:16,
              opacity:!step.done&&!isNext&&i>0?0.5:1,
              transition:'opacity 0.2s',
            }}>
              {/* Status icon */}
              <div style={{
                width:40,height:40,borderRadius:'50%',flexShrink:0,
                background:step.done?`${T.green}18`:isNext?`${T.blue}15`:T.elevated,
                border:`1.5px solid ${step.done?T.green:isNext?T.blue:T.border}`,
                display:'flex',alignItems:'center',justifyContent:'center',fontSize:step.done?16:20,
              }}>
                {step.done ? <span style={{color:T.green,fontWeight:700,fontSize:18}}>✓</span> : step.icon}
              </div>

              {/* Content */}
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:600,color:step.done?T.sec:T.text,textDecoration:step.done?'line-through':'none',marginBottom:3}}>
                  {step.title}
                </div>
                <div style={{fontSize:12,color:T.muted}}>{step.desc}</div>
              </div>

              {/* Action */}
              {!step.done && action && (
                <button
                  onClick={()=>{ action.fn(); completeStep(step.id); }}
                  style={{
                    padding:'8px 18px',borderRadius:7,border:'none',
                    background:isNext?T.blue:T.elevated,
                    color:isNext?'#fff':T.sec,
                    fontSize:12,fontWeight:isNext?600:400,
                    cursor:'pointer',flexShrink:0,
                  }}>
                  {action.label} →
                </button>
              )}
              {step.done&&<span style={{fontSize:12,color:T.green,flexShrink:0}}>Done</span>}
            </div>
          );
        })}
      </div>

      {/* Skip link */}
      <div style={{textAlign:'center',marginTop:24}}>
        <button onClick={()=>nav('basecamp')} style={{background:'none',border:'none',fontSize:12,color:T.muted,cursor:'pointer',textDecoration:'underline'}}>
          Skip setup — go to Basecamp
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARDS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Widget type definitions ──────────────────────────────────────────────────
const WIDGET_TYPES = [
  { id:'servers-grid',    icon:'▣',  label:'Server grid',       desc:'Fleet status at a glance — all servers with health dots.',    defaultCols:3, defaultRows:1 },
  { id:'server-health',   icon:'🖥', label:'Server health',     desc:'CPU, memory, disk bars for a single server.',                defaultCols:1, defaultRows:1 },
  { id:'deploy-feed',     icon:'🚀', label:'Deploy feed',       desc:'Recent deployments for a project or all projects.',          defaultCols:2, defaultRows:1 },
  { id:'alert-status',    icon:'▲',  label:'Alert status',      desc:'Currently firing alert rules at a glance.',                  defaultCols:1, defaultRows:1 },
  { id:'app-status',      icon:'📦', label:'App status',        desc:'Single app — status, uptime, CPU/mem, quick deploy.',        defaultCols:1, defaultRows:1 },
  { id:'job-history',     icon:'⚡', label:'Job history',       desc:'Recent job runs with status and duration.',                  defaultCols:2, defaultRows:1 },
  { id:'activity-mini',   icon:'◎',  label:'Activity feed',     desc:'Live workspace event stream — last 5 events.',               defaultCols:1, defaultRows:1 },
  { id:'portal-service',  icon:'⬡',  label:'Service health',    desc:'Single internal service — latency, status, sparkline.',      defaultCols:1, defaultRows:1 },
  { id:'stat-counter',    icon:'#',  label:'Stat counter',      desc:'A single big number — custom label and value source.',       defaultCols:1, defaultRows:1 },
];

// ─── Default dashboard data ───────────────────────────────────────────────────
const DASHBOARDS_INIT = [
  {
    id:'db1', name:'Ops Overview', description:'Production health at a glance',
    icon:'🏢', color:T.blue, pinned:true,
    widgets:[
      { id:'w1', type:'servers-grid',   cols:3, config:{} },
      { id:'w2', type:'alert-status',   cols:1, config:{} },
      { id:'w3', type:'deploy-feed',    cols:2, config:{ project:'all' } },
      { id:'w4', type:'server-health',  cols:1, config:{ serverId:'s1', serverName:'prod-web-01' } },
      { id:'w5', type:'server-health',  cols:1, config:{ serverId:'s3', serverName:'prod-db-01' } },
      { id:'w6', type:'job-history',    cols:2, config:{} },
    ],
  },
  {
    id:'db2', name:'My Apps', description:'Dashboard/web and API gateway status',
    icon:'📦', color:T.green, pinned:false,
    widgets:[
      { id:'w7',  type:'app-status',    cols:1, config:{ appId:'b1', appName:'dashboard/web', env:'production' } },
      { id:'w8',  type:'app-status',    cols:1, config:{ appId:'a1', appName:'api-gateway/router', env:'production' } },
      { id:'w9',  type:'deploy-feed',   cols:2, config:{ project:'dashboard' } },
      { id:'w10', type:'activity-mini', cols:1, config:{ kind:'deploy' } },
      { id:'w11', type:'alert-status',  cols:1, config:{} },
      { id:'w12', type:'portal-service',cols:1, config:{ serviceId:'grafana', serviceName:'Grafana' } },
      { id:'w13', type:'stat-counter',  cols:1, config:{ label:'Active servers', value:'6', sub:'of 8 fleet', color:T.green } },
    ],
  },
  {
    id:'db3', name:'Infra Health', description:'Servers, services, and network',
    icon:'⬡', color:T.cyan, pinned:false,
    widgets:[
      { id:'w14', type:'servers-grid',   cols:3, config:{} },
      { id:'w15', type:'portal-service', cols:1, config:{ serviceId:'valkey',   serviceName:'Valkey'   } },
      { id:'w16', type:'portal-service', cols:1, config:{ serviceId:'typesense',serviceName:'Typesense'} },
      { id:'w17', type:'portal-service', cols:1, config:{ serviceId:'grafana',  serviceName:'Grafana'  } },
      { id:'w18', type:'job-history',    cols:2, config:{} },
      { id:'w19', type:'stat-counter',   cols:1, config:{ label:'Mesh peers online', value:'7', sub:'of 9 peers', color:T.green } },
    ],
  },
];

// ─── Individual widget renderers ──────────────────────────────────────────────
function DashWidget({ widget, onRemove, onEdit, nav }) {
  const { type, config } = widget;
  const [tick, setTick] = useState(0);
  useEffect(()=>{const t=setInterval(()=>setTick(n=>n+1),4000);return()=>clearInterval(t);},[]);
  const jitter=(b,r)=>Math.max(0,Math.min(100,Math.round(b+(Math.random()-0.5)*r)));

  const WrapCard = ({children, title, action}) => (
    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'100%',display:'flex',flexDirection:'column'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px 8px',borderBottom:`0.5px solid ${T.border}`,flexShrink:0}}>
        <span style={{fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em'}}>{title}</span>
        <div style={{display:'flex',gap:5,alignItems:'center'}}>
          {action}
          <button onClick={onEdit} style={{fontSize:10,padding:'1px 6px',borderRadius:3,border:`0.5px solid ${T.border}`,background:'none',color:T.muted,cursor:'pointer',lineHeight:'16px'}}>⚙</button>
          <button onClick={onRemove} style={{fontSize:10,padding:'1px 5px',borderRadius:3,border:'none',background:'none',color:T.muted,cursor:'pointer',lineHeight:'16px'}}>✕</button>
        </div>
      </div>
      <div style={{flex:1,overflow:'hidden',padding:'12px 14px'}}>{children}</div>
    </div>
  );

  if (type==='servers-grid') {
    return (
      <WrapCard title="Server fleet">
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
          {SERVERS.map(s=>{
            const cpu = jitter(s.cpu, 8);
            const sc  = s.status==='online'?T.green:s.status==='draining'?T.amber:s.status==='unreachable'?T.red:T.muted;
            return (
              <div key={s.id} onClick={()=>nav&&nav('servers')} style={{background:T.elevated,borderRadius:7,padding:'10px 10px 8px',border:`0.5px solid ${sc}33`,cursor:'pointer'}}>
                <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
                  <Dot color={sc} size={6}/>
                  <span style={{fontSize:10,fontWeight:600,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name.replace('prod-','').replace('-0','')}</span>
                </div>
                <div style={{height:3,background:T.border,borderRadius:2,overflow:'hidden',marginBottom:3}}>
                  <div style={{height:'100%',width:`${cpu}%`,background:cpu>80?T.red:cpu>60?T.amber:T.green,borderRadius:2,transition:'width 0.6s'}}/>
                </div>
                <div style={{fontSize:9,color:T.muted}}>{cpu}% CPU</div>
              </div>
            );
          })}
        </div>
      </WrapCard>
    );
  }

  if (type==='server-health') {
    const s = SERVERS.find(x=>x.id===config.serverId) || SERVERS[0];
    const cpu = jitter(s.cpu, 10);
    const mem = jitter(s.mem, 8);
    const statusC = s.status==='online'?T.green:s.status==='draining'?T.amber:T.red;
    return (
      <WrapCard title={config.serverName||s.name}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12}}>
          <Dot color={statusC} size={7}/>
          <span style={{fontSize:12,color:statusC,fontWeight:500}}>{s.status}</span>
          <span style={{fontSize:11,color:T.muted,marginLeft:'auto',fontFamily:'monospace'}}>{s.ip}</span>
        </div>
        {[['CPU',cpu],['Memory',mem],['Disk',jitter(42,5)]].map(([label,val])=>(
          <div key={label} style={{marginBottom:8}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:T.muted,marginBottom:3}}>
              <span>{label}</span><span style={{color:val>80?T.red:val>60?T.amber:T.green}}>{val}%</span>
            </div>
            <div style={{height:4,background:T.elevated,borderRadius:2,overflow:'hidden'}}>
              <div style={{height:'100%',width:`${val}%`,background:val>80?T.red:val>60?T.amber:T.green,borderRadius:2,transition:'width 0.6s'}}/>
            </div>
          </div>
        ))}
        <div style={{display:'flex',gap:8,marginTop:6}}>
          <div style={{flex:1,background:T.elevated,borderRadius:5,padding:'5px 8px',textAlign:'center'}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Region</div>
            <div style={{fontSize:10,color:T.sec}}>{s.region}</div>
          </div>
          <div style={{flex:1,background:T.elevated,borderRadius:5,padding:'5px 8px',textAlign:'center'}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Role</div>
            <div style={{fontSize:10,color:T.sec}}>{s.role}</div>
          </div>
        </div>
      </WrapCard>
    );
  }

  if (type==='deploy-feed') {
    const deploys = DEPLOYMENTS.filter(d=>config.project==='all'||d.project===config.project).slice(0,5);
    return (
      <WrapCard title={config.project==='all'?'All deployments':`${config.project} — deploys`}
        action={<button onClick={()=>nav&&nav('deployments')} style={{fontSize:10,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>View all →</button>}>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {deploys.map((d,i)=>(
            <div key={d.id} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:i<deploys.length-1?`0.5px solid ${T.border}`:'none'}}>
              <Dot color={dColor(d.status)} size={6}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.project}/{d.app}</div>
                <div style={{fontSize:10,color:T.muted}}>{d.env} · {d.version}</div>
              </div>
              <div style={{fontSize:10,color:T.muted,flexShrink:0}}>{d.time}</div>
            </div>
          ))}
          {deploys.length===0&&<div style={{fontSize:12,color:T.muted,padding:'8px 0'}}>No recent deployments.</div>}
        </div>
      </WrapCard>
    );
  }

  if (type==='alert-status') {
    const firing = ALERT_RULES_INIT.filter(r=>r.state==='firing');
    return (
      <WrapCard title="Alerts"
        action={<button onClick={()=>nav&&nav('alert-rules')} style={{fontSize:10,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>Manage →</button>}>
        {firing.length===0 ? (
          <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'12px 0',gap:8}}>
            <span style={{fontSize:26}}>✓</span>
            <span style={{fontSize:12,color:T.green,fontWeight:500}}>All clear</span>
            <span style={{fontSize:11,color:T.muted}}>No alerts firing</span>
          </div>
        ) : (
          <div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,padding:'8px 10px',background:`${T.red}10`,borderRadius:6,border:`0.5px solid ${T.red}33`}}>
              <span style={{fontSize:18,color:T.red}}>▲</span>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:T.red}}>{firing.length} firing</div>
                <div style={{fontSize:10,color:T.sec}}>{ALERT_RULES_INIT.filter(r=>r.enabled).length} rules active</div>
              </div>
            </div>
            {firing.map(r=>(
              <div key={r.id} style={{display:'flex',gap:8,padding:'5px 0',borderBottom:`0.5px solid ${T.border}`,alignItems:'center'}}>
                <Dot color={SEV_COLOR[r.severity]||T.muted} size={6}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.name}</div>
                  <div style={{fontSize:10,color:T.muted}}>{r.target_label}</div>
                </div>
                <span style={{fontSize:10,color:T.muted,flexShrink:0}}>{fmtAge(r.last_fired)}</span>
              </div>
            ))}
          </div>
        )}
      </WrapCard>
    );
  }

  if (type==='app-status') {
    const app = Object.values(PROJECT_DATA).flatMap(p=>Object.values(p.envs).flatMap(e=>e.apps)).find(a=>a.id===config.appId)||{name:'dashboard/web',status:'running',cpu:7,mem:310,uptime:'14m',image:'registry/dashboard:v2.14.1',replicas:2,port:3000};
    const sc  = app.status==='running'?T.green:app.status==='deploying'?T.blue:T.muted;
    const toast2 = useToast();
    return (
      <WrapCard title={config.appName||app.name}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <Dot color={sc} size={8}/>
            <span style={{fontSize:13,fontWeight:600,color:sc}}>{app.status}</span>
          </div>
          <Pill label={config.env||'production'} color={config.env==='production'?T.red:config.env==='staging'?T.amber:T.blue}/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:10}}>
          {[['Uptime',app.uptime||'—'],['Replicas',app.replicas||'1'],['CPU',app.cpu+'%'],['Mem',app.mem+' MB']].map(([k,v])=>(
            <div key={k} style={{background:T.elevated,borderRadius:5,padding:'6px 8px'}}>
              <div style={{fontSize:9,color:T.muted,marginBottom:2,textTransform:'uppercase',letterSpacing:'0.07em'}}>{k}</div>
              <div style={{fontSize:12,fontWeight:600,color:T.text,fontFamily:'monospace'}}>{v}</div>
            </div>
          ))}
        </div>
        <button onClick={()=>{const t=toast2.loading('Queueing…',config.appName);setTimeout(()=>t.update('success','Deploy triggered',config.appName),1200);}} style={{width:'100%',padding:'6px',borderRadius:5,border:'none',background:T.blue,color:'#fff',fontSize:11,fontWeight:600,cursor:'pointer'}}>🚀 Deploy</button>
      </WrapCard>
    );
  }

  if (type==='job-history') {
    return (
      <WrapCard title="Recent jobs"
        action={<button onClick={()=>nav&&nav('jobs')} style={{fontSize:10,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>View all →</button>}>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {JOBS_INIT.slice(0,5).map((j,i)=>(
            <div key={j.id} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:i<4?`0.5px solid ${T.border}`:'none'}}>
              <Dot color={jColor(j.status)} size={6}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{j.name}</div>
                <div style={{fontSize:10,color:T.muted}}>{j.project} · {describeCron(j.schedule)}</div>
              </div>
              <div style={{fontSize:10,color:T.muted,flexShrink:0,textAlign:'right'}}>
                <div>{j.lastRun}</div>
                <div style={{fontFamily:'monospace'}}>{j.duration}</div>
              </div>
            </div>
          ))}
        </div>
      </WrapCard>
    );
  }

  if (type==='activity-mini') {
    const events = (config.kind && config.kind!=='all')
      ? ACTIVITY_EVENTS.filter(e=>e.kind===config.kind).slice(0,5)
      : ACTIVITY_EVENTS.slice(0,5);
    return (
      <WrapCard title="Activity"
        action={<button onClick={()=>nav&&nav('activity')} style={{fontSize:10,color:T.blue,background:'none',border:'none',cursor:'pointer',padding:0}}>Full feed →</button>}>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          {events.map((ev,i)=>(
            <div key={ev.id} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',borderBottom:i<events.length-1?`0.5px solid ${T.border}`:'none'}}>
              <div style={{width:22,height:22,borderRadius:'50%',background:`${ev.color}12`,border:`0.5px solid ${ev.color}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,flexShrink:0,marginTop:1}}>{ev.icon}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ev.title}</div>
                <div style={{fontSize:10,color:T.muted}}>{ev.actor} · {fmtAge(ev.ts)}</div>
              </div>
            </div>
          ))}
        </div>
      </WrapCard>
    );
  }

  if (type==='portal-service') {
    const svc = PORTAL_SERVICES.find(s=>s.id===config.serviceId) || PORTAL_SERVICES[0];
    const sc  = ({healthy:T.green,stub:T.muted,degraded:T.amber}[svc.status]||T.muted);
    const liveLatency = svc.metrics.latency_ms ? (svc.metrics.latency_ms+(Math.random()-0.5)*0.5).toFixed(1) : null;
    return (
      <WrapCard title={config.serviceName||svc.name}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
          <div style={{width:32,height:32,borderRadius:7,background:`${sc}15`,border:`1px solid ${sc}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{svc.icon}</div>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:6}}><Dot color={sc} size={6}/><span style={{fontSize:12,fontWeight:500,color:sc}}>{svc.status==='stub'?'stub mode':svc.status}</span></div>
            <div style={{fontSize:10,color:T.muted}}>{svc.adapter}</div>
          </div>
          <div style={{marginLeft:'auto'}}><Sparkline data={svc.sparkline} color={svc.configured?sc:T.muted} width={50} height={18}/></div>
        </div>
        {liveLatency&&<div style={{display:'flex',gap:8}}>
          <div style={{flex:1,background:T.elevated,borderRadius:5,padding:'6px 8px',textAlign:'center'}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Latency</div>
            <div style={{fontSize:14,fontWeight:700,color:sc,fontFamily:'monospace'}}>{liveLatency}<span style={{fontSize:9,color:T.muted}}>ms</span></div>
          </div>
          {svc.metrics.ops_sec&&<div style={{flex:1,background:T.elevated,borderRadius:5,padding:'6px 8px',textAlign:'center'}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Ops/s</div>
            <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{Math.round(svc.metrics.ops_sec+(Math.random()-0.5)*100)}</div>
          </div>}
          {svc.metrics.docs&&<div style={{flex:1,background:T.elevated,borderRadius:5,padding:'6px 8px',textAlign:'center'}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Docs</div>
            <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:'monospace'}}>{(svc.metrics.docs/1000).toFixed(1)}k</div>
          </div>}
        </div>}
        {!svc.configured&&<div style={{fontSize:11,color:T.amber,marginTop:6,display:'flex',alignItems:'center',gap:5}}><span>⚠</span>Set <code style={{fontFamily:'monospace'}}>{svc.env}</code> to activate</div>}
      </WrapCard>
    );
  }

  if (type==='stat-counter') {
    return (
      <WrapCard title={config.label||'Stat'}>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'8px 0',gap:4,height:'100%'}}>
          <div style={{fontSize:40,fontWeight:800,color:config.color||T.text,letterSpacing:'-0.03em',lineHeight:1}}>{config.value||'—'}</div>
          {config.sub&&<div style={{fontSize:11,color:T.muted}}>{config.sub}</div>}
        </div>
      </WrapCard>
    );
  }

  return (
    <WrapCard title={type}>
      <div style={{fontSize:12,color:T.muted,padding:'12px 0'}}>Widget type not found: {type}</div>
    </WrapCard>
  );
}

// ─── Add Widget Modal ─────────────────────────────────────────────────────────
function AddWidgetModal({ onClose, onAdd }) {
  const [step, setStep]       = useState(0); // 0=pick type, 1=configure
  const [widgetType, setType] = useState(null);
  const [cols, setCols]       = useState(1);
  // Config fields
  const [serverId,    setServerId]   = useState('s1');
  const [appId,       setAppId]      = useState('b1');
  const [appEnv,      setAppEnv]     = useState('production');
  const [project,     setProject]    = useState('all');
  const [serviceId,   setServiceId]  = useState('valkey');
  const [statLabel,   setStatLabel]  = useState('');
  const [statValue,   setStatValue]  = useState('');
  const [statSub,     setStatSub]    = useState('');
  const [statColor,   setStatColor]  = useState(T.blue);
  const [actKind,     setActKind]    = useState('all');

  const wt = WIDGET_TYPES.find(w=>w.id===widgetType);

  const buildConfig = () => {
    if (widgetType==='server-health')  return { serverId, serverName: SERVERS.find(s=>s.id===serverId)?.name };
    if (widgetType==='deploy-feed')    return { project };
    if (widgetType==='app-status')     return { appId, appName: appId, env: appEnv };
    if (widgetType==='portal-service') return { serviceId, serviceName: PORTAL_SERVICES.find(s=>s.id===serviceId)?.name };
    if (widgetType==='stat-counter')   return { label:statLabel, value:statValue, sub:statSub, color:statColor };
    if (widgetType==='activity-mini')  return { kind: actKind };
    return {};
  };

  const add = () => {
    onAdd({ type:widgetType, cols, config:buildConfig() });
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:560,maxHeight:'88vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>{step===0?'Choose widget':'Configure widget'}</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'18px 22px'}}>
          {step===0 ? (
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
              {WIDGET_TYPES.map(wt=>{
                const sel = widgetType===wt.id;
                return (
                  <button key={wt.id} onClick={()=>{ setType(wt.id); setCols(wt.defaultCols); }} style={{background:sel?`${T.blue}12`:T.elevated,border:`1px solid ${sel?T.blue:T.border}`,borderRadius:8,padding:'12px 10px',cursor:'pointer',textAlign:'left'}}>
                    <div style={{fontSize:22,marginBottom:7}}>{wt.icon}</div>
                    <div style={{fontSize:12,fontWeight:600,color:sel?T.text:T.sec,marginBottom:3}}>{wt.label}</div>
                    <div style={{fontSize:10,color:T.muted,lineHeight:'14px'}}>{wt.desc}</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:T.elevated,borderRadius:7,marginBottom:18}}>
                <span style={{fontSize:20}}>{wt?.icon}</span>
                <span style={{fontSize:13,fontWeight:500,color:T.text}}>{wt?.label}</span>
                <button onClick={()=>setStep(0)} style={{marginLeft:'auto',fontSize:11,color:T.blue,background:'none',border:'none',cursor:'pointer'}}>Change</button>
              </div>

              {/* Width */}
              <div style={{marginBottom:16}}>
                <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:7,fontWeight:500}}>Width</label>
                <div style={{display:'flex',gap:7}}>
                  {[1,2,3].map(c=>(
                    <button key={c} onClick={()=>setCols(c)} style={{flex:1,padding:'8px',borderRadius:6,border:`1px solid ${cols===c?T.blue:T.border}`,background:cols===c?`${T.blue}12`:T.elevated,color:cols===c?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:cols===c?600:400}}>
                      {c===1?'Small (1/3)':c===2?'Medium (2/3)':'Full width'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Type-specific config */}
              {widgetType==='server-health' && (
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Server</label>
                  <select value={serverId} onChange={e=>setServerId(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none'}}>
                    {SERVERS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {widgetType==='deploy-feed' && (
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Project</label>
                  <select value={project} onChange={e=>setProject(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none'}}>
                    <option value="all">All projects</option>
                    {PROJECTS.map(p=><option key={p.id} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
              )}
              {widgetType==='portal-service' && (
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Service</label>
                  <select value={serviceId} onChange={e=>setServiceId(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none'}}>
                    {PORTAL_SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {widgetType==='activity-mini' && (
                <div>
                  <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Filter by kind</label>
                  <select value={actKind} onChange={e=>setActKind(e.target.value)} style={{width:'100%',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'8px 10px',fontSize:13,color:T.text,outline:'none'}}>
                    {ACTIVITY_KINDS.map(k=><option key={k.id} value={k.id}>{k.label}</option>)}
                  </select>
                </div>
              )}
              {widgetType==='stat-counter' && (
                <div style={{display:'flex',flexDirection:'column',gap:12}}>
                  <Input label="Label" value={statLabel} onChange={e=>setStatLabel(e.target.value)} placeholder="Active servers"/>
                  <Input label="Value" value={statValue} onChange={e=>setStatValue(e.target.value)} placeholder="6"/>
                  <Input label="Subtitle" value={statSub} onChange={e=>setStatSub(e.target.value)} placeholder="of 8 fleet"/>
                  <div>
                    <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:7,fontWeight:500}}>Color</label>
                    <div style={{display:'flex',gap:8}}>
                      {[T.green,T.blue,T.amber,T.red,T.purple,T.cyan,T.text].map(c=>(
                        <button key={c} onClick={()=>setStatColor(c)} style={{width:28,height:28,borderRadius:'50%',background:c,border:statColor===c?`2.5px solid #fff`:`1px solid transparent`,cursor:'pointer'}}/>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',flexShrink:0}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer',padding:'8px 0'}}>Cancel</button>
          {step===0
            ? <button onClick={()=>setStep(1)} disabled={!widgetType} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:widgetType?'pointer':'not-allowed',opacity:widgetType?1:0.4}}>Configure →</button>
            : <button onClick={add} style={{background:T.blue,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Add widget</button>
          }
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard detail view ────────────────────────────────────────────────────
function DashboardDetailView({ dashboard, onBack }) {
  const toast = useToast();
  const [widgets, setWidgets] = useState(dashboard.widgets);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(false);

  const removeWidget = id => {
    setWidgets(ws=>ws.filter(w=>w.id!==id));
    toast.success('Widget removed','');
  };

  const addWidget = w => {
    setWidgets(ws=>[...ws,{id:'w'+Date.now(),...w}]);
    toast.success('Widget added',WIDGET_TYPES.find(t=>t.id===w.type)?.label||w.type);
  };

  // Build 3-column grid rows from widgets
  const buildRows = (widgets) => {
    const rows = [];
    let current = [], currentCols = 0;
    for (const w of widgets) {
      const cols = Math.min(w.cols||1, 3);
      if (currentCols + cols > 3) {
        if (current.length) rows.push(current);
        current = []; currentCols = 0;
      }
      current.push(w);
      currentCols += cols;
    }
    if (current.length) rows.push(current);
    return rows;
  };

  const rows = buildRows(widgets);

  return (
    <div style={{padding:'24px 28px'}}>
      {showAdd&&<AddWidgetModal onClose={()=>setShowAdd(false)} onAdd={addWidget}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:22}}>
        <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:T.blue,padding:0,fontSize:13}}>← Dashboards</button>
        <span style={{color:T.muted}}>/</span>
        <div style={{display:'flex',alignItems:'center',gap:10,flex:1}}>
          <span style={{fontSize:20}}>{dashboard.icon}</span>
          <span style={{fontSize:18,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{dashboard.name}</span>
          {dashboard.description&&<span style={{fontSize:12,color:T.muted}}>{dashboard.description}</span>}
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>setEditing(e=>!e)} style={{padding:'7px 14px',borderRadius:6,border:`0.5px solid ${editing?T.blue:T.border}`,background:editing?`${T.blue}12`:'none',color:editing?T.blue:T.sec,fontSize:12,cursor:'pointer'}}>
            {editing?'Done editing':'✎ Edit'}
          </button>
          <button onClick={()=>setShowAdd(true)} style={{padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>＋ Add widget</button>
        </div>
      </div>

      {editing&&(
        <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:7,padding:'8px 16px',marginBottom:16,fontSize:12,color:T.amber}}>
          ✎ Edit mode — each widget has a ✕ to remove it. Add new widgets with the button above.
        </div>
      )}

      {/* Widget grid */}
      {rows.length===0 ? (
        <div style={{padding:'60px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10}}>
          <div style={{fontSize:36,marginBottom:14}}>📊</div>
          <div style={{fontSize:15,fontWeight:500,color:T.text,marginBottom:6}}>No widgets yet</div>
          <div style={{fontSize:12,color:T.sec,marginBottom:20}}>Add widgets to build your custom view.</div>
          <button onClick={()=>setShowAdd(true)} style={{padding:'9px 20px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ Add first widget</button>
        </div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          {rows.map((row,ri)=>(
            <div key={ri} style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
              {row.map(w=>(
                <div key={w.id} style={{gridColumn:`span ${Math.min(w.cols||1,3)}`,minHeight:editing?190:180}}>
                  <DashWidget widget={w} nav={null}
                    onRemove={()=>removeWidget(w.id)}
                    onEdit={()=>{}}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dashboards list view ─────────────────────────────────────────────────────
function DashboardsView({ onOpen }) {
  const toast = useToast();
  const [dashboards, setDashboards] = useState(DASHBOARDS_INIT);
  const [showNew, setShowNew]       = useState(false);
  const [newName, setNewName]       = useState('');
  const [newDesc, setNewDesc]       = useState('');
  const [newIcon, setNewIcon]       = useState('📊');

  const ICONS = ['📊','🏢','📦','⬡','🖥','🚀','⚡','◎','🔑','🗂','🕸','💾'];

  const create = () => {
    if (!newName.trim()) { toast.error('Name required',''); return; }
    const d = { id:'db'+Date.now(), name:newName, description:newDesc, icon:newIcon, color:T.blue, pinned:false, widgets:[] };
    setDashboards(ds=>[...ds,d]);
    toast.success('Dashboard created',newName);
    setShowNew(false); setNewName(''); setNewDesc('');
    onOpen(d);
  };

  const deleteDashboard = d => {
    setDashboards(ds=>ds.filter(x=>x.id!==d.id));
    toast.success('Dashboard deleted',d.name);
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Dashboards</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Custom views — pull any metric, app, server, or service into a single screen.</p>
        </div>
        <button onClick={()=>setShowNew(v=>!v)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ New dashboard
        </button>
      </div>

      {showNew&&(
        <div style={{background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:9,padding:'18px 20px',marginBottom:20}}>
          <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>New dashboard</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
            <Input label="Name" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Ops Overview"/>
            <Input label="Description (optional)" value={newDesc} onChange={e=>setNewDesc(e.target.value)} placeholder="Production health at a glance"/>
          </div>
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Icon</label>
            <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
              {ICONS.map(ic=>(
                <button key={ic} onClick={()=>setNewIcon(ic)} style={{width:36,height:36,borderRadius:7,border:`1px solid ${newIcon===ic?T.blue:T.border}`,background:newIcon===ic?`${T.blue}15`:T.elevated,fontSize:18,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>{ic}</button>
              ))}
            </div>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowNew(false)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Cancel</button>
            <button onClick={create} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>Create &amp; open →</button>
          </div>
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:14}}>
        {dashboards.map(d=>(
          <div key={d.id} onClick={()=>onOpen(d)}
            style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',cursor:'pointer',transition:'border-color 0.12s',position:'relative'}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=T.borderMd}
            onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
            <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:14}}>
              <div style={{width:44,height:44,borderRadius:10,background:`${d.color||T.blue}15`,border:`1px solid ${d.color||T.blue}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>
                {d.icon}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:3}}>{d.name}</div>
                <div style={{fontSize:12,color:T.muted}}>{d.description}</div>
              </div>
            </div>

            {/* Widget type preview chips */}
            <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:14}}>
              {[...new Set(d.widgets.map(w=>w.type))].map(wtype=>{
                const wt = WIDGET_TYPES.find(x=>x.id===wtype);
                return <span key={wtype} style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`}}>{wt?.icon} {wt?.label}</span>;
              })}
            </div>

            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span style={{fontSize:12,color:T.muted}}>{d.widgets.length} widget{d.widgets.length!==1?'s':''}</span>
              <button onClick={e=>{e.stopPropagation();deleteDashboard(d);}} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

const USER_SESSIONS = [
  { id:'s1', device:'macOS · Chrome 124',  ip:'203.0.113.14', location:'San Francisco, US', current:true,  last:'just now',   created:'2024-05-01' },
  { id:'s2', device:'iOS · Safari 17',     ip:'203.0.113.15', location:'San Francisco, US', current:false, last:'2h ago',     created:'2024-05-10' },
  { id:'s3', device:'macOS · Terminal (CLI)',ip:'10.0.1.4',   location:'VPN · Local',        current:false, last:'1d ago',     created:'2024-04-28' },
  { id:'s4', device:'Ubuntu · Firefox 125', ip:'198.51.100.3',location:'Austin, US',         current:false, last:'5d ago',     created:'2024-04-22' },
];

function UserSettingsView({ nav }) {
  const toast = useToast();
  const [tab, setTab] = useState('profile');

  // Profile state
  const [name, setName]     = useState('Sarah Chen');
  const [email, setEmail]   = useState('sarah@acme.com');
  const [handle, setHandle] = useState('sarah');

  // Password state
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [conPwd, setConPwd] = useState('');

  // Notifications state
  const [notifs, setNotifs] = useState({
    deploy_success: { email:false, inapp:true  },
    deploy_fail:    { email:true,  inapp:true  },
    alert_firing:   { email:true,  inapp:true  },
    alert_resolved: { email:false, inapp:true  },
    member_joined:  { email:true,  inapp:false },
    job_failed:     { email:true,  inapp:true  },
    weekly_digest:  { email:true,  inapp:false },
  });
  const toggleNotif = (key, channel) => {
    setNotifs(n=>({...n,[key]:{...n[key],[channel]:!n[key][channel]}}));
  };

  // Sessions state
  const [sessions, setSessions] = useState(USER_SESSIONS);

  const tabs = ['profile','password','notifications','sessions','danger zone'];

  const saveProfile = () => toast.success('Profile saved', `${name} · ${email}`);
  const savePassword = () => {
    if (!curPwd) { toast.error('Current password required',''); return; }
    if (newPwd.length < 8) { toast.error('Password too short','Minimum 8 characters.'); return; }
    if (newPwd !== conPwd) { toast.error('Passwords do not match',''); return; }
    toast.success('Password updated','You have been logged out of other sessions.');
    setCurPwd(''); setNewPwd(''); setConPwd('');
  };
  const revokeSession = id => {
    setSessions(ss=>ss.filter(s=>s.id!==id));
    toast.success('Session revoked','That device has been signed out.');
  };

  const NOTIF_LABELS = {
    deploy_success:'Deployment succeeded',
    deploy_fail:   'Deployment failed',
    alert_firing:  'Alert rule firing',
    alert_resolved:'Alert resolved',
    member_joined: 'Member joined workspace',
    job_failed:    'Job failed',
    weekly_digest: 'Weekly digest',
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:760}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:28}}>
        <div style={{width:56,height:56,borderRadius:'50%',background:T.purple,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,color:'#fff',fontWeight:700,flexShrink:0}}>SC</div>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{name}</h2>
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:4}}>
            <span style={{fontSize:12,color:T.muted}}>{email}</span>
            <Pill label="owner" color={T.amber}/>
            <Pill label="superadmin" color={T.purple}/>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`,marginBottom:24}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'8px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,textTransform:'capitalize',whiteSpace:'nowrap'}}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Profile ── */}
      {tab==='profile' && (
        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <Card>
            <SecHead title="Personal info"/>
            <Input label="Display name" value={name}   onChange={e=>setName(e.target.value)}  hint="Shown to teammates and in the audit log."/>
            <Input label="Email"        value={email}  onChange={e=>setEmail(e.target.value)} type="email" hint="Used for login, notifications, and invites."/>
            <Input label="Username"     value={handle} onChange={e=>setHandle(e.target.value)} mono hint="Lowercase, no spaces. Used in webhook URLs and deploy hooks."/>
          </Card>

          <Card>
            <SecHead title="Avatar"/>
            <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:14}}>
              <div style={{width:56,height:56,borderRadius:'50%',background:T.purple,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,color:'#fff',fontWeight:700}}>SC</div>
              <div>
                <div style={{fontSize:13,color:T.sec,marginBottom:8}}>Your avatar is generated from your initials. Upload a custom image to replace it.</div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>toast.info('Upload coming soon','Custom avatar upload is on the roadmap.')} style={{fontSize:12,padding:'6px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>Upload image</button>
                </div>
              </div>
            </div>
            <div style={{fontSize:11,color:T.sec,marginBottom:6}}>Initials colour</div>
            <div style={{display:'flex',gap:7}}>
              {[T.purple,T.blue,T.green,T.amber,T.red,T.cyan,T.orange].map(c=>(
                <button key={c} onClick={()=>toast.info('Colour saved','')} style={{width:28,height:28,borderRadius:'50%',background:c,border:c===T.purple?`2.5px solid #fff`:'1px solid transparent',cursor:'pointer'}}/>
              ))}
            </div>
          </Card>

          <div style={{display:'flex',justifyContent:'flex-end'}}>
            <button onClick={saveProfile} style={{padding:'9px 22px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Save profile</button>
          </div>
        </div>
      )}

      {/* ── Password ── */}
      {tab==='password' && (
        <div>
          <Card>
            <SecHead title="Change password"/>
            <Input label="Current password" value={curPwd} onChange={e=>setCurPwd(e.target.value)} type="password"/>
            <Input label="New password"     value={newPwd} onChange={e=>setNewPwd(e.target.value)} type="password" hint="Minimum 8 characters. Use a mix of letters, numbers, and symbols."/>
            <Input label="Confirm new password" value={conPwd} onChange={e=>setConPwd(e.target.value)} type="password"/>
            {newPwd && conPwd && newPwd!==conPwd && (
              <div style={{fontSize:12,color:T.red,marginBottom:12}}>Passwords do not match.</div>
            )}
            {newPwd && newPwd===conPwd && newPwd.length>=8 && (
              <div style={{fontSize:12,color:T.green,marginBottom:12}}>✓ Passwords match.</div>
            )}
          </Card>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
            <button onClick={savePassword} style={{padding:'9px 22px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Update password</button>
          </div>

          <div style={{marginTop:24,background:T.elevated,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'14px 18px'}}>
            <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:8}}>Two-factor authentication</div>
            <div style={{fontSize:12,color:T.sec,marginBottom:12}}>Add an extra layer of security. When enabled, you'll need your phone to sign in.</div>
            <button onClick={()=>toast.info('2FA setup','TOTP setup coming soon — we recommend Bitwarden Authenticator.')} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.card,color:T.sec,cursor:'pointer'}}>Set up authenticator app</button>
          </div>
        </div>
      )}

      {/* ── Notifications ── */}
      {tab==='notifications' && (
        <div>
          <Card>
            <SecHead title="Notification preferences"/>
            <div style={{fontSize:12,color:T.sec,marginBottom:14,lineHeight:'18px'}}>
              Choose how you want to be notified for each event type. In-app notifications appear in the activity feed. Email notifications use <code style={{fontFamily:'monospace'}}>sarah@acme.com</code>.
            </div>

            {/* Header row */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 80px 80px',gap:0,padding:'0 0 8px',borderBottom:`0.5px solid ${T.borderMd}`}}>
              <div style={{fontSize:11,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em'}}>Event</div>
              <div style={{fontSize:11,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',textAlign:'center'}}>Email</div>
              <div style={{fontSize:11,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',textAlign:'center'}}>In-app</div>
            </div>

            {Object.entries(NOTIF_LABELS).map(([key,label])=>(
              <div key={key} style={{display:'grid',gridTemplateColumns:'1fr 80px 80px',gap:0,alignItems:'center',padding:'11px 0',borderBottom:`0.5px solid ${T.border}`}}>
                <span style={{fontSize:13,color:T.text}}>{label}</span>
                {['email','inapp'].map(channel=>{
                  const on = notifs[key]?.[channel];
                  return (
                    <div key={channel} style={{display:'flex',justifyContent:'center'}}>
                      <div onClick={()=>toggleNotif(key,channel)} style={{width:36,height:20,borderRadius:10,background:on?T.green:T.elevated,border:`0.5px solid ${on?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s'}}>
                        <div style={{position:'absolute',top:2,left:on?18:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </Card>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
            <button onClick={()=>toast.success('Preferences saved','Notification settings updated.')} style={{padding:'9px 22px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Save preferences</button>
          </div>
        </div>
      )}

      {/* ── Sessions ── */}
      {tab==='sessions' && (
        <div>
          <Card>
            <SecHead title="Active sessions"/>
            <div style={{fontSize:12,color:T.sec,marginBottom:14}}>
              These are all devices currently signed in to your account. Revoke any session you don't recognize.
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              {sessions.map((s,i)=>(
                <div key={s.id} style={{display:'flex',alignItems:'center',gap:14,padding:'12px 0',borderBottom:i<sessions.length-1?`0.5px solid ${T.border}`:'none'}}>
                  {/* Device icon */}
                  <div style={{width:36,height:36,borderRadius:8,background:T.elevated,border:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>
                    {s.device.startsWith('iOS')?'📱':s.device.startsWith('macOS')?'💻':s.device.startsWith('Ubuntu')?'🐧':'🖥'}
                  </div>
                  {/* Details */}
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                      <span style={{fontSize:13,fontWeight:500,color:T.text}}>{s.device}</span>
                      {s.current&&<span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:`${T.green}18`,color:T.green,border:`0.5px solid ${T.green}44`,fontWeight:600}}>current</span>}
                    </div>
                    <div style={{fontSize:11,color:T.muted}}>{s.ip} · {s.location} · last active {s.last}</div>
                  </div>
                  {/* Action */}
                  {!s.current && (
                    <button onClick={()=>revokeSession(s.id)} style={{fontSize:11,padding:'4px 11px',borderRadius:5,border:`0.5px solid ${T.red}44`,background:`${T.red}08`,color:T.red,cursor:'pointer',flexShrink:0,fontWeight:500}}>Revoke</button>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {sessions.filter(s=>!s.current).length>0&&(
            <div style={{display:'flex',justifyContent:'flex-end',marginTop:14}}>
              <button onClick={()=>{
                setSessions(ss=>ss.filter(s=>s.current));
                toast.warning('All other sessions revoked','Only this device remains signed in.');
              }} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:`0.5px solid ${T.red}44`,background:`${T.red}08`,color:T.red,cursor:'pointer',fontWeight:500}}>
                Revoke all other sessions
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Danger zone ── */}
      {tab==='danger zone' && (
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <div style={{background:T.elevated,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'16px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:2}}>Export your data</div>
              <div style={{fontSize:12,color:T.sec}}>Download a JSON export of your profile, API keys, and notification settings.</div>
            </div>
            <button onClick={()=>toast.info('Export queued','You\'ll receive a download link at sarah@acme.com within a few minutes.')} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.card,color:T.sec,cursor:'pointer',flexShrink:0}}>Export data</button>
          </div>

          <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:8,padding:'16px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:T.amber,marginBottom:2}}>Sign out everywhere</div>
              <div style={{fontSize:12,color:T.sec}}>Immediately invalidates all sessions across all devices.</div>
            </div>
            <button onClick={()=>{setSessions(ss=>ss.filter(s=>s.current));toast.warning('Signed out everywhere','All other sessions have been revoked.');}} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.amber}44`,background:`${T.amber}10`,color:T.amber,cursor:'pointer',fontWeight:500,flexShrink:0}}>Sign out everywhere</button>
          </div>

          <div style={{background:`${T.red}08`,border:`0.5px solid ${T.red}33`,borderRadius:8,padding:'16px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:T.red,marginBottom:2}}>Delete account</div>
              <div style={{fontSize:12,color:T.sec}}>Permanently delete your account. This cannot be undone. As workspace owner, you must transfer ownership first.</div>
            </div>
            <button onClick={()=>toast.error('Transfer ownership first','You are the owner of Acme Corp. Assign a new owner before deleting your account.')} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.red}44`,background:`${T.red}10`,color:T.red,cursor:'pointer',fontWeight:500,flexShrink:0}}>Delete account</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISK CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

const DISK_DATA_INIT = [
  {
    id:'s1', name:'prod-web-01', status:'online',
    images:{ unused:3, dangling:8, total_count:24, size_gb:4.2 },
    containers:{ stopped:1, running:6 },
    volumes:{ unused:0, size_gb:0.01 },
    build_cache_gb:1.1,
    total_gb:5.31,
    last_cleanup: Date.now()-86400000*3,
  },
  {
    id:'s2', name:'prod-web-02', status:'online',
    images:{ unused:3, dangling:6, total_count:22, size_gb:3.9 },
    containers:{ stopped:0, running:5 },
    volumes:{ unused:0, size_gb:0.01 },
    build_cache_gb:0.9,
    total_gb:4.81,
    last_cleanup: Date.now()-86400000*3,
  },
  {
    id:'s3', name:'prod-db-01', status:'online',
    images:{ unused:1, dangling:2, total_count:8, size_gb:1.2 },
    containers:{ stopped:0, running:2 },
    volumes:{ unused:0, size_gb:14.2 },
    build_cache_gb:0.1,
    total_gb:15.5,
    last_cleanup: Date.now()-86400000*7,
  },
  {
    id:'s4', name:'prod-worker-01', status:'draining',
    images:{ unused:5, dangling:12, total_count:31, size_gb:6.8 },
    containers:{ stopped:3, running:2 },
    volumes:{ unused:1, size_gb:2.3 },
    build_cache_gb:2.4,
    total_gb:11.5,
    last_cleanup: Date.now()-86400000*14,
  },
  {
    id:'s5', name:'build-runner-01', status:'online',
    images:{ unused:9, dangling:22, total_count:58, size_gb:18.4 },
    containers:{ stopped:2, running:1 },
    volumes:{ unused:2, size_gb:4.1 },
    build_cache_gb:8.2,
    total_gb:30.7,
    last_cleanup: Date.now()-86400000*21,
  },
  {
    id:'s6', name:'stg-app-01', status:'online',
    images:{ unused:4, dangling:9, total_count:27, size_gb:5.1 },
    containers:{ stopped:1, running:4 },
    volumes:{ unused:1, size_gb:1.2 },
    build_cache_gb:1.8,
    total_gb:8.1,
    last_cleanup: Date.now()-86400000*10,
  },
];

function DiskCleanupView() {
  const toast = useToast();
  const [dismissed, setDismissed] = React.useState(new Set());
  const diskNotices = computeNotices()
    .filter(n => n.category === 'cleanup' && !dismissed.has(n.id));
  const [servers, setServers]       = useState(DISK_DATA_INIT);
  const [cleaning, setCleaning]     = useState({}); // { serverId: 'running'|'done' }
  const [cleanAllRunning, setCleanAll] = useState(false);
  const [cleanAllProgress, setProgress] = useState(-1); // index of server being cleaned

  // Schedule settings
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedCron, setSchedCron]       = useState('0 1 * * *');
  const [keepImages, setKeepImages]     = useState(3);
  const [targets, setTargets]           = useState({
    dangling: true,
    unused_images: true,
    stopped_containers: true,
    unused_volumes: false,
    build_cache: true,
  });
  const [schedSaved, setSchedSaved]     = useState(false);

  const toggleTarget = k => setTargets(t=>({...t,[k]:!t[k]}));

  const totalReclaimable = servers.reduce((acc,s)=>{
    let gb = s.images.dangling * 0.08; // rough avg per dangling layer
    if (targets.unused_images)       gb += s.images.unused * 0.4;
    if (targets.stopped_containers)  gb += s.containers.stopped * 0.01;
    if (targets.unused_volumes)      gb += s.volumes.unused > 0 ? s.volumes.size_gb * 0.8 : 0;
    if (targets.build_cache)         gb += s.build_cache_gb * 0.9;
    return acc + gb;
  }, 0);

  const cleanServer = (server, opts={}) => {
    if (server.status === 'unreachable') { toast.error('Server unreachable', `Cannot connect to ${server.name} via agent.`); return; }
    setCleaning(c=>({...c,[server.id]:'running'}));
    const duration = 1500 + Math.random()*1000;
    setTimeout(()=>{
      const freed = (server.images.dangling*0.08 + (targets.unused_images?server.images.unused*0.4:0) + (targets.build_cache?server.build_cache_gb*0.9:0)).toFixed(1);
      setServers(ss=>ss.map(s=>s.id===server.id?{
        ...s,
        images:{ ...s.images, dangling:0, unused:targets.unused_images?0:s.images.unused },
        containers:{ ...s.containers, stopped:targets.stopped_containers?0:s.containers.stopped },
        volumes:{ ...s.volumes, unused:targets.unused_volumes?0:s.volumes.unused },
        build_cache_gb: targets.build_cache?0:s.build_cache_gb,
        total_gb: Math.max(0.1, s.total_gb - parseFloat(freed)),
        last_cleanup: Date.now(),
      }:s));
      setCleaning(c=>({...c,[server.id]:'done'}));
      if (!opts.silent) toast.success(`${server.name} cleaned`, `Freed ~${freed} GB`);
      setTimeout(()=>setCleaning(c=>{const n={...c};delete n[server.id];return n;}), 3000);
    }, duration);
  };

  // Sequential clean all
  const cleanAll = async () => {
    const online = servers.filter(s=>s.status!=='unreachable');
    if (online.length===0) { toast.error('No reachable servers',''); return; }

    setCleanAll(true);
    setProgress(0);

    const t = toast.loading(`Cleaning fleet…`, `${online.length} servers, running sequentially`);

    let totalFreed = 0;
    for (let i=0; i<online.length; i++) {
      setProgress(i);
      const s = online[i];
      setCleaning(c=>({...c,[s.id]:'running'}));

      await new Promise(res=>setTimeout(res, 1800+Math.random()*800));

      const freed = parseFloat((s.images.dangling*0.08+(targets.unused_images?s.images.unused*0.4:0)+(targets.build_cache?s.build_cache_gb*0.9:0)).toFixed(1));
      totalFreed += freed;

      setServers(ss=>ss.map(x=>x.id===s.id?{
        ...x,
        images:{ ...x.images, dangling:0, unused:targets.unused_images?0:x.images.unused },
        containers:{ ...x.containers, stopped:targets.stopped_containers?0:x.containers.stopped },
        build_cache_gb: targets.build_cache?0:x.build_cache_gb,
        total_gb: Math.max(0.1, x.total_gb - freed),
        last_cleanup: Date.now(),
      }:x));
      setCleaning(c=>{const n={...c};delete n[s.id];return n;});
    }

    setCleanAll(false);
    setProgress(-1);
    t.update('success', 'Fleet cleaned', `Freed ~${totalFreed.toFixed(1)} GB across ${online.length} servers`);
  };

  const saveSchedule = () => {
    toast.success('Schedule saved', `${describeCron(schedCron)} · keep ${keepImages} images per app`);
    setSchedSaved(true);
    setTimeout(()=>setSchedSaved(false), 2000);
  };

  const totalImages   = servers.reduce((a,s)=>a+s.images.dangling+s.images.unused,0);
  const totalStopped  = servers.reduce((a,s)=>a+s.containers.stopped,0);
  const totalDiskGb   = servers.reduce((a,s)=>a+s.total_gb,0);

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Disk Cleanup</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            Remove unused Docker images, dangling layers, stopped containers, and build cache across the fleet.
          </p>
        </div>
        <button
          onClick={cleanAll}
          disabled={cleanAllRunning}
          style={{display:'flex',alignItems:'center',gap:8,padding:'9px 18px',borderRadius:7,border:'none',background:cleanAllRunning?T.elevated:T.amber,color:cleanAllRunning?T.muted:'#111',fontSize:13,fontWeight:700,cursor:cleanAllRunning?'not-allowed':'pointer',opacity:cleanAllRunning?0.7:1}}>
          {cleanAllRunning
            ? <><span style={{display:'inline-block',width:12,height:12,border:'2px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Cleaning {servers.find((_,i)=>i===cleanAllProgress)?.name||'…'}</>
            : '🗑 Clean all servers'}
        </button>
      </div>

      <NoticeBar notices={diskNotices} onDismiss={id=>setDismissed(s=>new Set([...s,id]))}/>
      {/* Stat strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
        <StatCard label="Total disk used"    value={totalDiskGb.toFixed(1)+' GB'}   sub="across fleet"/>
        <StatCard label="Reclaimable"         value={'~'+totalReclaimable.toFixed(1)+' GB'} sub="with current targets" color={T.amber}/>
        <StatCard label="Unused images"      value={totalImages}                    sub="dangling + orphaned"   color={totalImages>10?T.amber:T.text}/>
        <StatCard label="Stopped containers" value={totalStopped}                   sub="safe to remove"        color={totalStopped>0?T.amber:T.muted}/>
      </div>

      {/* What to clean */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'16px 20px',marginBottom:20}}>
        <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:12}}>Cleanup targets</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
          {[
            { k:'dangling',            label:'Dangling images',       desc:'Untagged layers from old builds. Always safe.' },
            { k:'unused_images',       label:'Unused images',         desc:`Tags not used by any container. Keeps ${keepImages} per app.` },
            { k:'stopped_containers',  label:'Stopped containers',    desc:'Exited containers. Data volumes preserved.' },
            { k:'unused_volumes',      label:'Unused volumes',        desc:'Volumes not mounted by any container. ⚠ Check first.' },
            { k:'build_cache',         label:'Build cache',           desc:'Cached layers from docker build. Next build slower.' },
          ].map(item=>{
            const on = targets[item.k];
            return (
              <button key={item.k} onClick={()=>toggleTarget(item.k)} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px',borderRadius:7,border:`1px solid ${on?T.blue:T.border}`,background:on?`${T.blue}10`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                <div style={{width:15,height:15,borderRadius:3,border:`1.5px solid ${on?T.blue:T.border}`,background:on?T.blue:'none',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:1}}>
                  {on&&<span style={{fontSize:8,color:'#fff',fontWeight:700}}>✓</span>}
                </div>
                <div>
                  <div style={{fontSize:12,fontWeight:500,color:on?T.text:T.sec,marginBottom:2}}>{item.label}</div>
                  <div style={{fontSize:10,color:T.muted,lineHeight:'14px'}}>{item.desc}</div>
                </div>
              </button>
            );
          })}
          {/* Keep N images */}
          <div style={{padding:'10px 12px',borderRadius:7,border:`0.5px solid ${T.border}`,background:T.elevated}}>
            <div style={{fontSize:12,fontWeight:500,color:T.text,marginBottom:6}}>Images to keep per app</div>
            <div style={{display:'flex',gap:5}}>
              {[1,2,3,5].map(n=>(
                <button key={n} onClick={()=>setKeepImages(n)} style={{padding:'3px 10px',borderRadius:4,border:`1px solid ${keepImages===n?T.blue:T.border}`,background:keepImages===n?`${T.blue}15`:T.card,color:keepImages===n?T.blue:T.sec,fontSize:12,cursor:'pointer',fontWeight:keepImages===n?600:400}}>{n}</button>
              ))}
            </div>
            <div style={{fontSize:10,color:T.muted,marginTop:5}}>Kept for rollback. Older ones pruned.</div>
          </div>
        </div>
      </div>

      {/* Per-server list */}
      <div style={{marginBottom:24}}>
        <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:12,fontWeight:500}}>Fleet — {servers.length} servers</div>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {servers.map((s,idx)=>{
            const state        = cleaning[s.id];
            const isRunning    = state==='running';
            const isDone       = state==='done';
            const isCleanAll   = cleanAllRunning && cleanAllProgress===servers.filter(x=>x.status!=='unreachable').indexOf(s);
            const isQueued     = cleanAllRunning && servers.filter(x=>x.status!=='unreachable').indexOf(s) > cleanAllProgress;
            const reclaimable  = (s.images.dangling*0.08+(targets.unused_images?s.images.unused*0.4:0)+(targets.build_cache?s.build_cache_gb*0.9:0)).toFixed(1);
            const statusC      = {online:T.green,draining:T.amber,unreachable:T.red,stopped:T.muted}[s.status]||T.muted;
            const daysAgo      = s.last_cleanup ? Math.floor((Date.now()-s.last_cleanup)/86400000) : null;

            return (
              <div key={s.id} style={{background:T.card,border:`0.5px solid ${isDone?T.green+'44':isRunning||isCleanAll?T.blue+'44':T.border}`,borderRadius:9,padding:'14px 18px',transition:'border-color 0.2s'}}>
                <div style={{display:'flex',alignItems:'center',gap:14}}>
                  {/* Server name + status */}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                      <Dot color={statusC} size={7}/>
                      <span style={{fontSize:14,fontWeight:600,color:T.text}}>{s.name}</span>
                      {isQueued&&<Pill label="queued" color={T.muted}/>}
                      {isRunning&&<Pill label="cleaning…" color={T.blue}/>}
                      {isDone&&<Pill label="✓ cleaned" color={T.green}/>}
                    </div>
                    {/* Breakdown */}
                    <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
                      {[
                        [`${s.images.dangling} dangling`, s.images.dangling>0?T.amber:T.muted],
                        [`${s.images.unused} unused imgs`, s.images.unused>0?T.amber:T.muted],
                        [`${s.containers.stopped} stopped`, s.containers.stopped>0?T.sec:T.muted],
                        [`${s.build_cache_gb.toFixed(1)} GB cache`, s.build_cache_gb>1?T.amber:T.muted],
                      ].map(([label,color])=>(
                        <span key={label} style={{fontSize:11,color}}>{label}</span>
                      ))}
                    </div>
                  </div>

                  {/* Total disk */}
                  <div style={{textAlign:'center',minWidth:80,flexShrink:0}}>
                    <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Disk used</div>
                    <div style={{fontSize:16,fontWeight:700,color:s.total_gb>20?T.amber:T.text}}>{s.total_gb.toFixed(1)}<span style={{fontSize:11,color:T.muted,fontWeight:400}}> GB</span></div>
                  </div>

                  {/* Reclaimable */}
                  <div style={{textAlign:'center',minWidth:80,flexShrink:0}}>
                    <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Reclaimable</div>
                    <div style={{fontSize:16,fontWeight:700,color:parseFloat(reclaimable)>0?T.amber:T.muted}}>~{reclaimable}<span style={{fontSize:11,color:T.muted,fontWeight:400}}> GB</span></div>
                  </div>

                  {/* Last cleanup */}
                  <div style={{textAlign:'right',minWidth:80,flexShrink:0}}>
                    <div style={{fontSize:10,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>Last cleaned</div>
                    <div style={{fontSize:12,color:daysAgo!==null&&daysAgo>14?T.amber:T.muted}}>{daysAgo===0?'today':daysAgo===1?'yesterday':daysAgo!==null?`${daysAgo}d ago`:'never'}</div>
                  </div>

                  {/* Clean button */}
                  <button
                    onClick={()=>cleanServer(s)}
                    disabled={isRunning||cleanAllRunning||s.status==='unreachable'}
                    style={{padding:'7px 16px',borderRadius:6,border:'none',background:isRunning?T.elevated:s.status==='unreachable'?T.elevated:T.blue,color:isRunning||s.status==='unreachable'?T.muted:'#fff',fontSize:12,fontWeight:600,cursor:isRunning||cleanAllRunning||s.status==='unreachable'?'not-allowed':'pointer',flexShrink:0,opacity:cleanAllRunning&&!isRunning?0.5:1,display:'flex',alignItems:'center',gap:6}}>
                    {isRunning
                      ? <><span style={{display:'inline-block',width:10,height:10,border:'1.5px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Cleaning…</>
                      : isDone ? '✓ Done' : 'Clean'}
                  </button>
                </div>

                {/* Progress bar while cleaning */}
                {(isRunning||isCleanAll) && (
                  <div style={{marginTop:10,height:2,background:T.elevated,borderRadius:1,overflow:'hidden'}}>
                    <div style={{height:'100%',background:T.blue,borderRadius:1,animation:'progress-indeterminate 1.5s ease-in-out infinite',width:'60%'}}/>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scheduled cleanup */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'18px 20px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:T.text,marginBottom:2}}>Scheduled cleanup</div>
            <div style={{fontSize:12,color:T.sec}}>Runs automatically on all online servers. Uses the same targets configured above.</div>
          </div>
          <div onClick={()=>setSchedEnabled(v=>!v)} style={{width:40,height:22,borderRadius:11,background:schedEnabled?T.green:T.elevated,border:`0.5px solid ${schedEnabled?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
            <div style={{position:'absolute',top:2,left:schedEnabled?20:2,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
          </div>
        </div>

        {schedEnabled && (
          <div>
            <div style={{marginBottom:14}}>
              <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Schedule</label>
              <CronBuilder value={schedCron} onChange={setSchedCron}/>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:T.elevated,borderRadius:7,border:`0.5px solid ${T.border}`,marginBottom:14}}>
              <span style={{fontSize:12,color:T.muted}}>Next run:</span>
              <span style={{fontSize:12,color:T.text,fontWeight:500}}>{describeCron(schedCron)}</span>
              <span style={{fontSize:11,fontFamily:'monospace',color:T.muted,marginLeft:'auto'}}>{schedCron}</span>
            </div>
          </div>
        )}

        <div style={{display:'flex',justifyContent:'flex-end'}}>
          <button
            onClick={saveSchedule}
            style={{padding:'8px 20px',borderRadius:6,border:'none',background:schedSaved?T.green:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',transition:'background 0.2s'}}>
            {schedSaved?'✓ Saved':'Save schedule'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes progress-indeterminate {
          0%   { transform: translateX(-100%); width: 60%; }
          100% { transform: translateX(200%);  width: 60%; }
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP BLUEPRINTS
// ═══════════════════════════════════════════════════════════════════════════════

const BLUEPRINTS = [
  {
    id:'n8n', name:'n8n', category:'Automation',
    icon:'🔄', color:'#ea4b71',
    desc:'Workflow automation platform. Connect anything to everything.',
    version:'1.1.1', image:'n8nio/n8n:latest',
    app:{ type:'container', port:5678, persistent:true, volume_path:'/home/node/.n8n', health_check:'/healthz', replicas:1, cpu:'500m', mem:'512Mi' },
    params:[
      { id:'N8N_BASIC_AUTH_ACTIVE',    label:'Enable basic auth',        default:'true',  required:false, secret:false  },
      { id:'N8N_BASIC_AUTH_USER',      label:'Admin username',           default:'admin', required:true,  secret:false, hint:'Your login username' },
      { id:'N8N_BASIC_AUTH_PASSWORD',  label:'Admin password',           default:'',      required:true,  secret:true,  hint:'Min 8 characters'  },
      { id:'WEBHOOK_URL',              label:'Public URL',               default:'',      required:false, secret:false, hint:'https://n8n.acme.com — used for webhooks' },
      { id:'N8N_ENCRYPTION_KEY',       label:'Encryption key',           default:'',      required:true,  secret:true,  hint:'Random string to encrypt credentials', generate:'random_hex_32' },
      { id:'GENERIC_TIMEZONE',         label:'Timezone',                 default:'UTC',   required:false, secret:false, hint:'e.g. America/New_York' },
    ],
    links:[{ label:'Docs', url:'https://docs.n8n.io' },{ label:'Docker Hub', url:'https://hub.docker.com/r/n8nio/n8n' }],
    notes:'n8n stores credentials and workflow data in /home/node/.n8n. The persistent volume ensures nothing is lost on redeploy.',
  },
  {
    id:'postgres', name:'PostgreSQL', category:'Database',
    icon:'🐘', color:T.blue,
    desc:'The world\'s most advanced open source relational database.',
    version:'16', image:'postgres:16-alpine',
    app:{ type:'database', port:5432, persistent:true, volume_path:'/var/lib/postgresql/data', health_check:null, replicas:1, cpu:'500m', mem:'1Gi' },
    params:[
      { id:'POSTGRES_DB',        label:'Database name',   default:'app_db',  required:true,  secret:false },
      { id:'POSTGRES_USER',      label:'Superuser',       default:'postgres', required:true,  secret:false },
      { id:'POSTGRES_PASSWORD',  label:'Superuser password', default:'',     required:true,  secret:true, generate:'random_hex_16' },
    ],
    links:[{ label:'Docs', url:'https://www.postgresql.org/docs/16/index.html' }],
    notes:'Accessible only on the private mesh network. Connect your apps using the service name as the host.',
  },
  {
    id:'redis', name:'Redis', category:'Cache',
    icon:'💾', color:T.red,
    desc:'In-memory data structure store. Cache, queue, pub/sub.',
    version:'7.2', image:'redis:7.2-alpine',
    app:{ type:'container', port:6379, persistent:false, health_check:null, replicas:1, cpu:'250m', mem:'256Mi' },
    params:[
      { id:'REDIS_PASSWORD',  label:'Password (optional)', default:'', required:false, secret:true, hint:'Leave blank for no auth (not recommended for production)' },
      { id:'MAXMEMORY',       label:'Max memory',          default:'256mb', required:false, secret:false, hint:'e.g. 256mb, 1gb' },
      { id:'MAXMEMORY_POLICY',label:'Eviction policy',     default:'allkeys-lru', required:false, secret:false },
    ],
    links:[{ label:'Docs', url:'https://redis.io/docs' }],
    notes:'For production, always set a password. Use allkeys-lru as the eviction policy for a general-purpose cache.',
  },
  {
    id:'meilisearch', name:'Meilisearch', category:'Search',
    icon:'🔍', color:T.cyan,
    desc:'Fast, typo-tolerant, open-source search engine.',
    version:'v1.6', image:'getmeili/meilisearch:v1.6',
    app:{ type:'container', port:7700, persistent:true, volume_path:'/meili_data', health_check:'/health', replicas:1, cpu:'500m', mem:'512Mi' },
    params:[
      { id:'MEILI_MASTER_KEY', label:'Master key', default:'', required:true, secret:true, generate:'random_hex_32', hint:'All API keys are derived from this. Keep it safe.' },
      { id:'MEILI_ENV',        label:'Environment', default:'production', required:false, secret:false },
    ],
    links:[{ label:'Docs', url:'https://www.meilisearch.com/docs' }],
    notes:'The master key is used to generate API keys for your applications. Changing it invalidates all existing keys.',
  },
  {
    id:'plausible', name:'Plausible Analytics', category:'Analytics',
    icon:'📊', color:T.purple,
    desc:'Privacy-friendly, lightweight web analytics. No cookies.',
    version:'v2.1', image:'ghcr.io/plausible/community-edition:v2.1',
    app:{ type:'container', port:8000, persistent:true, volume_path:'/var/lib/plausible', health_check:'/api/health', replicas:1, cpu:'500m', mem:'1Gi' },
    params:[
      { id:'BASE_URL',           label:'Public URL',       default:'',      required:true,  secret:false, hint:'https://analytics.acme.com' },
      { id:'SECRET_KEY_BASE',    label:'Secret key base',  default:'',      required:true,  secret:true,  generate:'random_hex_64' },
      { id:'DATABASE_URL',       label:'Postgres URL',     default:'',      required:true,  secret:true,  hint:'postgresql://user:pass@postgres:5432/plausible_db' },
      { id:'CLICKHOUSE_DATABASE_URL', label:'ClickHouse URL', default:'http://clickhouse:8123/plausible_events_db', required:true, secret:false },
      { id:'MAILER_EMAIL',       label:'From email',       default:'',      required:false, secret:false },
    ],
    links:[{ label:'Docs', url:'https://plausible.io/docs/self-hosting' }],
    notes:'Requires a Postgres and ClickHouse database. Deploy those first, then fill in their connection strings here.',
  },
  {
    id:'umami', name:'Umami', category:'Analytics',
    icon:'📈', color:T.green,
    desc:'Simple, fast, privacy-focused web analytics.',
    version:'v2.10', image:'ghcr.io/umami-software/umami:postgresql-latest',
    app:{ type:'container', port:3000, persistent:false, health_check:'/api/heartbeat', replicas:1, cpu:'250m', mem:'256Mi' },
    params:[
      { id:'DATABASE_URL',   label:'Postgres URL', default:'',         required:true,  secret:true,  hint:'postgresql://user:pass@postgres:5432/umami' },
      { id:'APP_SECRET',     label:'App secret',   default:'',         required:true,  secret:true,  generate:'random_hex_32' },
    ],
    links:[{ label:'Docs', url:'https://umami.is/docs' }],
    notes:'Simpler than Plausible — no ClickHouse required. Just needs a Postgres database.',
  },
  {
    id:'minio', name:'MinIO', category:'Storage',
    icon:'🪣', color:T.orange,
    desc:'High-performance S3-compatible object storage.',
    version:'latest', image:'quay.io/minio/minio:latest',
    app:{ type:'container', port:9000, persistent:true, volume_path:'/data', health_check:'/minio/health/live', replicas:1, cpu:'500m', mem:'512Mi' },
    params:[
      { id:'MINIO_ROOT_USER',     label:'Root user',     default:'minioadmin', required:true,  secret:false },
      { id:'MINIO_ROOT_PASSWORD', label:'Root password', default:'',           required:true,  secret:true, generate:'random_hex_16' },
    ],
    links:[{ label:'Docs', url:'https://min.io/docs' }],
    notes:'Console available on port 9001. S3-compatible API on port 9000. Use in your apps with the AWS SDK pointed at this host.',
  },
  {
    id:'ghost', name:'Ghost', category:'CMS',
    icon:'👻', color:T.sec,
    desc:'Professional publishing platform. Blog, newsletter, membership.',
    version:'5.x', image:'ghost:5-alpine',
    app:{ type:'container', port:2368, persistent:true, volume_path:'/var/lib/ghost/content', health_check:'/ghost/api/v4/admin/site/', replicas:1, cpu:'500m', mem:'512Mi' },
    params:[
      { id:'url',                  label:'Public URL',    default:'',      required:true,  secret:false, hint:'https://blog.acme.com' },
      { id:'database__client',     label:'DB client',     default:'mysql', required:false, secret:false },
      { id:'database__connection__host',     label:'DB host',     default:'', required:true, secret:false },
      { id:'database__connection__user',     label:'DB user',     default:'ghost', required:true, secret:false },
      { id:'database__connection__password', label:'DB password', default:'', required:true, secret:true },
      { id:'database__connection__database', label:'DB name',     default:'ghost_db', required:true, secret:false },
      { id:'mail__transport',      label:'Mail transport', default:'SMTP', required:false, secret:false },
      { id:'mail__options__host',  label:'SMTP host',      default:'',     required:false, secret:false },
    ],
    links:[{ label:'Docs', url:'https://ghost.org/docs/self-hosting' }],
    notes:'Requires a MySQL/MariaDB database. Deploy a database app first and fill in the connection details here.',
  },
];

const BLUEPRINT_CATEGORIES = ['All', ...new Set(BLUEPRINTS.map(b=>b.category))];

// ── Generate random values for params that have generate: ─────────────────────
function generateParamValue(generate) {
  if (!generate) return '';
  const len = parseInt(generate.replace(/[^0-9]/g,''))||32;
  return Array.from({length:len},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
}

// ── Blueprint param filler modal ──────────────────────────────────────────────
function BlueprintDeployModal({ blueprint, project, env, onClose, onCreated }) {
  const toast = useToast();
  // Initialize param values — auto-generate where specified
  const [values, setValues] = useState(()=>{
    const init={};
    blueprint.params.forEach(p=>{ init[p.id] = p.generate ? generateParamValue(p.generate) : (p.default||''); });
    return init;
  });
  const [revealed, setRevealed] = useState({});
  const [appName, setAppName]   = useState(blueprint.id);

  const setVal = (id,v) => setValues(vs=>({...vs,[id]:v}));

  const missing = blueprint.params.filter(p=>p.required&&!values[p.id]?.trim());

  const deploy = () => {
    if (!appName.trim()) { toast.error('Name required',''); return; }
    if (missing.length>0) { toast.error('Missing required fields', missing.map(p=>p.label).join(', ')); return; }

    const envVars = blueprint.params.map(p=>({ key:p.id, value:values[p.id], secret:p.secret||false }));
    const newApp = {
      id:'app-'+Date.now(),
      name: appName,
      type: blueprint.app.type,
      status: 'stopped',
      image: blueprint.image,
      port: blueprint.app.port,
      replicas: blueprint.app.replicas,
      cpu: 0, mem: 0, uptime: null,
      domain: null,
      persistent: blueprint.app.persistent,
      _blueprint: blueprint.id,
      _envVars: envVars,
    };
    toast.success(`${blueprint.name} created`, `${appName} — configure domain then deploy.`);
    onCreated(newApp);
    onClose();
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1300}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:560,maxHeight:'90vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>

        {/* Header */}
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',gap:14,flexShrink:0}}>
          <div style={{width:40,height:40,borderRadius:10,background:`${blueprint.color}18`,border:`1px solid ${blueprint.color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>
            {blueprint.icon}
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:T.text}}>Deploy {blueprint.name}</div>
            <div style={{fontSize:12,color:T.sec,marginTop:2}}>{project.name} · {env}</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4}}>✕</button>
        </div>

        {/* Body */}
        <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>
          {/* App name */}
          <Input
            label="App name"
            value={appName}
            onChange={e=>setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))}
            hint="Lowercase, hyphens only. Unique within this environment."
          />

          {/* Blueprint summary strip */}
          <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
            {[
              ['Image',   blueprint.image],
              ['Port',    blueprint.app.port],
              ['Storage', blueprint.app.persistent?'Persistent':'Stateless'],
              ['Memory',  blueprint.app.mem],
            ].map(([k,v])=>(
              <div key={k} style={{padding:'4px 10px',borderRadius:5,background:T.elevated,border:`0.5px solid ${T.border}`,display:'flex',gap:5,alignItems:'center'}}>
                <span style={{fontSize:10,color:T.muted}}>{k}</span>
                <span style={{fontSize:11,fontFamily:'monospace',color:T.sec,fontWeight:500}}>{v}</span>
              </div>
            ))}
          </div>

          {/* Parameters */}
          <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:12}}>Configuration</div>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {blueprint.params.map(p=>{
              const isGenerated = !!p.generate;
              const isRevealed  = revealed[p.id];
              return (
                <div key={p.id}>
                  <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
                    <label style={{fontSize:12,color:T.sec,fontWeight:500}}>{p.label}</label>
                    {p.required&&<span style={{fontSize:10,padding:'0px 5px',borderRadius:3,background:`${T.red}15`,color:T.red,border:`0.5px solid ${T.red}33`}}>required</span>}
                    {isGenerated&&<span style={{fontSize:10,padding:'0px 5px',borderRadius:3,background:`${T.green}12`,color:T.green,border:`0.5px solid ${T.green}33`}}>auto-generated</span>}
                    {p.secret&&<span style={{fontSize:10,padding:'0px 5px',borderRadius:3,background:`${T.purple}12`,color:T.purple,border:`0.5px solid ${T.purple}33`}}>secret</span>}
                  </div>
                  <div style={{display:'flex',gap:7}}>
                    <input
                      value={values[p.id]}
                      onChange={e=>setVal(p.id,e.target.value)}
                      type={p.secret&&!isRevealed?'password':'text'}
                      placeholder={p.hint||p.default||''}
                      style={{flex:1,background:T.elevated,border:`0.5px solid ${!values[p.id]&&p.required?T.red+'55':T.borderMd}`,borderRadius:6,padding:'8px 11px',fontSize:12,fontFamily:'monospace',color:T.text,outline:'none'}}
                      onFocus={e=>e.target.style.borderColor=T.blue}
                      onBlur={e=>e.target.style.borderColor=!values[p.id]&&p.required?T.red+'55':T.borderMd}
                    />
                    {p.secret&&(
                      <button onClick={()=>setRevealed(r=>({...r,[p.id]:!r[p.id]}))} style={{fontSize:11,padding:'0 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.muted,cursor:'pointer',flexShrink:0}}>{isRevealed?'hide':'show'}</button>
                    )}
                    {isGenerated&&(
                      <button onClick={()=>setVal(p.id,generateParamValue(p.generate))} style={{fontSize:11,padding:'0 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.muted,cursor:'pointer',flexShrink:0}} title="Regenerate">↺</button>
                    )}
                  </div>
                  {p.hint&&<div style={{fontSize:10,color:T.muted,marginTop:4}}>{p.hint}</div>}
                </div>
              );
            })}
          </div>

          {/* Notes */}
          {blueprint.notes&&(
            <div style={{marginTop:18,background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:7,padding:'10px 14px',fontSize:12,color:T.sec,lineHeight:'18px'}}>
              ℹ {blueprint.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div style={{display:'flex',gap:8}}>
            {blueprint.links.map(l=>(
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer" style={{fontSize:12,color:T.blue,textDecoration:'none',padding:'7px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated}}>
                {l.label} ↗
              </a>
            ))}
          </div>
          <div style={{display:'flex',gap:10}}>
            <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer'}}>Cancel</button>
            <button onClick={deploy} disabled={missing.length>0||!appName.trim()} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 22px',color:'#fff',fontSize:13,fontWeight:600,cursor:missing.length===0&&appName.trim()?'pointer':'not-allowed',opacity:missing.length===0&&appName.trim()?1:0.4}}>
              Create app →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Blueprint marketplace view ────────────────────────────────────────────────
function BlueprintMarketplaceView({ nav }) {
  const [category, setCategory] = useState('All');
  const [search, setSearch]     = useState('');
  const [selected, setSelected] = useState(null);

  const filtered = BLUEPRINTS.filter(b=>{
    const matchCat  = category==='All' || b.category===category;
    const matchSearch = !search || b.name.toLowerCase().includes(search.toLowerCase()) || b.desc.toLowerCase().includes(search.toLowerCase()) || b.category.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const exportBlueprint = (appSource) => {
    // Build a real Hub blueprint from a blueprint or a running app's config
    const source = appSource || BLUEPRINTS[0]; // fallback to n8n as example
    const bp = {
      schemaVersion: 1,
      name:          source.id || source.name?.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
      description:   source.description || source.desc || '',
      icon:          source.icon || '🧩',
      category:      source.category || 'Custom',
      version:       source.version || 'latest',
      image:         source.image,
      app: {
        type:         source.app?.type || 'container',
        port:         source.app?.port || source.port || 3000,
        persistent:   source.app?.persistent ?? source.persistent ?? false,
        volume_path:  source.app?.volume_path || null,
        health_check: source.app?.health_check || null,
        replicas:     source.app?.replicas || 1,
        cpu_limit:    source.app?.cpu || '500m',
        mem_limit:    source.app?.mem || '512Mi',
      },
      params: (source.params || []).map(p=>({
        id:            p.id || p.param_key,
        label:         p.label,
        default:       p.default_value ?? p.default ?? '',
        hint:          p.hint || null,
        required:      p.required || false,
        secret:        p.is_secret ?? p.secret ?? false,
        generate:      p.generate || null,
      })),
      notes: source.notes || null,
    };
    const filename = (bp.name||'blueprint')+'.blueprint.json';
    const blob = new Blob([JSON.stringify(bp,null,2)],{type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:1000}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>App Blueprints</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            Pre-configured deployment templates. Pick one, fill in your variables, and deploy.
          </p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>exportBlueprint(BLUEPRINTS.find(b=>b.id===selected)||null)} style={{fontSize:12,padding:'8px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>
            ↑ Export blueprint
          </button>
          <button onClick={()=>nav('provision')} style={{fontSize:12,padding:'8px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>
            ＋ Custom app
          </button>
        </div>
      </div>

      {/* Search + category filter */}
      <div style={{display:'flex',gap:10,marginBottom:22,alignItems:'center',flexWrap:'wrap'}}>
        <input
          value={search}
          onChange={e=>setSearch(e.target.value)}
          placeholder="Search blueprints…"
          style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'8px 14px',fontSize:12,color:T.text,outline:'none',width:220}}
          onFocus={e=>e.target.style.borderColor=T.blue}
          onBlur={e=>e.target.style.borderColor=T.borderMd}
        />
        <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
          {BLUEPRINT_CATEGORIES.map(c=>(
            <button key={c} onClick={()=>setCategory(c)} style={{padding:'5px 13px',borderRadius:20,border:`0.5px solid ${category===c?T.blue:T.border}`,background:category===c?`${T.blue}15`:T.elevated,color:category===c?T.blue:T.sec,fontSize:12,fontWeight:category===c?600:400,cursor:'pointer'}}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Blueprint grid */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:14}}>
        {filtered.map(bp=>{
          const isSel = selected===bp.id;
          return (
            <div key={bp.id}
              style={{background:T.card,border:`0.5px solid ${isSel?bp.color+'66':T.border}`,borderRadius:10,overflow:'hidden',cursor:'pointer',transition:'border-color 0.12s'}}
              onMouseEnter={e=>!isSel&&(e.currentTarget.style.borderColor=T.borderMd)}
              onMouseLeave={e=>!isSel&&(e.currentTarget.style.borderColor=T.border)}
            >
              {/* Card header */}
              <div style={{padding:'16px 18px 12px',borderBottom:`0.5px solid ${T.border}`}}>
                <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:10}}>
                  <div style={{width:42,height:42,borderRadius:10,background:`${bp.color}18`,border:`1px solid ${bp.color}33`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>
                    {bp.icon}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:3}}>
                      <span style={{fontSize:14,fontWeight:700,color:T.text}}>{bp.name}</span>
                      <span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`}}>{bp.version}</span>
                    </div>
                    <span style={{fontSize:10,padding:'1px 7px',borderRadius:4,background:`${bp.color}12`,color:bp.color,border:`0.5px solid ${bp.color}33`,fontWeight:500}}>{bp.category}</span>
                  </div>
                </div>
                <div style={{fontSize:12,color:T.sec,lineHeight:'17px'}}>{bp.desc}</div>
              </div>

              {/* Quick stats */}
              <div style={{display:'flex',padding:'10px 18px',gap:14,borderBottom:`0.5px solid ${T.border}`}}>
                {[
                  [':'+bp.app.port, 'port'],
                  [bp.app.persistent?'persistent':'stateless','storage'],
                  [bp.params.filter(p=>p.required).length+' required','params'],
                ].map(([v,l])=>(
                  <div key={l}>
                    <div style={{fontSize:11,fontFamily:'monospace',fontWeight:600,color:T.text}}>{v}</div>
                    <div style={{fontSize:9,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginTop:1}}>{l}</div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{padding:'10px 18px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <button
                  onClick={()=>setSelected(isSel?null:bp.id)}
                  style={{fontSize:12,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>
                  {isSel?'▲ less':'▼ details'}
                </button>
                <button
                  onClick={()=>nav('projects')}
                  style={{fontSize:12,padding:'6px 16px',borderRadius:6,border:'none',background:bp.color,color:'#fff',fontWeight:600,cursor:'pointer'}}>
                  Deploy →
                </button>
              </div>

              {/* Expanded detail */}
              {isSel&&(
                <div style={{padding:'14px 18px',background:T.elevated,borderTop:`0.5px solid ${T.border}`}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>Image</div>
                  <code style={{fontSize:11,fontFamily:'monospace',color:T.blue,background:T.card,padding:'5px 9px',borderRadius:5,border:`0.5px solid ${T.border}`,display:'block',marginBottom:12}}>{bp.image}</code>

                  <div style={{fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>Parameters ({bp.params.length})</div>
                  <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:12}}>
                    {bp.params.map(p=>(
                      <div key={p.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:11}}>
                        <code style={{fontFamily:'monospace',color:T.text,flex:1}}>{p.id}</code>
                        {p.required&&<span style={{color:T.red,fontSize:10}}>required</span>}
                        {p.generate&&<span style={{color:T.green,fontSize:10}}>auto-gen</span>}
                        {p.secret&&<span style={{color:T.purple,fontSize:10}}>secret</span>}
                      </div>
                    ))}
                  </div>

                  {bp.notes&&<div style={{fontSize:11,color:T.muted,lineHeight:'16px',borderTop:`0.5px solid ${T.border}`,paddingTop:10}}>{bp.notes}</div>}

                  <div style={{display:'flex',gap:7,marginTop:10}}>
                    {bp.links.map(l=>(
                      <a key={l.label} href={l.url} target="_blank" rel="noreferrer" style={{fontSize:11,color:T.blue,textDecoration:'none'}}>
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER RECIPES
// ═══════════════════════════════════════════════════════════════════════════════

const RECIPES_INIT = [
  {
    id:'r1', name:'Update system packages',
    description:'Runs apt-get update && apt-get upgrade -y on the target server.',
    script:'#!/bin/bash\nset -e\napt-get update\napt-get upgrade -y\necho "Done."',
    created_at: Date.now()-86400000*10, last_run_at: Date.now()-86400000*2, runs:14,
  },
  {
    id:'r2', name:'Restart nginx',
    description:'Gracefully reloads the nginx config and restarts the service.',
    script:'#!/bin/bash\nnginx -t && systemctl reload nginx\necho "nginx reloaded."',
    created_at: Date.now()-86400000*20, last_run_at: Date.now()-3600000, runs:8,
  },
  {
    id:'r3', name:'Clear Docker build cache',
    description:'Runs docker builder prune -f to free up disk space from build cache.',
    script:'#!/bin/bash\ndocker builder prune -f\ndocker system prune -f --filter "until=72h"\necho "Build cache cleared."',
    created_at: Date.now()-86400000*5, last_run_at: null, runs:0,
  },
  {
    id:'r4', name:'Check disk usage',
    description:'Shows disk usage summary for / and /var with df and du.',
    script:'#!/bin/bash\necho "=== Disk usage ==="\ndf -h /\necho ""\necho "=== Top 10 largest dirs in /var ==="\ndu -sh /var/* 2>/dev/null | sort -rh | head -10',
    created_at: Date.now()-86400000*3, last_run_at: Date.now()-86400000, runs:6,
  },
  {
    id:'r5', name:'Show running containers',
    description:'Lists all running Docker containers with resource usage.',
    script:'#!/bin/bash\ndocker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"\necho ""\ndocker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}"',
    created_at: Date.now()-86400000*7, last_run_at: Date.now()-7200000, runs:22,
  },
];

function RecipesView() {
  const toast = useToast();
  const [recipes,   setRecipes]   = useState(RECIPES_INIT);
  const [selected,  setSelected]  = useState(null);  // recipe being viewed/edited
  const [showNew,   setShowNew]   = useState(false);
  const [running,   setRunning]   = useState({});     // { runKey: 'running' | output_lines[] }
  const [targetServer, setTarget] = useState('all');

  // New recipe form
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newScript,setNewScript]=useState('#!/bin/bash\nset -e\n\n');

  // Simulated output lines for a run
  const FAKE_OUTPUTS = {
    'r1': ['Reading package lists...', 'Building dependency tree...', 'Reading state information...', 'Calculating upgrade...', '12 packages upgraded, 0 newly installed.', 'Done.'],
    'r2': ['nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful', 'nginx reloaded.'],
    'r3': ['Deleted build cache objects:', '  a1b2c3d4e5f6 (2.3 GB)', '  f6e5d4c3b2a1 (1.1 GB)', 'Total reclaimed space: 3.4 GB', 'Build cache cleared.'],
    'r4': ['=== Disk usage ===', 'Filesystem      Size  Used Avail Use% Mounted on', '/dev/vda1        79G   42G   34G  55% /', '', '=== Top 10 largest dirs in /var ===', '14G\t/var/lib/docker', '2.3G\t/var/log', '180M\t/var/cache'],
    'r5': ['NAMES                  STATUS         PORTS', 'nginx-proxy            Up 14 days     0.0.0.0:80->80/tcp', 'dashboard-web-1        Up 3 hours     127.0.0.1:3000->3000/tcp', 'postgres-primary       Up 14 days     127.0.0.1:5432->5432/tcp', '', 'NAME                  CPU %    MEM USAGE', 'nginx-proxy           0.02%    42MiB / 4GiB', 'dashboard-web-1       0.8%     180MiB / 4GiB', 'postgres-primary      2.1%     612MiB / 4GiB'],
  };

  const runRecipe = (recipe, serverId) => {
    const runKey = recipe.id + ':' + (serverId||'all');
    const servers = serverId==='all' ? SERVERS.filter(s=>s.status==='online') : SERVERS.filter(s=>s.id===serverId);
    if (servers.length===0) { toast.error('No online servers','No servers are online to run this recipe.'); return; }

    setRunning(r=>({...r,[runKey]:'running'}));
    const outputLines = FAKE_OUTPUTS[recipe.id] || ['Running script…', 'Done.'];

    let lineIdx = 0;
    const interval = setInterval(()=>{
      lineIdx++;
      setRunning(r=>({...r,[runKey]: outputLines.slice(0,lineIdx)}));
      if (lineIdx>=outputLines.length) {
        clearInterval(interval);
        setRecipes(rs=>rs.map(r=>r.id===recipe.id?{...r,last_run_at:Date.now(),runs:r.runs+servers.length}:r));
        toast.success('Recipe complete', `${recipe.name} ran on ${servers.length} server${servers.length>1?'s':''}`);
      }
    }, 200);
  };

  const createRecipe = () => {
    if (!newName.trim()) { toast.error('Name required',''); return; }
    const r = { id:'r'+Date.now(), name:newName, description:newDesc, script:newScript, created_at:Date.now(), last_run_at:null, runs:0 };
    setRecipes(rs=>[...rs,r]);
    toast.success('Recipe created', newName);
    setShowNew(false); setNewName(''); setNewDesc(''); setNewScript('#!/bin/bash\nset -e\n\n');
  };

  const deleteRecipe = r => {
    setRecipes(rs=>rs.filter(x=>x.id!==r.id));
    if (selected?.id===r.id) setSelected(null);
    toast.success('Recipe deleted', r.name);
  };

  return (
    <div style={{padding:'28px 30px', maxWidth:1000}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Server Recipes</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>Saved shell scripts you can run on-demand across any server in the fleet.</p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <select value={targetServer} onChange={e=>setTarget(e.target.value)} style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'8px 12px',fontSize:12,color:T.text,outline:'none',cursor:'pointer'}}>
            <option value="all">All online servers</option>
            {SERVERS.filter(s=>s.status==='online').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={()=>setShowNew(v=>!v)} style={{padding:'9px 16px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New recipe</button>
        </div>
      </div>

      {/* New recipe form */}
      {showNew&&(
        <div style={{background:T.card,border:`0.5px solid ${T.borderMd}`,borderRadius:10,padding:'18px 20px',marginBottom:20}}>
          <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:14}}>New recipe</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
            <Input label="Name" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Restart nginx"/>
            <Input label="Description" value={newDesc} onChange={e=>setNewDesc(e.target.value)} placeholder="Briefly what this script does"/>
          </div>
          <div style={{marginBottom:14}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:6,fontWeight:500}}>Script</label>
            <textarea
              value={newScript}
              onChange={e=>setNewScript(e.target.value)}
              rows={8}
              style={{width:'100%',boxSizing:'border-box',background:'#090b11',border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'12px 14px',fontSize:12,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'20px',outline:'none',resize:'vertical'}}
            />
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setShowNew(false)} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:'none',color:T.sec,cursor:'pointer'}}>Cancel</button>
            <button onClick={createRecipe} style={{fontSize:12,padding:'7px 16px',borderRadius:6,border:'none',background:T.blue,color:'#fff',cursor:'pointer',fontWeight:600}}>Save recipe</button>
          </div>
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:14}}>
        {/* Recipe list */}
        <div style={{display:'flex',flexDirection:'column',gap:7}}>
          {recipes.map(r=>{
            const isSel = selected?.id===r.id;
            const runKey = r.id+':'+(targetServer||'all');
            const isRunning = running[runKey]==='running';
            return (
              <div key={r.id} onClick={()=>setSelected(r)} style={{background:isSel?T.elevated:T.card,border:`0.5px solid ${isSel?T.blue:T.border}`,borderRadius:8,padding:'12px 14px',cursor:'pointer',transition:'border-color 0.12s'}}
                onMouseEnter={e=>!isSel&&(e.currentTarget.style.borderColor=T.borderMd)}
                onMouseLeave={e=>!isSel&&(e.currentTarget.style.borderColor=T.border)}>
                <div style={{fontSize:13,fontWeight:600,color:isSel?T.text:T.sec,marginBottom:3}}>{r.name}</div>
                <div style={{fontSize:11,color:T.muted,marginBottom:8,lineHeight:'15px'}}>{r.description}</div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,color:T.muted}}>{r.runs} run{r.runs!==1?'s':''}</span>
                  {r.last_run_at&&<span style={{fontSize:10,color:T.muted}}>· {fmtAge(r.last_run_at)}</span>}
                  <button
                    onClick={e=>{e.stopPropagation();runRecipe(r,targetServer==='all'?'all':targetServer);}}
                    disabled={isRunning}
                    style={{marginLeft:'auto',fontSize:11,padding:'3px 10px',borderRadius:4,border:'none',background:isRunning?T.elevated:T.blue,color:isRunning?T.muted:'#fff',cursor:isRunning?'not-allowed':'pointer',fontWeight:600,display:'flex',alignItems:'center',gap:5}}>
                    {isRunning?<><span style={{display:'inline-block',width:9,height:9,border:'1.5px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Running</>:'▶ Run'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Recipe detail + output */}
        <div>
          {selected ? (
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {/* Script editor */}
              <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
                <div style={{padding:'12px 16px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontSize:13,fontWeight:600,color:T.text,flex:1}}>{selected.name}</span>
                  <button onClick={()=>deleteRecipe(selected)} style={{fontSize:11,padding:'3px 9px',borderRadius:4,border:`0.5px solid ${T.red}33`,background:`${T.red}08`,color:T.red,cursor:'pointer'}}>Delete</button>
                </div>
                <div style={{padding:'14px 16px',background:'#090b11'}}>
                  <pre style={{margin:0,fontSize:12,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'20px',whiteSpace:'pre-wrap'}}>{selected.script}</pre>
                </div>
              </div>

              {/* Run output */}
              {Object.entries(running).filter(([k])=>k.startsWith(selected.id+':')).map(([runKey,output])=>(
                <div key={runKey} style={{background:'#090b11',border:`0.5px solid ${output==='running'?T.blue+'44':T.green+'44'}`,borderRadius:8,overflow:'hidden'}}>
                  <div style={{padding:'8px 14px',borderBottom:`0.5px solid ${output==='running'?T.blue+'22':T.green+'22'}`,display:'flex',alignItems:'center',gap:8,background:'#0d1117'}}>
                    {output==='running'
                      ? <><span style={{display:'inline-block',width:10,height:10,border:'1.5px solid '+T.blue,borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/><span style={{fontSize:11,color:T.blue,fontWeight:600}}>Running on {runKey.split(':')[1]==='all'?'all servers':SERVERS.find(s=>s.id===runKey.split(':')[1])?.name||'server'}…</span></>
                      : <><span style={{fontSize:11,color:T.green}}>●</span><span style={{fontSize:11,color:T.green,fontWeight:600}}>Complete</span></>
                    }
                    <span style={{fontSize:10,color:T.muted,marginLeft:'auto'}}>
                      {runKey.split(':')[1]==='all'?`${SERVERS.filter(s=>s.status==='online').length} servers`:(SERVERS.find(s=>s.id===runKey.split(':')[1])?.name||'server')}
                    </span>
                  </div>
                  <div style={{padding:'12px 14px',maxHeight:240,overflowY:'auto'}}>
                    {Array.isArray(output) ? output.map((line,i)=>(
                      <div key={i} style={{fontSize:11,fontFamily:'monospace',color: line.startsWith('===')?T.cyan: line.includes('error')||line.includes('Error')?T.red: line.includes('Done')||line.includes('complete')||line.includes('ok')?T.green:'#e2e8f0',lineHeight:'20px',whiteSpace:'pre-wrap'}}>{line||'\u00a0'}</div>
                    )) : <div style={{fontSize:11,color:T.muted}}>Waiting for output…</div>}
                  </div>
                </div>
              ))}

              {!Object.keys(running).some(k=>k.startsWith(selected.id+':'))&&(
                <div style={{padding:'20px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8}}>
                  <div style={{fontSize:12,color:T.muted,marginBottom:12}}>Select servers and click ▶ Run to execute this recipe.</div>
                  <button onClick={()=>runRecipe(selected,targetServer==='all'?'all':targetServer)} style={{padding:'8px 20px',borderRadius:6,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>▶ Run now</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{padding:'40px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9}}>
              <div style={{fontSize:28,marginBottom:10}}>📜</div>
              <div style={{fontSize:13,color:T.sec}}>Select a recipe to view its script and run output.</div>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUB BACKUP & RESTORE
// ═══════════════════════════════════════════════════════════════════════════════

const BACKUP_HISTORY = [
  { id:'bk1', type:'manual',    size:'14.2 MB', created_at: Date.now()-3600000*2,    status:'complete', dest:'local' },
  { id:'bk2', type:'scheduled', size:'13.9 MB', created_at: Date.now()-86400000,     status:'complete', dest:'s3'    },
  { id:'bk3', type:'scheduled', size:'13.7 MB', created_at: Date.now()-86400000*2,   status:'complete', dest:'s3'    },
  { id:'bk4', type:'scheduled', size:'13.1 MB', created_at: Date.now()-86400000*3,   status:'complete', dest:'s3'    },
  { id:'bk5', type:'scheduled', size:'12.8 MB', created_at: Date.now()-86400000*7,   status:'complete', dest:'s3'    },
];

function HubBackupView() {
  const toast = useToast();
  const [backing,  setBacking]   = useState(false);
  const [restoring,setRestoring] = useState(false);
  const [history,  setHistory]   = useState(BACKUP_HISTORY);
  const [schedOn,  setSchedOn]   = useState(true);
  const [schedCron2,setSchedCron2]=useState('0 2 * * *');
  const [s3Bucket, setS3Bucket]  = useState('acme-hub-backups');
  const [s3Region, setS3Region]  = useState('us-east-1');
  const [s3Key,    setS3Key]     = useState('');
  const [s3Secret, setS3Secret]  = useState('');
  const [s3Saved,  setS3Saved]   = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);

  const doBackup = () => {
    setBacking(true);
    const t = toast.loading('Creating backup…', 'Dumping hub.db + config');
    setTimeout(()=>{
      setBacking(false);
      const newBk = { id:'bk'+Date.now(), type:'manual', size:'14.3 MB', created_at:Date.now(), status:'complete', dest:'local' };
      setHistory(h=>[newBk,...h]);
      t.update('success','Backup ready', 'hub-backup-'+new Date().toISOString().slice(0,10)+'.zip · 14.3 MB');
      // Simulate download
      const blob = new Blob([JSON.stringify({hub_backup:true,version:'1.0',created_at:new Date().toISOString(),note:'Platform Hub backup — hub.db + config'})],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='hub-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();
    }, 2000);
  };

  const doRestore = () => {
    if (!restoreFile) { toast.error('No file selected','Upload a backup file first.'); return; }
    setRestoring(true);
    const t = toast.loading('Restoring…','This will restart Hub after restore. Do not close this tab.');
    setTimeout(()=>{
      setRestoring(false);
      t.update('success','Restore complete','Hub has been restored. Refresh to reload.');
    }, 3500);
  };

  const saveS3 = () => {
    toast.success('S3 config saved','Scheduled backups will upload to '+s3Bucket);
    setS3Saved(true);
    setTimeout(()=>setS3Saved(false),2000);
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:760}}>
      <SysHeader title="Hub Backup &amp; Restore" sub="Back up the entire Hub database and config. Restore from any previous backup."/>

      {/* Warning */}
      <div style={{background:`${T.amber}10`,border:`0.5px solid ${T.amber}33`,borderRadius:8,padding:'12px 16px',marginBottom:24,display:'flex',gap:10,alignItems:'flex-start'}}>
        <span style={{fontSize:16,flexShrink:0}}>⚠</span>
        <div style={{fontSize:12,color:T.sec,lineHeight:'18px'}}>
          Backup includes <code style={{fontFamily:'monospace',color:T.text}}>hub.db</code> (all workspaces, projects, servers, deployments) and Hub config. It does <strong style={{color:T.text}}>not</strong> include Docker volumes or container data — back those up separately per app.
        </div>
      </div>

      {/* Manual backup */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',marginBottom:16}}>
        <SecHead title="Manual backup"/>
        <div style={{fontSize:12,color:T.sec,marginBottom:14}}>
          Creates a snapshot of <code style={{fontFamily:'monospace'}}>hub.db</code> and all config files, zipped and downloaded to your browser.
        </div>
        <button onClick={doBackup} disabled={backing} style={{display:'flex',alignItems:'center',gap:8,padding:'9px 20px',borderRadius:7,border:'none',background:backing?T.elevated:T.blue,color:backing?T.muted:'#fff',fontSize:13,fontWeight:600,cursor:backing?'not-allowed':'pointer'}}>
          {backing?<><span style={{display:'inline-block',width:12,height:12,border:'2px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>Creating backup…</>:'⬇ Download backup now'}
        </button>
      </div>

      {/* Scheduled + S3 */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',marginBottom:16}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <SecHead title="Scheduled backups"/>
          <div onClick={()=>setSchedOn(v=>!v)} style={{width:40,height:22,borderRadius:11,background:schedOn?T.green:T.elevated,border:`0.5px solid ${schedOn?T.green:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s'}}>
            <div style={{position:'absolute',top:2,left:schedOn?20:2,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
          </div>
        </div>
        {schedOn&&(
          <div>
            <div style={{marginBottom:14}}>
              <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Schedule</label>
              <CronBuilder value={schedCron2} onChange={setSchedCron2}/>
            </div>
            <div style={{padding:'10px 14px',background:T.elevated,borderRadius:7,marginBottom:14,fontSize:12,color:T.sec,display:'flex',gap:8,alignItems:'center'}}>
              <span>Next backup:</span>
              <span style={{color:T.text,fontWeight:500}}>{describeCron(schedCron2)}</span>
            </div>

            <div style={{borderTop:`0.5px solid ${T.border}`,paddingTop:14}}>
              <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:12}}>S3 destination</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
                <Input label="Bucket" value={s3Bucket} onChange={e=>setS3Bucket(e.target.value)} mono placeholder="my-hub-backups"/>
                <Input label="Region" value={s3Region} onChange={e=>setS3Region(e.target.value)} mono placeholder="us-east-1"/>
                <Input label="Access key ID" value={s3Key}    onChange={e=>setS3Key(e.target.value)}    mono type="password" placeholder="AKIA…"/>
                <Input label="Secret access key" value={s3Secret} onChange={e=>setS3Secret(e.target.value)} mono type="password" placeholder="…"/>
              </div>
              <div style={{fontSize:11,color:T.muted,marginBottom:12}}>
                Compatible with AWS S3, Cloudflare R2, MinIO, and any S3-compatible store. Backups are encrypted before upload using the <code style={{fontFamily:'monospace'}}>AUTH_SECRET</code>.
              </div>
              <button onClick={saveS3} style={{padding:'7px 18px',borderRadius:6,border:'none',background:s3Saved?T.green:T.blue,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer',transition:'background 0.2s'}}>
                {s3Saved?'✓ Saved':'Save S3 config'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Restore */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:'18px 20px',marginBottom:16}}>
        <SecHead title="Restore from backup"/>
        <div style={{background:`${T.red}08`,border:`0.5px solid ${T.red}33`,borderRadius:7,padding:'10px 14px',marginBottom:14,fontSize:12,color:T.red}}>
          ⚠ Restoring will <strong>replace all current data</strong> and restart Hub. This cannot be undone. Make a fresh backup first.
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          <label style={{display:'flex',alignItems:'center',gap:10,padding:'9px 14px',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,cursor:'pointer',flex:1}}>
            <span style={{fontSize:13,color:restoreFile?T.text:T.muted}}>
              {restoreFile ? restoreFile.name : 'Choose backup file (.json or .zip)…'}
            </span>
            <input type="file" accept=".json,.zip" style={{display:'none'}} onChange={e=>setRestoreFile(e.target.files[0]||null)}/>
          </label>
          <button onClick={doRestore} disabled={!restoreFile||restoring} style={{padding:'9px 18px',borderRadius:7,border:'none',background:restoreFile&&!restoring?T.red:T.elevated,color:restoreFile&&!restoring?'#fff':T.muted,fontSize:13,fontWeight:600,cursor:restoreFile&&!restoring?'pointer':'not-allowed',flexShrink:0}}>
            {restoring?'Restoring…':'Restore'}
          </button>
        </div>
      </div>

      {/* Backup history */}
      <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
        <div style={{padding:'12px 18px',borderBottom:`0.5px solid ${T.border}`,fontSize:12,fontWeight:600,color:T.text}}>Backup history</div>
        {history.map((bk,i)=>(
          <div key={bk.id} style={{display:'flex',alignItems:'center',gap:12,padding:'11px 18px',borderBottom:i<history.length-1?`0.5px solid ${T.border}`:'none'}}>
            <span style={{fontSize:16}}>{bk.dest==='s3'?'☁':'💾'}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:500,color:T.text,marginBottom:2}}>
                {bk.type==='manual'?'Manual backup':'Scheduled backup'}
                <span style={{fontSize:10,marginLeft:8,padding:'1px 6px',borderRadius:3,background:`${T.green}15`,color:T.green,border:`0.5px solid ${T.green}33`}}>{bk.status}</span>
              </div>
              <div style={{fontSize:11,color:T.muted}}>{new Date(bk.created_at).toLocaleString()} · {bk.size} · {bk.dest==='s3'?`s3://${s3Bucket}`:' local download'}</div>
            </div>
            <button onClick={()=>toast.success('Download started','hub-backup-'+new Date(bk.created_at).toISOString().slice(0,10)+'.json')} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>⬇ Download</button>
            <button onClick={()=>{setRestoreFile({name:'hub-backup-'+new Date(bk.created_at).toISOString().slice(0,10)+'.json'});}} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.amber}44`,background:`${T.amber}08`,color:T.amber,cursor:'pointer'}}>↩ Restore</button>
          </div>
        ))}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE DNS HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

const CF_ZONES = [
  {
    id:'z1', name:'acme.com', plan:'Pro', ssl_mode:'Full (strict)',
    universal_ssl:true, always_https:true, min_tls:'1.2',
    analytics:{ requests:142800, cached:89200, bandwidth_gb:4.2, threats:12 },
    records:[
      { id:'r1',  type:'A',     name:'@',           content:'203.0.113.10',  proxied:true,  ttl:'auto', app:'prod-web-01'     },
      { id:'r2',  type:'A',     name:'www',         content:'203.0.113.10',  proxied:true,  ttl:'auto', app:'prod-web-01'     },
      { id:'r3',  type:'A',     name:'api',         content:'203.0.113.11',  proxied:true,  ttl:'auto', app:'prod-web-02'     },
      { id:'r4',  type:'A',     name:'n8n',         content:'203.0.113.14',  proxied:true,  ttl:'auto', app:'n8n'             },
      { id:'r5',  type:'A',     name:'analytics',   content:'203.0.113.14',  proxied:true,  ttl:'auto', app:'plausible'       },
      { id:'r6',  type:'CNAME', name:'mail',        content:'mail.acme.com', proxied:false, ttl:3600,   app:null              },
      { id:'r7',  type:'MX',    name:'@',           content:'aspmx.l.google.com', proxied:false, ttl:3600, app:null          },
      { id:'r8',  type:'TXT',   name:'@',           content:'v=spf1 include:_spf.google.com ~all', proxied:false, ttl:3600, app:null },
      { id:'r9',  type:'A',     name:'stg',         content:'203.0.113.20',  proxied:false, ttl:3600,   app:'stg-app-01'      },
    ],
  },
  {
    id:'z2', name:'acme.io', plan:'Free', ssl_mode:'Flexible',
    universal_ssl:true, always_https:false, min_tls:'1.0',
    analytics:{ requests:4200, cached:1800, bandwidth_gb:0.3, threats:2 },
    records:[
      { id:'r10', type:'A',     name:'@',           content:'203.0.113.10',  proxied:true,  ttl:'auto', app:'prod-web-01'     },
      { id:'r11', type:'A',     name:'www',         content:'203.0.113.10',  proxied:true,  ttl:'auto', app:'prod-web-01'     },
    ],
  },
];

function CloudflareView() {
  const toast = useToast();
  const [zones]        = useState(CF_ZONES);
  const [activeZone,   setActiveZone]   = useState(CF_ZONES[0].id);
  const [tab,          setTab]          = useState('dns');
  const [filterType,   setFilterType]   = useState('all');
  const [search,       setSearch]       = useState('');
  const [syncing,      setSyncing]      = useState(false);

  const zone = zones.find(z=>z.id===activeZone);
  const cacheHitPct = zone ? Math.round(zone.analytics.cached/zone.analytics.requests*100) : 0;

  const filteredRecords = (zone?.records||[]).filter(r=>{
    const matchType   = filterType==='all' || r.type===filterType;
    const matchSearch = !search || r.name.includes(search) || r.content.includes(search);
    return matchType && matchSearch;
  });

  const sslIssues = zones.filter(z=>z.ssl_mode==='Flexible'||z.ssl_mode==='Off');

  const sync = () => {
    setSyncing(true);
    setTimeout(()=>{ setSyncing(false); toast.success('Synced','Cloudflare data refreshed.'); }, 1400);
  };

  const SSL_MODE_COLOR = { 'Full (strict)':T.green, 'Full':T.amber, 'Flexible':T.red, 'Off':T.red };

  return (
    <div style={{padding:'28px 30px',maxWidth:980}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:5}}>
            <div style={{width:30,height:30,borderRadius:7,background:'#f38020',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>☁</div>
            <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Cloudflare</h2>
          </div>
          <p style={{margin:0,fontSize:13,color:T.sec}}>{zones.length} zones · DNS + proxy + SSL health</p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={sync} disabled={syncing} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
            {syncing?<span style={{display:'inline-block',width:10,height:10,border:'1.5px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>:'↺'} Sync
          </button>
          <select value={activeZone} onChange={e=>setActiveZone(e.target.value)} style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:7,padding:'7px 12px',fontSize:13,color:T.text,outline:'none',cursor:'pointer'}}>
            {zones.map(z=><option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </div>
      </div>

      {/* SSL warning banner */}
      {sslIssues.length>0&&(
        <div style={{background:`${T.red}08`,border:`0.5px solid ${T.red}33`,borderRadius:8,padding:'10px 16px',marginBottom:16,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:16}}>⚠</span>
          <div style={{fontSize:12,color:T.sec}}>
            <strong style={{color:T.red}}>{sslIssues.map(z=>z.name).join(', ')}</strong> {sslIssues.length>1?'are':'is'} using <strong style={{color:T.red}}>{sslIssues[0].ssl_mode}</strong> SSL mode. This is insecure — change to <strong style={{color:T.text}}>Full (Strict)</strong> in the Cloudflare dashboard.
          </div>
        </div>
      )}

      {/* Zone stats strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,marginBottom:20}}>
        <StatCard label="SSL mode"    value={zone?.ssl_mode||'—'}               sub="CF → origin"       color={SSL_MODE_COLOR[zone?.ssl_mode]||T.muted}/>
        <StatCard label="Requests"    value={(zone?.analytics.requests/1000).toFixed(1)+'k'} sub="last 24h"/>
        <StatCard label="Cache hit"   value={cacheHitPct+'%'}                  sub="bandwidth saved"   color={cacheHitPct>70?T.green:T.amber}/>
        <StatCard label="Bandwidth"   value={zone?.analytics.bandwidth_gb+'GB'} sub="origin egress"/>
        <StatCard label="Threats"     value={zone?.analytics.threats||0}        sub="blocked"           color={zone?.analytics.threats>0?T.amber:T.text}/>
      </div>

      {/* Zone config pills */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {[
          ['Always HTTPS', zone?.always_https, zone?.always_https?T.green:T.red],
          ['Universal SSL', zone?.universal_ssl, zone?.universal_ssl?T.green:T.red],
          ['Min TLS', zone?.min_tls, zone?.min_tls==='1.2'||zone?.min_tls==='1.3'?T.green:T.amber],
          ['Plan', zone?.plan, T.blue],
        ].map(([label,val,color])=>(
          <div key={label} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:5,background:T.elevated,border:`0.5px solid ${T.border}`}}>
            <span style={{fontSize:10,color:T.muted}}>{label}</span>
            <span style={{fontSize:11,fontWeight:600,color}}>{val===true?'On':val===false?'Off':val}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`,marginBottom:18}}>
        {['dns','ssl-chain','analytics'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'7px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,textTransform:'capitalize'}}>
            {t==='ssl-chain'?'SSL Chain':t==='dns'?'DNS Records':'Analytics'}
          </button>
        ))}
      </div>

      {/* DNS Records */}
      {tab==='dns'&&(
        <div>
          <div style={{display:'flex',gap:8,marginBottom:14,alignItems:'center',flexWrap:'wrap'}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter records…" style={{background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'7px 12px',fontSize:12,color:T.text,outline:'none',width:200}}/>
            <div style={{display:'flex',gap:3,background:T.elevated,borderRadius:6,padding:3}}>
              {['all','A','CNAME','MX','TXT'].map(t=>(
                <button key={t} onClick={()=>setFilterType(t)} style={{padding:'4px 10px',borderRadius:4,border:'none',cursor:'pointer',fontSize:11,fontWeight:filterType===t?600:400,background:filterType===t?T.card:'transparent',color:filterType===t?T.text:T.sec}}>{t}</button>
              ))}
            </div>
            <span style={{fontSize:11,color:T.muted,marginLeft:'auto'}}>{filteredRecords.length} records</span>
          </div>

          <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
            <div style={{display:'grid',gridTemplateColumns:'60px 130px 1fr 100px 80px 160px',gap:0,padding:'8px 16px',background:T.elevated,borderBottom:`0.5px solid ${T.border}`}}>
              {['Type','Name','Content','Proxied','TTL','Hub app'].map(h=>(
                <span key={h} style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',fontWeight:500}}>{h}</span>
              ))}
            </div>
            {filteredRecords.map((r,i)=>{
              const hubApp = r.app;
              const isProxied = r.proxied;
              return (
                <div key={r.id} style={{display:'grid',gridTemplateColumns:'60px 130px 1fr 100px 80px 160px',gap:0,alignItems:'center',padding:'10px 16px',borderBottom:i<filteredRecords.length-1?`0.5px solid ${T.border}`:'none',background:hubApp?`${T.blue}04`:'transparent'}}>
                  <span style={{fontSize:10,padding:'2px 7px',borderRadius:3,background:`${r.type==='A'?T.blue:r.type==='CNAME'?T.cyan:r.type==='MX'?T.purple:T.muted}18`,color:r.type==='A'?T.blue:r.type==='CNAME'?T.cyan:r.type==='MX'?T.purple:T.muted,fontWeight:600,fontFamily:'monospace',width:'fit-content'}}>{r.type}</span>
                  <span style={{fontSize:12,fontFamily:'monospace',fontWeight:600,color:T.text}}>{r.name}</span>
                  <span style={{fontSize:11,fontFamily:'monospace',color:T.sec,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:8}}>{r.content}</span>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <span style={{fontSize:16}}>{isProxied?'🟠':'⚫'}</span>
                    <span style={{fontSize:11,color:isProxied?'#f38020':T.muted}}>{isProxied?'Proxied':'DNS only'}</span>
                  </div>
                  <span style={{fontSize:11,color:T.muted,fontFamily:'monospace'}}>{r.ttl==='auto'?'Auto':r.ttl+'s'}</span>
                  <div>
                    {hubApp
                      ? <span style={{fontSize:10,padding:'2px 8px',borderRadius:4,background:`${T.blue}15`,color:T.blue,border:`0.5px solid ${T.blue}33`,fontFamily:'monospace'}}>{hubApp}</span>
                      : <span style={{fontSize:10,color:T.muted}}>—</span>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SSL Chain */}
      {tab==='ssl-chain'&&(
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          {(zone?.records||[]).filter(r=>r.proxied&&r.type==='A'&&r.app).map(r=>{
            const sslOk = zone.ssl_mode==='Full (strict)';
            return (
              <div key={r.id} style={{background:T.card,border:`0.5px solid ${sslOk?T.green+'33':T.red+'33'}`,borderRadius:9,padding:'14px 18px'}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
                  <span style={{fontSize:13,fontFamily:'monospace',fontWeight:600,color:T.text}}>{r.name==='@'?zone.name:`${r.name}.${zone.name}`}</span>
                  <Pill label={r.app} color={T.blue}/>
                </div>
                {/* Chain visualization */}
                <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                  {[
                    { label:'Browser', icon:'🌐', status:'ok', detail:'HTTPS' },
                    { label:'Cloudflare', icon:'🟠', status:zone.universal_ssl?'ok':'error', detail:zone.universal_ssl?'Universal SSL':'No SSL' },
                    { label:'CF → Origin', icon:'🔒', status:sslOk?'ok':'warn', detail:zone.ssl_mode },
                    { label:'Origin cert', icon:'📄', status:'ok', detail:'Valid · 15yr' },
                    { label:`${r.app}`, icon:'📦', status:'ok', detail:r.content },
                  ].map((node,ni,arr)=>(
                    <React.Fragment key={node.label}>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,padding:'8px 12px',borderRadius:7,background:T.elevated,border:`0.5px solid ${node.status==='ok'?T.green+'33':node.status==='warn'?T.amber+'33':T.red+'33'}`,minWidth:90}}>
                        <span style={{fontSize:18}}>{node.icon}</span>
                        <span style={{fontSize:10,color:T.muted,textAlign:'center'}}>{node.label}</span>
                        <span style={{fontSize:10,color:node.status==='ok'?T.green:node.status==='warn'?T.amber:T.red,fontWeight:600,textAlign:'center'}}>{node.detail}</span>
                      </div>
                      {ni<arr.length-1&&<span style={{color:T.muted,fontSize:16,flexShrink:0}}>→</span>}
                    </React.Fragment>
                  ))}
                </div>
                {!sslOk&&<div style={{marginTop:10,fontSize:11,color:T.amber,padding:'6px 10px',background:`${T.amber}08`,borderRadius:5}}>⚠ SSL mode is "{zone.ssl_mode}" — change to Full (Strict) to encrypt traffic between Cloudflare and your origin server.</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Analytics */}
      {tab==='analytics'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          {[
            { label:'Total requests (24h)', value:(zone?.analytics.requests||0).toLocaleString(), color:T.blue },
            { label:'Cached requests',      value:(zone?.analytics.cached||0).toLocaleString(),   color:T.green },
            { label:'Cache hit rate',       value:cacheHitPct+'%',                                 color:cacheHitPct>70?T.green:T.amber },
            { label:'Bandwidth served',     value:(zone?.analytics.bandwidth_gb||0)+' GB',         color:T.text },
            { label:'Threats blocked',      value:(zone?.analytics.threats||0)+'',                color:zone?.analytics.threats>0?T.amber:T.green },
            { label:'Origin requests',      value:((zone?.analytics.requests||0)-(zone?.analytics.cached||0)).toLocaleString(), color:T.muted },
          ].map(s=>(
            <div key={s.label} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'16px 18px'}}>
              <div style={{fontSize:11,color:T.muted,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.07em'}}>{s.label}</div>
              <div style={{fontSize:26,fontWeight:800,color:s.color,letterSpacing:'-0.02em'}}>{s.value}</div>
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIGITALOCEAN SPEND
// ═══════════════════════════════════════════════════════════════════════════════

const DO_DROPLET_COSTS = [
  { id:'s1', name:'prod-web-01',    plan:'s-2vcpu-4gb',  price:24,  bandwidth_used:2.1, bandwidth_limit:4,  region:'nyc3', snapshot_count:3, backups_enabled:true,  backup_price:4.8  },
  { id:'s2', name:'prod-web-02',    plan:'s-2vcpu-4gb',  price:24,  bandwidth_used:1.8, bandwidth_limit:4,  region:'nyc3', snapshot_count:3, backups_enabled:true,  backup_price:4.8  },
  { id:'s3', name:'prod-db-01',     plan:'s-4vcpu-8gb',  price:48,  bandwidth_used:0.4, bandwidth_limit:5,  region:'nyc3', snapshot_count:5, backups_enabled:true,  backup_price:9.6  },
  { id:'s4', name:'prod-worker-01', plan:'s-2vcpu-4gb',  price:24,  bandwidth_used:0.2, bandwidth_limit:4,  region:'nyc3', snapshot_count:1, backups_enabled:false, backup_price:0    },
  { id:'s5', name:'build-runner-01',plan:'s-4vcpu-8gb',  price:48,  bandwidth_used:1.2, bandwidth_limit:5,  region:'sfo3', snapshot_count:0, backups_enabled:false, backup_price:0    },
  { id:'s6', name:'stg-app-01',     plan:'s-1vcpu-2gb',  price:12,  bandwidth_used:0.1, bandwidth_limit:2,  region:'sfo3', snapshot_count:1, backups_enabled:false, backup_price:0    },
];

const DO_VOLUMES = [
  { id:'v1', name:'prod-db-data',   size_gb:100, attached_to:'prod-db-01',   price_month:10,  region:'nyc3' },
  { id:'v2', name:'prod-db-backup', size_gb:50,  attached_to:'prod-db-01',   price_month:5,   region:'nyc3' },
  { id:'v3', name:'old-scratch',    size_gb:25,  attached_to:null,            price_month:2.5, region:'nyc3' },
];

const DO_FLOATING_IPS = [
  { id:'f1', ip:'203.0.113.10', assigned_to:'prod-web-01', region:'nyc3', price_month:4 },
  { id:'f2', ip:'203.0.113.11', assigned_to:'prod-web-02', region:'nyc3', price_month:4 },
  { id:'f3', ip:'203.0.113.99', assigned_to:null,          region:'sfo3', price_month:4 },
];

function DigitalOceanView() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [syncing, setSyncing] = useState(false);

  const currentDay   = 19;
  const daysInMonth  = 31;
  const dayFraction  = currentDay / daysInMonth;

  const dropletTotal  = DO_DROPLET_COSTS.reduce((a,d)=>a+d.price,0);
  const backupTotal   = DO_DROPLET_COSTS.reduce((a,d)=>a+d.backup_price,0);
  const volumeTotal   = DO_VOLUMES.reduce((a,v)=>a+v.price_month,0);
  const floatingTotal = DO_FLOATING_IPS.reduce((a,f)=>a+f.price_month,0);
  const snapshotTotal = 3.2; // rough estimate from snapshot storage
  const monthTotal    = dropletTotal + backupTotal + volumeTotal + floatingTotal + snapshotTotal;
  const mtdCost       = Math.round(monthTotal * dayFraction * 100) / 100;
  const projectedCost = monthTotal;
  const unattachedIPs = DO_FLOATING_IPS.filter(f=>!f.assigned_to);
  const unattachedVols= DO_VOLUMES.filter(v=>!v.attached_to);

  const sync = () => {
    setSyncing(true);
    setTimeout(()=>{ setSyncing(false); toast.success('Synced','DigitalOcean data refreshed.'); },1400);
  };

  const BW_BAR = ({used, limit}) => {
    const pct = Math.min(100, Math.round(used/limit*100));
    const c   = pct>90?T.red:pct>70?T.amber:T.green;
    return (
      <div>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:T.muted,marginBottom:3}}>
          <span>{used} TB used</span><span>{limit} TB</span>
        </div>
        <div style={{height:4,background:T.elevated,borderRadius:2,overflow:'hidden'}}>
          <div style={{height:'100%',width:pct+'%',background:c,borderRadius:2}}/>
        </div>
      </div>
    );
  };

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:5}}>
            <DOLogo size={28}/>
            <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>DigitalOcean</h2>
          </div>
          <p style={{margin:0,fontSize:13,color:T.sec}}>Spend, bandwidth, snapshots, volumes — current billing period</p>
        </div>
        <button onClick={sync} disabled={syncing} style={{fontSize:12,padding:'7px 14px',borderRadius:6,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
          {syncing?<span style={{display:'inline-block',width:10,height:10,border:'1.5px solid #888',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.7s linear infinite'}}/>:'↺'} Sync
        </button>
      </div>

      {/* Waste warnings */}
      {(unattachedIPs.length>0||unattachedVols.length>0)&&(
        <div style={{background:`${T.amber}08`,border:`0.5px solid ${T.amber}33`,borderRadius:8,padding:'10px 16px',marginBottom:16,display:'flex',gap:10,alignItems:'flex-start'}}>
          <span style={{fontSize:16,flexShrink:0}}>💸</span>
          <div style={{fontSize:12,color:T.sec}}>
            {unattachedIPs.length>0&&<span><strong style={{color:T.amber}}>{unattachedIPs.length} unassigned floating IP{unattachedIPs.length>1?'s':''}</strong> costing ${unattachedIPs.length*4}/mo with nothing attached. </span>}
            {unattachedVols.length>0&&<span><strong style={{color:T.amber}}>{unattachedVols.length} detached volume{unattachedVols.length>1?'s':''}</strong> costing ${unattachedVols.reduce((a,v)=>a+v.price_month,0)}/mo. </span>}
            Consider cleaning these up.
          </div>
        </div>
      )}

      {/* Cost summary */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
        <StatCard label="Month to date"  value={'$'+mtdCost}     sub={`Day ${currentDay} of ${daysInMonth}`} color={T.text}/>
        <StatCard label="Projected total" value={'$'+projectedCost} sub="end of month"                      color={T.amber}/>
        <StatCard label="Droplets"        value={'$'+dropletTotal+'/mo'} sub={DO_DROPLET_COSTS.length+' servers'} color={T.text}/>
        <StatCard label="Extras"          value={'$'+(backupTotal+volumeTotal+floatingTotal+snapshotTotal).toFixed(0)+'/mo'} sub="backups · volumes · IPs" color={T.text}/>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`,marginBottom:18}}>
        {['overview','bandwidth','volumes','floating-ips','snapshots'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'7px 16px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,whiteSpace:'nowrap',textTransform:'capitalize'}}>
            {t.replace('-',' ')}{t==='floating-ips'&&unattachedIPs.length>0?<span style={{fontSize:9,marginLeft:5,padding:'1px 5px',borderRadius:3,background:T.amber,color:'#000',fontWeight:700}}>{unattachedIPs.length}</span>:null}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab==='overview'&&(
        <div>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {[
              { label:'Droplets',      amount:dropletTotal,                                      detail:DO_DROPLET_COSTS.length+' servers',          icon:'🖥' },
              { label:'Backups',       amount:backupTotal,                                        detail:DO_DROPLET_COSTS.filter(d=>d.backups_enabled).length+' enabled', icon:'💾' },
              { label:'Block volumes', amount:volumeTotal,                                        detail:DO_VOLUMES.length+' volumes · '+DO_VOLUMES.reduce((a,v)=>a+v.size_gb,0)+' GB', icon:'📦' },
              { label:'Floating IPs',  amount:floatingTotal,                                      detail:DO_FLOATING_IPS.length+' IPs',               icon:'🌐' },
              { label:'Snapshots',     amount:snapshotTotal,                                      detail:'~'+DO_DROPLET_COSTS.reduce((a,d)=>a+d.snapshot_count,0)+' snapshots', icon:'📸' },
            ].map(item=>(
              <div key={item.label} style={{display:'flex',alignItems:'center',gap:14,padding:'12px 16px',background:T.card,borderRadius:8,border:`0.5px solid ${T.border}`}}>
                <span style={{fontSize:20,width:28,textAlign:'center',flexShrink:0}}>{item.icon}</span>
                <span style={{fontSize:13,color:T.text,flex:1,fontWeight:500}}>{item.label}</span>
                <span style={{fontSize:12,color:T.muted}}>{item.detail}</span>
                <div style={{width:140,height:4,background:T.elevated,borderRadius:2,overflow:'hidden'}}>
                  <div style={{height:'100%',width:(item.amount/monthTotal*100)+'%',background:T.blue,borderRadius:2}}/>
                </div>
                <span style={{fontSize:14,fontWeight:700,color:T.text,width:64,textAlign:'right'}}>${item.amount.toFixed(0)}<span style={{fontSize:10,color:T.muted,fontWeight:400}}>/mo</span></span>
              </div>
            ))}
            <div style={{display:'flex',justifyContent:'space-between',padding:'12px 16px',background:T.elevated,borderRadius:8,border:`0.5px solid ${T.borderMd}`}}>
              <span style={{fontSize:13,fontWeight:700,color:T.text}}>Total</span>
              <span style={{fontSize:16,fontWeight:800,color:T.text}}>${monthTotal.toFixed(2)}<span style={{fontSize:11,color:T.muted,fontWeight:400}}>/mo</span></span>
            </div>
          </div>
        </div>
      )}

      {/* Bandwidth */}
      {tab==='bandwidth'&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {DO_DROPLET_COSTS.map(d=>(
            <div key={d.id} style={{background:T.card,border:`0.5px solid ${d.bandwidth_used/d.bandwidth_limit>0.8?T.amber+'44':T.border}`,borderRadius:8,padding:'12px 16px',display:'flex',alignItems:'center',gap:14}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:8}}>{d.name}</div>
                <BW_BAR used={d.bandwidth_used} limit={d.bandwidth_limit}/>
              </div>
              <div style={{textAlign:'right',flexShrink:0}}>
                <div style={{fontSize:15,fontWeight:700,color:d.bandwidth_used/d.bandwidth_limit>0.8?T.amber:T.text}}>{Math.round(d.bandwidth_used/d.bandwidth_limit*100)}%</div>
                <div style={{fontSize:10,color:T.muted}}>{d.region}</div>
              </div>
            </div>
          ))}
          <div style={{padding:'10px 14px',background:T.elevated,borderRadius:7,fontSize:12,color:T.muted}}>
            Bandwidth resets on the 1st of each month. Overages are billed at $0.01/GB.
          </div>
        </div>
      )}

      {/* Volumes */}
      {tab==='volumes'&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {DO_VOLUMES.map(v=>(
            <div key={v.id} style={{background:T.card,border:`0.5px solid ${!v.attached_to?T.amber+'44':T.border}`,borderRadius:8,padding:'13px 16px',display:'flex',alignItems:'center',gap:14}}>
              <span style={{fontSize:20}}>{v.attached_to?'📦':'🗑'}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:3}}>{v.name}</div>
                <div style={{fontSize:11,color:T.muted}}>{v.size_gb} GB · {v.region} · {v.attached_to?<span style={{color:T.green}}>attached to {v.attached_to}</span>:<span style={{color:T.amber}}>⚠ unattached — paying for nothing</span>}</div>
              </div>
              <div style={{fontSize:14,fontWeight:700,color:v.attached_to?T.text:T.amber}}>${v.price_month}<span style={{fontSize:10,color:T.muted,fontWeight:400}}>/mo</span></div>
              {!v.attached_to&&<button onClick={()=>toast.warning('Manual action required',`Detach and delete ${v.name} in the DO console to stop billing.`)} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.amber}44`,background:`${T.amber}08`,color:T.amber,cursor:'pointer'}}>Fix</button>}
            </div>
          ))}
        </div>
      )}

      {/* Floating IPs */}
      {tab==='floating-ips'&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {DO_FLOATING_IPS.map(f=>(
            <div key={f.id} style={{background:T.card,border:`0.5px solid ${!f.assigned_to?T.amber+'44':T.border}`,borderRadius:8,padding:'13px 16px',display:'flex',alignItems:'center',gap:14}}>
              <span style={{fontSize:20}}>🌐</span>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                  <code style={{fontSize:13,fontFamily:'monospace',fontWeight:600,color:T.text}}>{f.ip}</code>
                  {f.assigned_to
                    ? <Pill label={f.assigned_to} color={T.green}/>
                    : <Pill label="unassigned" color={T.amber}/>
                  }
                </div>
                <div style={{fontSize:11,color:T.muted}}>{f.region}</div>
              </div>
              <div style={{fontSize:14,fontWeight:700,color:f.assigned_to?T.text:T.amber}}>${f.price_month}<span style={{fontSize:10,color:T.muted,fontWeight:400}}>/mo</span></div>
              {!f.assigned_to&&<button onClick={()=>toast.warning('Manual action required',`Release ${f.ip} in the DO console to stop the $4/mo charge.`)} style={{fontSize:11,padding:'4px 10px',borderRadius:5,border:`0.5px solid ${T.amber}44`,background:`${T.amber}08`,color:T.amber,cursor:'pointer'}}>Release</button>}
            </div>
          ))}
          <div style={{padding:'10px 14px',background:T.elevated,borderRadius:7,fontSize:12,color:T.muted}}>
            Unassigned floating IPs are billed at $4/mo. Release them in the DigitalOcean console if not in use.
          </div>
        </div>
      )}

      {/* Snapshots */}
      {tab==='snapshots'&&(
        <div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:16}}>
            <StatCard label="Total snapshots" value={DO_DROPLET_COSTS.reduce((a,d)=>a+d.snapshot_count,0)} sub="across all droplets"/>
            <StatCard label="Snapshot cost"   value={'~$'+snapshotTotal+'/mo'} sub="$0.05 per GB/mo" color={T.amber}/>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {DO_DROPLET_COSTS.filter(d=>d.snapshot_count>0||d.backups_enabled).map(d=>(
              <div key={d.id} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:'12px 16px',display:'flex',alignItems:'center',gap:12}}>
                <span style={{fontSize:18}}>📸</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>{d.name}</div>
                  <div style={{display:'flex',gap:8}}>
                    {d.backups_enabled&&<span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:`${T.green}15`,color:T.green,border:`0.5px solid ${T.green}33`}}>DO Backups on · +${d.backup_price}/mo</span>}
                    {d.snapshot_count>0&&<span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.sec,border:`0.5px solid ${T.border}`}}>{d.snapshot_count} snapshot{d.snapshot_count>1?'s':''}</span>}
                  </div>
                </div>
                <div style={{fontSize:12,color:T.muted}}>{d.region}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:12,padding:'10px 14px',background:`${T.blue}08`,border:`0.5px solid ${T.blue}33`,borderRadius:7,fontSize:12,color:T.sec}}>
            💡 DigitalOcean Backups (20% of droplet cost) vs Hub Backup: DO Backups give you weekly droplet snapshots. Hub Backup saves your configuration and database. Both are recommended for production.
          </div>
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT ACTIVITY
// ═══════════════════════════════════════════════════════════════════════════════

const GIT_REPOS = [
  {
    id:'gr1', name:'acme/dashboard', project:'dashboard', default_branch:'main',
    last_commit:{ sha:'a3f2c91', message:'feat: add new workflow editor sidebar', author:'sarah', ago:'2h ago' },
    open_prs:[
      { id:'pr1', number:142, title:'feat: dark mode improvements', author:'james',  branch:'feature/dark-mode', commits:3, ago:'1d ago', ci:'passing', mergeable:true  },
      { id:'pr2', number:141, title:'fix: memory leak in log viewer', author:'sarah', branch:'fix/log-leak',     commits:1, ago:'2d ago', ci:'passing', mergeable:true  },
      { id:'pr3', number:138, title:'chore: update dependencies',    author:'bot',   branch:'deps/update',      commits:1, ago:'5d ago', ci:'failing', mergeable:false },
    ],
    recent_commits:[
      { sha:'a3f2c91', message:'feat: add new workflow editor sidebar',    author:'sarah', ago:'2h ago',  branch:'main'   },
      { sha:'92e1b80', message:'fix: resolve race condition in deploy hook', author:'james', ago:'6h ago', branch:'main'   },
      { sha:'81d0a79', message:'chore: bump node to 20.11',                author:'bot',   ago:'1d ago',  branch:'main'   },
      { sha:'70c9b68', message:'feat: log analysis tab improvements',      author:'sarah', ago:'2d ago',  branch:'main'   },
    ],
    ci_status:'passing', stars:12, open_issues:8,
  },
  {
    id:'gr2', name:'acme/api-gateway', project:'api-gateway', default_branch:'main',
    last_commit:{ sha:'c4a1d55', message:'fix: rate limiter edge case on burst traffic', author:'james', ago:'4h ago' },
    open_prs:[
      { id:'pr4', number:89, title:'feat: add GraphQL endpoint', author:'james', branch:'feature/graphql', commits:8, ago:'3d ago', ci:'passing', mergeable:true },
    ],
    recent_commits:[
      { sha:'c4a1d55', message:'fix: rate limiter edge case on burst traffic', author:'james', ago:'4h ago',  branch:'main' },
      { sha:'b3f0e44', message:'feat: circuit breaker pattern for upstream',   author:'sarah', ago:'1d ago',  branch:'main' },
      { sha:'a2e9d33', message:'docs: update API reference',                  author:'james', ago:'2d ago',  branch:'main' },
    ],
    ci_status:'passing', stars:6, open_issues:3,
  },
  {
    id:'gr3', name:'acme/data-pipeline', project:'data-pipeline', default_branch:'main',
    last_commit:{ sha:'d5b0c44', message:'fix: null pointer in transformer step 4', author:'sarah', ago:'1d ago' },
    open_prs:[
      { id:'pr5', number:56, title:'feat: Kafka source connector',      author:'sarah', branch:'feature/kafka',  commits:12, ago:'4d ago', ci:'failing', mergeable:false },
      { id:'pr6', number:55, title:'fix: memory usage in batch reader', author:'james', branch:'fix/batch-mem',  commits:2,  ago:'6d ago', ci:'passing', mergeable:true  },
    ],
    recent_commits:[
      { sha:'d5b0c44', message:'fix: null pointer in transformer step 4', author:'sarah', ago:'1d ago',  branch:'main' },
      { sha:'c4a9b33', message:'perf: 40% faster batch processing',       author:'james', ago:'3d ago',  branch:'main' },
    ],
    ci_status:'failing', stars:4, open_issues:14,
  },
];

function GitActivityView() {
  const [repos]     = useState(GIT_REPOS);
  const [activeRepo,setActiveRepo] = useState(GIT_REPOS[0].id);
  const [tab,       setTab]         = useState('overview');

  const repo = repos.find(r=>r.id===activeRepo);
  const totalOpenPRs    = repos.reduce((a,r)=>a+r.open_prs.length,0);
  const totalFailingCI  = repos.filter(r=>r.ci_status==='failing').length;
  const totalOpenIssues = repos.reduce((a,r)=>a+r.open_issues,0);

  const CI_COLOR  = { passing:T.green, failing:T.red, pending:T.amber, unknown:T.muted };
  const ciColor   = s => CI_COLOR[s]||T.muted;

  return (
    <div style={{padding:'28px 30px',maxWidth:980}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:5}}>
            <div style={{width:28,height:28,borderRadius:7,background:T.elevated,border:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>🗂</div>
            <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Git Activity</h2>
          </div>
          <p style={{margin:0,fontSize:13,color:T.sec}}>Commits, PRs, and CI status across your Forgejo repositories</p>
        </div>
      </div>

      {/* Cross-repo stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
        <StatCard label="Repositories"  value={repos.length}      sub="connected"/>
        <StatCard label="Open PRs"      value={totalOpenPRs}      sub="across all repos"  color={totalOpenPRs>0?T.blue:T.text}/>
        <StatCard label="CI failing"    value={totalFailingCI}    sub="repos"              color={totalFailingCI>0?T.red:T.green}/>
        <StatCard label="Open issues"   value={totalOpenIssues}   sub="across all repos"  color={T.muted}/>
      </div>

      {/* Repo selector */}
      <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
        {repos.map(r=>{
          const isSel = activeRepo===r.id;
          return (
            <button key={r.id} onClick={()=>setActiveRepo(r.id)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 14px',borderRadius:7,border:`1px solid ${isSel?T.blue:T.border}`,background:isSel?`${T.blue}12`:T.card,cursor:'pointer'}}>
              <Dot color={ciColor(r.ci_status)} size={7}/>
              <span style={{fontSize:12,fontWeight:isSel?600:400,color:isSel?T.text:T.sec}}>{r.name.split('/')[1]}</span>
              {r.open_prs.length>0&&<span style={{fontSize:10,background:T.blue,color:'#fff',borderRadius:8,padding:'1px 5px',fontWeight:700}}>{r.open_prs.length}</span>}
              {r.ci_status==='failing'&&<span style={{fontSize:10,background:T.red,color:'#fff',borderRadius:8,padding:'1px 5px',fontWeight:700}}>CI</span>}
            </button>
          );
        })}
      </div>

      {/* Repo tabs */}
      <div style={{display:'flex',borderBottom:`0.5px solid ${T.border}`,marginBottom:18}}>
        {['overview','pull-requests','commits'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:'7px 18px',border:'none',background:'none',cursor:'pointer',fontSize:13,color:tab===t?T.text:T.sec,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${T.blue}`:'2px solid transparent',marginBottom:-1,whiteSpace:'nowrap',textTransform:'capitalize'}}>
            {t.replace('-',' ')}
            {t==='pull-requests'&&repo?.open_prs.length>0&&<span style={{marginLeft:6,fontSize:10,background:T.blue,color:'#fff',borderRadius:8,padding:'1px 5px',fontWeight:700}}>{repo.open_prs.length}</span>}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab==='overview'&&repo&&(
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          {/* Repo header */}
          <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,padding:'16px 18px'}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:5}}>
                  <span style={{fontSize:15,fontWeight:700,color:T.blue}}>{repo.name}</span>
                  <span style={{fontSize:11,fontFamily:'monospace',color:T.muted}}>:{repo.default_branch}</span>
                </div>
                <div style={{display:'flex',gap:10}}>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <Dot color={ciColor(repo.ci_status)} size={7}/>
                    <span style={{fontSize:12,color:ciColor(repo.ci_status),fontWeight:500}}>CI {repo.ci_status}</span>
                  </div>
                  <span style={{fontSize:12,color:T.muted}}>{repo.open_prs.length} open PRs · {repo.open_issues} issues</span>
                </div>
              </div>
              <a href="#" onClick={e=>e.preventDefault()} style={{fontSize:12,color:T.blue,textDecoration:'none',padding:'6px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated}}>Open in Forgejo ↗</a>
            </div>
            <div style={{padding:'10px 14px',background:T.elevated,borderRadius:7,border:`0.5px solid ${T.border}`}}>
              <div style={{fontSize:10,color:T.muted,marginBottom:3,textTransform:'uppercase',letterSpacing:'0.07em'}}>Latest commit</div>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <code style={{fontSize:11,fontFamily:'monospace',color:T.blue}}>{repo.last_commit.sha}</code>
                <span style={{fontSize:12,color:T.text,flex:1}}>{repo.last_commit.message}</span>
                <Avatar initials={repo.last_commit.author.slice(0,2).toUpperCase()} color={T.purple} size={20}/>
                <span style={{fontSize:11,color:T.muted,flexShrink:0}}>{repo.last_commit.ago}</span>
              </div>
            </div>
          </div>

          {/* Open PRs summary */}
          {repo.open_prs.length>0&&(
            <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
              <div style={{padding:'10px 16px',borderBottom:`0.5px solid ${T.border}`,fontSize:11,fontWeight:600,color:T.sec,textTransform:'uppercase',letterSpacing:'0.07em'}}>Open pull requests</div>
              {repo.open_prs.map((pr,i)=>(
                <div key={pr.id} style={{display:'flex',alignItems:'center',gap:10,padding:'11px 16px',borderBottom:i<repo.open_prs.length-1?`0.5px solid ${T.border}`:'none'}}>
                  <span style={{fontSize:14}}>{pr.ci==='passing'?'✅':pr.ci==='failing'?'❌':'⏳'}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>#{pr.number} {pr.title}</div>
                    <div style={{fontSize:10,color:T.muted}}>{pr.author} · {pr.branch} · {pr.commits} commit{pr.commits>1?'s':''} · {pr.ago}</div>
                  </div>
                  <Pill label={pr.ci} color={ciColor(pr.ci)}/>
                  {pr.mergeable
                    ? <span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:`${T.green}12`,color:T.green,border:`0.5px solid ${T.green}33`}}>mergeable</span>
                    : <span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:`${T.red}12`,color:T.red,border:`0.5px solid ${T.red}33`}}>conflicts</span>
                  }
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pull Requests */}
      {tab==='pull-requests'&&repo&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {repo.open_prs.map(pr=>(
            <div key={pr.id} style={{background:T.card,border:`0.5px solid ${pr.ci==='failing'?T.red+'33':T.border}`,borderRadius:9,padding:'14px 18px'}}>
              <div style={{display:'flex',alignItems:'flex-start',gap:12}}>
                <span style={{fontSize:20,flexShrink:0,marginTop:2}}>{pr.ci==='passing'?'✅':pr.ci==='failing'?'❌':'⏳'}</span>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                    <span style={{fontSize:14,fontWeight:700,color:T.text}}>#{pr.number} {pr.title}</span>
                  </div>
                  <div style={{display:'flex',gap:10,marginBottom:8,flexWrap:'wrap'}}>
                    <span style={{fontSize:11,color:T.muted}}>by {pr.author}</span>
                    <code style={{fontSize:10,fontFamily:'monospace',color:T.sec,background:T.elevated,padding:'1px 6px',borderRadius:3}}>{pr.branch}</code>
                    <span style={{fontSize:11,color:T.muted}}>{pr.commits} commit{pr.commits>1?'s':''}</span>
                    <span style={{fontSize:11,color:T.muted}}>opened {pr.ago}</span>
                  </div>
                  <div style={{display:'flex',gap:7}}>
                    <Pill label={'CI: '+pr.ci} color={ciColor(pr.ci)}/>
                    {pr.mergeable
                      ? <Pill label="mergeable" color={T.green}/>
                      : <Pill label="has conflicts" color={T.red}/>
                    }
                  </div>
                </div>
              </div>
            </div>
          ))}
          {repo.open_prs.length===0&&(
            <div style={{padding:'32px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9}}>
              <div style={{fontSize:28,marginBottom:8}}>✓</div>
              <div style={{fontSize:13,color:T.sec}}>No open pull requests.</div>
            </div>
          )}
        </div>
      )}

      {/* Commits */}
      {tab==='commits'&&repo&&(
        <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:9,overflow:'hidden'}}>
          {repo.recent_commits.map((c,i)=>(
            <div key={c.sha} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderBottom:i<repo.recent_commits.length-1?`0.5px solid ${T.border}`:'none'}}>
              <code style={{fontSize:11,fontFamily:'monospace',color:T.blue,width:60,flexShrink:0}}>{c.sha}</code>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:500,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.message}</div>
                <div style={{fontSize:10,color:T.muted,marginTop:2}}>{c.branch}</div>
              </div>
              <Avatar initials={c.author.slice(0,2).toUpperCase()} color={c.author==='bot'?T.cyan:T.purple} size={20}/>
              <span style={{fontSize:11,color:T.muted,flexShrink:0}}>{c.ago}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PROVIDER_VIEWS = new Set(['cloudflare','do-spend','git-activity']);
// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE FEATURE FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

const WS_FLAGS_INIT = [
  {
    id:'wf1', name:'new-checkout-flow',    type:'boolean',
    description:'Enables the redesigned checkout experience with one-page summary.',
    tags:['frontend','payments'],
    variants:null,
    environments:{
      production: { enabled:false, rollout:0,   strategy:'default' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:true,  rollout:100,  strategy:'default' },
    },
    created_by:'sarah', created_at: Date.now()-86400000*14,
    last_changed_by:'james', last_changed_at: Date.now()-3600000*6,
  },
  {
    id:'wf2', name:'recommendation-engine', type:'boolean',
    description:'AI-powered product recommendations on category pages. Kill switch for high DB load.',
    tags:['ai','performance'],
    variants:null,
    environments:{
      production: { enabled:true,  rollout:100,  strategy:'default' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:true,  rollout:100,  strategy:'default' },
    },
    created_by:'sarah', created_at: Date.now()-86400000*30,
    last_changed_by:'sarah', last_changed_at: Date.now()-86400000*2,
  },
  {
    id:'wf3', name:'beta-dashboard-v2',    type:'boolean',
    description:'New analytics dashboard. Gradual rollout by user segment.',
    tags:['frontend','beta'],
    variants:null,
    environments:{
      production: { enabled:true,  rollout:10,   strategy:'gradual' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:true,  rollout:100,  strategy:'default' },
    },
    created_by:'james', created_at: Date.now()-86400000*7,
    last_changed_by:'james', last_changed_at: Date.now()-86400000,
  },
  {
    id:'wf4', name:'api-rate-limit-v2',    type:'boolean',
    description:'New per-endpoint rate limiting algorithm. Emergency kill switch available.',
    tags:['api','killswitch'],
    variants:null,
    environments:{
      production: { enabled:true,  rollout:100,  strategy:'default' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:true,  rollout:100,  strategy:'default' },
    },
    created_by:'sarah', created_at: Date.now()-86400000*21,
    last_changed_by:'sarah', last_changed_at: Date.now()-86400000*5,
  },
  {
    id:'wf5', name:'pricing-variant',       type:'variant',
    description:'A/B test: three pricing page layouts. Tracks conversion per variant.',
    tags:['experiment','growth'],
    variants:[
      { key:'control',    name:'Control',    weight:34, description:'Current pricing page' },
      { key:'simplified', name:'Simplified', weight:33, description:'Single plan CTA' },
      { key:'comparison', name:'Comparison', weight:33, description:'Feature comparison table' },
    ],
    environments:{
      production: { enabled:true,  rollout:100,  strategy:'default' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:false, rollout:0,    strategy:'default' },
    },
    created_by:'james', created_at: Date.now()-86400000*5,
    last_changed_by:'james', last_changed_at: Date.now()-3600000*2,
  },
  {
    id:'wf6', name:'dark-mode',             type:'boolean',
    description:'System-wide dark mode toggle. Reads prefers-color-scheme by default.',
    tags:['frontend','ui'],
    variants:null,
    environments:{
      production: { enabled:false, rollout:0,    strategy:'default' },
      staging:    { enabled:true,  rollout:100,  strategy:'default' },
      development:{ enabled:true,  rollout:100,  strategy:'default' },
    },
    created_by:'sarah', created_at: Date.now()-86400000*3,
    last_changed_by:'sarah', last_changed_at: Date.now()-3600000*8,
  },
];

const SDK_SNIPPETS = {
  javascript: (name) => [
    "// See Unleash docs for SDK setup",
    "",
    "const client = new UnleashClient({",
    "  url: 'https://hub.acme.com/api/proxy',",
    "  clientKey: '<your-client-key>',",
    "  appName: 'my-app',",
    "});",
    "",
    "await client.start();",
    "",
    `if (client.isEnabled('${name}')) {`,
    "  // flag is enabled for this user",
    "}",
  ].join("\n"),
  python: (name) => [
    "# See Unleash docs for Python SDK setup",
    "",
    "client = UnleashClient(",
    '    url="https://hub.acme.com/api/proxy",',
    '    app_name="my-app",',
    '    custom_headers={"Authorization": "<your-client-key>"}',
    ")",
    "client.initialize_client()",
    "",
    `if client.is_enabled("${name}"):`,
    "    # flag is enabled for this user",
  ].join("\n"),
  go: (name) => [
    "// See Unleash docs for Go SDK setup",
    "",
    "unleash.Initialize(",
    '    unleash.WithUrl("https://hub.acme.com/api/proxy"),',
    '    unleash.WithAppName("my-app"),',
    '    unleash.WithCustomAuthToken("<your-client-key>"),',
    ")",
    "",
    `if unleash.IsEnabled("${name}") {`,
    "    // flag is enabled for this user",
    "}",
  ].join("\n"),
};

function FlagDetailModal({ flag, onClose, onSave }) {
  const toast = useToast();
  const [envs, setEnvs] = useState({ ...flag.environments });
  const [sdkLang, setSdkLang] = useState('javascript');
  const [copied, setCopied] = useState(false);

  const ENV_ORDER = ['production','staging','development'];
  const ENV_COLOR = { production:T.red, staging:T.amber, development:T.blue };

  const setRollout = (env, val) => {
    const n = Math.max(0, Math.min(100, parseInt(val)||0));
    setEnvs(e=>({ ...e, [env]:{ ...e[env], rollout:n } }));
  };
  const toggleEnv = (env) => {
    setEnvs(e=>({ ...e, [env]:{ ...e[env], enabled:!e[env].enabled } }));
  };

  const snippet = SDK_SNIPPETS[sdkLang]?.(flag.name) || '';

  const copy = () => {
    navigator.clipboard?.writeText(snippet).catch(()=>{});
    setCopied(true);
    setTimeout(()=>setCopied(false),2000);
    toast.success('Copied','SDK snippet copied to clipboard.');
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:640,maxHeight:'90vh',overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>

        {/* Header */}
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexShrink:0}}>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <code style={{fontSize:14,fontFamily:'monospace',fontWeight:700,color:T.text}}>{flag.name}</code>
              <Pill label={flag.type} color={flag.type==='variant'?T.purple:T.blue}/>
              {flag.tags.includes('killswitch')&&<Pill label="killswitch" color={T.red}/>}
            </div>
            <div style={{fontSize:12,color:T.sec}}>{flag.description}</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1,padding:4,flexShrink:0}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'20px 22px'}}>

          {/* Environment toggles */}
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:500,marginBottom:12}}>Environments</div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {ENV_ORDER.filter(e=>envs[e]).map(env=>{
                const cfg = envs[env];
                const ec  = ENV_COLOR[env];
                return (
                  <div key={env} style={{background:T.elevated,border:`0.5px solid ${cfg.enabled?ec+'44':T.border}`,borderRadius:9,padding:'14px 16px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:cfg.enabled?12:0}}>
                      <div onClick={()=>toggleEnv(env)} style={{width:36,height:20,borderRadius:10,background:cfg.enabled?ec:T.card,border:`0.5px solid ${cfg.enabled?ec:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
                        <div style={{position:'absolute',top:2,left:cfg.enabled?18:2,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
                      </div>
                      <span style={{fontSize:13,fontWeight:600,color:T.text,textTransform:'capitalize',flex:1}}>{env}</span>
                      <Pill label={cfg.enabled?'enabled':'disabled'} color={cfg.enabled?ec:T.muted}/>
                    </div>
                    {cfg.enabled&&(
                      <div>
                        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
                          <label style={{fontSize:11,color:T.muted,width:60,flexShrink:0}}>Rollout</label>
                          <input
                            type="range" min="0" max="100" value={cfg.rollout}
                            onChange={e=>setRollout(env,e.target.value)}
                            style={{flex:1,accentColor:ec}}
                          />
                          <span style={{fontSize:12,fontWeight:700,color:ec,width:36,textAlign:'right'}}>{cfg.rollout}%</span>
                        </div>
                        {cfg.rollout<100&&<div style={{fontSize:10,color:T.muted,padding:'4px 8px',background:T.card,borderRadius:4}}>
                          {cfg.rollout===0?'Flag is off — no users will see this.`':`${cfg.rollout}% of users will receive this flag based on user ID hash.`}
                        </div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Variants (if type=variant) */}
          {flag.variants&&(
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:500,marginBottom:12}}>Variants</div>
              <div style={{display:'flex',flexDirection:'column',gap:7}}>
                {flag.variants.map((v,i)=>(
                  <div key={v.key} style={{background:T.elevated,borderRadius:7,padding:'10px 14px',border:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',gap:12}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:[T.blue,T.green,T.purple,T.amber][i%4],flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
                        <code style={{fontSize:12,fontFamily:'monospace',fontWeight:600,color:T.text}}>{v.key}</code>
                        <span style={{fontSize:11,color:T.muted}}>{v.description}</span>
                      </div>
                      <div style={{height:4,background:T.card,borderRadius:2,overflow:'hidden'}}>
                        <div style={{height:'100%',width:v.weight+'%',background:[T.blue,T.green,T.purple,T.amber][i%4],borderRadius:2}}/>
                      </div>
                    </div>
                    <span style={{fontSize:13,fontWeight:700,color:T.text,width:36,textAlign:'right'}}>{v.weight}%</span>
                  </div>
                ))}
              </div>
              <div style={{fontSize:11,color:T.muted,marginTop:8}}>Weights must total 100%. Users are assigned variants consistently based on their user ID.</div>
            </div>
          )}

          {/* SDK snippet */}
          <div>
            <div style={{fontSize:11,color:T.sec,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:500,marginBottom:10}}>SDK usage</div>
            <div style={{display:'flex',gap:4,marginBottom:8}}>
              {['javascript','python','go'].map(lang=>(
                <button key={lang} onClick={()=>setSdkLang(lang)} style={{padding:'4px 12px',borderRadius:5,border:`0.5px solid ${sdkLang===lang?T.blue:T.border}`,background:sdkLang===lang?`${T.blue}15`:T.elevated,color:sdkLang===lang?T.blue:T.sec,fontSize:11,cursor:'pointer',fontWeight:sdkLang===lang?600:400}}>
                  {lang}
                </button>
              ))}
              <button onClick={copy} style={{marginLeft:'auto',padding:'4px 12px',borderRadius:5,border:`0.5px solid ${copied?T.green+'55':T.border}`,background:copied?`${T.green}12`:T.elevated,color:copied?T.green:T.muted,fontSize:11,cursor:'pointer'}}>
                {copied?'✓ Copied':'Copy'}
              </button>
            </div>
            <pre style={{margin:0,background:'#090b11',border:`0.5px solid ${T.border}`,borderRadius:7,padding:'12px 14px',fontSize:11,fontFamily:'monospace',color:'#e2e8f0',lineHeight:'18px',overflowX:'auto',whiteSpace:'pre'}}>{snippet}</pre>
          </div>

          {/* Metadata */}
          <div style={{marginTop:16,display:'flex',gap:16,flexWrap:'wrap'}}>
            {[
              ['Created by', flag.created_by],
              ['Created', fmtAge(flag.created_at)],
              ['Last changed by', flag.last_changed_by],
              ['Last changed', fmtAge(flag.last_changed_at)],
            ].map(([k,v])=>(
              <div key={k}>
                <div style={{fontSize:10,color:T.muted,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:2}}>{k}</div>
                <div style={{fontSize:12,color:T.sec,fontWeight:500}}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between',flexShrink:0}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer'}}>Cancel</button>
          <button onClick={()=>{ onSave(flag.id, envs); onClose(); toast.success('Flag updated', flag.name); }} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 22px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function NewFlagModal({ onClose, onCreate }) {
  const [name,    setName]    = useState('');
  const [desc,    setDesc]    = useState('');
  const [type,    setType]    = useState('boolean');
  const [tags,    setTags]    = useState('');
  const [nameErr, setNameErr] = useState('');
  const toast = useToast();

  const create = () => {
    if (!name.trim()) { setNameErr('Name required'); return; }
    if (!/^[a-z0-9-]+$/.test(name)) { setNameErr('Lowercase letters, numbers, hyphens only'); return; }
    const flag = {
      id:'wf'+Date.now(), name, type, description:desc,
      tags: tags.split(',').map(t=>t.trim()).filter(Boolean),
      variants: type==='variant'?[{key:'control',name:'Control',weight:50,description:'Original'},{key:'variant-a',name:'Variant A',weight:50,description:'Alternative'}]:null,
      environments:{
        production: { enabled:false, rollout:0,   strategy:'default' },
        staging:    { enabled:true,  rollout:100,  strategy:'default' },
        development:{ enabled:true,  rollout:100,  strategy:'default' },
      },
      created_by:'sarah', created_at:Date.now(),
      last_changed_by:'sarah', last_changed_at:Date.now(),
    };
    onCreate(flag);
    onClose();
    toast.success('Flag created', name);
  };

  return (
    <div style={{position:'fixed',inset:0,background:T.overlay,display:'flex',alignItems:'center',justifyContent:'center',zIndex:1200}}>
      <div style={{background:T.modal,border:`0.5px solid ${T.borderMd}`,borderRadius:12,width:'100%',maxWidth:480,overflow:'hidden',boxShadow:'0 24px 80px rgba(0,0,0,0.7)',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:15,fontWeight:700,color:T.text}}>New feature flag</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:T.sec,fontSize:20,lineHeight:1}}>✕</button>
        </div>
        <div style={{padding:'20px 22px'}}>
          <Input label="Flag name" value={name} onChange={e=>{setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,'-'));setNameErr('');}} placeholder="new-checkout-flow" mono error={nameErr} hint="Lowercase, hyphens only. This is what your SDK will reference."/>

          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:12,color:T.sec,marginBottom:8,fontWeight:500}}>Type</label>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[
                { id:'boolean', icon:'🔘', label:'Boolean',  desc:'Simple on/off flag' },
                { id:'variant', icon:'🔀', label:'Variant',  desc:'A/B test with multiple variants' },
              ].map(t=>{
                const sel=type===t.id;
                return (
                  <button key={t.id} onClick={()=>setType(t.id)} style={{padding:'12px',borderRadius:8,border:`1.5px solid ${sel?T.blue:T.border}`,background:sel?`${T.blue}12`:T.elevated,cursor:'pointer',textAlign:'left'}}>
                    <div style={{fontSize:18,marginBottom:5}}>{t.icon}</div>
                    <div style={{fontSize:12,fontWeight:600,color:sel?T.blue:T.text,marginBottom:2}}>{t.label}</div>
                    <div style={{fontSize:10,color:T.muted}}>{t.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <Input label="Description" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="What does this flag control?"/>
          <Input label="Tags (comma-separated)" value={tags} onChange={e=>setTags(e.target.value)} placeholder="frontend, experiment, killswitch" hint="Used for filtering and organization."/>
        </div>
        <div style={{padding:'14px 22px',borderTop:`0.5px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.sec,fontSize:13,cursor:'pointer'}}>Cancel</button>
          <button onClick={create} disabled={!name.trim()} style={{background:T.blue,border:'none',borderRadius:7,padding:'9px 22px',color:'#fff',fontSize:13,fontWeight:600,cursor:name.trim()?'pointer':'not-allowed',opacity:name.trim()?1:0.4}}>
            Create flag
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceFlagsView() {
  const toast = useToast();
  const [flags,      setFlags]     = useState(WS_FLAGS_INIT);
  const [editing,    setEditing]   = useState(null);
  const [showNew,    setShowNew]   = useState(false);
  const [filterTag,  setFilterTag] = useState('all');
  const [filterEnv,  setFilterEnv] = useState('production');
  const [search,     setSearch]    = useState('');

  const ENV_COLOR = { production:T.red, staging:T.amber, development:T.blue };
  const TYPE_COLOR = { boolean:T.blue, variant:T.purple };

  const allTags = ['all', ...new Set(flags.flatMap(f=>f.tags))];

  const filtered = flags.filter(f=>{
    const matchTag = filterTag==='all' || f.tags.includes(filterTag);
    const matchSearch = !search || f.name.includes(search.toLowerCase()) || f.description.toLowerCase().includes(search.toLowerCase());
    return matchTag && matchSearch;
  });

  const saveFlag = (id, newEnvs) => {
    setFlags(fs=>fs.map(f=>f.id===id?{...f,environments:newEnvs,last_changed_by:'sarah',last_changed_at:Date.now()}:f));
  };

  const deleteFlag = (f) => {
    setFlags(fs=>fs.filter(x=>x.id!==f.id));
    toast.success('Flag deleted', f.name);
  };

  const enabledInEnv = (flag) => flag.environments[filterEnv]?.enabled;
  const rolloutInEnv = (flag) => flag.environments[filterEnv]?.rollout ?? 0;

  const totalEnabled = flags.filter(f=>f.environments[filterEnv]?.enabled).length;
  const totalVariants= flags.filter(f=>f.type==='variant').length;
  const partialRollout=flags.filter(f=>f.environments[filterEnv]?.enabled&&f.environments[filterEnv]?.rollout<100).length;

  return (
    <div style={{padding:'28px 30px',maxWidth:960}}>
      {editing&&<FlagDetailModal flag={editing} onClose={()=>setEditing(null)} onSave={saveFlag}/>}
      {showNew&&<NewFlagModal onClose={()=>setShowNew(false)} onCreate={f=>setFlags(fs=>[f,...fs])}/>}

      {/* Header */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:24}}>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>Feature Flags</h2>
          <p style={{margin:'6px 0 0',fontSize:13,color:T.sec}}>
            Runtime toggles for your apps · backed by Unleash · no redeploy needed
          </p>
        </div>
        <button onClick={()=>setShowNew(true)} style={{display:'flex',alignItems:'center',gap:8,background:T.blue,border:'none',borderRadius:7,padding:'9px 16px',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>
          ＋ New flag
        </button>
      </div>

      {/* Stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:22}}>
        <StatCard label="Total flags"     value={flags.length}      sub="all types"/>
        <StatCard label={`Enabled in ${filterEnv}`} value={totalEnabled} sub={`of ${flags.length} flags`} color={T.green}/>
        <StatCard label="Partial rollout" value={partialRollout}    sub="gradual flags"          color={partialRollout>0?T.amber:T.muted}/>
        <StatCard label="A/B variants"    value={totalVariants}     sub="multivariate flags"     color={totalVariants>0?T.purple:T.muted}/>
      </div>

      {/* Filters */}
      <div style={{display:'flex',gap:10,marginBottom:18,alignItems:'center',flexWrap:'wrap'}}>
        {/* Env selector */}
        <div style={{display:'flex',gap:2,background:T.elevated,borderRadius:7,padding:3}}>
          {['production','staging','development'].map(e=>(
            <button key={e} onClick={()=>setFilterEnv(e)} style={{padding:'5px 12px',borderRadius:5,border:'none',cursor:'pointer',fontSize:12,fontWeight:filterEnv===e?600:400,background:filterEnv===e?T.card:'transparent',color:filterEnv===e?ENV_COLOR[e]:T.sec,textTransform:'capitalize'}}>
              {e.slice(0,4)}
            </button>
          ))}
        </div>

        {/* Tag filter */}
        <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
          {allTags.map(t=>(
            <button key={t} onClick={()=>setFilterTag(t)} style={{padding:'4px 10px',borderRadius:14,border:`0.5px solid ${filterTag===t?T.blue:T.border}`,background:filterTag===t?`${T.blue}15`:T.elevated,color:filterTag===t?T.blue:T.muted,fontSize:11,cursor:'pointer',fontWeight:filterTag===t?600:400,textTransform:'capitalize'}}>
              {t}
            </button>
          ))}
        </div>

        {/* Search */}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search flags…"
          style={{marginLeft:'auto',background:T.elevated,border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'7px 12px',fontSize:12,color:T.text,outline:'none',width:200}}
          onFocus={e=>e.target.style.borderColor=T.blue} onBlur={e=>e.target.style.borderColor=T.borderMd}/>
      </div>

      {/* Flag list */}
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {filtered.map(flag=>{
          const envCfg = flag.environments[filterEnv];
          const isOn   = envCfg?.enabled;
          const rollout= envCfg?.rollout ?? 0;
          const ec     = ENV_COLOR[filterEnv];

          return (
            <div key={flag.id} style={{background:T.card,border:`0.5px solid ${isOn?ec+'33':T.border}`,borderRadius:10,padding:'14px 18px',display:'flex',alignItems:'center',gap:14,transition:'border-color 0.15s'}}>
              {/* Quick toggle for current env */}
              <div
                onClick={()=>{
                  const next = !isOn;
                  setFlags(fs=>fs.map(f=>f.id===flag.id?{...f,environments:{...f.environments,[filterEnv]:{...f.environments[filterEnv],enabled:next}},last_changed_at:Date.now()}:f));
                  toast(next?'success':'warning', next?`Flag on in ${filterEnv}`:`Flag off in ${filterEnv}`, flag.name);
                }}
                style={{width:40,height:22,borderRadius:11,background:isOn?ec:T.elevated,border:`0.5px solid ${isOn?ec:T.borderMd}`,cursor:'pointer',position:'relative',transition:'background 0.15s',flexShrink:0}}>
                <div style={{position:'absolute',top:2,left:isOn?20:2,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.4)'}}/>
              </div>

              {/* Flag info */}
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <code style={{fontSize:13,fontFamily:'monospace',fontWeight:700,color:T.text}}>{flag.name}</code>
                  <Pill label={flag.type} color={TYPE_COLOR[flag.type]||T.blue}/>
                  {flag.tags.includes('killswitch')&&<Pill label="killswitch" color={T.red}/>}
                  {flag.tags.filter(t=>t!=='killswitch').map(t=>(
                    <span key={t} style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:T.elevated,color:T.muted,border:`0.5px solid ${T.border}`}}>{t}</span>
                  ))}
                </div>
                <div style={{fontSize:12,color:T.sec,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{flag.description}</div>
              </div>

              {/* Rollout bar */}
              {isOn&&(
                <div style={{width:120,flexShrink:0}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:T.muted,marginBottom:3}}>
                    <span>{filterEnv.slice(0,4)}</span>
                    <span style={{fontWeight:600,color:rollout===100?T.green:ec}}>{rollout}%</span>
                  </div>
                  <div style={{height:4,background:T.elevated,borderRadius:2,overflow:'hidden'}}>
                    <div style={{height:'100%',width:rollout+'%',background:rollout===100?T.green:ec,borderRadius:2,transition:'width 0.3s'}}/>
                  </div>
                </div>
              )}

              {/* Env status dots (all envs at a glance) */}
              <div style={{display:'flex',gap:5,flexShrink:0}}>
                {['production','staging','development'].map(e=>{
                  const on = flag.environments[e]?.enabled;
                  return <div key={e} title={`${e}: ${on?'on':'off'}`} style={{width:7,height:7,borderRadius:'50%',background:on?ENV_COLOR[e]:T.muted+'55'}}/>;
                })}
              </div>

              {/* Actions */}
              <div style={{display:'flex',gap:6,flexShrink:0}}>
                <button onClick={()=>setEditing(flag)} style={{fontSize:11,padding:'5px 12px',borderRadius:5,border:`0.5px solid ${T.border}`,background:T.elevated,color:T.sec,cursor:'pointer'}}>
                  Configure
                </button>
                <button onClick={()=>deleteFlag(flag)} style={{fontSize:11,padding:'5px 10px',borderRadius:5,border:`0.5px solid ${T.red}33`,background:'none',color:T.red,cursor:'pointer'}}>✕</button>
              </div>
            </div>
          );
        })}

        {filtered.length===0&&(
          <div style={{padding:'48px',textAlign:'center',background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10}}>
            <div style={{fontSize:32,marginBottom:12}}>🔘</div>
            <div style={{fontSize:14,fontWeight:500,color:T.text,marginBottom:6}}>No flags found</div>
            <div style={{fontSize:12,color:T.sec,marginBottom:20}}>Try a different filter or create your first flag.</div>
            <button onClick={()=>setShowNew(true)} style={{padding:'9px 20px',borderRadius:7,border:'none',background:T.blue,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>＋ New flag</button>
          </div>
        )}
      </div>
    </div>
  );
}

const SYS_VIEWS = new Set(['sys-overview','sys-workspaces','sys-users','sys-adapters','sys-audit','sys-flags','sys-settings','sys-backup']);

function Sidebar({view,setView}) {
  const [manageOpen,   setManageOpen]   = useState(false);
  const [providersOpen,setProvidersOpen] = useState(false);
  const [sysOpen,      setSysOpen]      = useState(false);

  // Auto-open the group that contains the active view
  const MANAGE_VIEWS    = new Set(['members','ssh-keys','api-keys','blueprints','registry','volumes','disk-cleanup','channels']);
  const PROVIDER_VIEWS_SET = new Set(['cloudflare','do-spend','git-activity']);
  React.useEffect(()=>{
    if (MANAGE_VIEWS.has(view))        setManageOpen(true);
    if (PROVIDER_VIEWS_SET.has(view))   setProvidersOpen(true);
    if (SYS_VIEWS.has(view))           setSysOpen(true);
  }, [view]);

  // Live notice counts for badges
  const notices      = computeNotices();
  const critCount    = notices.filter(n=>n.priority==='critical').length;
  const serverIssues = notices.filter(n=>n.category==='fleet').length;
  const deployIssues = notices.filter(n=>n.category==='deploy').length;
  const jobIssues    = notices.filter(n=>n.category==='job').length;
  const alertFiring  = ALERT_RULES_INIT.filter(r=>r.state==='firing').length;

  const DAILY = [
    { id:'basecamp',     icon:'⊞', label:'Basecamp',    badge: critCount > 0 ? critCount : null, badgeColor: T.red },
    { id:'dashboards',   icon:'📊', label:'Dashboards' },
    { id:'projects',     icon:'◫', label:'Projects'   },
    { id:'deployments',  icon:'⇥', label:'Deployments', badge: deployIssues || null, badgeColor: T.amber },
    { id:'servers',      icon:'▣', label:'Servers',     badge: serverIssues || null, badgeColor: T.amber },
    { id:'jobs',         icon:'⚡', label:'Jobs',         badge: jobIssues || null,   badgeColor: T.amber },
    { id:'alert-rules',  icon:'▲', label:'Alerts',       badge: alertFiring || null, badgeColor: T.red   },
    { id:'flags',        icon:'🔘', label:'Flags'                                                        },
  ];

  const WEEKLY = [
    { id:'activity',     icon:'◎', label:'Activity'      },
    { id:'networking',   icon:'⬡', label:'Networking'    },
    { id:'observability',icon:'◈', label:'Observability' },
    { id:'portal',       icon:'⬡', label:'Portal'        },
    { id:'infra-graph',  icon:'◈', label:'Infra Graph'   },
  ];

  const MANAGE = [
    { id:'members',      icon:'👥', label:'Members'       },
    { id:'ssh-keys',     icon:'🔑', label:'SSH Keys'       },
    { id:'api-keys',     icon:'⚿', label:'API Keys'       },
    { id:'blueprints',   icon:'🧩', label:'Blueprints'    },
    { id:'registry',     icon:'📦', label:'Registry'       },
    { id:'volumes',      icon:'💾', label:'Volumes'        },
    { id:'disk-cleanup', icon:'🗑', label:'Disk Cleanup'  },
    { id:'channels',     icon:'📣', label:'Channels'       },
    { id:'recipes',      icon:'📜', label:'Recipes'        },
  ];

  const PROVIDERS_NAV = [
    { id:'cloudflare',   icon:'🟠', label:'Cloudflare'     },
    { id:'do-spend',     icon:'💧', label:'DigitalOcean'   },
    { id:'git-activity', icon:'🗂', label:'Git Activity'   },
  ];

  const SYS = [
    { id:'sys-overview',   icon:'⬡', label:'Hub Overview'  },
    { id:'sys-workspaces', icon:'◫', label:'Workspaces'    },
    { id:'sys-users',      icon:'▣', label:'Users & Bots'  },
    { id:'sys-adapters',   icon:'🔌', label:'Adapters'      },
    { id:'sys-audit',      icon:'📋', label:'Audit Log'     },
    { id:'sys-flags',      icon:'🚩', label:'Feature Flags' },
    { id:'sys-settings',   icon:'⚙',  label:'Hub Settings'  },
    { id:'sys-backup',    icon:'💿', label:'Backup & Restore'},
  ];

  const NavBtn = ({ item, indent=false }) => {
    const active = view===item.id;
    const isSys  = SYS_VIEWS.has(item.id);
    const ac     = isSys ? T.sys : T.blue;
    return (
      <button onClick={()=>setView(item.id)} style={{
        width:'100%', display:'flex', alignItems:'center', gap:9,
        padding: indent ? '6px 10px 6px 22px' : '6px 10px',
        borderRadius:6, border:'none', cursor:'pointer', textAlign:'left', marginBottom:1,
        background: active ? (isSys?`${T.sys}18`:T.elevated) : 'transparent',
        color:      active ? (isSys?T.sys:T.text) : T.sec,
        fontSize:13,
      }}>
        <span style={{fontSize:12,width:16,textAlign:'center',flexShrink:0,opacity:active?1:0.8}}>{item.icon}</span>
        <span style={{flex:1,fontWeight:active?500:400}}>{item.label}</span>
        {item.badge!=null&&<span style={{fontSize:9,background:item.badgeColor||T.red,color:'#fff',borderRadius:8,padding:'1px 5px',fontWeight:700,flexShrink:0}}>{item.badge}</span>}
      </button>
    );
  };

  const GroupToggle = ({ label, open, onToggle, activeInside, color=T.muted }) => {
    const c = activeInside ? T.blue : color;
    return (
      <button onClick={onToggle} style={{
        width:'100%', display:'flex', alignItems:'center', gap:8,
        padding:'6px 10px', borderRadius:6, border:'none', cursor:'pointer',
        background: 'transparent', color: c, fontSize:12, fontWeight:600,
        textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:1,
      }}>
        <span style={{fontSize:10, transition:'transform 0.15s', display:'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)'}}>›</span>
        <span style={{flex:1, textAlign:'left'}}>{label}</span>
      </button>
    );
  };

  const manageActive    = MANAGE_VIEWS.has(view);
  const providersActive = PROVIDER_VIEWS_SET.has(view);
  const sysActive       = SYS_VIEWS.has(view);

  const Divider = () => <div style={{height:'0.5px', background:T.border, margin:'5px 8px'}}/>;

  return (
    <div style={{width:210,flexShrink:0,background:T.sidebar,borderRight:`0.5px solid ${T.border}`,display:'flex',flexDirection:'column',height:'100%'}}>
      {/* Logo + workspace */}
      <div style={{padding:'16px 14px 12px',borderBottom:`0.5px solid ${T.border}`,flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:10}}>
          <div style={{width:26,height:26,borderRadius:6,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,color:'#fff',fontWeight:700,flexShrink:0}}>P</div>
          <div style={{fontSize:13,fontWeight:700,color:T.text,letterSpacing:'-0.01em'}}>Platform Hub</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:7,padding:'5px 8px',background:T.elevated,borderRadius:5,cursor:'pointer'}}>
          <div style={{width:6,height:6,borderRadius:'50%',background:T.green,flexShrink:0}}/>
          <span style={{fontSize:11,color:T.sec,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>Acme Corp</span>
          <span style={{fontSize:10,color:T.muted,flexShrink:0}}>›</span>
        </div>
      </div>

      {/* Nav */}
      <nav style={{flex:1,padding:'8px 6px',overflowY:'auto'}}>

        {/* ── Daily ── */}
        {DAILY.map(item=><NavBtn key={item.id} item={item}/>)}

        <Divider/>

        {/* ── Weekly ── */}
        {WEEKLY.map(item=><NavBtn key={item.id} item={item}/>)}

        <Divider/>

        {/* ── Manage (collapsible) ── */}
        <GroupToggle
          label="Manage"
          open={manageOpen}
          onToggle={()=>setManageOpen(v=>!v)}
          activeInside={manageActive}
        />
        {manageOpen && MANAGE.map(item=><NavBtn key={item.id} item={item} indent/>)}

        {/* ── Providers (collapsible) ── */}
        <GroupToggle
          label="Providers"
          open={providersOpen}
          onToggle={()=>setProvidersOpen(v=>!v)}
          activeInside={providersActive}
        />
        {providersOpen && PROVIDERS_NAV.map(item=><NavBtn key={item.id} item={item} indent/>)}

        {/* ── System (collapsible, amber) ── */}
        <div style={{margin:'8px 8px 4px',display:'flex',alignItems:'center',gap:8}}>
          <div style={{flex:1,height:'0.5px',background:`${T.sys}33`}}/>
          <span style={{fontSize:9,color:T.sys,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',whiteSpace:'nowrap'}}>System</span>
          <div style={{flex:1,height:'0.5px',background:`${T.sys}33`}}/>
        </div>
        <GroupToggle
          label="Admin"
          open={sysOpen}
          onToggle={()=>setSysOpen(v=>!v)}
          activeInside={sysActive}
          color={T.sys}
        />
        {sysOpen && SYS.map(item=><NavBtn key={item.id} item={item} indent/>)}

      </nav>

      {/* User footer */}
      <div style={{padding:'10px 12px',borderTop:`0.5px solid ${T.border}`,flexShrink:0}}>
        <div onClick={()=>setView('user-settings')} style={{display:'flex',alignItems:'center',gap:9,cursor:'pointer',borderRadius:7,padding:'4px 6px',transition:'background 0.1s'}}
          onMouseEnter={e=>e.currentTarget.style.background=T.elevated}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
          <Avatar initials="SC" color={T.purple} size={27}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,color:T.text,fontWeight:500}}>sarah</div>
            <div style={{fontSize:11,color:T.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>sarah@acme.com</div>
          </div>
          <span style={{fontSize:13,color:T.muted,flexShrink:0}}>⚙</span>
        </div>
      </div>
    </div>
  );
}

function TopBar({view,selectedServer,selectedDeploy,selectedProject,selectedApp,selectedEnv,selectedDashboard,openPalette,nav}) {
  const labels={
    basecamp:'Basecamp',servers:'Servers',projects:'Projects',deployments:'Deployments',
    jobs:'Jobs',networking:'Networking',observability:'Observability',
    'server-detail':  selectedServer?.name || 'Server',
    'deploy-detail':  selectedDeploy ? `${selectedDeploy.project}/${selectedDeploy.app}` : 'Deployment',
    'project-detail': selectedProject?.name || 'Project',
    'app-detail':     selectedApp?.name || 'App',
    'ssh-keys':       'SSH Keys',
    'alert-rules':    'Alert Rules',
    'flags':          'Feature Flags',
    'channels':       'Notification Channels',
    'api-keys':       'API Keys',
    'registry':       'Container Registry',
    'volumes':        'Volume Management',
    'disk-cleanup':   'Disk Cleanup',
    'recipes':        'Server Recipes',
    'sys-backup':     'Backup & Restore',
    'blueprints':     'App Blueprints',
    'cloudflare':     'Cloudflare',
    'do-spend':       'DigitalOcean',
    'git-activity':   'Git Activity',
    'onboarding':     'Setup',
    'members':        'Members',
    'activity':       'Activity',
    'portal':         'Portal',
    'dashboards':     'Dashboards',
    'user-settings':  'Account Settings',
    'provision':      'Provision New Server',
    'dashboard-detail': selectedDashboard?.name || 'Dashboard',
    'infra-graph':    'Infrastructure Graph',
    'sys-overview':'Hub Overview','sys-workspaces':'Workspaces','sys-users':'Users & Bots',
    'sys-adapters':'Adapters','sys-audit':'Audit Log','sys-flags':'Feature Flags','sys-settings':'Hub Settings',
  };
  const isSys    = SYS_VIEWS.has(view);
  const isServer = view==='server-detail';
  const isDeploy = view==='deploy-detail';
  const isProject= view==='project-detail';
  const isApp    = view==='app-detail';
  return (
    <div style={{height:48,borderBottom:`0.5px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 22px',background:T.sidebar,flexShrink:0,gap:8,overflow:'hidden'}}>
      <span style={{fontSize:12,color:T.muted,flexShrink:0}}>Acme</span>
      <span style={{fontSize:12,color:T.muted}}>›</span>
      {isSys     && <><span style={{fontSize:12,color:T.sys,flexShrink:0}}>System</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      {isServer  && <><span style={{fontSize:12,color:T.sec,flexShrink:0}}>Servers</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      {isDeploy  && <><span style={{fontSize:12,color:T.sec,flexShrink:0}}>Deployments</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      {(isProject||isApp) && <><span style={{fontSize:12,color:T.sec,flexShrink:0}}>Projects</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      {isApp && selectedProject && <><span style={{fontSize:12,color:T.sec,flexShrink:0}}>{selectedProject.name}</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      {isApp && selectedEnv     && <><span style={{fontSize:12,color:T.sec,flexShrink:0}}>{selectedEnv}</span><span style={{fontSize:12,color:T.muted}}>›</span></>}
      <span style={{fontSize:13,color:T.text,fontWeight:500,flexShrink:0}}>{labels[view]}</span>
      {isServer  && selectedServer && <Pill label={selectedServer.status} color={sColor(selectedServer.status)}/>}
      {isDeploy  && selectedDeploy && <><Pill label={selectedDeploy.env} color={selectedDeploy.env==='production'?T.red:selectedDeploy.env==='staging'?T.amber:T.blue}/><span style={{fontSize:12,color:T.sec,fontFamily:'monospace',marginLeft:4}}>{selectedDeploy.version}</span></>}
      {isApp     && selectedApp    && <Pill label={selectedApp.type} color={APP_TYPE_COLOR[selectedApp.type]||T.blue}/>}
      <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
        <button onClick={openPalette} style={{display:'flex',alignItems:'center',gap:7,background:T.elevated,border:`0.5px solid ${T.border}`,borderRadius:6,padding:'5px 11px',cursor:'pointer',color:T.muted,fontSize:12}}>
          <span>⌕</span><span style={{whiteSpace:'nowrap'}}>Search…</span><Kbd>⌘K</Kbd>
        </button>
        <div style={{position:'relative',cursor:'pointer'}}><span style={{fontSize:15,color:T.sec}}>🔔</span><span style={{position:'absolute',top:-3,right:-3,width:7,height:7,background:T.red,borderRadius:'50%'}}/></div>
        <button onClick={()=>nav('provision')} style={{display:'flex',alignItems:'center',gap:6,background:'none',border:`0.5px solid ${T.borderMd}`,borderRadius:6,padding:'5px 12px',color:T.sec,fontSize:14,cursor:'pointer'}}>＋</button>
      </div>
    </div>
  );
}

export default function App() {
  const [view,setView]                        = useState('basecamp');
  const [selectedServer, setSelectedServer]   = useState(null);
  const [selectedDeploy, setSelectedDeploy]   = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedApp, setSelectedApp]         = useState(null);
  const [selectedEnv, setSelectedEnv]         = useState(null);
  const [selectedDashboard, setSelectedDashboard] = useState(null);
  const [showPalette,setPalette]              = useState(false);
  const { toasts, toast, dismiss }            = useToastState();

  useEffect(()=>{
    const h=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();setPalette(p=>!p);}};
    window.addEventListener('keydown',h);
    return()=>window.removeEventListener('keydown',h);
  },[]);

  const clearAll    = () => { setSelectedServer(null); setSelectedDeploy(null); setSelectedProject(null); setSelectedApp(null); setSelectedEnv(null); setSelectedDashboard(null); };
  const nav         = v => { clearAll(); setView(v); setPalette(false); };
  const openServer  = s => { clearAll(); setSelectedServer(s);  setView('server-detail');  };
  const openDeploy  = d => { clearAll(); setSelectedDeploy(d);  setView('deploy-detail');  };
  const openProject = p => { clearAll(); setSelectedProject(p); setView('project-detail'); };
  const [appEditMode, setAppEditMode] = useState(false);
  const openApp     = (app, proj, env, editMode=false) => { setSelectedApp(app); setSelectedProject(proj); setSelectedEnv(env); setAppEditMode(editMode); setView('app-detail'); };

  return (
    <ToastCtx.Provider value={toast}>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',background:T.bg,color:T.text,fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
        <Sidebar view={view} setView={v=>{clearAll();setView(v);}}/>
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <TopBar view={view} selectedServer={selectedServer} selectedDeploy={selectedDeploy} selectedProject={selectedProject} selectedApp={selectedApp} selectedEnv={selectedEnv} selectedDashboard={selectedDashboard} openPalette={()=>setPalette(true)} nav={nav}/>
          <div style={{flex:1,overflowY:'auto'}}>
            {view==='basecamp'       && <BasecampView nav={nav}/>}
            {view==='dashboards'     && <DashboardsView onOpen={d=>{setSelectedDashboard(d);setView('dashboard-detail');}}/>}
            {view==='dashboard-detail' && selectedDashboard && <DashboardDetailView dashboard={selectedDashboard} onBack={()=>nav('dashboards')}/>}
            {view==='servers'        && <ServersView onSelect={openServer} nav={nav}/>}
            {view==='server-detail'  && selectedServer  && <ServerDetailView server={selectedServer} onBack={()=>nav('servers')} nav={nav}/>}
            {view==='projects'       && <ProjectsView onSelect={openProject} nav={nav}/>}
            {view==='project-detail' && selectedProject && <ProjectDetailView project={selectedProject} onBack={()=>nav('projects')} onOpenApp={(app,env,editMode)=>openApp(app,selectedProject,env,editMode)} onOpenDeploy={openDeploy}/>}
            {view==='app-detail'     && selectedApp     && <AppDetailView app={selectedApp} project={selectedProject} envName={selectedEnv||'production'} editMode={appEditMode} onBack={(to)=>{ if(to==='projects'){nav('projects');}else if(to==='project'){openProject(selectedProject);}else if(to==='env'){setSelectedApp(null);setView('project-detail');} }} onOpenDeploy={openDeploy}/>}
            {view==='ssh-keys'       && <SSHKeysView/>}
            {view==='api-keys'       && <ApiKeysView/>}
            {view==='registry'       && <RegistryView/>}
            {view==='volumes'        && <VolumesView/>}
            {view==='disk-cleanup'    && <DiskCleanupView/>}
            {view==='recipes'         && <RecipesView/>}
            {view==='blueprints'      && <BlueprintMarketplaceView nav={nav}/>}
            {view==='cloudflare'     && <CloudflareView/>}
            {view==='do-spend'       && <DigitalOceanView/>}
            {view==='git-activity'   && <GitActivityView/>}
            {view==='onboarding'     && <OnboardingView nav={nav}/>}
            {view==='provision'       && <ProvisionServerView nav={nav}/>}
            {view==='user-settings'   && <UserSettingsView nav={nav}/>}
            {view==='members'        && <MembersView/>}
            {view==='activity'       && <ActivityFeedView nav={nav}/>}
            {view==='deployments'    && <DeploymentsView onSelect={openDeploy}/>}
            {view==='deploy-detail'  && selectedDeploy  && <DeploymentDetailView deployment={selectedDeploy} onBack={()=>nav('deployments')}/>}
            {view==='alert-rules'    && <AlertRulesView onGoChannels={()=>nav('channels')}/>}
            {view==='flags'           && <WorkspaceFlagsView/>}
            {view==='channels'        && <NotificationChannelsView/>}
            {view==='portal'         && <PortalView/>}
            {view==='infra-graph'    && <InfraGraphView onOpenServer={openServer} onOpenProject={p=>{ nav('projects'); }}/>}
            {view==='networking'     && <NetworkingView/>}
            {view==='observability'  && <ObservabilityView/>}
            {view==='jobs'           && <JobsView/>}
            {view==='sys-overview'   && <SysOverviewView/>}
            {view==='sys-workspaces' && <WorkspacesView/>}
            {view==='sys-users'      && <UsersView/>}
            {view==='sys-adapters'   && <AdaptersView/>}
            {view==='sys-audit'      && <AuditLogView/>}
            {view==='sys-flags'      && <FlagsView/>}
            {view==='sys-settings'   && <HubSettingsView/>}
            {view==='sys-backup'      && <HubBackupView/>}
          </div>
        </div>
        {showPalette&&<CommandPalette onClose={()=>setPalette(false)} nav={nav}/>}
        <ToastStack toasts={toasts} onDismiss={dismiss}/>
      </div>
    </ToastCtx.Provider>
  );
}
