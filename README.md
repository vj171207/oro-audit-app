# Oro Audit App

Internal collateral audit tool for Oro's audit team, built for Tenmark Capital (TCPL). Sole developer: VJ (intern). Technical handover owner from end of July 2026: Vivek. Manager: Rijin C.

## Live app

- **URL:** oro-audit-app.vercel.app
- **Hosting:** Vercel (primary and only supported deployment target)
- **GitHub:** github.com/vj171207/oro-audit-app

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Plain HTML/CSS/JS — `index.html`, `style.css`, `app.js`. No framework, no build step. |
| Auth | Firebase Authentication (email/password + anonymous for guest access) |
| Database | Firebase Firestore (project: `oro-audit`, Spark/free plan) |
| Live loan data | Metabase (`oro.metabaseapp.com`), Tenmark Prod, database ID 103 |
| Exports | SheetJS (`xlsx.full.min.js`, loaded via CDN) for `.xlsx` export |
| Serverless functions | Vercel `/api` functions (Node) — **Hobby plan caps this at 12 functions per deployment.** Keep an eye on the `api/` folder count; this limit has been hit twice already from leftover one-time scripts not being deleted promptly. |
| Scheduled sync | Vercel Cron, daily at 3:30 AM UTC (9:00 AM IST) |

**Data flow:** Metabase is the source of truth for live loan status and is **read-only** from this app's perspective. Firestore is the source of truth for everything the audit team enters (audit records, tare weights, settings, users). The daily cron job (`api/sync-loans.js`) pulls active loans from Metabase and adds any new ones to Firestore as pending audits — it never writes back to Metabase.

## What the app does

**1. New Audit** — Shows active Tenmark loans that have never been audited (pulled from Metabase, cross-referenced against Firestore). Auditor selects a loan, ops data (ornament weights, karat, hallmark, etc.) auto-populates, auditor records findings and tare weight, submits to Firestore.

If a loan has been audited before (a genuine re-audit), the ornament form pre-fills each field with the previous audit's values as a reference, clearly labeled and fully editable — the auditor still physically re-measures, this is a comparison aid, not an autofill shortcut. See **"The re-audit reference system"** below for how this actually works and why it's more subtle than it looks.

**2. Tare Weight** — Ledger of tare weight readings against active loans, with a configurable mismatch threshold (default 0.3g). Filterable by branch and match/pending/flagged status. Shows a live "X remaining today / X completed today" counter so auditors always know exactly how much of the day's queue is left, without needing to track it manually.

**3. All Audits** — Full audit history, deduplicated per loan. Filterable by loan ID, branch, auditor, deviation type, loan status, and date range. Loan ID search always searches the complete history regardless of what's currently displayed. The table shows the most recent 100 audits by default with a "Load more" button — see **"Performance: why two different fixes"** below for why this works differently from Tare Weight's fix.

**4. Settings** (password-protected, managers only) — Configure pending-audit cycle length and tare weight threshold, manage users and their roles, register branches, view app-level stats (sync status, audit counts).

### Roles

- **Manager** — full access, including Settings and audit date editing.
- **Auditor** — everything except Settings and the locked audit-date field.
- **Guest** — read-only, signs in anonymously via Firebase Auth (required so Firestore rules can enforce `request.auth != null` on every read — guests are not literally unauthenticated), banner shown at top of screen.

## Environment variables (set in Vercel project settings)

| Variable | Purpose |
|---|---|
| `METABASE_SESSION_TOKEN` | Auth for all Metabase queries. **This is a session token copied from a browser cookie and will expire periodically** — see maintenance notes below for the permanent fix that's been scoped but not yet built. |
| `FIREBASE_API_KEY` | Firebase Auth REST API key (used server-side in `/api` functions for admin-style operations) |
| `FIREBASE_SYNC_EMAIL` / `FIREBASE_SYNC_PASSWORD` | Credentials for a dedicated Firebase service account used by the cron sync, user creation, password reset, and user removal functions to obtain an auth token. **This is the only account permitted to write to the `users` collection** — see the Firestore Security Rules note below, this is not optional/legacy, it's load-bearing. |
| `CRON_SECRET` | Shared secret checked by `api/sync-loans.js` to ensure only Vercel's own cron trigger can call it |
| `BACKFILL_SECRET` | Historically used to gate one-time data-migration scripts (see "One-time data fixes" below). No currently-active script uses this, but the pattern is documented there in case a future migration is ever needed — don't remove this env var casually, and don't be surprised if it's referenced again someday. |

The Firebase web `apiKey` used client-side in `app.js` is intentionally public (standard for Firebase — access is controlled by Firestore security rules, not by hiding the key).

## Files

- `index.html` — App structure and markup for all four sections, login screen, and modals
- `style.css` — All styling, including light/dark mode theming via CSS variables
- `app.js` — All client-side logic: Firebase init, auth, Firestore reads/writes, rendering, exports
- `api/active-loans.js` — Fetches all currently active loans from Metabase
- `api/browse-loans.js` — Fetches loans within a date range from Metabase
- `api/loan-lookup.js` — Fetches ops data (including ornament detail) for a single loan ID from Metabase
- `api/tw-gross-weight.js` — Batched, scale-safe endpoint returning total gross weight per loan for the Tare Weight report (see the Pledge Card note below before touching the SQL in here)
- `api/sync-loans.js` — Cron job: pulls active loans from Metabase, adds new ones to Firestore, updates last-sync timestamp
- `api/create-user.js` — Creates a Firebase Auth user + Firestore user record (Settings panel, managers only)
- `api/reset-password.js` — Resets another user's password via Firebase Auth (Settings panel, managers only)
- `api/remove-user.js` — Removes a user's Firestore access record (Settings panel, managers only). Revokes app access immediately; does **not** delete the underlying Firebase Auth account — that's a deliberate scope decision, not an oversight.
- `vercel.json` — API routing rewrites and the cron schedule
- `netlify.toml` — Currently empty. Kept only as a placeholder in case the app is ever redeployed to Netlify instead of Vercel; has no effect on the current Vercel deployment.
- `tests/` — A handful of saved, runnable test scripts covering the trickiest logic in the app. See `tests/README.md`. Not exhaustive, not a formal test suite with a runner — just real, working checks against the pieces of logic that were genuinely non-obvious to get right, kept so future changes don't silently re-break them.

## Hard-won domain knowledge

This section exists because most of these facts aren't visible from reading the code alone — each one caused a real bug at some point before it was understood.

### "Gross weight" is a Pledge Card total, not a per-piece figure

`GW` on any ornament (in Metabase, in Firestore, in the app's UI) is the **total weight for that line item as recorded on the Pledge Card** — not the weight of one individual piece. If an ornament line says count = 2, its GW is already the combined weight of both pieces, **not** a per-piece figure that needs multiplying. This directly caused a bug in the Gross Weight report column (originally built as `gross_weight × quantity`, which double-counted every multi-piece ornament) before being caught and fixed. Any future code touching ornament weights should sum `gw` directly, never multiply by count.

### Every loan has (at least) two copies of its gold records — only one is authoritative

Metabase's `gold` table stores **both** the Appraisal Partner's (AP) original valuation and the Maker's independent re-verification of the same physical items, as two separate rows. The Maker's row always has `original_gold_id` pointing back to the AP row it corresponds to. **Any query touching the `gold` table must filter `original_gold_id IS NULL`** to get only the authoritative AP records — omitting this filter causes every multi-piece loan to appear to have double the ornaments it actually has. This is already correctly handled in `api/loan-lookup.js` and `api/tw-gross-weight.js`; if you ever write a new query against `gold`, copy this filter from one of those files rather than writing it from scratch.

### Ornament type names in Metabase can silently change over time

At least one real case: a type recorded as `"Stud"` on an old audit is now called `"Studs"` in Metabase's current `gold_ornament` table (and there are other similarly-named categories like `"Drops & Studs"` vs `"Stud & Drops"` — easy territory for this to happen again). This broke the re-audit reference system's matching until it was found and fixed — see the next section for how the fix actually works.

### The re-audit reference system

When a loan gets audited a second time, the app tries to show what was recorded last time as a reference (never as a silent autofill without the auditor seeing it). This is genuinely subtler than it looks, because of two compounding problems: (1) old records didn't originally store which specific physical item (Metabase's `gold.id`) they corresponded to, and (2) even the item's *type name* isn't reliably stable over time (see above).

The matching logic (`matchPreviousOrnament()` in `app.js`) tries, in order:
1. **Exact match by `goldId`** — the reliable case, works regardless of any type-name drift. Every audit submitted from mid-project onward captures this at the time of audit, so this case gets more common over time and needs no further work.
2. **Unambiguous match by type name** — for older records with no `goldId` stored: if only one past entry shares this type name, there's nothing actually ambiguous about it, safe to use.
3. **Match by recorded weight, across all types** — the fallback for when a type name has drifted (case above): if no past entry shares the current type name at all, but exactly one shares the recorded Pledge Card weight, that's treated as a genuine re-identification, not a guess, and labeled honestly ("recorded as X last time, now Y").
4. **If none of the above resolve to exactly one candidate** — genuinely ambiguous (e.g. two same-type ornaments with no `goldId` and no distinguishing weight). The app **deliberately does not guess** here — it shows all candidates as a labeled reference list and leaves the fields blank, rather than risk silently feeding a wrong number into an audit. A one-time backfill pass (already run) retroactively resolved most of the historical gap using this same weight-matching logic; a small number of genuinely unresolvable cases remain by design, not oversight — they're unresolvable because the original data never recorded which physical item was which, not because the matching logic is incomplete.

### Performance: why two different fixes, not one

**Tare Weight** only ever needs to show *currently active* loans (~150 today, out of 500+ total audits ever recorded). It was rewritten to fetch only the audit records for those active loans (batched Firestore `in` queries, 30 IDs per batch — a hard Firestore limit), merged into the shared in-memory store rather than replacing it. This is a genuine reduction in what gets read from the database, and the saving grows every year as total history accumulates while active loan count stays roughly flat.

**All Audits** is different, deliberately: its summary cards (Total/Excess/Spurious/Active) need to count *the most recent audit per loan*, which requires looking at the full history to correctly deduplicate (a loan can have more than one audit doc — see the AP/Maker note above for why duplicates are common in this data, not rare). So the underlying full-history fetch was kept **on purpose** to keep those numbers exactly correct — Firestore's native counting can't dedupe by loan, and would have quietly inflated the summary numbers given how common duplicate records are in this exact dataset. What changed instead is how much gets *rendered into the browser* — only the most recent 100 rows draw into the table by default, with "Load more" revealing the rest, and Loan ID search always checks the complete already-loaded dataset regardless of pagination. This solves the part of the problem that was actually getting worse (a browser choking on thousands of rendered rows) while keeping the numbers at the top permanently accurate.

**If a future maintainer wants to revert the All Audits pagination** back to rendering everything at once: flip `ALL_AUDITS_PAGINATION_ENABLED` to `false` near the top of `app.js` — this was built as a single, deliberate switch specifically so reverting doesn't require re-writing anything.

### One-time data fixes

Several historical data-quality issues (a handful of malformed dates, an import script's naming inconsistencies, ambiguous ornament matches) were fixed via **temporary, secret-gated API scripts** — never by editing Firestore data by hand. The pattern used every time:

1. Build a script under `api/` requiring `?secret=<BACKFILL_SECRET>` in the URL
2. Run it with `?mode=preview` first — reports exactly what *would* change, writes nothing
3. Only after manually checking the preview output looks right, re-run with `?mode=commit`
4. **Delete the script from the repo once confirmed successful** — these are not meant to be permanent, and forgetting this step is exactly what's hit Vercel's 12-function limit twice already

If a similar one-time fix is ever needed again, copy this pattern rather than writing directly against Firestore from the browser console — the preview step has caught real mistakes before they became permanent.

### `twUpdatedAt` and the daily reset — timezone caveat

The Tare Weight sort (completed loans sink to the bottom) and the "remaining today / completed today" counter both work by checking whether a timestamp starts with today's date. **This is calculated using the browser's UTC time, not IST.** Since UTC's calendar flips over at 5:30 AM India time (not midnight), there's a real ~5.5 hour window — roughly 12:00 AM to 5:30 AM IST — where a recheck saved during that window could later appear to "un-complete" itself once UTC catches up. This has never actually been observed, since the team's real working hours are mid-morning through evening — but it's a genuine, understood latent bug, not a hypothetical one. If it's ever worth fixing: compute "today" explicitly in IST rather than relying on the browser's raw UTC conversion.

### No protection against two people saving the same loan at once

Saving a Tare Weight recheck is an unconditional overwrite — if two auditors happened to save the same not-yet-done loan within moments of each other, the second write silently erases the first, with no warning to either person. Low probability given the sort logic already pushes completed loans out of the way, but not zero, especially with multiple auditors working the same list simultaneously. Not yet fixed; the standard fix would be a "has this changed since I loaded it?" check before writing.

## Known maintenance risks, ranked

1. **`METABASE_SESSION_TOKEN` expires periodically** and requires manually copying a fresh value out of a browser cookie. When it does, the New Audit loan list, loan lookups, and the daily sync will all start failing with a clear "Metabase session expired" message (not a silent failure — this was fixed). **The permanent fix has been scoped but not built:** switch to a dedicated Metabase *service account* (email + password, not a session cookie) and have every endpoint log in fresh before each request, the same pattern already used for Firebase throughout this codebase. Ask Oro's Metabase admin for a dedicated login (e.g. `audit-app-service@orocorp.in`) — not a real employee's personal account, for reasons covered in project notes.
2. **The IST/UTC timezone gap** described above — low likelihood, real if it ever hits.
3. **No concurrency protection on Tare Weight saves** — also described above.
4. **The `api/` folder creeping toward Vercel's 12-function limit** — a discipline issue, not a code issue. Delete one-time scripts promptly (see "One-time data fixes" above).

## Deployment

Deploy via **drag-and-drop upload to the GitHub repo**, not the GitHub web editor's paste function (Vercel's build cache has previously served stale files when edited in-browser). After deploying, hard-refresh (Ctrl+Shift+R) to bypass browser/CDN caching before verifying changes.
