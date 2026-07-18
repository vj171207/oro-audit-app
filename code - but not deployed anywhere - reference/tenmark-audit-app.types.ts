// tenmark-audit-app.types.ts
//
// TypeScript interface definitions for the Tenmark Audit App's core data
// shapes — Audit, Ornament, User, Settings.
//
// PURPOSE: this is a translation of tenmark-data-dictionary.md into real
// TypeScript, ready to hand to Tenmark's frontend team (React 18 + TS) or
// to use directly if/when this app's logic gets ported into their
// codebase. It is NOT currently imported or used anywhere in the running
// app — app.js is plain JS with no build step, so this file has zero
// effect on current behavior. It exists purely as a migration-prep
// artifact.
//
// SOURCE OF TRUTH: derived directly from what app.js / auditDataService.js
// / api/*.js actually read and write today (see tenmark-data-dictionary.md
// for the full field-by-field reasoning). If the data dictionary is ever
// updated, update this file to match.

// ─────────────────────────────────────────────────────
// Ornament — one item within an audit's ornaments[] array
// ─────────────────────────────────────────────────────
export interface Ornament {
  /** Ornament category label (e.g. "Chain", "Ring"). A LABEL, not a stable
   *  ID — known to drift over time. Prefer `goldId` for matching across
   *  audits where available. */
  type: string;

  /** Stable ID from Metabase. Preferred over `type` for re-audit matching
   *  when present — not always available on older records. */
  goldId?: string;

  /** Original ops-recorded piece count. */
  count: number;

  /** Auditor-recorded piece count. NOTE: older imported records may have
   *  `count` but not `countAudit` populated — callers should fall back to
   *  `count` in that case (`countAudit ?? count`), matching existing
   *  re-audit logic. */
  countAudit?: number;

  /** Original gross weight — a TOTAL for this line, never a per-piece
   *  figure. This is a hard rule across the whole app; do not treat this
   *  as "weight per item." */
  gw: number;

  /** Auditor-measured gross weight (same total-not-per-piece rule). */
  gwAudit?: number;

  /** Derived: gross weight per piece. */
  gwPC?: number;

  /** Original recorded karat. */
  karat: number;

  /** Auditor-measured karat. */
  karatAudit?: number;

  /** Derived: per-piece karat. */
  karatPC?: number;

  /** Original net weight. Formula: (GW − Stone) × (Karat/22). */
  nw: number;

  /** Auditor-calculated net weight, same formula applied to audited
   *  figures. */
  nwAudit?: number;

  /** Derived: per-piece net weight. */
  nwPC?: number;

  /** Original stone deduction. */
  stoneDed: number;

  /** Auditor-measured stone deduction. */
  stoneDedAudit?: number;

  /** Derived: per-piece stone deduction. */
  stoneDedPC?: number;

  /** Hallmark reading, freeform. */
  hallmark?: string;

  /** Per-ornament spurious flag. Rolls up into the audit-level `spurious`
   *  and `spuriousOrnaments` fields. */
  spurious: 'Yes' | 'No';
}

// ─────────────────────────────────────────────────────
// Audit — one document in the `audits` collection
// ─────────────────────────────────────────────────────
//
// IMPORTANT: a single loanId can have MULTIPLE Audit records (re-audits
// create new docs rather than overwriting). Only the most recent one (by
// `date`) is authoritative for current state — see computeDedupedAudits()
// in app.js for the exact dedup rule. Any migration must preserve this
// multiple-docs-per-loan structure, or re-audit history is lost.
export interface Audit {
  /** Firestore doc ID today. Becomes whatever the new DB's primary key is
   *  (see open question: UUID vs auto-increment int on Tenmark's side). */
  id: string;

  /** The stable key everything joins on, e.g. "TCGL31241368". */
  loanId: string;

  /** Audit date (YYYY-MM-DD). Can be backdated by the auditor — distinct
   *  from `submittedAt`, which is the real save timestamp. */
  date: string;

  /** Auto-derived from the logged-in user's email at submit time
   *  (e.g. "vj@orocorp.in" -> "Vj"), not a separate lookup/join. */
  auditor: string;

  /** Tare weight reading, in grams. `null` on Metabase-sync placeholder
   *  docs that haven't been audited yet. */
  tw: number | null;

  /** Set only when a TW recheck happens after the initial audit.
   *  Attribution field — who performed the recheck. */
  twRecheckedBy?: string;

  /** ISO timestamp of the most recent TW save. This is the real,
   *  persistent signal that a recheck happened — see `_twSubmitted` below
   *  for the (deliberately non-persistent) UI-only counterpart. */
  twUpdatedAt?: string;

  /** CLIENT-SIDE ONLY — never written to Firestore/DB. A transient flag
   *  set on the in-memory object right after a successful TW save, purely
   *  to disable that row's input for the rest of the current browser
   *  session. Included here only so a future rewrite doesn't accidentally
   *  try to persist it — it should NOT be a column/field in the new DB. */
  _twSubmitted?: boolean;

  excessFunding: 'Yes' | 'No';

  /** Only meaningful when `excessFunding === 'Yes'`. */
  excessAmount?: number;

  /** 'Yes' if ANY ornament in this audit was flagged spurious. */
  spurious: 'Yes' | 'No';

  /** Ornament TYPE names (not IDs) that were flagged spurious. */
  spuriousOrnaments?: string[];

  /** Snapshot of ops data at audit time — NOT a live join. Will not
   *  reflect later changes to the loan's city/branch in Metabase. */
  city?: string;
  branch?: string;

  /** Raw number. Historically was sometimes stored as a formatted currency
   *  string ("₹1,20,000") on records created before the loanAmount type
   *  fix — see tenmark-data-dictionary.md. New records are always numeric. */
  loanAmount: number;

  /** ISO date string, or null. Historically had a bug where this was
   *  scraped from displayed text instead of raw data — fixed to always
   *  store raw ISO format going forward. */
  loanBookingDate: string | null;

  /** Freeform, legitimately often blank. Not mandatory. */
  remarks?: string;

  /** Freeform, blank means "unchanged." Not mandatory. */
  newPacketId?: string;

  ornaments: Ornament[];

  /** Real save timestamp, set at submit time. Distinct from `date`. */
  submittedAt: string;

  /** Only present on placeholder docs auto-created by the nightly Metabase
   *  sync cron, before any real audit has been performed. Always the
   *  literal string 'metabase-sync' when present. */
  source?: 'metabase-sync';

  /** Only present on placeholder docs — when the sync created this doc. */
  syncedAt?: string;
}

// ─────────────────────────────────────────────────────
// AppSettings — the single document in `app_settings` (doc ID: 'config')
// ─────────────────────────────────────────────────────
// Global app configuration, not per-user.
export interface AppSettings {
  /** Configurable pending-audit cycle length, manager-set. */
  pendingDays: number;

  /** Tare weight mismatch threshold in grams. Default 0.3. */
  twThreshold: number;

  /** Gates the Settings screen — a SHARED password, not per-user auth.
   *  FLAG FOR MIGRATION: worth deciding whether this concept survives
   *  integration at all, especially if Tenmark's dashboard login replaces
   *  this app's own auth entirely (see User below). */
  settingsPassword: string;

  /** Manager-registered branch list, used for filtering across Tare
   *  Weight / All Audits. */
  branches: string[];

  /** ISO timestamp, set whenever settings are saved. */
  updatedAt: string;

  /** ISO timestamp, set by the nightly Metabase sync cron. */
  lastSyncAt?: string;

  /** Drives the manager-only sync-failure banner on login. */
  lastSyncStatus?: 'success' | 'completed_with_errors';

  /** How many loans failed to sync — shown in the failure banner. */
  lastSyncFailureCount?: number;
}

// ─────────────────────────────────────────────────────
// User — one document in the `users` collection
// ─────────────────────────────────────────────────────
// Document ID today = Firebase Auth UID (not email).
//
// FLAG FOR MIGRATION: if Tenmark Core's dashboard login (Passport JWT +
// Google OAuth) replaces this app's own auth, as currently being discussed,
// this entire interface — and the 3 backend functions that manage it
// (create-user.js, reset-password.js, remove-user.js) — may become
// unnecessary rather than something to port. Confirm direction before
// building anything against this shape.
export interface User {
  /** Doc ID today. Duplicated into the `uid` field below (redundant, but
   *  relied upon in current UI code — d.uid is compared against
   *  currentUser.uid). */
  id: string;

  /** Restricted to @orocorp.in domain today. */
  email: string;

  role: 'auditor' | 'manager';

  /** Same value as `id` above — kept for backward compatibility with
   *  current app.js logic, not because it's semantically distinct. */
  uid: string;
}
