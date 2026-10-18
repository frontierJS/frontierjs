---
id: owner-editing
status: proposed
dated: 2026-10-17
---

# Idea — owner editing: a site's owner changes their own words

**Status: PROPOSED. Nothing is built. Q1–Q7 are ruled (`FJS-D1225`–`FJS-D1231`).** Do not cite this file as describing
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
| One render function for the prerender and the browser | `FJS-D821` | a changed markdown route can re-render in the page before anything builds |
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
- [ ] 0.2 Re-render one changed markdown route in a browser with `FJS-D821`'s
  function, and time it. Name what a `.mesa` route would need.
- [ ] 0.3 Run the first real preview upload (`site-hosting.md` step 5's gap),
  because every draft depends on it.

### Phase 1 — A draft and a publish, with forms

Goal: an owner changes a word and it goes live. The forms live in basecamp,
and Phase 2's on-page editor reuses their save and publish.
Done when: a grant-holding user edits frontierjs.com's copy in basecamp, the
preview link shows it, Publish ships it, and the commit carries their name.

- [ ] 1.1 The grant (Q6) and the editable-file list for a git static App,
  derived from Q2's rule.
- [ ] 1.2 Edit a file's prose and its content keys in a form. A save commits to
  the draft branch (Q3, Q4).
- [ ] 1.3 A preview of the draft: `build --preview` on the branch, then
  `deploy --preview` aliased by the branch.
- [ ] 1.4 Publish: merge, build, deploy, record. A failed build, a conflict,
  or undeployed commits (Q5) each refuse by name.
- [ ] 1.5 History: each publish lists the files and the author, and Revert
  makes a draft from `git revert`.

### Phase 2 — On the page

Goal: click the thing you want to change.
Done when: an owner changes a paragraph by clicking it on the draft's
preview, the page shows the change before it is saved, and a reviewer without
a grant sees the Edit button but has every save refused.

- [ ] 2.1 The Edit button and sign-in on a preview (`FJS-D1225`). Basecamp's
  API accepts a write from the site's preview host and checks the grant on
  every one.
- [ ] 2.2 The editor outlines stamped elements and turns a click's `loc` into
  a field. It ships only under `preview: true`.
- [ ] 2.3 Edit a prose element inline. The save writes that `.md` line.
- [ ] 2.4 A front-matter value lands on its field by provenance at the read (`FJS-D1231`).
- [ ] 2.5 Re-render a markdown route live on the page before saving (0.2).

### Phase 3 — Lists and media

Goal: CloudCannon's five kinds, minus `source`.
Done when: an owner adds a review, reorders a menu and swaps a photo.

- [ ] 3.1 Add, remove and reorder collection items and menu entries.
- [ ] 3.2 Upload an image into `content/media`. Alt text is required.

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
