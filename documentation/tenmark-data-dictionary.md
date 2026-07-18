# Tenmark Audit App — Firestore Data Dictionary

**Purpose:** single source of truth for every collection, field, and non-obvious rule currently stored in Firestore — built specifically to hand to whoever maps this schema onto Tenmark Core's DB (us, their team, or jointly). Extracted directly from the codebase (`app.js`, `auditDataService.js`, `api/*.js`), not from memory.

**Project:** Firebase project `oro-audit`, Spark (free) plan. Three collections: `audits`, `app_settings`, `users`.

---

## Collection: `audits`

The core collection. One document per audit performed — but see the **duplicates** note below, this is not 1 document per loan.

| Field | Type | Written by | Meaning / notes |
|---|---|---|---|
| `loanId` | string | New Audit submit | e.g. `TCGL31241368`. The stable key everything joins on. |
| `date` | string (YYYY-MM-DD) | New Audit submit | Audit date, defaults to today if not overridden. `loadAudits()` sorts on this field. |
| `auditor` | string | New Audit submit | Auto-derived from the logged-in user's email (`vj@orocorp.in` → `Vj`), not a separate lookup. |
| `tw` | number | New Audit submit / Tare Weight recheck | Tare weight reading, in grams. `null` on Metabase-sync placeholder docs (see below). |
| `twRecheckedBy` | string | Tare Weight module | Set only when a TW recheck happens after initial audit. Attribution field. |
| `twUpdatedAt` | ISO timestamp string | Tare Weight module | Drives the "X remaining / X completed today" counters — computed fresh from this on every render, no separate session tracking. Subject to the known IST/UTC gap (see open issues doc, §8.1). |
| `_twSubmitted` | boolean, **client-side only — never persisted** | Tare Weight module | Set on the in-memory audit object only, immediately after a successful TW save. Purely a same-session UI lock (disables input, shows "✓ Saved") to prevent accidental double-submit. Resets on reload by design — NOT a field to migrate. The real persistent signal of a completed recheck is `twUpdatedAt` + `twRecheckedBy`. |
| `excessFunding` | string (`'Yes'`/`'No'`) | New Audit submit | Whether the loan was over-funded relative to audited value. |
| `excessAmount` | number | New Audit submit | Amount of excess funding, only meaningful if `excessFunding === 'Yes'`. |
| `spurious` | string (`'Yes'`/`'No'`) | New Audit submit | `'Yes'` if **any** ornament in this audit was flagged spurious. |
| `spuriousOrnaments` | array of strings | New Audit submit | Ornament *type* names (not IDs) that were flagged spurious. |
| `city` | string | New Audit submit | Copied from Metabase ops data at audit time — a snapshot, not a live join. |
| `branch` | string | New Audit submit | Same — snapshot at audit time. |
| `loanAmount` | number | New Audit submit | Fixed: previously stored as a string scraped from DOM `.textContent` (inheriting a "₹1,20,000"-style currency format from the API). Now stored as a raw number end-to-end — `api/loan-lookup.js` returns a raw number, and app.js tracks it in a JS variable (`currentLoanAmount`) rather than re-reading the formatted display text, mirroring the existing `loanBookingDate` pattern. Display formatting (₹ + locale commas) now happens only at render time. Note: `api/sync-loans.js` placeholder docs already stored this as a raw number even before this fix — the inconsistency was isolated to the New-Audit-submit path. |
| `loanBookingDate` | ISO date string or `null` | New Audit submit | Previously had a bug where this was scraped from displayed text instead of raw data — now fixed to store raw ISO format (per context doc history). |
| `remarks` | string | New Audit submit | Freeform, legitimately often blank. Not mandatory. |
| `newPacketId` | string | New Audit submit | Freeform, blank means "unchanged." Not mandatory. |
| `ornaments` | array of objects | New Audit submit | See **Ornament object shape** below. |
| `submittedAt` | ISO timestamp string | New Audit submit | Set at save time, distinct from `date` (which can be backdated). |
| `source` | string | Metabase sync only | Only present on placeholder docs, always `'metabase-sync'` — marks a doc that was auto-created by the nightly cron and has not yet had a real audit performed. |
| `syncedAt` | ISO timestamp string | Metabase sync only | Present only on placeholder docs. |

### Ornament object shape (nested inside `audits.ornaments[]`)

| Field | Type | Notes |
|---|---|---|
| `type` | string | Ornament category (e.g. "Chain", "Ring") — a **label**, drifts over time (per project's guiding principle #3 — prefer IDs/measurements over labels when matching). |
| `goldId` | string | Stable ID from Metabase, used for re-audit matching when available. |
| `count` | number | Original ops-recorded piece count. |
| `countAudit` | number | Auditor-recorded piece count. Known bug: old imported records have `count` but not `countAudit` populated — a display fallback (`countAudit ?? count`) exists in re-audit logic but not yet in the detail modal (open issue §8.4). |
| `gw` | number | Original gross weight (a **total for the line**, never per-piece — project's guiding principle #1). |
| `gwAudit` | number | Auditor-measured gross weight. |
| `gwPC` | number | Gross weight per piece (derived). |
| `karat` | number | Original recorded karat. |
| `karatAudit` | number | Auditor-measured karat. |
| `karatPC` | number | Per-piece karat (derived). |
| `nw` | number | Original net weight — formula: `(GW − Stone) × (Karat/22)`. |
| `nwAudit` | number | Auditor-calculated net weight, same formula on audited figures. |
| `nwPC` | number | Per-piece net weight. |
| `stoneDed` | number | Original stone deduction. |
| `stoneDedAudit` | number | Auditor-measured stone deduction. |
| `stoneDedPC` | number | Per-piece stone deduction. |
| `hallmark` | string | Hallmark reading. |
| `spurious` | string (`'Yes'`/`'No'`) | Per-ornament flag — rolls up into the audit-level `spurious`/`spuriousOrnaments` fields above. |

### ⚠️ Duplicates are expected and load-bearing
A loan can have **more than one** `audits` doc for the same `loanId` (re-audits create new docs rather than overwriting). Only the most recent one counts as authoritative. All-Audits summary cards deliberately compute against full history (not the paginated view) specifically to dedupe correctly. **Any migration must preserve this multiple-docs-per-loan structure**, or re-audit history is lost.

---

## Collection: `app_settings`

Single document, hardcoded ID `config`. Acts as global app configuration — not per-user.

| Field | Type | Notes |
|---|---|---|
| `pendingDays` | number | Configurable pending-audit cycle length, manager-set. |
| `twThreshold` | number | Tare weight mismatch threshold in grams, default 0.3. |
| `settingsPassword` | string | Gates the Settings screen — a shared password, not per-user auth. **Flag for migration:** this is a plaintext-adjacent shared secret; worth deciding whether this concept survives integration at all, especially given the auth-simplification direction being discussed (dashboard login may replace this entirely). |
| `branches` | array of strings | Manager-registered branch list, used for filtering across Tare Weight / All Audits. |
| `updatedAt` | ISO timestamp string | Set whenever settings are saved. |
| `lastSyncAt` | ISO timestamp string | Set by the nightly Metabase sync cron — displayed in Settings info panel. |
| `lastSyncStatus` | string (`'success'` / `'completed_with_errors'`) | Drives the manager-only sync-failure banner on login. |
| `lastSyncFailureCount` | number | How many loans failed to sync, shown in the failure banner. |

---

## Collection: `users`

One document per user, **document ID = Firebase Auth UID** (not email).

| Field | Type | Notes |
|---|---|---|
| `email` | string | Restricted to `@orocorp.in` domain (per parked Auth/Roles item on the AP Appraisal App — same pattern likely applies here, worth confirming). |
| `role` | string (`'auditor'` / `'manager'`) | The only role gate in the app today. No city-restriction or finer permission model. |
| `uid` | string | Duplicated from the doc ID itself into a field — redundant but relied upon (`d.uid` is compared against `currentUser.uid` in the user-list UI). |

**⚠️ Directly relevant to the auth discussion:** if Tenmark Core's dashboard login replaces this app's own auth (as currently being assumed), this entire collection — and the 3 backend functions that manage it (`create-user.js`, `reset-password.js`, `remove-user.js`) — may become **unnecessary** rather than something to migrate. Worth confirming in tomorrow's meeting before doing any work here.

---

## Cross-cutting rules that don't belong to any one field

These aren't stored anywhere — they're business logic that must survive the migration regardless of what DB or UI holds the data:

1. **A "gross weight" is always a line total, never a per-piece figure.** Anything computing weights must respect this or produce silently wrong numbers.
2. **Every loan has at least two gold records in Metabase — AP and Maker — only the AP one (`original_gold_id IS NULL`) is authoritative.** This filter exists in `api/loan-lookup.js` and `api/tw-gross-weight.js` and must be preserved in any replacement of those endpoints.
3. **Prefer stable IDs or physical measurements over text labels when matching old to new data** (e.g. `goldId` over `type` name) — and when nothing reliable exists to match on, the app is designed to refuse to guess rather than risk a silent wrong match. This must NOT be "simplified away" during a rewrite.

---

## Known gaps in this dictionary (worth a follow-up pass)

- Field-level Firestore security rules (who can read/write what) are documented separately in `firestore.rules` — not duplicated here, but relevant to any auth/access-model conversation with Tenmark.
- This dictionary reflects fields **currently written by the app**. It does not include any fields that may exist in old records from before certain fixes (e.g. `loanBookingDate` before the ISO-format fix, or `loanAmount` before the numeric-type fix) — those are documented as historical bugs in the main context transfer doc, §6 and §8. **Note:** existing `audits` docs written before this fix may still have `loanAmount` stored as a "₹1,20,000"-style string — display code at lines ~1706/1901/2431 in `app.js` already strips non-numeric characters defensively before formatting, so old records display correctly without a backfill. A backfill is only needed if a future migration script assumes a clean numeric column from day one.
