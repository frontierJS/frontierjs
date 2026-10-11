---
id: charter
status: proposed
dated: 2026-10-10
---

# Idea — Charter: the plan an app is built from, approved before it is built

**Status: IDEA. A prototype runs in the Charter stressor; nothing here is in the
framework.** Dated 2026-10-10. Do not cite this file as describing behavior — see
`VERIFYING.md`.

**Vocabulary:** *Charter* is the name, chosen 2026-10-10. It is not yet in
`VOCABULARY.md`. The prototype was first called *Blueprint* and was renamed
everywhere (Charter's model, service, files and `charter.json`) for two reasons:

- **Basecamp's `Blueprint` is already a model:** the catalog of one-click
  third-party apps (`DECISIONS.md` cites it under tenancy). **Blueprint stays
  basecamp's.** The two never share a word again: a *charter* is what to
  **build**, before any code exists; a *blueprint* is what to **run**, a
  prebuilt image and its parameters.
- **Bubble and Firebase Studio both call their pre-build plan a blueprint**, so
  that word did not set the product apart.

*Charter* fits because a charter sets out the rules and the intent, and who
belongs and what they may do is most of one. **Set aside:** Schematic, Foundation,
Roughcut and Atlas. Atlas may still fit later, as the name for a charter that
covers a live app and its rigs as well as the first build. *Homestead* is taken
(the offline work, `FJS-D297`), and `app.claim` rules out *claim*.

---

## What it is

**A person says what they want; Charter turns that into a plan they can read,
change and approve; only then is anything built.** The plan holds:

- **the shape:** a SaaS product (many organizations), one person's tool, or one
  team sharing one set of records;
- **who gets in from outside:** customers through a portal, the public through
  a booking page, a share link, a form embedded on another website, client
  companies;
- **what is bought rather than built:** billing, sign-in, the add-ons (audit,
  notifications, webhooks, flags, uploads) and the vendors (Stripe, Resend,
  Telnyx, S3, Cloudflare), each with its true status;
- **the models and their access:** Oracle's graded answer, with each entity's
  *why*, *cost* and *escape*;
- **what is left for later:** the custom pieces, as to-dos that become rigs.

**Why it belongs to this framework and not to every builder:** the other tools
show a plan written by the model and then build whatever the model writes next.
Here, the plan is **Oracle's answer**. `checkAnswer` grades it, `emit` turns it
into `db/schema.lite` without a model, and the schema is the app's one origin
(`FJS-D632`). The plan the person approves is the plan that is built. No other
builder can say that, because none of them has a schema that the rest of the app
is derived from.

## What exists today

The Charter stressor carries a working prototype (uncommitted, 2026-10-10):

- **`/new/`, a nine-step wizard:** Shape → Who gets in → Billing (SaaS only) →
  Sign-in → Add-ons → Vendors → Your domain → Custom pieces → Review. Every step
  has a recommended answer, so clicking Next all the way through builds an app.
  Each sign-in, add-on and vendor shows its real status (built, in the starter,
  ready, planned, not built).
- **A `Charter` model** in Charter's schema. `charters.build` writes the app,
  its brief and the first build turn in one transaction.
- **The brief** (`charter/builder/charter.ts`) wraps the person's sentence. It
  says who owns which records and who outside the staff gets in. It lists what
  not to model (billing, sign-in, add-ons, vendors) and what will be built later
  (the custom pieces).
- **A Plan tab** on the generated app: the custom pieces as to-dos, and the
  brief the app was built from.
- **Two starters** the shape picks between: `fjs-prototypes/saas-starter` and
  `fjs-prototypes/personal-starter` (just me, or a few people sharing). The
  starter is recorded, not installed: installing it needs Oracle to read a
  host's schema (Charter `RIGS.md` R2).

**First measured run:** a lawn-care scheduling tool settled in 2 turns, for
$0.33 and about 90 seconds. The brief held: the model modelled `Company` and
`Membership` as the tenancy, gave customers portal access to their own records,
and wrote no payment tables. The first answer was refused with *"Nobody creates
a Company."* The answer that passed marked the company `system`, and nothing in
the generated app is that system, so nobody can get in → **`FJS-2530`**.

## Prior art

| Product | What it does before building | What to take |
| --- | --- | --- |
| **Bubble** | A blueprint of feature cards you confirm, remove or add to, plus a **Scenarios** view that restates the plan from each user type's side. Privacy rules come out of generation, with a warning that they are a starting point | The scenarios view, and the warning: AI-written access needs a check |
| **Firebase Studio** | A blueprint of app name, features, style guidelines and stack. You edit it or click *Prototype this app*. Firebase calls it an agreement between you and the code | The plan as an agreement |
| **Replit Agent** | Plan mode breaks the request into ordered tasks before any code. *Start with a design* builds a clickable front end first, then *Build functionality* | Ordered tasks; a cheap preview before the expensive build |
| **Lovable** | Chat mode decides *what*, Plan mode decides *how*, Build mode changes code. A questions tool asks about audience, features and design when a request is unclear | Questions asked before the build, not discovered after it |
| **Base44** | A Plan toggle under the first prompt: the AI asks who it is for, what it does and what it includes. Planning is free and the build costs credits | Free planning, paid building |
| **v0 · HighLevel** | v0 asks clarifying questions before generating. HighLevel's clarifying agent asks **at most three** | A cap on the questions |
| **Bolt** | *Enhance prompt* rewrites the request. Its own guides warn that it drops details | What to avoid: a rewrite the person must re-check |
| **Wasp Mage** | One planning call drafts entities, operations and pages as JSON, then cheaper calls write the code, then a repair loop | The plan as structured data a cheaper step builds from. Mage's plan was not graded; ours is |
| **Spring Initializr** | Every choice is in a bookmarkable URL, and *Explore* shows the build file before you download it | A charter as a link, and a preview of what it writes |
| **Better-T-Stack** | A web builder at `/new` that produces a CLI command you can copy. The CLI keeps the setup in `bts.jsonc` | A charter as a file the CLI replays |
| **Clerk** | With personal accounts off, a *choose organization* step after sign-up makes every user create or join an organization before they get in | The onboarding `FJS-2530` is missing |

## The features, ranked

### Tier 1: the plan is the product

1. **Show the plan, then build.** Run Oracle first and show the graded answer:
   the models, each with its why/cost/escape, and who reads and writes each.
   The person edits it; Build runs `emit` and then the build turn. Answering is
   cheap and `emit` is free, so the expensive turn moves to after approval.
2. **Scenarios for each role, which are also the access tests.** Restate the
   emitted policies from each role's side: *a customer sees their own jobs and
   no one else's; a crew member cannot delete a customer*. Each sentence is a
   case for the generated access test (`verifyGateLadder`), so the person
   approves the tests in their own words. This tests whether Oracle's output can
   be read back to the person who asked for it.
3. **At most three questions, taken from Oracle's own refusals.** The steps are
   the same for every app; these questions come from the sentence. The best
   source is a refusal asked ahead of time: *"Who creates a Company: the person
   signing up, or you?"*, instead of a build turn spent on *"Nobody creates a
   Company."*
4. **"How do people first get in?"** Signup creates their organization, invite
   only, or an admin creates accounts. This is the gap `FJS-2530` names, and it
   is the onboarding half of the teams rig (`overview.md` 3.8). The wizard step
   is easy; Oracle being able to say it is the work.

### Tier 2: the first open feels real

5. **Sample data in the app's own domain**, so the first open is not an empty
   table. Litestone's factories already exist.
6. **View as each role** on the first preview: owner, member, customer,
   anonymous visitor. The person sees what each one sees, which is the check
   Bubble's warning asks for.
7. **Starting charters from the Charter corpus.** The 21 apps Charter drives (an
   applicant tracker like JazzHR, a photo library like Immich, …) as presets.
   For the person they are a quick start; for the instrument, runs start from a
   known charter and can be compared.
8. **The cost and time before Build**, from measured runs by shape.

### Tier 3: a charter outlives the first build

9. **A charter as a file and a link.** `charter.json`, replayed by
   something like `fli new --charter charter.json` (not built), and a URL
   that holds every choice. For the instrument this is the largest gain: the
   same charter runs through the Oracle route and the freehand route.
10. **Vendor keys that are checked**: collect the key, test it (Stripe test
    mode, Resend domain verification) and write the `attachments` entry
    `FJS-D824` rules for.
11. **To-dos that build themselves.** A custom piece on the Plan tab gets a
    *Build this* button that installs it as a rig. This needs the installer
    (`overview.md` 3.2) and Oracle answering against a host (Charter `RIGS.md`).
12. **Re-run a charter on a live app.** Turn on two-factor or webhooks
    after launch: Charter shows what would change and writes the migration.
    This needs the same host-aware Oracle.
13. **A go-live checklist** as the last screen: DNS, email domain, Stripe live
    mode, backups, through `fli deploy:doctor`. This would be the first reader of
    *Checklist*, the term `FJS-D693` reserves.

**Left out on purpose:** a step that rewrites the person's prompt. Bolt's own
guides warn that it drops details, and the charter is already the structured
version of the sentence. **Low priority:** a style step for a brand color and a
logo that sets only CSS tokens; Firebase's blueprint takes a color scheme from
an image.

## Why it might be a product

**The other builders compete on how fast the first screen appears. Charter
competes on whether the approved plan is the app that ships.** Three things
only this framework has make that claim checkable:

- **The plan is graded.** `checkAnswer` refuses a plan nobody can enter, or one
  where a delegation admits everybody, before a model writes code.
- **The plan stays the app's origin.** The schema it emits is what the API, the
  forms, the migrations and the access tests are derived from, so the plan
  cannot drift from the app.
- **What is bought is honest.** Each sign-in, add-on and vendor shows whether
  the framework does it today, so the plan never promises what the build will
  fake.

**What it is not:** a hosted builder competing with Lovable or Base44 on
breadth. Its natural first buyer is whoever starts FJS apps for clients: an
agency, or this repo's own conversions. There, a charter is the discovery
document and the build in one.

## What it needs from the framework

| Need | Where it stands |
| --- | --- |
| Oracle saying *the person signing up creates the organization and becomes its first member* | `FJS-2530`, open |
| A scaffold that passes its own check | `FJS-2531`, open |
| Oracle answering against an existing schema (a starter, then a live app) | Charter `RIGS.md` R2, unbuilt |
| The rig installer | `overview.md` 3.2, idea |
| The teams rig: organizations, memberships, invitations | `overview.md` 3.8, idea |
| A charter file `fli new` replays | Not started |

## Open questions

- **Is a charter a framework artifact or an app's?** If `fli new` replays it, the
  format is the framework's, and so is the name.
- **Is the charter the Oracle answer, or a wrapper around one?** The shape, the
  vendors and the custom pieces are not entities. Either the answer grows to
  hold them, or the charter holds the answer next to them.
- **Where does it run?** Inside Charter it is an instrument. As a product it is a
  page that calls a model, and `FJS-D601` keeps the model out of Oracle, so the
  caller is the product.

## Sources

- Bubble: https://manual.bubble.io/help-guides/ai/bubble-ai-agent/generate-apps-with-ai
- Firebase Studio: https://firebase.google.com/docs/studio/get-started-ai ·
  https://firebase.blog/posts/2025/07/studio-tips-tricks-2
- Replit Agent: https://docs.replit.com/replitai/agent
- Lovable: https://docs.lovable.dev/features/chat-mode ·
  https://lovable.dev/de/blog/chat-mode-and-questions
- Base44: https://docs.base44.com/Getting-Started
- v0: https://www.createwith.com/tool/v0/updates/v0-adds-clarifying-questions-before-generating-web-apps
- HighLevel: https://ideas.gohighlevel.com/changelog/clarifying-agent-in-ai-builder
- Bolt: https://support.bolt.new/docs/prompting-effectively ·
  https://www.bensbites.com/p/get-started-with-bolt-a-beginners-guide
- Wasp Mage: https://wasp.sh/blog/2023/07/17/how-we-built-gpt-web-app-generator
- Spring Initializr: https://docs.spring.io/initializr/docs/0.9.0/reference/html
- Better-T-Stack: https://www.better-t-stack.dev/docs
- Clerk: https://clerk.com/docs/components/authentication/task-choose-organization
