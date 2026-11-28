---
id: mail-client
status: reading
dated: 2026-11-27
---

# Reading — what an email client has to get right, and who already did

**Status: READING.** This is the research behind stressor #51 (Courier,
`fjs-prototypes/courier/PLAN.md`). It proposes nothing for the framework and
describes no behavior of it. Each claim carries its source. A claim marked
*(inferred)* is a synthesis nobody published, and § Not verified lists what was
looked for and not found. Researched 2026-11-27 by four read-only agents; RFC
clauses marked *(not re-fetched)* come from the RFC as remembered, not from a
re-read this session.

Five topics, in the order the plan's phases meet them: § IMAP sync, § MIME
parsing, § Threading, § Hostile HTML, § Sending and deliverability. Each ends
with **Recommended**, which is what the plan's Questions start from.

---

## What the framework already has

Read from this tree on 2026-11-27, with `file:line` where a plan step will lean on it.

- **Sending exists, receiving does not.** `packages/junction/src/mail/smtp.ts` is a Bun-native ESMTP client with no dependencies: STARTTLS on 587, implicit TLS on 465, `AUTH PLAIN` and `LOGIN` only. It builds MIME (`toMime` `:624`), mints a Message-ID (`messageIdFor` `:575`) and refuses a CR or LF in an address or header (`assertAddress` `:75`, `assertHeaderValue` `:130`). It has no XOAUTH2.
- **Junction parses no MIME.** The one parser in the tree is `packages/conduits/conduit-mailgun/src/mime.ts:24`, on `postal-mime` 4.0.11.
- **No IMAP client, HTML sanitizer or image proxy exists** in any package. `jsdom`, `dompurify`, `imapflow` and `mailparser` are nobody's dependency. `happy-dom` is a devDependency of several packages, and DOMPurify's README says it is not safe to sanitize with.
- **`packages/ui/components/display/HtmlFrame.mesa`** renders `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">` with no token granted. It cannot report its content's height.
- **Two API connectors read mail without IMAP**: `conduit-gmail` (Gmail REST; `src/mime.ts` has `replyHeaders` `:121` and `subjectsThread` `:99`) and `conduit-microsoft` (Graph, delta sync). Neither has been run against the real vendor's mail.
- **Litestone has the storage**: `@@fts` over FTS5, `File` columns over local or S3-shaped storage, `@encrypted` and `@secret`, row policies.
- **Junction has the lifecycle**: a plugin's `work()` is where "workers, pollers, timers" start (`packages/junction/src/core/app.ts:108`) and it is skipped in one-shot processes; `shutdown()` is `:117`. The default request body limit is 256 KB (`src/config/index.ts:278`), which an attachment upload passes at once.
- **A mirror may key on the row's own id.** `@@mirror(key: externalId)` is the usual shape (`FJS-D1142`, `FJS-D1144`). `FJS-D2071` (2026-11-26) ruled that when the Provider issues no key that lasts, the mirror keys on `id`, the Provider's address becomes a `@system` column the sync rewrites, and the sync matches by its own rules instead of conduit's key-matched upsert. An IMAP message is that case (§ IMAP sync, identity), and the ruling says only a scratch probe proves the move so far.
- **One app already re-matches mail.** ELA's Microsoft sync pairs a moved message by its Message-Id (`FJS-D1463`: the dialect became `conduit-microsoft`, the engine stayed in the app at `fjs-prototypes/ela/api/src/providers/microsoft/`).

---

## IMAP sync

### The state a client keeps

Per folder: `UIDVALIDITY`, `UIDNEXT` (or the highest UID seen) and, where the server has CONDSTORE, `HIGHESTMODSEQ`. A message's address is `(folder, UIDVALIDITY, UID)` and nothing shorter. Delta Chat's `imap` table is keyed exactly so ([imap.rs](https://rs.delta.chat/src/deltachat/imap.rs.html)).

**The disconnected-client algorithm is [RFC 4549](https://www.rfc-editor.org/rfc/rfc4549.txt):**

1. Replay the person's queued actions first, in order.
2. Check `UIDVALIDITY` on every `SELECT`. If it changed, empty the folder's cache and drop pending actions on its messages, but "MUST NOT cancel any scheduled uploads (i.e., APPENDs)".
3. Fetch new mail with `UID FETCH <lastseenuid+1>:* (FLAGS BODYSTRUCTURE RFC822.SIZE …)`.
4. Without CONDSTORE, `UID FETCH 1:<lastseenuid> FLAGS` refreshes flags, and a UID missing from the answer was expunged.

The same RFC's habits: `+FLAGS.SILENT` and `-FLAGS.SILENT`, never a plain `FLAGS` store; `UID EXPUNGE`, never a plain `EXPUNGE`; `BODY.PEEK` so a read does not set `\Seen`; never store a sequence number. (Its section numbers came through a summarizer; re-read before citing one.)

**[RFC 7162](https://www.rfc-editor.org/rfc/rfc7162.txt) CONDSTORE and QRESYNC make step 4 cheap.** `CHANGEDSINCE <modseq>` returns only changed flags. `SELECT … (QRESYNC (…))` after `ENABLE QRESYNC` also returns `VANISHED (EARLIER)` for expunged UIDs. Update the cached `HIGHESTMODSEQ` only after the resync completes. A folder can answer `NOMODSEQ`. CONDSTORE alone does not report expunges ([Mozilla bug 912216](https://bugzilla.mozilla.org/show_bug.cgi?id=912216)), so a CONDSTORE-only server still needs a UID comparison.

**IDLE ([RFC 2177](https://www.rfc-editor.org/rfc/rfc2177)) must be re-issued inside 29 minutes** and watches one folder per connection.

### Identity

A UID is not an identity: a move issues a new one, a `UIDVALIDITY` change voids them all, and one message in two folders has two.

- **[RFC 8474](https://www.rfc-editor.org/rfc/rfc8474.txt) OBJECTID** gives `EMAILID`, `THREADID` and `MAILBOXID` that survive a move, "intentionally defined to be compatible with" JMAP Mail.
- **Gmail** gives `X-GM-MSGID`, `X-GM-THRID` and `X-GM-LABELS` ([IMAP extensions](https://developers.google.com/gmail/imap/imap-extensions)).
- **Where neither exists**, Mailspring-Sync builds the id from a hash of headers, and its PR #144 moved the model from one folder per message to many ([Mailspring-Sync](https://github.com/Foundry376/Mailspring-Sync)).

### Who supports what

- **Dovecot, Cyrus, iCloud and Zimbra** have CONDSTORE and QRESYNC ([Mozilla bug 1747311](https://bugzilla.mozilla.org/show_bug.cgi?id=1747311)). iCloud's QRESYNC has misbehaved ([Apple forum](https://developer.apple.com/forums/thread/694251)).
- **Gmail** has CONDSTORE and not QRESYNC ([Mozilla bug 1124569](https://bugzilla.mozilla.org/show_bug.cgi?id=1124569)), and caps IMAP at 2,500 MB a day down and 500 MB up ([bandwidth limits](https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits)).
- **Password sign-in is ending.** Google Workspace ended it on 2025-03-14 ([notice](https://support.google.com/a/answer/14114704)). Microsoft needs XOAUTH2 with `IMAP.AccessAsUser.All`, `SMTP.Send` and `offline_access` ([Microsoft Learn](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)). So the two largest providers cannot be reached with a password, and a client that stops at `AUTH PLAIN` reaches neither.

### What real clients do

- **Nylas sync-engine** ([generic.py](https://raw.githubusercontent.com/nylas/sync-engine/master/inbox/mailsync/backends/imap/generic.py), [actions.py](https://raw.githubusercontent.com/nylas/sync-engine/master/inbox/transactions/actions.py)): one engine per folder, newest first. With CONDSTORE it refreshes flags in batches of 200; without, it refreshes the newest 100 UIDs every 30 s and runs a slow pass hourly, capped at 2,000. Write-back is an `ActionLog` replayed in id order, 20 retries at 30 s, with no idempotency key.
- **Mailspring-Sync**: two connections per account (one idles, one works), bodies for the last three months only, and a test suite against a fake IMAP server and Dovecot.
- **EmailEngine** ([docs](https://learn.emailengine.app/docs/receiving/tracking-deleted)): one connection, IDLE on the inbox (All Mail for Gmail), poll the rest, a full resync every 15 minutes, and one `mailboxReset` event when `UIDVALIDITY` changes.
- **mbsync** ([manual](https://isync.sourceforge.io/mbsync.html)): a state file per folder pair, `MaxSize` placeholders for large messages, duplicate-UID detection.
- **K-9** queues pending commands, and its bugs are the cautionary pair: a queued action holding a server id that went stale ([#823](https://github.com/k9mail/k-9/issues/823)), and a folder rename breaking a queued move ([#4582](https://github.com/thunderbird/thunderbird-android/issues/4582)).

### Libraries and test servers

- **`imapflow`** (MIT, 2.12.2 released 2026-11-20): the maintained choice, and its README says the ESM build runs on Bun. One instance is one connection with no reconnect of its own. Bun reports to respect: `servername` handling for an IP host, and an unhandled error when the connection closes during login, so attach an `'error'` listener before `connect()`. `node-imap` and `emailjs-imap-client` are unmaintained.
- **Dovecot in Docker** ([docs](https://doc.dovecot.org/main/installation/docker.html)): `dovecot/dovecot:latest-dev` accepts any username with `USER_PASSWORD`, and `doveadm import` loads a maildir. It has CONDSTORE, QRESYNC and IDLE.
- **GreenMail** (`greenmail/standalone`, IMAP on 3143) advertises none of ENABLE, CONDSTORE or QRESYNC (single source), which makes it the fallback-path server.
- **Stalwart** (`stalwartlabs/stalwart`) serves IMAP, JMAP and SMTP from one binary and is the reference JMAP server. Mailpit has no IMAP.
- **JMAP** ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620), [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621), [why JMAP](https://jmap.io/why-jmap/)) is served in 2026 by Fastmail, Stalwart, Cyrus and Apache James. Its data model (immutable Email ids, a `state` string and `/changes` per type) is the cleanest published statement of what a client's local store should be able to answer.

**Recommended.** Key a placement by `(folder, UIDVALIDITY, UID)` and a message by OBJECTID, else `X-GM-MSGID`, else a header hash. Run RFC 4549 with the QRESYNC shortcut where offered and the UID comparison where not, and prove both against real servers. Queue every write, address it by message identity and never by a UID captured earlier, and learn new UIDs from UIDPLUS answers. Use `imapflow` inside a plugin's `work()`.

---

## MIME parsing

### The standards a parser answers to

*(not re-fetched)* [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322) headers, folding and the obsolete syntax a reader must still accept; [RFC 2045](https://www.rfc-editor.org/rfc/rfc2045) and [RFC 2046](https://www.rfc-editor.org/rfc/rfc2046) content types, transfer encodings and multipart grammar (in `multipart/alternative` the last part is preferred); [RFC 2047](https://www.rfc-editor.org/rfc/rfc2047) encoded-words; [RFC 2231](https://www.rfc-editor.org/rfc/rfc2231) parameter continuations and charset; [RFC 6532](https://www.rfc-editor.org/rfc/rfc6532) raw UTF-8 headers; [RFC 2183](https://www.rfc-editor.org/rfc/rfc2183) `Content-Disposition`; [RFC 2392](https://www.rfc-editor.org/rfc/rfc2392) `cid:` URLs; [RFC 3676](https://www.rfc-editor.org/rfc/rfc3676) `format=flowed`.

### What real mail gets wrong

- **MimeKit's `compliance` folder is the catalog** ([test data](https://github.com/jstedfast/MimeKit/tree/master/UnitTests/TestData/compliance), MIT): missing end boundary, missing boundary parameter, duplicate `Content-Type`, invalid transfer encodings, raw 8-bit and KOI8-R headers, null bytes in headers and bodies, a missing body separator. Its `messages` folder adds an empty multipart and a delivery status with no blank line.
- **`postal-mime` documents its choices** and matches Python's `email` package on purpose, so a scanner and the client read the same message the same way ([README](https://github.com/postalsys/postal-mime/blob/master/README.md)): the header block ends at the first line that is neither a header nor a fold, a bare CR in a header becomes a space, and a `message/rfc822` part with a base64 or quoted-printable encoding is an attachment.
- **The charset fallback is a trap.** `postal-mime` issue [#94](https://github.com/postalsys/postal-mime/issues/94): labels `TextDecoder` does not know (`cp932` among them) fell back to windows-1252 and produced mojibake silently. Fixed, but the shape recurs with any unknown label.
- **UTF-7 is refused by mailparser on purpose**, because `+ADw-script+AD4-` decodes to `<script>` after a filter has looked ([README](https://github.com/nodemailer/mailparser/blob/master/README.md)).
- **Filenames arrive two ways.** Old Outlook wrote RFC 2047 words inside quotes, which RFC 2047 forbids, and never RFC 2231, so a parser decodes both ([MimeKit FAQ](https://github.com/jstedfast/MimeKit/blob/master/FAQ.md)).
- **TNEF (`winmail.dat`)** is handled by MimeKit and by neither JS parser.

### Which part is the body

[RFC 8621 §4.1.4](https://www.rfc-editor.org/rfc/rfc8621#section-4.1.4) publishes the algorithm, as a suggestion. Walk the part tree and build three lists, `textBody`, `htmlBody` and `attachments`. A part is inline when its disposition is not `attachment`, its type is `text/plain`, `text/html` or an image, audio or video type, and it is either first in its list or has no filename outside `multipart/related`. Inside an alternative, a `text/plain` goes to `textBody` and a `text/html` to `htmlBody`; a text-only message appears in both. The RFC's worked example is the test case. *(inferred)* For `multipart/signed` show the first child, and for `multipart/report` show the readable part and keep the delivery status as an attachment.

### Where a parser is attacked

- **Parser differentials.** A 2025 Radboud study fuzzed MIME parsers against each other and found content that one parser shows and another hides, a multipart preamble among them ([paper](https://www.cs.ru.nl/~erikpoll/papers/mime2025.pdf)).
- **SMTP smuggling** ([SEC Consult](https://sec-consult.com/blog/detail/smtp-smuggling-spoofing-e-mails-worldwide/), [CERT VU#302671](https://kb.cert.org/vuls/id/302671)) is an end-of-data disagreement between servers. A client that only fetches over IMAP is exposed to the differential, not the smuggle.
- **Limits.** `postal-mime` defaults: nesting depth 256, 10,000 parts, 2 MiB of headers, `message/rfc822` depth 10. It holds the whole message in memory, so the size is capped before the call. No parser read states a base64 or decompression limit.
- **Filenames** *(inferred beyond the first clause)*: MimeKit warns that a filename must carry no path. Take the basename, strip control characters and the bidi overrides, cap the length, never trust the extension for the type, and serve every attachment with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

### Libraries and corpora

- **`postal-mime` 4.2.1** (2026-11-10, MIT-0, no dependencies) names Bun as supported and is what its own maintainers recommend over mailparser. **`mailparser` 3.15.0** streams, decodes ISO-2022-JP, and is in maintenance mode. `letterparser` and `emailjs-mime-parser` are inactive.
- **Corpora**: MimeKit's test data (MIT; it includes a `jwz.*` threading set under `mbox`), CPython's [`test_email/data`](https://github.com/python/cpython/tree/main/Lib/test/test_email/data), the [SpamAssassin public corpus](https://spamassassin.apache.org/old/publiccorpus/) for 2002–2005 oddities, the [Enron corpus](https://www.cs.cmu.edu/~enron/) for volume (no license stated), and [fastmail/JMAP-TestSuite](https://github.com/fastmail/JMAP-TestSuite) (license not checked).

**Recommended.** Parse with `postal-mime` behind a size cap. Keep the raw bytes, so a parser fix can be re-run over old mail. Check a charset label against a known list before decoding, refuse UTF-7, and fall back to UTF-8 with replacement. Choose bodies by RFC 8621 §4.1.4. Show `winmail.dat` as an attachment and say so.

---

## Threading

### The two published algorithms

**JWZ** ([threading](https://www.jwz.org/doc/threading.html), read from the Wayback copy): build a container per Message-ID, link each message's `References` chain in order, never add a link that makes a loop, set the parent to the last reference, prune empty containers, then group the roots by stripped subject. From `In-Reply-To` take only the first thing shaped like a Message-ID: in a 1997 sample of 22,950 such headers, about 20% held no `<…>` at all. It rebuilds the whole folder each run.

**[RFC 5256](https://www.rfc-editor.org/rfc/rfc5256.txt) `REFERENCES`** is JWZ made normative, and its §2.1 defines the *base subject* in seven steps: decode encoded-words and collapse whitespace, strip trailing `(fwd)`, strip leading `re:`, `fw:` and `fwd:` with optional `[blob]`, repeat, then unwrap `[fwd: … ]`. The grammar knows only the English prefixes, so `AW:`, `SV:` and `回复:` survive it.

### What shipped systems do

- **notmuch** ([add-message.cc](https://github.com/notmuch/notmuch/blob/master/lib/add-message.cc)): ids only, no subject. An id seen only in a `References` header gets a *ghost* record carrying a thread id, so a child that arrives before its parent is already in the right thread. A message that names two threads merges them by rewriting the loser's thread id. The display parent is a strict `In-Reply-To` id, else the last reference, else the first `In-Reply-To` id.
- **Mailspring-Sync** ([MailProcessor.cpp](https://github.com/Foundry376/Mailspring-Sync/blob/master/MailSync/MailProcessor.cpp)): a `ThreadReference(threadId, accountId, headerMessageId)` table holding each message's own id, its first reference and its last 99. Lookup is `IN (…) LIMIT 1` over up to 50 ids, so it joins and never merges. No subject matching.
- **Thunderbird** (`ThreadNewHdr` in [nsMsgDatabase.cpp](https://hg.mozilla.org/comm-central/raw-file/tip/mailnews/db/msgdb/src/nsMsgDatabase.cpp)): references from nearest to farthest; a message that replies to itself loses its references; subject threading only when the message has `Re:` and `mail.strict_threading` is off.
- **Cyrus**, which runs Fastmail ([message.c](https://github.com/cyrusimap/cyrus-imapd/blob/master/imap/message.c)): ids from `References`, `In-Reply-To` and the message's own id, capped at 20 per header, joined only when the normalized subject also matches. A conversation splits at 100 messages (`conversations_max_thread`). It takes the highest matching conversation and does not merge at ingest.
- **Gmail** splits a conversation when the subject changes and past 100 messages ([help](https://support.google.com/mail/answer/5900)); its matching rules are not published.
- **JMAP** ([RFC 8621 §3](https://www.rfc-editor.org/rfc/rfc8621#section-3)): suggests joining on a shared id and a matching base subject. A `threadId` is immutable, so a merge means the server destroys and re-creates the Emails.
- **Nylas** threads non-Gmail mail on cleaned subject plus two shared participants and no `References` at all, and its own comment calls the subject assumption "only right 95% of the time" ([threading.py](https://github.com/nylas/sync-engine/blob/master/inbox/util/threading.py)).
- **Outlook** writes `Thread-Index`: 22 bytes naming the conversation, then 5 per reply ([MS-OXOMSG](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxomsg/9e994fbb-b839-495f-84e3-2c8c02c7dd9b)).

### Where the systems disagree

| Case | Joins | Splits or refuses |
| ---- | ----- | ----------------- |
| Reply that changes the subject | notmuch, Thunderbird | Gmail, Fastmail, Cyrus |
| Same subject, no ids | Nylas (with two shared participants), Thunderbird (with `Re:`) | notmuch, Mailspring |
| One message naming two threads | notmuch merges | Cyrus and Mailspring pick one |
| Thread past 100 messages | notmuch, Thunderbird | Gmail, Cyrus (Nylas at 500) |

A message with no Message-ID gets a generated one (RFC 5256), and Mailspring will not index references for a generated id.

**Recommended** *(inferred as a combination)*. A `MessageRef(messageId, thread)` table with a row for a message's own id and every id it references, ghosts included. On arrival join the thread those ids name, and when they name two, merge in one transaction. Join on ids alone. If a subject fallback is added, it needs a reply marker or shared participants, and it never merges two existing threads. Cap references read per message (20 as Cyrus, or 50 as Mailspring).

---

## Hostile HTML

### How webmail has been broken

- **Changing HTML after sanitizing.** Proton Mail 2022: a pass that ran after the sanitizer re-parsed the markup and turned inert text into live markup (mutation XSS), and a CSS path leaked content ([Sonar](https://www.sonarsource.com/blog/code-vulnerabilities-leak-emails-in-proton-mail/)). Roundcube CVE-2024-42009 was the same class, a post-processing step undoing the sanitizer ([Sonar](https://www.sonarsource.com/blog/government-emails-at-risk-critical-cross-site-scripting-vulnerability-in-roundcube-webmail/)). The rule both yield: **nothing touches the output of the sanitizer.** The [mXSS cheatsheet](https://sonarsource.github.io/mxss-cheatsheet/explained/) holds the payloads.
- **CSS as a network client.** `url()`, `@import`, `image-set()`, `cross-fade()` and attribute selectors each fetch or leak with no script; PortSwigger worked them against Fastmail, Gmail, Proton and Outlook web ([research](https://portswigger.net/research/css-the-bomb-inside-your-inbox)).
- **Kobold letters**: CSS that shows one message to the first reader and another after a forward ([Lutra](https://lutrasecurity.com/en/articles/kobold-letters/)).
- **EFAIL**: decrypted text exfiltrated through a remote-content URL ([efail.de](https://efail.de/)). No remote content, no channel.

### What the careful clients do

- **Proton** ([purify.ts](https://raw.githubusercontent.com/ProtonMail/WebClients/main/packages/sanitize/src/purify.ts)): DOMPurify with `FORBID_TAGS: ['style','input','form','textarea']` and `FORBID_ATTR: ['srcset','for']`, URL attributes renamed to `proton-*` so nothing loads until the reader allows it, and ids prefixed against DOM clobbering.
- **AdGuard** ([write-up](https://adguard.com/en/blog/how-we-created-safe-html-email.html)), the closest to the recommendation below: DOMPurify on the whole document, a hook that rewrites `img src` to a proxy, a CSS parser that rewrites `url()`, then a `srcdoc` iframe that allows popups only, with `credentialless`, `referrerpolicy="no-referrer"` and a CSP of `default-src 'none'; img-src data: <proxy>`.
- **Close** ([write-up](https://making.close.com/posts/rendering-untrusted-html-email-safely/)) skips the sanitizer and relies on the sandbox with `script-src 'none'`. One layer.
- **DOMPurify's own rules** ([README](https://github.com/cure53/DOMPurify/blob/main/README.md)): on a server it needs a current jsdom, happy-dom is "not considered safe", and it should be handed strings.
- **The Sanitizer API** (`Element.setHTML`) shipped in Firefox 148 and Chrome 146 in 2026 and not in Safari, with early bypass reports. A second layer later, not the first now.

### Remote content

- **Block by default**, and when the reader allows it, fetch through a proxy so the sender learns no IP, cookie or user agent. The models are GitHub's camo and [go-camo](https://github.com/cactus/go-camo): HMAC-signed URLs, private and link-local ranges refused, at most 3 redirects, `image/*` only, a 4 s timeout and a size cap.
- **[Email Privacy Tester](https://www.emailprivacytester.com/about)** ([source](https://gitlab.com/grepular/ept3)) is the public list of ways a message phones home, and a ready corpus.

**Recommended.** Four layers, each sufficient against the common case: an allowlist sanitizer over a real DOM; a frame with no `allow-scripts` and no `allow-same-origin`; a CSP of `default-src 'none'` on the frame's own document, sent as a header where the document has a URL; and no network, with remote content blocked by default and served through a signed proxy when allowed. Sanitize once, and add nothing afterwards. Prove it in Chromium and in Firefox, because Chromium has applied a cloned template's inline `style` where Firefox enforced the policy (this project's own finding).

---

## Sending and deliverability

### A client is not a mail server

A client sends through the account's own submission server (587 or 465 with AUTH). The provider signs with DKIM and owns the IP reputation. Direct delivery is not open to an app anyway: DigitalOcean, Hetzner and AWS block or gate port 25 ([DigitalOcean](https://docs.digitalocean.com/support/why-is-smtp-blocked/), [Hetzner](https://docs.hetzner.com/cloud/servers/faq/)). What remains for the client is the message itself.

### What the message must be

- **[RFC 5322 §3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4)**: a unique `Message-ID`; a reply's `In-Reply-To` is the parent's id, and its `References` is the parent's `References` plus the parent's id (or the parent's `In-Reply-To` when it had no `References`). Lines are at most 998 octets and should be at most 78.
- **The submission server may replace a `Message-ID`** ([RFC 6409 §8](https://www.rfc-editor.org/rfc/rfc6409#section-8)), so generate one and read it back from the sent copy before threading on it.
- **`Bcc` never reaches a recipient's copy**; the addresses go in the envelope.
- **An automatic message says so** with `Auto-Submitted` ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834.html)), and nothing auto-replies to a message that carries it.
- **Header injection** *(inferred from RFC 5322's ban on a bare CR or LF)*: refuse a CR or LF in anything a person typed that lands in a header. Junction's `assertHeaderValue` already does.
- **Gmail refuses some attachment types outright** ([list](https://support.google.com/mail/answer/6590)).

### What receivers demand of the domain

Google asks every sender for SPF or DKIM, and anyone past 5,000 a day for SPF, DKIM, a DMARC record of at least `p=none`, a spam rate under 0.3% and one-click unsubscribe ([guidelines](https://support.google.com/a/answer/81126)). Yahoo matches ([best practices](https://senders.yahooinc.com/best-practices/)). Microsoft began enforcing the same on 2025-05-05 (third-party sources). DMARC was revised in May 2026 as RFC 9989–9991 (vendor blogs only). A client meets these only when its `From` is a domain the submission server signs for, so sending as an alias on another domain is the one deliverability fault a client causes by itself.

### Reading authentication on the way in

[RFC 8601](https://datatracker.ietf.org/doc/html/rfc8601) `Authentication-Results` is trustworthy only when it carries the receiving server's own `authserv-id`; a copy of the header from anywhere else is the sender's claim. Gmail shows a question mark for unauthenticated mail ([help](https://support.google.com/mail/answer/180707)). [`mailauth`](https://github.com/postalsys/mailauth) (MIT) verifies SPF, DKIM, DMARC and ARC in JS; its Bun support is unstated.

### Proving it without sending

[Mailpit](https://mailpit.axllent.org/docs/usage/html-check/) is an SMTP sink that keeps the raw bytes, scores HTML against client support and can call SpamAssassin.

**Recommended.** Send only through the account's submission server, with `From` held to an identity that server signs for, and warn when it is not. Build the message with junction's `toMime` and file what it lacks. Put the copy in Sent by `APPEND` unless the server already did, and find out which by looking. Grade the raw bytes at a sink, never the app's own idea of what it sent.

---

## Not verified

- **IMAP**: Gmail's 15-connection limit; whether Gmail saves a sent message by itself; `NOTIFY` in real use; reconnect backoff guidance; RFC 4549's section numbers. GreenMail's capability list has one source. RFC 8438 is `STATUS=SIZE` and `LITERAL-` is RFC 7888, corrected during the research.
- **MIME**: Thunderbird's body selection and its handling of signed and report parts; `mailparser` on `format=flowed`; base64 and decompression limits in any parser; Bun under `mailparser` or `nodemailer`; RFC 2231 in `postal-mime`; a "MIME torture test" corpus (not found).
- **Threading**: Gmail's real grouping rules; whether Cyrus merges conversations after ingest; Outlook's use of `Thread-Topic`; Apple Mail, mu, aerc, Roundcube and Delta Chat.
- **HTML**: Nextcloud Mail, SOGo, Tuta, Hey and Superhuman; DOMPurify's bypass history; the Roundcube SVG CVEs beyond their summaries. A search on Roundcube CVE-2025-49113 was refused by a safety filter and was not pursued; it is cited nowhere here.
- **Deliverability**: the DMARC revision and Microsoft's dates from primary sources; bounce parsing ([RFC 3464](https://www.rfc-editor.org/rfc/rfc3464)); ARC, MTA-STS and BIMI; 8BITMIME and SMTPUTF8.
