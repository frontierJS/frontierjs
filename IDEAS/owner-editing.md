---
id: owner-editing
status: proposed
dated: 2026-10-17
---

# Idea — owner editing: a site's owner changes their own words

**Status: PROPOSED. 1.1–1.5, 2.1–2.5, 3.1, 3.2, 4.1 and 4.2 are built. Q1–Q27 are ruled (`FJS-D1225`–`FJS-D1231`, `FJS-D1242`, `FJS-D1246`–`FJS-D1252`, `FJS-D1339`, `FJS-D1357`, `FJS-D1358`, `FJS-D1399`, `FJS-D1403`–`FJS-D1408`, `FJS-D1424`, `FJS-D1425`).** Do not cite this file as describing
behavior — see `VERIFYING.md`.

A site's owner (a Kobami client, or whoever runs frontierjs.com) opens their
site, changes a sentence, a photo or a review, looks at the result, and
publishes. They never see git, a build or Cloudflare. This is
`site-hosting.md` step 6 and `on-page-editing.md` § *Not in this file*:
Framer's and Webflow Editor's case, with the layout locked and a publish step.

**Already ruled, so not reopened here:**

- **The site stays static** (`site-hosting.md` § Preview and editing). Git
  (`content/`) is where content lives. The editor writes to it, publishing is a
  commit, and the build ships through the adapter. Nothing editable runs at the
  edge.
- **It is a module of `packages/basecamp`** (`FJS-D921`), which already holds
  the Cloudflare account, the DNS writes, the release record and an App whose
  `source` can be `{ kind: 'git', repo, branch, path }`
  (`api/src/domain/release/app-source.ts`).
- **A preview build stamps `data-fjs-loc`** (`FJS-D838`), and a preview deploy
  is a Version URL on the site's own Worker, named by its git branch
  (`FJS-D1221`, `FJS-D1222`).

## What the tree already gives

| Piece | Where | What owner editing gets from it |
| --- | --- | --- |
| Stamps on prose name the `.md` line | `mesa/src/compiler-md.js` `stampLoc` (`FJS-1711`) | a click on a paragraph resolves to `content/routes/x.md:12:1`, not to a template line |
| `compileMd` has no Node dependency | `mesa/src/compiler-md.js` | a changed markdown route can compile in the page before anything builds (0.2 measured it) |
| A preview per branch | `site-kit deploy --preview` (`site-hosting.md` step 5) | each draft gets its own review link, with no extra work |
| A deploy that ships the last build | `site-kit deploy` (step 4) | Publish ships the build it checked |
| Real git in basecamp | `api/src/domain/local/local-git.ts`, the `git` App source | basecamp already runs git and parses its output |
| The look is six keys, each one an `@frontierjs/css` word | site-kit README (`tone`, `treatment`, `template`, `density`, `align`, `background`) | which front-matter keys are design and which are content is already a fixed list |

**One gap matters.** A front-matter value (a block's `title:`, a review's
`author:`) reaches the page through a `.mesa` block. Its stamp therefore names
a line in the block's template, not the field. Netlify's Visual Editor hits the
same problem, because it reads the generated HTML and not the components
([annotations](https://docs.netlify.com/manage/visual-editor/visual-editing/inline-editor/)).
Phase 0 measures how much of a real client site is affected.

## Prior art

| Tool | How it works | The lesson |
| --- | --- | --- |
| **Decap CMS** | A form editor. Its editorial workflow makes a branch per entry (`cms/<collection>/<slug>`) and opens a PR. Each save is a commit on that PR, and Publish merges the PR and deletes the branch ([editorial workflows](https://decapcms.org/docs/editorial-workflows/)) | a draft maps to a branch, and publishing maps to a merge |
| **TinaCMS** | Click an element on the page and edit it in a sidebar while the page updates. Content is Markdown/JSON in the repo, and branch previews are linked from the editor ([Smashing case study](https://www.smashingmagazine.com/2023/09/smashing-magazine-tinacms-manage-editorial-workflow)) | the site has to be instrumented (`useTina`), and the hosted backend is a SaaS dependency |
| **CloudCannon** | Editable regions are declared with a `data-editable` attribute on an element, in five kinds: text, image, source, array, component. Edits commit back to the repo ([editable regions](https://cloudcannon.com/documentation/articles/what-are-editable-regions/)). Large changes go on a branch and are merged later ([blog](https://cloudcannon.com/blog/looking-for-a-forestry-alternative/)) | the five kinds cover a marketing site's needs |
| **Netlify Visual Editor** | `data-sb-object-id` names the document and `data-sb-field-path` names the field. The editor reads the rendered HTML and syncs both ways with a Git content source ([Git source](https://docs.netlify.com/manage/visual-editor/content-sources/git/)) | an attribute naming a field is what lets a click land on that field |
| **Sanity Presentation** | Stega hides source-map data in strings as invisible characters, and overlays use observers to draw a box over each match ([stega](https://www.sanity.io/docs/stega), [overlays](https://www.sanity.io/docs/loaders-and-overlays)) | stega only works on strings and breaks string comparison. An attribute avoids both problems |
| **Keystatic, Pages CMS** | A form editor over a GitHub repo, with its config in a file in the repo (`.pages.yml`), invited editors, and changes made through a GitHub App or PR ([Pages CMS](https://pagescms.org/docs/)) | this is the plain form-based floor, and it only works with GitHub |
| **Webflow Editor** | Layout, section order, spacing and type styles are off limits to a content editor ([agency guide](https://www.lowcode.agency/blog/how-to-update-your-webflow-site)). A full publish by the editor **also ships the designer's staged work** ([forum](https://discourse.webflow.com/t/editor-pushed-all-design-changes-in-staging-live/167182)) | lock the layout, and never ship work the owner didn't make without saying so |
| **Framer On-Page Editing** | Edit on the published site itself. The Edit button appears only for collaborators with the Content permission. Edits are drafts, and *Finish Editing* either publishes or hands off to someone who can ([help](https://www.framer.com/help/articles/on-page-editing/)) | editing and publishing are separate permissions |

**The best practices, in short:** the layout is locked. What can be edited is
derived, not hand-marked. A click lands on a field. A draft is isolated and has
its own preview. Publishing is a separate permission and ships only what the
owner saw. History is the undo. When a conflict comes up, the owner hands it to
a developer instead of resolving it.

## The shape

**Open → draft branch → edits commit → preview → Publish merges → production
build → deploy.** An owner opens their draft's preview link and presses Edit
(`FJS-D1225`). The editor is part of the preview build, so production never
has it. Signing in to basecamp gives the page a session. A click on prose
outlines the element and opens its source as a field. Each save goes to
basecamp's API, which checks the grant and commits to the draft's branch
(`FJS-D1227`, `FJS-D1228`). The draft's preview is step 5's `deploy
--preview` aliased by that branch, so the link to share comes for free. A
save rebuilds that preview. Publish merges the branch, builds without
`--preview` and deploys. Basecamp records the merge commit as the release.
Basecamp itself lists drafts and history and holds the grants.

## Open questions

- ~~**Q1 — Where the editor runs.**~~ **Answered 2026-10-17 (`FJS-D1225`): B — an Edit button on the preview site itself, against the recommendation. The preview origin carries a session that can write, and every write is checked against the grant (`FJS-D1230`).**
  - **A** — a basecamp page that frames the preview. The preview build carries
    a small bridge, only under `preview: true`, that outlines stamped elements
    and posts the `loc` of a click to the parent. This is the pattern of Sanity
    Presentation, Tina, CloudCannon and Netlify.
  - **B** — an Edit button on the preview site itself, as Framer does.
  - **C** — forms only, with no page, as Decap, Keystatic and Pages CMS do.
  - **Recommend A** — auth and writes stay on basecamp's origin, which was
    `FJS-D921`'s reason. The preview origin only posts a location. B puts a
    write credential on a `workers.dev` origin, and that origin is a link meant
    to be handed to reviewers. C is Phase 1 anyway. The question is what the
    end state is.
- ~~**Q2 — What an owner may change.**~~ **Answered 2026-10-17 (`FJS-D1226`): A.**
  - **A** — the markdown under `content/`: prose, and every front-matter key
    except `layout`, `name` and the six look keys. Collection items, menus and
    images are included. `.mesa`, `.js` and `settings/site.js` are developer
    files, refused by path.
  - **B** — everything in a `.md` file, look keys included.
  - **C** — only what a block marks editable with an attribute, as
    CloudCannon's `data-editable` does.
  - **Recommend A** — Webflow and Framer both lock the layout, because a layout
    mistake is the one a developer ends up repairing. A is derived from the path
    and a key list site-kit already fixes. C is a second, hand-written
    statement of what the content already says, and it goes stale the first
    time a block gains a field.
- ~~**Q3 — What a draft is in git.**~~ **Answered 2026-10-17 (`FJS-D1227`): A.**
  - **A** — a branch per draft, previewed at its alias. Publish merges it.
  - **B** — every save commits straight to the default branch, and publishing
    means deploying. This is Pages CMS's default.
  - **C** — one long-lived `content` branch per site.
  - **Recommend A** — `FJS-D1222` already names a preview by its branch, so a
    draft gets its review link without new code. An abandoned draft is just an
    unmerged branch. Decap and Keystatic both work this way. B puts unreviewed
    edits on the branch developers build from. C drifts away from the default
    branch.
- ~~**Q4 — Who writes to git.**~~ **Answered 2026-10-17 (`FJS-D1228`): A.**
  - **A** — a checkout that basecamp holds, using the git CLI and a deploy key
    per repository.
  - **B** — GitHub's contents API through a GitHub App, as Decap, Pages CMS,
    Keystatic and Tina Cloud do.
  - **Recommend A** — Publish has to build, and a build needs a checkout
    anyway. Git works with any host (GitLab, Forgejo), which is the thesis of
    this file's parent. Basecamp already runs real git. B ties editing to
    GitHub and still needs a second path for the build.
- ~~**Q5 — What Publish ships when the default branch has commits that were never
  deployed.**~~ **Answered 2026-10-17 (`FJS-D1229`): C.**
  - **A** — merge and ship everything, listing the other commits by author on
    the confirm screen.
  - **B** — ship the draft on top of the last deployed commit, and merge it
    into the default branch separately.
  - **C** — refuse, naming the undeployed commits and their authors. Basecamp
    notifies the developer.
  - **Recommend C** — this is exactly Webflow's hazard: an owner can't judge a
    developer's commit, and A asks them to. B deploys a commit that exists on
    no branch. C costs a wait only in the rare case that a developer pushed and
    didn't deploy, and the refusal says who to ask.
- ~~**Q6 — Who may edit and who may publish.**~~ **Answered 2026-10-17 (`FJS-D1230`): A.**
  - **A** — a grant row per (user, App) with two levels, `edit` and
    `publish`, gated in the schema.
  - **B** — a role on `WorkspaceMember`, applying to every site in the
    workspace.
  - **Recommend A** — a Kobami client edits one site, and workspace membership
    would show them the whole fleet. Framer keeps content editing and
    publishing as separate permissions too. The gate is in the schema
    (Invariant 6).
- ~~**Q7 — How a value rendered through a template lands on its field (2.4).**~~ **Answered 2026-10-17 (`FJS-D1231`): A.**
  0.1 measured 35–63% of on-page text going through about 20 shared template
  lines.
  - **A** — provenance at the read. In a preview build, site-kit's loader
    records each loaded value's content line (YAML gives each key's position).
    Mesa's preview codegen then stamps an element whose interpolation reads a
    field off a recorded object (`{item.name}`, `{settings.company_email}`)
    with that content line as its `data-fjs-loc`, in place of the template
    line. There is no new attribute. A prop passed in whole, or a derived
    value, keeps the template stamp and falls back to C.
  - **B** — text match at click time. The editor matches the clicked text
    against the page's values. 0.1 measured 53–66% of front-matter values
    sharing their text with another value.
  - **C** — no field landing. A template stamp opens Phase 1's form for the
    kind of file that template renders (a menu, a collection, settings), and
    the owner picks the entry.
  - **Recommend A, with C for what A cannot name.** The best practice is that
    a click lands on a field, and A is the derived way to get there. Sanity's
    stega does the same thing inside strings, and A avoids stega's failure by
    using the attribute that already exists. B is wrong about half the time
    and can't say so. C is the floor, and it is built anyway.
- ~~**Q8 — Whether an owner can ask a model to change their words, and how far it reaches.**~~ **Answered 2026-10-18 (`FJS-D1242`): B — an agent over the draft. A Claude run with file tools on basecamp's checkout of the draft branch, limited to Q2's editable set, for a change across several fields or pages ("update the hours everywhere", "add an FAQ entry"). Its diff is graded against Q2's set after the run and refused whole if it touches a developer file or a look key. The owner sees the diff before it commits.** The ask panel (`on-page-editing.md`) runs `claude -p` with
  Edit on a developer's disk. An owner has no `claude` and no disk, so any
  model call here is basecamp calling the Claude API on the owner's behalf,
  billed to whoever runs basecamp. Precedent: Webflow's Editor regenerates a
  selected text element or CMS field from page and CMS context and offers three
  variations to pick from ([Webflow AI](https://help.webflow.com/hc/en-us/articles/38323375464723),
  [announcement](https://webflow.com/updates/ai-assistant-content-generation)).
  Sanity's AI Assist runs instructions against a document's fields with the
  invoking user's permissions ([AI Assist](https://www.sanity.io/docs/ai-assist-working-with-instructions)).
  Framer has a Text Rewrite feature, and its agent edits page copy on the
  canvas, with each edit reviewed before publish
  ([Framer AI](https://framer.com/ai), [AI designer](https://framer.com/solutions/ai-designer/)).
  - **A** — rewrite one field. The owner clicks an element as in 2.2 and asks
    for a change ("shorter", "friendlier", or their own words). Basecamp sends
    the field's text and the page's text to the Messages API with no tools, and
    returns variations. The pick is saved as a typed edit would be: the same
    grant, the same `locateText` swap or front-matter write, and the same
    commit on the draft. The model never sees a path, and what it returns
    cannot be anything but text for one field.
  - **B** — an agent over the draft. A Claude run with file tools on
    basecamp's checkout of the draft branch, limited to Q2's editable set, for
    a change across several fields or pages ("update the hours everywhere",
    "add an FAQ entry"). Its diff is graded against Q2's set after the run and
    refused whole if it touches a developer file or a look key. The owner sees
    the diff before it commits.
  - **C** — none. Model edits stay with the developer and the ask panel. An
    owner types every change.
  - **Recommend A, with B as a later question once A is used.** In A the write
    path is the one a typed edit already takes, so the grant (`FJS-D1230`) and
    Q2's refusal by path are not restated for the model. B needs a second
    enforcement of Q2 (a diff grader), and the cases it serves ("everywhere")
    are also what produces a change an owner can't review in one look. C
    leaves the owners without what Webflow, Framer and Sanity give theirs.
    Either A or B needs an API key and a spend limit per site in basecamp,
    which is part of the ruling.
- ~~**Q9 — Whether a save pushes the draft (1.2).**~~ **Answered 2026-10-18 (`FJS-D1246`): A — every save is a commit pushed to `draft/<name>` on the remote, as each Decap save is a commit on its PR. Basecamp's clone is a cache, and the push is the lock: a rejected fast-forward means someone saved first.**
  - **A** — every save is a commit pushed to `draft/<name>` on the remote, as
    each Decap save is a commit on its PR. Basecamp's clone is a cache, and the
    push is the lock: a rejected fast-forward means someone saved first.
  - **B** — commits stay in basecamp's clone until Publish pushes them.
  - **Recommend A** — a draft survives basecamp losing its disk, and a
    developer sees it as a branch. B makes the clone hold the only copy.
- ~~**Q10 — Where the deploy key per repository (`FJS-D1228`) lives (1.2).**~~ **Answered 2026-10-18 (`FJS-D1247`): B — deferred: 1.2 clones and pushes with the credential the host's git already holds, and the key is its own step.**
  - **A** — the git source gains `key: 'secret:<id>'`, an `ssh_key` Secret in
    the App's workspace, resolved by `core/credentials.ts`.
  - **B** — deferred: 1.2 clones and pushes with the credential the host's git
    already holds, and the key is its own step.
  - **Recommend A** — the ref form and the resolver exist, so it is no new
    noun. B leaves `FJS-D1228` unmet for now.
- ~~**Q11 — What a draft is named, and who opens one (1.2).**~~ **Answered 2026-10-18 (`FJS-D1248`): A — an editor opens a draft by name, `draft/<slug>`; a site has several, and every editor of the site sees and saves to all of them.**
  - **A** — an editor opens a draft by name, `draft/<slug>`; a site has
    several, and every editor of the site sees and saves to all of them.
  - **B** — `draft/<user>`, opened by an editor's first save, one per person.
  - **Recommend A** — two changes can run side by side, and the preview alias
    is the name the owner gave it.
- ~~**Q12 — How the form writes front matter (1.2).**~~ **Answered 2026-10-18 (`FJS-D1249`): A — a field per top-level text, number or yes/no key, written back by replacing that key's line, so comments and formatting survive; lists show read-only until Phase 3.**
  - **A** — a field per top-level text, number or yes/no key, written back by
    replacing that key's line, so comments and formatting survive; lists show
    read-only until Phase 3.
  - **B** — the front-matter block as YAML text, graded by parsing before and
    after.
  - **Recommend A** — an owner edits a value, never YAML, and the writer sits
    beside site-kit's rule.
- ~~**Q13 — What code an owner's body may carry (1.3, `FJS-3283`).**~~ **Answered 2026-10-18 (`FJS-D1250`): A — the body's code is the developer's: the leading `<script>`, every `{…}` and every tag with its attributes in the new body must already be in the old one, and a link may not use the `javascript:` scheme. An owner edits text and may delete; adding code or markup is refused by name.** Today
  `applyEdit` passes a body with a leading `<script>` or a `{…}` expression,
  and `compileMd` runs both wherever the draft is built. Mintlify's MDX
  (CVE-2025-67843) and next-mdx-remote (CVE-2026-0969, now `blockJS` by
  default) were this hole.
  - **A** — the body's code is the developer's: the leading `<script>`, every
    `{…}` and every tag with its attributes in the new body must already be in
    the old one, and a link may not use the `javascript:` scheme. An owner
    edits text and may delete; adding code or markup is refused by name.
  - **B** — plain markdown only: a file whose body holds any script,
    expression or tag is not editable in the form at all.
  - **C** — leave the body open and rely on where the build runs (Q14).
  - **Recommend A** — `FJS-D1226` already makes code the developer's, so this
    closes a hole in that ruling rather than adding one. B shuts out Luminous
    Heart's 186 raw-HTML lines. C still ships the script to every visitor of
    the preview, which holds a write session (`FJS-D1225`), and of production.
- ~~**Q14 — Where a draft's preview builds (1.3).**~~ **Answered 2026-10-18 (`FJS-D1251`): A — on a fleet machine through Outpost, in a throwaway container, as a `git` App already is (`outpost/src/server.js` `POST /build`): basecamp sends the commit, the machine clones, installs, builds and uploads.** A build runs the repository's
  own code: `bun install`'s scripts, `site.js`, the preset and every `.mesa`.
  - **A** — on a fleet machine through Outpost, in a throwaway container,
    as a `git` App already is (`outpost/src/server.js` `POST /build`):
    basecamp sends the commit, the machine clones, installs, builds and
    uploads.
  - **B** — on basecamp's host: a worktree from the bare clone, `bun install`
    and `site-kit build --preview` as a child process with a scrubbed
    environment.
  - **C** — the repository's own CI builds it, as Decap reads a host's
    commit status for its preview link ([Decap](https://decapcms.org/docs/deploy-preview-links/));
    basecamp only reads the status.
  - **Recommend A** — the tree's precedent is that basecamp never builds a
    repository; the machine does. B runs a site's dependencies on the box
    holding `ENCRYPTION_KEY` (`FJS-2714`), where a scrubbed env does not hide
    the parent's `/proc/<pid>/environ` from the same user. CloudCannon builds
    in its own isolated container too
    ([CloudCannon](https://cloudcannon.com/documentation/articles/what-is-a-site-build/)).
    C contradicts `FJS-D1228` and needs a CI per host.
- ~~**Q15 — Which credential uploads the preview (1.3).**~~ **Answered 2026-10-18 (`FJS-D1252`): A — the workspace's Cloudflare edge account (the `provider_key` Secret `services/edge/` already reads), handed to wrangler as `CLOUDFLARE_API_TOKEN` for the one run. The token then needs Workers Scripts edit beside DNS.**
  - **A** — the workspace's Cloudflare edge account (the `provider_key`
    Secret `services/edge/` already reads), handed to wrangler as
    `CLOUDFLARE_API_TOKEN` for the one run. The token then needs Workers
    Scripts edit beside DNS.
  - **B** — deferred like `FJS-D1247`: whatever wrangler login the building
    host holds, with the account as its own step.
  - **Recommend A** — basecamp already holds the Cloudflare account
    (`FJS-D921`), so it is no new noun; B is 0.3's expired login again.
- ~~**Q16 — What a site's first publish does, with no release recorded to compare against (1.4).**~~ **Answered 2026-10-20 (`FJS-D1339`): A — refuse by name ("no release of this site is recorded"), and give a static `git` App a real Deploy: `deployments.create` sends the same Outpost build-and-deploy a publish does, recording the commit.** Q5 refuses undeployed commits, and "undeployed" is measured
  from the last successful `Deployment`'s commit. A static `git` App has no
  release path today: `buildInitialSteps` gives it *Pull image*, which pulls
  nothing, so no site has a recorded commit.
  - **A** — refuse by name ("no release of this site is recorded"), and give a
    static `git` App a real Deploy: `deployments.create` sends the same
    Outpost build-and-deploy a publish does, recording the commit.
  - **B** — the first publish ships the default branch plus the draft and
    becomes the baseline; Q5 applies from the second publish on.
  - **C** — refuse by name and leave the developer's Deploy for later.
  - **Recommend A** — B ships a developer's unreviewed commits once, which is
    Q5's hazard on the day it matters most. C leaves Publish unable to
    succeed anywhere. A also mends the broken step list.
- ~~**Q17 — How a preview's Edit button gets a credential for basecamp (2.1).**~~ **Answered 2026-10-20 (`FJS-D1357`): A — a one-time code with PKCE, the OAuth pattern for browser apps. Edit sends the browser to basecamp's `/sites/<id>/edit/`, carrying the preview's address and a PKCE challenge. Basecamp signs the person in there if needed, checks the `AppEditor` grant, and redirects back with a code that works once, for a minute. The preview posts the code and its verifier and gets an API key that reaches only `drafts`. The key is held in the tab's `sessionStorage` and expires within hours.**
  The preview is `<draft>-<worker>.<sub>.workers.dev` and basecamp is another
  site, so basecamp's session cookie is a third-party cookie there. Safari and
  Firefox block those by default. Auth's own OAuth note says the
  short-lived-code exchange that would carry a session across a redirect
  "is not built" (`packages/auth/plugin.ts`). Framer shows the button to
  everyone on a staging link and lets only permitted users edit
  ([Framer](https://www.framer.com/help/articles/editor-bar/)), which
  `FJS-D1225` already took.
  - **A** — a one-time code with PKCE, the OAuth pattern for browser apps.
    Edit sends the browser to basecamp's `/sites/<id>/edit/`, carrying the preview's
    address and a PKCE challenge. Basecamp signs the person in there if needed,
    checks the `AppEditor` grant, and redirects back with a code that works
    once, for a minute. The preview posts the code and its verifier and gets an
    API key that reaches only `drafts`. The key is held in the tab's
    `sessionStorage` and expires within hours.
  - **B** — the same redirect, with the key itself in the URL fragment. This
    is the implicit grant, which RFC 9700 recommends against: the key sits in
    the browser's history.
  - **C** — basecamp's own session cookie, `SameSite=None`, with credentialed
    CORS from the preview. It needs no new code, but it fails wherever
    third-party cookies are blocked (Safari, Firefox, an owner's phone), and
    the preview would hold the person's whole basecamp session.
  - **D** — a sign-in form on the preview that posts the password to
    basecamp. It puts the password on a link meant for reviewers, carries the
    whole session, and has no path for SSO.
  - **Recommend A.** It is what the OAuth browser-apps draft and RFC 9700
    prescribe ([draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/),
    [oauth.net](https://oauth.net/implicit)). The scoped key already exists
    (`FJS-D916`), so the preview never holds more than `drafts`. The exchange
    is auth's unbuilt one, and Bearer-mode OAuth needs the same piece.
- ~~**Q18 — Where the preview's editor code comes from (2.1).**~~ **Answered 2026-10-20 (`FJS-D1358`): A — site-kit carries the editor and gains `@frontierjs/junction` as a dependency, which pulls in only toolbelt. Under `--preview` with an editor URL, the build emits `_fjs/editor.js` and adds its tag to each page through Sierra's `document.bodyEnd`.** The editor calls
  basecamp through junction's browser client, which owns unwrapping the result
  envelope (Invariant 4). A site-kit site installs css, mesa, sierra, site-kit
  and toolbelt. It does not install junction, which is an optional peer of
  Sierra. Vercel's toolbar on a preview deployment is a script served from
  vercel.live, and Netlify's Drawer is served from Netlify's origin. The tree's
  own sibling, the ask panel (`on-page-editing.md`), is built into the site by
  Sierra's `askPlugin`.
  - **A** — site-kit carries the editor and gains `@frontierjs/junction` as a
    dependency, which pulls in only toolbelt. Under `--preview` with an editor
    URL, the build emits `_fjs/editor.js` and adds its tag to each page through
    Sierra's `document.bodyEnd`.
  - **B** — basecamp serves the editor from its own web build, and the
    preview build adds only `<script type="module" src="<basecamp>/editor.js">`.
    Sites install nothing new, and the editor always matches the API it calls.
    The cost: a cross-origin module script needs CORS on basecamp's static
    files and a fixed-name second entry in its web build, in dev and in the
    deploy's proxy.
  - **Recommend A** (confidence 2). It matches the in-tree sibling, the ask
    panel built into the site, and adds no deploy plumbing. Skew between
    editor and API stays small, because every save rebuilds the preview. B is
    the reopen path if previews start to outlive basecamp's releases.
- ~~**Q19 — How a preview shows a change before it is saved (2.5).**~~ **Answered 2026-10-21 (`FJS-D1399`): D — words only, with no compiler in the page; a change that adds or removes markup waits for the rebuild.** A preset's Markdown passes are function values in its config, so neither the page nor basecamp could run the site's exact pipeline without a new preset key (A, recommended; B skipped the preset's passes; C compiled in basecamp). A is the reopen path.
- ~~**Q20 — How a reorder of a collection is written (3.1).**~~ **Answered 2026-10-22 (`FJS-D1403`): B — an `order:` key in each item, `collection()` sorting by it then by name (Hugo's `weight`). Files keep their names, and the order is written in two places for a site that also numbers its files.** `collection()`
  lists a collection's files in file-name order, and its own comment is the
  rule: "an author orders a collection by naming its files" (`1-stacy.md`).
  Prior art: Decap orders a folder collection only by a field
  (`sortable_fields`, [config](https://decapcms.org/docs/configuration-options/#sortable_fields));
  Hugo by a `weight` key ([byweight](https://gohugo.io/methods/pages/byweight/));
  Webflow has no manual order and its users add a number field
  ([forum](https://discourse.webflow.com/t/change-cms-items-order/219973));
  Framer's CMS keeps a dragged order of its own
  ([community](https://www.framer.com/community/posts/5xDY2fK6p7vkM6NeYmbyzD/)).
  - **A** — rename the files. A move renumbers the prefixes, padded so
    code-unit order holds (`01-` once there are ten), in one commit. The order
    stays where it is written today, and a slug, which carries the prefix,
    changes with it.
  - **B** — an `order:` key in each item, `collection()` sorting by it then by
    name (Hugo's `weight`). Files keep their names, and the order is written
    in two places for a site that also numbers its files.
  - **C** — one list file per collection naming its items in order.
  - **Recommend A** (confidence 2) — the rule exists, so nothing new is
    stated; B and C each add a second place the order lives. B is the reopen
    path if a block starts building URLs from a slug.
- ~~**Q21 — What Add makes (3.1).**~~ **Answered 2026-10-22 (`FJS-D1404`): A — a copy of the item it is added after, whole: the same keys and words, which the owner then changes. A collection item is a new file beside it; a menu entry is the entry repeated below.** CloudCannon's plain array clones the last
  item and empties its data
  ([array input](https://cloudcannon.com/documentation/articles/configure-an-array-input/)),
  and its structures and Decap's `fields` are a template the developer writes.
  - **A** — a copy of the item it is added after, whole: the same keys and
    words, which the owner then changes. A collection item is a new file
    beside it; a menu entry is the entry repeated below.
  - **B** — the same copy with its words emptied (CloudCannon). A number or
    yes/no is kept.
  - **C** — a template the developer writes per collection and per menu.
  - **Recommend A** (confidence 2) — every key stays a value the block already
    renders, so the preview shows a real item at once; B shows an empty review
    or a logo entry with no words until filled; C is a second statement of
    what the items already show.
- ~~**Q22 — Which menu entries an owner may move and remove (3.1).**~~ **Answered 2026-10-22 (`FJS-D1405`): A — every entry: the owner moves, removes and adds any of them, as `FJS-D1226` already treats every nested key as theirs.** A ksite
  menu mixes links with entries that carry `type`, `design`, `setting` or
  `classes` (the logo, the phone button). Q2 locks only top-level keys, so the
  inline save already lets an owner change a nested `design:` word.
  - **A** — every entry: the owner moves, removes and adds any of them, as
    `FJS-D1226` already treats every nested key as theirs.
  - **B** — only an entry whose keys are `name`, `link` and `items`; any other
    entry is the developer's, shown locked and kept in its place.
  - **Recommend A** (confidence 1) — it is Q2's ruling applied to lists, and B
    is a new hand-written key list site-kit would have to know of a preset's
    menu. Webflow locks the nav; B is the reopen path, and it would lock the
    nested look keys too.
- ~~**Q23 — Where a front-matter photo's alt text is written (3.2).**~~ **Answered 2026-10-22 (`FJS-D1406`): A — on the path, `?text=`: `hero_image: /media/images/porch.jpg?text=The%20front%20porch`. One value, read by the `Image.mesa` every ksite block already renders a photo through; no template changes. A template drawing a raw `<img src={…}>` (ksite's `Nav`) shows no alt and carries the query in `src`.** A photo
  in front matter is a path (`hero_image: /media/images/owner.jpg`), and no
  site writes alt text for one: Luminous Heart has 22 such photos and none
  carries any. ksite's `Image.mesa` already reads a `?text=` query on the path
  ahead of its `text` prop ("which is how ksite lets front-matter image paths
  carry their own sizing"), but no file uses it. Prior art: Decap's image
  widget saves only the path, and alt is a second field the developer declares
  beside it ([image widget](https://decapcms.org/docs/widgets/image/),
  [community](https://community.netlify.com/t/alt-text-and-title-text-for-featured-image/1681));
  CloudCannon shows a featured image with its alt as a separate field
  ([blog](https://cloudcannon.com/blog/how-you-can-optimize-your-cms-for-seo-success/));
  ButterCMS stores alt with the media pick and answers it beside the URL
  ([media field](https://buttercms.com/docs/core-concepts/field-types/media-field)).
  - **A** — on the path, `?text=`: `hero_image: /media/images/porch.jpg?text=The%20front%20porch`.
    One value, read by the `Image.mesa` every ksite block already renders a
    photo through; no template changes. A template drawing a raw `<img
    src={…}>` (ksite's `Nav`) shows no alt and carries the query in `src`.
  - **B** — a sibling key, `<key>_alt` (Decap's shape). Every block that
    renders the photo must read the new key, so until a developer changes
    each one the alt is written and never shown.
  - **C** — on the photo file: one alt per image in a sidecar, filled by
    site-kit's image step into every `<img>` that names it (WordPress's media
    library). One alt everywhere the photo appears, which a decorative use
    then cannot opt out of.
  - **Recommend A** (confidence 2) — the reader exists and every ksite photo
    passes through it; B and C each add a place alt lives that nothing reads
    yet. B is the reopen path once a second preset arrives.
- ~~**Q24 — Which photos 3.2 swaps.**~~ **Answered 2026-10-22 (`FJS-D1407`): A — front-matter photos only. Prose `<Image>` tags wait for a step of their own, filed.** ksite's template has 2 front-matter
  photos and 8 `<Image>` tags in prose (all SVG icons, the developer's);
  Luminous Heart has 22 front-matter photos and 29 prose `<Image>` tags, 28 of
  them with `text=`. A prose `<Image>` is a tag, and `FJS-D1250` refuses any
  change to a tag in an owner's save.
  - **A** — front-matter photos only. Prose `<Image>` tags wait for a step of
    their own, filed.
  - **B** — both: a tag whose only change is its `source` to a photo on the
    draft and its `text` is let through. `source` and `text` are ksite's
    names, so site-kit would learn them from the preset (a new preset key).
  - **Recommend A** (confidence 2) — it meets the phase's "swaps a photo" on
    both sites without touching `FJS-D1250`'s guard; B is a preset contract
    worth its own question.
- ~~**Q25 — What basecamp does with the bytes (3.2).**~~ **Answered 2026-10-22 (`FJS-D1408`): D — C and then A, as the owner answered: the page shrinks the photo to at most 2560 px in its own format so the body stays small, and basecamp still decodes and re-encodes it, so what reaches git is the server's promise. `http.maxBodySize` rises to 10 MB, `maxFrameBytes` pinned at 256 KB.** A phone photo is 3–8 MB
  and carries EXIF, often GPS, which a site would then publish. Basecamp's
  `http.maxBodySize` is junction's 256 KB default, global to every route.
  Bun.Image, which site-kit's build already uses, decodes and re-encodes.
  - **A** — re-encode every upload in basecamp with Bun.Image, in the format
    it came in, longest side at most 2560 px: a file that does not decode is
    refused, and the metadata is gone. `http.maxBodySize` rises to 15 MB, with
    `maxFrameBytes` pinned at 256 KB so sockets do not grow with it.
  - **B** — commit the bytes as sent, checked by their magic number, 5 MB at
    most. GPS ships.
  - **C** — the page shrinks the photo in a canvas before sending, and
    basecamp checks it decodes. The body stays near 2 MB; a script on the
    preview decides what reaches git.
  - **D** — C and then A, as the owner answered: the page shrinks the photo
    to at most 2560 px in its own format so the body stays small, and
    basecamp still decodes and re-encodes it, so what reaches git is the
    server's promise. `http.maxBodySize` rises to 10 MB, `maxFrameBytes`
    pinned at 256 KB.
  - **Recommend A** (confidence 2) — the server is the one place that can
    promise the photo is a photo and carries no location. A per-method body
    limit in junction is the cleaner bound, and is the reopen path.
- ~~**Q26 — Where a site's Anthropic key lives (4.1).**~~ **Answered 2026-10-22 (`FJS-D1424`): B — one `ANTHROPIC_API_KEY` in basecamp's env for every site, billed to whoever runs basecamp. Not per site.** `FJS-D1242` rules "an
  API key and a spend limit per site in basecamp". The run is `claude -p`
  (`askArgv({ edit })`), which takes a key as `ANTHROPIC_API_KEY` in its
  env. The sibling in this module is `cloudflareFor` (`domain/site/site-preview.ts`):
  a workspace Secret, `provider_key` with `providerKind: cloudflare`, picked by
  the column that names it or by being the only one. Prior art meters AI per
  account, not per site: Webflow pools AI credits per Workspace across its
  sites ([AI credits](https://help.webflow.com/hc/en-us/articles/51060121155347)),
  Sanity per organization ([quotas](https://www.sanity.io/docs/help/understanding-quotas.md)),
  and an Anthropic Console workspace scopes its own keys and carries its own
  monthly cap ([workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces),
  [announcement](https://anthropic.com/news/workspaces)).
  - **A** — a workspace Secret, `provider_key` with `providerKind: anthropic`
    (`ProviderKind` grows one value), and a new App column `askKeyId` naming
    one. Unnamed, the workspace's only Anthropic key is used, as `cloudflareFor`
    picks; two and none named is refused by name. Per site when named, pooled
    when not.
  - **B** — one `ANTHROPIC_API_KEY` in basecamp's env for every site, billed to
    whoever runs basecamp. Not per site.
  - **C** — whatever account `claude` is logged in as on the host, as the
    workbench runs. Not per site, and an owner's ask spends the operator's plan.
  - **Recommend A** (confidence 2) — it is `cloudflareFor`'s shape in the same
    module, it meets the ruling's "per site" without making every site mint a
    key, and one Console workspace per client puts Anthropic's own monthly cap
    on that client's key.
- ~~**Q27 — What the spend limit is (4.1).**~~ **Answered 2026-10-22 (`FJS-D1425`): A — per run only: the $2 `--max-budget-usd`, plus whatever monthly cap the key's Console workspace carries. Basecamp keeps no total.** `askArgv({ edit })` already caps
  each run at `ASK_BUDGET_USD` ($2) with `--max-budget-usd`, and the stream's
  `result` event carries the run's `total_cost_usd`. 4.3 needs a record of the
  run anyway: the diff the owner reviews outlives a reload, and Undo names the
  commit a save made.
  - **A** — per run only: the $2 `--max-budget-usd`, plus whatever monthly
    cap the key's Console workspace carries. Basecamp keeps no total.
  - **B** — per run, plus a monthly dollar cap on the App (`askMonthlyUsd`,
    null = no cap). Each run's cost goes in a status file beside
    `<appId>.previews.json`; an ask is refused once this calendar month's (UTC)
    total reaches the cap. Lost with the disk, so a cap can reset silently.
  - **C** — as B, but each run is a row (`SiteAsk`: app, draft, who, request,
    cost, state `running|ready|saved|discarded|refused`, the commit a save
    made). The row is the cap's ledger and 4.3's record of the run in one.
  - **Recommend C** (confidence 2) — Webflow and Sanity both hold a monthly
    allowance in the product, not at the model vendor, and a ledger is not
    derivable, so it belongs in the database rather than a cache file; the row
    is also what 4.3 needs. A is the smaller reopen path if a row is too much.

## The plan

### Phase 0 — Measure

Goal: the numbers that decide Q2's field mapping and Phase 2's live render.
Done when: each step's number is written under it.

- [x] 0.1 Count the owner-editable values on ksite's `content/` by where they
  render from: prose (whose stamp names the `.md`), front matter through a block
  (whose stamp names the template), or a collection item.
  **Measured 2026-10-17** on a `site-kit build --preview` of ksite (the
  template) and of Luminous Heart (the first real client). Every value Q2
  allows was matched to the innermost stamped element that renders it.

  | Where the value is | ksite | Luminous Heart |
  | --- | --- | --- |
  | Prose, and the stamp names its own `.md` line | 57 | 456 (186 of them raw HTML lines, such as a price list) |
  | Front matter, a collection field, a menu entry or a setting, where the stamp names a `.mesa` line | 102 | 283 |
  | A prop on a component inside prose (`<Image source>`, `<Button text>`), where the stamp names the component | 9 | 50 |
  | Text that matches both a front-matter value and prose, so no answer is certain | 2 | 65 |
  | A flag, number or enum word that renders as a mark (stars, a ✓ in a table) | 72 | 62 |
  | Head only (`<title>`, meta) | 2 | 4 |
  | Not on any page (overridden, unused, or past a list's limit) | 64 | 160 |

  - **Prose already works.** Every prose value that reaches a page names its
    own `.md` line, and this includes raw HTML in markdown.
  - **Values that render through a template are 63% of ksite's on-page text
    and 35% of Luminous Heart's.** They all share one of about 20 template
    lines (18 for ksite's 102 values, 20 for Luminous Heart's 283). For
    example, `Nav.mesa:46` stamps every menu link, so a template stamp can say
    which kind of thing was clicked but never which entry.
  - **Text matching cannot fill the gap.** 53% of ksite's on-page front-matter
    values and 66% of Luminous Heart's have the same text as some other
    editable value: a menu link appears in both the header and the footer, and
    "Book now" is used on every spa page.
  - **The reads are mostly direct.** Of the template lines that render a value,
    most read a field off a loaded object (`{item.name}`, `{item.link}`,
    `{settings.company_email}`, `{hours[day]}`). The rest read a prop passed
    in whole (`{title}`, `{reviewer}`) or a derived value
    (`{@html p}` over a split `hero_text`, `telHref(company_phone)`).
  - **Marks and off-page values need a form,** because there is nothing on
    the page to click. Phase 1's forms cover them.
  - Found on the way: `FJS-3255`. A body-less `_module.md` empties every page
    beneath it, which is Luminous Heart's `/thank-you/`.
- [x] 0.2 Re-render one changed markdown route in a browser with `FJS-D821`'s
  function, and time it. Name what a `.mesa` route would need.
  **Measured 2026-10-18** on Luminous Heart's `spa/index.md` (149 lines, 10
  bands, 5 component tags), with one sentence changed. In Chrome the page was
  the built `/spa/`, and the site's own dialect and the ksite preset's rehype
  pass were used. In Bun the measurement was Sierra's `sierra:mesa` transform
  over the site's real `siteKit({ preview: true })` config.

  | | Bun (basecamp's side) | Chrome 150 | Chrome, CPU ×4 |
  | --- | --- | --- | --- |
  | Load the compiler bundle (local, no network) | — | 82 ms | 135 ms |
  | First compile | 168 ms | 100 ms | 437 ms |
  | Each compile after it | 19–36 ms | 18–30 ms | 84–99 ms |
  | Replace the changed band in the page | — | 0.6 ms | 2.7 ms |

  The bundle is 596 KB minified and 187 KB gzipped: unified, remark, rehype,
  the Mesa compiler and acorn. The Mesa compiler alone is 100 KB gzipped.

  - **`FJS-D821`'s function is the wrong one.** It is toolbelt's `markdown()`,
    the safe subset written for a stranger's text. It escapes raw HTML (186 of
    Luminous Heart's 456 prose values are raw HTML), and it knows neither
    components nor the dialect's bands. A site-kit route compiles through
    Mesa's `compileMd`, so a live render has to run `compileMd` in the page.
  - **Swapping the compiled HTML in is correct only where there are no
    components.** `<Image>` comes back as `<img source=…>`, with no `src`. The
    band changed in the run contained one. Site-kit's image step (the srcset
    and the webp) also runs after the build, so even a plain `<img>` loses it.
    The prerendered element has to stay wherever the edit did not touch.
  - **The built page ships no route module.** `/spa/` loads no script of its
    own. The compiled route imports the runtime, ksite's `Image.mesa` and the
    site's `SpaExperiences.mesa`, and that one reads `import.meta.glob` over a
    collection, which only Vite resolves.
  - **The hero is the layout's**, rendered from front matter, so it is not in
    the route's compile. A front-matter edit does not re-render this way; that
    is 2.4's problem.
  - `prepareForCompile` lives in `mesa-plugin.js`, which imports Node
    builtins, so it cannot be bundled for a browser. The run used the three
    helpers it calls directly.
  - **What a `.mesa` route would need:** the Mesa compiler in the page, plus
    every module the route imports as a module the page can load. That means
    each component, the settings module, and each `import.meta.glob` resolved
    ahead of time. Today only a Vite dev server builds that graph.
  - **For 2.5:** replace only the prose elements whose stamps fall on the edited
    lines, and leave everything else to the preview rebuild. The compile can
    run in the page (lazy, preview-only) or in basecamp, at the warm times
    above.
  - Found on the way: `FJS-3275`. The dialect's band and article wrappers
    carry the template's line, not the `====` line.
- [ ] 0.3 Run the first real preview upload (`site-hosting.md` step 5's gap),
  because every draft depends on it.
  **Held by the owner 2026-10-18.** The local half passes: the website's
  `site-kit build site --preview` stamps 51 pages, and `site-kit deploy site
  --preview --dry` packs Worker `frontierjs-com`, aliased `main`. Two things
  stand before the real upload. Wrangler's login has expired, so someone must
  run `wrangler login` in a terminal or set `CLOUDFLARE_API_TOKEN`. And the
  Worker does not exist yet. The two ways forward: a preview-only upload,
  which may create the Worker without deploying it and leaves frontierjs.com
  on Pages, or step 4's real deploy first, which moves frontierjs.com's
  custom domain off `frontierjs-site`.

### Phase 1 — A draft and a publish, with forms

Goal: an owner changes a word and it goes live. The forms live in basecamp,
and Phase 2's on-page editor reuses their save and publish.
Done when: a grant-holding user edits frontierjs.com's copy in basecamp, the
preview link shows it, Publish ships it, and the commit carries their name.

- [x] 1.1 The grant (Q6) and the editable-file list for a git static App,
  derived from Q2's rule.
  **Built 2026-10-18.** The grant is basecamp's `AppEditor` (`appId`,
  `userId`, `role` of `edit` or `publish`), shaped like `WorkspaceMember`:
  `@@tenant(none)`, gate `1.5`, no `workspaceId` of its own. An editor reads
  their own rows with no membership, a member reads the rows of their
  workspace's apps, and only an admin of the App's workspace writes one.
  `/app-editors` refuses an App that is not `static` with a `git` source. The
  rule is `@frontierjs/site-kit/editable`: `pathRefusal(path)` allows
  `content/**/*.md` and raster photos under `content/` (an SVG can carry
  script, so it is the developer's), and `lockedKeysChanged(before, after)`
  names a changed `layout`, `name` or look key at the top level of the front
  matter. The look keys are read off `block-look.js`.
  - Proved by `db/test/schema.test.ts` § AppEditor (each rule with one row let
    through and one refused) and site-kit's `test/content.mjs`.
  - A cross-workspace create is refused twice: App's tenancy hides the app, so
    the reference names nothing, before the create policy is read.
  - Left for 1.2: the editor's own way in. `sessionScope` requires a
    workspace, so a holder with no membership cannot call `/app-editors`, and
    their list of sites is a method or a screen 1.2 adds. The seed has no site
    built from git, so `app_editor` is in `NOT_SEEDED` until 1.2 seeds one.
- [x] 1.2 Edit a file's prose and its content keys in a form. A save commits to
  the draft branch (Q3, Q4).
  **Built 2026-10-18.** `domain/site/site-checkout.ts` keeps a bare clone per App
  under `SITES_DIR` and fetches it before every read and save. A draft is
  `draft/<slug>`, opened by name (Q11), and each save is one commit built
  through a temporary index and pushed (Q9), authored and committed as the
  editor. The `drafts` service takes no workspace: each method reads the
  caller's own `AppEditor` row first, then the App through `asSystem()`. Its
  methods are `sites`, `list`, `open`, `files`, `read` and `save`, each at
  VISITOR, because the grant is what refuses. The form is site-kit's `formOf`
  and `applyEdit` (Q12). `applyEdit` reads the result back and refuses one that
  changes any key it was not asked to. `/sites/` and `/sites/[id]/` are the
  screens. The seed has Harbor Spa, edited by Lee Carter, a member of no
  workspace, and published by Kim.
  - Proved by `api/test/drafts.test.ts` over a real bare remote. Dropping the
    grant read turns it red. Also by site-kit's `test/content.mjs` § the
    owner's form, and a browser probe of the two screens signed in as Lee (not
    committed).
  - A stale save is a 409 twice over: the blob the form read is checked, and
    the push is a fast-forward.
  - Left: photos (Phase 3), and lists, maps and folded values, which show
    read-only. The image has no git (1.3 needs it there too). A client
    landing on `/` meets the members' overview and its refusals.
- [x] 1.3 A preview of the draft: `build --preview` on the branch, then
  `deploy --preview` aliased by the branch.
  **Built 2026-10-18.** First `FJS-D1250` (Q13, `FJS-3283`): `applyEdit`
  refuses a body holding a `<script>` block, a `{…}` or a tag with its
  attributes more often than the old body did, and any `javascript:` link,
  naming the piece. Then the build (Q14): Outpost's `POST /site/preview` makes
  a fresh checkout of the draft's branch, runs `bun install --frozen-lockfile`
  at its root and `site-kit build --preview` then `deploy --preview <slug>` at
  `source.path`, each in a `docker run --rm` as Outpost's own user, and
  removes the checkout. It answers the commit it built and the aliased URL.
  The token (Q15) reaches only the upload's container, named by `-e` and
  valued in the docker client's environment, never argv. Basecamp's
  `domain/site/site-preview.ts` picks the workspace's Cloudflare account (the one its
  ingress zone names, else its only one), reads the account id off that zone,
  sends the build to the App's placement, and keeps each draft's last preview
  in `<SITES_DIR>/<appId>.previews.json`. The `site:preview` job is
  dispatched by `drafts.open`, by a save that changed a file, and by
  `drafts.preview` (Build again). A save during a build is picked up by the
  same run's next round. `/sites/[id]/` shows the state, the link and the
  refusal, and polls while a build is on its way.
  - Proved by outpost's `test/outpost.test.js` § a site preview (10), site-kit's
    `test/content.mjs` (10 code cases), and basecamp's `api/test/drafts.test.ts`
    § a draft's preview (no account, no placement and a stub machine each
    refused by name; the account and token chosen).
  - Proved end to end by a scratch drive, 15/15 (not committed): a real API
    on a temp database, the real Outpost enrolled by `dev:outpost`, real
    Docker, and a bare clone of this repo as Harbor Spa's remote at
    `website/site`. Lee opened a draft and saved while it built. The run went
    round again and ended on the saved commit, refused only by Cloudflare
    itself (the account id was the sink's). The token was in no log, and the
    checkout was gone. In Chrome as Lee, the card showed the refusal, Build
    again queued a build, and the screen polled until it settled.
  - Left: a real upload, which needs 0.3's token. The basecamp image still has
    no git (`FJS-3280`); the build no longer needs it there, but the checkout
    does.
  - **Found: frontierjs.com has no markdown under `content/`.** Every route
    in `website/site` is `.mesa`, so an owner can edit nothing on it, and this
    phase's *Done when* cannot be met there as written. The drive added an
    `.md` page to its scratch remote.
- [x] 1.4 Publish: merge, build, deploy, record. A failed build, a conflict,
  or undeployed commits (Q5) each refuse by name.
  **Built 2026-10-20.** `drafts.publish` (the `publish` grant) writes a
  `Deployment` through asSystem() with trigger `publish` and four steps, and
  the `site:publish` job (`domain/site/site-publish.ts`, as the app) runs them:
  **Validate** refuses with no release recorded (Q16, `FJS-D1339`) and names
  every commit on the site's branch the last release did not ship, with its
  author (Q5); **Merge** is a three-way merge through a temporary index and
  `git merge-file`, by the publisher, refusing a line both sides changed by
  file, and pushed to the DRAFT's branch; **Build and deploy** sends Outpost's
  new `POST /site/publish` (the preview's containers without `--preview`,
  refused when the branch is no longer at the merge); **Advance branch** moves
  the site's branch to the merge only after a deploy, then removes the draft
  unless a save landed on it. A failed step is the release's, so the workspace
  gets `deploy_failed` naming it, and `/sites/[id]/` shows it on a Last publish
  card. Q16's developer path: a static `git` App's Deploy is `Validate`,
  `Build and deploy` over the same `releaseSite`, recording the commit. The
  release's writes moved to `domain/release/release-record.ts`, shared with
  `deployments.startRun`/`stepStatus`/`finishRun`.
  - Proved by outpost's `test/outpost.test.js` § a site publish (3), basecamp's
    `api/test/drafts.test.ts` § publishing a draft (the grant, Q16, Q5 naming
    the developer, the stub refused at Build and deploy with the branch
    unmoved, a both-sides line refused at Merge) and § the merge a publish
    ships (both one-sided edits kept, a moved branch refused, the branch
    advanced and the draft removed, over a real remote), and
    `inline-app.test.ts` (the static git step list). A scratch browser drive,
    7/7 (not committed): Lee saves and sees no Publish button, Kim publishes,
    the card names the step that refused, the merge is on the draft by Kim,
    and the release is on `/deployments/`.
  - Left: a real deploy, which needs 0.3's token, and so does the done-when.
    A site's rollback is refused (its release records no image); 1.5's Revert
    is the way back.
- [x] 1.5 History: each publish lists the files and the author, and Revert
  makes a draft from `git revert`.
  **Built 2026-10-20.** `drafts.history` is derived, nothing stored: the
  App's last 20 successful releases, each with `shipped()`'s diff from the
  release before it (paths under the site's own path) and the writers of its
  non-merge commits, so a publish names Kim as publisher and Lee as the one
  who wrote it. `drafts.revert { release }` is `git revert -m 1` done as the
  publish's three-way merge run backwards onto the site's branch (base: the
  merge, other side: its first parent), so a developer's later line stays,
  pushed as the new draft `revert-<draft>` by the reverter and previewed like
  any draft. It takes the `edit` grant, since it only opens a draft and
  Publish still takes `publish` (`FJS-D1230`); it refuses a developer's deploy,
  whose files are theirs (`FJS-D1226`), any path site-kit's `pathRefusal`
  refuses, a line changed again since (naming the files), and a revert draft
  already open. `/sites/[id]/` has a History card with Revert on each publish.
  - Proved by `api/test/drafts.test.ts` § publishing a draft (history's files,
    writers and kinds; the admin's 404; the deploy refused; the revert draft
    holding the page as it was, Owner's commit on main, main unmoved; a second
    revert refused) and § the merge a publish ships (the developer's line
    kept, a refused path, a later change refused as a conflict with no branch
    pushed). A scratch browser drive, 7/7 (not committed): Lee sees both
    releases, no Revert on the developer's, and Revert opens and picks
    `revert-hours` holding the old page.
  - Left: a revert reaches the live site through Publish, so a real one needs
    0.3's token too.
- [ ] 1.6 A deploy key per repository (`FJS-D1228`, deferred by
  `FJS-D1247`), so a private repository clones and pushes without the
  host's own credential. Ruled `FJS-D1555`: per App, made by the Outpost,
  the public half on the App's screen. The clone side is built there; the
  PUSH side (`site-checkout.ts` on Basecamp's host) is still owed.

### Phase 2 — On the page

Goal: click the thing you want to change.
Done when: an owner changes a paragraph by clicking it on the draft's
preview, the page shows the change before it is saved, and a reviewer without
a grant sees the Edit button but has every save refused.

- [x] 2.1 The Edit button and sign-in on a preview (`FJS-D1225`). Basecamp's
  API accepts a write from the site's preview host and checks the grant on
  every one.
  **Built 2026-10-20.** The sign-in is Q17 (`FJS-D1357`). Edit sends the
  browser to `/sites/<id>/edit/` with the page's address and an S256
  challenge; a signed-out person goes through `/login/?next=` and comes back.
  `drafts.handoff` reads the grant, refuses an address that is not one of this
  site's recorded previews, refuses a key, a support episode and an agent, and
  answers a redirect carrying auth's one-minute code on the fragment.
  `drafts.redeem` (`gate: 0`) spends it with the verifier, from the origin it
  was issued for, and mints an 8-hour API key scoped `drafts:read`/`drafts:write`
  with an `ApiKey` row in the site's workspace, so its admins can see and
  revoke it. The editor keeps the key in `sessionStorage`. auth gained
  `issueHandoff`/`redeemHandoff`, which store the HMAC of code and challenge as
  a `handoff` Credential that the hourly sweep clears. Basecamp's CORS origins
  are the declared list plus any recorded preview origin
  (`site-preview.ts` `isPreviewOrigin`). Junction now borrows a predicate into
  CSRF and composes one with `FRONTIER_CORS_ORIGINS`. The editor is site-kit's
  (Q18, `FJS-D1358`): `src/editor/`, built only by `build --preview` with
  `SITE_EDITOR`, which Outpost sets from the `editor` URL basecamp sends. It is
  emitted as `assets/fjs-editor.js` so Sierra's prune keeps its chunks, and
  minified, and each page loads it through `document.bodyEnd`. Signed in, it
  names the person and the draft; a 401 or 404 forgets the key.
  - Proved by `api/test/drafts.test.ts` § a preview signs in: an unrecorded
    address refused by name, a stranger's 404, a wrong origin, a wrong verifier
    and a second redemption each 401. The key reads and saves from the preview
    origin, CORS answers that origin, `/apps` and a second handoff are 403, and
    a dropped grant is 404. Also by auth's `test/expiry.test.ts` § a handoff
    code, junction's `test/derived-origins.test.ts` (a predicate composes with
    the derived list, and CSRF borrows it), outpost's `SITE_EDITOR` case and
    refusal, and site-kit's `test/content-build.mjs` (a release ignores
    `SITE_EDITOR`; a preview carries the tag and every chunk the editor
    imports). A scratch browser drive, 9/9 (not committed), on a temp-db API,
    the dev web and the built preview on its own origin: Edit shows signed
    out, goes through sign-in and comes back as Lee. The code leaves the
    address bar, the key is in the tab and reaches no other service, Sign out
    forgets it, and Sam, with no grant, is refused at basecamp.
  - Left: the editor is styled by the page's own `@frontierjs/css`, with no
    shadow root, so a preset that restyles `.btn` restyles it. The key reaches
    every site the person may edit, not just this one; the grant still decides
    each call. Sign out forgets the key in the tab, and the key itself lapses
    after 8 hours.
- [x] 2.2 The editor outlines stamped elements and turns a click's `loc` into
  a field. It ships only under `preview: true`.
  **Built 2026-10-21.** Signed in, the preview is picked rather than browsed:
  a pointer outlines the nearest stamped element (solid on a file the draft
  lists, dashed on a template), and a click, caught in the capture phase so a
  link never navigates, opens the stamp's file. A `.md` the draft lists opens
  as `Field.mesa`, Phase 1's form (the unlocked one-line keys and the body)
  with the clicked block selected, and saves through `drafts.save`. A
  template's stamp is `FJS-D1231` C: it names the template and lists the
  editable files, this page's route first. Browse hands clicks back to the
  page; Escape closes the field. `formOf` gained `bodyLine`, the file line the
  body starts on. `src/editor/pick.js` is the stamp-to-field half.
  - Found on the way: `FJS-3412`. Prose stamps named a line four past their
    own on any page that reads a setting, because Sierra synthesizes an import
    block and the prerender had no line map. Fixed in mesa and Sierra.
  - Proved by site-kit `test/content-build.mjs` (a preview's prose names its
    own `.md` line past an auto-import), `test/content.mjs` (`bodyLine`) and a scratch browser drive, 17/17
    (not committed), on a temp-db basecamp over a bare git remote with a
    `draft/spring` branch: the outline is editable on prose and not on a
    template, a click on a link in prose stays on the page and selects that
    block (a two-line paragraph whole), the keys show and a locked one does
    not, Save commits only that change to the draft, a template click offers
    the page's file first and opens a picked one, Browse picks nothing, and
    with the grant deleted mid-edit the save is refused and the branch does
    not move.
  - Left: the selection is the stamp's line on the build the preview came
    from, so after a save it can sit on a moved line until the preview
    rebuilds (2.3's `locateText` is the fix for writing). A component placed
    in prose (`<Button text>`) stamps its own file and gets the template
    list, not its placing line. The editor's own elements carry stamps naming
    where site-kit sits on the build machine.
- [x] 2.3 Edit a prose element inline. The save writes that `.md` line
  through `@frontierjs/toolbelt/textedit`'s `locateText`, the ask panel's text
  edit. In a `.md` it searches the whole body, so the same words twice anywhere
  on the page are refused; narrowing the search to the block the loc names is
  this step's.
  **Built 2026-10-21.** A click on a `.md` the draft lists lays a textarea
  over the element (`Inline.mesa`), the ask panel's Edit text shape: Enter
  saves, Escape and a click away cancel, and Edit the file opens 2.2's form.
  The save is `drafts.save` with `text: { line, old, next }` and no blob,
  since the old words found in the stamped block are the staleness check; the
  swapped body still goes through `applyEdit`. `locateText` searches a `.md`
  in the block the line opens (to the next blank line) and the whole body
  when that block lacks the words, so a line a save moved still lands while
  the same words twice are refused; the new words are collapsed to one line.
  A refusal opens the form at that line with the reason and the typed words.
  A leaf shows its new words at once; text with markup inside waits for the
  rebuild. `decision-rules` ran before the code.
  - Proved by toolbelt `test/specs/textedit.spec.js` (the clicked block of
    two equal ones, a moved line, one line, empty refused), basecamp
    `api/test/drafts.test.ts` § a text edit, cli's `vite-ask.test.js` and
    website's `verify:ask` unchanged, and a scratch browser drive, 17/17 (not
    committed), on 2.2's harness: a link's words change inside its brackets
    without following it, the second of two equal paragraphs is the one
    saved, words around a link open the form saying why with that paragraph
    selected, a two-line paragraph saves as one line, a stamp that save moved
    still lands, Escape saves nothing, a template still offers files, Browse
    picks nothing, and with the grant deleted the save is refused and the
    branch does not move.
  - Left: a block that lost the words falls back to the whole body, so
    words a link splits in the clicked block but written plain once elsewhere
    would change the other place; it is a draft, seen on the next preview. A
    two-line paragraph is rewritten as one line. The form's selection still
    uses the build's line (2.2's Left).
- [x] 2.4 A front-matter value lands on its field by provenance at the read (`FJS-D1231`).
  **Built 2026-10-21.** In a stamping build, Mesa's `compileMd` records its
  `frontmatter` export: each value is marked with its file line, taken from
  toolbelt's `frontmatterPositions`, through runtime `recorded()`. The loader
  is Mesa's and not site-kit's, because every `@content/x.md` import and
  collection glob is a module `compileMd` emits; `collection()` passes the
  object through. An element whose whole text is one field read
  (`{item.name}`, `{hours[day]}`) gets a `stampFrom` bind, which stamps the
  content line when the object carries it and still holds the value that line
  wrote. The mark is an enumerable symbol, so a copy (`{ ...item, link }`)
  keeps the lines of the keys it kept, and a key it changed keeps the
  template's stamp. A click on one lands inline like prose. `drafts.save`
  routes a `text` edit whose line is above the body to site-kit's new
  `applyEdit` `field` edit, which swaps exactly that value, quoted where YAML
  needs it, and refuses a locked key, a number, a value over several lines,
  and words the line no longer holds. A refusal opens the form with the
  reason and that key's field selected (`formOf` keys gained `line`). Every
  leaf on the page with the same stamp shows the new words at once.
  `decision-rules` ran late, after the code; it passed, with the loader's
  owner reconciled in the ruling's *Lives in* line.
  - Proved by site-kit `test/content-build.mjs` (a real `--preview` build: a
    menu link and a sub-entry name their menu lines, a collection field its
    item's file, a copy keeps a kept key's line and the template for a changed
    one), `test/content.mjs` (the field edit and its refusals),
    toolbelt `frontmatter.spec.js` (positions, CRLF included), basecamp
    `api/test/drafts.test.ts` § a text edit on a front-matter line, and a
    scratch browser drive, 18/18 (not committed), on 2.3's harness with a
    menu, a setting and a number. A collection title, a menu link (header and
    copied footer both update) and a setting with a colon each save to their
    own file; a number opens the form at its key; words a block worked out
    still offer files; a stale value and a dropped grant are refused with the
    branch unmoved. 2.3's drive is 17/17 with its template step now landing
    inline.
  - Found on the way: `FJS-3416`. A front-matter value is graded for no
    code, and ksite's hero renders `title` through `{@html}`.
  - Left: a setting bound bare in prose (`{company_name}`, through
    `.sierra/settings.js`) is not recorded and keeps the prose stamp. Text
    beside a value (`© {year} {settings.company_name}`) keeps the template's
    stamp. A prop passed in whole (the hero's keys) is `FJS-D1231` C. A nested
    value the inline save refuses has no field in the form, which lists only
    top-level keys (Phase 3).
- [x] 2.5 Re-render a markdown route live on the page before saving (0.2).
  **Built 2026-10-21, as Q19 ruled it (`FJS-D1399`): words only, no
  compiler.** As the owner types, inline or in the form, each leaf that shows
  the old words of a changed block or value shows the new ones, at its stamp
  or, when a save moved the line, as the file's one leaf with those words.
  New words carrying markup (Markdown syntax, `{…}`, what the dialect turns
  into a mark, a phone or email link, or a kicker) wait for the rebuild, as do
  a block added, removed or split and a number; the form counts what waits.
  Escape, Discard and closing put the page back; a save keeps the words.
  `src/editor/live.js` is the owner, and 2.3's after-save swap folded into it;
  `config/prose.js` exports `isKickerText`/`marksText` so the editor reads the
  dialect rather than restating it.
  - Proved by site-kit `test/content.mjs` (the block diff and what waits) and
    a scratch browser drive, 17/17 (not committed), on 2.4's harness: a typed
    paragraph and both copies of a menu link show before any commit and come
    back on Escape, one of two equal paragraphs changes alone, markup waits,
    the form shows a plain block, counts a block with a link and an added
    block, Discard restores, a save keeps, and a setting shows while a number
    waits. 2.4's drive 18/18 and 2.3's 17/17 unchanged.
  - Left: anything with markup shows only after the rebuild (`FJS-D1399`'s A
    is the reopen path).

### Phase 3 — Lists and media

Goal: CloudCannon's five kinds, minus `source`.
Done when: an owner adds a review, reorders a menu and swaps a photo.

- [x] 3.1 Add, remove and reorder collection items and menu entries.
  **Built 2026-10-22**, as Q20–Q22 ruled (`FJS-D1403`–`FJS-D1405`). The
  form (`Field.mesa`) lists every entry of the file's front-matter lists,
  sub-entries indented and the clicked one marked, and, on a file under
  `content/collections/<name>/`, says the item's place ("Item 2 of 3 in
  steps"). Each has Earlier, Later, Copy and Remove, one commit each through
  the new `drafts.arrange`, held still while words are unsaved. An entry is
  site-kit's `applyEdit` `entry` edit: its lines are cut and pasted, so every
  other line keeps its spelling, and the result must read back as exactly
  that change. A collection item is `arrangeCollection`: a move writes
  `order:` on each item whose place is new, a copy is the file whole beside
  it (`<name>-copy.md`), a removal deletes the file; basecamp commits all of
  them as one commit through `saveDraftFiles`, which `saveDraftFile` now
  calls. `collection()` sorts by `byOrder`, which the reorder reads too. The
  first moved earlier, the last later and a list's only item removed are
  refused.
  - Proved by site-kit `test/content.mjs` § an owner's lists (a ksite-shaped
    menu with sub-entries and a comment; a three-item collection with and
    without front matter), basecamp `api/test/drafts.test.ts` § Lists over a
    real remote (one commit per act, the messages, a stale blob, a stranger),
    and a scratch browser drive, 14/14 (not committed), on 2.5's harness with
    a three-step collection: a menu link opens its file with the entry
    marked, Later/Copy/Remove each commit and the list follows, unsaved words
    hold the list, a step's title opens its item, Earlier writes `order:` in
    one commit with names kept, Copy lands after it, a rebuild of the draft
    lists the steps in that order, Remove empties the form, and with the grant
    deleted an arrange is refused with the branch unmoved. 2.5's drive 17/17
    and 2.4's 18/18 on fresh fixtures.
  - Left: an arrange shows on the page only after the rebuild. Copy names the
    file `<name>-copy.md` whatever the owner then writes in it. A move writes
    `order:` on every item of a collection that had none, so the first
    reorder of a file-name-ordered collection touches each of its files.
- [x] 3.2 Upload an image into `content/media`. Alt text is required.
  **Built 2026-10-22**, as Q23–Q25 ruled (`FJS-D1406`–`FJS-D1408`). Read
  against the sites, `content/media` is `content/public/`: a photo's address
  `/media/images/x.jpg` is the file `content/public/media/images/x.jpg`, and
  an upload lands in the folder of the photo it replaces, so no folder is
  written down. site-kit's `photoOf` makes a top-level, unlocked front-matter
  value a photo when it names one of the site's own raster files (an SVG or
  another site's address is not one); `formOf` marks it and the form
  (`Field.mesa`) shows a thumbnail, a file picker and "What the photo shows"
  instead of a text box. A file chosen is shrunk in the page to 2560 px
  (`src/editor/photo.js`), sent with its words to the new `drafts.photo`,
  decoded and encoded again by Bun.Image in basecamp (`domain/site/site-photo.ts`),
  which refuses what does not decode and drops the EXIF, then committed beside
  the old photo, named for the upload (`photoName`, `-2` past a taken name),
  with the key's line rewritten by `applyPhoto` — new address, `?text=` the
  words, the block's other query keys kept and the old photo's `height`
  dropped — in one commit through `saveDraftFiles`, which now takes bytes.
  Words alone rewrite only the line. Empty words, a key that is not a photo
  and a stale blob are refused. Basecamp's `http.maxBodySize` is 10 MB in
  `app.ts` (the config file has no key for it); socket frames stay 256 KB.
  - Proved by site-kit `test/content.mjs` § an owner's photos, basecamp
    `api/test/drafts.test.ts` § Photos over a real remote (a 3000×2000 JPEG
    with a GPS marker in its EXIF commits as 2560×1707 without it, the old
    file kept, a second upload named `-2`, a stranger and a stale blob
    refused), and a scratch browser drive, 14/14 (not committed), on 3.1's
    harness with a page whose layout reads `?text=` as ksite's `Image.mesa`
    does: a click on the photo offers the page's file first, the form shows
    the photo with no words and nothing to save, a file that is not a photo
    is refused by basecamp with nothing committed, a 10.7 MB 4000×3000 photo
    leaves the page at 2560×1920 and still past junction's 256 KB default,
    blank words hold Save, the save is one commit holding the re-encoded
    photo (no GPS) and the line, a rebuild of the draft renders it with
    those words as `alt` and a `srcset`, words alone are one commit, and with
    the grant deleted the save is refused with the branch unmoved. 3.1's
    drive 14/14 (one earlier run missed once, reading the form before its
    reload), 2.5's 17/17 and 2.4's 18/18 on fresh fixtures.
  - Left: a prose `<Image>` tag (`FJS-3436`). The old photo stays in the
    repository whether anything still names it. A template that draws a raw
    `<img src={…}>` shows no alt and carries the query in its `src`
    (`FJS-D1406`). A swap shows on the page only after the rebuild. Found on
    the way: `FJS-3437`, a symlinked `node_modules` prerenders one route.

### Phase 4 — Ask a model (`FJS-D1242`)

Goal: an owner asks for a change in their own words and gets it as a draft
commit, through the ask panel's engine with the scope narrowed to Q2's set.
Done when: an owner asks for the opening hours to change on every page that
shows them, reviews the diff and saves it to their draft.

- [x] 4.1 Basecamp runs `ask-claude.js`'s edit argv on its checkout of the
  draft branch, scoped to `content/`, the way the workbench already imports
  it. The key and a spend limit are per site and held by basecamp.
  **Built 2026-10-22**, as Q26–Q27 ruled (`FJS-D1424`, `FJS-D1425`): the key
  is one `ANTHROPIC_API_KEY` for every site, the limit the argv's $2 a run.
  Not per site, as this box first said.
  - The clone is bare, so a run gets a folder: `exportDraftContent` writes the
    draft's `content/**.md` (regular files only) to a temp directory, and
    `askArgv({ edit })` allows Edit/Write in its `content/` and nothing else.
    `treeFromExport` hashes what moved into the clone and writes a tree on the
    head the run read. Nothing commits; 4.2 grades the tree and 4.3 commits it.
  - `drafts.ask { appId, draft, request }` queues the `site:ask` job, which runs
    `domain/site/site-ask.ts`. Each draft's last ask is in `<SITES_DIR>/<appId>.asks.json`
    and on `drafts.list`, as its preview is: state, reply, cost, files, tree.
    One ask per draft at a time. A run that hits its cap fails and its edits
    are dropped.
  - The prompt is the cli's `contentPrompt`, beside `EDIT_RULES`, and names
    site-kit's `LOCKED_KEYS` to leave alone. `runAsk` takes `env`, so the
    key goes to that child only; `ANTHROPIC_API_KEY` is declared in env.ts,
    so `childEnv` keeps it from every other child.
  - Real run (scratch, host login through a wrapper, since no key is set
    here): "9am → 8am on every page" on a three-file fixture changed all three
    in 9.6 s for $0.03. On its own it left `tone` and a README outside
    `content/` alone and said why. Test: `drafts.test.ts` § asking a model
    for a change, with a stand-in `claude`.
- [x] 4.2 The run's diff is graded against Q2's editable set before anything
  commits, and refused whole if it touches a developer file or a look key.
  **Built 2026-10-22.** site-kit's `changeRefusal(path, before, after)` is the
  path rule and `lockedKeysChanged` over a file's two texts, null for a file
  that is not there, so a page added or removed moves its `layout` and a
  collection item does not. Basecamp's `gradeAsk` runs it on every file under
  the run's folder that differs from what went out, so a file written outside
  `content/` is refused too, and a photo is refused as the save refuses one. A
  refusal is a `failed` ask, `nothing was kept: <each reason>`, with no tree.
  - `treeFromExport` now carries a removed file (`blob: null`); 4.1 dropped
    removals without saying so.
  - Test: `drafts.test.ts` § asking a model (a look key, a file outside
    `content/`, an item removed, a page removed) and site-kit's
    `test/content.mjs`.
- [x] 4.3 The owner sees the diff on the preview and saves or discards it.
  A save is one commit on the draft, and Undo is that commit's revert.
  **Built 2026-10-22.** The preview's bar has Ask (site-kit `Ask.mesa`): the
  owner's words go to `drafts.ask`, the card polls `drafts.asked`, and a ready
  ask shows each file as `git diff`'s lines (`diffTree`, the run's tree
  against the head it read), red and green, with the model's reply. Keep is
  `drafts.keep`, the tree as one commit on that head, authored by the keeper
  and named `Asked: <their words>` (`commitTree`); a draft that moved since is
  refused, `ask again`, rather than merged, since the tree would undo the move.
  Discard (`drafts.discard`) forgets the ask and commits nothing. Undo
  (`drafts.undo`) is `revertOnDraft`, the kept commit run backwards on the
  draft three-way, so a later save to other lines stays; it shares
  `undoneTree` with 1.5's Revert. The method is `keep`, not `save`, because
  `save` is already the one-file write.
  - Test: `drafts.test.ts` § asking a model (the lines, keep's one commit and
    its author, a second keep and a discard of a kept ask refused, undo's
    revert, a moved draft refused, discard). A scratch browser drive, 12/12
    (not committed): Lee asks on the preview, sees the red and green lines,
    discards, asks again, keeps, and undoes, each checked on the remote.

## The nine (`decision-rules`, answered before any edit)

1. **Origin** — content's one origin stays `content/` in git. The editable
   set comes from paths and site-kit's look-key list, and the field comes from
   the stamp. No hand-maintained editable map.
2. **Concept** — no new noun. A draft is a git branch, a preview is
   `FJS-D1221`'s Version URL, and a release is basecamp's existing record. The
   grant (Q6) is the one new row.
3. **Complexity** — the problem's own: every git-backed editor surveyed has a
   branch, a preview and a merge.
4. **Predictability** — an owner's publish is a developer's merge plus
   `site-kit deploy`. The two take the same path.
5. **Derived** — the editable set (Q2), the preview alias (`FJS-D1222`), and
   draft state, which is the branch list as git reports it.
6. **Owner** — basecamp owns the editor and the grant (`FJS-D921`). Sierra
   owns the build, the stamps and the adapter. Mesa owns the markdown render.
   The editor is the only new code in the site's build, and it goes under
   Sierra's `preview: true`.
7. **Boundary** — the editor on a preview sends basecamp a file, a location
   and the new text, and basecamp decides everything else: the grant, the
   path rule (`FJS-D1226`), the branch. A preview holds a session and never a
   git credential (`FJS-D1225`).
8. **Failure** — a publish that would ship a failed build, a conflict or
   another person's undeployed work is refused by name. A developer file is
   refused by path.
9. **Silence** — *stays true:* production never carries the editor or a stamp.
   *What fails:* step 5's deploy check, which refuses a stamped dist, would also
   catch the editor if it lives in the stamped build. That an owner's edit
   writes the block they clicked is toolbelt's `textedit.spec.js` and
   basecamp's `drafts.test.ts` § a text edit; in a browser, a scratch drive.

Adjudications: *batteries vs. smallness* (owner editing is a basecamp module
and the site carries only the preview's editor) and *paved road vs. the
workaround* (Pinmark's `textContent` edit mode, cut in `anchored-feedback.md`,
was the workaround). Tier: Assessment (`IDEAS/`).

## Not in this file

- **Anchored review** — pins and threads on a preview are
  `anchored-feedback.md`. An owner's draft preview is where those pins land.
- **Layout and new page types** — a developer's job: the ask panel
  (`on-page-editing.md`) or a preview branch (`preview-branch.md`).
