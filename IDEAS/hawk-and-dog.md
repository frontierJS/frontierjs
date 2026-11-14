---
id: hawk-and-dog
status: proposed
dated: 2026-11-14
---

# Idea — the hawk and the dog: two AI agents, one that shapes and one that proves

**Status: PROPOSED.** Dated 2026-11-14. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Written from a survey of prior
art the same day (sources at the end).

The brand's two animal mascots, a hawk and the wolf-like dog, become two AI
agents with split jobs. The dog is in `brand/README.md` beside the figure; the
hawk is the owner's (2026-11-14) and no brand file records it yet. The split
holds whether the agent helps build an FJS app or runs inside one, but **the
reason for the split differs between the two**, and that difference is the main
thing this file records.

**This adds personas, not owners.** The build-time half is `fli done` and the
main-thread-verifies rule in `CLAUDE.md` § Delegation; the app-time half is a
recipe over `agent-surface.md` and `@frontierjs/mcp`'s gate. Neither half needs
a new framework noun.

## The split

| | Hawk — shape and sight | Dog — proof and protection |
|---|---|---|
| Building an app | Writes the schema, the gates and the plan. **The only agent that edits.** | Runs the tests, drives and `fli done`. Reports failures; never fixes them itself. |
| Inside an app | Reads data and explains it: summaries, patterns, "which leads went cold". **Has no tools.** | Acts for the user: fetch, file, send. **Exactly the user's permissions**, through the gate. |
| Its question | What should exist, and what does the data mean? | Does it work, and is it safe? |

**One rule holds in both columns: only the dog runs anything.** At build time
that is a drive; inside an app it is a tool call. The hawk produces text — a
schema, a plan, a summary — and never executes against the running system.
Without that rule the pair inverts between the two uses: the hawk would be the
agent with power while building and the one without it inside an app.

**Not split by realm.** UI, API and deploy all derive from `db/schema.lite`, so a
Data agent and a UI agent would pass the same schema back and forth.

## Why two patterns share one pair

**At build time the pair is maker and checker.** The evidence says a checker helps
only on two conditions:

- **The checker starts cold.** AgentCoder's single agent writing both code and
  tests reached roughly 52% test accuracy against 88% with a separate test
  designer that never saw the code. Cognition reports the same from production:
  review works best "when the coding and review agents do not share any context
  beforehand." So the dog gets the schema diff and the spec, never the hawk's
  reasoning.
- **The checker runs things.** CRITIC found a model's own critiques "contribute
  marginally" and the gains come from tools; Huang et al. found self-correction
  without outside feedback often turns right answers wrong. A dog that only
  *reviews* adds little. Its value is the drive it runs — `VERIFYING.md`'s rule
  turned into a role.

**One writer.** Cognition's revised position keeps edits single-threaded: the
reviewer reports, the builder fixes. Two agents editing the same tree make
conflicting implicit decisions.

**Verification that checks too little is the common failure.** In MAST's 1,642
multi-agent runs, about 23% of failures were verification failures; its example
is a program that compiled and broke the game's rules — Invariant 15 in the wild.
The dog's checks are the existing drives, not a fresh opinion.

**At app time the pair is a privilege split**, the Dual LLM pattern (Willison) as
built by DeepMind's CaMeL: the model that reads untrusted text has no tools, and
the model with tools never reads that text raw. App data carries outsiders' text
— lead notes, inbound email, form fields — and any of it can carry injected
instructions. Hence three rules:

1. **The hawk reads anything and holds no tools.**
2. **The dog takes instructions only from the user it serves**, and receives the
   hawk's findings as structured values, never as free text.
3. **The dog's ceiling is the user's session** (Invariant 6), with `agent-surface.md`'s
   approval hold for a call that should not run unattended.

Without rule 2, a lead's notes field could direct the dog. **Nothing enforces
rule 2 today** — it is an app's discipline until Q3 says otherwise.

## What the personas are not

**A persona prompt does not make an agent more accurate.** Zheng et al. (EMNLP
2024) found personas in system prompts gave no gain on 2,410 factual questions,
and each persona's effect was "largely random." The work is done by what each
agent sees, which tools it holds, and what it may do. The hawk and the dog are
how a person tells the two apart and remembers the rules — branding and
explanation, not a prompt technique.

**Cost is real.** Anthropic's multi-agent research system scored about 90% higher
on its internal eval and used about 15× a chat's tokens. The build-time pair is
worth it where a missed defect costs more than the dog's run.

## Where it would live

- **Build time:** the dog is already `fli done` plus the main thread's drive
  (`CLAUDE.md` § Delegation), done by hand. What is new is running it cold — a
  fresh agent given the diff and the spec, not the session (Q2).
- **App time:** the dog is a caller of `@frontierjs/mcp`, whose gate is already the
  permission model. The hawk is a read-only consumer with no tool list. Neither
  exists as a product noun yet.

## Open questions

- **Q1** — Is the app-time pair a framework feature or a recipe?
  **A** — a recipe section in `agent-surface.md`, built on the existing gate and
  hold. **B** — a framework seam: a typed handoff that carries the hawk's
  findings into the dog's tool call as values. **Recommend A** — B is a second
  owner beside `@frontierjs/mcp` (Invariant 4) before one app has needed it;
  revisit when the first app hits an injected instruction.
- **Q2** — Build time: what is the dog?
  **A** — a cold mode of `fli done` that a fresh agent runs against the diff and
  spec. **B** — a standing `.claude/agents/` definition. **Recommend A** — the
  evidence values the cold context and the drives, both of which `fli done`
  already owns; an agent definition adds a noun for neither.
- **Q3** — Does rule 2 get enforcement? Waits on Q1: under A, **no** — it is
  documented; under B, the typed handoff is the enforcement.
- **Q4** — Names. **A** — Theo (theodolite) and Gunter (Gunter's chain), both
  surveying instruments. **B** — Meridian and Plumb. **C** — Vesper and Ember.
  **Recommend A** — personal names keep the mascots from reading as package
  nouns, and `FJS-D29` gives AI personified nouns.

## Sources

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — the evaluator-optimizer pattern (Dec 2024)
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — 90% gain, ~15× tokens (Jun 2025)
- Huang et al., [AgentCoder](https://arxiv.org/abs/2312.13010) — separate test designer, § RQ6
- Cognition, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) (Jun 2025) and [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) (Apr 2026)
- Gou et al., [CRITIC](https://arxiv.org/abs/2305.11738) — tool feedback, not self-critique (ICLR 2024)
- Huang et al., [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) (ICLR 2024)
- Cemri et al., [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) — MAST (NeurIPS 2025)
- Panickssery et al., [LLM Evaluators Recognize and Favor Their Own Generations](https://proceedings.neurips.cc/paper_files/paper/2024/file/7f1f0218e45f5414c79c0679633e47bc-Paper-Conference.pdf) (NeurIPS 2024); disputed by [arXiv 2608.18091](https://arxiv.org/abs/2608.18091)
- Willison, [The Dual LLM pattern](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) (Apr 2023); Debenedetti et al., [CaMeL](https://arxiv.org/abs/2503.18813) (Mar 2025)
- Zheng et al., [personas in system prompts](https://arxiv.org/abs/2311.10054) (EMNLP 2024)
