---
paths:
  - "packages/junction/src/**"
  - "packages/{caravan,conduit,notifications,mcp,orion}/src/**"
  - "**/api/src/**/*.{js,mjs,ts}"
---

# API realm

Reading a service, hook, `ctx` use, raw route, plugin, job or cron: load the `api-hazards` skill before editing. It is an index with one reference file per section, so open only the section that matches what you touch. A seam you are about to grep for is `bridge-index`.
