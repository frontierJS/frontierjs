---
paths:
  - "**/*.lite"
  - "packages/litestone/src/**"
  - "packages/auth/src/**"
  - "**/db/**/*.{js,mjs,ts}"
---

# Data realm

Reading a schema, gate, policy, migration, tenant or audit-trail file: load the `data-hazards` skill before editing. It is an index with one reference file per section, so open only the section that matches what you touch. A seam you are about to grep for is `bridge-index`.
