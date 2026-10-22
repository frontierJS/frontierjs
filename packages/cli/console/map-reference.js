// ─── map-reference.js — what the chain IS, the same for every project ───────
//
// The nodes, the three realms, what each hook point is for, and three
// explainers (workflows, error paths, the session shape). It describes
// FrontierJS, not the project the map reads, so every panel drawn from it says
// so; the hook lists under each node are illustrative.

export const REF = {
  "CHAIN_DATA": {
    "nodes": [
      {
        "id": "schema",
        "lane": "out",
        "realm": "data",
        "x": 0,
        "label": "schema.lite",
        "sub": "JSON Schema"
      },
      {
        "id": "svc-after",
        "lane": "out",
        "realm": "api",
        "x": 1,
        "label": "Service",
        "sub": "After Hook"
      },
      {
        "id": "app-after",
        "lane": "out",
        "realm": "api",
        "x": 2,
        "label": "App",
        "sub": "After Hook"
      },
      {
        "id": "transport-out",
        "lane": "out",
        "realm": "api",
        "x": 3,
        "label": "Transport",
        "sub": "Outgoing"
      },
      {
        "id": "webclient-res",
        "lane": "out",
        "realm": "ui",
        "x": 4,
        "label": "WebClient",
        "sub": "Response"
      },
      {
        "id": "resource-out",
        "lane": "out",
        "realm": "ui",
        "x": 5,
        "label": "Resource",
        "sub": "After Hook"
      },
      {
        "id": "litestone-w",
        "lane": "mid",
        "realm": "data",
        "x": 0,
        "label": "Litestone",
        "sub": "write result"
      },
      {
        "id": "gate",
        "lane": "mid",
        "realm": "data",
        "x": 0,
        "label": "Gate Plugin",
        "sub": "@@gate(R.C.U.D)"
      },
      {
        "id": "sqlite",
        "lane": "mid",
        "realm": "data",
        "x": 0,
        "label": "SQLite",
        "sub": "db write/read"
      },
      {
        "id": "litestone-r",
        "lane": "mid",
        "realm": "data",
        "x": 0,
        "label": "Litestone",
        "sub": "read query"
      },
      {
        "id": "resource-in",
        "lane": "in",
        "realm": "ui",
        "x": 5,
        "label": "Resource",
        "sub": "Before Hook"
      },
      {
        "id": "webclient-req",
        "lane": "in",
        "realm": "ui",
        "x": 4,
        "label": "WebClient",
        "sub": "Request"
      },
      {
        "id": "transport-in",
        "lane": "in",
        "realm": "api",
        "x": 3,
        "label": "Transport",
        "sub": "Incoming"
      },
      {
        "id": "app-before",
        "lane": "in",
        "realm": "api",
        "x": 2,
        "label": "App",
        "sub": "Before Hook"
      },
      {
        "id": "svc-before",
        "lane": "in",
        "realm": "api",
        "x": 1,
        "label": "Service",
        "sub": "Before Hook"
      },
      {
        "id": "schema-in",
        "lane": "in",
        "realm": "data",
        "x": 0,
        "label": "schema.lite",
        "sub": "validates data"
      },
      {
        "id": "ui-resource",
        "lane": "ui",
        "realm": "ui",
        "x": 0,
        "label": "Resource",
        "sub": "service binding"
      },
      {
        "id": "ui-store",
        "lane": "ui",
        "realm": "ui",
        "x": 0,
        "label": "Store",
        "sub": "reactive state"
      },
      {
        "id": "ui-component",
        "lane": "ui",
        "realm": "ui",
        "x": 0,
        "label": "Component",
        "sub": "renders / events"
      },
      {
        "id": "ui-make",
        "lane": "ui",
        "realm": "ui",
        "x": 0,
        "label": "make()",
        "sub": "schema factory"
      }
    ],
    "realms": [
      {
        "id": "litestone",
        "label": "Litestone",
        "realm": "data",
        "sub": "ORM · Schema · Gate · SQLite",
        "nouns": []
      },
      {
        "id": "junction",
        "label": "Junction",
        "realm": "api",
        "sub": "HTTP · WebSocket · Hooks · Channels",
        "nouns": []
      },
      {
        "id": "sierra",
        "label": "Sierra",
        "realm": "ui",
        "sub": "Vite · File-system routing · Resources · Mesa",
        "nouns": []
      }
    ],
    "hookDetail": {
      "svc-after": {
        "title": "Service After Hooks",
        "desc": "Run after every successful service operation. Publish events, audit writes, invalidate caches.",
        "hooks": [
          {
            "phase": "after.create",
            "fns": [
              "publish(channel(\"contacts\"))"
            ],
            "svc": "contacts"
          },
          {
            "phase": "after.patch",
            "fns": [
              "publish(channel(\"contacts\"))"
            ],
            "svc": "contacts"
          },
          {
            "phase": "after.remove",
            "fns": [
              "publish(channel(\"contacts\"))"
            ],
            "svc": "contacts"
          },
          {
            "phase": "after.create",
            "fns": [
              "publish(channel(\"deals\"))"
            ],
            "svc": "deals"
          },
          {
            "phase": "after.create",
            "fns": [
              "publish(channel(\"notes\"))"
            ],
            "svc": "notes"
          }
        ],
        "context": "{ service, method, id, data, params, result, error, app }"
      },
      "app-after": {
        "title": "App After Hooks",
        "desc": "Global app-level hooks. Run after all services. Used for correlation ID stamping, response shaping.",
        "hooks": [
          {
            "phase": "after.all",
            "fns": [
              "correlationId.stamp(ctx)"
            ],
            "svc": "app-level"
          }
        ],
        "context": "{ service, method, id, data, params, result, error, app }"
      },
      "transport-out": {
        "title": "Transport — Outgoing",
        "desc": "Result serialized to HTTP response or WebSocket event payload. No hook runs here — transport is transparent.",
        "hooks": [
          {
            "phase": "HTTP",
            "fns": [
              "JSON.stringify(result)",
              "res.json(result)"
            ],
            "svc": "transport"
          },
          {
            "phase": "WS",
            "fns": [
              "emit(\"contacts:created\", record)"
            ],
            "svc": "transport"
          }
        ],
        "context": "HTTP: { req, res } · WS: [event, ...args]"
      },
      "webclient-res": {
        "title": "WebClient — Response",
        "desc": "Browser receives HTTP response or WebSocket push event. Sierra parses and hands off to the resource.",
        "hooks": [],
        "context": "{ status, data, headers }"
      },
      "resource-out": {
        "title": "Resource After Hooks",
        "desc": "Client-side after hooks. Transform incoming data — ISO strings to Date objects, format currency, normalize shapes.",
        "hooks": [
          {
            "phase": "after.all",
            "fns": [
              "formatDates"
            ],
            "svc": "Contact / Company / Deal / Activity"
          },
          {
            "phase": "after.all",
            "fns": [
              "formatCurrency"
            ],
            "svc": "Deal"
          }
        ],
        "context": "{ service, model, method, id, data, params, result, type: \"after\" }"
      },
      "svc-before": {
        "title": "Service Before Hooks",
        "desc": "Gate to the Data realm. Authenticate the caller, validate the payload against JSON Schema, transform data.",
        "hooks": [
          {
            "phase": "before.all",
            "fns": [
              "authenticate"
            ],
            "svc": "contacts / companies / notes / activities"
          },
          {
            "phase": "before.patch",
            "fns": [
              "authenticate"
            ],
            "svc": "deals"
          },
          {
            "phase": "before.remove",
            "fns": [
              "authenticate"
            ],
            "svc": "deals"
          },
          {
            "phase": "before.create",
            "fns": [
              "validate(jsonSchema)"
            ],
            "svc": "all services (auto-generated)"
          },
          {
            "phase": "before.patch",
            "fns": [
              "validate(jsonSchema)"
            ],
            "svc": "all services (auto-generated)"
          }
        ],
        "context": "{ service, method, id, data, params, result, error, app }"
      },
      "app-before": {
        "title": "App Before Hooks",
        "desc": "Global app-level before hooks. withLitestoneDb attaches a per-request, auth-scoped DB client to every service call.",
        "hooks": [
          {
            "phase": "around.all",
            "fns": [
              "withLitestoneDb(db, (base, { user }) => user ? base.$setAuth(user) : base)"
            ],
            "svc": "app-level"
          }
        ],
        "context": "{ service, method, id, data, params, result, error, app }"
      },
      "transport-in": {
        "title": "Transport — Incoming",
        "desc": "HTTP request or WebSocket message arrives. Token extracted, parsed, handed to auth verifier.",
        "hooks": [
          {
            "phase": "HTTP",
            "fns": [
              "extractBearerToken(req.headers)",
              "IAuth.verifySession(token)"
            ],
            "svc": "transport"
          },
          {
            "phase": "WS",
            "fns": [
              "verifySession(conn.query.token)",
              "attach SessionContext"
            ],
            "svc": "transport"
          }
        ],
        "context": "HTTP: { req, res } · WS: [event, ...args]"
      },
      "resource-in": {
        "title": "Resource Before Hooks",
        "desc": "Client-side before hooks. Normalize data before it leaves the browser — format datetimes, clear empty strings.",
        "hooks": [
          {
            "phase": "before.create",
            "fns": [
              "formatDateTimeValues"
            ],
            "svc": "all resources"
          },
          {
            "phase": "before.patch",
            "fns": [
              "formatDateTimeValues"
            ],
            "svc": "all resources"
          }
        ],
        "context": "{ service, model, method, id, data, params, result, type: \"before\" }"
      },
      "webclient-req": {
        "title": "WebClient — Request",
        "desc": "Sierra attaches auth token to every HTTP request header and WebSocket connection query string.",
        "hooks": [],
        "context": "{ method, url, headers: { Authorization: \"Bearer <token>\" } }"
      },
      "schema": {
        "title": "Schema — JSON Schema artifact",
        "desc": "generateJsonSchema(db.$schema) produces the JSON Schema artifact. Flows into Junction for validation, Sierra for make() factories.",
        "hooks": [
          {
            "phase": "radiation",
            "fns": [
              "generateJsonSchema(db.$schema)"
            ],
            "svc": "api/server.ts"
          },
          {
            "phase": "junction",
            "fns": [
              "createLitestoneService({ schema: jsonSchema })"
            ],
            "svc": "validation auto-generated"
          },
          {
            "phase": "sierra",
            "fns": [
              "GET /api/schema.json",
              "resource.make() factories"
            ],
            "svc": "browser"
          }
        ],
        "context": "JSON Schema · field types · constraints · defaults"
      },
      "schema-in": {
        "title": "Schema — validates incoming data",
        "desc": "The JSON Schema derived from schema.lite drives create + patch validators in Junction automatically.",
        "hooks": [
          {
            "phase": "before.create",
            "fns": [
              "validateSchema(jsonSchema, data)"
            ],
            "svc": "all services"
          },
          {
            "phase": "before.patch",
            "fns": [
              "validateSchema(jsonSchema, data)"
            ],
            "svc": "all services"
          }
        ],
        "context": "JSON Schema constraints enforced before Data realm is reached"
      },
      "litestone-w": {
        "title": "Litestone — write result",
        "desc": "After the gate passes, Litestone executes the write and returns the created/updated/deleted record.",
        "hooks": [
          {
            "phase": "onAfterWrite",
            "fns": [
              "AuditPlugin.log(operation, record, user)"
            ],
            "svc": "data-level plugin"
          }
        ],
        "context": "{ model, operation, args, user, level }"
      },
      "litestone-r": {
        "title": "Litestone — read query",
        "desc": "Auth-scoped db client executes the find/get query. withLitestoneDb has already called $setAuth(user) so the gate level is set.",
        "hooks": [
          {
            "phase": "onBeforeRead",
            "fns": [
              "GatePlugin.injectWhereClause(user.level)"
            ],
            "svc": "data-level plugin"
          }
        ],
        "context": "{ model, operation, args, user, level }"
      },
      "gate": {
        "title": "Gate Plugin",
        "desc": "Enforces @@gate(R.C.U.D) on every operation. User trust level must meet the declared minimum or the operation throws.",
        "hooks": [
          {
            "phase": "Read",
            "fns": [
              "user.level >= gate.read   || throw 403"
            ],
            "svc": "all models"
          },
          {
            "phase": "Create",
            "fns": [
              "user.level >= gate.create || throw 403"
            ],
            "svc": "all models"
          },
          {
            "phase": "Update",
            "fns": [
              "user.level >= gate.update || throw 403"
            ],
            "svc": "all models"
          },
          {
            "phase": "Delete",
            "fns": [
              "user.level >= gate.delete || throw 403"
            ],
            "svc": "all models"
          }
        ],
        "context": "Trust: STRANGER(0) → VISITOR(1) → READER(2) → CREATOR(3) → USER(4) → ADMIN(5) → OWNER(6) → SYSADMIN(7) → SYSTEM(8)"
      },
      "sqlite": {
        "title": "SQLite",
        "desc": "The database. Bun-native SQLite. One file per tenant. Litestream streams WAL to S3 for continuous backup.",
        "hooks": [],
        "context": "./db/acme-crm.db · WAL mode · Litestream replica"
      },
      "ui-resource": {
        "title": "Resource",
        "desc": "The UI binding for a service. Module block runs once — any component importing this file shares the same store, service, and make factory.",
        "hooks": [
          {
            "phase": "createResource",
            "fns": [
              "resource.createResource({ model: 'Lead', service: 'leads' })"
            ],
            "svc": "web/src/resources/Lead.mesa"
          },
          {
            "phase": "exports",
            "fns": [
              "store, service, make, load, context"
            ],
            "svc": "shared across all importing components"
          }
        ],
        "context": "{ model, service, idField }"
      },
      "ui-store": {
        "title": "Store",
        "desc": "Reactive container for resource data. Auto-syncs via WebSocket events — creates upsert, patch updates, remove deletes. Components subscribe and re-render on change.",
        "hooks": [
          {
            "phase": "ws:created",
            "fns": [
              "store.upsert(record)"
            ],
            "svc": "auto-wired by createResource"
          },
          {
            "phase": "ws:patched",
            "fns": [
              "store.upsert(record)"
            ],
            "svc": "auto-wired by createResource"
          },
          {
            "phase": "ws:removed",
            "fns": [
              "store.remove(id)"
            ],
            "svc": "auto-wired by createResource"
          }
        ],
        "context": "store.get() → T[] · store.set(records) · store.upsert(record) · store.remove(id)"
      },
      "ui-component": {
        "title": "Component",
        "desc": "Mesa or framework component that consumes the store. Subscribes to store changes, calls service methods, renders reactive UI. Events flow back into the chain via service calls.",
        "hooks": [
          {
            "phase": "useStore",
            "fns": [
              "const leads = useStore(leadsStore)"
            ],
            "svc": "subscribes, re-renders on change"
          },
          {
            "phase": "onMount",
            "fns": [
              "leadsStore.set(data.leads)"
            ],
            "svc": "seeds from load() prefetch"
          },
          {
            "phase": "onDestroy",
            "fns": [
              "leads.unsubscribe()"
            ],
            "svc": "cleanup"
          }
        ],
        "context": "Mesa reactive runtime · fine-grained subscriptions · no virtual DOM diffing"
      },
      "ui-make": {
        "title": "make()",
        "desc": "Schema-driven factory function. Returns a blank model instance with all fields initialized to schema-correct defaults. The only place JSON Schema directly touches the UI at construction time.",
        "hooks": [
          {
            "phase": "schema → make",
            "fns": [
              "GET /api/schema.json",
              "resource.make() factories"
            ],
            "svc": "JSON Schema radiation → UI"
          },
          {
            "phase": "usage",
            "fns": [
              "const lead = make({ status: \"active\" })"
            ],
            "svc": "overrides merge with schema defaults"
          }
        ],
        "context": "make(spec?) → T · spec overrides merge with schema defaults · always returns valid shape"
      }
    }
  },
  "TIER1_REGISTRY": [
    {
      "id": "auth",
      "label": "@frontierjs/auth",
      "short": "auth",
      "realm": "junction",
      "chainPoints": [
        {
          "nodeId": "transport-in",
          "role": "verifySession(token)"
        },
        {
          "nodeId": "svc-before",
          "role": "authenticate hook"
        },
        {
          "nodeId": "transport-out",
          "role": "SessionContext stamp"
        }
      ]
    },
    {
      "id": "conduit",
      "label": "@frontierjs/conduit",
      "short": "conduit",
      "realm": "junction",
      "chainPoints": [
        {
          "nodeId": "svc-after",
          "role": "outbound integrations"
        }
      ]
    },
    {
      "id": "caravan",
      "label": "@frontierjs/caravan",
      "short": "caravan",
      "realm": "junction",
      "chainPoints": [
        {
          "nodeId": "svc-after",
          "role": "enqueue background jobs"
        }
      ]
    },
    {
      "id": "notifications",
      "label": "@frontierjs/notifications",
      "short": "notifications",
      "realm": "junction",
      "chainPoints": [
        {
          "nodeId": "svc-after",
          "role": "app.notify(user, notification)"
        },
        {
          "nodeId": "sqlite",
          "role": "inApp → notifications table"
        },
        {
          "nodeId": "resource-out",
          "role": "WS push notification:created"
        }
      ]
    },
    {
      "id": "litestream",
      "label": "litestream",
      "short": "litestream",
      "realm": "litestone",
      "chainPoints": [
        {
          "nodeId": "sqlite",
          "role": "WAL stream → S3"
        }
      ]
    }
  ],
  "WORKFLOWS": [
    {
      "id": "add-model",
      "label": "Add a model end-to-end",
      "steps": [
        {
          "file": "db/schema.lite",
          "action": "Define model, fields, gate, plugins",
          "cmd": null
        },
        {
          "file": null,
          "action": "Push schema to local DB",
          "cmd": "fli db:push"
        },
        {
          "file": "api/src/server.ts",
          "action": "Register createLitestoneService({ name, model, schema })",
          "cmd": null
        },
        {
          "file": "web/src/resources/Model.mesa",
          "action": "Create resource with createResource({ model, service })",
          "cmd": null
        },
        {
          "file": "web/src/routes/models/index.mesa",
          "action": "Add route, import store from resource, seed from load()",
          "cmd": null
        },
        {
          "file": "web/src/routes/models/index.meta.js",
          "action": "Add load() function for prefetch",
          "cmd": null
        },
        {
          "file": null,
          "action": "Create migration file when ready to commit",
          "cmd": "fli db:migrate"
        }
      ]
    },
    {
      "id": "add-route",
      "label": "Add a new page / route",
      "steps": [
        {
          "file": "web/src/routes/path/index.mesa",
          "action": "Create route component file",
          "cmd": null
        },
        {
          "file": "web/src/routes/path/index.meta.js",
          "action": "Add load() if prefetch needed",
          "cmd": null
        },
        {
          "file": "web/config/sierra.config.js",
          "action": "Add to publicRoutes if unauthenticated",
          "cmd": null
        },
        {
          "file": "web/src/resources/Model.mesa",
          "action": "Import store, service, make from resource",
          "cmd": null
        }
      ]
    },
    {
      "id": "add-hook",
      "label": "Add a service hook",
      "steps": [
        {
          "file": "api/src/hooks/myHook.ts",
          "action": "Write hook function (ctx) => void",
          "cmd": null
        },
        {
          "file": "api/src/server.ts",
          "action": "Add to service hooks.before or hooks.after array",
          "cmd": null
        },
        {
          "file": null,
          "action": "Hook receives full ServiceContext — mutate ctx.data or throw",
          "cmd": null
        }
      ]
    },
    {
      "id": "add-notification",
      "label": "Add a notification type",
      "steps": [
        {
          "file": "api/src/notifications/MyNotif.ts",
          "action": "Extend Notification, implement via(), toInApp(), toEmail()",
          "cmd": null
        },
        {
          "file": "api/src/services/users.ts",
          "action": "Call await ctx.app.notify(user, new MyNotif(data)) in after hook",
          "cmd": null
        },
        {
          "file": "web/src/resources/Notification.mesa",
          "action": "onEvent(\"notification:created\") auto-updates store via WS",
          "cmd": null
        },
        {
          "file": null,
          "action": "No schema migration needed — type stored as string identifier",
          "cmd": null
        }
      ]
    },
    {
      "id": "add-job",
      "label": "Add a background job",
      "steps": [
        {
          "file": "api/src/jobs/myJob.ts",
          "action": "Define job({ name, perform: async (data, { app }) => {} })",
          "cmd": null
        },
        {
          "file": "api/src/server.ts",
          "action": "Add to caravanPlugin jobs array",
          "cmd": null
        },
        {
          "file": "api/src/services/myService.ts",
          "action": "Enqueue from after hook: await caravan.enqueue(\"my-job\", data)",
          "cmd": null
        },
        {
          "file": null,
          "action": "Job runs at SYSTEM trust level — use db.asSystem() for writes",
          "cmd": null
        }
      ]
    },
    {
      "id": "deploy",
      "label": "Deploy to production",
      "steps": [
        {
          "file": null,
          "action": "Run full test suite",
          "cmd": "fli test"
        },
        {
          "file": null,
          "action": "Verify DB schema matches migrations",
          "cmd": "fli db:verify"
        },
        {
          "file": null,
          "action": "Check for gap errors (exits 1 if any)",
          "cmd": "fli project:map --gaps"
        },
        {
          "file": null,
          "action": "Deploy all sub-projects (migrations run automatically)",
          "cmd": "fli deploy --production"
        },
        {
          "file": null,
          "action": "Check deployment status",
          "cmd": "fli deploy:status"
        }
      ]
    }
  ],
  "ERROR_PATHS": [
    {
      "id": "gate-deny",
      "label": "Gate denies access",
      "trigger": "user.level < gate.required",
      "nodes": [
        {
          "node": "transport-in",
          "outcome": "Token extracted and verified",
          "status": "pass"
        },
        {
          "node": "app-before",
          "outcome": "withLitestoneDb scopes db to user",
          "status": "pass"
        },
        {
          "node": "svc-before",
          "outcome": "authenticate hook passes",
          "status": "pass"
        },
        {
          "node": "gate",
          "outcome": "user.level (0) < gate.create (4) → throws 403",
          "status": "fail"
        },
        {
          "node": "svc-after",
          "outcome": "skipped — chain aborted",
          "status": "skip"
        },
        {
          "node": "transport-out",
          "outcome": "HTTP 403 Forbidden returned",
          "status": "error"
        }
      ]
    },
    {
      "id": "auth-fail",
      "label": "Authentication fails",
      "trigger": "Invalid or expired token",
      "nodes": [
        {
          "node": "transport-in",
          "outcome": "Token extracted from Authorization header",
          "status": "pass"
        },
        {
          "node": "app-before",
          "outcome": "withLitestoneDb attaches db",
          "status": "pass"
        },
        {
          "node": "svc-before",
          "outcome": "authenticate hook: verifySession(token) → throws 401",
          "status": "fail"
        },
        {
          "node": "gate",
          "outcome": "skipped — chain aborted before data realm",
          "status": "skip"
        },
        {
          "node": "svc-after",
          "outcome": "skipped",
          "status": "skip"
        },
        {
          "node": "transport-out",
          "outcome": "HTTP 401 Unauthorized returned",
          "status": "error"
        }
      ]
    },
    {
      "id": "validation-fail",
      "label": "Validation fails",
      "trigger": "Payload fails JSON Schema validation",
      "nodes": [
        {
          "node": "transport-in",
          "outcome": "Request received and parsed",
          "status": "pass"
        },
        {
          "node": "app-before",
          "outcome": "withLitestoneDb attaches db",
          "status": "pass"
        },
        {
          "node": "svc-before",
          "outcome": "authenticate passes, validate(jsonSchema) → throws 422",
          "status": "fail"
        },
        {
          "node": "gate",
          "outcome": "skipped",
          "status": "skip"
        },
        {
          "node": "svc-after",
          "outcome": "skipped",
          "status": "skip"
        },
        {
          "node": "transport-out",
          "outcome": "HTTP 422 Unprocessable Entity + field errors returned",
          "status": "error"
        }
      ]
    },
    {
      "id": "hook-throw",
      "label": "After hook throws",
      "trigger": "Service after hook throws unexpectedly",
      "nodes": [
        {
          "node": "svc-before",
          "outcome": "All before hooks pass",
          "status": "pass"
        },
        {
          "node": "gate",
          "outcome": "Gate passes",
          "status": "pass"
        },
        {
          "node": "sqlite",
          "outcome": "Write succeeds",
          "status": "pass"
        },
        {
          "node": "svc-after",
          "outcome": "publish() throws (channel unavailable) → error hook runs",
          "status": "fail"
        },
        {
          "node": "transport-out",
          "outcome": "HTTP 500 Internal Server Error — write already committed",
          "status": "error"
        }
      ],
      "note": "The write already committed to SQLite. The after hook failure does not roll it back. Use transactions if atomicity is required."
    }
  ],
  "SESSION_DATA": {
    "contextShape": [
      {
        "key": "id",
        "type": "string",
        "example": "'usr_abc123'",
        "desc": "Unique user identifier"
      },
      {
        "key": "email",
        "type": "string",
        "example": "'user@acme.com'",
        "desc": "User email address"
      },
      {
        "key": "firstName",
        "type": "string?",
        "example": "'Alice'",
        "desc": "Optional first name"
      },
      {
        "key": "lastName",
        "type": "string?",
        "example": "'Smith'",
        "desc": "Optional last name"
      },
      {
        "key": "role",
        "type": "string",
        "example": "'user' | 'admin'",
        "desc": "Application role"
      },
      {
        "key": "level",
        "type": "number",
        "example": "4  // USER",
        "desc": "Trust level 0–9 for gate enforcement"
      },
      {
        "key": "authMethod",
        "type": "string",
        "example": "'password' | 'created'",
        "desc": "How session was established. 'created' = new user registration"
      },
      {
        "key": "scopes",
        "type": "string[]",
        "example": "['read', 'write']",
        "desc": "Optional permission scopes"
      }
    ],
    "lifecycle": [
      {
        "step": "Login",
        "desc": "POST /auth/login → verifySession issues opaque token → stored in localStorage via tokenKey"
      },
      {
        "step": "HTTP attach",
        "desc": "Sierra attaches token as Authorization: Bearer <token> header on every request"
      },
      {
        "step": "WS attach",
        "desc": "Junction WS connection receives token in query string → authenticates once at upgrade time"
      },
      {
        "step": "Verify",
        "desc": "transport-in: IAuth.verifySession(token) → resolves SessionContext"
      },
      {
        "step": "Scope",
        "desc": "withLitestoneDb: db.$setAuth(user) → GatePlugin reads user.level for every operation"
      },
      {
        "step": "Logout",
        "desc": "sierra.logout() → clears token → disconnects WS → redirects to auth.redirectTo"
      },
      {
        "step": "WS re-auth",
        "desc": "After login, WS disconnects and reconnects so new session takes effect at transport level"
      }
    ],
    "trustLevels": [
      {
        "level": 0,
        "name": "STRANGER",
        "desc": "Unauthenticated. Read-only public data."
      },
      {
        "level": 1,
        "name": "VISITOR",
        "desc": "Identified but unverified."
      },
      {
        "level": 2,
        "name": "READER",
        "desc": "Can read non-public content."
      },
      {
        "level": 3,
        "name": "CREATOR",
        "desc": "Can create limited content."
      },
      {
        "level": 4,
        "name": "USER",
        "desc": "Standard authenticated user. Most write operations."
      },
      {
        "level": 5,
        "name": "ADMIN",
        "desc": "Elevated privileges. Can modify others."
      },
      {
        "level": 6,
        "name": "OWNER",
        "desc": "Record owner. Can delete own records."
      },
      {
        "level": 7,
        "name": "SYSADMIN",
        "desc": "Full application access."
      },
      {
        "level": 8,
        "name": "SYSTEM",
        "desc": "Internal system calls only. db.asSystem()."
      },
      {
        "level": 9,
        "name": "LOCKED",
        "desc": "No code path can reach this. Hard lock."
      }
    ]
  },
  "TRUST": [
    "STRANGER",
    "VISITOR",
    "READER",
    "CREATOR",
    "USER",
    "ADMIN",
    "OWNER",
    "SYSADMIN",
    "SYSTEM",
    "LOCKED"
  ]
}
