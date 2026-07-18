# PROJECT_CONTEXT.md — Tenmark Audit App

**Read this file first, in full, before touching anything else in this repo.** It is written so that a fresh Claude instance — with no prior conversation history, only this repository — can understand the app, its known issues, and the state of its integration into Tenmark Core's dashboard, without needing anything explained again.

---

## 1. What this app is

A collateral-audit tool for **Tenmark Capital Private Limited (TCPL)**, a gold-loan NBFC partner of Oro Corp. Auditors use it to record physical audits of pledged gold ornaments against what's on record in Oro's live loan database (queried via Metabase), flag discrepancies (excess funding, spurious ornaments, weight mismatches), and track a "Tare Weight" recheck workflow.

**Stack today:** plain HTML/CSS/JS (`app.js`, no build step, no framework) + Firebase (Firestore for app data, Firebase Auth for login) + Vercel (hosts the static frontend and 8 serverless functions in `api/`). No TypeScript, no bundler.

**Who built it:** a single intern developer (VJ), during an internship ending late July 2026, with a planned handover to another engineer (Vivek). This context matters — the code has good inline documentation because it was written knowing a handover was coming, but there is no team of engineers who already know it.

---

## 2. The two related apps — don't confuse them

This repo is the **Tenmark Audit App**. There is a sibling app, the **Oro AP Appraisal App**, which is a *different* codebase for a *different* purpose (AP calibration and interview workflows for Oro's own appraisal partners). They share some engineering patterns and lessons learned but are not the same app and don't share code. If you're reading this file, you're looking at the Tenmark one.

---

## 3. Core domain rules — do not violate these in any rewrite or migration

These are business rules, not implementation details. They must survive any UI rewrite, any database migration, any refactor:

1. **A loan can have TWO gold valuation records: AP (Appraisal Partner) and Maker/Checker.** Every query that reads gold/ornament data filters explicitly for `original_gold_id IS NULL` to get the **AP valuation only** — this is a deliberate business decision (attributed to Rijin in code comments), not an accident of whichever record was entered most recently. This filter appears in `api/loan-lookup.js` and `api/tw-gross-weight.js`. **If you ever see gold/ornament data NOT filtered this way, that's a bug.**
2. **Gross weight (`gw`/`gwAudit`) is always a LINE TOTAL, never a per-piece figure.** Never multiply or divide by quantity when working with this field. This rule is stated explicitly in `api/tw-gross-weight.js`'s comments.
3. **Net weight formula:** `(GW − Stone Deduction) × (Karat / 22)`.
4. **A single `loanId` can have MULTIPLE audit records** (re-audits create new Firestore docs, never overwrite old ones). Only the most recent one (by `date`) is authoritative for current display — see `computeDedupedAudits()` in `app.js`. Any migration that assumes one-row-per-loan will silently lose re-audit history.
5. **Never guess on ambiguous ornament matching.** When matching a current audit's ornaments against a previous audit's (for the re-audit autofill feature), the matching logic explicitly refuses to guess when it can't confidently resolve a match (e.g. duplicate ornament types with no `goldId` to disambiguate) — see `ornament-matching.test.js` for the exact rules. Do not "improve" this by making it more permissive.

---

## 4. Where to find everything — document map

This repo organizes handoff material into two folders: **`documentation/`** (pure docs, no code) and **`code - but not deployed anywhere - reference/`** (real, tested code that isn't wired into the running app — draft schemas, validation, TypeScript interfaces). It should contain the following. If any are missing, they should be regenerated before relying on this file's claims about them:

| File | Location | What it is |
|---|---|---|
| `tenmark-data-dictionary.md` | `documentation/` | Every Firestore collection/field, extracted from actual code, with meaning and known quirks. **Read this before touching any data shape.** |
| `tenmark-api-contracts.md` | `documentation/` | Exact input/output contract for all 8 `/api/*.js` endpoints. |
| `tenmark-env-vars.md` | `documentation/` | Every environment variable/secret the app needs, and why. |
| `tenmark-integration-questions-consolidated.md` | `documentation/` | The full, current list of open questions for Tenmark's dev/product team, with resolved items marked. |
| `tenmark-audit-app.types.ts` | `code - but not deployed anywhere - reference/` | TypeScript interfaces for Audit/Ornament/User/AppSettings — a direct translation of the data dictionary. Not wired into the app (plain JS, no build step) — reference only. |
| `audit.model.js` + `migrations-create-audits.js` | `code - but not deployed anywhere - reference/` | Draft Sequelize model + migration for a Postgres version of the `audits` table, if that's the DB chosen. Tested against a real in-memory SQLite DB (round-trip, multi-audit-per-loan, rollback all confirmed working) — not just hand-written. |
| `audit.schema.js` | `code - but not deployed anywhere - reference/` | Draft Mongoose schema for a MongoDB version of `audits`, if that's chosen instead. Tested with real document validation (including 3 negative-case rejections) — not just hand-written. |
| `schemas.js` (Joi validation) | `code - but not deployed anywhere - reference/` | Draft Joi validation schemas for all 8 endpoints' inputs, cross-referenced field-for-field against the endpoints' current manual validation. Tested for exact error-message parity with source. |

**If you (Claude) are asked to do further migration-prep work, check this table first** — there's a good chance the artifact already exists and just needs updating, not recreating from scratch.

---

## 5. Tenmark Core's confirmed tech stack (the integration target)

Confirmed directly by Tenmark's dev team (not assumed):

- **Backend:** Node.js + Express 4, PostgreSQL (Sequelize ORM) as primary DB, MongoDB (Mongoose) as secondary DB, Redis for cache/queue, Passport (JWT) + Google OAuth for auth (JWT delivered via cookies), Joi + celebrate for validation, AWS S3 for storage, PM2 + Docker for deployment (not serverless).
- **Frontend:** React 18 + TypeScript, Create React App + craco, Tailwind CSS 3, Zustand for state, react-hook-form + Yup for forms, react-router-dom v6, axios (+ axios-hooks), socket.io-client.

**What is still genuinely unknown** (do not assume answers to these):
- Whether this app's frontend gets fully rewritten in React, or embedded as-is via iframe/micro-frontend (CRA without ejecting does not support Module Federation — a real constraint, not just a preference).
- Whether the app gets direct DB access or must go through an API layer Tenmark exposes.
- Whether the JWT auth cookie would be readable if this app stays a separately-hosted deployment (same-origin question, unresolved).
- Which DB (Postgres or Mongo) the audit data would actually land in.
- Whether this app's own login/user-management (Firebase Auth, the `users` Firestore collection, `create-user`/`remove-user`/`reset-password` endpoints) gets replaced entirely by Tenmark's dashboard login, or kept.

See `tenmark-integration-questions-consolidated.md` for the full, current list — check it before assuming any of the above has been resolved, since this document may go stale faster than that one.

---

## 6. Migration-prep work already done (as of this writing)

All of the following have been built, and — importantly — **actually tested**, not just written and assumed correct:

- `auditDataService.js` hardened so all 10 Firestore-calling functions return plain JS values, never raw Firestore snapshot objects — the one clean boundary a backend swap needs.
- `loanAmount` type bug fixed (was inconsistently a currency string vs. a number depending on how the record was created) — now always numeric, with old records still displaying correctly via existing defensive parsing.
- Tare Weight table and All Audits table both had their compute logic (dedup, sorting, filtering, summary counts) extracted from their render functions — pure, framework-agnostic functions now exist that a React rewrite can reuse directly, proven byte-identical to the original inline logic via side-by-side testing.
- All 9 `fetch()` call sites consolidated behind one `apiRequest()` wrapper — one place to add auth headers later instead of nine.
- Component boundary comments added at the 4 major screens (New Audit, Tare Weight, All Audits, Settings) marking where natural React component splits would fall.
- Full data dictionary, API contract doc, TypeScript interfaces, draft DB schemas (both Postgres and Mongo versions), draft Joi validation schemas, and an environment variable checklist — see the table in section 4.

**What this means practically:** a large fraction of "translate this app into Tenmark's stack" is already done as reference material. The remaining work is mostly waiting on the open questions in section 5, not on more prep artifacts.

---

## 7. Known open bugs (not yet fixed — check before assuming these are handled)

- **§8.1 — IST/UTC timezone gap:** the nightly sync cron's "today" calculation is wrong for a ~5.5 hour window (12:00 AM–5:30 AM IST). Demonstrated by `tests/timezone-gap.test.js` but not yet fixed.
- **§8.4 — All Audits count blank for old imports:** `countAudit` is missing on some older imported ornament records; a fallback (`countAudit ?? count`) exists in re-audit logic but not in the detail modal display.
- **§8.2 — no concurrency protection on Tare Weight saves:** low-probability race condition, not yet addressed.
- **§8.6/§8.7 — specific loan data issues** (`TCGL31241368`, `TCGL31290410` vault-recoverable; `TCGL31554417`, `TCGL31575276` have permanently lost original TW values) — data issues, not code bugs.

---

## 8. How to verify any change you make here

This repo has a real, runnable test suite (plain Node, no framework, run with `node tests/<file>.test.js`) — as of this writing, 8 test files, 156+ assertions, all passing. **Run the full suite before and after any change.** The established pattern in this codebase (see any `tests/*.test.js` file) is: copy the exact logic under test into the test file as a plain function, then assert against realistic fixtures — including edge cases and, where a refactor is involved, a side-by-side comparison against the original pre-refactor logic to prove byte-identical output.

If you add new logic, add a new test file following this same pattern. Do not skip this — every fix and refactor in this app's history has been verified this way, and the discipline is part of what's kept the migration-prep work trustworthy.
