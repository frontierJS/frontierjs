---
id: deploy-posture
status: proposed
dated: 2026-10-16
---

# Idea — Posture at deploy: `fli deploy` refuses what the graders already know

**Status: IDEA.** Probed against the tree 2026-10-16. Do not cite this file as behavior.

Prompted by the owner: *do we / should we have some kind of security check on deploys?*
**Posture** is the repo's existing word for *standing against known risk*
(`IDEAS/server-posture.md`, `scripts/ci.mjs` phase 8). This asks it of a deploy.

---

## What exists (probed)

Every grader below exists. What is missing is a deploy that asks them.

| Piece | Where | Runs on a deploy? |
| --- | --- | --- |
| Build check — refuses a build that bakes config or a credential into the image (`context-config`, `env-config`, `build-secret`), warns on `unpinned-base` | `packages/cli/core/build-check.js`, step `02b-build-check` | **Yes**, refuses on error. Off with `api.buildCheck: false`. |
| Env check — the server's env file carries every declared key | step `01b-env-check` | Only when opted in, and it checks key presence only. |
| `deploy:doctor` — `.env` gitignored, tree clean, commits pushed, … | `packages/cli/commands/deploy/doctor.md` | No. Run by hand. |
| `fli check` app rules — `gate-unreachable`, `service-as-system`, `battery-raw-secret`, `untrusted-upload-root`, … | `packages/cli/core/checks.js` | No. |
| Dependency posture — `bun audit` filtered to what a published package's runtime closure reaches | `scripts/ci.mjs` `advisories()` | No. It grades this framework's packages and never an app's. |
| Dependency check — OSV per installed version, notifies on new advisory (`FJS-2715`) | `packages/basecamp/api/src/core/dependencies.ts`, `dependency-check.job.ts` | No. Basecamp-managed apps only, and it runs after the fact. |
| `fli npm:audit` | `packages/cli/commands/npm/audit.md` | No. It runs `npm audit`, which a bun app with no `package-lock.json` probably cannot answer (unprobed, 0.1). |
| Machine posture — firewall, sshd, updates (`FJS-2712`) | `packages/basecamp/api/src/core/posture.ts` | No. A deploy never reads the target's grade. |

**Not covered anywhere:**

- A credential in a SOURCE file. Only `.env*` files and build lines are graded.
- A vulnerable package inside the built image (OS layer). `server-posture.md` lists Trivy as a later phase.

---

## The proposal

One preflight step, `01c-posture`, that **calls existing owners and grades nothing itself**:

1. `fli check` over the app. An error finding refuses.
2. The dependency comparison, lifted out of `ci.mjs` so CI and deploy share it. An advised package that ships warns (Q2).
3. A credential-shape scan of what reaches the final image, added to `build-check.js`'s context rule (that file already traces what reaches the final image) rather than written beside it.

Image CVEs and the target's machine grade come later (Phase 4).

**When a check cannot run, it says so by name.** An audit with no network is a named skip, as in CI's `FJS_CI_REQUIRE_AUDIT`. A skipped check that prints nothing is worse than no check.

---

## The nine (answered before any edit)

1. **Origin** — none new. The rules stay in `checks.js`, the advisories in one lifted module, and the secret shapes in `build-check.js`.
2. **Concept** — no new noun. *Posture* already exists. *Gate* is avoided because it is the Data realm's word.
3. **Complexity** — the problem's. The one added piece is the lift out of `ci.mjs`, and it removes a duplicate rather than adding one.
4. **Predictability** — `02b` already refuses a deploy on error findings. `01c` behaves the same way.
5. **Derived** — the step derives everything from the existing graders and restates no rule.
6. **Owner** — the owners exist, and two of them overlap. `ci.mjs` (bun audit) and Basecamp `dependencies.ts` (OSV) both answer *is this version vulnerable* (Q5).
7. **Boundary** — a step in the deploy pipeline with the same `$.config.abort` contract as its siblings, tested through `deploy-dispatch`.
8. **Failure** — proportional by kind. A rule error or a baked secret refuses. An advisory warns, for the same reason the Litestream check warns: blocking an operator mid-incident costs more than the risk it reports.
9. **Silence** — *must stay true:* a deploy never ships past a check it did not run. *What fails:* a named skip line, plus a deploy-step test asserting that the skip prints.

**Adjudications:** *Ergonomics vs. strictness* decides 8: strictness per surface, by what a mistake destroys. *Paved road vs. the workaround* decides Q3: a skip flag widens the shoulder, so it needs a written reason.
**Tier:** Assessment. This file proposes and states nothing as behavior.

---

## Plan

### Phase 0 — Measure what is there

Goal: every *probably* above is a measurement.
Done when: each step below has a finding indented under it.

- [ ] 0.1 Run `fli npm:audit` on `example/`. Does `npm audit` answer at all for a bun app?
- [ ] 0.2 Time `fli check` app scope on `example/` and `basecamp/`, which is the latency a deploy would add.
- [ ] 0.3 Sort the app rules with error severity into security and hygiene (input to Q1).
- [ ] 0.4 Diff `ci.mjs` `advisories()` against Basecamp `dependencies.ts`: sources, scope, what each misses (input to Q5).
- [ ] 0.5 Prior art, with sources: what Kamal, Fly, Coolify, Forge, Rails (brakeman / bundler-audit) and GitHub push protection check at deploy or push time, and whether each refuses or warns.

### Phase 1 — One dependency grader

Goal: CI, `fli` and deploy ask one module whether a shipping package is advised against.
Done when: `bun run ci --phase advisories` is unchanged and `fli npm:audit` in `example/` answers through the lifted module.

- [ ] 1.1 Lift `runtimeClosure` and the classification step from `scripts/ci.mjs` into `packages/cli/core/advisories.js`. CI calls it.
- [ ] 1.2 Make `fli npm:audit` a caller of it: bun audit, scoped to the app's runtime closure (rename per the outcome of 0.1).
- [ ] 1.3 Settle Q5. Basecamp calls the same module, or the ruling says why two sources stay.

### Phase 2 — The deploy step

Goal: `fli deploy` runs `01c-posture` before the build.
Done when: a deploy of `example/` with a planted `gate-unreachable` error refuses, and one with a shipping advisory warns and proceeds.

- [ ] 2.1 `01c-posture`: `fli check` app scope (scoped per Q1), refusing on error.
- [ ] 2.2 Advisories through 1.1, with a named skip when there is no network.
- [ ] 2.3 The escape hatch, per Q3.

### Phase 3 — Secrets beyond `.env`

Goal: a credential in a source file that reaches the final image refuses the deploy.
Done when: `build-check.js` tests cover a planted key in `api/src/`, and a negative control shows a key outside the final image passes.

- [ ] 3.1 Credential shapes in the `build-check.js` context walk (per Q4).

### Phase 4 — Image and machine

Goal: a deploy knows the image's CVEs and the target's grade.
Done when: deferred until Phases 1–3 land.

- [ ] 4.1 Trivy on the builder when installed, and a named skip when not.
- [ ] 4.2 Basecamp-managed target: the deploy reads `posture.ts`'s grade and warns on a failing control.

---

## Open questions

- **Q1** — Should every `fli check` error refuse a deploy, or only a security-tagged subset? Refusing on all of them is simpler, but a CSS token error would then block a hotfix.
- **Q2** — Should a critical advisory that ships refuse, or always warn?
- **Q3** — Escape hatch: a config key (precedent: `api.buildCheck: false`), a per-run flag, or none?
- **Q4** — Secret shapes: our own patterns in `build-check.js`, or gitleaks as a dependency?
- **Q5** — `bun audit` (CI) or OSV (Basecamp): which is the one source for *is this version vulnerable*?
