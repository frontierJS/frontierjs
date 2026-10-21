---
id: owner-editing
status: proposed
dated: 2026-10-17
---

# Idea — owner editing: a site's owner changes their own words

**Status: PROPOSED. 1.1–1.5 and 2.1 are built. Q1–Q18 are ruled (`FJS-D1225`–`FJS-D1231`, `FJS-D1242`, `FJS-D1246`–`FJS-D1252`, `FJS-D1339`, `FJS-D1357`, `FJS-D1358`).** Do not cite this file as describing
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
  (`api/src/core/app-source.ts`).
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
| Real git in basecamp | `api/src/core/local-git.ts`, the `git` App source | basecamp already runs git and parses its output |
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
  **Built 2026-10-18.** `core/site-checkout.ts` keeps a bare clone per App
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
  `core/site-preview.ts` picks the workspace's Cloudflare account (the one its
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
  the `site:publish` job (`core/site-publish.ts`, as the app) runs them:
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
  release's writes moved to `core/release-record.ts`, shared with
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
  host's own credential.

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
- [ ] 2.2 The editor outlines stamped elements and turns a click's `loc` into
  a field. It ships only under `preview: true`.
- [ ] 2.3 Edit a prose element inline. The save writes that `.md` line
  through `@frontierjs/toolbelt/textedit`'s `locateText`, the ask panel's text
  edit. In a `.md` it searches the whole body, so the same words twice anywhere
  on the page are refused; narrowing the search to the block the loc names is
  this step's.
- [ ] 2.4 A front-matter value lands on its field by provenance at the read (`FJS-D1231`).
- [ ] 2.5 Re-render a markdown route live on the page before saving (0.2).

### Phase 3 — Lists and media

Goal: CloudCannon's five kinds, minus `source`.
Done when: an owner adds a review, reorders a menu and swaps a photo.

- [ ] 3.1 Add, remove and reorder collection items and menu entries.
- [ ] 3.2 Upload an image into `content/media`. Alt text is required.

### Phase 4 — Ask a model (`FJS-D1242`)

Goal: an owner asks for a change in their own words and gets it as a draft
commit, through the ask panel's engine with the scope narrowed to Q2's set.
Done when: an owner asks for the opening hours to change on every page that
shows them, reviews the diff and saves it to their draft.

- [ ] 4.1 Basecamp runs `ask-claude.js`'s edit argv on its checkout of the
  draft branch, scoped to `content/`, the way the workbench already imports
  it. The key and a spend limit are per site and held by basecamp.
- [ ] 4.2 The run's diff is graded against Q2's editable set before anything
  commits, and refused whole if it touches a developer file or a look key.
- [ ] 4.3 The owner sees the diff on the preview and saves or discards it.
  A save is one commit on the draft, and Undo is that commit's revert.

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
   writes the line they clicked is `none` until 2.3 has a drive.

Adjudications: *batteries vs. smallness* (owner editing is a basecamp module
and the site carries only the preview's editor) and *paved road vs. the
workaround* (Pinmark's `textContent` edit mode, cut in `anchored-feedback.md`,
was the workaround). Tier: Assessment (`IDEAS/`).

## Not in this file

- **Anchored review** — pins and threads on a preview are
  `anchored-feedback.md`. An owner's draft preview is where those pins land.
- **Layout and new page types** — a developer's job: the ask panel
  (`on-page-editing.md`) or a preview branch (`preview-branch.md`).
