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
| Auth | Firebase Authentication (email/password) |
| Database | Firebase Firestore (project: `oro-audit`, Spark/free plan) |
| Live loan data | Metabase (`oro.metabaseapp.com`), Tenmark Prod, database ID 103 |
| Exports | SheetJS (`xlsx.full.min.js`, loaded via CDN) for `.xlsx` export |
| Serverless functions | Vercel `/api` functions (Node) |
| Scheduled sync | Vercel Cron, daily at 3:30 AM UTC (9:00 AM IST) |

**Data flow:** Metabase is the source of truth for live loan status and is **read-only** from this app's perspective. Firestore is the source of truth for everything the audit team enters (audit records, tare weights, settings, users). The daily cron job (`api/sync-loans.js`) pulls active loans from Metabase and adds any new ones to Firestore as pending audits — it never writes back to Metabase.

## What the app does

**1. New Audit** — Shows active Tenmark loans that have never been audited (pulled from Metabase, cross-referenced against Firestore). Auditor selects a loan, ops data (ornament weights, karat, hallmark, etc.) auto-populates, auditor records findings and tare weight, submits to Firestore.

**2. Tear Weight** — Ledger of tare weight readings against active loans, with a configurable mismatch threshold (default 0.3g). Filterable by branch, date range, and match/pending/flagged status.

**3. All Audits** — Full audit history, deduplicated per loan. Filterable by loan ID, branch, auditor, deviation type, loan status, and date range. Exports filtered results to `.xlsx`. Click any row for the full audit detail.

**4. Settings** (password-protected, managers only) — Configure pending-audit cycle length and tare weight threshold, manage users and their roles, register branches, view app-level stats (sync status, audit counts).

### Roles

- **Manager** — full access, including Settings and audit date editing.
- **Auditor** — everything except Settings and the locked audit-date field.
- **Guest** — read-only, bypasses Firebase Auth entirely (no account needed), banner shown at top of screen.

## Environment variables (set in Vercel project settings)

| Variable | Purpose |
|---|---|
| `METABASE_SESSION_TOKEN` | Auth for all Metabase queries. **This is a session token and will expire periodically** — see maintenance notes below. |
| `FIREBASE_API_KEY` | Firebase Auth REST API key (used server-side in `/api` functions for admin-style operations) |
| `FIREBASE_SYNC_EMAIL` / `FIREBASE_SYNC_PASSWORD` | Credentials for a dedicated Firebase account used by the cron sync, user creation, and password reset functions to obtain an auth token |
| `CRON_SECRET` | Shared secret checked by `api/sync-loans.js` to ensure only Vercel's own cron trigger can call it |

The Firebase web `apiKey` used client-side in `app.js` is intentionally public (standard for Firebase — access is controlled by Firestore security rules, not by hiding the key).

## Files

- `index.html` — App structure and markup for all four sections, login screen, and modals
- `style.css` — All styling, including light/dark mode theming via CSS variables
- `app.js` — All client-side logic: Firebase init, auth, Firestore reads/writes, rendering, exports
- `api/active-loans.js` — Fetches all currently active loans from Metabase
- `api/loan-lookup.js` — Fetches ops data for a single loan ID from Metabase
- `api/browse-loans.js` — Fetches loans within a date range from Metabase
- `api/sync-loans.js` — Cron job: pulls active loans from Metabase, adds new ones to Firestore, updates last-sync timestamp
- `api/create-user.js` — Creates a Firebase Auth user + Firestore user record (Settings panel, managers only)
- `api/reset-password.js` — Resets another user's password via Firebase Auth (Settings panel, managers only)
- `api/fetch-sheet.js` — Currently empty/unused. Left in place intentionally in case of a future move away from Metabase; does not affect app function.
- `vercel.json` — API routing rewrites and the cron schedule
- `netlify.toml` — Currently empty. Kept only as a placeholder in case the app is ever redeployed to Netlify instead of Vercel; has no effect on the current Vercel deployment.

## Known maintenance risks

See the internal maintenance/handover documentation (`Oro_Audit_App_SOP.docx`) for the full list. The most important one to know as a new maintainer:

- **`METABASE_SESSION_TOKEN` expires periodically.** When it does, the New Audit loan list, loan lookups, and the daily sync will all silently start failing. There is currently no automated alert for this — check Vercel function logs for `api/sync-loans` if loans stop appearing, and regenerate the token in Metabase if needed.

## Deployment

Deploy via **drag-and-drop upload to the GitHub repo**, not the GitHub web editor's paste function (Vercel's build cache has previously served stale files when edited in-browser). After deploying, hard-refresh (Ctrl+Shift+R) to bypass browser/CDN caching before verifying changes.
